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

const accountDisplayTranslations = { pt: { unnamed: 'Conta sem nome', yours: 'Sua conta', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "pt">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const pt: Copy = {
    recoverAutomationTemplates: 'Recuperar gatilhos anteriores',
    recoverAutomationTemplatesDescription: 'Use as chaves deste dispositivo para recuperar gatilhos anteriores. Elas permanecem enquanto sessões criptografadas ou gatilhos bloqueados precisarem delas.',
    recoverAutomationTemplatesAction: 'Recuperar',
    recoverAutomationTemplatesComplete: 'Gatilhos recuperados. A chave antiga permanece neste dispositivo até você escolher esquecê-la.',
    recoverAutomationTemplatesRetained: 'Recuperação verificada. Alguns gatilhos continuam criptografados, bloqueados ou alterados. A chave antiga permanece neste dispositivo.',
    forgetEncryptionKey: 'Esquecer a chave de criptografia antiga',
    forgetEncryptionKeyDescription: 'As sessões criptografadas antigas ficam bloqueadas neste dispositivo.',
    forgetEncryptionKeyAction: 'Esquecer',
    forgetEncryptionKeyConfirm: 'Esquecer a chave de criptografia antiga?',
    forgetEncryptionKeyWarning: ({ items }) => `As sessões criptografadas antigas ficam bloqueadas neste dispositivo. Este histórico criptografado pode ficar inacessível:\n\n${items}\n\nA lista reflete o histórico atual. Sessões criptografadas criadas depois em outro dispositivo também ficam bloqueadas. Restaure a chave antiga para desbloqueá-las. Nada é excluído da sua conta.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sessão: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Gatilho: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Histórico de execução: ${id}`,
    forgetEncryptionKeyEmpty: 'Nenhum histórico criptografado encontrado.',
    forgetEncryptionKeyComplete: 'A chave antiga foi esquecida neste dispositivo.',
    forgetEncryptionKeyFailed: 'Não foi possível esquecer a chave. Reconecte e tente novamente; o histórico criptografado precisa ser listado primeiro.',
};

const accountEncryptionRecoveryTranslations = { pt } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { pt: {
        pageTitle: 'Conta e Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `Não vinculado a ${service}`,
        serviceUnavailable: ({ service }) => `Não é possível conectar a ${service}`,
        signedInToThisHome: 'Sessão iniciada neste Home',
        checkingSignIn: 'Verificando o login…',
        signInStatusUnavailable: 'Status de login indisponível',
        machinesOnline: ({ online, total }) => `${online} de ${total} ${total === 1 ? 'máquina' : 'máquinas'} online`,
        noMachines: 'Ainda não há máquinas',
        connectedNoMachinesOnline: 'Conectado · nenhuma máquina online',
        cantReach: 'Sem conexão',
        signedOut: 'Sessão encerrada',
        signIn: 'Entrar',
        link: 'Vincular',
        linkSubtitle: 'Encontre seus Homes em todos os dispositivos',
        manageHomes: 'Gerenciar Homes',
        connectionDetails: 'Detalhes da conexão',
        allHomes: 'Todos os Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · uma só lista`,
        addHome: 'Adicionar um Home…',
        addDevice: 'Adicionar um dispositivo',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "pt">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const pt = {
    title: 'Faça login para encontrar seus Homes',
    cancelNote: 'Cancelar não encerra a sessão nos seus Homes existentes.', focusedHomePreserved: 'O Home em foco não será alterado.',
    stages: { signingIn: 'Fazendo login', findingHomes: 'Procurando seus Homes', waitingApproval: 'Aguardando aprovação do Home' },
    errors: { provider: { title: 'O provedor não concluiu o login', body: 'Faça login novamente.' }, expired: { title: 'Esta solicitação de login expirou', body: 'Faça login novamente.' }, identityChanged: { title: 'A identidade do serviço de login mudou', body: 'Confirme que este é o serviço de login que você queria usar antes de se conectar novamente.' }, unavailable: { title: 'O serviço de login está indisponível', body: 'Verifique o serviço e tente novamente. Seus Homes existentes não serão alterados.' }, exchange: { title: 'Não foi possível concluir o login', body: 'Nenhuma credencial do serviço de login foi salva. Faça login novamente.' }, storage: { title: 'Não foi possível salvar o login', body: 'As credenciais dos seus Homes existentes não serão alteradas. Faça login novamente.' }, homeLink: { title: 'Login feito, mas não foi possível vincular este Home', body: 'Seu login está salvo. Tente vincular este Home novamente.' }, directoryRefresh: { title: 'Login feito, mas não foi possível atualizar sua lista de Homes', body: 'A conexão com o serviço de login está pronta. Tente atualizar sua lista de Homes novamente.' }, homeEnrollment: { title: 'Login feito, mas seu Home pessoal não foi adicionado', body: 'Seu login está salvo. Tente adicionar o Home novamente.' }, invalid: { title: 'Esta solicitação de login não é mais válida', body: 'Faça login novamente.' }, accountDisabled: { title: 'Esta conta está desativada', body: 'Entre em contato com quem administra seu serviço de login. Seus Homes existentes não serão alterados.' } },
    actions: { startAgain: 'Começar de novo', openHome: ({ homeName }: { homeName: string }) => `Abrir ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} está conectado`, body: 'Seu login está salvo e este Home está pronto para uso.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} ainda não está vinculado a esta conta`, signInAction: ({ homeName }: { homeName: string }) => `Fazer login em ${homeName}`, body: ({ homeName }: { homeName: string }) => `Faça login diretamente em ${homeName}, ou escaneie o código QR dele ou cole o link do Home.`, scanBody: ({ homeName }: { homeName: string }) => `Escaneie o código QR de ${homeName} ou cole o link do Home para conectá-lo.` },
    noHomes: { body: 'Esta conta ainda não tem Homes. Atualize depois de adicionar um em outro lugar, ou escaneie o código QR de um Home ou cole o link do Home.' },
    approvalWait: { waitingBody: 'Aprove este login no seu outro dispositivo conectado.', cancelledTitle: 'Você parou de aguardar a aprovação', cancelledBody: 'Seu login continua salvo e seus Homes existentes não mudam.' },
} as const;

const accountServiceOAuthTranslations = { pt } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { pt: {
        requestedByAgent: 'Ação solicitada pelo agente da sessão',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Sessão de destino: ${sessionId}`,
        oneShotConsequence: 'A aprovação vale apenas para este pedido. Não concede permissões futuras de Action nem permissões nativas.',
        homeUnavailable: 'Esta aprovação pertence a um Home indisponível neste dispositivo. Volte a ligar esse Home para decidir.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "pt">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "pt": {
        textInFiles: "Texto nos arquivos",
        everything: "Tudo",
        refineSearch: "Refine sua pesquisa",
        partial: "Não foi possível pesquisar alguns arquivos. Os resultados estão incompletos.",
        updateRequired: "Atualize o Happier nesta máquina para pesquisar texto nos arquivos.",
        invalidPattern: "A expressão regular é inválida. Edite o padrão e tente novamente.",
        unavailable: "A pesquisa de texto está indisponível. Verifique a conexão da máquina e tente novamente.",
        placeholder: "Pesquisar arquivos, mensagens, commits, sessões, configurações e ações",
        matchCase: "Diferenciar maiúsculas",
        regex: "Expressão regular",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "pt": {
        "partialHistory": "Enviados antes abrange apenas sessões conhecidas.",
        "loadedHistory": "Enviados antes mostra apenas mensagens carregadas.",
        "open": "Abrir prompts",
        "menu": "Prompts…",
        "placeholder": "Pesquisar prompts e mensagens enviadas",
        "favorites": "Favoritos",
        "library": "Biblioteca",
        "sentBefore": "Enviadas antes",
        "builtIn": "Integrado",
        "readError": "Não foi possível ler este prompt. Tente novamente.",
        "libraryError": "Não foi possível carregar a biblioteca.",
        "partialLibrary": "Não foi possível ler alguns prompts.",
        "loadOlder": "Pesquisar mensagens anteriores",
        "stop": "Parar",
        "insert": "Inserir",
        "send": "Enviar agora",
        "addFavorite": "Adicionar aos favoritos",
        "removeFavorite": "Remover dos favoritos",
        "empty": "Salve uma mensagem como prompt para reutilizá-la aqui.",
        "applyError": "Não foi possível aplicar o prompt. Tente novamente.",
        "historyError": "Não foi possível carregar mensagens anteriores. Tente novamente.",
        "title": "Prompts",
        "clear": "Limpar",
        "favorite": "Favorito",
        "favoritesInvite": "Marque com estrela um prompt ou algo que você enviou para mantê-lo aqui.",
        "saveAsFavorite": "Salvar como prompt favorito",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Da sua mensagem de ${time} · vai para a biblioteca, com estrela`,
        "saveInPlace": ({ time }: { time: string }) => `Da sua mensagem de ${time} · vai para a biblioteca`,
        "noMatchesFor": ({ query }: { query: string }) => `Nenhum prompt ou mensagem carregada corresponde a “${query}”`,
        "previewInserts": "é inserido e depois você envia",
        "previewSent": "enviado antes",
        "previewEdited": ({ time }: { time: string }) => `Editado ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Pesquisando mensagens anteriores… ${searched} de ${total} sessões`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { pt: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.pt.textInFiles,
            find: 'Localizar',
            app_shell: 'Workspace',
            roles: 'Funções',
            launch_profiles: 'Perfis de inicialização',
            discovery: 'Descoberta de ações',
            computer: 'Controle do computador',
            artifact_access: 'Compartilhamento de artefatos',
            workflows: 'Fluxos de trabalho',
            workflow_effects: 'Webhooks e comandos',
            notifications: 'Notificações',
            machine_agent_install: 'Instalações de agentes',
            machine_agent_sign_in: 'Login de agentes',
            session_access: 'Compartilhamento de sessões',
            session_lifecycle: 'Ciclo de vida das sessões',
            inventory: 'Inventário de computadores',
            messaging: 'Mensagens',
            session_control: 'Controles de sessão',
            intent_start: 'Revisões e delegação',
            review_comments: 'Comentários de revisão',
            subagent_registry: 'Subagentes',
            execution_run_control: 'Execuções em segundo plano',
            session_targeting: 'Seleção de sessões',
            session_follow: 'Acompanhamento de sessões',
            session_transcripts: 'Transcrições de sessões',
            session_read_state: 'Status de leitura',
            session_attention: 'Atenção',
            session_board: 'Quadro de sessões',
            session_discussion: 'Discussões',
            session_permissions: 'Permissões de sessão',
            external_sessions: 'Sessões externas',
            voice_controls: 'Controles de voz',
            current_ui_context: 'Tela atual',
            companion_controls: 'Companheiro',
            memory: 'Memória',
            agent_acp_catalog: 'Agentes ACP',
            prompt_library: 'Biblioteca de prompts',
            daemon_admin: 'Administração do daemon',
            browser_control: 'Controle do navegador',
            browser_diagnostics: 'Diagnóstico do navegador',
            browser_context: 'Contexto do navegador',
            browser_automation: 'Automação do navegador',
            browser_recording: 'Gravação do navegador',
            local_services_inventory: 'Serviços locais',
            local_services_launcher: 'Inicializador de serviços',
            local_services_preview: 'Pré-visualizações de serviços',
            local_services_public_preview: 'Pré-visualizações públicas',
            local_services_actions: 'Ações de serviços',
            peer_mediation_observability: 'Diagnóstico de conexões',
            devices_simulator: 'Simuladores',
            approvals: 'Aprovações',
            plugin_dev_loop: 'Desenvolvimento de plugins',
            plugin_settings_administration: 'Configurações de plugins',
            plugin_permission_grants: 'Permissões de plugins',
            plugin_webhooks: 'Webhooks de plugins',
            account_plugin_data: 'Dados de plugins',
            account_sessions: 'Dispositivos conectados',
            account_security: 'Segurança da Conta',
            account_api_tokens: 'Tokens de API',
            identity_github_apps: 'Apps do GitHub',
            identity_providers: 'Provedores de login',
            machine_pools: 'Pools de computadores',
            ephemeral_runner: 'Executores',
            automation_events: 'Eventos de automação',
            automation_conversation: 'Conversas de automação',
            scm_git: 'Git',
            scm_pull_request: 'Solicitações de pull',
            scm_repository: 'Repositórios',
            scm_diff_summary: 'Resumos de alterações',
            home_governance: 'Administração do Home',
            teams: 'Equipes',
            saved_secret_sharing: 'Segredos compartilhados',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { pt: {
        addHome: 'Adicionar um Home',
        addHomeSubtitle: 'Inicie sessão, ligue por endereço ou use um alojado',
        addHomeDescription: 'Ligue um Home que já usa ou use um alojado para si.',
        newGroup: 'Novo grupo',
        newGroupSubtitle: 'Ver juntas as sessões de vários Homes',
        groupsTitle: 'Grupos',
        homesInUse: 'Em uso aqui',
        thisDeviceTitle: 'Este dispositivo',
        thisDeviceSubtitle: 'Como chega aos seus Homes',
        thisDeviceDescription: 'Como este dispositivo chega aos seus Homes: dispositivos em espera, a ligação que usa e o Home que executa.',
        newHomeDraft: 'Novo Home',
        homeMissingTitle: 'Este Home não está neste dispositivo',
        homeMissingDescription: 'Foi removido ou guardado noutro dispositivo.',
        homeManageTitle: 'Gerir',
        homeAdministrationSubtitle: 'Pessoas, início de sessão, alcance e dados deste Home',
        groupMissingTitle: 'Este grupo já não existe',
        groupMissingDescription: 'Foi removido. Os seus Homes não mudaram.',
        discard: 'Descartar',
        sshSignInAgent: 'O seu agente SSH neste computador',
        sshSignInKeyFile: 'Um ficheiro de chave privada neste computador',
        sshSignInPassword: 'Usada uma vez para ligar; nunca guardada',
        addMachineMenuSubtitle: 'Um computador ou um servidor',
        addMachineDescription: 'Adicione um computador ou servidor para que os agentes executem nele as suas sessões.',
        machineJoinsHome: ({ home }) => `Junta-se a ${home}`,
        pathThisComputerTitle: 'Este computador',
        pathThisComputerTask: 'Configure-o num passo',
        pathThisComputerCommand: 'Um comando no seu terminal',
        pathSshTitle: 'Um servidor por SSH',
        pathSshChip: 'Servidor SSH',
        pathSshSubtitle: 'Uma máquina de desenvolvimento, VM ou servidor na nuvem',
        pathAnotherTitle: 'Outro computador',
        pathAnotherSubtitle: 'Abra um link para a Home nesse computador',
        machinePoolPrompt: 'Quer que as sessões passem de uma máquina para outra?',
        thisComputerCommandLead: ({ home }) => `Execute isto num terminal deste computador. Instala o Happier e junta-se a ${home}; esta página nota logo que estiver pronto.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} executa os agentes para ${home}. O Happier instala um pequeno serviço em segundo plano que arranca com o computador.`,
        setUpThisComputer: 'Configurar este computador',
        desktopAppHint: 'Prefere clicar a escrever?',
        desktopAppLink: 'Instale a app para computador: configura este computador sozinha.',
        thisComputerRunningLead: ({ machine }) => `A configurar ${machine}. Pode continuar a usar o Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} está ligado a outro Home`,
        onAnotherHomeBody: ({ home }) => `O seu serviço Happier executa sessões de outro Home. Movê-lo para ${home} mantém as definições; as sessões que já lá estão ficam lá.`,
        moveToHome: ({ home }) => `Movê-lo para ${home}`,
        keepOnOtherHome: 'Deixá-lo onde está',
        sshLeadTask: ({ home }) => `Uma máquina de desenvolvimento, VM ou servidor na nuvem que já alcança por SSH. Este computador liga-se, instala o Happier e junta-se a ${home}.`,
        sshLeadCommand: ({ home }) => `Uma máquina de desenvolvimento, VM ou servidor na nuvem alcançável por SSH. Execute o comando num computador que lá chegue; instala o Happier e junta-se a ${home}.`,
        setUpHost: ({ host }) => `Configurar ${host}`,
        sshSavedNote: 'O anfitrião é guardado em Anfitriões remotos; as palavras-passe nunca.',
        sshRunningTitle: ({ host }) => `A configurar ${host}`,
        sshRunningLead: 'Corre por SSH a partir deste computador. Pode sair; a lista de máquinas mostra o progresso e avisa quando terminar.',
        anotherLead: ({ home }) => `Execute isto num terminal desse computador. Instala o Happier e junta-se a ${home}.`,
        anotherTerminalAction: 'Usar um comando de terminal em alternativa',
        machineWatching: ({ subject }) => `À espera de ${subject} em `,
        subjectThisComputer: 'este computador',
        subjectAnotherComputer: 'o computador',
        machineNotSeeingTitle: ({ subject }) => `Ainda não vê ${subject}?`,
        machineNotSeeingBody: ({ home }) => `O Happier continua à espera. Normalmente a configuração parou com um erro, a máquina não chega a ${home} ou foi configurada para outro Home.`,
        machineArrived: ({ machine }) => `${machine} está ligado`,
        machineConnectedJustNow: 'ligado agora mesmo',
        machineStartSession: ({ machine }) => `Iniciar uma sessão em ${machine}`,
        machineAddAnother: 'Adicionar outra',
        cancelSetup: 'Cancelar',
        detectedOs: 'Detetado',
        sshSuggestionsTitle: 'Da sua configuração SSH e anfitriões guardados',
        connectingToHome: ({ address }) => `A ligar a ${address}…`,
        pathThisComputerConnected: 'Ligado · ver os seus agentes',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "pt">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { pt: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const pt: typeof en = {
    titles: {
        conversation: 'Uma conversa ao lado',
    },
    descriptions: {
        conversation: ({ machine }) => `Pergunte o que quiser sem interromper esta sessão. Ela roda em ${machine} ao lado; nada volta a menos que você envie.`,
    },
    chips: {
        engineTitle: 'Quem responde',
        addReviewer: 'Adicionar revisor',
        removeReviewer: ({ name }) => `Remover ${name}`,
        scope: 'O que revisar',
        advanced: 'Avançado',
    },
    reportToSession: 'Reportar a esta sessão',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} revisões começam ao enviar` : 'Começa ao enviar',
    offline: ({ machine }) => `${machine} está offline. O agente começa lá; seu rascunho fica aqui até ela voltar.`,
    menu: {
        askSection: 'Pedir a um agente',
        secondOpinionTitle: 'Segunda opinião',
        secondOpinionSubtitle: 'Uma checagem independente antes de concluir',
        keepGoingTitle: 'Continuar até terminar…',
        keepGoingSubtitle: 'Defina uma meta no controle de meta',
        runWorkflowTitle: 'Executar um fluxo de trabalho',
        runWorkflowSubtitle: 'Da sua biblioteca ou um integrado',
        searchWorkflows: 'Buscar fluxos de trabalho…',
        yourLibrary: 'Sua biblioteca',
        noWorkflows: 'Nenhum fluxo salvo ainda',
        addTriggerTitle: 'Adicionar um gatilho…',
        addTriggerSubtitle: 'Roda aqui sempre que algo acontece',
        advancedTitle: 'Avançado…',
        advancedSubtitle: 'Vários agentes, permissões, perfil',
        builtIn: 'Integrados',
        allWorkflows: 'Todos os fluxos de trabalho…',
    },
    role: {
        replaces: ({ agent }) => `Substitui ${agent}`,
    },
    startRow: {
        subtitle: 'Rascunho · começa ao enviar',
        conversation: 'Nova conversa',
        review: 'Nova revisão',
        plan: 'Novo plano',
        delegate: 'Nova tarefa',
    },
    pane: {
        cancelRun: 'Cancelar execução',
        whenItFinishes: 'Quando terminar',
        sendToSession: ({ session }) => `Enviar para ${session}`,
        replyTo: ({ agent }) => `Responder a ${agent}…`,
        repliesGoTo: ({ session }) => `As respostas vão para este agente, não para ${session}`,
    },
};

const agentStartTranslations = { pt };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { pt: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Acesso à criptografia",
                consequence: "Concede acesso à criptografia de toda a conta. A revogação interrompe futuras autorizações de API; chaves ou dados já obtidos não podem ser recuperados.",
                enabled: "Acesso à criptografia ativado",
                bearerOnly: "Somente acesso à API",
                unknown: "Acesso à criptografia desconhecido",
                outcomeUnknown: "A criação pode ter sido concluída. Atualize a lista e revogue este token antes de criar outro deliberadamente.",
                unsupported: "Este Home ainda não oferece tokens de API criptografados. Atualize-o ou crie um token comum.",
                notReady: "Restaure o acesso à criptografia neste Home antes de criar um token criptografado.",
                stale: "A chave de criptografia da conta mudou. Restaure o acesso neste Home.",
                idConflict: "Este ID de token já existe. Revogue esse token exato antes de criar outro.",
            },
            unattended: {
                choice: "Acesso autônomo à equipe",
                consequence: "Copia para este token os métodos de autenticação atualmente verificados desta credencial para trabalho restrito da equipe. O acesso à criptografia é independente.",
                authorized: "Acesso autônomo à equipe autorizado",
                notAuthorized: "Sem acesso autônomo à equipe",
                evidenceLimit: "Esta credencial tem métodos de autenticação verificados demais para copiar. Nenhum token foi criado.",
                evidenceUnavailable: "Esta credencial conectada não tem evidência de autenticação atual para copiar. Autentique-se novamente com o método necessário; nenhum token foi criado.",
            },
            title: 'Tokens de API',
            entrySubtitle: 'Permita que scripts, servidores e apps incorporados ajam por você, apenas com o acesso que você der a eles.',
            tokens: 'Tokens de API',
            refreshing: 'Atualizando…',
            emptyTitle: 'Ainda não há tokens de API',
            emptyBody: 'Os tokens permitem que scripts e ferramentas de confiança executem as ações automatizadas que autorizar. Crie um token quando uma integração precisar de acesso à sua Conta atual.',
            created: 'Criado',
            lastUsed: 'Usado pela última vez',
            neverUsed: 'Nunca usado',
            securityTitle: 'Segurança',
            securityFooter: 'Estas ações têm efeito em toda a Conta atual.',
            status: {
                active: 'Ativo',
                expiresInMinutes: ({ count }) => `Expira em ${count} min`,
                expiresInHours: ({ count }) => `Expira em ${count} h`,
                expiresInDays: ({ count }) => `Expira em ${count} d`,
                expired: 'Expirado',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, status: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Mais ações para ${label}`,
            create: {
                button: 'Criar token',
                title: 'Criar token de API',
                subtitle: 'Dê um nome à integração e escolha quando este token expira. Seu Home pode ler solicitações e resultados da API comum; o acesso à criptografia pode proteger chamadas compatíveis do SDK.',
                submit: 'Criar token',
                label: 'Rótulo',
                labelPlaceholder: 'Automação de lançamentos',
                expiry: 'Expira',
                expiryOptions: {
                    '30d': '30 dias',
                    '90d': '90 dias',
                    '1y': '1 ano',
                    none: 'Sem expiração',
                },
                access: 'Acesso',
                accessFull: 'Acesso total',
                accessLimited: 'Limitado',
                accessLimitedDescription: 'Em seguida, escolha ações, sessões, modelos e sites.',
                accessTitle: 'Escolher acesso',
                continue: 'Continuar',
                back: 'Voltar',
                actionSettingsPrefix: 'Este token pode executar qualquer operação habilitada para API externa e SDK nas suas',
                actionSettingsLink: 'Configurações de ações.',
            },
            reveal: {
                title: 'Salve seu token de API',
                accessibilityAnnouncement: 'Copie seu token agora — ele é mostrado apenas uma vez.',
                successTitle: 'Token criado',
                shownOnce: 'Copie este token agora. Para sua segurança, o Happier não pode mostrá-lo novamente.',
                copy: 'Copiar token',
                copied: 'Copiado',
                dismissTitle: 'Sair sem confirmar?',
                dismissBody: 'Este token não será mostrado novamente. Copie-o primeiro ou confirme que você o salvou em um local seguro.',
                copyFirst: 'Manter token visível',
                savedIt: 'Eu o salvei',
            },
            revoke: {
                title: ({ label }) => `Revogar “${label}”?`,
                body: 'O acesso ao servidor e à API será interrompido na próxima verificação. Um daemon local que verificou recentemente este token de API ainda pode aceitá-lo por até um minuto. Esta ação não pode ser desfeita.',
                confirm: 'Revogar token',
            },
            revokeAll: {
                title: 'Revogar todos os tokens de API',
                subtitle: 'Desative todos os tokens de API desta Conta.',
                body: 'O acesso ao servidor e à API será interrompido na próxima verificação. Incorporações que usam estes tokens param de funcionar, e suas credenciais incorporadas são desconectadas. Daemons locais que verificaram recentemente estes tokens de API ainda podem aceitá-los por até um minuto. Esta ação não pode ser desfeita.',
                confirm: 'Revogar todos',
                railAction: 'Revogar todos os tokens de API…',
            },
            signOutEverywhere: {
                title: 'Sair de todos os lugares',
                subtitle: 'Encerre todas as sessões conectadas desta Conta.',
                body: 'Todas as sessões conectadas em navegadores e dispositivos serão encerradas. Os tokens de API continuam ativos; revogue-os separadamente nesta tela.',
                confirm: 'Sair de todos os lugares',
            },
            errors: {
                labelRequired: 'Informe um rótulo antes de criar o token.',
                accountChanged: 'Sua conta ou Home ativo mudou, então nada foi alterado. Abra novamente para continuar.',
                presentUserRequired: 'Confirme sua identidade no aviso de entrada e tente novamente.',
                offline: 'O Happier não conseguiu acessar sua Conta. Verifique a conexão e tente novamente.',
                unavailable: 'Esta ação não está disponível agora. Tente novamente em instantes.',
                copyFailed: 'Não foi possível copiar o token. Selecione-o e copie-o manualmente antes de fechar.',
                listTitle: 'Tokens de API indisponíveis',
                grantIncomplete: 'Termine de escolher o acesso antes de criar o token.',
            },
            embedPill: 'Incorporação',
            embedRowHint: 'Abre esta incorporação em Configurações, Incorporações.',
            summary: {
                full: 'Acesso total',
                allActions: 'Todas as ações',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 sessão' : `${count} sessões`),
                computers: ({ count }) => (count === 1 ? '1 computador' : `${count} computadores`),
                approve: 'Pode aprovar',
                models: ({ count }) => (count === 1 ? '1 modelo' : `${count} modelos`),
                websites: ({ count }) => (count === 1 ? '1 site' : `${count} sites`),
                content: 'Acesso ao conteúdo',
                noExpiry: 'Sem expiração',
                expires: ({ date }) => `Expira em ${date}`,
                expired: ({ date }) => `Expirou em ${date}`,
            },
            grant: {
                accessTitle: 'Acesso',
                back: 'Acesso',
                onlyThese: 'Somente estes',
                selectedCount: ({ count }) => (count === 1 ? '1 selecionado' : `${count} selecionados`),
                reviewUnnamed: 'Este token',
                actions: {
                    title: 'Ações',
                    all: 'Todas as ações',
                    none: 'Escolha pelo menos uma ação',
                    search: 'Pesquisar ações',
                    noMatches: ({ query }) => `Nenhuma ação corresponde a “${query}”`,
                    groupDescription: 'Um grupo inteiro também inclui ações adicionadas a ele depois.',
                    familyCount: ({ count }) => (count === 1 ? 'Grupo · 1 ação' : `Grupo · ${count} ações`),
                    includedByFamily: ({ family }) => `Incluída em ${family}`,
                },
                targets: {
                    title: 'Sessões e computadores',
                    all: 'Todas as sessões e computadores',
                    none: 'Escolha pelo menos uma sessão ou computador',
                    computers: 'Computadores',
                    computersDescription: 'Um computador inclui todas as sessões nele, agora e no futuro.',
                    sessions: 'Sessões',
                    searchSessions: 'Pesquisar sessões',
                    noSessions: 'Nenhuma sessão ainda',
                    noSessionMatches: ({ query }) => `Nenhuma sessão corresponde a “${query}”`,
                    noComputers: 'Nenhum computador ainda',
                },
                models: {
                    title: 'Modelos',
                    any: 'Qualquer modelo',
                    onlyThese: 'Somente estes modelos',
                    none: 'Escolha pelo menos um modelo',
                    pickerDescription: 'Outros modelos são recusados, não apenas ocultados. “Automático” não é oferecido depois que você escolhe modelos.',
                    noModels: 'Nenhum modelo para escolher ainda',
                },
                approve: {
                    title: 'Aprovar solicitações',
                    on: 'Ele pode aprovar o uso de ferramentas e solicitações nas sessões acima — inclusive as que ele mesmo iniciou. Nunca pode alterar tokens, segurança ou plugins.',
                    off: 'As solicitações esperam por você no Happier.',
                },
                websites: {
                    title: 'Sites',
                    description: 'As páginas desses sites podem usar o token em um navegador. Deixe vazio para scripts e servidores.',
                    inputLabel: 'Adicionar um site',
                    placeholder: 'https://app.example.com',
                    add: 'Adicionar',
                    invalid: 'Comece com https://, ou http:// para localhost.',
                    duplicate: 'Este site já está na lista.',
                    remove: ({ origin }) => `Remover ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'O que ele pode fazer',
                whatItCanDoDescription: 'Ações que este token pode executar por você. Todo o resto é recusado.',
                everyAction: 'Todas as ações habilitadas para API externa e SDK',
                wholeGroup: 'Grupo inteiro',
                where: 'Onde',
                whereDescription: 'Sessões e computadores que ele pode alcançar.',
                computerCovers: 'Todas as sessões neste computador',
                unknownComputer: 'Um computador que não está mais na lista',
                unknownSession: 'Uma sessão que não está mais na lista',
                modelsDescription: 'Outros modelos são recusados, não apenas ocultados.',
                approvals: 'Aprovações',
                approvesOn: 'Aprova solicitações',
                approvesOff: 'Não aprova solicitações',
                websitesDescription: 'Páginas desses sites podem usá-lo no navegador.',
                noWebsites: 'Somente scripts e servidores',
                content: 'Acesso ao conteúdo',
                contentOn: 'Ele pode ler conteúdo criptografado de ponta a ponta por meio de chamadas compatíveis do SDK.',
                contentOff: 'Ele não pode ler conteúdo criptografado de ponta a ponta.',
                children: 'Credenciais incorporadas',
                childrenDescription: 'Chaves de curta duração que seu app gerou a partir deste token para as páginas dele.',
                childrenCount: ({ count }) => (count === 1 ? '1 ativa' : `${count} ativas`),
                childrenConsequence: 'São desconectadas quando você edita o acesso ou revoga este token.',
                sessionLimits: 'Sessões',
                sessionLimitsDescription: 'As sessões que ele pode iniciar e os modos de permissão que suas mensagens podem usar.',
                createsSessions: 'Inicia sessões',
                createsSessionsOn: ({ computer }: { computer: string }) => `Em ${computer}, em uma pasta privada gerenciada pelo Happier.`,
                editAccess: 'Editar acesso',
                revokeFootnote: 'Scripts e incorporações que o usam param de funcionar na próxima solicitação.',
                created: ({ date }) => `Criado em ${date}`,
                lastUsed: ({ date }) => `Último uso em ${date}`,
                missingTitle: 'Este token não existe mais',
                missingBody: 'Ele foi revogado ou expirou e foi removido. Seus outros tokens continuam na lista.',
                backToTokens: 'Mostrar tokens de API',
            },
            edit: {
                title: 'Editar acesso',
                save: 'Salvar',
                signsOut: 'As credenciais incorporadas ativas serão desconectadas.',
            },
            cliPolicy: {
                sectionTitle: 'CLI e daemon',
                sectionDescription: 'O que os comandos nos seus computadores podem fazer com o seu login.',
                title: 'Permitir aprovações e alterações da Conta pela CLI e pelo daemon',
                description: 'Permite que comandos nos seus computadores aprovem solicitações e alterem as configurações da Conta. Desative se agentes forem executados com acesso ao shell. Um computador também pode recusar com HAPPIER_CLI_PRESENT_USER=disallowed. Alterar isso reconecta seus computadores brevemente.',
                unavailable: 'Não foi possível ler esta configuração. Tente novamente em instantes.',
                saveFailed: 'Não foi possível alterar esta configuração. Tente novamente em instantes.',
            },
            notices: {
                revoked: 'Token de API revogado.',
                revokedAll: 'Todos os tokens de API foram revogados.',
                signedOutEverywhere: 'Você saiu de todos os lugares. Os tokens de API continuam ativos.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { pt: {
        description: 'O que você e seus agentes salvaram, pronto para ler, reutilizar e compartilhar.',
        newDocument: 'Novo documento',
        searchPlaceholder: 'Pesquisar artefatos',
        kindLabel: 'Tipo',
        kinds: {
            all: 'Todos os tipos',
            document: 'Documentos',
            prompt: 'Prompts',
            board: 'Quadros',
            workflow: 'Fluxos de trabalho',
            role: 'Funções',
            launchProfile: 'Perfis de início',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            board: 'Quadro',
            workflow: 'Fluxo de trabalho',
            role: 'Função',
            launchProfile: 'Perfil de início',
        },
        sort: {
            label: 'Ordenar',
            updated_desc: 'Atualizados recentemente',
            created_desc: 'Criados recentemente',
            title_asc: 'Título',
        },
        view: {
            label: 'Visualização',
            grid: 'Grade',
            list: 'Lista',
            folders: 'Pastas',
        },
        folders: {
            newFolder: 'Nova pasta',
            newFolderInside: 'Nova pasta dentro',
            rename: 'Renomear',
            moveTo: 'Mover para pasta…',
            moveVerb: 'Mover para',
            topLevel: 'Nível superior',
            moveToTopLevel: 'Mover para o nível superior',
            deleteFolder: 'Excluir pasta',
            deleteTitle: ({ name }) => `Excluir “${name}”?`,
            deleteBody: 'Seus itens e pastas sobem um nível. Nada é excluído.',
            nameHelp: 'As pastas são só suas. Arquivar algo nunca o altera para as pessoas com quem é compartilhado.',
            namePlaceholder: 'Nome da pasta',
            create: 'Criar',
            options: ({ name }) => `Opções de ${name}`,
            expand: ({ name }) => `Expandir ${name}`,
            collapse: ({ name }) => `Recolher ${name}`,
            columnName: 'Nome',
            columnEdited: 'Editado',
            emptyInvite: 'Ainda não há pastas. Agrupe o que anda junto; só você vê como arquiva.',
            unavailable: 'Não foi possível carregar as pastas deste Home. Tudo é listado sem elas.',
            saveFailed: 'Essa alteração não foi salva. Tente novamente.',
            refusedCycle: 'Uma pasta não pode ser movida para dentro de si mesma',
            refusedUnavailable: 'As pastas estão indisponíveis no momento',
            refusedOther: 'Não pode ser movido para lá',
            showAllKinds: 'Mostrar todos os tipos em Artefatos',
            promptSearch: 'Buscar prompts e skills',
        },
        provenance: {
            savedByYou: 'Salvo por você',
            sharedWithYou: 'Compartilhado com você',
            fromFile: ({ name }) => `De ${name}`,
            openSession: ({ session }) => `Abrir ${session}`,
        },
        emptyTitle: 'Guarde o que seus agentes criam',
        emptyBody: 'Planos, notas, código e quadros que você ou seus agentes salvam chegam aqui, legíveis em qualquer dispositivo e prontos para compartilhar com suas equipes.',
        emptyHint: 'Ou peça a um agente “salve isso como artefato”.',
        loadFailedTitle: 'Não foi possível carregar seus artefatos',
        loadFailedBody: 'Verifique sua conexão e tente novamente. Nada foi perdido.',
        quota: {
            accountTitle: 'O armazenamento de artefatos está cheio',
            documentTitle: 'Grande demais para salvar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usados, incluindo versões. Exclua ou exporte artefatos de que não precisa mais para salvar novos.`,
            documentBody: ({ size, limit }) => `Ficaria com ${size}; cada artefato comporta até ${limit}. Suas edições continuam aqui.`,
        },
        open: {
            document: 'Abrir documento',
            prompt: 'Abrir prompt',
            board: 'Abrir quadro',
            workflow: 'Abrir fluxo de trabalho',
            role: 'Abrir função',
            launchProfile: 'Abrir perfil de início',
        },
        openAsPage: 'Abrir como página',
        actions: {
            edit: 'Editar',
            history: 'Histórico',
            share: 'Compartilhar',
            more: 'Mais ações',
            copyLink: 'Copiar link',
            linkCopied: 'Link copiado',
        },
        history: {
            title: 'Histórico',
            current: 'Atual',
            now: 'Agora',
            restoreNote: 'Restaurar a adiciona como uma nova versão. Nada é perdido.',
            loadFailed: 'Não foi possível carregar o histórico. Tente novamente.',
            empty: 'Ainda não há versões anteriores. Cada salvamento guarda uma.',
            versionsLabel: 'Versões',
            restoreFailed: 'Não foi possível restaurar esta versão. Tente novamente.',
            savedByUser: 'Salvo por um usuário',
            savedByAgentSession: 'Salvo por uma sessão de agente',
            restoredVersion: ({ n }) => `Restaurado da versão ${n}`,
            version: ({ n }) => `Versão ${n}`,
            keeps: ({ count }) => `Mantém as últimas ${count} versões.`,
            restore: ({ n }) => `Restaurar versão ${n}`,
        },
        savedToday: ({ count }) => `${count} salvos hoje`,
        noMatch: ({ query }) => `Nenhum artefato corresponde a “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Armazenamento de artefatos, ${used} de ${limit} usados`,
        },
        facts: {
            edited: ({ age }) => `Editado ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "pt">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { pt: translated({
        automationPages: {
            index: {
                description: 'Trabalho que começa sozinho: por agendamento, a partir de um Event ou quando termina um turno de uma sessão.',
            },
            settings: {
                description: 'Quanto trabalho de automação cada máquina aceita e por quanto tempo as execuções concluídas são mantidas.',
                capacityTitle: 'Capacidade',
                capacityDescription: 'Vale para todas as máquinas que executam automações.',
                historyTitle: 'Histórico de execuções',
                historyDescription: 'Execuções concluídas que você ainda pode abrir a partir de uma automação.',
            },
            detail: {
                description: 'Começa trabalho sozinha sempre que um de seus acionadores dispara.',
                triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 acionador' : `${count} acionadores`),
                overviewDescription: 'O que ela executa e como iniciá-la ou alterá-la.',
                runNowSubtitle: 'Inicie uma execução agora, sem esperar um acionador.',
                editSubtitle: 'Altere o nome, o que ela executa e os acionadores.',
                machineAssignmentsDescription: 'Máquinas que podem assumir as execuções desta automação.',
            },
            run: {
                description: 'O que iniciou esta execução, onde ela rodou e o que produziu.',
                statusTitle: 'Status',
                statusDescription: 'Em que ponto esta execução está e o que você ainda pode fazer com ela.',
                causeTitle: 'O que a iniciou',
                causeDescription: 'O acionador e o evento que admitiram esta execução. Eles nunca mudam depois.',
            },
            gate: {
                serverTitle: 'As automações estão desativadas nesta Home',
                serverBody: 'Os administradores desta Home desativaram as automações. Peça a um deles para ativá-las novamente.',
                openFeatures: 'Abrir configurações de recursos',
                unknownTitle: 'Não é possível verificar as automações agora',
                unknownBody: 'O Happier não conseguiu contactar esta Home para verificar se as automações estão ativadas. Verifique novamente quando ela voltar a ficar online.',
                unsupportedTitle: 'Esta Home ainda não suporta automações',
                unsupportedBody: 'O servidor dela é anterior às automações. Atualize o servidor da Home para usá-las.',
                unsupportedContextTitle: 'As automações não estão disponíveis aqui',
                unsupportedContextBody: 'Nem todas as Homes que você está vendo suportam automações.',
            },
            editor: {
                description: 'Dê um nome, escolha o que ela executa e adicione os acionadores que a iniciam.',
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

const automationTriggerSetTranslations = { pt: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Quando a sessão começa',
                sessionArchived: 'Quando a sessão é arquivada',
            },
            triggersTitle: 'Acionadores',
            emptyBody: 'Sem acionadores automáticos. Ainda pode executar esta automação manualmente.',
            orSemantics: 'Adicione quantos acionadores quiser. Funcionam de forma independente — a automação é executada quando qualquer um corresponde.',
            enabledSubtitle: 'Pause toda a automação sem alterar os acionadores.', addTrigger: 'Adicionar acionador',
            addTriggerSubtitle: 'Agende-a, ligue um evento ou aguarde a conclusão de um turno exato.', scheduleTitle: 'Agendamento', eventTitle: 'Evento do plugin',
            turnCompletedTitle: 'Quando este turno terminar', turnCompletedSubtitle: 'É executada uma vez depois de o turno principal selecionado terminar.', selectedSession: 'Sessão selecionada',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · acionador único ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `A cada ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Ativar ${title}`, editScheduleTitle: 'Editar agendamento', scheduleType: 'Tipo de agendamento',
            chooseSession: 'Escolher uma sessão ativa', eventEditorUnavailable: 'A configuração do evento não está disponível na máquina atual.',
            removeTitle: 'Remover este acionador?', removeBody: 'As ocorrências futuras deste acionador deixarão de iniciar a automação. O histórico de execuções não será alterado.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Pesquisar eventos',
            refreshFailedTitle: 'Não foi possível atualizar as automações',
            refreshFailedBody: 'Não foi possível ler a lista de automações agora. Tente novamente para carregar a lista atual.',
            actionTitle: 'Quando este turno terminar…', createNew: 'Criar uma nova automação', createNewSubtitle: 'Comece com este turno exato já selecionado.',
            addToExistingSubtitle: 'Adicione este turno exato a uma automação existente.', searchPlaceholder: 'Pesquisar automações',
            eventListA11y: 'Escolher o evento do ciclo de vida da sessão',
            destinationA11y: 'Escolher onde adicionar o acionador deste turno', staleTitle: 'Este turno mudou',
            staleBody: 'O turno selecionado já não é o turno principal ativo. Atualize e escolha explicitamente o turno atual.',
            useCurrentTurn: 'Usar o turno atual', unavailable: 'Não existe um turno principal ativo neste momento.',
            resolvingRowSubtitle: 'A verificar quais automatizações pode usar…',
            unavailableRowSubtitle: 'Detalhes indisponíveis — não é possível verificar esta automatização nesta sessão.',
            incompleteNoticeTitle: 'Não foi possível ler algumas automatizações',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const pt: BoardsTranslations = {
    title: 'Quadros',
    newBoard: 'Novo quadro',
    defaultName: 'Quadro sem nome',
    index: {
        title: 'Seus quadros',
        body: 'Um quadro mantém sessões, execuções, fluxos de trabalho e máquinas ao vivo em um só lugar, organizados do seu jeito.',
    },
    notFound: {
        title: 'Este quadro não existe mais',
        body: 'Ele foi excluído ou pertence a uma Home que não está conectada aqui.',
    },
    meta: {
        needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        items: ({ count }) => (count === 1 ? '1 item' : `${count} itens`),
        handPicked: 'Escolhidos à mão',
        empty: 'Vazio',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Precisa de você', description: 'Tudo o que está esperando por você' },
        running: { title: 'Em execução agora', description: 'Execuções de fluxos de trabalho em andamento' },
        my_machines: { title: 'Minhas máquinas', description: 'Presença e o que roda em cada uma' },
        filter: { title: 'Sessões', description: 'Todas as sessões ativas' },
    },
    header: {
        layoutA11y: 'Layout do quadro',
        canvas: 'Tela',
        byStatus: 'Por status',
        add: 'Adicionar ao quadro',
        settings: 'Configurações do quadro',
    },
    kinds: {
        session: 'Sessão',
        workflow_run: 'Execução de fluxo de trabalho',
        workflow: 'Fluxo de trabalho',
        machine: 'Máquina',
    },
    card: {
        untitled: 'Item indisponível',
        unavailable: 'Indisponível',
        unavailableBody: 'A Home dele não está conectada neste dispositivo. Ele continua no quadro.',
        notLoaded: 'Ainda não carregado',
        remove: 'Remover do quadro',
        moveHint: 'As teclas de seta movem este cartão na grade.',
        moved: ({ x, y }) => `Movido para ${x}, ${y}`,
        moveActions: { up: 'Mover para cima', down: 'Mover para baixo', left: 'Mover para a esquerda', right: 'Mover para a direita' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 sessão em execução' : `${count} sessões em execução`),
            needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
            idle: 'Nenhuma sessão em execução',
            offlineBody: 'As sessões esperam até ela voltar.',
        },
        workflow: {
            noRuns: 'Nenhuma execução ainda',
            lastRun: ({ word, age }) => `Última execução ${age} · ${word}`,
            needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        },
        run: {
            waitingForYou: 'Aguardando sua revisão',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Encaixa aqui',
        snapOnceHint: 'Segure ⇧ para encaixar uma vez',
    },
    settings: {
        title: 'Configurações do quadro',
        name: 'Nome',
        whatsOn: 'O que há neste quadro',
        whichSessions: 'Quais sessões',
        addedByHand: 'Adicionados à mão',
        addedByHandNone: 'Nada ainda',
        add: 'Adicionar',
        layout: 'Layout',
        layoutDescription: 'A tela mantém sua organização quando você alterna.',
        snap: 'Alinhar à grade',
        pin: 'Mostrar na lista de sessões',
        pinDescription: 'Fixa este quadro acima das suas sessões.',
        delete: 'Excluir quadro',
        deleteConfirmTitle: 'Excluir este quadro?',
        deleteConfirmBody: 'Só o quadro some. Suas sessões, execuções, fluxos de trabalho e máquinas continuam como estão.',
    },
    add: {
        title: 'Adicionar ao quadro',
        search: 'Buscar itens',
        groups: { sessions: 'Sessões', workflows: 'Fluxos de trabalho', runs: 'Execuções de fluxos de trabalho', machines: 'Máquinas' },
        onBoard: 'Neste quadro',
        addHint: 'Adicionar',
        addAndPlaceHint: 'Adicionar e posicionar',
        empty: 'Nada encontrado.',
    },
    empty: {
        title: 'Escolha o que este quadro mostra',
        body: 'Adicione sessões, fluxos de trabalho, execuções ou máquinas à mão, ou mostre uma seção como Precisa de você. Você organiza; o quadro os mantém ao vivo.',
        action: 'Adicionar ao quadro',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Abrir a galeria',
        galleryHint: 'Todos os widgets, com prévia ao vivo',
        addHint: 'Só você vê seus quadros',
        widthOne: 'Um cartão',
        widthTwo: 'Dois cartões',
        moveEarlier: 'Mover para antes',
        moveLater: 'Mover para depois',
        remove: 'Remover do quadro',
        menuA11y: ({ widget }) => `Opções de ${widget}`,
        arrived: ({ count }) => (count === 1 ? '1 widget acabou de chegar' : `${count} widgets acabaram de chegar`),
        undo: 'Desfazer',
        dismiss: 'Dispensar',
    },
    saveFailed: {
        tooLarge: 'Este quadro ultrapassa o limite de armazenamento dos quadros. Remova alguns itens e tente de novo.',
        notFound: 'Este quadro foi excluído em outro dispositivo.',
        generic: 'Sua alteração não chegou à sua conta, então o quadro continua como estava.',
        retry: 'Tentar de novo',
        dismiss: 'Dispensar',
        createTitle: 'Este quadro não foi criado',
    },
};

const boardsTranslations = { pt };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { pt: {
        agentFallbackName: 'O agente',
        agentBrowsing: ({ agent }) => `${agent} está navegando`,
        clickTarget: ({ target }) => `Clicando em “${target}”`,
        doing: {
            click: 'Clicando na página',
            type: 'Digitando',
            fill: 'Preenchendo um campo',
            scroll: 'Rolando',
            navigate: 'Abrindo uma página',
            history: 'Navegando pelo histórico',
            reload: 'Recarregando a página',
            press: 'Pressionando uma tecla',
            select: 'Escolhendo uma opção',
            drag: 'Arrastando',
            upload: 'Enviando um arquivo',
            look: 'Olhando a página',
            other: 'Trabalhando na página',
        },
        takeControl: 'Assumir o controle',
        stopping: ({ agent }) => `Parando ${agent}…`,
        stoppingDetail: 'Concluindo a última ação',
        lastActionMayHaveLanded: ({ agent }) => `A última ação de ${agent} pode ter sido feita`,
        youHaveControl: 'Você está no controle',
        stopUnconfirmed: 'Não foi possível confirmar a parada',
        checkAgain: 'Verificar de novo',
        pausedUntilHandBack: ({ agent }) => `${agent} fica em pausa até você devolver o controle`,
        handBack: 'Devolver',
        stream: {
            connectingTitle: ({ agent }) => `Conectando ao navegador de ${agent}`,
            connectingBody: ({ machine }) => `Ele roda em ${machine}. A página aparece aqui assim que chegar o primeiro quadro.`,
            stalled: 'Mostrando o último quadro · reconectando',
            endedTitle: ({ agent }) => `${agent} fechou este navegador`,
            endedBody: 'A página não é mais exibida aqui.',
            unavailableTitle: ({ agent }) => `Não é possível mostrar aqui o navegador de ${agent}`,
            unavailableBody: ({ agent }) => `${agent} continua navegando; as ações ainda aparecem no chat.`,
            tryAgain: 'Tentar novamente',
            inputA11y: 'A página. Toque, role ou digite para assumir o controle.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Gravando, ${elapsed}`,
            discard: 'Descartar gravação',
        },
        openInYourBrowser: 'Abrir no seu navegador',
        slowPage: 'Esta página está demorando',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "pt">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { pt: {
        opened: ({ page }) => `Abriu ${page}`,
        openedPage: 'Abriu uma página',
        reloaded: 'Recarregou a página',
        wentBack: 'Voltou',
        wentForward: 'Avançou',
        clicked: ({ target }) => `Clicou em ${target}`,
        clickedPage: 'Clicou na página',
        typedInto: ({ target }) => `Digitou em ${target}`,
        typed: 'Digitou na página',
        filledIn: ({ target }) => `Preencheu ${target}`,
        filled: 'Preencheu um campo',
        pressed: ({ key }) => `Pressionou ${key}`,
        pressedKey: 'Pressionou uma tecla',
        scrolled: 'Rolou a página',
        pointedAt: ({ target }) => `Apontou para ${target}`,
        pointed: 'Apontou para a página',
        choseIn: ({ target }) => `Escolheu uma opção em ${target}`,
        chose: 'Escolheu uma opção',
        uploadedTo: ({ target }) => `Enviou um arquivo para ${target}`,
        uploaded: 'Enviou um arquivo',
        dragged: ({ target }) => `Arrastou ${target}`,
        draggedPage: 'Arrastou na página',
        looked: 'Olhou a página',
        screenshot: 'Fez uma captura de tela',
        recordingStarted: 'Começou a gravar a página',
        recordingStopped: 'Parou a gravação',
        other: 'Usou o navegador',
        watch: 'Ver',
        watchA11y: 'Abrir esta página no navegador',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "pt">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { pt: {
        changedFileEvidence: translated({
            before: 'Antes',
            after: 'Depois',
            binary: 'Arquivo binário',
            truncated: 'O conteúdo da evidência foi limitado; o tamanho original e as estatísticas de mudanças são preservados quando disponíveis.',
            truncatedOldBytes: ({ count }) => `Conteúdo original antes: ${count} bytes`,
            truncatedNewBytes: ({ count }) => `Conteúdo original depois: ${count} bytes`,
            truncatedDiffBytes: ({ count }) => `Diff original: ${count} bytes`,
            truncatedAddedLines: ({ count }) => `Linhas adicionadas: ${count}`,
            truncatedRemovedLines: ({ count }) => `Linhas removidas: ${count}`,
            kind: {
                added: 'Adicionado',
                modified: 'Modificado',
                deleted: 'Excluído',
                renamed: 'Renomeado',
                copied: 'Copiado',
                unknown: 'Tipo de mudança indisponível',
            },
            howDetermined: 'Como foi determinado',
            howDeterminedForFile: ({ path }) => `Como ${path} foi determinado`,
            content: {
                exact: 'Mudança exata do repositório',
                strong: 'Evidência de conteúdo forte',
                best_effort: 'Evidência de conteúdo aproximada',
            },
            attribution: {
                session_exact: 'Vinculado a esta sessão',
                session_likely: 'Provavelmente alterado por esta sessão',
                session_possible: 'Possivelmente alterado por esta sessão',
                unknown: 'Atribuição de sessão indisponível',
            },
            reason: {
                provider_correlated: 'O agente relatou esta mudança para este turno.',
                canonical_tool_correlated: 'Uma ferramenta de diff ou patch vinculou esta mudança a este turno.',
                checkpoint_no_happier_overlap_observed: 'O checkpoint não registrou nenhum turno do Happier sobreposto neste processo.',
                checkpoint_overlap_observed: 'Outro turno do Happier se sobrepôs ao intervalo de captura do checkpoint.',
                workspace_touched_path: 'Este caminho foi tocado no workspace; isso não identifica a sessão que o alterou.',
                unavailable: 'As evidências não estabelecem qual sessão fez esta mudança.',
            },
            overlap: {
                observed: 'Outro turno do Happier se sobrepôs a este checkout durante a captura. As observações cobrem apenas este processo; outros processos e gravadores externos não são rastreados.',
                not_observed: 'Nenhum turno do Happier sobreposto foi observado neste processo. Outros processos e gravadores externos não são rastreados; isso não estabelece autoria exclusiva.',
                unknown: 'A sobreposição do checkpoint é desconhecida. Outros processos e gravadores externos não são rastreados.',
            },
            sources: {
                provider_native: 'Relatório de mudanças nativo do agente',
                provider_tool: 'Relatório de ferramenta do agente',
                canonical_diff_tool: 'Evidência de ferramenta de diff',
                canonical_patch_tool: 'Evidência de ferramenta de patch',
                scm_checkpoint: 'Checkpoint do repositório',
                scm_reconciled: 'Snapshot reconciliado do repositório',
                inferred: 'Caminho tocado no workspace',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const pt = {
    title: 'Linha de comando',
    footer: 'O Happier Desktop só adiciona ou remove as entradas de PATH que criou. As entradas escritas pelo instalador do shell permanecem intactas.',
    addTitle: 'Adicionar happier ao PATH',
    addSubtitle: 'Deixe o comando happier disponível em novos terminais.',
    removeTitle: 'Remover happier do PATH',
    removeSubtitle: 'Remove apenas as entradas de PATH adicionadas pelo Happier Desktop.',
    working: 'Atualizando seu perfil de shell…',
    added: 'Adicionado. Abra um novo terminal para usar o happier.',
    alreadyPresent: 'O happier já está no seu PATH.',
    removed: 'As entradas de PATH adicionadas pelo Happier Desktop foram removidas.',
    nothingToRemove: 'O Happier Desktop não adicionou nenhuma entrada de PATH.',
};

const cliPathExposureTranslations = { pt: pt };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const pt = {
    title: 'Aprovar esta linha de comandos?',
    body: ({ command }: { command: string }) => `O Happier não instalou a linha de comandos em ${command}. Aprová-la permite-lhe ler e escrever as sessões desta conta. Aprove apenas a que colocou você mesmo.`,
    bodyUnknownCommand: 'O Happier não instalou esta linha de comandos. Aprová-la permite-lhe ler e escrever as sessões desta conta. Aprove apenas a que colocou você mesmo.',
    approve: 'Aprovar',
};

const cliTrustPromptTranslations = { pt: pt };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "pt"> = { pt: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Um commit para as suas alterações pendentes' : `${count} commits para as suas alterações pendentes`),
        titlePhone: ({ count }) => (count === 1 ? 'Um commit' : `${count} commits`),
        proposedBy: ({ who, committed, total }) => `Proposto por ${who} · ${committed} de ${total} arquivos · ordenados para que cada commit parta do anterior.`,
        proposedByPhone: ({ committed, total }) => `${committed} de ${total} arquivos pendentes · toque numa alteração para movê-la.`,
        moveHint: ({ max }) => `Mova qualquer alteração com ⌥1–${max} ou pelo menu.`,
        modelFallback: 'o modelo',
        regenerate: 'Gerar novamente',
        conflict: 'A proposta mudou noutro lugar. Esta é a mais recente; faça a alteração de novo.',
        approvalPending: 'Aguardando aprovação para criar estes commits.',
        discardBody: 'A proposta é removida. As suas alterações pendentes ficam como estão.', askFix: ({ hook, number, message }) => `O hook ${hook} parou o commit ${number}, “${message}”. Corrija o que ele aponta para o commit passar:`, askFixGeneric: ({ number, message }) => `Um hook parou o commit ${number}, “${message}”. Corrija o que ele aponta para o commit passar:`, discarded: 'Proposta descartada.', undo: 'Desfazer',
        fileCount: ({ count }) => (count === 1 ? '1 arquivo' : `${count} arquivos`),
        part: ({ count, of }) => `${count} de ${of} alterações`,
        move: { a11y: ({ file }) => `Mover ${file} para outro commit`, title: ({ file }) => `Mover ${file} para`, newCommitAfter: ({ number }) => `Novo commit depois do ${number}`, newCommitMessage: ({ file }) => `Atualizar ${file}`, leaveOut: 'Deixar fora destes commits', leaveOutHint: 'Fica na sua árvore de trabalho' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Editar mensagem', messageA11y: ({ number }) => `Mensagem do commit ${number}`, more: 'Mais', moveUp: 'Subir', moveDown: 'Descer', mergeWithNext: 'Juntar com o próximo commit', empty: 'Ainda sem alterações. Mova uma para cá ou junte-o ao próximo.' },
        leftOut: { title: 'Deixadas fora · ficam na sua árvore de trabalho', description: 'Estas alterações continuam pendentes. Faça um commit à parte se era essa a intenção.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `${count} commits`), onBranch: ({ branch }) => ` em ${branch} · hooks e assinatura funcionam como em qualquer commit`, detached: ' num HEAD destacado · hooks e assinatura funcionam como em qualquer commit', phone: 'Hooks e assinatura como sempre', discard: 'Descartar proposta', create: ({ count }) => (count === 1 ? 'Criar 1 commit' : `Criar ${count} commits`), createShort: ({ count }) => `Criar ${count}`, emptyGroupReason: 'Um commit não tem alterações. Mova uma para ele ou junte-o.' },
        applying: { title: ({ count }) => (count === 1 ? 'Criando 1 commit' : `Criando ${count} commits`), body: 'Um de cada vez pelo caminho de commit normal, para que hooks e assinatura funcionem como sempre. A edição fica em pausa até terminar.', bodyPhone: 'A edição fica em pausa até terminar.', created: ({ landed, total }) => `${landed} de ${total}`, createdRest: ' criados · nada é desfeito se um posterior parar', createdRestPhone: ' criados', stopAfterThis: 'Parar depois deste commit', stopAfterThisShort: 'Parar depois deste', stopping: 'Vai parar depois deste commit' },
        state: { waiting: 'Aguardando', writing: 'Executando hooks e criando o commit', landed: 'feito', landedAt: ({ time }) => `feito às ${time}`, signed: 'assinado', pausedBy: ({ hook, count }) => `${hook} alterou ${count} arquivo${count === 1 ? '' : 's'} · ainda sem commit`, hookFailedBy: ({ hook }) => `${hook} falhou · sem commit`, rewritten: 'um hook reescreveu a mensagem', notCreated: 'Não criado · ainda editável', notCreatedShort: 'Não criado', unknown: 'Ainda não confirmado', paused: ({ count }) => (count === 1 ? 'Um hook alterou 1 arquivo · ainda sem commit' : `Um hook alterou ${count} arquivos · ainda sem commit`), failed: 'Parou aqui · sem commit' },
        outcome: { signingTitle: 'Agora não é possível assinar os seus commits.', signingBody: 'Este repositório assina todos os commits. Nada foi commitado.', signingHint: 'Desbloqueie primeiro o seu agente GPG ou SSH', tryAgain: 'Tentar novamente', cancel: 'Cancelar', hookChanged: ({ files }) => `O hook alterou ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'O commit 1 já entrou; este espera por você.' : `${count} commits já entraram; este espera por você.`), waits: 'Este espera por você.', include: 'Incluir as alterações do hook', includePhone: 'Incluir e fazer commit', cancelCommit: 'Cancelar este commit', hookFailed: 'Um hook parou este commit.', hookChangedBy: ({ hook, files }) => `${hook} alterou ${files}.`, hookFailedBy: ({ hook }) => `${hook} parou este commit.`, hookFailedBody: 'Os commits anteriores ficam. O resto ainda é editável.', headMoved: ({ branch }) => `${branch} mudou durante os commits.`, headMovedBody: 'O próximo commit foi recusado e nada foi desfeito.', proposeAgain: 'Propor de novo o que resta', keepEditing: 'Continuar editando', askSessionToFix: 'Pedir a esta sessão que corrija', showInGit: 'Mostrar no Git', unknownTitle: 'Não foi possível confirmar se este commit entrou.', unknownBody: 'Nada é repetido até sabermos. Verifique o branch de novo.', checkAgain: 'Verificar de novo', stoppedTitle: ({ landed, total }) => `${landed} de ${total} commits criados`, stoppedBody: ({ count }) => (count === 1 ? 'O último não foi criado. As alterações continuam na sua árvore de trabalho, como antes.' : `${count} não foram criados. As alterações continuam na sua árvore de trabalho, como antes.`), createRest: ({ count }) => (count === 1 ? 'Criar o último' : `Criar os ${count} restantes`), completeTitle: ({ count }) => (count === 1 ? '1 commit criado' : `${count} commits criados`), completeBody: 'Nada foi enviado.', onBranch: ({ branch }) => `em ${branch}`, failed: { staging_conflict: 'Outra coisa alterou o que está preparado.', selection_conflict: 'Estas alterações não podem ser divididas assim.', source_changed: 'As alterações pendentes mudaram desde a proposta.', writer_failed: 'Não foi possível criar o commit.', publication_warning: 'O commit entrou, mas os arquivos preparados não foram atualizados.', cancelled: 'Este commit foi cancelado.' }, failedBody: 'Os commits anteriores ficam. Nada foi desfeito.' },
        none: { title: 'Ainda não há proposta de commits', reason: 'Uma proposta agrupa as suas alterações pendentes em commits editáveis e depois cria-os um de cada vez pelo caminho de commit normal.', propose: 'Propor commits', writing: 'Agrupando as suas alterações pendentes…' },
        gitPane: { title: 'Commits propostos', meta: ({ count, files }) => `${count} · ${files} arquivos`, inCommit: ({ count, number }) => `${count} no commit ${number}`, open: 'Abrir', review: 'Rever', reviewInWalkthrough: 'Rever na apresentação', more: 'Descartar ou gerar novamente', selectedHint: 'Selecionado. Toque de novo para abri-lo em Commits', tapHint: 'Toque para ver as alterações' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "pt": {
        "committedMessageActions": {
            "copy": "Copiar",
            "fork": "Ramificar",
            "rollback": "Reverter",
            "pin": "Fixar",
            "savePrompt": "Salvar como prompt",
            "plugins": "Ações de plugins",
            "composerButton": "Botão da biblioteca de prompts",
            "composerHint": "Seus prompts e o que você enviou, ao lado do ditado. O menu / continua oferecendo Prompts… quando está desativado.",
            "name": "Nome",
            "shortcut": "/ atalho",
            "savedOpen": "Salvo na biblioteca · Abrir",
            "shortcutNotSaved": "O prompt foi salvo, mas o atalho não. Abra-o na biblioteca para adicionar um atalho.",
            "wrongAccount": "Mude para o Home desta sessão antes de salvar seu prompt.",
            "savedHintFavorite": "Vai para sua biblioteca, com estrela.",
            "savedHint": "Vai para sua biblioteca.",
            "addShortcut": "Adicionar um atalho /",
            "shortcutPlaceholder": "/atalho",
            "savedToLibrary": "Salvo na biblioteca",
            "savePromptHint": "Reutilize pela biblioteca de prompts",
            "copyHint": "Copie o texto de uma mensagem.",
            "forkHint": "Comece uma nova sessão a partir de uma mensagem.",
            "rollbackHint": "Volte o espaço de trabalho ao estado anterior a uma mensagem.",
            "pinHint": "Fixe mensagens para voltar a elas. As fixadas continuam fixadas.",
            "savePromptSettingHint": "Guarde uma mensagem enviada como prompt da biblioteca.",
            "pluginsHint": "Ações que seus plugins adicionam abaixo das mensagens."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { pt: {
        approval: {
            sectionTitle: 'No computador',
            act: {
                list: 'Ver quais janelas estão abertas',
                see: 'Fazer uma captura de tela',
                read: 'Ler o texto e os controles',
                click: 'Clicar',
                press: 'Pressionar uma tecla',
                type: 'Digitar',
                share: 'Compartilhar uma janela',
            },
            windowOn: ({ machine }) => `Uma janela em ${machine}`,
            screenOf: ({ machine }) => `A tela inteira de ${machine}`,
            windowsOn: ({ machine }) => `As janelas abertas em ${machine}`,
            window: 'Uma janela',
            screen: 'A tela inteira',
            windows: 'As janelas abertas',
            typedLabel: 'Texto',
            keyLabel: 'Tecla',
            listConsequence: 'Só os nomes das janelas abertas são compartilhados, não o conteúdo delas.',
            seeConsequence: 'As capturas são compartilhadas com esta sessão. Sem cliques nem digitação.',
            useConsequence: 'A entrada que chega à máquina não pode ser desfeita. Você pode parar a qualquer momento.',
            targetOn: ({ machine, target }) => `${target} em ${machine}`,
            chooseFirst: 'Escolha a janela primeiro',
            cropA11y: ({ target }) => `A imagem mais recente de ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} sugere “${target}”`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} quer usar uma janela em ${machine}`,
            body: 'Você escolhe a janela. Nada é compartilhado até lá.',
            choose: 'Escolher uma janela',
            change: 'Trocar de janela',
            shared: ({ target }) => `Você compartilhou ${target}`,
            watch: 'Assistir',
        },
        picker: {
            title: ({ agent }) => `Deixar ${agent} usar uma janela`,
            description: ({ agent }) => `Você escolhe o que compartilhar com ${agent}.`,
            windows: 'Janelas',
            screens: 'Tela inteira',
            untitledWindow: 'Janela sem título',
            screenLabel: ({ index }) => `Tela ${index}`,
            share: 'Compartilhar janela',
            shareScreen: 'Compartilhar tela',
            shareApp: ({ app }) => `Compartilhar janela de ${app}`,
            stopSharing: 'Parar de compartilhar',
            loadingTitle: ({ machine }) => `Procurando janelas em ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} não tem tela para compartilhar`,
            noScreenBody: 'Funciona sem uma área de trabalho que o Happier possa ver. Use uma máquina com tela.',
            unsupportedTitle: ({ machine }) => `O Happier ainda não consegue usar a tela de ${machine}`,
            unsupportedBody: 'Por enquanto, compartilhar uma janela funciona em áreas de trabalho Linux.',
            failedTitle: ({ machine }) => `Não foi possível listar as janelas de ${machine}`,
            failedBody: 'Verifique se o Happier está rodando lá e tente de novo.',
            emptyTitle: ({ machine }) => `Nenhuma janela aberta em ${machine}`,
            emptyBody: 'Abra a janela que você quer compartilhar e verifique de novo.',
            tryAgain: 'Tentar de novo',
            inUse: 'Outra sessão está usando esta janela. Escolha outra.',
            closed: 'Essa janela foi fechada. Escolha outra.',
            selectFailed: 'Não foi possível compartilhar essa janela. Tente de novo.',
            otherMachineTitle: ({ machine }) => `${machine} não é a máquina desta sessão`,
            otherMachineBody: 'Só é possível compartilhar janelas na máquina em que esta sessão roda.',
            purpose: ({ session }) => `Para “${session}”.`,
            purposeIn: ({ project, session }) => `Para “${session}” em ${project}.`,
            access: ({ agent }) => `${agent} pode`,
            accessValue: 'Ver e usar',
            accessSee: 'Só ver',
            displayUnavailable: 'Não é possível compartilhar a tela inteira deste computador.',
            wholeDisplayBody: ({ display }) => `Tudo o que estiver visível em ${display} pode ser visto, incluindo outras apps e notificações.`,
            policyBoth: ({ agent }) => `${agent} pergunta antes de cada captura, clique e tecla.`,
            policyInput: ({ agent }) => `${agent} pergunta antes de cada clique e tecla.`,
            policyCapture: ({ agent }) => `${agent} pergunta antes de cada captura.`,
            policyNone: ({ agent }) => `${agent} não pergunta antes de capturas, cliques ou teclas.`,
            policyChange: 'Alterar',
            suggests: ({ agent }) => `${agent} sugere`,
        },
        permission: {
            title: ({ machine }) => `${machine} precisa da sua permissão primeiro`,
            body: 'O Happier só consegue ver e usar janelas depois que você permitir nos Ajustes do Sistema, naquele computador.',
            capture: 'Gravação de Tela',
            captureHint: 'Para ver janelas',
            input: 'Acessibilidade',
            inputHint: 'Para clicar e digitar',
            allowed: 'Permitido',
            denied: 'Não permitido',
            unknown: 'Não verificado',
            open: ({ machine }) => `Abrir Ajustes do Sistema em ${machine}`,
            opened: ({ machine }) => `Aberto em ${machine}. Permita o Happier lá e verifique de novo.`,
            openFailed: 'Não foi possível abrir os Ajustes do Sistema lá. Abra naquele computador.',
            checkAgain: 'Verificar de novo',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} está usando ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} pode usar ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} pode ver ${target}`,
            onMachine: ({ machine }) => `Em ${machine}`,
            connectingTitle: ({ target }) => `Conectando a ${target}`,
            connectingBody: ({ machine }) => `A janela aparece aqui assim que a primeira imagem chegar de ${machine}.`,
            unavailableTitle: 'Não é possível mostrar esta janela agora',
            unavailableBody: ({ agent }) => `Você ainda pode parar ${agent} por aqui.`,
            endedTitle: ({ target }) => `${target} foi fechada`,
            endedBody: ({ agent }) => `${agent} não pode mais vê-la nem usá-la. Escolha outra janela para continuar.`,
            stalled: 'Mostrando a última imagem · reconectando',
            inputA11y: ({ target }) => `${target}, ao vivo. Clique ou digite para assumir o controle.`,
            notSharedTitle: 'Nenhuma janela compartilhada',
            notSharedBody: ({ agent }) => `Escolha uma janela para ${agent} usar.`,
            moreA11y: 'Opções da janela',
            tabFallback: 'Computador',
            sourceComputer: 'Computador',
            sourceBrowser: 'Navegador',
            sourceA11y: 'Fonte',
            watchingA11y: ({ source, machine }) => `A ver ${source} em ${machine}`,
            expandView: 'Expandir vista',
            restoreView: 'Restaurar vista',
            dockView: 'Ancorar vista',
            closeView: 'Fechar vista',
            moveView: 'Mover vista',
            resizeView: 'Redimensionar vista',
            moveTopLeft: 'Mover para cima à esquerda',
            moveTopRight: 'Mover para cima à direita',
            moveBottomLeft: 'Mover para baixo à esquerda',
            moveBottomRight: 'Mover para baixo à direita',
            larger: 'Maior',
            smaller: 'Menor',
            viewOptions: 'Opções da vista',
            presentedElsewhereTitle: 'Mostrada na vista flutuante',
            presentedElsewhereBody: 'Ancore-a aqui para a manter ao lado do seu trabalho.',
            closeHint: 'Fecha este visualizador. A sessão continua.',
            captureOnly: 'Pode ver este ecrã. O controlo com rato e teclado não é permitido.',
        },
        strip: {
            using: ({ target }) => `Usando ${target}`,
            on: ({ machine }) => `em ${machine}`,
            stop: 'Parar',
            paused: ({ agent }) => `${agent} está pausado`,
            pausedDetail: ({ target }) => `Você está no controle de ${target}`,
        },
        tool: {
            capture: 'Fez uma captura',
            captureRunning: 'Fazendo uma captura',
            query: 'Leu o texto e os controles da janela',
            queryRunning: 'Lendo a janela',
            click: 'Clicou na janela',
            clickRunning: 'Clicando na janela',
            clickTarget: ({ target }) => `Clicou em “${target}”`,
            type: 'Digitou na janela',
            typeRunning: 'Digitando na janela',
            typeTarget: ({ target }) => `Digitou em “${target}”`,
            pressKey: ({ key }) => `Pressionou ${key}`,
            press: 'Pressionou uma tecla',
            pressRunning: 'Pressionando uma tecla',
            mayHaveLanded: 'pode ter sido aplicado',
            failed: 'Não foi concluído',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "pt">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const pt: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Conta ${service}`,
    accountLabelNumbered: ({ service, number }) => `Conta ${service} ${number}`,
    meterResetsIn: ({ time }) => `em ${time}`,
    meterNextResetIn: ({ time }) => `o próximo em ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Não informado',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Todos os serviços',
    indexDescription: 'As contas com que os seus agentes entram e quanto resta a cada uma.',
    viewList: 'Lista',
    viewGrid: 'Grade',
    viewLabel: 'Mostrar as contas como',
    refreshAll: 'Atualizar tudo',
    refreshUsage: 'Atualizar o uso',
    signedOutConsequence: 'As sessões não a podem usar até voltar a entrar.',
    poolsGroup: 'Pools',
    poolsDescription: 'Contas entre as quais um agente alterna. O pool escolhe uma quando a sessão começa e passa à seguinte quando se esgota.',
    newPool: 'Novo pool',
    poolUsing: ({ account }) => `A usar ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Primeira de ${count}` : `${position} de ${count}`,
    poolInUseNow: 'em uso agora',
    inUse: 'Em uso',
    connectService: 'Ligar um serviço',
    searchAccounts: 'Pesquisar contas',
    servicesGroup: 'Serviços',
    railEmpty: 'Ainda sem contas',
    railKey: 'chave',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Como os agentes entram',
    subscriptionTitle: 'Subscrição',
    subscriptionNone: 'Sem subscrição',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Renova hoje' : days === 1 ? 'Renova amanhã' : `Renova dentro de ${days} dias`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Sem renovação · termina hoje' : `Sem renovação · termina dentro de ${days} dias`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'O período termina hoje' : `O período termina dentro de ${days} dias`,
    subscriptionRenewsOn: ({ date, days }) => `Renova a ${date} · dentro de ${days} dias`,
    subscriptionEndsOn: ({ date, days }) => `Sem renovação · termina a ${date}, dentro de ${days} dias. Depois as sessões deixam de a usar.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `O período termina a ${date} · dentro de ${days} dias`,
    renewalOn: 'Ativa',
    renewalOff: 'Desativada',
    renewalUnknown: 'Desconhecido',
    checkedAt: ({ time }) => `Verificado ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Verificado ${time} · pode estar desatualizado`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Verificado ${time} · pode estar desatualizado`,
    daysAgo: ({ count }) => count === 1 ? 'há 1 dia' : `há ${count} dias`,
    hoursAgo: ({ count }) => count === 1 ? 'há 1 hora' : `há ${count} horas`,
    usageResetsCount: ({ count }) => count === 1 ? '1 reposição de uso' : `${count} reposições de uso`,
    usageResetsFirstExpires: ({ date }) => `a primeira expira ${date}`,
    usageResetExpires: ({ date }) => `expira ${date}`,
    useOne: 'Usar uma',
    useOneReset: 'Usar uma reposição de uso',
    usageResetsTitle: 'Reposições de uso',
    usageResetsDescription: 'Cada uma inicia logo uma nova janela. Guarde-as para quando um limite o bloquear; as não usadas expiram.',
    usageResetTitle: 'Reposição de uso',
    usageResetExpiresOn: ({ date }) => `Expira a ${date}`,
    use: 'Usar',
    usedByDefault: 'Predefinida · as novas sessões usam esta conta',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Ocultar e-mails e IDs das contas',
    hideIdentitiesDescription: 'Para transmissões e demonstrações. Oculta e-mails e IDs das contas em todo este dispositivo; os nomes que deu às contas mantêm-se.',
    privacyTitle: 'Privacidade',
    renameTitle: 'Dar nome a esta conta',
    renameBody: ({ service }) => `Só muda o nome no Happier. ${service} mantém o seu próprio nome para a conta.`,
    identityHidden: 'E-mail ou ID ocultos',
};

const connectedServicesCollectionTranslations = { pt };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const pt: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Expira antes",
    strategyExpiryFirstDescription: "Prefira uma quota suficiente cujo período longo reinicie ou cuja assinatura sem renovação termine mais cedo.",
    leadExpiryFirst: "Primeiro o que expira antes.",
    membersOn: ({ service, on, total }) => `${service} · ${on} de ${total} membros ativos`,
    rename: 'Renomear',
    moreActions: 'Mais ações',
    defaultFor: ({ agent }) => `Padrão para ${agent}`,
    defaultForMore: ({ agent, count }) => `Padrão para ${agent} +${count}`,
    makeDefault: 'Tornar padrão',
    makeDefaultA11y: 'Tornar padrão para um agente',
    usingSince: ({ name, time }) => `Usando ${name} desde ${time}`,
    using: ({ name }) => `Usando ${name}`,
    noActive: 'Nenhum membro em uso ainda',
    noActiveDetail: 'O grupo escolhe um quando uma sessão começa.',
    leadLeastLimited: 'Primeiro o menos limitado.',
    leadInOrder: 'Em ordem.',
    fallbackOff: ({ name }) => `A troca automática está desativada, então as sessões ficam em ${name} quando se esgotar.`,
    manualStays: ({ name }) => `Manual: o grupo fica em ${name} até você escolher outro membro.`,
    switchTo: ({ name }) => `Trocar para ${name}`,
    onlyOneOn: ({ name }) => `Só ${name} está ativo, então não há alternativa.`,
    turnOn: ({ name }) => `Ativar ${name}`,
    allWaitingTitle: 'Todos os membros aguardam uma redefinição',
    allWaitingFirst: ({ name, time, countdown }) => `${name} é redefinido primeiro, às ${time} (${countdown}).`,
    sessionsWait: 'As sessões aguardam e depois continuam sozinhas.',
    sessionsStop: 'As sessões param até um membro ter folga.',
    leftTitle: 'Restante no grupo',
    leftDescription: 'A média dos membros ativos; cada um é redefinido por conta própria.',
    roomCount: ({ count, total }) => `${count} de ${total} têm folga agora`,
    notReported: ({ count }) => count === 1 ? '1 sem dados' : `${count} sem dados`,
    nothingReported: 'Nenhum membro ativo informa seus limites ainda.',
    membersTitle: 'Membros',
    membersDescription: 'Arraste para definir a ordem. O membro selecionado é o ativo; um membro desativado é ignorado.',
    membersCompactDescription: 'Segure e arraste para reordenar.',
    manage: 'Gerenciar',
    connectAnotherAccount: ({ service }) => `Conectar outra conta ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} de ${total} contas ${service}`,
    manageMembers: 'Gerenciar membros',
    searchAccounts: ({ service }) => `Buscar contas ${service}`,
    active: 'Ativo',
    offNotUsed: 'Não usado pelo grupo enquanto desativado',
    autoOffModel: 'Desativado automaticamente · este plano não pode usar o modelo selecionado',
    checkedAt: ({ time }) => `Verificado ${time}`,
    makeActiveA11y: ({ name }) => `Tornar ${name} o membro ativo`,
    memberOnA11y: ({ name }) => `Usar ${name} neste grupo`,
    openA11y: ({ name }) => `Abrir ${name}`,
    dragA11y: 'Arraste para reordenar',
    behaviorTitle: 'Comportamento',
    strategyTitle: 'Estratégia de seleção',
    strategyLeastLimited: 'Menos limitado',
    strategyInOrder: 'Em ordem',
    strategyManual: 'Manual',
    strategyLeastLimitedDescription: 'Preferir o membro com mais cota utilizável.',
    strategyInOrderDescription: 'Tentar os membros na ordem acima.',
    strategyManualDescription: 'Usar só o membro ativo até você mudar.',
    fallbackTitle: 'Troca automática',
    fallbackDescription: 'Trocar para outro membro quando a conta ativa precisar de recuperação.',
    switchEarlyTitle: 'Trocar antes',
    switchEarlyDescription: 'Percentual restante abaixo do qual o grupo passa a um membro com cota mais recente. 0 desativa.',
    autoResetsTitle: 'Usar redefinições de cota automaticamente',
    autoResetsDescription: 'Gastar uma redefinição guardada só quando nenhum membro estiver pronto.',
    autoOffTitle: 'Desativar contas que não podem usar o modelo selecionado',
    autoOffDescription: 'Você pode reativá-las.',
    advancedTitle: 'Avançado',
    advancedCount: ({ count }) => `${count} ajustes`,
    restoreFirstTitle: 'Voltar ao primeiro membro quando ele for redefinido',
    restoreFirstDescription: 'Após uma troca, voltar ao membro colocado primeiro quando seu limite for redefinido.',
    switchWhenTitle: 'Trocar quando',
    switchWhenDescription: 'Eventos que movem o grupo para o próximo membro.',
    staleAfterTitle: 'Verificar uso antigo após',
    staleAfterDescription: 'Minutos. Perguntar novamente ao provedor quando o uso for mais antigo antes de escolher um membro.',
    switchesPerTurnTitle: 'Trocas automáticas por turno',
    switchesPerHourTitle: 'Trocas automáticas por hora de sessão',
    switchLimitsDescription: 'Impede que um grupo fique alternando entre membros.',
    recoveryTitle: 'Quando um limite para uma sessão',
    recoveryDescription: 'O que o grupo faz pela sessão em espera.',
    recoveryPromptsTitle: 'Mensagens de retomada',
    recoveryPromptsDescription: 'O Happier envia sua mensagem padrão ao retomar uma sessão após uma troca ou redefinição.',
    usedByTitle: 'Usado por',
    usedByDefault: 'Padrão · novas sessões entram por este grupo',
    usedByNone: 'Nenhum agente entra por este grupo por padrão ainda.',
    deleteNote: ({ agents }) => `Os membros continuam conectados. ${agents} volta ao próprio login até você escolher outro padrão.`,
    deleteNoteNoAgent: 'Os membros continuam conectados.',
    emptyTitle: 'Adicione as contas entre as quais trocar',
    emptyReason: ({ service }) => `Um grupo escolhe uma conta quando uma sessão começa e troca quando ela se esgota. Adicione pelo menos duas contas ${service}.`,
    usageNotAnswering: ({ service }) => `${service} não respondeu`,
    newPoolTitle: 'Novo grupo',
    newPoolDescription: ({ service }) => `Contas ${service} entre as quais um agente troca.`,
    nameTitle: 'Nome',
    namePlaceholder: 'Grupo de trabalho',
    draftMembersDescription: 'Escolha as contas entre as quais trocar. Você pode mudá-las depois.',
    create: 'Criar grupo',
    discard: 'Descartar',
};

const connectedServicesPoolTranslations = { pt };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const pt: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 conta' : `${count} contas`,
    defaultAccount: ({ name }) => `Padrão: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 grupo' : `${count} grupos`,
    noAccountsYet: 'Ainda não há contas',
    needsSignIn: 'Requer login',
    signInAgain: 'Entrar novamente',
    addAccount: 'Adicionar conta',
    connectAnotherTitle: 'Conectar outro serviço',
    connectFirstTitle: 'Conectar um serviço',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} e mais ${count}.`,
    connect: 'Conectar',
    emptyTitle: 'Ainda não há serviços para conectar',
    servicesTitle: 'Serviços',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Nenhum agente em ${machine} oferece ainda um serviço para iniciar sessão. Os agentes que usam uma subscrição adicionam o seu aqui.`,
    emptyNoMachineOnline: 'Nenhuma das suas máquinas está online. Os serviços aparecem quando uma estiver, a partir dos agentes que executa.',
    emptyOpenAgents: 'Abrir agentes',
    emptyAction: 'Abrir máquinas',
    projectionErrorTitle: 'Não foi possível carregar os serviços das suas máquinas',
    projectionErrorDescription: 'Suas contas continuam listadas. Os serviços que você pode adicionar aparecem quando uma máquina responde.',
    loadingServices: 'Procurando serviços nas suas máquinas…',
    usageTitle: 'Como as contas são usadas',
    usageDescription: 'Com qual conta cada agente entra ao iniciar uma sessão e o que as sessões compartilham.',
    sharingTitle: 'Compartilhamento de estado',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Vinculada',
    configCopiedShort: 'Copiada',
    configIsolatedShort: 'Isolada',
    stateSharedShort: 'Sessões compartilhadas',
    stateIsolatedShort: 'Sessões separadas',
    perAgentTitle: 'Compartilhamento por agente',
    perAgentDescription: 'Substitua estes padrões para um agente.',
    perAgentPurpose: 'Escolha, por agente, o que as sessões de contas conectadas compartilham com o seu próprio login.',
    servicePurpose: ({ service }) => `As contas com que você entra no ${service} e os pools que as compartilham.`,
    chooseMachineTitle: 'Escolha uma máquina',
    chooseMachineDescription: 'Adicionar, entrar e remover contas acontece em uma das suas máquinas. Suas contas continuam listadas em Serviços conectados.',
    newAccountTitle: 'Nova conta',
    newAccountDescription: 'Escolha como entrar.',
    newAccountInProgress: 'Conclua o login abaixo.',
    modeBrowser: 'Entrar com um navegador',
    modeDeviceCode: 'Entrar com um código',
    modeManual: 'Inserir um token',
    serviceSettingsTitle: 'Configurações do serviço',
    serviceSettingsDescription: 'Configurações com que cada conta deste serviço entra.',
    noAccountsDescription: 'Adicione uma conta para que seus agentes possam entrar com ela.',
    accountDetailsTitle: 'Detalhes da conta',
    poolEmptyTitle: 'Adicione contas a este pool',
    poolEmptyDescription: 'Um pool passa as sessões para a próxima conta quando uma atinge o limite. Escolha as contas abaixo.',
    agentDefaultsTitle: 'Conta padrão por agente',
    agentDefaultsDescription: 'A conta com que cada agente entra ao iniciar uma sessão.',
    agentDefaultsKeywords: 'conta padrão',
    namesAnd: ({ names, last }) => `${names} e ${last}`,
    usedBy: ({ names }) => `Usado por ${names}`,
    poolRuleMostLeft: 'usa o que tem mais disponível',
    poolRuleInOrder: 'usa-os em ordem',
    poolRuleManual: 'você troca manualmente',
    poolInUse: ({ pool }) => `${pool} · em uso`,
    agentDefault: ({ agent }) => `Padrão do ${agent}`,
    signedOutBy: ({ service }) => `Sessão encerrada pelo ${service}`,
    usageReadFailed: 'Não foi possível ler o uso',
    usageWindowPin: ({ meter }: { meter: string }) => `Mostrar ${meter} ao lado do compositor`,
    noLimitsBilledPerUse: 'Nenhum limite informado · cobrado por uso',
    needsYouCount: ({ count }) => count === 1 ? '1 precisa de você' : `${count} precisam de você`,
    connectToolsTitle: 'Conecte um host de código ou ferramenta',
    inviteTitle: ({ names }) => `Seus agentes também podem usar ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} pode entrar com ele.`,
    inviteWhoMany: ({ agents }) => `${agents} podem entrar com eles.`,
    inviteTools: 'Ou conecte um host de código e ferramentas.',
    firstRunTitle: 'Use os planos que você já paga',
    firstRunPromise: 'Conecte sua conta do Claude ou ChatGPT uma vez. Seus agentes a usam em todas as máquinas, e o Happier mostra quanto resta antes de atingir um limite.',
    connectAnAccount: 'Conectar uma conta',
    firstRunMeanwhile: 'Até lá, cada agente usa o próprio login em cada máquina.',
    agentAccountsTitle: 'Contas dos agentes',
    agentAccountsDescription: 'Assinaturas e chaves que seus agentes usam. Salvas na sua conta, para que qualquer máquina possa usá-las.',
    codeAndToolsTitle: 'Código e ferramentas',
    setupChooseMachine: 'Escolha uma máquina para entrar. Depois a conta funciona em todas as suas máquinas.',
    setupHowToSignIn: 'Como entrar',
    setupRecommendedMethod: ({ method }) => `${method} · Recomendado`,
    setupCatalogTitle: 'Conectar um serviço',
    setupCatalogPurpose: 'O login é feito na máquina que você escolher. Depois a conta funciona em todas as suas máquinas.',
    setupServiceTitle: ({ service }) => `Conectar ${service}`,
    setupReconnectTitle: ({ service }) => `Entrar de novo no ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} usarão sua conta do ${service} em todas as máquinas.`,
    setupServicePurposeNoAgents: 'A conta funciona em todas as máquinas.',
    setupForYourAgents: 'Para seus agentes',
    setupOwnLoginTitle: 'Já entrou em uma máquina?',
    setupOwnLoginBody: 'Continue usando o login próprio do agente. Escolha em Como as contas são usadas.',
    setupToolsTitle: 'Hosts de código e ferramentas',
    setupProvidersPointer: 'Provedores de modelos como OpenRouter e Ollama são configurados em Provedores.',
    setupOpenProviders: 'Abrir Provedores',
    setupTrust: 'Salvo na sua conta e usado só pelas suas máquinas. O Happier mantém o login em dia para você.',
    setupConnectedCount: ({ count }) => `${count} conectadas`,
    settleConnectedAs: ({ identity }) => `Conectada agora como ${identity}.`,
    settleConnected: 'Conectada agora.',
    settleUseFor: ({ agent }) => `Usar para o ${agent}?`,
    settleUseForAction: ({ agent }) => `Usar para o ${agent}`,
    notNow: 'Agora não',
    homeInvitePromise: 'Conecte o Claude ou o ChatGPT uma vez. Todas as máquinas podem usar, e você vê aqui quanto resta.',
    homeInviteHide: 'Ocultar',
    homeNextWho: ({ agents }) => `${agents} também pode usar`,
    oauthStepOpen: 'Abra a página de login no navegador',
    oauthStepApprove: 'Aprove e copie o código exibido (ou o endereço em que você chegar)',
    oauthStepPaste: 'Cole aqui',
    oauthPastePlaceholder: 'Cole o código ou endereço',
    oauthShapeOk: 'Parece um código de login',
    deviceEnterAt: ({ where }) => `Digite este código em ${where}`,
    deviceExpired: 'O código expirou. Nada foi salvo.',
    deviceExpiresIn: ({ time }) => `O código expira em ${time}`,
    deviceNewCode: 'Obter um novo código',
    detailSignedOutTitle: ({ service }) => `O ${service} encerrou a sessão desta conta`,
    detailSignedOutBody: 'O login foi revogado ou alterado, por exemplo após uma troca de senha. As sessões não podem usar esta conta até você entrar de novo.',
    detailSignInTitle: 'Login',
    detailSignInNeeded: 'Precisa entrar de novo',
    detailSignInKeptFresh: 'O Happier a mantém em dia',
    detailLastUsed: ({ time }) => `último uso ${time}`,
    detailLeavePool: ({ pool }) => `Remover de ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} usa esta conta; remova-a primeiro do grupo. Remover apaga da sua conta e de todas as máquinas.`,
    detailUsageSignedOut: 'Último valor conhecido · não atualiza sem login',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Último valor conhecido às ${time} · não atualiza sem login`,
    detailResetsIn: ({ countdown }) => `em ${countdown}`,
    detailUsedByTitle: 'Usado por',
    detailUsedByDefault: 'A conta padrão dele',
    detailUsedByPool: ({ pool }) => `Por meio de ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Por meio de ${pool} · em uso agora`,
    detailUsedByCould: 'Podem usar · hoje entram do próprio jeito',
    detailWorksOnTitle: 'Funciona em',
    detailWorksOnDescription: 'Salva na sua conta. Uma máquina a usa quando uma sessão começa nela; nada é copiado antes.',
    detailSignedInWithCode: 'Entrou com um código',
    detailSignedInWithBrowser: 'Entrou pelo navegador',
    detailAddedWithKey: 'Adicionada com uma chave',
    nearLimitTitle: ({ account, percent, window }) => `${account} tem ${percent}% do limite de ${window}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Resta ${percent}% do limite de ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Reinicia às ${time}. Aplique uma redefinição de uso para continuar agora.`,
    nearLimitBody: 'Aplique uma redefinição de uso para continuar agora.',
    nearLimitApplyReset: 'Aplicar redefinição',
    catalogSignInBrowserOrCode: 'Entre pelo navegador ou com um código',
    catalogSignInBrowserOrKey: 'Entre pelo navegador ou cole um token',
    catalogSignInBrowser: 'Entre pelo navegador',
    catalogSignInCode: 'Entre com um código',
    catalogPasteKey: 'Cole uma chave',
    deviceOpenService: ({ service }) => `Abrir ${service}`,
    deviceWaitingFor: ({ service }) => `Aguardando sua aprovação no ${service}…`,
};

const connectedServicesSettingsTranslations = { pt };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { pt: {
        connectMoreTitle: 'Conectar mais',
        connectMoreDescription: 'Serviços aceitos pelos agentes nas suas máquinas que você ainda não conectou.',
        connectMoreNothingNew: 'Adicione outra conta, um host de código ou uma ferramenta.',
        serviceSignInInstead: ({ agents }) => `${agents} pode entrar com ele em vez do login de cada máquina.`,
        serviceCanUse: ({ agents }) => `${agents} pode usá-lo.`,
        moreServicesTitle: 'Mais serviços',
        moreServicesTools: ({ names }) => `${names} e mais, para código e ferramentas.`,
        moreServicesAll: 'Tudo o que seus agentes e ferramentas aceitam.',
        browse: 'Explorar',
        notNow: ({ service }) => `Agora não: ${service}`,
        notNowTooltip: 'Agora não · continua em Explorar',
        back: 'Todos os serviços',
        homeCatalogTitle: 'Conectar uma conta',
        homeCatalogPurpose: 'Seus agentes a usam em todas as máquinas, e o Home mostra quanto resta.',
        homeNextSubtitle: ({ agents }) => `${agents} pode usá-la em vez do login de cada máquina.`,
        firstRunMore: 'Chaves de API, hosts de código e ferramentas',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Adicionar a ${pool}, para que ${agent} passe para ela quando ${active} acabar?`,
        settleAddToPoolShort: ({ pool }) => `Adicionar a ${pool}?`,
        settleAddToPool: ({ pool }) => `Adicionar a ${pool}`,
        deviceStepCopy: 'Copie este código',
        deviceStepOpen: ({ service }) => `Abra ${service} e digite-o`,
        deviceStepOpenWhere: ({ where }) => `${where}, conectado à conta que você quer usar`,
        deviceStepApprove: ({ service }) => `Aprove o Happier em ${service}`,
        deviceCheckNow: 'Verificar agora',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "pt">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { pt: {
        approval: {
            requestTitle: 'Pedido',
            requestDescription: 'O que foi pedido e em que ponto está.',
            failureTitle: 'Porque falhou',
            homeUnavailableTitle: 'Home indisponível',
            contextTitle: 'Pedido por',
            contextDescription: 'A sessão e o agente que fizeram o pedido.',
            proposalsDescription: 'Publicados na revisão se aprovar.',
        },
        runs: {
            description: 'Execuções em segundo plano nas suas máquinas.',
            filterLabel: 'Execuções apresentadas',
            filterRunning: 'Em curso',
            filterAll: 'Todas',
            onHome: ({ home }) => `Em ${home}`,
        },
        person: {
            placeholderTitle: 'Pessoa',
            friendshipTitle: 'Amizade',
            sharedSessionsDescription: 'Sessões que este amigo partilha consigo, só de leitura.',
            linkedAccountsTitle: 'Contas associadas',
            linkedAccountsDescription: 'Onde mais inicia sessão. Abre no navegador.',
        },
        friendsManage: {
            description: 'As pessoas com quem trabalha no Happier e os pedidos entre vocês.',
            requestsTitle: 'Pedidos de amizade',
            requestsDescription: 'Abra um pedido para o aceitar ou recusar.',
            sentTitle: 'Pedidos enviados',
            sentDescription: 'À espera que aceitem.',
            friendsTitle: 'Amigos',
            friendsDescription: 'Abra um amigo para ver o que partilha consigo.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "pt">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { pt: {
        closeUnsavedTabA11y: 'Fechar aba, tem alterações não salvas',
        emptyTitle: 'Arquivos, alterações e commits abrem aqui',
        browseFiles: 'Explorar arquivos',
        previewHint: 'Um clique abre uma prévia; abra de novo para manter a aba.',
        emptyReason: 'Os arquivos, alterações e commits que você abre aparecem aqui, ao lado de onde você os abriu.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisar 1 alteração' : `Revisar ${count} alterações`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 arquivo mudou nesta sessão. Leia-o aqui sem sair da conversa.'
            : `${count} arquivos mudaram nesta sessão. Leia-os aqui sem sair da conversa.`),
        splitNeedsWiderPane: 'A visualização lado a lado precisa de um painel mais largo. Amplie Detalhes ou use Foco.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "pt">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { pt: {
        areaUnstaged: 'Não preparados',
        areaStaged: 'Preparados',
        areaBoth: 'Ambos',
        areaLabel: 'Alterações',
        preview: 'Pré-visualizar',
        viewLabel: 'Exibição',
        compare: 'Comparar',
        stage: 'Preparar',
        unstage: 'Remover da preparação',
        addToCommit: 'Adicionar ao commit',
        removeFromCommit: 'Remover do commit',
        editing: 'Editando',
        editingUnsaved: 'Editando · alterações não salvas',
        statusModified: 'Modificado',
        statusAdded: 'Adicionado',
        statusDeleted: 'Excluído',
        statusRenamed: 'Renomeado',
        statusCopied: 'Copiado',
        statusUntracked: 'Novo, ainda não rastreado',
        statusConflicted: 'Tem conflitos',
        noChanges: 'Sem alterações',
        lines: ({ count }) => (count === 1 ? '1 linha' : `${count} linhas`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "pt">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { pt: {
        copyCommitSha: 'Copiar o SHA do commit',
        filesChanged: ({ count }) => (count === 1 ? '1 arquivo alterado' : `${count} arquivos alterados`),
        files: ({ count }) => (count === 1 ? '1 arquivo' : `${count} arquivos`),
        revertEllipsis: 'Reverter…',
        stashKeptOn: ({ branch }) => `Guardado em ${branch}`,
        stashOriginBranch: ({ branch }) => `Salvo quando você saiu de ${branch}`,
        stashOriginBranchShort: 'Ao trocar de branch',
        stashOriginTransient: 'Salvo pelo Happier',
        stashOriginUnmanaged: 'Criado fora do Happier',
        stashRestoreExplains: ({ folder }) => `Restaurar coloca estas alterações de volta em ${folder} e remove o stash. Nada mais muda na pasta.`,
        stashApply: 'Aplicar',
        stashApplyA11y: 'Aplicar estas alterações e manter o stash',
        stashDiscardEllipsis: 'Descartar…',
        stashSwitcherA11y: 'Escolher um stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "pt">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { pt: {
        title: 'Revisão',
        files: ({ count }) => (count === 1 ? `1 arquivo` : `${count} arquivos`),
        nextCommit: ({ count }) => `${count} no próximo commit`,
        changedFiles: 'Arquivos alterados',
        commitColumn: 'Commit',
        jumpA11y: 'Ir para um arquivo',
        comments: ({ count }) => (count === 1 ? `1 comentário` : `${count} comentários`),
        goesWithNext: ({ count }) => (count === 1 ? `vai com sua próxima mensagem` : `vão com sua próxima mensagem`),
        askForChanges: 'Pedir alterações',
        detachCommentA11y: 'Deixar este comentário fora da próxima mensagem',
        trayExpandedHint: 'Eles vão com sua próxima mensagem para o agente.',
        askPlaceholder: 'Diga ao agente o que mudar…',
        send: 'Enviar',
        draftAuthor: 'Você', draftStatus: 'rascunho', includeComment: 'Vai com sua próxima mensagem',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "pt">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { pt: translated({
        settingsEmbeds: {
            title: "Incorporações",
            newTitle: "Nova incorporação",
            purpose: "Deixe outros apps mostrarem chats do Happier, só com o acesso que você escolher.",
            yourEmbeds: "Suas incorporações",
            newEmbed: "Nova incorporação",
            listError: "Não foi possível carregar as incorporações",
            emptyTitle: "Coloque um chat do Happier no seu próprio app",
            emptyBody: "Seu app mostra conversas reais, só com o acesso que você escolher: quais sites, quem pode enviar ou aprovar e quais modelos.",
            createDescription: "Escolha o que outros apps podem fazer com seus chats e como eles aparecem.",
            name: "Nome",
            nameDescription: "Visível só para você, nesta lista.",
            namePlaceholder: "Por exemplo, painel de leads",
            create: "Criar incorporação",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 site' : `${count} sites`,
                send: "Pode enviar",
                sendAndApprove: "Pode enviar e aprovar",
                viewOnly: "Só visualizar",
                modelOnly: ({ name }: { name: string }) => `só ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 modelo' : `${count} modelos`,
            },
            sites: {
                title: "Onde pode aparecer",
                description: "Os chats só abrem nestes sites.",
            },
            capabilities: {
                title: "O que as pessoas podem fazer",
                view: "Ver a conversa",
                always: "Sempre",
                send: "Enviar mensagens",
                sendDescription: "Inclui parar o agente e anexar arquivos.",
                changeModel: "Trocar de modelo",
                permissionModes: "Modos de permissão",
                permissionModesDescription: "Os chats mostram um seletor de modo só quando mais de um modo é permitido.",
                anyMode: "Qualquer modo",
                anyModeDescription: "As pessoas podem mudar o quanto o agente faz sem perguntar.",
                modeOnly: ({ name }: { name: string }) => `só ${name}`,
                modes: ({ count }: { count: number }) => `${count} modos`,
                approveOn: "As pessoas nestes sites podem aprovar o uso de ferramentas e as solicitações nestes chats.",
            },
            models: {
                title: "Modelos",
                description: "Outros modelos são recusados, não apenas ocultados. Os chats começam no primeiro modelo permitido.",
                allowed: "Modelos permitidos",
                any: "Qualquer modelo",
            },
            organization: {
                title: "Organização",
                description: "Seu app lista daqui os chats desta incorporação (com qualquer uma destas etiquetas). Novos chats também chegam aqui.",
                folder: "Pasta",
                tags: "Etiquetas",
                none: "Nenhuma",
            },
            composer: {
                title: "Escrita",
                attachments: "Anexos",
                attachmentsDescription: "Oculta o botão de anexar. Quem pode enviar ainda pode anexar arquivos pela API.",
            },
            sessions: {
                title: "Sessões",
                description: "As sessões que esta chave cria, pelo seu servidor ou pelo chat, rodam neste computador com este agente e ficam na pasta e nas etiquetas acima.",
                allow: "Permitir que esta chave crie sessões",
                offConsequence: "Esta chave não pode criar sessões. Seu app só pode mostrar chats que já existem.",
                computer: "Computador",
                agent: "Agente",
                newChat: "Iniciar novos chats na incorporação",
                appSetting: "Para seu aplicativo",
                newChatDescription: "Mostra uma caixa de novo chat quando seu app abre a incorporação sem um chat. É uma configuração para o seu app, não um limite de segurança: seu servidor sempre pode criar chats com esta chave.",
            },
            appearance: {
                title: "Aparência",
                description: "A pré-visualização acompanha cada mudança. Os chats abertos se atualizam sem recarregar.",
                mode: "Modo",
                modeSystem: "Sistema",
                modeLight: "Claro",
                modeDark: "Escuro",
                theme: "Tema",
                presetHappier: "Happier",
                colors: "Cores",
                colorsDefault: "Cores do Happier",
                colorsCustomized: ({ count }: { count: number }) => count === 1 ? '1 personalizada' : `${count} personalizadas`,
                colorsFor: "Cores para",
                colorGroups: {
                    surface: "Superfícies",
                    text: "Texto",
                    accent: "Destaque",
                    messages: "Mensagens",
                    composer: "Escrita",
                    approvals: "Aprovações",
                },
                fontFamily: "Fonte",
                fontFamilyPlaceholder: "Fonte do Happier",
                fontFile: "Arquivo de fonte",
                fontFileDescription: "Um link https para um arquivo .woff2 ou .woff.",
                fontFileRefused: "Use um link para um arquivo .woff2 ou .woff, não uma folha de estilos.",
                textSize: "Tamanho do texto",
                textSizeCompact: "Compacto",
                textSizeDefault: "Padrão",
                textSizeLarge: "Grande",
                corners: "Cantos",
                cornersSharp: "Retos",
                cornersSoft: "Suaves",
                cornersRound: "Redondos",
                density: "Densidade",
                densityCompact: "Compacta",
                densityComfortable: "Confortável",
                reset: "Redefinir aparência",
            },
            preview: {
                title: "Pré-visualização ao vivo",
                phone: "Telefone",
                desktop: "Computador",
                reduceMotion: "Reduzir movimento",
                note: "O chat incorporado real com mensagens de exemplo. Nada é enviado.",
                rowDescription: "Veja o chat com estas configurações.",
                unavailable: "Pré-visualização indisponível",
            },
            snippets: {
                title: "Trechos de código",
                description: "Cole-os no seu app. Eles já usam as configurações desta incorporação.",
                steps: "1 Guarde a chave como HAPPIER_EMBED_KEY · 2 Escreva canOpenSession: quem pode abrir qual chat · 3 Mostre o chat",
                backend: "Servidor",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Criada em ${date}`,
                lastUsed: ({ date }: { date: string }) => `Último uso ${date}`,
                expires: ({ date }: { date: string }) => `Expira em ${date}`,
                reconnect: "Os chats abertos se reconectam com o novo acesso. Os rascunhos são mantidos.",
                e2eeTrust: "Esta chave pode ler os chats criptografados desta conta. Use uma conta dedicada para o seu app.",
                keyReach: "A chave fica no seu servidor e alcança todos os chats desta conta. Os navegadores nunca a veem: recebem chaves de curta duração limitadas aos chats que o seu servidor permite.",
                expiry: "A chave expira",
                expiryDescription: "Quando a chave expira, os chats deixam de abrir. Ela não pode ser estendida depois.",
                encryptionChecking: "Verificando a criptografia desta conta…",
                encryptionUnavailable: "Este dispositivo ainda não consegue ler os chats criptografados desta conta. Restaure sua chave secreta para criar a incorporação.",
                encryptionStale: "As chaves deste dispositivo para chats criptografados estão desatualizadas. Restaure sua chave secreta para criar a incorporação.",
                encryptionUnreadable: "Não foi possível verificar a criptografia desta conta.",
                missingTitle: "Esta incorporação não existe mais",
                backToEmbeds: "Voltar para incorporações",
            },
            delete: {
                button: "Excluir incorporação",
                title: ({ label }: { label: string }) => `Excluir “${label}”?`,
                body: "Os chats abertos são desconectados. Chaves já usadas para ler chats criptografados não podem ser revogadas retroativamente.",
                confirm: "Excluir",
            },
            reveal: {
                copyEnv: "Copiar como linha .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { pt: translated({
        embed: {
            errors: {
                originNotAllowed: 'Esta página não pode mostrar esta conversa.',
                originNotAllowedReason: 'Adicione este site aos sites permitidos da incorporação no Happier.',
                unavailable: 'Esta conversa não está disponível aqui.',
                encrypted: 'Esta conversa está criptografada e não pode ser aberta aqui.',
                createNotGranted: 'Este app não pode iniciar novos chats.',
                unsupportedVersion: 'Este chat precisa de uma incorporação mais recente.',
                unsupportedVersionReason: 'Atualize @happier-dev/embed neste app.',
            },
            nothingToShow: 'Nada para mostrar ainda',
            nothingToShowReason: 'Este app ainda não abriu nenhuma conversa.',
            reconnecting: 'Reconectando…',
            previewUnavailable: 'Pré-visualização indisponível',
            previewUser: "Analise este lead e registre o resultado: Acme Robotics, 40 licenças, avaliando no quarto trimestre.",
            previewAgent: "Encaixe excelente. O orçamento está confirmado e o patrocinador decide. Registrei a análise:",
            previewFollowUp: "Movemos este lead para qualificado?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const pt: EntityDragDropTranslations = {
    files: { attach: "Anexar", uploadHere: "Enviar aqui" },
    composer: { addContext: "Adicionar contexto", consequence: "Enviado com sua próxima mensagem · nada é enviado ainda", target: "Editor", readOnly: "Este editor é somente leitura", otherWorkspace: "Não faz parte deste espaço de trabalho", unavailable: "Esta referência está indisponível" },
    surface: {
        scopeMismatch: 'Está em outro Home ou conta',
        widgetMoveUnavailable: 'Este widget não pode ser movido para esta superfície',
        readOnly: 'Este quadro é somente leitura',
        copyDetail: 'Mantém uma referência · o quadro não muda',
    },
    preview: {
        putUnder: ({ target }) => `Colocar sob ${target}`,
        putUnderDetail: 'Reporta a ela · as duas continuam em execução',
        moveAbove: ({ target }) => `Mover para cima de ${target}`,
        moveBelow: ({ target }) => `Mover para baixo de ${target}`,
        orderDetail: 'Só a ordem · ninguém reporta a ninguém',
        moveToFolder: ({ folder }) => `Mover para ${folder}`,
        folderDetail: 'Só a pasta · não reporta a ninguém',
        moveToTopLevel: 'Mover para o nível superior',
        topLevelDetail: 'Fora da pasta · nada mais muda',
        cantPutUnder: ({ target }) => `Não é possível colocar sob ${target}`,
        cantMoveHere: 'Não é possível movê-la para aqui',
        pendingPutUnder: ({ target }) => `Colocando sob ${target}…`,
        pendingDetail: 'Aguardando a confirmação do Home',
        unknownTitle: 'Não é certo que tenha sido movida',
        unknownDetail: 'Confira a lista daqui a pouco antes de tentar de novo',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `Não foi possível colocar ${item} sob ${target}`,
        refused: ({ verb }) => `${verb}: não foi concluído`,
        unknown: ({ verb }) => `Não está claro se “${verb}” foi concluído`,
        dismiss: 'Dispensar',
    },
    reasons: {
        read: 'Foi compartilhada com você só para leitura, então não pode receber relatórios',
        input: 'Você não pode enviar nada a ela, então não pode receber relatórios',
        pairwise: 'Estas duas sessões não podem compartilhar contexto',
        cycle: 'Essa sessão já reporta a esta',
        alreadyUnder: 'Já reporta a esta',
        archived: 'Está arquivada',
        differentHome: 'Está em outro Home. As sessões reportam dentro de um mesmo Home',
        unavailable: 'Não foi possível verificar esta sessão agora',
        dateOrder: 'Esta lista está ordenada por data. Mude para a ordem personalizada para posicioná-la',
        noChange: 'Já está aqui',
        descendantCycle: 'Uma pasta não pode ir para dentro de si mesma',
        maxDepth: 'As pastas ficariam aninhadas demais',
        foldersOff: 'As pastas estão desativadas neste Home',
        gone: 'Esse lugar acabou de desaparecer',
        generic: 'Este lugar não pode recebê-la',
    },
    chooser: { putUnderTitle: ({ item }) => `Colocar ${item} sob…`, checking: 'Verificando quais sessões podem receber relatórios…', cantTakeReports: 'Não podem receber relatórios', unavailable: 'Indisponível' },
    keyboard: {
        choose: 'Escolha um lugar', putUnder: 'Colocar sob', topLevel: 'Nível superior', drop: 'Soltar', cancel: 'Cancelar', escapeKey: 'Esc',
        hintsA11y: 'As setas escolhem um lugar, Enter solta, Esc cancela',
    },
    organize: { enter: 'Organizar a lista', title: 'Organizar', done: 'Concluído', grip: ({ item }) => `Mover ${item}` },
    pane: {
        openHere: 'Abrir aqui como aba',
        nextTo: ({ target }) => `Ao lado de ${target} · nada fecha`,
        nothingCloses: 'Abre como aba · nada fecha',
        tooNarrow: 'Este painel é estreito demais para dividir',
        moveHere: 'Mover para cá como aba',
        openBefore: ({ target }) => `Abrir antes de ${target}`,
        moveBefore: ({ target }) => `Mover para antes de ${target}`,
        placeOnly: 'Só muda de lugar',
        splitLeft: 'Dividir à esquerda',
        splitRight: 'Dividir à direita',
        splitUp: 'Dividir acima',
        splitDown: 'Dividir abaixo',
        opensBeside: ({ target }) => `Abre ao lado de ${target}`,
        movesBeside: ({ target }) => `Vai para o lado de ${target}`,
        goTo: ({ target }) => `Ir para ${target}`,
        openInThisPane: 'Já está aberta neste painel · nada novo abre',
        openInAnotherPane: 'Já está aberta em outro painel · nada novo abre',
        alreadyHere: 'Já está aqui',
        leaveIt: 'Solte para deixá-la onde está',
        cantOpenHere: 'Não dá para abrir aqui',
        sessionsOnly: 'Este painel mostra apenas sessões',
        otherWorkspace: 'Não faz parte deste espaço de trabalho',
    },
};

const entityDragDropTranslations = { pt };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const pt = {
    eventAutomationComposer: {
        available: 'Disponível',
        payloadFields: 'CAMPOS DE CARGA',
        payloadSample: 'Exemplo de carga útil',
        noFilterableFields: 'Este evento não declara campos de carga filtráveis.',
        addFilterClause: 'Adicionar condição',
        filterField: 'Campo de filtro',
        filterOperator: 'Operador de filtro',
        filterEquals: 'Igual',
        filterOneOf: 'É um dos',
        filterValue: 'Valor do filtro',
        filterValuePlaceholder: '"valor" ou ["valor"]',
        storedContentUnavailableTitle: 'Conteúdo de automação armazenado indisponível',
        storedContentUnavailableBody: 'Esta automação de evento não pode ser salva porque seu conteúdo armazenado não está disponível.',
        historyGapRecoveryTitle: 'A lacuna histórica precisa de atenção',
        historyGapRecoverySubtitle: 'Redefina a linha de base de origem para retomar a observação de novos eventos.',
        historyGapRecoveryUnavailable: 'A ação de recuperação de origem não está disponível no inspetor atual.',
        historyGapRecoveryFailureTitle: 'A recuperação da fonte precisa de outra tentativa',
        historyGapRecoveryFailureBody: 'A recuperação não foi confirmada. A fonte ainda precisa de atenção.',
        sourceStatusTitle: 'Fonte de observação',
        sourceStatusState: {
            uninitialized: 'Não iniciada',
            baselined: 'Linha de base pronta',
            observing: 'Observando',
            backingOff: 'Aguardando nova tentativa',
            attention: 'Precisa de atenção',
        },
        sourceStatusCode: {
            credentialMissing: 'Credenciais necessárias',
            credentialRevoked: 'Credenciais revogadas',
            rateLimited: 'Limite de frequência atingido',
            historyGap: 'Lacuna no histórico',
            capacityBlocked: 'Capacidade esgotada',
            definitionStale: 'Definição alterada',
            sourceContractIncompatible: 'A fonte precisa ser atualizada',
            admissionUnavailable: 'Admissão indisponível',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Próxima tentativa: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Eventos observados: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Eventos admitidos: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Eventos ignorados: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Última observação: ${time}`,
        sourceCatalogStatusTitle: 'Reconciliação do catálogo',
        sourceCatalogStatusState: {
            current: 'Atual',
            reconciling: 'Em reconciliação',
            reconciliationLate: 'Reconciliação atrasada',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Revisão observada: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Revisão adotada: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Nenhuma revisão adotada ainda',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Verificação iniciada: ${time}`,
    },
};

const eventAutomationComposerTranslations = { pt } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { pt: {
    browseLinked: 'Ligada',
    browseImported: 'Importada',
    browseAgentUnavailable: 'O Happier não conseguiu iniciar nem alcançar o Agent selecionado nesta máquina. Verifique se a CLI dele está instalada e tente novamente.',
    browseAgentTimedOut: 'O Agent selecionado nesta máquina não respondeu a tempo. Pode estar ocupado ou ainda a indexar, por isso tente novamente.',
    browseAgentFailed: 'O Happier não conseguiu ler as sessões do Agent selecionado nesta máquina. Tente novamente; se continuar a falhar, atualize o Happier nessa máquina.',
    operationTitleMaterialize: 'Importar para o Happier',
    operationTitleTakeoverLinked: 'Assumir controlo e manter ligação',
    operationTitleTakeoverPersisted: 'Importar e assumir controlo',
    operationMaterializeAvailable: 'Importe esta sessão ligada para usar a transcrição offline ou partilhá-la.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} em ${machine}: ${status}`,
    operationStatusRunning: 'Em curso',
    operationStatusCancelling: 'A cancelar…',
    operationStatusCancelled: 'Cancelada',
    operationStatusCompleted: 'Concluída',
    operationStatusDiscarded: 'Sessão parcial eliminada',
    operationStatusNeedsResume: 'À espera que retome',
    operationStatusNeedsReview: 'Requer revisão antes de continuar',
    operationStatusFailed: 'Não foi possível continuar',
    operationStatusImportIncomplete: 'Importação incompleta — Retome ou elimine a sessão parcial',
    operationStatusUpdateIncomplete: 'Atualização incompleta — Retome',
    operationStatusOriginOffline: 'Progresso guardado — a máquina de origem está offline',
    operationStatusOriginUnknown: 'Progresso guardado — o Happier não consegue saber se a máquina de origem está online',
    operationStatusExternalWriter: 'Foi detetada uma escrita externa',
    operationStatusSpawnFailedAfterImport: 'Importada, mas não foi possível iniciar o Agent — Tentar iniciar novamente',
    operationStatusSpawnFailedAfterTakeover: 'Controlo assumido, mas não foi possível iniciar o Agent — Tentar iniciar novamente',
    operationErrorSourceUnavailable: 'A origem não está disponível. Volte a ligar a máquina de origem e retome.',
    operationErrorSourceChanged: 'A origem mudou durante a leitura. Reveja-a antes de retomar.',
    operationErrorCapacity: 'Esta máquina não tem capacidade temporária suficiente para continuar.',
    operationErrorRequiredItems: 'Não foi possível importar alguns elementos obrigatórios da sessão.',
    operationErrorImport: 'A importação das mensagens foi interrompida.',
    operationErrorPublication: 'Não foi possível publicar o instantâneo importado.',
    operationErrorAdmission: 'O Happier não conseguiu assumir o controlo desta sessão em segurança.',
    operationErrorExternalWriter: 'Pare o Agent externo antes de tentar novamente. O Happier não o irá combinar nem parar automaticamente.',
    operationErrorInternal: 'A operação parou devido a um erro interno.',
    operationPhaseValidating: 'Validação',
    operationPhaseWaitingForAgent: 'À espera que o Agent externo pare',
    operationPhaseReadingSource: 'Leitura da origem',
    operationPhaseImporting: 'Importação de mensagens',
    operationPhaseCatchingUp: 'Sincronização com a origem',
    operationPhasePreparingRuntime: 'Preparação do runtime',
    operationPhaseStartingRuntime: 'Início do runtime',
    operationPhaseFinalizing: 'Finalização',
    operationPhasePublishing: 'Publicação da sessão importada',
    operationActionResume: 'Retomar',
    operationActionRetryStart: 'Tentar iniciar novamente',
    operationActionCancel: 'Cancelar',
    operationActionDiscard: 'Eliminar sessão parcial',
    operationActionDismiss: 'Fechar',
    operationStatusOwnerReadFailed: 'O Happier não conseguiu ler o progresso atual desta operação.',
    operationActionCheckAgain: 'Verificar novamente',
    operationComposerImporting: 'A importar…',
    operationComposerTakingOver: 'A assumir o controlo…',
    operationActionErrorUpgradeRequired: 'Atualize o Happier na máquina de origem para usar esta ação.',
    operationActionErrorNotFound: 'Esta operação já não está disponível.',
    operationActionErrorConflict: 'Outra operação já está a controlar esta sessão.',
    operationActionErrorStaleRevision: 'A operação mudou. Reveja o progresso mais recente e tente novamente.',
    operationActionErrorInvalidState: 'Esta ação não está disponível no estado atual da operação.',
    operationActionErrorNotAllowed: 'Não tem permissão para controlar esta operação.',
    operationActionErrorUnavailable: 'Não foi possível concluir a ação. Tente novamente a partir do progresso mais recente.',
    operationImportProgress: 'Progresso da importação',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} mensagens importadas`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} de ~${total} mensagens`,
    operationPublishedSnapshot: 'Instantâneo publicado preservado',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Disponível até à mensagem ${sequence}`,
    operationDiscardConfirmTitle: 'Eliminar a sessão parcial?',
    operationDiscardConfirmBody: 'Isto elimina toda a sessão parcial. Esta ação não pode ser anulada.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `A transcrição desta sessão está em ${machine}. Importe-a para o Happier para a partilhar.`,
    sharingImportIncomplete: 'A importação está em curso ou incompleta. Retome-a antes de partilhar.',
    sharingTranscriptUnavailableTitle: 'Transcrição indisponível',
    transcriptRetainedRefreshFailedTitle: 'A mostrar a última transcrição conhecida',
    transcriptLoadFailed: 'O Happier não conseguiu carregar esta transcrição.',
    sharingTranscriptUnavailable: 'A transcrição não está disponível. Esta sessão ligada antiga não tem uma transcrição persistente segura.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Partilhada até ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Instantâneo de ${time}`,
    sharingUpdateSharedCopy: 'Atualizar cópia partilhada',
    sharingUpdateSharedCopyDescription: 'Atualize o instantâneo partilhado com a transcrição mais recente da origem.',
    sharingSourceMachineMissing: 'A máquina de origem não está disponível. Volte a ligá-la ao Happier antes de tentar novamente.',
    sharingSourceMachineOffline: 'A máquina de origem está offline. Coloque-a online antes de tentar novamente.',
    sharingActionAwaitingAvailability: 'Esta ação ficará disponível quando o fluxo de materialização estiver ligado.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { pt: {
    settingsIntegrationStatusNotInstalled: 'Não instalada',
    settingsIntegrationStatusEnabled: 'Instalada e ativa',
    settingsIntegrationStatusDisabled: 'Instalada e desativada',
    settingsIntegrationStatusNeedsAttention: 'Requer atenção',
    settingsIntegrationStatusUnsupported: 'Não suportada por esta versão do Agent',
    settingsIntegrationStatusUnavailable: 'Agent indisponível',
    settingsIntegrationInventoryLoadingTitle: 'A verificar o estado das integrações',
    settingsIntegrationInventoryLoadingSubtitle: 'A ler o inventário completo de integrações desta máquina.',
    settingsIntegrationInventoryPartialTitle: 'Estado das integrações incompleto',
    settingsIntegrationInventoryPartialSubtitle: 'Não foi possível ler alguns registos de instalação. Verifique novamente antes de fazer alterações.',
    settingsIntegrationInventoryErrorTitle: 'Estado das integrações indisponível',
    settingsIntegrationInventoryErrorSubtitle: 'O último estado conhecido pode estar desatualizado. Verifique novamente antes de fazer alterações.',
    settingsIntegrationTitle: 'Monitorização de sessões externas',
    settingsIntegrationNeedsAttentionTitle: 'Requer atenção',
    settingsIntegrationDiagnosticMessageUnavailable: 'Esta instalação requer atenção antes de a monitorização poder continuar.',
    settingsIntegrationRemediationRetry: 'Verifique novamente depois de resolver o problema.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Reveja a definição em ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Selecione uma conta para ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Instale a dependência necessária: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Consulte as orientações em ${url}.`,
    settingsIntegrationActionReviewInstall: 'Rever e instalar',
    settingsIntegrationActionDisable: 'Desativar',
    settingsIntegrationActionEnable: 'Ativar',
    settingsIntegrationActionUninstall: 'Desinstalar',
    settingsIntegrationActionCheckAgain: 'Verificar novamente',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Rever a integração de ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `O Happier só irá gerir estas entradas: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Reveja as alterações geridas pelo Agent antes de instalar.',
    settingsIntegrationPreviewNoMatcher: 'Todas as sessões correspondentes',
    settingsIntegrationActionInstall: 'Instalar',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Desinstalar a integração de ${agent}?`,
    settingsIntegrationUninstallBody: 'Isto remove apenas as entradas geridas pelo Happier. O resto da configuração do Agent permanece inalterado.',
    settingsIntegrationActionFailed: 'O Happier não conseguiu atualizar esta integração. Verifique a máquina e tente novamente.',
    settingsAutoLinkUpdateFailed: 'O Happier não conseguiu atualizar a ligação automática. Tente novamente.',
    settingsRestoreUpdateFailed: 'O Happier não conseguiu atualizar a preferência de sincronização após reiniciar. Tente novamente.',
    settingsIntegrationsGroupTitle: 'Monitorização de sessões externas',
    settingsIntegrationsFooter: 'O Happier só altera a configuração do Agent após uma ação explícita. Abrir esta página é uma operação só de leitura.',
    settingsIntegrationsUnavailableTitle: 'Nenhuma integração disponível',
    settingsIntegrationsUnavailableSubtitle: 'Ligue uma integração de Agent suportada para rever o respetivo estado e as ações disponíveis.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Adicionar automaticamente novas sessões de ${agent}`,
    settingsAutoLinkTitle: 'Adicionar automaticamente novas sessões externas',
    browseAutoLinkTitle: 'Adicionar automaticamente novas sessões',
    settingsAutoLinkGroupTitle: 'Ligação automática',
    settingsAutoLinkGroupFooter: 'A ligação automática está desativada por predefinição e é independente da configuração da integração do Agent e da sincronização em segundo plano.',
    settingsAutoLinkUnavailableTitle: 'Nenhuma origem de ligação automática disponível',
    settingsAutoLinkUnavailableSubtitle: 'Não existem âmbitos de origem suportados nesta máquina.',
    settingsAutoLinkSubtitle: 'Quando ativada, o Happier liga novas sessões suportadas desta origem sem abrir nem retomar o Agent.',
    settingsAutoLinkHint: 'Ativa ou desativa a ligação automática para esta origem.',
    settingsPrivacyGroupTitle: 'Privacidade',
    settingsPrivacyTitle: 'Observações limitadas e sem conteúdo',
    settingsPrivacySubtitle: 'As integrações de Agent fidedignas podem inspecionar dados nativos limitados de hooks nesta máquina. O Happier só admite e sincroniza observações sem conteúdo; o anfitrião nunca guarda, sincroniza nem regista payloads, caminhos, credenciais, prompts, texto de transcrições ou argumentos de ferramentas.',
    settingsAgentActionsGroupTitle: 'Sessões externas',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Navegar pelas sessões externas de ${agent}`,
    settingsManageAllTitle: 'Gerir todas as definições de Sessões externas',
    settingsManageAllSubtitle: 'Reveja as integrações e a sincronização em segundo plano nas máquinas ligadas.',
    settingsMachineOnline: 'On-line',
    settingsMachineOffline: 'Off-line',
    settingsMachineTitle: 'Máquina',
    settingsMachineUnavailable: 'Nenhuma máquina ligada',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `A mostrar as primeiras ${count} — refine a pesquisa`,
    browseAnnotationsIncomplete: 'Não foi possível confirmar alguns estados. Abrir uma sessão verifica-o.',
    browseRouteUnavailableTitle: 'As sessões externas não estão disponíveis aqui',
    browseRouteUnavailableSubtitle: 'Este servidor não oferece a navegação de sessões externas. Volta atrás e escolhe outro servidor, ou tenta mais tarde.',
    browseRouteAvailabilityUnknownTitle: 'Não foi possível confirmar o suporte a sessões externas',
    browseRouteAvailabilityUnknownSubtitle: 'O Happier não conseguiu verificar se este servidor oferece a navegação de sessões externas. Volta atrás e tenta novamente daqui a pouco.',
    browseHeaderTitle: 'Sessões externas',
    browseSettingsLink: 'Definições das sessões externas',
    browseChooseMachineTitle: 'Escolher uma máquina',
    browseChooseMachineBody: 'As sessões externas vivem na máquina que as executou. Escolha uma para ver as suas sessões.',
    browseMachineGoneBody: 'Foi removida ou substituída. Escolha outra máquina para ver as suas sessões.',
    browseHomeUnreachableBody: 'As suas máquinas e sessões aparecem quando for possível contactá-lo. Entretanto, escolha outra máquina.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} está offline`,
    browseThisMachineOfflineTitle: 'Esta máquina está offline',
    browseMachineOfflineBody: 'As suas sessões aparecem assim que voltar a ligar-se.',
    browseChooseAnotherMachine: 'Escolher outra máquina',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Não foi possível contactar o Happier em ${machine}`,
    browseCantReachBody: 'A máquina está online, mas o serviço Happier não responde. Pode ainda estar a iniciar.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Nada para explorar em ${machine}`,
    browseNothingToBrowseBody: 'Nenhum dos agentes nesta máquina pode partilhar as suas sessões ainda.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Sem sessões de ${agent} em ${machine}`,
    browseEmptyBody: 'As sessões que iniciar nesta máquina aparecem aqui, prontas a abrir no Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Experimentar ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Nenhuma sessão corresponde a “${query}”`,
    browseErrorTitle: 'Não foi possível carregar as sessões',
    browseThisMachine: 'esta máquina',
    browseIndexingStop: 'Parar',
    browseThreadsFilter: 'Threads de subagentes',
    browseThreadsHidden: 'Só sessões principais',
    browseThreadsShown: 'Com threads de subagentes',
    browseThreadReviewer: 'Revisor',
    browseThreadSubagent: 'Subagente',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Revisor de ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Subagente de ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { pt: {
        changedOnly: 'Só alterados',
        showAllFiles: 'Mostrar todos os arquivos',
        viewOptions: 'Opções de visualização',
        sizeAndDate: 'Tamanho e data',
        newMenu: 'Novo arquivo, nova pasta ou upload',
        newFile: 'Novo arquivo',
        newFolder: 'Nova pasta',
        noChangedFilesTitle: 'Nada mudou',
        noChangedFilesReason: 'A cópia de trabalho corresponde ao último commit.',
        rootErrorTitle: ({ machine }) => `Não foi possível listar os arquivos em ${machine}`,
        rootErrorTitleUnnamed: 'Não foi possível listar os arquivos',
        workspaceUnavailableReason: 'O Happier não conseguiu identificar uma máquina e uma pasta para esta sessão.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "pt">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const pt: FindTranslations = {
    open: 'Buscar…',
    openedForMatch: 'Aberto para uma correspondência', foldAgain: 'Recolher novamente', showHiddenLines: ({ count }) => `Mostrar ${count} linhas ocultas`,
    surface: {
        chat: 'Localizar no chat',
        changes: 'Localizar nas alterações',
        file: 'Localizar no arquivo',
        terminal: ({ name }) => `Localizar em ${name}`,
    },
    previous: 'Correspondência anterior',
    next: 'Próxima correspondência',
    matchCase: 'Diferenciar maiúsculas',
    regex: 'Usar expressão regular',
    regexShort: 'Expressão regular',
    options: 'Opções de pesquisa',
    close: 'Fechar busca',
    done: 'Concluído',
    stop: 'Parar',
    noMatches: 'Nenhuma correspondência',
    noneFound: 'Nada encontrado',
    invalidPattern: 'Padrão inválido',
    offline: 'Sem conexão',
    unsupported: 'Não é possível buscar aqui',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'correspondência' : 'correspondências'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
    soFar: 'até agora',
    loaded: 'carregadas',
    note: {
        searchingOlder: 'Buscando nas mensagens anteriores, descriptografadas neste dispositivo',
        offlineOlder: 'Você poderá buscar nas mensagens anteriores quando voltar a ficar online.',
        terminalKept: ({ lines }) => `Busca feita nas últimas ${lines} linhas que este terminal mantém.`,
    },
};

const findTranslations = { pt };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const pt: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Adicionar pasta',
        noFolder: 'Sem pasta',
        noFolderDescription: 'O Happier mantém uma pasta privada para este chat',
        removeFolder: 'Remover pasta',
        a11y: {
            folder: ({ path }) => `Pasta: ${path}. Abre a escolha de pasta.`,
            none: 'Sem pasta. O Happier mantém uma pasta privada para este chat. Adicionar pasta.',
            loading: 'Carregando pasta',
            noFolderRow: 'Sem pasta, pasta privada para este chat',
            removed: 'Pasta removida',
            set: ({ path }) => `Pasta definida como ${path}`,
        },
    },
    display: {
        chats: 'Chats',
        untitledChat: 'Novo chat',
        folder: 'Pasta',
        privateToSession: 'Só desta sessão',
        sessionFiles: 'Arquivos da sessão',
        privateFolderOn: ({ machine }) => `Pasta privada em ${machine}`,
    },
};

const folderlessSessionTranslations = { pt: pt };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "pt": {
        "effectiveBrowserSolid": "Menus e controles flutuantes sólidos. Um navegador não pode mostrar seu desktop.",
        "effectiveFloatingSolid": "Controles flutuantes sólidos neste dispositivo.",
        "effectiveSolid": "Superfícies opacas neste dispositivo.",
        "effectiveBrowser": "Vidro em menus e controles flutuantes. Um navegador não pode mostrar seu desktop.",
        "effectiveBrowserCustom": "Seu material em menus e controles flutuantes. Um navegador não pode mostrar seu desktop.",
        "effectivePhone": "Vidro em controles flutuantes e folhas.",
        "effectiveLayered": "Vidro em camadas em toda esta janela.",
        "effectiveUniform": "Vidro uniforme em toda esta janela.",
        "effectiveCustom": "Vidro nesta janela conforme seus ajustes.",
        "effectiveUnavailable": "O vidro da janela está indisponível. Os controles flutuantes usam o material escolhido.",
        "effectiveInactive": "Opaco enquanto esta janela está inativa.",
        "effectiveTint": "Controles flutuantes coloridos; o desfoque de fundo está indisponível.",
        "description": "Deixe o desktop aparecer pela janela e a página sob os controles flutuantes.",
        "descriptionBrowser": "Deixe a página aparecer sob menus e controles flutuantes.",
        "descriptionPhone": "Deixe a página aparecer sob controles flutuantes e folhas.",
        "chromeDescription": "Barra de título, navegação e fundo da janela",
        "sidebarDescription": "Sua coluna de sessões",
        "contentDescription": "Conversa, compositor e painéis de trabalho",
        "floatingDescription": "Menus, popovers, folhas e controles flutuantes",
        "clear": "Transparente",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-clique · ${modifier}⇧L alterna claro e escuro`
    } } as const;

const glassAppearanceTranslations = { pt: { iosReduceTransparencyPath: "Ajustes › Acessibilidade › Tela e Tamanho do Texto › Reduzir Transparência", title: 'Vidro', material: 'Material', solid: 'Sólido', auto: 'Automático', everywhere: 'Em todo lugar', custom: 'Personalizado', blur: 'Desfoque', off: 'Desativado', opacity: 'Opacidade', customize: 'Personalizar', chrome: 'Moldura da janela', sidebar: 'Barra lateral', content: 'Conteúdo', floating: 'Superfícies flutuantes', appearance: 'Aparência', moreSettings: 'Mais ajustes de aparência…', customizeLink: 'Personalizar…', toolbarTitle: 'Botão Aparência', toolbarDescription: 'Mostra Aparência na barra. Um clique com modificador alterna claro e escuro.', reduceTransparency: 'Sólido porque Reduzir transparência está ativado', osSettings: 'Abrir ajustes de acessibilidade', themeCommand: 'Alternar claro e escuro', autoDescription: "Adapta-se ao dispositivo: vidro em camadas nas janelas compatíveis e nas superfícies flutuantes do telefone.", osSettingsUnavailable: "Não foi possível abrir os ajustes de acessibilidade. Abra-os nos ajustes do dispositivo.", ...effectiveTranslations["pt"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "pt">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const pt: typeof en = {
    row: {
        notSet: 'Não definida',
    },
    keepGoing: {
        title: 'Continuar até terminar',
        nativeDescription: ({ agent }) => `${agent} continua a trabalhar para a meta por conta própria.`,
        description: ({ rounds }) => `Depois de cada um dos seus turnos, um agente verifica a meta e continua até ela ser cumprida, o orçamento acabar ou deixar de haver progresso, no máximo ${rounds} ${rounds === 1 ? 'rodada' : 'rodadas'}.`,
        roundsPrefix: 'Parar após',
        roundsSuffix: 'rodadas',
        roundsLabel: 'Rodadas antes de parar',
        strikesPrefix: 'Parar após',
        strikesSuffix: 'verificações sem progresso',
        strikesLabel: 'Verificações sem progresso antes de parar',
        secondOpinionTitle: 'Pedir uma segunda opinião antes de terminar',
        secondOpinionDescription: 'Antes de a meta ser marcada como concluída, um segundo agente verifica-a. Se discordar, recebe uma notificação e a meta continua aberta.',
        budgetUnreported: ({ agent }) => `${agent} não informa o uso de tokens, por isso só se aplicam as rodadas e as verificações de progresso.`,
    },
};

const goalControlTranslations = { pt };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { pt: {
        addressIsSignInService: 'Este endereço pertence a um serviço de início de sessão. Inicie sessão através dele para encontrar os seus Homes.',
        mixedContent: 'Este navegador não pode ligar-se a um Home HTTP a partir de uma página HTTPS. Abra o Happier através de HTTP ou utilize um endereço HTTPS para o Home.',
        connectedToHome: ({ home }) => `${home} está ligado a este dispositivo.`,
        openHome: ({ home }) => `Abrir ${home}`,
        showAllHomes: 'Mostrar todos os Homes',
        otherSignInService: 'Outro serviço de início de sessão',
        otherSignInServiceSubtitle: 'Um serviço auto-hospedado ou da empresa',
        signInServiceAddress: 'Endereço do serviço',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "pt">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { pt: {
        ...starterPrompts,
        suggestionsLabel: 'Sugestões',
        summarizeProjectSince: ({ project, day }) => `Resuma o que mudou em ${project} desde ${day}`,
        summarizeProjectToday: ({ project }) => `Resuma o que mudou hoje em ${project}`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 sessão desde ${day}` : `${count} sessões desde ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 sessão hoje' : `${count} sessões hoje`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "pt">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { pt: {
        title: 'Aprovações de dispositivos', deviceFallback: 'Novo dispositivo',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Expira: ${expiry}`,
        requestDetails: 'Detalhes do pedido', requestDetailsHint: 'Mostrar o identificador da chave do pedido',
        fingerprintLabel: 'Impressão digital da chave do pedido', requestDetailsHelp: 'Isto identifica a chave do pedido. Não é um código que precises de comparar.',
        approve: 'Aprovar', reject: 'Rejeitar', loadError: 'Não foi possível carregar as aprovações de dispositivos.',
        loadErrorUnreachable: ({ homes }) => `${homes} não respondeu.`, loadErrorFailed: ({ homes }) => `${homes} respondeu com um erro.`,
        decisionError: 'Não foi possível atualizar este pedido.', decisionRecovery: 'Escolhe Aprovar ou Rejeitar para tentar novamente.',
        approved: 'Dispositivo aprovado', rejected: 'Dispositivo rejeitado', expired: 'Expirado', stopWaiting: 'Deixar de esperar',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "pt">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const pt: typeof en = {
    teams: {
        title: 'Equipas',
        description: 'Grupos com sessões, máquinas e acessos partilhados.',
        credentialResources: {
            title: 'Credenciais da equipa',
            description: 'Credenciais que uma equipa partilha com as suas sessões.',
            externalApi: {
                title: 'API de credenciais da equipa',
                description: 'Ferramentas externas usam as credenciais de uma equipa através da API.',
            },
        },
    },
    automations: {
        title: 'Automatizações',
        description: 'Trabalho de agentes agendado e acionado por eventos.',
    },
    workflows: {
        title: 'Fluxos de trabalho',
        description: 'Pipelines de agentes com vários passos.',
    },
    pets: {
        sync: {
            title: 'Sincronização de mascotes',
            description: 'Mantém as mascotes de cada pessoa em todos os seus dispositivos.',
        },
    },
    voice: {
        title: 'Voz',
        description: 'Fale com os seus agentes.',
        happierVoice: {
            title: 'Voz Happier',
            description: 'Voz através do serviço de voz que este Home disponibiliza.',
        },
    },
    connectedServices: {
        group: 'Serviços ligados',
        quotas: {
            title: 'Medidores de quota',
            description: 'Mostra quanta quota resta a cada conta ligada.',
        },
        subscription: {
            title: 'Estado da subscrição',
            description: 'Mostra o plano e o estado de cada conta ligada.',
        },
        accountGroups: {
            title: 'Grupos de contas',
            description: 'Agrupe contas ligadas em pools.',
        },
        accountFallback: {
            title: 'Conta de recurso',
            description: 'Passa para a conta seguinte do pool quando uma se esgota.',
        },
        autoQuotaReset: {
            title: 'Reposição automática de quota',
            description: 'Usa as reposições de quota acumuladas quando todas as contas de um pool se esgotam.',
        },
        autoDisablePlanInvalid: {
            title: 'Ignorar contas inutilizáveis',
            description: 'Desativa as contas do pool que não podem usar o modelo escolhido.',
        },
        poolQuotaLimitSelection: {
            title: 'Limites de quota do pool',
            description: 'Escolha que quota do fornecedor cada pool segue.',
        },
    },
    updates: {
        ota: {
            title: 'Atualizações remotas',
            description: 'As apps instalam atualizações sem passar pela loja.',
        },
    },
    attachments: {
        uploads: {
            title: 'Anexos',
            description: 'Envie ficheiros e imagens aos agentes de uma sessão.',
        },
    },
    sharing: {
        group: 'Partilha',
        session: {
            title: 'Partilha de sessões',
            description: 'Partilhe uma sessão com alguém neste Home.',
        },
        public: {
            title: 'Ligações públicas',
            description: 'Partilhe o conteúdo de uma sessão com uma ligação pública.',
        },
        contentKeys: {
            title: 'Partilha cifrada',
            description: 'Troca chaves para que as sessões partilhadas continuem cifradas ponto a ponto.',
        },
        pendingQueueV2: {
            title: 'Fila de mensagens partilhada',
            description: 'Coloca em fila as mensagens de uma sessão partilhada enquanto o agente está ocupado.',
        },
        pendingDeliveryState: {
            title: 'Seguimento de entrega da fila',
            description: 'Regista que mensagens em fila chegaram ao agente.',
        },
    },
    sessions: {
        title: 'Sessões',
        description: 'As sessões e os seus controlos.',
        group: 'Sessões',
        handoff: {
            title: 'Passagem de sessão',
            description: 'Mova uma sessão em curso para outra máquina.',
        },
        ephemeralRunner: {
            title: 'Runners efémeros',
            description: 'Inicie uma sessão numa máquina descartável.',
        },
        agentSwitching: {
            title: 'Troca de agente',
            description: 'Continue uma sessão com outro agente de programação.',
        },
        folders: {
            title: 'Pastas de sessões',
            description: 'Organize as sessões em pastas.',
        },
        drafts: {
            title: 'Rascunhos sincronizados',
            description: 'Mantenha mensagens por enviar e rascunhos de sessão em todos os dispositivos.',
        },
        following: {
            title: 'Seguir',
            description: 'Siga uma sessão para receber as suas novidades e notificações.',
        },
        conversations: {
            title: 'Conversas',
            description: 'As pessoas conversam e mencionam-se dentro de uma sessão partilhada.',
        },
        board: {
            title: 'Quadro de sessões',
            description: 'Organize sessões e os seus elementos em quadros partilhados.',
        },
        filteredListing: {
            title: 'Lista filtrada',
            description: 'Filtra a lista de sessões neste Home antes da paginação.',
        },
        usageLimitRecovery: {
            title: 'Retoma após limite de utilização',
            description: 'Esperar e retomar, ou tentar novamente, quando um agente atinge um limite de utilização.',
        },
    },
    machines: {
        title: 'Máquinas',
        description: 'A ligação às suas máquinas.',
        group: 'Máquinas',
        pools: {
            title: 'Pools de máquinas',
            description: 'Passa para a máquina seguinte quando uma está offline.',
        },
        transfer: {
            title: 'Transferências entre máquinas',
            description: 'Transferir dados entre máquinas.',
            directPeer: {
                title: 'Transferências diretas',
                description: 'Transfere dados diretamente entre máquinas.',
            },
            serverRouted: {
                title: 'Transferências através deste Home',
                description: 'Transfere dados através deste Home quando as máquinas não se conseguem ligar diretamente.',
            },
        },
        peerMediation: {
            title: 'Ligações entre máquinas',
            description: 'Túneis, transmissões e acessos entre máquinas.',
            observability: {
                title: 'Diagnóstico de ligações',
                description: 'Mostra como túneis, transmissões e pré-visualizações estão ligados entre máquinas.',
            },
        },
        tunnel: {
            title: 'Túneis entre máquinas',
            description: 'Abrir portas entre máquinas.',
            directPeer: {
                title: 'Túneis diretos',
                description: 'Abre portas diretamente entre máquinas.',
            },
            serverRouted: {
                title: 'Túneis através deste Home',
                description: 'Abre portas através deste Home quando as máquinas não se conseguem ligar diretamente.',
            },
        },
        liveStream: {
            title: 'Transmissões em direto',
            description: 'Transmitir o ecrã de uma máquina.',
            directPeer: {
                title: 'Transmissões diretas',
                description: 'Transmite o ecrã de uma máquina diretamente para o seu dispositivo.',
            },
            serverRouted: {
                title: 'Transmissões através deste Home',
                description: 'Transmite o ecrã de uma máquina através deste Home quando a transmissão direta falha.',
            },
        },
        rpc: {
            title: 'Chamadas a máquinas',
            description: 'Chegar às máquinas diretamente.',
            directPeer: {
                title: 'Chamadas diretas a máquinas',
                description: 'Chega a uma máquina diretamente em vez de através deste Home.',
            },
        },
    },
    localServices: {
        title: 'Serviços locais',
        description: 'Veja e abra os serviços em execução nas suas máquinas.',
        group: 'Serviços locais',
        inventory: {
            title: 'Inventário de serviços',
            description: 'Lista as portas e os serviços ativos em cada máquina.',
        },
        managed: {
            title: 'Serviços geridos',
            description: 'Inicie, nomeie e acompanhe serviços a partir do Happier.',
        },
        launcher: {
            title: 'Iniciador de serviços',
            description: 'Sugere serviços para abrir e pré-visualizar.',
        },
        actions: {
            title: 'Ações de serviços',
            description: 'Copiar, pré-visualizar e esquecer serviços.',
            terminate: {
                title: 'Parar serviços',
                description: 'Para o processo de um serviço detetado.',
            },
        },
        preview: {
            title: 'Pré-visualizações de serviços',
            description: 'Pré-visualiza um serviço local em privado dentro de uma sessão.',
        },
        publicPreview: {
            title: 'Pré-visualizações públicas',
            description: 'Partilhe a pré-visualização de um serviço num endereço público.',
        },
    },
    browser: {
        title: 'Navegador',
        description: 'Abra páginas, pré-visualizações e vistas alojadas dentro do Happier.',
        group: 'Navegador',
        viewTargets: {
            title: 'Vistas do navegador',
            description: 'Abre pré-visualizações, páginas de plugins e ligações na vista certa.',
        },
        internal: {
            title: 'Navegador integrado',
            description: 'Navegue dentro do Happier com sessões e perfis próprios.',
        },
        sidecar: {
            title: 'Navegador auxiliar',
            description: 'Um navegador gerido à parte para automatização intensiva.',
        },
        diagnostics: {
            title: 'Ferramentas de programador',
            description: 'Consola, rede e eventos devtools do navegador integrado.',
        },
        context: {
            title: 'Contexto do navegador',
            description: 'Anexe o conteúdo de uma página a uma mensagem ou a um agente.',
        },
        automation: {
            title: 'Automatização do navegador',
            description: 'Os agentes clicam, escrevem e navegam no navegador integrado.',
        },
        recording: {
            title: 'Gravações do navegador',
            description: 'Grava sessões do navegador como prova.',
        },
    },
    plugins: {
        title: 'Plugins de fora do Happier',
        description: 'Instale plugins a partir do npm e das suas próprias fontes.',
        group: 'Plugins',
        webhooks: {
            title: 'Webhooks de plugins',
            description: 'Os plugins recebem webhooks de serviços externos.',
        },
        ui: {
            title: 'Ecrãs de plugins',
            description: 'Mostra os ecrãs e painéis que os plugins disponibilizam.',
            hostedWeb: {
                title: 'Ecrãs web de plugins',
                description: 'Mostra ecrãs de plugins criados para a web.',
            },
            reactNativeBundles: {
                title: 'Ecrãs nativos de plugins',
                description: 'Executa ecrãs de plugins de confiança criados com React Native.',
            },
        },
    },
    devices: {
        title: 'Dispositivos',
        description: 'Simuladores e dispositivos ligados.',
        simulatorPreview: {
            title: 'Pré-visualizações de simuladores',
            description: 'Mostra simuladores e emuladores das suas máquinas.',
        },
    },
    social: {
        friends: {
            title: 'Amigos',
            description: 'Adicione amigos e veja o que partilham.',
        },
    },
    auth: {
        group: 'Início de sessão',
        recovery: {
            providerReset: {
                title: 'Repor através de um fornecedor',
                description: 'Recupere uma conta iniciando sessão com o seu fornecedor de identidade.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Início de sessão com chave',
                description: 'Inicie sessão provando a chave de um dispositivo.',
            },
        },
        mtls: {
            title: 'Certificados de cliente',
            description: 'Inicie sessão com um certificado de cliente (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Lembrete da chave de recuperação',
                description: 'Lembra as pessoas de guardar a chave de recuperação.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Iniciar sessão por leitura',
                description: 'Inicie sessão num telemóvel lendo um código num computador.',
            },
            boundQrV2: {
                title: 'Códigos de emparelhamento mais seguros',
                description: 'Códigos de emparelhamento válidos só para este Home e esta direção.',
            },
        },
    },
    encryption: {
        group: 'Cifra',
        plaintextStorage: {
            title: 'Armazenamento sem cifra',
            description: 'Guarda as sessões sem cifra ponto a ponto.',
        },
        accountOptOut: {
            title: 'Desativar a cifra',
            description: 'Cada pessoa pode desligar a cifra ponto a ponto.',
        },
    },
    remoteHosts: {
        group: 'Anfitriões remotos',
        management: {
            title: 'Anfitriões remotos',
            description: 'Guarde anfitriões SSH onde executar sessões.',
        },
        secretMaterial: {
            title: 'Segredos de anfitriões guardados',
            description: 'Guarde palavras-passe e chaves de anfitriões SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Contas sem chaves',
            description: 'Contas sem chaves de cifra ponto a ponto.',
        },
    },
    bugReports: {
        title: 'Relatórios de erros',
        description: 'Envie relatórios de erros com diagnósticos.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Abra um terminal numa máquina dentro do Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminal em fluxo',
                description: 'Uma ligação mais rápida para o terminal integrado.',
            },
        },
    },
    search: {
        title: 'Pesquisa',
        description: 'Pesquise em sessões e transcrições.',
    },
    providers: {
        title: 'Fornecedores de modelos',
        description: 'Ligue fornecedores de modelos e escolha modelos para os agentes.',
        group: 'Fornecedores de modelos',
        localDiscovery: {
            title: 'Encontrar fornecedores locais',
            description: 'Encontra servidores de modelos em execução nas suas máquinas.',
        },
        localModelManagement: {
            title: 'Gestão de modelos locais',
            description: 'Transfira e gira modelos locais.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Endereço do serviço de relatórios',
            description: 'Para onde são enviados os relatórios de erros. Se ficar em branco, não é oferecido nenhum serviço de relatórios.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Incluir diagnósticos por predefinição',
            description: 'O formulário de relatório inclui diagnósticos, a menos que quem reporta opte por não os incluir.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Anexo máximo',
            description: 'Maior ficheiro que um relatório de erros pode anexar, em bytes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Tempo limite de envio',
            description: 'Quanto tempo pode demorar o envio de um relatório de erros, em milissegundos.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Tipos de anexo aceites',
            description: 'Tipos de anexo que os relatórios de erros aceitam. Vazio aceita os tipos habituais.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Janela de contexto',
            description: 'Até que ponto no passado um relatório de erros recolhe contexto, em milissegundos.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Voz requer subscrição',
            description: 'Só os subscritores podem usar a voz. Se não estiver definido, é obrigatório em produção e não nas outras configurações.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Manifesto de mascote máximo',
            description: 'Maior manifesto de mascote aceite, em bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Spritesheet de mascote máxima',
            description: 'Maior spritesheet de mascote aceite, em bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Pacote de mascote máximo',
            description: 'Maior pacote de mascote aceite, em bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Mascotes importadas por pessoa',
            description: 'Número máximo de mascotes importadas que uma pessoa pode manter.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Armazenamento de mascotes importadas por pessoa',
            description: 'Máximo de bytes de mascotes importadas que uma pessoa pode manter.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Mascotes personalizadas cifradas',
            description: 'Reservado para o futuro. As mascotes personalizadas cifradas ainda não são sincronizadas, por isso fica desativado.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Maior transferência através deste Home',
            description: 'Maior ficheiro que uma transferência através deste Home transporta, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Transferências em simultâneo por ligação',
            description: 'Máximo de transferências através deste Home que uma ligação executa em simultâneo.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Dados por túnel',
            description: 'Máximo de bytes que um túnel através deste Home transporta.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Túneis por ligação',
            description: 'Máximo de túneis através deste Home que uma ligação mantém abertos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Maior trama de túnel',
            description: 'Maior trama que um túnel através deste Home transporta, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Codificações de túnel',
            description: 'Codificações de trama que os túneis através deste Home aceitam. Vazio usa as padrão.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Codificação de túnel preferida',
            description: 'A codificação de trama a usar primeiro. Tem de ser uma das codificações aceites.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Maior cabeçalho de trama',
            description: 'Maior cabeçalho binário de trama, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Maior carga útil de trama',
            description: 'Maior carga útil bruta numa trama, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Maior mensagem em tramas',
            description: 'Maior mensagem dividida em tramas, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Fluxos em simultâneo por túnel',
            description: 'Máximo de fluxos que um túnel executa em simultâneo.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Fluxos por túnel',
            description: 'Máximo de fluxos que um túnel abre ao longo da sua vida útil.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Dados por fluxo',
            description: 'Máximo de bytes que um fluxo transporta.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Dados por túnel, todos os fluxos',
            description: 'Máximo de bytes que todos os fluxos de um túnel transportam em conjunto.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Tempo limite de fluxo inativo',
            description: 'Quanto tempo um fluxo pode ficar inativo antes de fechar, em milissegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Tempo limite de túnel inativo',
            description: 'Quanto tempo um túnel através deste Home pode ficar inativo antes de fechar, em milissegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Tempo limite de inatividade do túnel',
            description: 'Quanto tempo um túnel pode ficar inativo antes de fechar, em milissegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Duração máxima do túnel',
            description: 'Tempo máximo que um túnel fica aberto, em milissegundos.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Portas acessíveis por túneis',
            description: 'Portas que os túneis podem abrir. Vazio permite apenas as predefinidas.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Duração da ligação de pré-visualização',
            description: 'Quanto tempo funciona uma ligação de pré-visualização privada, em milissegundos.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Domínio de pré-visualização',
            description: 'Domínio que serve cada pré-visualização no seu próprio endereço. Vazio serve as pré-visualizações no endereço deste Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modos de pré-visualização pública',
            description: 'Formas de tornar uma pré-visualização pública.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Pré-visualização pública mais longa',
            description: 'Tempo máximo que uma pré-visualização fica pública, em milissegundos. Vazio mantém o limite padrão.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Pré-visualizações públicas em simultâneo',
            description: 'Máximo de pré-visualizações públicas ao mesmo tempo. Vazio mantém o limite padrão.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Exigir DNS e TLS',
            description: 'As pré-visualizações públicas precisam de DNS e TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Registo de auditoria de pré-visualizações públicas',
            description: 'Onde as pré-visualizações públicas são registadas. As pré-visualizações públicas precisam de um.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Ficheiro do registo de auditoria',
            description: 'Ficheiro onde é escrito o registo de auditoria das pré-visualizações públicas.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Permitir o registo de auditoria de teste',
            description: 'Apenas para desenvolvimento: aceita o registo de auditoria de teste em memória. Ignorado em produção.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Limites de pedidos de pré-visualizações públicas',
            description: 'Perfis de limite de pedidos que as pré-visualizações públicas podem usar.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Verificador de limite de pedidos',
            description: 'Como são limitados os pedidos às pré-visualizações públicas. As pré-visualizações públicas precisam de um.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Pedidos por janela',
            description: 'Pedidos que uma pré-visualização pública permite em cada janela.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Janela de limite de pedidos',
            description: 'Duração de cada janela de limite de pedidos, em milissegundos.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Permitir o limitador de pedidos de teste',
            description: 'Apenas para desenvolvimento: aceita o limitador de pedidos de teste em memória. Ignorado em produção.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooks em curso',
            description: 'Máximo de pedidos de webhook que este servidor processa em simultâneo.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Memória de webhooks',
            description: 'Máximo de memória que os pedidos de webhook em curso podem usar, em bytes. Vazio permite o que o limite de pedidos já autoriza.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por rota',
            description: 'Pedidos de webhook por minuto numa rota.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhooks em simultâneo por rota',
            description: 'Pedidos de webhook em curso numa rota.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por endpoint',
            description: 'Pedidos de webhook por minuto num endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhooks em simultâneo por endpoint',
            description: 'Pedidos de webhook em curso num endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks por minuto por pessoa',
            description: 'Pedidos de webhook por minuto para uma pessoa.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhooks em simultâneo por pessoa',
            description: 'Pedidos de webhook em curso para uma pessoa.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Maior pacote de ecrã de plugin',
            description: 'Maior pacote de ecrã de plugin que este Home aloja, em bytes.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Armazenamento de ecrãs de plugins por pessoa',
            description: 'Máximo de bytes de pacotes de ecrãs de plugins que uma pessoa pode guardar.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Maior linha de dados de plugin',
            description: 'Maior linha que um plugin guarda, em bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Maior lote de dados de plugin',
            description: 'Maior lote de alterações a dados de plugins, em bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Linhas por lote de dados de plugin',
            description: 'Máximo de linhas num lote de alterações a dados de plugins.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Linhas de dados de plugins por pessoa',
            description: 'Máximo de linhas de dados de plugins que uma pessoa pode guardar.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Armazenamento de dados de plugins por pessoa',
            description: 'Máximo de bytes de dados de plugins que uma pessoa pode guardar.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Taxa de bits máxima da transmissão',
            description: 'Taxa de bits máxima de uma transmissão em direto através deste Home, em bits por segundo.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Taxa de fotogramas máxima da transmissão',
            description: 'Taxa de fotogramas máxima de uma transmissão em direto através deste Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Maior fotograma da transmissão',
            description: 'Maior fotograma de uma transmissão em direto através deste Home, em bytes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Transmissão em direto mais longa',
            description: 'Tempo máximo que uma transmissão em direto através deste Home dura, em milissegundos.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Dados por transmissão em direto',
            description: 'Máximo de bytes que uma transmissão em direto através deste Home transporta.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Transmissões em simultâneo por pessoa',
            description: 'Máximo de transmissões em direto através deste Home que uma pessoa executa em simultâneo.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Transmissões em simultâneo por ligação',
            description: 'Máximo de transmissões em direto através deste Home que uma ligação executa em simultâneo.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Transmissões em simultâneo por máquina',
            description: 'Máximo de transmissões em direto através deste Home que uma máquina executa em simultâneo.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID da chave de assinatura de ligações',
            description: 'Identifica a chave que assina as ligações entre máquinas. Sem chave de assinatura, estas ligações ficam desativadas.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Chave privada de assinatura de ligações',
            description: 'Chave privada que assina as ligações entre máquinas.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Chave pública de assinatura de ligações',
            description: 'Chave pública correspondente à chave de assinatura. Se estiver vazia, é obtida a partir da chave privada.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Expiração da chave de assinatura',
            description: 'Quando a chave de assinatura expira, como marca temporal em milissegundos.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Encontrar amigos pelo nome de utilizador',
            description: 'As pessoas podem encontrar amigos pelo nome de utilizador, além da conta associada.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Fornecedor para identificar amigos',
            description: 'O fornecedor de início de sessão usado para identificar amigos.',
        },
    },
};

const homeFeatureTranslations = { pt } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const pt: typeof en = {
    title: 'Administração do Home',
    pages: {
        features: 'O que este Home oferece. Uma alteração aplica-se em todo o lado na próxima atualização.',
        data: 'O que este Home guarda e durante quanto tempo.',
        homes: 'Contas, funções, equipas e regras de início de sessão de cada Home que administra.',
        overview: 'Quem administra este Home e o que pode alterar aqui.',
        people: 'As contas deste Home, as suas funções e se podem iniciar sessão.',
        policies: 'Quem pode iniciar sessão, quem pode criar contas e equipas, e como os dados são protegidos.',
        teams: 'Todas as equipas deste Home. Administrar uma equipa não lhe dá acesso às suas sessões.',
        identityProvider: 'Um serviço de identidade com que se pode iniciar sessão neste Home.',
        identityProviderEditor: 'Como este serviço de identidade se liga e quem admite.',
        githubApp: 'Uma GitHub App que este Home usa para aceder a repositórios.',
        githubAppEditor: 'Registe ou altere uma GitHub App para este Home.',
        email: 'Como este Home envia e-mails.',
        reach: 'Como dispositivos, links de convite e e-mails encontram este Home.',
        runtime: 'O servidor que executa este Home.',
        activity: 'Quem mudou o quê neste Home, e quando.',
    },
    overview: 'Visão geral',
    people: 'Pessoas',
    teams: 'Equipas',
    policies: 'Políticas',
    console: {
        serverSettings: 'Configurações do servidor',
        serverSettingsDescription: 'Cada configuração que o servidor lê e quando uma alteração se aplica.',
        allHomes: 'Todos os Homes',
        backToHomes: 'Voltar aos Homes',
        viewerOwner: 'Você é o proprietário',
        viewerAdmin: 'Você é administrador',
        noOwnerYet: 'Ainda sem proprietário',
        administer: 'Administrar',
        navigation: 'Páginas de administração do Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Quem gere este Home e o que precisa de você.',
        attention: 'Precisa da sua atenção',
        emailNotSetUpTitle: 'O e-mail não está configurado',
        emailNotSetUpBody: 'Ninguém consegue verificar o endereço, redefinir a senha ou receber convites por e-mail.',
        emailNoLinkTitle: 'Os e-mails ainda não podem ter links',
        emailNoLinkBody: 'O envio está configurado, mas este Home não tem um endereço do app web para os links.',
        emailPasswordTitle: 'A senha do e-mail não pode ser lida',
        emailPasswordBody: 'Digite a senha SMTP de novo para que este Home possa enviar e-mails.',
        setUpEmail: 'Configurar e-mail',
        openEmail: 'Abrir E-mail',
        noAddressTitle: 'Sem endereço público',
        noAddressBody: 'Dispositivos em outras redes e links de convite não alcançam este Home.',
        setUpReach: 'Configurar',
        pendingBody: 'Salvo, aguardando o servidor reiniciar.',
        fixedBody: 'Definidas no ambiente do servidor; altere-as lá.',
        review: 'Revisar',
        settingsFailed: 'Não foi possível verificar as configurações deste Home',
        emailFailed: 'Não foi possível ler o estado do e-mail deste Home',
        reachFailed: 'Não foi possível ler como este Home é alcançado',
        ownership: 'Propriedade',
        ownerYou: 'Proprietário · você',
        peopleFailed: 'Não foi possível ler as pessoas deste Home',
        thisHome: 'Este Home',
        version: 'Versão',
        signIn: 'Login',
        signInOpen: 'qualquer pessoa pode criar uma conta',
        signInInvited: 'somente com convite',
        signInNone: 'Nenhum método de login está ativo',
        fixedTitle: ({ count }: { count: number }) => (count === 1 ? '1 configuração é fixada pela sua implantação' : `${count} configurações são fixadas pela sua implantação`),
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'pessoa' : 'pessoas'}`, `${owners} ${owners === 1 ? 'proprietário' : 'proprietários'}`, admins === null ? null : `${admins} ${admins === 1 ? 'admin' : 'admins'}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Convidar pessoas',
        description: 'As pessoas entram neste Home entrando em uma de suas equipes.',
        team: 'Equipe',
        noTeams: 'Ainda não há uma equipe para a qual você possa convidar',
        noTeamsBody: 'As pessoas entram em um Home por meio de uma equipe. Crie uma primeiro.',
        notAdministered: 'Você não pode convidar para as equipes deste Home',
        notAdministeredBody: 'Os proprietários e admins de cada equipe convidam as pessoas. Peça a um deles ou crie sua própria equipe.',
        createTeam: 'Criar uma equipe',
        notAdministeredAskBody: 'Os proprietários e admins de cada equipe convidam as pessoas; peça a um deles.',
        joinByTeam: 'As pessoas entram em um Home por meio de uma equipe.',
        teamsFailed: 'Não foi possível ler as equipes deste Home',
    },

    yourRole: 'A tua função',
    roleOwner: 'Proprietário',
    roleAdmin: 'Administrador',
    roleMember: 'Membro',
    activeOwners: 'Proprietários ativos',
    accountSection: 'Conta',
    accountAccessSection: 'Acesso',
    homeAddress: 'Endereço do Home',

    setupRequiredTitle: 'É necessário configurar a administração',
    setupRequiredBody: 'Este Home ainda não tem um proprietário ativo. Alguém com acesso ao servidor atribui o primeiro proprietário a partir da máquina que o executa.',

    manageTeams: 'Gerir equipas',
    manageTeamsSubtitle: 'Administra as equipas deste Home. Isto não te dá acesso às sessões delas.',
    teamsDisabled: 'As equipas não estão ativadas neste Home.',
    teamsEmpty: 'Ainda não há equipas neste Home.',

    loading: 'A carregar este Home…',
    refreshing: 'A atualizar…',
    updating: 'A atualizar…',
    staleNotice: 'A mostrar o último estado conhecido deste Home. Não é possível alterar até voltar a responder.',
    offlineNotice: 'Este Home não responde. Podes continuar a ler, mas não alterar.',
    unavailableTitle: 'Este Home não está disponível',
    unavailableBody: 'O Happier não conseguiu ler o estado de administração deste Home.',
    forbiddenTitle: 'Não podes administrar este Home',
    forbiddenBody: 'A tua conta não tem autoridade de administração aqui.',
    retry: 'Tentar novamente',
    loadMore: 'Carregar mais',
    unsupportedBody: 'Este Home não oferece administração. Pode estar a executar uma versão mais antiga.',
    notObservedTitle: 'Ainda não carregado',
    notObservedBody: 'Este Home ainda não comunicou o seu estado de administração a este dispositivo.',
    lastUpdated: ({ time }: { time: string }) => `Atualizado ${time}`,

    chooseHome: 'Escolhe um Home',
    chooseHomeFooter: 'Cada Home tem as suas próprias contas, funções e políticas.',
    homesEmpty: 'Ainda não há Homes',
    homesEmptyBody: 'Adiciona um Home a este dispositivo para o administrares aqui.',
    homesNoneAdministrable: 'Nenhum Home para administrar',
    homesNoneAdministrableBody: 'Nenhum dos Homes que estás a ver dá autoridade de administração a esta conta.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} não está a responder`,
    signedOutTitle: 'Sessão terminada neste Home',
    signedOutBody: 'Inicia sessão novamente neste Home para o administrares.',
    credentialUnreadableTitle: 'Não foi possível ler o início de sessão guardado neste dispositivo',
    credentialUnreadableBody: 'O problema está neste dispositivo, não no Home, e a tua sessão não foi terminada. Tenta novamente.',
    credentialUnreadableInviteBody: 'O problema está neste dispositivo, não no Home. O teu link de convite continua a funcionar, por isso podes tentar novamente agora ou voltar mais tarde.',

    peopleEmpty: 'Ainda não há contas neste Home.',
    rosterUnavailableTitle: 'A lista de pessoas ainda não está disponível',
    rosterUnavailableBody: 'Este Home ainda não fornece a lista de contas ao Happier. As funções e os estados aparecerão aqui quando o fizer.',
    accountUnavailableBody: 'Esta conta ainda não está disponível a partir deste Home.',
    searchPlaceholder: 'Procurar contas',
    searchResults: 'Resultados da pesquisa',
    searchResultsFooter: 'Abre uma conta para veres a sua função e o seu estado.',
    searchEmpty: 'Nenhuma conta corresponde a essa pesquisa.',
    searchUnsupported: 'A pesquisa não está disponível neste Home',
    searchUnsupportedBody: 'Este Home não oferece pesquisa de contas. Pode estar a usar uma versão mais antiga.',
    searchFailed: 'Não foi possível concluir a pesquisa',
    searchFailedBody: 'Este Home não respondeu à pesquisa. Altera o texto para tentares de novo.',

    statusActive: 'Ativa',
    statusDisabled: 'Desativada',
    statusRetired: 'Retirada',
    statusDisabledDetail: 'Sessão terminada em todo o lado. Pode ser reativada.',
    statusRetiredDetail: 'Acesso revogado permanentemente.',

    changeRole: 'Alterar função',
    disable: 'Desativar conta',
    enable: 'Reativar conta',
    deleteAccount: 'Eliminar conta e dados…',
    retryDeletion: 'Tentar eliminar novamente',

    reasonLastActiveOwner: 'Este Home precisa de pelo menos um proprietário ativo. Torna outra conta proprietária primeiro.',
    reasonTargetInactive: 'Só uma conta ativa pode ter uma função no Home.',
    reasonHomeUnreachable: 'Este Home não responde. As alterações ficam disponíveis após a reconexão.',

    roleSheetTitle: 'Função no Home',
    roleOwnerDescription: 'Pode administrar tudo neste Home, incluindo eliminar contas.',
    roleAdminDescription: 'Pode administrar contas e equipas, mas não alterar proprietários.',
    roleMemberDescription: 'Sem autoridade de administração do Home.',

    disableTitle: ({ account }: { account: string }) => `Desativar ${account}?`,
    disableBody: 'A sessão será terminada em todos os dispositivos e as máquinas serão desligadas. Os tokens de acesso pessoal são revogados permanentemente, a responsabilidade pelas sessões é removida e, em cada sessão a que perca acesso, os rascunhos por enviar são descartados e o seguimento é removido. Reativar devolve o acesso, mas não esses rascunhos, o seguimento ou a responsabilidade. A pertença a equipas e as chaves de cifra são mantidas.',
    disableConfirm: 'Desativar',
    enableTitle: ({ account }: { account: string }) => `Reativar ${account}?`,
    enableBody: 'Poderá iniciar sessão novamente nos seus dispositivos. Os tokens de acesso revogados continuam revogados.',
    enableConfirm: 'Reativar',
    deleteTitle: ({ account }: { account: string }) => `Eliminar ${account} e todos os seus dados?`,
    deleteBody: ({ home }: { home: string }) => `Isto elimina permanentemente a conta e os seus dados em ${home}. Não pode ser anulado. A propriedade do Home ou de equipas tem de ser transferida antes.`,
    deleteConfirm: 'Eliminar',

    deleteIncompleteTitle: 'A eliminação não terminou',
    deleteIncompleteBody: 'O acesso foi revogado e esta conta está agora retirada, mas a limpeza não terminou. Tenta eliminar novamente para concluir.',
    deleteIncompleteMemberBody: 'O acesso foi revogado, mas a limpeza não terminou. Um proprietário do Home ou o operador do servidor pode concluí-la.',

    errorForbidden: 'Já não tens autoridade para esta alteração neste Home.',
    errorOwnerTransferRequired: 'Este Home precisa de pelo menos um proprietário ativo. Torna outra conta proprietária primeiro.',
    errorTeamOwnerTransferRequired: 'Uma equipa ainda precisa desta conta como proprietária. Dá primeiro outro proprietário a essa equipa.',
    errorAccountNotFound: 'Esta conta já não existe neste Home.',
    errorAccountInactive: 'Esta conta não está ativa, por isso não pode receber esta autoridade.',
    errorErasureTransitionCleanupPending: 'A eliminação da conta aguarda a limpeza da encriptação. Tenta eliminar a conta novamente.',
    errorGeneric: 'Este Home não conseguiu concluir a alteração. Nada foi alterado.',
    errorConflict: 'Algo mais foi alterado aqui antes. Atualize este Home e tente novamente.',
    changeFailedTitle: 'A alteração não foi concluída',
    errorOutcomeUnknownTitle: 'Esta alteração não foi confirmada',
    errorOutcomeUnknown: 'O pedido chegou a este Home, mas a resposta perdeu-se. Pode ter sido aplicada. Atualize este Home e verifique antes de tentar novamente.',

    teamCreation: 'Criação de equipas',
    teamCreationSelfService: 'Qualquer pessoa pode criar equipas',
    teamCreationSelfServiceDescription: 'Os membros ativos deste Home podem criar uma equipa e tornar-se proprietários.',
    teamCreationManagedOnly: 'Os administradores criam equipas',
    teamCreationManagedOnlyDescription: 'Proprietários e administradores criam equipas e escolhem o proprietário inicial.',
    teamCreationDisabled: 'Criação de equipas desativada',
    teamCreationDisabledDescription: 'Sem novas equipas. As equipas existentes não mudam.',
    teamsVisibility: 'Quem vê as equipas',
    teamsVisibleToMembers: 'Mostrar equipas aos membros',
    teamsVisibleToMembersDescription: 'Quando desativado, só os membros de uma equipa e os administradores veem as equipas.',
    teamJit: 'Adesão automática à equipa ao iniciar sessão',
    teamJitDescription: 'Iniciar sessão através do fornecedor de identidade ligado a uma equipa junta essa pessoa à equipa automaticamente, sem convite nem aprovação.',
    githubEnterpriseOrigins: 'Hosts GitHub Enterprise aprovados',
    githubEnterpriseOriginsDescription: 'Uma origem HTTPS canónica por linha. As equipas só podem ligar GitHub Apps a estes hosts.',
    githubEnterpriseOriginsInvalid: 'Use origens HTTPS únicas, sem caminhos, consultas, credenciais ou fragmentos.',

    signInTitle: 'Início de sessão e admissão',
    authActionLogin: 'Início de sessão',
    authActionProvision: 'Novas contas',
    authActionConnect: 'Associação de contas',
    authReasonMethodNotEnabled: 'O método de início de sessão está desativado',
    authReasonProvisioningNotEnabled: 'A criação de contas está desativada',
    authReasonAccountModeUnavailable: 'O tipo de conta não está disponível',
    authReasonEmailDeliveryUnavailable: 'O envio de e-mail não está disponível',
    authInherited: 'A usar os valores do servidor',
    authInheritedDescription: 'Este Home não restringe os métodos de início de sessão nem os tipos de conta.',
    authNarrowed: 'Restringido por este Home',
    authUnreadable: 'A configuração precisa de atenção',
    authUnreadableDescription: 'Este Home guarda uma configuração de início de sessão que esta versão do servidor não consegue ler. O início de sessão fica indisponível até o operador a reparar.',
    signInMethods: 'Métodos de início de sessão',
    accountModes: 'Tipos de conta',
    accountModePlain: 'Simples',
    accountModeE2ee: 'Cifrada ponta a ponta',
    recommendedMode: 'Recomendado para novas contas',
    recommendedModeDescription: 'Define a predefinição para novas contas. As contas existentes não são alteradas.',
    admissionSelfService: 'Qualquer pessoa',
    admissionInvitationOnly: 'Apenas por convite',
    admissionClosed: 'Ninguém',

    deploymentServices: 'Serviços da implementação',
    deploymentServicesDescription: 'Serviços de identidade que o operador configura para este servidor. Não podem ser alterados na administração do Home.',
    deploymentWorkosConfigured: 'Configurado',
    deploymentWorkosPartial: 'Configuração incompleta',
    deploymentWorkosNotConfigured: 'Por configurar',
    privateEndpoints: 'Pontos de identidade privados',
    privateEndpointsDescription: 'Permite que o início de sessão gerido chegue a fornecedores de identidade em redes privadas. Só os anfitriões, redes e portas listados aqui ficam acessíveis.',
    privateEndpointsPublicOnly: 'Apenas pontos públicos',
    privateEndpointsAllowlist: 'Lista privada permitida',
    privateEndpointsHostnames: 'Anfitriões permitidos',
    privateEndpointsCidrs: 'Redes permitidas (CIDR)',
    privateEndpointsPorts: 'Portas permitidas',
    privateEndpointsSave: 'Guardar política de rede',
    privateEndpointsInvalid: 'Indica pelo menos um anfitrião ou rede, e uma porta entre 1 e 65535.',
    privateEndpointsUnreadable: 'Este Home guarda uma política de rede que esta versão do servidor não consegue ler. O início de sessão gerido continua só em pontos públicos.',

    policyReadOnly: 'Só um proprietário do Home pode alterar isto.',
    policyEditingUnavailable: 'Ainda não é possível alterar políticas a partir deste dispositivo.',
    revisionConflictTitle: 'Esta política mudou noutro sítio',
    revisionConflictBody: 'Outra pessoa guardou uma alteração enquanto editavas. A tua escolha foi mantida — recarrega este Home e aplica-a novamente.',
    reload: 'Recarregar',
    person: {
        you: 'você',
        roleDescription: 'Os membros usam o Home; os administradores também gerem pessoas e Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Tornar ${account} ${role}?`,
        roleChangeBody: 'O acesso a este Home muda de imediato. Fica registado na Atividade com o seu nome.',
        roleChangeConfirm: 'Alterar função',
        signIn: 'Início de sessão',
        signInDescription: 'Com o que pode iniciar sessão. Gere isso na própria conta.',
        methods: 'Métodos',
        linkedProviders: 'Fornecedores ligados',
        none: 'Nenhum',
        teams: 'Teams',
        noTeams: 'Não está em nenhum Team',
        teamArchived: 'Team arquivado',
        teamSuspended: 'suspenso',
        access: 'Acesso',
        accessDescription: 'Sessão iniciada nos seus dispositivos — as sessões não são registadas individualmente.',
        machines: 'Máquinas',
        apiTokens: 'Tokens de API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Último uso ${time}`,
        apiTokensNeverUsed: 'Nunca usado',
        signOutEverywhere: 'Terminar sessão em todo o lado',
        signOutEverywhereDescription: 'Termina todas as sessões iniciadas em todos os seus dispositivos. Os tokens de API continuam a funcionar até a conta ser desativada.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Terminar a sessão de ${account} em todo o lado?`,
        signOutEverywhereBody: 'Cada dispositivo com sessão iniciada terá de iniciar sessão novamente. Os tokens de API continuam a funcionar até desativar a conta. Fica registado na Atividade com o seu nome.',
        signOutEverywhereDone: 'Sessão terminada em todo o lado',
        recentActivity: 'Atividade recente',
        noRecentActivity: 'Ainda não há alterações de administração sobre esta pessoa.',
        showAllActivity: 'Mostrar tudo',
        disableOrDelete: 'Desativar ou eliminar',
        dangerFootnote: 'Desativar termina a sessão e para os tokens de API; pode ser revertido. Eliminar remove a conta e os dados deste Home para sempre.',
    },
    email: {
        title: 'E-mail',
        status: 'Estado',
        sendingMail: 'Envio de e-mail',
        sendingReady: ({ host }: { host: string }) => `Pronto · envia através de ${host}`,
        sendingNotSetUp: 'Não configurado',
        links: 'Links nos e-mails',
        linksReady: 'Abrem na app web deste Home',
        linksOpenAt: ({ host }: { host: string }) => `Abrem em ${host}`,
        setInReach: 'Definir em Acesso',
        linksMissing: 'Sem endereço da app web, por isso os links não podem ser criados',
        mailServer: 'Servidor de e-mail',
        mailServerDescription: 'O servidor SMTP que envia os e-mails de verificação, redefinição de senha e convite.',
        server: 'Servidor',
        port: 'Porta',
        portAndSecurity: 'Porta e segurança',
        security: 'Segurança da conexão',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Nome de usuário',
        password: 'Senha',
        passwordDescription: 'Guardada cifrada no servidor. Nunca mais é mostrada.',
        saved: 'Guardada',
        replace: 'Substituir',
        clear: 'Remover',
        keep: 'Manter',
        clearPending: 'A senha guardada será removida ao guardar.',
        valueSet: 'Definida',
        valueNotSet: 'Não definida',
        sender: 'Remetente',
        fromAddress: 'Endereço do remetente',
        fromName: 'Nome do remetente',
        test: 'Enviar um e-mail de teste',
        testDescription: 'Envia uma mensagem curta sem links.',
        testTo: 'Para',
        testToPlaceholder: 'Um endereço que possas verificar',
        testSend: 'Enviar',
        testSaveFirst: 'Guarde as suas alterações antes de enviar um teste.',
        testSent: ({ to }: { to: string }) => `Enviado para ${to}`,
        testSentDetail: 'Verifique a caixa de entrada e, se não estiver lá, a pasta de spam.',
        testFailed: 'Não foi possível enviar',
        testNotConfigured: 'O e-mail ainda não está configurado.',
        testPasswordUnreadable: 'A senha guardada não pode ser lida. Introduza-a novamente.',
        testRenderFailed: 'Não foi possível preparar a mensagem de teste.',
        testTransportFailed: 'O servidor de e-mail não pôde ser contactado ou recusou a mensagem.',
        adminTitle: 'Só os proprietários podem alterar as definições de e-mail',
        adminBody: 'Pode vê-las porque é admin deste Home.',
        notSetUpTitle: 'O e-mail não está configurado',
        notSetUpBody: 'A redefinição de senhas, a verificação por e-mail e os convites por e-mail estão desligados até estar.',
        unreadableTitle: 'A senha guardada não pode ser lida',
        unreadableBody: 'O segredo mestre do servidor mudou desde que foi guardada. Introduza a senha novamente.',
        invalidValue: 'Introduza um valor válido.',
        invalidPort: 'Use uma porta de 1 a 65535.',
        invalidEmail: 'Introduza um endereço de e-mail.',
        conflictTitle: 'As definições de e-mail mudaram noutro lugar',
        conflictBody: 'Alguém guardou uma alteração enquanto editava. As suas alterações foram mantidas: reveja-as e guarde novamente.',
        loadFailed: 'Este Home não devolveu as suas definições de e-mail.',
    },
    signInProviders: {
        title: 'Provedores de início de sessão',
        description: 'Início de sessão corporativo, GitHub Apps e as regras que os Teams usam. Ative um provedor para iniciar sessão em Políticas.',
        ownersOnlyTitle: 'Só proprietários podem alterar provedores de início de sessão',
        ownersOnlyBody: 'Peça a um proprietário deste Home para adicionar ou alterar provedores de identidade e GitHub Apps.',
        fromDeployment: ({ key }: { key: string }) => `Da sua implantação · ${key} · só leitura`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `Definido pela sua implantação (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `Definido em Definições do servidor (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `Fixado pela sua implantação · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `Desativado neste Home · ${key}`,
        teamRules: 'Regras de início de sessão dos Teams',
        teamRulesDescription: 'O que os Teams podem acrescentar aos provedores do Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `adicionou o provedor de identidade ${name}`,
            changedProvider: ({ name }: { name: string }) => `alterou o provedor de identidade ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `substituiu o segredo de cliente de ${name}`,
            enabledProvider: ({ name }: { name: string }) => `ativou ${name}`,
            disabledProvider: ({ name }: { name: string }) => `desativou ${name}`,
            removedProvider: ({ name }: { name: string }) => `removeu o provedor de identidade ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `adicionou a GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `alterou a GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `substituiu os segredos da GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `verificou ${name} em ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `removeu ${name} de ${organization}`,
        },
    },
    reach: {
        title: 'Acesso',
        diagramTitle: ({ home }: { home: string }) => `Como um novo dispositivo chega a ${home}`,
        yourDevices: 'Seus dispositivos',
        noAddress: 'Sem endereço público',
        plusDirect: '+ direto (Iroh) quando possível',
        noDirect: 'Sem conexões diretas',
        thisComputer: 'Este computador',
        homeServer: 'Servidor deste Home',
        diagramDeployment: 'Fixado pela sua implantação',
        diagramHere: 'Definido aqui',
        diagramInferred: ({ method }: { method: string }) => `${method} · deduzido`,
        addresses: 'Endereços',
        addressesDescription: 'Mudar um endereço nunca desconecta ninguém.',
        publicAddress: 'Endereço público',
        webAppAddress: 'Endereço do app web',
        accessMethod: 'Método de acesso',
        publicAddressHome: 'Definido aqui',
        publicAddressNone: 'Não definido. Dispositivos de outras redes não conseguem chegar a este Home.',
        inferredFrom: ({ method }: { method: string }) => `Deduzido de ${method} no computador que hospeda este Home`,
        inferredFromHost: 'Deduzido no computador que hospeda este Home',
        webAppDescription: 'Links de e-mails e convites abrem aqui.',
        webAppServed: 'Os links abrem no app web servido por este Home.',
        webAppDefault: 'Os links abrem no app web do Happier. Padrão',
        change: 'Alterar',
        setAddress: 'Definir endereço',
        httpsRequired: 'Use um endereço https://.',
        invalidAddress: 'Digite um endereço completo, como https://home.example.com.',
        conflict: 'As configurações deste Home mudaram. Tente de novo.',
        methodLocalOnly: 'Somente este computador',
        methodLan: 'Rede local',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Como este computador expõe o Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Definido em ${host}. Abra em Hosts remotos.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Definido no computador que hospeda este Home (${host}). Abra o Happier nele ou adicione-o como host remoto.`,
        accessMethodElsewhere: 'Definido no computador que hospeda este Home. Abra o Happier nele ou adicione-o como host remoto.',
        accessMethodDeployment: 'Gerenciado pela sua implantação.',
        directConnections: 'Conexões diretas',
        directConnectionsDescription: 'Os dispositivos se conectam diretamente a este Home quando podem e, caso contrário, usam o endereço público.',
        directConnectionsRow: 'Conexões diretas (Iroh)',
        irohActive: 'Ativas · os dispositivos se conectam ponto a ponto quando podem',
        irohStarting: 'Iniciando…',
        irohOff: 'Desativadas · os dispositivos se conectam pelo endereço público',
        irohFailed: 'Não está em execução neste computador. Os dispositivos se conectam pelo endereço público.',
        irohNotAvailable: 'Indisponível nesta implantação. Os dispositivos se conectam pelo endereço público.',
        irohNeedsAddressHint: 'Defina um endereço público antes de desativá-las',
        irohOffTitle: 'Desativar as conexões diretas?',
        irohOffBody: 'Os dispositivos passarão a se conectar só pelo endereço público. A identidade atual de conexão direta deste Home é aposentada de vez; reativar cria uma nova, que os dispositivos adotam na próxima conexão. O endereço público e os logins continuam os mesmos.',
        irohOffConfirm: 'Desativar',
        irohNeedsAddressTitle: 'Defina primeiro um endereço público',
        irohNeedsAddressBody: 'Sem um endereço público, os dispositivos não teriam como chegar a este Home depois de desativar as conexões diretas.',
        relay: 'Relay para conexões diretas',
        relayAutomatic: 'Automático',
        relayOff: 'Desativado',
        relayCustom: ({ count }: { count: number }) => `Seus relays (${count}) · Aplica-se após reiniciar`,
        appliesAfterRestart: 'Aplica-se após reiniciar',
        appliesAfterRestartPending: 'Aplica-se após reiniciar · Pendente',
        exposureInternetTitle: ({ method }: { method: string }) => `Acessível pela internet via ${method}`,
        exposureAddressTitle: 'Seu endereço público está aberto a cadastros',
        exposureOpenSignup: 'Qualquer pessoa que chegue a este Home pode criar uma conta. Revise quem pode se cadastrar em Políticas.',
        exposureInvitationOnly: 'Contas novas precisam de convite, então estranhos não conseguem se cadastrar.',
        loadFailed: 'Não foi possível carregar como este Home é acessado.',
    },
    runtime: {
        title: 'Execução',
        version: 'Versão',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Este Home não informa a versão',
        flavorLight: 'Servidor leve',
        flavorFull: 'Servidor completo',
        server: 'Servidor',
        restart: 'Reiniciar',
        restartNow: 'Reiniciar agora',
        restartFailed: 'Não foi possível reiniciar o servidor',
        restartToApply: 'Reinicie o servidor para aplicá-las.',
        restartFromDeployment: 'Reinicie pela sua implantação para aplicá-las.',
        restartFromHost: ({ host }: { host: string }) => `Reinicie em ${host}, o computador que hospeda este Home.`,
        restartFromHostingComputer: 'Reinicie no computador que hospeda este Home.',
        managedFrom: ({ host }: { host: string }) => `Gerenciado a partir de ${host}`,
        managedFromBody: 'Abra o Happier no computador que hospeda este Home para atualizar, reiniciar ou parar.',
        managedElsewhere: 'Gerenciado pelo computador que hospeda este Home',
        deploymentTitle: 'Gerenciado pela sua implantação',
        deploymentBody: 'Atualizações, reinícios e backups deste servidor são feitos por quem o implanta.',
        backups: 'Backups',
        backupsHere: 'Faça backup, restaure ou mova este Home pela página Execução.',
        backupsFromHost: ({ host }: { host: string }) => `Faça backup em ${host}, o computador que hospeda este Home.`,
        backupsFromHostingComputer: 'Faça backup no computador que hospeda este Home.',
        backupsDeployment: 'Os backups são gerenciados pela sua implantação.',
        hostedHere: ({ home }: { home: string }) => `Este computador hospeda ${home}`,
        hostedHereSubtitle: 'Atualize, reinicie, faça backup e mova-o pelo console do Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 alteração se aplica após reiniciar' : `${count} alterações se aplicam após reiniciar`),
    },
    activity: {
        title: 'Atividade',
        emptyTitle: 'Ainda sem atividade',
        emptyBody: 'As alterações ao início de sessão, e-mail, pessoas, políticas e propriedade aparecem aqui à medida que acontecem.',
        showOlder: 'Mostrar anteriores',
        footnote: 'As ações feitas com o Happier diretamente no computador anfitrião, como cópias de segurança e reinícios, não são listadas.',
        loadFailed: 'Este Home não devolveu a sua atividade.',
        deploymentCommand: 'Comando de implantação',
        personalHomeSetup: 'Configuração do Personal Home',
        someone: 'Alguém',
        removedAccount: 'uma conta removida',
        claimed: 'reivindicou a propriedade deste Home',
        madeOwner: ({ target }: { target: string }) => `tornou ${target} proprietário`,
        assignedOwner: 'atribuiu o primeiro proprietário',
        changedPolicies: 'alterou as políticas',
        changedEmailSetting: 'atualizou as definições de e-mail',
        changedServerSetting: 'alterou as definições do servidor',
        changedRole: ({ target }: { target: string }) => `alterou a função de ${target}`,
        disabled: ({ target }: { target: string }) => `desativou ${target}`,
        reenabled: ({ target }: { target: string }) => `reativou ${target}`,
        changedStatus: ({ target }: { target: string }) => `alterou o estado de ${target}`,
        deleted: ({ target }: { target: string }) => `eliminou ${target}`,
        deletionStarted: ({ target }: { target: string }) => `começou a eliminar ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `terminou a sessão de ${target} em todo o lado`,
        areaOwnership: 'Propriedade',
        areaPolicies: 'Políticas',
        areaEmail: 'E-mail',
        areaServerSettings: 'Definições do servidor',
        areaPeople: 'Pessoas',
        fieldRole: 'Função',
        fieldStatus: 'Estado',
        fieldTeamProviders: 'Fornecedores de início de sessão dos Teams',
        valueEmpty: '—',
        valueChanged: 'alterado',
        valueOn: 'Ligado',
        valueOff: 'Desligado',
        secretSet: 'definida',
        secretUnset: 'não definida',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Como as pessoas entram em ${home}. Pelo menos um método continua ativo, e ninguém perde seu último acesso.`,
        methodUnavailable: 'Indisponível — sua implantação não pode oferecê-lo',
        signInService: 'Serviço de login do Home',
        signInServiceDescription: 'Entrar pelo serviço de login próprio deste Home.',
        admissionTitle: 'Quem pode criar uma conta',
        newAccounts: 'Novas contas',
        admissionAnyoneDescription: 'Qualquer pessoa que alcance este Home',
        admissionInvitationDescription: 'Somente pessoas com um convite de equipe',
        admissionNobodyDescription: 'Ninguém pode criar uma conta',
        anonymousSignup: 'Cadastro anônimo',
        anonymousSignupDescription: 'Criar uma conta só com uma chave de recuperação, sem e-mail.',
        encryptionTitle: 'Criptografia',
        encryptionDescription: 'Vale para contas e sessões criadas daqui em diante. As existentes nunca mudam.',
        storagePolicy: 'Política de armazenamento',
        storageRequired: 'E2EE obrigatória',
        storageOptional: 'Opcional',
        storagePlaintext: 'Somente texto simples',
        storageRequiredDescription: 'Todas as contas mantêm a criptografia de ponta a ponta',
        storageOptionalDescription: 'Cada conta escolhe se criptografa',
        storagePlaintextDescription: 'As contas guardam dados sem criptografia de ponta a ponta',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Vale após reiniciar · ${running} até lá`,
        allowE2ee: 'Contas com criptografia de ponta a ponta',
        allowPlain: 'Contas sem criptografia de ponta a ponta',
        recommendedInherited: 'Padrão do servidor',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Esta mudança deixa mais pessoas entrarem e precisa da sua confirmação. Nada foi alterado.',
        widening: {
            titleAnyone: 'Permitir que qualquer pessoa crie uma conta?',
            titleInvited: 'Permitir que convidados criem contas?',
            titleMethod: ({ method }: { method: string }) => `Ativar ${method}?`,
            titleAnonymous: 'Permitir cadastro anônimo?',
            titleUnencrypted: 'Permitir armazenamento sem criptografia?',
            titleOther: 'Deixar mais pessoas entrarem?',
            exposureAnyone: ({ host }: { host: string }) => `Qualquer pessoa que alcance este Home em ${host} poderá se cadastrar sem convite.`,
            exposureInvited: ({ host }: { host: string }) => `Qualquer pessoa com convite que alcance este Home em ${host} poderá criar uma conta.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Qualquer pessoa que alcance este Home em ${host} poderá entrar com ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Qualquer pessoa que alcance este Home em ${host} poderá criar uma conta só com uma chave de recuperação.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Qualquer pessoa que alcance este Home em ${host} poderá guardar seus dados aqui sem criptografia de ponta a ponta.`,
            exposureOther: ({ host }: { host: string }) => `Qualquer pessoa que alcance este Home em ${host} poderá entrar ou participar pelas regras ampliadas.`,
            unchanged: 'Contas e convites existentes não mudam.',
            recorded: 'A mudança fica registrada em Atividade com o seu nome.',
            confirmAnyone: 'Permitir que qualquer pessoa se cadastre',
            confirmInvited: 'Permitir convites',
            confirmMethod: ({ method }: { method: string }) => `Ativar ${method}`,
            confirmAnonymous: 'Permitir cadastro anônimo',
            confirmUnencrypted: 'Permitir armazenamento sem criptografia',
            confirmOther: 'Aplicar a mudança',
        },
    },
    claim: {
        pageDescription: 'Reivindique a propriedade deste Home.',
        emptyTitle: 'Este Home ainda não tem dono',
        emptyBody: 'Um dono gerencia login, e-mail, alcance e pessoas. Até alguém reivindicá-lo, ninguém pode administrar este Home.',
        codeTitle: 'Reivindicar com um código de uso único',
        codeDescription: 'Alguém com acesso ao servidor imprime um código. Ele funciona uma vez e expira em 15 minutos.',
        printStep: '1 · Imprima um código no servidor',
        pasteStep: '2 · Cole aqui',
        codeLabel: 'Código de reivindicação',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Reivindicar',
        refused: 'Este código não funcionou. Pode estar digitado errado, usado ou expirado — imprima um novo.',
        hostTitle: ({ home }: { home: string }) => `Este computador hospeda ${home}`,
        hostBody: 'Você pode tornar sua conta a dona daqui. Só este computador pode fazer isso desta forma.',
        makeOwner: 'Tornar-me dono',
        hostFailed: 'Este computador não conseguiu tornar você o dono. Tente de novo.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Definido pela sua implementação · ${key}`,
    fixedByDeploymentLead: 'Definido pela sua implementação',
    deploymentNotSetLead: 'Indisponível até a sua implementação definir',
    features: {
        title: 'Funcionalidades',
        common: 'Comuns',
        advanced: 'Avançadas',
        advancedDescription: ({ count }: { count: number }) => `Mais ${count}, agrupadas por área.`,
        other: 'Outras',
        familyCount_one: '1 funcionalidade',
        familyCount_other: ({ count }: { count: number }) => `${count} funcionalidades`,
        offHome: 'Desligada para este Home.',
        notInBuild: 'Não incluída nesta compilação.',
        needs: ({ feature }: { feature: string }) => `Precisa de ${feature}.`,
        unavailable: 'Indisponível neste Home.',
        noHomeSwitchOn: 'Sempre ligada neste Home · só a compilação do Happier a pode desligar',
        noHomeSwitchOff: 'Desligada neste Home · só a compilação do Happier a pode ligar',
        unavailableByDeployment: 'Indisponível neste Home · quem decide é a configuração da tua implantação',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Desligar ${feature} também desliga 1 funcionalidade`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Desligar ${feature} também desliga ${count} funcionalidades`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} precisa de ${parent}.`,
        turnOff: 'Desligar',
        deviceTitle: 'Funcionalidades deste dispositivo',
        deviceBody: 'As funcionalidades que só afetam este dispositivo estão nas Definições.',
        adminTitle: 'Só os proprietários podem alterar as funcionalidades',
        adminBody: 'Pode ver o que este Home oferece porque é admin.',
        loadFailed: 'Este Home não devolveu as suas funcionalidades.',
        conflictTitle: 'As funcionalidades mudaram noutro lugar',
        conflictBody: 'Alguém alterou as definições deste Home enquanto as via. A página mostra agora o que o Home guarda.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} ou mais`,
        rangeAtMost: ({ max }: { max: number }) => `Até ${max}`,
        limitInvalid: 'Introduza um número dentro do intervalo.',
        appliesAfterRestart: 'Aplica-se após reiniciar',
        onAfterRestart: 'Ligada após reiniciar',
        offAfterRestart: 'Desligada após reiniciar',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Ignorado no último arranque: ${reason}`,
        ignoredInvalidType: 'o valor guardado tem o tipo errado',
        ignoredOutOfBounds: 'o valor guardado está fora do intervalo',
        ignoredSecretUnreadable: 'o segredo guardado não pode ser lido',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Após o próximo reinício, desligar ${feature} também desliga 1 funcionalidade`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Após o próximo reinício, desligar ${feature} também desliga ${count} funcionalidades`,
    },
    data: {
        title: 'Dados',
        deletion: 'Eliminação automática',
        deletionDescription: 'As alterações aplicam-se a partir da próxima limpeza.',
        dryRunMode: 'Modo de simulação',
        dryRunModeDescription: 'A limpeza conta em vez de eliminar até desligar isto.',
        tryRules: 'Testar as regras atuais',
        tryRulesDescription: 'Executa agora uma limpeza sem eliminar nada.',
        runDryRun: 'Executar simulação',
        runAgain: 'Executar novamente',
        ranAt: ({ time }: { time: string }) => `Executada às ${time} · nada foi eliminado`,
        sweepInProgress: 'Está a decorrer uma limpeza — tente novamente quando terminar.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Eliminaria ${count} · ${examined} examinados`,
        nothingToDelete: 'Nada a eliminar',
        stopTimeBudget: 'parada: limite de tempo',
        stopRowBudget: 'parada: limite de eliminação',
        stopCandidateBudget: 'parada: limite de análise',
        stopStalled: 'parada: sem progresso',
        keep: 'Manter',
        deleteAfter: 'Eliminar após',
        days: 'dias',
        daysFor: ({ domain }: { domain: string }) => `Dias de conservação de ${domain}`,
        daysRequired: 'Indique quantos dias.',
        daysInvalid: 'Use um número inteiro de dias, 1 ou mais.',
        defaultEffect: ({ effect }: { effect: string }) => `Predefinição · ${effect}`,
        alwaysRuns: 'É executada mesmo com a eliminação automática desligada.',
        expiresAutomatically: 'Expira automaticamente',
        systemRecords: 'Registos do sistema',
        systemRecordsSummary_one: '1 tipo de registo que este Home guarda para si',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} tipos de registos que este Home guarda para si`,
        adminTitle: 'Só os proprietários podem alterar o que este Home guarda',
        adminBody: 'Pode ver as regras porque é admin.',
        loadFailed: 'Este Home não devolveu as suas definições de dados.',
        conflictTitle: 'As definições de dados mudaram noutro lugar',
        conflictBody: 'Alguém alterou as definições deste Home enquanto as via. A página mostra agora o que o Home guarda.',
    },
};

const homeGovernanceTranslations = { pt } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { pt: {
        greetingMorning: ({ name }) => `Bom dia, ${name}`,
        greetingAfternoon: ({ name }) => `Boa tarde, ${name}`,
        greetingEvening: ({ name }) => `Boa noite, ${name}`,
        greetingMorningAnonymous: 'Bom dia',
        greetingAfternoonAnonymous: 'Boa tarde',
        greetingEveningAnonymous: 'Boa noite',
        sessionsWorking: ({ count }) => (count === 1 ? '1 sessão a trabalhar' : `${count} sessões a trabalhar`),
        sessionsNeedYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        nothingRunning: 'Nada em execução ainda',
        customize: 'Personalizar',
        customizeTitle: 'Personalizar início',
        customizeDescription: 'Arraste para reordenar. Guardado na sua conta, para que todos os dispositivos mostrem o mesmo início.',
        reset: 'Repor',
        alwaysShown: 'Sempre visível',
        builtIn: 'Integrado',
        startDescription: 'Compositor e sugestões',
        attentionDescription: 'Aparece quando algo precisa de você',
        machinesDescription: 'Integrado · uma grelha das suas máquinas',
        hiddenSetupSteps: 'Passos de configuração ocultos',
        showAgain: ({ count }) => `${count} · Mostrar de novo`,
        reorderHandle: ({ section }) => `Reordenar ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "pt">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const pt: typeof en = {
    page: {
        title: 'Configurações do servidor',
        description: 'Cada configuração que o servidor lê e que não tem página própria.',
        searchPlaceholder: 'Pesquisar configurações ou variáveis de ambiente',
        changed: 'Alteradas',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Mostrar só a configuração alterada' : `Mostrar só as ${count} configurações alteradas`),
        noMatches: 'Nenhuma configuração corresponde a esta pesquisa.',
        noChanges: 'Nenhuma configuração deste Home difere do valor predefinido.',
        filterLabel: 'Mostrar',
        filterAll: 'Todas as definições',
        filterChanged: ({ count }: { count: number }) => `Alteradas · ${count}`,
        more: 'Mais',
        readOnlyTitle: 'Só leitura no arranque',
        readOnlyDescription: 'O servidor precisa destas antes de poder ler qualquer configuração guardada, por isso são definidas onde ele é executado.',
        note: 'As configurações aplicam-se assim que as alteras, exceto as marcadas com “Aplica-se após reiniciar”. Pendente significa que o valor guardado difere daquele com que o servidor arrancou. Cada alteração fica registada em Atividade; os valores secretos nunca.',
        adminTitle: 'Só os proprietários alteram as configurações do servidor',
        adminBody: 'Podes ver cada configuração e de onde vem o seu valor.',
        loadFailed: 'Não foi possível carregar as configurações do servidor.',
        saveFailed: 'A configuração não foi guardada.',
        conflictTitle: 'Configurações alteradas noutro lado',
        conflictBody: 'Alguém alterou as configurações deste Home enquanto as editavas. A página mostra agora os valores dessa pessoa; a tua edição continua no respetivo campo.',
    },
    row: {
        appliesAfterRestart: 'Aplica-se após reiniciar',
        pending: 'Pendente',
        defaultValue: ({ value }: { value: string }) => `Padrão: ${value}`,
        runningWith: ({ value }: { value: string }) => `em execução com ${value} desde o último arranque`,
        runningWithout: 'em execução sem ela desde o último arranque',
        ignored: ({ reason }: { reason: string }) => `Ignorada no último arranque: ${reason}`,
        runningOn: ({ value }: { value: string }) => `em execução em ${value}`,
        notSet: 'Não definido',
        outOfBounds: ({ bounds }: { bounds: string }) => `Tem de ser ${bounds}`,
        invalid: 'Este valor não é válido aqui',
        storedEncrypted: 'guardado encriptado, nunca mostrado',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? 'mais 1' : `mais ${count}`),
        discard: 'Descartar',
        discardA11y: 'Descartar as alterações que se aplicam após reiniciar',
        discarded: 'Alterações pendentes descartadas',
        ignoredTitle: 'Uma configuração foi ignorada no último arranque',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} configurações foram ignoradas no último arranque`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. O servidor arrancou sem ela.`,
        fix: 'Corrigir',
    },
    readOnly: {
        before_database: 'Lida antes de a base de dados abrir',
        per_process_identity: 'Difere em cada processo do servidor',
        invariant: 'Protege o início de sessão e os limites da build, por isso não pode ser alterada aqui',
        other: 'Definida onde o servidor é executado',
        set: 'Definida',
    },
    secret: {
        saved: 'Guardado',
        replace: 'Substituir',
        clear: 'Remover',
        keep: 'Manter',
        clearPending: 'O valor guardado será removido ao guardar.',
        valueSet: 'Definido',
        valueNotSet: 'Não definido',
        setAction: 'Definir',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 configuração · predefinida' : `${count} configurações · predefinidas`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} configurações · ${changed} alteradas`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'bytes',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Descartou uma configuração do servidor pendente',
    },
    choices: {
        hosted_happier_relay: 'Relay do Happier',
        direct_apns: 'Push da Apple',
        background_wake_best_effort: 'Despertar em segundo plano',
        local_only: 'Apenas este dispositivo',
        disabled: 'Desativado',
        enabled: 'Ativado',
        automatic: 'Automático',
        sandbox: 'Sandbox',
        production: 'Produção',
        owner: 'Proprietários do servidor',
        authenticated: 'Qualquer pessoa com sessão',
        self: 'Este servidor',
        external: 'Serviço externo',
        '0': 'Desativado',
        '1': 'Ativado',
        any: 'Qualquer',
        all: 'Todas',
        github_app: 'GitHub App',
        oauth_user_token: 'Token da pessoa',
        light: 'Leve',
        full: 'Completo',
        api: 'Apenas API',
        worker: 'Apenas worker',
        fatal: 'Fatal',
        error: 'Erros',
        warn: 'Avisos',
        info: 'Informações',
        debug: 'Depuração',
        trace: 'Rastreio',
        silent: 'Silencioso',
        manual: 'Manual',
        default: 'Padrão do servidor',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: pedidos por janela`,
        window: ({ route }: { route: string }) => `${route}: janela`,
    },
    groups: {
        api: 'API e rede',
        storage: 'Armazenamento e ficheiros',
        monitoring: 'Monitorização',
        process: 'Processo',
        ui: 'Disponibilização da app web',
        realtime: 'Presença e sockets',
        retentionCaps: 'Limites de recursos da retenção',
        rpc: 'Chamadas às máquinas',
        liveActivity: 'Live Activities',
        voice: 'Voz',
        connectedServices: 'Serviços ligados',
        localServices: 'Serviços locais',
        plugins: 'Plugins',
        reviews: 'Revisões',
        bugReports: 'Relatórios de erros',
        releases: 'Versões',
        authCaches: 'Caches de início de sessão',
        limits: 'Limites',
        rateLimits: 'Limites de pedidos por rota',
        github: 'Início de sessão com GitHub',
        oauth: 'Início de sessão com OAuth',
        oidc: 'Fornecedores OIDC da configuração',
        workos: 'WorkOS',
        signInRequests: 'Pedidos de início de sessão',
        offboarding: 'Saída de utilizadores',
        friends: 'Amigos',
        accountService: 'Serviço de contas',
        devices: 'Dispositivos',
        diagnostics: 'Diagnóstico',
        reachInference: 'Deteção de endereço',
        addresses: 'Endereços',
        other: 'Outras',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nome do Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Atualizações em segundo plano',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Modo de entrega',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Recorrer a outro modo',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Janela de atualizações duplicadas',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Pushes de ativação em segundo plano',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Intervalo mínimo entre pushes de ativação',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'A build de widgets recebe pushes',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Falhas antes de descartar um dispositivo',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Ambiente de push da Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID de equipa Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID da chave de push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Chave de assinatura de push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Ficheiro da chave de assinatura de push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Bundle IDs de apps permitidos',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Nomes de Live Activity permitidos',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Tempo limite dos pedidos de push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Espera de religação de push Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Usar um relay alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Endereço do relay alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Chave de acesso ao relay alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Funcionar como relay alojado',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Chaves de acesso ao relay para outros servidores',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Tolerância de relógio do relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Memória de duplicados do relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Tamanho da cache de duplicados do relay',
        ELEVENLABS_API_KEY: 'Chave de API da ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agente ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Agente ElevenLabs de produção',
        ELEVENLABS_API_BASE_URL: 'Endereço da API da ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Chave secreta da RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Sessões de voz gratuitas por mês',
        VOICE_FREE_MINUTES_PER_MONTH: 'Minutos de voz gratuitos por mês',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Sessões de voz em simultâneo',
        VOICE_MAX_SESSION_SECONDS: 'Sessão de voz mais longa',
        VOICE_MAX_MINUTES_PER_DAY: 'Minutos de voz por dia',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Preenchimento retroativo da identidade de voz',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Tamanho dos lotes de preenchimento',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Tempo máximo de preenchimento',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pausa entre lotes de preenchimento',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Intervalo entre execuções de preenchimento',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'ID de cliente OAuth do OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Endpoint de token do OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'ID de cliente OAuth da subscrição Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Endpoint de token da subscrição Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Tempo limite da troca de tokens',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Maior credencial guardada',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Concessão de atualização mais longa',
        VENDOR_TOKEN_MAX_LEN: 'Maior token de fornecedor',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Segredo dos tokens de pré-visualização',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Segredo dos tokens de pré-visualização privada',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Segredo dos tokens de pré-visualização pública',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Origem da interface dos plugins',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Validade da prova do editor',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Tolerância de relógio da prova do editor',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Validade da prova de revisão',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Tolerância de relógio da prova de revisão',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Incluir registos do servidor',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Quem pode ler os registos do servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Ficheiro de registo do servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Tamanho do registo incluído',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Canal de versões',
        HAPPIER_GITHUB_REPO: 'Repositório de versões',
        AUTH_OFFBOARDING_ENABLED: 'Verificar de novo a elegibilidade de início de sessão',
        AUTH_OFFBOARDING_STRICT: 'Recusar quando uma verificação falha',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Intervalo entre verificações',
        AUTH_PROVIDERS_CONFIG_PATH: 'Ficheiro de fornecedores',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON de fornecedores',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Serviço de início de sessão',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Endereço do serviço de contas',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identidade do serviço de contas',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nome do serviço de contas',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Contas proprietárias do servidor',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Novos dispositivos precisam de aprovação',
        GITHUB_CLIENT_ID: 'ID de cliente OAuth do GitHub',
        GITHUB_CLIENT_SECRET: 'Segredo de cliente OAuth do GitHub',
        GITHUB_REDIRECT_URL: 'Endereço de retorno do GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Tempo limite dos pedidos ao GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Guardar o token de acesso do GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Validade dos inícios de sessão pendentes',
        OAUTH_STATE_TTL_SECONDS: 'Validade do estado OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Esquemas de retorno à app permitidos',
        AUTH_GITHUB_ALLOWED_USERS: 'Utilizadores do GitHub permitidos',
        AUTH_GITHUB_ALLOWED_ORGS: 'Organizações do GitHub permitidas',
        AUTH_GITHUB_ORG_MATCH: 'Organizações exigidas',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Verificação de pertença',
        AUTH_GITHUB_APP_ID: 'ID da GitHub App de pertença',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Chave da GitHub App de pertença',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Instalações da app por organização',
        WORKOS_API_KEY: 'Chave de API do WorkOS',
        WORKOS_CLIENT_ID: 'ID de cliente do WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Validade dos pedidos de início de sessão da conta',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Validade dos pedidos de início de sessão do terminal',
        AUTH_PAIRING_TTL_SECONDS: 'Validade do código de emparelhamento',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Validade da cache de tokens de sessão',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Tamanho da cache de tokens de sessão',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Validade da cache de elegibilidade',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Tamanho da cache de elegibilidade',
        FRIENDS_USERNAME_MIN_LEN: 'Nome de utilizador mais curto',
        FRIENDS_USERNAME_MAX_LEN: 'Nome de utilizador mais longo',
        FRIENDS_USERNAME_REGEX: 'Padrão do nome de utilizador',
        HAPPIER_CANONICAL_SERVER_URL: 'Endereço da identidade de início de sessão',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Endereço de retorno OAuth da app web',
        PUBLIC_URL: 'Endereço anunciado (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Validade do endereço detetado',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Detetar a partir do método de acesso',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Detetar a partir do Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Tempo limite da verificação do Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Tempo limite da verificação do Tailscale Funnel',
        PORT: 'Porta de escuta',
        HAPPIER_SERVER_HOST: 'Endereço de escuta',
        HAPPIER_SERVER_FLAVOR: 'Variante do servidor',
        NODE_ENV: 'Ambiente Node',
        SERVER_ROLE: 'Função do processo',
        UV_THREADPOOL_SIZE: 'Threads de trabalho',
        HAPPIER_INSTANCE_ID: 'ID da réplica',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Prazo de encerramento',
        HAPPY_EXIT_ON_FATAL: 'Sair após um erro fatal',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Cache de preflight do navegador',
        HAPPIER_SERVER_IDENTITY_ID: 'Identidade do servidor',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Finalidade do relay gerido',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Operação de mudança',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Ficheiro do recibo de arranque',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce do recibo de arranque',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Recuperação para a frente do atualizador',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit da build',
        HAPPIER_FEATURE_POLICY_ENV: 'Política do canal de versões',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Funcionalidades permitidas',
        HAPPIER_BUILD_FEATURES_DENY: 'Funcionalidades recusadas',
        HAPPIER_SERVER_LOG_LEVEL: 'Nível de registo',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Registo de depuração consolidado',
        HAPPIER_SELF_HOST_LOG_DIR: 'Pasta de registos',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Diagnóstico de autenticação',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnóstico de mensagens de socket',
        METRICS_ENABLED: 'Métricas',
        METRICS_PORT: 'Porta das métricas',
        SENTRY_DSN: 'DSN de relatório de erros',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Reportar ao Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'DSN central de relatório de erros',
        SENTRY_ENVIRONMENT: 'Ambiente de relatório de erros',
        SENTRY_RELEASE: 'Versão de relatório de erros',
        SENTRY_PROFILE_LIFECYCLE: 'Criação de perfis',
        SENTRY_SEND_DEFAULT_PII: 'Enviar dados pessoais',
        SENTRY_TRACES_SAMPLE_RATE: 'Pedidos rastreados',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Sessões com profiling',
        SENTRY_ENABLE_LOGS: 'Enviar registos',
        SENTRY_LOG_LEVELS: 'Níveis de registo enviados',
        SENTRY_MONITORS_ENABLED: 'Monitores de tarefas',
        HAPPIER_SERVER_UI_DIR: 'Pasta da app web',
        HAPPIER_SERVER_UI_PREFIX: 'Caminho da app web',
        HAPPIER_SERVER_UI_REQUIRED: 'Exigir a app web',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID de implantação da app web',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Mostrar o caminho da app web quando falta',
        HAPPIER_SOCKET_ADAPTER: 'Adaptador de socket',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adaptador de socket Redis (legado)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Comprimento do stream de socket',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Tamanho de leitura do stream de socket',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Maior mensagem de socket',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Limiar de desconexão rápida',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Espera de religação durante um reinício',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Janela de religação',
        HAPPY_SOCKET_ROOMS_ONLY: 'Distribuição de socket estrita',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Posse do socket da máquina',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Comprimento do stream de presença',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Escritas de presença em simultâneo',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Intervalo de gravação da presença',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Espera de leitura da presença',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Tamanho de leitura da presença',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Recuperar presença após',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sessão inativa após',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Máquina offline após',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Intervalo de verificação da presença',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Gravação da presença ao encerrar',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Tempo limite das chamadas às máquinas',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Tempo limite da chamada de capacidades',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Tempo limite de chamada mais longo',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Esperar por um método',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Intervalo de verificação de métodos',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Tempo limite da pesquisa entre réplicas',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Esperar para parar uma sessão',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Esperar por sessões diretas',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sessões que precisam de atenção no primeiro carregamento',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Turnos verificados para reversão',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Histórico de configurações guardado',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Exigir uma chave de máquina assinada',
        DATABASE_URL: 'Base de dados',
        HAPPIER_DB_PROVIDER: 'Motor da base de dados',
        HAPPIER_DB_CONNECTION_LIMIT: 'Tamanho do conjunto de ligações',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Tempo limite de disponibilidade da base de dados',
        HAPPIER_DB_TX_MAX_RETRIES: 'Novas tentativas de transação',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Espera da primeira tentativa',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Espera mais longa entre tentativas',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Variação aleatória das tentativas',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Tempo limite das transações',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Espera por ligação',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Tempo total de novas tentativas',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Aviso de tamanho da base de dados',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migrar no arranque',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Pasta de migrações',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Modo de journal do SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Modo síncrono do SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Limite de tamanho do journal SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Intervalo de checkpoint do SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Espera do checkpoint do SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Intervalo de vacuum do SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Páginas de vacuum do SQLite',
        HAPPIER_FILES_BACKEND: 'Backend de ficheiros',
        S3_HOST: 'Host S3',
        S3_PORT: 'Porta S3',
        S3_USE_SSL: 'S3 por TLS',
        S3_REGION: 'Região S3',
        S3_BUCKET: 'Bucket S3',
        S3_PUBLIC_URL: 'Endereço público S3',
        S3_ACCESS_KEY: 'Chave de acesso S3',
        S3_SECRET_KEY: 'Chave secreta S3',
        REDIS_URL: 'Ligação Redis',
        HANDY_MASTER_SECRET: 'Segredo mestre',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Pasta de dados',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Pasta da base de dados',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Pasta de ficheiros',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Limites de pedidos',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Pedidos por cliente',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Janela do limite de pedidos',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Contar pedidos por',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Contar pedidos de rota por',
        HAPPIER_SERVER_TRUST_PROXY: 'Confiar nos cabeçalhos do proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Intervalo entre limpezas',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Linhas por lote',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Máximo de eliminações por regra',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Tempo máximo de limpeza',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Máximo de linhas analisadas por regra',
    },
};

const homeSettingsTranslations = { pt } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { pt: {
        dismiss: ({ title }) => `Ocultar “${title}”`,
        dismissTooltip: 'Ocultar · restaure em Personalizar',
        close: 'Fechar',
        addPhoneSubtitle: 'Acompanhe sessões e responda a aprovações de qualquer lugar.',
        addPhoneAction: 'Mostrar código QR',
        addMachineSubtitle: 'Um servidor ou máquina de desenvolvimento que executa agentes, configurado por SSH ou com um comando.',
        installComputerTitle: 'Instalar em outro computador',
        installComputerSubtitle: 'Instale lá o app para desktop e entre neste Home com um link.',
        installComputerAction: 'Obter o link',
        connectComputerTitle: 'Conectar um computador',
        connectComputerSubtitle: 'Escaneie o código que o Happier mostra no terminal do computador.',
        connectComputerHint: 'Aponte a câmera para o código que o Happier mostra no terminal do computador.',
        phoneAddMachineSubtitle: 'Configure um servidor ou máquina de desenvolvimento para seus agentes.',
        phoneAddMachineAction: 'Adicionar',
        thisHome: 'este Home',
        pairingPhoneTitle: 'Escaneie com o telefone',
        pairingPhoneBody: ({ home }) => `Aponte a câmera do telefone para o código. O Happier abre e entra em ${home}.`,
        pairingPhoneStepInstall: 'Instale o Happier no telefone.',
        pairingPhoneStepScan: 'Abra a câmera e escaneie o código.',
        pairingPhoneStepJoin: 'Mantenha isto aberto: o telefone entra assim que escanear.',
        pairingComputerTitle: 'Entrar de outro computador',
        pairingComputerBody: ({ home }) => `Envie este link para o outro computador. Abri-lo no Happier entra em ${home}.`,
        pairingComputerStepInstall: 'Instale o app para desktop no outro computador.',
        pairingComputerStepOpen: 'Abra o link lá ou cole-o no Happier quando ele perguntar como se conectar.',
        pairingComputerStepJoin: 'Mantenha isto aberto: o computador entra assim que abrir o link.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Baixar o app',
        copyLink: 'Copiar link',
        waitingForPhone: 'Aguardando o telefone…',
        waitingForComputer: 'Aguardando o computador…',
        newCodeIn: ({ time }) => `Novo código em ${time}`,
        makingCode: 'Criando um código…',
        addingDevice: ({ device }) => `Adicionando ${device}…`,
        deviceJoined: ({ device, home }) => `${device} entrou em ${home}`,
        codeFailed: 'Não foi possível criar um código para este Home.',
        codeFailedUnreachable: ({ home }) => `${home} não respondeu a este dispositivo.`,
        codeFailedIdentity: ({ home }) => `O registo de ${home} neste dispositivo não corresponde à resposta; volte a ligá-lo em Homes.`,
        codeFailedSignedOut: ({ home }) => `Este dispositivo não tem sessão iniciada em ${home}.`,
        codeFailedTooLarge: 'Tem demasiados endereços para caber num código.',
        codeFailedRefused: ({ home }) => `${home} recusou o pedido.`,
        codeFailedUnexpected: 'Algo correu mal; tente novamente.',
        cancelCode: 'Cancelar código',
        newCode: 'Novo código',
        qrLabel: ({ home }) => `Código QR que adiciona um dispositivo a ${home}`,
        storeQrLabel: ({ store }) => `Código QR do Happier na ${store}`,
        getTheApp: 'Baixe o app',
        connectServicesTitle: ({ first, second }) => (second ? `Conecte ${first} ou ${second}` : `Conecte ${first}`),
        connectServicesSubtitle: 'Use o plano que você já paga, em todas as máquinas, e veja quanto resta.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "pt">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { pt: {
        open: ({ destination }) => `Abrir ${destination}`,
        refreshFailed: 'Não foi possível atualizar',
        latestRunsTitle: 'Últimas execuções',
        latestRunsLoading: 'Carregando as últimas execuções',
        latestRunsEmptyTitle: 'Ainda não há execuções',
        latestRunsEmptyReason: 'Quando suas automações forem executadas, você verá aqui como foi cada execução.',
        latestRunsErrorTitle: 'Não foi possível carregar as últimas execuções',
        latestRunsErrorReason: 'Sua Home não respondeu. Verifique a conexão e tente novamente.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "pt">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { pt: {
        addHomeOrSignIn: 'Adicionar um Home / Iniciar sessão',
        sheetDescription: 'Ligue este dispositivo a outro Home ou encontre os seus.',
        continueWithService: ({ service }) => `Continuar com ${service}`,
        continueWithThisHome: 'Continuar com este Home',
        continueWithServiceSubtitle: 'Encontre os seus Homes e torne este disponível nos seus outros dispositivos.',
        serviceUnavailable: ({ service }) => `${service} está indisponível neste momento.`,
        serviceUnsupported: ({ service }) => `${service} não oferece início de sessão com conta.`,
        serviceUnavailableUnnamed: 'O seu serviço de início de sessão está indisponível neste momento.',
        serviceUnsupportedUnnamed: 'O seu serviço de início de sessão não oferece início de sessão com conta.',
        scanOrPaste: 'Ler ou colar uma ligação de Home',
        scanOrPasteSubtitle: 'Junte-se a um Home com um código QR ou uma ligação.',
        createPersonalHome: 'Criar um Home pessoal neste computador',
        createPersonalHomeSubtitle: 'Execute aqui um Home para as suas próprias máquinas e dispositivos.',
        opensFirst: 'Abre primeiro',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "pt">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const pt: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Os teus Homes estão aqui",
        reconcileLead: "Este telefone acompanha agora todos os teus Homes.",
        showMySessions: "Mostrar as minhas sessões",
        scanComputerCode: "Lê o código no teu computador",
        serviceLead: "Os teus Homes são encontrados após iniciares sessão. Este telefone acompanha-os todos.",
        serviceAsHomeLead: ({ service }) => `As tuas sessões estão em ${service}, sempre acessíveis. Adiciona um computador para executar agentes quando quiseres.`,
        factAlwaysOnDetail: "Acede às tuas sessões a qualquer momento.",
        factAgents: "Os teus computadores executam os agentes",
        factAgentsDetail: "Adiciona um mais tarde com um código QR.",
        fromDeviceHelp: "Nesse dispositivo, abre Definições → Adicionar o teu telefone e lê o código com a câmara deste telefone ou cola o link do Home.",
        scan: "Ler código",
    },
    happierAccount: 'conta Happier',
    serviceAccount: ({ service }) => `conta ${service}`,

    alreadyUseTitle: 'Já usa o Happier?',
    alreadyUseDescription: 'Encontre os seus Homes com a sua conta ou ligue-se diretamente a um Home que gere. Nada muda neste computador até escolher.',
    signIn: 'Iniciar sessão',
    withService: ({ service }) => `com ${service}`,
    changeServiceLabel: ({ service }) => `Serviço de início de sessão: ${service}. Alterar`,
    connectToHome: 'Ligar a um Home…',
    hostedPrompt: 'Prefere que fique alojado?',
    useServiceAsAHome: ({ service }) => `Usar ${service} como Home`,
    dismiss: 'Ocultar',

    pathServiceTitle: ({ service }) => `Iniciar sessão com ${service}`,
    pathServiceSubtitle: 'Encontre os Homes ligados à sua conta',
    pathOtherServiceTitle: 'Iniciar sessão com outro serviço',
    pathOtherServiceSubtitle: 'O seu próprio início de sessão ou o da sua empresa',
    pathDirectTitle: 'Ligar diretamente a um Home',
    pathDirectSubtitle: 'Uma ligação ou um endereço · sem conta',

    serviceLead: 'Os seus Homes são encontrados depois de iniciar sessão e aparecem juntos. O Home pessoal deste computador mantém-se até decidir.',
    defaultServiceFact: 'o serviço de início de sessão predefinido',
    serviceMethodsHelp: ({ service }) => `Só são mostrados os métodos que ${service} oferece. É novo? Os mesmos botões criam a sua conta.`,

    otherServiceLead: 'Se você ou a sua equipa gerem o vosso próprio serviço de início de sessão, introduza o endereço. O Happier verifica primeiro o que oferece.',
    serviceAddressLabel: 'Endereço do serviço de início de sessão',
    serviceFound: 'Encontrado',
    useThisService: ({ service }) => `Iniciar sessão com ${service}`,
    addressIsNotAService: 'Este endereço não oferece início de sessão com conta. Se for um Home, ligue-se diretamente a ele.',
    connectAsHome: 'Ligar como Home',
    backToService: ({ service }) => `Voltar a ${service}`,

    directLead: 'Para um Home que gere por si, com ou sem serviço de contas. Não precisa de conta Happier.',
    fromDeviceLabel: 'A partir de um dispositivo já ligado',
    fromDeviceHelp: 'Nesse dispositivo, abra Definições → Adicionar o seu telemóvel e leia o código com a câmara deste computador ou cole a ligação do Home.',
    homeLinkLabel: 'Ligação do Home',
    homeLinkPlaceholder: 'Cole uma ligação de Home',
    useCamera: 'Usar a câmara',
    openLink: 'Abrir',
    byAddressLabel: 'Por endereço',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Ligar',
    byAddressHelp: 'O Happier verifica se o Home responde e depois inicia sessão com os métodos desse Home.',
    notAHomeLink: 'Isto não é uma ligação de Home. Copie-a novamente do outro dispositivo.',
    homeUnreachable: 'O Happier não conseguiu chegar a nenhum Home nesse endereço. Verifique o endereço e se o Home está em funcionamento.',

    anotherWay: 'Outra forma',
    homeReachable: 'Acessível',
    connected: 'Ligado',
    signInToHomeTitle: 'Iniciar sessão neste Home',
    signInToHomeLead: 'Estas são as formas que este Home oferece.',

    reconcileTitle: 'Os seus Homes estão ligados',
    reconcileLead: ({ count }) => count === 1
        ? 'Este computador tem agora dois Homes. Aparecem juntos em Todos os Homes.'
        : `Este computador tem agora ${count + 1} Homes. Aparecem juntos em Todos os Homes.`,
    reconcileFound: 'Encontrados',
    reconcileThisComputer: 'Este computador',
    runSessionsIn: 'Executar as sessões deste computador em',
    runSessionsInDescription: 'As novas sessões iniciadas aqui são guardadas neste Home.',
    removeEmptyPersonalHome: 'Remover o Home pessoal vazio',
    removeEmptyPersonalHomeDescription: 'Foi criado quando instalou o Happier e ainda não contém nada: nem sessões, nem pessoas, nem equipas, nem convites.',
    changeLater: 'Pode alterar isto mais tarde em Definições → Homes.',
    keepBoth: 'Manter ambos',
    useHome: ({ home }) => `Usar ${home}`,
    reconcileSetupTitle: 'Escolha para onde vão as sessões deste computador',
    reconcileSetupSubtitle: ({ home }) => `Ligou ${home}. Mantenha ambos os Homes ou execute lá as sessões deste computador.`,
    reconcileSetupAction: 'Escolher…',

    serviceAsHomeTitle: ({ service }) => `Usar ${service} como o seu Home`,
    serviceAsHomeLead: ({ service }) => `As suas sessões e definições ficam em ${service} em vez de neste computador.`,
    factAlwaysOn: 'Sempre disponível',
    factAlwaysOnDetail: 'O seu telemóvel chega às sessões enquanto este computador está em repouso.',
    factAgents: 'Este computador continua a executar os seus agentes',
    factAgentsDetail: 'Nada muda quanto ao sítio onde o código é executado.',
    storageE2ee: 'Encriptação ponto a ponto',
    storageE2eeDetail: ({ service }) => `${service} guarda as suas sessões, mas não as consegue ler.`,
    storagePlain: ({ service }) => `Guardado por ${service}`,
    storagePlainDetail: 'Sem encriptação ponto a ponto: o serviço pode ler o que guarda.',
    storageE2eeByDefault: 'Encriptação ponto a ponto por predefinição',
    storagePlainByDefault: ({ service }) => `Guardado por ${service}, legível por predefinição`,
    storageChoiceDetail: 'Escolhe ao criar a sua conta.',
    removeEmptyOfferedDetail: 'Ainda não contém nada. Só é proposto porque está vazio.',
    signInOrCreate: ({ account }) => `Inicie sessão ou crie a sua ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Já usa ${service} como Home? Ao iniciar sessão, fica ligado diretamente.`,

    addHomeTitle: 'Adicionar um Home',
    addHomeDescription: 'Um Home guarda as suas sessões e definições. Ligue um que já use ou comece um novo noutro sítio.',
    addSignIn: ({ account }) => `Iniciar sessão com a sua ${account}`,
    addSignInSubtitle: 'Encontre os Homes que já usa e ligue-os.',
    addServiceAsHomeSubtitle: 'Alojado para si e sempre disponível.',
    addLinkOrQr: 'Ligar com uma ligação ou código QR',
    addLinkOrQrSubtitle: 'Não precisa de conta. Obtenha-a num dispositivo já ligado.',
    addServerHome: 'Configurar um Home num servidor',
    addServerHomeSubtitle: 'Uma máquina de desenvolvimento ou VPS que controla, configurada por SSH.',
    haveHomeAddress: 'Tem o endereço de um Home?',
    enterIt: 'Introduza-o',

    livesOnThisComputer: 'Está neste computador',
    availableWhileAwake: 'disponível enquanto estiver ativo',
    gettingReady: 'a preparar-se',
    noComputerYet: 'Ainda não tem computador?',
    aboutYourHome: 'Sobre o seu Home',

    nudgeTitle: ({ count }) => `Home inacessível ${count} vezes esta semana — mover o Home?`,
    nudgeBody: 'Se este Home funciona num computador que entra em repouso, movê-lo para um servidor sempre ligado pode ajudar.',
    nudgeDismiss: 'Ocultar para sempre neste dispositivo',
    moveHome: 'Mover o Home…',
    useService: ({ service }) => `Usar ${service}`,
};

const homesJourneysTranslations = { pt } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "pt">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "pt"> = { pt: {
        githubCurrentAccess: 'Acesso atual',
        githubCurrentAccessSubtitle: 'Necessário para as ligações e fontes de diretório ativadas que usam esta instalação.',
        githubCurrentAccessEmpty: 'Os serviços ativados não requerem acesso.',
        githubSetupAccess: 'Acesso para configuração e reparação',
        githubSetupAccessSubtitle: 'Acesso para ligações configuradas, incluindo as desativadas e fontes de diretório em pausa. Concede o acesso em falta no GitHub antes de as ativar ou retomar e verifica novamente a instalação.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Remover a instalação de ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "pt"> = { pt: {
        clientAuthenticationMethod: 'Autenticação do cliente', clientSecretPost: 'Corpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Guardar token de renovação', buttonColor: 'Cor do botão de início de sessão', iconHint: 'Ícone de início de sessão',
        allowRulesHint: 'Introduz um valor por linha. Deixa em branco para não restringir.', brandingHint: 'Deixa em branco para usar o aspeto de início de sessão predefinido.', invalidScopes: 'Inclui openid nos âmbitos pedidos.', refreshFailed: 'Não foi possível atualizar esta ligação', refreshFailedHint: 'As tuas alterações foram mantidas. Tenta novamente para verificar alterações no Home.',
    } };

const identityAdministrationTranslations = { pt: build({ ...en, title: 'Fornecedores de identidade', subtitle: 'Ligações de início de sessão do Home disponíveis para Teams.', homeConnections: 'Ligações do Home', add: 'Adicionar ligação', empty: 'Sem ligações do Home', active: 'Ativo', disabled: 'Desativado', configuration: 'Configuração', issuer: 'URL do emissor', clientSecret: 'Segredo do cliente', secretSet: 'Definido', secretNotSet: 'Não definido', secretRetain: 'Deixe vazio para manter o segredo atual.', advanced: 'Mostrar definições avançadas', hideAdvanced: 'Ocultar definições avançadas', actions: 'Ações', test: 'Testar início de sessão', testing: 'A abrir teste…', edit: 'Editar ligação', save: 'Guardar ligação', saving: 'A guardar…', enable: 'Ativar ligação', disable: 'Desativar ligação', remove: 'Remover ligação', createTitle: 'Adicionar fornecedor de identidade', editTitle: 'Editar fornecedor de identidade', displayName: 'Nome', required: 'Preencha os campos obrigatórios.', invalidIssuer: 'Introduza um URL HTTPS válido.', secretRequired: 'Introduza um segredo do cliente.', error: 'A alteração não foi aplicada.', accounts: 'Accounts afetados', connections: 'Ligações de Team', errorForbidden: 'Já não tem permissão para isto. Nada foi alterado.', errorConflict: 'Outra pessoa alterou isto primeiro. As suas edições foram mantidas: recarregue e tente novamente.', errorMissing: 'Isto já não existe. Pode ter sido removido.', errorInUse: 'Algo ainda depende disto. Remova-o primeiro.', errorProviderUnavailable: 'O serviço de identidade não respondeu. Nada foi alterado.', errorRateLimited: 'O fornecedor pediu para aguardar antes de tentar de novo.', errorInvalid: 'O Home rejeitou estes valores. Verifique a configuração e tente novamente.', errorImmutable: 'Este valor fica fixo quando o registo está em uso. Crie um novo.', errorAuthenticationRequired: 'Inicie sessão novamente nesta Team e tente de novo. Nada foi alterado.', errorPolicyUnavailable: 'A política de autenticação da Team não pode ser avaliada agora. Nada foi alterado.', errorPolicyInUse: 'A política de autenticação da Team ainda depende desta ligação.', errorNotAllowed: 'Este Home não permite que as Teams configurem isto. Nada foi alterado.', errorNeedsAttention: 'A sincronização do diretório requer atenção. Execute uma sincronização completa.', errorSyncPaused: 'Esta fonte está em pausa. «Retomar sincronização» inicia uma nova sincronização completa.', alternateLogins: 'Accounts que precisam de outro método de início de sessão', recoveryAuthenticationPolicy: 'Abrir autenticação da Team', recoveryAlternateLogin: 'Dê primeiro outro método de início de sessão a essas Accounts', recoveryDirectory: 'Abrir diretório', recoveryGroupMappings: 'Abrir mapeamentos de Grupos', recoveryTeamAuthentication: 'Iniciar sessão novamente', callbackUrl: 'URL de callback', callbackUrlHint: 'Registe este URL no seu fornecedor de identidade.' }, githubAccessWords.pt, oidcEditorWords.pt) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const pt: typeof en = {
    pageDescription: 'Tudo o que espera por você, agrupado pelo trabalho a que pertence.',
    tabs: { a11y: 'Visualização da caixa de entrada', needsYou: 'Precisa de você', updates: 'Novidades' },
    groups: {
        unknownLead: 'Sessão',
        leadMeta: ({ count }) => (count === 1 ? '1 subsessão' : `${count} subsessões`),
        runMeta: 'Execução de fluxo de trabalho',
        otherTitle: 'Outras sessões',
        otherMeta: 'Fora de um orquestrador ou de uma execução',
        openSession: 'Abrir sessão',
        openRun: 'Abrir execução',
    },
    rows: {
        step: 'Etapa',
        workflowRun: 'Execução de fluxo de trabalho',
        review: 'Revisar',
        stalled: 'Parada',
        stalledReason: 'A máquina ficou offline no meio do turno',
        landing: 'Aguardando merge',
        settle: 'Encerrar',
        snoozedUntil: ({ time }) => `Adiada até ${time}`,
        more: 'Mais ações',
        approvalNeeded: 'Precisa da sua aprovação',
        approvalUntitled: 'Aprove uma ação',
        approvalAskedBy: ({ session }) => `Pedido por ${session}`,
    },
    popover: {
        moreInOther: ({ count }) => `Mais ${count} em Outras sessões`,
        updates: ({ count }) => (count === 1 ? '1 novidade' : `${count} novidades`),
    },
    empty: {
        title: 'Nada precisa de você',
        description: 'Pedidos de permissão, revisões e tudo o que um orquestrador ou fluxo de trabalho espera de você chegam aqui.',
    },
    updatesEmpty: {
        title: 'Sem novidades',
        description: 'Sessões concluídas e pedidos de amizade chegam aqui.',
    },
    stale: { reason: 'Não foi possível atualizar as execuções de fluxos de trabalho', retry: 'Tentar novamente' },
    settleFailed: 'Não foi possível encerrar esta sessão',
};

const inboxWorkTranslations = { pt };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { pt: {
        browse: 'Procurar…',
        browseField: ({ field }) => `Procurar para ${field}`,
        unavailable: 'O plugin que oferece esta opção não está disponível. O valor atual é mantido.',
        retired: 'O plugin foi atualizado enquanto você escolhia. Tente novamente.',
        invalid: 'Essa opção não pode ser usada aqui. O valor atual é mantido.',
        failed: 'Não foi possível abrir o seletor. Tente novamente.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "pt">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { pt: { newMachine: 'Nova máquina', waiting: 'A aguardar ligação', connected: 'Ligada', failed: 'Não foi possível adicionar esta máquina', cancelled: 'Cancelado', cannotReachHost: 'Não foi possível aceder ao host. Verifique o endereço e o acesso SSH.', choosePath: 'Escolha como adicionar uma máquina', switchHome: 'Volte a esta casa para continuar' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "pt">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const pt: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Conectado com ${label}`,
    signedInAs: ({ label }) => `Conectado como ${label}`,
    signedInHere: 'Conectado nesta máquina',
    updateTo: ({ version }) => `Atualizar para ${version}`,
    needsSignIn: 'Requer login',
    waitingForSignIn: 'Aguardando login no terminal…',
    notInstalled: 'Não instalado',
    downloadSize: ({ size }) => `Download de ${size}`,
    installYourself: 'Instale você mesmo',
    unsupportedOs: 'Não funciona neste sistema',
    unsupportedArch: 'Sem versão para este processador',
    installing: 'Instalando…',
    progress: ({ done, total }) => `${done} de ${total}`,
    checking: 'Verificando…',
    offlineSignedIn: 'Última vez conectado · máquina offline',
    offlineSignedOut: 'Última vez desconectado · máquina offline',
    offlineNotInstalled: 'Não instalado da última vez · máquina offline',
    offlineUnknown: 'Máquina offline',
    unknown: 'Não foi possível verificar esta máquina',
    actionInstall: 'Instalar',
    actionUpdate: 'Atualizar',
    actionSignIn: 'Entrar',
    actionRetry: 'Tentar novamente',
    actionCancel: 'Cancelar',
    actionShowTerminal: 'Mostrar terminal',
    actionGuide: 'Guia de instalação',
    installLeadManaged: ({ agent, machine }) => `O Happier instala ${agent} em ${machine} só para o Happier. Sua configuração de terminal não muda.`,
    installLeadVendor: ({ agent, machine }) => `O Happier executa o instalador do ${agent} em ${machine}.`,
    installAlsoDownloads: ({ what }) => `Também baixa ${what}, usado pelas sessões.`,
    installThenSignIn: 'Depois você entra.',
    installAgent: ({ agent }) => `Instalar ${agent}`,
    installMyself: 'Vou instalar eu mesmo',
    manualLead: ({ agent, machine }) => `O Happier não pode instalar o ${agent} por você. Instale-o em ${machine} com o guia e verifique de novo.`,
    checkAgain: 'Verificar novamente',
    closeNote: ({ machine }) => `Pode fechar; continua em ${machine}.`,
    stepCheck: 'Verificar se funciona',
    stepSignIn: 'Entrar',
    failedKept: 'Nada ficou instalado pela metade.',
    installedLine: ({ agent, version }) => `${agent} ${version} está instalado`,
    nowSignIn: 'agora entre',
    signInHow: ({ agent }) => `Como o ${agent} entra`,
    useService: ({ service }) => `Usar seu ${service}`,
    recommended: 'Recomendado',
    serviceConnected: ({ profile }) => `${profile} · já conectado · funciona em todas as máquinas`,
    serviceNotConnected: 'Conecte uma vez; todas as máquinas podem usar.',
    connect: 'Conectar',
    signInOn: ({ machine }) => `Entrar em ${machine}`,
    signInOnDetail: ({ agent }) => `Executa o login do ${agent} em um terminal lá. Só essa máquina usa.`,
    noNativeLogin: ({ agent }) => `${agent} não tem login próprio: usa uma chave de API ou uma conta conectada. Conecte uma vez e todas as máquinas poderão usar.`,
    openSignInTerminal: 'Abrir login no terminal',
    useThisAccount: 'Usar esta conta',
    waitingLead: ({ agent, machine }) => `O login do ${agent} está aberto no terminal em ${machine}. Fica pronto assim que informar que você entrou.`,
    readyLine: ({ agent, machine }) => `${agent} está pronto em ${machine}`,
    startSessionWith: ({ agent }) => `Iniciar uma sessão com ${agent}`,
    setUpAnother: 'Configurar outro agente',
    unsupportedLead: ({ agent, machine }) => `${agent} não tem versão para ${machine}, então não pode rodar lá.`,
    setupTitle: ({ agent }) => `Configurar ${agent}`,
    signInTitle: ({ agent }) => `Entrar no ${agent}`,
    readyTitle: ({ agent }) => `${agent} está pronto`,
    notOnMachineYet: ({ machine }) => `Ainda não está em ${machine}`,
    onMachine: ({ machine }) => `Em ${machine}`,
    installingOn: ({ machine }) => `Instalando em ${machine}`,
    cantRunOn: ({ machine }) => `Não funciona em ${machine}`,
    terminalTab: ({ agent }) => `Login · ${agent}`,
    panelLead: 'Conclua no navegador que abriu. Outro dispositivo? Abra o link lá.',
    open: 'Abrir',
    openSignInPage: 'Abrir a página de login',
    waitingEllipsis: 'Aguardando login…',
    signedInAlready: 'Já entrou?',
    closeTerminal: 'Fechar terminal',
    showTheTerminal: 'Mostrar o terminal',
    phoneLead: ({ agent, machine }) => `${agent} está pedindo para você entrar. Abra a página aqui, conclua e ${machine} vai detectar.`,
    panelSignedInAs: ({ account }) => `Conectado como ${account}.`,
    panelChecked: 'O Happier verificou agora há pouco.',
    sectionTitle: 'Agentes',
    sectionDescription: 'Os agentes de programação desta máquina e como cada um entra.',
    addTitle: 'Adicionar um agente',
    addMore: ({ count }) => (count === 1 ? `Mais 1 funciona aqui` : `Mais ${count} funcionam aqui`),
    showAll: 'Mostrar todos',
    showFewer: 'Mostrar menos',
    emptyInstalled: 'Ainda não há agente nesta máquina. Escolha um abaixo; o Happier instala e faz seu login.',
    offlineNote: ({ machine }) => `${machine} está offline. Isto foi o último que ela informou.`,
    firstTitle: 'Configure seu primeiro agente',
    firstLead: ({ machine }) => `${machine} está conectado, mas ainda não tem agente. Escolha um; o Happier instala e faz seu login.`,
    firstMore: ({ count }) => (count === 1 ? `Ou escolha entre mais 1 agente.` : `Ou escolha entre mais ${count} agentes.`),
    allAgents: 'Todos os agentes',
    setUp: 'Configurar',
    choiceUsesService: ({ service, profile }) => `Usa seu ${service}. Conectado: ${profile}.`,
    choiceSignsInOn: 'Entra na máquina.',
    dismissFirst: 'Ocultar “Configure seu primeiro agente”',
    dismissTooltip: 'Ocultar · restaure em Personalizar',
    chooseAgent: 'Escolha um agente',
    blockNotInstalled: ({ agent, machine }) => `${agent} ainda não está em ${machine}.`,
    blockSetUpToStart: 'Configure-o para começar.',
    blockSignedOut: ({ agent, machine }) => `${agent} precisa de login em ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} não está instalado em ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} está desconectado em ${machine}.`,
    draftKept: 'Sua mensagem foi mantida.',
    alreadySetUp: ({ machine, home }) => `${machine} já está conectado a ${home}`,
    startSession: 'Iniciar uma sessão',
    openMachine: ({ machine }) => `Abrir ${machine}`,
};

const machineAgentsTranslations = { pt: pt } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "pt">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { pt: translated({
        machineDetailPage: {
            description: 'Inicie sessões aqui e veja o que está a correr nesta máquina.',
            placeholderTitle: 'Máquina',
            online: 'Online',
            offline: 'Offline',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Substituída por ${machine}`,
            unavailableTitle: 'Esta máquina não pode iniciar sessões agora',
            startAction: 'Iniciar sessão',
            tmuxSectionDescription: 'Como as novas sessões nesta máquina usam o tmux.',
            windowsSectionDescription: 'Como as sessões remotas abrem nesta máquina.',
            clisSectionDescription: 'CLIs de agentes que o Happier encontrou nesta máquina e as ferramentas que pode instalar.',
            runsSectionDescription: 'Processos que as sessões iniciaram nesta máquina.',
            recentSessionsTitle: 'Sessões recentes',
            recentSessionsDescription: 'As cinco sessões mais recentes nesta máquina.',
            daemonSectionDescription: 'O serviço em segundo plano que liga esta máquina ao Happier.',
            stopDaemonDescription: 'As sessões em curso continuam. Não é possível iniciar novas até o reiniciar nesta máquina.',
            stopDaemonAction: 'Parar',
            detailsTitle: 'Detalhes da máquina',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const pt = {
    machinesSection: "Máquinas",
    tierPrimaryDescription: "Tentado primeiro.",
    tierFallbackDescription: "Tentado quando nenhuma máquina anterior está online.",
    pauseMember: "Pausar para novas sessões",
    resumeMember: "Usar para novas sessões",
    pausedState: "Em pausa",
    memberMenu: "Opções da máquina",
    newPoolTitle: "Novo pool de máquinas",
    title: "Conjuntos de máquinas",
    myTitle: "Meus conjuntos de máquinas",
    add: "Adicionar pool de máquinas",
    benefit: "Escolha uma máquina preferida, com outras disponíveis como alternativa.",
    placementChangeNotice: "As alterações se aplicam às sessões iniciadas depois que você salvar. As sessões abertas permanecem na máquina atual.",
    connectionSemantics: "Uma máquina é escolhida quando uma conexão é aberta e permanece selecionada para essa conexão. Uma conexão posterior pode escolher outra máquina.",
    noMembers: "Ainda não há máquinas neste pool",
    unavailable: "Indisponível",
    memberRevoked: "Revogado",
    memberReplaced: "Substituído",
    memberTemporary: "Temporário",
    availabilityUnknown: "Disponibilidade de conexão desconhecida",
    notVerified: "Não verificado",
    brokerUnavailable: "Nenhum intermediário disponível",
    brokerAvailable: ({ count }: { count: number }) => `${count} disponíveis`,
    basics: "Detalhes",
    name: "Nome",
    description: "Descrição (opcional)",
    descriptionTitle: "Descrição",
    addMachines: "Adicionar máquinas",
    noMachines: "Não há máquinas persistentes disponíveis neste Home.",
    allMachinesAdded: "Todas as máquinas deste Home já estão neste pool.",
    primary: "Primário",
    addFallback: "Adicionar substituto",
    moveTo: "Mover para",
    moveTierEarlier: "Mover esta camada mais cedo",
    moveTierLater: "Mover esta camada mais tarde",
    removeMember: "Remover do pool",
    enableMember: "Use para seleções futuras",
    save: "Salvar alterações",
    create: "Criar pool",
    delete: "Excluir pool de máquinas",
    deleteTitle: "Excluir este pool de máquinas?",
    deleteBody: "Quaisquer recursos de credenciais que usem este pool perderão a localização do broker e precisarão de reparação. Isso afeta seleções futuras, mas não exclui máquinas nem interrompe sessões em execução.",
    saveFailed: "Não foi possível salvar este pool de máquinas. Suas alterações ainda estão aqui.",
    deleteFailed: "Não foi possível excluir este pool de máquinas. Tente novamente.",
    conflictTitle: "Este pool mudou em outro lugar",
    conflictBody: "Suas alterações não salvas serão preservadas. Recarregue a versão salva para revisar as alterações mais recentes.",
    conflictNoReload: "A identidade do pool não está mais disponível. Suas alterações não salvas serão preservadas.",
    homeOffline: "Este Home está offline. As alterações do pool estarão disponíveis após a reconexão.",
    refreshFailed: "Não foi possível atualizar os pools de máquinas. A última lista conhecida está sendo exibida.",
    featureUnavailable: "Os pools de máquinas não estão disponíveis neste Home. Atualize-os ou ative-os no Home para continuar.",
    openSettings: "Configurações do pool de máquinas",
    pickSpecificMachine: "Escolher uma máquina específica",
    poolNotFound: "Este pool de máquinas não está mais disponível.",
    reload: "Recarregar versão salva",
    reloadTitle: "Descartar suas alterações não salvas?",
    reloadBody: "Recarregar substitui este formulário pela versão salva mais recente.",
    privacy: "O servidor deste Home pode ler os nomes, as descrições e os membros dos pools, mesmo em contas com criptografia de ponta a ponta.",
    nameRequired: "Digite um nome antes de salvar.",
    memberNotEligible: "Algumas máquinas não podem mais pertencer a este pool.",
    memberNotEligibleDetail: "Remova esta máquina ou escolha outra máquina persistente.",
    resolvingTarget: "Escolhendo uma máquina deste pool…",
    resolveEmpty: "Este pool não possui máquinas habilitadas.",
    resolveNoAvailable: "Nenhuma máquina neste pool está disponível no momento.",
    resolvePresenceUnavailable: "A disponibilidade da máquina é temporariamente desconhecida.",
    resolveFailed: "Happier não conseguiu escolher uma máquina deste grupo. Tente novamente.",
    executionMachine: "Executar em",
    chosenFrom: "Escolhido de",
    aMachinePool: "Um pool de máquinas",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} de ${enabled} ativadas ligadas`,
    fallback: ({ number }: { number: number }) => `Alternativa ${number}`,
};

const machinePoolTranslations = { pt };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const pt: McpSettingsCopy = {
    purpose: 'Servidores de ferramentas que seus agentes podem usar nas sessões. Adicione um servidor uma vez e escolha onde ele se aplica.',
    add: 'Adicionar servidor MCP',
    addConfigure: 'Configurar um servidor',
    addConfigureDescription: 'Informe o comando ou endereço',
    addImportJson: 'Colar uma configuração JSON',
    addImportJsonDescription: 'De um README ou outro app',
    addOwnCategory: 'Adicionar o seu',
    addPresetCategory: 'Instalação rápida',
    addFromMachine: 'Importar desta máquina',
    addFromMachineDescription: 'Servidores que outros agentes já usam',
    searchPlaceholder: 'Buscar servidores',
    toolsGroup: 'Ferramentas',
    unbound: 'Ainda não usado em nenhum lugar',
    newServer: 'Novo servidor MCP',
    serverPurpose: 'Um servidor de ferramentas que seus agentes podem usar. Escolha abaixo onde ele se aplica.',
    addByTitle: 'Adicionar por',
    serverSection: 'Servidor',
    serverSectionDescription: 'Como o servidor se chama nas sessões e nesta lista.',
    connectionSection: 'Conexão',
    connectionSectionDescription: 'Como o Happier inicia ou acessa o servidor.',
    envDescription: 'Valores passados ao servidor. Use um segredo salvo para chaves.',
    headersDescription: 'Enviados em cada requisição. Use um segredo salvo para tokens.',
    addRule: 'Adicionar regra',
    discardDraft: 'Descartar',
    landingTitle: 'Dê mais ferramentas aos seus agentes',
    landingDescription: 'Servidores MCP adicionam ferramentas como um navegador, busca em documentação ou GitHub. Configure um, cole uma configuração ou comece com uma predefinição.',
    onMachineTitle: 'Encontrados nesta máquina',
    onMachinePurpose: 'Servidores MCP que outros agentes já configuram nesta máquina. Importe um para usá-lo no Happier.',
    onMachineSearchSection: 'Onde procurar',
    onMachineSearchDescription: 'Configurações de agentes na sua pasta pessoal e, se você escolher, em uma pasta de projeto.',
    onMachineFoundSection: 'Servidores',
    onMachineFoundDescription: 'Importar copia o servidor para o Happier; a configuração original não muda.',
    previewTitle: 'O que as sessões recebem',
    previewPurpose: 'Veja quais servidores MCP uma sessão recebe para um agente e uma pasta, e o que acontece quando um não inicia.',
    previewContextSection: 'Sessão',
    previewContextDescription: 'O agente e a pasta com que uma nova sessão começaria.',
    failurePolicyTitle: 'Quando um servidor não inicia',
    failurePolicyDescription: 'Por exemplo, quando falta um segredo salvo de que ele precisa.',
    failurePolicySkip: 'Ignorá-lo',
    failurePolicyStop: 'Parar a sessão',
    failureSection: 'Confiabilidade',
    failureSectionDescription: 'Vale para todos os servidores MCP em todas as sessões.',
    previewNothingTitle: 'Nada seria entregue',
    previewNothingDescription: 'Nenhum servidor MCP se aplica a este agente e pasta. Adicione um servidor ou uma regra que os cubra.',
    check: 'Verificar',
    scan: 'Procurar',
};

const mcpSettingsTranslations = { pt } as const;

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

const pt: DesktopTrayTranslation = {
    open: 'Abrir o Happier',
    openInHappier: 'Abrir no Happier',
    settings: 'Configurações…',
    startAtLogin: 'Iniciar ao entrar',
    quit: 'Sair do Happier',
    stopServicesAndQuit: 'Parar serviços em segundo plano e sair…',
    sessions: ({ count }: CountParams) => `${count} em execução`,
    start: 'Iniciar',
    restart: 'Reiniciar',
    stop: 'Parar…',
    userOwned: 'Gerenciado fora do Happier',
    checking: 'Verificando serviços em segundo plano…',
    readFailed: 'Não foi possível verificar os serviços em segundo plano',
    incomplete: 'Alguns serviços em segundo plano não puderam ser verificados',
    noServices: 'Este computador ainda não está configurado',
    working: 'Trabalhando…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Parar o serviço em segundo plano do Happier para ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `As sessões de agente em execução neste computador para ${relay} serão encerradas, e seu telefone e seu navegador não poderão alcançá-lo lá até que o serviço inicie novamente.`,
    stopAllConfirmTitle: 'Parar os serviços em segundo plano do Happier e sair?',
    stopAllConfirmBody: 'As sessões de agente deste computador serão encerradas, e seu telefone e seu navegador não poderão alcançá-lo até que seus serviços em segundo plano iniciem novamente.',
    stopConfirmAction: 'Parar',
    actionFailedTitle: 'Não deu certo',
    loginItemFailed: 'Não foi possível atualizar o item de início do Happier',
    quitStopTitle: 'Ainda há sessões de agente em execução',
    quitStopBody: 'Sair para os serviços em segundo plano deste computador e encerra as sessões em execução aqui.',
    quitStopUnknownTitle: 'Parar os serviços em segundo plano?',
    quitStopUnknownBody: 'O Happier não consegue ver quais sessões estão em execução neste computador. Sair para os serviços em segundo plano e encerra as que estiverem.',
    quitStopConfirm: 'Parar mesmo assim',
    quitStopKeep: 'Deixar em execução',
    quitStopFailedTitle: 'Alguns serviços em segundo plano não pararam',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} O Happier permanece aberto para você verificar os serviços em segundo plano e tentar novamente.`,
};

const ptLoginStart: DesktopLoginStartTranslation = {
    title: 'Iniciar ao entrar',
    subtitle: 'Mantém este computador acessível pelo seu telefone e navegador: seus serviços em segundo plano iniciam ao entrar e continuam funcionando depois de sair do Happier. Desativado, sair do Happier para esses serviços.',
    unknown: 'O Happier ainda não sabe se os serviços em segundo plano deste computador iniciam ao entrar.',
    notSetUp: 'Disponível quando este computador estiver configurado.',
};

const menuBarModeTranslations = { pt: { tray: pt, loginStart: ptLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { pt: {
        email: 'E-mail',
        password: 'Senha',
        signIn: 'Entrar',
        title: 'E-mail e senha',
        forgotPassword: 'Esqueceu a senha?',
        capsLock: 'Caps Lock está ativado',
        emailRequired: 'Digite seu endereço de e-mail.',
        passwordRequirements: 'Use pelo menos 15 caracteres, até 1.024 bytes UTF-8. Espaços são permitidos.',
        unavailable: 'O acesso por e-mail e senha não está disponível neste Home.',
        rateLimited: 'Muitas tentativas. Aguarde um momento e tente novamente.',
        emailInvalid: 'Digite um endereço de e-mail válido.',
        passwordMalformed: 'Esta senha contém caracteres que não podemos armazenar com segurança. Digite-a novamente.',
        passwordMismatch: 'As senhas não coincidem.',
        currentPasswordRequired: 'Digite sua senha atual.',
        currentPassword: 'Senha atual',
        newPassword: 'Nova senha',
        confirmPassword: 'Confirmar senha',
        signInFailed: 'Essa combinação de e-mail e senha não funcionou.',
        accountDisabledHere: 'Esta conta está desativada neste Home. Peça a uma administração do Home para reativá-la.',
        notEligible: 'Esta conta não pode entrar neste Home no momento.',
        linkExpired: 'Este link expirou ou já foi usado. Solicite um novo.',
        revisionConflict: 'Sua senha mudou em outro lugar. Recarregue e tente novamente.',
        serverUnavailable: 'Este Home não conseguiu concluir a solicitação. Tente novamente em breve.',
        offline: 'Sem conexão com este Home. Verifique sua rede e tente novamente.',
        homeUnreachable: 'Não foi possível acessar este Home. Tente novamente.',
        securityFactUnavailable: 'Não foi possível ler isso do seu Home.',
        cancelled: 'Essa tentativa foi cancelada.',
        approvalPending: 'Aguardando sua aprovação. Revise-a na caixa de aprovações e volte aqui.',
        outcomeUnconfirmed: 'Não foi possível confirmar se a alteração foi aplicada. Atualizamos esta conta: verifique antes de tentar de novo.',
        recoveryKeyRequired: 'Digite sua chave de recuperação para alterar a senha desta conta com criptografia de ponta a ponta. A chave permanece neste dispositivo.',
        working: 'Processando…',
        showPassword: 'Mostrar senha',
        hidePassword: 'Ocultar senha',
        createTitle: 'Crie sua conta',
        createAccount: 'Criar conta',
        accountProtection: 'Proteção da conta',
        protectionPlain: 'Legível pelo Home',
        protectionPlainDetail: 'Seu Home pode ler seus dados. Se esquecer a senha, você pode redefini-la por e-mail.',
        protectionE2ee: 'Criptografia de ponta a ponta',
        protectionE2eeDetail: 'Só os seus dispositivos podem ler seus dados. Guarde sua chave de recuperação: redefinir a senha sozinha não os restaura.',
        checkYourEmail: 'Verifique seu e-mail',
        resend: 'Enviar novamente',
        resent: 'Enviado novamente. Verifica o teu email.',
        useDifferentEmail: 'Usar outro e-mail',
        connectTitle: 'Adicionar e-mail e senha',
        connectFromSecurity: 'Entre com um método que você já usa e depois adicione e-mail e senha em Segurança da conta.',
        signInFirst: 'Entrar primeiro',
        forgotTitle: 'Esqueceu sua senha?',
        forgotExplanation: 'Podemos enviar instruções por e-mail, ou você pode usar a chave de recuperação que salvou ao criar a conta.',
        emailResetInstructions: 'Enviar instruções por e-mail',
        useRecoveryKey: 'Usar sua chave de recuperação',
        recoveryKeyDownload: 'Baixar chave de recuperação',
        recoveryKeyLater: 'Fazer isso depois',
        securitySectionTitle: 'E-mail e senha',
        signInEmail: 'E-mail de acesso',
        signInEmailNotSet: 'Não definido',
        passwordEnrolled: 'Configurada',
        passwordNotEnrolled: 'Não configurada',
        passwordSetUp: 'A sua palavra-passe está configurada para este Home.',
        passwordChanged: 'A sua palavra-passe foi alterada.',
        passwordRemoved: 'A sua palavra-passe foi removida.',
        changePassword: 'Alterar senha',
        removePassword: 'Remover senha',
        removePasswordSubtitle: 'Entrar apenas com seus outros métodos',
        removePasswordConsequence: 'Seu e-mail e senha não farão mais login neste Home. Seus outros métodos e seus dados não mudam.',
        changeEmailExplanation: 'Enviaremos um e-mail para o novo endereço para confirmá-lo. Seu e-mail atual continua funcionando até a confirmação.',
        sendVerification: 'Enviar e-mail de confirmação',
        verifyTitle: 'Confirme seu e-mail',
        verifyGeneric: 'Este link confirma o controle de uma caixa de correio.',
        verifyReturnToCreate: 'Volte a este Home para concluir a criação da sua conta com este endereço.',
        addressVerified: 'Este endereço está confirmado.',
        confirmEmailChange: 'Usar como meu e-mail de acesso',
        signInToConfirm: 'Entre neste dispositivo para confirmar a alteração.',
        returnToSignIn: 'Voltar para entrar',
        continue: 'Continuar',
        resetTitle: 'Defina uma nova senha',
        resetChooseNew: 'Escolha uma nova senha para este Home.',
        resetComplete: 'Sua senha foi alterada. Entre novamente com a nova senha.',
        resetSignsOutOtherDevices: 'Definir uma nova senha desconecta esta conta em todos os outros lugares.',
        setNewPassword: 'Salvar nova senha',
        emailPlaceholder: 'voce@exemplo.com',
        accountDisabled: ({ home }: { home: string }) => `Esta conta está desativada em ${home}. Peça a uma administração do Home para reativá-la.`,
        verificationSent: ({ email }: { email: string }) => `Enviamos um link de confirmação para ${email}. Abra-o para concluir a criação da sua conta.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Se ${email} puder entrar aqui, as instruções de redefinição estão a caminho.`,
        verificationPending: ({ email }: { email: string }) => `Confirmação enviada para ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Este link confirma ${email}.`,
        passwordNeedsEmail: 'Adicione primeiro um e-mail de início de sessão',
        passwordNeedsEmailHint: 'Começa pelo seu e-mail de início de sessão',
        setupStepConfirm: 'Confirmar',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Passo ${step} de ${total}: ${label}`,
        setupEmailHint: 'O e-mail de início de sessão e a palavra-passe são adicionados juntos. Primeiro enviamos um link para confirmar o endereço.',
        setupConfirmHint: 'Abra o link desse e-mail para escolher a sua palavra-passe.',
        setupPasswordHint: 'Introduza o e-mail que confirmou e escolha a sua palavra-passe.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { pt: { customize: 'Personalizar…', title: 'Navegação', description: 'Escolha o que fica visível, vai para Mais ou fica oculto. Arraste para reordenar. Salvo neste dispositivo.', pinned: 'Fixado', overflow: 'Mais', hidden: 'Oculto', reset: 'Redefinir', appRail: 'Barra esquerda', sessionRail: 'Barra da sessão', workspaceRail: 'Barra do espaço de trabalho', sessionTabBar: 'Abas do telefone' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "pt">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const pt: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'precisa' : 'precisam'} de você`,
    next: 'Próxima', answeredElsewhere: 'Já respondida',
    unavailableTitle: 'Não foi possível abrir a próxima solicitação',
    unavailableBody: 'Algumas sessões em espera estão indisponíveis. Reconecte e tente novamente.',
    skippedUnavailable: ({ count }) => `${count} sessões indisponíveis foram ignoradas.`,
    waitsForPermission: 'pede sua permissão', waitsForInput: 'aguarda sua resposta',
    sessionsWaiting: ({ count }) => `${count} sessões aguardando`, go: 'Ir', dismiss: 'Agora não',
};

const pendingNavigationTranslations = { pt };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { pt: {
        blocked: {
            runtime_unhealthy: 'Seu Home local precisa de atenção antes de poder iniciar.',
            home_auth_invalid: 'A autenticação do seu Home precisa de atenção.',
            existing_runtime: 'Você precisa escolher o que fazer com o Home local existente antes de continuar a configuração.',
            existing_runtime_credentials: 'Este Home local pertence a outro app Happier neste computador.',
            personal_home_erased: 'Seu Home pessoal foi apagado. Tente novamente para criar um novo.',
        },
        blockedBody: { personal_home_erased: 'Os dados do seu Home foram excluídos. Não há nada para recuperar aqui — crie um novo Home pessoal ou use outro Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "pt">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const pt: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Este endereço do Home pessoal corresponde a mais de um Home salvo.',
    signedInHome: {
        status: 'Você já entrou em outro Home.',
        body: ({ home }: HomeParams) => `Este computador está conectado a ${home}. Continue usando-o ou configure aqui um Home pessoal.`,
        keep: ({ home }: HomeParams) => `Continuar usando ${home}`,
        keepDetail: 'Suas sessões e máquinas continuam exatamente como estão.',
        create: 'Configurar um Home pessoal',
        createDetail: 'Crie um Home privado neste computador e mude para ele.',
    },
    existingRuntimeCredentials: {
        body: 'Este app não consegue abri-lo sem a chave de recuperação desse Home. Entre com a chave ou use outro Home.',
        signIn: 'Entrar com uma chave de recuperação',
        signInDetail: 'Use a chave de recuperação salva para este Home local.',
    },
};

const personalHomeDecisionTranslations = { pt };

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

const pt = {
    standardOnlyTitle: 'Ligar através dos endereços dos Homes',
    standardOnlySubtitle: 'Neste dispositivo, use o endereço de cada Home em vez de uma ligação entre pares.',
    installOrUpdateAction: 'Instalar ou atualizar o Home pessoal', startAction: 'Iniciar o Home pessoal', stopAction: 'Parar o Home pessoal',
    defaultHomeLabel: 'Home pessoal', homeTitle: 'Home', canonicalAddress: 'Endereço do Home', identityComparison: 'Home atual', identityComparisonMatch: 'Corresponde', identityComparisonMismatch: 'Não corresponde', identityComparisonUnknown: 'Não foi possível confirmar',
    unknownSize: 'Tamanho desconhecido', unknownTimestamp: 'Data/hora desconhecida', restoreBackupTitle: 'Cópia de segurança', identityTitle: 'Identidade do Home', identityUnavailable: 'Identidade indisponível', restoreBackupDate: 'Criado em', restoreCompatibility: 'Compatibilidade', restoreCompatible: 'Compatível', restoreCompatibilityVerified: 'Verificado por esta versão', restoreBackupSize: 'Tamanho', restoreReplacementNotice: 'Os dados atuais do Home serão substituídos. Será mantida uma cópia de recuperação verificada.', restoreConfirmTitle: 'Substituir e restaurar este Home pessoal?', restoreConfirmAction: 'Substituir e restaurar', relocateConfirmTitle: 'Mover este Home pessoal?', relocateConfirmBody: 'O Home atual será parado antes de a cópia verificada ficar ativa no destino.', relocateDestination: 'Destino', relocateConfirmAction: 'Mover Home', recoverRestoreTitle: 'Recuperar o restauro interrompido?', recoverRestoreBody: 'Reverte o restauro interrompido usando o material de recuperação mantido.', recoverRestoreAction: 'Recuperar restauro', eraseDataTitle: 'Eliminar os dados do Home pessoal?', eraseHomeTarget: 'Home', eraseDataBody: 'Esta ação é separada da desinstalação e elimina permanentemente apenas estes caminhos resolvidos do Home:', estimatedSize: 'Tamanho estimado', summaryTitle: 'Home pessoal', footer: 'O teu Home permanece neste computador. Estas ações não alteram outro Home.', statusTitle: 'Estado', notAvailable: 'Indisponível', storageTitle: 'Armazenamento', masterSecretTitle: 'Segredo de acesso do Home', masterSecretPresent: 'Presente', masterSecretUnavailable: 'Indisponível', inspectAction: 'Atualizar detalhes do Home', actionsTitle: 'Cópia e restauro', protectionTitle: 'Proteção', backupsSectionFooter: 'As cópias contêm conversas legíveis, dados do Home, estado de dispositivos confiáveis e o segredo de acesso do Home. Guarda-as apenas num local em que confies.', lastBackupTitle: 'Última cópia', lastBackupUnknown: 'Última cópia desconhecida', backupsTitle: 'Arquivos de cópia', backupAction: 'Fazer cópia agora', backupSubtitle: 'Cria e verifica um arquivo Home em texto simples.', exportBackupAction: 'Exportar cópia…', exportBackupSubtitle: 'Cria uma cópia verificada num local à tua escolha.', verifyAction: 'Verificar cópia…', verifySubtitle: 'Verifica um arquivo sem o restaurar.', restoreAction: 'Restaurar…', restoreSubtitle: 'Valida uma cópia antes de substituir os dados do Home.', relocateAction: 'Mover Home…', relocateSubtitle: 'Move este Home para um computador gerido.', relocationFinishAction: 'Concluir mudança', relocationReturnAction: 'Voltar ao Home original', relocationFinishSubtitle: 'Conclui a mudança depois de o destino ser verificado.', relocationReturnSubtitle: 'Mantém o Home original como localização ativa.', recoverRestoreSubtitle: 'Um restauro interrompido pode ser revertido explicitamente.', restoreRecoveryWarningTitle: 'O restauro precisa de reparação', restoreRecoveryWarningBody: 'O estado de recuperação é ambíguo. Não será feita nenhuma alteração automática. Consulta o diagnóstico antes de reparar este Home.', restoreCleanupWarningTitle: 'A limpeza do restauro requer atenção', restoreCleanupWarningBody: 'O Home foi restaurado, mas a limpeza automática não terminou. Revê os diagnósticos e tenta novamente a operação do Home.', backupVerified: 'Cópia verificada', backupNeedsAttention: 'Cópia verificada; o reinício do Home requer atenção', backupHomeReady: 'Home reiniciado', backupRevealAction: 'Mostrar cópia', restoreResultTitle: 'Resultado do restauro', restoreOutcomeRecoveryRequired: 'Recuperação necessária', restoreOutcomeRolledBack: 'Restauro revertido', restoreOutcomeRestored: 'Home restaurado', advancedTitle: 'Avançado', advancedFooter: 'Controlos do runtime e diagnóstico deste computador.', restartAction: 'Reiniciar o Home pessoal', openDataLocationAction: 'Abrir localização dos dados do Home', openLogsAction: 'Abrir registos do runtime', removeProfileAction: 'Remover Home do Happier', removeProfileSubtitle: 'Remove este perfil; os dados do runtime permanecem neste computador.', removeProfileTitle: 'Remover o perfil do Home pessoal?', removeProfileBody: 'Remove o perfil, mas mantém o runtime e os dados.', uninstallRuntimeAction: 'Desinstalar runtime, manter dados', uninstallRuntimeSubtitle: 'Remove o serviço e os binários; os dados do Home são preservados.', deleteHomeDataTitle: 'Eliminar dados do Home', removeSectionFooter: 'A desinstalação mantém os dados do Home. A eliminação permanente é uma ação confirmada separada.', eraseDataAction: 'Eliminar permanentemente os dados do Home pessoal', eraseDataSubtitle: 'Separada da desinstalação. Elimina permanentemente os dados resolvidos do Home.', eraseResultTitle: 'Dados do Home eliminados', eraseStoppedHome: 'O Home em execução foi parado', eraseHomeAlreadyStopped: 'O Home já estava parado', eraseRemainingPaths: 'Não foi possível remover', progressTitle: 'Operação do Home pessoal', dismissResult: 'Fechar',
    repairSearchAction: 'Reconstruir a pesquisa do Home',
    repairSearchSubtitle: 'Recria o índice de pesquisa a partir das conversas deste Home.',
    repairSearchCompleteTitle: 'Pesquisa do Home reconstruída',
    repairSearchCompleteBody: 'O índice de pesquisa foi recriado a partir das conversas deste Home.',
    backupCleanupRequired: 'A cópia está segura; remova o caminho de preparação protegido indicado nos detalhes',
    backupCleanupPath: 'Caminho de preparação protegido a remover',
    backupCleanupError: 'Erro de limpeza',
    backupDestinationMismatch: 'A cópia não foi criada no destino selecionado. Nada foi eliminado.',
    backupDestinationUnsafe: 'O destino de cópia selecionado está dentro dos dados do Home pessoal que seriam eliminados. Nada foi eliminado.',
    eraseInspectionAttention: 'Dados do Home eliminados; a verificação precisa de atenção',
    searchTitle: 'Pesquisa',
    searchReady: 'Pronta',
    searchIndexing: 'A indexar…',
    searchUnavailable: 'Indisponível',
    localOnlyIngressTitle: 'Acessível apenas a partir deste computador',
    localOnlyIngressBody: 'As partilhas públicas, os callbacks de fornecedores, os webhooks de plugins e as notificações enquanto este computador dorme permanecem indisponíveis até este Home ser acessível a partir do exterior.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { pt: 'Este backup contém conversas legíveis, dados do Home, o segredo de acesso do Home e o estado dos dispositivos confiáveis. Qualquer pessoa que restaure o arquivo completo pode operar um clone deste Home. Salva-o num local de confiança.' } as const;

const eraseBackupOffer = { pt: { title: 'Fazer primeiro uma cópia deste Home?', body: 'A eliminação dos dados do Home não pode ser anulada. Cria primeiro uma cópia verificada ou continua sem cópia.', continueWithoutBackup: 'Continuar sem backup' } } as const;

const operationOutcome = { pt: {
        erasePartialTitle: 'Não foi possível eliminar alguns dados do Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed} ${removed === 1 ? 'item removido' : 'itens removidos'}`
            + (remaining > 0 ? `; ${remaining} não ${remaining === 1 ? 'pôde ser removido' : 'puderam ser removidos'}` : ''),
        eraseNotPerformed: 'Nada foi eliminado',
        eraseBlockedBackupMismatch: 'Esta cópia é de outro Home.',
        eraseBlockedIdentityUnknown: 'O Happier não conseguiu confirmar que esta cópia corresponde a este Home.',
        eraseVerificationDetail: 'Verificação',
        operationFailed: 'Esta operação do Home não terminou. Abre os Detalhes para ver o que aconteceu.',
        restorePreviousDataTitle: 'Dados anteriores guardados',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "pt">;

const personalHomeSettingsTranslations = { pt: { ...pt, ...operationOutcome.pt, backupDisclosureBody: backupDisclosureBody.pt, eraseBackupOfferTitle: eraseBackupOffer.pt.title, eraseBackupOfferBody: eraseBackupOffer.pt.body, eraseContinueWithoutBackup: eraseBackupOffer.pt.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const pt: PersonalizeTranslation = {
    cardTitle: 'Personalize o Happier',
    cardSubtitle: 'Seis escolhas rápidas, cada uma com prévia ao vivo.',
    cardAction: 'Personalizar',
    cardContinue: 'Continuar',
    cardProgress: ({ saved, total, step }) => `${saved} de ${total} escolhas salvas. Retome em ${step}.`,
    cardProgressReview: ({ saved, total }) => `${saved} de ${total} escolhas salvas. Revise sua configuração.`,
    inPlaceTitle: 'Deixe o Happier do seu jeito',
    inPlaceBody: 'Seis escolhas rápidas, cada uma com prévia ao vivo. Comece pelo visual — a Home muda enquanto você escolhe.',
    inPlaceContinue: ({ count }) => `Continuar · mais ${count}`,
    notNow: 'Agora não',
    flowTitle: 'Personalize o Happier',
    finishLater: 'Terminar depois',
    later: 'Depois',
    stepEyebrow: ({ n, total, name }) => `Passo ${n} de ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} de ${total}`,
    styleEyebrow: 'Opcional',
    summaryEyebrow: 'Tudo pronto',
    previewNote: 'Prévia. Nada é salvo até você pressionar Próximo.',
    previewNoteSummary: 'Seu espaço de trabalho, como está agora.',
    next: 'Próximo',
    review: 'Revisar',
    useThisSetup: 'Usar esta configuração',
    saveFailed: 'Este passo não foi salvo. Sua escolha continua selecionada.',
    tryAgain: 'Tentar novamente',
    skipThisStep: 'Pular este passo',
    scopeThisDevice: 'Este dispositivo',
    scopeAllDevices: 'Todos os seus dispositivos',
    stepsLabel: 'Passos',
    savedStepsNote: ({ count }) => count === 1 ? '1 passo já está salvo.' : `${count} passos já estão salvos.`,
    lookName: 'Visual',
    lookTitle: 'Deixe confortável',
    lookDescription: 'Claro, escuro ou o que o seu sistema usar, e quanto vidro o app mostra.',
    themeLabel: 'Tema',
    glassLabel: 'Vidro',
    glassAutoDescription: 'Vidro em todo o app, em camadas',
    glassEverywhereDescription: 'Um vidro uniforme em todo lugar',
    glassSolidDescription: 'Todas as superfícies opacas',
    glassCustomNote: 'Você ajustou o vidro em Aparência. Escolha uma predefinição para substituí-lo ou mantenha o seu.',
    customizeInAppearance: 'Personalizar em Aparência…',
    styleName: 'Estilo',
    styleTitle: 'Comece com um estilo',
    styleDescription: 'Cada estilo define como as sessões são lidas e como a lista aparece. Ele só preenche os próximos passos: nada é salvo até você pressionar Próximo em cada um.',
    styleKeep: 'Manter minha configuração atual',
    styleActivity: 'Atividade',
    styleConversation: 'Conversa',
    styleDetail: 'Detalhe',
    styleCustomTag: 'Personalizado',
    styleDefaultTag: 'Padrão do Happier',
    styleChanges: ({ style, count }) => count === 1 ? `${style} muda 1 coisa` : `${style} muda ${count} coisas`,
    styleNoChanges: 'Esta já é a sua configuração.',
    styleNever: 'Tema, notificações, privacidade e permissões dos agentes nunca fazem parte de um estilo.',
    was: ({ value }) => `antes: ${value}`,
    conversationName: 'Conversa',
    conversationTitle: 'Acompanhe a conversa',
    conversationDescription: 'Como aparecem os turnos de uma sessão e o pensamento do agente.',
    layoutLabel: 'Layout',
    thinkingLabel: 'Pensamento',
    toolsName: 'Chamadas de ferramentas',
    toolsTitle: 'Veja o que o agente fez',
    toolsDescription: 'Como comandos, edições e leituras aparecem em uma sessão.',
    toolsLabel: 'Chamadas de ferramentas',
    toolTapLabel: 'Ao clicar em uma ferramenta',
    toolDetailLabel: 'Detalhe das ferramentas',
    toolDetailDefault: 'Padrão',
    toolDetailFull: 'Completo',
    workName: 'Seu trabalho',
    workTitle: 'Encontre seu trabalho',
    workDescription: 'Como a lista de sessões é organizada e quanto cada linha mostra.',
    listLayoutLabel: 'Lista de sessões',
    rowsLabel: 'Linhas',
    attentionName: 'Atenção',
    attentionTitle: 'Perceba o que precisa de você',
    attentionDescription: 'Onde ficam na lista as sessões que esperam por você ou estão prontas para revisão.',
    attentionLabel: 'Sessões que precisam de você',
    attentionHomeNote: 'A Home sempre mostra o que precisa de você. Isto só muda a lista de sessões.',
    notificationsName: 'Notificações',
    notificationsTitle: 'Fique por dentro',
    notificationsDescription: 'O que este dispositivo avisa quando você está olhando outra coisa.',
    notificationsAllowed: 'As notificações estão permitidas neste dispositivo.',
    notificationsNotAllowed: 'O Happier ainda não pode mostrar notificações neste dispositivo.',
    notificationsUnsupported: 'As notificações não estão disponíveis neste dispositivo. Configure-as na aplicação de computador ou no telefone.',
    scopeLook: 'Tema neste dispositivo · vidro em todos os dispositivos',
    notificationsNeedsYouSummary: 'Precisa de você',
    notificationsFinishedSummary: 'Concluído',
    notificationsAllow: 'Permitir notificações',
    notificationsTellMe: 'Avise-me quando',
    notificationsNeedsYou: 'Uma sessão precisa de uma aprovação ou resposta',
    notificationsFinished: 'Uma sessão termina o turno',
    notificationsShowLabel: 'As notificações mostram',
    notificationsShowDescription: 'Comandos, perguntas e respostas podem aparecer na tela de bloqueio.',
    notificationsMessage: 'A mensagem',
    notificationsStatus: 'Só o status',
    notificationsPhoneNote: 'Alertas no celular com o Happier fechado são configurados no próprio celular.',
    notificationsOff: 'Sem notificações',
    sampleNeedsYouTitle: 'Revisão #2481 precisa de você',
    sampleNeedsYouBody: 'O agente quer executar yarn test:e2e em ~/happier. Permitir?',
    sampleReadyTitle: '“Corrigir teste de reconexão instável” está pronto',
    sampleReadyBody: 'Encontrei: o timer de nova tentativa nunca era limpo. Está corrigido e o teste passa.',
    sampleStatusBody: 'Abra o Happier para ver.',
    sampleSessionReconnect: 'Corrigir teste de reconexão instável',
    sampleSessionCraft: 'Laboratório de acabamento',
    sampleSessionReview: 'Revisão #2481',
    sampleSessionPricing: 'Textos da página de preços',
    sampleSessionDocs: 'Índice de busca da documentação',
    sampleWorking: 'Trabalhando',
    sampleNeedsYou: 'Precisa de você',
    sampleReady: 'Pronto para revisar',
    summaryTitle: 'Esta é a sua configuração',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Tudo abaixo já está salvo. Nada mudou.'
        : changed === 1
            ? 'Tudo abaixo já está salvo. Uma escolha mudou; o resto ficou como estava.'
            : `Tudo abaixo já está salvo. ${changed} escolhas mudaram; o resto ficou como estava.`,
    summaryChange: 'Alterar',
    summaryFooter: 'Você pode mudar tudo isso depois em Configurações ou percorrer de novo a partir de Configurações → Aparência.',
    replayTitle: 'Personalize o Happier',
    replaySubtitle: 'Seis escolhas rápidas, cada uma com prévia ao vivo.',
    replayAction: 'Começar',
    journeyHandoff: 'Deixe do seu jeito',
};

const personalizeTranslations = { pt } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "pt">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const pt: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'O layout de telefone dentro das sessões e os gestos da barra. Cada gesto pode ser desativado separadamente.',
            swipeSidewaysTitle: 'Deslize para o lado para trocar de sessão',
            swipeSidewaysScrollsDescription: 'Anterior ou próxima, na barra. Quando suas ferramentas não cabem, deslizar as rola.',
            swipeSidewaysAlwaysDescription: 'Anterior ou próxima, na barra. Continua sendo um deslize; as ferramentas que não cabem esperam em Mais.',
            alwaysSwipeTitle: 'Sempre deslizar entre sessões',
            alwaysSwipeOnDescription: 'A barra mantém as ferramentas que cabem; o resto espera em Mais.',
            alwaysSwipeOffDescription: 'Desativado: ferramentas extras fazem a barra rolar.',
            dragUpTitle: 'Arraste para cima para trocar',
            dragUpDescription: 'Arraste a barra para cima para ver suas abas abertas e sessões recentes, e deslize até uma.',
            dragUpSourceTitle: 'Arrastar para cima mostra',
            dragUpSourceRecentDescription: 'Abas abertas e depois o que você abriu recentemente neste dispositivo.',
            dragUpSourceListDescription: 'Sessões na ordem da lista.',
            swipeSourceTitle: 'Deslizar para o lado mostra',
            swipeSourceListDescription: 'A próxima ou a anterior sessão da sua lista.',
            swipeSourceRecentDescription: 'A próxima ou a anterior por quando você a abriu pela última vez.',
            sourceRecent: 'Recentes',
            sourceList: 'Lista de sessões',
            flickTitle: 'Faça um movimento rápido para cima ou para baixo para trocar',
            flickDescription: 'Um movimento rápido abre a próxima ou a anterior.',
            holdToDockTitle: 'Segure para manter o seletor aberto',
            holdToDockDescription: 'Segure a barra e solte para escolher com um toque.',
            pullAllTabsTitle: 'Puxe o título para ver todas as abas',
            pullAllTabsDescription: 'Arraste o título da sessão para baixo para ver todas as abas abertas e sessões recentes.',
        },
        bar: {
            onTheBar: 'Na barra',
            more: 'Mais',
            heldInMore: 'Em Mais enquanto “Sempre deslizar” está ativado',
            keepOnBar: 'Manter na barra',
            removeFromBar: 'Remover da barra',
            openFiles: 'Abrir arquivos',
        },
        allTabs: {
            title: 'Todas as abas',
            pullHint: 'Puxe para ver todas as abas',
            releaseHint: 'Solte para ver todas as abas',
            openTabs: 'Abas abertas',
            openTabsSynced: 'Abas abertas · sincronizadas',
            recent: 'Recentes',
            recentOnThisDevice: 'Recentes neste telefone',
            here: 'Aqui',
            panes: ({ count }: { count: number }) => `${count} painéis`,
            emptyTitle: 'Nada mais está aberto',
            emptyDescription: 'As sessões que você abre e as abas que mantém aparecem aqui, as mais recentes primeiro.',
            openTab: ({ title }: { title: string }) => `Abrir ${title}`,
        },
        rail: {
            label: 'Abas abertas',
            synced: 'Sincronizadas',
            syncedA11y: 'As abas abertas sincronizam entre seus dispositivos',
            notAvailableTitle: 'Indisponível neste telefone',
            notAvailableUnknown: 'Esta aba foi aberta em outro dispositivo e este telefone não consegue mostrá-la. Ela continua aberta lá.',
            closeTab: 'Fechar aba',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
            nextPane: 'Próximo painel',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Trocar para',
            allSessions: 'Todas as sessões',
            openTabs: 'Abas abertas',
            synced: 'sincronizadas',
            recent: 'Recentes',
            recentOnThisDevice: 'Recentes neste telefone',
            sessions: 'Sessões',
            nextInSessions: 'Próxima em Sessões',
            previousInSessions: 'Anterior em Sessões',
            furtherBack: 'Mais para trás',
            moreRecent: 'Mais recente',
            here: 'Aqui',
            stayOn: 'Ficar em',
            noOlderSessions: 'Nenhuma sessão mais antiga',
            noNewerSessions: 'Nenhuma sessão mais recente',
            lastInSessions: 'Esta é a última em Sessões.',
            firstInSessions: 'Esta é a primeira em Sessões.',
            nothingFurtherBack: 'Nada mais para trás.',
            mostRecent: 'Esta é a mais recente.',
            nothingToSwitch: 'Nada mais está aberto',
            nothingToSwitchDescription: 'As sessões que você abre aparecem aqui, as mais recentes primeiro.',
            draft: ({ text }: { text: string }) => `Seu rascunho: “${text}”`,
            switchSessionAction: 'Trocar de sessão',
            switchedTo: ({ name }: { name: string }) => `Trocou para ${name}`,
            close: 'Fechar',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
        },
    },
};

const phoneNavigationTranslations = { pt };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { pt: {
    accountDataErase: {
        installedGroupTitle: 'Dados da conta',
        installedGroupFooter: 'Isso afeta apenas os dados retidos da conta atual. Ele não desinstala este plugin de nenhuma máquina.',
        installedEntryTitle: 'Apagar dados da conta',
        installedEntrySubtitle: 'Remova permanentemente os dados retidos deste plugin da conta atual.',
        orphanedGroupTitle: 'Dados retidos do plug-in',
        orphanedGroupFooter: 'Use um ID de plug-in para remover dados retidos da conta após a remoção de um plug-in.',
        orphanedEntryTitle: 'Apagar dados retidos do plugin',
        orphanedEntrySubtitle: 'Insira um ID de plug-in instalado ou removido para apagar permanentemente os dados atuais da conta.',
        promptTitle: 'ID do plug-in',
        promptBody: 'Insira o ID do plugin cujos dados retidos você deseja apagar da conta atual.',
        promptPlaceholder: 'com.exemplo.plugin',
        invalidTitle: 'Insira um ID de plug-in',
        invalidBody: 'Use o ID exato do plugin antes de continuar.',
        confirmTitle: 'Apagar dados do plugin da conta?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Isso remove permanentemente os dados retidos para ${pluginId} da conta atual. Ele não desinstala o plugin de suas máquinas.`,
        confirm: 'Apagar dados',
        completedTitle: 'Dados do plug-in da conta apagados',
        completedChanged: 'Os dados retidos do plug-in foram removidos da conta atual.',
        completedEmpty: 'Nenhum dado de plug-in retido foi encontrado para este plug-in na conta atual.',
        partialTitle: 'Alguns dados do plugin permanecem',
        partialBody: 'Alguns dados retidos não puderam ser apagados. Nada será tentado novamente automaticamente; tente novamente apagar os dados restantes.',
        failedTitle: 'Os dados do plugin não foram apagados',
        failedBody: 'Os dados retidos não puderam ser apagados. Tente novamente após verificar a conexão da conta atual.',
        unavailableTitle: 'Os dados do plug-in não estão disponíveis',
        unavailableBody: 'A conta atual foi alterada ou está indisponível. Reabra esta ação depois que a conta estiver pronta.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { pt: {
    accountReleaseSelection: {
        groupTitle: 'Liberação de conta',
        groupFooter: 'Selecione uma versão exata para esta conta. Isso não instala, atualiza ou confia no plugin em nenhuma máquina.',
        entryTitle: 'Usar para esta conta',
        entrySubtitle: ({ version }: { version: string }) => `Selecione a versão ${version} para a conta atual sem alterar nenhuma instalação da máquina.`,
        selectedTitle: 'Liberação da conta selecionada',
        selectedBody: 'A versão do plugin selecionada será agora usada para esta conta.',
        conflictTitle: 'Liberação da conta alterada',
        conflictBody: 'A versão da conta mudou enquanto esta ação estava aberta. Abra-o novamente e tente novamente.',
        unavailableTitle: 'Liberação de conta indisponível',
        unavailableBody: 'A versão exata ou a origem de migração necessária não está disponível para a conta atual. Tente novamente quando a conta estiver pronta.',
        rejectedTitle: 'A liberação da conta não foi selecionada',
        rejectedBody: 'A conta não aceitou esta seleção de liberação. Verifique o estado da conta e tente novamente.',
        hostedGroupFooter: 'Gerencie os artefatos do plugin que esta conta hospeda para o plugin. Nenhuma máquina oferece esta versão no momento, então ela não pode ser selecionada aqui.',
        hostedEnableTitle: 'Hospedar artefatos do plugin para esta conta',
        hostedEnableBody: "Armazena a interface e os recursos do pacote no servidor da sua conta. Em contas sem criptografia, o servidor pode ler os dados; com E2EE, armazena dados criptografados. Os metadados da versão continuam visíveis. Isso não instala nem confia no plugin e não permite executá-lo em uma máquina offline.",
        hostedDisableTitle: 'Parar de hospedar artefatos do plugin',
        hostedStatusDisabled: "Desativado. Ative a hospedagem para baixar os artefatos desta versão quando a máquina de origem estiver offline.",
        hostedStatusPending: 'Ativado. Esta versão aguarda o host publicar os artefatos exatos do plugin.',
        hostedStatusReady: 'Os artefatos do plugin hospedados estão disponíveis para esta versão exata.',
        hostedRemoveTitle: 'Desativar a hospedagem e remover os artefatos',
        hostedRemoveBody: 'Interrompe a hospedagem na conta e remove os artefatos do plugin hospedados desta versão. A limpeza do cache local é separada.',
        hostedClearCacheTitle: 'Limpar o cache local de artefatos',
        hostedClearCacheBody: 'Remove os bytes de artefatos de interface armazenados localmente para esta versão exata sem alterar a hospedagem na conta.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { pt: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.pt) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const pt = {
    invocationLogs: {
        title: 'Registos de invocação',
        footer: 'Registos limitados e redigidos da máquina de plugin selecionada.',
        correlationFilter: 'Filtro de ID de correlação',
        correlationFilterAll: 'Todas as invocações deste plugin',
        correlationPromptTitle: 'Filtrar por ID de correlação',
        correlationPromptBody: 'Mostre apenas registos de uma invocação exata do plugin. Deixe vazio para mostrar todos os registos.',
        correlationPromptPlaceholder: 'ID de correlação',
        refresh: 'Atualizar registos',
        follow: 'Acompanhar registos',
        stopFollowing: 'Parar acompanhamento',
        loadMore: 'Carregar os registos seguintes',
        loadingTitle: 'A carregar registos de invocação',
        loadingSubtitle: 'A ler registos limitados e redigidos da máquina selecionada.',
        idleTitle: 'Pronto para ler registos de invocação',
        idleSubtitle: 'Atualize para ler registos limitados e redigidos da máquina selecionada.',
        emptyTitle: 'Não existem registos de invocação',
        emptySubtitle: 'Não existem registos redigidos correspondentes nesta máquina selecionada.',
        unavailableTitle: 'Registos de invocação indisponíveis',
        unavailableSubtitle: 'A máquina de plugin selecionada está indisponível ou deixou de ser atual.',
        readerUnavailableSubtitle: 'A máquina de plugin selecionada não consegue fornecer registos de invocação neste momento.',
        selectionRequiredTitle: 'Selecione uma máquina de plugin',
        selectionRequiredSubtitle: 'Escolha acima uma materialização compatível do plugin antes de ler os respetivos registos.',
        conflictTitle: 'Resolva a máquina de plugin selecionada',
        conflictSubtitle: 'Escolha acima uma materialização compatível do plugin antes de ler os respetivos registos.',
        errorTitle: 'Não foi possível carregar os registos de invocação',
        errorSubtitle: 'A leitura dos registos não foi concluída. Tente novamente quando a máquina selecionada estiver disponível.',
        noMessage: 'Evento de registo do plugin',
        level: {
            debug: 'Depuração',
            info: 'Informações',
            warn: 'Aviso',
            error: 'Falha',
            diagnostic: 'Diagnóstico',
        },
    },
};

const pluginInvocationLogTranslations = { pt } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { pt: {
        machineMatrix: {
            title: 'Nas suas máquinas',
            footer: 'Só leitura. Instalar, atualizar e todas as outras ações do plugin acontecem na máquina selecionada acima.',
            empty: 'Nenhuma máquina comunicou ainda uma instalação de plugin para esta conta.',
            unavailable: 'A disponibilidade de plugins da conta ainda não carregou, por isso os estados das máquinas são desconhecidos.',
            incomplete: ({ count }: { count: number }) => `Esta lista pode estar incompleta: ${count} servidor(es) ainda não comunicaram as suas máquinas.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Instalado e atualizado em ${installed} de ${total} máquinas`,
            lastObserved: ({ ago }: { ago: string }) => `visto pela última vez: ${ago}`,
            state: {
                installedCurrent: 'Instalado e atualizado',
                disabled: 'Desativado',
                untrusted: 'Sem confiança',
                incompatible: 'Versão diferente',
                localOnly: 'Local a esta máquina',
                staleOffline: 'Último estado conhecido, máquina offline',
                absent: 'Não instalado',
                unknown: 'Desconhecido',
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

const marketplacePresentation = { pt: {
        diagnosticsIssueTitle: 'Problema do plugin', diagnosticsRecovery: 'Consulte os detalhes acima e, depois de corrigir, recarregue o plugin ou esta página.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Código técnico: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Identificação do editor: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Categorias: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Executa em: ${realms} · Plataformas: ${platforms}`, reviewStatus: { curated: 'Recomendação selecionada', unreviewed: 'Não analisado', withdrawn: 'Retirado' }, executableRealm: { daemon: 'serviço em segundo plano', client: 'aplicação', hostedWeb: 'web alojada' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problema com uma fonte do marketplace', recovery: 'Atualize Descobrir. Se continuar, verifique Fontes e registos.', unreachableTitle: ({ source }: { source: string }) => `Não foi possível contactar ${source}`, behindTitle: ({ source }: { source: string }) => `${source} respondeu com dados antigos ou incompletos`, indexTitle: 'O índice de plugins está incompleto', otherSourcesShown: 'Os resultados das outras fontes continuam visíveis.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { pt: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Caminho local', archive: 'Ficheiro de arquivo', npm: 'Pacote npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Catálogo selecionado', 'community-npm': 'Catálogo npm público', user: 'Catálogo pessoal' }, executableRealm: { daemon: 'Código do serviço em segundo plano', reactNative: 'Código da interface da aplicação', hostedWeb: 'Código web alojado isolado' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Recursos de interface verificados', none: 'Sem recursos de interface', unavailable: 'Recursos de interface indisponíveis' }, authorizationClass: { cooperativeDisclosure: 'Divulgação cooperativa', hostResourceSelection: 'Recursos do sistema selecionados', presentIntentOrOs: 'Intenção atual ou permissão do sistema' }, priority: ({ priority }: { priority: number }) => `Prioridade ${priority}` } } as const;

const localizedReviewVocabulary = { pt: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.pt,
            archiveUrlRetention: 'O Happier salva a URL completa do arquivo na máquina selecionada, incluindo eventuais credenciais, para futuras atualizações. URLs expiradas ou revogadas podem impedir as atualizações.',
            trustedCodeTitle: 'Código confiável', trustedCodeDisclosure: 'Os plugins são executados como código confiável dentro do Happier, não numa sandbox. Um plugin pode usar diretamente as permissões desta aplicação — ficheiros, rede, ambiente e processos — para além dos serviços mediados pelo Happier listados abaixo. Essa lista é o que o plugin declarou e o que poderás desativar mais tarde, não um limite ao que o seu código consegue alcançar.', identity: 'Identidade e pacote', evidence: 'Dados técnicos', executableCode: 'Código executável e contribuições', requiredAccess: 'Acesso obrigatório ao sistema', optionalAccess: 'Acesso opcional ao sistema', requestInterceptors: 'Intercetores de pedidos', rawCredentials: 'Declarações de acesso direto a credenciais', compatibility: 'Compatibilidade e atualizações', none: 'Nada declarado', scope: ({ scope }: { scope: string }) => `Âmbito: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · desenvolvimento`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · não verificado`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (esperada)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (observada)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Assinatura do registo verificada: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Assinatura do registo não suportada: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Declarada, não verificada: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Obtida, não verificada: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Proveniência indisponível: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Origem de catálogo não analisada: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Analisada por ${sourceId} em ${reviewedAt}${reason}`, savedSecret: 'Segredo guardado', connectedAccount: 'Conta ligada', secretKinds: ({ kinds }: { kinds: string }) => `Tipos de segredo: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Serviço: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Finalidade: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Usado em ${realm} durante ${phase}`, credentialAccess: ({ access }: { access: string }) => `Acesso: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Cabeçalhos enviados para ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Variáveis de ambiente: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Ficheiros: ${files}`, realm: { web: 'o navegador', ios: 'a aplicação iOS', android: 'a aplicação Android', daemon: 'o serviço em segundo plano' }, phase: { settings: 'a configuração', prepare: 'a preparação', connection: 'a ligação', speech: 'o uso de voz' }, runtimeApi: ({ version }: { version: number }) => `API de execução ${version}`,
        },
        sourceAdministration: { title: 'Origens e registos', subtitle: 'Escolha onde esta máquina encontra os pacotes npm exatos e como acede aos respetivos registos.', communityTitle: 'Diretório npm público', communitySubtitle: 'Integrado · pesquisa não analisada de plugins Happier elegíveis no npm público, não de quaisquer pacotes npm.', configuredTitle: 'Origens do marketplace', configuredEmpty: 'Não há origens adicionais configuradas.', add: 'Adicionar origem', edit: 'Editar origem', remove: 'Remover origem', removeTitle: 'Remover a origem do marketplace?', removeBody: ({ name }: { name: string }) => `${name} deixará de ser usada para pesquisa nesta máquina. Os plugins instalados não serão alterados.`, sourceUrl: 'Endereço da origem', displayName: 'Nome apresentado', description: 'Descrição opcional', enabled: 'Ativada', disabled: 'Desativada', curated: 'Origem selecionada', user: 'A sua origem', loadError: 'Não foi possível carregar as origens do marketplace.', retry: 'Tentar novamente', operationFailed: 'Não foi possível aplicar a alteração. Verifique a ligação à máquina e tente novamente.', operationOutcomeUnknownTitle: 'Alteração pendente de análise', operationOutcomeUnknownBody: 'A máquina selecionada pode já ter aplicado esta alteração, mas o Happier não conseguiu confirmar o resultado. Reveja as definições atualizadas antes de as alterar novamente.' },
        updatePolicy: { title: 'Regra de atualização', target: ({ machine, server }: { machine: string; server: string }) => `Aplica-se em ${machine} através de ${server}.`, pinned: 'Versão fixada', pinnedSubtitle: 'Não atualizar até escolher outra regra.', allowed: 'Atualizações permitidas', allowedSubtitle: 'As atualizações explícitas avançam sem nova confirmação, exceto se as permissões declaradas aumentarem.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { pt: {
        ...localizedReviewVocabulary.pt,
        ...marketplacePresentation.pt,
        secretFieldActions: { delete: 'Eliminar o segredo guardado', deleteHint: 'Apaga o valor guardado. Não é possível anular.', unbind: 'Remover deste plugin', unbindHint: 'Desassocia o segredo guardado desta definição. O segredo é mantido.' },
        pluginChangeOutcomeUnknownTitle: 'Resultado não confirmado',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `O Happier não conseguiu confirmar se ${action} para ${name} terminou em ${machine} (${server}). Consulta a lista de instalados dessa máquina e a versão atual antes de tentares novamente.`,
        updateFromInstalledRecordSubtitle: 'Avançar esta instalação pelo seu próprio canal de atualização de confiança.',
        discover: {
            ...marketplacePresentation.pt.discover,
            status: {
                loading: 'A pesquisar em todas as fontes do marketplace…',
                loadingSource: ({ source }: { source: string }) => `A pesquisar em ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} plugin(s) de ${sources} fonte(s)`,
                empty: 'Nenhum plugin corresponde a esta pesquisa.',
                error: ({ message }: { message: string }) => `Não foi possível atualizar a pesquisa: ${message}`,
                errorTitle: 'Não foi possível atualizar a pesquisa',
                stale: 'Estes resultados respondem a uma pesquisa anterior. Pesquise de novo para aplicar os controlos acima.',
                partial: ({ count }: { count: number }) =>
                    `${count} fonte(s) responderam com dados antigos ou em falta, por isso os resultados podem estar incompletos.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `Foram encontradas ${count} entrada(s) que neste momento não podem ser instaladas nesta máquina.`,
            },
            sourceFreshness: {
                stale: 'Mais antigo do que esta fonte',
                'stale-offline': 'Últimos resultados conhecidos, fonte offline',
                unavailable: 'Fonte indisponível',
                'auth-unavailable': 'Esta fonte exige sessão iniciada',
                corrupt: 'Não foi possível ler o índice da fonte',
            },
            nonInstallableReason: {
                sourceStale: 'A sua fonte do marketplace não está atual.',
                artifactUnavailable: 'O seu pacote não é alcançável com o acesso ao registo desta máquina.',
                notApproved: 'A instalação a partir desta fonte não está aprovada.',
                unsupportedSourceKind: 'Esta versão do Happier não suporta este tipo de fonte.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Reveja tudo o que este plugin declara antes de confiar em algo vindo de ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Precisa de um perfil de registo para ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Escolha um registo para ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} é publicado em ${origin}. Escolha o perfil de registo que ${source} usa nesta máquina, ou adicione um e inicie sessão. Nada é transferido antes da revisão de instalação e confiança.`,
                continue: 'Continuar',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { pt: {
        fields: {
            pluginId: 'ID da extensão',
            capability: 'Capacidade',
            scope: 'Âmbito',
            requester: 'Solicitante',
            authority: 'Autoridade',
            requestedAt: 'Hora do pedido',
            reason: 'Motivo',
        },
        scope: { account: 'Conta', project: 'Projeto', workspace: 'Espaço de trabalho' },
        requester: { user: 'Utilizador', host: 'Anfitrião', plugin: 'Extensão' },
        authority: { bundled: 'Incluída', machineInstallation: 'Instalação na máquina' },
        identifiers: {
            session: 'Sessão',
            request: 'Pedido',
            machine: 'Máquina',
            installation: 'Instalação',
        },
        accessibilitySummary: ({ details }) => `Detalhes do pedido de permissão. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "pt">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { pt: {
        rowStatus: { enabled: 'Ativado', disabled: 'Desativado', incompatible: 'Não compatível', trustRemoved: 'Confiança removida', needsAttention: 'Requer atenção' },
        developmentPhase: { observing: 'A observar', preparingDependencies: 'A preparar dependências', compiling: 'A compilar', validating: 'A validar', active: 'Ativo', retainedIncumbent: 'Versão anterior ativa', unavailable: 'Indisponível' },
        rowSource: { bundled: 'Incluído no Happier', npm: 'Pacote npm', archive: 'Ficheiro de arquivo', localPath: 'Pasta local', other: 'Origem configurada' },
        rowAttention: { trustRemoved: 'Este plugin já não é executado. Reinstale-o para voltar a confiar no seu código.', incompatible: 'Esta versão não pode ser executada na máquina selecionada.' },
        developerGroupTitle: 'Desenvolvimento',
        developerGroupFooter: 'Crie plugins na máquina selecionada e veja o que o seu serviço reporta.',
        developerDevelopmentSubtitle: 'Crie, edite, teste e empacote plugins a partir de pastas suas.',
        developerDiagnosticsSubtitle: 'Diagnósticos do serviço e do catálogo para a máquina selecionada.',
        detailMissingTitle: 'Este plugin não está na máquina selecionada',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} não está instalado aqui. Pode ter sido desinstalado ou estar noutra máquina.`,
        detailMissingRetry: 'Verificar novamente',
        surfaces: {
            purpose: 'Adicione superfícies, comandos e integrações ao Happier. Os plugins são executados como código confiável nas suas máquinas.',
            navigationTitle: 'Plugins',
            updatesTitle: 'Atualizações',
            moreDescriptionInSettings: 'De onde vêm os plugins, criar os seus e o que esta máquina informa. Abrem nas Definições.',
            fix: 'Corrigir',
            allSources: 'Todas as fontes',
            shelfCurated: 'Seleção',
            shelfCuratedDescription: 'Revisados e recomendados pelo Happier. Cada instalação ainda mostra a revisão completa.',
            shelfCommunity: 'Comunidade',
            shelfCommunityDescription: 'Pacotes npm não revisados. Instalar e confiar mostra exatamente o que cada um pode acessar.',
            shelfUser: 'Suas fontes',
            shelfUserDescription: 'Listagens de fontes de marketplace adicionadas nesta máquina.',
            manage: 'Gerenciar',
            installed: 'Instalado',
            notShownTitle: 'Não foi possível mostrar tudo',
            listingInstallsOn: ({ machine }: { machine: string }) => `Instala em ${machine}. Você revisa o acesso antes de qualquer execução.`,
            listingChooseMachine: 'Escolha uma máquina no cabeçalho para instalar este plugin.',
            listingRunsIn: 'Executa em',
            listingPlatforms: 'Plataformas',
            listingSource: 'Fonte',
            listingCategories: 'Categorias',
            listingNotFoundTitle: 'Esta listagem não está disponível',
            listingNotFoundBody: 'Ela pode ter sido removida da fonte, ou esta máquina não consegue acessar a fonte agora.',
            developmentSourcesTitle: 'Plugins em desenvolvimento',
            chooseMachineInstalled: 'Escolha uma máquina no cabeçalho para ver os plugins dela.',
            chooseMachineBrowse: 'Escolha uma máquina no cabeçalho para explorar os plugins que ela pode instalar.',
            openAsPage: 'Abrir como página',
            detailInstalledLabel: 'Plugin instalado',
            detailListingLabel: 'Ficha do plugin',
            viewLabel: 'Mostrar como',
            viewGrid: 'Grade',
            viewList: 'Lista',
            installedSearchPlaceholder: 'Pesquisar plugins instalados',
            statusFilterLabel: 'Mostrar plugins',
            statusAll: 'Todos os plugins',
            statusEnabled: 'Ativados',
            statusDisabled: 'Desativados',
            statusAttention: 'Precisam de atenção',
            noMatch: ({ query }: { query: string }) => `Nenhum plugin corresponde a “${query}”`,
            clearSearch: 'Limpar',
            emptyTitle: 'Nenhum plugin instalado ainda',
            emptyBody: 'Os plugins adicionam painéis, comandos e ferramentas para os seus agentes. Comece pelos feitos pelo Happier.',
            browsePlugins: 'Explorar plugins',
            browseEmpty: 'Suas fontes ainda não oferecem nenhum plugin.',
            forDevelopers: 'Para desenvolvedores',
            readFailedTitle: 'Não foi possível ler os plugins desta máquina',
            readFailedBody: 'Nada foi alterado. Tente de novo para consultar a máquina outra vez.',
            lastKnown: ({ status }: { status: string }) => `Último estado conhecido · ${status}`,
            machinesTitle: 'Máquinas',
            machinesDescription: 'Onde este plugin está instalado.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Atualizado em ${current} de ${total} máquinas`,
            onMachines: ({ count }: { count: number }) => `Em ${count} máquinas`,
            onMachine: ({ machine }: { machine: string }) => `Em ${machine}`,
            addedGroup: 'Adicionados',
            machinesRetained: 'Uma máquina que não está mais nesta conta',
            open: 'Abrir',
            review: 'Revisar',
            seeAll: 'Ver tudo',
            allResults: 'Todos os resultados',
            categoriesLabel: 'Categorias',
            runOnNoneChosen: 'Nenhuma máquina escolhida',
            runOnNoneAvailable: 'Nenhuma máquina pode executá-lo ainda',
            runsEverywhere: 'Em cada máquina que executa o Happier',
            kinds: {
                agent: 'Agente',
                providers: 'Fornecedor de modelos',
                scmHostingProviders: 'Alojamento de código',
                scmBackends: 'Controlo de versões',
                voice: 'Voz',
                connectedAccounts: 'Serviço ligado',
                inputTypes: 'Tipos de entrada',
                mcp: 'Ferramentas MCP',
                pluginUi: 'Painéis da app',
                pluginBrowser: 'Vistas do navegador',
                composer: 'Ferramentas do compositor',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const pt = {
    title: 'Revisão de atualizações',
    confirmSubtitle: 'Atualizações que ampliam o acesso que você concedeu perguntam primeiro.',
    autoApplySubtitle: 'Atualizações são aplicadas sem perguntar, mesmo quando ampliam o acesso.',
    confirmOption: 'Perguntar',
    autoApplyOption: 'Automático',
};

const pluginUpdateReviewTranslations = { pt: pt };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { pt: {
    webhookAdministration: {
        title: 'Plug-in webhooks',
        footer: 'Endpoints de conta, destinos exatos de máquina, filas de entrega e recuperação de mensagens mortas. Os corpos de entrega nunca são mostrados aqui.',
        unavailableTitle: 'Os webhooks de plugin estão indisponíveis',
        unavailableSubtitle: 'Este servidor não ativou a receção de webhooks de plugin.',
        endpointsTitle: 'Pontos de extremidade de webhook',
        emptyTitle: 'Nenhum ponto de extremidade de webhook de plug-in',
        emptySubtitle: 'Os endpoints criados por plug-ins instalados permanecerão visíveis aqui, incluindo endpoints cujo destino não está disponível.',
        loadError: 'O status do webhook não pôde ser carregado.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `Na fila ${queued} · tentando novamente ${retrying} · reivindicado ${claimed} · letra morta ${deadLetter}`,
        copyUrl: 'Copiar URL do webhook',
        selectTarget: 'Selecione o destino de entrega',
        retarget: 'Ponto de extremidade de redirecionamento',
        retargetUnavailable: 'Selecione uma materialização de plug-in exata disponível antes de redirecionar este endpoint.',
        originSelected: 'A materialização exata do plugin selecionado será verificada novamente quando você continuar.',
        originUnavailable: 'Nenhuma materialização exata do plugin disponível foi selecionada.',
        movePendingTitle: 'Mover entregas pendentes?',
        movePendingBody: 'Mover entregas em fila e mensagens não entregues para o novo destino exato? As entregas reivindicadas ativamente permanecem em sua meta atual.',
        resumePendingMove: 'Retomar movimentação de entrega pendente',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} entregas em fila ou mensagens não entregues ainda usam o destino exato anterior.`,
        configureCredential: 'Configurar credencial de assinatura',
        rotateCredential: 'Alternar credencial de assinatura',
        finishRotation: 'Concluir a rotação de credenciais',
        finishRotationSubtitle: 'Pare de aceitar a credencial anterior agora.',
        credentialSecretTitle: 'Salve o novo segredo de assinatura',
        credentialSecretBody: ({ secret }: { secret: string }) => `Este segredo é mostrado uma vez. Salve-o antes de fechar esta mensagem.\n\n${secret}`,
        revoke: 'Revogar ponto de extremidade',
        revokeTitle: 'Revogar o ponto de extremidade do webhook?',
        revokeBody: 'Novas entregas para este endpoint serão rejeitadas. Os metadados de entrega existentes permanecem disponíveis de acordo com a política de retenção.',
        operationFailed: 'A operação do webhook não foi concluída. Atualize o status atual antes de tentar novamente.',
        deliveryTitle: ({ digest }: { digest: string }) => `Carta morta ${digest}`,
        deliveryStatus: 'Status de entrega',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} tentativas · ${replays} repetições · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} admissões de automação não resolvidas`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Amostra: ${sample} · ${omittedCount} não mostrado`,
        replay: 'Entrega de repetição',
        discardTitle: 'Descartar entrega?',
        discardBody: 'O corpo de entrega criptografado ou armazenado de forma simples será removido e não poderá ser recuperado.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { pt: translated({
        profilesPage: {
            searchPlaceholder: "Buscar perfis de inicialização",
            emptyTitle: "Ainda não há perfis de inicialização",
            newProfileTitle: "Novo perfil de inicialização",
            notFoundTitle: 'Este perfil já não existe',
            notFoundDescription: 'Pode ter sido eliminado noutro dispositivo.',
            backToProfiles: "Voltar aos perfis de inicialização",
            discardDraft: 'Descartar',
            detailDescription: 'Usado quando uma nova sessão começa com este perfil.',
            builtInDetailDescription: 'Um perfil já preparado. Guardar as alterações cria a sua própria cópia.',
            enabledHint: 'Oferecido quando escolhe um perfil para uma nova sessão.',
            pickerSection: 'Seletor de perfil',
            pickerSectionDescription: 'Onde esta opção aparece quando inicia uma sessão.',
            showFirst: 'Mostrar primeiro',
            showFirstDescription: 'Mostra o ambiente da máquina entre os seus favoritos.',
            environmentDescription: 'Variáveis de ambiente definidas quando uma sessão começa com este perfil. Os valores podem referir variáveis da máquina.',
            descriptionTitle: 'Descrição',
            descriptionHint: 'Opcional. Mostrada quando escolhe este perfil.',
            modelRequiresAgent: 'Escolha primeiro um agente preferido para escolher o seu modelo.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const pt: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: 'Ligue uma fonte de modelos uma vez e use os seus modelos com todos os agentes compatíveis.',
        foundOn: ({ machine }: { machine: string }) => `Encontrado em ${machine}`,
        foundOnThisMachine: 'Encontrado nesta máquina',
        connect: 'Ligar',
        start: 'Iniciar',
        test: 'Testar',
        addProvider: 'Adicionar um fornecedor',
        customEndpoint: 'Endpoint personalizado',
        menuOwnCategory: 'O seu',
        menuCatalogCategory: 'Do catálogo',
        newTitle: 'Novo fornecedor',
        emptyDescription: 'Adicione um fornecedor do catálogo ou o seu próprio endpoint compatível.',
        machineScopeLabel: 'Configurado em',
        invitationTitle: 'Traga os seus modelos',
        invitationDescription: 'Ligue um fornecedor uma vez e os seus modelos aparecem no seletor de modelos de todos os agentes compatíveis. Servidores locais como o Ollama são executados na sua máquina.',
        invitationNeedsMachine: 'Os fornecedores são ligados e verificados numa das suas máquinas. Adicione uma máquina para começar.',
        setUpMachine: 'Configurar uma máquina',
        duplicateAsCustom: 'Copiar como fornecedor personalizado',
        discard: 'Descartar',
        enabled: 'Ativado',
        enabledDescription: 'Oferecer os seus modelos nos seletores de modelos dos agentes',
        saved: 'Guardada',
        replace: 'Substituir',
        addKey: 'Escolher chave',
        apiKeyDefaultDescription: 'Usada em todas as máquinas, exceto nas que tenham a sua própria chave.',
        apiKeyMachineDescription: 'Usada nesta máquina em vez da chave predefinida.',
        availabilityTitle: 'Disponibilidade',
        availabilityDescription: 'Onde os agentes podem usar este fornecedor.',
        modelsDescription: 'Escolha que modelos os agentes oferecem nos seus seletores de modelos.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} de ${total} visíveis nos seletores de modelos`,
        modelsFilter: ({ count }: { count: number }) => `Filtrar ${count} modelos`,
        connectionTitle: 'Conexão',
        nameDescription: 'Aparece na lista de provedores e nos seletores de modelos.',
        nameRequired: 'Adicione um nome.',
        nameTooLong: ({ max }: { max: number }) => `Use no máximo ${max} caracteres.`,
        managedTitle: 'Serviço local gerido',
        endpointsTitle: 'Endpoints',
        endpointsDescription: 'Deixe vazio para usar os endereços fornecidos pelo fornecedor.',
        overridesDescription: 'Para onde vão os pedidos. Altere o endereço para todas as máquinas ou só para esta.',
        afterSavingTitle: 'Depois de guardar',
        destinationDescription: 'Para onde o Happier enviará os pedidos deste fornecedor.',
        destinationPending: 'Aparece quando todos os endpoints estiverem preenchidos.',
    },
};

const providerCollectionTranslations = { pt } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { pt: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Fornecedor: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Fornecedor: ${provider} · ${connection}`,
        changedTitle: 'As definições do fornecedor mudaram', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Esta sessão continua a usar a configuração ${provider} · ${connection} com que foi iniciada.`,
        unavailableTitle: 'O fornecedor já não está disponível', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} já não está disponível para retomar esta sessão.`,
        disabledTitle: 'O fornecedor está desativado', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Ative ${provider} · ${connection} antes de retomar esta sessão.`,
        incompatibleTitle: 'O fornecedor já não é compatível', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} já não é compatível com o agente desta sessão.`,
        restartAction: 'Reiniciar sessão', chooseModelAction: 'Escolher modelo',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const pt: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Ir para o apontamento`,
    tag: { noFile: 'Sem arquivo', outdated: 'Desatualizado', unplaced: 'Não localizável', notInStory: 'Fora das paradas' },
    outdatedSummary: 'O código mudou depois da revisão.',
    askAboutFindingA11y: ({ title }) => `Perguntar sobre o apontamento: ${title}`,
    tailTitle: 'Apontamentos sem parada',
    tailDescription: 'Ficam aqui para que nada desapareça quando suas linhas não podem ser localizadas.',
    inContext: 'em contexto',
    fromReviewAt: ({ time }) => `da revisão das ${time}`,
    reviewLabel: 'Revisão:',
    enginesOf: ({ count, total }) => `${count} de ${total}`,
    enginesFinished: 'motores terminaram',
    enginesRunning: ({ count }) => (count === 1 ? '1 motor ainda revisando' : `${count} motores ainda revisando`),
    fromEngines: ({ engines, inStory }) => `de ${engines} · ${inStory} na apresentação`,
    and: ' e ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} na apresentação, ${elsewhere} em outro lugar`,
    allInStory: 'todos na apresentação',
    seeded: {
        title: 'Escrito depois da revisão, por uma nova execução.',
        body: ({ reviewers, time }) => `O narrador não revisou o código; cada apontamento citado aqui vem de ${reviewers} às ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Desde então, 1 arquivo mudou.' : `Desde então, ${count} arquivos mudaram.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 apontamento de ${engine}` : `${count} apontamentos de ${engine}`),
    publishedBefore: ({ time }) => `publicados às ${time}, antes da apresentação`,
    steps: {
        reviewing: 'Revisando',
        engineProgress: ({ done, running }) => `${done} concluiu · ${running} revisando`,
        reviewed: ({ count }) => (count === 1 ? 'Revisado · 1 apontamento' : `Revisado · ${count} apontamentos`),
        reviewedShort: ({ count }) => `Revisado · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 apontamento` : `${engine} · ${count} apontamentos`),
        reviewedAt: ({ time }) => `Revisado às ${time}`,
        reviewAt: ({ time }) => `Revisão das ${time}`,
        partial: ({ count }) => (count === 1 ? 'Revisão parcial · 1 apontamento' : `Revisão parcial · ${count} apontamentos`),
        ready: 'Apresentação pronta',
        readyShort: 'Apresentação',
        failed: 'A apresentação falhou',
        narrating: 'Narrando',
        narratorWriting: ({ narrator }) => `${narrator} escrevendo`,
        writing: 'Escrevendo a apresentação',
        writingShort: 'Escrevendo',
    },
    writingWithFindings: 'Escrevendo a apresentação com os apontamentos…',
    dialog: {
        engines: 'Motores de revisão',
        selected: ({ count }) => `${count} selecionados`,
        loadingEngines: 'Procurando motores de revisão…',
        noEngines: 'Nenhum motor de revisão pode rodar na máquina desta sessão.',
        findingsOnly: 'só apontamentos',
        changes: 'Alterações',
        instructions: 'Instruções',
        instructionsPlaceholder: 'O que a revisão deve observar?',
        defaultInstructions: 'Revise estas alterações quanto a correção, risco e testes que faltam.',
        alsoWalkthrough: 'Escrever também uma apresentação',
        alsoWalkthroughBody: 'Quando os apontamentos chegam, a mesma execução escreve a apresentação com eles em contexto. Nada lê as alterações duas vezes.',
        narrator: 'Narrador',
        chooseNarrator: 'Escolha um narrador',
        narratorSeveral: ({ count }) => `${count} motores revisam; um modelo escreve a apresentação a partir de todos os apontamentos.`,
        narratorFindingsOnly: ({ engine }) => `${engine} devolve apontamentos, não texto. Um modelo escreve a apresentação a partir deles.`,
        noNarrator: 'Nenhum destes motores pode escrever uma apresentação. Adicione um motor com modelo ou desative a apresentação.',
        footerReviewThenWalkthrough: 'Revisando e depois escrevendo a apresentação',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} revisa · ${narrator} escreve`,
    },
    generated: {
        continues: ({ model }) => `${model} · continua a revisão`,
        seeded: ({ model }) => `${model} · a partir dos apontamentos da revisão`,
        handover: ({ narrator, engine }) => `${narrator}, a partir dos apontamentos de ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `A revisão de ${engines} não terminou.`,
        notClean: 'Esta é uma revisão parcial, não uma revisão limpa.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} terminou com 1 apontamento.` : `${engines} terminou com ${count} apontamentos.`),
        retry: ({ engine }) => `Tentar ${engine} de novo`,
    },
    explain: { action: 'Explicar os apontamentos', running: 'Explicando os apontamentos', a11y: 'Pedir uma explicação dos apontamentos na apresentação', unknownModel: 'Modelo desconhecido', requester: { user: 'um usuário', agent: 'um agente', plugin: 'um plugin', automation: 'uma automação', workflow: 'um fluxo de trabalho', unknown: 'um solicitante desconhecido' }, header: ({ model, time, requester = 'você' }) => `Explicação da revisão · ${model} · pedida por ${requester} às ${time} · não é um veredito` },
    finished: {
        title: 'Revisão concluída',
        openFindings: 'Abrir apontamentos',
        walkMeThrough: 'Me guie por isto',
        andMore: ({ count }) => `e mais ${count}`,
        continues: 'Continua esta execução de revisão: o revisor escreve a partir do que já leu. Nada é analisado de novo.',
        narrates: ({ count }) => (count === 1
            ? 'A execução de revisão terminou. Uma nova execução escreve a apresentação a partir deste apontamento e das alterações; ela não vai revisar de novo.'
            : `A execução de revisão terminou. Uma nova execução escreve a apresentação a partir destes ${count} apontamentos e das alterações; ela não vai revisar de novo.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Revisão iniciada · ${engineCount} ${engineCount === 1 ? 'motor' : 'motores'} · ${fileCount} ${fileCount === 1 ? 'arquivo' : 'arquivos'}`,
        notStarted: ({ engines }) => `${engines} não começou. Os outros estão revisando.`,
        narrationFailed: 'A revisão começou, mas não foi possível pedir a apresentação. Os apontamentos ainda chegam.',
    },
};

const reviewWalkthroughTranslations = { pt: { reviewWalkthrough: pt } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { pt: {
        rail: {
            label: 'Funções',
            title: 'Função',
            searchPlaceholder: 'Pesquisar funções…',
            empty: 'Ainda não há funções.',
            emptyWithManage: 'Ainda não há funções. Adicione uma em Gerir funções.',
            footer: 'Uma função traz as suas próprias instruções, motor e forma de execução, para que os fluxos continuem portáteis.',
            manage: 'Gerir funções',
            engineAppliesOnStart: 'O motor é aplicado ao iniciar este papel',
            defaultEngine: 'Agente predefinido',
            activeAccessibilityLabel: 'Funções, uma função está em uso',
        },
        builtIn: {
            orchestrator: "Lidera um trabalho e entrega partes a outros agentes",
            planner: "Prepara o plano antes de construir",
            builder: "Faz a alteração e verifica que funciona",
            reviewer: "Revê uma alteração e indica o que corrigir",
            judge: "Decide as conclusões em disputa e diz quando um objetivo foi cumprido",
            second_opinion: "Uma verificação independente antes de avançar",
            scout: "Percorre o código e responde onde estão as coisas",
            approval_reviewer: "Responde a pedidos de permissão de baixo risco e pergunta-te o resto",
        },
        settings: {
            description: 'Quem faz cada tipo de trabalho. Fluxos e orquestradores pedem uma função; a função diz como executá-lo.',
            count: ({ count }) => (count === 1 ? '1 função' : `${count} funções`),
            newRole: 'Nova função',
            groupBuiltIn: 'Integradas',
            groupYours: 'Suas',
            groupShared: 'Partilhadas consigo',
            groupPlugins: 'De plugins',
            edited: 'Editada',
            sourceBuiltIn: 'Integrada',
            sourceYours: 'Sua',
            sourceShared: 'Partilhada consigo',
            sourcePlugin: ({ plugin }) => `De ${plugin}`,
            migrated: 'dos subagentes 0.2',
            migratedNote: 'As funções marcadas «dos subagentes 0.2» vêm das suas orientações de subagentes: a descrição é agora a instrução, o agente e o modelo são o motor.',
            nameTitle: 'Nome',
            newRoleName: 'Função sem título',
            instructionsTitle: 'Instruções',
            instructionsDescription: 'O que faz, quando usá-la e como reportar. Os agentes leem isto ao distribuir trabalho.',
            resetToDefault: 'Repor predefinição',
            readOnlyNote: 'O papel original é só de leitura. Personalize aqui as suas instruções; Repor restaura o original.',
            howItRunsTitle: 'Como é executada',
            engineTitle: 'Motor',
            engineDescription: 'Agente, modelo e esforço.',
            engineFollowsDefault: 'Segue o seu agente predefinido.',
            engineUnavailable: 'Indisponível aqui. Escolha um motor.',
            runsAsTitle: 'Executa em',
            runsAsSession: 'Sessão',
            runsAsBackgroundRun: 'Execução em segundo plano',
            runsAsSessionDescription: 'Uma sessão que pode abrir e orientar.',
            runsAsBackgroundDescription: 'Corre em segundo plano e reporta; não há sessão para orientar.',
            handsOffTitle: 'Sem edição',
            handsOffDescription: 'Planeia e delega; não edita ficheiros por si.',
            secondOpinionTitle: 'Segunda opinião',
            secondOpinionDescription: 'Recomendada pede-lhe que considere uma segunda opinião antes de um pull request ou de dar o trabalho por concluído.',
            secondOpinionOff: 'Desligada',
            secondOpinionEncouraged: 'Recomendada',
            enabledTitle: 'Disponível',
            enabledDescription: 'Oferecida no painel de funções e aos orquestradores.',
            advancedTitle: 'Avançado',
            launchProfileTitle: 'Perfil de arranque',
            launchProfileDescription: 'Ambiente, permissões, máquina',
            launchProfileNone: 'Nenhum',
            profileUnavailable: 'Perfil indisponível',
            previewTitle: 'O que os agentes leem',
            previewDescription: 'O bloco enviado em cada turno, tal e qual.',
            deleteRole: 'Eliminar função',
            deleteConfirmTitle: 'Eliminar esta função?',
            deleteConfirmBody: ({ name }) => `${name} é removida para si e para todos com quem é partilhada. As sessões que a usam mantêm a sua cópia.`,
            share: 'Partilhar…',
            sendCopyFailed: 'Não foi possível enviar uma cópia.',
            saveFailed: 'Não foi possível guardar a função.',
            loadFailed: 'Não foi possível carregar as suas funções.',
            emptyDetailTitle: 'Escolha uma função',
            emptyDetailBody: 'Escolha uma função para ver as instruções e a execução.',
        },
        delegation: {
            title: 'Delegação',
            description: 'Como os agentes passam trabalho a outros agentes.',
            depthTitle: 'Profundidade de trabalho',
            approvalReviewer: 'Revisor de permissões',
            approvalReviewerDescription: 'Revise automaticamente pedidos de baixo risco, uma só vez. Ações sensíveis ainda precisam de você. Apenas nos modos Padrão e Aceitar edições.',
            approvedByReviewer: 'Permitido uma vez pelo revisor',
            depthDescription: 'Sessões, execuções em segundo plano e fluxos iniciados por agentes podem iniciar outros. Este limite trava cadeias descontroladas. O que inicia sozinho nunca é limitado.',
            depthSetting: 'Até onde os agentes podem delegar',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Um nível. Depois disso, o agente deve fazer o trabalho sozinho.'
                : `${count} níveis. Depois disso, o agente deve fazer o trabalho sozinho.`),
            ladderRoot: 'Trabalho que inicia',
            ladderRootDetail: 'Iniciado por si · nunca limitado',
            ladderLevel: ({ level }) => `Nível ${level}`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "Iniciado por um agente do trabalho que começas" : `Iniciado por um agente do nível ${level - 1}`),
            ladderRefused: 'Mais uma delegação',
            ladderRefusedDetail: ({ level }) => `Nível ${level} · recusado; o agente faz sozinho`,
        },
        session: {
            useDefaults: 'Usar predefinições',
            crossOwnerNote: 'As funções foram copiadas no arranque.',
            addRole: 'Adicionar uma função a esta sessão',
            addRoleConfirm: 'Adicionar função',
            namePlaceholder: 'Nome da função',
            instructionsPlaceholder: 'O que esta função faz e quando usá-la',
            notesTitle: 'Notas',
            notesPlaceholder: 'O que cada sessão abaixo deve saber',
            applyToReports: 'Aplicar às sessões abaixo',
            handsOffTitle: 'Sem edição',
            handsOffDescription: 'Planeia e delega; não edita ficheiros.',
            saveFailed: 'Não foi possível guardar esta alteração.',
            sectionTitle: 'Funções',
            allRoles: 'Todas as funções',
            inUse: ({ count }) => `${count} em uso`,
            changed: 'alterada',
            thisSession: 'esta sessão',
            reset: 'Repor',
            newRoleForSession: 'Nova função para esta sessão',
            changeForSession: 'Alterar para esta sessão',
            editNotes: 'Editar notas',
            more: 'Mais',
            info: 'Os papéis valem para esta sessão e para as sessões abaixo dela.',
            countChanged: ({ count }) => `${count} alterados`,
            countAdded: ({ count }) => `${count} adicionados`,
            addNotes: 'Adicione notas sobre como esta sessão deve orquestrar',
        },
        profiles: {
            sharedWithYouTitle: 'Partilhados consigo',
            sharedWithYouDescription: 'Perfis que pessoas e equipas partilham consigo. Os valores secretos ficam com os donos.',
            share: 'Partilhar…',
            shareFailedTitle: 'Não foi possível partilhar este perfil',
            shareNeedsSavedSecrets: 'Valores secretos nunca viajam. Mova cada valor deste perfil para um Segredo salvo, vincule-o e partilhe novamente.',
            shareAwaitingApproval: 'A publicação deste perfil aguarda aprovação. Depois de aprovada, escolha «Partilhar…» novamente.',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "pt">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { pt: {
        untitledRun: 'Execução de agente',
        intentTitles: { review: 'Revisão', plan: 'Plano', delegate: 'Tarefa delegada' },
        thisMachine: 'esta máquina',
        menu: {
            cancelResponse: 'Cancelar esta resposta',
            copyResult: 'Copiar resultado',
            showInTranscript: 'Mostrar na transcrição',
            runDetails: 'Detalhes da execução',
            agent: 'Agente',
            permissions: 'Permissões',
            kind: 'Tipo',
            finishesOnItsOwn: 'Termina sozinha',
            staysOpen: 'Fica aberta',
            started: 'Início',
            run: 'Execução',
            process: 'Processo',
        },
        opening: { reading: ({ machine }) => `Lendo de ${machine}.` },
        gone: {
            title: ({ machine }) => `Esta execução não está mais em ${machine}`,
            reason: 'Ela não é mais mantida lá, e a parte carregada da transcrição não a inclui.',
            closeTab: 'Fechar aba',
        },
        stopFailed: {
            title: {
                review: 'Não foi possível parar esta revisão',
                plan: 'Não foi possível parar este plano',
                delegate: 'Não foi possível parar esta tarefa',
                run: 'Não foi possível parar esta execução',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} não confirmou a parada. Você pode parar a sessão inteira — isso também para ${count === 1 ? 'o outro agente' : `os outros ${count} agentes`} em execução nela.`,
            reasonAlone: ({ machine }) => `${machine} não confirmou a parada. Você pode parar a sessão inteira.`,
            stopSession: 'Parar sessão…',
        },
        steps: {
            title: 'Como chegou lá',
            count: ({ count }) => (count === 1 ? '1 etapa' : `${count} etapas`),
        },
        review: {
            findings: 'Achados',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} altos`,
            severity: { blocker: 'Bloqueante', high: 'Alta', medium: 'Média', low: 'Baixa', nit: 'Detalhe' },
            triageLabel: 'O que fazer com este achado',
            reviewerAsks: 'O revisor pergunta',
            answer: 'Responder',
            askAboutThis: 'Perguntar sobre isto',
            fixesSelected: ({ count }) => (count === 1 ? '1 correção selecionada' : `${count} correções selecionadas`),
            noFixesSelected: 'Escolha as correções a aplicar',
            implementFixes: ({ count }) => (count === 1 ? 'Aplicar 1 correção' : count > 1 ? `Aplicar ${count} correções` : 'Aplicar correções'),
            couldNotSaveChoice: 'Não foi possível salvar sua escolha.',
            reviewers: 'Revisores',
            findingTotal: ({ count }) => (count === 1 ? '1 apontamento' : `${count} apontamentos`),
            moreFindings: ({ count }) => (count === 1 ? 'mais 1 apontamento' : `${count} apontamentos a mais`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 correção a implementar' : `${count} correções a implementar`),
            verifiedFirst: 'Cada uma é verificada primeiro e depois corrigida',
            replies: ({ count }) => (count === 1 ? '1 resposta' : `${count} respostas`),
            updatedAfterQuestion: 'Atualizado após sua pergunta',
            reviewerUpdated: ({ reviewer }) => `${reviewer} atualizou o apontamento`,
            askPlaceholder: 'Pergunte algo sobre este apontamento…',
            askReviewerPlaceholder: 'Pergunte algo ao revisor…',
            toReviewer: ({ reviewer }) => `Para ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `As perguntas vão para ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Aguardando ${reviewer}…`,
            waitingForAnswers: 'Aguardando os revisores…',
            both: 'Ambos',
            reviewerCount: ({ count }) => `${count} revisores`,
            askReviewersPlaceholder: 'Faça uma pergunta aos revisores…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'As perguntas vão para os dois revisores' : `As perguntas vão para os ${count} revisores`),
            stillReviewing: 'Ainda revisando',
            reviewerDidNotFinish: 'Não terminou',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Um revisor não começou' : `${count} revisores não começaram`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} não conseguiu começar.`,
            notSaved: 'Este apontamento não foi salvo, então ainda não aceita uma decisão.',
            decisionsUnavailable: 'Não foi possível carregar suas decisões.',
            followUpUnavailable: {
                notResumable: 'Esta revisão terminou; perguntas precisam de uma revisão que continue aberta.',
                ended: 'Esta revisão não terminou, então não aceita perguntas.',
                resumeUnavailable: 'O revisor não está mais acessível nesta máquina.',
                busy: 'O revisor ainda está ocupado. Tente novamente em instantes.',
                failed: 'Não foi possível enviar sua pergunta.',
            },
        },
        launcher: {
            titles: { review: 'Pedir uma revisão', plan: 'Pedir um plano', delegate: 'Delegar uma tarefa' },
            descriptions: {
                review: ({ machine }) => `Cada agente revisa as mudanças em ${machine} por conta própria; aqui você recebe um resultado de cada um.`,
                plan: ({ machine }) => `O agente lê o código em ${machine} e propõe um plano aqui. Ele não muda nada.`,
                delegate: ({ machine }) => `O agente trabalha em ${machine} com as permissões abaixo e relata aqui.`,
            },
            whatFor: 'Para quê',
            who: { review: 'Quem revisa', plan: 'Quem planeja', delegate: 'Quem faz' },
            selectedCount: ({ count }) => `${count} selecionados`,
            focus: {
                review: 'No que devem se concentrar?',
                plan: 'O que o plano deve cobrir?',
                delegate: 'O que ele deve fazer?',
            },
            optional: 'opcional',
            start: {
                review: ({ count }) => (count > 1 ? `Iniciar ${count} revisões` : 'Iniciar revisão'),
                plan: 'Iniciar plano',
                delegate: 'Iniciar tarefa',
            },
            runsOn: ({ machine }) => `Executa em ${machine}`,
            checking: 'Verificando quais agentes podem rodar aqui',
            unavailableTitle: 'Agentes não podem começar nesta sessão',
            unavailableReason: 'A máquina dela não oferece revisões, planos ou tarefas delegadas agora.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "pt">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { pt: {
        scmComparison: translated({
            view: { files: 'Arquivos', walkthrough: 'Roteiro', commits: 'Commits' },
            scope: {
                workingTree: 'Alterações pendentes',
                session: 'Esta sessão',
                turn: 'Turno',
                latestTurn: 'Último turno',
                branch: ({ head, base }) => `${head} em relação a ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `desde ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'turno' : 'turnos'} com alterações`,
            scopePicker: {
                a11y: 'Alterações a mostrar',
                branchChoice: 'Branch contra base',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Branch ou referência de destino',
                baseRef: 'Branch ou referência base',
                parentRef: 'Referência pai (opcional)',
                explainAndCommit: 'Explicar e fazer commit',
                explainOnly: 'Só explicar',
                unavailable: 'Indisponível nesta sessão',
                pendingDescription: 'Sem commit · pode propor commits',
                sessionDescription: 'Tudo o que mudou, início → agora',
                turnDescription: 'Na ordem em que o agente alterou',
                branchDescription: 'Alterações desde a base comum',
                commitDescription: 'Alterações introduzidas por este commit',
                pullRequestDescription: 'Alterações propostas por este pull request',
            },
            fileCount: ({ count }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'alteração' : 'alterações'}`,
            changedFiles: 'Arquivos alterados',
            startReview: 'Iniciar revisão',
            proposeCommits: 'Propor commits',
            explain: 'Explicar',
            explainA11y: 'Explicar: mostrar as notas do roteiro ao lado das alterações',
            viewA11y: 'Visualização',
            lockfileTag: 'Lockfile',
            generatedTag: 'Gerado',
            lockfileCollapsed: 'Lockfile, recolhido.',
            generatedCollapsed: 'Arquivo gerado, recolhido.',
            showDiff: 'Mostrar diff',
            unsupportedReason: 'Arquivos ainda não consegue mostrar esta comparação. As alterações continuam no Git.',
            showPendingChanges: 'Mostrar alterações pendentes',
            capturedStale: 'A origem mudou. Estes arquivos mantêm a comparação capturada.',
            capturedFreshnessUnknown: 'Exibindo arquivos capturados. Não foi possível verificar o estado atual da origem.',
            keys: { nextFile: 'próximo arquivo', nextChange: 'próxima alteração' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const pt: SecretsSettingsCopy = {
    purpose: "Chaves API e tokens para agentes e servidores MCP. Os valores salvos não são exibidos novamente.",
    yoursTitle: 'Seus segredos',
    yoursDescription: 'Segredos que você salvou ou possui. Escolha-os onde o Happier pedir uma chave.',
    sharedWithYouTitle: 'Compartilhados com você',
    sharedWithYouDescription: 'Outras pessoas permitem que você os use. Você pode escolhê-los, mas não vê-los nem alterá-los.',
    add: 'Adicionar segredo',
    newSecret: 'Novo segredo',
    emptyTitle: 'Nenhum segredo ainda',
    emptyDescription: 'Adicione uma chave de API ou um token uma vez e escolha-o onde o Happier pedir.',
    staleTitle: 'Não foi possível atualizar os segredos compartilhados',
    staleDescription: 'Mostrando a última lista conhecida.',
    valueTitle: 'Valor',
    valueSaved: 'Salvo. Nunca é mostrado de novo.',
    keepTitle: 'Guardar como',
    keepPersonal: 'Pessoal',
    keepShared: 'Compartilhado',
    keepPersonalDescription: 'Guardado na sua conta. Só você pode usá-lo.',
    keepSharedDescription: 'Guardado neste Home para você compartilhá-lo com pessoas, Teams ou Grupos.',
    accessTitle: 'Quem pode usá-lo',
    accessOnlyYou: 'Só você',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Você e 1 destinatário' : `Você e ${count} destinatários`),
    sharePersonalDescription: 'Compartilhar o move para este Home. Ele não pode voltar a ser pessoal.',
    share: 'Compartilhar',
    manage: 'Gerenciar',
    storageTitle: 'Armazenamento',
    storageE2ee: 'Criptografado de ponta a ponta',
    storageE2eeDescription: 'Só as pessoas com quem você compartilha podem lê-lo.',
    storagePlain: 'Gerenciado pelo Home',
    storagePlainDescription: 'Este Home o guarda e pode lê-lo para entregá-lo.',
    save: 'Salvar segredo',
};

const secretsSettingsTranslations = { pt } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "pt": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Acesso à sessão",
        context: "Contexto da sessão",
        search: "Pesquisar pessoas, grupos ou equipes",
        hasAccess: "Tem acesso",
        yourAccess: "Seu acesso",
        readOnly: "Você pode consultar como tem acesso. Somente administradores da sessão podem fazer alterações.",
        sourceDirect: "Acesso direto",
        sourceTeam: "Acesso por uma equipe",
        sourceGroup: "Acesso por um grupo",
        people: "Pessoas",
        groups: "Grupos",
        teams: "Equipes",
        account: "Pessoa",
        group: "Grupo",
        team: "Equipe",
        view: "Pode ver",
        edit: "Pode orientar",
        admin: "Administrar",
        owner: "Proprietário",
        private: "Privada",
        custom: "Acesso personalizado",
        required: "Exigido pela política da equipe",
        subjectNotFound: "Esta pessoa, grupo ou equipe não está mais disponível.",
        subjectIneligible: "Esta pessoa, grupo ou equipe não pode mais receber acesso.",
        teamPolicyRequired: "A política da equipe exige este acesso.",
        selfGrantManaged: "Outro administrador de acesso precisa alterar o seu acesso.",
        homeUnsupported: "Este Home ainda não oferece suporte ao acesso a sessões. Atualize-o para gerenciar quem pode abrir esta sessão.",
        openCollaboration: "Abrir Colaboração",
        authenticationRequired: "Entre com um método aceito por esta equipe e tente novamente.",
        authenticationUnavailable: "O método de entrada exigido por esta equipe não está disponível neste Home.",
        delegation: "Pode aprovar solicitações de permissão de execução",
        remove: "Remover acesso",
        confirmRemove: "Confirmar remoção",
        credentialsLost: ({ names }: { names: string }) => `Estas credenciais da equipe deixarão de funcionar aqui: ${names}`,
        ready: "Acesso criptografado pronto",
        prepared: "Acesso criptografado preparado",
        recipientRepairRequired: "Esta pessoa precisa de reparar a configuração de criptografia da sua conta.",
        pending: "Acesso criptografado pendente",
        setup: "Configuração de criptografia necessária",
        repair: "O acesso criptografado precisa de reparo",
        unavailable: "Conteúdo criptografado indisponível",
        notRequired: "Esta sessão não está encriptada, portanto não há nada a preparar.",
        preparing: "Preparando o acesso criptografado…",
        preparingProgress: ({ count }: { count: number }) => `Preparando o acesso criptografado… ${count} preparados`,
        preparationPending: ({ count }: { count: number }) => `Acesso criptografado pendente para ${count} pessoas`,
        preparationSetup: ({ count }: { count: number }) => `${count} pessoas precisam configurar a criptografia`,
        preparationRepair: ({ count }: { count: number }) => `O acesso criptografado precisa de reparo para ${count} pessoas`,
        preparationKeyUnavailable: "Este dispositivo não pode preparar o acesso criptografado para esta sessão.",
        preparationFailed: "O acesso foi salvo, mas a preparação do acesso criptografado falhou.",
        preparationPassFailed: "A preparação do acesso criptografado falhou.",
        preparationAnnouncedComplete: "Preparação do acesso criptografado concluída.",
        preparationAnnouncedNeedsAttention: "O acesso criptografado ainda precisa de configuração ou reparo.",
        preparationCheckFailed: "Não foi possível verificar o acesso criptografado.",
        outcomeUnknown: "O resultado é incerto. O Happier está verificando o acesso atual antes de você tentar novamente.",
        historicalLayoutNotice: "As pessoas com quem você compartilha esta sessão não podem abri-la até que ela seja atualizada para esta versão do Happier.",
        historicalLayoutUpdate: "Atualizar para compartilhar",
        homeReconciled: "O acesso à sessão foi reposto para o novo Home.",
        lockedTitleFallback: "Sessão criptografada",
        encryptedAccess: "Acesso criptografado",
        aggregatePrepared: ({ count }: { count: number }) => `${count} preparados`,
        aggregatePending: ({ count }: { count: number }) => `${count} pendentes`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} precisam de configuração ou reparo`,
        prepareNow: "Preparar agora",
        prepareAgain: "Preparar outra vez",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Preparando o acesso criptografado… ${count} de ${total}`,
        showAllRecipients: "Mostrar todas as pessoas",
        hideAllRecipients: "Ocultar pessoas",
        moreRecipients: "Mostrar mais pessoas",
        recipientPlainAccount: "Conta sem criptografia",
        pendingBody: "Esta sessão é criptografada. Quem administra ainda precisa preparar seu acesso criptografado antes que ela abra aqui.",
        setupBody: "Conclua a configuração de criptografia nesta conta e depois quem administra poderá preparar seu acesso a esta sessão.",
        setupAction: "Configurar criptografia",
        repairBody: "A chave entregue para esta sessão não pôde ser aberta neste dispositivo. Tente novamente ou peça a quem administra a sessão para preparar o acesso outra vez.",
        retryAction: "Tentar novamente",
        unavailableBody: "A chave abriu, mas o conteúdo desta sessão não pôde ser descriptografado. Quem administra a sessão pode preparar o acesso outra vez.",
        openAccessAction: "Abrir acesso à sessão",
        removedTitle: "Acesso removido",
        removedBody: "Você não pode abrir esta sessão com seu acesso atual. Quem administra a sessão pode compartilhá-la outra vez.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} removido do acesso à sessão`,
        browseMore: "Explorar tudo",
        allLoaded: "Todos os resultados carregados",
        help: "Pode ver permite ler. Pode orientar permite orientar o Agente dentro das permissões das ferramentas. Administrar também gerencia o acesso. Não é uma conversa isolada: a pasta de trabalho e o nome do autor não restringem o acesso ao shell, arquivos ou rede."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const pt: typeof en = {
    status: {
        queued: 'Na fila',
        starting: 'A iniciar',
        running: 'Em execução',
        waiting: 'À espera',
        blocked: 'Bloqueado',
        succeeded: 'Concluído',
        failed: 'Falhou',
        timedOut: 'Tempo esgotado',
        cancelled: 'Parado',
        unknown: 'Desconhecido',
    },
    attention: {
        permission: 'Precisa de aprovação',
        userAction: 'Precisa da sua resposta',
        both: 'Precisa de atenção',
        bothDescription: 'Precisa de aprovação e da sua resposta',
    },
    runKind: {
        conversation: 'Conversa',
        review: 'Revisão',
        plan: 'Plano',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Equipe ${team} · ${count} ${count === 1 ? 'agente' : 'agentes'}`,
        teamActionsA11y: 'Ações da equipe',
        openWork: 'Abrir',
        needsYouCount: ({ count }) => `${count} precisam de você`,
        runningCount: ({ count }) => `${count} em execução`,
        nothingRunning: 'Nada em execução.',
        startAgent: 'Iniciar um agente',
        machineOffline: ({ machine }) => `${machine} não está respondendo`,
        machineOfflineUnnamed: 'A máquina não está respondendo',
        launch: {
            menuA11y: 'Iniciar um agente',
            conversationDescription: 'Converse com um agente ao lado desta sessão',
            reviewDescription: 'Revise as mudanças até agora',
            planDescription: 'Planeje os próximos passos',
            delegateDescription: 'Delegue uma tarefa e receba-a pronta',
            advancedDescription: 'Escolha agentes, permissões e perfil',
        },
        empty: {
            title: 'Coloque mais agentes nesta sessão',
            reason: ({ machine }) => `Comece uma conversa paralela, ou peça uma revisão ou um plano enquanto continua trabalhando. Eles rodam em ${machine} e reportam aqui.`,
            reasonUnnamed: 'Comece uma conversa paralela, ou peça uma revisão ou um plano enquanto continua trabalhando. Eles reportam aqui.',
            moreWays: 'Peça uma revisão, um plano ou uma delegação',
        },
        unavailable: {
            notEnabled: 'Agentes não podem iniciar neste Home.',
            machineOffline: ({ machine }) => `Iniciar agentes exige que ${machine} esteja online.`,
            machineOfflineUnnamed: 'Iniciar agentes exige que esta máquina esteja online.',
            sessionInactive: 'Esta sessão parou. Retome-a para iniciar agentes aqui.',
            externalRunnerInactive: 'Esta sessão foi iniciada fora do Happier. Agentes podem iniciar daqui enquanto o Happier estiver conectado.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { pt };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { pt: {
        title: 'Quadro',
        views: {
            label: 'Vistas do quadro',
            overview: 'Visão geral',
            createTitle: 'Nova vista do quadro',
            renameTitle: 'Mudar o nome da vista do quadro',
            reconciled: ({ title }) => `Essa vista do quadro foi removida. A mostrar ${title}.`,
            empty: {
                title: 'Nada nesta vista',
                reason: 'Adicione aqui um widget ou mude para outra vista do quadro.',
            },
            actions: {
                create: 'Nova vista',
                rename: 'Mudar o nome da vista',
                moveBefore: 'Mover a vista para antes',
                moveAfter: 'Mover a vista para depois',
                remove: 'Eliminar a vista',
            },
            remove: {
                title: ({ title }) => `Eliminar «${title}»?`,
                moveMessage: ({ title }) => `Os widgets passam para ${title}. Nada é eliminado da sessão.`,
                unpinMessage: 'Os widgets continuam na sessão, mas deixam de estar fixados a uma vista.',
            },
        },
        add: { note: 'Nota', interactiveView: 'Vista interativa' },
        width: { compact: 'Estreito', medium: 'Médio', wide: 'Largo', full: 'Largura total' },
        height: { auto: 'Ajustar ao conteúdo', compact: 'Baixa', regular: 'Média', tall: 'Alta' },
        board: {
            loading: { title: 'A abrir o quadro', reason: 'A carregar o que está fixado nesta sessão.' },
            locked: {
                title: 'O quadro ainda está cifrado',
                reason: 'Este dispositivo ainda não consegue abrir a sessão. Nada se perdeu.',
            },
            unopenable: {
                title: 'Não é possível ler a organização do quadro',
                reason: 'A organização guardada não abriu. Os widgets em si não foram afetados.',
            },
            unsupported: {
                title: 'Este quadro precisa de um Happier mais recente',
                reason: 'Tudo fica preservado. Abre-o num dispositivo compatível ou atualiza o Happier.',
            },
            unavailable: {
                title: 'O quadro ainda não está disponível aqui',
                reason: 'Nada se perdeu. Aparece assim que este Home ativar os quadros.',
            },
            offline: 'Sem ligação — estás a ver a última versão carregada.',
            offlineEmpty: 'Sem ligação — volta a ligar-te para carregar este quadro.',
            stale: 'Estás a ver a última versão carregada.',
        },
        empty: {
            editor: {
                title: 'Mantém o plano ao lado do chat',
                description: 'As notas e vistas em direto fixadas aqui ficam com esta sessão, para quem a puder ler.',
                askAgent: 'Pedir ao agente',
                askAgentPrompt: 'Coloca neste quadro algo que mostre ',
                addNote: 'Adicionar uma nota',
            },
            viewer: {
                title: 'Ainda não há nada no quadro',
                description: 'Aqui aparece tudo o que pessoas ou agentes fixarem nesta sessão.',
            },
        },
        item: {
            untitled: 'Widget sem título',
            renameA11y: 'Título do widget',
            reorderA11y: ({ title }) => `Reordenar ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Ler e editar', movement: 'Mover', geometry: 'Tamanho', destructive: 'Remover' },
            loading: { title: 'A carregar este widget', reason: 'A obter o conteúdo deste Home.' },
            locked: {
                title: 'Conteúdo cifrado indisponível',
                reason: 'Este widget continua cifrado até este dispositivo conseguir abrir a sessão.',
            },
            unopenable: {
                title: 'Não é possível mostrar este widget',
                reason: 'O conteúdo guardado não pôde ser lido. O resto do quadro continua utilizável.',
            },
            unsupported: {
                title: 'Este widget precisa de um Happier mais recente',
                reason: 'O conteúdo fica preservado. Abre-o num dispositivo compatível ou atualiza o Happier.',
            },
            missing: {
                title: 'Este widget não foi encontrado',
                reason: 'O quadro ainda aponta para ele, mas o conteúdo não está neste Home.',
            },
            removed: {
                title: 'Este widget foi retirado do quadro',
                reason: 'Alguém com permissão de edição apagou-o para toda a gente.',
            },
            pluginUnavailable: {
                title: 'Plugin indisponível neste dispositivo',
                reason: 'O widget fica preservado. Volta a aparecer assim que o plugin estiver disponível aqui.',
            },
            rendererUnavailable: {
                title: 'Não é possível mostrar este widget neste dispositivo',
                reason: 'O conteúdo fica preservado. Abre-o onde as vistas interativas forem suportadas.',
            },
            provenance: {
                note: 'Nota',
                interactiveView: 'Vista interativa',
                pluginMissing: ({ pluginId }) => `De ${pluginId} · não instalado`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Remover do quadro',
                openHere: 'Abrir aqui',
                managePlugin: 'Gerir o plugin',
                prepareEncryption: 'Configurar a cifra',
                readFull: 'Ler a nota completa',
                rename: 'Mudar o nome do widget',
                unpin: 'Desafixar desta vista',
                moveToView: ({ title }) => `Mover para ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} movido para antes.`,
                after: ({ title }) => `${title} movido para depois.`,
                reordered: ({ title }) => `${title} movido.`,
                toView: ({ title, view }) => `${title} movido para ${view}.`,
            },
            movePosition: ({ position, total }) => `Posição ${position} de ${total}`,
            moveTargetView: ({ title }) => `Vista do quadro ${title}`,
            remove: {
                title: 'Remover este widget?',
                message: 'Perde-o toda a gente que possa ler esta sessão. Os plugins instalados continuam instalados.',
            },
        },
        note: {
            titlePlaceholder: 'Título',
            titleA11y: 'Título da nota',
            untitled: 'Nota sem título',
            offline: 'Para guardar é preciso ligação a este Home.',
            unavailable: 'As alterações ao quadro ainda não estão disponíveis neste Home.',
            failed: 'O Happier não conseguiu guardar esta nota. O teu texto continua aqui.',
            outcomeUnknown: 'O Happier não conseguiu confirmar se a nota foi guardada. Atualiza antes de guardar de novo.',
            saved: 'Nota guardada',
            conflict: {
                message: 'Esta nota mudou noutro dispositivo.',
                reviewLatest: 'Ver a versão mais recente',
                applyMine: 'Aplicar as minhas alterações',
                latestHeading: 'Versão mais recente',
            },
        },
        recovered: {
            title: 'Itens recuperados',
            description: 'Estes widgets estão na sessão mas não aparecem em nenhuma vista do quadro.',
            pin: 'Adicionar a esta vista',
        },
        mutation: {
            conflict: 'Este quadro mudou noutro dispositivo. Atualize para ver a versão mais recente.',
            outcomeUnknown: 'O Happier não conseguiu confirmar se a alteração foi guardada.',
            denied: 'Já não tem permissão para alterar este quadro.',
            offline: 'Alterar o quadro precisa de ligação a este Home.',
            unavailable: 'Este Home ainda não consegue alterar o quadro.',
            updateRequired: 'Atualize o Happier para fazer esta alteração ao quadro.',
            hostedHtmlSourceTooLarge: 'Esta vista interativa é demasiado grande para guardar. O seu rascunho continua aqui.',
            noteTooLarge: 'Esta nota é demasiado grande para guardar. O seu texto continua aqui.',
            invalid: 'Esta alteração ao quadro não é válida. Reveja-a e tente novamente.',
            notFound: 'Este item já não está disponível. Atualize o quadro.',
            storageFailed: 'O Happier não conseguiu proteger esta alteração. O seu trabalho continua aqui.',
            serverFailed: 'Este Home não conseguiu concluir a alteração. Tente novamente.',
            failed: 'O Happier não conseguiu aplicar essa alteração ao quadro.',
        },
        hostedHtmlApproval: {
            title: 'Permitir esta vista interativa?',
            body: 'A aprovação aplica-se a esta vista nesta sessão. Para enviar uma mensagem continua a ser preciso clicar dentro da vista.',
            resources: ({ count }) => (count === 1 ? 'Pode ler 1 recurso da sessão' : `Pode ler ${count} recursos da sessão`),
            actions: ({ count }) => (count === 1 ? 'Pode executar 1 ação' : `Pode executar ${count} ações`),
            sendMessages: 'Pode pedir ao Happier para enviar mensagens',
            loadsFrom: ({ origin }) => `Carrega de ${origin}`,
            allow: 'Permitir',
            notNow: 'Agora não',
            declined: {
                title: 'Vista interativa ainda não permitida',
                reason: 'Reveja o que ela pede quando quiser.',
                review: 'Rever',
            },
        },
        sidebar: {
            openInDetails: 'Abrir nos detalhes',
            openBoard: 'Abrir o quadro',
            sharedWithEveryone: 'Partilhado com todos aqui',
            widgetCount: ({ count }) => `${count} widget${count === 1 ? '' : 's'}`,
        },
        mobile: { searchPlaceholder: 'Pesquisar neste quadro' },
        inline: {
            openBoard: 'Abrir o quadro',
            openBoardA11y: ({ title }) => `Abrir “${title}” no quadro`,
        },
        companion: {
            title: 'Companheiro',
            inCompanionA11y: 'No teu companheiro',
            empty: {
                title: 'Mantenha a sessão à vista',
                reason: 'Coloque o resumo da sessão ou um widget do quadro ao lado do chat: o que está rodando, o que espera por você, o que mudou.',
                note: 'Só você vê o seu companheiro.',
            },
            pane: {
                besideChat: 'Ao lado do seu chat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 item' : `${count} itens`,
                justForYou: 'Só para você, ao lado do chat',
            },
            actions: {
                addSummary: 'Adicionar resumo da sessão',
                addItem: ({ title }) => `Adicionar ${title}`,
                moveToLeading: 'Mover para o lado esquerdo',
                moveToTrailing: 'Mover para o lado direito',
                moveToFirst: 'Mover para o topo',
                moveToLast: 'Mover para o fim',
                compact: 'Tamanho compacto',
                comfortable: 'Tamanho confortável',
                openFull: 'Abrir companheiro completo',
                openOnBoard: 'Abrir no quadro',
                collapse: 'Recolher companheiro',
                expand: 'Expandir companheiro',
                hide: 'Ocultar companheiro',
                addToCompanion: 'Adicionar ao companheiro',
                removeFromCompanion: 'Remover do companheiro',
                undo: 'Desfazer',
                menuA11y: 'Opções do companheiro',
                itemMenuA11y: ({ title }) => `Opções de ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Companheiro, ${count} itens`,
                show: ({ count }) => `Mostrar companheiro, ${count} itens`,
                expand: ({ count }) => `Expandir companheiro, ${count} itens`,
            },
            summary: {
                review: 'Revisar',
                title: 'Resumo da sessão',
                untitled: 'Sessão',
                approvals: ({ count }) => `${count} à sua espera`,
                workflows: ({ count }) => `${count} fluxos em execução`,
                changedFiles: ({ count }) => `${count} alterados`,
                tokens: ({ count }) => `${count} tokens`,
                contextPercent: ({ percent }) => `${percent}% de contexto`,
                contextOnly: 'Contexto usado',
                moreDetails: 'Mais detalhes',
                moreDetailsA11y: ({ count }) => `Mais detalhes, mais ${count} linhas`,
                partial: 'Alguns detalhes não estão visíveis daqui.',
            },
            notices: {
                shown: 'Companheiro apresentado',
                hidden: 'Companheiro ocultado',
                added: 'Adicionado ao companheiro',
                removed: 'Removido do companheiro',
                reordered: 'Companheiro reordenado',
                moved: 'Companheiro movido',
                boardOpened: 'Quadro aberto pelo agente',
                returnedToChat: 'O agente voltou ao chat',
                boardViewSelected: 'Vista do quadro selecionada pelo agente',
                boardItemRevealed: 'Item do quadro aberto pelo agente',
                fullOpened: 'Companheiro aberto pelo agente',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "pt">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "pt"> = { pt: {
        hereOne: ({ name }) => `${name} está aqui`,
        hereTwo: ({ first, second }) => `${first} e ${second} estão aqui`,
        hereMany: ({ first, count }) => `${first} e mais ${count.toLocaleString()} pessoas estão aqui`,
        typingOne: ({ name }) => `${name} está escrevendo…`,
        typingMany: ({ count }) => `${count.toLocaleString()} pessoas estão escrevendo…`,
        justYouHere: 'Só você está aqui',
        justYouHint: 'As pessoas com quem você compartilhar aparecem aqui',
        you: 'Você',
        presenceConnecting: 'Verificando quem está aqui…',
        presenceUnavailable: 'A presença em tempo real não está respondendo agora',
        presenceUnsupported: 'A presença em tempo real não está disponível nesta Home',
        responsibleUnsupported: 'Esta Home não registra quem é responsável',
        inviteTitle: 'Conversem ao lado da sessão',
        inviteBody: 'Comece uma conversa, mencione pessoas e passe a resposta ao agente quando estiver pronto.',
        readOnly: 'Você pode lê-las. Quem pode editar esta sessão pode escrever.',
        offline: 'Você está offline · mostrando as últimas conversas',
        lockedTitle: 'Ainda não é possível abrir estas conversas neste dispositivo',
        lockedBody: 'Elas são criptografadas de ponta a ponta, e a configuração de criptografia deste dispositivo não corresponde à da sessão.',
        revokedTitle: 'Você não tem mais acesso a estas conversas',
        revokedBody: 'Alguém que gerencia esta sessão mudou quem pode vê-la. As mensagens que você escreveu ficam com a sessão.',
        namesTwo: ({ first, second }) => `${first} e ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} e ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} e mais ${count.toLocaleString()}`,
        haveAccess: 'Têm acesso',
        hasAccess: 'Tem acesso',
        onlyYou: 'Só você',
        notShared: 'Ainda não compartilhada',
        publicLinkOn: 'Link público ativado',
        accessLoading: 'Verificando quem tem acesso…',
        accessError: 'Não foi possível carregar quem tem acesso',
        shareTitle: 'Compartilhar esta sessão',
        shareBody: ({ home }) => `As pessoas que você adicionar em ${home} podem acompanhar e participar das conversas.`,
        collapse: 'Recolher',
        linkOn: 'Ativado',
        linkOff: 'Desativado',
        linkGrants: 'Qualquer pessoa com o link pode ver a transcrição, sem conta.',
        linkExpires: ({ date }) => `Expira em ${date}`,
        linkNeverExpires: 'Nunca expira',
        linkAsksConsent: 'pede consentimento',
        linkNoConsent: 'sem etapa de consentimento',
        linkHidden: 'Este link foi criado antes e não pode ser mostrado de novo. Crie um novo link para copiá-lo.',
        qrCode: 'Código QR',
        hideQrCode: 'Ocultar código QR',
        newLink: 'Novo link…',
        turnOff: 'Desativar',
        turnOffTitle: 'Desativar o link público?',
        turnOffBody: 'Quem tiver o link perde o acesso na hora. Você pode criar um novo link depois.',
        newLinkReplaces: 'O link atual deixa de funcionar quando o novo for criado.',
        linkDenied: 'Só quem gerencia esta sessão pode criar um link público.',
        linkLoadFailed: 'Não foi possível verificar o link público.',
        linkUnavailable: 'Os links públicos não estão disponíveis neste Home. Peça ao administrador para configurar o alojamento de links públicos.',
        justYouTitle: 'Trabalhem juntos nesta sessão',
        justYouBody: ({ home }) => `Compartilhe com pessoas em ${home}. Elas podem acompanhar, conversar aqui e assumir enquanto você está fora.`,
        share: 'Compartilhar',
        justYouNote: 'Ou crie um link público que qualquer pessoa pode ver.',
        sharingOffTitle: ({ home }) => `${home} não compartilha sessões com pessoas`,
        sharingOffBody: 'Você ainda pode criar um link público que qualquer pessoa pode ver.',
        sharingOffPrivateBody: 'As sessões desta Home ficam com você.',
        accessDenied: 'Só quem gerencia esta sessão pode mudar quem tem acesso. Você ainda pode participar das conversas.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "pt"> = { pt: { pane: sessionCollaborationPaneTranslations['pt'], title: 'Colaboração', viewingNow: 'Vendo agora', justYou: 'Só você', typing: 'Digitando…', stale: 'Pode estar desatualizado', unavailable: 'Presença em tempo real indisponível', connecting: 'Conectando…', unnamed: 'Membro do Happier', open: 'Abrir colaboração', conversations: 'Conversas', accessUnavailable: 'Acesso à sessão indisponível', accessUnavailableReason: 'Este Home não suporta partilhar sessões com pessoas.', discussion: { featureUnavailable: "As conversas não estão ativadas neste Home.", bindingUnavailable: "Inicie sessão novamente neste Home para ver as conversas.", scopeMismatch: "Estas conversas pertencem a outra conta neste Home.", modeMismatch: "O conteúdo não corresponde ao modo de encriptação da sessão. Tente novamente ou peça a quem gere a sessão para verificar o acesso.",  title: 'Conversas', newDiscussion: 'Nova conversa', create: 'Criar conversa', titlePlaceholder: 'Título da conversa', messagePlaceholder: 'Escreva uma mensagem…', active: 'Ativas', activeDisclosure: 'Mostrar conversas ativas', archived: 'Arquivadas', archivedDisclosure: 'Mostrar conversas arquivadas', emptyActive: 'Ainda não há conversas ativas.', emptyArchived: 'Não há conversas arquivadas.', loading: 'A carregar conversas…', loadError: 'Não foi possível carregar as conversas.', retry: 'Tentar novamente', checking: 'A procurar atualizações…', deliveryUnknown: 'Entrega incerta — verifique antes de tentar novamente.', locked: 'Pode ler esta conversa, mas não pode publicar.', offline: 'Está offline. Volte a ligar-se para continuar.', unavailable: 'Esta conversa não está disponível.', unreadCount: ({ count }) => count === 1 ? '1 por ler' : `${count.toLocaleString()} por ler`, unreadMentionCount: ({ count }) => count === 1 ? '1 menção por ler' : `${count.toLocaleString()} menções por ler`,
        mentioned: 'Foi mencionado', unreadConversations: 'Conversas por ler', messageCount: ({ count }) => count === 1 ? '1 mensagem' : `${count.toLocaleString()} mensagens`, viaAgent: 'Através do Agent', collaborator: 'Colaborador', contentUnavailable: 'Mensagem indisponível', rename: 'Mudar o nome da conversa', archive: 'Arquivar conversa', restore: 'Restaurar conversa', selection: { copy: 'Copiar', askAgent: 'Perguntar ao Agent', sendToSession: 'Enviar para a sessão', handoffError: 'Não foi possível adicionar as mensagens selecionadas ao editor da sessão.' }, titleRequired: 'Adicione um título para iniciar esta conversa.', encryptedTitle: 'Conversa encriptada', archivedNotice: 'Esta conversa está arquivada.', sessionArchived: 'Esta sessão está arquivada.', postDenied: 'Já não pode publicar nesta sessão.', invalidMention: 'Alguém que mencionou já não consegue ler esta sessão.', invalidContent: 'Esta mensagem não pode ser enviada assim. Pode estar vazia ou ser demasiado longa.', idempotencyConflict: 'Já foi enviada uma mensagem diferente com esta identidade.', sendFailed: 'Não foi possível enviar esta mensagem.', dismiss: 'Dispensar', loadOlder: 'Carregar mensagens anteriores', loadMore: 'Carregar mais conversas' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { pt: {
        status: {
            waitingForYou: 'À sua espera',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} parou antes do passo ${step} de ${total}`,
            stepOfPlan: ({ step, total }) => `Passo ${step} de ${total} do plano`,
            agentFallback: 'O agente',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Permitir',
            deny: 'Negar',
            showInChat: 'Mostrar no chat',
            moreWaiting: ({ count }) => `Mais ${count} à espera`,
            allowed: ({ summary }) => `Permitido: ${summary}`,
            denied: ({ summary }) => `Negado: ${summary}`,
            justNow: 'agora mesmo',
            failed: 'A sua resposta não chegou à sessão. Tente novamente.',
            answerWhenBack: ({ machine }) => `Poderá responder quando ${machine} voltar.`,
            answerWhenSessionBack: 'Poderá responder quando a sessão voltar.',
            notAllowed: 'Só quem pode executar esta sessão pode responder.',
            groupA11y: 'À sua espera',
        },
        facts: {
            subagents: 'subagentes',
            changed: 'alterados',
            context: 'contexto',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} de ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Abre Agentes',
            opensGit: 'Abre Git',
            opensUsage: 'Abre a utilização',
        },
        plan: {
            title: 'Plano',
            description: ({ agent }) => `A lista de tarefas de ${agent} para esta sessão`,
            progress: ({ done, total }) => `${done} de ${total}`,
            progressA11y: ({ done, total }) => `${done} de ${total} concluídas`,
            emptyTitle: 'Ainda sem plano',
            emptyReason: 'Quando o agente escrever uma lista de tarefas, ela aparece aqui, passo a passo.',
            stepDone: 'Concluído',
            stepCurrent: 'Passo atual',
        },
        picker: {
            open: 'Adicionar ao Companheiro',
            chooseWidget: 'Escolher um widget…',
            onTheBoard: ({ source }) => `${source} · no quadro`,
        },
        drop: { keepBesideChat: 'Manter ao lado do chat' },
        freshness: { machineOffline: ({ machine }) => `${machine} está offline` },
        needsYouA11y: ({ count }) => `Companheiro, ${count} à sua espera`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "pt">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const pt: typeof en = {
    discussion: {
        loadingTitle: 'Abrindo esta conversa…',
        offlineTitle: 'Esta conversa não está disponível offline',
        offlineReason: 'Reconecte-se e ela abrirá de onde você parou.',
        errorTitle: 'Não foi possível abrir esta conversa',
        lockedTitle: 'Ainda não é possível abrir esta conversa neste dispositivo',
        lockedReason: 'Ela é criptografada de ponta a ponta, e a configuração de criptografia deste dispositivo não corresponde à da sessão.',
        revokedTitle: 'Você não tem mais acesso a esta conversa',
        revokedReason: 'Esta sessão não é mais compartilhada com você. As mensagens que você escreveu continuam na sessão.',
        unavailableTitle: 'As conversas não estão disponíveis aqui',
        closeTab: 'Fechar aba',
    },
    draft: {
        leadTitle: 'Pergunte a um agente',
        leadBody: 'Ele roda como uma conversa própria ao lado da sessão, com estas mensagens como contexto. Nada começa até você enviar.',
    },
    context: {
        fromConversation: ({ title, count }) => `De ${title} · ${count === 1 ? '1 mensagem' : `${count} mensagens`}`,
        fromUntitled: ({ count }) => `De uma conversa · ${count === 1 ? '1 mensagem' : `${count} mensagens`}`,
    },
    origin: {
        fromConversation: ({ title }) => `de ${title}`,
        fromUntitled: 'de uma conversa',
    },
    run: {
        details: 'Detalhes da execução',
        loadingTitle: 'Abrindo esta conversa com o agente…',
        errorTitle: 'Não foi possível abrir esta conversa com o agente',
    },
};

const sessionConversationSurfaceTranslations = { pt };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { pt: {
        title: ({ machine }) => `A pasta privada desta conversa já não está em ${machine}.`,
        body: 'Podes continuar numa pasta nova e vazia. O histórico da conversa ficará aqui, mas os ficheiros locais da pasta antiga não serão restaurados.',
        continue: 'Continuar numa pasta nova', notNow: 'Agora não',
        offlineDelete: ({ machine }) => `A pasta privada em ${machine} será removida quando esse computador voltar a estar online.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "pt">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const pt: typeof en = {
    sectionTitle: 'Rascunhos',
    sectionTitleForHome: ({ home }) => `Rascunhos em ${home}`,
    waitingSectionTitleForHome: ({ home }) => `À espera de um computador em ${home}`,
    badge: 'Rascunho',
    untitled: 'Rascunho sem título',
    continueEditing: 'Continuar a editar',
    startAnother: 'Começar outro',
    executionRunStart: {
        starting: 'A iniciar a conversa com o agente…',
        reconciling: 'A verificar se esta conversa com o agente foi iniciada…',
        unresolved: 'Não foi possível confirmar se esta conversa com o agente foi iniciada. Iniciar outra pode criar uma segunda conversa.',
        targetChanged: 'O computador desta sessão mudou antes de a conversa poder começar. Nada foi iniciado.',
        secretReferenceOverlayUpdateRequired: 'Usar segredos partilhados numa conversa com o agente exige um computador atualizado. Nada foi iniciado.',
    },
    status: {
        offline: 'Offline — guardado neste dispositivo',
        syncing: 'A sincronizar…',
        conflict: 'Precisa de revisão',
        unsupported: 'Não sincronizado — este Home não consegue sincronizar este rascunho',
        startInterrupted: 'Início interrompido',
    },
    availability: {
        machineUnavailable: 'Máquina indisponível',
        pluginUnavailable: 'Plug-in indisponível',
        attachmentNeedsAttention: 'O anexo precisa de atenção',
    },
    new: { action: 'Nova sessão' },
    delete: {
        action: 'Eliminar rascunho',
        confirmTitle: 'Eliminar este rascunho?',
        confirmDescription: 'Isto remove o rascunho dos seus dispositivos sincronizados.',
    },
    conflict: {
        title: 'Rever alterações em conflito',
        description: 'Escolha que versão manter em cada campo. Pode copiar a versão do seu dispositivo antes de a substituir.',
        mine: 'Este dispositivo',
        synced: 'Versão sincronizada',
        useSynced: 'Usar a sincronizada',
        keepDevice: 'Manter a deste dispositivo',
        copyMine: 'Copiar a minha',
        copied: 'Copiado',
        copyFailed: 'Não foi possível copiar este valor.',
        field: {
            text: 'Mensagem',
            mentions: 'Menções',
            attachments: 'Anexos',
            recipient: 'Destinatário',
            agentContinuation: 'Continuação do agente',
            executionRunRequestedAction: 'Entrega da execução',
        },
    },
};

const sessionDraftTranslations = { pt };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { pt: translated({
        unavailable: 'Esta sessão não está disponível',
        respondInSession: 'Abra a sessão para responder.',
        regionLabel: ({ title }) => `Sessão: ${title}`,
        newChatWelcome: 'Em que vamos trabalhar?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "pt"> = { 'pt': {
        "notificationBody": {"message":"Nova mensagem nesta sessão.","failed":"O turno falhou.","cancelled":"O turno foi cancelado.","sourceUnavailable":"A origem desta sessão não está disponível."},
        "follow": "Seguir",
        "unfollow": "Deixar de seguir",
        "following": "A seguir",
        "notifications": "Notificações",
        "unavailableTitle": "Seguir não está disponível",
        "unavailableDescription": "Esta Home não oferece o seguimento de sessões.",
        "unreachableTitle": "Não foi possível aceder a este Home",
        "unreachableDescription": "O Happier não conseguiu verificar se este Home oferece o seguimento de sessões. Tente novamente quando estiver acessível.",
        "editor": {
            "title": "Seguir esta sessão",
            "subtitle": "Recebe as atualizações que te interessam.",
            "ownerSubtitle": "Esta sessão é tua, por isso as atualizações chegam-te sempre.",
            "externalAttachedOnly": "A sincronização em segundo plano está desativada, por isso as atualizações podem chegar apenas enquanto esta sessão estiver ligada."
        },
        "level": {
            "none": "Sem notificações",
            "important": "Atualizações importantes",
            "all_messages": "Cada nova mensagem"
        },
        "voice": {
            "title": "Incluir no Voice",
            "subtitle": "O Voice pode manter esta sessão em contexto.",
            "waitingRuntime": "À espera da ligação do Voice.",
            "unsupported": "Este ambiente não permite incluir sessões seguidas no Voice.",
            "providerWithheld": "Este modo Voice não pode incluir atualizações de sessões guardadas.",
            "waitingEncrypted": "Desbloqueia esta sessão para a incluir no Voice.",
            "initialSnapshotPending": "No próximo turno do Voice, inclui um breve resumo do estado atual."
        },
        "footer": "Seguir nunca altera quem pode aceder a esta sessão.",
        "settingsLink": "Definições de notificações…",
        "assignedExplanation": "Estás a seguir porque a sessão te foi atribuída",
        "assignedNotice": "Foi-te atribuída uma sessão.",
        "sharedNotice": "Foi partilhada uma sessão contigo.",
        "wakeEventExplanation": "O contexto seguido mudou, por isso o Happier acordou este agente com a atualização.",
        "accessLost": "Já não tens acesso a esta sessão.",
        "offline": "Estás offline. Volta a ligar-te para alterar o seguimento.",
        "archived": "O seguimento está em pausa enquanto esta sessão está arquivada.",
        "sources": {
            "title": "Atualizações de sessões",
            "waitingRuntime": "A aguardar que a sessão de destino volte a ligar-se.",
            "unsupported": "Atualize ou volte a ligar a CLI na máquina de destino para receber atualizações.",
            "pausedArchived": "As atualizações ficam em pausa enquanto a origem ou o destino estiver arquivado.",
            "add": "Seguir noutra sessão…",
            "addSource": "Enviar atualizações de outra sessão…",
            "chooseDestinationTitle": "Seguir noutra sessão",
            "chooseSourceTitle": "Enviar atualizações de outra sessão",
            "row": ({ title }) => `Atualizações de “${title}”`,
            "nextTurn": "Próximo turno",
            "wakeOnHumanChange": "Ativar quando uma pessoa adicionar uma mensagem",
            "stop": "Parar atualizações",
            "stopForSource": ({ title }) => `Parar atualizações de «${title}»`,
            "includeNextTurn": "Inclui as atualizações no próximo turno do destino.",
            "sourceKeyPreparing": "A preparar o acesso encriptado…",
            "sourceKeyWaiting": "A aguardar acesso encriptado.",
            "sourceKeyUnavailable": "Este computador não consegue fornecer acesso encriptado.",
            "sourceSessionKeyUnavailable": "O acesso encriptado desta sessão não está disponível aqui.",
            "catchUpPending": "Atualização pendente"
        },
        "preferences": {
            "title": "Seguir automaticamente",
            "assigned": "Sessões atribuídas a mim",
            "direct": "Sessões partilhadas diretamente",
            "team": "Sessões partilhadas através de equipas",
            "group": "Sessões partilhadas através de grupos",
            "help": "Aplica-se a novas atribuições e sessões recentemente acessíveis. As escolhas existentes não mudam."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const pt: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Branch ${branch}: trocar de branch ou ver o que foi guardado`,
    searchPlaceholder: 'Trocar ou criar um branch',
    category: { current: 'Atual', branches: 'Branches', remote: 'Branches remotos', keptAside: 'Guardado', worktrees: 'Worktrees', start: 'Começar algo novo' },
    tracks: ({ upstream }) => `segue ${upstream}`,
    onlyHere: 'só nesta máquina',
    changed: ({ count }) => `${count} alterados`,
    ahead: ({ count }) => `${count} para enviar`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Novo branch a partir de ${branch}…`,
    newBranchDetached: 'Novo branch…',
    newBranchSubtitle: 'Digite o nome no campo de busca',
    newWorktree: 'Novo worktree…',
    newWorktreeSubtitle: 'Trabalhe em outro branch numa nova sessão',
    keepAside: 'Guardar as alterações',
    keepAsideSubtitle: ({ count }) => `Guarde ${count} alterações e comece do zero`,
    keepAsideNothing: 'Nenhuma alteração para guardar',
    keepAsideFailed: 'Não foi possível guardar as alterações.',
    loadFailed: 'Não foi possível carregar os branches',
    notice: {
        title: ({ branch }) => `Você guardou alterações em ${branch}`,
        reason: ({ when }) => `Guardadas ${when}. Traga-as de volta para continuar.`,
        reasonUndated: 'Traga-as de volta para continuar.',
        restore: 'Restaurar alterações',
        lookFirst: 'Ver antes',
        dismiss: 'Agora não',
        restoreFailed: 'Não foi possível restaurar as alterações.',
    },
};

const sessionGitBranchesTranslations = { pt };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const pt: typeof en = {
    settingsLayout: 'Layout do painel Git',
    settingsShowAs: 'Mostrar arquivos alterados como',
    trigger: 'Opções de exibição',
    paneGroup: 'Painel',
    changesGroup: 'Alterações',
    layout: 'Layout',
    layoutUnified: 'Unificado',
    layoutTabs: 'Abas',
    layoutDescription: 'Uma só rolagem das alterações ao histórico, ou Alterações e Histórico como duas visualizações.',
    showAs: 'Mostrar como',
    showAsList: 'Lista',
    showAsTree: 'Árvore',
    showAsDescription: 'Os arquivos alterados em lista, ou agrupados por pasta para pegar pastas inteiras.',
    density: 'Densidade',
    densityDefault: 'Padrão',
    densityCompact: 'Compacta',
    note: 'As linhas da árvore são sempre compactas. Lembrado na sua conta.',
    selectFolder: ({ folder }) => `Selecionar todas as alterações em ${folder}`,
    selectFile: ({ file }) => `Selecionar ${file} para o próximo commit`,
};

const sessionGitDisplayTranslations = { pt };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const pt: typeof en = {
    scope: { allChanges: 'Todas as alterações' },
    subTabs: { changes: 'Alterações', sync: 'Sincronizar', history: 'Histórico' },
    header: {
        changed: ({ count }) => `${count} alterados`,
        toPush: ({ count }) => `${count} para enviar`,
        toPull: ({ count }) => `${count} para receber`,
        push: ({ count }) => `Enviar ${count}`,
        pull: ({ count }) => `Receber ${count}`,
        publish: 'Publicar',
        folderOnMachine: ({ folder, machine }) => `${folder} em ${machine}`,
    },
    groups: {
        session: 'Alterado nesta sessão',
        elsewhere: ({ repo }) => `Noutras partes de ${repo}`,
        elsewhereUnnamed: 'Noutras partes deste repositório',
        selectGroup: ({ group }) => `Selecionar todos os ficheiros em «${group}»`,
    },
    row: { renamedFrom: ({ path }) => `antes ${path}` },
    commit: {
        toBranch: ({ branch }) => `Fazer commit em ${branch}`,
        selection: ({ count }) => (count === 1 ? '1 ficheiro' : `${count} ficheiros`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Você tem 1 alteração sem commit` : `Você tem ${formatted} alterações sem commit`),
            dirtyBody: 'Puxar pode tocá-las. Guarde-as à parte enquanto puxa (elas voltam logo depois) ou deixe o Git puxar só se nada se sobrepuser.',
            keepAsideAndPull: 'Guardar à parte e puxar',
            pullIfNoOverlap: 'Puxar se nada se sobrepuser',
            divergedPullBody: 'Seu branch e origin avançaram. Coloque seus commits sobre os de origin ou mescle os dois.',
            divergedPushBody: 'Traga primeiro os commits de origin (os seus por cima ou mesclando) e envie de novo. Seus commits ficam nesta máquina.',
            rebase: 'Rebase sobre origin',
            merge: 'Mesclar origin',
        },
        writesOff: {
            title: 'Fazer commits pelo Happier está desativado',
            body: 'Você pode ler e revisar cada alteração. Ative as operações de controle de versão para fazer commit, enviar e puxar daqui.',
            turnOn: 'Ativar',
        },
        header: {
            noChanges: 'sem alterações',
        },
        action: {
            fetch: 'Buscar',
            publish: 'Publicar branch',
            createPr: 'Criar PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Resolver ${count}`,
            upToDate: 'Em dia',
            pushing: ({ count }) => `Enviando ${count}…`,
            pulling: ({ count }) => `Puxando ${count}…`,
            fetching: 'Buscando…',
            publishing: 'Publicando…',
            creatingPr: 'Criando…',
        },
        menu: {
            open: 'Mais ações de sincronização',
            push: 'Enviar',
            pull: 'Puxar',
            pushTo: ({ target }) => `para ${target}`,
            pullFrom: ({ target }) => `de ${target}`,
            nothingToPush: 'Nada para enviar',
            upToDate: 'Em dia',
            fetchHint: 'Verificar novos commits em origin',
            publishHint: 'Colocar este branch em origin',
            createPr: 'Criar pull request…',
            createPrInto: ({ base }) => `para ${base}`,
            unavailable: 'Indisponível aqui',
            more: 'Mais',
        },
        running: {
            branchSwitch: 'Trocando de branch…',
            branchCreate: 'Criando o branch…',
            stashCreate: 'Guardando suas alterações à parte…',
            discard: 'Descartando alterações…',
            revert: 'Revertendo o commit…',
            generic: 'Trabalhando…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `sua alteração sem commit está intacta` : `suas ${formatted} alterações sem commit estão intactas`),
            commit: 'Commit feito',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 arquivo no commit` : `${formatted} arquivos no commit`),
            push: 'Enviado',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 commit enviado` : `${formatted} commits enviados`),
            upToDate: ({ target }) => `${target} está em dia`,
            pull: 'Puxado',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 commit puxado` : `${formatted} commits puxados`),
            fetch: ({ target }) => `${target} verificado`,
            branchSwitch: 'Branch trocado',
            branchCreate: 'Branch criado',
            stashCreate: 'Alterações guardadas à parte',
            discard: 'Alterações descartadas',
            revert: 'Commit revertido',
            pullRequest: 'Pull request pronta',
            generic: 'Pronto',
        },
        failed: {
            unknownTitle: 'Não conseguimos confirmar como terminou',
            unknownBody: 'A máquina parou de responder antes de o Git informar. Verifique de novo para ver o que aconteceu.',
            origin: 'origin',
            thisMachine: 'esta máquina',
            refreshTitle: 'Commit feito, mas a lista não foi atualizada',
            refreshBody: 'Seu commit está seguro. Tente de novo para ver as alterações atuais.',
            rejectedTitle: ({ target }) => `${target} tem commits que você não tem`,
            rejectedBody: 'Busque-os para ver o que mudou. Seus commits ficam nesta máquina até você enviar de novo.',
            authTitle: ({ machine, provider }) => `${provider} não aceitou o login de ${machine}`,
            authBody: ({ machine }) => `O Git em ${machine} não tem credenciais válidas para este remoto. Entre lá e tente de novo.`,
            offlineTitle: ({ machine }) => `${machine} está offline`,
            offlineBody: 'Nada pode ser executado lá agora. Seu trabalho está seguro naquela máquina.',
            conflictTitle: 'Parado por alterações em conflito',
            conflictBody: 'Alguns arquivos mudaram dos dois lados. Resolva-os e continue.',
            networkTitle: ({ target }) => `Não foi possível alcançar ${target}`,
            networkBody: 'A máquina não conseguiu se conectar ao remoto. Verifique a rede e tente de novo.',
            commitTitle: 'O commit não foi concluído',
            pushTitle: 'O envio não foi concluído',
            pullTitle: 'O pull não foi concluído',
            fetchTitle: 'Não foi possível verificar novos commits',
            pullRequestTitle: 'A pull request não foi criada',
            genericTitle: 'Não foi concluído',
        },
        recover: {
            open: 'Abrir',
            tryAgain: 'Tentar de novo',
            fetch: 'Buscar',
            checkAgain: 'Verificar de novo',
            showConflicts: 'Mostrar conflitos',
        },
        timeline: {
            title: 'Linha do tempo',
            now: 'Agora',
            loading: 'Lendo o histórico…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 alteração sem commit` : `${formatted} alterações sem commit`),
            selected: ({ count, formatted }) => (count === 1 ? `1 selecionada para o próximo commit` : `${formatted} selecionadas para o próximo commit`),
            nothingSelected: 'Nada selecionado',
            earlierToday: 'Hoje, mais cedo',
            yesterday: 'Ontem',
            older: 'Anteriores',
            justNow: 'agora mesmo',
            toPull: 'para puxar',
            originFurther: ({ name }) => `${name} está mais atrás`,
            originA11y: ({ name }) => `${name} está aqui`,
        },
        clean: {
            titleUpToDate: 'Tudo com commit e enviado',
            titleCommitted: 'Tudo com commit',
            bodyUpToDate: ({ branch, upstream }) => `${branch} corresponde a ${upstream}. Novas alterações desta sessão aparecem aqui.`,
            body: 'Novas alterações desta sessão aparecem aqui.',
            createPullRequest: 'Criar pull request',
            openPullRequest: ({ number }) => `Abrir a pull request #${number}`,
            lastCommit: ({ when }) => `Último commit ${when}`,
        },
        conflicts: {
            skip: 'Pular este commit',
            askAgentTask: ({ files, operation }) => `Resolva os conflitos da ${operation} em ${files}. Mantenha a intenção dos dois lados, edite e prepare os arquivos resolvidos e pare para a minha revisão. Não continue, não cancele, não faça commit nem push e não escolha um lado inteiro.`,
            revert: 'reversão',
            cherryPick: 'cherry-pick',
            merge: 'mesclagem',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `A ${operation} parou: 1 arquivo mudou dos dois lados` : `A ${operation} parou: ${formatted} arquivos mudaram dos dois lados`),
            readyToContinue: ({ operation }) => `Todos os conflitos foram resolvidos. Continue a ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 arquivo em conflito` : `${formatted} arquivos em conflito`),
            body: 'Abra cada arquivo em “Precisa de você” ou peça ao agente para resolvê-los.',
            continueBody: 'Nada entra no commit até você continuar.',
            askAgent: 'Pedir ao agente para resolver',
            continue: ({ operation }) => `Continuar a ${operation}`,
            abort: ({ operation }) => `Cancelar a ${operation}`,
            abortTitle: ({ operation }) => `Cancelar a ${operation}?`,
            abortBody: 'O branch volta para onde estava antes de começar. As resoluções feitas até agora são perdidas.',
            needsYou: 'Precisa de você',
            mergedCleanly: 'Mesclado sem conflitos',
        },
        commit: {
            selectFirst: 'Selecione arquivos para o commit',
        },
        tools: {
            title: 'Remotos e mesclagens',
            subtitle: 'Adicionar um remoto, mesclar ou fazer rebase de um branch',
        },
    },
    paused: { reason: 'a sessão está em pausa', resume: 'Retomar' },
    notRepository: {
        title: 'Acompanhe o que os agentes alteram aqui',
        body: ({ folder }) => `${folder} ainda não é um repositório. Crie um para rever, fazer commit e desfazer cada alteração.`,
        bodyUnnamed: 'Esta pasta ainda não é um repositório. Crie um para rever, fazer commit e desfazer cada alteração.',
    },
};

const sessionGitPaneTranslations = { pt: withFidelity(pt) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const pt: GitPullRequestCopy = {
    form: {
        title: 'Nova pull request', expand: 'Abrir num painel de detalhes', moveBack: 'Voltar para a barra lateral',
        close: 'Fechar o formulário (o rascunho é mantido)', base: 'Faz merge em', titlePlaceholder: 'Título',
        bodyPlaceholder: 'O que mudou e porquê', draft: 'Rascunho', create: 'Criar pull request', creating: 'A criar…',
        continueOn: ({ provider }) => `Continuar no ${provider}`, pointer: 'A nova pull request está aberta em Detalhes', pointerShow: 'Mostrar',
        openedProviderPage: ({ provider }) => `O ${provider} está aberto para a concluir; o seu texto fica aqui.`,
    },
    failure: {
        authFailed: ({ provider }) => `O ${provider} não aceitou o início de sessão desta máquina`,
        network: ({ provider }) => `Não foi possível contactar o ${provider}`,
        machineOffline: 'A máquina está offline; o rascunho é mantido',
        blocked: 'Outra operação Git está em curso; tente novamente quando terminar',
        other: 'A pull request não foi criada',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `para ${base}`,
        state: { open: 'Aberta', draft: 'Rascunho', merged: 'Com merge', closed: 'Fechada', unknown: 'Pull request' },
        checks: { pending: 'Verificações em curso', success: 'Verificações aprovadas', failure: 'Verificações falhadas', unknown: 'Verificações' },
        openOn: ({ provider }) => `Abrir no ${provider}`, copyLink: 'Copiar link', copied: 'Link copiado',
    },
    settings: {
        placementTitle: 'Abrir novas pull requests em', placementDescription: 'Num telemóvel, o formulário abre sempre como página própria.',
        sidebar: 'Barra lateral', details: 'Painel de detalhes',
    },
};

const sessionGitPullRequestTranslations = { pt };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { pt: translated({
        offline: 'Sem ligação',
        stale: 'Não foi possível atualizar',
        lastUpdated: ({ ago }) => `Atualizado há ${ago}`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { pt: translated({
        filtersTitle: 'Filtros de sessões', filtersSearch: 'Pesquisar filtros…', filtersShow: 'Mostrar',
        filtersScope: 'Escopo', filtersShowSessions: 'Sessões', filtersShowRuns: 'Execuções', filtersShowBoth: 'Ambas',
        filtersShowBothSummary: 'Sessões e execuções', filtersStartedByNone: 'Nenhum iniciador selecionado',
        filtersStartedBy: 'Iniciado por', filtersStartedByYou: 'Você', filtersStartedByTriggers: 'Gatilhos', filtersStartedByAgents: 'Agentes',
        filtersRunsNeedingYouAlwaysShow: 'As execuções que precisam de você sempre aparecem',
        filtersMyWork: 'Meu trabalho', filtersLegacyOwnerDirect: 'Meu trabalho', filtersAssignedToMe: 'Atribuídas a mim', filtersFollowing: 'Seguindo',
        filtersInvolvingMe: 'Com minha participação', filtersAllAccessible: 'Todas acessíveis', filtersAttention: 'Atenção',
        filtersAttentionAny: 'Qualquer', filtersAttentionNeedsMe: 'Apenas sessões que precisam de mim', filtersScopeNeedsMe: 'Precisam de mim',
        filtersInactive: 'Sessões inativas', filtersInactiveShow: 'Mostrar', filtersInactiveHide: 'Ocultar',
        filtersHomes: 'Homes', filtersSharedWith: 'Compartilhadas com', filtersOutsideTeams: 'Pessoal e direto',
        filtersTags: 'Tags', filtersSource: 'Origem', filtersSourceAll: 'Todas',
        filtersSourceDirect: 'Externas',
        filtersNoOptions: 'Nenhum filtro disponível', filtersClear: 'Limpar filtros', filtersDone: 'Concluído', filtersArchived: 'Arquivadas',
        filtersNeedsMeOnly: 'Só o que precisa de mim', filtersNeedsMeOnlyDescription: 'Sessões à sua espera', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} mais`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 item` : `${count} itens`,
        queryInitialLoadingTitle: 'Carregando sessões…', queryUpdatingTitle: 'Atualizando sessões…',
        querySomeHomesUnavailableTitle: 'Alguns Homes estão indisponíveis', querySomeHomesUnavailableDescription: 'O Happier mostra o que consegue acessar. Tente novamente quando esses Homes voltarem a ficar online.',
        queryRefreshFailedTitle: 'Não foi possível atualizar', queryRefreshFailedRetainedDescription: 'Suas sessões carregadas continuam aqui. Tente novamente para verificar atualizações.', queryRefreshFailedEmptyDescription: 'O Happier não conseguiu carregar sessões dos Homes selecionados. Tente novamente quando estiverem acessíveis.',
        queryNoMatchesLoadedTitle: 'Nenhuma correspondência nas sessões carregadas', queryNoMatchesLoadedDescription: 'Mais sessões correspondentes podem estar disponíveis em uma página anterior.', querySearchOlder: 'Pesquisar sessões anteriores',
        queryMoreAvailableTitle: 'Mais sessões podem estar disponíveis', queryMoreAvailableDescription: 'Esta visualização inclui as sessões carregadas. Pesquise sessões anteriores para continuar.',
        queryNoMatchesTitle: 'Nenhuma sessão corresponde', queryNoMatchesDescription: 'Tente alterar os filtros ativos.',
        queryTeamEmptyTitle: 'Esta Equipe não tem sessões', queryTeamEmptyDescription: 'As sessões compartilhadas com esta Equipe aparecerão aqui.',
        queryMyWorkEmptyTitle: 'Nada em Meu trabalho', queryScopeEmptyDescription: 'Tente um escopo mais amplo ou volte mais tarde.', queryBrowseAllAccessible: 'Mostrar todas as sessões',
        queryAssignedEmptyTitle: 'Nenhuma sessão foi atribuída a você', queryFollowingEmptyTitle: 'Nenhuma sessão seguida', queryInvolvingEmptyTitle: 'Nenhuma sessão com sua participação',
        queryAttentionEmptyTitle: 'Nenhuma sessão precisa da sua atenção', queryReachableEmptyTitle: 'Nenhuma sessão disponível', queryReachableEmptyDescription: 'Nenhuma sessão corresponde a esta visualização nos Homes acessíveis.',
        queryHistoricalSharesWithheldTitle: 'Algumas sessões compartilhadas estão ocultas', queryHistoricalSharesWithheldDescription: 'Sessões compartilhadas com você a partir de uma versão anterior do Happier ficam ocultas até que o proprietário as atualize no Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} não está nesta vista de Sessões`,
        partialHomeNotMountedDescription: 'Adicione este Home a um grupo de Homes visível para mostrar as sessões da Equipe sem alterar o foco.',
        partialShowFromHome: ({ home }) => `Mostrar sessões de ${home}`,
        teamListingUnavailableTitle: 'A lista de sessões da Equipe não está disponível neste Home',
        teamListingUnavailableDescription: 'Este Home ainda não pode listar as sessões da Equipe. Atualize ou reconfigure o Home e tente novamente.',
        teamListingLoadingTitle: ({ team }) => `Carregando as sessões de ${team}…`,
        teamListingLoadingDescription: 'O Happier está verificando o que este Home pode listar.',
        teamListingProbeFailedTitle: 'Não foi possível acessar este Home',
        teamListingProbeFailedDescription: 'O Happier não conseguiu consultar as sessões da Equipe neste Home. Tente novamente quando ele estiver acessível.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "pt"> = { pt: { accountActorYou: 'Você', accountActorFormerMember: 'Ex-membro', accountActorUnnamedMember: 'Membro do Happier', accountActorSentBy: ({ name }) => `Enviado por ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { pt: translated({
        sessionPages: {
            info: {
                continueTitle: 'Continuar',
                continueDescription: 'Comece um novo trabalho a partir de onde esta sessão está.',
                organizeTitle: 'Organizar',
                organizeDescription: 'Onde esta sessão aparece nas suas listas.',
                activityDescription: 'O que o agente está fazendo e se você fica sabendo.',
                detailsTitle: 'Detalhes',
                detailsDescription: 'Identificadores e histórico, para suporte e scripts.',
                environmentTitle: 'Ambiente',
                environmentDescription: 'A máquina, a pasta e o agente com que esta sessão é executada.',
                agentStateDescription: 'Quem conduz o agente e o que ele está aguardando.',
                relatedTitle: 'Relacionado',
                relatedDescription: 'Outras páginas desta sessão.',
                developerTitle: 'Desenvolvedor',
                developerDescription: 'Dados brutos para depuração, exibidos no modo desenvolvedor.',
                leaveLabel: 'Parar, arquivar ou excluir',
                leaveFootnote: 'Parar encerra o processo em execução. Sessões arquivadas podem ser restauradas. Excluir apaga a sessão e suas mensagens para sempre.',
            },
            follow: {
                description: 'Escolha se esta sessão notifica você e fala por voz.',
            },
            permissions: {
                description: 'Ferramentas que você permitiu de outro dispositivo para esta sessão. Revogue as que não quiser mais.',
            },
            automations: {
                description: 'Trabalho executado nesta sessão por agenda, evento ou ao final de um turno.',
            },
            newRun: {
                description: 'Inicie uma execução de um subagente a partir desta sessão.',
                transcriptReadOnly: 'Este é um histórico guardado. Volte a ligar-se a este Home para continuar a conversa.',
                daemonReadOnly: 'Este histórico vem do processo do Agent. Volte a ligar-se a este Home para continuar a conversa.',
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
>, "pt"> = { pt: {
        due: 'Lembrete pendente',
        title: 'Lembrar-me', inOneHour: 'Daqui a 1 hora', inThreeHours: 'Daqui a 3 horas',
        tomorrowMorning: 'Amanhã de manhã', nextWeek: 'Na próxima semana', custom: 'Escolher data e hora…',
        customTitle: 'Escolher data e hora',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Escolhe uma hora futura.',
        setReminder: 'Definir lembrete',
        reminderSaved: 'Lembrete guardado',
        presetSaveFailedAfterReminder: 'O lembrete foi guardado, mas a gravação da predefinição não foi confirmada. Tenta novamente ou fecha.',
        presetsSaveFailed: 'A gravação das predefinições não foi confirmada. As alterações mantêm-se aqui; tenta novamente.',
        presetsChanged: 'As predefinições guardadas diferem da lista que abriste. Fecha e volta a abrir para rever a lista atual.',
        remove: 'Remover lembrete',
        dateLabel: 'Data', timeLabel: 'Hora', addToPresets: 'Adicionar às predefinições', presetPreviewUnavailable: 'Escolhe uma hora futura válida para pré-visualizar.', managePresets: 'Gerir predefinições', managePresetsMessage: 'Muda o nome, a ordem ou remove lembretes guardados.', presetName: 'Nome da predefinição', movePresetUp: 'Mover para cima', movePresetDown: 'Mover para baixo', renamePresetLabel: ({ preset }) => `Mudar o nome de «${preset}»`, movePresetUpLabel: ({ preset }) => `Mover «${preset}» para cima`, movePresetDownLabel: ({ preset }) => `Mover «${preset}» para baixo`, deletePresetLabel: ({ preset }) => `Eliminar «${preset}»`, noPresets: 'Sem predefinições guardadas', noPresetsMessage: 'Guarda uma ao escolheres um lembrete personalizado.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { pt: {
        title: 'Concessões de permissões remotas',
        entryTitle: 'Concessões de permissões remotas',
        entrySubtitle: 'Reveja e revogue as concessões remotas da sessão',
        loadingTitle: 'A carregar concessões de permissões remotas',
        loadingReason: 'A verificar as concessões do atual proprietário da sessão.',
        emptyTitle: 'Sem concessões de permissões remotas',
        emptyReason: 'Esta sessão não tem concessões remotas para rever.',
        unavailableTitle: 'Concessões de permissões remotas indisponíveis',
        unavailableReason: 'Confirme que este é o atual proprietário da sessão e que a respetiva máquina está disponível e tente novamente.',
        ownerOnlyTitle: 'Só o proprietário da sessão pode gerir concessões remotas',
        ownerOnlyReason: 'Participantes partilhados podem responder a pedidos elegíveis, mas não podem rever ou revogar as concessões do proprietário da sessão.',
        retry: 'Tentar novamente',
        listTitle: 'Concessões da sessão',
        grantActive: ({ actor }) => `Concessão ativa de ${actor}`,
        grantRevoked: ({ actor }) => `Concessão revogada de ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Concessão ${grantId} · Origem ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Revogar concessão',
        revoking: 'A revogar…',
        revokeConfirmTitle: 'Revogar a concessão de permissão remota?',
        revokeConfirmBody: ({ identifier }) => `Isto revoga imediatamente a concessão remota para ${identifier}.`,
        revokeFailedTitle: 'Não foi possível atualizar as concessões remotas',
        revokeFailedReason: 'A concessão pode ter mudado ou a máquina do proprietário pode estar indisponível. Tente novamente.',
        loadMore: 'Carregar mais concessões',
        loadingMore: 'A carregar mais concessões…',
        loadMoreFailedReason: 'Não foi possível carregar mais concessões. Tente novamente.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "pt">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "pt"> = { pt: {
        responsibilitySectionTitle: 'Responsabilidade',
        responsibilityRowTitle: 'Responsável',
        responsibilityNoOne: 'Ninguém',
        responsibilityUnnamedPerson: 'Pessoa sem nome',
        responsibilityPickerTitle: 'Escolher a pessoa responsável',
        responsibilitySearchPlaceholder: 'Procurar pessoas com acesso',
        responsibilityAssignToMe: 'Atribuir a mim',
        responsibilityPeopleWithAccess: 'Pessoas com acesso',
        responsibilityAccessHintOwner: 'Proprietário',
        responsibilityNoCandidates: 'Ainda não há mais ninguém com acesso a esta sessão.',
        responsibilityAccessChanged: 'O acesso mudou. Esta pessoa já não pode ser responsável.',
        responsibilityUpdateFailed: 'O Happier não conseguiu atualizar a pessoa responsável. Tenta novamente.',
        responsibilityApprovalPending: 'A aguardar aprovação. Ainda não mudou nada: a pessoa responsável é atualizada quando for aprovado.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Pessoa responsável, ${name}. Mudar a pessoa responsável.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Pessoa responsável, ${name}.`,
        responsibilityA11yEmpty: 'Pessoa responsável, ninguém. Mudar a pessoa responsável.',
        responsibilityAssignedToYou: 'Atribuída a ti',
        responsibilitySharedWithYou: 'Partilhada contigo',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const pt: typeof en = {
    scheduled: {
        title: "Agendado",
        writesHere: "Escreve aqui",
        empty: "Nenhum workflow está agendado para escrever aqui.",
        step: ({ ordinal, title }) => `passo ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `De ${source} · passo ${step}`,
        notifyOnlyReported: "Somente se o agente relatou algo",
        notifyOnlyReportedDescription: "Ignorar a notificação quando o agente não retorna texto.",
        notifyOnlyReportedNeedsResult: "Use o resultado de texto de uma etapa anterior do agente como mensagem.",
    },
    workerUpdate: {
        settled: "Concluído",
        stalled: "Parado",
        published: "Publicado",
        truncated: "Resultado abreviado.",
        wokenBy: ({ count }) => (count === 1 ? 'Despertado por uma atualização' : `Despertado por ${count} atualizações`),
        notFromYou: 'não é uma mensagem sua',
    },
    title: 'Trabalho',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 sessão' : `${count} sessões`),
        runs: ({ count }) => (count === 1 ? '1 execução' : `${count} execuções`),
        nothingStarted: 'Nada iniciado ainda',
    },
    states: {
        recent: 'Recentes',
    },
    view: {
        a11y: 'Vista do trabalho',
        list: 'Lista',
        map: 'Mapa',
        expandMap: 'Abrir o mapa ao lado da sessão',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${position} de ${total} sob ${parent}`,
    },
    actions: {
        showInTranscript: 'Mostrar na transcrição',
        makeOrchestrator: 'Tornar orquestrador',
        makeOrchestratorSubtitle: 'Esta sessão planeja, delega e reporta',
        makeOrchestratorFailed: "Não foi possível tornar esta sessão um orquestrador",
    },
    putUnder: {
        title: "Colocar sob…",
        subtitle: "Reportar a outra sessão",
        search: "Encontrar uma sessão",
        topLevel: "Nível superior — não reporta a ninguém",
        errors: {
            cycle: "Essa sessão já reporta a esta",
            changed: "A sessão acabou de ser movida. Tente novamente",
            forbidden: "Você não pode colocá-la sob essa sessão",
            failed: "Não foi possível mover a sessão",
        },
    },
    kinds: {
        session: 'Sessão',
        workflowRun: 'Execução de fluxo',
        backgroundRun: 'Execução em segundo plano',
    },
    showMore: ({ count }) => `Mostrar mais ${count}`,
    role: {
        none: 'Nenhum',
        handsOff: 'sem edição',
        a11y: ({ role }) => `Função: ${role}. Alterar função`,
    },
    empty: {
        title: 'Nenhum trabalho iniciado',
        reason: 'As sessões, os fluxos de trabalho e as execuções em segundo plano que esta sessão iniciar aparecerão aqui, com tudo o que precisar de você.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} de ${total}`,
    strip: {
        openInSidebar: 'Abrir na barra lateral',
        stillWorking: ({ count }) => `${count} ainda trabalhando`,
        needsYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        a11y: ({ summary }) => `Trabalho: ${summary}`,
    },
    leadArchived: ({ count }) => `Esta sessão está arquivada · ${count} ainda trabalhando`,
    runsStale: 'As execuções de fluxos de trabalho podem estar desatualizadas',
    list: {
        level: ({ level }) => `Nível ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 subsessão' : `${count} subsessões`),
        showReports: ({ name, count }) => (count > 0 ? `Mostrar ${count} sessões sob ${name}` : `Mostrar as sessões sob ${name}`),
        hideReports: ({ name }) => `Ocultar as sessões sob ${name}`,
        reportsWorking: ({ count }) => `${count} trabalhando`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 subsessão precisa de você' : `${count} subsessões precisam de você`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Arquivar também 1 subsessão' : `Arquivar também ${count} subsessões`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 subsessão não foi arquivada' : `${count} subsessões não foram arquivadas`),
    },
    peek: {
        reportsTo: ({ lead }) => `Reporta a ${lead}`,
        repliesGoHere: 'As respostas vão para esta sessão',
    },
};

const notify = { pt: { turn: 'Avise-me quando este turno terminar', attention: 'Avise-me quando precisar de mim', armed: 'Você será notificado', cancel: 'Cancelar notificação', failed: 'Não foi possível atualizar a notificação. Tente novamente.', turnFinished: 'O turno desta sessão terminou.', needsYou: 'Esta sessão precisa de você.', settings: 'Configurações de notificações' } };

const runNotify = { pt: { run: 'Avise-me quando terminar', runFinished: 'Esta execução terminou.', runNeedsYou: 'Esta execução precisa de você.', setup: 'Configurar notificações' } };

const sessionWorkTranslations = { pt: { ...pt, notify: { ...notify.pt, ...runNotify.pt } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const pt = {
    sectionTitle: 'Conexões',
    sectionDescription: 'Como seus dispositivos chegam às suas máquinas.',
    directTitle: 'Conectar diretamente quando possível',
    directOnDescription: 'Prévias, visualizações ao vivo e transferências de arquivos vão direto entre seus dispositivos quando eles se alcançam, e pelo Happier quando não.',
    directOffDescription: 'Tudo passa pelo Happier. Nada se conecta diretamente às suas máquinas; na mesma rede, isso fica um pouco mais lento.',
    serverDenied: 'O servidor do seu Home envia tudo pelo Happier, então não há nada para escolher aqui.',
    machineSectionTitle: 'Conexão',
    machineTitle: ({ machine }: MachineParams) => `Conexão com ${machine}`,
    machineOptionDefault: 'Padrão',
    machineOptionDirect: 'Diretamente',
    machineOptionRelay: 'Pelo Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Segue sua conta: diretamente quando ${machine} está acessível, senão pelo Happier.`,
    machineDefaultOffDescription: 'Segue sua conta: sempre pelo Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Diretamente quando ${machine} está acessível, mesmo que sua conta diga o contrário.`,
    machineRelayDescription: 'Sempre pelo Happier, mesmo na mesma rede.',
};

const settingsConnectionsTranslations = { pt };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const pt: typeof en = {
    defaultsTitle: "Padrões das máquinas",
    localVirtualMachines: "Máquinas virtuais locais",
    runningOnly: "Nuvem cobrada apenas em execução",
    stoppedBilled: "Nuvem cobrada enquanto parada",
    billingUnknown: "Cobrança desconhecida",
    pageDescription: 'Os computadores onde as suas sessões são executadas e os pools que escolhem entre eles.',
    thisComputerTitle: 'Este computador',
    thisComputerRowSubtitle: 'Serviço em segundo plano e linha de comando',
    thisComputerPageDescription: 'O serviço em segundo plano e a linha de comando do Happier neste dispositivo.',
    setupSectionTitle: 'Configuração',
    setupRowSubtitle: 'Instale o Happier aqui e ligue-o ao seu Home.',
    addPageDescription: 'Ligue um computador para que os agentes executem as suas sessões nele.',
    addFromComputerTitle: 'Adicione máquinas a partir de um computador',
    addFromComputerDescription: 'Abra o Happier no computador que quer adicionar, ou ligue um por SSH a partir do Happier no computador ou num navegador.',
    searchPlaceholder: 'Pesquisar máquinas',
    count: ({ count }: { count: number }) => (count === 1 ? '1 máquina' : `${count} máquinas`),
    daemonTitle: 'Serviço em segundo plano',
    daemonDescription: 'Executa as suas sessões neste computador e mantém-no ligado ao seu Home.',
    unreadableTitle: ({ home }: { home: string }) => `Não foi possível ler as máquinas de ${home}`,
};

const settingsMachinesTranslations = { pt };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { pt: {
        attentionTitle: 'Requer sua atenção',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} precisa de login em ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} precisa de login`,
        serviceSignInExpired: ({ service }) => `O login de ${service} expirou`,
        signIn: 'Entrar',
        signInAgain: 'Entrar novamente',
        setupTitle: 'Primeiros passos',
        setupProgress: ({ done, total }) => `${done} de ${total}`,
        setupActionSaveKey: 'Salvar chave',
        setupActionAddMachine: 'Adicionar máquina',
        setupActionShowQr: 'Mostrar QR',
        setupActionScan: 'Escanear',
        setupActionPasteLink: 'Colar link',
        setupActionBrowse: 'Explorar',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} nesta máquina · ${latest} disponível`,
        connectTerminalTitle: 'Conectar um terminal',
        connectTerminalSubtitle: 'Escaneie o código que o terminal mostra ou cole o link dele.',
        quickSettingsTitle: 'Ajustes rápidos',
        notificationsPushOn: 'Push ativadas',
        notificationsPushOff: 'Push desativadas',
        notificationsQuietHours: 'Horário de silêncio ativado',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 alteração de plugin aguarda sua revisão' : `${count} alterações de plugins aguardam sua revisão`,
        review: 'Revisar',
        browsePluginsTitle: 'Explorar plugins',
        browsePluginsSubtitle: 'Adicione ferramentas, painéis e integrações ao Happier.',
        accountServiceSignedIn: ({ service }) => `Conectado a ${service}`,
        aboutDescription: 'Versão, código-fonte e termos legais (o Happier não é afiliado à Anthropic).',
        machinesTitle: 'Máquinas',
        machineOnline: 'Online',
        machineOffline: ({ lastSeen }) => `Offline · visto ${lastSeen}`,
        machineUpdateAvailable: 'Atualização disponível',
        machinesOnlineCount: ({ count }) => `${count} online`,
        machinesOfflineCount: ({ count }) => `${count} offline`,
        machineLastSeen: ({ lastSeen }) => `visto ${lastSeen}`,
        update: 'Atualizar',
        asOf: ({ time }) => `Às ${time}`,
        usageTitle: 'Uso',
        usageLeft: ({ percent }) => `${percent}% restante`,
        usageResets: ({ time }) => `reinicia ${time}`,
        securityTitle: 'Segurança',
        startSessionLabel: 'Iniciar uma sessão',
        saveRecoveryKeyTitle: 'Salve sua chave de recuperação',
        saveRecoveryKeySubtitle: 'A única forma de voltar aos dados criptografados se você perder todos os dispositivos.',
        addMachineTitle: 'Adicionar uma máquina',
        addMachineSubtitle: 'Conecte um computador onde seus agentes rodam.',
        homeGreetingNamed: ({ name }) => `Bem-vindo de volta, ${name}.`,
        homeStartSection: 'Iniciar uma sessão',
        homeCustomize: 'Personalizar início',
        homeCustomizeDescription: 'Escolha quais seções seu início mostra e em que ordem.',
        homeAlwaysShown: 'Sempre visível',
        homeShowSection: 'Mostrar',
        homeHideSection: 'Ocultar seção',
        homeSectionOptions: 'Opções da seção',
        homeResetLayout: 'Restaurar padrão',
        homeLayoutSectionTitle: 'Início',
        homeAddWidgetsTitle: 'Adicionar widgets',
        homeAddWidgetsDescription: 'Widgets oferecidos pelos seus plugins. Adicione um para mostrá-lo no seu início.',
        homeWidgetFromPlugin: ({ plugin }) => `De ${plugin}`,
        homeRemoveWidget: 'Remover do início',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "pt">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { pt: translated({
        settingsProfilesPage: {
            pageDescription: 'Configurações de início de uma nova sessão: o agente, o modelo, as variáveis de ambiente e onde ela roda.',
            useProfilesSection: 'Escolha de perfil',
            useProfilesSectionDescription: 'Escolha um perfil ao iniciar uma sessão ou inicie todas as sessões com o ambiente da máquina.',
            useProfiles: 'Usar perfis',
            useProfilesOffDescription: 'Desativado. Novas sessões usam o ambiente da máquina.',
            favoritesDescription: 'Aparecem primeiro quando você escolhe um perfil.',
            customDescription: 'Perfis que você criou. Editar um perfil integrado salva aqui uma cópia sua.',
            builtInDescription: 'Perfis prontos para cada agente.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Hosts SSH que este computador pode configurar como máquinas, aos quais pode se conectar ou nos quais pode rodar um relay.',
            savedHostsSection: 'Hosts salvos',
            savedHostsDescription: "Os usados mais recentemente primeiro. Abra um host para o usar ou alterar.",
            hostPageDescription: "Um host SSH que este computador pode configurar como máquina, ao qual se pode ligar ou onde pode executar um relay.",
            newHostTitle: "Novo host remoto",
            newHostDescription: "Dê um nome ao host e indique como o alcançar por SSH.",
            useSection: "Usar este host",
            useSectionDescription: "O que este dispositivo pode fazer com ele.",
            maintenanceSection: "Happier neste host",
            maintenanceSectionDescription: "Instale, atualize e execute lá a linha de comando, o serviço em segundo plano e o relay do Happier.",
            discard: "Descartar",
            accessTitle: "Chaves e ligações",
            accessRowSubtitle: "Chaves de host confiáveis e túneis abertos",
            accessPageDescription: "As chaves de host em que este dispositivo confia, e os túneis e rotas de acesso abertos para os seus hosts.",
            hostNotFound: "Este host já não está guardado.",
            unavailableDescription: 'Hosts SSH salvos podem ser configurados como máquinas ou usados como relays.',
            trustedHostKeysDescription: 'Chaves que este dispositivo aceitou ao se conectar. Remova uma para ser perguntado de novo na próxima vez.',
            trustedHostKeysEmpty: 'Ainda não há chaves de host confiáveis. Elas aparecem aqui quando você aceita uma ao se conectar.',
            sshTunnelsDescription: 'Túneis abertos deste dispositivo para um host salvo.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const pt = {
    title: 'Fornecedores', entrySubtitle: 'Ligue fontes de modelos locais e na nuvem', detailTitle: 'Ligação do fornecedor', configuredTitle: 'Os seus fornecedores', configuredFooter: 'Os modelos dos fornecedores ativados aparecem nos seletores dos agentes compatíveis.', availableTitle: 'Disponíveis', availableFooter: 'Adicione um fornecedor uma vez e use os respetivos modelos com todos os agentes compatíveis.', customTitle: 'Fornecedor personalizado', customFooter: 'Ligue um gateway da empresa ou outro endpoint de modelos compatível.', addCustom: 'Adicionar fornecedor personalizado', addCustomDescription: 'Use um endpoint compatível com OpenAI ou Anthropic', emptyTitle: 'Ainda não há fornecedores ligados', emptyDescription: 'Escolha um fornecedor disponível ou adicione o seu próprio endpoint.', unavailable: 'Os fornecedores não estão disponíveis', unavailableDescription: 'Este servidor não ativou ligações de fornecedores.', noMachine: 'Nenhuma máquina disponível', noMachineDescription: 'Ligue uma máquina para configurar e testar fornecedores.', problemTitle: 'O fornecedor precisa de atenção', searchPlaceholder: 'Pesquisar fornecedores',
    status: { available: 'Ligado', notChecked: 'Não verificado', needsAttention: 'Precisa de atenção', unreachable: 'Inacessível', disabled: 'Desativado', sourceUnavailable: 'Plugin indisponível' }, kind: { frontier: 'Fornecedor de modelos', aggregator: 'Catálogo de modelos', cloud: 'Fornecedor na nuvem', local: 'Executado nesta máquina' },
    detail: { pickSecretTitle: 'Escolha uma chave de API', notFoundTitle: 'Fornecedor não encontrado', notFoundDescription: 'Esta ligação do fornecedor já não existe.', deletedDescription: 'Este fornecedor foi removido. Escolha outro modelo antes de retomar as sessões que o utilizavam.', sourceAvailable: 'Plugin do fornecedor disponível', connectionTitle: 'Ligação', connectionFooter: 'Controle onde este fornecedor pode ser usado e verifique o estado atual.', accountAccess: 'Usar em todas as máquinas', accountAccessDescription: 'Disponível onde este fornecedor for resolvido para um endpoint público', testConnection: 'Testar ligação', testDescription: 'Verifique o endpoint e atualize o catálogo de modelos', testSucceeded: 'Ligação efetuada', testNotSupported: 'Este fornecedor não permite testar automaticamente a ligação', machinesTitle: 'Máquinas', machinesFooter: 'Os endpoints locais e privados têm de ser ativados separadamente em cada máquina.', currentMachine: 'Máquina atual', selectMachineToManage: 'Selecione esta máquina para rever e alterar o acesso', targetMachine: 'Máquina de destino', machineOnline: 'Online', machineOffline: 'Offline', apiKeyTitle: 'Chave de API', apiKeyFooter: 'As chaves ficam nos Segredos guardados e nunca são apresentadas aqui.', accountApiKey: 'Chave de API predefinida', machineApiKey: 'Chave de API nesta máquina', apiKeyConfigured: 'Configurada', apiKeyMissing: 'Adicione uma chave para ligar', apiKeySelected: 'Chave guardada selecionada', useAccountApiKey: 'Usa a chave predefinida quando não há uma chave da máquina', modelsTitle: 'Modelos', manageModels: 'Gerir modelos', modelsUnknown: 'Os modelos aparecem após a ligação', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'modelo' : 'modelos'}`, actionsTitle: 'Ações', duplicateTitle: 'Adicionar outra ligação', duplicateDescription: 'Crie uma ligação com outro nome para o mesmo fornecedor', deleteTitle: 'Remover fornecedor', deleteDescription: 'As sessões existentes mantêm o histórico, mas não podem ser retomadas com este fornecedor.', advancedTitle: 'Avançado', endpointDefault: 'Endpoint predefinido', endpointMachine: 'Endpoint nesta máquina', endpointMachineDescription: 'Substitua a predefinição apenas onde esta máquina executa o fornecedor', endpointPrompt: 'Introduza o URL base completo do fornecedor.', resetEndpoint: 'Repor endpoint', resetMachineEndpoint: 'Usar o endpoint predefinido nesta máquina', resetDefaultEndpoint: 'Usar o endpoint fornecido pelo plugin do fornecedor' },
    authoring: { providerTitle: 'Fornecedor', builtInDescription: 'Escolha um Segredo guardado e ligue este fornecedor.', compatibilityTitle: 'Compatibilidade', compatibilityFooter: 'Escolha o estilo de API documentado pelo fornecedor.', protocolTitle: 'Compatibilidade da API', protocol: { 'openai-responses': { title: 'Compatível com OpenAI Responses', description: 'Para gateways que implementam a API Responses' }, 'openai-chat': { title: 'Compatível com OpenAI Chat', description: 'Para gateways que implementam Chat Completions' }, anthropic: { title: 'Compatível com Anthropic', description: 'Para gateways que implementam a API Messages' } }, detailsTitle: 'Detalhes do fornecedor', name: 'Nome', namePlaceholder: 'Gateway da empresa', baseUrl: 'URL base', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Caminho dos modelos', credentialsTitle: 'Credenciais', credentialsFooter: 'Selecione um Segredo guardado. Nunca cole uma chave de API no URL nem nos cabeçalhos.', requiresApiKey: 'Requer uma chave de API', requiresApiKeyYes: 'Usar um Segredo guardado nos pedidos', requiresApiKeyNo: 'Ligar sem credenciais', apiKey: 'Chave de API', apiKeyDescription: 'Escolha ou crie um Segredo guardado', credentialStyleTitle: 'Formato da chave de API', credentialHeader: 'Nome do cabeçalho', credentialStyle: { bearer: 'Token bearer de autorização', xApiKey: 'Cabeçalho x-api-key', apiKey: 'Cabeçalho api-key', customHeader: 'Cabeçalho personalizado' }, catalogTitle: 'Catálogo de modelos', catalogFooter: 'Obtenha modelos automaticamente quando o endpoint permitir ou adicione-os manualmente mais tarde.', fetchModels: 'Obter modelos automaticamente', fetchModelsYes: 'Usar o endpoint da lista de modelos do fornecedor', fetchModelsNo: 'Adicionar IDs de modelos manualmente', verifyTitle: 'Ligar', verifyFooter: 'Teste primeiro quando possível e depois guarde o fornecedor.', save: 'Guardar fornecedor', connect: 'Ligar fornecedor' },
    errors: { secretMissingTitle: 'É necessária uma chave de API', secretMissingDescription: 'Escolha um Segredo guardado antes de ativar este fornecedor.', notEnabledOnMachineTitle: 'Não ativado nesta máquina', notEnabledOnMachineDescription: 'Ative este fornecedor na máquina onde a sessão será executada.', disabledTitle: 'O fornecedor está desativado', disabledDescription: 'Ative este fornecedor antes de usar os respetivos modelos.', unreachableTitle: 'O fornecedor está inacessível', unreachableDescription: 'Verifique se o serviço está em execução e se o endpoint está correto. Depois, tente novamente.', notFoundTitle: 'Fornecedor não encontrado', notFoundDescription: 'Este fornecedor foi removido. Escolha outro fornecedor ou modelo.', sourceUnavailableTitle: 'Plugin do fornecedor indisponível', sourceUnavailableDescription: 'Reative ou reinstale o plugin que fornece esta ligação.', featureDisabledTitle: 'Os fornecedores estão indisponíveis', featureDisabledDescription: 'Este servidor não ativou ligações de fornecedores.', unauthorizedTitle: 'Chave de API rejeitada', unauthorizedDescription: 'Substitua o Segredo guardado por uma chave válida e teste novamente a ligação.', rateLimitedTitle: 'O fornecedor limitou os pedidos', rateLimitedDescription: 'Aguarde um momento e teste novamente a ligação.', probeCapacityTitle: 'Demasiadas verificações do fornecedor em simultâneo', probeCapacityDescription: 'O Happier ainda não conseguiu iniciar esta verificação na máquina selecionada. Aguarde um momento e tente novamente.', genericTitle: 'O fornecedor precisa de atenção', genericDescription: 'Reveja as definições do fornecedor e tente novamente.' },
    models: { builtIn: 'Integrado', experimental: 'Experimental', experimentalConfirmTitle: 'Usar um modelo experimental?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${model} do ${provider} ainda não foi totalmente verificado com este agente. Se não funcionar como esperado, poderá ter de reiniciar ou escolher outro modelo.`, experimentalConfirmAction: 'Usar modelo', stale: 'Pode estar indisponível', hidden: 'Oculto', manage: 'Gerir modelos', empty: 'Ainda não há modelos disponíveis para este fornecedor.', add: 'Adicionar modelos', addPlaceholder: 'Introduza um ID de modelo por linha', resetVisibility: 'Repor visibilidade', showHidden: 'Mostrar modelos ocultos', hideHidden: 'Ocultar modelos ocultos', remove: 'Remover modelo', removeConfirmation: 'Remover este modelo adicionado manualmente?', enable: 'Mostrar modelo', disable: 'Ocultar modelo', load: 'Carregar modelo', retry: 'Tentar novamente', connectionUnavailable: 'Este fornecedor não está disponível na máquina selecionada.' },
};

const localTranslations = { pt: { title: 'Nesta máquina', footer: 'Servidores de modelos locais encontrados nesta máquina. Os modelos são executados de forma privada no seu equipamento.', detected: 'Detetado', possible: 'Possível serviço', detectedAtPort: ({ port }: { port: string }) => `Detetado · Porta ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Possível serviço ${provider} · Porta ${port}`, addConnectionTitle: 'Adicionar outra ligação local', addConnectionDescription: 'Dê um nome para a distinguir dos outros endpoints locais.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} local` } } as const;

const providerManagedDeploymentTranslations = { pt: {
        configureManaged: 'Executar sessões com um serviço local gerido',
        configureManagedDescription: 'Escolha a conta ligada ou o grupo para sessões futuras. O Happier inicia o serviço quando necessário.',
        subscriptionPolicyTitle: 'O encaminhamento de subscrições é experimental',
        subscriptionPolicyDescription: 'A política ou a aplicação do fornecedor original pode mudar e fazer com que deixe de funcionar. O Happier mostra a rejeição e não usa silenciosamente outra credencial.',
        accountScopeMismatchTitle: 'As contas conectadas ficam no servidor ativo',
        accountScopeMismatchDescription: 'Este provedor é gerido numa máquina de outro servidor. Muda para esse servidor para escolher a conta conectada ou o grupo.',
        editManagedDefaults: 'Editar valores de sessões geridas',
        editManagedDefaultsDescription: 'Altere a conta ligada ou o grupo para sessões futuras. As sessões existentes mantêm a seleção.',
        purposeTargetTitle: 'Destino da conta ligada',
        purposeTargetDescription: 'Escolha uma conta ligada ou um grupo disponível para esta finalidade.',
        invalidPurposeTargetTitle: 'Destino de conta inválido',
        invalidPurposeTargetDescription: 'Escolha uma conta ligada ou um grupo disponível antes de guardar.',
        useExternal: 'Usar um serviço externo',
        useExternalDescription: 'Deixe de gerir este fornecedor para sessões futuras e use a configuração do endpoint externo.',
        useExternalConfirmTitle: 'Usar um serviço externo?',
        useExternalConfirmDescription: 'Os valores geridos são removidos. As sessões existentes mantêm as seleções.',
    } } as const;

const copyNameTranslations = { pt: ({ name }: { name: string }) => `Cópia de ${name}` } as const;

const providerSharedFieldTranslations = { pt: {
        local: { installedNotRunning: 'Instalado, mas não está em execução', appRunningServerOff: 'A aplicação está aberta, mas o servidor local está desativado', startManaged: ({ provider }: { provider: string }) => `Iniciar ${provider}`, startedByHappier: 'Iniciado pelo Happier', runningOutsideHappier: 'Em execução fora do Happier' },
        apiKeyOptionalDescription: 'Opcional: escolha um Segredo guardado se este fornecedor exigir um',
        models: { addDescription: 'Adicione IDs de modelos que o fornecedor não apresenta automaticamente', addHelp: 'Introduza um ID de modelo exato por linha. Os modelos existentes são ignorados.', addFieldLabel: 'IDs de modelos', invalidModelIds: ({ ids }: { ids: string }) => `Estes IDs de modelos são inválidos: ${ids}`, noNewModels: 'Não há novos IDs de modelos para adicionar.', providerManagedTitle: 'Os modelos são geridos por este fornecedor', providerManagedDescription: 'Atualize o catálogo do fornecedor para renovar esta lista. Não são permitidos IDs de modelos manuais.', showAll: 'Mostrar todos os modelos', hideAll: 'Ocultar todos os modelos', hideAllConfirmation: 'Ocultar todos os modelos desta lista? Pode voltar a mostrá-los a qualquer momento.', showOnly: 'Mostrar apenas este modelo', showOnlyConfirmation: 'Ocultar todos os outros modelos desta lista? Pode restaurá-los a qualquer momento.' },
    } } as const;

const providerFirstSessionValidationTranslations = { pt: 'O Happier validará a ligação em segurança ao iniciar a primeira sessão que a utilize.' } as const;

const providerMigrationTranslations = { pt: { reviewTitle: 'Rever migração do fornecedor', reviewFooter: 'Confirme o endpoint, formato da API, credencial e modelos antes de aplicar alterações.', legacyProfileDescription: 'Este perfil mantém o encaminhamento antigo até confirmar a revisão.', credentialTitle: 'Credencial', credentialFooter: 'Apenas a referência ao Segredo guardado é movida; o valor nunca é apresentado nem copiado.', noCredential: 'Sem chave API', credentialMoveDescription: 'Mover esta credencial para a nova ligação', noCredentialDescription: 'Criar a ligação sem credenciais', actionsTitle: 'Migração', preview: 'Rever alterações', previewDescription: 'Validar esta configuração sem alterar definições', confirm: 'Criar ligação do fornecedor', confirmDescription: 'Aplicar as alterações atomicamente e manter as preferências de início', reviewAction: 'Rever migração do fornecedor', reviewActionDescription: 'Mover o endpoint e modelos antigos para uma ligação', retainedTitle: 'Configuração antiga mantida', retainedDescription: 'Continuará disponível até poder ser migrada sem perder comportamento.' } } as const;

const providerMigrationPreviewTranslations = { pt: { willMoveTitle: 'Será movido para o fornecedor', willMoveFooter: 'Apenas estes nomes de encaminhamento e credenciais são movidos. Os valores secretos nunca são apresentados.', willKeepTitle: 'Permanecerá no perfil de início', willKeepFooter: 'Estas definições exclusivas do início permanecem no perfil após a migração.', permissionDefaults: 'Permissões predefinidas', persistenceDefaults: 'Armazenamento de sessão predefinido' } } as const;

const providerMigrationConflictTranslations = { pt: { conflictReviewTitle: 'Resolver conflito de migração', conflictReviewFooter: 'Escolha entre manter a ligação existente ou guardar este perfil como uma ligação separada. Os valores secretos não são apresentados.', conflictCredential: 'A credencial guardada é diferente', conflictModels: 'As definições dos modelos são diferentes', conflictEditedConnection: 'A ligação existente foi alterada', keepExisting: 'Manter ligação existente', keepExistingDescription: 'Mantenha as credenciais e modelos atuais e conclua a migração sem os substituir.', modelOutcomeTitle: 'Escolha o modelo a manter', modelOutcomeFooter: 'Confirme o modelo exato antes de concluir a migração. Nada muda até escolher.', useExistingModel: 'Usar o modelo atual da ligação', useExistingModelDescription: 'Mantenha o modelo já selecionado para esta ligação do fornecedor.', preserveLegacyModel: 'Usar o modelo do perfil', preserveLegacyModelDescription: 'Mova a escolha exata deste perfil para a ligação existente.', discardLegacyModel: 'Remover a escolha de modelo do perfil', discardLegacyModelDescription: 'Conclua a migração sem a seleção de modelo nem o favorito deste perfil.', createNamed: 'Criar ligação separada', createNamedDescription: 'Preserve as definições do fornecedor deste perfil numa nova ligação.', separateConnectionName: 'Nome da ligação', conflictReviewAction: 'Resolver conflito do fornecedor', conflictReviewActionDescription: 'Escolha como preservar credenciais ou modelos em conflito' } } as const;

const providerCredentialSelectionRequiredTranslations = { pt: 'Escolha a credencial guardada que esta ligação do fornecedor deve utilizar' } as const;

const providerLinkTranslations = { pt: { providerWebsite: 'Site do fornecedor', getApiKey: 'Obter chave de API', failedToOpen: 'O Happier não conseguiu abrir esta ligação.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { pt: 'Escolha como esta credencial é enviada' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { pt: 'Ligue este editor de perfis a uma máquina disponível antes de alterar variáveis de ambiente.' } as const;

const providerAdvancedAuthoringTranslations = { pt: { advancedSetup: 'Configuração avançada', advancedSetupEnabled: 'Configure vários estilos de API, cabeçalhos e verificações seguras de modelos', advancedSetupDisabled: 'Use um endpoint compatível comum', endpointEnabled: 'Usar este estilo de API', endpointEnabledDescription: 'Disponibilizar este endpoint aos agentes compatíveis', endpointDisabledDescription: 'Este estilo de API não será usado', publicHeaders: 'Cabeçalhos públicos do pedido', publicHeadersPlaceholder: 'X-Tenant: engenharia', optionalProbePath: 'Caminho da lista de modelos (opcional)', probeParserTitle: 'Formato da resposta', probeParser: { openaiModels: 'Lista de modelos compatível com OpenAI', ollamaTags: 'Etiquetas do Ollama', lmStudioNative: 'Lista de modelos nativa do LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { pt: 'Cabeçalho personalizado (token Bearer)' } as const;

const providerNonSecretHeaderTranslations = { pt: 'Cabeçalhos não secretos' } as const;

const providerProbePathsTranslations = { pt: 'Caminhos da lista de modelos (opcionais, um por linha)' } as const;

const providerLocalAuthoringTranslations = { pt: { enableAfterSaving: 'Ativar este fornecedor', enableOnCurrentMachine: 'Ativar apenas nesta máquina depois de guardar', enableAccountWide: 'Ativar depois de guardar', localAddressTitle: 'Endereço local', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Ative separadamente em cada máquina. ${machine} usará ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { pt: { destinationReview: 'Destino da ligação', destinationLoading: 'A resolver o destino exato no daemon…', destinationSelection: 'Escolha um destino', destinationSelectionDescription: 'Reveja o endereço exato antes de ligar.', destinationScope: 'Âmbito do destino', destinationMachine: 'Esta máquina', destinationAccount: 'Conta' } } as const;

const providerCompatibilityTranslations = { pt: { title: 'Funciona com', footer: 'A compatibilidade é verificada por cada integração de agente e pode variar por modelo.', verified: 'Verificado', experimental: 'Experimental', incompatible: 'Incompatível', verifiedDescription: 'Testado com esta integração de agente', experimentalDescription: 'Pode funcionar, mas requer revisão antes da primeira utilização', incompatibleDescription: 'Este agente não pode usar a ligação em segurança' } } as const;

const providerModelNotLoadedTranslations = { pt: 'Não carregado · pode carregar na primeira utilização' } as const;

const providerModelLoadCancellationTranslations = { pt: { cancelLoad: 'Cancelar carregamento', loadCancelled: 'A espera pelo modelo foi interrompida', loadCancelledProviderMayContinue: 'O fornecedor pode continuar a carregá-lo. Atualize o catálogo mais tarde para verificar uma conclusão tardia; o Happier não repetirá o carregamento.' } } as const;

const providerPartialStatusTranslations = { pt: 'Parcialmente disponível' } as const;

const providerConnectedServiceSuppressedTranslations = { pt: 'O início de sessão nativo do agente não é usado com este fornecedor. A seleção guardada não é alterada.' } as const;

const providerMachineCleanupPendingTranslations = { pt: 'A máquina foi removida, mas não foi possível guardar a limpeza do acesso aos fornecedores. Verifique a ligação e remova novamente a máquina para tentar outra vez.' } as const;

const providerConnectionChangedTranslations = { pt: { title: 'A ligação do fornecedor mudou', description: 'Volte a carregar as definições atuais do fornecedor e tente novamente.' } } as const;

const providerModelSectionTranslations = { pt: { available: 'Disponíveis', manual: 'Manual' } } as const;

const providerCompletenessTranslations = { pt: {
        searchEmptyTitle: 'Nenhum fornecedor corresponde a esta pesquisa',
        searchEmptyDescription: 'Experimente outro nome de fornecedor ou ligação.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Este agente e o fornecedor não partilham nenhum protocolo de API suportado.',
            noAuthUnsupported: 'Este agente requer o envio de uma chave de API para este fornecedor.',
            credentialTransportUnavailable: 'Este agente não suporta o método configurado para enviar a chave de API.',
            optionalCredentialNoAuthUnsupported: 'Este agente não pode usar o fornecedor sem a chave de API opcional.',
            capabilityUnsupported: 'Uma capacidade obrigatória do fornecedor não é suportada.',
            capabilityUnknown: 'Uma capacidade obrigatória do fornecedor ainda não foi verificada.',
            modelEvidenceRequired: 'Escolha um modelo para verificar as capacidades necessárias.',
            modelCapabilityUnsupported: 'O modelo não suporta uma capacidade obrigatória.',
            modelCapabilityUnknown: 'Uma capacidade obrigatória do modelo ainda não foi verificada.',
            overrideIncompatible: 'A verificação do fornecedor marca esta integração como incompatível.',
            overrideExperimental: 'A verificação do fornecedor marca esta integração como experimental.',
            evidenceMissing: 'Ainda não foram registados dados de compatibilidade.',
            agentUnsupported: 'Este agente não suporta fornecedores de modelos externos.',
            adapterInvalid: 'Não foi possível validar o adaptador do fornecedor do agente.',
            unknown: 'Uma condição de compatibilidade mais recente requer revisão.',
        },
        unsavedDescription: 'Descartar este rascunho de fornecedor? Os Segredos guardados são objetos partilhados da conta e continuarão disponíveis.',
        recoveryActions: {
            reviewFeatures: 'Rever disponibilidade dos fornecedores',
            chooseConnection: 'Escolher fornecedor',
            restorePlugin: 'Rever plugin',
            enableConnection: 'Ativar fornecedor',
            reviewAccountGrant: 'Rever acesso da conta',
            enableOnMachine: 'Ativar na máquina',
            reviewMachineGrant: 'Rever acesso da máquina',
            reviewCompatibility: 'Rever compatibilidade',
            addSecret: 'Adicionar chave de API',
            reviewCredentialTransport: 'Rever suporte de credenciais',
            reviewConnection: 'Rever ligação',
            retry: 'Tentar novamente',
            replaceSecret: 'Substituir chave de API',
            chooseModel: 'Escolher modelo',
            loadModel: 'Carregar modelo',
            reviewAndRestart: 'Rever e reiniciar',
            restartProbe: 'Testar novamente',
            reduceProviderSettings: 'Gerir definições dos fornecedores',
            reviewProfileMigration: 'Rever migração do perfil',
            reviewCurrentState: 'Rever definições atuais',
        },
        hiddenForAllAgents: 'Oculto para todos os agentes · Gerir nas definições de Fornecedores',
    } } as const;

const providerAvailabilityTranslations = { pt: {
        availabilityChecking: 'A verificar a disponibilidade dos fornecedores', availabilityCheckingDescription: 'O Happier está a confirmar se este servidor suporta ligações a fornecedores.',
        availabilityProblem: 'Não foi possível verificar a disponibilidade dos fornecedores', availabilityProblemDescription: 'O Happier tentará novamente de forma automática. Verifique a ligação ao servidor se o problema persistir.',
        availabilityUnsupported: 'Os fornecedores requerem uma atualização do servidor', availabilityUnsupportedDescription: 'Esta versão do servidor não suporta ligações a fornecedores.',
        availabilityContextUnsupported: 'Os fornecedores não são suportados neste contexto', availabilityContextUnsupportedDescription: 'A configuração ou seleção atual do servidor não suporta ligações a fornecedores.',
        availabilityPolicyDisabled: 'Os fornecedores estão desativados por uma política', availabilityPolicyDisabledDescription: 'Uma política local ou de compilação desativou as ligações a fornecedores.',
    } } as const;

const settingsProvidersTranslations = { pt: withProviderSharedFields(pt, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.pt,
        providerLinkTranslations: providerLinkTranslations.pt,
        providerCompletenessTranslations: providerCompletenessTranslations.pt,
        providerPartialStatusTranslations: providerPartialStatusTranslations.pt,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.pt,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.pt,
        providerCompatibilityTranslations: providerCompatibilityTranslations.pt,
        providerMigrationTranslations: providerMigrationTranslations.pt,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.pt,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.pt,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.pt,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.pt,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.pt,
        localTranslations: localTranslations.pt,
        providerSharedFieldTranslations: providerSharedFieldTranslations.pt,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.pt,
        copyNameTranslations: copyNameTranslations.pt,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.pt,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.pt,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.pt,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.pt,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.pt,
        providerProbePathsTranslations: providerProbePathsTranslations.pt,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.pt,
        providerModelSectionTranslations: providerModelSectionTranslations.pt,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.pt,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.pt,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.pt,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { pt: translated({
        settingsSearchKeywords: {
            settings: 'configurações, definições, início, visão geral',
            groupProfileAndAccount: 'conta, perfil, cobrança, plano, uso',
            account: 'conta, perfil, cobrança',
            accountSecurity: 'segurança, senha, recuperação, criptografia, sair',
            apiTokens: 'token de api, token de acesso pessoal, pat, automação, cli, sdk',
            teams: 'equipes, membros, grupos, convites',
            homeAdministration: 'home, administração, governança, pessoas, políticas',
            secrets: 'segredos, chaves, env, tokens',
            usage: 'uso, cobrança, limites, cota',
            machines: 'máquinas, dispositivos, computador',
            machinePoolsNew: 'pools de máquinas, pools, alternativa, executar em',
            machinesAdd: 'adicionar, máquina, ssh',
            machinesThisComputer: 'este computador, local, dispositivo',
            remoteHosts: 'remoto, host, hosts, ssh, servidor, máquinas',
            groupGeneral: 'geral, aparência, idioma, experimentos',
            appearance: 'aparência, tema, fonte, interface, barra lateral',
            keyboard: 'teclado, atalho, atalhos, teclas de atalho, comandos',
            pets: 'mascotes, blink, companheiro, codex',
            language: 'idioma, localidade, tradução',
            features: 'recursos, experimentos, beta',
            groupAiAndAgents: 'agentes, provedores, mcp, prompts, voz',
            agents: 'provedores, agentes, modelos, llm',
            providers: 'provedores, modelos, openrouter, ollama, lm studio',
            subAgent: 'subagentes, agentes, delegação, regras',
            roles: 'funções, orquestrador, construtor, revisor, instruções',
            delegation: 'delegação, profundidade, passagem, orquestrador',
            profiles: 'perfis, personas',
            connectedServices: 'serviços conectados, oauth, contas',
            mcp: 'mcp, ferramentas, servidores, plugins',
            plugins: 'plugins, marketplace, catálogo, descritor, descoberta',
            prompts: 'prompts, modelos, biblioteca',
            promptsTemplates: 'modelos',
            promptsFolders: 'pastas',
            promptsStacks: 'pilhas',
            promptsRegistries: 'registros',
            promptsLibrary: 'biblioteca',
            promptsAssets: 'recursos, externo',
            voice: 'voz, assistente, microfone',
            voiceConversations: 'voz, conversa, tempo real, provedor',
            voiceDictation: 'voz, ditado, fala, transcrição',
            voicePrivacy: 'voz, privacidade, histórico, retenção',
            voiceAdvanced: 'voz, avançado, máquina, diagnóstico',
            memory: 'memória, pesquisa, índice',
            groupSessionsBehavior: 'sessões, transcrição, permissões, ações',
            session: 'sessão, terminal, tmux',
            externalSessions: 'sessões externas, acompanhamento em segundo plano, hooks',
            actions: 'ações, aprovações, atalhos',
            embeds: 'incorporações, incorporar, iframe, widget, site, chat',
            transcript: 'transcrição, chat, layout',
            permissions: 'permissões, aprovação, segurança',
            toolRendering: 'ferramentas, renderização',
            handoff: 'transferência, passagem',
            runs: 'execuções, execução',
            groupFilesAndSourceControl: 'arquivos, controle de versão, anexos',
            sourceControl: 'git, scm, controle de versão',
            attachments: 'anexos, uploads, arquivos',
            groupSystem: 'sistema, servidores, status, notificações',
            servers: 'servidores, relay',
            systemStatus: 'status do sistema, saúde, diagnóstico',
            updates: 'atualizações, atualizar, versão, cli, reiniciar',
            notifications: 'notif, notificação, notificações, push',
            notificationsPush: 'push, notificações push',
            desktop: 'desktop, tauri, sobreposição, janela',
            diagnosis: 'diagnóstico, depuração',
            reportIssue: 'relatar problema, bug',
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
>, "pt"> = { pt: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Corrija o teste de reconexão instável',
                agentReply: 'Encontrei: o temporizador de novas tentativas nunca era limpo. Está corrigido e o teste passa.',
                thinking: 'O teste só falha depois de um tempo limite, então o temporizador de novas tentativas provavelmente continua ativo.',
            },
            runtime: {
                pageDescription: 'Como as sessões são executadas nas suas máquinas.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Host de terminal para novas sessões',
                terminalHostNone: 'Nenhum',
                tmuxTitle: 'Iniciar sessões no tmux',
                tmuxOn: 'Novas sessões abrem em uma janela própria do tmux, para você se conectar a elas de um terminal.',
                tmuxOff: 'Novas sessões rodam em um shell comum.',
            },
            wizard: {
                pageDescription: 'Como o assistente de nova sessão organiza as etapas.',
                wideScreensSection: 'Telas largas',
                stepsSection: 'Como cada etapa mostra as opções',
                steps: {
                    profiles: 'Perfil',
                    backends: 'Agente',
                    models: 'Modelo',
                    machines: 'Máquina',
                    paths: 'Pasta',
                    permissions: 'Permissões',
                },
            },
            providerLimits: {
                pageDescription: 'O que acontece quando o limite de uso de um provedor é atingido e quanto da cota ainda resta.',
                recoveryDescription: 'Quando um agente atinge o limite de uso do provedor, a sessão pode esperar a renovação e continuar.',
                resumePromptCustom: 'Personalizado',
                unavailableTitle: 'Indisponível nesta Home',
                unavailableDescription: 'A recuperação após o limite de uso e o medidor de uso do provedor não estão ativados nesta Home.',
            },
            resume: {
                pageDescription: 'Como uma sessão inativa continua quando o agente não consegue retomá-la sozinho.',
                strategyRecent: 'Mensagens recentes',
                strategySummary: 'Resumo + recentes',
                maxSeedCharsTitle: 'Limite de tamanho do replay',
                summaryModelSection: 'Modelo de resumo',
                summaryModelDescription: 'O agente e o modelo que escrevem o resumo reproduzido na nova sessão.',
                handoffSection: 'Mover sessões',
                handoffLinkDescription: 'O que acompanha uma sessão quando você a passa para outra máquina.',
            },
            permissions: {
                duringSessionSection: 'Durante uma sessão',
                duringSessionDescription: 'Onde aparecem os pedidos de aprovação e quando uma mudança de permissões em uma sessão em andamento entra em vigor.',
                promptSurfaceComposer: 'Perto do compositor',
                applyImmediately: 'Imediatamente',
                applyNextMessage: 'Próxima mensagem',
                storageUseDefault: 'Padrão',
            },
            handoff: {
                pageDescription: 'O que acompanha uma sessão quando você a passa para outra máquina.',
                workspaceSection: 'Arquivos do espaço de trabalho',
                workspaceDescription: 'O que acontece com a pasta do projeto quando uma sessão vai para outra máquina.',
                keepUpdated: 'Manter atualizado',
                advancedModeDescription: 'Substitui a opção acima. Cuidado: arquivos podem ser removidos ou sobrescritos.',
                ignoredExclude: 'Excluir',
                ignoredIncludeSelected: 'Incluir selecionados',
            },
            toolRendering: {
                pageDescription: 'Dê a ferramentas específicas mais ou menos detalhes que o padrão da transcrição.',
                collapsedDescription: 'Quanto cada ferramenta mostra na transcrição antes de você abri-la.',
            },
            transcript: {
                advancedTitle: 'Desempenho e tempos',
                advancedPageDescription: 'Streaming, tempos de animação e limites de rolagem. Os padrões servem para quase todos.',
                advancedMotionOff: 'As animações da transcrição estão desligadas, então isto não tem efeito. Ative-as em Transcrição › Movimento.',
                toolsSection: 'Ferramentas',
                toolOverridesDescription: 'Dê a ferramentas específicas mais ou menos detalhes.',
                thinkingSummary: 'Resumo',
                thinkingFull: 'Completo',
                strategyConsecutive: 'Consecutivas',
                strategyWholeTurn: 'Turno inteiro',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Mensagens copiadas mantêm a formatação e indicam quem as escreveu.',
                copyPlainDescription: 'Mensagens copiadas são texto simples, sem rótulos.',
                motionSubtle: 'Sutil',
                advancedLinkDescription: 'Streaming, tempos de animação e limites de rolagem.',
                pageDescription: 'Como uma conversa é lida à medida que cresce: layout, raciocínio, ferramentas, movimento e rolagem.',
            },
            composer: {
                pageDescription: 'Como você escreve e envia mensagens, e o que acontece quando um agente está ocupado.',
                newSessionsSection: 'Novas sessões',
                newSessionsDescription: 'O que você vê ao escolher Nova sessão.',
                draftEntryTitle: 'Ao abrir Nova sessão',
                draftResume: 'Retomar rascunho',
                draftFresh: 'Começar do zero',
                typingSection: 'Digitação',
                typingDescription: 'Como Enter e o histórico de mensagens funcionam no compositor.',
                enterToSendTitle: 'Enter para enviar',
                sendModeTitle: 'Enquanto o agente trabalha',
                sendQueue: 'Na fila',
                sendInterrupt: 'Interromper',
                sendPending: 'Pendente',
                busySteerTitle: 'Se o agente aceita direcionamento',
                busySteerInactive: 'Só vale quando as mensagens entram na fila ou ficam pendentes enquanto o agente trabalha.',
                nonSteerableTitle: 'Perguntar quando uma mensagem não puder direcionar',
                resumeWhenPossible: 'Quando possível',
                resumeIfOnline: 'Se estiver online',
                resumeNever: 'Nunca',
                pendingSection: 'Mensagens pendentes',
                pendingDescription: 'Como as mensagens pendentes chegam ao agente.',
                pendingInactive: 'Com suas escolhas atuais nada fica pendente. Isto vale assim que uma mensagem ficar.',
                drainOne: 'Uma de cada vez',
                drainAll: 'Todas juntas',
                timingAfterReply: 'Após a resposta',
                timingWhenIdle: 'Com tudo ocioso',
                layoutSection: 'Layout do compositor',
                actionBarTitle: 'Barra de ações',
                actionBarAutoDescription: 'Os controles usam o espaço disponível e passam para outra linha quando necessário.',
                actionBarWrapDescription: 'Os chips quebram para uma segunda linha quando não cabem.',
                actionBarScrollDescription: 'Os chips ficam em uma linha; role para ver o resto.',
                actionBarCollapsedDescription: 'Os chips vão para um menu, deixando mais espaço para escrever.',
                chipDensityTitle: 'Chips de ação',
                chipsAutoDescription: 'Chips que precisam mantêm o rótulo; os óbvios mostram só o ícone.',
                chipsLabelsDescription: 'Cada chip mostra seu rótulo.',
                chipsIconsDescription: 'Os chips mostram só o ícone, para economizar espaço.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { pt: {
        publicLink: { description: "Qualquer pessoa com o link pode ler este documento sem uma conta.", grants: "Documento somente para leitura.", audit: "Registro de acesso", auditEmpty: "Nenhuma visita registrada.", ownerUpdateRequired: "O proprietário está atualizando este link", ownerUpdateRequiredDescription: "Peça ao proprietário para abrir o Happier e tente este link novamente." },
        whoHasAccess: 'Quem tem acesso',
        whoHasAccessStale: 'Quem tem acesso · pode estar desatualizado',
        owner: 'Proprietário',
        you: 'Você',
        addPlaceholder: 'Adicionar pessoas ou equipes',
        person: 'Pessoa',
        group: 'Grupo da equipe',
        team: 'Equipe',
        accessLevel: 'Nível de acesso',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Remover acesso',
        confirmRemove: 'Confirmar remoção',
        removedAnnouncement: ({ name }) => `${name} não tem mais acesso`,
        browseAll: 'Ver tudo',
        browsePeople: 'Ver todas as pessoas',
        browseTeams: 'Ver todas as equipes',
        browseGroups: 'Ver todos os grupos de equipe',
        membersOnlyLink: 'Copiar link é para quem já tem acesso.',
        allLoaded: 'Todos os resultados carregados',
        copyLink: 'Copiar link',
        linkCopied: 'Link copiado',
        copyLinkFailed: 'Não foi possível copiar o link.',
        sendCopy: 'Enviar uma cópia em vez disso',
        secrets: {
            levels: { canUse: 'Pode usar' },
            help: { use: 'em execuções; o valor nunca é mostrado' },
            oneLevel: 'Um segredo guardado só é usado por execuções e o valor nunca sai, por isso tem um único nível.',
        },
        documents: {
            title: 'Compartilhamento',
            shareTitle: ({ name }) => `Compartilhar ${name}`,
            levels: { canUse: 'Pode usar', canRead: 'Pode ler', canEdit: 'Pode editar', admin: 'Administrar' },
            help: {
                workflowUse: 'ver e executar',
                roleUse: '— as próprias alterações ficam nas próprias Configurações',
                profileUse: 'iniciar sessões com ele',
                documentUse: 'abri-lo e copiá-lo em qualquer um dos seus dispositivos',
                promptUse: 'usá-lo nas suas sessões',
                boardUse: 'ver o quadro; cada cartão abre só o que já pode abrir',
                dashboardUse: 'Veja este painel; cada widget mostra apenas o que você já pode abrir.',
                editForEveryone: 'alterar para todos com quem é compartilhado',
                adminOwnerShares: 'alterar e gerenciar o compartilhamento',
            },
            notes: {
                personalRuns: 'Execuções e gatilhos ficam com quem os inicia.',
                teamRuns: 'A equipe vê cada execução.',
                roleLive: 'Suas alterações chegam a todos com quem é compartilhado.',
                profileSecrets: 'Perfis fazem referência a Segredos salvos; seus valores não são transmitidos.',
                dashboardAccess: 'As pessoas adicionadas o abrem com a própria identidade. Widgets, definições, conexões, máquinas e repositórios precisam de acesso independente.',
            },
            privateChoices: {
                title: 'Escolhas de conexão privadas',
                account: ({ widget, service }) => `${widget} usa sua conta ${service}`,
                letViewersPick: 'Deixar os leitores escolherem',
                removeChoice: 'Remover a escolha',
                authoredInput: ({ widget }) => `Edite ${widget} para remover as entradas privadas antes de compartilhar.`,
            },
            errors: {
                unavailable: 'O compartilhamento ainda não está disponível aqui.',
                ownerOnly: 'Só o proprietário ou um administrador pode alterar quem tem acesso.',
                noAccess: 'Você não tem mais acesso.',
                notFound: 'Não está mais disponível.',
                subjectUnavailable: 'Esta pessoa, grupo ou equipe não pode receber acesso.',
                failed: 'Não foi possível atualizar o compartilhamento. Tente novamente.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "pt">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { pt: {
        linkToService: ({ service }) => `Associar a ${service}`,
        addHomeOrSignIn: 'Adicionar um Home ou iniciar sessão',
        usageNoAccounts: 'Ligue uma conta para ver quanto resta dos seus limites.',
        usageHealthy: 'Sobra bastante margem em todos os limites',
        homeUnreachableTitle: ({ home }) => `Não foi possível acessar ${home}`,
        homeUnreachableBody: 'Suas máquinas e sessões voltarão a aparecer aqui quando ele responder.',
        homeUnreachableLine: ({ home }) => `Não foi possível acessar ${home}.`,
        availableWhenHomeAnswers: "Disponível quando este Home responder.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 chave sem limites' : `${count} chaves sem limites`,
        usageSignedOut: 'Sessão encerrada',
        hideAccountIdentities: 'Ocultar e-mails e IDs das contas',
        accountIdentitiesHidden: 'E-mails e IDs ocultos · para transmissões e demos',
        usageThisSession: 'Esta sessão',
        usageAllAccounts: 'Todas as contas',
        usageMoreAccounts: ({ count }) => `mais ${count}`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} entra através de ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} entra com esta conta`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} usa o próprio login`,
        usagePoolFallback: 'o seu grupo',
        usageNextInOrder: ({ account }) => `Quando ${account} se esgotar, o próximo turno passa para a próxima conta na ordem`,
        usageNextMostLeft: ({ account }) => `Quando ${account} se esgotar, o próximo turno passa para a conta com mais margem`,
        usageNextStays: ({ pool, account }) => `${pool} fica em ${account} até você trocar`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "pt">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { pt: {
        stillWaiting: ({ seconds }) => `Ainda aguardando · ${seconds} s`,
        asOf: ({ time }) => `Às ${time}`,
        howItWorks: 'Como funciona',
        tryAgain: 'Tentar novamente',
        checkAgain: 'Verificar novamente',
        paneFailedTitle: 'Não foi possível mostrar este painel',
        paneFailedReason: 'Algo deu errado ao desenhá-lo. Sua sessão não foi afetada.',
        opening: ({ name }) => `Abrindo ${name}`,
        couldNotOpen: ({ name }) => `Não foi possível abrir ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "pt">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const portuguese: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: 'As sessões partilhadas com esta equipa.',
        },
        pages: {
            credentialCreate: 'Escolha o que partilhar, quem o pode usar e os seus limites.',
            credentialDetail: 'Quem pode usar esta credencial, como e quanto.',
            credentialEdit: 'Altere quem pode usar esta credencial, como e quanto.',
            credentialActivity: 'As alterações a esta credencial e quem as fez.',
            credentialUsage: 'Quanto esta credencial foi usada e por quem.',
            credentialExternalApi: 'Use esta credencial a partir de ferramentas fora do Happier.',
            identityProviderNew: 'Ligue um fornecedor de identidade com que os membros possam iniciar sessão.',
            identityProviderEdit: 'Altere como este fornecedor de identidade se liga.',
            githubApp: 'Uma GitHub App que esta equipa usa para aceder a repositórios.',
            githubAppEdit: 'Altere o registo desta GitHub App.',
            authentication: 'Como os membros iniciam sessão nesta equipa e quem ela admite.',
            credentials: 'As credenciais de fornecedor que esta equipa partilha com os membros.',
            directory: 'Grupos de pessoas que partilham sessões, acessos e credenciais num Home.',
            members: 'Quem está nesta equipa e o que cada pessoa pode fazer.',
            addMember: 'Adicione alguém que já tenha uma conta neste Home.',
            groups: 'Conjuntos de membros com nome para partilhar sessões e credenciais.',
            newGroup: 'Dê um nome ao grupo e escolha quem faz parte dele.',
            invitations: 'Os convites que permitem entrar nesta equipa e a quem se destinam.',
            newInvitation: 'Convide alguém para entrar nesta equipa.',
            settings: 'Nome, logótipo, predefinições das sessões e se a equipa está ativa.',
        },
        loading: 'A carregar a equipa…',
        title: 'Equipas',
        entrySubtitle: 'Crie equipas, faça a gestão de membros e grupos e convide pessoas.',
        entry: {
            heading: ({ team }: { team: string }) => `Continuar para ${team}`,
            onHome: ({ home }: { home: string }) => `em ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Inicie sessão através de ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `O início de sessão através de ${service} está indisponível`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Sessão iniciada em ${home} como ${account}`,
            unnamedAccount: 'Conta Happier',
            continueWith: ({ method }: { method: string }) => `Continuar com ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} não está disponível`,
            providerUnavailableDisabled: 'O administrador do seu Team desativou este início de sessão. Verifique mais tarde.',
            providerUnavailableSetupIncomplete: 'O administrador do seu Team ainda não terminou de configurar este início de sessão. Verifique mais tarde.',
            providerUnavailableUnavailable: 'Este Home não pode usar este início de sessão agora. Verifique mais tarde.',
            unknownTargetTitle: 'Este link não identifica o seu Home',
            unknownTargetBody: 'Este dispositivo não consegue saber a que Home pertence este link de início de sessão da equipa, por isso nada foi enviado. Peça de novo o link a quem gere a equipa.',
            ssoRequiredTitle: 'Este Team precisa de outro método de início de sessão',
            ssoRequiredBody: 'Tem sessão iniciada neste Home, mas este Team só aceita o método de início de sessão que exige. Inicie sessão novamente com esse método ou volte ao seu próprio trabalho.',
            invitationUnavailableTitle: 'Este convite não pode ser usado',
            invitationUnavailableBody: 'Pode ter expirado, ter sido revogado ou já ter sido usado. Iniciar sessão, por si só, não o junta ao Team.',
            wrongAccountTitle: 'Esta conta não pode usar este início de sessão',
            wrongAccountBody: 'A conta ou identidade com que iniciou sessão não é a que este Team espera. Inicie sessão com outra conta ou fornecedor, ou volte ao seu próprio trabalho.',
            notProvisionedTitle: 'Este Team ainda não o admitiu',
            notProvisionedBody: 'Iniciar sessão, por si só, não o junta a este Team. O administrador decide quem é admitido; peça-lhe acesso ou um convite e tente novamente.',
            directoryDelayedTitle: 'O seu acesso ainda está a caminho',
            directoryDelayedBody: 'Este Team recebe os seus membros de um diretório que ainda não entregou o seu acesso. Tente novamente mais tarde ou peça a um responsável do Team.',
            accessRemovedTitle: 'Este Team não está disponível para si',
            accessRemovedBody: 'O seu acesso pode ter sido removido, ou o Team está indisponível neste Home neste momento. Tudo o resto em que tem sessão iniciada continua igual.',
            providerChangedTitle: 'Este método de início de sessão mudou enquanto o usava',
            providerChangedBody: 'Um administrador atualizou este método de início de sessão durante o seu início de sessão. Nada foi alterado na sua conta. Recomece a partir da página do Team para ver os métodos atuais.',
            returnToTeamSignIn: 'Voltar ao início de sessão do Team',
            returnToHappier: 'Voltar ao Happier',
            signInToTeam: 'Entrar nesta equipe',
            readyStatus: 'Escolha como iniciar sessão para continuar.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Proprietário',
            admin: 'Administrador',
            member: 'Membro',
            guest: 'Convidado',
        },
        roleHelp: {
            owner: 'É proprietário da equipa, pode geri-la e mudar proprietários.',
            admin: 'Tem o acesso de Membro e pode gerir a equipa.',
            member: 'Recebe por predefinição o acesso concedido à equipa.',
            guest: 'Vê apenas as sessões e os recursos partilhados explicitamente com esta conta ou com um grupo a que pertence.',
        },
        status: {
            active: 'Ativo',
            suspended: 'Suspenso',
        },
        history: {
            label: 'Histórico de sessões',
            allExisting: 'Incluir as sessões já partilhadas com a equipa',
            fromMembership: 'Apenas as sessões partilhadas após a entrada',
            allExistingNamed: ({ name }) => `Incluir as sessões já partilhadas com ${name}`,
            fromMembershipNamed: ({ name }) => `Apenas as sessões partilhadas após a entrada em ${name}`,
            scopeNote: 'Aplica-se a sessões inteiras. Não revela apenas as mensagens criadas após a entrada.',
        },
        unavailable: {
            title: 'As equipas não estão disponíveis neste Home',
            disabled: 'Este Home tem as equipas desativadas.',
            updateRequired: 'Este Home precisa de uma atualização para usar equipas.',
            offline: 'Este Home está inacessível neste momento.',
            retry: 'Tentar novamente',
        },
        stale: {
            label: 'A mostrar os últimos dados conhecidos deste Home.',
        },
        errors: {
            generic: 'Não foi possível concluir. Nada foi alterado.',
            outcomeUnknown: 'O Home pode ter concluído esta alteração. Atualize a equipa antes de tentar novamente.',
            forbidden: 'Não tem permissão para esta alteração.',
            notFound: 'Esta equipa já não está disponível.',
            archived: 'Esta equipa está arquivada. Restaure-a para fazer alterações.',
            conflict: 'Outra pessoa alterou primeiro. Reveja os valores atuais e tente novamente.',
            offline: 'Este Home está inacessível, por isso a alteração não foi enviada.',
            invalidName: 'Introduza um nome entre 1 e 80 caracteres.',
            invalidDescription: 'Introduza uma descrição com 500 caracteres ou menos.',
        },
        directory: {
            loading: 'A carregar equipas…',
            chooseTeamToShare: 'Escolha a equipa com quem o partilhar.',
            noMatches: 'Nenhuma equipa corresponde',
            noLoadedMatches: 'Nenhuma equipa carregada corresponde',
            searchLoadedPlaceholder: 'Filtrar equipas carregadas',
            unreachableHomes: 'Sem resposta',
            searchPlaceholder: 'Pesquisar equipas',
            newTeam: 'Nova equipa',
            createDenied: ({ homes }: { homes: string }) => `Só os administradores de ${homes} podem criar equipas. Peça a um deles que crie uma equipa ou que o adicione a uma.`,
            createAdministered: ({ names }: { names: string }) => `As equipas neste Home são criadas pelos seus administradores. Peça a ${names} para criar uma equipa para si ou para permitir que todos criem equipas.`,
            createAdministeredUnnamed: 'As equipas neste Home são criadas pelos seus administradores. Peça a um deles para criar uma equipa para si ou para permitir que todos criem equipas.',
            createOff: 'A criação de equipas está desativada neste Home.',
            letEveryoneCreate: 'Permitir que todos criem equipas',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} e ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} e mais ${count}`,
            emptyTitle: 'Ainda não há equipas',
            emptyBody: 'Uma equipa dá a um grupo de pessoas um espaço comum para sessões, pessoas e acessos.',
            archivedSection: 'Equipas arquivadas',
            archivedEmpty: 'Sem equipas arquivadas',
            archivedEmptyBody: 'Arquivar uma equipa nas definições dela move-a para aqui. Os membros, grupos e histórico são mantidos.',
            showArchived: 'Mostrar arquivadas',
            hideArchived: 'Ocultar arquivadas',
            archivedBadge: 'Arquivada',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, em ${home}`,
            partialHomes: 'Não foi possível contactar alguns Homes, por isso faltam as respetivas equipas nesta lista.',
        },
        create: {
            loading: 'A verificar onde pode criar uma equipa…',
            discard: 'Descartar',
            detailsSection: 'Equipa',
            logoFailedBody: 'A equipa foi criada, mas o logótipo não foi publicado. Tente novamente ou continue sem ele.',
            title: 'Nova equipa',
            nameLabel: 'Nome',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Descrição',
            descriptionPlaceholder: 'Em que esta equipa trabalha',
            homeHelp: 'A equipa é criada neste Home e permanece nele.',
            duplicateNameNote: 'Duas equipas podem ter o mesmo nome. As ligações e os acessos usam sempre a própria equipa.',
            managedOnlyTitle: 'A criação de equipas é administrada neste Home',
            managedOnlyBody: 'Um administrador cria aqui as equipas e escolhe o primeiro proprietário.',
            initialOwnerLabel: 'Primeiro proprietário',
            initialOwnerPlaceholder: 'Pesquisar pessoas neste Home',
            initialOwnerHelp: 'Criar uma equipa para outra pessoa não o adiciona a ela.',
            initialOwnerRequired: 'Escolha o primeiro proprietário da equipa. Neste Home, um administrador indica quem é dono de uma nova equipa.',
            initialOwnerIneligible: 'Essa pessoa já não pode ser proprietária de uma equipa. Escolha outra pessoa.',
            submit: 'Criar equipa',
            submitting: 'A criar…',
            outcomeUnknown: 'Não foi possível confirmar se a equipa foi criada. Tente novamente para recuperar o mesmo pedido.',
        },
        tabs: {
            overview: 'Visão geral',
            sessions: 'Sessões',
            members: 'Membros',
            groups: 'Grupos',
            invitations: 'Convites',
            authentication: 'Autenticação',
            settings: 'Definições',
        },
        authentication: {
            policy: {
                admissionSection: 'Admissão',
                admissionHelp: 'Como as pessoas se tornam membros desta equipa.',
                admissionInviteOnly: 'Apenas por convite',
                admissionProvisioned: 'Aprovisionado por um diretório',
                admissionJit: 'Automaticamente no primeiro início de sessão',
                admissionUnavailable: 'Esta Home ainda não consegue aplicar esse modo de admissão, por isso nada mudou.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Esta Home não disponibilizou esse fornecedor de início de sessão às equipas. Um administrador da Home pode alterar isso.',
                    homePolicyProhibited: 'Um administrador da Home não permite este modo de admissão nesta Home.',
                    directorySourceRequired: 'Adicione primeiro um diretório a esta equipa. Este modo admite as pessoas que ele fornece.',
                    directoryProjectionRequired: 'O diretório desta equipa ainda não concluiu a primeira sincronização. Este modo fica disponível quando terminar.',
                    teamConnectionRequired: 'Adicione primeiro uma ligação de início de sessão a esta equipa. A admissão no primeiro início de sessão precisa de uma.',
                    teamConnectionUnavailable: 'Nenhuma ligação de início de sessão desta equipa está utilizável neste momento, por isso ninguém poderia ser admitido ao iniciar sessão.',
                },
                acceptedSection: 'Início de sessão aceite',
                acceptedHelp: 'Que início de sessão esta equipa aceita antes de permitir trabalho da equipa.',
                acceptedInherit: 'Usar a política da Home',
                acceptedRestricted: 'Apenas o início de sessão selecionado abaixo',
                connectionsSection: 'Ligações aceites',
                connectionsEmpty: 'Seleciona pelo menos uma ligação de início de sessão, ou usa a política da Home.',
                homeMethodRetained: 'Mantido da política guardada',
                repairRequired: 'A restrição de início de sessão guardada não pode ser lida',
                repairRequiredHelp: 'Não está a ser aplicada tal como escrita. Escolhe abaixo uma política para a substituir.',
                conflictBody: 'A política de início de sessão mudou nesta Home. Revê-a e volta a aplicar a tua alteração.',
                providerTestRequired: 'Testa esta ligação antes de a equipa a poder exigir.',
                unavailable: 'Esta Home não pode aceitar essa política de início de sessão.',
                approvalPending: 'À espera de aprovação',
                connectionOwnerTeam: "Ligação da equipa",
                connectionOwnerHome: "Método de início de sessão da Home",
            },
            subtitle: 'Como os membros da equipa comprovam a identidade.',
            memberSignIn: {
                section: 'Página de início de sessão para membros',
                open: 'Abrir a página de início de sessão para membros',
                copyLink: 'Copiar ligação',
                shareLink: 'Partilhar ligação',
                qrLabel: 'Código QR da ligação de início de sessão para membros',
                footer: 'Qualquer pessoa com esta ligação chega à página de início de sessão desta equipa. A ligação não concede nada por si só: a adesão continua a seguir a política de admissão da equipa.',
                unavailable: 'Sem ligação partilhável',
                unavailableBody: 'Este Home não publica qualquer endereço web, pelo que não existe uma ligação que funcione noutro dispositivo. Um administrador do Home pode configurar uma.',
            },
            connectionsSection: 'Ligações de início de sessão',
            empty: 'Sem ligações de início de sessão',
            status: {
                unavailable: 'Indisponível',
                prohibited: 'Bloqueada pela política do Home',
                notConfigured: 'Não configurada',
                settingUp: 'A configurar',
                connected: 'Ativa',
                needsAttention: 'Requer atenção',
                disabled: 'Desativada',
            },
            mode: {
                signInOnly: 'Apenas início de sessão',
                signInTimeGroups: 'Os grupos são atualizados ao iniciar sessão',
            },
            detail: {
                status: 'Estado',
                mode: 'Modo',
                provider: 'Fornecedor',
                restrictions: 'Restrições de início de sessão',
                allowedUsers: 'Utilizadores permitidos',
                allowedDomains: 'Domínios de e-mail permitidos',
                none: 'Nenhum',
                configuration: 'Configuração',
                organization: 'Organização',
                connection: 'Ligação',
            },
            directory: {
                actions: {
                    section: 'Ações', sync: 'Sincronizar agora', pause: 'Pausar sincronização', resume: 'Retomar sincronização', remove: 'Remover diretório…',
                    pauseTitle: ({ source }: { source: string }) => `Pausar ${source}?`, pauseBody: 'Novas alterações do diretório serão interrompidas. O acesso do Team e as contribuições de Grupos conhecidos ficam preservados até retomar.',
                    removeTitle: ({ source }: { source: string }) => `Remover ${source}?`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `${teamMembershipsRemoved} associações geridas, ${groupMembershipsRemoved} associações efetivas a Grupos e ${groupContributionsRemoved} contribuições da origem serão removidas. ${directoryCreatedGroupsRetained} Grupos criados pelo diretório, ${nativeMembershipsPreserved} associações nativas e ${nativeGroupContributionsPreserved} contribuições nativas serão preservados. Nenhum Account é eliminado.`,
                },
                section: "Associação gerida",
                overviewSubtitle: "As fontes de diretório mantêm os membros e grupos da Equipa alinhados com uma organização externa.",
                manageSubtitle: "Reveja as fontes de diretório ligadas e o respetivo estado de sincronização mais recente.",
                title: "Sincronização de diretório",
                sourcesSection: "Fontes de diretório",
                sourcesLoadMore: "Carregar mais fontes",
                subtitle: "As alterações de membros só são aplicadas a partir de projeções completas do servidor.",
                empty: "Sem fontes de diretório",
                setup: {
                    section: "Adicionar uma fonte",
                    add: "Escolher uma fonte de diretório",
                    options: "Configuração da fonte",
                    optionsFooter: "Escolha um diretório ou organização de provedor verificado e exato.",
                    loadMore: "Carregar mais",
                    empty: "Ainda não há opções de fontes verificadas",
                    workos: "Configurar a sincronização de diretório do WorkOS",
                    workosSubtitle: "Abra o portal de administração do WorkOS e volte para escolher o diretório verificado.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "O Happier começará a importar este diretório depois que você o adicionar.",
                },
                people: {
                    section: "Pessoas",
                    empty: "Nenhuma pessoa provisionada",
                    provisioned: "Provisionada · Ainda sem conta",
                    boundAccountCount: ({ count }: { count: number | string }) => `Contas vinculadas: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Pessoas provisionadas sem conta: ${count}`,
                    member: "Membro da equipe",
                    unknown: "Pessoa sem nome",
                    loadMore: "Carregar mais pessoas",
                    state: {
                        suspended: "Suspensa",
                        deleted: "Excluída",
                    },
                },
                kind: {
                    workos: "Sincronização de diretório WorkOS",
                    github: "Organização GitHub",
                },
                state: {
                    setup: "Configuração necessária",
                    syncing: "A sincronizar",
                    active: "Ativa",
                    paused: "Em pausa",
                    needsAttention: "Requer atenção",
                    initializing: "A configurar",
                    failed: "A última sincronização falhou",
                },
                mode: {
                    eventsAndFull: "Eventos e reconciliação completa",
                    fullOnly: "Apenas reconciliação completa",
                },
                freshness: {
                    never_synced: "Nunca sincronizada",
                    fresh: "Atualizada",
                    stale: "Desatualizada",
                    unknown: "Desconhecida",
                },
                detail: {
                    status: "Estado",
                    sourceType: "Tipo de fonte",
                    syncSection: "Estado da sincronização",
                    mode: "Modo de sincronização",
                    freshness: "Atualização",
                    lastSuccess: "Última sincronização bem-sucedida",
                    nextScheduled: "Próxima sincronização agendada",
                    attentionSection: "Atenção necessária",
                    attentionTitle: "Esta fonte de diretório requer atenção",
                    attentionRetryable: "A fonte pode recuperar depois de a ligação ser reparada. Atualize para verificar o estado mais recente.",
                    attentionAdmin: "Reveja a configuração da fonte antes de confiar em novas alterações do diretório.",
                },
                never: "Nunca",
                unknown: "Desconhecido",
            },
        },
        settings: {
            archiveDescription: 'Arquivar retira a equipa das vistas ativas e interrompe o acesso baseado na equipa. Os membros, grupos e histórico são mantidos, e pode ser restaurada.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Predefinições de sessão',
            externalSharingSection: 'Partilha externa',
            historyDefaultSection: 'Histórico predefinido',
            lifecycleSection: 'Ciclo de vida da equipa',
            saved: 'Guardado',
        },
        policy: {
            sessionCreationPrivate: 'Privada por predefinição',
            sessionCreationTeam: 'Partilhada com a equipa por predefinição',
            sessionCreationRequired: 'Sempre partilhada com a equipa',
            sessionCreationHelp: 'Aplica-se a novas sessões. As sessões privadas existentes não são expostas.',
            externalSharingAllowed: 'Qualquer pessoa que possa partilhar',
            externalSharingAdmins: 'Apenas administradores da equipa',
            externalSharingDisabled: 'Não permitido',
            externalSharingHelp: 'Pode bloquear partilhas futuras. Não retira as cópias já partilhadas.',
            historyDefaultHelp: 'Pré-seleciona a escolha para novos membros. Não reescreve o histórico dos membros existentes.',
        },
        logo: {
            add: 'Adicionar logo',
            replace: 'Substituir logo',
            remove: 'Remover logo',
            removeConfirmTitle: 'Remover este logo?',
            removeConfirmBody: 'A equipa voltará a mostrar o seu monograma. Pode carregar um novo logo quando quiser.',
            previewLabel: 'Pré-visualização do logo',
            useAsLogo: 'Usar como logo',
            monogramLabel: 'Monograma da equipa',
            tooLarge: 'Essa imagem é demasiado grande. Escolha uma mais pequena.',
            invalidFormat: ({ formats }: { formats: string }) => `Esse ficheiro não é uma imagem suportada. Formatos suportados: ${formats}.`,
            failed: 'O logo não foi carregado. O logo atual permanece inalterado.',
            retry: 'Tentar novamente',
        },
        archive: {
            openSettings: 'Abrir definições',
            action: ({ name }: { name: string }) => `Arquivar ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Arquivar ${name}?`,
            confirmBody: ({ name }: { name: string }) => `${name} sairá das vistas ativas. O acesso baseado na equipa e nos grupos será interrompido e as ligações de convite pendentes serão revogadas. As adesões, os grupos, as políticas e as autorizações existentes são mantidos. Restaurar ${name} pode tornar essas autorizações mantidas novamente efetivas.`,
            restoreAction: ({ name }: { name: string }) => `Restaurar ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Restaurar ${name}?`,
            restoreBody: () => 'As adesões, os grupos e as autorizações mantidos voltarão a estar ativos onde as contas e os recursos ainda o permitirem. As ligações de convite revogadas não voltarão.',
            readOnly: 'Esta equipa está arquivada. Restaure-a para fazer alterações.',
        },
        members: {
            membershipSection: 'Participação',
            filterLabel: 'Mostrar',
            searchPlaceholder: 'Pesquisar membros',
            filterAll: 'Todos',
            filterOwnersAndAdmins: 'Proprietários e administradores',
            filterMembers: 'Membros',
            filterGuests: 'Convidados',
            filterSuspended: 'Suspensos',
            emptyTitle: 'Nenhum membro corresponde',
            emptyBody: 'Ajuste o filtro ou convide alguém para esta equipa.',
            add: 'Adicionar membro',
            addTitle: ({ team }: { team: string }) => `Adicionar a ${team}`,
            personLabel: 'Pessoa',
            roleLabel: 'Função',
            personPlaceholder: 'Pesquisar pessoas neste Home',
            ineligible: 'Já está nesta equipa, ou não é uma conta ativa neste Home.',
            addSubmit: 'Adicionar membro',
            you: 'Você',
            joined: ({ when }: { when: string }) => `Entrou em ${when}`,
            managedBy: ({ source }: { source: string }) => `Gerido através de ${source}`,
            managedReadOnly: 'Esta adesão é gerida na origem. Altere-a aí.',
            detailManagedBy: 'Gerido por',
            managementTitle: 'Origem de gestão',
            managementHelp: 'Mudar a origem mantém esta adesão, o papel, o estado e o histórico de sessões. Só muda quem os pode alterar.',
            managementNative: 'Gerido no Happier',
            managementConflict: 'Essa origem ainda não tem uma identidade disponível para esta pessoa. Sincronize-a e tente de novo.',
            detailOpenSource: 'Abrir as definições da origem',
            encryption: {
                title: 'Acesso cifrado',
                checking: 'A verificar o acesso cifrado…',
                ready: 'Preparado',
                scopeBody: 'Isto inclui apenas as sessões que gere. Outros gestores de sessões poderão ainda ter de preparar o acesso.',
                pending: 'Por preparar',
                prepare: 'Preparar o acesso cifrado',
                preparing: ({ prepared }: { prepared: number }) => `A preparar o acesso cifrado · ${prepared} preparadas`,
                setupRequired: 'Configuração necessária',
                setupRequiredBody: 'Esta pessoa ainda não concluiu a configuração do acesso cifrado. Poderá preparar o histórico de sessões depois disso.',
                notEncrypted: 'Sem cifra',
                plainAccount: 'A conta desta pessoa não usa cifra ponta a ponta, por isso não há nada a preparar.',
                repairRequired: 'O acesso cifrado precisa de reparação',
                repairBody: 'Algumas sessões que gere não podem ser preparadas neste dispositivo. Abra-as para reparar o seu próprio acesso.',
                nonTransferableBody: 'Algumas sessões usam um formato de criptografia antigo que não pode ser partilhado com novos membros. Continuam legíveis para quem já tem acesso.',
                recipientChanged: 'A conta desta pessoa mudou. A recarregar antes de preparar outra vez.',
                retry: 'Tentar novamente',
                failed: 'A preparação parou antes de terminar. Tudo o que já estava preparado foi mantido.',
            },
            detailGroups: 'Grupos',
            detailGroupsEmpty: 'Sem grupos',
            suspend: 'Suspender membro',
            suspendTitle: ({ name }: { name: string }) => `Suspender ${name}?`,
            suspendBody: 'O acesso à equipa e aos grupos é interrompido de imediato. A pertença a grupos e as atribuições de recursos são mantidas, e a reativação restaura apenas o acesso que ainda for válido. A conta do Home e as outras equipas não são afetadas.',
            reactivate: 'Reativar membro',
            reactivateTitle: ({ name }: { name: string }) => `Reativar ${name}?`,
            reactivateBody: 'O acesso é retomado onde as adesões, os grupos e o estado da conta ainda o permitirem.',
            remove: 'Remover da equipa',
            removeTitle: ({ name }: { name: string }) => `Remover ${name}?`,
            removeBody: 'O acesso atual à equipa e aos grupos termina. As pertenças a grupos e as autorizações ligadas a esta adesão são removidas. A autoria anterior e os conteúdos já vistos não são apagados. Voltar mais tarde inicia uma nova adesão.',
            lastOwnerBlocked: 'Uma equipa mantém pelo menos um proprietário ativo. Escolha primeiro outro proprietário.',
            accountInactive: 'A conta desta pessoa não está ativa, por isso não pode ser adicionada nem tornada proprietária.',
            ownerOnlyAction: 'Só um proprietário da equipa pode alterar proprietários.',
            ownerRequiredTitle: 'É necessário um proprietário',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} precisa de um proprietário ativo para as alterações reservadas ao proprietário.`,
            chooseOwner: 'Escolher proprietário',
            ownerRequiredNoCandidate: 'Não há nenhum membro elegível. É preciso adicionar um membro existente ou combinar uma transferência de propriedade.',
        },
        groups: {
            detailsSection: 'Grupo',
            title: 'Grupos',
            emptyTitle: 'Ainda não há grupos',
            emptyBody: 'Um grupo é um conjunto simples de membros da equipa com quem pode partilhar de uma só vez.',
            emptyRosterTitle: 'Ainda não há membros neste grupo',
            noEligibleCandidatesTitle: 'Não há ninguém para adicionar',
            noEligibleCandidatesBody: 'Aqui aparecem os membros da equipa que ainda não estão neste grupo.',
            create: 'Novo grupo',
            nameLabel: 'Nome',
            namePlaceholder: 'Desenvolvimento',
            descriptionPlaceholder: 'Para que serve este grupo',
            submit: 'Criar grupo',
            nameTaken: 'Já existe um grupo com esse nome nesta equipa.',
            memberCount: ({ count }: { count: number }) => `${count} membros`,
            managedBy: ({ source }: { source: string }) => `Gerido por ${source}`,
            membersSection: 'Membros do grupo',
            addMember: 'Adicionar ao grupo',
            removeNative: 'Remover do grupo',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Remover ${name} do grupo ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} perde imediatamente o acesso que vem de ${group}. Continua na Team e pode voltar a adicioná-la a este grupo.`,
            externalOnlyTitle: 'Gerido na origem',
            externalOnlyBody: ({ source }: { source: string }) => `${source} continua a contribuir com esta pessoa, por isso ela permanece no grupo. Altere isso nas definições dessa origem.`,
            archiveAction: ({ name }: { name: string }) => `Arquivar ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Arquivar ${name}?`,
            archiveBody: 'O acesso baseado no grupo é interrompido de imediato. A pertença e o histórico são mantidos, e restaurar o grupo pode tornar essas autorizações novamente efetivas.',
            restoreAction: ({ name }: { name: string }) => `Restaurar ${name}`,
            archivedSection: 'Grupos arquivados',
            archivedReadOnly: 'Este grupo está arquivado. Restaure-o para fazer alterações.',
            managedReadOnly: 'O nome e o ciclo de vida deste grupo são geridos na origem. Ainda pode adicionar membros aqui.',
        },
        invitations: {
            emptyTitle: 'Sem convites',
            emptyBody: 'Convide alguém com uma ligação ou adicione uma pessoa que já tenha conta neste Home.',
            invite: 'Convidar',
            inviteTitle: ({ team }: { team: string }) => `Convidar para ${team}`,
            byLink: 'Ligação',
            byEmail: 'E-mail',
            emailLabel: 'Endereço de e-mail',
            emailPlaceholder: 'nome@exemplo.com',
            create: 'Criar convite',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Qualquer pessoa com sessão iniciada neste Home que tenha esta ligação pode juntar-se a ${team} como ${role}.`,
            copyLink: 'Copiar ligação',
            copied: 'Ligação copiada',
            qrLabel: 'Código QR desta ligação de convite',
            qrTooLargeFallback: 'Esta ligação é demasiado longa para um código QR. Copie-a em vez disso.',
            linkRow: 'Ligação de convite',
            maskedRecipient: ({ email }: { email: string }) => `Para ${email}`,
            expires: ({ when }: { when: string }) => `Expira a ${when}`,
            stateActive: 'Ativo',
            stateAccepted: 'Aceite',
            stateRevoked: 'Revogado',
            stateExpired: 'Expirado',
            deliverySent: 'E-mail submetido',
            deliveryFailed: 'Falha no envio do e-mail',
            deliveryUnknown: 'Resultado do envio desconhecido',
            deliveryRetry: 'Tentar novamente',
            deliveryChangeEmail: 'Alterar e-mail',
            emailUnavailable: 'O envio de e-mail está indisponível neste Home. Partilhe uma ligação em vez disso.',
            reissue: 'Criar uma nova ligação',
            reissueNotice: 'Reemitir cria uma nova ligação. A ligação anterior deixará de funcionar.',
            revoke: 'Revogar convite',
            revokeTitle: 'Revogar este convite?',
            revokeBody: 'A ligação deixa de funcionar de imediato. Pode criar uma nova quando quiser.',
            shareLink: 'Partilhar ligação',
            shareUnavailable: 'A partilha não está disponível neste dispositivo. Copie antes a ligação.',
            bearerUnavailable: 'Esta ligação foi mostrada uma única vez e não é guardada. Crie uma nova ligação para voltar a partilhar o acesso.',
            linkUnavailableRow: 'Sem ligação para partilhar',
            linkUnavailableBody: 'Este Home não publicou nenhum endereço para o qual as ligações de convite possam apontar, por isso não há ligação para partilhar. Peça a um administrador do Home que publique um, ou adicione pessoas a partir da lista Pessoas da Team.',
        },
        join: {
            previewLoading: 'A verificar este convite…',
            joinAction: ({ team }: { team: string }) => `Juntar-se a ${team}`,
            joinWithCurrentAccount: 'Entrar com esta conta',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} será adicionado a esta conta como endereço verificado.`,
            useAnotherAccount: 'Usar outra conta',
            useCurrentAccount: 'Usar a conta atual',
            useAnotherAccountHint: 'Inicie sessão neste Home sem terminar a sessão desta conta.',
            hostedOn: ({ home }: { home: string }) => `Alojado em ${home}`,
            personalHomeNotice: 'Este Home funciona num computador pessoal e pode estar indisponível enquanto estiver offline.',
            plainStorageNotice: 'As sessões deste Home são guardadas sem cifragem ponta a ponta.',
            invitedBy: ({ name }: { name: string }) => `Convite enviado por ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Foi convidado como ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Juntar-se como convidado não dá acesso às sessões de equipa de ${team}. Os itens têm de ser partilhados consigo ou com um dos seus grupos.`,
            joinedTitle: 'Você entrou',
            alreadyMemberTitle: 'Já é membro',
            openTeam: ({ team }: { team: string }) => `Abrir ${team}`,
            expiredTitle: 'Este convite expirou',
            revokedTitle: 'Este convite foi revogado',
            usedTitle: 'Este convite já foi utilizado',
            archivedTitle: 'Esta equipa está arquivada',
            inactiveTitle: 'Esta conta não pode juntar-se neste momento',
            invalidTitle: 'Esta ligação de convite não é válida',
            unresolvedHomeTitle: 'Este link não identifica o seu Home',
            unresolvedHomeBody: 'Este dispositivo não consegue saber qual Home emitiu este convite, por isso nada foi enviado. Peça um novo link a quem gere a equipa.',
            unknownHomeTitle: 'Este Home ainda não está neste dispositivo',
            askForNew: 'Peça um novo convite a um responsável da equipa.',
            mismatchTitle: 'Este convite é para outro endereço',
            signInWithInvited: 'Iniciar sessão com o endereço convidado',
            verifyAddress: 'Verificar este endereço',
            updateRequiredTitle: 'Este Home precisa de uma atualização para usar convites de equipa',
            offlineTitle: 'Este Home está inacessível',
            offlineBody: 'O convite é mantido. Tente novamente quando o Home voltar.',
            acceptanceOutcomeUnknown: 'Não foi possível confirmar se aderiu. Tente novamente para verificar o mesmo convite.',
            retry: 'Tentar novamente',
        },
        credentials: {
            recovery: {
                openSettings: 'Abrir defini\u00e7\u00f5es da credencial',
                selectBroker: 'Escolher uma localiza\u00e7\u00e3o de broker',
                ownerHandoff: 'Pe\u00e7a ao propriet\u00e1rio da fonte para reparar esta credencial',
                updateApp: 'Atualizar o Happier',
                chooseAnother: 'Escolher outra credencial',
            },
            requestPolicy: {
                title: 'Política de pedidos',
                subtitle: 'Limite o que se pode pedir a esta credencial.',
                summaryNone: 'Sem restrições',
                summaryActive: ({ count }: { count: number }) => `${count} restrições`,
                protocolsLabel: 'Formatos de pedido',
                protocolsAny: 'Todos os que a fonte suportar',
                modelsLabel: 'Modelos',
                modelsAny: 'Todos os modelos que a fonte oferece',
                modelsAllowed: ({ count }: { count: number }) => `${count} permitidos`,
                effortLabel: 'Esforço de raciocínio',
                effortAny: 'Todos os que a fonte suportar',
                catalogUnavailable: 'Escolher que modelos são permitidos ainda não está disponível a partir deste Home. As escolhas atuais mantêm-se até serem removidas.',
                clear: 'Remover todas as restrições',
                activeNote: 'Uma sessão que já está a decorrer não é reescrita. O próximo pedido dela terá de cumprir a nova política.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Preparação do acesso direto',
                check: 'Verificar preparação',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} prontos · ${pending} a preparar`,
                allReady: 'Todas as pessoas com acesso direto estão prontas.',
                automatic: 'O material é preparado no computador que detém esta fonte, assim que estiver online.',
                state: {
                    ready: 'Pronto',
                    preparing: 'A preparar o acesso',
                    notDelivered: 'Ainda não entregue',
                    recipientBindingChanged: 'À espera da configuração da conta cifrada',
                    sourceChanged: 'A fonte mudou — a atualizar',
                },
            },
            externalApi: {
                title: 'Acesso à API externa',
                subtitle: 'Use este fornecedor a partir de ferramentas compatíveis fora do Happier.',
                privateTitle: 'Sessões do Happier',
                privateDetail: 'Privado através do Happier',
                unavailable: 'O acesso à API externa não está disponível neste Home.',
                publicHttpsRequired: 'As ferramentas externas precisam de um endereço HTTPS público para este Home.',
                homeDisclosure: 'Os corpos brutos dos pedidos ao fornecedor passam pelo endpoint HTTPS público deste Home e podem ser lidos pelo seu operador.',
                bearerDisclosure: 'Esta chave é um segredo ao portador. Qualquer pessoa que a tenha pode usar o acesso atribuído até a chave expirar ou ser revogada.',
                usageDisclosure: 'O Happier regista o número de pedidos. Os totais de tokens e custos podem ficar incompletos quando um protocolo não os comunica.',
                keysTitle: 'Chaves de API',
                authorize: 'Autorizar chave',
                authenticationRequired: 'O membro atribuído precisa autorizar esta chave com o seu início de sessão da equipa.',
                authenticationUnavailable: 'A autenticação da equipa está indisponível. Peça a um administrador que verifique a política de início de sessão.',
                keysLoadFailed: 'Não foi possível carregar as chaves de API.',
                keysRetry: 'Tentar carregar as chaves novamente',
                keysEmpty: 'Ainda não há chaves',
                keysEmptyBody: 'Criar a primeira chave liga o acesso externo; revogar a última desliga-o.',
                labelPlaceholder: 'Para que serve esta chave',
                assignLabel: 'Atribuída a',
                revealTitle: 'Guarde esta chave agora',
                revealBody: 'Não voltará a ser mostrada.',
                revealDismiss: {
                    title: 'Fechar sem copiar a chave?',
                    body: 'Esta chave não poderá ser mostrada novamente. Mantenha-a visível até a guardar.',
                    confirm: 'Guardei a chave',
                    keepVisible: 'Manter a chave visível',
                },
                neverUsed: 'Nunca usada',
                lastUsed: ({ when }: { when: string }) => `Última utilização ${when}`,
                expiresOn: ({ when }: { when: string }) => `Expira ${when}`,
                expired: 'Expirada',
                revokeTitle: ({ name }: { name: string }) => `Revogar ${name}?`,
                revokeBody: 'As ferramentas que usam esta chave deixam de funcionar imediatamente. As sessões do Happier não são afetadas.',
                revokeAll: 'Revogar todas as chaves',
                revokeAllBody: 'O acesso à API externa desliga-se até ser criada uma nova chave. As sessões do Happier não são afetadas.',
            },
            title: 'Credenciais partilhadas',
            subtitle: 'Permita que esta equipa use uma conta ligada, um pool ou um fornecedor sem o copiar para a configura\u00e7\u00e3o de cada pessoa.',
            emptyTitle: 'Ainda sem credenciais partilhadas',
            emptyBody: 'Ainda nada foi partilhado com esta equipa.',
            forbidden: 'As credenciais partilhadas s\u00e3o geridas pelos propriet\u00e1rios e administradores desta equipa.',
            unavailable: 'Esta Home n\u00e3o oferece credenciais partilhadas.',
            approvalPending: 'Aguardando aprovação. As alterações são mantidas até a decisão.',
            approvalDeclined: 'Esse pedido não foi aprovado, então nada mudou.',
            sessionDeniedTitle: 'Uma credencial partilhada recusou este pedido',
            sharedByYou: 'Partilhada por si',
            providedByTeams: 'Fornecido pelas equipas',
            sharedWithYou: 'Partilhado consigo',
            sourceAdministration: { title: 'Partilhado com equipas', empty: 'Esta origem n\u00e3o \u00e9 partilhada com nenhuma equipa.' },
            source: {
                connectedAccount: 'Conta ligada',
                pool: 'Pool de serviços conectados',
                providerConnection: 'Liga\u00e7\u00e3o de fornecedor',
            },
            delivery: {
                brokered: 'Via intermedi\u00e1rio',
                direct: 'Acesso direto',
                both: 'Intermedi\u00e1rio + direto',
                mixed: 'Entrega mista',
            },
            state: {
                available: 'Dispon\u00edvel',
                needsAttention: 'Precisa de aten\u00e7\u00e3o',
                disabled: 'Desativada',
            },
            usePolicy: {
                title: 'Compartilhar esta sessão com a Equipa?',
                label: 'Onde os membros a podem usar',
                personalAllowed: 'Qualquer sess\u00e3o permitida',
                teamContextRequired: 'Sess\u00f5es cuja equipa \u00e9 esta',
                teamVisibilityRequired: 'Sess\u00f5es que esta equipa pode ver',
                visibilityNote: 'Escolher esta credencial pode partilhar uma sess\u00e3o privada com a equipa depois de a pessoa confirmar.',
            },
            selection: {
                activeTransitionUnsupported: 'Esta sessão começou a ser executada antes de a alteração ser guardada, por isso o modelo não mudou. Tente novamente.',
            },
            detail: {
                sourceLabel: 'Origem',
                brokerLabel: 'Localiza\u00e7\u00e3o do intermedi\u00e1rio',
                brokerNone: 'Escolher uma localização do intermediário',
                access: 'Acesso e entrega',
                activity: 'Atividade',
                edit: 'Editar',
                notFound: 'Esta credencial partilhada j\u00e1 n\u00e3o est\u00e1 dispon\u00edvel.',
                brokerUnnamedMachine: 'Computador sem nome',
                brokerUnnamedPool: 'Conjunto sem nome',
                brokerChosen: 'Escolhida por quem detém a fonte',
                limits: 'Limites',
                usage: 'Consumo',
            },
            create: {
                title: 'Partilhar uma credencial',
                action: 'Partilhar credencial',
                submit: 'Criar credencial partilhada',
                sourceChoose: 'Escolha uma fonte',
                sourceEmpty: 'Ainda não há nada para partilhar.',
                sourceUnsupported: 'As contas ligadas e as ligações de fornecedor ainda não podem ser partilhadas a partir deste Home.',
                alreadyShared: 'Já partilhada com esta equipa',
                poolAccounts: ({ count }: { count: number }) => `${count} contas`,
                notAllowed: 'Esta equipa não lhe permite oferecer uma credencial sua.',
                reviewLabel: 'Resumo',
            },
            edit: {
                title: 'Editar credencial partilhada',
                nameLabel: 'Nome',
                namePlaceholder: 'D\u00ea um nome a esta credencial',
                ceilingLabel: 'Divulga\u00e7\u00e3o direta',
                ceilingBrokeredOnly: 'Apenas via intermedi\u00e1rio',
                ceilingDirectAllowed: 'Permitir acesso direto',
                ceilingNote: 'O acesso direto permite que as ferramentas locais de quem recebe obtenham material de credencial. Remover o acesso p\u00e1ra entregas futuras, mas n\u00e3o apaga o que um processo externo j\u00e1 usou.',
                conflict: 'Estas defini\u00e7\u00f5es mudaram noutro lado. Recarregue para ver os valores atuais antes de guardar.',
            },
            audience: {
                title: 'Acesso e entrega',
                none: 'Ainda ningu\u00e9m',
                everyone: 'Toda a equipa',
                everyoneOff: 'Sem acesso para toda a equipa',
                groupCount: ({ count }: { count: number }) => `${count} grupos`,
                memberCount: ({ count }: { count: number }) => `${count} pessoas`,
                add: 'Adicionar um grupo ou uma pessoa',
                groupsSection: 'Grupos',
                membersSection: 'Pessoas',
                remove: 'Remover acesso',
                ceilingBlocked: 'O acesso direto n\u00e3o \u00e9 permitido para esta credencial. Permita-o primeiro em Editar.',
                directTitle: 'Partilhar esta credencial diretamente?',
                directBody: 'As ferramentas locais das pessoas que escolher podem receber material de credencial desta origem. Remover o acesso p\u00e1ra entregas futuras, mas n\u00e3o apaga o que um processo externo j\u00e1 usou.',
                directConfirm: 'Partilhar diretamente',
                keepBrokered: 'Manter via intermedi\u00e1rio',
                limitsNote: 'O uso direto acontece fora do Happier e n\u00e3o \u00e9 registado.',
            },
            directUse: {
                title: 'Usar diretamente esta credencial partilhada?',
                body: 'O Happier pode fornecer material da credencial \u00e0s ferramentas locais usadas por esta sess\u00e3o. Continue apenas se confiar nessas ferramentas com esta credencial.',
            },
            delete: {
                action: 'Eliminar credencial partilhada',
                title: ({ name }: { name: string }) => `Eliminar ${name}?`,
                body: 'Os membros perdem o acesso de imediato e o pedido seguinte falha. O material j\u00e1 entregue diretamente n\u00e3o pode ser apagado.',
            },
            errors: {
                featureDisabled: 'Este Home n\u00e3o oferece credenciais partilhadas.',
                teamAuthenticationRequired: 'Inicie sess\u00e3o nesta equipa antes de continuar.',
                teamAuthenticationPolicyUnavailable: 'N\u00e3o foi poss\u00edvel ler a pol\u00edtica de in\u00edcio de sess\u00e3o desta equipa, por isso nada foi alterado.',
                memberNotEligible: 'Esta pessoa n\u00e3o pode usar esta credencial.',
                sessionPolicyIncompatible: 'Esta credencial n\u00e3o pode ser usada nesta sess\u00e3o com a sua pol\u00edtica de partilha.',
                brokerUnavailable: 'A máquina intermediária desta credencial não está acessível agora. Tente de novo quando ela voltar ou escolha outro local.',
                sourceOwnerRequired: 'Só quem detém esta fonte pode fazer esta alteração.',
                sourceMissing: 'Esta credencial já não aponta para uma fonte existente. Quem a detém tem de escolher a fonte outra vez.',
                invalidAudience: 'Essas pessoas ou grupos não podem receber esta credencial.',
                subjectNotInTeam: 'Essa pessoa ou grupo já não está nesta equipa.',
                costUnavailable: 'Um limite de custo precisa de um preço para cada modelo permitido, e a alguns falta. Limite pedidos ou tokens em vez disso.',
                invalidLimit: 'Verifique a medida, o período e o máximo.',
                limitIdentityImmutable: 'A quem um limite se aplica, o que mede e o seu período não podem mudar. Remova-o e crie um novo.',
            },
            limits: {
                groupShared: 'Este valor \u00e9 partilhado por todos no Grupo.',
                title: 'Limites',
                empty: 'Ainda sem limites',
                emptyBody: 'Todos os pedidos são permitidos até adicionar um.',
                overshoot: 'Os novos pedidos param assim que o consumo registado atinge o limite. Os pedidos já em curso podem terminar.',
                directNote: 'Os limites cobrem o uso com intermediário e a API externa. O uso direto acontece na máquina de quem recebe e não é registado.',
                directOnly: 'Todas as pessoas com acesso usam esta credencial diretamente, na sua própria máquina, por isso o Happier não regista nada e nenhum limite se aplica.',
                requestLimitsOnlyForPersonalUse: 'Os limites de tokens aparecem quando esta credencial exige um contexto de equipa. O uso pessoal também a abre a execuções em segundo plano e à API externa, que só reportam pedidos, por isso só os limites de pedidos cobrem todo o uso.',
                add: 'Adicionar limite',
                subjectLabel: 'Aplica-se a',
                subject: {
                    resource: 'Toda a credencial partilhada',
                    eachMember: 'Cada pessoa em separado',
                    group: 'Grupo',
                    member: 'Pessoa',
                },
                metricLabel: 'Medida',
                metric: {
                    requests: 'Pedidos',
                    tokens: 'Tokens',
                    cost: 'Custo',
                },
                costNote: 'Um limite de custo só funciona se cada modelo permitido tiver um preço conhecido.',
                periodLabel: 'Período',
                period: {
                    day: 'Diário',
                    week: 'Semanal',
                    month: 'Mensal',
                },
                maximumLabel: 'Máximo',
                maximumPlaceholder: 'Máximo por período',
                maximumInvalid: 'Introduza um número inteiro maior do que zero.',
                maximumInvalidCost: 'Introduza um valor maior do que zero.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} de ${maximum} registado`,
                resetsUtc: ({ when }: { when: string }) => `Reinicia a ${when} UTC`,
                reached: 'Limite atingido',
                disabled: 'Desligado',
                remove: 'Remover limite',
                removeTitle: 'Remover este limite?',
                removeBody: 'Os pedidos deixam de ser verificados com ele de imediato. O consumo registado é mantido.',
                unknownSubject: 'Alguém fora desta página',
            },
            usage: {
                title: 'Consumo',
                empty: 'Nada registado neste período.',
                rangeLabel: 'Período',
                brokeredRequests: 'Pedidos intermediados',
                directOnlyRequests: 'Os pedidos só são contados no uso intermediado.',
                recordedRequests: 'Pedidos registados',
                requestIncomplete: 'Só estão incluídos os pedidos observados pelo Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'pedido externo ainda não tem' : 'pedidos externos ainda não têm'} um resultado registado.`,
                breakdownRestricted: 'Algumas divisões só são mostradas a quem gere credenciais.',
                export: 'Exportar CSV',
                exportFailed: 'Este dispositivo não conseguiu guardar a exportação.',
                recordedByHappier: 'Registado pelo Happier.',
                directIncomplete: 'O uso direto acontece fora do Happier e pode não estar incluído.',
                costIncomplete: 'O custo não está disponível para alguns modelos neste período.',
                tokenIncomplete: 'O total de tokens está incompleto para este período.',
                tokenUnavailable: 'Não foi observado uso de tokens neste período.',
                costUnavailable: 'Não foi observado uso com preço neste período.',
                costUnknown: 'Indisponível',
                breakdownLabel: 'Repartir por',
                breakdownNone: 'Apenas totais',
                breakdown: {
                    member: 'Pessoa',
                    externalApiKey: 'Chave de API externa',
                    model: 'Modelo',
                    session: 'Sessão',
                    sourceMember: 'Conta de origem',
                    workerMachine: 'Máquina de trabalho',
                    brokerMachine: 'Máquina intermediária',
                    deliveryMode: 'Entrega',
                },
                limitsTitle: 'Limites neste período',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} pedidos · ${tokens} tokens`,
            },
            activity: {
                title: 'Atividade',
                empty: 'Ainda sem altera\u00e7\u00f5es administrativas registadas.',
                unknownActor: 'Algu\u00e9m',
                kind: {
                    resourceCreated: 'Partilhou esta credencial',
                    resourceUpdated: 'Alterou as defini\u00e7\u00f5es',
                    audienceChanged: 'Alterou quem a pode usar',
                    resourceDeleted: 'Eliminou esta credencial',
                    directDelivered: 'Entregou acesso direto',
                    externalKeyCreated: 'Criou uma chave de API externa',
                    externalKeyRevoked: 'Revogou uma chave de API externa',
                    limitsChanged: 'Alterou os limites',
                },
            },
        },
    },
};

const teamsTranslations = { pt: portuguese };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { pt: en };

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

const pt: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Conectar este computador ao ${home}?`,
        body: ({ home }: HomeParams) => `${home} poderá iniciar sessões neste computador. O Home do terminal e as outras conexões permanecem.`,
        connect: 'Conectar',
        keep: 'Manter as conexões atuais',
    },
    setupAlreadyRunning: 'Já está em curso uma configuração. Aguarde até terminar.',
    title: {
        daemon_url_mismatch: 'O serviço em segundo plano está em outro Home',
        daemon_account_mismatch: 'O serviço em segundo plano usa outra conta',
        daemon_needs_auth: 'O serviço em segundo plano precisa entrar',
        daemon_not_configured: 'O serviço em segundo plano ainda não está conectado',
        daemon_not_installed: 'O serviço em segundo plano não está instalado',
        daemon_not_running: 'O serviço em segundo plano está parado',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Ele está conectado a ${daemonHome}, não a ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Ele entrou em ${home} como ${daemonAccount}, não como ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Ele está conectado a ${home}, mas ainda não foi aprovado.`,
        daemon_not_configured: ({ home }: HomeParams) => `Ele ainda não terminou de se conectar a ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Instale-o para conectar este computador a ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Inicie-o para se reconectar a ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Conectar a este Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Mudar para ${appAccount}`,
        daemon_needs_auth: 'Entrar',
        daemon_not_configured: 'Conectar a este Home',
        daemon_not_installed: 'Instalar serviço em segundo plano',
        daemon_not_running: 'Iniciar serviço em segundo plano',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Conectado a ${home} como ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} ainda não tem computadores em ${home}.`,
    openThisComputer: 'Revisar este computador',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Mudar este computador para ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `O serviço em segundo plano dele entrou em ${daemonHome} como ${daemonAccount}. Depois da mudança, ele trabalha para ${appAccount} em ${home}, e ${daemonAccount} deixa de ver este computador.`,
        confirm: 'Mudar',
    },
    cli: {
        title: 'CLI do Happier',
        version: ({ version }: { version: string }) => `Versão ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Versão ${version} · ${latestVersion} disponível`,
        update: 'Atualizar',
        progressTitle: 'Atualizando a CLI do Happier',
        notManaged: ({ origin }: { origin: string }) => `Instalada fora do Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `A CLI do Happier ${version} já está instalada`,
        titleUnknownVersion: 'A CLI do Happier já está instalada',
        titleMissing: 'Sua CLI do Happier não está mais instalada',
        body: ({ path }: { path: string }) => `Ela está em ${path}. O Happier pode instalar a própria cópia, mantê-la atualizada e colocá-la primeiro no seu PATH, ou você pode continuar usando esta.`,
        bodyOutdated: ({ path }: { path: string }) => `Ela está em ${path} e é antiga demais para a configuração. O Happier pode instalar a própria cópia atualizada e colocá-la primeiro no seu PATH, ou você pode manter a sua e atualizá-la você mesmo.`,
        bodyMissing: ({ path }: { path: string }) => `Você escolheu manter a que estava em ${path}, e ela não está mais lá. O Happier pode instalar a própria cópia e mantê-la atualizada, ou você pode reinstalar a sua e continuar usando-a.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Ela está em ${path}, mas novos terminais executam primeiro a CLI do Happier por meio de ${link}, que o Happier não adicionou. Deixe o Happier gerenciar a linha de comando, ou remova ${link} e execute a configuração de novo para manter a sua.`,
        notNow: 'Agora não',
        manage: 'Deixar o Happier gerenciar',
        keep: 'Manter a minha',
        unanswered: 'A configuração parou antes de alterar qualquer coisa. Escolha quem gerencia a linha de comando para continuar.',
        ownMissing: 'A linha de comando que você manteve não está mais instalada. Reinstale-a ou deixe o Happier gerenciar a linha de comando.',
        managed: 'Gerenciada pelo Happier',
        own: ({ path }: { path: string }) => `A sua — ${path}`,
        change: 'Mudar quem gerencia a linha de comando',
        keptUpdateTitle: 'Atualize sua linha de comando',
        keptUpdate: ({ command }: { command: string }) => `Há uma versão mais recente. Atualize-a com ${command}`,
        oldCopyTitle: 'Linha de comando antiga',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Ainda instalada em ${path}. Remova-a com ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Ainda instalada em ${path}.`,
    },
    servers: {
        title: 'Homes atendidos por este computador',
        connected: 'Conectado',
        offline: 'Configurado · Desligado',
        attention: 'Precisa de atenção',
        currentHome: ({ home }: HomeParams) => `${home} · este Home`,
    },
    removal: {
        uninstallFailedTitle: 'Não foi possível desligar este computador',
        uninstallFailedBody: ({ home }: HomeParams) => `Não foi possível remover o serviço em segundo plano deste computador para ${home}, por isso ${home} foi mantido. Tente novamente ou remova o serviço em Definições › Este computador.`,
        inventoryUnavailableTitle: 'Não foi possível verificar este computador',
        inventoryUnavailableBody: ({ home }: HomeParams) => `O Happier não conseguiu ler os serviços em segundo plano deste computador, por isso não sabe se este computador ainda serve ${home}. Remover do Happier mesmo assim?`,
        removeAnyway: 'Remover mesmo assim',
        userOwnedTitle: 'Este computador continua a servi-lo',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} foi instalado fora do Happier, por isso continua a funcionar para ${home}. Remova-o a partir do terminal se já não precisar dele.`,
    },
};

const thisComputerConnectionTranslations = { pt };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { pt: { searchOlder: 'Pesquisar mensagens anteriores', partialErrors: 'Não foi possível pesquisar parte do conteúdo. Os resultados estão incompletos.', olderRemaining: 'Ainda há mensagens anteriores não pesquisadas.', findOpen: 'Abrir pesquisa', findNext: 'Próxima correspondência', findPrevious: 'Correspondência anterior' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { pt: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'arquivo editado' : 'arquivos editados'}`,
                walkThrough: 'Explique para mim',
                openInFiles: 'Abrir em Arquivos',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'} em ${folders} pastas`,
                showMore: ({ count }) => `Mostrar mais ${count}`,
                groupA11y: 'Alterações neste turno',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { pt: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Gravar áudio de voz neste dispositivo?',
    consentBody: 'O áudio de voz pode conter conversas privadas e sons de fundo. Os ficheiros permanecem no dispositivo, usam permissões privadas, expiram automaticamente e nunca são sincronizados nem anexados a análises ou relatórios de falhas.',
    consentAction: 'Ativar gravação',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { pt: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["pt"].diagnostics, {
    title: 'Diagnósticos de voz locais',
    footer: 'Desativado por predefinição. O áudio permanece na máquina selecionada até que o exporte explicitamente.',
    enabled: 'Gravar áudio de diagnóstico local',
    enabledSubtitle: 'Mantém localmente entradas de STT e saídas de TTS limitadas para resolução de problemas',
    sttInput: 'Gravar a entrada de reconhecimento de voz',
    ttsOutput: 'Gravar a voz sintetizada',
    location: 'Localização de armazenamento',
    unavailable: 'Máquina selecionada indisponível',
    retention: 'Limites de retenção',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} horas · ${files} ficheiros · ${megabytes} MB`,
    deleteAll: 'Eliminar todo o áudio de diagnóstico',
    deleteAllSubtitle: 'Remove imediatamente o áudio e os metadados da máquina selecionada',
    deleteConfirmTitle: 'Eliminar todos os diagnósticos de voz locais?',
    deleteConfirmBody: 'Isto remove permanentemente todos os artefactos de diagnóstico de voz na máquina selecionada.',
    deleteAction: 'Eliminar tudo',
    deleteFailed: 'Não foi possível eliminar as gravações de diagnóstico locais. Podem continuar na máquina selecionada.',
    cleanupRequired: 'A limpeza de diagnósticos locais precisa de atenção',
    cleanupRequiredSubtitle: 'Podem ter ficado ficheiros de diagnóstico privados ou não foi possível ler o catálogo local. Repita a limpeza ou elimine todo o áudio de diagnóstico.',
    captureFailed: 'A captura de diagnóstico precisa de atenção',
    captureFailedSubtitle: 'Não foi possível ler nem guardar a última captura de áudio de diagnóstico. Não foi detetado nenhum ficheiro de diagnóstico remanescente; a próxima captura de voz elegível volta a verificar o estado.',
    retryCleanup: 'Repetir a limpeza de diagnósticos',
    retryCleanupSubtitle: 'Verifica novamente o armazenamento privado e reaplica os respetivos limites de retenção',
    cleanupRetryFailed: 'Não foi possível concluir a limpeza. Podem continuar ficheiros de diagnóstico na máquina selecionada; tente novamente ou elimine tudo depois de ela voltar a ligar-se.',
    exportTitle: 'Exportar os diagnósticos selecionados',
    noArtifacts: 'Não há gravações de diagnóstico guardadas na máquina selecionada.',
    exportSttArtifact: 'Exportar a entrada de reconhecimento de voz',
    exportTtsArtifact: 'Exportar a voz sintetizada',
    exportArtifactAccessibility: 'Exportar esta gravação de diagnóstico de voz local',
    exportConfirmTitle: 'Exportar esta gravação privada?',
    exportConfirmBody: 'Isto copia a gravação selecionada da máquina selecionada para este dispositivo através de uma transferência encriptada de uso único. Nunca é carregada automaticamente.',
    exportAction: 'Exportar gravação',
    exportFailed: 'Não foi possível exportar a gravação privada. Nada foi carregado.',
    backupPolicy: 'Exclusão de cópias de segurança',
    backupPolicyBestEffort: 'Guardado na cache privada da máquina selecionada e marcado para as ferramentas de cópia de segurança que respeitam o padrão de diretório de cache. Não está implementado qualquer carregamento ou sincronização automática; a exclusão das cópias de segurança do sistema operativo não é garantida.',
    activeIndicator: 'Diagnósticos de voz ativados',
    checkingIndicator: 'A verificar o estado dos diagnósticos de voz',
    statusUnknownIndicator: 'O estado dos diagnósticos de voz é desconhecido',
    shutdownPendingIndicator: 'A parar os diagnósticos de voz',
    shutdownFailedIndicator: 'Não foi possível confirmar que os diagnósticos de voz estão desativados',
    retryShutdown: 'Repetir a paragem dos diagnósticos',
    sessionOptOut: 'Não gravar esta sessão',
    sessionOptOutConfirmTitle: 'Parar a gravação desta sessão?',
    sessionOptOutConfirmBody: 'Os diagnósticos de voz continuam ativados para outras sessões, mas não será gravado novo áudio desta sessão até a app reiniciar.',
    sessionOptOutFailed: 'Não foi possível parar a gravação na máquina ativa. Esta sessão pode continuar a ser gravada; tente novamente depois de a máquina voltar a ligar-se.',
    sessionOptOutRetry: 'Repetir a paragem da gravação',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { pt: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Reveja o acesso às credenciais',
    recipientApprovalTitle: 'Permitir que este fornecedor utilize a sua credencial?',
    recipientApprovalBody: 'Reveja e aprove os endpoints e as operações declarados do fornecedor. Se esse contrato do destinatário mudar, o Happier mantém a sua seleção mas bloqueia o uso da credencial até que a aprove novamente.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pacote: ${title} (${pluginId}); origem: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Assinatura do pacote: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribuição: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operações declaradas:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operação ${id}: finalidade ${purpose}; efeito ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Pedido: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Cabeçalho da credencial: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limites de bytes: pedido ${requestMaxBytes}; resposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrado', verified: 'verificado' },
    recipientApprovalEffect: { read: 'leitura', mutation: 'alteração' },
    recipientApprovalCredentialFormat: { raw: 'em bruto', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprovar e guardar',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { pt: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Guardada na sua conta',
      notSetOnAccount: 'Não guardada na sua conta',
      setOnMachineOverride: ({ machine }) => `Está a ser usada uma substituição de credencial da conta para ${machine}`,
      notSetWithFallback: ({ machine }) => `Não definida para ${machine}; será usada uma credencial da conta quando estiver disponível`,
      plainStorageTitle: 'Guardar a chave de API sem encriptação ponta a ponta?',
      plainStorageBody: 'Esta conta guarda as definições sem encriptação ponta a ponta. Ao guardar esta chave de API, o seu texto simples fica visível para o servidor.',
      plainStorageConfirm: 'Guardar chave de API',
      deleteAccountBody: 'Remover esta chave de API guardada? As outras associações que referenciam o mesmo segredo guardado mantêm-na.',
      machineUnavailable: 'Selecione uma máquina de execução de voz online',
      machineUnavailableTitle: 'Máquina de voz indisponível',
      machineUnavailableBody: 'Escolha uma máquina de execução de voz online antes de guardar ou usar esta credencial.',
      statusUnavailable: ({ machine }) => `Estado da credencial indisponível em ${machine}. Toque para tentar de novo.`,
      importAvailable: ({ machine }) => `Há uma chave anterior disponível para importar para ${machine}`,
      notSetOnMachine: ({ machine }) => `Não definida em ${machine}`,
      setOnMachine: ({ machine, protection }) => `Definida em ${machine} · ${protection}`,
      protection: { osProtected: 'Protegida pelo sistema operativo', filePermissions: 'Protegida por permissões de ficheiro' },
      importTitle: 'Importar a chave de API existente?',
      importBody: ({ machine }) => `Copia a definição de conta encriptada existente para ${machine}. O original continua disponível para os seus outros dispositivos.`,
      importAction: 'Importar',
      enterNewAction: 'Introduzir nova',
      useSavedSecretTitle: 'Usar um segredo guardado',
      useSavedSecretSubtitle: 'Escolha uma chave já armazenada nesta conta.',
      replaceOrRemoveBody: 'Introduza uma nova chave de API ou deixe em branco para remover a chave desta máquina.',
      deleteTitle: 'Remover a chave de API?',
      deleteBody: ({ machine }) => `Remover esta chave de API de ${machine}? O antigo valor partilhado entre dispositivos, se existir, não é alterado.`,
      operationFailed: 'A máquina selecionada não conseguiu atualizar esta credencial. Verifique se está online e tente novamente.',
      newCredentialRequired: ({ machine }) => `É necessária uma nova credencial de máquina em ${machine}`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Os pedidos são executados em ${machine}. Localhost refere-se a essa máquina.`,
      insecureTitle: 'Permitir HTTP local não seguro?',
      insecureBody: ({ origin, machine }) => `Permitir o envio de credenciais por HTTP para ${origin} a partir de ${machine}? Localhost refere-se a ${machine}. Só são aceites endereços de loopback e de rede privada; o HTTP público é rejeitado.`,
      allowAction: 'Permitir HTTP',
      invalidBody: 'Introduza um URL HTTPS, ou um URL HTTP de loopback ou de rede privada sem nome de utilizador, palavra-passe ou cadeia de consulta.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { pt: {
        setupTitle: 'Configurar voz',
        setupTileSubtitle: 'Fale em voz alta com suas sessões. Quatro passos curtos.',
        setupTileProgress: ({ done, total, next }) => `${done} de ${total} prontos · ${next}`,
        setupNextService: 'agora escolha quem ouve',
        setupNextReadiness: 'agora conclua o serviço',
        setupNextMicrophone: 'agora permita o microfone',
        setupNextTry: 'agora experimente',
        setupNextInstalling: 'instalando',
        setupStart: 'Configurar',
        setupContinue: 'Continuar',
        setupDescription: 'Fale em voz alta com suas sessões: pergunte o que está acontecendo, comece trabalho, decida de qualquer lugar. Quatro passos; você pode sair e voltar.',
        setupLightCaption: ({ done, total }) => `${done} de ${total} prontos`,
        setupServiceTitle: 'Escolha quem ouve',
        setupServiceDetail: 'O que ouve você e responde. Você pode mudar depois.',
        setupChange: 'Alterar',
        setupReadinessTitle: ({ service }) => `Conclua a configuração de ${service}`,
        setupReadinessDone: ({ service }) => `${service} está pronto`,
        setupReadinessGeneric: 'O serviço',
        setupReadinessTitleGeneric: 'Prepare o serviço',
        setupReadinessUnknown: 'Abra as configurações para ver o que ainda falta.',
        setupReadinessCheck: 'Verificar configuração',
        setupMicrophoneTitle: 'Permita o microfone',
        setupMicrophoneDetail: 'Seu dispositivo pergunta uma vez. O Happier só ouve enquanto a voz está ligada, e você sempre consegue ver quando.',
        setupMicrophoneAction: 'Permitir microfone',
        setupMicrophoneDone: 'Microfone permitido',
        setupMicrophoneDeniedTitle: 'O microfone está desativado para o Happier',
        setupMicrophoneDeniedDetail: 'Ative nas configurações do sistema e volte aqui.',
        setupOpenSystemSettings: 'Abrir configurações',
        setupTryTitle: 'Experimente',
        setupTryDetail: 'Pergunte “O que minhas sessões estão fazendo?”. Suas palavras entram na conversa como qualquer mensagem.',
        setupTryAction: 'Experimentar',
        setupTryDone: 'Experimentado',
        setupTryNeedsService: 'Disponível quando o serviço estiver pronto.',
        setupDoneTitle: 'A voz está pronta',
        setupDoneBody: 'Toque o botão de voz em qualquer chat para começar a falar e toque de novo para terminar. Silenciar fica ao lado de Encerrar enquanto você fala.',
        setupGestureTap: 'Toque',
        setupGestureStartEnd: 'iniciar · encerrar',
        setupGestureAnywhere: 'iniciar · encerrar em qualquer lugar',
        setupDoneAction: 'Concluído',
        setupSettingsAction: 'Configurações de voz',
        setupClose: 'Fechar',
        needsYouEnded: 'A voz terminou. A aprovação ainda aguarda na Caixa de entrada.',
        needsYouReview: 'Revisar solicitação',
        needsYouTapToDecide: 'Lido em voz alta · decida aqui, não por voz',
        briefMe: 'Me atualize',
        briefMeA11y: 'Me atualize: a voz lê o que precisa de você, o que falhou e o que está pronto',
        briefNeedsYou: 'Precisa de você',
        briefFailed: 'Falhou',
        briefReady: 'Pronto',
        briefIncomplete: 'Parte do trabalho ainda não carregou, então pode não ser tudo.',
        briefCaughtUp: 'Nada precisa de você agora.',
        briefNotSpoken: 'A voz não pode ler isso agora. A lista está toda aqui.',
        briefStop: 'Parar',
        continueTitle: 'Continuar falando aqui',
        continueDetail: ({ device }) => `Você estava falando no ${device}`,
        continueAction: 'Continuar',
        continuedOn: ({ device }) => `Continuou no ${device}`,
        continuedElsewhere: 'Continuou em outro dispositivo',
        continuedHere: 'Continuou neste dispositivo',
        dismiss: 'Dispensar',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "pt">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { pt: {
        welcomeText: "Olá, estou ouvindo — o que você gostaria de fazer?",
        customVoice: 'Voz personalizada',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `Olá, você está falando com ${name} — o que gostaria de fazer?`,
        greetingLiteralUnavailable: "Neste idioma de resposta, o serviço espera você falar.",
        title: 'Voz',
        howYouTalk: "Como você fala",
        holdToTalkTitle: "Segurar para falar",
        holdToTalkDescription: "Segure a marca do Voice para dizer algo; solte para enviar. Tocar continua iniciando e encerrando o Voice.",
        holdToTalkHint: "Segure por um turno; solte para enviar. Arraste para cancelar.",
        holdToTalkUnavailable: ({ service }) => `${service} não permite segurar para falar. Toque para falar.`,
        talkWithVoice: 'Falar com a Voz',
        dictate: 'Ditar',
        globalVoice: 'Voz global',
        interrupt: 'Interromper',
        options: 'Opções de Voz',
        you: 'Você',
        showConversation: 'Mostrar a conversa',
        dragToMove: 'Arraste para mover',
        openConversation: 'Abrir a conversa',
        settings: 'Ajustes de Voz',
        ended: 'Voz encerrada',
        muted: 'Silenciado',
        setUp: 'Configurar Voz',
        setUpHint: 'Abre as configurações de Voz para escolher como ela fala',
        startAgain: 'Começar de novo',
        endedCaption: ({ elapsed }) => `${elapsed} · a conversa foi salva`,
        dismiss: 'Dispensar',
        mute: "Silenciar",
        unmute: "Ativar som",
        end: "Encerrar",
        captions: { connecting: "Abrindo o canal de áudio", listening: "Pode falar", transcribing: "Transformando em texto", thinking: "Preparando uma resposta", speaking: "Você pode interromper a qualquer momento", interrupted: "Pode falar", muted: "Ative o som para falar · a Voz ainda pode falar", reconnecting: "Conexão perdida · tentando de novo", blocked: "Permita o acesso ao microfone para falar", failed: "Tente de novo ou confira os ajustes da Voz" },
        recovery: { allow: "Permitir", setUp: "Configurar" },
        containerA11y: ({ status }) => `Voz, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "pt">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { pt: {
    openai: {
      privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a OpenAI por WebRTC. Quando as funcionalidades correspondentes estão ativas ou são usadas, a OpenAI também pode receber deste dispositivo atualizações limitadas do contexto de Voice, chamadas a ferramentas do cliente e os respetivos resultados. O Happier usa a chave de Voice API guardada, o Serviço ligado da OpenAI ou a conta experimental Codex OAuth selecionados para obter autenticação de cliente de curta duração; as contas ligadas são usadas através da máquina selecionada. A OpenAI processa a conversa na conta selecionada e pode reter os dados recebidos segundo as definições dessa conta e os termos da OpenAI. O servidor e o relay do Happier não transportam o áudio em direto. Os controlos de partilha de contexto do Voice são separados deste processamento pelo fornecedor.',
    },
    xai: {
      privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a xAI pela ligação xAI Realtime. Quando as funcionalidades correspondentes estão ativas ou são usadas, a xAI também pode receber deste dispositivo atualizações limitadas do contexto de Voice, chamadas a ferramentas do cliente e os respetivos resultados. O Happier usa a chave API da xAI guardada nos segredos da sua conta Happier apenas para as operações limitadas de autenticação do cliente e catálogo de vozes. A xAI processa a conversa nessa conta e pode reter os dados recebidos segundo as definições da conta e os termos da xAI. Se a retoma estiver ativa, o Happier guarda o identificador da conversa do fornecedor; esquecê-lo remove o identificador guardado pelo Happier e não elimina os dados retidos pela xAI. O servidor e o relay do Happier não transportam o áudio em direto. Os controlos de partilha de contexto do Voice são separados deste processamento pelo fornecedor.',
    },
    speechProcessing: {
      deviceStt: 'O áudio é processado pelo serviço de reconhecimento de voz do browser ou do sistema operativo. Consoante a plataforma e o serviço configurado, o processamento pode ocorrer fora do dispositivo.',
      deviceTts: 'O texto da resposta é processado pelo serviço de síntese de voz do browser ou do sistema operativo. Consoante a plataforma e o serviço configurado, o processamento pode ocorrer fora do dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Guardar o identificador de retoma da xAI',
        subtitle: 'Permita que o Happier guarde o identificador temporário da conversa da xAI para restabelecer a ligação.',
      },
    },
    resumption: {
      confirmTitle: 'Guardar o identificador de retoma da xAI?',
      confirmBody: 'O Happier guardará o identificador da conversa da xAI durante até {minutes} minutos para poder restabelecer uma conversa interrompida. Isto não altera nem elimina os dados retidos pela xAI.',
      confirmAction: 'Guardar identificador',
      forgetTitle: 'Esquecer o identificador de retoma do Happier',
      forgetSubtitle: 'Remove o identificador da conversa do fornecedor guardado pelo Happier. Isto não elimina a conversa nem os dados retidos pela xAI.',
      forgotten: 'O Happier removeu o identificador da conversa do fornecedor guardado.',
      unsupported: 'O Happier não pode remover desta sessão o identificador da conversa do fornecedor guardado.',
      failed: 'O Happier não conseguiu remover o identificador da conversa do fornecedor guardado. Tente novamente.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { pt: defineVoiceReadinessTranslation({
    ready: 'A função de Voz está pronta.',
    permissionAnnouncement: ({ summary }) => `A sessão de código precisa de permissão para ${summary}. Revê-a na interface da sessão para aprovar ou recusar.`,
    userActionAnnouncement: ({ question }) => `A sessão de código precisa da tua resposta. ${question}`,
    userActionFallback: 'A sessão de código precisa da tua resposta. Responde à pergunta para eu poder continuar.',
    requestedTool: 'a ferramenta pedida',
    provider_unselected: 'Escolha um provedor de Voz.',
    contribution_unavailable: 'Este provedor de Voz não está mais disponível.',
    role_unsupported: 'Este provedor não é compatível com o modo de Voz selecionado.',
    platform_unsupported: 'Este provedor de Voz não está disponível nesta plataforma.',
    settings_unsupported_version: 'Atualize este provedor antes de usá-lo com a função de Voz.',
    settings_unknown: 'Não foi possível verificar as configurações do provedor.',
    settings_needs_migration: 'Revise as configurações atualizadas do provedor.',
    settings_invalid: 'Revise as configurações inválidas do provedor.',
    settings_missing_required_setting: ({ service }) => `Termine de configurar ${service} para começar.`,
    provider_mode_unknown: 'Escolha um modo compatível com este provedor.',
    server_feature_disabled: 'O servidor desativou este provedor de Voz.',
    server_feature_installing: 'O servidor está preparando o suporte à função de Voz.',
    server_feature_incompatible: 'O servidor não é compatível com este provedor de Voz.',
    server_feature_unknown: 'Não foi possível verificar se o servidor é compatível com este provedor de Voz.',
    execution_machine_missing: 'Escolha uma máquina que possa executar este provedor de Voz.',
    execution_machine_installing: 'A máquina de execução de Voz selecionada ainda está sendo preparada.',
    execution_machine_incompatible: 'A máquina selecionada não é compatível com este provedor de Voz.',
    execution_machine_unknown: 'Não foi possível verificar a máquina de execução de Voz.',
    daemon_unreachable: 'A máquina selecionada não tem uma rota disponível para o áudio de Voz.',
    daemon_relay_disabled: 'A máquina selecionada precisa do retransmissor de áudio de Voz, mas seu uso está desativado.',
    daemon_relay_capped: 'A capacidade do retransmissor de áudio de Voz está indisponível para a máquina selecionada no momento.',
    credential_missing: 'Adicione a credencial exigida por este provedor de Voz.',
    credential_approval_required: 'Revise o acesso à credencial antes de usar este provedor de Voz.',
    credential_installing: 'A credencial do provedor ainda está sendo preparada.',
    credential_incompatible: 'A credencial selecionada não é compatível com este provedor de Voz.',
    credential_unknown: 'Não foi possível verificar a credencial do provedor.',
    endpoint_missing: 'Configure o endpoint exigido por este provedor de Voz.',
    endpoint_installing: 'O endpoint do provedor de Voz ainda está sendo preparado.',
    endpoint_incompatible: 'O endpoint configurado não é compatível com este provedor de Voz.',
    endpoint_unknown: 'Não foi possível verificar o endpoint do provedor de Voz.',
    runtime_missing: 'Instale o ambiente de execução exigido por este provedor de Voz.',
    runtime_installing: 'O ambiente de execução do provedor de Voz ainda está sendo instalado.',
    runtime_incompatible: 'O ambiente de execução instalado não é compatível com este provedor de Voz.',
    runtime_unknown: 'Não foi possível verificar o ambiente de execução do provedor de Voz.',
    model_missing: 'Instale ou escolha um modelo para este provedor de Voz.',
    model_installing: 'O modelo de Voz selecionado ainda está sendo instalado.',
    model_incompatible: 'O modelo selecionado não é compatível com este provedor de Voz.',
    model_unknown: 'Não foi possível verificar o modelo do provedor de Voz.',
    device_stt_unavailable: 'O reconhecimento de fala não está disponível neste dispositivo.',
    device_stt_availability_unknown: 'A disponibilidade do reconhecimento de fala ainda está sendo verificada.',
    short: {
      needsSetup: 'Precisa de configuração',
      needsKey: 'Precisa de uma chave',
      needsApproval: 'Precisa da sua aprovação',
      offOnServer: 'Desativado neste servidor',
      needsComputer: 'Precisa de um computador',
      needsAddress: 'Precisa de um endereço',
      needsModel: 'Precisa de um modelo',
      installing: 'Instalando',
      notInstalled: 'Não instalado',
      unavailableHere: 'Indisponível aqui',
      needsUpdate: 'Precisa de atualização',
      cantCheck: 'Ainda não verificado',
    },
    actions: {
      select_provider: 'Escolher um provedor',
      open_provider_settings: "Concluir configuração",
      select_execution_machine: 'Escolher uma máquina',
      configure_credential: 'Adicionar credenciais',
      review_credential_access: 'Revisar o acesso à credencial',
      configure_endpoint: 'Configurar o endpoint',
      install_model: 'Instalar um modelo',
      switch_provider: 'Escolher outro provedor',
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

const voiceRealtimeProviderSetupTranslations = { pt: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["pt"], {
    xai: {
      setup: { footer: 'A sua chave de API da xAI é guardada como segredo sincronizado nos segredos da sua conta Happier. Só é materializada para a operação delimitada da xAI Realtime.' },
      credential: { promptBody: 'Cole uma chave de API da xAI. O Happier protege-a como segredo guardado sincronizado e só a materializa para a operação delimitada da xAI Realtime.' },
    },
    setup: {
      title: 'Configuração da voz em tempo real',
      footer: 'A sua chave de API é guardada na máquina de execução selecionada e nunca é incluída nas definições de voz sincronizadas.',
    },
    credential: {
      title: 'Chave de API guardada',
      promptTitle: 'Ligar a voz em tempo real',
      promptBody: 'Cole uma chave de API da OpenAI Platform. É protegida nos segredos sincronizados da sua conta e só é materializada ao emitir credenciais de cliente Realtime de curta duração.',
    },
    authentication: {
      sectionTitle: 'Autenticação da OpenAI Realtime',
      title: 'Origem da autenticação',
      subtitle: 'Escolha exatamente uma origem. O Happier nunca recorre a outra chave nem a outra conta.',
      footer: 'A utilização da API OpenAI Realtime é faturada pela OpenAI Platform. Uma subscrição do ChatGPT ou do Codex não implica faturação nem acesso à API Realtime. Para a conversa por WebRTC só são passadas credenciais de cliente de curta duração.',
      savedSecret: {
        title: 'Chave de API de voz guardada',
        subtitle: 'Use a chave de API guardada nos segredos da conta Happier Voice. Não é necessário nenhum daemon.',
      },
      openAiApiKey: {
        title: 'Serviço ligado da OpenAI',
        subtitle: 'Use o perfil ou grupo de contas com chave de API padrão da OpenAI selecionado através da máquina escolhida e do respetivo daemon ligado.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Use o perfil ou grupo de contas Codex OAuth selecionado através da máquina escolhida e do respetivo daemon ligado. O Happier nunca recorre a outra chave nem a outra conta.',
      },
      account: {
        title: 'Conta ligada',
        subtitle: 'Escolha o perfil ou grupo de contas exato usado na próxima conversa.',
      },
      chooseAccount: 'Escolha uma conta',
      referenceRequired: 'Escolha um perfil ou grupo de contas ligado.',
      connected: 'Conta ligada pronta',
      unavailable: 'Conta selecionada indisponível ou a precisar de nova ligação',
    },
    invalidValue: 'Este fornecedor não suporta esse valor.',
    advanced: { show: 'Mostrar definições avançadas', hide: 'Ocultar definições avançadas' },
    fields: {
      model: { title: 'Modelo', subtitle: 'Escolha o modelo de voz em tempo real.' },
      voice: { title: 'Voz', subtitle: 'Escolha a voz usada nas respostas.' },
      instructions: {
        title: 'Instruções de voz',
        subtitle: 'Instruções opcionais de comportamento e personalidade.',
        promptTitle: 'Instruções de voz',
        promptBody: 'Escreva instruções opcionais para esta sessão de voz.',
      },
      turnDetection: {
        title: 'Deteção do fim da fala',
        subtitle: 'Escolha como o fornecedor deteta o fim da sua vez de falar.',
        threshold: {
          title: 'Limiar de VAD',
          subtitle: 'Sensibilidade à atividade de voz; deixe em branco para o valor do fornecedor.',
          promptTitle: 'Limiar de VAD',
          promptBody: 'Introduza um valor de 0.1 a 0.9 ou deixe em branco.',
        },
        silenceDurationMs: {
          title: 'Duração do silêncio',
          subtitle: 'Milissegundos de silêncio antes de terminar a vez de falar.',
          promptTitle: 'Duração do silêncio',
          promptBody: 'Introduza de 0 a 10000 milissegundos ou deixe em branco.',
        },
        prefixPaddingMs: {
          title: 'Margem antes da fala',
          subtitle: 'Milissegundos conservados antes da fala detetada.',
          promptTitle: 'Margem antes da fala',
          promptBody: 'Introduza de 0 a 10000 milissegundos ou deixe em branco.',
        },
        idleTimeoutMs: {
          title: 'Tempo limite de resposta em inatividade',
          subtitle: 'Se quiser, peça à xAI para iniciar uma resposta após este silêncio.',
          promptTitle: 'Tempo limite de resposta em inatividade',
          promptBody: 'Introduza de 1 a 600000 milissegundos ou deixe em branco para desativar as respostas automáticas em inatividade.',
          confirmTitle: 'Ativar as respostas automáticas em inatividade?',
          confirmBody: 'Após o silêncio configurado, a xAI pode criar uma resposta por iniciativa própria e consumir utilização da API.',
          confirmAction: 'Ativar',
        },
      },
      transcriptionModel: {
        title: 'Modelo de transcrição',
        subtitle: 'Modelo opcional de transcrição da entrada.',
        promptTitle: 'Modelo de transcrição',
        promptBody: 'Introduza um id de modelo ou deixe em branco para o valor do fornecedor.',
      },
      reasoning: { title: 'Raciocínio', subtitle: 'Escolha o nível de raciocínio para os modelos suportados.' },
      outputSpeed: {
        title: 'Velocidade da fala',
        subtitle: 'Ajuste a velocidade com que o fornecedor fala.',
        promptTitle: 'Velocidade da fala',
        promptBody: 'Introduza um valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Sugestão de idioma',
        subtitle: 'Se quiser, ajude a transcrição a identificar o seu idioma.',
        promptTitle: 'Sugestão de idioma',
        promptBody: 'Escolha um idioma suportado.',
      },
      keyterms: {
        title: 'Termos-chave',
        subtitle: 'Nomes e termos do domínio que a transcrição deve reconhecer.',
        promptTitle: 'Termos-chave',
        promptBody: 'Introduza até 100 termos separados por vírgulas ou por mudanças de linha.',
      },
    },
    options: {
      pinned: 'Versão fixada',
      movingAlias: 'Acompanha automaticamente as atualizações do fornecedor',
      automatic: 'Automático',
      custom: 'Personalizado…',
      server_vad: 'Deteção de atividade de voz no servidor',
      semantic_vad: 'Deteção semântica do fim da fala',
      manual: 'Manual',
      high: 'Alto',
      none: 'Nenhum',
    },
    catalog: {
      credentialRequired: 'Adicione uma chave de API para carregar as vozes',
      retry: 'Não foi possível carregar as vozes — tentar de novo',
      empty: 'Não há vozes disponíveis para esta conta',
      preview: ({ voice }) => `Ouvir ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Acompanhar o modelo mais recente?',
      confirmBody: 'Um alias de modelo móvel pode mudar de comportamento quando o fornecedor o atualiza. Pode voltar a uma versão fixada quando quiser.',
      confirmAction: 'Usar o mais recente',
    },
    links: {
      title: 'Recursos do fornecedor',
      account: { title: 'Abrir a conta do fornecedor', subtitle: 'Faça a gestão da sua conta no fornecedor.' },
      apiKeys: { title: 'Abrir as chaves de API', subtitle: 'Crie, rode ou revogue chaves de API do fornecedor.' },
      privacy: { title: 'Política de privacidade do fornecedor', subtitle: 'Veja como o fornecedor trata os dados de voz.' },
    },
    disconnect: {
      title: 'Desligar a voz em tempo real',
      subtitle: 'Remova a chave de API deste fornecedor da máquina selecionada.',
      confirmTitle: 'Desligar o fornecedor?',
      confirmBody: 'Isto remove a chave de API guardada da máquina de execução selecionada.',
    },
    unavailable: {
      title: 'Voz em tempo real indisponível',
      rowTitle: 'Não foi possível carregar as definições',
      provider: 'A contribuição do fornecedor está indisponível ou é incompatível.',
      invalid: 'As definições guardadas do fornecedor são inválidas.',
      needs_migration: 'Estas definições precisam de uma migração suportada antes de poderem ser editadas.',
      unsupported_version: 'Estas definições foram escritas por uma versão mais recente do Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const pt: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Escolha um serviço para alterar esta definição.',
      select: ({ choice, control }) => `Selecione ${choice} em ${control} para alterar esta definição.`,
    },
    hub: {
      description: 'Fale em voz alta com seus agentes e dite em qualquer mensagem.',
      modesTitle: 'Duas formas de usar sua voz',
      moreTitle: 'Mais',
      dictationPurpose: 'o microfone da caixa de texto transforma sua fala em texto editável',
      summarySessionSummaries: 'Resumos de sessão',
      summaryRecentMessages: ({ count }) => `últimas ${count} mensagens`,
      summaryNothingShared: 'Nada é compartilhado no início de uma conversa',
      summaryRemembers: 'O agente do Voice lembra conversas anteriores',
      summaryForgets: 'O agente do Voice esquece após cada conversa',
      summaryVoiceComputer: ({ machine }) => `Computador do Voice: ${machine}`,
      summaryTranscript: 'transcrição enquanto você fala',
    },
    pipeline: {
      hear: 'Ouvir',
      think: 'Pensar',
      speak: 'Falar',
      write: 'Escrever',
      ready: 'Pronto',
      oneStepNeedsYou: 'Uma etapa precisa de você',
      stepsNeedYou: ({ count }) => `${count} etapas precisam de você`,
      waiting: 'Aguardando',
      working: 'Em andamento',
      notChecked: 'Ainda não verificado',
      off: 'Desativado · o ditado continua disponível',
      onMachine: ({ machine }) => `Em ${machine}`,
      onVoiceComputer: 'No seu computador do Voice',
      inTheCloud: 'Na nuvem do serviço, a partir deste dispositivo',
      inTheSession: 'O próprio agente responde, na transcrição',
      intoYourMessage: 'Você revisa antes de enviar',
      messageLanguage: ({ language }) => `Idioma: ${language}`,
      languageAutomatic: 'automático',
      onThisDevice: 'Neste dispositivo',
      needsYou: 'Precisa de você',
      voiceAgentFollowsSession: 'Agente do Voice · segue a sessão',
      theSessionYoureIn: 'A sessão em que você está',
      intoYourMessageTitle: 'Na sua mensagem',
    },
    privacy: {
      localAudio: "O dispositivo ou computador Voice",
      localProcessor: "O modelo de voz selecionado",
      localRetention: "Gerido pelo dispositivo ou ambiente de execução. Os diagnósticos seguem as definições de gravação.",
      localDisclosure: "Os modelos de voz selecionados são executados no dispositivo ou computador Voice. O histórico Voice e as gravações de diagnóstico têm definições separadas nesta página.",
      audioTitle: "Áudio enviado para",
      processorTitle: "Processado por",
      retentionTitle: "Retenção",
      messagesUnit: "mensagens",
      secondsUnit: "segundos",
      servicePolicy: "Conforme as definições e os termos da sua conta do serviço.",
      noMicrophoneAudio: "Sem áudio do microfone; apenas texto da resposta.",
      yourEndpoint: "O seu endpoint configurado",
      endpointOperator: "O operador do seu endpoint",
      endpointPolicy: "Conforme a política de retenção do seu endpoint.",
      deviceAudio: "O serviço de voz do dispositivo",
      deviceProcessor: "O dispositivo ou o seu serviço de voz",
      devicePolicy: "Conforme as definições e os termos de voz do dispositivo.",
      description: 'O que seu serviço de voz ouve e lê, e o que o Happier guarda.',
      whereTitle: 'Para onde sua voz vai agora',
      whereDescription: 'Muda conforme o serviço escolhido.',
      startTitle: 'Quando uma conversa começa',
      startDescription: 'O que o serviço de voz pode ler do seu trabalho.',
      screenTitle: 'O que está na sua tela',
      screenDescription: 'Qual sessão ou página você está vendo.',
      screenNever: 'Nunca',
      screenWhenAsked: 'Quando pedir',
      screenAlways: 'Sempre',
      summariesTitle: 'Resumos de sessão',
      recentTitle: 'Suas mensagens recentes',
      recentDescription: 'As últimas mensagens de uma sessão, quando ele pede contexto.',
      recentCountTitle: 'Mensagens a compartilhar',
      recentCountDescription: "",
      recentCountUnavailable: 'Ative “Suas mensagens recentes” para alterar isto.',
      toolsTitle: 'Nomes das ferramentas',
      toolsDescription: 'Como “Arquivo editado”. Argumentos e caminhos de arquivos nunca são compartilhados.',
      permissionsTitle: 'Pedidos de permissão',
      permissionsDescription: 'Para ele dizer o que precisa de você. Você ainda aprova com um toque.',
      devicesTitle: 'Suas máquinas e dispositivos',
      devicesDescription: 'Nomes e status online, para iniciar sessões onde você pedir.',
      liveTitle: 'Enquanto você fala',
      liveDescription: 'Atualizações enviadas quando suas sessões mudam durante uma conversa.',
      liveActiveTitle: 'Da sessão em que você está',
      liveOtherTitle: 'Das suas outras sessões',
      liveNothing: 'Nada',
      liveActivity: 'Atividade',
      liveSummaries: 'Resumos',
      liveMessages: 'Mensagens',
      livePerUpdateTitle: 'Mensagens por atualização',
      liveIncludeMineTitle: 'Incluir o que você escreveu',
      liveIncludeMineDescription: 'Desativado: só a parte do agente é enviada.',
      liveMessagesUnavailable: 'Escolha “Mensagens” para uma sessão acima para alterar isto.',
      liveOtherModeTitle: 'Mensagens de outras sessões',
      liveOtherModeNever: 'Nunca',
      liveOtherModeWhenAsked: 'Quando pedir',
      liveOtherModeAutomatically: 'Automaticamente',
      liveOtherModeUnavailable: 'Escolha “Mensagens” para outras sessões para alterar isto.',
      memoryTitle: 'Memória do agente do Voice',
      memoryDescription: 'Só para voz local com um agente do Voice.',
      rememberTitle: 'Lembrar conversas anteriores',
      rememberOnDescription: 'Retoma de onde você parou.',
      rememberOffDescription: 'Desativado: esquece tudo quando você desliga.',
      restoreTitle: 'Restaurar memória por',
      restoreRecent: 'Mensagens recentes',
      restoreSummary: 'Resumo + recentes',
      restoreResume: 'Retomada do agente',
      restoreUnavailable: 'Ative “Lembrar” para escolher.',
      restoreResumeFeatureOff: 'A retomada precisa do agente do Voice ativado neste servidor.',
      restoreResumeAgentCannot: 'Este agente não consegue retomar uma conversa anterior.',
      fallbackTitle: 'Se a retomada falhar, reproduzir mensagens',
      fallbackDescription: 'Começa pelas suas mensagens recentes em vez do zero.',
      restoreCountTitle: 'Mensagens a restaurar',
      restoreCountDescription: "",
      forgetTitle: 'Esquecer tudo agora',
      forgetDescription: 'Reinicia o agente do Voice do zero. Suas sessões não são afetadas.',
      forgetAction: 'Esquecer',
      moreTitle: 'Mais',
    },
    dictation: {
      description: 'O microfone da caixa de texto transforma sua fala em texto que você edita antes de enviar.',
      engineTitle: 'Mecanismo de fala',
      engineDescription: 'Cada mecanismo diz para onde vai seu áudio.',
      sameAsConversations: 'Igual às conversas por voz',
      sameAsConversationsUses: ({ engine }) => `Usa ${engine}, como suas conversas por voz.`,
      languageTitle: 'Idioma',
      dictateInTitle: 'Eu dito em',
      dictateInDescription: 'Automático usa o padrão do mecanismo. Não segue o idioma das suas conversas.',
      pipelinePurpose: 'funciona mesmo com as conversas por voz desativadas',
    },
    conversations: {
      description: 'Fale em voz alta com seus agentes, com as mãos no teclado ou não.',
      serviceTitle: 'Serviço',
      serviceDescription: 'Quem ouve você, pensa e fala. Você pode trocar quando quiser; cada um mantém sua configuração.',
      offDescription: 'Sem conversas por voz. O ditado continua disponível.',
      serviceReady: 'Pronto',
      accountTitle: 'Conta',
      accountDescription: 'É o mesmo serviço nos dois casos; só muda quem paga.',
      payWithTitle: 'Pagar com',
      happierBillingUnavailable: "O faturamento do Happier não está disponível neste servidor.",
      turnOnVoiceAgent: "Ativar agente de voz",
      payWithHappierDescription: 'Seu plano Happier cobre isso. Não precisa de conta própria.',
      payWithOwnDescription: 'Você usa sua própria conta e chave de API deste serviço.',
      runsOn: 'Roda em',
      hearTitle: 'Ouvir',
      hearDescription: 'Como sua fala vira texto antes de ser respondida.',
      speechRecognitionTitle: 'Reconhecimento de fala',
      handsFreeUnsupported: 'O modo mãos livres precisa do reconhecimento de fala deste dispositivo ou de um modelo de fala do Happier.',
      handsFreeTimingUnavailable: 'Ative mãos livres para alterar isto.',
      interruptTitle: 'Interromper falando',
      interruptDescription: 'Falar por cima de uma resposta a interrompe.',
      talkToTitle: 'Falar com',
      talkToSession: 'A sessão',
      talkToSessionDescription: 'Você fala na sessão em que está; o próprio agente dela responde.',
      talkToAgent: 'Um agente do Voice',
      talkToAgentDescription: 'Um agente do Voice lê suas sessões e age por você.',
      agentFeatureRequired: ({ feature }) => `Ative ${feature} em Configurações → Recursos. Os recursos experimentais também precisam de Experimentos ativado.`,
      itMayTitle: 'Ele pode',
      itMayReadOnly: 'Só ler',
      itMayReadOnlyDescription: 'Lê suas sessões e arquivos e não muda nada.',
      itMayAsk: 'Perguntar antes',
      itMayAskDescription: 'Cada mudança pergunta a você antes. Um “sim” falado nunca aprova; você toca.',
      itMaySafe: 'Mudanças seguras',
      itMaySafeDescription: 'Faz sozinho as mudanças seguras no espaço de trabalho e pergunta pelo resto.',
      itMayAnything: 'Qualquer coisa',
      itMayAnythingDescription: 'Pode fazer qualquer mudança sem perguntar antes.',
      repliesTitle: 'Respostas',
      repliesShort: 'Curtas',
      repliesBalanced: 'Equilibradas',
      thinkTitle: 'Pensar',
      thinkDescription: 'O que acontece com o que você diz.',
      advancedAgentTitle: 'Comportamento avançado do agente',
      advancedAgentDescription: 'Como o agente do Voice inicia, espera e responde. Os padrões servem para a maioria.',
      memoryLinkTitle: 'Memória e restauração',
      memoryLinkDescription: 'Se ele lembra conversas anteriores fica em Privacidade e dados.',
      speakTitle: 'Falar',
      speakDescription: 'Como as respostas são lidas em voz alta.',
      voiceEngineTitle: 'Mecanismo de voz',
      languageTitle: 'Idioma',
      languageDescription: 'O que cada idioma muda para o serviço escolhido.',
      iSpeakTitle: 'Eu falo',
      iSpeakDescription: 'Ajuda a entender você. Automático detecta a cada vez.',
      replyInTitle: 'Responder em',
      replyInDescription: 'A resposta vem neste idioma, mesmo se você mudar.',
      replySame: 'Igual ao que falo',
      iSpeakAutomatic: 'Automático',
      iSpeakEngineDescription: ({ engine }) => `Ajuda ${engine} a entender você. Ajuste no reconhecimento de fala em Ouvir.`,
      voiceTitle: 'Voz',
      voiceDescription: ({ engine }) => `De ${engine}, o motor em Falar.`,
      voiceDefault: 'Padrão',
      voiceDevice: 'A voz deste dispositivo',
      voiceInEngine: 'Ajuste em Falar',
      languageServiceDescription: 'O idioma em que seu serviço de voz responde.',
      languageAutomaticDescription: 'Seu serviço de voz detecta o idioma que você fala.',
      languageEngineDefault: 'Padrão do mecanismo',
      languageCoupledDescription: 'Seu serviço de voz usa um único idioma para ouvir e responder.',
      greetingTitle: 'Saudação',
      greetingOff: 'Não',
      greetingRightAway: 'Imediatamente',
      greetingAfterISpeak: 'Quando eu falar',
      greetingOffDescription: 'Espera você falar primeiro.',
      greetingRightAwayDescription: 'Diz olá assim que a conversa começa.',
      greetingAfterISpeakDescription: 'Cumprimenta você na primeira resposta.',
      languageManagedDescription: 'Seu serviço de voz controla o próprio idioma.',
      languageServiceDefault: 'Padrão do serviço',
    },
    advanced: {
      description: 'Onde a voz roda, como aparece na tela e quais modelos de fala usa.',
      onScreenTitle: 'Na tela',
      onScreenDescription: 'Como uma conversa ao vivo aparece.',
      showLiveAsTitle: 'Mostrar o Voice ao vivo como',
      showLiveAsDescription: 'Só neste dispositivo. A seção Voice do Companion continua em todos os modos.',
      scopeTitle: 'Iniciar conversas com',
      scopeGlobal: 'Todas as minhas sessões',
      scopeGlobalDescription: 'Um assistente para tudo.',
      scopeSession: 'A sessão aberta',
      scopeSessionDescription: 'Começa dentro da sessão que você tem aberta.',
      transcriptTitle: 'Mostrar a transcrição enquanto fala',
      transcriptDescription: 'O que você e o agente dizem aparece enquanto vocês falam.',
      autoOpenTitle: 'Abrir quando uma conversa começa',
      autoOpenDescription: 'Desativado: abra você mesmo pela conversa.',
      autoOpenUnavailable: 'Ative “Mostrar a transcrição” para escolher.',
      computerTitle: 'Computador do Voice',
      speechModelsTitle: 'Modelos de fala',
      speechModelsNeedComputerTitle: 'Precisa de um computador do Voice',
      speechModelsNeedComputer: 'Escolha acima um computador do Voice para instalar e gerenciar os modelos de fala dele.',
      computerDescription: 'O computador que roda os modelos de fala e entra nas contas conectadas para a voz. Compartilhado entre seus dispositivos.',
      connectionTitle: 'Conexão',
      timeoutTitle: 'Desistir de um pedido de fala após',
      timeoutDescription: "Para endpoints e modelos de fala.",
    },
  },
};

const voiceSettingsPagesTranslations = { pt } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "pt">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'pt': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} partes concluídas · ${admitted} admitidas`, merge: 'Integrando o percurso…', titleEdited: 'Título editado', changed: 'Alterado', moved: 'Movido', filesReadUnavailable: 'Progresso de leitura de arquivos indisponível' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { pt: { discuss: 'Conversar', message: 'Mensagem', edit: 'Editar percurso', title: 'Título do percurso', stopTitle: 'Título da etapa', prose: 'Explicação', refine: 'Refinar', instructions: 'O que deve mudar?', moveUp: 'Mover para cima', moveDown: 'Mover para baixo', mergeNext: 'Combinar com a próxima etapa', addSummary: 'Adicionar resumo', addCommitPlan: 'Propor commits', updated: 'Resultado salvo atualizado', conflict: 'Este percurso mudou em outro lugar. Seu rascunho foi preservado. Carregue a versão mais recente e confira antes de salvar novamente.', reload: 'Carregar versão mais recente', missingStop: "Esta etapa não está mais no percurso mais recente. Seu rascunho foi preservado; selecione outra etapa para continuar.", applicationLocked: 'Os commits estão sendo aplicados. A edição está pausada.' } } satisfies Pick<Record<string, SavedCopy>, "pt">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { pt: copy({
        title: 'Guias',
        description: 'Uma ordem de leitura criada por IA, com explicações ao lado das alterações exatas e propostas de commits opcionais. Executa na máquina que contém o código.',
        enabled: 'Explicar alterações',
        enabledDescription: 'Adiciona uma ordem de leitura e explicações a uma comparação. Os arquivos continuam disponíveis sem um modelo.',
        model: 'Modelo de resumo',
        modelDescription: 'Usado para explicações, guias e propostas de commits.',
        chooseModel: 'Escolher modelo',
        unsupported: 'Não pode escrever guias',
        unavailable: 'Modelo indisponível. Escolha outro.',
        prefetch: 'Preparar após cada turno',
        prefetchDescription: 'Prepara um guia quando o agente termina um turno.',
        saved: 'Guias salvos',
        savedDescription: 'Salvos nesta máquina, incluindo suas edições.',
        clear: 'Limpar',
        unavailableData: 'Reconecte a máquina para carregar os guias salvos e os custos.',
        costUnavailable: 'Últimos 7 dias · custo indisponível',
        clearTitle: 'Limpar os guias salvos?',
        clearDescription: ({ machine }) => `Exclui os guias salvos e suas edições manuais em ${machine}, além das suas marcações de revisão dessas comparações. As outras máquinas não são afetadas.`,
        savedCount: ({ count, bytes }) => `${count} salvos · ${bytes}`,
        cost: ({ amount, partial }) => `Últimos 7 dias · ${amount}${partial ? ' · alguns custos estão indisponíveis' : ''}`,
        clearFailed: 'Não foi possível limpar alguns guias. Recarregue e tente novamente.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { pt: { walkthroughStart: { start: 'Iniciar apresentação', ended: 'Esta conversa não está disponível aqui. A apresentação permanece.', newConversation: 'Iniciar uma nova conversa', askSession: 'Perguntar ao agente da sessão', unavailable: 'Conecte a máquina e escolha um modelo com saída estruturada.', updated: 'Apresentação atualizada' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { pt: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.pt,
            progress: walkthroughProgressTranslations.pt,
            eyebrow: 'Roteiro',
            generated: 'Gerado',
            generatedBy: ({ model }) => `Gerado · ${model}`,
            generatedA11y: 'Escrito por um modelo',
            readingChanges: 'Lendo as alterações…',
            modelFallback: 'O modelo',
            analysisAll: ({ who, count }) => `${who} leu todas as ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} leu ${analysed} de ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} leu ${analysed} de ${total} antes de parar`,
            unavailableCount: ({ count }) => `${count} indisponíveis`,
            youReviewed: ({ count, total }) => `Você revisou ${count} de ${total}`,
            contents: 'Conteúdo',
            reviewedOfTotal: ({ count, total }) => `${count} de ${total} revisadas`,
            boardReadProgress: ({ count, total }) => `${count} de ${total} lidas`,
            stopOf: ({ number, total }) => `${number} de ${total}`,
            stopA11y: ({ number, title }) => `Parada ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Parada ${number}, revisada`,
            importance: { start: 'Comece aqui', high: 'Leia com atenção', low: 'Passe os olhos' },
            markReviewed: 'Marcar como revisada',
            reviewed: 'Revisada',
            markReviewedA11y: 'Marcar esta parada como revisada',
            unmarkReviewedA11y: 'Revisada. Toque para remover sua marca',
            askAboutThis: 'Perguntar sobre isto',
            askAboutStopA11y: 'Perguntar sobre esta parada',
            openConversation: 'Abrir a conversa do roteiro',
            andIn: ({ file }) => `e em ${file}`,
            newFile: 'Arquivo novo',
            deletedFile: 'Excluído',
            openInFiles: ({ file }) => `Abrir ${file} em Arquivos`,
            otherChanges: 'Outras alterações',
            otherChangesDescription: 'Fora da história, mas ainda aqui. Abra-as como um diff normal.',
            otherChangesCue: 'Mecânicas, mostradas como diffs',
            keys: { move: 'mover', reviewed: 'revisada', ask: 'perguntar' },
            overview: 'Visão geral',
            codeMapOf: ({ count }) => `Mapa de código de ${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
            codeMapHint: 'aponte uma parada para destacar seus arquivos',
            touchesOutlined: 'afeta os arquivos destacados',
            showOverviewA11y: ({ count }) => `Mostrar a visão geral: um mapa de código de ${count} arquivos`,
            inventory: { title: 'Tudo nesta comparação · já disponível em Arquivos', read: 'Lido', reading: 'Lendo', unavailable: 'Indisponível' },
            arriving: 'As próximas paradas aparecem aqui conforme são escritas.',
            previousStop: 'Parada anterior',
            nextStop: 'Próxima parada',
            done: 'Concluído',
            evidence: { displayFailed: 'Não foi possível mostrar o código salvo. O arquivo continua em Arquivos.', binary: 'Arquivo binário, descrito pelos metadados. Mostrado, não analisado.', unavailable: ({ reason }) => `Não foi possível ler (${reason}). Continua na lista; nada aqui afirma que foi revisado.` },
            notice: {
                stale: 'Arquivos mudaram depois que isto foi escrito',
                refresh: 'Atualizar roteiro',
                failed: ({ reason }) => `A escrita parou · ${reason}`,
                failedGeneric: 'A escrita parou',
                tryAgain: 'Tentar de novo',
                chooseModel: 'Escolher modelo',
                cancelled: 'A escrita foi interrompida. O que foi escrito permanece.',
                rest: 'O restante não foi escrito. Todos os arquivos estão em Arquivos; nada foi omitido em silêncio.',
                offline: ({ machine, time }) => `${machine} está offline · mostrando o roteiro e o código das ${time}. Perguntar e atualizar voltam quando reconectar.`,
                offlineA11y: 'Precisa da máquina, que está offline',
                incomplete: 'Algumas alterações não puderam ser listadas. O que está aqui é exato; nada afirma estar completo.',
                undo: 'Desfazer',
            },
            none: { title: 'Ainda não há roteiro', reason: 'Um roteiro lê essas alterações em ordem e explica cada uma ao lado do código exato. Todos os arquivos já estão em Arquivos.', showFiles: 'Mostrar arquivos' },
            explain: { notInStory: 'Fora da história', readInWalkthrough: 'Ler no roteiro' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { pt: {
        added: 'Adicionado',
        boardTitle: 'Adicionar ao quadro',
        boardHint: 'Todos aqui veem o que você adiciona',
        companionTitle: 'Adicionar ao companheiro',
        companionHint: 'Só você vê seu companheiro',
        searchWidgets: 'Pesquisar widgets',
        searchCompanion: 'Pesquisar resumos e painéis',
        makeOne: 'Criar um',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Encontrar mais widgets',
        findMoreSubtitle: 'Plugins',
        askTitle: 'Pedir um widget ao agente',
        askNote: 'Escreve um rascunho no compositor; nada é enviado até você enviar.',
        glances: 'Resumos',
        glancesHint: 'ao vivo, integrados ou de plugins',
        onBoard: 'Neste quadro',
        onBoardHint: 'compartilhado com todos aqui',
        panes: 'Painéis',
        panesHint: 'adicionado como um link que abre em Detalhes',
        builtIn: 'Integrado',
        noMatch: ({ query }) => `Nenhum widget corresponde a “${query}”`,
        pickTitle: 'Escolha um widget para vê-lo aqui',
        pickHint: 'Mostra seus próprios dados, no tamanho que você escolher, antes de adicionar qualquer coisa.',
        pickNote: 'Escolha um widget para adicioná-lo',
        askAction: 'Escrever o pedido',
        pluginTag: 'plugin',
        pluginProvenance: ({ plugin }) => `Plugin ${plugin}`,
        readsChosenSession: 'lê a sessão que você escolher, onde ela roda',
        readsFrom: ({ source }) => `lê ${source}`,
        savedQueryOn: ({ source }) => `uma consulta salva em ${source}`,
        madeByYou: ({ date }) => `criado por você em ${date}`,
        madeByAgent: ({ date }) => `criado pelo seu agente em ${date}`,
        madeByPlugin: ({ date }) => `criado por um plugin em ${date}`,
        previewLiveData: 'Ao vivo, com seus dados',
        addsAtSize: ({ size }) => `Adiciona no tamanho ${size}. Você pode mudar depois.`,
        backToWidgets: 'Widgets',
        nativeDescriptions: {
            session_summary: 'Atividade e próximos passos da sessão escolhida.',
            agent_plan: 'Acompanhe o plano do agente para a sessão escolhida.',
            changes: 'Revise as alterações de arquivos da sessão escolhida.',
            local_services: 'Abra os serviços locais da sessão escolhida.',
        },
        editTitle: ({ widget }) => `${widget} · entradas`,
        editHint: 'Só esta cópia muda. As outras mantêm suas entradas.',
        preview: 'Prévia',
        previewLive: 'Prévia · ao vivo',
        previewWaiting: ({ field }) => `Escolha ${field} para ver aqui`,
        previewAfterAdd: 'Aparece aqui depois de adicionado',
        needed: 'Necessário',
        stillNeeded: ({ field }) => `Ainda falta ${field}`,
        followGroup: 'Seguir',
        pinGroup: 'Ou fixe um',
        another: 'Outro…',
        anotherSubtitle: 'Pesquise tudo o que você pode acessar',
        searchChoices: ({ field }) => `Pesquisar ${field}`,
        noChoices: 'Ainda não há nada para escolher',
        optionsLoading: 'Carregando opções…',
        optionsFailed: 'Não foi possível carregar as opções',
        invalidValue: 'não encontrado',
        inputsInvalid: 'Revise as entradas deste widget',
        inputsUnavailable: 'Uma entrada selecionada está indisponível',
        connectionNeeded: ({ field }) => `Conecte sua ${field}`,
        sessionDenied: ({ session }) => `Você não tem mais acesso a ${session}`,
        sessionUnavailable: ({ session }) => `${session} está indisponível ou foi excluída`,
        typeUnavailable: ({ field }) => `O tipo de ${field} não está mais disponível`,
        inputUnavailable: ({ field }) => `${field} está indisponível`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} não está mais disponível`,
        invalidReason: 'Você não tem mais acesso, ou foi removido.',
        viewerOnly: 'Cada pessoa aqui vê com a própria conexão.',
        justAdded: ({ widget }) => `${widget} adicionado`,
        saved: ({ widget }) => `${widget} salvo`,
        addFailed: 'Não foi possível adicionar. Tente novamente.',
        saveFailed: 'Não foi possível salvar. Tente novamente.',
        homeTitle: 'Adicionar ao Início',
        homeHint: 'Só você vê seu Início · em todos os dispositivos',
        addWidgets: 'Adicionar widgets',
        addToHome: 'Adicionar ao Início',
        addToBoard: 'Adicionar ao quadro',
        addToCompanion: 'Adicionar ao acompanhante',
        editInputs: 'Editar entradas…',
        width: 'Largura',
        size: 'Tamanho',
        sizes: { small: 'Pequeno', medium: 'Médio', wide: 'Largo', full: 'Completo', tall: 'Alto', large: 'Grande' },
        widthHalf: 'Metade',
        widthFull: 'Inteira',
        thisSession: 'Esta sessão',
        choicesCount: ({ count }) => count === 1 ? '1 opção' : `${count} opções`,
        countOnHome: ({ count }) => `${count} no Início`,
        countOnBoard: ({ count }) => `${count} no quadro`,
        countInCompanion: ({ count }) => `${count} no acompanhante`,
        thisPage: 'Esta página',
        thisProject: 'Este projeto',
        thisCheckout: 'Esta cópia de trabalho',
        areaPinned: 'Fixados',
        areaPinnedMeta: 'os seus widgets nesta página',
        areaProjectTitle: 'Widgets',
        areaProjectMeta: 'seus',
        areaAdd: ({ surface }) => `Adicionar um widget a ${surface}`,
        areaAddTo: ({ surface }) => `Adicionar a ${surface}`,
        areaHint: 'Só você vê estes widgets',
        countHere: ({ count }) => count === 1 ? '1 aqui' : `${count} aqui`,
        areaEmptyTitle: 'Nada fixado ainda',
        areaEmptyReason: 'Fixe um widget para mantê-lo aqui, só para você.',
        areaEmptyAction: 'Adicionar um widget',
        areaUnavailableTitle: 'Os widgets não podem carregar aqui',
        projectSourceUnavailableTitle: 'Os widgets aparecerão aqui quando o repositório deste projeto for conhecido',
        areaWriteFailed: 'Não foi possível salvar esta alteração',
        areaApprovalPending: 'Aguardando aprovação',
        valueNotFound: ({ value }) => `Não foi possível encontrar ${value}`,
        chooseAnother: ({ field }) => `Escolher outro valor para ${field}`,
        chooseField: ({ field }) => `Escolher ${field}`,
        widgetOptions: 'Opções do widget',
        moveTo: 'Mover…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "pt">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { pt: {
        yourWidgets: "Seus widgets",
        yourWidgetsHint: "feitos por você ou seus agentes",
        yourWidget: "Seu widget",
        moreInSource: "A fonte tem mais do que é mostrado.",
        notCurrent: "Desatualizado",
        aboutMenu: "Sobre este widget",
        aboutTitle: "Sobre este widget",
        aboutUnavailable: "Não é possível abrir este widget agora.",
        aboutData: "Dados",
        aboutReads: "Lê",
        aboutInputs: "Entradas",
        aboutRefresh: "Atualização",
        aboutUsedIn: "Usado em",
        savedFromSession: ({ session }) => `Salvo de ${session}`,
        aSession: "uma sessão",
        madeInYourAccount: "Feito na sua conta",
        edited: ({ time }) => `editado ${time}`,
        readsOnly: "Somente leitura",
        runsOn: ({ machine }) => `roda em ${machine}`,
        withYourConnection: "com a sua própria conexão",
        readsResource: ({ read, plugin }) => `${read} de ${plugin}`,
        cannotRunAnythingElse: "O widget não pode executar mais nada.",
        inputsThisCopy: "Só para esta cópia",
        refreshWhenOpen: "Quando você abre",
        refreshNow: "Atualizar agora",
        refreshing: "Atualizando…",
        refreshed: "Atualizado",
        refreshFailed: "Não foi possível atualizar. Os últimos números continuam.",
        placedOnHome: "Início",
        placedOnBoard: ({ board }) => `Quadro ${board}`,
        placedOnABoard: "Um quadro",
        placedInASession: "Uma sessão",
        placedInAProject: "Um projeto",
        placedOnAPluginPage: "Uma página de plugin",
        notPlacedYet: "Ainda não está em lugar nenhum",
        otherPlacesNotListed: "Lugares em outros dispositivos ou superfícies compartilhadas não aparecem aqui.",
        editsChangeAll: ({ count }) => `Editar o widget muda todos os ${count}`,
        editsChangeEverywhere: "Editar o widget o muda em todos os lugares onde é usado",
        changeWithAgent: "Mudar com o agente",
        changeDraft: ({ widget }) => `Mude o widget “${widget}” para que `,
        duplicate: "Duplicar",
        duplicated: ({ name }) => `Cópia “${name}” salva em Seus widgets`,
        duplicateFailed: "Não foi possível fazer uma cópia. Tente de novo.",
        saveMenu: "Salvar como seu widget…",
        saveMenuSubtitle: "Uma cópia para o Início e seus quadros",
        saveTitle: "Salvar como seu widget",
        saveHint: "Uma cópia para colocar no Início, nos seus quadros e projetos. Esta sessão mantém a dela.",
        saveNote: "Salvo na sua conta · só você",
        saveWidget: "Salvar widget",
        saveFailed: "Não foi possível salvar o widget. Tente de novo.",
        savedButNotPlaced: "Salvo em Seus widgets, mas não foi adicionado em todos os lugares escolhidos.",
        savedAsYours: ({ name }) => `“${name}” salvo em Seus widgets`,
        name: "Nome",
        nameNeeded: "Dê um nome",
        becomesViewerInput: "Vira uma entrada: cada lugar usa sua conexão",
        becomesContextInput: "Vira uma entrada: cada lugar escolhe a sua",
        alsoAddTo: "Adicionar também a",
        alsoAddToNamed: ({ place }) => `Adicionar também a ${place}`,
        snapshotMenu: "Publicar um instantâneo neste quadro…",
        snapshotMenuSubtitle: "Todos aqui veem seus números de agora",
        snapshotTitle: "Publicar um instantâneo para todos?",
        snapshotHint: ({ widget, time }) => `Quem puder abrir esta sessão verá ${widget} às ${time}. Não será atualizado, e sua conexão continua sua.`,
        postSnapshot: "Publicar instantâneo",
        snapshotNotCurrent: "O widget ainda está obtendo números atuais. Tente de novo quando ele os tiver.",
        snapshotFailed: "Não foi possível publicar o instantâneo. Nada foi compartilhado.",
        snapshotAwaitingApproval: "Aguardando aprovação na sua caixa de entrada. Nada é compartilhado até ser aprovado.",
        snapshotPosted: "Instantâneo publicado",
        snapshotNote: "Uma cópia destes números. Não é atualizada.",
        asOf: ({ time }) => `às ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "pt">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { pt: {
        styleCard: 'Cartão',
        stylePlain: 'Simples',
        surfaceHome: 'Início',
        surfaceBoard: 'Quadro',
        surfaceCompanion: 'Companheiro',
        showFrame: 'Mostrar moldura',
        hideFrame: 'Ocultar moldura',
        thisWidgetOnly: 'Apenas este widget',
        surfaceUses: ({ surface, style }) => `${surface} usa ${style}`,
        useSurfaceDefault: ({ surface }) => `Usar o padrão de ${surface}`,
        likeTheOthers: ({ style }) => `${style}, como os outros`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'Como os widgets são emoldurados neste dispositivo. Para alterar um widget, use o menu ⋯ dele.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Moldura alterada',
        newChip: 'Novo',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "pt">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { pt: {
        changesTitle: 'Alterações',
        localServicesTitle: 'Serviços locais',
        changesSource: 'Git',
        reviewChanges: 'Revisar alterações',
        notARepo: 'A pasta desta sessão não é um repositório Git.',
        noChanges: 'Ainda sem alterações. Os arquivos que o agente editar aparecem aqui.',
        changesLoading: 'Carregando alterações',
        running: 'Em execução',
        notRunning: 'Parado',
        nothingRunning: 'Nada em execução. Os serviços iniciados por esta sessão aparecem aqui.',
        servicesLoading: 'Carregando serviços locais',
        servicesReadFailed: 'Não foi possível ler os serviços locais. Tente novamente.',
        noMachine: 'Esta sessão não tem uma máquina para consultar.',
        changedCount: ({ count }) => `${count} alterados`,
        moreFiles: ({ count }) => (count === 1 ? 'mais 1 arquivo' : `mais ${count} arquivos`),
        runningCount: ({ count }) => `${count} em execução`,
        openInBrowser: ({ name }) => `Abrir ${name} no navegador`,
        paneLinkA11y: ({ pane }) => `${pane}. Abre ao lado do chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "pt">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const pt: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Precisa de você',
        working: 'Trabalhando',
        finished: 'Concluído',
        idle: 'Ocioso',
        offline: 'Offline',
    },
};

const workStatusTranslations = { pt: { ...pt, task: { stopped: 'Parada', linkFailed: 'A sessão foi criada, mas o vínculo com a tarefa não foi salvo. Tente novamente para vincular a mesma sessão.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pt"> = { pt: {
        host: "Happier",
        structure: "Estrutura",
        callWebhook: "Chamar um webhook",
        runCommand: "Executar um comando",
        commandValuesInEnv: "Passe os valores do fluxo de trabalho por variáveis de ambiente. O texto do comando permanece como foi escrito.",
        waitForWork: "Esperar pelo trabalho",
        waitForWorkDescription: "Espera até que o trabalho escolhido alcance o estado indicado",
        artifactCreate: "Criar um documento",
        artifactGet: "Ler um documento",
        artifactList: "Listar documentos",
        artifactUpdate: "Atualizar um documento",
        artifactDelete: "Excluir um documento",
        artifactPublish: "Publicar um arquivo",
        artifactRevisions: "Listar versões do documento",
        artifactRestore: "Restaurar uma versão do documento",
        artifactUsage: "Consultar o uso do armazenamento de documentos",
        artifactShare: "Compartilhar um documento por link",
        artifactLinks: "Listar links do documento",
        artifactRevoke: "Revogar um link de documento",
        artifactAudit: "Consultar a atividade dos links de documento",
        sessionRole: "Definir o papel de uma sessão",
        sessionRoleOverride: "Alterar as configurações do papel de uma sessão",
        sessionRoleClear: "Redefinir as configurações do papel de uma sessão",
        sessionRoleAdd: "Adicionar um papel à sessão",
        sessionRoleRemove: "Remover um papel da sessão",
        sessionNotes: "Definir notas da sessão",
        sessionRolesApply: "Aplicar papéis às sessões subordinadas",
        roleList: "Listar papéis",
        roleGet: "Ler um papel",
        roleCreate: "Criar um papel",
        roleUpdate: "Atualizar um papel",
        roleDelete: "Excluir um papel",
        roleOverride: "Alterar configurações do papel",
        roleReset: "Redefinir configurações do papel",
        widgetCatalog: "Listar widgets disponíveis",
        widgetInstances: "Listar widgets posicionados",
        widgetAdd: "Adicionar um widget",
        widgetRemove: "Remover um widget",
        widgetMove: "Mover um widget",
        widgetRename: "Renomear um widget",
        widgetSize: "Definir o tamanho de um widget",
        widgetFrame: "Definir a moldura de um widget",
        widgetInputs: "Ler entradas de um widget",
        widgetValidate: "Verificar entradas de um widget",
        widgetSetInputs: "Definir entradas de um widget",
        widgetResetInputs: "Redefinir entradas de um widget",
        widgetLayout: "Ler a disposição dos widgets",
        widgetUpdateLayout: "Alterar a disposição dos widgets",
        widgetDefinitions: "Listar widgets salvos",
        widgetDefinition: "Ler um widget salvo",
        widgetCreate: "Criar um widget",
        widgetUpdate: "Atualizar um widget salvo",
        widgetDuplicate: "Duplicar um widget salvo",
        widgetDelete: "Excluir um widget salvo",
        widgetSave: "Salvar um widget da sessão",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { pt: { repeatable: 'Tornar repetível', repeatableDescription: 'Peça ao agente para transformar o que funcionou aqui em um workflow reutilizável.', repeatablePrompt: 'Transforme o que fizemos aqui em um workflow que eu possa executar de novo. Crie, verifique com workflow.validate e salve, mas não execute.', repeatableMessagePrompt: 'Transforme o que fizemos nesta mensagem em um workflow que eu possa executar de novo. Crie, verifique com workflow.validate e salve, mas não execute.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pt"> = { pt: { ...repeatable.pt, create: 'Criar com um agente', edit: 'Editar com um agente', agent: 'Agente', description: 'Uma nova sessão cria o workflow com você, verifica e salva. Nada é executado até você escolher Executar agora.', changedByAgent: 'Alterado pelo agente', saved: 'Salvo pelo agente agora', savedAge: ({ age }) => `Salvo pelo agente ${age}`, savedWorkflow: ({ name }) => `Workflow salvo · ${name}`, updated: 'Workflow atualizado', changed: ({ count }) => `Workflow atualizado · ${count} etapas alteradas`, openEditor: 'Abrir no editor', openSession: 'Abrir em Sessões', createPrompt: 'Crie comigo um workflow, verifique com workflow.validate e depois salve. Não execute.', createLead: 'Ajude-me a criar um workflow que ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `O workflow salvo “${name}” tem id ${definitionId} e revisão: cabeçalho ${headerVersion}, corpo ${bodyVersion}. Altere-o com workflow.definition.edit e use workflow.definition.update apenas para substituí-lo por inteiro. Verifique com workflow.validate antes de salvar. Não execute.`, editLead: ({ name }) => `Ajude-me a mudar ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const pt: WorkflowBuiltinTranslations = {
    keepGoing: { title: 'Continuar até terminar', description: 'Continua até cumprir o objetivo' },
    reviewAndConverge: { title: 'Rever e convergir', description: 'Revisa até os revisores concordarem', apply: 'Aplicar', verifyAndFix: 'Verificar e corrigir', verifyOnly: 'Apenas verificar', rounds: 'Rondas antes de parar' },
    planWithAPanel: { title: 'Planear com um painel', description: 'Vários agentes planeiam lado a lado e o plano aguarda a sua revisão.', inputs: { request: 'Pedido', requestPlaceholder: 'O que deve o painel planear?', engines: 'Planeadores' } },
    openAPullRequest: { title: 'Abrir um pull request', description: 'Pede uma segunda opinião e depois abre um pull request. Se a segunda opinião discordar, espera por si.', inputs: { base: 'Branch base', title: 'Título do pull request', body: 'Descrição', question: 'Pergunta para a segunda opinião' } },
};

const workflowBuiltinTranslations = { pt } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { pt: {
        sessionId: "Sessão",
        triggerId: "Gatilho",
        engineIds: "Revisores",
        backendTargetKeys: "Planejadores",
        reviewCommentAuthorIntent: "Constatações",
        commentId: "Constatação",
        expectedServerRevision: "Versão da constatação",
        clientMutationId: "Atualização",
        projectId: "Projeto",
        workspace: "Espaço de trabalho",
        toState: "Estado",
        expectedState: "Estado atual",
        disposition: "Importância",
        allPages: "Todas as constatações",
        permissionMode: "Permissões",
        target: "Executa em",
        cwd: "Pasta de trabalho",
        maxRounds: "Rodadas máximas",
        strikes: "Verificações sem progresso",
        secondOpinion: "Segunda opinião",
        useJudge: "Juiz",
        diffFingerprint: "Alterações revisadas",
        url: "URL",
        body: "Corpo JSON",
        command: "Comando",
        env: "Variáveis de ambiente",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const pt: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.pt,
    blocks: {
        actionSub: 'Ação · sem turno do agente',
        notSet: 'Não definido',
        set: 'Definir',
        clear: 'Limpar',
        required: 'Obrigatório',
        noFields: 'Nada a definir para esta ação.',
        workflowSub: 'Executa outro workflow · os seus passos aparecem nesta execução',
        builtin: 'Integrado',
        waitTitle: 'Esperar por si',
        waitSub: 'Esta faixa espera até que continue',
        waitSubRoot: 'Este fluxo de trabalho espera até você continuar.',
        waitPlaceholder: 'O que deve verificar ou decidir aqui?',
        returnsText: 'Devolve texto',
        returnsFields: ({ fields }) => `Devolve ${fields}`,
        workflowDefaults: 'Padrões do fluxo de trabalho',
        addNamedResults: 'Adicionar resultados nomeados',
        menuRun: 'Executar um workflow',
        menuAction: 'Ação',
        menuWait: 'Esperar por si',
        actionSearch: 'Procurar ações',
        workflowSearch: 'Procurar workflows',
        libraryGroup: 'Os seus workflows',
        noAgentTurn: 'Notificar, rever, publicar — sem turno do agente',
        agentSub: 'Uma instrução para um agente',
        parallelSub: 'Ramificações executadas ao mesmo tempo',
        loopSub: 'Para cada item, várias vezes ou até…',
        ifSub: 'Somente quando um resultado indicar',
        actionSourcePhone: 'Seu telefone',
        actionSourceReview: 'Mecanismos de revisão',
        useNumber: 'Usar um número',
        actionUnavailable: ({ action }: { action: string }) => `${action} não está disponível aqui.`,
        childInputs: ({ workflow }: { workflow: string }) => `As entradas vêm de ${workflow}.`,
        retryLoading: "Tentar carregar novamente",
        openWorkflow: ({ workflow }) => `Abrir ${workflow}`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} executa este workflow, por isso não pode ser executado dentro dele.`,
        maxFromInput: ({ name }: { name: string }) => `Da entrada · ${name}`,
        useInput: ({ name }: { name: string }) => `Usar a entrada ${name}`,
    },
    backToRun: 'Voltar à execução',
    reviewedCopyTitle: 'Revisar antes de salvar',
    reviewedCopyBody: 'Esta é uma cópia de uma execução. São salvos os passos e ajustes, não o histórico nem os resultados. Local, modo de execução e valores de entrada são escolhas de cada execução. Revise as referências a sessões existentes, pastas, perfis, modelos, serviços e servidores MCP antes de reutilizá-las.',
    chromeTitle: 'Workflow',
    untitled: 'Workflow sem título',
    nameLabel: 'Nome do workflow',
    descriptionPlaceholder: 'Adicione uma descrição',
    descriptionLabel: 'Descrição',
    save: 'Guardar',
    flow: 'Fluxo',
    flowSubtitle: 'Este rascunho como mapa',
    settings: 'Definições do workflow',
    settingsSubtitle: 'Cada passo usa-as, a menos que as altere.',
    deleteWorkflow: 'Eliminar workflow',
    deleteBody: 'As execuções anteriores são mantidas.',
    discardChangesBody: 'Volta à última versão guardada. Anular recupera as suas alterações.',
    deleteFailedTitle: 'Não foi possível eliminar o workflow',
    changedForStep: 'Alterado para este passo',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 coisa a corrigir antes de poder executar' : `${count} coisas a corrigir antes de poder executar`),
    readyToRun: 'Pronto',
    saveStatus: {
        notSaved: 'Ainda não guardado',
        unsaved: 'Alterações por guardar',
        saving: 'A guardar…',
        saved: 'Guardado',
        savedJustNow: 'Guardado agora mesmo',
        savedAge: ({ age }: { age: string }) => `Guardado ${age}`,
        failed: 'Não foi possível guardar',
        yourEdits: 'As suas alterações',
        newerVersion: 'A versão mais recente',
        newerVersionRevision: ({ revision }: { revision: string }) => `A versão mais recente · ${revision}`,
    },
    where: {
        label: 'Onde é executado',
        choose: 'Escolha onde é executado',
    },
    sections: {
        whereTitle: 'Onde é executado',
        machineAndProject: 'Máquina e projeto',
        eachStepRunsIn: 'Cada passo é executado em',
        eachStepSession: 'Cada passo aparece na sua lista de sessões, sob esta execução.',
        eachStepBackground: 'Cada passo é executado em segundo plano, sob esta execução.',
        aSession: 'Uma sessão',
        aBackgroundRun: 'Uma execução em segundo plano',
        agentTitle: 'Agente e modelo',
        agentDescription: 'Os passos usam-nos, a menos que escolham os seus.',
        rolesTitle: 'Funções para este fluxo de trabalho',
        conversationTitle: 'Conversa e espaço de trabalho',
        inputsTitle: 'Entradas e resultado',
    },
    unavailable: {
        machine_not_selected: 'Escolha primeiro uma máquina.',
        capability_unknown: 'A verificar o que esta máquina suporta.',
        machine_does_not_support_detached_runs: 'Esta máquina ainda não consegue fazer execuções em segundo plano.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Opções da etapa',
        whereMissing: 'Nenhuma máquina escolhida',
        none: 'Nenhuma',
        inputCount: ({ count }) => count === 1 ? '1 entrada' : `${count} entradas`,
        finalOutput: ({ output }) => `Resultado final: ${output}`,
        originSession: 'A sessão que o iniciou',
        differsFromWorkflow: 'difere do fluxo de trabalho',
        followsWorkflow: 'usa as configurações do fluxo de trabalho',
        advancedTitle: 'Avançado',
        deadline: ({ ms }) => `Aguarda o resultado por ${ms} ms`,
        workflowDefault: ({ value }) => `Padrão do fluxo · ${value}`,
        aSession: 'Uma sessão…',
        continues: ({ session }) => `Continua ${session}`,
        runsIn: 'Executa em',
        runsInBoundBySession: 'Continua uma sessão, então executa nessa sessão.',
        reviewTitle: 'Revisar antes de continuar',
        reviewDescription: 'As etapas seguintes desta faixa esperam até você usar, editar ou regenerar o resultado. O restante do trabalho continua.',
        reviewEvaluator: 'Cada iteração espera sua revisão.',
        reviewsBeforeContinuing: 'Revisa antes de continuar',
        resultTitle: 'Resultado',
        resultFromAction: ({ action }) => `Definido por ${action}`,
        resultFromWorkflow: ({ workflow }) => `Retorna o que ${workflow} retorna`,
        back: 'Voltar',
        options: 'Opções',
        itemConversation: 'Uma conversa por item; as etapas internas a compartilham.',
        dropContinue: ({ session }) => `Continuar ${session} nesta etapa`,
        dropRefused: ({ session, machine, where }) => `${session} está em ${machine}; este fluxo executa em ${where}.`,
        lanes: ({ count }) => `Lado a lado · ${count} faixas`,
        laneCount: ({ count }) => (count === 1 ? '1 faixa' : `${count} faixas`),
        lane: ({ position }) => `Faixa ${position}`,
        forEachIn: ({ source }) => `Para cada item em ${source}`,
        atATime: ({ count }) => `${count} por vez`,
        repeatTimes: ({ count }) => `Repetir ${count} vezes`,
        repeatUntil: ({ condition }) => `Repetir até ${condition}`,
        repeatUntilDecided: 'Repetir até uma etapa mandar parar',
        ifSentence: ({ condition }) => `Se ${condition}`,
        onlyWhenSentence: ({ condition }) => `Somente quando ${condition}`,
        conditionAll: 'todas são verdadeiras',
        conditionAny: 'alguma é verdadeira',
        conditionNot: ({ condition }) => `não (${condition})`,
        returnsStructured: 'Retorna dados estruturados',
        returnsDecision: 'Retorna uma decisão',
    },
};

const workflowEditorPageTranslations = { pt } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pt"> = { pt: {
        notifyWhenAgentWaits: { title: "Avise-me quando um agente esperar", description: "Escolha uma sessão e receba uma notificação sempre que o agente precisar da sua intervenção." },
        dailySummaryInSession: { title: "Resumo diário nesta sessão", description: "Escolha uma sessão para receber um resumo todos os dias às 09:00." },
        memoryUpkeepInSession: { title: 'Manutenção da memória', description: 'Revise a memória desta sessão todos os dias às 09:00 e mantenha os fatos úteis atualizados.' },
        installDepsInWorktree: { title: "Instalar dependências em uma nova árvore de trabalho", description: "Crie uma nova árvore de trabalho e execute nela um comando de instalação que você pode editar." },
        testAfterEveryTurn: { title: "Testar após cada turno", description: "Escolha uma sessão e execute um comando de teste que você pode editar após cada turno concluído, com falha ou cancelado." },
        noSessions: "Inicie uma sessão de trabalho para usar este modelo.",
        nodes: { ask: 'Perguntar', 'review-correctness': 'Revisar a correção', 'review-tests': 'Revisar testes', summarize: 'Resumir achados', analyze: 'Analisar', review: 'Revisar', fix: 'Corrigir', check: 'Verificar', classify: 'Classificar', reply: 'Redigir uma resposta', digest: 'Resumir mudanças' },
        title: 'Começar com um exemplo', fromExample: 'De um exemplo', description: 'Cada um abre como rascunho. Nada executa até você escolher Executar agora.', sessionDescription: 'Cada um abre como rascunho nesta sessão. Nada é executado até você ativá-lo.', use: 'Usar este', chooseSession: 'Escolher uma sessão…', builtInDescription: 'Parte do Happier. Duplique para alterar.', stepCount: ({ count }) => `${count} ${count === 1 ? 'etapa' : 'etapas'}`,
        askOnce: { title: 'Perguntar uma vez', description: 'Um passo: pergunte algo a um agente e receba a resposta.' },
        reviewPullRequest: { title: 'Revisar um pull request', description: 'Dois revisores em paralelo, depois um resumo com todos os achados.' },
        workThroughEachFile: { title: 'Trabalhar em cada arquivo', description: 'Para cada arquivo de uma lista, um por vez: analisar e revisar a mudança.' },
        repairUntilItPasses: { title: 'Reparar até passar', description: 'Reparar e verificar até passar ou esgotar suas tentativas. Depois você revisa a última correção.' },
        triageAnIssue: { title: 'Classificar uma issue', description: 'Classifique uma issue. Corrija bugs; caso contrário, prepare uma resposta.' },
        morningDigest: { title: 'Resumo da manhã', description: 'Resuma as mudanças do projeto e envie para você. Adicione um gatilho para cada manhã.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pt"> = { pt: { fromPlugins: 'De plugins', readOnly: 'Somente leitura · duplique na sua biblioteca para editar', duplicateToLibrary: 'Duplicar na sua biblioteca' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "pt"> = { pt: { title: "Visibilidade", chooseTeam: "Escolher uma equipe", loadFailed: "Não foi possível verificar quem pode ver esta execução", machines: "Executa nas suas máquinas", transcripts: "Os membros da equipe podem ver as conversas das etapas.", requiredSessionsEditable: "As sessões desta equipe podem ser editadas pelos seus membros", visibleTo: ({ team }) => "Visível para " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "pt"> = { pt: { visibility: workflowRunVisibilityTranslations.pt, runWithAnotherAgent: 'Executar novamente com outro agente', agentForStep: ({ step }) => `Agente para ${step}`, chooseAgent: 'Escolher um agente ou papel' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { pt: {
        definitions: 'Definições',
        stepsProgress: ({ completed, total }: Progress) => `${completed} de ${total} etapas`,
        loopProgress: ({ completed, total }: Progress) => `${completed} de ${total} itens`,
        startedByAgent: 'Iniciado por um agente',
        startedByTrigger: 'Iniciado por um gatilho',
    } } satisfies Pick<Record<string, typeof en>, "pt">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "pt"> = { pt: { rolesTitle: 'Funções para esta execução', rolesYour: 'Suas funções', rolesChanged: ({ count }) => `${count} alteradas para esta execução`, rolesUnchanged: 'Todo o resto permanece igual.', useYourRole: 'Usar sua função', targetsTitle: 'Cada passo é executado em', rolesPrefillFailed: 'Não foi possível ler as funções da sua última execução. Tente novamente.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pt"> = { pt: { ...workflowRunRoleTranslations.pt, ...workflowRunCompositionTranslations.pt, shortcutStarts: 'inicia', neededNamed: ({ name }) => `Entradas · falta ${name}`, addToStart: ({ name }) => `Adicione ${name} para iniciar`, workflow: 'Fluxo de trabalho', inputs: 'Entradas', start: 'Iniciar', starting: 'Iniciando…', stillStarting: 'Ainda iniciando…', needed: ({ count }) => `Entradas · faltam ${count}`, required: 'Necessário para iniciar', preview: 'O que será feito', unsaved: 'Inclui alterações não salvas', remove: 'Voltar a uma sessão normal', search: 'Encontrar um fluxo', builtin: 'Integrados', library: 'Sua biblioteca', noInputs: 'Nenhuma entrada necessária', asksFor: ({ names }) => `Solicita ${names}`, optional: 'Opcional — deixado vazio', defaultValue: ({ value }) => `Padrão: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const pt: WorkflowsDestinationTranslations = {
    description: 'Receitas que seus agentes executam nas suas máquinas — quando você quiser, em um horário ou quando algo acontecer.',
    import: 'Importar',
    addAccessibility: 'Adicionar um fluxo de trabalho',
    moreAccessibility: 'Mais opções de fluxos de trabalho',
    addMenu: {
        newWorkflowSubtitle: 'Comece com um rascunho em branco',
        importSubtitle: 'Um arquivo JSON de fluxo de trabalho',
    },
    sections: {
        needsYou: 'Precisa de você',
        running: 'Em execução',
        library: 'Biblioteca',
        sharedWithYou: 'Compartilhados com você',
        triggers: 'Gatilhos',
        history: 'Histórico',
    },
    allRuns: 'Todas as execuções',
    lastRun: ({ age }) => `última execução ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Última execução' : `Últimas ${count} execuções`}: ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Última execução' : `Últimas ${count} execuções`),
        completed: ({ count }) => `${count} ${count === 1 ? 'concluída' : 'concluídas'}`,
        failed: ({ count }) => `${count} com falha`,
        needsYou: ({ count }) => `${count} ${count === 1 ? 'precisa' : 'precisam'} de você`,
        separator: ', ',
    },
    runSettings: 'Configurações de execução',
    libraryEmpty: 'Os fluxos de trabalho que você salvar aparecem aqui.',
    waitingForYou: ({ age }) => `Aguardando você · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Enviar um prompt',
    thenRunWorkflow: 'Executar um fluxo de trabalho',
    offline: 'Offline',
    off: 'Desativado',
    columnLoadFailed: 'Não foi possível carregar os fluxos de trabalho. Nada do que você salvou foi perdido.',
    firstVisitTitle: 'Salve os prompts que funcionam e execute-os de novo',
    firstVisitBody: 'Um fluxo de trabalho é um conjunto de etapas que seus agentes executam em ordem, lado a lado ou uma vez por item — quando você quiser, em um horário ou quando algo acontecer.',
    importPrompt: 'Tem um arquivo de fluxo de trabalho?',
    loadMoreWorkflows: 'Carregar mais fluxos de trabalho',
    searchPlaceholder: 'Buscar fluxos de trabalho',
    noMatch: ({ query }) => `Nenhum fluxo de trabalho corresponde a “${query}”`,
    views: {
        all: 'Todos',
        triggered: 'Com gatilho',
        active: 'Ativas',
        needsYou: 'Precisa de você',
        libraryAccessibility: 'Quais fluxos de trabalho mostrar',
        historyAccessibility: 'Quais execuções mostrar',
    },
    history: {
        title: 'Histórico',
        description: 'Cada execução que você iniciou, não importa como começou.',
        loadMore: 'Carregar mais execuções',
        loadFailedTitle: 'Não foi possível carregar as execuções',
        loadFailedBody: 'Seu trabalho não foi afetado.',
        review: 'Revisar',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Opções do fluxo de trabalho',
        runNow: 'Executar agora',
        share: 'Compartilhar…',
    },
    deleteTitle: 'Excluir este fluxo de trabalho?',
    deleteFailedTitle: 'Não foi possível excluir o fluxo de trabalho',
    exportFailedTitle: 'Não foi possível exportar o fluxo de trabalho',
    gate: {
        localTitle: 'As automações estão desativadas neste dispositivo',
        localBody: 'Ative-as para executar fluxos de trabalho e seus gatilhos.',
        dependencyTitle: 'Fluxos de trabalho precisam de automações',
        dependencyBody: 'Ative as automações para criar e executar fluxos de trabalho.',
        openSettings: 'Abrir Configurações',
    },
    runSettingsPage: {
        title: 'Configurações de execução',
        description: 'Quantas execuções cada máquina aceita ao mesmo tempo e por quanto tempo o histórico é mantido.',
        saveFailed: 'Não foi possível salvar as configurações de execução. Suas alterações continuam aqui.',
    },
};

const workflowsDestinationTranslations = { pt } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const pt: WorkflowTriggersCopy = {
    activity: {
        create: "Criar um gatilho a partir deste evento",
        test: "Testar este gatilho",
        matched: "Este evento corresponde",
        noMatch: "Este evento não corresponde",
        sourceMismatch: "Este evento veio de outra fonte",
        tooOld: "Este evento é antigo demais para a observação",
        invalid: "Configure o evento antes de testar",
    },
    pullRequest: {
        label: "Pull request",
        description: "Adicionar este gatilho vincula a pull request a esta sessão.",
        empty: "Nenhuma pull request aberta",
        loadFailed: "Não foi possível carregar as pull requests",
    },
    summary: {
        everyDayAt: ({ time }) => `Todos os dias às ${time}`,
        weekdaysAt: ({ time }) => `Dias úteis às ${time}`,
        weeklyAt: ({ day, time }) => `Toda ${day} às ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'A cada minuto' : `A cada ${count} minutos`),
        everyHours: ({ count }) => (count === 1 ? 'A cada hora' : `A cada ${count} horas`),
        cron: ({ expression }) => `Em um horário · ${expression}`,
        schedule: 'Em um horário',
        event: ({ event }) => `Quando ${event} acontece`,
        manual: 'Manual',
        more: ({ first, count }) => `${first} · mais ${count}`,
    },
    kind: {
        pluginEvent: "Evento de plugin",
        sessionStarts: 'Quando a sessão começa',
        sessionArchived: 'Quando a sessão é arquivada',
        schedule: 'Em um horário',
        prComment: 'Quando alguém comenta em um pull request',
        ciFailed: 'Quando a CI falha em um pull request',
        turnEnds: 'Quando um turno termina',
        needsYou: 'Quando a sessão precisa de você',
        runEnds: 'Quando a execução termina',
        runNeedsYou: 'Quando a execução precisa de você',
    },
    row: {
        workflowDeleted: 'Fluxo excluído',
        legacyCreated: 'Criado no Happier 0.2',
        legacyUnavailable: 'Gatilho antigo indisponível',
        sessionKeyRequired: 'Chave da sessão necessária',
        templateRecoveryRequired: 'Recupere este gatilho em Segurança da conta',
        templateDecryptionFailed: 'Não foi possível descriptografar o gatilho',
        machines: ({ count }: Count) => `${count} máquinas`,
        nextRun: ({ time }: { time: string }) => `Próxima execução: ${time}`,
        nextMinutes: ({ count }: Count) => `em ${count} min`,
        nextHours: ({ count }: Count) => `em ${count} h`,
        nextDays: ({ count }: Count) => count === 1 ? 'amanhã' : `em ${count} dias`,
        steps: ({ count }) => (count === 1 ? `${count} passo` : `${count} passos`),
        off: 'Desligado',
        running: 'Em execução',
        ran: ({ age }) => `Executado ${age}`,
        turnOn: ({ name }) => `Ligar ${name}`,
        turnOff: ({ name }) => `Desligar ${name}`,
    },
    section: {
        add: 'Adicionar um gatilho',
        emptyTitle: 'Nenhum gatilho',
        emptyBody: 'Adicione um para revisar cada turno, continuar em direção a um objetivo ou reagir ao pull request.',
        loadFailed: 'Não foi possível carregar os gatilhos desta sessão.',
        title: 'Gatilhos',
        countOn: ({ count }) => `${count} ligados`,
        info: 'O que é executado nesta sessão quando algo acontece. Eles ficam com esta sessão e não aparecem na sua biblioteca.',
        saveFailed: 'Não foi possível salvar este gatilho. Suas alterações ainda estão aqui.',
    },    kindDescription: {
        pluginEvent: "Executar quando um plugin observar um evento.",
        turnEnds: 'Depois de um turno seu ou de um agente com quem você trabalha.',
        needsYou: 'Sempre que esta sessão espera por você, inclusive enquanto um fluxo ou Continuar até terminar a conduz.',
        sessionArchived: 'Executa uma vez, quando você arquiva esta sessão.',
        sessionStarts: 'Apenas ao criar uma sessão.',
        schedule: 'Continua esta sessão em um horário.',
        prComment: 'Apenas pessoas com acesso de escrita. O comentário é passado como texto citado.',
        pullRequestUnavailable: 'Gatilhos de pull request ainda não podem ser adicionados aqui.',
    },
    then: {
        runsIn: 'Executa em',
        runsInChoice: {
            newSession: 'Uma nova sessão',
            session: 'Uma sessão…',
            backgroundRun: 'Uma execução em segundo plano',
        },
        noSessionOnMachine: 'Ainda não há sessões nesta máquina',
        session: 'Sessão',
        action: 'Ação',
        label: 'Então',
        sendPrompt: 'Enviar um prompt',
        doAction: 'Fazer uma ação',
        notifyMe: 'Notificar-me',
        runWorkflow: 'Executar um fluxo',
        sendPromptDescription: 'O agente desta sessão recebe este prompt nesta sessão. Ele nunca interrompe o seu turno.',
        promptLabel: 'Prompt',
        promptPlaceholder: 'O que o agente deve fazer?',
        message: 'Mensagem',
        title: 'Título',
        sendTo: 'Enviar para',
        sendToDefault: 'Suas configurações de notificação',
        workflow: 'Fluxo',
        choose: 'Escolher…',
    },
    popover: {
        configureEvent: "Configurar evento",
        editEvent: "Editar evento",
        saveAsWorkflow: 'Salvar como fluxo',
        saveAsWorkflowDescription: 'Abre estes passos como um novo fluxo para revisar. Este gatilho mantém os próprios passos.',
        when: 'Quando',
        newTrigger: 'Novo gatilho',
        addTrigger: 'Adicionar gatilho',
        cancel: 'Cancelar',
        done: 'Concluído',
        turnOff: 'Desligar',
        turnOn: 'Ligar',
        deleteTrigger: 'Excluir gatilho',
        repeat: 'Repetir',
        everyDay: 'Todos os dias',
        weekdays: 'Dias úteis',
        weekly: 'Semanal',
        day: 'Dia',
        at: 'Às',
        expression: 'Horário',
        tryAgain: 'Tentar novamente',
    },    editor: {
        runsOn: 'Executa em',
        runsOnDescription: 'Todos os gatilhos deste fluxo executam aqui.',
        runsOnAccountDescription: 'Onde este gatilho executa.',
        runsOnDiffers: ({ where }) => `Executar agora usa ${where} em vez disso.`,
        sameForAllTriggers: 'Igual para todos os gatilhos',
        roles: 'Funções',
        retargetFailed: 'Fluxo salvo · Gatilho não atualizado',
        editInWorkflows: 'Altere este gatilho em Fluxos. Ele continua sendo executado como está.',
        title: 'Executa automaticamente',
        runsBy: 'Executa sozinho quando uma destas coisas acontece.',
        runsByOn: ({ where }) => `Executa sozinho quando uma destas coisas acontece, em ${where}.`,
        savedWorkflow: 'Os gatilhos executam o fluxo salvo.',
        saveToInclude: 'Os gatilhos executam o fluxo salvo. Salve para incluir suas alterações.',
        newRow: 'Novo · ainda não adicionado',
        partialSave: 'Fluxo salvo · Gatilhos não atualizados',
    },    column: {
        newTrigger: 'Novo gatilho',
        newTriggerSubtitle: 'Executa os próprios passos em um horário',
    },
};

const legacyTranslations = { pt: {
        editNotice: 'Criado no Happier 0.2. Abrir não altera nada.',
        conversionBoundary: 'Após esta alteração, ela só funciona em máquinas com Happier 0.3 ou posterior.',
        reviewRequired: 'Precisa da sua revisão',
        reviewConversionNotice: 'Ao salvar, o workflow é armazenado sem criptografia de ponta a ponta e seus gatilhos habilitados são retomados. A sessão continua criptografada de ponta a ponta.',
        channelReplyRefusal: 'Esta automação tem um vínculo de resposta a um canal que não pode ser transferido. Não foi convertida; suas configurações e suas alterações continuam intactas.',
        notAvailable: 'Esta automação não está mais disponível.',
    } };

const creationTranslations = { pt: { savedWorkflowsUnavailable: 'Mude para o servidor desta sessão para escolher um fluxo salvo. Os fluxos integrados e os passos próprios continuam disponíveis.' } };

const workflowTriggersTranslations = { pt: { ...pt, legacy: legacyTranslations.pt, creation: creationTranslations.pt } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { pt: {
        checkoutRoot: 'Pasta raiz do checkout',
        unavailableValue: 'Valor indisponível', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Contexto da sessão' : turns === 1 ? 'Último turno da sessão' : `Últimos ${turns} turnos da sessão`,
        tokensUsed: 'Tokens utilizados', goalTokenBudget: 'Orçamento de tokens do objetivo',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${source} consecutivos correspondentes a ${value}`,
        stopCondition: 'Condição de paragem cumprida', stopConditionArm: ({ arm }: { arm: number }) => `Condição de paragem ${arm} cumprida`,
        roundLimit: ({ rounds }: { rounds: number }) => `Limite atingido · ${rounds} rondas`, decision: 'Decisão',
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

const pt = translated(workflowValueReferenceTranslations.pt, {
    testRun: {
        title: "Execução de teste",
        savedNotice: "Executa a versão salva de verdade. As alterações não salvas ficam aqui.",
        resultsNotice: "Resultados da versão salva · última execução. As alterações não salvas não foram executadas.",
        recordedDuration: ({ seconds }) => `Tempo decorrido registrado · ${seconds} s`,
        loading: "Carregando os resultados do teste…",
    },
    runWhen: {
        title: "Executar quando",
        success: "Sucesso",
        failure: "Falha",
        always: "Sempre",
        ifSuccess: "Se tiver sucesso",
        ifFailure: "Se falhar",
        regardless: "Em qualquer caso",
        previousStep: "Em relação à etapa anterior",
    },
    title: 'Fluxos de trabalho',
    newWorkflow: 'Novo fluxo de trabalho',
    copyName: ({ name }: { name: string }) => `${name} cópia`,
    importJson: 'Importar JSON',
    exportJson: 'Exportar JSON',
    openCollection: 'Abrir os fluxos de trabalho',
    destination: workflowsDestinationTranslations.pt,
    plugins: workflowPluginTranslations.pt,
    authoring: workflowAgentAuthoringTranslations.pt,
    page: workflowEditorPageTranslations.pt,
    actionTitles: workflowActionTranslations.pt,
    builtins: workflowBuiltinTranslations.pt,
    examples: workflowExamplesTranslations.pt,
    triggers: workflowTriggersTranslations.pt,
    start: workflowStartTranslations.pt,
    list: workflowRunListTranslations.pt,
    review: {
        publishedByAgent: 'Publicado pelo agente',
        publishedByYou: 'Publicado por ti',
        editedByYou: 'Editado por ti',
        editedByPerson: 'Editado por outra pessoa',
        previousAttempt: 'Tentativa anterior',
        useBody: "As próximas etapas recebem exatamente o que você vê. Sem turno do agente.",
        usePlanBody: "Aceita exatamente este plano. Sem turno do agente.",
        reportBackTitle: ({ session }) => "Reportar para " + session,
        reportBackBody: ({ session }) => session + " recebe o resultado desta execução ao terminar.",
        planRunNotice: "Executa o fluxo proposto exatamente como mostrado e aceita o plano. Não o salva.",
        editedPlanBody: 'Este rascunho difere da proposta. Aceitar primeiro o plano revisado para edição? Suas alterações ficam aqui e nada começa até você executar o rascunho novamente.',
        title: "Resultado para revisar",
        planTitle: "Plano para revisar",
        waitTitle: "Esperando por você",
        waitBody: "Este ramo espera até você continuar.",
        editsTitle: "Suas alterações não salvas",
        editsBody: "O resultado salvo permanece como está até você usá-lo.",
        heldBody: "Esperando sua revisão · ainda não enviado às próximas etapas",
        noValue: "Ainda não há resultado válido",
        useResult: "Usar este resultado",
        usePlan: "Usar este plano",
        useValues: "Usar estes valores",
        continue: "Continuar",
        invalid: "Corrija primeiro o campo destacado.",
        newer: "Há um resultado mais recente.",
        showNewer: "Mostrar o novo",
        keepMyEdits: 'Manter minhas alterações',
        useNewer: 'Usar o novo',
        showFullResult: 'Mostrar o resultado completo',
        showFullPlan: 'Mostrar o plano completo',
        generationRequested: "Geração solicitada",
        startsResume: "Começa quando você retoma a execução.",
        generateBody: "O agente escreve um novo resultado nesta conversa. Se for válido, a execução continua sem perguntar novamente.",
        acceptedPaused: "Usar este resultado mantém o fluxo pausado.",
        editResult: "Editar resultado",
        generate: "Gerar resultado e continuar",
        discuss: "Conversar",
        discussBody: "Responda na conversa desta etapa. O agente pode publicar aqui um resultado atualizado.",
        proposal: "Fluxo proposto",
        planStarted: "Uma execução deste plano foi iniciada",
        earlierPlanStarted: "Já foi iniciada uma execução de uma proposta anterior",
        openEarlierPlanRun: "Abrir essa execução",
        runNewProposal: "Executar a nova proposta",
        runPlan: "Executar como fluxo",
        runPlanBody: "Abre a revisão do fluxo proposto. Iniciá-lo também aceita este plano.",
        editPlan: "Editar o fluxo primeiro",
        editPlanBody: "Aceita este plano e abre o fluxo proposto como rascunho não salvo.",
        editPlanFallback: "Aceita este plano e abre um fluxo de uma etapa com este plano como instrução.",
        waitingMachine: ({ machine }) => "Esperando por " + machine,
    },

    tabs: {
        saved: 'Salvos',
        runs: 'Execuções',
        steps: 'Etapas',
        flow: 'Fluxo',
        map: 'Mapa',
        activity: 'Atividade',
    },
    tabsAccessibility: {
        savedRuns: 'Fluxos de trabalho salvos ou execuções',
        stepsFlow: 'Etapas ou fluxo',
        activityFlow: 'Atividade ou fluxo',
        runViews: "Visualizações da execução",
    },

    filters: {
        all: 'Tudo',
        active: 'Ativos',
        needsYou: 'Precisa de você',
        clear: 'Limpar o filtro',
    },

    empty: {
        savedTitle: 'Ainda não há fluxos de trabalho salvos',
        savedBody: 'Salvar um fluxo de trabalho guarda uma definição reutilizável que você pode executar ou agendar.',
        runsTitle: 'Nada foi executado ainda',
        runsBody: 'As execuções aparecem aqui, você salvando o fluxo de trabalho ou não.',
        filteredTitle: 'Nenhuma execução corresponde a este filtro',
        filteredBody: 'Limpe o filtro para ver o restante das suas execuções.',
        missingTitle: 'Este fluxo de trabalho não está disponível',
        missingBody: 'O Happier não conseguiu abrir o fluxo de trabalho para o qual este link aponta. Seus outros fluxos, Automações e execuções não são afetados.',
    },

    loadFailedTitle: 'Não foi possível carregar os fluxos de trabalho',
    loadFailedBody: 'Seu trabalho não foi afetado. Tente de novo quando quiser.',
    retry: 'Tentar de novo',
    contentUnavailable: 'O conteúdo privado não está disponível neste dispositivo.',
    readState: {
        historyTitle: 'Não é possível ler o histórico',
        historyBody: 'Esta execução foi registada numa versão de desenvolvimento anterior do Happier, por isso não é possível abrir o histórico. Inicie uma nova execução para continuar.',
        encryptionTitle: 'É necessário configurar a encriptação',
        encryptionBody: 'Este conteúdo está encriptado de ponta a ponta. Configure a encriptação desta conta para o abrir.',
        keysTitle: 'À espera das chaves',
        keysBody: 'Este dispositivo ainda não tem as chaves de encriptação desta execução. Tente novamente quando estiverem disponíveis.',
        storageTitle: 'O armazenamento de execuções está indisponível',
        storageBody: 'O Happier não conseguiu aceder ao armazenamento de execuções. Verifique a ligação e tente novamente.',
        openSettings: 'Abrir definições',
    },
    contentReasons: {
        invalidHeader: 'As informações salvas deste fluxo de trabalho são inválidas.',
        revisionMismatch: 'Este fluxo de trabalho não corresponde à revisão salva.',
        missingBody: 'A definição salva deste fluxo de trabalho está ausente.',
        invalidBody: 'A definição salva deste fluxo de trabalho é inválida.',
        notFound: 'Este fluxo de trabalho não está mais disponível.',
    },

    sessionEntry: {
        missingTitle: 'Esta sessão já não está disponível',
        missingBody: 'Pode ter sido eliminada ou estar noutro Home. Abra Sessões para a encontrar.',
        inaccessibleTitle: 'Não é possível abrir esta sessão',
        inaccessibleBody: 'O Happier não conseguiu confirmar o acesso. Inicie sessão novamente ou peça a quem é proprietário e volte a abrir esta página.',
        failedTitle: 'Não foi possível abrir esta sessão',
        failedBody: 'O Happier continua a tentar. Pode tentar de novo agora.',
        unsupportedTitle: 'Esta sessão não pode iniciar um fluxo de trabalho',
        unsupportedBody: 'O Happier não conseguiu ler o agente e a máquina onde corre. Crie o fluxo de trabalho a partir de Fluxos de trabalho.',
    },

    editor: {
        namePlaceholder: 'Nome do fluxo de trabalho',
        agentRuntime: 'Runtime do agente',
        firstPromptTitle: 'O que deve acontecer primeiro?',
        firstPromptBody: 'Um único prompt já é um fluxo de trabalho. Adicione etapas quando precisar.',
        promptPlaceholder: 'Descreva o que esta etapa deve fazer',
        useWorkflowDefault: 'Usar o padrão do fluxo de trabalho',
        defaultsTitle: 'Padrões',
        produces: 'Produz',
        whereTitle: 'Onde',
        add: 'Adicionar',
        addAccessibility: 'Adicionar um bloco a este fluxo de trabalho',
        addStep: 'Passo do agente',
        addParallel: 'Lado a lado',
        addLoop: 'Repetir',
        addIf: 'Se',
        targetRequired: 'Escolha a máquina e a pasta do projeto para este fluxo de trabalho.',
        loadingTitle: 'A abrir o fluxo de trabalho…',
        accountChangedTitle: 'Mudaste de conta',
        accountChangedBody: 'Este fluxo de trabalho foi aberto pela conta anterior e não pode ser transferido. Abre-o novamente em Fluxos de trabalho.',
        loadFailedTitle: 'Não foi possível abrir este fluxo de trabalho',
        loadFailedBody: 'De momento não foi possível ler o fluxo de trabalho guardado.',
        timeoutTitle: 'Espera pelo resultado (ms)',
        noDeadline: 'Sem prazo',
        timeoutExplain: 'Milissegundos de espera pelo resultado desta etapa antes de precisar de atenção. Deixe vazio para não definir prazo.',
        wholeNumberRequired: 'Digite um número inteiro de pelo menos 1.',
        runNow: 'Executar agora',
        save: 'Salvar o fluxo de trabalho',
        saveAutomation: 'Salvar a Automação',
        schedule: 'Agendar',
        savedRevision: ({ revision }) => `Salvo · ${revision}`,
        moveUp: 'Mover para cima',
        moveDown: 'Mover para baixo',
        moveIn: 'Mover para o grupo acima',
        moveOut: 'Tirar deste grupo',
        remove: 'Remover',
        undo: 'Desfazer',
        redo: 'Refazer',
        historyRestoreRequiresSetup: 'Este evento precisa ser configurado novamente. A configuração privada salva não pode ser restaurada após a exclusão.',
        history: { edited: 'Editar workflow', agent: 'Alteração do agente', description: 'Editar descrição', where: 'Alterar local de execução', target: 'Alterar execução das etapas', triggers: 'Editar gatilhos', example: 'Inserir exemplo', document: 'Editar prompt', renameWorkflow: 'Renomear workflow', renameStep: 'Renomear etapa', renameLane: 'Renomear ramo' },
        undoAction: ({ change }: { change: string }) => `Desfazer: ${change}`,
        redoAction: ({ change }: { change: string }) => `Refazer: ${change}`,
        removedBlock: ({ block }) => `${block} removido`,
        rename: 'Renomear',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Etapa ${position}`,
        unnamedParallel: 'Grupo paralelo',
        unnamedLoop: 'Laço',
        unnamedIf: 'Condição',
        branch: 'Ramo',
        addBranch: 'Adicionar uma faixa',
        ifTrue: 'Então',
        otherwise: 'Caso contrário',
        addOtherwise: 'Adicionar um ramo “caso contrário”',
        evaluator: 'Decidir se continua',
        loopBody: 'Repetir estas etapas',
        continuation: 'Depois de cada rodada',
    },

    input: {
        label: 'Entrada',
        result: 'Resultado',
        change: 'Alterar',
        none: 'Sem entrada',
        previousResult: ({ block }) => `Resultado de ${block}`,
        workflowInput: ({ name }) => `Entrada do fluxo de trabalho ${name}`,
        currentItem: 'O item atual',
        iteration: 'Esta rodada',
        unavailable: 'Esta origem não está mais disponível',
        itemField: {
            value: 'Valor do item',
            index: 'Índice do item, a partir de 0',
            position: 'Posição do item, a partir de 1',
            count: 'Quantidade de itens',
        },
        iterationField: {
            index: 'Índice da rodada, a partir de 0',
            position: 'Número da rodada, a partir de 1',
            count: 'Quantidade de rodadas',
            stopReason: 'Motivo da parada',
        },
        valueKindGroup: 'Origem do valor',
        inputNameGroup: 'Entrada do fluxo',
        producerGroup: 'Passo de origem',
        workspaceFieldGroup: 'Campo do espaço de trabalho',
        itemFieldGroup: 'Campo do item',
        iterationFieldGroup: 'Campo da rodada',
    },

    inputs: {
        title: 'Entradas do fluxo de trabalho',
        addInput: 'Adicionar uma entrada',
        namePlaceholder: 'Nome',
        descriptionPlaceholder: 'Para que isto serve?',
        required: 'Obrigatório',
        optional: 'Opcional',
        defaultValue: 'Valor padrão',
        typeString: 'Texto',
        typeNumber: 'Número',
        typeBoolean: 'Sim ou não',
        typeJson: 'Dados estruturados',
        runSheetTitle: 'Executar este fluxo de trabalho',
        runSheetBody: 'Informe os valores que este fluxo de trabalho declara e execute-o.',
        missingRequired: 'Este valor é obrigatório.',
        wrongType: ({ type }) => `Este valor precisa ser do tipo ${type}.`,
    },

    finalOutput: {
        title: 'Resultado final',
        none: 'Nenhum resultado final selecionado',
        change: 'Alterar',
        clear: 'Limpar a seleção',
        fieldPath: 'Caminho do campo',
        explain: 'O que este fluxo de trabalho devolve quando termina.',
    },

    conversation: {
        title: 'Conversa',
        sharedRun: 'A mesma conversa',
        branchesShareAndTakeTurns: 'Os ramos compartilham uma conversa e se alternam.',
        fresh: 'Conversas separadas',
        fromStep: ({ block }) => `Continuar ${block}`,
        existingSession: 'Uma sessão existente',
        existingSessionById: ({ sessionId }) => `Sessão ${sessionId}`,
        noExistingSessions: 'Nenhuma sessão desta máquina pode ser continuada aqui.',
        chooseExistingSession: 'Escolha uma sessão para continuar',
        continuingKeepsAgentAndFolder: 'Continuar mantém o Agente e a pasta dessa conversa. Outro Agente ou outra pasta precisa de uma conversa separada.',
        waitingForConversation: ({ block }) => `Aguardando ${block} terminar nesta conversa.`,
        branchesUseSeparate: 'Os ramos de um grupo paralelo usam conversas separadas.',
    },

    workspace: {
        title: 'Espaço de trabalho',
        inherit: 'Espaço de trabalho do fluxo',
        projectCheckout: 'Pasta do projeto',
        fromStep: ({ block }) => `Continuar no espaço de trabalho de ${block}`,
        newWorktreeOriginal: 'Novo worktree a partir da pasta original',
        newWorktreeWorkflow: 'Novo worktree a partir do espaço de trabalho do fluxo',
        newWorktreeStep: ({ block }) => `Novo worktree a partir de ${block}`,
        committedOnlyNote: 'Um worktree novo contém o estado commitado da pasta de origem. As alterações no stage, não commitadas e não rastreadas ficam na origem.',
        reuseNote: 'Ao continuar em um espaço de trabalho, ele vê os arquivos não commitados exatamente como estão.',
        sharedParallelNote: 'Ramos que compartilham um espaço de trabalho podem escrever nele ao mesmo tempo.',
        unavailable: ({ block }) => `O espaço de trabalho de ${block} não está disponível.`,
        unavailableBody: 'Restaure-o para continuar esta execução, ou avalie uma nova execução que pode repetir trabalho já concluído.',
        unavailableRestoreBody: 'Restaura-o para continuar esta execução com o trabalho já concluído intacto.',
        unavailableNewRunBody: 'Não pode ser restaurado. Uma nova execução revista começa do início e o trabalho já concluído pode repetir-se.',
        restore: 'Restaurar',
        inspect: 'Inspecionar',
    },

    condition: {
        onlyWhen: 'Executar somente quando',
        always: 'Sempre',
        stopWhen: 'Parar quando',
        ifWhen: 'Executar o primeiro ramo quando',
        addCondition: 'Adicionar uma condição',
        removeCondition: 'Remover a condição',
        allOf: 'Todas estas',
        anyOf: 'Qualquer uma destas',
        not: 'Não',
        exists: 'tem um valor',
        operatorEq: 'é',
        operatorNeq: 'não é',
        operatorLt: 'é menor que',
        operatorLte: 'é no máximo',
        operatorGt: 'é maior que',
        operatorGte: 'é pelo menos',
        notFirstRound: 'não é a primeira rodada',
        trailingCountAtLeast: ({ source, value, count }) => `${source} é ${value} ${count} vezes seguidas`,
        loopRanOutOfRounds: ({ loop }) => `${loop} ficou sem rodadas`,
        loopEnded: ({ loop, outcome }) => `${loop} terminou: ${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${loop} parou porque ${condition}`,
        valuePlaceholder: 'Valor',
        literalPlaceholder: 'Digite um valor',
        skippedReason: ({ block }) => `Ignorado porque a condição de ${block} era falsa.`,
    },

    loop: {
        modeTitle: 'Repetir',
        modeCount: 'Um número fixo de vezes',
        modeItems: 'Uma vez para cada item',
        modeUntil: 'Até um resultado mandar parar',
        modeEvaluate: 'Até um Agente mandar parar',
        count: 'Número de vezes',
        items: 'Lista',
        sequential: 'Itens em sequência',
        parallel: 'Itens em paralelo',
        maxConcurrentItems: 'Máximo de itens simultâneos',
        maxConcurrentBranches: 'Máximo de ramos simultâneos',
        noWorkflowLimit: 'O fluxo de trabalho não define nenhum limite',
        maxIterations: 'Máximo de rodadas',
        limitReached: 'Limite atingido',
        historyTitle: 'Avaliações anteriores',
        historyNone: 'Nenhuma',
        historyLatest: 'A mais recente',
        historyAll: 'Todas',
        historyExplain: 'Isto seleciona as decisões e os comentários salvos, não as transcrições inteiras.',
        continuingConversation: 'Este avaliador mantém a conversa anterior e acrescenta cada nova rodada.',
        emptyListCompletes: 'Uma lista vazia termina sem nenhuma rodada.',
    },

    failurePolicy: {
        title: 'Se uma etapa falhar',
        failStop: 'Parar este grupo em caso de falha',
        failStopExplain: 'Este grupo deixa de iniciar trabalho e pede que os ramos ativos parem, inclusive os independentes. Os resultados e as alterações já concluídos permanecem. Isto não é uma reversão.',
        collectOutcomes: 'Concluir o trabalho independente',
        collectOutcomesExplain: 'Os ramos saudáveis concluem toda a sua cadeia e cada resultado é coletado. As etapas posteriores a uma falha dentro de um ramo não são executadas.',
    },

    runState: {
        pending: 'Aguardando para começar',
        queued: 'Aguardando para começar',
        claimed: 'Começando',
        running: 'Em execução',
        waiting_for_review: 'Aguardando sua revisão',
        succeeded: 'Concluído',
        failed: 'Falhou',
        cancel_requested: 'Parando',
        cancelled: 'Parado',
        pause_requested: 'Pausando',
        paused: 'Pausado',
        interrupted: 'Interrompido',
        expired: 'Expirou antes de começar',
        dispatch_failed: 'Não foi possível começar',
        skipped: 'Ignorado',
        missed: 'Perdido',
        outcome_uncertain: 'Resultado incerto',
        completed: 'Concluído',
        completed_with_failures: 'Concluído com falhas',
    },

    invocationState: {
        pending: 'Aguardando',
        waiting_for_capacity: 'Aguardando capacidade',
        admitting: 'Iniciando',
        running: 'Em execução',
        waiting_for_approval: 'Aguardando aprovação',
        waiting_for_review: 'Aguardando sua revisão',
        needs_attention: 'Precisa de você',
        completed: 'Concluído',
        failed: 'Falhou',
        skipped: 'Ignorado',
        cancel_requested: 'Parando',
        cancelled: 'Parado',
        outcome_uncertain: 'Resultado incerto',
        superseded: 'Substituído por uma tentativa posterior',
    },

    run: {
        title: 'Execução',
        frozenVersion: "Esta execução usa a versão com que começou. As alterações afetam apenas execuções futuras.",
        selectOccurrence: 'Escolher um passo',
        openReview: 'Rever resultado',
        open: 'Abrir execução',
        openExact: ({ title }) => `Abrir a execução ${title}`,
        openExecution: 'Abrir a execução em segundo plano',
        loadMore: 'Carregar etapas anteriores',
        origin: {
            direct: 'Iniciada diretamente',
            automation: 'Agendada',
            fromSession: 'A partir de uma sessão',
        },
        needsYou: 'Precisa de você',
        needsYouLoadedCount: 'carregadas',
        review: 'Revisar',
        stop: 'Parar',
        stopAgain: 'Parar novamente',
        stopping: 'Parando…',
        stopRequested: ({ machine }) => `Parada solicitada. Aguardando a confirmação de ${machine}.`,
        evidenceStale: 'Mostrando os últimos detalhes conhecidos. O Happier não conseguiu confirmar se estão atuais.',
        pauseAtBoundary: 'Pausar no próximo limite',
        pausePending: 'Terminando o trabalho atual e depois pausando.',
        paused: 'Pausado após o último limite concluído.',
        resume: 'Retomar',
        runAgain: 'Executar o fluxo de trabalho de novo',
        retryStep: 'Repetir a etapa',
        attempt: ({ attempt }) => `Tentativa ${attempt}`,
        untitled: 'Execução do fluxo',
        openResult: 'Abrir o resultado',
        inspectSteps: 'Inspecionar as etapas',
        seeFailures: 'Ver as falhas',
        saveAsWorkflow: 'Salvar como fluxo de trabalho',
        saveAsNewWorkflow: 'Salvar como novo fluxo de trabalho',
        showCurrentWork: 'Mostrar trabalho atual',
        editWorkflow: 'Editar fluxo de trabalho',
        openWorkflow: 'Abrir fluxo de trabalho',
        deleteHistory: 'Excluir o histórico de execuções',
        deleteHistoryConfirm: 'As entradas e os resultados são removidos. Espaços de trabalho, conversas, fluxos de trabalho salvos e Automações permanecem.',
        technicalDetails: 'Detalhes técnicos',
        technical: {
            runId: 'ID da execução',
            invocationId: 'ID da etapa',
            machine: 'Máquina',
            machineId: 'ID da máquina',
            revision: 'Revisão',
        },
        usageUnavailable: 'Uso indisponível',
        startedAt: ({ time }: { time: string }) => `Iniciado ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Abrir conversa',
        openChildRun: 'Abrir a sua execução',
        openStepDetails: 'Abrir detalhes',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} aguarda sua revisão`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} está esperando por você`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} aguarda sua revisão.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} está esperando por você.`,
        reviewing: 'Revisando',
        notStarted: 'Não iniciado',
        machineUnavailable: ({ machine }) => `Esta execução perdeu o contato com ${machine}.`,
        machineUnavailableBody: 'As opções para retomar vão aparecer quando o estado atual for conhecido.',
        completedCount: ({ count }) => `${count} ${count === 1 ? 'etapa concluída' : 'etapas concluídas'}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Concluído com falhas. ${completed} ${completed === 1 ? 'concluído' : 'concluídos'}; ${failed} não ${failed === 1 ? 'conseguiu' : 'conseguiram'} terminar.`,
        approvalWanted: ({ block }) => `${block} quer executar um comando.`,
        approvalWantedBody: 'Revise para continuar.',
        capacityOccupied: 'Todas as vagas definidas no fluxo de trabalho estão ocupadas.',
        openSourceSession: 'Abrir a sessão de onde veio',
        observedActivity: 'Atividade observada',
        observedActivityBody: 'O Happier consegue ver as fases e os agentes deste agente, mas ele não foi iniciado como um fluxo de trabalho gerenciado, então não pode ser editado, salvo nem executado de novo.',
    },

    recovery: {
        title: 'Revisar a recuperação',
        reattach: 'Reconectar',
        reattachExplain: 'Acompanha o trabalho que já está em andamento. Não inicia nada novo.',
        resumeSameConversation: 'Retomar',
        resumeSameConversationExplain: ({ block }) => `${block} pode continuar na mesma conversa.`,
        freshAgent: 'Continuar com um Agente novo',
        freshAgentExplain: 'Esta conversa não pode ser continuada. O espaço de trabalho está disponível para um Agente novo.',
        uncertainEffects: ({ block }) => `${block} parou antes de relatar. Ele pode já ter alterado o espaço de trabalho.`,
        acknowledgeEffects: 'Entendo que alterações anteriores podem já ter acontecido',
        waitingForStop: 'Aguardando a parada ou a confirmação',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'etapa relacionada ainda não começou' : 'etapas relacionadas ainda não começaram'}`,
        startReviewedRun: 'Iniciar uma nova execução revisada',
        editContinuation: 'Rever ou editar a continuação',
        continuationPlaceholder: 'Acrescenta o que esta etapa deve fazer de forma diferente',
        useReplacementInput: 'Substituir a entrada da etapa',
        repeatedEffectWarning: 'O trabalho já concluído pode se repetir. A execução original mantém o histórico dela.',
    },

    unavailable: {
        title: 'Os fluxos de trabalho não estão disponíveis',
        body: 'Os fluxos de trabalho não estão disponíveis neste servidor, por isso não dá para criar nem executar um aqui.',
        conversion: 'Estas alterações precisam do formato de fluxo de trabalho, e os fluxos de trabalho não estão disponíveis neste servidor. Mantém esta automação num único prompt ou tenta de novo quando estiverem disponíveis.',
        savedAutomation: 'Esta automação é executada como fluxo de trabalho. Os passos guardados ficam exatamente como estão; ainda podes editar o nome, a descrição e os acionadores.',
    },
    conversion: {
        title: 'Estas mudanças precisam do formato de fluxo de trabalho',
        automationTarget: 'Fluxo de trabalho',
        body: 'Esta automação ainda executa um único prompt no destino salvo. Converter mantém suas edições e faz as próximas execuções rodarem como fluxo de trabalho em uma máquina exata. As execuções anteriores não mudam.',
        action: 'Converter em fluxo de trabalho',
        machineRequired: 'Escolha a máquina e a pasta do projeto para as próximas execuções.',
    },
    save: {
        conflictTitle: 'Uma versão mais recente foi salva',
        conflictBody: 'Suas edições continuam aqui.',
        compare: 'Comparar',
        saveAsCopy: 'Salvar como cópia',
        failedTitle: 'Não foi possível salvar',
        failedBody: 'Seu trabalho local continua aqui.',
        deleteTitle: 'Excluir este fluxo de trabalho?',
        deleteBody: 'As Automações e as execuções existentes não são afetadas e continuam funcionando.',
        unsupportedAttachment: 'Anexe as mídias por uma referência durável antes de salvar este fluxo de trabalho.',
        nameRequired: 'Dê um nome a este fluxo de trabalho antes de salvá-lo.',
        runsCurrentDraft: 'Esta execução usa o fluxo de trabalho como ele está na tela. Ela não o salva.',
    },

    interchange: {
        importTitle: 'Importar um fluxo de trabalho',
        importBody: 'A importação abre um rascunho não salvo para você revisar. Ela não executa nem agenda nada.',
        importIssuesTitle: 'Revisar este fluxo de trabalho',
        importIssuesBody: 'Algumas configurações precisam da sua atenção antes que este fluxo de trabalho possa ser usado.',
        openRepairDraft: 'Abrir rascunho para correção',
        importFailedTitle: 'Não foi possível ler esse arquivo',
        importFailedInvalidJson: 'Esse arquivo não é um JSON válido.',
        importFailedUnsupportedVersion: 'Esse arquivo usa uma versão de fluxo de trabalho que este app não suporta.',
        importFailedInvalidDocument: 'Esse arquivo não é um fluxo de trabalho do Happier.',
        exportPrivacyNote: 'O arquivo exportado contém prompts e configurações. Ele nunca contém credenciais nem resultados de execução.',
    },

    issue: {
        invalid_version: 'Este fluxo de trabalho usa uma versão sem suporte.',
        unknown_field: 'Este bloco tem uma configuração que este fluxo de trabalho não suporta.',
        invalid_id: 'Este bloco precisa de um identificador válido.',
        duplicate_id: 'Dois blocos têm o mesmo identificador.',
        missing_reference: 'Esta entrada aponta para um bloco que não existe mais.',
        invalid_reference_scope: 'Esta entrada aponta para um bloco que não termina antes.',
        invalid_input: 'Este valor não é válido.',
        missing_required_input: 'Falta um valor obrigatório.',
        invalid_result_contract: 'As configurações de resultado desta etapa não são válidas.',
        invalid_condition: 'Esta condição não pode ser comparada.',
        invalid_repetition: 'Este laço não pode se repetir com essa configuração.',
        invalid_max_concurrent: 'A concorrência máxima precisa de um número inteiro de pelo menos 1 e vale apenas para trabalho em paralelo.',
        unsupported_persisted_attachment: 'As mídias anexadas precisam de uma referência durável antes de salvar.',
        conversation_workspace_mismatch: 'Esta conversa e este espaço de trabalho não podem continuar juntos.',
        target_unavailable: 'Escolha um Agente para este fluxo de trabalho antes de executá-lo.',
        emptyPrompt: 'Escreva o que esta etapa deve fazer.',
        emptyWaitPrompt: 'Escreva o que você deve verificar ou decidir aqui.',
        fieldMissing: ({ field }) => `${field} é obrigatório.`,
        fieldInvalid: ({ field }) => `${field} precisa de um valor válido.`,
    },

    problem: {
        title: 'Isso não funcionou',
        waitingTitle: 'Ainda não é possível',
        subtreeDenied: 'Um agente só pode iniciar trabalho na sua própria sessão ou em sessões que lidera.',
        roleTargetUnavailable: 'Este papel não pode ser usado aqui.',
        roleRunsAsMismatch: 'A forma como este papel é executado não é compatível com este passo. Escolhe outro papel ou altera a forma de execução do passo.',
        policyDeniedField: 'As definições do teu agente não permitem a definição pedida para trabalho iniciado por um agente.',
        permissionExceedsCeiling: 'Isto precisa de mais permissões do que o agente que o iniciou tem.',
        workDepthExceeded: 'Isto ultrapassaria o teu limite de delegação. Faz o trabalho nesta sessão ou aumenta o limite em Definições › Delegação.',
        definitionExceedsAuthority: 'O agente não pode guardar um fluxo de trabalho que possa fazer mais do que o próprio agente pode iniciar.',
        sourceUnavailable: 'Este fluxo de trabalho está indisponível, pelo que os seus acionadores não podem ser executados.',
        legacyConversionUnsupported: 'Esta automação ainda não pode ser alterada aqui. Continua a funcionar como está.',
        nativeGoalOwner: 'O agente já continua a trabalhar para atingir os objetivos por si próprio nesta sessão.',
        sessionAlreadyStarted: 'Esta sessão já começou. Os acionadores de início de sessão só podem ser adicionados ao criar uma sessão.',
        generic: 'O Happier não conseguiu concluir esse pedido do fluxo de trabalho. O teu trabalho não foi afetado.',
        needsRepair: 'Este fluxo de trabalho tem definições a corrigir antes de poder ser executado.',
        targetUnavailable: 'A máquina ou o agente de que este fluxo de trabalho precisa não está disponível agora.',
        notFound: 'Esta execução já não existe.',
        accessDenied: 'Não tens acesso a esta execução.',
        conflict: 'Isto mudou noutro sítio. Atualiza para veres a versão atual; o teu trabalho local é mantido.',
        inputTooLarge: 'Essa entrada é demasiado grande para ser enviada. Nada foi alterado.',
        unresolvedOutcome: 'O Happier ainda não consegue confirmar que o trabalho anterior parou, por isso não pode ser substituído.',
        interactionCapacity: 'Esta conversa tem demasiada coisa em espera para aceitar mais agora.',
        conversationUnavailable: 'Essa conversa não pode ser continuada.',
        workspaceRestore: 'Não foi possível restaurar o espaço de trabalho. Nada foi alterado.',
        waitSelfDependency: 'Isto deixaria o fluxo de trabalho à espera da conversa que o iniciou.',
        updateRequired: 'A máquina que executa isto precisa de um Happier mais recente para aceitar este passo.',
        ineligible: 'Esta execução avançou, por isso já não é possível.',
        custodyPending: 'O Happier ainda está à espera da confirmação da máquina.',
        runFinished: 'Esta execução terminou.',
        checkpointUnavailable: 'Não há nenhum ponto guardado a partir do qual retomar.',
        recoveryEvidenceRequired: 'Abre esta execução para veres as opções de recuperação.',
        executionNotStarted: 'Ainda não começou nenhum passo.',
        custodySettled: 'Esta execução já está fechada.',
        unavailableHere: 'Isto não está disponível agora.',
    },

    a11y: {
        blockList: 'Blocos do fluxo de trabalho',
        stepContext: ({ block, position, total }) => `${block}, etapa ${position} de ${total}`,
        groupContext: ({ group, block }) => `${block}, dentro de ${group}`,
        inherited: 'usa a configuração do fluxo de trabalho',
        overridden: 'definido para esta etapa',
        inserted: ({ block, position, total }) =>
            `${block} adicionado na posição ${position} de ${total}`,
        removed: ({ block, total }) =>
            `${block} removido. ${total === 1 ? 'Resta 1 bloco' : `Restam ${total} blocos`}`,
        reordered: ({ block, position, total }) =>
            `${block} movido para a posição ${position} de ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count === 1 ? 'etapa precisa' : 'etapas precisam'} de você`,
        needsYouLoaded: 'carregadas',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count === 1 ? 'etapa precisa' : 'etapas precisam'} de você`,
        selectedRowUpdated: ({ block }) => `${block} atualizado`,
        progress: ({ count }) =>
            `${count} ${count === 1 ? 'etapa atualizada' : 'etapas atualizadas'}`,
        progressLoaded: ({ count }) =>
            `${count} ${count === 1 ? 'etapa atualizada' : 'etapas atualizadas'} até agora`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count === 1 ? 'etapa atualizada' : 'etapas atualizadas'}; ${attention} ${attention === 1 ? 'precisa' : 'precisam'} de você`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Editar a etapa',
        editBlock: 'Editar o bloco',
        commandRefused: ({ reason }) => `Ainda não é possível. ${reason}`,
    },
});

const workflowTranslations = { pt } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "pt"> = { pt: { workspaceBar: { tabsLabel: 'Abas abertas', tabMenuLabel: 'Opções da aba', pinTab: 'Fixar aba', unpinTab: 'Desafixar aba', splitRight: 'Dividir à direita', splitDown: 'Dividir abaixo', maximizePane: 'Maximizar painel', restorePane: 'Restaurar painel', closeTab: 'Fechar aba', closeOtherTabs: 'Fechar as outras abas', closeTabsToRight: 'Fechar abas à direita', moreTabs: ({ count }) => (count === 1 ? 'Mais 1 aba' : `Mais ${count} abas`), searchTabs: 'Pesquisar abas', splitPane: 'Dividir o painel ativo', openInNewTab: 'Abrir em nova aba', openToRight: 'Abrir à direita', openBelow: 'Abrir abaixo', newTab: 'Nova aba' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { pt: {
        diagnostics: { title: 'Diagnóstico', relationshipId: 'ID da relação', controllerMachineId: 'ID do computador controlador', alphaMachineId: 'ID do computador de origem', betaMachineId: 'ID do computador de destino', alphaRoot: 'Pasta de origem atual', betaRoot: 'Pasta de destino atual', engineMode: 'Modo do motor', engineState: 'Estado do motor', errorCode: 'Código de erro' },
        error: { updateRequired: 'Atualize o Happier no computador de origem antes de tentar novamente esta transferência do espaço de trabalho. As outras ações de sessões e computadores continuam disponíveis.' },
        resolve: { title: 'Resolver o conflito do espaço de trabalho?', body: ({ path, side }) => `Manter a versão “${side}” da pasta ${path}? A outra pasta e tudo o que existir apenas nela serão removidos depois de o estado atual ser verificado.`, unverifiedFile: 'Uma versão sem uma impressão digital atual do ficheiro não pode ser removida em segurança. Atualize o conflito e tente novamente.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "pt">;

const workspaceSyncSetAttentionTranslations = { pt: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'ligação tem' : 'ligações têm'} conflitos`, unavailableLinks: ({ count }) => `Verifique o estado de ${count} ${count === 1 ? 'ligação' : 'ligações'}` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "pt">;

const workspaceSyncAddMachineTranslations = { pt: { availableOn: 'Disponível em', addMachine: { replica: 'Réplica', exactReplica: 'Réplica exata', editableCopy: 'Cópia editável', editableCopyHint: 'As alterações em computadores ligados podem ficar visíveis aos agentes nos outros computadores. As versões em conflito precisam de revisão. Use árvores de trabalho separadas quando quiser isolamento.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "pt">;

const workspaceSyncReviewOutcomeTranslations = { pt: { keepBoth: 'Manter ambas as versões', preserveAt: ({ path }) => `Manter outra versão em ${path}`, notReviewed: 'Não verificado; nada será alterado aqui', confirmScope: 'Só os espaços de trabalho verificados na lista serão alterados. Os indisponíveis ficam intactos.', preserved: 'Preservado', alreadyPresent: 'Já existe', notStarted: 'Não iniciado', askAgent: 'Perguntar a um agente', askAgentPrompt: ({ path, versions }) => `Ajude-me a rever as versões em conflito de ${path} nestes espaços de trabalho ligados:\n${versions}\nInspecione os ficheiros atuais e sugira uma solução segura. Não altere nem resolva o conflito sem a minha aprovação.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "pt">;

const workspaceSyncCoverageIncompleteTranslations = { pt: 'Algumas ligações ou pontos não foram verificados. Os conflitos carregados continuam visíveis; só é possível resolver as versões disponíveis verificadas explicitamente.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "pt">;

const workspaceSyncReviewLifecycleTranslations = { pt: { requestingApproval: 'A pedir aprovação…', applying: 'A aplicar as alterações verificadas…', propagationExpected: ({ names }) => `Propagação esperada para ${names}`, propagationUnverified: ({ names }) => `Ainda não é possível verificar a propagação para ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "pt">;

const workspaceSyncLocalOnlyTranslations = { pt: 'Esta localização alternativa permanece local ao seu espaço de trabalho' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "pt">;

const workspaceSyncKeepAlternativesTranslations = { pt: 'Manter as alternativas' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "pt">;

const workspaceSyncReviewDecisionTranslations = { pt: { chooseTargets: 'Escolha os espaços de trabalho a substituir', notSelected: 'Não selecionado para esta resolução', inspectCurrentVersions: 'Inspecionar versões atuais' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "pt">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "pt"> = { pt: {
        executable: 'Executável', regular: 'Não executável', applied: 'Aplicado', appliedPaused: 'Aplicado; sincronização pausada', changed: 'Alterado antes de aplicar', offline: 'Offline; não aplicado', cancelled: 'Cancelado', unknown: 'Resultado desconhecido; verifique este ponto', failed: 'Falhou; não aplicado', recoveryNeeded: 'Recuperação necessária neste local', inspectionUnavailable: 'Não foi possível inspecionar as versões atuais. Atualize quando o computador controlador estiver disponível.', coverageIncomplete: 'Algumas ligações ou pontos não foram verificados. Os conflitos carregados continuam visíveis, mas ainda não podem ser resolvidos.', versions: 'Versões', comparison: 'Comparar versões selecionadas', linkDecisions: 'Seleção por ligação', result: 'Resultado', confirmTitle: 'Usar esta versão?', confirmBody: ({ path, source, count }) => `Usar a versão de ${source} de ${path} noutros ${count} espaços de trabalho? O Happier verificará todas as versões antes de alterar.`, useVersion: 'Usar versão', useNamedVersion: ({ name }) => `Usar ${name}`, compareNamedVersion: ({ name }) => `Comparar ${name}`, linkCount: ({ count }) => `${count} ligações comunicaram este caminho`, moreOnLink: ({ name }) => `Carregar mais de ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { pt: { selectionIncluded: 'Incluído por esta ligação', selectionExcluded: 'Excluído por esta ligação', selectionUnknown: 'Seleção desconhecida', reasonRepositoryMetadata: 'Metadados do repositório', reasonSubmodule: 'Submódulo Git', reasonConfiguredRule: 'Regra configurada', reasonGitIgnore: 'Regra Git ignore', reasonEndpointUnavailable: 'Ponto indisponível', reasonSelectionUnavailable: 'Avaliador de seleção indisponível', configuredInclude: ({ pattern }) => `Padrão de inclusão: ${pattern}`, configuredExclude: ({ pattern }) => `Padrão de exclusão: ${pattern}`, completedLinks: ({ count }) => `${count} ligações concluídas antes do bloqueio` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "pt">;

const pt = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["pt"],
    review: workspaceSyncReviewTranslations["pt"],
    selection: workspaceSyncReviewSelectionTranslations["pt"],
    outcome: workspaceSyncReviewOutcomeTranslations["pt"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["pt"],
    decision: workspaceSyncReviewDecisionTranslations["pt"],
    coverage: workspaceSyncCoverageIncompleteTranslations["pt"],
    localOnly: workspaceSyncLocalOnlyTranslations["pt"],
    alternatives: workspaceSyncKeepAlternativesTranslations["pt"],
    addMachine: workspaceSyncAddMachineTranslations["pt"],
    attention: workspaceSyncSetAttentionTranslations["pt"],
}, {
    title: 'Sincronização do espaço de trabalho',
    footer: 'O estado vem do computador que gere esta relação. As alterações só aparecem depois de esse computador as confirmar.',
    legacyRecovery: {
        title: 'Dados de sincronização descontinuados',
        footer: 'O Happier apenas inspeciona e coloca em quarentena estes dados descontinuados. Nunca os elimina na aplicação.',
        checking: 'A verificar computadores…',
        inspectFailed: 'Não foi possível verificar alguns computadores. As pastas de quarentena já encontradas continuam visíveis; tenta novamente quando esses computadores estiverem acessíveis.',
        outdatedTitle: ({ machine }) => `${machine} usa uma versão antiga do Happier`,
        outdatedBody: 'Essa versão não consegue verificar dados de sincronização descontinuados. Atualiza o Happier nesse computador e volta a inspecionar aqui.',
        explanation: 'Este computador contém dados do mecanismo de replicação descontinuado. O Happier moveu os dados reconhecidos para uma quarentena privada e desativou a sincronização para impedir a execução do mecanismo antigo.',
        quarantinePath: 'Pasta de quarentena',
        openFolder: 'Abrir pasta',
        offlineTitle: 'Remover enquanto o Happier está offline',
        offlineSteps: ({ path }) => `1. Para todos os serviços em segundo plano do Happier que possam usar estes dados.\n2. Remove exatamente esta pasta através do sistema operativo: ${path}\n3. Reinicia os serviços e volta a inspecionar aqui.`,
        unknown: ({ path, reason }) => `O Happier não conseguiu classificar com segurança o estado antigo em ${path} (${reason}). A sincronização continua desativada. Inspeciona este caminho manualmente; não o elimines na aplicação.`,
        reinspect: 'Inspecionar novamente',
    },
    none: 'Nenhuma relação de sincronização',
    conflictsTitle: 'Conflitos do espaço de trabalho',
    openConflicts: ({ count }) => `Rever sincronização em ${count} ligações`,
    noConflicts: 'Nenhum conflito',
    previewUnavailable: 'O computador controlador não conseguiu fornecer uma pré-visualização segura. Atualiza o conflito antes de tentar novamente.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'conflito adicional não é apresentado' : 'conflitos adicionais não são apresentados'}`,
    unknownMode: 'Modo de sincronização não suportado',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'conflito' : 'conflitos'}`,
    conflictKind: { file: 'Ficheiro', directory: 'Pasta', symlink: 'Ligação simbólica', missing: 'Em falta', unsupported: 'Entrada não suportada' },
    mode: { copyOnce: 'Copiar uma vez', keepSynced: 'Manter atualizado — recomendado', mirrorExactly: 'Espelhar exatamente', keepBothInSync: 'Manter ambos sincronizados' },
    state: { loading: 'A verificar o estado…', starting: 'A preparar', watching: 'A monitorizar', flushing: 'A sincronizar', paused: 'Em pausa', peerOffline: 'Offline', conflicted: 'Conflitos', controllerUnavailable: 'Requer atenção', engineUnavailable: 'Componente indisponível', error: 'Requer atenção', stopped: 'Parado', working: 'A processar…' },
    lastChecked: ({ at }) => `Última verificação: ${at}`,
    endpoint: { source: ({ label }) => `Origem · ${label}`, destination: ({ label }) => `Destino · ${label}`, synced: ({ label }) => `Extremidade sincronizada · ${label}` },
    error: {
        componentUnavailable: 'A sincronização do espaço de trabalho não está disponível nesta compilação. Instala o componente necessário e tenta novamente.',
        machineOffline: 'O computador de destino não está disponível. Volta a ligá-lo e tenta novamente.',
        destinationNeedsPreparation: 'A pasta de destino precisa de ser preparada antes de iniciar a sincronização.',
        gitPreparationFailed: 'O Happier não conseguiu preparar este espaço de trabalho Git. Revê o destino e tenta novamente.',
        authorizationExpired: 'A autorização do espaço de trabalho expirou. Inicia novamente a operação.',
        rootNoLongerAuthorized: 'A pasta do espaço de trabalho mudou e deixou de estar autorizada. Revê a relação antes de tentar novamente.',
        conflictNeedsAttention: 'Este conflito mudou. Atualiza-o antes de escolher uma versão.',
        needsAttention: 'A sincronização do espaço de trabalho requer atenção. Atualiza o estado e tenta novamente.',
    },
    start: { blocked: {
        targetMachine: 'Escolhe um computador de destino para continuar.',
        targetMachineOffline: 'Esse computador não está disponível agora. Volta a ligá-lo e tenta novamente.',
        relationshipUnavailable: 'Esta relação de sincronização já não abrange estas duas pastas. Escolhe outra opção para o espaço de trabalho.',
        sourceFolder: 'A pasta desta sessão não pode ser sincronizada com segurança. Escolhe “Não mover ficheiros” para transferir apenas a sessão.',
        destinationFolder: 'Escolhe uma pasta de destino válida.',
        workspaceOptions: 'Revê as opções do espaço de trabalho antes de começar.',
    } },
    engine: { checking: 'A verificar a sincronização neste computador…' },
    actions: { refresh: 'Atualizar estado', syncNow: 'Sincronizar agora', more: 'Ações de sincronização', pause: 'Pausar', resume: 'Retomar', terminate: 'Parar sincronização', openOnMachine: ({ machine }) => `Abrir em ${machine}`, openFolder: ({ label }) => `Abrir a pasta ${label}`, keepLocal: 'Manter a versão local', keepRemote: 'Manter a versão remota', keepNamed: ({ side }) => `Manter a versão de ${side}` },
    terminate: { title: 'Remover a sincronização do espaço de trabalho?', body: 'A sincronização será interrompida e a relação removida. Os ficheiros permanecem nos dois espaços de trabalho.' },
    resolve: {
        changedTitle: 'O conflito mudou',
        changedBody: 'Este conflito mudou desde que foi aberto. A lista foi atualizada. Revê as versões mais recentes antes de escolher novamente.',
        consequence: 'A outra versão só será removida depois de o Happier verificar que o ficheiro não mudou.',
        unsupported: 'Este conflito contém uma entrada do sistema de ficheiros não suportada e não pode ser resolvido no Happier. Remove-a ou substitui-a no computador afetado e depois atualiza.',
        keepHint: ({ side }) => `Manter a versão de ${side} e remover a outra versão verificada.`,
    },
    fileState: { text: 'Pré-visualização de texto', binary: 'Ficheiro binário — pré-visualização indisponível', tooLarge: 'O ficheiro é demasiado grande para pré-visualizar', missing: 'Ficheiro em falta', changed: 'O ficheiro mudou desde que este conflito foi apresentado' },
});

const workspaceSyncTranslations = { pt } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "pt">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { pt: en };

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
