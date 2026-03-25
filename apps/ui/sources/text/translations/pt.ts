import type { TranslationStructure } from "../_types";
import { memoryEmbeddingsTranslationExtensions } from './memoryEmbeddingsExtension';
import { mcpServersUxTranslationExtension } from './mcpServersUxExtension';
import { newSessionMcpTranslationExtensions } from './newSessionMcpExtension';
import { promptLibraryUxRefinementTranslationExtension } from './promptLibraryUxRefinementExtension';
import { sessionHandoffTranslationExtensions, settingsSessionHandoffTranslationExtensions } from './sessionHandoffExtension';
import { settingsAppearanceTranslationExtensions } from './settingsAppearanceExtension';
import { acpCatalogTranslationExtensions } from './acpCatalogExtension';

const newSessionMcpTranslationExtension = newSessionMcpTranslationExtensions.pt;
const settingsAppearanceTranslationExtension = settingsAppearanceTranslationExtensions.pt;
const acpCatalogTranslationExtension = acpCatalogTranslationExtensions.pt;
const memoryEmbeddingsTranslationExtension = memoryEmbeddingsTranslationExtensions.pt;
const ptMcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle:
    "Crie um servidor, importe JSON do host ou instale uma predefinição recomendada.",
  mcpServersHeroSubtitle: ({
    configuredCount,
  }: {
    configuredCount: number;
  }) => `${configuredCount} configurado${configuredCount === 1 ? "" : "s"} no Happier`,
  mcpServersHeroSubtitleEmpty:
    "Crie servidores uma vez, visualize onde se aplicam e importe o que outras ferramentas já usam.",
  mcpServersSegmentConfigured: "Configurados",
  mcpServersSegmentConfiguredSubtitle: "Seu catálogo do Happier",
  mcpServersSegmentDetected: "Detectados",
  mcpServersSegmentDetectedSubtitle:
    "Encontrados nos arquivos de configuração dos provedores",
  mcpServersSegmentPreview: "Pré-visualização",
  mcpServersSegmentPreviewSubtitle: "O que esta sessão vai receber",
  mcpServersAdvancedTitle: "Avançado",
  mcpServersAdvancedSubtitle: "Modo estrito e comportamento de validação",
  mcpServersDetectedDirectoryTitle: "Diretório do projeto",
  mcpServersDetectedDirectorySubtitle:
    "Caminho de workspace opcional para configurações no nível do projeto",
  mcpServersDetectedDirectoryPlaceholder: "/caminho/para/projeto",
  mcpServersPreviewAgentTitle: "Back-end",
  mcpServersPreviewMachineTitle: "Máquina",
  mcpServersPreviewDeliveryTitle: "Entrega de ferramentas",
  mcpServersPreviewDirectoryTitle: "Diretório do workspace",
  mcpServersPreviewDirectorySubtitle:
    "Escolha a pasta em que você pretende iniciar a sessão",
  mcpServersPreviewDirectoryPlaceholder: "/caminho/para/workspace",
  mcpServersPreviewRefreshTitle: "Atualizar pré-visualização",
  mcpServersPreviewRefreshSubtitle:
    "Resolver servidores MCP do Happier e nativos do provedor para este contexto",
  mcpServersPreviewEmptyTitle: "Ainda não há pré-visualização",
  mcpServersPreviewEmptySubtitle:
    "Escolha um backend, uma máquina e um diretório, depois atualize para inspecionar o conjunto MCP efetivo.",
  mcpServersPreviewDirectoryRequired:
    "Escolha um diretório para pré-visualizar esta sessão.",
  mcpServersBuiltInDescription:
    "Sempre disponível nas sessões do Happier.",
  mcpServersSourceHappier: "Happier",
  mcpServersSourceBuiltIn: "Integrado",
  mcpServersSourceDetected: "Detectado",
  mcpServersQuickInstallTitle: "Instalação rápida",
  mcpServersQuickInstallSubtitle:
    "Instale servidores MCP comuns para desenvolvimento em uma etapa.",
  mcpServersQuickInstallAction: "Instalar",
  mcpServersQuickInstallEmptyTitle: "Escolha uma predefinição",
  mcpServersQuickInstallEmptySubtitle:
    "Selecione um dos servidores MCP recomendados para continuar.",
  mcpServersEditAction: "Editar",
  mcpServersDeleteAction: "Remover",
  mcpServersAddServerFlowSubtitle:
    "Configure um servidor manualmente, importe JSON do host ou comece com uma predefinição curada.",
  mcpServersAddFlowConfigureTitle: "Configurar",
  mcpServersAddFlowConfigureSubtitle: "Configuração manual",
  mcpServersAddFlowImportJsonTitle: "Importar JSON",
  mcpServersAddFlowImportJsonSubtitle: "Cole a configuração do host",
  mcpServersAddFlowQuickInstallTitle: "Instalação rápida",
  mcpServersAddFlowQuickInstallSubtitle: "Predefinições curadas",
  mcpServersFieldCommandLine: "Linha de comando",
  mcpServersFieldCommandLinePlaceholder:
    "npx -y @modelcontextprotocol/server-playwright",
  mcpServersTransportLocalTitle: "Comando local",
  mcpServersTransportLocalSubtitle: "Executa na máquina selecionada",
  mcpServersTransportHttpTitle: "HTTP remoto",
  mcpServersTransportHttpSubtitle: "Faz a ponte a partir de um endpoint HTTP",
  mcpServersTransportSseTitle: "SSE remoto",
  mcpServersTransportSseSubtitle:
    "Faz a ponte a partir de eventos enviados pelo servidor",
  mcpServersAdvancedCommandEditorTitle: "Editor avançado de comando",
  mcpServersAdvancedCommandEditorSubtitle:
    "Separe manualmente o comando e os argumentos",
  mcpServersCancelSubtitle: "Sair sem salvar este rascunho",
  mcpServersImportJsonTitle: "Colar JSON do host MCP",
  mcpServersImportJsonSubtitle:
    "Oferecemos suporte a formatos comuns usados em READMEs e hosts desktop.",
  mcpServersImportJsonPlaceholder:
    '{"mcpServers":{"playwright":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: "Erro de importação",
  mcpServersImportJsonWarningsTitle: "Avisos de importação",
  mcpServersImportJsonEmptyTitle: "Ainda não há servidores analisados",
  mcpServersImportJsonEmptySubtitle:
    "Cole o JSON MCP do host para visualizar os servidores antes de importar.",
  mcpServersImportJsonAction: "Importar servidores",
  mcpServersImportMappingSavedSecret: "Usar segredo salvo",
  mcpServersImportMappingMachineEnv:
    "Usar variável de ambiente da máquina",
  mcpServersImportSecretNamePlaceholder: "Nome do segredo salvo",
  mcpServersImportSecretValuePlaceholder: "Valor do segredo salvo",
  mcpServersImportMachineEnvPlaceholder: "NOME_DA_VARIÁVEL_DE_AMBIENTE",
  mcpServersImportMappingMissingSecretName: ({
    input,
  }: {
    input: string;
  }) => `Insira um nome de segredo salvo para ${input}.`,
  mcpServersImportMappingMissingSecretValue: ({
    input,
  }: {
    input: string;
  }) =>
    `Insira um valor de segredo salvo para ${input} ou mude para variável de ambiente da máquina.`,
  mcpServersImportMappingMissingMachineEnvName: ({
    input,
  }: {
    input: string;
  }) => `Insira o nome da variável de ambiente da máquina para ${input}.`,
  mcpServersAuthSavedSecret: "Segredo salvo",
  mcpServersAuthMachineEnv: "Variável de ambiente da máquina",
  mcpServersAuthPlainText: "Texto simples",
  mcpServersAuthUnknown: "Autenticação desconhecida",
  mcpServersAuthNone: "Sem autenticação",
  mcpServersScopeAllMachines: "Todas as máquinas",
  mcpServersScopeMachine: "Máquina",
  mcpServersScopeWorkspace: "Espaço de trabalho",
  mcpServersScopeProviderProject:
    "Configuração de projeto do provedor",
  mcpServersScopeProviderUser: "Configuração de usuário do provedor",
  mcpServersScopeBuiltIn: "Integrado",
  mcpServersStatusActive: "Ativo",
  mcpServersStatusAvailable: "Disponível",
  mcpServersStatusUnavailable: "Indisponível",
  mcpServersStatusDetected: ({
    provider,
  }: {
    provider: string;
  }) => `Ativado em ${provider}`,
  mcpServersStatusDisabledInProvider: ({
    provider,
  }: {
    provider: string;
  }) => `Desativado em ${provider}`,
  mcpServersEditorAppliesTo: "Aplica-se a",
  mcpServersEditorAppliesToSubtitle:
    "Escolha onde o Happier deve adicionar este servidor por padrão.",
  mcpServersAddApplyRule: "Adicionar regra de aplicação",
  mcpServersAddApplyRuleSubtitle:
    "Escolha onde este servidor deve se aplicar por padrão.",
  mcpServersAddApplyRuleHelp:
    "Salve esta regra de aplicação para torná-la parte desta configuração de servidor.",
  mcpServersAddApplyRuleSave: "Salvar regra de aplicação",
  mcpServersDeliveryNativeTitle: "MCP nativo",
  mcpServersDeliveryNativeSubtitle:
    "Este backend recebe ferramentas do Happier como servidores MCP nativos.",
  mcpServersDeliveryShellBridgeTitle: "Bridge de shell do Happier",
  mcpServersDeliveryShellBridgeSubtitle:
    "Este backend chama as ferramentas do Happier pela ponte `happier tools`.",
  mcpServersDeliveryUnsupportedTitle: "Não suportado",
  mcpServersDeliveryUnsupportedSubtitle:
    "Este backend ainda não recebe ferramentas do Happier.",
};

/**
 * Portuguese plural helper function
 * Portuguese (Brazilian) has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Portuguese plural rules
 */
function plural({
  count,
  singular,
  plural,
}: {
  count: number;
  singular: string;
  plural: string;
}): string {
  return count === 1 ? singular : plural;
}

/**
 * Portuguese (Brazilian) translations for the Happier app
 * Must match the exact structure of the English translations
 */
