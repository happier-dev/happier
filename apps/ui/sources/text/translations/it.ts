import type { TranslationStructure } from "../_types";

/**
 * Italian plural helper function
 * Italian has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Italian plural rules
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
 * Italian translations for the Happier app
 * Must match the exact structure of the English translations
 */
export const it: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "Amici",
    sessions: "Terminali",
    settings: "Impostazioni",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Nessuna attività degli amici",
    emptyDescription:
      "Aggiungi amici per condividere sessioni e vedere l’attività qui.",
    updates: "Attività",
  },

  runs: {
    title: "Esecuzioni",
    empty: "Ancora nessuna esecuzione.",
    groupLabel: ({ groupId }: { groupId: string }) => `Gruppo ${groupId}`,
    showFinished: "Mostra completate",
    unknownMachine: "Macchina sconosciuta",
    failedToLoad: "Impossibile caricare le esecuzioni",
    noMachinesAvailable: "Nessuna macchina disponibile.",
    serverTitle: ({ serverId }: { serverId: string }) => `Server ${serverId}`,
    machinesSubtitle: "Macchine",
    openMachine: "Apri macchina",
    a11y: {
      toggleFinished: "Attiva/disattiva esecuzioni completate",
      refresh: "Aggiorna esecuzioni",
    },
    openSession: "Apri sessione",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `Sessione ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `esecuzione ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `pid ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "Impossibile caricare l'esecuzione",
      latestToolResultTitle: "Ultimo risultato dello strumento",
      a11y: {
        refreshRun: "Aggiorna esecuzione",
      },
    },
    stop: {
      stopRunA11y: "Interrompi esecuzione",
      stopLabel: "Interrompi esecuzione",
      stoppingLabel: "Interruzione…",
      stopRunFailedTitle: "Impossibile interrompere l'esecuzione",
      stopRunFailedBody:
        "L'interruzione di questa esecuzione tramite RPC della sessione non è riuscita. Vuoi interrompere invece l'intero processo della sessione? È un'azione distruttiva e interromperà tutte le esecuzioni in quella sessione.",
      stopSession: "Interrompi sessione",
      failedToStopRun: "Impossibile interrompere l'esecuzione",
      failedToStopSession: "Impossibile interrompere la sessione",
    },
    send: {
      placeholder: "Invia all'esecuzione…",
      a11y: {
        sendToRun: "Invia all'esecuzione",
      },
      sendLabel: "Invia",
      sendingLabel: "Invio…",
      failedToSend: "Invio non riuscito",
    },
  },

  sessionLog: {
    title: "Log della sessione",
    devModeRequiredTitle: "È richiesto il modo sviluppatore",
    devModeRequiredBody:
      "Abilita il modo sviluppatore nelle impostazioni per vedere i log della sessione.",
    logPathTitle: "Percorso del log",
    unavailable: "Non disponibile",
    logPathCopyLabel: "Percorso del log della sessione",
    refreshTailTitle: "Aggiorna coda del log",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `Leggi gli ultimi ${maxBytes} byte`,
    copyVisibleTitle: "Copia log visibile",
    copyVisibleSubtitleLoaded:
      "Copia la coda corrente negli appunti",
    copyVisibleSubtitleEmpty: "Nessun contenuto di log caricato",
    copyLogLabel: "Log della sessione",
    statusTitle: "Stato del log",
    readErrorTitle: "Errore di lettura",
    tailTitle: "Coda del log",
    tailTitleTruncated: "Coda del log (troncata)",
    noOutputYet: "(Nessun output del log per ora)",
    readFailed: "Impossibile leggere il log della sessione",
  },

  automations: {
    openA11y: "Apri automazioni",
    gate: {
      disabledTitle: "Le automazioni sono disattivate",
      disabledBody:
        "Abilitale in Impostazioni, poi attiva Esperimenti e Automazioni.",
    },
    edit: {
      title: "Modifica automazione",
      saveAutomationLabel: "Salva automazione",
      messageLabel: "MESSAGGIO",
      messagePlaceholder: "Messaggio da inviare",
      messageHelpText:
        "Questo messaggio verrà accodato nella sessione come messaggio utente in sospeso.",
      updateFailed: "Impossibile aggiornare l'automazione.",
      loadTemplateFailed: "Impossibile caricare il modello di automazione.",
    },
    form: {
      groupAutomationTitle: "Automazione",
      groupScheduleTitle: "Pianificazione",
      toggleEnableTitle: "Abilita automazione",
      toggleEnableSubtitle:
        "Crea questo nuovo modello di sessione come automazione pianificata invece di avviare subito.",
      toggleEnabledTitle: "Abilitata",
      toggleEnabledSubtitle:
        "Se disabilitata, non verranno eseguite esecuzioni pianificate.",
      labels: {
        name: "NOME",
        descriptionOptional: "DESCRIZIONE (OPZIONALE)",
        everyMinutes: "OGNI (MINUTI)",
        cronExpression: "ESPRESSIONE CRON",
        timezoneOptional: "FUSO ORARIO (OPZIONALE)",
      },
      placeholders: {
        name: "Sessione pianificata",
        description: "Cosa dovrebbe fare questa automazione?",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC o America/New_York",
      },
      schedule: {
        intervalTitle: "Intervallo",
        intervalSubtitle: "Esegui ogni N minuti.",
        cronTitle: "Espressione cron",
        cronSubtitle: "Espressione di pianificazione avanzata.",
        cronHelpText:
          "Cron standard a 5 campi: minuto ora giorno-del-mese mese giorno-della-settimana.",
      },
    },
    session: {
      emptyTitle: "Nessuna automazione",
      emptyBody:
        "Aggiungi un'automazione per accodare messaggi pianificati in questa sessione.",
      addAutomation: "Aggiungi automazione",
      failedToLoad: "Impossibile caricare le automazioni.",
    },
    screen: {
      emptyTitle: "Ancora nessuna automazione",
      emptyBody:
        "Creane una dal flusso Nuova sessione per eseguire sessioni pianificate sulle tue macchine.",
      createAutomationA11y: "Crea automazione",
    },
    detail: {
      invalidId: "ID automazione non valido.",
      notFound: "Automazione non trovata.",
      unknownDate: "Sconosciuto",
      notScheduled: "Non pianificata",
      overviewGroupTitle: "Panoramica",
      overview: {
        nameTitle: "Nome",
        scheduleTitle: "Pianificazione",
        statusTitle: "Stato",
        nextRunTitle: "Prossima esecuzione",
      },
      status: {
        active: "Attiva",
        paused: "In pausa",
      },
      actionsGroupTitle: "Azioni",
      runNowTitle: "Esegui ora",
      runNowQueuedBadge: "In coda",
      runNowQueuedLine: "In coda.",
      runNowQueuedSubtitle:
        "In coda. Il daemon assegnato la eseguirà quando disponibile.",
      pauseAutomation: "Metti in pausa l'automazione",
      resumeAutomation: "Riprendi automazione",
      editAutomation: "Modifica automazione",
      deleteAutomation: "Elimina automazione",
      deleteConfirmTitle: "Elimina automazione",
      deleteConfirmMessage:
        "Questa automazione e la sua pianificazione verranno rimosse.",
      deleteConfirmButton: "Elimina",
      machineAssignmentsTitle: "Assegnazioni macchina",
      machineAssignmentsFooter:
        "Abilita almeno una macchina perché questa automazione possa essere eseguita.",
      refreshFailed: "Impossibile aggiornare l'automazione.",
      runFailed: "Impossibile eseguire l'automazione.",
      deleteFailed: "Impossibile eliminare l'automazione.",
      assignmentsUpdateFailed:
        "Impossibile aggiornare le assegnazioni macchina.",
      recentRunsTitle: "Esecuzioni recenti",
      runMeta: {
        scheduled: ({ time }: { time: string }) => `Pianificata: ${time}`,
        updated: ({ time }: { time: string }) => `Aggiornata: ${time}`,
        error: ({ message }: { message: string }) => `Errore: ${message}`,
      },
    },
    create: {
      defaultName: "Messaggio programmato",
      createFailed: "Impossibile creare l'automazione.",
      unavailableGroupTitle: "Non disponibile",
      cannotCreateForSession: "Impossibile creare un'automazione per questa sessione",
      sessionNotFound: "Sessione non trovata.",
      missingMachineId: "Questa sessione non ha un ID macchina.",
      missingResumeKey:
        "Questa sessione non ha ancora caricato una chiave di crittografia per la ripresa.",
      createButtonTitle: "Crea automazione",
    },
  },

  appCrash: {
    title: "Qualcosa è andato storto",
    subtitle:
      "Happier ha riscontrato un errore imprevisto. Puoi riavviare l'interfaccia dell'app o copiare i dettagli per l'assistenza.",
    detailsTitle: "Dettagli dell'errore",
    restart: "Riavvia app",
    copyDetails: "Copia dettagli dell'errore",
  },

  webCryptoGate: {
    title: "È richiesta una connessione sicura",
    subtitle:
      "Questa pagina richiede WebCrypto per mantenere i tuoi dati al sicuro. WebCrypto non è disponibile su questa origine perché i browser richiedono un contesto sicuro.",
    howToFix: "Come risolvere",
    fixHttps: "Apri la UI in HTTPS (consigliato).",
    fixTunnel: "Se ti serve l'accesso in LAN, usa un tunnel HTTPS o un reverse proxy con TLS.",
    fixLocalhost:
      "Se sei sulla stessa macchina, usa http://localhost (il loopback è considerato sicuro).",
    currentOrigin: "Origine corrente",
    secureContext: "Contesto sicuro",
    copyDetails: "Copia dettagli",
    reload: "Ricarica",
  },

  common: {
    // Simple string constants
    add: "Aggiungi",
    edit: "Modifica",
    actions: "Azioni",
    moreActions: "Altre azioni",
    moreActionsHint: "Apre un menu con altre azioni",
    cancel: "Annulla",
    close: "Chiudi",
      open: "Apri",
      done: "Fatto",
      reorder: "Riordina",
      authenticate: "Autentica",
      save: "Salva",
    error: "Errore",
    success: "Successo",
    ok: "OK",
    continue: "Continua",
    back: "Indietro",
    start: "Avvia",
    create: "Crea",
    rename: "Rinomina",
    remove: "Rimuovi",
    update: "Aggiorna",
    commit: "Esegui commit",
    history: "Cronologia",
    applied: "Applicato",
    signOut: "Disconnetti",
    keep: "Mantieni",
    use: "Usa",
    reset: "Ripristina",
    logout: "Esci",
    yes: "Sì",
    no: "No",
    on: "Attivo",
    off: "Disattivo",
    discard: "Scarta",
    discardChanges: "Scarta modifiche",
    unsavedChangesWarning: "Hai modifiche non salvate.",
    keepEditing: "Continua a modificare",
    version: "Versione",
    details: "Dettagli",
    copied: "Copiato",
    copy: "Copia",
    copyWithLabel: ({ label }: { label: string }) => `Copia ${label}`,
    expand: "Espandi",
    collapse: "Comprimi",
    command: "Comando",
    scanning: "Scansione...",
    urlPlaceholder: "https://esempio.com",
    home: "Inizio",
    message: "Messaggio",
    send: "Invia",
    attach: "Allega",
    linkFile: "Collega file",
    files: "File",
    path: "Percorso",
    fileViewer: "Visualizzatore file",
    loading: "Caricamento...",
    none: "—",
    unavailable: "Non disponibile",
    dialog: "Finestra di dialogo",
    retry: "Riprova",
    or: "oppure",
    delete: "Elimina",
    deleted: "Eliminato",
    optional: "opzionale",
    noMatches: "Nessuna corrispondenza",
    all: "Tutti",
    machine: "macchina",
    clearSearch: "Cancella ricerca",
    refresh: "Aggiorna",
    default: "Predefinito",
    enabled: "Abilitato",
    disabled: "Disabilitato",
    saveAs: "Salva con nome",
    requestFailed: "Richiesta non riuscita.",
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "Ridimensiona pannello",
      resizeHint:
        "Usa le frecce sinistra e destra per ridimensionare",
    },
  },

  dropdown: {
    category: {
      general: "Generale",
      results: "Risultati",
    },
    createItem: {
      prefix: "Aggiungi",
    },
  },

  profile: {
    userProfile: "Profilo utente",
    details: "Dettagli",
    firstName: "Nome",
    lastName: "Cognome",
    username: "Nome utente",
    status: "Stato",
  },

  profiles: {
    title: "Profili",
    subtitle: "Gestisci i profili delle variabili ambiente per le sessioni",
    sessionUses: ({ profile }: { profile: string }) =>
      `Questa sessione usa: ${profile}`,
    profilesFixedPerSession:
      "I profili sono fissi per sessione. Per usare un profilo diverso, avvia una nuova sessione.",
    noProfile: "Nessun profilo",
    noProfileDescription: "Usa le impostazioni ambiente predefinite",
    defaultModel: "Modello predefinito",
    addProfile: "Aggiungi profilo",
    profileName: "Nome profilo",
    enterName: "Inserisci nome profilo",
    baseURL: "URL base",
    authToken: "Token di autenticazione",
    enterToken: "Inserisci token di autenticazione",
    model: "Modello",
    tmuxSession: "Sessione Tmux",
    enterTmuxSession: "Inserisci nome sessione tmux",
    tmuxTempDir: "Directory temporanea Tmux",
    enterTmuxTempDir: "Inserisci percorso directory temporanea",
    tmuxUpdateEnvironment: "Aggiorna ambiente automaticamente",
    nameRequired: "Il nome del profilo è obbligatorio",
    deleteConfirm: ({ name }: { name: string }) =>
      `Sei sicuro di voler eliminare il profilo "${name}"?`,
    editProfile: "Modifica profilo",
    addProfileTitle: "Aggiungi nuovo profilo",
    builtIn: "Integrato",
    custom: "Personalizzato",
    builtInSaveAsHint:
      "Salvare un profilo integrato crea un nuovo profilo personalizzato.",
    builtInNames: {
      anthropic: "Anthropic (Predefinito)",
      deepseek: "DeepSeek (Ragionamento)",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (Predefinito)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Predefinito)",
      geminiApiKey: "Gemini (API key)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "Preferiti",
      custom: "I tuoi profili",
      builtIn: "Profili integrati",
    },
    actions: {
      viewEnvironmentVariables: "Variabili ambiente",
      addToFavorites: "Aggiungi ai preferiti",
      removeFromFavorites: "Rimuovi dai preferiti",
      editProfile: "Modifica profilo",
      duplicateProfile: "Duplica profilo",
      deleteProfile: "Elimina profilo",
    },
    copySuffix: "(Copia)",
    duplicateName: "Esiste già un profilo con questo nome",
    setupInstructions: {
      title: "Istruzioni di configurazione",
      viewCloudGuide: "Visualizza la guida ufficiale di configurazione",
    },
    machineLogin: {
      title: "Login richiesto sulla macchina",
      subtitle:
        "Questo profilo si basa su una cache di login del CLI sulla macchina selezionata.",
      status: {
        loggedIn: "Accesso effettuato",
        notLoggedIn: "Accesso non effettuato",
      },
      claudeCode: {
        title: "Claude Code",
        instructions: "Esegui `claude`, poi digita `/login` per accedere.",
        warning:
          "Nota: impostare `ANTHROPIC_AUTH_TOKEN` sostituisce il login del CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Esegui `codex login` per accedere.",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "Esegui `gemini auth` per accedere.",
      },
    },
    requirements: {
      secretRequired: "Segreto",
      configured: "Configurata sulla macchina",
      notConfigured: "Non configurata",
      checking: "Verifica…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `Questo profilo richiede la configurazione di ${env} sulla macchina.`,
      modalTitle: "Segreto richiesto",
      modalBody:
        "Questo profilo richiede un segreto.\n\nOpzioni supportate:\n• Usa ambiente della macchina (consigliato)\n• Usa un segreto salvato nelle impostazioni dell’app\n• Inserisci un segreto solo per questa sessione",
      sectionTitle: "Requisiti",
      sectionSubtitle:
        "Questi campi servono per verificare lo stato e evitare fallimenti inattesi.",
      secretEnvVarPromptDescription:
        "Inserisci il nome della variabile d’ambiente segreta richiesta (es. OPENAI_API_KEY).",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `Questo profilo richiede ${env}. Scegli un’opzione qui sotto.`,
      modalHelpGeneric:
        "Questo profilo richiede un segreto. Scegli un’opzione qui sotto.",
      chooseOptionTitle: "Scegli un’opzione",
      machineEnvStatus: {
        theMachine: "la macchina",
        checkFor: ({ env }: { env: string }) => `Controlla ${env}`,
        checking: ({ env }: { env: string }) => `Verifica ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${env} trovato su ${machine}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${env} non trovato su ${machine}`,
      },
      machineEnvSubtitle: {
        checking: "Verifica ambiente del daemon…",
        found: "Trovato nell’ambiente del daemon sulla macchina.",
        notFound:
          "Impostalo nell’ambiente del daemon sulla macchina e riavvia il daemon.",
      },
      options: {
        none: {
          title: "Nessuno",
          subtitle: "Non richiede segreto né login CLI.",
        },
        machineLogin: {
          subtitle:
            "Richiede essere autenticati tramite un CLI sulla macchina di destinazione.",
          longSubtitle:
            "Richiede essere autenticati tramite il CLI per il backend IA scelto sulla macchina di destinazione.",
        },
        useMachineEnvironment: {
          title: "Usa ambiente della macchina",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `Usa ${env} dall’ambiente del daemon.`,
          subtitleGeneric: "Usa il segreto dall’ambiente del daemon.",
        },
        useSavedSecret: {
          title: "Usa un segreto salvato",
          subtitle: "Seleziona (o aggiungi) un segreto salvato nell’app.",
        },
        enterOnce: {
          title: "Inserisci un segreto",
          subtitle:
            "Incolla un segreto solo per questa sessione (non verrà salvato).",
        },
      },
      secretEnvVar: {
        title: "Variabile d’ambiente del segreto",
        subtitle:
          "Inserisci il nome della variabile d’ambiente che questo provider si aspetta per il segreto (es. OPENAI_API_KEY).",
        label: "Nome variabile d’ambiente",
      },
      sections: {
        machineEnvironment: "Ambiente della macchina",
        useOnceTitle: "Usa una volta",
        useOnceLabel: "Inserisci un segreto",
        useOnceFooter:
          "Incolla un segreto solo per questa sessione. Non verrà salvato.",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "Inizia con la chiave già presente sulla macchina.",
        },
        useOnceButton: "Usa una volta (solo sessione)",
      },
    },
    defaultSessionType: "Tipo di sessione predefinito",
    defaultPermissionMode: {
      title: "Modalità di permesso predefinita",
      descriptions: {
        default: "Chiedi permessi",
        acceptEdits: "Approva automaticamente le modifiche",
        plan: "Pianifica prima di eseguire",
        bypassPermissions: "Salta tutti i permessi",
      },
    },
    defaultPermissions: {
      title: "Permessi predefiniti",
      footer:
        "Sovrascrive i permessi predefiniti a livello account per le nuove sessioni quando questo profilo è selezionato.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `Predefinito account: ${label}`,
      useAccountDefault: "Usa predefinito account",
      currently: ({ label }: { label: string }) => `Attualmente: ${label}`,
    },
    aiBackend: {
      title: "Backend IA",
      selectAtLeastOneError: "Seleziona almeno un backend IA.",
      claudeSubtitle: "CLI di Claude",
      codexSubtitle: "CLI di Codex",
      opencodeSubtitle: "CLI di OpenCode",
      geminiSubtitleExperimental: "Gemini CLI (sperimentale)",
      auggieSubtitle: "Auggie CLI",
      qwenSubtitleExperimental: "Qwen Code CLI (sperimentale)",
      kimiSubtitleExperimental: "Kimi CLI (sperimentale)",
      kiloSubtitleExperimental: "Kilo CLI (sperimentale)",
      piSubtitleExperimental: "Pi CLI (sperimentale)",
      copilotSubtitleExperimental: "GitHub Copilot CLI (sperimentale)",
    },
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Avvia sessioni in Tmux",
      spawnSessionsEnabledSubtitle:
        "Le sessioni vengono avviate in nuove finestre di tmux.",
      spawnSessionsDisabledSubtitle:
        "Le sessioni vengono avviate in una shell normale (senza integrazione tmux)",
      isolatedServerTitle: "Server tmux isolato",
      isolatedServerEnabledSubtitle:
        "Avvia le sessioni in un server tmux isolato (consigliato).",
      isolatedServerDisabledSubtitle:
        "Avvia le sessioni nel server tmux predefinito.",
      sessionNamePlaceholder: "Vuoto = sessione corrente/più recente",
      tempDirPlaceholder: "Lascia vuoto per generare automaticamente",
    },
    previewMachine: {
      title: "Anteprima macchina",
      itemTitle: "Macchina di anteprima per variabili d'ambiente",
      selectMachine: "Seleziona macchina",
      resolveSubtitle:
        "Usata solo per l'anteprima dei valori risolti sotto (non cambia ciò che viene salvato).",
      selectSubtitle:
        "Seleziona una macchina per l'anteprima dei valori risolti sotto.",
    },
    environmentVariables: {
      title: "Variabili ambiente",
      addVariable: "Aggiungi variabile",
      namePlaceholder: "Nome variabile (es., MY_CUSTOM_VAR)",
      valuePlaceholder: "Valore (es., my-value o ${MY_VAR})",
      validation: {
        nameRequired: "Inserisci un nome variabile.",
        invalidNameFormat:
          "I nomi delle variabili devono usare lettere maiuscole, numeri e underscore e non possono iniziare con un numero.",
        duplicateName: "Questa variabile esiste già.",
      },
      card: {
        valueLabel: "Valore:",
        fallbackValueLabel: "Valore di fallback:",
        valueInputPlaceholder: "Valore",
        defaultValueInputPlaceholder: "Valore predefinito",
        fallbackDisabledForVault:
          "I fallback sono disabilitati quando usi il vault dei segreti.",
        secretNotRetrieved: "Valore segreto - non recuperato per sicurezza",
        secretToggleLabel: "Nascondi il valore nella UI",
        secretToggleSubtitle:
          "Nasconde il valore nella UI ed evita di recuperarlo dalla macchina per l'anteprima.",
        secretToggleEnforcedByDaemon: "Imposto dal daemon",
        secretToggleEnforcedByVault: "Imposto dal vault dei segreti",
        secretToggleResetToAuto: "Ripristina su automatico",
        requirementRequiredLabel: "Obbligatorio",
        requirementRequiredSubtitle:
          "Blocca la creazione della sessione quando la variabile manca.",
        requirementUseVaultLabel: "Usa vault dei segreti",
        requirementUseVaultSubtitle:
          "Usa un segreto salvato (senza valori di fallback).",
        defaultSecretLabel: "Segreto predefinito",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `Sostituzione del valore predefinito documentato: ${expectedValue}`,
        useMachineEnvToggle: "Usa valore dall'ambiente della macchina",
        resolvedOnSessionStart:
          "Risolto quando la sessione viene avviata sulla macchina selezionata.",
        sourceVariableLabel: "Variabile sorgente",
        sourceVariablePlaceholder: "Nome variabile sorgente (es., Z_AI_MODEL)",
        checkingMachine: ({ machine }: { machine: string }) =>
          `Verifica ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `Vuoto su ${machine}`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Vuoto su ${machine} (uso fallback)`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `Non trovato su ${machine}`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Non trovato su ${machine} (uso fallback)`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `Valore trovato su ${machine}`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `Diverso dal valore documentato: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - nascosto per sicurezza`,
        hiddenValue: "***nascosto***",
        emptyValue: "(vuoto)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `La sessione riceverà: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `Variabili ambiente · ${profileName}`,
        descriptionPrefix:
          "Queste variabili ambiente vengono inviate all'avvio della sessione. I valori vengono risolti dal daemon su",
        descriptionFallbackMachine: "la macchina selezionata",
        descriptionSuffix: ".",
        emptyMessage:
          "Nessuna variabile ambiente è impostata per questo profilo.",
        checkingSuffix: "(verifica…)",
        detail: {
          fixed: "Fisso",
          machine: "Macchina",
          checking: "Verifica",
          fallback: "Alternativa",
          missing: "Mancante",
        },
      },
    },
    delete: {
      title: "Elimina profilo",
      message: ({ name }: { name: string }) =>
        `Sei sicuro di voler eliminare "${name}"? Questa azione non può essere annullata.`,
      confirm: "Elimina",
      cancel: "Annulla",
    },
  },

  status: {
    connected: "connesso",
    connecting: "connessione in corso",
    disconnected: "disconnesso",
    error: "errore",
    online: "in linea",
    offline: "non in linea",
    lastSeen: ({ time }: { time: string }) => `visto l'ultima volta ${time}`,
    actionRequired: "azione richiesta",
    permissionRequired: "permesso richiesto",
    activeNow: "Attivo ora",
    unknown: "sconosciuto",
  },

  connectionStatus: {
    title: "Connessione",
    labels: {
      server: "Server (servizio)",
      socket: "WebSocket",
      authenticated: "Autenticato",
      lastSync: "Ultima sincronizzazione",
      nextRetry: "Prossimo tentativo",
      lastError: "Ultimo errore",
    },
  },

  time: {
    justNow: "proprio ora",
    minutesAgo: ({ count }: { count: number }) =>
      `${count} ${count === 1 ? "minuto" : "minuti"} fa`,
    hoursAgo: ({ count }: { count: number }) =>
      `${count} ${count === 1 ? "ora" : "ore"} fa`,
  },

  connect: {
    restoreAccount: "Ripristina account",
    enterSecretKey: "Inserisci la chiave segreta",
    invalidSecretKey: "Chiave segreta non valida. Controlla e riprova.",
    enterUrlManually: "Inserisci URL manualmente",
    scanComputerQrUnavailableTitle: "Scansione QR dal computer non disponibile",
    scanComputerQrUnavailableBody:
      "Questo metodo di accesso è disattivato su questo server. Usa un’altra opzione qui sotto per ripristinare il tuo account.",
    scanComputerQrInstructions: "Scansiona il codice QR mostrato in Happier sul tuo computer (Impostazioni → Aggiungi il tuo telefono).",
    scanComputerQrButton: "Scansiona QR per accedere",
    waitingForApproval: "In attesa di approvazione…",
    showQrInstead: "Mostra invece un codice QR",
    addPhoneQrInstructions: "Scansiona questo codice QR con l’app mobile Happier per accedere sul tuo telefono.",
    pairingRequestTitle: "Richiesta di abbinamento",
    pairingRequestBody: "Verifica che questo codice corrisponda a quello visualizzato sul telefono, poi approva.",
    pairingAlreadyRequestedTitle: "Codice già usato",
    pairingAlreadyRequestedBody:
      "Questo codice QR è già stato scansionato su un altro telefono. Chiedi al computer di generarne uno nuovo.",
    deviceLabel: "Dispositivo",
    confirmCodeLabel: "Codice di conferma",
    approveButton: "Approva",
    generateNewQrCode: "Genera un nuovo codice QR",
    pairingQrExpired: "Questo codice QR è scaduto. Generane uno nuovo.",
    openMachine: "Apri macchina",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "Su un dispositivo dove hai già effettuato l’accesso, vai su Impostazioni → Account e scansiona questo codice QR.",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} verificato`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `Abbiamo trovato un account Happier esistente collegato a ${provider}. Per completare l'accesso su questo dispositivo, ripristina la chiave del tuo account con il codice QR o con la tua chiave segreta.`,
    restoreWithSecretKeyInstead: "Ripristina con chiave segreta",
    restoreWithSecretKeyDescription:
      "Inserisci la chiave segreta per ripristinare l’accesso al tuo account.",
    lostAccessLink: "Accesso perso?",
    lostAccessTitle: "Hai perso l’accesso al tuo account?",
    lostAccessBody:
      "Se non hai più alcun dispositivo collegato a questo account e hai perso la chiave segreta, puoi reimpostare l’account usando il provider di identità. Verrà creato un nuovo account Happier. La vecchia cronologia cifrata non può essere recuperata.",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `Continua con ${provider}`,
    lostAccessConfirmTitle: "Reimpostare l’account?",
    lostAccessConfirmBody:
      "Questo creerà un nuovo account e ricollegherà la tua identità del provider. La vecchia cronologia cifrata non può essere recuperata.",
    lostAccessConfirmButton: "Reimposta e continua",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    linkNewDeviceTitle: "Collega nuovo dispositivo",
    linkNewDeviceSubtitle: "Scansiona il codice QR mostrato sul nuovo dispositivo per collegarlo a questo account",
    linkNewDeviceQrInstructions: "Apri Happier sul nuovo dispositivo e mostra il codice QR",
    scanQrCodeOnDevice: "Scansiona codice QR",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Connetti ${name}`,
      runCommandInTerminal: "Esegui il seguente comando nel terminale:",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `Esegui il seguente comando nel terminale:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "Anteprima non disponibile",
        previewUnavailableBody: "Impossibile creare l’anteprima della diagnostica.",
        submittedTitle: "Segnalazione bug inviata",
        submittedExistingIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `È stato pubblicato un commento sull’issue #${issueNumber}.\n\nID segnalazione: ${reportId}`,
        submittedNewIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `È stata creata l’issue #${issueNumber}.\n\nID segnalazione: ${reportId}`,
        submitFailedTitle: "Invio non riuscito",
        submitFailedFallbackMessage: "Impossibile inviare questa segnalazione.",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\nVuoi invece aprire un’issue GitHub precompilata?`,
        openFallbackIssueButton: "Apri issue alternativa",
      },
      diagnostics: {
        title: "Diagnostica",
        subtitle: "Scegli cosa includere e fai un’anteprima prima di inviare.",
        includeTitle: "Includi diagnostica",
        includeSubtitle:
          "Allega artefatti di debug sanitizzati per una diagnosi più rapida.",
        disabledByServerSuffix: " (disabilitato dal server)",
        pasteDoctorJson: {
          title: "CLI doctor JSON (opzionale)",
          subtitle:
            "Se la tua macchina non è raggiungibile dalla UI, esegui `happier doctor --json` sul computer e incollalo qui.",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `Doctor JSON non valido: ${error}`,
          valid: "Il doctor JSON sembra valido e verrà allegato alla segnalazione.",
        },
        previewButton: "Anteprima diagnostica",
        preview: {
          title: "Anteprima diagnostica",
          helper:
            "Questi artefatti verranno caricati con la tua segnalazione (sanitizzati e con dimensione limitata). Tocca un elemento per vedere il contenuto completo.",
          empty: "Non verrebbero inviati artefatti diagnostici.",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `Apri ${filename}`,
        },
        kinds: {
          app: {
            title: "Diagnostica app",
            detail:
              "Log console dell’app, azioni recenti dell’utente e riepilogo sessione.",
          },
          daemon: {
            title: "Diagnostica demone",
            detail:
              "Riepilogo del demone e log recenti del demone dalle macchine selezionate.",
          },
          stackService: {
            title: "Diagnostica servizio Stack",
            detail:
              "Contesto dello stack e log recenti dello stack (se disponibili).",
          },
          server: {
            title: "Diagnostica server",
            detail: "Snapshot del server attualmente attivo.",
          },
        },
      },
      issueDetails: {
        title: "Descrivi il problema",
        subtitle:
          "Fornisci abbastanza dettagli per consentirci di riprodurre e diagnosticare rapidamente.",
        titleLabel: "Titolo (obbligatorio)",
        titlePlaceholder: "Titolo breve",
        githubUsernameLabel: "Username GitHub (opzionale)",
        githubUsernamePlaceholder:
          "Usato come contatto nel corpo dell’issue",
        summaryLabel: "Riepilogo conciso (obbligatorio)",
        summaryPlaceholder: "Riepilogo in un paragrafo",
        currentBehaviorLabel: "Comportamento attuale (opzionale)",
        currentBehaviorPlaceholder: "Cosa succede davvero?",
        expectedBehaviorLabel: "Comportamento previsto (opzionale)",
        expectedBehaviorPlaceholder: "Cosa dovrebbe succedere invece?",
        reproductionStepsLabel: "Passaggi di riproduzione (opzionale)",
        reproductionStepsPlaceholder:
          "1. Apri Happier\n2. Avvia una sessione\n3. ...",
        whatChangedLabel: "Cosa è cambiato di recente (opzionale)",
        whatChangedPlaceholder:
          "Aggiornamenti, modifiche di configurazione, nuovi passaggi di setup...",
      },
      similarIssues: {
        title: "Possibili duplicati",
        subtitle:
          "Se uno di questi corrisponde, puoi pubblicare il tuo report come commento invece di aprire una nuova issue.",
        searching: "Ricerca delle issue…",
        selectedTitle: ({ number }: { number: number }) =>
          `Usando la issue #${number}`,
        selectedSubtitle: "Tocca per tornare a creare una nuova issue.",
        useIssueA11y: ({ number }: { number: number }) => `Usa issue #${number}`,
        issueState: {
          open: "Issue aperta",
          closed: "Issue chiusa",
        },
      },
      frequencySeverity: {
        title: "Frequenza e gravità",
        frequencyLabel: "Frequenza",
        severityLabel: "Gravità",
        frequency: {
          always: "Sempre",
          often: "Spesso",
          sometimes: "A volte",
          once: "Una volta",
        },
        severity: {
          blocker: "Bloccante",
          high: "Alta",
          medium: "Media",
          low: "Bassa",
        },
      },
      environment: {
        title: "Ambiente (modificabile)",
        appVersionLabel: "Versione app",
        platformLabel: "Piattaforma",
        osVersionLabel: "Versione OS",
        deviceModelLabel: "Modello dispositivo",
        serverUrlLabel: "URL server",
        serverVersionLabel: "Versione server (opzionale)",
        deploymentTypeLabel: "Tipo di deployment",
        deploymentType: {
          cloud: "Cloud (gestito)",
          selfHosted: "Autogestito",
          enterprise: "Aziendale",
        },
      },
      consent: {
        title: "Consenso",
        understandTitle:
          "Capisco che la diagnostica può includere metadati tecnici",
        understandSubtitle:
          "Non includere password, token di accesso o chiavi private.",
      },
      submit: {
        requiredFieldsHint:
          "Completa i campi obbligatori per abilitare l’invio.",
        submitting: "Invio della segnalazione…",
        addToIssue: ({ number }: { number: number }) =>
          `Aggiungi all’issue #${number}`,
        submitNew: "Invia segnalazione bug",
      },
    },
  },

    memorySearchSettings: {
    disabled: {
      footer:
        "Abilita la ricerca memoria nelle Funzionalità per configurare l’indicizzazione locale.",
      title: "La ricerca memoria è disabilitata",
      subtitle: "Apri Impostazioni → Funzionalità per abilitare memory.search",
      openFeatureSettings: "Apri impostazioni delle funzionalità",
      alertTitle: "Ricerca memoria disabilitata",
      alertBody: "Abilita memory.search in Impostazioni → Funzionalità.",
    },
      enabled: {
        title: "Abilitato",
        subtitle: "Crea e mantieni un indice locale su questa macchina",
        footer:
          "Quando abilitato, Happier crea un indice locale sul dispositivo derivato da trascrizioni decriptate per supportare richiamo e ricerca rapidi.",
      },
      budgets: {
        groupTitle: "Budget disco",
        groupFooter:
          "Limita lo spazio su disco che può usare l'indice di memoria locale (evizione best-effort).",
        mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
        lightTitle: "Budget indice leggero",
        lightPromptTitle: "Budget indice leggero",
        lightPromptBody:
          "MB massimi per l’indice leggero (frammenti di riepilogo) su questa macchina.",
        deepTitle: "Budget indice profondo",
        deepPromptTitle: "Budget indice profondo",
        deepPromptBody:
          "MB massimi per l’indice profondo (chunk) su questa macchina.",
      },
      privacy: {
        groupTitle: "Riservatezza",
        groupFooter:
          "Elimina gli indici derivati locali e le cache dei modelli quando disattivi la ricerca nella memoria.",
        deleteOnDisableTitle: "Elimina alla disattivazione",
        deleteOnDisableSubtitle:
          "Rimuove indici e cache locali quando la ricerca nella memoria è disattivata",
      },
      screen: {
        machineLabel: ({ machine }: { machine: string }) => `Macchina: ${machine}`,
        searchPlaceholder: "Cerca nella memoria",
        enableLocalSearch: "Abilita ricerca memoria locale",
      },
    machine: {
      title: "Macchina",
      changeTitle: "Cambia macchina",
      noMachine: "Nessuna macchina",
    },
    indexMode: {
      title: "Modalità indice",
      footer:
        "La modalità leggera salva piccoli frammenti di riepilogo. La modalità profonda può trovare di più ma usa più disco.",
      triggerTitle: "Modalità",
      options: {
        lightTitle: "Leggera (consigliata)",
        lightSubtitle: "Solo frammenti di riepilogo",
        deepTitle: "Profonda",
        deepSubtitle: "Indicizza frammenti dei messaggi localmente",
      },
    },
      backfill: {
        title: "Recupero storico",
        footer:
          "Controlla quanta cronologia viene indicizzata quando abiliti la memoria locale.",
        triggerTitle: "Criterio",
        options: {
          newOnlyTitle: "Solo nuovo (consigliata)",
          newOnlySubtitle: "Indicizza solo contenuti creati dopo l’abilitazione",
          last30DaysTitle: "Ultimi 30 giorni",
        last30DaysSubtitle: "Backfill delle sessioni recenti",
        allHistoryTitle: "Tutta la cronologia",
        allHistorySubtitle: "Backfill di tutto (può richiedere tempo)",
      },
    },
    hints: {
      title: "Generazione hint memoria",
      footer:
        "Controlla come vengono generati i frammenti di riepilogo per la ricerca memoria leggera.",
      backend: {
        title: "Backend del riepilogatore",
        promptTitle: "Backend del riepilogatore",
        promptBody:
          "Inserisci un id backend di execution-run (es. claude, codex).",
      },
      model: {
        title: "Modello del riepilogatore",
        promptTitle: "Modello del riepilogatore",
        promptBody: "Inserisci un id modello da passare al backend.",
      },
      permissions: {
        triggerTitle: "Permessi del riepilogatore",
        options: {
          noToolsTitle: "Nessun tool (consigliata)",
          noToolsSubtitle: "Riepiloga solo testo",
          readOnlyTitle: "Sola lettura",
          readOnlySubtitle:
            "Consenti tool non mutanti quando supportati",
        },
      },
    },
    embeddings: {
      groupTitle: "Embedding",
      groupFooter:
        "Opzionale: scarica un modello locale per migliorare le corrispondenze semantiche in modalità Deep.",
      enableTitle: "Abilita embeddings",
      enableSubtitle:
        "Migliora il ranking per la ricerca profonda (scarica un modello al primo utilizzo)",
      modelTitle: "Modello embeddings",
      promptBody: "Inserisci un id di modello transformers locale.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
    },
    },

      subAgentGuidance: {
        ruleEditor: {
        header: {
          newRule: "Nuova regola",
          editRule: "Modifica regola",
        },
        enabled: {
          title: "Abilitato",
        },
        enabledState: {
          enabled: "Abilitato",
          disabled: "Disabilitato",
        },
        common: {
          noPreference: "Nessuna preferenza",
        },
        titleField: {
          label: "Titolo (opzionale)",
          placeholder: "es. lavoro UI",
        },
        descriptionField: {
          label: "Quando l’agente dovrebbe delegare?",
          placeholder: "Descrivi quando/come delegare…",
        },
        backendPicker: {
          title: "Backend di destinazione (opzionale)",
          searchPlaceholder: "Cerca backend",
          noPreference: {
            subtitle: "Lascia che l’agente scelga un backend.",
          },
        },
        modelPicker: {
          title: "Modello di destinazione (opzionale)",
          searchPlaceholder: "Cerca modelli",
          noPreference: {
            subtitle: "Lascia che il backend scelga un modello predefinito.",
          },
        },
        intent: {
          title: "Intento suggerito (opzionale)",
          noPreference: {
            subtitle: "Lascia che l’agente decida l’intento.",
          },
          options: {
            review: {
              title: "Revisione",
              subtitle: "Revisione codice / risultati.",
            },
            plan: {
              title: "Piano",
              subtitle: "Pianificazione / architettura.",
            },
            delegate: {
              title: "Delega",
              subtitle: "Delega / esecuzione.",
            },
          },
        },
          exampleToolCalls: {
            label: "Esempi di chiamate agli strumenti (opzionale, una per riga)",
            placeholder: "es. execution.run.start …",
          },
        },
        settings: {
          groupTitle: "Sub-agente",
          disabled: {
            footer:
              "Execution runs è disabilitato. Abilita Execution Runs in Impostazioni → Funzionalità per usare la guida alla delega.",
            enableExecutionRuns: {
              title: "Abilita Execution Runs",
              subtitle: "Apri le impostazioni Funzionalità",
            },
          },
          footer:
            "Le regole vengono aggiunte al prompt di sistema, così l’agente principale sa quando e come preferisci avviare run di sub-agenti.",
          enableInjection: {
            title: "Abilita iniezione guida",
          },
          characterBudget: {
            title: "Limite caratteri",
            subtitle: ({ value }: { value: string }) => `${value} caratteri`,
            promptTitle: "Limite caratteri",
            promptBody:
              "Numero massimo di caratteri da inserire nel prompt di sistema.",
          },
          rules: {
            groupTitle: "Regole di guida",
            footerEnabled:
              "Tocca una regola per modificarla. L’agente le usa come indizi di delega.",
            footerDisabled: "Abilita l’iniezione per attivare le regole.",
            emptyTitle: "Nessuna regola",
            emptySubtitle: "Aggiungi una regola per guidare la delega.",
            addRuleTitle: "Aggiungi regola",
            addRuleSubtitle: "Crea una nuova regola di guida",
            untitled: "Regola senza titolo",
            descriptionFallback: "Descrivi quando delegare.",
            tapToEdit: "Tocca per modificare",
            meta: {
              target: ({ value }: { value: string }) => `Obiettivo: ${value}`,
              model: ({ value }: { value: string }) => `Modello: ${value}`,
              intent: ({ value }: { value: string }) => `Intento: ${value}`,
            },
          },
          preview: {
            title: "Anteprima",
            footer:
              "Questo è il testo (troncato) aggiunto al prompt di sistema.",
            systemPromptLabel: "Prompt di sistema (aggiunto)",
          },
        },
      },

    settings: {
      title: "Impostazioni",
      connectedAccounts: "Account collegati",
    connectedAccountsDisabled: "I servizi connessi sono disabilitati.",
    connectAccount: "Collega account",
    github: "GitHub",
    machines: "Macchine",
    features: "Funzionalità",
    social: "Social (amici)",
    account: "Account utente",
    accountSubtitle: "Gestisci i dettagli del tuo account",
    addYourPhone: "Aggiungi il tuo telefono",
    addYourPhoneSubtitle: "Mostra un codice QR per accedere sul tuo telefono",
    appearance: "Aspetto",
    appearanceSubtitle: "Personalizza l'aspetto dell'app",
      voiceAssistant: "Assistente vocale",
      voiceAssistantSubtitle: "Configura le preferenze vocali",
      memorySearch: "Ricerca memoria locale",
      memorySearchSubtitle: "Cerca nelle conversazioni passate (sul dispositivo)",
      notifications: "Notifiche",
      notificationsSubtitle: "Preferenze notifiche push",
      attachments: "Allegati",
      attachmentsSubtitle: "Preferenze caricamento file",
      sourceControl: "Controllo di versione",
      sourceControlSubtitle: "Strategia di commit e comportamento del backend",
      automations: "Automazioni",
      automationsSubtitle: "Gestisci sessioni pianificate e run ricorrenti",
      executionRunsSubtitle: "Esecuzioni su più macchine",
      connectedServices: "Servizi connessi",
      connectedServicesSubtitle: "Abbonamenti Claude/Codex e profili OAuth",
      featuresTitle: "Funzionalità",
      featuresSubtitle: "Abilita o disabilita le funzionalità dell'app",
    developer: "Sviluppatore",
    developerTools: "Strumenti sviluppatore",
    about: "Informazioni",
    actionsSettingsAboutSubtitle:
      "Abilita o disabilita le azioni globalmente, per superficie (UI/voce/MCP) e per posizionamento (dove compaiono nell’interfaccia). Le azioni disabilitate vengono bloccate in modo sicuro a runtime.",
    aboutFooter:
      "Happier Coder è un client mobile per Codex e Claude Code. È completamente cifrato end-to-end e il tuo account è memorizzato solo sul tuo dispositivo. Non affiliato con Anthropic.",
    whatsNew: "Novità",
    whatsNewSubtitle: "Scopri gli ultimi aggiornamenti e miglioramenti",
    reportIssue: "Segnala un problema",
    privacyPolicy: "Informativa sulla privacy",
    termsOfService: "Termini di servizio",
    eula: "EULA",
    supportUs: "Sostienici",
    supportUsSubtitlePro: "Grazie per il tuo supporto!",
    supportUsSubtitle: "Sostieni lo sviluppo del progetto",
    scanQrCodeToAuthenticate: "Scansiona il codice QR per connettere il terminale",
    githubConnected: ({ login }: { login: string }) =>
      `Connesso come @${login}`,
    connectGithubAccount: "Collega il tuo account GitHub",
    claudeAuthSuccess: "Connesso a Claude con successo",
    exchangingTokens: "Scambio dei token...",
    usage: "Utilizzo",
    usageSubtitle: "Vedi il tuo utilizzo API e i costi",
    profiles: "Profili",
    profilesSubtitle:
      "Gestisci i profili delle variabili ambiente per le sessioni",
    secrets: "Segreti",
    secretsSubtitle:
      "Gestisci i segreti salvati (non verranno più mostrati dopo l’inserimento)",
    terminal: "Terminale",
    session: "Sessione",
    sessionSubtitleTmuxEnabled: "Tmux abilitato",
    sessionSubtitleMessageSendingAndTmux: "Invio messaggi e tmux",
    servers: "Server",
    serversSubtitle: "Server salvati, gruppi e impostazioni predefinite",
    systemStatus: "Stato del sistema",
    systemStatusSubtitle: "Server, account, macchine, daemon",

    // Dynamic settings messages
    accountConnected: ({ service }: { service: string }) =>
      `Account ${service} collegato`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} è ${status === "online" ? "online" : "offline"}`,
  featureToggled: ({
      feature,
      enabled,
    }: {
      feature: string;
      enabled: boolean;
    }) => `${feature} ${enabled ? "abilitata" : "disabilitata"}`,
  },

  systemStatus: {
    sections: {
      appHealth: "Salute app e sincronizzazione",
      currentServer: "Server attuale",
      identity: "Identità autenticata",
      configuredServers: "Server configurati",
      machinesActiveServer: "Macchine (server attivo)",
      machinesOtherServer: ({ server }: { server: string }) => `Macchine (${server})`,
      actions: "Azioni",
    },
    ui: {
      dataReady: "Dati pronti",
      realtime: "Tempo reale",
      socket: "Socket (WebSocket)",
      socketLastError: ({ error }: { error: string }) => `Ultimo errore: ${error}`,
      lastSync: "Ultima sincronizzazione",
    },
    server: {
      activeServer: "Server attivo",
    },
    identity: {
      accountId: "ID account",
      username: "Nome utente",
    },
    servers: {
      noneConfigured: "Nessun server configurato",
      active: "Attivo",
    },
    machines: {
      none: "Nessuna macchina",
      status: ({ status }: { status: string }) => `Stato: ${status}`,
    },
    machine: {
      unknownHost: "Macchina sconosciuta",
      online: "In linea",
      offline: "Non in linea",
      fetchDoctorSnapshot: {
        loading: "Recupero server/account del daemon…",
        invalid: "Impossibile leggere lo snapshot doctor dalla macchina",
      },
      daemonAttributionUnknown: "Server/account del daemon: sconosciuto",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `Daemon: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `Ultimo controllo: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "Incongruenza",
    time: {
      secondsAgo: ({ count }: { count: number }) => `${count}s fa`,
      minutesAgo: ({ count }: { count: number }) => `${count}m fa`,
      hoursAgo: ({ count }: { count: number }) => `${count}h fa`,
      daysAgo: ({ count }: { count: number }) => `${count}g fa`,
    },
    actions: {
      runDiagnosis: "Esegui diagnosi",
      runDiagnosisSubtitle: "Rileva mismatch di server/account/daemon",
      refreshMachineAttribution: "Aggiorna attribuzione daemon",
      refreshMachineAttributionSubtitle: "Recupera server/account del daemon per alcune macchine online",
      copyJson: "Copia JSON Stato del sistema",
      copyJsonSubtitle: "Condividi uno snapshot redatto per il supporto",
    },
  },

  diagnosis: {
    title: "Diagnosi",
    sections: {
      overview: "Panoramica",
      actions: "Azioni",
      pasteDoctorJson: "Incolla doctor JSON del CLI",
      machineRuns: "Esecuzioni sulle macchine",
      serverProbe: "Probe server",
      findings: "Risultati",
    },
    overview: {
      activeServer: "Server attivo",
      account: "Account utente",
      onlineMachines: "Macchine online (server attivo)",
      cachedAttribution: ({ count }: { count: number }) => `${count} snapshot doctor in cache disponibili`,
    },
    actions: {
      run: "Esegui diagnosi",
      runSubtitle: "Controlla server, account, macchine e targeting del daemon",
      copyReport: "Copia report di diagnosi",
      copyReportSubtitle: "Copia un report JSON redatto per il supporto",
    },
    pasteDoctorJson: {
      footer: "Suggerimento: esegui `happier doctor --json` sul computer e incollalo qui.",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "Valida JSON incollato",
      ok: "Il doctor JSON incollato sembra valido.",
      helper: "Opzionale: incolla doctor JSON per diagnosticare mismatch quando la macchina non è raggiungibile.",
      error: ({ error }: { error: string }) => `Doctor JSON non valido: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "La macchina ha restituito uno snapshot doctor non valido",
    },
    machineRuns: {
      none: "Nessuna macchina online disponibile",
      idle: "Inattivo",
      loading: "In esecuzione…",
      ready: "Pronto",
      error: "Errore",
    },
    serverProbe: {
      title: "Diagnostica server",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "Esegui la diagnosi per vedere i risultati",
      notRunSubtitle: "Esegue controlli sicuri e redatti (nessun log a meno che non includi diagnostica in un bug report).",
      none: "Nessun problema rilevato",
      noneSubtitle: "Se il problema persiste, invia un bug report con diagnostica.",
      code: ({ code }: { code: string }) => `Codice: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `Dettagli per ${code}`,
        steps: {
          reportIssue: "Invia un bug report e includi questo report di diagnosi.",
        },
      },
      serverMismatch: {
        title: "Mismatch server (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          chooseAccount: "Decidi quale server/account vuoi usare.",
          switchUiServer: "Allinea UI e daemon allo stesso server.",
          restartDaemon: "Riavvia il daemon puntando al server corretto e riprova.",
        },
      },
      serverMismatchPasted: {
        title: "Mismatch server (UI vs doctor incollato)",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • Incollato: ${pasted}`,
      },
      settingsMismatch: {
        title: "Mismatch tra settings del CLI e server risolto",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • risolto: ${resolved}`,
      },
      accountMismatch: {
        title: "Mismatch account (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          signInSameAccount: "Assicurati che UI e CLI usino lo stesso account sullo stesso server.",
          cliReauth: "Nel CLI: disconnettiti e autentica di nuovo sul server corretto.",
        },
      },
      machineMissingAccount: {
        title: "La macchina non ha informazioni sull’account",
      },
      noOnlineMachines: {
        title: "Nessuna macchina online",
        steps: {
          startDaemon: "Avvia il daemon (e assicurati che rimanga in esecuzione).",
          checkNetwork: "Controlla la rete e riprova.",
        },
      },
      serverDiagnosticsDisabled: {
        title: "Diagnostica server disabilitata",
        steps: {
          ok: "È normale se il tuo server ha la diagnostica disabilitata.",
        },
      },
      serverAuthError: {
        title: "Errore di autenticazione server (401)",
      },
      serverUnreachable: {
        title: "Server non raggiungibile",
        steps: {
          checkServerUrl: "Verifica l’URL del server e la connettività di rete.",
          tryAgain: "Riprova tra un momento.",
        },
      },
      serverHttpError: {
        title: "Errore HTTP diagnostica server",
        subtitle: ({ status }: { status: string }) => `Il server ha risposto con ${status}`,
      },
      activeServerNotInProfiles: {
        title: "Server attivo non presente nei profili salvati",
      },
      multipleServers: {
        title: "Rilevati più server tra le macchine",
      },
    },
  },

  connectedServices: {
    fallbackName: "Servizio connesso",
    title: "Servizi connessi",
    authChip: {
      label: "Autenticazione",
      labelWithCount: ({ count }: { count: number }) => `Autenticazione: ${count}`,
    },
    list: {
      empty: "Nessun servizio connesso per ora.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "connesso", plural: "connessi" })}`,
      needsReauth: "richiede ri-autenticazione",
      notConnected: "non connesso",
    },
    quota: {
      loading: "Caricamento…",
      error: ({ message }: { message: string }) => `Errore: ${message}`,
      lastUpdated: ({ time }: { time: string }) =>
        `Ultimo aggiornamento: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Ultimo aggiornamento: ${time} • obsoleto`,
      noData: "Nessun dato quota ancora",
      planLabel: ({ plan }: { plan: string }) => `Piano: ${plan}`,
    },
    oauthPaste: {
      invalidConfig: "Configurazione del servizio connesso non valida.",
      connectWebGroupTitle: "Connetti (web)",
      connectWebDescription:
        "Questo flusso usa un passaggio di reindirizzamento copia/incolla (come OpenClaw) e un proxy del server Happier per scambiare i token in modo sicuro.",
      openAuthorizationUrl: "Apri URL di autorizzazione",
      opensInNewTab: "Si apre in una nuova scheda",
      preparing: "Preparazione…",
      pasteRedirectUrl: "Incolla URL di reindirizzamento",
      pasteRedirectUrlPromptBody:
        "Dopo aver completato OAuth, copia l’URL finale reindirizzato dalla barra degli indirizzi del browser e incollalo qui.",
      tryDeviceInstead: "Prova l’autenticazione del dispositivo",
      tryEmbeddedInstead: "Prova il browser integrato",
      working: "Elaborazione…",
      alerts: {
        connectedTitle: "Connesso",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) è connesso.`,
        failedToOpenUrl: "Impossibile aprire l’URL",
        failedToConnect: "Connessione non riuscita",
      },
    },
    deviceAuth: {
      invalidConfig: "Configurazione del servizio connesso non valida.",
      title: "Connetti (dispositivo)",
      description:
        "Apri la pagina di verifica, inserisci il codice e mantieni questa schermata aperta finché la connessione non è completata.",
      openVerificationUrl: "Apri pagina di verifica",
      userCode: "Codice utente",
      securityHint:
        "Suggerimento: tocca Copia per copiare il codice. Inseriscilo solo su auth.openai.com. Non condividerlo con nessuno.",
      deviceAuthDisabledHint:
        "Se la pagina di verifica indica che l'autorizzazione tramite codice dispositivo è disabilitata, abilita “Enable device code authorization for Codex” nelle impostazioni di ChatGPT e riprova.",
      preparing: "Preparazione…",
      waiting: "In attesa di approvazione…",
      polling: "Verifica dell'approvazione…",
      usePasteInstead: "Usa invece l'URL di reindirizzamento incollato",
      useBrowserInstead: "Usa invece il browser in-app",
      alerts: {
        connectedTitle: "Connesso",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) è connesso.`,
        failedToConnect: "Connessione non riuscita",
        failedToStart: "Impossibile avviare l'autenticazione del dispositivo",
      },
    },
    detail: {
      unknownService: "Servizio connesso sconosciuto.",
      actionsGroupTitle: "Azioni",
      actions: {
        setDefault: "Imposta come predefinito",
        unsetDefault: "Rimuovi predefinito",
        editLabel: "Modifica etichetta",
        reconnect: "Riconnetti",
      },
      setDefaultProfileTitle: "Imposta profilo predefinito",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Predefinito: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Scegli quale profilo è selezionato per impostazione predefinita",
      setProfileLabelTitle: "Imposta etichetta profilo",
      setProfileLabelSubtitle:
        "Etichetta facoltativa mostrata nei selettori di autenticazione",
      addOauthProfileTitle: "Aggiungi profilo OAuth",
      addOauthProfileSubtitle: "Collega un nuovo profilo account",
      addOauthProfileDeviceTitle: "Aggiungi con auth dispositivo",
      addOauthProfileDeviceSubtitle: "Consigliato per web/ambienti remoti",
      addOauthProfilePasteTitle: "Aggiungi con incolla reindirizzamento",
      addOauthProfilePasteSubtitle: "Flusso manuale di copia/incolla URL di reindirizzamento",
      addOauthProfileBrowserTitle: "Aggiungi con browser in-app",
      addOauthProfileBrowserSubtitle: "Usa un browser incorporato dove supportato",
      connectApiKeyTitle: "Connetti con chiave API",
      connectApiKeySubtitle: "Incolla una chiave API di Anthropic",
      connectSetupTokenTitle: "Connetti con setup-token",
      connectSetupTokenSubtitle: "Incolla un setup-token di Claude (da claude setup-token)",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Disconnettere ${service} (${profileId})?`,
      prompts: {
        profileIdTitle: "ID profilo",
        profileIdBody: "Usa un’etichetta breve come work, personal, alt.",
        apiKeyTitle: "Chiave API",
        apiKeyBody: "Incolla la tua chiave API di Anthropic.",
        apiKeyPlaceholder: "es. sk-ant-…",
        setupTokenTitle: "Token di configurazione",
        setupTokenBody: "Incolla il tuo setup-token di Claude (da claude setup-token).",
        setupTokenPlaceholder: "es. sk-ant-oat01-…",
        profileLabelTitle: "Etichetta profilo",
        profileLabelBody: "Facoltativo. Mostrato nei selettori di autenticazione.",
        profileLabelPlaceholder: "Account lavoro",
      },
      alerts: {
        invalidProfileIdTitle: "ID profilo non valido",
        invalidProfileIdBody:
          "Usa lettere, numeri, trattino o underscore (max 64).",
        unknownProfileTitle: "Profilo sconosciuto",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Nessun profilo chiamato \"${profileId}\" esiste per ${service}.`,
      },
      profiles: {
        empty: "Nessun profilo ancora.",
        connected: "Connesso",
        defaultBadge: "Predefinito",
        needsReauth: "Richiede ri-autenticazione",
      },
    },
    profile: {
      profileId: "ID profilo",
      status: "Stato",
      email: "E-mail",
      accountId: "ID account",
      quotaTitle: "Quote",
      defaultSubtitle: "Questo profilo è selezionato come predefinito",
      setDefaultSubtitle: "Usa questo profilo come predefinito",
      disconnectSubtitle: "Rimuovi le credenziali per questo profilo",
      reconnectSubtitle: "Ri-autentica questo profilo",
    },
    authModal: {
      nativeAuthTitle: "Autenticazione nativa del backend",
      nativeAuthSubtitle: "Usa il login della CLI locale / chiavi API",
      connectedServicesTitle: "Usa servizi connessi",
      connectedServicesSubtitle: "Recupera e materializza dal cloud di Happier",
      notConnectedTitle: "Non connesso",
      notConnectedSubtitle: "Tocca per aprire le impostazioni",
      profileLabel: "Profilo",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "File troppo grande",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Saltati ${count} ${plural({ count, singular: "file", plural: "file" })} che superano la dimensione massima dell’allegato.`,
    },
  },

  settingsAttachments: {
    disabled: {
      title: "Allegati",
      footer:
        "Questa funzionalità è disabilitata dal server o dalla policy di build.",
    },
    fileUploads: {
      title: "Caricamenti file",
    },
    uploadLocation: {
      title: "Posizione di caricamento",
      footer:
        "I caricamenti nel workspace sono l’opzione più compatibile. I caricamenti nella directory temporanea del sistema possono essere utili per evitare artefatti nel repository, ma potrebbero non essere leggibili in sandboxes più rigide.",
      options: {
        workspace: {
          title: "Directory del workspace (consigliata)",
          subtitle:
            "I caricamenti vengono scritti in una directory relativa al workspace così il sandbox dell’agente può leggerli in modo affidabile.",
        },
        osTemp: {
          title: "Directory temporanea del sistema",
          subtitle:
            "I caricamenti vengono scritti nella directory temporanea del sistema operativo. Questo può rompersi in sandboxes più rigide.",
        },
      },
    },
    workspaceDirectory: {
      title: "Directory del workspace",
      footer:
        "Usata solo quando la posizione di caricamento è impostata su Directory del workspace.",
      uploadsDirectory: {
        title: "Directory degli upload",
        promptTitle: "Directory degli upload",
        promptMessage:
          "Inserisci una directory relativa al workspace (niente percorsi assoluti, niente ..).",
        invalidDirectoryTitle: "Directory non valida",
        invalidDirectoryMessage: "Usa un percorso relativo come `.happier/uploads`.",
      },
    },
    sourceControlIgnore: {
      title: "Ignore nel controllo di versione",
      footer:
        "Gli ignore solo locali evitano commit accidentali. Se scegli .gitignore, questo può modificare un file tracciato.",
      options: {
        gitInfoExclude: {
          title: "Ignora localmente (.git/info/exclude) (consigliato)",
          subtitle:
            "Evita commit accidentali senza modificare file del repository.",
        },
        gitignore: {
          title: "Ignora tramite .gitignore",
          subtitle:
            "Scrive una voce nel file .gitignore del workspace (può essere committata).",
        },
        none: {
          title: "Non scrivere regole di ignore",
          subtitle:
            "I caricamenti potrebbero essere rilevati dal controllo di versione a seconda della configurazione del repo.",
        },
      },
      writeIgnoreRules: {
        title: "Scrivi regole di ignore",
      },
    },
    limits: {
      title: "Limiti",
      footer:
        "Questi limiti sono applicati dal gestore locale di upload del CLI (best-effort).",
      invalidValueTitle: "Valore non valido",
      maxAttachmentSize: {
        title: "Dimensione massima allegato (byte)",
        promptTitle: "Dimensione massima allegato (byte)",
        promptMessage: "Esempio: 26214400 per 25MB.",
        invalidValueMessage: "Inserisci un numero tra 1024 e 1073741824.",
      },
      uploadTtl: {
        title: "TTL caricamento (ms)",
        promptTitle: "TTL caricamento (ms)",
        promptMessage:
          "Per quanto tempo un upload può restare inattivo prima di scadere.",
        invalidValueMessage: "Inserisci un numero tra 5000 e 3600000.",
      },
      chunkSize: {
        title: "Dimensione chunk preferita (byte)",
        promptTitle: "Dimensione chunk preferita (byte)",
        promptMessage: "Il CLI può limitarlo a valori sicuri.",
        invalidValueMessage: "Inserisci un numero tra 4096 e 1048576.",
      },
    },
  },

  settingsSourceControl: {
    commitStrategy: {
      title: "Strategia di commit",
      footer:
        "Il commit atomico evita interferenze tra agenti nell’indice. Lo staging Git abilita flussi interattivi di include/exclude.",
      options: {
        atomic: {
          title: "Commit atomico (consigliato)",
          subtitle:
            "Nessuno staging live nell’indice del repository. Effettua il commit di tutte le modifiche in sospeso in una sola operazione RPC.",
        },
        gitStaging: {
          title: "Workflow di staging Git",
          subtitle:
            "Abilita include/exclude e staging parziale per riga per i repository Git.",
        },
      },
    },
    gitRoutingPreference: {
      title: "Preferenza di instradamento per .git",
      footer:
        "Seleziona quale backend preferire quando la modalità del repository è .git.",
      options: {
        git: {
          title: "I repository .git usano Git",
          subtitle: "Predefinito e consigliato per compatibilità.",
        },
        sapling: {
          title: "I repository .git preferiscono Sapling",
          subtitle:
            "Usa il backend Sapling quando sono disponibili sia Git che Sapling.",
        },
      },
    },
    remoteConfirmation: {
      title: "Conferma remota",
      footer: "Controlla se le operazioni pull/push richiedono conferma.",
      options: {
        always: {
          title: "Conferma sempre pull/push",
          subtitle:
            "Mostra finestre di conferma per le operazioni di pull e push.",
        },
        pushOnly: {
          title: "Conferma solo push",
          subtitle: "Pull immediato; push richiede conferma.",
        },
        never: {
          title: "Non confermare mai",
          subtitle: "Esegui pull e push immediatamente.",
        },
      },
    },
    pushRejectionRecovery: {
      title: "Recupero dopo rifiuto push",
      footer:
        "Comportamento quando il push viene rifiutato perché il branch è indietro rispetto all’upstream.",
      options: {
        promptFetch: {
          title: "Chiedi prima di fare fetch",
          subtitle:
            "Chiede prima di eseguire fetch quando il push non fast-forward viene rifiutato.",
        },
        autoFetch: {
          title: "Fetch automatico",
          subtitle:
            "Esegue automaticamente fetch dopo un rifiuto push non fast-forward.",
        },
        manual: {
          title: "Recupero manuale",
          subtitle:
            "Non eseguire fetch automaticamente dopo il rifiuto del push.",
        },
      },
    },
    commitMessageGenerator: {
      title: "Generatore di messaggi di commit",
      footer:
        "Opzionale: genera suggerimenti per i messaggi di commit con un’attività LLM one-shot. Richiede supporto per execution runs sul daemon.",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `Backend generatore: ${backendId}`,
      backendItemSubtitle:
        "ID backend usato per la generazione one-shot dei messaggi di commit.",
      backendPromptTitle: "Backend messaggio di commit",
      backendPromptMessage: "Inserisci l’ID del backend",
      instructionsPlaceholder: "Istruzioni per il messaggio di commit",
    },
    commitAttribution: {
      title: "Attribuzione commit",
      footer:
        "Quando abilitato, i messaggi di commit generati dall’IA includeranno i crediti Co-Authored-By.",
      includeCoAuthoredBy: {
        title: "Includi Co-Authored-By",
      },
    },
    filesDisplay: {
      title: "Visualizzazione file",
      footer:
        "L’evidenziazione della sintassi è sperimentale e può essere disabilitata per diff molto grandi.",
      diffRenderer: {
        options: {
          pierre: {
            title: "Renderer diff: Pierre",
            subtitle:
              "Miglior rendering dei diff su web/desktop. Usa una pipeline con worker e fa fallback in modo sicuro se non disponibile.",
          },
          happier: {
            title: "Renderer diff: Happier",
            subtitle:
              "Renderer di fallback per compatibilità e risoluzione problemi.",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Layout diff: Unificato",
            subtitle:
              "Vista in linea (una colonna). Ideale per schermi stretti e scansione rapida.",
          },
          split: {
            title: "Layout diff: Affiancato",
            subtitle:
              "Vista divisa (due colonne). Ideale per schermi grandi e confronti precisi.",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "Evidenziazione sintassi: Disattivata",
            subtitle:
              "Mostra diff e file come testo monospaziato semplice.",
          },
          simple: {
            title: "Evidenziazione sintassi: Semplice",
            subtitle:
              "Evidenziazione rapida basata su token per linguaggi comuni.",
          },
          advanced: {
            title: "Evidenziazione sintassi: Avanzata",
            subtitle:
              "Evidenziazione più fedele su web/desktop; fallback a semplice su native.",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "Densità file modificati: Confortevole",
            subtitle:
              "Righe più grandi con sottotitoli file e stato più chiari.",
          },
          compact: {
            title: "Densità file modificati: Compatta",
            subtitle:
              "Righe più piccole per una scansione più facile quando cambiano molti file.",
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
      }) => `Diff predefinito di ${backendTitle}: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "Modalità predefinita quando si visualizzano file con delta inclusi e in sospeso.",
    },
    diffMode: {
      pending: "In attesa",
      combined: "Combinato",
      included: "Incluso",
    },
  },

  settingsNotifications: {
    push: {
      title: "Notifiche push",
      footer:
        "Queste notifiche vengono inviate dal tuo CLI tramite Expo quando la sessione richiede attenzione.",
      enabledSubtitle: "Consenti le notifiche push su questo account",
    },
    types: {
      title: "Tipi",
      footer:
        "Disattiva i singoli tipi se vuoi ricevere solo alcuni avvisi.",
      ready: {
        title: "Pronto",
        subtitle:
          "Notifica quando un turno termina e l’agente è in attesa del tuo comando",
      },
      permissionRequests: {
        title: "Richieste di autorizzazione",
        subtitle:
          "Notifica quando una sessione è bloccata in attesa di un’approvazione",
      },
      userActions: {
        title: "Richieste di azione",
        subtitle: "Notifica quando una sessione richiede una risposta o una conferma",
      },
    },
  },

    notifications: {
      actions: {
        allow: 'Consenti',
        deny: 'Nega',
        answer: 'Rispondi',
      },
      channels: {
        default: 'Predefinito',
        permissionRequests: 'Richieste di autorizzazione',
        userActionRequests: 'Richieste di azione',
      },
    },

  settingsProviders: {
        title: "Impostazioni del provider IA",
        entrySubtitle: "Configura opzioni specifiche del provider",
        footer:
        "Configura opzioni specifiche del provider. Queste impostazioni possono influire sul comportamento della sessione.",
      providerSubtitle: "Impostazioni specifiche del provider",
      stateEnabled: "Abilitato",
      stateDisabled: "Disabilitato",
      channelStable: "Stabile",
      channelExperimental: "Sperimentale",
      supported: "Supportato",
      notSupported: "Non supportato",
      allowed: "Consentito",
      notAllowed: "Non consentito",
      notAvailable: "Non disponibile",
      enabledTitle: "Abilitato",
      enabledSubtitle: "Usa questo backend in selettori, profili e sessioni",
      releaseChannelTitle: "Canale di rilascio",
      capabilitiesTitle: "Funzionalità",
      resumeSupportTitle: "Supporto ripresa",
      sessionModeSupportTitle: "Supporto modalità sessione",
      runtimeModeSwitchingTitle: "Cambio modalità in runtime",
      localControlTitle: "Controllo locale",
      resumeSupportSupported: "Supportato",
      resumeSupportSupportedExperimental: "Supportato (sperimentale)",
      resumeSupportRuntimeGatedAcpLoadSession:
        "Limitato in runtime tramite ACP loadSession",
      resumeSupportNotSupported: "Non supportato",
      sessionModeNone: "Nessuna modalità ACP",
      sessionModeAcpPolicyPresets: "Preset policy ACP",
      sessionModeAcpAgentModes: "Modalità agente ACP",
      sessionModeStaticAgentModes: "Modalità agente statiche",
      runtimeSwitchNone: "Nessun cambio in runtime",
      runtimeSwitchMetadataGating: "Limitato dai metadati",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchProviderNative: "Nativo del provider",
      modelsTitle: "Modelli",
      modelSelectionTitle: "Selezione modello",
      freeformModelIdsTitle: "ID modello liberi",
      defaultModelTitle: "Modello predefinito",
      catalogModelListTitle: "Elenco modelli catalogo",
      catalogModelListEmpty: "Nessun modello di catalogo disponibile",
      dynamicModelProbeTitle: "Rilevamento dinamico modelli",
      dynamicModelProbeAuto: "Automatico",
      dynamicModelProbeStaticOnly: "Solo statico",
      nonAcpApplyScopeTitle: "Ambito applicazione modello (non-ACP)",
      nonAcpApplyScopeSpawnOnly: "Applica all'avvio sessione",
      nonAcpApplyScopeNextPrompt: "Applica al prossimo messaggio",
      acpApplyBehaviorTitle: "Comportamento applicazione modello (ACP)",
      acpApplyBehaviorSetModel: "Imposta modello in diretta",
      acpApplyBehaviorRestartSession: "Riavvia sessione",
        acpConfigOptionTitle: "ID opzione config modello ACP",
        cliConnectionTitle: "CLI e connessione",
        targetMachineTitle: "Macchina di destinazione",
        detectedCliTitle: "CLI rilevato",
        installSetupTitle: "Installazione / configurazione",
        installInfoSeeSetupGuide: "Vedi guida configurazione",
      installInfoUseProviderCliInstaller: "Usa l'installer CLI del provider",
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `Installa CLI ${provider}`,
        reinstallTitle: ({ provider }: { provider: string }) => `Reinstalla CLI ${provider}`,
        autoInstallUnavailable:
          "L’installazione automatica non è disponibile per questa macchina.",
        installSubtitle:
          "Installa la CLI del provider sulla macchina selezionata (best-effort).",
        reinstallSubtitle:
          "Esegue di nuovo l’installer del provider anche se la CLI è già presente.",
        noMachineSelected: "Nessuna macchina selezionata.",
        installNotSupported: "Installazione non supportata su questa macchina.",
        installFailed: "Installazione non riuscita.",
        installed: "Installato.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL guida configurazione",
      connectedServiceTitle: "Servizio connesso",
      notFoundTitle: "Provider non trovato",
      notFoundSubtitle: "Questo provider non ha una schermata impostazioni.",
      noOptionsAvailable: "Nessuna opzione disponibile",
      invalidNumber: "Numero non valido",
    invalidJson: "JSON non valido",
  },

  settingsAppearance: {
    // Appearance settings screen
    theme: "Tema",
    themeDescription: "Scegli lo schema di colori preferito",
    themeOptions: {
      adaptive: "Adattivo",
      light: "Chiaro",
      dark: "Scuro",
    },
    themeDescriptions: {
      adaptive: "Segui le impostazioni di sistema",
      light: "Usa sempre il tema chiaro",
      dark: "Usa sempre il tema scuro",
    },
    display: "Schermo",
    displayDescription: "Controlla layout e spaziatura",
    multiPanePanels: "Pannelli destri",
    multiPanePanelsDescription:
      "Mostra pannelli laterali ridimensionabili per file e controllo versione (web/tablet)",
    sessionsRightPaneDefaultOpen:
      "Mostra sempre la barra laterale destra nelle sessioni",
    sessionsRightPaneDefaultOpenDescription:
      "Apri automaticamente la barra laterale destra quando entri in una sessione (web/tablet)",
    detailsPaneTabsBehavior: "Schede editor",
    detailsPaneTabsBehaviorDescription:
      "Scegli come si comportano le schede dei file nel pannello editor",
    detailsPaneTabsBehaviorOptions: {
      preview: "Scheda anteprima",
      persistent: "Schede persistenti",
    },
    editorFocusMode: "Modalità focus editor",
    editorFocusModeDescription:
      "Nasconde conversazione e barra laterale mentre rivedi i file (web/tablet)",
    inlineToolCalls: "Chiamate strumenti inline",
    inlineToolCallsDescription:
      "Mostra le chiamate agli strumenti direttamente nei messaggi di chat",
    expandTodoLists: "Espandi liste di attività",
    expandTodoListsDescription:
      "Mostra tutte le attività invece dei soli cambiamenti",
    showLineNumbersInDiffs: "Mostra numeri di riga nelle differenze",
    showLineNumbersInDiffsDescription:
      "Mostra i numeri di riga nei diff del codice",
    showLineNumbersInToolViews: "Mostra numeri di riga nelle viste strumenti",
    showLineNumbersInToolViewsDescription:
      "Mostra i numeri di riga nei diff delle viste strumenti",
    wrapLinesInDiffs: "A capo nelle differenze",
    wrapLinesInDiffsDescription:
      "A capo delle righe lunghe invece dello scorrimento orizzontale nelle viste diff",
    alwaysShowContextSize: "Mostra sempre dimensione contesto",
    alwaysShowContextSizeDescription:
      "Mostra l'uso del contesto anche quando non è vicino al limite",
    agentInputActionBarLayout: "Barra azioni di input",
    agentInputActionBarLayoutDescription:
      "Scegli come vengono mostrati i chip azione sopra il campo di input",
    agentInputActionBarLayoutOptions: {
      auto: "Automatico",
      wrap: "A capo",
      scroll: "Scorrevole",
      collapsed: "Compresso",
    },
    agentInputChipDensity: "Densità dei chip azione",
    agentInputChipDensityDescription:
      "Scegli se i chip azione mostrano etichette o icone",
    agentInputChipDensityOptions: {
      auto: "Automatico",
      labels: "Etichette",
      icons: "Solo icone",
    },
    avatarStyle: "Stile avatar",
    avatarStyleDescription: "Scegli l'aspetto dell'avatar di sessione",
    avatarOptions: {
      pixelated: "Pixelato",
      gradient: "Gradiente",
      brutalist: "Brutalista",
    },
    showFlavorIcons: "Mostra icone provider IA",
    showFlavorIconsDescription:
      "Mostra le icone del provider IA sugli avatar di sessione",
    compactSessionView: "Vista sessioni compatta",
    compactSessionViewDescription:
      "Mostra le sessioni attive in un layout più compatto",
    compactSessionViewMinimal: "Vista compatta minima",
    compactSessionViewMinimalDescription:
      "Rimuovi gli avatar e mostra un layout di riga sessione molto compatto",
    text: "Testo",
    textDescription: "Regola la dimensione del testo nell'app",
    textSize: "Dimensione testo",
    textSizeDescription: "Rendi il testo più grande o più piccolo",
    textSizeOptions: {
      xxsmall: "Molto molto piccolo",
      xsmall: "Molto piccolo",
      small: "Piccolo",
      default: "Predefinito",
      large: "Grande",
      xlarge: "Molto grande",
      xxlarge: "Molto molto grande",
    },
  },

  settingsFeatures: {
    // Features settings screen
    experiments: "Esperimenti",
    experimentsDescription:
      "Abilita funzionalità sperimentali ancora in sviluppo. Queste funzionalità possono essere instabili o cambiare senza preavviso.",
    experimentalFeatures: "Funzionalità sperimentali",
    experimentalFeaturesEnabled: "Funzionalità sperimentali abilitate",
    experimentalFeaturesDisabled: "Usando solo funzionalità stabili",
    experimentalOptions: "Opzioni sperimentali",
    experimentalOptionsDescription:
      "Scegli quali funzionalità sperimentali sono abilitate.",
    localTogglesTitle: "Funzionalità",
    localTogglesFooter:
      "Interruttori locali per funzionalità (indipendenti dal supporto del server).",
    featureDiagnostics: {
      title: "Diagnostica funzionalità",
      footer:
        "Decisioni sulle funzionalità risolte (policy di build, policy locale, probe daemon/server e ambito).",
      decisionUnknown: "sconosciuto",
      decisionEnabled: "abilitato",
      decisionBlocked: ({
        state,
        blockedBy,
        code,
      }: {
        state: string;
        blockedBy: string | null;
        code: string;
      }) => `${state} (bloccatoDa=${blockedBy ?? "null"}, codice=${code})`,
    },
        expAutomations: "Automazioni",
        expAutomationsSubtitle:
          "Abilita superfici UI e pianificazione delle automazioni",
        expExecutionRuns: "Esecuzioni",
      expExecutionRunsSubtitle:
        "Abilita superfici di controllo per le esecuzioni (sub‑agenti / revisioni)",
      expAttachmentsUploads: "Caricamento allegati",
      expAttachmentsUploadsSubtitle:
        "Abilita caricamento di file/immagini così l'agente può leggerli dal disco",
      expUsageReporting: "Report di utilizzo",
      expUsageReportingSubtitle: "Abilita schermate di utilizzo e report dei token",
    expScmOperations: "Operazioni di controllo versione",
    expScmOperationsSubtitle:
      "Abilita operazioni di scrittura sperimentali di controllo versione (stage/commit/push/pull)",
      expFilesReviewComments: "Commenti di revisione file",
      expFilesReviewCommentsSubtitle:
        "Aggiungi commenti di revisione a livello di riga dalle viste file e diff, poi inviali come messaggio strutturato",
      expFilesDiffSyntaxHighlighting: "Evidenziazione sintassi diff",
      expFilesDiffSyntaxHighlightingSubtitle:
        "Abilita evidenziazione sintassi nelle viste diff e codice (con limiti prestazionali)",
      expFilesAdvancedSyntaxHighlighting: "Evidenziazione sintassi avanzata",
      expFilesAdvancedSyntaxHighlightingSubtitle:
        "Usa evidenziazione più pesante e ad alta fedeltà (solo web, può essere più lenta)",
      expFilesEditor: "Editor file incorporato",
      expFilesEditorSubtitle:
        "Abilita modifica dei file direttamente dal browser file (Monaco su web/desktop, CodeMirror su native)",
      expSessionType: "Selettore tipo sessione",
      expSessionTypeSubtitle:
        "Mostra il selettore del tipo di sessione (semplice vs worktree)",
      expZen: "Modalità Zen",
      expZenSubtitle: "Abilita la voce di navigazione Zen",
      expVoiceAuthFlow: "Flusso di autenticazione voce",
      expVoiceAuthFlowSubtitle:
        "Usa flusso token voce autenticato (consapevole del paywall)",
    voice: "Voce",
    voiceSubtitle: "Abilita le funzioni vocali",
      expVoiceAgent: "Agente vocale",
      expVoiceAgentSubtitle:
        "Abilita superfici agente vocale supportate dal daemon (richiede esecuzioni)",
      expConnectedServices: "Servizi connessi",
      expConnectedServicesSubtitle:
        "Abilita impostazioni servizi connessi e collegamenti di sessione",
      expConnectedServicesQuotas: "Quote servizi connessi",
      expConnectedServicesQuotasSubtitle:
        "Mostra badge quota e indicatori di utilizzo per i servizi connessi",
      expMemorySearch: "Ricerca memoria",
      expMemorySearchSubtitle:
        "Abilita schermate e impostazioni di ricerca memoria locale",
    expFriends: "Amici",
    expFriendsSubtitle: "Abilita le funzioni Amici (scheda Posta in arrivo e condivisione sessioni)",
    webFeatures: "Funzionalità web",
    webFeaturesDescription:
      "Funzionalità disponibili solo nella versione web dell'app.",
    enterToSend: "Invio con Enter",
    enterToSendEnabled:
      "Premi Invio per inviare (Maiusc+Invio per una nuova riga)",
    enterToSendDisabled: "Invio inserisce una nuova riga",
      historyScope: "Cronologia messaggi",
      historyScopePerSession: "Scorri cronologia per terminale",
      historyScopeGlobal: "Scorri cronologia su tutti i terminali",
      historyScopeModalTitle: "Cronologia messaggi",
      historyScopeModalMessage:
        "Scegli se Freccia su/Freccia giù scorre solo i messaggi inviati in questo terminale o su tutti i terminali.",
      historyScopePerSessionOption: "Per terminale",
      historyScopeGlobalOption: "Globale",
      commandPalette: "Palette comandi",
      commandPaletteEnabled: "Premi ⌘K per aprire",
      commandPaletteDisabled: "Accesso rapido ai comandi disabilitato",
      hideInactiveSessions: "Nascondi sessioni inattive",
      hideInactiveSessionsSubtitle: "Mostra solo le chat attive nella tua lista",
    sessionListActiveGrouping: "Raggruppamento sessioni attive",
    sessionListActiveGroupingSubtitle:
      "Scegli come raggruppare le sessioni attive nella barra laterale",
    sessionListInactiveGrouping: "Raggruppamento sessioni inattive",
    sessionListInactiveGroupingSubtitle:
      "Scegli come raggruppare le sessioni inattive nella barra laterale",
    sessionListGrouping: {
      projectTitle: "Progetto",
      projectSubtitle: "Raggruppa le sessioni per macchina + percorso",
      dateTitle: "Data",
      dateSubtitle: "Raggruppa le sessioni per data dell'ultima attività",
    },
    groupInactiveSessionsByProject: "Raggruppa sessioni inattive per progetto",
    groupInactiveSessionsByProjectSubtitle:
      "Organizza le chat inattive per progetto",
      environmentBadge: "Badge ambiente",
      environmentBadgeSubtitle:
        "Mostra un piccolo badge accanto al titolo Happier che indica l'ambiente corrente dell'app",
    enhancedSessionWizard: "Wizard sessione avanzato",
    enhancedSessionWizardEnabled: "Avvio sessioni con profili attivo",
    enhancedSessionWizardDisabled: "Usando avvio sessioni standard",
    profiles: "Profili IA",
    profilesEnabled: "Selezione profili abilitata",
    profilesDisabled: "Selezione profili disabilitata",
    pickerSearch: "Ricerca nei selettori",
    pickerSearchSubtitle:
      "Mostra un campo di ricerca nei selettori di macchina e percorso",
    machinePickerSearch: "Ricerca macchine",
    machinePickerSearchSubtitle:
      "Mostra un campo di ricerca nei selettori di macchine",
    pathPickerSearch: "Ricerca percorsi",
    pathPickerSearchSubtitle:
      "Mostra un campo di ricerca nei selettori di percorsi",
  },

  errors: {
    networkError: "Si è verificato un errore di rete",
    serverError: "Si è verificato un errore del server",
    unknownError: "Si è verificato un errore sconosciuto",
    connectionTimeout: "Connessione scaduta",
    authenticationFailed: "Autenticazione non riuscita",
    permissionDenied: "Permesso negato",
      fileNotFound: "File non trovato",
      invalidFormat: "Formato non valido",
      operationFailed: "Operazione non riuscita",
      failedToForkSession: "Impossibile derivare la sessione",
      daemonUnavailableTitle: "Daemon non disponibile",
      daemonUnavailableBody:
        "Happier non riesce a raggiungere il daemon su questa macchina. Potrebbe essere offline, in avvio o disconnesso dal server.",
      tryAgain: "Per favore riprova",
      contactSupport: "Contatta l'assistenza se il problema persiste",
      sessionNotFound: "Sessione non trovata",
      voiceSessionFailed: "Avvio della sessione vocale non riuscito",
      voiceServiceUnavailable:
      "Il servizio vocale non è temporaneamente disponibile",
    voiceAlreadyStarting: "La voce si sta già avviando in un’altra sessione",
    oauthInitializationFailed: "Impossibile inizializzare il flusso OAuth",
    tokenStorageFailed: "Impossibile salvare i token di autenticazione",
    oauthStateMismatch: "Convalida di sicurezza non riuscita. Riprova",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} è già collegato a un account Happier esistente. Per accedere su questo dispositivo, collegalo da un dispositivo che ha già effettuato l’accesso.`,
    tokenExchangeFailed: "Impossibile scambiare il codice di autorizzazione",
    oauthAuthorizationDenied: "Autorizzazione negata",
    webViewLoadFailed: "Impossibile caricare la pagina di autenticazione",
    failedToLoadProfile: "Impossibile caricare il profilo utente",
    userNotFound: "Utente non trovato",
    sessionDeleted: "La sessione non è disponibile",
    sessionDeletedDescription:
      "Potrebbe essere stata eliminata o potresti non avere più accesso.",

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
    }) => `${field} deve essere tra ${min} e ${max}`,
    retryIn: ({ seconds }: { seconds: number }) =>
      `Riprova tra ${seconds} ${seconds === 1 ? "secondo" : "secondi"}`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (Errore ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `Impossibile disconnettere ${service}`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `Impossibile connettere ${service}. Riprova.`,
    failedToLoadFriends: "Impossibile caricare la lista amici",
    failedToAcceptRequest: "Impossibile accettare la richiesta di amicizia",
    failedToRejectRequest: "Impossibile rifiutare la richiesta di amicizia",
    failedToRemoveFriend: "Impossibile rimuovere l'amico",
    searchFailed: "Ricerca non riuscita. Riprova.",
    failedToSendRequest: "Impossibile inviare la richiesta di amicizia",
    failedToResumeSession: "Impossibile riprendere la sessione",
    failedToSendMessage: "Impossibile inviare il messaggio",
    failedToSwitchControl: "Impossibile cambiare la modalità di controllo",
    cannotShareWithSelf: "Non puoi condividere con te stesso",
    canOnlyShareWithFriends: "Puoi condividere solo con amici",
    shareNotFound: "Condivisione non trovata",
    publicShareNotFound: "Link pubblico non trovato o scaduto",
    consentRequired: "Consenso richiesto per l'accesso",
    maxUsesReached: "Numero massimo di utilizzi raggiunto",
    invalidShareLink: "Link di condivisione non valido o scaduto",
    missingPermissionId: "Manca l'ID del permesso",
    codexResumeNotInstalledTitle:
      "Codex resume non è installato su questa macchina",
    codexResumeNotInstalledMessage:
      "Per riprendere una conversazione di Codex, installa il server di ripresa di Codex sulla macchina di destinazione (Dettagli macchina → Ripresa Codex).",
    codexAcpNotInstalledTitle: "Codex ACP non è installato su questa macchina",
    codexAcpNotInstalledMessage:
      "Per usare l'esperimento Codex ACP, installa codex-acp sulla macchina di destinazione (Dettagli macchina → Installables) o disattiva l'esperimento.",
  },

  deps: {
    installNotSupported:
      "Aggiorna Happier CLI per installare questa dipendenza.",
    installFailed: "Installazione non riuscita",
    installed: "Installato",
    installLog: ({ path }: { path: string }) => `Log di installazione: ${path}`,
    installable: {
      codexResume: {
        title: "Server di ripresa Codex",
        installSpecTitle: "Origine installazione Codex resume",
      },
      codexAcp: {
        title: "Adattatore Codex ACP",
        installSpecTitle: "Origine installazione Codex ACP",
      },
      installSpecDescription:
        "Spec NPM/Git/file passato a `npm install` (sperimentale). Lascia vuoto per usare il valore predefinito del demone.",
    },
    ui: {
      notAvailable: "Non disponibile",
      notAvailableUpdateCli: "Non disponibile (aggiorna CLI)",
      errorRefresh: "Errore (aggiorna)",
      installed: "Installato",
      installedWithVersion: ({ version }: { version: string }) =>
        `Installato (v${version})`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) =>
        `Installato (v${installedVersion}) — aggiornamento disponibile (v${latestVersion})`,
      notInstalled: "Non installato",
      latest: "Ultimo",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version} (tag: ${tag})`,
      registryCheck: "Controllo registro",
      registryCheckFailed: ({ error }: { error: string }) =>
        `Non riuscito: ${error}`,
      installSource: "Origine installazione",
      installSourceDefault: "(predefinito)",
      installSpecPlaceholder:
        "es. file:/percorso/al/pkg o github:proprietario/repo#branch",
      lastInstallLog: "Ultimo log di installazione",
      installLogTitle: "Log di installazione",
    },
  },

  newSession: {
    // Used by new-session screen and launch flows
    title: "Avvia nuova sessione",
    selectAiProfileTitle: "Seleziona profilo IA",
    selectAiProfileDescription:
      "Seleziona un profilo IA per applicare variabili d’ambiente e valori predefiniti alla sessione.",
    changeProfile: "Cambia profilo",
    aiBackendSelectedByProfile:
      "Il backend IA è determinato dal profilo. Per cambiarlo, seleziona un profilo diverso.",
    selectAiBackendTitle: "Seleziona backend IA",
    aiBackendLimitedByProfileAndMachineClis:
      "Limitato dal profilo selezionato e dalle CLI disponibili su questa macchina.",
    aiBackendSelectWhichAiRuns: "Seleziona quale IA esegue la sessione.",
    aiBackendNotCompatibleWithSelectedProfile:
      "Non compatibile con il profilo selezionato.",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `CLI di ${cli} non rilevata su questa macchina.`,
    selectMachineTitle: "Seleziona macchina",
    selectMachineDescription: "Scegli dove viene eseguita questa sessione.",
    selectPathTitle: "Seleziona percorso",
    selectWorkingDirectoryTitle: "Seleziona directory di lavoro",
    selectWorkingDirectoryDescription:
      "Scegli la cartella usata per comandi e contesto.",
    selectPermissionModeTitle: "Seleziona modalità di permessi",
    selectPermissionModeDescription:
      "Controlla quanto rigidamente le azioni richiedono approvazione.",
    selectModelTitle: "Seleziona modello IA",
    selectModelDescription: "Scegli il modello usato da questa sessione.",
    selectSessionTypeTitle: "Seleziona tipo di sessione",
    selectSessionTypeDescription:
      "Scegli una sessione semplice o una collegata a una worktree Git.",
    searchPathsPlaceholder: "Cerca percorsi...",
    noMachinesFound:
      "Nessuna macchina trovata. Avvia prima una sessione Happier sul tuo computer.",
    allMachinesOffline: "Tutte le macchine sembrano offline",
    machineDetails: "Visualizza dettagli macchina →",
    directoryDoesNotExist: "Directory non trovata",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `La directory ${directory} non esiste. Vuoi crearla?`,
    sessionStarted: "Sessione avviata",
    sessionStartedMessage: "La sessione è stata avviata con successo.",
    sessionSpawningFailed:
      "Avvio sessione non riuscito - nessun ID sessione restituito.",
    startingSession: "Avvio sessione...",
    startNewSessionInFolder: "Nuova sessione qui",
    failedToStart:
      "Impossibile avviare la sessione. Assicurati che il daemon sia in esecuzione sulla macchina di destinazione.",
    sessionTimeout:
      "Avvio sessione scaduto. La macchina potrebbe essere lenta o il daemon potrebbe non rispondere.",
    notConnectedToServer:
      "Non connesso al server. Controlla la tua connessione Internet.",
    daemonRpcUnavailableTitle: "Daemon non disponibile",
    daemonRpcUnavailableBody:
      "Happier non riesce a raggiungere il daemon su questa macchina. Potrebbe essere offline, in avvio o disconnesso dal server.",
    noMachineSelected: "Seleziona una macchina per avviare la sessione",
    noPathSelected: "Seleziona una directory in cui avviare la sessione",
    machinePicker: {
      searchPlaceholder: "Cerca macchine...",
      recentTitle: "Recenti",
      favoritesTitle: "Preferiti",
      allTitle: "Tutte",
      emptyMessage: "Nessuna macchina disponibile",
    },
    pathPicker: {
      enterPathTitle: "Inserisci percorso",
      enterPathPlaceholder: "Inserisci un percorso...",
      customPathTitle: "Percorso personalizzato",
      recentTitle: "Recenti",
      favoritesTitle: "Preferiti",
      suggestedTitle: "Suggeriti",
      allTitle: "Tutte",
      emptyRecent: "Nessun percorso recente",
      emptyFavorites: "Nessun percorso preferito",
      emptySuggested: "Nessun percorso suggerito",
      emptyAll: "Nessun percorso",
    },
    sessionType: {
      title: "Tipo di sessione",
      simple: "Semplice",
      worktree: "Worktree (Git)",
      comingSoon: "In arrivo",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Richiede ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) =>
        `CLI di ${cli} non rilevata`,
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `CLI di ${cli} non rilevata`,
      dontShowFor: "Non mostrare questo avviso per",
      thisMachine: "questa macchina",
      anyMachine: "qualsiasi macchina",
      installCommand: ({ command }: { command: string }) =>
        `Installa: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `Installa la CLI di ${cli} se disponibile •`,
      viewInstallationGuide: "Vedi guida di installazione →",
      viewGeminiDocs: "Vedi documentazione Gemini →",
    },
    worktree: {
      creating: ({ name }: { name: string }) =>
        `Creazione worktree '${name}'...`,
      notGitRepo: "Le worktree richiedono un repository git",
      failed: ({ error }: { error: string }) =>
        `Impossibile creare la worktree: ${error}`,
      success: "Worktree creata con successo",
    },
    resume: {
      title: "Riprendi sessione",
      optional: "Riprendi: Opzionale",
      pickerTitle: "Riprendi sessione",
      subtitle: ({ agent }: { agent: string }) =>
        `Incolla un ID sessione ${agent} per riprendere`,
      placeholder: ({ agent }: { agent: string }) =>
        `Incolla ID sessione ${agent}…`,
      paste: "Incolla",
      save: "Salva",
      clearAndRemove: "Cancella",
      helpText: "Puoi trovare gli ID sessione nella schermata Info sessione.",
      cannotApplyBody:
        "Questo ID di ripresa non può essere applicato ora. Happier avvierà invece una nuova sessione.",
    },
    codexResumeBanner: {
      title: "Riprendi Codex",
      updateAvailable: "Aggiornamento disponibile",
      systemCodexVersion: ({ version }: { version: string }) =>
        `Codex di sistema: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Server Codex resume: ${version}`,
      notInstalled: "non installato",
      latestVersion: ({ version }: { version: string }) =>
        `(più recente ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `Controllo del registro non riuscito: ${error}`,
      install: "Installa",
      update: "Aggiorna",
      reinstall: "Reinstalla",
    },
    codexResumeInstallModal: {
      installTitle: "Installare Codex resume?",
      updateTitle: "Aggiornare Codex resume?",
      reinstallTitle: "Reinstallare Codex resume?",
      description:
        "Questo installa un wrapper sperimentale del server MCP di Codex usato solo per operazioni di ripresa.",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "Installa",
      update: "Aggiorna",
      reinstall: "Reinstalla",
    },
    codexAcpInstallModal: {
      installTitle: "Installare Codex ACP?",
      updateTitle: "Aggiornare Codex ACP?",
      reinstallTitle: "Reinstallare Codex ACP?",
      description:
        "Questo installa un adattatore ACP sperimentale per Codex che supporta il caricamento/la ripresa dei thread.",
    },
  },

  sessionHistory: {
    // Used by session history screen
    title: "Cronologia sessioni",
    empty: "Nessuna sessione trovata",
    today: "Oggi",
    yesterday: "Ieri",
    daysAgo: ({ count }: { count: number }) =>
      `${count} ${count === 1 ? "giorno" : "giorni"} fa`,
    viewAll: "Visualizza tutte le sessioni",
  },

  session: {
    inputPlaceholder: "Scrivi un messaggio ...",
    activity: "Attività",
    activityCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} in più…`,
    forking: {
      dividerTitle: "Derivato da un contesto precedente",
      dividerSubtitle: "Contesto precedente (sola lettura)",
      openParent: "Apri",
      openParentA11y: "Apri la sessione padre",
      forkFromMessageA11y: "Deriva da questo messaggio",
    },
    resuming: "Ripresa in corso...",
    resumeFailed: "Impossibile riprendere la sessione",
    resumeSupportNoteChecking:
      "Nota: Happier sta ancora verificando se questa macchina può riprendere la sessione del provider.",
    resumeSupportNoteUnverified:
      "Nota: Happier non è riuscito a verificare il supporto alla ripresa su questa macchina.",
    resumeSupportDetails: {
      cliNotDetected: "CLI non rilevata sulla macchina.",
      capabilityProbeFailed: "Verifica delle capacità non riuscita.",
      acpProbeFailed: "Verifica ACP non riuscita.",
      loadSessionFalse: "L’agente non supporta il caricamento delle sessioni.",
    },
    inactiveResumable: "Inattiva (riprendibile)",
    inactiveMachineOffline: "Inattiva (macchina offline)",
    inactiveNotResumable: "Inattiva",
    inactiveNotResumableNoticeTitle: "Questa sessione non può essere ripresa",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `Questa sessione è terminata e non può essere ripresa perché ${provider} non supporta il ripristino del contesto qui. Avvia una nuova sessione per continuare.`,
    machineOfflineNoticeTitle: "La macchina è offline",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” è offline, quindi Happier non può ancora riprendere questa sessione. Riporta la macchina online per continuare.`,
      machineOfflineCannotResume:
        "La macchina è offline. Riportala online per riprendere questa sessione.",
          openRuns: "Apri esecuzioni della sessione",
          openAutomations: "Apri automazioni della sessione",
          participants: {
            to: 'A',
            lead: 'Principale',
            sendToTitle: 'Invia a',
            broadcast: ({ teamId }: { teamId: string }) => `Broadcast: ${teamId}`,
            executionRun: ({ runId }: { runId: string }) => `Esecuzione ${runId}`,
            cardTo: ({ label }: { label: string }) => `A: ${label}`,
            unsupportedAttachmentsOrReviewComments: 'L’invio a un destinatario non supporta ancora allegati o commenti di revisione.',
          },
          actionMenu: {
            openA11y: "Apri azioni della sessione",
          },
        detailsPanel: {
          emptyHint: "Apri un file o un diff dal pannello di destra.",
          unsupportedTab: "Scheda dettagli non supportata.",
          closeA11y: "Chiudi dettagli",
              openTabA11y: ({ title }: { title: string }) => `Apri scheda ${title}`,
              pinTabA11y: "Fissa scheda",
              pinnedTabA11y: "Scheda fissata",
              closeTabA11y: "Chiudi scheda",
              enterFocusModeA11y: "Entra in modalità focus editor",
              exitFocusModeA11y: "Esci dalla modalità focus editor",
        },
  
      actionsDraft: {
        noInputHints: "Questa azione non ha suggerimenti di input.",
      },

    planOutput: {
      title: "Piano",
      recommendedBackend: "Backend consigliato",
      risks: "Rischi",
      milestones: "Traguardi",
      adoptPlan: "Adotta piano",
      sending: "Invio…",
      failedToAdopt: "Impossibile adottare il piano",
      a11y: {
        adoptPlan: "Adotta piano",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `Risultati della revisione (${count})`,
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
        untriaged: "Non classificato",
        accept: "Accetta",
        reject: "Rifiuta",
        defer: "Rimanda",
        needsRefinement: "Da perfezionare",
      },
      refinementPlaceholder: "Commento facoltativo per il perfezionamento",
      actions: {
        applyTriage: "Applica classificazione",
        applying: "Applicazione…",
        applyAcceptedFindings: "Applica risultati accettati",
        sending: "Invio…",
      },
      errors: {
        applyTriageFailed: "Impossibile applicare la classificazione.",
        applyAcceptedFailed: "Impossibile applicare i risultati accettati.",
      },
    },

        pendingMessages: {
          title: "Messaggi in sospeso",
          indicator: ({ count }: { count: number }) => `In sospeso (${count})`,
          badgeLabel: ({ count }: { count: number }) =>
            count > 0 ? `In sospeso (+${count})` : "In sospeso",
          empty: "Nessun messaggio in sospeso.",
          actions: {
            up: "Su",
            down: "Giù",
          edit: "Modifica",
            viewMore: "Mostra di più",
            viewLess: "Mostra meno",
          steerNow: "Inserisci ora",
          sendNow: "Invia ora",
          sendNowInterrupt: "Invia ora (interrompi)",
          requeue: "Rimetti in coda",
        },
        editPrompt: {
          title: "Modifica messaggio in sospeso",
        },
        removeConfirm: {
          title: "Rimuovere il messaggio in sospeso?",
          body: "Questo eliminerà il messaggio in sospeso.",
        },
        steerConfirm: {
          title: "Inserire ora?",
          body: "Questo aggiungerà questo messaggio al turno corrente senza fermarlo.",
        },
        sendConfirm: {
          title: "Inviare ora?",
          interruptTitle: "Inviare ora (interrompere)?",
          body: "Questo fermerà il turno corrente e invierà questo messaggio immediatamente.",
        },
        discarded: {
          title: "Messaggi scartati",
          subtitle:
            "Questi messaggi non sono stati inviati all’agente (ad esempio passando da remoto a locale).",
          label: "Scartato",
          removeConfirm: {
            title: "Rimuovere il messaggio scartato?",
            body: "Questo eliminerà il messaggio scartato.",
          },
        },
        errors: {
          updateFailed: "Impossibile aggiornare il messaggio in sospeso",
          deleteFailed: "Impossibile eliminare il messaggio in sospeso",
          sendFailed: "Impossibile inviare il messaggio in sospeso",
          restoreFailed: "Impossibile ripristinare il messaggio scartato",
          deleteDiscardedFailed: "Impossibile eliminare il messaggio scartato",
          sendDiscardedFailed: "Impossibile inviare il messaggio scartato",
          reorderFailed: "Impossibile riordinare i messaggi in sospeso",
        },
      },

      sharing: {
        title: "Condivisione",
        directSharing: "Condivisione diretta",
        addShare: "Condividi con un amico",
      accessLevel: "Livello di accesso",
      shareWith: "Condividi con",
      sharedWith: "Condiviso con",
      noShares: "Non condiviso",
      viewOnly: "Solo visualizzazione",
      viewOnlyDescription: "Può vedere la sessione ma non inviare messaggi.",
      viewOnlyMode: "Solo visualizzazione (sessione condivisa)",
      noEditPermission: "Hai accesso in sola lettura a questa sessione.",
      canEdit: "Può modificare",
      canEditDescription: "Può inviare messaggi.",
      canManage: "Può gestire",
      canManageDescription: "Può gestire la condivisione.",
      manageSharingDenied:
        "Non hai il permesso di gestire le impostazioni di condivisione per questa sessione.",
      stopSharing: "Interrompi condivisione",
      recipientMissingKeys:
        "Questo utente non ha ancora registrato le chiavi di crittografia.",
      permissionApprovals: "Può approvare i permessi",
      allowPermissionApprovals: "Consenti approvazione permessi",
      allowPermissionApprovalsDescription:
        "Consente a questo utente di approvare le richieste di permesso ed eseguire strumenti sulla tua macchina.",
      permissionApprovalsDisabledTitle:
        "L’approvazione dei permessi è disattivata",
      permissionApprovalsDisabledPublic:
        "I link pubblici sono di sola lettura. Non è possibile approvare i permessi.",
      permissionApprovalsDisabledReadOnly:
        "Hai accesso di sola lettura a questa sessione.",
      permissionApprovalsDisabledInactive:
        "Questa sessione è inattiva. Non è possibile approvare i permessi.",
      permissionApprovalsDisabledNotGranted:
        "Il proprietario non ti ha consentito di approvare i permessi per questa sessione.",
      publicReadOnlyTitle: "Link pubblico (sola lettura)",
      publicReadOnlyBody:
        "Questa sessione è condivisa tramite un link pubblico. Puoi vedere messaggi e output degli strumenti, ma non puoi interagire né approvare permessi.",

      publicLink: "Link pubblico",
      publicLinkActive: "Link pubblico attivo",
      publicLinkDescription:
        "Crea un link per permettere a chiunque di visualizzare questa sessione.",
      createPublicLink: "Crea link pubblico",
      regeneratePublicLink: "Rigenera link pubblico",
      deletePublicLink: "Elimina link pubblico",
      linkToken: "Token del link",
      tokenNotRecoverable: "Token non disponibile",
      tokenNotRecoverableDescription:
        "Per motivi di sicurezza, i token dei link pubblici vengono salvati come hash e non possono essere recuperati. Rigenera il link per creare un nuovo token.",

      expiresIn: "Scade tra",
      expiresOn: "Scade il",
      days7: "7 giorni",
      days30: "30 giorni",
      never: "Mai",

      maxUsesLabel: "Utilizzi massimi",
      unlimited: "Illimitato",
      uses10: "10 utilizzi",
      uses50: "50 utilizzi",
      usageCount: "Conteggio utilizzi",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} utilizzi`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} utilizzi`,

      requireConsent: "Richiedi consenso",
      requireConsentDescription:
        "Chiedi il consenso prima di registrare l'accesso.",
      consentRequired: "Consenso richiesto",
      consentDescription:
        "Questo link richiede il tuo consenso per registrare IP e user agent.",
      acceptAndView: "Accetta e visualizza",
      sharedBy: ({ name }: { name: string }) => `Condiviso da ${name}`,

      shareNotFound: "Link di condivisione non trovato o scaduto",
      failedToDecrypt: "Impossibile decifrare la sessione",
      noMessages: "Nessun messaggio",
      session: "Sessione",
    },
  },

  commandPalette: {
    placeholder: "Digita un comando o cerca...",
    noCommandsFound: "Nessun comando trovato",
  },

  commandView: {
    completedWithNoOutput: "[Comando completato senza output]",
  },

  delegation: {
    output: {
      title: "Delega",
      deliverablesTitle: "Deliverable",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "Aggiorna i modelli",
    loadingModelsA11y: "Caricamento modelli…",
    refreshingModelsA11y: "Aggiornamento modelli…",
    searchPlaceholder: "Cerca modelli…",
    customTitle: "Personalizzato…",
    effectiveLabel: ({ label }: { label: string }) => `Effettivo: ${label}`,
  },

  voiceAssistant: {
    connecting: "Connessione...",
    active: "Assistente vocale attivo",
    connectionError: "Errore di connessione",
    label: "Assistente vocale",
    tapToEnd: "Tocca per terminare",
  },

  voiceSurface: {
    start: "Avvia",
    stop: "Ferma",
    selectSessionToStart: "Seleziona una sessione per avviare la voce",
    targetSession: "Sessione target",
    noTarget: "Nessuna sessione selezionata",
    clearTarget: "Cancella target",
    a11y: {
      teleport: "Teletrasporta l’agente vocale",
      toggleActivity: "Mostra/nascondi attività vocale",
      clearActivity: "Cancella attività vocale",
    },
  },

  voiceActivity: {
    title: "Attività vocale",
    empty: "Nessuna attività vocale.",
    clear: "Cancella",
    format: {
      voiceAgent: "Agente vocale",
      you: "Tu",
      assistant: "Assistente",
      assistantStreaming: "Assistente…",
      action: "Azione",
      error: "Errore",
      status: "Stato",
      started: "Avviato",
      stopped: "Interrotto",
      errorFallback: "errore",
      eventFallback: "evento",
    },
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Configurazione server",
    enterServerUrl: "Inserisci un URL del server",
    notValidHappyServer: "Non è un Happier Server valido",
    changeServer: "Cambia server",
    continueWithServer: "Continuare con questo server?",
    resetToDefault: "Ripristina predefinito",
    resetServerDefault: "Ripristinare il server predefinito?",
    validating: "Verifica...",
    validatingServer: "Verifica del server...",
    serverReturnedError: "Il server ha restituito un errore",
    failedToConnectToServer: "Impossibile connettersi al server",
    currentlyUsingCustomServer: "Attualmente si usa un server personalizzato",
    customServerUrlLabel: "URL server personalizzato",
    advancedFeatureFooter:
      "Questa è una funzionalità avanzata. Cambia il server solo se sai cosa stai facendo. Dovrai disconnetterti e accedere di nuovo dopo aver cambiato server.",
    useThisServer: "Usa questo server",
    autoConfigHint:
      "Se fai self-hosting: configura prima il server, poi accedi (o crea un account) e infine collega il tuo terminale.",
    renameServer: "Rinomina server",
    renameServerPrompt: "Inserisci un nuovo nome per questo server.",
    renameServerGroup: "Rinomina gruppo di server",
    renameServerGroupPrompt: "Inserisci un nuovo nome per questo gruppo di server.",
    serverNamePlaceholder: "Nome del server",
    cannotRenameCloud: "Non puoi rinominare il server cloud.",
    removeServer: "Rimuovi server",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Rimuovere "${name}" dai server salvati?`,
    removeServerGroup: "Rimuovi gruppo di server",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Rimuovere "${name}" dai gruppi di server salvati?`,
    cannotRemoveCloud: "Non puoi rimuovere il server cloud.",
    signOutThisServer: "Vuoi disconnetterti anche da questo server?",
    signOutThisServerPrompt:
      "Sono state trovate credenziali salvate per questo server su questo dispositivo.",
    savedServersTitle: "Server salvati",
    signedIn: "Connesso",
    signedOut: "Disconnesso",
    authStatusUnknown: "Stato di autenticazione sconosciuto",
    switchToServer: "Passa a questo server",
    active: "Attivo",
    default: "Predefinito",
    addServerTitle: "Aggiungi server",
    switchForThisTab: "Passa per questa scheda",
    makeDefaultOnDevice: "Imposta come predefinito su questo dispositivo",
    serverNameLabel: "Nome del server",
    addAndUse: "Aggiungi e usa",
      addTargetsTitle: "Aggiungi",
      addServerSubtitle: "Aggiungi un nuovo server e passa ad esso",
      notificationAddServerHint: "Questo server non è ancora salvato su questo dispositivo. Aggiungilo qui sotto per continuare.",
      serverCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "server", plural: "server" })}`,
      useCanonicalServerUrlTitle: "Usare l'URL canonico del server?",
    useCanonicalServerUrlBody:
      "Questo server annuncia un URL canonico che dovrebbe funzionare da altri dispositivi. Vuoi usarlo invece di quello inserito?",
    insecureHttpUrlTitle: "URL del server non sicuro",
    insecureHttpUrlBody:
      "Questo URL usa http:// e potrebbe non funzionare dal telefono o fuori dalla LAN. Usa HTTPS se possibile. Continuare comunque?",
    signedOutSwitchConfirmTitle: "Non sei connesso",
    signedOutSwitchConfirmBody:
      "Vuoi passare a questo server e tornare alla schermata iniziale per accedere o creare un account?",
    addServerGroupTitle: "Aggiungi gruppo di server",
    addServerGroupSubtitle: "Crea un gruppo di server riutilizzabile",
    serverGroupNameLabel: "Nome gruppo",
    serverGroupNamePlaceholder: "Il mio gruppo di server",
    serverGroupServersLabel: "Server",
    saveServerGroup: "Salva gruppo",
    serverGroupMustHaveServer:
      "Un gruppo di server deve includere almeno un server.",
    multiServerView: {
      title: "Vista concorrente multi-server",
      footer: "Scegli se combinare più server in un’unica lista di sessioni.",
      enableTitle: "Abilita vista concorrente",
      enableSubtitle: "Mostra insieme le sessioni dei server selezionati",
      presentationTitle: "Modalità di presentazione",
      presentation: {
        flatWithBadges: "Elenco piatto con badge del server",
        groupedByServer: "Raggruppato per server",
      },
    },
  },

  sessionTags: {
    searchOrAddPlaceholder: "Cerca o aggiungi tag",
    editTagsLabel: "Modifica tag",
    noTagsFound: "Nessun tag trovato",
    newTagItem: "Nuovo tag…",
    newTagTitle: "Nuovo tag",
    newTagMessage: "Inserisci un nome per il nuovo tag.",
    newTagConfirm: "Aggiungi",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Server: ${server}`,
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "Termina sessione",
    killSessionConfirm: "Sei sicuro di voler terminare questa sessione?",
    stopSession: "Ferma sessione",
    stopSessionConfirm: "Sei sicuro di voler fermare questa sessione?",
    archiveSession: "Archivia sessione",
    archiveSessionConfirm: "Sei sicuro di voler archiviare questa sessione?",
    happySessionIdCopied: "ID sessione Happier copiato negli appunti",
    failedToCopySessionId: "Impossibile copiare l'ID sessione Happier",
    happySessionId: "ID sessione Happier",
    claudeCodeSessionId: "ID sessione Claude Code",
    claudeCodeSessionIdCopied: "ID sessione Claude Code copiato negli appunti",
    aiProfile: "Profilo IA",
    aiProvider: "Provider IA",
    failedToCopyClaudeCodeSessionId:
      "Impossibile copiare l'ID sessione Claude Code",
    codexSessionId: "ID sessione Codex",
    codexSessionIdCopied: "ID sessione Codex copiato negli appunti",
    failedToCopyCodexSessionId: "Impossibile copiare l'ID sessione Codex",
    opencodeSessionId: "ID sessione OpenCode",
    opencodeSessionIdCopied: "ID sessione OpenCode copiato negli appunti",
    auggieSessionId: "ID sessione Auggie",
    auggieSessionIdCopied: "ID sessione Auggie copiato negli appunti",
    geminiSessionId: "ID sessione Gemini",
    geminiSessionIdCopied: "ID sessione Gemini copiato negli appunti",
    qwenSessionId: "ID sessione Qwen Code",
    qwenSessionIdCopied: "ID sessione Qwen Code copiato negli appunti",
    kimiSessionId: "ID sessione Kimi",
    kimiSessionIdCopied: "ID sessione Kimi copiato negli appunti",
    kiloSessionId: "ID sessione Kilo",
    kiloSessionIdCopied: "ID sessione Kilo copiato negli appunti",
    piSessionId: "ID sessione Pi",
    piSessionIdCopied: "ID sessione Pi copiato negli appunti",
    copilotSessionId: "ID sessione Copilot",
    copilotSessionIdCopied: "ID sessione Copilot copiato negli appunti",
    metadataCopied: "Metadati copiati negli appunti",
    failedToCopyMetadata: "Impossibile copiare i metadati",
    failedToKillSession: "Impossibile terminare la sessione",
    failedToStopSession: "Impossibile fermare la sessione",
    failedToArchiveSession: "Impossibile archiviare la sessione",
    connectionStatus: "Stato connessione",
    created: "Creato",
    lastUpdated: "Ultimo aggiornamento",
    sequence: "Sequenza",
    quickActions: "Azioni rapide",
    executionRunsSubtitle: "Vedi le esecuzioni di questa sessione",
    automationsTitle: "Automazioni",
    automationsSubtitle: "Gestisci i messaggi programmati per questa sessione",
    viewSessionLogTitle: "Visualizza log della sessione",
    viewSessionLogSubtitle: "Apri la coda del log in tempo reale per questa sessione",
    pinSession: "Fissa sessione",
    unpinSession: "Rimuovi fissaggio",
    copyResumeCommand: "Copia comando di ripresa",
    resumeCommand: ({ sessionId }: { sessionId: string }) => `happier resume ${sessionId}`,
    viewMachine: "Visualizza macchina",
    viewMachineSubtitle: "Visualizza dettagli e sessioni della macchina",
    killSessionSubtitle: "Termina immediatamente la sessione",
    stopSessionSubtitle: "Ferma il processo della sessione",
    archiveSessionSubtitle: "Sposta questa sessione in Archiviate",
    archivedSessions: "Session archiviate",
    unarchiveSession: "Rimuovi dall'archivio",
    unarchiveSessionConfirm: "Sei sicuro di voler rimuovere questa sessione dall'archivio?",
    unarchiveSessionSubtitle: "Sposta questa sessione di nuovo tra Inattive",
    failedToUnarchiveSession: "Impossibile rimuovere la sessione dall'archivio",
    metadata: "Metadati",
    host: "Host (server)",
    path: "Percorso",
    operatingSystem: "Sistema operativo",
    processId: "ID processo",
    happyHome: "Home di Happier",
    attachFromTerminal: "Collega dal terminale",
    tmuxTarget: "Destinazione tmux",
    tmuxFallback: "Fallback tmux",
    copyMetadata: "Copia metadati",
    agentState: "Stato agente",
    rawJsonDevMode: "JSON grezzo (modalità sviluppatore)",
    sessionStatus: "Stato sessione",
    fullSessionObject: "Oggetto sessione completo",
    controlledByUser: "Controllato dall'utente",
    pendingRequests: "Richieste in sospeso",
    activity: "Attività",
    thinking: "Pensando",
    thinkingSince: "Pensando da",
    thinkingLevel: "Livello di pensiero",
    cliVersion: "Versione CLI",
    cliVersionOutdated: "Aggiornamento CLI richiesto",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `Versione ${currentVersion} installata. Aggiorna a ${requiredVersion} o successiva`,
    updateCliInstructions: "Esegui npm install -g @happier-dev/cli@latest",
    deleteSession: "Elimina sessione",
    deleteSessionSubtitle: "Rimuovi definitivamente questa sessione",
    deleteSessionConfirm: "Eliminare definitivamente la sessione?",
    deleteSessionWarning:
      "Questa azione non può essere annullata. Tutti i messaggi e i dati associati a questa sessione verranno eliminati definitivamente.",
    failedToDeleteSession: "Impossibile eliminare la sessione",
    sessionDeleted: "Sessione eliminata con successo",
    manageSharing: "Gestisci condivisione",
    manageSharingSubtitle:
      "Condividi questa sessione con amici o crea un link pubblico",
    renameSession: "Rinomina sessione",
    renameSessionSubtitle: "Cambia il nome visualizzato di questa sessione",
    renameSessionPlaceholder: "Inserisci nome sessione...",
    forkSession: "Deriva sessione",
    forkSessionSubtitle: "Crea una nuova sessione dal contesto più recente",
    failedToRenameSession: "Impossibile rinominare la sessione",
    sessionRenamed: "Sessione rinominata con successo",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "Pronto a programmare?",
      installCli: "Installa la CLI Happier",
      runIt: "Avviala",
      scanQrCode: "Scansiona il codice QR",
      openCamera: "Apri fotocamera",
      installCommand: "$ npm i -g @happier-dev/cli",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "Ancora nessun messaggio",
      created: ({ time }: { time: string }) => `Creato ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "Nessuna sessione attiva",
      startNewSessionDescription:
        "Avvia una nuova sessione su una delle tue macchine collegate.",
      startNewSessionButton: "Avvia nuova sessione",
      openTerminalToStart:
        "Apri un nuovo terminale sul computer per avviare una sessione.",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "Cosa bisogna fare?",
    },
    home: {
      noTasksYet: "Ancora nessuna attività. Tocca + per aggiungerne una.",
    },
    view: {
      workOnTask: "Lavora sul compito",
      clarify: "Chiarisci",
      delete: "Elimina",
      linkedSessions: "Sessioni collegate",
      tapTaskTextToEdit: "Tocca il testo del compito per modificarlo",
    },
  },

  agentInput: {
    dropToAttach: "Rilascia per allegare file",
    envVars: {
      title: "Var env",
      titleWithCount: ({ count }: { count: number }) => `Var env (${count})`,
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
      title: "MODALITÀ PERMESSI",
      effectiveLabel: ({ label }: { label: string }) => `Effettivo: ${label}`,
      default: "Predefinito",
      readOnly: "Sola lettura",
      acceptEdits: "Accetta modifiche",
      safeYolo: "YOLO sicuro",
      yolo: "YOLO",
      plan: "Modalità piano",
      bypassPermissions: "Modalità YOLO",
      badgeAccept: "Accetta",
      badgePlan: "Piano",
      badgeReadOnly: "Sola lettura",
      badgeSafeYolo: "YOLO sicuro",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Accetta tutte le modifiche",
      badgeBypassAllPermissions: "Bypassa tutti i permessi",
      badgePlanMode: "Modalità piano",
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
      on: "Indicizzazione attiva",
      off: "Indicizzazione disattiva",
    },
      model: {
        title: "MODELLO",
        useCliSettings: "Usa le impostazioni CLI",
        configureInCli: "Configura i modelli nelle impostazioni CLI",
        customDescription: "Usa un id modello che non è in elenco.",
        customPromptBody: "Inserisci un id modello",
        customPlaceholder: "es. claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "MODALITÀ PERMESSI CODEX",
      default: "Impostazioni CLI",
      plan: "Modalità piano",
      readOnly: "Modalità sola lettura",
      safeYolo: "YOLO sicuro",
      yolo: "YOLO",
      badgePlan: "Piano",
      badgeReadOnly: "Modalità sola lettura",
      badgeSafeYolo: "YOLO sicuro",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "MODELLO CODEX",
      gpt5CodexLow: "gpt-5-codex basso",
      gpt5CodexMedium: "gpt-5-codex medio",
      gpt5CodexHigh: "gpt-5-codex alto",
      gpt5Minimal: "GPT-5 Minimo",
      gpt5Low: "GPT-5 Basso",
      gpt5Medium: "GPT-5 Medio",
      gpt5High: "GPT-5 Alto",
    },
    geminiPermissionMode: {
      title: "MODALITÀ PERMESSI GEMINI",
      default: "Predefinito",
      readOnly: "Modalità sola lettura",
      safeYolo: "YOLO sicuro",
      yolo: "YOLO",
      badgeReadOnly: "Modalità sola lettura",
      badgeSafeYolo: "YOLO sicuro",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "MODELLO GEMINI",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "Il più potente",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "Veloce ed efficiente",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "Il più veloce",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
    },
    suggestion: {
      fileLabel: "FILE",
      folderLabel: "CARTELLA",
    },
    mode: {
      sectionTitle: "Modalità",
      badge: ({ name }: { name: string }) => `Modalità: ${name}`,
      badgePending: ({ name }: { name: string }) => `Modalità: ${name} (in sospeso)`,
      badgeA11y: ({ name }: { name: string }) => `Modalità: ${name}`,
      refreshModesA11y: "Aggiorna modalità",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `In sospeso: passaggio da ${from} a ${to}`,
      currentMode: ({ name }: { name: string }) => `Attuale: ${name}`,
      loadingModes: "Caricamento modalità…",
      refreshingModes: "Aggiornamento modalità…",
      useDefaultModeHint: "Usa la modalità predefinita per questo agente.",
      startIn: ({ name }: { name: string }) => `Avvia in: ${name}`,
      build: "Costruisci",
      buildDescription: "Comportamento predefinito",
      plan: "Pianifica",
      planDescription: "Pensa prima",
    },
    acp: {
      modeSectionTitle: "Modalità",
      refreshModesA11y: "Aggiorna modalità",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `In sospeso: passaggio da ${from} a ${to}`,
      currentMode: ({ name }: { name: string }) => `Attuale: ${name}`,
      loadingModes: "Caricamento modalità…",
      refreshingModes: "Aggiornamento modalità…",
      useDefaultModeHint: "Usa la modalità predefinita per questo agente.",
      startIn: ({ name }: { name: string }) => `Avvia in: ${name}`,
      optionsSectionTitle: "Opzioni",
      currentValue: ({ value }: { value: string }) => `Attuale: ${value}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `In sospeso: ${current} → ${requested}`,
    },
    actionMenu: {
      title: "AZIONI",
      files: "File",
      stop: "Ferma",
    },
    noMachinesAvailable: "Nessuna macchina",
  },

  machineLauncher: {
    showLess: "Mostra meno",
    showAll: ({ count }: { count: number }) =>
      `Mostra tutto (${count} percorsi)`,
    enterCustomPath: "Inserisci percorso personalizzato",
    offlineUnableToSpawn: "Impossibile avviare una nuova sessione, offline",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "Apri dettagli",
    expand: "Espandi/Comprimi",
    input: "Ingresso",
    output: "Uscita",
  },

    tools: {
      common: {
        more: ({ count }: { count: number }) => `+${count} altri`,
        elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
        unknownToolTitle: "Strumento",
      },
      bashView: {
        commandDiffTitle: "Comando grezzo",
        commandDiffHint:
          "L’anteprima del comando nasconde un breve prefisso di pulizia dell’ambiente per mantenerlo leggibile. Il comando grezzo completo è mostrato qui sotto.",
      },
      webFetch: {
        httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
      },
    fullView: {
      description: "Descrizione",
      inputParams: "Parametri di input",
      output: "Uscita",
      error: "Errore",
      completed: "Strumento completato con successo",
      noOutput: "Nessun output prodotto",
      running: "Strumento in esecuzione...",
      debug: "Diagnostica",
      show: "Mostra",
      hide: "Nascondi",
      rawJsonDevMode: "JSON grezzo (Modalità sviluppatore)",
    },
    taskView: {
      initializing: "Inizializzazione agente...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} altri ${plural({ count, singular: "strumento", plural: "strumenti" })}`,
    },
    subAgentRunView: {
      planTitle: "Piano",
      delegateTitle: "Delega",
      reviewDigestTitle: "Riepilogo revisione",
    },
    changeTitleView: {
      titleLabel: "Titolo",
    },
    enterPlanMode: {
      title: "Modalità piano attivata",
      body:
        "Ora l’agente fornirà un piano strutturato prima di agire. Puoi uscire dalla modalità piano o richiedere modifiche quando sei pronto.",
    },
    structuredResult: {
      exit: "Codice di uscita",
      stdout: "Output standard",
      stderr: "Errore standard",
      diff: "Differenze",
      result: "Risultato",
      items: "Elementi",
      more: ({ count }: { count: number }) => `+${count} in più`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "Indicizzazione workspace",
      description:
        "L’indicizzazione aiuta l’agente a cercare nel tuo codice più velocemente e a fornire risposte più accurate. Potrebbe analizzare i file del tuo workspace.",
      optionFallback: "Opzione",
      chooseOptionHint: "Scegli un’opzione qui sotto per continuare.",
    },
    acpHistoryImport: {
      title: "Importare la cronologia della sessione?",
      defaultNote:
        "Questa cronologia della sessione è diversa da quella già presente in Happier. L’importazione potrebbe creare duplicati.",
      counts: {
        local: ({ count }: { count: number }) => `Locale: ${count}`,
        remote: ({ count }: { count: number }) => `Remoto: ${count}`,
      },
      preview: {
        localTail: "Locale (coda)",
        remoteTail: "Remoto (coda)",
        unknownRole: "sconosciuto",
      },
      actions: {
        import: "Importa",
        skip: "Salta",
      },
    },
    askUserQuestion: {
      submit: "Invia risposta",
      multipleQuestions: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "domanda", plural: "domande" })}`,
      other: "Altro",
      otherDescription: "Scrivi la tua risposta",
      otherPlaceholder: "Scrivi la tua risposta...",
    },
    exitPlanMode: {
      approve: "Approva piano",
      reject: "Rifiuta",
      requestChanges: "Richiedi modifiche",
      planMissing:
        "Il testo del piano non è stato fornito. Consulta il piano nel messaggio precedente oppure chiedi all’agente di includerlo nella richiesta di approvazione.",
      requestChangesPlaceholder:
        "Spiega a Claude cosa vuoi cambiare in questo piano…",
      requestChangesSend: "Invia feedback",
      requestChangesEmpty: "Scrivi cosa vuoi cambiare.",
      requestChangesFailed:
        "Impossibile inviare la richiesta di modifiche. Riprova.",
      responded: "Risposta inviata",
      approvalMessage: "Approvo questo piano. Procedi con l’implementazione.",
      rejectionMessage:
        "Non approvo questo piano. Rivedilo o chiedimi quali modifiche desidero.",
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Modifica ${index} di ${total}`,
      replaceAll: "Sostituisci tutto",
      summaryEdits: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "modifica", plural: "modifiche" })}`,
    },
    names: {
      task: "Attività",
      terminal: "Terminale",
      searchFiles: "Cerca file",
      search: "Cerca",
      searchContent: "Cerca contenuto",
      listFiles: "Elenca file",
      planProposal: "Proposta di piano",
      readFile: "Leggi file",
      editFile: "Modifica file",
      writeFile: "Scrivi file",
      fetchUrl: "Recupera URL",
      readNotebook: "Leggi notebook",
      editNotebook: "Modifica notebook",
      todoList: "Elenco attività",
      webSearch: "Ricerca web",
      reasoning: "Ragionamento",
      applyChanges: "Aggiorna file",
      viewDiff: "Differenze",
      turnDiff: "Differenze turno",
      question: "Domanda",
      changeTitle: "Cambia titolo",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `Terminale(cmd: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `Cerca(pattern: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `Cerca(path: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) =>
        `Recupera URL(url: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `Modifica notebook(file: ${path}, mode: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Elenco attività(count: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Ricerca web(query: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(pattern: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} modifiche)`,
      readingFile: ({ file }: { file: string }) => `Leggendo ${file}`,
      writingFile: ({ file }: { file: string }) => `Scrivendo ${file}`,
      modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `Modificando ${count} file`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} e altri ${count}`,
      showingDiff: "Mostrando modifiche",
    },
  },

  files: {
    searchPlaceholder: "Cerca file...",
    clearSearchA11y: "Cancella ricerca",
    createFileA11y: "Crea file",
    createFolderA11y: "Crea cartella",
    createFilePromptTitle: "Crea file",
    createFilePromptBody: "Inserisci un percorso relativo alla radice del progetto.",
    createFileInvalidPath:
      "Percorso file non valido. Usa un percorso relativo al workspace come src/new-file.ts.",
    createFileFailed: "Impossibile creare il file.",
    createFolderPromptTitle: "Crea cartella",
    createFolderPromptBody:
      "Inserisci un percorso di cartella relativo alla radice del progetto.",
    createFolderInvalidPath:
      "Percorso cartella non valido. Usa un percorso relativo al workspace come src/new-folder.",
    createFolderFailed: "Impossibile creare la cartella.",
    changeRow: {
      viewDiffA11y: ({ file }: { file: string }) => `Visualizza diff per ${file}`,
      status: {
        untracked: "File non tracciato",
        added: "Nuovo file",
        deleted: "File eliminato",
        renamed: "File rinominato",
        copied: "File copiato",
        conflicted: "File in conflitto",
        modified: "File modificato",
      },
    },
    projectLinkPicker: {
      title: "Collega file di progetto",
      searchFailed: "Ricerca non riuscita. Riprova.",
    },
    detachedHead: "HEAD scollegato",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} in stage • ${unstaged} non in stage`,
    branchSummary: {
      ahead: "Avanti",
      behind: "Indietro",
      included: "Incluso",
      staged: "In stage",
      pending: "In sospeso",
      unstaged: "Non in stage",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "Nessun upstream",
    },
    stageActions: {
      selectPendingDiffMode:
        "Seleziona la modalità diff In sospeso per scegliere le righe per il commit.",
      unableToBuildPatchFromSelection:
        "Impossibile creare la patch dalle righe selezionate.",
      diffChangedRefreshAndReselect:
        "Il diff è cambiato; aggiorna e seleziona di nuovo le righe.",
    },
    discardChangesFor: ({ path }: { path: string }) => `Scarta le modifiche per ${path}`,
    commitSelection: {
      addToCommit: "Aggiungi al commit",
      removeFromCommit: "Rimuovi dal commit",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) => `${count} file`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `File modificati nel repository (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Modifiche attribuite alla sessione (${count})`,
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Altre modifiche del repository (${count})`,
    attributionReliabilityHigh:
      "Attribuzione best-effort. La vista del repository resta la fonte di verità.",
    attributionReliabilityLimited:
      "Affidabilità limitata: più sessioni sono attive per questo repository. Mostro solo attribuzione diretta.",
    attributionLegendFull:
      "direct = dalle operazioni di questa sessione, inferred = attribuzione basata su snapshot",
    attributionLegendDirectOnly: "direct = dalle operazioni di questa sessione",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} file inferit${count === 1 ? "o" : "i"} mantenut${count === 1 ? "o" : "i"} nelle modifiche solo repository.`,
    noSessionAttributedChanges:
      "Nessuna modifica attribuita alla sessione rilevata.",
    notRepo: "Non è un repository di controllo versione",
    notUnderSourceControl: "Questa directory non è sotto controllo versione",
    searching: "Ricerca file...",
      noFilesFound: "Nessun file trovato",
      noFilesInProject: "Nessun file nel progetto",
      repositoryFolderLoadFailed: "Impossibile caricare la cartella",
      repositoryCollapseAll: "Comprimi tutto",
    sourceControlOperationsLog: {
      title: "Operazioni recenti di controllo versione",
      allSessions: "Tutte le sessioni",
      thisSession: "Questa sessione",
      emptyThisSession: "Nessuna operazione recente per questa sessione.",
    },
    operationsHistory: {
      recentCommits: "Commit recenti",
      noCommitsAvailable: "Nessun commit disponibile.",
      loadMore: "Carica altri commit",
    },
      reviewFilterPlaceholder: "Filtra file...",
      reviewNoMatches: "Nessuna corrispondenza",
      reviewLargeDiffOneAtATime: "Diff grande rilevato; i diff verranno caricati mentre scorri.",
      reviewDiffRequestFailed: "Impossibile caricare il diff",
      reviewUnableToLoadDiff: "Impossibile caricare il diff",
      tryDifferentTerm: "Prova un termine di ricerca diverso",
      searchResults: ({ count }: { count: number }) =>
        `Risultati ricerca (${count})`,
    projectRoot: "Radice progetto",
    stagedChanges: ({ count }: { count: number }) =>
      `Modifiche in stage (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `Modifiche non in stage (${count})`,
      // File viewer strings
      fileReadFailed: "Impossibile leggere il file",
      fileWriteFailed: "Impossibile scrivere il file",
    fileEditor: {
      experimentalHint:
        "La modifica è sperimentale. Salva per scrivere le modifiche nel worktree della sessione.",
    },
      fileEditingUnsupported:
        "La modifica dei file non è supportata dal daemon connesso. Aggiorna Happier sulla macchina per abilitare le operazioni di scrittura.",
      selectionFailed: "Impossibile aggiornare la selezione",
      openReviewCommentsFailed: "Impossibile aprire i commenti di revisione",
          reviewComments: {
          title: ({ count }: { count: number }) =>
            `Commenti di revisione (${count})`,
            placeholder: "Aggiungi un commento di revisione…",
          jump: "Vai",
          addCommentA11y: "Aggiungi commento",
          closeCommentA11y: "Chiudi commento",
          draftsChipLabel: ({ count }: { count: number }) => `Revisione (${count})`,
            errors: {
              empty: "Il commento non può essere vuoto",
              couldNotMapSelection: "Impossibile associare la selezione a una riga del diff",
            },
          },
        commitDetails: {
          missingContext: "Contesto del commit mancante",
          failedToLoadDiff: "Impossibile caricare il diff del commit",
          diffUnavailableTitle: "Diff del commit non disponibile",
          diffUnavailableHint:
            "Prova ad aprire di nuovo il commit dalla schermata File.",
          commitLabel: "Commit (Git)",
          running: ({ operation }: { operation: string }) =>
            `In esecuzione: ${operation}`,
          revert: {
            title: "Reverti commit",
            button: "Reverti commit",
            confirm: "Reverti",
            success: "Commit annullato con successo",
            failed: "Impossibile annullare il commit",
          },
        },
        commitRevertUnavailable: "Il revert non è disponibile per questo commit.",
        commitMessageEditor: {
          placeholder: "Messaggio di commit",
          generate: "Genera",
          generating: "Generazione…",
          applySuggestion: "Applica suggerimento",
          commit: "Esegui commit",
          generateFailed: "Impossibile generare il messaggio di commit",
          generatorDisabled: "Il generatore di messaggi di commit è disabilitato",
        },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Caricamento ${fileName}...`,
        binaryFile: "File binario",
        imagePreviewTooLarge: "L'anteprima dell'immagine è troppo grande per essere visualizzata",
        cannotDisplayBinary: "Impossibile mostrare il contenuto del file binario",
        diff: "Differenze",
      file: "Documento",
    diffModes: {
      pending: "In sospeso",
      included: "Incluso",
      combined: "Combinato",
    },
    fileActions: {
      selectForCommit: "Seleziona per il commit",
      stageFile: "Metti in stage il file",
      removeFromSelection: "Rimuovi dalla selezione",
      unstageFile: "Rimuovi dallo stage",
      selectionHint:
        "Seleziona Incluso o In sospeso per abilitare la selezione delle righe.",
      selectedLines: {
        selectLinesForCommit: "Seleziona righe per il commit",
        stageSelectedLines: "Metti in stage le righe selezionate",
        unstageSelectedLines: "Rimuovi dallo stage le righe selezionate",
      },
      clearSelection: "Cancella selezione",
    },
    toolbar: {
      changedFiles: "File modificati",
      allRepositoryFiles: "Tutti i file del repository",
      repositoryView: "Vista repository",
      sessionView: "Vista sessione",
      review: "Revisione",
      list: "Elenco",
      scm: "Git",
    },
    fileEmpty: "File vuoto",
    noChanges: "Nessuna modifica da mostrare",
    sourceControlOperations: {
      title: "Controllo di versione",
      actorThisSession: "questa sessione",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `sessione ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `In esecuzione: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `Le operazioni di controllo versione sono bloccate da ${actor}.`,
      globalLock:
        "Le operazioni sono temporaneamente bloccate perché un'altra sessione sta eseguendo un comando di controllo versione.",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "1 file selezionato per il prossimo commit."
          : `${count} file selezionati per il prossimo commit.`,
      clear: "Cancella",
      conflictsDetected:
        "Conflitti rilevati. Commit, pull e push sono bloccati finché i conflitti non vengono risolti.",
      actions: {
        fetch: "Recupera",
        pull: "Scarica",
        push: "Invia",
      },
      blockedHints: {
        lock: "Blocco",
        commitBlocked: "Commit bloccato",
        pullBlocked: "Pull bloccato",
        pushBlocked: "Push bloccato",
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Avvia esecuzione",
      sections: {
        intent: "Intento",
        permissions: "Permessi",
        backends: "Backend",
        instructions: "Istruzioni",
      },
      intents: {
        review: "Revisione",
        plan: "Piano",
        delegate: "Delega",
      },
      permissionModes: {
        readOnly: "Sola lettura",
        default: "Predefinito",
      },
      instructionsPlaceholder: "Cosa deve fare il sub‑agente?",
      actions: {
        start: "Avvia",
      },
      guidancePreview: "Anteprima guida",
      a11y: {
        startRun: "Avvia esecuzione",
        cancel: "Annulla",
        selectIntent: ({ intent }: { intent: string }) =>
          `Seleziona intento ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `Seleziona permessi ${mode}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Attiva/disattiva backend ${backendId}`,
      },
    },
    details: {
      labels: {
        intent: "Intento",
        backendId: "ID backend",
        permissionMode: "Modalità permessi",
        retentionPolicy: "Criterio di conservazione",
        runClass: "Classe esecuzione",
        ioMode: "Modalità I/O",
      },
      timestamps: {
        started: "Avviato",
        finished: "Terminato",
      },
    },
  },

    settingsSession: {
      messageSending: {
        title: "Invio messaggi",
        footer:
          "Controlla cosa succede quando invii un messaggio mentre l'agente è in esecuzione.",
        queueInAgentTitle: "Accoda nell'agente (attuale)",
        queueInAgentSubtitle:
          "Scrivi subito nella trascrizione; l'agente elabora quando è pronto.",
        interruptTitle: "Interrompi e invia",
        interruptSubtitle: "Interrompi il turno corrente, poi invia subito.",
        pendingTitle: "In attesa finché pronto",
        pendingSubtitle:
          "Mantieni i messaggi in una coda in attesa; l'agente li prende quando è pronto.",
        busySteerPolicyTitle: "Quando l'agente è occupato (con steering)",
        busySteerPolicyFooter:
          "Se l'agente supporta lo steering in corso, scegli se i messaggi devono fare steering subito o passare prima in In attesa.",
        busySteerPolicy: {
          steerImmediatelyTitle: "Steering immediato",
          steerImmediatelySubtitle:
            "Invia subito e fai steering del turno corrente (senza interruzione).",
          queueForReviewTitle: "Accoda in In attesa",
          queueForReviewSubtitle:
            "Metti i messaggi prima in In attesa; inviali dopo con \"Guida ora\".",
        },
      },
      thinking: {
        title: "Pensiero",
        footer:
          "Controlla come i messaggi di pensiero dell'agente appaiono nella trascrizione della sessione.",
          displayModeTitle: "Visualizzazione del pensiero",
          displayMode: {
            inlineSummaryTitle: "In linea (riepilogo)",
            inlineSummarySubtitle: "Mostra un riepilogo su una riga; tocca per espandere.",
            inlineTitle: "In linea (completo)",
            inlineSubtitle: "Mostra il messaggio di pensiero completo direttamente nella trascrizione.",
            toolTitle: "Scheda strumento",
            toolSubtitle:
              "Mostra i messaggi di pensiero come scheda strumento \"Ragionamento\".",
            hiddenTitle: "Nascosto",
            hiddenSubtitle: "Nascondi i messaggi di pensiero dalla trascrizione.",
          },
              inlineChromeTitle: "Schede di pensiero",
              inlineChromeSubtitle: "Mostra il pensiero in linea con uno sfondo a scheda discreto.",
        },
      toolRendering: {
        title: "Rendering strumenti",
        footer:
          "Controlla quanto dettaglio degli strumenti viene mostrato nella timeline della sessione. È una preferenza UI; non cambia il comportamento dell'agente.",
          defaultToolDetailLevelTitle:
            "Livello di dettaglio predefinito degli strumenti",
          expandedToolDetailLevelTitle: "Livello di dettaglio espanso",
          cardTapActionTitle: "Azione al tocco (scheda)",
          timelineChrome: {
            title: "Stile strumenti nella timeline",
            cardsTitle: "Schede",
          cardsSubtitle:
            "Schede strumento con contenuto inline (in base al livello di dettaglio).",
          activityFeedTitle: "Feed attività",
          activityFeedSubtitle:
            "Righe compatte ottimizzate per alta densità di strumenti.",
        },
        cardDensity: {
          title: "Densità schede",
          comfortableTitle: "Confortevole",
          comfortableSubtitle: "Più spazio e separazione più chiara.",
          compactTitle: "Compatta",
          compactSubtitle: "Intestazioni più strette e padding ridotto.",
        },
        activityFeed: {
          defaultDetailTitle: "Dettaglio predefinito (feed attività)",
          expandedDetailTitle: "Dettaglio espanso (feed attività)",
          tapActionTitle: "Azione al tocco (feed attività)",
          tapAction: {
            expandTitle: "Espandi",
            expandSubtitle: "Tocca per espandere o comprimere i dettagli inline.",
            openTitle: "Apri",
            openSubtitle: "Tocca per aprire la schermata vista completa strumento.",
          },
          defaultExpandedTitle: "Espanso per impostazione predefinita",
          defaultExpandedSubtitle:
            "Espandi le righe strumento per impostazione predefinita nel feed attività.",
        },
        localControlDefaultTitle: "Predefinito (controllo locale)",
        showDebugByDefaultTitle: "Mostra debug per impostazione predefinita",
        showDebugByDefaultSubtitle:
          "Espandi automaticamente i payload grezzi degli strumenti nella vista completa.",
      },
      transcript: {
        title: "Trascrizione",
        entrySubtitle: "Apri impostazioni trascrizione",
        footer:
          "Personalizza come vengono mostrati i chat e come si comporta la trascrizione.",
        layoutTitle: "Disposizione",
        layoutFooter:
          "Scegli tra una trascrizione lineare e il raggruppamento per turni.",
        layoutPickerTitle: "Layout trascrizione",
        layout: {
          linearTitle: "Lineare (attuale)",
          linearSubtitle: "Mostra i messaggi come lista piatta.",
          turnsTitle: "Turni",
          turnsSubtitle: "Raggruppa i messaggi in turni utente/assistente.",
        },
        activityGroupTitle: "Raggruppa strumenti in Attività",
        activityGroupSubtitle:
          "Compatta le chiamate strumento in una sezione Attività dentro ogni turno.",
        toolAppearanceTitle: "Aspetto strumenti",
        toolAppearanceSubtitle:
          "Personalizza come appaiono gli strumenti nella trascrizione.",
        motionTitle: "Movimento",
        motionFooter: "Controlla le animazioni nella trascrizione.",
        motionPickerTitle: "Animazioni",
        motion: {
          offTitle: "Disattivato",
          offSubtitle: "Disattiva le animazioni della trascrizione.",
          subtleTitle: "Sottile (predefinito)",
          subtleSubtitle: "Movimento minimo e veloce per nuova attività.",
          fullTitle: "Completo",
          fullSubtitle: "Movimento e transizioni più espressive.",
        },
        advancedMotionTitle: "Movimento avanzato…",
        advancedMotionSubtitle:
          "Regola finestra di freschezza e toggle animazioni.",
        scrollTitle: "Scorrimento",
        scrollFooter: "Controlla pin e comportamento vai in fondo.",
        scrollPinTitle: "Ancora in fondo",
          scrollPinSubtitle:
            "Segui i nuovi messaggi quando sei in fondo.",
            jumpToBottomTitle: "Pulsante vai in fondo",
            jumpToBottomButtonLabel: "Vai in fondo",
            jumpToBottomSubtitle:
              "Mostra un pulsante quando scorri su e arriva nuova attività.",
            advancedScrollTitle: "Scorrimento avanzato…",
          advancedScrollSubtitle: "Regola soglie e contatori.",
          advancedTitle: "Avanzato…",
          advancedSubtitle: "Controlli di prestazioni e debug.",
          advanced: {
            turnGroupingTitle: "Raggruppamento per turni",
            turnGroupingFooter:
            "Controlla come si forma Attività dentro i turni.",
            performanceTitle: "Prestazioni",
            performanceFooter: "Controlli prestazioni per streaming e liste.",
            coalesceEnabledTitle: "Raggruppa aggiornamenti in streaming",
            coalesceEnabledSubtitle:
              "Raggruppa gli aggiornamenti socket per mantenere lo scorrimento fluido.",
            coalesceWindowTitle: "Finestra di raggruppamento",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `Attuale: ${value}ms`,
            coalesceWindowPromptTitle: "Finestra di raggruppamento (ms)",
            coalesceWindowPromptBody:
              "Imposta ogni quanto gli aggiornamenti raggruppati vengono applicati allo store.",
            coalesceMaxBatchTitle: "Dimensione massima batch",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `Attuale: ${value}`,
            coalesceMaxBatchPromptTitle: "Dimensione massima batch",
            coalesceMaxBatchPromptBody:
              "Imposta un limite massimo di messaggi applicati in un singolo flush.",
            thinkingPulseStaleTitle: "Finestra di scadenza del pensiero",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Attuale: ${value}ms`,
            thinkingPulseStalePromptTitle: "Finestra di scadenza del pensiero (ms)",
            thinkingPulseStalePromptBody:
              "Nasconde il pensiero attivo dopo questo tempo senza aggiornamenti.",
            listImplementationTitle: "Implementazione lista trascrizione",
            listImplementationSubtitle: "Cambia motore lista (debug).",
            listImplementation: {
              flashTitle: "FlashList v2 (consigliato)",
              flashSubtitle: "Migliori prestazioni per trascrizioni lunghe.",
              legacyTitle: "FlatList legacy",
              legacySubtitle: "Alternativa per debug compatibilità.",
            },
          activityStrategyTitle: "Strategia raggruppamento Attività",
          activityStrategy: {
            consecutiveTitle: "Strumenti consecutivi (predefinito)",
            consecutiveSubtitle:
              "Raggruppa solo chiamate strumento consecutive in Attività.",
            allToolsTitle: "Tutti gli strumenti nel turno",
            allToolsSubtitle:
              "Raggruppa tutte le chiamate strumento del turno in una sola sezione Attività.",
          },
            activityCollapsedPreviewCountTitle: "Anteprima (compresso)",
            activityCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Mostra gli ultimi ${value} strumenti quando Attività è compresso.`,
            activityCollapsedPreviewCount: {
              offTitle: "Disattivato",
              offSubtitle: "Mostra solo l'intestazione di Attività.",
              oneTitle: "1 strumento",
              oneSubtitle: "Mostra lo strumento più recente come riga di anteprima.",
              twoTitle: "2 strumenti",
              twoSubtitle: "Mostra i 2 strumenti più recenti come righe di anteprima.",
              threeTitle: "3 strumenti",
              threeSubtitle: "Mostra i 3 strumenti più recenti come righe di anteprima.",
              countTitle: ({ value }: { value: string }) => `${value} strumenti`,
              countSubtitle: ({ value }: { value: string }) =>
                `Mostra i ${value} strumenti più recenti come righe di anteprima.`,
            },
          motionTitle: "Movimento (avanzato)",
          motionFooter:
            "Le animazioni sono limitate dalla freschezza per mantenere stabile la cronologia.",
          freshnessTitle: "Finestra di freschezza",
          freshnessSubtitle: ({ value }: { value: string }) => `Attuale: ${value}ms`,
          freshnessPromptTitle: "Finestra di freschezza (ms)",
          freshnessPromptBody:
            "Imposta per quanto tempo i nuovi elementi restano “freschi” per le animazioni.",
          animateNewItemsTitle: "Anima nuovi elementi",
          animateNewItemsSubtitle:
            "Anima messaggi e strumenti in arrivo in streaming.",
          animateToolExpandCollapseTitle: "Anima espandi/comprimi strumenti",
          animateToolExpandCollapseSubtitle:
            "Anima le transizioni di espansione/compressione inline.",
          animateToolExpandCollapseFreshOnlyTitle: "Espandi/comprimi solo freschi",
          animateToolExpandCollapseFreshOnlySubtitle:
            "Anima espandi/comprimi solo per strumenti freschi.",
          animateThinkingTitle: "Anima pensiero",
          animateThinkingSubtitle:
            "Anima i messaggi di pensiero in streaming quando visibili.",
          scrollTitle: "Scorrimento (avanzato)",
          scrollFooter: "Regola soglie pin e comportamento salto.",
          pinOffsetTitle: "Soglia offset ancorato",
          pinOffsetSubtitle: ({ value }: { value: string }) => `Attuale: ${value}px`,
          pinOffsetPromptTitle: "Soglia offset ancorato (px)",
          pinOffsetPromptBody:
            "Imposta quanto lontano dal fondo conta come ancorato.",
          autoFollowTitle: "Auto-segui quando ancorato",
          autoFollowSubtitle:
            "Quando ancorato, segui automaticamente la nuova attività.",
          jumpMinNewCountTitle: "Minimo nuovi per il pulsante",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `Attuale: ${value}`,
          jumpMinNewCountPromptTitle: "Minimo nuovi (pulsante)",
          jumpMinNewCountPromptBody:
            "Mostra il pulsante vai in fondo solo dopo questo numero di nuovi elementi.",
          jumpAnimateScrollTitle: "Anima salto in fondo",
          jumpAnimateScrollSubtitle:
            "Anima lo scorrimento quando vai in fondo.",
        },
      },
        toolDetailOverrides: {
          title: "Override dettaglio strumenti",
          entrySubtitle: "Override strumenti singoli",
          footer:
            "Sovrascrivi il livello di dettaglio per strumenti specifici. Gli override si applicano al nome canonico dello strumento (V2), dopo la normalizzazione legacy.",
          expandedTitle: "Override dettaglio espanso",
          expandedFooter: "Sovrascrivi il livello di dettaglio espanso per strumenti specifici.",
        },
      permissions: {
        title: "Permessi",
        entrySubtitle: "Apri impostazioni permessi",
        footer:
          "Configura i permessi predefiniti e come i cambiamenti si applicano alle sessioni in esecuzione.",
        promptSurfaceTitle: "Richieste permessi",
        promptSurfaceFooter:
          "Scegli dove appaiono le richieste di approvazione durante una sessione.",
        applyChangesFooter:
          "Scegli quando i cambiamenti dei permessi hanno effetto per le sessioni in esecuzione.",
        backendFooter:
          "Imposta la modalità permessi predefinita usata all'avvio delle sessioni con questo backend.",
        defaultPermissionModeTitle: "Modalità permessi predefinita",
        promptSurface: {
          composerTitle: "Vicino al compositore (consigliato)",
          composerSubtitle: "Mostra schede permessi ricche vicino all’input.",
          transcriptTitle: "Nella trascrizione",
          transcriptSubtitle: "Mostra richieste permessi dentro i messaggi strumento.",
          bothTitle: "Entrambi",
          bothSubtitle: "Mostra sia vicino al compositore che nella trascrizione.",
        },
        applyTiming: {
          immediateTitle: "Applica subito",
          nextPromptTitle: "Applica al prossimo messaggio",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "Apri impostazioni sub-agent",
      },
      actionsEntry: {
        footer:
          "Abilita le azioni per superficie e posizionamento (UI, voce, MCP) e controlla dove compaiono.",
        openSubtitle: "Apri impostazioni azioni",
      },
      defaultPermissions: {
        title: "Permessi predefiniti",
        footer:
          "Si applica quando avvii una nuova sessione. I profili possono sovrascriverlo facoltativamente.",
        applyPermissionChangesTitle: "Applica cambiamenti permessi",
        applyPermissionChangesImmediateSubtitle:
          "Applica subito alle sessioni in esecuzione (aggiorna i metadati della sessione).",
        applyPermissionChangesNextPromptSubtitle: "Applica solo al prossimo messaggio.",
      },
      replayResume: {
        title: "Ripresa tramite replay",
        footer:
          "Quando la ripresa del fornitore non è disponibile, riproduci facoltativamente messaggi recenti della trascrizione in una nuova sessione come contesto.",
        enabledTitle: "Abilita ripresa tramite replay",
        enabledSubtitleOn:
          "Offri la ripresa tramite replay quando la ripresa del fornitore non è disponibile.",
        enabledSubtitleOff: "Non offrire la ripresa tramite replay.",
        strategyTitle: "Strategia replay",
        strategy: {
          recentTitle: "Messaggi recenti",
          recentSubtitle: "Usa solo i messaggi più recenti della trascrizione.",
          summaryRecentTitle: "Riepilogo + recenti (sperimentale)",
          summaryRecentSubtitle:
            "Includi un breve riepilogo e messaggi recenti (best-effort).",
        },
        recentMessagesTitle: "Messaggi recenti da includere",
        recentMessagesPlaceholder: "16",
      },
      toolDetailLevel: {
        titleOnlyTitle: "Solo titolo",
        titleOnlySubtitle:
          "Mostra solo il nome dello strumento nella timeline (senza sottotitolo, senza corpo).",
        compactTitle: "Compatto",
        compactSubtitle: "Mostra il nome dello strumento + un breve sottotitolo sulla stessa riga (senza corpo).",
        summaryTitle: "Riepilogo",
        summarySubtitle: "Mostra un riepilogo compatto e sicuro nella timeline.",
        fullTitle: "Completo",
        fullSubtitle: "Mostra tutti i dettagli in linea nella timeline.",
        defaultTitle: "Predefinito",
        defaultSubtitle: "Usa il predefinito globale.",
          styleDefaultTitle: "Predefinito (consigliato)",
          styleDefaultSubtitle: "Schede: Riepilogo. Feed attività: Compatto.",
          expandedStyleDefaultTitle: "Predefinito (consigliato)",
          expandedStyleDefaultSubtitle: "Schede: Completo. Feed attività: Riepilogo.",
      },
      terminalConnect: {
        title: "Connessione terminale",
        legacySecretExportTitle: "Esportazione segreto legacy (compatibilità)",
        legacySecretExportEnabledSubtitle:
          "Abilitato: esporta il segreto legacy del tuo account nel terminale così i terminali più vecchi possono connettersi. Non consigliato.",
        legacySecretExportDisabledSubtitle:
          "Disabilitato (consigliato): effettua il provisioning dei terminali solo con la chiave contenuto (Terminal Connect V2).",
      },
    sessionList: {
      title: "Elenco sessioni",
      footer: "Personalizza cosa appare in ogni riga della sessione.",
      tagsTitle: "Tag della sessione",
      tagsEnabledSubtitle: "Controlli tag visibili nell'elenco sessioni",
      tagsDisabledSubtitle: "Controlli tag nascosti",
    },
  },
  settingsVoice: {
    // Voice settings screen
    modeTitle: "Voce",
    modeDescription:
      "Configura le funzionalità vocali. Puoi disattivare completamente la voce, usare Happier Voice (richiede abbonamento) o usare il tuo account ElevenLabs.",
    mode: {
      off: "Disattivato",
      offSubtitle: "Disattiva tutte le funzionalità vocali",
      happier: "Happier Voice",
      happierSubtitle: "Usa Happier Voice (abbonamento richiesto)",
      local: "Voce OSS locale",
      localSubtitle: "Usa endpoint STT/TTS locali compatibili con OpenAI",
      byo: "Usa il mio ElevenLabs",
      byoSubtitle: "Usa la tua chiave API e il tuo agente ElevenLabs",
    },
    ui: {
      title: "Superficie vocale",
      footer: "Feed opzionale a schermo degli eventi vocali (non scritto nella sessione).",
      activityFeedEnabled: "Abilita feed attività vocale",
      activityFeedEnabledSubtitle: "Mostra eventi vocali recenti a schermo",
      activityFeedAutoExpandOnStart: "Espandi automaticamente all'avvio",
      activityFeedAutoExpandOnStartSubtitle: "Espandi il feed automaticamente quando la voce parte",
      scopeTitle: "Ambito voce predefinito",
      scopeSubtitle: "Scegli se la voce è globale (account) o per sessione di default.",
      scopeGlobal: "Globale (account)",
      scopeGlobalSubtitle: "La voce resta visibile mentre navighi",
      scopeSession: "Sessione",
      scopeSessionSubtitle: "La voce è controllata nella sessione in cui è stata avviata",
      surfaceLocationTitle: "Posizione",
      surfaceLocationSubtitle: "Scegli dove appare la superficie vocale.",
      surfaceLocation: {
        autoTitle: "Automatico",
        autoSubtitle: "Globale in sidebar; sessione nella sessione.",
        sidebarTitle: "Barra laterale",
        sidebarSubtitle: "Mostra nella sidebar.",
        sessionTitle: "Sessione",
        sessionSubtitle: "Mostra sopra l'input nella sessione.",
      },
      updates: {
        title: "Aggiornamenti sessione",
        footer: "Controlla cosa riceve l'assistente vocale come contesto.",
        activeSessionTitle: "Sessione target attiva",
        activeSessionSubtitle: "Cosa inviare automaticamente per la sessione target.",
        otherSessionsTitle: "Altre sessioni",
        otherSessionsSubtitle: "Cosa inviare automaticamente per sessioni non target.",
        level: {
          noneTitle: "Nessuno",
          noneSubtitle: "Non inviare aggiornamenti automatici.",
          activityTitle: "Solo attività",
          activitySubtitle: "Solo conteggi e timestamp.",
          summariesTitle: "Riassunti",
          summariesSubtitle: "Riassunti brevi (senza testo dei messaggi).",
          snippetsTitle: "Snippet",
          snippetsSubtitle: "Snippet brevi di messaggi (rischio privacy).",
        },
        snippetsMaxMessagesTitle: "Max messaggi snippet",
        snippetsMaxMessagesSubtitle: "Limita quanti messaggi includere per aggiornamento.",
        includeUserMessagesInSnippetsTitle: "Includi i tuoi messaggi",
        includeUserMessagesInSnippetsSubtitle: "Se attivo, gli snippet possono includere i tuoi messaggi.",
        otherSessionsSnippetsModeTitle: "Snippet altre sessioni",
        otherSessionsSnippetsModeSubtitle: "Controlla quando sono consentiti snippet per altre sessioni.",
        otherSessionsSnippetsMode: {
          neverTitle: "Mai",
          neverSubtitle: "Disabilita snippet per altre sessioni.",
          onDemandTitle: "Su richiesta",
          onDemandSubtitle: "Consenti solo quando l'utente lo chiede.",
          autoTitle: "Automatico",
          autoSubtitle: "Consenti snippet automatici (rumoroso).",
        },
      },
    },
    byo: {
      title: "Usa il mio ElevenLabs",
      agentReuseDialog: {
        title: "L’agente Happier esiste già",
        messageWithId: ({ name, id }: { name: string; id: string }) =>
          `Abbiamo trovato un agente ElevenLabs esistente (“${name}”, id: ${id}).\n\nVuoi aggiornarlo o crearne uno nuovo?`,
        messageNoId: ({ name }: { name: string }) =>
          `Abbiamo trovato un agente ElevenLabs esistente (“${name}”).\n\nVuoi aggiornarlo o crearne uno nuovo?`,
      },
      configured:
        "Configurato. L’uso della voce verrà addebitato sul tuo account ElevenLabs.",
      notConfigured:
        "Inserisci la tua chiave API ElevenLabs e l’ID agente per usare la voce senza un abbonamento.",
      createAccount: "Crea account ElevenLabs",
      createAccountSubtitle:
        "Registrati (o accedi) prima di creare una chiave API",
      openApiKeys: "Apri chiavi API ElevenLabs",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "Come creare una chiave API",
      apiKeyHelpSubtitle:
        "Guida passo passo per creare e copiare la tua chiave API ElevenLabs",
      apiKeyHelpDialogTitle: "Crea una chiave API ElevenLabs",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Crea agente Happier",
      autoprovCreateSubtitle:
        "Crea e configura un agente Happier nel tuo account ElevenLabs usando la chiave API",
      autoprovUpdate: "Aggiorna agente",
      autoprovUpdateSubtitle:
        "Aggiorna l’agente al template Happier più recente",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `Agente creato: ${agentId}`,
      autoprovUpdated: "Agente aggiornato",
      autoprovFailed: "Impossibile creare/aggiornare l’agente. Riprova.",
      agentId: "ID agente",
      agentIdSet: "Impostato",
      agentIdNotSet: "Non impostato",
      agentIdTitle: "ID agente ElevenLabs",
      agentIdDescription:
        "Inserisci l’ID agente dalla dashboard di ElevenLabs.",
      agentIdPlaceholder: "agent_...",
      apiKey: "Chiave API",
      apiKeySet: "Impostata",
      apiKeyNotSet: "Non impostata",
      apiKeyTitle: "Chiave API di ElevenLabs",
      apiKeyDescription:
        "Inserisci la tua chiave API di ElevenLabs. È salvata in modo crittografato sul dispositivo.",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "Cerca voci",
      speakerBoostTitle: "Boost speaker",
      speakerBoostSubtitle: "Migliora chiarezza e presenza (opzionale).",
      speakerBoostAuto: "Automatico",
      speakerBoostAutoSubtitle: "Usa il valore predefinito di ElevenLabs.",
      speakerBoostOn: "Attivo",
      speakerBoostOnSubtitle: "Forza l’attivazione dello speaker boost.",
      speakerBoostOff: "Disattivo",
      speakerBoostOffSubtitle: "Forza la disattivazione dello speaker boost.",
      voiceGroupTitle: "Voce",
      voiceGroupFooter:
        "Scegli come parla il tuo agente ElevenLabs. Le modifiche si applicano quando aggiorni l’agente.",
      provisioningGroupTitle: "Provisioning agente",
      provisioningGroupFooter:
        "Se cambi voce/impostazioni, tocca Aggiorna agente per applicare in ElevenLabs.",
      realtime: {
        call: {
          title: "Chiamata",
          welcome: {
            title: "Messaggio di benvenuto",
            subtitle: "Saluto opzionale all’inizio della chiamata.",
            detail: {
              off: "Disattivato",
              immediate: "Immediato",
              onFirstTurn: "Al primo turno",
            },
            options: {
              offSubtitle: "Nessun saluto.",
              immediateSubtitle:
                "Saluta non appena la chiamata si connette.",
              onFirstTurnSubtitle:
                "Saluta all’inizio della prima risposta.",
            },
          },
        },
        voicePicker: {
          title: "Voce",
          subtitle: "Scegli la voce ElevenLabs usata per le risposte.",
          missingApiKeyTitle: "Aggiungi la chiave API per caricare le voci",
          loadingTitle: "Caricamento voci…",
          errorTitle: "Impossibile caricare le voci",
          errorSubtitle: "Controlla la chiave API e riprova.",
        },
        modelPicker: {
          title: "Modello",
          subtitle:
            "Opzionale: sovrascrivi l’id del modello TTS di ElevenLabs.",
          detailAuto: "Automatico",
          options: {
            autoTitle: "Automatico",
            autoSubtitle: "Usa il modello predefinito di ElevenLabs.",
            multilingualV2Subtitle: "Predefinito comune (multilingue).",
            turboV2Subtitle:
              "Latenza più bassa (se disponibile nel tuo piano).",
            turboV25Subtitle: "Turbo 2.5 (se disponibile).",
            customTitle: "Personalizzato…",
            customSubtitle: "Inserisci un id modello.",
          },
          prompt: {
            title: "Id modello",
            body: "Inserisci un id modello di ElevenLabs oppure lascia vuoto per usare il predefinito.",
          },
        },
        voiceSettings: {
          default: "Predefinito",
          stability: {
            title: "Stabilità",
            subtitle: "0–1. Lascia vuoto per il predefinito.",
            promptTitle: "Stabilità (0–1)",
            promptBody:
              "Inserisci un numero tra 0 e 1. Lascia vuoto per usare il predefinito.",
            invalid: "Inserisci un numero tra 0 e 1.",
          },
          similarityBoost: {
            title: "Aumento di similarità",
            subtitle: "0–1. Lascia vuoto per il predefinito.",
            promptTitle: "Aumento di similarità (0–1)",
            promptBody:
              "Inserisci un numero tra 0 e 1. Lascia vuoto per usare il predefinito.",
            invalid: "Inserisci un numero tra 0 e 1.",
          },
          style: {
            title: "Stile",
            subtitle: "0–1. Lascia vuoto per il predefinito.",
            promptTitle: "Stile (0–1)",
            promptBody:
              "Inserisci un numero tra 0 e 1. Lascia vuoto per usare il predefinito.",
            invalid: "Inserisci un numero tra 0 e 1.",
          },
          speed: {
            title: "Velocità",
            subtitle: "0.5–2. Lascia vuoto per il predefinito.",
            promptTitle: "Velocità (0.5–2)",
            promptBody:
              "Inserisci un numero tra 0.5 e 2. Lascia vuoto per usare il predefinito.",
            invalid: "Inserisci un numero tra 0.5 e 2.",
          },
        },
        getStartedTitle: "Per iniziare",
      },
      apiKeySaveFailed: "Impossibile salvare la chiave API. Riprova.",
      disconnect: "Disconnetti",
      disconnectSubtitle:
        "Rimuovi le credenziali ElevenLabs salvate da questo dispositivo",
      disconnectTitle: "Disconnetti ElevenLabs",
      disconnectDescription:
        "Questo rimuoverà la chiave API e l’ID agente ElevenLabs salvati da questo dispositivo.",
      disconnectConfirm: "Disconnetti",
    },
    local: {
      title: "Voce OSS locale",
      footer:
        "Configura endpoint compatibili con OpenAI per STT (speech-to-text) e TTS (text-to-speech).",
      localhostWarning:
        'Nota: "localhost" e "127.0.0.1" di solito non funzionano sul telefono. Usa l’IP LAN del computer o un tunnel.',
      notSet: "Non impostato",
      apiKeySet: "Impostata",
      apiKeyNotSet: "Non impostata",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "Opzionale",
      apiKeySaveFailed: "Impossibile salvare la chiave API. Riprova.",
      googleCloudTts: {
        provider: {
          title: "Google Cloud: Text-to-Speech",
          subtitle:
            "Usa la tua chiave API di Google Cloud per sintetizzare audio.",
          detail: "Google Cloud (GCP)",
        },
        common: {
          default: "Predefinito",
        },
        apiKey: {
          title: "Chiave API Google Cloud",
          promptTitle: "Chiave API Google Cloud",
          promptBody:
            "Crea una chiave API con Text-to-Speech API abilitata. Opzionale: limita la chiave a questa app (iOS bundle id / Android package+SHA1).",
        },
        androidCertSha1: {
          title: "SHA-1 certificato Android (opzionale)",
          subtitle:
            "Serve solo se limiti la chiave API alla tua app Android.",
          promptTitle: "SHA-1 certificato Android",
          promptBody:
            "Esempio: AA:BB:CC:... (dal certificato di firma).",
        },
        language: {
          title: "Lingua",
          subtitle: "Filtro opzionale per la lista voci.",
          searchPlaceholder: "Cerca lingue",
          allTitle: "Tutte",
          allSubtitle: "Mostra voci per tutte le lingue.",
        },
        speakingRate: {
          title: "Velocità parlato",
          subtitle: "0.25–4.0 (vuoto = predefinito della voce).",
          promptTitle: "Velocità parlato",
          promptBody:
            "Imposta la velocità (0.25–4.0). Lascia vuoto per il predefinito.",
        },
        pitch: {
          title: "Tono",
          subtitle: "-20–20 (vuoto = predefinito della voce).",
          promptTitle: "Tono",
          promptBody:
            "Imposta il tono (-20–20). Lascia vuoto per il predefinito.",
        },
        voice: {
          title: "Voce",
          subtitle: "Seleziona una voce Google Cloud.",
          searchPlaceholder: "Cerca voci",
          selectPrompt: "Seleziona…",
          setApiKeyPrompt: "Imposta chiave API",
          loadingTitle: "Caricamento voci…",
        },
        format: {
          title: "Formato",
          subtitle: "MP3 è più piccolo; WAV non è compresso.",
          mp3Subtitle: "Output più piccolo, ampia compatibilità.",
          wavSubtitle: "Output più grande, non compresso.",
        },
        alerts: {
          missingApiKey: "Manca la chiave API Google Cloud.",
          missingVoice: "Seleziona prima una voce Google Cloud.",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Gemini di Google (audio)",
          subtitle:
            "Trascrivi audio usando i modelli multimodali di Gemini.",
          detail: "Gemini di Google",
        },
        apiKey: {
          title: "Chiave API di Gemini",
          promptTitle: "Chiave API di Gemini",
          promptBody: "Crea una chiave API in Google AI Studio (Gemini API).",
        },
        model: {
          title: "Modello Gemini",
          subtitle: "Scegli quale modello Gemini usare per la trascrizione.",
          searchPlaceholder: "Cerca modelli",
          customTitle: "ID modello personalizzato…",
          customSubtitle: "Inserisci manualmente un nome modello.",
          loadingModelsTitle: "Caricamento modelli…",
          promptTitle: "Modello Gemini",
          promptBody: "Esempio: gemini-2.5-flash",
        },
        language: {
          title: "Lingua",
          subtitle:
            "Suggerimento opzionale per migliorare la precisione della trascrizione.",
          searchPlaceholder: "Cerca lingue",
          autoTitle: "Automatico",
          autoSubtitle: "Non fornire un suggerimento sulla lingua.",
        },
      },
      kokoro: {
        common: {
          default: "Predefinito",
          none: "N/D",
        },
        runtime: {
          title: "Runtime di Kokoro",
          unsupportedSubtitle: "Kokoro non è supportato su questo dispositivo/runtime.",
          unavailableDetail: "Non disponibile",
        },
        manifest: {
          title: "Manifest del pacchetto modello",
          subtitle:
            "Per impostazione predefinita usa i model pack di Happier (override tramite EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS).",
          detailResolved: "Risolto",
          detailMissing: "Mancante",
        },
        assetPack: {
          title: "Pacchetto modello Kokoro",
          subtitleNative: "Seleziona il pacchetto di risorse per Kokoro.",
          subtitleWeb: "Seleziona la configurazione runtime per Kokoro.",
        },
        model: {
          title: "Modello Kokoro",
          subtitleNative:
            "Scarica i file necessari per abilitare la sintesi sul dispositivo.",
          subtitleWeb: "Scarica su richiesta. Usa WebAssembly (beta).",
        },
        modelStatus: {
          downloading: "Download in corso…",
          downloadingPrefix: "Download",
          ready: "Pronto",
          error: "Errore",
          notDownloaded: "Non scaricato",
        },
        removeAssets: {
          title: "Rimuovi risorse Kokoro",
          subtitle: "Libera spazio rimuovendo i file Kokoro scaricati.",
          detailRemove: "Rimuovi",
          confirmTitle: "Rimuovere le risorse Kokoro?",
          confirmBody:
            "Questo rimuove dal dispositivo i file Kokoro scaricati.",
          confirmButton: "Rimuovi",
        },
        updates: {
          title: "Verifica aggiornamenti modello",
          subtitle:
            "Controlla manualmente se è disponibile un model pack più recente.",
          check: "Verifica",
          upToDate: "Aggiornato",
          updateAvailable: "Aggiornamento disponibile",
        },
        alerts: {
          runtimeUnsupported: {
            body: "Kokoro non è supportato su questo dispositivo/runtime.",
          },
          missingManifest: {
            title: "URL del manifest mancante",
            body: "Impossibile risolvere l’URL del manifest del model pack. Controlla EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (o le vecchie variabili d’ambiente Kokoro).",
          },
          notInstalledTitle: "Non installato",
          notInstalledBody:
            "Scarica prima il model pack per abilitare i controlli di aggiornamento.",
          upToDateTitle: "Aggiornato",
          upToDateBody:
            "Nessun aggiornamento disponibile per questo model pack.",
          updateAvailableTitle: "Aggiornamento disponibile",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Scaricare ora l’ultima versione di questo model pack?${remoteBuild ? `\n\nBuild remota: ${remoteBuild}` : ""}`,
          updatedTitle: "Aggiornato",
          updatedBody: "Model pack aggiornato correttamente.",
          updateFailedTitle: "Aggiornamento non riuscito",
          updateFailedBody: ({ message }: { message: string }) =>
            `Impossibile aggiornare questo model pack.\n\n${message}`,
        },
        voice: {
          title: "Voce",
          subtitleNative: "Seleziona la voce Kokoro.",
          searchPlaceholder: "Cerca voci",
          titleWeb: "Voce Kokoro",
          subtitleWeb: "Scegli la voce sul dispositivo usata per le risposte.",
          loadingVoicesTitle: "Caricamento voci…",
        },
        speed: {
          title: "Velocità",
          subtitle: "Regola la velocità di lettura (0,5–2,0).",
        },
        web: {
          warmingUp: "Riscaldamento…",
          clearCache: {
            confirmTitle: "Svuotare la cache di Kokoro?",
            confirmBody:
              "Questo rimuove dal dispositivo i file modello e voce Kokoro scaricati.",
            confirmButton: "Svuota",
          },
          cacheDetail: {
            modelFiles: "File del modello",
            voices: "Voci",
          },
          cache: {
            title: "Cache Kokoro",
            subtitle: "Gestisci i file Kokoro scaricati su questo dispositivo.",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "Pacchetto modello",
          subtitle: "ID del pacchetto modello STT in streaming.",
        },
        modelFiles: {
          title: "File del modello",
          subtitle:
            "Scarica i file necessari per abilitare lo STT in streaming sul dispositivo.",
        },
        removeModelFiles: {
          title: "Rimuovi file del modello",
          subtitle: "Libera spazio rimuovendo i file del modello scaricati.",
          confirmTitle: "Rimuovere i file del modello?",
          confirmBody:
            "Questo rimuoverà dal dispositivo il pacchetto STT scaricato.",
        },
        status: {
          installed: "Installato",
          installedWithBuild: ({ build }: { build: string }) =>
            `Installato • ${build}`,
          notInstalled: "Non installato",
        },
        language: {
          title: "Lingua",
          subtitle: "Tag lingua BCP-47 opzionale.",
          promptTitle: "Lingua",
          promptBody: "Inserisci un tag lingua BCP-47 (es. en, en-US).",
        },
        alerts: {
          downloadFailedTitle: "Download non riuscito",
          downloadFailedBody: ({ message }: { message: string }) =>
            `Impossibile scaricare questo pacchetto modello.\n\n${message}`,
          notInstalledTitle: "Non installato",
          notInstalledBody:
            "Scarica prima il pacchetto modello per abilitare il controllo aggiornamenti.",
          upToDateBody:
            "Nessun aggiornamento disponibile per questo pacchetto modello.",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Scaricare ora l’ultima versione di questo pacchetto modello?${remoteBuild ? `\n\nBuild remota: ${remoteBuild}` : ""}`,
          updatedTitle: "Aggiornato",
          updatedBody: "Pacchetto modello aggiornato con successo.",
          updateFailedTitle: "Aggiornamento non riuscito",
          updateFailedBody: ({ message }: { message: string }) =>
            `Impossibile aggiornare questo pacchetto modello.\n\n${message}`,
        },
      },
      conversationMode: "Modalità conversazione",
      conversationModeSubtitle:
        "Diretto alla sessione, o mediatore con commit esplicito",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "Usa l’agente vocale (commit esplicito, controllo strumenti).",
          directTitle: "Sessione diretta",
          directSubtitle: "Parla direttamente nella sessione attiva.",
        },
        handsFree: {
          title: "Mani libere",
          enableTitle: "Abilita mani libere",
          silenceTitle: "Timeout silenzio (ms)",
          minSpeechTitle: "Parlato minimo (ms)",
        },
        customBackendIdSubtitle: "Inserisci un id backend personalizzato.",
        searchBackendsPlaceholder: "Cerca backend",
        searchModelsPlaceholder: "Cerca modelli",
        machineAutoSubtitle:
          "Seleziona automaticamente una macchina in base all’uso recente.",
        rootSessionPolicy: {
          title: "Politica sessione radice",
          fallbackSubtitle: "Scegli una politica.",
          singleTitle: "Singola",
          singleSubtitle: "Crea una nuova sessione radice ogni volta.",
          keepWarmTitle: "Mantieni calda",
          keepWarmSubtitle:
            "Riutilizza una sessione radice calda quando possibile.",
          maxWarmRootsTitle: "Max radici calde",
          maxWarmRootsSubtitle:
            "Limita quante sessioni radice calde mantenere.",
        },
        persistence: {
          title: "Persistenza trascrizione",
          ephemeralTitle: "Effimera",
          ephemeralSubtitle:
            "Non salvare lo stato dell’agente vocale tra le sessioni.",
          persistentTitle: "Persistente",
          persistentSubtitle:
            "Salva lo stato dell’agente vocale tra le sessioni (riprendibile).",
        },
        resetVoiceAgent: {
          title: "Reimposta stato agente vocale",
          subtitle: "Cancella lo stato persistente dell’agente vocale.",
          confirmBody:
            "Questo cancellerà lo stato salvato dell’agente vocale. Non puoi annullare.",
        },
        agentSettings: {
          title: "Agente vocale",
        },
        backend: {
          daemonSubtitle:
            "Usa il backend Happier e supporta la ripresa del provider.",
          openAiSubtitle:
            "Connetti a endpoint HTTP compatibili con OpenAI.",
        },
        agentMachine: {
          title: "Macchina agente",
          fallbackSubtitle: "Scegli dove eseguire l’agente vocale.",
          stayInVoiceHomeTitle: "Resta in voice home",
          stayInVoiceHomeEnabledSubtitle:
            "Mantieni l’agente sulla macchina voice home.",
          stayInVoiceHomeDisabledSubtitle:
            "Consenti all’agente di seguire la macchina della sessione.",
          allowTeleportTitle: "Consenti teletrasporto",
          teleportEnabledSubtitle:
            "Consenti di spostare l’agente su un’altra macchina quando serve.",
          teleportDisabledSubtitle: "Teletrasporto disabilitato.",
        },
        agentSource: {
          followSessionTitle: "Segui sessione",
          followSessionSubtitle:
            "Usa backend e configurazione della sessione.",
          fixedAgentTitle: "Agente fisso",
          fixedAgentSubtitle:
            "Usa sempre un backend agente specifico.",
        },
        permissionPolicy: {
          readOnlySubtitle:
            "Può vedere il contesto, ma non può eseguire strumenti.",
          noToolsSubtitle:
            "Dovrebbe evitare richieste di strumenti e non eseguirli mai.",
        },
        chatModelSource: {
          sessionSubtitle:
            "Usa la configurazione del modello di sessione per la chat dell’agente.",
          customSubtitle:
            "Sovrascrivi l’id modello chat dell’agente vocale.",
        },
        chatModelId: {
          title: "Id modello chat agente vocale",
          subtitle:
            "Usato quando l’origine del modello chat è impostata su Modello personalizzato.",
        },
        commitModelSource: {
          chatSubtitle: "Usa il modello chat dell’agente per i commit.",
          sessionSubtitle:
            "Usa la configurazione del modello di sessione per i commit.",
          customSubtitle:
            "Sovrascrivi l’id modello commit dell’agente vocale.",
        },
        commitModelId: {
          title: "Id modello commit agente vocale",
          subtitle:
            "Usato quando l’origine del modello commit è impostata su Modello personalizzato.",
        },
        commitIsolation: {
          title: "Isolamento commit",
          subtitle:
            "Usa una sessione del vendor separata per generare i commit (avanzato).",
        },
        resumability: {
          modeTitle: "Ripresa",
          replayTitle: "Riproduzione",
          replaySubtitle: "Riprendi riproducendo i messaggi recenti.",
          providerResumeTitle: "Ripresa provider",
          providerResumeSubtitle:
            "Riprendi usando lo stato della sessione del provider (se supportato).",
          disabledVoiceAgent: "Richiede Happier Voice Agent.",
          disabledDaemonBackend: "Richiede backend Daemon.",
          disabledAgentNoProviderResume:
            "L’agente selezionato non supporta la ripresa del provider.",
        },
        providerResumeFallback: {
          title: "Fallback a replay",
          subtitle:
            "Se la ripresa del provider fallisce, passa al replay.",
        },
        replayRecentMessagesPromptBody:
          "Quanti messaggi recenti includere (1–100).",
        prewarm: {
          title: "Pre-riscalda alla connessione",
          subtitle: "Avvia subito l’agente vocale quando ti connetti.",
        },
        welcome: {
          title: "Messaggio di benvenuto",
          offTitle: "Disattivato",
          offSubtitle: "Non inviare un messaggio di benvenuto.",
          immediateTitle: "Immediato",
          immediateSubtitle:
            "Invia un messaggio di benvenuto appena l’agente parte.",
          onFirstTurnTitle: "Al primo turno",
          onFirstTurnSubtitle:
            "Invia il benvenuto quando parli la prima volta.",
        },
        verbosity: {
          shortSubtitle: "Mantieni le risposte dell’agente brevi.",
          balancedSubtitle:
            "Consenti un po’ più di dettaglio quando serve.",
        },
        streaming: {
          title: "Trasmissione",
          enableTitle: "Abilita streaming",
          enableTtsTitle: "Abilita streaming TTS",
          ttsChunkCharsTitle: "Caratteri chunk TTS",
          ttsChunkCharsPromptBody:
            "Quanti caratteri bufferizzare prima di richiedere il chunk TTS successivo (32–2000).",
        },
        network: {
          title: "Rete",
          timeoutTitle: "Timeout rete (ms)",
          timeoutPromptBody:
            "Timeout per le richieste ai tuoi endpoint (1000–60000).",
        },
      },
      mediatorBackend: "Backend mediatore",
      mediatorBackendSubtitle:
        "Daemon (usa il backend Happier) o OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Demone",
      mediatorBackendOpenAi: "HTTP compatibile con OpenAI",
      mediatorAgentSource: "Sorgente agente mediatore",
      mediatorAgentSourceSubtitle:
        "Usa il backend della sessione o forza un agente specifico",
      mediatorAgentSourceSession: "Backend sessione",
      mediatorAgentSourceAgent: "Agente specifico",
      mediatorAgentId: "Agente mediatore",
      mediatorAgentIdSubtitle:
        "Quale backend agente usare per il mediatore (quando non si usa la sessione)",
      mediatorPermissionPolicy: "Permessi del mediatore",
      mediatorPermissionPolicySubtitle:
        "Limita l’uso degli strumenti durante la mediazione",
      mediatorPermissionReadOnly: "Sola lettura",
      mediatorPermissionNoTools: "Nessun tool",
      mediatorVerbosity: "Verbosità mediatore",
      mediatorVerbositySubtitle: "Quanto dettagliato deve essere il mediatore",
      mediatorVerbosityShort: "Breve",
      mediatorVerbosityBalanced: "Bilanciato",
      mediatorIdleTtl: "TTL inattività mediatore",
      mediatorIdleTtlSubtitle: "Arresto automatico dopo inattività (60–3600s)",
      mediatorIdleTtlTitle: "TTL inattività mediatore (secondi)",
      mediatorIdleTtlDescription: "Inserisci un numero tra 60 e 3600.",
      mediatorIdleTtlInvalid: "Inserisci un numero tra 60 e 3600.",
      mediatorChatModelSource: "Origine modello (chat)",
      mediatorChatModelSourceSubtitle:
        "Usa il modello della sessione o un modello veloce personalizzato",
      mediatorChatModelSourceSession: "Modello sessione",
      mediatorChatModelSourceCustom: "Modello personalizzato",
      mediatorCommitModelSource: "Origine modello (commit)",
      mediatorCommitModelSourceSubtitle:
        "Usa modello chat, modello sessione o un modello personalizzato",
      mediatorCommitModelSourceChat: "Modello chat",
      mediatorCommitModelSourceSession: "Modello sessione",
      mediatorCommitModelSourceCustom: "Modello personalizzato",
      chatBaseUrl: "URL base Chat",
      chatBaseUrlTitle: "URL base Chat",
      chatBaseUrlDescription:
        "URL base per l’endpoint chat completion compatibile con OpenAI (di solito termina con /v1).",
      chatApiKey: "Chiave API Chat",
      chatApiKeyTitle: "Chiave API Chat",
      chatApiKeyDescription:
        "Chiave API opzionale per il server chat (salvata crittografata). Lascia vuoto per cancellare.",
      chatModel: "Modello chat",
      chatModelSubtitle: "Modello veloce per la conversazione vocale",
      chatModelTitle: "Modello chat",
      chatModelDescription:
        "Nome modello da inviare al server chat (campo compatibile con OpenAI).",
      modelCustomTitle: "Personalizzato…",
      modelCustomSubtitle: "Inserisci un ID modello",
      commitModel: "Modello commit",
      commitModelSubtitle:
        "Modello per generare il messaggio finale di istruzioni",
      commitModelTitle: "Modello commit",
      commitModelDescription:
        "Nome modello da usare per generare il messaggio finale.",
      chatTemperature: "Temperatura chat",
      chatTemperatureSubtitle: "Controlla la casualità (0–2)",
      chatTemperatureTitle: "Temperatura chat",
      chatTemperatureDescription: "Inserisci un numero tra 0 e 2.",
      chatTemperatureInvalid: "Inserisci un numero tra 0 e 2.",
      chatMaxTokens: "Max token chat",
      chatMaxTokensSubtitle: "Limita la lunghezza (vuoto = default)",
      chatMaxTokensTitle: "Max token chat",
      chatMaxTokensDescription:
        "Inserisci un intero positivo o lascia vuoto per default.",
      chatMaxTokensPlaceholder: "Vuoto = default",
      chatMaxTokensUnlimited: "Predefinito",
      chatMaxTokensInvalid: "Inserisci un numero positivo o lascia vuoto.",
      sttBaseUrl: "URL base STT",
      sttBaseUrlTitle: "URL base STT",
      sttBaseUrlDescription:
        "URL base per l’endpoint di trascrizione compatibile con OpenAI (di solito termina con /v1).",
      sttApiKey: "Chiave API STT",
      sttApiKeyTitle: "Chiave API STT",
      sttApiKeyDescription:
        "Chiave API opzionale per il server STT (salvata crittografata). Lascia vuoto per cancellare.",
      sttModel: "Modello STT",
      sttModelSubtitle: "Nome modello inviato nelle richieste di trascrizione",
      sttModelTitle: "Modello STT",
      sttModelDescription:
        "Nome modello da inviare al server STT (campo compatibile con OpenAI).",
      deviceStt: "STT del dispositivo (sperimentale)",
      deviceSttSubtitle:
        "Usa il riconoscimento vocale sul dispositivo invece di un endpoint compatibile con OpenAI",
      sttProvider: "Provider STT",
      neuralStt: {
        title: "STT sul dispositivo",
        webNotAvailableSubtitle:
          "Non disponibile sul web. Usa STT del dispositivo, compatibile OpenAI o Gemini STT.",
      },
      ttsBaseUrl: "URL base TTS",
      ttsBaseUrlTitle: "URL base TTS",
      ttsBaseUrlDescription:
        "URL base per l’endpoint speech compatibile con OpenAI (di solito termina con /v1).",
      ttsApiKey: "Chiave API TTS",
      ttsApiKeyTitle: "Chiave API TTS",
      ttsApiKeyDescription:
        "Chiave API opzionale per il server TTS (salvata crittografata). Lascia vuoto per cancellare.",
      ttsModel: "Modello TTS",
      ttsModelSubtitle: "Nome modello inviato nelle richieste speech",
      ttsModelTitle: "Modello TTS",
      ttsModelDescription:
        "Nome modello da inviare al server TTS (campo compatibile con OpenAI).",
      ttsVoice: "Voce TTS",
      ttsVoiceSubtitle: "Nome/ID voce inviato nelle richieste speech",
      ttsVoiceTitle: "Voce TTS",
      ttsVoiceDescription:
        "Nome/ID voce da inviare al server TTS (campo compatibile con OpenAI).",
      ttsFormat: "Formato TTS",
      ttsFormatSubtitle: "Formato audio restituito dal TTS",
      ttsFormatOptions: {
        mp3Subtitle: "Output più piccolo, ampiamente compatibile.",
        wavSubtitle: "Output più grande, non compresso.",
      },
      testTts: "Prova TTS",
      testTtsSubtitle:
        "Riproduci un breve esempio usando il TTS locale configurato (TTS del dispositivo o endpoint)",
      testTtsSample: "Ciao da Happier. Questo è un test del tuo TTS locale.",
      testTtsMissingBaseUrl: "Imposta prima un URL base TTS.",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "TTS del dispositivo (sperimentale)",
      deviceTtsSubtitle:
        "Usa la sintesi vocale sul dispositivo invece di un endpoint compatibile con OpenAI",
      ttsProvider: "Provider TTS",
      ttsProviderSubtitle:
        "Scegli TTS dispositivo, un endpoint compatibile con OpenAI o Kokoro (web/desktop)",

      autoSpeak: "Auto-leggi le risposte",
      autoSpeakSubtitle:
        "Leggi la prossima risposta dell’assistente dopo aver inviato il messaggio vocale",
      bargeIn: "Interruzione",
      speaking: "Parlando…",
    },
    privacy: {
      title: "Riservatezza",
      footer: "I provider vocali ricevono il contesto di sessione selezionato.",
      shareSessionSummary: "Condividi riepilogo sessione",
      shareSessionSummarySubtitle: "Includi il riepilogo nel contesto vocale",
      shareRecentMessages: "Condividi messaggi recenti",
      shareRecentMessagesSubtitle:
        "Includi i messaggi recenti nel contesto vocale",
      recentMessagesCount: "Numero di messaggi recenti",
      recentMessagesCountSubtitle: "Quanti messaggi recenti includere (0–50)",
      recentMessagesCountTitle: "Numero di messaggi recenti",
      recentMessagesCountDescription: "Inserisci un numero tra 0 e 50.",
      recentMessagesCountInvalid: "Inserisci un numero tra 0 e 50.",
      shareToolNames: "Condividi nomi strumenti",
      shareToolNamesSubtitle: "Includi nomi/descrizioni strumenti nel contesto vocale",
      shareDeviceInventory: "Condividi inventario dispositivo",
      shareDeviceInventorySubtitle:
        "Consenti alla voce di elencare workspace, macchine e server recenti",
      shareToolArgs: "Condividi argomenti strumenti",
      shareToolArgsSubtitle: "Includi argomenti strumenti (puo' includere percorsi o segreti)",
      sharePermissionRequests: "Condividi richieste di permesso",
      sharePermissionRequestsSubtitle: "Inoltra richieste di permesso alla voce",
      shareFilePaths: "Condividi percorsi locali",
      shareFilePathsSubtitle:
        "Includi percorsi locali nel contesto vocale (non consigliato)",
    },
    languageTitle: "Lingua",
    languageDescription:
      "Scegli la tua lingua preferita per le interazioni dell'assistente vocale. Questa impostazione si sincronizza su tutti i tuoi dispositivi.",
    preferredLanguage: "Lingua preferita",
    preferredLanguageSubtitle:
      "Lingua usata per le risposte dell'assistente vocale",
    language: {
      searchPlaceholder: "Cerca lingue...",
      title: "Lingue",
      footer: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "lingua", plural: "lingue" })} disponibili`,
      autoDetect: "Rilevamento automatico",
      autoDetectSubtitle: "Lascia decidere al riconoscitore (consigliato).",
      customTitle: "Personalizzato…",
      customSubtitle: "Inserisci un tag lingua BCP-47.",
      options: {
        english: "Inglese",
        englishUs: "Inglese (USA)",
        french: "Francese",
        spanish: "Spagnolo",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Informazioni account",
    status: "Stato",
    statusActive: "Attivo",
    statusNotAuthenticated: "Non autenticato",
    anonymousId: "ID anonimo",
    publicId: "ID pubblico",
    notAvailable: "Non disponibile",
    linkNewDevice: "Scansiona il QR per collegare un nuovo dispositivo",
    linkNewDeviceSubtitle: "Scansiona il codice QR mostrato sul tuo nuovo dispositivo",
    profile: "Profilo",
    name: "Nome",
    github: "GitHub",
    showGitHubOnProfile: "Mostra nel profilo",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `Mostra ${provider} nel profilo`,
    tapToDisconnect: "Tocca per disconnettere",
    server: "Server (connessione)",
    backup: "Copia di backup",
    backupDescription:
      "La tua chiave segreta è l'unico modo per recuperare l'account. Salvala in un posto sicuro come un gestore di password.",
    secretKey: "Chiave segreta",
    tapToReveal: "Tocca per mostrare",
    tapToHide: "Tocca per nascondere",
    secretKeyLabel: "CHIAVE SEGRETA (TOCCA PER COPIARE)",
    secretKeyCopied:
      "Chiave segreta copiata negli appunti. Conservala in un luogo sicuro!",
    secretKeyCopyFailed: "Impossibile copiare la chiave segreta",
    privacy: "Riservatezza",
    privacyDescription:
      "Aiuta a migliorare l'app condividendo dati di utilizzo anonimi. Nessuna informazione personale viene raccolta.",
    analytics: "Analisi",
    analyticsDisabled: "Nessun dato condiviso",
    analyticsEnabled: "I dati di utilizzo anonimi sono condivisi",
    crashReports: "Segnalazioni di crash",
    crashReportsDisabled: "Nessuna segnalazione di crash condivisa",
    crashReportsEnabled: "Le segnalazioni di crash sono condivise",
    dangerZone: "Zona pericolosa",
    logout: "Esci",
    logoutSubtitle: "Disconnetti e cancella i dati locali",
    logoutConfirm:
      "Sei sicuro di voler uscire? Assicurati di aver fatto il backup della tua chiave segreta!",
    encryptionUpdateFailed: "Impossibile aggiornare l’impostazione di crittografia",
    secretKeyMissing: "Chiave segreta non disponibile. Ripristina prima il tuo account.",
    restoreRequiredTitle: "Ripristino richiesto",
    restoreRequiredBody:
      "Questo account ha una cronologia cifrata. Per riattivare la crittografia su questo dispositivo, ripristina la tua chiave segreta. Se hai perso la chiave, puoi reimpostare l’account per ricominciare da zero (la cronologia cifrata precedente non può essere recuperata).",
  },

  settingsLanguage: {
    // Language settings screen
    title: "Lingua",
    description:
      "Scegli la tua lingua preferita per l'interfaccia dell'app. Questo si sincronizza su tutti i tuoi dispositivi.",
    currentLanguage: "Lingua attuale",
    automatic: "Automatico",
    automaticSubtitle: "Rileva dalle impostazioni del dispositivo",
    needsRestart: "Lingua cambiata",
    needsRestartMessage:
      "L'app deve riavviarsi per applicare la nuova impostazione della lingua.",
    restartNow: "Riavvia ora",
  },

  connectButton: {
    authenticate: "Autentica terminale",
    authenticateWithUrlPaste: "Autentica terminale incollando URL",
    pasteAuthUrl: "Incolla l'URL di autenticazione dal terminale",
  },

  updateBanner: {
    updateAvailable: "Aggiornamento disponibile",
    pressToApply: "Premi per applicare l'aggiornamento",
    whatsNew: "Novità",
    seeLatest: "Vedi gli ultimi aggiornamenti e miglioramenti",
    nativeUpdateAvailable: "Aggiornamento app disponibile",
    tapToUpdateAppStore: "Tocca per aggiornare nell'App Store",
    tapToUpdatePlayStore: "Tocca per aggiornare nel Play Store",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `Versione ${version}`,
    noEntriesAvailable: "Nessuna voce di changelog disponibile.",
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Browser web richiesto",
    webBrowserRequiredDescription:
      "I link di connessione del terminale possono essere aperti solo in un browser web per motivi di sicurezza. Usa lo scanner QR o apri questo link su un computer.",
    processingConnection: "Elaborazione connessione...",
    invalidConnectionLink: "Link di connessione non valido",
    invalidConnectionLinkDescription:
      "Il link di connessione è mancante o non valido. Controlla l'URL e riprova.",
    connectTerminal: "Connetti terminale",
    terminalRequestDescription:
      "Un terminale richiede di connettersi al tuo account Happier Coder. Questo consentirà al terminale di inviare e ricevere messaggi in modo sicuro.",
    connectionDetails: "Dettagli connessione",
    publicKey: "Chiave pubblica",
    encryption: "Cifratura",
    endToEndEncrypted: "Crittografia end-to-end",
    acceptConnection: "Accetta connessione",
    connecting: "Connessione...",
    reject: "Rifiuta",
    security: "Sicurezza",
    securityFooter:
      "Questo link di connessione è stato elaborato in modo sicuro nel tuo browser e non è mai stato inviato a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.",
    securityFooterDevice:
      "Questa connessione è stata elaborata in modo sicuro sul tuo dispositivo e non è mai stata inviata a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.",
    clientSideProcessing: "Elaborazione lato client",
    linkProcessedLocally: "Link elaborato localmente nel browser",
    linkProcessedOnDevice: "Link elaborato localmente sul dispositivo",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `This connection is for ${serverUrl}. Switch servers and continue?`,
  },

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Autentica terminale",
    pasteUrlFromTerminal: "Incolla l'URL di autenticazione dal terminale",
    deviceLinkedSuccessfully: "Dispositivo collegato con successo",
    terminalConnectedSuccessfully: "Terminale collegato con successo",
    terminalAlreadyConnected: "Connessione già utilizzata",
    terminalConnectionAlreadyUsedDescription: "Questo collegamento è già stato utilizzato da un altro dispositivo. Per collegare più dispositivi allo stesso terminale, disconnetti e accedi allo stesso account su tutti i dispositivi.",
    authRequestExpired: "Connessione scaduta",
    authRequestExpiredDescription: "Questo collegamento è scaduto. Genera un nuovo collegamento dal tuo terminale.",
    pleaseSignInFirst: "Please sign in (or create an account) first.",
    invalidAuthUrl: "URL di autenticazione non valido",
    microphoneAccessRequiredTitle: "Accesso al microfono richiesto",
    microphoneAccessRequiredRequestPermission:
      "Happier ha bisogno dell’accesso al microfono per la chat vocale. Concedi il permesso quando richiesto.",
    microphoneAccessRequiredEnableInSettings:
      "Happier ha bisogno dell’accesso al microfono per la chat vocale. Abilita l’accesso al microfono nelle impostazioni del dispositivo.",
    microphoneAccessRequiredBrowserInstructions:
      "Consenti l’accesso al microfono nelle impostazioni del browser. Potrebbe essere necessario fare clic sull’icona del lucchetto nella barra degli indirizzi e abilitare il permesso del microfono per questo sito.",
    openSettings: "Apri impostazioni",
    developerMode: "Modalità sviluppatore",
    developerModeEnabled: "Modalità sviluppatore attivata",
    developerModeDisabled: "Modalità sviluppatore disattivata",
    disconnectGithub: "Disconnetti GitHub",
    disconnectGithubConfirm:
      "La disconnessione disattiva Amici e la condivisione tra amici finché non ti ricolleghi.",
    disconnectService: ({ service }: { service: string }) =>
      `Disconnetti ${service}`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `Sei sicuro di voler disconnettere ${service} dal tuo account?`,
    disconnect: "Disconnetti",
    failedToConnectTerminal: "Impossibile connettere il terminale",
    cameraPermissionsRequiredToConnectTerminal:
      "Sono necessarie le autorizzazioni della fotocamera per connettere il terminale",
    failedToLinkDevice: "Impossibile collegare il dispositivo",
    cameraPermissionsRequiredToScanQr:
      "Sono necessarie le autorizzazioni della fotocamera per scansionare i codici QR",
    qrScannerUnavailable:
      "Impossibile aprire lo scanner QR. Riprova o inserisci l’URL manualmente.",
  },

    navigation: {
      // Navigation titles and screen headers
      connectTerminal: "Connetti terminale",
      linkNewDevice: "Collega nuovo dispositivo",
      restoreWithSecretKey: "Ripristina con chiave segreta",
      whatsNew: "Novità",
      friends: "Amici",
      automations: "Automazioni",
      automation: "Automazione",
      newAutomation: "Nuova automazione",
      sourceControl: "Controllo di versione",
      developerTools: "Strumenti sviluppatore",
      listComponentsDemo: "Demo componenti lista",
      typography: "Tipografia",
      colors: "Colori",
      toolViewsDemo: "Demo viste strumenti",
      maskedProgress: "Progresso mascherato",
      shimmerViewDemo: "Demo effetto shimmer",
      multiTextInput: "Input testo multiplo",
      connectClaude: "Connetti a Claude",
      zenNewTask: "Nuovo compito",
      zenTaskDetails: "Dettagli compito",
    },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Client mobile di Codex e Claude Code",
    subtitle:
      "Crittografia end-to-end e account memorizzato solo sul tuo dispositivo.",
    createAccount: "Crea account",
    chooseEncryptionTitle: "Scegli la crittografia",
    chooseEncryptionBody: "Questo server supporta account crittografati e non crittografati. Scegli come vuoi archiviare i dati del tuo account.",
    chooseEncryptionEncrypted: "Continua con crittografia end‑to‑end",
    chooseEncryptionPlain: "Continua senza crittografia",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Continua con ${provider}`,
    signInWithCertificate: "Accedi con certificato",
    linkOrRestoreAccount: "Collega o ripristina account",
    loginWithMobileApp: "Accedi con l'app mobile",
    serverUnavailableTitle: "Impossibile raggiungere il server",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Non riusciamo a connetterci a ${serverUrl}. Riprova o cambia server per continuare.`,
    serverIncompatibleTitle: "Server non supportato",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Il server su ${serverUrl} ha restituito una risposta inattesa. Aggiorna il server o cambia server per continuare.`,
  },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "Ti piace l'app?",
    feedbackPrompt: "Ci piacerebbe ricevere il tuo feedback!",
    yesILoveIt: "Sì, mi piace!",
    notReally: "Non proprio",
  },

  items: {
    // Used by Item component for copy toast
    copiedToClipboard: ({ label }: { label: string }) =>
      `${label} copiato negli appunti`,
  },

     machine: {
    launchNewSessionInDirectory: "Avvia nuova sessione nella directory",
    offlineUnableToSpawn: "Avvio disabilitato quando la macchina è offline",
    offlineHelp:
      "• Assicurati che il tuo computer sia online\n• Esegui `happier daemon status` per diagnosticare\n• Stai usando l'ultima versione della CLI? Aggiorna con `npm install -g @happier-dev/cli@latest`",
    customPathPlaceholder: "Inserisci un percorso personalizzato",
    tools: {
      title: "Strumenti",
      installablesTitle: "Installabili",
      installablesSubtitle:
        "Gestisci gli strumenti installabili per questa macchina.",
    },
    installables: {
      screenTitle: "Installabili",
      aboutGroupTitle: "Info",
      aboutSubtitle:
        "Gestisci gli strumenti che Happier può installare e mantenere aggiornati su questa macchina.",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title} (sperimentale)`,
      autoInstallTitle: "Auto‑installa quando necessario",
      autoInstallSubtitle:
        "Installa in background quando richiesto per un backend selezionato (best effort).",
      autoUpdateTitle: "Auto‑aggiornamento",
      autoUpdatePromptTitle: "Auto‑aggiornamento",
      autoUpdatePromptBody:
        "Scegli come Happier deve gestire gli aggiornamenti per questo installabile.",
      autoUpdateModes: {
        off: "Disattivato",
        notify: "Notifica",
        auto: "Automatico",
      },
    },
    daemon: "Demone",
    status: "Stato",
    daemonStatus: {
      unknown: "Sconosciuto",
      stopped: "Arrestato",
      likelyAlive: "Probabilmente attivo",
    },
    stopDaemon: "Arresta daemon",
    stopDaemonConfirmTitle: "Arrestare il daemon?",
    stopDaemonConfirmBody:
      "Non potrai avviare nuove sessioni su questa macchina finché non riavvii il daemon sul computer. Le sessioni correnti resteranno attive.",
    daemonStoppedTitle: "Daemon arrestato",
    stopDaemonFailed:
      "Impossibile arrestare il daemon. Potrebbe non essere in esecuzione.",
    renameTitle: "Rinomina macchina",
    renameDescription:
      "Assegna a questa macchina un nome personalizzato. Lascia vuoto per usare l’hostname predefinito.",
      renamePlaceholder: "Inserisci nome macchina",
      renamedSuccess: "Macchina rinominata correttamente",
      renameFailed: "Impossibile rinominare la macchina",
      actions: {
        removeMachine: "Rimuovi macchina",
        removeMachineSubtitle:
          "Revoca questa macchina e la rimuove dal tuo account.",
        removeMachineConfirmBody:
          "Questo revocherà l’accesso da questa macchina (incluse chiavi di accesso e assegnazioni automazioni). Puoi riconnetterla più tardi accedendo di nuovo dalla CLI.",
        removeMachineAlreadyRemoved:
          "Questa macchina è già stata rimossa dal tuo account.",
      },
      lastKnownPid: "Ultimo PID noto",
      lastKnownHttpPort: "Ultima porta HTTP nota",
      startedAt: "Avviato alle",
      cliVersion: "Versione CLI",
    daemonStateVersion: "Versione stato daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Sessioni attive (${count})`,
    machineGroup: "Macchina",
    host: "Host (server)",
    machineId: "ID macchina",
    username: "Nome utente",
    homeDirectory: "Directory home",
    platform: "Piattaforma",
    architecture: "Architettura",
    lastSeen: "Ultimo accesso",
    never: "Mai",
    metadataVersion: "Versione metadati",
    detectedClis: "CLI rilevate",
    detectedCliNotDetected: "Non rilevata",
    detectedCliUnknown: "Sconosciuta",
    detectedCliNotSupported: "Non supportata (aggiorna @happier-dev/cli)",
    untitledSession: "Sessione senza titolo",
    back: "Indietro",
    notFound: "Macchina non trovata",
    unknownMachine: "macchina sconosciuta",
    unknownPath: "percorso sconosciuto",
    previousSessionsTitle: "Sessioni precedenti (fino alle 5 più recenti)",
    tmux: {
      overrideTitle: "Sovrascrivi le impostazioni tmux globali",
      overrideEnabledSubtitle:
        "Le impostazioni tmux personalizzate si applicano alle nuove sessioni su questa macchina.",
      overrideDisabledSubtitle:
        "Le nuove sessioni usano le impostazioni tmux globali.",
      notDetectedSubtitle: "tmux non è rilevato su questa macchina.",
      notDetectedMessage:
        "tmux non è rilevato su questa macchina. Installa tmux e aggiorna il rilevamento.",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "Mostra la console per sessioni remote",
      remoteSessionConsoleVisibleSubtitle:
        "Le sessioni remote si aprono in una finestra console visibile su questa macchina.",
      remoteSessionConsoleHiddenSubtitle:
        "Le sessioni remote si avviano nascoste per evitare finestre che si aprono/chiudono.",
      remoteSessionConsoleUpdateFailed:
        "Impossibile aggiornare l’impostazione della console per le sessioni Windows.",
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) =>
      `Passato alla modalità ${mode}`,
    discarded: "Scartato",
    unknownEvent: "Evento sconosciuto",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Limite di utilizzo raggiunto fino a ${time}`,
    unknownTime: "ora sconosciuta",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "I permessi vengono mostrati solo nel terminale. Reimposta o invia un messaggio per controllare dall’app.",
    sessionRunningLocally:
      "Questa sessione è in esecuzione localmente su questo computer. Puoi passare a remoto per controllarla dall’app.",
    switchToRemote: "Passa a remoto",
    localModeAvailable: "La modalità locale è disponibile per questa sessione.",
    localModeUnavailableMachineOffline:
      "La modalità locale non è disponibile mentre questa macchina è offline.",
    localModeUnavailableDaemonStarted:
      "La modalità locale non è disponibile per le sessioni avviate dal daemon.",
    localModeUnavailableNeedsResume:
      "La modalità locale richiede il supporto alla ripresa per questo provider.",
    switchToLocal: "Passa a locale",
  },

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "Sì, consenti sempre globalmente",
        yesForSession: "Sì, e non chiedere per una sessione",
        stop: "Ferma",
        stopAndExplain: "Fermati e spiega cosa devo fare",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits:
          "Sì, consenti tutte le modifiche durante questa sessione",
        yesForTool: "Sì, non chiedere più per questo strumento",
        yesForCommandPrefix:
          "Sì, non chiedere più per questo prefisso di comando",
        yesForSubcommand: "Sì, non chiedere più per questo sottocomando",
        yesForCommandName: "Sì, non chiedere più per questo comando",
        stop: "Ferma",
        noTellClaude: "No, fornisci feedback",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "Seleziona intervallo di testo",
    title: "Seleziona testo",
    noTextProvided: "Nessun testo fornito",
    textNotFound: "Testo non trovato o scaduto",
    textCopied: "Testo copiato negli appunti",
    failedToCopy: "Impossibile copiare il testo negli appunti",
    noTextToCopy: "Nessun testo disponibile da copiare",
    failedToOpen: "Impossibile aprire la selezione del testo. Riprova.",
  },

    markdown: {
      // Markdown copy functionality
      codeCopied: "Codice copiato",
      copyFailed: "Copia non riuscita",
      mermaidRenderFailed: "Impossibile renderizzare il diagramma mermaid",
      diffLabel: "Differenze",
      codeLabel: "Codice",
    },

  artifacts: {
    // Artifacts feature
    title: "Artefatti",
    countSingular: "1 artefatto",
    countPlural: ({ count }: { count: number }) => `${count} artefatti`,
    empty: "Nessun artefatto",
    emptyDescription: "Crea il tuo primo artefatto per iniziare",
    new: "Nuovo artefatto",
    edit: "Modifica artefatto",
    delete: "Elimina",
    updateError: "Impossibile aggiornare l'artefatto. Riprova.",
    deleteError: "Impossibile eliminare l’artefatto. Riprova.",
    notFound: "Artefatto non trovato",
    discardChanges: "Scartare le modifiche?",
    discardChangesDescription:
      "Hai modifiche non salvate. Sei sicuro di volerle scartare?",
    deleteConfirm: "Eliminare artefatto?",
    deleteConfirmDescription: "Questa azione non può essere annullata",
    noContent: "Nessun contenuto",
    untitled: "Senza titolo",
    titleLabel: "TITOLO",
    titlePlaceholder: "Inserisci un titolo per il tuo artefatto",
    bodyLabel: "CONTENUTO",
    bodyPlaceholder: "Scrivi il tuo contenuto qui...",
    emptyFieldsError: "Inserisci un titolo o un contenuto",
    createError: "Impossibile creare l'artefatto. Riprova.",
    save: "Salva",
    saving: "Salvataggio...",
    loading: "Caricamento artefatti...",
    error: "Impossibile caricare l'artefatto",
  },

  friends: {
    // Friends feature
    title: "Amici",
    sharedSessions: "Sessioni condivise",
    noSharedSessions: "Nessuna sessione condivisa",
    manageFriends: "Gestisci i tuoi amici e le connessioni",
    searchTitle: "Trova amici",
    pendingRequests: "Richieste di amicizia",
    myFriends: "I miei amici",
    noFriendsYet: "Non hai ancora amici",
    findFriends: "Trova amici",
    remove: "Rimuovi",
    pendingRequest: "In attesa",
    sentOn: ({ date }: { date: string }) => `Inviata il ${date}`,
    accept: "Accetta",
    reject: "Rifiuta",
    addFriend: "Aggiungi amico",
    alreadyFriends: "Già amici",
    requestPending: "Richiesta in sospeso",
    searchInstructions: "Inserisci un nome utente per cercare amici",
    searchPlaceholder: "Inserisci nome utente...",
    searching: "Ricerca...",
    userNotFound: "Utente non trovato",
    noUserFound: "Nessun utente trovato con quel nome",
    checkUsername: "Controlla il nome utente e riprova",
    howToFind: "Come trovare amici",
    findInstructions:
      "Cerca amici tramite il loro nome utente. A seconda del server, potresti dover collegare un provider o scegliere un nome utente per usare Amici.",
    requestSent: "Richiesta di amicizia inviata!",
    requestAccepted: "Richiesta di amicizia accettata!",
    requestRejected: "Richiesta di amicizia rifiutata",
    friendRemoved: "Amico rimosso",
    confirmRemove: "Rimuovi amico",
    confirmRemoveMessage: "Sei sicuro di voler rimuovere questo amico?",
    cannotAddYourself: "Non puoi inviare una richiesta di amicizia a te stesso",
    bothMustHaveGithub:
      "Entrambi gli utenti devono avere collegato il provider richiesto per diventare amici",
    status: {
      none: "Non connesso",
      requested: "Richiesta inviata",
      pending: "Richiesta in sospeso",
      friend: "Amici",
      rejected: "Rifiutata",
    },
    acceptRequest: "Accetta richiesta",
    removeFriend: "Rimuovi amico",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `Sei sicuro di voler rimuovere ${name} dagli amici?`,
    requestSentDescription: ({ name }: { name: string }) =>
      `La tua richiesta di amicizia è stata inviata a ${name}`,
    requestFriendship: "Richiedi amicizia",
    cancelRequest: "Annulla richiesta di amicizia",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `Annullare la tua richiesta di amicizia a ${name}?`,
    denyRequest: "Rifiuta richiesta",
    nowFriendsWith: ({ name }: { name: string }) => `Ora sei amico di ${name}`,
    disabled: "Amici è disattivato su questo server.",
    username: {
      required: "Scegli un nome utente per usare Amici.",
      taken: "Questo nome utente è già in uso.",
      invalid: "Questo nome utente non è consentito.",
      disabled: "Amici con nome utente non è abilitato su questo server.",
      preferredNotAvailable:
        "Il tuo nome utente preferito non è disponibile su questo server. Scegline un altro.",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `Il tuo nome utente preferito @${login} non è disponibile su questo server. Scegline un altro.`,
    },
    githubGate: {
      title: "Collega GitHub per usare Amici",
      body: "Amici usa gli username GitHub per trovare e condividere.",
      connect: "Collega GitHub",
      notAvailable: "Non disponibile?",
      notConfigured: "GitHub OAuth non è configurato su questo server.",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `Collega ${provider} per usare Amici`,
      body: ({ provider }: { provider: string }) =>
        `Amici usa gli username ${provider} per trovare e condividere.`,
      connect: ({ provider }: { provider: string }) => `Collega ${provider}`,
      notAvailable: "Non disponibile?",
      notConfigured: ({ provider }: { provider: string }) =>
        `OAuth ${provider} non è configurato su questo server.`,
    },
  },

  usage: {
    // Usage panel strings
    today: "Oggi",
    last7Days: "Ultimi 7 giorni",
    last30Days: "Ultimi 30 giorni",
    totalTokens: "Token totali",
    totalCost: "Costo totale",
    tokens: "Token",
    cost: "Costo",
    usageOverTime: "Utilizzo nel tempo",
    byModel: "Per modello",
    noData: "Nessun dato di utilizzo disponibile",
  },

  secrets: {
    addTitle: "Nuovo segreto",
    savedTitle: "Segreti salvati",
    badgeReady: "Segreto",
    badgeRequired: "Segreto richiesto",
    missingForProfile: ({ env }: { env: string | null }) =>
      `Segreto mancante (${env ?? "segreto"}). Configuralo sulla macchina oppure seleziona/inserisci un segreto.`,
    defaultForProfileTitle: "Segreto predefinito",
    defineDefaultForProfileTitle:
      "Definisci segreto predefinito per questo profilo",
    addSubtitle: "Aggiungi un segreto salvato",
    noneTitle: "Nessuna",
    noneSubtitle:
      "Usa l’ambiente della macchina o inserisci un segreto per questa sessione",
    emptyTitle: "Nessun segreto salvato",
    emptySubtitle:
      "Aggiungine uno per usare profili con segreto senza impostare variabili d’ambiente sulla macchina.",
    savedHiddenSubtitle: "Salvata (valore nascosto)",
    defaultLabel: "Predefinita",
    fields: {
      name: "Nome",
      value: "Valore",
    },
    placeholders: {
      nameExample: "es. Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "Il nome è obbligatorio.",
      valueRequired: "Il valore è obbligatorio.",
    },
    actions: {
      replace: "Sostituisci",
      replaceValue: "Sostituisci valore",
      setDefault: "Imposta come predefinita",
      unsetDefault: "Rimuovi predefinita",
    },
    prompts: {
      renameTitle: "Rinomina segreto",
      renameDescription: "Aggiorna il nome descrittivo di questo segreto.",
      replaceValueTitle: "Sostituisci valore del segreto",
      replaceValueDescription:
        "Incolla il nuovo valore del segreto. Questo valore non verrà mostrato di nuovo dopo il salvataggio.",
      deleteTitle: "Elimina segreto",
      deleteConfirm: ({ name }: { name: string }) =>
        `Eliminare “${name}”? Questa azione non può essere annullata.`,
    },
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} ti ha inviato una richiesta di amicizia`,
    friendRequestGeneric: "Nuova richiesta di amicizia",
    friendAccepted: ({ name }: { name: string }) => `Ora sei amico di ${name}`,
    friendAcceptedGeneric: "Richiesta di amicizia accettata",
  },
} as const;

export type TranslationsIt = typeof it;
