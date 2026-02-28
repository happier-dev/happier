import type { TranslationStructure } from "../_types";

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
    inbox: "Amigos",
    sessions: "Terminais",
    settings: "Configurações",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Sem atividade de amigos",
    emptyDescription:
      "Adicione amigos para compartilhar sessões e ver atividade aqui.",
    updates: "Atividade",
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
        name: "Sessão agendada",
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
    actions: "Ações",
    moreActions: "Mais ações",
    moreActionsHint: "Abre um menu com mais ações",
    cancel: "Cancelar",
    close: "Fechar",
    open: "Abrir",
    done: "Concluído",
    reorder: "Reordenar",
    authenticate: "Autenticar",
    save: "Salvar",
    saveAs: "Salvar como",
    error: "Erro",
    success: "Sucesso",
    ok: "OK",
    continue: "Continuar",
    back: "Voltar",
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
    expand: "Expandir",
    collapse: "Recolher",
    command: "Comando",
    scanning: "Escaneando...",
    urlPlaceholder: "https://exemplo.com",
    home: "Início",
    message: "Mensagem",
    send: "Enviar",
    attach: "Anexar",
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
      groupTitle: "Vetores de embedding",
      groupFooter:
        "Opcional: baixe um modelo local para melhorar correspondências semânticas ao usar o modo Deep.",
      enableTitle: "Ativar embeddings",
      enableSubtitle:
        "Melhora o ranqueamento da busca profunda (baixa um modelo no primeiro uso)",
      modelTitle: "Modelo de embeddings",
      promptBody: "Insira um id de modelo transformers local.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
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
      groupTitle: "Subagente",
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
    },
  },

  settings: {
    title: "Configurações",
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
      "Happier Coder é um cliente móvel para Codex e Claude Code. É totalmente criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo. Não é afiliado à Anthropic.",
    whatsNew: "Novidades",
    whatsNewSubtitle: "Veja as atualizações e melhorias mais recentes",
    reportIssue: "Relatar um problema",
    privacyPolicy: "Política de privacidade",
    termsOfService: "Termos de serviço",
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
    servers: "Servidores",
    serversSubtitle: "Servidores salvos, grupos e padrões",
    systemStatus: "Status do sistema",
    systemStatusSubtitle: "Servidores, conta, máquinas, daemon",

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
        "Este fluxo usa uma etapa de redirecionamento de copiar/colar (como OpenClaw) e um proxy do servidor Happier para trocar tokens com segurança.",
      openAuthorizationUrl: "Abrir URL de autorização",
      opensInNewTab: "Abre em uma nova aba",
      preparing: "Preparando…",
      pasteRedirectUrl: "Colar URL de redirecionamento",
      pasteRedirectUrlPromptBody:
        "Após concluir o OAuth, copie a URL final redirecionada da barra de endereços do navegador e cole aqui.",
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
      uploadTtl: {
        title: "TTL do upload (ms)",
        promptTitle: "TTL do upload (ms)",
        promptMessage:
          "Por quanto tempo um upload pode ficar ocioso antes de expirar.",
        invalidValueMessage: "Insira um número entre 5000 e 3600000.",
      },
      chunkSize: {
        title: "Tamanho de chunk preferido (bytes)",
        promptTitle: "Tamanho de chunk preferido (bytes)",
        promptMessage: "O CLI pode limitar isso a faixas seguras.",
        invalidValueMessage: "Insira um número entre 4096 e 1048576.",
      },
    },
  },

  settingsSourceControl: {
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
    push: {
      title: "Notificações push",
      footer:
        "Essas notificações são enviadas do seu CLI via Expo quando sua sessão precisa de atenção.",
      enabledSubtitle: "Permitir notificações push nesta conta",
    },
    types: {
      title: "Tipos",
      footer: "Desative tipos individuais se quiser apenas certos alertas.",
      ready: {
        title: "Pronto",
        subtitle:
          "Notificar quando um turno termina e o agente está aguardando seu comando",
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
      resumeSupportRuntimeGatedAcpLoadSession:
        "Limitado em runtime via ACP loadSession",
      resumeSupportNotSupported: "Não suportado",
      sessionModeNone: "Sem modos ACP",
      sessionModeAcpPolicyPresets: "Predefinições de políticas ACP",
      sessionModeAcpAgentModes: "Modos de agente ACP",
      sessionModeStaticAgentModes: "Modos de agente estáticos",
      runtimeSwitchNone: "Sem troca em tempo de execução",
      runtimeSwitchMetadataGating: "Limitado por metadados",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
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
        noMachineSelected: "Nenhuma máquina selecionada.",
        installNotSupported: "Instalação não suportada nesta máquina.",
        installFailed: "Falha na instalação.",
        installed: "Instalado.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL do guia de configuração",
      connectedServiceTitle: "Serviço conectado",
      notFoundTitle: "Provedor não encontrado",
      notFoundSubtitle: "Este provedor não tem tela de configurações.",
      noOptionsAvailable: "Sem opções disponíveis",
      invalidNumber: "Número inválido",
    invalidJson: "JSON inválido",
  },

  settingsAppearance: {
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
      "O Codex resume não está instalado nesta máquina",
    codexResumeNotInstalledMessage:
      "Para retomar uma conversa do Codex, instale o servidor de retomada do Codex na máquina de destino (Detalhes da máquina → Retomada do Codex).",
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
        installSpecTitle: "Fonte de instalação do Codex resume",
      },
      codexAcp: {
        title: "Adaptador Codex ACP",
        installSpecTitle: "Fonte de instalação do Codex ACP",
      },
      installSpecDescription:
        "Especificação NPM/Git/arquivo passada para `npm install` (experimental). Deixe em branco para usar o padrão do daemon.",
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
      installSpecPlaceholder:
        "ex.: file:/caminho/para/pkg ou github:owner/repo#branch",
      lastInstallLog: "Último log de instalação",
      installLogTitle: "Log de instalação",
    },
  },

  newSession: {
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
    selectSessionTypeTitle: "Selecionar tipo de sessão",
    selectSessionTypeDescription:
      "Escolha uma sessão simples ou uma vinculada a um worktree do Git.",
    searchPathsPlaceholder: "Pesquisar caminhos...",
    noMachinesFound:
      "Nenhuma máquina encontrada. Inicie uma sessão Happier no seu computador primeiro.",
    allMachinesOffline: "Todas as máquinas estão offline",
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
      title: "Retomar Codex",
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
      installTitle: "Instalar Codex resume?",
      updateTitle: "Atualizar Codex resume?",
      reinstallTitle: "Reinstalar Codex resume?",
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

  session: {
    inputPlaceholder: "Digite uma mensagem ...",
    activity: "Atividade",
    activityCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} mais…`,
    forking: {
      dividerTitle: "Derivado de um contexto anterior",
      dividerSubtitle: "Contexto anterior (somente leitura)",
      openParent: "Abrir",
      openParentA11y: "Abrir sessão pai",
      forkFromMessageA11y: "Derivar desta mensagem",
    },
    resuming: "Retomando...",
    resumeFailed: "Falha ao retomar a sessão",
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
        participants: {
          to: 'Para',
          lead: 'Principal',
          sendToTitle: 'Enviar para',
          broadcast: ({ teamId }: { teamId: string }) => `Broadcast: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `Execução ${runId}`,
          cardTo: ({ label }: { label: string }) => `Para: ${label}`,
          unsupportedAttachmentsOrReviewComments: 'Enviar para um destinatário ainda não suporta anexos nem comentários de revisão.',
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
          pinnedTabA11y: "Aba fixada",
          closeTabA11y: "Fechar aba",
          enterFocusModeA11y: "Entrar no modo de foco do editor",
          exitFocusModeA11y: "Sair do modo de foco do editor",
      },
  
      actionsDraft: {
        noInputHints: "Esta ação não tem dicas de entrada.",
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
        untriaged: "Sem triagem",
        accept: "Aceitar",
        reject: "Rejeitar",
        defer: "Adiar",
        needsRefinement: "Precisa de refinamento",
      },
      refinementPlaceholder: "Comentário opcional para refinamento",
      actions: {
        applyTriage: "Aplicar triagem",
        applying: "Aplicando…",
        applyAcceptedFindings: "Aplicar achados aceitos",
        sending: "Enviando…",
      },
      errors: {
        applyTriageFailed: "Falha ao aplicar a triagem.",
        applyAcceptedFailed: "Falha ao aplicar os achados aceitos.",
      },
    },

      pendingMessages: {
        title: "Mensagens pendentes",
        indicator: ({ count }: { count: number }) => `Pendentes (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `Pendentes (+${count})` : "Pendentes",
        empty: "Nenhuma mensagem pendente.",
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
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "Encerrar sessão",
    killSessionConfirm: "Tem certeza de que deseja encerrar esta sessão?",
    stopSession: "Parar sessão",
    stopSessionConfirm: "Tem certeza de que deseja parar esta sessão?",
    archiveSession: "Arquivar sessão",
    archiveSessionConfirm: "Tem certeza de que deseja arquivar esta sessão?",
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
      "Por favor execute npm install -g @happier-dev/cli@latest",
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
      installCommand: "$ npm i -g @happier-dev/cli",
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
      badgeA11y: ({ name }: { name: string }) => `Modo: ${name}`,
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
    taskView: {
      initializing: "Inicializando agente...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} mais ${plural({ count, singular: "ferramenta", plural: "ferramentas" })}`,
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
      allRepositoryFiles: "Todos os arquivos do repositório",
      repositoryView: "Visão do repositório",
      sessionView: "Visão da sessão",
      review: "Revisão",
      list: "Lista",
      scm: "Git",
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
      labels: {
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

    settingsSession: {
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
          cardTapActionTitle: "Ação ao tocar (cartão)",
          timelineChrome: {
            title: "Estilo de ferramentas na linha do tempo",
            cardsTitle: "Cartões",
          cardsSubtitle:
            "Cartões de ferramentas com conteúdo inline (com base no nível de detalhe).",
          activityFeedTitle: "Feed de atividade",
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
          defaultDetailTitle: "Detalhe padrão (feed de atividade)",
          expandedDetailTitle: "Detalhe expandido (feed de atividade)",
          tapActionTitle: "Ação ao tocar (feed de atividade)",
          tapAction: {
            expandTitle: "Expandir",
            expandSubtitle: "Toque expande ou recolhe detalhes inline.",
            openTitle: "Abrir",
            openSubtitle: "Toque abre a tela de visão completa da ferramenta.",
          },
          defaultExpandedTitle: "Expandido por padrão",
          defaultExpandedSubtitle:
            "Expandir linhas de ferramentas por padrão no feed de atividade.",
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
        layoutTitle: "Disposição",
        layoutFooter:
          "Escolha entre uma transcrição linear e o agrupamento por turnos.",
        layoutPickerTitle: "Layout da transcrição",
        layout: {
          linearTitle: "Linear (atual)",
          linearSubtitle: "Mostrar mensagens como uma lista plana.",
          turnsTitle: "Turnos",
          turnsSubtitle: "Agrupar mensagens em turnos usuário/assistente.",
        },
        activityGroupTitle: "Agrupar ferramentas em Atividade",
        activityGroupSubtitle:
          "Compactar chamadas de ferramenta em uma seção Atividade dentro de cada turno.",
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
          jumpToBottomTitle: "Botão de pular para o final",
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
            "Controla como a Atividade é formada dentro dos turnos.",
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
          activityStrategyTitle: "Estratégia de agrupamento de Atividade",
          activityStrategy: {
            consecutiveTitle: "Ferramentas consecutivas (padrão)",
            consecutiveSubtitle:
              "Agrupar apenas chamadas consecutivas em Atividade.",
            allToolsTitle: "Todas as ferramentas no turno",
            allToolsSubtitle:
              "Agrupar todas as ferramentas de um turno em uma única seção Atividade.",
          },
            activityCollapsedPreviewCountTitle: "Prévia (recolhido)",
            activityCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Mostrar as últimas ${value} ferramentas quando a Atividade estiver recolhida.`,
            activityCollapsedPreviewCount: {
              offTitle: "Desativado",
              offSubtitle: "Mostrar apenas o cabeçalho de Atividade.",
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
      actionsEntry: {
        footer:
          "Habilite ações por superfície e posicionamento (UI, voz, MCP) e controle onde elas aparecem.",
        openSubtitle: "Abrir configurações de ações",
      },
      defaultPermissions: {
        title: "Permissões padrão",
        footer:
          "Aplica-se ao iniciar uma nova sessão. Perfis podem sobrescrever opcionalmente.",
        applyPermissionChangesTitle: "Aplicar mudanças de permissão",
        applyPermissionChangesImmediateSubtitle:
          "Aplicar imediatamente para sessões em execução (atualiza metadados da sessão).",
        applyPermissionChangesNextPromptSubtitle: "Aplicar somente na próxima mensagem.",
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
        recentMessagesTitle: "Mensagens recentes a incluir",
        recentMessagesPlaceholder: "16",
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
          styleDefaultSubtitle: "Cartões: Resumo. Feed de atividade: Compacto.",
          expandedStyleDefaultTitle: "Padrão (recomendado)",
          expandedStyleDefaultSubtitle: "Cartões: Completo. Feed de atividade: Resumo.",
      },
      terminalConnect: {
        title: "Conexão do terminal",
        legacySecretExportTitle: "Exportação de segredo legado (compatibilidade)",
        legacySecretExportEnabledSubtitle:
          "Ativado: exporta seu segredo legado de conta para o terminal para que terminais antigos possam conectar. Não recomendado.",
        legacySecretExportDisabledSubtitle:
          "Desativado (recomendado): provisione terminais apenas com a chave de conteúdo (Terminal Connect V2).",
      },
    sessionList: {
      title: "Lista de sessões",
      footer: "Personalize o que aparece em cada linha de sessão.",
      tagsTitle: "Tags da sessão",
      tagsEnabledSubtitle: "Controles de tags visíveis na lista de sessões",
      tagsDisabledSubtitle: "Controles de tags ocultos",
    },
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
          enableTtsTitle: "Ativar streaming de TTS",
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
      "Criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo.",
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
  },

    machine: {
    offlineUnableToSpawn:
      "Inicializador desativado enquanto a máquina está offline",
    offlineHelp:
      "• Verifique se seu computador está online\n• Execute `happier daemon status` para diagnosticar\n• Você está usando a versão mais recente do CLI? Atualize com `npm install -g @happier-dev/cli@latest`",
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
    switchToRemote: "Alternar para remoto",
    localModeAvailable: "O modo local está disponível para esta sessão.",
    localModeUnavailableMachineOffline:
      "O modo local não está disponível enquanto esta máquina estiver offline.",
    localModeUnavailableDaemonStarted:
      "O modo local não está disponível para sessões iniciadas pelo daemon.",
    localModeUnavailableNeedsResume:
      "O modo local requer suporte de retomada para este provedor.",
    switchToLocal: "Alternar para local",
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
    defaultSessionType: "Tipo de sessão padrão",
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
