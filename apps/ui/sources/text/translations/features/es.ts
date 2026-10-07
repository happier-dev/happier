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

const accountDisplayTranslations = { es: { unnamed: 'Cuenta sin nombre', yours: 'Tu cuenta', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "es">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const es: Copy = {
    recoverAutomationTemplates: 'Recuperar disparadores anteriores',
    recoverAutomationTemplatesDescription: 'Usa las claves de este dispositivo para recuperar disparadores anteriores. Se conservan mientras las sesiones cifradas o los disparadores bloqueados las necesiten.',
    recoverAutomationTemplatesAction: 'Recuperar',
    recoverAutomationTemplatesComplete: 'Disparadores recuperados. La clave anterior permanece en este dispositivo hasta que decidas olvidarla.',
    recoverAutomationTemplatesRetained: 'Recuperación comprobada. Algunos disparadores siguen cifrados, bloqueados o modificados. La clave anterior permanece en este dispositivo.',
    forgetEncryptionKey: 'Olvidar la clave de cifrado anterior',
    forgetEncryptionKeyDescription: 'Las sesiones cifradas anteriores se bloquean en este dispositivo.',
    forgetEncryptionKeyAction: 'Olvidar',
    forgetEncryptionKeyConfirm: '¿Olvidar la clave de cifrado anterior?',
    forgetEncryptionKeyWarning: ({ items }) => `Las sesiones cifradas anteriores se bloquean en este dispositivo. Este historial cifrado puede quedar inaccesible:\n\n${items}\n\nLa lista refleja el historial actual. Las sesiones cifradas creadas después en otro dispositivo también se bloquean. Restaura la clave anterior para desbloquearlas. No se elimina nada de tu cuenta.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sesión: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Disparador: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Historial de ejecución: ${id}`,
    forgetEncryptionKeyEmpty: 'No se encontró historial cifrado.',
    forgetEncryptionKeyComplete: 'Se olvidó la clave anterior en este dispositivo.',
    forgetEncryptionKeyFailed: 'No se pudo olvidar la clave. Vuelve a conectarte e inténtalo de nuevo; primero hay que listar el historial cifrado.',
};

const accountEncryptionRecoveryTranslations = { es } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { es: {
        pageTitle: 'Cuenta y Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `No vinculado con ${service}`,
        serviceUnavailable: ({ service }) => `No se puede conectar con ${service}`,
        signedInToThisHome: 'Sesión iniciada en este Home',
        checkingSignIn: 'Comprobando el inicio de sesión…',
        signInStatusUnavailable: 'Estado de inicio de sesión no disponible',
        machinesOnline: ({ online, total }) => `${online} de ${total} ${total === 1 ? 'máquina' : 'máquinas'} en línea`,
        noMachines: 'Aún no hay máquinas',
        connectedNoMachinesOnline: 'Conectado · ninguna máquina en línea',
        cantReach: 'No se puede conectar',
        signedOut: 'Sesión cerrada',
        signIn: 'Iniciar sesión',
        link: 'Vincular',
        linkSubtitle: 'Encuentra tus Homes en todos tus dispositivos',
        manageHomes: 'Gestionar Homes',
        connectionDetails: 'Detalles de conexión',
        allHomes: 'Todos los Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · una sola lista`,
        addHome: 'Añadir un Home…',
        addDevice: 'Añadir un dispositivo',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "es">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const es = {
    title: 'Inicia sesión para encontrar tus Homes',
    cancelNote: 'Cancelar no cerrará la sesión de tus Homes existentes.', focusedHomePreserved: 'Tu Home enfocado no cambiará.',
    stages: { signingIn: 'Iniciando sesión', findingHomes: 'Buscando tus Homes', waitingApproval: 'Esperando la aprobación del Home' },
    errors: { provider: { title: 'El proveedor no completó el inicio de sesión', body: 'Vuelve a iniciar sesión.' }, expired: { title: 'Esta solicitud de inicio de sesión ha caducado', body: 'Vuelve a iniciar sesión.' }, identityChanged: { title: 'La identidad del servicio de inicio de sesión ha cambiado', body: 'Comprueba que es el servicio de inicio de sesión que querías usar antes de volver a conectarte.' }, unavailable: { title: 'El servicio de inicio de sesión no está disponible', body: 'Comprueba el servicio e inténtalo de nuevo. Tus Homes existentes no cambiarán.' }, exchange: { title: 'No se pudo completar el inicio de sesión', body: 'No se guardaron credenciales del servicio de inicio de sesión. Vuelve a iniciar sesión.' }, storage: { title: 'No se pudo guardar el inicio de sesión', body: 'Las credenciales de tus Homes existentes no cambiarán. Vuelve a iniciar sesión.' }, homeLink: { title: 'Sesión iniciada, pero no se pudo vincular este Home', body: 'Tu inicio de sesión está guardado. Intenta vincular este Home de nuevo.' }, directoryRefresh: { title: 'Sesión iniciada, pero no pudimos actualizar tu lista de Homes', body: 'La conexión del servicio de inicio de sesión está lista. Intenta actualizar tu lista de Homes de nuevo.' }, homeEnrollment: { title: 'Sesión iniciada, pero tu Home personal no se añadió', body: 'Tu inicio de sesión está guardado. Intenta añadir el Home de nuevo.' }, invalid: { title: 'Esta solicitud de inicio de sesión ya no es válida', body: 'Vuelve a iniciar sesión.' }, accountDisabled: { title: 'Esta cuenta está desactivada', body: 'Contacta con quien administra tu servicio de inicio de sesión. Tus Homes existentes no cambiarán.' } },
    actions: { startAgain: 'Empezar de nuevo', openHome: ({ homeName }: { homeName: string }) => `Abrir ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} está conectado`, body: 'Tu inicio de sesión está guardado y este Home está listo para usarse.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} aún no está vinculado a esta cuenta`, signInAction: ({ homeName }: { homeName: string }) => `Iniciar sesión en ${homeName}`, body: ({ homeName }: { homeName: string }) => `Inicia sesión directamente en ${homeName}, o escanea su código QR o pega su enlace de Home.`, scanBody: ({ homeName }: { homeName: string }) => `Escanea el código QR de ${homeName} o pega su enlace de Home para conectarlo.` },
    noHomes: { body: 'Esta cuenta aún no tiene Homes. Actualiza después de añadir uno en otro lugar, o escanea el código QR de un Home o pega su enlace de Home.' },
    approvalWait: { waitingBody: 'Aprueba este inicio de sesión desde tu otro dispositivo con sesión iniciada.', cancelledTitle: 'Se dejó de esperar la aprobación', cancelledBody: 'Tu inicio de sesión sigue guardado y tus Homes existentes no cambian.' },
} as const;

const accountServiceOAuthTranslations = { es } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { es: {
        requestedByAgent: 'Acción solicitada por el agente de la sesión',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Sesión de destino: ${sessionId}`,
        oneShotConsequence: 'La aprobación se aplica solo a esta solicitud. No concede permisos futuros de Action ni permisos nativos.',
        homeUnavailable: 'Esta aprobación pertenece a un Home que no está disponible en este dispositivo. Vuelve a conectar ese Home para decidir.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "es">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "es": {
        textInFiles: "Texto en archivos",
        everything: "Todo",
        refineSearch: "Refina tu búsqueda",
        partial: "No se pudieron buscar algunos archivos. Los resultados están incompletos.",
        updateRequired: "Actualiza Happier en esta máquina para buscar texto en archivos.",
        invalidPattern: "La expresión regular no es válida. Edita el patrón e inténtalo de nuevo.",
        unavailable: "La búsqueda de texto no está disponible. Comprueba la conexión de la máquina e inténtalo de nuevo.",
        placeholder: "Buscar archivos, mensajes, commits, sesiones, ajustes y acciones",
        matchCase: "Distinguir mayúsculas",
        regex: "Expresión regular",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "es": {
        "partialHistory": "Enviados antes solo incluye sesiones conocidas.",
        "loadedHistory": "Enviados antes solo muestra mensajes cargados.",
        "open": "Abrir prompts",
        "menu": "Prompts…",
        "placeholder": "Buscar prompts y mensajes enviados",
        "favorites": "Favoritos",
        "library": "Biblioteca",
        "sentBefore": "Enviados antes",
        "builtIn": "Integrado",
        "readError": "No se pudo leer este prompt. Inténtalo de nuevo.",
        "libraryError": "No se pudo cargar la biblioteca.",
        "partialLibrary": "No se pudieron leer algunos prompts.",
        "loadOlder": "Buscar mensajes anteriores",
        "stop": "Detener",
        "insert": "Insertar",
        "send": "Enviar ahora",
        "addFavorite": "Añadir a favoritos",
        "removeFavorite": "Quitar de favoritos",
        "empty": "Guarda un mensaje como prompt para reutilizarlo aquí.",
        "applyError": "No se pudo aplicar el prompt. Inténtalo de nuevo.",
        "historyError": "No se pudieron cargar los mensajes anteriores. Inténtalo de nuevo.",
        "title": "Prompts",
        "clear": "Borrar",
        "favorite": "Favorito",
        "favoritesInvite": "Marca con una estrella un prompt o algo que enviaste para tenerlo aquí.",
        "saveAsFavorite": "Guardar como prompt favorito",
        "saveInPlaceStarred": ({ time }: { time: string }) => `De tu mensaje de ${time} · va a tu biblioteca, con estrella`,
        "saveInPlace": ({ time }: { time: string }) => `De tu mensaje de ${time} · va a tu biblioteca`,
        "noMatchesFor": ({ query }: { query: string }) => `Ningún prompt ni mensaje cargado coincide con «${query}»`,
        "previewInserts": "se inserta y luego lo envías",
        "previewSent": "enviado antes",
        "previewEdited": ({ time }: { time: string }) => `Editado ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Buscando mensajes anteriores… ${searched} de ${total} sesiones`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { es: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.es.textInFiles,
            find: 'Buscar',
            app_shell: 'Workspace',
            roles: 'Roles de agente',
            launch_profiles: 'Perfiles de inicio',
            discovery: 'Descubrimiento de acciones',
            computer: 'Control del ordenador',
            artifact_access: 'Uso compartido de artefactos',
            workflows: 'Flujos de trabajo',
            notifications: 'Notificaciones',
            machine_agent_install: 'Instalaciones de agentes',
            machine_agent_sign_in: 'Inicio de sesión de agentes',
            session_access: 'Uso compartido de sesiones',
            session_lifecycle: 'Ciclo de vida de las sesiones',
            inventory: 'Inventario de ordenadores',
            messaging: 'Mensajería',
            session_control: 'Controles de sesión',
            intent_start: 'Revisiones y delegación',
            review_comments: 'Comentarios de revisión',
            subagent_registry: 'Subagentes',
            execution_run_control: 'Ejecuciones en segundo plano',
            session_targeting: 'Selección de sesiones',
            session_follow: 'Seguimiento de sesiones',
            session_transcripts: 'Transcripciones de sesiones',
            session_read_state: 'Estado de lectura',
            session_attention: 'Atención',
            session_board: 'Tablero de sesiones',
            session_discussion: 'Conversaciones',
            session_permissions: 'Permisos de sesión',
            external_sessions: 'Sesiones externas',
            voice_controls: 'Controles de voz',
            current_ui_context: 'Pantalla actual',
            companion_controls: 'Acompañante',
            memory: 'Memoria',
            agent_acp_catalog: 'Agentes ACP',
            prompt_library: 'Biblioteca de prompts',
            daemon_admin: 'Administración del daemon',
            browser_control: 'Control del navegador',
            browser_diagnostics: 'Diagnóstico del navegador',
            browser_context: 'Contexto del navegador',
            browser_automation: 'Automatización del navegador',
            browser_recording: 'Grabación del navegador',
            local_services_inventory: 'Servicios locales',
            local_services_launcher: 'Lanzador de servicios',
            local_services_preview: 'Vistas previas de servicios',
            local_services_public_preview: 'Vistas previas públicas',
            local_services_actions: 'Acciones de servicios',
            peer_mediation_observability: 'Diagnóstico de conexiones',
            devices_simulator: 'Simuladores',
            approvals: 'Aprobaciones',
            plugin_dev_loop: 'Desarrollo de plugins',
            plugin_settings_administration: 'Ajustes de plugins',
            plugin_permission_grants: 'Permisos de plugins',
            plugin_webhooks: 'Webhooks de plugins',
            account_plugin_data: 'Datos de plugins',
            account_sessions: 'Dispositivos con sesión iniciada',
            account_security: 'Seguridad de la Cuenta',
            account_api_tokens: 'Tokens de API',
            identity_github_apps: 'Apps de GitHub',
            identity_providers: 'Proveedores de inicio de sesión',
            machine_pools: 'Grupos de ordenadores',
            ephemeral_runner: 'Ejecutores',
            automation_events: 'Eventos de automatización',
            automation_conversation: 'Conversaciones de automatización',
            scm_git: 'Git',
            scm_pull_request: 'Solicitudes de incorporación',
            scm_repository: 'Repositorios',
            scm_diff_summary: 'Resúmenes de cambios',
            home_governance: 'Administración del Home',
            teams: 'Equipos',
            saved_secret_sharing: 'Secretos compartidos',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { es: {
        addHome: 'Añadir un Home',
        addHomeSubtitle: 'Inicia sesión, conéctate por dirección o usa uno alojado',
        addHomeDescription: 'Conecta un Home que ya usas o usa uno alojado para ti.',
        newGroup: 'Nuevo grupo',
        newGroupSubtitle: 'Ver juntas las sesiones de varios Homes',
        groupsTitle: 'Grupos',
        homesInUse: 'En uso aquí',
        thisDeviceTitle: 'Este dispositivo',
        thisDeviceSubtitle: 'Cómo llega a sus Homes',
        thisDeviceDescription: 'Cómo llega este dispositivo a sus Homes: dispositivos en espera, la conexión que usa y el Home que ejecuta.',
        newHomeDraft: 'Nuevo Home',
        homeMissingTitle: 'Este Home no está en este dispositivo',
        homeMissingDescription: 'Se eliminó o se guardó en otro dispositivo.',
        homeManageTitle: 'Gestionar',
        homeAdministrationSubtitle: 'Personas, inicio de sesión, alcance y datos de este Home',
        groupMissingTitle: 'Este grupo ya no existe',
        groupMissingDescription: 'Se eliminó. Tus Homes no han cambiado.',
        discard: 'Descartar',
        sshSignInAgent: 'Tu agente SSH en este ordenador',
        sshSignInKeyFile: 'Un archivo de clave privada en este ordenador',
        sshSignInPassword: 'Se usa una vez para conectar; nunca se guarda',
        addMachineMenuSubtitle: 'Un ordenador o un servidor',
        addMachineDescription: 'Añade un ordenador o servidor para que los agentes ejecuten allí tus sesiones.',
        machineJoinsHome: ({ home }) => `Se une a ${home}`,
        pathThisComputerTitle: 'Este ordenador',
        pathThisComputerTask: 'Configúralo en un paso',
        pathThisComputerCommand: 'Un comando en tu terminal',
        pathSshTitle: 'Un servidor por SSH',
        pathSshChip: 'Servidor SSH',
        pathSshSubtitle: 'Una máquina de desarrollo, VM o servidor en la nube',
        pathAnotherTitle: 'Otro ordenador',
        pathAnotherSubtitle: 'Abre un enlace al Hogar en ese ordenador',
        machinePoolPrompt: '¿Quieres que las sesiones pasen de una máquina a otra?',
        thisComputerCommandLead: ({ home }) => `Ejecuta esto en un terminal de este ordenador. Instala Happier y se une a ${home}; esta página lo detecta en cuanto está listo.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} ejecutará agentes para ${home}. Happier instala un pequeño servicio en segundo plano que se inicia con el ordenador.`,
        setUpThisComputer: 'Configurar este ordenador',
        desktopAppHint: '¿Prefieres hacer clic a escribir?',
        desktopAppLink: 'Descarga la app de escritorio: configura este ordenador por sí sola.',
        thisComputerRunningLead: ({ machine }) => `Configurando ${machine}. Puedes seguir usando Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} está conectado a otro Home`,
        onAnotherHomeBody: ({ home }) => `Su servicio Happier ejecuta sesiones para otro Home. Moverlo a ${home} conserva sus ajustes; las sesiones que ya existen se quedan allí.`,
        moveToHome: ({ home }) => `Moverlo a ${home}`,
        keepOnOtherHome: 'Dejarlo donde está',
        sshLeadTask: ({ home }) => `Una máquina de desarrollo, VM o servidor en la nube al que ya llegas por SSH. Este ordenador se conecta, instala Happier y se une a ${home}.`,
        sshLeadCommand: ({ home }) => `Una máquina de desarrollo, VM o servidor en la nube al que ya llegas por SSH. Ejecuta el comando en un ordenador que llegue a él; instala Happier y se une a ${home}.`,
        setUpHost: ({ host }) => `Configurar ${host}`,
        sshSavedNote: 'El host se guarda en Hosts remotos; las contraseñas nunca.',
        sshRunningTitle: ({ host }) => `Configurando ${host}`,
        sshRunningLead: 'Se ejecuta por SSH desde este ordenador. Puedes irte; la lista de máquinas muestra el progreso y te avisa al terminar.',
        anotherLead: ({ home }) => `Ejecuta esto en un terminal de ese ordenador. Instala Happier y se une a ${home}.`,
        anotherTerminalAction: 'Usar un comando de terminal en su lugar',
        machineWatching: ({ subject }) => `Esperando ${subject} en `,
        subjectThisComputer: 'este ordenador',
        subjectAnotherComputer: 'el ordenador',
        machineNotSeeingTitle: ({ subject }) => `¿Aún no aparece ${subject}?`,
        machineNotSeeingBody: ({ home }) => `Happier sigue esperando. Normalmente la configuración terminó con un error, la máquina no llega a ${home} o se configuró para otro Home.`,
        machineArrived: ({ machine }) => `${machine} está conectado`,
        machineConnectedJustNow: 'conectado ahora mismo',
        machineStartSession: ({ machine }) => `Iniciar una sesión en ${machine}`,
        machineAddAnother: 'Añadir otra',
        cancelSetup: 'Cancelar',
        detectedOs: 'Detectado',
        sshSuggestionsTitle: 'De tu configuración SSH y hosts guardados',
        connectingToHome: ({ address }) => `Conectando con ${address}…`,
        pathThisComputerConnected: 'Conectado · ver sus agentes',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "es">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { es: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const es: typeof en = {
    titles: {
        conversation: 'Una conversación aparte',
    },
    descriptions: {
        conversation: ({ machine }) => `Pregunta lo que quieras sin interrumpir esta sesión. Se ejecuta en ${machine} a su lado; no vuelve nada a menos que lo envíes.`,
    },
    chips: {
        engineTitle: 'Quién responde',
        addReviewer: 'Añadir revisor',
        removeReviewer: ({ name }) => `Quitar a ${name}`,
        scope: 'Qué revisar',
        advanced: 'Avanzado',
    },
    reportToSession: 'Informar a esta sesión',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} revisiones empiezan al enviar` : 'Empieza al enviar',
    offline: ({ machine }) => `${machine} está sin conexión. El agente empieza allí; tu borrador se queda aquí hasta que vuelva.`,
    menu: {
        askSection: 'Pedir a un agente',
        secondOpinionTitle: 'Segunda opinión',
        secondOpinionSubtitle: 'Una comprobación independiente antes de terminar',
        keepGoingTitle: 'Seguir hasta terminar…',
        keepGoingSubtitle: 'Fija un objetivo en el control de objetivo',
        runWorkflowTitle: 'Ejecutar un flujo de trabajo',
        runWorkflowSubtitle: 'De tu biblioteca o uno integrado',
        searchWorkflows: 'Buscar flujos de trabajo…',
        yourLibrary: 'Tu biblioteca',
        noWorkflows: 'Aún no hay flujos guardados',
        addTriggerTitle: 'Añadir un disparador…',
        addTriggerSubtitle: 'Se ejecuta aquí cada vez que pasa algo',
        advancedTitle: 'Avanzado…',
        advancedSubtitle: 'Varios agentes, permisos, perfil',
        builtIn: 'Integrados',
        allWorkflows: 'Todos los flujos de trabajo…',
    },
    role: {
        replaces: ({ agent }) => `Sustituye a ${agent}`,
    },
    startRow: {
        subtitle: 'Borrador · empieza al enviar',
        conversation: 'Nueva conversación',
        review: 'Nueva revisión',
        plan: 'Nuevo plan',
        delegate: 'Nueva tarea',
    },
    pane: {
        cancelRun: 'Cancelar ejecución',
        whenItFinishes: 'Cuando termine',
        sendToSession: ({ session }) => `Enviar a ${session}`,
        replyTo: ({ agent }) => `Responder a ${agent}…`,
        repliesGoTo: ({ session }) => `Las respuestas van a este agente, no a ${session}`,
    },
};

const agentStartTranslations = { es };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { es: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Acceso al cifrado",
                consequence: "Concede acceso al cifrado de toda la cuenta. La revocación detiene futuras autorizaciones de API; no se pueden recuperar las claves o los datos ya obtenidos.",
                enabled: "Acceso al cifrado activado",
                bearerOnly: "Solo acceso a la API",
                unknown: "Acceso al cifrado no disponible",
                outcomeUnknown: "La creación puede haberse completado. Actualiza la lista y revoca este token antes de crear otro deliberadamente.",
                unsupported: "Este Home aún no admite tokens de API cifrados. Actualízalo o crea un token normal.",
                notReady: "Restaura el acceso al cifrado en este Home antes de crear un token cifrado.",
                stale: "La clave de cifrado de la cuenta cambió. Restaura el acceso en este Home.",
                idConflict: "Este ID de token ya existe. Revoca ese token exacto antes de crear otro.",
            },
            unattended: {
                choice: "Acceso desatendido al equipo",
                consequence: "Copia en este token los métodos de autenticación actualmente verificados de esta credencial para trabajo restringido del equipo. El acceso de cifrado es independiente.",
                authorized: "Acceso desatendido al equipo autorizado",
                notAuthorized: "Sin acceso desatendido al equipo",
                evidenceLimit: "Esta credencial tiene demasiados métodos de autenticación verificados para copiarlos. No se creó ningún token.",
                evidenceUnavailable: "Esta credencial con sesión iniciada no tiene evidencia de autenticación actual para copiar. Vuelve a autenticarte con el método requerido; no se creó ningún token.",
            },
            title: 'Tokens de API',
            entrySubtitle: 'Permite que scripts, servidores y apps insertadas actúen por ti, solo con el acceso que les des.',
            tokens: 'Tokens de API',
            refreshing: 'Actualizando…',
            emptyTitle: 'Aún no hay tokens de API',
            emptyBody: 'Los tokens permiten que scripts y herramientas de confianza realicen las acciones automatizadas que permitas. Crea un token cuando una integración necesite acceso a tu Cuenta actual.',
            created: 'Creado',
            lastUsed: 'Último uso',
            neverUsed: 'Nunca se usó',
            securityTitle: 'Seguridad',
            securityFooter: 'Estas acciones tienen efecto en toda la Cuenta actual.',
            status: {
                active: 'Activo',
                expiresInMinutes: ({ count }) => `Caduca en ${count} min`,
                expiresInHours: ({ count }) => `Caduca en ${count} h`,
                expiresInDays: ({ count }) => `Caduca en ${count} d`,
                expired: 'Caducado',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, estado: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Más acciones para ${label}`,
            create: {
                button: 'Crear token',
                title: 'Crear token de API',
                subtitle: 'Nombra la integración y elige cuándo caduca este token. Tu Home puede leer las solicitudes y los resultados de la API ordinaria; el acceso al cifrado puede proteger las llamadas del SDK compatibles.',
                submit: 'Crear token',
                label: 'Etiqueta',
                labelPlaceholder: 'Automatización de lanzamientos',
                expiry: 'Caduca',
                expiryOptions: {
                    '30d': '30 días',
                    '90d': '90 días',
                    '1y': '1 año',
                    none: 'Sin caducidad',
                },
                access: 'Acceso',
                accessFull: 'Acceso completo',
                accessLimited: 'Limitado',
                accessLimitedDescription: 'A continuación, elige acciones, sesiones, modelos y sitios web.',
                accessTitle: 'Elige el acceso',
                continue: 'Continuar',
                back: 'Atrás',
                actionSettingsPrefix: 'Este token puede realizar cualquier operación habilitada para API externa y SDK en tu',
                actionSettingsLink: 'Configuración de acciones.',
            },
            reveal: {
                title: 'Guarda tu token de API',
                accessibilityAnnouncement: 'Copia tu token ahora; solo se muestra una vez.',
                successTitle: 'Token creado',
                shownOnce: 'Copia este token ahora. Por tu seguridad, Happier no puede volver a mostrarlo.',
                copy: 'Copiar token',
                copied: 'Copiado',
                dismissTitle: '¿Salir sin confirmar?',
                dismissBody: 'Este token no se volverá a mostrar. Cópialo primero o confirma que lo guardaste en un lugar seguro.',
                copyFirst: 'Mantener el token visible',
                savedIt: 'Lo guardé',
            },
            revoke: {
                title: ({ label }) => `¿Revocar «${label}»?`,
                body: 'El acceso al servidor y a la API se detendrá en la siguiente verificación. Un daemon local que haya verificado recientemente este token de API podría seguir aceptándolo hasta un minuto. Esta acción no se puede deshacer.',
                confirm: 'Revocar token',
            },
            revokeAll: {
                title: 'Revocar todos los tokens de API',
                subtitle: 'Desactiva todos los tokens de API de esta Cuenta.',
                body: 'El acceso al servidor y a la API se detendrá en la siguiente verificación. Las inserciones que usen estos tokens dejarán de funcionar y se cerrará la sesión de sus credenciales insertadas. Los daemons locales que hayan verificado recientemente estos tokens de API podrían seguir aceptándolos hasta un minuto. Esta acción no se puede deshacer.',
                confirm: 'Revocar todos',
                railAction: 'Revocar todos los tokens de API…',
            },
            signOutEverywhere: {
                title: 'Cerrar sesión en todas partes',
                subtitle: 'Finaliza todas las sesiones iniciadas de esta Cuenta.',
                body: 'Finalizarán todas las sesiones iniciadas en navegadores y dispositivos. Los tokens de API seguirán activos; revócalos por separado desde esta pantalla.',
                confirm: 'Cerrar sesión en todas partes',
            },
            errors: {
                labelRequired: 'Introduce una etiqueta antes de crear el token.',
                accountChanged: 'Tu cuenta o Home activo cambió, así que no se cambió nada. Vuelve a abrirlo para continuar.',
                presentUserRequired: 'Confirma tu identidad en el aviso de inicio de sesión y vuelve a intentarlo.',
                offline: 'Happier no pudo acceder a tu Cuenta. Comprueba la conexión y vuelve a intentarlo.',
                unavailable: 'Esta acción no está disponible ahora mismo. Vuelve a intentarlo en un momento.',
                copyFailed: 'No se pudo copiar el token. Selecciónalo y cópialo manualmente antes de cerrar.',
                listTitle: 'Tokens de API no disponibles',
                grantIncomplete: 'Termina de elegir el acceso antes de crear el token.',
            },
            embedPill: 'Inserción',
            embedRowHint: 'Abre esta inserción en Configuración, Inserciones.',
            summary: {
                full: 'Acceso completo',
                allActions: 'Todas las acciones',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 sesión' : `${count} sesiones`),
                computers: ({ count }) => (count === 1 ? '1 ordenador' : `${count} ordenadores`),
                approve: 'Puede aprobar',
                models: ({ count }) => (count === 1 ? '1 modelo' : `${count} modelos`),
                websites: ({ count }) => (count === 1 ? '1 sitio web' : `${count} sitios web`),
                content: 'Acceso al contenido',
                noExpiry: 'Sin caducidad',
                expires: ({ date }) => `Caduca el ${date}`,
                expired: ({ date }) => `Caducó el ${date}`,
            },
            grant: {
                accessTitle: 'Acceso',
                back: 'Acceso',
                onlyThese: 'Solo estos',
                selectedCount: ({ count }) => (count === 1 ? '1 seleccionado' : `${count} seleccionados`),
                reviewUnnamed: 'Este token',
                actions: {
                    title: 'Acciones',
                    all: 'Todas las acciones',
                    none: 'Elige al menos una acción',
                    search: 'Buscar acciones',
                    noMatches: ({ query }) => `Ninguna acción coincide con «${query}»`,
                    groupDescription: 'Un grupo completo también incluye las acciones que se le añadan más adelante.',
                    familyCount: ({ count }) => (count === 1 ? 'Grupo · 1 acción' : `Grupo · ${count} acciones`),
                    includedByFamily: ({ family }) => `Incluida en ${family}`,
                },
                targets: {
                    title: 'Sesiones y ordenadores',
                    all: 'Todas las sesiones y ordenadores',
                    none: 'Elige al menos una sesión o un ordenador',
                    computers: 'Ordenadores',
                    computersDescription: 'Un ordenador incluye todas sus sesiones, ahora y en el futuro.',
                    sessions: 'Sesiones',
                    searchSessions: 'Buscar sesiones',
                    noSessions: 'Aún no hay sesiones',
                    noSessionMatches: ({ query }) => `Ninguna sesión coincide con «${query}»`,
                    noComputers: 'Aún no hay ordenadores',
                },
                models: {
                    title: 'Modelos',
                    any: 'Cualquier modelo',
                    onlyThese: 'Solo estos modelos',
                    none: 'Elige al menos un modelo',
                    pickerDescription: 'Los demás modelos se rechazan, no solo se ocultan. «Automático» no se ofrece cuando eliges modelos.',
                    noModels: 'Aún no hay modelos para elegir',
                },
                approve: {
                    title: 'Aprobar solicitudes',
                    on: 'Puede aprobar el uso de herramientas y las solicitudes en las sesiones anteriores, incluidas las que haya iniciado él mismo. Nunca puede cambiar tokens, la seguridad ni los plugins.',
                    off: 'Las solicitudes te esperan en Happier.',
                },
                websites: {
                    title: 'Sitios web',
                    description: 'Las páginas de estos sitios pueden usar el token desde un navegador. Déjalo vacío para scripts y servidores.',
                    inputLabel: 'Añadir un sitio web',
                    placeholder: 'https://app.example.com',
                    add: 'Añadir',
                    invalid: 'Empieza con https://, o http:// para localhost.',
                    duplicate: 'Este sitio web ya está en la lista.',
                    remove: ({ origin }) => `Quitar ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Qué puede hacer',
                whatItCanDoDescription: 'Acciones que este token puede ejecutar por ti. Todo lo demás se rechaza.',
                everyAction: 'Todas las acciones habilitadas para API externa y SDK',
                wholeGroup: 'Grupo completo',
                where: 'Dónde',
                whereDescription: 'Sesiones y ordenadores a los que puede acceder.',
                computerCovers: 'Todas las sesiones de este ordenador',
                unknownComputer: 'Un ordenador que ya no aparece en la lista',
                unknownSession: 'Una sesión que ya no aparece en la lista',
                modelsDescription: 'Los demás modelos se rechazan, no solo se ocultan.',
                approvals: 'Aprobaciones',
                approvesOn: 'Aprueba solicitudes',
                approvesOff: 'No aprueba solicitudes',
                websitesDescription: 'Las páginas de estos sitios pueden usarlo desde el navegador.',
                noWebsites: 'Solo scripts y servidores',
                content: 'Acceso al contenido',
                contentOn: 'Puede leer contenido cifrado de extremo a extremo mediante llamadas del SDK compatibles.',
                contentOff: 'No puede leer contenido cifrado de extremo a extremo.',
                children: 'Credenciales insertadas',
                childrenDescription: 'Claves de corta duración que tu app generó a partir de este token para sus páginas.',
                childrenCount: ({ count }) => (count === 1 ? '1 activa' : `${count} activas`),
                childrenConsequence: 'Se cierra su sesión cuando editas el acceso o revocas este token.',
                sessionLimits: 'Sesiones',
                sessionLimitsDescription: 'Las sesiones que puede iniciar y los modos de permiso que pueden usar sus mensajes.',
                createsSessions: 'Inicia sesiones',
                createsSessionsOn: ({ computer }: { computer: string }) => `En ${computer}, en una carpeta privada que gestiona Happier.`,
                editAccess: 'Editar acceso',
                revokeFootnote: 'Los scripts e inserciones que lo usan dejan de funcionar en su siguiente solicitud.',
                created: ({ date }) => `Creado el ${date}`,
                lastUsed: ({ date }) => `Último uso: ${date}`,
                missingTitle: 'Este token ya no existe',
                missingBody: 'Se revocó o caducó y se eliminó. Tus otros tokens siguen en la lista.',
                backToTokens: 'Mostrar tokens de API',
            },
            edit: {
                title: 'Editar acceso',
                save: 'Guardar',
                signsOut: 'Se cerrará la sesión de las credenciales insertadas activas.',
            },
            cliPolicy: {
                sectionTitle: 'CLI y daemon',
                sectionDescription: 'Lo que pueden hacer los comandos de tus ordenadores con tu inicio de sesión.',
                title: 'Permitir aprobaciones y cambios en la Cuenta desde la CLI y el daemon',
                description: 'Permite que los comandos de tus ordenadores aprueben solicitudes y cambien la configuración de la Cuenta. Desactívalo si hay agentes que se ejecutan con acceso a la shell. Un ordenador también puede excluirse con HAPPIER_CLI_PRESENT_USER=disallowed. Cambiarlo reconecta brevemente tus ordenadores.',
                unavailable: 'No se pudo leer este ajuste. Inténtalo de nuevo en un momento.',
                saveFailed: 'No se pudo cambiar este ajuste. Inténtalo de nuevo en un momento.',
            },
            notices: {
                revoked: 'Token de API revocado.',
                revokedAll: 'Se revocaron todos los tokens de API.',
                signedOutEverywhere: 'Sesión cerrada en todas partes. Los tokens de API siguen activos.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { es: {
        description: 'Lo que tú y tus agentes guardaron, listo para leer, reutilizar y compartir.',
        newDocument: 'Nuevo documento',
        searchPlaceholder: 'Buscar artefactos',
        kindLabel: 'Tipo',
        kinds: {
            all: 'Todos los tipos',
            document: 'Documentos',
            prompt: 'Prompts',
            board: 'Tableros',
            workflow: 'Flujos de trabajo',
            role: 'Roles',
            launchProfile: 'Perfiles de inicio',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            board: 'Tablero',
            workflow: 'Flujo de trabajo',
            role: 'Rol',
            launchProfile: 'Perfil de inicio',
        },
        sort: {
            label: 'Ordenar',
            updated_desc: 'Actualizados recientemente',
            created_desc: 'Creados recientemente',
            title_asc: 'Título',
        },
        view: {
            label: 'Vista',
            grid: 'Cuadrícula',
            list: 'Lista',
        },
        provenance: {
            savedByYou: 'Guardado por ti',
            sharedWithYou: 'Compartido contigo',
            fromFile: ({ name }) => `Desde ${name}`,
            openSession: ({ session }) => `Abrir ${session}`,
        },
        emptyTitle: 'Guarda lo que crean tus agentes',
        emptyBody: 'Los planes, notas, código y tableros que tú o tus agentes guardan llegan aquí, legibles en todos tus dispositivos y listos para compartir con tus equipos.',
        emptyHint: 'O pide a un agente “guárdalo como artefacto”.',
        loadFailedTitle: 'No se pudieron cargar tus artefactos',
        loadFailedBody: 'Revisa tu conexión e inténtalo de nuevo. No se perdió nada.',
        quota: {
            accountTitle: 'El almacenamiento de artefactos está lleno',
            documentTitle: 'Demasiado grande para guardar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usados, versiones incluidas. Elimina o exporta los artefactos que ya no necesites para guardar otros nuevos.`,
            documentBody: ({ size, limit }) => `Ocuparía ${size}; cada artefacto admite hasta ${limit}. Tus cambios siguen aquí.`,
        },
        open: {
            document: 'Abrir documento',
            prompt: 'Abrir prompt',
            board: 'Abrir tablero',
            workflow: 'Abrir flujo de trabajo',
            role: 'Abrir rol',
            launchProfile: 'Abrir perfil de inicio',
        },
        openAsPage: 'Abrir como página',
        actions: {
            edit: 'Editar',
            history: 'Historial',
            share: 'Compartir',
            more: 'Más acciones',
            copyLink: 'Copiar enlace',
            linkCopied: 'Enlace copiado',
        },
        history: {
            title: 'Historial',
            current: 'Actual',
            now: 'Ahora',
            restoreNote: 'Restaurar la añade como una versión nueva. No se pierde nada.',
            loadFailed: 'No se pudo cargar el historial. Inténtalo de nuevo.',
            empty: 'Aún no hay versiones anteriores. Cada guardado conserva una.',
            versionsLabel: 'Versiones',
            restoreFailed: 'No se pudo restaurar esta versión. Inténtalo de nuevo.',
            savedByUser: 'Guardado por un usuario',
            savedByAgentSession: 'Guardado por una sesión de agente',
            restoredVersion: ({ n }) => `Restaurado desde la versión ${n}`,
            version: ({ n }) => `Versión ${n}`,
            keeps: ({ count }) => `Conserva las últimas ${count} versiones.`,
            restore: ({ n }) => `Restaurar versión ${n}`,
        },
        savedToday: ({ count }) => `${count} guardados hoy`,
        noMatch: ({ query }) => `Ningún artefacto coincide con “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Almacenamiento de artefactos, ${used} de ${limit} usados`,
        },
        facts: {
            edited: ({ age }) => `Editado ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "es">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { es: translated({
        automationPages: {
            index: {
                description: 'Trabajo que empieza solo: con una programación, desde un Event o cuando termina un turno de una sesión.',
            },
            settings: {
                description: 'Cuánto trabajo de automatización acepta cada máquina y cuánto tiempo se conservan las ejecuciones terminadas.',
                capacityTitle: 'Capacidad',
                capacityDescription: 'Se aplica a todas las máquinas que ejecutan automatizaciones.',
                historyTitle: 'Historial de ejecuciones',
                historyDescription: 'Ejecuciones terminadas que aún puedes abrir desde una automatización.',
            },
            detail: {
                description: 'Empieza trabajo por sí sola cada vez que se activa uno de sus activadores.',
                triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 activador' : `${count} activadores`),
                overviewDescription: 'Qué ejecuta y cómo iniciarla o cambiarla.',
                runNowSubtitle: 'Inicia una ejecución ahora, sin esperar a un activador.',
                editSubtitle: 'Cambia su nombre, lo que ejecuta y sus activadores.',
                machineAssignmentsDescription: 'Máquinas que pueden tomar las ejecuciones de esta automatización.',
            },
            run: {
                description: 'Qué inició esta ejecución, dónde se ejecutó y qué produjo.',
                statusTitle: 'Estado',
                statusDescription: 'Dónde está ahora esta ejecución y qué puedes hacer todavía con ella.',
                causeTitle: 'Qué la inició',
                causeDescription: 'El activador y el event que admitieron esta ejecución. Nunca cambian después.',
            },
            gate: {
                serverTitle: 'Las automatizaciones están desactivadas en este Home',
                serverBody: 'Los administradores de este Home han desactivado las automatizaciones. Pide a uno de ellos que las vuelva a activar.',
                openFeatures: 'Abrir ajustes de funciones',
                unknownTitle: 'No se pueden comprobar las automatizaciones ahora',
                unknownBody: 'Happier no pudo contactar con este Home para comprobar si las automatizaciones están activadas. Vuelve a comprobarlo cuando esté en línea.',
                unsupportedTitle: 'Este Home aún no admite automatizaciones',
                unsupportedBody: 'Su servidor es anterior a las automatizaciones. Actualiza el servidor del Home para usarlas.',
                unsupportedContextTitle: 'Las automatizaciones no están disponibles aquí',
                unsupportedContextBody: 'No todos los Homes que estás viendo admiten automatizaciones.',
            },
            editor: {
                description: 'Ponle nombre, elige qué ejecuta y añade los activadores que la inician.',
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

const automationTriggerSetTranslations = { es: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Cuando comienza la sesión',
                sessionArchived: 'Cuando se archiva la sesión',
            },
            triggersTitle: 'Activadores',
            emptyBody: 'No hay activadores automáticos. Aun así, puedes ejecutar esta automatización manualmente.',
            orSemantics: 'Añade tantos activadores como quieras. Funcionan de forma independiente: la automatización se ejecuta cuando coincide cualquiera de ellos.',
            enabledSubtitle: 'Pausa toda la automatización sin cambiar sus activadores.', addTrigger: 'Añadir activador',
            addTriggerSubtitle: 'Programa una hora, conecta un evento o espera a que termine un turno concreto.', scheduleTitle: 'Programación', eventTitle: 'Evento del plugin',
            turnCompletedTitle: 'Cuando termine este turno', turnCompletedSubtitle: 'Se ejecuta una vez cuando finaliza exactamente el turno principal seleccionado.',
            selectedSession: 'Sesión seleccionada', turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · activador de una sola vez ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Cada ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Habilitar ${title}`, editScheduleTitle: 'Editar programación', scheduleType: 'Tipo de programación',
            chooseSession: 'Elige una sesión activa', eventEditorUnavailable: 'La configuración del evento no está disponible en la máquina actual.',
            removeTitle: '¿Eliminar este activador?', removeBody: 'Las futuras coincidencias de este activador dejarán de iniciar la automatización. El historial de ejecuciones no cambiará.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Buscar eventos',
            refreshFailedTitle: 'No se pudieron actualizar las automatizaciones',
            refreshFailedBody: 'Ahora mismo no se pudo leer la lista de automatizaciones. Inténtalo de nuevo para cargar la lista actual.',
            actionTitle: 'Cuando termine este turno…', createNew: 'Crear una automatización', createNewSubtitle: 'Empieza con este turno exacto ya seleccionado.',
            addToExistingSubtitle: 'Añade este turno exacto a una automatización existente.', searchPlaceholder: 'Buscar automatizaciones',
            eventListA11y: 'Elige el evento del ciclo de vida de la sesión',
            destinationA11y: 'Elige dónde añadir el activador de este turno', staleTitle: 'Este turno ha cambiado',
            staleBody: 'El turno seleccionado ya no es el turno principal activo. Actualiza y elige explícitamente el turno actual.',
            useCurrentTurn: 'Usar el turno actual', unavailable: 'Ahora mismo no hay ningún turno principal activo.',
            resolvingRowSubtitle: 'Comprobando qué automatizaciones puedes usar…',
            unavailableRowSubtitle: 'Detalles no disponibles: no se puede verificar esta automatización para esta sesión.',
            incompleteNoticeTitle: 'No se pudieron leer algunas automatizaciones',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const es: BoardsTranslations = {
    title: 'Tableros',
    newBoard: 'Tablero nuevo',
    defaultName: 'Tablero sin nombre',
    index: {
        title: 'Tus tableros',
        body: 'Un tablero mantiene sesiones, ejecuciones, flujos de trabajo y máquinas en vivo en un solo lugar, organizados a tu manera.',
    },
    notFound: {
        title: 'Este tablero ya no existe',
        body: 'Se eliminó, o pertenece a una Home que no está conectada aquí.',
    },
    meta: {
        needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        items: ({ count }) => (count === 1 ? '1 elemento' : `${count} elementos`),
        handPicked: 'Elegidos a mano',
        empty: 'Vacío',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Te necesita', description: 'Todo lo que te está esperando' },
        running: { title: 'En marcha', description: 'Ejecuciones de flujos de trabajo en curso' },
        my_machines: { title: 'Mis máquinas', description: 'Presencia y qué se ejecuta en cada una' },
        filter: { title: 'Sesiones', description: 'Todas las sesiones activas' },
    },
    header: {
        layoutA11y: 'Diseño del tablero',
        canvas: 'Lienzo',
        byStatus: 'Por estado',
        add: 'Añadir al tablero',
        settings: 'Ajustes del tablero',
    },
    kinds: {
        session: 'Sesión',
        workflow_run: 'Ejecución de flujo de trabajo',
        workflow: 'Flujo de trabajo',
        machine: 'Máquina',
    },
    card: {
        untitled: 'Elemento no disponible',
        unavailable: 'No disponible',
        unavailableBody: 'Su Home no está conectada en este dispositivo. Se queda en el tablero.',
        notLoaded: 'Aún no se ha cargado',
        remove: 'Quitar del tablero',
        moveHint: 'Las teclas de flecha mueven esta tarjeta por la cuadrícula.',
        moved: ({ x, y }) => `Movida a ${x}, ${y}`,
        moveActions: { up: 'Mover arriba', down: 'Mover abajo', left: 'Mover a la izquierda', right: 'Mover a la derecha' },
        machine: {
            online: 'En línea',
            offline: 'Sin conexión',
            running: ({ count }) => (count === 1 ? '1 sesión en marcha' : `${count} sesiones en marcha`),
            needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
            idle: 'Ninguna sesión en marcha',
            offlineBody: 'Sus sesiones esperan a que vuelva.',
        },
        workflow: {
            noRuns: 'Aún no hay ejecuciones',
            lastRun: ({ word, age }) => `Última ejecución ${age} · ${word}`,
            needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        },
        run: {
            waitingForYou: 'Esperando tu revisión',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Se ajusta aquí',
        snapOnceHint: 'Mantén ⇧ para ajustar una vez',
    },
    settings: {
        title: 'Ajustes del tablero',
        name: 'Nombre',
        whatsOn: 'Qué hay en este tablero',
        whichSessions: 'Qué sesiones',
        addedByHand: 'Añadido a mano',
        addedByHandNone: 'Aún nada',
        add: 'Añadir',
        layout: 'Diseño',
        layoutDescription: 'El lienzo conserva tu disposición cuando cambias.',
        snap: 'Ajustar a la cuadrícula',
        pin: 'Mostrar en la lista de sesiones',
        pinDescription: 'Fija este tablero encima de tus sesiones.',
        delete: 'Eliminar tablero',
        deleteConfirmTitle: '¿Eliminar este tablero?',
        deleteConfirmBody: 'Solo se va el tablero. Sus sesiones, ejecuciones, flujos de trabajo y máquinas se quedan como están.',
    },
    add: {
        title: 'Añadir al tablero',
        search: 'Buscar elementos',
        groups: { sessions: 'Sesiones', workflows: 'Flujos de trabajo', runs: 'Ejecuciones de flujos de trabajo', machines: 'Máquinas' },
        onBoard: 'En este tablero',
        addHint: 'Añadir',
        addAndPlaceHint: 'Añadir y colocar',
        empty: 'No hay coincidencias.',
    },
    empty: {
        title: 'Elige qué muestra este tablero',
        body: 'Añade sesiones, flujos de trabajo, ejecuciones o máquinas a mano, o muestra una sección como Te necesita. Tú los organizas; el tablero los mantiene en vivo.',
        action: 'Añadir al tablero',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Abrir la galería',
        galleryHint: 'Todos los widgets, con vista previa en vivo',
        addHint: 'Solo tú ves tus tableros',
        widthOne: 'Una tarjeta',
        widthTwo: 'Dos tarjetas',
        moveEarlier: 'Mover antes',
        moveLater: 'Mover después',
        remove: 'Quitar del tablero',
        menuA11y: ({ widget }) => `Opciones de ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Acaba de llegar 1 widget' : `Acaban de llegar ${count} widgets`),
        undo: 'Deshacer',
        dismiss: 'Descartar',
    },
    saveFailed: {
        tooLarge: 'Este tablero supera el límite de almacenamiento de tableros. Quita algunos elementos e inténtalo de nuevo.',
        notFound: 'Este tablero se eliminó en otro dispositivo.',
        generic: 'Tu cambio no llegó a tu cuenta, así que el tablero sigue como estaba.',
        retry: 'Reintentar',
        dismiss: 'Descartar',
        createTitle: 'Este tablero no se creó',
    },
};

const boardsTranslations = { es };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { es: {
        agentFallbackName: 'El agente',
        agentBrowsing: ({ agent }) => `${agent} está navegando`,
        clickTarget: ({ target }) => `Haciendo clic en «${target}»`,
        doing: {
            click: 'Haciendo clic en la página',
            type: 'Escribiendo',
            fill: 'Rellenando un campo',
            scroll: 'Desplazándose',
            navigate: 'Abriendo una página',
            history: 'Moviéndose por el historial',
            reload: 'Recargando la página',
            press: 'Pulsando una tecla',
            select: 'Eligiendo una opción',
            drag: 'Arrastrando',
            upload: 'Subiendo un archivo',
            look: 'Mirando la página',
            other: 'Trabajando en la página',
        },
        takeControl: 'Tomar el control',
        stopping: ({ agent }) => `Deteniendo a ${agent}…`,
        stoppingDetail: 'Terminando su última acción',
        lastActionMayHaveLanded: ({ agent }) => `Puede que la última acción de ${agent} se haya realizado`,
        youHaveControl: 'Tienes el control',
        stopUnconfirmed: 'No se pudo confirmar la parada',
        checkAgain: 'Volver a comprobar',
        pausedUntilHandBack: ({ agent }) => `${agent} está en pausa hasta que le devuelvas el control`,
        handBack: 'Devolver',
        stream: {
            connectingTitle: ({ agent }) => `Conectando con el navegador de ${agent}`,
            connectingBody: ({ machine }) => `Se ejecuta en ${machine}. La página aparecerá aquí en cuanto llegue el primer fotograma.`,
            stalled: 'Mostrando el último fotograma · reconectando',
            endedTitle: ({ agent }) => `${agent} cerró este navegador`,
            endedBody: 'La página ya no se muestra aquí.',
            unavailableTitle: ({ agent }) => `No se puede mostrar aquí el navegador de ${agent}`,
            unavailableBody: ({ agent }) => `${agent} sigue navegando; sus acciones siguen apareciendo en el chat.`,
            tryAgain: 'Reintentar',
            inputA11y: 'La página. Toca, desplázate o escribe para tomar el control.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Grabando, ${elapsed}`,
            discard: 'Descartar grabación',
        },
        openInYourBrowser: 'Abrir en tu navegador',
        slowPage: 'Esta página está tardando',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "es">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { es: {
        opened: ({ page }) => `Abrió ${page}`,
        openedPage: 'Abrió una página',
        reloaded: 'Recargó la página',
        wentBack: 'Volvió atrás',
        wentForward: 'Avanzó',
        clicked: ({ target }) => `Hizo clic en ${target}`,
        clickedPage: 'Hizo clic en la página',
        typedInto: ({ target }) => `Escribió en ${target}`,
        typed: 'Escribió en la página',
        filledIn: ({ target }) => `Rellenó ${target}`,
        filled: 'Rellenó un campo',
        pressed: ({ key }) => `Pulsó ${key}`,
        pressedKey: 'Pulsó una tecla',
        scrolled: 'Desplazó la página',
        pointedAt: ({ target }) => `Señaló ${target}`,
        pointed: 'Señaló la página',
        choseIn: ({ target }) => `Eligió una opción en ${target}`,
        chose: 'Eligió una opción',
        uploadedTo: ({ target }) => `Subió un archivo a ${target}`,
        uploaded: 'Subió un archivo',
        dragged: ({ target }) => `Arrastró ${target}`,
        draggedPage: 'Arrastró en la página',
        looked: 'Miró la página',
        screenshot: 'Hizo una captura de pantalla',
        recordingStarted: 'Empezó a grabar la página',
        recordingStopped: 'Detuvo la grabación',
        other: 'Usó el navegador',
        watch: 'Ver',
        watchA11y: 'Abrir esta página en el navegador',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "es">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { es: {
        changedFileEvidence: translated({
            before: 'Antes',
            after: 'Después',
            binary: 'Archivo binario',
            truncated: 'El contenido de la evidencia se limitó; el tamaño original y las estadísticas de cambios se conservan cuando están disponibles.',
            truncatedOldBytes: ({ count }) => `Contenido original anterior: ${count} bytes`,
            truncatedNewBytes: ({ count }) => `Contenido original posterior: ${count} bytes`,
            truncatedDiffBytes: ({ count }) => `Diferencia original: ${count} bytes`,
            truncatedAddedLines: ({ count }) => `Líneas añadidas: ${count}`,
            truncatedRemovedLines: ({ count }) => `Líneas eliminadas: ${count}`,
            kind: {
                added: 'Añadido',
                modified: 'Modificado',
                deleted: 'Eliminado',
                renamed: 'Renombrado',
                copied: 'Copiado',
                unknown: 'Tipo de cambio no disponible',
            },
            howDetermined: 'Cómo se determinó',
            howDeterminedForFile: ({ path }) => `Cómo se determinó ${path}`,
            content: {
                exact: 'Cambio exacto del repositorio',
                strong: 'Evidencia de contenido sólida',
                best_effort: 'Evidencia de contenido aproximada',
            },
            attribution: {
                session_exact: 'Vinculado a esta sesión',
                session_likely: 'Probablemente modificado por esta sesión',
                session_possible: 'Posiblemente modificado por esta sesión',
                unknown: 'Atribución de sesión no disponible',
            },
            reason: {
                provider_correlated: 'El agente informó de este cambio para este turno.',
                canonical_tool_correlated: 'Una herramienta de diferencias o de parches vinculó este cambio con este turno.',
                checkpoint_no_happier_overlap_observed: 'El punto de control no registró ningún turno de Happier solapado en este proceso.',
                checkpoint_overlap_observed: 'Otro turno de Happier se solapó con el intervalo de captura del punto de control.',
                workspace_touched_path: 'Esta ruta se tocó en el espacio de trabajo; eso no identifica la sesión que la cambió.',
                unavailable: 'La evidencia no establece qué sesión hizo este cambio.',
            },
            overlap: {
                observed: 'Otro turno de Happier se solapó con esta copia de trabajo durante la captura. Las observaciones solo cubren este proceso; otros procesos y escritores externos no se registran.',
                not_observed: 'No se observó ningún turno de Happier solapado en este proceso. Otros procesos y escritores externos no se registran; esto no establece una autoría exclusiva.',
                unknown: 'El solapamiento del punto de control es desconocido. Otros procesos y escritores externos no se registran.',
            },
            sources: {
                provider_native: 'Informe de cambios nativo del agente',
                provider_tool: 'Informe de una herramienta del agente',
                canonical_diff_tool: 'Evidencia de una herramienta de diferencias',
                canonical_patch_tool: 'Evidencia de una herramienta de parches',
                scm_checkpoint: 'Punto de control del repositorio',
                scm_reconciled: 'Instantánea reconciliada del repositorio',
                inferred: 'Ruta tocada en el espacio de trabajo',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const es = {
    title: 'Línea de comandos',
    footer: 'Happier Desktop solo añade o elimina las entradas de PATH que creó. Las entradas escritas por el instalador de la shell no se tocan.',
    addTitle: 'Añadir happier al PATH',
    addSubtitle: 'Haz que el comando happier esté disponible en las terminales nuevas.',
    removeTitle: 'Quitar happier del PATH',
    removeSubtitle: 'Elimina solo las entradas de PATH que añadió Happier Desktop.',
    working: 'Actualizando tu perfil de shell…',
    added: 'Añadido. Abre una terminal nueva para usar happier.',
    alreadyPresent: 'happier ya está en tu PATH.',
    removed: 'Se eliminaron las entradas de PATH que añadió Happier Desktop.',
    nothingToRemove: 'Happier Desktop no ha añadido ninguna entrada de PATH.',
};

const cliPathExposureTranslations = { es: es };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const es = {
    title: '¿Aprobar esta línea de comandos?',
    body: ({ command }: { command: string }) => `Happier no instaló la línea de comandos en ${command}. Aprobarla le permite leer y escribir las sesiones de esta cuenta. Aprueba solo la que hayas puesto tú.`,
    bodyUnknownCommand: 'Happier no instaló esta línea de comandos. Aprobarla le permite leer y escribir las sesiones de esta cuenta. Aprueba solo la que hayas puesto tú.',
    approve: 'Aprobar',
};

const cliTrustPromptTranslations = { es: es };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "es"> = { es: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Un commit para tus cambios pendientes' : `${count} commits para tus cambios pendientes`),
        titlePhone: ({ count }) => (count === 1 ? 'Un commit' : `${count} commits`),
        proposedBy: ({ who, committed, total }) => `Propuesto por ${who} · ${committed} de ${total} archivos · ordenados para que cada commit parta del anterior.`,
        proposedByPhone: ({ committed, total }) => `${committed} de ${total} archivos pendientes · toca un cambio para moverlo.`,
        moveHint: ({ max }) => `Mueve cualquier cambio con ⌥1–${max} o con su menú.`,
        modelFallback: 'el modelo',
        regenerate: 'Regenerar',
        conflict: 'La propuesta cambió en otro lugar. Esta es la más reciente; vuelve a hacer tu cambio.',
        approvalPending: 'Esperando aprobación para crear estos commits.',
        discardBody: 'Se elimina la propuesta. Tus cambios pendientes se quedan como están.', askFix: ({ hook, number, message }) => `El hook ${hook} detuvo el commit ${number}, «${message}». Corrige lo que indica para que el commit pueda pasar:`, askFixGeneric: ({ number, message }) => `Un hook detuvo el commit ${number}, «${message}». Corrige lo que indica para que el commit pueda pasar:`, discarded: 'Propuesta descartada.', undo: 'Deshacer',
        fileCount: ({ count }) => (count === 1 ? '1 archivo' : `${count} archivos`),
        part: ({ count, of }) => `${count} de ${of} cambios`,
        move: { a11y: ({ file }) => `Mover ${file} a otro commit`, title: ({ file }) => `Mover ${file} a`, newCommitAfter: ({ number }) => `Commit nuevo después del ${number}`, newCommitMessage: ({ file }) => `Actualizar ${file}`, leaveOut: 'Dejar fuera de estos commits', leaveOutHint: 'Se queda en tu árbol de trabajo' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Editar mensaje', messageA11y: ({ number }) => `Mensaje del commit ${number}`, more: 'Más', moveUp: 'Subir', moveDown: 'Bajar', mergeWithNext: 'Fusionar con el siguiente commit', empty: 'Aún no tiene cambios. Mueve uno aquí o fusiónalo con el siguiente.' },
        leftOut: { title: 'Fuera · se queda en tu árbol de trabajo', description: 'Estos cambios siguen pendientes. Haz un commit aparte si era tu intención.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `${count} commits`), onBranch: ({ branch }) => ` en ${branch} · los hooks y la firma funcionan como en cualquier commit`, detached: ' en un HEAD separado · los hooks y la firma funcionan como en cualquier commit', phone: 'Hooks y firma como siempre', discard: 'Descartar propuesta', create: ({ count }) => (count === 1 ? 'Crear 1 commit' : `Crear ${count} commits`), createShort: ({ count }) => `Crear ${count}`, emptyGroupReason: 'Un commit no tiene cambios. Mueve uno a él o fusiónalo.' },
        applying: { title: ({ count }) => (count === 1 ? 'Creando 1 commit' : `Creando ${count} commits`), body: 'Uno a uno por el camino de commit habitual, así tus hooks y la firma funcionan como siempre. La edición se pausa hasta que termine.', bodyPhone: 'La edición se pausa hasta que termine.', created: ({ landed, total }) => `${landed} de ${total}`, createdRest: ' creados · nada se deshace si uno posterior se detiene', createdRestPhone: ' creados', stopAfterThis: 'Detener tras este commit', stopAfterThisShort: 'Detener tras este', stopping: 'Se detendrá tras este commit' },
        state: { waiting: 'En espera', writing: 'Ejecutando hooks y creando el commit', landed: 'hecho', landedAt: ({ time }) => `hecho a las ${time}`, signed: 'firmado', pausedBy: ({ hook, count }) => `${hook} cambió ${count} archivo${count === 1 ? '' : 's'} · aún sin commit`, hookFailedBy: ({ hook }) => `${hook} falló · sin commit`, rewritten: 'un hook reescribió el mensaje', notCreated: 'No creado · aún puedes editarlo', notCreatedShort: 'No creado', unknown: 'Sin confirmar', paused: ({ count }) => (count === 1 ? 'Un hook cambió 1 archivo · aún sin commit' : `Un hook cambió ${count} archivos · aún sin commit`), failed: 'Detenido aquí · sin commit' },
        outcome: { signingTitle: 'Ahora mismo no se pueden firmar tus commits.', signingBody: 'Este repositorio firma cada commit. No se ha hecho ningún commit.', signingHint: 'Desbloquea primero tu agente GPG o SSH', tryAgain: 'Reintentar', cancel: 'Cancelar', hookChanged: ({ files }) => `El hook cambió ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'El commit 1 ya está; este te espera.' : `${count} commits ya están; este te espera.`), waits: 'Este te espera.', include: 'Incluir los cambios del hook', includePhone: 'Incluir y hacer commit', cancelCommit: 'Cancelar este commit', hookFailed: 'Un hook detuvo este commit.', hookChangedBy: ({ hook, files }) => `${hook} cambió ${files}.`, hookFailedBy: ({ hook }) => `${hook} detuvo este commit.`, hookFailedBody: 'Los commits anteriores se quedan. El resto aún puedes editarlo.', headMoved: ({ branch }) => `${branch} se movió durante los commits.`, headMovedBody: 'Se rechazó el siguiente commit y no se deshizo nada.', proposeAgain: 'Proponer de nuevo lo que queda', keepEditing: 'Seguir editando', askSessionToFix: 'Pedir a esta sesión que lo arregle', showInGit: 'Mostrar en Git', unknownTitle: 'No pudimos confirmar si este commit está.', unknownBody: 'No se reintenta nada hasta saberlo. Vuelve a comprobar la rama.', checkAgain: 'Comprobar de nuevo', stoppedTitle: ({ landed, total }) => `${landed} de ${total} commits creados`, stoppedBody: ({ count }) => (count === 1 ? 'El último no se creó. Sus cambios siguen en tu árbol de trabajo, como antes.' : `${count} no se crearon. Sus cambios siguen en tu árbol de trabajo, como antes.`), createRest: ({ count }) => (count === 1 ? 'Crear el último' : `Crear los ${count} restantes`), completeTitle: ({ count }) => (count === 1 ? '1 commit creado' : `${count} commits creados`), completeBody: 'No se subió nada.', onBranch: ({ branch }) => `en ${branch}`, failed: { staging_conflict: 'Algo más cambió lo que está preparado.', selection_conflict: 'Estos cambios no se pueden dividir así.', source_changed: 'Los cambios pendientes cambiaron desde la propuesta.', writer_failed: 'No se pudo crear el commit.', publication_warning: 'El commit está, pero los archivos preparados no se actualizaron.', cancelled: 'Se canceló este commit.' }, failedBody: 'Los commits anteriores se quedan. No se deshizo nada.' },
        none: { title: 'Aún no hay propuesta de commits', reason: 'Una propuesta agrupa tus cambios pendientes en commits que puedes editar y luego los crea uno a uno por el camino de commit habitual.', propose: 'Proponer commits', writing: 'Agrupando tus cambios pendientes…' },
        gitPane: { title: 'Commits propuestos', meta: ({ count, files }) => `${count} · ${files} archivos`, inCommit: ({ count, number }) => `${count} en el commit ${number}`, open: 'Abrir', review: 'Revisar', reviewInWalkthrough: 'Revisar en el recorrido', more: 'Descartar o regenerar', selectedHint: 'Seleccionado. Toca otra vez para abrirlo en Commits', tapHint: 'Toca para ver sus cambios' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "es": {
        "committedMessageActions": {
            "copy": "Copiar",
            "fork": "Bifurcar",
            "rollback": "Revertir",
            "pin": "Fijar",
            "savePrompt": "Guardar como prompt",
            "plugins": "Acciones de plugins",
            "composerButton": "Botón de la biblioteca de prompts",
            "composerHint": "Tus prompts y lo que enviaste, junto al dictado. El menú / sigue ofreciendo Prompts… si está desactivado.",
            "name": "Nombre",
            "shortcut": "/ atajo",
            "savedOpen": "Guardado en la biblioteca · Abrir",
            "shortcutNotSaved": "El prompt se guardó, pero su atajo no. Ábrelo en la biblioteca para añadir un atajo.",
            "wrongAccount": "Cambia al Home de esta sesión antes de guardar su prompt.",
            "savedHintFavorite": "Se guarda en tu biblioteca, con estrella.",
            "savedHint": "Se guarda en tu biblioteca.",
            "addShortcut": "Añadir un atajo /",
            "shortcutPlaceholder": "/atajo",
            "savedToLibrary": "Guardado en la biblioteca",
            "savePromptHint": "Reutilízalo desde la biblioteca de prompts",
            "copyHint": "Copia el texto de un mensaje.",
            "forkHint": "Empieza una sesión nueva desde un mensaje.",
            "rollbackHint": "Devuelve el espacio de trabajo a como estaba antes de un mensaje.",
            "pinHint": "Fija mensajes para volver a ellos. Los fijados siguen fijados.",
            "savePromptSettingHint": "Guarda un mensaje enviado como prompt de la biblioteca.",
            "pluginsHint": "Acciones que tus plugins añaden bajo los mensajes."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { es: {
        approval: {
            sectionTitle: 'En el ordenador',
            act: {
                list: 'Ver qué ventanas están abiertas',
                see: 'Hacer una captura de pantalla',
                read: 'Leer el texto y los controles',
                click: 'Hacer clic',
                press: 'Pulsar una tecla',
                type: 'Escribir',
                share: 'Compartir una ventana',
            },
            windowOn: ({ machine }) => `Una ventana en ${machine}`,
            screenOf: ({ machine }) => `Toda la pantalla de ${machine}`,
            windowsOn: ({ machine }) => `Las ventanas abiertas en ${machine}`,
            window: 'Una ventana',
            screen: 'Toda la pantalla',
            windows: 'Las ventanas abiertas',
            typedLabel: 'Texto',
            keyLabel: 'Tecla',
            listConsequence: 'Solo se comparten los nombres de las ventanas abiertas, no su contenido.',
            seeConsequence: 'Las capturas se comparten con esta sesión. Sin clics ni escritura.',
            useConsequence: 'La entrada que llega a la máquina no se puede deshacer. Puedes detenerlo en cualquier momento.',
            targetOn: ({ machine, target }) => `${target} en ${machine}`,
            chooseFirst: 'Primero elige la ventana',
            cropA11y: ({ target }) => `La última imagen de ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} sugiere «${target}»`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} quiere usar una ventana en ${machine}`,
            body: 'Tú eliges la ventana. No se comparte nada hasta que lo hagas.',
            choose: 'Elegir una ventana',
            change: 'Cambiar de ventana',
            shared: ({ target }) => `Compartiste ${target}`,
            watch: 'Ver',
        },
        picker: {
            title: ({ agent }) => `Deja que ${agent} use una ventana`,
            description: ({ agent }) => `Tú eliges qué compartir con ${agent}.`,
            windows: 'Ventanas',
            screens: 'Pantalla completa',
            untitledWindow: 'Ventana sin título',
            screenLabel: ({ index }) => `Pantalla ${index}`,
            share: 'Compartir ventana',
            shareScreen: 'Compartir pantalla',
            shareApp: ({ app }) => `Compartir ventana de ${app}`,
            stopSharing: 'Dejar de compartir',
            loadingTitle: ({ machine }) => `Buscando ventanas en ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} no tiene pantalla para compartir`,
            noScreenBody: 'Funciona sin un escritorio que Happier pueda ver. Usa una máquina con pantalla.',
            unsupportedTitle: ({ machine }) => `Happier aún no puede usar la pantalla de ${machine}`,
            unsupportedBody: 'Por ahora, compartir una ventana funciona en escritorios Linux.',
            failedTitle: ({ machine }) => `No se pudieron listar las ventanas de ${machine}`,
            failedBody: 'Comprueba que Happier se está ejecutando allí y vuelve a intentarlo.',
            emptyTitle: ({ machine }) => `No hay ventanas abiertas en ${machine}`,
            emptyBody: 'Abre la ventana que quieres compartir y vuelve a comprobar.',
            tryAgain: 'Volver a intentar',
            inUse: 'Otra sesión está usando esta ventana. Elige otra.',
            closed: 'Esa ventana se cerró. Elige otra.',
            selectFailed: 'No se pudo compartir esa ventana. Vuelve a intentarlo.',
            otherMachineTitle: ({ machine }) => `${machine} no es la máquina de esta sesión`,
            otherMachineBody: 'Solo se pueden compartir ventanas en la máquina donde se ejecuta esta sesión.',
            purpose: ({ session }) => `Para «${session}».`,
            purposeIn: ({ project, session }) => `Para «${session}» en ${project}.`,
            access: ({ agent }) => `${agent} puede`,
            accessValue: 'Verla y usarla',
            accessSee: 'Verla',
            displayUnavailable: 'No se puede compartir toda la pantalla de este equipo.',
            policyBoth: ({ agent }) => `${agent} pregunta antes de cada captura, clic y pulsación.`,
            policyInput: ({ agent }) => `${agent} pregunta antes de cada clic y pulsación.`,
            policyCapture: ({ agent }) => `${agent} pregunta antes de cada captura.`,
            policyNone: ({ agent }) => `${agent} no pregunta antes de capturas, clics ni pulsaciones.`,
            policyChange: 'Cambiar',
            suggests: ({ agent }) => `${agent} sugiere`,
        },
        permission: {
            title: ({ machine }) => `${machine} necesita tu permiso primero`,
            body: 'Happier solo puede ver y usar ventanas después de que lo permitas en Ajustes del Sistema, en ese ordenador.',
            capture: 'Grabación de pantalla',
            captureHint: 'Para ver ventanas',
            input: 'Accesibilidad',
            inputHint: 'Para hacer clic y escribir',
            allowed: 'Permitido',
            denied: 'No permitido',
            unknown: 'Sin comprobar',
            open: ({ machine }) => `Abrir Ajustes del Sistema en ${machine}`,
            opened: ({ machine }) => `Abierto en ${machine}. Permite Happier allí y vuelve a comprobar.`,
            openFailed: 'No se pudo abrir Ajustes del Sistema allí. Ábrelo en ese ordenador.',
            checkAgain: 'Volver a comprobar',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} está usando ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} puede usar ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} puede ver ${target}`,
            onMachine: ({ machine }) => `En ${machine}`,
            connectingTitle: ({ target }) => `Conectando con ${target}`,
            connectingBody: ({ machine }) => `La ventana aparece aquí en cuanto llega la primera imagen de ${machine}.`,
            unavailableTitle: 'No se puede mostrar esta ventana ahora',
            unavailableBody: ({ agent }) => `Aun así, puedes detener a ${agent} desde aquí.`,
            endedTitle: ({ target }) => `${target} se cerró`,
            endedBody: ({ agent }) => `${agent} ya no puede verla ni usarla. Elige otra ventana para continuar.`,
            stalled: 'Mostrando la última imagen · reconectando',
            inputA11y: ({ target }) => `${target}, en directo. Haz clic o escribe para tomar el control.`,
            notSharedTitle: 'No hay ninguna ventana compartida',
            notSharedBody: ({ agent }) => `Elige una ventana para que ${agent} la use.`,
            moreA11y: 'Opciones de la ventana',
            tabFallback: 'Ordenador',
        },
        strip: {
            using: ({ target }) => `Usando ${target}`,
            on: ({ machine }) => `en ${machine}`,
            stop: 'Detener',
            paused: ({ agent }) => `${agent} está en pausa`,
            pausedDetail: ({ target }) => `Tienes el control de ${target}`,
        },
        tool: {
            capture: 'Hizo una captura',
            captureRunning: 'Haciendo una captura',
            query: 'Leyó el texto y los controles de la ventana',
            queryRunning: 'Leyendo la ventana',
            click: 'Hizo clic en la ventana',
            clickRunning: 'Haciendo clic en la ventana',
            clickTarget: ({ target }) => `Hizo clic en «${target}»`,
            type: 'Escribió en la ventana',
            typeRunning: 'Escribiendo en la ventana',
            typeTarget: ({ target }) => `Escribió en «${target}»`,
            pressKey: ({ key }) => `Pulsó ${key}`,
            press: 'Pulsó una tecla',
            pressRunning: 'Pulsando una tecla',
            mayHaveLanded: 'puede que se aplicara',
            failed: 'No se completó',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "es">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const es: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Cuenta de ${service}`,
    accountLabelNumbered: ({ service, number }) => `Cuenta de ${service} ${number}`,
    meterResetsIn: ({ time }) => `en ${time}`,
    meterNextResetIn: ({ time }) => `el próximo en ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Sin datos',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Todos los servicios',
    indexDescription: 'Las cuentas con las que inician sesión tus agentes y cuánto le queda a cada una.',
    viewList: 'Lista',
    viewGrid: 'Cuadrícula',
    viewLabel: 'Mostrar las cuentas como',
    refreshAll: 'Actualizar todo',
    refreshUsage: 'Actualizar el uso',
    signedOutConsequence: 'Las sesiones no pueden usarla hasta que vuelvas a iniciar sesión.',
    poolsGroup: 'Grupos',
    poolsDescription: 'Cuentas entre las que cambia un agente. El grupo elige una al empezar una sesión y pasa a otra cuando se agota.',
    newPool: 'Grupo nuevo',
    poolUsing: ({ account }) => `Usando ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Primera de ${count}` : `${position} de ${count}`,
    poolInUseNow: 'en uso ahora',
    inUse: 'En uso',
    connectService: 'Conectar un servicio',
    searchAccounts: 'Buscar cuentas',
    servicesGroup: 'Servicios',
    railEmpty: 'Aún no hay cuentas',
    railKey: 'clave',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Cómo inician sesión los agentes',
    subscriptionTitle: 'Suscripción',
    subscriptionNone: 'Sin suscripción',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Se renueva hoy' : days === 1 ? 'Se renueva mañana' : `Se renueva en ${days} días`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'No se renueva · termina hoy' : `No se renueva · termina en ${days} días`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'El periodo termina hoy' : `El periodo termina en ${days} días`,
    subscriptionRenewsOn: ({ date, days }) => `Se renueva el ${date} · en ${days} días`,
    subscriptionEndsOn: ({ date, days }) => `No se renueva · termina el ${date}, en ${days} días. Entonces las sesiones dejarán de usarla.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `El periodo termina el ${date} · en ${days} días`,
    renewalOn: 'Activa',
    renewalOff: 'Desactivada',
    renewalUnknown: 'Desconocido',
    checkedAt: ({ time }) => `Comprobado ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Comprobado ${time} · puede estar desactualizado`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Comprobado ${time} · puede estar desactualizado`,
    daysAgo: ({ count }) => count === 1 ? 'hace 1 día' : `hace ${count} días`,
    hoursAgo: ({ count }) => count === 1 ? 'hace 1 hora' : `hace ${count} horas`,
    usageResetsCount: ({ count }) => count === 1 ? '1 restablecimiento de uso' : `${count} restablecimientos de uso`,
    usageResetsFirstExpires: ({ date }) => `el primero caduca ${date}`,
    usageResetExpires: ({ date }) => `caduca ${date}`,
    useOne: 'Usar uno',
    useOneReset: 'Usar un restablecimiento de uso',
    usageResetsTitle: 'Restablecimientos de uso',
    usageResetsDescription: 'Cada uno empieza una ventana nueva al instante. Guárdalos para cuando un límite te bloquee; los que no uses caducan.',
    usageResetTitle: 'Restablecimiento de uso',
    usageResetExpiresOn: ({ date }) => `Caduca el ${date}`,
    use: 'Usar',
    usedByDefault: 'Predeterminada · las sesiones nuevas usan esta cuenta',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Ocultar correos e ID de las cuentas',
    hideIdentitiesDescription: 'Para retransmisiones y demos. Oculta correos e ID de cuenta en todo este dispositivo; los nombres que diste a las cuentas se mantienen.',
    privacyTitle: 'Privacidad',
    renameTitle: 'Nombra esta cuenta',
    renameBody: ({ service }) => `Solo cambia el nombre en Happier. ${service} mantiene su propio nombre para la cuenta.`,
    identityHidden: 'Correo o ID ocultos',
};

const connectedServicesCollectionTranslations = { es };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const es: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Caduca antes",
    strategyExpiryFirstDescription: "Prioriza una cuota suficiente cuyo periodo largo se reinicie o cuya suscripción sin renovación termine antes.",
    leadExpiryFirst: "Primero lo que caduca antes.",
    membersOn: ({ service, on, total }) => `${service} · ${on} de ${total} miembros activos`,
    rename: 'Cambiar nombre',
    moreActions: 'Más acciones',
    defaultFor: ({ agent }) => `Predeterminado para ${agent}`,
    defaultForMore: ({ agent, count }) => `Predeterminado para ${agent} +${count}`,
    makeDefault: 'Hacer predeterminado',
    makeDefaultA11y: 'Hacerlo predeterminado para un agente',
    usingSince: ({ name, time }) => `Usando ${name} desde las ${time}`,
    using: ({ name }) => `Usando ${name}`,
    noActive: 'Aún no hay ningún miembro en uso',
    noActiveDetail: 'El grupo elige uno cuando empieza una sesión.',
    leadLeastLimited: 'Primero el menos limitado.',
    leadInOrder: 'En orden.',
    fallbackOff: ({ name }) => `El cambio automático está desactivado; las sesiones siguen en ${name} cuando se agote.`,
    manualStays: ({ name }) => `Manual: el grupo sigue en ${name} hasta que elijas otro miembro.`,
    switchTo: ({ name }) => `Cambiar a ${name}`,
    onlyOneOn: ({ name }) => `Solo ${name} está activo, así que no hay alternativa.`,
    turnOn: ({ name }) => `Activar ${name}`,
    allWaitingTitle: 'Todos los miembros esperan un reinicio',
    allWaitingFirst: ({ name, time, countdown }) => `${name} se reinicia primero, a las ${time} (${countdown}).`,
    sessionsWait: 'Las sesiones esperan y luego se reanudan solas.',
    sessionsStop: 'Las sesiones se detienen hasta que un miembro tenga margen.',
    leftTitle: 'Disponible en el grupo',
    leftDescription: 'La media de los miembros activos; cada uno se reinicia por su cuenta.',
    roomCount: ({ count, total }) => `${count} de ${total} tienen margen ahora`,
    notReported: ({ count }) => count === 1 ? '1 sin datos' : `${count} sin datos`,
    nothingReported: 'Ningún miembro activo informa todavía de sus límites.',
    membersTitle: 'Miembros',
    membersDescription: 'Arrastra para fijar el orden. El miembro seleccionado es el activo; un miembro desactivado se omite.',
    membersCompactDescription: 'Mantén pulsado y arrastra para reordenar.',
    manage: 'Gestionar',
    connectAnotherAccount: ({ service }) => `Conectar otra cuenta de ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} de ${total} cuentas de ${service}`,
    manageMembers: 'Gestionar miembros',
    searchAccounts: ({ service }) => `Buscar cuentas de ${service}`,
    active: 'Activo',
    offNotUsed: 'El grupo no lo usa mientras está desactivado',
    autoOffModel: 'Desactivado automáticamente · este plan no puede usar el modelo seleccionado',
    checkedAt: ({ time }) => `Comprobado ${time}`,
    makeActiveA11y: ({ name }) => `Hacer de ${name} el miembro activo`,
    memberOnA11y: ({ name }) => `Usar ${name} en este grupo`,
    openA11y: ({ name }) => `Abrir ${name}`,
    dragA11y: 'Arrastra para reordenar',
    behaviorTitle: 'Comportamiento',
    strategyTitle: 'Estrategia de selección',
    strategyLeastLimited: 'Menos limitado',
    strategyInOrder: 'En orden',
    strategyManual: 'Manual',
    strategyLeastLimitedDescription: 'Preferir el miembro con más cuota utilizable.',
    strategyInOrderDescription: 'Probar los miembros en el orden de arriba.',
    strategyManualDescription: 'Usar solo el miembro activo hasta que lo cambies.',
    fallbackTitle: 'Cambio automático',
    fallbackDescription: 'Cambiar a otro miembro cuando la cuenta activa necesite recuperarse.',
    switchEarlyTitle: 'Cambiar antes',
    switchEarlyDescription: 'Porcentaje restante por debajo del cual el grupo pasa a un miembro con cuota más fresca. 0 lo desactiva.',
    autoResetsTitle: 'Usar automáticamente los reinicios de cuota',
    autoResetsDescription: 'Gastar un reinicio guardado solo cuando ningún miembro esté listo.',
    autoOffTitle: 'Desactivar las cuentas que no pueden usar el modelo seleccionado',
    autoOffDescription: 'Puedes volver a activarlas tú.',
    advancedTitle: 'Avanzado',
    advancedCount: ({ count }) => `${count} ajustes`,
    restoreFirstTitle: 'Volver al primer miembro cuando se reinicie',
    restoreFirstDescription: 'Tras un cambio, volver al primer miembro de la lista cuando se reinicie su límite.',
    switchWhenTitle: 'Cambiar cuando',
    switchWhenDescription: 'Eventos que llevan el grupo al siguiente miembro.',
    staleAfterTitle: 'Comprobar el uso antiguo tras',
    staleAfterDescription: 'Minutos. Volver a preguntar al proveedor cuando el uso sea más antiguo antes de elegir un miembro.',
    switchesPerTurnTitle: 'Cambios automáticos por turno',
    switchesPerHourTitle: 'Cambios automáticos por hora de sesión',
    switchLimitsDescription: 'Evita que un grupo salte entre miembros.',
    recoveryTitle: 'Cuando un límite detiene una sesión',
    recoveryDescription: 'Qué hace el grupo con la sesión que espera.',
    recoveryPromptsTitle: 'Mensajes de reanudación',
    recoveryPromptsDescription: 'Happier envía su mensaje estándar cuando reanuda una sesión tras un cambio o un reinicio.',
    usedByTitle: 'Usado por',
    usedByDefault: 'Predeterminado · las sesiones nuevas inician sesión con este grupo',
    usedByNone: 'Ningún agente inicia sesión con este grupo por defecto todavía.',
    deleteNote: ({ agents }) => `Los miembros siguen conectados. ${agents} vuelve a su propio inicio de sesión hasta que elijas otro predeterminado.`,
    deleteNoteNoAgent: 'Los miembros siguen conectados.',
    emptyTitle: 'Añade las cuentas entre las que cambiar',
    emptyReason: ({ service }) => `Un grupo elige una cuenta cuando empieza una sesión y cambia cuando se agota. Añade al menos dos cuentas de ${service}.`,
    usageNotAnswering: ({ service }) => `${service} no respondió`,
    newPoolTitle: 'Grupo nuevo',
    newPoolDescription: ({ service }) => `Cuentas de ${service} entre las que cambia un agente.`,
    nameTitle: 'Nombre',
    namePlaceholder: 'Grupo de trabajo',
    draftMembersDescription: 'Elige las cuentas entre las que cambiar. Puedes cambiarlas después.',
    create: 'Crear grupo',
    discard: 'Descartar',
};

const connectedServicesPoolTranslations = { es };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const es: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 cuenta' : `${count} cuentas`,
    defaultAccount: ({ name }) => `Predeterminada: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 grupo' : `${count} grupos`,
    noAccountsYet: 'Aún no hay cuentas',
    needsSignIn: 'Requiere inicio de sesión',
    signInAgain: 'Volver a iniciar sesión',
    addAccount: 'Añadir cuenta',
    connectAnotherTitle: 'Conectar otro servicio',
    connectFirstTitle: 'Conectar un servicio',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} y ${count} más.`,
    connect: 'Conectar',
    emptyTitle: 'Aún no hay servicios para conectar',
    servicesTitle: 'Servicios',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Ningún agente de ${machine} ofrece todavía un servicio con el que iniciar sesión. Los agentes que usan una suscripción añaden el suyo aquí.`,
    emptyNoMachineOnline: 'Ninguna de tus máquinas está en línea. Los servicios aparecen cuando una lo está, a partir de los agentes que ejecuta.',
    emptyOpenAgents: 'Abrir agentes',
    emptyAction: 'Abrir máquinas',
    projectionErrorTitle: 'No se pudieron cargar los servicios de tus máquinas',
    projectionErrorDescription: 'Tus cuentas siguen en la lista. Los servicios que puedes añadir aparecen cuando responde una máquina.',
    loadingServices: 'Buscando servicios en tus máquinas…',
    usageTitle: 'Cómo se usan las cuentas',
    usageDescription: 'Con qué cuenta inicia sesión cada agente al empezar una sesión y qué comparten las sesiones.',
    sharingTitle: 'Uso compartido del estado',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Vinculada',
    configCopiedShort: 'Copiada',
    configIsolatedShort: 'Aislada',
    stateSharedShort: 'Sesiones compartidas',
    stateIsolatedShort: 'Sesiones separadas',
    perAgentTitle: 'Uso compartido por agente',
    perAgentDescription: 'Sustituye estos valores para un agente.',
    perAgentPurpose: 'Elige, por agente, qué comparten las sesiones de cuentas conectadas con tu propio inicio de sesión.',
    servicePurpose: ({ service }) => `Las cuentas con las que inicias sesión en ${service} y los grupos que las comparten.`,
    chooseMachineTitle: 'Elige una máquina',
    chooseMachineDescription: 'Añadir, iniciar sesión y quitar cuentas se hace en una de tus máquinas. Tus cuentas siguen en Servicios conectados.',
    newAccountTitle: 'Cuenta nueva',
    newAccountDescription: 'Elige cómo iniciar sesión.',
    newAccountInProgress: 'Termina de iniciar sesión abajo.',
    modeBrowser: 'Iniciar sesión con un navegador',
    modeDeviceCode: 'Iniciar sesión con un código',
    modeManual: 'Introducir un token',
    serviceSettingsTitle: 'Ajustes del servicio',
    serviceSettingsDescription: 'Ajustes con los que inicia sesión cada cuenta de este servicio.',
    noAccountsDescription: 'Añade una cuenta para que tus agentes puedan iniciar sesión con ella.',
    accountDetailsTitle: 'Detalles de la cuenta',
    poolEmptyTitle: 'Añade cuentas a este grupo',
    poolEmptyDescription: 'Un grupo pasa las sesiones a la siguiente cuenta cuando una llega a su límite. Elige sus cuentas abajo.',
    agentDefaultsTitle: 'Cuenta predeterminada por agente',
    agentDefaultsDescription: 'La cuenta con la que cada agente inicia sesión al empezar una sesión.',
    agentDefaultsKeywords: 'cuenta predeterminada',
    namesAnd: ({ names, last }) => `${names} y ${last}`,
    usedBy: ({ names }) => `Lo usan ${names}`,
    poolRuleMostLeft: 'usa el que tiene más disponible',
    poolRuleInOrder: 'los usa en orden',
    poolRuleManual: 'lo cambias tú',
    poolInUse: ({ pool }) => `${pool} · en uso`,
    agentDefault: ({ agent }) => `Predeterminada de ${agent}`,
    signedOutBy: ({ service }) => `${service} cerró la sesión`,
    usageReadFailed: 'No se pudo leer el uso',
    usageWindowPin: ({ meter }: { meter: string }) => `Mostrar ${meter} junto al compositor`,
    noLimitsBilledPerUse: 'Sin límites informados · se factura por uso',
    needsYouCount: ({ count }) => count === 1 ? '1 te necesita' : `${count} te necesitan`,
    connectToolsTitle: 'Conecta un alojamiento de código o una herramienta',
    inviteTitle: ({ names }) => `Tus agentes también pueden usar ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} puede iniciar sesión con él.`,
    inviteWhoMany: ({ agents }) => `${agents} pueden iniciar sesión con ellos.`,
    inviteTools: 'O conecta un alojamiento de código y herramientas.',
    firstRunTitle: 'Usa los planes que ya pagas',
    firstRunPromise: 'Conecta tu cuenta de Claude o ChatGPT una vez. Tus agentes la usan en todas tus máquinas y Happier te muestra cuánto te queda antes de llegar al límite.',
    connectAnAccount: 'Conectar una cuenta',
    firstRunMeanwhile: 'Mientras tanto, cada agente usa su propio inicio de sesión en cada máquina.',
    agentAccountsTitle: 'Cuentas de los agentes',
    agentAccountsDescription: 'Suscripciones y claves que usan tus agentes. Se guardan en tu cuenta para que cualquier máquina pueda usarlas.',
    codeAndToolsTitle: 'Código y herramientas',
    setupChooseMachine: 'Elige una máquina para iniciar sesión. Después la cuenta funciona en todas tus máquinas.',
    setupHowToSignIn: 'Cómo iniciar sesión',
    setupRecommendedMethod: ({ method }) => `${method} · Recomendado`,
    setupCatalogTitle: 'Conectar un servicio',
    setupCatalogPurpose: 'El inicio de sesión se ejecuta en la máquina que elijas. Después la cuenta funciona en todas tus máquinas.',
    setupServiceTitle: ({ service }) => `Conectar ${service}`,
    setupReconnectTitle: ({ service }) => `Vuelve a iniciar sesión en ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} usarán tu cuenta de ${service} en todas las máquinas.`,
    setupServicePurposeNoAgents: 'La cuenta funciona en todas las máquinas.',
    setupForYourAgents: 'Para tus agentes',
    setupOwnLoginTitle: '¿Ya iniciaste sesión en una máquina?',
    setupOwnLoginBody: 'Sigue usando el inicio de sesión propio del agente. Elígelo en Cómo se usan las cuentas.',
    setupToolsTitle: 'Alojamientos de código y herramientas',
    setupProvidersPointer: 'Los proveedores de modelos como OpenRouter y Ollama se configuran en Proveedores.',
    setupOpenProviders: 'Abrir Proveedores',
    setupTrust: 'Se guarda en tu cuenta y solo lo usan tus máquinas. Happier mantiene la sesión al día por ti.',
    setupConnectedCount: ({ count }) => `${count} conectadas`,
    settleConnectedAs: ({ identity }) => `Conectada ahora mismo como ${identity}.`,
    settleConnected: 'Conectada ahora mismo.',
    settleUseFor: ({ agent }) => `¿Usarla para ${agent}?`,
    settleUseForAction: ({ agent }) => `Usar para ${agent}`,
    notNow: 'Ahora no',
    homeInvitePromise: 'Conecta Claude o ChatGPT una vez. Todas tus máquinas pueden usarlo y aquí verás cuánto te queda.',
    homeInviteHide: 'Ocultar',
    homeNextWho: ({ agents }) => `${agents} también puede usarlo`,
    oauthStepOpen: 'Abre la página de inicio de sesión en tu navegador',
    oauthStepApprove: 'Aprueba y copia el código que muestra la página (o la dirección a la que llegas)',
    oauthStepPaste: 'Pégalo aquí',
    oauthPastePlaceholder: 'Pega el código o la dirección',
    oauthShapeOk: 'Parece un código de inicio de sesión',
    deviceEnterAt: ({ where }) => `Introduce este código en ${where}`,
    deviceExpired: 'El código caducó. No se guardó nada.',
    deviceExpiresIn: ({ time }) => `El código caduca en ${time}`,
    deviceNewCode: 'Obtener un código nuevo',
    detailSignedOutTitle: ({ service }) => `${service} cerró la sesión de esta cuenta`,
    detailSignedOutBody: 'El inicio de sesión se revocó o cambió, por ejemplo tras un cambio de contraseña. Las sesiones no pueden usar esta cuenta hasta que vuelvas a iniciar sesión.',
    detailSignInTitle: 'Inicio de sesión',
    detailSignInNeeded: 'Necesita volver a iniciar sesión',
    detailSignInKeptFresh: 'Happier la mantiene al día',
    detailLastUsed: ({ time }) => `último uso ${time}`,
    detailLeavePool: ({ pool }) => `Quitar de ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} usa esta cuenta; quítala primero del grupo. Eliminarla la borra de tu cuenta y de todas las máquinas.`,
    detailUsageSignedOut: 'Último valor conocido · no se puede actualizar sin sesión',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Último valor conocido a las ${time} · no se puede actualizar sin sesión`,
    detailResetsIn: ({ countdown }) => `en ${countdown}`,
    detailUsedByTitle: 'Lo usan',
    detailUsedByDefault: 'Su cuenta predeterminada',
    detailUsedByPool: ({ pool }) => `A través de ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `A través de ${pool} · en uso ahora`,
    detailUsedByCould: 'Pueden usarla · hoy inician sesión a su manera',
    detailWorksOnTitle: 'Funciona en',
    detailWorksOnDescription: 'Guardada en tu cuenta. Una máquina la usa cuando empieza allí una sesión; no se copia nada por adelantado.',
    detailSignedInWithCode: 'Sesión iniciada con un código',
    detailSignedInWithBrowser: 'Sesión iniciada con un navegador',
    detailAddedWithKey: 'Añadida con una clave',
    nearLimitTitle: ({ account, percent, window }) => `A ${account} le queda un ${percent}% del límite de ${window}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Queda un ${percent}% del límite de ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Se restablece a las ${time}. Aplica un restablecimiento de uso para seguir ahora.`,
    nearLimitBody: 'Aplica un restablecimiento de uso para seguir ahora.',
    nearLimitApplyReset: 'Aplicar un restablecimiento',
    catalogSignInBrowserOrCode: 'Inicia sesión con un navegador o un código',
    catalogSignInBrowserOrKey: 'Inicia sesión con un navegador o pega un token',
    catalogSignInBrowser: 'Inicia sesión con un navegador',
    catalogSignInCode: 'Inicia sesión con un código',
    catalogPasteKey: 'Pega una clave',
    deviceOpenService: ({ service }) => `Abrir ${service}`,
    deviceWaitingFor: ({ service }) => `Esperando a que lo apruebes en ${service}…`,
};

const connectedServicesSettingsTranslations = { es };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { es: {
        connectMoreTitle: 'Conectar más',
        connectMoreDescription: 'Servicios que aceptan los agentes de tus máquinas y que aún no has conectado.',
        connectMoreNothingNew: 'Añade otra cuenta, un alojamiento de código o una herramienta.',
        serviceSignInInstead: ({ agents }) => `${agents} puede iniciar sesión con él en lugar del inicio de sesión de cada máquina.`,
        serviceCanUse: ({ agents }) => `${agents} puede usarlo.`,
        moreServicesTitle: 'Más servicios',
        moreServicesTools: ({ names }) => `${names} y más, para código y herramientas.`,
        moreServicesAll: 'Todo lo que aceptan tus agentes y herramientas.',
        browse: 'Explorar',
        notNow: ({ service }) => `Ahora no: ${service}`,
        notNowTooltip: 'Ahora no · sigue en Explorar',
        back: 'Todos los servicios',
        homeCatalogTitle: 'Conectar una cuenta',
        homeCatalogPurpose: 'Tus agentes la usan en todas las máquinas y Home muestra cuánto queda.',
        homeNextSubtitle: ({ agents }) => `${agents} puede usarla en lugar del inicio de sesión de cada máquina.`,
        firstRunMore: 'Claves de API, alojamientos de código y herramientas',
        settleAddToPoolWhy: ({ pool, agent, active }) => `¿Añadirla a ${pool}, para que ${agent} pase a ella cuando se agote ${active}?`,
        settleAddToPoolShort: ({ pool }) => `¿Añadirla a ${pool}?`,
        settleAddToPool: ({ pool }) => `Añadir a ${pool}`,
        deviceStepCopy: 'Copia este código',
        deviceStepOpen: ({ service }) => `Abre ${service} e introdúcelo`,
        deviceStepOpenWhere: ({ where }) => `${where}, con la sesión iniciada en la cuenta que quieres usar`,
        deviceStepApprove: ({ service }) => `Aprueba Happier en ${service}`,
        deviceCheckNow: 'Comprobar ahora',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "es">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { es: {
        approval: {
            requestTitle: 'Solicitud',
            requestDescription: 'Qué se pidió y en qué estado está.',
            failureTitle: 'Por qué falló',
            homeUnavailableTitle: 'Home no disponible',
            contextTitle: 'Solicitado por',
            contextDescription: 'La sesión y el agente que lo pidieron.',
            proposalsDescription: 'Se publican en la revisión si apruebas.',
        },
        runs: {
            description: 'Ejecuciones en segundo plano en tus máquinas.',
            filterLabel: 'Ejecuciones que se muestran',
            filterRunning: 'En curso',
            filterAll: 'Todas',
            onHome: ({ home }) => `En ${home}`,
        },
        person: {
            placeholderTitle: 'Persona',
            friendshipTitle: 'Amistad',
            sharedSessionsDescription: 'Sesiones que este amigo comparte contigo, solo lectura.',
            linkedAccountsTitle: 'Cuentas vinculadas',
            linkedAccountsDescription: 'Dónde más inicia sesión. Se abre en tu navegador.',
        },
        friendsManage: {
            description: 'Las personas con las que trabajas en Happier y las solicitudes entre vosotros.',
            requestsTitle: 'Solicitudes de amistad',
            requestsDescription: 'Abre una solicitud para aceptarla o rechazarla.',
            sentTitle: 'Solicitudes enviadas',
            sentDescription: 'Esperando a que acepten.',
            friendsTitle: 'Amigos',
            friendsDescription: 'Abre un amigo para ver lo que comparte contigo.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "es">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { es: {
        closeUnsavedTabA11y: 'Cerrar pestaña, tiene cambios sin guardar',
        emptyTitle: 'Aquí se abren archivos, cambios y commits',
        browseFiles: 'Explorar archivos',
        previewHint: 'Un clic abre una vista previa; ábrela de nuevo para conservarla.',
        emptyReason: 'Los archivos, cambios y commits que abras aparecen aquí, junto a donde los abriste.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisar 1 cambio' : `Revisar ${count} cambios`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'Cambió 1 archivo en esta sesión. Léelo aquí sin salir de la conversación.'
            : `Cambiaron ${count} archivos en esta sesión. Léelos aquí sin salir de la conversación.`),
        splitNeedsWiderPane: 'La vista en paralelo necesita un panel más ancho. Ensancha Detalles o usa Enfoque.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "es">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { es: {
        areaUnstaged: 'Sin preparar',
        areaStaged: 'Preparados',
        areaBoth: 'Ambos',
        areaLabel: 'Cambios',
        preview: 'Vista previa',
        viewLabel: 'Vista',
        compare: 'Comparar',
        stage: 'Preparar',
        unstage: 'Quitar de preparados',
        addToCommit: 'Añadir al commit',
        removeFromCommit: 'Quitar del commit',
        editing: 'Editando',
        editingUnsaved: 'Editando · cambios sin guardar',
        statusModified: 'Modificado',
        statusAdded: 'Añadido',
        statusDeleted: 'Eliminado',
        statusRenamed: 'Renombrado',
        statusCopied: 'Copiado',
        statusUntracked: 'Nuevo, aún sin seguimiento',
        statusConflicted: 'Tiene conflictos',
        noChanges: 'Sin cambios',
        lines: ({ count }) => (count === 1 ? '1 línea' : `${count} líneas`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "es">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { es: {
        copyCommitSha: 'Copiar el SHA del commit',
        filesChanged: ({ count }) => (count === 1 ? '1 archivo cambiado' : `${count} archivos cambiados`),
        files: ({ count }) => (count === 1 ? '1 archivo' : `${count} archivos`),
        revertEllipsis: 'Revertir…',
        stashKeptOn: ({ branch }) => `Guardado en ${branch}`,
        stashOriginBranch: ({ branch }) => `Guardado al salir de ${branch}`,
        stashOriginBranchShort: 'Al cambiar de rama',
        stashOriginTransient: 'Guardado por Happier',
        stashOriginUnmanaged: 'Creado fuera de Happier',
        stashRestoreExplains: ({ folder }) => `Al restaurar, estos cambios vuelven a ${folder} y se elimina el stash. Nada más cambia en la carpeta.`,
        stashApply: 'Aplicar',
        stashApplyA11y: 'Aplicar estos cambios y conservar el stash',
        stashDiscardEllipsis: 'Descartar…',
        stashSwitcherA11y: 'Elegir un stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "es">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { es: {
        title: 'Revisión',
        files: ({ count }) => (count === 1 ? `1 archivo` : `${count} archivos`),
        nextCommit: ({ count }) => `${count} en el próximo commit`,
        changedFiles: 'Archivos cambiados',
        commitColumn: 'Commit',
        jumpA11y: 'Ir a un archivo',
        comments: ({ count }) => (count === 1 ? `1 comentario` : `${count} comentarios`),
        goesWithNext: ({ count }) => (count === 1 ? `va con tu próximo mensaje` : `van con tu próximo mensaje`),
        askForChanges: 'Pedir cambios',
        detachCommentA11y: 'Dejar este comentario fuera del próximo mensaje',
        trayExpandedHint: 'Van con tu próximo mensaje al agente.',
        askPlaceholder: 'Dile al agente qué cambiar…',
        send: 'Enviar',
        draftAuthor: 'Tú', draftStatus: 'borrador', includeComment: 'Va con tu próximo mensaje',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "es">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { es: translated({
        settingsEmbeds: {
            title: "Inserciones",
            newTitle: "Nueva inserción",
            purpose: "Deja que otras apps muestren chats de Happier, solo con el acceso que elijas.",
            yourEmbeds: "Tus inserciones",
            newEmbed: "Nueva inserción",
            listError: "No se pudieron cargar las inserciones",
            emptyTitle: "Pon un chat de Happier dentro de tu propia app",
            emptyBody: "Tu app muestra conversaciones reales, solo con el acceso que elijas: qué sitios, quién puede enviar o aprobar y qué modelos.",
            createDescription: "Elige qué pueden hacer otras apps con tus chats y cómo se ven.",
            name: "Nombre",
            nameDescription: "Solo lo ves tú, en esta lista.",
            namePlaceholder: "Por ejemplo, panel de leads",
            create: "Crear inserción",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 sitio' : `${count} sitios`,
                send: "Puede enviar",
                sendAndApprove: "Puede enviar y aprobar",
                viewOnly: "Solo ver",
                modelOnly: ({ name }: { name: string }) => `solo ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 modelo' : `${count} modelos`,
            },
            sites: {
                title: "Dónde puede aparecer",
                description: "Los chats solo se abren en estos sitios.",
            },
            capabilities: {
                title: "Qué puede hacer la gente",
                view: "Ver la conversación",
                always: "Siempre",
                send: "Enviar mensajes",
                sendDescription: "Incluye detener al agente y adjuntar archivos.",
                changeModel: "Cambiar de modelo",
                permissionModes: "Modos de permiso",
                permissionModesDescription: "Los chats muestran un selector de modo solo si se permite más de un modo.",
                anyMode: "Cualquier modo",
                anyModeDescription: "Las personas pueden cambiar cuánto hace el agente sin preguntar.",
                modeOnly: ({ name }: { name: string }) => `solo ${name}`,
                modes: ({ count }: { count: number }) => `${count} modos`,
                approveOn: "Las personas de estos sitios pueden aprobar el uso de herramientas y las solicitudes en estos chats.",
            },
            models: {
                title: "Modelos",
                description: "Los demás modelos se rechazan, no solo se ocultan. Los chats empiezan con el primer modelo permitido.",
                allowed: "Modelos permitidos",
                any: "Cualquier modelo",
            },
            organization: {
                title: "Organización",
                description: "Tu app lista desde aquí los chats de esta inserción (con cualquiera de estas etiquetas). Los chats nuevos también llegan aquí.",
                folder: "Carpeta",
                tags: "Etiquetas",
                none: "Ninguna",
            },
            composer: {
                title: "Redacción",
                attachments: "Adjuntos",
                attachmentsDescription: "Oculta el botón de adjuntar. Quien puede enviar aún puede adjuntar archivos mediante la API.",
            },
            sessions: {
                title: "Sesiones",
                description: "Las sesiones que crea esta clave, desde tu servidor o el chat, se ejecutan en este ordenador con este agente y llegan a la carpeta y las etiquetas de arriba.",
                allow: "Permitir que esta clave cree sesiones",
                offConsequence: "Esta clave no puede crear sesiones. Tu app solo puede mostrar chats que ya existen.",
                computer: "Ordenador",
                agent: "Agente",
                newChat: "Empezar chats nuevos en la inserción",
                appSetting: "Para tu aplicación",
                newChatDescription: "Muestra un cuadro de chat nuevo cuando tu app abre la inserción sin un chat. Es un ajuste para tu app, no un límite de seguridad: tu servidor siempre puede crear chats con esta clave.",
            },
            appearance: {
                title: "Apariencia",
                description: "La vista previa sigue cada cambio. Los chats abiertos se actualizan sin recargar.",
                mode: "Modo",
                modeSystem: "Sistema",
                modeLight: "Claro",
                modeDark: "Oscuro",
                theme: "Tema",
                presetHappier: "Happier",
                colors: "Colores",
                colorsDefault: "Colores de Happier",
                colorsCustomized: ({ count }: { count: number }) => count === 1 ? '1 personalizado' : `${count} personalizados`,
                colorsFor: "Colores para",
                colorGroups: {
                    surface: "Superficies",
                    text: "Texto",
                    accent: "Acento",
                    messages: "Mensajes",
                    composer: "Redacción",
                    approvals: "Aprobaciones",
                },
                fontFamily: "Fuente",
                fontFamilyPlaceholder: "Fuente de Happier",
                fontFile: "Archivo de fuente",
                fontFileDescription: "Un enlace https a un archivo .woff2 o .woff.",
                fontFileRefused: "Usa un enlace a un archivo .woff2 o .woff, no una hoja de estilos.",
                textSize: "Tamaño del texto",
                textSizeCompact: "Compacto",
                textSizeDefault: "Predeterminado",
                textSizeLarge: "Grande",
                corners: "Esquinas",
                cornersSharp: "Rectas",
                cornersSoft: "Suaves",
                cornersRound: "Redondas",
                density: "Densidad",
                densityCompact: "Compacta",
                densityComfortable: "Cómoda",
                reset: "Restablecer apariencia",
            },
            preview: {
                title: "Vista previa en vivo",
                phone: "Teléfono",
                desktop: "Escritorio",
                reduceMotion: "Reducir movimiento",
                note: "El chat insertado real con mensajes de ejemplo. Aquí no se envía nada.",
                rowDescription: "Mira el chat con estos ajustes.",
                unavailable: "Vista previa no disponible",
            },
            snippets: {
                title: "Fragmentos de código",
                description: "Pégalos en tu app. Ya usan los ajustes de esta inserción.",
                steps: "1 Guarda la clave como HAPPIER_EMBED_KEY · 2 Escribe canOpenSession: quién puede abrir qué chat · 3 Muestra el chat",
                backend: "Servidor",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Creada el ${date}`,
                lastUsed: ({ date }: { date: string }) => `Último uso ${date}`,
                expires: ({ date }: { date: string }) => `Caduca el ${date}`,
                reconnect: "Los chats abiertos se reconectan con el nuevo acceso. Los borradores se conservan.",
                e2eeTrust: "Esta clave puede leer los chats cifrados de esta cuenta. Usa una cuenta dedicada para tu app.",
                keyReach: "La clave se queda en tu servidor y puede llegar a todos los chats de esta cuenta. Los navegadores nunca la ven: reciben claves de corta duración limitadas a los chats que tu servidor permite.",
                expiry: "La clave caduca",
                expiryDescription: "Cuando la clave caduca, los chats dejan de abrirse. No se puede ampliar después.",
                encryptionChecking: "Comprobando el cifrado de esta cuenta…",
                encryptionUnavailable: "Este dispositivo aún no puede leer los chats cifrados de esta cuenta. Restaura tu clave secreta para crear la inserción.",
                encryptionStale: "Las claves de este dispositivo para los chats cifrados están desactualizadas. Restaura tu clave secreta para crear la inserción.",
                encryptionUnreadable: "No se pudo comprobar el cifrado de esta cuenta.",
                missingTitle: "Esta inserción ya no existe",
                backToEmbeds: "Volver a inserciones",
            },
            delete: {
                button: "Eliminar inserción",
                title: ({ label }: { label: string }) => `¿Eliminar «${label}»?`,
                body: "Los chats abiertos se desconectan. Las claves ya usadas para leer chats cifrados no se pueden recuperar.",
                confirm: "Eliminar",
            },
            reveal: {
                copyEnv: "Copiar como línea .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { es: translated({
        embed: {
            errors: {
                originNotAllowed: 'Esta página no puede mostrar esta conversación.',
                originNotAllowedReason: 'Añade este sitio a los sitios permitidos de la inserción en Happier.',
                unavailable: 'Esta conversación no está disponible aquí.',
                encrypted: 'Esta conversación está cifrada y no se puede abrir aquí.',
                createNotGranted: 'Esta aplicación no puede iniciar chats nuevos.',
                unsupportedVersion: 'Este chat necesita una inserción más reciente.',
                unsupportedVersionReason: 'Actualiza @happier-dev/embed en esta aplicación.',
            },
            nothingToShow: 'Todavía no hay nada que mostrar',
            nothingToShowReason: 'Esta aplicación no ha abierto ninguna conversación.',
            reconnecting: 'Reconectando…',
            previewUnavailable: 'Vista previa no disponible',
            previewUser: "Analiza este lead y registra el resultado: Acme Robotics, 40 puestos, evaluando en el cuarto trimestre.",
            previewAgent: "Encaja muy bien. El presupuesto está confirmado y el promotor decide. Registré el análisis:",
            previewFollowUp: "¿Pasamos este lead a calificado?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const es: EntityDragDropTranslations = {
    files: { attach: "Adjuntar", uploadHere: "Subir aquí" },
    composer: { addContext: "Añadir contexto", consequence: "Se envía con tu próximo mensaje · aún no se envía nada", target: "Redactor", readOnly: "Este redactor es de solo lectura", otherWorkspace: "No forma parte de este espacio de trabajo", unavailable: "Esta referencia no está disponible" },
    surface: {
        scopeMismatch: 'Está en otro Home o cuenta',
        widgetMoveUnavailable: 'Este widget no se puede mover a esta superficie',
        readOnly: 'Este tablero es de solo lectura',
        copyDetail: 'Conserva una referencia · el tablero no cambia',
    },
    preview: {
        putUnder: ({ target }) => `Poner debajo de ${target}`,
        putUnderDetail: 'Le informa · las dos siguen en marcha',
        moveAbove: ({ target }) => `Mover encima de ${target}`,
        moveBelow: ({ target }) => `Mover debajo de ${target}`,
        orderDetail: 'Solo el orden · nadie informa a nadie',
        moveToFolder: ({ folder }) => `Mover a ${folder}`,
        folderDetail: 'Solo la carpeta · no informa a nadie',
        moveToTopLevel: 'Mover al nivel superior',
        topLevelDetail: 'Fuera de su carpeta · nada más cambia',
        cantPutUnder: ({ target }) => `No se puede poner debajo de ${target}`,
        cantMoveHere: 'No se puede mover aquí',
        pendingPutUnder: ({ target }) => `Poniéndola debajo de ${target}…`,
        pendingDetail: 'Esperando a que el Home lo confirme',
        unknownTitle: 'No es seguro que se haya movido',
        unknownDetail: 'Revisa la lista en un momento antes de volver a intentarlo',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `No se pudo poner ${item} debajo de ${target}`,
        refused: ({ verb }) => `${verb}: no se completó`,
        unknown: ({ verb }) => `No está claro si «${verb}» se completó`,
        dismiss: 'Descartar',
    },
    reasons: {
        read: 'Se compartió contigo solo para leer, así que no puede recibir informes',
        input: 'No puedes enviarle nada, así que no puede recibir informes',
        pairwise: 'Estas dos sesiones no pueden compartir su contexto',
        cycle: 'Esa sesión ya informa a esta',
        alreadyUnder: 'Ya informa a esta',
        archived: 'Está archivada',
        differentHome: 'Está en otro Home. Las sesiones informan dentro de un mismo Home',
        unavailable: 'No se pudo comprobar esta sesión ahora mismo',
        dateOrder: 'Esta lista se ordena por fecha. Cambia al orden personalizado para colocarla',
        noChange: 'Ya está aquí',
        descendantCycle: 'Una carpeta no puede ir dentro de sí misma',
        maxDepth: 'Las carpetas quedarían demasiado anidadas',
        foldersOff: 'Las carpetas están desactivadas en este Home',
        gone: 'Ese lugar acaba de desaparecer',
        generic: 'Este lugar no lo admite',
    },
    chooser: { putUnderTitle: ({ item }) => `Poner ${item} debajo de…`, checking: 'Comprobando qué sesiones pueden recibir informes…', cantTakeReports: 'No pueden recibir informes', unavailable: 'No disponible' },
    keyboard: {
        choose: 'Elige un lugar', putUnder: 'Poner debajo', topLevel: 'Nivel superior', drop: 'Soltar', cancel: 'Cancelar', escapeKey: 'Esc',
        hintsA11y: 'Las flechas eligen un lugar, Intro suelta, Escape cancela',
    },
    organize: { enter: 'Organizar la lista', title: 'Organizar', done: 'Listo', grip: ({ item }) => `Mover ${item}` },
    pane: {
        openHere: 'Abrir aquí como pestaña',
        nextTo: ({ target }) => `Junto a ${target} · no se cierra nada`,
        nothingCloses: 'Se abre como pestaña · no se cierra nada',
        tooNarrow: 'Este panel es demasiado estrecho para dividirlo',
        moveHere: 'Mover aquí como pestaña',
        openBefore: ({ target }) => `Abrir antes de ${target}`,
        moveBefore: ({ target }) => `Mover antes de ${target}`,
        placeOnly: 'Solo cambia de sitio',
        splitLeft: 'Dividir a la izquierda',
        splitRight: 'Dividir a la derecha',
        splitUp: 'Dividir arriba',
        splitDown: 'Dividir abajo',
        opensBeside: ({ target }) => `Se abre junto a ${target}`,
        movesBeside: ({ target }) => `Se mueve junto a ${target}`,
        goTo: ({ target }) => `Ir a ${target}`,
        openInThisPane: 'Ya está abierta en este panel · no se abre nada nuevo',
        openInAnotherPane: 'Ya está abierta en otro panel · no se abre nada nuevo',
        alreadyHere: 'Ya está aquí',
        leaveIt: 'Suéltala para dejarla donde está',
        cantOpenHere: 'No se puede abrir aquí',
        sessionsOnly: 'Este panel solo muestra sesiones',
        otherWorkspace: 'No forma parte de este espacio de trabajo',
    },
};

const entityDragDropTranslations = { es };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const es = {
    eventAutomationComposer: {
        available: 'Disponible',
        payloadFields: 'CAMPOS DE CARGA ÚTIL',
        payloadSample: 'Carga útil de muestra',
        noFilterableFields: 'Este evento no declara campos de carga útil filtrables.',
        addFilterClause: 'Agregar condición',
        filterField: 'Campo de filtro',
        filterOperator: 'Operador de filtro',
        filterEquals: 'igual',
        filterOneOf: 'es uno de',
        filterValue: 'Valor del filtro',
        filterValuePlaceholder: '"valor" o ["valor"]',
        storedContentUnavailableTitle: 'El contenido de automatización almacenado no está disponible',
        storedContentUnavailableBody: 'Esta automatización de eventos no se puede guardar porque su contenido almacenado no está disponible.',
        historyGapRecoveryTitle: 'La brecha histórica necesita atención',
        historyGapRecoverySubtitle: 'Restablezca la línea base de origen para continuar observando nuevos eventos.',
        historyGapRecoveryUnavailable: 'La acción de recuperación de origen no está disponible en su observador actual.',
        historyGapRecoveryFailureTitle: 'La recuperación de la fuente necesita otro intento',
        historyGapRecoveryFailureBody: 'La recuperación no fue confirmada. La fuente todavía necesita atención.',
        sourceStatusTitle: 'Fuente de observación',
        sourceStatusState: {
            uninitialized: 'Sin iniciar',
            baselined: 'Línea base lista',
            observing: 'Observando',
            backingOff: 'Esperando para reintentar',
            attention: 'Requiere atención',
        },
        sourceStatusCode: {
            credentialMissing: 'Se requieren credenciales',
            credentialRevoked: 'Credencial revocada',
            rateLimited: 'Límite de solicitudes alcanzado',
            historyGap: 'Laguna en el historial',
            capacityBlocked: 'Capacidad agotada',
            definitionStale: 'La definición cambió',
            sourceContractIncompatible: 'La fuente necesita actualizarse',
            admissionUnavailable: 'Admisión no disponible',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Próximo intento: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Eventos observados: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Eventos admitidos: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Eventos omitidos: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Última observación: ${time}`,
        sourceCatalogStatusTitle: 'Conciliación del catálogo',
        sourceCatalogStatusState: {
            current: 'Actual',
            reconciling: 'En conciliación',
            reconciliationLate: 'La conciliación está retrasada',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Revisión observada: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Revisión adoptada: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Aún no se adoptó ninguna revisión',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Análisis iniciado: ${time}`,
    },
};

const eventAutomationComposerTranslations = { es } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { es: {
    browseLinked: 'Vinculada',
    browseImported: 'Importada',
    browseAgentUnavailable: 'Happier no pudo iniciar ni conectar con el Agent seleccionado en esta máquina. Comprueba que su CLI esté instalada allí y vuelve a intentarlo.',
    browseAgentTimedOut: 'El Agent seleccionado en esta máquina no respondió a tiempo. Puede que esté ocupado o que siga indexando, así que vuelve a intentarlo.',
    browseAgentFailed: 'Happier no pudo leer las sesiones del Agent seleccionado en esta máquina. Vuelve a intentarlo; si sigue fallando, actualiza Happier en esa máquina.',
    operationTitleMaterialize: 'Importar a Happier',
    operationTitleTakeoverLinked: 'Tomar el control y continuar vinculada',
    operationTitleTakeoverPersisted: 'Importar y tomar el control',
    operationMaterializeAvailable: 'Importa esta sesión vinculada para usar su transcripción sin conexión o compartirla.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} en ${machine}: ${status}`,
    operationStatusRunning: 'En curso',
    operationStatusCancelling: 'Cancelando…',
    operationStatusCancelled: 'Cancelada',
    operationStatusCompleted: 'Completada',
    operationStatusDiscarded: 'Sesión parcial descartada',
    operationStatusNeedsResume: 'Esperando a que reanudes',
    operationStatusNeedsReview: 'Necesita revisión antes de continuar',
    operationStatusFailed: 'No se pudo continuar',
    operationStatusImportIncomplete: 'Importación incompleta — Reanuda o descarta la sesión parcial',
    operationStatusUpdateIncomplete: 'Actualización incompleta — Reanuda',
    operationStatusOriginOffline: 'Progreso guardado — la máquina de origen está desconectada',
    operationStatusOriginUnknown: 'Progreso guardado — Happier no puede saber si la máquina de origen está conectada',
    operationStatusExternalWriter: 'Se detectó un escritor externo',
    operationStatusSpawnFailedAfterImport: 'Importada, pero no se pudo iniciar el Agent — Reintentar inicio',
    operationStatusSpawnFailedAfterTakeover: 'Control asumido, pero no se pudo iniciar el Agent — Reintentar inicio',
    operationErrorSourceUnavailable: 'El origen no está disponible. Vuelve a conectar la máquina de origen y reanuda.',
    operationErrorSourceChanged: 'El origen cambió mientras se leía. Revísalo antes de reanudar.',
    operationErrorCapacity: 'Esta máquina no tiene suficiente capacidad temporal para continuar.',
    operationErrorRequiredItems: 'No se pudieron importar algunos elementos obligatorios de la sesión.',
    operationErrorImport: 'La importación de mensajes se interrumpió.',
    operationErrorPublication: 'No se pudo publicar la instantánea importada.',
    operationErrorAdmission: 'Happier no pudo tomar el control de esta sesión de forma segura.',
    operationErrorExternalWriter: 'Detén el Agent externo antes de intentarlo de nuevo. Happier no lo combinará ni lo detendrá automáticamente.',
    operationErrorInternal: 'La operación se detuvo por un error interno.',
    operationPhaseValidating: 'Validando',
    operationPhaseWaitingForAgent: 'Esperando a que se detenga el Agent externo',
    operationPhaseReadingSource: 'Leyendo el origen',
    operationPhaseImporting: 'Importando mensajes',
    operationPhaseCatchingUp: 'Sincronizando con el origen',
    operationPhasePreparingRuntime: 'Preparando el runtime',
    operationPhaseStartingRuntime: 'Iniciando el runtime',
    operationPhaseFinalizing: 'Finalizando',
    operationPhasePublishing: 'Publicando la sesión importada',
    operationActionResume: 'Reanudar',
    operationActionRetryStart: 'Reintentar inicio',
    operationActionCancel: 'Cancelar',
    operationActionDiscard: 'Descartar sesión parcial',
    operationActionDismiss: 'Cerrar',
    operationStatusOwnerReadFailed: 'Happier no pudo leer el progreso actual de esta operación.',
    operationActionCheckAgain: 'Volver a comprobar',
    operationComposerImporting: 'Importando…',
    operationComposerTakingOver: 'Tomando el control…',
    operationActionErrorUpgradeRequired: 'Actualiza Happier en la máquina de origen para usar esta acción.',
    operationActionErrorNotFound: 'Esta operación ya no está disponible.',
    operationActionErrorConflict: 'Otra operación ya está controlando esta sesión.',
    operationActionErrorStaleRevision: 'La operación cambió. Revisa el progreso más reciente e inténtalo de nuevo.',
    operationActionErrorInvalidState: 'Esta acción no está disponible en el estado actual de la operación.',
    operationActionErrorNotAllowed: 'No tienes permiso para controlar esta operación.',
    operationActionErrorUnavailable: 'No se pudo completar la acción. Inténtalo de nuevo desde el progreso más reciente.',
    operationImportProgress: 'Progreso de importación',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} mensajes importados`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} de ~${total} mensajes`,
    operationPublishedSnapshot: 'Instantánea publicada conservada',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Disponible hasta el mensaje ${sequence}`,
    operationDiscardConfirmTitle: '¿Descartar la sesión parcial?',
    operationDiscardConfirmBody: 'Esto elimina toda la sesión parcial. Esta acción no se puede deshacer.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `La transcripción de esta sesión está en ${machine}. Impórtala a Happier para compartirla.`,
    sharingImportIncomplete: 'La importación está en curso o incompleta. Reanúdala antes de compartir.',
    sharingTranscriptUnavailableTitle: 'Transcripción no disponible',
    transcriptRetainedRefreshFailedTitle: 'Mostrando la última transcripción conocida',
    transcriptLoadFailed: 'Happier no pudo cargar esta transcripción.',
    sharingTranscriptUnavailable: 'La transcripción no está disponible. Esta sesión vinculada antigua no tiene una transcripción persistente segura.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Compartida hasta ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Instantánea de ${time}`,
    sharingUpdateSharedCopy: 'Actualizar copia compartida',
    sharingUpdateSharedCopyDescription: 'Actualiza la instantánea compartida con la transcripción más reciente del origen.',
    sharingSourceMachineMissing: 'La máquina de origen no está disponible. Vuelve a conectarla a Happier antes de intentarlo de nuevo.',
    sharingSourceMachineOffline: 'La máquina de origen está desconectada. Conéctala antes de intentarlo de nuevo.',
    sharingActionAwaitingAvailability: 'Esta acción estará disponible cuando se conecte el flujo de materialización.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { es: {
    settingsIntegrationStatusNotInstalled: 'No instalada',
    settingsIntegrationStatusEnabled: 'Instalada y activada',
    settingsIntegrationStatusDisabled: 'Instalada y desactivada',
    settingsIntegrationStatusNeedsAttention: 'Necesita atención',
    settingsIntegrationStatusUnsupported: 'Esta versión del Agent no es compatible',
    settingsIntegrationStatusUnavailable: 'Agent no disponible',
    settingsIntegrationInventoryLoadingTitle: 'Comprobando el estado de las integraciones',
    settingsIntegrationInventoryLoadingSubtitle: 'Leyendo el inventario completo de integraciones de esta máquina.',
    settingsIntegrationInventoryPartialTitle: 'Estado de integraciones incompleto',
    settingsIntegrationInventoryPartialSubtitle: 'No se pudieron leer algunos registros de instalación. Comprueba de nuevo antes de hacer cambios.',
    settingsIntegrationInventoryErrorTitle: 'Estado de integraciones no disponible',
    settingsIntegrationInventoryErrorSubtitle: 'Es posible que el último estado conocido esté desactualizado. Comprueba de nuevo antes de hacer cambios.',
    settingsIntegrationTitle: 'Supervisión de sesiones externas',
    settingsIntegrationNeedsAttentionTitle: 'Necesita atención',
    settingsIntegrationDiagnosticMessageUnavailable: 'Esta instalación necesita atención antes de continuar la supervisión.',
    settingsIntegrationRemediationRetry: 'Comprueba de nuevo después de resolver el problema.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Revisa el ajuste en ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Selecciona una cuenta para ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Instala la dependencia necesaria: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Consulta las indicaciones en ${url}.`,
    settingsIntegrationActionReviewInstall: 'Revisar e instalar',
    settingsIntegrationActionDisable: 'Desactivar',
    settingsIntegrationActionEnable: 'Activar',
    settingsIntegrationActionUninstall: 'Desinstalar',
    settingsIntegrationActionCheckAgain: 'Comprobar de nuevo',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Revisar la integración de ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier solo gestionará estas entradas: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Revisa los cambios gestionados por el Agent antes de instalar.',
    settingsIntegrationPreviewNoMatcher: 'Todas las sesiones coincidentes',
    settingsIntegrationActionInstall: 'Instalar',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `¿Desinstalar la integración de ${agent}?`,
    settingsIntegrationUninstallBody: 'Esto solo elimina las entradas gestionadas por Happier. El resto de la configuración del Agent no cambia.',
    settingsIntegrationActionFailed: 'Happier no pudo actualizar esta integración. Comprueba la máquina e inténtalo de nuevo.',
    settingsAutoLinkUpdateFailed: 'Happier no pudo actualizar la vinculación automática. Inténtalo de nuevo.',
    settingsRestoreUpdateFailed: 'Happier no pudo actualizar la preferencia de sincronización después de reiniciar. Inténtalo de nuevo.',
    settingsIntegrationsGroupTitle: 'Supervisión de sesiones externas',
    settingsIntegrationsFooter: 'Happier solo cambia la configuración del Agent después de una acción explícita. Abrir esta página es de solo lectura.',
    settingsIntegrationsUnavailableTitle: 'No hay integraciones disponibles',
    settingsIntegrationsUnavailableSubtitle: 'Conecta una integración de Agent compatible para revisar su estado y las acciones disponibles.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Añadir automáticamente nuevas sesiones de ${agent}`,
    settingsAutoLinkTitle: 'Añadir automáticamente nuevas sesiones externas',
    browseAutoLinkTitle: 'Añadir automáticamente nuevas sesiones',
    settingsAutoLinkGroupTitle: 'Vinculación automática',
    settingsAutoLinkGroupFooter: 'La vinculación automática está desactivada de forma predeterminada y es independiente de la configuración de la integración del Agent y de la sincronización en segundo plano.',
    settingsAutoLinkUnavailableTitle: 'No hay orígenes de vinculación automática disponibles',
    settingsAutoLinkUnavailableSubtitle: 'No hay ámbitos de origen compatibles disponibles en esta máquina.',
    settingsAutoLinkSubtitle: 'Al activarla, Happier vincula las nuevas sesiones compatibles de este origen sin abrir ni reanudar el Agent.',
    settingsAutoLinkHint: 'Activa o desactiva la vinculación automática para este origen.',
    settingsPrivacyGroupTitle: 'Privacidad',
    settingsPrivacyTitle: 'Observaciones limitadas y sin contenido',
    settingsPrivacySubtitle: 'Las integraciones de Agent de confianza pueden inspeccionar datos nativos limitados de hooks en esta máquina. Happier solo admite y sincroniza observaciones sin contenido; el host nunca guarda, sincroniza ni registra cargas útiles, rutas, credenciales, instrucciones, texto de transcripciones ni argumentos de herramientas.',
    settingsAgentActionsGroupTitle: 'Sesiones externas',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Explorar sesiones externas de ${agent}`,
    settingsManageAllTitle: 'Gestionar todos los ajustes de Sesiones externas',
    settingsManageAllSubtitle: 'Revisa las integraciones y la sincronización en segundo plano de las máquinas conectadas.',
    settingsMachineOnline: 'En línea',
    settingsMachineOffline: 'Sin conexión',
    settingsMachineTitle: 'Máquina',
    settingsMachineUnavailable: 'No hay ninguna máquina conectada',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Se muestran las primeras ${count} — afina la búsqueda`,
    browseAnnotationsIncomplete: 'No se pudieron confirmar algunos estados. Abrir una sesión lo comprueba.',
    browseRouteUnavailableTitle: 'Las sesiones externas no están disponibles aquí',
    browseRouteUnavailableSubtitle: 'Este servidor no ofrece la exploración de sesiones externas. Vuelve atrás y elige otro servidor, o inténtalo más tarde.',
    browseRouteAvailabilityUnknownTitle: 'No se pudo confirmar la compatibilidad con sesiones externas',
    browseRouteAvailabilityUnknownSubtitle: 'Happier no pudo comprobar si este servidor ofrece la exploración de sesiones externas. Vuelve atrás e inténtalo en un momento.',
    browseHeaderTitle: 'Sesiones externas',
    browseSettingsLink: 'Ajustes de sesiones externas',
    browseChooseMachineTitle: 'Elige una máquina',
    browseChooseMachineBody: 'Las sesiones externas viven en la máquina que las ejecutó. Elige una para ver sus sesiones.',
    browseMachineGoneBody: 'Se eliminó o se reemplazó. Elige otra máquina para ver sus sesiones.',
    browseHomeUnreachableBody: 'Sus máquinas y sesiones aparecerán cuando se pueda conectar. Mientras tanto, elige otra máquina.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} está sin conexión`,
    browseThisMachineOfflineTitle: 'Esta máquina está sin conexión',
    browseMachineOfflineBody: 'Sus sesiones aparecerán cuando vuelva a conectarse.',
    browseChooseAnotherMachine: 'Elegir otra máquina',
    browseCantReachTitle: ({ machine }: { machine: string }) => `No se puede contactar con Happier en ${machine}`,
    browseCantReachBody: 'La máquina está en línea, pero su servicio de Happier no responde. Puede que aún se esté iniciando.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Nada que explorar en ${machine}`,
    browseNothingToBrowseBody: 'Ninguno de los agentes de esta máquina puede compartir sus sesiones todavía.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `No hay sesiones de ${agent} en ${machine}`,
    browseEmptyBody: 'Las sesiones que inicies en esta máquina aparecen aquí, listas para abrirse en Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Probar ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Ninguna sesión coincide con «${query}»`,
    browseErrorTitle: 'No se pudieron cargar las sesiones',
    browseThisMachine: 'esta máquina',
    browseIndexingStop: 'Detener',
    browseThreadsFilter: 'Hilos de subagentes',
    browseThreadsHidden: 'Solo sesiones principales',
    browseThreadsShown: 'Con hilos de subagentes',
    browseThreadReviewer: 'Revisor',
    browseThreadSubagent: 'Subagente',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Revisor de ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Subagente de ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { es: {
        changedOnly: 'Solo con cambios',
        showAllFiles: 'Mostrar todos los archivos',
        viewOptions: 'Opciones de vista',
        sizeAndDate: 'Tamaño y fecha',
        newMenu: 'Archivo nuevo, carpeta nueva o subir',
        newFile: 'Archivo nuevo',
        newFolder: 'Carpeta nueva',
        noChangedFilesTitle: 'No ha cambiado nada',
        noChangedFilesReason: 'La copia de trabajo coincide con el último commit.',
        rootErrorTitle: ({ machine }) => `No se pudieron listar los archivos en ${machine}`,
        rootErrorTitleUnnamed: 'No se pudieron listar los archivos',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "es">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const es: FindTranslations = {
    open: 'Buscar…',
    openedForMatch: 'Abierto por una coincidencia', foldAgain: 'Volver a plegar', showHiddenLines: ({ count }) => `Mostrar ${count} líneas ocultas`,
    surface: {
        chat: 'Buscar en el chat',
        changes: 'Buscar en los cambios',
        file: 'Buscar en el archivo',
        terminal: ({ name }) => `Buscar en ${name}`,
    },
    previous: 'Coincidencia anterior',
    next: 'Coincidencia siguiente',
    matchCase: 'Distinguir mayúsculas',
    regex: 'Usar expresión regular',
    regexShort: 'Expresión regular',
    options: 'Opciones de búsqueda',
    close: 'Cerrar búsqueda',
    done: 'Listo',
    stop: 'Detener',
    noMatches: 'Sin coincidencias',
    noneFound: 'Nada encontrado',
    invalidPattern: 'Patrón no válido',
    offline: 'Sin conexión',
    unsupported: 'Aquí no se puede buscar',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'coincidencia' : 'coincidencias'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'archivo' : 'archivos'}`,
    soFar: 'por ahora',
    loaded: 'cargadas',
    note: {
        searchingOlder: 'Revisando mensajes anteriores, descifrados en este dispositivo',
        offlineOlder: 'Podrás buscar en los mensajes anteriores cuando vuelvas a estar en línea.',
        terminalKept: ({ lines }) => `Se buscó en las últimas ${lines} líneas que conserva este terminal.`,
    },
};

const findTranslations = { es };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const es: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Añadir carpeta',
        noFolder: 'Sin carpeta',
        noFolderDescription: 'Happier guarda una carpeta privada para este chat',
        removeFolder: 'Quitar carpeta',
        a11y: {
            folder: ({ path }) => `Carpeta: ${path}. Abre las opciones de carpeta.`,
            none: 'Sin carpeta. Happier guarda una carpeta privada para este chat. Añadir carpeta.',
            loading: 'Cargando carpeta',
            noFolderRow: 'Sin carpeta, carpeta privada para este chat',
            removed: 'Carpeta quitada',
            set: ({ path }) => `Carpeta establecida en ${path}`,
        },
    },
    display: {
        chats: 'Chats',
        untitledChat: 'Nuevo chat',
        folder: 'Carpeta',
        privateToSession: 'Solo de esta sesión',
        sessionFiles: 'Archivos de la sesión',
        privateFolderOn: ({ machine }) => `Carpeta privada en ${machine}`,
    },
};

const folderlessSessionTranslations = { es: es };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "es": {
        "effectiveBrowserSolid": "Menús y controles flotantes opacos. Un navegador no puede mostrar tu escritorio.",
        "effectiveFloatingSolid": "Controles flotantes opacos en este dispositivo.",
        "effectiveSolid": "Superficies opacas en este dispositivo.",
        "effectiveBrowser": "Cristal en menús y controles flotantes. Un navegador no puede mostrar tu escritorio.",
        "effectiveBrowserCustom": "Tu material en menús y controles flotantes. Un navegador no puede mostrar tu escritorio.",
        "effectivePhone": "Cristal en controles flotantes y hojas.",
        "effectiveLayered": "Cristal por capas en toda esta ventana.",
        "effectiveUniform": "Cristal uniforme en toda esta ventana.",
        "effectiveCustom": "Cristal en esta ventana según tus ajustes.",
        "effectiveUnavailable": "El cristal de ventana no está disponible. Los controles flotantes usan el material elegido.",
        "effectiveInactive": "Opaco mientras esta ventana está inactiva.",
        "effectiveTint": "Controles flotantes tintados; el desenfoque de fondo no está disponible.",
        "description": "Deja ver el escritorio a través de la ventana y la página bajo los controles flotantes.",
        "descriptionBrowser": "Deja ver la página bajo los menús y controles flotantes.",
        "descriptionPhone": "Deja ver la página bajo los controles flotantes y hojas.",
        "chromeDescription": "Barra de título, navegación y fondo de ventana",
        "sidebarDescription": "Tu columna de sesiones",
        "contentDescription": "Conversación, compositor y paneles de trabajo",
        "floatingDescription": "Menús, ventanas emergentes, hojas y controles flotantes",
        "clear": "Transparente",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-clic · ${modifier}⇧L cambia entre claro y oscuro`
    } } as const;

const glassAppearanceTranslations = { es: { iosReduceTransparencyPath: "Ajustes › Accesibilidad › Pantalla y tamaño del texto › Reducir transparencia", title: 'Cristal', material: 'Material', solid: 'Sólido', auto: 'Automático', everywhere: 'En todas partes', custom: 'Personalizado', blur: 'Desenfoque', off: 'Desactivado', opacity: 'Opacidad', customize: 'Personalizar', chrome: 'Marco de ventana', sidebar: 'Barra lateral', content: 'Contenido', floating: 'Superficies flotantes', appearance: 'Apariencia', moreSettings: 'Más ajustes de apariencia…', customizeLink: 'Personalizar…', toolbarTitle: 'Botón de apariencia', toolbarDescription: 'Muestra Apariencia en la barra. Un clic con modificador cambia entre claro y oscuro.', reduceTransparency: 'Sólido porque Reducir transparencia está activado', osSettings: 'Abrir ajustes de accesibilidad', themeCommand: 'Cambiar entre claro y oscuro', autoDescription: "Se adapta al dispositivo: cristal por capas en ventanas compatibles y en superficies flotantes del teléfono.", osSettingsUnavailable: "No se pudieron abrir los ajustes de accesibilidad. Ábrelos en los ajustes del dispositivo.", ...effectiveTranslations["es"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "es">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const es: typeof en = {
    row: {
        notSet: 'Sin definir',
    },
    keepGoing: {
        title: 'Seguir hasta terminar',
        nativeDescription: ({ agent }) => `${agent} sigue trabajando hacia el objetivo por su cuenta.`,
        description: ({ rounds }) => `Después de cada uno de tus turnos, un agente revisa el objetivo y continúa hasta que se cumple, se agota el presupuesto o deja de avanzar, como máximo ${rounds} ${rounds === 1 ? 'ronda' : 'rondas'}.`,
        roundsPrefix: 'Parar tras',
        roundsSuffix: 'rondas',
        roundsLabel: 'Rondas antes de parar',
        strikesPrefix: 'Parar tras',
        strikesSuffix: 'revisiones sin avance',
        strikesLabel: 'Revisiones sin avance antes de parar',
        secondOpinionTitle: 'Pedir una segunda opinión antes de terminar',
        secondOpinionDescription: 'Antes de marcar el objetivo como hecho, un segundo agente lo revisa. Si no está de acuerdo, recibes una notificación y el objetivo sigue abierto.',
        budgetUnreported: ({ agent }) => `${agent} no informa del uso de tokens, así que solo se aplican las rondas y las revisiones de avance.`,
    },
};

const goalControlTranslations = { es };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { es: {
        addressIsSignInService: 'Esta dirección corresponde a un servicio de inicio de sesión. Inicia sesión allí para encontrar tus Homes.',
        mixedContent: 'Este navegador no puede conectarse a un Home HTTP desde una página HTTPS. Abre Happier mediante HTTP o utiliza una dirección HTTPS para el Home.',
        connectedToHome: ({ home }) => `${home} está conectado a este dispositivo.`,
        openHome: ({ home }) => `Abrir ${home}`,
        showAllHomes: 'Mostrar todos los Homes',
        otherSignInService: 'Otro servicio de inicio de sesión',
        otherSignInServiceSubtitle: 'Un servicio autoalojado o de empresa',
        signInServiceAddress: 'Dirección del servicio',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "es">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { es: {
        ...starterPrompts,
        suggestionsLabel: 'Sugerencias',
        summarizeProjectSince: ({ project, day }) => `Resume qué cambió en ${project} desde ${day}`,
        summarizeProjectToday: ({ project }) => `Resume qué cambió hoy en ${project}`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 sesión desde ${day}` : `${count} sesiones desde ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 sesión hoy' : `${count} sesiones hoy`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "es">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { es: {
        title: 'Aprobaciones de dispositivos', deviceFallback: 'Dispositivo nuevo',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Caduca: ${expiry}`,
        requestDetails: 'Detalles de la solicitud', requestDetailsHint: 'Mostrar el identificador de la clave de solicitud',
        fingerprintLabel: 'Huella de la clave de solicitud', requestDetailsHelp: 'Esto identifica la clave de solicitud. No es un código que tengas que comparar.',
        approve: 'Aprobar', reject: 'Rechazar', loadError: 'No se han podido cargar las aprobaciones de dispositivos.',
        loadErrorUnreachable: ({ homes }) => `${homes} no ha respondido.`, loadErrorFailed: ({ homes }) => `${homes} ha respondido con un error.`,
        decisionError: 'No se ha podido actualizar esta solicitud.', decisionRecovery: 'Elige Aprobar o Rechazar para volver a intentarlo.',
        approved: 'Dispositivo aprobado', rejected: 'Dispositivo rechazado', expired: 'Caducada', stopWaiting: 'Dejar de esperar',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "es">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const es: typeof en = {
    teams: {
        title: 'Equipos',
        description: 'Grupos con sesiones, máquinas y acceso compartidos.',
        credentialResources: {
            title: 'Credenciales de equipo',
            description: 'Credenciales que un equipo comparte con sus sesiones.',
            externalApi: {
                title: 'API de credenciales de equipo',
                description: 'Herramientas externas usan las credenciales de un equipo a través de la API.',
            },
        },
    },
    automations: {
        title: 'Automatizaciones',
        description: 'Trabajo de agentes programado y activado por eventos.',
    },
    workflows: {
        title: 'Flujos de trabajo',
        description: 'Pipelines de agentes de varios pasos.',
    },
    pets: {
        sync: {
            title: 'Sincronización de mascotas',
            description: 'Mantiene las mascotas de cada persona en todos sus dispositivos.',
        },
    },
    voice: {
        title: 'Voz',
        description: 'Habla con tus agentes.',
        happierVoice: {
            title: 'Voz de Happier',
            description: 'Voz a través del servicio de voz que ofrece este Home.',
        },
    },
    connectedServices: {
        group: 'Servicios conectados',
        quotas: {
            title: 'Medidores de cuota',
            description: 'Muestra cuánta cuota le queda a cada cuenta conectada.',
        },
        subscription: {
            title: 'Estado de la suscripción',
            description: 'Muestra el plan y el estado de cada cuenta conectada.',
        },
        accountGroups: {
            title: 'Grupos de cuentas',
            description: 'Agrupa cuentas conectadas en pools.',
        },
        accountFallback: {
            title: 'Cuenta de respaldo',
            description: 'Cambia a la siguiente cuenta del pool cuando una se agota.',
        },
        autoQuotaReset: {
            title: 'Restablecimiento automático de cuota',
            description: 'Usa los restablecimientos de cuota acumulados cuando todas las cuentas de un pool se agotan.',
        },
        autoDisablePlanInvalid: {
            title: 'Omitir cuentas inservibles',
            description: 'Desactiva las cuentas del pool que no pueden usar el modelo elegido.',
        },
        poolQuotaLimitSelection: {
            title: 'Límites de cuota del pool',
            description: 'Elige qué cuota del proveedor sigue cada pool.',
        },
    },
    updates: {
        ota: {
            title: 'Actualizaciones remotas',
            description: 'Las apps instalan actualizaciones sin pasar por la tienda.',
        },
    },
    attachments: {
        uploads: {
            title: 'Adjuntos',
            description: 'Envía archivos e imágenes a los agentes de una sesión.',
        },
    },
    sharing: {
        group: 'Compartir',
        session: {
            title: 'Compartir sesiones',
            description: 'Comparte una sesión con alguien de este Home.',
        },
        public: {
            title: 'Enlaces públicos',
            description: 'Comparte el contenido de una sesión con un enlace público.',
        },
        contentKeys: {
            title: 'Compartición cifrada',
            description: 'Intercambia claves para que las sesiones compartidas sigan cifradas de extremo a extremo.',
        },
        pendingQueueV2: {
            title: 'Cola de mensajes compartida',
            description: 'Pone en cola los mensajes de una sesión compartida mientras su agente está ocupado.',
        },
        pendingDeliveryState: {
            title: 'Seguimiento de entrega de la cola',
            description: 'Recuerda qué mensajes en cola llegaron al agente.',
        },
    },
    sessions: {
        title: 'Sesiones',
        description: 'Las sesiones y sus controles.',
        group: 'Sesiones',
        handoff: {
            title: 'Traspaso de sesión',
            description: 'Mueve una sesión en curso a otra máquina.',
        },
        ephemeralRunner: {
            title: 'Runners efímeros',
            description: 'Inicia una sesión en una máquina desechable.',
        },
        agentSwitching: {
            title: 'Cambio de agente',
            description: 'Continúa una sesión con otro agente de código.',
        },
        folders: {
            title: 'Carpetas de sesiones',
            description: 'Organiza las sesiones en carpetas.',
        },
        drafts: {
            title: 'Borradores sincronizados',
            description: 'Conserva los mensajes sin enviar y los borradores de sesión en cada dispositivo.',
        },
        following: {
            title: 'Seguimiento',
            description: 'Sigue una sesión para recibir sus novedades y notificaciones.',
        },
        conversations: {
            title: 'Conversaciones',
            description: 'Las personas conversan y se mencionan dentro de una sesión compartida.',
        },
        board: {
            title: 'Tablero de sesiones',
            description: 'Organiza las sesiones y sus elementos en tableros compartidos.',
        },
        filteredListing: {
            title: 'Lista filtrada',
            description: 'Filtra la lista de sesiones en este Home antes de paginarla.',
        },
        usageLimitRecovery: {
            title: 'Recuperación tras límite de uso',
            description: 'Esperar y reanudar, o reintentar, cuando un agente alcanza un límite de uso.',
        },
    },
    machines: {
        title: 'Máquinas',
        description: 'La conexión con tus máquinas.',
        group: 'Máquinas',
        pools: {
            title: 'Pools de máquinas',
            description: 'Pasa a la siguiente máquina cuando una está desconectada.',
        },
        transfer: {
            title: 'Transferencias entre máquinas',
            description: 'Transferir datos entre máquinas.',
            directPeer: {
                title: 'Transferencias directas',
                description: 'Transfiere datos directamente entre máquinas.',
            },
            serverRouted: {
                title: 'Transferencias a través de este Home',
                description: 'Transfiere datos a través de este Home cuando las máquinas no pueden conectarse directamente.',
            },
        },
        peerMediation: {
            title: 'Conexiones entre máquinas',
            description: 'Túneles, transmisiones y acceso entre máquinas.',
            observability: {
                title: 'Diagnóstico de conexiones',
                description: 'Muestra cómo se conectan los túneles, las transmisiones y las vistas previas entre máquinas.',
            },
        },
        tunnel: {
            title: 'Túneles entre máquinas',
            description: 'Abrir puertos entre máquinas.',
            directPeer: {
                title: 'Túneles directos',
                description: 'Abre puertos directamente entre máquinas.',
            },
            serverRouted: {
                title: 'Túneles a través de este Home',
                description: 'Abre puertos a través de este Home cuando las máquinas no pueden conectarse directamente.',
            },
        },
        liveStream: {
            title: 'Transmisiones en directo',
            description: 'Transmitir la pantalla de una máquina.',
            directPeer: {
                title: 'Transmisiones directas',
                description: 'Transmite la pantalla de una máquina directamente a tu dispositivo.',
            },
            serverRouted: {
                title: 'Transmisiones a través de este Home',
                description: 'Transmite la pantalla de una máquina a través de este Home cuando falla la transmisión directa.',
            },
        },
        rpc: {
            title: 'Llamadas a máquinas',
            description: 'Llegar a las máquinas directamente.',
            directPeer: {
                title: 'Llamadas directas a máquinas',
                description: 'Llega a una máquina directamente en lugar de a través de este Home.',
            },
        },
    },
    localServices: {
        title: 'Servicios locales',
        description: 'Ve y abre los servicios que se ejecutan en tus máquinas.',
        group: 'Servicios locales',
        inventory: {
            title: 'Inventario de servicios',
            description: 'Lista los puertos y servicios activos en cada máquina.',
        },
        managed: {
            title: 'Servicios gestionados',
            description: 'Inicia, nombra y vigila servicios desde Happier.',
        },
        launcher: {
            title: 'Lanzador de servicios',
            description: 'Sugiere servicios para abrir y previsualizar.',
        },
        actions: {
            title: 'Acciones de servicios',
            description: 'Copiar, previsualizar y olvidar servicios.',
            terminate: {
                title: 'Detener servicios',
                description: 'Detiene el proceso de un servicio detectado.',
            },
        },
        preview: {
            title: 'Vistas previas de servicios',
            description: 'Previsualiza un servicio local en privado dentro de una sesión.',
        },
        publicPreview: {
            title: 'Vistas previas públicas',
            description: 'Comparte la vista previa de un servicio en una dirección pública.',
        },
    },
    browser: {
        title: 'Navegador',
        description: 'Abre páginas, vistas previas y vistas alojadas dentro de Happier.',
        group: 'Navegador',
        viewTargets: {
            title: 'Vistas del navegador',
            description: 'Abre vistas previas, páginas de plugins y enlaces en la vista adecuada.',
        },
        internal: {
            title: 'Navegador integrado',
            description: 'Navega dentro de Happier con sus propias sesiones y perfiles.',
        },
        sidecar: {
            title: 'Navegador auxiliar',
            description: 'Un navegador gestionado aparte para automatización intensiva.',
        },
        diagnostics: {
            title: 'Herramientas de desarrollo',
            description: 'Consola, red y eventos de devtools del navegador integrado.',
        },
        context: {
            title: 'Contexto del navegador',
            description: 'Adjunta el contenido de una página a un mensaje o a un agente.',
        },
        automation: {
            title: 'Automatización del navegador',
            description: 'Los agentes hacen clic, escriben y navegan en el navegador integrado.',
        },
        recording: {
            title: 'Grabaciones del navegador',
            description: 'Graba las sesiones del navegador como evidencia.',
        },
    },
    plugins: {
        title: 'Plugins de fuera de Happier',
        description: 'Instala plugins desde npm y tus propias fuentes.',
        group: 'Plugins',
        webhooks: {
            title: 'Webhooks de plugins',
            description: 'Los plugins reciben webhooks de servicios externos.',
        },
        ui: {
            title: 'Pantallas de plugins',
            description: 'Muestra las pantallas y paneles que ofrecen los plugins.',
            hostedWeb: {
                title: 'Pantallas web de plugins',
                description: 'Muestra pantallas de plugins creadas para la web.',
            },
            reactNativeBundles: {
                title: 'Pantallas nativas de plugins',
                description: 'Ejecuta pantallas de plugins de confianza creadas con React Native.',
            },
        },
    },
    devices: {
        title: 'Dispositivos',
        description: 'Simuladores y dispositivos conectados.',
        simulatorPreview: {
            title: 'Vistas previas de simuladores',
            description: 'Muestra simuladores y emuladores de tus máquinas.',
        },
    },
    social: {
        friends: {
            title: 'Amigos',
            description: 'Añade amigos y ve lo que comparten.',
        },
    },
    auth: {
        group: 'Inicio de sesión',
        recovery: {
            providerReset: {
                title: 'Restablecer con un proveedor',
                description: 'Recupera una cuenta iniciando sesión con su proveedor de identidad.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Inicio de sesión con clave',
                description: 'Inicia sesión demostrando la clave de un dispositivo.',
            },
        },
        mtls: {
            title: 'Certificados de cliente',
            description: 'Inicia sesión con un certificado de cliente (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Recordatorio de clave de recuperación',
                description: 'Recuerda a las personas que guarden su clave de recuperación.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Iniciar sesión escaneando',
                description: 'Inicia sesión en un teléfono escaneando un código en un ordenador.',
            },
            boundQrV2: {
                title: 'Códigos de vinculación más seguros',
                description: 'Códigos de vinculación que solo sirven para este Home y esta dirección.',
            },
        },
    },
    encryption: {
        group: 'Cifrado',
        plaintextStorage: {
            title: 'Almacenamiento sin cifrar',
            description: 'Guarda las sesiones sin cifrado de extremo a extremo.',
        },
        accountOptOut: {
            title: 'Desactivar el cifrado',
            description: 'Cada persona puede desactivar el cifrado de extremo a extremo.',
        },
    },
    remoteHosts: {
        group: 'Hosts remotos',
        management: {
            title: 'Hosts remotos',
            description: 'Guarda hosts SSH donde ejecutar sesiones.',
        },
        secretMaterial: {
            title: 'Secretos de hosts guardados',
            description: 'Guarda contraseñas y claves de hosts SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Cuentas sin claves',
            description: 'Cuentas sin claves de cifrado de extremo a extremo.',
        },
    },
    bugReports: {
        title: 'Informes de errores',
        description: 'Envía informes de errores con diagnósticos.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Abre un terminal en una máquina dentro de Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminal por flujo',
                description: 'Una conexión más rápida para el terminal integrado.',
            },
        },
    },
    search: {
        title: 'Búsqueda',
        description: 'Busca en sesiones y transcripciones.',
    },
    providers: {
        title: 'Proveedores de modelos',
        description: 'Conecta proveedores de modelos y elige modelos para los agentes.',
        group: 'Proveedores de modelos',
        localDiscovery: {
            title: 'Buscar proveedores locales',
            description: 'Encuentra servidores de modelos que se ejecutan en tus máquinas.',
        },
        localModelManagement: {
            title: 'Gestión de modelos locales',
            description: 'Descarga y gestiona modelos locales.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Dirección del servicio de informes',
            description: 'Adónde se envían los informes de errores. Si se deja vacío, no se ofrece ningún servicio de informes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Incluir diagnósticos por defecto',
            description: 'El formulario de informe incluye diagnósticos salvo que quien informa los desactive.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Adjunto más grande',
            description: 'Archivo más grande que puede adjuntar un informe de errores, en bytes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Tiempo límite de subida',
            description: 'Cuánto puede tardar la subida de un informe de errores, en milisegundos.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Tipos de adjunto aceptados',
            description: 'Tipos de adjunto que aceptan los informes de errores. Vacío acepta los tipos habituales.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Ventana de contexto',
            description: 'Cuánto tiempo atrás recopila contexto un informe de errores, en milisegundos.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'La voz requiere suscripción',
            description: 'Solo los suscriptores pueden usar la voz. Si no se define, producción lo exige y las demás configuraciones no.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Manifiesto de mascota más grande',
            description: 'Manifiesto de mascota más grande que se acepta, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Hoja de sprites de mascota más grande',
            description: 'Hoja de sprites de mascota más grande que se acepta, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Paquete de mascota más grande',
            description: 'Paquete de mascota más grande que se acepta, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Mascotas importadas por persona',
            description: 'Máximo de mascotas importadas que puede conservar una persona.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Almacenamiento de mascotas importadas por persona',
            description: 'Máximo de bytes de mascotas importadas que puede conservar una persona.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Mascotas personalizadas cifradas',
            description: 'Reservado para más adelante. Las mascotas personalizadas cifradas aún no se sincronizan, así que esto sigue desactivado.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Transferencia más grande a través de este Home',
            description: 'Archivo más grande que lleva una transferencia a través de este Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Transferencias simultáneas por conexión',
            description: 'Máximo de transferencias a través de este Home que ejecuta una conexión a la vez.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Datos por túnel',
            description: 'Máximo de bytes que lleva un túnel a través de este Home.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Túneles por conexión',
            description: 'Máximo de túneles a través de este Home que mantiene abiertos una conexión.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Trama de túnel más grande',
            description: 'Trama más grande que lleva un túnel a través de este Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Codificaciones de túnel',
            description: 'Codificaciones de trama que aceptan los túneles a través de este Home. Vacío usa las estándar.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Codificación de túnel preferida',
            description: 'La codificación de trama que se usa primero. Debe ser una de las codificaciones aceptadas.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Cabecera de trama más grande',
            description: 'Cabecera binaria de trama más grande, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Carga útil de trama más grande',
            description: 'Carga útil sin procesar más grande en una trama, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Mensaje entramado más grande',
            description: 'Mensaje entramado más grande, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Flujos simultáneos por túnel',
            description: 'Máximo de flujos que ejecuta un túnel a la vez.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Flujos por túnel',
            description: 'Máximo de flujos que abre un túnel durante su vida útil.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Datos por flujo',
            description: 'Máximo de bytes que lleva un flujo.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Datos por túnel, todos los flujos',
            description: 'Máximo de bytes que llevan juntos todos los flujos de un túnel.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Tiempo límite de flujo inactivo',
            description: 'Cuánto puede estar inactivo un flujo antes de cerrarse, en milisegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Tiempo límite de túnel inactivo',
            description: 'Cuánto puede estar inactivo un túnel a través de este Home antes de cerrarse, en milisegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Límite de inactividad del túnel',
            description: 'Cuánto puede estar inactivo un túnel antes de cerrarse, en milisegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Túnel más largo',
            description: 'Tiempo máximo que un túnel permanece abierto, en milisegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Puertos accesibles para túneles',
            description: 'Puertos que pueden abrir los túneles. Vacío permite solo los predeterminados.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Duración del enlace de vista previa',
            description: 'Cuánto tiempo funciona un enlace de vista previa privada, en milisegundos.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Dominio de vistas previas',
            description: 'Dominio que sirve cada vista previa en su propia dirección. Vacío sirve las vistas previas bajo la dirección de este Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modos de vista previa pública',
            description: 'Formas en que una vista previa puede hacerse pública.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Vista previa pública más larga',
            description: 'Tiempo máximo que una vista previa permanece pública, en milisegundos. Vacío mantiene el límite estándar.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Vistas previas públicas simultáneas',
            description: 'Máximo de vistas previas públicas al mismo tiempo. Vacío mantiene el límite estándar.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Exigir DNS y TLS',
            description: 'Las vistas previas públicas necesitan DNS y TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Registro de auditoría de vistas previas públicas',
            description: 'Dónde se registran las vistas previas públicas. Las vistas previas públicas necesitan uno.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Archivo del registro de auditoría',
            description: 'Archivo en el que se escribe el registro de auditoría de vistas previas públicas.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Permitir el registro de auditoría de prueba',
            description: 'Solo para desarrollo: acepta el registro de auditoría de prueba en memoria. Se ignora en producción.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Límites de frecuencia de vistas previas públicas',
            description: 'Perfiles de límite de frecuencia que pueden usar las vistas previas públicas.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Comprobador de límite de frecuencia',
            description: 'Cómo se limita la frecuencia de las solicitudes a vistas previas públicas. Las vistas previas públicas necesitan uno.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Solicitudes por ventana',
            description: 'Solicitudes que permite una vista previa pública en cada ventana.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Ventana de límite de frecuencia',
            description: 'Duración de cada ventana de límite de frecuencia, en milisegundos.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Permitir el limitador de prueba',
            description: 'Solo para desarrollo: acepta el limitador de frecuencia de prueba en memoria. Se ignora en producción.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooks en curso',
            description: 'Máximo de solicitudes webhook que este servidor atiende a la vez.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Memoria de webhooks',
            description: 'Memoria máxima que pueden usar las solicitudes webhook en curso, en bytes. Vacío permite lo que ya admite el límite de solicitudes.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por ruta',
            description: 'Solicitudes webhook por minuto en una ruta.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhooks simultáneos por ruta',
            description: 'Solicitudes webhook en curso en una ruta.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por endpoint',
            description: 'Solicitudes webhook por minuto en un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhooks simultáneos por endpoint',
            description: 'Solicitudes webhook en curso en un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por persona',
            description: 'Solicitudes webhook por minuto de una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhooks simultáneos por persona',
            description: 'Solicitudes webhook en curso de una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Paquete de pantalla de plugin más grande',
            description: 'Paquete de pantalla de plugin más grande que aloja este Home, en bytes.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Almacenamiento de pantallas de plugins por persona',
            description: 'Máximo de bytes de paquetes de pantallas de plugins que puede almacenar una persona.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Fila de datos de plugin más grande',
            description: 'Fila más grande que almacena un plugin, en bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Lote de datos de plugin más grande',
            description: 'Lote más grande de cambios de datos de plugin, en bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Filas por lote de datos de plugin',
            description: 'Máximo de filas en un lote de cambios de datos de plugin.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Filas de datos de plugin por persona',
            description: 'Máximo de filas de datos de plugin que puede almacenar una persona.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Almacenamiento de datos de plugin por persona',
            description: 'Máximo de bytes de datos de plugin que puede almacenar una persona.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Tasa de bits máxima de transmisión',
            description: 'Tasa de bits máxima de una transmisión en directo a través de este Home, en bits por segundo.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Frecuencia de fotogramas máxima',
            description: 'Frecuencia de fotogramas máxima de una transmisión en directo a través de este Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Fotograma de transmisión más grande',
            description: 'Fotograma más grande de una transmisión en directo a través de este Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Transmisión en directo más larga',
            description: 'Tiempo máximo que dura una transmisión en directo a través de este Home, en milisegundos.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Datos por transmisión en directo',
            description: 'Máximo de bytes que lleva una transmisión en directo a través de este Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Transmisiones simultáneas por persona',
            description: 'Máximo de transmisiones en directo a través de este Home que ejecuta una persona a la vez.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Transmisiones simultáneas por conexión',
            description: 'Máximo de transmisiones en directo a través de este Home que ejecuta una conexión a la vez.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Transmisiones simultáneas por máquina',
            description: 'Máximo de transmisiones en directo a través de este Home que ejecuta una máquina a la vez.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID de la clave de firma de conexiones',
            description: 'Identifica la clave que firma las conexiones entre máquinas. Sin clave de firma, estas conexiones están desactivadas.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Clave privada de firma de conexiones',
            description: 'Clave privada que firma las conexiones entre máquinas.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Clave pública de firma de conexiones',
            description: 'Clave pública que corresponde a la clave de firma. Si está vacía, se deriva de la clave privada.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Caducidad de la clave de firma',
            description: 'Cuándo caduca la clave de firma, como marca de tiempo en milisegundos.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Buscar amigos por nombre de usuario',
            description: 'Las personas pueden encontrar amigos por nombre de usuario además de por cuenta vinculada.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Proveedor para emparejar amigos',
            description: 'El proveedor de inicio de sesión que se usa para emparejar amigos.',
        },
    },
};

const homeFeatureTranslations = { es } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const es: typeof en = {
    title: 'Administración del Home',
    pages: {
        features: 'Lo que ofrece este Home. Un cambio se aplica en todas partes en la siguiente actualización.',
        data: 'Lo que conserva este Home y durante cuánto tiempo.',
        homes: 'Cuentas, roles, equipos y reglas de inicio de sesión de cada Home que administras.',
        overview: 'Quién administra este Home y qué puedes cambiar aquí.',
        people: 'Las cuentas de este Home, sus roles y si pueden iniciar sesión.',
        policies: 'Quién puede iniciar sesión, quién puede crear cuentas y equipos, y cómo se protegen los datos.',
        teams: 'Todos los equipos de este Home. Administrar un equipo no te da acceso a sus sesiones.',
        identityProvider: 'Un servicio de identidad con el que se puede iniciar sesión en este Home.',
        identityProviderEditor: 'Cómo se conecta este servicio de identidad y a quién admite.',
        githubApp: 'Una GitHub App que este Home usa para acceder a repositorios.',
        githubAppEditor: 'Registra o cambia una GitHub App para este Home.',
        email: 'Cómo envía correo este Home.',
        reach: 'Cómo encuentran este Home los dispositivos, los enlaces de invitación y los correos.',
        runtime: 'El servidor que ejecuta este Home.',
        activity: 'Quién cambió qué en este Home y cuándo.',
    },
    overview: 'Resumen',
    people: 'Personas',
    teams: 'Equipos',
    policies: 'Políticas',
    console: {
        serverSettings: 'Ajustes del servidor',
        serverSettingsDescription: 'Cada ajuste que lee el servidor y cuándo se aplica un cambio.',
        allHomes: 'Todos los Homes',
        backToHomes: 'Volver a los Homes',
        viewerOwner: 'Eres el propietario',
        viewerAdmin: 'Eres administrador',
        noOwnerYet: 'Aún sin propietario',
        administer: 'Administrar',
        navigation: 'Páginas de administración del Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Quién gestiona este Home y qué necesita de ti.',
        attention: 'Requiere tu atención',
        emailNotSetUpTitle: 'El correo no está configurado',
        emailNotSetUpBody: 'Nadie puede verificar su dirección, restablecer una contraseña ni recibir invitaciones por correo.',
        emailNoLinkTitle: 'Los correos aún no pueden incluir enlaces',
        emailNoLinkBody: 'El envío está configurado, pero este Home no tiene una dirección de la app web para los enlaces.',
        emailPasswordTitle: 'No se puede leer la contraseña del correo',
        emailPasswordBody: 'Vuelve a introducir la contraseña SMTP para que este Home pueda enviar correos.',
        setUpEmail: 'Configurar correo',
        openEmail: 'Abrir Correo',
        noAddressTitle: 'Sin dirección pública',
        noAddressBody: 'Los dispositivos de otras redes y los enlaces de invitación no pueden llegar a este Home.',
        setUpReach: 'Configurar',
        pendingBody: 'Guardado, a la espera de que el servidor se reinicie.',
        fixedBody: 'Definidos en el entorno del servidor; cámbialos allí.',
        review: 'Revisar',
        settingsFailed: 'No se pudieron comprobar los ajustes de este Home',
        emailFailed: 'No se pudo leer el estado del correo de este Home',
        reachFailed: 'No se pudo leer cómo se llega a este Home',
        ownership: 'Propiedad',
        ownerYou: 'Propietario · tú',
        peopleFailed: 'No se pudieron leer las personas de este Home',
        thisHome: 'Este Home',
        version: 'Versión',
        signIn: 'Inicio de sesión',
        signInOpen: 'cualquiera puede crear una cuenta',
        signInInvited: 'solo con invitación',
        signInNone: 'No hay ningún método de inicio de sesión activo',
        fixedTitle: ({ count }: { count: number }) => (count === 1 ? '1 ajuste lo fija tu despliegue' : `${count} ajustes los fija tu despliegue`),
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'persona' : 'personas'}`, `${owners} ${owners === 1 ? 'propietario' : 'propietarios'}`, admins === null ? null : `${admins} ${admins === 1 ? 'admin' : 'admins'}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Invitar personas',
        description: 'Las personas se unen a este Home uniéndose a uno de sus equipos.',
        team: 'Equipo',
        noTeams: 'Aún no hay ningún equipo al que puedas invitar',
        noTeamsBody: 'Las personas se unen a un Home a través de un equipo. Crea uno primero.',
        notAdministered: 'No puedes invitar a los equipos de este Home',
        notAdministeredBody: 'Los propietarios y admins de cada equipo invitan a las personas. Pídeselo a uno de ellos o crea tu propio equipo.',
        createTeam: 'Crear un equipo',
        notAdministeredAskBody: 'Los propietarios y admins de cada equipo invitan a las personas; pídeselo a uno de ellos.',
        joinByTeam: 'Las personas se unen a un Home a través de un equipo.',
        teamsFailed: 'No se pudieron leer los equipos de este Home',
    },

    yourRole: 'Tu rol',
    roleOwner: 'Propietario',
    roleAdmin: 'Administrador',
    roleMember: 'Miembro',
    activeOwners: 'Propietarios activos',
    accountSection: 'Cuenta',
    accountAccessSection: 'Acceso',
    homeAddress: 'Dirección del Home',

    setupRequiredTitle: 'Falta configurar la administración del Home',
    setupRequiredBody: 'Este Home aún no tiene un propietario activo. Alguien con acceso al servidor asigna el primer propietario desde la máquina que lo ejecuta.',

    manageTeams: 'Gestionar equipos',
    manageTeamsSubtitle: 'Administra los equipos de este Home. Esto no te da acceso a sus sesiones.',
    teamsDisabled: 'Los equipos no están habilitados en este Home.',
    teamsEmpty: 'Todavía no hay equipos en este Home.',

    loading: 'Cargando este Home…',
    refreshing: 'Actualizando…',
    updating: 'Actualizando…',
    staleNotice: 'Mostrando el último estado conocido de este Home. No se pueden hacer cambios hasta que vuelva a responder.',
    offlineNotice: 'Este Home no responde. Puedes seguir leyendo, pero no hacer cambios.',
    unavailableTitle: 'Este Home no está disponible',
    unavailableBody: 'Happier no pudo leer el estado de administración de este Home.',
    forbiddenTitle: 'No puedes administrar este Home',
    forbiddenBody: 'Tu cuenta no tiene autoridad de administración en este Home.',
    retry: 'Reintentar',
    loadMore: 'Cargar más',
    unsupportedBody: 'Este Home no ofrece administración. Puede estar ejecutando una versión anterior.',
    notObservedTitle: 'Aún no cargado',
    notObservedBody: 'Este Home todavía no ha comunicado su estado de administración a este dispositivo.',
    lastUpdated: ({ time }: { time: string }) => `Actualizado ${time}`,

    chooseHome: 'Elige un Home',
    chooseHomeFooter: 'Cada Home tiene sus propias cuentas, roles y políticas.',
    homesEmpty: 'Aún no hay Homes',
    homesEmptyBody: 'Añade un Home a este dispositivo para administrarlo aquí.',
    homesNoneAdministrable: 'Ningún Home para administrar',
    homesNoneAdministrableBody: 'Ninguno de los Homes que estás viendo da autoridad de administración a esta cuenta.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} no responde`,
    signedOutTitle: 'Sesión cerrada en este Home',
    signedOutBody: 'Vuelve a iniciar sesión en este Home para administrarlo.',
    credentialUnreadableTitle: 'No se pudo leer el inicio de sesión guardado en este dispositivo',
    credentialUnreadableBody: 'El problema está en este dispositivo, no en el Home, y no se cerró tu sesión. Vuelve a intentarlo.',
    credentialUnreadableInviteBody: 'El problema está en este dispositivo, no en el Home. Tu enlace de invitación sigue funcionando, así que puedes volver a intentarlo ahora o más tarde.',

    peopleEmpty: 'Todavía no hay cuentas en este Home.',
    rosterUnavailableTitle: 'La lista de personas aún no está disponible',
    rosterUnavailableBody: 'Este Home todavía no proporciona su lista de cuentas a Happier. Los roles y el estado aparecerán aquí cuando lo haga.',
    accountUnavailableBody: 'Esta cuenta aún no está disponible desde este Home.',
    searchPlaceholder: 'Buscar cuentas',
    searchResults: 'Resultados de búsqueda',
    searchResultsFooter: 'Abre una cuenta para ver su rol y su estado.',
    searchEmpty: 'Ninguna cuenta coincide con esa búsqueda.',
    searchUnsupported: 'La búsqueda no está disponible en este Home',
    searchUnsupportedBody: 'Este Home no ofrece búsqueda de cuentas. Puede que use una versión anterior.',
    searchFailed: 'No se pudo completar la búsqueda',
    searchFailedBody: 'Este Home no respondió a la búsqueda. Cambia el texto para volver a intentarlo.',

    statusActive: 'Activa',
    statusDisabled: 'Deshabilitada',
    statusRetired: 'Retirada',
    statusDisabledDetail: 'Sesión cerrada en todas partes. Se puede volver a habilitar.',
    statusRetiredDetail: 'Acceso revocado permanentemente.',

    changeRole: 'Cambiar rol',
    disable: 'Deshabilitar cuenta',
    enable: 'Volver a habilitar la cuenta',
    deleteAccount: 'Eliminar la cuenta y sus datos…',
    retryDeletion: 'Reintentar la eliminación',

    reasonLastActiveOwner: 'Este Home necesita al menos un propietario activo. Haz propietario a otra cuenta primero.',
    reasonTargetInactive: 'Solo una cuenta activa puede tener un rol en el Home.',
    reasonHomeUnreachable: 'Este Home no responde. No se pueden hacer cambios hasta que se reconecte.',

    roleSheetTitle: 'Rol en el Home',
    roleOwnerDescription: 'Puede administrar todo en este Home, incluida la eliminación de cuentas.',
    roleAdminDescription: 'Puede administrar cuentas y equipos, pero no cambiar propietarios.',
    roleMemberDescription: 'Sin autoridad de administración del Home.',

    disableTitle: ({ account }: { account: string }) => `¿Deshabilitar a ${account}?`,
    disableBody: 'Se cerrará su sesión en todos los dispositivos y sus máquinas se desconectarán. Los tokens de acceso personal se revocan permanentemente, se elimina la responsabilidad de las sesiones y, en cada sesión a la que pierda acceso, se descartan sus borradores sin enviar y se elimina su seguimiento. Al volver a habilitar la cuenta se recupera el acceso, pero no esos borradores, el seguimiento ni la responsabilidad. Se conservan la pertenencia a equipos y las claves de cifrado.',
    disableConfirm: 'Deshabilitar',
    enableTitle: ({ account }: { account: string }) => `¿Volver a habilitar a ${account}?`,
    enableBody: 'Podrá iniciar sesión de nuevo en sus dispositivos. Los tokens de acceso revocados siguen revocados.',
    enableConfirm: 'Volver a habilitar',
    deleteTitle: ({ account }: { account: string }) => `¿Eliminar a ${account} y todos sus datos?`,
    deleteBody: ({ home }: { home: string }) => `Esto elimina de forma permanente la cuenta y sus datos en ${home}. No se puede deshacer. La propiedad del Home o de un equipo debe transferirse antes.`,
    deleteConfirm: 'Eliminar',

    deleteIncompleteTitle: 'La eliminación no se completó',
    deleteIncompleteBody: 'El acceso se revocó y esta cuenta ahora está retirada, pero la limpieza no terminó. Reintenta la eliminación para completarla.',
    deleteIncompleteMemberBody: 'El acceso se revocó, pero la limpieza no terminó. Un propietario del Home o el operador del servidor puede completarla.',

    errorForbidden: 'Ya no tienes autoridad para este cambio en este Home.',
    errorOwnerTransferRequired: 'Este Home necesita al menos un propietario activo. Haz propietario a otra cuenta primero.',
    errorTeamOwnerTransferRequired: 'Un equipo todavía necesita esta cuenta como propietaria. Dale otro propietario a ese equipo primero.',
    errorAccountNotFound: 'Esta cuenta ya no existe en este Home.',
    errorAccountInactive: 'Esta cuenta no está activa, así que no puede recibir esta autoridad.',
    errorErasureTransitionCleanupPending: 'La eliminación de la cuenta está esperando la limpieza del cifrado. Intenta eliminar la cuenta de nuevo.',
    errorGeneric: 'Este Home no pudo completar el cambio. No se cambió nada.',
    errorConflict: 'Aquí ya se cambió otra cosa antes. Actualiza este Home e inténtalo de nuevo.',
    changeFailedTitle: 'El cambio no se realizó',
    errorOutcomeUnknownTitle: 'Este cambio no se confirmó',
    errorOutcomeUnknown: 'La solicitud llegó a este Home, pero se perdió su respuesta. Puede que se haya aplicado. Actualiza este Home y compruébalo antes de volver a intentarlo.',

    teamCreation: 'Creación de equipos',
    teamCreationSelfService: 'Cualquiera puede crear equipos',
    teamCreationSelfServiceDescription: 'Los miembros activos de este Home pueden crear un equipo y ser su propietario.',
    teamCreationManagedOnly: 'Los administradores crean equipos',
    teamCreationManagedOnlyDescription: 'Los propietarios y administradores crean equipos y eligen al propietario inicial.',
    teamCreationDisabled: 'Creación de equipos deshabilitada',
    teamCreationDisabledDescription: 'No se crean equipos nuevos. Los equipos existentes no cambian.',
    teamsVisibility: 'Quién ve los equipos',
    teamsVisibleToMembers: 'Mostrar los equipos a los miembros',
    teamsVisibleToMembersDescription: 'Si está desactivado, solo los miembros de un equipo y los administradores ven los equipos.',
    teamJit: 'Pertenencia automática al equipo al iniciar sesión',
    teamJitDescription: 'Iniciar sesión a través del proveedor de identidad conectado de un equipo incorpora a esa persona al equipo automáticamente, sin invitación ni aprobación.',
    githubEnterpriseOrigins: 'Hosts de GitHub Enterprise aprobados',
    githubEnterpriseOriginsDescription: 'Un origen HTTPS canónico por línea. Los equipos solo pueden conectar GitHub Apps a estos hosts.',
    githubEnterpriseOriginsInvalid: 'Usa orígenes HTTPS únicos sin rutas, consultas, credenciales ni fragmentos.',

    signInTitle: 'Inicio de sesión y admisión',
    authActionLogin: 'Inicio de sesión',
    authActionProvision: 'Cuentas nuevas',
    authActionConnect: 'Vinculación de cuentas',
    authReasonMethodNotEnabled: 'El método de inicio de sesión está desactivado',
    authReasonProvisioningNotEnabled: 'La creación de cuentas está desactivada',
    authReasonAccountModeUnavailable: 'El tipo de cuenta no está disponible',
    authReasonEmailDeliveryUnavailable: 'El envío de correo no está disponible',
    authInherited: 'Usando los valores del servidor',
    authInheritedDescription: 'Este Home no restringe los métodos de inicio de sesión ni los tipos de cuenta.',
    authNarrowed: 'Restringido por este Home',
    authUnreadable: 'La configuración necesita atención',
    authUnreadableDescription: 'Este Home guarda una configuración de inicio de sesión que esta versión del servidor no puede leer. El inicio de sesión no estará disponible hasta que el operador la repare.',
    signInMethods: 'Métodos de inicio de sesión',
    accountModes: 'Tipos de cuenta',
    accountModePlain: 'Simple',
    accountModeE2ee: 'Cifrada de extremo a extremo',
    recommendedMode: 'Recomendado para cuentas nuevas',
    recommendedModeDescription: 'Define el valor predeterminado para las cuentas nuevas. Las cuentas existentes no cambian.',
    admissionSelfService: 'Cualquiera',
    admissionInvitationOnly: 'Solo por invitación',
    admissionClosed: 'Nadie',

    deploymentServices: 'Servicios del despliegue',
    deploymentServicesDescription: 'Servicios de identidad que el operador configura para este servidor. No se pueden cambiar desde la administración del Home.',
    deploymentWorkosConfigured: 'Configurado',
    deploymentWorkosPartial: 'Configuración incompleta',
    deploymentWorkosNotConfigured: 'Sin configurar',
    privateEndpoints: 'Puntos de identidad privados',
    privateEndpointsDescription: 'Permite que el inicio de sesión gestionado llegue a proveedores de identidad en redes privadas. Solo son accesibles los hosts, redes y puertos de esta lista.',
    privateEndpointsPublicOnly: 'Solo puntos públicos',
    privateEndpointsAllowlist: 'Lista privada permitida',
    privateEndpointsHostnames: 'Nombres de host permitidos',
    privateEndpointsCidrs: 'Redes permitidas (CIDR)',
    privateEndpointsPorts: 'Puertos permitidos',
    privateEndpointsSave: 'Guardar política de red',
    privateEndpointsInvalid: 'Indica al menos un nombre de host o red, y un puerto entre 1 y 65535.',
    privateEndpointsUnreadable: 'Este Home guarda una política de red que esta versión del servidor no puede leer. El inicio de sesión gestionado sigue usando solo puntos públicos.',

    policyReadOnly: 'Solo un propietario del Home puede cambiar esto.',
    policyEditingUnavailable: 'Todavía no se pueden cambiar las políticas desde este dispositivo.',
    revisionConflictTitle: 'Esta política cambió en otro lugar',
    revisionConflictBody: 'Alguien más guardó un cambio mientras editabas. Tu elección se conserva: recarga este Home y vuelve a aplicarla.',
    reload: 'Recargar',
    person: {
        you: 'tú',
        roleDescription: 'Los miembros usan el Home; los administradores también gestionan personas y Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `¿Hacer a ${account} ${role}?`,
        roleChangeBody: 'Su acceso a este Home cambia de inmediato. Queda registrado en Actividad con tu nombre.',
        roleChangeConfirm: 'Cambiar rol',
        signIn: 'Inicio de sesión',
        signInDescription: 'Con qué puede iniciar sesión. Lo gestiona en su propia cuenta.',
        methods: 'Métodos',
        linkedProviders: 'Proveedores vinculados',
        none: 'Ninguno',
        teams: 'Teams',
        noTeams: 'No está en ningún Team',
        teamArchived: 'Team archivado',
        teamSuspended: 'suspendida',
        access: 'Acceso',
        accessDescription: 'Sesión iniciada en sus dispositivos — las sesiones no se registran una a una.',
        machines: 'Máquinas',
        apiTokens: 'Tokens de API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Último uso ${time}`,
        apiTokensNeverUsed: 'Nunca usado',
        signOutEverywhere: 'Cerrar sesión en todas partes',
        signOutEverywhereDescription: 'Cierra todas las sesiones iniciadas en todos sus dispositivos. Los tokens de API siguen funcionando hasta que se desactive la cuenta.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `¿Cerrar la sesión de ${account} en todas partes?`,
        signOutEverywhereBody: 'Cada dispositivo en el que tenga sesión iniciada tendrá que volver a iniciarla. Sus tokens de API siguen funcionando hasta que desactives la cuenta. Queda registrado en Actividad con tu nombre.',
        signOutEverywhereDone: 'Sesión cerrada en todas partes',
        recentActivity: 'Actividad reciente',
        noRecentActivity: 'Aún no hay cambios de administración sobre esta persona.',
        showAllActivity: 'Ver todo',
        disableOrDelete: 'Desactivar o eliminar',
        dangerFootnote: 'Desactivar cierra su sesión y detiene sus tokens de API; se puede deshacer. Eliminar borra su cuenta y sus datos de este Home para siempre.',
    },
    email: {
        title: 'Correo',
        status: 'Estado',
        sendingMail: 'Envío de correo',
        sendingReady: ({ host }: { host: string }) => `Listo · envía a través de ${host}`,
        sendingNotSetUp: 'Sin configurar',
        links: 'Enlaces en los correos',
        linksReady: 'Se abren en la app web de este Home',
        linksOpenAt: ({ host }: { host: string }) => `Se abren en ${host}`,
        setInReach: 'Configurar en Acceso',
        linksMissing: 'No hay dirección de la app web, así que no se pueden crear enlaces',
        mailServer: 'Servidor de correo',
        mailServerDescription: 'El servidor SMTP que envía los correos de verificación, restablecimiento de contraseña e invitación.',
        server: 'Servidor',
        port: 'Puerto',
        portAndSecurity: 'Puerto y seguridad',
        security: 'Seguridad de la conexión',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Usuario',
        password: 'Contraseña',
        passwordDescription: 'Se guarda cifrada en el servidor. Nunca se vuelve a mostrar.',
        saved: 'Guardada',
        replace: 'Reemplazar',
        clear: 'Quitar',
        keep: 'Conservar',
        clearPending: 'La contraseña guardada se quitará al guardar.',
        valueSet: 'Configurada',
        valueNotSet: 'Sin configurar',
        sender: 'Remitente',
        fromAddress: 'Dirección del remitente',
        fromName: 'Nombre del remitente',
        test: 'Enviar un correo de prueba',
        testDescription: 'Envía un mensaje corto sin enlaces.',
        testTo: 'Para',
        testToPlaceholder: 'Cualquier dirección que puedas revisar',
        testSend: 'Enviar',
        testSaveFirst: 'Guarda tus cambios antes de enviar una prueba.',
        testSent: ({ to }: { to: string }) => `Enviado a ${to}`,
        testSentDetail: 'Revisa la bandeja de entrada y, si no está ahí, la carpeta de spam.',
        testFailed: 'No se pudo enviar',
        testNotConfigured: 'El correo aún no está configurado.',
        testPasswordUnreadable: 'No se puede leer la contraseña guardada. Vuelve a introducirla.',
        testRenderFailed: 'No se pudo preparar el mensaje de prueba.',
        testTransportFailed: 'No se pudo contactar con el servidor de correo o rechazó el mensaje.',
        adminTitle: 'Solo los propietarios pueden cambiar la configuración de correo',
        adminBody: 'Puedes verla porque eres admin de este Home.',
        notSetUpTitle: 'El correo no está configurado',
        notSetUpBody: 'El restablecimiento de contraseñas, la verificación por correo y las invitaciones por correo están desactivados hasta que lo esté.',
        unreadableTitle: 'No se puede leer la contraseña guardada',
        unreadableBody: 'El secreto maestro del servidor cambió desde que se guardó. Vuelve a introducir la contraseña.',
        invalidValue: 'Introduce un valor válido.',
        invalidPort: 'Usa un puerto del 1 al 65535.',
        invalidEmail: 'Introduce una dirección de correo.',
        conflictTitle: 'La configuración de correo cambió en otro lugar',
        conflictBody: 'Alguien guardó un cambio mientras editabas. Tus cambios se conservan: revísalos y vuelve a guardar.',
        loadFailed: 'Este Home no devolvió su configuración de correo.',
    },
    signInProviders: {
        title: 'Proveedores de inicio de sesión',
        description: 'Inicio de sesión corporativo, GitHub Apps y las reglas que usan los Teams. Activa un proveedor para iniciar sesión en Políticas.',
        ownersOnlyTitle: 'Solo los propietarios pueden cambiar los proveedores de inicio de sesión',
        ownersOnlyBody: 'Pide a un propietario de este Home que añada o cambie proveedores de identidad y GitHub Apps.',
        fromDeployment: ({ key }: { key: string }) => `De tu despliegue · ${key} · solo lectura`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `Definido por tu despliegue (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `Definido en Ajustes del servidor (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `Fijado por tu despliegue · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `Desactivado en este Home · ${key}`,
        teamRules: 'Reglas de inicio de sesión de los Teams',
        teamRulesDescription: 'Lo que los Teams pueden añadir a los proveedores del Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `añadió el proveedor de identidad ${name}`,
            changedProvider: ({ name }: { name: string }) => `cambió el proveedor de identidad ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `reemplazó el secreto de cliente de ${name}`,
            enabledProvider: ({ name }: { name: string }) => `activó ${name}`,
            disabledProvider: ({ name }: { name: string }) => `desactivó ${name}`,
            removedProvider: ({ name }: { name: string }) => `eliminó el proveedor de identidad ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `añadió la GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `cambió la GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `reemplazó los secretos de la GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `verificó ${name} en ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `quitó ${name} de ${organization}`,
        },
    },
    reach: {
        title: 'Acceso',
        diagramTitle: ({ home }: { home: string }) => `Cómo llega un dispositivo nuevo a ${home}`,
        yourDevices: 'Tus dispositivos',
        noAddress: 'Sin dirección pública',
        plusDirect: '+ directo (Iroh) cuando es posible',
        noDirect: 'Sin conexiones directas',
        thisComputer: 'Este ordenador',
        homeServer: 'Servidor de este Home',
        diagramDeployment: 'Fijada por tu despliegue',
        diagramHere: 'Configurada aquí',
        diagramInferred: ({ method }: { method: string }) => `${method} · deducida`,
        addresses: 'Direcciones',
        addressesDescription: 'Cambiar una dirección nunca cierra la sesión de nadie.',
        publicAddress: 'Dirección pública',
        webAppAddress: 'Dirección de la app web',
        accessMethod: 'Método de acceso',
        publicAddressHome: 'Configurada aquí',
        publicAddressNone: 'Sin configurar. Los dispositivos de otras redes no pueden llegar a este Home.',
        inferredFrom: ({ method }: { method: string }) => `Deducida de ${method} en el ordenador que aloja este Home`,
        inferredFromHost: 'Deducida en el ordenador que aloja este Home',
        webAppDescription: 'Los enlaces de correos e invitaciones se abren aquí.',
        webAppServed: 'Los enlaces se abren en la app web que sirve este Home.',
        webAppDefault: 'Los enlaces se abren en la app web de Happier. Predeterminado',
        change: 'Cambiar',
        setAddress: 'Configurar dirección',
        httpsRequired: 'Usa una dirección https://.',
        invalidAddress: 'Escribe una dirección completa, como https://home.example.com.',
        conflict: 'La configuración de este Home ha cambiado. Inténtalo de nuevo.',
        methodLocalOnly: 'Solo este ordenador',
        methodLan: 'Red local',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Cómo expone este ordenador el Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Se configura en ${host}. Ábrelo en Hosts remotos.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Se configura en el ordenador que aloja este Home (${host}). Abre Happier allí o añádelo como host remoto.`,
        accessMethodElsewhere: 'Se configura en el ordenador que aloja este Home. Abre Happier allí o añádelo como host remoto.',
        accessMethodDeployment: 'Lo gestiona tu despliegue.',
        directConnections: 'Conexiones directas',
        directConnectionsDescription: 'Los dispositivos se conectan directamente a este Home cuando pueden y, si no, usan la dirección pública.',
        directConnectionsRow: 'Conexiones directas (Iroh)',
        irohActive: 'Activas · los dispositivos se conectan de igual a igual cuando pueden',
        irohStarting: 'Iniciando…',
        irohOff: 'Desactivadas · los dispositivos se conectan por la dirección pública',
        irohFailed: 'No se está ejecutando en este ordenador. Los dispositivos se conectan por la dirección pública.',
        irohNotAvailable: 'No disponible en este despliegue. Los dispositivos se conectan por la dirección pública.',
        irohNeedsAddressHint: 'Configura una dirección pública antes de desactivarlas',
        irohOffTitle: '¿Desactivar las conexiones directas?',
        irohOffBody: 'Los dispositivos solo se conectarán por la dirección pública. La identidad de conexión directa actual de este Home se retira para siempre; al volver a activarlas se crea una nueva, que los dispositivos adoptan en su próxima conexión. La dirección pública y los inicios de sesión no cambian.',
        irohOffConfirm: 'Desactivar',
        irohNeedsAddressTitle: 'Configura primero una dirección pública',
        irohNeedsAddressBody: 'Sin una dirección pública, los dispositivos no podrían llegar a este Home una vez desactivadas las conexiones directas.',
        relay: 'Relé para conexiones directas',
        relayAutomatic: 'Automático',
        relayOff: 'Desactivado',
        relayCustom: ({ count }: { count: number }) => `Tus relés (${count}) · Se aplica tras reiniciar`,
        appliesAfterRestart: 'Se aplica tras reiniciar',
        appliesAfterRestartPending: 'Se aplica tras reiniciar · Pendiente',
        exposureInternetTitle: ({ method }: { method: string }) => `Accesible desde internet a través de ${method}`,
        exposureAddressTitle: 'Tu dirección pública está abierta a registros',
        exposureOpenSignup: 'Cualquiera que llegue a este Home puede crear una cuenta. Revisa quién puede registrarse en Políticas.',
        exposureInvitationOnly: 'Las cuentas nuevas necesitan una invitación, así que los desconocidos no pueden registrarse.',
        loadFailed: 'No se pudo cargar cómo se accede a este Home.',
    },
    runtime: {
        title: 'Ejecución',
        version: 'Versión',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Este Home no informa de su versión',
        flavorLight: 'Servidor ligero',
        flavorFull: 'Servidor completo',
        server: 'Servidor',
        restart: 'Reiniciar',
        restartNow: 'Reiniciar ahora',
        restartFailed: 'No se pudo reiniciar el servidor',
        restartToApply: 'Reinicia el servidor para aplicarlos.',
        restartFromDeployment: 'Reinicia desde tu despliegue para aplicarlos.',
        restartFromHost: ({ host }: { host: string }) => `Reinicia desde ${host}, el ordenador que aloja este Home.`,
        restartFromHostingComputer: 'Reinicia desde el ordenador que aloja este Home.',
        managedFrom: ({ host }: { host: string }) => `Se gestiona desde ${host}`,
        managedFromBody: 'Abre Happier en el ordenador que aloja este Home para actualizarlo, reiniciarlo o detenerlo.',
        managedElsewhere: 'Se gestiona desde el ordenador que aloja este Home',
        deploymentTitle: 'Lo gestiona tu despliegue',
        deploymentBody: 'Las actualizaciones, reinicios y copias de seguridad de este servidor las hace quien lo despliega.',
        backups: 'Copias de seguridad',
        backupsHere: 'Haz copias, restaura o mueve este Home desde su página de Ejecución.',
        backupsFromHost: ({ host }: { host: string }) => `Haz la copia desde ${host}, el ordenador que aloja este Home.`,
        backupsFromHostingComputer: 'Haz la copia desde el ordenador que aloja este Home.',
        backupsDeployment: 'Las copias de seguridad las gestiona tu despliegue.',
        hostedHere: ({ home }: { home: string }) => `Este ordenador aloja ${home}`,
        hostedHereSubtitle: 'Actualízalo, reinícialo, haz copias y muévelo desde su consola del Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 cambio se aplica tras reiniciar' : `${count} cambios se aplican tras reiniciar`),
    },
    activity: {
        title: 'Actividad',
        emptyTitle: 'Aún no hay actividad',
        emptyBody: 'Los cambios en el inicio de sesión, el correo, las personas, las políticas y la propiedad aparecen aquí a medida que ocurren.',
        showOlder: 'Mostrar anteriores',
        footnote: 'No se muestran las acciones realizadas con Happier en el propio ordenador anfitrión, como copias de seguridad y reinicios.',
        loadFailed: 'Este Home no devolvió su actividad.',
        deploymentCommand: 'Comando de despliegue',
        personalHomeSetup: 'Configuración del Personal Home',
        someone: 'Alguien',
        removedAccount: 'una cuenta eliminada',
        claimed: 'reclamó la propiedad de este Home',
        madeOwner: ({ target }: { target: string }) => `hizo propietario a ${target}`,
        assignedOwner: 'asignó el primer propietario',
        changedPolicies: 'cambió las políticas',
        changedEmailSetting: 'actualizó la configuración de correo',
        changedServerSetting: 'cambió la configuración del servidor',
        changedRole: ({ target }: { target: string }) => `cambió el rol de ${target}`,
        disabled: ({ target }: { target: string }) => `desactivó a ${target}`,
        reenabled: ({ target }: { target: string }) => `reactivó a ${target}`,
        changedStatus: ({ target }: { target: string }) => `cambió el estado de ${target}`,
        deleted: ({ target }: { target: string }) => `eliminó a ${target}`,
        deletionStarted: ({ target }: { target: string }) => `empezó a eliminar a ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `cerró la sesión de ${target} en todas partes`,
        areaOwnership: 'Propiedad',
        areaPolicies: 'Políticas',
        areaEmail: 'Correo',
        areaServerSettings: 'Configuración del servidor',
        areaPeople: 'Personas',
        fieldRole: 'Rol',
        fieldStatus: 'Estado',
        fieldTeamProviders: 'Proveedores de inicio de sesión de Teams',
        valueEmpty: '—',
        valueChanged: 'cambiado',
        valueOn: 'Activado',
        valueOff: 'Desactivado',
        secretSet: 'configurada',
        secretUnset: 'sin configurar',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Cómo se inicia sesión en ${home}. Al menos un método sigue activo y nadie pierde su último acceso.`,
        methodUnavailable: 'No disponible — tu despliegue no puede ofrecerlo',
        signInService: 'Servicio de inicio de sesión del Home',
        signInServiceDescription: 'Iniciar sesión con el servicio propio de este Home.',
        admissionTitle: 'Quién puede crear una cuenta',
        newAccounts: 'Cuentas nuevas',
        admissionAnyoneDescription: 'Cualquiera que pueda llegar a este Home',
        admissionInvitationDescription: 'Solo personas con una invitación de equipo',
        admissionNobodyDescription: 'Nadie puede crear una cuenta',
        anonymousSignup: 'Registro anónimo',
        anonymousSignupDescription: 'Crear una cuenta solo con una clave de recuperación, sin correo.',
        encryptionTitle: 'Cifrado',
        encryptionDescription: 'Se aplica a las cuentas y sesiones creadas a partir de ahora. Las existentes nunca cambian.',
        storagePolicy: 'Política de almacenamiento',
        storageRequired: 'E2EE obligatorio',
        storageOptional: 'Opcional',
        storagePlaintext: 'Solo texto plano',
        storageRequiredDescription: 'Todas las cuentas mantienen el cifrado de extremo a extremo',
        storageOptionalDescription: 'Cada cuenta elige si cifra',
        storagePlaintextDescription: 'Las cuentas guardan datos sin cifrado de extremo a extremo',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Se aplica tras reiniciar · ${running} hasta entonces`,
        allowE2ee: 'Cuentas con cifrado de extremo a extremo',
        allowPlain: 'Cuentas sin cifrado de extremo a extremo',
        recommendedInherited: 'Predeterminado del servidor',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Este cambio deja entrar a más personas y necesita tu confirmación. No se cambió nada.',
        widening: {
            titleAnyone: '¿Permitir que cualquiera cree una cuenta?',
            titleInvited: '¿Permitir que las personas invitadas creen cuentas?',
            titleMethod: ({ method }: { method: string }) => `¿Activar ${method}?`,
            titleAnonymous: '¿Permitir el registro anónimo?',
            titleUnencrypted: '¿Permitir almacenamiento sin cifrar?',
            titleOther: '¿Dejar entrar a más personas?',
            exposureAnyone: ({ host }: { host: string }) => `Cualquiera que llegue a este Home en ${host} podrá registrarse sin invitación.`,
            exposureInvited: ({ host }: { host: string }) => `Cualquiera con una invitación que llegue a este Home en ${host} podrá crear una cuenta.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Cualquiera que llegue a este Home en ${host} podrá iniciar sesión con ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Cualquiera que llegue a este Home en ${host} podrá crear una cuenta solo con una clave de recuperación.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Cualquiera que llegue a este Home en ${host} podrá guardar aquí sus datos sin cifrado de extremo a extremo.`,
            exposureOther: ({ host }: { host: string }) => `Cualquiera que llegue a este Home en ${host} podrá iniciar sesión o unirse con las reglas ampliadas.`,
            unchanged: 'Las cuentas e invitaciones existentes no cambian.',
            recorded: 'El cambio queda registrado en Actividad con tu nombre.',
            confirmAnyone: 'Permitir que cualquiera se registre',
            confirmInvited: 'Permitir invitaciones',
            confirmMethod: ({ method }: { method: string }) => `Activar ${method}`,
            confirmAnonymous: 'Permitir el registro anónimo',
            confirmUnencrypted: 'Permitir almacenamiento sin cifrar',
            confirmOther: 'Aplicar el cambio',
        },
    },
    claim: {
        pageDescription: 'Reclama la propiedad de este Home.',
        emptyTitle: 'Este Home aún no tiene propietario',
        emptyBody: 'Un propietario gestiona el inicio de sesión, el correo, el acceso y las personas. Hasta que alguien lo reclame, nadie puede administrar este Home.',
        codeTitle: 'Reclamar con un código de un solo uso',
        codeDescription: 'Alguien con acceso al servidor imprime un código. Funciona una vez y caduca a los 15 minutos.',
        printStep: '1 · Imprime un código en el servidor',
        pasteStep: '2 · Pégalo aquí',
        codeLabel: 'Código de reclamación',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Reclamar',
        refused: 'Este código no ha funcionado. Puede estar mal escrito, usado o caducado — imprime uno nuevo.',
        hostTitle: ({ home }: { home: string }) => `Este ordenador aloja ${home}`,
        hostBody: 'Puedes hacer que tu cuenta sea su propietaria desde aquí. Solo este ordenador puede hacerlo así.',
        makeOwner: 'Hacerme propietario',
        hostFailed: 'Este ordenador no pudo hacerte propietario. Inténtalo de nuevo.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Fijado por tu despliegue · ${key}`,
    fixedByDeploymentLead: 'Fijado por tu despliegue',
    deploymentNotSetLead: 'No disponible hasta que tu despliegue defina',
    features: {
        title: 'Funciones',
        common: 'Comunes',
        advanced: 'Avanzadas',
        advancedDescription: ({ count }: { count: number }) => `${count} más, agrupadas por área.`,
        other: 'Otras',
        familyCount_one: '1 función',
        familyCount_other: ({ count }: { count: number }) => `${count} funciones`,
        offHome: 'Desactivada para este Home.',
        notInBuild: 'No incluida en esta compilación.',
        needs: ({ feature }: { feature: string }) => `Necesita ${feature}.`,
        unavailable: 'No disponible en este Home.',
        noHomeSwitchOn: 'Siempre activada en este Home · solo la compilación de Happier puede desactivarla',
        noHomeSwitchOff: 'Desactivada en este Home · solo la compilación de Happier puede activarla',
        unavailableByDeployment: 'No disponible en este Home · lo decide la configuración de tu despliegue',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Desactivar ${feature} también desactiva 1 función`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Desactivar ${feature} también desactiva ${count} funciones`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} necesita ${parent}.`,
        turnOff: 'Desactivar',
        deviceTitle: 'Funciones de este dispositivo',
        deviceBody: 'Las funciones que solo afectan a este dispositivo están en Ajustes.',
        adminTitle: 'Solo los propietarios pueden cambiar las funciones',
        adminBody: 'Puedes ver lo que ofrece este Home porque eres admin.',
        loadFailed: 'Este Home no devolvió sus funciones.',
        conflictTitle: 'Las funciones cambiaron en otro lugar',
        conflictBody: 'Alguien cambió la configuración de este Home mientras la mirabas. La página muestra ahora lo que guarda el Home.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} o más`,
        rangeAtMost: ({ max }: { max: number }) => `Hasta ${max}`,
        limitInvalid: 'Introduce un número dentro del rango.',
        appliesAfterRestart: 'Se aplica tras reiniciar',
        onAfterRestart: 'Activada tras reiniciar',
        offAfterRestart: 'Desactivada tras reiniciar',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Ignorado en el último inicio: ${reason}`,
        ignoredInvalidType: 'el valor guardado tiene un tipo incorrecto',
        ignoredOutOfBounds: 'el valor guardado está fuera de rango',
        ignoredSecretUnreadable: 'no se puede leer el secreto guardado',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Tras el próximo reinicio, desactivar ${feature} también desactiva 1 función`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Tras el próximo reinicio, desactivar ${feature} también desactiva ${count} funciones`,
    },
    data: {
        title: 'Datos',
        deletion: 'Eliminación automática',
        deletionDescription: 'Los cambios se aplican desde la próxima limpieza.',
        dryRunMode: 'Modo de simulación',
        dryRunModeDescription: 'La limpieza cuenta en lugar de eliminar hasta que desactives esto.',
        tryRules: 'Probar las reglas actuales',
        tryRulesDescription: 'Ejecuta ahora una limpieza sin eliminar nada.',
        runDryRun: 'Ejecutar simulación',
        runAgain: 'Volver a ejecutar',
        ranAt: ({ time }: { time: string }) => `Ejecutada a las ${time} · no se eliminó nada`,
        sweepInProgress: 'Hay una limpieza en curso: vuelve a intentarlo cuando termine.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Eliminaría ${count} · ${examined} examinados`,
        nothingToDelete: 'Nada que eliminar',
        stopTimeBudget: 'detenida: límite de tiempo',
        stopRowBudget: 'detenida: límite de eliminación',
        stopCandidateBudget: 'detenida: límite de examen',
        stopStalled: 'detenida: sin progreso',
        keep: 'Conservar',
        deleteAfter: 'Eliminar tras',
        days: 'días',
        daysFor: ({ domain }: { domain: string }) => `Días que se conservan ${domain}`,
        daysRequired: 'Indica cuántos días.',
        daysInvalid: 'Usa un número entero de días, 1 o más.',
        defaultEffect: ({ effect }: { effect: string }) => `Predeterminado · ${effect}`,
        alwaysRuns: 'Se ejecuta incluso con la eliminación automática desactivada.',
        expiresAutomatically: 'Caduca automáticamente',
        systemRecords: 'Registros del sistema',
        systemRecordsSummary_one: '1 tipo de registro que este Home guarda para sí',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} tipos de registros que este Home guarda para sí`,
        adminTitle: 'Solo los propietarios pueden cambiar lo que conserva este Home',
        adminBody: 'Puedes ver las reglas porque eres admin.',
        loadFailed: 'Este Home no devolvió su configuración de datos.',
        conflictTitle: 'La configuración de datos cambió en otro lugar',
        conflictBody: 'Alguien cambió la configuración de este Home mientras la mirabas. La página muestra ahora lo que guarda el Home.',
    },
};

const homeGovernanceTranslations = { es } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { es: {
        greetingMorning: ({ name }) => `Buenos días, ${name}`,
        greetingAfternoon: ({ name }) => `Buenas tardes, ${name}`,
        greetingEvening: ({ name }) => `Buenas noches, ${name}`,
        greetingMorningAnonymous: 'Buenos días',
        greetingAfternoonAnonymous: 'Buenas tardes',
        greetingEveningAnonymous: 'Buenas noches',
        sessionsWorking: ({ count }) => (count === 1 ? '1 sesión trabajando' : `${count} sesiones trabajando`),
        sessionsNeedYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        nothingRunning: 'Nada en marcha todavía',
        customize: 'Personalizar',
        customizeTitle: 'Personalizar inicio',
        customizeDescription: 'Arrastra para reordenar. Se guarda en tu cuenta, así todos tus dispositivos muestran el mismo inicio.',
        reset: 'Restablecer',
        alwaysShown: 'Siempre visible',
        builtIn: 'Integrado',
        startDescription: 'Compositor y sugerencias',
        attentionDescription: 'Aparece cuando algo te necesita',
        machinesDescription: 'Integrado · una cuadrícula de tus máquinas',
        hiddenSetupSteps: 'Pasos de configuración ocultos',
        showAgain: ({ count }) => `${count} · Mostrar de nuevo`,
        reorderHandle: ({ section }) => `Reordenar ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "es">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const es: typeof en = {
    page: {
        title: 'Ajustes del servidor',
        description: 'Cada ajuste que lee el servidor que no tiene su propia página.',
        searchPlaceholder: 'Buscar ajustes o claves de entorno',
        changed: 'Cambiado',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Mostrar solo el ajuste cambiado' : `Mostrar solo los ${count} ajustes cambiados`),
        noMatches: 'Ningún ajuste coincide con esta búsqueda.',
        noChanges: 'Ningún ajuste está cambiado respecto a su valor predeterminado en este Home.',
        filterLabel: 'Mostrar',
        filterAll: 'Todos los ajustes',
        filterChanged: ({ count }: { count: number }) => `Cambiados · ${count}`,
        more: 'Más',
        readOnlyTitle: 'Solo lectura al iniciar',
        readOnlyDescription: 'El servidor necesita estos ajustes antes de poder leer cualquier ajuste guardado, así que se establecen donde se ejecuta.',
        note: 'Los ajustes se aplican en cuanto los cambias, salvo que estén marcados como "Se aplica tras reiniciar". Pendiente significa que el valor guardado difiere del que tenía el servidor al iniciarse. Todo cambio se registra en Actividad; los valores secretos nunca.',
        adminTitle: 'Solo los propietarios cambian los ajustes del servidor',
        adminBody: 'Puedes ver todos los ajustes y de dónde viene su valor.',
        loadFailed: 'No se pudieron cargar los ajustes del servidor.',
        saveFailed: 'El ajuste no se guardó.',
        conflictTitle: 'Los ajustes cambiaron en otro sitio',
        conflictBody: 'Alguien cambió los ajustes de este Home mientras los editabas. La página ahora muestra sus valores; tu edición sigue en su campo.',
    },
    row: {
        appliesAfterRestart: 'Se aplica tras reiniciar',
        pending: 'Pendiente',
        defaultValue: ({ value }: { value: string }) => `Predeterminado: ${value}`,
        runningWith: ({ value }: { value: string }) => `ejecutándose con ${value} desde el último inicio`,
        runningWithout: 'ejecutándose sin él desde el último inicio',
        ignored: ({ reason }: { reason: string }) => `Ignorado en el último inicio: ${reason}`,
        runningOn: ({ value }: { value: string }) => `ejecutándose en ${value}`,
        notSet: 'Sin definir',
        outOfBounds: ({ bounds }: { bounds: string }) => `Debe estar ${bounds}`,
        invalid: 'Este valor no es válido aquí',
        storedEncrypted: 'guardado cifrado, nunca se muestra',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '1 más' : `${count} más`),
        discard: 'Descartar',
        discardA11y: 'Descartar los cambios que se aplican tras reiniciar',
        discarded: 'Cambios pendientes descartados',
        ignoredTitle: 'Un ajuste se ignoró en el último inicio',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} ajustes se ignoraron en el último inicio`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. El servidor arrancó sin él.`,
        fix: 'Solucionar',
    },
    readOnly: {
        before_database: 'Se lee antes de abrir la base de datos',
        per_process_identity: 'Es distinto para cada proceso del servidor',
        invariant: 'Protege el inicio de sesión y los límites de compilación, así que no se puede cambiar aquí',
        other: 'Se establece donde se ejecuta el servidor',
        set: 'Establecido',
    },
    secret: {
        saved: 'Guardado',
        replace: 'Reemplazar',
        clear: 'Quitar',
        keep: 'Conservar',
        clearPending: 'El valor guardado se quitará al guardar.',
        valueSet: 'Configurado',
        valueNotSet: 'Sin configurar',
        setAction: 'Definir',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 ajuste · predeterminado' : `${count} ajustes · predeterminados`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} ajustes · ${changed} cambiados`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'bytes',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Descartó un ajuste del servidor pendiente',
    },
    choices: {
        hosted_happier_relay: 'Relay de Happier',
        direct_apns: 'Push de Apple',
        background_wake_best_effort: 'Activación en segundo plano',
        local_only: 'Solo este dispositivo',
        disabled: 'Desactivado',
        enabled: 'Activado',
        automatic: 'Automático',
        sandbox: 'Sandbox',
        production: 'Producción',
        owner: 'Propietarios del servidor',
        authenticated: 'Cualquier persona con sesión',
        self: 'Este servidor',
        external: 'Servicio externo',
        '0': 'Desactivado',
        '1': 'Activado',
        any: 'Cualquiera',
        all: 'Todas',
        github_app: 'GitHub App',
        oauth_user_token: 'Token de la persona',
        light: 'Ligero',
        full: 'Completo',
        api: 'Solo API',
        worker: 'Solo worker',
        fatal: 'Fatal',
        error: 'Errores',
        warn: 'Advertencias',
        info: 'Información',
        debug: 'Depuración',
        trace: 'Traza',
        silent: 'Silencio',
        manual: 'Manual',
        default: 'Valor del servidor',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: solicitudes por ventana`,
        window: ({ route }: { route: string }) => `${route}: ventana`,
    },
    groups: {
        api: 'API y red',
        storage: 'Almacenamiento y archivos',
        monitoring: 'Monitorización',
        process: 'Proceso',
        ui: 'Entrega de la app web',
        realtime: 'Presencia y sockets',
        retentionCaps: 'Límites de recursos de conservación',
        rpc: 'Llamadas a máquinas',
        liveActivity: 'Live Activities',
        voice: 'Voz',
        connectedServices: 'Servicios conectados',
        localServices: 'Servicios locales',
        plugins: 'Plugins',
        reviews: 'Revisiones',
        bugReports: 'Informes de errores',
        releases: 'Lanzamientos',
        authCaches: 'Cachés de inicio de sesión',
        limits: 'Límites',
        rateLimits: 'Límites de frecuencia por ruta',
        github: 'Inicio de sesión de GitHub',
        oauth: 'Inicio de sesión OAuth',
        oidc: 'Proveedores OIDC de la configuración',
        workos: 'WorkOS',
        signInRequests: 'Solicitudes de inicio de sesión',
        offboarding: 'Baja de cuentas',
        friends: 'Amigos',
        accountService: 'Servicio de cuentas',
        devices: 'Dispositivos',
        diagnostics: 'Diagnóstico',
        reachInference: 'Detección de dirección',
        addresses: 'Direcciones',
        other: 'Otros',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nombre de Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Actualizaciones en segundo plano',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Modo de entrega',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Recurrir a otro modo',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Ventana de actualizaciones duplicadas',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Notificaciones push de activación en segundo plano',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Tiempo mínimo entre notificaciones de activación',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'La compilación de widgets recibe notificaciones push',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Fallos antes de descartar un dispositivo',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Entorno de notificaciones push de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID de equipo de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID de clave push de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Clave de firma push de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Archivo de clave de firma push de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'ID de paquete de apps permitidos',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Nombres de Live Activity permitidos',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Tiempo de espera de solicitud push de Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Retraso de reconexión push de Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Usar un relé alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Dirección del relé alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Clave de acceso del relé alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Actuar como relé alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Claves de acceso del relé para otros servidores',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Tolerancia de reloj del relé',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Memoria de duplicados del relé',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Tamaño de la caché de duplicados del relé',
        ELEVENLABS_API_KEY: 'Clave de API de ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agente de ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Agente de producción de ElevenLabs',
        ELEVENLABS_API_BASE_URL: 'Dirección de API de ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Clave secreta de RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Sesiones de voz gratuitas al mes',
        VOICE_FREE_MINUTES_PER_MONTH: 'Minutos de voz gratuitos al mes',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Sesiones de voz simultáneas',
        VOICE_MAX_SESSION_SECONDS: 'Sesión de voz más larga',
        VOICE_MAX_MINUTES_PER_DAY: 'Minutos de voz al día',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Relleno retroactivo de identidad de voz',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Tamaño del lote de relleno',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Presupuesto de tiempo del relleno',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pausa entre lotes de relleno',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Tiempo entre ejecuciones de relleno',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'ID de cliente OAuth de OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Endpoint de token de OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'ID de cliente OAuth de la suscripción de Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Endpoint de token de la suscripción de Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Tiempo de espera del intercambio de tokens',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Credencial guardada más grande',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Concesión de renovación más larga',
        VENDOR_TOKEN_MAX_LEN: 'Token de proveedor más grande',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Secreto del token de vista previa',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Secreto del token de vista previa privada',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Secreto del token de vista previa pública',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Origen de la interfaz de plugins',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Vigencia de la prueba del editor',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Tolerancia de reloj de la prueba del editor',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Vigencia de la prueba de revisión',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Tolerancia de reloj de la prueba de revisión',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Incluir registros del servidor',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Quién puede leer los registros del servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Archivo de registro del servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Tamaño de registro incluido',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Canal de lanzamiento',
        HAPPIER_GITHUB_REPO: 'Repositorio de lanzamiento',
        AUTH_OFFBOARDING_ENABLED: 'Volver a comprobar la elegibilidad de inicio de sesión',
        AUTH_OFFBOARDING_STRICT: 'Rechazar cuando falla una nueva comprobación',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Tiempo entre comprobaciones',
        AUTH_PROVIDERS_CONFIG_PATH: 'Archivo de proveedores',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON de proveedores',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Servicio de inicio de sesión',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Dirección del servicio de cuentas',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identidad del servicio de cuentas',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nombre del servicio de cuentas',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Cuentas propietarias del servidor',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Los nuevos dispositivos necesitan aprobación',
        GITHUB_CLIENT_ID: 'ID de cliente OAuth de GitHub',
        GITHUB_CLIENT_SECRET: 'Secreto de cliente OAuth de GitHub',
        GITHUB_REDIRECT_URL: 'Dirección de retorno de GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Tiempo de espera de solicitudes de GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Conservar el token de acceso de GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Vigencia del inicio de sesión pendiente',
        OAUTH_STATE_TTL_SECONDS: 'Vigencia del estado OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Esquemas de retorno de app permitidos',
        AUTH_GITHUB_ALLOWED_USERS: 'Usuarios de GitHub permitidos',
        AUTH_GITHUB_ALLOWED_ORGS: 'Organizaciones de GitHub permitidas',
        AUTH_GITHUB_ORG_MATCH: 'Organizaciones requeridas',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Comprobación de pertenencia',
        AUTH_GITHUB_APP_ID: 'ID de la GitHub App de pertenencia',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Clave de la GitHub App de pertenencia',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Instalaciones de la app por organización',
        WORKOS_API_KEY: 'Clave de API de WorkOS',
        WORKOS_CLIENT_ID: 'ID de cliente de WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Vigencia de la solicitud de inicio de sesión de cuenta',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Vigencia de la solicitud de inicio de sesión de terminal',
        AUTH_PAIRING_TTL_SECONDS: 'Vigencia del código de vinculación',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Vigencia de la caché de tokens de sesión',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Tamaño de la caché de tokens de sesión',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Vigencia de la caché de elegibilidad',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Tamaño de la caché de elegibilidad',
        FRIENDS_USERNAME_MIN_LEN: 'Nombre de usuario más corto',
        FRIENDS_USERNAME_MAX_LEN: 'Nombre de usuario más largo',
        FRIENDS_USERNAME_REGEX: 'Patrón del nombre de usuario',
        HAPPIER_CANONICAL_SERVER_URL: 'Dirección de identidad de inicio de sesión',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Dirección de retorno OAuth de la app web',
        PUBLIC_URL: 'Dirección anunciada (ligera)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Vigencia de la dirección detectada',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Detectar según el método de acceso',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Detectar desde Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Tiempo de espera de la comprobación de Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Tiempo de espera de la comprobación de Tailscale Funnel',
        PORT: 'Puerto de escucha',
        HAPPIER_SERVER_HOST: 'Dirección de escucha',
        HAPPIER_SERVER_FLAVOR: 'Variante del servidor',
        NODE_ENV: 'Entorno de Node',
        SERVER_ROLE: 'Rol del proceso',
        UV_THREADPOOL_SIZE: 'Hilos de trabajo',
        HAPPIER_INSTANCE_ID: 'ID de réplica',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Plazo de apagado',
        HAPPY_EXIT_ON_FATAL: 'Salir tras un error fatal',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Caché de preflight del navegador',
        HAPPIER_SERVER_IDENTITY_ID: 'Identidad del servidor',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Finalidad del relé gestionado',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Operación de reubicación',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Archivo de recibo de arranque',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce del recibo de arranque',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Recuperación anticipada del actualizador',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit de compilación',
        HAPPIER_FEATURE_POLICY_ENV: 'Política del anillo de lanzamiento',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Funciones permitidas',
        HAPPIER_BUILD_FEATURES_DENY: 'Funciones denegadas',
        HAPPIER_SERVER_LOG_LEVEL: 'Nivel de registro',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Registro de depuración consolidado',
        HAPPIER_SELF_HOST_LOG_DIR: 'Directorio de registros',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Diagnóstico de autenticación',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnóstico de mensajes de socket',
        METRICS_ENABLED: 'Métricas',
        METRICS_PORT: 'Puerto de métricas',
        SENTRY_DSN: 'DSN de reporte de errores',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Reportar a Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'DSN central de reporte de errores',
        SENTRY_ENVIRONMENT: 'Entorno de reporte de errores',
        SENTRY_RELEASE: 'Versión de reporte de errores',
        SENTRY_PROFILE_LIFECYCLE: 'Perfilado',
        SENTRY_SEND_DEFAULT_PII: 'Enviar datos personales',
        SENTRY_TRACES_SAMPLE_RATE: 'Solicitudes rastreadas',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Sesiones perfiladas',
        SENTRY_ENABLE_LOGS: 'Enviar registros',
        SENTRY_LOG_LEVELS: 'Niveles de registro enviados',
        SENTRY_MONITORS_ENABLED: 'Monitores de tareas',
        HAPPIER_SERVER_UI_DIR: 'Carpeta de la app web',
        HAPPIER_SERVER_UI_PREFIX: 'Ruta de la app web',
        HAPPIER_SERVER_UI_REQUIRED: 'Requerir la app web',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID de despliegue de la app web',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Mostrar la ruta de la app web si falta',
        HAPPIER_SOCKET_ADAPTER: 'Adaptador de socket',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adaptador de socket Redis (obsoleto)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Longitud del stream de sockets',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Tamaño de lectura del stream de sockets',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Mensaje de socket más grande',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Umbral de desconexión rápida',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Retraso de reconexión durante un reinicio',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Ventana de reconexión',
        HAPPY_SOCKET_ROOMS_ONLY: 'Difusión estricta por sockets',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Propiedad de socket de la máquina',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Longitud del stream de presencia',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Concurrencia de escritura de presencia',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Intervalo de vaciado de presencia',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Espera de lectura de presencia',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Tamaño de lectura de presencia',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Recuperación de presencia tras',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sesión inactiva tras',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Máquina fuera de línea tras',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Intervalo de comprobación de presencia',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Vaciado de presencia al apagar',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Tiempo de espera de llamadas a máquinas',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Tiempo de espera de llamadas de capacidades',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Tiempo de espera de llamada más largo',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera de un método',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Intervalo de comprobación del método',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Tiempo de espera de búsqueda entre réplicas',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera para detener una sesión',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera de sesiones directas',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sesiones que necesitan atención en la primera carga',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Turnos comprobados para la reversión',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Historial de ajustes conservado',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Requerir una clave de máquina firmada',
        DATABASE_URL: 'Base de datos',
        HAPPIER_DB_PROVIDER: 'Motor de base de datos',
        HAPPIER_DB_CONNECTION_LIMIT: 'Tamaño del pool de conexiones',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Tiempo de espera de disponibilidad de la base de datos',
        HAPPIER_DB_TX_MAX_RETRIES: 'Reintentos de transacción',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Retraso del primer reintento',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Retraso máximo de reintento',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Variación aleatoria del reintento',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Tiempo de espera de transacción',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Espera de conexión',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Presupuesto total de reintentos',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Advertencia de tamaño de la base de datos',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migrar al arrancar',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Carpeta de migraciones',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Modo de journal de SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Modo síncrono de SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Límite de tamaño del journal de SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Intervalo de checkpoint de SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Espera de checkpoint de SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Intervalo de vacuum de SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Páginas de vacuum de SQLite',
        HAPPIER_FILES_BACKEND: 'Backend de archivos',
        S3_HOST: 'Host de S3',
        S3_PORT: 'Puerto de S3',
        S3_USE_SSL: 'S3 sobre TLS',
        S3_REGION: 'Región de S3',
        S3_BUCKET: 'Bucket de S3',
        S3_PUBLIC_URL: 'Dirección pública de S3',
        S3_ACCESS_KEY: 'Clave de acceso de S3',
        S3_SECRET_KEY: 'Clave secreta de S3',
        REDIS_URL: 'Conexión de Redis',
        HANDY_MASTER_SECRET: 'Secreto maestro',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Directorio de datos',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Directorio de la base de datos',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Directorio de archivos',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Límites de frecuencia',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Solicitudes por cliente',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Ventana del límite de frecuencia',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Contar solicitudes por',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Contar solicitudes de ruta por',
        HAPPIER_SERVER_TRUST_PROXY: 'Confiar en las cabeceras de proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Tiempo entre barridos',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Filas por lote',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Máximo de eliminaciones por regla',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Presupuesto de tiempo del barrido',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Máximo de filas examinadas por regla',
    },
};

const homeSettingsTranslations = { es } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { es: {
        dismiss: ({ title }) => `Ocultar «${title}»`,
        dismissTooltip: 'Ocultar · recupéralo en Personalizar',
        close: 'Cerrar',
        addPhoneSubtitle: 'Sigue tus sesiones y responde aprobaciones desde cualquier lugar.',
        addPhoneAction: 'Mostrar código QR',
        addMachineSubtitle: 'Un servidor o equipo de desarrollo que ejecuta agentes, configurado por SSH o con un comando.',
        installComputerTitle: 'Instalar en otro ordenador',
        installComputerSubtitle: 'Instala allí la app de escritorio y únete a este Home con un enlace.',
        installComputerAction: 'Obtener el enlace',
        connectComputerTitle: 'Conectar un ordenador',
        connectComputerSubtitle: 'Escanea el código que Happier muestra en el terminal de tu ordenador.',
        connectComputerHint: 'Apunta la cámara al código que Happier muestra en el terminal de tu ordenador.',
        phoneAddMachineSubtitle: 'Configura un servidor o equipo de desarrollo para tus agentes.',
        phoneAddMachineAction: 'Añadir',
        thisHome: 'este Home',
        pairingPhoneTitle: 'Escanea con tu teléfono',
        pairingPhoneBody: ({ home }) => `Apunta la cámara del teléfono al código. Happier se abre y se une a ${home}.`,
        pairingPhoneStepInstall: 'Instala Happier en tu teléfono.',
        pairingPhoneStepScan: 'Abre la cámara y escanea el código.',
        pairingPhoneStepJoin: 'Deja esto abierto: tu teléfono se une en cuanto escanea.',
        pairingComputerTitle: 'Unirse desde otro ordenador',
        pairingComputerBody: ({ home }) => `Envía este enlace a tu otro ordenador. Al abrirlo en Happier se une a ${home}.`,
        pairingComputerStepInstall: 'Instala la app de escritorio en el otro ordenador.',
        pairingComputerStepOpen: 'Abre allí el enlace, o pégalo en Happier cuando pregunte cómo conectarse.',
        pairingComputerStepJoin: 'Deja esto abierto: el ordenador se une en cuanto abre el enlace.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Descargar la app',
        copyLink: 'Copiar enlace',
        waitingForPhone: 'Esperando a tu teléfono…',
        waitingForComputer: 'Esperando a tu ordenador…',
        newCodeIn: ({ time }) => `Nuevo código en ${time}`,
        makingCode: 'Creando un código…',
        addingDevice: ({ device }) => `Añadiendo ${device}…`,
        deviceJoined: ({ device, home }) => `${device} se unió a ${home}`,
        codeFailed: 'No se pudo crear un código para este Home.',
        codeFailedUnreachable: ({ home }) => `${home} no respondió a este dispositivo.`,
        codeFailedIdentity: ({ home }) => `Lo que este dispositivo sabe de ${home} no coincide con su respuesta; vuelve a conectarlo en Homes.`,
        codeFailedSignedOut: ({ home }) => `Este dispositivo no ha iniciado sesión en ${home}.`,
        codeFailedTooLarge: 'Tiene demasiadas direcciones para caber en un código.',
        codeFailedRefused: ({ home }) => `${home} rechazó la solicitud.`,
        codeFailedUnexpected: 'Algo salió mal; inténtalo de nuevo.',
        cancelCode: 'Cancelar código',
        newCode: 'Nuevo código',
        qrLabel: ({ home }) => `Código QR que añade un dispositivo a ${home}`,
        storeQrLabel: ({ store }) => `Código QR de Happier en ${store}`,
        getTheApp: 'Consigue la app',
        connectServicesTitle: ({ first, second }) => (second ? `Conecta ${first} o ${second}` : `Conecta ${first}`),
        connectServicesSubtitle: 'Usa el plan que ya pagas en todas tus máquinas y mira cuánto te queda.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "es">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { es: {
        open: ({ destination }) => `Abrir ${destination}`,
        refreshFailed: 'No se pudo actualizar',
        latestRunsTitle: 'Últimas ejecuciones',
        latestRunsLoading: 'Cargando las últimas ejecuciones',
        latestRunsEmptyTitle: 'Aún no hay ejecuciones',
        latestRunsEmptyReason: 'Cuando tus automatizaciones se ejecuten, aquí verás cómo fue cada ejecución.',
        latestRunsErrorTitle: 'No se pudieron cargar las últimas ejecuciones',
        latestRunsErrorReason: 'Tu Home no respondió. Comprueba la conexión y vuelve a intentarlo.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "es">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { es: {
        addHomeOrSignIn: 'Añadir un Home / Iniciar sesión',
        sheetDescription: 'Conecta este dispositivo a otro Home o encuentra los tuyos.',
        continueWithService: ({ service }) => `Continuar con ${service}`,
        continueWithThisHome: 'Continuar con este Home',
        continueWithServiceSubtitle: 'Encuentra tus Homes y haz que este esté disponible en tus otros dispositivos.',
        serviceUnavailable: ({ service }) => `${service} no está disponible en este momento.`,
        serviceUnsupported: ({ service }) => `${service} no ofrece inicio de sesión con cuenta.`,
        serviceUnavailableUnnamed: 'Tu servicio de inicio de sesión no está disponible en este momento.',
        serviceUnsupportedUnnamed: 'Tu servicio de inicio de sesión no ofrece inicio de sesión con cuenta.',
        scanOrPaste: 'Escanear o pegar un enlace de Home',
        scanOrPasteSubtitle: 'Únete a un Home con un código QR o un enlace.',
        createPersonalHome: 'Crear un Home personal en este ordenador',
        createPersonalHomeSubtitle: 'Ejecuta aquí un Home para tus propias máquinas y dispositivos.',
        opensFirst: 'Se abre primero',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "es">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const es: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Tus Homes están aquí",
        reconcileLead: "Este teléfono ahora sigue tus Homes juntos.",
        showMySessions: "Mostrar mis sesiones",
        scanComputerCode: "Escanea el código de tu ordenador",
        serviceLead: "Tus Homes se encuentran al iniciar sesión. Este teléfono los sigue a todos.",
        serviceAsHomeLead: ({ service }) => `Tus sesiones están en ${service}, siempre accesibles. Añade un ordenador para ejecutar agentes cuando quieras.`,
        factAlwaysOnDetail: "Accede a tus sesiones en cualquier momento.",
        factAgents: "Tus ordenadores ejecutan los agentes",
        factAgentsDetail: "Añade uno después con un código QR.",
        fromDeviceHelp: "Abre allí Ajustes → Añade tu teléfono y escanea el código con la cámara de este teléfono o pega el enlace del Home.",
        scan: "Escanear",
    },
    happierAccount: 'cuenta de Happier',
    serviceAccount: ({ service }) => `cuenta de ${service}`,

    alreadyUseTitle: '¿Ya usas Happier?',
    alreadyUseDescription: 'Encuentra tus Homes con tu cuenta o conéctate directamente a un Home que gestionas. Nada cambia en este ordenador hasta que elijas.',
    signIn: 'Iniciar sesión',
    withService: ({ service }) => `con ${service}`,
    changeServiceLabel: ({ service }) => `Servicio de inicio de sesión: ${service}. Cambiar`,
    connectToHome: 'Conectarse a un Home…',
    hostedPrompt: '¿Prefieres que esté alojado?',
    useServiceAsAHome: ({ service }) => `Usar ${service} como Home`,
    dismiss: 'Descartar',

    pathServiceTitle: ({ service }) => `Iniciar sesión con ${service}`,
    pathServiceSubtitle: 'Encuentra los Homes vinculados a tu cuenta',
    pathOtherServiceTitle: 'Iniciar sesión con otro servicio',
    pathOtherServiceSubtitle: 'Tu propio inicio de sesión o el de tu empresa',
    pathDirectTitle: 'Conectarse directamente a un Home',
    pathDirectSubtitle: 'Un enlace o una dirección · sin cuenta',

    serviceLead: 'Tus Homes aparecen juntos cuando inicias sesión. El Home personal de este ordenador se mantiene hasta que decidas.',
    defaultServiceFact: 'el servicio de inicio de sesión predeterminado',
    serviceMethodsHelp: ({ service }) => `Solo se muestran los métodos que ofrece ${service}. ¿Eres nuevo? Los mismos botones crean tu cuenta.`,

    otherServiceLead: 'Si tú o tu equipo gestionáis vuestro propio servicio de inicio de sesión, introduce su dirección. Happier comprueba qué ofrece antes de nada.',
    serviceAddressLabel: 'Dirección del servicio de inicio de sesión',
    serviceFound: 'Encontrado',
    useThisService: ({ service }) => `Iniciar sesión con ${service}`,
    addressIsNotAService: 'Esta dirección no ofrece inicio de sesión con cuenta. Si es un Home, conéctate a él directamente.',
    connectAsHome: 'Conectarse como Home',
    backToService: ({ service }) => `Volver a ${service}`,

    directLead: 'Para un Home que gestionas tú mismo, con o sin servicio de cuentas. No necesitas una cuenta de Happier.',
    fromDeviceLabel: 'Desde un dispositivo que ya está conectado',
    fromDeviceHelp: 'En él, abre Ajustes → Añadir tu teléfono y escanea su código con la cámara de este ordenador o pega su enlace de Home.',
    homeLinkLabel: 'Enlace de Home',
    homeLinkPlaceholder: 'Pega un enlace de Home',
    useCamera: 'Usar la cámara',
    openLink: 'Abrir',
    byAddressLabel: 'Por dirección',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Conectar',
    byAddressHelp: 'Happier comprueba que el Home responde y después inicias sesión con los métodos de ese Home.',
    notAHomeLink: 'Eso no es un enlace de Home. Vuelve a copiarlo desde el otro dispositivo.',
    homeUnreachable: 'Happier no ha podido llegar a ningún Home en esa dirección. Comprueba la dirección y que el Home esté en marcha.',

    anotherWay: 'Otra forma',
    homeReachable: 'Accesible',
    connected: 'Conectado',
    signInToHomeTitle: 'Iniciar sesión en este Home',
    signInToHomeLead: 'Estas son las formas que ofrece este Home.',

    reconcileTitle: 'Tus Homes están conectados',
    reconcileLead: ({ count }) => count === 1
        ? 'Este ordenador tiene ahora dos Homes. Aparecen juntos en Todos los Homes.'
        : `Este ordenador tiene ahora ${count + 1} Homes. Aparecen juntos en Todos los Homes.`,
    reconcileFound: 'Encontrados',
    reconcileThisComputer: 'Este ordenador',
    runSessionsIn: 'Ejecutar las sesiones de este ordenador en',
    runSessionsInDescription: 'Las sesiones nuevas iniciadas aquí se guardan en este Home.',
    removeEmptyPersonalHome: 'Eliminar el Home personal vacío',
    removeEmptyPersonalHomeDescription: 'Se creó al instalar Happier y todavía no contiene nada: ni sesiones, ni personas, ni equipos, ni invitaciones.',
    changeLater: 'Puedes cambiarlo más tarde en Ajustes → Homes.',
    keepBoth: 'Conservar ambos',
    useHome: ({ home }) => `Usar ${home}`,
    reconcileSetupTitle: 'Elige adónde van las sesiones de este ordenador',
    reconcileSetupSubtitle: ({ home }) => `Has conectado ${home}. Conserva ambos Homes o ejecuta allí las sesiones de este ordenador.`,
    reconcileSetupAction: 'Elegir…',

    serviceAsHomeTitle: ({ service }) => `Usar ${service} como tu Home`,
    serviceAsHomeLead: ({ service }) => `Tus sesiones y ajustes se guardan en ${service} en lugar de en este ordenador.`,
    factAlwaysOn: 'Siempre disponible',
    factAlwaysOnDetail: 'Tu teléfono llega a tus sesiones mientras este ordenador duerme.',
    factAgents: 'Este ordenador sigue ejecutando tus agentes',
    factAgentsDetail: 'No cambia nada de dónde se ejecuta el código.',
    storageE2ee: 'Cifrado de extremo a extremo',
    storageE2eeDetail: ({ service }) => `${service} guarda tus sesiones, pero no puede leerlas.`,
    storagePlain: ({ service }) => `Guardado por ${service}`,
    storagePlainDetail: 'Sin cifrado de extremo a extremo: el servicio puede leer lo que guarda.',
    storageE2eeByDefault: 'Cifrado de extremo a extremo por defecto',
    storagePlainByDefault: ({ service }) => `Guardado por ${service}, legible por defecto`,
    storageChoiceDetail: 'Lo eliges al crear tu cuenta.',
    removeEmptyOfferedDetail: 'Todavía no contiene nada. Solo se ofrece porque está vacío.',
    signInOrCreate: ({ account }) => `Inicia sesión o crea tu ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `¿Ya usas ${service} como tu Home? Al iniciar sesión se conecta directamente.`,

    addHomeTitle: 'Añadir un Home',
    addHomeDescription: 'Un Home guarda tus sesiones y ajustes. Conecta uno que ya uses o empieza uno nuevo en otro lugar.',
    addSignIn: ({ account }) => `Iniciar sesión con tu ${account}`,
    addSignInSubtitle: 'Encuentra los Homes que ya usas y conéctalos.',
    addServiceAsHomeSubtitle: 'Alojado para ti y siempre disponible.',
    addLinkOrQr: 'Conectarse con un enlace o un código QR',
    addLinkOrQrSubtitle: 'No necesitas cuenta. Obtenlo de un dispositivo que ya esté conectado.',
    addServerHome: 'Configurar un Home en un servidor',
    addServerHomeSubtitle: 'Una máquina de desarrollo o un VPS que controlas, configurado por SSH.',
    haveHomeAddress: '¿Tienes la dirección de un Home?',
    enterIt: 'Introdúcela',

    livesOnThisComputer: 'Está en este ordenador',
    availableWhileAwake: 'disponible mientras está activo',
    gettingReady: 'preparándose',
    noComputerYet: '¿Todavía no tienes ordenador?',
    aboutYourHome: 'Acerca de tu Home',

    nudgeTitle: ({ count }) => `Home inaccesible ${count} veces esta semana — ¿mover el Home?`,
    nudgeBody: 'Si este Home funciona en un ordenador que entra en reposo, moverlo a un servidor siempre encendido puede ayudar.',
    nudgeDismiss: 'Descartar para siempre en este dispositivo',
    moveHome: 'Mover el Home…',
    useService: ({ service }) => `Usar ${service}`,
};

const homesJourneysTranslations = { es } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "es">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "es"> = { es: {
        githubCurrentAccess: 'Acceso actual',
        githubCurrentAccessSubtitle: 'Necesario para las conexiones y las fuentes de directorio activadas que usan esta instalación.',
        githubCurrentAccessEmpty: 'Los servicios activados no requieren acceso.',
        githubSetupAccess: 'Acceso para configuración y reparación',
        githubSetupAccessSubtitle: 'Acceso para las conexiones configuradas, incluidas las desactivadas y las fuentes de directorio en pausa. Concede el acceso que falta en GitHub antes de activarlas o reanudarlas y vuelve a verificar la instalación.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Eliminar la instalación de ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "es"> = { es: {
        clientAuthenticationMethod: 'Autenticación del cliente', clientSecretPost: 'Cuerpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Guardar token de renovación', buttonColor: 'Color del botón de acceso', iconHint: 'Icono de acceso',
        allowRulesHint: 'Introduce un valor por línea. Déjalo vacío para no restringir.', brandingHint: 'Déjalo vacío para usar la apariencia de acceso predeterminada.', invalidScopes: 'Incluye openid en los ámbitos solicitados.', refreshFailed: 'No se pudo actualizar esta conexión', refreshFailedHint: 'Tus cambios se conservan. Reintenta para comprobar los cambios en el Home.',
    } };

const identityAdministrationTranslations = { es: build({ ...en, title: 'Proveedores de identidad', subtitle: 'Conexiones de acceso del Home disponibles para Teams.', homeConnections: 'Conexiones del Home', add: 'Añadir conexión', empty: 'No hay conexiones del Home', active: 'Activo', disabled: 'Desactivado', configuration: 'Configuración', issuer: 'URL del emisor', clientSecret: 'Secreto del cliente', secretSet: 'Configurado', secretNotSet: 'Sin configurar', secretRetain: 'Déjalo vacío para conservar el secreto actual.', advanced: 'Mostrar ajustes avanzados', hideAdvanced: 'Ocultar ajustes avanzados', test: 'Probar acceso', testing: 'Abriendo la prueba…', edit: 'Editar conexión', save: 'Guardar conexión', saving: 'Guardando…', enable: 'Activar conexión', disable: 'Desactivar conexión', remove: 'Eliminar conexión', createTitle: 'Añadir proveedor de identidad', editTitle: 'Editar proveedor de identidad', displayName: 'Nombre', required: 'Completa los campos obligatorios.', invalidIssuer: 'Introduce una URL HTTPS válida.', secretRequired: 'Introduce un secreto del cliente.', error: 'El cambio no se realizó.', accounts: 'Accounts afectados', connections: 'Conexiones de Team', errorForbidden: 'Ya no tienes permiso para esto. No se cambió nada.', errorConflict: 'Otra persona lo cambió antes. Tus ediciones se conservan: recarga y vuelve a intentarlo.', errorMissing: 'Esto ya no existe. Puede que alguien lo haya eliminado.', errorInUse: 'Algo todavía depende de esto. Elimínalo primero.', errorProviderUnavailable: 'El servicio de identidad no respondió. No se cambió nada.', errorRateLimited: 'El proveedor pidió esperar antes de reintentar.', errorInvalid: 'El Home rechazó estos valores. Revisa la configuración e inténtalo de nuevo.', errorImmutable: 'Este valor queda fijo cuando el registro está en uso. Crea uno nuevo.', errorAuthenticationRequired: 'Vuelve a iniciar sesión en este Team y reintenta. No se cambió nada.', errorPolicyUnavailable: 'La política de autenticación del Team no se puede evaluar ahora. No se cambió nada.', errorPolicyInUse: 'La política de autenticación del Team aún depende de esta conexión.', errorNotAllowed: 'Este Home no permite que los Teams configuren esto. No se cambió nada.', errorNeedsAttention: 'La sincronización del directorio requiere atención. Ejecuta una sincronización completa.', errorSyncPaused: 'Esta fuente está en pausa. «Reanudar sincronización» inicia una nueva sincronización completa.', alternateLogins: 'Accounts que necesitan otro método de acceso', recoveryAuthenticationPolicy: 'Abrir autenticación del Team', recoveryAlternateLogin: 'Da primero otro método de acceso a esas Accounts', recoveryDirectory: 'Abrir directorio', recoveryGroupMappings: 'Abrir asignaciones de Grupos', recoveryTeamAuthentication: 'Volver a iniciar sesión', callbackUrl: 'URL de retorno', callbackUrlHint: 'Registra esta URL en tu proveedor de identidad.' }, githubAccessWords.es, oidcEditorWords.es) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const es: typeof en = {
    pageDescription: 'Todo lo que te espera, agrupado por el trabajo al que pertenece.',
    tabs: { a11y: 'Vista de la bandeja', needsYou: 'Te necesita', updates: 'Novedades' },
    groups: {
        unknownLead: 'Sesión',
        leadMeta: ({ count }) => (count === 1 ? '1 subsesión' : `${count} subsesiones`),
        runMeta: 'Ejecución de flujo de trabajo',
        otherTitle: 'Otras sesiones',
        otherMeta: 'No forman parte de un orquestador ni de una ejecución',
        openSession: 'Abrir sesión',
        openRun: 'Abrir ejecución',
    },
    rows: {
        step: 'Paso',
        workflowRun: 'Ejecución de flujo de trabajo',
        review: 'Revisar',
        stalled: 'Detenida',
        stalledReason: 'Su máquina se desconectó a mitad del turno',
        landing: 'Pendiente de fusionar',
        settle: 'Cerrar',
        snoozedUntil: ({ time }) => `Pospuesta hasta ${time}`,
        more: 'Más acciones',
    },
    popover: {
        moreInOther: ({ count }) => `${count} más en Otras sesiones`,
        updates: ({ count }) => (count === 1 ? '1 novedad' : `${count} novedades`),
    },
    empty: {
        title: 'Nada te necesita',
        description: 'Aquí llegan las solicitudes de permiso, las revisiones y todo lo que un orquestador o un flujo de trabajo espera de ti.',
    },
    updatesEmpty: {
        title: 'Sin novedades',
        description: 'Aquí llegan las sesiones terminadas y las solicitudes de amistad.',
    },
    stale: { reason: 'No se pudieron actualizar las ejecuciones de flujos de trabajo', retry: 'Reintentar' },
    settleFailed: 'No se pudo cerrar esta sesión',
};

const inboxWorkTranslations = { es };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { es: {
        browse: 'Explorar…',
        browseField: ({ field }) => `Explorar para ${field}`,
        unavailable: 'El plugin que ofrece esta opción no está disponible. Se conserva tu valor actual.',
        retired: 'El plugin se actualizó mientras elegías. Inténtalo de nuevo.',
        invalid: 'Esa opción no se puede usar aquí. Se conserva tu valor actual.',
        failed: 'No se pudo abrir el selector. Inténtalo de nuevo.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "es">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { es: { newMachine: 'Nueva máquina', waiting: 'Esperando a que se conecte', connected: 'Conectada', failed: 'No se pudo añadir esta máquina', cancelled: 'Cancelado', cannotReachHost: 'No se puede acceder al host. Comprueba la dirección y el acceso SSH.', choosePath: 'Elige cómo añadir una máquina', switchHome: 'Vuelve a este hogar para continuar' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "es">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const es: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Sesión iniciada con ${label}`,
    signedInAs: ({ label }) => `Sesión iniciada como ${label}`,
    signedInHere: 'Sesión iniciada en esta máquina',
    updateTo: ({ version }) => `Actualizar a ${version}`,
    needsSignIn: 'Requiere iniciar sesión',
    waitingForSignIn: 'Esperando el inicio de sesión en la terminal…',
    notInstalled: 'No instalado',
    downloadSize: ({ size }) => `Descarga de ${size}`,
    installYourself: 'Instálalo tú mismo',
    unsupportedOs: 'No funciona en este sistema',
    unsupportedArch: 'No hay versión para este procesador',
    installing: 'Instalando…',
    progress: ({ done, total }) => `${done} de ${total}`,
    checking: 'Comprobando…',
    offlineSignedIn: 'Última vez con sesión iniciada · máquina sin conexión',
    offlineSignedOut: 'Última vez sin sesión · máquina sin conexión',
    offlineNotInstalled: 'No instalado la última vez · máquina sin conexión',
    offlineUnknown: 'Máquina sin conexión',
    unknown: 'No se pudo comprobar esta máquina',
    actionInstall: 'Instalar',
    actionUpdate: 'Actualizar',
    actionSignIn: 'Iniciar sesión',
    actionRetry: 'Reintentar',
    actionCancel: 'Cancelar',
    actionShowTerminal: 'Mostrar terminal',
    actionGuide: 'Guía de instalación',
    installLeadManaged: ({ agent, machine }) => `Happier instala ${agent} en ${machine} solo para Happier. Tu configuración de terminal no cambia.`,
    installLeadVendor: ({ agent, machine }) => `Happier ejecuta el instalador de ${agent} en ${machine}.`,
    installAlsoDownloads: ({ what }) => `También descarga ${what}, que usan las sesiones.`,
    installThenSignIn: 'Después inicias sesión.',
    installAgent: ({ agent }) => `Instalar ${agent}`,
    installMyself: 'Lo instalaré yo',
    manualLead: ({ agent, machine }) => `Happier no puede instalar ${agent} por ti. Instálalo en ${machine} con su guía y vuelve a comprobar.`,
    checkAgain: 'Comprobar de nuevo',
    closeNote: ({ machine }) => `Puedes cerrarlo; sigue en ${machine}.`,
    stepCheck: 'Comprobar que funciona',
    stepSignIn: 'Iniciar sesión',
    failedKept: 'No se ha dejado nada a medio instalar.',
    installedLine: ({ agent, version }) => `${agent} ${version} está instalado`,
    nowSignIn: 'ahora inicia sesión',
    signInHow: ({ agent }) => `Cómo inicia sesión ${agent}`,
    useService: ({ service }) => `Usar tu ${service}`,
    recommended: 'Recomendado',
    serviceConnected: ({ profile }) => `${profile} · ya conectado · funciona en todas las máquinas`,
    serviceNotConnected: 'Conéctalo una vez; todas las máquinas pueden usarlo.',
    connect: 'Conectar',
    signInOn: ({ machine }) => `Iniciar sesión en ${machine}`,
    signInOnDetail: ({ agent }) => `Ejecuta el inicio de sesión de ${agent} en una terminal allí. Solo esa máquina lo usa.`,
    noNativeLogin: ({ agent }) => `${agent} no tiene inicio de sesión propio: usa una clave de API o una cuenta conectada. Conéctala una vez y todas las máquinas podrán usarla.`,
    openSignInTerminal: 'Abrir el inicio de sesión en la terminal',
    useThisAccount: 'Usar esta cuenta',
    waitingLead: ({ agent, machine }) => `El inicio de sesión de ${agent} está abierto en la terminal de ${machine}. Quedará listo en cuanto indique que has iniciado sesión.`,
    readyLine: ({ agent, machine }) => `${agent} está listo en ${machine}`,
    startSessionWith: ({ agent }) => `Iniciar una sesión con ${agent}`,
    setUpAnother: 'Configurar otro agente',
    unsupportedLead: ({ agent, machine }) => `${agent} no tiene versión para ${machine}, así que no puede funcionar allí.`,
    setupTitle: ({ agent }) => `Configurar ${agent}`,
    signInTitle: ({ agent }) => `Iniciar sesión en ${agent}`,
    readyTitle: ({ agent }) => `${agent} está listo`,
    notOnMachineYet: ({ machine }) => `Aún no está en ${machine}`,
    onMachine: ({ machine }) => `En ${machine}`,
    installingOn: ({ machine }) => `Instalando en ${machine}`,
    cantRunOn: ({ machine }) => `No funciona en ${machine}`,
    terminalTab: ({ agent }) => `Inicio de sesión · ${agent}`,
    panelLead: 'Termina en el navegador que se abrió. ¿Otro dispositivo? Abre el enlace allí.',
    open: 'Abrir',
    openSignInPage: 'Abrir la página de inicio de sesión',
    waitingEllipsis: 'Esperando el inicio de sesión…',
    signedInAlready: '¿Ya iniciaste sesión?',
    closeTerminal: 'Cerrar terminal',
    showTheTerminal: 'Mostrar la terminal',
    phoneLead: ({ agent, machine }) => `${agent} te pide iniciar sesión. Abre la página aquí, termina y ${machine} lo recogerá.`,
    panelSignedInAs: ({ account }) => `Sesión iniciada como ${account}.`,
    panelChecked: 'Happier lo comprobó hace un momento.',
    sectionTitle: 'Agentes',
    sectionDescription: 'Los agentes de programación de esta máquina y cómo inicia sesión cada uno.',
    addTitle: 'Añadir un agente',
    addMore: ({ count }) => (count === 1 ? `1 más funciona aquí` : `${count} más funcionan aquí`),
    showAll: 'Mostrar todos',
    showFewer: 'Mostrar menos',
    emptyInstalled: 'Esta máquina aún no tiene agente. Elige uno abajo; Happier lo instala y te conecta.',
    offlineNote: ({ machine }) => `${machine} está sin conexión. Esto es lo último que informó.`,
    firstTitle: 'Configura tu primer agente',
    firstLead: ({ machine }) => `${machine} está conectado, pero aún no tiene agente. Elige uno; Happier lo instala y te conecta.`,
    firstMore: ({ count }) => (count === 1 ? `O elige entre 1 agente más.` : `O elige entre ${count} agentes más.`),
    allAgents: 'Todos los agentes',
    setUp: 'Configurar',
    choiceUsesService: ({ service, profile }) => `Usa tu ${service}. Conectado: ${profile}.`,
    choiceSignsInOn: 'Inicia sesión en la máquina.',
    dismissFirst: 'Ocultar «Configura tu primer agente»',
    dismissTooltip: 'Ocultar · restáuralo desde Personalizar',
    chooseAgent: 'Elige un agente',
    blockNotInstalled: ({ agent, machine }) => `${agent} aún no está en ${machine}.`,
    blockSetUpToStart: 'Configúralo para empezar.',
    blockSignedOut: ({ agent, machine }) => `${agent} necesita iniciar sesión en ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} no está instalado en ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} no tiene sesión en ${machine}.`,
    draftKept: 'Tu mensaje se conserva.',
    alreadySetUp: ({ machine, home }) => `${machine} ya está conectado a ${home}`,
    startSession: 'Iniciar una sesión',
    openMachine: ({ machine }) => `Abrir ${machine}`,
};

const machineAgentsTranslations = { es: es } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "es">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { es: translated({
        machineDetailPage: {
            description: 'Inicia sesiones aquí y mira qué se ejecuta en esta máquina.',
            placeholderTitle: 'Máquina',
            online: 'En línea',
            offline: 'Sin conexión',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Sustituida por ${machine}`,
            unavailableTitle: 'Esta máquina no puede iniciar sesiones ahora mismo',
            startAction: 'Iniciar sesión',
            tmuxSectionDescription: 'Cómo usan tmux las nuevas sesiones de esta máquina.',
            windowsSectionDescription: 'Cómo se abren las sesiones remotas en esta máquina.',
            clisSectionDescription: 'CLI de agentes que Happier encontró en esta máquina y las herramientas que puede instalar.',
            runsSectionDescription: 'Procesos que las sesiones iniciaron en esta máquina.',
            recentSessionsTitle: 'Sesiones recientes',
            recentSessionsDescription: 'Las cinco sesiones más recientes de esta máquina.',
            daemonSectionDescription: 'El servicio en segundo plano que conecta esta máquina con Happier.',
            stopDaemonDescription: 'Las sesiones en curso siguen funcionando. No se pueden iniciar nuevas hasta que lo reinicies en esta máquina.',
            stopDaemonAction: 'Detener',
            detailsTitle: 'Detalles de la máquina',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const es = {
    machinesSection: "Máquinas",
    tierPrimaryDescription: "Se prueba primero.",
    tierFallbackDescription: "Se prueba cuando ninguna máquina anterior está en línea.",
    pauseMember: "Pausar para sesiones nuevas",
    resumeMember: "Usar para sesiones nuevas",
    pausedState: "En pausa",
    memberMenu: "Opciones de la máquina",
    newPoolTitle: "Nuevo grupo de máquinas",
    title: "Pools de máquinas",
    myTitle: "Mis pools de máquinas",
    add: "Agregar grupo de máquinas",
    benefit: "Elija una máquina preferida, con otras disponibles como alternativa.",
    placementChangeNotice: "Los cambios se aplican a las sesiones que empiecen después de guardar. Las sesiones abiertas se quedan en su máquina.",
    connectionSemantics: "Se elige una máquina al abrir una conexión y permanece seleccionada para esa conexión. Una conexión posterior puede elegir otra máquina.",
    noMembers: "Aún no hay máquinas en este grupo",
    unavailable: "Indisponible",
    memberRevoked: "Revocado",
    memberReplaced: "Reemplazado",
    memberTemporary: "Temporario",
    availabilityUnknown: "Disponibilidad de conexión desconocida",
    notVerified: "No verificado",
    brokerUnavailable: "No hay intermediarios disponibles",
    brokerAvailable: ({ count }: { count: number }) => `${count} disponibles`,
    basics: "Detalles",
    name: "Nombre",
    description: "Descripción (opcional)",
    descriptionTitle: "Descripción",
    addMachines: "Agregar máquinas",
    noMachines: "No hay máquinas persistentes disponibles en este Home.",
    allMachinesAdded: "Todas las máquinas de este Home ya están en este grupo.",
    primary: "Primario",
    addFallback: "Agregar respaldo",
    moveTo: "Mover a",
    moveTierEarlier: "Mover este nivel antes",
    moveTierLater: "Mover este nivel más tarde",
    removeMember: "Quitar del grupo",
    enableMember: "Usar para futuras selecciones",
    save: "Guardar cambios",
    create: "Crear grupo",
    delete: "Eliminar grupo de máquinas",
    deleteTitle: "¿Eliminar este grupo de máquinas?",
    deleteBody: "Cualquier recurso de credenciales que use este pool perderá su ubicación de bróker y deberán repararse. Esto afecta a futuras selecciones; no elimina máquinas ni detiene sesiones en curso.",
    saveFailed: "No se pudo guardar este grupo de máquinas. Tus cambios todavía están aquí.",
    deleteFailed: "No se pudo eliminar este grupo de máquinas. Inténtalo de nuevo.",
    conflictTitle: "Este grupo cambió en otra parte",
    conflictBody: "Se conservan los cambios no guardados. Vuelva a cargar la versión guardada para revisar los últimos cambios.",
    conflictNoReload: "La identidad del grupo ya no está disponible. Se conservan los cambios no guardados.",
    homeOffline: "Este Home está sin conexión. Los cambios en pools estarán disponibles cuando vuelva a conectarse.",
    refreshFailed: "No se pudieron actualizar los pools de máquinas. Se muestra la última lista conocida.",
    featureUnavailable: "Los pools de máquinas no están disponibles en este Home. Actualízalos o actívalos en el Home para continuar.",
    openSettings: "Configuración del grupo de máquinas",
    pickSpecificMachine: "Elegir una máquina específica",
    poolNotFound: "Este grupo de máquinas ya no está disponible.",
    reload: "Recargar la versión guardada",
    reloadTitle: "¿Descartar los cambios no guardados?",
    reloadBody: "La recarga reemplaza este formulario con la última versión guardada.",
    privacy: "El servidor de este Home puede leer los nombres, las descripciones y los miembros de los pools, incluso en cuentas con cifrado de extremo a extremo.",
    nameRequired: "Ingrese un nombre antes de guardar.",
    memberNotEligible: "Algunas máquinas ya no pueden pertenecer a este grupo.",
    memberNotEligibleDetail: "Elimine esta máquina o elija otra máquina persistente.",
    resolvingTarget: "Elegir una máquina de este grupo…",
    resolveEmpty: "Este grupo no tiene máquinas habilitadas.",
    resolveNoAvailable: "Ninguna máquina en este grupo está disponible actualmente.",
    resolvePresenceUnavailable: "La disponibilidad de la máquina se desconoce temporalmente.",
    resolveFailed: "Happier no pudo elegir una máquina de este grupo. Inténtalo de nuevo.",
    executionMachine: "Ejecutar en",
    chosenFrom: "Elegido de",
    aMachinePool: "Un pool de máquinas",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} de ${enabled} habilitadas conectadas`,
    fallback: ({ number }: { number: number }) => `Alternativa ${number}`,
};

const machinePoolTranslations = { es };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const es: McpSettingsCopy = {
    purpose: 'Servidores de herramientas que tus agentes pueden usar en las sesiones. Añade un servidor una vez y elige dónde se aplica.',
    add: 'Añadir servidor MCP',
    addConfigure: 'Configurar un servidor',
    addConfigureDescription: 'Introduce su comando o dirección',
    addImportJson: 'Pegar una configuración JSON',
    addImportJsonDescription: 'Desde un README u otra app',
    addOwnCategory: 'Añadir el tuyo',
    addPresetCategory: 'Instalación rápida',
    addFromMachine: 'Importar desde esta máquina',
    addFromMachineDescription: 'Servidores que otros agentes ya usan',
    searchPlaceholder: 'Buscar servidores',
    toolsGroup: 'Herramientas',
    unbound: 'Aún no se usa en ningún sitio',
    newServer: 'Nuevo servidor MCP',
    serverPurpose: 'Un servidor de herramientas que tus agentes pueden usar. Elige abajo dónde se aplica.',
    addByTitle: 'Añadir mediante',
    serverSection: 'Servidor',
    serverSectionDescription: 'Cómo se llama el servidor en las sesiones y en esta lista.',
    connectionSection: 'Conexión',
    connectionSectionDescription: 'Cómo inicia o alcanza Happier el servidor.',
    envDescription: 'Valores que se pasan al servidor. Usa un secreto guardado para las claves.',
    headersDescription: 'Se envían con cada solicitud. Usa un secreto guardado para los tokens.',
    addRule: 'Añadir regla',
    discardDraft: 'Descartar',
    landingTitle: 'Dale más herramientas a tus agentes',
    landingDescription: 'Los servidores MCP añaden herramientas como un navegador, búsqueda de documentación o GitHub. Configura uno, pega una configuración o empieza con un preajuste.',
    onMachineTitle: 'Encontrados en esta máquina',
    onMachinePurpose: 'Servidores MCP que otros agentes ya configuran en esta máquina. Importa uno para usarlo desde Happier.',
    onMachineSearchSection: 'Dónde buscar',
    onMachineSearchDescription: 'Configuraciones de agentes en tu carpeta personal y, si eliges una, en una carpeta de proyecto.',
    onMachineFoundSection: 'Servidores',
    onMachineFoundDescription: 'Importar copia el servidor en Happier; la configuración original no cambia.',
    previewTitle: 'Qué reciben las sesiones',
    previewPurpose: 'Comprueba qué servidores MCP recibe una sesión para un agente y una carpeta, y qué pasa cuando uno no puede iniciarse.',
    previewContextSection: 'Sesión',
    previewContextDescription: 'El agente y la carpeta con los que empezaría una nueva sesión.',
    failurePolicyTitle: 'Cuando un servidor no puede iniciarse',
    failurePolicyDescription: 'Por ejemplo, cuando falta un secreto guardado que necesita.',
    failurePolicySkip: 'Omitirlo',
    failurePolicyStop: 'Detener la sesión',
    failureSection: 'Fiabilidad',
    failureSectionDescription: 'Se aplica a todos los servidores MCP en todas las sesiones.',
    previewNothingTitle: 'No se entregaría nada',
    previewNothingDescription: 'Ningún servidor MCP se aplica a este agente y carpeta. Añade un servidor o una regla que los cubra.',
    check: 'Comprobar',
    scan: 'Buscar',
};

const mcpSettingsTranslations = { es } as const;

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

const es: DesktopTrayTranslation = {
    open: 'Abrir Happier',
    openInHappier: 'Abrir en Happier',
    settings: 'Ajustes…',
    startAtLogin: 'Iniciar al acceder',
    quit: 'Salir de Happier',
    stopServicesAndQuit: 'Detener servicios en segundo plano y salir…',
    sessions: ({ count }: CountParams) => `${count} en curso`,
    start: 'Iniciar',
    restart: 'Reiniciar',
    stop: 'Detener…',
    userOwned: 'Gestionado fuera de Happier',
    checking: 'Comprobando servicios en segundo plano…',
    readFailed: 'No se pudieron comprobar los servicios en segundo plano',
    incomplete: 'Algunos servicios en segundo plano no se pudieron comprobar',
    noServices: 'Este ordenador aún no está configurado',
    working: 'Trabajando…',
    stopConfirmTitle: ({ relay }: RelayParams) => `¿Detener el servicio en segundo plano de Happier para ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Las sesiones de agente que se ejecutan en este ordenador para ${relay} terminarán, y tu teléfono y tu navegador no podrán acceder a él allí hasta que el servicio vuelva a iniciarse.`,
    stopAllConfirmTitle: '¿Detener los servicios en segundo plano de Happier y salir?',
    stopAllConfirmBody: 'Las sesiones de agente de este ordenador terminarán, y tu teléfono y tu navegador no podrán acceder a él hasta que sus servicios en segundo plano vuelvan a iniciarse.',
    stopConfirmAction: 'Detener',
    actionFailedTitle: 'No se pudo completar',
    loginItemFailed: 'No se pudo actualizar el elemento de inicio de Happier',
    quitStopTitle: 'Todavía hay sesiones de agente en ejecución',
    quitStopBody: 'Al salir se detienen los servicios en segundo plano de este ordenador y terminan las sesiones que se ejecutan aquí.',
    quitStopUnknownTitle: '¿Detener los servicios en segundo plano?',
    quitStopUnknownBody: 'Happier no puede ver qué sesiones se están ejecutando en este ordenador. Al salir se detienen sus servicios en segundo plano y terminan las que haya.',
    quitStopConfirm: 'Detener de todos modos',
    quitStopKeep: 'Dejarlos en marcha',
    quitStopFailedTitle: 'Algunos servicios en segundo plano no se detuvieron',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier permanece abierto para que puedas comprobar los servicios en segundo plano e intentarlo de nuevo.`,
};

const esLoginStart: DesktopLoginStartTranslation = {
    title: 'Iniciar al acceder',
    subtitle: 'Mantiene este ordenador accesible desde tu teléfono y tu navegador: sus servicios en segundo plano se inician al acceder y siguen funcionando después de salir de Happier. Si está desactivado, salir de Happier los detiene.',
    unknown: 'Happier aún no sabe si los servicios en segundo plano de este ordenador se inician al acceder.',
    notSetUp: 'Disponible cuando este ordenador esté configurado.',
};

const menuBarModeTranslations = { es: { tray: es, loginStart: esLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { es: {
        email: 'Correo electrónico',
        password: 'Contraseña',
        signIn: 'Iniciar sesión',
        title: 'Correo y contraseña',
        forgotPassword: '¿Olvidaste la contraseña?',
        capsLock: 'Bloq Mayús está activado',
        emailRequired: 'Introduce tu dirección de correo electrónico.',
        passwordRequirements: 'Usa al menos 15 caracteres, hasta 1.024 bytes UTF-8. Se permiten espacios.',
        unavailable: 'El inicio de sesión con correo y contraseña no está disponible en este Home.',
        rateLimited: 'Demasiados intentos. Espera un momento y vuelve a intentarlo.',
        emailInvalid: 'Introduce una dirección de correo válida.',
        passwordMalformed: 'Esta contraseña contiene caracteres que no podemos guardar de forma segura. Vuelve a escribirla.',
        passwordMismatch: 'Las contraseñas no coinciden.',
        currentPasswordRequired: 'Introduce tu contraseña actual.',
        currentPassword: 'Contraseña actual',
        newPassword: 'Nueva contraseña',
        confirmPassword: 'Confirmar contraseña',
        signInFailed: 'Esa combinación de correo y contraseña no funcionó.',
        accountDisabledHere: 'Esta cuenta está deshabilitada en este Home. Pide a una administración del Home que vuelva a habilitarla.',
        notEligible: 'Esta cuenta no puede iniciar sesión en este Home ahora mismo.',
        linkExpired: 'Este enlace caducó o ya se usó. Solicita uno nuevo.',
        revisionConflict: 'Tu contraseña cambió en otro lugar. Vuelve a cargar e inténtalo de nuevo.',
        serverUnavailable: 'Este Home no pudo completar la solicitud. Inténtalo de nuevo en breve.',
        offline: 'Sin conexión con este Home. Revisa tu red e inténtalo de nuevo.',
        homeUnreachable: 'No se pudo contactar con este Home. Inténtalo de nuevo.',
        securityFactUnavailable: 'No se pudo leer desde tu Home.',
        cancelled: 'Se canceló ese intento.',
        approvalPending: 'Pendiente de tu aprobación. Revísala en la bandeja de aprobaciones y vuelve aquí.',
        outcomeUnconfirmed: 'No pudimos confirmar si el cambio se aplicó. Actualizamos esta cuenta: compruébala antes de volver a intentarlo.',
        recoveryKeyRequired: 'Introduce tu clave de recuperación para cambiar la contraseña de esta cuenta cifrada de extremo a extremo. La clave no sale de este dispositivo.',
        working: 'Trabajando…',
        showPassword: 'Mostrar contraseña',
        hidePassword: 'Ocultar contraseña',
        createTitle: 'Crea tu cuenta',
        createAccount: 'Crear cuenta',
        accountProtection: 'Protección de la cuenta',
        protectionPlain: 'Legible por el Home',
        protectionPlainDetail: 'Tu Home puede leer tus datos. Si olvidas la contraseña, puedes restablecerla por correo.',
        protectionE2ee: 'Cifrado de extremo a extremo',
        protectionE2eeDetail: 'Solo tus dispositivos pueden leer tus datos. Guarda tu clave de recuperación: restablecer la contraseña no basta para recuperarlos.',
        checkYourEmail: 'Revisa tu correo',
        resend: 'Enviar de nuevo',
        resent: 'Enviado de nuevo. Revisa tu correo.',
        useDifferentEmail: 'Usar otro correo',
        connectTitle: 'Añadir correo y contraseña',
        connectFromSecurity: 'Inicia sesión con un método que ya uses y luego añade correo y contraseña en Seguridad de la cuenta.',
        signInFirst: 'Iniciar sesión primero',
        forgotTitle: '¿Olvidaste tu contraseña?',
        forgotExplanation: 'Podemos enviarte instrucciones por correo, o puedes usar la clave de recuperación que guardaste al crear la cuenta.',
        emailResetInstructions: 'Enviarme instrucciones por correo',
        useRecoveryKey: 'Usar tu clave de recuperación',
        recoveryKeyDownload: 'Descargar clave de recuperación',
        recoveryKeyLater: 'Hacerlo más tarde',
        securitySectionTitle: 'Correo y contraseña',
        signInEmail: 'Correo de inicio de sesión',
        signInEmailNotSet: 'Sin configurar',
        passwordEnrolled: 'Configurada',
        passwordNotEnrolled: 'Sin configurar',
        passwordSetUp: 'Tu contraseña está configurada para este Home.',
        passwordChanged: 'Tu contraseña se ha cambiado.',
        passwordRemoved: 'Tu contraseña se ha eliminado.',
        changePassword: 'Cambiar contraseña',
        removePassword: 'Quitar contraseña',
        removePasswordSubtitle: 'Inicia sesión solo con tus otros métodos',
        removePasswordConsequence: 'Tu correo y contraseña ya no te permitirán iniciar sesión en este Home. Tus otros métodos y tus datos no cambian.',
        changeEmailExplanation: 'Enviaremos un correo a la nueva dirección para confirmarla. Tu correo actual sigue funcionando hasta que la confirmes.',
        sendVerification: 'Enviar correo de confirmación',
        verifyTitle: 'Confirma tu correo',
        verifyGeneric: 'Este enlace confirma el control de un buzón.',
        verifyReturnToCreate: 'Vuelve a este Home para terminar de crear tu cuenta con esta dirección.',
        addressVerified: 'Esta dirección está confirmada.',
        confirmEmailChange: 'Usar como mi correo de inicio de sesión',
        signInToConfirm: 'Inicia sesión en este dispositivo para confirmar el cambio.',
        returnToSignIn: 'Volver al inicio de sesión',
        continue: 'Continuar',
        resetTitle: 'Establece una nueva contraseña',
        resetChooseNew: 'Elige una nueva contraseña para este Home.',
        resetComplete: 'Tu contraseña se cambió. Inicia sesión de nuevo con la nueva contraseña.',
        resetSignsOutOtherDevices: 'Establecer una nueva contraseña cierra la sesión de esta cuenta en todos los demás sitios.',
        setNewPassword: 'Guardar nueva contraseña',
        emailPlaceholder: 'tu@ejemplo.com',
        accountDisabled: ({ home }: { home: string }) => `Esta cuenta está deshabilitada en ${home}. Pide a una administración del Home que vuelva a habilitarla.`,
        verificationSent: ({ email }: { email: string }) => `Enviamos un enlace de confirmación a ${email}. Ábrelo para terminar de crear tu cuenta.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Si ${email} puede iniciar sesión aquí, las instrucciones de restablecimiento ya van en camino.`,
        verificationPending: ({ email }: { email: string }) => `Confirmación enviada a ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Este enlace confirma ${email}.`,
        passwordNeedsEmail: 'Primero añade un correo de inicio de sesión',
        passwordNeedsEmailHint: 'Empieza por tu correo de inicio de sesión',
        setupStepConfirm: 'Confirmar',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Paso ${step} de ${total}: ${label}`,
        setupEmailHint: 'El correo de inicio de sesión y la contraseña se añaden juntos. Primero enviaremos un enlace para confirmar la dirección.',
        setupConfirmHint: 'Abre el enlace de ese correo para elegir tu contraseña.',
        setupPasswordHint: 'Introduce el correo que confirmaste y elige tu contraseña.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { es: { customize: 'Personalizar…', title: 'Navegación', description: 'Elige qué se muestra, va a Más o se oculta. Arrastra para ordenar. Se guarda en este dispositivo.', pinned: 'Fijado', overflow: 'Más', hidden: 'Oculto', reset: 'Restablecer', appRail: 'Barra izquierda', sessionRail: 'Barra de sesión', workspaceRail: 'Barra del espacio de trabajo', sessionTabBar: 'Pestañas del teléfono' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "es">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const es: typeof en = {
    nextWithCount: ({ count }) => `${count} te ${count === 1 ? 'necesita' : 'necesitan'}`,
    next: 'Siguiente', answeredElsewhere: 'Ya se respondió',
    unavailableTitle: 'No se pudo abrir la siguiente solicitud',
    unavailableBody: 'Algunas sesiones pendientes no están disponibles. Vuelve a conectarte e inténtalo de nuevo.',
    skippedUnavailable: ({ count }) => `Se omitieron ${count} sesiones no disponibles.`,
    waitsForPermission: 'pide tu permiso', waitsForInput: 'espera tu respuesta',
    sessionsWaiting: ({ count }) => `${count} sesiones esperan`, go: 'Ir', dismiss: 'Ahora no',
};

const pendingNavigationTranslations = { es };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { es: {
        blocked: {
            runtime_unhealthy: 'Tu Home local necesita atención antes de poder iniciarse.',
            home_auth_invalid: 'La autenticación de tu Home necesita atención.',
            existing_runtime: 'Debes elegir qué hacer con el Home local existente antes de continuar la configuración.',
            existing_runtime_credentials: 'Este Home local pertenece a otra app de Happier en este ordenador.',
            personal_home_erased: 'Tu Home personal se eliminó. Inténtalo de nuevo para crear uno nuevo.',
        },
        blockedBody: { personal_home_erased: 'Se eliminaron los datos de tu Home. Aquí no queda nada que recuperar; crea un Home personal nuevo o usa otro Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "es">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const es: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Esta dirección del Home personal corresponde a más de un Home guardado.',
    signedInHome: {
        status: 'Ya has iniciado sesión en otro Home.',
        body: ({ home }: HomeParams) => `Este ordenador tiene la sesión iniciada en ${home}. Sigue usándolo o configura aquí un Home personal.`,
        keep: ({ home }: HomeParams) => `Seguir usando ${home}`,
        keepDetail: 'Tus sesiones y máquinas se quedan exactamente como están.',
        create: 'Configurar un Home personal',
        createDetail: 'Crea un Home privado en este ordenador y cámbiate a él.',
    },
    existingRuntimeCredentials: {
        body: 'Esta app no puede abrirlo sin la clave de recuperación de ese Home. Inicia sesión con la clave o usa otro Home.',
        signIn: 'Iniciar sesión con una clave de recuperación',
        signInDetail: 'Usa la clave de recuperación guardada para este Home local.',
    },
};

const personalHomeDecisionTranslations = { es };

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

const es = {
    standardOnlyTitle: 'Solo conexión estándar',
    standardOnlySubtitle: 'Las conexiones nuevas en este dispositivo usan rutas estándar. Las transferencias en curso terminan en su ruta actual.',
    installOrUpdateAction: 'Instalar o actualizar el Home personal', startAction: 'Iniciar el Home personal', stopAction: 'Detener el Home personal',
    defaultHomeLabel: 'Home personal', homeTitle: 'Home', canonicalAddress: 'Dirección del Home', identityComparison: 'Home actual', identityComparisonMatch: 'Coincide', identityComparisonMismatch: 'No coincide', identityComparisonUnknown: 'No se pudo confirmar',
    unknownSize: 'Tamaño desconocido', unknownTimestamp: 'Marca de tiempo desconocida', restoreBackupTitle: 'Copia de seguridad', identityTitle: 'Identidad del Home', identityUnavailable: 'Identidad no disponible', restoreBackupDate: 'Creado', restoreCompatibility: 'Compatibilidad', restoreCompatible: 'Compatible', restoreCompatibilityVerified: 'Verificado por esta versión', restoreBackupSize: 'Tamaño', restoreReplacementNotice: 'Se reemplazarán los datos actuales del Home. Se conservará una copia de recuperación verificada.', restoreConfirmTitle: '¿Reemplazar y restaurar este Home personal?', restoreConfirmAction: 'Reemplazar y restaurar', relocateConfirmTitle: '¿Mover este Home personal?', relocateConfirmBody: 'Tu Home actual se detendrá antes de que su copia verificada se active en el destino.', relocateDestination: 'Destino', relocateConfirmAction: 'Mover Home', recoverRestoreTitle: '¿Recuperar la restauración interrumpida?', recoverRestoreBody: 'Revertir la restauración interrumpida usando el material de recuperación conservado.', recoverRestoreAction: 'Recuperar restauración', eraseDataTitle: '¿Eliminar los datos del Home personal?', eraseHomeTarget: 'Home', eraseDataBody: 'Esto es independiente de la desinstalación y elimina permanentemente solo estas rutas resueltas del Home:', estimatedSize: 'Tamaño estimado', summaryTitle: 'Home personal', footer: 'Tu Home permanece en este ordenador. Estas acciones no cambian otro Home.', statusTitle: 'Estado', notAvailable: 'No disponible', storageTitle: 'Almacenamiento', masterSecretTitle: 'Secreto de acceso del Home', masterSecretPresent: 'Presente', masterSecretUnavailable: 'No disponible', inspectAction: 'Actualizar detalles del Home', actionsTitle: 'Copia y restauración', protectionTitle: 'Protección', backupsSectionFooter: 'Las copias contienen conversaciones legibles, datos del Home, el estado de dispositivos de confianza y el secreto de acceso del Home. Guárdalas solo en un lugar de confianza.', lastBackupTitle: 'Última copia', lastBackupUnknown: 'Última copia desconocida', backupsTitle: 'Archivos de copia', backupAction: 'Hacer copia ahora', backupSubtitle: 'Crea y verifica un archivo de Home en texto plano.', exportBackupAction: 'Exportar copia…', exportBackupSubtitle: 'Crea una copia verificada en una ubicación que elijas.', verifyAction: 'Verificar copia…', verifySubtitle: 'Comprueba un archivo sin restaurarlo.', restoreAction: 'Restaurar…', restoreSubtitle: 'Valida una copia antes de reemplazar los datos del Home.', relocateAction: 'Mover Home…', relocateSubtitle: 'Mueve este Home a un ordenador gestionado.', relocationFinishAction: 'Terminar el traslado', relocationReturnAction: 'Volver al Home original', relocationFinishSubtitle: 'Termina de mover este Home después de verificar el destino.', relocationReturnSubtitle: 'Conserva el Home original como ubicación activa.', recoverRestoreSubtitle: 'Una restauración interrumpida puede revertirse explícitamente.', restoreRecoveryWarningTitle: 'La restauración necesita reparación', restoreRecoveryWarningBody: 'El estado de recuperación es ambiguo. No se hará ningún cambio automático. Revisa el diagnóstico antes de reparar este Home.', restoreCleanupWarningTitle: 'La limpieza de la restauración requiere atención', restoreCleanupWarningBody: 'El Home se restauró, pero la limpieza automática no terminó. Revisa el diagnóstico y vuelve a intentar la operación del Home.', backupVerified: 'Copia verificada', backupNeedsAttention: 'Copia verificada; el reinicio del Home requiere atención', backupHomeReady: 'Home reiniciado', backupRevealAction: 'Mostrar copia', restoreResultTitle: 'Resultado de la restauración', restoreOutcomeRecoveryRequired: 'Se necesita recuperación', restoreOutcomeRolledBack: 'Restauración revertida', restoreOutcomeRestored: 'Home restaurado', advancedTitle: 'Avanzado', advancedFooter: 'Controles del entorno y diagnóstico de este ordenador.', restartAction: 'Reiniciar el Home personal', openDataLocationAction: 'Abrir ubicación de datos del Home', openLogsAction: 'Abrir registros del entorno', removeProfileAction: 'Quitar Home de Happier', removeProfileSubtitle: 'Quita este perfil; los datos del entorno permanecen en este ordenador.', removeProfileTitle: '¿Quitar el perfil del Home personal?', removeProfileBody: 'Esto quita el perfil, pero conserva el entorno y los datos.', uninstallRuntimeAction: 'Desinstalar entorno, conservar datos', uninstallRuntimeSubtitle: 'Quita el servicio y los binarios; los datos del Home se conservan.', deleteHomeDataTitle: 'Eliminar datos del Home', removeSectionFooter: 'La desinstalación conserva los datos del Home. La eliminación permanente es una acción confirmada independiente.', eraseDataAction: 'Eliminar permanentemente los datos del Home personal', eraseDataSubtitle: 'Independiente de la desinstalación. Elimina permanentemente los datos resueltos del Home.', eraseResultTitle: 'Datos del Home eliminados', eraseStoppedHome: 'Se detuvo el Home en ejecución', eraseHomeAlreadyStopped: 'El Home ya estaba detenido', eraseRemainingPaths: 'No se pudo eliminar', progressTitle: 'Operación del Home personal', dismissResult: 'Descartar',
    repairSearchAction: 'Reconstruir la búsqueda del Home',
    repairSearchSubtitle: 'Recrea el índice de búsqueda a partir de las conversaciones de este Home.',
    repairSearchCompleteTitle: 'Búsqueda del Home reconstruida',
    repairSearchCompleteBody: 'El índice de búsqueda se recreó a partir de las conversaciones de este Home.',
    backupCleanupRequired: 'La copia está a salvo; elimina la ruta de preparación protegida que se muestra en Detalles',
    backupCleanupPath: 'Ruta de preparación protegida por eliminar',
    backupCleanupError: 'Error de limpieza',
    backupDestinationMismatch: 'La copia no se creó en el destino seleccionado. No se ha eliminado nada.',
    backupDestinationUnsafe: 'El destino de copia seleccionado está dentro de los datos del Home personal que se eliminarían. No se ha eliminado nada.',
    eraseInspectionAttention: 'Datos del Home eliminados; la verificación necesita atención',
    searchTitle: 'Búsqueda',
    searchReady: 'Lista',
    searchIndexing: 'Indexando…',
    searchUnavailable: 'No disponible',
    localOnlyIngressTitle: 'Accesible solo desde este ordenador',
    localOnlyIngressBody: 'Los recursos compartidos públicos, las llamadas de retorno de proveedores, los webhooks de plugins y las notificaciones mientras este ordenador duerme no estarán disponibles hasta que este Home sea accesible desde fuera.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { es: 'Esta copia contiene conversaciones legibles, datos del Home, el secreto de acceso del Home y el estado de los dispositivos de confianza. Cualquiera que pueda restaurar el archivo completo puede operar un clon de este Home. Guárdala en un lugar de confianza.' } as const;

const eraseBackupOffer = { es: { title: '¿Hacer primero una copia de este Home?', body: 'Eliminar los datos del Home no se puede deshacer. Crea primero una copia verificada o continúa sin ella.', continueWithoutBackup: 'Continuar sin copia' } } as const;

const operationOutcome = { es: {
        erasePartialTitle: 'No se pudieron eliminar algunos datos del Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `Se ${removed === 1 ? 'eliminó' : 'eliminaron'} ${removed} ${removed === 1 ? 'elemento' : 'elementos'}`
            + (remaining > 0 ? `; ${remaining} no se ${remaining === 1 ? 'pudo' : 'pudieron'} eliminar` : ''),
        eraseNotPerformed: 'No se eliminó nada',
        eraseBlockedBackupMismatch: 'Esta copia es de otro Home.',
        eraseBlockedIdentityUnknown: 'Happier no pudo confirmar que esta copia corresponde a este Home.',
        eraseVerificationDetail: 'Verificación',
        operationFailed: 'Esta operación del Home no terminó. Abre Detalles para ver qué pasó.',
        restorePreviousDataTitle: 'Datos anteriores guardados',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "es">;

const personalHomeSettingsTranslations = { es: { ...es, ...operationOutcome.es, backupDisclosureBody: backupDisclosureBody.es, eraseBackupOfferTitle: eraseBackupOffer.es.title, eraseBackupOfferBody: eraseBackupOffer.es.body, eraseContinueWithoutBackup: eraseBackupOffer.es.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const es: PersonalizeTranslation = {
    cardTitle: 'Personaliza Happier',
    cardSubtitle: 'Seis elecciones rápidas, cada una con vista previa en directo.',
    cardAction: 'Personalizar',
    cardContinue: 'Continuar',
    cardProgress: ({ saved, total, step }) => `${saved} de ${total} elecciones guardadas. Sigue en ${step}.`,
    cardProgressReview: ({ saved, total }) => `${saved} de ${total} elecciones guardadas. Revisa tu configuración.`,
    inPlaceTitle: 'Haz tuyo Happier',
    inPlaceBody: 'Seis elecciones rápidas, cada una con vista previa en directo. Empieza por el aspecto: Home cambia mientras eliges.',
    inPlaceContinue: ({ count }) => `Continuar · ${count} más`,
    notNow: 'Ahora no',
    flowTitle: 'Personaliza Happier',
    finishLater: 'Terminar más tarde',
    later: 'Más tarde',
    stepEyebrow: ({ n, total, name }) => `Paso ${n} de ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} de ${total}`,
    styleEyebrow: 'Opcional',
    summaryEyebrow: 'Todo listo',
    previewNote: 'Vista previa. No se guarda nada hasta que pulses Siguiente.',
    previewNoteSummary: 'Tu espacio de trabajo, tal como está ahora.',
    next: 'Siguiente',
    review: 'Revisar',
    useThisSetup: 'Usar esta configuración',
    saveFailed: 'Este paso no se guardó. Tu elección sigue seleccionada.',
    tryAgain: 'Reintentar',
    skipThisStep: 'Omitir este paso',
    scopeThisDevice: 'Este dispositivo',
    scopeAllDevices: 'Todos tus dispositivos',
    stepsLabel: 'Pasos',
    savedStepsNote: ({ count }) => count === 1 ? 'Ya hay 1 paso guardado.' : `Ya hay ${count} pasos guardados.`,
    lookName: 'Aspecto',
    lookTitle: 'Hazlo cómodo',
    lookDescription: 'Claro, oscuro o lo que use tu sistema, y cuánto cristal muestra la app.',
    themeLabel: 'Tema',
    glassLabel: 'Cristal',
    glassAutoDescription: 'Cristal en toda la app, por capas',
    glassEverywhereDescription: 'Un mismo cristal en todas partes',
    glassSolidDescription: 'Todas las superficies opacas',
    glassCustomNote: 'Ajustaste el cristal en Apariencia. Elige un ajuste predefinido para reemplazarlo o conserva el tuyo.',
    customizeInAppearance: 'Personalizar en Apariencia…',
    styleName: 'Estilo',
    styleTitle: 'Empieza con un estilo',
    styleDescription: 'Cada estilo define cómo se leen las sesiones y cómo se ve la lista. Solo rellena los siguientes pasos: no se guarda nada hasta que pulses Siguiente en cada uno.',
    styleKeep: 'Mantener mi configuración actual',
    styleActivity: 'Actividad',
    styleConversation: 'Conversación',
    styleDetail: 'Detalle',
    styleCustomTag: 'Personalizado',
    styleDefaultTag: 'Predeterminado de Happier',
    styleChanges: ({ style, count }) => count === 1 ? `${style} cambia 1 cosa` : `${style} cambia ${count} cosas`,
    styleNoChanges: 'Esta ya es tu configuración.',
    styleNever: 'El tema, las notificaciones, la privacidad y los permisos de los agentes nunca forman parte de un estilo.',
    was: ({ value }) => `antes: ${value}`,
    conversationName: 'Conversación',
    conversationTitle: 'Sigue la conversación',
    conversationDescription: 'Cómo se leen los turnos de una sesión y el pensamiento del agente.',
    layoutLabel: 'Diseño',
    thinkingLabel: 'Pensamiento',
    toolsName: 'Llamadas a herramientas',
    toolsTitle: 'Mira lo que hizo el agente',
    toolsDescription: 'Cómo aparecen los comandos, las ediciones y las lecturas en una sesión.',
    toolsLabel: 'Llamadas a herramientas',
    toolTapLabel: 'Al hacer clic en una herramienta',
    toolDetailLabel: 'Detalle de las herramientas',
    toolDetailDefault: 'Predeterminado',
    toolDetailFull: 'Completo',
    workName: 'Tu trabajo',
    workTitle: 'Encuentra tu trabajo',
    workDescription: 'Cómo se organiza la lista de sesiones y cuánto muestra cada fila.',
    listLayoutLabel: 'Lista de sesiones',
    rowsLabel: 'Filas',
    attentionName: 'Atención',
    attentionTitle: 'Ve lo que te necesita',
    attentionDescription: 'Dónde aparecen en la lista las sesiones que te esperan o están listas para revisar.',
    attentionLabel: 'Sesiones que te necesitan',
    attentionHomeNote: 'Home siempre muestra lo que te necesita. Esto solo cambia la lista de sesiones.',
    notificationsName: 'Notificaciones',
    notificationsTitle: 'Mantente al día',
    notificationsDescription: 'Lo que este dispositivo te avisa mientras miras otra cosa.',
    notificationsAllowed: 'Las notificaciones están permitidas en este dispositivo.',
    notificationsNotAllowed: 'Happier todavía no puede mostrar notificaciones en este dispositivo.',
    notificationsUnsupported: 'Las notificaciones no están disponibles en este dispositivo. Configúralas en la aplicación de escritorio o en tu teléfono.',
    scopeLook: 'Tema en este dispositivo · cristal en todos tus dispositivos',
    notificationsNeedsYouSummary: 'Te necesita',
    notificationsFinishedSummary: 'Finalizado',
    notificationsAllow: 'Permitir notificaciones',
    notificationsTellMe: 'Avísame cuando',
    notificationsNeedsYou: 'Una sesión necesita una aprobación o una respuesta',
    notificationsFinished: 'Una sesión termina su turno',
    notificationsShowLabel: 'Las notificaciones muestran',
    notificationsShowDescription: 'Los comandos, las preguntas y las respuestas pueden aparecer en tu pantalla de bloqueo.',
    notificationsMessage: 'El mensaje',
    notificationsStatus: 'Solo el estado',
    notificationsPhoneNote: 'Los avisos en tu teléfono con Happier cerrado se configuran en el teléfono.',
    notificationsOff: 'Sin notificaciones',
    sampleNeedsYouTitle: 'Revisión #2481 te necesita',
    sampleNeedsYouBody: 'El agente quiere ejecutar yarn test:e2e en ~/happier. ¿Lo permites?',
    sampleReadyTitle: '«Arreglar test de reconexión inestable» está listo',
    sampleReadyBody: 'Encontrado: el temporizador de reintentos nunca se limpiaba. Ya está arreglado y el test pasa.',
    sampleStatusBody: 'Abre Happier para verlo.',
    sampleSessionReconnect: 'Arreglar test de reconexión inestable',
    sampleSessionCraft: 'Laboratorio de pulido',
    sampleSessionReview: 'Revisión #2481',
    sampleSessionPricing: 'Textos de la página de precios',
    sampleSessionDocs: 'Índice de búsqueda de la documentación',
    sampleWorking: 'Trabajando',
    sampleNeedsYou: 'Te necesita',
    sampleReady: 'Listo para revisar',
    summaryTitle: 'Esta es tu configuración',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Todo lo de abajo ya está guardado. No cambió nada.'
        : changed === 1
            ? 'Todo lo de abajo ya está guardado. Cambió una elección; el resto quedó igual.'
            : `Todo lo de abajo ya está guardado. Cambiaron ${changed} elecciones; el resto quedó igual.`,
    summaryChange: 'Cambiar',
    summaryFooter: 'Puedes cambiar todo esto más tarde en Configuración, o repasarlo de nuevo desde Configuración → Apariencia.',
    replayTitle: 'Personaliza Happier',
    replaySubtitle: 'Seis elecciones rápidas, cada una con vista previa en directo.',
    replayAction: 'Empezar',
    journeyHandoff: 'Hazlo tuyo',
};

const personalizeTranslations = { es } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "es">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const es: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'El diseño de teléfono dentro de las sesiones y los gestos de su barra. Cada gesto se puede desactivar por separado.',
            swipeSidewaysTitle: 'Desliza hacia los lados para cambiar de sesión',
            swipeSidewaysScrollsDescription: 'Anterior o siguiente, en la barra. Cuando tus herramientas no caben, deslizar las desplaza.',
            swipeSidewaysAlwaysDescription: 'Anterior o siguiente, en la barra. Sigue siendo un deslizamiento; las herramientas que no caben esperan en Más.',
            alwaysSwipeTitle: 'Desliza siempre entre sesiones',
            alwaysSwipeOnDescription: 'La barra mantiene las herramientas que caben; el resto espera en Más.',
            alwaysSwipeOffDescription: 'Desactivado: las herramientas extra hacen que la barra se desplace.',
            dragUpTitle: 'Arrastra hacia arriba para cambiar',
            dragUpDescription: 'Arrastra la barra hacia arriba para ver tus pestañas abiertas y sesiones recientes, y desliza hasta una.',
            dragUpSourceTitle: 'Arrastrar hacia arriba muestra',
            dragUpSourceRecentDescription: 'Pestañas abiertas y luego lo que abriste recientemente en este dispositivo.',
            dragUpSourceListDescription: 'Sesiones en el orden de la lista.',
            swipeSourceTitle: 'Deslizar hacia los lados muestra',
            swipeSourceListDescription: 'La sesión siguiente o anterior de tu lista.',
            swipeSourceRecentDescription: 'La siguiente o anterior según cuándo la abriste por última vez.',
            sourceRecent: 'Recientes',
            sourceList: 'Lista de sesiones',
            flickTitle: 'Desliza rápido arriba o abajo para cambiar',
            flickDescription: 'Un movimiento rápido abre la siguiente o la anterior.',
            holdToDockTitle: 'Mantén pulsado para dejar abierto el selector',
            holdToDockDescription: 'Mantén la barra y suelta para elegir con un toque.',
            pullAllTabsTitle: 'Baja el título para ver todas las pestañas',
            pullAllTabsDescription: 'Arrastra el título de la sesión hacia abajo para ver todas las pestañas abiertas y sesiones recientes.',
        },
        bar: {
            onTheBar: 'En la barra',
            more: 'Más',
            heldInMore: 'En Más mientras “Deslizar siempre” está activado',
            keepOnBar: 'Mantener en la barra',
            removeFromBar: 'Quitar de la barra',
            openFiles: 'Abrir archivos',
        },
        allTabs: {
            title: 'Todas las pestañas',
            pullHint: 'Tira para ver todas las pestañas',
            releaseHint: 'Suelta para ver todas las pestañas',
            openTabs: 'Pestañas abiertas',
            openTabsSynced: 'Pestañas abiertas · sincronizadas',
            recent: 'Recientes',
            recentOnThisDevice: 'Recientes en este teléfono',
            here: 'Aquí',
            panes: ({ count }: { count: number }) => `${count} paneles`,
            emptyTitle: 'No hay nada más abierto',
            emptyDescription: 'Las sesiones que abres y las pestañas que conservas aparecen aquí, las más recientes primero.',
            openTab: ({ title }: { title: string }) => `Abrir ${title}`,
        },
        rail: {
            label: 'Pestañas abiertas',
            synced: 'Sincronizadas',
            syncedA11y: 'Las pestañas abiertas se sincronizan entre tus dispositivos',
            notAvailableTitle: 'No disponible en este teléfono',
            notAvailableUnknown: 'Esta pestaña se abrió en otro dispositivo y este teléfono no puede mostrarla. Sigue abierta allí.',
            closeTab: 'Cerrar pestaña',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
            nextPane: 'Panel siguiente',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Cambiar a',
            allSessions: 'Todas las sesiones',
            openTabs: 'Pestañas abiertas',
            synced: 'sincronizadas',
            recent: 'Recientes',
            recentOnThisDevice: 'Recientes en este teléfono',
            sessions: 'Sesiones',
            nextInSessions: 'Siguiente en Sesiones',
            previousInSessions: 'Anterior en Sesiones',
            furtherBack: 'Más atrás',
            moreRecent: 'Más reciente',
            here: 'Aquí',
            stayOn: 'Quedarse en',
            noOlderSessions: 'No hay sesiones más antiguas',
            noNewerSessions: 'No hay sesiones más recientes',
            lastInSessions: 'Esta es la última de Sesiones.',
            firstInSessions: 'Esta es la primera de Sesiones.',
            nothingFurtherBack: 'No hay nada más atrás.',
            mostRecent: 'Esta es la más reciente.',
            nothingToSwitch: 'No hay nada más abierto',
            nothingToSwitchDescription: 'Las sesiones que abres aparecen aquí, las más recientes primero.',
            draft: ({ text }: { text: string }) => `Tu borrador: “${text}”`,
            switchSessionAction: 'Cambiar de sesión',
            switchedTo: ({ name }: { name: string }) => `Cambiaste a ${name}`,
            close: 'Cerrar',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
        },
    },
};

const phoneNavigationTranslations = { es };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { es: {
    accountDataErase: {
        installedGroupTitle: 'Datos de la cuenta',
        installedGroupFooter: 'Esto afecta únicamente a los datos retenidos de la Cuenta actual. No desinstala este complemento de ninguna máquina.',
        installedEntryTitle: 'Borrar datos de la cuenta',
        installedEntrySubtitle: 'Elimine permanentemente los datos retenidos de este complemento de la cuenta actual.',
        orphanedGroupTitle: 'Datos del complemento retenidos',
        orphanedGroupFooter: 'Utilice una ID de complemento para eliminar los datos retenidos de la cuenta después de que se haya eliminado un complemento.',
        orphanedEntryTitle: 'Borrar datos retenidos del complemento',
        orphanedEntrySubtitle: 'Ingrese un ID de complemento instalado o eliminado para borrar permanentemente los datos de su cuenta actual.',
        promptTitle: 'ID del complemento',
        promptBody: 'Ingrese el ID del complemento cuyos datos retenidos desea borrar de la cuenta actual.',
        promptPlaceholder: 'com.ejemplo.plugin',
        invalidTitle: 'Ingrese una ID de complemento',
        invalidBody: 'Utilice la ID exacta del complemento antes de continuar.',
        confirmTitle: '¿Borrar datos del complemento de la cuenta?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Esto elimina permanentemente los datos retenidos para ${pluginId} de la Cuenta Corriente. No desinstala el complemento de sus máquinas.`,
        confirm: 'borrar datos',
        completedTitle: 'Se borraron los datos del complemento de la cuenta',
        completedChanged: 'Los datos del complemento retenidos se eliminaron de la cuenta actual.',
        completedEmpty: 'No se encontraron datos de complemento retenidos para este complemento en la cuenta actual.',
        partialTitle: 'Quedan algunos datos del complemento',
        partialBody: 'Algunos datos retenidos no se pudieron borrar. Nada se reintentará automáticamente; Vuelva a intentar borrar los datos restantes.',
        failedTitle: 'Los datos del complemento no se borraron',
        failedBody: 'Los datos conservados no se pudieron borrar. Vuelva a intentarlo después de verificar la conexión de la cuenta actual.',
        unavailableTitle: 'Los datos del complemento no están disponibles',
        unavailableBody: 'La cuenta actual cambió o no está disponible. Vuelva a abrir esta acción después de que la cuenta esté lista.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { es: {
    accountReleaseSelection: {
        groupTitle: 'Liberación de cuenta',
        groupFooter: 'Seleccione una versión exacta para esta cuenta. Esto no instala, actualiza ni confía en el complemento en ninguna máquina.',
        entryTitle: 'Usar para esta cuenta',
        entrySubtitle: ({ version }: { version: string }) => `Seleccionar versión ${version} para la cuenta actual sin cambiar ninguna instalación de la máquina.`,
        selectedTitle: 'Liberación de cuenta seleccionada',
        selectedBody: 'La versión del complemento seleccionada ahora se utilizará para esta cuenta.',
        conflictTitle: 'Liberación de cuenta cambiada',
        conflictBody: 'La liberación de la cuenta cambió mientras esta acción estaba abierta. Vuelve a abrirlo y vuelve a intentarlo.',
        unavailableTitle: 'Liberación de cuenta no disponible',
        unavailableBody: 'La versión exacta o su fuente de migración requerida no está disponible para la Cuenta actual. Vuelva a intentarlo cuando la cuenta esté lista.',
        rejectedTitle: 'No se seleccionó la liberación de cuenta',
        rejectedBody: 'La Cuenta no aceptó esta selección de versión. Verifique el estado de la cuenta e inténtelo nuevamente.',
        hostedGroupFooter: 'Gestione los artefactos del complemento que esta cuenta aloja para el complemento. Ninguna máquina ofrece ahora esta versión, así que no se puede seleccionar aquí.',
        hostedEnableTitle: 'Alojar artefactos del complemento para esta cuenta',
        hostedEnableBody: "Guarda la interfaz y los recursos del paquete en el servidor de tu cuenta. En cuentas sin cifrado, el servidor puede leer los datos; con E2EE, almacena datos cifrados. Los metadatos de la versión siguen visibles. Esto no instala el complemento, no le concede confianza ni permite ejecutarlo en una máquina sin conexión.",
        hostedDisableTitle: 'Dejar de alojar artefactos del complemento',
        hostedStatusDisabled: "Desactivado. Activa el alojamiento para descargar los artefactos de esta versión cuando la máquina de origen esté sin conexión.",
        hostedStatusPending: 'Activado. Esta versión espera a que el host publique los artefactos exactos del complemento.',
        hostedStatusReady: 'Los artefactos del complemento alojados están disponibles para esta versión exacta.',
        hostedRemoveTitle: 'Desactivar el alojamiento y eliminar los artefactos',
        hostedRemoveBody: 'Detiene el alojamiento en la cuenta y elimina los artefactos del complemento alojados de esta versión. La limpieza de la caché local es aparte.',
        hostedClearCacheTitle: 'Borrar la caché local de artefactos',
        hostedClearCacheBody: 'Elimina los bytes de artefactos de interfaz almacenados localmente para esta versión exacta sin cambiar el alojamiento en la cuenta.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { es: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.es) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const es = {
    invocationLogs: {
        title: 'Registros de invocaciones',
        footer: 'Registros limitados y redactados de la máquina de plugin seleccionada.',
        correlationFilter: 'Filtro de ID de correlación',
        correlationFilterAll: 'Todas las invocaciones de este plugin',
        correlationPromptTitle: 'Filtrar por ID de correlación',
        correlationPromptBody: 'Muestra solo los registros de una invocación exacta del plugin. Déjalo vacío para mostrar todos los registros.',
        correlationPromptPlaceholder: 'ID de correlación',
        refresh: 'Actualizar registros',
        follow: 'Seguir registros',
        stopFollowing: 'Dejar de seguir',
        loadMore: 'Cargar los registros siguientes',
        loadingTitle: 'Cargando registros de invocaciones',
        loadingSubtitle: 'Leyendo registros limitados y redactados de la máquina seleccionada.',
        idleTitle: 'Listo para leer registros de invocaciones',
        idleSubtitle: 'Actualiza para leer registros limitados y redactados de la máquina seleccionada.',
        emptyTitle: 'No hay registros de invocaciones',
        emptySubtitle: 'No hay registros redactados coincidentes en esta máquina seleccionada.',
        unavailableTitle: 'Los registros de invocaciones no están disponibles',
        unavailableSubtitle: 'La máquina de plugin seleccionada no está disponible o ya no es actual.',
        readerUnavailableSubtitle: 'La máquina de plugin seleccionada no puede proporcionar registros de invocaciones ahora mismo.',
        selectionRequiredTitle: 'Selecciona una máquina de plugin',
        selectionRequiredSubtitle: 'Elige arriba una materialización compatible del plugin antes de leer sus registros.',
        conflictTitle: 'Resuelve la máquina de plugin seleccionada',
        conflictSubtitle: 'Elige arriba una materialización compatible del plugin antes de leer sus registros.',
        errorTitle: 'No se pudieron cargar los registros de invocaciones',
        errorSubtitle: 'La lectura de registros no se completó. Inténtalo de nuevo cuando la máquina seleccionada esté disponible.',
        noMessage: 'Evento del registro del plugin',
        level: {
            debug: 'Depuración',
            info: 'Información',
            warn: 'Advertencia',
            error: 'Se produjo un error',
            diagnostic: 'Diagnóstico',
        },
    },
};

const pluginInvocationLogTranslations = { es } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { es: {
        machineMatrix: {
            title: 'En tus máquinas',
            footer: 'Solo lectura. La instalación, la actualización y las demás acciones del plugin se ejecutan en la máquina seleccionada arriba.',
            empty: 'Ninguna máquina ha informado todavía de una instalación de plugins para esta cuenta.',
            unavailable: 'La disponibilidad de plugins de la cuenta aún no se ha cargado, así que los estados de las máquinas son desconocidos.',
            incomplete: ({ count }: { count: number }) => `Esta lista puede estar incompleta: ${count} servidor(es) todavía no han informado de sus máquinas.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Instalado y actualizado en ${installed} de ${total} máquinas`,
            lastObserved: ({ ago }: { ago: string }) => `visto por última vez: ${ago}`,
            state: {
                installedCurrent: 'Instalado y actualizado',
                disabled: 'Desactivado',
                untrusted: 'Sin confianza',
                incompatible: 'Versión distinta',
                localOnly: 'Local a esta máquina',
                staleOffline: 'Último estado conocido, máquina sin conexión',
                absent: 'No instalado',
                unknown: 'Desconocido',
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

const marketplacePresentation = { es: {
        diagnosticsIssueTitle: 'Problema del plugin', diagnosticsRecovery: 'Revisa el detalle anterior y, tras corregirlo, vuelve a cargar el plugin o esta página.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Código técnico: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Etiqueta del publicador: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Categorías: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Se ejecuta en: ${realms} · Plataformas: ${platforms}`, reviewStatus: { curated: 'Recomendación seleccionada', unreviewed: 'Sin revisar', withdrawn: 'Retirado' }, executableRealm: { daemon: 'servicio en segundo plano', client: 'aplicación', hostedWeb: 'web alojada' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problema con una fuente del marketplace', recovery: 'Actualiza Descubrir. Si continúa, revisa Fuentes y registros.', unreachableTitle: ({ source }: { source: string }) => `No se pudo conectar con ${source}`, behindTitle: ({ source }: { source: string }) => `${source} respondió con datos antiguos o incompletos`, indexTitle: 'El índice de plugins está incompleto', otherSourcesShown: 'Los resultados de otras fuentes se siguen mostrando.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { es: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Ruta local', archive: 'Archivo comprimido', npm: 'Paquete npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Catálogo seleccionado', 'community-npm': 'Catálogo público de npm', user: 'Catálogo personal' }, executableRealm: { daemon: 'Código del servicio en segundo plano', reactNative: 'Código de la interfaz de la aplicación', hostedWeb: 'Código web alojado aislado' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Recursos de interfaz verificados', none: 'Sin recursos de interfaz', unavailable: 'Recursos de interfaz no disponibles' }, authorizationClass: { cooperativeDisclosure: 'Divulgación cooperativa', hostResourceSelection: 'Recursos del sistema seleccionados', presentIntentOrOs: 'Intención actual o permiso del sistema operativo' }, priority: ({ priority }: { priority: number }) => `Prioridad ${priority}` } } as const;

const localizedReviewVocabulary = { es: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.es,
            archiveUrlRetention: 'Happier guarda la URL completa del archivo en la máquina seleccionada, incluidas las credenciales que contenga, para futuras actualizaciones. Las URL caducadas o revocadas pueden hacer que las actualizaciones fallen.',
            trustedCodeTitle: 'Código de confianza', trustedCodeDisclosure: 'Los plugins se ejecutan como código de confianza dentro de Happier, no en un entorno aislado. Un plugin puede usar directamente los permisos de esta aplicación —archivos, red, entorno y procesos— más allá de los servicios mediados por Happier que aparecen abajo. Esa lista es lo que el plugin declaró y lo que podrás desactivar después, no un límite de lo que su código puede alcanzar.', identity: 'Identidad y paquete', evidence: 'Detalles técnicos', executableCode: 'Código ejecutable y contribuciones', requiredAccess: 'Acceso obligatorio al sistema', optionalAccess: 'Acceso opcional al sistema', requestInterceptors: 'Interceptores de solicitudes', rawCredentials: 'Declaraciones de acceso directo a credenciales', compatibility: 'Compatibilidad y actualizaciones', none: 'No se declaró nada', scope: ({ scope }: { scope: string }) => `Ámbito: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · desarrollo`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · sin verificar`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (esperada)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (observada)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Firma del registro verificada: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Firma del registro no compatible: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Declarada sin verificar: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Obtenida sin verificar: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Procedencia no disponible: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Fuente de catálogo sin revisar: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Revisada por ${sourceId} el ${reviewedAt}${reason}`, savedSecret: 'Secreto guardado', connectedAccount: 'Cuenta conectada', secretKinds: ({ kinds }: { kinds: string }) => `Tipos de secreto: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Servicio: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Finalidad: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Se usa en ${realm} durante ${phase}`, credentialAccess: ({ access }: { access: string }) => `Acceso: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Encabezados enviados a ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Variables de entorno: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Archivos: ${files}`, realm: { web: 'el navegador', ios: 'la aplicación para iOS', android: 'la aplicación para Android', daemon: 'el servicio en segundo plano' }, phase: { settings: 'la configuración', prepare: 'la preparación', connection: 'la conexión', speech: 'el uso de voz' }, runtimeApi: ({ version }: { version: number }) => `API de ejecución ${version}`,
        },
        sourceAdministration: { title: 'Fuentes y registros', subtitle: 'Elige dónde descubre esta máquina los paquetes npm exactos y cómo accede a sus registros.', communityTitle: 'Directorio público de npm', communitySubtitle: 'Integrado · búsqueda sin revisar de plugins de Happier aptos en npm público, no de cualquier paquete npm.', configuredTitle: 'Fuentes del marketplace', configuredEmpty: 'No hay fuentes adicionales configuradas.', add: 'Añadir fuente', edit: 'Editar fuente', remove: 'Eliminar fuente', removeTitle: '¿Eliminar la fuente del marketplace?', removeBody: ({ name }: { name: string }) => `${name} dejará de usarse para buscar en esta máquina. Los plugins instalados no cambian.`, sourceUrl: 'Dirección de la fuente', displayName: 'Nombre visible', description: 'Descripción opcional', enabled: 'Activada', disabled: 'Desactivada', curated: 'Fuente seleccionada', user: 'Tu fuente', loadError: 'No se pudieron cargar las fuentes del marketplace.', retry: 'Reintentar', operationFailed: 'No se pudo aplicar el cambio. Comprueba la conexión con la máquina e inténtalo de nuevo.', operationOutcomeUnknownTitle: 'Cambio pendiente de revisión', operationOutcomeUnknownBody: 'Es posible que la máquina seleccionada ya haya aplicado este cambio, pero Happier no pudo confirmar el resultado. Revisa los ajustes actualizados antes de cambiarlos de nuevo.' },
        updatePolicy: { title: 'Regla de actualización', target: ({ machine, server }: { machine: string; server: string }) => `Se aplica en ${machine} mediante ${server}.`, pinned: 'Versión fijada', pinnedSubtitle: 'No actualizar hasta que elijas otra regla.', allowed: 'Actualizaciones permitidas', allowedSubtitle: 'Las actualizaciones explícitas continúan sin otra confirmación salvo que aumenten los permisos declarados.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { es: {
        ...localizedReviewVocabulary.es,
        ...marketplacePresentation.es,
        secretFieldActions: { delete: 'Eliminar el secreto guardado', deleteHint: 'Borra el valor guardado. No se puede deshacer.', unbind: 'Quitar de este plugin', unbindHint: 'Desvincula el secreto guardado de este ajuste. El secreto se conserva.' },
        pluginChangeOutcomeUnknownTitle: 'Resultado sin confirmar',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier no pudo confirmar si ${action} para ${name} terminó en ${machine} (${server}). Consulta la lista de instalados de esa máquina y su versión actual antes de volver a intentarlo.`,
        updateFromInstalledRecordSubtitle: 'Actualizar esta instalación por su propio canal de actualización de confianza.',
        discover: {
            ...marketplacePresentation.es.discover,
            status: {
                loading: 'Buscando en todas las fuentes del marketplace…',
                loadingSource: ({ source }: { source: string }) => `Buscando en ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} plugin(s) de ${sources} fuente(s)`,
                empty: 'Ningún plugin coincide con esta búsqueda.',
                error: ({ message }: { message: string }) => `No se pudo actualizar la búsqueda: ${message}`,
                errorTitle: 'No se pudo actualizar la búsqueda',
                stale: 'Estos resultados responden a una búsqueda anterior. Vuelve a buscar para aplicar los controles de arriba.',
                partial: ({ count }: { count: number }) =>
                    `${count} fuente(s) respondieron con datos antiguos o incompletos, así que los resultados pueden estar incompletos.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `Se encontraron ${count} entrada(s) que ahora mismo no se pueden instalar en esta máquina.`,
            },
            sourceFreshness: {
                stale: 'Más antiguo que esta fuente',
                'stale-offline': 'Últimos resultados conocidos, fuente sin conexión',
                unavailable: 'Fuente no disponible',
                'auth-unavailable': 'Esta fuente requiere iniciar sesión',
                corrupt: 'No se pudo leer el índice de la fuente',
            },
            nonInstallableReason: {
                sourceStale: 'Su fuente del marketplace no está actualizada.',
                artifactUnavailable: 'No se puede alcanzar su paquete con el acceso al registro de esta máquina.',
                notApproved: 'Su instalación no está aprobada desde esta fuente.',
                unsupportedSourceKind: 'Esta versión de Happier no admite ese tipo de fuente.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Revisa todo lo que declara este plugin antes de confiar en nada procedente de ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Necesita un perfil de registro para ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Elige un registro para ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} se publica en ${origin}. Elige el perfil de registro que ${source} usa en esta máquina, o añade uno e inicia sesión. No se descarga nada hasta la revisión de instalación y confianza.`,
                continue: 'Continuar',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { es: {
        fields: {
            pluginId: 'ID del complemento',
            capability: 'Capacidad',
            scope: 'Ámbito',
            requester: 'Solicitante',
            authority: 'Autoridad',
            requestedAt: 'Hora de la solicitud',
            reason: 'Motivo',
        },
        scope: { account: 'Cuenta', project: 'Proyecto', workspace: 'Espacio de trabajo' },
        requester: { user: 'Usuario', host: 'Sistema anfitrión', plugin: 'Complemento' },
        authority: { bundled: 'Incluido', machineInstallation: 'Instalación en una máquina' },
        identifiers: {
            session: 'Sesión',
            request: 'Solicitud',
            machine: 'Máquina',
            installation: 'Instalación',
        },
        accessibilitySummary: ({ details }) => `Detalles de la solicitud de permiso. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "es">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { es: {
        rowStatus: { enabled: 'Activado', disabled: 'Desactivado', incompatible: 'No compatible', trustRemoved: 'Confianza retirada', needsAttention: 'Requiere atención' },
        developmentPhase: { observing: 'Observando', preparingDependencies: 'Preparando dependencias', compiling: 'Compilando', validating: 'Validando', active: 'Activo', retainedIncumbent: 'Versión anterior activa', unavailable: 'No disponible' },
        rowSource: { bundled: 'Incluido con Happier', npm: 'Paquete npm', archive: 'Archivo comprimido', localPath: 'Carpeta local', other: 'Fuente configurada' },
        rowAttention: { trustRemoved: 'Este plugin ya no se ejecuta. Vuelve a instalarlo para confiar de nuevo en su código.', incompatible: 'Esta versión no puede ejecutarse en la máquina seleccionada.' },
        developerGroupTitle: 'Desarrollo',
        developerGroupFooter: 'Crea plugins en la máquina seleccionada y consulta lo que informa su servicio.',
        developerDevelopmentSubtitle: 'Crea, edita, prueba y empaqueta plugins desde carpetas propias.',
        developerDiagnosticsSubtitle: 'Diagnósticos del servicio y del catálogo para la máquina seleccionada.',
        detailMissingTitle: 'Este plugin no está en la máquina seleccionada',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} no está instalado aquí. Puede que se haya desinstalado o que esté en otra máquina.`,
        detailMissingRetry: 'Comprobar de nuevo',
        surfaces: {
            purpose: 'Añade superficies, comandos e integraciones a Happier. Los plugins se ejecutan como código de confianza en tus máquinas.',
            navigationTitle: 'Plugins',
            updatesTitle: 'Actualizaciones',
            moreDescriptionInSettings: 'De dónde vienen los plugins, crear los tuyos y lo que informa esta máquina. Se abren en Ajustes.',
            fix: 'Corregir',
            allSources: 'Todas las fuentes',
            shelfCurated: 'Selección',
            shelfCuratedDescription: 'Revisados y recomendados por Happier. Cada instalación sigue mostrando su revisión completa.',
            shelfCommunity: 'Comunidad',
            shelfCommunityDescription: 'Paquetes npm sin revisar. Instalar y confiar muestra exactamente a qué puede acceder cada uno.',
            shelfUser: 'Tus fuentes',
            shelfUserDescription: 'Listados de fuentes de marketplace añadidas en esta máquina.',
            manage: 'Gestionar',
            installed: 'Instalado',
            notShownTitle: 'No se pudo mostrar todo',
            listingInstallsOn: ({ machine }: { machine: string }) => `Se instala en ${machine}. Revisas su acceso antes de que se ejecute nada.`,
            listingChooseMachine: 'Elige una máquina en el encabezado para instalar este plugin.',
            listingRunsIn: 'Se ejecuta en',
            listingPlatforms: 'Plataformas',
            listingSource: 'Fuente',
            listingCategories: 'Categorías',
            listingNotFoundTitle: 'Este listado no está disponible',
            listingNotFoundBody: 'Puede que se haya retirado de su fuente, o que esta máquina no pueda llegar a la fuente ahora.',
            developmentSourcesTitle: 'Plugins en desarrollo',
            chooseMachineInstalled: 'Elige una máquina en el encabezado para ver sus plugins.',
            chooseMachineBrowse: 'Elige una máquina en el encabezado para explorar los plugins que puede instalar.',
            openAsPage: 'Abrir como página',
            detailInstalledLabel: 'Plugin instalado',
            detailListingLabel: 'Ficha del plugin',
            viewLabel: 'Mostrar como',
            viewGrid: 'Cuadrícula',
            viewList: 'Lista',
            installedSearchPlaceholder: 'Buscar en los plugins instalados',
            statusFilterLabel: 'Mostrar plugins',
            statusAll: 'Todos los plugins',
            statusEnabled: 'Activados',
            statusDisabled: 'Desactivados',
            statusAttention: 'Requieren atención',
            noMatch: ({ query }: { query: string }) => `Ningún plugin coincide con «${query}»`,
            clearSearch: 'Borrar',
            emptyTitle: 'Aún no hay plugins instalados',
            emptyBody: 'Los plugins añaden paneles, comandos y herramientas para tus agentes. Empieza por los que hace Happier.',
            browsePlugins: 'Explorar plugins',
            browseEmpty: 'Tus fuentes todavía no ofrecen ningún plugin.',
            forDevelopers: 'Para desarrolladores',
            readFailedTitle: 'No se pudieron leer los plugins de esta máquina',
            readFailedBody: 'No se ha cambiado nada. Reintenta para volver a consultar la máquina.',
            lastKnown: ({ status }: { status: string }) => `Último estado conocido · ${status}`,
            machinesTitle: 'Máquinas',
            machinesDescription: 'Dónde está instalado este plugin.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Actualizado en ${current} de ${total} máquinas`,
            onMachines: ({ count }: { count: number }) => `En ${count} máquinas`,
            onMachine: ({ machine }: { machine: string }) => `En ${machine}`,
            addedGroup: 'Añadidos',
            machinesRetained: 'Una máquina que ya no está en esta cuenta',
            open: 'Abrir',
            review: 'Revisar',
            seeAll: 'Ver todo',
            allResults: 'Todos los resultados',
            categoriesLabel: 'Categorías',
            runOnNoneChosen: 'Ninguna máquina elegida',
            runOnNoneAvailable: 'Todavía ninguna máquina puede ejecutarlo',
            runsEverywhere: 'En cada máquina que ejecuta Happier',
            kinds: {
                agent: 'Agente',
                providers: 'Proveedor de modelos',
                scmHostingProviders: 'Alojamiento de código',
                scmBackends: 'Control de versiones',
                voice: 'Voz',
                connectedAccounts: 'Servicio conectado',
                inputTypes: 'Tipos de entrada',
                mcp: 'Herramientas MCP',
                pluginUi: 'Paneles de la app',
                pluginBrowser: 'Vistas de navegador',
                composer: 'Herramientas del compositor',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const es = {
    title: 'Revisión de actualizaciones',
    confirmSubtitle: 'Las actualizaciones que amplían el acceso que concediste te preguntan primero.',
    autoApplySubtitle: 'Las actualizaciones se aplican sin preguntar, aunque amplíen su acceso.',
    confirmOption: 'Preguntar',
    autoApplyOption: 'Automático',
};

const pluginUpdateReviewTranslations = { es: es };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { es: {
    webhookAdministration: {
        title: 'Webhooks de complemento',
        footer: 'Puntos finales de cuentas, destinos de máquinas exactos, colas de entrega y recuperación de mensajes no entregados. Los cuerpos de entrega nunca se muestran aquí.',
        unavailableTitle: 'Los webhooks de plugin no están disponibles',
        unavailableSubtitle: 'Este servidor no ha habilitado la recepción de webhooks de plugin.',
        endpointsTitle: 'Puntos finales de webhook',
        emptyTitle: 'Sin puntos finales de webhook complementarios',
        emptySubtitle: 'Los puntos finales creados por complementos instalados permanecerán visibles aquí, incluidos los puntos finales cuyo objetivo no está disponible.',
        loadError: 'No se pudo cargar el estado del webhook.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `En cola ${queued} · reintentando ${retrying} · reclamado ${claimed} · letra muerta ${deadLetter}`,
        copyUrl: 'Copiar la URL del webhook',
        selectTarget: 'Seleccionar destino de entrega',
        retarget: 'Reorientar el punto final',
        retargetUnavailable: 'Seleccione una materialización de complemento exacta disponible antes de reorientar este punto final.',
        originSelected: 'La materialización exacta del complemento seleccionado se volverá a verificar cuando continúe.',
        originUnavailable: 'No se ha seleccionado ninguna materialización exacta del complemento disponible.',
        movePendingTitle: '¿Mover entregas pendientes?',
        movePendingBody: '¿Mover las entregas en cola y de mensajes fallidos al nuevo objetivo exacto? Las entregas reclamadas activamente se mantienen en su objetivo actual.',
        resumePendingMove: 'Reanudar movimiento pendiente de entrega',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} Las entregas en cola o de mensajes no entregados siguen utilizando el destino exacto anterior.`,
        configureCredential: 'Configurar credencial de firma',
        rotateCredential: 'Rotar credencial de firma',
        finishRotation: 'Finalizar la rotación de credenciales',
        finishRotationSubtitle: 'Deja de aceptar la credencial anterior ahora.',
        credentialSecretTitle: 'Guarde el nuevo secreto de firma',
        credentialSecretBody: ({ secret }: { secret: string }) => `Este secreto se muestra una vez. Guárdalo antes de cerrar este mensaje.\n\n${secret}`,
        revoke: 'Revocar punto final',
        revokeTitle: '¿Revocar el punto final del webhook?',
        revokeBody: 'Se rechazarán nuevas entregas a este punto final. Los metadatos de entrega existentes permanecen disponibles según la política de retención.',
        operationFailed: 'La operación del webhook no se completó. Actualice el estado actual antes de volver a intentarlo.',
        deliveryTitle: ({ digest }: { digest: string }) => `carta muerta ${digest}`,
        deliveryStatus: 'Estado de entrega',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} intentos · ${replays} repeticiones · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} Admisiones Automatización no resueltas`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Muestra: ${sample} · ${omittedCount} no mostrado`,
        replay: 'Entrega de repetición',
        discardTitle: '¿Descartar la entrega?',
        discardBody: 'El cuerpo de entrega cifrado o almacenado sin formato se eliminará y no podrá recuperarse.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { es: translated({
        profilesPage: {
            searchPlaceholder: 'Buscar perfiles',
            emptyTitle: 'Aún no hay perfiles',
            newProfileTitle: 'Perfil nuevo',
            notFoundTitle: 'Este perfil ya no existe',
            notFoundDescription: 'Puede que se haya eliminado desde otro dispositivo.',
            backToProfiles: 'Volver a los perfiles',
            discardDraft: 'Descartar',
            detailDescription: 'Se usa cuando una sesión nueva empieza con este perfil.',
            builtInDetailDescription: 'Un perfil ya preparado. Al guardar los cambios se crea tu propia copia.',
            enabledHint: 'Se ofrece cuando eliges un perfil para una sesión nueva.',
            pickerSection: 'Selector de perfil',
            pickerSectionDescription: 'Dónde aparece esta opción al empezar una sesión.',
            showFirst: 'Mostrar primero',
            showFirstDescription: 'Muestra el entorno de la máquina entre tus favoritos.',
            environmentDescription: 'Variables de entorno que se definen cuando una sesión empieza con este perfil. Los valores pueden referirse a variables de la máquina.',
            descriptionTitle: 'Descripción',
            descriptionHint: 'Opcional. Se muestra al elegir este perfil.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const es: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: 'Conecta una fuente de modelos una vez y usa sus modelos con todos los agentes compatibles.',
        foundOn: ({ machine }: { machine: string }) => `Encontrado en ${machine}`,
        foundOnThisMachine: 'Encontrado en esta máquina',
        connect: 'Conectar',
        start: 'Iniciar',
        test: 'Probar',
        addProvider: 'Añadir un proveedor',
        customEndpoint: 'Endpoint personalizado',
        menuOwnCategory: 'Propio',
        menuCatalogCategory: 'Del catálogo',
        newTitle: 'Nuevo proveedor',
        emptyDescription: 'Añade un proveedor del catálogo o tu propio endpoint compatible.',
        machineScopeLabel: 'Configurado en',
        invitationTitle: 'Trae tus propios modelos',
        invitationDescription: 'Conecta un proveedor una vez y sus modelos aparecen en el selector de modelos de todos los agentes compatibles. Los servidores locales como Ollama se ejecutan en tu máquina.',
        invitationNeedsMachine: 'Los proveedores se conectan y se comprueban en una de tus máquinas. Añade una máquina para empezar.',
        setUpMachine: 'Configurar una máquina',
        duplicateAsCustom: 'Copiar como proveedor personalizado',
        discard: 'Descartar',
        enabled: 'Activado',
        enabledDescription: 'Ofrecer sus modelos en los selectores de modelos de los agentes',
        saved: 'Guardada',
        replace: 'Reemplazar',
        addKey: 'Elegir clave',
        apiKeyDefaultDescription: 'Se usa en todas las máquinas salvo que una tenga su propia clave.',
        apiKeyMachineDescription: 'Se usa en esta máquina en lugar de la clave predeterminada.',
        availabilityTitle: 'Disponibilidad',
        availabilityDescription: 'Dónde pueden usar los agentes este proveedor.',
        modelsDescription: 'Elige qué modelos ofrecen los agentes en sus selectores de modelos.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} de ${total} visibles en los selectores de modelos`,
        modelsFilter: ({ count }: { count: number }) => `Filtrar ${count} modelos`,
        connectionTitle: 'Conexión',
        nameDescription: 'Se muestra en la lista de proveedores y en los selectores de modelos.',
        nameRequired: 'Añade un nombre.',
        nameTooLong: ({ max }: { max: number }) => `Usa ${max} caracteres o menos.`,
        managedTitle: 'Servicio local gestionado',
        endpointsTitle: 'Endpoints',
        endpointsDescription: 'Déjalo vacío para usar las direcciones que proporciona el proveedor.',
        overridesDescription: 'Adónde van las solicitudes. Cambia la dirección para todas las máquinas o solo para esta.',
        afterSavingTitle: 'Después de guardar',
        destinationDescription: 'Adónde enviará Happier las solicitudes de este proveedor.',
        destinationPending: 'Aparece cuando todos los endpoints están completos.',
    },
};

const providerCollectionTranslations = { es } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { es: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Proveedor: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Proveedor: ${provider} · ${connection}`,
        changedTitle: 'La configuración del proveedor ha cambiado',
        changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Esta sesión sigue usando la configuración de ${provider} · ${connection} con la que se inició.`,
        unavailableTitle: 'El proveedor ya no está disponible',
        unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} ya no está disponible para reanudar esta sesión.`,
        disabledTitle: 'El proveedor está desactivado',
        disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Habilita ${provider} · ${connection} antes de reanudar esta sesión.`,
        incompatibleTitle: 'El proveedor ya no es compatible',
        incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} ya no es compatible con el agente de esta sesión.`,
        restartAction: 'Reiniciar sesión', chooseModelAction: 'Elegir modelo',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const es: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Ir al hallazgo`,
    tag: { noFile: 'Sin archivo', outdated: 'Desactualizado', unplaced: 'No se puede ubicar', notInStory: 'Fuera de las paradas' },
    outdatedSummary: 'El código cambió después de la revisión.',
    askAboutFindingA11y: ({ title }) => `Preguntar sobre el hallazgo: ${title}`,
    tailTitle: 'Hallazgos sin parada',
    tailDescription: 'Se quedan aquí para que nada desaparezca cuando sus líneas no se pueden ubicar.',
    inContext: 'en contexto',
    fromReviewAt: ({ time }) => `de la revisión de las ${time}`,
    reviewLabel: 'Revisión:',
    enginesOf: ({ count, total }) => `${count} de ${total}`,
    enginesFinished: 'motores terminaron',
    enginesRunning: ({ count }) => (count === 1 ? '1 motor sigue revisando' : `${count} motores siguen revisando`),
    fromEngines: ({ engines, inStory }) => `de ${engines} · ${inStory} en el recorrido`,
    and: ' y ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} en el recorrido, ${elsewhere} en otra parte`,
    allInStory: 'todos en el recorrido',
    seeded: {
        title: 'Escrito después de la revisión, por una ejecución nueva.',
        body: ({ reviewers, time }) => `El narrador no revisó el código; cada hallazgo citado aquí viene de ${reviewers} a las ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Desde entonces cambió 1 archivo.' : `Desde entonces cambiaron ${count} archivos.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 hallazgo de ${engine}` : `${count} hallazgos de ${engine}`),
    publishedBefore: ({ time }) => `publicados a las ${time}, antes del recorrido`,
    steps: {
        reviewing: 'Revisando',
        engineProgress: ({ done, running }) => `${done} terminó · ${running} revisando`,
        reviewed: ({ count }) => (count === 1 ? 'Revisado · 1 hallazgo' : `Revisado · ${count} hallazgos`),
        reviewedShort: ({ count }) => `Revisado · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 hallazgo` : `${engine} · ${count} hallazgos`),
        reviewedAt: ({ time }) => `Revisado a las ${time}`,
        reviewAt: ({ time }) => `Revisión de las ${time}`,
        partial: ({ count }) => (count === 1 ? 'Revisión parcial · 1 hallazgo' : `Revisión parcial · ${count} hallazgos`),
        ready: 'Recorrido listo',
        readyShort: 'Recorrido',
        failed: 'El recorrido falló',
        narrating: 'Narrando',
        narratorWriting: ({ narrator }) => `${narrator} escribe`,
        writing: 'Escribiendo el recorrido',
        writingShort: 'Escribiendo',
    },
    writingWithFindings: 'Escribiendo el recorrido con los hallazgos…',
    dialog: {
        engines: 'Motores de revisión',
        selected: ({ count }) => `${count} seleccionados`,
        loadingEngines: 'Buscando motores de revisión…',
        noEngines: 'Ningún motor de revisión puede ejecutarse en la máquina de esta sesión.',
        findingsOnly: 'solo hallazgos',
        changes: 'Cambios',
        instructions: 'Instrucciones',
        instructionsPlaceholder: '¿Qué debe mirar la revisión?',
        defaultInstructions: 'Revisa estos cambios en cuanto a corrección, riesgo y pruebas que faltan.',
        alsoWalkthrough: 'Escribir también un recorrido',
        alsoWalkthroughBody: 'Cuando llegan los hallazgos, la misma ejecución escribe el recorrido con ellos en contexto. Nada lee los cambios dos veces.',
        narrator: 'Narrador',
        chooseNarrator: 'Elige un narrador',
        narratorSeveral: ({ count }) => `${count} motores revisan; un modelo escribe el recorrido con todos sus hallazgos.`,
        narratorFindingsOnly: ({ engine }) => `${engine} devuelve hallazgos, no texto. Un modelo escribe el recorrido a partir de ellos.`,
        noNarrator: 'Ninguno de estos motores puede escribir un recorrido. Añade un motor con modelo o desactiva el recorrido.',
        footerReviewThenWalkthrough: 'Revisando y luego escribiendo el recorrido',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} revisa · ${narrator} escribe`,
    },
    generated: {
        continues: ({ model }) => `${model} · continúa la revisión`,
        seeded: ({ model }) => `${model} · a partir de los hallazgos de la revisión`,
        handover: ({ narrator, engine }) => `${narrator}, a partir de los hallazgos de ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `La revisión de ${engines} no terminó.`,
        notClean: 'Es una revisión parcial, no una revisión limpia.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} terminó con 1 hallazgo.` : `${engines} terminó con ${count} hallazgos.`),
        retry: ({ engine }) => `Reintentar ${engine}`,
    },
    explain: { action: 'Explicar los hallazgos', running: 'Explicando los hallazgos', a11y: 'Pedir una explicación de los hallazgos en el recorrido', unknownModel: 'Modelo desconocido', requester: { user: 'un usuario', agent: 'un agente', plugin: 'un complemento', automation: 'una automatización', workflow: 'un flujo de trabajo', unknown: 'un solicitante desconocido' }, header: ({ model, time, requester = 'ti' }) => `Explicación de la revisión · ${model} · pedida por ${requester} a las ${time} · no es un veredicto` },
    finished: {
        title: 'Revisión terminada',
        openFindings: 'Abrir hallazgos',
        walkMeThrough: 'Guíame por los cambios',
        andMore: ({ count }) => `y ${count} más`,
        continues: 'Continúa esta ejecución de revisión: el revisor lo escribe con lo que ya leyó. No se analiza nada de nuevo.',
        narrates: ({ count }) => (count === 1
            ? 'La ejecución de revisión terminó. Una ejecución nueva escribe el recorrido con este hallazgo y los cambios; no volverá a revisar.'
            : `La ejecución de revisión terminó. Una ejecución nueva escribe el recorrido con estos ${count} hallazgos y los cambios; no volverá a revisar.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Revisión iniciada · ${engineCount} ${engineCount === 1 ? 'motor' : 'motores'} · ${fileCount} ${fileCount === 1 ? 'archivo' : 'archivos'}`,
        notStarted: ({ engines }) => `${engines} no empezó. Los demás están revisando.`,
        narrationFailed: 'La revisión empezó, pero no se pudo pedir el recorrido. Los hallazgos llegarán igualmente.',
    },
};

const reviewWalkthroughTranslations = { es: { reviewWalkthrough: es } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { es: {
        rail: {
            label: 'Roles',
            title: 'Rol',
            searchPlaceholder: 'Buscar roles…',
            empty: 'Ningún rol coincide.',
            footer: 'Un rol trae sus propias instrucciones, motor y forma de ejecutarse, para que los flujos sigan siendo portables.',
            manage: 'Gestionar roles',
            engineAppliesOnStart: 'El motor se aplica al iniciar este rol',
            defaultEngine: 'Agente predeterminado',
            activeAccessibilityLabel: 'Roles, hay un rol en uso',
        },
        settings: {
            description: 'Quién hace cada tipo de trabajo. Los flujos y orquestadores piden un rol; el rol dice cómo ejecutarlo.',
            count: ({ count }) => (count === 1 ? '1 rol' : `${count} roles`),
            newRole: 'Nuevo rol',
            groupBuiltIn: 'Integrados',
            groupYours: 'Tuyos',
            groupShared: 'Compartidos contigo',
            groupPlugins: 'De plugins',
            edited: 'Editado',
            sourceBuiltIn: 'Integrado',
            sourceYours: 'Tuyo',
            sourceShared: 'Compartido contigo',
            sourcePlugin: ({ plugin }) => `De ${plugin}`,
            migrated: 'de los subagentes 0.2',
            migratedNote: 'Los roles marcados «de los subagentes 0.2» vienen de tu guía de subagentes: su descripción ahora son las instrucciones, su agente y modelo el motor.',
            nameTitle: 'Nombre',
            newRoleName: 'Rol sin título',
            instructionsTitle: 'Instrucciones',
            instructionsDescription: 'Qué hace, cuándo usarlo y cómo informar. Los agentes lo leen al repartir trabajo.',
            resetToDefault: 'Restablecer',
            readOnlyNote: 'Compartido contigo para ver. Tus elecciones de motor y perfil siguen siendo tuyas.',
            howItRunsTitle: 'Cómo se ejecuta',
            engineTitle: 'Motor',
            engineDescription: 'Agente, modelo y esfuerzo.',
            engineFollowsDefault: 'Sigue tu agente predeterminado.',
            engineUnavailable: 'No disponible aquí. Elige un motor.',
            runsAsTitle: 'Se ejecuta en',
            runsAsSession: 'Sesión',
            runsAsBackgroundRun: 'Ejecución en segundo plano',
            runsAsSessionDescription: 'Una sesión que puedes abrir y dirigir.',
            runsAsBackgroundDescription: 'Se ejecuta en segundo plano e informa; no hay sesión que dirigir.',
            handsOffTitle: 'Sin editar',
            handsOffDescription: 'Planifica y delega; no edita archivos por sí mismo.',
            secondOpinionTitle: 'Segunda opinión',
            secondOpinionDescription: 'Recomendada le pide considerar una segunda opinión antes de un pull request o de dar el trabajo por terminado.',
            secondOpinionOff: 'Desactivada',
            secondOpinionEncouraged: 'Recomendada',
            enabledTitle: 'Disponible',
            enabledDescription: 'Se ofrece en el panel de roles y a los orquestadores.',
            advancedTitle: 'Avanzado',
            launchProfileTitle: 'Perfil de inicio',
            launchProfileDescription: 'Entorno, permisos, máquina',
            launchProfileNone: 'Ninguno',
            profileUnavailable: 'Perfil no disponible',
            previewTitle: 'Lo que leen los agentes',
            previewDescription: 'El bloque que se envía en cada turno, tal cual.',
            deleteRole: 'Eliminar rol',
            deleteConfirmTitle: '¿Eliminar este rol?',
            deleteConfirmBody: ({ name }) => `${name} se elimina para ti y para todos con quienes se comparte. Las sesiones que lo usan conservan su copia.`,
            share: 'Compartir…',
            sendCopyFailed: 'No se pudo enviar una copia.',
            saveFailed: 'No se pudo guardar el rol.',
            loadFailed: 'No se pudieron cargar tus roles.',
            emptyDetailTitle: 'Elige un rol',
            emptyDetailBody: 'Elige un rol para ver sus instrucciones y cómo se ejecuta.',
        },
        delegation: {
            title: 'Delegación',
            description: 'Cómo los agentes pasan trabajo a otros agentes.',
            depthTitle: 'Profundidad de trabajo',
            approvalReviewer: 'Revisor de permisos',
            approvalReviewerDescription: 'Revisar automáticamente las solicitudes de bajo riesgo, una sola vez. Las acciones sensibles requieren tu aprobación. Solo en modos Predeterminado y Aceptar cambios.',
            approvedByReviewer: 'Permitido una vez por el revisor',
            depthDescription: 'Las sesiones, ejecuciones en segundo plano y flujos que inician los agentes pueden iniciar más. Este límite detiene cadenas descontroladas. Lo que inicias tú nunca está limitado.',
            depthSetting: 'Hasta dónde pueden delegar los agentes',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Un nivel. Después, el agente debe hacer el trabajo él mismo.'
                : `${count} niveles. Después, el agente debe hacer el trabajo él mismo.`),
            ladderRoot: 'Trabajo que inicias tú',
            ladderRootDetail: 'Iniciado por ti · sin límite',
            ladderLevel: ({ level }) => `Nivel ${level}`,
            ladderLevelDetail: 'Iniciado por un agente',
            ladderRefused: 'Una delegación más',
            ladderRefusedDetail: ({ level }) => `Nivel ${level} · rechazado; el agente lo hace él mismo`,
        },
        session: {
            useDefaults: 'Usar predeterminados',
            crossOwnerNote: 'Los roles se copiaron al iniciarse.',
            addRole: 'Añadir un rol a esta sesión',
            addRoleConfirm: 'Añadir rol',
            namePlaceholder: 'Nombre del rol',
            instructionsPlaceholder: 'Qué hace este rol y cuándo usarlo',
            notesTitle: 'Notas',
            notesPlaceholder: 'Lo que cada sesión de debajo debe saber',
            applyToReports: 'Aplicar a las sesiones de debajo',
            handsOffTitle: 'Sin editar',
            handsOffDescription: 'Planifica y delega; no edita archivos.',
            saveFailed: 'No se pudo guardar este cambio.',
            sectionTitle: 'Roles',
            allRoles: 'Todos los roles',
            inUse: ({ count }) => `${count} en uso`,
            changed: 'cambiado',
            thisSession: 'esta sesión',
            reset: 'Restablecer',
            newRoleForSession: 'Nuevo rol para esta sesión',
            changeForSession: 'Cambiar para esta sesión',
            editNotes: 'Editar notas',
            more: 'Más',
            info: 'Los roles se aplican a esta sesión y a las sesiones que dependen de ella.',
            countChanged: ({ count }) => `${count} cambiados`,
            countAdded: ({ count }) => `${count} añadidos`,
            addNotes: 'Añade notas sobre cómo debe orquestar esta sesión',
        },
        profiles: {
            sharedWithYouTitle: 'Compartidos contigo',
            sharedWithYouDescription: 'Perfiles que personas y equipos comparten contigo. Los valores secretos se quedan con sus dueños.',
            share: 'Compartir…',
            shareFailedTitle: 'No se pudo compartir este perfil',
            shareNeedsSavedSecrets: 'Los valores secretos nunca viajan. Mueve cada valor de este perfil a un Secreto guardado, vincúlalo y vuelve a compartir.',
            shareAwaitingApproval: 'La publicación de este perfil espera aprobación. Cuando se apruebe, vuelve a elegir «Compartir…».',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "es">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { es: {
        untitledRun: 'Ejecución de agente',
        intentTitles: { review: 'Revisión', plan: 'Plan', delegate: 'Tarea delegada' },
        thisMachine: 'esta máquina',
        menu: {
            cancelResponse: 'Cancelar esta respuesta',
            copyResult: 'Copiar resultado',
            showInTranscript: 'Mostrar en la transcripción',
            runDetails: 'Detalles de la ejecución',
            agent: 'Agente',
            permissions: 'Permisos',
            kind: 'Tipo',
            finishesOnItsOwn: 'Termina sola',
            staysOpen: 'Sigue abierta',
            started: 'Inicio',
            run: 'Ejecución',
            process: 'Proceso',
        },
        opening: { reading: ({ machine }) => `Leyéndola desde ${machine}.` },
        gone: {
            title: ({ machine }) => `Esta ejecución ya no está en ${machine}`,
            reason: 'Ya no se conserva allí, y la parte cargada de la transcripción no la incluye.',
            closeTab: 'Cerrar pestaña',
        },
        stopFailed: {
            title: {
                review: 'No se pudo detener esta revisión',
                plan: 'No se pudo detener este plan',
                delegate: 'No se pudo detener esta tarea',
                run: 'No se pudo detener esta ejecución',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} no confirmó la detención. Puedes detener toda la sesión; eso también detiene ${count === 1 ? 'el otro agente' : `los otros ${count} agentes`} que se ejecutan en ella.`,
            reasonAlone: ({ machine }) => `${machine} no confirmó la detención. Puedes detener toda la sesión.`,
            stopSession: 'Detener sesión…',
        },
        steps: {
            title: 'Cómo llegó ahí',
            count: ({ count }) => (count === 1 ? '1 paso' : `${count} pasos`),
        },
        review: {
            findings: 'Hallazgos',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} altos`,
            severity: { blocker: 'Bloqueante', high: 'Alta', medium: 'Media', low: 'Baja', nit: 'Detalle' },
            triageLabel: 'Qué hacer con este hallazgo',
            reviewerAsks: 'El revisor pregunta',
            answer: 'Responder',
            askAboutThis: 'Preguntar sobre esto',
            fixesSelected: ({ count }) => (count === 1 ? '1 corrección seleccionada' : `${count} correcciones seleccionadas`),
            noFixesSelected: 'Elige las correcciones que quieres aplicar',
            implementFixes: ({ count }) => (count === 1 ? 'Aplicar 1 corrección' : count > 1 ? `Aplicar ${count} correcciones` : 'Aplicar correcciones'),
            couldNotSaveChoice: 'No se pudo guardar tu elección.',
            reviewers: 'Revisores',
            findingTotal: ({ count }) => (count === 1 ? '1 hallazgo' : `${count} hallazgos`),
            moreFindings: ({ count }) => (count === 1 ? '1 hallazgo más' : `${count} hallazgos más`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 corrección por aplicar' : `${count} correcciones por aplicar`),
            verifiedFirst: 'Cada una se verifica primero y luego se corrige',
            replies: ({ count }) => (count === 1 ? '1 respuesta' : `${count} respuestas`),
            updatedAfterQuestion: 'Actualizado tras tu pregunta',
            reviewerUpdated: ({ reviewer }) => `${reviewer} actualizó el hallazgo`,
            askPlaceholder: 'Pregunta algo sobre este hallazgo…',
            askReviewerPlaceholder: 'Pregunta algo al revisor…',
            toReviewer: ({ reviewer }) => `Para ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Las preguntas van a ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Esperando a ${reviewer}…`,
            waitingForAnswers: 'Esperando a los revisores…',
            both: 'Ambos',
            reviewerCount: ({ count }) => `${count} revisores`,
            askReviewersPlaceholder: 'Haz una pregunta a los revisores…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Las preguntas van a los dos revisores' : `Las preguntas van a los ${count} revisores`),
            stillReviewing: 'Todavía revisando',
            reviewerDidNotFinish: 'No terminó',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Un revisor no empezó' : `${count} revisores no empezaron`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} no pudo empezar.`,
            notSaved: 'Este hallazgo no se guardó, así que aún no admite una decisión.',
            decisionsUnavailable: 'No se pudieron cargar tus decisiones.',
            followUpUnavailable: {
                notResumable: 'Esta revisión terminó; las preguntas necesitan una revisión que siga abierta.',
                ended: 'Esta revisión no terminó bien, así que no admite preguntas.',
                resumeUnavailable: 'El revisor ya no está disponible en esta máquina.',
                busy: 'El revisor sigue ocupado. Inténtalo de nuevo en un momento.',
                failed: 'No se pudo enviar tu pregunta.',
            },
        },
        launcher: {
            titles: { review: 'Pedir una revisión', plan: 'Pedir un plan', delegate: 'Delegar una tarea' },
            descriptions: {
                review: ({ machine }) => `Cada agente revisa los cambios en ${machine} por su cuenta; aquí recibes un resultado de cada uno.`,
                plan: ({ machine }) => `El agente lee el código en ${machine} y propone un plan aquí. No cambia nada.`,
                delegate: ({ machine }) => `El agente trabaja en ${machine} con los permisos de abajo e informa aquí.`,
            },
            whatFor: 'Para qué',
            who: { review: 'Quién revisa', plan: 'Quién planifica', delegate: 'Quién lo hace' },
            selectedCount: ({ count }) => `${count} seleccionados`,
            focus: {
                review: '¿En qué deben fijarse?',
                plan: '¿Qué debe cubrir el plan?',
                delegate: '¿Qué debe hacer?',
            },
            optional: 'opcional',
            start: {
                review: ({ count }) => (count > 1 ? `Iniciar ${count} revisiones` : 'Iniciar revisión'),
                plan: 'Iniciar plan',
                delegate: 'Iniciar tarea',
            },
            runsOn: ({ machine }) => `Se ejecuta en ${machine}`,
            checking: 'Comprobando qué agentes pueden ejecutarse aquí',
            unavailableTitle: 'Los agentes no pueden empezar en esta sesión',
            unavailableReason: 'Su máquina no ofrece ahora revisiones, planes ni tareas delegadas.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "es">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { es: {
        scmComparison: translated({
            view: { files: 'Archivos', walkthrough: 'Recorrido', commits: 'Commits' },
            scope: {
                workingTree: 'Cambios pendientes',
                session: 'Esta sesión',
                turn: 'Turno',
                latestTurn: 'Último turno',
                branch: ({ head, base }) => `${head} frente a ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `desde las ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'turno' : 'turnos'} con cambios`,
            scopePicker: {
                a11y: 'Cambios que mostrar',
                branchChoice: 'Rama contra base',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Rama o referencia de cabecera',
                baseRef: 'Rama o referencia base',
                parentRef: 'Referencia padre (opcional)',
                explainAndCommit: 'Explicar y hacer commit',
                explainOnly: 'Solo explicar',
                unavailable: 'No disponible en esta sesión',
                pendingDescription: 'Sin commit · puede proponer commits',
                sessionDescription: 'Todo lo que cambió, inicio → ahora',
                turnDescription: 'En orden, como lo hizo el agente',
                branchDescription: 'Cambios desde la base compartida',
                commitDescription: 'Cambios introducidos por este commit',
                pullRequestDescription: 'Cambios propuestos por esta pull request',
            },
            fileCount: ({ count }) => `${count} ${count === 1 ? 'archivo' : 'archivos'}`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'cambio' : 'cambios'}`,
            changedFiles: 'Archivos modificados',
            startReview: 'Iniciar revisión',
            proposeCommits: 'Proponer commits',
            explain: 'Explicar',
            explainA11y: 'Explicar: mostrar las notas del recorrido junto a los cambios',
            viewA11y: 'Vista',
            lockfileTag: 'Lockfile',
            generatedTag: 'Generado',
            lockfileCollapsed: 'Lockfile, contraído.',
            generatedCollapsed: 'Archivo generado, contraído.',
            showDiff: 'Mostrar diferencias',
            unsupportedReason: 'Archivos aún no puede mostrar esta comparación. Los cambios siguen en Git.',
            showPendingChanges: 'Mostrar cambios pendientes',
            capturedStale: 'El origen cambió. Estos archivos conservan la comparación capturada.',
            capturedFreshnessUnknown: 'Se muestran los archivos capturados. No se pudo comprobar el estado actual del origen.',
            keys: { nextFile: 'archivo siguiente', nextChange: 'cambio siguiente' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const es: SecretsSettingsCopy = {
    purpose: 'Claves API y tokens que usan tus agentes y servidores MCP. Un valor no se vuelve a mostrar después de guardarlo.',
    yoursTitle: 'Tus secretos',
    yoursDescription: 'Secretos que guardaste o que te pertenecen. Elígelos donde Happier pida una clave.',
    sharedWithYouTitle: 'Compartidos contigo',
    sharedWithYouDescription: 'Otras personas te permiten usarlos. Puedes elegirlos, pero no verlos ni cambiarlos.',
    add: 'Añadir secreto',
    newSecret: 'Nuevo secreto',
    emptyTitle: 'Aún no hay secretos',
    emptyDescription: 'Añade una clave API o un token una vez y elígelo donde Happier lo pida.',
    staleTitle: 'No se pudieron actualizar los secretos compartidos',
    staleDescription: 'Se muestra la última lista conocida.',
    valueTitle: 'Valor',
    valueSaved: 'Guardado. No se vuelve a mostrar.',
    keepTitle: 'Guardarlo como',
    keepPersonal: 'Personal',
    keepShared: 'Compartido',
    keepPersonalDescription: 'Se guarda en tu cuenta. Solo tú puedes usarlo.',
    keepSharedDescription: 'Se guarda en este Home para que puedas compartirlo con personas, Teams o Grupos.',
    accessTitle: 'Quién puede usarlo',
    accessOnlyYou: 'Solo tú',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Tú y 1 destinatario' : `Tú y ${count} destinatarios`),
    sharePersonalDescription: 'Al compartirlo se mueve a este Home. No puede volver a ser personal.',
    share: 'Compartir',
    manage: 'Gestionar',
    storageTitle: 'Almacenamiento',
    storageE2ee: 'Cifrado de extremo a extremo',
    storageE2eeDescription: 'Solo las personas con quienes lo compartes pueden leerlo.',
    storagePlain: 'Gestionado por el Home',
    storagePlainDescription: 'Este Home lo guarda y puede leerlo para entregarlo.',
    save: 'Guardar secreto',
};

const secretsSettingsTranslations = { es } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "es": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Acceso a la sesión",
        search: "Buscar personas, grupos o equipos",
        hasAccess: "Tiene acceso",
        yourAccess: "Tu acceso",
        readOnly: "Puedes consultar cómo tienes acceso. Solo quienes administran la sesión pueden hacer cambios.",
        sourceDirect: "Acceso directo",
        sourceTeam: "Acceso mediante un equipo",
        sourceGroup: "Acceso mediante un grupo",
        people: "Personas",
        groups: "Grupos",
        teams: "Equipos",
        account: "Persona",
        group: "Grupo",
        team: "Equipo",
        view: "Puede ver",
        edit: "Puede dirigir",
        admin: "Administrar",
        owner: "Propietario",
        private: "Privada",
        custom: "Acceso personalizado",
        required: "Obligatorio por la política del equipo",
        subjectNotFound: "Esta persona, grupo o equipo ya no está disponible.",
        subjectIneligible: "Esta persona, grupo o equipo ya no puede recibir acceso.",
        teamPolicyRequired: "La política del equipo exige este acceso.",
        selfGrantManaged: "Otro administrador de acceso debe cambiar tu acceso.",
        homeUnsupported: "Este Home todavía no admite el acceso a sesiones. Actualízalo para gestionar quién puede abrir esta sesión.",
        openCollaboration: "Abrir Colaboración",
        authenticationRequired: "Inicia sesión con un método aceptado por este equipo y vuelve a intentarlo.",
        authenticationUnavailable: "El método de inicio de sesión exigido por este equipo no está disponible en este Home.",
        delegation: "Puede aprobar solicitudes de permisos de ejecución",
        remove: "Quitar acceso",
        confirmRemove: "Confirmar eliminación",
        credentialsLost: ({ names }: { names: string }) => `Estas credenciales del equipo dejarán de funcionar aquí: ${names}`,
        ready: "Acceso cifrado listo",
        prepared: "Acceso cifrado preparado",
        recipientRepairRequired: "Esta persona debe reparar la configuración de cifrado de su cuenta.",
        pending: "Acceso cifrado pendiente",
        setup: "Debes configurar el cifrado",
        repair: "El acceso cifrado necesita reparación",
        unavailable: "Contenido cifrado no disponible",
        notRequired: "Esta sesión no está cifrada, así que no hay nada que preparar.",
        preparing: "Preparando el acceso cifrado…",
        preparingProgress: ({ count }: { count: number }) => `Preparando el acceso cifrado… ${count} preparados`,
        preparationPending: ({ count }: { count: number }) => `Acceso cifrado pendiente para ${count} personas`,
        preparationSetup: ({ count }: { count: number }) => `${count} personas necesitan configurar el cifrado`,
        preparationRepair: ({ count }: { count: number }) => `El acceso cifrado necesita reparación para ${count} personas`,
        preparationKeyUnavailable: "Este dispositivo no puede preparar el acceso cifrado para esta sesión.",
        preparationFailed: "Se guardó el acceso, pero falló la preparación del acceso cifrado.",
        preparationPassFailed: "Falló la preparación del acceso cifrado.",
        preparationAnnouncedComplete: "Preparación del acceso cifrado completada.",
        preparationAnnouncedNeedsAttention: "El acceso cifrado aún necesita configuración o reparación.",
        preparationCheckFailed: "No se pudo comprobar el acceso cifrado.",
        outcomeUnknown: "El resultado es incierto. Happier está comprobando el acceso actual antes de que vuelvas a intentarlo.",
        historicalLayoutNotice: "Las personas con las que compartes esta sesión no pueden abrirla hasta que se actualice para esta versión de Happier.",
        historicalLayoutUpdate: "Actualizar para compartir",
        homeReconciled: "El acceso a la sesión se restableció para el nuevo Home.",
        lockedTitleFallback: "Sesión cifrada",
        encryptedAccess: "Acceso cifrado",
        aggregatePrepared: ({ count }: { count: number }) => `${count} preparados`,
        aggregatePending: ({ count }: { count: number }) => `${count} pendientes`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} necesitan configuración o reparación`,
        prepareNow: "Preparar ahora",
        prepareAgain: "Preparar otra vez",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Preparando el acceso cifrado… ${count} de ${total}`,
        showAllRecipients: "Mostrar todas las personas",
        hideAllRecipients: "Ocultar personas",
        moreRecipients: "Mostrar más personas",
        recipientPlainAccount: "Cuenta sin cifrado",
        pendingBody: "Esta sesión está cifrada. Alguien con administración aún debe preparar tu acceso cifrado antes de que se abra aquí.",
        setupBody: "Termina la configuración del cifrado en esta cuenta y después alguien con administración podrá preparar tu acceso a esta sesión.",
        setupAction: "Configurar el cifrado",
        repairBody: "La clave entregada para esta sesión no se pudo abrir en este dispositivo. Vuelve a intentarlo o pide a quien administra la sesión que prepare el acceso otra vez.",
        retryAction: "Reintentar",
        unavailableBody: "La clave se abrió, pero no se pudo descifrar el contenido de esta sesión. Quien administra la sesión puede preparar el acceso otra vez.",
        openAccessAction: "Abrir acceso a la sesión",
        removedTitle: "Acceso retirado",
        removedBody: "No puedes abrir esta sesión con tu acceso actual. Quien administra la sesión puede compartirla otra vez.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} retirado del acceso a la sesión`,
        browseMore: "Explorar todo",
        allLoaded: "Todos los resultados cargados",
        help: "Puede ver permite leer. Puede dirigir permite dirigir al Agente según sus permisos de herramientas. Administrar también permite gestionar el acceso. No es un chat aislado: la carpeta de trabajo y el nombre del autor no limitan el acceso al shell, archivos o red."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const es: typeof en = {
    status: {
        queued: 'En cola',
        starting: 'Iniciando',
        running: 'En ejecución',
        waiting: 'Esperando',
        blocked: 'Bloqueado',
        succeeded: 'Completado',
        failed: 'Ha fallado',
        timedOut: 'Tiempo agotado',
        cancelled: 'Detenido',
        unknown: 'Desconocido',
    },
    attention: {
        permission: 'Necesita aprobación',
        userAction: 'Necesita tu respuesta',
        both: 'Necesita atención',
        bothDescription: 'Necesita aprobación y tu respuesta',
    },
    runKind: {
        conversation: 'Conversación',
        review: 'Revisión',
        plan: 'Plan',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Equipo ${team} · ${count} ${count === 1 ? 'agente' : 'agentes'}`,
        teamActionsA11y: 'Acciones del equipo',
        openWork: 'Abrir',
        needsYouCount: ({ count }) => `${count} te necesitan`,
        runningCount: ({ count }) => `${count} en ejecución`,
        nothingRunning: 'Nada en ejecución.',
        startAgent: 'Iniciar un agente',
        machineOffline: ({ machine }) => `${machine} no responde`,
        machineOfflineUnnamed: 'La máquina no responde',
        launch: {
            menuA11y: 'Iniciar un agente',
            conversationDescription: 'Habla con un agente junto a esta sesión',
            reviewDescription: 'Revisa los cambios hasta ahora',
            planDescription: 'Planifica los siguientes pasos',
            delegateDescription: 'Delega una tarea y recíbela hecha',
            advancedDescription: 'Elige agentes, permisos y perfil',
        },
        empty: {
            title: 'Pon más agentes en esta sesión',
            reason: ({ machine }) => `Empieza una conversación paralela, o pide una revisión o un plan mientras sigues trabajando. Se ejecutan en ${machine} y te informan aquí.`,
            reasonUnnamed: 'Empieza una conversación paralela, o pide una revisión o un plan mientras sigues trabajando. Te informan aquí.',
            moreWays: 'Pide una revisión, un plan o una delegación',
        },
        unavailable: {
            notEnabled: 'Los agentes no pueden iniciarse en este Home.',
            machineOffline: ({ machine }) => `Para iniciar agentes, ${machine} debe estar en línea.`,
            machineOfflineUnnamed: 'Para iniciar agentes, esta máquina debe estar en línea.',
            sessionInactive: 'Esta sesión se detuvo. Reanúdala para iniciar agentes aquí.',
            externalRunnerInactive: 'Esta sesión se inició fuera de Happier. Los agentes pueden iniciarse desde aquí mientras Happier esté conectado.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { es };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { es: {
        title: 'Tablero',
        views: {
            label: 'Vistas del tablero',
            overview: 'Resumen',
            createTitle: 'Nueva vista del tablero',
            renameTitle: 'Renombrar la vista del tablero',
            reconciled: ({ title }) => `Esa vista del tablero se eliminó. Mostrando ${title}.`,
            empty: {
                title: 'Nada en esta vista',
                reason: 'Añade un widget aquí o cambia a otra vista del tablero.',
            },
            actions: {
                create: 'Nueva vista',
                rename: 'Renombrar la vista',
                moveBefore: 'Mover la vista antes',
                moveAfter: 'Mover la vista después',
                remove: 'Eliminar la vista',
            },
            remove: {
                title: ({ title }) => `¿Eliminar «${title}»?`,
                moveMessage: ({ title }) => `Sus widgets pasan a ${title}. No se elimina nada de la sesión.`,
                unpinMessage: 'Sus widgets siguen en la sesión, pero dejan de estar fijados a una vista.',
            },
        },
        add: { note: 'Nota', interactiveView: 'Vista interactiva' },
        width: { compact: 'Estrecho', medium: 'Medio', wide: 'Ancho', full: 'Ancho completo' },
        height: { auto: 'Ajustar al contenido', compact: 'Baja', regular: 'Media', tall: 'Alta' },
        board: {
            loading: { title: 'Abriendo el tablero', reason: 'Cargando lo que está fijado en esta sesión.' },
            locked: {
                title: 'El tablero sigue cifrado',
                reason: 'Este dispositivo aún no puede abrir la sesión. No se perdió nada.',
            },
            unopenable: {
                title: 'No se puede leer la organización del tablero',
                reason: 'No se pudo abrir la organización guardada. Los widgets en sí no se ven afectados.',
            },
            unsupported: {
                title: 'Este tablero necesita un Happier más reciente',
                reason: 'Todo se conserva. Ábrelo en un dispositivo compatible o actualiza Happier.',
            },
            unavailable: {
                title: 'El tablero todavía no está disponible aquí',
                reason: 'No se perdió nada. Aparecerá cuando este Home active los tableros.',
            },
            offline: 'Sin conexión: ves la última versión que cargaste.',
            offlineEmpty: 'Sin conexión: vuelve a conectarte para cargar este tablero.',
            stale: 'Ves la última versión que cargaste.',
        },
        empty: {
            editor: {
                title: 'Ten el plan junto al chat',
                description: 'Las notas y vistas en vivo que se fijan aquí se quedan con esta sesión, para todo el que pueda leerla.',
                askAgent: 'Pedírselo al agente',
                askAgentPrompt: 'Coloca en este tablero algo que muestre ',
                addNote: 'Añadir una nota',
            },
            viewer: {
                title: 'Todavía no hay nada en el tablero',
                description: 'Aquí aparecerá lo que las personas o los agentes fijen en esta sesión.',
            },
        },
        item: {
            untitled: 'Widget sin título',
            renameA11y: 'Título del widget',
            reorderA11y: ({ title }) => `Reordenar ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Leer y editar', movement: 'Movimiento', geometry: 'Tamaño', destructive: 'Eliminar' },
            loading: { title: 'Cargando este widget', reason: 'Obteniendo su contenido de este Home.' },
            locked: {
                title: 'Contenido cifrado no disponible',
                reason: 'Este widget seguirá cifrado hasta que este dispositivo pueda abrir la sesión.',
            },
            unopenable: {
                title: 'No se puede mostrar este widget',
                reason: 'No se pudo leer su contenido guardado. El resto del tablero sigue disponible.',
            },
            unsupported: {
                title: 'Este widget necesita un Happier más reciente',
                reason: 'Su contenido se conserva. Ábrelo en un dispositivo compatible o actualiza Happier.',
            },
            missing: {
                title: 'No se encuentra este widget',
                reason: 'El tablero sigue apuntando a él, pero su contenido no está en este Home.',
            },
            removed: {
                title: 'Este widget se quitó del tablero',
                reason: 'Alguien con permiso de edición lo borró para todo el mundo.',
            },
            pluginUnavailable: {
                title: 'Plugin no disponible en este dispositivo',
                reason: 'El widget se conserva. Volverá a mostrarse cuando el plugin esté disponible aquí.',
            },
            rendererUnavailable: {
                title: 'No se puede mostrar este widget en este dispositivo',
                reason: 'Su contenido se conserva. Ábrelo donde se admitan las vistas interactivas.',
            },
            provenance: {
                note: 'Nota',
                interactiveView: 'Vista interactiva',
                pluginMissing: ({ pluginId }) => `De ${pluginId} · no instalado`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Quitar del tablero',
                openHere: 'Abrir aquí',
                managePlugin: 'Gestionar el plugin',
                prepareEncryption: 'Configurar el cifrado',
                readFull: 'Leer la nota completa',
                rename: 'Cambiar el nombre del widget',
                unpin: 'Quitar de esta vista',
                moveToView: ({ title }) => `Mover a ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} se movió antes.`,
                after: ({ title }) => `${title} se movió después.`,
                reordered: ({ title }) => `${title} se movió.`,
                toView: ({ title, view }) => `${title} se movió a ${view}.`,
            },
            movePosition: ({ position, total }) => `Posición ${position} de ${total}`,
            moveTargetView: ({ title }) => `Vista del tablero ${title}`,
            remove: {
                title: '¿Quitar este widget?',
                message: 'Lo pierde todo el mundo que pueda leer esta sesión. Los plugins instalados siguen instalados.',
            },
        },
        note: {
            titlePlaceholder: 'Título',
            titleA11y: 'Título de la nota',
            untitled: 'Nota sin título',
            offline: 'Para guardar hace falta conexión con este Home.',
            unavailable: 'Los cambios del tablero aún no están disponibles en este Home.',
            failed: 'Happier no pudo guardar esta nota. Tu texto sigue aquí.',
            outcomeUnknown: 'Happier no pudo confirmar si la nota se guardó. Actualiza antes de volver a guardar.',
            saved: 'Nota guardada',
            conflict: {
                message: 'Esta nota cambió en otro dispositivo.',
                reviewLatest: 'Ver la última versión',
                applyMine: 'Aplicar mis cambios',
                latestHeading: 'Última versión',
            },
        },
        recovered: {
            title: 'Elementos recuperados',
            description: 'Estos widgets están en la sesión pero no en ninguna vista del tablero.',
            pin: 'Añadir a esta vista',
        },
        mutation: {
            conflict: 'Este tablero cambió en otro dispositivo. Actualiza para ver lo último.',
            outcomeUnknown: 'Happier no pudo confirmar si ese cambio se guardó.',
            denied: 'Ya no tienes permiso para cambiar este tablero.',
            offline: 'Cambiar el tablero necesita conexión con este Home.',
            unavailable: 'Este Home todavía no puede cambiar el tablero.',
            updateRequired: 'Actualiza Happier para hacer este cambio en el tablero.',
            hostedHtmlSourceTooLarge: 'Esta vista interactiva es demasiado grande para guardarla. Tu borrador sigue aquí.',
            noteTooLarge: 'Esta nota es demasiado grande para guardarla. Tu texto sigue aquí.',
            invalid: 'Ese cambio del tablero no es válido. Revísalo e inténtalo de nuevo.',
            notFound: 'Ese elemento ya no está disponible. Actualiza el tablero.',
            storageFailed: 'Happier no pudo proteger ese cambio. Tu trabajo sigue aquí.',
            serverFailed: 'Este Home no pudo completar el cambio del tablero. Inténtalo de nuevo.',
            failed: 'Happier no pudo aplicar ese cambio del tablero.',
        },
        hostedHtmlApproval: {
            title: '¿Permitir esta vista interactiva?',
            body: 'La aprobación se aplica a esta vista en esta sesión. Para enviar un mensaje sigue siendo necesario hacer clic dentro de la vista.',
            resources: ({ count }) => (count === 1 ? 'Puede leer 1 recurso de la sesión' : `Puede leer ${count} recursos de la sesión`),
            actions: ({ count }) => (count === 1 ? 'Puede ejecutar 1 acción' : `Puede ejecutar ${count} acciones`),
            sendMessages: 'Puede pedir a Happier que envíe mensajes',
            loadsFrom: ({ origin }) => `Carga desde ${origin}`,
            allow: 'Permitir',
            notNow: 'Ahora no',
            declined: {
                title: 'Vista interactiva aún no permitida',
                reason: 'Revisa lo que solicita cuando quieras.',
                review: 'Revisar',
            },
        },
        sidebar: {
            openInDetails: 'Abrir en Detalles',
            openBoard: 'Abrir el tablero',
            sharedWithEveryone: 'Compartido con todos aquí',
            widgetCount: ({ count }) => `${count} widget${count === 1 ? '' : 's'}`,
        },
        mobile: { searchPlaceholder: 'Buscar en este tablero' },
        inline: {
            openBoard: 'Abrir el tablero',
            openBoardA11y: ({ title }) => `Abrir «${title}» en el tablero`,
        },
        companion: {
            title: 'Acompañante',
            inCompanionA11y: 'En tu acompañante',
            empty: {
                title: 'Mantén la sesión a la vista',
                reason: 'Pon el resumen de la sesión o un widget del tablero junto a tu chat: lo que se ejecuta, lo que te espera, lo que cambió.',
                note: 'Solo tú ves tu acompañante.',
            },
            pane: {
                besideChat: 'Junto a tu chat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 elemento' : `${count} elementos`,
                justForYou: 'Solo para ti, junto al chat',
            },
            actions: {
                addSummary: 'Añadir resumen de la sesión',
                addItem: ({ title }) => `Añadir ${title}`,
                moveToLeading: 'Mover al lado izquierdo',
                moveToTrailing: 'Mover al lado derecho',
                moveToFirst: 'Mover al principio',
                moveToLast: 'Mover al final',
                compact: 'Tamaño compacto',
                comfortable: 'Tamaño cómodo',
                openFull: 'Abrir acompañante completo',
                openOnBoard: 'Abrir en el tablero',
                collapse: 'Contraer acompañante',
                expand: 'Expandir acompañante',
                hide: 'Ocultar acompañante',
                addToCompanion: 'Añadir al acompañante',
                removeFromCompanion: 'Quitar del acompañante',
                undo: 'Deshacer',
                menuA11y: 'Opciones del acompañante',
                itemMenuA11y: ({ title }) => `Opciones de ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Acompañante, ${count} elementos`,
                show: ({ count }) => `Mostrar acompañante, ${count} elementos`,
                expand: ({ count }) => `Expandir acompañante, ${count} elementos`,
            },
            summary: {
                review: 'Revisar',
                title: 'Resumen de la sesión',
                untitled: 'Sesión',
                approvals: ({ count }) => `${count} esperándote`,
                workflows: ({ count }) => `${count} flujos en curso`,
                changedFiles: ({ count }) => `${count} cambiados`,
                tokens: ({ count }) => `${count} tokens`,
                contextPercent: ({ percent }) => `${percent} % de contexto`,
                contextOnly: 'Contexto usado',
                moreDetails: 'Más detalles',
                moreDetailsA11y: ({ count }) => `Más detalles, ${count} filas más`,
                partial: 'Algunos detalles no se ven desde aquí.',
            },
            notices: {
                shown: 'Acompañante mostrado',
                hidden: 'Acompañante oculto',
                added: 'Añadido al acompañante',
                removed: 'Quitado del acompañante',
                reordered: 'Acompañante reordenado',
                moved: 'Acompañante movido',
                boardOpened: 'El agente abrió el tablero',
                returnedToChat: 'El agente volvió al chat',
                boardViewSelected: 'El agente seleccionó una vista del tablero',
                boardItemRevealed: 'El agente abrió un elemento del tablero',
                fullOpened: 'El agente abrió el acompañante',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "es">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "es"> = { es: {
        hereOne: ({ name }) => `${name} está aquí`,
        hereTwo: ({ first, second }) => `${first} y ${second} están aquí`,
        hereMany: ({ first, count }) => `${first} y ${count.toLocaleString()} personas más están aquí`,
        typingOne: ({ name }) => `${name} está escribiendo…`,
        typingMany: ({ count }) => `${count.toLocaleString()} personas están escribiendo…`,
        justYouHere: 'Solo estás tú',
        justYouHint: 'Las personas con quienes la compartas aparecerán aquí',
        you: 'Tú',
        presenceConnecting: 'Comprobando quién está…',
        presenceUnavailable: 'La presencia en directo no responde ahora mismo',
        presenceUnsupported: 'La presencia en directo no está disponible en esta Home',
        responsibleUnsupported: 'Esta Home no registra quién es responsable',
        inviteTitle: 'Habladlo junto a la sesión',
        inviteBody: 'Empieza una conversación, menciona a personas y pasa la respuesta al agente cuando estés listo.',
        readOnly: 'Puedes leerlas. Las personas que pueden editar esta sesión pueden escribir.',
        offline: 'Estás sin conexión · se muestran las últimas conversaciones',
        lockedTitle: 'Aún no se pueden abrir estas conversaciones en este dispositivo',
        lockedBody: 'Están cifradas de extremo a extremo y la configuración de cifrado de este dispositivo no coincide con la de la sesión.',
        revokedTitle: 'Ya no tienes acceso a estas conversaciones',
        revokedBody: 'Alguien que gestiona esta sesión cambió quién puede verla. Los mensajes que escribiste se quedan con la sesión.',
        namesTwo: ({ first, second }) => `${first} y ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} y ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} y ${count.toLocaleString()} más`,
        haveAccess: 'Tienen acceso',
        hasAccess: 'Tiene acceso',
        onlyYou: 'Solo tú',
        notShared: 'Aún no se ha compartido con nadie',
        publicLinkOn: 'Enlace público activado',
        accessLoading: 'Comprobando quién tiene acceso…',
        accessError: 'No se pudo cargar quién tiene acceso',
        shareTitle: 'Compartir esta sesión',
        shareBody: ({ home }) => `Las personas que añadas en ${home} pueden seguirla y unirse a sus conversaciones.`,
        collapse: 'Contraer',
        linkOn: 'Activado',
        linkOff: 'Desactivado',
        linkGrants: 'Cualquiera con el enlace puede ver la transcripción, sin cuenta.',
        linkExpires: ({ date }) => `Caduca el ${date}`,
        linkNeverExpires: 'No caduca nunca',
        linkAsksConsent: 'pide consentimiento',
        linkNoConsent: 'sin paso de consentimiento',
        linkHidden: 'Este enlace se creó antes y no se puede volver a mostrar. Crea uno nuevo para copiarlo.',
        qrCode: 'Código QR',
        hideQrCode: 'Ocultar código QR',
        newLink: 'Enlace nuevo…',
        turnOff: 'Desactivar',
        turnOffTitle: '¿Desactivar el enlace público?',
        turnOffBody: 'Quien tenga el enlace perderá el acceso de inmediato. Puedes crear uno nuevo más adelante.',
        newLinkReplaces: 'El enlace actual dejará de funcionar cuando se cree el nuevo.',
        linkDenied: 'Solo las personas que gestionan esta sesión pueden crear un enlace público.',
        linkLoadFailed: 'No se pudo comprobar el enlace público.',
        justYouTitle: 'Trabajad juntos en esta sesión',
        justYouBody: ({ home }) => `Compártela con personas de ${home}. Podrán seguirla, hablarla aquí y continuar mientras no estás.`,
        share: 'Compartir',
        justYouNote: 'O crea un enlace público que cualquiera pueda ver.',
        sharingOffTitle: ({ home }) => `${home} no comparte sesiones con personas`,
        sharingOffBody: 'Aun así puedes crear un enlace público que cualquiera pueda ver.',
        sharingOffPrivateBody: 'Las sesiones de esta Home se quedan contigo.',
        accessDenied: 'Solo las personas que gestionan esta sesión pueden cambiar quién tiene acceso. Tú aún puedes unirte a sus conversaciones.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "es"> = { es: { pane: sessionCollaborationPaneTranslations['es'], title: 'Colaboración', viewingNow: 'Viendo ahora', justYou: 'Solo tú', typing: 'Escribiendo…', stale: 'Puede estar desactualizado', unavailable: 'Presencia en directo no disponible', connecting: 'Conectando…', unnamed: 'Miembro de Happier', open: 'Abrir colaboración', conversations: 'Conversaciones', accessUnavailable: 'Acceso a la sesión no disponible', accessUnavailableReason: 'Este Home no admite compartir sesiones con personas.', discussion: { featureUnavailable: "Las conversaciones no están activadas en este Home.", bindingUnavailable: "Vuelve a iniciar sesión en este Home para ver las conversaciones.", scopeMismatch: "Estas conversaciones pertenecen a otra cuenta de este Home.", modeMismatch: "El contenido no coincide con el modo de cifrado de la sesión. Inténtalo de nuevo o pide a quien administra la sesión que revise el acceso.",  title: 'Conversaciones', newDiscussion: 'Nueva conversación', create: 'Crear conversación', titlePlaceholder: 'Título de la conversación', messagePlaceholder: 'Escribe un mensaje…', active: 'Activas', activeDisclosure: 'Mostrar conversaciones activas', archived: 'Archivadas', archivedDisclosure: 'Mostrar conversaciones archivadas', emptyActive: 'Aún no hay conversaciones activas.', emptyArchived: 'No hay conversaciones archivadas.', loading: 'Cargando conversaciones…', loadError: 'No se pudieron cargar las conversaciones.', retry: 'Intentar de nuevo', checking: 'Buscando novedades…', deliveryUnknown: 'No se sabe si se entregó — compruébalo antes de reintentar.', locked: 'Puedes leer esta conversación, pero no publicar en ella.', offline: 'No tienes conexión. Vuelve a conectarte para continuar.', unavailable: 'Esta conversación no está disponible.', unreadCount: ({ count }) => count === 1 ? '1 sin leer' : `${count.toLocaleString()} sin leer`, unreadMentionCount: ({ count }) => count === 1 ? '1 mención sin leer' : `${count.toLocaleString()} menciones sin leer`,
        mentioned: 'Te han mencionado', unreadConversations: 'Conversaciones sin leer', messageCount: ({ count }) => count === 1 ? '1 mensaje' : `${count.toLocaleString()} mensajes`, viaAgent: 'Mediante el Agente', collaborator: 'Colaborador', contentUnavailable: 'Mensaje no disponible', rename: 'Cambiar nombre de la conversación', archive: 'Archivar conversación', restore: 'Restaurar conversación', selection: { copy: 'Copiar', askAgent: 'Preguntar al Agente', sendToSession: 'Enviar a la sesión', handoffError: 'No se pudieron añadir los mensajes seleccionados al editor de la sesión.' }, titleRequired: 'Añade un título para iniciar esta conversación.', encryptedTitle: 'Conversación cifrada', archivedNotice: 'Esta conversación está archivada.', sessionArchived: 'Esta sesión está archivada.', postDenied: 'Ya no puedes publicar en esta sesión.', invalidMention: 'Alguien a quien mencionaste ya no puede leer esta sesión.', invalidContent: 'Este mensaje no se puede enviar tal como está. Puede estar vacío o ser demasiado largo.', idempotencyConflict: 'Ya se envió un mensaje diferente con esta identidad.', sendFailed: 'No se pudo enviar este mensaje.', dismiss: 'Descartar', loadOlder: 'Cargar mensajes anteriores', loadMore: 'Cargar más conversaciones' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { es: {
        status: {
            waitingForYou: 'Esperándote',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} se detuvo antes del paso ${step} de ${total}`,
            stepOfPlan: ({ step, total }) => `Paso ${step} de ${total} del plan`,
            agentFallback: 'El agente',
        },
        ask: {
            question: ({ summary }) => `¿${summary}?`,
            allow: 'Permitir',
            deny: 'Denegar',
            showInChat: 'Ver en el chat',
            moreWaiting: ({ count }) => `${count} más en espera`,
            allowed: ({ summary }) => `Permitido: ${summary}`,
            denied: ({ summary }) => `Denegado: ${summary}`,
            justNow: 'ahora mismo',
            failed: 'Tu respuesta no llegó a la sesión. Inténtalo de nuevo.',
            answerWhenBack: ({ machine }) => `Podrás responder cuando ${machine} vuelva.`,
            answerWhenSessionBack: 'Podrás responder cuando la sesión vuelva.',
            notAllowed: 'Solo quien puede ejecutar esta sesión puede responder.',
            groupA11y: 'Esperándote',
        },
        facts: {
            subagents: 'subagentes',
            changed: 'cambiados',
            context: 'contexto',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} de ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent} %`,
            opensAgents: 'Abre Agentes',
            opensGit: 'Abre Git',
            opensUsage: 'Abre el uso',
        },
        plan: {
            title: 'Plan',
            description: ({ agent }) => `La lista de tareas de ${agent} para esta sesión`,
            progress: ({ done, total }) => `${done} de ${total}`,
            progressA11y: ({ done, total }) => `${done} de ${total} hechas`,
            emptyTitle: 'Aún no hay plan',
            emptyReason: 'Cuando el agente escriba una lista de tareas, aparecerá aquí, paso a paso.',
            stepDone: 'Hecho',
            stepCurrent: 'Paso actual',
        },
        picker: {
            open: 'Añadir al Acompañante',
            chooseWidget: 'Elegir un widget…',
            onTheBoard: ({ source }) => `${source} · en el tablero`,
        },
        drop: { keepBesideChat: 'Tener junto al chat' },
        freshness: { machineOffline: ({ machine }) => `${machine} está sin conexión` },
        needsYouA11y: ({ count }) => `Acompañante, ${count} esperándote`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "es">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const es: typeof en = {
    discussion: {
        loadingTitle: 'Abriendo esta conversación…',
        offlineTitle: 'Esta conversación no está disponible sin conexión',
        offlineReason: 'Vuelve a conectarte y se abrirá donde la dejaste.',
        errorTitle: 'No se pudo abrir esta conversación',
        lockedTitle: 'Todavía no se puede abrir esta conversación en este dispositivo',
        lockedReason: 'Está cifrada de extremo a extremo y la configuración de cifrado de este dispositivo no coincide con la de la sesión.',
        revokedTitle: 'Ya no tienes acceso a esta conversación',
        revokedReason: 'Esta sesión ya no se comparte contigo. Los mensajes que escribiste se quedan en la sesión.',
        unavailableTitle: 'Las conversaciones no están disponibles aquí',
        closeTab: 'Cerrar pestaña',
    },
    draft: {
        leadTitle: 'Pregúntale a un agente',
        leadBody: 'Se ejecuta como una conversación propia junto a la sesión, con estos mensajes como contexto. No empieza nada hasta que lo envíes.',
    },
    context: {
        fromConversation: ({ title, count }) => `De ${title} · ${count === 1 ? '1 mensaje' : `${count} mensajes`}`,
        fromUntitled: ({ count }) => `De una conversación · ${count === 1 ? '1 mensaje' : `${count} mensajes`}`,
    },
    origin: {
        fromConversation: ({ title }) => `de ${title}`,
        fromUntitled: 'de una conversación',
    },
    run: {
        details: 'Detalles de la ejecución',
        loadingTitle: 'Abriendo esta conversación con el agente…',
        errorTitle: 'No se pudo abrir esta conversación con el agente',
    },
};

const sessionConversationSurfaceTranslations = { es };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { es: {
        title: ({ machine }) => `La carpeta privada de este chat ya no está en ${machine}.`,
        body: 'Puedes continuar en una carpeta nueva y vacía. El historial del chat se conservará aquí, pero no se restaurarán los archivos locales de la carpeta anterior.',
        continue: 'Continuar en una carpeta nueva', notNow: 'Ahora no',
        offlineDelete: ({ machine }) => `Su carpeta privada en ${machine} se eliminará cuando ese ordenador vuelva a estar en línea.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "es">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const es: typeof en = {
    sectionTitle: 'Borradores',
    sectionTitleForHome: ({ home }) => `Borradores en ${home}`,
    waitingSectionTitleForHome: ({ home }) => `Esperando un ordenador en ${home}`,
    badge: 'Borrador',
    untitled: 'Borrador sin título',
    continueEditing: 'Seguir editando',
    startAnother: 'Empezar otro',
    executionRunStart: {
        starting: 'Iniciando la conversación con el agente…',
        reconciling: 'Comprobando si esta conversación con el agente se inició…',
        unresolved: 'No pudimos confirmar si esta conversación con el agente se inició. Iniciar otra puede crear una segunda conversación.',
        targetChanged: 'El ordenador de esta sesión cambió antes de que la conversación pudiera iniciarse. No se inició nada.',
        secretReferenceOverlayUpdateRequired: 'Usar secretos compartidos en una conversación con el agente necesita un ordenador actualizado. No se inició nada.',
    },
    status: {
        offline: 'Sin conexión — guardado en este dispositivo',
        syncing: 'Sincronizando…',
        conflict: 'Necesita revisión',
        unsupported: 'Sin sincronizar — este Home no puede sincronizar este borrador',
        startInterrupted: 'Inicio interrumpido',
    },
    availability: {
        machineUnavailable: 'Máquina no disponible',
        pluginUnavailable: 'Complemento no disponible',
        attachmentNeedsAttention: 'El adjunto necesita atención',
    },
    new: { action: 'Sesión nueva' },
    delete: {
        action: 'Eliminar borrador',
        confirmTitle: '¿Eliminar este borrador?',
        confirmDescription: 'Esto quita el borrador de tus dispositivos sincronizados.',
    },
    conflict: {
        title: 'Revisa los cambios en conflicto',
        description: 'Elige qué versión conservar en cada campo. Puedes copiar la versión de tu dispositivo antes de reemplazarla.',
        mine: 'Este dispositivo',
        synced: 'Versión sincronizada',
        useSynced: 'Usar la sincronizada',
        keepDevice: 'Conservar la de este dispositivo',
        copyMine: 'Copiar la mía',
        copied: 'Copiado',
        copyFailed: 'No se pudo copiar este valor.',
        field: {
            text: 'Mensaje',
            mentions: 'Menciones',
            attachments: 'Adjuntos',
            recipient: 'Destinatario',
            agentContinuation: 'Continuación del agente',
            executionRunRequestedAction: 'Entrega de la ejecución',
        },
    },
};

const sessionDraftTranslations = { es };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { es: translated({
        unavailable: 'Esta sesión no está disponible',
        respondInSession: 'Abre la sesión para responder.',
        regionLabel: ({ title }) => `Sesión: ${title}`,
        newChatWelcome: '¿En qué trabajamos?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "es"> = { 'es': {
        "notificationBody": {"message":"Nuevo mensaje en esta sesión.","failed":"El turno ha fallado.","cancelled":"El turno se ha cancelado.","sourceUnavailable":"La fuente de esta sesión no está disponible."},
        "follow": "Seguir",
        "unfollow": "Dejar de seguir",
        "following": "Siguiendo",
        "notifications": "Notificaciones",
        "unavailableTitle": "El seguimiento no está disponible",
        "unavailableDescription": "Este Home no ofrece el seguimiento de sesiones.",
        "unreachableTitle": "No se pudo contactar con este Home",
        "unreachableDescription": "Happier no pudo comprobar si este Home ofrece el seguimiento de sesiones. Inténtalo de nuevo cuando esté disponible.",
        "editor": {
            "title": "Seguir esta sesión",
            "subtitle": "Recibe las novedades que te importan.",
            "ownerSubtitle": "Esta sesión es tuya, así que siempre recibirás sus novedades.",
            "externalAttachedOnly": "La sincronización en segundo plano está desactivada, así que las actualizaciones pueden llegar solo mientras esta sesión esté conectada."
        },
        "level": {
            "none": "Sin notificaciones",
            "important": "Novedades importantes",
            "all_messages": "Cada mensaje nuevo"
        },
        "voice": {
            "title": "Incluir en Voice",
            "subtitle": "Voice puede mantener esta sesión en contexto.",
            "waitingRuntime": "Esperando a que Voice se conecte.",
            "unsupported": "Este entorno no permite incluir sesiones seguidas en Voice.",
            "providerWithheld": "Este modo de Voice no puede incluir novedades de sesiones guardadas.",
            "waitingEncrypted": "Desbloquea esta sesión para incluirla en Voice.",
            "initialSnapshotPending": "En tu próximo turno de Voice, incluye un breve resumen del estado actual."
        },
        "footer": "Seguir nunca cambia quién puede acceder a esta sesión.",
        "settingsLink": "Ajustes de notificaciones…",
        "assignedExplanation": "La sigues porque se te asignó",
        "assignedNotice": "Se te ha asignado una sesión.",
        "sharedNotice": "Se ha compartido una sesión contigo.",
        "wakeEventExplanation": "El contexto seguido ha cambiado, así que Happier despertó a este agente con la actualización.",
        "accessLost": "Ya no tienes acceso a esta sesión.",
        "offline": "No tienes conexión. Vuelve a conectarte para cambiar el seguimiento.",
        "archived": "El seguimiento está en pausa mientras esta sesión está archivada.",
        "sources": {
            "title": "Actualizaciones de sesiones",
            "waitingRuntime": "Esperando a que la sesión de destino vuelva a conectarse.",
            "unsupported": "Actualiza o vuelve a conectar la CLI de la máquina de destino para recibir actualizaciones.",
            "pausedArchived": "Las actualizaciones están en pausa mientras el origen o el destino estén archivados.",
            "add": "Seguir en otra sesión…",
            "addSource": "Enviar novedades desde otra sesión…",
            "chooseDestinationTitle": "Seguir en otra sesión",
            "chooseSourceTitle": "Enviar novedades desde otra sesión",
            "row": ({ title }) => `Novedades de «${title}»`,
            "nextTurn": "Próximo turno",
            "wakeOnHumanChange": "Activar cuando una persona añada un mensaje",
            "stop": "Detener novedades",
            "stopForSource": ({ title }) => `Detener novedades de «${title}»`,
            "includeNextTurn": "Incluye las novedades en el próximo turno del destino.",
            "sourceKeyPreparing": "Preparando el acceso cifrado…",
            "sourceKeyWaiting": "Esperando el acceso cifrado.",
            "sourceKeyUnavailable": "Este equipo no puede proporcionar acceso cifrado.",
            "sourceSessionKeyUnavailable": "El acceso cifrado de esta sesión no está disponible aquí.",
            "catchUpPending": "Actualización pendiente"
        },
        "preferences": {
            "title": "Seguir automáticamente",
            "assigned": "Sesiones asignadas a mí",
            "direct": "Sesiones compartidas directamente",
            "team": "Sesiones compartidas mediante equipos",
            "group": "Sesiones compartidas mediante grupos",
            "help": "Se aplica a nuevas asignaciones y sesiones recién accesibles. Las opciones existentes no cambian."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const es: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Rama ${branch}: cambia de rama o mira lo que se apartó`,
    searchPlaceholder: 'Cambia o crea una rama',
    category: { current: 'Actual', branches: 'Ramas', remote: 'Ramas remotas', keptAside: 'Apartado', worktrees: 'Worktrees', start: 'Empieza algo nuevo' },
    tracks: ({ upstream }) => `sigue ${upstream}`,
    onlyHere: 'solo en esta máquina',
    changed: ({ count }) => `${count} cambiados`,
    ahead: ({ count }) => `${count} por subir`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Rama nueva desde ${branch}…`,
    newBranchDetached: 'Rama nueva…',
    newBranchSubtitle: 'Escribe su nombre en el campo de búsqueda',
    newWorktree: 'Worktree nuevo…',
    newWorktreeSubtitle: 'Trabaja en otra rama en una sesión nueva',
    keepAside: 'Apartar los cambios',
    keepAsideSubtitle: ({ count }) => `Guarda ${count} cambios y empieza de cero`,
    keepAsideNothing: 'No hay cambios que guardar',
    keepAsideFailed: 'No se pudieron apartar los cambios.',
    loadFailed: 'No se pudieron cargar las ramas',
    notice: {
        title: ({ branch }) => `Apartaste cambios en ${branch}`,
        reason: ({ when }) => `Apartados ${when}. Recupéralos para seguir trabajando.`,
        reasonUndated: 'Recupéralos para seguir trabajando.',
        restore: 'Restaurar los cambios',
        lookFirst: 'Ver primero',
        dismiss: 'Ahora no',
        restoreFailed: 'No se pudieron restaurar los cambios.',
    },
};

const sessionGitBranchesTranslations = { es };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const es: typeof en = {
    settingsLayout: 'Diseño del panel de Git',
    settingsShowAs: 'Mostrar archivos cambiados como',
    trigger: 'Opciones de visualización',
    paneGroup: 'Panel',
    changesGroup: 'Cambios',
    layout: 'Diseño',
    layoutUnified: 'Unificado',
    layoutTabs: 'Pestañas',
    layoutDescription: 'Un solo desplazamiento de los cambios al historial, o Cambios e Historial como dos vistas.',
    showAs: 'Mostrar como',
    showAsList: 'Lista',
    showAsTree: 'Árbol',
    showAsDescription: 'Los archivos cambiados en una lista, o agrupados por carpeta para tomar carpetas enteras.',
    density: 'Densidad',
    densityDefault: 'Predeterminada',
    densityCompact: 'Compacta',
    note: 'Las filas del árbol siempre son compactas. Se recuerda en tu cuenta.',
    selectFolder: ({ folder }) => `Seleccionar todos los cambios de ${folder}`,
    selectFile: ({ file }) => `Seleccionar ${file} para el próximo commit`,
};

const sessionGitDisplayTranslations = { es };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const es: typeof en = {
    scope: { allChanges: 'Todos los cambios' },
    subTabs: { changes: 'Cambios', sync: 'Sincronizar', history: 'Historial' },
    header: {
        changed: ({ count }) => `${count} cambiados`,
        toPush: ({ count }) => `${count} por subir`,
        toPull: ({ count }) => `${count} por bajar`,
        push: ({ count }) => `Subir ${count}`,
        pull: ({ count }) => `Bajar ${count}`,
        publish: 'Publicar',
        folderOnMachine: ({ folder, machine }) => `${folder} en ${machine}`,
    },
    groups: {
        session: 'Cambiado en esta sesión',
        elsewhere: ({ repo }) => `En otras partes de ${repo}`,
        elsewhereUnnamed: 'En otras partes de este repositorio',
        selectGroup: ({ group }) => `Seleccionar todos los archivos de «${group}»`,
    },
    row: { renamedFrom: ({ path }) => `antes ${path}` },
    commit: {
        toBranch: ({ branch }) => `Confirmar en ${branch}`,
        selection: ({ count }) => (count === 1 ? '1 archivo' : `${count} archivos`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Tienes 1 cambio sin confirmar` : `Tienes ${formatted} cambios sin confirmar`),
            dirtyBody: 'Bajar podría tocarlos. Guárdalos aparte mientras bajas (vuelven enseguida) o deja que Git baje solo si nada se solapa.',
            keepAsideAndPull: 'Guardar aparte y bajar',
            pullIfNoOverlap: 'Bajar si nada se solapa',
            divergedPullBody: 'Tu rama y origin se movieron. Pon tus commits encima de los de origin o fusiona ambos.',
            divergedPushBody: 'Trae primero los commits de origin (los tuyos encima o fusionando) y vuelve a subir. Tus commits se quedan en esta máquina.',
            rebase: 'Rebase sobre origin',
            merge: 'Fusionar origin',
        },
        writesOff: {
            title: 'Confirmar desde Happier está desactivado',
            body: 'Puedes leer y revisar cada cambio. Activa las operaciones de control de versiones para confirmar, subir y bajar desde aquí.',
            turnOn: 'Activar',
        },
        header: {
            noChanges: 'sin cambios',
        },
        action: {
            fetch: 'Obtener',
            publish: 'Publicar rama',
            createPr: 'Crear PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Resolver ${count}`,
            upToDate: 'Al día',
            pushing: ({ count }) => `Subiendo ${count}…`,
            pulling: ({ count }) => `Bajando ${count}…`,
            fetching: 'Obteniendo…',
            publishing: 'Publicando…',
            creatingPr: 'Creando…',
        },
        menu: {
            open: 'Más acciones de sincronización',
            push: 'Subir',
            pull: 'Bajar',
            pushTo: ({ target }) => `a ${target}`,
            pullFrom: ({ target }) => `desde ${target}`,
            nothingToPush: 'Nada que subir',
            upToDate: 'Al día',
            fetchHint: 'Comprobar si origin tiene commits nuevos',
            publishHint: 'Poner esta rama en origin',
            createPr: 'Crear pull request…',
            createPrInto: ({ base }) => `hacia ${base}`,
            unavailable: 'No disponible aquí',
            more: 'Más',
        },
        running: {
            branchSwitch: 'Cambiando de rama…',
            branchCreate: 'Creando la rama…',
            stashCreate: 'Guardando tus cambios aparte…',
            discard: 'Descartando cambios…',
            revert: 'Revirtiendo el commit…',
            generic: 'Trabajando…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `tu cambio sin confirmar está intacto` : `tus ${formatted} cambios sin confirmar están intactos`),
            commit: 'Confirmado',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 archivo confirmado` : `${formatted} archivos confirmados`),
            push: 'Subido',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 commit subido` : `${formatted} commits subidos`),
            upToDate: ({ target }) => `${target} está al día`,
            pull: 'Bajado',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 commit bajado` : `${formatted} commits bajados`),
            fetch: ({ target }) => `${target} comprobado`,
            branchSwitch: 'Rama cambiada',
            branchCreate: 'Rama creada',
            stashCreate: 'Cambios guardados aparte',
            discard: 'Cambios descartados',
            revert: 'Commit revertido',
            pullRequest: 'Pull request lista',
            generic: 'Hecho',
        },
        failed: {
            unknownTitle: 'No pudimos confirmar cómo terminó',
            unknownBody: 'La máquina dejó de responder antes de que Git informara. Comprueba de nuevo para ver qué pasó.',
            origin: 'origin',
            thisMachine: 'esta máquina',
            refreshTitle: 'Confirmado, pero la lista no se actualizó',
            refreshBody: 'Tu commit está a salvo. Vuelve a intentarlo para ver los cambios actuales.',
            rejectedTitle: ({ target }) => `${target} tiene commits que tú no tienes`,
            rejectedBody: 'Obtenlos para ver qué cambió. Tus commits se quedan en esta máquina hasta que vuelvas a subir.',
            authTitle: ({ machine, provider }) => `${provider} no aceptó el inicio de sesión desde ${machine}`,
            authBody: ({ machine }) => `Git en ${machine} no tiene credenciales válidas para este remoto. Inicia sesión allí y vuelve a intentarlo.`,
            offlineTitle: ({ machine }) => `${machine} está sin conexión`,
            offlineBody: 'Ahora no puede ejecutarse nada allí. Tu trabajo está a salvo en esa máquina.',
            conflictTitle: 'Detenido por cambios en conflicto',
            conflictBody: 'Algunos archivos cambiaron en ambos lados. Resuélvelos y continúa.',
            networkTitle: ({ target }) => `No se pudo contactar con ${target}`,
            networkBody: 'La máquina no pudo conectarse al remoto. Revisa su red y vuelve a intentarlo.',
            commitTitle: 'El commit no se completó',
            pushTitle: 'La subida no se completó',
            pullTitle: 'La bajada no se completó',
            fetchTitle: 'No se pudieron comprobar los commits nuevos',
            pullRequestTitle: 'No se creó la pull request',
            genericTitle: 'No se pudo completar',
        },
        recover: {
            open: 'Abrir',
            tryAgain: 'Reintentar',
            fetch: 'Obtener',
            checkAgain: 'Comprobar de nuevo',
            showConflicts: 'Ver conflictos',
        },
        timeline: {
            title: 'Cronología',
            now: 'Ahora',
            loading: 'Leyendo el historial…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 cambio sin confirmar` : `${formatted} cambios sin confirmar`),
            selected: ({ count, formatted }) => (count === 1 ? `1 seleccionado para el próximo commit` : `${formatted} seleccionados para el próximo commit`),
            nothingSelected: 'Nada seleccionado',
            earlierToday: 'Hoy, antes',
            yesterday: 'Ayer',
            older: 'Anterior',
            justNow: 'ahora mismo',
            toPull: 'por bajar',
            originFurther: ({ name }) => `${name} está más atrás`,
            originA11y: ({ name }) => `${name} está aquí`,
        },
        clean: {
            titleUpToDate: 'Todo está confirmado y subido',
            titleCommitted: 'Todo está confirmado',
            bodyUpToDate: ({ branch, upstream }) => `${branch} coincide con ${upstream}. Los cambios nuevos de esta sesión aparecerán aquí.`,
            body: 'Los cambios nuevos de esta sesión aparecerán aquí.',
            createPullRequest: 'Crear pull request',
            openPullRequest: ({ number }) => `Abrir la pull request #${number}`,
            lastCommit: ({ when }) => `Último commit ${when}`,
        },
        conflicts: {
            skip: 'Omitir este commit',
            askAgentTask: ({ files, operation }) => `Resuelve los conflictos de la ${operation} en ${files}. Mantén la intención de ambos lados, edita y prepara los archivos resueltos y detente para que los revise. No continúes, no canceles, no hagas commit ni push, y no elijas un lado entero.`,
            revert: 'reversión',
            cherryPick: 'cherry-pick',
            merge: 'fusión',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `La ${operation} se detuvo: 1 archivo cambió en ambos lados` : `La ${operation} se detuvo: ${formatted} archivos cambiaron en ambos lados`),
            readyToContinue: ({ operation }) => `Todos los conflictos están resueltos. Continúa la ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 archivo en conflicto` : `${formatted} archivos en conflicto`),
            body: 'Abre cada archivo de «Te necesita» o pide al agente que los resuelva.',
            continueBody: 'No se confirma nada hasta que continúes.',
            askAgent: 'Pedir al agente que resuelva',
            continue: ({ operation }) => `Continuar la ${operation}`,
            abort: ({ operation }) => `Cancelar la ${operation}`,
            abortTitle: ({ operation }) => `¿Cancelar la ${operation}?`,
            abortBody: 'La rama vuelve a donde estaba antes de empezar. Se pierden las resoluciones hechas hasta ahora.',
            needsYou: 'Te necesita',
            mergedCleanly: 'Fusionado sin problemas',
        },
        commit: {
            selectFirst: 'Selecciona archivos para confirmar',
        },
        tools: {
            title: 'Remotos y fusiones',
            subtitle: 'Añadir un remoto, fusionar o hacer rebase de una rama',
        },
    },
    paused: { reason: 'la sesión está en pausa', resume: 'Reanudar' },
    notRepository: {
        title: 'Sigue lo que cambian los agentes aquí',
        body: ({ folder }) => `${folder} aún no es un repositorio. Crea uno para revisar, confirmar y deshacer cada cambio.`,
        bodyUnnamed: 'Esta carpeta aún no es un repositorio. Crea uno para revisar, confirmar y deshacer cada cambio.',
    },
};

const sessionGitPaneTranslations = { es: withFidelity(es) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const es: GitPullRequestCopy = {
    form: {
        title: 'Nueva pull request', expand: 'Abrir en un panel de detalles', moveBack: 'Volver a la barra lateral',
        close: 'Cerrar el formulario (el borrador se conserva)', base: 'Se fusiona en', titlePlaceholder: 'Título',
        bodyPlaceholder: 'Qué cambió y por qué', draft: 'Borrador', create: 'Crear pull request', creating: 'Creando…',
        continueOn: ({ provider }) => `Continuar en ${provider}`, pointer: 'La nueva pull request está abierta en Detalles', pointerShow: 'Mostrar',
        openedProviderPage: ({ provider }) => `${provider} está abierto para terminarla; tu texto se conserva aquí.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} no aceptó el inicio de sesión de esta máquina`,
        network: ({ provider }) => `No se pudo conectar con ${provider}`,
        machineOffline: 'La máquina está sin conexión; tu borrador se conserva',
        blocked: 'Hay otra operación de Git en curso; inténtalo cuando termine',
        other: 'No se creó la pull request',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `en ${base}`,
        state: { open: 'Abierta', draft: 'Borrador', merged: 'Fusionada', closed: 'Cerrada', unknown: 'Pull request' },
        checks: { pending: 'Comprobaciones en curso', success: 'Comprobaciones correctas', failure: 'Comprobaciones fallidas', unknown: 'Comprobaciones' },
        openOn: ({ provider }) => `Abrir en ${provider}`, copyLink: 'Copiar enlace', copied: 'Enlace copiado',
    },
    settings: {
        placementTitle: 'Abrir nuevas pull requests en', placementDescription: 'En un teléfono el formulario siempre se abre como su propia página.',
        sidebar: 'Barra lateral', details: 'Panel de detalles',
    },
};

const sessionGitPullRequestTranslations = { es };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { es: translated({
        offline: 'Sin conexión',
        stale: 'No se pudo actualizar',
        lastUpdated: ({ ago }) => `Actualizado hace ${ago}`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { es: translated({
        filtersTitle: 'Filtros de sesiones', filtersSearch: 'Buscar filtros…', filtersShow: 'Mostrar',
        filtersScope: 'Ámbito', filtersShowSessions: 'Sesiones', filtersShowRuns: 'Ejecuciones', filtersShowBoth: 'Ambas',
        filtersShowBothSummary: 'Sesiones y ejecuciones', filtersStartedByNone: 'Ningún iniciador seleccionado',
        filtersStartedBy: 'Iniciado por', filtersStartedByYou: 'Ti', filtersStartedByTriggers: 'Disparadores', filtersStartedByAgents: 'Agentes',
        filtersRunsNeedingYouAlwaysShow: 'Las ejecuciones que te necesitan siempre se muestran',
        filtersMyWork: 'Mi trabajo', filtersLegacyOwnerDirect: 'Propias y compartidas directamente', filtersAssignedToMe: 'Asignadas a mí', filtersFollowing: 'Siguiendo',
        filtersInvolvingMe: 'En las que participo', filtersAllAccessible: 'Todas las accesibles', filtersAttention: 'Atención',
        filtersAttentionAny: 'Cualquiera', filtersAttentionNeedsMe: 'Solo sesiones que me necesitan', filtersScopeNeedsMe: 'Me necesitan',
        filtersInactive: 'Sesiones inactivas', filtersInactiveShow: 'Mostrar', filtersInactiveHide: 'Ocultar',
        filtersHomes: 'Homes', filtersSharedWith: 'Compartidas con', filtersOutsideTeams: 'Personal y directo',
        filtersTags: 'Etiquetas', filtersSource: 'Origen', filtersSourceAll: 'Todas',
        filtersSourceDirect: 'Externas',
        filtersNoOptions: 'No hay filtros disponibles', filtersClear: 'Borrar filtros', filtersDone: 'Listo', filtersArchived: 'Archivadas',
        filtersNeedsMeOnly: 'Solo lo que me necesita', filtersNeedsMeOnlyDescription: 'Sesiones que te esperan', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} más`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 elemento` : `${count} elementos`,
        queryInitialLoadingTitle: 'Cargando sesiones…', queryUpdatingTitle: 'Actualizando sesiones…',
        querySomeHomesUnavailableTitle: 'Algunos Homes no están disponibles', querySomeHomesUnavailableDescription: 'Happier muestra lo que puede alcanzar. Inténtalo de nuevo cuando esos Homes vuelvan a estar en línea.',
        queryRefreshFailedTitle: 'No se pudo actualizar', queryRefreshFailedRetainedDescription: 'Tus sesiones cargadas siguen aquí. Vuelve a intentarlo para buscar actualizaciones.', queryRefreshFailedEmptyDescription: 'Happier no pudo cargar sesiones de los Homes seleccionados. Inténtalo cuando estén disponibles.',
        queryNoMatchesLoadedTitle: 'No hay coincidencias en las sesiones cargadas', queryNoMatchesLoadedDescription: 'Puede haber más sesiones coincidentes en una página anterior.', querySearchOlder: 'Buscar en sesiones anteriores',
        queryMoreAvailableTitle: 'Puede haber más sesiones disponibles', queryMoreAvailableDescription: 'Esta vista incluye las sesiones cargadas. Busca en sesiones anteriores para continuar.',
        queryNoMatchesTitle: 'Ninguna sesión coincide', queryNoMatchesDescription: 'Prueba a cambiar los filtros activos.',
        queryTeamEmptyTitle: 'Este equipo no tiene sesiones', queryTeamEmptyDescription: 'Las sesiones compartidas con este equipo aparecerán aquí.',
        queryMyWorkEmptyTitle: 'Nada en Mi trabajo', queryScopeEmptyDescription: 'Prueba un ámbito más amplio o vuelve más tarde.', queryBrowseAllAccessible: 'Mostrar todas las sesiones',
        queryAssignedEmptyTitle: 'No tienes sesiones asignadas', queryFollowingEmptyTitle: 'No hay sesiones seguidas', queryInvolvingEmptyTitle: 'No hay sesiones en las que participes',
        queryAttentionEmptyTitle: 'Ninguna sesión necesita tu atención', queryReachableEmptyTitle: 'No hay sesiones disponibles', queryReachableEmptyDescription: 'Ninguna sesión coincide con esta vista en los Homes accesibles.',
        queryHistoricalSharesWithheldTitle: 'Algunas sesiones compartidas están ocultas', queryHistoricalSharesWithheldDescription: 'Las sesiones compartidas contigo desde una versión anterior de Happier permanecen ocultas hasta que su propietario las actualice en Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} no está en esta vista de Sesiones`,
        partialHomeNotMountedDescription: 'Añade este Home a un grupo de Homes visible para mostrar las sesiones del equipo sin cambiar el foco.',
        partialShowFromHome: ({ home }) => `Mostrar sesiones de ${home}`,
        teamListingUnavailableTitle: 'La lista de sesiones del equipo no está disponible en este Home',
        teamListingUnavailableDescription: 'Este Home todavía no puede mostrar las sesiones del equipo. Actualízalo o vuelve a configurarlo e inténtalo de nuevo.',
        teamListingLoadingTitle: ({ team }) => `Cargando las sesiones de ${team}…`,
        teamListingLoadingDescription: 'Happier está comprobando qué puede mostrar este Home.',
        teamListingProbeFailedTitle: 'No se pudo contactar con este Home',
        teamListingProbeFailedDescription: 'Happier no pudo consultar las sesiones del equipo en este Home. Inténtalo de nuevo cuando esté disponible.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "es"> = { es: { accountActorYou: 'Tú', accountActorFormerMember: 'Antiguo miembro', accountActorUnnamedMember: 'Miembro de Happier', accountActorSentBy: ({ name }) => `Enviado por ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { es: translated({
        sessionPages: {
            info: {
                continueTitle: 'Continuar',
                continueDescription: 'Empieza trabajo nuevo desde donde está esta sesión.',
                organizeTitle: 'Organizar',
                organizeDescription: 'Dónde aparece esta sesión en tus listas.',
                activityDescription: 'Qué hace el agente y si te enteras.',
                detailsTitle: 'Detalles',
                detailsDescription: 'Identificadores e historial, para soporte y scripts.',
                environmentTitle: 'Entorno',
                environmentDescription: 'La máquina, la carpeta y el agente con los que se ejecuta esta sesión.',
                agentStateDescription: 'Quién dirige el agente y qué está esperando.',
                relatedTitle: 'Relacionado',
                relatedDescription: 'Otras páginas de esta sesión.',
                developerTitle: 'Desarrollador',
                developerDescription: 'Registros sin procesar para depurar, visibles en modo desarrollador.',
                leaveLabel: 'Detener, archivar o eliminar',
                leaveFootnote: 'Detener termina el proceso en ejecución. Las sesiones archivadas se pueden restaurar. Eliminar borra la sesión y sus mensajes para siempre.',
            },
            follow: {
                description: 'Elige si esta sesión te avisa y si habla por voz.',
            },
            permissions: {
                description: 'Herramientas que permitiste desde otro dispositivo para esta sesión. Revoca las que ya no quieras.',
            },
            automations: {
                description: 'Trabajo que se ejecuta en esta sesión según un horario, un evento o al terminar un turno.',
            },
            newRun: {
                description: 'Inicia una ejecución de un subagente desde esta sesión.',
                transcriptReadOnly: 'Este es un historial guardado. Vuelve a conectarte a este Home para continuar la conversación.',
                daemonReadOnly: 'Este historial procede del proceso del agente. Vuelve a conectarte a este Home para continuar la conversación.',
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
>, "es"> = { es: {
        due: 'Recordatorio pendiente',
        title: 'Recordarme', inOneHour: 'En 1 hora', inThreeHours: 'En 3 horas',
        tomorrowMorning: 'Mañana por la mañana', nextWeek: 'La próxima semana', custom: 'Elegir fecha y hora…',
        customTitle: 'Elegir fecha y hora',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Elige una hora futura.',
        setReminder: 'Establecer recordatorio',
        reminderSaved: 'Recordatorio guardado',
        presetSaveFailedAfterReminder: 'El recordatorio está guardado, pero no se confirmó el guardado del preajuste. Reintenta o cierra.',
        presetsSaveFailed: 'No se confirmó el guardado de los preajustes. Tus cambios se conservan aquí; inténtalo de nuevo.',
        presetsChanged: 'Los preajustes guardados difieren de la lista que abriste. Cierra y vuelve a abrir para revisar la lista actual.',
        remove: 'Eliminar recordatorio',
        dateLabel: 'Fecha', timeLabel: 'Hora', addToPresets: 'Añadir a preajustes', presetPreviewUnavailable: 'Elige una hora futura válida para previsualizar el preajuste.', managePresets: 'Gestionar preajustes', managePresetsMessage: 'Renombra, reordena o elimina tus recordatorios guardados.', presetName: 'Nombre del preajuste', movePresetUp: 'Mover hacia arriba', movePresetDown: 'Mover hacia abajo', renamePresetLabel: ({ preset }) => `Renombrar «${preset}»`, movePresetUpLabel: ({ preset }) => `Mover «${preset}» hacia arriba`, movePresetDownLabel: ({ preset }) => `Mover «${preset}» hacia abajo`, deletePresetLabel: ({ preset }) => `Eliminar «${preset}»`, noPresets: 'No hay preajustes guardados', noPresetsMessage: 'Guarda uno la próxima vez que elijas un recordatorio personalizado.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { es: {
        title: 'Concesiones de permisos remotos',
        entryTitle: 'Concesiones de permisos remotos',
        entrySubtitle: 'Revisa y revoca las concesiones remotas de la sesión',
        loadingTitle: 'Cargando concesiones de permisos remotos',
        loadingReason: 'Comprobando las concesiones del propietario actual de la sesión.',
        emptyTitle: 'No hay concesiones de permisos remotos',
        emptyReason: 'Esta sesión no tiene concesiones remotas para revisar.',
        unavailableTitle: 'Las concesiones de permisos remotos no están disponibles',
        unavailableReason: 'Comprueba que este sea el propietario actual de la sesión y que su máquina esté disponible; después, inténtalo de nuevo.',
        ownerOnlyTitle: 'Solo el propietario de la sesión puede administrar las concesiones remotas',
        ownerOnlyReason: 'Los participantes compartidos pueden responder a solicitudes aptas, pero no pueden revisar ni revocar las concesiones del propietario de la sesión.',
        retry: 'Reintentar',
        listTitle: 'Concesiones de la sesión',
        grantActive: ({ actor }) => `Concesión activa de ${actor}`,
        grantRevoked: ({ actor }) => `Concesión revocada de ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Concesión ${grantId} · Origen ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Revocar concesión',
        revoking: 'Revocando…',
        revokeConfirmTitle: '¿Revocar la concesión de permiso remoto?',
        revokeConfirmBody: ({ identifier }) => `Esto revocará inmediatamente la concesión remota para ${identifier}.`,
        revokeFailedTitle: 'No se pudieron actualizar las concesiones remotas',
        revokeFailedReason: 'La concesión pudo haber cambiado o la máquina del propietario no está disponible. Inténtalo de nuevo.',
        loadMore: 'Cargar más concesiones',
        loadingMore: 'Cargando más concesiones…',
        loadMoreFailedReason: 'No se pudieron cargar más concesiones. Inténtalo de nuevo.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "es">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "es"> = { es: {
        responsibilitySectionTitle: 'Responsabilidad',
        responsibilityRowTitle: 'Responsable',
        responsibilityNoOne: 'Nadie',
        responsibilityUnnamedPerson: 'Persona sin nombre',
        responsibilityPickerTitle: 'Elige a la persona responsable',
        responsibilitySearchPlaceholder: 'Buscar personas con acceso',
        responsibilityAssignToMe: 'Asignármelo',
        responsibilityPeopleWithAccess: 'Personas con acceso',
        responsibilityAccessHintOwner: 'Propietario',
        responsibilityNoCandidates: 'Todavía nadie más puede acceder a esta sesión.',
        responsibilityAccessChanged: 'El acceso cambió. Esta persona ya no puede ser responsable.',
        responsibilityUpdateFailed: 'Happier no pudo actualizar a la persona responsable. Inténtalo de nuevo.',
        responsibilityApprovalPending: 'Esperando aprobación. Aún no ha cambiado nada: la persona responsable se actualizará cuando se apruebe.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Persona responsable, ${name}. Cambiar la persona responsable.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Persona responsable, ${name}.`,
        responsibilityA11yEmpty: 'Persona responsable, nadie. Cambiar la persona responsable.',
        responsibilityAssignedToYou: 'Asignada a ti',
        responsibilitySharedWithYou: 'Compartida contigo',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const es: typeof en = {
    workerUpdate: {
        settled: "Resuelto",
        stalled: "Estancado",
        published: "Publicado",
        truncated: "Resultado abreviado.",
        wokenBy: ({ count }) => (count === 1 ? 'Despertado por una actualización' : `Despertado por ${count} actualizaciones`),
        notFromYou: 'no es un mensaje tuyo',
    },
    title: 'Trabajo',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 sesión' : `${count} sesiones`),
        runs: ({ count }) => (count === 1 ? '1 ejecución' : `${count} ejecuciones`),
        nothingStarted: 'Aún no se ha iniciado nada',
    },
    states: {
        recent: 'Recientes',
    },
    view: {
        a11y: 'Vista del trabajo',
        list: 'Lista',
        map: 'Mapa',
        expandMap: 'Abrir el mapa junto a la sesión',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${position} de ${total} bajo ${parent}`,
    },
    actions: {
        makeOrchestrator: 'Convertir en orquestador',
        makeOrchestratorSubtitle: 'Esta sesión planifica, delega e informa',
        makeOrchestratorFailed: "No se pudo convertir la sesión en orquestador",
    },
    putUnder: {
        title: "Poner debajo de…",
        subtitle: "Informar a otra sesión",
        search: "Buscar una sesión",
        topLevel: "Nivel superior — no informa a nadie",
        errors: {
            cycle: "Esa sesión ya informa a esta",
            changed: "La sesión se acaba de mover. Inténtalo de nuevo",
            forbidden: "No puedes ponerla debajo de esa sesión",
            failed: "No se pudo mover la sesión",
        },
    },
    kinds: {
        session: 'Sesión',
        workflowRun: 'Ejecución de flujo',
        backgroundRun: 'Ejecución en segundo plano',
    },
    showMore: ({ count }) => `Mostrar ${count} más`,
    role: {
        none: 'Ninguno',
        handsOff: 'sin editar',
        a11y: ({ role }) => `Rol: ${role}. Cambiar rol`,
    },
    empty: {
        title: 'Aún no hay trabajo',
        reason: 'Las sesiones, los flujos de trabajo y las ejecuciones en segundo plano que inicie esta sesión aparecerán aquí, junto con todo lo que te necesite.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} de ${total}`,
    strip: {
        openInSidebar: 'Abrir en la barra lateral',
        stillWorking: ({ count }) => `${count} aún trabajando`,
        needsYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        a11y: ({ summary }) => `Trabajo: ${summary}`,
    },
    leadArchived: ({ count }) => `Esta sesión está archivada · ${count} aún trabajando`,
    runsStale: 'Las ejecuciones de flujos de trabajo pueden estar desactualizadas',
    list: {
        level: ({ level }) => `Nivel ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 subsesión' : `${count} subsesiones`),
        reportsWorking: ({ count }) => `${count} trabajando`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 subsesión te necesita' : `${count} subsesiones te necesitan`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Archivar también 1 subsesión' : `Archivar también ${count} subsesiones`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 subsesión no se archivó' : `${count} subsesiones no se archivaron`),
    },
    peek: {
        reportsTo: ({ lead }) => `Informa a ${lead}`,
        repliesGoHere: 'Las respuestas van a esta sesión',
    },
};

const notify = { es: { turn: 'Avísame cuando termine este turno', attention: 'Avísame cuando me necesite', armed: 'Recibirás una notificación', cancel: 'Cancelar notificación', failed: 'No se pudo actualizar la notificación. Inténtalo de nuevo.', turnFinished: 'El turno de esta sesión ha terminado.', needsYou: 'Esta sesión te necesita.', settings: 'Ajustes de notificaciones' } };

const runNotify = { es: { run: 'Avísame cuando termine', runFinished: 'Esta ejecución ha terminado.', runNeedsYou: 'Esta ejecución te necesita.', setup: 'Configurar notificaciones' } };

const sessionWorkTranslations = { es: { ...es, notify: { ...notify.es, ...runNotify.es } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const es = {
    sectionTitle: 'Conexiones',
    sectionDescription: 'Cómo llegan tus dispositivos a tus máquinas.',
    directTitle: 'Conectar directamente cuando sea posible',
    directOnDescription: 'Las vistas previas, las vistas en directo y las transferencias de archivos van directamente entre tus dispositivos cuando se alcanzan, y a través de Happier cuando no.',
    directOffDescription: 'Todo pasa por Happier. Nada se conecta directamente a tus máquinas; en la misma red es un poco más lento.',
    serverDenied: 'El servidor de tu Home envía todo a través de Happier, así que aquí no hay nada que elegir.',
    machineSectionTitle: 'Conexión',
    machineTitle: ({ machine }: MachineParams) => `Conectar con ${machine}`,
    machineOptionDefault: 'Predeterminado',
    machineOptionDirect: 'Directamente',
    machineOptionRelay: 'A través de Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Sigue tu cuenta: directamente cuando se puede llegar a ${machine}, si no a través de Happier.`,
    machineDefaultOffDescription: 'Sigue tu cuenta: siempre a través de Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Directamente cuando se puede llegar a ${machine}, aunque tu cuenta diga lo contrario.`,
    machineRelayDescription: 'Siempre a través de Happier, incluso en la misma red.',
};

const settingsConnectionsTranslations = { es };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const es: typeof en = {
    pageDescription: 'Los ordenadores donde se ejecutan tus sesiones y los grupos que eligen entre ellos.',
    thisComputerTitle: 'Este ordenador',
    thisComputerRowSubtitle: 'Servicio en segundo plano y línea de comandos',
    thisComputerPageDescription: 'El servicio en segundo plano y la línea de comandos de Happier en este dispositivo.',
    setupSectionTitle: 'Configuración',
    setupRowSubtitle: 'Instala Happier aquí y conéctalo a tu Home.',
    addPageDescription: 'Conecta un ordenador para que los agentes ejecuten tus sesiones en él.',
    addFromComputerTitle: 'Añade máquinas desde un ordenador',
    addFromComputerDescription: 'Abre Happier en el ordenador que quieras añadir, o conecta uno por SSH desde Happier en el escritorio o en un navegador.',
    searchPlaceholder: 'Buscar máquinas',
    count: ({ count }: { count: number }) => (count === 1 ? '1 máquina' : `${count} máquinas`),
    daemonTitle: 'Servicio en segundo plano',
    daemonDescription: 'Ejecuta tus sesiones en este ordenador y lo mantiene conectado a tu Home.',
    unreadableTitle: ({ home }: { home: string }) => `No se pudieron leer las máquinas de ${home}`,
};

const settingsMachinesTranslations = { es };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { es: {
        attentionTitle: 'Requiere tu atención',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} necesita iniciar sesión en ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} necesita iniciar sesión`,
        serviceSignInExpired: ({ service }) => `La sesión de ${service} ha caducado`,
        signIn: 'Iniciar sesión',
        signInAgain: 'Volver a iniciar sesión',
        setupTitle: 'Primeros pasos',
        setupProgress: ({ done, total }) => `${done} de ${total}`,
        setupActionSaveKey: 'Guardar clave',
        setupActionAddMachine: 'Añadir máquina',
        setupActionShowQr: 'Mostrar QR',
        setupActionScan: 'Escanear',
        setupActionPasteLink: 'Pegar enlace',
        setupActionBrowse: 'Explorar',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} en esta máquina · ${latest} disponible`,
        connectTerminalTitle: 'Conectar un terminal',
        connectTerminalSubtitle: 'Escanea el código que muestra tu terminal o pega su enlace.',
        quickSettingsTitle: 'Ajustes rápidos',
        notificationsPushOn: 'Push activadas',
        notificationsPushOff: 'Push desactivadas',
        notificationsQuietHours: 'Horas de silencio activadas',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 cambio de plugin espera tu revisión' : `${count} cambios de plugins esperan tu revisión`,
        review: 'Revisar',
        browsePluginsTitle: 'Explorar plugins',
        browsePluginsSubtitle: 'Añade herramientas, paneles e integraciones a Happier.',
        accountServiceSignedIn: ({ service }) => `Sesión iniciada en ${service}`,
        aboutDescription: 'Versión, código fuente y términos legales (Happier no está afiliado a Anthropic).',
        machinesTitle: 'Máquinas',
        machineOnline: 'En línea',
        machineOffline: ({ lastSeen }) => `Sin conexión · visto por última vez ${lastSeen}`,
        machineUpdateAvailable: 'Actualización disponible',
        machinesOnlineCount: ({ count }) => `${count} en línea`,
        machinesOfflineCount: ({ count }) => `${count} sin conexión`,
        machineLastSeen: ({ lastSeen }) => `visto ${lastSeen}`,
        update: 'Actualizar',
        asOf: ({ time }) => `A las ${time}`,
        usageTitle: 'Uso',
        usageLeft: ({ percent }) => `Queda un ${percent} %`,
        usageResets: ({ time }) => `se restablece ${time}`,
        securityTitle: 'Seguridad',
        startSessionLabel: 'Iniciar una sesión',
        saveRecoveryKeyTitle: 'Guarda tu clave de recuperación',
        saveRecoveryKeySubtitle: 'La única forma de recuperar los datos cifrados si pierdes todos tus dispositivos.',
        addMachineTitle: 'Añadir una máquina',
        addMachineSubtitle: 'Conecta un ordenador donde se ejecuten tus agentes.',
        homeGreetingNamed: ({ name }) => `Hola de nuevo, ${name}.`,
        homeStartSection: 'Iniciar una sesión',
        homeCustomize: 'Personalizar inicio',
        homeCustomizeDescription: 'Elige qué secciones muestra tu inicio y en qué orden.',
        homeAlwaysShown: 'Siempre visible',
        homeShowSection: 'Mostrar',
        homeHideSection: 'Ocultar sección',
        homeSectionOptions: 'Opciones de la sección',
        homeResetLayout: 'Restablecer valores predeterminados',
        homeLayoutSectionTitle: 'Inicio',
        homeAddWidgetsTitle: 'Añadir widgets',
        homeAddWidgetsDescription: 'Widgets que ofrecen tus plugins. Añade uno para verlo en tu inicio.',
        homeWidgetFromPlugin: ({ plugin }) => `De ${plugin}`,
        homeRemoveWidget: 'Quitar del inicio',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "es">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { es: translated({
        settingsProfilesPage: {
            pageDescription: 'Ajustes de inicio con los que puede empezar una sesión nueva: el agente, el modelo, las variables de entorno y dónde se ejecuta.',
            useProfilesSection: 'Selección de perfil',
            useProfilesSectionDescription: 'Elige un perfil al empezar una sesión, o empieza todas las sesiones con el entorno de la máquina.',
            useProfiles: 'Usar perfiles',
            useProfilesOffDescription: 'Desactivado. Las sesiones nuevas usan el entorno de la máquina.',
            favoritesDescription: 'Se muestran primero al elegir un perfil.',
            customDescription: 'Perfiles que creaste. Al editar un perfil integrado se guarda aquí tu propia copia.',
            builtInDescription: 'Perfiles listos para cada agente.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Hosts SSH que este equipo puede configurar como máquinas, a los que puede conectarse o donde puede ejecutar un relay.',
            savedHostsSection: 'Hosts guardados',
            savedHostsDescription: "Primero los usados más recientemente. Abre un host para usarlo o cambiarlo.",
            hostPageDescription: "Un host SSH que este ordenador puede configurar como máquina, al que puede conectarse o donde puede ejecutar un relay.",
            newHostTitle: "Nuevo host remoto",
            newHostDescription: "Ponle nombre al host e indica cómo llegar a él por SSH.",
            useSection: "Usar este host",
            useSectionDescription: "Lo que este dispositivo puede hacer con él.",
            maintenanceSection: "Happier en este host",
            maintenanceSectionDescription: "Instala, actualiza y ejecuta allí la línea de comandos, el servicio en segundo plano y el relay de Happier.",
            discard: "Descartar",
            accessTitle: "Claves y conexiones",
            accessRowSubtitle: "Claves de host de confianza y túneles abiertos",
            accessPageDescription: "Claves de host en las que confía este dispositivo, y los túneles y rutas de acceso abiertos hacia tus hosts.",
            hostNotFound: "Este host ya no está guardado.",
            unavailableDescription: 'Los hosts SSH guardados pueden configurarse como máquinas o usarse como relays.',
            trustedHostKeysDescription: 'Claves que este dispositivo aceptó al conectarse. Elimina una para que se vuelva a preguntar la próxima vez.',
            trustedHostKeysEmpty: 'Aún no hay claves de host de confianza. Aparecen aquí cuando aceptas una al conectarte.',
            sshTunnelsDescription: 'Túneles abiertos desde este dispositivo hacia un host guardado.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const es = {
    title: 'Proveedores', entrySubtitle: 'Conecta fuentes de modelos locales y en la nube', detailTitle: 'Conexión del proveedor',
    configuredTitle: 'Tus proveedores', configuredFooter: 'Los modelos de proveedores habilitados aparecen en los selectores de modelos de los agentes compatibles.',
    availableTitle: 'Disponibles', availableFooter: 'Añade un proveedor una vez y usa sus modelos con todos los agentes compatibles.',
    customTitle: 'Proveedor personalizado', customFooter: 'Conecta una pasarela de tu empresa u otro endpoint de modelos compatible.',
    addCustom: 'Añadir proveedor personalizado', addCustomDescription: 'Usa un endpoint compatible con OpenAI o Anthropic',
    emptyTitle: 'Aún no hay proveedores conectados', emptyDescription: 'Elige un proveedor disponible o añade tu propio endpoint.',
    unavailable: 'Los proveedores no están disponibles', unavailableDescription: 'Este servidor no ha habilitado las conexiones de proveedores.',
    noMachine: 'No hay ninguna máquina disponible', noMachineDescription: 'Conecta una máquina para configurar y probar proveedores.',
    problemTitle: 'El proveedor necesita atención', searchPlaceholder: 'Buscar proveedores',
    status: { available: 'Conectado', notChecked: 'Sin comprobar', needsAttention: 'Necesita atención', unreachable: 'Inaccesible', disabled: 'Desactivado', sourceUnavailable: 'Plugin no disponible' },
    kind: { frontier: 'Proveedor de modelos', aggregator: 'Catálogo de modelos', cloud: 'Proveedor en la nube', local: 'Se ejecuta en esta máquina' },
    detail: {
        pickSecretTitle: 'Elige una clave API', notFoundTitle: 'Proveedor no encontrado', notFoundDescription: 'Esta conexión de proveedor ya no existe.',
        deletedDescription: 'Este proveedor se eliminó. Elige otro modelo antes de reanudar las sesiones que lo usaban.', sourceAvailable: 'Plugin del proveedor disponible',
        connectionTitle: 'Conexión', connectionFooter: 'Controla dónde se puede usar este proveedor y comprueba su estado actual.',
        accountAccess: 'Usar en todas las máquinas', accountAccessDescription: 'Disponible donde este proveedor se resuelva a un endpoint público',
        testConnection: 'Probar conexión', testDescription: 'Comprueba el endpoint y actualiza su catálogo de modelos', testSucceeded: 'Conexión correcta',
        testNotSupported: 'Este proveedor no admite una prueba de conexión automática', machinesTitle: 'Máquinas', machinesFooter: 'Los endpoints locales y privados deben habilitarse por separado en cada máquina.',
        currentMachine: 'Máquina actual', selectMachineToManage: 'Selecciona esta máquina para revisar y cambiar su acceso', targetMachine: 'Máquina de destino',
        machineOnline: 'En línea', machineOffline: 'Sin conexión', apiKeyTitle: 'Clave API', apiKeyFooter: 'Las claves permanecen en Secretos guardados y nunca se muestran aquí.',
        accountApiKey: 'Clave API predeterminada', machineApiKey: 'Clave API en esta máquina', apiKeyConfigured: 'Configurada', apiKeyMissing: 'Añade una clave para conectar',
        apiKeySelected: 'Clave guardada seleccionada', useAccountApiKey: 'Usa la clave predeterminada si no hay una clave para esta máquina', modelsTitle: 'Modelos', manageModels: 'Gestionar modelos',
        modelsUnknown: 'Los modelos aparecerán después de conectar', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'modelo' : 'modelos'}`,
        actionsTitle: 'Acciones', duplicateTitle: 'Añadir otra conexión', duplicateDescription: 'Crea una conexión con otro nombre para el mismo proveedor',
        deleteTitle: 'Eliminar proveedor', deleteDescription: 'Las sesiones existentes conservan su historial, pero no podrán reanudarse con este proveedor.',
        advancedTitle: 'Avanzado', endpointDefault: 'Endpoint predeterminado', endpointMachine: 'Endpoint en esta máquina', endpointMachineDescription: 'Sustituye el valor predeterminado solo donde esta máquina ejecuta el proveedor',
        endpointPrompt: 'Introduce la URL base completa del proveedor.', resetEndpoint: 'Restablecer endpoint', resetMachineEndpoint: 'Usar el endpoint predeterminado en esta máquina', resetDefaultEndpoint: 'Usar el endpoint proporcionado por el plugin del proveedor',
    },
    authoring: {
        providerTitle: 'Proveedor', builtInDescription: 'Elige un Secreto guardado y conecta este proveedor.', compatibilityTitle: 'Compatibilidad', compatibilityFooter: 'Elige el estilo de API documentado por tu proveedor.', protocolTitle: 'Compatibilidad de API',
        protocol: { 'openai-responses': { title: 'Compatible con OpenAI Responses', description: 'Para pasarelas que implementan la API Responses' }, 'openai-chat': { title: 'Compatible con OpenAI Chat', description: 'Para pasarelas que implementan Chat Completions' }, anthropic: { title: 'Compatible con Anthropic', description: 'Para pasarelas que implementan la API Messages' } },
        detailsTitle: 'Detalles del proveedor', name: 'Nombre', namePlaceholder: 'Pasarela de la empresa', baseUrl: 'URL base', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Ruta de modelos',
        credentialsTitle: 'Credenciales', credentialsFooter: 'Selecciona un Secreto guardado. Nunca pegues una clave API en la URL ni en las cabeceras.', requiresApiKey: 'Requiere una clave API',
        requiresApiKeyYes: 'Usar un Secreto guardado para las solicitudes', requiresApiKeyNo: 'Conectar sin credenciales', apiKey: 'Clave API', apiKeyDescription: 'Elige o crea un Secreto guardado',
        credentialStyleTitle: 'Formato de la clave API', credentialHeader: 'Nombre de la cabecera', credentialStyle: { bearer: 'Token bearer de autorización', xApiKey: 'Cabecera x-api-key', apiKey: 'Cabecera api-key', customHeader: 'Cabecera personalizada' },
        catalogTitle: 'Catálogo de modelos', catalogFooter: 'Obtén los modelos automáticamente si el endpoint lo permite o añádelos manualmente más tarde.', fetchModels: 'Obtener modelos automáticamente',
        fetchModelsYes: 'Usar el endpoint de lista de modelos del proveedor', fetchModelsNo: 'Añadir los ID de modelo manualmente', verifyTitle: 'Conectar', verifyFooter: 'Prueba primero cuando sea posible y después guarda el proveedor.', save: 'Guardar proveedor', connect: 'Conectar proveedor',
    },
    errors: {
        secretMissingTitle: 'Se necesita una clave API', secretMissingDescription: 'Elige un Secreto guardado antes de habilitar este proveedor.', notEnabledOnMachineTitle: 'No habilitado en esta máquina',
        notEnabledOnMachineDescription: 'Habilita este proveedor en la máquina donde se ejecutará la sesión.', disabledTitle: 'El proveedor está desactivado', disabledDescription: 'Habilita este proveedor antes de usar sus modelos.',
        unreachableTitle: 'No se puede acceder al proveedor', unreachableDescription: 'Comprueba que el servicio esté en ejecución y que el endpoint sea correcto. Después, inténtalo de nuevo.',
        notFoundTitle: 'Proveedor no encontrado', notFoundDescription: 'Este proveedor se eliminó. Elige otro proveedor o modelo.', sourceUnavailableTitle: 'Plugin del proveedor no disponible', sourceUnavailableDescription: 'Vuelve a habilitar o instalar el plugin que ofrece esta conexión.',
        featureDisabledTitle: 'Los proveedores no están disponibles', featureDisabledDescription: 'Este servidor no ha habilitado las conexiones de proveedores.', unauthorizedTitle: 'Clave API rechazada',
        unauthorizedDescription: 'Sustituye el Secreto guardado por una clave válida y vuelve a probar la conexión.', rateLimitedTitle: 'El proveedor ha limitado las solicitudes', rateLimitedDescription: 'Espera un momento y vuelve a probar la conexión.', probeCapacityTitle: 'Demasiadas comprobaciones de proveedor a la vez', probeCapacityDescription: 'Happier aún no ha podido iniciar esta comprobación en la máquina seleccionada. Espera un momento y vuelve a intentarlo.',
        genericTitle: 'El proveedor necesita atención', genericDescription: 'Revisa la configuración del proveedor y vuelve a intentarlo.',
    },
    models: { builtIn: 'Integrado', experimental: 'Experimental', experimentalConfirmTitle: '¿Usar un modelo experimental?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${model} de ${provider} aún no se ha verificado por completo con este agente. Si no funciona como esperas, puede que tengas que reiniciar o elegir otro modelo.`, experimentalConfirmAction: 'Usar modelo', stale: 'Puede no estar disponible', hidden: 'Oculto', manage: 'Gestionar modelos', empty: 'Este proveedor aún no tiene modelos disponibles.', add: 'Añadir modelos', addPlaceholder: 'Introduce un ID de modelo por línea', resetVisibility: 'Restablecer visibilidad', showHidden: 'Mostrar modelos ocultos', hideHidden: 'Ocultar modelos ocultos', remove: 'Eliminar modelo', removeConfirmation: '¿Eliminar este modelo añadido manualmente?', enable: 'Mostrar modelo', disable: 'Ocultar modelo', load: 'Cargar modelo', retry: 'Intentar de nuevo', connectionUnavailable: 'Este proveedor no está disponible en la máquina seleccionada.' },
};

const localTranslations = { es: { title: 'En esta máquina', footer: 'Servidores de modelos locales encontrados en esta máquina. Los modelos se ejecutan de forma privada en tu equipo.', detected: 'Detectado', possible: 'Posible servicio', detectedAtPort: ({ port }: { port: string }) => `Detectado · Puerto ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Posible servicio de ${provider} · Puerto ${port}`, addConnectionTitle: 'Añadir otra conexión local', addConnectionDescription: 'Ponle un nombre para distinguirla de tus otros endpoints locales.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} local` } } as const;

const providerManagedDeploymentTranslations = { es: {
        configureManaged: 'Ejecutar sesiones con un servicio local gestionado',
        configureManagedDescription: 'Elige la cuenta conectada o el grupo para sesiones futuras. Happier inicia el servicio cuando una sesión lo necesita.',
        subscriptionPolicyTitle: 'El enrutamiento de suscripciones es experimental',
        subscriptionPolicyDescription: 'Las políticas o medidas de cumplimiento del proveedor original pueden cambiar y hacer que deje de funcionar. Happier muestra el rechazo y no usa silenciosamente otra credencial.',
        accountScopeMismatchTitle: 'Las cuentas conectadas están en el servidor activo',
        accountScopeMismatchDescription: 'Este proveedor se gestiona en una máquina de otro servidor. Cambia a ese servidor para elegir su cuenta conectada o grupo.',
        editManagedDefaults: 'Editar valores de sesiones gestionadas',
        editManagedDefaultsDescription: 'Cambia la cuenta conectada o el grupo para sesiones futuras. Las sesiones existentes conservan su selección.',
        purposeTargetTitle: 'Destino de cuenta conectada',
        purposeTargetDescription: 'Elige una cuenta conectada o un grupo disponible para este propósito.',
        invalidPurposeTargetTitle: 'Destino de cuenta no válido',
        invalidPurposeTargetDescription: 'Elige una cuenta conectada o un grupo disponible antes de guardar.',
        useExternal: 'Usar un servicio externo',
        useExternalDescription: 'Deja de gestionar este proveedor para sesiones futuras y usa su configuración de endpoint externo.',
        useExternalConfirmTitle: '¿Usar un servicio externo?',
        useExternalConfirmDescription: 'Se eliminan los valores gestionados. Las sesiones existentes conservan sus selecciones.',
    } } as const;

const copyNameTranslations = { es: ({ name }: { name: string }) => `Copia de ${name}` } as const;

const providerSharedFieldTranslations = { es: {
        local: { installedNotRunning: 'Instalado, pero no está en ejecución', appRunningServerOff: 'La aplicación está abierta, pero su servidor local está desactivado', startManaged: ({ provider }: { provider: string }) => `Iniciar ${provider}`, startedByHappier: 'Iniciado por Happier', runningOutsideHappier: 'Ejecutándose fuera de Happier' },
        apiKeyOptionalDescription: 'Opcional: elige un Secreto guardado si este proveedor requiere uno',
        models: { addDescription: 'Añade ID de modelo que este proveedor no enumera automáticamente', addHelp: 'Introduce un ID de modelo exacto por línea. Se omiten los modelos existentes.', addFieldLabel: 'ID de modelo', invalidModelIds: ({ ids }: { ids: string }) => `Estos ID de modelo no son válidos: ${ids}`, noNewModels: 'No hay nuevos ID de modelo que añadir.', providerManagedTitle: 'Este proveedor gestiona los modelos', providerManagedDescription: 'Actualiza el catálogo del proveedor para renovar esta lista. No se admiten ID de modelo manuales.', showAll: 'Mostrar todos los modelos', hideAll: 'Ocultar todos los modelos', hideAllConfirmation: '¿Ocultar todos los modelos de esta lista? Puedes volver a mostrarlos en cualquier momento.', showOnly: 'Mostrar solo este modelo', showOnlyConfirmation: '¿Ocultar todos los demás modelos de esta lista? Puedes restaurarlos en cualquier momento.' },
    } } as const;

const providerFirstSessionValidationTranslations = { es: 'Happier validará la conexión de forma segura al iniciar la primera sesión que la use.' } as const;

const providerMigrationTranslations = { es: { reviewTitle: 'Revisar migración del proveedor', reviewFooter: 'Comprueba el endpoint, el formato de API, la credencial y los modelos antes de aplicar cambios.', legacyProfileDescription: 'Este perfil conserva el enrutamiento antiguo hasta que confirmes la revisión.', credentialTitle: 'Credencial', credentialFooter: 'Solo se mueve la referencia al Secreto guardado; su valor nunca se muestra ni se copia.', noCredential: 'Sin clave API', credentialMoveDescription: 'Mover esta credencial a la nueva conexión', noCredentialDescription: 'Crear la conexión sin credenciales', actionsTitle: 'Migración', preview: 'Revisar cambios', previewDescription: 'Validar esta configuración sin cambiar ajustes', confirm: 'Crear conexión del proveedor', confirmDescription: 'Aplicar los cambios de forma atómica y conservar las preferencias de inicio', reviewAction: 'Revisar migración del proveedor', reviewActionDescription: 'Mover el endpoint y los modelos antiguos a una conexión', retainedTitle: 'Configuración antigua conservada', retainedDescription: 'Esta configuración seguirá disponible hasta que pueda migrarse sin perder comportamiento.' } } as const;

const providerMigrationPreviewTranslations = { es: { willMoveTitle: 'Se moverá al proveedor', willMoveFooter: 'Solo se mueven estos nombres de enrutamiento y credenciales. Los valores secretos nunca se muestran.', willKeepTitle: 'Permanecerá en el perfil de inicio', willKeepFooter: 'Estos ajustes exclusivos del inicio permanecen en el perfil después de la migración.', permissionDefaults: 'Permisos predeterminados', persistenceDefaults: 'Almacenamiento de sesión predeterminado' } } as const;

const providerMigrationConflictTranslations = { es: { conflictReviewTitle: 'Resolver conflicto de migración', conflictReviewFooter: 'Elige si quieres conservar la conexión existente o guardar este perfil como una conexión independiente. No se muestran valores secretos.', conflictCredential: 'La credencial guardada es diferente', conflictModels: 'Los ajustes de modelos son diferentes', conflictEditedConnection: 'La conexión existente se modificó', keepExisting: 'Conservar conexión existente', keepExistingDescription: 'Mantén sus credenciales y modelos actuales y completa la migración sin sustituirlos.', modelOutcomeTitle: 'Elige qué modelo conservar', modelOutcomeFooter: 'Revisa el modelo exacto antes de completar la migración. Nada cambia hasta que elijas.', useExistingModel: 'Usar el modelo actual de la conexión', useExistingModelDescription: 'Conserva el modelo ya seleccionado para esta conexión del proveedor.', preserveLegacyModel: 'Usar el modelo del perfil', preserveLegacyModelDescription: 'Mueve la selección exacta de este perfil a la conexión existente.', discardLegacyModel: 'Eliminar la selección de modelo del perfil', discardLegacyModelDescription: 'Completa la migración sin la selección de modelo ni el favorito de este perfil.', createNamed: 'Crear conexión independiente', createNamedDescription: 'Conserva los ajustes del proveedor de este perfil en una conexión nueva.', separateConnectionName: 'Nombre de la conexión', conflictReviewAction: 'Resolver conflicto del proveedor', conflictReviewActionDescription: 'Elige cómo conservar las credenciales o modelos en conflicto' } } as const;

const providerCredentialSelectionRequiredTranslations = { es: 'Elige qué credencial guardada debe usar esta conexión del proveedor' } as const;

const providerLinkTranslations = { es: { providerWebsite: 'Sitio web del proveedor', getApiKey: 'Obtener clave API', failedToOpen: 'Happier no ha podido abrir este enlace.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { es: 'Elige cómo se envía esta credencial' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { es: 'Conecta este editor de perfiles a una máquina disponible antes de cambiar variables de entorno.' } as const;

const providerAdvancedAuthoringTranslations = { es: { advancedSetup: 'Configuración avanzada', advancedSetupEnabled: 'Configura varios estilos de API, cabeceras y comprobaciones seguras de modelos', advancedSetupDisabled: 'Usa un endpoint compatible habitual', endpointEnabled: 'Usar este estilo de API', endpointEnabledDescription: 'Ofrece este endpoint a los agentes compatibles', endpointDisabledDescription: 'Este estilo de API no se usará', publicHeaders: 'Cabeceras públicas de solicitud', publicHeadersPlaceholder: 'X-Tenant: ingeniería', optionalProbePath: 'Ruta de lista de modelos (opcional)', probeParserTitle: 'Formato de respuesta', probeParser: { openaiModels: 'Lista de modelos compatible con OpenAI', ollamaTags: 'Etiquetas de Ollama', lmStudioNative: 'Lista de modelos nativa de LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { es: 'Cabecera personalizada (token Bearer)' } as const;

const providerNonSecretHeaderTranslations = { es: 'Cabeceras no secretas' } as const;

const providerProbePathsTranslations = { es: 'Rutas de lista de modelos (opcionales, una por línea)' } as const;

const providerLocalAuthoringTranslations = { es: { enableAfterSaving: 'Activar este proveedor', enableOnCurrentMachine: 'Activar solo en esta máquina después de guardar', enableAccountWide: 'Activar después de guardar', localAddressTitle: 'Dirección local', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Actívalo por separado en cada máquina. ${machine} usará ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { es: { destinationReview: 'Destino de la conexión', destinationLoading: 'Resolviendo el destino exacto en el daemon…', destinationSelection: 'Elige un destino', destinationSelectionDescription: 'Revisa la dirección exacta antes de conectar.', destinationScope: 'Ámbito del destino', destinationMachine: 'Esta máquina', destinationAccount: 'Cuenta' } } as const;

const providerCompatibilityTranslations = { es: { title: 'Funciona con', footer: 'La compatibilidad la verifica cada integración de agente y puede variar según el modelo.', verified: 'Verificado', experimental: 'Experimental', incompatible: 'Incompatible', verifiedDescription: 'Probado con esta integración de agente', experimentalDescription: 'Puede funcionar, pero requiere revisión antes del primer uso', incompatibleDescription: 'Este agente no puede usar la conexión de forma segura' } } as const;

const providerModelNotLoadedTranslations = { es: 'No cargado · puede cargarse al usarlo por primera vez' } as const;

const providerModelLoadCancellationTranslations = { es: { cancelLoad: 'Cancelar carga', loadCancelled: 'Se dejó de esperar al modelo', loadCancelledProviderMayContinue: 'El proveedor puede seguir cargándolo. Actualiza el catálogo más tarde para comprobar si terminó; Happier no repetirá la carga.' } } as const;

const providerPartialStatusTranslations = { es: 'Disponible parcialmente' } as const;

const providerConnectedServiceSuppressedTranslations = { es: 'El inicio de sesión nativo del agente no se usa con este proveedor. Tu selección guardada no cambia.' } as const;

const providerMachineCleanupPendingTranslations = { es: 'La máquina se eliminó, pero no se pudo guardar la limpieza de acceso a proveedores. Comprueba la conexión y vuelve a eliminar la máquina para reintentarlo.' } as const;

const providerConnectionChangedTranslations = { es: { title: 'La conexión del proveedor cambió', description: 'Vuelve a cargar la configuración actual del proveedor e inténtalo de nuevo.' } } as const;

const providerModelSectionTranslations = { es: { available: 'Disponibles', manual: 'Manual' } } as const;

const providerCompletenessTranslations = { es: {
        searchEmptyTitle: 'Ningún proveedor coincide con esta búsqueda',
        searchEmptyDescription: 'Prueba con otro nombre de proveedor o conexión.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Este agente y el proveedor no comparten ningún protocolo de API compatible.',
            noAuthUnsupported: 'Este agente requiere enviar una clave API para este proveedor.',
            credentialTransportUnavailable: 'Este agente no admite el método configurado para enviar la clave API.',
            optionalCredentialNoAuthUnsupported: 'Este agente no puede usar el proveedor sin la clave API opcional.',
            capabilityUnsupported: 'No se admite una capacidad obligatoria del proveedor.',
            capabilityUnknown: 'Aún no se ha verificado una capacidad obligatoria del proveedor.',
            modelEvidenceRequired: 'Elige un modelo para verificar las capacidades que requiere.',
            modelCapabilityUnsupported: 'El modelo no admite una capacidad obligatoria.',
            modelCapabilityUnknown: 'Aún no se ha verificado una capacidad obligatoria del modelo.',
            overrideIncompatible: 'La verificación del proveedor marca esta integración como incompatible.',
            overrideExperimental: 'La verificación del proveedor marca esta integración como experimental.',
            evidenceMissing: 'Aún no se han registrado pruebas de compatibilidad.',
            agentUnsupported: 'Este agente no admite proveedores de modelos externos.',
            adapterInvalid: 'No se ha podido validar el adaptador de proveedor del agente.',
            unknown: 'Hay que revisar una condición de compatibilidad más reciente.',
        },
        unsavedDescription: '¿Descartar este borrador de proveedor? Los Secretos guardados son objetos compartidos de la cuenta y seguirán disponibles.',
        recoveryActions: {
            reviewFeatures: 'Revisar disponibilidad de proveedores',
            chooseConnection: 'Elegir proveedor',
            restorePlugin: 'Revisar plugin',
            enableConnection: 'Habilitar proveedor',
            reviewAccountGrant: 'Revisar acceso de la cuenta',
            enableOnMachine: 'Habilitar en la máquina',
            reviewMachineGrant: 'Revisar acceso de la máquina',
            reviewCompatibility: 'Revisar compatibilidad',
            addSecret: 'Añadir clave API',
            reviewCredentialTransport: 'Revisar compatibilidad de credenciales',
            reviewConnection: 'Revisar conexión',
            retry: 'Intentarlo de nuevo',
            replaceSecret: 'Sustituir clave API',
            chooseModel: 'Elegir modelo',
            loadModel: 'Cargar modelo',
            reviewAndRestart: 'Revisar y reiniciar',
            restartProbe: 'Volver a probar',
            reduceProviderSettings: 'Gestionar ajustes de proveedores',
            reviewProfileMigration: 'Revisar migración del perfil',
            reviewCurrentState: 'Revisar ajustes actuales',
        },
        hiddenForAllAgents: 'Oculto para todos los agentes · Gestiona en los ajustes de Proveedores',
    } } as const;

const providerAvailabilityTranslations = { es: {
        availabilityChecking: 'Comprobando la disponibilidad de proveedores', availabilityCheckingDescription: 'Happier está confirmando si este servidor admite conexiones de proveedores.',
        availabilityProblem: 'No se pudo comprobar la disponibilidad de proveedores', availabilityProblemDescription: 'Happier volverá a intentarlo automáticamente. Comprueba la conexión del servidor si el problema continúa.',
        availabilityUnsupported: 'Los proveedores requieren una actualización del servidor', availabilityUnsupportedDescription: 'Esta versión del servidor no admite conexiones de proveedores.',
        availabilityContextUnsupported: 'Los proveedores no son compatibles en este contexto', availabilityContextUnsupportedDescription: 'La configuración o selección actual del servidor no admite conexiones de proveedores.',
        availabilityPolicyDisabled: 'Los proveedores están desactivados por una política', availabilityPolicyDisabledDescription: 'Una política local o de compilación ha desactivado las conexiones de proveedores.',
    } } as const;

const settingsProvidersTranslations = { es: withProviderSharedFields(es, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.es,
        providerLinkTranslations: providerLinkTranslations.es,
        providerCompletenessTranslations: providerCompletenessTranslations.es,
        providerPartialStatusTranslations: providerPartialStatusTranslations.es,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.es,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.es,
        providerCompatibilityTranslations: providerCompatibilityTranslations.es,
        providerMigrationTranslations: providerMigrationTranslations.es,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.es,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.es,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.es,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.es,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.es,
        localTranslations: localTranslations.es,
        providerSharedFieldTranslations: providerSharedFieldTranslations.es,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.es,
        copyNameTranslations: copyNameTranslations.es,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.es,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.es,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.es,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.es,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.es,
        providerProbePathsTranslations: providerProbePathsTranslations.es,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.es,
        providerModelSectionTranslations: providerModelSectionTranslations.es,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.es,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.es,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.es,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { es: translated({
        settingsSearchKeywords: {
            settings: 'ajustes, configuración, inicio, resumen',
            groupProfileAndAccount: 'cuenta, perfil, facturación, plan, uso',
            account: 'cuenta, perfil, facturación',
            accountSecurity: 'seguridad, contraseña, recuperación, cifrado, cerrar sesión',
            apiTokens: 'token de api, token de acceso personal, pat, automatización, cli, sdk',
            teams: 'equipos, miembros, grupos, invitaciones',
            homeAdministration: 'home, administración, gobernanza, personas, políticas',
            secrets: 'secretos, claves, env, tokens',
            usage: 'uso, facturación, límites, cuota',
            machines: 'máquinas, dispositivos, ordenador',
            machinePoolsNew: 'grupos de máquinas, pools, respaldo, ejecutar en',
            machinesAdd: 'añadir, máquina, ssh',
            machinesThisComputer: 'este ordenador, local, dispositivo',
            remoteHosts: 'remoto, host, hosts, ssh, servidor, máquinas',
            groupGeneral: 'general, apariencia, idioma, experimentos',
            appearance: 'apariencia, tema, fuente, interfaz, barra lateral',
            keyboard: 'teclado, atajo, atajos, teclas rápidas, comandos',
            pets: 'mascotas, blink, compañero, codex',
            language: 'idioma, región, traducción',
            features: 'funciones, experimentos, beta',
            groupAiAndAgents: 'agentes, proveedores, mcp, prompts, voz',
            agents: 'proveedores, agentes, modelos, llm',
            providers: 'proveedores, modelos, openrouter, ollama, lm studio',
            subAgent: 'subagentes, agentes, delegación, reglas',
            roles: 'roles, orquestador, constructor, revisor, instrucciones',
            delegation: 'delegación, profundidad, traspaso, orquestador',
            profiles: 'perfiles, personas',
            connectedServices: 'servicios conectados, oauth, cuentas',
            mcp: 'mcp, herramientas, servidores, plugins',
            plugins: 'plugins, complementos, catálogo, descriptor, descubrimiento',
            prompts: 'prompts, plantillas, biblioteca',
            promptsTemplates: 'plantillas',
            promptsFolders: 'carpetas',
            promptsStacks: 'pilas',
            promptsRegistries: 'registros',
            promptsLibrary: 'biblioteca',
            promptsAssets: 'recursos, externo',
            voice: 'voz, asistente, micrófono',
            voiceConversations: 'voz, conversación, tiempo real, proveedor',
            voiceDictation: 'voz, dictado, habla, transcripción',
            voicePrivacy: 'voz, privacidad, historial, retención',
            voiceAdvanced: 'voz, avanzado, máquina, diagnóstico',
            memory: 'memoria, búsqueda, índice',
            groupSessionsBehavior: 'sesiones, transcripción, permisos, acciones',
            session: 'sesión, terminal, tmux',
            externalSessions: 'sesiones externas, seguimiento en segundo plano, hooks',
            actions: 'acciones, aprobaciones, atajos',
            embeds: 'inserciones, insertar, iframe, widget, sitio web, chat',
            transcript: 'transcripción, chat, diseño',
            permissions: 'permisos, aprobación, seguridad',
            toolRendering: 'herramientas, visualización',
            handoff: 'traspaso, transferencia',
            runs: 'ejecuciones, ejecución',
            groupFilesAndSourceControl: 'archivos, control de versiones, adjuntos',
            sourceControl: 'git, scm, control de versiones',
            attachments: 'adjuntos, subidas, archivos',
            groupSystem: 'sistema, servidores, estado, notificaciones',
            servers: 'servidores, relé',
            systemStatus: 'estado del sistema, salud, diagnóstico',
            updates: 'actualizaciones, actualizar, versión, cli, reiniciar',
            notifications: 'notif, notificación, notificaciones, push',
            notificationsPush: 'push, notificaciones push',
            desktop: 'escritorio, tauri, superposición, ventana',
            diagnosis: 'diagnóstico, depuración',
            reportIssue: 'informar de un problema, error, bug',
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
>, "es"> = { es: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Arregla la prueba de reconexión inestable',
                agentReply: 'Encontrado: el temporizador de reintentos nunca se limpiaba. Ya está arreglado y la prueba pasa.',
                thinking: 'La prueba solo falla tras un tiempo de espera, así que el temporizador de reintentos seguramente sigue activo.',
            },
            runtime: {
                pageDescription: 'Cómo se ejecutan las sesiones en tus máquinas.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Terminal para nuevas sesiones',
                terminalHostNone: 'Ninguno',
                tmuxTitle: 'Iniciar sesiones en tmux',
                tmuxOn: 'Las sesiones nuevas se abren en su propia ventana de tmux, para que puedas conectarte a ellas desde una terminal.',
                tmuxOff: 'Las sesiones nuevas se ejecutan en una shell normal.',
            },
            wizard: {
                pageDescription: 'Cómo organiza sus pasos el asistente de nueva sesión.',
                wideScreensSection: 'Pantallas anchas',
                stepsSection: 'Cómo muestra cada paso sus opciones',
                steps: {
                    profiles: 'Perfil',
                    backends: 'Agente',
                    models: 'Modelo',
                    machines: 'Máquina',
                    paths: 'Carpeta',
                    permissions: 'Permisos',
                },
            },
            providerLimits: {
                pageDescription: 'Qué pasa cuando se alcanza el límite de uso de un proveedor y cuánta cuota te queda.',
                recoveryDescription: 'Cuando un agente alcanza el límite de uso de su proveedor, la sesión puede esperar al reinicio y continuar.',
                resumePromptCustom: 'Personalizado',
                unavailableTitle: 'No disponible en este Home',
                unavailableDescription: 'La recuperación tras el límite de uso y el indicador de uso del proveedor no están activados en este Home.',
            },
            resume: {
                pageDescription: 'Cómo continúa una sesión inactiva cuando su agente no puede reanudarla por sí mismo.',
                strategyRecent: 'Mensajes recientes',
                strategySummary: 'Resumen + recientes',
                maxSeedCharsTitle: 'Límite de tamaño de la repetición',
                summaryModelSection: 'Modelo de resumen',
                summaryModelDescription: 'El agente y el modelo que escriben el resumen que se repite en la nueva sesión.',
                handoffSection: 'Mover sesiones',
                handoffLinkDescription: 'Qué se mueve con una sesión cuando la pasas a otra máquina.',
            },
            permissions: {
                duringSessionSection: 'Durante una sesión',
                duringSessionDescription: 'Dónde aparecen las solicitudes de aprobación y cuándo surte efecto un cambio de permisos en una sesión en curso.',
                promptSurfaceComposer: 'Junto al compositor',
                applyImmediately: 'Al instante',
                applyNextMessage: 'Siguiente mensaje',
                storageUseDefault: 'Predeterminado',
            },
            handoff: {
                pageDescription: 'Qué se mueve con una sesión cuando la pasas a otra máquina.',
                workspaceSection: 'Archivos del espacio de trabajo',
                workspaceDescription: 'Qué pasa con la carpeta del proyecto cuando una sesión se mueve a otra máquina.',
                keepUpdated: 'Mantener al día',
                advancedModeDescription: 'Sustituye la opción de arriba. Con cuidado: se pueden eliminar o sobrescribir archivos.',
                ignoredExclude: 'Excluir',
                ignoredIncludeSelected: 'Incluir seleccionados',
            },
            toolRendering: {
                pageDescription: 'Da a herramientas concretas más o menos detalle que el predeterminado de la transcripción.',
                collapsedDescription: 'Cuánto muestra cada herramienta en la transcripción antes de abrirla.',
            },
            transcript: {
                advancedTitle: 'Rendimiento y tiempos',
                advancedPageDescription: 'Streaming, tiempos de animación y umbrales de desplazamiento. Los valores predeterminados sirven para casi todos.',
                advancedMotionOff: 'Las animaciones de la transcripción están desactivadas, así que esto no tiene efecto. Actívalas en Transcripción › Movimiento.',
                toolsSection: 'Herramientas',
                toolOverridesDescription: 'Da a herramientas concretas más o menos detalle.',
                thinkingSummary: 'Resumen',
                thinkingFull: 'Completo',
                strategyConsecutive: 'Consecutivas',
                strategyWholeTurn: 'Turno completo',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Los mensajes copiados conservan su formato e indican quién los escribió.',
                copyPlainDescription: 'Los mensajes copiados son texto sin formato, sin etiquetas.',
                motionSubtle: 'Sutil',
                advancedLinkDescription: 'Streaming, tiempos de animación y umbrales de desplazamiento.',
                pageDescription: 'Cómo se lee una conversación a medida que crece: diseño, razonamiento, herramientas, movimiento y desplazamiento.',
            },
            composer: {
                pageDescription: 'Cómo escribes y envías mensajes, y qué pasa cuando un agente está ocupado.',
                newSessionsSection: 'Sesiones nuevas',
                newSessionsDescription: 'Lo que ves al elegir Nueva sesión.',
                draftEntryTitle: 'Al abrir Nueva sesión',
                draftResume: 'Retomar borrador',
                draftFresh: 'Empezar de cero',
                typingSection: 'Escritura',
                typingDescription: 'Cómo se comportan Intro y el historial de mensajes en el compositor.',
                enterToSendTitle: 'Intro para enviar',
                sendModeTitle: 'Mientras el agente trabaja',
                sendQueue: 'En cola',
                sendInterrupt: 'Interrumpir',
                sendPending: 'Pendiente',
                busySteerTitle: 'Si el agente admite dirección',
                busySteerInactive: 'Solo se aplica cuando los mensajes se ponen en cola o quedan pendientes mientras el agente trabaja.',
                nonSteerableTitle: 'Preguntar si un mensaje no puede dirigir',
                resumeWhenPossible: 'Cuando se pueda',
                resumeIfOnline: 'Si está en línea',
                resumeNever: 'Nunca',
                pendingSection: 'Mensajes pendientes',
                pendingDescription: 'Cómo llegan al agente los mensajes pendientes.',
                pendingInactive: 'Con tus opciones actuales nada queda pendiente. Esto se aplica en cuanto un mensaje lo esté.',
                drainOne: 'De uno en uno',
                drainAll: 'Todos a la vez',
                timingAfterReply: 'Tras la respuesta',
                timingWhenIdle: 'Con todo inactivo',
                layoutSection: 'Diseño del compositor',
                actionBarTitle: 'Barra de acciones',
                actionBarAutoDescription: 'Los chips pasan a una segunda línea en pantallas anchas y se desplazan en horizontal en el teléfono.',
                actionBarWrapDescription: 'Los chips pasan a una segunda línea cuando no caben.',
                actionBarScrollDescription: 'Los chips se quedan en una línea; desplázate para ver el resto.',
                actionBarCollapsedDescription: 'Los chips se agrupan en un menú y dejan más espacio para escribir.',
                chipDensityTitle: 'Chips de acción',
                chipsAutoDescription: 'Los chips que lo necesitan conservan la etiqueta; los evidentes muestran solo su icono.',
                chipsLabelsDescription: 'Cada chip muestra su etiqueta.',
                chipsIconsDescription: 'Los chips muestran solo el icono, para ahorrar espacio.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { es: {
        publicLink: { description: "Cualquiera que tenga el enlace puede leer este documento sin una cuenta.", grants: "Documento de solo lectura.", audit: "Registro de acceso", auditEmpty: "Aún no hay visitas registradas.", ownerUpdateRequired: "El propietario está actualizando este enlace", ownerUpdateRequiredDescription: "Pide al propietario que abra Happier y vuelve a probar este enlace." },
        whoHasAccess: 'Quién tiene acceso',
        whoHasAccessStale: 'Quién tiene acceso · puede no estar actualizado',
        owner: 'Propietario',
        you: 'Tú',
        addPlaceholder: 'Añadir personas o equipos',
        person: 'Persona',
        group: 'Grupo de equipo',
        team: 'Equipo',
        accessLevel: 'Nivel de acceso',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Quitar acceso',
        confirmRemove: 'Confirmar',
        removedAnnouncement: ({ name }) => `${name} ya no tiene acceso`,
        browseAll: 'Ver todo',
        allLoaded: 'Todos los resultados cargados',
        copyLink: 'Copiar enlace',
        linkCopied: 'Enlace copiado',
        copyLinkFailed: 'No se pudo copiar el enlace.',
        sendCopy: 'Enviar una copia en su lugar',
        secrets: {
            levels: { canUse: 'Puede usar' },
            help: { use: 'en ejecuciones; su valor nunca se muestra' },
            oneLevel: 'Un secreto guardado solo lo usan las ejecuciones y su valor nunca sale, así que tiene un único nivel.',
        },
        documents: {
            title: 'Compartir',
            shareTitle: ({ name }) => `Compartir ${name}`,
            levels: { canUse: 'Puede usar', canRead: 'Puede leer', canEdit: 'Puede editar', admin: 'Administrar' },
            help: {
                workflowUse: 'verlo y ejecutarlo',
                roleUse: 'usarlo; sus propios cambios quedan en sus Ajustes',
                profileUse: 'iniciar sesiones con él',
                documentUse: 'abrirlo y copiarlo en cualquiera de sus dispositivos',
                promptUse: 'usarlo en sus sesiones',
                boardUse: 'ver el tablero; cada tarjeta abre solo lo que ya puede abrir',
                editForEveryone: 'cambiarlo para todas las personas con acceso',
                adminOwnerShares: 'cambiarlo y gestionar el uso compartido; solo el propietario puede asignar Admin',
            },
            notes: {
                personalRuns: 'Las ejecuciones y los disparadores quedan con quien los inicia.',
                teamRuns: 'El equipo ve cada ejecución.',
                roleLive: 'Tus cambios llegan a todas las personas con quienes se comparte.',
                profileSecrets: 'Los valores secretos nunca viajan · vincula un Secreto guardado',
            },
            errors: {
                unavailable: 'Compartir aún no está disponible aquí.',
                ownerOnly: 'Solo el propietario o un administrador puede cambiar quién tiene acceso.',
                noAccess: 'Ya no tienes acceso.',
                notFound: 'Ya no está disponible.',
                subjectUnavailable: 'Esta persona, grupo o equipo no puede recibir acceso.',
                failed: 'No se pudo actualizar el uso compartido. Inténtalo de nuevo.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "es">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { es: {
        linkToService: ({ service }) => `Vincular con ${service}`,
        addHomeOrSignIn: 'Añadir un Home o iniciar sesión',
        usageNoAccounts: 'Conecta una cuenta para ver cuánto queda de sus límites.',
        usageHealthy: 'Queda margen de sobra en todos los límites',
        homeUnreachableTitle: ({ home }) => `No se puede conectar con ${home}`,
        homeUnreachableBody: 'Tus máquinas y sesiones volverán a aparecer aquí cuando responda.',
        homeUnreachableLine: ({ home }) => `No se puede conectar con ${home}.`,
        availableWhenHomeAnswers: "Disponible cuando este Home responda.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 clave sin límites' : `${count} claves sin límites`,
        usageSignedOut: 'Sesión cerrada',
        hideAccountIdentities: 'Ocultar correos e ID de las cuentas',
        accountIdentitiesHidden: 'Correos e ID ocultos · para directos y demos',
        usageThisSession: 'Esta sesión',
        usageAllAccounts: 'Todas las cuentas',
        usageMoreAccounts: ({ count }) => `${count} más`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} inicia sesión a través de ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} inicia sesión con esta cuenta`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} usa su propio inicio de sesión`,
        usagePoolFallback: 'su grupo',
        usageNextInOrder: ({ account }) => `Cuando ${account} se agote, el siguiente turno pasará a la siguiente cuenta en orden`,
        usageNextMostLeft: ({ account }) => `Cuando ${account} se agote, el siguiente turno pasará a la cuenta con más margen`,
        usageNextStays: ({ pool, account }) => `${pool} sigue con ${account} hasta que cambies`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "es">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { es: {
        stillWaiting: ({ seconds }) => `Seguimos esperando · ${seconds} s`,
        asOf: ({ time }) => `A las ${time}`,
        howItWorks: 'Cómo funciona',
        tryAgain: 'Reintentar',
        checkAgain: 'Volver a comprobar',
        paneFailedTitle: 'No se pudo mostrar este panel',
        paneFailedReason: 'Algo salió mal al dibujarlo. Tu sesión no se ve afectada.',
        opening: ({ name }) => `Abriendo ${name}`,
        couldNotOpen: ({ name }) => `No se pudo abrir ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "es">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const spanish: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: 'Las sesiones compartidas con este equipo.',
        },
        pages: {
            credentialCreate: 'Elige qué compartir, quién puede usarlo y sus límites.',
            credentialDetail: 'Quién puede usar esta credencial, cómo y cuánto.',
            credentialEdit: 'Cambia quién puede usar esta credencial, cómo y cuánto.',
            credentialActivity: 'Los cambios en esta credencial y quién los hizo.',
            credentialUsage: 'Cuánto se ha usado esta credencial y quién la usó.',
            credentialExternalApi: 'Usa esta credencial desde herramientas fuera de Happier.',
            identityProviderNew: 'Conecta un proveedor de identidad con el que los miembros puedan iniciar sesión.',
            identityProviderEdit: 'Cambia cómo se conecta este proveedor de identidad.',
            githubApp: 'Una GitHub App que este equipo usa para acceder a repositorios.',
            githubAppEdit: 'Cambia el registro de esta GitHub App.',
            authentication: 'Cómo inician sesión los miembros en este equipo y a quién admite.',
            credentials: 'Las credenciales de proveedor que este equipo comparte con sus miembros.',
            directory: 'Grupos de personas que comparten sesiones, accesos y credenciales en un Home.',
            members: 'Quién está en este equipo y qué puede hacer cada persona.',
            addMember: 'Añade a alguien que ya tenga una cuenta en este Home.',
            groups: 'Conjuntos de miembros con nombre para compartir sesiones y credenciales.',
            newGroup: 'Pon nombre al grupo y elige quién forma parte.',
            invitations: 'Las invitaciones que permiten unirse a este equipo y para quién son.',
            newInvitation: 'Invita a alguien a unirse a este equipo.',
            settings: 'Nombre, logotipo, valores predeterminados de las sesiones y si el equipo está activo.',
        },
        loading: 'Cargando el equipo…',
        title: 'Equipos',
        entrySubtitle: 'Crea equipos, gestiona miembros y grupos, e invita a personas.',
        entry: {
            heading: ({ team }: { team: string }) => `Continuar a ${team}`,
            onHome: ({ home }: { home: string }) => `en ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Inicia sesión a través de ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `El inicio de sesión a través de ${service} no está disponible`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Sesión iniciada en ${home} como ${account}`,
            unnamedAccount: 'Cuenta de Happier',
            continueWith: ({ method }: { method: string }) => `Continuar con ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} no está disponible`,
            providerUnavailableDisabled: 'El administrador de tu Team desactivó este inicio de sesión. Vuelve a comprobarlo más tarde.',
            providerUnavailableSetupIncomplete: 'El administrador de tu Team todavía no terminó de configurar este inicio de sesión. Vuelve a comprobarlo más tarde.',
            providerUnavailableUnavailable: 'Este Home no puede usar este inicio de sesión ahora mismo. Vuelve a comprobarlo más tarde.',
            unknownTargetTitle: 'Este enlace no identifica su Home',
            unknownTargetBody: 'Este dispositivo no puede saber a qué Home pertenece este enlace de acceso al equipo, así que no se envió nada. Pide el enlace de nuevo a quien gestione el equipo.',
            ssoRequiredTitle: 'Este Team necesita otro método de inicio de sesión',
            ssoRequiredBody: 'Has iniciado sesión en este Home, pero este Team solo acepta el método de inicio de sesión que exige. Vuelve a iniciar sesión con ese método o regresa a tu propio trabajo.',
            invitationUnavailableTitle: 'Esta invitación no se puede usar',
            invitationUnavailableBody: 'Puede haber caducado, haber sido revocada o ya haberse usado. Iniciar sesión por sí solo no te une al Team.',
            wrongAccountTitle: 'Esta cuenta no puede usar este inicio de sesión',
            wrongAccountBody: 'La cuenta o identidad con la que iniciaste sesión no es la que este Team espera. Inicia sesión con otra cuenta u otro proveedor, o regresa a tu propio trabajo.',
            notProvisionedTitle: 'Este Team todavía no te ha admitido',
            notProvisionedBody: 'Iniciar sesión por sí solo no te une a este Team. Su administrador decide quién es admitido; pídele acceso o una invitación y vuelve a intentarlo.',
            directoryDelayedTitle: 'Tu acceso todavía está en camino',
            directoryDelayedBody: 'Este Team recibe sus miembros de un directorio que aún no ha entregado tu acceso. Inténtalo de nuevo más tarde o pregunta a un responsable del Team.',
            accessRemovedTitle: 'Este Team no está disponible para ti',
            accessRemovedBody: 'Es posible que tu acceso se haya retirado o que el Team no esté disponible en este Home ahora mismo. Todo lo demás en lo que has iniciado sesión sigue igual.',
            providerChangedTitle: 'Este método de inicio de sesión cambió mientras lo usabas',
            providerChangedBody: 'Un administrador actualizó este método de inicio de sesión durante tu inicio de sesión. No se cambió nada en tu cuenta. Empieza de nuevo desde la página del Team para ver los métodos actuales.',
            returnToTeamSignIn: 'Volver al inicio de sesión del Team',
            returnToHappier: 'Volver a Happier',
            signInToTeam: 'Iniciar sesión en este Team',
            readyStatus: 'Elige cómo iniciar sesión para continuar.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Propietario',
            admin: 'Administrador',
            member: 'Miembro',
            guest: 'Invitado',
        },
        roleHelp: {
            owner: 'Es propietario del equipo, puede gestionarlo y cambiar propietarios.',
            admin: 'Tiene el acceso de Miembro y puede gestionar el equipo.',
            member: 'Recibe de forma predeterminada el acceso concedido al equipo.',
            guest: 'Solo ve las sesiones y los recursos compartidos explícitamente con esta cuenta o con un grupo al que pertenece.',
        },
        status: {
            active: 'Activo',
            suspended: 'Suspendido',
        },
        history: {
            label: 'Historial de sesiones',
            allExisting: 'Incluir las sesiones ya compartidas con el equipo',
            fromMembership: 'Solo las sesiones compartidas después de su incorporación',
            allExistingNamed: ({ name }) => `Incluir las sesiones ya compartidas con ${name}`,
            fromMembershipNamed: ({ name }) => `Solo las sesiones compartidas después de su incorporación a ${name}`,
            scopeNote: 'Esto se aplica a sesiones completas. No revela únicamente los mensajes creados tras la incorporación.',
        },
        unavailable: {
            title: 'Los equipos no están disponibles en este Home',
            disabled: 'Este Home tiene los equipos desactivados.',
            updateRequired: 'Este Home necesita una actualización para usar equipos.',
            offline: 'Este Home no está accesible en este momento.',
            retry: 'Reintentar',
        },
        stale: {
            label: 'Mostrando los últimos datos conocidos de este Home.',
        },
        errors: {
            generic: 'No se pudo completar. No se cambió nada.',
            outcomeUnknown: 'Es posible que el Home haya completado este cambio. Actualiza el equipo antes de volver a intentarlo.',
            forbidden: 'No tienes permiso para este cambio.',
            notFound: 'Este equipo ya no está disponible.',
            archived: 'Este equipo está archivado. Restáuralo para hacer cambios.',
            conflict: 'Otra persona lo cambió antes. Revisa los valores actuales e inténtalo de nuevo.',
            offline: 'Este Home no está accesible, así que el cambio no se envió.',
            invalidName: 'Introduce un nombre de entre 1 y 80 caracteres.',
            invalidDescription: 'Introduce una descripción de 500 caracteres como máximo.',
        },
        directory: {
            loading: 'Cargando equipos…',
            chooseTeamToShare: 'Elige el equipo con el que compartirlo.',
            noMatches: 'Ningún equipo coincide',
            noLoadedMatches: 'Ningún equipo cargado coincide',
            searchLoadedPlaceholder: 'Filtrar equipos cargados',
            unreachableHomes: 'Sin respuesta',
            searchPlaceholder: 'Buscar equipos',
            newTeam: 'Nuevo equipo',
            createDenied: ({ homes }: { homes: string }) => `Solo los administradores de ${homes} pueden crear equipos. Pide a uno que cree un equipo o que te añada a uno.`,
            createAdministered: ({ names }: { names: string }) => `En este Home, los equipos los crean sus administradores. Pide a ${names} un equipo para ti, o que todos puedan crear equipos.`,
            createAdministeredUnnamed: 'En este Home, los equipos los crean sus administradores. Pide a uno de ellos un equipo para ti, o que todos puedan crear equipos.',
            createOff: 'La creación de equipos está desactivada en este Home.',
            letEveryoneCreate: 'Permitir que todos creen equipos',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} y ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} y ${count} más`,
            emptyTitle: 'Aún no hay equipos',
            emptyBody: 'Un equipo ofrece a un grupo de personas un espacio común para sesiones, personas y accesos.',
            archivedSection: 'Equipos archivados',
            archivedEmpty: 'No hay equipos archivados',
            archivedEmptyBody: 'Archivar un equipo desde sus propios ajustes lo mueve aquí. Se conservan sus miembros, grupos e historial.',
            showArchived: 'Mostrar archivados',
            hideArchived: 'Ocultar archivados',
            archivedBadge: 'Archivado',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, en ${home}`,
            partialHomes: 'No se pudo contactar con algunos Homes, por lo que faltan sus equipos en esta lista.',
        },
        create: {
            loading: 'Comprobando dónde puedes crear un equipo…',
            discard: 'Descartar',
            detailsSection: 'Equipo',
            logoFailedBody: 'El equipo se creó, pero su logotipo no se publicó. Vuelve a intentarlo o continúa sin él.',
            title: 'Nuevo equipo',
            nameLabel: 'Nombre',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Descripción',
            descriptionPlaceholder: 'En qué trabaja este equipo',
            homeHelp: 'El equipo se crea en este Home y permanece allí.',
            duplicateNameNote: 'Dos equipos pueden compartir nombre. Los enlaces y los accesos siempre usan el equipo en sí.',
            managedOnlyTitle: 'La creación de equipos se administra en este Home',
            managedOnlyBody: 'Un administrador crea aquí los equipos y elige al primer propietario.',
            initialOwnerLabel: 'Primer propietario',
            initialOwnerPlaceholder: 'Buscar personas en este Home',
            initialOwnerHelp: 'Crear un equipo para otra persona no te añade a él.',
            initialOwnerRequired: 'Elige al primer propietario del equipo. En este Home, un administrador designa quién es propietario de un equipo nuevo.',
            initialOwnerIneligible: 'Esa persona ya no puede ser propietaria de un equipo. Elige a otra persona.',
            submit: 'Crear equipo',
            submitting: 'Creando…',
            outcomeUnknown: 'No se pudo confirmar si el equipo se creó. Reinténtalo para recuperar la misma solicitud.',
        },
        tabs: {
            overview: 'Resumen',
            sessions: 'Sesiones',
            members: 'Miembros',
            groups: 'Grupos',
            invitations: 'Invitaciones',
            authentication: 'Autenticación',
            settings: 'Ajustes',
        },
        authentication: {
            policy: {
                admissionSection: 'Admisión',
                admissionHelp: 'Cómo las personas pasan a ser miembros de este equipo.',
                admissionInviteOnly: 'Solo por invitación',
                admissionProvisioned: 'Aprovisionado por un directorio',
                admissionJit: 'Automáticamente al iniciar sesión por primera vez',
                admissionUnavailable: 'Este Home todavía no puede aplicar ese modo de admisión, así que nada cambió.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Este Home no ha puesto ese proveedor de inicio de sesión a disposición de los equipos. Un administrador del Home puede cambiarlo.',
                    homePolicyProhibited: 'Un administrador del Home no permite este modo de admisión en este Home.',
                    directorySourceRequired: 'Añade primero un directorio a este equipo. Este modo admite a las personas que aporta.',
                    directoryProjectionRequired: 'El directorio de este equipo aún no ha terminado su primera sincronización. Este modo estará disponible cuando termine.',
                    teamConnectionRequired: 'Añade primero una conexión de inicio de sesión a este equipo. La admisión en el primer inicio de sesión la necesita.',
                    teamConnectionUnavailable: 'Ninguna conexión de inicio de sesión de este equipo se puede usar ahora mismo, así que nadie podría ser admitido al iniciar sesión.',
                },
                acceptedSection: 'Inicio de sesión aceptado',
                acceptedHelp: 'Qué inicio de sesión acepta este equipo antes de permitir trabajo del equipo.',
                acceptedInherit: 'Usar la política del Home',
                acceptedRestricted: 'Solo el inicio de sesión seleccionado abajo',
                connectionsSection: 'Conexiones aceptadas',
                connectionsEmpty: 'Selecciona al menos una conexión de inicio de sesión, o usa la política del Home.',
                homeMethodRetained: 'Conservado de la política almacenada',
                repairRequired: 'No se puede leer la restricción de inicio de sesión almacenada',
                repairRequiredHelp: 'No se aplica tal como está escrita. Elige una política abajo para reemplazarla.',
                conflictBody: 'La política de inicio de sesión cambió en este Home. Revísala y vuelve a aplicar tu cambio.',
                providerTestRequired: 'Prueba esta conexión antes de que el equipo pueda exigirla.',
                unavailable: 'Este Home no puede aceptar esa política de inicio de sesión.',
                approvalPending: 'Esperando aprobación',
                connectionOwnerTeam: "Conexión del equipo",
                connectionOwnerHome: "Método de inicio de sesión del Home",
            },
            subtitle: 'Cómo demuestran su identidad los miembros del equipo.',
            memberSignIn: {
                section: 'Página de inicio de sesión para miembros',
                open: 'Abrir la página de inicio de sesión para miembros',
                copyLink: 'Copiar enlace',
                shareLink: 'Compartir enlace',
                qrLabel: 'Código QR del enlace de inicio de sesión para miembros',
                footer: 'Cualquiera con este enlace llega a la página de inicio de sesión de este equipo. El enlace no concede nada por sí mismo: unirse sigue la política de admisión del equipo.',
                unavailable: 'Sin enlace compartible',
                unavailableBody: 'Este Home no publica ninguna dirección web, por lo que no hay ningún enlace que funcione en otro dispositivo. Un administrador del Home puede configurar una.',
            },
            connectionsSection: 'Conexiones de inicio de sesión',
            empty: 'No hay conexiones de inicio de sesión',
            status: {
                unavailable: 'No disponible',
                prohibited: 'Bloqueado por la política del Home',
                notConfigured: 'Sin configurar',
                settingUp: 'Configurando',
                connected: 'Activo',
                needsAttention: 'Requiere atención',
                disabled: 'Desactivado',
            },
            mode: {
                signInOnly: 'Solo inicio de sesión',
                signInTimeGroups: 'Los grupos se actualizan al iniciar sesión',
            },
            detail: {
                status: 'Estado',
                mode: 'Modo',
                provider: 'Proveedor',
                restrictions: 'Restricciones de inicio de sesión',
                allowedUsers: 'Usuarios permitidos',
                allowedDomains: 'Dominios de correo permitidos',
                none: 'Ninguno',
                configuration: 'Configuración',
                organization: 'Organización',
                connection: 'Conexión',
            },
            directory: {
                actions: {
                    section: 'Acciones', sync: 'Sincronizar ahora', pause: 'Pausar sincronización', resume: 'Reanudar sincronización', remove: 'Eliminar directorio…',
                    pauseTitle: ({ source }: { source: string }) => `¿Pausar ${source}?`, pauseBody: 'Los cambios nuevos del directorio se detendrán. El acceso del Team y las contribuciones a Grupos conocidas se conservan hasta reanudar.',
                    removeTitle: ({ source }: { source: string }) => `¿Eliminar ${source}?`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `Se eliminarán ${teamMembershipsRemoved} membresías gestionadas, ${groupMembershipsRemoved} membresías efectivas de Grupos y ${groupContributionsRemoved} contribuciones de origen. Se conservarán ${directoryCreatedGroupsRetained} Grupos creados por el directorio, ${nativeMembershipsPreserved} membresías nativas y ${nativeGroupContributionsPreserved} contribuciones nativas. No se eliminan cuentas.`,
                },
                section: "Membresía administrada",
                overviewSubtitle: "Las fuentes de directorio mantienen la membresía y los grupos del equipo alineados con una organización externa.",
                manageSubtitle: "Revisa las fuentes de directorio conectadas y su último estado de sincronización.",
                title: "Sincronización de directorio",
                sourcesSection: "Fuentes de directorio",
                sourcesLoadMore: "Cargar más fuentes",
                subtitle: "Los cambios de membresía solo se aplican desde proyecciones completas del servidor.",
                empty: "No hay fuentes de directorio",
                setup: {
                    section: "Añadir una fuente",
                    add: "Elegir una fuente de directorio",
                    options: "Configuración de la fuente",
                    optionsFooter: "Elige un directorio u organización de proveedor verificado y exacto.",
                    loadMore: "Cargar más",
                    empty: "Aún no hay opciones de fuentes verificadas",
                    workos: "Configurar la sincronización de directorios de WorkOS",
                    workosSubtitle: "Abre el portal de administración de WorkOS y vuelve para elegir el directorio verificado.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier empezará a importar este directorio después de añadirlo.",
                },
                people: {
                    section: "Personas",
                    empty: "No hay personas aprovisionadas",
                    provisioned: "Aprovisionada · Aún sin cuenta",
                    boundAccountCount: ({ count }: { count: number | string }) => `Cuentas vinculadas: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Personas aprovisionadas sin cuenta: ${count}`,
                    member: "Miembro del equipo",
                    unknown: "Persona sin nombre",
                    loadMore: "Cargar más personas",
                    state: {
                        suspended: "Suspendida",
                        deleted: "Eliminada",
                    },
                },
                kind: {
                    workos: "Sincronización de directorio WorkOS",
                    github: "Organización de GitHub",
                },
                state: {
                    setup: "Requiere configuración",
                    syncing: "Sincronizando",
                    active: "Activa",
                    paused: "En pausa",
                    needsAttention: "Requiere atención",
                    initializing: "Configurando",
                    failed: "La última sincronización falló",
                },
                mode: {
                    eventsAndFull: "Eventos y reconciliación completa",
                    fullOnly: "Solo reconciliación completa",
                },
                freshness: {
                    never_synced: "Nunca sincronizada",
                    fresh: "Actualizada",
                    stale: "Desactualizada",
                    unknown: "Desconocida",
                },
                detail: {
                    status: "Estado",
                    sourceType: "Tipo de fuente",
                    syncSection: "Estado de sincronización",
                    mode: "Modo de sincronización",
                    freshness: "Actualización",
                    lastSuccess: "Última sincronización correcta",
                    nextScheduled: "Próxima sincronización programada",
                    attentionSection: "Requiere atención",
                    attentionTitle: "Esta fuente de directorio requiere atención",
                    attentionRetryable: "La fuente puede recuperarse al reparar su conexión. Actualiza para comprobar su estado.",
                    attentionAdmin: "Revisa la configuración de la fuente antes de confiar en nuevos cambios del directorio.",
                },
                never: "Nunca",
                unknown: "Desconocido",
            },
        },
        settings: {
            archiveDescription: 'Archivar quita el equipo de las vistas activas y detiene el acceso basado en el equipo. Se conservan sus miembros, grupos e historial, y se puede restaurar.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Valores predeterminados de sesión',
            externalSharingSection: 'Uso compartido externo',
            historyDefaultSection: 'Historial predeterminado',
            lifecycleSection: 'Ciclo de vida del equipo',
            saved: 'Guardado',
        },
        policy: {
            sessionCreationPrivate: 'Privada de forma predeterminada',
            sessionCreationTeam: 'Compartida con el equipo de forma predeterminada',
            sessionCreationRequired: 'Siempre compartida con el equipo',
            sessionCreationHelp: 'Esto se aplica a las sesiones nuevas. Las sesiones privadas existentes no quedan expuestas.',
            externalSharingAllowed: 'Cualquiera que pueda compartir',
            externalSharingAdmins: 'Solo administradores del equipo',
            externalSharingDisabled: 'No permitido',
            externalSharingHelp: 'Esto puede bloquear el uso compartido futuro. No retira las copias ya compartidas.',
            historyDefaultHelp: 'Esto preselecciona la opción para los miembros nuevos. No reescribe el historial de los miembros existentes.',
        },
        logo: {
            add: 'Añadir logo',
            replace: 'Sustituir logo',
            remove: 'Quitar logo',
            removeConfirmTitle: '¿Quitar este logo?',
            removeConfirmBody: 'El equipo volverá a mostrar su monograma. Puedes subir un logo nuevo cuando quieras.',
            previewLabel: 'Vista previa del logo',
            useAsLogo: 'Usar como logo',
            monogramLabel: 'Monograma del equipo',
            tooLarge: 'Esa imagen es demasiado grande. Elige una más pequeña.',
            invalidFormat: ({ formats }: { formats: string }) => `Ese archivo no es una imagen compatible. Formatos admitidos: ${formats}.`,
            failed: 'El logo no se subió. El logo actual no ha cambiado.',
            retry: 'Reintentar',
        },
        archive: {
            openSettings: 'Abrir ajustes',
            action: ({ name }: { name: string }) => `Archivar ${name}`,
            confirmTitle: ({ name }: { name: string }) => `¿Archivar ${name}?`,
            confirmBody: ({ name }: { name: string }) => `${name} saldrá de las vistas activas. El acceso basado en el equipo y en los grupos se detendrá, y los enlaces de invitación pendientes se revocarán. Las membresías, los grupos, las políticas y los permisos existentes se conservan. Restaurar ${name} puede volver a activar esos permisos conservados.`,
            restoreAction: ({ name }: { name: string }) => `Restaurar ${name}`,
            restoreTitle: ({ name }: { name: string }) => `¿Restaurar ${name}?`,
            restoreBody: () => 'Las membresías, los grupos y los permisos conservados volverán a estar activos donde las cuentas y los recursos aún lo permitan. Los enlaces de invitación revocados no volverán.',
            readOnly: 'Este equipo está archivado. Restáuralo para hacer cambios.',
        },
        members: {
            membershipSection: 'Membresía',
            filterLabel: 'Mostrar',
            searchPlaceholder: 'Buscar miembros',
            filterAll: 'Todos',
            filterOwnersAndAdmins: 'Propietarios y administradores',
            filterMembers: 'Miembros',
            filterGuests: 'Invitados',
            filterSuspended: 'Suspendidos',
            emptyTitle: 'Ningún miembro coincide',
            emptyBody: 'Ajusta el filtro o invita a alguien a este equipo.',
            add: 'Añadir miembro',
            addTitle: ({ team }: { team: string }) => `Añadir a ${team}`,
            personLabel: 'Persona',
            roleLabel: 'Rol',
            personPlaceholder: 'Buscar personas en este Home',
            ineligible: 'Ya está en este equipo, o no es una cuenta activa en este Home.',
            addSubmit: 'Añadir miembro',
            you: 'Tú',
            joined: ({ when }: { when: string }) => `Se unió el ${when}`,
            managedBy: ({ source }: { source: string }) => `Gestionado mediante ${source}`,
            managedReadOnly: 'Esta membresía se gestiona en su origen. Cámbiala allí.',
            detailManagedBy: 'Gestionado por',
            managementTitle: 'Origen de gestión',
            managementHelp: 'Cambiar el origen conserva esta membresía, su rol, su estado y su historial de sesiones. Solo cambia quién puede modificarlos.',
            managementNative: 'Gestionado en Happier',
            managementConflict: 'Ese origen todavía no tiene una identidad disponible para esta persona. Sincronízalo y vuelve a intentarlo.',
            detailOpenSource: 'Abrir la configuración del origen',
            encryption: {
                title: 'Acceso cifrado',
                checking: 'Comprobando el acceso cifrado…',
                ready: 'Preparado',
                scopeBody: 'Esto solo cubre las sesiones que gestionas. Es posible que otros responsables aún deban preparar el acceso.',
                pending: 'Pendiente de preparar',
                prepare: 'Preparar el acceso cifrado',
                preparing: ({ prepared }: { prepared: number }) => `Preparando el acceso cifrado · ${prepared} preparadas`,
                setupRequired: 'Configuración necesaria',
                setupRequiredBody: 'Esta persona aún no ha terminado de configurar el acceso cifrado. Podrás preparar su historial de sesiones cuando lo haga.',
                notEncrypted: 'Sin cifrar',
                plainAccount: 'La cuenta de esta persona no usa cifrado de extremo a extremo, así que no hay nada que preparar.',
                repairRequired: 'El acceso cifrado necesita reparación',
                repairBody: 'Algunas sesiones que gestionas no se pueden preparar desde este dispositivo. Ábrelas para reparar tu propio acceso.',
                nonTransferableBody: 'Algunas sesiones usan un formato de cifrado antiguo que no se puede compartir con miembros nuevos. Siguen siendo legibles para quienes ya tienen acceso.',
                recipientChanged: 'La cuenta de esta persona cambió. Recargando antes de preparar otra vez.',
                retry: 'Reintentar',
                failed: 'La preparación se detuvo antes de terminar. Se conservó todo lo ya preparado.',
            },
            detailGroups: 'Grupos',
            detailGroupsEmpty: 'Sin grupos',
            suspend: 'Suspender miembro',
            suspendTitle: ({ name }: { name: string }) => `¿Suspender a ${name}?`,
            suspendBody: 'El acceso al equipo y a los grupos se detiene de inmediato. La pertenencia a grupos y las asignaciones de recursos se conservan, y la reactivación solo restablece el acceso que siga siendo válido. La cuenta del Home y los demás equipos no se ven afectados.',
            reactivate: 'Reactivar miembro',
            reactivateTitle: ({ name }: { name: string }) => `¿Reactivar a ${name}?`,
            reactivateBody: 'El acceso se reanuda donde las membresías, los grupos y el estado de la cuenta aún lo permitan.',
            remove: 'Quitar del equipo',
            removeTitle: ({ name }: { name: string }) => `¿Quitar a ${name}?`,
            removeBody: 'El acceso actual al equipo y a los grupos finaliza. Se eliminan las pertenencias a grupos y los permisos ligados a esta membresía. La autoría previa y el contenido ya visto no se borran. Volver a unirse más adelante iniciará una nueva membresía.',
            lastOwnerBlocked: 'Un equipo conserva al menos un propietario activo. Elige antes otro propietario.',
            accountInactive: 'La cuenta de esta persona no está activa, así que no se puede añadir ni hacer propietaria.',
            ownerOnlyAction: 'Solo un propietario del equipo puede cambiar propietarios.',
            ownerRequiredTitle: 'Se necesita un propietario',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} necesita un propietario activo para los cambios reservados al propietario.`,
            chooseOwner: 'Elegir propietario',
            ownerRequiredNoCandidate: 'No hay ningún miembro elegible. Hay que añadir un miembro existente o acordar un traspaso.',
        },
        groups: {
            detailsSection: 'Grupo',
            title: 'Grupos',
            emptyTitle: 'Aún no hay grupos',
            emptyBody: 'Un grupo es un conjunto plano de miembros del equipo con los que compartir a la vez.',
            emptyRosterTitle: 'Aún no hay miembros en este grupo',
            noEligibleCandidatesTitle: 'No hay nadie para añadir',
            noEligibleCandidatesBody: 'Aquí aparecen los miembros del equipo que todavía no están en este grupo.',
            create: 'Nuevo grupo',
            nameLabel: 'Nombre',
            namePlaceholder: 'Desarrollo',
            descriptionPlaceholder: 'Para qué sirve este grupo',
            submit: 'Crear grupo',
            nameTaken: 'Ya hay un grupo con ese nombre en este equipo.',
            memberCount: ({ count }: { count: number }) => `${count} miembros`,
            managedBy: ({ source }: { source: string }) => `Gestionado por ${source}`,
            membersSection: 'Miembros del grupo',
            addMember: 'Añadir al grupo',
            removeNative: 'Quitar del grupo',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `¿Quitar a ${name} del grupo ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} pierde de inmediato el acceso que otorga ${group}. Sigue en el Team y puedes volver a añadirla a este grupo.`,
            externalOnlyTitle: 'Gestionado en su origen',
            externalOnlyBody: ({ source }: { source: string }) => `${source} sigue aportando a esta persona, así que permanece en el grupo. Cámbialo en los ajustes de ese origen.`,
            archiveAction: ({ name }: { name: string }) => `Archivar ${name}`,
            archiveTitle: ({ name }: { name: string }) => `¿Archivar ${name}?`,
            archiveBody: 'El acceso basado en el grupo se detiene de inmediato. La pertenencia y el historial se conservan, y restaurar el grupo puede volver a activar esos permisos.',
            restoreAction: ({ name }: { name: string }) => `Restaurar ${name}`,
            archivedSection: 'Grupos archivados',
            archivedReadOnly: 'Este grupo está archivado. Restáuralo para hacer cambios.',
            managedReadOnly: 'El nombre y el ciclo de vida de este grupo se gestionan en su origen. Aun así puedes añadir miembros aquí.',
        },
        invitations: {
            emptyTitle: 'Sin invitaciones',
            emptyBody: 'Invita a alguien con un enlace o añade a una persona que ya tenga cuenta en este Home.',
            invite: 'Invitar',
            inviteTitle: ({ team }: { team: string }) => `Invitar a ${team}`,
            byLink: 'Enlace',
            byEmail: 'Correo',
            emailLabel: 'Dirección de correo',
            emailPlaceholder: 'nombre@ejemplo.com',
            create: 'Crear invitación',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Cualquier persona con sesión iniciada en este Home que tenga este enlace puede unirse a ${team} como ${role}.`,
            copyLink: 'Copiar enlace',
            copied: 'Enlace copiado',
            qrLabel: 'Código QR de este enlace de invitación',
            qrTooLargeFallback: 'Este enlace es demasiado largo para un código QR. Cópialo en su lugar.',
            linkRow: 'Enlace de invitación',
            maskedRecipient: ({ email }: { email: string }) => `Para ${email}`,
            expires: ({ when }: { when: string }) => `Caduca el ${when}`,
            stateActive: 'Activa',
            stateAccepted: 'Aceptada',
            stateRevoked: 'Revocada',
            stateExpired: 'Caducada',
            deliverySent: 'Correo enviado al proveedor',
            deliveryFailed: 'Falló el envío del correo',
            deliveryUnknown: 'Resultado de envío desconocido',
            deliveryRetry: 'Reintentar',
            deliveryChangeEmail: 'Cambiar correo',
            emailUnavailable: 'El envío de correo no está disponible en este Home. Comparte un enlace en su lugar.',
            reissue: 'Crear un enlace nuevo',
            reissueNotice: 'Al reemitir se crea un enlace nuevo. El enlace anterior dejará de funcionar.',
            revoke: 'Revocar invitación',
            revokeTitle: '¿Revocar esta invitación?',
            revokeBody: 'El enlace deja de funcionar de inmediato. Puedes crear uno nuevo cuando quieras.',
            shareLink: 'Compartir enlace',
            shareUnavailable: 'Compartir no está disponible en este dispositivo. Copia el enlace en su lugar.',
            bearerUnavailable: 'Este enlace se mostró una sola vez y no se guarda. Crea un enlace nuevo para volver a compartir el acceso.',
            linkUnavailableRow: 'Sin enlace para compartir',
            linkUnavailableBody: 'Este Home no ha publicado ninguna dirección a la que puedan apuntar los enlaces de invitación, así que no hay ningún enlace que compartir. Pide a un administrador del Home que publique una, o añade personas desde la lista Personas de la Team.',
        },
        join: {
            previewLoading: 'Comprobando esta invitación…',
            joinAction: ({ team }: { team: string }) => `Unirse a ${team}`,
            joinWithCurrentAccount: 'Unirse con esta cuenta',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} se añadirá como dirección verificada a esta cuenta.`,
            useAnotherAccount: 'Usar otra cuenta',
            useCurrentAccount: 'Usar la cuenta actual',
            useAnotherAccountHint: 'Inicia sesión en este Home sin cerrar la sesión de esta cuenta.',
            hostedOn: ({ home }: { home: string }) => `Alojado en ${home}`,
            personalHomeNotice: 'Este Home funciona en un ordenador personal y puede no estar disponible mientras esté sin conexión.',
            plainStorageNotice: 'Las sesiones de este Home se almacenan sin cifrado de extremo a extremo.',
            invitedBy: ({ name }: { name: string }) => `Invitación enviada por ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Se te invita como ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Unirse como invitado no da acceso a las sesiones de equipo de ${team}. Los elementos deben compartirse contigo o con uno de tus grupos.`,
            joinedTitle: 'Te has unido',
            alreadyMemberTitle: 'Ya eres miembro',
            openTeam: ({ team }: { team: string }) => `Abrir ${team}`,
            expiredTitle: 'Esta invitación ha caducado',
            revokedTitle: 'Esta invitación fue revocada',
            usedTitle: 'Esta invitación ya se usó',
            archivedTitle: 'Este equipo está archivado',
            inactiveTitle: 'Esta cuenta no puede unirse ahora mismo',
            invalidTitle: 'Este enlace de invitación no es válido',
            unresolvedHomeTitle: 'Este enlace no identifica su Home',
            unresolvedHomeBody: 'Este dispositivo no puede saber qué Home emitió esta invitación, así que no se envió nada. Pide un enlace nuevo a quien gestione el equipo.',
            unknownHomeTitle: 'Este Home todavía no está en este dispositivo',
            askForNew: 'Pide una invitación nueva a un responsable del equipo.',
            mismatchTitle: 'Esta invitación es para otra dirección',
            signInWithInvited: 'Iniciar sesión con la dirección invitada',
            verifyAddress: 'Verificar esta dirección',
            updateRequiredTitle: 'Este Home necesita una actualización para usar invitaciones de equipo',
            offlineTitle: 'Este Home no está accesible',
            offlineBody: 'La invitación se conserva. Inténtalo de nuevo cuando el Home vuelva.',
            acceptanceOutcomeUnknown: 'No se pudo confirmar si te uniste. Reinténtalo para comprobar la misma invitación.',
            retry: 'Reintentar',
        },
        credentials: {
            recovery: {
                openSettings: 'Abrir ajustes de la credencial',
                selectBroker: 'Elegir una ubicaci\u00f3n de intermediario',
                ownerHandoff: 'Pide al propietario de la fuente que repare esta credencial',
                updateApp: 'Actualizar Happier',
                chooseAnother: 'Elegir otra credencial',
            },
            requestPolicy: {
                title: 'Política de solicitudes',
                subtitle: 'Limita lo que se le puede pedir a esta credencial.',
                summaryNone: 'Sin restricciones',
                summaryActive: ({ count }: { count: number }) => `${count} restricciones`,
                protocolsLabel: 'Formatos de solicitud',
                protocolsAny: 'Todos los que admita la fuente',
                modelsLabel: 'Modelos',
                modelsAny: 'Todos los modelos que ofrece la fuente',
                modelsAllowed: ({ count }: { count: number }) => `${count} permitidos`,
                effortLabel: 'Esfuerzo de razonamiento',
                effortAny: 'Todos los que admita la fuente',
                catalogUnavailable: 'Elegir qué modelos se permiten todavía no está disponible desde este Home. Las opciones actuales siguen vigentes hasta que se eliminen.',
                clear: 'Quitar todas las restricciones',
                activeNote: 'Una sesión que ya está en marcha no se reescribe. Su próxima solicitud tendrá que cumplir la nueva política.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Preparación del acceso directo',
                check: 'Comprobar preparación',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} listos · ${pending} preparándose`,
                allReady: 'Todas las personas con acceso directo están listas.',
                automatic: 'El material se prepara en el ordenador que tiene esta fuente, en cuanto está conectado.',
                state: {
                    ready: 'Listo',
                    preparing: 'Preparando el acceso',
                    notDelivered: 'Aún no entregado',
                    recipientBindingChanged: 'Esperando la configuración de la cuenta cifrada',
                    sourceChanged: 'La fuente cambió: actualizando',
                },
            },
            externalApi: {
                title: 'Acceso a la API externa',
                subtitle: 'Usa este proveedor desde herramientas compatibles fuera de Happier.',
                privateTitle: 'Sesiones de Happier',
                privateDetail: 'Privado a través de Happier',
                unavailable: 'El acceso a la API externa no está disponible en este Home.',
                publicHttpsRequired: 'Las herramientas externas necesitan una dirección HTTPS pública para este Home.',
                homeDisclosure: 'Los cuerpos sin procesar de las solicitudes al proveedor pasan por el punto final HTTPS público de este Home y su operador puede leerlos.',
                bearerDisclosure: 'Esta clave es un secreto al portador. Quien la tenga podrá usar el acceso asignado hasta que caduque o se revoque.',
                usageDisclosure: 'Happier registra el número de solicitudes. Los totales de tokens y costes pueden estar incompletos si un protocolo no los informa.',
                keysTitle: 'Claves de API',
                authorize: 'Autorizar clave',
                authenticationRequired: 'El miembro asignado debe autorizar esta clave con su inicio de sesión del equipo.',
                authenticationUnavailable: 'La autenticación del equipo no está disponible. Pide a un administrador que revise la política de inicio de sesión.',
                keysLoadFailed: 'No se pudieron cargar las claves de API.',
                keysRetry: 'Volver a cargar las claves',
                keysEmpty: 'Todavía no hay claves',
                keysEmptyBody: 'Crear la primera clave activa el acceso externo; revocar la última lo desactiva.',
                labelPlaceholder: 'Para qué es esta clave',
                assignLabel: 'Atribuida a',
                revealTitle: 'Guarda esta clave ahora',
                revealBody: 'No se volverá a mostrar.',
                revealDismiss: {
                    title: '¿Cerrar sin copiar la clave?',
                    body: 'Esta clave no se podrá volver a mostrar. Déjala visible hasta que la hayas guardado.',
                    confirm: 'He guardado la clave',
                    keepVisible: 'Mantener la clave visible',
                },
                neverUsed: 'Sin usar',
                lastUsed: ({ when }: { when: string }) => `Último uso ${when}`,
                expiresOn: ({ when }: { when: string }) => `Caduca ${when}`,
                expired: 'Caducada',
                revokeTitle: ({ name }: { name: string }) => `¿Revocar ${name}?`,
                revokeBody: 'Las herramientas que usen esta clave dejan de funcionar de inmediato. Las sesiones de Happier no se ven afectadas.',
                revokeAll: 'Revocar todas las claves',
                revokeAllBody: 'El acceso a la API externa se desactiva hasta que se cree una clave nueva. Las sesiones de Happier no se ven afectadas.',
            },
            title: 'Credenciales compartidas',
            subtitle: 'Permite que este equipo use una cuenta conectada, un pool o un proveedor sin copiarlo en la configuraci\u00f3n de cada persona.',
            emptyTitle: 'A\u00fan no hay credenciales compartidas',
            emptyBody: 'Todav\u00eda no se ha compartido nada con este equipo.',
            forbidden: 'Las credenciales compartidas las gestionan las personas propietarias y administradoras del equipo.',
            unavailable: 'Este Home no ofrece credenciales compartidas.',
            approvalPending: 'Esperando aprobación. Los cambios se conservan hasta que se decida.',
            approvalDeclined: 'Esa solicitud no se aprobó, así que no cambió nada.',
            sessionDeniedTitle: 'Una credencial compartida rechazó esta solicitud',
            sharedByYou: 'Compartido por ti',
            providedByTeams: 'Proporcionado por equipos',
            sharedWithYou: 'Compartido contigo',
            sourceAdministration: { title: 'Compartido con equipos', empty: 'Esta fuente no se comparte con ning\u00fan equipo.' },
            source: {
                connectedAccount: 'Cuenta conectada',
                pool: 'Pool de servicios conectados',
                providerConnection: 'Conexi\u00f3n de proveedor',
            },
            delivery: {
                brokered: 'Con intermediario',
                direct: 'Acceso directo',
                both: 'Intermediario + directo',
                mixed: 'Entrega mixta',
            },
            state: {
                available: 'Disponible',
                needsAttention: 'Necesita atenci\u00f3n',
                disabled: 'Desactivado',
            },
            usePolicy: {
                title: '¿Compartir esta sesión con el Equipo?',
                label: 'D\u00f3nde pueden usarlo los miembros',
                personalAllowed: 'Cualquier sesi\u00f3n permitida',
                teamContextRequired: 'Sesiones cuyo equipo es este',
                teamVisibilityRequired: 'Sesiones que este equipo puede ver',
                visibilityNote: 'Elegir esta credencial puede compartir una sesi\u00f3n privada con el equipo despu\u00e9s de que la persona lo confirme.',
            },
            selection: {
                activeTransitionUnsupported: 'Esta sesión empezó a ejecutarse antes de guardar el cambio, así que el modelo no cambió. Inténtalo de nuevo.',
            },
            detail: {
                sourceLabel: 'Origen',
                brokerLabel: 'Ubicaci\u00f3n del intermediario',
                brokerNone: 'Elegir una ubicación de intermediario',
                access: 'Acceso y entrega',
                activity: 'Actividad',
                edit: 'Editar',
                notFound: 'Esta credencial compartida ya no est\u00e1 disponible.',
                brokerUnnamedMachine: 'Equipo sin nombre',
                brokerUnnamedPool: 'Grupo sin nombre',
                brokerChosen: 'Elegida por quien posee la fuente',
                limits: 'Límites',
                usage: 'Consumo',
            },
            create: {
                title: 'Compartir una credencial',
                action: 'Compartir credencial',
                submit: 'Crear credencial compartida',
                sourceChoose: 'Elige una fuente',
                sourceEmpty: 'Todavía no hay nada que compartir.',
                sourceUnsupported: 'Las cuentas conectadas y las conexiones de proveedor todavía no se pueden compartir desde este Home.',
                alreadyShared: 'Ya se comparte con este equipo',
                poolAccounts: ({ count }: { count: number }) => `${count} cuentas`,
                notAllowed: 'Este equipo no te permite ofrecer una credencial propia.',
                reviewLabel: 'Resumen',
            },
            edit: {
                title: 'Editar credencial compartida',
                nameLabel: 'Nombre',
                namePlaceholder: 'Da nombre a esta credencial',
                ceilingLabel: 'Divulgaci\u00f3n directa',
                ceilingBrokeredOnly: 'Solo con intermediario',
                ceilingDirectAllowed: 'Permitir acceso directo',
                ceilingNote: 'El acceso directo permite que las herramientas locales de quien lo recibe obtengan material de credencial. Quitar el acceso detiene entregas futuras, pero no borra lo que un proceso externo ya us\u00f3.',
                conflict: 'Estos ajustes cambiaron en otro lugar. Recarga para ver los valores actuales antes de guardar.',
            },
            audience: {
                title: 'Acceso y entrega',
                none: 'Todav\u00eda nadie',
                everyone: 'Todo el equipo',
                everyoneOff: 'Sin acceso para todo el equipo',
                groupCount: ({ count }: { count: number }) => `${count} grupos`,
                memberCount: ({ count }: { count: number }) => `${count} personas`,
                add: 'Añadir un grupo o una persona',
                groupsSection: 'Grupos',
                membersSection: 'Personas',
                remove: 'Quitar acceso',
                ceilingBlocked: 'El acceso directo no est\u00e1 permitido para esta credencial. Perm\u00edtelo primero en Editar.',
                directTitle: '\u00bfCompartir esta credencial directamente?',
                directBody: 'Las herramientas locales de las personas que elijas pueden recibir material de credencial de este origen. Quitar el acceso detiene entregas futuras, pero no borra lo que un proceso externo ya us\u00f3.',
                directConfirm: 'Compartir directamente',
                keepBrokered: 'Mantener con intermediario',
                limitsNote: 'El uso directo ocurre fuera de Happier y no queda registrado.',
            },
            directUse: {
                title: '\u00bfUsar directamente esta credencial compartida?',
                body: 'Happier puede proporcionar material de credencial a las herramientas locales que usa esta sesi\u00f3n. Contin\u00faa solo si conf\u00edas en esas herramientas con esta credencial.',
            },
            delete: {
                action: 'Eliminar credencial compartida',
                title: ({ name }: { name: string }) => `\u00bfEliminar ${name}?`,
                body: 'Los miembros pierden el acceso de inmediato y la siguiente solicitud falla. El material ya entregado directamente no se puede borrar.',
            },
            errors: {
                featureDisabled: 'Este Home no ofrece credenciales compartidas.',
                teamAuthenticationRequired: 'Inicia sesi\u00f3n en este equipo antes de continuar.',
                teamAuthenticationPolicyUnavailable: 'No se pudo leer la pol\u00edtica de acceso de este equipo, as\u00ed que no se cambi\u00f3 nada.',
                memberNotEligible: 'Esta persona no puede usar esta credencial.',
                sessionPolicyIncompatible: 'Esta credencial no puede usarse en esta sesi\u00f3n con su pol\u00edtica de uso compartido.',
                brokerUnavailable: 'La máquina intermediaria de esta credencial no está accesible ahora mismo. Inténtalo cuando vuelva o elige otra ubicación.',
                sourceOwnerRequired: 'Solo quien posee esta fuente puede hacer este cambio.',
                sourceMissing: 'Esta credencial ya no apunta a una fuente existente. Su propietario debe elegir la fuente de nuevo.',
                invalidAudience: 'Esas personas o grupos no pueden recibir esta credencial.',
                subjectNotInTeam: 'Esa persona o grupo ya no está en este equipo.',
                costUnavailable: 'Un límite de coste necesita un precio para cada modelo permitido y a algunos les falta. Limita solicitudes o tokens en su lugar.',
                invalidLimit: 'Revisa la medida, el periodo y el máximo.',
                limitIdentityImmutable: 'A quién se aplica un límite, qué mide y su periodo no se pueden cambiar. Elimínalo y añade uno nuevo.',
            },
            limits: {
                groupShared: 'Esta cantidad la comparten todas las personas del Grupo.',
                title: 'Límites',
                empty: 'Aún no hay límites',
                emptyBody: 'Se permiten todas las solicitudes hasta que añadas uno.',
                overshoot: 'Las nuevas solicitudes se detienen cuando el consumo registrado alcanza el límite. Las que ya están en curso pueden terminar.',
                directNote: 'Los límites cubren el uso con intermediario y la API externa. El uso directo ocurre en la máquina de quien lo recibe y no se registra.',
                directOnly: 'Todas las personas con acceso usan esta credencial de forma directa, en su propia máquina, así que Happier no registra nada y ningún límite puede aplicarse.',
                requestLimitsOnlyForPersonalUse: 'Los límites de tokens aparecen cuando esta credencial exige un contexto de equipo. El uso personal también permite usarla a ejecuciones en segundo plano y a la API externa, que solo informan solicitudes, así que solo los límites de solicitudes cubren todo el uso.',
                add: 'Añadir límite',
                subjectLabel: 'Se aplica a',
                subject: {
                    resource: 'Toda la credencial compartida',
                    eachMember: 'Cada persona por separado',
                    group: 'Grupo',
                    member: 'Persona',
                },
                metricLabel: 'Medida',
                metric: {
                    requests: 'Solicitudes',
                    tokens: 'Tokens',
                    cost: 'Coste',
                },
                costNote: 'Un límite de coste solo funciona si cada modelo permitido tiene un precio conocido.',
                periodLabel: 'Periodo',
                period: {
                    day: 'Diario',
                    week: 'Semanal',
                    month: 'Mensual',
                },
                maximumLabel: 'Máximo',
                maximumPlaceholder: 'Máximo por periodo',
                maximumInvalid: 'Introduce un número entero mayor que cero.',
                maximumInvalidCost: 'Introduce un importe mayor que cero.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} de ${maximum} registrado`,
                resetsUtc: ({ when }: { when: string }) => `Se reinicia el ${when} UTC`,
                reached: 'Límite alcanzado',
                disabled: 'Desactivado',
                remove: 'Eliminar límite',
                removeTitle: '¿Eliminar este límite?',
                removeBody: 'Las solicitudes dejan de compararse con él de inmediato. El consumo registrado se conserva.',
                unknownSubject: 'Alguien fuera de esta página',
            },
            usage: {
                title: 'Consumo',
                empty: 'No hay nada registrado en este periodo.',
                rangeLabel: 'Periodo',
                brokeredRequests: 'Solicitudes intermediadas',
                directOnlyRequests: 'Las solicitudes solo se cuentan para el uso intermediado.',
                recordedRequests: 'Solicitudes registradas',
                requestIncomplete: 'Solo se incluyen las solicitudes observadas por Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'solicitud externa aún no tiene' : 'solicitudes externas aún no tienen'} un resultado registrado.`,
                breakdownRestricted: 'Algunos desgloses solo se muestran a quienes gestionan credenciales.',
                export: 'Exportar CSV',
                exportFailed: 'Este dispositivo no pudo guardar la exportación.',
                recordedByHappier: 'Registrado por Happier.',
                directIncomplete: 'El uso directo ocurre fuera de Happier y puede no estar incluido.',
                costIncomplete: 'El coste no está disponible para algunos modelos en este periodo.',
                tokenIncomplete: 'El total de tokens está incompleto para este periodo.',
                tokenUnavailable: 'No se observó uso de tokens en este periodo.',
                costUnavailable: 'No se observó uso con precio en este periodo.',
                costUnknown: 'No disponible',
                breakdownLabel: 'Desglosar por',
                breakdownNone: 'Solo totales',
                breakdown: {
                    member: 'Persona',
                    externalApiKey: 'Clave de API externa',
                    model: 'Modelo',
                    session: 'Sesión',
                    sourceMember: 'Cuenta de origen',
                    workerMachine: 'Máquina de trabajo',
                    brokerMachine: 'Máquina intermediaria',
                    deliveryMode: 'Entrega',
                },
                limitsTitle: 'Límites en este periodo',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} solicitudes · ${tokens} tokens`,
            },
            activity: {
                title: 'Actividad',
                empty: 'A\u00fan no hay cambios administrativos registrados.',
                unknownActor: 'Alguien',
                kind: {
                    resourceCreated: 'Comparti\u00f3 esta credencial',
                    resourceUpdated: 'Cambi\u00f3 los ajustes',
                    audienceChanged: 'Cambi\u00f3 qui\u00e9n puede usarla',
                    resourceDeleted: 'Elimin\u00f3 esta credencial',
                    directDelivered: 'Entreg\u00f3 acceso directo',
                    externalKeyCreated: 'Cre\u00f3 una clave de API externa',
                    externalKeyRevoked: 'Revoc\u00f3 una clave de API externa',
                    limitsChanged: 'Cambi\u00f3 los l\u00edmites',
                },
            },
        },
    },
};

const teamsTranslations = { es: spanish };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { es: en };

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

const es: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `¿Conectar este ordenador a ${home}?`,
        body: ({ home }: HomeParams) => `${home} podrá iniciar sesiones en este ordenador. El Home del terminal y las demás conexiones se mantienen.`,
        connect: 'Conectar',
        keep: 'Mantener las conexiones actuales',
    },
    setupAlreadyRunning: 'Ya hay una configuración en curso. Espera a que termine.',
    title: {
        daemon_url_mismatch: 'El servicio en segundo plano está en otro Home',
        daemon_account_mismatch: 'El servicio en segundo plano usa otra cuenta',
        daemon_needs_auth: 'El servicio en segundo plano debe iniciar sesión',
        daemon_not_configured: 'El servicio en segundo plano aún no está conectado',
        daemon_not_installed: 'El servicio en segundo plano no está instalado',
        daemon_not_running: 'El servicio en segundo plano está detenido',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Está conectado a ${daemonHome}, no a ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Tiene la sesión iniciada en ${home} como ${daemonAccount}, no como ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Está conectado a ${home}, pero aún no se ha aprobado.`,
        daemon_not_configured: ({ home }: HomeParams) => `Aún no ha terminado de conectarse a ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Instálalo para conectar este ordenador a ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Inícialo para volver a conectarte a ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Conectar a este Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Cambiar a ${appAccount}`,
        daemon_needs_auth: 'Iniciar sesión',
        daemon_not_configured: 'Conectar a este Home',
        daemon_not_installed: 'Instalar el servicio en segundo plano',
        daemon_not_running: 'Iniciar el servicio en segundo plano',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Conectado a ${home} como ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} aún no tiene ordenadores en ${home}.`,
    openThisComputer: 'Revisar este ordenador',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `¿Cambiar este ordenador a ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Su servicio en segundo plano tiene la sesión iniciada en ${daemonHome} como ${daemonAccount}. Después del cambio funcionará para ${appAccount} en ${home}, y ${daemonAccount} dejará de ver este ordenador.`,
        confirm: 'Cambiar',
    },
    cli: {
        title: 'CLI de Happier',
        version: ({ version }: { version: string }) => `Versión ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Versión ${version} · ${latestVersion} disponible`,
        update: 'Actualizar',
        progressTitle: 'Actualizando la CLI de Happier',
        notManaged: ({ origin }: { origin: string }) => `Instalada fuera de Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `La CLI de Happier ${version} ya está instalada`,
        titleUnknownVersion: 'La CLI de Happier ya está instalada',
        titleMissing: 'Tu CLI de Happier ya no está instalada',
        body: ({ path }: { path: string }) => `Está en ${path}. Happier puede instalar su propia copia, mantenerla al día y ponerla primera en tu PATH, o puedes seguir usando esta.`,
        bodyOutdated: ({ path }: { path: string }) => `Está en ${path} y es demasiado antigua para la configuración. Happier puede instalar su propia copia actualizada y ponerla primera en tu PATH, o puedes conservar la tuya y actualizarla tú.`,
        bodyMissing: ({ path }: { path: string }) => `Elegiste conservar la que estaba en ${path}, y ya no está ahí. Happier puede instalar su propia copia y mantenerla al día, o puedes reinstalar la tuya y seguir usándola.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Está en ${path}, pero los terminales nuevos ejecutan primero la CLI de Happier a través de ${link}, que Happier no añadió. Deja que Happier gestione la línea de comandos, o elimina ${link} y vuelve a ejecutar la configuración para conservar la tuya.`,
        notNow: 'Ahora no',
        manage: 'Deja que Happier la gestione',
        keep: 'Conservar la mía',
        unanswered: 'La configuración se detuvo antes de cambiar nada. Elige quién gestiona la línea de comandos para continuar.',
        ownMissing: 'La línea de comandos que conservaste ya no está instalada. Reinstálala o deja que Happier gestione la línea de comandos.',
        managed: 'Gestionada por Happier',
        own: ({ path }: { path: string }) => `La tuya — ${path}`,
        change: 'Cambiar quién gestiona la línea de comandos',
        keptUpdateTitle: 'Actualiza tu línea de comandos',
        keptUpdate: ({ command }: { command: string }) => `Hay una versión más reciente. Actualízala con ${command}`,
        oldCopyTitle: 'Línea de comandos antigua',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Sigue instalada en ${path}. Elimínala con ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Sigue instalada en ${path}.`,
    },
    servers: {
        title: 'Homes a los que sirve este ordenador',
        connected: 'Conectado',
        offline: 'Configurado · Sin conexión',
        attention: 'Requiere atención',
        currentHome: ({ home }: HomeParams) => `${home} · este Home`,
    },
    removal: {
        uninstallFailedTitle: 'No se pudo desconectar este ordenador',
        uninstallFailedBody: ({ home }: HomeParams) => `No se pudo quitar el servicio en segundo plano de este ordenador para ${home}, así que se ha conservado ${home}. Vuelve a intentarlo o quita el servicio en Ajustes › Este ordenador.`,
        inventoryUnavailableTitle: 'No se pudo comprobar este ordenador',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier no pudo leer los servicios en segundo plano de este ordenador, así que no sabe si este ordenador sigue sirviendo ${home}. ¿Quitarlo de Happier de todos modos?`,
        removeAnyway: 'Quitar de todos modos',
        userOwnedTitle: 'Este ordenador lo sigue sirviendo',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} se instaló fuera de Happier, así que sigue funcionando para ${home}. Quítalo desde la terminal si ya no lo necesitas.`,
    },
};

const thisComputerConnectionTranslations = { es };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { es: { searchOlder: 'Buscar mensajes anteriores', partialErrors: 'No se pudo buscar en parte del contenido. Los resultados están incompletos.', olderRemaining: 'Quedan mensajes anteriores sin buscar.', findOpen: 'Abrir búsqueda', findNext: 'Siguiente coincidencia', findPrevious: 'Coincidencia anterior' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { es: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'archivo editado' : 'archivos editados'}`,
                walkThrough: 'Explícamelo',
                openInFiles: 'Abrir en Archivos',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'archivo' : 'archivos'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'archivo' : 'archivos'} en ${folders} carpetas`,
                showMore: ({ count }) => `Mostrar ${count} más`,
                groupA11y: 'Cambios en este turno',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { es: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '¿Grabar audio de voz en este dispositivo?',
    consentBody: 'El audio de voz puede contener conversaciones privadas y sonido de fondo. Los archivos permanecen en el dispositivo, usan permisos privados, caducan automáticamente y nunca se sincronizan ni se adjuntan a análisis o informes de fallos.',
    consentAction: 'Activar grabación',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { es: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["es"].diagnostics, {
    title: 'Diagnósticos de voz locales',
    footer: 'Desactivado de forma predeterminada. El audio permanece en la máquina seleccionada hasta que lo exportes explícitamente.',
    enabled: 'Grabar audio de diagnóstico local',
    enabledSubtitle: 'Conserva localmente entradas de STT y salidas de TTS acotadas para solucionar problemas',
    sttInput: 'Grabar la entrada de reconocimiento de voz',
    ttsOutput: 'Grabar la voz sintetizada',
    location: 'Ubicación de almacenamiento',
    unavailable: 'Máquina seleccionada no disponible',
    retention: 'Límites de retención',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} horas · ${files} archivos · ${megabytes} MB`,
    deleteAll: 'Eliminar todo el audio de diagnóstico',
    deleteAllSubtitle: 'Elimina de inmediato el audio y los metadatos de la máquina seleccionada',
    deleteConfirmTitle: '¿Eliminar todos los diagnósticos de voz locales?',
    deleteConfirmBody: 'Esto elimina de forma permanente todos los artefactos de diagnóstico de voz de la máquina seleccionada.',
    deleteAction: 'Eliminar todo',
    deleteFailed: 'No se pudieron eliminar las grabaciones de diagnóstico locales. Puede que sigan en la máquina seleccionada.',
    cleanupRequired: 'La limpieza de diagnósticos locales necesita atención',
    cleanupRequiredSubtitle: 'Puede que queden archivos de diagnóstico privados o que no se haya podido leer el catálogo local. Reintenta la limpieza o elimina todo el audio de diagnóstico.',
    captureFailed: 'La captura de diagnóstico necesita atención',
    captureFailedSubtitle: 'No se pudo leer ni guardar la última captura de audio de diagnóstico. No se detectó ningún archivo de diagnóstico residual; la próxima captura de voz que reúna las condiciones volverá a comprobar el estado.',
    retryCleanup: 'Reintentar la limpieza de diagnósticos',
    retryCleanupSubtitle: 'Vuelve a comprobar el almacén privado y aplica de nuevo sus límites de retención',
    cleanupRetryFailed: 'No se pudo completar la limpieza. Puede que queden archivos de diagnóstico en la máquina seleccionada; reinténtalo o elimínalos todos cuando vuelva a conectarse.',
    exportTitle: 'Exportar los diagnósticos seleccionados',
    noArtifacts: 'No hay grabaciones de diagnóstico conservadas en la máquina seleccionada.',
    exportSttArtifact: 'Exportar la entrada de reconocimiento de voz',
    exportTtsArtifact: 'Exportar la voz sintetizada',
    exportArtifactAccessibility: 'Exportar esta grabación de diagnóstico de voz local',
    exportConfirmTitle: '¿Exportar esta grabación privada?',
    exportConfirmBody: 'Esto copia la grabación seleccionada desde la máquina seleccionada a este dispositivo mediante una transferencia cifrada de un solo uso. Nunca se sube automáticamente.',
    exportAction: 'Exportar grabación',
    exportFailed: 'No se pudo exportar la grabación privada. No se subió nada.',
    backupPolicy: 'Exclusión de copias de seguridad',
    backupPolicyBestEffort: 'Se guarda en la caché privada de la máquina seleccionada y se marca para las herramientas de copia de seguridad que respetan el estándar de directorio de caché. No se implementa ninguna subida ni sincronización automática; la exclusión de las copias de seguridad del sistema operativo no está garantizada.',
    activeIndicator: 'Diagnósticos de voz activados',
    checkingIndicator: 'Comprobando el estado de los diagnósticos de voz',
    statusUnknownIndicator: 'Se desconoce el estado de los diagnósticos de voz',
    shutdownPendingIndicator: 'Deteniendo los diagnósticos de voz',
    shutdownFailedIndicator: 'No se pudo confirmar que los diagnósticos de voz estén desactivados',
    retryShutdown: 'Reintentar detener los diagnósticos',
    sessionOptOut: 'No grabar esta sesión',
    sessionOptOutConfirmTitle: '¿Dejar de grabar esta sesión?',
    sessionOptOutConfirmBody: 'Los diagnósticos de voz siguen activados para otras sesiones, pero no se grabará audio nuevo de esta sesión hasta que se reinicie la app.',
    sessionOptOutFailed: 'No se pudo detener la grabación en la máquina activa. Puede que esta sesión siga grabándose; reinténtalo cuando la máquina vuelva a conectarse.',
    sessionOptOutRetry: 'Reintentar detener la grabación',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { es: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Revisa el acceso a las credenciales',
    recipientApprovalTitle: '¿Permitir que este proveedor use tu credencial?',
    recipientApprovalBody: 'Revisa y aprueba los endpoints y las operaciones declarados del proveedor. Si ese contrato de destinatario cambia, Happier conserva tu selección pero bloquea el uso de la credencial hasta que la apruebes de nuevo.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquete: ${title} (${pluginId}); fuente: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Firma del paquete: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribución: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operaciones declaradas:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operación ${id}: propósito ${purpose}; efecto ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Solicitud: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Cabecera de la credencial: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Límites de bytes: solicitud ${requestMaxBytes}; respuesta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrado', verified: 'verificado' },
    recipientApprovalEffect: { read: 'lectura', mutation: 'mutación' },
    recipientApprovalCredentialFormat: { raw: 'sin formato', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprobar y guardar',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { es: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Guardada en tu cuenta',
      notSetOnAccount: 'No guardada en tu cuenta',
      setOnMachineOverride: ({ machine }) => `Se usa una anulación de credencial de cuenta para ${machine}`,
      notSetWithFallback: ({ machine }) => `Sin configurar para ${machine}; se usará una credencial de cuenta cuando esté disponible`,
      plainStorageTitle: '¿Guardar la clave de API sin cifrado de extremo a extremo?',
      plainStorageBody: 'Esta cuenta guarda los ajustes sin cifrado de extremo a extremo. Si guardas esta clave de API, su texto sin cifrar será visible para el servidor.',
      plainStorageConfirm: 'Guardar clave de API',
      deleteAccountBody: '¿Quitar esta clave de API guardada? Otras vinculaciones que usen el mismo secreto guardado la conservarán.',
      machineUnavailable: 'Selecciona una máquina de ejecución de voz en línea',
      machineUnavailableTitle: 'Máquina de voz no disponible',
      machineUnavailableBody: 'Elige una máquina de ejecución de voz en línea antes de guardar o usar esta credencial.',
      statusUnavailable: ({ machine }) => `El estado de la credencial no está disponible en ${machine}. Toca para reintentar.`,
      importAvailable: ({ machine }) => `Hay una clave anterior disponible para importar a ${machine}`,
      notSetOnMachine: ({ machine }) => `Sin configurar en ${machine}`,
      setOnMachine: ({ machine, protection }) => `Configurada en ${machine} · ${protection}`,
      protection: { osProtected: 'Protegida por el sistema', filePermissions: 'Protegida por permisos de archivo' },
      importTitle: '¿Importar la clave de API existente?',
      importBody: ({ machine }) => `Copia el ajuste de cuenta cifrado existente a ${machine}. El original seguirá disponible para tus otros dispositivos.`,
      importAction: 'Importar',
      enterNewAction: 'Introducir nueva',
      useSavedSecretTitle: 'Usar un secreto guardado',
      useSavedSecretSubtitle: 'Elige una clave ya almacenada en esta cuenta.',
      replaceOrRemoveBody: 'Introduce una clave de API nueva o déjalo en blanco para quitar la clave de esta máquina.',
      deleteTitle: '¿Quitar la clave de API?',
      deleteBody: ({ machine }) => `¿Quitar esta clave de API de ${machine}? El antiguo valor compartido entre dispositivos, si existe, no cambia.`,
      operationFailed: 'La máquina seleccionada no pudo actualizar esta credencial. Comprueba que esté en línea e inténtalo de nuevo.',
      newCredentialRequired: ({ machine }) => `Se necesita una credencial de máquina nueva en ${machine}`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Las solicitudes se ejecutan en ${machine}. Localhost se refiere a esa máquina.`,
      insecureTitle: '¿Permitir HTTP local sin cifrar?',
      insecureBody: ({ origin, machine }) => `¿Permitir que se envíen credenciales por HTTP a ${origin} desde ${machine}? Localhost se refiere a ${machine}. Solo se aceptan direcciones de bucle invertido y de red privada; el HTTP público se rechaza.`,
      allowAction: 'Permitir HTTP',
      invalidBody: 'Introduce una URL HTTPS, o una URL HTTP de bucle invertido o red privada sin usuario, contraseña ni cadena de consulta.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { es: {
        setupTitle: 'Configurar la voz',
        setupTileSubtitle: 'Habla en voz alta con tus sesiones. Cuatro pasos cortos.',
        setupTileProgress: ({ done, total, next }) => `${done} de ${total} listos · ${next}`,
        setupNextService: 'ahora elige quién escucha',
        setupNextReadiness: 'ahora termina el servicio',
        setupNextMicrophone: 'ahora permite el micrófono',
        setupNextTry: 'ahora pruébalo',
        setupNextInstalling: 'instalando',
        setupStart: 'Configurar',
        setupContinue: 'Continuar',
        setupDescription: 'Habla en voz alta con tus sesiones: pregunta qué pasa, empieza trabajo, decide desde cualquier lugar. Cuatro pasos; puedes irte y volver.',
        setupLightCaption: ({ done, total }) => `${done} de ${total} listos`,
        setupServiceTitle: 'Elige quién escucha',
        setupServiceDetail: 'Lo que te escucha y te responde. Puedes cambiarlo después.',
        setupChange: 'Cambiar',
        setupReadinessTitle: ({ service }) => `Termina de configurar ${service}`,
        setupReadinessDone: ({ service }) => `${service} está listo`,
        setupReadinessGeneric: 'El servicio',
        setupReadinessTitleGeneric: 'Prepara el servicio',
        setupReadinessUnknown: 'Abre su configuración para ver qué le falta.',
        setupReadinessCheck: 'Comprobar configuración',
        setupMicrophoneTitle: 'Permite el micrófono',
        setupMicrophoneDetail: 'Tu dispositivo lo pregunta una vez. Happier solo escucha mientras la voz está activa, y siempre puedes verlo.',
        setupMicrophoneAction: 'Permitir micrófono',
        setupMicrophoneDone: 'Micrófono permitido',
        setupMicrophoneDeniedTitle: 'El micrófono está desactivado para Happier',
        setupMicrophoneDeniedDetail: 'Actívalo en la configuración del sistema y vuelve aquí.',
        setupOpenSystemSettings: 'Abrir configuración',
        setupTryTitle: 'Pruébalo',
        setupTryDetail: 'Pregunta «¿Qué están haciendo mis sesiones?». Tus palabras llegan a la conversación como cualquier mensaje.',
        setupTryAction: 'Probar',
        setupTryDone: 'Probado',
        setupTryNeedsService: 'Disponible cuando el servicio esté listo.',
        setupDoneTitle: 'La voz está lista',
        setupDoneBody: 'Toca el botón de voz en cualquier chat para empezar a hablar y vuelve a tocarlo para terminar. Silenciar está junto a Finalizar mientras hablas.',
        setupGestureTap: 'Toca',
        setupGestureStartEnd: 'empezar · terminar',
        setupGestureAnywhere: 'empezar · terminar en cualquier lugar',
        setupDoneAction: 'Listo',
        setupSettingsAction: 'Ajustes de voz',
        setupClose: 'Cerrar',
        needsYouEnded: 'La voz terminó. La aprobación sigue pendiente en la Bandeja.',
        needsYouReview: 'Revisar solicitud',
        needsYouTapToDecide: 'Leído en voz alta · decide aquí, no por voz',
        briefMe: 'Ponme al día',
        briefMeA11y: 'Ponme al día: la voz lee lo que te necesita, lo que falló y lo que está listo',
        briefNeedsYou: 'Te necesita',
        briefFailed: 'Falló',
        briefReady: 'Listo',
        briefIncomplete: 'Aún no se ha cargado todo el trabajo, así que puede que falte algo.',
        briefCaughtUp: 'Ahora mismo nada te necesita.',
        briefNotSpoken: 'La voz no puede leerlo ahora. La lista está completa aquí.',
        briefStop: 'Detener',
        continueTitle: 'Seguir hablando aquí',
        continueDetail: ({ device }) => `Estabas hablando en ${device}`,
        continueAction: 'Continuar',
        continuedOn: ({ device }) => `Continuó en ${device}`,
        continuedElsewhere: 'Continuó en otro dispositivo',
        continuedHere: 'Continuó en este dispositivo',
        dismiss: 'Descartar',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "es">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { es: {
        welcomeText: "Hola, te escucho — ¿qué te gustaría hacer?",
        greetingLiteralUnavailable: "Con este idioma de respuesta, el servicio espera a que hables.",
        title: 'Voz',
        howYouTalk: "Cómo hablas",
        holdToTalkTitle: "Mantener para hablar",
        holdToTalkDescription: "Mantén pulsada la marca de Voice para decir algo; suelta para enviar. Tocar sigue iniciando y terminando Voice.",
        holdToTalkHint: "Mantén para un turno; suelta para enviar. Arrastra para cancelar.",
        holdToTalkUnavailable: ({ service }) => `${service} no permite mantener pulsado para hablar. Toca para hablar.`,
        talkWithVoice: 'Hablar con Voz',
        dictate: 'Dictar',
        globalVoice: 'Voz global',
        interrupt: 'Interrumpir',
        options: 'Opciones de Voz',
        you: 'Tú',
        showConversation: 'Mostrar la conversación',
        dragToMove: 'Arrastra para mover',
        openConversation: 'Abrir la conversación',
        settings: 'Ajustes de Voz',
        ended: 'Voz finalizada',
        muted: 'Silenciado',
        setUp: 'Configurar Voz',
        setUpHint: 'Abre los ajustes de Voz para elegir cómo habla',
        startAgain: 'Empezar de nuevo',
        endedCaption: ({ elapsed }) => `${elapsed} · la conversación se ha guardado`,
        dismiss: 'Descartar',
        mute: "Silenciar",
        unmute: "Activar sonido",
        end: "Terminar",
        captions: { connecting: "Abriendo el canal de audio", listening: "Adelante", transcribing: "Convirtiéndolo en texto", thinking: "Pensando una respuesta", speaking: "Puedes interrumpir cuando quieras", interrupted: "Adelante", muted: "Activa el sonido para hablar · Voz aún puede hablar", reconnecting: "Se perdió la conexión · reintentando", blocked: "Permite el acceso al micrófono para hablar", failed: "Inténtalo de nuevo o revisa los ajustes de Voz" },
        recovery: { allow: "Permitir", setUp: "Configurar" },
        containerA11y: ({ status }) => `Voz, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "es">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { es: {
    openai: {
      privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a OpenAI mediante WebRTC. Cuando las funciones correspondientes están activadas o se usan, OpenAI también puede recibir desde este dispositivo actualizaciones acotadas del contexto de Voice, llamadas a herramientas del cliente y sus resultados. Happier usa la clave de Voice API guardada, el servicio conectado de OpenAI o la cuenta experimental de Codex OAuth seleccionados para obtener autenticación de cliente de corta duración; las cuentas conectadas se usan mediante la máquina seleccionada. OpenAI procesa la conversación en la cuenta seleccionada y puede conservar los datos recibidos según la configuración de esa cuenta y sus términos. El servidor y el relay de Happier no transportan el audio en directo. Los controles para compartir contexto de Voice son independientes de este tratamiento por el proveedor.',
    },
    xai: {
      privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a xAI mediante la conexión xAI Realtime. Cuando las funciones correspondientes están activadas o se usan, xAI también puede recibir desde este dispositivo actualizaciones acotadas del contexto de Voice, llamadas a herramientas del cliente y sus resultados. Happier usa la clave API de xAI guardada en los secretos de tu cuenta de Happier solo para las operaciones acotadas de autenticación de cliente y catálogo de voces. xAI procesa la conversación en esa cuenta y puede conservar los datos recibidos según la configuración de la cuenta y sus términos. Si se activa la reanudación, Happier guarda el identificador de conversación del proveedor; olvidarlo elimina el identificador guardado por Happier y no elimina los datos conservados por xAI. El servidor y el relay de Happier no transportan el audio en directo. Los controles para compartir contexto de Voice son independientes de este tratamiento por el proveedor.',
    },
    speechProcessing: {
      deviceStt: 'El audio lo procesa el servicio de reconocimiento de voz del navegador o del sistema operativo. Según la plataforma y el servicio configurado, el procesamiento puede realizarse fuera del dispositivo.',
      deviceTts: 'El texto de la respuesta lo procesa el servicio de síntesis de voz del navegador o del sistema operativo. Según la plataforma y el servicio configurado, el procesamiento puede realizarse fuera del dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Guardar el identificador de reanudación de xAI',
        subtitle: 'Permite que Happier guarde el identificador temporal de conversación de xAI para volver a conectar.',
      },
    },
    resumption: {
      confirmTitle: '¿Guardar el identificador de reanudación de xAI?',
      confirmBody: 'Happier guardará el identificador de conversación de xAI durante un máximo de {minutes} minutos para poder volver a conectar una conversación interrumpida. Esto no cambia ni elimina los datos conservados por xAI.',
      confirmAction: 'Guardar identificador',
      forgetTitle: 'Olvidar el identificador de reanudación de Happier',
      forgetSubtitle: 'Elimina el identificador de conversación del proveedor guardado por Happier. Esto no elimina la conversación ni los datos conservados por xAI.',
      forgotten: 'Happier eliminó el identificador de conversación del proveedor guardado.',
      unsupported: 'Happier no puede eliminar el identificador de conversación del proveedor guardado desde esta sesión.',
      failed: 'Happier no pudo eliminar el identificador de conversación del proveedor guardado. Inténtalo de nuevo.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { es: defineVoiceReadinessTranslation({
    ready: 'La función de voz está lista.',
    permissionAnnouncement: ({ summary }) => `La sesión de código necesita permiso para ${summary}. Revísalo en la interfaz de la sesión para aprobarlo o denegarlo.`,
    userActionAnnouncement: ({ question }) => `La sesión de código necesita tu respuesta. ${question}`,
    userActionFallback: 'La sesión de código necesita tu respuesta. Responde la pregunta para que pueda continuar.',
    requestedTool: 'la herramienta solicitada',
    provider_unselected: 'Elige un proveedor de voz.',
    contribution_unavailable: 'Este proveedor de voz ya no está disponible.',
    role_unsupported: 'Este proveedor no admite el modo de voz seleccionado.',
    platform_unsupported: 'Este proveedor de voz no está disponible en esta plataforma.',
    settings_unsupported_version: 'Actualiza este proveedor antes de usarlo con la función de voz.',
    settings_unknown: 'No se ha podido comprobar la configuración del proveedor.',
    settings_needs_migration: 'Revisa la configuración actualizada del proveedor.',
    settings_invalid: 'Revisa la configuración no válida del proveedor.',
    settings_missing_required_setting: ({ service }) => `Termina de configurar ${service} para empezar.`,
    provider_mode_unknown: 'Elige un modo compatible con este proveedor.',
    server_feature_disabled: 'El servidor ha desactivado este proveedor de voz.',
    server_feature_installing: 'El servidor está preparando la compatibilidad con la función de voz.',
    server_feature_incompatible: 'El servidor no es compatible con este proveedor de voz.',
    server_feature_unknown: 'No se ha podido comprobar si el servidor admite este proveedor de voz.',
    execution_machine_missing: 'Elige una máquina que pueda ejecutar este proveedor de voz.',
    execution_machine_installing: 'La máquina de ejecución de voz seleccionada aún se está preparando.',
    execution_machine_incompatible: 'La máquina seleccionada no es compatible con este proveedor de voz.',
    execution_machine_unknown: 'No se ha podido comprobar la máquina de ejecución de voz.',
    daemon_unreachable: 'La máquina seleccionada no tiene una ruta disponible para el audio de voz.',
    daemon_relay_disabled: 'La máquina seleccionada necesita el relé de audio de voz, pero su uso está desactivado.',
    daemon_relay_capped: 'La capacidad del relé de audio de voz no está disponible actualmente para la máquina seleccionada.',
    credential_missing: 'Añade la credencial que necesita este proveedor de voz.',
    credential_approval_required: 'Revisa el acceso a la credencial antes de usar este proveedor de voz.',
    credential_installing: 'La credencial del proveedor aún se está preparando.',
    credential_incompatible: 'La credencial seleccionada no es compatible con este proveedor de voz.',
    credential_unknown: 'No se ha podido comprobar la credencial del proveedor.',
    endpoint_missing: 'Configura el endpoint que necesita este proveedor de voz.',
    endpoint_installing: 'El endpoint del proveedor de voz aún se está preparando.',
    endpoint_incompatible: 'El endpoint configurado no es compatible con este proveedor de voz.',
    endpoint_unknown: 'No se ha podido comprobar el endpoint del proveedor de voz.',
    runtime_missing: 'Instala el entorno de ejecución que necesita este proveedor de voz.',
    runtime_installing: 'El entorno de ejecución del proveedor de voz aún se está instalando.',
    runtime_incompatible: 'El entorno de ejecución instalado no es compatible con este proveedor de voz.',
    runtime_unknown: 'No se ha podido comprobar el entorno de ejecución del proveedor de voz.',
    model_missing: 'Instala o elige un modelo para este proveedor de voz.',
    model_installing: 'El modelo de voz seleccionado aún se está instalando.',
    model_incompatible: 'El modelo seleccionado no es compatible con este proveedor de voz.',
    model_unknown: 'No se ha podido comprobar el modelo del proveedor de voz.',
    device_stt_unavailable: 'El reconocimiento de voz no está disponible en este dispositivo.',
    device_stt_availability_unknown: 'Todavía se está comprobando la disponibilidad del reconocimiento de voz.',
    short: {
      needsSetup: 'Falta configurar',
      needsKey: 'Falta una clave',
      needsApproval: 'Falta tu aprobación',
      offOnServer: 'Desactivado en este servidor',
      needsComputer: 'Falta un ordenador',
      needsAddress: 'Falta una dirección',
      needsModel: 'Falta un modelo',
      installing: 'Instalando',
      notInstalled: 'No instalado',
      unavailableHere: 'No disponible aquí',
      needsUpdate: 'Necesita actualizarse',
      cantCheck: 'Aún sin comprobar',
    },
    actions: {
      select_provider: 'Elegir un proveedor',
      open_provider_settings: "Terminar configuración",
      select_execution_machine: 'Elegir una máquina',
      configure_credential: 'Añadir credenciales',
      review_credential_access: 'Revisar el acceso a la credencial',
      configure_endpoint: 'Configurar el endpoint',
      install_model: 'Instalar un modelo',
      switch_provider: 'Elegir otro proveedor',
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

const voiceRealtimeProviderSetupTranslations = { es: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["es"], {
    xai: {
      setup: { footer: 'Tu clave de API de xAI se guarda como un secreto sincronizado en los secretos de tu cuenta de Happier. Solo se materializa para la operación acotada de xAI Realtime.' },
      credential: { promptBody: 'Pega una clave de API de xAI. Happier la protege como un secreto guardado sincronizado y solo la materializa para la operación acotada de xAI Realtime.' },
    },
    setup: {
      title: 'Configuración de voz en tiempo real',
      footer: 'Tu clave de API se guarda en la máquina de ejecución seleccionada y nunca se incluye en los ajustes de voz sincronizados.',
    },
    credential: {
      title: 'Clave de API guardada',
      promptTitle: 'Conectar la voz en tiempo real',
      promptBody: 'Pega una clave de API de OpenAI Platform. Se protege en los secretos sincronizados de tu cuenta y solo se materializa al emitir credenciales de cliente de Realtime de corta duración.',
    },
    authentication: {
      sectionTitle: 'Autenticación de OpenAI Realtime',
      title: 'Fuente de autenticación',
      subtitle: 'Elige exactamente una fuente. Happier nunca recurre a otra clave ni a otra cuenta.',
      footer: 'El uso de la API de OpenAI Realtime lo factura OpenAI Platform. Una suscripción a ChatGPT o Codex no implica facturación ni acceso a la API de Realtime. A la conversación por WebRTC solo se le pasan credenciales de cliente de corta duración.',
      savedSecret: {
        title: 'Clave de API de voz guardada',
        subtitle: 'Usa la clave de API guardada en los secretos de la cuenta de Happier Voice. No hace falta ningún demonio.',
      },
      openAiApiKey: {
        title: 'Servicio conectado de OpenAI',
        subtitle: 'Usa el perfil o grupo de cuentas estándar de clave de API de OpenAI seleccionado a través de la máquina elegida y su demonio conectado.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Usa el perfil o grupo de cuentas de Codex OAuth seleccionado a través de la máquina elegida y su demonio conectado. Happier nunca recurre a otra clave ni a otra cuenta.',
      },
      account: {
        title: 'Cuenta conectada',
        subtitle: 'Elige el perfil o grupo de cuentas exacto que se usará en la próxima conversación.',
      },
      chooseAccount: 'Elige una cuenta',
      referenceRequired: 'Elige un perfil o grupo de cuentas conectado.',
      connected: 'Cuenta conectada lista',
      unavailable: 'La cuenta seleccionada no está disponible o necesita reconectarse',
    },
    invalidValue: 'Este proveedor no admite ese valor.',
    advanced: { show: 'Mostrar ajustes avanzados', hide: 'Ocultar ajustes avanzados' },
    fields: {
      model: { title: 'Modelo', subtitle: 'Elige el modelo de voz en tiempo real.' },
      voice: { title: 'Voz', subtitle: 'Elige la voz que se usa en las respuestas.' },
      instructions: {
        title: 'Instrucciones de voz',
        subtitle: 'Instrucciones opcionales de comportamiento y personalidad.',
        promptTitle: 'Instrucciones de voz',
        promptBody: 'Escribe instrucciones opcionales para esta sesión de voz.',
      },
      turnDetection: {
        title: 'Detección de turno',
        subtitle: 'Elige cómo detecta el proveedor el final de tu turno.',
        threshold: {
          title: 'Umbral de VAD',
          subtitle: 'Sensibilidad a la actividad de voz; déjalo en blanco para el valor del proveedor.',
          promptTitle: 'Umbral de VAD',
          promptBody: 'Introduce un valor de 0.1 a 0.9, o déjalo en blanco.',
        },
        silenceDurationMs: {
          title: 'Duración del silencio',
          subtitle: 'Milisegundos de silencio antes de terminar un turno.',
          promptTitle: 'Duración del silencio',
          promptBody: 'Introduce de 0 a 10000 milisegundos, o déjalo en blanco.',
        },
        prefixPaddingMs: {
          title: 'Margen previo al habla',
          subtitle: 'Milisegundos que se conservan antes del habla detectada.',
          promptTitle: 'Margen previo al habla',
          promptBody: 'Introduce de 0 a 10000 milisegundos, o déjalo en blanco.',
        },
        idleTimeoutMs: {
          title: 'Tiempo de espera de respuesta por inactividad',
          subtitle: 'Opcionalmente, pide a xAI que empiece una respuesta tras ese silencio.',
          promptTitle: 'Tiempo de espera de respuesta por inactividad',
          promptBody: 'Introduce de 1 a 600000 milisegundos, o déjalo en blanco para desactivar las respuestas automáticas por inactividad.',
          confirmTitle: '¿Activar las respuestas automáticas por inactividad?',
          confirmBody: 'Tras el silencio configurado, xAI puede crear una respuesta por su cuenta y consumir uso de la API.',
          confirmAction: 'Activar',
        },
      },
      transcriptionModel: {
        title: 'Modelo de transcripción',
        subtitle: 'Modelo opcional de transcripción de la entrada.',
        promptTitle: 'Modelo de transcripción',
        promptBody: 'Introduce un id de modelo, o déjalo en blanco para el valor del proveedor.',
      },
      reasoning: { title: 'Razonamiento', subtitle: 'Elige el esfuerzo de razonamiento para los modelos compatibles.' },
      outputSpeed: {
        title: 'Velocidad al hablar',
        subtitle: 'Ajusta la velocidad de habla del proveedor.',
        promptTitle: 'Velocidad al hablar',
        promptBody: 'Introduce un valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Pista de idioma',
        subtitle: 'Opcionalmente, ayuda a la transcripción a identificar tu idioma.',
        promptTitle: 'Pista de idioma',
        promptBody: 'Elige un idioma compatible.',
      },
      keyterms: {
        title: 'Términos clave',
        subtitle: 'Nombres y términos del dominio que la transcripción debería reconocer.',
        promptTitle: 'Términos clave',
        promptBody: 'Introduce hasta 100 términos separados por comas o saltos de línea.',
      },
    },
    options: {
      pinned: 'Versión fijada',
      movingAlias: 'Sigue automáticamente las actualizaciones del proveedor',
      automatic: 'Automático',
      custom: 'Personalizado…',
      server_vad: 'Detección de actividad de voz en el servidor',
      semantic_vad: 'Detección semántica de turno',
      manual: 'Manual',
      high: 'Alto',
      none: 'Ninguno',
    },
    catalog: {
      credentialRequired: 'Añade una clave de API para cargar las voces',
      retry: 'No se pudieron cargar las voces: reintentar',
      empty: 'No hay voces disponibles para esta cuenta',
      preview: ({ voice }) => `Escuchar ${voice}`,
    },
    movingAlias: {
      confirmTitle: '¿Seguir el modelo más reciente?',
      confirmBody: 'Un alias de modelo móvil puede cambiar el comportamiento cuando el proveedor lo actualice. Puedes volver a una versión fijada cuando quieras.',
      confirmAction: 'Usar el más reciente',
    },
    links: {
      title: 'Recursos del proveedor',
      account: { title: 'Abrir la cuenta del proveedor', subtitle: 'Gestiona tu cuenta del proveedor.' },
      apiKeys: { title: 'Abrir las claves de API', subtitle: 'Crea, rota o revoca claves de API del proveedor.' },
      privacy: { title: 'Política de privacidad del proveedor', subtitle: 'Consulta cómo trata el proveedor los datos de voz.' },
    },
    disconnect: {
      title: 'Desconectar la voz en tiempo real',
      subtitle: 'Quita la clave de API de este proveedor de la máquina seleccionada.',
      confirmTitle: '¿Desconectar el proveedor?',
      confirmBody: 'Esto quita la clave de API guardada de la máquina de ejecución seleccionada.',
    },
    unavailable: {
      title: 'Voz en tiempo real no disponible',
      rowTitle: 'No se pudieron cargar los ajustes',
      provider: 'La contribución del proveedor no está disponible o no es compatible.',
      invalid: 'Los ajustes guardados del proveedor no son válidos.',
      needs_migration: 'Estos ajustes necesitan una migración compatible antes de poder editarse.',
      unsupported_version: 'Estos ajustes los escribió una versión más reciente de Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const es: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Elige un servicio para cambiar este ajuste.',
      select: ({ choice, control }) => `Selecciona ${choice} en ${control} para cambiar este ajuste.`,
    },
    hub: {
      description: 'Habla en voz alta con tus agentes y dicta en cualquier mensaje.',
      modesTitle: 'Dos formas de usar tu voz',
      moreTitle: 'Más',
      dictationPurpose: 'el micrófono del cuadro de texto convierte tu voz en texto que puedes editar',
      summarySessionSummaries: 'Resúmenes de sesión',
      summaryRecentMessages: ({ count }) => `últimos ${count} mensajes`,
      summaryNothingShared: 'No se comparte nada al iniciar una conversación',
      summaryRemembers: 'El agente de Voice recuerda conversaciones pasadas',
      summaryForgets: 'El agente de Voice olvida tras cada conversación',
      summaryVoiceComputer: ({ machine }) => `Ordenador de Voice: ${machine}`,
      summaryTranscript: 'transcripción mientras hablas',
    },
    pipeline: {
      hear: 'Escuchar',
      think: 'Pensar',
      speak: 'Hablar',
      write: 'Escribir',
      ready: 'Listo',
      oneStepNeedsYou: 'Un paso te necesita',
      stepsNeedYou: ({ count }) => `${count} pasos te necesitan`,
      waiting: 'En espera',
      working: 'En curso',
      notChecked: 'Aún sin comprobar',
      off: 'Desactivado · el dictado sigue disponible',
      onMachine: ({ machine }) => `En ${machine}`,
      onVoiceComputer: 'En tu ordenador de Voice',
      inTheCloud: 'En la nube del servicio, desde este dispositivo',
      inTheSession: 'Su propio agente responde, en la transcripción',
      intoYourMessage: 'Lo revisas antes de enviar',
      messageLanguage: ({ language }) => `Idioma: ${language}`,
      languageAutomatic: 'automático',
      onThisDevice: 'En este dispositivo',
      needsYou: 'Te necesita',
      voiceAgentFollowsSession: 'Agente de Voice · sigue la sesión',
      theSessionYoureIn: 'La sesión en la que estás',
      intoYourMessageTitle: 'En tu mensaje',
    },
    privacy: {
      localAudio: "Tu dispositivo u ordenador de Voice",
      localProcessor: "Tu modelo de voz seleccionado",
      localRetention: "Lo gestiona tu dispositivo o entorno de ejecución. Los diagnósticos siguen tus ajustes de grabación.",
      localDisclosure: "Los modelos de voz seleccionados se ejecutan en tu dispositivo u ordenador de Voice. El historial y las grabaciones de diagnóstico tienen ajustes separados en esta página.",
      audioTitle: "El audio va a",
      processorTitle: "Procesado por",
      retentionTitle: "Retención",
      messagesUnit: "mensajes",
      secondsUnit: "segundos",
      servicePolicy: "Según los ajustes y condiciones de tu cuenta del servicio.",
      noMicrophoneAudio: "Sin audio del micrófono; solo texto de respuesta.",
      yourEndpoint: "Tu endpoint configurado",
      endpointOperator: "El operador de tu endpoint",
      endpointPolicy: "Según la política de retención de tu endpoint.",
      deviceAudio: "El servicio de voz de tu dispositivo",
      deviceProcessor: "Tu dispositivo o su servicio de voz",
      devicePolicy: "Según los ajustes y condiciones de voz de tu dispositivo.",
      description: 'Lo que tu servicio de voz oye y lee, y lo que Happier guarda.',
      whereTitle: 'A dónde va tu voz ahora',
      whereDescription: 'Cambia según el servicio que elijas.',
      startTitle: 'Al empezar una conversación',
      startDescription: 'Lo que el servicio de voz puede leer de tu trabajo.',
      screenTitle: 'Lo que hay en tu pantalla',
      screenDescription: 'Qué sesión o página estás mirando.',
      screenNever: 'Nunca',
      screenWhenAsked: 'Cuando lo pida',
      screenAlways: 'Siempre',
      summariesTitle: 'Resúmenes de sesión',
      recentTitle: 'Tus mensajes recientes',
      recentDescription: 'Los últimos mensajes de una sesión, cuando pide contexto.',
      recentCountTitle: 'Mensajes a compartir',
      recentCountDescription: "",
      recentCountUnavailable: 'Activa «Tus mensajes recientes» para cambiar esto.',
      toolsTitle: 'Nombres de herramientas',
      toolsDescription: 'Como «Archivo editado». Los argumentos y las rutas de archivo nunca se comparten.',
      permissionsTitle: 'Solicitudes de permiso',
      permissionsDescription: 'Para que te diga qué te necesita. Sigues aprobando con un toque.',
      devicesTitle: 'Tus máquinas y dispositivos',
      devicesDescription: 'Nombres y estado en línea, para iniciar sesiones donde pidas.',
      liveTitle: 'Mientras hablas',
      liveDescription: 'Actualizaciones enviadas cuando tus sesiones cambian durante una conversación.',
      liveActiveTitle: 'De la sesión en la que estás',
      liveOtherTitle: 'De tus otras sesiones',
      liveNothing: 'Nada',
      liveActivity: 'Actividad',
      liveSummaries: 'Resúmenes',
      liveMessages: 'Mensajes',
      livePerUpdateTitle: 'Mensajes por actualización',
      liveIncludeMineTitle: 'Incluir lo que escribiste',
      liveIncludeMineDescription: 'Desactivado: solo se envía la parte del agente.',
      liveMessagesUnavailable: 'Elige «Mensajes» para una sesión arriba para cambiar esto.',
      liveOtherModeTitle: 'Mensajes de otras sesiones',
      liveOtherModeNever: 'Nunca',
      liveOtherModeWhenAsked: 'Cuando lo pida',
      liveOtherModeAutomatically: 'Automáticamente',
      liveOtherModeUnavailable: 'Elige «Mensajes» para otras sesiones para cambiar esto.',
      memoryTitle: 'Memoria del agente de Voice',
      memoryDescription: 'Solo para voz local con un agente de Voice.',
      rememberTitle: 'Recordar conversaciones pasadas',
      rememberOnDescription: 'Retoma donde lo dejaste.',
      rememberOffDescription: 'Desactivado: lo olvida todo cuando cuelgas.',
      restoreTitle: 'Restaurar la memoria con',
      restoreRecent: 'Mensajes recientes',
      restoreSummary: 'Resumen + recientes',
      restoreResume: 'Reanudar el agente',
      restoreUnavailable: 'Activa «Recordar» para elegir.',
      restoreResumeFeatureOff: 'Reanudar requiere el agente de Voice activado en este servidor.',
      restoreResumeAgentCannot: 'Este agente no puede reanudar una conversación pasada.',
      fallbackTitle: 'Si reanudar falla, reproducir mensajes',
      fallbackDescription: 'Empieza por tus mensajes recientes en lugar de desde cero.',
      restoreCountTitle: 'Mensajes a restaurar',
      restoreCountDescription: "",
      forgetTitle: 'Olvidarlo todo ahora',
      forgetDescription: 'Reinicia el agente de Voice desde cero. Tus sesiones no se tocan.',
      forgetAction: 'Olvidar',
      moreTitle: 'Más',
    },
    dictation: {
      description: 'El micrófono del cuadro de texto convierte tu voz en texto que puedes editar antes de enviar.',
      engineTitle: 'Motor de voz',
      engineDescription: 'Cada motor indica a dónde va tu audio.',
      sameAsConversations: 'Igual que las conversaciones de voz',
      sameAsConversationsUses: ({ engine }) => `Usa ${engine}, como tus conversaciones de voz.`,
      languageTitle: 'Idioma',
      dictateInTitle: 'Dicto en',
      dictateInDescription: 'Automático usa el idioma predeterminado del motor. No sigue el idioma de tus conversaciones.',
      pipelinePurpose: 'funciona incluso con las conversaciones de voz desactivadas',
    },
    conversations: {
      description: 'Habla en voz alta con tus agentes, con las manos en el teclado o no.',
      serviceTitle: 'Servicio',
      serviceDescription: 'Quién te escucha, piensa y habla. Puedes cambiar cuando quieras; cada uno conserva su configuración.',
      offDescription: 'Sin conversaciones de voz. El dictado sigue disponible.',
      serviceReady: 'Listo',
      accountTitle: 'Cuenta',
      accountDescription: 'Es el mismo servicio en ambos casos; solo cambia quién paga.',
      payWithTitle: 'Pagar con',
      happierBillingUnavailable: "La facturación de Happier no está disponible en este servidor.",
      turnOnVoiceAgent: "Activar agente de voz",
      payWithHappierDescription: 'Lo cubre tu plan de Happier. No necesitas cuenta propia.',
      payWithOwnDescription: 'Usas tu propia cuenta y clave API de este servicio.',
      runsOn: 'Se ejecuta en',
      hearTitle: 'Escuchar',
      hearDescription: 'Cómo tu voz se convierte en texto antes de responderse.',
      speechRecognitionTitle: 'Reconocimiento de voz',
      handsFreeUnsupported: 'El modo manos libres necesita el reconocimiento de voz de este dispositivo o un modelo de voz de Happier.',
      handsFreeTimingUnavailable: 'Activa manos libres para cambiar esto.',
      interruptTitle: 'Interrumpir hablando',
      interruptDescription: 'Hablar sobre una respuesta la detiene.',
      talkToTitle: 'Hablar con',
      talkToSession: 'La sesión',
      talkToSessionDescription: 'Hablas en la sesión en la que estás; responde su propio agente.',
      talkToAgent: 'Un agente de Voice',
      talkToAgentDescription: 'Un agente de Voice lee tus sesiones y actúa por ti.',
      agentFeatureRequired: ({ feature }) => `Activa ${feature} en Ajustes → Funciones. Las funciones experimentales también requieren activar Experimentos.`,
      itMayTitle: 'Puede',
      itMayReadOnly: 'Solo leer',
      itMayReadOnlyDescription: 'Lee tus sesiones y archivos y no cambia nada.',
      itMayAsk: 'Preguntar antes',
      itMayAskDescription: 'Cada cambio te pregunta antes. Un «sí» dicho en voz alta nunca aprueba; apruebas con un toque.',
      itMaySafe: 'Cambios seguros',
      itMaySafeDescription: 'Hace por su cuenta los cambios seguros del espacio de trabajo y pregunta por el resto.',
      itMayAnything: 'Cualquier cosa',
      itMayAnythingDescription: 'Puede hacer cualquier cambio sin preguntarte antes.',
      repliesTitle: 'Respuestas',
      repliesShort: 'Breves',
      repliesBalanced: 'Equilibradas',
      thinkTitle: 'Pensar',
      thinkDescription: 'Qué pasa con lo que dices.',
      advancedAgentTitle: 'Comportamiento avanzado del agente',
      advancedAgentDescription: 'Cómo el agente de Voice empieza, espera y responde. Los valores predeterminados sirven a la mayoría.',
      memoryLinkTitle: 'Memoria y restauración',
      memoryLinkDescription: 'Si recuerda conversaciones pasadas se ajusta en Privacidad y datos.',
      speakTitle: 'Hablar',
      speakDescription: 'Cómo se leen en voz alta las respuestas.',
      voiceEngineTitle: 'Motor de voz',
      languageTitle: 'Idioma',
      languageDescription: 'Lo que cambia cada idioma para el servicio elegido.',
      iSpeakTitle: 'Hablo',
      iSpeakDescription: 'Ayuda a entenderte. Automático lo detecta cada vez.',
      replyInTitle: 'Responder en',
      replyInDescription: 'La respuesta llega en este idioma, aunque cambies.',
      replySame: 'Igual que hablo',
      iSpeakAutomatic: 'Automático',
      iSpeakEngineDescription: ({ engine }) => `Ayuda a ${engine} a entenderte. Se ajusta con el reconocimiento de voz en Escuchar.`,
      voiceTitle: 'Voz',
      voiceDescription: ({ engine }) => `De ${engine}, el motor de Hablar.`,
      voiceDefault: 'Predeterminada',
      voiceDevice: 'La voz de este dispositivo',
      voiceInEngine: 'Se ajusta en Hablar',
      languageServiceDescription: 'El idioma en que responde tu servicio de voz.',
      languageAutomaticDescription: 'Tu servicio de voz detecta el idioma que hablas.',
      languageEngineDefault: 'Predeterminado del motor',
      languageCoupledDescription: 'Tu servicio de voz usa un mismo idioma para escuchar y responder.',
      greetingTitle: 'Saludo',
      greetingOff: 'No',
      greetingRightAway: 'De inmediato',
      greetingAfterISpeak: 'Cuando yo hable',
      greetingOffDescription: 'Espera a que hables primero.',
      greetingRightAwayDescription: 'Saluda en cuanto empieza la conversación.',
      greetingAfterISpeakDescription: 'Te saluda en su primera respuesta.',
      languageManagedDescription: 'Tu servicio de voz controla su idioma.',
      languageServiceDefault: 'Predeterminado del servicio',
    },
    advanced: {
      description: 'Dónde se ejecuta la voz, cómo se muestra y qué modelos de voz usa.',
      onScreenTitle: 'En pantalla',
      onScreenDescription: 'Cómo aparece una conversación en curso.',
      showLiveAsTitle: 'Mostrar Voice en directo como',
      showLiveAsDescription: 'Solo en este dispositivo. La sección Voice del Companion sigue en todos los modos.',
      scopeTitle: 'Iniciar conversaciones con',
      scopeGlobal: 'Todas mis sesiones',
      scopeGlobalDescription: 'Un solo asistente para todo.',
      scopeSession: 'La sesión abierta',
      scopeSessionDescription: 'Empieza dentro de la sesión que tienes abierta.',
      transcriptTitle: 'Mostrar la transcripción mientras hablas',
      transcriptDescription: 'Lo que tú y el agente decís aparece mientras habláis.',
      autoOpenTitle: 'Abrirla al empezar una conversación',
      autoOpenDescription: 'Desactivado: ábrela tú desde la conversación.',
      autoOpenUnavailable: 'Activa «Mostrar la transcripción» para elegir.',
      computerTitle: 'Ordenador de Voice',
      speechModelsTitle: 'Modelos de voz',
      speechModelsNeedComputerTitle: 'Necesita un ordenador de Voice',
      speechModelsNeedComputer: 'Elige arriba un ordenador de Voice para instalar y gestionar sus modelos de voz.',
      computerDescription: 'El ordenador que ejecuta los modelos de voz e inicia sesión en las cuentas conectadas para la voz. Compartido entre tus dispositivos.',
      connectionTitle: 'Conexión',
      timeoutTitle: 'Abandonar una solicitud de voz después de',
      timeoutDescription: "Para servicios y modelos de voz.",
    },
  },
};

const voiceSettingsPagesTranslations = { es } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "es">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'es': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} partes completas · ${admitted} admitidas`, merge: 'Integrando el recorrido…', titleEdited: 'Título editado', changed: 'Cambiado', moved: 'Movido', filesReadUnavailable: 'Progreso de lectura de archivos no disponible' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { es: { edit: 'Editar recorrido', title: 'Título del recorrido', stopTitle: 'Título de la parada', prose: 'Explicación', refine: 'Refinar', instructions: '¿Qué debería cambiar?', moveUp: 'Subir', moveDown: 'Bajar', mergeNext: 'Combinar con la siguiente parada', addSummary: 'Añadir resumen', addCommitPlan: 'Proponer commits', updated: 'Resultado guardado actualizado', conflict: 'Este recorrido cambió en otro lugar. Tu borrador se conserva. Carga la última versión y revísala antes de guardar de nuevo.', reload: 'Cargar última versión', missingStop: "Esta parada ya no está en el último recorrido. Tu borrador se conserva; selecciona otra parada para continuar.", applicationLocked: 'Se están aplicando commits. La edición está en pausa.' } } satisfies Pick<Record<string, SavedCopy>, "es">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { es: copy({
        title: 'Recorridos',
        description: 'Un orden de lectura creado con IA, con explicaciones junto a los cambios exactos y propuestas de commits opcionales. Se ejecuta en la máquina que tiene el código.',
        enabled: 'Explicar cambios',
        enabledDescription: 'Añade un orden de lectura y explicaciones a una comparación. Los archivos siguen disponibles sin un modelo.',
        model: 'Modelo de resumen',
        modelDescription: 'Se usa para explicaciones, recorridos y propuestas de commits.',
        chooseModel: 'Elegir un modelo',
        unsupported: 'No puede escribir recorridos',
        unavailable: 'Modelo no disponible. Elige otro.',
        prefetch: 'Preparar después de cada turno',
        prefetchDescription: 'Prepara un recorrido cuando el agente termina un turno.',
        saved: 'Recorridos guardados',
        savedDescription: 'Guardados en esta máquina, incluidas tus ediciones.',
        clear: 'Borrar',
        unavailableData: 'Vuelve a conectar la máquina para cargar los recorridos guardados y los costes.',
        costUnavailable: 'Últimos 7 días · coste no disponible',
        clearTitle: '¿Borrar los recorridos guardados?',
        clearDescription: ({ machine }) => `Elimina los recorridos guardados y tus ediciones manuales en ${machine}, junto con tus marcas de revisión de esas comparaciones. No afecta a otras máquinas.`,
        savedCount: ({ count, bytes }) => `${count} guardados · ${bytes}`,
        cost: ({ amount, partial }) => `Últimos 7 días · ${amount}${partial ? ' · algunos costes no están disponibles' : ''}`,
        clearFailed: 'No se pudieron borrar algunos recorridos. Recarga e inténtalo de nuevo.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { es: { walkthroughStart: { start: 'Iniciar recorrido', ended: 'Esta conversación no está disponible aquí. El recorrido se conserva.', newConversation: 'Iniciar una conversación nueva', askSession: 'Preguntar al agente de la sesión', unavailable: 'Conecta la máquina y elige un modelo que devuelva salida estructurada.', updated: 'Recorrido actualizado' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { es: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.es,
            progress: walkthroughProgressTranslations.es,
            eyebrow: 'Recorrido',
            generated: 'Generado',
            generatedBy: ({ model }) => `Generado · ${model}`,
            generatedA11y: 'Escrito por un modelo',
            readingChanges: 'Leyendo los cambios…',
            modelFallback: 'El modelo',
            analysisAll: ({ who, count }) => `${who} leyó los ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} ha leído ${analysed} de ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} leyó ${analysed} de ${total} antes de detenerse`,
            unavailableCount: ({ count }) => `${count} no disponibles`,
            youReviewed: ({ count, total }) => `Revisaste ${count} de ${total}`,
            contents: 'Contenido',
            reviewedOfTotal: ({ count, total }) => `${count} de ${total} revisadas`,
            boardReadProgress: ({ count, total }) => `${count} de ${total} leídas`,
            stopOf: ({ number, total }) => `${number} de ${total}`,
            stopA11y: ({ number, title }) => `Parada ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Parada ${number}, revisada`,
            importance: { start: 'Empieza aquí', high: 'Lee con atención', low: 'Por encima' },
            markReviewed: 'Marcar como revisada',
            reviewed: 'Revisada',
            markReviewedA11y: 'Marcar esta parada como revisada',
            unmarkReviewedA11y: 'Revisada. Pulsa para quitar tu marca',
            askAboutThis: 'Preguntar sobre esto',
            askAboutStopA11y: 'Preguntar sobre esta parada',
            openConversation: 'Abrir la conversación del recorrido',
            andIn: ({ file }) => `y en ${file}`,
            newFile: 'Archivo nuevo',
            deletedFile: 'Eliminado',
            openInFiles: ({ file }) => `Abrir ${file} en Archivos`,
            otherChanges: 'Otros cambios',
            otherChangesDescription: 'No forman parte de la historia, pero siguen aquí. Ábrelos como un diff normal.',
            otherChangesCue: 'Mecánicos, mostrados como diffs',
            keys: { move: 'mover', reviewed: 'revisada', ask: 'preguntar' },
            overview: 'Vista general',
            codeMapOf: ({ count }) => `Mapa de código de ${count} ${count === 1 ? 'archivo' : 'archivos'}`,
            codeMapHint: 'señala una parada para resaltar sus archivos',
            touchesOutlined: 'toca los archivos resaltados',
            showOverviewA11y: ({ count }) => `Mostrar la vista general: un mapa de código de ${count} archivos`,
            inventory: { title: 'Todo lo de esta comparación · ya disponible en Archivos', read: 'Leído', reading: 'Leyendo', unavailable: 'No disponible' },
            arriving: 'Las siguientes paradas aparecerán aquí a medida que se escriban.',
            previousStop: 'Parada anterior',
            nextStop: 'Parada siguiente',
            done: 'Listo',
            evidence: { displayFailed: 'No se pudo mostrar el código guardado. El archivo sigue en Archivos.', binary: 'Archivo binario, descrito a partir de sus metadatos. Se muestra, no se analiza.', unavailable: ({ reason }) => `No se pudo leer (${reason}). Sigue en la lista; nada aquí afirma que se revisó.` },
            notice: {
                stale: 'Hay archivos que cambiaron después de escribir esto',
                refresh: 'Actualizar recorrido',
                failed: ({ reason }) => `La escritura se detuvo · ${reason}`,
                failedGeneric: 'La escritura se detuvo',
                tryAgain: 'Reintentar',
                chooseModel: 'Elegir modelo',
                cancelled: 'Se detuvo la escritura. Lo escrito se mantiene.',
                rest: 'El resto no se escribió. Todos los archivos están en Archivos; no se omitió nada en silencio.',
                offline: ({ machine, time }) => `${machine} está sin conexión · se muestran el recorrido y el código de las ${time}. Preguntar y actualizar volverán al reconectarse.`,
                offlineA11y: 'Necesita la máquina, que está sin conexión',
                incomplete: 'Algunos cambios no se pudieron listar. Lo que hay es exacto; nada afirma estar completo.',
                undo: 'Deshacer',
            },
            none: { title: 'Aún no hay recorrido', reason: 'Un recorrido lee estos cambios en orden y explica cada uno junto a su código exacto. Todos los archivos ya están en Archivos.', showFiles: 'Mostrar archivos' },
            explain: { notInStory: 'No forma parte de la historia', readInWalkthrough: 'Leer en el recorrido' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { es: {
        added: 'Añadido',
        boardTitle: 'Añadir al tablero',
        boardHint: 'Todos aquí ven lo que añades',
        companionTitle: 'Añadir al acompañante',
        companionHint: 'Solo tú ves tu acompañante',
        searchWidgets: 'Buscar widgets',
        searchCompanion: 'Buscar vistazos y paneles',
        makeOne: 'Crear uno',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Buscar más widgets',
        findMoreSubtitle: 'Plugins',
        askTitle: 'Pedir un widget al agente',
        askNote: 'Lo redacta en el compositor; no se envía nada hasta que tú lo hagas.',
        glances: 'Vistazos',
        glancesHint: 'en vivo, integrados o de plugins',
        onBoard: 'En este tablero',
        onBoardHint: 'compartido con todos aquí',
        panes: 'Paneles',
        panesHint: 'se añade como un enlace que se abre en Detalles',
        builtIn: 'Integrado',
        nativeDescriptions: {
            session_summary: 'Actividad y próximos pasos de la sesión que elijas.',
            agent_plan: 'Sigue el plan del agente para la sesión que elijas.',
            changes: 'Revisa los cambios de archivos de la sesión que elijas.',
            local_services: 'Abre los servicios locales de la sesión que elijas.',
        },
        noMatch: ({ query }) => `Ningún widget coincide con «${query}»`,
        pickTitle: 'Elige un widget para verlo aquí',
        pickHint: 'Muestra tus propios datos, al tamaño que elijas, antes de añadir nada.',
        pickNote: 'Elige un widget para añadirlo',
        askAction: 'Redactar la petición',
        pluginTag: 'plugin',
        pluginProvenance: ({ plugin }) => `Plugin ${plugin}`,
        readsChosenSession: 'lee la sesión que elijas, donde se ejecuta',
        readsFrom: ({ source }) => `lee ${source}`,
        savedQueryOn: ({ source }) => `una consulta guardada en ${source}`,
        madeByYou: ({ date }) => `creado por ti el ${date}`,
        madeByAgent: ({ date }) => `creado por tu agente el ${date}`,
        madeByPlugin: ({ date }) => `creado por un plugin el ${date}`,
        previewLiveData: 'En directo, con tus datos',
        addsAtSize: ({ size }) => `Lo añade en tamaño ${size}. Puedes cambiarlo más tarde.`,
        backToWidgets: 'Widgets',
        editTitle: ({ widget }) => `${widget} · entradas`,
        editHint: 'Solo cambia esta copia. Las demás conservan sus entradas.',
        preview: 'Vista previa',
        previewLive: 'Vista previa · en directo',
        previewWaiting: ({ field }) => `Elige ${field} para verlo aquí`,
        previewAfterAdd: 'Se verá aquí cuando lo añadas',
        needed: 'Necesario',
        stillNeeded: ({ field }) => `Aún falta ${field}`,
        followGroup: 'Seguir',
        pinGroup: 'O fija uno',
        another: 'Otro…',
        anotherSubtitle: 'Busca en todo lo que puedes consultar',
        searchChoices: ({ field }) => `Buscar ${field}`,
        noChoices: 'Todavía no hay nada que elegir',
        optionsLoading: 'Cargando opciones…',
        optionsFailed: 'No se pudieron cargar las opciones',
        invalidValue: 'no encontrado',
        inputsInvalid: 'Revisa las entradas de este widget',
        inputsUnavailable: 'Una entrada seleccionada no está disponible',
        connectionNeeded: ({ field }) => `Conecta tu ${field}`,
        sessionDenied: ({ session }) => `Ya no tienes acceso a ${session}`,
        sessionUnavailable: ({ session }) => `${session} no está disponible o se ha eliminado`,
        typeUnavailable: ({ field }) => `El tipo de ${field} ya no está disponible`,
        inputUnavailable: ({ field }) => `${field} no está disponible`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} ya no está disponible`,
        invalidReason: 'Ya no tienes acceso, o se eliminó.',
        viewerOnly: 'Cada persona aquí lo ve con su propia conexión.',
        justAdded: ({ widget }) => `${widget} añadido`,
        saved: ({ widget }) => `${widget} guardado`,
        addFailed: 'No se pudo añadir. Inténtalo de nuevo.',
        saveFailed: 'No se pudo guardar. Inténtalo de nuevo.',
        homeTitle: 'Añadir a Inicio',
        homeHint: 'Solo tú ves tu Inicio · en todos tus dispositivos',
        addWidgets: 'Añadir widgets',
        addToHome: 'Añadir a Inicio',
        addToBoard: 'Añadir al tablero',
        addToCompanion: 'Añadir al acompañante',
        editInputs: 'Editar entradas…',
        width: 'Ancho',
        size: 'Tamaño',
        sizes: { small: 'Pequeño', medium: 'Mediano', wide: 'Ancho', full: 'Completo', tall: 'Alto', large: 'Grande' },
        widthHalf: 'Mitad',
        widthFull: 'Completo',
        thisSession: 'Esta sesión',
        choicesCount: ({ count }) => count === 1 ? '1 opción' : `${count} opciones`,
        countOnHome: ({ count }) => `${count} en Inicio`,
        countOnBoard: ({ count }) => `${count} en el tablero`,
        countInCompanion: ({ count }) => `${count} en el acompañante`,
        thisPage: 'Esta página',
        thisProject: 'Este proyecto',
        thisCheckout: 'Esta copia de trabajo',
        areaPinned: 'Fijados',
        areaPinnedMeta: 'tus widgets en esta página',
        areaProjectTitle: 'Widgets',
        areaProjectMeta: 'tuyos',
        areaAdd: ({ surface }) => `Añadir un widget a ${surface}`,
        areaAddTo: ({ surface }) => `Añadir a ${surface}`,
        areaHint: 'Solo tú ves estos widgets',
        countHere: ({ count }) => count === 1 ? '1 aquí' : `${count} aquí`,
        areaEmptyTitle: 'Aún no hay nada fijado',
        areaEmptyReason: 'Fija un widget para tenerlo aquí, solo para ti.',
        areaEmptyAction: 'Añadir un widget',
        areaUnavailableTitle: 'Los widgets no se pueden cargar aquí',
        projectSourceUnavailableTitle: 'Los widgets aparecerán aquí cuando se conozca el repositorio de este proyecto',
        areaWriteFailed: 'No se pudo guardar este cambio',
        areaApprovalPending: 'Esperando aprobación',
        valueNotFound: ({ value }) => `No se encuentra ${value}`,
        chooseAnother: ({ field }) => `Elige otro valor para ${field}`,
        chooseField: ({ field }) => `Elige ${field}`,
        widgetOptions: 'Opciones del widget',
        moveTo: 'Mover…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "es">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { es: {
        yourWidgets: "Tus widgets",
        yourWidgetsHint: "hechos por ti o tus agentes",
        yourWidget: "Tu widget",
        moreInSource: "La fuente tiene más de lo que se muestra.",
        notCurrent: "No actualizado",
        aboutMenu: "Sobre este widget",
        aboutTitle: "Sobre este widget",
        aboutUnavailable: "No se puede abrir este widget ahora.",
        aboutData: "Datos",
        aboutReads: "Lee",
        aboutInputs: "Entradas",
        aboutRefresh: "Actualización",
        aboutUsedIn: "Se usa en",
        savedFromSession: ({ session }) => `Guardado desde ${session}`,
        aSession: "una sesión",
        madeInYourAccount: "Hecho en tu cuenta",
        edited: ({ time }) => `editado ${time}`,
        readsOnly: "Solo lectura",
        runsOn: ({ machine }) => `se ejecuta en ${machine}`,
        withYourConnection: "con tu propia conexión",
        readsResource: ({ read, plugin }) => `${read} de ${plugin}`,
        cannotRunAnythingElse: "El widget no puede ejecutar nada más.",
        inputsThisCopy: "Solo para esta copia",
        refreshWhenOpen: "Cuando lo abres",
        refreshNow: "Actualizar ahora",
        refreshing: "Actualizando…",
        refreshed: "Actualizado",
        refreshFailed: "No se pudo actualizar. Se mantienen las últimas cifras.",
        placedOnHome: "Inicio",
        placedOnBoard: ({ board }) => `Tablero ${board}`,
        placedOnABoard: "Un tablero",
        placedInASession: "Una sesión",
        placedInAProject: "Un proyecto",
        placedOnAPluginPage: "Una página de plugin",
        notPlacedYet: "Aún no está en ningún sitio",
        otherPlacesNotListed: "Los lugares en otros dispositivos o superficies compartidas no aparecen aquí.",
        editsChangeAll: ({ count }) => `Los cambios en el widget afectan a los ${count}`,
        editsChangeEverywhere: "Los cambios en el widget lo afectan en todos los sitios donde se usa",
        changeWithAgent: "Cambiar con el agente",
        changeDraft: ({ widget }) => `Cambia el widget «${widget}» para que `,
        duplicate: "Duplicar",
        duplicated: ({ name }) => `Copia «${name}» guardada en Tus widgets`,
        duplicateFailed: "No se pudo hacer una copia. Inténtalo de nuevo.",
        saveMenu: "Guardar como tu widget…",
        saveMenuSubtitle: "Una copia para Inicio y tus tableros",
        saveTitle: "Guardar como tu widget",
        saveHint: "Una copia que puedes poner en Inicio, tus tableros y proyectos. Esta sesión conserva la suya.",
        saveNote: "Guardado en tu cuenta · solo tú",
        saveWidget: "Guardar widget",
        saveFailed: "No se pudo guardar el widget. Inténtalo de nuevo.",
        savedButNotPlaced: "Guardado en Tus widgets, pero no se pudo añadir en todos los sitios elegidos.",
        savedAsYours: ({ name }) => `«${name}» guardado en Tus widgets`,
        name: "Nombre",
        nameNeeded: "Ponle un nombre",
        becomesViewerInput: "Pasa a ser una entrada: cada sitio usa tu conexión",
        becomesContextInput: "Pasa a ser una entrada: cada sitio elige la suya",
        alsoAddTo: "Añadir también a",
        alsoAddToNamed: ({ place }) => `Añadir también a ${place}`,
        snapshotMenu: "Publicar una instantánea en este tablero…",
        snapshotMenuSubtitle: "Todos aquí ven tus cifras de ahora",
        snapshotTitle: "¿Publicar una instantánea para todos?",
        snapshotHint: ({ widget, time }) => `Cualquiera que pueda abrir esta sesión verá ${widget} a las ${time}. No se actualizará y tu conexión sigue siendo tuya.`,
        postSnapshot: "Publicar instantánea",
        snapshotNotCurrent: "El widget aún está obteniendo cifras actuales. Inténtalo cuando las tenga.",
        snapshotFailed: "No se pudo publicar la instantánea. No se compartió nada.",
        snapshotAwaitingApproval: "Esperando aprobación en tu bandeja. No se comparte nada hasta que se apruebe.",
        snapshotPosted: "Instantánea publicada",
        snapshotNote: "Una copia de estas cifras. No se actualiza.",
        asOf: ({ time }) => `a las ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "es">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { es: {
        styleCard: 'Tarjeta',
        stylePlain: 'Simple',
        surfaceHome: 'Inicio',
        surfaceBoard: 'Tablero',
        surfaceCompanion: 'Acompañante',
        showFrame: 'Mostrar marco',
        hideFrame: 'Ocultar marco',
        thisWidgetOnly: 'Solo este widget',
        surfaceUses: ({ surface, style }) => `${surface} usa ${style}`,
        useSurfaceDefault: ({ surface }) => `Usar el valor predeterminado de ${surface}`,
        likeTheOthers: ({ style }) => `${style}, como los demás`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'Cómo se enmarcan los widgets en este dispositivo. Para cambiar uno, usa su menú ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Marco cambiado',
        newChip: 'Nuevo',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "es">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { es: {
        changesTitle: 'Cambios',
        localServicesTitle: 'Servicios locales',
        changesSource: 'Git',
        reviewChanges: 'Revisar cambios',
        notARepo: 'La carpeta de esta sesión no es un repositorio Git.',
        noChanges: 'Aún no hay cambios. Aquí aparecen los archivos que edite el agente.',
        changesLoading: 'Cargando cambios',
        running: 'En ejecución',
        notRunning: 'Sin ejecutar',
        nothingRunning: 'No hay nada en ejecución. Aquí aparecen los servicios que inicie esta sesión.',
        servicesLoading: 'Cargando servicios locales',
        servicesReadFailed: 'No se pudieron leer los servicios locales. Inténtalo de nuevo.',
        noMachine: 'Esta sesión no tiene una máquina a la que preguntar.',
        changedCount: ({ count }) => `${count} cambiados`,
        moreFiles: ({ count }) => (count === 1 ? '1 archivo más' : `${count} archivos más`),
        runningCount: ({ count }) => `${count} en ejecución`,
        openInBrowser: ({ name }) => `Abrir ${name} en el navegador`,
        paneLinkA11y: ({ pane }) => `${pane}. Se abre junto al chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "es">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const es: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Te necesita',
        working: 'Trabajando',
        finished: 'Terminado',
        idle: 'Inactivo',
        offline: 'Sin conexión',
    },
};

const workStatusTranslations = { es: { ...es, task: { stopped: 'Detenida', linkFailed: 'La sesión se creó, pero no se guardó su enlace con la tarea. Reintenta para enlazar la misma sesión.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "es"> = { es: {
        host: "Happier",
        structure: "Estructura",
        callWebhook: "Llamar a un webhook",
        runCommand: "Ejecutar un comando",
        commandValuesInEnv: "Pasa los valores del flujo de trabajo mediante variables de entorno. El texto del comando se mantiene tal como lo escribiste.",
        artifactCreate: "Crear un documento",
        artifactGet: "Leer un documento",
        artifactList: "Listar documentos",
        artifactUpdate: "Actualizar un documento",
        artifactDelete: "Eliminar un documento",
        artifactPublish: "Publicar un archivo",
        artifactRevisions: "Listar versiones de un documento",
        artifactRestore: "Restaurar una versión de un documento",
        artifactUsage: "Consultar el uso de almacenamiento de documentos",
        artifactShare: "Compartir un documento por enlace",
        artifactLinks: "Listar enlaces de un documento",
        artifactRevoke: "Revocar un enlace de documento",
        artifactAudit: "Consultar la actividad de enlaces de documento",
        sessionRole: "Establecer el rol de una sesión",
        sessionRoleOverride: "Cambiar los ajustes del rol de una sesión",
        sessionRoleClear: "Restablecer los ajustes del rol de una sesión",
        sessionRoleAdd: "Añadir un rol de sesión",
        sessionRoleRemove: "Eliminar un rol de sesión",
        sessionNotes: "Establecer notas de sesión",
        sessionRolesApply: "Aplicar roles a las sesiones subordinadas",
        roleList: "Listar roles",
        roleGet: "Leer un rol",
        roleCreate: "Crear un rol",
        roleUpdate: "Actualizar un rol",
        roleDelete: "Eliminar un rol",
        roleOverride: "Cambiar ajustes de un rol",
        roleReset: "Restablecer ajustes de un rol",
        widgetCatalog: "Listar widgets disponibles",
        widgetInstances: "Listar widgets colocados",
        widgetAdd: "Añadir un widget",
        widgetRemove: "Quitar un widget",
        widgetMove: "Mover un widget",
        widgetRename: "Renombrar un widget",
        widgetSize: "Establecer el tamaño de un widget",
        widgetFrame: "Establecer el marco de un widget",
        widgetInputs: "Leer entradas de un widget",
        widgetValidate: "Comprobar entradas de un widget",
        widgetSetInputs: "Establecer entradas de un widget",
        widgetResetInputs: "Restablecer entradas de un widget",
        widgetLayout: "Leer la disposición de widgets",
        widgetUpdateLayout: "Cambiar la disposición de widgets",
        widgetDefinitions: "Listar widgets guardados",
        widgetDefinition: "Leer un widget guardado",
        widgetCreate: "Crear un widget",
        widgetUpdate: "Actualizar un widget guardado",
        widgetDuplicate: "Duplicar un widget guardado",
        widgetDelete: "Eliminar un widget guardado",
        widgetSave: "Guardar un widget de sesión",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { es: { repeatable: 'Hacerlo repetible', repeatableDescription: 'Pide al agente que convierta lo que funcionó aquí en un workflow reutilizable.', repeatablePrompt: 'Convierte lo que hicimos aquí en un workflow que pueda volver a ejecutar. Diséñalo, compruébalo con workflow.validate y guárdalo, pero no lo ejecutes.', repeatableMessagePrompt: 'Convierte lo que hicimos en este mensaje en un workflow que pueda volver a ejecutar. Diséñalo, compruébalo con workflow.validate y guárdalo, pero no lo ejecutes.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "es"> = { es: { ...repeatable.es, create: 'Crear con un agente', edit: 'Editar con un agente', agent: 'Agente', description: 'Una sesión nueva diseña el workflow contigo, lo comprueba y lo guarda. No se ejecuta nada hasta que elijas Ejecutar ahora.', changedByAgent: 'Cambiado por el agente', saved: 'Guardado por el agente ahora', savedAge: ({ age }) => `Guardado por el agente ${age}`, savedWorkflow: ({ name }) => `Workflow guardado · ${name}`, updated: 'Workflow actualizado', changed: ({ count }) => `Workflow actualizado · ${count} pasos cambiados`, openEditor: 'Abrir en el editor', openSession: 'Abrir en Sesiones', createPrompt: 'Diseña conmigo un workflow, compruébalo con workflow.validate y luego guárdalo. No lo ejecutes.', createLead: 'Ayúdame a crear un workflow que ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `El workflow guardado «${name}» tiene el id ${definitionId} y la revisión: cabecera ${headerVersion}, cuerpo ${bodyVersion}. Cámbialo con workflow.definition.edit y usa workflow.definition.update solo para reemplazarlo entero. Compruébalo con workflow.validate antes de guardar. No lo ejecutes.`, editLead: ({ name }) => `Ayúdame a cambiar ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const es: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Se ejecuta dentro de una sesión',
    keepGoing: { title: 'Seguir hasta terminar' },
    reviewAndConverge: { title: 'Revisar y converger', apply: 'Aplicar', verifyAndFix: 'Verificar y corregir', verifyOnly: 'Solo verificar', rounds: 'Rondas antes de parar' },
    planWithAPanel: { title: 'Planificar con un panel', description: 'Varios agentes planifican en paralelo y el plan espera tu revisión.', inputs: { request: 'Solicitud', requestPlaceholder: '¿Qué debe planificar el panel?', engines: 'Planificadores' } },
    openAPullRequest: { title: 'Abrir una pull request', description: 'Pide una segunda opinión y luego abre una pull request. Si la segunda opinión no está de acuerdo, te espera.', inputs: { base: 'Rama base', title: 'Título de la pull request', body: 'Descripción', question: 'Pregunta para la segunda opinión' } },
};

const workflowBuiltinTranslations = { es } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { es: {
        sessionId: "Sesión",
        triggerId: "Disparador",
        engineIds: "Revisores",
        backendTargetKeys: "Planificadores",
        reviewCommentAuthorIntent: "Hallazgos",
        commentId: "Hallazgo",
        expectedServerRevision: "Versión del hallazgo",
        clientMutationId: "Actualización",
        projectId: "Proyecto",
        workspace: "Espacio de trabajo",
        toState: "Estado",
        expectedState: "Estado actual",
        disposition: "Importancia",
        allPages: "Todos los hallazgos",
        permissionMode: "Permisos",
        target: "Se ejecuta en",
        cwd: "Carpeta de trabajo",
        maxRounds: "Rondas máximas",
        strikes: "Comprobaciones sin progreso",
        secondOpinion: "Segunda opinión",
        useJudge: "Juez",
        diffFingerprint: "Cambios revisados",
        url: "URL",
        body: "Cuerpo JSON",
        command: "Comando",
        env: "Variables de entorno",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const es: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.es,
    blocks: {
        actionSub: 'Acción · sin turno de agente',
        notSet: 'Sin definir',
        set: 'Definir',
        clear: 'Borrar',
        required: 'Obligatorio',
        noFields: 'No hay nada que definir para esta acción.',
        workflowSub: 'Ejecuta otro flujo · sus pasos aparecen en esta ejecución',
        builtin: 'Integrado',
        waitTitle: 'Esperarte',
        waitSub: 'Este carril espera hasta que continúes.',
        waitPlaceholder: '¿Qué deberías revisar o decidir aquí?',
        returnsText: 'Devuelve texto',
        returnsFields: ({ fields }) => `Devuelve ${fields}`,
        workflowDefaults: 'Valores del flujo de trabajo',
        addNamedResults: 'Añadir resultados con nombre',
        menuRun: 'Ejecutar un flujo',
        menuAction: 'Acción',
        menuWait: 'Esperarte',
        actionSearch: 'Buscar acciones',
        workflowSearch: 'Buscar flujos',
        libraryGroup: 'Tus flujos',
        noAgentTurn: 'Sin turno de agente.',
        useNumber: 'Usar un número',
        actionUnavailable: ({ action }: { action: string }) => `${action} no está disponible aquí.`,
        childInputs: ({ workflow }: { workflow: string }) => `Las entradas vienen de ${workflow}.`,
        retryLoading: "Volver a cargar",
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} ejecuta este flujo, así que no puede ejecutarse dentro de él.`,
        maxFromInput: ({ name }: { name: string }) => `Desde la entrada · ${name}`,
        useInput: ({ name }: { name: string }) => `Usar la entrada ${name}`,
    },
    backToRun: 'Volver a la ejecución',
    reviewedCopyTitle: 'Revisar antes de guardar',
    reviewedCopyBody: 'Esta es una copia de una ejecución. Se guardan los pasos y ajustes, no el historial ni los resultados. El lugar, el tipo de ejecución y los valores de entrada son opciones de cada ejecución. Revisa las referencias a sesiones existentes, carpetas, perfiles, modelos, servicios y servidores MCP antes de reutilizarlas.',
    chromeTitle: 'Flujo de trabajo',
    untitled: 'Flujo sin título',
    nameLabel: 'Nombre del flujo',
    descriptionPlaceholder: 'Añade una descripción',
    descriptionLabel: 'Descripción',
    save: 'Guardar',
    flow: 'Flujo',
    flowSubtitle: 'Este borrador como mapa',
    settings: 'Ajustes del flujo',
    settingsSubtitle: 'Cada paso los usa salvo que los cambie.',
    deleteWorkflow: 'Eliminar flujo',
    deleteBody: 'Las ejecuciones anteriores siguen en el historial.',
    deleteFailedTitle: 'No se pudo eliminar el flujo',
    changedForStep: 'Cambiado para este paso',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 cosa por corregir antes de poder ejecutarlo' : `${count} cosas por corregir antes de poder ejecutarlo`),
    saveStatus: {
        notSaved: 'Aún sin guardar',
        unsaved: 'Cambios sin guardar',
        saving: 'Guardando…',
        saved: 'Guardado',
        savedJustNow: 'Guardado ahora mismo',
        savedAge: ({ age }: { age: string }) => `Guardado ${age}`,
        failed: 'No se pudo guardar',
        yourEdits: 'Tus cambios',
        newerVersion: 'La versión más reciente',
        newerVersionRevision: ({ revision }: { revision: string }) => `La versión más reciente · ${revision}`,
    },
    where: {
        label: 'Dónde se ejecuta',
        choose: 'Elige dónde se ejecuta',
    },
    sections: {
        whereTitle: 'Dónde se ejecuta',
        machineAndProject: 'Máquina y proyecto',
        eachStepRunsIn: 'Cada paso se ejecuta en',
        eachStepSession: 'Cada paso aparece en tu lista de sesiones, bajo esta ejecución.',
        eachStepBackground: 'Cada paso se ejecuta en segundo plano, bajo esta ejecución.',
        aSession: 'Una sesión',
        aBackgroundRun: 'Una ejecución en segundo plano',
        agentTitle: 'Agente y modelo',
        agentDescription: 'Los pasos los usan salvo que elijan los suyos.',
        rolesTitle: 'Roles para este flujo de trabajo',
        conversationTitle: 'Conversación y espacio de trabajo',
        inputsTitle: 'Entradas y resultado',
    },
    unavailable: {
        machine_not_selected: 'Elige primero una máquina.',
        capability_unknown: 'Comprobando qué admite esta máquina.',
        machine_does_not_support_detached_runs: 'Esta máquina aún no puede hacer ejecuciones en segundo plano.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Opciones del paso',
        whereMissing: 'Ninguna máquina elegida',
        none: 'Ninguna',
        inputCount: ({ count }) => count === 1 ? '1 entrada' : `${count} entradas`,
        finalOutput: ({ output }) => `Resultado final: ${output}`,
        originSession: 'La sesión que lo inició',
        differsFromWorkflow: 'difiere del flujo de trabajo',
        followsWorkflow: 'usa los ajustes del flujo de trabajo',
        advancedTitle: 'Avanzado',
        deadline: ({ ms }) => `Espera ${ms} ms su resultado`,
        workflowDefault: ({ value }) => `Predeterminado del flujo · ${value}`,
        aSession: 'Una sesión…',
        continues: ({ session }) => `Continúa ${session}`,
        runsIn: 'Se ejecuta en',
        runsInBoundBySession: 'Continúa una sesión, así que se ejecuta en esa sesión.',
        reviewTitle: 'Revisar antes de continuar',
        reviewDescription: 'Los pasos siguientes de este carril esperan hasta que uses, edites o regeneres el resultado. El resto del trabajo continúa.',
        reviewEvaluator: 'Cada iteración espera tu revisión.',
        reviewsBeforeContinuing: 'Revisa antes de continuar',
        resultTitle: 'Resultado',
        resultFromAction: ({ action }) => `Definido por ${action}`,
        resultFromWorkflow: ({ workflow }) => `Devuelve lo que devuelve ${workflow}`,
        back: 'Atrás',
        options: 'Opciones',
        itemConversation: 'Una conversación por elemento; los pasos de dentro la comparten.',
        dropContinue: ({ session }) => `Continuar ${session} en este paso`,
        dropRefused: ({ session, machine, where }) => `${session} está en ${machine}; este flujo se ejecuta en ${where}.`,
        lanes: ({ count }) => `En paralelo · ${count} carriles`,
        lane: ({ position }) => `Carril ${position}`,
        forEachIn: ({ source }) => `Para cada elemento de ${source}`,
        atATime: ({ count }) => `${count} a la vez`,
        repeatTimes: ({ count }) => `Repetir ${count} veces`,
        repeatUntil: ({ condition }) => `Repetir hasta ${condition}`,
        repeatUntilDecided: 'Repetir hasta que un paso diga que pare',
        ifSentence: ({ condition }) => `Si ${condition}`,
        onlyWhenSentence: ({ condition }) => `Solo cuando ${condition}`,
        conditionAll: 'se cumplen todas',
        conditionAny: 'se cumple alguna',
        conditionNot: ({ condition }) => `no (${condition})`,
        returnsStructured: 'Devuelve datos estructurados',
        returnsDecision: 'Devuelve una decisión',
    },
};

const workflowEditorPageTranslations = { es } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "es"> = { es: {
        nodes: { ask: 'Preguntar', 'review-correctness': 'Revisar la corrección', 'review-tests': 'Revisar pruebas', summarize: 'Resumir hallazgos', analyze: 'Analizar', review: 'Revisar', fix: 'Corregir', check: 'Comprobar', classify: 'Clasificar', reply: 'Redactar una respuesta', digest: 'Resumir cambios' },
        title: 'Empezar con un ejemplo', fromExample: 'Desde un ejemplo', description: 'Cada uno se abre como borrador. Nada se ejecuta hasta que elijas Ejecutar ahora.', use: 'Usar este', chooseSession: 'Elegir una sesión…', builtInDescription: 'Parte de Happier. Duplica uno para cambiarlo.', stepCount: ({ count }) => `${count} ${count === 1 ? 'paso' : 'pasos'}`,
        askOnce: { title: 'Preguntar una vez', description: 'Un paso: pregunta algo a un agente y recibe su respuesta.' },
        reviewPullRequest: { title: 'Revisar un pull request', description: 'Dos revisores en paralelo y después un resumen con todos los hallazgos.' },
        workThroughEachFile: { title: 'Trabajar en cada archivo', description: 'Para cada archivo de una lista, de uno en uno: analizarlo y revisar el cambio.' },
        repairUntilItPasses: { title: 'Reparar hasta que pase', description: 'Reparar y comprobar hasta que pase o se agoten tus intentos. Después revisas la última reparación.' },
        triageAnIssue: { title: 'Clasificar una incidencia', description: 'Clasifica una incidencia. Si es un error, corrígelo; si no, redacta una respuesta.' },
        morningDigest: { title: 'Resumen de la mañana', description: 'Resume los cambios de tu proyecto y envíatelos. Añade un disparador para recibirlo cada mañana.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "es"> = { es: { fromPlugins: 'De plugins', readOnly: 'Solo lectura · duplica en tu biblioteca para editar', duplicateToLibrary: 'Duplicar en tu biblioteca' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "es"> = { es: { title: "Visibilidad", chooseTeam: "Elegir un equipo", loadFailed: "No se pudo comprobar quién puede ver esta ejecución", machines: "Se ejecuta en tus máquinas", transcripts: "Los miembros del equipo pueden ver las conversaciones de los pasos.", requiredSessionsEditable: "Los miembros de este equipo pueden editar sus sesiones", visibleTo: ({ team }) => "Visible para " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "es"> = { es: { visibility: workflowRunVisibilityTranslations.es, runWithAnotherAgent: 'Ejecutar de nuevo con otro agente', agentForStep: ({ step }) => `Agente para ${step}`, chooseAgent: 'Elegir un agente o rol' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { es: {
        definitions: 'Definiciones',
        stepsProgress: ({ completed, total }: Progress) => `${completed} de ${total} pasos`,
        loopProgress: ({ completed, total }: Progress) => `${completed} de ${total} elementos`,
        startedByAgent: 'Iniciado por un agente',
        startedByTrigger: 'Iniciado por un disparador',
    } } satisfies Pick<Record<string, typeof en>, "es">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "es"> = { es: { rolesTitle: 'Roles para esta ejecución', rolesYour: 'Tus roles', rolesChanged: ({ count }) => `${count} cambiados para esta ejecución`, rolesUnchanged: 'Todo lo demás sigue igual.', useYourRole: 'Usar tu rol', targetsTitle: 'Cada paso se ejecuta en', rolesPrefillFailed: 'No se pudieron leer los roles de tu última ejecución. Inténtalo de nuevo.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "es"> = { es: { ...workflowRunRoleTranslations.es, ...workflowRunCompositionTranslations.es, neededNamed: ({ name }) => `Entradas · falta ${name}`, addToStart: ({ name }) => `Añade ${name} para iniciar`, workflow: 'Flujo de trabajo', inputs: 'Entradas', start: 'Iniciar', starting: 'Iniciando…', stillStarting: 'Aún iniciando…', needed: ({ count }) => `Entradas · faltan ${count}`, required: 'Necesario para iniciar', preview: 'Qué hará', unsaved: 'Incluye cambios sin guardar', remove: 'Volver a una sesión normal', search: 'Buscar un flujo', builtin: 'Integrados', library: 'Tu biblioteca', noInputs: 'No necesita entradas', asksFor: ({ names }) => `Solicita ${names}`, optional: 'Opcional — se deja vacío', defaultValue: ({ value }) => `Predeterminado: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const es: WorkflowsDestinationTranslations = {
    description: 'Recetas que tus agentes ejecutan en tus máquinas: cuando tú decidas, según un horario o cuando pase algo.',
    import: 'Importar',
    addAccessibility: 'Añadir un flujo de trabajo',
    moreAccessibility: 'Más opciones de flujos de trabajo',
    addMenu: {
        newWorkflowSubtitle: 'Empieza con un borrador en blanco',
        importSubtitle: 'Un archivo JSON de flujo de trabajo',
    },
    sections: {
        needsYou: 'Te necesita',
        running: 'En curso',
        library: 'Biblioteca',
        sharedWithYou: 'Compartidos contigo',
        triggers: 'Disparadores',
        history: 'Historial',
    },
    allRuns: 'Todas las ejecuciones',
    lastRun: ({ age }) => `última ejecución ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Última ejecución' : `Últimas ${count} ejecuciones`}: ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Última ejecución' : `Últimas ${count} ejecuciones`),
        completed: ({ count }) => `${count} ${count === 1 ? 'completada' : 'completadas'}`,
        failed: ({ count }) => `${count} ${count === 1 ? 'fallida' : 'fallidas'}`,
        needsYou: ({ count }) => `${count} te ${count === 1 ? 'necesita' : 'necesitan'}`,
        separator: ', ',
    },
    runSettings: 'Ajustes de ejecución',
    libraryEmpty: 'Los flujos de trabajo que guardes aparecen aquí.',
    waitingForYou: ({ age }) => `Te espera · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Enviar una instrucción',
    thenRunWorkflow: 'Ejecutar un flujo de trabajo',
    offline: 'Sin conexión',
    off: 'Desactivado',
    columnLoadFailed: 'No se pudieron cargar los flujos de trabajo. No se pierde nada de lo que guardaste.',
    firstVisitTitle: 'Guarda las instrucciones que funcionan y vuelve a ejecutarlas',
    firstVisitBody: 'Un flujo de trabajo es un conjunto de pasos que tus agentes ejecutan en orden, en paralelo o una vez por elemento: cuando tú decidas, según un horario o cuando pase algo.',
    importPrompt: '¿Tienes un archivo de flujo de trabajo?',
    loadMoreWorkflows: 'Cargar más flujos de trabajo',
    searchPlaceholder: 'Buscar flujos de trabajo',
    noMatch: ({ query }) => `Ningún flujo de trabajo coincide con «${query}»`,
    views: {
        all: 'Todos',
        triggered: 'Con disparador',
        active: 'Activas',
        needsYou: 'Te necesita',
        libraryAccessibility: 'Qué flujos de trabajo mostrar',
        historyAccessibility: 'Qué ejecuciones mostrar',
    },
    history: {
        title: 'Historial',
        description: 'Cada ejecución que iniciaste, sin importar cómo empezó.',
        loadMore: 'Cargar más ejecuciones',
        loadFailedTitle: 'No se pudieron cargar las ejecuciones',
        loadFailedBody: 'Tu trabajo no se ve afectado.',
        review: 'Revisar',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Opciones del flujo de trabajo',
        runNow: 'Ejecutar ahora',
        share: 'Compartir…',
    },
    deleteTitle: '¿Eliminar este flujo de trabajo?',
    deleteBody: 'Las ejecuciones anteriores se quedan en el Historial.',
    deleteFailedTitle: 'No se pudo eliminar el flujo de trabajo',
    exportFailedTitle: 'No se pudo exportar el flujo de trabajo',
    gate: {
        localTitle: 'Las automatizaciones están desactivadas en este dispositivo',
        localBody: 'Actívalas para ejecutar flujos de trabajo y sus disparadores.',
        dependencyTitle: 'Los flujos de trabajo necesitan automatizaciones',
        dependencyBody: 'Activa las automatizaciones para crear y ejecutar flujos de trabajo.',
        openSettings: 'Abrir Ajustes',
    },
    runSettingsPage: {
        title: 'Ajustes de ejecución',
        description: 'Cuántas ejecuciones acepta cada máquina a la vez y cuánto tiempo se guarda el historial.',
        saveFailed: 'No se pudieron guardar los ajustes de ejecución. Tus cambios siguen aquí.',
    },
};

const workflowsDestinationTranslations = { es } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const es: WorkflowTriggersCopy = {
    pullRequest: {
        label: "Pull request",
        description: "Añadir este disparador vincula el pull request a esta sesión.",
        empty: "No hay pull requests abiertos",
        loadFailed: "No se pudieron cargar los pull requests",
    },
    summary: {
        everyDayAt: ({ time }) => `Cada día a las ${time}`,
        weekdaysAt: ({ time }) => `Días laborables a las ${time}`,
        weeklyAt: ({ day, time }) => `Cada ${day} a las ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Cada minuto' : `Cada ${count} minutos`),
        everyHours: ({ count }) => (count === 1 ? 'Cada hora' : `Cada ${count} horas`),
        cron: ({ expression }) => `Según un horario · ${expression}`,
        schedule: 'Según un horario',
        event: ({ event }) => `Cuando ocurre ${event}`,
        manual: 'Manual',
        more: ({ first, count }) => `${first} · ${count} más`,
    },
    kind: {
        sessionStarts: 'Cuando empieza la sesión',
        sessionArchived: 'Cuando se archiva la sesión',
        schedule: 'Según un horario',
        prComment: 'Cuando alguien comenta en un pull request',
        ciFailed: 'Cuando falla la CI en un pull request',
        turnEnds: 'Cuando termina un turno',
        needsYou: 'Cuando la sesión te necesita',
        runEnds: 'Cuando termina la ejecución',
        runNeedsYou: 'Cuando la ejecución te necesita',
    },
    row: {
        workflowDeleted: 'Flujo eliminado',
        legacyCreated: 'Creado en Happier 0.2',
        legacyUnavailable: 'Disparador antiguo no disponible',
        sessionKeyRequired: 'Se necesita la clave de sesión',
        templateRecoveryRequired: 'Recupera este disparador en Seguridad de la cuenta',
        templateDecryptionFailed: 'No se pudo descifrar el disparador',
        machines: ({ count }: Count) => `${count} máquinas`,
        nextRun: ({ time }: { time: string }) => `Próxima ejecución: ${time}`,
        steps: ({ count }) => (count === 1 ? `${count} paso` : `${count} pasos`),
        off: 'Desactivado',
        running: 'En curso',
        ran: ({ age }) => `Se ejecutó ${age}`,
        turnOn: ({ name }) => `Activar ${name}`,
        turnOff: ({ name }) => `Desactivar ${name}`,
    },
    section: {
        add: 'Añadir un disparador',
        emptyTitle: 'Sin disparadores',
        emptyBody: 'Añade uno para revisar cada turno, seguir hacia un objetivo o reaccionar al pull request.',
        loadFailed: 'No se pudieron cargar los disparadores de esta sesión.',
        title: 'Disparadores',
        countOn: ({ count }) => `${count} activos`,
        info: 'Lo que se ejecuta en esta sesión cuando ocurre algo. Se quedan con esta sesión y no aparecen en tu biblioteca.',
        saveFailed: 'No se pudo guardar este disparador. Tus cambios siguen aquí.',
    },    kindDescription: {
        turnEnds: 'Después de un turno tuyo o de un agente con el que trabajas.',
        needsYou: 'Siempre que esta sesión te espere, también mientras la dirige un flujo o Seguir hasta terminar.',
        sessionArchived: 'Se ejecuta una vez, cuando archivas esta sesión.',
        sessionStarts: 'Solo al crear una sesión.',
        schedule: 'Continúa esta sesión según un horario.',
        prComment: 'Solo personas con acceso de escritura. El comentario se pasa como texto citado.',
        pullRequestUnavailable: 'Todavía no se pueden añadir aquí disparadores de pull requests.',
    },
    then: {
        runsIn: 'Se ejecuta en',
        runsInChoice: {
            newSession: 'Una sesión nueva',
            session: 'Una sesión…',
            backgroundRun: 'Una ejecución en segundo plano',
        },
        noSessionOnMachine: 'Aún no hay sesiones en esta máquina',
        session: 'Sesión',
        action: 'Acción',
        label: 'Después',
        sendPrompt: 'Enviar un prompt',
        doAction: 'Hacer una acción',
        notifyMe: 'Notificarme',
        runWorkflow: 'Ejecutar un flujo',
        sendPromptDescription: 'El agente de esta sesión recibe este prompt en esta sesión. Nunca interrumpe tu turno.',
        promptLabel: 'Prompt',
        promptPlaceholder: '¿Qué debe hacer el agente?',
        message: 'Mensaje',
        title: 'Título',
        sendTo: 'Enviar a',
        sendToDefault: 'Tus ajustes de notificaciones',
        workflow: 'Flujo',
        choose: 'Elegir…',
    },
    popover: {
        saveAsWorkflow: 'Guardar como flujo',
        saveAsWorkflowDescription: 'Abre estos pasos como un flujo nuevo para revisar. Este disparador conserva sus propios pasos.',
        when: 'Cuándo',
        newTrigger: 'Nuevo disparador',
        addTrigger: 'Añadir disparador',
        cancel: 'Cancelar',
        done: 'Listo',
        turnOff: 'Desactivar',
        turnOn: 'Activar',
        deleteTrigger: 'Eliminar disparador',
        repeat: 'Repetir',
        everyDay: 'Cada día',
        weekdays: 'Días laborables',
        weekly: 'Semanal',
        day: 'Día',
        at: 'A las',
        expression: 'Horario',
        tryAgain: 'Reintentar',
    },    editor: {
        runsOn: 'Se ejecuta en',
        runsOnDescription: 'Todos los disparadores de este flujo se ejecutan aquí.',
        runsOnAccountDescription: 'Dónde se ejecuta este disparador.',
        runsOnDiffers: ({ where }) => `Ejecutar ahora usa ${where} en su lugar.`,
        sameForAllTriggers: 'Igual para todos los disparadores',
        roles: 'Roles',
        retargetFailed: 'Flujo guardado · Disparador sin actualizar',
        editInWorkflows: 'Cambia este disparador en Flujos. Sigue ejecutándose como está.',
        title: 'Se ejecuta automáticamente',
        runsBy: 'Se ejecuta solo cuando ocurre una de estas cosas.',
        runsByOn: ({ where }) => `Se ejecuta solo cuando ocurre una de estas cosas, en ${where}.`,
        savedWorkflow: 'Los disparadores ejecutan el flujo guardado.',
        saveToInclude: 'Los disparadores ejecutan el flujo guardado. Guarda para incluir tus cambios.',
        newRow: 'Nuevo · aún no añadido',
        partialSave: 'Flujo guardado · Disparadores sin actualizar',
    },    column: {
        newTrigger: 'Nuevo disparador',
        newTriggerSubtitle: 'Ejecuta sus propios pasos según un horario',
    },
};

const legacyTranslations = { es: {
        editNotice: 'Creado en Happier 0.2. Abrirlo no cambia nada.',
        conversionBoundary: 'Después de este cambio solo se ejecuta en máquinas con Happier 0.3 o posterior.',
        channelReplyRefusal: 'Esta automatización tiene un vínculo de respuesta a un canal que no se puede transferir. No se convirtió; sus ajustes y tus cambios siguen intactos.',
        notAvailable: 'Esta automatización ya no está disponible.',
    } };

const creationTranslations = { es: { savedWorkflowsUnavailable: 'Cambia al servidor de esta sesión para elegir un flujo guardado. Los flujos integrados y los pasos propios siguen disponibles.' } };

const workflowTriggersTranslations = { es: { ...es, legacy: legacyTranslations.es, creation: creationTranslations.es } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { es: {
        checkoutRoot: 'Carpeta raíz del checkout',
        unavailableValue: 'Valor no disponible', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Contexto de la sesión' : `Últimos ${turns} turnos de la sesión`,
        tokensUsed: 'Tokens usados', goalTokenBudget: 'Presupuesto de tokens del objetivo',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${source} consecutivos con ${value}`,
        stopCondition: 'Condición de parada cumplida', stopConditionArm: ({ arm }: { arm: number }) => `Condición de parada ${arm} cumplida`,
        roundLimit: ({ rounds }: { rounds: number }) => `Límite alcanzado · ${rounds} rondas`, decision: 'Decisión',
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

const es = translated(workflowValueReferenceTranslations.es, {
    title: 'Flujos de trabajo',
    newWorkflow: 'Nuevo flujo de trabajo',
    copyName: ({ name }: { name: string }) => `${name} copia`,
    importJson: 'Importar JSON',
    exportJson: 'Exportar JSON',
    openCollection: 'Abrir los flujos de trabajo',
    destination: workflowsDestinationTranslations.es,
    plugins: workflowPluginTranslations.es,
    authoring: workflowAgentAuthoringTranslations.es,
    page: workflowEditorPageTranslations.es,
    actionTitles: workflowActionTranslations.es,
    builtins: workflowBuiltinTranslations.es,
    examples: workflowExamplesTranslations.es,
    triggers: workflowTriggersTranslations.es,
    start: workflowStartTranslations.es,
    list: workflowRunListTranslations.es,
    review: {
        publishedByAgent: 'Publicado por el agente',
        publishedByYou: 'Publicado por ti',
        editedByYou: 'Editado por ti',
        editedByPerson: 'Editado por otra persona',
        previousAttempt: 'Intento anterior',
        useBody: "Los siguientes pasos reciben exactamente lo que ves. Sin un turno del agente.",
        usePlanBody: "Acepta exactamente este plan. Sin un turno del agente.",
        reportBackTitle: ({ session }) => "Informar a " + session,
        reportBackBody: ({ session }) => session + " recibe el resultado de esta ejecución cuando termina.",
        planRunNotice: "Ejecuta el flujo propuesto tal como se muestra y acepta el plan. No lo guarda.",
        editedPlanBody: 'Este borrador difiere de la propuesta. ¿Aceptar primero el plan revisado para editarlo? Tus cambios permanecen aquí y nada se inicia hasta que vuelvas a ejecutar el borrador.',
        title: "Resultado para revisar",
        planTitle: "Plan para revisar",
        waitTitle: "Esperando tu respuesta",
        waitBody: "Esta rama espera hasta que continúes.",
        editsTitle: "Tus cambios sin guardar",
        editsBody: "El resultado guardado no cambia hasta que lo uses.",
        heldBody: "Esperando tu revisión · aún no se ha pasado a los siguientes pasos",
        noValue: "Aún no hay un resultado válido",
        useResult: "Usar este resultado",
        usePlan: "Usar este plan",
        useValues: "Usar estos valores",
        continue: "Continuar",
        invalid: "Corrige primero el campo marcado.",
        newer: "Hay un resultado más reciente.",
        showNewer: "Mostrar el nuevo",
        keepMyEdits: 'Conservar mis cambios',
        useNewer: 'Usar el nuevo',
        showFullResult: 'Mostrar el resultado completo',
        showFullPlan: 'Mostrar el plan completo',
        generationRequested: "Generación solicitada",
        startsResume: "Empieza cuando reanudes la ejecución.",
        generateBody: "El agente escribe un nuevo resultado en esta conversación. Si es válido, la ejecución continúa sin volver a preguntar.",
        acceptedPaused: "Usar este resultado mantiene el flujo en pausa.",
        editResult: "Editar resultado",
        generate: "Generar resultado y continuar",
        discuss: "Conversar",
        discussBody: "Responde en la conversación de este paso. El agente puede publicar aquí un resultado actualizado.",
        proposal: "Flujo propuesto",
        planStarted: "Se inició una ejecución de este plan",
        earlierPlanStarted: "Ya se inició una ejecución de una propuesta anterior",
        openEarlierPlanRun: "Abrir esa ejecución",
        runNewProposal: "Ejecutar la nueva propuesta",
        runPlan: "Ejecutarlo como flujo",
        runPlanBody: "Abre la revisión del flujo propuesto. Al iniciarlo también se acepta este plan.",
        editPlan: "Editar primero el flujo",
        editPlanBody: "Acepta este plan y abre el flujo propuesto como borrador sin guardar.",
        editPlanFallback: "Acepta este plan y abre un flujo de un paso con este plan como instrucción.",
        waitingMachine: ({ machine }) => "Esperando a " + machine,
    },

    tabs: {
        saved: 'Guardados',
        runs: 'Ejecuciones',
        steps: 'Pasos',
        flow: 'Flujo',
        map: 'Mapa',
        activity: 'Actividad',
    },
    tabsAccessibility: {
        savedRuns: 'Flujos de trabajo guardados o ejecuciones',
        stepsFlow: 'Pasos o flujo',
        activityFlow: 'Actividad o flujo',
        runViews: "Vistas de ejecución",
    },

    filters: {
        all: 'Todo',
        active: 'Activos',
        needsYou: 'Te necesita',
        clear: 'Quitar el filtro',
    },

    empty: {
        savedTitle: 'Aún no hay flujos de trabajo guardados',
        savedBody: 'Al guardar un flujo de trabajo conservas una definición reutilizable que puedes ejecutar o programar.',
        runsTitle: 'Todavía no se ha ejecutado nada',
        runsBody: 'Las ejecuciones aparecen aquí, guardes o no el flujo de trabajo.',
        filteredTitle: 'Ninguna ejecución coincide con este filtro',
        filteredBody: 'Quita el filtro para ver el resto de tus ejecuciones.',
        missingTitle: 'Este flujo de trabajo no está disponible',
        missingBody: 'Happier no pudo abrir el flujo de trabajo al que apunta este enlace. Tus otros flujos, Automatizaciones y ejecuciones no se ven afectados.',
    },

    loadFailedTitle: 'No se han podido cargar los flujos de trabajo',
    loadFailedBody: 'Tu trabajo no se ve afectado. Inténtalo de nuevo cuando quieras.',
    retry: 'Reintentar',
    contentUnavailable: 'El contenido privado no está disponible en este dispositivo.',
    contentReasons: {
        invalidHeader: 'La información guardada de este flujo de trabajo no es válida.',
        revisionMismatch: 'Este flujo de trabajo no coincide con su revisión guardada.',
        missingBody: 'Falta la definición guardada de este flujo de trabajo.',
        invalidBody: 'La definición guardada de este flujo de trabajo no es válida.',
        notFound: 'Este flujo de trabajo ya no está disponible.',
    },

    sessionEntry: {
        missingTitle: 'Esta sesión ya no está disponible',
        missingBody: 'Puede haberse eliminado o estar en otro Home. Abre Sesiones para encontrarla.',
        inaccessibleTitle: 'No puedes abrir esta sesión',
        inaccessibleBody: 'Happier no pudo confirmar el acceso. Vuelve a iniciar sesión o pídeselo a su propietario y abre de nuevo esta página.',
        failedTitle: 'No se pudo abrir esta sesión',
        failedBody: 'Happier sigue intentándolo. Puedes volver a intentarlo ahora.',
        unsupportedTitle: 'Esta sesión no puede iniciar un flujo de trabajo',
        unsupportedBody: 'Happier no pudo leer el agente ni la máquina en la que se ejecuta. Crea el flujo de trabajo desde Flujos de trabajo.',
    },

    editor: {
        namePlaceholder: 'Nombre del flujo de trabajo',
        agentRuntime: 'Entorno de ejecución del agente',
        firstPromptTitle: '¿Qué debería ocurrir primero?',
        firstPromptBody: 'Un solo prompt ya es un flujo de trabajo. Añade pasos cuando los necesites.',
        promptPlaceholder: 'Describe qué debe hacer este paso',
        useWorkflowDefault: 'Usar el valor del flujo de trabajo',
        defaultsTitle: 'Valores por defecto',
        produces: 'Produce',
        whereTitle: 'Dónde',
        add: 'Añadir',
        addAccessibility: 'Añadir un bloque a este flujo de trabajo',
        addStep: 'Paso de agente',
        addParallel: 'En paralelo',
        addLoop: 'Repetir',
        addIf: 'Si',
        targetRequired: 'Elige la máquina y la carpeta del proyecto para este flujo de trabajo.',
        loadingTitle: 'Abriendo el flujo de trabajo…',
        accountChangedTitle: 'Has cambiado de cuenta',
        accountChangedBody: 'Este flujo de trabajo lo abrió la cuenta anterior y no se puede trasladar. Ábrelo de nuevo desde Flujos de trabajo.',
        loadFailedTitle: 'No se pudo abrir este flujo de trabajo',
        loadFailedBody: 'Ahora mismo no se pudo leer el flujo de trabajo guardado.',
        timeoutTitle: 'Espera del resultado (ms)',
        noDeadline: 'Sin plazo',
        timeoutExplain: 'Milisegundos de espera del resultado de este paso antes de que necesite atención. Déjalo vacío para no fijar plazo.',
        wholeNumberRequired: 'Introduce un número entero de al menos 1.',
        runNow: 'Ejecutar ahora',
        save: 'Guardar el flujo de trabajo',
        saveAutomation: 'Guardar la Automatización',
        schedule: 'Programar',
        savedRevision: ({ revision }) => `Guardado · ${revision}`,
        moveUp: 'Subir',
        moveDown: 'Bajar',
        moveIn: 'Mover al grupo de arriba',
        moveOut: 'Sacar de este grupo',
        remove: 'Eliminar',
        undo: 'Deshacer',
        redo: 'Rehacer',
        historyRestoreRequiresSetup: 'Este evento debe configurarse de nuevo. Su configuración privada guardada no puede restaurarse después de eliminarlo.',
        history: { edited: 'Editar workflow', agent: 'Cambio del agente', description: 'Editar descripción', where: 'Cambiar dónde se ejecuta', target: 'Cambiar ejecución de pasos', triggers: 'Editar disparadores', example: 'Insertar ejemplo', document: 'Editar prompt' },
        undoAction: ({ change }: { change: string }) => `Deshacer: ${change}`,
        redoAction: ({ change }: { change: string }) => `Rehacer: ${change}`,
        removedBlock: ({ block }) => `${block} eliminado`,
        rename: 'Cambiar el nombre',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Paso ${position}`,
        unnamedParallel: 'Grupo paralelo',
        unnamedLoop: 'Bucle',
        unnamedIf: 'Condición',
        branch: 'Rama',
        addBranch: 'Añadir una rama',
        ifTrue: 'Si se cumple',
        otherwise: 'Si no',
        addOtherwise: 'Añadir una rama «si no»',
        evaluator: 'Decidir si continuar',
        loopBody: 'Repetir estos pasos',
        continuation: 'Después de cada ronda',
    },

    input: {
        label: 'Entrada',
        result: 'Resultado',
        change: 'Cambiar',
        none: 'Sin entrada',
        previousResult: ({ block }) => `Resultado de ${block}`,
        workflowInput: ({ name }) => `Entrada del flujo de trabajo ${name}`,
        currentItem: 'El elemento actual',
        iteration: 'Esta ronda',
        unavailable: 'Esta fuente ya no está disponible',
        itemField: {
            value: 'Valor del elemento',
            index: 'Índice del elemento, desde 0',
            position: 'Posición del elemento, desde 1',
            count: 'Número de elementos',
        },
        iterationField: {
            index: 'Índice de la ronda, desde 0',
            position: 'Número de la ronda, desde 1',
            count: 'Número de rondas',
            stopReason: 'Motivo de la parada',
        },
        valueKindGroup: 'Origen del valor',
        inputNameGroup: 'Entrada del flujo',
        producerGroup: 'Paso de origen',
        workspaceFieldGroup: 'Campo del espacio de trabajo',
        itemFieldGroup: 'Campo del elemento',
        iterationFieldGroup: 'Campo de la ronda',
    },

    inputs: {
        title: 'Entradas del flujo de trabajo',
        addInput: 'Añadir una entrada',
        namePlaceholder: 'Nombre',
        descriptionPlaceholder: '¿Para qué sirve?',
        required: 'Obligatorio',
        optional: 'Opcional',
        defaultValue: 'Valor por defecto',
        typeString: 'Texto',
        typeNumber: 'Número',
        typeBoolean: 'Sí o no',
        typeJson: 'Datos estructurados',
        runSheetTitle: 'Ejecutar este flujo de trabajo',
        runSheetBody: 'Indica los valores que declara este flujo de trabajo y ejecútalo.',
        missingRequired: 'Este valor es obligatorio.',
        wrongType: ({ type }) => `Este valor debe ser de tipo ${type}.`,
    },

    finalOutput: {
        title: 'Resultado final',
        none: 'No se ha seleccionado ningún resultado final',
        change: 'Cambiar',
        clear: 'Quitar la selección',
        fieldPath: 'Ruta del campo',
        explain: 'El resultado final es lo que devuelve este flujo de trabajo al terminar. El orden en que se completan las cosas nunca lo cambia.',
    },

    conversation: {
        title: 'Conversación',
        sharedRun: 'La misma conversación',
        branchesShareAndTakeTurns: 'Las ramas comparten una conversación y se turnan.',
        fresh: 'Conversaciones separadas',
        fromStep: ({ block }) => `Continuar ${block}`,
        existingSession: 'Una sesión existente',
        existingSessionById: ({ sessionId }) => `Sesión ${sessionId}`,
        noExistingSessions: 'Ninguna sesión de esta máquina puede continuarse aquí.',
        chooseExistingSession: 'Elige una sesión para continuar',
        continuingKeepsAgentAndFolder: 'Al continuar se mantienen el Agente y la carpeta de esa conversación. Otro Agente u otra carpeta necesitan una conversación separada.',
        waitingForConversation: ({ block }) => `Esperando a que ${block} termine en esta conversación.`,
        branchesUseSeparate: 'Las ramas de un grupo paralelo usan conversaciones separadas.',
    },

    workspace: {
        title: 'Espacio de trabajo',
        inherit: 'Espacio de trabajo del flujo',
        projectCheckout: 'Carpeta del proyecto',
        fromStep: ({ block }) => `Continuar en el espacio de trabajo de ${block}`,
        newWorktreeOriginal: 'Nuevo worktree a partir de la carpeta original',
        newWorktreeWorkflow: 'Nuevo worktree a partir del espacio de trabajo del flujo',
        newWorktreeStep: ({ block }) => `Nuevo worktree a partir de ${block}`,
        committedOnlyNote: 'Un worktree nuevo contiene el estado confirmado de la carpeta de origen. Los cambios preparados, sin confirmar y sin seguimiento se quedan en el origen.',
        reuseNote: 'Al continuar en un espacio de trabajo, este ve sus archivos sin confirmar tal y como están.',
        sharedParallelNote: 'Las ramas que comparten un espacio de trabajo pueden escribir en él a la vez.',
        unavailable: ({ block }) => `El espacio de trabajo de ${block} no está disponible.`,
        unavailableBody: 'Restáuralo para continuar esta ejecución, o revisa una ejecución nueva que puede repetir trabajo ya terminado.',
        unavailableRestoreBody: 'Restáuralo para continuar esta ejecución con el trabajo ya terminado intacto.',
        unavailableNewRunBody: 'No se puede restaurar. Una nueva ejecución revisada empieza de cero y el trabajo ya terminado puede repetirse.',
        restore: 'Restaurar',
        inspect: 'Inspeccionar',
    },

    condition: {
        onlyWhen: 'Ejecutar solo cuando',
        always: 'Siempre',
        stopWhen: 'Parar cuando',
        ifWhen: 'Ejecutar la primera rama cuando',
        addCondition: 'Añadir una condición',
        removeCondition: 'Eliminar la condición',
        allOf: 'Todas estas',
        anyOf: 'Cualquiera de estas',
        not: 'No',
        exists: 'tiene un valor',
        operatorEq: 'es',
        operatorNeq: 'no es',
        operatorLt: 'es menor que',
        operatorLte: 'es como máximo',
        operatorGt: 'es mayor que',
        operatorGte: 'es como mínimo',
        valuePlaceholder: 'Valor',
        skippedReason: ({ block }) => `Omitido porque la condición de ${block} era falsa.`,
    },

    loop: {
        modeTitle: 'Repetir',
        modeCount: 'Un número fijo de veces',
        modeItems: 'Una vez por cada elemento',
        modeUntil: 'Hasta que un resultado diga que pare',
        modeEvaluate: 'Hasta que un Agente diga que pare',
        count: 'Número de veces',
        items: 'Lista',
        sequential: 'Elementos en secuencia',
        parallel: 'Elementos en paralelo',
        maxConcurrentItems: 'Máximo de elementos simultáneos',
        maxConcurrentBranches: 'Máximo de ramas simultáneas',
        noWorkflowLimit: 'El flujo de trabajo no fija ningún límite',
        maxIterations: 'Máximo de rondas',
        limitReached: 'Límite alcanzado',
        historyTitle: 'Evaluaciones anteriores',
        historyNone: 'Ninguna',
        historyLatest: 'La última',
        historyAll: 'Todas',
        historyExplain: 'Esto selecciona las decisiones y los comentarios guardados, no las transcripciones completas.',
        continuingConversation: 'Este evaluador mantiene su conversación anterior y añade cada ronda nueva.',
        emptyListCompletes: 'Una lista vacía termina sin ninguna ronda.',
    },

    failurePolicy: {
        title: 'Si un paso falla',
        failStop: 'Parar este grupo si algo falla',
        failStopExplain: 'Este grupo deja de iniciar trabajo y pide a las ramas activas que paren, incluidas las independientes. Los resultados y los cambios ya terminados se conservan. Esto no es una reversión.',
        collectOutcomes: 'Terminar el trabajo independiente',
        collectOutcomesExplain: 'Las ramas sanas completan toda su cadena y se recoge cada resultado. Los pasos posteriores a un fallo dentro de una rama no se ejecutan.',
    },

    runState: {
        pending: 'Esperando para empezar',
        queued: 'Esperando para empezar',
        claimed: 'Empezando',
        running: 'En ejecución',
        waiting_for_review: 'Esperando tu revisión',
        succeeded: 'Completado',
        failed: 'Ha fallado',
        cancel_requested: 'Parando',
        cancelled: 'Parado',
        pause_requested: 'Pausando',
        paused: 'En pausa',
        interrupted: 'Interrumpido',
        expired: 'Caducado antes de empezar',
        dispatch_failed: 'No se ha podido empezar',
        skipped: 'Omitido',
        missed: 'Perdido',
        outcome_uncertain: 'Resultado incierto',
        completed: 'Completado',
        completed_with_failures: 'Completado con fallos',
    },

    invocationState: {
        pending: 'Esperando',
        waiting_for_capacity: 'Esperando capacidad',
        admitting: 'Iniciando',
        running: 'En ejecución',
        waiting_for_approval: 'Esperando aprobación',
        waiting_for_review: 'Esperando tu revisión',
        needs_attention: 'Te necesita',
        completed: 'Completado',
        failed: 'Ha fallado',
        skipped: 'Omitido',
        cancel_requested: 'Parando',
        cancelled: 'Parado',
        outcome_uncertain: 'Resultado incierto',
        superseded: 'Reemplazado por un intento posterior',
    },

    run: {
        title: 'Ejecución',
        frozenVersion: "Esta ejecución usa la versión con la que empezó. Los cambios solo afectan a futuras ejecuciones.",
        selectOccurrence: 'Elige un paso',
        openReview: 'Revisar resultado',
        open: 'Abrir ejecución',
        openExact: ({ title }) => `Abrir la ejecución ${title}`,
        openExecution: 'Abrir la ejecución en segundo plano',
        loadMore: 'Cargar pasos anteriores',
        origin: {
            direct: 'Iniciada directamente',
            automation: 'Programada',
            fromSession: 'Desde una sesión',
        },
        needsYou: 'Te necesita',
        needsYouLoadedCount: 'cargados',
        review: 'Revisar',
        stop: 'Parar',
        stopAgain: 'Detener de nuevo',
        stopping: 'Parando…',
        stopRequested: ({ machine }) => `Parada solicitada. Esperando la confirmación de ${machine}.`,
        evidenceStale: 'Mostrando los últimos detalles conocidos. Happier no pudo confirmar que sean actuales.',
        pauseAtBoundary: 'Pausar en el siguiente límite',
        pausePending: 'Terminando el trabajo actual y luego pausando.',
        paused: 'En pausa tras el último límite completado.',
        resume: 'Reanudar',
        runAgain: 'Volver a ejecutar el flujo de trabajo',
        retryStep: 'Reintentar el paso',
        attempt: ({ attempt }) => `Intento ${attempt}`,
        untitled: 'Ejecución del flujo',
        openResult: 'Abrir el resultado',
        inspectSteps: 'Inspeccionar los pasos',
        seeFailures: 'Ver los fallos',
        saveAsWorkflow: 'Guardar como flujo de trabajo',
        saveAsNewWorkflow: 'Guardar como nuevo flujo de trabajo',
        showCurrentWork: 'Mostrar el trabajo actual',
        editWorkflow: 'Editar flujo de trabajo',
        openWorkflow: 'Abrir flujo de trabajo',
        deleteHistory: 'Eliminar el historial de ejecuciones',
        deleteHistoryConfirm: 'Se eliminan las entradas y los resultados. Los espacios de trabajo, las conversaciones, los flujos de trabajo guardados y las Automatizaciones se conservan.',
        technicalDetails: 'Detalles técnicos',
        technical: {
            runId: 'ID de ejecución',
            invocationId: 'ID del paso',
            machine: 'Máquina',
            machineId: 'ID de la máquina',
            revision: 'Revisión',
        },
        usageUnavailable: 'Uso no disponible',
        startedAt: ({ time }: { time: string }) => `Iniciado ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Abrir conversación',
        openChildRun: 'Abrir su ejecución',
        openStepDetails: 'Abrir detalles',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} espera tu revisión`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} te está esperando`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} espera tu revisión.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} te está esperando.`,
        reviewing: 'Revisando',
        notStarted: 'Sin iniciar',
        machineUnavailable: ({ machine }) => `Esta ejecución ha perdido el contacto con ${machine}.`,
        machineUnavailableBody: 'Las opciones para reanudar aparecerán cuando se conozca el estado actual.',
        completedCount: ({ count }) => `${count} ${count === 1 ? 'paso completado' : 'pasos completados'}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Completado con fallos. ${completed} ${completed === 1 ? 'completado' : 'completados'}; ${failed} no ${failed === 1 ? 'pudo' : 'pudieron'} terminar.`,
        approvalWanted: ({ block }) => `${block} quiere ejecutar un comando.`,
        approvalWantedBody: 'Revísalo para continuar.',
        capacityOccupied: 'Todas las plazas definidas en el flujo de trabajo están ocupadas.',
        openSourceSession: 'Abrir la sesión de la que viene',
        observedActivity: 'Actividad observada',
        observedActivityBody: 'Happier puede ver las fases y los agentes de este agente, pero no se inició como un flujo de trabajo gestionado, así que no se puede editar, guardar ni volver a ejecutar.',
    },

    recovery: {
        title: 'Revisar la recuperación',
        reattach: 'Volver a conectar',
        reattachExplain: 'Observa el trabajo que ya está en marcha. No inicia nada nuevo.',
        resumeSameConversation: 'Reanudar',
        resumeSameConversationExplain: ({ block }) => `${block} puede continuar en la misma conversación.`,
        freshAgent: 'Continuar con un Agente nuevo',
        freshAgentExplain: 'Esta conversación no se puede continuar. El espacio de trabajo está disponible para un Agente nuevo.',
        uncertainEffects: ({ block }) => `${block} se detuvo antes de informar. Puede que ya haya cambiado el espacio de trabajo.`,
        acknowledgeEffects: 'Entiendo que los cambios anteriores pueden haber ocurrido ya',
        waitingForStop: 'Esperando la parada o la confirmación',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'paso relacionado aún no ha' : 'pasos relacionados aún no han'} comenzado`,
        startReviewedRun: 'Iniciar una ejecución nueva revisada',
        editContinuation: 'Revisar o editar la continuación',
        continuationPlaceholder: 'Añade lo que este paso debe hacer de otra forma',
        useReplacementInput: 'Reemplazar la entrada del paso',
        repeatedEffectWarning: 'El trabajo ya terminado puede repetirse. La ejecución original conserva su historial.',
    },

    unavailable: {
        title: 'Los flujos de trabajo no están disponibles',
        body: 'Los flujos de trabajo no están disponibles en este servidor, así que aquí no se puede crear ni ejecutar ninguno.',
        conversion: 'Estos cambios necesitan el formato de flujo de trabajo, y los flujos de trabajo no están disponibles en este servidor. Mantén esta automatización en un solo prompt o inténtalo de nuevo cuando estén disponibles.',
        savedAutomation: 'Esta automatización se ejecuta como flujo de trabajo. Sus pasos guardados no cambian; aún puedes editar su nombre, su descripción y sus desencadenantes.',
    },
    conversion: {
        title: 'Estos cambios necesitan el formato de flujo de trabajo',
        automationTarget: 'Flujo de trabajo',
        body: 'Esta automatización sigue ejecutando un solo prompt en su destino guardado. Al convertirla se conservan tus cambios y las próximas ejecuciones funcionarán como flujo de trabajo en una máquina concreta. Las ejecuciones anteriores no cambian.',
        action: 'Convertir en flujo de trabajo',
        machineRequired: 'Elige la máquina y la carpeta del proyecto para las próximas ejecuciones.',
    },
    save: {
        conflictTitle: 'Se ha guardado una versión más reciente',
        conflictBody: 'Tus cambios siguen aquí.',
        compare: 'Comparar',
        saveAsCopy: 'Guardar como copia',
        failedTitle: 'No se ha podido guardar',
        failedBody: 'Tu trabajo local sigue aquí.',
        deleteTitle: '¿Eliminar este flujo de trabajo?',
        deleteBody: 'Las Automatizaciones y las ejecuciones existentes no se ven afectadas y siguen funcionando.',
        unsupportedAttachment: 'Adjunta los archivos mediante una referencia duradera antes de guardar este flujo de trabajo.',
        nameRequired: 'Ponle un nombre a este flujo de trabajo antes de guardarlo.',
        runsCurrentDraft: 'Esta ejecución usa el flujo de trabajo tal y como está en pantalla. No lo guarda.',
    },

    interchange: {
        importTitle: 'Importar un flujo de trabajo',
        importBody: 'Al importar se abre un borrador sin guardar para que lo revises. No ejecuta ni programa nada.',
        importIssuesTitle: 'Revisar este flujo de trabajo',
        importIssuesBody: 'Algunos ajustes necesitan tu atención antes de poder usar este flujo de trabajo.',
        openRepairDraft: 'Abrir borrador para reparar',
        importFailedTitle: 'No se ha podido leer ese archivo',
        importFailedInvalidJson: 'Ese archivo no es JSON válido.',
        importFailedUnsupportedVersion: 'Ese archivo usa una versión de flujo de trabajo que esta app no admite.',
        importFailedInvalidDocument: 'Ese archivo no es un flujo de trabajo de Happier.',
        exportPrivacyNote: 'El archivo exportado contiene prompts y ajustes. Nunca contiene credenciales ni resultados de ejecuciones.',
    },

    issue: {
        invalid_version: 'Este flujo de trabajo usa una versión no admitida.',
        unknown_field: 'Este bloque tiene un ajuste que este flujo de trabajo no admite.',
        invalid_id: 'Este bloque necesita un identificador válido.',
        duplicate_id: 'Dos bloques comparten el mismo identificador.',
        missing_reference: 'Esta entrada apunta a un bloque que ya no existe.',
        invalid_reference_scope: 'Esta entrada apunta a un bloque que no termina antes.',
        invalid_input: 'Este valor no es válido.',
        missing_required_input: 'Falta un valor obligatorio.',
        invalid_result_contract: 'Los ajustes de resultado de este paso no son válidos.',
        invalid_condition: 'Esta condición no se puede comparar.',
        invalid_repetition: 'Este bucle no puede repetirse con esta configuración.',
        invalid_max_concurrent: 'La concurrencia máxima necesita un número entero de al menos 1 y solo se aplica al trabajo en paralelo.',
        unsupported_persisted_attachment: 'Los archivos adjuntos necesitan una referencia duradera antes de guardar.',
        conversation_workspace_mismatch: 'Esta conversación y este espacio de trabajo no pueden continuar juntos.',
        target_unavailable: 'Elige un Agente para este flujo de trabajo antes de ejecutarlo.',
    },

    problem: {
        title: 'Eso no ha funcionado',
        waitingTitle: 'Todavía no es posible',
        subtreeDenied: 'Un agente solo puede iniciar trabajo en su propia sesión o en sesiones que dirige.',
        roleTargetUnavailable: 'Este rol no se puede usar aquí.',
        roleRunsAsMismatch: 'La forma de ejecutar este rol no es compatible con este paso. Elige otro rol o cambia cómo se ejecuta el paso.',
        policyDeniedField: 'Los ajustes de tu agente no permiten el ajuste solicitado para trabajo que inicia un agente.',
        permissionExceedsCeiling: 'Esto necesita más permisos de los que tiene el agente que lo inició.',
        workDepthExceeded: 'Esto superaría tu límite de delegación. Hazlo en esta sesión o aumenta el límite en Ajustes › Delegación.',
        definitionExceedsAuthority: 'El agente no puede guardar un flujo de trabajo que pueda hacer más de lo que el propio agente puede iniciar.',
        sourceUnavailable: 'Este flujo de trabajo no está disponible, por lo que sus disparadores no pueden ejecutarse.',
        legacyConversionUnsupported: 'Esta automatización todavía no se puede cambiar aquí. Sigue ejecutándose como está.',
        nativeGoalOwner: 'El agente ya continúa trabajando hacia los objetivos por su cuenta en esta sesión.',
        sessionAlreadyStarted: 'Esta sesión ya ha comenzado. Los disparadores de inicio de sesión solo se pueden añadir al crear una sesión.',
        generic: 'Happier no ha podido completar esa petición del flujo de trabajo. Tu trabajo no se ve afectado.',
        needsRepair: 'Este flujo de trabajo tiene ajustes que hay que arreglar antes de poder ejecutarlo.',
        targetUnavailable: 'La máquina o el agente que necesita este flujo de trabajo no está disponible ahora mismo.',
        notFound: 'Esta ejecución ya no existe.',
        accessDenied: 'No tienes acceso a esta ejecución.',
        conflict: 'Esto ha cambiado en otro sitio. Actualiza para ver la versión actual; tu trabajo local se conserva.',
        inputTooLarge: 'Esa entrada es demasiado grande para enviarla. No se ha cambiado nada.',
        unresolvedOutcome: 'Happier todavía no puede confirmar que el trabajo anterior se detuvo, así que no se puede reemplazar.',
        interactionCapacity: 'Esta conversación tiene demasiado en espera para aceptar más ahora mismo.',
        conversationUnavailable: 'Esa conversación no se puede continuar.',
        workspaceRestore: 'No se ha podido restaurar el espacio de trabajo. No se ha cambiado nada.',
        waitSelfDependency: 'Esto dejaría el flujo de trabajo esperando a la conversación que lo inició.',
        updateRequired: 'La máquina que lo ejecuta necesita una versión más reciente de Happier para aceptar este paso.',
        ineligible: 'Esta ejecución ha avanzado, así que eso ya no es posible.',
        custodyPending: 'Happier sigue esperando la confirmación de la máquina.',
        runFinished: 'Esta ejecución ha terminado.',
        checkpointUnavailable: 'No hay ningún punto guardado desde el que reanudar.',
        recoveryEvidenceRequired: 'Abre esta ejecución para ver sus opciones de recuperación.',
        executionNotStarted: 'Todavía no ha empezado ningún paso.',
        custodySettled: 'Esta ejecución ya está cerrada.',
        unavailableHere: 'Esto no está disponible ahora mismo.',
    },

    a11y: {
        blockList: 'Bloques del flujo de trabajo',
        stepContext: ({ block, position, total }) => `${block}, paso ${position} de ${total}`,
        groupContext: ({ group, block }) => `${block}, dentro de ${group}`,
        inherited: 'usa el ajuste del flujo de trabajo',
        overridden: 'definido para este paso',
        inserted: ({ block, position, total }) =>
            `${block} añadido en la posición ${position} de ${total}`,
        removed: ({ block, total }) =>
            `${block} eliminado. ${total === 1 ? 'Queda 1 bloque' : `Quedan ${total} bloques`}`,
        reordered: ({ block, position, total }) =>
            `${block} movido a la posición ${position} de ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count === 1 ? 'paso te necesita' : 'pasos te necesitan'}`,
        needsYouLoaded: 'cargados',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count === 1 ? 'paso te necesita' : 'pasos te necesitan'}`,
        selectedRowUpdated: ({ block }) => `${block} actualizado`,
        progress: ({ count }) =>
            `${count} ${count === 1 ? 'paso actualizado' : 'pasos actualizados'}`,
        progressLoaded: ({ count }) =>
            `${count} ${count === 1 ? 'paso actualizado' : 'pasos actualizados'} hasta ahora`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count === 1 ? 'paso actualizado' : 'pasos actualizados'}; ${attention} ${attention === 1 ? 'te necesita' : 'te necesitan'}`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Editar el paso',
        editBlock: 'Editar el bloque',
        commandRefused: ({ reason }) => `Todavía no es posible. ${reason}`,
    },
});

const workflowTranslations = { es } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "es"> = { es: { workspaceBar: { tabsLabel: 'Pestañas abiertas', tabMenuLabel: 'Opciones de pestaña', pinTab: 'Fijar pestaña', unpinTab: 'Desfijar pestaña', splitRight: 'Dividir a la derecha', splitDown: 'Dividir hacia abajo', maximizePane: 'Maximizar panel', restorePane: 'Restaurar panel', closeTab: 'Cerrar pestaña', closeOtherTabs: 'Cerrar las demás pestañas', closeTabsToRight: 'Cerrar pestañas a la derecha', moreTabs: ({ count }) => (count === 1 ? '1 pestaña más' : `${count} pestañas más`), searchTabs: 'Buscar pestañas', splitPane: 'Dividir el panel activo', openInNewTab: 'Abrir en una pestaña nueva', openToRight: 'Abrir a la derecha', openBelow: 'Abrir debajo', newTab: 'Pestaña nueva' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { es: {
        diagnostics: { title: 'Diagnóstico', relationshipId: 'ID de relación', controllerMachineId: 'ID del equipo controlador', alphaMachineId: 'ID del equipo de origen', betaMachineId: 'ID del equipo de destino', alphaRoot: 'Carpeta de origen actual', betaRoot: 'Carpeta de destino actual', engineMode: 'Modo del motor', engineState: 'Estado del motor', errorCode: 'Código de error' },
        error: { updateRequired: 'Actualiza Happier en el equipo de origen antes de volver a intentar esta transferencia del espacio de trabajo. Las demás acciones de sesiones y equipos siguen disponibles.' },
        resolve: { title: '¿Resolver el conflicto del espacio de trabajo?', body: ({ path, side }) => `¿Conservar la versión «${side}» de la carpeta ${path}? La otra carpeta y todo lo que exista solo en ella se eliminarán después de verificar su estado actual.`, unverifiedFile: 'No se puede eliminar de forma segura una versión sin una huella actual del archivo. Actualiza el conflicto e inténtalo de nuevo.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "es">;

const workspaceSyncSetAttentionTranslations = { es: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'enlace tiene' : 'enlaces tienen'} conflictos`, unavailableLinks: ({ count }) => `Revisa el estado de ${count} ${count === 1 ? 'enlace' : 'enlaces'}` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "es">;

const workspaceSyncAddMachineTranslations = { es: { availableOn: 'Disponible en', addMachine: { replica: 'Réplica', exactReplica: 'Réplica exacta', editableCopy: 'Copia editable', editableCopyHint: 'Los cambios en equipos vinculados pueden ser visibles para los agentes de los demás. Las versiones en conflicto requieren revisión. Usa árboles de trabajo separados cuando necesites aislamiento.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "es">;

const workspaceSyncReviewOutcomeTranslations = { es: { keepBoth: 'Conservar ambas versiones', preserveAt: ({ path }) => `Conservar otra versión en ${path}`, notReviewed: 'Sin revisar; no se cambiará aquí', confirmScope: 'Solo se cambiarán los espacios de trabajo revisados que aparecen en la lista. Los no disponibles permanecerán intactos.', preserved: 'Conservado', alreadyPresent: 'Ya existe', notStarted: 'No iniciado', askAgent: 'Preguntar a un agente', askAgentPrompt: ({ path, versions }) => `Ayúdame a revisar las versiones en conflicto de ${path} en estos espacios de trabajo vinculados:\n${versions}\nInspecciona los archivos actuales y sugiere una solución segura. No cambies ni resuelvas el conflicto sin mi aprobación.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "es">;

const workspaceSyncCoverageIncompleteTranslations = { es: 'Algunos enlaces o extremos no se han revisado. Los conflictos cargados siguen visibles; solo se pueden resolver las versiones disponibles que se hayan revisado expresamente.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "es">;

const workspaceSyncReviewLifecycleTranslations = { es: { requestingApproval: 'Solicitando aprobación…', applying: 'Aplicando los cambios revisados…', propagationExpected: ({ names }) => `Se espera la propagación a ${names}`, propagationUnverified: ({ names }) => `Aún no se puede verificar la propagación a ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "es">;

const workspaceSyncLocalOnlyTranslations = { es: 'Esta ubicación alternativa queda solo en su espacio de trabajo' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "es">;

const workspaceSyncKeepAlternativesTranslations = { es: 'Conservar alternativas' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "es">;

const workspaceSyncReviewDecisionTranslations = { es: { chooseTargets: 'Elige los espacios de trabajo que se reemplazarán', notSelected: 'No seleccionado para esta resolución', inspectCurrentVersions: 'Inspeccionar versiones actuales' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "es">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "es"> = { es: {
        executable: 'Ejecutable', regular: 'No ejecutable', applied: 'Aplicado', appliedPaused: 'Aplicado; sincronización pausada', changed: 'Cambió antes de aplicarse', offline: 'Sin conexión; no aplicado', cancelled: 'Cancelado', unknown: 'Resultado desconocido; revisa este extremo', failed: 'Falló; no aplicado', recoveryNeeded: 'Se requiere recuperación en esta ubicación', inspectionUnavailable: 'No se pudieron revisar las versiones actuales. Actualiza cuando el equipo controlador esté disponible.', coverageIncomplete: 'Quedan enlaces o extremos sin revisar. Los conflictos cargados siguen visibles, pero aún no se pueden resolver.', versions: 'Versiones', comparison: 'Comparar versiones seleccionadas', linkDecisions: 'Selección por enlace', result: 'Resultado', confirmTitle: '¿Usar esta versión?', confirmBody: ({ path, source, count }) => `¿Usar la versión de ${source} de ${path} en otros ${count} espacios de trabajo? Happier verificará todas las versiones antes de cambiar nada.`, useVersion: 'Usar versión', useNamedVersion: ({ name }) => `Usar ${name}`, compareNamedVersion: ({ name }) => `Comparar ${name}`, linkCount: ({ count }) => `${count} enlaces notificaron esta ruta`, moreOnLink: ({ name }) => `Cargar más de ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { es: { selectionIncluded: 'Incluido por este enlace', selectionExcluded: 'Excluido por este enlace', selectionUnknown: 'Selección desconocida', reasonRepositoryMetadata: 'Metadatos del repositorio', reasonSubmodule: 'Submódulo Git', reasonConfiguredRule: 'Regla configurada', reasonGitIgnore: 'Regla Git ignore', reasonEndpointUnavailable: 'Extremo no disponible', reasonSelectionUnavailable: 'Evaluador de selección no disponible', configuredInclude: ({ pattern }) => `Patrón de inclusión: ${pattern}`, configuredExclude: ({ pattern }) => `Patrón de exclusión: ${pattern}`, completedLinks: ({ count }) => `${count} enlaces completados antes del bloqueo` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "es">;

const es = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["es"],
    review: workspaceSyncReviewTranslations["es"],
    selection: workspaceSyncReviewSelectionTranslations["es"],
    outcome: workspaceSyncReviewOutcomeTranslations["es"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["es"],
    decision: workspaceSyncReviewDecisionTranslations["es"],
    coverage: workspaceSyncCoverageIncompleteTranslations["es"],
    localOnly: workspaceSyncLocalOnlyTranslations["es"],
    alternatives: workspaceSyncKeepAlternativesTranslations["es"],
    addMachine: workspaceSyncAddMachineTranslations["es"],
    attention: workspaceSyncSetAttentionTranslations["es"],
}, {
    title: 'Sincronización del espacio de trabajo',
    footer: 'El estado procede del equipo que gestiona esta relación. Los cambios aparecen solo después de que ese equipo los confirme.',
    legacyRecovery: {
        title: 'Datos de sincronización retirados',
        footer: 'Happier solo inspecciona y pone en cuarentena estos datos retirados. Nunca los elimina desde la aplicación.',
        checking: 'Comprobando equipos…',
        inspectFailed: 'No se pudieron comprobar algunos equipos. Las carpetas de cuarentena ya encontradas seguirán visibles; vuelve a intentarlo cuando esos equipos estén disponibles.',
        outdatedTitle: ({ machine }) => `${machine} usa una versión antigua de Happier`,
        outdatedBody: 'Esa versión no puede buscar datos de sincronización retirados. Actualiza Happier en ese equipo y vuelve a inspeccionar aquí.',
        explanation: 'Este equipo contiene datos del sistema de replicación retirado. Happier movió los datos reconocidos a una cuarentena privada y desactivó la sincronización para impedir que se ejecute el sistema antiguo.',
        quarantinePath: 'Carpeta de cuarentena',
        openFolder: 'Abrir carpeta',
        offlineTitle: 'Eliminar mientras Happier está sin conexión',
        offlineSteps: ({ path }) => `1. Detén todos los servicios en segundo plano de Happier que puedan usar estos datos.\n2. Elimina exactamente esta carpeta con tu sistema operativo: ${path}\n3. Reinicia los servicios y vuelve a inspeccionar aquí.`,
        unknown: ({ path, reason }) => `Happier no pudo clasificar de forma segura el estado antiguo en ${path} (${reason}). La sincronización sigue desactivada. Inspecciona esta ruta manualmente; no la elimines desde la aplicación.`,
        reinspect: 'Volver a inspeccionar',
    },
    none: 'No hay ninguna relación de sincronización',
    conflictsTitle: 'Conflictos del espacio de trabajo',
    openConflicts: ({ count }) => `Revisar la sincronización en ${count} enlaces`,
    noConflicts: 'No hay conflictos',
    previewUnavailable: 'El equipo controlador no pudo proporcionar una vista previa segura. Actualiza el conflicto antes de volver a intentarlo.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'conflicto adicional no se muestra' : 'conflictos adicionales no se muestran'}`,
    unknownMode: 'Modo de sincronización no compatible',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'conflicto' : 'conflictos'}`,
    conflictKind: { file: 'Archivo', directory: 'Carpeta', symlink: 'Enlace simbólico', missing: 'Ausente', unsupported: 'Entrada no compatible' },
    mode: { copyOnce: 'Copiar una vez', keepSynced: 'Mantener actualizado — recomendado', mirrorExactly: 'Reflejar exactamente', keepBothInSync: 'Mantener ambos sincronizados' },
    state: { loading: 'Comprobando estado…', starting: 'Preparando', watching: 'Vigilando', flushing: 'Sincronizando', paused: 'En pausa', peerOffline: 'Sin conexión', conflicted: 'Conflictos', controllerUnavailable: 'Necesita atención', engineUnavailable: 'Componente no disponible', error: 'Necesita atención', stopped: 'Detenido', working: 'Procesando…' },
    lastChecked: ({ at }) => `Última comprobación: ${at}`,
    endpoint: { source: ({ label }) => `Origen · ${label}`, destination: ({ label }) => `Destino · ${label}`, synced: ({ label }) => `Extremo sincronizado · ${label}` },
    error: {
        componentUnavailable: 'La sincronización del espacio de trabajo no está disponible en esta compilación. Instala el componente necesario y vuelve a intentarlo.',
        machineOffline: 'El equipo de destino no está disponible. Vuelve a conectarlo e inténtalo de nuevo.',
        destinationNeedsPreparation: 'La carpeta de destino debe prepararse antes de iniciar la sincronización.',
        gitPreparationFailed: 'Happier no pudo preparar este espacio de trabajo de Git. Revisa el destino y vuelve a intentarlo.',
        authorizationExpired: 'La autorización del espacio de trabajo ha caducado. Inicia de nuevo la operación.',
        rootNoLongerAuthorized: 'La carpeta del espacio de trabajo cambió y ya no está autorizada. Revisa la relación antes de volver a intentarlo.',
        conflictNeedsAttention: 'Este conflicto cambió. Actualízalo antes de elegir una versión.',
        needsAttention: 'La sincronización del espacio de trabajo necesita atención. Actualiza su estado y vuelve a intentarlo.',
    },
    start: { blocked: {
        targetMachine: 'Elige un equipo de destino para continuar.',
        targetMachineOffline: 'Ese equipo no está disponible ahora. Vuelve a conectarlo e inténtalo de nuevo.',
        relationshipUnavailable: 'Esta relación de sincronización ya no incluye estas dos carpetas. Elige otra opción para el espacio de trabajo.',
        sourceFolder: 'La carpeta de esta sesión no se puede sincronizar de forma segura. Elige «No mover archivos» para transferir solo la sesión.',
        destinationFolder: 'Elige una carpeta de destino que se pueda sincronizar de forma segura.',
        workspaceOptions: 'Revisa las opciones del espacio de trabajo antes de comenzar.',
    } },
    engine: { checking: 'Comprobando la sincronización en este equipo…' },
    actions: { refresh: 'Actualizar estado', syncNow: 'Sincronizar ahora', more: 'Acciones de sincronización', pause: 'Pausar', resume: 'Reanudar', terminate: 'Detener sincronización', openOnMachine: ({ machine }) => `Abrir en ${machine}`, openFolder: ({ label }) => `Abrir la carpeta ${label}`, keepLocal: 'Conservar la versión local', keepRemote: 'Conservar la versión remota', keepNamed: ({ side }) => `Conservar la versión de ${side}` },
    terminate: { title: '¿Eliminar la sincronización del espacio de trabajo?', body: 'La sincronización se detendrá y se eliminará su relación. Los archivos permanecerán en ambos espacios de trabajo.' },
    resolve: {
        changedTitle: 'El conflicto cambió',
        changedBody: 'Este conflicto cambió desde que se abrió. La lista se ha actualizado. Revisa las versiones más recientes antes de volver a elegir.',
        consequence: 'La otra versión solo se eliminará después de que Happier compruebe que el archivo no ha cambiado.',
        unsupported: 'Este conflicto contiene una entrada del sistema de archivos no compatible y no se puede resolver en Happier. Elimínala o sustitúyela en el equipo afectado y después actualiza.',
        keepHint: ({ side }) => `Conservar la versión de ${side} y eliminar la otra versión verificada.`,
    },
    fileState: { text: 'Vista previa de texto', binary: 'Archivo binario — vista previa no disponible', tooLarge: 'El archivo es demasiado grande para mostrar una vista previa', missing: 'Falta el archivo', changed: 'El archivo cambió desde que se mostró este conflicto' },
});

const workspaceSyncTranslations = { es } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "es">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { es: en };

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