export const pt: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "Caixa de entrada",
    friends: "Amigos",
    sessions: "Sessões",
    settings: "Configurações",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Tudo em dia",
    emptyDescription: "Nenhuma solicitação ou atualização pendente no momento.",
    approvals: "Aprovações",
    permissions: "Permissões",
    updates: "Atividade",
  },

  approvals: {
    title: "Aprovação",
    untitled: "Aprovação sem título",
    details: "Detalhes",
    fieldStatus: "Estado",
    fieldAction: "Ação",
    approve: "Aprovar",
    reject: "Rejeitar",
    loadError: "Falha ao carregar a aprovação.",
    decisionError: "Falha ao atualizar a aprovação.",
    confirmApproveTitle: "Aprovar solicitação?",
    confirmApproveBody: "Isso executará a ação solicitada.",
    confirmRejectTitle: "Rejeitar solicitação?",
    confirmRejectBody: "Isso rejeitará a solicitação.",
    status: {
      open: "Pendente",
      approved: "Aprovada",
      rejected: "Rejeitada",
      executed: "Executada",
      failed: "Falhou",
      canceled: "Cancelada",
    },
  },

  promptLibrary: {
    sections: "Seções",
    library: "Biblioteca",
    librarySubtitle: "Gerencie prompts e habilidades",
    create: "Criar",
    newPrompt: "Novo prompt",
    newSkill: "Nova habilidade",
    prompts: "Instruções",
    skills: "Habilidades",
    untitledPrompt: "Prompt sem título",
    untitledSkill: "Habilidade sem título",
    origin: "Origem",
    schema: "Esquema",
    editPrompt: "Editar prompt",
    editSkill: "Editar habilidade",
    titlePlaceholder: "Título",
	    saveError: "Falha ao salvar.",
	    templates: "Modelos",
	    templatesSubtitle: "Crie e gerencie modelos /slash",
	    newTemplate: "Novo modelo",
	    stacks: "Pilhas",
	    stacksSubtitle: "Anexe prompts e habilidades a sessões e perfis",
        externalAssets: "Recursos externos",
        externalAssetsSubtitle: "Importe skills e recursos de prompt de máquinas conectadas",
        externalAssetsContext: "Contexto de descoberta",
        externalAssetsMachine: "Máquina",
        externalAssetsScope: "Escopo",
        externalAssetsProjectScope: "Projeto",
        externalAssetsProjectScopeSubtitle: "Descubra recursos dentro do caminho de um workspace",
        externalAssetsUserScope: "Usuário",
        externalAssetsUserScopeSubtitle: "Descubra recursos em pastas no nível do usuário",
        externalAssetsProjectDirectory: "Diretório do projeto",
        externalAssetsProjectDirectoryRequired: "Escolha um diretório do projeto antes de importar ou exportar recursos com escopo de projeto.",
        externalAssetsRefresh: "Atualizar recursos externos",
        externalAssetsRefreshSubtitle: "Descubra recursos de prompt para a máquina e o escopo selecionados",
        externalAssetsTypes: "Tipos de recursos",
        externalAssetsNoMachine: "Selecione uma máquina para continuar.",
        externalAssetsNoTypes: "Nenhum tipo de recurso externo",
        externalAssetsNoTypesSubtitle: "Esta máquina ainda não expõe adaptadores de recursos de prompt.",
        externalAssetsNoItems: "Nenhum recurso externo encontrado",
        externalAssetsNoItemsSubtitle: "Atualize depois de escolher uma máquina, um escopo ou um diretório.",
        externalAssetsUnsupportedImport: "Aqui só é possível importar recursos de prompt baseados em bundle.",
        externalAssetsExportTitle: "Exportar recurso externo",
        externalAssetsExportOptions: "Opções de exportação",
        externalAssetsExportType: "Tipo de recurso",
        externalAssetsExportAction: "Exportar",
        externalAssetsExportConfirmTitle: "Exportar recurso externo?",
        externalAssetsExportConfirmBody: "Isto irá gravar o recurso de prompt selecionado na localização externa.",
        externalAssetsExportTargetPathPlaceholder: "Caminho de destino (ex.: review/code.md)",
        externalAssetsExportTargetNamePlaceholder: "Nome de destino (ex.: reviewer)",
        externalAssetsDeleteConfirmTitle: "Eliminar recurso externo?",
        externalAssetsDeleteConfirmBody: "Isto irá eliminar do disco o recurso externo ligado.",
        externalAssetsLinkedTitle: "Recurso externo ligado",
        registries: "Registros",
        registriesSubtitle: "Navegue pelos registros de skills e importe bundles para a biblioteca",
        registriesContext: "Contexto do registro",
        registriesNoMachine: "Selecione uma máquina para continuar.",
        registriesRefresh: "Atualizar registros",
        registriesRefreshSubtitle: "Carregue as fontes de registro integradas e configuradas para a máquina selecionada",
        registriesAddGitSource: "Adicionar fonte Git",
        registriesAddGitSourceAction: "Salvar fonte Git",
        registriesAddGitSourceActionSubtitle: "Salvar este repositório como fonte de registro",
        registriesAddGitSourceError: "Adicione um título e uma URL do repositório.",
        registriesSourceTitlePlaceholder: "Título da fonte",
        registriesSourceUrlPlaceholder: "URL do repositório ou caminho local",
        registriesSources: "Fontes",
        registriesNoSources: "Nenhuma fonte de registro carregada",
        registriesNoSourcesSubtitle: "Adicione uma fonte Git ou atualize para carregar as fontes integradas.",
        registriesItems: "Itens do registro",
        registriesNoItems: "Nenhum item do registro",
        registriesNoItemsSubtitle: "Selecione uma fonte para escanear as skills disponíveis.",
	    editTemplate: "Editar modelo",
    tokenPlaceholder: "Token (ex.: /daily)",
    codingStack: "Pilha de código",
    codingStackSubtitle: "Aplicado às sessões de código",
    voiceStack: "Pilha de voz",
    voiceStackSubtitle: "Aplicado ao Happier Voice",
    profileStacks: "Pilhas de perfil",
    profileStacksSubtitle: ({ count }: { count: number }) => `${count} perfil${count === 1 ? "" : "s"}`,
    profileStackCount: ({ count }: { count: number }) => `${count} item${count === 1 ? "" : "s"}`,
    noProfilesTitle: "Sem perfis",
    noProfilesSubtitle: "Crie um perfil para usar pilhas de perfil.",
    stackEntries: "Itens da pilha",
    stackPlacementSkill: "Instruções de habilidade",
    stackPlacementComposer: "Inserção no compositor",
    stackPlacementSystem: "Anexar ao sistema",
    stackEmptyTitle: "Nada nesta pilha",
    stackEmptySubtitle: "Adicione prompts ou habilidades para começar.",
    actions: "Ações",
    addToStack: "Adicionar à pilha",
    stackAlreadyContainsPrompt: "Esta pilha já contém esse item.",
    stackPickerNoPrompts: "Ainda não há prompts.",
    stackPickerNoSkills: "Ainda não há habilidades.",
    removeFromStack: "Remover da pilha?",
    removeFromStackConfirm: "Isso removerá o item da pilha.",
    deleteTemplate: "Excluir modelo?",
    deleteTemplateConfirm: "Isso excluirá o modelo.",
    templateTokenReserved: "Esse token é reservado.",
    templateTokenConflictsWithAction: "Esse token entra em conflito com uma ação integrada.",
    templateTokenDuplicate: "Esse token já está em uso.",
    templateTarget: "Prompt alvo",
    templateBehavior: "Comportamento",
    templateBehaviorInsert: "Inserir",
    templateBehaviorInsertAndSend: "Inserir e enviar",
    templateAllowArgs: "Permitir argumentos",
    templateAllowArgsSubtitle: "Se ativado, o texto após o token é passado como $args.",
        ...promptLibraryUxRefinementTranslationExtension.pt,
  },

  runs: {
    title: "Execuções",
    empty: "Nenhuma execução ainda.",
    showFinished: "Mostrar finalizadas",
    unknownMachine: "Máquina desconhecida",
    failedToLoad: "Falha ao carregar execuções",
    noMachinesAvailable: "Nenhuma máquina disponível.",
    groupLabel: ({ groupId }: { groupId: string }) => `Grupo ${groupId}`,
    serverTitle: ({ serverId }: { serverId: string }) => `Servidor ${serverId}`,
    machinesSubtitle: "Máquinas",
    openMachine: "Abrir máquina",
    a11y: {
      toggleFinished: "Alternar execuções finalizadas",
      refresh: "Atualizar execuções",
    },
    openSession: "Abrir sessão",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `Sessão ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `execução ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `pid ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "Falha ao carregar a execução",
      latestToolResultTitle: "Último resultado da ferramenta",
      a11y: {
        refreshRun: "Atualizar execução",
      },
    },
    stop: {
      stopRunA11y: "Parar execução",
      stopLabel: "Parar execução",
      stoppingLabel: "Parando…",
      stopRunFailedTitle: "Falha ao parar a execução",
      stopRunFailedBody:
        "Parar esta execução via RPC da sessão falhou. Quer parar o processo inteiro da sessão? Isso é destrutivo e vai parar todas as execuções dessa sessão.",
      stopSession: "Parar sessão",
      failedToStopRun: "Falha ao parar a execução",
      failedToStopSession: "Falha ao parar a sessão",
    },
    send: {
      placeholder: "Enviar para a execução…",
      a11y: {
        sendToRun: "Enviar para a execução",
      },
      sendLabel: "Enviar",
      sendingLabel: "Enviando…",
      failedToSend: "Falha ao enviar",
    },
    delivery: {
      title: "Entrega",
      cardDelivery: ({ label }: { label: string }) => `Entrega: ${label}`,
      steerLabel: "Orientar",
      steerHelp:
        "Envie uma mensagem de orientação enquanto a execução estiver ocupada (se houver suporte).",
      interruptLabel: "Interromper",
      interruptHelp:
        "Cancele o turno atual e envie sua mensagem como um novo turno.",
      promptLabel: "Comando",
    },
  },

  sessionLog: {
    title: "Log da sessão",
    devModeRequiredTitle: "O modo desenvolvedor é obrigatório",
    devModeRequiredBody:
      "Ative o modo desenvolvedor nas configurações para ver os logs da sessão.",
    logPathTitle: "Caminho do log",
    unavailable: "Indisponível",
    logPathCopyLabel: "Caminho do log da sessão",
    refreshTailTitle: "Atualizar final do log",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `Ler os últimos ${maxBytes} bytes`,
    copyVisibleTitle: "Copiar log visível",
    copyVisibleSubtitleLoaded:
      "Copiar o trecho atual para a área de transferência",
    copyVisibleSubtitleEmpty: "Nenhum conteúdo de log carregado",
    copyLogLabel: "Log da sessão",
    statusTitle: "Status do log",
    readErrorTitle: "Erro de leitura",
    tailTitle: "Final do log",
    tailTitleTruncated: "Final do log (truncado)",
    noOutputYet: "(Ainda não há saída de log)",
    readFailed: "Falha ao ler o log da sessão",
  },

  automations: {
    openA11y: "Abrir automações",
    gate: {
      disabledTitle: "As automações estão desativadas",
      disabledBody:
        "Ative em Configurações e depois habilite Experimentos e Automações.",
    },
    edit: {
      title: "Editar automação",
      saveAutomationLabel: "Salvar automação",
      messageLabel: "MENSAGEM",
      messagePlaceholder: "Mensagem para enviar",
      messageHelpText:
        "Esta mensagem será colocada na fila da sessão como uma mensagem de usuário pendente.",
      updateFailed: "Falha ao atualizar a automação.",
      loadTemplateFailed: "Falha ao carregar o template da automação.",
    },
    form: {
      groupAutomationTitle: "Automação",
      groupScheduleTitle: "Agendamento",
      toggleEnableTitle: "Ativar automação",
      toggleEnableSubtitle:
        "Crie este novo modelo de sessão como uma automação agendada em vez de iniciar imediatamente.",
      toggleEnabledTitle: "Ativada",
      toggleEnabledSubtitle:
        "Quando desativada, nenhuma execução agendada será executada.",
      labels: {
        name: "NOME",
        descriptionOptional: "DESCRIÇÃO (OPCIONAL)",
        everyMinutes: "A CADA (MINUTOS)",
        cronExpression: "EXPRESSÃO CRON",
        timezoneOptional: "FUSO HORÁRIO (OPCIONAL)",
      },
      placeholders: {
        name: "Resumo diário",
        description: "O que esta automação deve fazer?",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC ou America/New_York",
      },
      schedule: {
        intervalTitle: "Intervalo",
        intervalSubtitle: "Executar a cada N minutos.",
        cronTitle: "Expressão cron",
        cronSubtitle: "Expressão de agendamento avançada.",
        cronHelpText:
          "Cron padrão de 5 campos: minuto hora dia-do-mês mês dia-da-semana.",
      },
    },
    session: {
      emptyTitle: "Sem automações",
      emptyBody:
        "Adicione uma automação para colocar mensagens agendadas na fila desta sessão.",
      addAutomation: "Adicionar automação",
      failedToLoad: "Falha ao carregar automações.",
    },
    screen: {
      emptyTitle: "Ainda não há automações",
      emptyBody:
        "Crie uma no fluxo de Nova sessão para executar sessões agendadas nas suas máquinas.",
      createAutomationA11y: "Criar automação",
    },
    detail: {
      invalidId: "ID de automação inválido.",
      notFound: "Automação não encontrada.",
      unknownDate: "Desconhecido",
      notScheduled: "Não agendada",
      overviewGroupTitle: "Visão geral",
      overview: {
        nameTitle: "Nome",
        scheduleTitle: "Agendamento",
        statusTitle: "Estado",
        nextRunTitle: "Próxima execução",
      },
      status: {
        active: "Ativa",
        paused: "Pausada",
      },
      actionsGroupTitle: "Ações",
      runNowTitle: "Executar agora",
      runNowQueuedBadge: "Na fila",
      runNowQueuedLine: "Na fila.",
      runNowQueuedSubtitle:
        "Na fila. O daemon atribuído irá executá-la quando estiver disponível.",
      pauseAutomation: "Pausar automação",
      resumeAutomation: "Retomar automação",
      editAutomation: "Editar automação",
      deleteAutomation: "Excluir automação",
      deleteConfirmTitle: "Excluir automação",
      deleteConfirmMessage: "Esta automação e seu agendamento serão removidos.",
      deleteConfirmButton: "Excluir",
      machineAssignmentsTitle: "Atribuições de máquina",
      machineAssignmentsFooter:
        "Ative pelo menos uma máquina para que esta automação possa ser executada.",
      refreshFailed: "Falha ao atualizar a automação.",
      runFailed: "Falha ao executar a automação.",
      deleteFailed: "Falha ao excluir a automação.",
      assignmentsUpdateFailed: "Falha ao atualizar as atribuições de máquina.",
      recentRunsTitle: "Execuções recentes",
      runMeta: {
        scheduled: ({ time }: { time: string }) => `Agendada: ${time}`,
        updated: ({ time }: { time: string }) => `Atualizada: ${time}`,
        error: ({ message }: { message: string }) => `Erro: ${message}`,
      },
    },
    create: {
      defaultName: "Mensagem agendada",
      createFailed: "Falha ao criar a automação.",
      unavailableGroupTitle: "Indisponível",
      cannotCreateForSession: "Não é possível criar uma automação para esta sessão",
      sessionNotFound: "Sessão não encontrada.",
      missingMachineId: "Esta sessão não tem um ID de máquina.",
      missingResumeKey:
        "Esta sessão ainda não tem uma chave de criptografia de retomada carregada.",
      createButtonTitle: "Criar automação",
    },
  },

  appCrash: {
    title: "Algo correu mal",
    subtitle:
      "O Happier encontrou um erro inesperado. Pode reiniciar a interface da app ou copiar os detalhes para suporte.",
    detailsTitle: "Detalhes do erro",
    restart: "Reiniciar app",
    restartAndReportIssue: "Reiniciar e abrir relatório de erro",
    copyDetails: "Copiar detalhes do erro",
  },

  webCryptoGate: {
    title: "É necessária uma ligação segura",
    subtitle:
      "Esta página precisa de WebCrypto para manter os seus dados seguros. O WebCrypto não está disponível nesta origem porque os navegadores exigem um contexto seguro.",
    howToFix: "Como corrigir",
    fixHttps: "Abra a UI em HTTPS (recomendado).",
    fixTunnel: "Se precisar de acesso por LAN, use um túnel HTTPS ou um proxy reverso com TLS.",
    fixLocalhost:
      "Se estiver na mesma máquina, use http://localhost (o loopback é tratado como seguro).",
    currentOrigin: "Origem atual",
    secureContext: "Contexto seguro",
    copyDetails: "Copiar detalhes",
    reload: "Recarregar",
  },

  common: {
    // Simple string constants
    add: "Adicionar",
    edit: "Editar",
    duplicate: "Duplicar",
    actions: "Ações",
    moreActions: "Mais ações",
    moreActionsHint: "Abre um menu com mais ações",
    cancel: "Cancelar",
    close: "Fechar",
    open: "Abrir",
    done: "Concluído",
    reorder: "Reordenar",
    moveUp: "Mover para cima",
    moveDown: "Mover para baixo",
    authenticate: "Autenticar",
    save: "Salvar",
    saveAs: "Salvar como",
		    error: "Erro",
		    success: "Sucesso",
		    info: "Informações",
		    comingSoon: "Em breve",
		    ok: "OK",
		    continue: "Continuar",
		    back: "Voltar",
        previous: "Anterior",
        next: "Seguinte",
	    start: "Iniciar",
	    create: "Criar",
    rename: "Renomear",
    remove: "Remover",
    update: "Atualizar",
    commit: "Fazer commit",
    history: "Histórico",
      applied: "Aplicado",
      signOut: "Sair",
      keep: "Manter",
      use: "Usar",
      reset: "Redefinir",
      logout: "Sair",
      yes: "Sim",
      no: "Não",
    on: "Ativado",
    off: "Desativado",
    discard: "Descartar",
    discardChanges: "Descartar alterações",
    unsavedChangesWarning: "Você tem alterações não salvas.",
    keepEditing: "Continuar editando",
    version: "Versão",
    details: "Detalhes",
    copied: "Copiado",
    copy: "Copiar",
    copyWithLabel: ({ label }: { label: string }) => `Copiar ${label}`,
    paste: "Colar",
    expand: "Expandir",
    collapse: "Recolher",
    command: "Comando",
    scanning: "Escaneando...",
    urlPlaceholder: "https://exemplo.com",
    home: "Início",
    message: "Mensagem",
    send: "Enviar",
    attach: "Anexar",
    addImage: "Adicionar imagem",
    addFile: "Adicionar arquivo",
    linkFile: "Vincular arquivo",
    files: "Arquivos",
    path: "Caminho",
    fileViewer: "Visualizador de arquivos",
    loading: "Carregando...",
    none: "—",
    unavailable: "Indisponível",
    dialog: "Diálogo",
    retry: "Tentar novamente",
    or: "ou",
    delete: "Excluir",
    deleted: "Excluído",
    optional: "Opcional",
    noMatches: "Nenhuma correspondência",
    all: "Todos",
    machine: "máquina",
    clearSearch: "Limpar pesquisa",
    refresh: "Atualizar",
    default: "Padrão",
    enabled: "Ativado",
    disabled: "Desativado",
    requestFailed: "Falha na solicitação.",
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "Redimensionar painel",
      resizeHint:
        "Use as setas para esquerda e direita para redimensionar",
    },
  },

  dropdown: {
    category: {
      general: "Geral",
      results: "Resultados",
    },
    createItem: {
      prefix: "Adicionar",
    },
  },

  profile: {
    userProfile: "Perfil do usuário",
    details: "Detalhes",
    firstName: "Nome",
    lastName: "Sobrenome",
    username: "Nome de usuário",
    status: "Estado",
  },

  status: {
    connected: "conectado",
    connecting: "conectando",
    disconnected: "desconectado",
    error: "erro",
    online: "em linha",
    offline: "fora de linha",
    lastSeen: ({ time }: { time: string }) => `visto por último ${time}`,
    actionRequired: "ação necessária",
    permissionRequired: "permissão necessária",
    activeNow: "Ativo agora",
    unknown: "desconhecido",
  },

  connectionStatus: {
    title: "Conexão",
    labels: {
      server: "Servidor",
      socket: "WebSocket",
      authenticated: "Autenticado",
      lastSync: "Última sincronização",
      nextRetry: "Próxima tentativa",
      lastError: "Último erro",
    },
  },

  time: {
    justNow: "agora mesmo",
    minutesAgo: ({ count }: { count: number }) =>
      `há ${count} minuto${count !== 1 ? "s" : ""}`,
    hoursAgo: ({ count }: { count: number }) =>
      `há ${count} hora${count !== 1 ? "s" : ""}`,
  },

  connect: {
    restoreAccount: "Restaurar conta",
    enterSecretKey: "Por favor, insira uma chave secreta",
    invalidSecretKey: "Chave secreta inválida. Verifique e tente novamente.",
    enterUrlManually: "Inserir URL manualmente",
    scanComputerQrUnavailableTitle: "Escanear QR do computador indisponível",
    scanComputerQrUnavailableBody:
      "Este método de login está desativado neste servidor. Use outra opção abaixo para restaurar sua conta.",
    scanComputerQrInstructions: "Escaneie o código QR exibido no Happier no seu computador (Configurações → Adicionar seu telefone).",
    scanComputerQrButton: "Escanear QR para entrar",
    waitingForApproval: "Aguardando aprovação…",
    showQrInstead: "Mostrar um código QR em vez disso",
    addPhoneQrInstructions: "Escaneie este código QR com o app móvel do Happier para entrar no seu telefone.",
    serverUrlNotEmbeddedTitle: "Configure o servidor no seu telefone",
    serverUrlNotEmbeddedBody:
      "Este QR code não pode incluir o endereço do servidor porque ele está definido como localhost. No seu telefone, vá em Configurações → Servidores e adicione uma URL que o telefone consiga acessar (IP da LAN ou Tailscale) e depois escaneie novamente.",
    pairingRequestTitle: "Solicitação de pareamento",
    pairingRequestBody: "Verifique se este código corresponde ao que aparece no seu telefone e, em seguida, aprove.",
    pairingAlreadyRequestedTitle: "Código já usado",
    pairingAlreadyRequestedBody:
      "Este código QR já foi escaneado em outro telefone. Peça ao computador para gerar um novo.",
    deviceLabel: "Dispositivo",
    confirmCodeLabel: "Código de confirmação",
    approveButton: "Aprovar",
    generateNewQrCode: "Gerar novo código QR",
    pairingQrExpired: "Este código QR expirou. Gere um novo.",
    openMachine: "Abrir máquina",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "Em um dispositivo onde você já está conectado, vá em Configurações → Conta e escaneie este código QR.",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} verificado`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `Encontramos uma conta Happier existente vinculada a ${provider}. Para concluir o login neste dispositivo, restaure a chave da sua conta usando o QR code ou sua chave secreta.`,
    restoreWithSecretKeyInstead: "Restaurar com chave secreta",
    restoreWithSecretKeyDescription:
      "Digite sua chave secreta para recuperar o acesso à sua conta.",
    lostAccessLink: "Sem acesso?",
    lostAccessTitle: "Perdeu o acesso à sua conta?",
    lostAccessBody:
      "Se você não tem mais nenhum dispositivo associado a esta conta e perdeu a chave secreta, você pode redefinir sua conta com seu provedor de identidade. Isso cria uma nova conta Happier. O histórico criptografado antigo não pode ser recuperado.",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `Continuar com ${provider}`,
    lostAccessConfirmTitle: "Redefinir conta?",
    lostAccessConfirmBody:
      "Isso criará uma nova conta e vinculará novamente sua identidade do provedor. O histórico criptografado antigo não pode ser recuperado.",
    lostAccessConfirmButton: "Redefinir e continuar",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    linkNewDeviceTitle: "Vincular Novo Dispositivo",
    linkNewDeviceSubtitle: "Escaneie o código QR exibido no seu novo dispositivo para vinculá-lo a esta conta",
    linkNewDeviceQrInstructions: "Abra o Happier no seu novo dispositivo e exiba o código QR",
    scanQrCodeOnDevice: "Escanear Código QR",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Conectar ${name}`,
      runCommandInTerminal: "Execute o seguinte comando no terminal:",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `Execute o seguinte comando no terminal:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "Prévia indisponível",
        previewUnavailableBody:
          "Não foi possível criar a prévia do diagnóstico.",
        submittedTitle: "Relatório de bug enviado",
        submittedExistingIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) =>
          `Um comentário foi publicado na issue #${issueNumber}.\n\nID do relatório: ${reportId}`,
        submittedNewIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) =>
          `A issue #${issueNumber} foi criada.\n\nID do relatório: ${reportId}`,
        submitFailedTitle: "Falha ao enviar",
        submitFailedFallbackMessage:
          "Não foi possível enviar este relatório.",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\nDeseja abrir uma issue do GitHub pré-preenchida?`,
        openFallbackIssueButton: "Abrir issue alternativa",
      },
      diagnostics: {
        title: "Diagnóstico",
        subtitle: "Escolha o que incluir e faça uma prévia antes de enviar.",
        includeTitle: "Incluir diagnóstico",
        includeSubtitle:
          "Anexe artefatos de depuração sanitizados para acelerar o diagnóstico.",
        disabledByServerSuffix: " (desativado pelo servidor)",
        pasteDoctorJson: {
          title: "CLI doctor JSON (opcional)",
          subtitle:
            "Se sua máquina estiver inacessível pela UI, execute `happier doctor --json` no computador e cole aqui.",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `Doctor JSON inválido: ${error}`,
          valid: "O doctor JSON parece válido e será anexado ao relatório.",
        },
        previewButton: "Pré-visualizar diagnóstico",
        preview: {
          title: "Prévia de diagnósticos",
          helper:
            "Esses artefatos serão enviados junto com o seu relatório (sanitizados e com tamanho limitado). Toque em um item para ver o conteúdo completo.",
          empty: "Nenhum artefato de diagnóstico seria enviado.",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `Abrir ${filename}`,
        },
        kinds: {
          app: {
            title: "Diagnóstico do app",
            detail:
              "Logs do app, ações recentes do usuário e resumo da sessão.",
          },
          daemon: {
            title: "Diagnóstico do daemon",
            detail:
              "Resumo do daemon e logs recentes do daemon das máquinas selecionadas.",
          },
          stackService: {
            title: "Diagnóstico do serviço Stack",
            detail:
              "Contexto do stack e logs recentes do stack (se disponíveis).",
          },
          server: {
            title: "Diagnóstico do servidor",
            detail: "Snapshot do servidor atualmente ativo.",
          },
        },
      },
      issueDetails: {
        title: "Descreva o problema",
        subtitle:
          "Forneça detalhes suficientes para que possamos reproduzir e diagnosticar rapidamente.",
        titleLabel: "Título (obrigatório)",
        titlePlaceholder: "Título curto",
        githubUsernameLabel: "Usuário do GitHub (opcional)",
        githubUsernamePlaceholder:
          "Usado como contato no corpo do issue",
        summaryLabel: "Resumo conciso (obrigatório)",
        summaryPlaceholder: "Resumo de um parágrafo",
        currentBehaviorLabel: "Comportamento atual (opcional)",
        currentBehaviorPlaceholder: "O que acontece de fato?",
        expectedBehaviorLabel: "Comportamento esperado (opcional)",
        expectedBehaviorPlaceholder: "O que deveria acontecer em vez disso?",
        reproductionStepsLabel: "Passos de reprodução (opcional)",
        reproductionStepsPlaceholder:
          "1. Abra o Happier\n2. Inicie uma sessão\n3. ...",
        whatChangedLabel: "O que mudou recentemente (opcional)",
        whatChangedPlaceholder:
          "Atualizações, mudanças de configuração, novos passos de configuração...",
      },
      similarIssues: {
        title: "Possíveis duplicatas",
        subtitle:
          "Se alguma corresponder, você pode publicar seu relatório como comentário em vez de abrir uma nova issue.",
        searching: "Pesquisando issues…",
        selectedTitle: ({ number }: { number: number }) =>
          `Usando a issue #${number}`,
        selectedSubtitle: "Toque para voltar a criar uma nova issue.",
        useIssueA11y: ({ number }: { number: number }) => `Usar issue #${number}`,
        issueState: {
          open: "Issue aberta",
          closed: "Issue fechada",
        },
      },
      frequencySeverity: {
        title: "Frequência e gravidade",
        frequencyLabel: "Frequência",
        severityLabel: "Gravidade",
        frequency: {
          always: "Sempre",
          often: "Frequentemente",
          sometimes: "Às vezes",
          once: "Uma vez",
        },
        severity: {
          blocker: "Bloqueante",
          high: "Alta",
          medium: "Média",
          low: "Baixa",
        },
      },
      environment: {
        title: "Ambiente (editável)",
        appVersionLabel: "Versão do app",
        platformLabel: "Plataforma",
        osVersionLabel: "Versão do SO",
        deviceModelLabel: "Modelo do dispositivo",
        serverUrlLabel: "URL do servidor",
        serverVersionLabel: "Versão do servidor (opcional)",
        deploymentTypeLabel: "Tipo de implantação",
        deploymentType: {
          cloud: "Nuvem",
          selfHosted: "Auto-hospedado",
          enterprise: "Empresarial",
        },
      },
      consent: {
        title: "Consentimento",
        understandTitle:
          "Entendo que o diagnóstico pode incluir metadados técnicos",
        understandSubtitle:
          "Não inclua senhas, tokens de acesso ou chaves privadas.",
      },
      submit: {
        requiredFieldsHint:
          "Preencha os campos obrigatórios para habilitar o envio.",
        submitting: "Enviando relatório…",
        addToIssue: ({ number }: { number: number }) =>
          `Adicionar à issue #${number}`,
        submitNew: "Enviar relatório de bug",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer:
        "Ative a pesquisa de memória em Recursos para configurar a indexação local.",
      title: "A pesquisa de memória está desativada",
      subtitle: "Abra Configurações → Recursos para ativar memory.search",
      openFeatureSettings: "Abrir configurações de recursos",
      alertTitle: "Pesquisa de memória desativada",
      alertBody: "Ative memory.search em Configurações → Recursos.",
    },
    enabled: {
      title: "Ativado",
      subtitle: "Crie e mantenha um índice local nesta máquina",
      footer:
        "Quando ativado, o Happier cria um índice local no dispositivo a partir de transcrições descriptografadas para facilitar lembrança e busca rápidas.",
    },
    budgets: {
      groupTitle: "Orçamento de disco",
      groupFooter:
        "Limita quanto espaço em disco o índice de memória local pode usar (remoção best-effort).",
      mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
      lightTitle: "Orçamento do índice leve",
      lightPromptTitle: "Orçamento do índice leve",
      lightPromptBody:
        "MB máximos para o índice leve (resumos) nesta máquina.",
      deepTitle: "Orçamento do índice profundo",
      deepPromptTitle: "Orçamento do índice profundo",
      deepPromptBody:
        "MB máximos para o índice profundo (chunks) nesta máquina.",
    },
    privacy: {
      groupTitle: "Privacidade",
      groupFooter:
        "Exclui índices derivados locais e caches do modelo ao desativar a busca de memória.",
      deleteOnDisableTitle: "Excluir ao desativar",
      deleteOnDisableSubtitle:
        "Remove índices e caches locais quando a busca de memória está desativada",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `Máquina: ${machine}`,
      searchPlaceholder: "Buscar na memória",
      enableLocalSearch: "Ativar busca de memória local",
      emptyResults: "Ainda não há resultados de memória",
    },
        status: {
            title: "Estado do índice local",
            diskUsageTitle: "Uso em disco",
            disabled: "A busca de memória local está desativada nesta máquina",
            readyLight: "O índice leve está pronto nesta máquina",
            readyDeep: "O índice profundo está pronto nesta máquina",
            unavailableLight: "O índice leve ainda não está pronto nesta máquina",
            unavailableDeep: "O índice profundo ainda não está pronto nesta máquina",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
            diskUsageUnavailable: "Uso em disco indisponível",
            ...memoryEmbeddingsTranslationExtension.status,
            embeddingsTitle: "Runtime de embeddings",
            embeddingsProviderTitle: "Provedor de embeddings",
            embeddingsModelTitle: "Modelo de embeddings",
            embeddingsDisabled: "Os embeddings estão desativados",
            embeddingsReady: "Os embeddings estão prontos",
            embeddingsDownloading: "O modelo de embeddings está sendo baixado",
            embeddingsFallback: "Embeddings indisponíveis; usando fallback somente de texto",
            embeddingsUnavailable: "Embeddings indisponíveis",
            embeddingsError: "Falha ao inicializar os embeddings",
            embeddingsProviderLocal: "Modelo local",
            embeddingsProviderOpenAiCompatible: "Endpoint compatível com OpenAI",
        },
    machine: {
      title: "Máquina",
      changeTitle: "Trocar máquina",
      noMachine: "Sem máquina",
    },
    indexMode: {
      title: "Modo de índice",
      footer:
        "O modo leve armazena pequenos fragmentos de resumo. O modo profundo pode encontrar mais, mas usa mais disco.",
      triggerTitle: "Modo",
      options: {
        lightTitle: "Leve (recomendado)",
        lightSubtitle: "Apenas fragmentos de resumo",
        deepTitle: "Profundo",
        deepSubtitle: "Indexar trechos de mensagens localmente",
      },
    },
    backfill: {
      title: "Preenchimento",
      footer:
        "Controla quanto histórico é indexado ao ativar a memória local.",
      triggerTitle: "Política",
      options: {
        newOnlyTitle: "Somente novo (recomendado)",
        newOnlySubtitle: "Indexar apenas conteúdo criado após ativar",
        last30DaysTitle: "Últimos 30 dias",
        last30DaysSubtitle: "Preencher sessões recentes",
        allHistoryTitle: "Todo o histórico",
        allHistorySubtitle: "Preencher tudo (pode levar tempo)",
      },
    },
    hints: {
      title: "Geração de dicas de memória",
      footer:
        "Controla como os fragmentos de resumo são gerados para a pesquisa de memória leve.",
      backend: {
        title: "Backend do resumidor",
        promptTitle: "Backend do resumidor",
        promptBody:
          "Digite um id de backend de execution-run (ex.: claude, codex).",
      },
      model: {
        title: "Modelo do resumidor",
        promptTitle: "Modelo do resumidor",
        promptBody: "Digite um id de modelo para repassar ao backend.",
      },
      permissions: {
        triggerTitle: "Permissões do resumidor",
        options: {
          noToolsTitle: "Sem ferramentas (recomendado)",
          noToolsSubtitle: "Resumir apenas texto",
          readOnlyTitle: "Somente leitura",
          readOnlySubtitle:
            "Permitir ferramentas não mutantes quando suportadas",
        },
      },
    },
    embeddings: {
      modelTitle: "Modelo de embeddings",
      promptBody: "Insira um id de modelo transformers local.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
      groupTitle: "Busca vetorial",
      groupFooter:
        "Opcional: melhore o ranqueamento da busca profunda com um modelo local ou seu próprio endpoint compatível com OpenAI.",
      mode: {
        title: "Modo de embeddings",
        options: {
          disabledTitle: "Desativado",
          disabledSubtitle: "Usar ranqueamento somente por texto na busca profunda",
          balancedTitle: "Equilibrado",
          balancedSubtitle: "Predefinição local rápida e validada",
          longContextTitle: "Contexto longo",
          longContextSubtitle: "Melhor para trechos maiores de conversa",
          qualityTitle: "Qualidade",
          qualitySubtitle: "Predefinição local de maior custo para avaliação",
          customTitle: "Personalizado",
          customSubtitle: "Escolha seu próprio provedor e modelo",
        },
      },
      provider: {
        title: "Provedor",
        options: {
          localTitle: "Modelo local",
          localSubtitle: "Gerenciado pelo Happier e baixado no primeiro uso",
          openAiCompatibleTitle: "Endpoint compatível com OpenAI",
          openAiCompatibleSubtitle: "Use seu próprio servidor de embeddings e chave de API",
        },
      },
      notSet: "Não definido",
      secretSet: "Definido",
      secretNotSet: "Não definido",
      queryPrefixTitle: "Prefixo da consulta",
      queryPrefixPromptBody: "Prefixo opcional adicionado às buscas do usuário antes de gerar embeddings.",
      documentPrefixTitle: "Prefixo do documento",
      documentPrefixPromptBody: "Prefixo opcional adicionado aos trechos indexados de memória antes de gerar embeddings.",
      openAi: {
        baseUrlTitle: "URL base",
        baseUrlPromptBody: "Insira a URL base do endpoint de embeddings compatível com OpenAI.",
        modelTitle: "Modelo remoto",
        modelPromptBody: "Insira o id do modelo de embeddings a ser solicitado ao endpoint remoto.",
        apiKeyTitle: "Chave de API",
        apiKeyPromptBody: "Insira a chave de API usada pelo endpoint remoto de embeddings.",
        dimensionsTitle: "Dimensões",
        dimensionsPromptBody: "Substituição opcional da dimensão de saída para endpoints que oferecem suporte a isso.",
      },
      advanced: {
        ftsWeightTitle: "Peso do ranqueamento textual",
        ftsWeightPromptBody: "Peso relativo do ranqueamento full-text do SQLite ao combinar resultados.",
        embeddingWeightTitle: "Peso do ranqueamento por embeddings",
        embeddingWeightPromptBody: "Peso relativo da similaridade de embeddings ao combinar resultados.",
      },
    },
  },

  subAgentGuidance: {
    ruleEditor: {
      header: {
        newRule: "Nova regra",
        editRule: "Editar regra",
      },
      enabled: {
        title: "Ativado",
      },
      enabledState: {
        enabled: "Ativado",
        disabled: "Desativado",
      },
      common: {
        noPreference: "Sem preferência",
      },
      titleField: {
        label: "Título (opcional)",
        placeholder: "ex.: trabalho de UI",
      },
      descriptionField: {
        label: "Quando o agente deve delegar?",
        placeholder: "Descreva quando/como delegar…",
      },
      backendPicker: {
        title: "Backend alvo (opcional)",
        searchPlaceholder: "Pesquisar backends",
        noPreference: {
          subtitle: "Deixe o agente escolher um backend.",
        },
      },
      modelPicker: {
        title: "Modelo alvo (opcional)",
        searchPlaceholder: "Pesquisar modelos",
        noPreference: {
          subtitle: "Deixe o backend escolher um modelo padrão.",
        },
      },
      intent: {
        title: "Intenção sugerida (opcional)",
        noPreference: {
          subtitle: "Deixe o agente decidir a intenção.",
        },
        options: {
          review: {
            title: "Revisão",
            subtitle: "Revisão de código / achados.",
          },
          plan: {
            title: "Plano",
            subtitle: "Planejamento / arquitetura.",
          },
          delegate: {
            title: "Delegar",
            subtitle: "Delegação / execução.",
          },
        },
      },
      exampleToolCalls: {
        label: "Exemplos de chamadas de ferramenta (opcional, uma por linha)",
        placeholder: "ex.: execution.run.start …",
      },
    },
    settings: {
      groupTitle: "Subagentes",
      disabled: {
        footer:
          "Execution runs está desativado. Ative Execution Runs em Configurações → Recursos para usar a orientação de delegação.",
        enableExecutionRuns: {
          title: "Ativar Execution Runs",
          subtitle: "Abrir configurações de Recursos",
        },
      },
      footer:
        "As regras são anexadas ao prompt do sistema para que o agente principal saiba quando e como você prefere iniciar execuções de subagentes.",
      overview: {
        groupTitle: "Visão geral",
        footer:
          "Use esta página para configurar a orientação de subagentes e navegar para configurações relacionadas de provedor, backend e sessão.",
        explainerTitle: "O que esta página controla",
        explainerSubtitle:
          "Orientação de delegação para Subagentes, além de links para configurações específicas de cada provedor.",
        happierStatusTitle: "Subagentes",
        happierStatusEnabledSubtitle:
          "Ativado. Você pode iniciar Subagentes a partir de sessões compatíveis.",
        happierStatusDisabledSubtitle:
          "Desativado. Abra as configurações de Recursos para ativar Subagentes.",
      },
      related: {
        groupTitle: "Configurações relacionadas",
        footer:
          "A inicialização e o controle de subagentes também dependem do comportamento da sessão, dos provedores e dos backends configurados.",
        sessionTitle: "Comportamento da sessão",
        sessionSubtitle:
          "Envio de mensagens, direcionamento quando ocupado e comportamento de replay/retomada.",
        providersTitle: "Provedores",
        providersSubtitle:
          "Configurações específicas de autenticação, runtime e agentes de cada provedor.",
        backendsTitle: "Catálogo ACP",
        backendsSubtitle: "Backends configurados e alvos de inicialização personalizados.",
      },
      enableInjection: {
        title: "Ativar injeção de orientação",
      },
      characterBudget: {
        title: "Limite de caracteres",
        subtitle: ({ value }: { value: string }) => `${value} caracteres`,
        promptTitle: "Limite de caracteres",
        promptBody: "Máximo de caracteres a injetar no prompt do sistema.",
      },
      rules: {
        groupTitle: "Regras de orientação",
        footerEnabled:
          "Toque em uma regra para editar. O agente usa isso como dicas de delegação.",
        footerDisabled: "Ative a injeção para ativar as regras.",
        emptyTitle: "Ainda não há regras",
        emptySubtitle: "Adicione uma regra para orientar a delegação.",
        addRuleTitle: "Adicionar regra",
        addRuleSubtitle: "Criar uma nova regra de orientação",
        untitled: "Regra sem título",
        descriptionFallback: "Descreva quando delegar.",
        tapToEdit: "Toque para editar",
        meta: {
          target: ({ value }: { value: string }) => `Alvo: ${value}`,
          model: ({ value }: { value: string }) => `Modelo: ${value}`,
          intent: ({ value }: { value: string }) => `Intenção: ${value}`,
        },
      },
      preview: {
        title: "Pré-visualização",
        footer:
          "Este é o texto (truncado) anexado ao prompt do sistema.",
        systemPromptLabel: "Prompt do sistema (anexado)",
      },
      providers: {
        claude: {
          title: "Agentes em equipe do Claude",
          footer:
            "O comportamento de subagentes específico do provedor continua sendo controlado na tela de configurações do provedor.",
          openTitle: "Opções de subagentes do Claude",
          openSubtitle:
            "Gerencie Agent Teams e outros comportamentos de subagentes específicos do Claude.",
        },
      },
    },
  },

  settings: {
    title: "Configurações",

    // Main settings hub category groups
      profileAndAccount: 'Perfil e conta',
      aiAndAgents: 'IA e agentes',
      sessionsBehavior: 'Sessões e comportamento',
      general: 'Geral',
      filesAndSourceControl: 'Arquivos e controle de código-fonte',
      system: 'Sistema',

    // Renamed / promoted items
      sessions: 'Sessões',
      transcript: 'Transcrição',
      transcriptSubtitle: 'Raciocínio, renderização de ferramentas e exibição de código',
      permissions: 'Permissões',
      permissionsSubtitle: 'Modo de permissões e comportamento de aprovações',
    filesSourceControl: 'Arquivos e controle de código-fonte',
    filesSourceControlSubtitle: 'Editor, diffs e integração com controle de código-fonte',
    workspaces: 'Espaços de trabalho',
    workspacesSubtitle: 'Gerencie workspaces vinculados, locais e checkouts',

    connectedAccounts: "Contas conectadas",
    connectedAccountsDisabled: "Os serviços conectados estão desativados.",
    connectAccount: "Conectar conta",
    github: "GitHub",
    machines: "Máquinas",
    features: "Recursos",
    social: "Rede social",
    account: "Conta",
    accountSubtitle: "Gerencie os detalhes da sua conta",
    addYourPhone: "Adicionar seu telefone",
    addYourPhoneSubtitle: "Mostre um código QR para entrar no seu telefone",
    addMachine: "Adicionar uma máquina",
    machineSetupCurrentMachineTitle: "Este computador",
    machineSetupCurrentMachineSubtitle: "Inicialize o Happier diretamente neste dispositivo",
    machineSetupSshMachineTitle: "Máquina remota via SSH",
    machineSetupSshMachineSubtitle: "Conecte uma dev box, VM ou servidor com SSH",
    machineSetupStagesTitle: "O que acontece",
    machineSetupStageConnect: "Conectar e validar o acesso",
    machineSetupStageInstall: "Instalar o Happier e emparelhar a máquina",
    machineSetupStageFinish: "Concluir a configuração no terminal integrado",
    machineSetupComingSoon: "A inicialização de máquinas estará disponível em breve.",
    appearance: "Aparência",
    appearanceSubtitle: "Personalize a aparência do aplicativo",
    voiceAssistant: "Assistente de voz",
    voiceAssistantSubtitle: "Configure as preferências de interação por voz",
    memorySearch: "Pesquisa de memória local",
    memorySearchSubtitle: "Pesquise em conversas anteriores (no dispositivo)",
    notifications: "Notificações",
    notificationsSubtitle: "Preferências de notificações push",
    attachments: "Anexos",
    attachmentsSubtitle: "Preferências de upload de arquivos",
    sourceControl: "Controle de versão",
    sourceControlSubtitle: "Estratégia de commits e comportamento do backend",
    automations: "Automações",
    automationsSubtitle: "Gerencie sessões agendadas e execuções recorrentes",
    executionRunsSubtitle: "Execuções em várias máquinas",
    connectedServices: "Serviços conectados",
    connectedServicesSubtitle: "Assinaturas Claude/Codex e perfis OAuth",
    featuresTitle: "Recursos",
    featuresSubtitle: "Ativar ou desativar recursos do aplicativo",
    developer: "Desenvolvedor",
    developerTools: "Ferramentas de desenvolvedor",
    about: "Sobre",
    actionsSettingsAboutSubtitle:
      "Ative ou desative ações globalmente, por superfície (UI/voz/MCP) e por posicionamento (onde aparecem na interface). Ações desativadas são bloqueadas (fail-closed) em tempo de execução.",
    aboutFooter:
      "Happier Coder é um cliente móvel para Codex e Claude Code. Usa criptografia de ponta a ponta por padrão, com restauração da conta nos seus outros dispositivos. Não é afiliado à Anthropic.",
    whatsNew: "Novidades",
    whatsNewSubtitle: "Veja as atualizações e melhorias mais recentes",
    reportIssue: "Relatar um problema",
    privacyPolicy: "Política de privacidade",
    termsOfService: "Termos de serviço",
    rateUs: "Avalie o Happier",
    rateUsSubtitle: "Se você gosta do app, uma avaliação rápida ajuda muito",
    eula: "EULA",
    supportUs: "Nos apoie",
    supportUsSubtitlePro: "Obrigado pelo seu apoio!",
    supportUsSubtitle: "Apoie o desenvolvimento do projeto",
    scanQrCodeToAuthenticate: "Escaneie o QR para conectar o terminal",
    githubConnected: ({ login }: { login: string }) =>
      `Conectado como @${login}`,
    connectGithubAccount: "Conecte sua conta GitHub",
    claudeAuthSuccess: "Conectado ao Claude com sucesso",
    exchangingTokens: "Trocando tokens...",
    usage: "Uso",
    usageSubtitle: "Visualizar uso da API e custos",
    profiles: "Perfis",
    profilesSubtitle: "Gerenciar perfis de ambiente e variáveis",
    secrets: "Segredos",
    secretsSubtitle:
      "Gerencie os segredos salvos (não serão exibidos novamente após o envio)",
    terminal: "Terminal (CLI)",
    session: "Sessão",
    sessionSubtitleTmuxEnabled: "Tmux ativado",
    sessionSubtitleMessageSendingAndTmux: "Envio de mensagens e tmux",
        actionsSubtitle: "Escolha onde cada ação aparece no app, na voz e nas integrações.",
    prompts: "Prompts e habilidades",
    promptsSubtitle: "Biblioteca de prompts, modelos e pilhas",
    servers: "Servidores",
	    serversSubtitle: "Servidores salvos, grupos e padrões",
		    systemStatus: "Status do sistema",
		    systemStatusSubtitle: "Servidores, conta, máquinas, daemon",
		    mcpServers: "Servidores MCP",
		    mcpServersSubtitle: "Gerencie servidores MCP e vínculos",
		    mcpServersComingSoon: "As configurações de servidores MCP estarão disponíveis em breve.",
		    mcpServersStrictMode: "Modo estrito",
		    mcpServersStrictModeSubtitle: "Falhar com bloqueio quando as configurações do servidor MCP forem inválidas.",
		    mcpServersCatalogTitle: "Catálogo",
		    mcpServersUnnamed: "Servidor sem nome",
		    mcpServersEmptyTitle: "Ainda não há servidores MCP",
		    mcpServersEmptySubtitle: "Adicione servidores MCP para usá-los nas sessões.",
		    mcpServersAddServer: "Adicionar servidor",
		    mcpServersAddServerSubtitle: "Criar uma nova entrada de servidor MCP",
		    mcpServersEditorTitle: "Servidor MCP",
		    mcpServersPickSecretTitle: "Escolher um segredo",
		    mcpServersPickSecretNoneSubtitle: "Nenhum segredo selecionado",
		    mcpServersEditorBasics: "Básico",
		    mcpServersEditorStdio: "Entrada/saída padrão",
		    mcpServersEditorRemote: "Remoto",
		    mcpServersEditorBindings: "Vínculos",
		    mcpServersFieldName: "Nome",
		    mcpServersFieldTitle: "Título",
		    mcpServersFieldTitlePlaceholder: "Título de exibição opcional",
		    mcpServersFieldTransport: "Transporte",
		    mcpServersFieldCommand: "Comando",
		    mcpServersFieldArgs: "Argumentos",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "Vínculo",
		    mcpServersBindingEnabled: "Ativado",
		    mcpServersBindingEnabledSubtitle: "Ative ou desative este vínculo",
		    mcpServersBindingTarget: "Destino",
		    mcpServersBindingTargetSubtitle: "Onde este servidor fica disponível",
		    mcpServersBindingMachine: "Máquina",
		    mcpServersBindingMachineSubtitle: "Selecione uma máquina",
		    mcpServersBindingDeleteSubtitle: "Remover este vínculo",
		    mcpServersBindingTargetAllMachines: "Todas as máquinas",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `Máquina: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `Espaço de trabalho: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "Ativar em todas as máquinas",
		    mcpServersBindingTargetMachineTitle: "Máquina",
		    mcpServersBindingTargetMachineSubtitle: "Ativar em uma única máquina",
		    mcpServersBindingTargetWorkspaceTitle: "Espaço de trabalho",
		    mcpServersBindingTargetWorkspaceSubtitle: "Ativar apenas para um caminho específico de espaço de trabalho",
		    mcpServersValidationFailed: "As configurações do servidor MCP são inválidas.",
		    mcpServersServerNotFound: "Servidor não encontrado.",
		    mcpServersBindingsEmptyTitle: "Ainda não há vínculos",
		    mcpServersBindingsEmptySubtitle: "Adicione um vínculo para usar este servidor.",
		    mcpServersAddBinding: "Adicionar vínculo",
		    mcpServersAddBindingSubtitle: "Ativar este servidor para máquinas ou workspaces",
		    mcpServersSaveDisabledSubtitle: "Não há alterações para salvar.",
		    mcpServersDeleteTitle: "Excluir servidor MCP?",
		    mcpServersDeleteConfirm: ({ name }: { name: string }) => `Excluir "${name}"?`,
		    mcpServersDeleteSubtitle: "Remover este servidor do seu catálogo",
		    mcpServersNoMachineSelected: "Nenhuma máquina selecionada",
		    mcpServersDetectedTitle: "Detectado nas configurações dos provedores",
		    mcpServersDetectedMachineTitle: "Máquina",
		    mcpServersDetectedRefreshTitle: "Atualizar servidores detectados",
		    mcpServersDetectedRefreshSubtitle: "Examinar os arquivos de configuração dos provedores nesta máquina",
		    mcpServersDetectedWarningsTitle: "Avisos de detecção",
		    mcpServersDetectedEmptyTitle: "Nenhum servidor MCP detectado",
		    mcpServersDetectedEmptySubtitle: "Clique em atualizar para examinar as configurações do Claude/Codex/OpenCode.",
		    mcpServersImportTitle: "Importar servidor MCP?",
		    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) =>
		      `Importar "${name}" de ${provider}?`,
		    mcpServersImportAction: "Importar",
		    mcpServersBindingSummaryAllMachines: "Todas as máquinas",
		    mcpServersBindingSummaryMachines: ({ count }: { count: number }) =>
		      `${count} máquina${count === 1 ? "" : "s"}`,
		    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) =>
		      `${count} espaço${count === 1 ? " de trabalho" : "s de trabalho"}`,
		    mcpServersBindingSummaryNone: "Sem vínculo",
		    mcpServersPickWorkspaceTitle: "Escolher uma raiz de espaço de trabalho",
		    mcpServersBindingWorkspaceRootTitle: "Raiz do espaço de trabalho",
		    mcpServersBindingOverridesTitle: "Substituições",
		    mcpServersBindingOverridesNone: "Sem substituições",
		    mcpServersBindingOverridesCount: ({ count }: { count: number }) =>
		      `${count} substituição${count === 1 ? "" : "ões"}`,
		    mcpServersEditorEnv: "Ambiente",
		    mcpServersEnvAdd: "Adicionar variável de ambiente",
		    mcpServersEnvAddSubtitle: "Defina variáveis de ambiente para este servidor",
		    mcpServersEnvEmptyTitle: "Sem variáveis de ambiente",
		    mcpServersEnvEmptySubtitle: "Adicione variáveis de ambiente ou use Segredos salvos.",
		    mcpServersEditorHeaders: "Cabeçalhos",
		    mcpServersHeadersAdd: "Adicionar cabeçalho",
		    mcpServersHeadersAddSubtitle: "Defina cabeçalhos HTTP/SSE para este servidor",
		    mcpServersHeadersEmptyTitle: "Sem cabeçalhos",
		    mcpServersHeadersEmptySubtitle: "Adicione cabeçalhos se o servidor exigir autenticação.",
		    mcpServersEnvEditorTitle: "Editar variável de ambiente",
		    mcpServersHeadersEditorTitle: "Editar cabeçalho",
		    mcpServersEnvKeyLabel: "Nome da variável de ambiente",
		    mcpServersEnvKeyPlaceholder: "API_KEY",
		    mcpServersHeaderKeyLabel: "Nome do cabeçalho",
		    mcpServersHeaderKeyPlaceholder: "Authorization",
		    mcpServersValueSourceTitle: "Origem do valor",
		    mcpServersArgsPlaceholder: "--flag\nvalue",
		    mcpServersValueSourceLiteral: "Valor literal",
		    mcpServersValueSourceLiteralSubtitle: "Armazene um valor (com suporte a templates ${VAR})",
		    mcpServersValueSourceSavedSecret: "Segredo salvo",
		    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `Segredo salvo: ${name}`,
		    mcpServersValueSourceSavedSecretSubtitle: "Referencie um Segredo salvo",
		    mcpServersValueLiteralLabel: "Valor",
		    mcpServersValueLiteralPlaceholder: "Valor ou ${ENV_VAR}",
		    mcpServersValueSecretLabel: "Segredo salvo",
		    mcpServersValueSecretSelect: "Selecionar segredo",
		    mcpServersValueSecretSelectSubtitle: "Escolha um Segredo salvo",
		    mcpServersKeyInvalid: "A chave é inválida.",
		    mcpServersKeyAlreadyExists: "A chave já existe.",
		    mcpServersOverridesStdioTitle: "Substituições de Stdio",
		    mcpServersOverridesCommandTitle: "Substituir comando",
		    mcpServersOverridesCommandSubtitle: "Usar um comando diferente para este vínculo",
		    mcpServersOverridesArgsTitle: "Substituir argumentos",
		    mcpServersOverridesArgsSubtitle: "Usar argumentos diferentes para este vínculo (em branco = argumentos vazios)",
		    mcpServersOverridesRemoteTitle: "Substituições remotas",
		    mcpServersOverridesUrlTitle: "Substituir URL",
		    mcpServersOverridesUrlSubtitle: "Usar uma URL diferente para este vínculo",
		    mcpServersOverridesEnvPatchTitle: "Patch de ambiente",
		    mcpServersOverridesEnvPatchEmptyTitle: "Sem substituições de ambiente",
		    mcpServersOverridesEnvPatchEmptySubtitle: "Adicione substituições ou exclusões para variáveis de ambiente.",
		    mcpServersOverridesHeadersPatchTitle: "Patch de cabeçalhos",
		    mcpServersOverridesHeadersPatchEmptyTitle: "Sem substituições de cabeçalhos",
		    mcpServersOverridesHeadersPatchEmptySubtitle: "Adicione substituições ou exclusões para cabeçalhos.",
		    mcpServersOverridesDeleteValue: "Excluir esta chave neste vínculo",
		    mcpServersOverridesEnvPatchAddTitle: "Adicionar substituição de ambiente",
		    mcpServersOverridesEnvPatchAddSubtitle: "Defina ou substitua uma variável de ambiente para este vínculo",
		    mcpServersOverridesEnvPatchDeleteTitle: "Excluir chave de ambiente",
		    mcpServersOverridesEnvPatchDeleteSubtitle: "Remova uma variável de ambiente deste vínculo",
		    mcpServersOverridesHeadersPatchAddTitle: "Adicionar substituição de cabeçalho",
		    mcpServersOverridesHeadersPatchAddSubtitle: "Defina ou substitua um cabeçalho para este vínculo",
		    mcpServersOverridesHeadersPatchDeleteTitle: "Excluir chave de cabeçalho",
		    mcpServersOverridesHeadersPatchDeleteSubtitle: "Remova um cabeçalho deste vínculo",
		    mcpServersOverridesDeleteEnvTitle: "Excluir chave de ambiente",
		    mcpServersOverridesDeleteEnvPrompt: "Insira o nome da variável de ambiente a excluir deste vínculo.",
		    mcpServersOverridesDeleteHeaderTitle: "Excluir chave de cabeçalho",
		    mcpServersOverridesDeleteHeaderPrompt: "Insira o nome do cabeçalho a excluir deste vínculo.",
		    mcpServersOverridesCommandRequired: "A substituição de comando está ativada, mas vazia.",
		    mcpServersOverridesUrlRequired: "A substituição de URL está ativada, mas vazia.",
		    mcpServersTestTitle: "Teste",
		    mcpServersTestFooter: "Executa na máquina selecionada. Nenhum segredo é mostrado nos resultados.",
		    mcpServersTestMachineTitle: "Testar na máquina",
		    mcpServersTestBindingTitle: "Usar vínculo",
		    mcpServersTestNoBinding: "Sem vínculo",
		    mcpServersTestNoBindingSubtitle: "Testar sem substituições do vínculo",
		    mcpServersTestDirectoryTitle: "Diretório de trabalho",
		    mcpServersTestDirectorySubtitle: "Toque para definir um diretório",
		    mcpServersTestDirectoryPrompt: "Insira o diretório de trabalho para o teste.",
		    mcpServersTestRunTitle: "Testar servidor",
		    mcpServersTestRunSubtitle: "Conectar e listar ferramentas",
		    mcpServersTestResultOkTitle: "Teste concluído com sucesso",
		    mcpServersTestResultOkSubtitle: ({
		      toolCount,
		      durationMs,
		    }: {
		      toolCount: number;
		      durationMs: number;
		    }) => `${toolCount} ferramentas · ${durationMs}ms`,
		    mcpServersTestResultErrorTitle: "Teste falhou",
        ...mcpServersUxTranslationExtension,
        ...acpCatalogTranslationExtension.settings,

		    // Dynamic settings messages
		    accountConnected: ({ service }: { service: string }) =>
		      `Conta ${service} conectada`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} está ${status === "online" ? "online" : "offline"}`,
		  featureToggled: ({
		      feature,
		      enabled,
		    }: {
		      feature: string;
		      enabled: boolean;
		    }) => `${feature} ${enabled ? "ativado" : "desativado"}`,
		  },

	  systemStatus: {
	    sections: {
	      appHealth: "Saúde do app e sincronização",
	      currentServer: "Servidor atual",
      identity: "Identidade conectada",
      configuredServers: "Servidores configurados",
      machinesActiveServer: "Máquinas (servidor ativo)",
      machinesOtherServer: ({ server }: { server: string }) => `Máquinas (${server})`,
      actions: "Ações",
    },
    ui: {
      dataReady: "Dados prontos",
      realtime: "Tempo real",
      socket: "Socket (WebSocket)",
      socketLastError: ({ error }: { error: string }) => `Último erro: ${error}`,
      lastSync: "Última sincronização",
    },
    server: {
      activeServer: "Servidor ativo",
    },
    identity: {
      accountId: "ID da conta",
      username: "Nome de usuário",
    },
    servers: {
      noneConfigured: "Nenhum servidor configurado",
      active: "Ativo",
    },
    machines: {
      none: "Nenhuma máquina",
      status: ({ status }: { status: string }) => `Status: ${status}`,
    },
    machine: {
      unknownHost: "Máquina desconhecida",
      online: "Conectada",
      offline: "Desconectada",
      fetchDoctorSnapshot: {
        loading: "Buscando servidor/conta do daemon…",
        invalid: "Não foi possível ler o doctor snapshot da máquina",
      },
      daemonAttributionUnknown: "Servidor/conta do daemon: desconhecido",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `Daemon: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `Última verificação: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "Incompatível",
    time: {
      secondsAgo: ({ count }: { count: number }) => `há ${count}s`,
      minutesAgo: ({ count }: { count: number }) => `há ${count}m`,
      hoursAgo: ({ count }: { count: number }) => `há ${count}h`,
      daysAgo: ({ count }: { count: number }) => `há ${count}d`,
    },
    actions: {
      runDiagnosis: "Executar diagnóstico",
      runDiagnosisSubtitle: "Detecta incompatibilidades de servidor/conta/daemon",
      refreshMachineAttribution: "Atualizar atribuição do daemon",
      refreshMachineAttributionSubtitle: "Busca servidor/conta do daemon para algumas máquinas online",
      copyJson: "Copiar JSON de Status do sistema",
      copyJsonSubtitle: "Compartilhe um snapshot redigido para suporte",
    },
  },

  diagnosis: {
    title: "Diagnóstico",
    sections: {
      overview: "Visão geral",
      actions: "Ações",
      pasteDoctorJson: "Colar CLI doctor JSON",
      machineRuns: "Execuções nas máquinas",
      serverProbe: "Teste do servidor",
      findings: "Achados",
    },
    overview: {
      activeServer: "Servidor ativo",
      account: "Conta",
      onlineMachines: "Máquinas online (servidor ativo)",
      cachedAttribution: ({ count }: { count: number }) => `${count} doctor snapshot(s) em cache disponível(is)`,
    },
    actions: {
      run: "Executar diagnóstico",
      runSubtitle: "Verifica servidor, conta, máquinas e alvo do daemon",
      copyReport: "Copiar relatório de diagnóstico",
      copyReportSubtitle: "Copie um relatório JSON redigido para suporte",
    },
    pasteDoctorJson: {
      footer: "Dica: execute `happier doctor --json` no seu computador e cole aqui.",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "Validar JSON colado",
      ok: "O doctor JSON colado parece válido.",
      helper: "Opcional: cole doctor JSON para diagnosticar incompatibilidades quando a máquina não é acessível.",
      error: ({ error }: { error: string }) => `Doctor JSON inválido: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "A máquina retornou um doctor snapshot inválido",
    },
    machineRuns: {
      none: "Nenhuma máquina online disponível",
      idle: "Ocioso",
      loading: "Executando…",
      ready: "Pronto",
      error: "Erro",
    },
    serverProbe: {
      title: "Diagnóstico do servidor",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "Execute o diagnóstico para ver resultados",
      notRunSubtitle: "Isso executa verificações seguras e redigidas (sem logs, a menos que você inclua diagnósticos em um relatório).",
      none: "Nenhum problema detectado",
      noneSubtitle: "Se o problema persistir, envie um bug report com diagnósticos.",
      code: ({ code }: { code: string }) => `Código: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `Detalhes para ${code}`,
        steps: {
          reportIssue: "Envie um bug report e inclua este relatório de diagnóstico.",
        },
      },
      serverMismatch: {
        title: "Incompatibilidade de servidor (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          chooseAccount: "Decida qual servidor/conta você quer usar.",
          switchUiServer: "Alinhe a UI e o daemon para o mesmo servidor.",
          restartDaemon: "Reinicie o daemon apontando para o servidor correto e tente novamente.",
        },
      },
      serverMismatchPasted: {
        title: "Incompatibilidade de servidor (UI vs colado)",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • Colado: ${pasted}`,
      },
      settingsMismatch: {
        title: "Incompatibilidade entre settings do CLI e servidor resolvido",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • resolvido: ${resolved}`,
      },
      accountMismatch: {
        title: "Incompatibilidade de conta (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          signInSameAccount: "Garanta que UI e CLI estejam na mesma conta no mesmo servidor.",
          cliReauth: "No CLI: saia e autentique novamente no servidor correto.",
        },
      },
      machineMissingAccount: {
        title: "A máquina não possui informações de conta",
      },
      noOnlineMachines: {
        title: "Nenhuma máquina online",
        steps: {
          startDaemon: "Inicie o daemon (e garanta que ele continue rodando).",
          checkNetwork: "Verifique a rede e tente novamente.",
        },
      },
      serverDiagnosticsDisabled: {
        title: "Diagnóstico do servidor desativado",
        steps: {
          ok: "Isso é normal se o servidor tiver diagnósticos desativados.",
        },
      },
      serverAuthError: {
        title: "Erro de autenticação do servidor (401)",
      },
      serverUnreachable: {
        title: "Servidor inacessível",
        steps: {
          checkServerUrl: "Verifique a URL do servidor e a conectividade de rede.",
          tryAgain: "Tente novamente em instantes.",
        },
      },
      serverHttpError: {
        title: "Erro HTTP no diagnóstico do servidor",
        subtitle: ({ status }: { status: string }) => `O servidor respondeu com ${status}`,
      },
      activeServerNotInProfiles: {
        title: "Servidor ativo não encontrado nos perfis salvos",
      },
      multipleServers: {
        title: "Vários servidores detectados entre as máquinas",
      },
    },
  },

  connectedServices: {
    fallbackName: "Serviço conectado",
    serviceNames: {
      claudeSubscription: "Assinatura Claude",
      openaiCodex: "Codex da OpenAI",
      openai: "Chave de API da OpenAI",
      anthropic: "Chave de API da Anthropic",
      gemini: "Gemini do Google",
    },
    title: "Serviços conectados",
    authChip: {
      label: "Autenticação",
      labelWithCount: ({ count }: { count: number }) => `Autenticação: ${count}`,
    },
    list: {
      empty: "Ainda não há serviços conectados.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "conectado", plural: "conectados" })}`,
      needsReauth: "precisa de reautenticação",
      notConnected: "não conectado",
    },
    quota: {
      loading: "Carregando…",
      error: ({ message }: { message: string }) => `Erro: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `Última atualização: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Última atualização: ${time} • desatualizado`,
      noData: "Ainda não há dados de cota",
      planLabel: ({ plan }: { plan: string }) => `Plano: ${plan}`,
    },
    oauthPaste: {
      invalidConfig: "Configuração de serviço conectado inválida.",
      connectWebGroupTitle: "Conectar (web)",
      connectWebDescription:
        "Abra a URL de autorização, conclua o OAuth no navegador e depois copie/cole a URL final redirecionada de volta no Happier.",
      openAuthorizationUrl: "Abrir URL de autorização",
      opensInNewTab: "Abre em uma nova aba",
      preparing: "Preparando…",
      pasteRedirectUrl: "Colar URL de redirecionamento",
      pasteRedirectUrlPlaceholder: "Colar URL de redirecionamento",
      pasteRedirectUrlPromptBody:
        "Após concluir o OAuth, copie a URL final redirecionada da barra de endereços do navegador e cole aqui.",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "Próximo passo: faça login na página que abrir. O Claude pode mostrar uma sequência de código em vez de redirecionar automaticamente.",
          pasteRedirectUrlPromptBody:
            "1) Faça login na página que abrir. 2) Copie a URL final ou o valor completo \"code#state\" exibido pelo Claude. 3) Cole no campo abaixo.",
          pasteRedirectUrlPlaceholder: "Colar URL de redirecionamento ou code#state",
          errors: {
            missingState:
              "Falta o estado OAuth. Se o Claude mostrar um código, copie o valor completo \"code#state\", não apenas o código.",
          },
        },
      },
      tryDeviceInstead: "Tentar autenticação do dispositivo",
      tryEmbeddedInstead: "Tentar navegador no app",
      working: "Processando…",
      alerts: {
        connectedTitle: "Conectado",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) está conectado.`,
        failedToOpenUrl: "Não foi possível abrir a URL",
        failedToConnect: "Falha ao conectar",
      },
      errors: {
        missingState: "Falta o estado OAuth na URL de redirecionamento.",
        stateMismatch: "O estado OAuth não corresponde.",
      },
    },
    oauthEmbedded: {
      title: "Conectar (navegador no app)",
      description:
        "Inicie o login em um navegador incorporado. Se não funcionar, use o método de colar a redireção.",
      startButton: "Iniciar login",
    },
    deviceAuth: {
      invalidConfig: "Configuração do serviço conectado inválida.",
      title: "Conectar (dispositivo)",
      description:
        "Abra a página de verificação, insira o código e mantenha esta tela aberta até que a conexão seja concluída.",
      openVerificationUrl: "Abrir página de verificação",
      userCode: "Código do usuário",
      securityHint:
        "Dica: toque em Copiar para copiar o código. Insira-o apenas em auth.openai.com. Nunca compartilhe com ninguém.",
      deviceAuthDisabledHint:
        "Se a página de verificação informar que a autorização por código de dispositivo está desativada, ative “Enable device code authorization for Codex” nas configurações do ChatGPT e tente novamente.",
      preparing: "Preparando…",
      waiting: "Aguardando aprovação…",
      polling: "Verificando aprovação…",
      usePasteInstead: "Usar URL de redirecionamento colada",
      useBrowserInstead: "Usar navegador no app",
      alerts: {
        connectedTitle: "Conectado",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) está conectado.`,
        failedToConnect: "Falha ao conectar",
        failedToStart: "Falha ao iniciar a autenticação do dispositivo",
      },
    },
    detail: {
      unknownService: "Serviço conectado desconhecido.",
      actionsGroupTitle: "Ações",
      actions: {
        setDefault: "Definir como padrão",
        unsetDefault: "Remover padrão",
        editLabel: "Editar rótulo",
        reconnect: "Reconectar",
      },
      setDefaultProfileTitle: "Definir perfil padrão",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Padrão: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Escolha qual perfil é selecionado por padrão",
      setProfileLabelTitle: "Definir rótulo do perfil",
      setProfileLabelSubtitle:
        "Rótulo opcional exibido nos seletores de autenticação",
      addOauthProfileTitle: "Adicionar perfil OAuth",
      addOauthProfileSubtitle: "Conectar um novo perfil de conta",
      addOauthProfileDeviceTitle: "Adicionar via autenticação do dispositivo",
      addOauthProfileDeviceSubtitle: "Recomendado para web/ambientes remotos",
      addOauthProfilePasteTitle: "Adicionar via colar redirecionamento",
      addOauthProfilePasteSubtitle: "Fluxo manual de copiar/colar URL de redirecionamento",
      addOauthProfileBrowserTitle: "Adicionar via navegador no app",
      addOauthProfileBrowserSubtitle: "Use um navegador incorporado quando suportado",
      connectApiKeyTitle: "Conectar com chave de API",
      connectApiKeySubtitle: "Cole uma chave de API da Anthropic",
      connectSetupTokenTitle: "Conectar com setup-token",
      connectSetupTokenSubtitle: "Cole um setup-token do Claude (de claude setup-token)",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Desconectar ${service} (${profileId})?`,
      prompts: {
        profileIdTitle: "ID do perfil",
        profileIdBody: "Use um rótulo curto como work, personal, alt.",
        apiKeyTitle: "Chave de API",
        apiKeyBody: "Cole sua chave de API da Anthropic.",
        apiKeyPlaceholder: "ex.: sk-ant-…",
        setupTokenTitle: "Token de configuração",
        setupTokenBody: "Cole seu setup-token do Claude (de claude setup-token).",
        setupTokenPlaceholder: "ex.: sk-ant-oat01-…",
        profileLabelTitle: "Rótulo do perfil",
        profileLabelBody: "Opcional. Exibido nos seletores de autenticação.",
        profileLabelPlaceholder: "Conta de trabalho",
      },
      alerts: {
        invalidProfileIdTitle: "ID de perfil inválido",
        invalidProfileIdBody:
          "Use letras, números, hífen ou sublinhado (máx. 64).",
        unknownProfileTitle: "Perfil desconhecido",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Nenhum perfil chamado \"${profileId}\" existe para ${service}.`,
      },
      profiles: {
        empty: "Ainda não há perfis.",
        connected: "Conectado",
        defaultBadge: "Padrão",
        needsReauth: "Precisa reautenticar",
      },
    },
    profile: {
      profileId: "ID do perfil",
      status: "Estado",
      email: "E-mail",
      accountId: "ID da conta",
      quotaTitle: "Cotas",
      defaultSubtitle: "Este perfil está selecionado por padrão",
      setDefaultSubtitle: "Usar este perfil por padrão",
      disconnectSubtitle: "Remover credenciais deste perfil",
      reconnectSubtitle: "Reautenticar este perfil",
    },
    authModal: {
      nativeAuthTitle: "Autenticação nativa do backend",
      nativeAuthSubtitle: "Use seu login local do CLI / chaves de API",
      connectedServicesTitle: "Usar serviços conectados",
      connectedServicesSubtitle: "Buscar e materializar da nuvem Happier",
      notConnectedTitle: "Não conectado",
      notConnectedSubtitle: "Toque para abrir configurações",
      profileLabel: "Perfil",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Arquivo muito grande",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Ignorados ${count} ${plural({ count, singular: "arquivo", plural: "arquivos" })} que excedem o tamanho máximo de anexo.`,
    },
  },

  settingsAttachments: {
    disabled: {
      title: "Anexos",
      footer:
        "Este recurso está desativado pelo seu servidor ou pela política de build.",
    },
    fileUploads: {
      title: "Uploads de arquivos",
    },
    uploadLocation: {
      title: "Local de upload",
      footer:
        "Os uploads no workspace são a opção mais compatível. Uploads para o diretório temporário do sistema podem ser úteis para evitar artefatos no repositório, mas podem não ser legíveis em sandboxes mais rígidos.",
      options: {
        workspace: {
          title: "Diretório do workspace (recomendado)",
          subtitle:
            "Os uploads são gravados em um diretório relativo ao workspace para que o sandbox do agente possa lê-los de forma confiável.",
        },
        osTemp: {
          title: "Diretório temporário do sistema",
          subtitle:
            "Os uploads são gravados no diretório temporário do sistema operacional. Isso pode falhar em sandboxes mais rígidos.",
        },
      },
    },
    workspaceDirectory: {
      title: "Diretório do workspace",
      footer:
        "Usado apenas quando o local de upload está definido como Diretório do workspace.",
      uploadsDirectory: {
        title: "Diretório de uploads",
        promptTitle: "Diretório de uploads",
        promptMessage:
          "Insira um diretório relativo ao workspace (sem caminhos absolutos, sem ..).",
        invalidDirectoryTitle: "Diretório inválido",
        invalidDirectoryMessage: "Use um caminho relativo como `.happier/uploads`.",
      },
    },
    sourceControlIgnore: {
      title: "Ignorar no controle de versão",
      footer:
        "Ignorados apenas locais evitam commits acidentais. Se você escolher .gitignore, isso pode modificar um arquivo rastreado.",
      options: {
        gitInfoExclude: {
          title: "Ignorar localmente (.git/info/exclude) (recomendado)",
          subtitle:
            "Evita commits acidentais sem modificar arquivos do repositório.",
        },
        gitignore: {
          title: "Ignorar via .gitignore",
          subtitle:
            "Escreve uma entrada no arquivo .gitignore do workspace (pode ser commitado).",
        },
        none: {
          title: "Não escrever regras de ignore",
          subtitle:
            "Uploads podem ser capturados pelo controle de versão dependendo da configuração do repositório.",
        },
      },
      writeIgnoreRules: {
        title: "Escrever regras de ignore",
      },
    },
    limits: {
      title: "Limites",
      footer:
        "Esses limites são aplicados pelo manipulador local de upload do CLI (melhor esforço).",
      invalidValueTitle: "Valor inválido",
      maxAttachmentSize: {
        title: "Tamanho máximo do anexo (bytes)",
        promptTitle: "Tamanho máximo do anexo (bytes)",
        promptMessage: "Exemplo: 26214400 para 25MB.",
        invalidValueMessage: "Insira um número entre 1024 e 1073741824.",
      },
    },
  },

  settingsSourceControl: {
    title: 'Arquivos e controle de código-fonte',
    editor: 'Editor de arquivos',
    editorFooter: 'Configure o comportamento do editor de arquivos.',
    editorAutoSave: 'Salvamento automático',
    editorAutoSaveDescription: 'Salva arquivos automaticamente após a edição.',
    commitStrategy: {
      title: "Estratégia de commit",
      footer:
        "O commit atômico evita interferência entre agentes no índice. O staging do Git habilita fluxos interativos de incluir/excluir.",
      options: {
        atomic: {
          title: "Commit atômico (recomendado)",
          subtitle:
            "Sem staging ao vivo no índice do repositório. Commite todas as mudanças pendentes em uma única operação RPC.",
        },
        gitStaging: {
          title: "Fluxo de staging do Git",
          subtitle:
            "Habilita incluir/excluir e staging parcial por linhas em repositórios Git.",
        },
      },
    },
    gitRoutingPreference: {
      title: "Preferência de roteamento para .git",
      footer:
        "Selecione qual backend preferir quando o modo do repositório é .git.",
      options: {
        git: {
          title: "Repositórios .git usam Git",
          subtitle: "Padrão e recomendado por compatibilidade.",
        },
        sapling: {
          title: "Repositórios .git preferem Sapling",
          subtitle:
            "Use o backend Sapling quando Git e Sapling estiverem disponíveis.",
        },
      },
    },
    remoteConfirmation: {
      title: "Confirmação remota",
      footer: "Controla se operações pull/push exigem confirmação.",
      options: {
        always: {
          title: "Sempre confirmar pull/push",
          subtitle: "Mostra diálogos de confirmação para pull e push.",
        },
        pushOnly: {
          title: "Confirmar apenas push",
          subtitle: "Pull roda imediatamente; push exige confirmação.",
        },
        never: {
          title: "Nunca confirmar",
          subtitle: "Executa pull e push imediatamente.",
        },
      },
    },
    pushRejectionRecovery: {
      title: "Recuperação de rejeição de push",
      footer:
        "Comportamento quando o push é rejeitado porque o branch está atrás do upstream.",
      options: {
        promptFetch: {
          title: "Perguntar para fazer fetch",
          subtitle:
            "Pergunta antes de executar fetch quando o push é rejeitado por não fast-forward.",
        },
        autoFetch: {
          title: "Fetch automático",
          subtitle:
            "Executa fetch automaticamente após rejeição de push não fast-forward.",
        },
        manual: {
          title: "Recuperação manual",
          subtitle: "Não executa fetch automaticamente após rejeição do push.",
        },
      },
    },
    commitMessageGenerator: {
      title: "Gerador de mensagens de commit",
      footer:
        "Opcional: gera sugestões de mensagens de commit usando uma tarefa LLM de uma única execução. Requer suporte de execution runs no daemon.",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `Backend do gerador: ${backendId}`,
      backendItemSubtitle:
        "ID do backend usado para geração pontual de mensagens de commit.",
      backendPromptTitle: "Backend de mensagem de commit",
      backendPromptMessage: "Digite o id do backend",
      instructionsPlaceholder: "Instruções de mensagem de commit",
    },
    commitAttribution: {
      title: "Atribuição do commit",
      footer:
        "Quando ativado, mensagens de commit geradas por IA incluirão créditos Co-Authored-By.",
      includeCoAuthoredBy: {
        title: "Incluir Co-Authored-By",
      },
    },
    filesDisplay: {
      title: "Exibição de arquivos",
      footer:
        "O destaque de sintaxe é experimental e pode ser desativado para diffs muito grandes.",
      diffRenderer: {
        options: {
          pierre: {
            title: "Renderizador de diff: Pierre",
            subtitle:
              "Melhor renderização de diff em web/desktop. Usa um pipeline com worker e faz fallback com segurança se indisponível.",
          },
          happier: {
            title: "Renderizador de diff: Happier",
            subtitle:
              "Renderizador de fallback para compatibilidade e depuração.",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Layout do diff: Unificado",
            subtitle:
              "Vista em linha (uma coluna). Melhor para telas estreitas e leitura rápida.",
          },
          split: {
            title: "Layout do diff: Lado a lado",
            subtitle:
              "Vista dividida (duas colunas). Melhor para telas grandes e comparações precisas.",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "Destaque de sintaxe: Desativado",
            subtitle:
              "Renderiza diffs e arquivos como texto monoespaçado simples.",
          },
          simple: {
            title: "Destaque de sintaxe: Simples",
            subtitle:
              "Destaque rápido baseado em tokens para linguagens comuns.",
          },
          advanced: {
            title: "Destaque de sintaxe: Avançado",
            subtitle:
              "Destaque de maior fidelidade em web/desktop; volta para simples no nativo.",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "Densidade de arquivos alterados: Confortável",
            subtitle:
              "Linhas maiores com subtítulos e status mais claros.",
          },
          compact: {
            title: "Densidade de arquivos alterados: Compacta",
            subtitle:
              "Linhas menores para facilitar a leitura quando muitos arquivos mudaram.",
          },
        },
      },
    },
    backends: {
      backendGroupTitle: ({ backendTitle }: { backendTitle: string }) =>
        `Backend: ${backendTitle}`,
      defaultDiffItemTitle: ({
        backendTitle,
        diffModeTitle,
      }: {
        backendTitle: string;
        diffModeTitle: string;
      }) => `Diff padrão de ${backendTitle}: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "Modo padrão ao visualizar arquivos com deltas incluídos e pendentes.",
    },
    diffMode: {
      pending: "Pendente",
      combined: "Combinado",
      included: "Incluído",
    },
  },

  settingsNotifications: {
    badges: {
      title: 'Badges neste dispositivo',
      footer: 'Escolha quais atividades contribuem para o badge do ícone do app neste dispositivo.',
      enabledTitle: 'Ativar badges',
      enabledSubtitle: 'Mostrar um badge no ícone do app quando houver atividade que exija atenção',
      unreadTitle: 'Unread sessions',
      unreadSubtitle: 'Count sessions that have unread transcript activity',
      permissionRequestsTitle: 'Solicitações de permissão',
      permissionRequestsSubtitle: 'Count sessions waiting for approval',
      userActionsTitle: 'Solicitações de ação',
      userActionsSubtitle: 'Count sessions waiting for an answer or confirmation',
      queuedTitle: 'Queued user input',
      queuedSubtitle: 'Count sessions with queued work you still need to send',
      friendRequestsTitle: 'Solicitações de amizade',
      friendRequestsSubtitle: 'Adicionar solicitações de amizade recebidas ao badge numérico',
      desktopDotTitle: 'Desktop dock dot',
      desktopDotSubtitle: 'On desktop, show a dot when only non-numeric inbox activity exists',
    },
    local: {
      title: 'Notificações locais neste dispositivo',
      footer: 'Esses controles afetam como as notificações aparecem neste dispositivo específico.',
      enabledSubtitle: 'Permitir que este dispositivo mostre notificações locais',
      readyTitle: 'Pronto',
      readySubtitle: 'Mostrar uma notificação local quando um turno terminar',
      readyPreviewTitle: 'Pré-visualizações de mensagens prontas',
      readyPreviewSubtitle: 'Incluir a mensagem mais recente do assistente nas notificações de pronto deste dispositivo',
      permissionRequestsTitle: 'Solicitações de permissão',
      permissionRequestsSubtitle: 'Mostrar uma notificação local quando uma sessão precisar de aprovação',
      userActionsTitle: 'Solicitações de ação',
      userActionsSubtitle: 'Mostrar uma notificação local quando uma sessão precisar da sua resposta',
    },
    push: {
      title: "Notificações push",
      footer:
        "Essas notificações são enviadas do seu CLI via Expo quando sua sessão precisa de atenção.",
      enabledSubtitle: "Permitir notificações push nesta conta",
    },
    webhooks: {
      title: 'Notificações por webhook',
      footer: 'Envie notificações de atividade remota para endpoints de webhook adicionais nesta conta.',
      addTitle: 'Adicionar webhook',
      addSubtitle: 'Entregar notificações para outro endpoint',
      emptyTitle: 'Nenhum canal de webhook',
      emptySubtitle: 'Adicione um webhook para entregar eventos de atividade remota fora do Expo push.',
      enabledTitle: 'Ativar webhook',
      enabledSubtitle: 'As notificações por webhook estão ativadas',
      disabledSubtitle: 'As notificações por webhook estão desativadas',
      channelEnabledSubtitle: 'Permitir que este endpoint receba notificações de atividade',
      urlPromptTitle: 'URL do webhook',
      urlPromptSubtitle: 'Insira a URL de destino para este webhook de notificação.',
      urlPromptPlaceholder: 'https://hooks.example.test/notify',
      invalidUrlTitle: 'URL de webhook inválida',
            invalidUrlSubtitle: 'Insira uma URL HTTP ou HTTPS válida.',
            deleteTitle: 'Remover webhook',
            deleteConfirm: ({ url }: { url: string }) => `Parar de enviar notificações para ${url}?`,
            signingSecretTitle: 'Segredo de assinatura',
            signingSecretEmptySubtitle: 'Adicione um segredo compartilhado para assinar as cargas úteis do webhook',
            signingSecretConfiguredSubtitle: 'As cargas úteis do webhook são assinadas com um segredo compartilhado',
            signingSecretPromptTitle: 'Segredo de assinatura do webhook',
            signingSecretPromptSubtitleAdd: 'Insira um segredo compartilhado para assinar a carga útil deste webhook.',
            signingSecretPromptSubtitleReplace: 'Insira um novo segredo compartilhado para substituir o segredo de assinatura existente.',
            signingSecretPromptPlaceholder: 'shared-secret',
            signingSecretClearAction: 'Limpar segredo',
            readyTitle: 'Pronto',
      readySubtitle: 'Enviar quando um turno terminar e o agente estiver aguardando seu comando',
      readyPreviewTitle: 'Pré-visualizações de mensagens prontas',
      readyPreviewSubtitle: 'Incluir o texto da mensagem mais recente do assistente nas notificações de pronto deste webhook',
      permissionRequestsTitle: 'Solicitações de permissão',
      permissionRequestsSubtitle: 'Enviar quando uma sessão estiver bloqueada aguardando aprovação',
      userActionsTitle: 'Solicitações de ação',
      userActionsSubtitle: 'Enviar quando uma sessão precisar de uma resposta ou confirmação',
    },
    foregroundBehavior: {
      title: "Notificações no app",
      footer:
        "Controla as notificações enquanto você usa o app. Notificações da sessão que você está visualizando são sempre silenciadas.",
      full: "Completas",
      fullDescription: "Mostrar banner e reproduzir som",
      silent: "Silenciosas",
      silentDescription: "Mostrar banner sem som",
      off: "Desativadas",
      offDescription: "Apenas badge, sem banner",
    },
    types: {
      title: "Tipos",
      footer: "Desative tipos individuais se quiser apenas certos alertas.",
      ready: {
        title: "Pronto",
        subtitle:
          "Notificar quando um turno termina e o agente está aguardando seu comando",
      },
      readyPreview: {
        title: 'Pré-visualizações de mensagens prontas',
        subtitle: 'Incluir o texto da mensagem mais recente do assistente nas notificações push de turnos prontos',
      },
      permissionRequests: {
        title: "Solicitações de permissão",
        subtitle:
          "Notificar quando uma sessão está bloqueada aguardando uma aprovação",
      },
      userActions: {
        title: "Solicitações de ação",
        subtitle:
          "Notificar quando uma sessão precisa de uma resposta ou confirmação",
      },
    },
  },

    notifications: {
      actions: {
        allow: 'Permitir',
        deny: 'Negar',
        answer: 'Responder',
      },
      activity: {
        defaultSessionTitle: 'Sessão',
        readyFallbackBody: 'O turno terminou. Abra a sessão para continuar.',
        permissionFallbackBody: 'Aprovação necessária.',
        userActionFallbackBody: 'Esta sessão precisa da sua resposta.',
      },
      channels: {
        default: 'Padrão',
        permissionRequests: 'Solicitações de permissão',
        userActionRequests: 'Solicitações de ação',
      },
    },

  settingsProviders: {
        title: "Configurações do provedor de IA",
        entrySubtitle: "Configure opções específicas do provedor",
        footer:
        "Configure opções específicas do provedor. Essas configurações podem afetar o comportamento da sessão.",
      configuration: 'Configuração',
      cliConnection: 'Conexão CLI',
      capabilities: 'Capacidades',
      models: 'Modelos',
      providerSubtitle: "Configurações específicas do provedor",
      stateEnabled: "Ativado",
      stateDisabled: "Desativado",
      channelStable: "Estável",
      channelExperimental: "Em testes",
      supported: "Suportado",
      notSupported: "Não suportado",
      allowed: "Permitido",
      notAllowed: "Não permitido",
      notAvailable: "Não disponível",
      enabledTitle: "Ativado",
      enabledSubtitle: "Use este backend em seletores, perfis e sessões",
      releaseChannelTitle: "Canal de lançamento",
      capabilitiesTitle: "Capacidades",
      resumeSupportTitle: "Suporte a retomada",
      sessionModeSupportTitle: "Suporte a modo de sessão",
      runtimeModeSwitchingTitle: "Troca de modo em tempo de execução",
      localControlTitle: "Controle local",
      resumeSupportSupported: "Suportado",
      resumeSupportSupportedExperimental: "Suportado (em testes)",
      resumeSupportNotSupported: "Não suportado",
      sessionModeNone: "Sem modos ACP",
      sessionModeAcpPolicyPresets: "Predefinições de políticas ACP",
      sessionModeAcpAgentModes: "Modos de agente ACP",
      sessionModeDynamicPolicyModes: "Modos dinâmicos de política",
      sessionModeDynamicAgentModes: "Modos dinâmicos de agente",
      sessionModeStaticAgentModes: "Modos de agente estáticos",
      runtimeSwitchNone: "Sem troca em tempo de execução",
      runtimeSwitchMetadataGating: "Limitado por metadados",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchSessionModeApi: "API de modo de sessão",
      runtimeSwitchProviderNative: "Nativo do provedor",
      modelsTitle: "Modelos",
      modelSelectionTitle: "Seleção de modelo",
      freeformModelIdsTitle: "IDs de modelo livres",
      defaultModelTitle: "Modelo padrão",
      catalogModelListTitle: "Lista de modelos do catálogo",
      catalogModelListEmpty: "Nenhum modelo de catálogo disponível",
      dynamicModelProbeTitle: "Sondagem dinâmica de modelos",
      dynamicModelProbeAuto: "Automático",
      dynamicModelProbeStaticOnly: "Somente estático",
      nonAcpApplyScopeTitle: "Escopo de aplicação do modelo (sem ACP)",
      nonAcpApplyScopeSpawnOnly: "Aplicar ao iniciar a sessão",
      nonAcpApplyScopeNextPrompt: "Aplicar na próxima mensagem",
      acpApplyBehaviorTitle: "Comportamento de aplicação do modelo (ACP)",
      acpApplyBehaviorSetModel: "Definir modelo ao vivo",
      acpApplyBehaviorRestartSession: "Reiniciar sessão",
      acpConfigOptionTitle: "ID de opção de config do modelo ACP",
      cliConnectionTitle: "CLI e conexão",
      targetMachineTitle: "Máquina de destino",
      detectedCliTitle: "CLI detectado",
      installSetupTitle: "Instalação / configuração",
      installInfoSeeSetupGuide: "Ver guia de configuração",
      installInfoUseProviderCliInstaller: "Use o instalador CLI do provedor",
      cliSourcePreference: {
        title: "Preferência da origem da CLI",
        subtitle:
          "Escolha se o Happier deve preferir a CLI do sistema ou a instalação gerenciada quando ambas existirem.",
        options: {
          systemFirst: {
            title: "Preferir instalação do sistema",
            subtitle: "Preferir a CLI já instalada nesta máquina.",
          },
          managedFirst: {
            title: "Preferir instalação gerenciada",
            subtitle: "Preferir a CLI instalada pelo Happier para este provedor.",
          },
        },
      },
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) =>
          `Instalar ${provider} CLI`,
        reinstallTitle: ({ provider }: { provider: string }) =>
          `Reinstalar ${provider} CLI`,
        autoInstallUnavailable:
          "A instalação automática não está disponível para esta máquina.",
        installSubtitle:
          "Instala o CLI do provedor na máquina selecionada (best-effort).",
        reinstallSubtitle:
          "Executa novamente o instalador do provedor mesmo se o CLI já estiver presente.",
        confirmInstallTitle: ({ provider }: { provider: string }) => `Instalar ${provider} CLI?`,
        confirmReinstallTitle: ({ provider }: { provider: string }) => `Reinstalar ${provider} CLI?`,
        confirmBody: ({ provider }: { provider: string }) =>
          `Isto executará os comandos do instalador de ${provider} na máquina selecionada. Continue apenas se confiar no provedor.`,
        confirmInstallConfirm: "Instalar",
        confirmReinstallConfirm: "Reinstalar",
        noMachineSelected: "Nenhuma máquina selecionada.",
        installNotSupported: "Instalação não suportada nesta máquina.",
        installFailed: "Falha na instalação.",
        installed: "Instalado.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL do guia de configuração",
      authentication: {
        title: "Autenticação",
        footer: "Revise o estado de autenticação local da CLI e inicie sessão quando houver suporte.",
        terminalTitle: "Terminal de login do provedor",
        logInTitle: "Iniciar sessão",
        logInSubtitle: "Abra um terminal e execute o fluxo de login do provedor nesta máquina.",
        reauthenticateTitle: "Reautenticar",
        reauthenticateSubtitle: "Abra um terminal e renove o login do provedor nesta máquina.",
        checkNowTitle: "Verificar agora",
        checkNowSubtitle: "Atualize o estado de autenticação local detectado.",
        statusTitle: "Estado",
        loggedInAsTitle: "Sessão iniciada como",
        methodTitle: "Método de autenticação",
        sourceTitle: "Origem das credenciais",
        reasonTitle: "Problema",
        lastCheckedTitle: "Última verificação",
        stateUnknown: "Desconhecido",
        stateLoggedIn: "Sessão iniciada",
        stateLoggedOut: "Sessão encerrada",
        methods: {
          apiKeyEnv: "Variável de ambiente da chave de API",
          authTokenEnv: "Variável de ambiente do token de autenticação",
          credentialsFile: "Arquivo de credenciais",
          oauthCli: "Login OAuth da CLI",
          configFile: "Arquivo de configuração",
          gcloudAdc: "Credenciais padrão do aplicativo Google Cloud",
          unknown: "Desconhecido",
        },
        reasons: {
          missingCredentials: "Credenciais ausentes",
          expired: "Credenciais expiradas",
          cliMissing: "CLI não instalado",
          probeFailed: "Falha na verificação de estado",
          timeout: "A verificação de estado excedeu o tempo limite",
          unsupported: "A autenticação local não é suportada",
          interactiveBlocked: "O login interativo está bloqueado",
          notConfigured: "Não configurado",
        },
        sources: {
          environment: "Ambiente",
          file: "Arquivo",
          command: "Comando",
          mixed: "Misto",
        },
      },
      connectedServiceTitle: "Serviço conectado",
      notFoundTitle: "Provedor não encontrado",
      notFoundSubtitle: "Este provedor não tem tela de configurações.",
      noOptionsAvailable: "Sem opções disponíveis",
      invalidNumber: "Número inválido",
    invalidJson: "JSON inválido",
      plugins: {
            claude: {
                title: "Claude (remoto)",
                sections: {
                    claudeCodeExperiments: {
                        title: "Experimentos do Claude Code",
                        footer: "Estas configuracoes se aplicam tanto as sessoes locais do Claude (terminal) quanto as remotas (Agent SDK) iniciadas pelo Happier."
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK (modo remoto)",
                        footer: "O modo remoto executa o Claude na sua maquina, mas controlado pela interface do Happier. O modo local e a TUI do Claude Code no terminal. Estas configuracoes afetam apenas o modo remoto."
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Forcar ativacao do Agent Teams",
                        subtitle: "Ativa o Agent Teams experimental do Claude Code (enxame de agentes) em todas as sessoes do Claude iniciadas pelo Happier."
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Usar Agent SDK (remoto)",
                        subtitle: "Usa o @anthropic-ai/claude-agent-sdk oficial no modo remoto."
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "Fontes de configuracao",
                        subtitle: "Controla quais configuracoes do Claude sao carregadas.",
                        options: {
                            user: {
                                title: "Usuario",
                                subtitle: "Carrega a configuracao global de usuario do Claude."
                            },
                            project: {
                                title: "Projeto",
                                subtitle: "Carrega as configuracoes do repositorio (incluindo CLAUDE.md)."
                            },
                            local: {
                                title: "Local",
                                subtitle: "Carrega substituicoes apenas locais."
                            }
                        }
                    },
                    claudeRemoteIncludePartialMessages: {
                        title: "Atualizacoes parciais de streaming",
                        subtitle: "Mostra a saida parcial do assistente enquanto o Claude ainda esta respondendo."
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "Experimental: ponte local de permissoes",
                        subtitle: "Encaminha pedidos de permissao do modo local do Claude para o Happier, para que voce possa aprovar ou negar pela interface."
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "Manter pedidos abertos ate responder",
                        subtitle: "Quando ativado, o Happier mantem os pedidos de permissao local do Claude pendentes ate voce aprovar ou negar pela interface."
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "Tempo limite opcional de permissao (segundos)",
                        subtitle: "Usado apenas quando a espera indefinida estiver desligada. Depois desse tempo, o Happier volta ao prompt de terminal do Claude."
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "Checkpoints de arquivo + /rewind",
                        subtitle: "Ativa checkpoints de arquivo e /rewind (somente arquivos; nao rebobina a conversa). Use /checkpoints para listar e /rewind --confirm para aplicar (mais sobrecarga)."
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "Maximo de tokens de raciocinio",
                        subtitle: "Limita o orcamento interno de raciocinio do Claude (null = padrao)."
                    },
                    claudeRemoteDisableTodos: {
                        title: "Desativar TODOs",
                        subtitle: "Impede que o Claude crie itens TODO no modo remoto."
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "Configuracao estrita de servidor MCP",
                        subtitle: "Falha se qualquer configuracao de servidor MCP for invalida."
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "Opcoes avancadas (JSON)",
                        subtitle: "Substituicoes avancadas do Agent SDK para usuarios experientes (validadas no cliente)."
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "Modo de backend",
                        footer: "O modo servidor libera perguntas e fork nativo. O modo ACP e um fallback legado."
                    },
                    server: {
                        title: "Conexao do servidor",
                        footer: "Deixe vazio para usar o ciclo de vida do servidor OpenCode gerenciado pelo Happier. Defina uma URL http(s) absoluta para se conectar a um servidor OpenCode existente."
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "Modo de backend do OpenCode",
                        subtitle: "Escolha o backend de integracao.",
                        options: {
                            server: {
                                title: "Servidor (recomendado)",
                                subtitle: "Usa as APIs de servidor do OpenCode para mais recursos e confiabilidade."
                            },
                            acp: {
                                title: "ACP (legado)",
                                subtitle: "Roteia o OpenCode via ACP; com menos recursos."
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "URL de servidor OpenCode existente",
                        subtitle: "Substituicao opcional para um servidor OpenCode gerenciado pelo usuario."
                    }
                }
            },
            auggie: {
                title: "Auggie"
            },
            copilot: {
                title: "Copilot"
            },
            customAcp: {
                title: "ACP personalizado"
            },
            gemini: {
                title: "Gemini"
            },
            kilo: {
                title: "Kilo"
            },
            kimi: {
                title: "Kimi"
            },
            kiro: {
                title: "Kiro"
            },
            pi: {
                title: "Pi"
            },
            qwen: {
                title: "Qwen Code"
            },
            codex: {
          title: "Codex",
          sections: {
            backendMode: {
              title: "Modo de roteamento",
              footer:
                "Escolha como o Codex é roteado. App Server é o padrão recomendado. Alternância local/remota e retomada funcionam com App Server; ACP continua disponível como fallback legado.",
            },
            installOverrides: {
              title: "Substituições de origem de instalação",
              footer:
                "Opcional. Deixe vazio para usar as origens de instalação padrão.",
            },
          },
          fields: {
            codexBackendMode: {
              title: "Modo de roteamento do Codex",
              subtitle: "Selecione App Server, ACP ou MCP.",
              options: {
                appServer: {
                  title: "Servidor do app",
                  subtitle: "Modo oficial recomendado do Codex app-server",
                },
                acp: {
                  title: "ACP",
                  subtitle: "Roteie o Codex via ACP (codex-acp)",
                },
                mcp: {
                  title: "MCP",
                  subtitle: "Modo MCP padrão do Codex",
                },
              },
            },
          },
        },
      },
  },

  settingsAppearance: {
    ...settingsAppearanceTranslationExtension,
    // Appearance settings screen
    theme: "Tema",
    themeDescription: "Escolha seu esquema de cores preferido",
    themeOptions: {
      adaptive: "Adaptativo",
      light: "Claro",
      dark: "Escuro",
    },
    themeDescriptions: {
      adaptive: "Usar configurações do sistema",
      light: "Sempre usar tema claro",
      dark: "Sempre usar tema escuro",
    },
    display: "Exibição",
    displayDescription: "Controle layout e espaçamento",
    multiPanePanels: "Painéis à direita",
    multiPanePanelsDescription:
      "Mostre painéis laterais redimensionáveis para arquivos e controle de código fonte (web/tablet)",
    sessionsRightPaneDefaultOpen: "Mostrar sempre a barra lateral direita nas sessões",
    sessionsRightPaneDefaultOpenDescription:
      "Abrir automaticamente a barra lateral direita ao entrar numa sessão (web/tablet)",
    detailsPaneTabsBehavior: "Abas do editor",
    detailsPaneTabsBehaviorDescription:
      "Escolha como as abas de arquivo se comportam no painel do editor",
    detailsPaneTabsBehaviorOptions: {
      preview: "Aba de pré-visualização",
      persistent: "Abas persistentes",
    },
    editorFocusMode: "Modo foco do editor",
    editorFocusModeDescription:
      "Oculta a conversa e a barra lateral enquanto você revisa arquivos (web/tablet)",
    inlineToolCalls: "Chamadas de ferramentas inline",
    inlineToolCallsDescription:
      "Exibir chamadas de ferramentas diretamente nas mensagens do chat",
    expandTodoLists: "Expandir listas de tarefas",
    expandTodoListsDescription:
      "Mostrar todas as tarefas em vez de apenas as mudanças",
    showLineNumbersInDiffs: "Mostrar números de linha nos diffs",
    showLineNumbersInDiffsDescription:
      "Exibir números de linha nos diffs de código",
    showLineNumbersInToolViews:
      "Mostrar números de linha nas visualizações de ferramentas",
    showLineNumbersInToolViewsDescription:
      "Exibir números de linha nos diffs das visualizações de ferramentas",
    wrapLinesInDiffs: "Quebrar linhas nos diffs",
    wrapLinesInDiffsDescription:
      "Quebrar linhas longas ao invés de rolagem horizontal nas visualizações de diffs",
    alwaysShowContextSize: "Sempre mostrar tamanho do contexto",
    alwaysShowContextSizeDescription:
      "Exibir uso do contexto mesmo quando não estiver próximo do limite",
    agentInputActionBarLayout: "Barra de ações do input",
    agentInputActionBarLayoutDescription:
      "Escolha como os chips de ação são exibidos acima do campo de entrada",
    agentInputActionBarLayoutOptions: {
      auto: "Automático",
      wrap: "Quebrar linha",
      scroll: "Rolável",
      collapsed: "Recolhido",
    },
    agentInputChipDensity: "Densidade dos chips de ação",
    agentInputChipDensityDescription:
      "Escolha se os chips de ação exibem rótulos ou ícones",
    agentInputChipDensityOptions: {
      auto: "Automático",
      labels: "Rótulos",
      icons: "Somente ícones",
    },
    avatarStyle: "Estilo do avatar",
    avatarStyleDescription: "Escolha a aparência do avatar da sessão",
    avatarOptions: {
      pixelated: "Pixelizado",
      gradient: "Gradiente",
      brutalist: "Brutalista",
    },
    showFlavorIcons: "Mostrar ícones de provedores de IA",
    showFlavorIconsDescription:
      "Exibir ícones do provedor de IA nos avatares de sessão",
    compactSessionView: "Visualização compacta de sessões",
    compactSessionViewDescription:
      "Mostrar sessões ativas em um layout mais compacto",
    compactSessionViewMinimal: "Visualização compacta mínima",
    compactSessionViewMinimalDescription:
      "Remover avatares e mostrar um layout de linha de sessão muito compacto",
    text: "Texto",
    textDescription: "Ajuste o tamanho do texto no app",
    textSize: "Tamanho do texto",
    textSizeDescription: "Deixe o texto maior ou menor",
    textSizeOptions: {
      xxsmall: "Muito muito pequeno",
      xsmall: "Muito pequeno",
      small: "Pequeno",
      default: "Padrão",
      large: "Grande",
      xlarge: "Muito grande",
      xxlarge: "Muito muito grande",
    },
    itemDensity: "Densidade dos itens",
    itemDensityDescription: "Escolha o tamanho das linhas de listas e configurações em todo o app",
    itemDensityOptions: {
      comfortable: "Padrão",
      comfortableDescription: "Usa o tamanho e espaçamento padrão das linhas",
      cozy: "Intermediário",
      cozyDescription: "Usa linhas um pouco mais compactas sem chegar ao layout compacto",
      compact: "Compacto",
      compactDescription: "Mostra mais linhas na tela com espaçamento reduzido",
    },
  },

  settingsFeatures: {
    // Features settings screen
    experiments: "Experimentos",
    experimentsDescription:
      "Ative recursos experimentais que ainda estão em desenvolvimento. Estes recursos podem ser instáveis ou mudar sem aviso.",
    experimentalFeatures: "Recursos experimentais",
    experimentalFeaturesEnabled: "Recursos experimentais ativados",
    experimentalFeaturesDisabled: "Usando apenas recursos estáveis",
    experimentalOptions: "Opções experimentais",
    experimentalOptionsDescription:
      "Escolha quais recursos experimentais estão ativados.",
    localTogglesTitle: "Recursos",
    localTogglesFooter:
      "Alternâncias locais por recurso (independentes do suporte do servidor).",
    featureDiagnostics: {
      title: "Diagnóstico de recursos",
      footer:
        "Decisões resolvidas de recursos (política de build, política local, sondas do daemon/servidor e escopo).",
      decisionUnknown: "desconhecido",
      decisionEnabled: "ativado",
      decisionBlocked: ({
        state,
        blockedBy,
        code,
      }: {
        state: string;
        blockedBy: string | null;
        code: string;
      }) => `${state} (blockedBy=${blockedBy ?? "null"}, code=${code})`,
    },
      expAutomations: "Automações",
      expAutomationsSubtitle: "Ativar interface e agendamento de automações",
      expExecutionRuns: "Execuções",
      expExecutionRunsSubtitle:
        "Ativar superfícies de controle para execuções (subagentes / revisões)",
      expAttachmentsUploads: "Upload de anexos",
      expAttachmentsUploadsSubtitle:
        "Ativar upload de arquivos/imagens para que o agente possa lê-los do disco",
      expUsageReporting: "Relatórios de uso",
      expUsageReportingSubtitle: "Ativar telas de uso e relatórios de tokens",
    expScmOperations: "Operações de controle de versão",
    expScmOperationsSubtitle:
      "Habilitar operações de escrita experimentais de controle de versão (stage/commit/push/pull)",
      expFilesReviewComments: "Comentários de revisão de arquivos",
      expFilesReviewCommentsSubtitle:
        "Adicionar comentários de revisão por linha a partir das visualizações de arquivo e diff e enviá-los como mensagem estruturada",
      expFilesDiffSyntaxHighlighting: "Realce de sintaxe em diffs",
      expFilesDiffSyntaxHighlightingSubtitle:
        "Ativar realce de sintaxe nas visualizações de diff e código (com limites de desempenho)",
      expFilesAdvancedSyntaxHighlighting: "Realce de sintaxe avançado",
      expFilesAdvancedSyntaxHighlightingSubtitle:
        "Usar realce mais pesado e de maior fidelidade (somente web, pode ser mais lento)",
      expFilesEditor: "Editor de arquivos embutido",
      expFilesEditorSubtitle:
        "Ativar edição de arquivos diretamente no navegador de arquivos (Monaco na web/desktop, CodeMirror no nativo)",
      expEmbeddedTerminal: "Terminal embutido",
      expEmbeddedTerminalSubtitle:
        "Abra um terminal real dentro das sessões.",
      expSessionType: "Seletor de tipo de sessão",
      expSessionTypeSubtitle:
        "Mostrar o seletor de tipo de sessão (simples vs worktree)",
      expZen: "Modo Zen",
      expZenSubtitle: "Ativar a entrada de navegação Zen",
      expVoiceAuthFlow: "Fluxo de autenticação por voz",
      expVoiceAuthFlowSubtitle:
        "Usar fluxo de token de voz autenticado (com paywall)",
    voice: "Voz",
    voiceSubtitle: "Ativar recursos de voz",
      expVoiceAgent: "Agente de voz",
      expVoiceAgentSubtitle:
        "Ativar superfícies de agente de voz com daemon (requer execuções)",
      expConnectedServices: "Serviços conectados",
      expConnectedServicesSubtitle:
        "Ativar configurações de serviços conectados e vinculações de sessão",
      expConnectedServicesQuotas: "Cotas de serviços conectados",
      expConnectedServicesQuotasSubtitle:
        "Mostrar badges de cota e medidores de uso para serviços conectados",
      expMemorySearch: "Busca de memória",
      expMemorySearchSubtitle:
        "Ativar telas e configurações de busca de memória local",
    expSessionsDirect: "Sessões diretas",
    expSessionsDirectSubtitle: "Liste e abra na barra lateral sessões diretas apoiadas pelo provedor",
    expFriends: "Amigos",
    expFriendsSubtitle: "Ative os recursos de amigos (aba Caixa de entrada e compartilhamento de sessões)",
    webFeatures: "Recursos web",
    webFeaturesDescription:
      "Recursos disponíveis apenas na versão web do aplicativo.",
    enterToSend: "Enter para enviar",
    enterToSendEnabled:
      "Pressione Enter para enviar (Shift+Enter para nova linha)",
    enterToSendDisabled: "Enter insere uma nova linha",
      historyScope: "Histórico de mensagens",
      historyScopePerSession: "Percorrer histórico por terminal",
      historyScopeGlobal: "Percorrer histórico em todos os terminais",
      historyScopeModalTitle: "Histórico de mensagens",
      historyScopeModalMessage:
        "Escolha se Seta para cima/Seta para baixo percorre apenas as mensagens enviadas neste terminal ou em todos os terminais.",
      historyScopePerSessionOption: "Por terminal",
      historyScopeGlobalOption: "Global (todos)",
      commandPalette: "Paleta de comandos",
      commandPaletteEnabled: "Pressione ⌘K para abrir",
      commandPaletteDisabled: "Acesso rápido a comandos desativado",
      hideInactiveSessions: "Ocultar sessões inativas",
      hideInactiveSessionsSubtitle: "Mostre apenas os chats ativos na sua lista",
    sessionListActiveGrouping: "Agrupamento de sessões ativas",
    sessionListActiveGroupingSubtitle:
      "Escolha como as sessões ativas são agrupadas na barra lateral",
    sessionListInactiveGrouping: "Agrupamento de sessões inativas",
    sessionListInactiveGroupingSubtitle:
      "Escolha como as sessões inativas são agrupadas na barra lateral",
    sessionListGrouping: {
      projectTitle: "Projeto",
      projectSubtitle: "Agrupar sessões por máquina + caminho",
      dateTitle: "Data",
      dateSubtitle: "Agrupar sessões pela data da última atividade",
    },
    groupInactiveSessionsByProject: "Agrupar sessões inativas por projeto",
    groupInactiveSessionsByProjectSubtitle:
      "Organize os chats inativos por projeto",
      environmentBadge: "Badge de ambiente",
      environmentBadgeSubtitle:
        "Mostrar um pequeno badge ao lado do título Happier indicando o ambiente atual do app",
    enhancedSessionWizard: "Assistente de sessão aprimorado",
    enhancedSessionWizardEnabled: "Lançador de sessão com perfil ativo",
    enhancedSessionWizardDisabled: "Usando o lançador de sessão padrão",
    profiles: "Perfis de IA",
    profilesEnabled: "Seleção de perfis ativada",
    profilesDisabled: "Seleção de perfis desativada",
    pickerSearch: "Busca nos seletores",
    pickerSearchSubtitle:
      "Mostrar um campo de busca nos seletores de máquina e caminho",
    machinePickerSearch: "Busca de máquinas",
    machinePickerSearchSubtitle:
      "Mostrar um campo de busca nos seletores de máquinas",
    pathPickerSearch: "Busca de caminhos",
    pathPickerSearchSubtitle:
      "Mostrar um campo de busca nos seletores de caminhos",
  },

  errors: {
    networkError: "Ocorreu um erro de rede",
    serverError: "Ocorreu um erro do servidor",
    unknownError: "Ocorreu um erro desconhecido",
    connectionTimeout: "Tempo limite da conexão esgotado",
    authenticationFailed: "Falha na autenticação",
    permissionDenied: "Permissão negada",
      fileNotFound: "Arquivo não encontrado",
      invalidFormat: "Formato inválido",
      operationFailed: "Operação falhou",
      failedToForkSession: "Falha ao derivar sessão",
      daemonUnavailableTitle: "Daemon indisponível",
      daemonUnavailableBody:
        "O Happier não consegue acessar o daemon nesta máquina. Ele pode estar offline, iniciando ou desconectado do servidor.",
      tryAgain: "Por favor, tente novamente",
      contactSupport: "Entre em contato com o suporte se o problema persistir",
      sessionNotFound: "Sessão não encontrada",
      voiceSessionFailed: "Falha ao iniciar sessão de voz",
      voiceServiceUnavailable: "Serviço de voz temporariamente indisponível",
      voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
      `Limite da sessão de voz: cerca de ${duration}.`,
      voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
      `A sessão de voz terminará em cerca de ${duration}.`,
      voiceSessionLimitExpired:
      "A sessão de voz atingiu o limite de tempo atual e terminou.",
    voiceAlreadyStarting: "A voz já está iniciando em outra sessão",
    oauthInitializationFailed: "Falha ao inicializar o fluxo OAuth",
    tokenStorageFailed: "Falha ao armazenar tokens de autenticação",
    oauthStateMismatch:
      "Falha na validação de segurança. Por favor, tente novamente",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} já está vinculado a uma conta Happier existente. Para entrar neste dispositivo, vincule-o a partir de um dispositivo onde já esteja conectado.`,
    tokenExchangeFailed: "Falha ao trocar código de autorização",
    oauthAuthorizationDenied: "A autorização foi negada",
    webViewLoadFailed: "Falha ao carregar a página de autenticação",
    failedToLoadProfile: "Falha ao carregar o perfil do usuário",
    userNotFound: "Usuário não encontrado",
    sessionDeleted: "A sessão não está disponível",
    sessionDeletedDescription:
      "Ela pode ter sido excluída ou você pode não ter mais acesso.",

    // Error functions with context
    fieldError: ({ field, reason }: { field: string; reason: string }) =>
      `${field}: ${reason}`,
    validationError: ({
      field,
      min,
      max,
    }: {
      field: string;
      min: number;
      max: number;
    }) => `${field} deve estar entre ${min} e ${max}`,
    retryIn: ({ seconds }: { seconds: number }) =>
      `Tentar novamente em ${seconds} ${seconds === 1 ? "segundo" : "segundos"}`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (Erro ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `Falha ao desconectar ${service}`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `Falha ao conectar ${service}. Por favor, tente novamente.`,
    failedToLoadFriends: "Falha ao carregar lista de amigos",
    failedToAcceptRequest: "Falha ao aceitar solicitação de amizade",
    failedToRejectRequest: "Falha ao rejeitar solicitação de amizade",
    failedToRemoveFriend: "Falha ao remover amigo",
    searchFailed: "A busca falhou. Por favor, tente novamente.",
    failedToSendRequest: "Falha ao enviar solicitação de amizade",
    failedToResumeSession: "Falha ao retomar a sessão",
    failedToSendMessage: "Falha ao enviar a mensagem",
    failedToSwitchControl: "Falha ao alternar o modo de controle",
    cannotShareWithSelf: "Não é possível compartilhar consigo mesmo",
    canOnlyShareWithFriends: "Só é possível compartilhar com amigos",
    shareNotFound: "Compartilhamento não encontrado",
    publicShareNotFound: "Link público não encontrado ou expirado",
    consentRequired: "Consentimento necessário para acesso",
    maxUsesReached: "Máximo de usos atingido",
    invalidShareLink: "Link de compartilhamento inválido ou expirado",
    missingPermissionId: "Falta o id de permissão",
    codexResumeNotInstalledTitle:
      "O servidor de retomada do Codex não está instalado nesta máquina",
    codexResumeNotInstalledMessage:
      "Para retomar uma conversa do Codex, instale o servidor de retomada do Codex na máquina de destino (Detalhes da máquina → Installables).",
    codexAcpNotInstalledTitle: "O Codex ACP não está instalado nesta máquina",
    codexAcpNotInstalledMessage:
      "Para usar o experimento Codex ACP, instale o codex-acp na máquina de destino (Detalhes da máquina → Installables) ou desative o experimento.",
  },

  deps: {
    installNotSupported:
      "Atualize o Happier CLI para instalar esta dependência.",
    installFailed: "Falha na instalação",
    installed: "Instalado",
    installLog: ({ path }: { path: string }) => `Log de instalação: ${path}`,
    installable: {
      codexResume: {
        title: "Servidor de retomada do Codex",
      },
      codexAcp: {
        title: "Adaptador Codex ACP",
      },
    },
    ui: {
      notAvailable: "Indisponível",
      notAvailableUpdateCli: "Indisponível (atualize o CLI)",
      errorRefresh: "Erro (atualizar)",
      installed: "Instalado",
      installedWithVersion: ({ version }: { version: string }) =>
        `Instalado (v${version})`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) =>
        `Instalado (v${installedVersion}) — atualização disponível (v${latestVersion})`,
      notInstalled: "Não instalado",
      latest: "Última",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version} (tag: ${tag})`,
      registryCheck: "Verificação do registro",
      registryCheckFailed: ({ error }: { error: string }) => `Falhou: ${error}`,
      installSource: "Fonte de instalação",
      installSourceDefault: "(padrão)",
      lastInstallLog: "Último log de instalação",
      installLogTitle: "Log de instalação",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
    // Used by new-session screen and launch flows
    title: "Iniciar nova sessão",
    selectAiProfileTitle: "Selecionar perfil de IA",
    selectAiProfileDescription:
      "Selecione um perfil de IA para aplicar variáveis de ambiente e padrões à sua sessão.",
    changeProfile: "Trocar perfil",
    aiBackendSelectedByProfile:
      "O backend de IA é selecionado pelo seu perfil. Para alterar, selecione um perfil diferente.",
    selectAiBackendTitle: "Selecionar backend de IA",
    aiBackendLimitedByProfileAndMachineClis:
      "Limitado pelo perfil selecionado e pelos CLIs disponíveis nesta máquina.",
    aiBackendSelectWhichAiRuns: "Selecione qual IA roda sua sessão.",
    aiBackendNotCompatibleWithSelectedProfile:
      "Não compatível com o perfil selecionado.",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `CLI do ${cli} não detectado nesta máquina.`,
    selectMachineTitle: "Selecionar máquina",
    selectMachineDescription: "Escolha onde esta sessão será executada.",
    selectPathTitle: "Selecionar caminho",
    selectWorkingDirectoryTitle: "Selecionar diretório de trabalho",
    selectWorkingDirectoryDescription:
      "Escolha a pasta usada para comandos e contexto.",
    selectPermissionModeTitle: "Selecionar modo de permissões",
    selectPermissionModeDescription:
      "Controle o quão estritamente as ações exigem aprovação.",
    selectModelTitle: "Selecionar modelo de IA",
    selectModelDescription: "Escolha o modelo usado por esta sessão.",
    checkout: {
      selectTitle: "Selecionar checkout",
      noWorktree: "Pasta atual",
      noWorktreeSubtitle:
        "Use a pasta já selecionada sem vincular um checkout de workspace.",
      noWorktreeSectionTitle: "Pasta atual",
      existingWorktreesSectionTitle: "Checkouts vinculados",
      actionsSectionTitle: "Ações",
      newWorktree: "Novo worktree",
      newWorktreeSubtitle: "Crie e use um novo worktree Git para esta sessão.",
      existingWorktree: "Worktree existente",
      existingWorktreeSubtitle: "Escolha um worktree Git existente para esta sessão.",
      existingWorktreeEmptyTitle: "Nenhum worktree existente",
      existingWorktreeEmptySubtitle: "Crie um worktree Git primeiro ou escolha Novo worktree.",
      newWorktreeDetailWorkspace:
        "Crie um novo checkout vinculado dentro deste workspace.",
      newWorktreeDetailBranch:
        "Comece do estado atual do repositório e escolha um novo nome de branch/worktree.",
      branchPickerTitle: "Começar de",
      branchPickerCurrentHead: "Branch atual",
      branchPickerCurrentHeadDescription: "Comece da branch atualmente em checkout neste repositório.",
      branchPickerEmpty: "Nenhuma branch disponível para este repositório.",
      branchPickerSearchPlaceholder: "Pesquisar branches…",
      branchPickerRefreshA11y: "Atualizar branches",
      branchPickerLoadingA11y: "Carregando branches",
      branchPickerRefreshingA11y: "Atualizando branches",
      primaryDetailDescription:
        "Use o checkout principal vinculado deste workspace na máquina selecionada.",
      gitWorktreeDetailDescription:
        "Use um checkout Git worktree já vinculado para esta sessão.",
      existingBranchWorktreeDescription:
        "Esta branch já possui um worktree. Você pode reutilizá-lo diretamente ou criar uma nova branch a partir dela.",
      existingBranchDescription:
        "Esta branch pode ser usada diretamente em um novo worktree, ou você pode criar uma nova branch a partir dela.",
      createNewBranchFromBranchHint:
        "Use Aplicar para criar uma nova branch e um worktree a partir desta branch.",
      useExistingBranchAction: "Usar branch existente",
      useExistingWorktreeAction: "Usar worktree existente",
      detailBranch: ({ branch }: { branch: string }) => `Branch: ${branch}`,
      detailPath: ({ path }: { path: string }) => `Caminho: ${path}`,
      detailLinkedWorkspace: "Vinculado ao espaco de trabalho atual.",
    },
    selectSessionTypeTitle: "Selecionar tipo de sessão",
    selectSessionTypeDescription:
      "Escolha uma sessão simples ou uma vinculada a um worktree do Git.",
    searchPathsPlaceholder: "Pesquisar caminhos...",
    noMachinesFound:
      "Nenhuma máquina encontrada. Inicie uma sessão Happier no seu computador primeiro.",
    allMachinesOffline: "Todas as máquinas estão offline",
    machineOfflineInlineTitle: "A máquina está offline",
    machineOfflineInlineBody:
      "Inicie o daemon nesta máquina ou escolha outra antes de criar uma sessão.",
    machineOfflineCannotStartStatus: "offline (não é possível iniciar a sessão)",
    automationChip: {
      default: "Automatizar",
      interval: ({ minutes }: { minutes: number }) => `A cada ${minutes} min`,
      cron: "Agendamento cron",
    },
    machineDetails: "Ver detalhes da máquina →",
    directoryDoesNotExist: "Diretório não encontrado",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `O diretório ${directory} não existe. Deseja criá-lo?`,
    sessionStarted: "Sessão iniciada",
    sessionStartedMessage: "A sessão foi iniciada com sucesso.",
    sessionSpawningFailed:
      "Falha ao criar sessão - nenhum ID de sessão foi retornado.",
    failedToStart:
      "Falha ao iniciar sessão. Certifique-se de que o daemon está rodando na máquina de destino.",
    sessionTimeout:
      "Tempo limite de inicialização da sessão esgotado. A máquina pode estar lenta ou o daemon pode não estar respondendo.",
    notConnectedToServer:
      "Não conectado ao servidor. Verifique sua conexão com a internet.",
    daemonRpcUnavailableTitle: "Daemon indisponível",
    daemonRpcUnavailableBody:
      "O Happier não consegue acessar o daemon nesta máquina. Ele pode estar offline, iniciando ou desconectado do servidor.",
    startingSession: "Iniciando sessão...",
    startNewSessionInFolder: "Nova sessão aqui",
    noMachineSelected: "Por favor, selecione uma máquina para iniciar a sessão",
    noPathSelected: "Por favor, selecione um diretório para iniciar a sessão",
    machinePicker: {
      searchPlaceholder: "Pesquisar máquinas...",
      recentTitle: "Recentes",
      favoritesTitle: "Favoritos",
      allTitle: "Todas",
      emptyMessage: "Nenhuma máquina disponível",
    },
    pathPicker: {
      enterPathTitle: "Inserir caminho",
      enterPathPlaceholder: "Insira um caminho...",
      customPathTitle: "Caminho personalizado",
      truncatedDirectoryInfo: ({ count }: { count: number }) => `Mostrando os primeiros ${count} itens`,
      recentTitle: "Recentes",
      favoritesTitle: "Favoritos",
      suggestedTitle: "Sugeridos",
      allTitle: "Todas",
      emptyRecent: "Nenhum caminho recente",
      emptyFavorites: "Nenhum caminho favorito",
      emptySuggested: "Nenhum caminho sugerido",
      emptyAll: "Nenhum caminho",
    },
    sessionType: {
      title: "Tipo de sessão",
      simple: "Simples",
      worktree: "Árvore de trabalho",
      comingSoon: "Em breve",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Requer ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) =>
        `CLI do ${cli} não detectado`,
    },
    profileSelection: {
      workspaceDefault: "Padrão do workspace",
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `CLI do ${cli} não detectado`,
      dontShowFor: "Não mostrar este aviso para",
      thisMachine: "esta máquina",
      anyMachine: "qualquer máquina",
      installCommand: ({ command }: { command: string }) =>
        `Instalar: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `Instale o CLI do ${cli} se disponível •`,
      viewInstallationGuide: "Ver guia de instalação →",
      viewGeminiDocs: "Ver docs do Gemini →",
    },
    worktree: {
      creating: ({ name }: { name: string }) => `Criando worktree '${name}'...`,
      notGitRepo: "Worktrees requerem um repositório git",
      failed: ({ error }: { error: string }) =>
        `Falha ao criar worktree: ${error}`,
      success: "Worktree criado com sucesso",
    },
    resume: {
      title: "Retomar sessão",
      optional: "Retomar: Opcional",
      chipOptional: ({ agent }: { agent: string }) => `Retomar sessão do ${agent}`,
      pickerTitle: "Retomar sessão",
      subtitle: ({ agent }: { agent: string }) =>
        `Cole um ID de sessão do ${agent} para retomar`,
      placeholder: ({ agent }: { agent: string }) =>
        `Cole o ID de sessão do ${agent}…`,
      paste: "Colar",
      save: "Salvar",
      clearAndRemove: "Limpar",
      helpText:
        "Você pode encontrar os IDs de sessão na tela de informações da sessão.",
      cannotApplyBody:
        "Este ID de retomada não pode ser aplicado agora. O Happier iniciará uma nova sessão em vez disso.",
    },
    codexResumeBanner: {
      title: "Servidor de retomada do Codex",
      updateAvailable: "Atualização disponível",
      systemCodexVersion: ({ version }: { version: string }) =>
        `Codex do sistema: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Servidor do Codex resume: ${version}`,
      notInstalled: "não instalado",
      latestVersion: ({ version }: { version: string }) =>
        `(mais recente ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `Falha na verificação do registro: ${error}`,
      install: "Instalar",
      update: "Atualizar",
      reinstall: "Reinstalar",
    },
    codexResumeInstallModal: {
      installTitle: "Instalar o servidor de retomada do Codex?",
      updateTitle: "Atualizar o servidor de retomada do Codex?",
      reinstallTitle: "Reinstalar o servidor de retomada do Codex?",
      description:
        "Isso instala um wrapper experimental de servidor MCP do Codex usado apenas para operações de retomada.",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "Instalar",
      update: "Atualizar",
      reinstall: "Reinstalar",
    },
    codexAcpInstallModal: {
      installTitle: "Instalar Codex ACP?",
      updateTitle: "Atualizar Codex ACP?",
      reinstallTitle: "Reinstalar Codex ACP?",
      description:
        "Isso instala um adaptador ACP experimental em torno do Codex que oferece suporte a carregar/retomar threads.",
    },
  },

  sessionHistory: {
    // Used by session history screen
    title: "Histórico de sessões",
    empty: "Nenhuma sessão encontrada",
    today: "Hoje",
    yesterday: "Ontem",
    daysAgo: ({ count }: { count: number }) =>
      `há ${count} ${count === 1 ? "dia" : "dias"}`,
    viewAll: "Ver todas as sessões",
  },

  sessionHandoff: sessionHandoffTranslationExtensions.pt,

  session: {
    inputPlaceholder: "Digite uma mensagem ...",
    toolCalls: "Chamadas de ferramenta",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} mais…`,
    forking: {
      dividerTitle: "Derivado de um contexto anterior",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Derivado de ${parent}`,
      dividerSubtitle: "Contexto anterior (somente leitura)",
      openParent: "Abrir",
      openParentA11y: "Abrir sessão pai",
      forkFromMessageA11y: "Derivar desta mensagem",
	    },
	    rollback: {
	      latestTurnA11y: 'Reverter o ultimo turno',
	      beforeUserMessageA11y: 'Reverter para antes desta mensagem',
	    },
	    resuming: "Retomando...",
	    resumeFailed: "Falha ao retomar a sessão",
	    pendingQueuedResumeFailedTitle: "Mensagem na fila",
	    pendingQueuedResumeFailedBody:
	      "Sua mensagem foi salva na fila de pendentes, mas o Happier não conseguiu retomar esta sessão. Tente novamente para iniciá-la.",
	    invalidLinkTitle: "Link de sessão inválido",
	    invalidLinkDescription: "O link da sessão está ausente ou é inválido. Verifique a URL e tente novamente.",
	    resumeSupportNoteChecking:
	      "Nota: o Happier ainda está verificando se esta máquina pode retomar a sessão do provedor.",
	    resumeSupportNoteUnverified:
	      "Nota: o Happier não conseguiu verificar o suporte de retomada para esta máquina.",
    resumeSupportDetails: {
      cliNotDetected: "CLI não detectado na máquina.",
      capabilityProbeFailed: "Falha na verificação de capacidades.",
      acpProbeFailed: "Falha na verificação ACP.",
      loadSessionFalse: "O agente não oferece suporte para carregar sessões.",
    },
    inactiveResumable: "Inativa (retomável)",
    inactiveMachineOffline: "Inativa (máquina offline)",
    inactiveNotResumable: "Inativa",
    inactiveNotResumableNoticeTitle: "Esta sessão não pode ser retomada",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `Esta sessão terminou e não pode ser retomada porque ${provider} não oferece suporte para restaurar o contexto aqui. Inicie uma nova sessão para continuar.`,
    machineOfflineNoticeTitle: "A máquina está offline",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” está offline, então o Happier ainda não consegue retomar esta sessão. Traga a máquina de volta online para continuar.`,
      machineOfflineCannotResume:
        "A máquina está offline. Traga-a de volta online para retomar esta sessão.",
        openRuns: "Abrir execuções da sessão",
        openAutomations: "Abrir automações da sessão",
        openSubagents: ({ count }: { count: number }) => (count > 0 ? `Abrir agentes (${count})` : 'Abrir agentes'),
        participants: {
          to: 'Para',
          lead: 'Principal',
          sendToTitle: 'Enviar para',
          broadcast: ({ teamId }: { teamId: string }) => `Broadcast: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `Execução ${runId}`,
          cardTo: ({ label }: { label: string }) => `Para: ${label}`,
          unsupportedAttachmentsOrReviewComments: 'Enviar para um destinatário ainda não suporta anexos nem comentários de revisão.',
        },
        subagents: {
          messages: {
            teamLabel: ({ teamId }: { teamId: string }) => `Team: ${teamId}`,
            memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
              `${memberLabel} · ${teamId}`,
            launch: {
              createTeamTitle: "Criar equipe",
              createMemberTitle: "Iniciar colega de equipe",
            },
            command: {
              deleteTeamTitle: "Excluir equipe",
              deleteMemberTitle: "Desligar colega de equipe",
            },
          },
                    panel: {
            title: "Agentes",
            active: "Ativos",
            recent: "Recentes",
            emptyActive: "Nenhum agente ativo.",
            emptyRecent: "Ainda não há agentes recentes.",
            openFull: "Abrir visualização completa",
            openAdvancedRun: "Detalhes da execução",
            send: "Enviar mensagem",
            delete: "Excluir",
            launchSectionTitle: "Iniciar",
            launchSectionSubtitle: "Inicie novos agentes e execuções a partir desta sessão.",
            sectionCount: ({ count }: { count: number }) => `${count}`,
            groupCount: ({ count }: { count: number }) => `${count} agentes`,
            launchExecutionRunsTitle: "Iniciar execuções",
            launchExecutionRunsSubtitle: "Abra o iniciador de execuções com predefinições de revisão, plano ou delegação.",
            launchExecutionRunsAdvanced: "Avançado…",
            launchClaudeTeamsTitle: "Iniciar equipes Claude",
            launchClaudeTeamsSubtitle: "Crie uma equipe ou inicie um colega com comandos estruturados de equipes Claude.",
            teamIdLabel: "ID da equipe",
            teamIdPlaceholder: "id-da-equipe",
            teamDescriptionPlaceholder: "Pelo que esta equipe é responsável?",
            launchClaudeTeamA11y: "Criar equipe Claude",
            launchClaudeTeamAction: "Criar equipe",
            teammateTeamIdLabel: "Equipe do colega",
            teammateLabelPlaceholder: "Rótulo do colega",
            teammateInstructionsPlaceholder: "O que este colega deve fazer?",
            launchTeammateA11y: "Iniciar colega",
            launchTeammateAction: "Iniciar colega",
            typeFact: ({ value }: { value: string }) => `Tipo: ${value}`,
            providerFact: ({ value }: { value: string }) => `Provedor: ${value}`,
            backendFact: ({ value }: { value: string }) => `Backend: ${value}`,
            intentFact: ({ value }: { value: string }) => `Intenção: ${value}`,
            errors: {
              teamIdRequired: "Informe primeiro um ID de equipe.",
              memberTeamIdRequired: "Informe primeiro o ID da equipe do colega.",
              memberLabelRequired: "Informe primeiro um rótulo para o colega.",
              memberInstructionsRequired: "Informe primeiro as instruções do colega.",
            },
          },
          details: {
            unavailable: "Esta transcrição do agente não está mais disponível.",
          },
          kind: {
            execution_run: "Execução",
            agent_team_member: "Agente de equipe",
            subagent_sidechain: "Subagente",
          },
          intent: {
            review: "Revisão",
            plan: "Plano",
            delegate: "Delegação",
          },
        },
        actionMenu: {
          openA11y: "Abrir ações da sessão",
        },
      detailsPanel: {
        emptyHint: "Abra um arquivo ou diff no painel direito.",
        unsupportedTab: "Aba de detalhes não suportada.",
        closeA11y: "Fechar detalhes",
          openTabA11y: ({ title }: { title: string }) => `Abrir aba ${title}`,
          pinTabA11y: "Fixar aba",
          unpinTabA11y: "Desafixar aba",
          pinnedTabA11y: "Aba fixada",
          closeTabA11y: "Fechar aba",
          enterFocusModeA11y: "Entrar no modo de foco do editor",
          exitFocusModeA11y: "Sair do modo de foco do editor",
      },
  
      actionsDraft: {
        noInputHints: "Esta ação não tem dicas de entrada.",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `${field} é obrigatório.`,
        },
      },

    planOutput: {
      title: "Plano",
      recommendedBackend: "Backend recomendado",
      risks: "Riscos",
      milestones: "Marcos",
      adoptPlan: "Adotar plano",
      sending: "Enviando…",
      failedToAdopt: "Falha ao adotar o plano",
      a11y: {
        adoptPlan: "Adotar plano",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `Achados de revisão (${count})`,
      questionsTitle: "Perguntas do revisor",
      assumptionsTitle: "Suposições",
      findingTitle: ({
        status,
        severity,
        category,
        title,
      }: {
        status: string;
        severity: string;
        category: string;
        title: string;
      }) => `[${status}] [${severity}/${category}] ${title}`,
      status: {
        untriaged: "Pendente",
        accept: "Implementar correção",
        reject: "Ignorar",
        defer: "Decidir depois",
        needsRefinement: "Pedir esclarecimento",
      },
      refinementPlaceholder: "O que precisa de esclarecimento?",
      actions: {
        applyTriage: "Aplicar ações da revisão",
        applying: "Aplicando…",
        askReviewer: "Perguntar ao revisor",
        answerQuestion: "Responder ao revisor",
        applyAcceptedFindings: "Implementar correções selecionadas",
        sendFollowUp: "Enviar acompanhamento",
        sending: "Enviando…",
      },
      errors: {
        applyTriageFailed: "Falha ao aplicar as ações da revisão.",
        followUpFailed: "Falha ao enviar o acompanhamento da revisão.",
        applyAcceptedFailed: "Falha ao enviar as correções selecionadas.",
      },
    },

      pendingMessages: {
        title: "Mensagens pendentes",
        indicator: ({ count }: { count: number }) => `Pendentes (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `Pendentes (+${count})` : "Pendentes",
	        empty: "Nenhuma mensagem pendente.",
	        decryptFailed: "Não foi possível descriptografar esta mensagem pendente.",
	        actions: {
          up: "Para cima",
          down: "Para baixo",
          edit: "Editar",
            viewMore: "Ver mais",
            viewLess: "Ver menos",
          steerNow: "Inserir agora",
          sendNow: "Enviar agora",
          sendNowInterrupt: "Enviar agora (interromper)",
          requeue: "Reenfileirar",
        },
        editPrompt: {
          title: "Editar mensagem pendente",
        },
        removeConfirm: {
          title: "Remover mensagem pendente?",
          body: "Isso excluirá a mensagem pendente.",
        },
        steerConfirm: {
          title: "Inserir agora?",
          body: "Isso adicionará esta mensagem ao turno atual sem interrompê-lo.",
        },
        sendConfirm: {
          title: "Enviar agora?",
          interruptTitle: "Enviar agora (interromper)?",
          body: "Isso interromperá o turno atual e enviará esta mensagem imediatamente.",
        },
        discarded: {
          title: "Mensagens descartadas",
          subtitle:
            "Essas mensagens não foram enviadas ao agente (por exemplo, ao mudar de remoto para local).",
          label: "Descartada",
          removeConfirm: {
            title: "Remover mensagem descartada?",
            body: "Isso excluirá a mensagem descartada.",
          },
        },
        errors: {
          updateFailed: "Falha ao atualizar a mensagem pendente",
          deleteFailed: "Falha ao excluir a mensagem pendente",
          sendFailed: "Falha ao enviar a mensagem pendente",
          restoreFailed: "Falha ao restaurar a mensagem descartada",
          deleteDiscardedFailed: "Falha ao excluir a mensagem descartada",
          sendDiscardedFailed: "Falha ao enviar a mensagem descartada",
          reorderFailed: "Falha ao reordenar mensagens pendentes",
        },
      },

      sharing: {
        title: "Compartilhamento",
        directSharing: "Compartilhamento direto",
        addShare: "Compartilhar com um amigo",
      accessLevel: "Nível de acesso",
      shareWith: "Compartilhar com",
      sharedWith: "Compartilhado com",
      noShares: "Não compartilhado",
      viewOnly: "Somente visualizar",
      viewOnlyDescription: "Pode ver a sessão, mas não enviar mensagens.",
      viewOnlyMode: "Somente visualização (sessão compartilhada)",
      noEditPermission: "Você tem acesso somente leitura a esta sessão.",
      canEdit: "Pode editar",
      canEditDescription: "Pode enviar mensagens.",
      canManage: "Pode gerenciar",
      canManageDescription: "Pode gerenciar o compartilhamento.",
      manageSharingDenied:
        "Você não tem permissão para gerenciar as configurações de compartilhamento desta sessão.",
      stopSharing: "Parar de compartilhar",
      recipientMissingKeys:
        "Este usuário ainda não registrou chaves de criptografia.",
      permissionApprovals: "Pode aprovar permissões",
      allowPermissionApprovals: "Permitir aprovar permissões",
      allowPermissionApprovalsDescription:
        "Permite que este usuário aprove solicitações de permissão e execute ferramentas na sua máquina.",
      permissionApprovalsDisabledTitle:
        "A aprovação de permissões está desativada",
      permissionApprovalsDisabledPublic:
        "Links públicos são somente leitura. Não é possível aprovar permissões.",
      permissionApprovalsDisabledReadOnly:
        "Você tem acesso somente leitura a esta sessão.",
      permissionApprovalsDisabledInactive:
        "Esta sessão está inativa. Não é possível aprovar permissões.",
      permissionApprovalsDisabledNotGranted:
        "O proprietário não permitiu que você aprovasse permissões para esta sessão.",
      publicReadOnlyTitle: "Link público (somente leitura)",
      publicReadOnlyBody:
        "Esta sessão é compartilhada por link público. Você pode ver mensagens e saídas das ferramentas, mas não pode interagir nem aprovar permissões.",

      publicLink: "Link público",
      publicLinkActive: "Link público ativo",
      publicLinkDescription:
        "Crie um link para que qualquer pessoa possa ver esta sessão.",
      createPublicLink: "Criar link público",
      regeneratePublicLink: "Regenerar link público",
      deletePublicLink: "Excluir link público",
      linkToken: "Token do link",
      tokenNotRecoverable: "Token indisponível",
      tokenNotRecoverableDescription:
        "Por segurança, tokens de link público são armazenados como hash e não podem ser recuperados. Regere o link para criar um novo token.",

      expiresIn: "Expira em",
      expiresOn: "Expira em",
      days7: "7 dias",
      days30: "30 dias",
      never: "Nunca",

      maxUsesLabel: "Máximo de usos",
      unlimited: "Ilimitado",
      uses10: "10 usos",
      uses50: "50 usos",
      usageCount: "Contagem de usos",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} usos`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} usos`,

      requireConsent: "Exigir consentimento",
      requireConsentDescription:
        "Peça consentimento antes de registrar o acesso.",
      consentRequired: "Consentimento exigido",
      consentDescription:
        "Este link exige seu consentimento para registrar seu IP e agente de usuário.",
      acceptAndView: "Aceitar e visualizar",
      sharedBy: ({ name }: { name: string }) => `Compartilhado por ${name}`,

      shareNotFound: "Link de compartilhamento não encontrado ou expirado",
      failedToDecrypt: "Falha ao descriptografar a sessão",
      noMessages: "Ainda não há mensagens",
      session: "Sessão",
    },
  },

  commandPalette: {
    placeholder: "Digite um comando ou pesquise...",
    noCommandsFound: "Nenhum comando encontrado",
  },

  commandView: {
    completedWithNoOutput: "[Comando concluído sem saída]",
  },

  delegation: {
    output: {
      title: "Delegação",
      deliverablesTitle: "Entregáveis",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "Atualizar modelos",
    loadingModelsA11y: "Carregando modelos…",
    refreshingModelsA11y: "Atualizando modelos…",
    searchPlaceholder: "Pesquisar modelos…",
    customTitle: "Personalizado…",
    effectiveLabel: ({ label }: { label: string }) => `Em uso: ${label}`,
  },

  voiceAssistant: {
    connecting: "Conectando...",
    active: "Assistente de voz ativo",
    connectionError: "Erro de conexão",
    label: "Assistente de voz",
    tapToEnd: "Toque para encerrar",
  },

  voiceSurface: {
    start: "Iniciar",
    stop: "Parar",
    selectSessionToStart: "Selecione uma sessão para iniciar a voz",
    targetSession: "Sessão alvo",
    noTarget: "Nenhuma sessão selecionada",
    clearTarget: "Limpar alvo",
    a11y: {
      teleport: "Teletransportar agente de voz",
      toggleActivity: "Alternar atividade de voz",
      clearActivity: "Limpar atividade de voz",
      bargeIn: "Interromper",
      cancelTurn: "Cancelar resposta",
    },
  },

  voiceActivity: {
    title: "Atividade de voz",
    empty: "Nenhuma atividade de voz ainda.",
    clear: "Limpar",
    format: {
      voiceAgent: "Agente de voz",
      you: "Você",
      assistant: "Assistente",
      assistantStreaming: "Assistente…",
      action: "Ação",
      error: "Erro",
      status: "Estado",
      started: "Iniciado",
      stopped: "Parado",
      errorFallback: "erro",
      eventFallback: "evento",
    },
  },

  devVoiceQa: {
    menuTitle: "Painel de QA de voz",
    menuSubtitle: "Controle o agente de voz real com prompts de texto",
    title: "Painel de QA de voz",
    subtitle: "Inicie o runtime de voz configurado e envie prompts sem usar o microfone.",
    instructions: "Use esta tela para testar o agente de voz local real ou uma sessão do ElevenLabs com prompts de texto determinísticos. Deixe o ID da sessão em branco para usar o destino de voz atual ou a sessão global do agente de voz.",
    configurationTitle: "Configuração",
    configuredProvider: "Provedor configurado",
    qaProvider: "Provedor de QA ativo",
    qaStatus: "Status do QA",
    targetSession: "Sessão de destino atual",
    runtimeSession: "Sessão de runtime ativa",
    inputsTitle: "Entradas",
    sessionIdLabel: "Substituição do ID da sessão",
    sessionIdPlaceholder: "Deixe em branco para usar o destino de voz atual",
    initialContextLabel: "Contexto inicial",
    initialContextPlaceholder: "Contexto opcional enviado quando a sessão de QA é iniciada",
    promptLabel: "Comando",
    promptPlaceholder: "Digite o texto que você quer enviar ao agente de voz",
    contextUpdateLabel: "Atualização de contexto",
    contextUpdatePlaceholder: "Atualização de contexto opcional de acompanhamento",
    actionsTitle: "Ações",
    sendContext: "Enviar contexto",
    usesCurrentProvider: "Este painel sempre usa suas configurações atuais de voz e as integrações reais de runtime.",
    localModeHint: "O QA local exige Local voice com o modo de conversa definido como Agent.",
    elevenLabsHint: "O QA do ElevenLabs exige que o provedor ElevenLabs esteja configurado e que a sessão em tempo real se conecte com sucesso.",
    transcriptTitle: "Transcrição QA",
    transcriptEmpty: "Ainda não há transcrição QA.",
    activityTitle: "Atividade de voz",
    activityEmpty: "Ainda não há atividade de voz capturada para a sessão de QA ativa.",
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Configuração do servidor",
    enterServerUrl: "Por favor, insira uma URL do servidor",
    notValidHappyServer: "Não é um servidor Happier válido",
    changeServer: "Alterar servidor",
    continueWithServer: "Continuar com este servidor?",
    resetToDefault: "Redefinir para padrão",
    resetServerDefault: "Redefinir servidor para padrão?",
    validating: "Validando...",
    validatingServer: "Validando servidor...",
    serverReturnedError: "O servidor retornou um erro",
    failedToConnectToServer: "Falha ao conectar com o servidor",
    currentlyUsingCustomServer: "Atualmente usando servidor personalizado",
    customServerUrlLabel: "URL do servidor personalizado",
    advancedFeatureFooter:
      "Este é um recurso avançado. Altere o servidor apenas se souber o que está fazendo. Você precisará sair e entrar novamente após alterar servidores.",
    useThisServer: "Usar este servidor",
    autoConfigHint:
      "Se você está hospedando: configure o servidor primeiro, depois entre (ou crie uma conta) e, por fim, conecte seu terminal.",
    renameServer: "Renomear servidor",
    renameServerPrompt: "Digite um novo nome para este servidor.",
    renameServerGroup: "Renomear grupo de servidores",
    renameServerGroupPrompt: "Digite um novo nome para este grupo de servidores.",
    serverNamePlaceholder: "Nome do servidor",
    cannotRenameCloud: "Você não pode renomear o servidor na nuvem.",
    removeServer: "Remover servidor",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Remover "${name}" dos servidores salvos?`,
    removeServerGroup: "Remover grupo de servidores",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Remover "${name}" dos grupos de servidores salvos?`,
    cannotRemoveCloud: "Você não pode remover o servidor na nuvem.",
    signOutThisServer: "Sair também deste servidor?",
    signOutThisServerPrompt:
      "Foram encontradas credenciais salvas para este servidor neste dispositivo.",
    savedServersTitle: "Servidores salvos",
    signedIn: "Conectado",
    signedOut: "Desconectado",
    authStatusUnknown: "Status de autenticação desconhecido",
    switchToServer: "Trocar para este servidor",
    active: "Ativo",
    default: "Padrão",
    addServerTitle: "Adicionar servidor",
    switchForThisTab: "Trocar para esta aba",
    makeDefaultOnDevice: "Definir como padrão neste dispositivo",
    serverNameLabel: "Nome do servidor",
      addAndUse: "Adicionar e usar",
      addTargetsTitle: "Adicionar",
      addServerSubtitle: "Adicionar um novo servidor e trocar para ele",
      notificationAddServerHint: "Este servidor ainda não está salvo neste dispositivo. Adicione-o abaixo para continuar.",
      serverCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "servidor", plural: "servidores" })}`,
      useCanonicalServerUrlTitle: "Usar a URL canônica do servidor?",
    useCanonicalServerUrlBody:
      "Este servidor anuncia uma URL canônica que deve funcionar em outros dispositivos. Usar essa URL em vez da que você inseriu?",
    insecureHttpUrlTitle: "URL do servidor insegura",
    insecureHttpUrlBody:
      "Esta URL usa http:// e pode não funcionar no seu telefone ou fora da sua LAN. Use HTTPS se possível. Continuar mesmo assim?",
    signedOutSwitchConfirmTitle: "Você não está conectado",
    signedOutSwitchConfirmBody:
      "Trocar para este servidor e continuar para a tela inicial para que você possa entrar ou criar uma conta?",
    addServerGroupTitle: "Adicionar grupo de servidores",
    addServerGroupSubtitle: "Criar um grupo reutilizável de servidores",
    serverGroupNameLabel: "Nome do grupo",
    serverGroupNamePlaceholder: "Meu grupo de servidores",
    serverGroupServersLabel: "Servidores",
    saveServerGroup: "Salvar grupo",
    serverGroupMustHaveServer:
      "Um grupo de servidores deve incluir pelo menos um servidor.",
    retention: {
      title: "Politica de retencao",
      summary: "Resumo",
      keepForever: "Sem exclusao automatica",
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Exclui sessoes inativas apos ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Exclui dados apos ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      sessionNotice: ({ count }: { count: number }) => `Este servidor exclui sessoes inativas apos ${count} ${plural({ count, singular: 'dia', plural: 'dias' })} de inatividade.`,
      sessions: "Sessoes",
      accountChanges: "Alteracoes da conta",
      voiceSessionLeases: "Concessoes de sessao de voz",
      feedItems: "Itens do feed",
      sessionShareAccessLogs: "Logs de acesso a compartilhamentos de sessao",
      publicShareAccessLogs: "Logs de acesso a compartilhamentos publicos",
      terminalAuthRequests: "Solicitacoes de autenticacao do terminal",
      accountAuthRequests: "Solicitacoes de autenticacao da conta",
      authPairingSessions: "Sessoes de pareamento de autenticacao",
      repeatKeys: "Chaves de repeticao",
      globalLocks: "Bloqueios globais",
      automationRuns: "Execucoes de automacao",
      automationRunEvents: "Eventos de execucao de automacao",
    },
    multiServerView: {
      title: "Visualização simultânea de vários servidores",
      footer:
        "Escolha se deseja combinar vários servidores em uma única lista de sessões.",
      enableTitle: "Ativar visualização simultânea",
      enableSubtitle: "Mostrar juntas as sessões dos servidores selecionados",
      presentationTitle: "Modo de apresentação",
      presentation: {
        flatWithBadges: "Lista plana com badges de servidor",
        groupedByServer: "Agrupado por servidor",
      },
    },
  },

  sessionTags: {
    searchOrAddPlaceholder: "Pesquisar ou adicionar etiquetas",
    editTagsLabel: "Editar etiquetas",
    noTagsFound: "Nenhuma tag encontrada",
    newTagItem: "Nova tag…",
    newTagTitle: "Nova tag",
    newTagMessage: "Digite um nome para a nova tag.",
    newTagConfirm: "Adicionar",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Servidor: ${server}`,
    storagePersistedTab: "Sincronizadas",
    storageDirectTab: "Diretas",
    renameWorkspace: 'Renomear área de trabalho',
    renameWorkspacePromptTitle: 'Renomear área de trabalho',
    renameWorkspacePromptPlaceholder: 'Digite um nome...',
    resetWorkspaceName: 'Redefinir nome',
  },

  directSessions: {
    browseTitle: "Navegar pelas sessões do provedor",
    browseOpenExisting: "Navegar pelas sessões do provedor",
    browseFiltersTitle: "Selecionar origem",
    browseMachines: "Máquinas",
    browseProviders: "Provedores",
    browseSources: "Fontes",
    browseSourceCodexUserHome: "Meu diretório Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} connected services`,
    browseSourceClaudeDefault: "Configuração padrão do Claude",
    browseSourceOpenCodeDefault: "Servidor padrão do OpenCode",
    browseCandidates: "Sessões disponíveis",
    browseNoMachines: "Ainda não há máquinas disponíveis para sessões diretas.",
    browseNoCandidates: "Nenhuma sessão do provedor foi encontrada para esta máquina e este provedor.",
    browseActivityRunning: "Em execução",
        browseActivityRunningNow: "Em execução",
    browseActivityRecent: "Recente",
    browseActivityIdle: "Inativa",
    browseActivityUnknown: "Desconhecida",
        browseSearchPlaceholder: "Pesquisar sessões carregadas…",
        browseNoSearchResults: "Nenhuma sessão carregada corresponde ainda a esta pesquisa.",
    browseLoadMore: "Carregar mais sessões",
    browseFailedToLoad: "Falha ao carregar sessões do provedor.",
    browseLinkFailed: "Falha ao vincular a sessão do provedor selecionada.",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: 'Checkout principal',
            git_worktree: 'worktree Git',
        },
    },
    sourceControlWorkspace: {
        createTitle: 'Criar workspace vinculado',
        createSubtitle: 'Adicione este checkout a um espaco de trabalho vinculado e abra suas configuracoes.',
        otherCheckoutsTitle: 'Outros checkouts',
        unlinkedWorktreesTitle: 'Worktrees desvinculados',
        createSessionInWorktreeTitle: 'Criar sessão aqui',
        adoptWorktreeTitle: 'Adicionar worktree ao workspace',
    },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "Informações da sessão",
	    killSession: "Encerrar sessão",
    killSessionConfirm: "Tem certeza de que deseja encerrar esta sessão?",
    stopSession: "Parar sessão",
    stopSessionConfirm: "Tem certeza de que deseja parar esta sessão?",
    archiveSession: "Arquivar sessão",
    archiveSessionConfirm: "Tem certeza de que deseja arquivar esta sessão?",
    workspaceTitle: "Espaço de trabalho",
    workspaceLabel: "Espaço de trabalho",
    linkWorkspaceTitle: "Vincular este workspace",
    linkWorkspaceSubtitle: "Crie um workspace vinculado a partir deste caminho de sessão e abra as respetivas definições.",
    openWorkspaceTitle: "Abrir workspace",
    openWorkspaceSubtitle: "Abra os detalhes e as definições do workspace vinculado.",
    createWorktreeTitle: "Criar worktree",
    createWorktreeSubtitle: "Inicie uma nova sessão que irá criar um Git worktree neste workspace vinculado.",
    locationLabel: "Local",
    checkoutLabel: "Check-out",
    happySessionIdCopied:
      "ID da sessão Happier copiado para a área de transferência",
    failedToCopySessionId: "Falha ao copiar ID da sessão Happier",
    happySessionId: "ID da sessão Happier",
    claudeCodeSessionId: "ID da sessão Claude Code",
    claudeCodeSessionIdCopied:
      "ID da sessão Claude Code copiado para a área de transferência",
    aiProfile: "Perfil de IA",
    aiProvider: "Provedor de IA",
    failedToCopyClaudeCodeSessionId: "Falha ao copiar ID da sessão Claude Code",
    codexSessionId: "ID da sessão Codex",
    codexSessionIdCopied:
      "ID da sessão Codex copiado para a área de transferência",
    failedToCopyCodexSessionId: "Falha ao copiar ID da sessão Codex",
    opencodeSessionId: "ID da sessão OpenCode",
    opencodeSessionIdCopied:
      "ID da sessão OpenCode copiado para a área de transferência",
    auggieSessionId: "ID da sessão Auggie",
    auggieSessionIdCopied:
      "ID da sessão Auggie copiado para a área de transferência",
    geminiSessionId: "ID da sessão Gemini",
    geminiSessionIdCopied:
      "ID da sessão Gemini copiado para a área de transferência",
    qwenSessionId: "ID da sessão Qwen Code",
    qwenSessionIdCopied:
      "ID da sessão Qwen Code copiado para a área de transferência",
    kimiSessionId: "ID da sessão Kimi",
    kimiSessionIdCopied:
      "ID da sessão Kimi copiado para a área de transferência",
    kiloSessionId: "ID da sessão Kilo",
    kiloSessionIdCopied:
      "ID da sessão Kilo copiado para a área de transferência",
    kiroSessionId: "ID da sessão Kiro",
    kiroSessionIdCopied:
      "ID da sessão Kiro copiado para a área de transferência",
    customAcpSessionId: "ID da sessão ACP personalizada",
    customAcpSessionIdCopied:
      "ID da sessão ACP personalizada copiado para a área de transferência",
    piSessionId: "ID da sessão Pi",
    piSessionIdCopied: "ID da sessão Pi copiado para a área de transferência",
    copilotSessionId: "ID da sessão do Copilot",
    copilotSessionIdCopied:
      "ID da sessão do Copilot copiado para a área de transferência",
    metadataCopied: "Metadados copiados para a área de transferência",
    failedToCopyMetadata: "Falha ao copiar metadados",
    failedToKillSession: "Falha ao encerrar sessão",
    failedToStopSession: "Falha ao parar sessão",
    failedToArchiveSession: "Falha ao arquivar sessão",
    connectionStatus: "Status da conexão",
    created: "Criado",
    lastUpdated: "Última atualização",
    sequence: "Sequência",
    quickActions: "Ações rápidas",
    executionRunsSubtitle: "Ver execuções desta sessão",
    automationsTitle: "Automações",
    automationsSubtitle: "Gerencie mensagens agendadas para esta sessão",
    viewSessionLogTitle: "Ver log da sessão",
    viewSessionLogSubtitle: "Abrir a cauda do log ao vivo para esta sessão",
    pinSession: "Fixar sessão",
    unpinSession: "Desafixar sessão",
    copyResumeCommand: "Copiar comando de retomada",
    resumeCommand: ({ sessionId }: { sessionId: string }) =>
      `happier resume ${sessionId}`,
    viewMachine: "Ver máquina",
    viewMachineSubtitle: "Ver detalhes da máquina e sessões",
    killSessionSubtitle: "Encerrar imediatamente a sessão",
    stopSessionSubtitle: "Parar o processo da sessão",
    archiveSessionSubtitle: "Mover esta sessão para Arquivadas",
    archivedSessions: "Sessões arquivadas",
    unarchiveSession: "Desarquivar sessão",
    unarchiveSessionConfirm: "Tem certeza de que deseja desarquivar esta sessão?",
    unarchiveSessionSubtitle: "Mover esta sessão de volta para Inativas",
    failedToUnarchiveSession: "Falha ao desarquivar sessão",
    metadata: "Metadados",
    host: "Host (servidor)",
    path: "Caminho",
    operatingSystem: "Sistema operacional",
    processId: "ID do processo",
    happyHome: "Diretório Happier",
    attachFromTerminal: "Anexar pelo terminal",
    tmuxTarget: "Alvo do tmux",
    tmuxFallback: "Fallback do tmux",
    copyMetadata: "Copiar metadados",
    agentState: "Estado do agente",
    rawJsonDevMode: "JSON bruto (modo dev)",
    sessionStatus: "Status da sessão",
    fullSessionObject: "Objeto completo da sessão",
    controlledByUser: "Controlado pelo usuário",
    pendingRequests: "Solicitações pendentes",
    activity: "Atividade",
    thinking: "Pensando",
    thinkingSince: "Pensando desde",
    thinkingLevel: "Nível de pensamento",
    cliVersion: "Versão do CLI",
    cliVersionOutdated: "Atualização do CLI necessária",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `Versão ${currentVersion} instalada. Atualize para ${requiredVersion} ou posterior`,
    updateCliInstructions:
      "Por favor execute happier self update",
    deleteSession: "Excluir sessão",
    deleteSessionSubtitle: "Remover permanentemente esta sessão",
    deleteSessionConfirm: "Excluir sessão permanentemente?",
    deleteSessionWarning:
      "Esta ação não pode ser desfeita. Todas as mensagens e dados associados a esta sessão serão excluídos permanentemente.",
    failedToDeleteSession: "Falha ao excluir sessão",
    sessionDeleted: "Sessão excluída com sucesso",
    manageSharing: "Gerenciar compartilhamento",
    manageSharingSubtitle:
      "Compartilhe esta sessão com amigos ou crie um link público",
    renameSession: "Renomear Sessão",
    renameSessionSubtitle: "Alterar o nome de exibição desta sessão",
    renameSessionPlaceholder: "Digite o nome da sessão...",
    forkSession: "Derivar sessão",
    forkSessionSubtitle: "Criar uma nova sessão a partir do contexto mais recente",
    failedToRenameSession: "Falha ao renomear sessão",
    sessionRenamed: "Sessão renomeada com sucesso",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "Pronto para programar?",
      installCli: "Instale o Happier CLI",
      runIt: "Execute",
      scanQrCode: "Escaneie o código QR",
      openCamera: "Abrir câmera",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "Nenhuma mensagem ainda",
      created: ({ time }: { time: string }) => `Criado ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "Nenhuma sessão ativa",
      startNewSessionDescription:
        "Inicie uma nova sessão em qualquer uma das suas máquinas conectadas.",
      startNewSessionButton: "Iniciar nova sessão",
      openTerminalToStart:
        "Abra um novo terminal no computador para iniciar uma sessão.",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "O que precisa ser feito?",
    },
    home: {
      noTasksYet: "Ainda não há tarefas. Toque em + para adicionar.",
    },
    view: {
      workOnTask: "Trabalhar na tarefa",
      clarify: "Esclarecer",
      delete: "Excluir",
      linkedSessions: "Sessões vinculadas",
      tapTaskTextToEdit: "Toque no texto da tarefa para editar",
    },
  },

  agentInput: {
    dropToAttach: "Solte para anexar arquivos",
    envVars: {
      title: "Vars env",
      titleWithCount: ({ count }: { count: number }) => `Vars env (${count})`,
    },
    resumeChip: {
      withId: ({ title, id }: { title: string; id: string }) =>
        `${title}: ${id}`,
      withIdTruncated: ({
        title,
        prefix,
        suffix,
      }: {
        title: string;
        prefix: string;
        suffix: string;
      }) => `${title}: ${prefix}…${suffix}`,
    },
    permissionMode: {
      title: "MODO DE PERMISSÃO",
      effectiveLabel: ({ label }: { label: string }) => `Efetivo: ${label}`,
      default: "Padrão",
      readOnly: "Somente leitura",
      acceptEdits: "Aceitar edições",
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      plan: "Modo de planejamento",
      bypassPermissions: "Modo Yolo",
      badgeAccept: "Aceitar",
      badgePlan: "Plano",
      badgeReadOnly: "Somente leitura",
      badgeSafeYolo: "YOLO seguro",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Aceitar todas as edições",
      badgeBypassAllPermissions: "Ignorar todas as permissões",
      badgePlanMode: "Modo de planejamento",
    },
    agent: {
      claude: "Claude",
      codex: "Codex",
      opencode: "OpenCode",
      gemini: "Gemini",
      auggie: "Auggie",
      qwen: "Qwen Code",
      kimi: "Kimi",
      kilo: "Kilo",
      kiro: "Kiro",
      customAcp: "Custom ACP",
      pi: "Pi",
      copilot: "Copilot",
    },
    auggieIndexingChip: {
      on: "Indexação ativada",
      off: "Indexação desativada",
    },
      model: {
        title: "MODELO",
        useCliSettings: "Usar configurações do CLI",
        configureInCli: "Configurar modelos nas configurações do CLI",
        customDescription: "Use um id de modelo que não está na lista.",
        customPromptBody: "Digite um id de modelo",
        customPlaceholder: "ex.: claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "MODO DE PERMISSÃO CODEX",
      default: "Configurações do CLI",
      plan: "Modo de planejamento",
      readOnly: "Modo somente leitura",
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      badgePlan: "Plano",
      badgeReadOnly: "Somente leitura",
      badgeSafeYolo: "YOLO seguro",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "MODELO CODEX",
      gpt5CodexLow: "gpt-5-codex baixo",
      gpt5CodexMedium: "gpt-5-codex médio",
      gpt5CodexHigh: "gpt-5-codex alto",
      gpt5Minimal: "GPT-5 Mínimo",
      gpt5Low: "GPT-5 Baixo",
      gpt5Medium: "GPT-5 Médio",
      gpt5High: "GPT-5 Alto",
    },
    geminiPermissionMode: {
      title: "MODO DE PERMISSÃO GEMINI",
      default: "Padrão",
      readOnly: "Somente leitura",
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      badgeReadOnly: "Somente leitura",
      badgeSafeYolo: "YOLO seguro",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "MODELO GEMINI",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "Mais capaz",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "Rápido e eficiente",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "Mais rápido",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
    },
    suggestion: {
      fileLabel: "ARQUIVO",
      folderLabel: "PASTA",
    },
    mode: {
      sectionTitle: "Modo",
      badge: ({ name }: { name: string }) => `Modo: ${name}`,
      badgePending: ({ name }: { name: string }) => `Modo: ${name} (pendente)`,
      refreshModesA11y: "Atualizar modos",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Pendente: mudando de ${from} para ${to}`,
      currentMode: ({ name }: { name: string }) => `Atual: ${name}`,
      loadingModes: "Carregando modos…",
      refreshingModes: "Atualizando modos…",
      useDefaultModeHint: "Use o modo padrão para este agente.",
      startIn: ({ name }: { name: string }) => `Iniciar em: ${name}`,
      build: "Construir",
      buildDescription: "Comportamento padrão",
      plan: "Plano",
      planDescription: "Pensar primeiro",
    },
    acp: {
      modeSectionTitle: "Modo",
      refreshModesA11y: "Atualizar modos",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Pendente: mudando de ${from} para ${to}`,
      currentMode: ({ name }: { name: string }) => `Atual: ${name}`,
      loadingModes: "Carregando modos…",
      refreshingModes: "Atualizando modos…",
      useDefaultModeHint: "Use o modo padrão para este agente.",
      startIn: ({ name }: { name: string }) => `Iniciar em: ${name}`,
      optionsSectionTitle: "Opções",
      currentValue: ({ value }: { value: string }) => `Atual: ${value}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `Pendente: ${current} → ${requested}`,
    },
    actionMenu: {
      title: "AÇÕES",
      files: "Arquivos",
      stop: "Parar",
    },
    noMachinesAvailable: "Sem máquinas",
  },

  machineLauncher: {
    showLess: "Mostrar menos",
    showAll: ({ count }: { count: number }) =>
      `Mostrar todos (${count} caminhos)`,
    enterCustomPath: "Inserir caminho personalizado",
    offlineUnableToSpawn: "Não é possível criar nova sessão, você está offline",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "Abrir detalhes",
    expand: "Expandir/recolher",
    input: "Entrada",
    output: "Saída",
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} mais`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
      unknownToolTitle: "Ferramenta",
    },
    bashView: {
      commandDiffTitle: "Comando bruto",
      commandDiffHint:
        "A pré-visualização do comando oculta um curto prefixo de limpeza de ambiente para manter a legibilidade. O comando bruto completo é mostrado abaixo.",
    },
    webFetch: {
      httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
    },
    fullView: {
      description: "Descrição",
      inputParams: "Parâmetros de entrada",
      output: "Saída",
      error: "Erro",
      completed: "Ferramenta concluída com sucesso",
      noOutput: "Nenhuma saída foi produzida",
      running: "Ferramenta está executando...",
      debug: "Depuração",
      show: "Mostrar",
      hide: "Ocultar",
      rawJsonDevMode: "JSON bruto (modo desenvolvedor)",
    },
    agentTeamView: {
      team: "Equipe",
      member: "Membro",
      type: "Tipo",
      content: "Conteúdo",
      status: "Estado",
      description: "Descrição",
    },
    subAgentRunView: {
      planTitle: "Plano",
      delegateTitle: "Delegação",
      reviewDigestTitle: "Resumo da revisão",
    },
    changeTitleView: {
      titleLabel: "Título",
    },
    enterPlanMode: {
      title: "Entrou no modo de planejamento",
      body:
        "Agora o agente vai fornecer um plano estruturado antes de tomar ação. Quando estiver pronto, você pode sair do modo de planejamento ou solicitar alterações.",
    },
    structuredResult: {
      exit: "Código de saída",
      stdout: "Saída padrão",
      stderr: "Erro padrão",
      diff: "Diferenças",
      result: "Resultado",
      items: "Itens",
      more: ({ count }: { count: number }) => `+${count} a mais`,
    },
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `Criar subagente: ${subject}`,
      createTask: "Criar subagente",
      listTasks: "Listar subagentes",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `Atualizar subagente ${id} → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `Atualizar subagente ${id}`,
      updateTask: "Atualizar subagente",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `+${count} ferramentas`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "Indexação do workspace",
      description:
        "A indexação ajuda o agente a pesquisar sua base de código mais rápido e fornecer respostas mais precisas. Isso pode escanear arquivos no seu workspace.",
      optionFallback: "Opção",
      chooseOptionHint: "Escolha uma opção abaixo para continuar.",
    },
    acpHistoryImport: {
      title: "Importar histórico da sessão?",
      defaultNote:
        "Este histórico da sessão difere do que já está no Happier. Importar pode criar duplicatas.",
      counts: {
        local: ({ count }: { count: number }) => `Local: ${count}`,
        remote: ({ count }: { count: number }) => `Remoto: ${count}`,
      },
      preview: {
        localTail: "Local (final)",
        remoteTail: "Remoto (final)",
        unknownRole: "desconhecido",
      },
      actions: {
        import: "Importar",
        skip: "Pular",
      },
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Edição ${index} de ${total}`,
      replaceAll: "Substituir tudo",
      summaryEdits: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "edição", plural: "edições" })}`,
    },
    names: {
      task: "Tarefa",
      subAgent: "Subagente",
      terminal: "Console",
      searchFiles: "Buscar arquivos",
      search: "Buscar",
      searchContent: "Buscar conteúdo",
      listFiles: "Listar arquivos",
      planProposal: "Proposta de plano",
      readFile: "Ler arquivo",
      editFile: "Editar arquivo",
      writeFile: "Escrever arquivo",
      fetchUrl: "Buscar URL",
      readNotebook: "Ler notebook",
      editNotebook: "Editar notebook",
      todoList: "Lista de tarefas",
      webSearch: "Busca web",
      reasoning: "Raciocínio",
      applyChanges: "Atualizar arquivo",
      viewDiff: "Diferenças",
      turnDiff: "Diferenças do turno",
      question: "Pergunta",
      changeTitle: "Alterar título",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `Buscar(padrão: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `Buscar(caminho: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) => `Buscar URL(url: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `Editar notebook(arquivo: ${path}, modo: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Lista de tarefas(quantidade: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Busca web(consulta: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(padrão: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} edições)`,
      readingFile: ({ file }: { file: string }) => `Lendo ${file}`,
      writingFile: ({ file }: { file: string }) => `Escrevendo ${file}`,
      modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `Modificando ${count} arquivos`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} e ${count} mais`,
      showingDiff: "Mostrando alterações",
    },
    askUserQuestion: {
      submit: "Enviar resposta",
      multipleQuestions: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "pergunta", plural: "perguntas" })}`,
      other: "Outro",
      otherDescription: "Digite sua própria resposta",
      otherPlaceholder: "Digite sua resposta...",
    },
    exitPlanMode: {
      approve: "Aprovar plano",
      reject: "Rejeitar",
      requestChanges: "Solicitar alterações",
      planMissing:
        "O texto do plano não foi fornecido. Veja o plano na mensagem acima ou peça ao agente para incluí-lo na solicitação de aprovação.",
      requestChangesPlaceholder:
        "Diga ao Claude o que você quer mudar neste plano…",
      requestChangesSend: "Enviar feedback",
      requestChangesEmpty: "Escreva o que você quer mudar.",
      requestChangesFailed: "Falha ao solicitar alterações. Tente novamente.",
      responded: "Resposta enviada",
      approvalMessage:
        "Aprovo este plano. Por favor, prossiga com a implementação.",
      rejectionMessage:
        "Não aprovo este plano. Por favor, revise-o ou pergunte quais alterações eu gostaria.",
    },
  },

  files: {
    searchPlaceholder: "Buscar arquivos...",
    clearSearchA11y: "Limpar pesquisa",
    createFileA11y: "Criar arquivo",
    createFolderA11y: "Criar pasta",
    createFilePromptTitle: "Criar arquivo",
    createFilePromptBody: "Digite um caminho relativo à raiz do projeto.",
    createFileInvalidPath:
      "Caminho de arquivo inválido. Use um caminho relativo ao workspace como src/new-file.ts.",
    createFileFailed: "Falha ao criar o arquivo.",
	    createFolderPromptTitle: "Criar pasta",
	    createFolderPromptBody: "Digite um caminho de pasta relativo à raiz do projeto.",
	    createFolderInvalidPath:
	      "Caminho de pasta inválido. Use um caminho relativo ao workspace como src/new-folder.",
	    createFolderFailed: "Falha ao criar a pasta.",
	    repositoryTree: {
	      actions: {
	        copyPath: "Copiar caminho",
	        download: "Baixar",
	        downloadAsZip: "Baixar como ZIP",
	      },
	      dropToUpload: "Solte arquivos para enviar",
	      rename: {
	        title: "Renomear",
	        body: "Digite um novo caminho relativo à raiz do projeto.",
	        invalidPath:
	          "Caminho inválido. Use um caminho relativo ao workspace como src/new-file.ts.",
	        failed: "Falha ao renomear.",
	        conflicts: {
	          title: "O destino já existe",
	          body: ({ path }: { path: string }) => `"${path}" já existe. O que você quer fazer?`,
	        },
	      },
	      deleteFolder: {
	        title: "Excluir pasta?",
	        body: ({ path }: { path: string }) =>
	          `Excluir a pasta ${path} e todo o seu conteúdo?`,
	        confirm: "Excluir pasta",
	      },
	      deleteFile: {
	        title: "Excluir arquivo?",
	        body: ({ path }: { path: string }) => `Excluir o arquivo ${path}?`,
	      },
	      delete: {
	        failed: "Falha ao excluir.",
	      },
	      download: {
	        notReady: "O download ainda não está disponível.",
	      },
	    },
	    changeRow: {
	      viewDiffA11y: ({ file }: { file: string }) => `Ver diff de ${file}`,
	      status: {
	        untracked: "Arquivo não rastreado",
        added: "Novo arquivo",
        deleted: "Arquivo excluído",
        renamed: "Arquivo renomeado",
        copied: "Arquivo copiado",
        conflicted: "Arquivo em conflito",
        modified: "Arquivo modificado",
      },
    },
    projectLinkPicker: {
      title: "Vincular arquivo do projeto",
      searchFailed: "A busca falhou. Tente novamente.",
    },
    detachedHead: "HEAD desanexado",
    branchSwitchDialog: {
      title: "Trocar de ramo",
      body: "Você tem alterações não confirmadas. Como deseja lidar com elas?",
      leaveTitle: ({ branch }: { branch: string }) => `Deixar minhas alterações em ${branch}`,
      leaveSubtitle: "Cria um stash no ramo atual e troca.",
      bringTitle: ({ branch }: { branch: string }) => `Levar minhas alterações para ${branch}`,
      bringSubtitle: "Tenta trocar e manter suas alterações no novo ramo.",
    },
    branchMenu: {
      openA11y: "Abrir menu de ramos",
      failedToLoad: "Falha ao carregar ramos.",
      unavailable: "Lista de ramos indisponível",
      empty: "Nenhum ramo encontrado",
      searchPlaceholder: "Pesquisar ramos...",
      category: {
        actions: "Ações",
        branches: "Ramos",
        worktrees: "Árvores de trabalho",
        remote: "Remotos",
        local: "Locais",
        options: "Opções",
      },
      publish: {
        title: "Publicar ramo",
        subtitle: "Envie o ramo atual para um ramo remoto upstream",
        short: "Publicar",
        failed: "Falha ao publicar ramo.",
      },
      create: {
        title: "Criar ramo",
        subtitle: ({ name }: { name: string }) => `Criar \"${name}\"`,
        failed: "Falha ao criar ramo.",
      },
      switch: {
        failed: "Falha ao alternar ramo.",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `Upstream: ${upstream}`,
      },
      remotes: {
        show: "Mostrar ramos remotos",
        hide: "Ocultar ramos remotos",
        subtitle: "Incluir ramos remotos na lista",
      },
      worktrees: {
        createFromCurrentBranchTitle: "Novo worktree a partir da branch atual",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) =>
          `Crie um novo worktree a partir de ${branch} e inicie uma sessão nele.`,
        createFromCurrentBranchDetachedSubtitle:
          "Mude para uma branch antes de criar um worktree a partir da branch atual.",
        createFromAnotherBranchTitle: "Novo worktree a partir de outra branch",
        createFromAnotherBranchSubtitle:
          "Abra o fluxo de nova sessão para escolher outra branch ou reutilizar um worktree existente.",
        removeTitle: "Remover worktree",
        removeSubtitle: ({ target }: { target: string }) =>
          `Remove ${target} from this repository.`,
        removeConfirmTitle: "Remover worktree?",
        removeConfirmBody: ({ path }: { path: string }) =>
          `Remover o worktree em ${path}? Isso não pode ser desfeito.`,
        removeConfirmButton: "Remover worktree",
        pruneTitle: "Limpar worktrees obsoletos",
        pruneSubtitle: "Limpe os metadados de worktrees obsoletos deste repositório.",
        createFailed: "Falha ao criar worktree.",
        removeFailed: "Falha ao remover worktree.",
        pruneFailed: "Falha ao limpar worktrees.",
      },
      stashOverwrite: {
        title: "Sobrescrever o stash do ramo?",
        body: ({ branch }: { branch: string }) =>
          `Já existe um stash para ${branch}. Sobrescrever?`,
        confirm: "Sobrescrever stash",
      },
    },
    stash: {
      summaryA11y: "Abrir detalhes do stash",
      summaryTitle: "Stashes gerenciados",
      detailsTitle: "Stashes gerenciados",
      empty: "Nenhum stash gerenciado.",
      failedToLoad: "Falha ao carregar stashes.",
      failedToLoadDiff: "Falha ao carregar o diff do stash.",
      diffTruncated: "Diff truncado (limite de saída).",
      writeDisabled: "As operações de escrita do controle de código-fonte estão desativadas.",
      noSelection: "Selecione um stash para continuar.",
      selectA11y: ({ stash }: { stash: string }) => `Selecionar stash ${stash}`,
      restore: "Restaurar",
      discard: "Descartar",
      restoreFailed: "Falha ao restaurar o stash.",
      discardFailed: "Falha ao descartar o stash.",
      restoreConfirm: {
        title: "Restaurar alterações do stash?",
        body: "Aplicará as alterações em stash na sua árvore de trabalho. Conflitos podem exigir resolução manual.",
        confirm: "Restaurar",
      },
      discardConfirm: {
        title: "Descartar alterações do stash?",
        body: "Isso excluirá permanentemente este stash.",
        confirm: "Descartar",
      },
    },
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} preparados • ${unstaged} não preparados`,
    branchSummary: {
      ahead: "À frente",
      behind: "Atrás",
      included: "Incluído",
      staged: "Preparado",
      pending: "Pendente",
      unstaged: "Não preparado",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "Sem upstream",
    },
    stageActions: {
      selectPendingDiffMode:
        "Selecione o modo de diff Pendente para escolher linhas para o commit.",
      unableToBuildPatchFromSelection:
        "Não foi possível gerar o patch a partir das linhas selecionadas.",
      diffChangedRefreshAndReselect:
        "O diff mudou — atualize e selecione as linhas novamente.",
    },
    discardChangesFor: ({ path }: { path: string }) =>
      `Descartar alterações para ${path}`,
    commitSelection: {
      addToCommit: "Adicionar ao commit",
      removeFromCommit: "Remover do commit",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "arquivo", plural: "arquivos" })}`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `Arquivos alterados no repositório (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Alterações atribuídas à sessão (${count})`,
    latestTurnChanges: ({ count }: { count: number }) =>
      `Alterações do último turno (${count})`,
    latestTurnDescription:
      'Alterações fornecidas pelo provedor do turno concluído mais recente.',
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Outras alterações do repositório (${count})`,
    attributionReliabilityHigh:
      "Atribuição por melhor esforço. A visão do repositório continua sendo a fonte de verdade.",
    attributionReliabilityLimited:
      "Confiabilidade limitada: várias sessões estão ativas para este repositório. Mostrando apenas atribuição direta.",
    attributionLegendFull:
      "direct = das operações desta sessão, inferred = atribuição baseada em snapshot",
    attributionLegendDirectOnly: "direct = das operações desta sessão",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} arquivo${count === 1 ? "" : "s"} inferido${count === 1 ? "" : "s"} mantido${count === 1 ? "" : "s"} nas alterações apenas do repositório.`,
    noSessionAttributedChanges:
      "Nenhuma alteração atribuída à sessão foi detectada no momento.",
    noLatestTurnChanges:
      "Nenhuma alteração do último turno foi detectada no momento.",
    notRepo: "Não é um repositório de controle de versão",
    notUnderSourceControl: "Este diretório não está sob controle de versão",
    searching: "Buscando arquivos...",
      noFilesFound: "Nenhum arquivo encontrado",
      noFilesInProject: "Nenhum arquivo no projeto",
      repositoryFolderLoadFailed: "Não foi possível carregar a pasta",
      repositoryCollapseAll: "Recolher tudo",
    sourceControlOperationsLog: {
      title: "Operações recentes de controle de versão",
      allSessions: "Todas as sessões",
      thisSession: "Esta sessão",
      emptyThisSession: "Nenhuma operação recente para esta sessão.",
    },
    operationsHistory: {
      recentCommits: "Commits recentes",
      noCommitsAvailable: "Nenhum commit disponível.",
      loadMore: "Carregar mais commits",
    },
      reviewFilterPlaceholder: "Filtrar arquivos...",
      reviewNoMatches: "Sem correspondências",
      reviewLargeDiffOneAtATime: "Diff grande detectado; os diffs serão carregados conforme você rola.",
      reviewDiffRequestFailed: "Não foi possível carregar o diff",
      reviewUnableToLoadDiff: "Não foi possível carregar o diff",
      tryDifferentTerm: "Tente um termo de busca diferente",
      searchResults: ({ count }: { count: number }) =>
        `Resultados da busca (${count})`,
    projectRoot: "Raiz do projeto",
    stagedChanges: ({ count }: { count: number }) =>
      `Alterações preparadas (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `Alterações não preparadas (${count})`,
      // File viewer strings
      fileReadFailed: "Falha ao ler o arquivo",
      fileTooLargeToPreview: "O arquivo é grande demais para pré-visualizar",
      fileWriteFailed: "Falha ao escrever o arquivo",
      fileEditor: {
        experimentalHint:
          "A edição é experimental. Salve para gravar as alterações de volta no worktree da sessão.",
      },
      fileEditingUnsupported:
        "A edição de arquivos não é suportada pelo daemon conectado. Atualize o Happier na máquina para habilitar operações de escrita.",
      selectionFailed: "Falha ao atualizar a seleção",
      openReviewCommentsFailed: "Falha ao abrir comentários de revisão",
        reviewComments: {
          title: ({ count }: { count: number }) =>
            `Comentários de revisão (${count})`,
          placeholder: "Adicionar um comentário de revisão…",
          jump: "Ir",
          addCommentA11y: "Adicionar comentário",
          closeCommentA11y: "Fechar comentário",
          draftsChipLabel: ({ count }: { count: number }) =>
            `Revisão (${count})`,
          errors: {
            empty: "O comentário não pode estar vazio",
            couldNotMapSelection: "Não foi possível mapear a seleção para uma linha do diff",
          },
        },
        commitDetails: {
          missingContext: "Falta o contexto do commit",
          failedToLoadDiff: "Falha ao carregar o diff do commit",
          diffUnavailableTitle: "Diff do commit indisponível",
          diffUnavailableHint:
            "Tente abrir o commit novamente na tela Arquivos.",
          commitLabel: "Commit (Git)",
          running: ({ operation }: { operation: string }) =>
            `Em execução: ${operation}`,
          revert: {
            title: "Reverter commit",
            button: "Reverter commit",
            confirm: "Reverter",
            success: "Commit revertido com sucesso",
            failed: "Falha ao reverter o commit",
          },
        },
        commitRevertUnavailable: "Reverter não está disponível para este commit.",
        commitMessageEditor: {
          placeholder: "Mensagem de commit",
          generate: "Gerar",
          generating: "Gerando…",
          applySuggestion: "Aplicar sugestão",
          commit: "Fazer commit",
          generateFailed: "Falha ao gerar mensagem de commit",
          generatorDisabled: "O gerador de mensagens de commit está desativado",
        },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Carregando ${fileName}...`,
        binaryFile: "Arquivo binário",
        imagePreviewTooLarge: "A pré-visualização da imagem é grande demais para ser exibida",
        cannotDisplayBinary: "Não é possível exibir o conteúdo do arquivo binário",
        diff: "Diferenças",
      file: "Arquivo",
    diffModes: {
      pending: "Pendente",
      included: "Incluído",
      combined: "Combinado",
    },
    fileActions: {
      selectForCommit: "Selecionar para commit",
      stageFile: "Preparar arquivo",
      removeFromSelection: "Remover da seleção",
      unstageFile: "Remover do stage",
      selectionHint:
        "Selecione Incluído ou Pendente para habilitar a seleção de linhas.",
      selectedLines: {
        selectLinesForCommit: "Selecionar linhas para commit",
        stageSelectedLines: "Preparar linhas selecionadas",
        unstageSelectedLines: "Remover do stage as linhas selecionadas",
      },
      clearSelection: "Limpar seleção",
    },
    toolbar: {
      changedFiles: "Arquivos alterados",
      details: "Detalhes",
      upload: "Enviar",
      uploadFiles: "Enviar arquivos",
      uploadFolder: "Enviar pasta",
      allRepositoryFiles: "Todos os arquivos do repositório",
      repositoryView: "Visão do repositório",
      turnView: "Visão do turno",
      sessionView: "Visão da sessão",
      review: "Revisão",
      list: "Lista",
      scm: "Git",
    },
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `Preparando envio (${count} arquivos)…`,
      uploading: ({
        completed,
        total,
        uploaded,
        totalBytes,
      }: {
        completed: number;
        total: number;
        uploaded: string;
        totalBytes: string;
      }) => `Enviando ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `Baixando ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "Conflitos de envio",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount} de ${totalCount} arquivos já existem. O que você quer fazer?`,
        keepBoth: {
          title: "Manter ambos",
          subtitle:
            "Adiciona “ (1)”, “ (2)”, … aos nomes em conflito.",
        },
        replace: {
          title: "Substituir",
          subtitle: "Sobrescrever arquivos existentes.",
        },
        skip: {
          title: "Ignorar",
          subtitle: "Enviar apenas arquivos que ainda não existam.",
        },
      },
    },
    fileEmpty: "Arquivo está vazio",
    noChanges: "Nenhuma alteração para exibir",
    sourceControlOperations: {
      title: "Controle de versão",
      actorThisSession: "esta sessão",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `sessão ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `Em execução: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `As operações de controle de versão estão bloqueadas por ${actor}.`,
      globalLock:
        "As operações estão temporariamente bloqueadas porque outra sessão está executando um comando de controle de versão.",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "1 arquivo selecionado para o próximo commit."
          : `${count} arquivos selecionados para o próximo commit.`,
      clear: "Limpar",
      conflictsDetected:
        "Conflitos detectados. Commit, pull e push estão bloqueados até que os conflitos sejam resolvidos.",
      actions: {
        fetch: "Buscar",
        pull: "Puxar",
        push: "Enviar",
      },
      blockedHints: {
        lock: "Bloqueio",
        commitBlocked: "Commit bloqueado",
        pullBlocked: "Pull bloqueado",
        pushBlocked: "Push bloqueado",
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Iniciar execução",
      sections: {
        intent: "Intenção",
        permissions: "Permissões",
        backends: "Motores",
        instructions: "Instruções",
      },
      intents: {
        review: "Revisão",
        plan: "Plano",
        delegate: "Delegar",
      },
      permissionModes: {
        readOnly: "Somente leitura",
        default: "Padrão",
      },
      instructionsPlaceholder: "O que o subagente deve fazer?",
      actions: {
        start: "Iniciar",
      },
      guidancePreview: "Prévia da orientação",
      a11y: {
        startRun: "Iniciar execução",
        cancel: "Cancelar",
        selectIntent: ({ intent }: { intent: string }) =>
          `Selecionar intenção ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `Selecionar permissões ${mode}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Alternar backend ${backendId}`,
      },
    },
    details: {
      titles: {
        executionRun: "Execução",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent} · execução`,
      },
      labels: {
        status: "Estado",
        statusValue: ({ value }: { value: string }) => `Status: ${value}`,
        runId: ({ value }: { value: string }) => `Run ID: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permissions: ${value}`,
        mode: ({ value }: { value: string }) => `Mode: ${value}`,
        intent: "Intenção",
        backendId: "ID do backend",
        permissionMode: "Modo de permissões",
        retentionPolicy: "Política de retenção",
        runClass: "Classe de execução",
        ioMode: "Modo de E/S",
      },
      timestamps: {
        started: "Iniciado",
        finished: "Finalizado",
      },
    },
  },

        settingsActions: {
        aboutSubtitle: 'Escolha onde cada ação é exibida no app, na voz e nas integrações. Itens indisponíveis permanecem visíveis para que você entenda o que está bloqueado por recursos, privacidade ou suporte de runtime.',
        aboutFooter: 'Essas configurações se aplicam globalmente aos padrões da sua conta. Itens indisponíveis explicam por que um destino está bloqueado no momento.',
        searchPlaceholder: 'Pesquisar ações',
        noResults: 'Nenhuma ação corresponde à sua pesquisa atual.',
        noDescription: 'Ainda não há descrição disponível.',
        sections: {
            app: 'No app',
            voice: 'Voz',
            integrations: 'Integrações',
        },
        badges: {
            unavailable: 'Indisponível',
        },
        reasons: {
            voiceFeature: 'Ative as configurações do Assistente de voz para usar este destino.',
            voiceInventoryPrivacy: 'Ative Compartilhar inventário do dispositivo nas configurações de privacidade do Assistente de voz para usar este destino.',
            mcpFeature: 'Ative os servidores MCP para expor esta ação via MCP.',
            executionRunsFeature: 'Ative execution runs para usar esta ação ou destino.',
            memorySearchFeature: 'Ative a Pesquisa de memória local para usar esta ação.',
            sessionHandoffFeature: 'Ative o suporte a handoff de sessão para usar esta ação.',
            notAvailableInThisApp: 'Este destino ainda não é exibido neste cliente.',
        },
        targets: {
            session_header: {
                title: 'Cabeçalho da sessão',
                subtitle: 'Visível na barra de ferramentas do cabeçalho da sessão.',
            },
            session_action_menu: {
                title: 'Menu da sessão',
                subtitle: 'Visível no menu de ações da sessão.',
            },
            session_info: {
                title: 'Detalhes da sessão',
                subtitle: 'Visível na tela de informações da sessão.',
            },
            command_palette: {
                title: 'Paleta de comandos',
                subtitle: 'Visível na paleta global de comandos.',
            },
            slash_command: {
                title: 'Comando slash',
                subtitle: 'Disponível nos seletores de ação no estilo slash-command.',
            },
            agent_input_chips: {
                title: 'Chips do compositor',
                subtitle: 'Mostrados como chips rápidos perto da entrada do agente.',
            },
            voice_panel: {
                title: 'Painel de voz',
                subtitle: 'Mostrado no painel do assistente de voz.',
            },
            run_list: {
                title: 'Lista de execuções',
                subtitle: 'Visível nas listas de execution runs.',
            },
            run_card: {
                title: 'Cartões de execução',
                subtitle: 'Visível nos cartões de execution runs.',
            },
            voice_tool: {
                title: 'Ferramenta de voz',
                subtitle: 'Disponível para o agente de voz como ferramenta chamável.',
            },
            voice_action_block: {
                title: 'Bloco de ação de voz',
                subtitle: 'Mostrado dentro de blocos e affordances de ação de voz.',
            },
            mcp: {
                title: 'MCP',
                subtitle: 'Disponível por meio do catálogo de ações MCP.',
            },
            cli: {
                title: 'CLI de controle de sessão',
                subtitle: 'Disponível por meio da superfície CLI de controle de sessão.',
            },
            contextual_ui: {
                title: 'UI contextual',
                subtitle: 'Mostrado em superfícies contextuais da UI que não têm um posicionamento dedicado.',
            },
        },
    },

settingsSession: {
      sessionList: {
          title: 'Lista de sessões',
          footer: 'Personalize o que aparece em cada linha de sessão.',
          tagsTitle: 'Tags da sessão',
          tagsEnabledSubtitle: 'Controles de tags visíveis na lista de sessões',
          tagsDisabledSubtitle: 'Controles de tags ocultos',
      },
      input: {
          title: 'Entrada',
          footer: 'Configure a aparência e o comportamento da barra de entrada do agente.',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Modo remoto padrão do Windows',
      },
      advanced: {
          title: 'Avançado',
      },
      messageSending: {
        title: "Envio de mensagens",
        footer:
          "Controla o que acontece quando você envia uma mensagem enquanto o agente está em execução.",
        queueInAgentTitle: "Enfileirar no agente (atual)",
        queueInAgentSubtitle:
          "Escreva na transcrição imediatamente; o agente processa quando estiver pronto.",
        interruptTitle: "Interromper e enviar",
        interruptSubtitle: "Abortar o turno atual e enviar imediatamente.",
        pendingTitle: "Pendente até estar pronto",
        pendingSubtitle:
          "Mantenha mensagens em uma fila de pendentes; o agente puxa quando estiver pronto.",
        busySteerPolicyTitle: "Quando o agente está ocupado (com direção)",
        busySteerPolicyFooter:
          "Se o agente suporta direção em voo, escolha se as mensagens direcionam imediatamente ou vão para Pendente primeiro.",
        busySteerPolicy: {
          steerImmediatelyTitle: "Direcionar imediatamente",
          steerImmediatelySubtitle:
            "Enviar na hora e direcionar o turno atual (sem interrupção).",
          queueForReviewTitle: "Enfileirar em Pendente",
          queueForReviewSubtitle:
            "Coloque as mensagens primeiro em Pendente; envie depois usando \"Direcionar agora\".",
        },
      },
      thinking: {
        title: "Pensamento",
        footer:
          "Controla como as mensagens de pensamento do agente aparecem na transcrição da sessão.",
          displayModeTitle: "Exibição do pensamento",
          displayMode: {
            inlineSummaryTitle: "Em linha (resumo)",
            inlineSummarySubtitle: "Mostra um resumo de uma linha; toque para expandir.",
            inlineTitle: "Em linha (completo)",
            inlineSubtitle: "Mostra a mensagem de pensamento completa diretamente na transcrição.",
            toolTitle: "Cartão de ferramenta",
            toolSubtitle:
              "Mostrar mensagens de pensamento como um cartão de ferramenta de Raciocínio.",
            hiddenTitle: "Oculto",
            hiddenSubtitle: "Ocultar mensagens de pensamento da transcrição.",
          },
              inlineChromeTitle: "Cartões de pensamento",
              inlineChromeSubtitle: "Mostra o pensamento em linha com um fundo de cartão sutil.",
        },
      toolRendering: {
        title: "Renderização de ferramentas",
          footer:
            "Controla quanto detalhe de ferramenta é mostrado na linha do tempo da sessão. É uma preferência de UI; não altera o comportamento do agente.",
          defaultToolDetailLevelTitle: "Nível de detalhe padrão",
          expandedToolDetailLevelTitle: "Nível de detalhe ao expandir",
          cardTapActionTitle: "Ação ao tocar",
          timelineChrome: {
            title: "Estilo de ferramentas na linha do tempo",
            cardsTitle: "Cartões",
          cardsSubtitle:
            "Cartões de ferramentas com conteúdo inline (com base no nível de detalhe).",
          activityFeedTitle: "Feed de ferramentas",
          activityFeedSubtitle:
            "Linhas compactas otimizadas para alta densidade de ferramentas.",
        },
        cardDensity: {
          title: "Densidade dos cartões",
          comfortableTitle: "Confortável",
          comfortableSubtitle: "Mais espaçamento e separação mais clara.",
          compactTitle: "Compacto",
          compactSubtitle: "Cabeçalhos mais enxutos e menos padding.",
        },
        activityFeed: {
          defaultDetailTitle: "Detalhe padrão (feed de ferramentas)",
          expandedDetailTitle: "Detalhe expandido (feed de ferramentas)",
          tapActionTitle: "Ação ao tocar (feed de ferramentas)",
          tapAction: {
            expandTitle: "Expandir",
            expandSubtitle: "Toque expande ou recolhe detalhes inline.",
            openTitle: "Abrir",
            openSubtitle: "Toque abre a tela de visão completa da ferramenta.",
          },
          defaultExpandedTitle: "Expandido por padrão",
          defaultExpandedSubtitle:
            "Expandir linhas de ferramentas por padrão no feed de ferramentas.",
        },
        localControlDefaultTitle: "Padrão (controle local)",
        showDebugByDefaultTitle: "Mostrar debug por padrão",
        showDebugByDefaultSubtitle:
          "Expandir automaticamente payloads brutos na visão completa da ferramenta.",
      },
      transcript: {
        title: "Transcrição",
        entrySubtitle: "Abrir configurações da transcrição",
        footer:
          "Personalize como os chats são exibidos e como a transcrição se comporta.",
        codeDiffs: 'Código e diffs',
        codeDiffsFooter: 'Configure como o código e o conteúdo de diff são exibidos na transcrição.',
        layoutTitle: "Disposição",
        layoutFooter:
          "Escolha entre uma transcrição linear e o agrupamento por turnos.",
        layoutPickerTitle: "Layout da transcrição",
        layout: {
          linearTitle: "Lista",
          linearSubtitle: "Mostrar mensagens como uma lista plana.",
          turnsTitle: "Turnos",
          turnsSubtitle: "Agrupar mensagens em turnos usuário/assistente.",
        },
        toolCallsGroupTitle: "Agrupar chamadas de ferramenta",
        toolCallsGroupSubtitle:
          "Compactar chamadas de ferramenta em uma seção de chamadas de ferramenta dentro de cada turno.",
        toolCallsGroupBackgroundTitle: "Fundo do grupo de chamadas",
        toolCallsGroupBackgroundSubtitle:
          "Mostrar um fundo atrás de grupos de chamadas no modo de feed de ferramentas.",
        toolAppearanceTitle: "Aparência das ferramentas",
        toolAppearanceSubtitle:
          "Personalize como as ferramentas aparecem na transcrição.",
        motionTitle: "Movimento",
        motionFooter: "Controle animações na transcrição.",
        motionPickerTitle: "Animações",
        motion: {
          offTitle: "Desativado",
          offSubtitle: "Desativar animações da transcrição.",
          subtleTitle: "Sutil (padrão)",
          subtleSubtitle: "Movimento mínimo e rápido para novas atividades.",
          fullTitle: "Completo",
          fullSubtitle: "Movimento e transições mais expressivos.",
        },
        advancedMotionTitle: "Movimento avançado…",
        advancedMotionSubtitle:
          "Ajuste janela de frescor e alternâncias de animação.",
        scrollTitle: "Rolagem",
        scrollFooter:
          "Controle o fixar no final e o comportamento de pular para o final.",
          scrollPinTitle: "Fixar no final",
          scrollPinSubtitle: "Seguir novas mensagens enquanto você estiver no final.",
          jumpToBottomTitle: "Pular para o final",
          jumpToBottomButtonLabel: "Pular para o final",
          jumpToBottomSubtitle:
            "Mostrar um botão quando você rolar para cima e novas atividades chegarem.",
            advancedScrollTitle: "Rolagem avançada…",
          advancedScrollSubtitle: "Ajuste limites e contadores.",
          advancedTitle: "Avançado…",
          advancedSubtitle: "Controles de desempenho e depuração.",
          advanced: {
            turnGroupingTitle: "Agrupamento por turnos",
            turnGroupingFooter:
            "Controla como os grupos de chamadas de ferramenta são formados dentro dos turnos.",
            performanceTitle: "Desempenho",
            performanceFooter: "Controles de desempenho para streaming e listas.",
            coalesceEnabledTitle: "Agrupar atualizações em streaming",
            coalesceEnabledSubtitle:
              "Agrupa atualizações de socket para manter a rolagem fluida.",
            coalesceWindowTitle: "Janela de agrupamento",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `Atual: ${value}ms`,
            coalesceWindowPromptTitle: "Janela de agrupamento (ms)",
            coalesceWindowPromptBody:
              "Defina com que frequência as atualizações agrupadas são aplicadas ao store.",
            coalesceMaxBatchTitle: "Tamanho máximo do lote",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `Atual: ${value}`,
            coalesceMaxBatchPromptTitle: "Tamanho máximo do lote",
            coalesceMaxBatchPromptBody:
              "Defina um limite superior de mensagens aplicadas em um único flush.",
            thinkingPulseStaleTitle: "Janela de expiração do pensamento",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Atual: ${value}ms`,
            thinkingPulseStalePromptTitle: "Janela de expiração do pensamento (ms)",
            thinkingPulseStalePromptBody:
              "Oculta o pensamento ativo após este tempo sem atualizações.",
            listImplementationTitle: "Implementação da lista do transcript",
            listImplementationSubtitle: "Alternar motor de lista (debug).",
            listImplementation: {
              flashTitle: "FlashList v2 (recomendado)",
              flashSubtitle: "Melhor desempenho para transcripts longos.",
              legacyTitle: "FlatList legado",
              legacySubtitle: "Alternativa para depuração de compatibilidade.",
            },
          toolCallsStrategyTitle: "Estratégia de agrupamento de chamadas",
          toolCallsStrategy: {
            consecutiveTitle: "Ferramentas consecutivas (padrão)",
            consecutiveSubtitle:
              "Agrupar apenas chamadas consecutivas em chamadas de ferramenta.",
            allToolsTitle: "Todas as ferramentas no turno",
            allToolsSubtitle:
              "Agrupar todas as ferramentas de um turno em uma única seção de chamadas de ferramenta.",
          },
            toolCallsCollapsedPreviewCountTitle: "Prévia (recolhido)",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Mostrar as últimas ${value} ferramentas quando Chamadas de ferramenta estiver recolhida.`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "Desativado",
              offSubtitle: "Mostrar apenas o cabeçalho de chamadas de ferramenta.",
              oneTitle: "1 ferramenta",
              oneSubtitle: "Mostrar a ferramenta mais recente como linha de prévia.",
              twoTitle: "2 ferramentas",
              twoSubtitle: "Mostrar as 2 ferramentas mais recentes como linhas de prévia.",
              threeTitle: "3 ferramentas",
              threeSubtitle: "Mostrar as 3 ferramentas mais recentes como linhas de prévia.",
              countTitle: ({ value }: { value: string }) => `${value} ferramentas`,
              countSubtitle: ({ value }: { value: string }) =>
                `Mostrar as ${value} ferramentas mais recentes como linhas de prévia.`,
            },
          motionTitle: "Movimento (avançado)",
          motionFooter:
            "As animações são limitadas pelo frescor para manter o histórico estável.",
          freshnessTitle: "Janela de frescor",
          freshnessSubtitle: ({ value }: { value: string }) => `Atual: ${value}ms`,
          freshnessPromptTitle: "Janela de frescor (ms)",
          freshnessPromptBody:
            "Defina por quanto tempo novos itens ficam “frescos” para animações.",
          animateNewItemsTitle: "Animar novos itens",
          animateNewItemsSubtitle:
            "Animar novas mensagens e ferramentas recebidas por streaming.",
          animateToolExpandCollapseTitle:
            "Animar expandir/recolher ferramentas",
          animateToolExpandCollapseSubtitle:
            "Animar transições inline de expandir/recolher.",
          animateToolExpandCollapseFreshOnlyTitle:
            "Expandir/recolher apenas frescos",
          animateToolExpandCollapseFreshOnlySubtitle:
            "Animar expandir/recolher apenas para ferramentas frescas.",
          animateThinkingTitle: "Animar pensamento",
          animateThinkingSubtitle:
            "Animar mensagens de pensamento em streaming quando visíveis.",
          scrollTitle: "Rolagem (avançado)",
          scrollFooter:
            "Ajuste limites de fixação e comportamento de pulo.",
          pinOffsetTitle: "Limite de offset fixado",
          pinOffsetSubtitle: ({ value }: { value: string }) => `Atual: ${value}px`,
          pinOffsetPromptTitle: "Limite de offset fixado (px)",
          pinOffsetPromptBody:
            "Defina a distância do final que ainda conta como fixado.",
          autoFollowTitle: "Acompanhar automaticamente quando fixado",
          autoFollowSubtitle:
            "Quando fixado, acompanhar automaticamente novas atividades.",
          jumpMinNewCountTitle: "Mínimo de novos para o botão",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `Atual: ${value}`,
          jumpMinNewCountPromptTitle: "Mínimo de novos (botão)",
          jumpMinNewCountPromptBody:
            "Mostrar o botão de pular para o final somente após este número de novos itens.",
          jumpAnimateScrollTitle: "Animar pulo para o final",
          jumpAnimateScrollSubtitle:
            "Animar a rolagem ao pular para o final.",
        },
      },
        toolDetailOverrides: {
          title: "Substituições de detalhe de ferramenta",
          entrySubtitle: "Substituir ferramentas individuais",
          footer:
            "Substitua o nível de detalhe para ferramentas específicas. As substituições se aplicam ao nome canônico da ferramenta (V2) após a normalização legada.",
          expandedTitle: "Substituições de detalhe expandido",
          expandedFooter: "Substitua o nível de detalhe expandido para ferramentas específicas.",
        },
      permissions: {
        title: "Permissões",
        entrySubtitle: "Abrir configurações de permissões",
        footer:
          "Configure permissões padrão e como as mudanças se aplicam às sessões em execução.",
        promptSurfaceTitle: "Solicitações de permissão",
        promptSurfaceFooter:
          "Escolha onde os pedidos de aprovação aparecem durante uma sessão.",
        applyChangesFooter:
          "Escolha quando as mudanças de permissão entram em vigor para sessões em execução.",
        backendFooter:
          "Defina o modo de permissão padrão usado ao iniciar sessões com este backend.",
        defaultPermissionModeTitle: "Modo de permissão padrão",
        promptSurface: {
          composerTitle: "Perto do compositor (recomendado)",
          composerSubtitle: "Mostrar cartões ricos perto do input.",
          transcriptTitle: "Na transcrição",
          transcriptSubtitle:
            "Mostrar prompts de permissão dentro das mensagens de ferramenta.",
          bothTitle: "Ambos",
          bothSubtitle:
            "Mostrar perto do compositor e dentro da transcrição.",
        },
        applyTiming: {
          immediateTitle: "Aplicar imediatamente",
          nextPromptTitle: "Aplicar na próxima mensagem",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "Abrir configurações de sub-agente",
      },
      handoff: settingsSessionHandoffTranslationExtensions.pt,
      defaultPermissions: {
        title: "Permissões padrão",
        footer:
          "Aplica-se ao iniciar uma nova sessão. Perfis podem sobrescrever opcionalmente.",
        applyPermissionChangesTitle: "Aplicar mudanças de permissão",
        applyPermissionChangesImmediateSubtitle:
          "Aplicar imediatamente para sessões em execução (atualiza metadados da sessão).",
        applyPermissionChangesNextPromptSubtitle: "Aplicar somente na próxima mensagem.",
      },
          defaultStorage: {
              title: 'Armazenamento padrão da sessão',
              footer: 'Escolha se novas sessões começam como sessões sincronizadas do Happier ou sessões diretas apoiadas pelo provedor.',
              globalTitle: 'Padrão global',
              persistedSubtitle: 'Armazene novas sessões no Happier e sincronize-as entre dispositivos por padrão.',
              directSubtitle: 'Inicie sessões diretas vinculadas à máquina quando o provedor oferecer suporte.',
              globalSubtitle: ({ label }: { label: string }) => `Padrão global: ${label}`,
              useGlobalDefault: 'Usar padrão global',
              currently: ({ label }: { label: string }) => `Atual: ${label}`,
          },
      replayResume: {
        title: "Retomada por replay",
        footer:
          "Quando a retomada do fornecedor não estiver disponível, opcionalmente repita mensagens recentes da transcrição em uma nova sessão como contexto.",
        enabledTitle: "Ativar retomada por replay",
        enabledSubtitleOn:
          "Oferecer retomada por replay quando a retomada do fornecedor não estiver disponível.",
        enabledSubtitleOff: "Não oferecer retomada por replay.",
        strategyTitle: "Estratégia de replay",
        strategy: {
          recentTitle: "Mensagens recentes",
          recentSubtitle: "Usar apenas as mensagens mais recentes da transcrição.",
          summaryRecentTitle: "Resumo + recentes (experimental)",
          summaryRecentSubtitle:
            "Incluir um resumo curto e mensagens recentes (melhor esforço).",
        },
        summaryRunner: {
          title: "Gerador de resumos (sob demanda)",
          backendTitle: "Motor",
          backendPlaceholder: "claude (ex.)",
          searchBackendsPlaceholder: "Buscar backends…",
          modelTitle: "Modelo (LLM)",
          modelPlaceholder: "default (ex.)",
          searchModelsPlaceholder: "Buscar modelos…",
          notSet: "Não definido",
          customTitle: "Personalizado",
          customBackendIdSubtitle: "Informe um id de backend (ex.: claude).",
          customModelIdSubtitle: "Informe um id de modelo (ex.: default).",
        },
        recentMessagesTitle: "Mensagens recentes a incluir",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Limite de seed (caracteres)",
        maxSeedCharsPlaceholder: "50000",
      },
      toolDetailLevel: {
        titleOnlyTitle: "Somente título",
        titleOnlySubtitle:
          "Mostrar apenas o nome da ferramenta na linha do tempo (sem subtítulo, sem corpo).",
        compactTitle: "Compacto",
        compactSubtitle: "Mostrar o nome da ferramenta + um subtítulo curto na mesma linha (sem corpo).",
        summaryTitle: "Resumo",
        summarySubtitle: "Mostrar um resumo compacto e seguro na linha do tempo.",
        fullTitle: "Completo",
        fullSubtitle: "Mostrar detalhes completos em linha na linha do tempo.",
        defaultTitle: "Padrão",
        defaultSubtitle: "Usar o padrão global.",
          styleDefaultTitle: "Padrão (recomendado)",
          styleDefaultSubtitle: "Cartões: Resumo. Feed de ferramentas: Compacto.",
          expandedStyleDefaultTitle: "Padrão (recomendado)",
          expandedStyleDefaultSubtitle: "Cartões: Completo. Feed de ferramentas: Resumo.",
      },
      terminalConnect: {
        title: "Conexão do terminal",
        legacySecretExportTitle: "Exportação de segredo legado (compatibilidade)",
        legacySecretExportEnabledSubtitle:
          "Ativado: exporta seu segredo legado de conta para o terminal para que terminais antigos possam conectar. Não recomendado.",
        legacySecretExportDisabledSubtitle:
          "Desativado (recomendado): provisione terminais apenas com a chave de conteúdo (Terminal Connect V2).",
      },
  },
  windowsRemoteSessionLaunchMode: {
    hidden: "Oculto",
    shortHidden: "Oculto",
    hiddenSubtitle: "Inicia a sessão em segundo plano sem abrir uma janela de terminal.",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "Abre a sessão em uma janela dedicada do Windows Terminal.",
    console: "Console",
    shortConsole: "Console",
    consoleSubtitle: "Abre a sessão em uma janela padrão do console do Windows.",
  },
  settingsVoice: {
    // Voice settings screen
    modeTitle: "Voz",
    modeDescription:
      "Configure os recursos de voz. Você pode desativar a voz por completo, usar Happier Voice (requer assinatura) ou usar sua própria conta ElevenLabs.",
    mode: {
      off: "Desativado",
      offSubtitle: "Desativar todas as funcionalidades de voz",
      happier: "Happier Voice",
      happierSubtitle: "Usar Happier Voice (assinatura necessária)",
      local: "Voz OSS local",
      localSubtitle: "Usar endpoints STT/TTS locais compatíveis com OpenAI",
      byo: "Usar meu ElevenLabs",
      byoSubtitle: "Usar sua chave API e agente do ElevenLabs",
    },
    ui: {
      title: "Superficie de voz",
      footer: "Feed opcional na tela com eventos de voz (nao e escrito na sessao).",
      activityFeedEnabled: "Ativar feed de atividade de voz",
      activityFeedEnabledSubtitle: "Mostrar eventos recentes de voz na tela",
      activityFeedAutoExpandOnStart: "Expandir automaticamente ao iniciar",
      activityFeedAutoExpandOnStartSubtitle: "Expandir o feed automaticamente quando a voz iniciar",
      scopeTitle: "Escopo padrao da voz",
      scopeSubtitle: "Escolha se a voz e global (conta) ou por sessao por padrao.",
      scopeGlobal: "Global (conta)",
      scopeGlobalSubtitle: "A voz continua ativa enquanto voce navega",
      scopeSession: "Sessao",
      scopeSessionSubtitle: "A voz e controlada dentro da sessao onde foi iniciada",
      surfaceLocationTitle: "Local",
      surfaceLocationSubtitle: "Escolha onde a superfície de voz aparece.",
      surfaceLocation: {
        autoTitle: "Automático",
        autoSubtitle: "Escopo global no sidebar; escopo de sessão na sessão.",
        sidebarTitle: "Barra lateral",
        sidebarSubtitle: "Mostrar no sidebar.",
        sessionTitle: "Sessão",
        sessionSubtitle: "Mostrar acima do input na sessão.",
      },
      updates: {
        title: "Atualizações de sessão",
        footer: "Controle o que o assistente de voz recebe como contexto.",
        activeSessionTitle: "Sessão alvo ativa",
        activeSessionSubtitle: "O que enviar automaticamente para a sessão alvo.",
        otherSessionsTitle: "Outras sessões",
        otherSessionsSubtitle: "O que enviar automaticamente para sessões não alvo.",
        level: {
          noneTitle: "Nenhuma",
          noneSubtitle: "Não enviar atualizações automáticas.",
          activityTitle: "Apenas atividade",
          activitySubtitle: "Apenas contadores e timestamps.",
          summariesTitle: "Resumos",
          summariesSubtitle: "Resumos curtos (sem texto de mensagens).",
          snippetsTitle: "Trechos",
          snippetsSubtitle: "Trechos curtos de mensagens (risco de privacidade).",
        },
        snippetsMaxMessagesTitle: "Máx. mensagens",
        snippetsMaxMessagesSubtitle: "Limita quantas mensagens são incluídas por atualização.",
        includeUserMessagesInSnippetsTitle: "Incluir suas mensagens",
        includeUserMessagesInSnippetsSubtitle: "Se ativado, trechos podem incluir suas mensagens.",
        otherSessionsSnippetsModeTitle: "Trechos de outras sessões",
        otherSessionsSnippetsModeSubtitle: "Controla quando trechos de outras sessões são permitidos.",
        otherSessionsSnippetsMode: {
          neverTitle: "Nunca",
          neverSubtitle: "Desativar trechos para outras sessões.",
          onDemandTitle: "Sob demanda",
          onDemandSubtitle: "Permitir apenas quando o usuário pedir.",
          autoTitle: "Automático",
          autoSubtitle: "Permitir trechos automáticos (barulhento).",
        },
      },
    },
    byo: {
      title: "Usar meu ElevenLabs",
      agentReuseDialog: {
        title: "O agente do Happier já existe",
        messageWithId: ({ name, id }: { name: string; id: string }) =>
          `Encontramos um agente existente do ElevenLabs (“${name}”, id: ${id}).\n\nVocê quer atualizá-lo ou criar um novo?`,
        messageNoId: ({ name }: { name: string }) =>
          `Encontramos um agente existente do ElevenLabs (“${name}”).\n\nVocê quer atualizá-lo ou criar um novo?`,
      },
      configured:
        "Configurado. A utilização de voz será cobrada na sua conta ElevenLabs.",
      notConfigured:
        "Digite sua chave API e o ID do agente do ElevenLabs para usar voz sem assinatura.",
      createAccount: "Criar conta na ElevenLabs",
      createAccountSubtitle:
        "Cadastre-se (ou entre) antes de criar uma chave de API",
      openApiKeys: "Abrir chaves API do ElevenLabs",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "Como criar uma chave API",
      apiKeyHelpSubtitle:
        "Ajuda passo a passo para criar e copiar sua chave API do ElevenLabs",
      apiKeyHelpDialogTitle: "Criar uma chave API do ElevenLabs",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Criar agente Happier",
      autoprovCreateSubtitle:
        "Crie e configure um agente Happier na sua conta ElevenLabs usando sua chave API",
      autoprovUpdate: "Atualizar agente",
      autoprovUpdateSubtitle:
        "Atualize seu agente para o template mais recente do Happier",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `Agente criado: ${agentId}`,
      autoprovUpdated: "Agente atualizado",
      autoprovFailed: "Falha ao criar/atualizar agente. Tente novamente.",
      agentId: "ID do agente",
      agentIdSet: "Definido",
      agentIdNotSet: "Não definido",
      agentIdTitle: "ID do agente do ElevenLabs",
      agentIdDescription: "Digite o ID do agente no seu painel do ElevenLabs.",
      agentIdPlaceholder: "agent_...",
      apiKey: "Chave API",
      apiKeySet: "Definida",
      apiKeyNotSet: "Não definida",
      apiKeyTitle: "Chave API do ElevenLabs",
      apiKeyDescription:
        "Digite sua chave API do ElevenLabs. Ela é armazenada criptografada no dispositivo.",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "Pesquisar vozes",
      speakerBoostTitle: "Reforço do locutor",
      speakerBoostSubtitle: "Melhora a clareza e a presença (opcional).",
      speakerBoostAuto: "Automático",
      speakerBoostAutoSubtitle: "Usar o padrão do ElevenLabs.",
      speakerBoostOn: "Ativado",
      speakerBoostOnSubtitle: "Forçar ativar o reforço do locutor.",
      speakerBoostOff: "Desativado",
      speakerBoostOffSubtitle: "Forçar desativar o reforço do locutor.",
      voiceGroupTitle: "Voz",
      voiceGroupFooter:
        "Escolha como seu agente do ElevenLabs fala. As mudanças se aplicam quando você atualiza o agente.",
      provisioningGroupTitle: "Provisionamento do agente",
      provisioningGroupFooter:
        "Se você mudar voz/ajustes, toque em Atualizar agente para aplicar no ElevenLabs.",
      realtime: {
        call: {
          title: "Chamada",
          welcome: {
            title: "Mensagem de boas-vindas",
            subtitle: "Saudação opcional no início da chamada.",
            detail: {
              off: "Desativado",
              immediate: "Imediato",
              onFirstTurn: "No primeiro turno",
            },
            options: {
              offSubtitle: "Sem saudação.",
              immediateSubtitle:
                "Cumprimente assim que a chamada conectar.",
              onFirstTurnSubtitle:
                "Cumprimente no início da primeira resposta.",
            },
          },
        },
        voicePicker: {
          title: "Voz",
          subtitle: "Escolha a voz do ElevenLabs usada nas respostas.",
          missingApiKeyTitle: "Adicione a chave API para carregar vozes",
          loadingTitle: "Carregando vozes…",
          errorTitle: "Falha ao carregar vozes",
          errorSubtitle: "Verifique sua chave API e tente novamente.",
        },
        modelPicker: {
          title: "Modelo",
          subtitle:
            "Opcional: substituir o id do modelo TTS do ElevenLabs.",
          detailAuto: "Automático",
          options: {
            autoTitle: "Automático",
            autoSubtitle: "Use o modelo padrão do ElevenLabs.",
            multilingualV2Subtitle: "Padrão comum (multilíngue).",
            turboV2Subtitle:
              "Menor latência (se disponível no seu plano).",
            turboV25Subtitle: "Turbo 2.5 (se disponível).",
            customTitle: "Personalizado…",
            customSubtitle: "Digite um id de modelo.",
          },
          prompt: {
            title: "Id do modelo",
            body: "Digite um id de modelo do ElevenLabs ou deixe em branco para usar o padrão.",
          },
        },
        voiceSettings: {
          default: "Padrão",
          stability: {
            title: "Estabilidade",
            subtitle: "0–1. Deixe em branco para o padrão.",
            promptTitle: "Estabilidade (0–1)",
            promptBody:
              "Digite um número entre 0 e 1. Deixe em branco para usar o padrão.",
            invalid: "Digite um número entre 0 e 1.",
          },
          similarityBoost: {
            title: "Aumento de similaridade",
            subtitle: "0–1. Deixe em branco para o padrão.",
            promptTitle: "Aumento de similaridade (0–1)",
            promptBody:
              "Digite um número entre 0 e 1. Deixe em branco para usar o padrão.",
            invalid: "Digite um número entre 0 e 1.",
          },
          style: {
            title: "Estilo",
            subtitle: "0–1. Deixe em branco para o padrão.",
            promptTitle: "Estilo (0–1)",
            promptBody:
              "Digite um número entre 0 e 1. Deixe em branco para usar o padrão.",
            invalid: "Digite um número entre 0 e 1.",
          },
          speed: {
            title: "Velocidade",
            subtitle: "0.5–2. Deixe em branco para o padrão.",
            promptTitle: "Velocidade (0.5–2)",
            promptBody:
              "Digite um número entre 0.5 e 2. Deixe em branco para usar o padrão.",
            invalid: "Digite um número entre 0.5 e 2.",
          },
        },
        getStartedTitle: "Começar",
      },
      apiKeySaveFailed: "Falha ao salvar a chave API. Tente novamente.",
      disconnect: "Desconectar",
      disconnectSubtitle:
        "Remover as credenciais do ElevenLabs salvas neste dispositivo",
      disconnectTitle: "Desconectar ElevenLabs",
      disconnectDescription:
        "Isso removerá sua chave API e o ID do agente do ElevenLabs salvos neste dispositivo.",
      disconnectConfirm: "Desconectar",
    },
    local: {
      title: "Voz OSS local",
      footer:
        "Configure endpoints compatíveis com OpenAI para STT (speech-to-text) e TTS (text-to-speech).",
      localhostWarning:
        'Nota: "localhost" e "127.0.0.1" normalmente não funcionam em celulares. Use o IP LAN do computador ou um túnel.',
      notSet: "Não definido",
      apiKeySet: "Definida",
      apiKeyNotSet: "Não definida",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "Opcional",
      apiKeySaveFailed: "Falha ao salvar a chave API. Tente novamente.",
      googleCloudTts: {
        provider: {
          title: "Google Cloud: Text-to-Speech",
          subtitle:
            "Use sua chave API do Google Cloud para sintetizar áudio.",
          detail: "Google Cloud (GCP)",
        },
        common: {
          default: "Padrão",
        },
        apiKey: {
          title: "Chave API do Google Cloud",
          promptTitle: "Chave API do Google Cloud",
          promptBody:
            "Crie uma chave API com a Text-to-Speech API habilitada. Opcional: restrinja a chave a este app (iOS bundle id / Android package+SHA1).",
        },
        androidCertSha1: {
          title: "SHA-1 do certificado Android (opcional)",
          subtitle:
            "Só é necessário se você restringir a chave API ao seu app Android.",
          promptTitle: "SHA-1 do certificado Android",
          promptBody:
            "Exemplo: AA:BB:CC:... (do seu certificado de assinatura).",
        },
        language: {
          title: "Idioma",
          subtitle: "Filtro opcional para a lista de vozes.",
          searchPlaceholder: "Buscar idiomas",
          allTitle: "Todos",
          allSubtitle: "Mostrar vozes para todos os idiomas.",
        },
        speakingRate: {
          title: "Taxa de fala",
          subtitle: "0.25–4.0 (em branco = padrão da voz).",
          promptTitle: "Taxa de fala",
          promptBody:
            "Defina a taxa de fala (0.25–4.0). Deixe em branco para usar o padrão.",
        },
        pitch: {
          title: "Tom",
          subtitle: "-20–20 (em branco = padrão da voz).",
          promptTitle: "Tom",
          promptBody:
            "Defina o tom (-20–20). Deixe em branco para usar o padrão.",
        },
        voice: {
          title: "Voz",
          subtitle: "Selecione uma voz do Google Cloud.",
          searchPlaceholder: "Buscar vozes",
          selectPrompt: "Selecionar…",
          setApiKeyPrompt: "Definir chave API",
          loadingTitle: "Carregando vozes…",
        },
        format: {
          title: "Formato",
          subtitle: "MP3 é menor; WAV não é comprimido.",
          mp3Subtitle: "Saída menor, ampla compatibilidade.",
          wavSubtitle: "Saída maior, sem compressão.",
        },
        alerts: {
          missingApiKey: "Falta a chave API do Google Cloud.",
          missingVoice: "Selecione primeiro uma voz do Google Cloud.",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Google Gemini (áudio)",
          subtitle: "Transcreva áudio usando modelos multimodais do Gemini.",
          detail: "Gemini do Google",
        },
        apiKey: {
          title: "Chave de API do Gemini",
          promptTitle: "Chave de API do Gemini",
          promptBody: "Crie uma chave de API no Google AI Studio (Gemini API).",
        },
        model: {
          title: "Modelo do Gemini",
          subtitle: "Escolha qual modelo do Gemini usar para transcrição.",
          searchPlaceholder: "Buscar modelos",
          customTitle: "ID de modelo personalizado…",
          customSubtitle: "Digite um nome de modelo manualmente.",
          loadingModelsTitle: "Carregando modelos…",
          promptTitle: "Modelo do Gemini",
          promptBody: "Exemplo: gemini-2.5-flash",
        },
        language: {
          title: "Idioma",
          subtitle: "Dica opcional para melhorar a precisão da transcrição.",
          searchPlaceholder: "Buscar idiomas",
          autoTitle: "Automático",
          autoSubtitle: "Não fornecer uma dica de idioma.",
        },
      },
      kokoro: {
        common: {
          default: "Padrão",
          none: "N/D",
        },
        runtime: {
          title: "Runtime do Kokoro",
          unsupportedSubtitle: "Kokoro não é compatível com este dispositivo/runtime.",
          unavailableDetail: "Indisponível",
        },
        manifest: {
          title: "Manifesto do pacote de modelo",
          subtitle:
            "Por padrão usa pacotes de modelo do Happier (substitua via EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS).",
          detailResolved: "Resolvido",
          detailMissing: "Ausente",
        },
        assetPack: {
          title: "Pacote de modelo Kokoro",
          subtitleNative: "Selecione o pacote de recursos para o Kokoro.",
          subtitleWeb: "Selecione a configuração de runtime para o Kokoro.",
        },
        model: {
          title: "Modelo Kokoro",
          subtitleNative:
            "Baixe os arquivos necessários para habilitar a síntese no dispositivo.",
          subtitleWeb: "Baixa sob demanda. Usa WebAssembly (beta).",
        },
        modelStatus: {
          downloading: "Baixando…",
          downloadingPrefix: "Baixando",
          ready: "Pronto",
          error: "Erro",
          notDownloaded: "Não baixado",
        },
        removeAssets: {
          title: "Remover recursos do Kokoro",
          subtitle: "Libere armazenamento removendo os arquivos do Kokoro baixados.",
          detailRemove: "Remover",
          confirmTitle: "Remover recursos do Kokoro?",
          confirmBody: "Isso remove os arquivos do Kokoro baixados deste dispositivo.",
          confirmButton: "Remover",
        },
        updates: {
          title: "Verificar atualizações do modelo",
          subtitle: "Verifique manualmente se há um pacote de modelo mais novo.",
          check: "Verificar",
          upToDate: "Atualizado",
          updateAvailable: "Atualização disponível",
        },
        alerts: {
          runtimeUnsupported: {
            body: "Kokoro não é compatível com este dispositivo/runtime.",
          },
          missingManifest: {
            title: "URL do manifesto ausente",
            body: "Não foi possível resolver a URL do manifesto do pacote de modelo. Verifique EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (ou variáveis de ambiente antigas do Kokoro).",
          },
          notInstalledTitle: "Não instalado",
          notInstalledBody:
            "Baixe o pacote de modelo primeiro para habilitar verificações de atualização.",
          upToDateTitle: "Atualizado",
          upToDateBody:
            "Nenhuma atualização está disponível para este pacote de modelo.",
          updateAvailableTitle: "Atualização disponível",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Baixar a versão mais recente deste pacote de modelo agora?${remoteBuild ? `\n\nBuild remoto: ${remoteBuild}` : ""}`,
          updatedTitle: "Atualizado",
          updatedBody: "Pacote de modelo atualizado com sucesso.",
          updateFailedTitle: "Falha na atualização",
          updateFailedBody: ({ message }: { message: string }) =>
            `Não foi possível atualizar este pacote de modelo.\n\n${message}`,
        },
        voice: {
          title: "Voz",
          subtitleNative: "Selecione a voz do Kokoro.",
          searchPlaceholder: "Pesquisar vozes",
          titleWeb: "Voz do Kokoro",
          subtitleWeb: "Escolha a voz no dispositivo usada nas respostas.",
          loadingVoicesTitle: "Carregando vozes…",
        },
        speed: {
          title: "Velocidade",
          subtitle: "Ajuste a velocidade de fala (0,5–2,0).",
        },
        web: {
          warmingUp: "Preparando…",
          clearCache: {
            confirmTitle: "Limpar cache do Kokoro?",
            confirmBody:
              "Isso remove do dispositivo os arquivos baixados do modelo e das vozes do Kokoro.",
            confirmButton: "Limpar",
          },
          cacheDetail: {
            modelFiles: "Arquivos do modelo",
            voices: "Vozes",
          },
          cache: {
            title: "Cache do Kokoro",
            subtitle: "Gerencie os arquivos do Kokoro baixados neste dispositivo.",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "Pacote de modelo",
          subtitle: "Id do pacote de modelo STT em streaming.",
        },
        modelFiles: {
          title: "Arquivos do modelo",
          subtitle:
            "Baixe os arquivos necessários para habilitar STT em streaming no dispositivo.",
        },
        removeModelFiles: {
          title: "Remover arquivos do modelo",
          subtitle: "Libere espaço removendo os arquivos do modelo baixados.",
          confirmTitle: "Remover arquivos do modelo?",
          confirmBody:
            "Isso removerá o pacote de modelo STT baixado deste dispositivo.",
        },
        status: {
          installed: "Instalado",
          installedWithBuild: ({ build }: { build: string }) =>
            `Instalado • ${build}`,
          notInstalled: "Não instalado",
        },
        language: {
          title: "Idioma",
          subtitle: "Tag de idioma BCP-47 opcional.",
          promptTitle: "Idioma",
          promptBody: "Digite uma tag de idioma BCP-47 (ex.: en, en-US).",
        },
        alerts: {
          downloadFailedTitle: "Falha no download",
          downloadFailedBody: ({ message }: { message: string }) =>
            `Não foi possível baixar este pacote de modelo.\n\n${message}`,
          notInstalledTitle: "Não instalado",
          notInstalledBody:
            "Baixe primeiro o pacote de modelo para habilitar a verificação de atualizações.",
          upToDateBody:
            "Não há atualizações disponíveis para este pacote de modelo.",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Baixar agora a versão mais recente deste pacote de modelo?${remoteBuild ? `\n\nBuild remota: ${remoteBuild}` : ""}`,
          updatedTitle: "Atualizado",
          updatedBody: "Pacote de modelo atualizado com sucesso.",
          updateFailedTitle: "Falha ao atualizar",
          updateFailedBody: ({ message }: { message: string }) =>
            `Não foi possível atualizar este pacote de modelo.\n\n${message}`,
        },
      },
      conversationMode: "Modo de conversa",
      conversationModeSubtitle:
        "Direto para a sessão ou mediador com commit explícito",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "Use o agente de voz (commit explícito, controle de ferramentas).",
          directTitle: "Sessão direta",
          directSubtitle: "Fale diretamente na sessão ativa.",
        },
        handsFree: {
          title: "Mãos livres",
          enableTitle: "Ativar mãos livres",
          silenceTitle: "Tempo de silêncio (ms)",
          minSpeechTitle: "Fala mínima (ms)",
        },
        customBackendIdSubtitle: "Digite um id de backend personalizado.",
        searchBackendsPlaceholder: "Buscar backends",
        searchModelsPlaceholder: "Buscar modelos",
        machineAutoSubtitle:
          "Seleciona automaticamente uma máquina com base no uso recente.",
        rootSessionPolicy: {
          title: "Política da sessão raiz",
          fallbackSubtitle: "Escolha uma política.",
          singleTitle: "Única",
          singleSubtitle: "Criar uma nova sessão raiz a cada vez.",
          keepWarmTitle: "Manter aquecida",
          keepWarmSubtitle:
            "Reutilizar uma sessão raiz aquecida quando possível.",
          maxWarmRootsTitle: "Máx. raízes aquecidas",
          maxWarmRootsSubtitle:
            "Limita quantas sessões raiz aquecidas podem ser mantidas.",
        },
        persistence: {
          title: "Persistência da transcrição",
          ephemeralTitle: "Efêmera",
          ephemeralSubtitle:
            "Não salvar o estado do agente de voz entre sessões.",
          persistentTitle: "Persistente",
          persistentSubtitle:
            "Salvar o estado do agente de voz entre sessões (reutilizável).",
        },
        resetVoiceAgent: {
          title: "Redefinir estado do agente de voz",
          subtitle: "Limpa o estado persistente do agente de voz.",
          confirmBody:
            "Isso limpará o estado salvo do agente de voz. Não é possível desfazer.",
        },
        agentSettings: {
          title: "Agente de voz",
        },
        backend: {
          daemonSubtitle:
            "Usa o backend do Happier e suporta retomada do provedor.",
          openAiSubtitle:
            "Conectar a endpoints HTTP compatíveis com OpenAI.",
        },
        agentMachine: {
          title: "Máquina do agente",
          fallbackSubtitle: "Escolha onde executar o agente de voz.",
          stayInVoiceHomeTitle: "Ficar no voice home",
          stayInVoiceHomeEnabledSubtitle:
            "Manter o agente na máquina de voice home.",
          stayInVoiceHomeDisabledSubtitle:
            "Permitir que o agente siga a máquina da sessão.",
          allowTeleportTitle: "Permitir teleporte",
          teleportEnabledSubtitle:
            "Permite mover o agente para outra máquina quando necessário.",
          teleportDisabledSubtitle: "Teleporte desativado.",
        },
        machineRecovery: {
          switchTitle: "Máquina de voz indisponível",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `A máquina de voz atual (${currentMachine}) está indisponível.\n\nMudar a voz para ${nextMachine}?`,
          switchAction: "Mudar máquina",
          replayTitle: "Trazer a conversa?",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `Você pode começar do zero em ${nextMachine} ou mudar e reproduzir o contexto de voz recente da máquina anterior.`,
          replayAction: "Mudar e reproduzir o contexto de voz recente",
          startFreshAction: "Começar do zero",
        },
        agentSource: {
          followSessionTitle: "Seguir sessão",
          followSessionSubtitle:
            "Usar o backend e a configuração da sessão.",
          fixedAgentTitle: "Agente fixo",
          fixedAgentSubtitle:
            "Sempre usar um backend de agente específico.",
        },
        permissionPolicy: {
          readOnlySubtitle:
            "Pode ver o contexto, mas não pode executar ferramentas.",
          noToolsSubtitle:
            "Deve evitar pedidos de ferramentas e nunca executá-las.",
        },
        chatModelSource: {
          sessionSubtitle:
            "Usar a configuração do modelo da sessão para o chat do agente.",
          customSubtitle:
            "Substituir o id do modelo de chat do agente de voz.",
        },
        chatModelId: {
          title: "Id do modelo de chat do agente de voz",
          subtitle:
            "Usado quando a origem do modelo de chat está definida como Modelo personalizado.",
        },
        commitModelSource: {
          chatSubtitle: "Usar o modelo de chat do agente para commits.",
          sessionSubtitle:
            "Usar a configuração do modelo da sessão para commits.",
          customSubtitle:
            "Substituir o id do modelo de commit do agente de voz.",
        },
        commitModelId: {
          title: "Id do modelo de commit do agente de voz",
          subtitle:
            "Usado quando a origem do modelo de commit está definida como Modelo personalizado.",
        },
        commitIsolation: {
          title: "Isolamento de commits",
          subtitle:
            "Use uma sessão do provedor separada para gerar commits (avançado).",
        },
        resumability: {
          modeTitle: "Retomada",
          replayTitle: "Reprodução",
          replaySubtitle: "Retome reproduzindo mensagens recentes.",
          providerResumeTitle: "Retomada do provedor",
          providerResumeSubtitle:
            "Retome usando o estado da sessão do provedor (quando suportado).",
          disabledVoiceAgent: "Requer Happier Voice Agent.",
          disabledDaemonBackend: "Requer backend Daemon.",
          disabledAgentNoProviderResume:
            "O agente selecionado não suporta retomada do provedor.",
        },
        providerResumeFallback: {
          title: "Fallback para reprodução",
          subtitle:
            "Se a retomada do provedor falhar, volte para reprodução.",
        },
        replayRecentMessagesPromptBody:
          "Quantas mensagens recentes incluir (1–100).",
        prewarm: {
          title: "Pré-aquecer ao conectar",
          subtitle: "Iniciar o agente de voz imediatamente ao conectar.",
        },
        welcome: {
          title: "Mensagem de boas-vindas",
          offTitle: "Desativado",
          offSubtitle: "Não enviar mensagem de boas-vindas.",
          immediateTitle: "Imediato",
          immediateSubtitle:
            "Enviar boas-vindas assim que o agente iniciar.",
          onFirstTurnTitle: "No primeiro turno",
          onFirstTurnSubtitle:
            "Enviar boas-vindas quando você falar pela primeira vez.",
        },
        verbosity: {
          shortSubtitle: "Mantenha as respostas do agente curtas.",
          balancedSubtitle:
            "Permita um pouco mais de detalhe quando necessário.",
        },
        streaming: {
          title: "Transmissão",
          enableTitle: "Ativar streaming",
          enableSubtitle:
            "Transmita texto parcial do agente conforme é gerado (usado para fala em streaming).",
          enableTtsTitle: "Ativar streaming de TTS",
          enableTtsSubtitle:
            "Fale a resposta enquanto ela está em streaming (requer streaming).",
          ttsChunkCharsTitle: "Caracteres do chunk de TTS",
          ttsChunkCharsPromptBody:
            "Quantos caracteres armazenar antes de solicitar o próximo chunk de TTS (32–2000).",
        },
        network: {
          title: "Rede",
          timeoutTitle: "Tempo limite de rede (ms)",
          timeoutPromptBody:
            "Tempo limite para requisições aos seus endpoints (1000–60000).",
        },
      },
      mediatorBackend: "Backend do mediador",
      mediatorBackendSubtitle:
        "Daemon (usa o backend do Happier) ou OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Daemon (serviço)",
      mediatorBackendOpenAi: "HTTP compatível com OpenAI",
      mediatorAgentSource: "Fonte do agente do mediador",
      mediatorAgentSourceSubtitle:
        "Usar o backend da sessão ou forçar um agente específico",
      mediatorAgentSourceSession: "Backend da sessão",
      mediatorAgentSourceAgent: "Agente específico",
      mediatorAgentId: "Agente do mediador",
      mediatorAgentIdSubtitle:
        "Qual backend de agente usar no mediador (quando não usa a sessão)",
      mediatorPermissionPolicy: "Permissões do mediador",
      mediatorPermissionPolicySubtitle:
        "Restringe o uso de ferramentas durante a mediação",
      mediatorPermissionReadOnly: "Somente leitura",
      mediatorPermissionNoTools: "Sem ferramentas",
      mediatorVerbosity: "Verbosidade do mediador",
      mediatorVerbositySubtitle: "Quão detalhado o mediador deve ser",
      mediatorVerbosityShort: "Curto",
      mediatorVerbosityBalanced: "Equilibrado",
      mediatorIdleTtl: "TTL de inatividade do mediador",
      mediatorIdleTtlSubtitle:
        "Parar automaticamente após inatividade (60–3600s)",
      mediatorIdleTtlTitle: "TTL de inatividade do mediador (segundos)",
      mediatorIdleTtlDescription: "Digite um número entre 60 e 3600.",
      mediatorIdleTtlInvalid: "Digite um número entre 60 e 3600.",
      mediatorChatModelSource: "Origem do modelo (chat)",
      mediatorChatModelSourceSubtitle:
        "Usar o modelo da sessão ou um modelo rápido personalizado",
      mediatorChatModelSourceSession: "Modelo da sessão",
      mediatorChatModelSourceCustom: "Modelo personalizado",
      mediatorCommitModelSource: "Origem do modelo (commit)",
      mediatorCommitModelSourceSubtitle:
        "Usar o modelo do chat, da sessão ou um modelo personalizado",
      mediatorCommitModelSourceChat: "Modelo do chat",
      mediatorCommitModelSourceSession: "Modelo da sessão",
      mediatorCommitModelSourceCustom: "Modelo personalizado",
      chatBaseUrl: "Base URL Chat",
      chatBaseUrlTitle: "Base URL Chat",
      chatBaseUrlDescription:
        "Base URL para o endpoint de chat completion compatível com OpenAI (normalmente termina com /v1).",
      chatApiKey: "Chave API Chat",
      chatApiKeyTitle: "Chave API Chat",
      chatApiKeyDescription:
        "Chave API opcional para o servidor de chat (armazenada criptografada). Deixe em branco para limpar.",
      chatModel: "Modelo de chat",
      chatModelSubtitle: "Modelo rápido usado na conversa de voz",
      chatModelTitle: "Modelo de chat",
      chatModelDescription:
        "Nome do modelo a enviar para o servidor de chat (campo compatível com OpenAI).",
      modelCustomTitle: "Personalizado…",
      modelCustomSubtitle: "Digite um ID de modelo",
      commitModel: "Modelo de commit",
      commitModelSubtitle: "Modelo usado para gerar a instrução final",
      commitModelTitle: "Modelo de commit",
      commitModelDescription: "Nome do modelo ao gerar a mensagem final.",
      chatTemperature: "Temperatura do chat",
      chatTemperatureSubtitle: "Controla aleatoriedade (0–2)",
      chatTemperatureTitle: "Temperatura do chat",
      chatTemperatureDescription: "Digite um número entre 0 e 2.",
      chatTemperatureInvalid: "Digite um número entre 0 e 2.",
      chatMaxTokens: "Máx. tokens (chat)",
      chatMaxTokensSubtitle: "Limita o tamanho da resposta (vazio = padrão)",
      chatMaxTokensTitle: "Máx. tokens (chat)",
      chatMaxTokensDescription:
        "Digite um inteiro positivo ou deixe em branco para o padrão.",
      chatMaxTokensPlaceholder: "Vazio = padrão",
      chatMaxTokensUnlimited: "Padrão",
      chatMaxTokensInvalid: "Digite um número positivo ou deixe em branco.",
      sttBaseUrl: "Base URL STT",
      sttBaseUrlTitle: "Base URL STT",
      sttBaseUrlDescription:
        "Base URL para o endpoint de transcrição compatível com OpenAI (normalmente termina com /v1).",
      sttApiKey: "Chave API STT",
      sttApiKeyTitle: "Chave API STT",
      sttApiKeyDescription:
        "Chave API opcional para o servidor STT (armazenada criptografada). Deixe em branco para limpar.",
      sttModel: "Modelo STT",
      sttModelSubtitle:
        "Nome do modelo enviado nas solicitações de transcrição",
      sttModelTitle: "Modelo STT",
      sttModelDescription:
        "Nome do modelo a enviar para o servidor STT (campo compatível com OpenAI).",
      deviceStt: "STT do dispositivo (experimental)",
      deviceSttSubtitle:
        "Usar reconhecimento de fala no dispositivo em vez de um endpoint compatível com OpenAI",
      sttProvider: "Provedor STT",
      neuralStt: {
        title: "STT no dispositivo",
        webNotAvailableSubtitle:
          "Indisponível na web. Use STT do dispositivo, compatível com OpenAI ou Gemini STT.",
      },
      ttsBaseUrl: "Base URL TTS",
      ttsBaseUrlTitle: "Base URL TTS",
      ttsBaseUrlDescription:
        "Base URL para o endpoint de fala compatível com OpenAI (normalmente termina com /v1).",
      ttsApiKey: "Chave API TTS",
      ttsApiKeyTitle: "Chave API TTS",
      ttsApiKeyDescription:
        "Chave API opcional para o servidor TTS (armazenada criptografada). Deixe em branco para limpar.",
      ttsModel: "Modelo TTS",
      ttsModelSubtitle: "Nome do modelo enviado nas solicitações de fala",
      ttsModelTitle: "Modelo TTS",
      ttsModelDescription:
        "Nome do modelo a enviar para o servidor TTS (campo compatível com OpenAI).",
      ttsVoice: "Voz TTS",
      ttsVoiceSubtitle: "Nome/ID da voz enviado nas solicitações de fala",
      ttsVoiceTitle: "Voz TTS",
      ttsVoiceDescription:
        "Nome/ID da voz a enviar para o servidor TTS (campo compatível com OpenAI).",
      ttsFormat: "Formato TTS",
      ttsFormatSubtitle: "Formato de áudio retornado pelo TTS",
      ttsFormatOptions: {
        mp3Subtitle: "Saída menor, amplamente compatível.",
        wavSubtitle: "Saída maior, sem compressão.",
      },
      testTts: "Testar TTS",
      testTtsSubtitle:
        "Reproduza uma amostra curta usando o TTS local configurado (TTS do dispositivo ou endpoint)",
      testTtsSample: "Olá do Happier. Este é um teste do seu TTS local.",
      testTtsMissingBaseUrl: "Defina uma URL base de TTS primeiro.",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "TTS do dispositivo (experimental)",
      deviceTtsSubtitle:
        "Usar síntese de fala no dispositivo em vez de um endpoint compatível com OpenAI",
      ttsProvider: "Provedor de TTS",
      ttsProviderSubtitle:
        "Escolha TTS do dispositivo, um endpoint compatível com OpenAI ou Kokoro (web/desktop)",

      autoSpeak: "Auto-reproduzir respostas",
      autoSpeakSubtitle:
        "Reproduz a próxima resposta do assistente após enviar a mensagem de voz",
      bargeIn: "Interrupção",
      speaking: "Falando…",
    },
    privacy: {
      title: "Privacidade",
      footer: "Os provedores de voz recebem o contexto de sessão selecionado.",
      shareSessionSummary: "Compartilhar resumo da sessão",
      shareSessionSummarySubtitle:
        "Inclui o resumo da sessão no contexto de voz",
      shareRecentMessages: "Compartilhar mensagens recentes",
      shareRecentMessagesSubtitle:
        "Inclui mensagens recentes no contexto de voz",
      recentMessagesCount: "Quantidade de mensagens recentes",
      recentMessagesCountSubtitle: "Quantas mensagens recentes incluir (0–50)",
      recentMessagesCountTitle: "Quantidade de mensagens recentes",
      recentMessagesCountDescription: "Digite um número entre 0 e 50.",
      recentMessagesCountInvalid: "Digite um número entre 0 e 50.",
      shareToolNames: "Compartilhar nomes de ferramentas",
      shareToolNamesSubtitle: "Inclui nomes/descrições de ferramentas no contexto de voz",
      shareDeviceInventory: "Compartilhar inventário do dispositivo",
      shareDeviceInventorySubtitle:
        "Permitir que a voz liste workspaces, máquinas e servidores recentes",
      shareToolArgs: "Compartilhar argumentos de ferramentas",
      shareToolArgsSubtitle: "Inclui argumentos de ferramentas (pode incluir caminhos ou segredos)",
      sharePermissionRequests: "Compartilhar solicitações de permissão",
      sharePermissionRequestsSubtitle: "Encaminha solicitações de permissão para a voz",
      shareFilePaths: "Compartilhar caminhos locais",
      shareFilePathsSubtitle:
        "Inclui caminhos locais no contexto de voz (não recomendado)",
    },
    languageTitle: "Idioma",
    languageDescription:
      "Escolha seu idioma preferido para interações com o assistente de voz. Esta configuração sincroniza em todos os seus dispositivos.",
    preferredLanguage: "Idioma preferido",
    preferredLanguageSubtitle:
      "Idioma usado para respostas do assistente de voz",
    language: {
      searchPlaceholder: "Buscar idiomas...",
      title: "Idiomas",
      footer: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "idioma", plural: "idiomas" })} disponíveis`,
      autoDetect: "Detectar automaticamente",
      autoDetectSubtitle: "Deixe o reconhecedor decidir (recomendado).",
      customTitle: "Personalizado…",
      customSubtitle: "Digite uma tag de idioma BCP-47.",
      options: {
        english: "Inglês",
        englishUs: "Inglês (EUA)",
        french: "Francês",
        spanish: "Espanhol",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Informações da conta",
    status: "Estado",
    statusActive: "Ativo",
    statusNotAuthenticated: "Não autenticado",
    anonymousId: "ID anônimo",
    publicId: "ID público",
    notAvailable: "Não disponível",
    linkNewDevice: "Escanear QR para vincular novo dispositivo",
    linkNewDeviceSubtitle: "Escaneie o código QR exibido no seu novo dispositivo",
    profile: "Perfil",
    name: "Nome",
    github: "GitHub",
    showGitHubOnProfile: "Mostrar no perfil",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `Mostrar ${provider} no perfil`,
    tapToDisconnect: "Toque para desconectar",
    server: "Servidor",
    backup: "Cópia de segurança",
    backupDescription:
      "Sua chave secreta é a única forma de recuperar sua conta. Salve-a em um local seguro como um gerenciador de senhas.",
    secretKey: "Chave secreta",
    tapToReveal: "Toque para revelar",
    tapToHide: "Toque para ocultar",
    secretKeyLabel: "CHAVE SECRETA (TOQUE PARA COPIAR)",
    secretKeyCopied:
      "Chave secreta copiada para a área de transferência. Guarde-a em um local seguro!",
    secretKeyCopyFailed: "Falha ao copiar chave secreta",
    privacy: "Privacidade",
    privacyDescription:
      "Ajude a melhorar o aplicativo compartilhando dados de uso anônimos. Nenhuma informação pessoal é coletada.",
    analytics: "Análises",
    analyticsDisabled: "Nenhum dado é compartilhado",
    analyticsEnabled: "Dados de uso anônimos são compartilhados",
    crashReports: "Relatórios de falhas",
    crashReportsDisabled: "Nenhum relatório de falhas é compartilhado",
    crashReportsEnabled: "Relatórios de falhas são compartilhados",
    dangerZone: "Zona perigosa",
    logout: "Sair",
    logoutSubtitle: "Sair e limpar dados locais",
    logoutConfirm:
      "Tem certeza de que quer sair? Certifique-se de ter feito backup da sua chave secreta!",
    encryptionUpdateFailed: "Falha ao atualizar a configuração de criptografia",
    secretKeyMissing: "Chave secreta indisponível. Restaure sua conta primeiro.",
    restoreRequiredTitle: "Restauração necessária",
    restoreRequiredBody:
      "Esta conta tem histórico criptografado. Para reativar a criptografia neste dispositivo, restaure sua chave secreta. Se você perdeu a chave, pode redefinir a conta para começar do zero (o histórico criptografado antigo não pode ser recuperado).",
  },

  settingsLanguage: {
    // Language settings screen
    title: "Idioma",
    description:
      "Escolher o idioma preferido para a interface do aplicativo. Isso vai ser sincronizado em todos os seus dispositivos.",
    currentLanguage: "Idioma atual",
    automatic: "Automático",
    automaticSubtitle: "Detectar das configurações do dispositivo",
    needsRestart: "Idioma alterado",
    needsRestartMessage:
      "O aplicativo precisa ser reiniciado para aplicar a nova configuração de idioma.",
    restartNow: "Reiniciar agora",
  },

  connectButton: {
    authenticate: "Autenticar terminal",
    authenticateWithUrlPaste: "Autenticar terminal com colagem de URL",
    pasteAuthUrl: "Cole a URL de autenticação do seu terminal",
  },

  updateBanner: {
    updateAvailable: "Atualização disponível",
    pressToApply: "Pressione para aplicar a atualização",
    whatsNew: "Novidades",
    seeLatest: "Veja as atualizações e melhorias mais recentes",
    nativeUpdateAvailable: "Atualização do aplicativo disponível",
    tapToUpdateAppStore: "Toque para atualizar na App Store",
    tapToUpdatePlayStore: "Toque para atualizar na Play Store",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `Versão ${version}`,
    noEntriesAvailable: "Nenhuma entrada de changelog disponível.",
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Navegador web necessário",
    webBrowserRequiredDescription:
      "Links de conexão de terminal só podem ser abertos em um navegador web por questões de segurança. Use o leitor de código QR ou abra este link num computador.",
    processingConnection: "Processando conexão...",
    invalidConnectionLink: "Link de conexão inválido",
    invalidConnectionLinkDescription:
      "O link de conexão está ausente ou inválido. Verifique a URL e tente novamente.",
    connectTerminal: "Conectar terminal",
    terminalRequestDescription:
      "Um terminal está solicitando conexão à sua conta Happier Coder. Isso permitirá que o terminal envie e receba mensagens com segurança.",
    connectionDetails: "Detalhes da conexão",
    publicKey: "Chave pública",
    encryption: "Criptografia",
    endToEndEncrypted: "Criptografia ponta a ponta",
    acceptConnection: "Aceitar conexão",
    connecting: "Conectando...",
    reject: "Rejeitar",
    security: "Segurança",
    securityFooter:
      "Este link de conexão foi processado com segurança no seu navegador e nunca foi enviado para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.",
    securityFooterDevice:
      "Esta conexão foi processada com segurança no seu dispositivo e nunca foi enviada para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.",
    clientSideProcessing: "Processamento do lado cliente",
    linkProcessedLocally: "Link processado localmente no navegador",
    linkProcessedOnDevice: "Link processado localmente no dispositivo",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `Esta conexão é para ${serverUrl}. Trocar de servidor e continuar?`,
  },

  terminalEmbedded: {
    dockMenuA11y: "Ancorar terminal",
    settings: {
      locationTitle: "Local do terminal incorporado",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "Enter ↵",
    },
    location: {
      sidebar: "Barra lateral",
      details: "Painel de detalhes",
      bottom: "Painel inferior",
    },
    errors: {
      missingMachineTarget: "Esta sessão está sem um destino de máquina.",
      rpcTargetUnavailable: "O RPC da máquina não está disponível para esta máquina.",
      machineUnreachable: "A máquina não está acessível.",
      disabled: "O suporte a terminal está desativado na configuração do daemon. Ative-o e reinicie o daemon.",
      notFound: "Sessão de terminal não encontrada. Tente reiniciar.",
      cwdDenied: "O daemon não tem permissão para usar este diretório de trabalho.",
      spawnFailed: "Falha ao iniciar o processo do terminal.",
      invalidRequest: "Solicitação de terminal inválida.",
      busy: "O terminal está ocupado. Tente novamente.",
    },
  },

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Autenticar terminal",
    pasteUrlFromTerminal: "Cole a URL de autenticação do seu terminal",
    deviceLinkedSuccessfully: "Dispositivo vinculado com sucesso",
    terminalConnectedSuccessfully: "Terminal conectado com sucesso",
    terminalAlreadyConnected: "Conexão Já Utilizada",
    terminalConnectionAlreadyUsedDescription: "Este link de conexão já foi usado por outro dispositivo. Para conectar vários dispositivos ao mesmo terminal, saia e faça login na mesma conta em todos os dispositivos.",
    authRequestExpired: "Conexão Expirada",
    authRequestExpiredDescription: "Este link de conexão expirou. Por favor, gere um novo link a partir do seu terminal.",
    pleaseSignInFirst: "Por favor, faça login (ou crie uma conta) primeiro.",
    invalidAuthUrl: "URL de autenticação inválida",
    microphoneAccessRequiredTitle: "É necessário acesso ao microfone",
    microphoneAccessRequiredRequestPermission:
      "O Happier precisa de acesso ao seu microfone para o chat por voz. Conceda a permissão quando solicitado.",
    microphoneAccessRequiredEnableInSettings:
      "O Happier precisa de acesso ao seu microfone para o chat por voz. Ative o acesso ao microfone nas configurações do seu dispositivo.",
    microphoneAccessRequiredBrowserInstructions:
      "Permita o acesso ao microfone nas configurações do navegador. Talvez seja necessário clicar no ícone de cadeado na barra de endereços e habilitar a permissão do microfone para este site.",
    openSettings: "Abrir configurações",
    developerMode: "Modo desenvolvedor",
    developerModeEnabled: "Modo desenvolvedor ativado",
    developerModeDisabled: "Modo desenvolvedor desativado",
    disconnectGithub: "Desconectar GitHub",
    disconnectGithubConfirm:
      "Ao desconectar, Amigos e o compartilhamento entre amigos ficam desativados até você reconectar.",
    disconnectService: ({ service }: { service: string }) =>
      `Desconectar ${service}`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `Tem certeza de que deseja desconectar ${service} da sua conta?`,
    disconnect: "Desconectar",
    failedToConnectTerminal: "Falha ao conectar terminal",
    cameraPermissionsRequiredToConnectTerminal:
      "Permissões de câmera são necessárias para conectar terminal",
    failedToLinkDevice: "Falha ao vincular dispositivo",
    cameraPermissionsRequiredToScanQr:
      "Permissões de câmera são necessárias para escanear códigos QR",
    qrScannerUnavailable:
      "Não foi possível abrir o leitor de QR. Tente novamente ou insira a URL manualmente.",
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "Conectar terminal",
    linkNewDevice: "Vincular novo dispositivo",
    restoreWithSecretKey: "Restaurar com chave secreta",
    whatsNew: "Novidades",
    friends: "Amigos",
    automations: "Automações",
    automation: "Automação",
    newAutomation: "Nova automação",
    sourceControl: "Controle de versão",
    developerTools: "Ferramentas de desenvolvedor",
    listComponentsDemo: "Demo de componentes de lista",
    typography: "Tipografia",
    colors: "Cores",
    toolViewsDemo: "Demo de visualizações de ferramentas",
    maskedProgress: "Progresso mascarado",
    shimmerViewDemo: "Demo de efeito de brilho",
    multiTextInput: "Entrada de texto múltipla",
    connectClaude: "Conectar ao Claude",
    zenNewTask: "Nova tarefa",
    zenTaskDetails: "Detalhes da tarefa",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Cliente móvel Codex e Claude Code",
    subtitle:
      "Criptografia de ponta a ponta por padrão, com restauração da conta nos seus outros dispositivos.",
    createAccount: "Criar conta",
    chooseEncryptionTitle: "Escolha a criptografia",
    chooseEncryptionBody: "Este servidor oferece suporte a contas criptografadas e não criptografadas. Escolha como você quer armazenar os dados da sua conta.",
    chooseEncryptionEncrypted: "Continuar com criptografia de ponta a ponta",
    chooseEncryptionPlain: "Continuar sem criptografia",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Continuar com ${provider}`,
    signInWithCertificate: "Entrar com certificado",
    linkOrRestoreAccount: "Vincular ou restaurar conta",
    loginWithMobileApp: "Fazer login com aplicativo móvel",
    serverUnavailableTitle: "Não é possível conectar ao servidor",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Não conseguimos conectar a ${serverUrl}. Tente novamente ou altere o servidor para continuar.`,
    serverIncompatibleTitle: "Servidor não suportado",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `O servidor em ${serverUrl} retornou uma resposta inesperada. Atualize o servidor ou altere o servidor para continuar.`,
  },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "Curtindo o aplicativo?",
    feedbackPrompt: "Adoraríamos ouvir seu feedback!",
    yesILoveIt: "Sim, eu amo!",
    notReally: "Não muito",
  },

	  items: {
	    // Used by Item component for copy toast
	    copiedToClipboard: ({ label }: { label: string }) =>
	      `${label} copiado para a área de transferência`,
	    failedToCopyToClipboard: "Falha ao copiar para a área de transferência",
	  },

    machine: {
    offlineUnableToSpawn:
      "Inicializador desativado enquanto a máquina está offline",
    offlineHelp:
      "• Verifique se seu computador está online\n• Execute `happier daemon status` para diagnosticar\n• Você está usando a versão mais recente do CLI? Execute `happier self update`",
    launchNewSessionInDirectory: "Iniciar nova sessão no diretório",
    customPathPlaceholder: "Digite um caminho personalizado",
    tools: {
      title: "Ferramentas",
      installablesTitle: "Instaláveis",
      installablesSubtitle:
        "Gerencie ferramentas instaláveis para esta máquina.",
    },
    installables: {
      screenTitle: "Instaláveis",
      aboutGroupTitle: "Sobre",
      aboutSubtitle:
        "Gerencie ferramentas que o Happier pode instalar e manter atualizadas nesta máquina.",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title} (experimental)`,
      autoInstallTitle: "Auto-instalar quando necessário",
      autoInstallSubtitle:
        "Instala em segundo plano quando necessário para um backend selecionado (best-effort).",
      autoUpdateTitle: "Auto-atualizar",
      autoUpdatePromptTitle: "Auto-atualizar",
      autoUpdatePromptBody:
        "Escolha como o Happier deve lidar com atualizações para este instalável.",
      autoUpdateModes: {
        off: "Desativado",
        notify: "Notificar",
        auto: "Automático",
      },
    },
    daemon: "Daemon (serviço)",
    status: "Estado",
    daemonStatus: {
      unknown: "Desconhecido",
      stopped: "Parado",
      likelyAlive: "Provavelmente ativo",
    },
    stopDaemon: "Parar daemon",
    stopDaemonConfirmTitle: "Parar daemon?",
    stopDaemonConfirmBody:
      "Você não poderá iniciar novas sessões nesta máquina até reiniciar o daemon no seu computador. Suas sessões atuais continuarão ativas.",
    daemonStoppedTitle: "Daemon parado",
    stopDaemonFailed:
      "Falha ao parar o daemon. Talvez ele não esteja em execução.",
    renameTitle: "Renomear máquina",
    renameDescription:
      "Dê a esta máquina um nome personalizado. Deixe em branco para usar o hostname padrão.",
      renamePlaceholder: "Digite o nome da máquina",
      renamedSuccess: "Máquina renomeada com sucesso",
      renameFailed: "Falha ao renomear a máquina",
      actions: {
        removeMachine: "Remover máquina",
        removeMachineSubtitle:
          "Revoga esta máquina e a remove da sua conta.",
        removeMachineConfirmBody:
          "Isso revogará o acesso desta máquina (incluindo chaves de acesso e atribuições de automação). Você pode reconectá-la mais tarde entrando novamente pelo CLI.",
        removeMachineAlreadyRemoved:
          "Esta máquina já foi removida da sua conta.",
      },
      lastKnownPid: "Último PID conhecido",
      lastKnownHttpPort: "Última porta HTTP conhecida",
      startedAt: "Iniciado em",
      cliVersion: "Versão do CLI",
    daemonStateVersion: "Versão do estado do daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Sessões ativas (${count})`,
    machineGroup: "Máquina",
    host: "Host (servidor)",
    machineId: "ID da máquina",
    username: "Nome de usuário",
    homeDirectory: "Diretório home",
    platform: "Plataforma",
    architecture: "Arquitetura",
    lastSeen: "Visto pela última vez",
    never: "Nunca",
    metadataVersion: "Versão dos metadados",
    detectedClis: "CLIs detectados",
    detectedCliDetected: "Detectado",
    detectedCliNotDetected: "Não detectado",
    detectedCliUnknown: "Desconhecido",
    detectedCliNotSupported: "Não suportado (atualize o @happier-dev/cli)",
    untitledSession: "Sessão sem título",
    back: "Voltar",
    notFound: "Máquina não encontrada",
    unknownMachine: "máquina desconhecida",
    unknownPath: "caminho desconhecido",
    previousSessionsTitle: "Sessões anteriores (até as 5 mais recentes)",
    tmux: {
      overrideTitle: "Substituir configurações globais do tmux",
      overrideEnabledSubtitle:
        "As configurações personalizadas do tmux se aplicam a novas sessões nesta máquina.",
      overrideDisabledSubtitle:
        "Novas sessões usam as configurações globais do tmux.",
      notDetectedSubtitle: "tmux não foi detectado nesta máquina.",
      notDetectedMessage:
        "tmux não foi detectado nesta máquina. Instale o tmux e atualize a detecção.",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "Mostrar console para sessões remotas",
      remoteSessionConsoleVisibleSubtitle:
        "Sessões remotas abrem em uma janela de console visível nesta máquina.",
      remoteSessionConsoleHiddenSubtitle:
        "Sessões remotas iniciam ocultas para evitar janelas abrindo/fechando.",
      remoteSessionConsoleUpdateFailed:
        "Falha ao atualizar a configuração do console de sessão no Windows.",
      remoteSessionModeTitle: "Modo de sessão remota",
      remoteSessionModeOverrideTitle: "Substituir o modo global de sessão do Windows",
      remoteSessionModeOverrideEnabledSubtitle:
        "Esta máquina usa seu próprio modo de sessão remota do Windows.",
      remoteSessionModeOverrideDisabledSubtitle:
        "Esta máquina segue o seu modo global de sessão remota do Windows.",
      windowsTerminalUnavailableSuffix: "Windows Terminal não foi detectado nesta máquina.",
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) => `Mudou para o modo ${mode}`,
    discarded: "Descartado",
    unknownEvent: "Evento desconhecido",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Limite de uso atingido até ${time}`,
    unknownTime: "horário desconhecido",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "As permissões são mostradas apenas no terminal. Redefina ou envie uma mensagem para controlar pelo app.",
    sessionRunningLocally:
      "Esta sessão está sendo executada localmente neste computador. Você pode alternar para remoto para controlar pelo app.",
    sessionRunningLocallyAndRemotely:
      "Esta sessão está conectada localmente no OpenCode e ainda pode ser controlada pelo app.",
    switchingToRemote: "Alternando para o modo remoto…",
    switchToLocal: "Alternar para local",
    switchToRemote: "Alternar para remoto",
    detachLocalTerminal: "Desconectar terminal",
    directSessionTakeoverAvailable:
      "Esta sessão direta está disponível na sua máquina. Assuma o controle no Happier para controlá-la aqui.",
    directSessionMachineOffline:
      "Esta sessão direta está indisponível no momento porque a máquina está offline.",
    switchingToDirectTakeover: "Assumindo o controle desta sessão direta…",
    switchingToPersistedTakeover: "Assumindo o controle e sincronizando esta sessão…",
    takeOverDirect: "Assumir controle",
    takeOverPersist: "Assumir controle + Sincronizar",
    directTakeoverDialogTitle: "Continuar esta sessão direta no Happier?",
    directTakeoverDialogBody: "Escolha como o Happier deve assumir o controle. Direto continua usando a transcrição do provedor. Sincronizar importa a transcrição para o Happier.",
    directTakeoverDialogDirectTitle: "Assumir controle",
    directTakeoverDialogDirectBody: "Controle esta sessão no Happier sem sincronizar a transcrição para o Happier.",
    directTakeoverDialogPersistTitle: "Assumir controle + Sincronizar",
    directTakeoverDialogPersistBody: "Importe a transcrição para o Happier e continue com todos os recursos de sessão sincronizada.",
    directTakeoverDialogForceStopTitle: "Tentar parar primeiro o processo local",
    directTakeoverDialogForceStopBody: "O Happier encontrou um processo local confiável para esta sessão. Ative isto se quiser que o Happier o pare antes de assumir o controle.",
    directTakeoverForceStopConfirmTitle: "Parar primeiro o processo local?",
    directTakeoverForceStopConfirmBody: "O Happier encontrou um processo local confiável para esta sessão direta. Pará-lo antes de assumir o controle aqui?",
    directTakeoverForceStopConfirmAction: "Parar e assumir o controle",
  },

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "Sim, permitir globalmente",
        yesForSession: "Sim, e não perguntar para esta sessão",
        stop: "Parar",
        stopAndExplain: "Parar, e explicar o que fazer",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits: "Sim, permitir todas as edições durante esta sessão",
        yesForTool: "Sim, não perguntar novamente para esta ferramenta",
        yesForCommandPrefix:
          "Sim, não perguntar novamente para este prefixo de comando",
        yesForSubcommand: "Sim, não perguntar novamente para este subcomando",
        yesForCommandName: "Sim, não perguntar novamente para este comando",
        stop: "Parar",
        noTellClaude: "Não, fornecer feedback",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "Selecionar intervalo de texto",
    title: "Selecionar texto",
    noTextProvided: "Nenhum texto fornecido",
    textNotFound: "Texto não encontrado ou expirado",
    textCopied: "Texto copiado para a área de transferência",
    failedToCopy: "Falha ao copiar o texto para a área de transferência",
    noTextToCopy: "Nenhum texto disponível para copiar",
    failedToOpen: "Falha ao abrir a seleção de texto. Tente novamente.",
  },

    markdown: {
      // Markdown copy functionality
      codeCopied: "Código copiado",
      copyFailed: "Falha ao copiar",
      mermaidRenderFailed: "Falha ao renderizar diagrama mermaid",
      diffLabel: "Diferenças",
      codeLabel: "Código",
    },

  artifacts: {
    title: "Artefatos",
    countSingular: "1 artefato",
    countPlural: ({ count }: { count: number }) => `${count} artefatos`,
    empty: "Ainda não há artefatos",
    emptyDescription:
      "Crie seu primeiro artefato para salvar e organizar conteúdo",
    new: "Novo artefato",
    edit: "Editar artefato",
    delete: "Excluir",
    updateError: "Falha ao atualizar artefato. Por favor, tente novamente.",
    deleteError: "Falha ao excluir o artefato. Tente novamente.",
    notFound: "Artefato não encontrado",
    discardChanges: "Descartar alterações?",
    discardChangesDescription:
      "Você tem alterações não salvas. Tem certeza de que deseja descartá-las?",
    deleteConfirm: "Excluir artefato?",
    deleteConfirmDescription: "Este artefato será excluído permanentemente.",
    noContent: "Sem conteúdo",
    untitled: "Sem título",
    titlePlaceholder: "Título do artefato",
    bodyPlaceholder: "Digite o conteúdo aqui...",
    save: "Salvar",
    saving: "Salvando...",
    loading: "Carregando...",
    error: "Falha ao carregar artefatos",
    titleLabel: "TÍTULO",
    bodyLabel: "CONTEÚDO",
    emptyFieldsError: "Por favor, insira um título ou conteúdo",
    createError: "Falha ao criar artefato. Por favor, tente novamente.",
  },

  friends: {
    // Friends feature
    title: "Amigos",
    sharedSessions: "Sessões compartilhadas",
    noSharedSessions: "Ainda não há sessões compartilhadas",
    manageFriends: "Gerencie seus amigos e conexões",
    searchTitle: "Buscar amigos",
    pendingRequests: "Solicitações de amizade",
    myFriends: "Meus amigos",
    noFriendsYet: "Você ainda não tem amigos",
    findFriends: "Buscar amigos",
    remove: "Remover",
    pendingRequest: "Pendente",
    sentOn: ({ date }: { date: string }) => `Enviado em ${date}`,
    accept: "Aceitar",
    reject: "Rejeitar",
    addFriend: "Adicionar amigo",
    alreadyFriends: "Já são amigos",
    requestPending: "Solicitação pendente",
    searchInstructions: "Digite um nome de usuário para buscar amigos",
    searchPlaceholder: "Digite o nome de usuário...",
    searching: "Buscando...",
    userNotFound: "Usuário não encontrado",
    noUserFound: "Nenhum usuário encontrado com esse nome",
    checkUsername: "Por favor, verifique o nome de usuário e tente novamente",
    howToFind: "Como encontrar amigos",
    findInstructions:
      "Procure amigos pelo nome de usuário. Dependendo do seu servidor, talvez seja necessário conectar um provedor ou escolher um nome de usuário para usar Amigos.",
    emptyTitle: "Sem atividade de amigos",
    emptyDescription: "Adicione amigos para compartilhar sessões e ver atividade aqui.",
    activity: "Atividade",
    requestSent: "Solicitação de amizade enviada!",
    requestAccepted: "Solicitação de amizade aceita!",
    requestRejected: "Solicitação de amizade rejeitada",
    friendRemoved: "Amigo removido",
    confirmRemove: "Remover amigo",
    confirmRemoveMessage: "Tem certeza de que deseja remover este amigo?",
    cannotAddYourself:
      "Você não pode enviar uma solicitação de amizade para si mesmo",
    bothMustHaveGithub:
      "Ambos os usuários devem ter o provedor necessário conectado para serem amigos",
    status: {
      none: "Não conectado",
      requested: "Solicitação enviada",
      pending: "Solicitação pendente",
      friend: "Amigos",
      rejected: "Rejeitada",
    },
    acceptRequest: "Aceitar solicitação",
    removeFriend: "Remover dos amigos",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `Tem certeza de que deseja remover ${name} dos seus amigos?`,
    requestSentDescription: ({ name }: { name: string }) =>
      `Sua solicitação de amizade foi enviada para ${name}`,
    requestFriendship: "Solicitar amizade",
    cancelRequest: "Cancelar solicitação de amizade",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `Cancelar sua solicitação de amizade para ${name}?`,
    denyRequest: "Recusar solicitação",
    nowFriendsWith: ({ name }: { name: string }) =>
      `Agora você é amigo de ${name}`,
    disabled: "O recurso Amigos está desativado neste servidor.",
    username: {
      required: "Escolha um nome de usuário para usar Amigos.",
      taken: "Esse nome de usuário já está em uso.",
      invalid: "Esse nome de usuário não é permitido.",
      disabled:
        "O recurso Amigos com nome de usuário não está habilitado neste servidor.",
      preferredNotAvailable:
        "Seu nome de usuário preferido não está disponível neste servidor. Escolha outro.",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `Seu nome de usuário preferido @${login} não está disponível neste servidor. Escolha outro.`,
    },
    githubGate: {
      title: "Conecte o GitHub para usar Amigos",
      body: "Amigos usa nomes de usuário do GitHub para descoberta e compartilhamento.",
      connect: "Conectar GitHub",
      notAvailable: "Não disponível?",
      notConfigured: "GitHub OAuth não está configurado neste servidor.",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `Conecte ${provider} para usar Amigos`,
      body: ({ provider }: { provider: string }) =>
        `Amigos usa nomes de usuário do ${provider} para descoberta e compartilhamento.`,
      connect: ({ provider }: { provider: string }) => `Conectar ${provider}`,
      notAvailable: "Não disponível?",
      notConfigured: ({ provider }: { provider: string }) =>
        `${provider} OAuth não está configurado neste servidor.`,
    },
  },

  usage: {
    // Usage panel strings
    today: "Hoje",
    last7Days: "Últimos 7 dias",
    last30Days: "Últimos 30 dias",
    totalTokens: "Tokens totais",
    totalCost: "Custo total",
    tokens: "Tokens (IA)",
    cost: "Custo",
    usageOverTime: "Uso ao longo do tempo",
    byModel: "Por modelo",
    noData: "Nenhum dado de uso disponível",
  },

  profiles: {
    title: "Perfis",
    subtitle: "Gerencie seus perfis de configuração",
    sessionUses: ({ profile }: { profile: string }) =>
      `Esta sessão usa: ${profile}`,
    profilesFixedPerSession:
      "Os perfis são fixos por sessão. Para usar um perfil diferente, inicie uma nova sessão.",
    noProfile: "Nenhum perfil",
    noProfileDescription:
      "Crie um perfil para gerenciar sua configuração de ambiente",
    addProfile: "Adicionar perfil",
    addProfileTitle: "Título do perfil de adição",
    editProfile: "Editar perfil",
    profileName: "Nome do perfil",
    enterName: "Digite o nome do perfil",
    baseURL: "URL base",
    authToken: "Token de autenticação",
    enterToken: "Digite o token de autenticação",
    model: "Modelo",
    defaultModel: "Modelo padrão",
    tmuxSession: "Sessão tmux",
    enterTmuxSession: "Digite o nome da sessão tmux",
    tmuxTempDir: "Diretório temporário tmux",
    enterTmuxTempDir: "Digite o diretório temporário tmux",
    tmuxUpdateEnvironment: "Atualizar ambiente tmux",
    deleteConfirm: ({ name }: { name: string }) =>
      `Tem certeza de que deseja excluir o perfil "${name}"?`,
    nameRequired: "O nome do perfil é obrigatório",
    builtIn: "Integrado",
    custom: "Personalizado",
    builtInSaveAsHint:
      "Salvar um perfil integrado cria um novo perfil personalizado.",
    builtInNames: {
      anthropic: "Anthropic (Padrão)",
      deepseek: "DeepSeek (Raciocínio)",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (Padrão)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Padrão)",
      geminiApiKey: "Gemini (Chave de API)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "Favoritos",
      custom: "Seus perfis",
      builtIn: "Perfis integrados",
    },
    actions: {
      viewEnvironmentVariables: "Variáveis de ambiente",
      addToFavorites: "Adicionar aos favoritos",
      removeFromFavorites: "Remover dos favoritos",
      editProfile: "Editar perfil",
      duplicateProfile: "Duplicar perfil",
      deleteProfile: "Excluir perfil",
    },
    copySuffix: "(Cópia)",
    duplicateName: "Já existe um perfil com este nome",
    setupInstructions: {
      title: "Instruções de configuração",
      viewCloudGuide: "Ver guia oficial de configuração",
    },
    machineLogin: {
      title: "Login necessário na máquina",
      subtitle:
        "Este perfil depende do cache de login do CLI na máquina selecionada.",
      status: {
        loggedIn: "Logado",
        notLoggedIn: "Não logado",
      },
      claudeCode: {
        title: "Claude Code",
        instructions: "Execute `claude` e depois digite `/login` para entrar.",
        warning:
          "Obs.: definir `ANTHROPIC_AUTH_TOKEN` substitui o login do CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Execute `codex login` para entrar.",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "Execute `gemini auth` para entrar.",
      },
    },
    requirements: {
      secretRequired: "Segredo",
      configured: "Configurada na máquina",
      notConfigured: "Não configurada",
      checking: "Verificando…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `Este perfil requer que ${env} esteja configurado na máquina.`,
      modalTitle: "Segredo necessário",
      modalBody:
        "Este perfil requer um segredo.\n\nOpções disponíveis:\n• Usar ambiente da máquina (recomendado)\n• Usar um segredo salvo nas configurações do app\n• Inserir um segredo apenas para esta sessão",
      sectionTitle: "Requisitos",
      sectionSubtitle:
        "Estes campos são usados para checar a prontidão e evitar falhas inesperadas.",
      secretEnvVarPromptDescription:
        "Digite o nome da variável de ambiente secreta necessária (ex.: OPENAI_API_KEY).",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `Este perfil precisa de ${env}. Escolha uma opção abaixo.`,
      modalHelpGeneric:
        "Este perfil precisa de um segredo. Escolha uma opção abaixo.",
      chooseOptionTitle: "Escolha uma opção",
      machineEnvStatus: {
        theMachine: "a máquina",
        checkFor: ({ env }: { env: string }) => `Verificar ${env}`,
        checking: ({ env }: { env: string }) => `Verificando ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${env} encontrado em ${machine}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${env} não encontrado em ${machine}`,
      },
      machineEnvSubtitle: {
        checking: "Verificando ambiente do daemon…",
        found: "Encontrado no ambiente do daemon na máquina.",
        notFound:
          "Defina no ambiente do daemon na máquina e reinicie o daemon.",
      },
      options: {
        none: {
          title: "Nenhum",
          subtitle: "Não requer segredo nem login via CLI.",
        },
        machineLogin: {
          subtitle: "Requer estar logado via um CLI na máquina de destino.",
          longSubtitle:
            "Requer estar logado via o CLI do backend de IA escolhido na máquina de destino.",
        },
        useMachineEnvironment: {
          title: "Usar ambiente da máquina",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `Usar ${env} do ambiente do daemon.`,
          subtitleGeneric: "Usar o segredo do ambiente do daemon.",
        },
        useSavedSecret: {
          title: "Usar um segredo salvo",
          subtitle: "Selecione (ou adicione) um segredo salvo no app.",
        },
        enterOnce: {
          title: "Inserir um segredo",
          subtitle: "Cole um segredo apenas para esta sessão (não será salvo).",
        },
      },
      secretEnvVar: {
        title: "Variável de ambiente do segredo",
        subtitle:
          "Digite o nome da variável de ambiente que este provedor espera para o segredo (ex.: OPENAI_API_KEY).",
        label: "Nome da variável de ambiente",
      },
      sections: {
        machineEnvironment: "Ambiente da máquina",
        useOnceTitle: "Usar uma vez",
        useOnceLabel: "Insira um segredo",
        useOnceFooter:
          "Cole um segredo apenas para esta sessão. Ele não será salvo.",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "Começar com a chave já presente na máquina.",
        },
        useOnceButton: "Usar uma vez (apenas sessão)",
      },
    },
    defaultPermissionMode: {
      title: "Modo de permissão padrão",
      descriptions: {
        default: "Solicitar permissões",
        acceptEdits: "Aprovar edições automaticamente",
        plan: "Planejar antes de executar",
        bypassPermissions: "Ignorar todas as permissões",
      },
    },
    defaultPermissions: {
      title: "Permissões padrão",
      footer:
        "Substitui as permissões padrão no nível da conta para novas sessões quando este perfil estiver selecionado.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `Padrão da conta: ${label}`,
      useAccountDefault: "Usar padrão da conta",
      currently: ({ label }: { label: string }) => `Atual: ${label}`,
    },
    defaultStorage: {
      title: 'Armazenamento padrão da sessão',
      footer: 'Substitui o modo padrão sincronizado/direto no nível da conta para novas sessões quando este perfil estiver selecionado.',
      accountDefaultSubtitle: ({ label }: { label: string }) => `Padrão da conta: ${label}`,
      useAccountDefault: 'Usar padrão da conta',
      currently: ({ label }: { label: string }) => `Atual: ${label}`,
    },
    aiBackend: {
      title: "Backend de IA",
      selectAtLeastOneError: "Selecione pelo menos um backend de IA.",
      claudeSubtitle: "CLI do Claude",
      codexSubtitle: "CLI do Codex",
      opencodeSubtitle: "CLI do OpenCode",
      geminiSubtitleExperimental: "CLI do Gemini (experimental)",
      auggieSubtitle: "CLI do Auggie",
      qwenSubtitleExperimental: "CLI do Qwen Code (experimental)",
      kimiSubtitleExperimental: "CLI do Kimi (experimental)",
      kiloSubtitleExperimental: "CLI do Kilo (experimental)",
      kiroSubtitleExperimental: "CLI do Kiro (experimental)",
      customAcpSubtitleExperimental: "CLI de ACP personalizada (experimental)",
      piSubtitleExperimental: "CLI do Pi (experimental)",
      copilotSubtitleExperimental: "GitHub Copilot CLI (em testes)",
    },
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Iniciar sessões no Tmux",
      spawnSessionsEnabledSubtitle:
        "As sessões são iniciadas em novas janelas do tmux.",
      spawnSessionsDisabledSubtitle:
        "As sessões são iniciadas no shell comum (sem integração com tmux)",
      isolatedServerTitle: "Servidor tmux isolado",
      isolatedServerEnabledSubtitle:
        "Inicie sessões em um servidor tmux isolado (recomendado).",
      isolatedServerDisabledSubtitle:
        "Inicie sessões no seu servidor tmux padrão.",
      sessionNamePlaceholder: "Vazio = sessão atual/mais recente",
      tempDirPlaceholder: "Deixe em branco para gerar automaticamente",
    },
    previewMachine: {
      title: "Pré-visualizar máquina",
      itemTitle: "Máquina de pré-visualização para variáveis de ambiente",
      selectMachine: "Selecionar máquina",
      resolveSubtitle:
        "Usada apenas para pré-visualizar os valores resolvidos abaixo (não altera o que é salvo).",
      selectSubtitle:
        "Selecione uma máquina para pré-visualizar os valores resolvidos abaixo.",
    },
    environmentVariables: {
      title: "Variáveis de ambiente",
      addVariable: "Adicionar variável",
      namePlaceholder: "Nome da variável (e.g., MY_CUSTOM_VAR)",
      valuePlaceholder: "Valor (e.g., my-value ou ${MY_VAR})",
      validation: {
        nameRequired: "Digite um nome de variável.",
        invalidNameFormat:
          "Os nomes das variáveis devem conter letras maiúsculas, números e sublinhados, e não podem começar com um número.",
        duplicateName: "Essa variável já existe.",
      },
      card: {
        valueLabel: "Valor:",
        fallbackValueLabel: "Valor de fallback:",
        valueInputPlaceholder: "Valor",
        defaultValueInputPlaceholder: "Valor padrão",
        fallbackDisabledForVault:
          "Fallbacks ficam desativados ao usar o cofre de segredos.",
        secretNotRetrieved: "Valor secreto - não é recuperado por segurança",
        secretToggleLabel: "Ocultar valor na UI",
        secretToggleSubtitle:
          "Oculta o valor na interface e evita buscá-lo da máquina para pré-visualização.",
        secretToggleEnforcedByDaemon: "Imposto pelo daemon",
        secretToggleEnforcedByVault: "Imposto pelo cofre de segredos",
        secretToggleResetToAuto: "Redefinir para automático",
        requirementRequiredLabel: "Obrigatório",
        requirementRequiredSubtitle:
          "Bloqueia a criação da sessão quando a variável está ausente.",
        requirementUseVaultLabel: "Usar cofre de segredos",
        requirementUseVaultSubtitle:
          "Usar um segredo salvo (sem valores de fallback).",
        defaultSecretLabel: "Segredo padrão",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `Substituindo o valor padrão documentado: ${expectedValue}`,
        useMachineEnvToggle: "Usar valor do ambiente da máquina",
        resolvedOnSessionStart:
          "Resolvido quando a sessão começa na máquina selecionada.",
        sourceVariableLabel: "Variável de origem",
        sourceVariablePlaceholder:
          "Nome da variável de origem (e.g., Z_AI_MODEL)",
        checkingMachine: ({ machine }: { machine: string }) =>
          `Verificando ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `Vazio em ${machine}`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Vazio em ${machine} (usando fallback)`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `Não encontrado em ${machine}`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Não encontrado em ${machine} (usando fallback)`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `Valor encontrado em ${machine}`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `Diferente do valor documentado: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - oculto por segurança`,
        hiddenValue: "***oculto***",
        emptyValue: "(vazio)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `A sessão receberá: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `Vars de ambiente · ${profileName}`,
        descriptionPrefix:
          "Estas variáveis de ambiente são enviadas ao iniciar a sessão. Os valores são resolvidos usando o daemon em",
        descriptionFallbackMachine: "a máquina selecionada",
        descriptionSuffix: ".",
        emptyMessage:
          "Nenhuma variável de ambiente está definida para este perfil.",
        checkingSuffix: "(verificando…)",
        detail: {
          fixed: "Fixo",
          machine: "Máquina",
          checking: "Verificando",
          fallback: "Alternativa",
          missing: "Ausente",
        },
      },
    },
    delete: {
      title: "Excluir Perfil",
      message: ({ name }: { name: string }) =>
        `Tem certeza de que deseja excluir "${name}"? Esta ação não pode ser desfeita.`,
      confirm: "Excluir",
      cancel: "Cancelar",
    },
  },

  secrets: {
    addTitle: "Novo segredo",
    savedTitle: "Segredos salvos",
    badgeReady: "Segredo",
    badgeRequired: "Segredo necessário",
    missingForProfile: ({ env }: { env: string | null }) =>
      `Falta o segredo (${env ?? "segredo"}). Configure na máquina ou selecione/insira um segredo.`,
    defaultForProfileTitle: "Segredo padrão",
    defineDefaultForProfileTitle: "Definir segredo padrão para este perfil",
    addSubtitle: "Adicionar um segredo salvo",
    noneTitle: "Nenhuma",
    noneSubtitle:
      "Use o ambiente da máquina ou insira um segredo para esta sessão",
    emptyTitle: "Nenhum segredo salvo",
    emptySubtitle:
      "Adicione um para usar perfis com segredo sem configurar variáveis de ambiente na máquina.",
    savedHiddenSubtitle: "Salva (valor oculto)",
    defaultLabel: "Padrão",
    fields: {
      name: "Nome",
      value: "Valor",
    },
    placeholders: {
      nameExample: "ex.: Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "Nome é obrigatório.",
      valueRequired: "Valor é obrigatório.",
    },
    actions: {
      replace: "Substituir",
      replaceValue: "Substituir valor",
      setDefault: "Definir como padrão",
      unsetDefault: "Remover padrão",
    },
    prompts: {
      renameTitle: "Renomear segredo",
      renameDescription: "Atualize o nome amigável deste segredo.",
      replaceValueTitle: "Substituir valor do segredo",
      replaceValueDescription:
        "Cole o novo valor do segredo. Este valor não será mostrado novamente após salvar.",
      deleteTitle: "Excluir segredo",
      deleteConfirm: ({ name }: { name: string }) =>
        `Excluir “${name}”? Esta ação não pode ser desfeita.`,
    },
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} enviou-lhe um pedido de amizade`,
    friendRequestGeneric: "Novo pedido de amizade",
    friendAccepted: ({ name }: { name: string }) =>
      `Agora você é amigo de ${name}`,
    friendAcceptedGeneric: "Pedido de amizade aceito",
  },
} as const;

export type TranslationsPt = typeof pt;
