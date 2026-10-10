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

const accountDisplayTranslations = { fr: { unnamed: 'Compte sans nom', yours: 'Votre compte', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "fr">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const fr: Copy = {
    recoverAutomationTemplates: 'Récupérer les anciens déclencheurs',
    recoverAutomationTemplatesDescription: 'Utilisez les clés de cet appareil pour récupérer les anciens déclencheurs. Elles restent disponibles tant que les sessions chiffrées ou les déclencheurs verrouillés en ont besoin.',
    recoverAutomationTemplatesAction: 'Récupérer',
    recoverAutomationTemplatesComplete: 'Déclencheurs récupérés. L’ancienne clé reste sur cet appareil jusqu’à ce que vous décidiez de l’oublier.',
    recoverAutomationTemplatesRetained: 'Récupération vérifiée. Certains déclencheurs restent chiffrés, verrouillés ou modifiés. L’ancienne clé reste sur cet appareil.',
    forgetEncryptionKey: 'Oublier l’ancienne clé de chiffrement',
    forgetEncryptionKeyDescription: 'Les anciennes sessions chiffrées deviennent verrouillées sur cet appareil.',
    forgetEncryptionKeyAction: 'Oublier',
    forgetEncryptionKeyConfirm: 'Oublier l’ancienne clé de chiffrement ?',
    forgetEncryptionKeyWarning: ({ items }) => `Les anciennes sessions chiffrées deviennent verrouillées sur cet appareil. Cet historique chiffré peut devenir inaccessible :\n\n${items}\n\nCette liste reflète l’historique actuel. Les sessions chiffrées créées ensuite sur un autre appareil deviennent aussi verrouillées. Restaurez l’ancienne clé pour les déverrouiller. Rien n’est supprimé de votre compte.`,
    forgetEncryptionKeySession: ({ name, id }) => `Session : ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Déclencheur : ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Historique d’exécution : ${id}`,
    forgetEncryptionKeyEmpty: 'Aucun historique chiffré trouvé.',
    forgetEncryptionKeyComplete: 'L’ancienne clé a été oubliée sur cet appareil.',
    forgetEncryptionKeyFailed: 'Impossible d’oublier la clé. Reconnectez-vous et réessayez ; l’historique chiffré doit d’abord être listé.',
};

const accountEncryptionRecoveryTranslations = { fr } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { fr: {
        pageTitle: 'Compte et Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `Non lié à ${service}`,
        serviceUnavailable: ({ service }) => `Impossible de joindre ${service}`,
        signedInToThisHome: 'Connecté à ce Home',
        checkingSignIn: 'Vérification de la connexion…',
        signInStatusUnavailable: 'État de connexion indisponible',
        machinesOnline: ({ online, total }) => `${online} sur ${total} ${total === 1 ? 'machine' : 'machines'} en ligne`,
        noMachines: 'Aucune machine pour l’instant',
        connectedNoMachinesOnline: 'Connecté · aucune machine en ligne',
        cantReach: 'Injoignable',
        signedOut: 'Déconnecté',
        signIn: 'Se connecter',
        link: 'Lier',
        linkSubtitle: 'Retrouvez vos Homes sur tous vos appareils',
        manageHomes: 'Gérer les Homes',
        connectionDetails: 'Détails de connexion',
        allHomes: 'Tous les Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · une seule liste`,
        addHome: 'Ajouter un Home…',
        addDevice: 'Ajouter un appareil',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "fr">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const fr = {
    title: 'Se connecter pour trouver tes Homes',
    cancelNote: 'L’annulation ne te déconnectera pas de tes Homes existants.', focusedHomePreserved: 'Le Home actif ne changera pas.',
    stages: { signingIn: 'Connexion en cours', findingHomes: 'Recherche de tes Homes', waitingApproval: 'En attente de l’approbation du Home' },
    errors: { provider: { title: 'Le fournisseur n’a pas terminé la connexion', body: 'Recommence la connexion.' }, expired: { title: 'Cette demande de connexion a expiré', body: 'Recommence la connexion.' }, identityChanged: { title: 'L’identité du service de connexion a changé', body: 'Vérifie qu’il s’agit bien du service de connexion que tu voulais utiliser avant de te reconnecter.' }, unavailable: { title: 'Le service de connexion est indisponible', body: 'Vérifie le service et réessaie. Tes Homes existants restent inchangés.' }, exchange: { title: 'La connexion n’a pas pu être terminée', body: 'Aucun identifiant du service de connexion n’a été enregistré. Recommence la connexion.' }, storage: { title: 'La connexion n’a pas pu être enregistrée', body: 'Les identifiants de tes Homes existants restent inchangés. Recommence la connexion.' }, homeLink: { title: 'Connecté, mais ce Home n’a pas pu être lié', body: 'Ta connexion est enregistrée. Réessaie de lier ce Home.' }, directoryRefresh: { title: 'Connecté, mais la liste de tes Homes n’a pas pu être actualisée', body: 'La connexion au service de connexion est prête. Réessaie d’actualiser la liste de tes Homes.' }, homeEnrollment: { title: 'Connecté, mais ton Home personnel n’a pas été ajouté', body: 'Ta connexion est enregistrée. Réessaie d’ajouter le Home.' }, invalid: { title: 'Cette demande de connexion n’est plus valide', body: 'Recommence la connexion.' }, accountDisabled: { title: 'Ce compte est désactivé', body: 'Contacte l’administrateur de ton service de connexion. Tes Homes existants restent inchangés.' } },
    actions: { startAgain: 'Recommencer', openHome: ({ homeName }: { homeName: string }) => `Ouvrir ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} est connecté`, body: 'Ta connexion est enregistrée et ce Home est prêt à être utilisé.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} n’est pas encore lié à ce compte`, signInAction: ({ homeName }: { homeName: string }) => `Se connecter à ${homeName}`, body: ({ homeName }: { homeName: string }) => `Connecte-toi directement à ${homeName}, ou scanne son code QR ou colle son lien de Home.`, scanBody: ({ homeName }: { homeName: string }) => `Scanne le code QR de ${homeName} ou colle son lien de Home pour le connecter.` },
    noHomes: { body: 'Ce compte n’a pas encore de Home. Actualise après en avoir ajouté un ailleurs, ou scanne le code QR d’un Home ou colle son lien de Home.' },
    approvalWait: { waitingBody: 'Approuve cette connexion depuis ton autre appareil déjà connecté.', cancelledTitle: 'Attente de l’approbation terminée', cancelledBody: 'Ta connexion reste enregistrée et tes Homes existants ne changent pas.' },
} as const;

const accountServiceOAuthTranslations = { fr } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { fr: {
        requestedByAgent: 'Action demandée par l’agent de la session',
        homeTarget: ({ serverId }) => `Home : ${serverId}`,
        sessionTarget: ({ sessionId }) => `Session cible : ${sessionId}`,
        oneShotConsequence: 'L’approbation ne vaut que pour cette demande. Elle n’accorde aucune autorisation future, Action ou native.',
        homeUnavailable: 'Cette approbation appartient à un Home indisponible sur cet appareil. Reconnectez ce Home pour prendre une décision.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "fr">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "fr": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `Toutes les ${matches} correspondances dans ${files} fichiers`,
        moreMatches: "Toutes les correspondances",
        textInFiles: "Texte dans les fichiers",
        everything: "Tout",
        refineSearch: "Affine ta recherche",
        partial: "Certains fichiers n’ont pas pu être parcourus. Les résultats sont incomplets.",
        updateRequired: "Mets à jour Happier sur cette machine pour chercher du texte dans les fichiers.",
        invalidPattern: "L’expression régulière est invalide. Modifie le motif et réessaie.",
        unavailable: "La recherche de texte est indisponible. Vérifie la connexion de la machine et réessaie.",
        placeholder: "Chercher fichiers, messages, commits, sessions, paramètres et actions",
        matchCase: "Respecter la casse",
        regex: "Expression régulière",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "fr": {
        "partialHistory": "Déjà envoyés couvre uniquement les sessions connues.",
        "loadedHistory": "Déjà envoyés affiche uniquement les messages chargés.",
        "open": "Ouvrir les prompts",
        "menu": "Prompts…",
        "placeholder": "Rechercher des prompts et messages envoyés",
        "favorites": "Favoris",
        "library": "Bibliothèque",
        "sentBefore": "Déjà envoyés",
        "builtIn": "Intégré",
        "readError": "Ce prompt n’a pas pu être lu. Réessayez.",
        "libraryError": "La bibliothèque n’a pas pu être chargée.",
        "partialLibrary": "Certains prompts n’ont pas pu être lus.",
        "loadOlder": "Rechercher les anciens messages",
        "stop": "Arrêter",
        "insert": "Insérer",
        "send": "Envoyer maintenant",
        "addFavorite": "Ajouter aux favoris",
        "removeFavorite": "Retirer des favoris",
        "empty": "Enregistrez un message comme prompt pour le réutiliser ici.",
        "applyError": "Le prompt n’a pas pu être appliqué. Réessayez.",
        "historyError": "Les anciens messages n’ont pas pu être chargés. Réessayez.",
        "title": "Prompts",
        "clear": "Effacer",
        "favorite": "Favori",
        "favoritesInvite": "Ajoutez une étoile à un prompt ou à un message envoyé pour le garder ici.",
        "saveAsFavorite": "Enregistrer comme prompt favori",
        "saveInPlaceStarred": ({ time }: { time: string }) => `De votre message ${time} · rejoint votre bibliothèque, avec une étoile`,
        "saveInPlace": ({ time }: { time: string }) => `De votre message ${time} · rejoint votre bibliothèque`,
        "noMatchesFor": ({ query }: { query: string }) => `Aucun prompt ni message chargé ne correspond à « ${query} »`,
        "previewInserts": "inséré, puis vous envoyez",
        "previewSent": "envoyé avant",
        "previewEdited": ({ time }: { time: string }) => `Modifié ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Recherche des messages plus anciens… ${searched} sur ${total} sessions`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { fr: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.fr.textInFiles,
            find: 'Rechercher',
            app_shell: 'Workspace',
            roles: 'Rôles',
            launch_profiles: 'Profils de lancement',
            discovery: 'Découverte des actions',
            computer: 'Contrôle de l’ordinateur',
            artifact_access: 'Partage d’artefacts',
            workflows: 'Flux de travail',
            workflow_effects: 'Webhooks et commandes',
            notifications: 'Gestion des notifications',
            machine_agent_install: 'Installations d’agents',
            machine_agent_sign_in: 'Connexion des agents',
            session_access: 'Partage de sessions',
            session_lifecycle: 'Cycle de vie des sessions',
            inventory: 'Inventaire des ordinateurs',
            messaging: 'Messagerie',
            session_control: 'Contrôles de session',
            intent_start: 'Revues et délégation',
            review_comments: 'Commentaires de revue',
            subagent_registry: 'Sous-agents',
            execution_run_control: 'Exécutions en arrière-plan',
            session_targeting: 'Ciblage des sessions',
            session_follow: 'Suivi des sessions',
            session_transcripts: 'Transcriptions de sessions',
            session_read_state: 'État de lecture',
            session_attention: 'À traiter',
            session_board: 'Tableau des sessions',
            session_discussion: 'Discussions de session',
            session_permissions: 'Autorisations de session',
            external_sessions: 'Sessions externes',
            voice_controls: 'Commandes vocales',
            current_ui_context: 'Écran actuel',
            companion_controls: 'Compagnon',
            memory: 'Mémoire',
            agent_acp_catalog: 'Agents ACP',
            prompt_library: 'Bibliothèque de prompts',
            daemon_admin: 'Administration du daemon',
            browser_control: 'Contrôle du navigateur',
            browser_diagnostics: 'Diagnostics du navigateur',
            browser_context: 'Contexte du navigateur',
            browser_automation: 'Automatisation du navigateur',
            browser_recording: 'Enregistrement du navigateur',
            local_services_inventory: 'Services locaux',
            local_services_launcher: 'Lanceur de services',
            local_services_preview: 'Aperçus des services',
            local_services_public_preview: 'Aperçus publics',
            local_services_actions: 'Actions des services',
            peer_mediation_observability: 'Diagnostics de connexion',
            devices_simulator: 'Simulateurs',
            approvals: 'Approbations',
            plugin_dev_loop: 'Développement de plugins',
            plugin_settings_administration: 'Réglages des plugins',
            plugin_permission_grants: 'Autorisations des plugins',
            plugin_webhooks: 'Webhooks des plugins',
            account_plugin_data: 'Données des plugins',
            account_sessions: 'Appareils connectés',
            account_security: 'Sécurité du compte',
            account_api_tokens: 'Jetons API',
            identity_github_apps: 'Apps GitHub',
            identity_providers: 'Fournisseurs de connexion',
            machine_pools: 'Groupes d’ordinateurs',
            ephemeral_runner: 'Exécuteurs',
            automation_events: 'Événements d’automatisation',
            automation_conversation: 'Conversations d’automatisation',
            scm_git: 'Git',
            scm_pull_request: 'Demandes de fusion',
            scm_repository: 'Dépôts',
            scm_diff_summary: 'Résumés des modifications',
            home_governance: 'Administration du Home',
            teams: 'Équipes',
            saved_secret_sharing: 'Secrets partagés',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { fr: {
        addHome: 'Ajouter un Home',
        addHomeSubtitle: 'Connectez-vous, reliez-vous par adresse ou utilisez-en un hébergé',
        addHomeDescription: 'Reliez un Home que vous utilisez déjà, ou utilisez-en un hébergé pour vous.',
        newGroup: 'Nouveau groupe',
        newGroupSubtitle: 'Voir ensemble les sessions de plusieurs Homes',
        groupsTitle: 'Groupes',
        homesInUse: 'Utilisé ici',
        thisDeviceTitle: 'Cet appareil',
        thisDeviceSubtitle: 'Comment il joint ses Homes',
        thisDeviceDescription: 'Comment cet appareil joint ses Homes : appareils en attente, connexion utilisée et Home qu’il exécute.',
        newHomeDraft: 'Nouveau Home',
        homeMissingTitle: 'Ce Home n’est pas sur cet appareil',
        homeMissingDescription: 'Il a été retiré, ou enregistré sur un autre appareil.',
        homeManageTitle: 'Gérer',
        homeAdministrationSubtitle: 'Personnes, connexion, accès et données de ce Home',
        groupMissingTitle: 'Ce groupe n’existe plus',
        groupMissingDescription: 'Il a été retiré. Vos Homes sont inchangés.',
        discard: 'Abandonner',
        sshSignInAgent: 'Votre agent SSH sur cet ordinateur',
        sshSignInKeyFile: 'Un fichier de clé privée sur cet ordinateur',
        sshSignInPassword: 'Utilisé une fois pour se connecter ; jamais enregistré',
        addMachineMenuSubtitle: 'Un ordinateur ou un serveur',
        addMachineDescription: 'Ajoutez un ordinateur ou un serveur pour que les agents y exécutent vos sessions.',
        machineJoinsHome: ({ home }) => `Rejoint ${home}`,
        pathThisComputerTitle: 'Cet ordinateur',
        pathThisComputerTask: 'Configurez-le en une étape',
        pathThisComputerCommand: 'Une commande dans votre terminal',
        pathSshTitle: 'Un serveur via SSH',
        pathSshChip: 'Par SSH',
        pathSshSubtitle: 'Une machine de dev, une VM ou un serveur cloud',
        pathAnotherTitle: 'Un autre ordinateur',
        pathAnotherSubtitle: 'Ouvrez un lien vers le Foyer sur cet ordinateur',
        machinePoolPrompt: 'Vous voulez que les sessions basculent entre machines ?',
        thisComputerCommandLead: ({ home }) => `Exécutez ceci dans un terminal de cet ordinateur. Happier s’installe et rejoint ${home} ; cette page le voit dès qu’il est prêt.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} exécute les agents pour ${home}. Happier installe un petit service d’arrière-plan qui démarre avec l’ordinateur.`,
        setUpThisComputer: 'Configurer cet ordinateur',
        desktopAppHint: 'Plutôt cliquer que taper ?',
        desktopAppLink: 'Installez l’app de bureau : elle configure cet ordinateur toute seule.',
        thisComputerRunningLead: ({ machine }) => `Configuration de ${machine}. Vous pouvez continuer à utiliser Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} est relié à un autre Home`,
        onAnotherHomeBody: ({ home }) => `Son service Happier exécute les sessions d’un autre Home. Le déplacer vers ${home} garde ses réglages ; les sessions déjà là-bas y restent.`,
        moveToHome: ({ home }) => `Le déplacer vers ${home}`,
        keepOnOtherHome: 'Le laisser où il est',
        sshLeadTask: ({ home }) => `Une machine de dev, une VM ou un serveur cloud déjà joignable en SSH. Cet ordinateur s’y connecte, installe Happier et rejoint ${home}.`,
        sshLeadCommand: ({ home }) => `Une machine de dev, une VM ou un serveur cloud joignable en SSH. Lancez la commande sur un ordinateur qui peut l’atteindre ; elle installe Happier et rejoint ${home}.`,
        setUpHost: ({ host }) => `Configurer ${host}`,
        sshSavedNote: 'L’hôte est enregistré dans Hôtes distants ; les mots de passe jamais.',
        sshRunningTitle: ({ host }) => `Configuration de ${host}`,
        sshRunningLead: 'S’exécute via SSH depuis cet ordinateur. Vous pouvez partir ; la liste des machines montre l’avancement et prévient à la fin.',
        anotherLead: ({ home }) => `Exécutez ceci dans un terminal de cet autre ordinateur. Happier s’installe et rejoint ${home}.`,
        anotherTerminalAction: 'Utiliser plutôt une commande de terminal',
        machineWatching: ({ subject }) => `En attente de ${subject} sur `,
        subjectThisComputer: 'cet ordinateur',
        subjectAnotherComputer: 'l’ordinateur',
        machineNotSeeingTitle: ({ subject }) => `Toujours pas de ${subject} ?`,
        machineNotSeeingBody: ({ home }) => `Happier attend toujours. En général la configuration s’est arrêtée sur une erreur, la machine ne joint pas ${home} ou elle a été configurée pour un autre Home.`,
        machineArrived: ({ machine }) => `${machine} est connecté`,
        machineConnectedJustNow: 'connecté à l’instant',
        machineStartSession: ({ machine }) => `Démarrer une session sur ${machine}`,
        machineAddAnother: 'En ajouter une autre',
        cancelSetup: 'Annuler',
        detectedOs: 'Détecté',
        sshSuggestionsTitle: 'Depuis votre configuration SSH et vos hôtes enregistrés',
        connectingToHome: ({ address }) => `Connexion à ${address}…`,
        pathThisComputerConnected: 'Connecté · voir ses agents',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "fr">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { fr: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const fr: typeof en = {
    titles: {
        conversation: 'Une conversation à côté',
    },
    descriptions: {
        conversation: ({ machine }) => `Demandez ce que vous voulez sans interrompre cette session. Elle tourne sur ${machine} à côté ; rien n’y revient sans que vous l’envoyiez.`,
    },
    chips: {
        engineTitle: 'Qui répond',
        addReviewer: 'Ajouter un relecteur',
        removeReviewer: ({ name }) => `Retirer ${name}`,
        scope: 'Quoi relire',
        advanced: 'Avancé',
    },
    reportToSession: 'Rendre compte à cette session',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} relectures démarrent à l’envoi` : 'Démarre à l’envoi',
    offline: ({ machine }) => `${machine} est hors ligne. L’agent démarre là-bas ; votre brouillon reste ici jusqu’à son retour.`,
    menu: {
        askSection: 'Demander à un agent',
        secondOpinionTitle: 'Deuxième avis',
        secondOpinionSubtitle: 'Une vérification indépendante avant de finir',
        keepGoingTitle: 'Continuer jusqu’au bout…',
        keepGoingSubtitle: 'Fixer un objectif dans le contrôle d’objectif',
        runWorkflowTitle: 'Lancer un workflow',
        runWorkflowSubtitle: 'De votre bibliothèque ou intégré',
        searchWorkflows: 'Rechercher des workflows…',
        yourLibrary: 'Votre bibliothèque',
        noWorkflows: 'Aucun workflow enregistré',
        addTriggerTitle: 'Ajouter un déclencheur…',
        addTriggerSubtitle: 'S’exécute ici à chaque événement',
        advancedTitle: 'Avancé…',
        advancedSubtitle: 'Plusieurs agents, permissions, profil',
        builtIn: 'Intégrés',
        allWorkflows: 'Tous les workflows…',
    },
    role: {
        replaces: ({ agent }) => `Remplace ${agent}`,
    },
    startRow: {
        subtitle: 'Brouillon · démarre à l’envoi',
        conversation: 'Nouvelle conversation',
        review: 'Nouvelle relecture',
        plan: 'Nouveau plan',
        delegate: 'Nouvelle tâche',
    },
    pane: {
        cancelRun: 'Annuler l’exécution',
        whenItFinishes: 'Quand il aura fini',
        sendToSession: ({ session }) => `Envoyer à ${session}`,
        replyTo: ({ agent }) => `Répondre à ${agent}…`,
        repliesGoTo: ({ session }) => `Les réponses vont à cet agent, pas à ${session}`,
    },
};

const agentStartTranslations = { fr };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { fr: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Accès au chiffrement",
                consequence: "Accorde un accès au chiffrement de tout le compte. La révocation arrête les futures autorisations API ; les clés ou données déjà obtenues ne peuvent pas être rappelées.",
                enabled: "Accès au chiffrement activé",
                bearerOnly: "Accès API uniquement",
                unknown: "Accès au chiffrement inconnu",
                outcomeUnknown: "La création a peut-être abouti. Actualisez la liste et révoquez ce jeton avant d’en créer délibérément un autre.",
                unsupported: "Ce Home ne prend pas encore en charge les jetons API chiffrés. Mettez-le à jour ou créez un jeton ordinaire.",
                notReady: "Restaurez l’accès au chiffrement sur ce Home avant de créer un jeton chiffré.",
                stale: "La clé de chiffrement du compte a changé. Restaurez l’accès sur ce Home.",
                idConflict: "Cet identifiant de jeton existe déjà. Révoquez ce jeton précis avant d’en créer un autre.",
            },
            unattended: {
                choice: "Accès autonome à l’équipe",
                consequence: "Copie dans ce jeton les méthodes d’authentification actuellement vérifiées de cet identifiant pour le travail restreint de l’équipe. L’accès au chiffrement est indépendant.",
                authorized: "Accès autonome à l’équipe autorisé",
                notAuthorized: "Aucun accès autonome à l’équipe",
                evidenceLimit: "Cet identifiant comporte trop de méthodes d’authentification vérifiées à copier. Aucun jeton n’a été créé.",
                evidenceUnavailable: "Cet identifiant connecté ne comporte aucune preuve d’authentification actuelle à copier. Authentifiez-vous à nouveau avec la méthode requise ; aucun jeton n’a été créé.",
            },
            title: 'Jetons API',
            entrySubtitle: 'Laisse des scripts, des serveurs et des apps intégrées agir pour toi, avec uniquement l’accès que tu leur donnes.',
            tokens: 'Jetons API',
            refreshing: 'Actualisation…',
            emptyTitle: 'Pas encore de jeton API',
            emptyBody: 'Les jetons permettent aux scripts et outils de confiance d’effectuer les actions automatisées que tu autorises. Crée un jeton lorsqu’une intégration a besoin d’accéder à ton compte actuel.',
            created: 'Créé',
            lastUsed: 'Dernière utilisation',
            neverUsed: 'Jamais utilisé',
            securityTitle: 'Sécurité',
            securityFooter: 'Ces actions s’appliquent à tout le compte actuel.',
            status: {
                active: 'Actif',
                expiresInMinutes: ({ count }) => `Expire dans ${count} min`,
                expiresInHours: ({ count }) => `Expire dans ${count} h`,
                expiresInDays: ({ count }) => `Expire dans ${count} j`,
                expired: 'Expiré',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, état : ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Plus d’actions pour ${label}`,
            create: {
                button: 'Créer un jeton',
                title: 'Créer un jeton API',
                subtitle: 'Nomme l’intégration et choisis quand ce jeton expire. Ton Home peut lire les requêtes et résultats de l’API ordinaire ; l’accès au chiffrement peut protéger les appels SDK compatibles.',
                submit: 'Créer un jeton',
                label: 'Libellé',
                labelPlaceholder: 'Automatisation des versions',
                expiry: 'Expire',
                expiryOptions: {
                    '30d': '30 jours',
                    '90d': '90 jours',
                    '1y': '1 an',
                    none: 'Sans expiration',
                },
                access: 'Accès',
                accessFull: 'Accès complet',
                accessLimited: 'Limité',
                accessLimitedDescription: 'Choisis ensuite les actions, sessions, modèles et sites web.',
                accessTitle: 'Choisir l’accès',
                continue: 'Continuer',
                back: 'Retour',
                actionSettingsPrefix: 'Ce jeton peut effectuer toute opération activée pour l’API externe et le SDK dans tes',
                actionSettingsLink: 'Réglages d’actions.',
            },
            reveal: {
                title: 'Enregistre ton jeton API',
                accessibilityAnnouncement: 'Copie ton jeton maintenant : il n’est affiché qu’une seule fois.',
                successTitle: 'Jeton créé',
                shownOnce: 'Copie ce jeton maintenant. Pour ta sécurité, Happier ne peut pas l’afficher de nouveau.',
                copy: 'Copier le jeton',
                copied: 'Copié',
                dismissTitle: 'Quitter sans confirmer ?',
                dismissBody: 'Ce jeton ne sera plus affiché. Copie-le d’abord ou confirme que tu l’as enregistré en lieu sûr.',
                copyFirst: 'Garder le jeton visible',
                savedIt: 'Je l’ai enregistré',
            },
            revoke: {
                title: ({ label }) => `Révoquer « ${label} » ?`,
                body: 'L’accès au serveur et à l’API s’arrêtera lors de la prochaine vérification. Un daemon local ayant récemment vérifié ce jeton API peut encore l’accepter pendant une minute. Cette action est irréversible.',
                confirm: 'Révoquer le jeton',
            },
            revokeAll: {
                title: 'Révoquer tous les jetons API',
                subtitle: 'Désactive tous les jetons API de ce compte.',
                body: 'L’accès au serveur et à l’API s’arrêtera lors de la prochaine vérification. Les intégrations qui utilisent ces jetons cessent de fonctionner et leurs identifiants intégrés sont déconnectés. Les daemons locaux ayant récemment vérifié ces jetons API peuvent encore les accepter pendant une minute. Cette action est irréversible.',
                confirm: 'Tout révoquer',
                railAction: 'Révoquer tous les jetons API…',
            },
            signOutEverywhere: {
                title: 'Se déconnecter partout',
                subtitle: 'Met fin à toutes les sessions connectées de ce compte.',
                body: 'Toutes les sessions connectées dans les navigateurs et sur les appareils prendront fin. Les jetons API restent actifs ; révoque-les séparément depuis cet écran.',
                confirm: 'Se déconnecter partout',
            },
            errors: {
                labelRequired: 'Saisis un libellé avant de créer le jeton.',
                accountChanged: 'Ton compte ou ton Home actif a changé, donc rien n’a été modifié. Rouvre-le pour continuer.',
                presentUserRequired: 'Confirme ton identité dans l’invite de connexion, puis réessaie.',
                offline: 'Happier n’a pas pu joindre ton compte. Vérifie ta connexion, puis réessaie.',
                unavailable: 'Cette action est indisponible pour le moment. Réessaie dans un instant.',
                copyFailed: 'Le jeton n’a pas pu être copié. Sélectionne-le et copie-le manuellement avant de fermer.',
                listTitle: 'Jetons API indisponibles',
                grantIncomplete: 'Termine de choisir l’accès avant de créer le jeton.',
            },
            embedPill: 'Intégré',
            embedRowHint: 'Ouvre cette intégration dans Réglages, Intégrations.',
            summary: {
                full: 'Accès complet',
                allActions: 'Toutes les actions',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 session' : `${count} sessions`),
                computers: ({ count }) => (count === 1 ? '1 ordinateur' : `${count} ordinateurs`),
                approve: 'Peut approuver',
                models: ({ count }) => (count === 1 ? '1 modèle' : `${count} modèles`),
                websites: ({ count }) => (count === 1 ? '1 site web' : `${count} sites web`),
                content: 'Accès au contenu',
                noExpiry: 'Sans expiration',
                expires: ({ date }) => `Expire le ${date}`,
                expired: ({ date }) => `Expiré le ${date}`,
            },
            grant: {
                accessTitle: 'Accès',
                back: 'Accès',
                onlyThese: 'Uniquement ceux-ci',
                selectedCount: ({ count }) => (count === 1 ? '1 sélectionné' : `${count} sélectionnés`),
                reviewUnnamed: 'Ce jeton',
                actions: {
                    title: 'Actions autorisées',
                    all: 'Toutes les actions',
                    none: 'Choisis au moins une action',
                    search: 'Rechercher des actions',
                    noMatches: ({ query }) => `Aucune action ne correspond à « ${query} »`,
                    groupDescription: 'Un groupe entier couvre aussi les actions qui y seront ajoutées plus tard.',
                    familyCount: ({ count }) => (count === 1 ? 'Groupe · 1 action' : `Groupe · ${count} actions`),
                    includedByFamily: ({ family }) => `Inclus avec ${family}`,
                },
                targets: {
                    title: 'Sessions et ordinateurs',
                    all: 'Toutes les sessions et tous les ordinateurs',
                    none: 'Choisis au moins une session ou un ordinateur',
                    computers: 'Ordinateurs',
                    computersDescription: 'Un ordinateur couvre toutes ses sessions, actuelles et futures.',
                    sessions: 'Sessions individuelles',
                    searchSessions: 'Rechercher des sessions',
                    noSessions: 'Aucune session pour l’instant',
                    noSessionMatches: ({ query }) => `Aucune session ne correspond à « ${query} »`,
                    noComputers: 'Aucun ordinateur pour l’instant',
                },
                models: {
                    title: 'Modèles',
                    any: 'N’importe quel modèle',
                    onlyThese: 'Uniquement ces modèles',
                    none: 'Choisis au moins un modèle',
                    pickerDescription: 'Les autres modèles sont refusés, pas seulement masqués. « Automatique » n’est plus proposé une fois que tu choisis des modèles.',
                    noModels: 'Aucun modèle à choisir pour l’instant',
                },
                approve: {
                    title: 'Approuver les demandes',
                    on: 'Il peut approuver l’utilisation d’outils et les demandes dans les sessions ci-dessus, y compris celles qu’il a lui-même lancées. Il ne peut jamais modifier les jetons, la sécurité ou les plugins.',
                    off: 'Les demandes t’attendent dans Happier.',
                },
                websites: {
                    title: 'Sites web',
                    description: 'Les pages de ces sites peuvent utiliser le jeton depuis un navigateur. Laisse vide pour les scripts et les serveurs.',
                    inputLabel: 'Ajouter un site web',
                    placeholder: 'https://app.example.com',
                    add: 'Ajouter',
                    invalid: 'Commence par https://, ou http:// pour localhost.',
                    duplicate: 'Ce site web figure déjà dans la liste.',
                    remove: ({ origin }) => `Retirer ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Ce qu’il peut faire',
                whatItCanDoDescription: 'Actions que ce jeton peut exécuter pour toi. Tout le reste est refusé.',
                everyAction: 'Toutes les actions activées pour l’API externe et le SDK',
                wholeGroup: 'Groupe entier',
                where: 'Où',
                whereDescription: 'Sessions et ordinateurs qu’il peut atteindre.',
                computerCovers: 'Toutes les sessions de cet ordinateur',
                unknownComputer: 'Un ordinateur qui n’est plus répertorié',
                unknownSession: 'Une session qui n’est plus répertoriée',
                modelsDescription: 'Les autres modèles sont refusés, pas seulement masqués.',
                approvals: 'Approbations',
                approvesOn: 'Approuve les demandes',
                approvesOff: 'N’approuve pas les demandes',
                websitesDescription: 'Les pages de ces sites peuvent l’utiliser dans un navigateur.',
                noWebsites: 'Scripts et serveurs uniquement',
                content: 'Accès au contenu',
                contentOn: 'Il peut lire le contenu chiffré de bout en bout via les appels SDK compatibles.',
                contentOff: 'Il ne peut pas lire le contenu chiffré de bout en bout.',
                children: 'Identifiants intégrés',
                childrenDescription: 'Clés à courte durée de vie que ton app a générées à partir de ce jeton pour ses pages.',
                childrenCount: ({ count }) => (count === 1 ? '1 actif' : `${count} actifs`),
                childrenConsequence: 'Déconnectés quand tu modifies l’accès ou révoques ce jeton.',
                sessionLimits: 'Sessions',
                sessionLimitsDescription: 'Les sessions qu’il peut démarrer et les modes de permission que ses messages peuvent utiliser.',
                createsSessions: 'Démarre des sessions',
                createsSessionsOn: ({ computer }: { computer: string }) => `Sur ${computer}, dans un dossier privé géré par Happier.`,
                editAccess: 'Modifier l’accès',
                revokeFootnote: 'Les scripts et intégrations qui l’utilisent cessent de fonctionner à leur prochaine requête.',
                created: ({ date }) => `Créé le ${date}`,
                lastUsed: ({ date }) => `Dernière utilisation le ${date}`,
                missingTitle: 'Ce jeton n’existe plus',
                missingBody: 'Il a été révoqué ou a expiré, puis supprimé. Tes autres jetons sont toujours listés.',
                backToTokens: 'Afficher les jetons API',
            },
            edit: {
                title: 'Modifier l’accès',
                save: 'Enregistrer',
                signsOut: 'Les identifiants intégrés actifs seront déconnectés.',
            },
            cliPolicy: {
                sectionTitle: 'CLI et daemon',
                sectionDescription: 'Ce que les commandes sur tes ordinateurs peuvent faire avec ta connexion.',
                title: 'Autoriser les approbations et les modifications du compte depuis la CLI et le daemon',
                description: 'Permet aux commandes sur tes ordinateurs d’approuver des demandes et de modifier les réglages du compte. Désactive-le si des agents s’exécutent avec un accès au shell. Un ordinateur peut aussi refuser avec HAPPIER_CLI_PRESENT_USER=disallowed. Ce changement reconnecte brièvement tes ordinateurs.',
                unavailable: 'Ce réglage n’a pas pu être lu. Réessaie dans un instant.',
                saveFailed: 'Ce réglage n’a pas pu être modifié. Réessaie dans un instant.',
            },
            notices: {
                revoked: 'Jeton API révoqué.',
                revokedAll: 'Tous les jetons API ont été révoqués.',
                signedOutEverywhere: 'Déconnecté partout. Les jetons API restent actifs.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { fr: {
        description: 'Ce que vous et vos agents avez enregistré — prêt à lire, réutiliser et partager.',
        newDocument: 'Nouveau document',
        searchPlaceholder: 'Rechercher des artefacts',
        kindLabel: 'Type',
        sourceLabel: 'Source',
        kinds: {
            all: 'Tous les types',
            document: 'Documents',
            prompt: 'Prompts',
            memory: 'Mémoires',
            board: 'Tableaux',
            workflow: 'Workflows',
            role: 'Rôles',
            launchProfile: 'Profils de lancement',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            memory: 'Mémoire',
            board: 'Tableau',
            workflow: 'Workflow',
            role: 'Rôle',
            launchProfile: 'Profil de lancement',
        },
        sort: {
            label: 'Trier',
            updated_desc: 'Modifiés récemment',
            created_desc: 'Créés récemment',
            title_asc: 'Titre',
        },
        view: {
            label: 'Affichage',
            grid: 'Grille',
            list: 'Liste',
            folders: 'Dossiers',
        },
        folders: {
            newFolder: 'Nouveau dossier',
            newFolderInside: 'Nouveau dossier à l’intérieur',
            rename: 'Renommer',
            moveTo: 'Déplacer vers un dossier…',
            moveItemTo: ({ name }) => `Déplacer « ${name} » vers`,
            newFolderEllipsis: 'Nouveau dossier…',
            moveVerb: 'Déplacer vers',
            topLevel: 'Niveau supérieur',
            moveToTopLevel: 'Déplacer au niveau supérieur',
            deleteFolder: 'Supprimer le dossier',
            deleteTitle: ({ name }) => `Supprimer « ${name} » ?`,
            deleteBody: 'Ses éléments et dossiers remontent d’un niveau. Rien n’est supprimé.',
            nameHelp: 'Les dossiers n’appartiennent qu’à vous. Classer un élément ne change rien pour les personnes avec qui il est partagé.',
            namePlaceholder: 'Nom du dossier',
            create: 'Créer',
            options: ({ name }) => `Options de ${name}`,
            expand: ({ name }) => `Développer ${name}`,
            collapse: ({ name }) => `Réduire ${name}`,
            columnName: 'Nom',
            columnEdited: 'Modifié',
            emptyInvite: 'Aucun dossier pour l’instant. Regroupez ce qui va ensemble ; vous seul voyez votre classement.',
            unavailable: 'Les dossiers n’ont pas pu être chargés depuis ce Home. Tout est listé sans eux.',
            saveFailed: 'Cette modification n’a pas été enregistrée. Réessayez.',
            refusedCycle: 'Un dossier ne peut pas être déplacé dans lui-même',
            refusedUnavailable: 'Les dossiers sont indisponibles pour le moment',
            refusedOther: 'Impossible de le déplacer ici',
            showAllKinds: 'Afficher tous les types dans Artefacts',
            promptSearch: 'Rechercher des prompts et des skills',
        },
        provenance: {
            savedByYou: 'Enregistré par vous',
            sharedWithYou: 'Partagé avec vous',
            fromFile: ({ name }) => `Depuis ${name}`,
            openSession: ({ session }) => `Ouvrir ${session}`,
        },
        emptyTitle: 'Gardez ce que vos agents créent',
        emptyBody: 'Les plans, notes, code et tableaux que vous ou vos agents enregistrez arrivent ici — lisibles sur tous vos appareils et prêts à partager avec vos équipes.',
        emptyHint: 'Ou demandez à un agent « enregistre ça comme artefact ».',
        loadFailedTitle: 'Impossible de charger vos artefacts',
        loadFailedBody: 'Vérifiez votre connexion, puis réessayez. Rien n’a été perdu.',
        retainedBody: "Actualisation impossible. Les derniers artefacts chargés restent affichés.",
        quota: {
            accountTitle: 'Le stockage des artefacts est plein',
            documentTitle: 'Trop volumineux pour être enregistré',
            accountBody: ({ used, limit }) => `${used} utilisés sur ${limit}, versions comprises. Supprimez ou exportez les artefacts inutiles pour en enregistrer de nouveaux.`,
            documentBody: ({ size, limit }) => `Il ferait ${size} ; chaque artefact peut contenir jusqu’à ${limit}. Vos modifications sont conservées.`,
        },
        open: {
            document: 'Ouvrir le document',
            prompt: 'Ouvrir le prompt',
            memory: 'Ouvrir la mémoire',
            board: 'Ouvrir le tableau',
            workflow: 'Ouvrir le workflow',
            role: 'Ouvrir le rôle',
            launchProfile: 'Ouvrir le profil de lancement',
        },
        openAsPage: 'Ouvrir en page',
        actions: {
            edit: 'Modifier',
            history: 'Historique',
            share: 'Partager',
            more: 'Plus d’actions',
            copyLink: 'Copier le lien',
            linkCopied: 'Lien copié',
        },
        history: {
            title: 'Historique',
            current: 'Actuelle',
            now: 'Maintenant',
            restoreNote: 'La restauration l’ajoute comme nouvelle version. Rien n’est perdu.',
            loadFailed: 'Impossible de charger l’historique. Réessayez.',
            empty: 'Pas encore de version antérieure. Chaque enregistrement en garde une.',
            versionsLabel: 'Versions',
            restoreFailed: 'Impossible de restaurer cette version. Réessayez.',
            savedByUser: 'Enregistré par un utilisateur',
            savedByAgentSession: 'Enregistré par une session d’agent',
            restoredVersion: ({ n }) => `Restauré depuis la version ${n}`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Conserve les ${count} dernières versions.`,
            restore: ({ n }) => `Restaurer la version ${n}`,
        },
        savedToday: ({ count }) => `${count} enregistrés aujourd’hui`,
        noMatch: ({ query }) => `Aucun artefact ne correspond à « ${query} »`,
        storage: {
            meter: ({ used, limit }) => `${used} sur ${limit}`,
            a11y: ({ used, limit }) => `Stockage des artefacts, ${used} utilisés sur ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Modifié ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "fr">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { fr: translated({
        automationPages: {
            index: {
                description: 'Du travail qui démarre seul : selon un planning, depuis un Event ou à la fin d’un tour de session.',
            },
            settings: {
                description: 'La quantité de travail d’automatisation que chaque machine accepte, et la durée de conservation des exécutions terminées.',
                capacityTitle: 'Capacité',
                capacityDescription: 'S’applique à chaque machine qui exécute des automatisations.',
                historyTitle: 'Historique des exécutions',
                historyDescription: 'Les exécutions terminées que vous pouvez encore ouvrir depuis une automatisation.',
            },
            detail: {
                description: 'Démarre du travail seule dès qu’un de ses déclencheurs se produit.',
                triggerCount: ({ count }: { count: number }) => (count <= 1 ? `${count} déclencheur` : `${count} déclencheurs`),
                overviewDescription: 'Ce qu’elle exécute, et comment la lancer ou la modifier.',
                runNowSubtitle: 'Lancer une exécution maintenant, sans attendre un déclencheur.',
                editSubtitle: 'Modifier son nom, ce qu’elle exécute et ses déclencheurs.',
                machineAssignmentsDescription: 'Les machines qui peuvent prendre les exécutions de cette automatisation.',
            },
            run: {
                description: 'Ce qui a démarré cette exécution, où elle a tourné et ce qu’elle a produit.',
                statusTitle: 'État',
                statusDescription: 'Où en est cette exécution, et ce que vous pouvez encore en faire.',
                causeTitle: 'Ce qui l’a démarrée',
                causeDescription: 'Le déclencheur et l’événement qui ont admis cette exécution. Ils ne changent jamais ensuite.',
            },
            gate: {
                serverTitle: 'Les automatisations sont désactivées sur ce Home',
                serverBody: 'Les administrateurs de ce Home ont désactivé les automatisations. Demandez à l’un d’eux de les réactiver.',
                openFeatures: 'Ouvrir les réglages des fonctionnalités',
                unknownTitle: 'Impossible de vérifier les automatisations pour l’instant',
                unknownBody: 'Happier n’a pas pu joindre cette Home pour vérifier si les automatisations sont activées. Vérifiez à nouveau quand elle sera de retour en ligne.',
                unsupportedTitle: 'Cette Home ne prend pas encore en charge les automatisations',
                unsupportedBody: 'Son serveur est antérieur aux automatisations. Mettez à jour le serveur de la Home pour les utiliser.',
                unsupportedContextTitle: 'Les automatisations ne sont pas disponibles ici',
                unsupportedContextBody: 'Les Homes que vous consultez ne prennent pas toutes en charge les automatisations.',
            },
            editor: {
                description: 'Nommez-la, choisissez ce qu’elle exécute, puis ajoutez les déclencheurs qui la lancent.',
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

const automationTriggerSetTranslations = { fr: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Quand la session démarre',
                sessionArchived: 'Quand la session est archivée',
            },
            triggersTitle: 'Déclencheurs',
            emptyBody: 'Aucun déclencheur automatique. Vous pouvez toujours lancer cette automatisation manuellement.',
            orSemantics: 'Ajoutez autant de déclencheurs que nécessaire. Ils fonctionnent indépendamment : l’automatisation se lance dès que l’un d’eux correspond.',
            enabledSubtitle: 'Mettre toute l’automatisation en pause sans modifier ses déclencheurs.', addTrigger: 'Ajouter un déclencheur',
            addTriggerSubtitle: 'Planifiez-la, connectez un événement ou attendez la fin d’un tour précis.', scheduleTitle: 'Planification', eventTitle: 'Événement du plugin',
            turnCompletedTitle: 'À la fin de ce tour', turnCompletedSubtitle: 'Se lance une fois après la fin exacte du tour parent sélectionné.', selectedSession: 'Session sélectionnée',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · déclencheur unique ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Toutes les ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Activer ${title}`, editScheduleTitle: 'Modifier la planification', scheduleType: 'Type de planification',
            chooseSession: 'Choisir une session active', eventEditorUnavailable: 'La configuration de l’événement est indisponible sur la machine actuelle.',
            removeTitle: 'Supprimer ce déclencheur ?', removeBody: 'Les prochains événements de ce déclencheur ne lanceront plus l’automatisation. L’historique des exécutions restera inchangé.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Rechercher des événements',
            refreshFailedTitle: 'Impossible d’actualiser les automatisations',
            refreshFailedBody: 'La liste des automatisations n’a pas pu être lue pour le moment. Réessayez pour charger la liste actuelle.',
            actionTitle: 'À la fin de ce tour…', createNew: 'Créer une automatisation', createNewSubtitle: 'Commencez avec ce tour précis déjà sélectionné.',
            addToExistingSubtitle: 'Ajoutez ce tour précis à une automatisation existante.', searchPlaceholder: 'Rechercher des automatisations',
            eventListA11y: 'Choisir l’événement du cycle de vie de la session',
            destinationA11y: 'Choisir où ajouter le déclencheur de ce tour', staleTitle: 'Ce tour a changé',
            staleBody: 'Le tour sélectionné n’est plus le tour parent actif. Actualisez puis choisissez explicitement le tour actuel.',
            useCurrentTurn: 'Utiliser le tour actuel', unavailable: 'Aucun tour parent n’est actif pour le moment.',
            resolvingRowSubtitle: 'Vérification des automatisations que vous pouvez utiliser…',
            unavailableRowSubtitle: 'Détails indisponibles — cette automatisation ne peut pas être vérifiée pour cette session.',
            incompleteNoticeTitle: 'Certaines automatisations n’ont pas pu être lues',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const fr: BoardsTranslations = {
    title: 'Tableaux',
    newBoard: 'Nouveau tableau',
    defaultName: 'Tableau sans titre',
    index: {
        title: 'Vos tableaux',
        body: 'Un tableau garde sessions, exécutions, workflows et machines en direct au même endroit, organisés à votre façon.',
    },
    notFound: {
        title: 'Ce tableau n\'existe plus',
        body: 'Il a été supprimé, ou il appartient à un Home qui n\'est pas connecté ici.',
    },
    meta: {
        needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
        items: ({ count }) => (count === 1 ? '1 élément' : `${count} éléments`),
        handPicked: 'Choisis à la main',
        empty: 'Vide',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'A besoin de vous', description: 'Tout ce qui vous attend' },
        running: { title: 'En cours', description: 'Exécutions de workflows en cours' },
        my_machines: { title: 'Mes machines', description: 'Présence et ce qui tourne sur chacune' },
        filter: { title: 'Sessions', description: 'Toutes les sessions actives' },
    },
    header: {
        layoutA11y: 'Disposition du tableau',
        canvas: 'Canevas',
        byStatus: 'Par statut',
        add: 'Ajouter au tableau',
        settings: 'Réglages du tableau',
    },
    kinds: {
        session: 'Session',
        workflow_run: 'Exécution de workflow',
        workflow: 'Workflow',
        machine: 'Machine',
    },
    card: {
        untitled: 'Élément indisponible',
        unavailable: 'Indisponible',
        unavailableBody: 'Son Home n\'est pas connecté sur cet appareil. Il reste sur le tableau.',
        notLoaded: 'Pas encore chargé',
        remove: 'Retirer du tableau',
        moveHint: 'Les touches fléchées déplacent cette carte sur la grille.',
        moved: ({ x, y }) => `Déplacée en ${x}, ${y}`,
        moveActions: { up: 'Déplacer vers le haut', down: 'Déplacer vers le bas', left: 'Déplacer vers la gauche', right: 'Déplacer vers la droite' },
        machine: {
            online: 'En ligne',
            offline: 'Hors ligne',
            running: ({ count }) => (count === 1 ? '1 session en cours' : `${count} sessions en cours`),
            needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
            idle: 'Aucune session en cours',
            offlineBody: 'Ses sessions attendent son retour.',
        },
        workflow: {
            noRuns: 'Aucune exécution pour l\'instant',
            lastRun: ({ word, age }) => `Dernière exécution ${age} · ${word}`,
            needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
        },
        run: {
            waitingForYou: 'Attend votre relecture',
            started: ({ age }) => `Lancée ${age}`,
        },
    },
    canvas: {
        snapsHere: 'S\'aimante ici',
        snapOnceHint: 'Maintenez ⇧ pour aligner une fois',
    },
    settings: {
        title: 'Réglages du tableau',
        name: 'Nom',
        whatsOn: 'Ce que contient ce tableau',
        whichSessions: 'Quelles sessions',
        addedByHand: 'Ajouté à la main',
        addedByHandNone: 'Rien pour l\'instant',
        add: 'Ajouter',
        layout: 'Disposition',
        layoutDescription: 'Le canevas garde votre arrangement quand vous changez.',
        snap: 'Aimanter à la grille',
        pin: 'Afficher dans la liste des sessions',
        pinDescription: 'Épingle ce tableau au-dessus de vos sessions.',
        delete: 'Supprimer le tableau',
        deleteConfirmTitle: 'Supprimer ce tableau ?',
        deleteConfirmBody: 'Seul le tableau disparaît. Ses sessions, exécutions, workflows et machines restent tels quels.',
    },
    add: {
        title: 'Ajouter au tableau',
        search: 'Rechercher des éléments',
        groups: { sessions: 'Sessions', workflows: 'Workflows', runs: 'Exécutions de workflows', machines: 'Machines' },
        onBoard: 'Sur ce tableau',
        addHint: 'Ajouter',
        addAndPlaceHint: 'Ajouter et placer',
        empty: 'Aucun résultat.',
    },
    empty: {
        title: 'Choisissez ce que montre ce tableau',
        body: 'Ajoutez à la main des sessions, workflows, exécutions ou machines, ou affichez une section comme « A besoin de vous ». Vous les arrangez ; le tableau les garde en direct.',
        action: 'Ajouter au tableau',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Ouvrir la galerie',
        galleryHint: 'Tous les widgets, avec un aperçu en direct',
        addHint: 'Vous seul voyez vos tableaux',
        widthOne: 'Une carte',
        widthTwo: 'Deux cartes',
        moveEarlier: 'Avancer',
        moveLater: 'Reculer',
        remove: 'Retirer du tableau',
        menuA11y: ({ widget }) => `Options de ${widget}`,
        arrived: ({ count }) => (count === 1 ? '1 widget vient d’arriver' : `${count} widgets viennent d’arriver`),
        undo: 'Annuler',
        dismiss: 'Ignorer',
    },
    saveFailed: {
        tooLarge: 'Ce tableau dépasse la limite de stockage des tableaux. Retirez quelques éléments, puis réessayez.',
        notFound: 'Ce tableau a été supprimé sur un autre appareil.',
        generic: 'Votre modification n\'a pas atteint votre compte, le tableau est donc inchangé.',
        retry: 'Réessayer',
        dismiss: 'Ignorer',
        createTitle: 'Ce tableau n’a pas été créé',
    },
};

const boardsTranslations = { fr };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { fr: {
        agentFallbackName: 'L’agent',
        agentBrowsing: ({ agent }) => `${agent} navigue`,
        clickTarget: ({ target }) => `Clique sur « ${target} »`,
        doing: {
            click: 'Clique sur la page',
            type: 'Saisit du texte',
            fill: 'Remplit un champ',
            scroll: 'Fait défiler',
            navigate: 'Ouvre une page',
            history: 'Parcourt l’historique',
            reload: 'Recharge la page',
            press: 'Appuie sur une touche',
            select: 'Choisit une option',
            drag: 'Fait glisser',
            upload: 'Envoie un fichier',
            look: 'Regarde la page',
            other: 'Travaille dans la page',
        },
        takeControl: 'Prendre la main',
        stopping: ({ agent }) => `Arrêt de ${agent}…`,
        stoppingDetail: 'Termine sa dernière action',
        lastActionMayHaveLanded: ({ agent }) => `La dernière action de ${agent} a peut-être eu lieu`,
        youHaveControl: 'Vous avez la main',
        stopUnconfirmed: 'Arrêt non confirmé',
        checkAgain: 'Vérifier à nouveau',
        pausedUntilHandBack: ({ agent }) => `${agent} est en pause jusqu’à ce que vous rendiez la main`,
        handBack: 'Rendre la main',
        stream: {
            connectingTitle: ({ agent }) => `Connexion au navigateur de ${agent}`,
            connectingBody: ({ machine }) => `Il tourne sur ${machine}. La page apparaît ici dès la première image.`,
            stalled: 'Dernière image affichée · reconnexion',
            endedTitle: ({ agent }) => `${agent} a fermé ce navigateur`,
            endedBody: 'La page n’est plus affichée ici.',
            openPageHere: "Ouvrir la page ici",
            unavailableTitle: ({ agent }) => `Impossible d’afficher ici le navigateur de ${agent}`,
            unavailableBody: ({ agent }) => `${agent} continue de naviguer ; ses actions apparaissent toujours dans la conversation.`,
            tryAgain: 'Réessayer',
            inputA11y: 'La page. Touchez, faites défiler ou tapez pour prendre la main.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Enregistrement, ${elapsed}`,
            discard: 'Supprimer l’enregistrement',
        },
        openInYourBrowser: 'Ouvrir dans votre navigateur',
        slowPage: 'Cette page met du temps à charger',
        confidentialHeld: ({ agent }) => `Saisie privée ici · masquée à ${agent} jusqu’à la fermeture de la page`,
        closePage: 'Fermer la page',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "fr">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { fr: {
        opened: ({ page }) => `A ouvert ${page}`,
        openedPage: 'A ouvert une page',
        reloaded: 'A rechargé la page',
        wentBack: 'Est revenu en arrière',
        wentForward: 'Est allé en avant',
        clicked: ({ target }) => `A cliqué sur ${target}`,
        clickedPage: 'A cliqué sur la page',
        typedInto: ({ target }) => `A saisi dans ${target}`,
        typed: 'A saisi du texte sur la page',
        filledIn: ({ target }) => `A rempli ${target}`,
        filled: 'A rempli un champ',
        pressed: ({ key }) => `A appuyé sur ${key}`,
        pressedKey: 'A appuyé sur une touche',
        scrolled: 'A fait défiler la page',
        pointedAt: ({ target }) => `A pointé ${target}`,
        pointed: 'A pointé la page',
        choseIn: ({ target }) => `A choisi une option dans ${target}`,
        chose: 'A choisi une option',
        uploadedTo: ({ target }) => `A envoyé un fichier dans ${target}`,
        uploaded: 'A envoyé un fichier',
        dragged: ({ target }) => `A fait glisser ${target}`,
        draggedPage: 'A fait glisser sur la page',
        looked: 'A regardé la page',
        screenshot: 'A pris une capture d’écran',
        recordingStarted: 'A commencé à enregistrer la page',
        recordingStopped: 'A arrêté l’enregistrement',
        other: 'A utilisé le navigateur',
        watch: 'Voir',
        watchA11y: 'Ouvrir cette page dans le navigateur',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "fr">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { fr: {
        changedFileEvidence: translated({
            before: 'Avant',
            after: 'Après',
            binary: 'Fichier binaire',
            truncated: 'Le contenu de la preuve a été borné ; la taille d’origine et les statistiques de modification sont conservées lorsqu’elles sont disponibles.',
            truncatedOldBytes: ({ count }) => `Contenu d’origine avant : ${count} octets`,
            truncatedNewBytes: ({ count }) => `Contenu d’origine après : ${count} octets`,
            truncatedDiffBytes: ({ count }) => `Diff d’origine : ${count} octets`,
            truncatedAddedLines: ({ count }) => `Lignes ajoutées : ${count}`,
            truncatedRemovedLines: ({ count }) => `Lignes supprimées : ${count}`,
            kind: {
                added: 'Ajouté',
                modified: 'Modifié',
                deleted: 'Supprimé',
                renamed: 'Renommé',
                copied: 'Copié',
                unknown: 'Type de modification indisponible',
            },
            howDetermined: 'Comment cela a été déterminé',
            howDeterminedForFile: ({ path }) => `Comment ${path} a été déterminé`,
            content: {
                exact: 'Modification exacte du dépôt',
                strong: 'Preuve de contenu solide',
                best_effort: 'Preuve de contenu approximative',
            },
            attribution: {
                session_exact: 'Lié à cette session',
                session_likely: 'Probablement modifié par cette session',
                session_possible: 'Peut-être modifié par cette session',
                unknown: 'Attribution de session indisponible',
            },
            reason: {
                provider_correlated: 'L’agent a signalé cette modification pour ce tour.',
                canonical_tool_correlated: 'Un outil de diff ou de patch a relié cette modification à ce tour.',
                checkpoint_no_happier_overlap_observed: 'Le checkpoint n’a enregistré aucun tour Happier chevauchant dans ce processus.',
                checkpoint_overlap_observed: 'Un autre tour Happier a chevauché l’intervalle de capture du checkpoint.',
                workspace_touched_path: 'Ce chemin a été touché dans le workspace ; cela n’identifie pas la session qui l’a modifié.',
                unavailable: 'Les preuves n’établissent pas quelle session a effectué cette modification.',
            },
            overlap: {
                observed: 'Un autre tour Happier a chevauché ce checkout pendant la capture. Les observations ne couvrent que ce processus ; les autres processus et les écrivains externes ne sont pas suivis.',
                not_observed: 'Aucun tour Happier chevauchant n’a été observé dans ce processus. Les autres processus et les écrivains externes ne sont pas suivis ; cela n’établit pas une paternité exclusive.',
                unknown: 'Le chevauchement du checkpoint est inconnu. Les autres processus et les écrivains externes ne sont pas suivis.',
            },
            sources: {
                provider_native: 'Rapport de modifications natif de l’agent',
                provider_tool: 'Rapport d’un outil de l’agent',
                canonical_diff_tool: 'Preuve d’un outil de diff',
                canonical_patch_tool: 'Preuve d’un outil de patch',
                scm_checkpoint: 'Checkpoint du dépôt',
                scm_reconciled: 'Instantané réconcilié du dépôt',
                inferred: 'Chemin touché dans le workspace',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const fr = {
    title: 'Ligne de commande',
    footer: 'Happier Desktop ajoute ou supprime uniquement les entrées PATH qu’il a créées. Les entrées écrites par l’installateur du shell restent intactes.',
    addTitle: 'Ajouter happier au PATH',
    addSubtitle: 'Rends la commande happier disponible dans les nouveaux terminaux.',
    removeTitle: 'Retirer happier du PATH',
    removeSubtitle: 'Supprime uniquement les entrées PATH ajoutées par Happier Desktop.',
    working: 'Mise à jour de ton profil de shell…',
    added: 'Ajouté. Ouvre un nouveau terminal pour utiliser happier.',
    alreadyPresent: 'happier est déjà dans ton PATH.',
    removed: 'Les entrées PATH ajoutées par Happier Desktop ont été supprimées.',
    nothingToRemove: 'Happier Desktop n’a ajouté aucune entrée PATH.',
};

const cliPathExposureTranslations = { fr: fr };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const fr = {
    title: 'Approuver cette ligne de commande ?',
    body: ({ command }: { command: string }) => `Happier n’a pas installé la ligne de commande située à ${command}. L’approuver lui permet de lire et d’écrire les sessions de ce compte. N’approuvez que celle que vous y avez placée vous-même.`,
    bodyUnknownCommand: 'Happier n’a pas installé cette ligne de commande. L’approuver lui permet de lire et d’écrire les sessions de ce compte. N’approuvez que celle que vous y avez placée vous-même.',
    approve: 'Approuver',
};

const cliTrustPromptTranslations = { fr: fr };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "fr"> = { fr: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Un commit pour vos modifications en attente' : `${count} commits pour vos modifications en attente`),
        titlePhone: ({ count }) => (count === 1 ? 'Un commit' : `${count} commits`),
        proposedBy: ({ who, committed, total }) => `Proposé par ${who} · ${committed} fichiers sur ${total} · ordonnés pour que chaque commit s’appuie sur le précédent.`,
        proposedByPhone: ({ committed, total }) => `${committed} fichiers en attente sur ${total} · touchez une modification pour la déplacer.`,
        moveHint: ({ max }) => `Déplacez une modification avec ⌥1–${max} ou son menu.`,
        modelFallback: 'le modèle',
        regenerate: 'Régénérer',
        conflict: 'La proposition a changé ailleurs. Voici la plus récente ; refaites votre modification.',
        approvalPending: 'En attente d’approbation pour créer ces commits.',
        discardBody: 'La proposition est supprimée. Vos modifications en attente restent telles quelles.', askFix: ({ hook, number, message }) => `Le hook ${hook} a arrêté le commit ${number}, « ${message} ». Corrige ce qu’il signale pour que le commit passe :`, askFixGeneric: ({ number, message }) => `Un hook a arrêté le commit ${number}, « ${message} ». Corrige ce qu’il signale pour que le commit passe :`, discarded: 'Proposition abandonnée.', undo: 'Annuler',
        fileCount: ({ count }) => (count === 1 ? '1 fichier' : `${count} fichiers`),
        part: ({ count, of }) => `${count} sur ${of} modifications`,
        move: { a11y: ({ file }) => `Déplacer ${file} vers un autre commit`, title: ({ file }) => `Déplacer ${file} vers`, newCommitAfter: ({ number }) => `Nouveau commit après le ${number}`, newCommitMessage: ({ file }) => `Mettre à jour ${file}`, leaveOut: 'Laisser hors de ces commits', leaveOutHint: 'Reste dans votre arbre de travail' },
        group: { a11y: ({ number, message }) => `Commit ${number} : ${message}`, editMessage: 'Modifier le message', messageA11y: ({ number }) => `Message du commit ${number}`, more: 'Plus', moveUp: 'Monter', moveDown: 'Descendre', mergeWithNext: 'Fusionner avec le commit suivant', empty: 'Aucune modification pour l’instant. Déplacez-en une ici ou fusionnez-le avec le suivant.' },
        leftOut: { title: 'Laissé de côté · reste dans votre arbre de travail', description: 'Ces modifications restent en attente. Faites-en un commit séparé si c’était voulu.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `${count} commits`), onBranch: ({ branch }) => ` sur ${branch} · hooks et signature s’exécutent comme pour tout commit`, detached: ' sur un HEAD détaché · hooks et signature s’exécutent comme pour tout commit', phone: 'Hooks et signature comme d’habitude', discard: 'Abandonner la proposition', create: ({ count }) => (count === 1 ? 'Créer 1 commit' : `Créer ${count} commits`), createShort: ({ count }) => `Créer ${count}`, emptyGroupReason: 'Un commit n’a aucune modification. Déplacez-en une dedans ou fusionnez-le.' },
        applying: { title: ({ count }) => (count === 1 ? 'Création de 1 commit' : `Création de ${count} commits`), body: 'Un par un par le chemin de commit habituel : vos hooks et la signature s’exécutent comme d’habitude. La modification est suspendue jusqu’à la fin.', bodyPhone: 'La modification est suspendue jusqu’à la fin.', created: ({ landed, total }) => `${landed} sur ${total}`, createdRest: ' créés · rien n’est annulé si un suivant s’arrête', createdRestPhone: ' créés', stopAfterThis: 'Arrêter après ce commit', stopAfterThisShort: 'Arrêter après', stopping: 'Arrêt après ce commit' },
        state: { waiting: 'En attente', writing: 'Hooks en cours, création du commit', landed: 'commité', landedAt: ({ time }) => `commité à ${time}`, signed: 'signé', pausedBy: ({ hook, count }) => `${hook} a modifié ${count} fichier${count === 1 ? '' : 's'} · pas encore commité`, hookFailedBy: ({ hook }) => `${hook} a échoué · non commité`, rewritten: 'un hook a réécrit le message', notCreated: 'Non créé · toujours modifiable', notCreatedShort: 'Non créé', unknown: 'Pas encore confirmé', paused: ({ count }) => (count === 1 ? 'Un hook a modifié 1 fichier · pas encore commité' : `Un hook a modifié ${count} fichiers · pas encore commité`), failed: 'Arrêté ici · non commité' },
        outcome: { signingTitle: 'Vos commits ne peuvent pas être signés pour le moment.', signingBody: 'Ce dépôt signe chaque commit. Rien n’a été commité.', signingHint: 'Déverrouillez d’abord votre agent GPG ou SSH', tryAgain: 'Réessayer', cancel: 'Annuler', hookChanged: ({ files }) => `Le hook a modifié ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'Le commit 1 est passé ; celui-ci vous attend.' : `${count} commits sont passés ; celui-ci vous attend.`), waits: 'Celui-ci vous attend.', include: 'Inclure les modifications du hook', includePhone: 'Inclure et commiter', cancelCommit: 'Annuler ce commit', hookFailed: 'Un hook a arrêté ce commit.', hookChangedBy: ({ hook, files }) => `${hook} a modifié ${files}.`, hookFailedBy: ({ hook }) => `${hook} a arrêté ce commit.`, hookFailedBody: 'Les commits précédents restent. Le reste est toujours modifiable.', headMoved: ({ branch }) => `${branch} a bougé pendant les commits.`, headMovedBody: 'Le commit suivant a été refusé et rien n’a été annulé.', proposeAgain: 'Reproposer ce qui reste', keepEditing: 'Continuer à modifier', askSessionToFix: 'Demander à cette session de corriger', showInGit: 'Afficher dans Git', unknownTitle: 'Impossible de confirmer si ce commit est passé.', unknownBody: 'Rien n’est relancé tant qu’on ne sait pas. Revérifiez la branche.', checkAgain: 'Revérifier', stoppedTitle: ({ landed, total }) => `${landed} commits créés sur ${total}`, stoppedBody: ({ count }) => (count === 1 ? 'Le dernier n’a pas été créé. Ses modifications sont toujours dans votre arbre de travail, comme avant.' : `${count} n’ont pas été créés. Leurs modifications sont toujours dans votre arbre de travail, comme avant.`), createRest: ({ count }) => (count === 1 ? 'Créer le dernier' : `Créer les ${count} restants`), completeTitle: ({ count }) => (count === 1 ? '1 commit créé' : `${count} commits créés`), completeBody: 'Rien n’a été poussé.', onBranch: ({ branch }) => `sur ${branch}`, failed: { staging_conflict: 'Autre chose a changé ce qui est indexé.', selection_conflict: 'Ces modifications ne peuvent pas être séparées ainsi.', source_changed: 'Les modifications en attente ont changé depuis la proposition.', writer_failed: 'Le commit n’a pas pu être créé.', publication_warning: 'Le commit est passé, mais les fichiers indexés n’ont pas été mis à jour.', cancelled: 'Ce commit a été annulé.' }, failedBody: 'Les commits précédents restent. Rien n’a été annulé.' },
        none: { title: 'Pas encore de proposition de commits', workingTreeOnly: 'Les plans de commits ne peuvent être appliqués qu’aux modifications locales actuelles.', reason: 'Une proposition regroupe vos modifications en attente en commits modifiables, puis les crée un par un par le chemin de commit habituel.', propose: 'Proposer des commits', writing: 'Regroupement de vos modifications en attente…' },
        gitPane: { title: 'Commits proposés', meta: ({ count, files }) => `${count} · ${files} fichiers`, inCommit: ({ count, number }) => `${count} dans le commit ${number}`, open: 'Ouvrir', review: 'Relire', reviewInWalkthrough: 'Relire dans le parcours', more: 'Abandonner ou régénérer', selectedHint: 'Sélectionné. Touchez à nouveau pour l’ouvrir dans Commits', tapHint: 'Touchez pour voir ses modifications' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "fr": {
        "committedMessageActions": {
            "copy": "Copier",
            "fork": "Créer une branche",
            "rollback": "Revenir en arrière",
            "pin": "Épingler",
            "savePrompt": "Enregistrer comme prompt",
            "plugins": "Actions des plugins",
            "composerButton": "Bouton de la bibliothèque de prompts",
            "composerHint": "Vos prompts et ce que vous avez envoyé, à côté de la dictée. Le menu / propose toujours Prompts… s’il est désactivé.",
            "name": "Nom",
            "shortcut": "/ raccourci",
            "savedOpen": "Enregistré dans la bibliothèque · Ouvrir",
            "shortcutNotSaved": "Le prompt a été enregistré, mais pas son raccourci. Ouvrez-le dans la bibliothèque pour en ajouter un.",
            "wrongAccount": "Passez au Home de cette session avant d’enregistrer son prompt.",
            "savedHintFavorite": "Rejoint votre bibliothèque, avec une étoile.",
            "savedHint": "Rejoint votre bibliothèque.",
            "addShortcut": "Ajouter un raccourci /",
            "shortcutPlaceholder": "/raccourci",
            "savedToLibrary": "Enregistré dans la bibliothèque",
            "savePromptHint": "Réutilisez-le depuis la bibliothèque de prompts",
            "copyHint": "Copier le texte d’un message.",
            "forkHint": "Démarrer une nouvelle session à partir d’un message.",
            "rollbackHint": "Ramener l’espace de travail à son état avant un message.",
            "pinHint": "Épinglez des messages pour y revenir. Les messages épinglés le restent.",
            "savePromptSettingHint": "Garder un message envoyé comme prompt de la bibliothèque.",
            "pluginsHint": "Actions que vos plugins ajoutent sous les messages."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { fr: {
        approval: {
            sectionTitle: 'Sur l’ordinateur',
            act: {
                list: 'Voir quelles fenêtres sont ouvertes',
                see: 'Faire une capture d’écran',
                read: 'Lire le texte et les commandes',
                click: 'Cliquer',
                press: 'Appuyer sur une touche',
                type: 'Saisir du texte',
                share: 'Partager une fenêtre',
            },
            windowOn: ({ machine }) => `Une fenêtre sur ${machine}`,
            screenOf: ({ machine }) => `Tout l’écran de ${machine}`,
            windowsOn: ({ machine }) => `Les fenêtres ouvertes sur ${machine}`,
            window: 'Une fenêtre',
            screen: 'Tout l’écran',
            windows: 'Les fenêtres ouvertes',
            typedLabel: 'Texte',
            keyLabel: 'Touche',
            listConsequence: 'Seuls les noms des fenêtres ouvertes sont partagés, pas leur contenu.',
            seeConsequence: 'Les captures sont partagées avec cette session. Ni clic ni saisie.',
            useConsequence: 'Une saisie qui atteint la machine ne peut pas être annulée. Vous pouvez arrêter à tout moment.',
            targetOn: ({ machine, target }) => `${target} sur ${machine}`,
            chooseFirst: 'Choisissez d’abord la fenêtre',
            cropA11y: ({ target }) => `La dernière image de ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} suggère « ${target} »`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} veut utiliser une fenêtre sur ${machine}`,
            body: 'Vous choisissez la fenêtre. Rien n’est partagé avant.',
            choose: 'Choisir une fenêtre',
            change: 'Changer de fenêtre',
            shared: ({ target }) => `${target} partagée`,
            watch: 'Regarder',
        },
        picker: {
            title: ({ agent }) => `Laisser ${agent} utiliser une fenêtre`,
            description: ({ agent }) => `Vous choisissez ce que vous partagez avec ${agent}.`,
            windows: 'Fenêtres',
            screens: 'Écran entier',
            untitledWindow: 'Fenêtre sans titre',
            screenLabel: ({ index }) => `Écran ${index}`,
            share: 'Partager la fenêtre',
            shareScreen: 'Partager l’écran',
            shareApp: ({ app }) => `Partager la fenêtre ${app}`,
            stopSharing: 'Arrêter le partage',
            loadingTitle: ({ machine }) => `Recherche des fenêtres sur ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} n’a pas d’écran à partager`,
            noScreenBody: 'Elle fonctionne sans bureau visible par Happier. Utilisez une machine avec un écran.',
            unsupportedTitle: ({ machine }) => `Happier ne peut pas encore utiliser l’écran de ${machine}`,
            unsupportedBody: 'Pour l’instant, le partage de fenêtre fonctionne sur les bureaux Linux.',
            failedTitle: ({ machine }) => `Impossible de lister les fenêtres de ${machine}`,
            failedBody: 'Vérifiez que Happier y fonctionne, puis réessayez.',
            emptyTitle: ({ machine }) => `Aucune fenêtre ouverte sur ${machine}`,
            emptyBody: 'Ouvrez la fenêtre à partager, puis vérifiez à nouveau.',
            tryAgain: 'Réessayer',
            inUse: 'Une autre session utilise cette fenêtre. Choisissez-en une autre.',
            closed: 'Cette fenêtre a été fermée. Choisissez-en une autre.',
            selectFailed: 'Impossible de partager cette fenêtre. Réessayez.',
            otherMachineTitle: ({ machine }) => `${machine} n’est pas la machine de cette session`,
            otherMachineBody: 'Les fenêtres ne peuvent être partagées que sur la machine où tourne cette session.',
            purpose: ({ session }) => `Pour « ${session} ».`,
            purposeIn: ({ project, session }) => `Pour « ${session} » dans ${project}.`,
            access: ({ agent }) => `${agent} peut`,
            accessValue: 'La voir et l’utiliser',
            accessSee: 'Voir seulement',
            displayUnavailable: 'Le partage de l’écran entier n’est pas disponible sur cet ordinateur.',
            wholeDisplayBody: ({ display }) => `Tout ce qui est visible sur ${display} peut être vu, y compris les autres apps et les notifications.`,
            policyBoth: ({ agent }) => `${agent} demande avant chaque capture, clic et frappe.`,
            policyInput: ({ agent }) => `${agent} demande avant chaque clic et frappe.`,
            policyCapture: ({ agent }) => `${agent} demande avant chaque capture.`,
            policyNone: ({ agent }) => `${agent} ne demande pas avant les captures, clics ou frappes.`,
            policyChange: 'Modifier',
            suggests: ({ agent }) => `${agent} suggère`,
            usingIt: 'l’agent l’utilise',
            displayShared: 'tout ce qui s’y trouve est partagé',
            refresh: 'Actualiser les sources',
            footnote: 'Lister les fenêtres vous demande d’abord ; partager un écran entier redemande.',
            wholeDisplayTitle: 'Partager tout l’écran ?',
            allowSee: 'Autoriser l’affichage',
            allowUse: 'Autoriser la souris et le clavier',
            allowUseHint: ({ agent }) => `${agent} peut utiliser cet écran. Vous pouvez reprendre le contrôle à tout moment.`,
            shareDisplay: 'Partager l’écran',
        },
        permission: {
            input: 'Accessibilité',
            denied: 'Non autorisé',
            opened: ({ machine }) => `Ouvert sur ${machine}. Autorisez Happier là-bas, puis vérifiez à nouveau.`,
            openFailed: 'Impossible d’ouvrir les Réglages Système là-bas. Ouvrez-les sur cet ordinateur.',
            checkAgain: 'Vérifier à nouveau',
            captureTitle: ({ machine }) => `Autorisez l’enregistrement de l’écran sur ${machine} pour regarder ses fenêtres ou son écran.`,
            inputTitle: ({ machine }) => `Autorisez l’accessibilité sur ${machine} pour utiliser sa souris et son clavier.`,
            unknownTitle: ({ machine }) => `Impossible de vérifier les autorisations d’écran sur ${machine}. Vérifiez à nouveau avant de partager.`,
            separateBody: ({ machine }) => `L’accessibilité est distincte : elle vous permet d’y utiliser la souris et le clavier. Chacune s’accorde sur ${machine}, pas sur cet appareil.`,
            onMachineBody: ({ machine }) => `Elle s’accorde sur ${machine}, pas sur cet appareil.`,
            openPrivacy: ({ machine }) => `Ouvrir les réglages de confidentialité sur ${machine}`,
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} utilise ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} peut utiliser ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} peut voir ${target}`,
            onMachine: ({ machine }) => `Sur ${machine}`,
            connectingTitle: ({ target }) => `Connexion à ${target}`,
            unavailableTitle: 'Impossible d’afficher cette fenêtre pour le moment',
            unavailableBody: ({ agent }) => `Vous pouvez toujours arrêter ${agent} ici.`,
            endedTitle: ({ target }) => `${target} a été fermée`,
            endedBody: ({ agent }) => `${agent} ne peut plus la voir ni l’utiliser. Choisissez une autre fenêtre pour continuer.`,
            stalled: 'Dernière image affichée · reconnexion',
            inputA11y: ({ target }) => `${target}, en direct. Cliquez ou saisissez pour prendre la main.`,
            notSharedTitle: 'Aucune fenêtre partagée',
            notSharedBody: ({ agent }) => `Choisissez une fenêtre que ${agent} pourra utiliser.`,
            moreA11y: 'Options de la fenêtre',
            tabFallback: 'Ordinateur',
            sourceComputer: 'Ordinateur',
            sourceBrowser: 'Navigateur',
            sourceA11y: 'Source',
            watchingA11y: ({ source, machine }) => `Vous regardez ${source} sur ${machine}`,
            expandView: 'Agrandir la vue',
            restoreView: 'Restaurer la vue',
            dockView: 'Ancrer la vue',
            closeView: 'Fermer la vue',
            moveView: 'Déplacer la vue',
            resizeView: 'Redimensionner la vue',
            moveTopLeft: 'Déplacer en haut à gauche',
            moveTopRight: 'Déplacer en haut à droite',
            moveBottomLeft: 'Déplacer en bas à gauche',
            moveBottomRight: 'Déplacer en bas à droite',
            larger: 'Plus grande',
            smaller: 'Plus petite',
            viewOptions: 'Options de la vue',
            presentedElsewhereTitle: 'Affichée dans la vue flottante',
            presentedElsewhereBody: 'Ancrez-la ici pour la garder à côté de votre travail.',
            closeHint: 'Ferme cette vue. La session continue.',
            agentWorkingOn: ({ agent, machine }) => `${agent} travaille sur ${machine}`,
            watchingSourceA11y: ({ source }) => `Vous regardez ${source}`,
            controlNotAllowed: 'Le contrôle de la souris et du clavier n’est pas autorisé',
            paused: ({ time }) => `Flux en pause · dernière image ${time}`,
            offlineTitle: ({ machine }) => `${machine} ne répond pas`,
            offlineBody: 'Reconnectez-la pour la regarder. Regarder ne la démarre pas.',
            openingTitle: ({ target, machine }) => `Ouverture de ${target} sur ${machine}…`,
        },
        strip: {
            using: ({ target }) => `Utilise ${target}`,
            on: ({ machine }) => `sur ${machine}`,
            stop: 'Arrêter',
            paused: ({ agent }) => `${agent} est en pause`,
            pausedDetail: ({ target }) => `Vous avez la main sur ${target}`,
        },
        tool: {
            capture: 'A pris une capture',
            captureRunning: 'Prend une capture',
            query: 'A lu le texte et les commandes de la fenêtre',
            queryRunning: 'Lit la fenêtre',
            click: 'A cliqué dans la fenêtre',
            clickRunning: 'Clique dans la fenêtre',
            clickTarget: ({ target }) => `A cliqué sur « ${target} »`,
            type: 'A saisi dans la fenêtre',
            typeRunning: 'Saisit dans la fenêtre',
            typeTarget: ({ target }) => `A saisi dans « ${target} »`,
            pressKey: ({ key }) => `A appuyé sur ${key}`,
            press: 'A appuyé sur une touche',
            pressRunning: 'Appuie sur une touche',
            mayHaveLanded: 'a peut-être abouti',
            failed: 'N’a pas abouti',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "fr">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const fr: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Compte ${service}`,
    accountLabelNumbered: ({ service, number }) => `Compte ${service} ${number}`,
    meterResetsIn: ({ time }) => `dans ${time}`,
    meterNextResetIn: ({ time }) => `prochain dans ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Non communiqué',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Tous les services',
    indexDescription: 'Les comptes avec lesquels vos agents se connectent, et ce qu’il reste à chacun.',
    viewList: 'Liste',
    viewGrid: 'Grille',
    viewLabel: 'Afficher les comptes en',
    refreshAll: 'Tout actualiser',
    refreshUsage: 'Actualiser l’utilisation',
    signedOutConsequence: 'Les sessions ne peuvent pas l’utiliser tant que vous ne vous reconnectez pas.',
    poolsGroup: 'Pools',
    poolsDescription: 'Des comptes entre lesquels un agent alterne. Le pool en choisit un au début d’une session et passe au suivant quand il est épuisé.',
    newPool: 'Nouveau pool',
    poolUsing: ({ account }) => `Utilise ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Premier sur ${count}` : `${position} sur ${count}`,
    poolInUseNow: 'utilisé en ce moment',
    inUse: 'Utilisé',
    connectService: 'Connecter un service',
    searchAccounts: 'Rechercher des comptes',
    servicesGroup: 'Services',
    railEmpty: 'Aucun compte pour l’instant',
    railKey: 'clé',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Comment les agents se connectent',
    subscriptionTitle: 'Abonnement',
    subscriptionNone: 'Pas d’abonnement',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Renouvelé aujourd’hui' : days === 1 ? 'Renouvelé demain' : `Renouvelé dans ${days} jours`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Non renouvelé · se termine aujourd’hui' : `Non renouvelé · se termine dans ${days} jours`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'La période se termine aujourd’hui' : `La période se termine dans ${days} jours`,
    subscriptionRenewsOn: ({ date, days }) => `Renouvelé le ${date} · dans ${days} jours`,
    subscriptionEndsOn: ({ date, days }) => `Non renouvelé · se termine le ${date}, dans ${days} jours. Les sessions cesseront alors de l’utiliser.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `La période se termine le ${date} · dans ${days} jours`,
    renewalOn: 'Activé',
    renewalOff: 'Désactivé',
    renewalUnknown: 'Inconnu',
    checkedAt: ({ time }) => `Vérifié ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Vérifié ${time} · peut-être obsolète`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Vérifié ${time} · peut-être obsolète`,
    daysAgo: ({ count }) => count === 1 ? 'il y a 1 jour' : `il y a ${count} jours`,
    hoursAgo: ({ count }) => count === 1 ? 'il y a 1 heure' : `il y a ${count} heures`,
    usageResetsCount: ({ count }) => count === 1 ? '1 réinitialisation' : `${count} réinitialisations`,
    usageResetsFirstExpires: ({ date }) => `la première expire ${date}`,
    usageResetExpires: ({ date }) => `expire ${date}`,
    useOne: 'En utiliser une',
    useOneReset: 'Utiliser une réinitialisation',
    usageResetsTitle: 'Réinitialisations',
    usageResetsDescription: 'Chacune démarre aussitôt une nouvelle fenêtre. Gardez-les pour quand une limite vous bloque ; celles non utilisées expirent.',
    usageResetTitle: 'Réinitialisation',
    usageResetExpiresOn: ({ date }) => `Expire le ${date}`,
    use: 'Utiliser',
    usedByDefault: 'Par défaut · les nouvelles sessions utilisent ce compte',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Masquer les e-mails et identifiants des comptes',
    hideIdentitiesDescription: 'Pour le streaming et les démos. Masque les e-mails et identifiants partout sur cet appareil ; les noms donnés aux comptes restent.',
    privacyTitle: 'Confidentialité',
    renameTitle: 'Nommer ce compte',
    renameBody: ({ service }) => `Seul le nom dans Happier change. ${service} garde son propre nom pour le compte.`,
    identityHidden: 'E-mail ou identifiant masqué',
};

const connectedServicesCollectionTranslations = { fr };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const fr: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Expire bientôt",
    strategyExpiryFirstDescription: "Privilégier un quota suffisant dont la période longue se réinitialise ou dont l’abonnement sans renouvellement se termine plus tôt.",
    leadExpiryFirst: "Expiration la plus proche d’abord.",
    membersOn: ({ service, on, total }) => `${service} · ${on} membres actifs sur ${total}`,
    rename: 'Renommer',
    moreActions: "Plus d'actions",
    defaultFor: ({ agent }) => `Par défaut pour ${agent}`,
    defaultForMore: ({ agent, count }) => `Par défaut pour ${agent} +${count}`,
    makeDefault: 'Définir par défaut',
    makeDefaultA11y: 'Définir par défaut pour un agent',
    usingSince: ({ name, time }) => `${name} utilisé depuis ${time}`,
    using: ({ name }) => `${name} utilisé`,
    noActive: "Aucun membre n'est encore utilisé",
    noActiveDetail: 'Le groupe en choisit un au démarrage d’une session.',
    leadLeastLimited: "Le moins limité d'abord.",
    leadInOrder: 'Dans l’ordre.',
    fallbackOff: ({ name }) => `Le basculement automatique est désactivé : les sessions restent sur ${name} quand il est épuisé.`,
    manualStays: ({ name }) => `Manuel : le groupe reste sur ${name} jusqu’à ce que vous choisissiez un autre membre.`,
    switchTo: ({ name }) => `Passer à ${name}`,
    onlyOneOn: ({ name }) => `Seul ${name} est actif, il n’y a donc pas de relais.`,
    turnOn: ({ name }) => `Activer ${name}`,
    allWaitingTitle: 'Tous les membres attendent une réinitialisation',
    allWaitingFirst: ({ name, time, countdown }) => `${name} se réinitialise en premier, à ${time} (${countdown}).`,
    sessionsWait: 'Les sessions attendent, puis reprennent d’elles-mêmes.',
    sessionsStop: 'Les sessions s’arrêtent jusqu’à ce qu’un membre ait de la marge.',
    leftTitle: 'Restant dans le groupe',
    leftDescription: 'La moyenne des membres actifs ; chacun se réinitialise de son côté.',
    roomCount: ({ count, total }) => `${count} sur ${total} ont de la marge maintenant`,
    notReported: ({ count }) => count === 1 ? '1 sans données' : `${count} sans données`,
    nothingReported: 'Aucun membre actif ne signale encore ses limites.',
    membersTitle: 'Membres',
    membersDescription: 'Faites glisser pour définir l’ordre. Le membre sélectionné est l’actif ; un membre désactivé est ignoré.',
    membersCompactDescription: 'Maintenez et faites glisser pour réordonner.',
    manage: 'Gérer',
    connectAnotherAccount: ({ service }) => `Connecter un autre compte ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} sur ${total} comptes ${service}`,
    manageMembers: 'Gérer les membres',
    searchAccounts: ({ service }) => `Rechercher des comptes ${service}`,
    active: 'Actif',
    offNotUsed: 'Non utilisé par le groupe tant qu’il est désactivé',
    autoOffModel: 'Désactivé automatiquement · ce forfait ne peut pas utiliser le modèle choisi',
    checkedAt: ({ time }) => `Vérifié ${time}`,
    makeActiveA11y: ({ name }) => `Faire de ${name} le membre actif`,
    memberOnA11y: ({ name }) => `Utiliser ${name} dans ce groupe`,
    openA11y: ({ name }) => `Ouvrir ${name}`,
    dragA11y: 'Faire glisser pour réordonner',
    behaviorTitle: 'Comportement',
    strategyTitle: 'Stratégie de sélection',
    strategyLeastLimited: 'Le moins limité',
    strategyInOrder: 'Dans l’ordre',
    strategyManual: 'Manuel',
    strategyLeastLimitedDescription: 'Préférer le membre avec le plus de quota utilisable.',
    strategyInOrderDescription: 'Essayer les membres dans l’ordre ci-dessus.',
    strategyManualDescription: 'Utiliser seulement le membre actif jusqu’à ce que vous le changiez.',
    fallbackTitle: 'Basculement automatique',
    fallbackDescription: 'Passer à un autre membre quand le compte actif doit être rétabli.',
    switchEarlyTitle: 'Basculer plus tôt',
    switchEarlyDescription: 'Pourcentage restant sous lequel le groupe passe à un membre au quota plus frais. 0 le désactive.',
    autoResetsTitle: 'Utiliser automatiquement les réinitialisations de quota',
    autoResetsDescription: 'Dépenser une réinitialisation en réserve seulement quand aucun membre n’est prêt.',
    autoOffTitle: 'Désactiver les comptes qui ne peuvent pas utiliser le modèle choisi',
    autoOffDescription: 'Vous pouvez les réactiver vous-même.',
    advancedTitle: 'Avancé',
    advancedCount: ({ count }) => `${count} réglages`,
    restoreFirstTitle: 'Revenir au premier membre quand il se réinitialise',
    restoreFirstDescription: 'Après un basculement, revenir au membre placé en premier une fois sa limite réinitialisée.',
    switchWhenTitle: 'Basculer quand',
    switchWhenDescription: 'Événements qui font passer le groupe au membre suivant.',
    staleAfterTitle: 'Vérifier une utilisation ancienne après',
    staleAfterDescription: 'Minutes. Redemander au fournisseur quand l’utilisation est plus ancienne avant de choisir un membre.',
    switchesPerTurnTitle: 'Basculements automatiques par tour',
    switchesPerHourTitle: 'Basculements automatiques par heure de session',
    switchLimitsDescription: 'Empêche un groupe de passer sans cesse d’un membre à l’autre.',
    recoveryTitle: 'Quand une limite arrête une session',
    recoveryDescription: 'Ce que fait le groupe pour la session en attente.',
    recoveryPromptsTitle: 'Messages de reprise',
    recoveryPromptsDescription: 'Happier envoie son message standard quand il reprend une session après un basculement ou une réinitialisation.',
    usedByTitle: 'Utilisé par',
    usedByDefault: 'Par défaut · les nouvelles sessions se connectent via ce groupe',
    usedByNone: 'Aucun agent ne se connecte encore via ce groupe par défaut.',
    deleteNote: ({ agents }) => `Les membres restent connectés. ${agents} revient à sa propre connexion jusqu’à ce que vous choisissiez un autre défaut.`,
    deleteNoteNoAgent: 'Les membres restent connectés.',
    emptyTitle: 'Ajoutez les comptes entre lesquels basculer',
    emptyReason: ({ service }) => `Un groupe choisit un compte au démarrage d’une session et bascule quand il est épuisé. Ajoutez au moins deux comptes ${service}.`,
    usageNotAnswering: ({ service }) => `${service} n’a pas répondu`,
    newPoolTitle: 'Nouveau groupe',
    newPoolDescription: ({ service }) => `Comptes ${service} entre lesquels un agent bascule.`,
    nameTitle: 'Nom',
    namePlaceholder: 'Groupe travail',
    draftMembersDescription: 'Choisissez les comptes entre lesquels basculer. Vous pourrez les changer plus tard.',
    create: 'Créer le groupe',
    discard: 'Abandonner',
};

const connectedServicesPoolTranslations = { fr };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const fr: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 compte' : `${count} comptes`,
    defaultAccount: ({ name }) => `Par défaut : ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 pool' : `${count} pools`,
    noAccountsYet: 'Aucun compte pour l’instant',
    needsSignIn: 'Connexion requise',
    signInAgain: 'Se reconnecter',
    addAccount: 'Ajouter un compte',
    connectAnotherTitle: 'Connecter un autre service',
    connectFirstTitle: 'Connecter un service',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} et ${count} de plus.`,
    connect: 'Connecter',
    emptyTitle: 'Aucun service à connecter pour l’instant',
    servicesTitle: 'Services',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Aucun agent sur ${machine} ne propose encore de service avec lequel te connecter. Les agents qui utilisent un abonnement ajoutent le leur ici.`,
    emptyNoMachineOnline: 'Aucune de tes machines n’est en ligne. Les services apparaissent quand l’une l’est, depuis les agents qu’elle exécute.',
    emptyOpenAgents: 'Ouvrir les agents',
    emptyAction: 'Ouvrir les machines',
    projectionErrorTitle: 'Impossible de charger les services de tes machines',
    projectionErrorDescription: 'Tes comptes restent affichés. Les services que tu peux ajouter apparaissent dès qu’une machine répond.',
    loadingServices: 'Recherche des services sur tes machines…',
    usageTitle: 'Utilisation des comptes',
    usageDescription: 'Le compte avec lequel chaque agent se connecte au début d’une session, et ce que les sessions partagent.',
    sharingTitle: 'Partage de l’état',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Liée',
    configCopiedShort: 'Copiée',
    configIsolatedShort: 'Isolée',
    stateSharedShort: 'Sessions partagées',
    stateIsolatedShort: 'Sessions séparées',
    perAgentTitle: 'Partage par agent',
    perAgentDescription: 'Remplace ces valeurs pour un agent.',
    perAgentPurpose: 'Choisis, pour chaque agent, ce que les sessions des comptes connectés partagent avec ta propre connexion.',
    servicePurpose: ({ service }) => `Les comptes avec lesquels tu te connectes à ${service}, et les pools qui les partagent.`,
    chooseMachineTitle: 'Choisis une machine',
    chooseMachineDescription: 'L’ajout, la connexion et la suppression de comptes se font sur l’une de tes machines. Tes comptes restent listés dans Services connectés.',
    newAccountTitle: 'Nouveau compte',
    newAccountDescription: 'Choisis comment te connecter.',
    newAccountInProgress: 'Termine la connexion ci-dessous.',
    modeBrowser: 'Se connecter avec un navigateur',
    modeDeviceCode: 'Se connecter avec un code',
    modeManual: 'Saisir un token',
    serviceSettingsTitle: 'Réglages du service',
    serviceSettingsDescription: 'Réglages avec lesquels chaque compte de ce service se connecte.',
    noAccountsDescription: 'Ajoute un compte pour que tes agents puissent s’y connecter.',
    accountDetailsTitle: 'Détails du compte',
    poolEmptyTitle: 'Ajoute des comptes à ce pool',
    poolEmptyDescription: 'Un pool fait passer les sessions au compte suivant quand l’un atteint sa limite. Choisis ses comptes ci-dessous.',
    agentDefaultsTitle: 'Compte par défaut de chaque agent',
    agentDefaultsDescription: 'Le compte avec lequel chaque agent se connecte au début d’une session.',
    agentDefaultsKeywords: 'compte par défaut',
    namesAnd: ({ names, last }) => `${names} et ${last}`,
    usedBy: ({ names }) => `Utilisé par ${names}`,
    poolRuleMostLeft: 'utilise celui qui en a le plus',
    poolRuleInOrder: 'les utilise dans l’ordre',
    poolRuleManual: 'vous changez vous-même',
    poolInUse: ({ pool }) => `${pool} · utilisé`,
    agentDefault: ({ agent }) => `Par défaut pour ${agent}`,
    signedOutBy: ({ service }) => `Déconnecté par ${service}`,
    usageReadFailed: 'Utilisation illisible',
    usageWindowPin: ({ meter }: { meter: string }) => `Afficher ${meter} à côté du composer`,
    noLimitsBilledPerUse: 'Aucune limite signalée · facturé à l’usage',
    needsYouCount: ({ count }) => count === 1 ? '1 a besoin de vous' : `${count} ont besoin de vous`,
    connectToolsTitle: 'Connecter un hébergeur de code ou un outil',
    inviteTitle: ({ names }) => `Vos agents peuvent aussi utiliser ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} peut s’y connecter.`,
    inviteWhoMany: ({ agents }) => `${agents} peuvent s’y connecter.`,
    inviteTools: 'Ou connectez un hébergeur de code et des outils.',
    firstRunTitle: 'Utilisez les abonnements que vous payez déjà',
    firstRunPromise: 'Connectez votre compte Claude ou ChatGPT une seule fois. Vos agents l’utilisent sur chaque machine, et Happier indique ce qu’il reste avant d’atteindre une limite.',
    connectAnAccount: 'Connecter un compte',
    firstRunMeanwhile: 'En attendant, chaque agent utilise sa propre connexion sur chaque machine.',
    agentAccountsTitle: 'Comptes des agents',
    agentAccountsDescription: 'Abonnements et clés utilisés par vos agents. Enregistrés dans votre compte, pour que chaque machine puisse les utiliser.',
    codeAndToolsTitle: 'Code et outils',
    setupChooseMachine: 'Choisissez une machine pour vous connecter. Le compte fonctionne ensuite sur toutes vos machines.',
    setupHowToSignIn: 'Comment se connecter',
    setupRecommendedMethod: ({ method }) => `${method} · Recommandé`,
    setupCatalogTitle: 'Connecter un service',
    setupCatalogPurpose: 'La connexion se fait sur la machine choisie. Le compte fonctionne ensuite sur toutes vos machines.',
    setupServiceTitle: ({ service }) => `Connecter ${service}`,
    setupReconnectTitle: ({ service }) => `Se reconnecter à ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} utiliseront votre compte ${service} sur chaque machine.`,
    setupServicePurposeNoAgents: 'Le compte fonctionne sur chaque machine.',
    setupForYourAgents: 'Pour vos agents',
    setupOwnLoginTitle: 'Déjà connecté sur une machine ?',
    setupOwnLoginBody: 'Continuez d’utiliser la connexion propre à l’agent. Choisissez-la dans Utilisation des comptes.',
    setupToolsTitle: 'Hébergeurs de code et outils',
    setupProvidersPointer: 'Les fournisseurs de modèles comme OpenRouter et Ollama se configurent dans Fournisseurs.',
    setupOpenProviders: 'Ouvrir Fournisseurs',
    setupTrust: 'Enregistré dans votre compte et utilisé uniquement par vos machines. Happier garde la connexion à jour pour vous.',
    setupConnectedCount: ({ count }) => `${count} connectés`,
    settleConnectedAs: ({ identity }) => `Connecté à l’instant en tant que ${identity}.`,
    settleConnected: 'Connecté à l’instant.',
    settleUseFor: ({ agent }) => `L’utiliser pour ${agent} ?`,
    settleUseForAction: ({ agent }) => `Utiliser pour ${agent}`,
    notNow: 'Pas maintenant',
    homeInvitePromise: 'Connectez Claude ou ChatGPT une seule fois. Chaque machine peut l’utiliser, et vous verrez ici ce qu’il reste.',
    homeInviteHide: 'Masquer',
    homeNextWho: ({ agents }) => `${agents} peut aussi l’utiliser`,
    oauthStepOpen: 'Ouvrez la page de connexion dans votre navigateur',
    oauthStepApprove: 'Approuvez, puis copiez le code affiché (ou l’adresse de la page d’arrivée)',
    oauthStepPaste: 'Collez-le ici',
    oauthPastePlaceholder: 'Collez le code ou l’adresse',
    oauthShapeOk: 'Ressemble à un code de connexion',
    deviceEnterAt: ({ where }) => `Saisissez ce code sur ${where}`,
    deviceExpired: 'Le code a expiré. Rien n’a été enregistré.',
    deviceExpiresIn: ({ time }) => `Le code expire dans ${time}`,
    deviceNewCode: 'Obtenir un nouveau code',
    detailSignedOutTitle: ({ service }) => `${service} a déconnecté ce compte`,
    detailSignedOutBody: 'La connexion a été révoquée ou modifiée, par exemple après un changement de mot de passe. Les sessions ne peuvent plus utiliser ce compte avant une nouvelle connexion.',
    detailSignInTitle: 'Connexion',
    detailSignInNeeded: 'Nouvelle connexion requise',
    detailSignInKeptFresh: 'Happier la garde à jour',
    detailLastUsed: ({ time }) => `dernière utilisation ${time}`,
    detailLeavePool: ({ pool }) => `Retirer de ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} utilise ce compte ; retirez-le d’abord du groupe. Le supprimer l’efface de votre compte et de chaque machine.`,
    detailUsageSignedOut: 'Dernière valeur connue · actualisation impossible sans connexion',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Dernière valeur connue à ${time} · actualisation impossible sans connexion`,
    detailResetsIn: ({ countdown }) => `dans ${countdown}`,
    detailUsedByTitle: 'Utilisé par',
    detailUsedByDefault: 'Son compte par défaut',
    detailUsedByPool: ({ pool }) => `Via ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Via ${pool} · utilisé en ce moment`,
    detailUsedByCould: 'Peuvent l’utiliser · se connectent autrement pour l’instant',
    detailWorksOnTitle: 'Fonctionne sur',
    detailWorksOnDescription: 'Enregistré dans votre compte. Une machine l’utilise quand une session y démarre ; rien n’est copié à l’avance.',
    detailSignedInWithCode: 'Connecté avec un code',
    detailSignedInWithBrowser: 'Connecté avec un navigateur',
    detailAddedWithKey: 'Ajouté avec une clé',
    nearLimitTitle: ({ account, percent, window }) => `Il reste ${percent} % de la limite ${window} à ${account}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Il reste ${percent} % de la limite ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Réinitialisation à ${time}. Appliquez une réinitialisation d’utilisation pour continuer maintenant.`,
    nearLimitBody: 'Appliquez une réinitialisation d’utilisation pour continuer maintenant.',
    nearLimitApplyReset: 'Appliquer une réinitialisation',
    catalogSignInBrowserOrCode: 'Connexion par navigateur ou par code',
    catalogSignInBrowserOrKey: 'Connexion par navigateur ou jeton collé',
    catalogSignInBrowser: 'Connexion par navigateur',
    catalogSignInCode: 'Connexion par code',
    catalogPasteKey: 'Collez une clé',
    deviceOpenService: ({ service }) => `Ouvrir ${service}`,
    deviceWaitingFor: ({ service }) => `En attente de votre approbation dans ${service}…`,
};

const connectedServicesSettingsTranslations = { fr };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { fr: {
        connectMoreTitle: 'Connecter davantage',
        connectMoreDescription: 'Services acceptés par les agents de vos machines que vous n’avez pas encore connectés.',
        connectMoreNothingNew: 'Ajoutez un autre compte, un hébergeur de code ou un outil.',
        serviceSignInInstead: ({ agents }) => `${agents} peut s’y connecter au lieu de la connexion propre à chaque machine.`,
        serviceCanUse: ({ agents }) => `${agents} peut l’utiliser.`,
        moreServicesTitle: 'Plus de services',
        moreServicesTools: ({ names }) => `${names} et d’autres, pour le code et les outils.`,
        moreServicesAll: 'Tout ce qu’acceptent vos agents et vos outils.',
        browse: 'Parcourir',
        notNow: ({ service }) => `Pas maintenant : ${service}`,
        notNowTooltip: 'Pas maintenant · reste dans Parcourir',
        back: 'Tous les services',
        homeCatalogTitle: 'Connecter un compte',
        homeCatalogPurpose: 'Vos agents l’utilisent sur toutes les machines, et Home affiche ce qu’il reste.',
        homeNextSubtitle: ({ agents }) => `${agents} peut l’utiliser au lieu de la connexion propre à chaque machine.`,
        firstRunMore: 'Clés d’API, hébergeurs de code et outils',
        settleAddToPoolWhy: ({ pool, agent, active }) => `L’ajouter à ${pool}, pour que ${agent} passe dessus quand ${active} est épuisé ?`,
        settleAddToPoolShort: ({ pool }) => `L’ajouter à ${pool} ?`,
        settleAddToPool: ({ pool }) => `Ajouter à ${pool}`,
        deviceStepCopy: 'Copiez ce code',
        deviceStepOpen: ({ service }) => `Ouvrez ${service} et saisissez-le`,
        deviceStepOpenWhere: ({ where }) => `${where}, connecté au compte que vous voulez utiliser`,
        deviceStepApprove: ({ service }) => `Autorisez Happier dans ${service}`,
        deviceCheckNow: 'Vérifier maintenant',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "fr">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { fr: {
        approval: {
            requestTitle: 'Demande',
            requestDescription: 'Ce qui a été demandé et où en est la demande.',
            failureTitle: 'Raison de l’échec',
            homeUnavailableTitle: 'Home indisponible',
            contextTitle: 'Demandé par',
            contextDescription: 'La session et l’agent à l’origine de la demande.',
            sessionOnHome: ({ home }) => `Une session sur ${home}`,
            sessionElsewhere: 'Une session absente de cet appareil',
            origin: {
                voice: 'Demandé à la voix',
                agent: 'Demandé par un agent',
                mcp: 'Demandé via un outil connecté',
                cli: 'Demandé depuis la ligne de commande',
                ui: 'Demandé dans l’application',
                api: 'Demandé via l’API',
                plugin: 'Demandé par un plugin',
                system: 'Demandé par Happier',
            },
            proposalsDescription: 'Publiés dans la revue si vous approuvez.',
        },
        runs: {
            description: 'Exécutions en arrière-plan sur vos machines.',
            filterLabel: 'Exécutions affichées',
            filterRunning: 'En cours',
            filterAll: 'Toutes',
            onHome: ({ home }) => `Sur ${home}`,
        },
        person: {
            placeholderTitle: 'Personne',
            friendshipTitle: 'Amitié',
            sharedSessionsDescription: 'Sessions que cet ami partage avec vous, en lecture seule.',
            linkedAccountsTitle: 'Comptes associés',
            linkedAccountsDescription: 'Où cette personne se connecte aussi. S’ouvre dans votre navigateur.',
        },
        friendsManage: {
            description: 'Les personnes avec qui vous travaillez sur Happier, et vos demandes mutuelles.',
            requestsTitle: 'Demandes d’ami',
            requestsDescription: 'Ouvrez une demande pour l’accepter ou la refuser.',
            sentTitle: 'Demandes envoyées',
            sentDescription: 'En attente de leur acceptation.',
            friendsTitle: 'Amis',
            friendsDescription: 'Ouvrez un ami pour voir ce qu’il partage avec vous.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "fr">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { fr: {
        closeUnsavedTabA11y: 'Fermer l’onglet, modifications non enregistrées',
        emptyTitle: 'Les fichiers, modifications et commits s’ouvrent ici',
        browseFiles: 'Parcourir les fichiers',
        previewHint: 'Un clic ouvre un aperçu ; ouvrez-le à nouveau pour le garder.',
        emptyReason: 'Les fichiers, modifications et commits que vous ouvrez apparaissent ici, à côté de l’endroit d’où vous les avez ouverts.',
        reviewChanges: ({ count }) => (count === 1 ? 'Relire 1 modification' : `Relire ${count} modifications`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 fichier a changé dans cette session. Lisez-le ici sans quitter la conversation.'
            : `${count} fichiers ont changé dans cette session. Lisez-les ici sans quitter la conversation.`),
        splitNeedsWiderPane: 'La vue côte à côte demande un panneau plus large. Élargissez Détails ou utilisez Focus.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "fr">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { fr: {
        areaUnstaged: 'Non indexé',
        areaStaged: 'Indexé',
        areaBoth: 'Les deux',
        areaLabel: 'Modifications',
        preview: 'Aperçu',
        viewLabel: 'Affichage',
        compare: 'Comparer',
        stage: 'Indexer',
        unstage: 'Désindexer',
        addToCommit: 'Ajouter au commit',
        removeFromCommit: 'Retirer du commit',
        editing: 'Modification en cours',
        editingUnsaved: 'Modification en cours · non enregistrée',
        statusModified: 'Modifié',
        statusAdded: 'Ajouté',
        statusDeleted: 'Supprimé',
        statusRenamed: 'Renommé',
        statusCopied: 'Copié',
        statusUntracked: 'Nouveau, pas encore suivi',
        statusConflicted: 'A des conflits',
        noChanges: 'Aucune modification',
        lines: ({ count }) => (count === 1 ? '1 ligne' : `${count} lignes`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "fr">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { fr: {
        copyCommitSha: 'Copier le SHA du commit',
        filesChanged: ({ count }) => (count === 1 ? '1 fichier modifié' : `${count} fichiers modifiés`),
        files: ({ count }) => (count === 1 ? '1 fichier' : `${count} fichiers`),
        revertEllipsis: 'Annuler le commit…',
        stashKeptOn: ({ branch }) => `Mis de côté sur ${branch}`,
        stashOriginBranch: ({ branch }) => `Enregistré quand vous avez quitté ${branch}`,
        stashOriginBranchShort: 'Au changement de branche',
        stashOriginTransient: 'Enregistré par Happier',
        stashOriginUnmanaged: 'Créé hors de Happier',
        stashRestoreExplains: ({ folder }) => `Restaurer remet ces modifications dans ${folder} et supprime le stash. Rien d’autre ne change dans le dossier.`,
        stashApply: 'Appliquer',
        stashApplyA11y: 'Appliquer ces modifications et garder le stash',
        stashDiscardEllipsis: 'Supprimer…',
        stashSwitcherA11y: 'Choisir un stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "fr">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { fr: {
        title: 'Relecture',
        files: ({ count }) => (count === 1 ? `1 fichier` : `${count} fichiers`),
        nextCommit: ({ count }) => `${count} dans le prochain commit`,
        changedFiles: 'Fichiers modifiés',
        commitColumn: 'Commit',
        jumpA11y: 'Aller à un fichier',
        comments: ({ count }) => (count === 1 ? `1 commentaire` : `${count} commentaires`),
        goesWithNext: ({ count }) => (count === 1 ? `part avec votre prochain message` : `partent avec votre prochain message`),
        askForChanges: 'Demander des modifications',
        detachCommentA11y: 'Retirer ce commentaire du prochain message',
        trayExpandedHint: 'Ils partent avec votre prochain message à l’agent.',
        askPlaceholder: 'Dites à l’agent quoi modifier…',
        send: 'Envoyer',
        draftAuthor: 'Vous', draftStatus: 'brouillon', includeComment: 'Part avec votre prochain message',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "fr">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { fr: translated({
        settingsEmbeds: {
            title: "Intégrations",
            newTitle: "Nouvelle intégration",
            purpose: "Laissez d’autres apps afficher des discussions Happier, avec seulement l’accès que vous choisissez.",
            yourEmbeds: "Vos intégrations",
            newEmbed: "Nouvelle intégration",
            listError: "Impossible de charger les intégrations",
            emptyTitle: "Placez une discussion Happier dans votre propre app",
            emptyBody: "Votre app affiche de vraies conversations, avec seulement l’accès que vous choisissez : quels sites, qui peut envoyer ou approuver, et quels modèles.",
            createDescription: "Choisissez ce que d’autres apps peuvent faire de vos discussions et leur apparence.",
            name: "Nom",
            nameDescription: "Visible uniquement par vous, dans cette liste.",
            namePlaceholder: "Par exemple, tableau des prospects",
            create: "Créer l’intégration",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 site' : `${count} sites`,
                send: "Peut envoyer",
                sendAndApprove: "Peut envoyer et approuver",
                approve: "Peut approuver",
                viewOnly: "Lecture seule",
                modelOnly: ({ name }: { name: string }) => `${name} uniquement`,
                models: ({ count }: { count: number }) => count === 1 ? '1 modèle' : `${count} modèles`,
            },
            sites: {
                title: "Où elle peut apparaître",
                description: "Les discussions ne s’ouvrent que sur ces sites.",
            },
            capabilities: {
                title: "Ce que les gens peuvent faire",
                view: "Voir la conversation",
                always: "Toujours",
                send: "Envoyer des messages",
                sendDescription: "Inclut l’arrêt de l’agent et l’ajout de fichiers.",
                changeModel: "Changer de modèle",
                permissionModes: "Modes d’autorisation",
                permissionModesDescription: "Les discussions n’affichent un sélecteur de mode que si plusieurs modes sont autorisés.",
                anyMode: "Tous les modes",
                anyModeDescription: "Les personnes peuvent changer ce que l’agent fait sans demander.",
                modeOnly: ({ name }: { name: string }) => `${name} uniquement`,
                modes: ({ count }: { count: number }) => `${count} modes`,
                approveOn: "Les personnes sur ces sites peuvent approuver l’usage des outils et les demandes dans ces discussions.",
            },
            models: {
                title: "Modèles",
                description: "Les autres modèles sont refusés, pas seulement masqués. Les discussions démarrent sur le premier modèle autorisé.",
                allowed: "Modèles autorisés",
                any: "Tous les modèles",
            },
            organization: {
                title: "Organisation",
                description: "Votre app liste d’ici les discussions de cette intégration (avec l’une de ces étiquettes). Les nouvelles discussions arrivent ici aussi.",
                folder: "Dossier",
                tags: "Étiquettes",
                none: "Aucun",
            },
            composer: {
                title: "Zone de saisie",
                attachments: "Pièces jointes",
                attachmentsDescription: "Masque le bouton de pièce jointe. Les personnes qui peuvent envoyer peuvent toujours joindre des fichiers via l’API.",
            },
            sessions: {
                title: "Sessions",
                description: "Les sessions créées par cette clé, depuis votre serveur ou la discussion, s’exécutent sur cet ordinateur avec cet agent, et arrivent dans le dossier et les étiquettes ci-dessus.",
                allow: "Autoriser cette clé à créer des sessions",
                offConsequence: "Cette clé ne peut pas créer de sessions. Votre app ne peut afficher que des discussions existantes.",
                computer: "Ordinateur",
                agent: "Agent",
                newChat: "Démarrer de nouvelles discussions dans l’intégration",
                appSetting: "Pour votre application",
                newChatDescription: "Affiche une zone de nouvelle discussion quand votre app ouvre l’intégration sans discussion. C’est un réglage pour votre app, pas une limite de sécurité : votre serveur peut toujours créer des discussions avec cette clé.",
            },
            appearance: {
                title: "Apparence",
                description: "L’aperçu suit chaque changement. Les discussions ouvertes se mettent à jour sans rechargement.",
                mode: "Mode",
                modeSystem: "Système",
                modeLight: "Clair",
                modeDark: "Sombre",
                theme: "Thème",
                presetHappier: "Happier",
                colors: "Couleurs",
                colorsDefault: "Couleurs Happier",
                colorsCustomized: ({ count }: { count: number }) => count === 1 ? '1 personnalisée' : `${count} personnalisées`,
                colorsFor: "Couleurs pour",
                colorGroups: {
                    surface: "Surfaces",
                    text: "Texte",
                    accent: "Accent",
                    messages: "Messages",
                    composer: "Zone de saisie",
                    approvals: "Approbations",
                },
                fontFamily: "Police",
                fontFamilyPlaceholder: "Police Happier",
                fontFile: "Fichier de police",
                fontFileDescription: "Un lien https vers un fichier .woff2 ou .woff.",
                fontFileRefused: "Utilisez un lien vers un fichier .woff2 ou .woff, pas une feuille de style.",
                textSize: "Taille du texte",
                textSizeCompact: "Compacte",
                textSizeDefault: "Par défaut",
                textSizeLarge: "Grande",
                corners: "Coins",
                cornersSharp: "Nets",
                cornersSoft: "Doux",
                cornersRound: "Arrondis",
                density: "Densité",
                densityCompact: "Compacte",
                densityComfortable: "Confortable",
                reset: "Réinitialiser l’apparence",
            },
            preview: {
                title: "Aperçu en direct",
                phone: "Téléphone",
                desktop: "Ordinateur",
                reduceMotion: "Réduire les animations",
                note: "La vraie discussion intégrée avec des messages d’exemple. Rien n’est envoyé.",
                rowDescription: "Voir la discussion avec ces réglages.",
                unavailable: "Aperçu indisponible",
            },
            snippets: {
                title: "Extraits de code",
                description: "Collez-les dans votre app. Ils utilisent déjà les réglages de cette intégration.",
                steps: "1 Stockez la clé dans HAPPIER_EMBED_KEY · 2 Écrivez canOpenSession : qui peut ouvrir quelle discussion · 3 Affichez la discussion",
                backend: "Serveur",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Créée le ${date}`,
                lastUsed: ({ date }: { date: string }) => `Utilisée le ${date}`,
                expires: ({ date }: { date: string }) => `Expire le ${date}`,
                reconnect: "Les discussions ouvertes se reconnectent avec le nouvel accès. Les brouillons sont conservés.",
                e2eeTrust: "Cette clé peut lire les discussions chiffrées de ce compte. Utilisez un compte dédié pour votre app.",
                keyReach: "La clé reste sur votre serveur et peut atteindre toutes les discussions de ce compte. Les navigateurs ne la voient jamais : ils reçoivent des clés de courte durée limitées aux discussions que votre serveur autorise.",
                expiry: "La clé expire",
                expiryDescription: "Quand la clé expire, les discussions ne s’ouvrent plus. Elle ne peut pas être prolongée ensuite.",
                encryptionChecking: "Vérification du chiffrement de ce compte…",
                encryptionUnavailable: "Cet appareil ne peut pas encore lire les discussions chiffrées de ce compte. Restaurez votre clé secrète pour créer l’intégration.",
                encryptionStale: "Les clés de cet appareil pour les discussions chiffrées ne sont plus à jour. Restaurez votre clé secrète pour créer l’intégration.",
                encryptionUnreadable: "Le chiffrement de ce compte n’a pas pu être vérifié.",
                missingTitle: "Cette intégration n’existe plus",
                backToEmbeds: "Retour aux intégrations",
            },
            delete: {
                button: "Supprimer l’intégration",
                title: ({ label }: { label: string }) => `Supprimer « ${label} » ?`,
                body: "Les discussions ouvertes sont déconnectées. Les clés déjà utilisées pour lire des discussions chiffrées ne peuvent pas être rappelées.",
                confirm: "Supprimer",
            },
            reveal: {
                copyEnv: "Copier comme ligne .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { fr: translated({
        embed: {
            errors: {
                originNotAllowed: 'Cette page n’est pas autorisée à afficher cette conversation.',
                originNotAllowedReason: 'Ajoutez ce site aux sites autorisés de l’intégration dans Happier.',
                unavailable: 'Cette conversation n’est pas disponible ici.',
                encrypted: 'Cette conversation est chiffrée et ne peut pas être ouverte ici.',
                createNotGranted: 'Cette application ne peut pas démarrer de nouvelles discussions.',
                unsupportedVersion: 'Cette discussion nécessite une intégration plus récente.',
                unsupportedVersionReason: 'Mettez à jour @happier-dev/embed dans cette application.',
            },
            nothingToShow: 'Rien à afficher pour le moment',
            nothingToShowReason: 'Cette application n’a ouvert aucune conversation.',
            reconnecting: 'Reconnexion…',
            previewUnavailable: 'Aperçu indisponible',
            previewUser: "Analyse ce prospect et enregistre le résultat : Acme Robotics, 40 postes, évaluation au quatrième trimestre.",
            previewAgent: "Très bonne adéquation. Le budget est confirmé et le sponsor décide. J’ai enregistré l’analyse :",
            previewFollowUp: "On passe ce prospect en qualifié ?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const fr: EntityDragDropTranslations = {
    files: { attach: "Joindre", uploadHere: "Importer ici" },
    composer: { addContext: "Ajouter du contexte", consequence: "Envoyé avec votre prochain message · rien n’est encore envoyé", target: "Éditeur", readOnly: "Cet éditeur est en lecture seule", otherWorkspace: "Ne fait pas partie de cet espace de travail", unavailable: "Cette référence est indisponible" },
    surface: {
        scopeMismatch: 'Cet élément est dans un autre Home ou compte',
        widgetMoveUnavailable: 'Ce widget ne peut pas être déplacé vers cette surface',
        widgetReadOnly: 'Vous pouvez voir cette disposition mais pas la modifier. Demandez l’accès en modification à son propriétaire',
        widgetAlreadyHere: 'Il est déjà sur cette surface. Réordonnez-le là-bas',
        widgetCantLiveHere: 'Ce widget ne peut pas vivre sur cette surface. Ajoutez-le ici depuis Ajouter un widget',
        widgetNeedsInputs: 'Ses entrées ne peuvent pas être renseignées ici. Ajoutez-le ici depuis Ajouter un widget et choisissez-les',
        widgetLayoutChanged: 'Cette disposition vient de changer. Déposez-le à nouveau',
        readOnly: 'Ce tableau est en lecture seule',
        copyDetail: 'Conserve une référence · le tableau reste inchangé',
    },
    preview: {
        putUnder: ({ target }) => `Placer sous ${target}`,
        putUnderDetail: 'Lui rend compte · les deux continuent',
        moveAbove: ({ target }) => `Déplacer au-dessus de ${target}`,
        moveBelow: ({ target }) => `Déplacer sous ${target}`,
        orderDetail: 'Ordre seulement · personne ne rend compte à personne',
        moveToFolder: ({ folder }) => `Déplacer dans ${folder}`,
        folderDetail: 'Dossier seulement · ne rend compte à personne',
        moveToTopLevel: 'Déplacer au premier niveau',
        topLevelDetail: 'Hors de son dossier · rien d’autre ne change',
        cantPutUnder: ({ target }) => `Impossible de placer sous ${target}`,
        cantMoveHere: 'Impossible de la déplacer ici',
        pendingPutUnder: ({ target }) => `Placement sous ${target}…`,
        pendingDetail: 'En attente de la confirmation du Home',
        unknownTitle: 'Pas sûr que ce soit déplacé',
        unknownDetail: 'Vérifie la liste dans un instant avant de réessayer',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `Impossible de placer ${item} sous ${target}`,
        refused: ({ verb }) => `${verb} : n’a pas abouti`,
        unknown: ({ verb }) => `Pas sûr que « ${verb} » ait abouti`,
        dismiss: 'Ignorer',
    },
    reasons: {
        read: 'Elle est partagée avec toi en lecture seule, elle ne peut donc pas recevoir de comptes rendus',
        input: 'Tu ne peux rien lui envoyer, elle ne peut donc pas recevoir de comptes rendus',
        pairwise: 'Ces deux sessions ne peuvent pas partager leur contexte',
        cycle: 'Cette session rend déjà compte à celle-ci',
        alreadyUnder: 'Elle rend déjà compte à celle-ci',
        archived: 'Elle est archivée',
        differentHome: 'Elle est dans un autre Home. Les sessions rendent compte au sein d’un même Home',
        unavailable: 'Impossible de vérifier cette session pour le moment',
        dateOrder: 'Cette liste est triée par date. Passe à l’ordre personnalisé pour la placer',
        noChange: 'Elle est déjà ici',
        descendantCycle: 'Un dossier ne peut pas aller dans lui-même',
        maxDepth: 'Les dossiers seraient trop imbriqués',
        foldersOff: 'Les dossiers sont désactivés pour ce Home',
        gone: 'Cet emplacement vient de disparaître',
        generic: 'Cet emplacement ne peut pas l’accueillir',
    },
    chooser: { putUnderTitle: ({ item }) => `Placer ${item} sous…`, checking: 'Vérification des sessions qui peuvent recevoir des comptes rendus…', cantTakeReports: 'Ne peuvent pas recevoir de comptes rendus', unavailable: 'Indisponible' },
    keyboard: {
        choose: 'Choisir un emplacement', putUnder: 'Placer sous', topLevel: 'Premier niveau', drop: 'Déposer', cancel: 'Annuler', escapeKey: 'échap',
        hintsA11y: 'Les flèches choisissent un emplacement, Entrée dépose, Échap annule',
    },
    organize: { enter: 'Organiser la liste', title: 'Organiser', done: 'Terminé', grip: ({ item }) => `Déplacer ${item}` },
    pane: {
        openHere: 'Ouvrir ici dans un onglet',
        nextTo: ({ target }) => `À côté de ${target} · rien ne se ferme`,
        nothingCloses: 'S’ouvre dans un onglet · rien ne se ferme',
        tooNarrow: 'Ce panneau est trop étroit pour être divisé',
        moveHere: 'Déplacer ici dans un onglet',
        openBefore: ({ target }) => `Ouvrir avant ${target}`,
        moveBefore: ({ target }) => `Déplacer avant ${target}`,
        placeOnly: 'Seule sa place change',
        splitLeft: 'Diviser à gauche',
        splitRight: 'Diviser à droite',
        splitUp: 'Diviser en haut',
        splitDown: 'Diviser en bas',
        opensBeside: ({ target }) => `S’ouvre à côté de ${target}`,
        movesBeside: ({ target }) => `Se place à côté de ${target}`,
        goTo: ({ target }) => `Aller à ${target}`,
        openInThisPane: 'Déjà ouvert dans ce panneau · rien de nouveau ne s’ouvre',
        openInAnotherPane: 'Déjà ouvert dans un autre panneau · rien de nouveau ne s’ouvre',
        alreadyHere: 'Déjà ici',
        leaveIt: 'Relâchez pour le laisser où il est',
        cantOpenHere: 'Impossible de l’ouvrir ici',
        sessionsOnly: 'Ce panneau n’affiche que des sessions',
        otherWorkspace: 'Ne fait pas partie de cet espace de travail',
    },
};

const entityDragDropTranslations = { fr };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const eventAutomationComposerTranslations = { fr: {
    eventAutomationComposer: {
        available: 'Disponible',
        payloadFields: 'CHAMPS DU PAYLOAD',
        payloadSample: 'Exemple de payload',
        noFilterableFields: 'Cet Événement ne déclare aucun champ de payload filtrable.',
        addFilterClause: 'Ajouter une condition',
        filterField: 'Champ du filtre',
        filterOperator: 'Opérateur du filtre',
        filterEquals: 'Égal à',
        filterOneOf: 'Fait partie de',
        filterValue: 'Valeur du filtre',
        filterValuePlaceholder: '"value" ou ["value"]',
        storedContentUnavailableTitle: 'Contenu d’automatisation stocké indisponible',
        storedContentUnavailableBody: 'Cette automatisation d’Événement ne peut pas être enregistrée car son contenu stocké est indisponible.',
        historyGapRecoveryTitle: 'Une lacune d’historique nécessite ton attention',
        historyGapRecoverySubtitle: 'Réinitialise la ligne de base de la source pour reprendre l’observation des nouveaux Événements.',
        historyGapRecoveryUnavailable: 'L’action de récupération de la source n’est pas disponible sur son watcher actuel.',
        historyGapRecoveryFailureTitle: 'La récupération de la source doit être retentée',
        historyGapRecoveryFailureBody: 'La récupération n’a pas été confirmée. La source nécessite toujours ton attention.',
        sourceStatusTitle: 'Source d’observation',
        sourceStatusState: {
            uninitialized: 'Non démarrée',
            baselined: 'Ligne de base prête',
            observing: 'Observation',
            backingOff: 'En attente de nouvelle tentative',
            attention: 'Nécessite ton attention',
        },
        sourceStatusCode: {
            credentialMissing: 'Identifiants requis',
            credentialRevoked: 'Identifiants révoqués',
            rateLimited: 'Limite de débit atteinte',
            historyGap: 'Lacune d’historique',
            capacityBlocked: 'Capacité bloquée',
            definitionStale: 'La définition a changé',
            sourceContractIncompatible: 'La source doit être mise à jour',
            admissionUnavailable: 'Admission indisponible',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Prochaine tentative : ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Événements observés : ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Événements admis : ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Événements ignorés : ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Dernière observation : ${time}`,
        sourceCatalogStatusTitle: 'Réconciliation du catalogue',
        sourceCatalogStatusState: {
            current: 'À jour',
            reconciling: 'Réconciliation en cours',
            reconciliationLate: 'Réconciliation retardée',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Révision observée : ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Révision adoptée : ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Aucune révision n’a encore été adoptée',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Analyse commencée : ${time}`,
    },
} } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { fr: {
    browseLinked: 'Lié',
    browseImported: 'Importé',
    browseAgentUnavailable: 'Happier n’a pas pu démarrer ou joindre l’Agent sélectionné sur cette machine. Vérifie que son CLI y est installé, puis réessaie.',
    browseAgentTimedOut: 'L’Agent sélectionné sur cette machine n’a pas répondu à temps. Il est peut-être occupé ou encore en cours d’indexation, alors réessaie.',
    browseAgentFailed: 'Happier n’a pas pu lire les sessions de l’Agent sélectionné sur cette machine. Réessaie ; si l’échec persiste, mets à jour Happier sur cette machine.',
    operationTitleMaterialize: 'Importer dans Happier',
    operationTitleTakeoverLinked: 'Reprendre la main et continuer en lié',
    operationTitleTakeoverPersisted: 'Importer et reprendre la main',
    operationMaterializeAvailable: 'Importe cette session liée pour utiliser sa transcription hors ligne ou la partager.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} sur ${machine}: ${status}`,
    operationStatusRunning: 'En cours',
    operationStatusCancelling: 'Annulation…',
    operationStatusCancelled: 'Annulé',
    operationStatusCompleted: 'Terminé',
    operationStatusDiscarded: 'Session partielle abandonnée',
    operationStatusNeedsResume: 'En attente que tu reprennes',
    operationStatusNeedsReview: 'Doit être vérifié avant de pouvoir continuer',
    operationStatusFailed: 'Impossible de continuer',
    operationStatusImportIncomplete: 'Import incomplet — Reprends ou abandonne la session partielle',
    operationStatusUpdateIncomplete: 'Mise à jour incomplète — Reprendre',
    operationStatusOriginOffline: 'Progression enregistrée — la machine source est hors ligne',
    operationStatusOriginUnknown: 'Progression enregistrée — Happier ne peut pas savoir si la machine source est en ligne',
    operationStatusExternalWriter: 'Écriture externe détectée',
    operationStatusSpawnFailedAfterImport: 'Importé, mais l’Agent n’a pas pu démarrer — Réessayer le démarrage',
    operationStatusSpawnFailedAfterTakeover: 'Main reprise, mais l’Agent n’a pas pu démarrer — Réessayer le démarrage',
    operationErrorSourceUnavailable: 'La source est indisponible. Reconnecte la machine source, puis reprends.',
    operationErrorSourceChanged: 'La source a changé pendant sa lecture. Vérifie-la avant de reprendre.',
    operationErrorCapacity: 'Cette machine n’a pas assez de capacité de staging pour continuer.',
    operationErrorRequiredItems: 'Certains éléments de session requis n’ont pas pu être importés.',
    operationErrorImport: 'L’import des messages a été interrompu.',
    operationErrorPublication: 'Le snapshot importé n’a pas pu être publié.',
    operationErrorAdmission: 'Happier n’a pas pu prendre le contrôle de cette session en toute sécurité.',
    operationErrorExternalWriter: 'Arrête l’Agent extérieur avant de réessayer. Happier ne le fusionnera pas et ne l’arrêtera pas automatiquement.',
    operationErrorInternal: 'L’opération s’est arrêtée à cause d’une erreur interne.',
    operationPhaseValidating: 'Validation',
    operationPhaseWaitingForAgent: 'En attente de l’arrêt de l’Agent externe',
    operationPhaseReadingSource: 'Lecture de la source',
    operationPhaseImporting: 'Import des messages',
    operationPhaseCatchingUp: 'Rattrapage avec la source',
    operationPhasePreparingRuntime: 'Préparation du runtime',
    operationPhaseStartingRuntime: 'Démarrage du runtime',
    operationPhaseFinalizing: 'Finalisation',
    operationPhasePublishing: 'Publication de la session importée',
    operationActionResume: 'Reprendre',
    operationActionRetryStart: 'Réessayer le démarrage',
    operationActionCancel: 'Annuler',
    operationActionDiscard: 'Abandonner la session partielle',
    operationActionDismiss: 'Ignorer',
    operationStatusOwnerReadFailed: 'Happier n’a pas pu lire la progression actuelle de cette opération.',
    operationActionCheckAgain: 'Vérifier à nouveau',
    operationComposerImporting: 'Import…',
    operationComposerTakingOver: 'Reprise de la main…',
    operationActionErrorUpgradeRequired: 'Mets Happier à jour sur la machine source pour utiliser cette action.',
    operationActionErrorNotFound: 'Cette opération n’est plus disponible.',
    operationActionErrorConflict: 'Une autre opération contrôle déjà cette session.',
    operationActionErrorStaleRevision: 'L’opération a changé. Vérifie sa progression la plus récente, puis réessaie.',
    operationActionErrorInvalidState: 'Cette action n’est pas disponible dans l’état actuel de l’opération.',
    operationActionErrorNotAllowed: 'Tu n’as pas la permission de contrôler cette opération.',
    operationActionErrorUnavailable: 'L’action sur l’opération n’a pas pu être effectuée. Réessaie depuis sa progression la plus récente.',
    operationImportProgress: 'Progression de l’import',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} messages importés`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} sur ~${total} messages`,
    operationPublishedSnapshot: 'Snapshot publié conservé',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Disponible jusqu’au message ${sequence}`,
    operationDiscardConfirmTitle: 'Abandonner la session partielle ?',
    operationDiscardConfirmBody: 'Cela supprime toute la session partielle. Cette action est irréversible.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `La transcription de cette session se trouve sur ${machine}. Importe-la dans Happier pour la partager.`,
    sharingImportIncomplete: 'Import en cours ou incomplet. Reprends l’import avant de partager.',
    sharingTranscriptUnavailableTitle: 'Transcription indisponible',
    transcriptRetainedRefreshFailedTitle: 'Affichage de la dernière transcription connue',
    transcriptLoadFailed: 'Happier n’a pas pu charger cette transcription.',
    sharingTranscriptUnavailable: 'Transcription indisponible. Cette ancienne session liée n’a pas de transcription persistée sûre.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Partagé jusqu’à ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Snapshot du ${time}`,
    sharingUpdateSharedCopy: 'Mettre à jour la copie partagée',
    sharingUpdateSharedCopyDescription: 'Actualise le snapshot partagé avec la dernière transcription de la source.',
    sharingSourceMachineMissing: 'La machine source est indisponible. Reconnecte-la à Happier avant de réessayer.',
    sharingSourceMachineOffline: 'La machine source est hors ligne. Remets-la en ligne avant de réessayer.',
    sharingActionAwaitingAvailability: 'Cette action sera disponible quand le workflow de matérialisation sera connecté.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { fr: {
    settingsIntegrationStatusNotInstalled: 'Non installé',
    settingsIntegrationStatusEnabled: 'Installé et activé',
    settingsIntegrationStatusDisabled: 'Installé et désactivé',
    settingsIntegrationStatusNeedsAttention: 'Nécessite ton attention',
    settingsIntegrationStatusUnsupported: 'Non pris en charge par cette version de l’Agent',
    settingsIntegrationStatusUnavailable: 'Agent indisponible',
    settingsIntegrationInventoryLoadingTitle: 'Vérification de l’état de l’intégration',
    settingsIntegrationInventoryLoadingSubtitle: 'Lecture de l’inventaire complet des intégrations depuis cette machine.',
    settingsIntegrationInventoryPartialTitle: 'État de l’intégration incomplet',
    settingsIntegrationInventoryPartialSubtitle: 'Certains enregistrements d’installation n’ont pas pu être lus. Vérifie à nouveau avant de faire des modifications.',
    settingsIntegrationInventoryErrorTitle: 'État de l’intégration indisponible',
    settingsIntegrationInventoryErrorSubtitle: 'Le dernier état connu peut être obsolète. Vérifie à nouveau avant de faire des modifications.',
    settingsIntegrationTitle: 'Surveillance des sessions externes',
    settingsIntegrationNeedsAttentionTitle: 'Nécessite ton attention',
    settingsIntegrationDiagnosticMessageUnavailable: 'Cette installation nécessite ton attention avant que la surveillance puisse continuer.',
    settingsIntegrationRemediationRetry: 'Vérifie à nouveau une fois le problème résolu.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Vérifie le réglage dans ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Sélectionne un compte pour ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Installe la dépendance requise : ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Consulte les instructions sur ${url}.`,
    settingsIntegrationActionReviewInstall: 'Vérifier et installer',
    settingsIntegrationActionDisable: 'Désactiver',
    settingsIntegrationActionEnable: 'Activer',
    settingsIntegrationActionUninstall: 'Désinstaller',
    settingsIntegrationActionCheckAgain: 'Vérifier à nouveau',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Vérifier l’intégration ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier ne gérera que ces entrées : ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Vérifie les modifications gérées par l’Agent avant d’installer.',
    settingsIntegrationPreviewNoMatcher: 'Toutes les sessions correspondantes',
    settingsIntegrationActionInstall: 'Installer',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Désinstaller l’intégration ${agent} ?`,
    settingsIntegrationUninstallBody: 'Cela supprime uniquement les entrées gérées par Happier. Le reste de la configuration de l’Agent est laissé inchangé.',
    settingsIntegrationActionFailed: 'Happier n’a pas pu mettre à jour cette intégration. Vérifie la machine et réessaie.',
    settingsAutoLinkUpdateFailed: 'Happier n’a pas pu mettre à jour la liaison automatique. Réessaie.',
    settingsRestoreUpdateFailed: 'Happier n’a pas pu mettre à jour la préférence de synchronisation au redémarrage. Réessaie.',
    settingsIntegrationsGroupTitle: 'Surveillance des sessions externes',
    settingsIntegrationsFooter: 'Happier ne modifie la configuration de l’Agent qu’après une action explicite. Ouvrir cette page est en lecture seule.',
    settingsIntegrationsUnavailableTitle: 'Aucune intégration disponible',
    settingsIntegrationsUnavailableSubtitle: 'Connecte une intégration d’Agent prise en charge pour voir son état et les actions disponibles.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Ajouter automatiquement les nouvelles sessions ${agent}`,
    settingsAutoLinkTitle: 'Ajouter automatiquement les nouvelles sessions externes',
    browseAutoLinkTitle: 'Ajouter automatiquement les nouvelles sessions',
    settingsAutoLinkGroupTitle: 'Liaison automatique',
    settingsAutoLinkGroupFooter: 'La liaison automatique est désactivée par défaut et reste indépendante de la configuration de l’intégration de l’Agent et de la synchronisation en arrière-plan.',
    settingsAutoLinkUnavailableTitle: 'Aucune source de liaison automatique disponible',
    settingsAutoLinkUnavailableSubtitle: 'Aucune portée de source prise en charge n’est disponible sur cette machine.',
    settingsAutoLinkSubtitle: 'Quand c’est activé, Happier lie les nouvelles sessions prises en charge de cette source sans ouvrir ni reprendre l’Agent.',
    settingsAutoLinkHint: 'Active ou désactive la liaison automatique pour cette source.',
    settingsPrivacyGroupTitle: 'Confidentialité',
    settingsPrivacyTitle: 'Observations limitées et sans contenu',
    settingsPrivacySubtitle: 'Les intégrations d’Agent de confiance peuvent inspecter des données de hook natives limitées sur cette machine. Happier n’admet et ne synchronise que des observations sans contenu ; les payloads bruts, les chemins, les identifiants, les prompts, le texte des transcriptions et les arguments d’outils ne sont jamais conservés, synchronisés ni journalisés par l’hôte.',
    settingsAgentActionsGroupTitle: 'Sessions externes',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Parcourir les sessions ${agent} externes`,
    settingsManageAllTitle: 'Gérer toutes les sessions externes',
    settingsManageAllSubtitle: 'Vérifie les intégrations et la synchronisation en arrière-plan sur les machines connectées.',
    settingsMachineOnline: 'En ligne',
    settingsMachineOffline: 'Hors ligne',
    settingsMachineTitle: 'Machine',
    settingsMachineUnavailable: 'Aucune machine connectée',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Affichage des ${count} premiers — affine ta recherche`,
    browseAnnotationsIncomplete: 'Certains états n’ont pas pu être confirmés. Ouvrir une session le vérifie.',
    browseRouteUnavailableTitle: 'Les sessions externes sont indisponibles ici',
    browseRouteUnavailableSubtitle: 'Ce serveur ne propose pas la navigation des sessions externes. Reviens en arrière et choisis un autre serveur, ou réessaie plus tard.',
    browseRouteAvailabilityUnknownTitle: 'Impossible de confirmer la prise en charge des sessions externes',
    browseRouteAvailabilityUnknownSubtitle: 'Happier n’a pas pu vérifier si ce serveur propose la navigation des sessions externes. Reviens en arrière et réessaie dans un instant.',
    browseHeaderTitle: 'Sessions externes',
    browseSettingsLink: 'Réglages des sessions externes',
    browseChooseMachineTitle: 'Choisir une machine',
    browseChooseMachineBody: 'Les sessions externes restent sur la machine qui les a lancées. Choisis-en une pour voir ses sessions.',
    browseMachineGoneBody: 'Elle a été retirée ou remplacée. Choisis une autre machine pour voir ses sessions.',
    browseHomeUnreachableBody: 'Ses machines et sessions apparaîtront dès qu’il sera joignable. Choisis une autre machine en attendant.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} est hors ligne`,
    browseThisMachineOfflineTitle: 'Cette machine est hors ligne',
    browseMachineOfflineBody: 'Ses sessions apparaîtront dès qu’elle se reconnectera.',
    browseChooseAnotherMachine: 'Choisir une autre machine',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Impossible de joindre Happier sur ${machine}`,
    browseCantReachBody: 'La machine est en ligne, mais son service Happier ne répond pas. Il est peut-être encore en train de démarrer.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Rien à parcourir sur ${machine}`,
    browseNothingToBrowseBody: 'Aucun des agents de cette machine ne peut encore partager ses sessions.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Aucune session ${agent} sur ${machine}`,
    browseEmptyBody: 'Les sessions que tu lances sur cette machine apparaissent ici, prêtes à s’ouvrir dans Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Essayer ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Aucune session ne correspond à « ${query} »`,
    browseErrorTitle: 'Impossible de charger les sessions',
    browseThisMachine: 'cette machine',
    browseIndexingStop: 'Arrêter',
    browseThreadsFilter: 'Fils de sous-agents',
    browseThreadsHidden: 'Sessions principales',
    browseThreadsShown: 'Avec les fils de sous-agents',
    browseThreadReviewer: 'Réviseur',
    browseThreadSubagent: 'Sous-agent',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Réviseur de ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Sous-agent de ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { fr: {
        changedOnly: 'Modifiés seulement',
        showAllFiles: 'Afficher tous les fichiers',
        viewOptions: 'Options d’affichage',
        sizeAndDate: 'Taille et date',
        newMenu: 'Nouveau fichier, nouveau dossier ou import',
        newFile: 'Nouveau fichier',
        newFolder: 'Nouveau dossier',
        noChangedFilesTitle: 'Rien n’a changé',
        noChangedFilesReason: 'La copie de travail correspond au dernier commit.',
        rootErrorTitle: ({ machine }) => `Impossible de lister les fichiers sur ${machine}`,
        rootErrorTitleUnnamed: 'Impossible de lister les fichiers',
        workspaceUnavailableReason: 'Happier n’a pas pu identifier un ordinateur et un dossier pour cette session.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "fr">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const fr: FindTranslations = {
    open: 'Rechercher…',
    openedForMatch: 'Ouvert pour une correspondance', foldAgain: 'Replier', showHiddenLines: ({ count }) => `Afficher ${count} lignes masquées`,
    surface: {
        chat: 'Rechercher dans le chat',
        changes: 'Rechercher dans les modifications',
        file: 'Rechercher dans le fichier',
        terminal: ({ name }) => `Rechercher dans ${name}`,
    },
    previous: 'Occurrence précédente',
    next: 'Occurrence suivante',
    matchCase: 'Respecter la casse',
    regex: 'Utiliser une expression régulière',
    regexShort: 'Expression régulière',
    options: 'Options de recherche',
    close: 'Fermer la recherche',
    done: 'Terminé',
    stop: 'Arrêter',
    noMatches: 'Aucune occurrence',
    noneFound: 'Rien trouvé',
    invalidPattern: 'Motif non valide',
    offline: 'Hors ligne',
    unsupported: 'Recherche impossible ici',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'occurrence' : 'occurrences'}` : `${current} sur ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
    soFar: 'pour l’instant',
    loaded: 'chargées',
    note: {
        searchingOlder: 'Recherche dans les messages plus anciens, déchiffrés sur cet appareil',
        offlineOlder: 'Les messages plus anciens pourront être recherchés une fois de retour en ligne.',
        terminalKept: ({ lines }) => `Recherche effectuée dans les ${lines} dernières lignes conservées par ce terminal.`,
    },
};

const findTranslations = { fr };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const fr: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Ajouter un dossier',
        noFolder: 'Aucun dossier',
        noFolderDescription: 'Happier garde un dossier privé pour cette discussion',
        removeFolder: 'Retirer le dossier',
        a11y: {
            folder: ({ path }) => `Dossier : ${path}. Ouvre le choix du dossier.`,
            none: 'Aucun dossier. Happier garde un dossier privé pour cette discussion. Ajouter un dossier.',
            loading: 'Chargement du dossier',
            noFolderRow: 'Aucun dossier, dossier privé pour cette discussion',
            removed: 'Dossier retiré',
            set: ({ path }) => `Dossier défini sur ${path}`,
        },
    },
    display: {
        chats: 'Discussions',
        untitledChat: 'Nouvelle discussion',
        folder: 'Dossier',
        privateToSession: 'Propre à cette session',
        sessionFiles: 'Fichiers de la session',
        privateFolderOn: ({ machine }) => `Dossier privé sur ${machine}`,
    },
};

const folderlessSessionTranslations = { fr: fr };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "fr": {
        "effectiveBrowserSolid": "Menus et commandes flottantes opaques. Un navigateur ne peut pas montrer votre bureau.",
        "effectiveFloatingSolid": "Commandes flottantes opaques sur cet appareil.",
        "effectiveSolid": "Surfaces opaques sur cet appareil.",
        "effectiveBrowser": "Verre sur les menus et commandes flottantes. Un navigateur ne peut pas montrer votre bureau.",
        "effectiveBrowserCustom": "Votre matériau sur les menus et commandes flottantes. Un navigateur ne peut pas montrer votre bureau.",
        "effectivePhone": "Verre sur les commandes flottantes et feuilles.",
        "effectiveLayered": "Verre en couches dans toute cette fenêtre.",
        "effectiveUniform": "Verre uniforme dans toute cette fenêtre.",
        "effectiveCustom": "Verre dans cette fenêtre selon vos réglages.",
        "effectiveUnavailable": "Le verre de fenêtre est indisponible. Les commandes flottantes utilisent le matériau choisi.",
        "effectiveInactive": "Opaque tant que cette fenêtre est inactive.",
        "effectiveTint": "Commandes flottantes teintées ; le flou d’arrière-plan est indisponible.",
        "description": "Laissez voir le bureau à travers la fenêtre et la page sous les commandes flottantes.",
        "descriptionBrowser": "Laissez voir la page sous les menus et commandes flottantes.",
        "descriptionPhone": "Laissez voir la page sous les commandes flottantes et feuilles.",
        "chromeDescription": "Barre de titre, navigation et fond de fenêtre",
        "sidebarDescription": "Votre colonne de sessions",
        "contentDescription": "Conversation, saisie et panneaux de travail",
        "floatingDescription": "Menus, popovers, feuilles et commandes flottantes",
        "clear": "Transparent",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-clic · ${modifier}⇧L alterne clair et sombre`
    } } as const;

const glassAppearanceTranslations = { fr: { iosReduceTransparencyPath: "Réglages › Accessibilité › Affichage et taille du texte › Réduire la transparence", title: 'Verre', material: 'Matériau', solid: 'Opaque', auto: 'Auto', everywhere: 'Partout', custom: 'Personnalisé', blur: 'Flou', off: 'Désactivé', opacity: 'Opacité', customize: 'Personnaliser', chrome: 'Cadre de la fenêtre', sidebar: 'Barre latérale', content: 'Contenu', floating: 'Surfaces flottantes', appearance: 'Apparence', moreSettings: 'Plus de réglages d’apparence…', customizeLink: 'Personnaliser…', toolbarTitle: 'Bouton Apparence', toolbarDescription: 'Affiche Apparence dans la barre. Un clic avec une touche modificatrice alterne clair et sombre.', reduceTransparency: 'Opaque car Réduire la transparence est activé', osSettings: 'Ouvrir les réglages d’accessibilité', themeCommand: 'Alterner clair et sombre', autoDescription: "S’adapte à cet appareil : verre en couches dans les fenêtres compatibles et surfaces flottantes sur téléphone.", osSettingsUnavailable: "Impossible d’ouvrir les réglages d’accessibilité. Ouvrez-les dans les réglages de votre appareil.", ...effectiveTranslations["fr"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "fr">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const fr: typeof en = {
    row: {
        notSet: 'Non défini',
    },
    keepGoing: {
        title: 'Continuer jusqu’au bout',
        nativeDescription: ({ agent }) => `${agent} poursuit l’objectif de façon autonome.`,
        description: ({ rounds }) => `Après chacun de vos tours, un agent vérifie l’objectif et continue jusqu’à ce qu’il soit atteint, que le budget soit épuisé ou qu’il ne progresse plus, pendant ${rounds} ${rounds === 1 ? 'tour' : 'tours'} au maximum.`,
        roundsPrefix: 'Arrêter après',
        roundsSuffix: 'tours',
        roundsLabel: 'Tours avant l’arrêt',
        strikesPrefix: 'Arrêter après',
        strikesSuffix: 'vérifications sans progrès',
        strikesLabel: 'Vérifications sans progrès avant l’arrêt',
        secondOpinionTitle: 'Demander un second avis avant de terminer',
        secondOpinionDescription: 'Avant que l’objectif soit marqué comme atteint, un second agent le vérifie. S’il n’est pas d’accord, vous recevez une notification et l’objectif reste ouvert.',
        budgetUnreported: ({ agent }) => `${agent} ne signale pas sa consommation de tokens, donc seuls les tours et les vérifications de progrès s’appliquent.`,
    },
};

const goalControlTranslations = { fr };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { fr: {
        addressIsSignInService: 'Cette adresse correspond à un service de connexion. Connectez-vous à ce service pour retrouver vos Homes.',
        mixedContent: 'Ce navigateur ne peut pas se connecter à un Home HTTP depuis une page HTTPS. Ouvrez Happier en HTTP ou utilisez une adresse HTTPS pour le Home.',
        connectedToHome: ({ home }) => `${home} est connecté à cet appareil.`,
        openHome: ({ home }) => `Ouvrir ${home}`,
        showAllHomes: 'Afficher tous les Homes',
        otherSignInService: 'Autre service de connexion',
        otherSignInServiceSubtitle: 'Un service auto-hébergé ou d’entreprise',
        signInServiceAddress: 'Adresse du service',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "fr">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { fr: {
        ...starterPrompts,
        suggestionsLabel: 'Suggestions',
        summarizeProjectSince: ({ project, day }) => `Résume ce qui a changé dans ${project} depuis ${day}`,
        summarizeProjectToday: ({ project }) => `Résume ce qui a changé aujourd’hui dans ${project}`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 session depuis ${day}` : `${count} sessions depuis ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 session aujourd’hui' : `${count} sessions aujourd’hui`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "fr">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { fr: {
        title: 'Approbations d’appareils', deviceFallback: 'Nouvel appareil',
        homeLabel: ({ home }) => `Home : ${home}`, expiresLabel: ({ expiry }) => `Expire : ${expiry}`,
        requestDetails: 'Détails de la demande', requestDetailsHint: 'Afficher l’identifiant de la clé de demande',
        fingerprintLabel: 'Empreinte de la clé de demande', requestDetailsHelp: 'Ceci identifie la clé de demande. Ce n’est pas un code à comparer.',
        approve: 'Approuver', reject: 'Rejeter', loadError: 'Impossible de charger les approbations d’appareils.',
        loadErrorUnreachable: ({ homes }) => `${homes} n’a pas répondu.`, loadErrorFailed: ({ homes }) => `${homes} a répondu par une erreur.`,
        decisionError: 'Impossible de mettre à jour cette demande.', decisionRecovery: 'Choisis Approuver ou Rejeter pour réessayer.',
        approved: 'Appareil approuvé', rejected: 'Appareil rejeté', expired: 'Expirée', stopWaiting: 'Ne plus attendre',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "fr">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const fr: typeof en = {
    teams: {
        title: 'Équipes',
        description: 'Des groupes qui partagent sessions, machines et accès.',
        credentialResources: {
            title: 'Identifiants d’équipe',
            description: 'Les identifiants qu’une équipe partage avec ses sessions.',
            externalApi: {
                title: 'API des identifiants d’équipe',
                description: 'Des outils externes utilisent les identifiants d’une équipe via l’API.',
            },
        },
    },
    automations: {
        title: 'Automatisations',
        description: 'Du travail d’agent planifié et déclenché.',
    },
    workflows: {
        title: 'Workflows',
        description: 'Des pipelines d’agents en plusieurs étapes.',
    },
    pets: {
        sync: {
            title: 'Synchronisation des compagnons',
            description: 'Garde les compagnons de chacun sur tous ses appareils.',
        },
    },
    voice: {
        title: 'Voix',
        description: 'Parlez à vos agents.',
        happierVoice: {
            title: 'Voix Happier',
            description: 'La voix via le service vocal fourni par ce Home.',
        },
    },
    connectedServices: {
        group: 'Services connectés',
        quotas: {
            title: 'Jauges de quota',
            description: 'Indique le quota restant de chaque compte connecté.',
        },
        subscription: {
            title: 'État de l’abonnement',
            description: 'Indique la formule et l’état de chaque compte connecté.',
        },
        accountGroups: {
            title: 'Groupes de comptes',
            description: 'Regroupez les comptes connectés en pools.',
        },
        accountFallback: {
            title: 'Compte de secours',
            description: 'Passe au compte suivant du pool quand l’un est épuisé.',
        },
        autoQuotaReset: {
            title: 'Réinitialisation automatique du quota',
            description: 'Utilise les réinitialisations de quota en réserve une fois tous les comptes d’un pool épuisés.',
        },
        autoDisablePlanInvalid: {
            title: 'Ignorer les comptes inutilisables',
            description: 'Désactive les comptes du pool qui ne peuvent pas utiliser le modèle choisi.',
        },
        poolQuotaLimitSelection: {
            title: 'Limites de quota du pool',
            description: 'Choisissez le quota fournisseur que suit chaque pool.',
        },
    },
    updates: {
        ota: {
            title: 'Mises à jour à distance',
            description: 'Les apps installent les mises à jour sans passer par un store.',
        },
    },
    attachments: {
        uploads: {
            title: 'Pièces jointes',
            description: 'Envoyez des fichiers et des images aux agents d’une session.',
        },
    },
    sharing: {
        group: 'Partage',
        session: {
            title: 'Partage de session',
            description: 'Partagez une session avec quelqu’un sur ce Home.',
        },
        public: {
            title: 'Liens publics',
            description: 'Partagez le contenu d’une session avec un lien public.',
        },
        contentKeys: {
            title: 'Partage chiffré',
            description: 'Échange des clés pour que les sessions partagées restent chiffrées de bout en bout.',
        },
        pendingQueueV2: {
            title: 'File de messages partagée',
            description: 'Met en file les messages d’une session partagée pendant que son agent est occupé.',
        },
        pendingDeliveryState: {
            title: 'Suivi de livraison de la file',
            description: 'Retient quels messages en file ont atteint l’agent.',
        },
    },
    sessions: {
        title: 'Sessions',
        description: 'Les sessions et leurs commandes.',
        group: 'Sessions',
        handoff: {
            title: 'Transfert de session',
            description: 'Déplacez une session en cours vers une autre machine.',
        },
        ephemeralRunner: {
            title: 'Runners éphémères',
            description: 'Lancez une session sur une machine jetable.',
        },
        agentSwitching: {
            title: 'Changement d’agent',
            description: 'Poursuivez une session avec un autre agent de code.',
        },
        folders: {
            title: 'Dossiers de sessions',
            description: 'Rangez les sessions dans des dossiers.',
        },
        drafts: {
            title: 'Brouillons synchronisés',
            description: 'Gardez les messages non envoyés et les brouillons de session sur chaque appareil.',
        },
        following: {
            title: 'Suivi',
            description: 'Suivez une session pour recevoir ses mises à jour et notifications.',
        },
        conversations: {
            title: 'Conversations',
            description: 'Les personnes échangent et se mentionnent dans une session partagée.',
        },
        board: {
            title: 'Tableau de sessions',
            description: 'Organisez les sessions et leurs éléments sur des tableaux partagés.',
        },
        filteredListing: {
            title: 'Liste filtrée',
            description: 'Filtre la liste des sessions sur ce Home avant la pagination.',
        },
        usageLimitRecovery: {
            title: 'Reprise après limite d’usage',
            description: 'Attendre et reprendre, ou réessayer, quand un agent atteint une limite d’usage.',
        },
    },
    machines: {
        title: 'Machines',
        description: 'La connexion à vos machines.',
        group: 'Machines',
        pools: {
            title: 'Pools de machines',
            description: 'Bascule sur la machine suivante quand l’une est hors ligne.',
        },
        transfer: {
            title: 'Transferts entre machines',
            description: 'Transférer des données entre machines.',
            directPeer: {
                title: 'Transferts directs',
                description: 'Transfère les données directement entre machines.',
            },
            serverRouted: {
                title: 'Transferts via ce Home',
                description: 'Transfère les données via ce Home quand les machines ne peuvent pas se connecter directement.',
            },
        },
        peerMediation: {
            title: 'Connexions entre machines',
            description: 'Tunnels, flux et accès entre machines.',
            observability: {
                title: 'Diagnostic des connexions',
                description: 'Montre comment tunnels, flux et aperçus sont connectés entre machines.',
            },
        },
        tunnel: {
            title: 'Tunnels entre machines',
            description: 'Ouvrir des ports entre machines.',
            directPeer: {
                title: 'Tunnels directs',
                description: 'Ouvre des ports directement entre machines.',
            },
            serverRouted: {
                title: 'Tunnels via ce Home',
                description: 'Ouvre des ports via ce Home quand les machines ne peuvent pas se connecter directement.',
            },
        },
        liveStream: {
            title: 'Diffusions en direct',
            description: 'Diffuser l’écran d’une machine.',
            directPeer: {
                title: 'Diffusions directes',
                description: 'Diffuse l’écran d’une machine directement sur votre appareil.',
            },
            serverRouted: {
                title: 'Diffusions via ce Home',
                description: 'Diffuse l’écran d’une machine via ce Home quand la diffusion directe échoue.',
            },
        },
        rpc: {
            title: 'Appels aux machines',
            description: 'Joindre les machines directement.',
            directPeer: {
                title: 'Appels directs aux machines',
                description: 'Joint une machine directement plutôt que via ce Home.',
            },
        },
    },
    localServices: {
        title: 'Services locaux',
        description: 'Voyez et ouvrez les services qui tournent sur vos machines.',
        group: 'Services locaux',
        inventory: {
            title: 'Inventaire des services',
            description: 'Liste les ports et services actifs sur chaque machine.',
        },
        managed: {
            title: 'Services gérés',
            description: 'Démarrez, nommez et surveillez des services depuis Happier.',
        },
        launcher: {
            title: 'Lanceur de services',
            description: 'Suggère des services à ouvrir et à prévisualiser.',
        },
        actions: {
            title: 'Actions sur les services',
            description: 'Copier, prévisualiser et oublier des services.',
            terminate: {
                title: 'Arrêter des services',
                description: 'Arrête le processus d’un service détecté.',
            },
        },
        preview: {
            title: 'Aperçus de services',
            description: 'Prévisualise un service local en privé dans une session.',
        },
        publicPreview: {
            title: 'Aperçus publics',
            description: 'Partagez l’aperçu d’un service à une adresse publique.',
        },
    },
    browser: {
        title: 'Navigateur',
        description: 'Ouvrez pages, aperçus et vues hébergées dans Happier.',
        group: 'Navigateur',
        viewTargets: {
            title: 'Vues du navigateur',
            description: 'Ouvre aperçus, pages de plugins et liens dans la bonne vue.',
        },
        internal: {
            title: 'Navigateur intégré',
            description: 'Naviguez dans Happier avec ses propres sessions et profils.',
        },
        sidecar: {
            title: 'Navigateur annexe',
            description: 'Un navigateur géré à part pour l’automatisation intensive.',
        },
        diagnostics: {
            title: 'Outils de développement',
            description: 'Console, réseau et événements devtools du navigateur intégré.',
        },
        context: {
            title: 'Contexte du navigateur',
            description: 'Joignez le contenu d’une page à un message ou à un agent.',
        },
        automation: {
            title: 'Automatisation du navigateur',
            description: 'Les agents cliquent, tapent et naviguent dans le navigateur intégré.',
        },
        recording: {
            title: 'Enregistrements du navigateur',
            description: 'Enregistre les sessions du navigateur comme preuves.',
        },
    },
    plugins: {
        title: 'Plugins hors Happier',
        description: 'Installez des plugins depuis npm et vos propres sources.',
        group: 'Plugins',
        webhooks: {
            title: 'Webhooks des plugins',
            description: 'Les plugins reçoivent des webhooks de services externes.',
        },
        ui: {
            title: 'Écrans des plugins',
            description: 'Affiche les écrans et panneaux fournis par les plugins.',
            hostedWeb: {
                title: 'Écrans web des plugins',
                description: 'Affiche les écrans de plugins conçus pour le web.',
            },
            reactNativeBundles: {
                title: 'Écrans natifs des plugins',
                description: 'Exécute des écrans de plugins de confiance conçus avec React Native.',
            },
        },
    },
    devices: {
        title: 'Appareils',
        description: 'Simulateurs et appareils connectés.',
        simulatorPreview: {
            title: 'Aperçus de simulateurs',
            description: 'Affiche les simulateurs et émulateurs de vos machines.',
        },
    },
    social: {
        friends: {
            title: 'Amis',
            description: 'Ajoutez des amis et voyez ce qu’ils partagent.',
        },
    },
    auth: {
        group: 'Connexion',
        recovery: {
            providerReset: {
                title: 'Réinitialisation via un fournisseur',
                description: 'Récupérez un compte en vous connectant avec son fournisseur d’identité.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Connexion par clé',
                description: 'Connectez-vous en prouvant la clé d’un appareil.',
            },
        },
        mtls: {
            title: 'Certificats client',
            description: 'Connectez-vous avec un certificat client (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Rappel de la clé de récupération',
                description: 'Rappelle aux personnes d’enregistrer leur clé de récupération.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Connexion par scan',
                description: 'Connectez-vous sur un téléphone en scannant un code affiché sur un ordinateur.',
            },
            boundQrV2: {
                title: 'Codes d’appairage plus sûrs',
                description: 'Des codes d’appairage valables uniquement pour ce Home et ce sens.',
            },
        },
    },
    encryption: {
        group: 'Chiffrement',
        plaintextStorage: {
            title: 'Stockage non chiffré',
            description: 'Stocke les sessions sans chiffrement de bout en bout.',
        },
        accountOptOut: {
            title: 'Désactivation du chiffrement',
            description: 'Chacun peut désactiver le chiffrement de bout en bout.',
        },
    },
    remoteHosts: {
        group: 'Hôtes distants',
        management: {
            title: 'Hôtes distants',
            description: 'Enregistrez des hôtes SSH où exécuter des sessions.',
        },
        secretMaterial: {
            title: 'Secrets d’hôtes enregistrés',
            description: 'Enregistrez mots de passe et clés des hôtes SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Comptes sans clé',
            description: 'Des comptes sans clés de chiffrement de bout en bout.',
        },
    },
    bugReports: {
        title: 'Rapports de bug',
        description: 'Envoyez des rapports de bug avec des diagnostics.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Ouvrez un terminal sur une machine dans Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminal en flux',
                description: 'Une connexion plus rapide pour le terminal intégré.',
            },
        },
    },
    search: {
        title: 'Recherche',
        description: 'Recherchez dans les sessions et les transcriptions.',
    },
    providers: {
        title: 'Fournisseurs de modèles',
        description: 'Connectez des fournisseurs de modèles et choisissez les modèles des agents.',
        group: 'Fournisseurs de modèles',
        localDiscovery: {
            title: 'Trouver les fournisseurs locaux',
            description: 'Trouve les serveurs de modèles qui tournent sur vos machines.',
        },
        localModelManagement: {
            title: 'Gestion des modèles locaux',
            description: 'Téléchargez et gérez des modèles locaux.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Adresse du service de rapports',
            description: 'Où les rapports de bug sont envoyés. Si vide, aucun service de rapports n’est proposé.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Inclure les diagnostics par défaut',
            description: 'Le formulaire de rapport inclut les diagnostics, sauf si la personne qui signale les retire.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Taille maximale d’une pièce jointe',
            description: 'Plus gros fichier qu’un rapport de bug peut joindre, en octets.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Délai d’envoi',
            description: 'Durée maximale de l’envoi d’un rapport de bug, en millisecondes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Types de pièces jointes acceptés',
            description: 'Types de pièces jointes acceptés par les rapports de bug. Vide accepte les types habituels.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Fenêtre de contexte',
            description: 'Jusqu’où dans le passé un rapport de bug collecte le contexte, en millisecondes.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Voix réservée aux abonnés',
            description: 'Seuls les abonnés peuvent utiliser la voix. Si non défini, la production l’exige et les autres configurations non.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Manifeste de compagnon maximal',
            description: 'Plus gros manifeste de compagnon accepté, en octets.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Planche de sprites maximale',
            description: 'Plus grosse planche de sprites de compagnon acceptée, en octets.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Paquet de compagnon maximal',
            description: 'Plus gros paquet de compagnon accepté, en octets.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Compagnons importés par personne',
            description: 'Nombre maximal de compagnons importés qu’une personne peut garder.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Stockage de compagnons importés par personne',
            description: 'Nombre maximal d’octets de compagnons importés qu’une personne peut garder.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Compagnons personnalisés chiffrés',
            description: 'Réservé pour plus tard. Les compagnons personnalisés chiffrés ne sont pas encore synchronisés, ce réglage reste donc désactivé.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Transfert maximal via ce Home',
            description: 'Plus gros fichier qu’un transfert via ce Home transporte, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Transferts simultanés par connexion',
            description: 'Nombre maximal de transferts via ce Home qu’une connexion mène en même temps.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Données par tunnel',
            description: 'Nombre maximal d’octets qu’un tunnel via ce Home transporte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Tunnels par connexion',
            description: 'Nombre maximal de tunnels via ce Home qu’une connexion garde ouverts.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Trame de tunnel maximale',
            description: 'Plus grande trame qu’un tunnel via ce Home transporte, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Encodages de tunnel',
            description: 'Encodages de trame acceptés par les tunnels via ce Home. Vide utilise les encodages standard.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Encodage de tunnel préféré',
            description: 'L’encodage de trame à utiliser en premier. Il doit faire partie des encodages acceptés.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'En-tête de trame maximal',
            description: 'Plus grand en-tête binaire de trame, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Charge utile de trame maximale',
            description: 'Plus grande charge utile brute dans une trame, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Message tramé maximal',
            description: 'Plus grand message tramé, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Flux simultanés par tunnel',
            description: 'Nombre maximal de flux qu’un tunnel mène en même temps.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Flux par tunnel',
            description: 'Nombre maximal de flux qu’un tunnel ouvre au cours de sa vie.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Données par flux',
            description: 'Nombre maximal d’octets qu’un flux transporte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Données par tunnel, tous flux confondus',
            description: 'Nombre maximal d’octets que tous les flux d’un tunnel transportent ensemble.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Délai d’inactivité d’un flux',
            description: 'Durée pendant laquelle un flux peut rester inactif avant sa fermeture, en millisecondes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Délai d’inactivité d’un tunnel',
            description: 'Durée pendant laquelle un tunnel via ce Home peut rester inactif avant sa fermeture, en millisecondes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Limite d’inactivité des tunnels',
            description: 'Durée pendant laquelle un tunnel peut rester inactif avant sa fermeture, en millisecondes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Tunnel le plus long',
            description: 'Durée maximale pendant laquelle un tunnel reste ouvert, en millisecondes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Ports accessibles aux tunnels',
            description: 'Ports que les tunnels peuvent ouvrir. Vide n’autorise que ceux par défaut.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Durée de vie des liens d’aperçu',
            description: 'Durée de validité d’un lien d’aperçu privé, en millisecondes.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Domaine des aperçus',
            description: 'Domaine qui sert chaque aperçu à sa propre adresse. Vide sert les aperçus sous l’adresse de ce Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modes d’aperçu public',
            description: 'Façons dont un aperçu peut être rendu public.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Aperçu public le plus long',
            description: 'Durée maximale pendant laquelle un aperçu reste public, en millisecondes. Vide conserve la limite standard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Aperçus publics simultanés',
            description: 'Nombre maximal d’aperçus publics en même temps. Vide conserve la limite standard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Exiger DNS et TLS',
            description: 'Les aperçus publics nécessitent DNS et TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Journal d’audit des aperçus publics',
            description: 'Où les aperçus publics sont enregistrés. Les aperçus publics en ont besoin.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Fichier du journal d’audit',
            description: 'Fichier dans lequel le journal d’audit des aperçus publics est écrit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Autoriser le journal d’audit de test',
            description: 'Pour le développement uniquement : accepte le journal d’audit de test en mémoire. Ignoré en production.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Limites de débit des aperçus publics',
            description: 'Profils de limitation de débit que les aperçus publics peuvent utiliser.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Contrôleur de limitation de débit',
            description: 'Comment les requêtes des aperçus publics sont limitées. Les aperçus publics en ont besoin.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Requêtes par fenêtre',
            description: 'Requêtes qu’un aperçu public autorise dans chaque fenêtre.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Fenêtre de limitation de débit',
            description: 'Durée de chaque fenêtre de limitation de débit, en millisecondes.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Autoriser le limiteur de test',
            description: 'Pour le développement uniquement : accepte le limiteur de débit de test en mémoire. Ignoré en production.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooks en cours',
            description: 'Nombre maximal de requêtes webhook que ce serveur traite en même temps.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Mémoire des webhooks',
            description: 'Mémoire maximale que les requêtes webhook en cours peuvent utiliser, en octets. Vide autorise ce que la limite de requêtes permet déjà.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks par minute et par route',
            description: 'Requêtes webhook par minute sur une route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhooks simultanés par route',
            description: 'Requêtes webhook en cours sur une route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks par minute et par endpoint',
            description: 'Requêtes webhook par minute sur un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhooks simultanés par endpoint',
            description: 'Requêtes webhook en cours sur un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks par minute et par personne',
            description: 'Requêtes webhook par minute pour une personne.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhooks simultanés par personne',
            description: 'Requêtes webhook en cours pour une personne.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Bundle d’écran de plugin maximal',
            description: 'Plus gros bundle d’écran de plugin que ce Home héberge, en octets.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Stockage des écrans de plugins par personne',
            description: 'Nombre maximal d’octets de bundles d’écrans de plugins qu’une personne peut stocker.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Ligne de données de plugin maximale',
            description: 'Plus grande ligne qu’un plugin stocke, en octets.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Lot de données de plugin maximal',
            description: 'Plus gros lot de modifications de données de plugin, en octets.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Lignes par lot de données de plugin',
            description: 'Nombre maximal de lignes dans un lot de modifications de données de plugin.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Lignes de données de plugin par personne',
            description: 'Nombre maximal de lignes de données de plugin qu’une personne peut stocker.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Stockage de données de plugin par personne',
            description: 'Nombre maximal d’octets de données de plugin qu’une personne peut stocker.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Débit binaire maximal de diffusion',
            description: 'Débit binaire maximal d’une diffusion en direct via ce Home, en bits par seconde.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Fréquence d’images maximale de diffusion',
            description: 'Fréquence d’images maximale d’une diffusion en direct via ce Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Image de diffusion maximale',
            description: 'Plus grande image d’une diffusion en direct via ce Home, en octets.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Diffusion en direct la plus longue',
            description: 'Durée maximale d’une diffusion en direct via ce Home, en millisecondes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Données par diffusion en direct',
            description: 'Nombre maximal d’octets qu’une diffusion en direct via ce Home transporte.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Diffusions simultanées par personne',
            description: 'Nombre maximal de diffusions en direct via ce Home qu’une personne mène en même temps.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Diffusions simultanées par connexion',
            description: 'Nombre maximal de diffusions en direct via ce Home qu’une connexion mène en même temps.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Diffusions simultanées par machine',
            description: 'Nombre maximal de diffusions en direct via ce Home qu’une machine mène en même temps.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID de la clé de signature des connexions',
            description: 'Nomme la clé qui signe les connexions entre machines. Sans clé de signature, ces connexions sont désactivées.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Clé privée de signature des connexions',
            description: 'Clé privée qui signe les connexions entre machines.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Clé publique de signature des connexions',
            description: 'Clé publique correspondant à la clé de signature. Si vide, elle est dérivée de la clé privée.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Expiration de la clé de signature',
            description: 'Date d’expiration de la clé de signature, sous forme d’horodatage en millisecondes.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Trouver des amis par nom d’utilisateur',
            description: 'Les personnes peuvent trouver des amis par nom d’utilisateur ainsi que par compte lié.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Fournisseur de correspondance des amis',
            description: 'Le fournisseur de connexion utilisé pour faire correspondre les amis.',
        },
    },
};

const homeFeatureTranslations = { fr } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const fr: typeof en = {
    title: 'Administration du Home',
    pages: {
        features: 'Ce que ce Home propose. Un changement s’applique partout à la prochaine actualisation.',
        data: 'Ce que ce Home conserve, et pendant combien de temps.',
        homes: 'Comptes, rôles, équipes et règles de connexion de chaque Home que vous administrez.',
        overview: 'Qui administre ce Home et ce que vous pouvez modifier ici.',
        people: 'Les comptes de ce Home, leurs rôles et s’ils peuvent se connecter.',
        policies: 'Qui peut se connecter, comment les comptes sont créés et comment les données sont protégées.',
        teams: 'Toutes les équipes de ce Home. Administrer une équipe ne donne pas accès à ses sessions.',
        identityProvider: 'Un service d’identité permettant de se connecter à ce Home.',
        identityProviderEditor: 'Comment ce service d’identité se connecte et qui il admet.',
        githubApp: 'Une GitHub App que ce Home utilise pour accéder aux dépôts.',
        githubAppEditor: 'Enregistrez ou modifiez une GitHub App pour ce Home.',
        email: 'Comment ce Home envoie des e-mails.',
        reach: 'Comment les appareils, les liens d’invitation et les e-mails trouvent ce Home.',
        runtime: 'Le serveur qui fait tourner ce Home.',
        activity: 'Qui a changé quoi sur ce Home, et quand.',
    },
    overview: 'Aperçu',
    people: 'Personnes',
    teams: 'Équipes',
    policies: 'Politiques',
    console: {
        serverSettings: 'Réglages du serveur',
        serverSettingsDescription: 'Chaque réglage lu par le serveur, et quand une modification s’applique.',
        allHomes: 'Tous les Homes',
        backToHomes: 'Retour aux Homes',
        viewerOwner: 'Vous êtes le propriétaire',
        viewerAdmin: 'Vous êtes administrateur',
        noOwnerYet: 'Pas encore de propriétaire',
        administer: 'Administrer',
        navigation: 'Pages d’administration du Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Qui gère ce Home, et ce qui demande votre attention.',
        attention: 'Demande votre attention',
        emailNotSetUpTitle: 'L’e-mail n’est pas configuré',
        emailNotSetUpBody: 'Personne ne peut vérifier son adresse, réinitialiser un mot de passe ni recevoir d’invitation par e-mail.',
        emailNoLinkTitle: 'Les e-mails ne peuvent pas encore contenir de liens',
        emailNoLinkBody: 'L’envoi est configuré, mais ce Home n’a pas d’adresse d’application web pour les liens.',
        emailPasswordTitle: 'Le mot de passe de messagerie est illisible',
        emailPasswordBody: 'Saisissez à nouveau le mot de passe SMTP pour que ce Home puisse envoyer des e-mails.',
        setUpEmail: 'Configurer l’e-mail',
        openEmail: 'Ouvrir E-mail',
        noAddressTitle: 'Aucune adresse publique',
        noAddressBody: 'Les appareils d’autres réseaux et les liens d’invitation ne peuvent pas joindre ce Home.',
        setUpReach: 'Configurer',
        githubPartlySetUp: 'La connexion GitHub est à moitié configurée',
        workosPartlySetUp: 'WorkOS est à moitié configuré',
        workosNeedsClientIdBody: 'Il lui faut un ID client avant que les équipes puissent connecter la connexion d’entreprise.',
        workosNeedsApiKeyBody: 'Il lui faut une clé d’API avant que les équipes puissent connecter la connexion d’entreprise.',
        githubNeedsClientIdBody: 'Il lui faut un ID client avant que l’on puisse se connecter avec GitHub.',
        githubNeedsClientSecretBody: 'Il lui faut un secret client avant que l’on puisse se connecter avec GitHub.',
        finish: 'Terminer',
        nameDescription: 'Affiché dans l’app et sur les invitations.',
        review: 'Voir',
        settingsFailed: 'Impossible de vérifier les réglages de ce Home',
        emailFailed: 'Impossible de lire l’état de la messagerie de ce Home',
        reachFailed: 'Impossible de lire comment ce Home est joint',
        ownership: 'Propriété',
        ownerYou: 'Propriétaire · vous',
        peopleFailed: 'Impossible de lire les personnes de ce Home',
        thisHome: 'Ce Home',
        version: 'Version',
        signIn: 'Connexion',
        signInOpen: 'tout le monde peut créer un compte',
        signInInvited: 'sur invitation uniquement',
        signInNone: 'Aucune méthode de connexion n’est active',
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'personne' : 'personnes'}`, `${owners} ${owners === 1 ? 'propriétaire' : 'propriétaires'}`, admins === null ? null : `${admins} ${admins === 1 ? 'admin' : 'admins'}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Inviter des personnes',
        description: 'On rejoint ce Home en rejoignant l’une de ses équipes.',
        team: 'Équipe',
        noTeams: 'Aucune équipe à laquelle vous pouvez inviter pour l’instant',
        noTeamsBody: 'On rejoint un Home en rejoignant une équipe. Créez-en une d’abord.',
        notAdministered: 'Vous ne pouvez pas inviter dans les équipes de ce Home',
        notAdministeredBody: 'Ce sont les propriétaires et admins de chaque équipe qui invitent. Demandez à l’un d’eux, ou créez votre propre équipe.',
        createTeam: 'Créer une équipe',
        notAdministeredAskBody: 'Ce sont les propriétaires et admins de chaque équipe qui invitent ; demandez à l’un d’eux.',
        joinByTeam: 'On rejoint un Home en rejoignant une équipe.',
        teamsFailed: 'Impossible de lire les équipes de ce Home',
    },

    yourRole: 'Votre rôle',
    roleOwner: 'Propriétaire',
    roleAdmin: 'Administrateur',
    roleMember: 'Membre',
    activeOwners: 'Propriétaires actifs',
    accountSection: 'Compte',
    accountAccessSection: 'Accès',
    homeAddress: 'Adresse du Home',

    setupRequiredTitle: 'Configuration de l’administration requise',
    setupRequiredBody: 'Ce Home n’a pas encore de propriétaire actif. Une personne ayant accès au serveur attribue le premier propriétaire depuis la machine qui l’exécute.',

    manageTeams: 'Gérer les équipes',
    manageTeamsSubtitle: 'Administrez les équipes de ce Home. Cela ne vous donne pas accès à leurs sessions.',
    teamsDisabled: 'Les équipes ne sont pas activées sur ce Home.',
    teamsEmpty: 'Aucune équipe sur ce Home pour l’instant.',

    loading: 'Chargement de ce Home…',
    refreshing: 'Actualisation…',
    updating: 'Mise à jour…',
    staleNotice: 'Affichage du dernier état connu de ce Home. Les modifications sont indisponibles jusqu’à sa réponse.',
    offlineNotice: 'Ce Home ne répond pas. Vous pouvez continuer à lire, mais pas modifier.',
    unavailableTitle: 'Ce Home est indisponible',
    unavailableBody: 'Happier n’a pas pu lire l’état d’administration de ce Home.',
    forbiddenTitle: 'Vous ne pouvez pas administrer ce Home',
    forbiddenBody: 'Votre compte n’a pas d’autorité d’administration ici.',
    retry: 'Réessayer',
    loadMore: 'Charger plus',
    unsupportedBody: 'Ce Home ne propose pas d’administration. Il exécute peut-être une version plus ancienne.',
    notObservedTitle: 'Pas encore chargé',
    notObservedBody: 'Ce Home n’a pas encore communiqué son état d’administration à cet appareil.',
    lastUpdated: ({ time }: { time: string }) => `Mis à jour ${time}`,

    chooseHome: 'Choisir un Home',
    chooseHomeFooter: 'Chaque Home a ses propres comptes, rôles et règles.',
    homesEmpty: 'Aucun Home pour l’instant',
    homesEmptyBody: 'Ajoutez un Home à cet appareil pour l’administrer ici.',
    homesNoneAdministrable: 'Aucun Home à administrer',
    homesNoneAdministrableBody: 'Aucun des Homes affichés ne donne d’autorité d’administration à ce compte.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} ne répond pas`,
    signedOutTitle: 'Déconnecté de ce Home',
    signedOutBody: 'Reconnectez-vous à ce Home pour l’administrer.',
    credentialUnreadableTitle: 'Impossible de lire la connexion enregistrée sur cet appareil',
    credentialUnreadableBody: 'Le problème vient de cet appareil, pas du Home, et tu n’as pas été déconnecté. Réessaie.',
    credentialUnreadableInviteBody: 'Le problème vient de cet appareil, pas du Home. Ton lien d’invitation fonctionne toujours : tu peux réessayer maintenant ou y revenir plus tard.',

    peopleEmpty: 'Aucun compte sur ce Home pour l’instant.',
    rosterUnavailableTitle: 'La liste des personnes n’est pas encore disponible',
    rosterUnavailableBody: 'Ce Home ne fournit pas encore sa liste de comptes à Happier. Les rôles et les états apparaîtront ici ensuite.',
    accountUnavailableBody: 'Ce compte n’est pas encore disponible depuis ce Home.',
    searchPlaceholder: 'Rechercher des comptes',
    searchResults: 'Résultats de recherche',
    searchResultsFooter: 'Ouvrez un compte pour voir son rôle et son état.',
    searchEmpty: 'Aucun compte ne correspond à cette recherche.',
    searchUnsupported: 'La recherche n’est pas disponible sur ce Home',
    searchUnsupportedBody: 'Ce Home ne propose pas de recherche de comptes. Il utilise peut-être une version plus ancienne.',
    searchFailed: 'La recherche n’a pas pu aboutir',
    searchFailedBody: 'Ce Home n’a pas répondu à la recherche. Modifiez le texte pour réessayer.',

    statusActive: 'Actif',
    statusDisabled: 'Désactivé',
    statusRetired: 'Retiré',
    statusDisabledDetail: 'Déconnecté partout. Peut être réactivé.',
    statusRetiredDetail: 'Accès révoqué définitivement.',

    changeRole: 'Changer le rôle',
    disable: 'Désactiver le compte',
    enable: 'Réactiver le compte',
    deleteAccount: 'Supprimer le compte et les données…',
    retryDeletion: 'Réessayer la suppression',

    reasonLastActiveOwner: 'Ce Home a besoin d’au moins un propriétaire actif. Nommez d’abord un autre propriétaire.',
    reasonTargetInactive: 'Seul un compte actif peut détenir un rôle sur le Home.',
    reasonHomeUnreachable: 'Ce Home ne répond pas. Les modifications seront possibles après la reconnexion.',

    roleSheetTitle: 'Rôle sur le Home',
    roleOwnerDescription: 'Peut tout administrer sur ce Home, y compris supprimer des comptes.',
    roleAdminDescription: 'Peut administrer les comptes et les équipes, mais pas changer les propriétaires.',
    roleMemberDescription: 'Aucune autorité d’administration sur le Home.',

    disableTitle: ({ account }: { account: string }) => `Désactiver ${account} ?`,
    disableBody: 'La personne sera déconnectée sur tous ses appareils et ses machines se déconnecteront. Les jetons d’accès personnels sont révoqués définitivement, la responsabilité des sessions est supprimée et, dans chaque session dont elle perd l’accès, ses brouillons non envoyés sont supprimés et son suivi est retiré. La réactivation rétablit l’accès, mais pas ces brouillons, ce suivi ni cette responsabilité. L’appartenance aux équipes et les clés de chiffrement sont conservées.',
    disableConfirm: 'Désactiver',
    enableTitle: ({ account }: { account: string }) => `Réactiver ${account} ?`,
    enableBody: 'La personne pourra se reconnecter sur ses appareils. Les jetons d’accès révoqués restent révoqués.',
    enableConfirm: 'Réactiver',
    deleteTitle: ({ account }: { account: string }) => `Supprimer ${account} et toutes ses données ?`,
    deleteBody: ({ home }: { home: string }) => `Cela supprime définitivement le compte et ses données sur ${home}. C’est irréversible. Toute propriété de Home ou d’équipe doit être transférée avant.`,
    deleteConfirm: 'Supprimer',

    deleteIncompleteTitle: 'La suppression n’est pas terminée',
    deleteIncompleteBody: 'L’accès a été révoqué et ce compte est maintenant retiré, mais le nettoyage n’est pas terminé. Réessayez la suppression pour la finir.',
    deleteIncompleteMemberBody: 'L’accès a été révoqué, mais le nettoyage n’est pas terminé. Un propriétaire du Home ou l’opérateur du serveur peut le finir.',

    errorForbidden: 'Vous n’avez plus l’autorité pour cette modification sur ce Home.',
    errorOwnerTransferRequired: 'Ce Home a besoin d’au moins un propriétaire actif. Nommez d’abord un autre propriétaire.',
    errorTeamOwnerTransferRequired: 'Une équipe a encore besoin de ce compte comme propriétaire. Donnez-lui d’abord un autre propriétaire.',
    errorAccountNotFound: 'Ce compte n’existe plus sur ce Home.',
    errorAccountInactive: 'Ce compte n’est pas actif et ne peut pas recevoir cette autorité.',
    errorErasureTransitionCleanupPending: 'La suppression du compte attend le nettoyage du chiffrement. Réessayez de supprimer le compte.',
    errorGeneric: 'Ce Home n’a pas pu appliquer la modification. Rien n’a été changé.',
    errorConflict: 'Autre chose a été modifié ici entre-temps. Actualisez ce Home et réessayez.',
    changeFailedTitle: 'La modification n’a pas abouti',
    errorOutcomeUnknownTitle: 'Cette modification n’a pas été confirmée',
    errorOutcomeUnknown: 'La requête a atteint ce Home, mais sa réponse a été perdue. Elle a peut-être été appliquée. Actualisez ce Home et vérifiez avant de réessayer.',

    teamCreation: 'Création d’équipes',
    teamCreationSelfService: 'Tout le monde peut créer des équipes',
    teamCreationSelfServiceDescription: 'Les membres actifs de ce Home peuvent créer une équipe et en devenir propriétaire.',
    teamCreationManagedOnly: 'Les administrateurs créent les équipes',
    teamCreationManagedOnlyDescription: 'Les propriétaires et administrateurs créent les équipes et choisissent le propriétaire initial.',
    teamCreationDisabled: 'Création d’équipes désactivée',
    teamCreationDisabledDescription: 'Aucune nouvelle équipe. Les équipes existantes sont inchangées.',
    teamCreationWho: 'Qui peut créer des équipes',
    teamCreationAnyone: 'Tout le monde',
    teamCreationAdmins: 'Admins',
    teamCreationNobody: 'Personne',
    teamsVisibility: 'Qui voit les équipes',
    teamsVisibleToMembers: 'Afficher les équipes aux membres',
    teamsVisibleToMembersDescription: 'Désactivé, seuls les membres d’une équipe et les administrateurs voient les équipes.',
    teamJit: 'Adhésion automatique à l’équipe à la connexion',
    teamJitDescription: 'Se connecter via le fournisseur d’identité relié à une équipe fait rejoindre cette équipe automatiquement, sans invitation ni approbation.',
    githubEnterpriseOrigins: 'Hôtes GitHub Enterprise approuvés',
    githubEnterpriseOriginsDescription: 'Une origine HTTPS canonique par ligne. Les équipes ne peuvent connecter les GitHub Apps qu’à ces hôtes.',
    githubEnterpriseOriginsInvalid: 'Utilisez des origines HTTPS uniques sans chemin, requête, identifiants ni fragment.',

    signInTitle: 'Connexion et admission',
    authActionLogin: 'Connexion',
    authActionProvision: 'Nouveaux comptes',
    authActionConnect: 'Liaison de comptes',
    authReasonMethodNotEnabled: 'La méthode de connexion est désactivée',
    authReasonProvisioningNotEnabled: 'La création de comptes est désactivée',
    authReasonAccountModeUnavailable: 'Le type de compte est indisponible',
    authReasonEmailDeliveryUnavailable: 'L’envoi d’e-mails est indisponible',
    authInherited: 'Valeurs du serveur utilisées',
    authInheritedDescription: 'Ce Home ne restreint pas les méthodes de connexion ni les types de compte.',
    authNarrowed: 'Restreint par ce Home',
    authUnreadable: 'La configuration nécessite votre attention',
    authUnreadableDescription: 'Ce Home stocke une configuration de connexion que cette version du serveur ne peut pas lire. La connexion reste indisponible jusqu’à ce que votre opérateur la répare.',
    signInMethods: 'Méthodes de connexion',
    accountModes: 'Types de compte',
    accountModePlain: 'Simple',
    accountModeE2ee: 'Chiffré de bout en bout',
    recommendedMode: 'Recommandé pour les nouveaux comptes',
    recommendedModeDescription: 'Définit la valeur par défaut des nouveaux comptes. Les comptes existants ne sont pas modifiés.',
    admissionSelfService: 'Tout le monde',
    admissionInvitationOnly: 'Sur invitation uniquement',
    admissionClosed: 'Personne',

    deploymentServices: 'Services du déploiement',
    deploymentServicesDescription: 'Services d’identité que l’opérateur configure pour ce serveur. Ils ne se modifient pas depuis l’administration du Home.',
    privateEndpoints: 'Points d’identité privés',
    privateEndpointsDescription: 'Autoriser la connexion gérée à joindre des fournisseurs d’identité sur des réseaux privés. Seuls les hôtes, réseaux et ports listés ici sont joignables.',
    privateEndpointsPublicOnly: 'Points publics uniquement',
    privateEndpointsAllowlist: 'Liste privée autorisée',
    privateEndpointsHostnames: 'Noms d’hôte autorisés',
    privateEndpointsCidrs: 'Réseaux autorisés (CIDR)',
    privateEndpointsPorts: 'Ports autorisés',
    privateEndpointsSave: 'Enregistrer la politique réseau',
    privateEndpointsInvalid: 'Indique au moins un nom d’hôte ou un réseau, et un port entre 1 et 65535.',
    privateEndpointsUnreadable: 'Ce Home enregistre une politique réseau que cette version du serveur ne peut pas lire. La connexion gérée reste sur des points publics.',

    policyReadOnly: 'Seul un propriétaire du Home peut modifier ceci.',
    policyEditingUnavailable: 'La modification des politiques n’est pas encore possible depuis cet appareil.',
    revisionConflictTitle: 'Cette politique a changé ailleurs',
    revisionConflictBody: 'Quelqu’un d’autre a enregistré une modification pendant votre édition. Votre choix est conservé — rechargez ce Home et appliquez-le à nouveau.',
    reload: 'Recharger',
    person: {
        you: 'vous',
        roleDescription: 'Les membres utilisent le Home ; les administrateurs gèrent aussi les personnes et les Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Passer ${account} en ${role} ?`,
        roleChangeBody: 'Son accès à ce Home change immédiatement. C’est enregistré dans l’activité avec votre nom.',
        roleChangeConfirm: 'Changer le rôle',
        signIn: 'Connexion',
        signInDescription: 'Ce avec quoi la personne peut se connecter. Elle le gère dans son propre compte.',
        methods: 'Méthodes',
        linkedProviders: 'Fournisseurs liés',
        none: 'Aucun',
        teams: 'Teams',
        noTeams: 'Dans aucun Team',
        teamArchived: 'Team archivé',
        teamSuspended: 'suspendu',
        access: 'Accès',
        accessDescription: 'Connectée sur ses appareils — les sessions ne sont pas suivies une à une.',
        machines: 'Machines',
        apiTokens: 'Jetons d’API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Dernière utilisation ${time}`,
        apiTokensNeverUsed: 'Jamais utilisé',
        signOutEverywhere: 'Déconnecter partout',
        signOutEverywhereDescription: 'Met fin à toutes les sessions ouvertes sur tous ses appareils. Les jetons d’API restent valides jusqu’à la désactivation du compte.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Déconnecter ${account} partout ?`,
        signOutEverywhereBody: 'Chaque appareil sur lequel la personne est connectée devra se reconnecter. Ses jetons d’API restent valides jusqu’à ce que vous désactiviez le compte. C’est enregistré dans l’activité avec votre nom.',
        signOutEverywhereDone: 'Déconnecté partout',
        recentActivity: 'Activité récente',
        noRecentActivity: 'Aucune modification d’administration la concernant pour l’instant.',
        showAllActivity: 'Tout afficher',
        disableOrDelete: 'Désactiver ou supprimer',
        dangerFootnote: 'Désactiver la déconnecte et arrête ses jetons d’API ; c’est réversible. Supprimer retire définitivement son compte et ses données de ce Home.',
    },
    email: {
        title: 'E-mail',
        status: 'État',
        sendingMail: 'Envoi d’e-mails',
        sendingReady: ({ host }: { host: string }) => `Prêt · envoie via ${host}`,
        sendingNotSetUp: 'Non configuré',
        links: 'Liens dans les e-mails',
        linksReady: 'S’ouvrent dans l’app web de ce Home',
        linksOpenAt: ({ host }: { host: string }) => `S’ouvrent sur ${host}`,
        setInReach: 'Définir dans Accès',
        linksMissing: 'Aucune adresse d’app web, les liens ne peuvent donc pas être créés',
        mailServer: 'Serveur de messagerie',
        mailServerDescription: 'Le serveur SMTP qui envoie les e-mails de vérification, de réinitialisation du mot de passe et d’invitation.',
        server: 'Serveur',
        port: 'Port',
        portAndSecurity: 'Port et sécurité',
        security: 'Sécurité de la connexion',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Nom d’utilisateur',
        password: 'Mot de passe',
        passwordDescription: 'Stocké chiffré sur le serveur. Il n’est plus jamais affiché.',
        saved: 'Enregistré',
        replace: 'Remplacer',
        clear: 'Effacer',
        keep: 'Conserver',
        clearPending: 'Le mot de passe enregistré sera supprimé à l’enregistrement.',
        valueSet: 'Défini',
        valueNotSet: 'Non défini',
        sender: 'Expéditeur',
        fromAddress: 'Adresse d’expédition',
        fromName: 'Nom de l’expéditeur',
        test: 'Envoyer un e-mail de test',
        testDescription: 'Envoie un court message sans lien.',
        testTo: 'À',
        testToPlaceholder: 'Une adresse que vous pouvez consulter',
        testSend: 'Envoyer',
        testSaveFirst: 'Enregistrez vos modifications avant d’envoyer un test.',
        testSent: ({ to }: { to: string }) => `Envoyé à ${to}`,
        testSentDetail: 'Vérifiez la boîte de réception, et le dossier spam s’il n’y est pas.',
        testFailed: 'Envoi impossible',
        testNotConfigured: 'L’e-mail n’est pas encore configuré.',
        testPasswordUnreadable: 'Le mot de passe enregistré est illisible. Saisissez-le à nouveau.',
        testRenderFailed: 'Le message de test n’a pas pu être préparé.',
        testTransportFailed: 'Le serveur de messagerie est injoignable ou a refusé le message.',
        adminTitle: 'Seuls les propriétaires peuvent modifier les réglages e-mail',
        adminBody: 'Vous les voyez parce que vous êtes admin de ce Home.',
        notSetUpTitle: 'L’e-mail n’est pas configuré',
        notSetUpBody: 'La réinitialisation des mots de passe, la vérification par e-mail et les invitations par e-mail sont désactivées tant qu’il ne l’est pas.',
        unreadableTitle: 'Le mot de passe enregistré est illisible',
        unreadableBody: 'Le secret maître du serveur a changé depuis l’enregistrement. Saisissez à nouveau le mot de passe.',
        invalidValue: 'Saisissez une valeur valide.',
        invalidPort: 'Utilisez un port de 1 à 65535.',
        invalidEmail: 'Saisissez une adresse e-mail.',
        conflictTitle: 'Les réglages e-mail ont changé ailleurs',
        conflictBody: 'Quelqu’un a enregistré une modification pendant que vous éditiez. Vos modifications sont conservées : vérifiez-les et enregistrez à nouveau.',
        loadFailed: 'Ce Home n’a pas renvoyé ses réglages e-mail.',
    },
    signInProviders: {
        title: 'Fournisseurs de connexion',
        description: 'Comment les gens se connectent à ce Home, et ce que ses équipes peuvent connecter.',
        ownersOnlyTitle: 'Seuls les propriétaires peuvent modifier les fournisseurs de connexion',
        ownersOnlyBody: 'Demandez à un propriétaire de ce Home d’ajouter ou de modifier les fournisseurs d’identité et les GitHub Apps.',
        fromDeploymentReadOnly: 'De votre déploiement · lecture seule',
        platformsDescriptionReadOnly: ({ home }: { home: string }) => `Les applications par lesquelles ${home} connecte les gens. Seuls les propriétaires de ${home} peuvent les modifier.`,
        fieldClientId: 'ID client',
        fieldClientSecret: 'Secret client',
        fieldApiKey: 'Clé d’API',
        workosClientIdHint: 'Dans WorkOS, sous Clés d’API.',
        githubClientIdHint: 'Sur la page des paramètres de votre application OAuth GitHub.',
        secretHintUnset: 'Stocké chiffré et plus jamais affiché.',
        secretHintSet: 'Stocké chiffré, jamais affiché.',
        neededWorkos: 'Nécessaire avant que les équipes puissent se connecter',
        neededGithub: 'Nécessaire avant de pouvoir activer la connexion GitHub',
        secretPlaceholder: 'Collez la clé',
        lockedFootnote: 'Les valeurs définies par votre déploiement ne peuvent être modifiées que là où le serveur s’exécute.',
        ignoredBannerTitle: 'Un réglage de connexion a été ignoré au dernier démarrage',
        showMe: 'Afficher',
        callbackAddress: 'Adresse de rappel',
        callbackAddressHint: 'Enregistrez-la dans l’application OAuth GitHub.',
        whoCanSignInGithub: 'Qui peut se connecter avec GitHub',
        companySignIn: 'Connexion d’entreprise',
        companySignInDescription: 'Les fournisseurs OpenID Connect avec lesquels les personnes et les équipes peuvent se connecter.',
        addProvider: 'Ajouter un fournisseur',
        privateEndpointsTitle: 'Points de terminaison privés',
        privateEndpointsPublicOnlyShort: 'Publics uniquement',
        privateEndpointsAllowlistShort: 'Liste autorisée',
        privateEndpointsPublicOnlyHint: 'Les fournisseurs doivent être à une adresse publique.',
        privateEndpointsAllowlistHint: 'Seuls les hôtes ci-dessous peuvent être privés.',
        platforms: 'Plateformes de connexion',
        platformsDescription: ({ home }: { home: string }) => `Les applications par lesquelles ${home} connecte les gens : GitHub pour tous, WorkOS pour la connexion d’entreprise de chaque équipe.`,
        githubSignIn: 'Connexion GitHub',
        githubPurpose: ({ home }: { home: string }) => `L’application OAuth GitHub avec laquelle les gens se connectent à ${home}. Activez ou désactivez la connexion GitHub dans Règles.`,
        workosPurpose: ({ home }: { home: string }) => `Permet à chaque équipe de ${home} de connecter sa propre connexion d’entreprise et son annuaire via WorkOS, depuis la page Authentification de l’équipe.`,
        notSetGithub: 'Non configurée · la connexion GitHub reste désactivée d’ici là',
        notSetWorkos: 'Non configuré · les équipes ne peuvent pas encore utiliser WorkOS',
        needsClientId: 'Il manque un ID client',
        needsClientSecret: 'Il manque un secret client',
        needsApiKey: 'Il manque une clé d’API',
        pendingSummaryWorkos: 'Enregistré · les équipes pourront se connecter après le prochain redémarrage',
        pendingSummaryGithub: 'Enregistré · utilisé après le prochain redémarrage',
        lockedSummary: 'Défini par votre déploiement',
        readyPartlyLocked: ({ setting }: { setting: string }) => `Prêt · ${setting} défini par votre déploiement`,
        readyWorkos: 'Prêt · les équipes peuvent s’y connecter',
        readyGithubOn: 'Prêt · les gens peuvent se connecter avec GitHub',
        readyGithubOff: 'Prêt · activez la connexion GitHub dans Règles',
        advanced: 'Avancé',
        appliesAfterRestart: 'Les modifications ici s’appliquent au redémarrage du serveur.',
        privateEndpointsOffHere: 'Désactivé pour ce Home',
        teamRules: 'Règles de connexion des Teams',
        teamRulesDescription: 'Ce que les Teams peuvent ajouter aux fournisseurs du Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `a ajouté le fournisseur d’identité ${name}`,
            changedProvider: ({ name }: { name: string }) => `a modifié le fournisseur d’identité ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `a remplacé le secret client de ${name}`,
            enabledProvider: ({ name }: { name: string }) => `a activé ${name}`,
            disabledProvider: ({ name }: { name: string }) => `a désactivé ${name}`,
            removedProvider: ({ name }: { name: string }) => `a supprimé le fournisseur d’identité ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `a ajouté la GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `a modifié la GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `a remplacé les secrets de la GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `a vérifié ${name} sur ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `a retiré ${name} de ${organization}`,
        },
    },
    reach: {
        title: 'Accès',
        diagramTitle: ({ home }: { home: string }) => `Comment un nouvel appareil atteint ${home}`,
        yourDevices: 'Vos appareils',
        noAddress: 'Aucune adresse publique',
        plusDirect: '+ direct (Iroh) si possible',
        noDirect: 'Pas de connexions directes',
        thisComputer: 'Cet ordinateur',
        homeServer: 'Serveur de ce Home',
        diagramDeployment: 'Fixée par votre déploiement',
        diagramHere: 'Définie ici',
        diagramInferred: ({ method }: { method: string }) => `${method} · déduite`,
        addresses: 'Adresses',
        addressesDescription: 'Changer une adresse ne déconnecte jamais personne.',
        publicAddress: 'Adresse publique',
        webAppAddress: 'Adresse de l’app web',
        accessMethod: 'Méthode d’accès',
        publicAddressHome: 'Définie ici',
        publicAddressNone: 'Non définie. Les appareils d’autres réseaux ne peuvent pas atteindre ce Home.',
        inferredFrom: ({ method }: { method: string }) => `Déduite de ${method} sur l’ordinateur qui héberge ce Home`,
        inferredFromHost: 'Déduite sur l’ordinateur qui héberge ce Home',
        webAppDescription: 'Les liens des e-mails et invitations s’ouvrent ici.',
        webAppServed: 'Les liens s’ouvrent dans l’app web que sert ce Home.',
        webAppDefault: 'Les liens s’ouvrent dans l’app web Happier. Par défaut',
        change: 'Modifier',
        setAddress: 'Définir l’adresse',
        httpsRequired: 'Utilisez une adresse https://.',
        invalidAddress: 'Saisissez une adresse complète, comme https://home.example.com.',
        conflict: 'Les réglages de ce Home ont changé. Réessayez.',
        methodLocalOnly: 'Cet ordinateur uniquement',
        methodLan: 'Réseau local',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Comment cet ordinateur expose le Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Se règle sur ${host}. Ouvrez-le dans Hôtes distants.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Se règle sur l’ordinateur qui héberge ce Home (${host}). Ouvrez Happier dessus ou ajoutez-le comme hôte distant.`,
        accessMethodElsewhere: 'Se règle sur l’ordinateur qui héberge ce Home. Ouvrez Happier dessus ou ajoutez-le comme hôte distant.',
        accessMethodDeployment: 'Géré par votre déploiement.',
        directConnections: 'Connexions directes',
        directConnectionsDescription: 'Les appareils se connectent directement à ce Home quand ils le peuvent, sinon ils passent par l’adresse publique.',
        directConnectionsRow: 'Connexions directes (Iroh)',
        irohActive: 'Actives · les appareils se connectent en pair-à-pair quand ils le peuvent',
        irohStarting: 'Démarrage…',
        irohOff: 'Désactivées · les appareils passent par l’adresse publique',
        irohFailed: 'Ne fonctionne pas sur cet ordinateur. Les appareils passent par l’adresse publique.',
        irohNotAvailable: 'Indisponible sur ce déploiement. Les appareils passent par l’adresse publique.',
        irohNeedsAddressHint: 'Définissez une adresse publique avant de les désactiver',
        irohOffTitle: 'Désactiver les connexions directes ?',
        irohOffBody: 'Les appareils passeront uniquement par l’adresse publique. L’identité de connexion directe actuelle de ce Home est retirée définitivement ; la réactiver en crée une nouvelle, que les appareils adoptent à leur prochaine connexion. L’adresse publique et les connexions de chacun restent les mêmes.',
        irohOffConfirm: 'Désactiver',
        irohNeedsAddressTitle: 'Définissez d’abord une adresse publique',
        irohNeedsAddressBody: 'Sans adresse publique, les appareils ne pourraient plus atteindre ce Home une fois les connexions directes désactivées.',
        relay: 'Relais des connexions directes',
        relayAutomatic: 'Automatique',
        relayOff: 'Désactivé',
        relayCustom: ({ count }: { count: number }) => `Vos relais (${count}) · S’applique après redémarrage`,
        appliesAfterRestart: 'S’applique après redémarrage',
        appliesAfterRestartPending: 'S’applique après redémarrage · En attente',
        exposureInternetTitle: ({ method }: { method: string }) => `Accessible depuis Internet via ${method}`,
        exposureAddressTitle: 'Votre adresse publique est ouverte aux inscriptions',
        exposureOpenSignup: 'Toute personne qui atteint ce Home peut créer un compte. Vérifiez qui peut s’inscrire dans Règles.',
        exposureInvitationOnly: 'Les nouveaux comptes nécessitent une invitation : les inconnus ne peuvent pas s’inscrire.',
        loadFailed: 'Impossible de charger l’accès à ce Home.',
    },
    runtime: {
        title: 'Exécution',
        version: 'Version',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Ce Home n’indique pas sa version',
        flavorLight: 'Serveur léger',
        flavorFull: 'Serveur complet',
        server: 'Serveur',
        restart: 'Redémarrer',
        restartNow: 'Redémarrer maintenant',
        restartFailed: 'Impossible de redémarrer le serveur',
        waitingForHome: 'Redémarrage en cours, en attendant que le Home soit à nouveau disponible.',
        restartToApply: 'Redémarrez le serveur pour les appliquer.',
        restartFromDeployment: 'Redémarrez depuis votre déploiement pour les appliquer.',
        restartFromHost: ({ host }: { host: string }) => `Redémarrez depuis ${host}, l’ordinateur qui héberge ce Home.`,
        restartFromHostingComputer: 'Redémarrez depuis l’ordinateur qui héberge ce Home.',
        managedFrom: ({ host }: { host: string }) => `Géré depuis ${host}`,
        managedFromBody: 'Ouvrez Happier sur l’ordinateur qui héberge ce Home pour le mettre à jour, le redémarrer ou l’arrêter.',
        managedElsewhere: 'Géré depuis l’ordinateur qui héberge ce Home',
        deploymentTitle: 'Géré par votre déploiement',
        deploymentBody: 'Les mises à jour, redémarrages et sauvegardes de ce serveur sont gérés par qui le déploie.',
        backups: 'Sauvegardes',
        backupsHere: 'Sauvegardez, restaurez ou déplacez ce Home depuis sa page Exécution.',
        backupsFromHost: ({ host }: { host: string }) => `Sauvegardez depuis ${host}, l’ordinateur qui héberge ce Home.`,
        backupsFromHostingComputer: 'Sauvegardez depuis l’ordinateur qui héberge ce Home.',
        backupsDeployment: 'Les sauvegardes sont gérées par votre déploiement.',
        hostedHere: ({ home }: { home: string }) => `Cet ordinateur héberge ${home}`,
        hostedHereSubtitle: 'Mettez-le à jour, redémarrez-le, sauvegardez-le et déplacez-le depuis sa console Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 modification s’applique après redémarrage' : `${count} modifications s’appliquent après redémarrage`),
    },
    activity: {
        title: 'Activité',
        emptyTitle: 'Aucune activité pour l’instant',
        emptyBody: 'Les changements de connexion, d’e-mail, de personnes, de politiques et de propriété apparaissent ici au fur et à mesure.',
        showOlder: 'Afficher les plus anciennes',
        footnote: 'Les actions effectuées avec Happier directement sur l’ordinateur hôte, comme les sauvegardes et les redémarrages, ne sont pas listées.',
        loadFailed: 'Ce Home n’a pas renvoyé son activité.',
        deploymentCommand: 'Commande de déploiement',
        personalHomeSetup: 'Configuration du Personal Home',
        someone: 'Quelqu’un',
        removedAccount: 'un compte supprimé',
        claimed: 'a revendiqué la propriété de ce Home',
        madeOwner: ({ target }: { target: string }) => `a fait de ${target} un propriétaire`,
        assignedOwner: 'a désigné le premier propriétaire',
        changedPolicies: 'a modifié les politiques',
        changedEmailSetting: 'a mis à jour les réglages e-mail',
        changedServerSetting: 'a modifié les réglages du serveur',
        changedRole: ({ target }: { target: string }) => `a changé le rôle de ${target}`,
        disabled: ({ target }: { target: string }) => `a désactivé ${target}`,
        reenabled: ({ target }: { target: string }) => `a réactivé ${target}`,
        changedStatus: ({ target }: { target: string }) => `a changé le statut de ${target}`,
        deleted: ({ target }: { target: string }) => `a supprimé ${target}`,
        deletionStarted: ({ target }: { target: string }) => `a commencé à supprimer ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `a déconnecté ${target} partout`,
        areaOwnership: 'Propriété',
        areaPolicies: 'Politiques',
        areaEmail: 'E-mail',
        areaServerSettings: 'Réglages du serveur',
        areaPeople: 'Personnes',
        fieldRole: 'Rôle',
        fieldStatus: 'Statut',
        fieldTeamProviders: 'Fournisseurs de connexion des Teams',
        valueEmpty: '—',
        valueChanged: 'modifié',
        valueOn: 'Activé',
        valueOff: 'Désactivé',
        secretSet: 'défini',
        secretUnset: 'non défini',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Comment on se connecte à ${home}. Au moins une méthode reste active, et personne ne perd son dernier accès.`,
        methodUnavailable: 'Indisponible — votre déploiement ne peut pas la proposer',
        needsGithubApp: 'Il faut d’abord une application de connexion GitHub.',
        needsWorkos: 'Il faut d’abord configurer WorkOS.',
        setUp: 'Configurer',
        signInService: 'Service de connexion du Home',
        signInServiceDescription: 'Se connecter via le service de connexion propre à ce Home.',
        admissionTitle: 'Qui peut créer un compte',
        newAccounts: 'Nouveaux comptes',
        admissionAnyoneDescription: 'Toute personne pouvant joindre ce Home',
        admissionInvitationDescription: 'Seulement les personnes invitées dans une équipe',
        admissionNobodyDescription: 'Personne ne peut créer de compte',
        anonymousSignup: 'Inscription anonyme',
        anonymousSignupDescription: 'Créer un compte avec seulement une clé de récupération, sans e-mail.',
        encryptionTitle: 'Chiffrement',
        encryptionDescription: 'S’applique aux comptes et sessions créés à partir de maintenant. Les existants ne changent jamais.',
        storagePolicy: 'Politique de stockage',
        storageRequired: 'E2EE obligatoire',
        storageOptional: 'Facultatif',
        storagePlaintext: 'Texte clair uniquement',
        storageRequiredDescription: 'Chaque compte garde le chiffrement de bout en bout',
        storageOptionalDescription: 'Chaque compte choisit de chiffrer ou non',
        storagePlaintextDescription: 'Les comptes stockent leurs données sans chiffrement de bout en bout',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `S’applique après un redémarrage · ${running} d’ici là`,
        allowE2ee: 'Comptes chiffrés de bout en bout',
        allowPlain: 'Comptes sans chiffrement de bout en bout',
        recommendedInherited: 'Valeur du serveur',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Ce changement laisse entrer plus de monde et doit être confirmé. Rien n’a été modifié.',
        widening: {
            titleAnyone: 'Laisser tout le monde créer un compte ?',
            titleInvited: 'Laisser les personnes invitées créer un compte ?',
            titleMethod: ({ method }: { method: string }) => `Activer ${method} ?`,
            titleAnonymous: 'Autoriser l’inscription anonyme ?',
            titleUnencrypted: 'Autoriser le stockage non chiffré ?',
            titleOther: 'Laisser entrer plus de monde ?',
            exposureAnyone: ({ host }: { host: string }) => `Toute personne qui peut joindre ce Home à ${host} pourra s’inscrire sans invitation.`,
            exposureInvited: ({ host }: { host: string }) => `Toute personne invitée qui peut joindre ce Home à ${host} pourra créer un compte.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Toute personne qui peut joindre ce Home à ${host} pourra se connecter avec ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Toute personne qui peut joindre ce Home à ${host} pourra créer un compte avec seulement une clé de récupération.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Toute personne qui peut joindre ce Home à ${host} pourra y conserver ses données sans chiffrement de bout en bout.`,
            exposureOther: ({ host }: { host: string }) => `Toute personne qui peut joindre ce Home à ${host} pourra se connecter ou rejoindre selon les règles élargies.`,
            unchanged: 'Les comptes et invitations existants ne changent pas.',
            recorded: 'Le changement est enregistré dans l’Activité avec votre nom.',
            confirmAnyone: 'Laisser tout le monde s’inscrire',
            confirmInvited: 'Autoriser les invitations',
            confirmMethod: ({ method }: { method: string }) => `Activer ${method}`,
            confirmAnonymous: 'Autoriser l’inscription anonyme',
            confirmUnencrypted: 'Autoriser le stockage non chiffré',
            confirmOther: 'Appliquer le changement',
        },
    },
    claim: {
        pageDescription: 'Revendiquez la propriété de ce Home.',
        emptyTitle: 'Ce Home n’a pas encore de propriétaire',
        emptyBody: 'Un propriétaire gère la connexion, l’e-mail, l’accès et les personnes. Tant que personne ne le revendique, personne ne peut administrer ce Home.',
        codeTitle: 'Revendiquer avec un code à usage unique',
        codeDescription: 'Une personne ayant accès au serveur affiche un code. Il fonctionne une fois et expire après 15 minutes.',
        printStep: '1 · Afficher un code sur le serveur',
        pasteStep: '2 · Le coller ici',
        codeLabel: 'Code de revendication',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Revendiquer',
        refused: 'Ce code n’a pas fonctionné. Il est peut-être mal saisi, déjà utilisé ou expiré — affichez-en un nouveau.',
        hostTitle: ({ home }: { home: string }) => `Cet ordinateur héberge ${home}`,
        hostBody: 'Vous pouvez faire de votre compte son propriétaire depuis ici. Seul cet ordinateur peut le faire de cette façon.',
        makeOwner: 'Devenir propriétaire',
        hostFailed: 'Cet ordinateur n’a pas pu faire de vous le propriétaire. Réessayez.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Fixé par votre déploiement · ${key}`,
    fixedByDeploymentLead: 'Fixé par votre déploiement',
    deploymentNotSetLead: 'Indisponible tant que votre déploiement ne définit pas',
    features: {
        title: 'Fonctionnalités',
        common: 'Courantes',
        advanced: 'Avancées',
        advancedDescription: ({ count }: { count: number }) => `${count} de plus, regroupées par domaine.`,
        other: 'Autres',
        familyCount_one: '1 fonctionnalité',
        familyCount_other: ({ count }: { count: number }) => `${count} fonctionnalités`,
        offHome: 'Désactivée pour ce Home.',
        notInBuild: 'Non incluse dans cette version.',
        needs: ({ feature }: { feature: string }) => `Nécessite ${feature}.`,
        unavailable: 'Indisponible sur ce Home.',
        noHomeSwitchOn: 'Toujours activée sur ce Home · seule la version de Happier peut la désactiver',
        noHomeSwitchOff: 'Désactivée sur ce Home · seule la version de Happier peut l’activer',
        unavailableByDeployment: 'Indisponible sur ce Home · la configuration de ton déploiement en décide',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Désactiver ${feature} désactive aussi 1 fonctionnalité`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Désactiver ${feature} désactive aussi ${count} fonctionnalités`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} nécessite ${parent}.`,
        turnOff: 'Désactiver',
        deviceTitle: 'Fonctionnalités de cet appareil',
        deviceBody: 'Les fonctionnalités qui ne concernent que cet appareil sont dans les Réglages.',
        adminTitle: 'Seuls les propriétaires peuvent modifier les fonctionnalités',
        adminBody: 'Vous voyez ce que propose ce Home parce que vous en êtes admin.',
        loadFailed: 'Ce Home n’a pas renvoyé ses fonctionnalités.',
        conflictTitle: 'Fonctionnalités modifiées ailleurs',
        conflictBody: 'Quelqu’un a modifié les réglages de ce Home pendant que vous les consultiez. La page affiche maintenant ce que le Home contient.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} ou plus`,
        rangeAtMost: ({ max }: { max: number }) => `Jusqu’à ${max}`,
        limitInvalid: 'Saisissez un nombre dans la plage.',
        appliesAfterRestart: 'S’applique après un redémarrage',
        onAfterRestart: 'Activée après redémarrage',
        offAfterRestart: 'Désactivée après redémarrage',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Ignoré au dernier démarrage : ${reason}`,
        ignoredInvalidType: 'la valeur enregistrée n’a pas le bon type',
        ignoredOutOfBounds: 'la valeur enregistrée est hors limites',
        ignoredSecretUnreadable: 'le secret enregistré est illisible',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Après le prochain redémarrage, désactiver ${feature} désactive aussi 1 fonctionnalité`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Après le prochain redémarrage, désactiver ${feature} désactive aussi ${count} fonctionnalités`,
    },
    data: {
        title: 'Données',
        deletion: 'Suppression automatique',
        deletionDescription: 'Les changements s’appliquent dès le prochain nettoyage.',
        dryRunMode: 'Mode simulation',
        dryRunModeDescription: 'Le nettoyage compte au lieu de supprimer jusqu’à ce que vous désactiviez ceci.',
        tryRules: 'Tester les règles actuelles',
        tryRulesDescription: 'Lance un nettoyage maintenant sans rien supprimer.',
        runDryRun: 'Lancer une simulation',
        runAgain: 'Relancer',
        ranAt: ({ time }: { time: string }) => `Lancée à ${time} · rien n’a été supprimé`,
        sweepInProgress: 'Un nettoyage est en cours — réessayez quand il sera terminé.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Supprimerait ${count} · ${examined} examinés`,
        nothingToDelete: 'Rien à supprimer',
        stopTimeBudget: 'arrêté : budget de temps',
        stopRowBudget: 'arrêté : limite de suppression',
        stopCandidateBudget: 'arrêté : limite d’examen',
        stopStalled: 'arrêté : aucun progrès',
        keep: 'Conserver',
        deleteAfter: 'Supprimer après',
        days: 'jours',
        daysFor: ({ domain }: { domain: string }) => `Jours de conservation de ${domain}`,
        daysRequired: 'Indiquez le nombre de jours.',
        daysInvalid: 'Utilisez un nombre entier de jours, 1 ou plus.',
        defaultEffect: ({ effect }: { effect: string }) => `Par défaut · ${effect}`,
        alwaysRuns: 'S’exécute même quand la suppression automatique est désactivée.',
        expiresAutomatically: 'Expire automatiquement',
        systemRecords: 'Enregistrements système',
        systemRecordsSummary_one: '1 type d’enregistrement que ce Home garde pour lui-même',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} types d’enregistrements que ce Home garde pour lui-même`,
        adminTitle: 'Seuls les propriétaires peuvent modifier ce que ce Home conserve',
        adminBody: 'Vous voyez les règles parce que vous en êtes admin.',
        loadFailed: 'Ce Home n’a pas renvoyé ses réglages de données.',
        conflictTitle: 'Réglages de données modifiés ailleurs',
        conflictBody: 'Quelqu’un a modifié les réglages de ce Home pendant que vous les consultiez. La page affiche maintenant ce que le Home contient.',
    },
};

const homeGovernanceTranslations = { fr } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { fr: {
        greetingMorning: ({ name }) => `Bonjour, ${name}`,
        greetingAfternoon: ({ name }) => `Bon après-midi, ${name}`,
        greetingEvening: ({ name }) => `Bonsoir, ${name}`,
        greetingMorningAnonymous: 'Bonjour',
        greetingAfternoonAnonymous: 'Bon après-midi',
        greetingEveningAnonymous: 'Bonsoir',
        sessionsWorking: ({ count }) => (count === 1 ? '1 session en cours' : `${count} sessions en cours`),
        sessionsNeedYou: ({ count }) => `${count} attend${count === 1 ? '' : 'ent'} votre réponse`,
        sessionsAwaitingResponse: ({ count }) => count === 1 ? '1 session attend votre réponse' : `${count} sessions attendent votre réponse`,
        nothingRunning: 'Rien en cours pour l’instant',
        customize: 'Personnaliser',
        customizeTitle: 'Personnaliser l’accueil',
        customizeDescription: 'Glissez pour réorganiser. Enregistré dans votre compte : chaque appareil affiche le même accueil.',
        customizing: "Personnalisation de l’accueil",
        customizingHint: "Faites glisser des widgets dans, hors et entre les groupes",
        sections: "Sections",
        newRow: "Déposez ici pour commencer une nouvelle ligne",
        newRowVerb: "Déplacer vers une nouvelle ligne",
        addWidget: "Ajouter un widget",
        reset: 'Réinitialiser',
        alwaysShown: 'Toujours affiché',
        builtIn: 'Intégré',
        startDescription: 'Zone de saisie et suggestions',
        attentionDescription: 'Affiché quand quelque chose vous attend',
        machinesDescription: 'Intégré · une grille de vos machines',
        hiddenSetupSteps: 'Étapes de configuration masquées',
        showAgain: ({ count }) => `${count} · Afficher à nouveau`,
        reorderHandle: ({ section }) => `Réorganiser ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "fr">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const fr: typeof en = {
    page: {
        title: 'Réglages du serveur',
        description: "Chaque réglage lu par le serveur qui n'a pas sa propre page.",
        searchPlaceholder: "Rechercher des réglages ou des clés d'environnement",
        changed: 'Modifié',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Afficher uniquement le réglage modifié' : `Afficher uniquement les ${count} réglages modifiés`),
        noMatches: 'Aucun réglage ne correspond à cette recherche.',
        noChanges: "Aucun réglage n'est modifié par rapport à sa valeur par défaut sur ce Home.",
        filterLabel: 'Afficher',
        filterAll: 'Tous les réglages',
        filterChanged: ({ count }: { count: number }) => `Modifiés · ${count}`,
        more: 'Plus',
        readOnlyTitle: 'Lecture seule au démarrage',
        readOnlyDescription: "Le serveur a besoin de ces réglages avant de pouvoir lire un réglage enregistré, donc ils sont définis là où il s'exécute.",
        note: "Les réglages s'appliquent dès que vous les modifiez, sauf s'ils sont marqués \"S'applique après redémarrage\". En attente signifie que la valeur enregistrée diffère de celle avec laquelle le serveur a démarré. Chaque modification est enregistrée dans Activité ; les valeurs secrètes jamais.",
        adminTitle: 'Seuls les propriétaires modifient les réglages du serveur',
        adminBody: "Vous voyez chaque réglage et d'où vient sa valeur.",
        loadFailed: "Les réglages du serveur n'ont pas pu être chargés.",
        saveFailed: "Le réglage n'a pas été enregistré.",
        conflictTitle: 'Les réglages ont changé ailleurs',
        conflictBody: "Quelqu'un a changé les réglages de ce Home pendant que vous les modifiiez. La page affiche maintenant ses valeurs ; votre modification est toujours dans son champ.",
    },
    row: {
        appliesAfterRestart: "S'applique après redémarrage",
        pending: 'En attente',
        defaultValue: ({ value }: { value: string }) => `Par défaut : ${value}`,
        runningWith: ({ value }: { value: string }) => `s'exécute avec ${value} depuis le dernier démarrage`,
        runningWithout: "s'exécute sans lui depuis le dernier démarrage",
        ignored: ({ reason }: { reason: string }) => `Ignoré au dernier démarrage : ${reason}`,
        runningOn: ({ value }: { value: string }) => `s'exécute sur ${value}`,
        notSet: 'Non défini',
        outOfBounds: ({ bounds }: { bounds: string }) => `Doit être ${bounds}`,
        invalid: "Cette valeur n'est pas valide ici",
        storedEncrypted: 'stocké chiffré, jamais affiché',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '1 de plus' : `${count} de plus`),
        discard: 'Abandonner',
        discarded: 'Modifications en attente abandonnées',
        ignoredTitle: 'Un réglage a été ignoré au dernier démarrage',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} réglages ont été ignorés au dernier démarrage`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting} : ${reason}. Le serveur a démarré sans lui.`,
        fix: 'Corriger',
    },
    readOnly: {
        before_database: "Lu avant l'ouverture de la base de données",
        per_process_identity: 'Diffère pour chaque processus serveur',
        invariant: 'Protège la connexion et les limites de build, donc ne peut pas être modifié ici',
        other: "Défini là où le serveur s'exécute",
        set: 'Défini',
    },
    secret: {
        saved: 'Enregistrée',
        replace: 'Remplacer',
        clear: 'Effacer',
        keep: 'Conserver',
        clearPending: "La valeur enregistrée sera supprimée à l'enregistrement.",
        valueSet: 'Définie',
        valueNotSet: 'Non définie',
        setAction: 'Définir',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 réglage · par défaut' : `${count} réglages · par défaut`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} réglages · ${changed} modifiés`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'octets',
        megabytes: 'Mo',
    },
    activity: {
        discarded: 'A abandonné un réglage serveur en attente',
    },
    choices: {
        hosted_happier_relay: 'Relais Happier',
        direct_apns: 'Push Apple',
        background_wake_best_effort: 'Réveil en arrière-plan',
        local_only: 'Cet appareil uniquement',
        disabled: 'Désactivé',
        enabled: 'Activé',
        automatic: 'Automatique',
        sandbox: 'Bac à sable',
        production: 'Production',
        owner: 'Propriétaires du serveur',
        authenticated: 'Toute personne connectée',
        self: 'Ce serveur',
        external: 'Service externe',
        '0': 'Désactivé',
        '1': 'Activé',
        any: 'N’importe laquelle',
        all: 'Toutes',
        github_app: 'GitHub App',
        oauth_user_token: 'Jeton de la personne',
        light: 'Léger',
        full: 'Complet',
        api: 'API uniquement',
        worker: 'Worker uniquement',
        fatal: 'Fatal',
        error: 'Erreurs',
        warn: 'Avertissements',
        info: 'Infos',
        debug: 'Débogage',
        trace: 'Trace',
        silent: 'Silencieux',
        manual: 'Manuel',
        default: 'Valeur du serveur',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route} : requêtes par fenêtre`,
        window: ({ route }: { route: string }) => `${route} : fenêtre`,
    },
    groups: {
        api: 'API et réseau',
        storage: 'Stockage et fichiers',
        monitoring: 'Surveillance',
        process: 'Processus',
        ui: "Diffusion de l'app web",
        realtime: 'Présence et sockets',
        retentionCaps: 'Plafonds de ressources de conservation',
        rpc: 'Appels aux machines',
        liveActivity: 'Live Activities',
        voice: 'Voix',
        connectedServices: 'Services connectés',
        localServices: 'Services locaux',
        plugins: 'Plugins',
        reviews: 'Revues',
        bugReports: 'Rapports de bug',
        releases: 'Versions publiées',
        authCaches: 'Caches de connexion',
        limits: 'Limites',
        rateLimits: 'Limites de débit par route',
        github: 'Connexion GitHub',
        oauth: 'Connexion OAuth',
        oidc: 'Fournisseurs OIDC de la configuration',
        workos: 'WorkOS',
        signInRequests: 'Demandes de connexion',
        offboarding: 'Départ de compte',
        friends: 'Amis',
        accountService: 'Service de compte',
        devices: 'Appareils',
        diagnostics: 'Diagnostic',
        reachInference: "Détection d'adresse",
        addresses: 'Adresses',
        other: 'Autres',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nom du Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Mises à jour en arrière-plan',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Mode de livraison',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Basculer vers un autre mode',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Fenêtre de déduplication des mises à jour',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Notifications de réveil en arrière-plan',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Délai minimal entre les notifications de réveil',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'Le build widgets reçoit les notifications',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: "Échecs avant l'abandon d'un appareil",
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Environnement push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: "ID d'équipe Apple",
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID de clé push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Clé de signature push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Fichier de clé de signature push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: "ID de bundle d'app autorisés",
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Noms de Live Activity autorisés',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: "Délai d'attente des requêtes push Apple",
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Délai de reconnexion push Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Utiliser un relais hébergé',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Adresse du relais hébergé',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: "Clé d'accès du relais hébergé",
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Agir comme relais hébergé',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: "Clés d'accès du relais pour d'autres serveurs",
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: "Tolérance d'horloge du relais",
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Mémoire des doublons du relais',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Taille du cache des doublons du relais',
        ELEVENLABS_API_KEY: 'Clé API ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agent ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Agent de production ElevenLabs',
        ELEVENLABS_API_BASE_URL: 'Adresse API ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Clé secrète RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Sessions vocales gratuites par mois',
        VOICE_FREE_MINUTES_PER_MONTH: 'Minutes vocales gratuites par mois',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Sessions vocales simultanées',
        VOICE_MAX_SESSION_SECONDS: 'Session vocale la plus longue',
        VOICE_MAX_MINUTES_PER_DAY: 'Minutes vocales par jour',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "Rétro-remplissage de l'identité vocale",
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Taille de lot du rétro-remplissage',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Budget de temps du rétro-remplissage',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pause entre les lots de rétro-remplissage',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Délai entre les exécutions de rétro-remplissage',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'ID client OAuth OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Point de terminaison de jeton OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: "ID client OAuth de l'abonnement Claude",
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: "Point de terminaison de jeton de l'abonnement Claude",
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: "Délai d'expiration de l'échange de jeton",
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Plus grand identifiant stocké',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Bail de renouvellement le plus long',
        VENDOR_TOKEN_MAX_LEN: 'Plus grand jeton fournisseur',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: "Secret du jeton d'aperçu",
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: "Secret du jeton d'aperçu privé",
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: "Secret du jeton d'aperçu public",
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: "Origine de l'interface des plugins",
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: "Durée de vie de la preuve d'éditeur",
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: "Tolérance d'horloge de la preuve d'éditeur",
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Durée de vie de la preuve de revue',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: "Tolérance d'horloge de la preuve de revue",
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Inclure les journaux du serveur',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Qui peut lire les journaux du serveur',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Fichier de journal du serveur',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Taille de journal incluse',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Canal de publication',
        HAPPIER_GITHUB_REPO: 'Dépôt de publication',
        AUTH_OFFBOARDING_ENABLED: "Revérifier l'éligibilité à la connexion",
        AUTH_OFFBOARDING_STRICT: "Refuser en cas d'échec d'une revérification",
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Délai entre les revérifications',
        AUTH_PROVIDERS_CONFIG_PATH: 'Fichier des fournisseurs',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON des fournisseurs',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Service de connexion',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Adresse du service de compte',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identité du service de compte',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nom du service de compte',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Comptes propriétaires du serveur',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Les nouveaux appareils nécessitent une approbation',
        GITHUB_CLIENT_ID: 'ID client OAuth GitHub',
        GITHUB_CLIENT_SECRET: 'Secret client OAuth GitHub',
        GITHUB_REDIRECT_URL: 'Adresse de rappel GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: "Délai d'attente des requêtes GitHub",
        GITHUB_STORE_ACCESS_TOKEN: "Conserver le jeton d'accès GitHub",
        OAUTH_PENDING_TTL_SECONDS: 'Durée de vie de la connexion en attente',
        OAUTH_STATE_TTL_SECONDS: "Durée de vie de l'état OAuth",
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: "Schémas de retour d'app autorisés",
        AUTH_GITHUB_ALLOWED_USERS: 'Utilisateurs GitHub autorisés',
        AUTH_GITHUB_ALLOWED_ORGS: 'Organisations GitHub autorisées',
        AUTH_GITHUB_ORG_MATCH: 'Organisations requises',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "Vérification d'appartenance",
        AUTH_GITHUB_APP_ID: "ID de la GitHub App d'appartenance",
        AUTH_GITHUB_APP_PRIVATE_KEY: "Clé de la GitHub App d'appartenance",
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: "Installations d'app par organisation",
        WORKOS_API_KEY: 'Clé API WorkOS',
        WORKOS_CLIENT_ID: 'ID client WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Durée de vie de la demande de connexion au compte',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Durée de vie de la demande de connexion au terminal',
        AUTH_PAIRING_TTL_SECONDS: "Durée de vie du code d'appairage",
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Durée de vie du cache de jetons de session',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Taille du cache de jetons de session',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "Durée de vie du cache d'éligibilité",
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: "Taille du cache d'éligibilité",
        FRIENDS_USERNAME_MIN_LEN: "Nom d'utilisateur le plus court",
        FRIENDS_USERNAME_MAX_LEN: "Nom d'utilisateur le plus long",
        FRIENDS_USERNAME_REGEX: "Motif du nom d'utilisateur",
        HAPPIER_CANONICAL_SERVER_URL: "Adresse d'identité de connexion",
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: "Adresse de retour OAuth de l'app web",
        PUBLIC_URL: 'Adresse annoncée (légère)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: "Durée de vie de l'adresse détectée",
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: "Détecter à partir de la méthode d'accès",
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Détecter depuis Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: "Délai d'attente de la vérification Tailscale Serve",
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: "Délai d'attente de la vérification Tailscale Funnel",
        PORT: "Port d'écoute",
        HAPPIER_SERVER_HOST: "Adresse d'écoute",
        HAPPIER_SERVER_FLAVOR: 'Variante du serveur',
        NODE_ENV: 'Environnement Node',
        SERVER_ROLE: 'Rôle du processus',
        UV_THREADPOOL_SIZE: 'Threads de travail',
        HAPPIER_INSTANCE_ID: 'ID de réplica',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: "Délai d'arrêt",
        HAPPY_EXIT_ON_FATAL: 'Quitter après une erreur fatale',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Cache de préflight du navigateur',
        HAPPIER_SERVER_IDENTITY_ID: 'Identité du serveur',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Objet du relais géré',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Opération de relocalisation',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Fichier de reçu de démarrage',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce du reçu de démarrage',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Récupération anticipée du programme de mise à jour',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit de build',
        HAPPIER_FEATURE_POLICY_ENV: "Politique d'anneau de publication",
        HAPPIER_BUILD_FEATURES_ALLOW: 'Fonctionnalités autorisées',
        HAPPIER_BUILD_FEATURES_DENY: 'Fonctionnalités refusées',
        HAPPIER_SERVER_LOG_LEVEL: 'Niveau de journalisation',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Journal de débogage consolidé',
        HAPPIER_SELF_HOST_LOG_DIR: 'Répertoire des journaux',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: "Diagnostic d'authentification",
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnostic des messages socket',
        METRICS_ENABLED: 'Métriques',
        METRICS_PORT: 'Port des métriques',
        SENTRY_DSN: "DSN de signalement d'erreurs",
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Signaler à Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: "DSN central de signalement d'erreurs",
        SENTRY_ENVIRONMENT: "Environnement de signalement d'erreurs",
        SENTRY_RELEASE: "Version de signalement d'erreurs",
        SENTRY_PROFILE_LIFECYCLE: 'Profilage',
        SENTRY_SEND_DEFAULT_PII: 'Envoyer des données personnelles',
        SENTRY_TRACES_SAMPLE_RATE: 'Requêtes tracées',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Sessions profilées',
        SENTRY_ENABLE_LOGS: 'Envoyer les journaux',
        SENTRY_LOG_LEVELS: 'Niveaux de journal envoyés',
        SENTRY_MONITORS_ENABLED: 'Moniteurs de tâches',
        HAPPIER_SERVER_UI_DIR: "Dossier de l'app web",
        HAPPIER_SERVER_UI_PREFIX: "Chemin de l'app web",
        HAPPIER_SERVER_UI_REQUIRED: "Exiger l'app web",
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: "ID de déploiement de l'app web",
        HAPPIER_SERVER_UI_DEBUG_PATH: "Afficher le chemin de l'app web en cas d'absence",
        HAPPIER_SOCKET_ADAPTER: 'Adaptateur de socket',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adaptateur de socket Redis (ancien)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Longueur du flux de sockets',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Taille de lecture du flux de sockets',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Plus grand message de socket',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Seuil de déconnexion rapide',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Délai de reconnexion pendant un redémarrage',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Fenêtre de reconnexion',
        HAPPY_SOCKET_ROOMS_ONLY: 'Diffusion stricte par sockets',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Propriété de socket de la machine',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Longueur du flux de présence',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: "Concurrence d'écriture de présence",
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Intervalle de vidage de présence',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Attente de lecture de présence',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Taille de lecture de présence',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Récupération de présence après',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Session inactive après',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Machine hors ligne après',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Intervalle de vérification de présence',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: "Vidage de présence à l'arrêt",
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: "Délai d'attente des appels aux machines",
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: "Délai d'attente des appels de capacités",
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: "Délai d'attente d'appel le plus long",
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: "Attente d'une méthode",
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Intervalle de vérification de la méthode',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: "Délai d'attente de recherche inter-réplicas",
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Attente pour arrêter une session',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Attente des sessions directes',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sessions nécessitant de l’attention au premier chargement',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Tours vérifiés pour le retour en arrière',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Historique des réglages conservé',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Exiger une clé de machine signée',
        DATABASE_URL: 'Base de données',
        HAPPIER_DB_PROVIDER: 'Moteur de base de données',
        HAPPIER_DB_CONNECTION_LIMIT: 'Taille du pool de connexions',
        HAPPIER_DB_READINESS_TIMEOUT_MS: "Délai d'attente de disponibilité de la base de données",
        HAPPIER_DB_TX_MAX_RETRIES: 'Tentatives de transaction',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Délai de la première nouvelle tentative',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Délai maximal de nouvelle tentative',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Variation aléatoire des tentatives',
        HAPPIER_DB_TX_TIMEOUT_MS: "Délai d'attente de transaction",
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Attente de connexion',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Budget total des tentatives',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Avertissement de taille de base de données',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migrer au démarrage',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Dossier des migrations',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Mode journal de SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Mode synchrone de SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Limite de taille du journal SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Intervalle de checkpoint SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Attente de checkpoint SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Intervalle de vacuum SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Pages de vacuum SQLite',
        HAPPIER_FILES_BACKEND: 'Backend de fichiers',
        S3_HOST: 'Hôte S3',
        S3_PORT: 'Port S3',
        S3_USE_SSL: 'S3 via TLS',
        S3_REGION: 'Région S3',
        S3_BUCKET: 'Bucket S3',
        S3_PUBLIC_URL: 'Adresse publique S3',
        S3_ACCESS_KEY: 'Clé d’accès S3',
        S3_SECRET_KEY: 'Clé secrète S3',
        REDIS_URL: 'Connexion Redis',
        HANDY_MASTER_SECRET: 'Secret principal',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Répertoire de données',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Répertoire de base de données',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Répertoire de fichiers',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Limites de débit',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Requêtes par client',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Fenêtre de limite de débit',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Compter les requêtes par',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Compter les requêtes de route par',
        HAPPIER_SERVER_TRUST_PROXY: 'Faire confiance aux en-têtes de proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Délai entre les balayages',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Lignes par lot',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Suppressions maximales par règle',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Budget de temps du balayage',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Lignes maximales examinées par règle',
    },
};

const homeSettingsTranslations = { fr } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { fr: {
        dismiss: ({ title }) => `Masquer « ${title} »`,
        dismissTooltip: 'Masquer · à rétablir depuis Personnaliser',
        close: 'Fermer',
        addPhoneSubtitle: 'Suivez vos sessions et répondez aux approbations où que vous soyez.',
        addPhoneAction: 'Afficher le code QR',
        addMachineSubtitle: 'Un serveur ou une machine de dev qui exécute des agents, configurée par SSH ou en une commande.',
        installComputerTitle: 'Installer sur un autre ordinateur',
        installComputerSubtitle: 'Installez-y l’app de bureau et rejoignez ce Home avec un lien.',
        installComputerAction: 'Obtenir le lien',
        connectComputerTitle: 'Connecter un ordinateur',
        connectComputerSubtitle: 'Scannez le code que Happier affiche dans le terminal de votre ordinateur.',
        connectComputerHint: 'Pointez l’appareil photo vers le code que Happier affiche dans le terminal de votre ordinateur.',
        phoneAddMachineSubtitle: 'Configurez un serveur ou une machine de dev pour vos agents.',
        phoneAddMachineAction: 'Ajouter',
        thisHome: 'ce Home',
        pairingPhoneTitle: 'Scannez avec votre téléphone',
        pairingPhoneBody: ({ home }) => `Pointez l’appareil photo de votre téléphone vers le code. Happier s’ouvre et rejoint ${home}.`,
        pairingPhoneStepInstall: 'Installez Happier sur votre téléphone.',
        pairingPhoneStepScan: 'Ouvrez l’appareil photo et scannez le code.',
        pairingPhoneStepJoin: 'Gardez ceci ouvert : votre téléphone rejoint dès qu’il a scanné.',
        pairingComputerTitle: 'Rejoindre depuis un autre ordinateur',
        pairingComputerBody: ({ home }) => `Envoyez ce lien à votre autre ordinateur. L’ouvrir dans Happier rejoint ${home}.`,
        pairingComputerStepInstall: 'Installez l’app de bureau sur l’autre ordinateur.',
        pairingComputerStepOpen: 'Ouvrez-y le lien, ou collez-le dans Happier quand il demande comment se connecter.',
        pairingComputerStepJoin: 'Gardez ceci ouvert : l’ordinateur rejoint dès qu’il ouvre le lien.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Télécharger l’app',
        copyLink: 'Copier le lien',
        waitingForPhone: 'En attente de votre téléphone…',
        waitingForComputer: 'En attente de votre ordinateur…',
        newCodeIn: ({ time }) => `Nouveau code dans ${time}`,
        makingCode: 'Création d’un code…',
        addingDevice: ({ device }) => `Ajout de ${device}…`,
        deviceJoined: ({ device, home }) => `${device} a rejoint ${home}`,
        codeFailed: 'Impossible de créer un code pour ce Home.',
        codeFailedUnreachable: ({ home }) => `${home} n’a pas répondu à cet appareil.`,
        codeFailedIdentity: ({ home }) => `Ce que cet appareil sait de ${home} ne correspond pas à sa réponse ; reconnectez-le dans Homes.`,
        codeFailedSignedOut: ({ home }) => `Cet appareil n’est pas connecté à ${home}.`,
        codeFailedTooLarge: 'Il a trop d’adresses pour tenir dans un code.',
        codeFailedRefused: ({ home }) => `${home} a refusé la demande.`,
        codeFailedUnexpected: 'Un problème est survenu ; réessayez.',
        cancelCode: 'Annuler le code',
        newCode: 'Nouveau code',
        qrLabel: ({ home }) => `Code QR qui ajoute un appareil à ${home}`,
        storeQrLabel: ({ store }) => `Code QR de Happier sur ${store}`,
        getTheApp: 'Obtenir l’app',
        connectServicesTitle: ({ first, second }) => (second ? `Connecter ${first} ou ${second}` : `Connecter ${first}`),
        connectServicesSubtitle: 'Utilisez l’abonnement que vous payez déjà, sur chaque machine, et voyez ce qu’il reste.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "fr">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { fr: {
        open: ({ destination }) => `Ouvrir ${destination}`,
        refreshFailed: 'Actualisation impossible',
        latestRunsTitle: 'Dernières exécutions',
        latestRunsLoading: 'Chargement des dernières exécutions',
        latestRunsEmptyTitle: 'Aucune exécution pour l’instant',
        latestRunsEmptyReason: 'Quand vos automatisations s’exécutent, le résultat de chaque exécution s’affiche ici.',
        latestRunsErrorTitle: 'Impossible de charger les dernières exécutions',
        latestRunsErrorReason: 'Votre Home n’a pas répondu. Vérifiez la connexion, puis réessayez.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "fr">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { fr: {
        addHomeOrSignIn: 'Ajouter un Home / Se connecter',
        sheetDescription: 'Connectez cet appareil à un autre Home, ou retrouvez les vôtres.',
        continueWithService: ({ service }) => `Continuer avec ${service}`,
        continueWithThisHome: 'Continuer avec ce Home',
        continueWithServiceSubtitle: 'Retrouvez vos Homes et rendez celui-ci disponible sur vos autres appareils.',
        serviceUnavailable: ({ service }) => `${service} est indisponible pour le moment.`,
        serviceUnsupported: ({ service }) => `${service} ne propose pas de connexion par compte.`,
        serviceUnavailableUnnamed: 'Votre service de connexion est indisponible pour le moment.',
        serviceUnsupportedUnnamed: 'Votre service de connexion ne propose pas de connexion par compte.',
        scanOrPaste: 'Scanner ou coller un lien de Home',
        scanOrPasteSubtitle: 'Rejoignez un Home avec un code QR ou un lien.',
        createPersonalHome: 'Créer un Home personnel sur cet ordinateur',
        createPersonalHomeSubtitle: 'Faites tourner ici un Home pour vos propres machines et appareils.',
        opensFirst: 'S’ouvre en premier',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "fr">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const fr: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Tes Homes sont ici",
        reconcileLead: "Ce téléphone suit maintenant tous tes Homes.",
        showMySessions: "Afficher mes sessions",
        scanComputerCode: "Scanne le code sur ton ordinateur",
        serviceLead: "Tes Homes sont trouvés après la connexion. Ce téléphone les suit tous.",
        serviceAsHomeLead: ({ service }) => `Tes sessions sont sur ${service}, toujours accessibles. Ajoute un ordinateur pour exécuter les agents quand tu veux.`,
        factAlwaysOnDetail: "Accède à tes sessions à tout moment.",
        factAgents: "Tes ordinateurs exécutent les agents",
        factAgentsDetail: "Ajoutes-en un plus tard avec un code QR.",
        fromDeviceHelp: "Ouvre Réglages → Ajouter ton téléphone sur cet appareil, puis scanne son code avec la caméra de ce téléphone ou colle son lien Home.",
        scan: "Scanner",
    },
    happierAccount: 'compte Happier',
    serviceAccount: ({ service }) => `compte ${service}`,

    alreadyUseTitle: 'Tu utilises déjà Happier ?',
    alreadyUseDescription: 'Retrouve tes Homes avec ton compte, ou connecte-toi directement à un Home que tu gères. Rien ne change sur cet ordinateur tant que tu n’as pas choisi.',
    signIn: 'Se connecter',
    withService: ({ service }) => `avec ${service}`,
    changeServiceLabel: ({ service }) => `Service de connexion : ${service}. Modifier`,
    connectToHome: 'Se connecter à un Home…',
    hostedPrompt: 'Tu préfères un Home hébergé ?',
    useServiceAsAHome: ({ service }) => `Utiliser ${service} comme Home`,
    dismiss: 'Masquer',

    pathServiceTitle: ({ service }) => `Se connecter avec ${service}`,
    pathServiceSubtitle: 'Retrouver les Homes liés à ton compte',
    pathOtherServiceTitle: 'Se connecter avec un autre service',
    pathOtherServiceSubtitle: 'Ta propre connexion ou celle de ton entreprise',
    pathDirectTitle: 'Se connecter directement à un Home',
    pathDirectSubtitle: 'Un lien ou une adresse · sans compte',

    serviceLead: 'Tes Homes sont retrouvés après la connexion et s’affichent ensemble. Le Home personnel de cet ordinateur reste en place jusqu’à ce que tu décides.',
    defaultServiceFact: 'le service de connexion par défaut',
    serviceMethodsHelp: ({ service }) => `Seules les méthodes proposées par ${service} sont affichées. Nouveau ici ? Les mêmes boutons créent ton compte.`,

    otherServiceLead: 'Si toi ou ton équipe gérez votre propre service de connexion, saisis son adresse. Happier vérifie d’abord ce qu’il propose.',
    serviceAddressLabel: 'Adresse du service de connexion',
    serviceFound: 'Trouvé',
    useThisService: ({ service }) => `Se connecter avec ${service}`,
    addressIsNotAService: 'Cette adresse ne propose pas de connexion par compte. S’il s’agit d’un Home, connecte-toi directement à lui.',
    connectAsHome: 'S’y connecter comme Home',
    backToService: ({ service }) => `Revenir à ${service}`,

    directLead: 'Pour un Home que tu gères toi-même, avec ou sans service de comptes. Aucun compte Happier n’est nécessaire.',
    fromDeviceLabel: 'Depuis un appareil déjà connecté',
    fromDeviceHelp: 'Sur celui-ci, ouvre Réglages → Ajouter ton téléphone, puis scanne son code avec la caméra de cet ordinateur ou colle son lien de Home.',
    homeLinkLabel: 'Lien de Home',
    homeLinkPlaceholder: 'Colle un lien de Home',
    useCamera: 'Utiliser la caméra',
    openLink: 'Ouvrir',
    byAddressLabel: 'Par adresse',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Connecter',
    byAddressHelp: 'Happier vérifie que le Home répond, puis tu te connectes avec les méthodes de ce Home.',
    notAHomeLink: 'Ce n’est pas un lien de Home. Copie-le à nouveau depuis l’autre appareil.',
    homeUnreachable: 'Happier n’a pu joindre aucun Home à cette adresse. Vérifie l’adresse et que le Home est en marche.',

    anotherWay: 'Autre méthode',
    homeReachable: 'Joignable',
    connected: 'Connecté',
    signInToHomeTitle: 'Se connecter à ce Home',
    signInToHomeLead: 'Voici les méthodes proposées par ce Home.',

    reconcileTitle: 'Tes Homes sont connectés',
    reconcileLead: ({ count }) => count === 1
        ? 'Cet ordinateur a maintenant deux Homes. Ils s’affichent ensemble dans Tous les Homes.'
        : `Cet ordinateur a maintenant ${count + 1} Homes. Ils s’affichent ensemble dans Tous les Homes.`,
    reconcileFound: 'Trouvés',
    reconcileThisComputer: 'Cet ordinateur',
    runSessionsIn: 'Exécuter les sessions de cet ordinateur dans',
    runSessionsInDescription: 'Les nouvelles sessions lancées ici sont enregistrées dans ce Home.',
    removeEmptyPersonalHome: 'Supprimer le Home personnel vide',
    removeEmptyPersonalHomeDescription: 'Il a été créé à l’installation de Happier et ne contient encore rien : ni sessions, ni personnes, ni équipes, ni invitations.',
    changeLater: 'Tu pourras changer ça plus tard dans Réglages → Homes.',
    keepBoth: 'Garder les deux',
    useHome: ({ home }) => `Utiliser ${home}`,
    reconcileSetupTitle: 'Choisis où vont les sessions de cet ordinateur',
    reconcileSetupSubtitle: ({ home }) => `Tu as connecté ${home}. Garde les deux Homes, ou exécute-y les sessions de cet ordinateur.`,
    reconcileSetupAction: 'Choisir…',

    serviceAsHomeTitle: ({ service }) => `Utiliser ${service} comme Home`,
    serviceAsHomeLead: ({ service }) => `Tes sessions et réglages sont conservés sur ${service} plutôt que sur cet ordinateur.`,
    factAlwaysOn: 'Toujours disponible',
    factAlwaysOnDetail: 'Ton téléphone accède à tes sessions pendant que cet ordinateur est en veille.',
    factAgents: 'Cet ordinateur continue d’exécuter tes agents',
    factAgentsDetail: 'Rien ne change quant à l’endroit où le code s’exécute.',
    storageE2ee: 'Chiffré de bout en bout',
    storageE2eeDetail: ({ service }) => `${service} stocke tes sessions mais ne peut pas les lire.`,
    storagePlain: ({ service }) => `Stocké par ${service}`,
    storagePlainDetail: 'Pas de chiffrement de bout en bout : le service peut lire ce qu’il stocke.',
    storageE2eeByDefault: 'Chiffré de bout en bout par défaut',
    storagePlainByDefault: ({ service }) => `Stocké par ${service}, lisible par défaut`,
    storageChoiceDetail: 'Tu choisis en créant ton compte.',
    removeEmptyOfferedDetail: 'Il ne contient encore rien. Proposé uniquement parce qu’il est vide.',
    signInOrCreate: ({ account }) => `Connecte-toi ou crée ton ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Tu utilises déjà ${service} comme Home ? La connexion le relie directement.`,

    addHomeTitle: 'Ajouter un Home',
    addHomeDescription: 'Un Home conserve tes sessions et tes réglages. Connecte-en un que tu utilises déjà, ou lance-en un ailleurs.',
    addSignIn: ({ account }) => `Se connecter avec ton ${account}`,
    addSignInSubtitle: 'Retrouve les Homes que tu utilises déjà et connecte-les.',
    addServiceAsHomeSubtitle: 'Hébergé pour toi et toujours disponible.',
    addLinkOrQr: 'Se connecter avec un lien ou un code QR',
    addLinkOrQrSubtitle: 'Aucun compte nécessaire. Récupère-le depuis un appareil déjà connecté.',
    addServerHome: 'Configurer un Home sur un serveur',
    addServerHomeSubtitle: 'Une machine de dev ou un VPS que tu contrôles, configuré via SSH.',
    haveHomeAddress: 'Tu as l’adresse d’un Home ?',
    enterIt: 'La saisir',

    livesOnThisComputer: 'Sur cet ordinateur',
    availableWhileAwake: 'disponible tant qu’il est allumé',
    gettingReady: 'en préparation',
    noComputerYet: 'Pas encore d’ordinateur ?',
    aboutYourHome: 'À propos de ton Home',

    nudgeTitle: ({ count }) => `Home injoignable ${count} fois cette semaine — déplacer le Home ?`,
    nudgeBody: 'Si ce Home fonctionne sur un ordinateur qui se met en veille, le déplacer vers un serveur toujours allumé peut aider.',
    nudgeDismiss: 'Masquer définitivement sur cet appareil',
    moveHome: 'Déplacer le Home…',
    useService: ({ service }) => `Utiliser ${service}`,
};

const homesJourneysTranslations = { fr } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "fr">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "fr"> = { fr: {
        githubCurrentAccess: 'Accès actuel',
        githubCurrentAccessSubtitle: 'Requis par les connexions et les sources d’annuaire activées qui utilisent cette installation.',
        githubCurrentAccessEmpty: 'Aucun accès n’est requis par les services activés.',
        githubSetupAccess: 'Accès pour la configuration et la réparation',
        githubSetupAccessSubtitle: 'Accès pour les connexions configurées, y compris celles désactivées et les sources d’annuaire en pause. Accordez les accès manquants sur GitHub avant de les activer ou reprendre, puis vérifiez à nouveau l’installation.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Supprimer l’installation pour ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "fr"> = { fr: {
        clientAuthenticationMethod: 'Authentification du client', clientSecretPost: 'Corps POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Conserver le jeton de renouvellement', buttonColor: 'Couleur du bouton de connexion', iconHint: 'Icône de connexion',
        allowRulesHint: 'Saisissez une valeur par ligne. Laissez vide pour ne pas restreindre.', brandingHint: 'Laissez vide pour utiliser l’apparence de connexion par défaut.', invalidScopes: 'Incluez openid dans les portées demandées.', refreshFailed: 'Impossible d’actualiser cette connexion', refreshFailedHint: 'Vos modifications sont conservées. Réessayez pour vérifier les changements sur le Home.',
    } };

const identityAdministrationTranslations = { fr: build({ ...en, homeWorkosChooseDetail: "Choisissez la connexion WorkOS utilisée pour se connecter à ce Home.", homeWorkosAdd: "Connexion d’entreprise via WorkOS", homeWorkosCompanyName: "Nom de l’entreprise", homeWorkosPurpose: "Les personnes de votre entreprise peuvent se connecter à ce Home avec leur compte professionnel.", homeWorkosEnableDetail: "Les personnes pourront se connecter à ce Home avec leur compte d’entreprise.", homeWorkosOffboarding: "Le SSO seul ne retire pas les personnes qui quittent votre entreprise.", homeWorkosPlatformRequired: "Configurez d’abord WorkOS dans les plateformes de connexion.",  title: 'Fournisseurs d’identité', subtitle: 'Connexions de connexion du Home disponibles pour les Teams.', homeConnections: 'Connexions du Home', add: 'Ajouter une connexion', empty: 'Aucune connexion du Home', unreadable: 'Certains fournisseurs sont illisibles.', active: 'Actif', disabled: 'Désactivé', needsTest: 'Test requis', tested: 'Testé', staleTest: 'Nouveau test requis', configuration: 'Configuration', issuer: 'URL de l’émetteur', clientId: 'ID client', clientSecret: 'Secret client', secretSet: 'Défini', secretNotSet: 'Non défini', secretRetain: 'Laisser vide pour conserver le secret actuel.', scopes: 'Portées', loginClaim: 'Attribut de connexion', emailClaim: 'Attribut e-mail', groupsClaim: 'Attribut des Groupes', fetchUserInfo: 'Récupérer UserInfo', advanced: 'Afficher les réglages avancés', hideAdvanced: 'Masquer les réglages avancés', actions: 'Actions', test: 'Tester la connexion', testing: 'Ouverture du test…', edit: 'Modifier la connexion', save: 'Enregistrer', saving: 'Enregistrement…', enable: 'Activer la connexion', disable: 'Désactiver la connexion', remove: 'Supprimer la connexion', createTitle: 'Ajouter un fournisseur d’identité', editTitle: 'Modifier le fournisseur d’identité', displayName: 'Nom', required: 'Renseignez les champs obligatoires.', invalidIssuer: 'Saisissez une URL HTTPS valide.', secretRequired: 'Saisissez un secret client.', error: 'La modification a échoué.', accounts: 'Accounts concernés', connections: 'Connexions Team', errorForbidden: 'Vous n’avez plus l’autorisation. Rien n’a été modifié.', errorConflict: 'Quelqu’un a modifié cet élément avant vous. Vos modifications sont conservées : rechargez, puis réessayez.', errorMissing: 'Cet élément n’existe plus. Quelqu’un l’a peut-être supprimé.', errorInUse: 'D’autres éléments en dépendent encore. Supprimez-les d’abord.', errorProviderUnavailable: 'Le service d’identité n’a pas répondu. Rien n’a été modifié.', errorRateLimited: 'Le fournisseur demande d’attendre avant un nouvel essai.', errorInvalid: 'Le Home a refusé ces valeurs. Vérifiez la configuration et réessayez.', errorImmutable: 'Cette valeur est figée une fois l’enregistrement utilisé. Créez-en un nouveau.', errorAuthenticationRequired: 'Reconnectez-vous à cette Team, puis réessayez. Rien n’a été modifié.', errorPolicyUnavailable: 'La politique d’authentification de la Team ne peut pas être évaluée pour le moment. Rien n’a été modifié.', errorPolicyInUse: 'La politique d’authentification de la Team dépend encore de cette connexion.', errorNotAllowed: 'Ce Home n’autorise pas les Teams à configurer ceci. Rien n’a été modifié.', errorNeedsAttention: 'La synchronisation de l’annuaire nécessite votre attention. Lancez une synchronisation complète.', errorSyncPaused: 'Cette source est suspendue. « Reprendre la synchronisation » lance une nouvelle synchronisation complète.', alternateLogins: 'Accounts nécessitant une autre méthode de connexion', recoveryAuthenticationPolicy: 'Ouvrir l’authentification de la Team', recoveryAlternateLogin: 'Donnez d’abord une autre méthode de connexion à ces Accounts', recoveryDirectory: 'Ouvrir l’annuaire', recoveryGroupMappings: 'Ouvrir les correspondances de Groupes', recoveryTeamAuthentication: 'Se reconnecter', callbackUrl: 'URL de rappel', callbackUrlHint: 'Enregistrez cette URL auprès de votre fournisseur d’identité.' , workosSetupSso: 'Ouvrir le portail d’administration WorkOS', workosSetupDirectory: 'Configurer WorkOS Directory Sync', workosCheckSetup: 'Vérifier la configuration WorkOS', workosChooseConnection: 'Choisir la connexion', workosPortalConfirmBody: 'Vous terminerez la configuration dans WorkOS, puis reviendrez ici choisir la connexion.', workosDirectoryPortalConfirmBody: 'Vous terminerez la configuration dans WorkOS, puis reviendrez ici choisir l’annuaire.', workosSetupSection: 'Configuration', workosSetupFooter: 'Vous pouvez partir et revenir : la configuration reprend à l’étape atteinte.', workosStepPortalDetail: 'Connectez-y votre fournisseur d’identité. À votre retour, la configuration continue ici.', workosStepPortalDone: 'Portail d’administration', workosStepPortalDoneDetail: 'Votre organisation est liée.', workosOpenPortal: 'Ouvrir le portail', workosOpenPortalAgain: 'Rouvrir', workosStepChooseDetail: 'Choisissez la connexion WorkOS qui connecte les membres.', workosStepChooseDone: 'Connexion', workosFindConnections: 'Rechercher les connexions', workosUseConnection: ({ name }: { name: string }) => `Utiliser ${name}`, workosCandidateDraft: 'Un brouillon dans WorkOS. Terminez-le d’abord là-bas.', workosStepTestDetail: 'Connectez-vous une fois vous-même. Rien n’est enregistré dans le compte de qui que ce soit.', workosTestPassed: 'Votre connexion de test a fonctionné.', workosTestAgain: 'Tester à nouveau', workosStepEnable: 'L’activer', workosStepEnableDetail: 'Les membres pourront ensuite se connecter avec. Pour l’exiger, choisissez-la sous Comment les membres se connectent.', workosTurnOn: 'Activer', workosConnectionSection: 'Connexion', workosConnectionRow: 'Connexion WorkOS', workosConnectionNotChosen: 'Pas encore choisie', workosChange: 'Modifier', errorWorkosPlatformUnavailable: 'WorkOS n’est pas encore configuré sur ce Home.', errorSetupRequired: 'Ceci doit être configuré avant de pouvoir être utilisé.', removeTitle: ({ name }: { name: string }) => `Supprimer ${name} ?`, removeBody: ({ name }: { name: string }) => `${name} n’est plus proposé pour la connexion. Les comptes qui l’utilisaient sont conservés.`, removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `Encore utilisé par ${connections} connexion(s) d’équipe et ${accounts} compte(s). Supprimez-les d’abord.`, disableTitle: ({ name }: { name: string }) => `Désactiver ${name} ?`, disableBody: ({ name }: { name: string }) => `Personne ne peut se connecter avec ${name} tant qu’il n’est pas réactivé. Rien n’est supprimé.`, githubRemoveInstallationTitle: ({ name }: { name: string }) => `Supprimer l’installation sur ${name} ?`, githubRemoveInstallationBody: ({ name }: { name: string }) => `Ce Home cesse d’utiliser l’App sur ${name}. Rien ne change sur GitHub ; désinstallez-la là-bas si vous n’en avez plus besoin.`, removeBlockedTitle: ({ name }: { name: string }) => `${name} ne peut pas encore être supprimé`, removeImpactPeople: ({ count }: { count: number }) => count === 1 ? '1 personne se connecte à cette équipe avec.' : `${count} personnes se connectent à cette équipe avec.`, removeImpactNobody: 'Personne ne se connecte encore à cette équipe avec.', removeImpactKept: 'Leurs comptes et adhésions à l’équipe sont conservés.', removeBlockedAlternateLogins: ({ count }: { count: number }) => count === 1 ? '1 personne n’a pas d’autre moyen de se connecter.' : `${count} personnes n’ont pas d’autre moyen de se connecter.`, removeBlockedDirectories: ({ count }: { count: number }) => count === 1 ? 'Une source d’annuaire l’utilise encore.' : `${count} sources d’annuaire l’utilisent encore.`, removeBlockedGroups: ({ count }: { count: number }) => count === 1 ? 'Une correspondance de groupe l’utilise encore.' : `${count} correspondances de groupe l’utilisent encore.`, removeBlockedMemberships: ({ count }: { count: number }) => count === 1 ? '1 adhésion est encore gérée par elle.' : `${count} adhésions sont encore gérées par elle.` }, githubAccessWords.fr, oidcEditorWords.fr) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const fr: typeof en = {
    pageDescription: 'Tout ce qui vous attend, regroupé par le travail auquel il appartient.',
    tabs: { a11y: 'Vue de la boîte de réception', needsYou: 'Vous attend', updates: 'Nouveautés' },
    groups: {
        unknownLead: 'Session',
        leadMeta: ({ count }) => (count === 1 ? '1 sous-session' : `${count} sous-sessions`),
        runMeta: 'Exécution de workflow',
        otherTitle: 'Autres sessions',
        otherMeta: 'Hors orchestrateur et hors exécution',
        openSession: 'Ouvrir la session',
        openRun: 'Ouvrir l’exécution',
    },
    rows: {
        step: 'Étape',
        workflowRun: 'Exécution de workflow',
        review: 'Examiner',
        stalled: 'Bloquée',
        stalledReason: 'Sa machine s’est déconnectée en plein tour',
        landing: 'À fusionner',
        settle: 'Clore',
        snoozedUntil: ({ time }) => `Reportée jusqu’à ${time}`,
        more: 'Plus d’actions',
        approvalNeeded: 'Attend ton approbation',
        approvalUntitled: 'Approuver une action',
    },
    popover: {
        moreInOther: ({ count }) => `${count} de plus dans Autres sessions`,
        updates: ({ count }) => (count === 1 ? '1 nouveauté' : `${count} nouveautés`),
    },
    empty: {
        title: 'Rien ne vous attend',
        description: 'Les demandes d’autorisation, les revues et tout ce qu’un orchestrateur ou un workflow attend de vous arrivent ici.',
    },
    updatesEmpty: {
        title: 'Aucune nouveauté',
        description: 'Les sessions terminées et les demandes d’ami arrivent ici.',
    },
    stale: { reason: 'Impossible d’actualiser les exécutions de workflow', retry: 'Réessayer' },
    settleFailed: 'Impossible de clore cette session',
    detail: {
        openApproval: 'Ouvrir la demande',
        idle: 'Choisis un élément pour le voir ici',
    },
};

const inboxWorkTranslations = { fr };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { fr: {
        browse: 'Parcourir…',
        browseField: ({ field }) => `Parcourir pour ${field}`,
        unavailable: 'Le plugin qui fournit ce choix n’est pas disponible. Votre valeur actuelle est conservée.',
        retired: 'Le plugin a été mis à jour pendant votre choix. Réessayez.',
        invalid: 'Ce choix n’est pas utilisable ici. Votre valeur actuelle est conservée.',
        failed: 'Le sélecteur n’a pas pu s’ouvrir. Réessayez.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "fr">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { fr: { newMachine: 'Nouvelle machine', waiting: 'En attente de connexion', connected: 'Connectée', failed: 'Impossible d’ajouter cette machine', cancelled: 'Annulé', cannotReachHost: 'Hôte inaccessible. Vérifiez l’adresse et l’accès SSH.', choosePath: 'Choisissez comment ajouter une machine', switchHome: 'Revenez à ce foyer pour continuer' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "fr">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const fr: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Connecté avec ${label}`,
    signedInAs: ({ label }) => `Connecté en tant que ${label}`,
    signedInHere: 'Connecté sur cette machine',
    updateTo: ({ version }) => `Mettre à jour vers ${version}`,
    needsSignIn: 'Connexion requise',
    waitingForSignIn: 'En attente de la connexion dans le terminal…',
    notInstalled: 'Non installé',
    downloadSize: ({ size }) => `Téléchargement de ${size}`,
    installYourself: 'À installer vous-même',
    unsupportedOs: 'Ne fonctionne pas sur ce système',
    unsupportedArch: 'Aucune version pour ce processeur',
    installing: 'Installation…',
    progress: ({ done, total }) => `${done} sur ${total}`,
    checking: 'Vérification…',
    offlineSignedIn: 'Dernier état : connecté · machine hors ligne',
    offlineSignedOut: 'Dernier état : déconnecté · machine hors ligne',
    offlineNotInstalled: 'Non installé au dernier relevé · machine hors ligne',
    offlineUnknown: 'Machine hors ligne',
    unknown: 'Impossible de vérifier cette machine',
    actionInstall: 'Installer',
    actionUpdate: 'Mettre à jour',
    actionSignIn: 'Se connecter',
    actionRetry: 'Réessayer',
    actionCancel: 'Annuler',
    actionShowTerminal: 'Afficher le terminal',
    actionGuide: 'Guide d’installation',
    installLeadManaged: ({ agent, machine }) => `Happier installe ${agent} sur ${machine} pour Happier uniquement. Votre configuration de terminal ne change pas.`,
    installLeadVendor: ({ agent, machine }) => `Happier lance l’installateur de ${agent} sur ${machine}.`,
    installAlsoDownloads: ({ what }) => `Il télécharge aussi ${what}, utilisé par les sessions.`,
    installThenSignIn: 'Ensuite, vous vous connectez.',
    installAgent: ({ agent }) => `Installer ${agent}`,
    installMyself: 'Je l’installerai moi-même',
    manualLead: ({ agent, machine }) => `Happier ne peut pas installer ${agent} pour vous. Installez-le sur ${machine} avec son guide, puis vérifiez à nouveau.`,
    checkAgain: 'Vérifier à nouveau',
    closeNote: ({ machine }) => `Vous pouvez fermer ; cela continue sur ${machine}.`,
    stepCheck: 'Vérifier qu’il fonctionne',
    stepSignIn: 'Connexion',
    failedKept: 'Rien d’à moitié installé n’a été conservé.',
    installedLine: ({ agent, version }) => `${agent} ${version} est installé`,
    nowSignIn: 'connectez-vous maintenant',
    signInHow: ({ agent }) => `Comment ${agent} se connecte`,
    useService: ({ service }) => `Utiliser votre ${service}`,
    recommended: 'Recommandé',
    serviceConnected: ({ profile }) => `${profile} · déjà connecté · fonctionne sur toutes les machines`,
    serviceNotConnected: 'Connectez-le une fois ; toutes les machines peuvent l’utiliser.',
    connect: 'Connecter',
    signInOn: ({ machine }) => `Se connecter sur ${machine}`,
    signInOnDetail: ({ agent }) => `Lance la connexion propre à ${agent} dans un terminal là-bas. Seule cette machine l’utilise.`,
    noNativeLogin: ({ agent }) => `${agent} n’a pas de connexion propre : il utilise une clé API ou un compte connecté. Connectez-en un une fois et toutes les machines pourront l’utiliser.`,
    openSignInTerminal: 'Ouvrir la connexion dans le terminal',
    useThisAccount: 'Utiliser ce compte',
    waitingLead: ({ agent, machine }) => `La connexion de ${agent} est ouverte dans le terminal de ${machine}. Tout sera prêt dès qu’il indiquera que vous êtes connecté.`,
    readyLine: ({ agent, machine }) => `${agent} est prêt sur ${machine}`,
    startSessionWith: ({ agent }) => `Démarrer une session avec ${agent}`,
    setUpAnother: 'Configurer un autre agent',
    unsupportedLead: ({ agent, machine }) => `${agent} n’a pas de version pour ${machine} et ne peut donc pas y fonctionner.`,
    setupTitle: ({ agent }) => `Configurer ${agent}`,
    signInTitle: ({ agent }) => `Se connecter à ${agent}`,
    readyTitle: ({ agent }) => `${agent} est prêt`,
    notOnMachineYet: ({ machine }) => `Pas encore sur ${machine}`,
    onMachine: ({ machine }) => `Sur ${machine}`,
    installingOn: ({ machine }) => `Installation sur ${machine}`,
    cantRunOn: ({ machine }) => `Ne fonctionne pas sur ${machine}`,
    terminalTab: ({ agent }) => `Connexion · ${agent}`,
    panelLead: 'Terminez dans le navigateur qui s’est ouvert. Autre appareil ? Ouvrez-y le lien.',
    open: 'Ouvrir',
    openSignInPage: 'Ouvrir la page de connexion',
    waitingEllipsis: 'En attente de connexion…',
    signedInAlready: 'Déjà connecté ?',
    closeTerminal: 'Fermer le terminal',
    showTheTerminal: 'Afficher le terminal',
    phoneLead: ({ agent, machine }) => `${agent} vous demande de vous connecter. Ouvrez la page ici, terminez, et ${machine} le prendra en compte.`,
    panelSignedInAs: ({ account }) => `Connecté en tant que ${account}.`,
    panelChecked: 'Happier vient de le vérifier.',
    sectionTitle: 'Agents',
    sectionDescription: 'Les agents de code de cette machine et la façon dont chacun se connecte.',
    addTitle: 'Ajouter un agent',
    addMore: ({ count }) => (count === 1 ? `1 de plus fonctionne ici` : `${count} de plus fonctionnent ici`),
    showAll: 'Tout afficher',
    showFewer: 'Afficher moins',
    emptyInstalled: 'Aucun agent sur cette machine pour l’instant. Choisissez-en un ci-dessous ; Happier l’installe et vous connecte.',
    offlineNote: ({ machine }) => `${machine} est hors ligne. Voici ce qu’elle a signalé en dernier.`,
    firstTitle: 'Configurez votre premier agent',
    firstLead: ({ machine }) => `${machine} est connecté, mais n’a pas encore d’agent. Choisissez-en un ; Happier l’installe et vous connecte.`,
    firstMore: ({ count }) => (count === 1 ? `Ou choisissez parmi 1 autre agent.` : `Ou choisissez parmi ${count} autres agents.`),
    allAgents: 'Tous les agents',
    setUp: 'Configurer',
    choiceUsesService: ({ service, profile }) => `Utilise votre ${service}. Connecté : ${profile}.`,
    choiceSignsInOn: 'Se connecte sur la machine.',
    dismissFirst: 'Masquer « Configurez votre premier agent »',
    dismissTooltip: 'Masquer · à restaurer depuis Personnaliser',
    chooseAgent: 'Choisissez un agent',
    blockNotInstalled: ({ agent, machine }) => `${agent} n’est pas encore sur ${machine}.`,
    blockSetUpToStart: 'Configurez-le pour commencer.',
    blockSignedOut: ({ agent, machine }) => `${agent} doit se connecter sur ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} n’est pas installé sur ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} est déconnecté sur ${machine}.`,
    draftKept: 'Votre message est conservé.',
    alreadySetUp: ({ machine, home }) => `${machine} est déjà connecté à ${home}`,
    startSession: 'Démarrer une session',
    openMachine: ({ machine }) => `Ouvrir ${machine}`,
};

const machineAgentsTranslations = { fr: fr } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "fr">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { fr: translated({
        machineDetailPage: {
            description: 'Lancez des sessions ici et voyez ce qui tourne sur cette machine.',
            placeholderTitle: 'Machine',
            online: 'En ligne',
            offline: 'Hors ligne',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Remplacée par ${machine}`,
            unavailableTitle: 'Cette machine ne peut pas lancer de sessions pour le moment',
            startAction: 'Lancer la session',
            tmuxSectionDescription: 'Comment les nouvelles sessions de cette machine utilisent tmux.',
            windowsSectionDescription: 'Comment les sessions à distance s’ouvrent sur cette machine.',
            clisSectionDescription: 'Les CLI d’agents trouvées par Happier sur cette machine, et les outils qu’il peut installer.',
            runsSectionDescription: 'Les processus lancés par des sessions sur cette machine.',
            recentSessionsTitle: 'Sessions récentes',
            recentSessionsDescription: 'Les cinq sessions les plus récentes sur cette machine.',
            daemonSectionDescription: 'Le service d’arrière-plan qui relie cette machine à Happier.',
            stopDaemonDescription: 'Les sessions en cours continuent. Aucune nouvelle session ne peut démarrer tant que vous ne l’avez pas relancé sur cette machine.',
            stopDaemonAction: 'Arrêter',
            detailsTitle: 'Détails de la machine',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const fr = {
    machinesSection: "Machines",
    tierPrimaryDescription: "Essayé en premier.",
    tierFallbackDescription: "Essayé quand aucune machine précédente n’est en ligne.",
    pauseMember: "Suspendre pour les nouvelles sessions",
    resumeMember: "Utiliser pour les nouvelles sessions",
    pausedState: "En pause",
    memberMenu: "Options de la machine",
    newPoolTitle: "Nouveau pool de machines",
    title: "Pools de machines",
    myTitle: "Mes pools de machines",
    add: "Ajouter un pool de machines",
    benefit: "Choisissez une machine préférée, avec d’autres disponibles comme solution de secours.",
    placementChangeNotice: "Les modifications s’appliquent aux sessions qui démarrent après l’enregistrement. Les sessions ouvertes restent sur leur machine.",
    connectionSemantics: "Une machine est choisie à l’ouverture d’une connexion et reste sélectionnée pour cette connexion. Une connexion ultérieure peut choisir une autre machine.",
    noMembers: "Aucune machine dans ce pool pour l'instant",
    unavailable: "Indisponible",
    memberRevoked: "Révoqué",
    memberReplaced: "Remplacé",
    memberTemporary: "Temporaire",
    availabilityUnknown: "Disponibilité de la connexion inconnue",
    notVerified: "Non vérifié",
    brokerUnavailable: "Aucun courtier disponible",
    brokerAvailable: ({ count }: { count: number }) => `${count} disponibles`,
    basics: "Détails",
    name: "Nom",
    description: "Description (facultatif)",
    descriptionTitle: "Description",
    addMachines: "Ajouter des machines",
    noMachines: "Aucune machine persistante n’est disponible sur ce Home.",
    allMachinesAdded: "Toutes les machines de ce Home sont déjà dans ce pool.",
    primary: "Primaire",
    addFallback: "Ajouter une solution de secours",
    moveTo: "Déplacer vers",
    moveTierEarlier: "Déplacer ce niveau plus tôt",
    moveTierLater: "Déplacer ce niveau plus tard",
    removeMember: "Supprimer du pool",
    enableMember: "Utiliser pour les sélections futures",
    save: "Enregistrer les modifications",
    create: "Créer un pool",
    delete: "Supprimer le pool de machines",
    deleteTitle: "Supprimer ce pool de machines ?",
    deleteBody: "Toute ressource d’identifiants qui utilise ce pool perdra leur emplacement de courtier et devront être réparées. Cela affecte les sélections futures sans supprimer de machines ni arrêter les sessions en cours.",
    saveFailed: "Impossible d'enregistrer ce pool de machines. Vos modifications sont toujours là.",
    deleteFailed: "Impossible de supprimer ce pool de machines. Réessayez.",
    conflictTitle: "Ce pool a été modifié ailleurs",
    conflictBody: "Vos modifications non enregistrées sont conservées. Rechargez la version enregistrée pour consulter les dernières modifications.",
    conflictNoReload: "L'identité du pool n'est plus disponible. Vos modifications non enregistrées sont conservées.",
    homeOffline: "Ce Home est hors ligne. Les modifications du pool seront disponibles après sa reconnexion.",
    refreshFailed: "Impossible d’actualiser les pools de machines. La dernière liste connue est affichée.",
    featureUnavailable: "Les pools de machines ne sont pas disponibles sur ce Home. Mettez-les à jour ou activez-les sur le Home pour continuer.",
    openSettings: "Paramètres du pool de machines",
    pickSpecificMachine: "Choisir une machine spécifique",
    poolNotFound: "Ce pool de machines n'est plus disponible.",
    reload: "Recharger la version enregistrée",
    reloadTitle: "Supprimer vos modifications non enregistrées ?",
    reloadBody: "Le rechargement remplace ce formulaire par la dernière version enregistrée.",
    privacy: "Le serveur de ce Home peut lire les noms, les descriptions et les membres des pools, même pour les comptes chiffrés de bout en bout.",
    nameRequired: "Entrez un nom avant d'enregistrer.",
    memberNotEligible: "Certaines machines ne peuvent plus appartenir à ce pool.",
    memberNotEligibleDetail: "Supprimez cette machine ou choisissez une autre machine persistante.",
    resolvingTarget: "Choisir une machine dans ce pool…",
    resolveEmpty: "Ce pool ne contient aucune machine activée.",
    resolveNoAvailable: "Aucune machine de ce pool n'est actuellement disponible.",
    resolvePresenceUnavailable: "La disponibilité de la machine est temporairement inconnue.",
    resolveFailed: "Happier n’a pas pu choisir une machine dans ce pool. Réessayez.",
    executionMachine: "Exécuter sur",
    chosenFrom: "Choisi parmi",
    aMachinePool: "Un pool de machines",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} sur ${enabled} machines activées connectées`,
    fallback: ({ number }: { number: number }) => `Secours ${number}`,
};

const machinePoolTranslations = { fr };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const fr: McpSettingsCopy = {
    purpose: 'Les serveurs d’outils que vos agents peuvent appeler en session. Ajoutez un serveur une fois, puis choisissez où il s’applique.',
    add: 'Ajouter un serveur MCP',
    addConfigure: 'Configurer un serveur',
    addConfigureDescription: 'Saisissez sa commande ou son adresse',
    addImportJson: 'Coller une configuration JSON',
    addImportJsonDescription: 'Depuis un README ou une autre app',
    addOwnCategory: 'Ajouter le vôtre',
    addPresetCategory: 'Installation rapide',
    addFromMachine: 'Importer depuis cette machine',
    addFromMachineDescription: 'Serveurs que d’autres agents utilisent déjà',
    searchPlaceholder: 'Rechercher des serveurs',
    toolsGroup: 'Outils',
    unbound: 'Utilisé nulle part pour l’instant',
    newServer: 'Nouveau serveur MCP',
    serverPurpose: 'Un serveur d’outils que vos agents peuvent appeler. Choisissez ci-dessous où il s’applique.',
    addByTitle: 'Ajouter par',
    serverSection: 'Serveur',
    serverSectionDescription: 'Le nom du serveur dans les sessions et dans cette liste.',
    connectionSection: 'Connexion',
    connectionSectionDescription: 'Comment Happier démarre ou joint le serveur.',
    envDescription: 'Valeurs transmises au serveur. Utilisez un secret enregistré pour les clés.',
    headersDescription: 'Envoyés avec chaque requête. Utilisez un secret enregistré pour les jetons.',
    addRule: 'Ajouter une règle',
    discardDraft: 'Abandonner',
    landingTitle: 'Donnez plus d’outils à vos agents',
    landingDescription: 'Les serveurs MCP ajoutent des outils comme un navigateur, une recherche de documentation ou GitHub. Configurez-en un, collez une configuration ou partez d’un préréglage.',
    onMachineTitle: 'Trouvés sur cette machine',
    onMachinePurpose: 'Les serveurs MCP que d’autres agents configurent déjà sur cette machine. Importez-en un pour l’utiliser depuis Happier.',
    onMachineSearchSection: 'Où chercher',
    onMachineSearchDescription: 'Les configurations d’agents de votre dossier personnel, plus un dossier de projet si vous en choisissez un.',
    onMachineFoundSection: 'Serveurs',
    onMachineFoundDescription: 'L’import copie le serveur dans Happier ; la configuration d’origine ne change pas.',
    previewTitle: 'Ce que reçoivent les sessions',
    previewPurpose: 'Vérifiez quels serveurs MCP une session reçoit pour un agent et un dossier, et ce qui se passe quand l’un ne peut pas démarrer.',
    previewContextSection: 'Session',
    previewContextDescription: 'L’agent et le dossier avec lesquels une nouvelle session démarrerait.',
    failurePolicyTitle: 'Quand un serveur ne peut pas démarrer',
    failurePolicyDescription: 'Par exemple, quand un secret enregistré dont il a besoin manque.',
    failurePolicySkip: 'L’ignorer',
    failurePolicyStop: 'Arrêter la session',
    failureSection: 'Fiabilité',
    failureSectionDescription: 'S’applique à chaque serveur MCP dans chaque session.',
    previewNothingTitle: 'Rien ne serait fourni',
    previewNothingDescription: 'Aucun serveur MCP ne s’applique à cet agent et à ce dossier. Ajoute un serveur ou une règle qui les couvre.',
    check: 'Vérifier',
    scan: 'Rechercher',
};

const mcpSettingsTranslations = { fr } as const;

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

const fr: DesktopTrayTranslation = {
    open: 'Ouvrir Happier',
    openInHappier: 'Ouvrir dans Happier',
    settings: 'Réglages…',
    startAtLogin: 'Lancer à la connexion',
    quit: 'Quitter Happier',
    stopServicesAndQuit: 'Arrêter les services en arrière-plan et quitter…',
    sessions: ({ count }: CountParams) => `${count} en cours`,
    start: 'Démarrer',
    restart: 'Redémarrer',
    stop: 'Arrêter…',
    userOwned: 'Géré en dehors de Happier',
    checking: 'Vérification des services en arrière-plan…',
    readFailed: 'Impossible de vérifier les services en arrière-plan',
    incomplete: 'Certains services en arrière-plan n’ont pas pu être vérifiés',
    noServices: 'Cet ordinateur n’est pas encore configuré',
    working: 'En cours…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Arrêter le service en arrière-plan de Happier pour ${relay} ?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Les sessions d’agent en cours sur cet ordinateur pour ${relay} vont s’arrêter, et ton téléphone et ton navigateur ne pourront plus l’y joindre tant que le service n’aura pas redémarré.`,
    stopAllConfirmTitle: 'Arrêter les services en arrière-plan de Happier et quitter ?',
    stopAllConfirmBody: 'Les sessions d’agent de cet ordinateur vont s’arrêter, et ton téléphone et ton navigateur ne pourront plus le joindre tant que ses services en arrière-plan n’auront pas redémarré.',
    stopConfirmAction: 'Arrêter',
    actionFailedTitle: 'Ça n’a pas abouti',
    loginItemFailed: 'Impossible de mettre à jour l’élément d’ouverture de Happier',
    quitStopTitle: 'Des sessions d’agent sont encore en cours',
    quitStopBody: 'Quitter arrête les services en arrière-plan de cet ordinateur et met fin aux sessions en cours ici.',
    quitStopUnknownTitle: 'Arrêter les services en arrière-plan ?',
    quitStopUnknownBody: 'Happier ne voit pas quelles sessions tournent sur cet ordinateur. Quitter arrête ses services en arrière-plan et met fin à celles qui tournent.',
    quitStopConfirm: 'Arrêter quand même',
    quitStopKeep: 'Les laisser tourner',
    quitStopFailedTitle: 'Certains services en arrière-plan ne se sont pas arrêtés',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier reste ouvert pour que tu puisses vérifier les services en arrière-plan et réessayer.`,
};

const frLoginStart: DesktopLoginStartTranslation = {
    title: 'Lancer à la connexion',
    subtitle: 'Garde cet ordinateur joignable depuis ton téléphone et ton navigateur : ses services en arrière-plan démarrent à la connexion et continuent après avoir quitté Happier. Désactivé, quitter Happier les arrête.',
    unknown: 'Happier ne sait pas encore si les services en arrière-plan de cet ordinateur démarrent à la connexion.',
    notSetUp: 'Disponible une fois cet ordinateur configuré.',
};

const menuBarModeTranslations = { fr: { tray: fr, loginStart: frLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { fr: {
        email: 'E-mail',
        password: 'Mot de passe',
        signIn: 'Se connecter',
        title: 'E-mail et mot de passe',
        forgotPassword: 'Mot de passe oublié ?',
        capsLock: 'Le verrouillage des majuscules est activé',
        emailRequired: 'Saisis ton adresse e-mail.',
        passwordRequirements: 'Utilise au moins 15 caractères, dans la limite de 1 024 octets UTF-8. Les espaces sont autorisés.',
        unavailable: 'La connexion par e-mail et mot de passe est indisponible sur ce Home.',
        rateLimited: 'Trop de tentatives. Patiente un instant, puis réessaie.',
        emailInvalid: 'Saisis une adresse e-mail valide.',
        passwordMalformed: 'Ce mot de passe contient des caractères que nous ne pouvons pas stocker en toute sécurité. Saisis-le à nouveau.',
        passwordMismatch: 'Ces mots de passe ne correspondent pas.',
        currentPasswordRequired: 'Saisis ton mot de passe actuel.',
        currentPassword: 'Mot de passe actuel',
        newPassword: 'Nouveau mot de passe',
        confirmPassword: 'Confirmer le mot de passe',
        signInFailed: 'Cette combinaison e-mail / mot de passe n’a pas fonctionné.',
        accountDisabledHere: 'Ce compte est désactivé sur ce Home. Demande à une administration du Home de le réactiver.',
        notEligible: 'Ce compte ne peut pas se connecter à ce Home pour le moment.',
        linkExpired: 'Ce lien a expiré ou a déjà été utilisé. Demandes-en un nouveau.',
        revisionConflict: 'Ton mot de passe a changé ailleurs. Recharge puis réessaie.',
        serverUnavailable: 'Ce Home n’a pas pu traiter la demande. Réessaie dans un instant.',
        offline: 'Aucune connexion à ce Home. Vérifie ton réseau et réessaie.',
        homeUnreachable: 'Impossible de joindre ce Home. Réessaie.',
        securityFactUnavailable: 'Impossible de lire ceci depuis ton Home.',
        cancelled: 'Cette tentative a été annulée.',
        approvalPending: 'En attente de ton approbation. Vérifie-la dans la boîte des approbations, puis reviens ici.',
        outcomeUnconfirmed: "Nous n'avons pas pu confirmer si la modification a été appliquée. Nous avons actualisé ce compte : vérifie-le avant de réessayer.",
        recoveryKeyRequired: "Saisis ta clé de récupération pour changer le mot de passe de ce compte chiffré de bout en bout. La clé reste sur cet appareil.",
        working: 'En cours…',
        showPassword: 'Afficher le mot de passe',
        hidePassword: 'Masquer le mot de passe',
        createTitle: 'Crée ton compte',
        createAccount: 'Créer le compte',
        accountProtection: 'Protection du compte',
        protectionPlain: 'Lisible par le Home',
        protectionPlainDetail: 'Ton Home peut lire tes données. Si tu oublies ton mot de passe, tu peux le réinitialiser par e-mail.',
        protectionE2ee: 'Chiffré de bout en bout',
        protectionE2eeDetail: 'Seuls tes appareils peuvent lire tes données. Conserve ta clé de récupération : réinitialiser le mot de passe ne suffit pas à les restaurer.',
        checkYourEmail: 'Consulte ta boîte mail',
        resend: 'Renvoyer',
        resent: 'Renvoyé. Consulte ta boîte mail.',
        useDifferentEmail: 'Utiliser une autre adresse',
        connectTitle: 'Ajouter e-mail et mot de passe',
        connectFromSecurity: 'Connecte-toi avec une méthode que tu utilises déjà, puis ajoute e-mail et mot de passe depuis Sécurité du compte.',
        signInFirst: 'Se connecter d’abord',
        forgotTitle: 'Mot de passe oublié ?',
        forgotExplanation: 'Nous pouvons t’envoyer des instructions par e-mail, ou tu peux utiliser la clé de récupération enregistrée à la création du compte.',
        emailResetInstructions: 'M’envoyer les instructions par e-mail',
        useRecoveryKey: 'Utiliser ta clé de récupération',
        recoveryKeyDownload: 'Télécharger la clé de récupération',
        recoveryKeyLater: 'Le faire plus tard',
        securitySectionTitle: 'E-mail et mot de passe',
        signInEmail: 'E-mail de connexion',
        signInEmailNotSet: 'Non défini',
        passwordEnrolled: 'Configuré',
        passwordNotEnrolled: 'Non configuré',
        passwordSetUp: 'Ton mot de passe est configuré pour ce Home.',
        passwordChanged: 'Ton mot de passe a été modifié.',
        passwordRemoved: 'Ton mot de passe a été supprimé.',
        changePassword: 'Changer le mot de passe',
        removePassword: 'Supprimer le mot de passe',
        removePasswordSubtitle: 'Se connecter uniquement avec tes autres méthodes',
        removePasswordConsequence: 'Ton e-mail et ton mot de passe ne te connecteront plus à ce Home. Tes autres méthodes et tes données restent inchangées.',
        changeEmailExplanation: 'Nous enverrons un e-mail à la nouvelle adresse pour la confirmer. Ton adresse actuelle reste valable jusque-là.',
        sendVerification: 'Envoyer l’e-mail de confirmation',
        verifyTitle: 'Confirme ton e-mail',
        verifyGeneric: 'Ce lien confirme le contrôle d’une boîte mail.',
        verifyReturnToCreate: 'Retourne sur ce Home pour terminer la création de ton compte avec cette adresse.',
        addressVerified: 'Cette adresse est confirmée.',
        confirmEmailChange: 'Utiliser comme e-mail de connexion',
        signInToConfirm: 'Connecte-toi sur cet appareil pour confirmer le changement.',
        returnToSignIn: 'Retour à la connexion',
        continue: 'Continuer',
        resetTitle: 'Définir un nouveau mot de passe',
        resetChooseNew: 'Choisis un nouveau mot de passe pour ce Home.',
        resetComplete: 'Ton mot de passe a été changé. Reconnecte-toi avec le nouveau mot de passe.',
        resetSignsOutOtherDevices: 'Définir un nouveau mot de passe déconnecte ce compte partout ailleurs.',
        setNewPassword: 'Enregistrer le mot de passe',
        emailPlaceholder: 'toi@exemple.fr',
        accountDisabled: ({ home }: { home: string }) => `Ce compte est désactivé sur ${home}. Demande à une administration du Home de le réactiver.`,
        verificationSent: ({ email }: { email: string }) => `Nous avons envoyé un lien de confirmation à ${email}. Ouvre-le pour terminer la création de ton compte.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Si ${email} peut se connecter ici, les instructions de réinitialisation sont en route.`,
        verificationPending: ({ email }: { email: string }) => `Confirmation envoyée à ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Ce lien confirme ${email}.`,
        passwordNeedsEmail: 'Ajoutez d’abord un e-mail de connexion',
        passwordNeedsEmailHint: 'Commence par votre e-mail de connexion',
        setupStepConfirm: 'Confirmer',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Étape ${step} sur ${total} : ${label}`,
        setupEmailHint: 'L’e-mail de connexion et le mot de passe s’ajoutent ensemble. Nous envoyons d’abord un lien pour confirmer l’adresse.',
        setupConfirmHint: 'Ouvrez le lien de cet e-mail pour choisir votre mot de passe.',
        setupPasswordHint: 'Saisissez l’e-mail que vous avez confirmé, puis choisissez votre mot de passe.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { fr: { customize: 'Personnaliser…', title: 'Navigation', description: 'Choisissez ce qui reste visible, apparaît dans Plus ou est masqué. Faites glisser pour réordonner. Enregistré sur cet appareil.', pinned: 'Épinglé', overflow: 'Plus', hidden: 'Masqué', reset: 'Réinitialiser', appRail: 'Barre gauche', sessionRail: 'Barre de session', workspaceRail: 'Barre de l’espace de travail', sessionTabBar: 'Onglets du téléphone' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "fr">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const fr: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'a' : 'ont'} besoin de vous`,
    next: 'Suivant', answeredElsewhere: 'Déjà répondu',
    unavailableTitle: 'Impossible d’ouvrir la demande suivante',
    unavailableBody: 'Certaines sessions en attente sont indisponibles. Reconnectez-vous et réessayez.',
    skippedUnavailable: ({ count }) => `${count} sessions indisponibles ont été ignorées.`,
    waitsForPermission: 'demande votre autorisation', waitsForInput: 'attend votre réponse',
    sessionsWaiting: ({ count }) => `${count} sessions attendent`, go: 'Aller', dismiss: 'Plus tard',
};

const pendingNavigationTranslations = { fr };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { fr: {
        blocked: {
            runtime_unhealthy: 'Ton Home local nécessite ton attention avant de pouvoir démarrer.',
            home_auth_invalid: 'L’authentification de ton Home nécessite ton attention.',
            existing_runtime: 'Tu dois choisir quoi faire du Home local existant avant de poursuivre la configuration.',
            existing_runtime_credentials: 'Ce Home local appartient à une autre app Happier sur cet ordinateur.',
            personal_home_erased: 'Ton Home personnel a été supprimé. Réessaie pour en créer un nouveau.',
        },
        blockedBody: { personal_home_erased: 'Les données de ton Home ont été supprimées. Il n’y a plus rien à récupérer ici ; crée un nouveau Home personnel ou utilise un autre Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "fr">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const fr: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Cette adresse du Home personnel correspond à plusieurs Homes enregistrés.',
    signedInHome: {
        status: 'Tu es déjà connecté à un autre Home.',
        body: ({ home }: HomeParams) => `Cet ordinateur est connecté à ${home}. Continue de l’utiliser, ou configure ici un Home personnel.`,
        keep: ({ home }: HomeParams) => `Continuer avec ${home}`,
        keepDetail: 'Tes sessions et tes machines restent exactement comme elles sont.',
        create: 'Configurer un Home personnel',
        createDetail: 'Crée un Home privé sur cet ordinateur et bascule dessus.',
    },
    existingRuntimeCredentials: {
        body: 'Cette app ne peut pas l’ouvrir sans la clé de récupération de ce Home. Connecte-toi avec la clé, ou utilise un autre Home.',
        signIn: 'Se connecter avec une clé de récupération',
        signInDetail: 'Utilise la clé de récupération enregistrée pour ce Home local.',
    },
};

const personalHomeDecisionTranslations = { fr };

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

const fr = {
    standardOnlyTitle: 'Connexion via les adresses des Homes',
    standardOnlySubtitle: 'Sur cet appareil, utilisez l’adresse de chaque Home plutôt qu’une connexion pair à pair.',
    installOrUpdateAction: 'Installer ou mettre à jour le Home personnel', startAction: 'Démarrer le Home personnel', stopAction: 'Arrêter le Home personnel',
    defaultHomeLabel: 'Home personnel', homeTitle: 'Home', canonicalAddress: 'Adresse du Home', identityComparison: 'Home actuel', identityComparisonMatch: 'Correspond', identityComparisonMismatch: 'Ne correspond pas', identityComparisonUnknown: 'Impossible à confirmer',
    unknownSize: 'Taille inconnue', unknownTimestamp: 'Horodatage inconnu', restoreBackupTitle: 'Sauvegarde', identityTitle: 'Identité du Home', identityUnavailable: 'Identité indisponible', restoreBackupDate: 'Créée le', restoreCompatibility: 'Compatibilité', restoreCompatible: 'Compatible', restoreCompatibilityVerified: 'Vérifiée par cette version', restoreBackupSize: 'Taille', restoreReplacementNotice: 'Les données actuelles du Home seront remplacées. Une sauvegarde de récupération vérifiée sera conservée.', restoreConfirmTitle: 'Remplacer et restaurer ce Home personnel ?', restoreConfirmAction: 'Remplacer et restaurer', relocateConfirmTitle: 'Déplacer ce Home personnel ?', relocateConfirmBody: 'Ton Home actuel sera arrêté avant que sa copie vérifiée devienne active sur la destination.', relocateDestination: 'Destination', relocateConfirmAction: 'Déplacer le Home', recoverRestoreTitle: 'Récupérer la restauration interrompue ?', recoverRestoreBody: 'Annuler la restauration interrompue avec les éléments de récupération conservés.', recoverRestoreAction: 'Récupérer la restauration', eraseDataTitle: 'Supprimer les données du Home personnel ?', eraseHomeTarget: 'Home', eraseDataBody: 'Cette action est distincte de la désinstallation et supprime définitivement uniquement ces chemins résolus du Home :', estimatedSize: 'Taille estimée', summaryTitle: 'Home personnel', footer: 'Ton Home reste sur cet ordinateur. Ces actions ne modifient aucun autre Home.', statusTitle: 'État', notAvailable: 'Indisponible', storageTitle: 'Stockage', masterSecretTitle: 'Secret d’accès du Home', masterSecretPresent: 'Présent', masterSecretUnavailable: 'Indisponible', inspectAction: 'Actualiser les détails du Home', actionsTitle: 'Sauvegarde et restauration', protectionTitle: 'Protection', backupsSectionFooter: 'Les sauvegardes contiennent des conversations lisibles, les données du Home, l’état des appareils de confiance et le secret d’accès du Home. Conserve-les uniquement dans un emplacement de confiance.', lastBackupTitle: 'Dernière sauvegarde', lastBackupUnknown: 'Dernière sauvegarde inconnue', backupsTitle: 'Archives de sauvegarde', backupAction: 'Sauvegarder maintenant', backupSubtitle: 'Crée et vérifie une archive Home en clair.', exportBackupAction: 'Exporter la sauvegarde…', exportBackupSubtitle: 'Crée une sauvegarde vérifiée à l’emplacement de ton choix.', verifyAction: 'Vérifier la sauvegarde…', verifySubtitle: 'Vérifie une archive sans la restaurer.', restoreAction: 'Restaurer…', restoreSubtitle: 'Valide une sauvegarde avant de remplacer les données du Home.', relocateAction: 'Déplacer le Home…', relocateSubtitle: 'Déplace ce Home vers un ordinateur géré.', relocationFinishAction: 'Terminer le déplacement', relocationReturnAction: 'Revenir au Home d’origine', relocationFinishSubtitle: 'Termine le déplacement après vérification de la destination.', relocationReturnSubtitle: 'Garde le Home d’origine comme emplacement actif.', recoverRestoreSubtitle: 'Une restauration interrompue peut être annulée explicitement.', restoreRecoveryWarningTitle: 'La restauration doit être réparée', restoreRecoveryWarningBody: 'L’état de récupération est ambigu. Aucun changement automatique ne sera effectué. Consulte les diagnostics avant de réparer ce Home.', restoreCleanupWarningTitle: 'Le nettoyage de la restauration nécessite ton attention', restoreCleanupWarningBody: 'Le Home a été restauré, mais le nettoyage automatique ne s’est pas terminé. Consulte les diagnostics et réessaie l’opération du Home.', backupVerified: 'Sauvegarde vérifiée', backupNeedsAttention: 'Sauvegarde vérifiée ; le redémarrage du Home nécessite ton attention', backupHomeReady: 'Home redémarré', backupRevealAction: 'Afficher la sauvegarde', restoreResultTitle: 'Résultat de la restauration', restoreOutcomeRecoveryRequired: 'Récupération nécessaire', restoreOutcomeRolledBack: 'Restauration annulée', restoreOutcomeRestored: 'Home restauré', advancedTitle: 'Avancé', advancedFooter: 'Contrôles du runtime et diagnostics de cet ordinateur.', restartAction: 'Redémarrer le Home personnel', openDataLocationAction: 'Ouvrir l’emplacement des données du Home', openLogsAction: 'Ouvrir les journaux du runtime', removeProfileAction: 'Retirer le Home de Happier', removeProfileSubtitle: 'Retire ce profil ; les données du runtime restent sur cet ordinateur.', removeProfileTitle: 'Retirer le profil du Home personnel ?', removeProfileBody: 'Le profil sera retiré, mais le runtime et les données seront conservés.', uninstallRuntimeAction: 'Désinstaller le runtime, garder les données', uninstallRuntimeSubtitle: 'Supprime le service et les binaires ; les données du Home sont conservées.', deleteHomeDataTitle: 'Supprimer les données du Home', removeSectionFooter: 'La désinstallation conserve les données du Home. La suppression définitive est une action confirmée distincte.', eraseDataAction: 'Supprimer définitivement les données du Home personnel', eraseDataSubtitle: 'Distincte de la désinstallation. Supprime définitivement les données résolues du Home.', eraseResultTitle: 'Données du Home supprimées', eraseStoppedHome: 'Le Home en cours d’exécution a été arrêté', eraseHomeAlreadyStopped: 'Le Home était déjà arrêté', eraseRemainingPaths: 'Impossible de supprimer', progressTitle: 'Opération du Home personnel', dismissResult: 'Fermer',
    repairSearchAction: 'Reconstruire la recherche du Home',
    repairSearchSubtitle: 'Recrée l’index de recherche à partir des conversations de ce Home.',
    repairSearchCompleteTitle: 'Recherche du Home reconstruite',
    repairSearchCompleteBody: 'L’index de recherche a été recréé à partir des conversations de ce Home.',
    backupCleanupRequired: 'La sauvegarde est intacte ; supprime le chemin de préparation protégé indiqué dans les détails',
    backupCleanupPath: 'Chemin de préparation protégé à supprimer',
    backupCleanupError: 'Erreur de nettoyage',
    backupDestinationMismatch: 'La sauvegarde n’a pas été créée à la destination sélectionnée. Rien n’a été supprimé.',
    backupDestinationUnsafe: 'La destination de sauvegarde sélectionnée se trouve dans les données du Home personnel qui seraient supprimées. Rien n’a été supprimé.',
    eraseInspectionAttention: 'Données du Home supprimées ; la vérification nécessite ton attention',
    searchTitle: 'Recherche',
    searchReady: 'Prête',
    searchIndexing: 'Indexation…',
    searchUnavailable: 'Indisponible',
    localOnlyIngressTitle: 'Accessible uniquement depuis cet ordinateur',
    localOnlyIngressBody: 'Les partages publics, les rappels de fournisseurs, les webhooks de plugins et les notifications pendant la veille de cet ordinateur restent indisponibles tant que ce Home n’est pas joignable depuis l’extérieur.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { fr: 'Cette sauvegarde contient des conversations lisibles, les données du Home, le secret d’accès du Home et l’état des appareils de confiance. Toute personne capable de restaurer l’archive complète peut exploiter un clone de ce Home. Enregistre-la dans un emplacement de confiance.' } as const;

const eraseBackupOffer = { fr: { title: 'Sauvegarder ce Home d’abord ?', body: 'La suppression des données du Home est irréversible. Crée d’abord une sauvegarde vérifiée ou continue sans sauvegarde.', continueWithoutBackup: 'Continuer sans sauvegarde' } } as const;

const operationOutcome = { fr: {
        erasePartialTitle: 'Certaines données du Home n’ont pas pu être supprimées',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed} ${removed <= 1 ? 'élément supprimé' : 'éléments supprimés'}`
            + (remaining > 0 ? `; ${remaining} ${remaining === 1 ? 'n’a pas pu être supprimé' : 'n’ont pas pu être supprimés'}` : ''),
        eraseNotPerformed: 'Rien n’a été supprimé',
        eraseBlockedBackupMismatch: 'Cette sauvegarde provient d’un autre Home.',
        eraseBlockedIdentityUnknown: 'Happier n’a pas pu confirmer que cette sauvegarde correspond à ce Home.',
        eraseVerificationDetail: 'Vérification',
        operationFailed: 'Cette opération du Home ne s’est pas terminée. Ouvre les détails pour voir ce qui s’est passé.',
        restorePreviousDataTitle: 'Données précédentes enregistrées',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "fr">;

const personalHomeSettingsTranslations = { fr: { ...fr, ...operationOutcome.fr, backupDisclosureBody: backupDisclosureBody.fr, eraseBackupOfferTitle: eraseBackupOffer.fr.title, eraseBackupOfferBody: eraseBackupOffer.fr.body, eraseContinueWithoutBackup: eraseBackupOffer.fr.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const fr: PersonalizeTranslation = {
    cardTitle: 'Personnaliser Happier',
    cardSubtitle: 'Six choix rapides, chacun avec un aperçu en direct.',
    cardAction: 'Personnaliser',
    cardContinue: 'Continuer',
    cardProgress: ({ saved, total, step }) => `Choix enregistrés : ${saved} sur ${total}. Reprenez à l’étape ${step}.`,
    cardProgressReview: ({ saved, total }) => `Choix enregistrés : ${saved} sur ${total}. Vérifiez votre configuration.`,
    inPlaceTitle: 'Faites de Happier le vôtre',
    inPlaceBody: 'Six choix rapides, chacun avec un aperçu en direct. Commencez par son aspect — Home change au fil de vos choix.',
    inPlaceContinue: ({ count }) => `Continuer · encore ${count}`,
    notNow: 'Pas maintenant',
    flowTitle: 'Personnaliser Happier',
    finishLater: 'Terminer plus tard',
    later: 'Plus tard',
    stepEyebrow: ({ n, total, name }) => `Étape ${n} sur ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} sur ${total}`,
    styleEyebrow: 'Facultatif',
    summaryEyebrow: 'Tout est prêt',
    previewNote: 'Aperçu. Rien n’est enregistré tant que vous n’appuyez pas sur Suivant.',
    previewNoteSummary: 'Votre espace de travail, tel qu’il est maintenant.',
    next: 'Suivant',
    review: 'Vérifier',
    useThisSetup: 'Utiliser cette configuration',
    saveFailed: 'Cette étape n’a pas été enregistrée. Votre choix reste sélectionné.',
    tryAgain: 'Réessayer',
    skipThisStep: 'Passer cette étape',
    scopeThisDevice: 'Cet appareil',
    scopeAllDevices: 'Tous vos appareils',
    stepsLabel: 'Étapes',
    savedStepsNote: ({ count }) => count === 1 ? '1 étape est déjà enregistrée.' : `${count} étapes sont déjà enregistrées.`,
    lookName: 'Aspect',
    lookTitle: 'Mettez-vous à l’aise',
    lookDescription: 'Clair, sombre ou selon votre système, et la quantité de verre affichée par l’app.',
    themeLabel: 'Thème',
    glassLabel: 'Verre',
    glassAutoDescription: 'Du verre dans toute l’app, en couches',
    glassEverywhereDescription: 'Un même verre partout',
    glassSolidDescription: 'Toutes les surfaces opaques',
    glassCustomNote: 'Vous avez réglé le verre dans Apparence. Choisissez un préréglage pour le remplacer, ou gardez le vôtre.',
    customizeInAppearance: 'Personnaliser dans Apparence…',
    styleName: 'Style',
    styleTitle: 'Partir d’un style',
    styleDescription: 'Chaque style définit la lecture des sessions et l’aspect de la liste. Il préremplit seulement les étapes suivantes : rien n’est enregistré tant que vous n’appuyez pas sur Suivant à chacune.',
    styleKeep: 'Garder ma configuration actuelle',
    styleActivity: 'Activité',
    styleConversation: 'Conversation',
    styleDetail: 'Détail',
    styleCustomTag: 'Personnalisé',
    styleDefaultTag: 'Réglage par défaut de Happier',
    styleChanges: ({ style, count }) => count === 1 ? `${style} modifie 1 réglage` : `${style} modifie ${count} réglages`,
    styleNoChanges: 'C’est déjà votre configuration.',
    styleNever: 'Le thème, les notifications, la confidentialité et les autorisations des agents ne font jamais partie d’un style.',
    was: ({ value }) => `avant : ${value}`,
    conversationName: 'Conversation',
    conversationTitle: 'Suivre la conversation',
    conversationDescription: 'Comment se lisent les tours d’une session et la réflexion de l’agent.',
    layoutLabel: 'Disposition',
    thinkingLabel: 'Réflexion',
    toolsName: 'Appels d’outils',
    toolsTitle: 'Voir ce que l’agent a fait',
    toolsDescription: 'Comment les commandes, modifications et lectures apparaissent dans une session.',
    toolsLabel: 'Appels d’outils',
    toolTapLabel: 'Clic sur un outil',
    toolDetailLabel: 'Détail des outils',
    toolDetailDefault: 'Par défaut',
    toolDetailFull: 'Complet',
    workName: 'Votre travail',
    workTitle: 'Retrouver votre travail',
    workDescription: 'Comment la liste des sessions est organisée et ce que chaque ligne affiche.',
    listLayoutLabel: 'Liste des sessions',
    rowsLabel: 'Lignes',
    attentionName: 'Attention',
    attentionTitle: 'Repérer ce qui vous attend',
    attentionDescription: 'Où se placent dans la liste les sessions qui vous attendent ou sont prêtes à être vérifiées.',
    attentionLabel: 'Sessions qui ont besoin de vous',
    attentionHomeNote: 'Home montre toujours ce qui a besoin de vous. Ceci ne change que la liste des sessions.',
    notificationsName: 'Notifications',
    notificationsTitle: 'Restez informé',
    notificationsDescription: 'Ce que cet appareil vous signale quand vous regardez autre chose.',
    notificationsAllowed: 'Les notifications sont autorisées sur cet appareil.',
    notificationsNotAllowed: 'Happier ne peut pas encore afficher de notifications sur cet appareil.',
    notificationsUnsupported: 'Les notifications ne sont pas disponibles sur cet appareil. Configurez-les dans l’application de bureau ou sur votre téléphone.',
    scopeLook: 'Thème sur cet appareil · verre sur tous vos appareils',
    notificationsNeedsYouSummary: 'Besoin de vous',
    notificationsFinishedSummary: 'Terminé',
    notificationsAllow: 'Autoriser les notifications',
    notificationsTellMe: 'Me prévenir quand',
    notificationsNeedsYou: 'Une session attend une approbation ou une réponse',
    notificationsFinished: 'Une session termine son tour',
    notificationsShowLabel: 'Les notifications affichent',
    notificationsShowDescription: 'Les commandes, questions et réponses peuvent apparaître sur votre écran verrouillé.',
    notificationsMessage: 'Le message',
    notificationsStatus: 'Seulement le statut',
    notificationsPhoneNote: 'Les alertes sur votre téléphone quand Happier est fermé se règlent sur le téléphone.',
    notificationsOff: 'Aucune notification',
    sampleNeedsYouTitle: 'Revue #2481 a besoin de vous',
    sampleNeedsYouBody: 'L’agent veut exécuter yarn test:e2e dans ~/happier. Autoriser ?',
    sampleReadyTitle: '« Corriger le test de reconnexion instable » est prêt',
    sampleReadyBody: 'Trouvé : le minuteur de nouvelle tentative n’était jamais effacé. C’est corrigé et le test passe.',
    sampleStatusBody: 'Ouvrez Happier pour le voir.',
    sampleSessionReconnect: 'Corriger le test de reconnexion instable',
    sampleSessionCraft: 'Labo de finitions',
    sampleSessionReview: 'Revue #2481',
    sampleSessionPricing: 'Textes de la page Tarifs',
    sampleSessionDocs: 'Index de recherche de la doc',
    sampleWorking: 'En cours',
    sampleNeedsYou: 'Vous attend',
    sampleReady: 'Prêt à vérifier',
    summaryTitle: 'Voici votre configuration',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Tout ce qui suit est déjà enregistré. Rien n’a changé.'
        : changed === 1
            ? 'Tout ce qui suit est déjà enregistré. Un choix a changé ; le reste est resté tel quel.'
            : `Tout ce qui suit est déjà enregistré. ${changed} choix ont changé ; le reste est resté tel quel.`,
    summaryChange: 'Modifier',
    summaryFooter: 'Vous pourrez modifier tout cela plus tard dans Réglages, ou le reprendre depuis Réglages → Apparence.',
    replayTitle: 'Personnaliser Happier',
    replaySubtitle: 'Six choix rapides, chacun avec un aperçu en direct.',
    replayAction: 'Commencer',
    journeyHandoff: 'Faites-le vôtre',
};

const personalizeTranslations = { fr } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "fr">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const fr: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'La disposition téléphone dans les sessions et les gestes de sa barre. Chaque geste peut être désactivé séparément.',
            swipeSidewaysTitle: 'Glisser sur le côté pour changer de session',
            swipeSidewaysScrollsDescription: 'Précédente ou suivante, sur la barre. Quand vos outils ne tiennent pas, glisser les fait défiler à la place.',
            swipeSidewaysAlwaysDescription: 'Précédente ou suivante, sur la barre. Cela reste un glissement ; les outils qui ne tiennent pas attendent dans Plus.',
            alwaysSwipeTitle: 'Toujours glisser entre les sessions',
            alwaysSwipeOnDescription: 'La barre garde les outils qui tiennent ; le reste attend dans Plus.',
            alwaysSwipeOffDescription: 'Désactivé : les outils en plus font défiler la barre.',
            dragUpTitle: 'Tirer vers le haut pour changer',
            dragUpDescription: 'Tirez la barre vers le haut pour voir vos onglets ouverts et vos sessions récentes, puis glissez vers l’une d’elles.',
            dragUpSourceTitle: 'Tirer vers le haut affiche',
            dragUpSourceRecentDescription: 'Les onglets ouverts, puis ce que vous avez ouvert récemment sur cet appareil.',
            dragUpSourceListDescription: 'Les sessions dans l’ordre de la liste.',
            swipeSourceTitle: 'Glisser sur le côté affiche',
            swipeSourceListDescription: 'La session suivante ou précédente de votre liste.',
            swipeSourceRecentDescription: 'La suivante ou la précédente selon la dernière ouverture.',
            sourceRecent: 'Récentes',
            sourceList: 'Liste des sessions',
            flickTitle: 'Balayer vers le haut ou le bas pour changer',
            flickDescription: 'Un balayage rapide ouvre la suivante ou la précédente.',
            holdToDockTitle: 'Maintenir pour garder le sélecteur ouvert',
            holdToDockDescription: 'Maintenez la barre puis relâchez pour choisir d’un tap.',
            pullAllTabsTitle: 'Tirer le titre vers le bas pour tous les onglets',
            pullAllTabsDescription: 'Tirez le titre de la session vers le bas pour voir tous les onglets ouverts et les sessions récentes.',
        },
        bar: {
            onTheBar: 'Sur la barre',
            more: 'Plus',
            heldInMore: 'Dans Plus tant que « Toujours glisser » est activé',
            keepOnBar: 'Garder sur la barre',
            removeFromBar: 'Retirer de la barre',
            openFiles: 'Ouvrir les fichiers',
        },
        allTabs: {
            title: 'Tous les onglets',
            pullHint: 'Tirez pour tous les onglets',
            releaseHint: 'Relâchez pour tous les onglets',
            openTabs: 'Onglets ouverts',
            openTabsSynced: 'Onglets ouverts · synchronisés',
            recent: 'Récentes',
            recentOnThisDevice: 'Récentes sur ce téléphone',
            here: 'Ici',
            panes: ({ count }: { count: number }) => `${count} volets`,
            emptyTitle: 'Rien d’autre n’est ouvert',
            emptyDescription: 'Les sessions que vous ouvrez et les onglets que vous gardez apparaissent ici, les plus récents d’abord.',
            openTab: ({ title }: { title: string }) => `Ouvrir ${title}`,
        },
        rail: {
            label: 'Onglets ouverts',
            synced: 'Synchronisés',
            syncedA11y: 'Les onglets ouverts se synchronisent entre vos appareils',
            notAvailableTitle: 'Indisponible sur ce téléphone',
            notAvailableUnknown: 'Cet onglet a été ouvert sur un autre appareil et ce téléphone ne peut pas l’afficher. Il y reste ouvert.',
            closeTab: 'Fermer l’onglet',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} sur ${total}`,
            nextPane: 'Volet suivant',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Passer à',
            allSessions: 'Toutes les sessions',
            openTabs: 'Onglets ouverts',
            synced: 'synchronisés',
            recent: 'Récentes',
            recentOnThisDevice: 'Récentes sur ce téléphone',
            sessions: 'Sessions',
            nextInSessions: 'Suivante dans Sessions',
            previousInSessions: 'Précédente dans Sessions',
            furtherBack: 'Plus loin',
            moreRecent: 'Plus récent',
            here: 'Ici',
            stayOn: 'Rester sur',
            noOlderSessions: 'Aucune session plus ancienne',
            noNewerSessions: 'Aucune session plus récente',
            lastInSessions: 'C’est la dernière de Sessions.',
            firstInSessions: 'C’est la première de Sessions.',
            nothingFurtherBack: 'Rien de plus ancien.',
            mostRecent: 'C’est la plus récente.',
            nothingToSwitch: 'Rien d’autre n’est ouvert',
            nothingToSwitchDescription: 'Les sessions que vous ouvrez apparaissent ici, les plus récentes d’abord.',
            draft: ({ text }: { text: string }) => `Votre brouillon : « ${text} »`,
            switchSessionAction: 'Changer de session',
            switchedTo: ({ name }: { name: string }) => `Passé à ${name}`,
            close: 'Fermer',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} sur ${total}`,
        },
    },
};

const phoneNavigationTranslations = { fr };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { fr: {
    accountDataErase: {
        installedGroupTitle: 'Données du Compte',
        installedGroupFooter: 'Cela n’affecte que les données conservées pour le Compte actuel. Cela ne désinstalle ce plugin d’aucune machine.',
        installedEntryTitle: 'Effacer les données du Compte',
        installedEntrySubtitle: 'Supprime définitivement les données conservées par ce plugin dans le Compte actuel.',
        orphanedGroupTitle: 'Données de plugin conservées',
        orphanedGroupFooter: 'Utilise un ID de plugin pour supprimer les données conservées du Compte après la suppression d’un plugin.',
        orphanedEntryTitle: 'Effacer les données de plugin conservées',
        orphanedEntrySubtitle: 'Saisis l’ID d’un plugin installé ou supprimé pour effacer définitivement ses données du Compte actuel.',
        promptTitle: 'ID du plugin',
        promptBody: 'Saisis l’ID du plugin dont tu veux effacer les données conservées du Compte actuel.',
        promptPlaceholder: 'com.exemple.plugin',
        invalidTitle: 'Saisis un ID de plugin',
        invalidBody: 'Utilise l’ID exact du plugin avant de continuer.',
        confirmTitle: 'Effacer les données de plugin du Compte ?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Cela supprime définitivement les données conservées de ${pluginId} dans le Compte actuel. Cela ne désinstalle pas le plugin de tes machines.`,
        confirm: 'Effacer les données',
        completedTitle: 'Données de plugin du Compte effacées',
        completedChanged: 'Les données de plugin conservées ont été supprimées du Compte actuel.',
        completedEmpty: 'Aucune donnée conservée n’a été trouvée pour ce plugin dans le Compte actuel.',
        partialTitle: 'Certaines données de plugin subsistent',
        partialBody: 'Certaines données conservées n’ont pas pu être effacées. Rien ne sera réessayé automatiquement ; relance l’action pour effacer le reste.',
        failedTitle: 'Les données de plugin n’ont pas été effacées',
        failedBody: 'Les données conservées n’ont pas pu être effacées. Réessaie après avoir vérifié la connexion au Compte actuel.',
        unavailableTitle: 'Les données de plugin sont indisponibles',
        unavailableBody: 'Le Compte actuel a changé ou est indisponible. Rouvre cette action quand le Compte sera prêt.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { fr: {
    accountReleaseSelection: {
        groupTitle: 'Libération du compte',
        groupFooter: 'Sélectionnez une version exacte pour ce compte. Cela n’installe, ne met à jour ou ne fait confiance au plugin sur aucune machine.',
        entryTitle: 'Utiliser pour ce compte',
        entrySubtitle: ({ version }: { version: string }) => `Sélectionnez la version ${version} pour le compte actuel sans modifier aucune installation de machine.`,
        selectedTitle: 'Libération du compte sélectionnée',
        selectedBody: 'La version du plugin sélectionnée sera désormais utilisée pour ce compte.',
        conflictTitle: 'La version du compte a été modifiée',
        conflictBody: 'La version du compte a changé pendant que cette action était ouverte. Rouvrez-le et réessayez.',
        unavailableTitle: 'Libération de compte indisponible',
        unavailableBody: 'La version exacte ou sa source de migration requise n\'est pas disponible pour le compte actuel. Réessayez lorsque le compte est prêt.',
        rejectedTitle: 'La libération du compte n\'a pas été sélectionnée',
        rejectedBody: 'Le compte n\'a pas accepté cette sélection de version. Vérifiez l\'état du compte et réessayez.',
        hostedGroupFooter: 'Gère les artefacts que ce compte héberge pour le plugin. Aucune machine ne propose actuellement cette version, elle ne peut donc pas être sélectionnée ici.',
        hostedEnableTitle: 'Héberger les artefacts du plugin pour ce compte',
        hostedEnableBody: "Stocke l’interface et les ressources du paquet sur le serveur de ton compte. Pour les comptes en clair, le serveur peut lire les données ; avec E2EE, il stocke des données chiffrées. Les métadonnées de version restent visibles. Cela n’installe pas le plugin, ne lui accorde pas de confiance et ne permet pas l’exécution hors ligne sur une machine.",
        hostedDisableTitle: 'Arrêter d’héberger les artefacts du plugin',
        hostedStatusDisabled: "Désactivé. Active l’hébergement pour télécharger les artefacts de cette version lorsque sa machine source est hors ligne.",
        hostedStatusPending: 'Activé. Cette version attend que l’hôte publie les artefacts exacts du plugin.',
        hostedStatusReady: 'Les artefacts du plugin hébergés sont disponibles pour cette version exacte.',
        hostedRemoveTitle: 'Désactiver l’hébergement et supprimer les artefacts',
        hostedRemoveBody: 'Arrête l’hébergement par le compte et supprime les artefacts du plugin hébergés de cette version. Le nettoyage du cache local est distinct.',
        hostedClearCacheTitle: 'Vider le cache local des artefacts',
        hostedClearCacheBody: 'Supprime les octets d’artefacts d’interface mis en cache localement pour cette version exacte, sans modifier l’hébergement par le compte.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { fr: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.fr) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const pluginInvocationLogTranslations = { fr: {
    invocationLogs: {
        title: 'Journaux d’invocation',
        footer: 'Enregistrements limités et expurgés provenant de la machine de plugin sélectionnée.',
        correlationFilter: 'Filtre par ID de corrélation',
        correlationFilterAll: 'Toutes les invocations de ce plugin',
        correlationPromptTitle: 'Filtrer par ID de corrélation',
        correlationPromptBody: 'N’affiche que les enregistrements d’une invocation de plugin exacte. Laisse ce champ vide pour tout afficher.',
        correlationPromptPlaceholder: 'ID de corrélation',
        refresh: 'Actualiser les journaux',
        follow: 'Suivre les journaux',
        stopFollowing: 'Arrêter le suivi',
        loadMore: 'Charger les enregistrements suivants',
        loadingTitle: 'Chargement des journaux d’invocation',
        loadingSubtitle: 'Lecture des enregistrements limités et expurgés depuis la machine sélectionnée.',
        idleTitle: 'Prêt à lire les journaux d’invocation',
        idleSubtitle: 'Actualise pour lire les enregistrements limités et expurgés de la machine sélectionnée.',
        emptyTitle: 'Aucun journal d’invocation',
        emptySubtitle: 'Aucun enregistrement expurgé correspondant n’est disponible sur cette machine sélectionnée.',
        unavailableTitle: 'Journaux d’invocation indisponibles',
        unavailableSubtitle: 'La machine de plugin sélectionnée est indisponible ou n’est plus l’actuelle.',
        readerUnavailableSubtitle: 'La machine de plugin sélectionnée ne peut pas fournir de journaux d’invocation pour le moment.',
        selectionRequiredTitle: 'Sélectionne une machine de plugin',
        selectionRequiredSubtitle: 'Choisis au-dessus une matérialisation de plugin compatible avant de lire ses journaux.',
        conflictTitle: 'Résous la machine de plugin sélectionnée',
        conflictSubtitle: 'Choisis au-dessus une matérialisation de plugin compatible avant de lire ses journaux.',
        errorTitle: 'Impossible de charger les journaux d’invocation',
        errorSubtitle: 'La lecture des journaux n’a pas abouti. Réessaie quand la machine sélectionnée sera disponible.',
        noMessage: 'Événement de journal du plugin',
        level: {
            debug: 'Débogage',
            info: 'Informations',
            warn: 'Avertissement',
            error: 'Erreur',
            diagnostic: 'Diagnostic',
        },
    },
} } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { fr: {
        machineMatrix: {
            title: 'Sur vos machines',
            footer: 'Lecture seule. L’installation, la mise à jour et toutes les autres actions de plugin s’exécutent sur la machine sélectionnée ci-dessus.',
            empty: 'Aucune machine n’a encore signalé d’installation de plugin pour ce compte.',
            unavailable: 'La disponibilité des plugins du compte n’est pas encore chargée : les états des machines sont donc inconnus.',
            incomplete: ({ count }: { count: number }) => `Cette liste peut être incomplète : ${count} serveur(s) n’ont pas encore signalé leurs machines.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Installé et à jour sur ${installed} machine(s) sur ${total}`,
            lastObserved: ({ ago }: { ago: string }) => `dernière observation : ${ago}`,
            state: {
                installedCurrent: 'Installé et à jour',
                disabled: 'Désactivé',
                untrusted: 'Non approuvé',
                incompatible: 'Version différente',
                localOnly: 'Local à cette machine',
                staleOffline: 'Dernier état connu, machine hors ligne',
                absent: 'Non installé',
                unknown: 'Inconnu',
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

const marketplacePresentation = { fr: {
        diagnosticsIssueTitle: 'Problème de plugin', diagnosticsRecovery: 'Consultez le détail ci-dessus, puis rechargez le plugin ou cette page après correction.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Code technique : ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Étiquette d’éditeur : ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Catégories : ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `S’exécute dans : ${realms} · Plateformes : ${platforms}`, reviewStatus: { curated: 'Recommandation sélectionnée', unreviewed: 'Non examiné', withdrawn: 'Retiré' }, executableRealm: { daemon: 'service en arrière-plan', client: 'application', hostedWeb: 'web hébergé' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problème de source de marketplace', recovery: 'Actualisez Découvrir. Si le problème persiste, vérifiez Sources et registres.', unreachableTitle: ({ source }: { source: string }) => `Impossible de joindre ${source}`, behindTitle: ({ source }: { source: string }) => `${source} a répondu avec des données anciennes ou incomplètes`, indexTitle: 'L’index des plugins est incomplet', otherSourcesShown: 'Les résultats des autres sources restent affichés.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { fr: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind} : ${locator}`, sourceKind: { path: 'Chemin local', archive: 'Fichier d’archive', npm: 'Paquet npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind} : ${source}`, marketplaceSourceKind: { curated: 'Catalogue sélectionné', 'community-npm': 'Catalogue npm public', user: 'Catalogue personnel' }, executableRealm: { daemon: 'Code du service en arrière-plan', reactNative: 'Code de l’interface de l’application', hostedWeb: 'Code web hébergé isolé' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status} : ${ids}`, uiArtifactStatus: { verified: 'Artefacts d’interface vérifiés', none: 'Aucun artefact d’interface', unavailable: 'Artefacts d’interface indisponibles' }, authorizationClass: { cooperativeDisclosure: 'Divulgation coopérative', hostResourceSelection: 'Ressources de l’hôte sélectionnées', presentIntentOrOs: 'Intention actuelle ou autorisation du système' }, priority: ({ priority }: { priority: number }) => `Priorité ${priority}` } } as const;

const localizedReviewVocabulary = { fr: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.fr,
            archiveUrlRetention: 'Happier conserve l’URL complète de l’archive sur la machine sélectionnée, y compris les éventuels identifiants, pour les futures mises à jour. Une URL expirée ou révoquée peut faire échouer une mise à jour.',
            trustedCodeTitle: 'Code de confiance', trustedCodeDisclosure: 'Les plugins s’exécutent comme du code de confiance dans Happier, pas dans un bac à sable. Un plugin peut utiliser directement les droits de cette application — fichiers, réseau, environnement et processus — au-delà des services médiatisés par Happier listés ci-dessous. Cette liste est ce que le plugin a déclaré et ce que tu peux désactiver ensuite, pas une limite de ce que son code peut atteindre.', identity: 'Identité et paquet', evidence: 'Éléments techniques', executableCode: 'Code exécutable et contributions', requiredAccess: 'Accès requis à l’hôte', optionalAccess: 'Accès facultatif à l’hôte', requestInterceptors: 'Intercepteurs de requêtes', rawCredentials: 'Déclarations d’accès direct aux identifiants', compatibility: 'Compatibilité et mises à jour', none: 'Aucune déclaration', scope: ({ scope }: { scope: string }) => `Portée : ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · développement`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · non vérifié`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (attendue)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (observée)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Signature du registre vérifiée : ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Signature du registre non prise en charge : ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Déclarée, non vérifiée : ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Récupérée, non vérifiée : ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Provenance indisponible : ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Source de catalogue non examinée : ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Examinée par ${sourceId} le ${reviewedAt}${reason}`, savedSecret: 'Secret enregistré', connectedAccount: 'Compte connecté', secretKinds: ({ kinds }: { kinds: string }) => `Types de secrets : ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Service associé : ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Finalité : ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Utilisé dans ${realm} pendant ${phase}`, credentialAccess: ({ access }: { access: string }) => `Accès accordé : ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `En-têtes envoyés à ${origin} : ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Variables d’environnement : ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Fichiers : ${files}`, realm: { web: 'le navigateur', ios: 'l’application iOS', android: 'l’application Android', daemon: 'le service en arrière-plan' }, phase: { settings: 'la configuration', prepare: 'la préparation', connection: 'la connexion', speech: 'l’utilisation vocale' }, runtimeApi: ({ version }: { version: number }) => `API d’exécution ${version}`,
        },
        sourceAdministration: { title: 'Sources et registres', subtitle: 'Choisissez où cette machine découvre les paquets npm exacts et comment elle accède à leurs registres.', communityTitle: 'Répertoire npm public', communitySubtitle: 'Intégré · découverte non examinée de plugins Happier admissibles sur npm public, pas de paquets npm quelconques.', configuredTitle: 'Sources de la place de marché', configuredEmpty: 'Aucune source supplémentaire configurée.', add: 'Ajouter une source', edit: 'Modifier la source', remove: 'Supprimer la source', removeTitle: 'Supprimer cette source ?', removeBody: ({ name }: { name: string }) => `${name} ne servira plus à la découverte sur cette machine. Les plugins installés ne changent pas.`, sourceUrl: 'Adresse de la source', displayName: 'Nom affiché', description: 'Description facultative', enabled: 'Activée', disabled: 'Désactivée', curated: 'Source sélectionnée', user: 'Votre source', loadError: 'Impossible de charger les sources de la place de marché.', retry: 'Réessayer', operationFailed: 'Impossible d’appliquer cette modification. Vérifiez la connexion à la machine et réessayez.', operationOutcomeUnknownTitle: 'Changement à examiner', operationOutcomeUnknownBody: 'La machine sélectionnée a peut-être déjà appliqué ce changement, mais Happier n’a pas pu confirmer le résultat. Vérifiez les réglages actualisés avant de les modifier à nouveau.' },
        updatePolicy: { title: 'Règle de mise à jour', target: ({ machine, server }: { machine: string; server: string }) => `S’applique sur ${machine} via ${server}.`, pinned: 'Version épinglée', pinnedSubtitle: 'Ne pas mettre à jour avant le choix d’une autre règle.', allowed: 'Mises à jour autorisées', allowedSubtitle: 'Les mises à jour explicites continuent sans nouvelle demande sauf si les autorisations déclarées augmentent.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { fr: {
        ...localizedReviewVocabulary.fr,
        ...marketplacePresentation.fr,
        secretFieldActions: { delete: 'Supprimer le secret enregistré', deleteHint: 'Efface la valeur enregistrée. C’est irréversible.', unbind: 'Retirer de ce plugin', unbindHint: 'Détache le secret enregistré de ce réglage. Le secret lui-même est conservé.' },
        pluginChangeOutcomeUnknownTitle: 'Résultat non confirmé',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier n’a pas pu confirmer si ${action} pour ${name} s’est terminé sur ${machine} (${server}). Regarde la liste Installés de cette machine et sa version actuelle avant de réessayer.`,
        updateFromInstalledRecordSubtitle: 'Faire avancer cette installation via son propre canal de mise à jour approuvé.',
        discover: {
            ...marketplacePresentation.fr.discover,
            status: {
                loading: 'Recherche dans toutes les sources de marketplace…',
                loadingSource: ({ source }: { source: string }) => `Recherche dans ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} plugin(s) provenant de ${sources} source(s)`,
                empty: 'Aucun plugin ne correspond à cette recherche.',
                error: ({ message }: { message: string }) => `La recherche n’a pas pu être actualisée : ${message}`,
                errorTitle: 'La recherche n’a pas pu être actualisée',
                stale: 'Ces résultats correspondent à une recherche précédente. Relancez la recherche pour appliquer les réglages ci-dessus.',
                partial: ({ count }: { count: number }) =>
                    `${count} source(s) ont répondu avec des données plus anciennes ou manquantes : les résultats peuvent être incomplets.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `${count} entrée(s) ont été trouvées mais ne peuvent pas être installées sur cette machine pour le moment.`,
            },
            sourceFreshness: {
                stale: 'Plus ancien que cette source',
                'stale-offline': 'Derniers résultats connus, source hors ligne',
                unavailable: 'Source indisponible',
                'auth-unavailable': 'Connexion requise pour cette source',
                corrupt: 'L’index de la source n’a pas pu être lu',
            },
            nonInstallableReason: {
                sourceStale: 'Sa source de marketplace n’est pas à jour.',
                artifactUnavailable: 'Son paquet est inaccessible avec l’accès au registre de cette machine.',
                notApproved: 'Son installation n’est pas approuvée depuis cette source.',
                unsupportedSourceKind: 'Ce type de source n’est pas pris en charge par cette version de Happier.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Examinez tout ce que ce plugin déclare avant d’accorder votre confiance à ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Nécessite un profil de registre pour ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Choisir un registre pour ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} est publié sur ${origin}. Choisissez le profil de registre que ${source} utilise sur cette machine, ou ajoutez-en un et connectez-vous. Rien n’est téléchargé avant l’examen d’installation et de confiance.`,
                continue: 'Continuer',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { fr: {
        fields: {
            pluginId: 'ID du plugin',
            capability: 'Capacité',
            scope: 'Portée',
            requester: 'Demandeur',
            authority: 'Autorité',
            requestedAt: 'Heure de la demande',
            reason: 'Motif',
        },
        scope: { account: 'Compte', project: 'Projet', workspace: 'Espace de travail' },
        requester: { user: 'Utilisateur', host: 'Hôte', plugin: 'Plugin' },
        authority: { bundled: 'Intégré', machineInstallation: 'Installation sur la machine' },
        identifiers: {
            session: 'Séance',
            request: 'Demande',
            machine: 'Machine',
            installation: 'Mise en place',
        },
        accessibilitySummary: ({ details }) => `Détails de la demande de permission. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "fr">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { fr: {
        rowStatus: { enabled: 'Activé', disabled: 'Désactivé', incompatible: 'Non compatible', trustRemoved: 'Confiance retirée', needsAttention: 'À vérifier' },
        developmentPhase: { observing: 'Surveillance', preparingDependencies: 'Préparation des dépendances', compiling: 'Compilation', validating: 'Validation', active: 'Actif', retainedIncumbent: 'Version précédente active', unavailable: 'Indisponible' },
        rowSource: { bundled: 'Inclus avec Happier', npm: 'Paquet npm', archive: 'Fichier d’archive', localPath: 'Dossier local', other: 'Source configurée' },
        rowAttention: { trustRemoved: 'Ce plugin ne s’exécute plus. Réinstallez-le pour faire à nouveau confiance à son code.', incompatible: 'Cette version ne peut pas s’exécuter sur la machine sélectionnée.' },
        developerGroupTitle: 'Développement',
        developerGroupFooter: 'Créez des plugins sur la machine sélectionnée et consultez ce que son service rapporte.',
        developerDevelopmentSubtitle: 'Créez, modifiez, testez et empaquetez des plugins depuis vos propres dossiers.',
        developerDiagnosticsSubtitle: 'Diagnostics du service et du catalogue pour la machine sélectionnée.',
        detailMissingTitle: 'Ce plugin n’est pas sur la machine sélectionnée',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} n’est pas installé ici. Il a peut-être été désinstallé, ou il se trouve sur une autre machine.`,
        detailMissingRetry: 'Vérifier à nouveau',
        surfaces: {
            purpose: 'Ajoutez des surfaces, des commandes et des intégrations à Happier. Les plugins s’exécutent comme du code de confiance sur vos machines.',
            navigationTitle: 'Plugins',
            updatesTitle: 'Mises à jour',
            moreDescriptionInSettings: 'D’où viennent les plugins, créer les vôtres et ce que cette machine signale. Ces pages s’ouvrent dans les Réglages.',
            fix: 'Corriger',
            allSources: 'Toutes les sources',
            shelfCurated: 'Sélection',
            shelfCuratedDescription: 'Vérifiés et recommandés par Happier. Chaque installation affiche quand même son examen complet.',
            shelfCommunity: 'Communauté',
            shelfCommunityDescription: 'Paquets npm non vérifiés. Installer et faire confiance montre exactement ce à quoi chacun peut accéder.',
            shelfUser: 'Vos sources',
            shelfUserDescription: 'Annonces des sources de marketplace ajoutées sur cette machine.',
            manage: 'Gérer',
            installed: 'Installé',
            notShownTitle: 'Tout n’a pas pu être affiché',
            listingInstallsOn: ({ machine }: { machine: string }) => `S’installe sur ${machine}. Vous examinez ses accès avant toute exécution.`,
            listingChooseMachine: 'Choisissez une machine dans l’en-tête pour installer ce plugin.',
            listingRunsIn: 'S’exécute dans',
            listingPlatforms: 'Plateformes',
            listingSource: 'Source',
            listingCategories: 'Catégories',
            listingNotFoundTitle: 'Cette annonce n’est pas disponible',
            listingNotFoundBody: 'Elle a peut-être été retirée de sa source, ou cette machine ne peut pas joindre la source pour le moment.',
            developmentSourcesTitle: 'Plugins en développement',
            chooseMachineInstalled: 'Choisissez une machine dans l’en-tête pour voir ses plugins.',
            chooseMachineBrowse: 'Choisissez une machine dans l’en-tête pour parcourir les plugins qu’elle peut installer.',
            openAsPage: 'Ouvrir en page',
            detailInstalledLabel: 'Plugin installé',
            detailListingLabel: 'Fiche du plugin',
            viewLabel: 'Afficher en',
            viewGrid: 'Grille',
            viewList: 'Liste',
            installedSearchPlaceholder: 'Rechercher dans les plugins installés',
            statusFilterLabel: 'Afficher les plugins',
            statusAll: 'Tous les plugins',
            statusEnabled: 'Activés',
            statusDisabled: 'Désactivés',
            statusAttention: 'À vérifier',
            noMatch: ({ query }: { query: string }) => `Aucun plugin ne correspond à « ${query} »`,
            clearSearch: 'Effacer',
            emptyTitle: 'Aucun plugin installé pour l’instant',
            emptyBody: 'Les plugins ajoutent des panneaux, des commandes et des outils pour vos agents. Commencez par ceux faits par Happier.',
            browsePlugins: 'Parcourir les plugins',
            browseEmpty: 'Vos sources ne proposent encore aucun plugin.',
            forDevelopers: 'Pour les développeurs',
            readFailedTitle: 'Impossible de lire les plugins de cette machine',
            readFailedBody: 'Rien n’a été modifié. Réessayez pour interroger à nouveau la machine.',
            lastKnown: ({ status }: { status: string }) => `Dernier état connu · ${status}`,
            machinesTitle: 'Machines',
            machinesDescription: 'Où ce plugin est installé.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `À jour sur ${current} machine(s) sur ${total}`,
            onMachines: ({ count }: { count: number }) => `Sur ${count} machines`,
            onMachine: ({ machine }: { machine: string }) => `Sur ${machine}`,
            addedGroup: 'Ajoutés',
            machinesRetained: 'Une machine qui n’est plus sur ce compte',
            open: 'Ouvrir',
            review: 'Examiner',
            seeAll: 'Tout voir',
            allResults: 'Tous les résultats',
            categoriesLabel: 'Catégories',
            runOnNoneChosen: 'Aucune machine choisie',
            runOnNoneAvailable: 'Aucune machine ne peut encore l’exécuter',
            runsEverywhere: 'Sur chaque machine qui exécute Happier',
            kinds: {
                agent: 'Agent',
                providers: 'Fournisseur de modèles',
                scmHostingProviders: 'Hébergement de code',
                scmBackends: 'Gestion de versions',
                voice: 'Voix',
                connectedAccounts: 'Service connecté',
                inputTypes: 'Types de saisie',
                mcp: 'Outils MCP',
                pluginUi: 'Panneaux de l’app',
                pluginBrowser: 'Vues navigateur',
                composer: 'Outils du compositeur',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const fr = {
    title: 'Vérification des mises à jour',
    confirmSubtitle: 'Les mises à jour qui élargissent l’accès accordé vous demandent d’abord.',
    autoApplySubtitle: 'Les mises à jour s’appliquent sans demander, même si leur accès s’élargit.',
    confirmOption: 'Demander',
    autoApplyOption: 'Automatique',
};

const pluginUpdateReviewTranslations = { fr: fr };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { fr: {
    webhookAdministration: {
        title: 'Webhooks de plugin',
        footer: 'Endpoints du compte, cibles machine exactes, files de livraison et récupération des dead letters. Le contenu des livraisons n’est jamais affiché ici.',
        unavailableTitle: 'Les webhooks de plugin sont indisponibles',
        unavailableSubtitle: 'Ce serveur n’a pas activé la réception des webhooks de plugin.',
        endpointsTitle: 'Endpoints webhook',
        emptyTitle: 'Aucun endpoint webhook de plugin',
        emptySubtitle: 'Les endpoints créés par les plugins installés restent visibles ici, y compris ceux dont la cible est indisponible.',
        loadError: 'L’état des webhooks n’a pas pu être chargé.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `En file ${queued} · nouvelles tentatives ${retrying} · réservées ${claimed} · lettre morte ${deadLetter}`,
        copyUrl: 'Copier l’URL du webhook',
        selectTarget: 'Sélectionner la cible de livraison',
        retarget: 'Rediriger l’endpoint',
        retargetUnavailable: 'Sélectionne une matérialisation de plugin exacte et disponible avant de rediriger cet endpoint.',
        originSelected: 'La matérialisation de plugin exacte sélectionnée sera revérifiée quand tu continueras.',
        originUnavailable: 'Aucune matérialisation de plugin exacte et disponible n’est sélectionnée.',
        movePendingTitle: 'Déplacer les livraisons en attente ?',
        movePendingBody: 'Déplacer les livraisons en file et en dead letter vers la nouvelle cible exacte ? Les livraisons activement réservées restent sur leur cible actuelle.',
        resumePendingMove: 'Reprendre le déplacement des livraisons en attente',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} livraisons en file ou en dead letter utilisent encore la cible exacte précédente.`,
        configureCredential: 'Configurer les identifiants de signature',
        rotateCredential: 'Faire tourner les identifiants de signature',
        finishRotation: 'Terminer la rotation des identifiants',
        finishRotationSubtitle: 'Cesser d’accepter les identifiants précédents dès maintenant.',
        credentialSecretTitle: 'Enregistre le nouveau secret de signature',
        credentialSecretBody: ({ secret }: { secret: string }) => `Ce secret n’est affiché qu’une fois. Enregistre-le avant de fermer ce message.\n\n${secret}`,
        revoke: 'Révoquer l’endpoint',
        revokeTitle: 'Révoquer l’endpoint webhook ?',
        revokeBody: 'Les nouvelles livraisons vers cet endpoint seront rejetées. Les métadonnées de livraison existantes restent disponibles selon la politique de rétention.',
        operationFailed: 'L’opération sur le webhook n’a pas abouti. Actualise l’état actuel avant de réessayer.',
        deliveryTitle: ({ digest }: { digest: string }) => `Lettre morte ${digest}`,
        deliveryStatus: 'État de la livraison',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} tentatives · ${replays} rejeux · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} admissions d’Automatisation non résolues`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Exemple : ${sample} · ${omittedCount} non affichées`,
        replay: 'Rejouer la livraison',
        discardTitle: 'Abandonner la livraison ?',
        discardBody: 'Le contenu de livraison stocké, chiffré ou en clair, sera supprimé et ne pourra pas être récupéré.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { fr: translated({
        profilesPage: {
            searchPlaceholder: "Rechercher des profils de lancement",
            emptyTitle: "Aucun profil de lancement pour le moment",
            newProfileTitle: "Nouveau profil de lancement",
            notFoundTitle: 'Ce profil n\'existe plus',
            notFoundDescription: 'Il a peut-être été supprimé depuis un autre appareil.',
            backToProfiles: "Retour aux profils de lancement",
            discardDraft: 'Abandonner',
            detailDescription: 'Utilisé quand une nouvelle session démarre avec ce profil.',
            builtInDetailDescription: 'Un profil prêt à l\'emploi. Enregistrer vos modifications crée votre propre copie.',
            enabledHint: 'Proposé quand vous choisissez un profil pour une nouvelle session.',
            pickerSection: 'Sélecteur de profil',
            pickerSectionDescription: 'Où ce choix apparaît quand vous démarrez une session.',
            showFirst: 'Afficher en premier',
            showFirstDescription: 'Affiche l\'environnement de la machine parmi vos favoris.',
            environmentDescription: 'Variables d\'environnement définies quand une session démarre avec ce profil. Les valeurs peuvent faire référence aux variables de la machine.',
            descriptionTitle: 'Description',
            descriptionHint: 'Facultatif. Affichée quand vous choisissez ce profil.',
            modelRequiresAgent: 'Choisissez d’abord un agent préféré pour choisir son modèle.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const fr: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        gateway: {
            railGroup: 'Passerelles',
            managedFromConnectedServices: 'Géré depuis Services connectés',
            description: 'Permet à n’importe quel agent d’utiliser vos abonnements.',
            statusUnavailable: ({ machine }: { machine: string }) => `Indisponible · ${machine} est hors ligne`,
            offlineTitle: ({ machine }: { machine: string }) => `${machine} est hors ligne`,
            offlineDescription: ({ gateway, machine }: { gateway: string; machine: string }) => `Les sessions ne peuvent pas utiliser ${gateway} tant que ${machine} n’est pas de retour, ou que vous n’avez pas choisi un autre ordinateur ci-dessous. Rien d’autre n’est essayé à sa place.`,
            modelsFromTitle: 'Modèles issus de',
            modelsFromDescription: 'Les abonnements sur lesquels s’appuie cette passerelle. Choisissez un compte ou un pool pour chacun ; ils ne sont jamais mélangés.',
            slotUnused: ({ service }: { service: string }) => `Les modèles ${service} ne sont pas proposés via cette passerelle.`,
            slotConnect: ({ service }: { service: string }) => `Connectez un compte ${service} pour l’utiliser ici.`,
            connect: 'Connecter',
            runsOnTitle: 'S’exécute sur',
            runsOnDescription: 'L’endroit où la passerelle démarre quand une session en a besoin. Les requêtes vont toujours aux abonnements ci-dessus.',
            runsOnSession: 'L’ordinateur de chaque session',
            runsOnChosen: 'Un ordinateur choisi',
            runsOnSessionDescription: 'Une passerelle par ordinateur, partagée par toutes les sessions qui s’y trouvent.',
            runsOnChosenDescription: 'Une passerelle sur l’ordinateur de votre choix. Les sessions de vos autres ordinateurs y accèdent via Happier.',
            computerTitle: 'Ordinateur',
            computerChoose: 'Choisir un ordinateur',
            computerChooseDescription: 'Choisissez où la passerelle s’exécute.',
            computerOnline: 'En ligne · pas encore vérifié depuis vos autres ordinateurs',
            computerOnlineReachable: 'En ligne · vos autres ordinateurs peuvent y accéder',
            computerOnlineUnreachable: 'En ligne · vos autres ordinateurs ne peuvent pas y accéder',
            computerOffline: 'Hors ligne',
            computerGone: 'N’est plus l’un de vos ordinateurs',
            modelPickerTitle: 'Sélecteur de modèles',
            showInPickerGateway: 'Désactivé par défaut pour les passerelles, afin que les mêmes modèles n’apparaissent pas deux fois. Ils restent accessibles depuis « Passe par ».',
            modelsAvailable: ({ count }: { count: number }) => `${count} disponibles`,
            helperTitle: 'Modèles auxiliaires de Claude Code',
            helperDescription: 'Claude Code confie les tâches secondaires à un modèle rapide, un modèle par défaut et un modèle plus puissant. Choisissez lequel est utilisé pour chacun sur cette passerelle. Les définitions d’agent qui nomment un modèle le conservent.',
            helperFast: 'Rapide',
            helperDefault: 'Par défaut',
            helperStrongest: 'Le plus puissant',
            helperSameAsSession: 'Comme la session',
            detailsTitle: 'Détails',
            whatToKnow: 'À savoir',
            whatToKnowTitle: 'Vos abonnements, hors de leurs propres apps',
            whatToKnowDescription: 'Les services derrière ces abonnements ne prennent pas en charge cet usage. Les requêtes peuvent être refusées et leurs conditions peuvent changer. Happier n’envoie une requête qu’au compte ou au pool choisi ci-dessus.',
            useExternalEndpoint: 'Utiliser plutôt un endpoint externe',
            poolSectionTitle: 'Utiliser dans d’autres agents',
            poolSectionDescription: ({ agents }: { agents: string }) => `${agents} se connecte directement à ce pool. Les autres agents accèdent aux mêmes comptes via une passerelle.`,
            poolSectionDescriptionGeneric: 'Les agents qui se connectent avec ce service utilisent ce pool directement. Les autres agents accèdent aux mêmes comptes via une passerelle.',
            poolSwitchVia: ({ gateway }: { gateway: string }) => `via ${gateway}`,
            poolSwitchDescription: ({ service }: { service: string }) => `D’autres agents peuvent exécuter des modèles ${service} depuis ce pool.`,
            poolSwitchHeldBy: ({ gateway, current, service }: { gateway: string; current: string; service: string }) => `${gateway} utilise actuellement ${current} pour les modèles ${service}.`,
            poolSwitchNeedsComputer: 'Un de vos ordinateurs doit être en ligne pour modifier cela.',
            poolReplaceTitle: ({ gateway, pool }: { gateway: string; pool: string }) => `Basculer ${gateway} vers ${pool} ?`,
            poolReplaceDescription: ({ pool, service, current }: { pool: string; service: string; current: string }) => `Les nouvelles sessions dans d’autres agents utiliseront ${pool} pour les modèles ${service}. ${current} garde ses comptes, et les sessions en cours conservent ce avec quoi elles ont démarré.`,
            poolReplaceConfirm: 'Basculer',
            compareNative: ({ agents }: { agents: string }) => `Dans ${agents}`,
            compareNativeGeneric: 'Avec sa propre connexion',
            compareOther: 'Dans d’autres agents',
            compareRunsThrough: 'Passe par',
            compareOwnSignIn: ({ service }: { service: string }) => `La connexion propre à ${service}`,
            compareSupported: ({ service }: { service: string }) => `Pris en charge par ${service}`,
            compareSupportedYes: 'Oui',
            compareSupportedNo: 'Non. Expérimental ; les requêtes peuvent être refusées',
            compareLimits: 'Limites',
            compareLimitsNative: 'Les limites de ce pool',
            compareLimitsShared: 'Les mêmes limites, partagées',
        },
        connectionDescription: 'Enregistré dans votre compte. Fonctionne sur tous vos ordinateurs.',
        apiKeySavedDescription: 'Conservée comme secret enregistré. Jamais réaffichée.',
        modelsShownCount: ({ count }: { count: number }) => `${count} affichés`,
        showInPickerTitle: 'Afficher dans le sélecteur de modèles',
        showInPickerDirect: ({ provider }: { provider: string }) => `Activé par défaut pour les fournisseurs directs. Les modèles de ${provider} apparaissent dans chaque agent capable de les exécuter.`,
        showInPickerManyModels: 'Désactivé par défaut pour les fournisseurs qui proposent beaucoup de modèles. Ils restent accessibles depuis « Passe par ».',
        showInPickerLocal: 'Activé par défaut pour les modèles qui tournent sur vos ordinateurs.',
        showInPickerAction: 'Afficher dans le sélecteur',
        onThisComputerTitle: 'Sur cet ordinateur',
        onThisComputerNoComputer: 'Aucun ordinateur sélectionné. Choisissez-en un pour tester cette connexion ou changer la façon de la joindre.',
        endpointAccessTitle: 'Accès au point de terminaison',
        endpointAccessDirect: ({ machine, host }: { machine: string; host: string }) => `${machine} joint ${host} directement.`,
        endpointAccessDirectValue: 'Direct',
        localRuntimeTitle: 'Exécution locale',
        onMachine: ({ machine }: { machine: string }) => `Sur ${machine}`,
        onAComputerTitle: 'Sur un ordinateur',
        localNoComputer: 'Choisissez un ordinateur pour voir les serveurs de modèles qui y tournent.',
        localOfflineDetail: 'Ses serveurs de modèles ne peuvent pas être vérifiés.',
        localNoneFound: 'Aucun serveur de modèles trouvé ici.',
        invitationAccountDescription: 'Connectez un fournisseur une fois et ses modèles apparaissent dans chaque agent capable de les exécuter. Aucun ordinateur n’est nécessaire pour commencer.',
        subscriptionsPointerLead: 'Les abonnements comme Claude et ChatGPT se trouvent dans ',
        subscriptionsPointerLink: 'Services connectés',
        subscriptionsPointerTail: '.',
        addTitle: ({ provider }: { provider: string }) => `Ajouter ${provider}`,
        addDescription: ({ provider }: { provider: string }) => `Ajoutez une clé et les modèles de ${provider} apparaissent dans chaque agent capable de les exécuter.`,
        addKeyDescription: 'Conservée comme secret enregistré dans votre compte.',
        connectedTitle: ({ provider }: { provider: string }) => `${provider} est connecté`,
        connectedHiddenCountDescription: ({ provider, count }: { provider: string; count: number }) => `${count} modèles sont prêts. Ils sont masqués du sélecteur par défaut, car ${provider} propose beaucoup de modèles que vous avez peut-être déjà. Choisissez-en un à tout moment depuis « Passe par », ou affichez-les tous.`,
        connectedHiddenDescription: ({ provider }: { provider: string }) => `Ses modèles sont masqués du sélecteur par défaut, car ${provider} propose beaucoup de modèles que vous avez peut-être déjà. Choisissez-en un à tout moment depuis « Passe par », ou affichez-les tous.`,
        description: 'Connecte une source de modèles une fois et utilise ses modèles avec chaque agent compatible.',
        foundOn: ({ machine }: { machine: string }) => `Trouvé sur ${machine}`,
        foundOnThisMachine: 'Trouvé sur cette machine',
        connect: 'Connecter',
        start: 'Démarrer',
        test: 'Tester',
        addProvider: 'Ajouter un provider',
        customEndpoint: 'Endpoint personnalisé',
        menuOwnCategory: 'Le tien',
        menuCatalogCategory: 'Du catalogue',
        newTitle: 'Nouveau provider',
        emptyDescription: 'Ajoute un provider du catalogue, ou ton propre endpoint compatible.',
        machineScopeLabel: 'Configuré sur',
        invitationTitle: 'Apporte tes propres modèles',
        invitationDescription: 'Connecte un provider une fois et ses modèles apparaissent dans le sélecteur de modèles de chaque agent compatible. Les serveurs locaux comme Ollama tournent sur ta machine.',
        invitationNeedsMachine: 'Les providers sont connectés et vérifiés sur l’une de tes machines. Ajoute une machine pour commencer.',
        setUpMachine: 'Configurer une machine',
        duplicateAsCustom: 'Copier comme provider personnalisé',
        discard: 'Abandonner',
        enabled: 'Activé',
        enabledDescription: 'Proposer ses modèles dans les sélecteurs de modèles des agents',
        saved: 'Enregistrée',
        replace: 'Remplacer',
        addKey: 'Choisir une clé',
        apiKeyDefaultDescription: 'Utilisée sur chaque machine, sauf si une machine a sa propre clé.',
        apiKeyMachineDescription: 'Utilisée sur cette machine à la place de la clé par défaut.',
        availabilityTitle: 'Disponibilité',
        availabilityDescription: 'Où les agents peuvent utiliser ce provider.',
        modelsDescription: 'Choisis les modèles que les agents proposent dans leurs sélecteurs de modèles.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} sur ${total} affichés dans les sélecteurs de modèles`,
        modelsFilter: ({ count }: { count: number }) => `Filtrer ${count} modèles`,
        connectionTitle: 'Connexion',
        nameDescription: 'Affiché dans la liste des fournisseurs et dans les sélecteurs de modèles.',
        nameRequired: 'Ajoutez un nom.',
        nameTooLong: ({ max }: { max: number }) => `Utilisez ${max} caractères au maximum.`,
        managedTitle: 'Service local géré',
        endpointsTitle: 'Endpoints',
        endpointsDescription: 'Laisse vide pour utiliser les adresses fournies par le provider.',
        overridesDescription: 'Où vont les requêtes. Change l’adresse pour toutes les machines, ou seulement pour celle-ci.',
        afterSavingTitle: 'Après l’enregistrement',
        destinationDescription: 'Où Happier enverra les requêtes de ce provider.',
        destinationPending: 'Apparaît une fois tous les endpoints remplis.',
    },
};

const providerCollectionTranslations = { fr } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { fr: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Provider : ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Provider : ${provider} · ${connection}`,
        changedTitle: 'Réglages du provider modifiés',
        changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Cette session utilise toujours la configuration ${provider} · ${connection} avec laquelle elle a démarré.`,
        unavailableTitle: 'Provider plus disponible',
        unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} n’est plus disponible pour reprendre cette session.`,
        disabledTitle: 'Le provider est désactivé',
        disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Active ${provider} · ${connection} avant de reprendre cette session.`,
        incompatibleTitle: 'Provider plus compatible',
        incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} n’est plus compatible avec l’agent de cette session.`,
        restartAction: 'Redémarrer la session',
        chooseModelAction: 'Choisir un modèle',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const fr: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label} : ${title}. Aller au constat`,
    tag: { noFile: 'Sans fichier', outdated: 'Obsolète', unplaced: 'Impossible à situer', notInStory: 'Hors des étapes' },
    outdatedSummary: 'Le code a changé après la revue.',
    askAboutFindingA11y: ({ title }) => `Poser une question sur le constat : ${title}`,
    tailTitle: 'Constats sans étape',
    tailDescription: 'Ils restent ici pour que rien ne disparaisse quand leurs lignes ne peuvent pas être situées.',
    inContext: 'en contexte',
    fromReviewAt: ({ time }) => `de la revue de ${time}`,
    reviewLabel: 'Revue :',
    enginesOf: ({ count, total }) => `${count} sur ${total}`,
    enginesFinished: 'moteurs terminés',
    enginesRunning: ({ count }) => (count === 1 ? '1 moteur relit encore' : `${count} moteurs relisent encore`),
    fromEngines: ({ engines, inStory }) => `de ${engines} · ${inStory} dans le parcours`,
    and: ' et ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} dans le parcours, ${elsewhere} ailleurs`,
    allInStory: 'tous dans le parcours',
    seeded: {
        title: 'Écrit après la revue, par une nouvelle exécution.',
        body: ({ reviewers, time }) => `Le narrateur n’a pas relu le code ; chaque constat cité ici vient de ${reviewers} à ${time}.`,
        changed: ({ count }) => (count === 1 ? '1 fichier a changé depuis.' : `${count} fichiers ont changé depuis.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 constat de ${engine}` : `${count} constats de ${engine}`),
    publishedBefore: ({ time }) => `publiés à ${time}, avant le parcours`,
    steps: {
        reviewing: 'Revue en cours',
        engineProgress: ({ done, running }) => `${done} terminé · ${running} en cours`,
        reviewed: ({ count }) => (count === 1 ? 'Relu · 1 constat' : `Relu · ${count} constats`),
        reviewedShort: ({ count }) => `Relu · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 constat` : `${engine} · ${count} constats`),
        reviewedAt: ({ time }) => `Relu à ${time}`,
        reviewAt: ({ time }) => `Revue de ${time}`,
        partial: ({ count }) => (count === 1 ? 'Revue partielle · 1 constat' : `Revue partielle · ${count} constats`),
        ready: 'Parcours prêt',
        readyShort: 'Parcours',
        failed: 'Le parcours a échoué',
        narrating: 'Narration',
        narratorWriting: ({ narrator }) => `${narrator} écrit`,
        writing: 'Écriture du parcours',
        writingShort: 'Écriture',
    },
    writingWithFindings: 'Écriture du parcours avec les constats…',
    dialog: {
        engines: 'Moteurs de revue',
        selected: ({ count }) => `${count} sélectionnés`,
        loadingEngines: 'Recherche des moteurs de revue…',
        noEngines: 'Aucun moteur de revue ne peut tourner sur la machine de cette session.',
        findingsOnly: 'constats uniquement',
        changes: 'Modifications',
        instructions: 'Instructions',
        instructionsPlaceholder: 'Sur quoi la revue doit-elle porter ?',
        defaultInstructions: 'Relis ces modifications : exactitude, risques et tests manquants.',
        alsoWalkthrough: 'Écrire aussi un parcours',
        alsoWalkthroughBody: 'Une fois les constats arrivés, la même exécution écrit le parcours avec eux en contexte. Rien ne relit les modifications deux fois.',
        narrator: 'Narrateur',
        chooseNarrator: 'Choisir un narrateur',
        narratorSeveral: ({ count }) => `${count} moteurs relisent ; un modèle écrit le parcours à partir de tous leurs constats.`,
        narratorFindingsOnly: ({ engine }) => `${engine} renvoie des constats, pas de texte. Un modèle écrit le parcours à partir d’eux.`,
        noNarrator: 'Aucun de ces moteurs ne peut écrire de parcours. Ajoutez un moteur à modèle ou désactivez le parcours.',
        footerReviewThenWalkthrough: 'Revue, puis écriture du parcours',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} relit · ${narrator} écrit`,
    },
    generated: {
        continues: ({ model }) => `${model} · poursuit la revue`,
        seeded: ({ model }) => `${model} · à partir des constats de la revue`,
        handover: ({ narrator, engine }) => `${narrator}, à partir des constats de ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `La revue de ${engines} ne s’est pas terminée.`,
        notClean: 'C’est une revue partielle, pas une revue sans constat.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} a terminé avec 1 constat.` : `${engines} a terminé avec ${count} constats.`),
        retry: ({ engine }) => `Relancer ${engine}`,
    },
    explain: { action: 'Expliquer les constats', running: 'Explication des constats', a11y: 'Demander une explication des constats dans le parcours', unknownModel: 'Modèle inconnu', requester: { user: 'un utilisateur', agent: 'un agent', plugin: 'une extension', automation: 'une automatisation', workflow: 'un flux de travail', unknown: 'un demandeur inconnu' }, header: ({ model, time, requester = 'vous' }) => `Explication de la revue · ${model} · demandée par ${requester} à ${time} · pas un verdict` },
    finished: {
        title: 'Revue terminée',
        openFindings: 'Ouvrir les constats',
        walkMeThrough: 'Fais-moi le parcours',
        andMore: ({ count }) => `et ${count} de plus`,
        continues: 'Poursuit cette exécution de revue : le relecteur l’écrit à partir de ce qu’il a déjà lu. Rien n’est réanalysé.',
        narrates: ({ count }) => (count === 1
            ? 'L’exécution de revue est terminée. Une nouvelle exécution écrit le parcours à partir de ce constat et des modifications ; elle ne relira pas.'
            : `L’exécution de revue est terminée. Une nouvelle exécution écrit le parcours à partir de ces ${count} constats et des modifications ; elle ne relira pas.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Revue lancée · ${engineCount} ${engineCount === 1 ? 'moteur' : 'moteurs'} · ${fileCount} ${fileCount === 1 ? 'fichier' : 'fichiers'}`,
        notStarted: ({ engines }) => `${engines} n’a pas démarré. Les autres relisent.`,
        narrationFailed: 'La revue a démarré, mais le parcours n’a pas pu être demandé. Les constats arriveront quand même.',
    },
};

const reviewWalkthroughTranslations = { fr: { reviewWalkthrough: fr } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { fr: {
        rail: {
            chooseEngine: 'Choisissez un moteur',
            unavailableRole: 'N’est plus disponible',
            label: 'Rôles',
            title: 'Rôle',
            searchPlaceholder: 'Rechercher des rôles…',
            empty: 'Aucun rôle pour l’instant.',
            emptyWithManage: 'Aucun rôle pour l’instant. Ajoutez-en un dans Gérer les rôles.',
            footer: 'Un rôle apporte ses instructions, son moteur et sa façon de s’exécuter, pour que les workflows restent portables.',
            manage: 'Gérer les rôles',
            engineAppliesOnStart: 'Le moteur s’applique au démarrage de ce rôle',
            defaultEngine: 'Agent par défaut',
            activeAccessibilityLabel: 'Rôles, un rôle est actif',
        },
        builtIn: {
            orchestrator: "Mène un travail et en confie des parties à d’autres agents",
            planner: "Établit le plan avant que rien ne soit construit",
            builder: "Fait la modification et vérifie qu’elle fonctionne",
            reviewer: "Relit une modification et indique quoi corriger",
            judge: "Tranche les constats contestés et dit quand un objectif est atteint",
            second_opinion: "Un contrôle indépendant avant d’aller plus loin",
            scout: "Parcourt le code et répond où se trouvent les choses",
            approval_reviewer: "Répond aux demandes d’autorisation à faible risque et te consulte pour le reste",
        },
        settings: {
            duplicate: 'Dupliquer',
            duplicateName: ({ name }) => `Copie de ${name}`,
            platformDefault: 'Valeur de la plateforme · suit les mises à jour',
            runsAsThisSession: 'Cette session',
            runsAsOrchestratorDescription: 'Un orchestrateur est la session dans laquelle vous l’activez.',
            readOnly: 'Lecture seule',
            engineChooseMigrated: 'Aucun moteur n’a été repris de la 0.2. Choisissez-en un, sinon le rôle suit votre agent par défaut.',
            description: 'Qui fait chaque type de travail. Les workflows et les orchestrateurs demandent un rôle ; le rôle dit comment l’exécuter.',
            count: ({ count }) => (count === 1 ? '1 rôle' : `${count} rôles`),
            newRole: 'Nouveau rôle',
            groupBuiltIn: 'Intégrés',
            groupYours: 'Les vôtres',
            groupShared: 'Partagés avec vous',
            groupPlugins: 'Des plugins',
            edited: 'Modifié',
            sourceBuiltIn: 'Intégré',
            sourceYours: 'À vous',
            sourceShared: 'Partagé avec vous',
            sourcePlugin: ({ plugin }) => `De ${plugin}`,
            migrated: 'des sous-agents 0.2',
            migratedNote: ({ names }) => (names.length === 1 ? `${names[0]} vient de vos consignes de sous-agents 0.2 : sa description est devenue les instructions, son agent et son modèle le moteur.` : `${names.join(', ')} viennent de vos consignes de sous-agents 0.2 : chaque description est devenue les instructions, chaque agent et modèle le moteur.`),
            nameTitle: 'Nom',
            newRoleName: 'Rôle sans titre',
            instructionsTitle: 'Consignes',
            instructionsDescription: 'Ce qu’il fait, quand l’utiliser et comment rendre compte. Les agents le lisent quand ils distribuent le travail.',
            resetToDefault: 'Rétablir la valeur par défaut',
            readOnlyNote: 'Le rôle original est en lecture seule. Personnalisez ici vos instructions ; Réinitialiser restaure l’original.',
            howItRunsTitle: 'Exécution',
            engineTitle: 'Moteur',
            engineDescription: 'Agent, modèle et effort.',
            engineFollowsDefault: 'Suit votre agent par défaut.',
            engineUnavailable: 'Indisponible ici. Choisissez un moteur.',
            runsAsTitle: 'S’exécute dans',
            runsAsSession: 'Session',
            runsAsBackgroundRun: 'Tâche de fond',
            runsAsSessionDescription: 'Une session que vous pouvez ouvrir et piloter.',
            runsAsBackgroundDescription: 'S’exécute en arrière-plan et rend compte ; aucune session à piloter.',
            handsOffTitle: 'Sans les mains',
            handsOffDescription: 'Planifie et délègue ; ne modifie pas de fichiers lui-même.',
            secondOpinionTitle: 'Deuxième avis',
            secondOpinionDescription: 'Encouragé lui demande d’envisager un deuxième avis avant une pull request ou avant de terminer.',
            secondOpinionOff: 'Désactivé',
            secondOpinionEncouraged: 'Encouragé',
            enabledTitle: 'Disponible',
            enabledDescription: 'Proposé dans le rail Rôles et aux orchestrateurs.',
            advancedTitle: 'Avancé',
            launchProfileTitle: 'Profil de lancement',
            launchProfileDescription: 'Environnement, permissions, machine',
            launchProfileNone: 'Aucun',
            profileUnavailable: 'Profil indisponible',
            previewTitle: 'Ce que lisent les agents',
            previewDescription: 'Le bloc envoyé à chaque tour, tel quel.',
            deleteRole: 'Supprimer le rôle',
            deleteConfirmTitle: 'Supprimer ce rôle ?',
            deleteConfirmBody: ({ name }) => `${name} est supprimé pour vous et tous ceux avec qui il est partagé. Les sessions qui l’utilisent gardent leur copie.`,
            share: 'Partager…',
            sendCopyFailed: 'Impossible d’envoyer une copie.',
            saveFailed: 'Impossible d’enregistrer le rôle.',
            loadFailed: 'Impossible de charger vos rôles.',
            emptyDetailTitle: 'Choisissez un rôle',
            emptyDetailBody: 'Choisissez un rôle pour voir ses instructions et son exécution.',
        },
        delegation: {
            title: 'Délégation',
            description: 'Comment les agents confient du travail à d’autres agents.',
            depthTitle: 'Profondeur de travail',
            approvalReviewer: 'Réviseur des autorisations',
            approvalReviewerDescription: 'Examiner automatiquement les demandes à faible risque, une seule fois. Les actions sensibles exigent votre accord. Modes Par défaut et Accepter les modifications uniquement.',
            approvedByReviewer: 'Autorisé une fois par le réviseur',
            depthDescription: 'Les sessions, tâches de fond et workflows lancés par des agents peuvent en lancer d’autres. Cette limite arrête les chaînes incontrôlées. Ce que vous lancez vous-même n’est jamais limité.',
            depthSetting: 'Jusqu’où les agents peuvent déléguer',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Un niveau. Au-delà, l’agent doit faire le travail lui-même.'
                : `${count} niveaux. Au-delà, l’agent doit faire le travail lui-même.`),
            ladderRoot: 'Le travail que vous lancez',
            ladderRootDetail: 'Lancé par vous · jamais limité',
            ladderLevel: ({ level }) => `Niveau ${level}`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "Lancé par un agent du travail que tu démarres" : `Lancé par un agent du niveau ${level - 1}`),
            ladderRefused: 'Une délégation de plus',
            ladderRefusedDetail: ({ level }) => `Niveau ${level} · refusé ; l’agent le fait lui-même`,
        },
        session: {
            refusal: {
                unenforceableTitle: 'Cet agent ne peut pas travailler sans les mains',
                unenforceableBody: 'Le rôle est « Sans les mains » et l’agent de cette session ne peut pas retenir ses propres modifications de fichiers. Désactivez « Sans les mains » pour ce rôle, ou démarrez-le dans une nouvelle session avec un agent qui le prend en charge.',
                restartRequiredTitle: 'Redémarrez la session pour passer en « Sans les mains »',
                restartRequiredBody: 'Cet agent n’applique « Sans les mains » qu’au démarrage de la session. Redémarrez la session, puis choisissez de nouveau le rôle.',
                roleUnavailableTitle: 'Ce rôle n’est plus disponible',
                roleUnavailableBody: 'Il a été supprimé, désactivé ou n’est plus partagé avec vous. Choisissez un autre rôle.',
            },
            useDefaults: 'Rôles par défaut',
            crossOwnerNote: 'Les rôles ont été copiés au démarrage.',
            addRole: 'Ajouter un rôle à cette session',
            addRoleConfirm: 'Ajouter le rôle',
            namePlaceholder: 'Nom du rôle',
            instructionsPlaceholder: 'Ce que fait ce rôle et quand l’utiliser',
            notesTitle: 'Notes',
            notesPlaceholder: 'Ce que chaque session en dessous doit savoir',
            applyToReports: 'Appliquer les rôles aux sessions en dessous',
            handsOffTitle: 'Sans les mains',
            handsOffDescription: 'Planifie et délègue ; ne modifie pas de fichiers.',
            saveFailed: 'Impossible d’enregistrer cette modification.',
            sectionTitle: 'Rôles',
            allRoles: 'Tous les rôles',
            inUse: ({ count }) => `${count} utilisés`,
            changed: 'modifié',
            thisSession: 'cette session',
            reset: 'Rétablir',
            newRoleForSession: 'Nouveau rôle pour cette session',
            changeForSession: 'Modifier pour cette session',
            editNotes: 'Modifier les notes',
            more: 'Plus',
            info: 'Les rôles s’appliquent à cette session et aux sessions en dessous.',
            countChanged: ({ count }) => `${count} modifiés`,
            countAdded: ({ count }) => `${count} ajoutés`,
            addNotes: 'Ajouter des notes sur la façon dont cette session doit orchestrer',
        },
        profiles: {
            sharedWithYouTitle: 'Partagés avec vous',
            sharedWithYouDescription: 'Profils que des personnes et des équipes partagent avec vous. Les valeurs secrètes restent chez leurs propriétaires.',
            share: 'Partager…',
            shareFailedTitle: 'Impossible de partager ce profil',
            shareNeedsSavedSecrets: 'Les valeurs secrètes ne voyagent jamais. Déplacez chaque valeur de ce profil dans un Secret enregistré, liez-le, puis partagez à nouveau.',
            shareAwaitingApproval: 'La publication de ce profil attend une approbation. Une fois approuvée, choisissez de nouveau « Partager… ».',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "fr">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { fr: {
        untitledRun: 'Exécution d’agent',
        intentTitles: { review: 'Revue', plan: 'Plan', delegate: 'Tâche déléguée' },
        thisMachine: 'cette machine',
        menu: {
            cancelResponse: 'Annuler cette réponse',
            copyResult: 'Copier le résultat',
            showInTranscript: 'Afficher dans la transcription',
            runDetails: 'Détails de l’exécution',
            agent: 'Agent',
            permissions: 'Autorisations',
            kind: 'Type',
            finishesOnItsOwn: 'Se termine seule',
            selectionInherited: 'Hérité de la session',
            selectionExplicit: 'Choisi pour cette exécution',
            selectionIndependent: 'Par défaut du compte',
            selectionRetained: 'Conservé depuis son lancement',
            selectionChoose: 'Choisir pour cette exécution',
            selectionChooseDetail: 'Choisir un modèle et par où il passe',
            staysOpen: 'Reste ouverte',
            started: 'Début',
            run: 'Exécution',
            process: 'Processus',
        },
        opening: { reading: ({ machine }) => `Lecture depuis ${machine}.` },
        gone: {
            title: ({ machine }) => `Cette exécution n’est plus sur ${machine}`,
            reason: 'Elle n’y est plus conservée, et la partie chargée de la transcription ne la contient pas.',
            closeTab: 'Fermer l’onglet',
        },
        stopFailed: {
            title: {
                review: 'Impossible d’arrêter cette revue',
                plan: 'Impossible d’arrêter ce plan',
                delegate: 'Impossible d’arrêter cette tâche',
                run: 'Impossible d’arrêter cette exécution',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} n’a pas confirmé l’arrêt. Vous pouvez arrêter toute la session : cela arrête aussi ${count === 1 ? 'l’autre agent' : `les ${count} autres agents`} qui y tournent.`,
            reasonAlone: ({ machine }) => `${machine} n’a pas confirmé l’arrêt. Vous pouvez arrêter toute la session.`,
            stopSession: 'Arrêter la session…',
        },
        steps: {
            title: 'Comment il y est arrivé',
            count: ({ count }) => (count === 1 ? '1 étape' : `${count} étapes`),
        },
        review: {
            findings: 'Constats',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} élevés`,
            severity: { blocker: 'Bloquant', high: 'Élevé', medium: 'Moyen', low: 'Faible', nit: 'Détail' },
            triageLabel: 'Que faire de ce constat',
            reviewerAsks: 'Le relecteur demande',
            answer: 'Répondre',
            askAboutThis: 'Poser une question',
            fixesSelected: ({ count }) => (count === 1 ? '1 correctif choisi' : `${count} correctifs choisis`),
            noFixesSelected: 'Choisissez les correctifs à appliquer',
            implementFixes: ({ count }) => (count === 1 ? 'Appliquer 1 correctif' : count > 1 ? `Appliquer ${count} correctifs` : 'Appliquer les correctifs'),
            couldNotSaveChoice: 'Impossible d’enregistrer votre choix.',
            reviewers: 'Relecteurs',
            findingTotal: ({ count }) => (count === 1 ? '1 constat' : `${count} constats`),
            moreFindings: ({ count }) => (count === 1 ? '1 constat de plus' : `${count} constats de plus`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 correctif à appliquer' : `${count} correctifs à appliquer`),
            verifiedFirst: 'Chacun est vérifié d’abord, puis corrigé',
            replies: ({ count }) => (count === 1 ? '1 réponse' : `${count} réponses`),
            updatedAfterQuestion: 'Mis à jour après votre question',
            reviewerUpdated: ({ reviewer }) => `${reviewer} a mis à jour le constat`,
            askPlaceholder: 'Posez une question sur ce constat…',
            askReviewerPlaceholder: 'Posez une question au relecteur…',
            toReviewer: ({ reviewer }) => `À ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Les questions vont à ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `En attente de ${reviewer}…`,
            waitingForAnswers: 'En attente des relecteurs…',
            both: 'Les deux',
            reviewerCount: ({ count }) => `${count} relecteurs`,
            askReviewersPlaceholder: 'Posez une question aux relecteurs…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Les questions vont aux deux relecteurs' : `Les questions vont aux ${count} relecteurs`),
            stillReviewing: 'Relecture en cours',
            reviewerDidNotFinish: 'N’a pas terminé',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Un relecteur n’a pas démarré' : `${count} relecteurs n’ont pas démarré`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} n’a pas pu démarrer.`,
            notSaved: 'Ce constat n’a pas été enregistré ; il ne peut pas encore recevoir de décision.',
            decisionsUnavailable: 'Impossible de charger vos décisions.',
            followUpUnavailable: {
                notResumable: 'Cette relecture est terminée ; les questions exigent une relecture qui reste ouverte.',
                ended: 'Cette relecture ne s’est pas terminée ; elle n’accepte pas de questions.',
                resumeUnavailable: 'Le relecteur n’est plus joignable sur cette machine.',
                busy: 'Le relecteur est encore occupé. Réessayez dans un instant.',
                failed: 'Impossible d’envoyer votre question.',
            },
        },
        launcher: {
            titles: { review: 'Demander une revue', plan: 'Demander un plan', delegate: 'Confier une tâche' },
            descriptions: {
                review: ({ machine }) => `Chaque agent relit les changements sur ${machine} de son côté ; vous recevez ici un résultat de chacun.`,
                plan: ({ machine }) => `L’agent lit le code sur ${machine} et propose un plan ici. Il ne modifie rien.`,
                delegate: ({ machine }) => `L’agent travaille sur ${machine} avec les autorisations ci-dessous et rend compte ici.`,
            },
            whatFor: 'Pour quoi',
            who: { review: 'Qui relit', plan: 'Qui planifie', delegate: 'Qui s’en charge' },
            selectedCount: ({ count }) => `${count} sélectionnés`,
            focus: {
                review: 'Sur quoi doivent-ils se concentrer ?',
                plan: 'Que doit couvrir le plan ?',
                delegate: 'Que doit-il faire ?',
            },
            optional: 'facultatif',
            start: {
                review: ({ count }) => (count > 1 ? `Lancer ${count} revues` : 'Lancer la revue'),
                plan: 'Lancer le plan',
                delegate: 'Lancer la tâche',
            },
            runsOn: ({ machine }) => `S’exécute sur ${machine}`,
            checking: 'Vérification des agents disponibles ici',
            unavailableTitle: 'Aucun agent ne peut démarrer dans cette session',
            unavailableReason: 'Sa machine ne propose pas de revues, de plans ni de tâches déléguées pour le moment.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "fr">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { fr: {
        scmComparison: translated({
            view: { files: 'Fichiers', walkthrough: 'Parcours', commits: 'Commits' },
            scope: {
                workingTree: 'Modifications en attente',
                session: 'Cette session',
                turn: 'Tour',
                latestTurn: 'Dernier tour',
                branch: ({ head, base }) => `${head} par rapport à ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `depuis ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'tour' : 'tours'} avec modifications`,
            scopePicker: {
                a11y: 'Modifications à afficher',
                branchChoice: 'Branche contre base',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Branche ou référence de tête',
                baseRef: 'Branche ou référence de base',
                parentRef: 'Référence parente (facultative)',
                explainAndCommit: 'Expliquer et committer',
                explainOnly: 'Expliquer seulement',
                unavailable: 'Indisponible pour cette session',
                pendingDescription: 'Sans commit · peut proposer des commits',
                sessionDescription: 'Tout ce qui a changé, début → maintenant',
                turnDescription: 'Dans l’ordre des modifications de l’agent',
                branchDescription: 'Modifications depuis la base commune',
                commitDescription: 'Modifications introduites par ce commit',
                pullRequestDescription: 'Modifications proposées par cette pull request',
            },
            fileCount: ({ count }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'modification' : 'modifications'}`,
            changedFiles: 'Fichiers modifiés',
            startReview: 'Lancer la revue',
            proposeCommits: 'Proposer des commits',
            explain: 'Expliquer',
            explainA11y: 'Expliquer : afficher les notes du parcours à côté des modifications',
            viewA11y: 'Vue',
            lockfileTag: 'Lockfile',
            generatedTag: 'Généré',
            lockfileCollapsed: 'Lockfile, replié.',
            generatedCollapsed: 'Fichier généré, replié.',
            showDiff: 'Afficher le diff',
            unsupportedReason: 'Fichiers ne peut pas encore afficher cette comparaison. Les modifications restent dans Git.',
            showPendingChanges: 'Afficher les modifications en attente',
            capturedStale: 'La source a changé. Ces fichiers conservent la comparaison capturée.',
            capturedFreshnessUnknown: 'Affichage des fichiers capturés. L’état actuel de la source n’a pas pu être vérifié.',
            keys: { nextFile: 'fichier suivant', nextChange: 'modification suivante' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const fr: SecretsSettingsCopy = {
    purpose: "Clés API et jetons pour les agents et serveurs MCP. Les valeurs enregistrées ne sont plus affichées.",
    yoursTitle: 'Vos secrets',
    yoursDescription: 'Les secrets que vous avez enregistrés ou possédez. Choisissez-les partout où Happier demande une clé.',
    sharedWithYouTitle: 'Partagés avec vous',
    sharedWithYouDescription: 'D’autres personnes vous permettent de les utiliser. Vous pouvez les choisir, mais pas les voir ni les modifier.',
    add: 'Ajouter un secret',
    newSecret: 'Nouveau secret',
    emptyTitle: 'Aucun secret pour l’instant',
    emptyDescription: 'Ajoutez une clé API ou un jeton une fois, puis choisissez-le partout où Happier en demande un.',
    staleTitle: 'Impossible d’actualiser les secrets partagés',
    staleDescription: 'La dernière liste connue est affichée.',
    valueTitle: 'Valeur',
    valueSaved: 'Enregistrée. Elle n’est plus jamais affichée.',
    keepTitle: 'Conserver en tant que',
    keepPersonal: 'Personnel',
    keepShared: 'Partagé',
    keepPersonalDescription: 'Stocké dans votre compte. Vous seul pouvez l’utiliser.',
    keepSharedDescription: 'Stocké sur ce Home pour que vous puissiez le partager avec des personnes, des Teams ou des Groupes.',
    accessTitle: 'Qui peut l’utiliser',
    accessOnlyYou: 'Vous seul',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Vous et 1 destinataire' : `Vous et ${count} destinataires`),
    sharePersonalDescription: 'Le partager le déplace sur ce Home. Il ne pourra plus redevenir personnel.',
    share: 'Partager',
    manage: 'Gérer',
    storageTitle: 'Stockage',
    storageE2ee: 'Chiffré de bout en bout',
    storageE2eeDescription: 'Seules les personnes avec qui vous le partagez peuvent le lire.',
    storagePlain: 'Géré par le Home',
    storagePlainDescription: 'Ce Home le stocke et peut le lire pour le transmettre.',
    save: 'Enregistrer le secret',
};

const secretsSettingsTranslations = { fr } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "fr": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Accès à la session",
        context: "Contexte de la session",
        search: "Rechercher des personnes, groupes ou équipes",
        hasAccess: "A accès",
        yourAccess: "Votre accès",
        readOnly: "Vous pouvez voir comment vous avez accès. Seuls les administrateurs de la session peuvent apporter des modifications.",
        sourceDirect: "Accès direct",
        sourceTeam: "Accès via une équipe",
        sourceGroup: "Accès via un groupe",
        people: "Personnes",
        groups: "Groupes",
        teams: "Équipes",
        account: "Personne",
        group: "Groupe",
        team: "Équipe",
        view: "Peut voir",
        edit: "Peut diriger",
        admin: "Administration",
        owner: "Propriétaire",
        private: "Privée",
        custom: "Accès personnalisé",
        required: "Requis par la politique de l’équipe",
        subjectNotFound: "Cette personne, ce groupe ou cette équipe n’est plus disponible.",
        subjectIneligible: "Cette personne, ce groupe ou cette équipe ne peut plus recevoir l’accès.",
        teamPolicyRequired: "La politique de l’équipe exige cet accès.",
        selfGrantManaged: "Un autre gestionnaire d’accès doit modifier votre accès.",
        homeUnsupported: "Ce Home ne prend pas encore en charge l’accès aux sessions. Mettez-le à jour pour gérer qui peut ouvrir cette session.",
        openCollaboration: "Ouvrir la collaboration",
        authenticationRequired: "Connectez-vous avec une méthode acceptée par cette équipe, puis réessayez.",
        authenticationUnavailable: "La méthode de connexion exigée par cette équipe n’est pas disponible sur ce Home.",
        delegation: "Peut approuver les demandes d’autorisation d’exécution",
        remove: "Retirer l’accès",
        confirmRemove: "Confirmer le retrait",
        credentialsLost: ({ names }: { names: string }) => `Ces identifiants d’équipe cesseront de fonctionner ici : ${names}`,
        ready: "Accès chiffré prêt",
        prepared: "Accès chiffré préparé",
        recipientRepairRequired: "Cette personne doit réparer la configuration du chiffrement de son compte.",
        pending: "Accès chiffré en attente",
        setup: "Configuration du chiffrement requise",
        repair: "L’accès chiffré nécessite une réparation",
        unavailable: "Contenu chiffré indisponible",
        notRequired: "Cette session n’est pas chiffrée : il n’y a rien à préparer.",
        preparing: "Préparation de l’accès chiffré…",
        preparingProgress: ({ count }: { count: number }) => `Préparation de l’accès chiffré… ${count} préparés`,
        preparationPending: ({ count }: { count: number }) => `Accès chiffré en attente pour ${count} personnes`,
        preparationSetup: ({ count }: { count: number }) => `${count} personnes doivent configurer le chiffrement`,
        preparationRepair: ({ count }: { count: number }) => `L’accès chiffré doit être réparé pour ${count} personnes`,
        preparationKeyUnavailable: "Cet appareil ne peut pas préparer l’accès chiffré pour cette session.",
        preparationFailed: "L’accès a été enregistré, mais la préparation de l’accès chiffré a échoué.",
        preparationPassFailed: "La préparation de l’accès chiffré a échoué.",
        preparationAnnouncedComplete: "Préparation de l’accès chiffré terminée.",
        preparationAnnouncedNeedsAttention: "L’accès chiffré nécessite encore une configuration ou une réparation.",
        preparationCheckFailed: "Impossible de vérifier l’accès chiffré.",
        outcomeUnknown: "Le résultat est incertain. Happier vérifie l’accès actuel avant que vous réessayiez.",
        historicalLayoutNotice: "Les personnes avec qui vous partagez cette session ne peuvent pas l’ouvrir tant qu’elle n’a pas été mise à jour pour cette version de Happier.",
        historicalLayoutUpdate: "Mettre à jour pour le partage",
        homeReconciled: "L’accès à la session a été réinitialisé pour le nouveau Home.",
        lockedTitleFallback: "Session chiffrée",
        encryptedAccess: "Accès chiffré",
        aggregatePrepared: ({ count }: { count: number }) => `${count} préparés`,
        aggregatePending: ({ count }: { count: number }) => `${count} en attente`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} à configurer ou réparer`,
        prepareNow: "Préparer maintenant",
        prepareAgain: "Préparer à nouveau",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Préparation de l’accès chiffré… ${count} sur ${total}`,
        showAllRecipients: "Afficher toutes les personnes",
        hideAllRecipients: "Masquer les personnes",
        moreRecipients: "Afficher plus de personnes",
        recipientPlainAccount: "Compte sans chiffrement",
        pendingBody: "Cette session est chiffrée. Un responsable doit encore préparer votre accès chiffré avant qu’elle s’ouvre ici.",
        setupBody: "Terminez la configuration du chiffrement sur ce compte, puis un responsable pourra préparer votre accès à cette session.",
        setupAction: "Configurer le chiffrement",
        repairBody: "La clé livrée pour cette session n’a pas pu être ouverte sur cet appareil. Réessayez ou demandez à un responsable de la session de préparer à nouveau l’accès.",
        retryAction: "Réessayer",
        unavailableBody: "La clé s’est ouverte, mais le contenu de cette session n’a pas pu être déchiffré. Un responsable de la session peut préparer à nouveau l’accès.",
        openAccessAction: "Ouvrir l’accès à la session",
        removedTitle: "Accès retiré",
        removedBody: "Vous ne pouvez pas ouvrir cette session avec votre accès actuel. Un responsable de la session peut la partager à nouveau.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} retiré de l’accès à la session`,
        browseMore: "Tout parcourir",
        allLoaded: "Tous les résultats sont chargés",
        levelHelp: { view: "lire la session", edit: "diriger l’Agent selon les autorisations configurées de ses outils", admin: "gérer l’accès à la Session" },
        steeringScopeNotice: "Diriger n’est pas une discussion isolée : le dossier de travail et le nom affiché ne limitent pas l’accès au shell, au système de fichiers ou au réseau.",
        help: "Peut voir permet de lire. Peut diriger permet de diriger l’Agent selon ses autorisations d’outils. Administration permet aussi de gérer l’accès. Ce n’est pas une discussion isolée : le dossier de travail et le nom affiché ne limitent pas l’accès au shell, aux fichiers ou au réseau."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const fr: typeof en = {
    status: {
        queued: 'En file d’attente',
        starting: 'Démarrage',
        running: 'En cours',
        waiting: 'En attente',
        blocked: 'Bloqué',
        succeeded: 'Terminé',
        failed: 'Échec',
        timedOut: 'Délai dépassé',
        cancelled: 'Arrêté',
        unknown: 'Inconnu',
    },
    attention: {
        permission: 'Approbation requise',
        userAction: 'Votre réponse est requise',
        both: 'Nécessite votre attention',
        bothDescription: 'Approbation et votre réponse requises',
    },
    runKind: {
        conversation: 'Conversation',
        review: 'Revue',
        plan: 'Plan',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Équipe ${team} · ${count} ${count === 1 ? 'agent' : 'agents'}`,
        teamActionsA11y: 'Actions de l’équipe',
        openWork: 'Ouvrir',
        needsYouCount: ({ count }) => `${count} ont besoin de vous`,
        runningCount: ({ count }) => `${count} en cours`,
        nothingRunning: 'Rien en cours.',
        startAgent: 'Démarrer un agent',
        machineOffline: ({ machine }) => `${machine} ne répond pas`,
        machineOfflineUnnamed: 'La machine ne répond pas',
        launch: {
            menuA11y: 'Démarrer un agent',
            conversationDescription: 'Parler à un agent à côté de cette session',
            reviewDescription: 'Relire les changements faits jusqu’ici',
            planDescription: 'Préparer les prochaines étapes',
            delegateDescription: 'Confier une tâche et la récupérer terminée',
            advancedDescription: 'Choisir les agents, les autorisations et le profil',
        },
        empty: {
            title: 'Mettez plus d’agents sur cette session',
            reason: ({ machine }) => `Lancez une conversation en parallèle, ou demandez une relecture ou un plan pendant que vous continuez. Ils tournent sur ${machine} et rendent compte ici.`,
            reasonUnnamed: 'Lancez une conversation en parallèle, ou demandez une relecture ou un plan pendant que vous continuez. Ils rendent compte ici.',
            moreWays: 'Demander une relecture, un plan ou une délégation',
        },
        unavailable: {
            notEnabled: 'Les agents ne peuvent pas démarrer sur ce Home.',
            machineOffline: ({ machine }) => `Démarrer des agents nécessite que ${machine} soit en ligne.`,
            machineOfflineUnnamed: 'Démarrer des agents nécessite que cette machine soit en ligne.',
            sessionInactive: 'Cette session est arrêtée. Reprenez-la pour démarrer des agents ici.',
            externalRunnerInactive: 'Cette session a été lancée hors de Happier. Les agents peuvent démarrer d’ici tant que Happier y est attaché.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { fr };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { fr: {
        title: 'Tableau',
        views: {
            label: 'Vues du tableau',
            overview: 'Vue d’ensemble',
            createTitle: 'Nouvelle vue du tableau',
            renameTitle: 'Renommer la vue du tableau',
            reconciled: ({ title }) => `Cette vue du tableau a été supprimée. Affichage de ${title}.`,
            empty: {
                title: 'Rien dans cette vue',
                reason: 'Ajoutez un widget ici, ou passez à une autre vue du tableau.',
            },
            actions: {
                create: 'Nouvelle vue',
                rename: 'Renommer la vue',
                moveBefore: 'Déplacer la vue avant',
                moveAfter: 'Déplacer la vue après',
                remove: 'Supprimer la vue',
            },
            remove: {
                title: ({ title }) => `Supprimer « ${title} » ?`,
                moveMessage: ({ title }) => `Ses widgets passent dans ${title}. Rien n’est supprimé de la session.`,
                unpinMessage: 'Ses widgets restent dans la session mais ne sont plus épinglés à une vue.',
            },
        },
        add: { note: 'Nouvelle note', interactiveView: 'Vue interactive' },
        width: { compact: 'Compacte', medium: 'Moyenne', wide: 'Large', full: 'Pleine largeur' },
        height: { auto: 'Ajuster au contenu', compact: 'Basse', regular: 'Moyenne', tall: 'Haute' },
        board: {
            loading: { title: 'Ouverture du tableau', reason: 'Chargement de ce qui est épinglé à cette session.' },
            locked: {
                title: 'Le tableau est encore chiffré',
                reason: 'Cet appareil ne peut pas encore ouvrir la session. Rien n’est perdu.',
            },
            unopenable: {
                title: 'L’organisation du tableau est illisible',
                reason: 'L’organisation enregistrée n’a pas pu être ouverte. Les widgets eux-mêmes ne sont pas touchés.',
            },
            unsupported: {
                title: 'Ce tableau demande une version plus récente de Happier',
                reason: 'Tout est conservé. Ouvre-le sur un appareil compatible ou mets Happier à jour.',
            },
            unavailable: {
                title: 'Le tableau n’est pas encore disponible ici',
                reason: 'Rien n’est perdu. Il apparaîtra dès que ce Home activera les tableaux.',
            },
            offline: 'Hors ligne — tu vois la dernière version chargée.',
            offlineEmpty: 'Hors ligne — reconnecte-toi pour charger ce tableau.',
            stale: 'Tu vois la dernière version chargée.',
        },
        empty: {
            editor: {
                title: 'Garde le plan à côté du chat',
                description: 'Les notes et vues en direct épinglées ici restent avec cette session, pour toutes les personnes qui peuvent la lire.',
                askAgent: 'Demander à l’agent',
                askAgentPrompt: 'Place sur ce tableau quelque chose qui montre ',
                addNote: 'Ajouter une note',
            },
            viewer: {
                title: 'Rien sur le tableau pour l’instant',
                description: 'Ce que les personnes ou les agents épinglent à cette session apparaîtra ici.',
            },
        },
        item: {
            untitled: 'Widget sans titre',
            renameA11y: 'Titre du widget',
            reorderA11y: ({ title }) => `Réorganiser ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Lire et modifier', movement: 'Déplacement', geometry: 'Taille', destructive: 'Supprimer' },
            loading: { title: 'Chargement du widget', reason: 'Récupération de son contenu depuis ce Home.' },
            locked: {
                title: 'Contenu chiffré indisponible',
                reason: 'Ce widget reste chiffré tant que cet appareil ne peut pas ouvrir la session.',
            },
            unopenable: {
                title: 'Ce widget ne peut pas être affiché',
                reason: 'Son contenu enregistré n’a pas pu être lu. Le reste du tableau reste utilisable.',
            },
            unsupported: {
                title: 'Ce widget demande une version plus récente de Happier',
                reason: 'Son contenu est conservé. Ouvre-le sur un appareil compatible ou mets Happier à jour.',
            },
            notCopied: { title: 'Visuel non copié', reason: 'Ce visuel n’a pas pu être copié dans cette bifurcation.' },
            missing: {
                title: 'Ce widget est introuvable',
                reason: 'Le tableau y renvoie encore, mais son contenu n’est pas sur ce Home.',
            },
            removed: {
                title: 'Ce widget a été retiré du tableau',
                reason: 'Une personne ayant les droits d’édition l’a supprimé pour tout le monde.',
            },
            pluginUnavailable: {
                title: 'Plugin indisponible sur cet appareil',
                reason: 'Le widget est conservé. Il s’affichera de nouveau dès que le plugin sera disponible ici.',
            },
            rendererUnavailable: {
                title: 'Ce widget ne peut pas s’afficher sur cet appareil',
                reason: 'Son contenu est conservé. Ouvre-le sur un appareil qui prend en charge les vues interactives.',
            },
            provenance: {
                note: 'Note',
                interactiveView: 'Vue interactive',
                pluginMissing: ({ pluginId }) => `De ${pluginId} · non installé`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Retirer du tableau',
                openHere: 'Ouvrir ici',
                managePlugin: 'Gérer le plugin',
                prepareEncryption: 'Configurer le chiffrement',
                readFull: 'Lire la note entière',
                rename: 'Renommer le widget',
                unpin: 'Détacher de cette vue',
                moveToView: ({ title }) => `Déplacer vers ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} déplacé vers l’avant.`,
                after: ({ title }) => `${title} déplacé vers l’arrière.`,
                reordered: ({ title }) => `${title} déplacé.`,
                toView: ({ title, view }) => `${title} déplacé vers ${view}.`,
            },
            movePosition: ({ position, total }) => `Position ${position} sur ${total}`,
            moveTargetView: ({ title }) => `Vue du tableau ${title}`,
            remove: {
                title: 'Retirer ce widget ?',
                message: 'Toutes les personnes qui peuvent lire cette session le perdent. Les plugins installés restent installés.',
            },
        },
        note: {
            titlePlaceholder: 'Titre',
            titleA11y: 'Titre de la note',
            untitled: 'Note sans titre',
            offline: 'Pour enregistrer, il faut une connexion à ce Home.',
            unavailable: 'Les modifications du tableau ne sont pas encore disponibles sur ce Home.',
            failed: 'Happier n’a pas pu enregistrer cette note. Ton texte est toujours là.',
            outcomeUnknown: 'Happier n’a pas pu confirmer l’enregistrement de cette note. Actualise avant de réessayer.',
            saved: 'Note enregistrée',
            conflict: {
                message: 'Cette note a changé sur un autre appareil.',
                reviewLatest: 'Voir la dernière version',
                applyMine: 'Appliquer mes modifications',
                latestHeading: 'Dernière version',
            },
        },
        recovered: {
            title: 'Éléments récupérés',
            description: 'Ces widgets appartiennent à la session mais ne figurent dans aucune vue du tableau.',
            pin: 'Ajouter à cette vue',
        },
        mutation: {
            conflict: 'Ce tableau a changé sur un autre appareil. Actualisez pour voir la dernière version.',
            outcomeUnknown: 'Happier n’a pas pu confirmer si la modification a été enregistrée.',
            denied: 'Vous n’avez plus la permission de modifier ce tableau.',
            offline: 'Modifier le tableau nécessite une connexion à ce Home.',
            unavailable: 'Ce Home ne peut pas encore modifier le tableau.',
            updateRequired: 'Mettez Happier à jour pour appliquer cette modification.',
            noteTooLarge: 'Cette note est trop volumineuse pour être enregistrée. Votre texte est toujours là.',
            invalid: 'Cette modification du tableau n’est pas valide. Vérifiez-la puis réessayez.',
            notFound: 'Cet élément n’est plus disponible. Actualisez le tableau.',
            storageFailed: 'Happier n’a pas pu sécuriser cette modification. Votre travail est toujours là.',
            serverFailed: 'Ce Home n’a pas pu terminer cette modification. Réessayez.',
            failed: 'Happier n’a pas pu appliquer cette modification du tableau.',
        },
        hostedHtmlApproval: {
            title: 'Autoriser cette vue interactive ?',
            body: 'L’autorisation s’applique à cette vue dans cette session. Pour envoyer un message, vous devez toujours cliquer dans la vue.',
            resources: ({ count }) => (count === 1 ? 'Peut lire 1 ressource de session' : `Peut lire ${count} ressources de session`),
            actions: ({ count }) => (count === 1 ? 'Peut exécuter 1 action' : `Peut exécuter ${count} actions`),
            sendMessages: 'Peut demander à Happier d’envoyer des messages',
            loadsFrom: ({ origin }) => `Charge depuis ${origin}`,
            allow: 'Autoriser',
            notNow: 'Pas maintenant',
            declined: {
                title: 'Vue interactive pas encore autorisée',
                reason: 'Consultez ce qu’elle demande quand vous le souhaitez.',
                review: 'Consulter',
            },
        },
        sidebar: {
            openInDetails: 'Ouvrir dans les détails',
            openBoard: 'Ouvrir le tableau',
            sharedWithEveryone: 'Partagé avec tout le monde ici',
            widgetCount: ({ count }) => `${count} widget${count === 1 ? '' : 's'}`,
        },
        mobile: { searchPlaceholder: 'Rechercher dans ce tableau' },
        inline: {
            openBoard: 'Ouvrir le tableau',
            openBoardA11y: ({ title }) => `Ouvrir « ${title} » dans le tableau`,
        },
        companion: {
            title: 'Compagnon',
            inCompanionA11y: 'Dans ton compagnon',
            empty: {
                title: 'Gardez la session sous les yeux',
                reason: 'Placez le résumé de session ou un widget du tableau à côté de votre chat : ce qui tourne, ce qui vous attend, ce qui a changé.',
                note: 'Vous seul voyez votre compagnon.',
            },
            pane: {
                besideChat: 'À côté de votre chat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 élément' : `${count} éléments`,
                justForYou: 'Rien que pour vous, à côté du chat',
            },
            actions: {
                addSummary: 'Ajouter le résumé de session',
                addItem: ({ title }) => `Ajouter ${title}`,
                moveToLeading: 'Déplacer vers la gauche',
                moveToTrailing: 'Déplacer vers la droite',
                moveToFirst: 'Déplacer tout en haut',
                moveToLast: 'Déplacer tout en bas',
                compact: 'Taille compacte',
                comfortable: 'Taille confortable',
                openFull: 'Ouvrir le compagnon complet',
                openOnBoard: 'Ouvrir sur le tableau',
                collapse: 'Réduire le compagnon',
                expand: 'Développer le compagnon',
                hide: 'Masquer le compagnon',
                addToCompanion: 'Ajouter au compagnon',
                removeFromCompanion: 'Retirer du compagnon',
                undo: 'Annuler',
                menuA11y: 'Options du compagnon',
                itemMenuA11y: ({ title }) => `Options pour ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Compagnon, ${count} éléments`,
                show: ({ count }) => `Afficher le compagnon, ${count} éléments`,
                expand: ({ count }) => `Développer le compagnon, ${count} éléments`,
            },
            summary: {
                review: 'Voir',
                title: 'Résumé de session',
                untitled: 'Session',
                approvals: ({ count }) => `${count} en attente`,
                workflows: ({ count }) => `${count} workflows en cours`,
                changedFiles: ({ count }) => `${count} modifiés`,
                tokens: ({ count }) => `${count} jetons`,
                contextPercent: ({ percent }) => `${percent} % de contexte`,
                contextOnly: 'Contexte utilisé',
                moreDetails: 'Plus de détails',
                moreDetailsA11y: ({ count }) => `Plus de détails, ${count} lignes supplémentaires`,
                partial: 'Certains détails ne sont pas visibles ici.',
            },
            notices: {
                shown: 'Compagnon affiché',
                hidden: 'Compagnon masqué',
                added: 'Ajouté au compagnon',
                removed: 'Retiré du compagnon',
                reordered: 'Compagnon réorganisé',
                moved: 'Compagnon déplacé',
                boardOpened: 'Tableau ouvert par l’agent',
                returnedToChat: 'Retour au chat par l’agent',
                boardViewSelected: 'Vue du tableau sélectionnée par l’agent',
                boardItemRevealed: 'Élément du tableau ouvert par l’agent',
                fullOpened: 'Compagnon ouvert par l’agent',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "fr">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "fr"> = { fr: {
        hereOne: ({ name }) => `${name} est là`,
        hereTwo: ({ first, second }) => `${first} et ${second} sont là`,
        hereMany: ({ first, count }) => `${first} et ${count.toLocaleString()} autres personnes sont là`,
        typingOne: ({ name }) => `${name} écrit…`,
        typingMany: ({ count }) => `${count.toLocaleString()} personnes écrivent…`,
        justYouHere: 'Vous êtes seul ici',
        justYouHint: 'Les personnes avec qui vous la partagez apparaîtront ici',
        you: 'Vous',
        presenceConnecting: 'Vérification des présents…',
        presenceUnavailable: 'La présence en direct ne répond pas pour le moment',
        presenceUnsupported: 'La présence en direct n’est pas disponible sur cette Home',
        responsibleUnsupported: 'Cette Home n’indique pas qui est responsable',
        inviteTitle: 'Discutez-en à côté de la session',
        inviteBody: 'Lancez une conversation, mentionnez des personnes et confiez la réponse à l’agent quand vous êtes prêt.',
        readOnly: 'Vous pouvez les lire. Les personnes qui peuvent modifier cette session peuvent écrire.',
        offline: 'Vous êtes hors ligne · dernières conversations affichées',
        lockedTitle: 'Impossible d’ouvrir ces conversations sur cet appareil pour l’instant',
        lockedBody: 'Elles sont chiffrées de bout en bout et la configuration de chiffrement de cet appareil ne correspond pas à celle de la session.',
        revokedTitle: 'Vous n’avez plus accès à ces conversations',
        revokedBody: 'Une personne qui gère cette session a changé qui peut la voir. Vos messages restent avec la session.',
        namesTwo: ({ first, second }) => `${first} et ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} et ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} et ${count.toLocaleString()} autres`,
        haveAccess: 'Y ont accès',
        hasAccess: 'Y a accès',
        onlyYou: 'Vous uniquement',
        notShared: 'Pas encore partagée',
        publicLinkOn: 'Lien public activé',
        accessLoading: 'Vérification des accès…',
        accessError: 'Impossible de charger qui a accès',
        shareTitle: 'Partager cette session',
        shareBody: ({ home }) => `Les personnes que vous ajoutez sur ${home} peuvent la suivre et rejoindre ses conversations.`,
        collapse: 'Réduire',
        linkOn: 'Activé',
        linkOff: 'Désactivé',
        linkGrants: 'Toute personne disposant du lien peut voir la transcription, sans compte.',
        linkExpires: ({ date }) => `Expire le ${date}`,
        linkNeverExpires: 'N’expire jamais',
        linkAsksConsent: 'demande un consentement',
        linkNoConsent: 'sans étape de consentement',
        linkHidden: 'Ce lien a été créé plus tôt et ne peut plus être affiché. Créez-en un nouveau pour le copier.',
        qrCode: 'Code QR',
        hideQrCode: 'Masquer le code QR',
        newLink: 'Nouveau lien…',
        turnOff: 'Désactiver',
        turnOffTitle: 'Désactiver le lien public ?',
        turnOffBody: 'Les personnes qui ont le lien perdent l’accès immédiatement. Vous pourrez en créer un nouveau plus tard.',
        newLinkReplaces: 'Le lien actuel cessera de fonctionner dès que le nouveau sera créé.',
        linkDenied: 'Seules les personnes qui gèrent cette session peuvent créer un lien public.',
        linkLoadFailed: 'Impossible de vérifier le lien public.',
        linkNetworkOff: 'Partager les visuels sans accès réseau',
        linkNetworkConsequence: 'Les visuels avec un accès réseau peuvent envoyer leur contenu à d’autres sites et révéler l’adresse IP de la personne qui les consulte. Le code et les ressources distants peuvent changer. Sans accès réseau, le contenu intégré reste interactif.',
        linkUnavailable: 'Les liens publics ne sont pas disponibles sur ce Home. Demandez à son administrateur de configurer leur hébergement.',
        justYouTitle: 'Travaillez ensemble sur cette session',
        justYouBody: ({ home }) => `Partagez-la avec des personnes de ${home}. Elles pourront la suivre, en discuter ici et prendre le relais en votre absence.`,
        share: 'Partager',
        justYouNote: 'Ou créez un lien public que tout le monde peut voir.',
        sharingOffTitle: ({ home }) => `${home} ne partage pas de sessions avec des personnes`,
        sharingOffBody: 'Vous pouvez tout de même créer un lien public que tout le monde peut voir.',
        sharingOffPrivateBody: 'Les sessions de cette Home restent avec vous.',
        accessDenied: 'Seules les personnes qui gèrent cette session peuvent changer qui y a accès. Vous pouvez toujours rejoindre ses conversations.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "fr"> = { fr: { pane: sessionCollaborationPaneTranslations['fr'], title: 'Collaboration', viewingNow: 'Présents maintenant', justYou: 'Vous uniquement', typing: 'Écrit…', stale: 'Peut ne plus être à jour', unavailable: 'Présence en direct indisponible', connecting: 'Connexion…', unnamed: 'Membre Happier', open: 'Ouvrir la collaboration', conversations: 'Conversations', accessUnavailable: 'Accès à la session indisponible', accessUnavailableReason: 'Ce Home ne prend pas en charge le partage de sessions avec des personnes.', discussion: { featureUnavailable: "Les conversations ne sont pas activées sur ce Home.", bindingUnavailable: "Reconnectez-vous à ce Home pour voir les conversations.", scopeMismatch: "Ces conversations appartiennent à un autre compte sur ce Home.", modeMismatch: "Ce contenu ne correspond pas au mode de chiffrement de la session. Réessayez ou demandez à une personne qui gère la session de vérifier l’accès.",  title: 'Conversations', newDiscussion: 'Nouvelle conversation', create: 'Créer la conversation', titlePlaceholder: 'Titre de la conversation', messagePlaceholder: 'Écrivez un message…', active: 'Actives', activeDisclosure: 'Afficher les conversations actives', archived: 'Archivées', archivedDisclosure: 'Afficher les conversations archivées', emptyActive: 'Aucune conversation active pour le moment.', emptyArchived: 'Aucune conversation archivée.', loading: 'Chargement des conversations…', loadError: 'Impossible de charger les conversations.', retry: 'Réessayer', checking: 'Recherche de nouveautés…', deliveryUnknown: 'Livraison incertaine — vérifiez avant de réessayer.', locked: 'Vous pouvez lire cette conversation, mais pas y publier.', offline: 'Vous êtes hors ligne. Reconnectez-vous pour continuer.', unavailable: 'Cette conversation est indisponible.', unreadCount: ({ count }) => count === 1 ? '1 non lu' : `${count.toLocaleString()} non lus`, unreadMentionCount: ({ count }) => count === 1 ? '1 mention non lue' : `${count.toLocaleString()} mentions non lues`,
        mentioned: 'Vous avez été mentionné', unreadConversations: 'Conversations non lues', messageCount: ({ count }) => count === 1 ? '1 message' : `${count.toLocaleString()} messages`, viaAgent: 'Via l’Agent', collaborator: 'Collaborateur', contentUnavailable: 'Message indisponible', rename: 'Renommer la conversation', archive: 'Archiver la conversation', restore: 'Restaurer la conversation', selection: { copy: 'Copier', askAgent: 'Demander à l’Agent', sendToSession: 'Envoyer à la session', handoffError: 'Les messages sélectionnés n’ont pas pu être ajoutés à l’éditeur de la session.' }, titleRequired: 'Ajoutez un titre pour démarrer cette conversation.', encryptedTitle: 'Conversation chiffrée', archivedNotice: 'Cette conversation est archivée.', sessionArchived: 'Cette session est archivée.', postDenied: 'Vous ne pouvez plus publier dans cette session.', invalidMention: 'Une personne mentionnée ne peut plus lire cette session.', invalidContent: 'Ce message ne peut pas être envoyé tel quel. Il est peut-être vide ou trop long.', idempotencyConflict: 'Un autre message a déjà été envoyé sous cette identité.', sendFailed: 'Ce message n’a pas pu être envoyé.', dismiss: 'Ignorer', loadOlder: 'Charger les messages précédents', loadMore: 'Charger plus de conversations' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { fr: {
        recap: { title: 'Récapitulatif' },
        status: {
            waitingForYou: 'Vous attend',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} s’est arrêté avant l’étape ${step} sur ${total}`,
            stepOfPlan: ({ step, total }) => `Étape ${step} sur ${total} du plan`,
            agentFallback: 'L’agent',
        },
        ask: {
            question: ({ summary }) => `${summary} ?`,
            allow: 'Autoriser',
            deny: 'Refuser',
            showInChat: 'Voir dans le chat',
            moreWaiting: ({ count }) => `${count} autres en attente`,
            allowed: ({ summary }) => `Autorisé : ${summary}`,
            denied: ({ summary }) => `Refusé : ${summary}`,
            justNow: 'à l’instant',
            failed: 'Votre réponse n’a pas atteint la session. Réessayez.',
            answerWhenBack: ({ machine }) => `Vous pourrez répondre quand ${machine} sera de retour.`,
            answerWhenSessionBack: 'Vous pourrez répondre quand la session sera de retour.',
            notAllowed: 'Seules les personnes qui peuvent exécuter cette session peuvent répondre.',
            groupA11y: 'Vous attend',
        },
        facts: {
            subagents: 'sous-agents',
            changed: 'modifiés',
            context: 'contexte',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} sur ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent} %`,
            opensAgents: 'Ouvre Agents',
            opensGit: 'Ouvre Git',
            opensUsage: 'Ouvre l’utilisation',
        },
        plan: {
            title: 'Plan',
            description: ({ agent }) => `La liste de tâches de ${agent} pour cette session`,
            progress: ({ done, total }) => `${done} sur ${total}`,
            progressA11y: ({ done, total }) => `${done} sur ${total} terminées`,
            emptyTitle: 'Pas encore de plan',
            emptyReason: 'Quand l’agent écrit une liste de tâches, elle apparaît ici, étape par étape.',
            stepDone: 'Terminé',
            stepCurrent: 'Étape en cours',
        },
        picker: {
            open: 'Ajouter au Compagnon',
            chooseWidget: 'Choisir un widget…',
            onTheBoard: ({ source }) => `${source} · sur le tableau`,
        },
        drop: { keepBesideChat: 'Garder à côté du chat' },
        freshness: { machineOffline: ({ machine }) => `${machine} est hors ligne` },
        needsYouA11y: ({ count }) => `Compagnon, ${count} vous attendent`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "fr">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const fr: typeof en = {
    discussion: {
        loadingTitle: 'Ouverture de cette conversation…',
        offlineTitle: 'Cette conversation n’est pas disponible hors ligne',
        offlineReason: 'Reconnectez-vous et elle rouvrira là où vous l’avez laissée.',
        errorTitle: 'Impossible d’ouvrir cette conversation',
        lockedTitle: 'Impossible d’ouvrir cette conversation sur cet appareil pour le moment',
        lockedReason: 'Elle est chiffrée de bout en bout, et la configuration de chiffrement de cet appareil ne correspond pas à celle de la session.',
        revokedTitle: 'Vous n’avez plus accès à cette conversation',
        revokedReason: 'Cette session n’est plus partagée avec vous. Les messages que vous avez écrits restent dans la session.',
        unavailableTitle: 'Les conversations ne sont pas disponibles ici',
        closeTab: 'Fermer l’onglet',
    },
    draft: {
        leadTitle: 'Demander à un agent',
        leadBody: 'Il s’exécute dans sa propre conversation à côté de la session, avec ces messages comme contexte. Rien ne démarre avant l’envoi.',
    },
    context: {
        fromConversation: ({ title, count }) => `De ${title} · ${count === 1 ? '1 message' : `${count} messages`}`,
        fromUntitled: ({ count }) => `D’une conversation · ${count === 1 ? '1 message' : `${count} messages`}`,
    },
    origin: {
        fromConversation: ({ title }) => `de ${title}`,
        fromUntitled: 'd’une conversation',
    },
    run: {
        details: 'Détails de l’exécution',
        loadingTitle: 'Ouverture de cette conversation avec l’agent…',
        errorTitle: 'Impossible d’ouvrir cette conversation avec l’agent',
    },
};

const sessionConversationSurfaceTranslations = { fr };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { fr: {
        title: ({ machine }) => `Le dossier privé de ce chat n’est plus sur ${machine}.`,
        body: 'Tu peux continuer dans un nouveau dossier vide. Ton historique restera ici, mais les fichiers locaux de l’ancien dossier ne seront pas restaurés.',
        continue: 'Continuer dans un nouveau dossier', notNow: 'Pas maintenant',
        offlineDelete: ({ machine }) => `Son dossier privé sur ${machine} sera supprimé quand cet ordinateur sera de nouveau en ligne.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "fr">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const fr: typeof en = {
    sectionTitle: 'Brouillons',
    sectionTitleForHome: ({ home }) => `Brouillons sur ${home}`,
    waitingSectionTitleForHome: ({ home }) => `En attente d’un ordinateur sur ${home}`,
    badge: 'Brouillon',
    untitled: 'Brouillon sans titre',
    continueEditing: 'Continuer la modification',
    startAnother: 'En démarrer un autre',
    executionRunStart: {
        starting: 'Démarrage de la conversation avec l’agent…',
        reconciling: 'Vérification du démarrage de cette conversation avec l’agent…',
        unresolved: 'Nous n’avons pas pu confirmer si cette conversation avec l’agent a démarré. En lancer une autre peut en créer une seconde.',
        targetChanged: 'L’ordinateur de cette session a changé avant que la conversation puisse démarrer. Rien n’a été lancé.',
        secretReferenceOverlayUpdateRequired: 'Utiliser des secrets partagés dans une conversation avec l’agent nécessite un ordinateur à jour. Rien n’a été lancé.',
    },
    status: {
        offline: 'Hors ligne — enregistré sur cet appareil',
        syncing: 'Synchronisation…',
        conflict: 'À examiner',
        unsupported: 'Non synchronisé — ce Home ne peut pas synchroniser ce brouillon',
        startInterrupted: 'Démarrage interrompu',
    },
    availability: {
        machineUnavailable: 'Machine indisponible',
        pluginUnavailable: 'Plugin indisponible',
        attachmentNeedsAttention: 'La pièce jointe demande votre attention',
    },
    new: { action: 'Nouvelle session' },
    delete: {
        action: 'Supprimer le brouillon',
        confirmTitle: 'Supprimer ce brouillon ?',
        confirmDescription: 'Cela retire le brouillon de vos appareils synchronisés.',
    },
    conflict: {
        title: 'Examiner les modifications en conflit',
        description: 'Choisissez la version à conserver pour chaque champ. Vous pouvez copier la version de votre appareil avant de la remplacer.',
        mine: 'Cet appareil',
        synced: 'Version synchronisée',
        useSynced: 'Utiliser la synchronisée',
        keepDevice: 'Garder celle de cet appareil',
        copyMine: 'Copier la mienne',
        copied: 'Copié',
        copyFailed: 'Impossible de copier cette valeur.',
        field: {
            text: 'Message',
            mentions: 'Mentions',
            attachments: 'Pièces jointes',
            recipient: 'Destinataire',
            agentContinuation: 'Continuation de l’agent',
            executionRunRequestedAction: 'Livraison de l’exécution',
        },
    },
};

const sessionDraftTranslations = { fr };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { fr: translated({
        unavailable: 'Cette session n’est pas disponible',
        respondInSession: 'Ouvrez la session pour répondre.',
        regionLabel: ({ title }) => `Session : ${title}`,
        newChatWelcome: 'Sur quoi travaillons-nous ?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "fr"> = { 'fr': {
        "notificationBody": {"message":"Nouveau message dans cette session.","failed":"Le tour a échoué.","cancelled":"Le tour a été annulé.","sourceUnavailable":"La source de cette session est indisponible."},
        "follow": "Suivre",
        "unfollow": "Ne plus suivre",
        "following": "Suivi",
        "notifications": "Notifications",
        "unavailableTitle": "Le suivi n’est pas disponible",
        "unavailableDescription": "Ce Home ne propose pas le suivi de sessions.",
        "unreachableTitle": "Impossible de joindre ce Home",
        "unreachableDescription": "Happier n’a pas pu vérifier si ce Home propose le suivi de sessions. Réessayez lorsqu’il sera joignable.",
        "editor": {
            "title": "Suivre cette session",
            "subtitle": "Recevez les nouvelles qui comptent pour vous.",
            "ownerSubtitle": "Cette session vous appartient, ses mises à jour vous parviennent toujours.",
            "externalAttachedOnly": "La synchronisation en arrière-plan est désactivée : les mises à jour peuvent n’arriver que pendant que cette session est attachée."
        },
        "level": {
            "none": "Aucune notification",
            "important": "Mises à jour importantes",
            "all_messages": "Chaque nouveau message"
        },
        "voice": {
            "title": "Inclure dans Voice",
            "subtitle": "Voice peut garder cette session en contexte.",
            "waitingRuntime": "En attente de la connexion de Voice.",
            "unsupported": "Cet environnement ne permet pas d’inclure les sessions suivies dans Voice.",
            "providerWithheld": "Ce mode Voice ne peut pas inclure les mises à jour de sessions enregistrées.",
            "waitingEncrypted": "Déverrouillez cette session pour l’inclure dans Voice.",
            "initialSnapshotPending": "Lors de votre prochain tour Voice, inclure un bref résumé de l’état actuel."
        },
        "footer": "Le suivi ne change jamais qui peut accéder à cette session.",
        "settingsLink": "Paramètres de notification…",
        "assignedExplanation": "Vous suivez cette session car elle vous a été attribuée",
        "assignedNotice": "Une session vous a été attribuée.",
        "sharedNotice": "Une session a été partagée avec vous.",
        "wakeEventExplanation": "Le contexte suivi a changé, donc Happier a réveillé cet agent avec la mise à jour.",
        "accessLost": "Vous n’avez plus accès à cette session.",
        "offline": "Vous êtes hors ligne. Reconnectez-vous pour modifier le suivi.",
        "archived": "Le suivi est suspendu tant que cette session est archivée.",
        "sources": {
            "title": "Mises à jour des sessions",
            "waitingRuntime": "En attente de la reconnexion de la session de destination.",
            "unsupported": "Mets à jour ou reconnecte le CLI sur la machine de destination pour recevoir les mises à jour.",
            "pausedArchived": "Les mises à jour sont en pause tant que la source ou la destination est archivée.",
            "add": "Suivre dans une autre session…",
            "addSource": "Envoyer les mises à jour d’une autre session…",
            "chooseDestinationTitle": "Suivre dans une autre session",
            "chooseSourceTitle": "Envoyer les mises à jour d’une autre session",
            "row": ({ title }) => `Mises à jour de « ${title} »`,
            "nextTurn": "Prochain tour",
            "wakeOnHumanChange": "Réveiller quand une personne ajoute un message",
            "stop": "Arrêter les mises à jour",
            "stopForSource": ({ title }) => `Arrêter les mises à jour de «${title}»`,
            "includeNextTurn": "Inclure les mises à jour au prochain tour de la destination.",
            "sourceKeyPreparing": "Préparation de l’accès chiffré…",
            "sourceKeyWaiting": "En attente de l’accès chiffré.",
            "sourceKeyUnavailable": "Cet ordinateur ne peut pas fournir d’accès chiffré.",
            "sourceSessionKeyUnavailable": "L’accès chiffré de cette session n’est pas disponible ici.",
            "catchUpPending": "Rattrapage en attente"
        },
        "preferences": {
            "title": "Suivre automatiquement",
            "assigned": "Sessions qui me sont attribuées",
            "direct": "Sessions partagées directement",
            "team": "Sessions partagées via des équipes",
            "group": "Sessions partagées via des groupes",
            "help": "S’applique aux nouvelles attributions et aux sessions nouvellement accessibles. Les choix existants restent inchangés."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const fr: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Branche ${branch} : changer de branche ou voir ce qui a été mis de côté`,
    searchPlaceholder: 'Changer ou créer une branche',
    category: { current: 'Actuelle', branches: 'Branches', remote: 'Branches distantes', keptAside: 'Mis de côté', worktrees: 'Worktrees', start: 'Commencer autre chose' },
    tracks: ({ upstream }) => `suit ${upstream}`,
    onlyHere: 'seulement sur cette machine',
    changed: ({ count }) => `${count} modifiés`,
    ahead: ({ count }) => `${count} à pousser`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Nouvelle branche depuis ${branch}…`,
    newBranchDetached: 'Nouvelle branche…',
    newBranchSubtitle: 'Saisissez son nom dans le champ de recherche',
    newWorktree: 'Nouveau worktree…',
    newWorktreeSubtitle: 'Travailler sur une autre branche dans une nouvelle session',
    keepAside: 'Mettre les changements de côté',
    keepAsideSubtitle: ({ count }) => `Ranger ${count} changements et repartir propre`,
    keepAsideNothing: 'Aucun changement à garder',
    keepAsideFailed: 'Impossible de mettre les changements de côté.',
    loadFailed: 'Impossible de charger les branches',
    notice: {
        title: ({ branch }) => `Vous avez mis des changements de côté sur ${branch}`,
        reason: ({ when }) => `Mis de côté ${when}. Récupérez-les pour continuer.`,
        reasonUndated: 'Récupérez-les pour continuer.',
        restore: 'Restaurer les changements',
        lookFirst: 'Voir d’abord',
        dismiss: 'Plus tard',
        restoreFailed: 'Impossible de restaurer les changements.',
    },
};

const sessionGitBranchesTranslations = { fr };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const fr: typeof en = {
    settingsLayout: 'Disposition du panneau Git',
    settingsShowAs: 'Afficher les fichiers modifiés en',
    trigger: 'Options d’affichage',
    paneGroup: 'Panneau',
    changesGroup: 'Modifications',
    layout: 'Disposition',
    layoutUnified: 'Unifiée',
    layoutTabs: 'Onglets',
    layoutDescription: 'Un seul défilement des modifications à l’historique, ou Modifications et Historique en deux vues.',
    showAs: 'Afficher en',
    showAsList: 'Liste',
    showAsTree: 'Arbre',
    showAsDescription: 'Les fichiers modifiés en liste, ou groupés par dossier pour prendre des dossiers entiers.',
    density: 'Densité',
    densityDefault: 'Par défaut',
    densityCompact: 'Compacte',
    note: 'Les lignes de l’arbre sont toujours compactes. Mémorisé pour votre compte.',
    selectFolder: ({ folder }) => `Sélectionner toutes les modifications de ${folder}`,
    selectFile: ({ file }) => `Sélectionner ${file} pour le prochain commit`,
};

const sessionGitDisplayTranslations = { fr };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const fr: typeof en = {
    scope: { allChanges: 'Toutes les modifications' },
    subTabs: { changes: 'Modifications', sync: 'Synchroniser', history: 'Historique' },
    header: {
        changed: ({ count }) => `${count} modifiés`,
        toPush: ({ count }) => `${count} à pousser`,
        toPull: ({ count }) => `${count} à tirer`,
        push: ({ count }) => `Pousser ${count}`,
        pull: ({ count }) => `Tirer ${count}`,
        publish: 'Publier',
        folderOnMachine: ({ folder, machine }) => `${folder} sur ${machine}`,
    },
    groups: {
        session: 'Modifié dans cette session',
        elsewhere: ({ repo }) => `Ailleurs dans ${repo}`,
        elsewhereUnnamed: 'Ailleurs dans ce dépôt',
        selectGroup: ({ group }) => `Sélectionner tous les fichiers de « ${group} »`,
    },
    row: { renamedFrom: ({ path }) => `avant ${path}` },
    commit: {
        toBranch: ({ branch }) => `Committer sur ${branch}`,
        selection: ({ count }) => (count === 1 ? '1 fichier' : `${count} fichiers`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Vous avez 1 modification non commitée` : `Vous avez ${formatted} modifications non commitées`),
            dirtyBody: 'Récupérer pourrait les toucher. Mettez-les de côté pendant la récupération (elles reviennent juste après) ou laissez Git récupérer seulement si rien ne se chevauche.',
            keepAsideAndPull: 'Mettre de côté et récupérer',
            pullIfNoOverlap: 'Récupérer si rien ne se chevauche',
            divergedPullBody: 'Votre branche et origin ont toutes deux avancé. Placez vos commits sur ceux d’origin ou fusionnez les deux.',
            divergedPushBody: 'Récupérez d’abord les commits d’origin (les vôtres par-dessus ou fusion), puis renvoyez. Vos commits restent sur cette machine.',
            rebase: 'Rebaser sur origin',
            merge: 'Fusionner origin',
        },
        writesOff: {
            title: 'Commiter depuis Happier est désactivé',
            body: 'Vous pouvez lire et relire chaque modification. Activez les opérations de gestion de sources pour commiter, envoyer et récupérer d’ici.',
            turnOn: 'Activer',
        },
        header: {
            noChanges: 'aucune modification',
        },
        action: {
            fetch: 'Récupérer',
            publish: 'Publier la branche',
            createPr: 'Créer une PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Résoudre ${count}`,
            upToDate: 'À jour',
            pushing: ({ count }) => `Envoi de ${count}…`,
            pulling: ({ count }) => `Récupération de ${count}…`,
            fetching: 'Récupération…',
            publishing: 'Publication…',
            creatingPr: 'Création…',
        },
        menu: {
            open: 'Autres actions de synchronisation',
            push: 'Envoyer',
            pull: 'Récupérer',
            pushTo: ({ target }) => `vers ${target}`,
            pullFrom: ({ target }) => `depuis ${target}`,
            nothingToPush: 'Rien à envoyer',
            upToDate: 'À jour',
            fetchHint: 'Vérifier les nouveaux commits sur origin',
            publishHint: 'Mettre cette branche sur origin',
            createPr: 'Créer une pull request…',
            createPrInto: ({ base }) => `vers ${base}`,
            unavailable: 'Indisponible ici',
            more: 'Plus',
        },
        running: {
            branchSwitch: 'Changement de branche…',
            branchCreate: 'Création de la branche…',
            stashCreate: 'Mise de côté de vos modifications…',
            discard: 'Abandon des modifications…',
            revert: 'Annulation du commit…',
            generic: 'En cours…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `votre modification non commitée est intacte` : `vos ${formatted} modifications non commitées sont intactes`),
            commit: 'Commit effectué',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 fichier commité` : `${formatted} fichiers commités`),
            push: 'Envoyé',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 commit envoyé` : `${formatted} commits envoyés`),
            upToDate: ({ target }) => `${target} est à jour`,
            pull: 'Récupéré',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 commit récupéré` : `${formatted} commits récupérés`),
            fetch: ({ target }) => `${target} vérifié`,
            branchSwitch: 'Branche changée',
            branchCreate: 'Branche créée',
            stashCreate: 'Modifications mises de côté',
            discard: 'Modifications abandonnées',
            revert: 'Commit annulé',
            pullRequest: 'Pull request prête',
            generic: 'Terminé',
        },
        failed: {
            unknownTitle: 'Impossible de confirmer comment cela s’est terminé',
            unknownBody: 'La machine a cessé de répondre avant la réponse de Git. Vérifiez à nouveau pour voir ce qui s’est passé.',
            origin: 'origin',
            thisMachine: 'cette machine',
            refreshTitle: 'Commit effectué, mais la liste n’a pas été actualisée',
            refreshBody: 'Votre commit est en sécurité. Réessayez pour voir les modifications actuelles.',
            rejectedTitle: ({ target }) => `${target} a des commits que vous n’avez pas`,
            rejectedBody: 'Récupérez-les pour voir ce qui a changé. Vos commits restent sur cette machine jusqu’au prochain envoi.',
            authTitle: ({ machine, provider }) => `${provider} a refusé la connexion depuis ${machine}`,
            authBody: ({ machine }) => `Git sur ${machine} n’a pas d’identifiants valides pour ce dépôt distant. Connectez-vous là-bas, puis réessayez.`,
            offlineTitle: ({ machine }) => `${machine} est hors ligne`,
            offlineBody: 'Rien ne peut s’y exécuter pour l’instant. Votre travail est en sécurité sur cette machine.',
            conflictTitle: 'Arrêté sur des modifications en conflit',
            conflictBody: 'Certains fichiers ont changé des deux côtés. Résolvez-les, puis continuez.',
            networkTitle: ({ target }) => `Impossible de joindre ${target}`,
            networkBody: 'La machine n’a pas pu se connecter au dépôt distant. Vérifiez son réseau et réessayez.',
            commitTitle: 'Le commit n’a pas abouti',
            pushTitle: 'L’envoi n’a pas abouti',
            pullTitle: 'La récupération n’a pas abouti',
            fetchTitle: 'Impossible de vérifier les nouveaux commits',
            pullRequestTitle: 'La pull request n’a pas été créée',
            genericTitle: 'Cela n’a pas abouti',
        },
        recover: {
            open: 'Ouvrir',
            tryAgain: 'Réessayer',
            fetch: 'Récupérer',
            checkAgain: 'Vérifier à nouveau',
            showConflicts: 'Voir les conflits',
        },
        timeline: {
            title: 'Chronologie',
            now: 'Maintenant',
            loading: 'Lecture de l’historique…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 modification non commitée` : `${formatted} modifications non commitées`),
            selected: ({ count, formatted }) => (count === 1 ? `1 sélectionnée pour le prochain commit` : `${formatted} sélectionnées pour le prochain commit`),
            nothingSelected: 'Rien de sélectionné',
            earlierToday: 'Plus tôt aujourd’hui',
            yesterday: 'Hier',
            older: 'Plus ancien',
            justNow: 'à l’instant',
            toPull: 'à récupérer',
            originFurther: ({ name }) => `${name} est plus loin`,
            originA11y: ({ name }) => `${name} est ici`,
        },
        clean: {
            titleUpToDate: 'Tout est commité et envoyé',
            titleCommitted: 'Tout est commité',
            bodyUpToDate: ({ branch, upstream }) => `${branch} correspond à ${upstream}. Les nouvelles modifications de cette session apparaîtront ici.`,
            body: 'Les nouvelles modifications de cette session apparaîtront ici.',
            createPullRequest: 'Créer une pull request',
            openPullRequest: ({ number }) => `Ouvrir la pull request #${number}`,
            lastCommit: ({ when }) => `Dernier commit ${when}`,
        },
        conflicts: {
            skip: 'Ignorer ce commit',
            askAgentTask: ({ files, operation }) => `Résous les conflits de la ${operation} dans ${files}. Garde l’intention des deux côtés, modifie et indexe les fichiers résolus, puis arrête-toi pour ma relecture. Ne continue pas, n’annule pas, ne commite pas, ne pousse pas et ne prends pas un côté en bloc.`,
            revert: 'annulation',
            cherryPick: 'cherry-pick',
            merge: 'fusion',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `La ${operation} s’est arrêtée : 1 fichier a changé des deux côtés` : `La ${operation} s’est arrêtée : ${formatted} fichiers ont changé des deux côtés`),
            readyToContinue: ({ operation }) => `Tous les conflits sont résolus. Continuez la ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 fichier en conflit` : `${formatted} fichiers en conflit`),
            body: 'Ouvrez chaque fichier sous « À traiter » ou demandez à l’agent de les résoudre.',
            continueBody: 'Rien n’est commité tant que vous ne continuez pas.',
            askAgent: 'Demander à l’agent de résoudre',
            continue: ({ operation }) => `Continuer la ${operation}`,
            abort: ({ operation }) => `Annuler la ${operation}`,
            abortTitle: ({ operation }) => `Annuler la ${operation} ?`,
            abortBody: 'La branche revient à son état d’avant. Les résolutions déjà faites sont perdues.',
            needsYou: 'À traiter',
            mergedCleanly: 'Fusionné sans conflit',
        },
        commit: {
            selectFirst: 'Sélectionnez des fichiers à commiter',
        },
        tools: {
            title: 'Dépôts distants et fusions',
            subtitle: 'Ajouter un dépôt distant, fusionner ou rebaser une branche',
        },
    },
    paused: { reason: 'la session est en pause', resume: 'Reprendre' },
    notRepository: {
        title: 'Suivez ce que les agents modifient ici',
        body: ({ folder }) => `${folder} n’est pas encore un dépôt. Créez-en un pour relire, committer et annuler chaque modification.`,
        bodyUnnamed: 'Ce dossier n’est pas encore un dépôt. Créez-en un pour relire, committer et annuler chaque modification.',
    },
};

const sessionGitPaneTranslations = { fr: withFidelity(fr) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const fr: GitPullRequestCopy = {
    form: {
        title: 'Nouvelle pull request', expand: 'Ouvrir dans un panneau de détails', moveBack: 'Remettre dans la barre latérale',
        close: 'Fermer le formulaire (le brouillon est conservé)', base: 'Fusionnée dans', titlePlaceholder: 'Titre',
        bodyPlaceholder: 'Ce qui a changé et pourquoi', draft: 'Brouillon', create: 'Créer la pull request', creating: 'Création…',
        continueOn: ({ provider }) => `Continuer sur ${provider}`, pointer: 'La nouvelle pull request est ouverte dans Détails', pointerShow: 'Afficher',
        openedProviderPage: ({ provider }) => `${provider} est ouvert pour la terminer ; votre texte reste ici.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} n’a pas accepté la connexion de cette machine`,
        network: ({ provider }) => `Impossible de joindre ${provider}`,
        machineOffline: 'La machine est hors ligne ; votre brouillon est conservé',
        blocked: 'Une autre opération Git est en cours ; réessayez quand elle sera terminée',
        other: 'La pull request n’a pas été créée',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `dans ${base}`,
        state: { open: 'Ouverte', draft: 'Brouillon', merged: 'Fusionnée', closed: 'Fermée', unknown: 'Pull request' },
        checks: { pending: 'Vérifications en cours', success: 'Vérifications réussies', failure: 'Vérifications échouées', unknown: 'Vérifications' },
        openOn: ({ provider }) => `Ouvrir sur ${provider}`, copyLink: 'Copier le lien', copied: 'Lien copié',
    },
    settings: {
        placementTitle: 'Ouvrir les nouvelles pull requests dans', placementDescription: 'Sur un téléphone, le formulaire s’ouvre toujours dans sa propre page.',
        sidebar: 'Barre latérale', details: 'Panneau de détails',
    },
};

const sessionGitPullRequestTranslations = { fr };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { fr: translated({
        offline: 'Hors ligne',
        stale: 'Actualisation impossible',
        lastUpdated: ({ ago }) => `Mis à jour il y a ${ago}`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { fr: translated({
        filtersTitle: 'Filtres des sessions', filtersSearch: 'Rechercher des filtres…', filtersShow: 'Afficher',
        filtersScope: 'Portée', filtersShowSessions: 'Sessions', filtersShowRuns: 'Exécutions', filtersShowBoth: 'Les deux',
        filtersShowBothSummary: 'Sessions et exécutions', filtersStartedByNone: 'Aucun initiateur sélectionné',
        filtersStartedBy: 'Démarré par', filtersStartedByYou: 'Vous', filtersStartedByTriggers: 'Déclencheurs', filtersStartedByAgents: 'Agents',
        filtersRunsNeedingYouAlwaysShow: 'Les exécutions qui ont besoin de vous restent visibles',
        filtersMyWork: 'Mon travail', filtersLegacyOwnerDirect: 'Mon travail', filtersAssignedToMe: 'Assignées à moi', filtersFollowing: 'Suivies',
        filtersInvolvingMe: 'Me concernant', filtersAllAccessible: 'Toutes accessibles', filtersAttention: 'Attention',
        filtersAttentionAny: 'Toutes', filtersAttentionNeedsMe: 'Uniquement les sessions qui ont besoin de moi', filtersScopeNeedsMe: 'A besoin de moi',
        filtersInactive: 'Sessions inactives', filtersInactiveShow: 'Afficher', filtersInactiveHide: 'Masquer',
        filtersHomes: 'Homes', filtersSharedWith: 'Partagées avec', filtersOutsideTeams: 'Personnel et direct',
        filtersTags: 'Tags', filtersSource: 'Source', filtersSourceAll: 'Toutes',
        filtersSourceDirect: 'Externes',
        filtersNoOptions: 'Aucun filtre disponible', filtersClear: 'Effacer les filtres', filtersDone: 'Terminé', filtersArchived: 'Archivées',
        filtersNeedsMeOnly: 'Seulement pour moi', filtersNeedsMeOnlyDescription: 'Sessions qui vous attendent', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} de plus`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 élément` : `${count} éléments`,
        queryInitialLoadingTitle: 'Chargement des sessions…', queryUpdatingTitle: 'Mise à jour des sessions…',
        querySomeHomesUnavailableTitle: 'Certains Homes sont indisponibles', querySomeHomesUnavailableDescription: 'Happier affiche ce qui est accessible. Réessayez lorsque ces Homes seront de nouveau en ligne.',
        queryRefreshFailedTitle: 'Actualisation impossible', queryRefreshFailedRetainedDescription: 'Vos sessions chargées restent affichées. Réessayez pour vérifier les mises à jour.', queryRefreshFailedEmptyDescription: 'Happier n’a pas pu charger les sessions des Homes sélectionnés. Réessayez lorsqu’ils seront accessibles.',
        queryNoMatchesLoadedTitle: 'Aucun résultat dans les sessions chargées', queryNoMatchesLoadedDescription: 'D’autres sessions correspondantes peuvent se trouver sur une page plus ancienne.', querySearchOlder: 'Rechercher dans les anciennes sessions',
        queryMoreAvailableTitle: 'D’autres sessions sont peut-être disponibles', queryMoreAvailableDescription: 'Cette vue contient les sessions chargées. Recherchez dans les anciennes sessions pour continuer.',
        queryNoMatchesTitle: 'Aucune session ne correspond', queryNoMatchesDescription: 'Essayez de modifier les filtres actifs.',
        queryTeamEmptyTitle: 'Cette équipe n’a aucune session', queryTeamEmptyDescription: 'Les sessions partagées avec cette équipe apparaîtront ici.',
        queryMyWorkEmptyTitle: 'Rien dans Mon travail', queryScopeEmptyDescription: 'Essayez une portée plus large ou revenez plus tard.', queryBrowseAllAccessible: 'Afficher toutes les sessions',
        queryAssignedEmptyTitle: 'Aucune session ne vous est assignée', queryFollowingEmptyTitle: 'Aucune session suivie', queryInvolvingEmptyTitle: 'Aucune session ne vous concerne',
        queryAttentionEmptyTitle: 'Aucune session ne nécessite votre attention', queryReachableEmptyTitle: 'Aucune session disponible', queryReachableEmptyDescription: 'Aucune session de cette vue ne correspond dans les Homes accessibles.',
        queryHistoricalSharesWithheldTitle: 'Certaines sessions partagées sont masquées', queryHistoricalSharesWithheldDescription: 'Les sessions partagées avec vous depuis une version antérieure de Happier restent masquées jusqu’à ce que leur propriétaire les mette à jour dans Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} ne fait pas partie de cette vue Sessions`,
        partialHomeNotMountedDescription: 'Ajoutez ce Home à un groupe de Homes visible pour afficher les sessions de l’équipe sans changer le focus.',
        partialShowFromHome: ({ home }) => `Afficher les sessions de ${home}`,
        teamListingUnavailableTitle: 'La liste des sessions d’équipe est indisponible sur ce Home',
        teamListingUnavailableDescription: 'Ce Home ne peut pas encore afficher les sessions d’équipe. Mettez-le à jour ou reconfigurez-le, puis réessayez.',
        teamListingLoadingTitle: ({ team }) => `Chargement des sessions ${team}…`,
        teamListingLoadingDescription: 'Happier vérifie ce que ce Home peut afficher.',
        teamListingProbeFailedTitle: 'Impossible de joindre ce Home',
        teamListingProbeFailedDescription: 'Happier n’a pas pu interroger ce Home pour les sessions d’équipe. Réessayez lorsqu’il sera joignable.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "fr"> = { fr: { accountActorYou: 'Toi', accountActorFormerMember: 'Ancien membre', accountActorUnnamedMember: 'Membre de Happier', accountActorSentBy: ({ name }) => `Envoyé par ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { fr: translated({
        sessionPages: {
            info: {
                continueTitle: 'Continuer',
                continueDescription: 'Démarrez un nouveau travail là où en est cette session.',
                organizeTitle: 'Organiser',
                organizeDescription: 'Où cette session apparaît dans vos listes.',
                activityDescription: 'Ce que fait l’agent, et si vous en êtes averti.',
                detailsTitle: 'Détails',
                detailsDescription: 'Identifiants et historique, pour le support et les scripts.',
                environmentTitle: 'Environnement',
                environmentDescription: 'La machine, le dossier et l’agent de cette session.',
                agentStateDescription: 'Qui pilote l’agent et ce qu’il attend.',
                relatedTitle: 'Associé',
                relatedDescription: 'Autres pages de cette session.',
                developerTitle: 'Développeur',
                developerDescription: 'Données brutes pour le débogage, affichées en mode développeur.',
                leaveLabel: 'Arrêter, archiver ou supprimer',
                leaveFootnote: 'Arrêter met fin au processus en cours. Les sessions archivées peuvent être restaurées. Supprimer efface la session et ses messages définitivement.',
            },
            follow: {
                description: 'Choisissez si cette session vous notifie et parle par la voix.',
            },
            permissions: {
                description: 'Outils que vous avez autorisés depuis un autre appareil pour cette session. Révoquez ceux dont vous ne voulez plus.',
            },
            automations: {
                description: 'Travail exécuté dans cette session selon un horaire, un événement ou à la fin d’un tour.',
            },
            newRun: {
                description: 'Lancez l’exécution d’un sous-agent depuis cette session.',
                transcriptReadOnly: 'Ceci est un historique enregistré. Reconnectez-vous à ce Home pour poursuivre la conversation.',
                daemonReadOnly: 'Cet historique provient du processus de l’agent. Reconnectez-vous à ce Home pour poursuivre la conversation.',
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
>, "fr"> = { fr: {
        due: 'Rappel en attente',
        title: 'Me le rappeler', inOneHour: 'Dans 1 heure', inThreeHours: 'Dans 3 heures',
        tomorrowMorning: 'Demain matin', nextWeek: 'La semaine prochaine', custom: 'Choisir la date et l’heure…',
        customTitle: 'Choisir la date et l’heure',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Choisis une heure future.',
        setReminder: 'Définir le rappel',
        reminderSaved: 'Rappel enregistré',
        presetSaveFailedAfterReminder: 'Le rappel est enregistré, mais l’enregistrement du préréglage n’a pas été confirmé. Réessaie ou ferme cette fenêtre.',
        presetsSaveFailed: 'L’enregistrement des préréglages n’a pas été confirmé. Tes modifications sont conservées ici ; réessaie.',
        presetsChanged: 'Les préréglages enregistrés diffèrent de la liste ouverte. Ferme puis rouvre pour consulter la liste actuelle.',
        remove: 'Supprimer le rappel',
        dateLabel: 'Date', timeLabel: 'Heure', addToPresets: 'Ajouter aux préréglages', presetPreviewUnavailable: 'Choisis une heure future valide pour prévisualiser le préréglage.', managePresets: 'Gérer les préréglages', managePresetsMessage: 'Renomme, réorganise ou supprime tes rappels enregistrés.', presetName: 'Nom du préréglage', movePresetUp: 'Déplacer vers le haut', movePresetDown: 'Déplacer vers le bas', renamePresetLabel: ({ preset }) => `Renommer «${preset}»`, movePresetUpLabel: ({ preset }) => `Déplacer «${preset}» vers le haut`, movePresetDownLabel: ({ preset }) => `Déplacer «${preset}» vers le bas`, deletePresetLabel: ({ preset }) => `Supprimer «${preset}»`, noPresets: 'Aucun préréglage enregistré', noPresetsMessage: 'Enregistre-en un lors de ton prochain rappel personnalisé.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { fr: {
        title: 'Autorisations distantes',
        entryTitle: 'Autorisations distantes',
        entrySubtitle: 'Vérifie et révoque les autorisations distantes limitées à la session',
        loadingTitle: 'Chargement des autorisations distantes',
        loadingReason: 'Vérification des autorisations du propriétaire actuel de la session.',
        emptyTitle: 'Aucune autorisation distante',
        emptyReason: 'Cette session n’a aucune autorisation distante à vérifier.',
        unavailableTitle: 'Autorisations distantes indisponibles',
        unavailableReason: 'Vérifie qu’il s’agit bien du propriétaire actuel de la session et que sa machine est disponible, puis réessaie.',
        ownerOnlyTitle: 'Seul le propriétaire de la session peut gérer les autorisations distantes',
        ownerOnlyReason: 'Les participants partagés peuvent répondre aux demandes éligibles, mais ne peuvent pas vérifier ni révoquer les autorisations du propriétaire de la session.',
        retry: 'Réessayer',
        listTitle: 'Autorisations de la session',
        grantActive: ({ actor }) => `Autorisation active de ${actor}`,
        grantRevoked: ({ actor }) => `Autorisation révoquée de ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Autorisation ${grantId} · Origine ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Révoquer l’autorisation',
        revoking: 'Révocation…',
        revokeConfirmTitle: 'Révoquer l’autorisation distante ?',
        revokeConfirmBody: ({ identifier }) => `Cela révoque immédiatement l’autorisation distante pour ${identifier}.`,
        revokeFailedTitle: 'Impossible de mettre à jour les autorisations distantes',
        revokeFailedReason: 'L’autorisation a peut-être changé ou la machine propriétaire est indisponible. Réessaie.',
        loadMore: 'Charger plus d’autorisations',
        loadingMore: 'Chargement d’autres autorisations…',
        loadMoreFailedReason: 'Impossible de charger d’autres autorisations. Réessaie.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "fr">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "fr"> = { fr: {
        responsibilitySectionTitle: 'Responsabilité',
        responsibilityRowTitle: 'Responsable',
        responsibilityNoOne: 'Personne',
        responsibilityUnnamedPerson: 'Personne sans nom',
        responsibilityPickerTitle: 'Choisir la personne responsable',
        responsibilitySearchPlaceholder: 'Rechercher des personnes ayant accès',
        responsibilityAssignToMe: 'Me l’attribuer',
        responsibilityPeopleWithAccess: 'Personnes ayant accès',
        responsibilityAccessHintOwner: 'Propriétaire',
        responsibilityNoCandidates: 'Personne d’autre n’a encore accès à cette session.',
        responsibilityAccessChanged: 'L’accès a changé. Cette personne ne peut plus être responsable.',
        responsibilityUpdateFailed: 'Happier n’a pas pu changer la personne responsable. Réessaie.',
        responsibilityApprovalPending: 'En attente d’approbation. Rien n’a encore changé : la personne responsable sera mise à jour après l’approbation.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Personne responsable, ${name}. Changer la personne responsable.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Personne responsable, ${name}.`,
        responsibilityA11yEmpty: 'Personne responsable, personne. Changer la personne responsable.',
        responsibilityAssignedToYou: 'Qui vous est attribuée',
        responsibilitySharedWithYou: 'Partagée avec vous',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const fr: typeof en = {
    scheduled: {
        title: "Planifié",
        writesHere: "Écrit ici",
        empty: "Aucun workflow n’est programmé pour écrire ici.",
        step: ({ ordinal, title }) => `étape ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `De ${source} · étape ${step}`,
        notifyOnlyReported: "Seulement si l’agent a signalé quelque chose",
        notifyOnlyReportedDescription: "Ignorer la notification si l’agent ne renvoie aucun texte.",
        notifyOnlyReportedNeedsResult: "Utilisez le résultat texte d’une étape Agent précédente comme message.",
    },
    workerUpdate: {
        state: {
            settled: "a terminé son tour",
            needsYou: "a besoin de vous",
            stalled: "bloquée",
            published: "publié",
            failed: "a échoué",
            stopped: "arrêté",
            timedOut: "délai dépassé",
            finished: "terminé",
        },
        peek: "Aperçu",
        truncated: "Résultat abrégé.",
        wokenBy: ({ count }) => (count === 1 ? 'Réveillé par une mise à jour' : `Réveillé par ${count} mises à jour`),
        notFromYou: 'pas un message de votre part',
    },
    title: 'Travail',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 session' : `${count} sessions`),
        runs: ({ count }) => (count === 1 ? '1 exécution' : `${count} exécutions`),
        nothingStarted: 'Rien de lancé',
    },
    states: {
        recent: 'Récents',
    },
    view: {
        a11y: 'Vue du travail',
        list: 'Liste',
        map: 'Carte',
        expandMap: 'Ouvrir la carte à côté de la session',
    },
    map: {
        folded: "Le travail terminé est replié",
        backgroundRuns: ({ count }) => (count === 1 ? "1 exécution en arrière-plan" : `${count} exécutions en arrière-plan`),
        positionUnder: ({ position, total, parent }) => `${position} sur ${total} sous ${parent}`,
    },
    actions: {
        showInTranscript: 'Afficher dans la transcription',
        makeOrchestrator: 'En faire un orchestrateur',
        makeOrchestratorSubtitle: 'Cette session planifie, délègue et rend compte',
        makeOrchestratorFailed: "Impossible de faire de cette session un orchestrateur",
    },
    putUnder: {
        title: "Placer sous…",
        subtitle: "Rendre compte à une autre session",
        search: "Trouver une session",
        topLevel: "Niveau supérieur — ne rend compte à personne",
        errors: {
            cycle: "Cette session rend déjà compte à celle-ci",
            changed: "La session vient d’être déplacée. Réessayez",
            forbidden: "Vous ne pouvez pas la placer sous cette session",
            failed: "Impossible de déplacer cette session",
        },
    },
    kinds: {
        session: 'Session',
        workflowRun: 'Exécution de workflow',
        backgroundRun: 'Exécution en arrière-plan',
    },
    showMore: ({ count }) => `Afficher ${count} de plus`,
    role: {
        none: 'Aucun',
        handsOff: 'sans les mains',
        a11y: ({ role }) => `Rôle : ${role}. Changer de rôle`,
    },
    empty: {
        title: 'Aucun travail lancé',
        reason: 'Les sessions, workflows et exécutions en arrière-plan lancés par cette session apparaîtront ici, avec tout ce qui a besoin de vous.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} sur ${total}`,
    strip: {
        openInSidebar: 'Ouvrir dans la barre latérale',
        stillWorking: ({ count }) => `${count} encore en cours`,
        needsYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
        a11y: ({ summary }) => `Travail : ${summary}`,
    },
    leadArchived: ({ count }) => `Cette session est archivée · ${count} encore en cours`,
    runsStale: 'Les exécutions de workflows ne sont peut-être pas à jour',
    list: {
        level: ({ level }) => `Niveau ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 sous-session' : `${count} sous-sessions`),
        showReports: ({ name, count }) => (count > 0 ? `Afficher ${count} sessions sous ${name}` : `Afficher les sessions sous ${name}`),
        hideReports: ({ name }) => `Masquer les sessions sous ${name}`,
        reportsWorking: ({ count }) => `${count} en cours`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 sous-session a besoin de vous' : `${count} sous-sessions ont besoin de vous`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Archiver aussi 1 sous-session' : `Archiver aussi ${count} sous-sessions`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 sous-session n’a pas été archivée' : `${count} sous-sessions n’ont pas été archivées`),
    },
    step: {
        drivenBy: "Pilotée par un workflow",
        partOf: ({ run }) => `Fait partie de ${run}`,
        checkedByWorkflow: "Le workflow vérifie le résultat de cette étape : les déclencheurs, les objectifs et les seconds avis ne s'exécutent pas dans cette session.",
        nothingStarted: "Rien n'a été lancé depuis cette étape.",
    },
    invite: {
        orAskFor: "Ou demandez",
    },
    peek: {
        reportsTo: ({ lead }) => `Rend compte à ${lead}`,
        repliesGoHere: 'Les réponses vont à cette session',
    },
};

const notify = { fr: { turn: 'Me prévenir quand ce tour se termine', attention: 'Me prévenir quand mon intervention est nécessaire', armed: 'Vous serez prévenu', cancel: 'Annuler la notification', failed: 'Impossible de modifier la notification. Réessayez.', turnFinished: 'Le tour de cette session est terminé.', needsYou: 'Cette session a besoin de vous.', settings: 'Paramètres des notifications' } };

const runNotify = { fr: { run: 'Me prévenir quand ceci se termine', runFinished: 'Cette exécution est terminée.', runNeedsYou: 'Cette exécution a besoin de vous.', setup: 'Configurer les notifications' } };

const sessionWorkTranslations = { fr: { ...fr, notify: { ...notify.fr, ...runNotify.fr } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const fr = {
    sectionTitle: 'Connexions',
    sectionDescription: 'Comment vos appareils joignent vos machines.',
    directTitle: 'Se connecter directement si possible',
    directOnDescription: 'Les aperçus, les vues en direct et les transferts de fichiers passent directement entre vos appareils quand ils se joignent, et par Happier sinon.',
    directOffDescription: 'Tout passe par Happier. Rien ne se connecte directement à vos machines ; sur le même réseau, c’est un peu plus lent.',
    serverDenied: 'Le serveur de votre Home fait tout passer par Happier : il n’y a rien à choisir ici.',
    machineSectionTitle: 'Connexion',
    machineTitle: ({ machine }: MachineParams) => `Connexion à ${machine}`,
    machineOptionDefault: 'Par défaut',
    machineOptionDirect: 'Directement',
    machineOptionRelay: 'Par Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Suit votre compte : directement quand ${machine} est joignable, sinon par Happier.`,
    machineDefaultOffDescription: 'Suit votre compte : toujours par Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Directement quand ${machine} est joignable, même si votre compte dit le contraire.`,
    machineRelayDescription: 'Toujours par Happier, même sur le même réseau.',
};

const settingsConnectionsTranslations = { fr };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const fr: typeof en = {
    scopeChooseComputer: 'Choisir un ordinateur',
    scopeSetUpComputer: 'Configurer un ordinateur',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} est hors ligne.`,
    defaultsTitle: "Valeurs par défaut des machines",
    localVirtualMachines: "Machines virtuelles locales",
    runningOnly: "Cloud facturé uniquement en marche",
    stoppedBilled: "Cloud facturé à l’arrêt",
    billingUnknown: "Facturation inconnue",
    pageDescription: 'Les ordinateurs sur lesquels vos sessions s’exécutent, et les pools qui choisissent entre eux.',
    thisComputerTitle: 'Cet ordinateur',
    thisComputerRowSubtitle: 'Service d’arrière-plan et ligne de commande',
    thisComputerPageDescription: 'Le service d’arrière-plan et la ligne de commande Happier sur cet appareil.',
    setupSectionTitle: 'Configuration',
    setupRowSubtitle: 'Installez Happier ici et connectez-le à votre Home.',
    addPageDescription: 'Connectez un ordinateur pour que les agents y exécutent vos sessions.',
    addFromComputerTitle: 'Ajoutez des machines depuis un ordinateur',
    addFromComputerDescription: 'Ouvrez Happier sur l’ordinateur à ajouter, ou connectez-en un en SSH depuis Happier sur ordinateur ou dans un navigateur.',
    searchPlaceholder: 'Rechercher des machines',
    count: ({ count }: { count: number }) => (count === 1 ? '1 machine' : `${count} machines`),
    daemonTitle: 'Service d’arrière-plan',
    daemonDescription: 'Exécute vos sessions sur cet ordinateur et le garde connecté à votre Home.',
    unreadableTitle: ({ home }: { home: string }) => `Impossible de lire les machines de ${home}`,
};

const settingsMachinesTranslations = { fr };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { fr: {
        attentionTitle: 'Requiert votre attention',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} doit se connecter sur ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} doit se connecter`,
        serviceSignInExpired: ({ service }) => `La connexion à ${service} a expiré`,
        signIn: 'Se connecter',
        signInAgain: 'Se reconnecter',
        setupTitle: 'Bien démarrer',
        setupProgress: ({ done, total }) => `${done} sur ${total}`,
        setupActionSaveKey: 'Enregistrer la clé',
        setupActionAddMachine: 'Ajouter une machine',
        setupActionShowQr: 'Afficher le QR',
        setupActionScan: 'Scanner',
        setupActionPasteLink: 'Coller le lien',
        setupActionBrowse: 'Parcourir',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} sur cette machine · ${latest} disponible`,
        connectTerminalTitle: 'Connecter un terminal',
        connectTerminalSubtitle: 'Scannez le code affiché par votre terminal, ou collez son lien.',
        quickSettingsTitle: 'Réglages rapides',
        notificationsPushOn: 'Push activées',
        notificationsPushOff: 'Push désactivées',
        notificationsQuietHours: 'Heures calmes activées',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 modification de plugin attend votre validation' : `${count} modifications de plugins attendent votre validation`,
        review: 'Examiner',
        browsePluginsTitle: 'Parcourir les plugins',
        browsePluginsSubtitle: 'Ajoutez des outils, des panneaux et des intégrations à Happier.',
        accountServiceSignedIn: ({ service }) => `Connecté à ${service}`,
        aboutDescription: 'Version, code source et conditions légales (Happier n’est pas affilié à Anthropic).',
        machinesTitle: 'Machines',
        machineOnline: 'En ligne',
        machineOffline: ({ lastSeen }) => `Hors ligne · vue ${lastSeen}`,
        machineUpdateAvailable: 'Mise à jour disponible',
        machinesOnlineCount: ({ count }) => `${count} en ligne`,
        machinesOfflineCount: ({ count }) => `${count} hors ligne`,
        machineLastSeen: ({ lastSeen }) => `vu ${lastSeen}`,
        update: 'Mettre à jour',
        asOf: ({ time }) => `À ${time}`,
        usageTitle: 'Utilisation',
        usageLeft: ({ percent }) => `${percent} % restant`,
        usageResets: ({ time }) => `réinitialisé ${time}`,
        securityTitle: 'Sécurité',
        startSessionLabel: 'Démarrer une session',
        saveRecoveryKeyTitle: 'Enregistrez votre clé de récupération',
        saveRecoveryKeySubtitle: 'Le seul moyen de retrouver vos données chiffrées si vous perdez tous vos appareils.',
        addMachineTitle: 'Ajouter une machine',
        addMachineSubtitle: 'Connectez un ordinateur sur lequel vos agents s’exécutent.',
        homeGreetingNamed: ({ name }) => `Bon retour, ${name}.`,
        homeStartSection: 'Démarrer une session',
        homeCustomize: 'Personnaliser l’accueil',
        homeCustomizeDescription: 'Choisissez les sections affichées sur votre accueil et leur ordre.',
        homeAlwaysShown: 'Toujours affichée',
        homeShowSection: 'Afficher',
        homeHideSection: 'Masquer la section',
        homeSectionOptions: 'Options de la section',
        homeResetLayout: 'Rétablir par défaut',
        homeLayoutSectionTitle: 'Accueil',
        homeAddWidgetsTitle: 'Ajouter des widgets',
        homeAddWidgetsDescription: 'Les widgets proposés par vos plugins. Ajoutez-en un pour l’afficher sur votre accueil.',
        homeWidgetFromPlugin: ({ plugin }) => `De ${plugin}`,
        homeRemoveWidget: 'Retirer de l’accueil',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "fr">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { fr: translated({
        settingsProfilesPage: {
            pageDescription: "Réglages de démarrage d'une nouvelle session : l'agent, le modèle, les variables d'environnement et l'endroit où elle s'exécute.",
            useProfilesSection: 'Choix du profil',
            useProfilesSectionDescription: "Choisissez un profil au démarrage d'une session, ou démarrez chaque session avec l'environnement de la machine.",
            useProfiles: 'Utiliser les profils',
            useProfilesOffDescription: "Désactivé. Les nouvelles sessions utilisent l'environnement de la machine.",
            favoritesDescription: 'Affichés en premier lorsque vous choisissez un profil.',
            customDescription: 'Les profils que vous avez créés. Modifier un profil intégré enregistre ici votre propre copie.',
            builtInDescription: 'Des profils prêts à l’emploi pour chaque agent.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Les hôtes SSH que cet ordinateur peut configurer comme machines, auxquels il peut se connecter ou sur lesquels il peut exécuter un relais.',
            savedHostsSection: 'Hôtes enregistrés',
            savedHostsDescription: "Les plus récemment utilisés d'abord. Ouvrez un hôte pour l'utiliser ou le modifier.",
            hostPageDescription: "Un hôte SSH que cet ordinateur peut configurer comme machine, auquel il peut se connecter ou sur lequel il peut exécuter un relay.",
            newHostTitle: "Nouvel hôte distant",
            newHostDescription: "Nommez l'hôte et indiquez comment le joindre en SSH.",
            useSection: "Utiliser cet hôte",
            useSectionDescription: "Ce que cet appareil peut en faire.",
            maintenanceSection: "Happier sur cet hôte",
            maintenanceSectionDescription: "Installer, mettre à jour et exécuter la ligne de commande, le service d'arrière-plan et le relay de Happier sur place.",
            discard: "Abandonner",
            accessTitle: "Clés et connexions",
            accessRowSubtitle: "Clés d'hôte approuvées et tunnels ouverts",
            accessPageDescription: "Les clés d'hôte que cet appareil approuve, ainsi que les tunnels et accès ouverts vers vos hôtes.",
            hostNotFound: "Cet hôte n'est plus enregistré.",
            unavailableDescription: 'Les hôtes SSH enregistrés peuvent être configurés comme machines ou servir de relais.',
            trustedHostKeysDescription: "Les clés acceptées par cet appareil lors de la connexion. Supprimez-en une pour que la question soit reposée la prochaine fois.",
            trustedHostKeysEmpty: 'Aucune clé d\'hôte approuvée pour l\'instant. Elles apparaissent ici dès que vous en acceptez une lors d\'une connexion.',
            sshTunnelsDescription: 'Tunnels ouverts depuis cet appareil vers un hôte enregistré.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const localTranslations = { fr: { title: 'Sur cette machine', footer: 'Services trouvés sur cette machine. Le lieu d’exécution des modèles dépend du service.', detected: 'Détectés', possible: 'Service possible', detectedAtPort: ({ port }: { port: string }) => `Détecté · Port ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Service ${provider} possible · Port ${port}`, addConnectionTitle: 'Ajouter une autre connexion locale', addConnectionDescription: 'Nomme cette connexion pour la distinguer de tes autres endpoints locaux.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} local` } } as const;

const providerManagedDeploymentTranslations = { fr: {
        configureManaged: 'Lancer les sessions avec un service local géré',
        configureManagedDescription: 'Choisis le compte connecté ou le groupe utilisé par les futures sessions. Happier démarre le service quand une session en a besoin.',
        subscriptionPolicyTitle: 'Le routage par abonnement est expérimental',
        subscriptionPolicyDescription: 'La politique ou l’application des règles en amont peut changer et faire cesser de fonctionner le routage adossé à un abonnement. Happier expose le rejet et n’utilise pas silencieusement un autre identifiant.',
        accountScopeMismatchTitle: 'Les comptes connectés vivent sur le serveur actif',
        accountScopeMismatchDescription: 'Ce provider est géré sur une machine d’un autre serveur. Bascule vers ce serveur pour choisir son compte connecté ou son groupe.',
        editManagedDefaults: 'Modifier les valeurs par défaut des sessions gérées',
        editManagedDefaultsDescription: 'Change le compte connecté ou le groupe pour les futures sessions. Les sessions existantes conservent leur sélection enregistrée.',
        purposeTargetTitle: 'Cible de compte connecté',
        purposeTargetDescription: 'Choisis un compte connecté ou un groupe disponible pour cet usage.',
        invalidPurposeTargetTitle: 'Cible de compte connecté invalide',
        invalidPurposeTargetDescription: 'Choisis un compte connecté ou un groupe disponible avant d’enregistrer.',
        useExternal: 'Utiliser un service externe',
        useExternalDescription: 'Empêche Happier de gérer ce provider pour les futures sessions et utilise sa configuration d’endpoint externe.',
        useExternalConfirmTitle: 'Utiliser un service externe ?',
        useExternalConfirmDescription: 'Les valeurs par défaut de compte connecté géré sont supprimées. Les sessions existantes conservent leurs sélections enregistrées.',
    } } as const;

const copyNameTranslations = { fr: ({ name }: { name: string }) => `${name} copie` } as const;

const providerSharedFieldTranslations = { fr: {
        local: { installedNotRunning: 'Installé, mais pas démarré', appRunningServerOff: 'L’app est ouverte, mais son serveur local est éteint', startManaged: ({ provider }: { provider: string }) => `Démarrer ${provider}`, startedByHappier: 'Démarré par Happier', runningOutsideHappier: 'S’exécute en dehors de Happier' },
        apiKeyOptionalDescription: 'Optionnel — choisis un secret enregistré si ce provider en requiert un',
        models: { addDescription: 'Ajoute les ids de modèle que ce provider ne liste pas automatiquement', addHelp: 'Saisis un id de modèle exact par ligne. Les modèles existants sont ignorés.', addFieldLabel: 'Ids de modèle', invalidModelIds: ({ ids }: { ids: string }) => `Ces ids de modèle sont invalides : ${ids}`, noNewModels: 'Aucun nouvel id de modèle à ajouter.', providerManagedTitle: 'Les modèles sont gérés par ce provider', providerManagedDescription: 'Actualise le catalogue du provider pour mettre à jour cette liste. Les ids de modèle manuels ne sont pas pris en charge.', showAll: 'Afficher tous les modèles', hideAll: 'Masquer tous les modèles', hideAllConfirmation: 'Masquer tous les modèles de cette liste ? Tu peux les réafficher à tout moment.', showOnly: 'Afficher uniquement ce modèle', showOnlyConfirmation: 'Masquer tous les autres modèles de cette liste ? Tu peux les restaurer à tout moment.' },
    } } as const;

const providerFirstSessionValidationTranslations = { fr: 'Happier validera la connexion en toute sécurité au démarrage de la première session qui l’utilise.' } as const;

const providerMigrationTranslations = { fr: { reviewTitle: 'Vérifier la migration du provider', reviewFooter: 'Vérifie l’endpoint, le format d’API, la liaison d’identifiant et les ids de modèle avant que Happier ne modifie ce profil.', legacyProfileDescription: 'Ce profil contient un routage de provider hérité. Il continue de fonctionner jusqu’à ce que tu confirmes cette vérification.', credentialTitle: 'Liaison d’identifiant', credentialFooter: 'Happier ne déplace que la référence au secret enregistré sélectionné. La valeur du secret n’est jamais affichée ni copiée.', noCredential: 'Aucune clé API', credentialMoveDescription: 'Déplacer la liaison de ce profil vers la nouvelle connexion de provider', noCredentialDescription: 'Créer la connexion de provider sans liaison d’identifiant', actionsTitle: 'Migration', preview: 'Vérifier les changements', previewDescription: 'Valider ce mapping exact sans modifier les réglages', confirm: 'Créer la connexion de provider', confirmDescription: 'Appliquer le mapping vérifié de façon atomique et conserver les préférences de lancement restantes', reviewAction: 'Vérifier la migration du provider', reviewActionDescription: 'Déplacer les réglages hérités d’endpoint et de modèle dans une connexion de provider', retainedTitle: 'Configuration de provider héritée conservée', retainedDescription: 'Cette configuration reste disponible jusqu’à ce que son contrat de provider complet puisse être migré sans perte de comportement.' } } as const;

const providerMigrationPreviewTranslations = { fr: { willMoveTitle: 'Sera déplacé vers le provider', willMoveFooter: 'Seuls ces noms de routage et d’identifiant sont déplacés. Les valeurs de secret ne sont jamais affichées.', willKeepTitle: 'Restera dans le profil de lancement', willKeepFooter: 'Ces réglages propres au lancement restent avec le profil après la migration.', permissionDefaults: 'Permissions par défaut', persistenceDefaults: 'Stockage de session par défaut' } } as const;

const providerMigrationConflictTranslations = { fr: { conflictReviewTitle: 'Résoudre le conflit de migration du provider', conflictReviewFooter: 'Choisis de conserver la connexion existante ou de préserver ce profil comme connexion nommée séparée. Aucune valeur de secret n’est affichée.', conflictCredential: 'L’identifiant enregistré diffère', conflictModels: 'Les réglages de modèle diffèrent', conflictEditedConnection: 'La connexion existante a été modifiée', keepExisting: 'Conserver la connexion existante', keepExistingDescription: 'Conserve ses identifiants et modèles actuels, puis termine cette migration de profil sans les remplacer.', modelOutcomeTitle: 'Choisis quel modèle conserver', modelOutcomeFooter: 'Vérifie le modèle exact avant de terminer la migration. Rien n’est modifié tant que tu n’as pas choisi.', useExistingModel: 'Utiliser le modèle actuel de la connexion', useExistingModelDescription: 'Conserve le modèle déjà sélectionné pour cette connexion de provider.', preserveLegacyModel: 'Utiliser le modèle du profil', preserveLegacyModelDescription: 'Déplace le choix de modèle exact de ce profil vers la connexion de provider existante.', discardLegacyModel: 'Supprimer le choix de modèle du profil', discardLegacyModelDescription: 'Termine la migration sans la sélection de modèle ni l’intention de favori de ce profil.', createNamed: 'Créer une connexion séparée', createNamedDescription: 'Préserve les réglages de provider de ce profil dans une nouvelle connexion nommée.', separateConnectionName: 'Nom de la connexion', conflictReviewAction: 'Résoudre le conflit de provider', conflictReviewActionDescription: 'Choisis comment préserver les identifiants ou modèles en conflit' } } as const;

const providerCredentialSelectionRequiredTranslations = { fr: 'Choisis quel identifiant enregistré cette connexion de provider doit utiliser' } as const;

const providerLinkTranslations = { fr: { providerWebsite: 'Site du provider', getApiKey: 'Obtenir une clé API', failedToOpen: 'Happier n’a pas pu ouvrir ce lien.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { fr: 'Choisis comment cet identifiant est envoyé' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { fr: 'Connecte cet éditeur de profil à une machine disponible avant de modifier les variables d’environnement.' } as const;

const providerAdvancedAuthoringTranslations = { fr: { advancedSetup: 'Configuration avancée', advancedSetupEnabled: 'Configure plusieurs styles d’API, en-têtes et sondes sûres de liste de modèles', advancedSetupDisabled: 'Utiliser un endpoint compatible courant', endpointEnabled: 'Utiliser ce style d’API', endpointEnabledDescription: 'Exposer cet endpoint aux agents compatibles', endpointDisabledDescription: 'Ce style d’API ne sera pas utilisé', publicHeaders: 'En-têtes non secrets', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: 'Chemins de liste de modèles (optionnel, un par ligne)', probeParserTitle: 'Format de réponse', probeParser: { openaiModels: 'Liste de modèles compatible OpenAI', ollamaTags: 'Tags Ollama', lmStudioNative: 'Liste de modèles native LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { fr: 'En-tête personnalisé (token Bearer)' } as const;

const providerNonSecretHeaderTranslations = { fr: 'En-têtes non secrets' } as const;

const providerProbePathsTranslations = { fr: 'Chemins de liste de modèles (optionnel, un par ligne)' } as const;

const providerLocalAuthoringTranslations = { fr: { enableAfterSaving: 'Activer ce provider', enableOnCurrentMachine: 'Activer uniquement sur cette machine après l’enregistrement', enableAccountWide: 'Activer après l’enregistrement', localAddressTitle: 'Adresse locale', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Active-le séparément sur chaque machine. ${machine} utilisera ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { fr: { destinationReview: 'Destination de la connexion', destinationLoading: 'Résolution de la destination exacte sur le daemon…', destinationSelection: 'Choisis une destination', destinationSelectionDescription: 'Vérifie l’adresse exacte avant de connecter.', destinationScope: 'Portée de la destination', destinationMachine: 'Cette machine', destinationAccount: 'Compte' } } as const;

const providerCompatibilityTranslations = { fr: { title: 'Compatible avec', footer: 'La compatibilité est vérifiée par chaque intégration d’agent et peut varier selon le modèle.', verified: 'Vérifié', experimental: 'Expérimental', incompatible: 'Incompatible', verifiedDescription: 'Testé avec cette intégration d’agent', experimentalDescription: 'Peut fonctionner, mais à vérifier avant la première utilisation', incompatibleDescription: 'Cet agent ne peut pas utiliser la connexion en toute sécurité' } } as const;

const providerModelNotLoadedTranslations = { fr: 'Non chargé · peut se charger à la première utilisation' } as const;

const providerModelLoadCancellationTranslations = { fr: { cancelLoad: 'Annuler le chargement', loadCancelled: 'Attente du modèle interrompue', loadCancelledProviderMayContinue: 'Le provider peut continuer à le charger. Actualise le catalogue plus tard pour prendre en compte une fin tardive ; Happier ne rejouera pas le chargement.' } } as const;

const providerPartialStatusTranslations = { fr: 'Partiellement disponible' } as const;

const providerConnectedServiceSuppressedTranslations = { fr: 'La connexion native au service connecté de l’agent n’est pas utilisée avec ce provider. Ta sélection enregistrée est inchangée.' } as const;

const providerMachineCleanupPendingTranslations = { fr: 'La machine a été supprimée, mais ses réglages d’accès au provider n’ont pas pu être enregistrés. Vérifie ta connexion et supprime à nouveau la machine pour réessayer le nettoyage.' } as const;

const providerConnectionChangedTranslations = { fr: { title: 'La connexion au provider a changé', description: 'Recharge les réglages actuels du provider, puis réessaie.' } } as const;

const providerModelSectionTranslations = { fr: { available: 'Disponible', manual: 'Manuel' } } as const;

const providerCompletenessTranslations = { fr: {
        searchEmptyTitle: 'Aucun provider ne correspond à cette recherche',
        searchEmptyDescription: 'Essaie un autre nom de provider ou de connexion.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Aucun protocole d’API pris en charge ne recoupe celui de cet agent.',
            noAuthUnsupported: 'Cet agent nécessite un transport par clé API pour ce provider.',
            credentialTransportUnavailable: 'Le transport de clé API configuré n’est pas pris en charge par cet agent.',
            optionalCredentialNoAuthUnsupported: 'Cet agent ne peut pas utiliser le provider sans la clé API optionnelle.',
            capabilityUnsupported: 'Une capacité requise du provider n’est pas prise en charge.',
            capabilityUnknown: 'Une capacité requise du provider n’a pas été vérifiée.',
            modelEvidenceRequired: 'Choisis un modèle pour vérifier ses capacités requises.',
            modelCapabilityUnsupported: 'Le modèle ne prend pas en charge une capacité requise.',
            modelCapabilityUnknown: 'Une capacité requise du modèle n’a pas été vérifiée.',
            overrideIncompatible: 'La vérification du provider marque cette intégration comme incompatible.',
            overrideExperimental: 'La vérification du provider marque cette intégration comme expérimentale.',
            evidenceMissing: 'Aucune preuve de compatibilité n’a encore été enregistrée.',
            agentUnsupported: 'Cet agent ne prend pas en charge les providers de modèles externes.',
            adapterInvalid: 'L’adaptateur de provider de l’agent n’a pas pu être validé.',
            unknown: 'Une condition de compatibilité plus récente demande une vérification.',
        },
        unsavedDescription: 'Abandonner ce brouillon de provider ? Les secrets enregistrés sont des objets partagés du compte et resteront disponibles.',
        recoveryActions: {
            reviewFeatures: 'Vérifier la disponibilité des providers',
            chooseConnection: 'Choisir un provider',
            restorePlugin: 'Vérifier le plugin',
            enableConnection: 'Activer le provider',
            reviewAccountGrant: 'Vérifier l’accès au compte',
            enableOnMachine: 'Activer sur la machine',
            reviewMachineGrant: 'Vérifier l’accès machine',
            reviewCompatibility: 'Vérifier la compatibilité',
            addSecret: 'Ajouter une clé API',
            reviewCredentialTransport: 'Vérifier la prise en charge des identifiants',
            reviewConnection: 'Vérifier la connexion',
            retry: 'Réessayer',
            replaceSecret: 'Remplacer la clé API',
            chooseModel: 'Choisir un modèle',
            loadModel: 'Charger le modèle',
            reviewAndRestart: 'Vérifier et redémarrer',
            restartProbe: 'Retester',
            reduceProviderSettings: 'Gérer les réglages du provider',
            reviewProfileMigration: 'Vérifier la migration du profil',
            reviewCurrentState: 'Vérifier les réglages actuels',
        },
        hiddenForAllAgents: 'Masqué pour tous les agents · Gérer dans les réglages du provider',
    } } as const;

const providerAvailabilityTranslations = { fr: {
        availabilityChecking: 'Vérification de la disponibilité des providers', availabilityCheckingDescription: 'Happier vérifie si ce serveur prend en charge les connexions aux providers.',
        availabilityProblem: 'Impossible de vérifier la disponibilité des providers', availabilityProblemDescription: 'Happier réessaiera automatiquement. Vérifie la connexion au serveur si cela persiste.',
        availabilityUnsupported: 'Les providers nécessitent une mise à jour du serveur', availabilityUnsupportedDescription: 'Cette version du serveur ne prend pas en charge les connexions aux providers.',
        availabilityContextUnsupported: 'Les providers ne sont pas pris en charge dans ce contexte', availabilityContextUnsupportedDescription: 'La configuration ou la sélection actuelle du serveur ne peut pas prendre en charge les connexions aux providers.',
        availabilityPolicyDisabled: 'Les providers sont désactivés par la politique', availabilityPolicyDisabledDescription: 'Une politique locale ou de build a désactivé les connexions aux providers.',
    } } as const;

const fr = {
    title: 'Providers', entrySubtitle: 'Connecter des sources de modèles cloud et locales', detailTitle: 'Connexion au provider',
    configuredTitle: 'Tes providers', configuredFooter: 'Les modèles des providers activés apparaissent dans les sélecteurs de modèle des agents compatibles.',
    availableTitle: 'Disponible', availableFooter: 'Ajoute un provider une fois, puis utilise ses modèles avec tous les agents compatibles.',
    customTitle: 'Provider personnalisé', customFooter: 'Connecte une gateway d’entreprise ou un autre endpoint de modèles compatible.',
    addCustom: 'Ajouter un provider personnalisé', addCustomDescription: 'Utilise un endpoint compatible OpenAI ou Anthropic',
    emptyTitle: 'Aucun provider connecté pour l’instant', emptyDescription: 'Choisis un provider disponible ci-dessous ou ajoute ton propre endpoint.',
    unavailable: 'Les providers ne sont pas disponibles', unavailableDescription: 'Ce serveur n’a pas activé les connexions aux providers.',
    noMachine: 'Aucune machine disponible', noMachineDescription: 'Connecte une machine pour configurer et tester les providers.',
    problemTitle: 'Le provider demande ton attention', searchPlaceholder: 'Rechercher des providers',
    status: { available: 'Connecté', notChecked: 'Non vérifié', needsAttention: 'Nécessite ton attention', unreachable: 'Injoignable', disabled: 'Désactivé', sourceUnavailable: 'Plugin indisponible' },
    kind: { frontier: 'Provider de modèles', aggregator: 'Catalogue de modèles', cloud: 'Provider cloud', local: 'S’exécute sur cette machine' },
    detail: {
        pickSecretTitle: 'Choisir une clé API', notFoundTitle: 'Provider introuvable', notFoundDescription: 'Cette connexion de provider n’existe plus.',
        deletedDescription: 'Ce provider a été supprimé. Choisis un autre modèle avant de reprendre les sessions qui l’utilisaient.', sourceAvailable: 'Plugin de provider disponible',
        connectionTitle: 'Connexion', connectionFooter: 'Contrôle où ce provider peut être utilisé et vérifie son statut actuel.',
        accountAccess: 'Utiliser sur toutes les machines', accountAccessDescription: 'Disponible partout où ce provider pointe vers un endpoint public',
        testConnection: 'Tester la connexion', testDescription: 'Vérifier l’endpoint et actualiser son catalogue de modèles', testSucceeded: 'Connexion réussie',
        testNotSupported: 'Ce provider ne prend pas en charge de test de connexion automatique', machinesTitle: 'Machines', machinesFooter: 'Les endpoints locaux et privés doivent être activés séparément sur chaque machine.',
        currentMachine: 'Machine actuelle', selectMachineToManage: 'Sélectionne cette machine pour vérifier et modifier son accès', targetMachine: 'Machine cible',
        machineOnline: 'En ligne', machineOffline: 'Hors ligne', apiKeyTitle: 'Clé API', apiKeyFooter: 'Les clés restent dans les secrets enregistrés et ne sont jamais affichées ici.',
        accountApiKey: 'Clé API par défaut', machineApiKey: 'Clé API sur cette machine', apiKeyConfigured: 'Configurés', apiKeyMissing: 'Ajoute une clé pour connecter',
        apiKeySelected: 'Clé enregistrée sélectionnée', useAccountApiKey: 'Utilise la clé par défaut si aucune clé de machine n’est définie', modelsTitle: 'Modèles', manageModels: 'Gérer les modèles',
        modelsUnknown: 'Les modèles apparaissent après la connexion', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'modèle' : 'modèles'}`,
        actionsTitle: 'Actions', duplicateTitle: 'Ajouter une autre connexion', duplicateDescription: 'Créer une connexion nommée séparément vers le même provider',
        deleteTitle: 'Supprimer le provider', deleteDescription: 'Les sessions existantes conservent leur historique, mais ne peuvent pas reprendre avec ce provider.',
        advancedTitle: 'Avancé', endpointDefault: 'Endpoint par défaut', endpointMachine: 'Endpoint sur cette machine', endpointMachineDescription: 'Ne surcharger la valeur par défaut que là où cette machine exécute le provider',
        endpointPrompt: 'Saisis l’URL de base complète du provider.', resetEndpoint: 'Réinitialiser l’endpoint', resetMachineEndpoint: 'Utiliser l’endpoint par défaut sur cette machine', resetDefaultEndpoint: 'Utiliser l’endpoint fourni par le plugin du provider',
    },
    authoring: {
        providerTitle: 'Provider', builtInDescription: 'Choisis un secret enregistré, puis connecte ce provider.', compatibilityTitle: 'Compatibilité', compatibilityFooter: 'Choisis le style d’API documenté par ton provider.', protocolTitle: 'Compatibilité API',
        protocol: { 'openai-responses': { title: 'Compatible OpenAI Responses', description: 'Pour les gateways qui implémentent l’API Responses' }, 'openai-chat': { title: 'Compatible OpenAI Chat', description: 'Pour les gateways qui implémentent Chat Completions' }, anthropic: { title: 'Compatible Anthropic', description: 'Pour les gateways qui implémentent l’API Messages' } },
        detailsTitle: 'Détails du provider', name: 'Nom', namePlaceholder: 'Gateway d’entreprise', baseUrl: 'URL de base', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Chemin des modèles',
        credentialsTitle: 'Identifiants', credentialsFooter: 'Sélectionne un secret enregistré. Ne colle jamais de clé API dans l’URL ou les en-têtes.', requiresApiKey: 'Nécessite une clé API',
        requiresApiKeyYes: 'Utiliser un secret enregistré pour les requêtes', requiresApiKeyNo: 'Connecter sans identifiants', apiKey: 'Clé API', apiKeyDescription: 'Choisir ou créer un secret enregistré',
        credentialStyleTitle: 'Format de clé API', credentialHeader: 'Nom du header', credentialStyle: { bearer: 'Token bearer Authorization', xApiKey: 'En-tête x-api-key', apiKey: 'En-tête api-key', customHeader: 'En-tête personnalisé (valeur brute)' },
        catalogTitle: 'Catalogue de modèles', catalogFooter: 'Récupère les modèles automatiquement quand l’endpoint le permet, ou ajoute-les manuellement plus tard.', fetchModels: 'Récupérer les modèles automatiquement',
        fetchModelsYes: 'Utiliser l’endpoint de liste de modèles du provider', fetchModelsNo: 'Ajouter les ids de modèle manuellement', verifyTitle: 'Connecter', verifyFooter: 'Teste d’abord si possible, puis enregistre le provider.', save: 'Enregistrer le provider', connect: 'Connecter le provider',
    },
    errors: {
        machineOfflineTitle: "Cette machine est hors ligne",
        machineOfflineDescription: "Les fournisseurs sont vérifiés sur une machine. Choisissez-en une autre ou démarrez-la, puis réessayez.",
        machineTimeoutTitle: "Cette machine n’a pas répondu",
        machineTimeoutDescription: "Cette machine n’a pas répondu pendant la vérification des fournisseurs. Réessayez.",
        runCredentialRequiredTitle: "Choisir un identifiant pour ce Run", runCredentialRequiredDescription: "Ce Run ne peut pas hériter de l’identifiant direct de la session. Choisissez un identifiant du Team pour le Run.", secretMissingTitle: 'Clé API nécessaire', secretMissingDescription: 'Choisis un secret enregistré avant d’activer ce provider.', notEnabledOnMachineTitle: 'Non activé sur cette machine',
        notEnabledOnMachineDescription: 'Active ce provider pour la machine où la session s’exécutera.', disabledTitle: 'Le provider est désactivé', disabledDescription: 'Active ce provider avant d’utiliser ses modèles.',
        unreachableTitle: 'Le provider est injoignable', unreachableDescription: 'Vérifie que le service tourne et que l’endpoint est correct, puis réessaie.',
        notFoundTitle: 'Provider introuvable', notFoundDescription: 'Ce provider a été supprimé. Choisis un autre provider ou modèle.', sourceUnavailableTitle: 'Plugin de provider indisponible', sourceUnavailableDescription: 'Réactive ou réinstalle le plugin qui fournit cette connexion.',
        featureDisabledTitle: 'Les providers sont indisponibles', featureDisabledDescription: 'Ce serveur n’a pas activé les connexions aux providers.', unauthorizedTitle: 'Clé API rejetée',
        unauthorizedDescription: 'Remplace le secret enregistré par une clé valide, puis teste à nouveau la connexion.', rateLimitedTitle: 'Le provider est en limite de débit', rateLimitedDescription: 'Attends un instant, puis réessaie la connexion.', probeCapacityTitle: 'Trop de vérifications de provider en même temps', probeCapacityDescription: 'Happier n’a pas encore pu lancer cette vérification sur la machine sélectionnée. Attends un instant, puis réessaie.',
        genericTitle: 'Le provider demande ton attention', genericDescription: 'Vérifie les réglages du provider et réessaie.',
    },
    models: { builtIn: 'Intégré', experimental: 'Expérimental', experimentalConfirmTitle: 'Utiliser un modèle expérimental ?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${model} de ${provider} changé de `, experimentalConfirmAction: 'Utiliser le modèle', stale: 'Peut être indisponible', hidden: 'Masqué', manage: 'Gérer les modèles', empty: 'Aucun modèle n’est encore disponible pour ce provider.', add: 'Ajouter des modèles', addPlaceholder: 'Saisis un id de modèle par ligne', resetVisibility: 'Réinitialiser la visibilité', showHidden: 'Afficher les modèles masqués', hideHidden: 'Masquer les modèles masqués', remove: 'Supprimer le modèle', removeConfirmation: 'Supprimer ce modèle ajouté manuellement ?', enable: 'Afficher le modèle', disable: 'Masquer le modèle', load: 'Charger le modèle', retry: 'Réessayer', connectionUnavailable: 'Ce provider est indisponible sur la machine sélectionnée.' },
};

const settingsProvidersTranslations = { fr: withProviderSharedFields(fr, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.fr,
        providerLinkTranslations: providerLinkTranslations.fr,
        providerCompletenessTranslations: providerCompletenessTranslations.fr,
        providerPartialStatusTranslations: providerPartialStatusTranslations.fr,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.fr,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.fr,
        providerCompatibilityTranslations: providerCompatibilityTranslations.fr,
        providerMigrationTranslations: providerMigrationTranslations.fr,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.fr,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.fr,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.fr,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.fr,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.fr,
        localTranslations: localTranslations.fr,
        providerSharedFieldTranslations: providerSharedFieldTranslations.fr,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.fr,
        copyNameTranslations: copyNameTranslations.fr,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.fr,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.fr,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.fr,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.fr,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.fr,
        providerProbePathsTranslations: providerProbePathsTranslations.fr,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.fr,
        providerModelSectionTranslations: providerModelSectionTranslations.fr,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.fr,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.fr,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.fr,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { fr: translated({
        settingsSearchKeywords: {
            settings: 'réglages, paramètres, accueil, aperçu',
            groupProfileAndAccount: 'compte, profil, facturation, forfait, utilisation',
            account: 'compte, profil, facturation',
            accountSecurity: 'sécurité, mot de passe, récupération, chiffrement, déconnexion',
            apiTokens: 'jeton api, jeton d’accès personnel, pat, automatisation, cli, sdk',
            teams: 'équipes, membres, groupes, invitations',
            homeAdministration: 'home, administration, gouvernance, personnes, règles',
            secrets: 'secrets, clés, env, jetons',
            usage: 'utilisation, facturation, limites, quota',
            machines: 'machines, appareils, ordinateur',
            machinePoolsNew: 'pools de machines, pools, repli, exécuter sur',
            machinesAdd: 'ajouter, machine, ssh',
            machinesThisComputer: 'cet ordinateur, local, appareil',
            remoteHosts: 'distant, hôte, hôtes, ssh, serveur, machines',
            groupGeneral: 'général, apparence, langue, expériences',
            appearance: 'apparence, thème, police, interface, barre latérale',
            keyboard: 'clavier, raccourci, raccourcis, touches, commandes',
            pets: 'compagnons, blink, compagnon, codex',
            language: 'langue, région, traduction',
            features: 'fonctionnalités, expériences, bêta',
            groupAiAndAgents: 'agents, fournisseurs, mcp, prompts, voix',
            agents: 'fournisseurs, agents, modèles, llm',
            providers: 'fournisseurs, modèles, openrouter, ollama, lm studio',
            subAgent: 'sous-agents, agents, délégation, règles',
            roles: 'rôles, orchestrateur, constructeur, relecteur, instructions',
            delegation: 'délégation, profondeur, transfert, orchestrateur',
            profiles: 'profils, personas',
            connectedServices: 'services connectés, oauth, comptes',
            mcp: 'mcp, outils, serveurs, plugins',
            plugins: 'plugins, extensions, catalogue, descripteur, découverte',
            prompts: 'prompts, modèles, bibliothèque',
            promptsTemplates: 'modèles',
            promptsFolders: 'dossiers',
            promptsStacks: 'piles',
            promptsRegistries: 'registres',
            promptsLibrary: 'bibliothèque',
            promptsAssets: 'ressources, externe',
            voice: 'voix, assistant, micro',
            voiceConversations: 'voix, conversation, temps réel, fournisseur',
            voiceDictation: 'voix, dictée, parole, transcription',
            voicePrivacy: 'voix, confidentialité, historique, conservation',
            voiceAdvanced: 'voix, avancé, machine, diagnostic',
            memory: 'mémoire, recherche, index',
            groupSessionsBehavior: 'sessions, transcription, autorisations, actions',
            session: 'session, terminal, console, tmux',
            externalSessions: 'sessions externes, suivi en arrière-plan, hooks',
            actions: 'actions, approbations, raccourcis',
            embeds: 'intégrations, intégrer, iframe, widget, site web, discussion',
            transcript: 'transcription, discussion, mise en page',
            permissions: 'autorisations, approbation, sécurité',
            toolRendering: 'outils, affichage',
            handoff: 'transfert, passation',
            runs: 'exécutions, exécution',
            groupFilesAndSourceControl: 'fichiers, gestion de versions, pièces jointes',
            sourceControl: 'git, scm, gestion de versions',
            attachments: 'pièces jointes, envois, fichiers',
            groupSystem: 'système, serveurs, état, notifications',
            servers: 'serveurs, relais',
            systemStatus: 'état du système, santé, diagnostic',
            updates: 'mises à jour, mettre à jour, version, cli, redémarrer',
            notifications: 'notif, notification, notifications, push, alertes',
            notificationsPush: 'push, notifications push',
            desktop: 'bureau, tauri, superposition, fenêtre',
            diagnosis: 'diagnostic, débogage',
            reportIssue: 'signaler un problème, bug',
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
>, "fr"> = { fr: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Corrige le test de reconnexion instable',
                agentReply: 'Trouvé : le minuteur de relance n’était jamais effacé. C’est corrigé et le test passe.',
                thinking: 'Le test n’échoue qu’après un délai d’attente, donc le minuteur de relance tourne sans doute encore.',
            },
            runtime: {
                pageDescription: 'Comment les sessions s’exécutent sur vos machines.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Hôte de terminal pour les nouvelles sessions',
                terminalHostNone: 'Aucun',
                tmuxTitle: 'Lancer les sessions dans tmux',
                tmuxOn: 'Les nouvelles sessions s’ouvrent dans leur propre fenêtre tmux, pour que vous puissiez vous y attacher depuis un terminal.',
                tmuxOff: 'Les nouvelles sessions s’exécutent dans un shell classique.',
            },
            wizard: {
                pageDescription: 'Comment l’assistant de nouvelle session dispose ses étapes.',
                wideScreensSection: 'Grands écrans',
                stepsSection: 'Comment chaque étape présente ses choix',
                steps: {
                    profiles: 'Profil',
                    backends: 'Agent',
                    models: 'Modèle',
                    machines: 'Machine',
                    paths: 'Dossier',
                    permissions: 'Autorisations',
                },
            },
            providerLimits: {
                pageDescription: 'Ce qui se passe quand la limite d’utilisation d’un compte est atteinte, et le quota qu’il vous reste.',
                recoveryDescription: 'Quand un agent atteint la limite d’utilisation de son compte, la session peut attendre la réinitialisation puis reprendre.',
                resumePromptCustom: 'Personnalisé',
                unavailableTitle: 'Indisponible sur ce Home',
                unavailableDescription: 'La reprise après limite d’utilisation et la jauge d’utilisation ne sont pas activées sur ce Home.',
            },
            resume: {
                pageDescription: 'Comment une session inactive continue quand son agent ne peut pas la reprendre seul.',
                strategyRecent: 'Messages récents',
                strategySummary: 'Résumé + récents',
                maxSeedCharsTitle: 'Taille maximale du rejeu',
                summaryModelSection: 'Modèle de résumé',
                summaryModelDescription: 'L’agent et le modèle qui rédigent le résumé rejoué dans la nouvelle session.',
                handoffSection: 'Déplacer des sessions',
                handoffLinkDescription: 'Ce qui accompagne une session quand vous la transférez vers une autre machine.',
            },
            permissions: {
                duringSessionSection: 'Pendant une session',
                duringSessionDescription: 'Où apparaissent les demandes d’approbation, et quand une modification des autorisations d’une session en cours prend effet.',
                promptSurfaceComposer: 'Près du composeur',
                applyImmediately: 'Immédiatement',
                applyNextMessage: 'Message suivant',
                storageUseDefault: 'Par défaut',
            },
            handoff: {
                pageDescription: 'Ce qui accompagne une session quand vous la transférez vers une autre machine.',
                workspaceSection: 'Fichiers de l’espace de travail',
                workspaceDescription: 'Ce qui arrive au dossier du projet quand une session passe sur une autre machine.',
                keepUpdated: 'Garder à jour',
                advancedModeDescription: 'Remplace le choix ci-dessus. Prudence : des fichiers peuvent être supprimés ou écrasés.',
                ignoredExclude: 'Exclure',
                ignoredIncludeSelected: 'Inclure la sélection',
            },
            toolRendering: {
                pageDescription: 'Donnez à certains outils plus ou moins de détails que le réglage par défaut de la transcription.',
                collapsedDescription: 'Ce que chaque outil montre dans la transcription avant que vous l’ouvriez.',
            },
            transcript: {
                advancedTitle: 'Performances et rythme',
                advancedPageDescription: 'Streaming, rythme des animations et seuils de défilement. Les valeurs par défaut conviennent à la plupart.',
                advancedMotionOff: 'Les animations de la transcription sont désactivées, ces réglages n’ont donc aucun effet. Activez-les dans Transcription › Animations.',
                toolsSection: "Appels d’outils",
                toolOverridesDescription: 'Donnez à certains outils plus ou moins de détails.',
                thinkingSummary: 'Résumé',
                thinkingFull: 'Complet',
                strategyConsecutive: 'Consécutifs',
                strategyWholeTurn: 'Tour entier',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Les messages copiés gardent leur mise en forme et indiquent qui les a écrits.',
                copyPlainDescription: 'Les messages copiés sont en texte brut, sans étiquettes.',
                motionSubtle: 'Discret',
                advancedLinkDescription: 'Streaming, rythme des animations et seuils de défilement.',
                pageDescription: 'Comment se lit une conversation à mesure qu’elle grandit : disposition, réflexion, outils, animations et défilement.',
            },
            composer: {
                pageDescription: 'Comment vous écrivez et envoyez des messages, et ce qui se passe quand un agent est occupé.',
                newSessionsSection: 'Nouvelles sessions',
                newSessionsDescription: 'Ce que vous voyez quand vous choisissez Nouvelle session.',
                draftEntryTitle: 'À l’ouverture d’une nouvelle session',
                draftResume: 'Reprendre le brouillon',
                draftFresh: 'Repartir de zéro',
                typingSection: 'Saisie',
                typingDescription: 'Comment Entrée et l’historique des messages se comportent dans le composeur.',
                enterToSendTitle: 'Entrée pour envoyer',
                sendModeTitle: 'Pendant que l’agent travaille',
                sendQueue: 'File',
                sendInterrupt: 'Interrompre',
                sendPending: 'En attente',
                busySteerTitle: 'Si l’agent peut être orienté',
                busySteerInactive: 'S’applique seulement quand les messages sont mis en file ou en attente pendant que l’agent travaille.',
                nonSteerableTitle: 'Demander quand un message ne peut pas orienter',
                resumeWhenPossible: 'Dès que possible',
                resumeIfOnline: 'Si en ligne',
                resumeNever: 'Jamais',
                pendingSection: 'Messages en attente',
                pendingDescription: 'Comment les messages en attente parviennent à l’agent.',
                pendingInactive: 'Avec vos choix actuels, rien n’est mis en attente. Ces réglages s’appliquent dès qu’un message l’est.',
                drainOne: 'Un à la fois',
                drainAll: 'Tous ensemble',
                timingAfterReply: 'Après la réponse',
                timingWhenIdle: 'Quand tout est inactif',
                layoutSection: 'Disposition du composeur',
                actionBarTitle: 'Barre d’actions',
                actionBarAutoDescription: 'Les commandes utilisent l’espace disponible et passent à la ligne si nécessaire.',
                actionBarWrapDescription: 'Les puces passent à la ligne quand elles ne tiennent pas.',
                actionBarScrollDescription: 'Les puces restent sur une ligne ; faites défiler pour voir la suite.',
                actionBarCollapsedDescription: 'Les puces sont regroupées dans un menu, pour laisser le plus de place à la saisie.',
                chipDensityTitle: 'Puces d’action',
                chipsAutoDescription: 'Les puces qui en ont besoin gardent leur libellé ; les autres n’affichent que leur icône.',
                chipsLabelsDescription: 'Chaque puce affiche son libellé.',
                chipsIconsDescription: 'Les puces n’affichent que leur icône, pour gagner de la place.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { fr: {
        publicLink: { workflowDescription: "Toute personne disposant du lien peut lire ce workflow sans compte.", workflowGrants: "Workflow en lecture seule.", description: "Toute personne disposant du lien peut lire ce document sans compte.", grants: "Document en lecture seule.", audit: "Journal des accès", auditEmpty: "Aucune visite enregistrée.", ownerUpdateRequired: "Le propriétaire met à jour ce lien", ownerUpdateRequiredDescription: "Demandez au propriétaire d’ouvrir Happier, puis réessayez ce lien." },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `Suggestions : ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `+${count} de plus`,
        roleRunsIn: ({ kind }: Readonly<{ kind: string }>) => `S’exécute dans ${kind}`,
        whoHasAccess: 'Qui a accès',
        whoHasAccessStale: 'Qui a accès · peut-être pas à jour',
        owner: 'Propriétaire',
        you: 'Vous',
        addPlaceholder: 'Ajouter des personnes ou des équipes',
        person: 'Personne',
        group: 'Groupe d’équipe',
        team: 'Équipe',
        accessLevel: 'Niveau d’accès',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Retirer l’accès',
        confirmRemove: 'Confirmer le retrait',
        removedAnnouncement: ({ name }) => `${name} n’a plus accès`,
        browseAll: 'Tout parcourir',
        browsePeople: 'Parcourir toutes les personnes',
        browseTeams: 'Parcourir toutes les équipes',
        browseGroups: 'Parcourir tous les groupes d’équipe',
        membersOnlyLink: 'Copier le lien est destiné aux personnes qui ont déjà accès.',
        allLoaded: 'Tous les résultats sont chargés',
        copyLink: 'Copier le lien',
        linkCopied: 'Lien copié',
        copyLinkFailed: 'Impossible de copier le lien.',
        sendCopy: 'Envoyer une copie à la place',
        secrets: {
            levels: { canUse: 'Peut utiliser' },
            help: { use: 'dans des exécutions ; sa valeur n’est jamais affichée' },
            oneLevel: 'Un secret enregistré sert uniquement aux exécutions et sa valeur ne sort jamais : il n’a qu’un niveau.',
        },
        documents: {
            title: 'Partage',
            shareTitle: ({ name }) => `Partager ${name}`,
            levels: { canUse: 'Peut utiliser', canRead: 'Peut lire', canEdit: 'Peut modifier', admin: 'Administration' },
            help: {
                workflowUse: 'le voir et le lancer',
                roleUse: "le rôle dans ses sessions ; ses changements personnels restent dans ses Réglages",
                profileUse: 'démarrer des sessions avec',
                documentUse: 'l’ouvrir et le copier sur tous ses appareils',
                promptUse: "le prompt dans ses sessions",
                boardUse: 'voir le tableau ; chaque carte n’ouvre que ce qu’il peut déjà ouvrir',
                dashboardUse: 'Voir ce tableau de bord ; chaque widget montre uniquement ce que vous pouvez déjà ouvrir.',
                editForEveryone: 'le modifier pour toutes les personnes concernées',
                adminOwnerShares: 'le modifier et gérer le partage',
            },
            notes: {
                personalRuns: 'Les exécutions et déclencheurs restent à la personne qui les lance.',
                teamRuns: 'L’équipe voit chaque exécution.',
                roleLive: 'Vos changements atteignent toutes les personnes avec qui il est partagé.',
                profileSecrets: 'Les profils font référence aux Secrets enregistrés ; leurs valeurs ne sont pas transmises.',
                dashboardAccess: 'Les personnes ajoutées l’ouvrent avec leur propre identité. Widgets, définitions, connexions, machines et dépôts nécessitent chacun leur propre accès.',
            },
            privateChoices: {
                title: 'Choix de connexion privés',
                account: ({ widget, service }) => `${widget} utilise votre compte ${service}`,
                letViewersPick: 'Laisser les lecteurs choisir',
                removeChoice: 'Retirer le choix',
                authoredInput: ({ widget }) => `Modifiez ${widget} pour retirer ses entrées privées avant le partage.`,
            },
            errors: {
                unavailable: 'Le partage n’est pas encore disponible ici.',
                ownerOnly: 'Seul le propriétaire ou un administrateur peut modifier qui a accès.',
                noAccess: 'Vous n’avez plus accès.',
                notFound: 'Cet élément n’est plus disponible.',
                subjectUnavailable: 'Cette personne, ce groupe ou cette équipe ne peut pas recevoir l’accès.',
                failed: 'Impossible de mettre à jour le partage. Réessayez.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "fr">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { fr: {
        linkToService: ({ service }) => `Lier à ${service}`,
        addHomeOrSignIn: 'Ajouter un Home ou se connecter',
        usageNoAccounts: 'Connectez un compte pour voir ce qu’il reste de ses limites.',
        usageHealthy: 'Largement de marge dans toutes les limites',
        homeUnreachableTitle: ({ home }) => `Impossible de joindre ${home}`,
        homeUnreachableBody: 'Vos machines et sessions réapparaîtront ici dès qu’il répondra.',
        homeUnreachableLine: ({ home }) => `Impossible de joindre ${home}.`,
        availableWhenHomeAnswers: "Disponible quand ce Home répondra.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 clé sans limites' : `${count} clés sans limites`,
        usageSignedOut: 'Déconnecté',
        hideAccountIdentities: 'Masquer les e-mails et identifiants des comptes',
        accountIdentitiesHidden: 'E-mails et identifiants masqués · pour les streams et démos',
        usageThisSession: 'Cette session',
        usageAllAccounts: 'Tous les comptes',
        usageMoreAccounts: ({ count }) => `${count} de plus`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} se connecte via ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} se connecte avec ce compte`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} utilise sa propre connexion`,
        usagePoolFallback: 'son groupe',
        usageNextInOrder: ({ account }) => `Quand ${account} sera épuisé, le tour suivant passera au compte suivant dans l'ordre`,
        usageNextMostLeft: ({ account }) => `Quand ${account} sera épuisé, le tour suivant passera au compte qui a le plus de marge`,
        usageNextStays: ({ pool, account }) => `${pool} reste sur ${account} jusqu'à ce que vous changiez`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "fr">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { fr: {
        stillWaiting: ({ seconds }) => `Toujours en attente · ${seconds} s`,
        asOf: ({ time }) => `À ${time}`,
        howItWorks: 'Comment ça marche',
        tryAgain: 'Réessayer',
        checkAgain: 'Vérifier à nouveau',
        paneFailedTitle: 'Impossible d’afficher ce panneau',
        paneFailedReason: 'Un problème est survenu pendant l’affichage. Votre session n’est pas affectée.',
        opening: ({ name }) => `Ouverture de ${name}`,
        couldNotOpen: ({ name }) => `Impossible d’ouvrir ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "fr">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const french: TeamsTranslationRoot = {
    teams: {
        leave: {
            action: 'Quitter l’équipe',
            description: 'Votre accès à l’équipe et aux groupes prend fin. Votre compte sur ce Home reste.',
            confirmTitle: ({ name }: { name: string }) => `Quitter ${name} ?`,
            confirmBody: 'Votre accès à l’équipe et aux groupes prend fin maintenant. Vos appartenances aux groupes et les droits liés à cette adhésion sont supprimés. Ce que vous avez écrit et le contenu déjà consulté sont conservés. Revenir plus tard crée une nouvelle adhésion.',
            auditLeft: ({ team }: { team: string }) => `a quitté ${team}`,
            auditRemoved: ({ team, target }: { team: string; target: string }) => `a retiré ${target} de ${team}`,
        },
        overview: {
            sharedSessions: "Sessions partagées",
            allSharedSessions: "Toutes les sessions partagées",
            managedBy: ({ team }: { team: string }) => `Les propriétaires et admins de ${team} gèrent les membres, la connexion et les réglages.`,
            attention: {
                directoryFailedTitle: ({ name }: { name: string }) => `${name} n’a pas pu se synchroniser`,
                directoryFailedBody: "Les membres et les groupes restent tels qu’à la dernière synchronisation réussie.",
                invitationUndeliveredTitle: "Un e-mail d’invitation n’est pas arrivé",
                invitationUndeliveredBody: ({ recipient }: { recipient: string }) => `Pour ${recipient}. Le lien fonctionne toujours si vous le partagez autrement.`,
            },
            sessionsSubtitle: 'Les sessions partagées avec cette équipe.',
            teamSection: 'Équipe',
            summary: {
                historyFromJoining: "historique à partir de l’arrivée",
                historyEarlier: "historique antérieur inclus",
                groupsDirectory: ({ directory }: { directory: string }) => `synchronisés avec ${directory}`,
                undelivered: ({ count }: { count: number }) => count === 1 ? '1 e-mail non arrivé' : `${count} e-mails non arrivés`,
                credentialsShared: ({ count, team }: { count: number; team: string }) => `${count} partagés avec ${team}`,
                credentialsNone: "Aucun partagé pour l’instant",
                justYou: 'Seulement vous',
                people: ({ count }: { count: number }) => count === 1 ? `1 personne` : `${count} personnes`,
                suspended: ({ count }: { count: number }) => `${count} suspendu(s)`,
                groups: ({ count }: { count: number }) => count === 1 ? `1 groupe` : `${count} groupes`,
                noGroups: 'Aucun groupe pour l’instant',
                waiting: ({ count }: { count: number }) => `${count} en attente d’acceptation`,
                noneWaiting: 'Aucune en attente',
                homeSignIn: ({ home }: { home: string }) => `Connexion de ${home}`,
                chosenSignIn: 'Seulement la connexion choisie',
                signInNeedsRepair: 'La règle de connexion doit être réparée',
                sessionsPrivate: 'Sessions privées par défaut',
                sessionsShared: 'Sessions partagées par défaut',
                sessionsAlwaysShared: 'Sessions toujours partagées',
            },
            setup: {
                title: ({ team }: { team: string }) => `Préparer ${team}`,
                description: 'Chaque étape quitte cette liste une fois terminée.',
                inviteBody: ({ home, team }: { home: string; team: string }) => `Toute personne invitée rejoint ${home} au sein de ${team}.`,
                signInTitle: 'Choisir comment les membres se connectent',
                signInBody: 'Gardez la connexion de ce Home, ou exigez celle de votre entreprise.',
                signInAction: 'Choisir',
                shareTitle: 'Partager une session',
                shareBody: ({ team }: { team: string }) => `Depuis le menu d’une session, partagez-la avec ${team}.`,
            },
        },
        denied: {
            askUnnamed: "Demandez à un propriétaire ou admin de cette équipe.",
            title: 'Votre rôle dans cette équipe ne le permet pas',
            authentication: ({ team }: { team: string }) => `Les propriétaires et admins de ${team} décident comment les membres se connectent.`,
            settings: ({ team }: { team: string }) => `Les propriétaires et admins de ${team} modifient ces réglages.`,
        },
        pages: {
            credentialCreate: 'Choisissez ce que vous partagez, qui peut l’utiliser et ses limites.',
            credentialDetail: 'Qui peut utiliser cet identifiant, comment et dans quelle mesure.',
            credentialEdit: 'Modifiez qui peut utiliser cet identifiant, comment et dans quelle mesure.',
            credentialActivity: 'Les modifications de cet identifiant et leurs auteurs.',
            credentialUsage: 'Dans quelle mesure cet identifiant a été utilisé, et par qui.',
            credentialExternalApi: 'Utilisez cet identifiant depuis des outils extérieurs à Happier.',
            identityProviderNew: 'Connectez un fournisseur d’identité avec lequel les membres peuvent se connecter.',
            identityProviderEdit: 'Modifiez la connexion de ce fournisseur d’identité.',
            githubApp: 'Une GitHub App que cette équipe utilise pour accéder aux dépôts.',
            githubAppEdit: 'Modifiez l’enregistrement de cette GitHub App.',
            authentication: 'Comment les membres se connectent à cette équipe et qui elle admet.',
            credentials: 'Les identifiants de fournisseur que cette équipe partage avec ses membres.',
            directory: 'Des groupes de personnes qui partagent sessions, accès et identifiants sur un Home.',
            members: 'Qui fait partie de cette équipe et ce que chacun peut faire.',
            addMember: 'Ajoutez une personne qui a déjà un compte sur ce Home.',
            groups: 'Des ensembles nommés de membres avec qui partager sessions et identifiants.',
            newGroup: 'Nommez le groupe. Vous ajoutez ses membres une fois créé.',
            invitations: 'Les invitations qui permettent de rejoindre cette équipe, et à qui elles sont destinées.',
            settings: 'Nom, logo, réglages par défaut des sessions et statut actif de l’équipe.',
        },
        loading: 'Chargement de l’équipe…',
        title: 'Équipes',
        entrySubtitle: 'Créez des équipes, gérez les membres et les groupes, et invitez des personnes.',
        entry: {
            heading: ({ team }: { team: string }) => `Continuer vers ${team}`,
            onHome: ({ home }: { home: string }) => `sur ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Connectez-vous via ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `La connexion via ${service} est indisponible`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Connecté à ${home} en tant que ${account}`,
            unnamedAccount: 'Compte Happier',
            continueWith: ({ method }: { method: string }) => `Continuer avec ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} est indisponible`,
            providerUnavailableDisabled: 'L’administrateur de ton équipe a désactivé cette connexion. Vérifie plus tard.',
            providerUnavailableSetupIncomplete: 'L’administrateur de ton équipe n’a pas fini de configurer cette connexion. Vérifie plus tard.',
            providerUnavailableUnavailable: 'Ce Home ne peut pas utiliser cette connexion pour le moment. Vérifie plus tard.',
            unknownTargetTitle: 'Ce lien n’identifie pas son Home',
            unknownTargetBody: 'Cet appareil ne peut pas déterminer à quel Home appartient ce lien de connexion à l’équipe ; rien n’a donc été envoyé. Demande de nouveau le lien à un responsable de l’équipe.',
            ssoRequiredTitle: 'Cette équipe demande une autre méthode de connexion',
            ssoRequiredBody: 'Tu es connecté à ce Home, mais cette équipe n’accepte que la méthode de connexion qu’elle impose. Reconnecte-toi avec cette méthode, ou reviens à ton propre travail.',
            invitationUnavailableTitle: 'Cette invitation ne peut pas être utilisée',
            invitationUnavailableBody: 'Elle a peut-être expiré, été révoquée ou déjà été utilisée. Se connecter ne suffit pas à rejoindre l’équipe.',
            wrongAccountTitle: 'Ce compte ne peut pas utiliser cette connexion',
            wrongAccountBody: 'Le compte ou l’identité avec lesquels tu t’es connecté ne sont pas ceux que cette équipe attend. Connecte-toi avec un autre compte ou fournisseur, ou reviens à ton propre travail.',
            notProvisionedTitle: 'Cette équipe ne t’a pas encore admis',
            notProvisionedBody: 'Se connecter ne suffit pas à rejoindre cette équipe. Son administrateur décide qui est admis ; demande-lui un accès ou une invitation, puis réessaie.',
            directoryDelayedTitle: 'Ton accès est encore en route',
            directoryDelayedBody: 'Cette équipe reçoit ses membres d’un annuaire qui n’a pas encore transmis ton accès. Réessaie plus tard, ou demande à un responsable de l’équipe.',
            accessRemovedTitle: 'Cette équipe ne t’est pas accessible',
            accessRemovedBody: 'Ton accès a peut-être été retiré, ou l’équipe est indisponible sur ce Home pour le moment. Tout le reste de tes connexions est intact.',
            providerChangedTitle: 'Cette méthode de connexion a changé pendant son utilisation',
            providerChangedBody: 'Un administrateur a modifié cette méthode de connexion pendant ta connexion. Rien n’a été changé sur ton compte. Recommence depuis la page de l’équipe pour voir les méthodes actuelles.',
            returnToTeamSignIn: 'Retour à la connexion de l’équipe',
            returnToHappier: 'Retour à Happier',
            signInToTeam: 'Se connecter à cette équipe',
            readyStatus: 'Choisis comment te connecter pour continuer.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Propriétaire',
            admin: 'Administrateur',
            member: 'Membre',
            guest: 'Invité',
        },
        roleHelp: {
            owner: 'Possède l’équipe, peut la gérer et changer les propriétaires.',
            admin: 'Dispose de l’accès Membre et peut gérer l’équipe.',
            member: 'Reçoit par défaut les accès accordés à l’équipe.',
            guest: 'Ne voit que les sessions et ressources partagées explicitement avec ce compte ou avec un de ses groupes.',
        },
        status: {
            active: 'Actif',
            suspended: 'Suspendu',
        },
        history: {
            label: 'Historique des sessions',
            allExisting: 'Inclure les sessions déjà partagées avec l’équipe',
            fromMembership: 'Uniquement les sessions partagées après son arrivée',
            allExistingNamed: ({ name }) => `Inclure les sessions déjà partagées avec ${name}`,
            fromMembershipNamed: ({ name }) => `Uniquement les sessions partagées après son arrivée dans ${name}`,
            scopeNote: 'Cela s’applique à des sessions entières. Cela ne révèle pas seulement les messages créés après l’arrivée.',
        },
        unavailable: {
            title: 'Les équipes ne sont pas disponibles sur ce Home',
            disabled: 'Ce Home a désactivé les équipes.',
            updateRequired: 'Ce Home doit être mis à jour pour utiliser les équipes.',
            offline: 'Ce Home est actuellement injoignable.',
            retry: 'Réessayer',
        },
        stale: {
            label: 'Affichage des dernières données connues pour ce Home.',
        },
        errors: {
            generic: 'L’opération n’a pas abouti. Rien n’a été modifié.',
            outcomeUnknown: 'Le Home a peut-être effectué cette modification. Actualisez l’équipe avant de réessayer.',
            forbidden: 'Vous n’avez pas l’autorisation pour cette modification.',
            notFound: 'Cette équipe n’est plus disponible.',
            archived: 'Cette équipe est archivée. Restaurez-la pour la modifier.',
            conflict: 'Quelqu’un a modifié cet élément avant vous. Vérifiez les valeurs actuelles et réessayez.',
            offline: 'Ce Home est injoignable, la modification n’a pas été envoyée.',
            invalidName: 'Saisissez un nom de 1 à 80 caractères.',
            invalidDescription: 'Saisissez une description de 500 caractères maximum.',
        },
        directory: {
            loading: 'Chargement des équipes…',
            chooseTeamToShare: 'Choisissez l’équipe avec qui le partager.',
            noMatches: 'Aucune équipe ne correspond',
            noLoadedMatches: 'Aucune équipe chargée ne correspond',
            searchLoadedPlaceholder: 'Filtrer les équipes chargées',
            unreachableHomes: 'Sans réponse',
            searchPlaceholder: 'Rechercher des équipes',
            newTeam: 'Nouvelle équipe',
            createDenied: ({ homes }: { homes: string }) => `Seuls les administrateurs de ${homes} peuvent créer des équipes. Demandez-leur d’en créer une ou de vous y ajouter.`,
            createAdministered: ({ names }: { names: string }) => `Sur ce Home, les équipes sont créées par ses administrateurs. Demandez à ${names} de créer une équipe pour vous ou de permettre à tous d’en créer.`,
            createAdministeredUnnamed: 'Sur ce Home, les équipes sont créées par ses administrateurs. Demandez à l’un d’eux de créer une équipe pour vous ou de permettre à tous d’en créer.',
            createOff: 'La création d’équipes est désactivée sur ce Home.',
            letEveryoneCreate: 'Permettre à tous de créer des équipes',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} et ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} et ${count} autres`,
            emptyTitle: 'Aucune équipe pour l’instant',
            emptyBody: 'Une équipe offre à un groupe de personnes un espace commun pour les sessions, les personnes et les accès.',
            archivedSection: 'Équipes archivées',
            archivedEmpty: 'Aucune équipe archivée',
            archivedEmptyBody: 'Archiver une équipe depuis ses propres paramètres la place ici. Ses membres, ses groupes et son historique sont conservés.',
            showArchived: 'Afficher les archivées',
            hideArchived: 'Masquer les archivées',
            archivedBadge: 'Archivée',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, sur ${home}`,
            partialHomes: 'Certains Homes sont injoignables : leurs équipes manquent dans cette liste.',
        },
        create: {
            loading: 'Vérification des Homes où vous pouvez créer une équipe…',
            discard: 'Abandonner',
            detailsSection: 'Équipe',
            logoFailedBody: 'L’équipe a été créée, mais son logo n’a pas été publié. Réessayez ou continuez sans logo.',
            title: 'Nouvelle équipe',
            nameLabel: 'Nom',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Description détaillée',
            descriptionPlaceholder: 'Sur quoi cette équipe travaille',
            homeHelp: 'L’équipe est créée sur ce Home et y reste.',
            duplicateNameNote: 'Deux équipes peuvent porter le même nom. Les liens et les accès utilisent toujours l’équipe elle-même.',
            managedOnlyTitle: 'La création d’équipe est administrée sur ce Home',
            managedOnlyBody: 'Un administrateur crée les équipes ici et choisit le premier propriétaire.',
            initialOwnerLabel: 'Premier propriétaire',
            initialOwnerPlaceholder: 'Rechercher des personnes sur ce Home',
            initialOwnerHelp: 'Créer une équipe pour quelqu’un d’autre ne vous y ajoute pas.',
            initialOwnerRequired: 'Choisissez le premier propriétaire de l’équipe. Sur ce Home, un administrateur désigne qui possède une nouvelle équipe.',
            initialOwnerIneligible: 'Cette personne ne peut plus posséder d’équipe. Choisissez quelqu’un d’autre.',
            submit: 'Créer l’équipe',
            submitting: 'Création…',
            outcomeUnknown: 'Impossible de confirmer si l’équipe a été créée. Réessayez pour reprendre la même demande.',
        },
        tabs: {
            overview: 'Aperçu',
            sessions: 'Séances',
            members: 'Membres',
            groups: 'Groupes',
            invitations: 'Invitations',
            authentication: 'Authentification',
            settings: 'Réglages',
        },
        authentication: {
            policy: {
                admissionRow: "Nouveaux membres",
                acceptedRow: "Connexion acceptée",
                admissionSection: 'Qui peut rejoindre',
                admissionHelp: 'Comment les personnes deviennent membres de cette équipe.',
                admissionInviteOnly: 'Sur invitation uniquement',
                admissionProvisioned: 'Provisionné par un annuaire',
                admissionJit: 'Automatiquement à la première connexion',
                admissionUnavailable: "Ce Home ne peut pas encore appliquer ce mode d'admission ; rien n'a changé.",
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Ce Home n’a pas rendu ce fournisseur de connexion disponible pour les équipes. Un administrateur du Home peut le changer.',
                    homePolicyProhibited: 'Un administrateur du Home n’autorise pas ce mode d’adhésion sur ce Home.',
                    directorySourceRequired: 'Ajoutez d’abord un annuaire à cette équipe. Ce mode admet les personnes qu’il fournit.',
                    directoryProjectionRequired: 'L’annuaire de cette équipe n’a pas encore terminé sa première synchronisation. Ce mode sera disponible une fois qu’elle sera terminée.',
                    teamConnectionRequired: 'Ajoutez d’abord une connexion d’authentification à cette équipe. L’adhésion à la première connexion en dépend.',
                    teamConnectionUnavailable: 'Aucune connexion d’authentification de cette équipe n’est utilisable pour le moment, donc personne ne pourrait être admis à la connexion.',
                },
                acceptedSection: 'Comment les membres se connectent',
                acceptedHelp: "Quelle connexion cette équipe accepte avant d'autoriser un travail d'équipe.",
                acceptedInherit: 'Utiliser la politique du Home',
                acceptedRestricted: 'Uniquement la connexion sélectionnée ci-dessous',
                connectionsSection: 'Connexions acceptées',
                connectionsEmpty: 'Sélectionnez au moins une connexion, ou utilisez la politique du Home.',
                homeMethodRetained: 'Conservé depuis la politique enregistrée',
                repairRequired: 'La restriction de connexion enregistrée est illisible',
                repairRequiredHelp: "Elle n'est pas appliquée telle quelle. Choisissez une politique ci-dessous pour la remplacer.",
                conflictBody: 'La politique de connexion a changé sur ce Home. Vérifiez-la, puis appliquez de nouveau votre modification.',
                providerTestRequired: "Testez cette connexion avant que l'équipe puisse l'exiger.",
                unavailable: 'Ce Home ne peut pas accepter cette politique de connexion.',
                approvalPending: "En attente d'approbation",
                connectionOwnerTeam: "Connexion d'équipe",
                connectionOwnerHome: "Méthode de connexion du Home",
            },
            subtitle: 'Comment les membres de l’équipe prouvent leur identité.',
            memberSignIn: {
                section: 'Page de connexion des membres',
                open: 'Ouvrir la page de connexion des membres',
                copyLink: 'Copier le lien',
                shareLink: 'Partager le lien',
                qrLabel: 'Code QR du lien de connexion des membres',
                footer: 'Toute personne disposant de ce lien atteint la page de connexion de cette équipe. Le lien n’accorde rien en soi : l’adhésion suit toujours la politique d’admission de l’équipe.',
                unavailable: 'Aucun lien partageable',
                unavailableBody: 'Ce Home ne publie aucune adresse web, il n’existe donc aucun lien qui fonctionnerait sur un autre appareil. Un administrateur du Home peut en configurer une.',
            },
            connectionsSection: 'Connexions de connexion',
            homeMethodsUnavailable: 'Les méthodes de connexion de ce Home n’ont pas pu être lues.',
            connectionsDescription: 'La connexion d’entreprise que cette équipe peut utiliser.',
            add: {
                fixTurnOn: "L’activer",
                action: 'Ajouter une connexion',
                askNamed: ({ names }: { names: string }) => `Demandez à ${names}.`,
                askUnnamed: 'Demandez à un propriétaire du Home.',
                fixInSignInProviders: 'Configurer',
                fixInReach: 'En définir une dans Accès',
                reason: {
                    contactHomeAdmin: ({ home }: { home: string }) => `${home} configure cela pour ses équipes.`,
                    workosPlatform: ({ home }: { home: string }) => `WorkOS n’est pas encore configuré sur ${home}.`,
                    providerDisabled: ({ home }: { home: string }) => `Fourni par ${home}. Il y est désactivé.`,
                    homeProhibited: ({ home, provider }: { home: string; provider: string }) => `${home} ne permet pas aux équipes d’ajouter ${provider}.`,
                    homeUnavailable: ({ home }: { home: string }) => `${home} ne l’a pas rendu disponible aux équipes.`,
                    publicAddress: ({ home }: { home: string }) => `Votre fournisseur a besoin d’une adresse publique de ${home} pour renvoyer les personnes.`,
                },
            },
            empty: 'Aucune connexion de connexion',
            status: {
                unavailable: 'Indisponible',
                prohibited: 'Bloqué par la politique du Home',
                notConfigured: 'Non configuré',
                settingUp: 'Configuration en cours',
                needsAttention: 'Nécessite votre attention',
            },
            mode: {
                signInOnly: 'Connexion uniquement',
                signInTimeGroups: 'Les groupes sont actualisés à la connexion',
            },
            detail: {
                status: 'État',
                mode: 'Fonctionnement',
                provider: 'Fournisseur',
                restrictions: 'Restrictions de connexion',
                allowedUsers: 'Utilisateurs autorisés',
                allowedDomains: 'Domaines de messagerie autorisés',
                none: 'Aucun',
                configuration: 'Paramètres',
                organization: 'Organisation',
                connection: 'Connexion',
            },
            directory: {
                connect: "Connecter",
                actions: {
                    section: 'Actions', sync: 'Synchroniser maintenant', pause: 'Suspendre la synchronisation', resume: 'Reprendre la synchronisation', remove: 'Supprimer l’annuaire…',
                    pauseTitle: ({ source }: { source: string }) => `Suspendre ${source} ?`, pauseBody: 'Les nouveaux changements de l’annuaire s’arrêtent. Les accès Team et contributions aux Groupes connus sont conservés jusqu’à la reprise.',
                    removeTitle: ({ source }: { source: string }) => `Supprimer ${source} ?`, removeMembers: ({ count }: { count: number }) => count === 1 ? '1 personne arrivée par cet annuaire quitte l’équipe.' : `${count} personnes arrivées par cet annuaire quittent l’équipe.`, removeGroupMemberships: ({ count }: { count: number }) => count === 1 ? '1 appartenance à un groupe qu’il a définie est supprimée.' : `${count} appartenances à des groupes qu’il a définies sont supprimées.`, removeNothing: "Aucune adhésion n’en dépend.", removeKept: "Les comptes, les groupes qu’il a créés et les personnes ajoutées autrement sont conservés.",
                },
                section: "Adhésion gérée",
                overviewSubtitle: "Les sources d’annuaire synchronisent les membres et les groupes de l’équipe avec une organisation externe.",
                manageSubtitle: "Consultez les sources d’annuaire connectées et leur dernier état de synchronisation.",
                title: "Synchronisation d’annuaire",
                sourcesSection: "Sources d’annuaire",
                sourcesLoadMore: "Charger plus de sources",
                subtitle: "Les changements de l’annuaire apparaissent ici après chaque synchronisation.",
                purpose: "Gardez les membres et groupes de cette équipe alignés sur l’annuaire de votre entreprise.",
                sourcePurpose: "Les personnes et groupes que cet annuaire garde alignés avec l’équipe.",
                empty: "Aucune source d’annuaire",
                emptyBody: "Connectez l’annuaire de votre entreprise et l’équipe le suit : qui le rejoint rejoint l’équipe, qui le quitte perd l’accès.",
                setup: {
                    add: "Ajouter une source",
                    options: "Choisir une source d’annuaire",
                    optionsFooter: "Rien ne change avant la fin de la première synchronisation.",
                    loadMore: "Charger plus",
                    empty: "Aucune option de source vérifiée pour le moment",
                    workos: "Configurer la synchronisation d’annuaire WorkOS",
                    workosSubtitle: "Ouvrez le portail d’administration WorkOS, puis revenez choisir l’annuaire vérifié.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier commencera à importer cet annuaire après son ajout.",
                },
                people: {
                    section: "Personnes",
                    empty: "Aucune personne provisionnée",
                    provisioned: "Provisionné · Aucun compte pour le moment",
                    boundAccountCount: ({ count }: { count: number | string }) => `Comptes liés : ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Personnes provisionnées sans compte : ${count}`,
                    member: "Membre de l’équipe",
                    unknown: "Personne sans nom",
                    loadMore: "Charger plus de personnes",
                    state: {
                        suspended: "Suspendue",
                        deleted: "Supprimée",
                    },
                },
                kind: {
                    workos: "Synchronisation d’annuaire WorkOS",
                    github: "Organisation GitHub",
                },
                state: {
                    setup: "Configuration requise",
                    syncing: "Synchronisation",
                    active: "Activée",
                    paused: "En pause",
                    needsAttention: "Nécessite votre attention",
                    initializing: "Configuration en cours",
                    failed: "Dernière synchronisation échouée",
                },
                mode: {
                    eventsAndFull: "Événements et rapprochement complet",
                    fullOnly: "Rapprochement complet uniquement",
                },
                freshness: {
                    never_synced: "Jamais synchronisé",
                    fresh: "À jour",
                    stale: "Obsolète",
                    unknown: "Inconnue",
                },
                detail: {
                    status: "État",
                    sourceType: "Type de source",
                    syncSection: "État de synchronisation",
                    mode: "Mode de synchronisation",
                    freshness: "Actualité",
                    lastSuccess: "Dernière synchronisation réussie",
                    nextScheduled: "Prochaine synchronisation planifiée",
                    attentionSection: "Attention requise",
                    attentionTitle: "Cette source d’annuaire nécessite votre attention",
                    attentionRetryable: "La source peut récupérer une fois sa connexion réparée. Actualisez pour vérifier son état.",
                    attentionAdmin: "Vérifiez la configuration de la source avant de vous fier aux nouveaux changements d’annuaire.",
                },
                never: "Jamais",
                unknown: "Inconnu",
            },
        },
        settings: {
            archiveDescription: 'L’archivage retire l’équipe des vues actives et arrête les accès basés sur l’équipe. Ses membres, groupes et historique sont conservés, et elle peut être restaurée.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Valeurs par défaut des sessions',
            sharingSection: 'Partage',
            sharingDescription: 'S’applique à partir de maintenant. Rien de déjà partagé ne change.',
            option: {
                private: 'Privé',
                shared: 'Partagé',
                alwaysShared: 'Toujours partagé',
                anyone: 'Tout le monde',
                admins: 'Administrateurs',
                nobody: 'Personne',
                fromJoining: 'Depuis l’arrivée',
                earlierToo: 'Aussi avant',
            },
            consequence: {
                sessionsPrivate: ({ team }: { team: string }) => `Commence en privé ; chacun choisit ce qu’il partage avec ${team}.`,
                sessionsShared: ({ team }: { team: string }) => `Commence partagé avec ${team} ; chacun peut en garder une privée.`,
                sessionsAlwaysShared: ({ team }: { team: string }) => `Chaque nouvelle session est partagée avec ${team}.`,
                outsideAnyone: ({ team }: { team: string }) => `Quiconque peut partager une session peut aussi la partager hors de ${team}.`,
                outsideAdmins: ({ team }: { team: string }) => `Seuls les admins de ${team} peuvent partager une session à l’extérieur.`,
                outsideNobody: ({ team }: { team: string }) => `Les sessions ne peuvent pas être partagées hors de ${team}.`,
                historyFromJoining: ({ team }: { team: string }) => `Les sessions partagées avec ${team} à partir de leur arrivée.`,
                historyEarlier: ({ team }: { team: string }) => `Aussi les sessions partagées avec ${team} avant leur arrivée.`,
            },
            externalSharingSection: 'Partage externe',
            historyDefaultSection: 'Historique par défaut',
            saved: 'Enregistré',
        },
        policy: {
            sessionCreationPrivate: 'Privée par défaut',
            sessionCreationTeam: 'Partagée avec l’équipe par défaut',
            sessionCreationRequired: 'Toujours partagée avec l’équipe',
            sessionCreationHelp: 'Cela s’applique aux nouvelles sessions. Les sessions privées existantes ne sont pas exposées.',
            externalSharingAllowed: 'Toute personne pouvant partager',
            externalSharingAdmins: 'Administrateurs de l’équipe uniquement',
            externalSharingDisabled: 'Non autorisé',
            externalSharingHelp: 'Cela peut bloquer les partages futurs. Cela ne retire pas les copies déjà partagées.',
            historyDefaultHelp: 'Cela présélectionne le choix pour les nouveaux membres. Cela ne réécrit pas l’historique des membres existants.',
        },
        logo: {
            add: 'Ajouter un logo',
            replace: 'Remplacer le logo',
            remove: 'Supprimer le logo',
            removeConfirmTitle: 'Supprimer ce logo ?',
            removeConfirmBody: 'L’équipe affichera de nouveau son monogramme. Vous pouvez importer un nouveau logo à tout moment.',
            previewLabel: 'Aperçu du logo',
            useAsLogo: 'Utiliser comme logo',
            monogramLabel: 'Monogramme de l’équipe',
            tooLarge: 'Cette image est trop volumineuse. Choisissez-en une plus petite.',
            invalidFormat: ({ formats }: { formats: string }) => `Ce fichier n’est pas une image prise en charge. Formats pris en charge : ${formats}.`,
            failed: 'Le logo n’a pas été importé. Le logo actuel est inchangé.',
            retry: 'Réessayer',
        },
        archive: {
            archivedTitle: ({ name }: { name: string }) => `${name} est archivée`,
            archivedBody: "L’accès à l’équipe est arrêté et rien ne peut changer ici. Les membres, les groupes et l’historique sont conservés.",
            confirm: {
                keptCounted: ({ members, groups }: { members: number; groups: number }) => `${members === 1 ? '1 membre' : `${members} membres`}, ${groups === 1 ? '1 groupe' : `${groups} groupes`} et leur historique sont conservés.`,
                kept: "Les membres, les groupes et leur historique sont conservés.",
                invitationsStop: ({ count }: { count: number }) => count === 1 ? '1 lien d’invitation en attente cesse de fonctionner, même après une restauration.' : `${count} liens d’invitation en attente cessent de fonctionner, même après une restauration.`,
                restore: "Restaurez-la à tout moment ; les accès conservés reviennent là où ils s’appliquent encore.",
            },
            openSettings: 'Ouvrir les paramètres',
            action: ({ name }: { name: string }) => `Archiver ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Archiver ${name} ?`,
            restoreAction: ({ name }: { name: string }) => `Restaurer ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Restaurer ${name} ?`,
            restoreBody: () => 'Les adhésions, groupes et autorisations conservés redeviendront actifs là où les comptes et les ressources le permettent encore. Les liens d’invitation révoqués ne reviendront pas.',
            readOnly: 'Cette équipe est archivée. Restaurez-la pour la modifier.',
        },
        members: {
            roleReadOnly: ({ team }: { team: string }) => `Seuls les propriétaires et admins de ${team} modifient les rôles.`,
            roleSetBy: ({ source }: { source: string }) => `Défini par ${source}.`,
            accessSection: "Accès",
            lifecycleFootnote: "La suspension arrête son accès jusqu’à la réactivation. Le retrait y met fin ; ce que cette personne a écrit reste, et un retour crée une nouvelle adhésion.",
            removal: {
                title: ({ name, team }: { name: string; team: string }) => `Retirer ${name} de ${team} ?`,
                action: ({ team }: { team: string }) => `Retirer de ${team}…`,
                ends: "Son accès à l’équipe et aux groupes prend fin maintenant.",
                leavesGroups: ({ groups }: { groups: string }) => `Cette personne quitte ${groups}.`,
                leavesGroupsAndMore: ({ groups }: { groups: string }) => `Cette personne quitte ${groups} et ses autres groupes.`,
                kept: "Les sessions et les messages qu’elle a écrits restent en place.",
            },
            filterLabel: 'Afficher',
            searchPlaceholder: 'Rechercher des membres',
            filterAll: 'Tous',
            filterOwnersAndAdmins: 'Propriétaires et administrateurs',
            addMenu: {
                existing: 'Ajouter quelqu’un de ce Home',
                existingBody: ({ home }: { home: string }) => `Choisissez parmi les personnes qui ont déjà un compte sur ${home}.`,
                invite: 'Inviter par lien ou e-mail',
                inviteBody: ({ team }: { team: string }) => `Pour tous les autres. Ils rejoignent ${team} en acceptant.`,
            },
            filterMembers: 'Membres',
            filterGuests: 'Invités',
            filterSuspended: 'Suspendus',
            emptyTitle: 'Aucun membre correspondant',
            emptyBody: 'Ajustez le filtre ou invitez quelqu’un dans cette équipe.',
            add: 'Ajouter un membre',
            addTitle: ({ team }: { team: string }) => `Ajouter à ${team}`,
            personLabel: 'Personne',
            roleLabel: 'Rôle',
            personPlaceholder: 'Rechercher des personnes sur ce Home',
            ineligible: 'Déjà dans cette équipe, ou compte non actif sur ce Home.',
            addSubmit: 'Ajouter le membre',
            you: 'Vous',
            joined: ({ when }: { when: string }) => `Arrivé le ${when}`,
            managedBy: ({ source }: { source: string }) => `Géré via ${source}`,
            managedReadOnly: 'Cette adhésion est gérée à sa source. Modifiez-la là-bas.',
            detailManagedBy: 'Géré par',
            managementTitle: 'Source de gestion',
            managementHelp: 'Changer la source conserve cette adhésion, son rôle, son statut et son historique de sessions. Seul le responsable des changements change.',
            managementNative: 'Géré dans Happier',
            managementConflict: 'Cette source n’a pas encore d’identité disponible pour cette personne. Synchronisez-la, puis réessayez.',
            encryption: {
                title: 'Accès chiffré',
                checking: 'Vérification de l’accès chiffré…',
                ready: 'Préparé',
                scopeBody: 'Cela ne couvre que les sessions que vous gérez. D’autres responsables de session devront peut-être encore préparer l’accès.',
                pending: 'À préparer',
                prepare: 'Préparer l’accès chiffré',
                preparing: ({ prepared }: { prepared: number }) => `Préparation de l’accès chiffré · ${prepared} préparées`,
                setupRequired: 'Configuration requise',
                setupRequiredBody: 'Cette personne n’a pas terminé la configuration de l’accès chiffré. Vous pourrez préparer son historique de sessions ensuite.',
                notEncrypted: 'Non chiffré',
                plainAccount: 'Le compte de cette personne n’utilise pas le chiffrement de bout en bout : il n’y a rien à préparer.',
                repairRequired: 'L’accès chiffré doit être réparé',
                repairBody: 'Certaines sessions que vous gérez ne peuvent pas être préparées depuis cet appareil. Ouvrez-les pour réparer votre propre accès.',
                nonTransferableBody: 'Certaines sessions utilisent un ancien format de chiffrement qui ne peut pas être partagé avec de nouveaux membres. Elles restent lisibles par les personnes qui y ont déjà accès.',
                recipientChanged: 'Le compte de cette personne a changé. Rechargement avant une nouvelle préparation.',
                retry: 'Réessayer',
                failed: 'La préparation s’est arrêtée avant la fin. Ce qui était déjà préparé a été conservé.',
            },
            detailGroups: 'Groupes',
            detailGroupsEmpty: 'Aucun groupe',
            suspend: 'Suspendre le membre',
            suspendTitle: ({ name }: { name: string }) => `Suspendre ${name} ?`,
            suspendBody: 'L’accès à l’équipe et aux groupes s’arrête immédiatement. L’appartenance aux groupes et les attributions de ressources sont conservées, et la réactivation ne rétablit que les accès encore valides. Le compte du Home et les autres équipes ne sont pas affectés.',
            reactivate: 'Réactiver le membre',
            reactivateTitle: ({ name }: { name: string }) => `Réactiver ${name} ?`,
            reactivateBody: 'L’accès reprend là où les adhésions, les groupes et l’état du compte le permettent encore.',
            remove: 'Retirer de l’équipe',
            lastOwnerBlocked: 'Une équipe conserve au moins un propriétaire actif. Choisissez d’abord un autre propriétaire.',
            accountInactive: 'Le compte de cette personne n’est pas actif : elle ne peut être ni ajoutée ni nommée propriétaire.',
            ownerOnlyAction: 'Seul un propriétaire de l’équipe peut changer les propriétaires.',
            ownerRequiredTitle: 'Propriétaire requis',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} a besoin d’un propriétaire actif pour les changements réservés au propriétaire.`,
            chooseOwner: 'Choisir un propriétaire',
            ownerRequiredNoCandidate: 'Aucun membre éligible n’est disponible. Il faut ajouter un membre existant ou organiser une passation.',
        },
        groups: {
            detailsSection: 'Groupe',
            title: 'Groupes',
            emptyTitle: 'Aucun groupe pour l’instant',
            emptyBody: 'Un groupe est un ensemble simple de membres de l’équipe avec qui partager en une fois.',
            emptyRosterTitle: 'Aucun membre dans ce groupe',
            noEligibleCandidatesTitle: 'Personne à ajouter',
            noEligibleCandidatesBody: 'Les membres de l’équipe qui ne font pas déjà partie de ce groupe apparaissent ici.',
            create: 'Nouveau groupe',
            nameLabel: 'Nom',
            namePlaceholder: 'Développement',
            descriptionPlaceholder: 'À quoi sert ce groupe',
            submit: 'Créer le groupe',
            nameTaken: 'Un groupe de cette équipe porte déjà ce nom.',
            memberCount: ({ count }: { count: number }) => `${count} membres`,
            managedBy: ({ source }: { source: string }) => `Géré par ${source}`,
            membersSection: 'Membres du groupe',
            addMember: 'Ajouter au groupe',
            removeNative: 'Retirer du groupe',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Retirer ${name} du groupe ${group} ?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} perd immédiatement l’accès accordé par ${group}. La personne reste dans l’équipe et vous pouvez la rajouter à ce groupe.`,
            externalOnlyTitle: 'Géré à sa source',
            externalOnlyBody: ({ source }: { source: string }) => `${source} continue d’ajouter cette personne, elle reste donc dans le groupe. Modifiez cela dans les réglages de cette source.`,
            archiveAction: ({ name }: { name: string }) => `Archiver ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Archiver ${name} ?`,
            archiveBody: 'L’accès basé sur le groupe s’arrête immédiatement. L’appartenance et l’historique sont conservés, et restaurer le groupe peut réactiver ces autorisations.',
            restoreAction: ({ name }: { name: string }) => `Restaurer ${name}`,
            archivedSection: 'Groupes archivés',
            archivedReadOnly: 'Ce groupe est archivé. Restaurez-le pour le modifier.',
            managedReadOnly: 'Le nom et le cycle de vie de ce groupe sont gérés à sa source. Vous pouvez tout de même y ajouter des membres.',
        },
        invitations: {
            waitingSection: "En attente",
            finishedSection: "Terminées",
            sendAgain: "Renvoyer",
            emptyTitle: 'Aucune invitation',
            emptyBody: 'Invitez quelqu’un avec un lien, ou ajoutez une personne qui a déjà un compte sur ce Home.',
            invite: 'Inviter',
            inviteTitle: ({ team }: { team: string }) => `Inviter dans ${team}`,
            byLink: 'Lien',
            byEmail: 'E-mail',
            emailLabel: 'Adresse e-mail',
            emailPlaceholder: 'nom@exemple.com',
            create: 'Créer l’invitation',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Toute personne connectée à ce Home avec ce lien peut rejoindre ${team} en tant que ${role}.`,
            copyLink: 'Copier le lien',
            copied: 'Lien copié',
            qrLabel: 'Code QR de ce lien d’invitation',
            qrTooLargeFallback: 'Ce lien est trop long pour un code QR. Copiez-le à la place.',
            linkRow: 'Lien d’invitation',
            maskedRecipient: ({ email }: { email: string }) => `Pour ${email}`,
            expires: ({ when }: { when: string }) => `Expire le ${when}`,
            stateActive: 'Active',
            stateAccepted: 'Acceptée',
            stateRevoked: 'Révoquée',
            stateExpired: 'Expirée',
            deliverySent: 'E-mail soumis',
            deliveryFailed: 'Échec de l’envoi de l’e-mail',
            deliveryUnknown: 'Résultat d’envoi inconnu',
            deliveryRetry: 'Réessayer',
            deliveryChangeEmail: 'Changer d’e-mail',
            emailUnavailable: 'L’envoi d’e-mails est indisponible sur ce Home. Partagez un lien à la place.',
            reissue: 'Créer un nouveau lien',
            reissueNotice: 'La réémission crée un nouveau lien. Le lien précédent cessera de fonctionner.',
            revoke: 'Révoquer l’invitation',
            revokeTitle: 'Révoquer cette invitation ?',
            revokeBody: 'Le lien cesse de fonctionner immédiatement. Vous pouvez en créer un nouveau à tout moment.',
            shareLink: 'Partager le lien',
            shareUnavailable: 'Le partage n’est pas disponible sur cet appareil. Copiez plutôt le lien.',
            bearerUnavailable: 'Ce lien a été affiché une seule fois et n’est pas conservé. Créez un nouveau lien pour repartager l’accès.',
            linkUnavailableRow: 'Aucun lien partageable',
            linkUnavailableBody: 'Ce Home n’a publié aucune adresse vers laquelle les liens d’invitation peuvent pointer ; il n’y a donc aucun lien à partager. Demandez à un administrateur du Home d’en publier une, ou ajoutez des personnes depuis la liste Personnes de la Team.',
        },
        join: {
            previewLoading: 'Vérification de cette invitation…',
            joinAction: ({ team }: { team: string }) => `Rejoindre ${team}`,
            joinWithCurrentAccount: 'Rejoindre avec ce compte',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} sera ajoutée comme adresse vérifiée à ce compte.`,
            useAnotherAccount: 'Utiliser un autre compte',
            useCurrentAccount: 'Utiliser le compte actuel',
            useAnotherAccountHint: 'Connecte-toi à ce Home sans déconnecter ce compte.',
            hostedOn: ({ home }: { home: string }) => `Hébergé sur ${home}`,
            personalHomeNotice: 'Ce Home fonctionne sur un ordinateur personnel et peut être indisponible lorsqu’il est hors ligne.',
            plainStorageNotice: 'Les sessions de ce Home sont stockées sans chiffrement de bout en bout.',
            invitedBy: ({ name }: { name: string }) => `Invitation envoyée par ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Tu es invité en tant que ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Rejoindre en tant qu’invité ne donne pas accès aux sessions d’équipe de ${team}. Les éléments doivent être partagés avec toi ou avec un de tes groupes.`,
            joinedTitle: 'Tu as rejoint l’équipe',
            alreadyMemberTitle: 'Tu es déjà membre',
            openTeam: ({ team }: { team: string }) => `Ouvrir ${team}`,
            expiredTitle: 'Cette invitation a expiré',
            revokedTitle: 'Cette invitation a été révoquée',
            usedTitle: 'Cette invitation a déjà été utilisée',
            archivedTitle: 'Cette équipe est archivée',
            inactiveTitle: 'Ce compte ne peut pas rejoindre pour le moment',
            invalidTitle: 'Ce lien d’invitation n’est pas valide',
            unresolvedHomeTitle: 'Ce lien n’identifie pas son Home',
            unresolvedHomeBody: 'Cet appareil ne peut pas déterminer quel Home a émis cette invitation ; rien n’a donc été envoyé. Demande un nouveau lien à un responsable de l’équipe.',
            unknownHomeTitle: 'Ce Home n’est pas encore sur cet appareil',
            askForNew: 'Demande une nouvelle invitation à un responsable de l’équipe.',
            mismatchTitle: 'Cette invitation concerne une autre adresse',
            signInWithInvited: 'Se connecter avec l’adresse invitée',
            verifyAddress: 'Vérifier cette adresse',
            updateRequiredTitle: 'Ce Home doit être mis à jour pour utiliser les invitations d’équipe',
            offlineTitle: 'Ce Home est injoignable',
            offlineBody: 'L’invitation est conservée. Réessaie quand le Home sera de retour.',
            acceptanceOutcomeUnknown: 'Impossible de confirmer si tu as rejoint l’équipe. Réessaie pour vérifier la même invitation.',
            retry: 'Réessayer',
        },
        credentials: {
            recovery: {
                openSettings: 'Ouvrir les r\u00e9glages de l\u2019identifiant',
                selectBroker: 'Choisir un emplacement de broker',
                ownerHandoff: 'Demandez au propri\u00e9taire de la source de r\u00e9parer cet identifiant',
                updateApp: 'Mettre \u00e0 jour Happier',
                chooseAnother: 'Choisir un autre identifiant',
            },
            requestPolicy: {
                title: 'Politique de requête',
                subtitle: 'Limitez ce que l’on peut demander à cet identifiant.',
                summaryNone: 'Aucune restriction',
                summaryActive: ({ count }: { count: number }) => `${count} restrictions`,
                protocolsLabel: 'Formats de requête',
                protocolsAny: 'Tous ceux pris en charge par la source',
                modelsLabel: 'Modèles',
                modelsAny: 'Tous les modèles proposés par la source',
                modelsAllowed: ({ count }: { count: number }) => `${count} autorisés`,
                effortLabel: 'Effort de raisonnement',
                effortAny: 'Tous ceux pris en charge par la source',
                catalogUnavailable: 'Choisir les modèles autorisés n’est pas encore possible depuis ce Home. Les choix actuels restent en vigueur jusqu’à leur suppression.',
                clear: 'Supprimer toutes les restrictions',
                activeNote: 'Une session déjà en cours n’est pas modifiée. Sa prochaine requête devra respecter la nouvelle politique.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Disponibilité de l’accès direct',
                check: 'Vérifier la disponibilité',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} prêts · ${pending} en préparation`,
                allReady: 'Toutes les personnes disposant d’un accès direct sont prêtes.',
                automatic: 'Le matériel est préparé sur l’ordinateur qui détient cette source, dès qu’il est en ligne.',
                state: {
                    ready: 'Prêt',
                    preparing: 'Préparation de l’accès',
                    notDelivered: 'Pas encore transmis',
                    recipientBindingChanged: 'En attente de la configuration du compte chiffré',
                    sourceChanged: 'Source modifiée — mise à jour',
                },
            },
            externalApi: {
                title: 'Accès API externe',
                subtitle: 'Utilisez ce fournisseur depuis des outils compatibles en dehors de Happier.',
                privateTitle: 'Sessions Happier',
                privateDetail: 'Privé via Happier',
                unavailable: 'L’accès API externe n’est pas disponible sur ce Home.',
                publicHttpsRequired: 'Les outils externes nécessitent une adresse HTTPS publique pour ce Home.',
                homeDisclosure: 'Le corps brut des requêtes au fournisseur transite par le point de terminaison HTTPS public de ce Home et peut être lu par son opérateur.',
                bearerDisclosure: 'Cette clé est un secret au porteur. Toute personne qui la détient peut utiliser l’accès attribué jusqu’à son expiration ou sa révocation.',
                usageDisclosure: 'Happier enregistre le nombre de requêtes. Les totaux de jetons et de coûts peuvent être incomplets si un protocole ne les communique pas.',
                keysTitle: 'Clés API',
                authorize: 'Autoriser la clé',
                authenticationRequired: 'Le membre désigné doit autoriser cette clé avec sa connexion à l’équipe.',
                authenticationUnavailable: 'L’authentification de l’équipe est indisponible. Demandez à un administrateur de vérifier sa politique de connexion.',
                keysLoadFailed: 'Impossible de charger les clés API.',
                keysRetry: 'Réessayer de charger les clés',
                keysEmpty: 'Aucune clé',
                keysEmptyBody: 'Créer la première clé active l’accès externe ; révoquer la dernière le désactive.',
                labelPlaceholder: 'À quoi sert cette clé',
                assignLabel: 'Attribuée à',
                revealTitle: 'Enregistrez cette clé maintenant',
                revealBody: 'Elle ne sera plus affichée.',
                revealDismiss: {
                    title: 'Fermer sans copier la clé ?',
                    body: 'Cette clé ne pourra plus être affichée. Gardez-la visible jusqu’à ce que vous l’ayez enregistrée.',
                    confirm: 'J’ai enregistré la clé',
                    keepVisible: 'Garder la clé visible',
                },
                neverUsed: 'Jamais utilisée',
                lastUsed: ({ when }: { when: string }) => `Dernière utilisation ${when}`,
                expiresOn: ({ when }: { when: string }) => `Expire ${when}`,
                expired: 'Expirée',
                revokeTitle: ({ name }: { name: string }) => `Révoquer ${name} ?`,
                revokeBody: 'Les outils qui utilisent cette clé cessent de fonctionner immédiatement. Les sessions Happier ne sont pas affectées.',
                revokeAll: 'Révoquer toutes les clés',
                revokeAllBody: 'L’accès API externe est désactivé jusqu’à la création d’une nouvelle clé. Les sessions Happier ne sont pas affectées.',
            },
            title: 'Identifiants partag\u00e9s',
            subtitle: 'Permettez \u00e0 cette \u00e9quipe d\u2019utiliser un compte connect\u00e9, un pool ou un fournisseur sans le copier dans la configuration de chaque membre.',
            emptyTitle: 'Aucun identifiant partag\u00e9',
            emptyBody: 'Rien n\u2019a encore \u00e9t\u00e9 partag\u00e9 avec cette \u00e9quipe.',
            forbidden: 'Les identifiants partag\u00e9s sont g\u00e9r\u00e9s par les propri\u00e9taires et administrateurs de cette \u00e9quipe.',
            unavailable: 'Ce Home ne propose pas d\u2019identifiants partag\u00e9s.',
            approvalPending: 'En attente d’approbation. Les modifications sont conservées jusqu’à la décision.',
            approvalDeclined: 'Cette demande n’a pas été approuvée, donc rien n’a changé.',
            sessionDeniedTitle: 'Un identifiant partagé a refusé cette requête',
            sharedByYou: 'Partag\u00e9 par vous',
            providedByTeams: 'Fourni par les \u00e9quipes',
            sharedWithYou: 'Partag\u00e9 avec vous',
            sourceAdministration: { title: 'Partag\u00e9 avec des \u00e9quipes', empty: 'Cette source n\u2019est partag\u00e9e avec aucune \u00e9quipe.' },
            source: {
                connectedAccount: 'Compte connect\u00e9',
                pool: 'Pool de services connectés',
                providerConnection: 'Connexion fournisseur',
            },
            delivery: {
                brokered: 'Via le courtier',
                direct: 'Acc\u00e8s direct',
                both: 'Courtier + direct',
                mixed: 'Distribution mixte',
            },
            state: {
                available: 'Disponible',
                needsAttention: 'Attention requise',
                disabled: 'D\u00e9sactiv\u00e9',
            },
            usePolicy: {
                title: 'Partager cette session avec l’Équipe ?',
                label: 'O\u00f9 les membres peuvent l\u2019utiliser',
                personalAllowed: 'Toute session autoris\u00e9e',
                teamContextRequired: 'Sessions rattach\u00e9es \u00e0 cette \u00e9quipe',
                teamVisibilityRequired: 'Sessions visibles par cette \u00e9quipe',
                visibilityNote: 'Choisir cet identifiant peut partager une session priv\u00e9e avec l\u2019\u00e9quipe apr\u00e8s confirmation de la personne.',
            },
            selection: {
                activeTransitionUnsupported: 'Cette session a démarré avant l’enregistrement du changement, donc le modèle n’a pas changé. Réessayez.',
            },
            detail: {
                sourceLabel: 'Origine',
                brokerLabel: 'Emplacement du courtier',
                brokerNone: 'Choisir un emplacement de courtier',
                access: 'Acc\u00e8s et distribution',
                activity: 'Activit\u00e9',
                edit: 'Modifier',
                notFound: 'Cet identifiant partag\u00e9 n\u2019est plus disponible.',
                brokerUnnamedMachine: 'Ordinateur sans nom',
                brokerUnnamedPool: 'Pool sans nom',
                brokerChosen: 'Choisie par le propriétaire de la source',
                limits: 'Plafonds',
                usage: 'Consommation',
            },
            create: {
                title: 'Partager un identifiant',
                action: 'Partager un identifiant',
                submit: 'Créer l’identifiant partagé',
                sourceChoose: 'Choisir une source',
                sourceEmpty: 'Rien à partager pour l’instant.',
                sourceUnsupported: 'Les comptes connectés et les connexions de fournisseur ne peuvent pas encore être partagés depuis ce Home.',
                alreadyShared: 'Déjà partagé avec cette équipe',
                poolAccounts: ({ count }: { count: number }) => `${count} comptes`,
                notAllowed: 'Cette équipe ne vous laisse pas proposer vos propres identifiants.',
                reviewLabel: 'Récapitulatif',
            },
            edit: {
                title: 'Modifier l\u2019identifiant partag\u00e9',
                nameLabel: 'Nom',
                namePlaceholder: 'Nommez cet identifiant',
                ceilingLabel: 'Divulgation directe',
                ceilingBrokeredOnly: 'Courtier uniquement',
                ceilingDirectAllowed: 'Autoriser l\u2019acc\u00e8s direct',
                ceilingNote: 'L\u2019acc\u00e8s direct permet aux outils locaux du destinataire de recevoir le mat\u00e9riel d\u2019identification. Retirer l\u2019acc\u00e8s arr\u00eate les livraisons futures, mais n\u2019efface pas ce qu\u2019un processus externe a d\u00e9j\u00e0 utilis\u00e9.',
                conflict: 'Ces r\u00e9glages ont chang\u00e9 ailleurs. Rechargez pour voir les valeurs actuelles avant d\u2019enregistrer.',
            },
            audience: {
                title: 'Acc\u00e8s et distribution',
                none: 'Personne pour l\u2019instant',
                everyone: 'Toute l\u2019\u00e9quipe',
                everyoneOff: 'Aucun acc\u00e8s pour toute l\u2019\u00e9quipe',
                groupCount: ({ count }: { count: number }) => `${count} groupes`,
                memberCount: ({ count }: { count: number }) => `${count} personnes`,
                add: 'Ajouter un groupe ou une personne',
                groupsSection: 'Groupes',
                membersSection: 'Personnes',
                remove: 'Retirer l\u2019acc\u00e8s',
                ceilingBlocked: 'L\u2019acc\u00e8s direct n\u2019est pas autoris\u00e9 pour cet identifiant. Autorisez-le d\u2019abord dans Modifier.',
                directTitle: 'Partager cet identifiant directement\u00a0?',
                directBody: 'Les outils locaux des personnes choisies peuvent recevoir le mat\u00e9riel d\u2019identification de cette source. Retirer l\u2019acc\u00e8s arr\u00eate les livraisons futures, mais n\u2019efface pas ce qu\u2019un processus externe a d\u00e9j\u00e0 utilis\u00e9.',
                directConfirm: 'Partager directement',
                keepBrokered: 'Garder via le courtier',
                limitsNote: 'L\u2019usage direct a lieu hors de Happier et n\u2019est pas enregistr\u00e9.',
            },
            directUse: {
                title: 'Utiliser directement cet identifiant partag\u00e9\u00a0?',
                body: 'Happier peut fournir le mat\u00e9riel d\u2019identification aux outils locaux utilis\u00e9s par cette session. Continuez uniquement si vous confiez cet identifiant \u00e0 ces outils.',
            },
            delete: {
                action: 'Supprimer l\u2019identifiant partag\u00e9',
                title: ({ name }: { name: string }) => `Supprimer ${name}\u00a0?`,
                body: 'Les membres perdent l\u2019acc\u00e8s imm\u00e9diatement et la prochaine requ\u00eate \u00e9choue. Le mat\u00e9riel d\u00e9j\u00e0 livr\u00e9 directement ne peut pas \u00eatre effac\u00e9.',
            },
            errors: {
                featureDisabled: 'Ce Home ne propose pas d\u2019identifiants partag\u00e9s.',
                teamAuthenticationRequired: 'Connectez-vous \u00e0 cette \u00e9quipe avant de continuer.',
                teamAuthenticationPolicyUnavailable: 'La politique de connexion de cette \u00e9quipe n\u2019a pas pu \u00eatre lue : rien n\u2019a \u00e9t\u00e9 modifi\u00e9.',
                memberNotEligible: 'Cette personne ne peut pas utiliser cet identifiant.',
                sessionPolicyIncompatible: 'Cet identifiant ne peut pas \u00eatre utilis\u00e9 dans cette session avec sa politique de partage.',
                brokerUnavailable: 'La machine courtier de cet identifiant est injoignable pour l’instant. Réessayez quand elle sera de retour ou choisissez un autre emplacement.',
                sourceOwnerRequired: 'Seule la personne qui possède cette source peut effectuer ce changement.',
                sourceMissing: 'Cet identifiant ne désigne plus une source existante. Son propriétaire doit choisir la source à nouveau.',
                invalidAudience: 'Ces personnes ou groupes ne peuvent pas recevoir cet identifiant.',
                subjectNotInTeam: 'Cette personne ou ce groupe ne fait plus partie de cette équipe.',
                costUnavailable: 'Un plafond de coût exige un tarif pour chaque modèle autorisé, et certains n’en ont pas. Limitez plutôt les requêtes ou les jetons.',
                invalidLimit: 'Vérifiez la mesure, la période et le maximum.',
                limitIdentityImmutable: 'La cible d’un plafond, sa mesure et sa période ne peuvent pas changer. Supprimez-le et créez-en un nouveau.',
            },
            limits: {
                groupShared: 'Ce montant est partag\u00e9 par tous les membres du Groupe.',
                title: 'Plafonds',
                empty: 'Aucun plafond',
                emptyBody: 'Toutes les requêtes sont autorisées tant que vous n’en ajoutez pas.',
                overshoot: 'Les nouvelles requêtes s’arrêtent dès que la consommation enregistrée atteint le plafond. Les requêtes déjà en cours peuvent se terminer.',
                directNote: 'Les plafonds couvrent l’usage via le courtier et l’API externe. L’usage direct a lieu sur la machine du destinataire et n’est pas enregistré.',
                directOnly: 'Toutes les personnes autorisées utilisent cet identifiant en direct, sur leur propre machine : Happier n’en enregistre rien et aucun plafond ne peut s’appliquer.',
                requestLimitsOnlyForPersonalUse: 'Les plafonds de jetons apparaissent quand cet identifiant exige un contexte d’équipe. L’usage personnel l’ouvre aussi aux exécutions en arrière-plan et à l’API externe, qui ne rapportent que des requêtes : seuls les plafonds de requêtes couvrent donc tous les usages.',
                add: 'Ajouter un plafond',
                subjectLabel: 'S’applique à',
                subject: {
                    resource: 'Tout l’identifiant partagé',
                    eachMember: 'Chaque membre séparément',
                    group: 'Groupe',
                    member: 'Personne',
                },
                metricLabel: 'Mesure',
                metric: {
                    requests: 'Requêtes',
                    tokens: 'Jetons',
                    cost: 'Coût',
                },
                costNote: 'Un plafond de coût ne fonctionne que si chaque modèle autorisé a un tarif connu.',
                periodLabel: 'Période',
                period: {
                    day: 'Par jour',
                    week: 'Par semaine',
                    month: 'Par mois',
                },
                maximumLabel: 'Maximum',
                maximumPlaceholder: 'Maximum par période',
                maximumInvalid: 'Saisissez un nombre entier supérieur à zéro.',
                maximumInvalidCost: 'Saisissez un montant supérieur à zéro.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} sur ${maximum} enregistré`,
                resetsUtc: ({ when }: { when: string }) => `Réinitialisation le ${when} UTC`,
                reached: 'Plafond atteint',
                disabled: 'Désactivé',
                remove: 'Supprimer le plafond',
                removeTitle: 'Supprimer ce plafond ?',
                removeBody: 'Les requêtes cessent immédiatement d’être vérifiées avec lui. La consommation enregistrée est conservée.',
                unknownSubject: 'Quelqu’un hors de cette page',
            },
            usage: {
                title: 'Consommation',
                empty: 'Rien d’enregistré sur cette période.',
                rangeLabel: 'Période',
                brokeredRequests: 'Requêtes relayées',
                directOnlyRequests: 'Les requêtes ne sont comptées que pour l’usage relayé.',
                recordedRequests: 'Requêtes enregistrées',
                requestIncomplete: 'Seules les requêtes observées par Happier sont incluses.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'requête externe n’a' : 'requêtes externes n’ont'} pas encore de résultat enregistré.`,
                breakdownRestricted: 'Certaines répartitions ne sont visibles que par les gestionnaires d’identifiants.',
                export: 'Exporter en CSV',
                exportFailed: 'Cet appareil n’a pas pu enregistrer l’export.',
                recordedByHappier: 'Enregistré par Happier.',
                directIncomplete: 'L’usage direct a lieu hors de Happier et peut ne pas être inclus.',
                costIncomplete: 'Le coût est indisponible pour certains modèles sur cette période.',
                tokenIncomplete: 'Le total de jetons est incomplet pour cette période.',
                tokenUnavailable: 'Aucune utilisation de jetons n’a été observée pour cette période.',
                costUnavailable: 'Aucune utilisation tarifée n’a été observée pour cette période.',
                costUnknown: 'Indisponible',
                breakdownLabel: 'Répartir par',
                breakdownNone: 'Totaux seulement',
                breakdown: {
                    member: 'Personne',
                    externalApiKey: 'Clé API externe',
                    model: 'Modèle',
                    session: 'Session',
                    sourceMember: 'Compte source',
                    workerMachine: 'Machine d’exécution',
                    brokerMachine: 'Machine courtier',
                    deliveryMode: 'Distribution',
                },
                limitsTitle: 'Plafonds sur cette période',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} requêtes · ${tokens} jetons`,
            },
            activity: {
                title: 'Activit\u00e9',
                empty: 'Aucune modification administrative enregistr\u00e9e.',
                unknownActor: 'Quelqu\u2019un',
                kind: {
                    resourceCreated: 'A partag\u00e9 cet identifiant',
                    resourceUpdated: 'A modifi\u00e9 les r\u00e9glages',
                    audienceChanged: 'A modifi\u00e9 qui peut l\u2019utiliser',
                    resourceDeleted: 'A supprim\u00e9 cet identifiant',
                    directDelivered: 'A livr\u00e9 un acc\u00e8s direct',
                    externalKeyCreated: 'A cr\u00e9\u00e9 une cl\u00e9 d\u2019API externe',
                    externalKeyRevoked: 'A r\u00e9voqu\u00e9 une cl\u00e9 d\u2019API externe',
                    limitsChanged: 'A modifi\u00e9 les limites',
                },
            },
        },
    },
};

const teamsTranslations = { fr: french };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { fr: en };

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

const fr: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Connecter cet ordinateur à ${home} ?`,
        body: ({ home }: HomeParams) => `${home} pourra lancer des sessions sur cet ordinateur. Le Home du terminal et les autres connexions restent en place.`,
        connect: 'Connecter',
        keep: 'Garder les connexions actuelles',
    },
    setupAlreadyRunning: 'Une configuration est déjà en cours. Attendez qu’elle se termine.',
    title: {
        daemon_url_mismatch: 'Le service en arrière-plan est sur un autre Home',
        daemon_account_mismatch: 'Le service en arrière-plan utilise un autre compte',
        daemon_needs_auth: 'Le service en arrière-plan doit se connecter',
        daemon_not_configured: 'Le service en arrière-plan n’est pas encore connecté',
        daemon_not_installed: 'Le service en arrière-plan n’est pas installé',
        daemon_not_running: 'Le service en arrière-plan est arrêté',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Il est connecté à ${daemonHome}, pas à ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Il est connecté à ${home} en tant que ${daemonAccount}, pas en tant que ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Il est connecté à ${home} mais n’a pas encore été approuvé.`,
        daemon_not_configured: ({ home }: HomeParams) => `Il n’a pas fini de se connecter à ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Installe-le pour connecter cet ordinateur à ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Démarre-le pour te reconnecter à ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Connecter à ce Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Passer à ${appAccount}`,
        daemon_needs_auth: 'Se connecter',
        daemon_not_configured: 'Connecter à ce Home',
        daemon_not_installed: 'Installer le service en arrière-plan',
        daemon_not_running: 'Démarrer le service en arrière-plan',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Connecté à ${home} en tant que ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} n’a encore aucun ordinateur sur ${home}.`,
    openThisComputer: 'Vérifier cet ordinateur',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Passer cet ordinateur à ${appAccount} ?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Son service en arrière-plan est connecté à ${daemonHome} en tant que ${daemonAccount}. Après le changement, il travaille pour ${appAccount} sur ${home}, et ${daemonAccount} ne voit plus cet ordinateur.`,
        confirm: 'Changer',
    },
    cli: {
        title: 'CLI Happier',
        version: ({ version }: { version: string }) => `Version ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Version ${version} · ${latestVersion} est disponible`,
        update: 'Mettre à jour',
        progressTitle: 'Mise à jour de la CLI Happier',
        notManaged: ({ origin }: { origin: string }) => `Installée en dehors de Happier : ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `La CLI Happier ${version} est déjà installée`,
        titleUnknownVersion: 'La CLI Happier est déjà installée',
        titleMissing: 'Votre CLI Happier n’est plus installée',
        body: ({ path }: { path: string }) => `Elle se trouve dans ${path}. Happier peut installer sa propre copie, la tenir à jour et la placer en premier dans votre PATH, ou vous pouvez continuer à utiliser celle-ci.`,
        bodyOutdated: ({ path }: { path: string }) => `Elle se trouve dans ${path} et elle est trop ancienne pour la configuration. Happier peut installer sa propre copie à jour et la placer en premier dans votre PATH, ou vous pouvez garder la vôtre et la mettre à jour vous-même.`,
        bodyMissing: ({ path }: { path: string }) => `Vous aviez choisi de garder celle de ${path}, et elle n’y est plus. Happier peut installer sa propre copie et la tenir à jour, ou vous pouvez réinstaller la vôtre et continuer à l’utiliser.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Elle se trouve dans ${path}, mais les nouveaux terminaux lancent d’abord la CLI de Happier via ${link}, que Happier n’a pas ajouté. Laissez Happier gérer la ligne de commande, ou supprimez ${link} et relancez la configuration pour garder la vôtre.`,
        notNow: 'Plus tard',
        manage: 'Laisser Happier la gérer',
        keep: 'Garder la mienne',
        unanswered: 'La configuration s’est arrêtée avant de modifier quoi que ce soit. Choisissez qui gère la ligne de commande pour continuer.',
        ownMissing: 'La ligne de commande que vous avez gardée n’est plus installée. Réinstallez-la, ou laissez Happier gérer la ligne de commande.',
        managed: 'Gérée par Happier',
        own: ({ path }: { path: string }) => `La vôtre — ${path}`,
        change: 'Changer qui gère la ligne de commande',
        keptUpdateTitle: 'Mettre à jour ta ligne de commande',
        keptUpdate: ({ command }: { command: string }) => `Une version plus récente est disponible. Mets-la à jour avec ${command}`,
        oldCopyTitle: 'Ancienne ligne de commande',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Toujours installée dans ${path}. Supprimez-la avec ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Toujours installée dans ${path}.`,
    },
    servers: {
        title: 'Homes servis par cet ordinateur',
        connected: 'Connecté',
        offline: 'Configuré · Hors ligne',
        attention: 'Action requise',
        currentHome: ({ home }: HomeParams) => `${home} · ce Home`,
    },
    removal: {
        uninstallFailedTitle: 'Impossible de déconnecter cet ordinateur',
        uninstallFailedBody: ({ home }: HomeParams) => `Le service d’arrière-plan de cet ordinateur pour ${home} n’a pas pu être supprimé : ${home} a donc été conservé. Réessayez ou supprimez le service dans Réglages › Cet ordinateur.`,
        inventoryUnavailableTitle: 'Impossible de vérifier cet ordinateur',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier n’a pas pu lire les services d’arrière-plan de cet ordinateur et ne sait donc pas s’il dessert encore ${home}. Le retirer de Happier quand même ?`,
        removeAnyway: 'Retirer quand même',
        userOwnedTitle: 'Cet ordinateur continue de le desservir',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} a été installé en dehors de Happier : il continue donc de fonctionner pour ${home}. Supprimez-le depuis le terminal si vous n’en avez plus besoin.`,
    },
};

const thisComputerConnectionTranslations = { fr };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { fr: { searchOlder: 'Chercher dans les messages précédents', partialErrors: 'Une partie du contenu n’a pas pu être parcourue. Les résultats sont incomplets.', olderRemaining: 'Des messages précédents restent à parcourir.', findOpen: 'Ouvrir la recherche', findNext: 'Résultat suivant', findPrevious: 'Résultat précédent' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { fr: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'fichier modifié' : 'fichiers modifiés'}`,
                walkThrough: 'Explique-moi',
                openInFiles: 'Ouvrir dans Fichiers',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'} dans ${folders} dossiers`,
                showMore: ({ count }) => `Afficher ${count} de plus`,
                groupA11y: 'Modifications de ce tour',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { fr: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Enregistrer la parole sur cet appareil ?',
    consentBody: 'L’audio peut contenir des conversations privées et des bruits de fond. Les fichiers restent sur l’appareil, utilisent des autorisations privées, expirent automatiquement et ne sont jamais synchronisés ni joints aux analyses ou rapports de plantage.',
    consentAction: 'Activer l’enregistrement',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { fr: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["fr"].diagnostics, {
    title: 'Diagnostics vocaux locaux',
    footer: 'Désactivé par défaut. L’audio reste sur la machine sélectionnée jusqu’à ce que tu l’exportes explicitement.',
    enabled: 'Enregistrer l’audio de diagnostic local',
    enabledSubtitle: 'Conserve localement des entrées STT et des sorties TTS limitées pour le dépannage',
    sttInput: 'Enregistrer l’entrée de reconnaissance vocale',
    ttsOutput: 'Enregistrer la parole synthétisée',
    location: 'Emplacement de stockage',
    unavailable: 'Machine sélectionnée indisponible',
    retention: 'Limites de conservation',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} heures · ${files} fichiers · ${megabytes} Mo`,
    deleteAll: 'Supprimer tout l’audio de diagnostic',
    deleteAllSubtitle: 'Supprime immédiatement l’audio et les métadonnées de la machine sélectionnée',
    deleteConfirmTitle: 'Supprimer tous les diagnostics vocaux locaux ?',
    deleteConfirmBody: 'Cette action supprime définitivement tous les artefacts de diagnostic vocal sur la machine sélectionnée.',
    deleteAction: 'Tout supprimer',
    deleteFailed: 'Les enregistrements de diagnostic locaux n’ont pas pu être supprimés. Ils sont peut-être encore sur la machine sélectionnée.',
    cleanupRequired: 'Le nettoyage des diagnostics locaux nécessite ton attention',
    cleanupRequiredSubtitle: 'Des fichiers de diagnostic privés peuvent subsister, ou le catalogue local n’a pas pu être lu. Relance le nettoyage ou supprime tout l’audio de diagnostic.',
    captureFailed: 'La capture de diagnostic nécessite ton attention',
    captureFailedSubtitle: 'La dernière capture audio de diagnostic n’a pas pu être lue ni enregistrée. Aucun fichier de diagnostic résiduel n’a été détecté ; la prochaine capture vocale éligible vérifiera de nouveau l’état.',
    retryCleanup: 'Relancer le nettoyage des diagnostics',
    retryCleanupSubtitle: 'Revérifie le stockage privé et réapplique ses limites de conservation',
    cleanupRetryFailed: 'Le nettoyage n’a pas pu être terminé. Des fichiers de diagnostic peuvent subsister sur la machine sélectionnée ; réessaie ou supprime tout après sa reconnexion.',
    exportTitle: 'Exporter les diagnostics sélectionnés',
    noArtifacts: 'Aucun enregistrement de diagnostic conservé sur la machine sélectionnée.',
    exportSttArtifact: 'Exporter l’entrée de reconnaissance vocale',
    exportTtsArtifact: 'Exporter la parole synthétisée',
    exportArtifactAccessibility: 'Exporter cet enregistrement de diagnostic vocal local',
    exportConfirmTitle: 'Exporter cet enregistrement privé ?',
    exportConfirmBody: 'L’enregistrement sélectionné est copié de la machine sélectionnée vers cet appareil via un transfert chiffré à usage unique. Il n’est jamais envoyé automatiquement.',
    exportAction: 'Exporter l’enregistrement',
    exportFailed: 'L’enregistrement privé n’a pas pu être exporté. Rien n’a été envoyé.',
    backupPolicy: 'Exclusion des sauvegardes',
    backupPolicyBestEffort: 'Stocké dans le cache privé de la machine sélectionnée et marqué pour les outils de sauvegarde qui respectent le standard des répertoires de cache. Aucun envoi ni synchronisation automatique n’est implémenté ; l’exclusion des sauvegardes du système d’exploitation n’est pas garantie.',
    activeIndicator: 'Diagnostics vocaux activés',
    checkingIndicator: 'Vérification de l’état des diagnostics vocaux',
    statusUnknownIndicator: 'L’état des diagnostics vocaux est inconnu',
    shutdownPendingIndicator: 'Arrêt des diagnostics vocaux',
    shutdownFailedIndicator: 'Impossible de confirmer l’arrêt des diagnostics vocaux',
    retryShutdown: 'Réessayer d’arrêter les diagnostics',
    sessionOptOut: 'Ne pas enregistrer cette session',
    sessionOptOutConfirmTitle: 'Arrêter l’enregistrement de cette session ?',
    sessionOptOutConfirmBody: 'Les diagnostics vocaux restent activés pour les autres sessions, mais aucun nouvel audio de cette session ne sera enregistré jusqu’au redémarrage de l’app.',
    sessionOptOutFailed: 'L’enregistrement n’a pas pu être arrêté sur la machine active. Cette session peut encore être enregistrée ; réessaie après la reconnexion de la machine.',
    sessionOptOutRetry: 'Réessayer d’arrêter l’enregistrement',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { fr: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Vérifie l’accès aux identifiants',
    recipientApprovalTitle: 'Autoriser ce provider à utiliser ton identifiant ?',
    recipientApprovalBody: 'Vérifie et approuve les endpoints et les opérations déclarés du provider. Si ce contrat de destinataire change, Happier conserve ta sélection mais bloque l’utilisation de l’identifiant jusqu’à une nouvelle approbation.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquet : ${title} (${pluginId}) ; source : ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Éditeur : ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Signature du paquet : ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribution : ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Opérations déclarées :',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Opération ${id} : finalité ${purpose} ; effet ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Requête : ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `En-tête d’identifiant : ${headerName} ; format : ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limites d’octets : requête ${requestMaxBytes} ; réponse ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'intégré', verified: 'vérifié' },
    recipientApprovalEffect: { read: 'lecture', mutation: 'mutation' },
    recipientApprovalCredentialFormat: { raw: 'brut', bearer: 'bearer' },
    recipientApprovalConfirm: 'Approuver et enregistrer',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { fr: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Enregistrée dans ton compte',
      notSetOnAccount: 'Non enregistrée dans ton compte',
      setOnMachineOverride: ({ machine }) => `Un remplacement d’identifiant de compte est utilisé pour ${machine}`,
      notSetWithFallback: ({ machine }) => `Non définie pour ${machine} ; un identifiant de compte sera utilisé lorsqu’il est disponible`,
      plainStorageTitle: 'Enregistrer la clé API sans chiffrement de bout en bout ?',
      plainStorageBody: 'Ce compte stocke les réglages sans chiffrement de bout en bout. Enregistrer cette clé API rend son texte en clair visible par le serveur.',
      plainStorageConfirm: 'Enregistrer la clé API',
      deleteAccountBody: 'Supprimer cette clé API enregistrée ? Les autres liaisons qui référencent le même secret enregistré la conservent.',
      machineUnavailable: 'Sélectionne une machine d’exécution vocale en ligne',
      machineUnavailableTitle: 'Machine vocale indisponible',
      machineUnavailableBody: 'Choisis une machine d’exécution vocale en ligne avant d’enregistrer ou d’utiliser cet identifiant.',
      statusUnavailable: ({ machine }) => `État de l’identifiant indisponible sur ${machine}. Touche pour réessayer.`,
      importAvailable: ({ machine }) => `Ancienne clé disponible à importer vers ${machine}`,
      notSetOnMachine: ({ machine }) => `Non définie sur ${machine}`,
      setOnMachine: ({ machine, protection }) => `Définie sur ${machine} · ${protection}`,
      protection: { osProtected: 'Protégée par le système', filePermissions: 'Protégée par les permissions de fichier' },
      importTitle: 'Importer la clé API existante ?',
      importBody: ({ machine }) => `Copie le réglage de compte chiffré existant vers ${machine}. L’original reste disponible pour tes autres appareils.`,
      importAction: 'Importer',
      enterNewAction: 'Saisir une nouvelle',
      useSavedSecretTitle: 'Utiliser un secret enregistré',
      useSavedSecretSubtitle: 'Choisis une clé déjà stockée dans ce compte.',
      replaceOrRemoveBody: 'Saisis une nouvelle clé API, ou laisse le champ vide pour supprimer la clé de cette machine.',
      deleteTitle: 'Supprimer la clé API ?',
      deleteBody: ({ machine }) => `Supprimer cette clé API de ${machine} ? L’ancienne valeur partagée entre appareils, le cas échéant, n’est pas modifiée.`,
      operationFailed: 'La machine sélectionnée n’a pas pu mettre à jour cet identifiant. Vérifie qu’elle est en ligne et réessaie.',
      newCredentialRequired: ({ machine }) => `Un nouvel identifiant de machine est requis sur ${machine}`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Les requêtes s’exécutent sur ${machine}. Localhost désigne cette machine.`,
      insecureTitle: 'Autoriser le HTTP local non sécurisé ?',
      insecureBody: ({ origin, machine }) => `Autoriser l’envoi d’identifiants en HTTP vers ${origin} depuis ${machine} ? Localhost désigne ${machine}. Seules les adresses de bouclage et de réseau privé sont acceptées ; le HTTP public est refusé.`,
      allowAction: 'Autoriser HTTP',
      invalidBody: 'Saisis une URL HTTPS, ou une URL HTTP de bouclage ou de réseau privé, sans nom d’utilisateur, mot de passe ni chaîne de requête.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { fr: {
        setupTitle: 'Configurer la voix',
        setupTileSubtitle: 'Parlez à vos sessions à voix haute. Quatre étapes courtes.',
        setupTileProgress: ({ done, total, next }) => `${done} sur ${total} faits · ${next}`,
        setupNextService: 'ensuite : qui écoute',
        setupNextReadiness: 'ensuite : finir le service',
        setupNextMicrophone: 'ensuite : autoriser le micro',
        setupNextTry: 'ensuite : essayer',
        setupNextInstalling: 'installation',
        setupStart: 'Configurer',
        setupContinue: 'Continuer',
        setupDescription: 'Parlez à vos sessions à voix haute : demandez ce qui se passe, lancez du travail, décidez de n’importe où. Quatre étapes ; vous pouvez partir et revenir.',
        setupLightCaption: ({ done, total }) => `${done} sur ${total} prêts`,
        setupServiceTitle: 'Choisissez qui écoute',
        setupServiceDetail: 'Ce qui vous entend et vous répond. Vous pourrez le changer plus tard.',
        setupChange: 'Modifier',
        setupReadinessTitle: ({ service }) => `Terminez de configurer ${service}`,
        setupReadinessDone: ({ service }) => `${service} est prêt`,
        setupReadinessGeneric: 'Le service',
        setupReadinessTitleGeneric: 'Préparez le service',
        setupReadinessUnknown: 'Ouvrez ses réglages pour voir ce qu’il manque.',
        setupReadinessCheck: 'Vérifier la configuration',
        setupMicrophoneTitle: 'Autorisez le micro',
        setupMicrophoneDetail: 'Votre appareil demande une fois. Happier n’écoute que lorsque la voix est active, et vous le voyez toujours.',
        setupMicrophoneAction: 'Autoriser le micro',
        setupMicrophoneDone: 'Micro autorisé',
        setupMicrophoneDeniedTitle: 'Le micro est désactivé pour Happier',
        setupMicrophoneDeniedDetail: 'Activez-le dans les réglages système, puis revenez ici.',
        setupOpenSystemSettings: 'Ouvrir les réglages',
        setupTryTitle: 'Essayez',
        setupTryDetail: 'Demandez « Que font mes sessions ? ». Vos mots arrivent dans la conversation comme tout message.',
        setupTryAction: 'Essayer',
        setupTryDone: 'Essayé',
        setupTryNeedsService: 'Disponible dès que le service est prêt.',
        setupDoneTitle: 'La voix est prête',
        setupDoneBody: 'Touchez le bouton voix dans n’importe quel chat pour parler, et à nouveau pour terminer. Muet est à côté de Terminer pendant que vous parlez.',
        setupGestureTap: 'Toucher',
        setupGestureStartEnd: 'démarrer · terminer',
        setupGestureAnywhere: 'démarrer · terminer partout',
        setupDoneAction: 'Terminé',
        setupSettingsAction: 'Réglages de la voix',
        setupClose: 'Fermer',
        needsYouEnded: 'La voix est terminée. L’approbation attend toujours dans la boîte de réception.',
        needsYouReview: 'Examiner la demande',
        needsYouTapToDecide: 'Lu à voix haute · décidez ici, pas à la voix',
        briefMe: 'Fais-moi le point',
        briefMeA11y: 'Fais-moi le point : la voix lit ce qui vous attend, ce qui a échoué et ce qui est prêt',
        briefNeedsYou: 'Vous attend',
        briefFailed: 'Échoué',
        briefReady: 'Prêt',
        briefIncomplete: 'Tout le travail n’est pas encore chargé ; il peut manquer des éléments.',
        briefCaughtUp: 'Rien ne vous attend pour l’instant.',
        briefNotSpoken: 'La voix ne peut pas le lire pour l’instant. La liste est complète ici.',
        briefStop: 'Arrêter',
        continueTitle: 'Continuer à parler ici',
        continueDetail: ({ device }) => `Vous parliez sur ${device}`,
        continueAction: 'Continuer',
        continuedOn: ({ device }) => `Poursuivi sur ${device}`,
        continuedElsewhere: 'Poursuivi sur un autre appareil',
        continuedHere: 'Poursuivi sur cet appareil',
        dismiss: 'Ignorer',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "fr">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { fr: {
        welcomeText: "Bonjour, je vous écoute — que souhaitez-vous faire ?",
        customVoice: 'Voix personnalisée',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `Bonjour, vous parlez à ${name} — que souhaitez-vous faire ?`,
        greetingLiteralUnavailable: "Dans cette langue de réponse, le service attend que vous parliez.",
        title: 'Voix',
        howYouTalk: "Comment vous parlez",
        holdToTalkTitle: "Maintenir pour parler",
        holdToTalkDescription: "Maintenez la marque Voice pour dire une chose ; relâchez pour envoyer. Un appui démarre et termine toujours Voice.",
        holdToTalkHint: "Maintenez pour un tour ; relâchez pour envoyer. Glissez pour annuler.",
        holdToTalkUnavailable: ({ service }) => `${service} ne permet pas de maintenir pour parler. Appuyez pour parler.`,
        talkWithVoice: 'Parler avec Voix',
        dictate: 'Dicter',
        globalVoice: 'Voix globale',
        interrupt: 'Interrompre',
        options: 'Options de Voix',
        you: 'Vous',
        showConversation: 'Afficher la conversation',
        dragToMove: 'Faire glisser pour déplacer',
        openConversation: 'Ouvrir la conversation',
        settings: 'Réglages de Voix',
        ended: 'Voix terminée',
        muted: 'Micro coupé',
        setUp: 'Configurer Voix',
        setUpHint: 'Ouvre les réglages de Voix pour choisir comment elle parle',
        startAgain: 'Recommencer',
        endedCaption: ({ elapsed }) => `${elapsed} · la conversation est enregistrée`,
        dismiss: 'Fermer',
        mute: "Couper le micro",
        unmute: "Réactiver",
        end: "Terminer",
        captions: { connecting: "Ouverture du canal audio", listening: "Allez-y", transcribing: "Transcription en cours", thinking: "Préparation d’une réponse", speaking: "Vous pouvez interrompre à tout moment", interrupted: "Allez-y", muted: "Réactivez le micro pour parler · Voix peut encore parler", reconnecting: "Connexion perdue · nouvelle tentative", blocked: "Autorisez l’accès au micro pour parler", failed: "Réessayez ou vérifiez les réglages de Voix" },
        recovery: { allow: "Autoriser", setUp: "Configurer" },
        containerA11y: ({ status }) => `Voix, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "fr">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { fr: {
    openai: {
      privacyDisclosure: 'L’audio et le contenu de la conversation sont envoyés depuis cet appareil vers OpenAI via WebRTC. Lorsque les fonctionnalités correspondantes sont activées ou utilisées, OpenAI peut aussi recevoir depuis cet appareil des mises à jour limitées du contexte Voice, des définitions d’outils client et des résultats délégués. Happier utilise la clé Voice API enregistrée, le Service connecté OpenAI ou le compte expérimental Codex OAuth sélectionné pour générer une authentification client de courte durée ; les comptes connectés sont utilisés via la machine sélectionnée. OpenAI traite la conversation en direct sous le compte sélectionné et peut conserver les données reçues selon les réglages de ce compte et les conditions d’OpenAI. Le serveur et le relay de Happier ne transportent pas l’audio en direct. Les contrôles de partage du contexte Voice sont distincts de ce traitement par le provider.',
    },
    xai: {
      privacyDisclosure: 'L’audio et le contenu de la conversation sont envoyés depuis cet appareil vers xAI via la connexion xAI Realtime. Lorsque les fonctionnalités correspondantes sont activées ou utilisées, xAI peut aussi recevoir depuis cet appareil des mises à jour limitées du contexte Voice, des définitions d’outils client et des résultats délégués. Happier utilise la clé API xAI enregistrée dans les secrets de ton compte Happier uniquement pour les opérations limitées d’authentification client et de catalogue de voix. xAI traite la conversation en direct sous ce compte et peut conserver les données reçues selon les réglages du compte et les conditions de xAI. Si la reprise est activée, Happier enregistre l’identifiant de conversation du provider ; l’oublier supprime l’identifiant enregistré par Happier et ne supprime pas les données conservées par xAI. Le serveur et le relay de Happier ne transportent pas l’audio en direct. Les contrôles de partage du contexte Voice sont distincts de ce traitement par le provider.',
    },
    speechProcessing: {
      deviceStt: 'L’audio est traité par le service de reconnaissance vocale du navigateur ou du système d’exploitation. Selon la plateforme et le service configuré, le traitement peut avoir lieu hors de l’appareil.',
      deviceTts: 'Le texte de la réponse est traité par le service de synthèse vocale du navigateur ou du système d’exploitation. Selon la plateforme et le service configuré, le traitement peut avoir lieu hors de l’appareil.',
    },
    fields: {
      resumption: {
        title: 'Enregistrer l’identifiant de reprise xAI',
        subtitle: 'Autorise Happier à enregistrer l’identifiant de conversation temporaire du provider xAI pour la reconnexion.',
      },
    },
    resumption: {
      confirmTitle: 'Enregistrer l’identifiant de reprise xAI ?',
      confirmBody: 'Happier enregistrera l’identifiant de conversation du provider xAI pendant {minutes} minutes au maximum afin qu’une conversation interrompue puisse se reconnecter. Cela ne modifie ni ne supprime les données conservées par xAI.',
      confirmAction: 'Enregistrer l’identifiant',
      forgetTitle: 'Oublier l’identifiant de reprise Happier',
      forgetSubtitle: 'Supprime l’identifiant de conversation du provider enregistré par Happier. La conversation n’est pas supprimée, et les données conservées par xAI non plus.',
      forgotten: 'Happier a supprimé l’identifiant de conversation du provider qu’il avait enregistré.',
      unsupported: 'Happier ne peut pas supprimer l’identifiant de conversation du provider enregistré depuis cette session.',
      failed: 'Happier n’a pas pu supprimer l’identifiant de conversation du provider qu’il avait enregistré. Réessaie.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { fr: defineVoiceReadinessTranslation({
    ready: 'Prêt pour Voice.',
    permissionAnnouncement: ({ summary }) => `La session de code a besoin d’une autorisation pour ${summary}. Vérifie-la dans l’interface de la session pour l’approuver ou la refuser.`,
    userActionAnnouncement: ({ question }) => `La session de code a besoin de ta réponse. ${question}`,
    userActionFallback: 'La session de code a besoin de ta réponse. Réponds à la question pour que je puisse continuer.',
    requestedTool: 'l’outil demandé',
    provider_unselected: 'Choisis un provider Voice.',
    contribution_unavailable: 'Ce provider Voice n’est plus disponible.',
    role_unsupported: 'Ce provider ne prend pas en charge le mode Voice sélectionné.',
    platform_unsupported: 'Ce provider Voice n’est pas disponible sur cette plateforme.',
    settings_unsupported_version: 'Mets ce provider à jour avant de l’utiliser avec Voice.',
    settings_unknown: 'Les réglages du provider n’ont pas pu être vérifiés.',
    settings_needs_migration: 'Vérifie les réglages mis à jour de ce provider.',
    settings_invalid: 'Vérifie les réglages de provider invalides.',
    settings_missing_required_setting: ({ service }) => `Terminez la configuration de ${service} pour commencer.`,
    provider_mode_unknown: 'Choisis un mode pris en charge pour ce provider.',
    server_feature_disabled: 'Ce provider Voice est désactivé par le serveur.',
    server_feature_installing: 'La prise en charge de Voice est en cours de préparation par le serveur.',
    server_feature_incompatible: 'Le serveur est incompatible avec ce provider Voice.',
    server_feature_unknown: 'La prise en charge de ce provider Voice par le serveur n’a pas pu être vérifiée.',
    execution_machine_missing: 'Choisis une machine capable d’exécuter ce provider Voice.',
    execution_machine_installing: 'La machine d’exécution Voice sélectionnée est encore en préparation.',
    execution_machine_incompatible: 'La machine sélectionnée est incompatible avec ce provider Voice.',
    execution_machine_unknown: 'La machine d’exécution Voice n’a pas pu être vérifiée.',
    daemon_unreachable: 'La machine sélectionnée n’a aucune route disponible pour l’audio Voice.',
    daemon_relay_disabled: 'La machine sélectionnée a besoin du relay audio Voice, mais l’usage du relay est désactivé.',
    daemon_relay_capped: 'La capacité du relay audio Voice est actuellement indisponible pour la machine sélectionnée.',
    credential_missing: 'Ajoute les identifiants requis par ce provider Voice.',
    credential_approval_required: 'Vérifie l’accès aux identifiants avant d’utiliser ce provider Voice.',
    credential_installing: 'Les identifiants du provider sont encore en préparation.',
    credential_incompatible: 'Les identifiants sélectionnés sont incompatibles avec ce provider Voice.',
    credential_unknown: 'Les identifiants du provider n’ont pas pu être vérifiés.',
    endpoint_missing: 'Configure l’endpoint requis par ce provider Voice.',
    endpoint_installing: 'L’endpoint du provider Voice est encore en préparation.',
    endpoint_incompatible: 'L’endpoint configuré est incompatible avec ce provider Voice.',
    endpoint_unknown: 'L’endpoint du provider Voice n’a pas pu être vérifié.',
    runtime_missing: 'Installe le runtime requis par ce provider Voice.',
    runtime_installing: 'Le runtime du provider Voice est encore en cours d’installation.',
    runtime_incompatible: 'Le runtime installé est incompatible avec ce provider Voice.',
    runtime_unknown: 'Le runtime du provider Voice n’a pas pu être vérifié.',
    model_missing: 'Installe ou choisis un modèle pour ce provider Voice.',
    model_installing: 'Le modèle Voice sélectionné est encore en cours d’installation.',
    model_incompatible: 'Le modèle sélectionné est incompatible avec ce provider Voice.',
    model_unknown: 'Le modèle du provider Voice n’a pas pu être vérifié.',
    device_stt_unavailable: 'La reconnaissance vocale n’est pas disponible sur cet appareil.',
    device_stt_availability_unknown: 'La disponibilité de la reconnaissance vocale est en cours de vérification.',
    short: {
      needsSetup: 'À configurer',
      needsKey: 'Clé requise',
      needsApproval: 'Votre accord requis',
      offOnServer: 'Désactivé sur ce serveur',
      needsComputer: 'Ordinateur requis',
      needsAddress: 'Adresse requise',
      needsModel: 'Modèle requis',
      installing: 'Installation…',
      notInstalled: 'Non installé',
      unavailableHere: 'Indisponible ici',
      needsUpdate: 'Mise à jour requise',
      cantCheck: 'Pas encore vérifié',
    },
    actions: {
      select_provider: 'Choisir un provider',
      open_provider_settings: "Terminer la configuration",
      select_execution_machine: 'Choisir une machine',
      configure_credential: 'Ajouter des identifiants',
      review_credential_access: 'Vérifier l’accès aux identifiants',
      configure_endpoint: 'Configurer l’endpoint',
      install_model: 'Installer un modèle',
      switch_provider: 'Choisir un autre provider',
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

const voiceRealtimeProviderSetupTranslations = { fr: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["fr"], {
    xai: {
      setup: { footer: 'Ta clé API xAI est stockée comme secret enregistré synchronisé dans les secrets de ton compte Happier. Elle n’est matérialisée que pour l’opération xAI Realtime délimitée.' },
      credential: { promptBody: 'Colle une clé API xAI. Happier la protège comme un secret enregistré synchronisé et ne la matérialise que pour l’opération xAI Realtime délimitée.' },
    },
    setup: {
      title: 'Configuration de la voix en temps réel',
      footer: 'Ta clé API est stockée sur la machine d’exécution sélectionnée et n’est jamais incluse dans les réglages vocaux synchronisés.',
    },
    credential: {
      title: 'Clé API enregistrée',
      promptTitle: 'Connecter la voix en temps réel',
      promptBody: 'Colle une clé API OpenAI Platform. Elle est protégée dans les secrets synchronisés de ton compte et n’est matérialisée que pour émettre une authentification client Realtime de courte durée.',
    },
    authentication: {
      sectionTitle: 'Authentification OpenAI Realtime',
      title: 'Source d’authentification',
      subtitle: 'Choisis exactement une source. Happier ne bascule jamais vers une autre clé ou un autre compte.',
      footer: 'L’utilisation de l’API OpenAI Realtime est facturée par OpenAI Platform. Un abonnement ChatGPT ou Codex n’implique ni facturation ni accès à l’API Realtime. Seule une authentification client de courte durée est transmise à la conversation WebRTC.',
      savedSecret: {
        title: 'Clé API Voice enregistrée',
        subtitle: 'Utiliser la clé API stockée dans les secrets du compte Happier Voice. Aucun démon n’est nécessaire.',
      },
      openAiApiKey: {
        title: 'Service connecté OpenAI',
        subtitle: 'Utiliser le profil ou le groupe de comptes clé API OpenAI standard sélectionné via la machine choisie et son démon connecté.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (expérimental)',
        subtitle: 'Utiliser le profil ou le groupe de comptes Codex OAuth sélectionné via la machine choisie et son démon connecté. Happier ne bascule jamais vers une autre clé ou un autre compte.',
      },
      account: {
        title: 'Compte connecté',
        subtitle: 'Choisis le profil ou le groupe de comptes exact utilisé pour la prochaine conversation.',
      },
      chooseAccount: 'Choisis un compte',
      referenceRequired: 'Choisis un profil ou un groupe de comptes connecté.',
      connected: 'Compte connecté prêt',
      unavailable: 'Compte sélectionné indisponible ou à reconnecter',
    },
    invalidValue: 'Cette valeur n’est pas prise en charge par ce provider.',
    advanced: { show: 'Afficher les réglages avancés', hide: 'Masquer les réglages avancés' },
    fields: {
      model: { title: 'Modèle', subtitle: 'Choisis le modèle de voix en temps réel.' },
      voice: { title: 'Voix', subtitle: 'Choisis la voix utilisée pour les réponses.' },
      instructions: {
        title: 'Instructions vocales',
        subtitle: 'Instructions facultatives de comportement et de personnalité.',
        promptTitle: 'Instructions vocales',
        promptBody: 'Saisis des instructions facultatives pour cette session vocale.',
      },
      turnDetection: {
        title: 'Détection de fin de tour',
        subtitle: 'Choisis comment le provider détecte la fin de ton tour de parole.',
        threshold: {
          title: 'Seuil VAD',
          subtitle: 'Sensibilité à l’activité vocale ; laisse vide pour la valeur du provider.',
          promptTitle: 'Seuil VAD',
          promptBody: 'Saisis une valeur de 0.1 à 0.9, ou laisse vide.',
        },
        silenceDurationMs: {
          title: 'Durée de silence',
          subtitle: 'Millisecondes de silence avant de terminer un tour.',
          promptTitle: 'Durée de silence',
          promptBody: 'Saisis de 0 à 10000 millisecondes, ou laisse vide.',
        },
        prefixPaddingMs: {
          title: 'Marge avant la parole',
          subtitle: 'Millisecondes conservées avant la parole détectée.',
          promptTitle: 'Marge avant la parole',
          promptBody: 'Saisis de 0 à 10000 millisecondes, ou laisse vide.',
        },
        idleTimeoutMs: {
          title: 'Délai de réponse en cas d’inactivité',
          subtitle: 'Demander éventuellement à xAI de lancer une réponse après ce silence.',
          promptTitle: 'Délai de réponse en cas d’inactivité',
          promptBody: 'Saisis de 1 à 600000 millisecondes, ou laisse vide pour désactiver les réponses automatiques en cas d’inactivité.',
          confirmTitle: 'Activer les réponses automatiques en cas d’inactivité ?',
          confirmBody: 'Après le silence configuré, xAI peut créer une réponse de sa propre initiative et consommer de l’usage API.',
          confirmAction: 'Activer',
        },
      },
      transcriptionModel: {
        title: 'Modèle de transcription',
        subtitle: 'Modèle facultatif de transcription de l’entrée.',
        promptTitle: 'Modèle de transcription',
        promptBody: 'Saisis un identifiant de modèle, ou laisse vide pour la valeur du provider.',
      },
      reasoning: { title: 'Raisonnement', subtitle: 'Choisis l’effort de raisonnement pour les modèles compatibles.' },
      outputSpeed: {
        title: 'Vitesse de parole',
        subtitle: 'Ajuste la vitesse de parole du provider.',
        promptTitle: 'Vitesse de parole',
        promptBody: 'Saisis une valeur de 0.7 à 1.5.',
      },
      languageHint: {
        title: 'Indice de langue',
        subtitle: 'Aide éventuellement la transcription à identifier ta langue.',
        promptTitle: 'Indice de langue',
        promptBody: 'Choisis une langue prise en charge.',
      },
      keyterms: {
        title: 'Termes clés',
        subtitle: 'Noms et termes métier que la transcription doit reconnaître.',
        promptTitle: 'Termes clés',
        promptBody: 'Saisis jusqu’à 100 termes séparés par des virgules ou des retours à la ligne.',
      },
    },
    options: {
      pinned: 'Version épinglée',
      movingAlias: 'Suit automatiquement les mises à jour du provider',
      automatic: 'Automatique',
      custom: 'Personnalisé…',
      server_vad: 'Détection d’activité vocale côté serveur',
      semantic_vad: 'Détection sémantique de fin de tour',
      manual: 'Manuel',
      high: 'Élevé',
      none: 'Aucun',
    },
    catalog: {
      credentialRequired: 'Ajoute une clé API pour charger les voix',
      retry: 'Impossible de charger les voix — réessayer',
      empty: 'Aucune voix n’est disponible pour ce compte',
      preview: ({ voice }) => `Écouter ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Suivre le dernier modèle ?',
      confirmBody: 'Un alias de modèle mouvant peut changer de comportement lorsque le provider le met à jour. Tu peux revenir à une version épinglée à tout moment.',
      confirmAction: 'Utiliser le dernier',
    },
    links: {
      title: 'Ressources du provider',
      account: { title: 'Ouvrir le compte du provider', subtitle: 'Gère ton compte chez le provider.' },
      apiKeys: { title: 'Ouvrir les clés API', subtitle: 'Crée, renouvelle ou révoque les clés API du provider.' },
      privacy: { title: 'Politique de confidentialité du provider', subtitle: 'Consulte la façon dont le provider traite les données vocales.' },
    },
    disconnect: {
      title: 'Déconnecter la voix en temps réel',
      subtitle: 'Supprimer la clé API de ce provider de la machine sélectionnée.',
      confirmTitle: 'Déconnecter le provider ?',
      confirmBody: 'Cette action supprime la clé API stockée de la machine d’exécution sélectionnée.',
    },
    unavailable: {
      title: 'Voix en temps réel indisponible',
      rowTitle: 'Impossible de charger les réglages',
      provider: 'La contribution du provider est indisponible ou incompatible.',
      invalid: 'Les réglages enregistrés du provider sont invalides.',
      needs_migration: 'Ces réglages nécessitent une migration prise en charge avant de pouvoir être modifiés.',
      unsupported_version: 'Ces réglages ont été écrits par une version plus récente de Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const fr: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Choisissez un service pour modifier ce réglage.',
      select: ({ choice, control }) => `Sélectionnez ${choice} dans ${control} pour modifier ce réglage.`,
    },
    hub: {
      description: 'Parle à tes agents à voix haute et dicte dans n’importe quel message.',
      modesTitle: 'Deux façons d’utiliser ta voix',
      moreTitle: 'Plus',
      dictationPurpose: 'le micro du champ de saisie transforme ta voix en texte modifiable',
      summarySessionSummaries: 'Résumés de session',
      summaryRecentMessages: ({ count }) => `${count} derniers messages`,
      summaryNothingShared: 'Rien n’est partagé au début d’une conversation',
      summaryRemembers: 'L’agent Voice se souvient des conversations passées',
      summaryForgets: 'L’agent Voice oublie après chaque conversation',
      summaryVoiceComputer: ({ machine }) => `Ordinateur Voice : ${machine}`,
      summaryTranscript: 'transcription pendant la conversation',
    },
    pipeline: {
      hear: 'Écouter',
      think: 'Réfléchir',
      speak: 'Parler',
      write: 'Écrire',
      ready: 'Prêt',
      oneStepNeedsYou: 'Une étape a besoin de toi',
      stepsNeedYou: ({ count }) => `${count} étapes ont besoin de toi`,
      waiting: 'En attente',
      working: 'En cours',
      notChecked: 'Pas encore vérifié',
      off: 'Désactivé · la dictée reste disponible',
      onMachine: ({ machine }) => `Sur ${machine}`,
      onVoiceComputer: 'Sur ton ordinateur Voice',
      inTheCloud: 'Dans le cloud du service, depuis cet appareil',
      inTheSession: 'Son propre agent répond, dans la transcription',
      intoYourMessage: 'Tu le relis avant d’envoyer',
      messageLanguage: ({ language }) => `Langue : ${language}`,
      languageAutomatic: 'automatique',
      onThisDevice: 'Sur cet appareil',
      needsYou: 'A besoin de toi',
      voiceAgentFollowsSession: 'Agent Voice · suit la session',
      theSessionYoureIn: 'La session où tu es',
      intoYourMessageTitle: 'Dans ton message',
    },
    privacy: {
      localAudio: "Votre appareil ou ordinateur Voice",
      localProcessor: "Votre modèle vocal sélectionné",
      localRetention: "Géré par votre appareil ou environnement d’exécution. Les diagnostics suivent vos réglages d’enregistrement.",
      localDisclosure: "Les modèles vocaux sélectionnés s’exécutent sur votre appareil ou ordinateur Voice. L’historique Voice et les enregistrements de diagnostic ont des réglages séparés sur cette page.",
      audioTitle: "Audio envoyé à",
      processorTitle: "Traité par",
      retentionTitle: "Conservation",
      messagesUnit: "messages",
      secondsUnit: "secondes",
      servicePolicy: "Selon les réglages et conditions de votre compte du service.",
      noMicrophoneAudio: "Aucun audio du micro ; texte de réponse uniquement.",
      yourEndpoint: "Votre endpoint configuré",
      endpointOperator: "L’opérateur de votre endpoint",
      endpointPolicy: "Selon la politique de conservation de votre endpoint.",
      deviceAudio: "Le service vocal de votre appareil",
      deviceProcessor: "Votre appareil ou son service vocal",
      devicePolicy: "Selon les réglages et conditions vocales de votre appareil.",
      description: 'Ce que ton service vocal entend et lit, et ce que Happier conserve.',
      whereTitle: 'Où va ta voix en ce moment',
      whereDescription: 'Cela change selon le service choisi.',
      startTitle: 'Au début d’une conversation',
      startDescription: 'Ce que le service vocal peut lire de ton travail.',
      screenTitle: 'Ce qui est à l’écran',
      screenDescription: 'La session ou la page que tu regardes.',
      screenNever: 'Jamais',
      screenWhenAsked: 'Sur demande',
      screenAlways: 'Toujours',
      summariesTitle: 'Résumés de session',
      recentTitle: 'Tes messages récents',
      recentDescription: 'Les derniers messages d’une session, quand il demande du contexte.',
      recentCountTitle: 'Messages à partager',
      recentCountDescription: "",
      recentCountUnavailable: 'Active « Tes messages récents » pour modifier ceci.',
      toolsTitle: 'Noms des outils',
      toolsDescription: 'Par exemple « Fichier modifié ». Les arguments et chemins de fichiers ne sont jamais partagés.',
      permissionsTitle: 'Demandes d’autorisation',
      permissionsDescription: 'Pour qu’il te dise ce qui a besoin de toi. Tu approuves toujours d’un tap.',
      devicesTitle: 'Tes machines et appareils',
      devicesDescription: 'Noms et état en ligne, pour démarrer des sessions là où tu le demandes.',
      liveTitle: 'Pendant que tu parles',
      liveDescription: 'Mises à jour envoyées quand tes sessions changent pendant une conversation.',
      liveActiveTitle: 'De la session où tu es',
      liveOtherTitle: 'De tes autres sessions',
      liveNothing: 'Rien',
      liveActivity: 'Activité',
      liveSummaries: 'Résumés',
      liveMessages: 'Messages',
      livePerUpdateTitle: 'Messages par mise à jour',
      liveIncludeMineTitle: 'Inclure ce que tu as écrit',
      liveIncludeMineDescription: 'Désactivé : seule la part de l’agent est envoyée.',
      liveMessagesUnavailable: 'Choisis « Messages » pour une session ci-dessus pour modifier ceci.',
      liveOtherModeTitle: 'Messages des autres sessions',
      liveOtherModeNever: 'Jamais',
      liveOtherModeWhenAsked: 'Sur demande',
      liveOtherModeAutomatically: 'Automatiquement',
      liveOtherModeUnavailable: 'Choisis « Messages » pour les autres sessions pour modifier ceci.',
      memoryTitle: 'Mémoire de l’agent Voice',
      memoryDescription: 'Uniquement pour la voix locale avec un agent Voice.',
      rememberTitle: 'Se souvenir des conversations passées',
      rememberOnDescription: 'Il reprend là où tu t’es arrêté.',
      rememberOffDescription: 'Désactivé : il oublie tout quand tu raccroches.',
      restoreTitle: 'Restaurer la mémoire par',
      restoreRecent: 'Messages récents',
      restoreSummary: 'Résumé + récents',
      restoreResume: 'Reprise de l’agent',
      restoreUnavailable: 'Active « Se souvenir » pour choisir.',
      restoreResumeFeatureOff: 'La reprise nécessite que l’agent Voice soit activé sur ce serveur.',
      restoreResumeAgentCannot: 'Cet agent ne peut pas reprendre une conversation passée.',
      fallbackTitle: 'Si la reprise échoue, rejouer les messages',
      fallbackDescription: 'Repart de tes messages récents plutôt que de rien.',
      restoreCountTitle: 'Messages à restaurer',
      restoreCountDescription: "",
      forgetTitle: 'Tout oublier maintenant',
      forgetDescription: 'Redémarre l’agent Voice à zéro. Tes sessions ne sont pas touchées.',
      forgetAction: 'Oublier',
      moreTitle: 'Plus',
    },
    dictation: {
      description: 'Le micro du champ de saisie transforme ta voix en texte que tu peux modifier avant d’envoyer.',
      engineTitle: 'Moteur vocal',
      engineDescription: 'Chaque moteur indique où va ton audio.',
      sameAsConversations: 'Comme les conversations vocales',
      sameAsConversationsUses: ({ engine }) => `Utilise ${engine}, comme tes conversations vocales.`,
      languageTitle: 'Langue',
      dictateInTitle: 'Je dicte en',
      dictateInDescription: 'Automatique utilise la langue par défaut du moteur. Elle ne suit pas la langue de tes conversations.',
      pipelinePurpose: 'fonctionne même quand les conversations vocales sont désactivées',
    },
    conversations: {
      description: 'Parle à tes agents à voix haute, les mains sur le clavier ou non.',
      serviceTitle: 'Service',
      serviceDescription: 'Qui t’écoute, réfléchit et parle. Tu peux changer à tout moment ; chacun garde sa configuration.',
      offDescription: 'Pas de conversations vocales. La dictée reste disponible.',
      serviceReady: 'Prêt',
      accountTitle: 'Compte',
      accountDescription: 'C’est le même service dans les deux cas ; seul le payeur change.',
      payWithTitle: 'Payer avec',
      happierBillingUnavailable: "La facturation Happier n’est pas disponible sur ce serveur.",
      turnOnVoiceAgent: "Activer l’agent vocal",
      payWithHappierDescription: 'Inclus dans votre forfait Happier. Aucun compte personnel requis.',
      payWithOwnDescription: 'Vous utilisez votre propre compte et votre clé API pour ce service.',
      runsOn: 'Tourne sur',
      hearTitle: 'Écouter',
      hearDescription: 'Comment ta voix devient du texte avant qu’on y réponde.',
      speechRecognitionTitle: 'Reconnaissance vocale',
      handsFreeUnsupported: 'Le mode mains libres nécessite la reconnaissance vocale de cet appareil ou un modèle vocal Happier.',
      handsFreeTimingUnavailable: 'Active le mode mains libres pour modifier ceci.',
      interruptTitle: 'Interrompre en parlant',
      interruptDescription: 'Parler par-dessus une réponse l’arrête.',
      talkToTitle: 'Parler à',
      talkToSession: 'La session',
      talkToSessionDescription: 'Tu parles dans la session où tu es ; son propre agent répond.',
      talkToAgent: 'Un agent Voice',
      talkToAgentDescription: 'Un agent Voice lit tes sessions et agit pour toi.',
      agentFeatureRequired: ({ feature }) => `Active ${feature} dans Réglages → Fonctionnalités. Les fonctionnalités expérimentales nécessitent aussi l’activation des Expériences.`,
      itMayTitle: 'Il peut',
      itMayReadOnly: 'Lire seulement',
      itMayReadOnlyDescription: 'Il lit tes sessions et fichiers sans rien modifier.',
      itMayAsk: 'Demander d’abord',
      itMayAskDescription: 'Chaque modification te demande d’abord. Un « oui » dit à voix haute n’approuve jamais ; tu touches pour approuver.',
      itMaySafe: 'Modifications sûres',
      itMaySafeDescription: 'Il fait seul les modifications sûres de l’espace de travail et demande pour le reste.',
      itMayAnything: 'Tout',
      itMayAnythingDescription: 'Il peut tout modifier sans te demander d’abord.',
      repliesTitle: 'Réponses',
      repliesShort: 'Courtes',
      repliesBalanced: 'Équilibrées',
      thinkTitle: 'Réfléchir',
      thinkDescription: 'Ce qui arrive à ce que tu dis.',
      advancedAgentTitle: 'Comportement avancé de l’agent',
      advancedAgentDescription: 'Comment l’agent Voice démarre, attend et répond. Les valeurs par défaut conviennent à la plupart.',
      memoryLinkTitle: 'Mémoire et restauration',
      memoryLinkDescription: 'Le souvenir des conversations passées se règle dans Confidentialité et données.',
      speakTitle: 'Parler',
      speakDescription: 'Comment les réponses sont lues à voix haute.',
      voiceEngineTitle: 'Moteur de voix',
      languageTitle: 'Langue',
      languageDescription: 'Ce que chaque langue change pour le service choisi.',
      iSpeakTitle: 'Je parle',
      iSpeakDescription: 'Aide à te comprendre. Automatique la détecte à chaque fois.',
      replyInTitle: 'Répondre en',
      replyInDescription: 'La réponse revient dans cette langue, même si tu changes.',
      replySame: 'Comme je parle',
      iSpeakAutomatic: 'Automatique',
      iSpeakEngineDescription: ({ engine }) => `Aide ${engine} à te comprendre. À régler avec la reconnaissance vocale dans Écouter.`,
      voiceTitle: 'Voix',
      voiceDescription: ({ engine }) => `Fournie par ${engine}, le moteur de Parler.`,
      voiceDefault: 'Par défaut',
      voiceDevice: 'La voix de cet appareil',
      voiceInEngine: 'À régler dans Parler',
      languageServiceDescription: 'La langue dans laquelle ton service vocal répond.',
      languageAutomaticDescription: 'Ton service vocal détecte la langue que tu parles.',
      languageEngineDefault: 'Par défaut du moteur',
      languageCoupledDescription: 'Ton service vocal utilise une seule langue pour écouter et répondre.',
      greetingTitle: 'Salutation',
      greetingOff: 'Non',
      greetingRightAway: 'Tout de suite',
      greetingAfterISpeak: 'Quand je parle',
      greetingOffDescription: 'Il attend que vous parliez en premier.',
      greetingRightAwayDescription: 'Il dit bonjour dès que la conversation commence.',
      greetingAfterISpeakDescription: 'Il vous salue dans sa première réponse.',
      languageManagedDescription: 'Ton service vocal gère sa langue.',
      languageServiceDefault: 'Par défaut du service',
    },
    advanced: {
      description: 'Où tourne la voix, comment elle s’affiche et les modèles vocaux qu’elle utilise.',
      onScreenTitle: 'À l’écran',
      onScreenDescription: 'Comment une conversation en cours apparaît.',
      showLiveAsTitle: 'Afficher Voice en direct comme',
      showLiveAsDescription: 'Sur cet appareil uniquement. La section Voice du Compagnon reste dans tous les modes.',
      scopeTitle: 'Démarrer les conversations avec',
      scopeGlobal: 'Toutes mes sessions',
      scopeGlobalDescription: 'Un seul assistant pour tout.',
      scopeSession: 'La session ouverte',
      scopeSessionDescription: 'Elle démarre dans la session que tu as ouverte.',
      transcriptTitle: 'Afficher la transcription pendant la conversation',
      transcriptDescription: 'Ce que toi et l’agent dites apparaît au fil de la conversation.',
      autoOpenTitle: 'L’ouvrir au début d’une conversation',
      autoOpenDescription: 'Désactivé : ouvre-la toi-même depuis la conversation.',
      autoOpenUnavailable: 'Active « Afficher la transcription » pour choisir.',
      computerTitle: 'Ordinateur Voice',
      speechModelsTitle: 'Modèles vocaux',
      speechModelsNeedComputerTitle: 'Un ordinateur Voice est nécessaire',
      speechModelsNeedComputer: 'Choisissez un ordinateur Voice ci-dessus pour installer et gérer ses modèles vocaux.',
      computerDescription: 'L’ordinateur qui fait tourner les modèles vocaux et se connecte aux comptes liés pour la voix. Partagé entre tes appareils.',
      connectionTitle: 'Connexion',
      timeoutTitle: 'Abandonner une requête vocale après',
      timeoutDescription: "Pour les points de terminaison et les modèles vocaux.",
    },
  },
};

const voiceSettingsPagesTranslations = { fr } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "fr">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'fr': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} parties terminées · ${admitted} admises`, merge: 'Assemblage du parcours…', titleEdited: 'Titre modifié', changed: 'Modifié', moved: 'Déplacé', filesReadUnavailable: 'Progression de lecture des fichiers indisponible' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { fr: { discuss: 'Discuter', message: 'Message', edit: 'Modifier le parcours', title: 'Titre du parcours', stopTitle: 'Titre de l’étape', prose: 'Explication', refine: 'Affiner', instructions: 'Que faut-il changer ?', moveUp: 'Monter', moveDown: 'Descendre', mergeNext: 'Fusionner avec l’étape suivante', addSummary: 'Ajouter un résumé', addCommitPlan: 'Proposer des commits', updated: 'Résultat enregistré mis à jour', conflict: 'Ce parcours a changé ailleurs. Votre brouillon est conservé. Chargez la dernière version et vérifiez-la avant d’enregistrer à nouveau.', reload: 'Charger la dernière version', missingStop: "Cette étape n’est plus dans le dernier parcours. Votre brouillon est conservé ; choisissez une autre étape pour continuer.", applicationLocked: 'Des commits sont en cours d’application. La modification est suspendue.' } } satisfies Pick<Record<string, SavedCopy>, "fr">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { fr: copy({
        title: 'Parcours',
        description: 'Un ordre de lecture rédigé par l’IA, avec des explications à côté des modifications exactes et des propositions de commits facultatives. S’exécute sur la machine qui contient le code.',
        enabled: 'Expliquer les modifications',
        enabledDescription: 'Ajoute un ordre de lecture et des explications à une comparaison. Les fichiers restent accessibles sans modèle.',
        model: 'Modèle de synthèse',
        modelDescription: 'Utilisé pour les explications, les parcours et les propositions de commits.',
        chooseModel: 'Choisir un modèle',
        searchModels: 'Rechercher des modèles',
        unsupported: 'Ne peut pas rédiger de parcours',
        unavailable: 'Modèle indisponible. Choisissez-en un autre.',
        prefetch: 'Préparer après chaque tour',
        prefetchDescription: 'Prépare un parcours lorsque l’agent termine un tour.',
        saved: 'Parcours enregistrés',
        savedDescription: 'Enregistrés sur cette machine, avec vos modifications.',
        clear: 'Effacer',
        unavailableData: 'Reconnectez la machine pour charger les parcours enregistrés et les coûts.',
        costUnavailable: '7 derniers jours · coût indisponible',
        clearTitle: 'Effacer les parcours enregistrés ?',
        clearDescription: ({ machine }) => `Supprime les parcours enregistrés et vos modifications manuelles sur ${machine}, ainsi que vos marques de révision pour ces comparaisons. Les autres machines ne sont pas concernées.`,
        savedCount: ({ count, bytes }) => `${count} enregistrés · ${bytes}`,
        cost: ({ amount, partial }) => `7 derniers jours · ${amount}${partial ? ' · certains coûts sont indisponibles' : ''}`,
        clearFailed: 'Certains parcours n’ont pas pu être effacés. Rechargez et réessayez.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { fr: { walkthroughStart: { start: 'Démarrer le parcours', ended: 'Cette conversation n’est pas disponible ici. Le parcours reste disponible.', newConversation: 'Démarrer une nouvelle conversation', askSession: 'Interroger l’agent de la session', unavailable: 'Connectez la machine et choisissez un modèle produisant une sortie structurée.', updated: 'Parcours mis à jour' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { fr: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.fr,
            progress: walkthroughProgressTranslations.fr,
            eyebrow: 'Parcours',
            generated: 'Généré',
            generatedBy: ({ model }) => `Généré · ${model}`,
            generatedA11y: 'Écrit par un modèle',
            readingChanges: 'Lecture des modifications…',
            modelFallback: 'Le modèle',
            analysisAll: ({ who, count }) => `${who} a lu les ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} a lu ${analysed} sur ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} a lu ${analysed} sur ${total} avant de s’arrêter`,
            unavailableCount: ({ count }) => `${count} indisponibles`,
            youReviewed: ({ count, total }) => `Vous avez relu ${count} sur ${total}`,
            contents: 'Sommaire',
            reviewedOfTotal: ({ count, total }) => `${count} sur ${total} relues`,
            boardReadProgress: ({ count, total }) => `${count} sur ${total} lues`,
            stopOf: ({ number, total }) => `${number} sur ${total}`,
            stopA11y: ({ number, title }) => `Étape ${number} : ${title}`,
            stopReviewedA11y: ({ number }) => `Étape ${number}, relue`,
            importance: { start: 'Commencer ici', high: 'À lire attentivement', low: 'En diagonale' },
            markReviewed: 'Marquer comme relue',
            reviewed: 'Relue',
            markReviewedA11y: 'Marquer cette étape comme relue',
            unmarkReviewedA11y: 'Relue. Appuyer pour retirer votre marque',
            askAboutThis: 'Poser une question',
            askAboutStopA11y: 'Poser une question sur cette étape',
            openConversation: 'Ouvrir la conversation du parcours',
            andIn: ({ file }) => `et dans ${file}`,
            newFile: 'Nouveau fichier',
            deletedFile: 'Supprimé',
            openInFiles: ({ file }) => `Ouvrir ${file} dans Fichiers`,
            otherChanges: 'Autres modifications',
            otherChangesDescription: 'Hors de l’histoire, mais toujours là. Ouvrez-les comme un diff normal.',
            otherChangesCue: 'Mécaniques, affichées en diffs',
            keys: { move: 'naviguer', reviewed: 'relue', ask: 'demander' },
            overview: 'Vue d’ensemble',
            codeMapOf: ({ count }) => `Carte du code de ${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
            codeMapHint: 'pointez une étape pour entourer ses fichiers',
            touchesOutlined: 'touche les fichiers entourés',
            showOverviewA11y: ({ count }) => `Afficher la vue d’ensemble : une carte du code de ${count} fichiers`,
            inventory: { title: 'Tout ce que contient cette comparaison · déjà disponible dans Fichiers', read: 'Lu', reading: 'En lecture', unavailable: 'Indisponible' },
            arriving: 'Les étapes suivantes apparaîtront ici au fur et à mesure.',
            previousStop: 'Étape précédente',
            nextStop: 'Étape suivante',
            done: 'Terminé',
            evidence: { displayFailed: 'Le code enregistré n’a pas pu être affiché. Le fichier reste dans Fichiers.', binary: 'Fichier binaire, décrit d’après ses métadonnées. Affiché, non analysé.', unavailable: ({ reason }) => `Illisible (${reason}). Il reste dans la liste ; rien ici n’affirme qu’il a été relu.` },
            notice: {
                stale: 'Des fichiers ont changé après la rédaction',
                refresh: 'Actualiser le parcours',
                failed: ({ reason }) => `Rédaction interrompue · ${reason}`,
                failedGeneric: 'Rédaction interrompue',
                tryAgain: 'Réessayer',
                chooseModel: 'Choisir un modèle',
                cancelled: 'La rédaction a été arrêtée. Ce qui est écrit reste.',
                rest: 'La suite n’a pas été écrite. Tous les fichiers sont dans Fichiers ; rien n’a été omis en silence.',
                offline: ({ machine, time }) => `${machine} est hors ligne · parcours et code de ${time}. Les questions et l’actualisation reviennent à la reconnexion.`,
                offlineA11y: 'Nécessite la machine, qui est hors ligne',
                incomplete: 'Certaines modifications n’ont pas pu être listées. Ce qui est ici est exact ; rien ne prétend être complet.',
                undo: 'Annuler',
            },
            none: { title: 'Pas encore de parcours', reason: 'Un parcours lit ces modifications dans l’ordre et explique chacune à côté de son code exact. Tous les fichiers sont déjà dans Fichiers.', showFiles: 'Afficher les fichiers' },
            explain: { notInStory: 'Hors de l’histoire', readInWalkthrough: 'Lire dans le parcours' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { fr: {
        added: 'Ajouté',
        boardTitle: 'Ajouter au tableau',
        boardHint: 'Tout le monde ici voit ce que vous ajoutez',
        companionTitle: 'Ajouter au Compagnon',
        companionHint: 'Vous seul voyez votre Compagnon',
        searchWidgets: 'Rechercher des widgets',
        searchCompanion: 'Rechercher aperçus et panneaux',
        makeOne: 'En créer un',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Trouver d’autres widgets',
        findMoreSubtitle: 'Plugins',
        askTitle: 'Demander un widget à l’agent',
        askNote: 'Rédigé dans la zone de saisie ; rien n’est envoyé avant vous.',
        glances: 'Aperçus',
        glancesHint: 'en direct, intégrés ou issus de plugins',
        onBoard: 'Sur ce tableau',
        onBoardHint: 'partagé avec tout le monde ici',
        panes: 'Panneaux',
        panesHint: 'ajouté comme un lien qui s’ouvre dans Détails',
        builtIn: 'Intégré',
        nativeDescriptions: {
            session_summary: 'Activité et prochaines étapes de la session choisie.',
            agent_plan: 'Suivez le plan de l’agent pour la session choisie.',
            changes: 'Consultez les modifications de fichiers de la session choisie.',
            local_services: 'Ouvrez les services locaux de la session choisie.',
        },
        noMatch: ({ query }) => `Aucun widget ne correspond à « ${query} »`,
        pickTitle: 'Choisissez un widget pour l’afficher ici',
        pickHint: 'Il affiche vos propres données, à la taille choisie, avant que rien ne soit ajouté.',
        pickNote: 'Choisissez un widget pour l’ajouter',
        askAction: 'Rédiger la demande',
        pluginTag: 'plugin',
        pluginProvenance: ({ plugin }) => `Plugin ${plugin}`,
        readsChosenSession: 'lit la session choisie, là où elle s’exécute',
        readsFrom: ({ source }) => `lit ${source}`,
        savedQueryOn: ({ source }) => `une requête enregistrée sur ${source}`,
        madeByYou: ({ date }) => `créé par vous le ${date}`,
        madeByAgent: ({ date }) => `créé par votre agent le ${date}`,
        madeByPlugin: ({ date }) => `créé par un plugin le ${date}`,
        previewLiveData: 'En direct, avec vos données',
        addsAtSize: ({ size }) => `Ajouté en taille ${size}. Vous pourrez la changer plus tard.`,
        backToWidgets: 'Widgets',
        editTitle: ({ widget }) => `${widget} · entrées`,
        editHint: 'Seule cette copie change. Les autres gardent leurs entrées.',
        preview: 'Aperçu',
        previewLive: 'Aperçu · en direct',
        previewWaiting: ({ field }) => `Choisissez ${field} pour l’afficher ici`,
        listOnePerLine: "Un par ligne",
        listCommaSeparated: "Séparés par des virgules",
        previewAfterAdd: 'Il s’affichera une fois ajouté',
        needed: 'Requis',
        stillNeeded: ({ field }) => `Il manque encore ${field}`,
        followGroup: 'Suivre',
        pinGroup: 'Ou en épingler un',
        another: 'Autre…',
        anotherSubtitle: 'Rechercher tout ce à quoi vous avez accès',
        searchChoices: ({ field }) => `Rechercher ${field}`,
        noChoices: 'Rien à choisir pour le moment',
        optionsLoading: 'Chargement des choix…',
        optionsFailed: 'Impossible de charger les choix',
        invalidValue: 'introuvable',
        inputsInvalid: 'Vérifiez les entrées de ce widget',
        inputsUnavailable: 'Une entrée sélectionnée est indisponible',
        connectionNeeded: ({ field }) => `Connectez votre ${field}`,
        sessionDenied: ({ session }) => `Vous n’avez plus accès à ${session}`,
        sessionUnavailable: ({ session }) => `${session} est indisponible ou a été supprimée`,
        typeUnavailable: ({ field }) => `Le type de ${field} n’est plus disponible`,
        inputUnavailable: ({ field }) => `${field} est indisponible`,
        selectedInputUnavailable: ({ field, value }) => `${field} : ${value} n’est plus disponible`,
        invalidReason: 'Vous n’y avez plus accès, ou il a été supprimé.',
        viewerOnly: 'Chacun ici le voit avec sa propre connexion.',
        justAdded: ({ widget }) => `${widget} ajouté`,
        saved: ({ widget }) => `${widget} enregistré`,
        addFailed: 'Impossible de l’ajouter. Réessayez.',
        saveFailed: 'Impossible d’enregistrer. Réessayez.',
        homeTitle: 'Ajouter à l’accueil',
        homeHint: 'Vous seul voyez votre accueil · sur tous vos appareils',
        addWidgets: 'Ajouter des widgets',
        addToHome: 'Ajouter à l’accueil',
        addToBoard: 'Ajouter au tableau',
        addToCompanion: 'Ajouter au compagnon',
        editInputs: 'Modifier les entrées…',
        width: 'Largeur',
        size: 'Taille',
        sizes: { small: 'Petit', medium: 'Moyen', wide: 'Large', full: 'Complet', tall: 'Haut', large: 'Grand' },
        widthHalf: 'Moitié',
        widthFull: 'Pleine',
        thisSession: 'Cette session',
        choicesCount: ({ count }) => count === 1 ? '1 choix' : `${count} choix`,
        countOnHome: ({ count }) => `${count} sur l’accueil`,
        countOnBoard: ({ count }) => `${count} sur le tableau`,
        countInCompanion: ({ count }) => `${count} dans le compagnon`,
        thisPage: 'Cette page',
        thisProject: 'Ce projet',
        thisCheckout: 'Cette copie de travail',
        areaPinned: 'Épinglés',
        areaPinnedMeta: 'vos widgets sur cette page',
        areaProjectTitle: 'Widgets',
        areaProjectMeta: 'les vôtres',
        areaAdd: ({ surface }) => `Ajouter un widget à ${surface}`,
        areaAddTo: ({ surface }) => `Ajouter à ${surface}`,
        areaHint: 'Vous seul voyez ces widgets',
        countHere: ({ count }) => count === 1 ? '1 ici' : `${count} ici`,
        areaEmptyTitle: 'Rien d’épinglé pour l’instant',
        areaEmptyReason: 'Épinglez un widget pour le garder ici, rien que pour vous.',
        areaEmptyAction: 'Ajouter un widget',
        areaUnavailableTitle: 'Les widgets ne peuvent pas se charger ici',
        projectSourceUnavailableTitle: 'Les widgets apparaîtront ici dès que le dépôt de ce projet sera connu',
        areaWriteFailed: 'Impossible d’enregistrer cette modification',
        areaApprovalPending: 'En attente d’approbation',
        valueNotFound: ({ value }) => `${value} est introuvable`,
        chooseAnother: ({ field }) => `Choisir une autre valeur pour ${field}`,
        chooseField: ({ field }) => `Choisir ${field}`,
        widgetOptions: 'Options du widget',
        moveTo: 'Déplacer…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "fr">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { fr: {
        yourWidgets: "Vos widgets",
        yourWidgetsHint: "créés par vous ou vos agents",
        yourWidget: "Votre widget",
        moreInSource: "La source contient plus que ce qui est affiché.",
        notCurrent: "Pas à jour",
        aboutMenu: "À propos de ce widget",
        aboutTitle: "À propos de ce widget",
        aboutUnavailable: "Impossible d’ouvrir ce widget pour le moment.",
        aboutData: "Données",
        aboutReads: "Lit",
        aboutInputs: "Entrées",
        aboutRefresh: "Actualisation",
        aboutUsedIn: "Utilisé dans",
        savedFromSession: ({ session }) => `Enregistré depuis ${session}`,
        aSession: "une session",
        madeInYourAccount: "Créé dans votre compte",
        edited: ({ time }) => `modifié ${time}`,
        readsOnly: "Lecture seule",
        runsOn: ({ machine }) => `s’exécute sur ${machine}`,
        withYourConnection: "avec votre propre connexion",
        readsResource: ({ read, plugin }) => `${read} depuis ${plugin}`,
        cannotRunAnythingElse: "Le widget ne peut rien exécuter d’autre.",
        inputsThisCopy: "Pour cette copie seulement",
        refreshWhenOpen: "À l’ouverture",
        refreshNow: "Actualiser maintenant",
        refreshing: "Actualisation…",
        refreshed: "Actualisé",
        refreshFailed: "Échec de l’actualisation. Les derniers chiffres restent affichés.",
        placedOnHome: "Accueil",
        placedOnBoard: ({ board }) => `Tableau ${board}`,
        placedOnABoard: "Un tableau",
        placedInASession: "Une session",
        placedInAProject: "Un projet",
        placedOnAPluginPage: "Une page de plugin",
        placedOnACorePage: "Une page de l’application",
        notPlacedYet: "Placé nulle part pour l’instant",
        otherPlacesNotListed: "Les emplacements sur d’autres appareils ou surfaces partagées ne sont pas listés ici.",
        editsChangeAll: ({ count }) => `Modifier le widget change les ${count}`,
        editsChangeEverywhere: "Modifier le widget le change partout où il est utilisé",
        changeWithAgent: "Modifier avec l’agent",
        changeDraft: ({ widget }) => `Modifie le widget « ${widget} » pour que `,
        duplicate: "Dupliquer",
        duplicated: ({ name }) => `Copie « ${name} » enregistrée dans Vos widgets`,
        duplicateFailed: "Impossible de faire une copie. Réessayez.",
        deleteSavedGroupNote: "Seul le groupe enregistré est supprimé. Les copies déjà ajoutées restent à leur place.",
        saveMenu: "Enregistrer comme votre widget…",
        saveMenuSubtitle: "Une copie pour l’accueil et vos tableaux",
        saveTitle: "Enregistrer comme votre widget",
        saveHint: "Une copie à placer sur l’accueil, vos tableaux et projets. Cette session garde la sienne.",
        saveNote: "Enregistré dans votre compte · vous seul",
        saveWidget: "Enregistrer le widget",
        saveFailed: "Impossible d’enregistrer le widget. Réessayez.",
        savedButNotPlaced: "Enregistré dans Vos widgets, mais pas ajouté partout où vous l’avez choisi.",
        savedAsYours: ({ name }) => `« ${name} » enregistré dans Vos widgets`,
        name: "Nom",
        nameNeeded: "Donnez-lui un nom",
        becomesViewerInput: "Devient une entrée : chaque emplacement utilise votre connexion",
        becomesContextInput: "Devient une entrée : chaque emplacement choisit la sienne",
        alsoAddTo: "Ajouter aussi à",
        alsoAddToNamed: ({ place }) => `Ajouter aussi à ${place}`,
        snapshotMenu: "Publier un instantané sur ce tableau…",
        snapshotMenuSubtitle: "Tout le monde ici voit vos chiffres actuels",
        snapshotTitle: "Publier un instantané pour tout le monde ?",
        snapshotHint: ({ widget, time }) => `Toute personne pouvant ouvrir cette session verra ${widget} à ${time}. Il ne sera pas mis à jour et votre connexion reste la vôtre.`,
        postSnapshot: "Publier l’instantané",
        snapshotNotCurrent: "Le widget récupère encore des chiffres à jour. Réessayez quand il les aura.",
        snapshotFailed: "Impossible de publier l’instantané. Rien n’a été partagé.",
        snapshotAwaitingApproval: "En attente d’approbation dans votre boîte. Rien n’est partagé avant l’approbation.",
        snapshotPosted: "Instantané publié",
        snapshotNote: "Une copie de ces chiffres. Elle n’est pas mise à jour.",
        asOf: ({ time }) => `à ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "fr">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { fr: {
        styleCard: 'Carte',
        stylePlain: 'Simple',
        surfaceHome: 'Accueil',
        surfaceBoard: 'Tableau',
        surfaceCompanion: 'Compagnon',
        showFrame: 'Afficher le cadre',
        hideFrame: 'Masquer le cadre',
        thisWidgetOnly: 'Ce widget uniquement',
        surfaceUses: ({ surface, style }) => `${surface} utilise ${style}`,
        useSurfaceDefault: ({ surface }) => `Utiliser le réglage de ${surface}`,
        likeTheOthers: ({ style }) => `${style}, comme les autres`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'Comment les widgets sont encadrés sur cet appareil. Pour en changer un seul, utilisez son menu ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Cadre modifié',
        newChip: 'Nouveau',
        groupInputs: "Entrées…",
        groupWidth: "Largeur",
        widthHalf: "Moitié",
        widthFull: "Pleine",
        groupFrame: "Cadre",
        groupDividers: "Séparateurs",
        dividersLines: "Lignes",
        dividersNone: "Aucun",
        groupSave: "Enregistrer le groupe…",
        groupSaveSubtitle: "Le garder dans Vos widgets, pour l’ajouter partout",
        ungroup: "Dissocier",
        ungroupSubtitle: ({ count }) => count === 1 ? 'Son widget reste ici, sur sa propre carte' : `Ses ${count} widgets restent ici, chacun sur sa carte`,
        groupRemove: "Supprimer le groupe et ses widgets",
        moveToGroup: "Déplacer dans un groupe",
        removeFromGroup: "Retirer du groupe",
        removeFromGroupSubtitle: "De nouveau sur sa propre carte, à côté du groupe",
        groupWith: "Grouper avec…",
        groupWithNew: "Un nouveau groupe des deux",
        groupSlot: "Déposez un widget ici ou",
        groupSlotAdd: "ajoutez-en un",
        groupUntitled: "Groupe sans titre",
        groupName: "Nom du groupe",
        groupMenu: "Options du groupe",
        followingGroup: "Suit le groupe",
        followingGroupValue: ({ value }) => `Suit le groupe · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · entrées`,
        groupInputsHint: "À définir une fois. Les widgets qui suivent le groupe l’utilisent.",
        groupFollowCount: ({ following, count }) => `${following} widgets sur ${count} suivent le groupe`,
        groupFollows: "Suit",
        groupOwnValue: "Sa propre valeur",
        groupGrantsNothing: "Le groupe n’accorde rien : chaque widget vérifie toujours son propre accès.",
        groupSaved: ({ name }) => `${name} est dans Vos widgets`,
        groupSaveFailed: "Impossible d’enregistrer le groupe. Réessayez.",
        moveIntoGroupNamed: ({ group }) => `Déplacer dans ${group}`,
        intoGroupAbove: ({ target }) => `Au-dessus de ${target} · affiché sans cadre dans le groupe`,
        intoGroupBelow: ({ target }) => `En dessous de ${target} · affiché sans cadre dans le groupe`,
        intoGroupEnd: "Affiché sans cadre dans le groupe",
        reorderInGroupDetail: "Ordre uniquement",
        outOfGroupDetail: ({ group }) => `Hors de ${group} · retrouve sa propre carte`,
        wholeGroupDetail: ({ count }) => count === 1 ? `Son widget se déplace avec lui` : `Ses ${count} widgets se déplacent avec lui`,
        cantPutInGroup: ({ group }) => `Impossible de le mettre dans ${group}`,
        groupRefusedWidth: "Il lui faut toute la largeur et ce groupe est à moitié. Déposez-le à côté, ou passez le groupe en pleine largeur.",
        groupRefusedNesting: "Un groupe ne peut pas aller dans un groupe. Déposez-le au-dessus ou en dessous, ou dissociez-le d’abord.",
        groupNeedsFullWidth: ({ widget }) => `${widget} a besoin de toute la largeur`,
        groupFacts: ({ width, count }) => `${width} · ${count} widgets`,
        groupCannotTake: ({ group }) => `Il faut toute la largeur ; ${group} est à moitié`,
        groupA11y: ({ name }) => `Groupe : ${name}`,
        groupCount: ({ count }) => `Groupe · ${count}`,
        groupWidgetCount: ({ count }) => count === 1 ? 'Groupe · 1 widget' : `Groupe · ${count} widgets`,
        addsAtWidth: ({ width }) => `L’ajoute en largeur ${width}.`,
        presetEdited: "Modifié",
        presetEditedTail: ({ changes }) => changes ? ` est à vous maintenant : vous avez ${changes}. Le modèle est conservé.` : ' est à vous maintenant. Le modèle est conservé.',
        presetChangeList: ({ first, second, more }) => more > 0 ? `${first}, ${second} et fait ${more} ${more === 1 ? 'autre modification' : 'autres modifications'}` : second ? `${first} et ${second}` : first,
        presetMovedUp: ({ item }) => `monté ${item}`,
        presetMovedDown: ({ item }) => `descendu ${item}`,
        presetAdded: ({ item }) => `ajouté ${item}`,
        presetRemoved: ({ item }) => `retiré ${item}`,
        presetChanged: ({ item }) => `modifié ${item}`,
        presetRenamed: "changé son nom",
        groupProvenance: ({ origin, date, count }) => ['Votre groupe', origin && date ? `enregistré depuis ${origin} le ${date}` : date ? `enregistré le ${date}` : origin ? `enregistré depuis ${origin}` : null, count === 1 ? '1 widget' : `${count} widgets`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `Ajoute ${name} avec ${count === 1 ? 'son widget' : `ses ${count} widgets`}${value ? `, en suivant ${value}` : ''}`,
        groupInputAskedOnce: ({ count }) => count === 1 ? 'Demandé une fois. Son widget le suit.' : `Demandé une fois. Les ${count} widgets le suivent.`,
        presetReset: "Revenir au modèle",
        presetResetDone: ({ name }) => `${name} est revenu à son modèle`,
        presetResetFailed: "Impossible de revenir au modèle.",
        undo: "Annuler",
        groupAddTo: "Ajouter à…",
        groupAddToSubtitle: "Une copie sur un autre accueil ou projet",
        groupCopied: ({ name, place }) => `${name} copié dans ${place}`,
        groupCopyFailed: "Impossible de copier le groupe. Réessayez.",
        groupSaveTitle: "Enregistrer le groupe",
        groupSaveHint: ({ count }) => `Le garder dans Vos widgets, avec ses ${count} widgets, pour l’ajouter partout.`,
        groupSaveNote: "Une copie : ce groupe reste tel quel.",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "fr">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { fr: {
        changesTitle: 'Modifications',
        localServicesTitle: 'Services locaux',
        changesSource: 'Git',
        reviewChanges: 'Voir les modifications',
        notARepo: 'Le dossier de cette session n’est pas un dépôt Git.',
        noChanges: 'Aucune modification pour l’instant. Les fichiers modifiés par l’agent apparaîtront ici.',
        changesLoading: 'Chargement des modifications',
        running: 'En cours',
        notRunning: 'Arrêté',
        nothingRunning: 'Rien ne tourne. Les services lancés par cette session apparaîtront ici.',
        servicesLoading: 'Chargement des services locaux',
        servicesReadFailed: 'Impossible de lire les services locaux. Réessayez.',
        noMachine: 'Cette session n’a pas de machine à interroger.',
        changedCount: ({ count }) => `${count} modifiés`,
        moreFiles: ({ count }) => (count === 1 ? '1 autre fichier' : `${count} autres fichiers`),
        runningCount: ({ count }) => `${count} en cours`,
        openInBrowser: ({ name }) => `Ouvrir ${name} dans le navigateur`,
        paneLinkA11y: ({ pane }) => `${pane}. S’ouvre à côté de la conversation`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "fr">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const fr: WorkStatusTranslations = {
    buckets: {
        needs_you: 'A besoin de vous',
        working: 'En cours',
        finished: 'Terminé',
        idle: 'Inactif',
        offline: 'Hors ligne',
    },
};

const workStatusTranslations = { fr: { ...fr, task: { stopped: 'Arrêtée', linkFailed: 'La session a été créée, mais son lien avec la tâche n’a pas été enregistré. Réessayez pour lier la même session.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "fr"> = { fr: {
        host: "Happier",
        structure: "Structure",
        callWebhook: "Appeler un webhook",
        runCommand: "Exécuter une commande",
        commandValuesInEnv: "Passez les valeurs du workflow par les variables d’environnement. Le texte de la commande reste tel que vous l’avez écrit.",
        waitForWork: "Attendre le travail",
        waitForWorkDescription: "Attendre que le travail choisi atteigne l’état demandé",
        callWebhookDescription: "Envoyer une requête à une adresse web. Aucun tour d’agent.",
        runCommandDescription: "Exécuter une commande shell sur ta machine. Aucun tour d’agent.",
        artifactCreate: "Créer un document",
        artifactGet: "Lire un document",
        artifactList: "Lister les documents",
        artifactUpdate: "Mettre à jour un document",
        artifactDelete: "Supprimer un document",
        artifactPublish: "Publier un fichier",
        artifactRevisions: "Lister les versions d’un document",
        artifactRestore: "Restaurer une version d’un document",
        artifactUsage: "Consulter le stockage des documents",
        artifactShare: "Partager un document par lien",
        artifactLinks: "Lister les liens d’un document",
        artifactRevoke: "Révoquer un lien de document",
        artifactAudit: "Consulter l’activité des liens de document",
        sessionRole: "Définir le rôle d’une session",
        sessionRoleOverride: "Modifier les paramètres de rôle d’une session",
        sessionRoleClear: "Réinitialiser les paramètres de rôle d’une session",
        sessionRoleAdd: "Ajouter un rôle de session",
        sessionRoleRemove: "Retirer un rôle de session",
        sessionNotes: "Définir les notes de session",
        sessionRolesApply: "Appliquer les rôles aux sessions subordonnées",
        roleList: "Lister les rôles",
        roleGet: "Lire un rôle",
        roleCreate: "Créer un rôle",
        roleUpdate: "Mettre à jour un rôle",
        roleDelete: "Supprimer un rôle",
        roleOverride: "Modifier les paramètres de rôle",
        roleReset: "Réinitialiser les paramètres de rôle",
        widgetCatalog: "Lister les widgets disponibles",
        widgetInstances: "Lister les widgets placés",
        widgetAdd: "Ajouter un widget",
        widgetRemove: "Retirer un widget",
        widgetMove: "Déplacer un widget",
        widgetRename: "Renommer un widget",
        widgetSize: "Définir la taille d’un widget",
        widgetFrame: "Définir le cadre d’un widget",
        widgetInputs: "Lire les entrées d’un widget",
        widgetValidate: "Vérifier les entrées d’un widget",
        widgetSetInputs: "Définir les entrées d’un widget",
        widgetResetInputs: "Réinitialiser les entrées d’un widget",
        widgetLayout: "Lire la disposition des widgets",
        widgetUpdateLayout: "Modifier la disposition des widgets",
        widgetDefinitions: "Lister les widgets enregistrés",
        widgetDefinition: "Lire un widget enregistré",
        widgetCreate: "Créer un widget",
        widgetUpdate: "Mettre à jour un widget enregistré",
        widgetDuplicate: "Dupliquer un widget enregistré",
        widgetDelete: "Supprimer un widget enregistré",
        widgetSave: "Enregistrer un widget de session",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { fr: { repeatable: 'Rendre réutilisable', repeatableDescription: 'Demandez à l’agent de transformer ce qui a fonctionné ici en workflow réutilisable.', repeatablePrompt: 'Transforme ce que nous avons fait ici en workflow que je peux relancer. Conçois-le, vérifie-le avec workflow.validate et enregistre-le, mais ne l’exécute pas.', repeatableMessagePrompt: 'Transforme ce que nous avons fait dans ce message en workflow que je peux relancer. Conçois-le, vérifie-le avec workflow.validate et enregistre-le, mais ne l’exécute pas.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "fr"> = { fr: { ...repeatable.fr, create: 'Créer avec un agent', edit: 'Modifier avec un agent', agent: 'Agent', description: 'Une nouvelle session conçoit le workflow avec vous, le vérifie et l’enregistre. Rien ne s’exécute avant Exécuter maintenant.', changedByAgent: 'Modifié par l’agent', saved: 'Enregistré par l’agent à l’instant', savedAge: ({ age }) => `Enregistré par l’agent ${age}`, savedWorkflow: ({ name }) => `Workflow enregistré · ${name}`, updated: 'Workflow mis à jour', changed: ({ count }) => `Workflow mis à jour · ${count} étapes modifiées`, openEditor: 'Ouvrir dans l’éditeur', openSession: 'Ouvrir dans Sessions', createPrompt: 'Conçois un workflow avec moi, vérifie-le avec workflow.validate, puis enregistre-le. Ne l’exécute pas.', createLead: 'Aide-moi à créer un workflow qui ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `Le workflow enregistré « ${name} » a l’id ${definitionId} et la révision : en-tête ${headerVersion}, corps ${bodyVersion}. Modifie-le avec workflow.definition.edit et utilise workflow.definition.update seulement pour le remplacer entièrement. Vérifie-le avec workflow.validate avant d’enregistrer. Ne l’exécute pas.`, editLead: ({ name }) => `Aide-moi à modifier ${name} : ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const fr: WorkflowBuiltinTranslations = {
    keepGoing: { title: 'Continuer jusqu’au bout', description: 'Continue jusqu’à atteindre l’objectif' },
    reviewAndConverge: { title: 'Relire et converger', description: 'Réviser jusqu’à l’accord des relecteurs', apply: 'Appliquer', verifyAndFix: 'Vérifier et corriger', verifyOnly: 'Vérifier uniquement', rounds: 'Tours avant l’arrêt' },
    planWithAPanel: { title: 'Planifier avec un panel', description: 'Plusieurs agents planifient côte à côte, puis le plan attend votre relecture.', inputs: { request: 'Demande', requestPlaceholder: 'Que doit planifier le panel ?', engines: 'Planificateurs' } },
    openAPullRequest: { title: 'Ouvrir une pull request', description: 'Demande un second avis, puis ouvre une pull request. Si le second avis n’est pas d’accord, il vous attend.', inputs: { base: 'Branche de base', title: 'Titre de la pull request', body: 'Description', question: 'Question pour le second avis' } },
};

const workflowBuiltinTranslations = { fr } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { fr: {
        sessionId: "Session",
        triggerId: "Déclencheur",
        engineIds: "Réviseurs",
        backendTargetKeys: "Planificateurs",
        reviewCommentAuthorIntent: "Constats",
        commentId: "Constat",
        expectedServerRevision: "Version du constat",
        clientMutationId: "Mise à jour",
        projectId: "Projet",
        workspace: "Espace de travail",
        toState: "État",
        expectedState: "État actuel",
        disposition: "Importance",
        allPages: "Tous les constats",
        permissionMode: "Autorisations",
        target: "Exécution dans",
        cwd: "Dossier de travail",
        maxRounds: "Nombre maximal de tours",
        strikes: "Vérifications sans progrès",
        secondOpinion: "Second avis",
        useJudge: "Arbitre",
        diffFingerprint: "Modifications examinées",
        url: "URL",
        body: "Corps JSON",
        command: "Commande",
        env: "Variables d’environnement",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const fr: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.fr,
    blocks: {
        actionSub: 'Action · aucun tour d’agent',
        notSet: 'Non défini',
        set: 'Définir',
        clear: 'Effacer',
        required: 'Obligatoire',
        noFields: 'Rien à définir pour cette action.',
        workflowSub: 'Exécute un autre workflow · ses étapes apparaissent dans cette exécution',
        builtin: 'Intégré',
        waitTitle: 'Vous attendre',
        waitSub: 'Cette voie attend que vous continuiez',
        waitSubRoot: 'Ce flux de travail attend que tu continues.',
        waitPlaceholder: 'Que devez-vous vérifier ou décider ici ?',
        returnsText: 'Renvoie du texte',
        returnsFields: ({ fields }) => `Renvoie ${fields}`,
        workflowDefaults: 'Réglages du flux de travail',
        addNamedResults: 'Ajouter des résultats nommés',
        menuRun: 'Exécuter un workflow',
        menuAction: 'Action',
        menuWait: 'Vous attendre',
        actionSearch: 'Rechercher des actions',
        workflowSearch: 'Rechercher des workflows',
        libraryGroup: 'Vos workflows',
        noAgentTurn: 'Notifier, examiner, publier — sans tour d’agent',
        agentSub: 'Une instruction pour un agent',
        parallelSub: 'Des branches qui s’exécutent en même temps',
        loopSub: 'Pour chaque élément, plusieurs fois ou jusqu’à…',
        ifSub: 'Seulement lorsqu’un résultat le demande',
        actionSourcePhone: 'Votre téléphone',
        actionSourceReview: 'Moteurs de revue',
        useNumber: 'Utiliser un nombre',
        actionUnavailable: ({ action }: { action: string }) => `${action} n’est pas disponible ici.`,
        childInputs: ({ workflow }: { workflow: string }) => `Les entrées viennent de ${workflow}.`,
        retryLoading: "Réessayer le chargement",
        openWorkflow: ({ workflow }) => `Ouvrir ${workflow}`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} exécute ce workflow, il ne peut donc pas s’exécuter dedans.`,
        maxFromInput: ({ name }: { name: string }) => `Depuis l’entrée · ${name}`,
        useInput: ({ name }: { name: string }) => `Utiliser l’entrée ${name}`,
    },
    backToRun: 'Retour à l’exécution',
    reviewedCopyTitle: 'Vérifier avant d’enregistrer',
    reviewedCopyBody: 'Ceci est une copie d’une exécution. Seuls les étapes et réglages sont enregistrés, pas l’historique ni les résultats. Le lieu, le mode d’exécution et les valeurs saisies restent propres à l’exécution. Vérifiez les références aux sessions existantes, dossiers, profils, modèles, services et serveurs MCP avant de les réutiliser.',
    chromeTitle: 'Workflow',
    untitled: 'Workflow sans titre',
    nameLabel: 'Nom du workflow',
    descriptionPlaceholder: 'Ajouter une description',
    descriptionLabel: 'Description',
    save: 'Enregistrer',
    flow: 'Flux',
    flowSubtitle: 'Ce brouillon sous forme de carte',
    settings: 'Réglages du workflow',
    settingsSubtitle: 'Chaque étape les utilise sauf si elle les change.',
    deleteWorkflow: 'Supprimer le workflow',
    deleteBody: 'Les exécutions passées sont conservées.',
    discardChangesBody: 'Revient à la dernière version enregistrée. Annuler rétablit vos modifications.',
    deleteFailedTitle: 'Impossible de supprimer le workflow',
    changedForStep: 'Modifié pour cette étape',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 point à corriger avant de pouvoir exécuter' : `${count} points à corriger avant de pouvoir exécuter`),
    readyToRun: 'Prêt',
    saveStatus: {
        notSaved: 'Pas encore enregistré',
        unsaved: 'Modifications non enregistrées',
        saving: 'Enregistrement…',
        saved: 'Enregistré',
        savedJustNow: 'Enregistré à l’instant',
        savedAge: ({ age }: { age: string }) => `Enregistré ${age}`,
        failed: 'Impossible d’enregistrer',
        yourEdits: 'Vos modifications',
        newerVersion: 'La version plus récente',
        newerVersionRevision: ({ revision }: { revision: string }) => `La version plus récente · ${revision}`,
    },
    where: {
        label: 'Où il s’exécute',
        choose: 'Choisir où il s’exécute',
    },
    sections: {
        whereTitle: 'Où il s’exécute',
        machineAndProject: 'Machine et projet',
        eachStepRunsIn: 'Chaque étape s’exécute dans',
        eachStepSession: 'Chaque étape apparaît dans votre liste de sessions, sous cette exécution.',
        eachStepBackground: 'Chaque étape s’exécute en arrière-plan, sous cette exécution.',
        aSession: 'Une session',
        aBackgroundRun: 'Une exécution en arrière-plan',
        agentTitle: 'Agent et modèle',
        agentDescription: 'Les étapes les utilisent sauf si elles choisissent les leurs.',
        rolesTitle: 'Rôles pour ce workflow',
        conversationTitle: 'Conversation et espace de travail',
        inputsTitle: 'Entrées et résultat',
    },
    unavailable: {
        machine_not_selected: 'Choisissez d’abord une machine.',
        capability_unknown: 'Vérification de ce que cette machine prend en charge.',
        machine_does_not_support_detached_runs: 'Cette machine ne peut pas encore faire d’exécutions en arrière-plan.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Options de l’étape',
        whereMissing: 'Aucune machine choisie',
        none: 'Aucune',
        inputCount: ({ count }) => count === 1 ? '1 entrée' : `${count} entrées`,
        finalOutput: ({ output }) => `Résultat final : ${output}`,
        originSession: 'La session qui l’a lancé',
        differsFromWorkflow: 'diffère du workflow',
        followsWorkflow: 'utilise les réglages du workflow',
        advancedTitle: 'Avancé',
        deadline: ({ ms }) => `Attend son résultat ${ms} ms`,
        workflowDefault: ({ value }) => `Valeur du workflow · ${value}`,
        aSession: 'Une session…',
        continues: ({ session }) => `Poursuit ${session}`,
        runsIn: 'S’exécute dans',
        runsInBoundBySession: 'Poursuit une session, donc s’exécute dans cette session.',
        reviewTitle: 'Vérifier avant de continuer',
        reviewDescription: 'Les étapes suivantes de cette voie attendent que vous utilisiez, modifiiez ou régénériez le résultat. Le reste du travail continue.',
        reviewEvaluator: 'Chaque itération attend votre vérification.',
        reviewsBeforeContinuing: 'Vérification avant de continuer',
        resultTitle: 'Résultat',
        resultFromAction: ({ action }) => `Défini par ${action}`,
        resultFromWorkflow: ({ workflow }) => `Renvoie ce que renvoie ${workflow}`,
        back: 'Retour',
        options: 'Options',
        itemConversation: 'Une conversation par élément ; les étapes à l’intérieur la partagent.',
        dropContinue: ({ session }) => `Poursuivre ${session} dans cette étape`,
        dropRefused: ({ session, machine, where }) => `${session} est sur ${machine} ; ce workflow s’exécute sur ${where}.`,
        lanes: ({ count }) => `En parallèle · ${count} voies`,
        laneCount: ({ count }) => (count === 1 ? '1 voie' : `${count} voies`),
        lane: ({ position }) => `Voie ${position}`,
        forEachIn: ({ source }) => `Pour chaque élément de ${source}`,
        atATime: ({ count }) => `${count} à la fois`,
        repeatTimes: ({ count }) => `Répéter ${count} fois`,
        repeatUntil: ({ condition }) => `Répéter jusqu’à ce que ${condition}`,
        repeatUntilDecided: 'Répéter jusqu’à ce qu’une étape dise d’arrêter',
        ifSentence: ({ condition }) => `Si ${condition}`,
        onlyWhenSentence: ({ condition }) => `Seulement si ${condition}`,
        conditionAll: 'toutes sont vraies',
        conditionAny: 'l’une est vraie',
        conditionNot: ({ condition }) => `non (${condition})`,
        returnsStructured: 'Renvoie des données structurées',
        returnsDecision: 'Renvoie une décision',
    },
};

const workflowEditorPageTranslations = { fr } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "fr"> = { fr: {
        sessionNotifyDescription: "Une notification dès que l’agent de cette session a besoin de votre intervention.",
        sessionDailySummaryDescription: "Un résumé ici chaque jour à 09:00.",
        sessionTestDescription: "Exécute une commande de test modifiable après chaque tour terminé, échoué ou annulé.",
        notifyWhenAgentWaits: { title: "Me prévenir quand un agent attend", description: "Choisissez une session et recevez une notification dès que son agent a besoin de votre intervention." },
        dailySummaryInSession: { title: "Résumé quotidien dans cette session", description: "Choisissez une session pour recevoir un résumé chaque jour à 09:00." },
        memoryUpkeepInSession: { title: 'Entretien de la mémoire', description: 'Examinez la mémoire de cette session chaque jour à 09:00 et gardez les faits utiles à jour.' },
        installDepsInWorktree: { title: "Installer les dépendances dans un nouvel arbre de travail", description: "Créez un nouvel arbre de travail et exécutez-y une commande d’installation modifiable." },
        testAfterEveryTurn: { title: "Tester après chaque tour", description: "Choisissez une session et exécutez une commande de test modifiable après chaque tour terminé, échoué ou annulé." },
        noSessions: "Démarrez une session de travail pour utiliser ce modèle.",
        nodes: { ask: 'Demander', 'review-correctness': 'Vérifier la justesse', 'review-tests': 'Examiner les tests', summarize: 'Résumer les constats', analyze: 'Analyser', review: 'Examiner', fix: 'Corriger', check: 'Vérifier', classify: 'Classer', reply: 'Rédiger une réponse', digest: 'Résumer les changements' },
        title: 'Partir d’un exemple', fromExample: 'À partir d’un exemple', description: 'Chaque exemple s’ouvre comme brouillon. Rien ne démarre avant votre choix Exécuter maintenant.', sessionDescription: 'Chacun s’ouvre comme brouillon dans cette session. Rien ne s’exécute avant que vous l’activiez.', use: 'Utiliser celui-ci', chooseSession: 'Choisir une session…', builtInDescription: 'Inclus dans Happier. Dupliquez-le pour le modifier.', stepCount: ({ count }) => `${count} ${count === 1 ? 'étape' : 'étapes'}`,
        askOnce: { title: 'Poser une question', description: 'Une étape : demander quelque chose à un agent et recevoir sa réponse.' },
        reviewPullRequest: { title: 'Examiner une pull request', description: 'Deux réviseurs en parallèle, puis un résumé de tous les constats.' },
        workThroughEachFile: { title: 'Traiter chaque fichier', description: 'Pour chaque fichier d’une liste, un à un : l’analyser, puis examiner la modification.' },
        repairUntilItPasses: { title: 'Réparer jusqu’à réussite', description: 'Réparer et vérifier jusqu’à réussite ou épuisement des essais autorisés. Puis examiner la dernière réparation.' },
        triageAnIssue: { title: 'Trier une issue', description: 'Classer une issue. Corriger les bugs, sinon rédiger une réponse.' },
        morningDigest: { title: 'Résumé du matin', description: 'Résumer les changements du projet et vous les envoyer. Ajouter un déclencheur pour chaque matin.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "fr"> = { fr: { fromPlugins: 'Depuis les plugins', readOnly: 'Lecture seule · dupliquez dans votre bibliothèque pour modifier', duplicateToLibrary: 'Dupliquer dans votre bibliothèque' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "fr"> = { fr: { title: "Visibilité", chooseTeam: "Choisir une équipe", loadFailed: "Impossible de vérifier qui peut voir cette exécution", machines: "S’exécute sur vos machines", transcripts: "Les membres de l’équipe peuvent voir les conversations des étapes.", requiredSessionsEditable: "Les sessions de cette équipe sont modifiables par ses membres", visibleTo: ({ team }) => "Visible par " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "fr"> = { fr: { visibility: workflowRunVisibilityTranslations.fr, runWithAnotherAgent: 'Relancer avec un autre agent', agentForStep: ({ step }) => `Agent pour ${step}`, chooseAgent: 'Choisir un agent ou un rôle' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { fr: {
        observedProgress: ({ status }: { status: string }) => `Observé : ${status}`,
        definitions: 'Définitions',
        stepsProgress: ({ completed, total }: Progress) => `${completed} étapes sur ${total}`,
        loopProgress: ({ completed, total }: Progress) => `${completed} éléments sur ${total}`,
        startedByAgent: 'Démarré par un agent',
        startedByTrigger: 'Démarré par un déclencheur',
    } } satisfies Pick<Record<string, typeof en>, "fr">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "fr"> = { fr: { rolesTitle: 'Rôles pour cette exécution', rolesYour: 'Vos rôles', rolesChanged: ({ count }) => `${count} modifiés pour cette exécution`, rolesUnchanged: 'Tout le reste reste identique.', useYourRole: 'Utiliser votre rôle', targetsTitle: 'Chaque étape s’exécute dans', rolesPrefillFailed: 'Impossible de lire les rôles de votre dernière exécution. Réessayez.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "fr"> = { fr: { ...workflowRunRoleTranslations.fr, ...workflowRunCompositionTranslations.fr, shortcutStarts: 'démarre', neededNamed: ({ name }) => `Entrées · ${name} manquant`, addToStart: ({ name }) => `Ajoutez ${name} pour démarrer`, workflow: 'Workflow', inputs: 'Entrées', start: 'Démarrer', starting: 'Démarrage…', stillStarting: 'Démarrage toujours en cours…', needed: ({ count }) => `Entrées · ${count} manquantes`, required: 'Requis pour démarrer', preview: 'Ce qui sera fait', unsaved: 'Inclut les modifications non enregistrées', remove: 'Revenir à une session simple', search: 'Trouver un workflow', builtin: 'Intégrés', library: 'Votre bibliothèque', noInputs: 'Aucune entrée requise', asksFor: ({ names }) => `Demande ${names}`, optional: 'Facultatif — laissé vide', defaultValue: ({ value }) => `Par défaut : ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const fr: WorkflowsDestinationTranslations = {
    description: 'Des recettes que tes agents exécutent sur tes machines — quand tu le décides, selon un planning ou quand quelque chose se produit.',
    import: 'Importer',
    addAccessibility: 'Ajouter un flux de travail',
    moreAccessibility: 'Autres options des flux de travail',
    addMenu: {
        newWorkflowSubtitle: 'Partir d’un brouillon vide',
        importSubtitle: 'Un fichier JSON de flux de travail',
    },
    sections: {
        needsYou: 'Besoin de toi',
        running: 'En cours',
        library: 'Bibliothèque',
        sharedWithYou: 'Partagés avec toi',
        triggers: 'Déclencheurs',
        history: 'Historique',
    },
    allRuns: 'Toutes les exécutions',
    lastRun: ({ age }) => `dernière exécution ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Dernière exécution' : `${count} dernières exécutions`} : ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Dernière exécution' : `${count} dernières exécutions`),
        completed: ({ count }) => `${count} ${count === 1 ? 'terminée' : 'terminées'}`,
        failed: ({ count }) => `${count} en échec`,
        needsYou: ({ count }) => `${count} ${count === 1 ? 'a' : 'ont'} besoin de toi`,
        separator: ', ',
    },
    runSettings: 'Réglages d’exécution',
    libraryEmpty: 'Les flux de travail que tu enregistres apparaissent ici.',
    waitingForYou: ({ age }) => `T’attend · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Envoyer une instruction',
    thenRunWorkflow: 'Exécuter un flux de travail',
    offline: 'Hors ligne',
    off: 'Désactivé',
    columnLoadFailed: 'Impossible de charger les flux de travail. Rien de ce que tu as enregistré n’est perdu.',
    firstVisitTitle: 'Enregistre les instructions qui marchent, puis relance-les',
    firstVisitBody: 'Un flux de travail est une suite d’étapes que tes agents exécutent dans l’ordre, côte à côte ou une fois par élément — quand tu le décides, selon un planning ou quand quelque chose se produit.',
    importPrompt: 'Tu as un fichier de flux de travail ?',
    loadMoreWorkflows: 'Charger plus de flux de travail',
    searchPlaceholder: 'Rechercher des flux de travail',
    noMatch: ({ query }) => `Aucun flux de travail ne correspond à « ${query} »`,
    views: {
        all: 'Tous',
        triggered: 'Déclenchés',
        active: 'Actives',
        needsYou: 'Besoin de toi',
        libraryAccessibility: 'Flux de travail à afficher',
        historyAccessibility: 'Exécutions à afficher',
    },
    history: {
        title: 'Historique',
        description: 'Chaque exécution que tu as lancée, quelle que soit la façon.',
        loadMore: 'Charger plus d’exécutions',
        loadFailedTitle: 'Impossible de charger les exécutions',
        loadFailedBody: 'Ton travail n’est pas affecté.',
        review: 'Examiner',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Options du flux de travail',
        runNow: 'Exécuter maintenant',
        share: 'Partager…',
    },
    deleteTitle: 'Supprimer ce flux de travail ?',
    deleteFailedTitle: 'Impossible de supprimer le flux de travail',
    exportFailedTitle: 'Impossible d’exporter le flux de travail',
    gate: {
        localTitle: 'Les automatisations sont désactivées sur cet appareil',
        localBody: 'Active-les pour exécuter les flux de travail et leurs déclencheurs.',
        dependencyTitle: 'Les flux de travail nécessitent les automatisations',
        dependencyBody: 'Active les automatisations pour créer et exécuter des flux de travail.',
        openSettings: 'Ouvrir les réglages',
    },
    runSettingsPage: {
        title: 'Réglages d’exécution',
        description: 'Combien d’exécutions chaque machine accepte à la fois, et combien de temps l’historique est conservé.',
        saveFailed: 'Impossible d’enregistrer les réglages d’exécution. Tes modifications sont toujours là.',
    },
};

const workflowsDestinationTranslations = { fr } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const fr: WorkflowTriggersCopy = {
    activity: {
        create: "Créer un déclencheur à partir de cet événement",
        test: "Tester ce déclencheur",
        matched: "Cet événement correspond",
        noMatch: "Cet événement ne correspond pas",
        sourceMismatch: "Cet événement provient d’une autre source",
        tooOld: "Cet événement est trop ancien pour l’observation",
        invalid: "Configurez l’événement avant de le tester",
    },
    pullRequest: {
        label: "Pull request",
        description: "Ajouter ce déclencheur lie la pull request à cette session.",
        empty: "Aucune pull request ouverte",
        loadFailed: "Impossible de charger les pull requests",
    },
    summary: {
        everyDayAt: ({ time }) => `Tous les jours à ${time}`,
        weekdaysAt: ({ time }) => `En semaine à ${time}`,
        weeklyAt: ({ day, time }) => `Chaque ${day} à ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Chaque minute' : `Toutes les ${count} minutes`),
        everyHours: ({ count }) => (count === 1 ? 'Chaque heure' : `Toutes les ${count} heures`),
        cron: ({ expression }) => `Selon un horaire · ${expression}`,
        schedule: 'Selon un horaire',
        event: ({ event }) => `Quand ${event} se produit`,
        manual: 'Manuel',
        more: ({ first, count }) => `${first} · ${count} de plus`,
    },
    kind: {
        pluginEvent: "Événement de plugin",
        sessionStarts: 'Quand la session démarre',
        sessionArchived: 'Quand la session est archivée',
        schedule: 'Selon un horaire',
        prComment: "Quand quelqu'un commente une pull request",
        ciFailed: 'Quand la CI échoue sur une pull request',
        turnEnds: 'Quand un tour se termine',
        needsYou: 'Quand la session a besoin de vous',
        runEnds: 'Quand l’exécution se termine',
        runNeedsYou: 'Quand l’exécution a besoin de vous',
    },
    row: {
        workflowDeleted: 'Workflow supprimé',
        legacyCreated: 'Créé dans Happier 0.2',
        legacyUnavailable: 'Déclencheur ancien indisponible',
        sessionKeyRequired: 'Clé de session requise',
        templateRecoveryRequired: 'Récupérez ce déclencheur dans Sécurité du compte',
        templateDecryptionFailed: 'Impossible de déchiffrer le déclencheur',
        machines: ({ count }: Count) => `${count} machines`,
        nextRun: ({ time }: { time: string }) => `Prochaine exécution : ${time}`,
        nextMinutes: ({ count }: Count) => `dans ${count} min`,
        nextHours: ({ count }: Count) => `dans ${count} h`,
        nextDays: ({ count }: Count) => count === 1 ? 'demain' : `dans ${count} jours`,
        steps: ({ count }) => (count === 1 ? `${count} étape` : `${count} étapes`),
        off: 'Désactivé',
        running: 'En cours',
        ran: ({ age }) => `Exécuté ${age}`,
        lastOutcome: ({ state, age }) => `${state} ${age}`,
        turnOn: ({ name }) => `Activer ${name}`,
        turnOff: ({ name }) => `Désactiver ${name}`,
    },
    section: {
        add: 'Ajouter un déclencheur',
        emptyTitle: 'Aucun déclencheur',
        emptyBody: 'Ajoutez-en un pour relire chaque tour, avancer vers un objectif ou réagir à la pull request.',
        loadFailed: 'Impossible de charger les déclencheurs de cette session.',
        accountLoadFailed: 'Impossible de charger vos déclencheurs.',
        title: 'Déclencheurs',
        countOn: ({ count }) => `${count} actifs`,
        info: 'Ce qui s\'exécute dans cette session quand quelque chose se produit. Ils restent avec cette session et n\'apparaissent pas dans votre bibliothèque.',
        saveFailed: 'Impossible d\'enregistrer ce déclencheur. Vos modifications sont toujours là.',
    },    kindDescription: {
        pluginEvent: "Exécuter quand un plugin observe un événement.",
        turnEnds: "Après un tour de vous ou d'un agent avec qui vous travaillez.",
        needsYou: 'Chaque fois que cette session vous attend, y compris quand un workflow ou Continuer la pilote.',
        sessionArchived: "S'exécute une fois, quand vous archivez cette session.",
        sessionStarts: "Seulement à la création d'une session.",
        schedule: 'Poursuit cette session selon un horaire.',
        prComment: 'Seulement les personnes avec accès en écriture. Le commentaire est transmis comme citation.',
        pullRequestUnavailable: 'Les déclencheurs de pull request ne peuvent pas encore être ajoutés ici.',
    },
    then: {
        runsIn: 'S\'exécute dans',
        runsInChoice: {
            newSession: 'Une nouvelle session',
            session: 'Une session…',
            backgroundRun: 'Une exécution en arrière-plan',
        },
        noSessionOnMachine: 'Aucune session sur cette machine pour le moment',
        session: 'Session',
        action: 'Action',
        label: 'Ensuite',
        sendPrompt: 'Envoyer un prompt',
        doAction: 'Faire une action',
        notifyMe: 'Me notifier',
        runWorkflow: 'Lancer un workflow',
        sendPromptDescription: "L'agent de cette session reçoit ce prompt dans cette session. Il n'interrompt jamais votre tour.",
        promptLabel: 'Prompt',
        promptPlaceholder: "Que doit faire l'agent ?",
        message: 'Message',
        title: 'Titre',
        sendTo: 'Envoyer à',
        sendToDefault: 'Vos réglages de notification',
        workflow: 'Workflow',
        choose: 'Choisir…',
    },
    popover: {
        configureEvent: "Configurer l’événement",
        editEvent: "Modifier l’événement",
        saveAsWorkflow: 'Enregistrer comme workflow',
        saveAsWorkflowDescription: 'Ouvre ces étapes comme un nouveau workflow à relire. Ce déclencheur garde ses propres étapes.',
        when: 'Quand',
        newTrigger: 'Nouveau déclencheur',
        addTrigger: 'Ajouter le déclencheur',
        cancel: 'Annuler',
        done: 'Terminé',
        turnOff: 'Désactiver',
        turnOn: 'Activer',
        deleteTrigger: 'Supprimer le déclencheur',
        repeat: 'Répéter',
        everyDay: 'Tous les jours',
        weekdays: 'En semaine',
        weekly: 'Chaque semaine',
        day: 'Jour',
        at: 'À',
        expression: 'Horaire',
        tryAgain: 'Réessayer',
    },    editor: {
        runsOn: 'S\'exécute sur',
        runsOnDescription: 'Tous les déclencheurs de ce workflow s’exécutent ici.',
        runsOnAccountDescription: 'Où ce déclencheur s’exécute.',
        runsOnDiffers: ({ where }) => `Exécuter maintenant utilise ${where} à la place.`,
        sameForAllTriggers: 'Identique pour tous les déclencheurs',
        roles: 'Rôles',
        retargetFailed: 'Workflow enregistré · Déclencheur non mis à jour',
        editInWorkflows: 'Modifiez ce déclencheur dans Workflows. Il continue de s’exécuter tel quel.',
        title: 'S\'exécute automatiquement',
        runsBy: 'S\'exécute tout seul quand l\'un de ces événements se produit.',
        runsByOn: ({ where }) => `S'exécute tout seul quand l'un de ces événements se produit, sur ${where}.`,
        savedWorkflow: 'Les déclencheurs lancent le workflow enregistré.',
        saveToInclude: 'Les déclencheurs lancent le workflow enregistré. Enregistrez pour inclure vos modifications.',
        newRow: 'Nouveau · pas encore ajouté',
        partialSave: 'Workflow enregistré · Déclencheurs non mis à jour',
    },    column: {
        newTrigger: 'Nouveau déclencheur',
        newTriggerSubtitle: 'Exécute ses propres étapes selon un horaire',
    },
};

const legacyTranslations = { fr: {
        editNotice: 'Créé dans Happier 0.2. L’ouvrir ne change rien.',
        conversionBoundary: 'Après cette modification, elle ne fonctionne que sur les machines avec Happier 0.3 ou ultérieur.',
        reviewRequired: 'À vérifier',
        reviewConversionNotice: 'En enregistrant, tu stockes ce workflow sans chiffrement de bout en bout et tu relances ses déclencheurs activés. La session reste chiffrée de bout en bout.',
        channelReplyRefusal: 'Cette automatisation a une liaison de réponse à un canal qui ne peut pas être transférée. Elle n’a pas été convertie ; ses réglages et vos modifications sont conservés.',
        notAvailable: 'Cette automatisation n’est plus disponible.',
    } };

const creationTranslations = { fr: { savedWorkflowsUnavailable: 'Passez au serveur de cette session pour choisir un workflow enregistré. Les workflows intégrés et les étapes en ligne restent disponibles.' } };

const workflowTriggersTranslations = { fr: { ...fr, legacy: legacyTranslations.fr, creation: creationTranslations.fr } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { fr: {
        checkoutRoot: 'Dossier racine de la copie de travail',
        unavailableValue: 'Valeur indisponible', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Contexte de la session' : turns === 1 ? 'Dernier tour de session' : `${turns} derniers tours de session`,
        tokensUsed: 'Jetons utilisés', goalTokenBudget: 'Budget de jetons de l’objectif',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${source} consécutifs correspondant à ${value}`,
        stopCondition: 'Condition d’arrêt remplie', stopConditionArm: ({ arm }: { arm: number }) => `Condition d’arrêt ${arm} remplie`,
        roundLimit: ({ rounds }: { rounds: number }) => `Limite atteinte · ${rounds} tours`, decision: 'Décision',
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

const fr = translated(workflowValueReferenceTranslations.fr, {
    testRun: {
        title: "Exécution de test",
        savedNotice: "Exécute réellement la version enregistrée. Les modifications non enregistrées restent ici.",
        resultsNotice: "Résultats de la version enregistrée · dernière exécution. Les modifications non enregistrées n’ont pas été exécutées.",
        recordedDuration: ({ seconds }) => `Durée écoulée enregistrée · ${seconds} s`,
        loading: "Chargement des résultats du test…",
    },
    runWhen: {
        title: "Exécuter en cas de",
        success: "Réussite",
        failure: "Échec",
        always: "Toujours",
        ifSuccess: "Si l’étape réussit",
        ifFailure: "Si l’étape échoue",
        regardless: "Dans tous les cas",
        previousStep: "Par rapport à l’étape précédente",
    },
    title: 'Flux de travail',
    newWorkflow: 'Nouveau flux de travail',
    copyName: ({ name }: { name: string }) => `${name} copie`,
    importJson: 'Importer du JSON',
    exportJson: 'Exporter en JSON',
    openCollection: 'Ouvrir les flux de travail',
    destination: workflowsDestinationTranslations.fr,
    plugins: workflowPluginTranslations.fr,
    authoring: workflowAgentAuthoringTranslations.fr,
    page: workflowEditorPageTranslations.fr,
    actionTitles: workflowActionTranslations.fr,
    builtins: workflowBuiltinTranslations.fr,
    examples: workflowExamplesTranslations.fr,
    triggers: workflowTriggersTranslations.fr,
    start: workflowStartTranslations.fr,
    list: workflowRunListTranslations.fr,
    review: {
        publishedByAgent: 'Publié par l’agent',
        publishedByYou: 'Publié par vous',
        editedByYou: 'Modifié par vous',
        editedByPerson: 'Modifié par une autre personne',
        previousAttempt: 'Tentative précédente',
        useBody: "Les étapes suivantes reçoivent exactement ce que vous voyez. Sans tour de l’agent.",
        usePlanBody: "Accepte exactement ce plan. Sans tour de l’agent.",
        reportBackTitle: ({ session }) => "Rapporter à " + session,
        reportBackBody: ({ session }) => session + " reçoit le résultat de cette exécution à la fin.",
        planRunNotice: "Exécute le workflow proposé exactement comme affiché et accepte le plan. Il n’est pas enregistré.",
        editedPlanBody: 'Ce brouillon diffère de la proposition. Utiliser d’abord le plan vérifié pour le modifier ? Vos modifications restent ici et rien ne démarre avant une nouvelle exécution du brouillon.',
        title: "Résultat à vérifier",
        planTitle: "Plan à vérifier",
        waitTitle: "En attente de votre réponse",
        waitBody: "Cette branche attend que vous continuiez.",
        editsTitle: "Vos modifications non enregistrées",
        editsBody: "Le résultat enregistré reste inchangé jusqu’à son utilisation.",
        heldBody: "En attente de votre vérification · pas encore transmis aux étapes suivantes",
        noValue: "Pas encore de résultat valide",
        enterValues: 'Remplissez les champs.',
        useResult: "Utiliser ce résultat",
        usePlan: "Utiliser ce plan",
        useValues: "Utiliser ces valeurs",
        continue: "Continuer",
        invalid: "Corrigez d’abord le champ indiqué.",
        newer: "Un résultat plus récent est disponible.",
        showNewer: "Afficher le nouveau",
        keepMyEdits: 'Garder mes modifications',
        useNewer: 'Utiliser le nouveau',
        showFullResult: 'Afficher le résultat complet',
        showFullPlan: 'Afficher le plan complet',
        generationRequested: "Génération demandée",
        startsResume: "Démarre quand vous reprenez l’exécution.",
        generateBody: "L’agent écrit un nouveau résultat dans cette conversation. S’il est valide, l’exécution continue sans nouvelle confirmation.",
        acceptedPaused: "L’utilisation de ce résultat laisse le workflow en pause.",
        editResult: "Modifier le résultat",
        generate: "Générer le résultat et continuer",
        discuss: "Discuter",
        discussBody: "Répondez dans la conversation de cette étape. L’agent peut publier ici un résultat actualisé.",
        proposal: "Workflow proposé",
        planStarted: "Une exécution de ce plan a démarré",
        earlierPlanStarted: "Une exécution a déjà démarré à partir d’une proposition précédente",
        openEarlierPlanRun: "Ouvrir cette exécution",
        runNewProposal: "Exécuter la nouvelle proposition",
        runPlan: "L’exécuter comme workflow",
        runPlanBody: "Ouvre la vérification du workflow proposé. Son démarrage accepte aussi ce plan.",
        editPlan: "Modifier d’abord le workflow",
        editPlanBody: "Accepte ce plan puis ouvre le workflow proposé comme brouillon non enregistré.",
        editPlanFallback: "Accepte ce plan puis ouvre un workflow à une étape avec ce plan comme instruction.",
        waitingMachine: ({ machine }) => "En attente de " + machine,
    },

    tabs: {
        saved: 'Enregistrés',
        runs: 'Exécutions',
        steps: 'Étapes',
        flow: 'Schéma',
        map: 'Carte',
        activity: 'Activité',
    },
    tabsAccessibility: {
        savedRuns: 'Flux de travail enregistrés ou exécutions',
        stepsFlow: 'Étapes ou schéma',
        activityFlow: 'Activité ou schéma',
        runViews: "Vues de l’exécution",
    },

    filters: {
        all: 'Tout',
        active: 'Actifs',
        needsYou: 'A besoin de toi',
        clear: 'Effacer le filtre',
    },

    empty: {
        savedTitle: 'Aucun flux de travail enregistré pour l’instant',
        savedBody: 'Enregistrer un flux de travail conserve une définition réutilisable que tu peux exécuter ou planifier.',
        runsTitle: 'Rien ne s’est encore exécuté',
        runsBody: 'Les exécutions apparaissent ici, que tu enregistres le flux de travail ou non.',
        filteredTitle: 'Aucune exécution ne correspond à ce filtre',
        filteredBody: 'Efface le filtre pour voir le reste de tes exécutions.',
        missingTitle: 'Ce flux de travail n’est pas disponible',
        missingBody: 'Happier n’a pas pu ouvrir le flux de travail visé par ce lien. Tes autres flux, Automatisations et exécutions ne sont pas affectés.',
        missingDraftTitle: "Cette copie non enregistrée a été perdue",
        missingDraftBody: "Le rechargement fait perdre les copies non enregistrées. Ouvre le flux de travail original pour le dupliquer à nouveau.",
    },

    loadFailedTitle: 'Impossible de charger les flux de travail',
    loadFailedBody: 'Ton travail n’est pas affecté. Réessaie quand tu veux.',
    retry: 'Réessayer',
    contentUnavailable: 'Le contenu privé n’est pas disponible sur cet appareil.',
    readState: {
        historyTitle: 'Historique illisible',
        historyBody: 'Cette exécution a été enregistrée avec une ancienne version de développement de Happier. Son historique ne peut pas être ouvert. Lancez une nouvelle exécution pour continuer.',
        encryptionTitle: 'Chiffrement à configurer',
        encryptionBody: 'Ce contenu est chiffré de bout en bout. Configurez le chiffrement de ce compte pour l’ouvrir.',
        keysTitle: 'En attente des clés',
        keysBody: 'Cet appareil ne possède pas encore les clés de chiffrement de cette exécution. Réessayez lorsqu’elles seront disponibles.',
        storageTitle: 'Stockage des exécutions indisponible',
        storageBody: 'Happier n’a pas pu accéder au stockage des exécutions. Vérifiez votre connexion, puis réessayez.',
        openSettings: 'Ouvrir les réglages',
    },
    contentReasons: {
        invalidHeader: 'Les informations enregistrées de ce workflow ne sont pas valides.',
        revisionMismatch: 'Ce workflow ne correspond pas à sa révision enregistrée.',
        missingBody: 'La définition enregistrée de ce workflow est manquante.',
        invalidBody: 'La définition enregistrée de ce workflow n’est pas valide.',
        notFound: 'Ce workflow n’est plus disponible.',
    },

    sessionEntry: {
        missingTitle: 'Cette session n’est plus disponible',
        missingBody: 'Elle a peut-être été supprimée ou se trouve sur un autre Home. Ouvrez Sessions pour la retrouver.',
        inaccessibleTitle: 'Vous ne pouvez pas ouvrir cette session',
        inaccessibleBody: 'Happier n’a pas pu confirmer l’accès. Reconnectez-vous ou demandez à sa propriétaire ou son propriétaire, puis rouvrez cette page.',
        failedTitle: 'Impossible d’ouvrir cette session',
        failedBody: 'Happier continue d’essayer. Vous pouvez réessayer maintenant.',
        unsupportedTitle: 'Cette session ne peut pas démarrer un flux de travail',
        unsupportedBody: 'Happier n’a pas pu lire l’agent ni la machine sur laquelle elle tourne. Créez le flux de travail depuis Flux de travail.',
    },

    editor: {
        namePlaceholder: 'Nom du flux de travail',
        agentRuntime: 'Environnement d’exécution de l’agent',
        firstPromptTitle: 'Que doit-il se passer en premier ?',
        firstPromptBody: 'Un seul prompt est déjà un flux de travail. Ajoute des étapes quand tu en as besoin.',
        promptPlaceholder: 'Décris ce que cette étape doit faire',
        useWorkflowDefault: 'Utiliser la valeur du flux de travail',
        defaultsTitle: 'Valeurs par défaut',
        produces: 'Produit',
        whereTitle: 'Où',
        add: 'Ajouter',
        addAccessibility: 'Ajouter un bloc à ce flux de travail',
        addStep: 'Étape d’agent',
        addParallel: 'Côte à côte',
        addLoop: 'Répéter',
        addIf: 'Si',
        targetRequired: 'Choisissez la machine et le dossier du projet pour ce flux de travail.',
        loadingTitle: 'Ouverture du flux de travail…',
        accountChangedTitle: 'Vous avez changé de compte',
        accountChangedBody: 'Ce flux de travail a été ouvert par le compte précédent et ne peut pas être conservé. Rouvrez-le depuis Flux de travail.',
        loadFailedTitle: 'Impossible d’ouvrir ce flux de travail',
        loadFailedBody: 'Le flux de travail enregistré n’a pas pu être lu pour l’instant.',
        timeoutTitle: 'Attente du résultat (ms)',
        noDeadline: 'Aucune limite',
        timeoutExplain: 'Millisecondes d’attente du résultat de cette étape avant qu’elle ne demande ton attention. Laisse vide pour aucune limite.',
        wholeNumberRequired: 'Saisis un nombre entier d’au moins 1.',
        runNow: 'Exécuter maintenant',
        save: 'Enregistrer le flux de travail',
        saveAutomation: 'Enregistrer l’Automatisation',
        schedule: 'Planifier',
        savedRevision: ({ revision }) => `Enregistré · ${revision}`,
        moveUp: 'Monter',
        moveDown: 'Descendre',
        moveIn: 'Déplacer dans le groupe au-dessus',
        moveOut: 'Sortir de ce groupe',
        remove: 'Supprimer',
        undo: 'Annuler',
        redo: 'Rétablir',
        historyRestoreRequiresSetup: 'Cet événement doit être configuré à nouveau. Sa configuration privée enregistrée ne peut pas être restaurée après sa suppression.',
        history: { edited: 'Modifier le workflow', agent: 'Modification de l’agent', description: 'Modifier la description', where: 'Changer le lieu d’exécution', target: 'Changer l’exécution des étapes', triggers: 'Modifier les déclencheurs', example: 'Insérer un exemple', document: 'Modifier la demande', renameWorkflow: 'Renommer le workflow', renameStep: 'Renommer l’étape', renameLane: 'Renommer la branche' },
        undoAction: ({ change }: { change: string }) => `Annuler : ${change}`,
        redoAction: ({ change }: { change: string }) => `Rétablir : ${change}`,
        removedBlock: ({ block }) => `${block} supprimé`,
        rename: 'Renommer',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Étape ${position}`,
        unnamedParallel: 'Groupe parallèle',
        unnamedLoop: 'Boucle',
        unnamedIf: 'Bloc conditionnel',
        branch: 'Branche',
        addBranch: 'Ajouter une voie',
        ifTrue: 'Alors',
        otherwise: 'Sinon',
        addOtherwise: 'Ajouter une branche « sinon »',
        evaluator: 'Décider s’il faut continuer',
        loopBody: 'Répéter ces étapes',
        continuation: 'Après chaque tour',
    },

    input: {
        label: 'Entrée',
        result: 'Résultat',
        change: 'Changer',
        none: 'Aucune entrée',
        previousResult: ({ block }) => `Résultat de ${block}`,
        workflowInput: ({ name }) => `Entrée du flux de travail ${name}`,
        currentItem: 'L’élément en cours',
        iteration: 'Ce tour',
        unavailable: 'Cette source n’est plus disponible',
        itemField: {
            value: 'Valeur de l’élément',
            index: 'Index de l’élément, à partir de 0',
            position: 'Position de l’élément, à partir de 1',
            count: 'Nombre d’éléments',
        },
        iterationField: {
            index: 'Index du tour, à partir de 0',
            position: 'Numéro du tour, à partir de 1',
            count: 'Nombre de tours',
            stopReason: 'Raison de l’arrêt',
        },
        valueKindGroup: 'Source de la valeur',
        inputNameGroup: 'Entrée du flux',
        producerGroup: 'Étape source',
        workspaceFieldGroup: 'Champ de l’espace de travail',
        itemFieldGroup: 'Champ de l’élément',
        iterationFieldGroup: 'Champ du tour',
    },

    inputs: {
        title: 'Entrées du flux de travail',
        addInput: 'Ajouter une entrée',
        namePlaceholder: 'Nom',
        descriptionPlaceholder: 'À quoi ça sert ?',
        required: 'Obligatoire',
        optional: 'Facultatif',
        defaultValue: 'Valeur par défaut',
        typeString: 'Texte',
        typeNumber: 'Nombre',
        typeBoolean: 'Oui ou non',
        typeJson: 'Données structurées',
        runSheetTitle: 'Exécuter ce flux de travail',
        runSheetBody: 'Fournis les valeurs déclarées par ce flux de travail, puis exécute-le.',
        missingRequired: 'Cette valeur est obligatoire.',
        wrongType: ({ type }) => `Cette valeur doit être de type ${type}.`,
    },

    finalOutput: {
        title: 'Résultat final',
        none: 'Aucun résultat final sélectionné',
        change: 'Changer',
        clear: 'Effacer la sélection',
        fieldPath: 'Chemin du champ',
        explain: 'Ce que ce flux de travail renvoie lorsqu’il se termine.',
    },

    conversation: {
        title: 'Discussion',
        sharedRun: 'La même discussion',
        branchesShareAndTakeTurns: 'Les branches partagent une discussion et passent chacune à leur tour.',
        fresh: 'Discussions séparées',
        fromStep: ({ block }) => `Continuer ${block}`,
        existingSession: 'Une session existante',
        existingSessionById: ({ sessionId }) => `Session ${sessionId}`,
        noExistingSessions: 'Aucune session de cette machine ne peut être poursuivie ici.',
        chooseExistingSession: 'Choisis une session à poursuivre',
        continuingKeepsAgentAndFolder: 'Continuer conserve l’Agent et le dossier de cette discussion. Un autre Agent ou dossier nécessite une discussion séparée.',
        waitingForConversation: ({ block }) => `En attente que ${block} se termine dans cette discussion.`,
        branchesUseSeparate: 'Les branches d’un groupe parallèle utilisent des discussions séparées.',
    },

    workspace: {
        title: 'Espace de travail',
        inherit: 'Espace de travail du flux',
        projectCheckout: 'Dossier du projet',
        fromStep: ({ block }) => `Continuer dans l’espace de travail de ${block}`,
        newWorktreeOriginal: 'Nouveau worktree à partir du dossier d’origine',
        newWorktreeWorkflow: 'Nouveau worktree à partir de l’espace de travail du flux',
        newWorktreeStep: ({ block }) => `Nouveau worktree à partir de ${block}`,
        committedOnlyNote: 'Un nouveau worktree contient l’état committé du dossier source. Les modifications indexées, non committées et non suivies restent dans la source.',
        reuseNote: 'Quand un espace de travail est repris, il voit ses fichiers non committés exactement tels quels.',
        sharedParallelNote: 'Les branches qui partagent un espace de travail peuvent y écrire en même temps.',
        unavailable: ({ block }) => `L’espace de travail de ${block} n’est pas disponible.`,
        unavailableBody: 'Restaure-le pour continuer cette exécution, ou examine une nouvelle exécution qui risque de répéter du travail déjà fait.',
        unavailableRestoreBody: 'Restaure-le pour poursuivre cette exécution avec le travail déjà terminé intact.',
        unavailableNewRunBody: 'Il ne peut pas être restauré. Une nouvelle exécution relue repart de zéro, et le travail déjà terminé peut se répéter.',
        restore: 'Restaurer',
        inspect: 'Inspecter',
    },

    condition: {
        onlyWhen: 'Exécuter uniquement si',
        always: 'Toujours',
        stopWhen: 'Arrêter si',
        ifWhen: 'Exécuter la première branche si',
        addCondition: 'Ajouter une condition',
        removeCondition: 'Supprimer la condition',
        allOf: 'Toutes ces conditions',
        anyOf: 'L’une de ces conditions',
        not: 'Non',
        exists: 'a une valeur',
        operatorEq: 'est',
        operatorNeq: 'n’est pas',
        operatorLt: 'est inférieur à',
        operatorLte: 'est au plus',
        operatorGt: 'est supérieur à',
        operatorGte: 'est au moins',
        notFirstRound: 'ce n’est pas le premier tour',
        trailingCountAtLeast: ({ source, value, count }) => `${source} vaut ${value} ${count} fois de suite`,
        loopRanOutOfRounds: ({ loop }) => `${loop} n’a plus de tours`,
        loopEnded: ({ loop, outcome }) => `${loop} s’est terminé : ${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${loop} s’est arrêté car ${condition}`,
        valuePlaceholder: 'Valeur',
        literalPlaceholder: 'Saisissez une valeur',
        skippedReason: ({ block }) => `Ignoré parce que la condition de ${block} était fausse.`,
    },

    loop: {
        modeTitle: 'Répéter',
        modeCount: 'Un nombre de fois défini',
        modeItems: 'Une fois par élément',
        modeUntil: 'Jusqu’à ce qu’un résultat dise d’arrêter',
        modeEvaluate: 'Jusqu’à ce qu’un Agent dise d’arrêter',
        count: 'Nombre de fois',
        items: 'Liste',
        sequential: 'Éléments en séquence',
        parallel: 'Éléments en parallèle',
        maxConcurrentItems: 'Maximum d’éléments simultanés',
        maxConcurrentBranches: 'Maximum de branches simultanées',
        noWorkflowLimit: 'Aucune limite définie par le flux de travail',
        maxIterations: 'Nombre maximal de tours',
        limitReached: 'Limite atteinte',
        historyTitle: 'Évaluations précédentes',
        historyNone: 'Aucune',
        historyLatest: 'La dernière',
        historyAll: 'Toutes',
        historyExplain: 'Cela sélectionne les décisions et les retours enregistrés, pas les transcriptions entières.',
        continuingConversation: 'Cet évaluateur conserve sa discussion précédente et y ajoute chaque nouveau tour.',
        emptyListCompletes: 'Une liste vide se termine sans aucun tour.',
    },

    failurePolicy: {
        title: 'Si une étape échoue',
        failStop: 'Arrêter ce groupe en cas d’échec',
        failStopExplain: 'Ce groupe cesse de lancer du travail et demande aux branches actives de s’arrêter, y compris les indépendantes. Les résultats et les modifications déjà terminés sont conservés. Ce n’est pas un retour en arrière.',
        collectOutcomes: 'Terminer le travail indépendant',
        collectOutcomesExplain: 'Les branches saines vont au bout de toute leur chaîne et chaque résultat est collecté. Les étapes situées après un échec dans une branche ne s’exécutent pas.',
    },

    runState: {
        pending: 'En attente de démarrage',
        queued: 'En attente de démarrage',
        claimed: 'Démarrage',
        running: 'En cours',
        waiting_for_review: 'En attente de votre révision',
        succeeded: 'Terminé',
        failed: 'Échec',
        cancel_requested: 'Arrêt en cours',
        cancelled: 'Arrêté',
        pause_requested: 'Mise en pause',
        paused: 'En pause',
        interrupted: 'Interrompu',
        expired: 'Expiré avant le démarrage',
        dispatch_failed: 'Démarrage impossible',
        skipped: 'Ignoré',
        missed: 'Manqué',
        outcome_uncertain: 'Issue incertaine',
        completed: 'Terminé',
        completed_with_failures: 'Terminé avec des échecs',
    },

    invocationState: {
        pending: 'En attente',
        waiting_for_capacity: 'En attente de capacité',
        admitting: 'Démarrage',
        running: 'En cours',
        waiting_for_approval: 'En attente d’approbation',
        waiting_for_review: 'En attente de votre révision',
        needs_attention: 'A besoin de toi',
        completed: 'Terminé',
        failed: 'Échec',
        skipped: 'Ignoré',
        cancel_requested: 'Arrêt en cours',
        cancelled: 'Arrêté',
        outcome_uncertain: 'Issue incertaine',
        superseded: 'Remplacé par une tentative ultérieure',
    },

    run: {
        title: 'Exécution',
        frozenVersion: "Cette exécution utilise sa version de départ. Les modifications ne concernent que les exécutions futures.",
        selectOccurrence: 'Choisir une étape',
        openReview: 'Examiner le résultat',
        open: 'Ouvrir l’exécution',
        openExact: ({ title }) => `Ouvrir l’exécution ${title}`,
        openExecution: 'Ouvrir l’exécution en arrière-plan',
        loadMore: 'Charger les étapes précédentes',
        origin: {
            direct: 'Lancée directement',
            automation: 'Planifiée',
            fromSession: 'Depuis une session',
        },
        needsYou: 'A besoin de toi',
        needsYouLoadedCount: 'chargées',
        review: 'Examiner',
        stop: 'Arrêter',
        stopAgain: 'Arrêter à nouveau',
        stopping: 'Arrêt en cours…',
        stopRequested: ({ machine }) => `Arrêt demandé. En attente de la confirmation de ${machine}.`,
        evidenceStale: 'Affichage des derniers détails connus. Happier n’a pas pu confirmer qu’ils sont à jour.',
        pauseAtBoundary: 'Mettre en pause à la prochaine limite',
        pausePending: 'Termine le travail en cours, puis se met en pause.',
        paused: 'En pause après la dernière limite terminée.',
        resume: 'Reprendre',
        runAgain: 'Réexécuter le flux de travail',
        retryStep: 'Réessayer l’étape',
        attempt: ({ attempt }) => `Tentative ${attempt}`,
        untitled: 'Exécution du workflow',
        openResult: 'Ouvrir le résultat',
        inspectSteps: 'Examiner les étapes',
        seeFailures: 'Voir les échecs',
        saveAsWorkflow: 'Enregistrer comme flux de travail',
        saveAsNewWorkflow: 'Enregistrer comme nouveau flux de travail',
        showCurrentWork: 'Afficher le travail en cours',
        editWorkflow: 'Modifier le flux de travail',
        openWorkflow: 'Ouvrir le flux de travail',
        deleteHistory: 'Supprimer l’historique des exécutions',
        deleteHistoryConfirm: 'Les entrées et les résultats sont supprimés. Les espaces de travail, les discussions, les flux de travail enregistrés et les Automatisations sont conservés.',
        technicalDetails: 'Détails techniques',
        technical: {
            runId: 'ID d’exécution',
            invocationId: 'ID de l’étape',
            machine: 'Machine',
            machineId: 'Identifiant de la machine',
            revision: 'Révision',
        },
        usageUnavailable: 'Consommation indisponible',
        startedAt: ({ time }: { time: string }) => `Démarré ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Ouvrir la conversation',
        openChildRun: 'Ouvrir son exécution',
        openStepDetails: 'Ouvrir les détails',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} attend ta vérification`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} t’attend`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} attend ta vérification.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} t’attend.`,
        reviewing: 'En cours de vérification',
        notStarted: 'Pas démarré',
        machineUnavailable: ({ machine }) => `Cette exécution a perdu le contact avec ${machine}.`,
        machineUnavailableBody: 'Les options de reprise apparaîtront quand l’état actuel sera connu.',
        completedCount: ({ count }) => `${count} ${count <= 1 ? 'étape terminée' : 'étapes terminées'}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Terminé avec des échecs. ${completed} ${completed <= 1 ? 'terminé' : 'terminés'} ; ${failed} n’${failed <= 1 ? 'a' : 'ont'} pas pu aboutir.`,
        approvalWanted: ({ block }) => `${block} veut exécuter une commande.`,
        approvalWantedBody: 'Examine-la pour continuer.',
        capacityOccupied: 'Toutes les places prévues par le flux de travail sont occupées.',
        openSourceSession: 'Ouvrir la session dont elle vient',
        observedActivity: 'Activité observée',
        observedActivityBody: 'Happier voit les phases et les agents de cet agent, mais il n’a pas été lancé comme un flux de travail géré : il ne peut donc être ni modifié, ni enregistré, ni réexécuté.',
    },

    recovery: {
        title: 'Examiner la reprise',
        reattach: 'Se rattacher',
        reattachExplain: 'Observe le travail déjà en cours. Rien de nouveau n’est lancé.',
        resumeSameConversation: 'Reprendre',
        resumeSameConversationExplain: ({ block }) => `${block} peut continuer dans la même discussion.`,
        freshAgent: 'Continuer avec un nouvel Agent',
        freshAgentExplain: 'Cette discussion ne peut pas être poursuivie. L’espace de travail est disponible pour un nouvel Agent.',
        uncertainEffects: ({ block }) => `${block} s’est arrêté avant de rendre compte. Il a peut-être déjà modifié l’espace de travail.`,
        acknowledgeEffects: 'Je comprends que des modifications précédentes ont peut-être déjà eu lieu',
        waitingForStop: 'En attente de l’arrêt ou d’une confirmation',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'étape associée n’a' : 'étapes associées n’ont'} pas encore démarré`,
        startReviewedRun: 'Lancer une nouvelle exécution vérifiée',
        editContinuation: 'Inspecter ou modifier la suite',
        continuationPlaceholder: 'Ajoutez ce que cette étape doit faire différemment',
        useReplacementInput: 'Remplacer l’entrée de l’étape',
        repeatedEffectWarning: 'Du travail déjà terminé peut se répéter. L’exécution d’origine conserve son historique.',
    },

    unavailable: {
        title: 'Les workflows ne sont pas disponibles',
        body: 'Les workflows ne sont pas disponibles sur ce serveur, impossible donc d’en créer ou d’en exécuter un ici.',
        conversion: 'Ces changements nécessitent le format workflow, et les workflows ne sont pas disponibles sur ce serveur. Garde cette automatisation sur une seule consigne, ou réessaie quand les workflows seront disponibles.',
        savedAutomation: 'Cette automatisation s’exécute comme un workflow. Ses étapes enregistrées restent telles quelles ; tu peux toujours modifier son nom, sa description et ses déclencheurs.',
    },
    conversion: {
        title: 'Ces changements nécessitent le format workflow',
        automationTarget: 'Workflow',
        body: 'Cette automatisation exécute encore un seul prompt sur sa cible enregistrée. La conversion conserve tes modifications et fait tourner les prochaines exécutions comme un workflow sur une machine précise. Les exécutions passées ne changent pas.',
        action: 'Convertir en workflow',
        machineRequired: 'Choisis la machine et le dossier du projet pour les prochaines exécutions.',
    },
    save: {
        conflictTitle: 'Une version plus récente a été enregistrée',
        conflictBody: 'Tes modifications sont toujours là.',
        compare: 'Comparer',
        saveAsCopy: 'Enregistrer comme copie',
        failedTitle: 'Impossible d’enregistrer',
        failedBody: 'Ton travail local est toujours là.',
        deleteTitle: 'Supprimer ce flux de travail ?',
        deleteBody: 'Les Automatisations et les exécutions existantes ne sont pas affectées et continuent de fonctionner.',
        unsupportedAttachment: 'Joins les médias via une référence durable avant d’enregistrer ce flux de travail.',
        nameRequired: 'Donne un nom à ce flux de travail avant de l’enregistrer.',
        runsCurrentDraft: 'Cette exécution utilise le flux de travail tel qu’il est à l’écran. Elle ne l’enregistre pas.',
    },

    interchange: {
        importTitle: 'Importer un flux de travail',
        importBody: 'L’import ouvre un brouillon non enregistré à examiner. Rien n’est exécuté ni planifié.',
        importIssuesTitle: 'Examiner ce flux de travail',
        importIssuesBody: 'Certains réglages nécessitent ton attention avant de pouvoir utiliser ce flux de travail.',
        openRepairDraft: 'Ouvrir le brouillon à corriger',
        importFailedTitle: 'Impossible de lire ce fichier',
        importFailedInvalidJson: 'Ce fichier n’est pas du JSON valide.',
        importFailedUnsupportedVersion: 'Ce fichier utilise une version de flux de travail que cette app ne prend pas en charge.',
        importFailedInvalidDocument: 'Ce fichier n’est pas un flux de travail Happier.',
        exportPrivacyNote: 'Le fichier exporté contient les prompts et les réglages. Il ne contient jamais d’identifiants ni de résultats d’exécution.',
    },

    issue: {
        invalid_version: 'Ce flux de travail utilise une version non prise en charge.',
        unknown_field: 'Ce bloc a un réglage que ce flux de travail ne prend pas en charge.',
        invalid_id: 'Ce bloc a besoin d’un identifiant valide.',
        duplicate_id: 'Deux blocs partagent le même identifiant.',
        missing_reference: 'Cette entrée pointe vers un bloc qui n’existe plus.',
        invalid_reference_scope: 'Cette entrée pointe vers un bloc qui ne se termine pas avant.',
        invalid_input: 'Cette valeur n’est pas valide.',
        missing_required_input: 'Une valeur obligatoire est manquante.',
        invalid_result_contract: 'Les réglages de résultat de cette étape ne sont pas valides.',
        invalid_condition: 'Cette condition ne peut pas être comparée.',
        invalid_repetition: 'Cette boucle ne peut pas se répéter avec cette configuration.',
        invalid_max_concurrent: 'La concurrence maximale demande un nombre entier d’au moins 1 et ne s’applique qu’au travail en parallèle.',
        unsupported_persisted_attachment: 'Les médias joints doivent avoir une référence durable avant l’enregistrement.',
        conversation_workspace_mismatch: 'Cette conversation et cet espace de travail ne peuvent pas être poursuivis ensemble.',
        target_unavailable: 'Choisis un Agent pour ce flux de travail avant de l’exécuter.',
        emptyPrompt: 'Écris ce que cette étape doit faire.',
        emptyWaitPrompt: 'Écris ce que tu dois vérifier ou décider ici.',
        fieldMissing: ({ field }) => `${field} est obligatoire.`,
        fieldInvalid: ({ field }) => `${field} doit avoir une valeur valide.`,
    },

    problem: {
        title: 'Ça n’a pas marché',
        waitingTitle: 'Pas encore possible',
        subtreeDenied: 'Un agent peut démarrer du travail uniquement dans sa propre session ou dans les sessions qu’il dirige.',
        roleTargetUnavailable: 'Ce rôle ne peut pas être utilisé ici.',
        roleRunsAsMismatch: 'Le mode d’exécution de ce rôle n’est pas compatible avec cette étape. Choisis un autre rôle ou change le mode d’exécution de l’étape.',
        policyDeniedField: 'Tes réglages d’agent n’autorisent pas le réglage demandé pour le travail démarré par un agent.',
        permissionExceedsCeiling: 'Cela nécessite plus d’autorisations que n’en possède l’agent qui l’a démarré.',
        workDepthExceeded: 'Cela dépasserait ta limite de délégation. Fais-le dans cette session ou augmente la limite dans Réglages › Délégation.',
        definitionExceedsAuthority: 'L’agent ne peut pas enregistrer un flux de travail qui pourrait faire plus que ce qu’il peut lui-même démarrer.',
        sourceUnavailable: 'Ce flux de travail n’est pas disponible, donc ses déclencheurs ne peuvent pas s’exécuter.',
        legacyConversionUnsupported: 'Cette automatisation ne peut pas encore être modifiée ici. Elle continue de fonctionner telle quelle.',
        nativeGoalOwner: 'L’agent continue déjà à travailler vers les objectifs de façon autonome dans cette session.',
        sessionAlreadyStarted: 'Cette session a déjà démarré. Les déclencheurs de début de session peuvent être ajoutés uniquement lors de sa création.',
        generic: 'Happier n’a pas pu terminer cette demande de flux de travail. Ton travail n’est pas affecté.',
        needsRepair: 'Ce flux de travail a des réglages à corriger avant de pouvoir être lancé.',
        targetUnavailable: 'La machine ou l’agent dont ce flux de travail a besoin n’est pas disponible pour le moment.',
        notFound: 'Cette exécution n’existe plus.',
        accessDenied: 'Tu n’as pas accès à cette exécution.',
        conflict: 'Ceci a changé ailleurs. Actualise pour voir la version actuelle ; ton travail local est conservé.',
        inputTooLarge: 'Cette entrée est trop grande pour être envoyée. Rien n’a été modifié.',
        unresolvedOutcome: 'Happier ne peut pas encore confirmer que le travail précédent s’est arrêté, il ne peut donc pas être remplacé.',
        interactionCapacity: 'Cette conversation a trop d’éléments en attente pour en accepter davantage maintenant.',
        conversationUnavailable: 'Cette conversation ne peut pas être poursuivie.',
        workspaceRestore: 'L’espace de travail n’a pas pu être restauré. Rien n’a été modifié.',
        waitSelfDependency: 'Cela laisserait le flux de travail en attente de la conversation qui l’a lancé.',
        updateRequired: 'La machine qui exécute ceci a besoin d’un Happier plus récent pour accepter cette étape.',
        ineligible: 'Cette exécution a avancé, ce n’est donc plus possible.',
        custodyPending: 'Happier attend encore la confirmation de la machine.',
        runFinished: 'Cette exécution est terminée.',
        checkpointUnavailable: 'Il n’y a aucun point enregistré à partir duquel reprendre.',
        recoveryEvidenceRequired: 'Ouvre cette exécution pour voir ses options de reprise.',
        executionNotStarted: 'Aucune étape n’a encore démarré.',
        custodySettled: 'Cette exécution est déjà clôturée.',
        unavailableHere: 'Ce n’est pas disponible pour le moment.',
    },

    a11y: {
        blockList: 'Blocs du flux de travail',
        stepContext: ({ block, position, total }) => `${block}, étape ${position} sur ${total}`,
        groupContext: ({ group, block }) => `${block}, dans ${group}`,
        inherited: 'utilise le réglage du flux de travail',
        overridden: 'défini pour cette étape',
        inserted: ({ block, position, total }) =>
            `${block} ajouté en position ${position} sur ${total}`,
        removed: ({ block, total }) =>
            `${block} supprimé. ${total} ${total <= 1 ? 'bloc restant' : 'blocs restants'}`,
        reordered: ({ block, position, total }) =>
            `${block} déplacé en position ${position} sur ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block} : ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count <= 1 ? 'étape a' : 'étapes ont'} besoin de toi`,
        needsYouLoaded: 'chargées',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count <= 1 ? 'étape a' : 'étapes ont'} besoin de toi`,
        selectedRowUpdated: ({ block }) => `${block} mis à jour`,
        progress: ({ count }) =>
            `${count} ${count <= 1 ? 'étape mise à jour' : 'étapes mises à jour'}`,
        progressLoaded: ({ count }) =>
            `${count} ${count <= 1 ? 'étape mise à jour' : 'étapes mises à jour'} pour l’instant`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count <= 1 ? 'étape mise à jour' : 'étapes mises à jour'} ; ${attention} ${attention <= 1 ? 'a' : 'ont'} besoin de toi`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Modifier l’étape',
        editBlock: 'Modifier le bloc',
        commandRefused: ({ reason }) => `Pas encore possible. ${reason}`,
    },
});

const workflowTranslations = { fr } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "fr"> = { fr: { workspaceBar: { tabsLabel: 'Onglets ouverts', tabMenuLabel: 'Options de l’onglet', pinTab: 'Épingler l’onglet', unpinTab: 'Désépingler l’onglet', splitRight: 'Diviser à droite', splitDown: 'Diviser en bas', maximizePane: 'Agrandir le volet', restorePane: 'Restaurer le volet', closeTab: 'Fermer l’onglet', closeOtherTabs: 'Fermer les autres onglets', closeTabsToRight: 'Fermer les onglets à droite', moreTabs: ({ count }) => (count === 1 ? '1 onglet de plus' : `${count} onglets de plus`), searchTabs: 'Rechercher des onglets', splitPane: 'Diviser le volet actif', openInNewTab: 'Ouvrir dans un nouvel onglet', openToRight: 'Ouvrir à droite', openBelow: 'Ouvrir en dessous', newTab: 'Nouvel onglet' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { fr: {
        diagnostics: { title: 'Diagnostic', relationshipId: 'ID de la relation', controllerMachineId: 'ID de la machine de contrôle', alphaMachineId: 'ID de la machine source', betaMachineId: 'ID de la machine de destination', alphaRoot: 'Dossier source actuel', betaRoot: 'Dossier de destination actuel', engineMode: 'Mode du moteur', engineState: 'État du moteur', errorCode: 'Code d’erreur' },
        error: { updateRequired: 'Mettez Happier à jour sur la machine source avant de réessayer ce transfert d’espace de travail. Les autres actions de session et de machine restent disponibles.' },
        resolve: { title: 'Résoudre le conflit d’espace de travail ?', body: ({ path, side }) => `Conserver la version « ${side} » du dossier ${path} ? L’autre dossier et tout ce qui n’existe que dans celui-ci seront supprimés après vérification de son état actuel.`, unverifiedFile: 'Une version sans empreinte de fichier actuelle ne peut pas être supprimée en toute sécurité. Actualise le conflit et réessaie.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "fr">;

const workspaceSyncSetAttentionTranslations = { fr: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'lien présente' : 'liens présentent'} des conflits`, unavailableLinks: ({ count }) => `Vérifiez l’état de ${count} ${count === 1 ? 'lien' : 'liens'}` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "fr">;

const workspaceSyncAddMachineTranslations = { fr: { availableOn: 'Disponible sur', addMachine: { replica: 'Réplique', exactReplica: 'Réplique exacte', editableCopy: 'Copie modifiable', editableCopyHint: 'Les modifications sur les machines liées peuvent devenir visibles aux agents des autres machines. Les versions en conflit doivent être examinées. Utilisez des worktrees distincts pour travailler de façon isolée.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "fr">;

const workspaceSyncReviewOutcomeTranslations = { fr: { keepBoth: 'Conserver les deux versions', preserveAt: ({ path }) => `Conserver une autre version à ${path}`, notReviewed: 'Non vérifié ; aucune modification ici', confirmScope: 'Seuls les espaces de travail vérifiés dans la liste seront modifiés. Les autres restent inchangés.', preserved: 'Conservé', alreadyPresent: 'Déjà présent', notStarted: 'Non commencé', askAgent: 'Demander à un agent', askAgentPrompt: ({ path, versions }) => `Aide-moi à examiner les versions conflictuelles de ${path} dans ces espaces de travail liés :\n${versions}\nExamine les fichiers actuels et propose une solution sûre. Ne modifie ni ne résous le conflit sans mon accord.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "fr">;

const workspaceSyncCoverageIncompleteTranslations = { fr: 'Certains liens ou points ne sont pas vérifiés. Les conflits chargés restent visibles ; seules les versions disponibles et explicitement vérifiées peuvent être résolues.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "fr">;

const workspaceSyncReviewLifecycleTranslations = { fr: { requestingApproval: 'Demande d’approbation…', applying: 'Application des modifications vérifiées…', propagationExpected: ({ names }) => `Propagation attendue vers ${names}`, propagationUnverified: ({ names }) => `La propagation vers ${names} ne peut pas encore être vérifiée` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "fr">;

const workspaceSyncLocalOnlyTranslations = { fr: 'Cet emplacement alternatif reste local à son espace de travail' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "fr">;

const workspaceSyncKeepAlternativesTranslations = { fr: 'Conserver les autres versions' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "fr">;

const workspaceSyncReviewDecisionTranslations = { fr: { chooseTargets: 'Choisir les espaces de travail à remplacer', notSelected: 'Non sélectionné pour cette résolution', inspectCurrentVersions: 'Examiner les versions actuelles' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "fr">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "fr"> = { fr: {
        executable: 'Exécutable', regular: 'Non exécutable', applied: 'Appliqué', appliedPaused: 'Appliqué ; synchronisation en pause', changed: 'Modifié avant application', offline: 'Hors ligne ; non appliqué', cancelled: 'Annulé', unknown: 'Résultat inconnu ; inspectez ce point', failed: 'Échec ; non appliqué', recoveryNeeded: 'Récupération nécessaire à cet emplacement', inspectionUnavailable: 'Impossible d’inspecter les versions actuelles. Actualisez quand la machine de contrôle est accessible.', coverageIncomplete: 'Certains liens ou points ne sont pas vérifiés. Les conflits chargés restent visibles, mais la résolution est indisponible.', versions: 'Versions', comparison: 'Comparer les versions choisies', linkDecisions: 'Sélection par lien', result: 'Résultat', confirmTitle: 'Utiliser cette version ?', confirmBody: ({ path, source, count }) => `Utiliser la version de ${source} pour ${path} sur ${count} autres espaces de travail ? Happier vérifiera chaque version avant modification.`, useVersion: 'Utiliser la version', useNamedVersion: ({ name }) => `Utiliser ${name}`, compareNamedVersion: ({ name }) => `Comparer ${name}`, linkCount: ({ count }) => `${count} liens signalent ce chemin`, moreOnLink: ({ name }) => `Charger la suite de ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { fr: { selectionIncluded: 'Inclus par ce lien', selectionExcluded: 'Exclu par ce lien', selectionUnknown: 'Sélection inconnue', reasonRepositoryMetadata: 'Métadonnées du dépôt', reasonSubmodule: 'Sous-module Git', reasonConfiguredRule: 'Règle configurée', reasonGitIgnore: 'Règle Git ignore', reasonEndpointUnavailable: 'Point indisponible', reasonSelectionUnavailable: 'Évaluation de la sélection indisponible', configuredInclude: ({ pattern }) => `Motif d’inclusion : ${pattern}`, configuredExclude: ({ pattern }) => `Motif d’exclusion : ${pattern}`, completedLinks: ({ count }) => `${count} liens terminés avant le blocage` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "fr">;

const fr = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["fr"],
    review: workspaceSyncReviewTranslations["fr"],
    selection: workspaceSyncReviewSelectionTranslations["fr"],
    outcome: workspaceSyncReviewOutcomeTranslations["fr"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["fr"],
    decision: workspaceSyncReviewDecisionTranslations["fr"],
    coverage: workspaceSyncCoverageIncompleteTranslations["fr"],
    localOnly: workspaceSyncLocalOnlyTranslations["fr"],
    alternatives: workspaceSyncKeepAlternativesTranslations["fr"],
    addMachine: workspaceSyncAddMachineTranslations["fr"],
    attention: workspaceSyncSetAttentionTranslations["fr"],
}, {
    title: 'Synchronisation de l’espace de travail',
    footer: 'L’état provient de la machine qui gère cette relation. Les changements apparaissent uniquement après confirmation par cette machine.',
    legacyRecovery: {
        title: 'Données de synchronisation retirées',
        footer: 'Happier se contente d’inspecter et de mettre en quarantaine ces données retirées. L’application ne les supprime jamais.',
        checking: 'Vérification des machines…',
        inspectFailed: 'Certaines machines n’ont pas pu être vérifiées. Les dossiers de quarantaine déjà trouvés restent affichés ; réessaie lorsque ces machines sont joignables.',
        outdatedTitle: ({ machine }) => `${machine} utilise une ancienne version de Happier`,
        outdatedBody: 'Cette version ne peut pas rechercher les anciennes données de synchronisation. Mets Happier à jour sur cette machine, puis relance l’inspection ici.',
        explanation: 'Cette machine contient des données de l’ancien moteur de réplication. Happier a placé les données reconnues dans une quarantaine privée et désactivé la synchronisation pour empêcher l’ancien moteur de fonctionner.',
        quarantinePath: 'Dossier de quarantaine',
        openFolder: 'Ouvrir le dossier',
        offlineTitle: 'Les supprimer quand Happier est hors ligne',
        offlineSteps: ({ path }) => `1. Arrête tous les services Happier susceptibles d’utiliser ces données.\n2. Supprime exactement ce dossier avec ton système d’exploitation : ${path}\n3. Redémarre les services, puis relance l’inspection ici.`,
        unknown: ({ path, reason }) => `Happier n’a pas pu classer de façon sûre l’ancien état dans ${path} (${reason}). La synchronisation reste désactivée. Inspecte ce chemin manuellement ; ne le supprime pas depuis l’application.`,
        reinspect: 'Inspecter à nouveau',
    },
    none: 'Aucune relation de synchronisation',
    conflictsTitle: 'Conflits de l’espace de travail',
    openConflicts: ({ count }) => `Examiner la synchronisation sur ${count} liens`,
    noConflicts: 'Aucun conflit',
    previewUnavailable: 'La machine de contrôle n’a pas pu fournir un aperçu sûr. Actualise le conflit avant de réessayer.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'conflit supplémentaire n’est pas affiché' : 'conflits supplémentaires ne sont pas affichés'}`,
    unknownMode: 'Mode de synchronisation non pris en charge',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'conflit' : 'conflits'}`,
    conflictKind: { file: 'Fichier', directory: 'Dossier', symlink: 'Lien symbolique', missing: 'Absent', unsupported: 'Élément non pris en charge' },
    mode: { copyOnce: 'Copier une fois', keepSynced: 'Maintenir à jour — recommandé', mirrorExactly: 'Reproduire à l’identique', keepBothInSync: 'Garder les deux synchronisés' },
    state: { loading: 'Vérification de l’état…', starting: 'Préparation', watching: 'Surveillance', flushing: 'Synchronisation', paused: 'En pause', peerOffline: 'Hors ligne', conflicted: 'Conflits', controllerUnavailable: 'Attention requise', engineUnavailable: 'Composant indisponible', error: 'Attention requise', stopped: 'Arrêté', working: 'Traitement en cours…' },
    lastChecked: ({ at }) => `Dernière vérification : ${at}`,
    endpoint: { source: ({ label }) => `Source · ${label}`, destination: ({ label }) => `Destination · ${label}`, synced: ({ label }) => `Point synchronisé · ${label}` },
    error: {
        componentUnavailable: 'La synchronisation de l’espace de travail n’est pas disponible dans cette version. Installe le composant requis, puis réessaie.',
        machineOffline: 'La machine de destination est indisponible. Reconnecte-la, puis réessaie.',
        destinationNeedsPreparation: 'Le dossier de destination doit être préparé avant le début de la synchronisation.',
        gitPreparationFailed: 'Happier n’a pas pu préparer cet espace de travail Git. Vérifie la destination et réessaie.',
        authorizationExpired: 'L’autorisation de l’espace de travail a expiré. Relance l’opération.',
        rootNoLongerAuthorized: 'Le dossier de l’espace de travail a changé et n’est plus autorisé. Vérifie la relation avant de réessayer.',
        conflictNeedsAttention: 'Ce conflit a changé. Actualise-le avant de choisir une version.',
        needsAttention: 'La synchronisation de l’espace de travail nécessite ton attention. Actualise son état, puis réessaie.',
    },
    start: { blocked: {
        targetMachine: 'Choisis une machine de destination pour continuer.',
        targetMachineOffline: 'Cette machine est indisponible pour le moment. Reconnecte-la, puis réessaie.',
        relationshipUnavailable: 'Cette relation de synchronisation ne couvre plus ces deux dossiers. Choisis une autre option pour l’espace de travail.',
        sourceFolder: 'Le dossier de cette session ne peut pas être synchronisé en toute sécurité. Choisis « Ne pas déplacer les fichiers » pour transférer uniquement la session.',
        destinationFolder: 'Choisis un dossier de destination valide.',
        workspaceOptions: 'Vérifie les options de l’espace de travail avant de commencer.',
    } },
    engine: { checking: 'Vérification de la synchronisation sur cette machine…' },
    actions: { refresh: 'Actualiser l’état', syncNow: 'Synchroniser maintenant', more: 'Actions de synchronisation', pause: 'Mettre en pause', resume: 'Reprendre', terminate: 'Arrêter la synchronisation', openOnMachine: ({ machine }) => `Ouvrir sur ${machine}`, openFolder: ({ label }) => `Ouvrir le dossier ${label}`, keepLocal: 'Conserver la version locale', keepRemote: 'Conserver la version distante', keepNamed: ({ side }) => `Conserver la version de ${side}` },
    terminate: { title: 'Supprimer la synchronisation de l’espace de travail ?', body: 'La synchronisation s’arrêtera et sa relation sera supprimée. Les fichiers resteront dans les deux espaces de travail.' },
    resolve: {
        changedTitle: 'Le conflit a changé',
        changedBody: 'Ce conflit a changé depuis son ouverture. La liste a été actualisée. Vérifie les dernières versions avant de choisir à nouveau.',
        consequence: 'L’autre version sera supprimée uniquement après que Happier aura vérifié que le fichier n’a pas changé.',
        unsupported: 'Ce conflit contient un élément de système de fichiers non pris en charge et ne peut pas être résolu dans Happier. Supprime ou remplace cet élément sur la machine concernée, puis actualise.',
        keepHint: ({ side }) => `Conserver la version de ${side} et supprimer l’autre version vérifiée.`,
    },
    fileState: { text: 'Aperçu du texte', binary: 'Fichier binaire — aperçu indisponible', tooLarge: 'Le fichier est trop volumineux pour être prévisualisé', missing: 'Fichier absent', changed: 'Le fichier a changé depuis l’affichage de ce conflit' },
});

const workspaceSyncTranslations = { fr } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "fr">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { fr: en };

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
