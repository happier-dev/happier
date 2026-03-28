import type { TranslationStructure } from "../_types";

const mcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle: 'Crea un server, importa il JSON dell’host o installa un preset consigliato.',
  mcpServersHeroSubtitle: ({ configuredCount }: { configuredCount: number }) => `${configuredCount} configurati in Happier`,
  mcpServersHeroSubtitleEmpty: 'Crea i server una volta, verifica dove si applicano e importa ciò che già usano altri strumenti.',
  mcpServersSegmentConfigured: 'Configurato',
  mcpServersSegmentConfiguredSubtitle: 'Il tuo catalogo Happier',
  mcpServersSegmentDetected: 'Rilevato',
  mcpServersSegmentDetectedSubtitle: 'Trovato nei file di configurazione del provider',
  mcpServersSegmentPreview: 'Anteprima',
  mcpServersSegmentPreviewSubtitle: 'Ciò che riceverà questa sessione',
  mcpServersAdvancedTitle: 'Avanzate',
  mcpServersAdvancedSubtitle: 'Modalità rigorosa e comportamento di validazione',
  mcpServersDetectedDirectoryTitle: 'Directory del progetto',
  mcpServersDetectedDirectorySubtitle: 'Percorso workspace facoltativo per configurazioni a livello di progetto',
  mcpServersDetectedDirectoryPlaceholder: '/percorso/del/progetto',
  mcpServersPreviewAgentTitle: 'Motore',
  mcpServersPreviewMachineTitle: 'Macchina',
  mcpServersPreviewDeliveryTitle: 'Consegna degli strumenti',
  mcpServersPreviewDirectoryTitle: 'Directory del workspace',
  mcpServersPreviewDirectorySubtitle: 'Scegli la cartella in cui prevedi di avviare la sessione',
  mcpServersPreviewDirectoryPlaceholder: '/percorso/del/workspace',
  mcpServersPreviewRefreshTitle: 'Aggiorna anteprima',
  mcpServersPreviewRefreshSubtitle: 'Risolvi i server MCP di Happier e quelli nativi del provider per questo contesto',
  mcpServersPreviewEmptyTitle: 'Nessuna anteprima ancora',
  mcpServersPreviewEmptySubtitle: 'Scegli un backend, una macchina e una directory, quindi aggiorna per ispezionare l’insieme MCP effettivo.',
  mcpServersPreviewDirectoryRequired: 'Scegli una directory per l’anteprima di questa sessione.',
  mcpServersBuiltInDescription: 'Sempre disponibile nelle sessioni Happier.',
  mcpServersSourceHappier: 'Happier',
  mcpServersSourceBuiltIn: 'Integrato',
  mcpServersSourceDetected: 'Rilevato',
  mcpServersQuickInstallTitle: 'Installazione rapida',
  mcpServersQuickInstallSubtitle: 'Installa i server MCP comuni per sviluppatori in un solo passaggio.',
  mcpServersQuickInstallAction: 'Installa',
  mcpServersQuickInstallEmptyTitle: 'Scegli un preset',
  mcpServersQuickInstallEmptySubtitle: 'Seleziona uno dei server MCP consigliati per continuare.',
  mcpServersEditAction: 'Modifica',
  mcpServersDeleteAction: 'Rimuovi',
  mcpServersAddServerFlowSubtitle: 'Configura un server manualmente, importa il JSON dell’host o parti da un preset curato.',
  mcpServersAddFlowConfigureTitle: 'Configura',
  mcpServersAddFlowConfigureSubtitle: 'Configurazione manuale',
  mcpServersAddFlowImportJsonTitle: 'Importa JSON',
  mcpServersAddFlowImportJsonSubtitle: 'Incolla la configurazione dell’host',
  mcpServersAddFlowQuickInstallTitle: 'Installazione rapida',
  mcpServersAddFlowQuickInstallSubtitle: 'Preset curati',
  mcpServersFieldCommandLine: 'Riga di comando',
  mcpServersFieldCommandLinePlaceholder: 'npx -y @modelcontextprotocol/server-playwright',
  mcpServersTransportLocalTitle: 'Comando locale',
  mcpServersTransportLocalSubtitle: 'Esegue sulla macchina selezionata',
  mcpServersTransportHttpTitle: 'HTTP remoto',
  mcpServersTransportHttpSubtitle: 'Bridge da un endpoint HTTP',
  mcpServersTransportSseTitle: 'SSE remoto',
  mcpServersTransportSseSubtitle: 'Bridge dagli eventi inviati dal server',
  mcpServersAdvancedCommandEditorTitle: 'Editor comandi avanzato',
  mcpServersAdvancedCommandEditorSubtitle: 'Separa manualmente comando e argomenti',
  mcpServersCancelSubtitle: 'Esci senza salvare questa bozza',
  mcpServersImportJsonTitle: 'Incolla JSON host MCP',
  mcpServersImportJsonSubtitle: 'Supportiamo i formati comuni usati in README e host desktop.',
  mcpServersImportJsonPlaceholder: '{"mcpServers":{"prova":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: 'Errore di importazione',
  mcpServersImportJsonWarningsTitle: 'Avvisi di importazione',
  mcpServersImportJsonEmptyTitle: 'Nessun server ancora analizzato',
  mcpServersImportJsonEmptySubtitle: 'Incolla il JSON MCP dell’host per visualizzare l’anteprima dei server prima dell’importazione.',
  mcpServersImportJsonAction: 'Importa server',
  mcpServersImportMappingSavedSecret: 'Usa segreto salvato',
  mcpServersImportMappingMachineEnv: 'Usa variabili d’ambiente della macchina',
  mcpServersImportSecretNamePlaceholder: 'Nome del segreto salvato',
  mcpServersImportSecretValuePlaceholder: 'Valore del segreto salvato',
  mcpServersImportMachineEnvPlaceholder: 'ENV_VAR_NAME',
  mcpServersImportMappingMissingSecretName: ({ input }: { input: string }) => `Inserisci un nome di segreto salvato per ${input}.`,
  mcpServersImportMappingMissingSecretValue: ({ input }: { input: string }) =>
    `Inserisci un valore di segreto salvato per ${input} o passa alle variabili d’ambiente della macchina.`,
  mcpServersImportMappingMissingMachineEnvName: ({ input }: { input: string }) => `Inserisci un nome di variabile d’ambiente della macchina per ${input}.`,
  mcpServersAuthSavedSecret: 'Segreto salvato',
  mcpServersAuthMachineEnv: 'Variabili d’ambiente della macchina',
  mcpServersAuthPlainText: 'Testo normale',
  mcpServersAuthUnknown: 'Autenticazione sconosciuta',
  mcpServersAuthNone: 'Nessuna autenticazione',
  mcpServersScopeAllMachines: 'Tutte le macchine',
  mcpServersScopeMachine: 'Macchina',
  mcpServersScopeWorkspace: 'Area di lavoro',
  mcpServersScopeProviderProject: 'Configurazione progetto provider',
  mcpServersScopeProviderUser: 'Configurazione utente provider',
  mcpServersScopeBuiltIn: 'Integrato',
  mcpServersStatusActive: 'Attivo',
  mcpServersStatusAvailable: 'Disponibile',
  mcpServersStatusUnavailable: 'Non disponibile',
  mcpServersStatusDetected: ({ provider }: { provider: string }) => `Abilitato in ${provider}`,
  mcpServersStatusDisabledInProvider: ({ provider }: { provider: string }) => `Disabilitato in ${provider}`,
  mcpServersEditorAppliesTo: 'Si applica a',
  mcpServersEditorAppliesToSubtitle: 'Scegli dove Happier deve aggiungere questo server per impostazione predefinita.',
  mcpServersAddApplyRule: 'Aggiungi regola di applicazione',
  mcpServersAddApplyRuleSubtitle: 'Scegli dove questo server deve applicarsi per impostazione predefinita.',
  mcpServersAddApplyRuleHelp: 'Salva questa regola di applicazione per farla diventare parte di questa configurazione server.',
  mcpServersAddApplyRuleSave: 'Salva regola di applicazione',
  mcpServersDeliveryNativeTitle: 'MCP nativo',
  mcpServersDeliveryNativeSubtitle: 'Questo backend riceve gli strumenti di Happier come server MCP nativi.',
  mcpServersDeliveryShellBridgeTitle: 'Bridge shell di Happier',
  mcpServersDeliveryShellBridgeSubtitle: 'Questo backend chiama gli strumenti di Happier tramite il bridge `happier tools`.',
  mcpServersDeliveryUnsupportedTitle: 'Non supportato',
  mcpServersDeliveryUnsupportedSubtitle: 'Questo backend al momento non riceve strumenti di Happier.',
} as const;

const newSessionMcpTranslationExtension = {
  mcpChipLabel: 'MCP',
  mcpChipLabelWithCount: ({ count }: { count: number }) => `MCP ${count}`,
  mcpModalTitle: 'Server MCP',
  mcpModalSubtitle: ({ machineName, directory }: { machineName: string; directory: string }) =>
    `Anteprima dei server MCP disponibili su ${machineName} per ${directory}.`,
  mcpManagedToggleTitle: 'Server MCP gestiti',
  mcpManagedToggleSubtitle: 'Includi i server MCP gestiti quando sono disponibili per questa sessione.',
  mcpOpenSettingsTitle: 'Apri impostazioni MCP',
  mcpOpenSettingsSubtitle: 'Gestisci server configurati, binding e opzioni di importazione.',
  mcpUnavailableNoContextTitle: 'Scegli prima una macchina e una directory',
  mcpUnavailableNoContextSubtitle: 'L’anteprima MCP richiede sia una macchina di destinazione sia una directory di lavoro.',
  mcpSelectedSectionTitle: 'Selezionati',
  mcpAvailableSectionTitle: 'Disponibili',
  mcpUnavailableSectionTitle: 'Non disponibili',
  mcpDetectedSectionTitle: 'Rilevati nelle configurazioni del provider',
  mcpDetectedSectionTitleForAgent: ({ agentName }: { agentName: string }) => `Rilevati nella configurazione di ${agentName}`,
  mcpDetectedEmptyTitle: 'Nessun server MCP rilevato',
  mcpDetectedEmptySubtitle: 'Aggiorna per scansionare i file di configurazione del provider su questa macchina.',
  mcpDetectedUnsupportedTitle: 'I server MCP rilevati non sono disponibili',
  mcpDetectedUnsupportedSubtitle: 'Aggiorna Happier su questa macchina per abilitare la scansione della configurazione del provider.',
  mcpHappierSectionTitle: 'Server MCP di Happier',
  mcpHappierEmptyTitle: 'Nessun server MCP definito in Happier',
  mcpHappierEmptySubtitle: 'Definisci i server MCP nelle impostazioni per usarli nelle sessioni.',
  mcpReasonActiveByDefault: 'Inclusi per impostazione predefinita',
  mcpReasonForcedIncluded: 'Richiesti dalla configurazione',
  mcpReasonForcedExcluded: 'Esclusi dalla configurazione',
  mcpReasonManagedDisabled: 'I server MCP gestiti sono disabilitati',
  mcpReasonBindingDisabled: 'Disabilitati dal binding del server',
  mcpReasonAvailablePortable: 'Compatibili con questa sessione',
  mcpReasonNotPortable: 'Non compatibili con questa sessione',
} as const;

const settingsAppearanceTranslationExtension = {
  sessionListDensity: {
    title: 'Densità elenco sessioni',
    subtitle: 'Scegli come visualizzare le sessioni nella barra laterale',
    detailed: 'Dettagliata',
    detailedDescription: 'Righe a dimensione completa con avatar e stato',
    cozy: 'Intermedia',
    cozyDescription: 'Righe più piccole con avatar',
    narrow: 'Stretta',
    narrowDescription: 'Righe minime senza avatar',
  },
} as const;

const acpCatalogTranslationExtension = {
  settings: {
    acpCatalog: 'Backend ACP',
    acpCatalogSubtitle: 'Gestisci i backend ACP integrati e personalizzati',
    acpCatalogBuiltIn: 'ACP integrato',
    acpCatalogBuiltInFooter:
      'Gli agenti ACP generici integrati sono definiti nel catalogo condiviso ed eseguiti tramite l’ambiente di esecuzione ACP condiviso.',
    acpCatalogBackends: 'Backend personalizzati',
    acpCatalogBackendsFooter:
      'Ogni backend personalizzato è una definizione CLI selezionabile compatibile con ACP, con il proprio avvio, i propri valori predefiniti e le impostazioni di autenticazione.',
    acpCatalogBackendsEmptyTitle: 'Nessun backend ACP personalizzato',
    acpCatalogBackendsEmptySubtitle: 'Aggiungi un backend per creare una scelta di backend ACP personalizzato selezionabile.',
    acpCatalogAddBackend: 'Aggiungi backend ACP',
    acpCatalogAddBackendSubtitle: 'Crea una scelta di backend ACP personalizzato',
    acpCatalogBackendEditorTitle: 'Backend ACP',
    acpCatalogBasics: 'Base',
    acpCatalogLauncher: 'Avvio',
    acpCatalogEnv: 'Ambiente',
    acpCatalogAddEnv: "Aggiungi variabile d'ambiente",
    acpCatalogAddEnvSubtitle: 'Memorizza valori letterali o associa Segreti salvati',
    acpCatalogEnvEmptyTitle: "Nessuna variabile d'ambiente",
    acpCatalogEnvEmptySubtitle: 'Aggiungi variabili di avvio per questo backend.',
    acpCatalogAuth: 'Autenticazione',
    acpCatalogAuthSupport: 'Supporto autenticazione',
    acpCatalogAuthParser: 'Parser dello stato',
    acpCatalogCapabilities: 'Funzionalità',
    acpCatalogTransportProfile: 'Profilo di trasporto',
    acpCatalogSupportsModes: 'Supporta modalità',
    acpCatalogSupportsModels: 'Supporta modelli',
    acpCatalogSupportsConfigOptions: 'Supporta opzioni di configurazione',
    acpCatalogPromptImageSupport: 'Supporto immagini nei prompt',
    acpCatalogFieldId: 'ID',
    acpCatalogFieldName: 'Nome',
    acpCatalogFieldTitle: 'Titolo',
    acpCatalogFieldDescription: 'Descrizione',
    acpCatalogFieldCommand: 'Comando',
    acpCatalogFieldArgs: 'Argomenti (uno per riga)',
    acpCatalogMachineLoginKey: 'Chiave di accesso macchina',
    acpCatalogDocsUrl: 'URL della documentazione',
    acpCatalogLoginCommand: 'Comando di accesso',
    acpCatalogLoginArgs: 'Argomenti di accesso (uno per riga)',
    acpCatalogStatusCommand: 'Token del comando di stato (uno per riga)',
    acpCatalogDefaultMode: 'Modalità predefinita',
    acpCatalogDefaultModel: 'Modello predefinito',
    acpCatalogDeleteBackendTitle: 'Eliminare il backend ACP?',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `Eliminare "${name}"?`,
    acpCatalogValidationFailed: 'Le impostazioni del catalogo ACP non sono valide.',
  },
  newSession: {},
} as const;

const memoryEmbeddingsTranslationExtension = {
  status: {
    embeddingsTitle: 'Runtime degli embeddings',
    embeddingsProviderTitle: 'Provider degli embeddings',
    embeddingsModelTitle: 'Modello degli embeddings',
    embeddingsDisabled: 'Gli embeddings sono disattivati',
    embeddingsReady: 'Gli embeddings sono pronti',
    embeddingsDownloading: 'Il modello di embedding viene scaricato',
    embeddingsFallback: 'Embeddings non disponibili, uso del fallback solo testo',
    embeddingsUnavailable: 'Embeddings non disponibili',
    embeddingsError: 'Impossibile inizializzare gli embeddings',
    embeddingsProviderLocal: 'Modello locale',
    embeddingsProviderOpenAiCompatible: 'Endpoint compatibile con OpenAI',
  },
  embeddings: {
    groupTitle: 'Vettori',
    groupFooter:
      'Opzionale: migliora il ranking della ricerca profonda con un modello locale o con il tuo endpoint compatibile con OpenAI.',
    mode: {
      title: 'Modalità embeddings',
      options: {
        disabledTitle: 'Disattivato',
        disabledSubtitle: 'Usa il ranking solo testuale per la ricerca profonda',
        balancedTitle: 'Bilanciato',
        balancedSubtitle: 'Preset locale rapido e validato',
        longContextTitle: 'Contesto lungo',
        longContextSubtitle: 'Meglio per blocchi di conversazione più grandi',
        qualityTitle: 'Qualità',
        qualitySubtitle: 'Preset locale più costoso per la valutazione',
        customTitle: 'Personalizzato',
        customSubtitle: 'Scegli il tuo provider e modello',
      },
    },
    provider: {
      title: 'Provider',
      options: {
        localTitle: 'Modello locale',
        localSubtitle: 'Gestito da Happier e scaricato al primo utilizzo',
        openAiCompatibleTitle: 'Endpoint compatibile con OpenAI',
        openAiCompatibleSubtitle: 'Usa il tuo server embeddings e la tua API key',
      },
    },
    notSet: 'Non impostato',
    secretSet: 'Impostato',
    secretNotSet: 'Non impostato',
    queryPrefixTitle: 'Prefisso query',
    queryPrefixPromptBody: 'Prefisso opzionale aggiunto alle query di ricerca dell’utente prima di generare embeddings.',
    documentPrefixTitle: 'Prefisso documento',
    documentPrefixPromptBody: 'Prefisso opzionale aggiunto ai chunk di memoria indicizzati prima di generare embeddings.',
    openAi: {
      baseUrlTitle: 'URL base',
      baseUrlPromptBody: 'Inserisci l’URL base del tuo endpoint embeddings compatibile con OpenAI.',
      modelTitle: 'Modello remoto',
      modelPromptBody: 'Inserisci l’id del modello embeddings da richiedere all’endpoint remoto.',
      apiKeyTitle: 'Chiave API',
      apiKeyPromptBody: 'Inserisci la API key usata per l’endpoint remoto di embeddings.',
      dimensionsTitle: 'Dimensioni',
      dimensionsPromptBody: 'Sovrascrittura opzionale della dimensione di output per gli endpoint che la supportano.',
    },
    advanced: {
      ftsWeightTitle: 'Peso del ranking testuale',
      ftsWeightPromptBody: 'Peso relativo del ranking full-text di SQLite quando si combinano i risultati.',
      embeddingWeightTitle: 'Peso del ranking embeddings',
      embeddingWeightPromptBody: 'Peso relativo della similarità embeddings quando si combinano i risultati.',
    },
  },
} as const;

const promptLibraryUxRefinementTranslationExtension = {
  it: {
    promptsSubtitle: 'Documenti prompt riutilizzabili',
    skillsSubtitle: 'Pacchetti abilità riutilizzabili',
    addPrompt: 'Aggiungi nuovo prompt',
    addPromptSubtitle: 'Crea un nuovo documento prompt',
    addSkill: 'Aggiungi nuova abilità',
    addSkillSubtitle: 'Crea un nuovo pacchetto abilità',
    newTemplateSubtitle: 'Crea un modello slash riutilizzabile',
    noPrompts: 'Nessun prompt ancora',
    noPromptsSubtitle: 'Crea un prompt per iniziare con modelli e aggiunte al prompt di sistema.',
    noSkills: 'Nessuna abilità ancora',
    noSkillsSubtitle: 'Crea un pacchetto abilità per riutilizzare istruzioni SKILL.md.',
    imported: 'Importato',
    builtIn: 'Integrato',
    general: 'Generale',
    promptNameLabel: 'Nome del prompt',
    promptContent: 'Contenuto del prompt',
    skillNameLabel: 'Nome dell’abilità',
    skillContent: 'Contenuto di SKILL.md',
    supportingFiles: 'File di supporto',
    supportingFilesEmptyTitle: 'Nessun file di supporto ancora',
    supportingFilesEmptySubtitle: 'Aggiungi file riutilizzabili da esportare insieme a questa abilità.',
    supportingFilesSaveFirstTitle: 'Salva prima questa abilità',
    supportingFilesSaveFirstSubtitle: 'Crea l’abilità prima di aggiungere file di supporto.',
    addSupportingFile: 'Aggiungi file di supporto',
    addSupportingFileSubtitle: 'Crea un altro file in questo pacchetto abilità',
    editSupportingFile: 'Modifica file di supporto',
    newSupportingFile: 'Nuovo file di supporto',
    supportingFilePathLabel: 'Percorso del file',
    supportingFilePathPlaceholder: 'templates/review.md',
    supportingFileContent: 'Contenuto del file',
    supportingFileTextSubtitle: 'File di testo',
    supportingFileBinarySubtitle: 'File binario · solo esportazione',
    deleteSupportingFileTitle: 'Eliminare file di supporto?',
    deleteSupportingFileConfirm: 'Questo rimuove il file dal pacchetto abilità.',
    linkedAssetsCount: ({ count }: { count: number }) => `${count} esportazione${count === 1 ? '' : 'i'}`,
    manageExternalAssets: 'Gestisci risorse esterne',
    deleteLibraryItemTitle: 'Eliminare elemento della libreria?',
    deleteLibraryItemBody:
      'Rimuove l’elemento dalla libreria e scollega modelli o aggiunte al prompt di sistema che lo usano.',
    folders: 'Cartelle',
    foldersSubtitle: 'Organizza prompt e abilità in cartelle con nome',
    addFolder: 'Aggiungi cartella',
    addFolderSubtitle: 'Crea una cartella riutilizzabile per gli elementi della libreria',
    foldersEmptyTitle: 'Nessuna cartella ancora',
    foldersEmptySubtitle: 'Crea una cartella per organizzare prompt e abilità.',
    renameFolder: 'Rinomina cartella',
    deleteFolderTitle: 'Eliminare cartella?',
    deleteFolderBody: 'Questo rimuove l’assegnazione della cartella dai prompt e dalle abilità che la usano.',
    folderUsageCount: ({ count }: { count: number }) => `${count} elemento${count === 1 ? '' : 'i'}`,
    folderLabel: 'Cartella',
    folderPlaceholder: 'Nome cartella',
    tagsLabel: 'Tag',
    tagsPlaceholder: 'tag-uno, tag-due',
    addToStackSubtitle: 'Scegli un prompt o un’abilità da aggiungere qui',
    externalAssetsImportAction: 'Importa',
    externalAssetsLinkedTo: ({ title }: { title: string }) => `Collegato a ${title}`,
    externalAssetsExportTarget: 'Destinazione',
    externalAssetsInstallMethod: 'Metodo di installazione',
    externalAssetsInstallMethodCopy: 'Copia file',
    externalAssetsInstallMethodCopySubtitle: 'Scrive una copia autonoma nella destinazione selezionata',
    externalAssetsInstallMethodSymlink: 'Link simbolico (consigliato)',
    externalAssetsInstallMethodSymlinkSubtitle: 'Collega la destinazione a una copia gestita da Happier per aggiornamenti più semplici',
    registriesAddGitSourceSubtitle: 'Aggiungi un repository Git o una copia locale come sorgente registro',
    registriesSourceTitleLabel: 'Titolo sorgente',
    registriesSourceUrlLabel: 'URL repository o percorso locale',
    registriesSearchLabel: 'Cerca nel registro',
    registriesSearchPlaceholder: 'Cerca abilità (ad esempio: design)',
    registriesItemSource: 'Repository sorgente',
    registriesItemPath: 'Percorso registro',
    registriesItemFiles: 'File di supporto',
    registriesItemPreview: 'Anteprima SKILL.md',
    registriesItemPreviewUnavailable: 'Nessuna anteprima SKILL.md disponibile per questo elemento del registro.',
    registriesItemImportSubtitle: 'Importa questo pacchetto abilità nella libreria Happier',
    registriesItemInstallAction: 'Installa sulla macchina',
    registriesItemInstallConfirmTitle: 'Installare l’elemento del registro?',
    registriesItemInstallConfirmBody: 'Questo importa l’abilità nella tua libreria e la installa nella destinazione macchina selezionata.',
    templateTargetPromptLabel: 'Prompt di destinazione',
    templateTargetPromptPlaceholder: 'Seleziona un prompt',
    editSelectedPrompt: 'Modifica il prompt selezionato',
    editSelectedPromptDisabled: 'Seleziona prima un prompt',
    templateNameLabel: 'Nome del modello',
    templateTokenLabel: 'Comando slash',
    templatesEmptyTitle: 'Nessun modello ancora',
    templatesEmptySubtitle: 'Crea un modello slash per inserire rapidamente prompt.',
    librarySearchPlaceholder: 'Cerca nella libreria',
  },
} as const;

const sessionHandoffTranslationExtensions = {
  it: {
    activeWarning: {
      title: 'Questa sessione è ancora in esecuzione qui',
      message: 'Il trasferimento fermerà questa sessione su questa macchina prima di trasferirla alla macchina selezionata.',
      confirm: 'Trasferisci e ferma qui',
    },
    progress: {
      title: 'Trasferimento della sessione',
      message: 'Preparazione della macchina di destinazione e spostamento dello stato della sessione.',
      planned: 'Pianificato',
      transferred: 'Trasferito',
      remaining: 'Rimanente',
      timeline: {
        scanSource: 'Scansione sorgente',
        plan: 'Pianificazione modifiche',
        transferBlobs: 'Trasferimento file',
        stageTarget: 'Preparazione destinazione',
        apply: 'Applicazione modifiche',
        importSession: 'Importazione sessione',
        finalize: 'Finalizzazione',
      },
    },
    failure: {
      title: 'Trasferimento della sessione non riuscito',
      message: 'Non e stato possibile completare il trasferimento. Puoi riprovare.',
    },
    recovery: {
      title: 'La sessione è stata fermata qui prima di completare il trasferimento',
      messageAfterSourceStop:
        'Happier ha già fermato questa sessione su questa macchina, ma non è riuscito a completarne l’avvio sulla macchina di destinazione. Riavviala qui oppure lasciala ferma mentre ripristini la macchina di destinazione.',
      restartOnSource: 'Riavvia sull origine',
      keepStopped: 'Lasciala arrestata',
    },
  },
} as const;

const settingsSessionHandoffTranslationExtensions = {
  it: {
    title: 'Trasferimento della sessione',
    groupTitle: 'Trasferimento della sessione',
    groupFooter: 'Scegli le opzioni predefinite per spostare una sessione tra macchine.',
    entrySubtitle: 'Apri i valori predefiniti del trasferimento',
    workspaceTransfer: {
      groupTitle: 'Trasferimento dell area di lavoro',
      groupFooter: 'Decidi se il trasferimento deve copiare l area di lavoro e come gestire i conflitti per impostazione predefinita.',
      title: 'Trasferisci area di lavoro',
      enabledSubtitle: 'Copia l area di lavoro sulla macchina di destinazione per impostazione predefinita.',
      disabledSubtitle: 'Lascia invariata l area di lavoro di destinazione per impostazione predefinita.',
      strategy: {
        title: 'Strategia di trasferimento dell area di lavoro',
        subtitle: 'Scegli tra uno snapshot completo o la sincronizzazione delle sole modifiche.',
        transferSnapshotTitle: 'Trasferisci snapshot',
        transferSnapshotSubtitle: 'Esporta e trasferisci uno snapshot completo dell area di lavoro.',
        syncChangesTitle: 'Sincronizza modifiche',
        syncChangesSubtitle: 'Confronta origine e destinazione e applica solo le modifiche unidirezionali necessarie.',
      },
    },
    conflictPolicy: {
      title: 'Criterio dei conflitti dell area di lavoro',
      subtitle: 'Scegli cosa succede quando il percorso di destinazione esiste gia.',
      createSiblingCopyTitle: 'Crea copia adiacente',
      createSiblingCopySubtitle: 'Mantieni il percorso di destinazione esistente e crea una copia adiacente per il trasferimento.',
      replaceExistingTitle: 'Sostituisci percorso esistente',
      replaceExistingSubtitle: 'Sostituisci il percorso di destinazione esistente dopo la conferma.',
    },
    includeIgnoredMode: {
      title: 'File ignorati',
      subtitle: 'Scegli come trattare i file ignorati da git durante il trasferimento dell area di lavoro.',
      excludeTitle: 'Escludi file ignorati',
      excludeSubtitle: 'Salta i file ignorati per impostazione predefinita.',
      includeSelectedTitle: 'Includi file ignorati selezionati',
      includeSelectedSubtitle: 'Copia solo i percorsi ignorati che corrispondono ai glob configurati.',
      globsTitle: 'Glob di inclusione ignorati',
      globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
      title: 'Modalita di destinazione per sessione diretta',
      subtitle: 'Scegli cosa deve succedere quando trasferisci una sessione diretta.',
      groupTitle: 'Trasferimento della sessione diretta',
      groupFooter: 'Si applica solo quando la sessione di origine e attualmente diretta.',
      keepDirectTitle: 'Mantieni diretta',
      keepDirectSubtitle: 'Riprendi la destinazione come sessione diretta quando il provider lo supporta.',
      convertToPersistedTitle: 'Converti in sincronizzata',
      convertToPersistedSubtitle: 'Importa la trascrizione e continua come sessione sincronizzata di Happier.',
    },
  },
} as const;

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
    inbox: "Posta",
    friends: "Amici",
    sessions: "Sessioni",
    settings: "Impostazioni",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Sei aggiornato",
    emptyDescription: "Nessuna richiesta o aggiornamento in sospeso al momento.",
    approvals: "Approvazioni",
    permissions: "Permessi",
    updates: "Attività",
  },

  approvals: {
    title: "Approvazione",
    untitled: "Approvazione senza titolo",
    details: "Dettagli",
    fieldStatus: "Stato",
    fieldAction: "Azione",
    approve: "Approva",
    reject: "Rifiuta",
    loadError: "Impossibile caricare l'approvazione.",
    decisionError: "Impossibile aggiornare l'approvazione.",
    confirmApproveTitle: "Approvare la richiesta?",
    confirmApproveBody: "Questo eseguirà l'azione richiesta.",
    confirmRejectTitle: "Rifiutare la richiesta?",
    confirmRejectBody: "Questo rifiuterà la richiesta.",
    status: {
      open: "In attesa",
      approved: "Approvata",
      rejected: "Rifiutata",
      executed: "Eseguita",
      failed: "Fallita",
      canceled: "Annullata",
    },
  },

  promptLibrary: {
    sections: "Sezioni",
    library: "Libreria",
    librarySubtitle: "Gestisci prompt e abilità",
    create: "Crea",
	    newPrompt: "Nuovo prompt",
	    templates: "Modelli",
	    templatesSubtitle: "Crea e gestisci modelli /slash",
	    newTemplate: "Nuovo modello",
	    newSkill: "Nuova abilità",
    prompts: "Prompt",
    skills: "Abilità",
    untitledPrompt: "Prompt senza titolo",
    untitledSkill: "Abilità senza titolo",
    origin: "Origine",
    schema: "Struttura",
    editPrompt: "Modifica prompt",
    editSkill: "Modifica abilità",
    titlePlaceholder: "Titolo",
	    saveError: "Impossibile salvare.",
	    stacks: "Stack",
	    stacksSubtitle: "Allega prompt e abilità a sessioni e profili",
        externalAssets: "Risorse esterne",
        externalAssetsSubtitle: "Importa skill e risorse di prompt dalle macchine connesse",
        externalAssetsContext: "Contesto di rilevamento",
        externalAssetsMachine: "Macchina",
        externalAssetsScope: "Ambito",
        externalAssetsProjectScope: "Progetto",
        externalAssetsProjectScopeSubtitle: "Rileva risorse all'interno del percorso di uno spazio di lavoro",
        externalAssetsUserScope: "Utente",
        externalAssetsUserScopeSubtitle: "Rileva risorse nelle cartelle a livello utente",
        externalAssetsProjectDirectory: "Directory del progetto",
        externalAssetsProjectDirectoryRequired: "Seleziona una directory del progetto prima di importare o esportare risorse con ambito progetto.",
        externalAssetsRefresh: "Aggiorna risorse esterne",
        externalAssetsRefreshSubtitle: "Rileva risorse di prompt per la macchina e l'ambito selezionati",
        externalAssetsTypes: "Tipi di risorse",
        externalAssetsNoMachine: "Seleziona una macchina per continuare.",
        externalAssetsNoTypes: "Nessun tipo di risorsa esterna",
        externalAssetsNoTypesSubtitle: "Questa macchina non espone ancora adattatori per risorse di prompt.",
        externalAssetsNoItems: "Nessuna risorsa esterna trovata",
        externalAssetsNoItemsSubtitle: "Aggiorna dopo aver scelto macchina, ambito o directory.",
        externalAssetsUnsupportedImport: "Qui è possibile importare solo risorse di prompt basate su bundle.",
        externalAssetsExportTitle: "Esporta risorsa esterna",
        externalAssetsExportOptions: "Opzioni di esportazione",
        externalAssetsExportType: "Tipo di risorsa",
        externalAssetsExportAction: "Esporta",
        externalAssetsExportConfirmTitle: "Esportare la risorsa esterna?",
        externalAssetsExportConfirmBody: "Questa operazione scriverà la risorsa prompt selezionata nella posizione esterna.",
        externalAssetsExportTargetPathPlaceholder: "Percorso di destinazione (ad es. review/code.md)",
        externalAssetsExportTargetNamePlaceholder: "Nome di destinazione (ad es. reviewer)",
        externalAssetsDeleteConfirmTitle: "Eliminare la risorsa esterna?",
        externalAssetsDeleteConfirmBody: "Questa operazione eliminerà dal disco la risorsa esterna collegata.",
        externalAssetsLinkedTitle: "Risorsa esterna collegata",
        registries: "Registri",
        registriesSubtitle: "Sfoglia i registri delle skill e importa bundle nella libreria",
        registriesContext: "Contesto del registro",
        registriesNoMachine: "Seleziona una macchina per continuare.",
        registriesRefresh: "Aggiorna registri",
        registriesRefreshSubtitle: "Carica le fonti di registro integrate e configurate per la macchina selezionata",
        registriesAddGitSource: "Aggiungi sorgente Git",
        registriesAddGitSourceAction: "Salva sorgente Git",
        registriesAddGitSourceActionSubtitle: "Salva questo repository come sorgente del registro",
        registriesAddGitSourceError: "Aggiungi sia un titolo sia un URL del repository.",
        registriesSourceTitlePlaceholder: "Titolo della sorgente",
        registriesSourceUrlPlaceholder: "URL del repository o percorso locale",
        registriesSources: "Sorgenti",
        registriesNoSources: "Nessuna sorgente del registro caricata",
        registriesNoSourcesSubtitle: "Aggiungi una sorgente Git o aggiorna per caricare le sorgenti integrate.",
        registriesItems: "Elementi del registro",
        registriesNoItems: "Nessun elemento del registro",
        registriesNoItemsSubtitle: "Seleziona una sorgente per analizzare le skill disponibili.",
	    editTemplate: "Modifica modello",
    tokenPlaceholder: "Token (es. /daily)",
    codingStack: "Stack di coding",
    codingStackSubtitle: "Applicato alle sessioni di coding",
    voiceStack: "Stack voce",
    voiceStackSubtitle: "Applicato a Happier Voice",
    profileStacks: "Stack profilo",
    profileStacksSubtitle: ({ count }: { count: number }) => (count === 1 ? "1 profilo" : `${count} profili`),
    profileStackCount: ({ count }: { count: number }) => (count === 1 ? "1 elemento" : `${count} elementi`),
    noProfilesTitle: "Nessun profilo",
    noProfilesSubtitle: "Crea un profilo per usare gli stack del profilo.",
    stackEntries: "Voci dello stack",
    stackPlacementSkill: "Istruzioni abilità",
    stackPlacementComposer: "Inserimento nel composer",
    stackPlacementSystem: "Aggiunta al sistema",
    stackEmptyTitle: "Niente in questo stack",
    stackEmptySubtitle: "Aggiungi prompt o abilità per iniziare.",
    actions: "Azioni",
    addToStack: "Aggiungi allo stack",
    stackAlreadyContainsPrompt: "Questo stack contiene già quell'elemento.",
    stackPickerNoPrompts: "Nessun prompt ancora.",
    stackPickerNoSkills: "Nessuna abilità ancora.",
    removeFromStack: "Rimuovere dallo stack?",
    removeFromStackConfirm: "Questo rimuoverà l'elemento dallo stack.",
    deleteTemplate: "Eliminare modello?",
    deleteTemplateConfirm: "Questo eliminerà il modello.",
    templateTokenReserved: "Quel token è riservato.",
    templateTokenConflictsWithAction: "Quel token entra in conflitto con un'azione integrata.",
    templateTokenDuplicate: "Quel token è già in uso.",
    templateTarget: "Prompt di destinazione",
    templateBehavior: "Comportamento",
    templateBehaviorInsert: "Inserisci",
    templateBehaviorInsertAndSend: "Inserisci e invia",
    templateAllowArgs: "Consenti argomenti",
    templateAllowArgsSubtitle: "Se attivo, il testo dopo il token viene passato come $args.",
        ...promptLibraryUxRefinementTranslationExtension.it,
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
    delivery: {
      title: "Consegna",
      cardDelivery: ({ label }: { label: string }) => `Consegna: ${label}`,
      steerLabel: "Guida",
      steerHelp:
        "Invia un messaggio di guida mentre l'esecuzione è occupata (se supportato).",
      interruptLabel: "Interrompi",
      interruptHelp:
        "Annulla il turno corrente, poi invia il messaggio come un nuovo turno.",
      promptLabel: "Richiesta",
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
        name: "Riepilogo giornaliero",
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
    restartAndReportIssue: "Riavvia e apri segnalazione",
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
    duplicate: "Duplica",
    actions: "Azioni",
    moreActions: "Altre azioni",
    moreActionsHint: "Apre un menu con altre azioni",
    cancel: "Annulla",
    close: "Chiudi",
      open: "Apri",
      done: "Fatto",
      reorder: "Riordina",
      moveUp: "Sposta su",
      moveDown: "Sposta giù",
      authenticate: "Autentica",
      save: "Salva",
		    error: "Errore",
		    success: "Successo",
		    info: "Informazioni",
		    comingSoon: "Prossimamente",
		    ok: "OK",
		    continue: "Continua",
		    back: "Indietro",
        previous: "Precedente",
        next: "Successivo",
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
    paste: "Incolla",
    expand: "Espandi",
    collapse: "Comprimi",
    command: "Comando",
    scanning: "Scansione...",
    urlPlaceholder: "https://esempio.com",
    home: "Inizio",
    message: "Messaggio",
    send: "Invia",
    attach: "Allega",
    addImage: "Aggiungi immagine",
    addFile: "Aggiungi file",
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
    defaultStorage: {
      title: "Archiviazione predefinita della sessione",
      footer:
        "Sovrascrive la modalità predefinita sincronizzata/diretta a livello account per le nuove sessioni quando questo profilo è selezionato.",
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
      kiroSubtitleExperimental: "Kiro CLI (sperimentale)",
      customAcpSubtitleExperimental: "CLI ACP personalizzata (sperimentale)",
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
    serverUrlNotEmbeddedTitle: "Configura il server sul tuo telefono",
    serverUrlNotEmbeddedBody:
      "Questo codice QR non può includere l’indirizzo del server perché è impostato su localhost. Sul telefono, vai su Impostazioni → Server e aggiungi un URL raggiungibile dal telefono (IP LAN o Tailscale), poi scansiona di nuovo.",
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
      emptyResults: "Nessun risultato memoria per ora",
      },
        status: {
            title: "Stato indice locale",
            diskUsageTitle: "Uso del disco",
            disabled: "La ricerca memoria locale è disabilitata su questa macchina",
            readyLight: "Indice leggero pronto su questa macchina",
            readyDeep: "Indice profondo pronto su questa macchina",
            unavailableLight: "L’indice leggero non è ancora pronto su questa macchina",
            unavailableDeep: "L’indice profondo non è ancora pronto su questa macchina",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Leggero ${lightMb} MB · Profondo ${deepMb} MB`,
            diskUsageUnavailable: "Uso del disco non disponibile",
            ...memoryEmbeddingsTranslationExtension.status,
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
      modelTitle: "Modello embeddings",
      promptBody: "Inserisci un id di modello transformers locale.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
      groupTitle: "Vettori semantici",
      provider: {
        ...memoryEmbeddingsTranslationExtension.embeddings.provider,
        title: "Fornitore",
      },
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
          groupTitle: "Subagenti",
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
          overview: {
            groupTitle: "Panoramica",
            footer:
              "Usa questa pagina per configurare la guida dei subagenti e aprire le impostazioni correlate di provider, backend e sessione.",
            explainerTitle: "Cosa controlla questa pagina",
            explainerSubtitle:
              "Guida alla delega per i subagenti, più collegamenti alle impostazioni dei subagenti specifiche del provider.",
            happierStatusTitle: "Subagenti",
            happierStatusEnabledSubtitle:
              "Abilitato. Puoi avviare subagenti dalle sessioni supportate.",
            happierStatusDisabledSubtitle:
              "Disabilitato. Apri Impostazioni → Funzionalità per abilitare i subagenti.",
          },
          related: {
            groupTitle: "Impostazioni correlate",
            footer:
              "L’avvio e il controllo dei subagenti dipendono anche dal comportamento della sessione, dai provider e dai backend configurati.",
            sessionTitle: "Comportamento sessione",
            sessionSubtitle:
              "Invio messaggi, gestione quando l’agente è occupato e comportamento di replay/ripresa.",
            providersTitle: "Provider",
            providersSubtitle:
              "Autenticazione, runtime e impostazioni agente specifici del provider.",
            backendsTitle: "Catalogo ACP",
            backendsSubtitle: "Backend configurati e obiettivi di avvio personalizzati.",
          },
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
          providers: {
            claude: {
              title: "Agenti del team Claude",
              footer:
                "Il comportamento dei subagenti specifico del provider resta gestito dalla schermata impostazioni del provider.",
              openTitle: "Opzioni subagenti Claude",
              openSubtitle:
                "Gestisci Agent Teams e altri comportamenti dei subagenti specifici di Claude.",
            },
          },
        },
      },

    settings: {
      title: "Impostazioni",

      // Main settings hub category groups
      profileAndAccount: 'Profilo e account',
      aiAndAgents: 'IA e agenti',
      sessionsBehavior: 'Sessioni e comportamento',
      general: 'Generale',
      filesAndSourceControl: 'File e controllo sorgente',
      system: 'Sistema',

      // Renamed / promoted items
      sessions: 'Sessioni',
      transcript: 'Trascrizione',
      transcriptSubtitle: 'Ragionamento, rendering degli strumenti e visualizzazione del codice',
      permissions: 'Permessi',
      permissionsSubtitle: 'Modalità permessi e comportamento delle approvazioni',
      filesSourceControl: 'File e controllo sorgente',
      filesSourceControlSubtitle: 'Editor, diff e integrazione con il controllo sorgente',
      workspaces: 'Workspace',
      workspacesSubtitle: 'Gestisci workspace collegati, posizioni e checkout',

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
    addMachine: "Aggiungi una macchina",
    machineSetupCurrentMachineTitle: "Questo computer",
    machineSetupCurrentMachineSubtitle: "Configura Happier direttamente su questo dispositivo",
    machineSetupSshMachineTitle: "Macchina remota via SSH",
    machineSetupSshMachineSubtitle: "Collega un dev box, una VM o un server tramite SSH",
    machineSetupStagesTitle: "Cosa succede",
    machineSetupStageConnect: "Connetti e verifica l’accesso",
    machineSetupStageInstall: "Installa Happier e associa la macchina",
    machineSetupStageFinish: "Completa la configurazione nel terminale integrato",
    machineSetupComingSoon: "L’avvio della macchina arriverà presto.",
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
      channelBridges: "Ponti di canale",
      channelBridgesSubtitle: "Collega chat esterne (Telegram) alle sessioni",
      featuresTitle: "Funzionalità",
      featuresSubtitle: "Abilita o disabilita le funzionalità dell'app",
    developer: "Sviluppatore",
    developerTools: "Strumenti sviluppatore",
    about: "Informazioni",
    actionsSettingsAboutSubtitle:
      "Abilita o disabilita le azioni globalmente, per superficie (UI/voce/MCP) e per posizionamento (dove compaiono nell’interfaccia). Le azioni disabilitate vengono bloccate in modo sicuro a runtime.",
    aboutFooter:
      "Happier Coder è un client mobile per Codex e Claude Code. Usa la crittografia end-to-end per impostazione predefinita, con ripristino dell'account sugli altri tuoi dispositivi. Non affiliato con Anthropic.",
    whatsNew: "Novità",
    whatsNewSubtitle: "Scopri gli ultimi aggiornamenti e miglioramenti",
    reportIssue: "Segnala un problema",
    privacyPolicy: "Informativa sulla privacy",
    termsOfService: "Termini di servizio",
    rateUs: "Valuta Happier",
    rateUsSubtitle: "Se l'app ti piace, una valutazione rapida ci aiuta molto",
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
        actionsSubtitle: "Scegli dove compare ogni azione nell’app, nella voce e nelle integrazioni.",
    prompts: "Prompt e skill",
    promptsSubtitle: "Libreria prompt, template e stack",
    servers: "Server",
	    serversSubtitle: "Server salvati, gruppi e impostazioni predefinite",
		    systemStatus: "Stato del sistema",
		    systemStatusSubtitle: "Server, account, macchine, daemon",
		    mcpServers: "Server MCP",
		    mcpServersSubtitle: "Gestisci server MCP e associazioni",
		    mcpServersComingSoon: "Le impostazioni dei server MCP arriveranno presto.",
		    mcpServersStrictMode: "Modalità rigorosa",
		    mcpServersStrictModeSubtitle: "Blocca tutto quando le impostazioni del server MCP non sono valide.",
		    mcpServersCatalogTitle: "Catalogo",
		    mcpServersUnnamed: "Server senza nome",
		    mcpServersEmptyTitle: "Nessun server MCP",
		    mcpServersEmptySubtitle: "Aggiungi server MCP per usarli nelle sessioni.",
		    mcpServersAddServer: "Aggiungi server",
		    mcpServersAddServerSubtitle: "Crea una nuova voce server MCP",
		    mcpServersEditorTitle: "Server MCP",
		    mcpServersPickSecretTitle: "Scegli un segreto",
		    mcpServersPickSecretNoneSubtitle: "Nessun segreto selezionato",
		    mcpServersEditorBasics: "Base",
		    mcpServersEditorStdio: "Input/output standard",
		    mcpServersEditorRemote: "Remoto",
		    mcpServersEditorBindings: "Associazioni",
		    mcpServersFieldName: "Nome",
		    mcpServersFieldTitle: "Titolo",
		    mcpServersFieldTitlePlaceholder: "Titolo facoltativo da visualizzare",
		    mcpServersFieldTransport: "Trasporto",
		    mcpServersFieldCommand: "Comando",
		    mcpServersFieldArgs: "Argomenti",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "Associazione",
		    mcpServersBindingEnabled: "Abilitata",
		    mcpServersBindingEnabledSubtitle: "Attiva o disattiva questa associazione",
		    mcpServersBindingTarget: "Destinazione",
		    mcpServersBindingTargetSubtitle: "Dove questo server è disponibile",
		    mcpServersBindingMachine: "Macchina",
		    mcpServersBindingMachineSubtitle: "Seleziona una macchina",
		    mcpServersBindingDeleteSubtitle: "Rimuovi questa associazione",
		    mcpServersBindingTargetAllMachines: "Tutte le macchine",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `Macchina: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `Workspace collegato: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "Abilita su ogni macchina",
		    mcpServersBindingTargetMachineTitle: "Macchina",
		    mcpServersBindingTargetMachineSubtitle: "Abilita su una sola macchina",
		    mcpServersBindingTargetWorkspaceTitle: "Area di lavoro",
		    mcpServersBindingTargetWorkspaceSubtitle: "Abilita solo per uno specifico percorso workspace",
		    mcpServersValidationFailed: "Le impostazioni del server MCP non sono valide.",
		    mcpServersServerNotFound: "Server non trovato.",
		    mcpServersBindingsEmptyTitle: "Nessuna associazione",
		    mcpServersBindingsEmptySubtitle: "Aggiungi un’associazione per usare questo server.",
		    mcpServersAddBinding: "Aggiungi associazione",
		    mcpServersAddBindingSubtitle: "Abilita questo server per macchine o workspace",
		    mcpServersSaveDisabledSubtitle: "Nessuna modifica da salvare.",
			    mcpServersDeleteTitle: "Eliminare il server MCP?",
			    mcpServersDeleteConfirm: ({ name }: { name: string }) => `Eliminare "${name}"?`,
			    mcpServersDeleteSubtitle: "Rimuovi questo server dal catalogo",
			    mcpServersNoMachineSelected: "Nessuna macchina selezionata",
			    mcpServersDetectedTitle: "Rilevati dalle configurazioni dei provider",
			    mcpServersDetectedMachineTitle: "Macchina",
			    mcpServersDetectedRefreshTitle: "Aggiorna server rilevati",
			    mcpServersDetectedRefreshSubtitle: "Analizza i file di configurazione dei provider su questa macchina",
			    mcpServersDetectedWarningsTitle: "Avvisi di rilevamento",
			    mcpServersDetectedEmptyTitle: "Nessun server MCP rilevato",
			    mcpServersDetectedEmptySubtitle: "Tocca aggiorna per analizzare le configurazioni di Claude/Codex/OpenCode.",
			    mcpServersImportTitle: "Importare il server MCP?",
			    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) =>
			      `Importare "${name}" da ${provider}?`,
			    mcpServersImportAction: "Importa",
			    mcpServersBindingSummaryAllMachines: "Tutte le macchine",
			    mcpServersBindingSummaryMachines: ({ count }: { count: number }) =>
			      `${count} ${plural({ count, singular: "macchina", plural: "macchine" })}`,
			    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) =>
			      `${count} ${plural({ count, singular: "workspace", plural: "workspace" })}`,
			    mcpServersBindingSummaryNone: "Non associato",
			    mcpServersPickWorkspaceTitle: "Scegli la radice del workspace",
			    mcpServersBindingWorkspaceRootTitle: "Radice del workspace",
			    mcpServersBindingOverridesTitle: "Sovrascritture",
			    mcpServersBindingOverridesNone: "Nessuna sovrascrittura",
			    mcpServersBindingOverridesCount: ({ count }: { count: number }) =>
			      `${count} ${plural({ count, singular: "sovrascrittura", plural: "sovrascritture" })}`,
			    mcpServersEditorEnv: "Ambiente",
			    mcpServersEnvAdd: "Aggiungi variabile d’ambiente",
			    mcpServersEnvAddSubtitle: "Imposta le variabili d’ambiente per questo server",
			    mcpServersEnvEmptyTitle: "Nessuna variabile d’ambiente",
			    mcpServersEnvEmptySubtitle: "Aggiungi variabili d’ambiente o usa i segreti salvati.",
			    mcpServersEditorHeaders: "Header",
			    mcpServersHeadersAdd: "Aggiungi header",
			    mcpServersHeadersAddSubtitle: "Imposta gli header HTTP/SSE per questo server",
			    mcpServersHeadersEmptyTitle: "Nessun header",
			    mcpServersHeadersEmptySubtitle: "Aggiungi header se il server richiede autenticazione.",
			    mcpServersEnvEditorTitle: "Modifica variabile d’ambiente",
			    mcpServersHeadersEditorTitle: "Modifica header",
			    mcpServersEnvKeyLabel: "Nome variabile d’ambiente",
			    mcpServersEnvKeyPlaceholder: "API_KEY",
			    mcpServersHeaderKeyLabel: "Nome header",
			    mcpServersHeaderKeyPlaceholder: "Authorization",
			    mcpServersValueSourceTitle: "Origine valore",
			    mcpServersArgsPlaceholder: "--flag\nvalue",
			    mcpServersValueSourceLiteral: "Letterale",
			    mcpServersValueSourceLiteralSubtitle: "Memorizza un valore (supporta template ${VAR})",
			    mcpServersValueSourceSavedSecret: "Segreto salvato",
			    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `Segreto salvato: ${name}`,
			    mcpServersValueSourceSavedSecretSubtitle: "Fai riferimento a un segreto salvato",
			    mcpServersValueLiteralLabel: "Valore",
			    mcpServersValueLiteralPlaceholder: "Valore o ${ENV_VAR}",
			    mcpServersValueSecretLabel: "Segreto salvato",
			    mcpServersValueSecretSelect: "Seleziona segreto",
			    mcpServersValueSecretSelectSubtitle: "Scegli un segreto salvato",
			    mcpServersKeyInvalid: "La chiave non è valida.",
			    mcpServersKeyAlreadyExists: "La chiave esiste già.",
			    mcpServersOverridesStdioTitle: "Sovrascritture Stdio",
			    mcpServersOverridesCommandTitle: "Sovrascrivi comando",
			    mcpServersOverridesCommandSubtitle: "Usa un comando diverso per questa associazione",
			    mcpServersOverridesArgsTitle: "Sovrascrivi argomenti",
			    mcpServersOverridesArgsSubtitle: "Usa argomenti diversi per questa associazione (vuoto = nessun argomento)",
			    mcpServersOverridesRemoteTitle: "Sovrascritture remote",
			    mcpServersOverridesUrlTitle: "Sovrascrivi URL",
			    mcpServersOverridesUrlSubtitle: "Usa un URL diverso per questa associazione",
			    mcpServersOverridesEnvPatchTitle: "Patch env",
			    mcpServersOverridesEnvPatchEmptyTitle: "Nessuna sovrascrittura env",
			    mcpServersOverridesEnvPatchEmptySubtitle: "Aggiungi sovrascritture o eliminazioni per le variabili d’ambiente.",
			    mcpServersOverridesHeadersPatchTitle: "Patch header",
			    mcpServersOverridesHeadersPatchEmptyTitle: "Nessuna sovrascrittura header",
			    mcpServersOverridesHeadersPatchEmptySubtitle: "Aggiungi sovrascritture o eliminazioni per gli header.",
			    mcpServersOverridesDeleteValue: "Elimina questa chiave per questa associazione",
			    mcpServersOverridesEnvPatchAddTitle: "Aggiungi sovrascrittura env",
			    mcpServersOverridesEnvPatchAddSubtitle: "Imposta o sovrascrivi una variabile d’ambiente per questa associazione",
			    mcpServersOverridesEnvPatchDeleteTitle: "Elimina chiave env",
			    mcpServersOverridesEnvPatchDeleteSubtitle: "Rimuovi una variabile d’ambiente per questa associazione",
			    mcpServersOverridesHeadersPatchAddTitle: "Aggiungi sovrascrittura header",
			    mcpServersOverridesHeadersPatchAddSubtitle: "Imposta o sovrascrivi un header per questa associazione",
			    mcpServersOverridesHeadersPatchDeleteTitle: "Elimina chiave header",
			    mcpServersOverridesHeadersPatchDeleteSubtitle: "Rimuovi un header per questa associazione",
			    mcpServersOverridesDeleteEnvTitle: "Elimina chiave env",
			    mcpServersOverridesDeleteEnvPrompt: "Inserisci il nome della variabile d’ambiente da eliminare per questa associazione.",
			    mcpServersOverridesDeleteHeaderTitle: "Elimina chiave header",
			    mcpServersOverridesDeleteHeaderPrompt: "Inserisci il nome dell’header da eliminare per questa associazione.",
			    mcpServersOverridesCommandRequired: "La sovrascrittura del comando è abilitata ma vuota.",
			    mcpServersOverridesUrlRequired: "La sovrascrittura dell’URL è abilitata ma vuota.",
			    mcpServersTestTitle: "Verifica",
			    mcpServersTestFooter: "Viene eseguito sulla macchina selezionata. I segreti non sono mostrati nei risultati.",
			    mcpServersTestMachineTitle: "Prova su macchina",
			    mcpServersTestBindingTitle: "Usa associazione",
			    mcpServersTestNoBinding: "Nessuna associazione",
			    mcpServersTestNoBindingSubtitle: "Prova senza sovrascritture dell’associazione",
			    mcpServersTestDirectoryTitle: "Directory di lavoro",
			    mcpServersTestDirectorySubtitle: "Tocca per impostare una directory",
			    mcpServersTestDirectoryPrompt: "Inserisci la directory di lavoro per il test.",
			    mcpServersTestRunTitle: "Prova server",
			    mcpServersTestRunSubtitle: "Connetti ed elenca gli strumenti",
			    mcpServersTestResultOkTitle: "Test riuscito",
			    mcpServersTestResultOkSubtitle: ({
			      toolCount,
			      durationMs,
			    }: {
			      toolCount: number;
			      durationMs: number;
			    }) => `${toolCount} strumenti · ${durationMs}ms`,
			    mcpServersTestResultErrorTitle: "Test non riuscito",
        ...mcpServersUxTranslationExtension,
        ...acpCatalogTranslationExtension.settings,

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
        `Demone: ${serverUrl} • ${accountId}`,
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
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Demone: ${machine}`,
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
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Demone: ${machine}`,
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
    serviceNames: {
      claudeSubscription: "Abbonamento Claude",
      openaiCodex: "Codex di OpenAI",
      openai: "Chiave API OpenAI",
      anthropic: "Chiave API Anthropic",
      gemini: "Gemini di Google",
    },
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
        "Apri l’URL di autorizzazione, completa OAuth nel browser e poi copia/incolla l’URL finale reindirizzato di nuovo in Happier.",
      openAuthorizationUrl: "Apri URL di autorizzazione",
      opensInNewTab: "Si apre in una nuova scheda",
      preparing: "Preparazione…",
      pasteRedirectUrl: "Incolla URL di reindirizzamento",
      pasteRedirectUrlPlaceholder: "Incolla URL di reindirizzamento",
      pasteRedirectUrlPromptBody:
        "Dopo aver completato OAuth, copia l’URL finale reindirizzato dalla barra degli indirizzi del browser e incollalo qui.",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "Passaggio successivo: accedi nella pagina che si apre. Claude potrebbe mostrare una stringa di codice invece di reindirizzare automaticamente.",
          pasteRedirectUrlPromptBody:
            "1) Accedi nella pagina che si apre. 2) Copia l'URL finale oppure il valore completo \"code#state\" mostrato da Claude. 3) Incollalo nel campo qui sotto.",
          pasteRedirectUrlPlaceholder: "Incolla URL di reindirizzamento o code#state",
          errors: {
            missingState:
              "Manca lo stato OAuth. Se Claude mostra un codice, copia il valore completo \"code#state\", non solo il codice.",
          },
        },
      },
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
      errors: {
        missingState: "Stato OAuth mancante nell’URL di reindirizzamento.",
        stateMismatch: "Stato OAuth non corrispondente.",
      },
    },
    oauthEmbedded: {
      title: "Connetti (browser nell’app)",
      description:
        "Avvia l’accesso in un browser incorporato. Se non funziona, usa il metodo di incollare la redirezione.",
      startButton: "Avvia accesso",
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
    },
  },

  settingsSourceControl: {
    title: 'File e controllo sorgente',
    editor: 'Editor file',
    editorFooter: 'Configura il comportamento dell’editor di file.',
    editorAutoSave: 'Salvataggio automatico',
    editorAutoSaveDescription: 'Salva automaticamente i file dopo la modifica.',
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
    badges: {
      title: "Badge su questo dispositivo",
      footer:
        "Scegli quale attività contribuisce al badge dell’icona dell’app su questo dispositivo.",
      enabledTitle: "Abilita badge",
      enabledSubtitle: "Mostra un badge sull’icona dell’app quando un’attività richiede attenzione",
      unreadTitle: "Sessioni non lette",
      unreadSubtitle: "Conta le sessioni con attività non letta nella trascrizione",
      permissionRequestsTitle: "Richieste di autorizzazione",
      permissionRequestsSubtitle: "Conta le sessioni in attesa di approvazione",
      userActionsTitle: "Richieste di azione",
      userActionsSubtitle: "Conta le sessioni in attesa di una risposta o conferma",
      queuedTitle: "Input utente in coda",
      queuedSubtitle: "Conta le sessioni con lavoro in coda che devi ancora inviare",
      friendRequestsTitle: "Richieste di amicizia",
      friendRequestsSubtitle: "Aggiungi le richieste di amicizia in arrivo al badge numerico",
      desktopDotTitle: "Puntino nel dock desktop",
      desktopDotSubtitle: "Su desktop, mostra un puntino quando esiste solo attività inbox non numerica",
    },
    local: {
      title: "Notifiche locali su questo dispositivo",
      footer: "Questi controlli influiscono su come le notifiche appaiono su questo dispositivo specifico.",
      enabledSubtitle: "Consenti a questo dispositivo di mostrare notifiche locali",
      readyTitle: "Pronto",
      readySubtitle: "Mostra una notifica locale quando un turno termina",
      readyPreviewTitle: "Anteprime dei messaggi pronti",
      readyPreviewSubtitle: "Includi l’ultimo messaggio dell’assistente nelle notifiche di pronto su questo dispositivo",
      permissionRequestsTitle: "Richieste di autorizzazione",
      permissionRequestsSubtitle: "Mostra una notifica locale quando una sessione richiede approvazione",
      userActionsTitle: "Richieste di azione",
      userActionsSubtitle: "Mostra una notifica locale quando una sessione richiede il tuo input",
    },
    push: {
      title: "Notifiche push",
      footer:
        "Queste notifiche vengono inviate dal tuo CLI tramite Expo quando la sessione richiede attenzione.",
      enabledSubtitle: "Consenti le notifiche push su questo account",
      troubleshootTitle: "Risoluzione problemi",
      troubleshootSubtitle: "Vedi permessi e dispositivi registrati",
    },
    pushTroubleshooting: {
      status: {
        title: "Stato",
        footer: "Controlla l’impostazione dell’account, il permesso del sistema e la registrazione sul server.",
        accountSettingTitle: "Impostazione account",
        accountSettingEnabledSubtitle: "Le notifiche push sono abilitate per questo account",
        accountSettingDisabledSubtitle: "Le notifiche push sono disabilitate per questo account",
      },
      permission: {
        title: "Permesso",
        loading: "Caricamento…",
        loadingSubtitle: "Verifica dei permessi di notifica",
        unsupported: "Non supportato",
        unsupportedSubtitle: "I permessi push non sono disponibili sul web.",
        allowed: "Consentito",
        allowedSubtitle: "Le notifiche sono consentite per questa app.",
        denied: "Negato",
        notRequested: "Non richiesto",
        canAskAgainSubtitle: "Tocca per richiedere il permesso.",
        openSettingsSubtitle: "Tocca per aprire le impostazioni di sistema.",
      },
      token: {
        title: "Questo dispositivo",
        subtitle: ({ fingerprint }: { fingerprint: string }) =>
          `Token attuale: ${fingerprint}`,
        unavailableSubtitle: "Impossibile leggere un token push di Expo.",
        registered: "Registrato",
      },
      actions: {
        title: "Azioni",
        footer: "Usa questi passaggi se le notifiche push non arrivano.",
        requestPermissionTitle: "Richiedi permesso",
        requestPermissionSubtitle: "Chiedi al sistema il permesso di notifica.",
        reregisterTitle: "Ri-registrare il token",
        reregisterSubtitle: "Invia di nuovo il token di questo dispositivo al server.",
        refreshTitle: "Aggiorna",
        refreshSubtitle: "Ricarica permesso, token e dispositivi sul server.",
      },
      devices: {
        title: "Dispositivi registrati",
        footer: ({ count, serverUrl }: { count: string; serverUrl: string }) =>
          `${count} token${Number(count) === 1 ? "" : "s"} su ${serverUrl}`,
        emptyTitle: "Nessun dispositivo",
        emptySubtitle: "Nessun token push è registrato sul server per questo account.",
        clientServerUrl: ({ url }: { url: string }) => `Server: ${url}`,
        registeredAt: ({ at }: { at: string }) => `Registrato: ${at}`,
        lastSeenAt: ({ at }: { at: string }) => `Ultima attività: ${at}`,
        thisDevice: "Questo dispositivo",
      },
      loadError: "Impossibile caricare lo stato delle notifiche push.",
      authRequired: "Accedi per gestire le notifiche push.",
      remove: {
        confirmTitle: "Rimuovi dispositivo",
        confirmBody: ({ fingerprint }: { fingerprint: string }) =>
          `Rimuovere il token push ${fingerprint}?`,
        error: "Impossibile rimuovere il token push.",
      },
    },
    webhooks: {
      title: "Notifiche webhook",
      footer: "Invia notifiche di attività remota a endpoint webhook aggiuntivi su questo account.",
      addTitle: "Aggiungi webhook",
      addSubtitle: "Consegna le notifiche a un altro endpoint",
      emptyTitle: "Nessun canale webhook",
      emptySubtitle: "Aggiungi un webhook per inviare eventi di attività remota fuori da Expo push.",
      enabledTitle: "Abilita webhook",
      enabledSubtitle: "Le notifiche webhook sono abilitate",
      disabledSubtitle: "Le notifiche webhook sono disabilitate",
      channelEnabledSubtitle: "Consenti a questo endpoint di ricevere notifiche di attività",
      urlPromptTitle: "URL webhook",
      urlPromptSubtitle: "Inserisci l’URL di destinazione per questo webhook di notifica.",
      urlPromptPlaceholder: "https://hooks.example.test/notify",
      invalidUrlTitle: "URL webhook non valido",
      invalidUrlSubtitle: "Inserisci un URL HTTP o HTTPS valido.",
      deleteTitle: "Rimuovi webhook",
      deleteConfirm: ({ url }: { url: string }) =>
        `Interrompere l’invio delle notifiche a ${url}?`,
      signingSecretTitle: "Segreto di firma",
      signingSecretEmptySubtitle: "Aggiungi un segreto condiviso per firmare i payload webhook",
      signingSecretConfiguredSubtitle: "I payload webhook sono firmati con un segreto condiviso",
      signingSecretPromptTitle: "Segreto di firma webhook",
      signingSecretPromptSubtitleAdd: "Inserisci un segreto condiviso per firmare il payload di questo webhook.",
      signingSecretPromptSubtitleReplace: "Inserisci un nuovo segreto condiviso per sostituire l’attuale segreto di firma.",
      signingSecretPromptPlaceholder: "shared-secret",
      signingSecretClearAction: "Cancella segreto",
      readyTitle: "Pronto",
      readySubtitle: "Invia quando un turno termina e l’agente è in attesa del tuo comando",
      readyPreviewTitle: "Anteprime dei messaggi pronti",
      readyPreviewSubtitle: "Includi il testo dell’ultimo messaggio dell’assistente nelle notifiche di pronto per questo webhook",
      permissionRequestsTitle: "Richieste di autorizzazione",
      permissionRequestsSubtitle: "Invia quando una sessione è bloccata in attesa di approvazione",
      userActionsTitle: "Richieste di azione",
      userActionsSubtitle: "Invia quando una sessione richiede una risposta o conferma",
    },
    foregroundBehavior: {
      title: "Notifiche in-app",
      footer:
        "Controlla le notifiche mentre usi l'app. Le notifiche per la sessione che stai visualizzando vengono sempre silenziate.",
      full: "Complete",
      fullDescription: "Mostra banner e riproduci suono",
      silent: "Silenziose",
      silentDescription: "Mostra banner senza suono",
      off: "Disattivate",
      offDescription: "Solo badge, nessun banner",
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
      readyPreview: {
        title: "Anteprime dei messaggi pronti",
        subtitle: "Includi il testo dell’ultimo messaggio dell’assistente nelle notifiche push per i turni pronti",
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
      activity: {
        defaultSessionTitle: "Sessione",
        readyFallbackBody: "Turno terminato. Apri la sessione per continuare.",
        permissionFallbackBody: "Approvazione richiesta.",
        userActionFallbackBody: "Questa sessione richiede il tuo input.",
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
      configuration: 'Configurazione',
      cliConnection: 'Connessione CLI',
      capabilities: 'Capacità',
      models: 'Modelli',
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
      resumeSupportNotSupported: "Non supportato",
      sessionModeNone: "Nessuna modalità ACP",
      sessionModeAcpPolicyPresets: "Preset policy ACP",
      sessionModeAcpAgentModes: "Modalità agente ACP",
      sessionModeDynamicPolicyModes: "Modalità dinamiche di policy",
      sessionModeDynamicAgentModes: "Modalità dinamiche dell'agente",
      sessionModeStaticAgentModes: "Modalità agente statiche",
      runtimeSwitchNone: "Nessun cambio in runtime",
      runtimeSwitchMetadataGating: "Limitato dai metadati",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchSessionModeApi: "API modalità sessione",
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
      cliSourcePreference: {
        title: "Preferenza origine CLI",
        subtitle:
          "Scegli se Happier deve preferire la CLI di sistema o l'installazione gestita quando entrambe sono disponibili.",
        options: {
          systemFirst: {
            title: "Preferisci installazione di sistema",
            subtitle: "Preferisci la CLI già installata su questa macchina.",
          },
          managedFirst: {
            title: "Preferisci installazione gestita",
            subtitle: "Preferisci la CLI installata da Happier per questo provider.",
          },
        },
      },
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `Installa CLI ${provider}`,
        reinstallTitle: ({ provider }: { provider: string }) => `Reinstalla CLI ${provider}`,
        autoInstallUnavailable:
          "L’installazione automatica non è disponibile per questa macchina.",
        installSubtitle:
          "Installa la CLI del provider sulla macchina selezionata (best-effort).",
        reinstallSubtitle:
          "Esegue di nuovo l’installer del provider anche se la CLI è già presente.",
        confirmInstallTitle: ({ provider }: { provider: string }) => `Installare la CLI ${provider}?`,
        confirmReinstallTitle: ({ provider }: { provider: string }) => `Reinstallare la CLI ${provider}?`,
        confirmBody: ({ provider }: { provider: string }) =>
          `Questo eseguirà i comandi dell’installer di ${provider} sulla macchina selezionata. Continua solo se ti fidi del provider.`,
        confirmInstallConfirm: "Installa",
        confirmReinstallConfirm: "Reinstalla",
        noMachineSelected: "Nessuna macchina selezionata.",
        installNotSupported: "Installazione non supportata su questa macchina.",
        installFailed: "Installazione non riuscita.",
        installed: "Installato.",
        logPath: ({ logPath }: { logPath: string }) => `Percorso log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL guida configurazione",
      authentication: {
        title: "Autenticazione",
        footer: "Controlla lo stato di autenticazione locale della CLI e avvia l'accesso quando supportato.",
        terminalTitle: "Terminale di accesso del provider",
        logInTitle: "Accedi",
        logInSubtitle: "Apri un terminale ed esegui il flusso di accesso del provider su questa macchina.",
        reauthenticateTitle: "Riautentica",
        reauthenticateSubtitle: "Apri un terminale e rinnova l'accesso del provider su questa macchina.",
        checkNowTitle: "Controlla ora",
        checkNowSubtitle: "Aggiorna lo stato di autenticazione locale rilevato.",
        statusTitle: "Stato",
        loggedInAsTitle: "Accesso effettuato come",
        methodTitle: "Metodo di autenticazione",
        sourceTitle: "Origine delle credenziali",
        reasonTitle: "Problema",
        lastCheckedTitle: "Ultimo controllo",
        stateUnknown: "Sconosciuto",
        stateLoggedIn: "Accesso effettuato",
        stateLoggedOut: "Disconnesso",
        methods: {
          apiKeyEnv: "Variabile d'ambiente della chiave API",
          authTokenEnv: "Variabile d'ambiente del token di autenticazione",
          credentialsFile: "File credenziali",
          oauthCli: "Accesso OAuth della CLI",
          configFile: "File di configurazione",
          gcloudAdc: "Credenziali predefinite dell'applicazione Google Cloud",
          unknown: "Sconosciuto",
        },
        reasons: {
          missingCredentials: "Credenziali mancanti",
          expired: "Credenziali scadute",
          cliMissing: "CLI non installata",
          probeFailed: "Controllo stato fallito",
          timeout: "Controllo stato scaduto",
          unsupported: "Autenticazione locale non supportata",
          interactiveBlocked: "Accesso interattivo bloccato",
          notConfigured: "Non configurato",
        },
        sources: {
          environment: "Ambiente",
          file: "File locale",
          command: "Comando",
          mixed: "Misto",
        },
      },
      connectedServiceTitle: "Servizio connesso",
      notFoundTitle: "Provider non trovato",
      notFoundSubtitle: "Questo provider non ha una schermata impostazioni.",
      noOptionsAvailable: "Nessuna opzione disponibile",
      invalidNumber: "Numero non valido",
    invalidJson: "JSON non valido",
      plugins: {
            claude: {
                title: "Claude (remoto)",
                sections: {
                    claudeCodeExperiments: {
                        title: "Esperimenti di Claude Code",
                        footer: "Queste impostazioni si applicano sia alle sessioni Claude locali (terminale) sia a quelle remote (Agent SDK) avviate da Happier."
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK (modalita remota)",
                        footer: "La modalita remota esegue Claude sulla tua macchina, ma controllato dall’interfaccia di Happier. La modalita locale e la TUI di Claude Code nel terminale. Queste impostazioni influenzano solo la modalita remota."
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Forza l’attivazione di Agent Teams",
                        subtitle: "Abilita Agent Teams sperimentale di Claude Code (sciame di agenti) in tutte le sessioni Claude avviate da Happier."
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Usa Agent SDK (remoto)",
                        subtitle: "Usa l’@anthropic-ai/claude-agent-sdk ufficiale per la modalita remota."
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "Origini impostazioni",
                        subtitle: "Controlla quali impostazioni di Claude vengono caricate.",
                        options: {
                            user: {
                                title: "Utente",
                                subtitle: "Carica la configurazione globale utente di Claude."
                            },
                            project: {
                                title: "Progetto",
                                subtitle: "Carica le impostazioni del repository (incluso CLAUDE.md)."
                            },
                            local: {
                                title: "Locale",
                                subtitle: "Carica le override solo locali."
                            }
                        }
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "Sperimentale: bridge permessi locale",
                        subtitle: "Inoltra le richieste di permesso della modalita locale di Claude a Happier per approvarle o rifiutarle dall’interfaccia."
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "Mantieni aperte le richieste finche non rispondi",
                        subtitle: "Quando abilitato, Happier mantiene in sospeso le richieste di permesso locali di Claude finche non le approvi o rifiuti dall’interfaccia."
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "Timeout permessi opzionale (secondi)",
                        subtitle: "Usato solo quando l’attesa indefinita e disattivata. Dopo questo ritardo, Happier torna al prompt del terminale di Claude."
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "Checkpoint file + /rewind",
                        subtitle: "Abilita checkpoint dei file e /rewind (solo file; non riavvolge la conversazione). Usa /checkpoints per elencare e /rewind --confirm per applicare (maggiore overhead)."
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "Token massimi di ragionamento",
                        subtitle: "Limita il budget interno di ragionamento di Claude (null = predefinito)."
                    },
                    claudeRemoteDisableTodos: {
                        title: "Disabilita TODO",
                        subtitle: "Impedisce a Claude di creare elementi TODO in modalita remota."
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "Configurazione server MCP rigorosa",
                        subtitle: "Fallisce se una qualsiasi configurazione del server MCP non e valida."
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "Opzioni avanzate (JSON)",
                        subtitle: "Override avanzate dell’Agent SDK per utenti esperti (validate lato client)."
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "Modalita backend",
                        footer: "La modalita server sblocca domande e fork nativo. La modalita ACP e un fallback legacy."
                    },
                    server: {
                        title: "Connessione server",
                        footer: "Lascia vuoto per usare il ciclo di vita del server OpenCode gestito da Happier. Imposta un URL http(s) assoluto per collegarti a un server OpenCode esistente."
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "Modalita backend OpenCode",
                        subtitle: "Scegli il backend di integrazione.",
                        options: {
                            server: {
                                title: "Server (consigliato)",
                                subtitle: "Usa le API server di OpenCode per funzioni piu ricche e maggiore affidabilita."
                            },
                            acp: {
                                title: "ACP (precedente)",
                                subtitle: "Instrada OpenCode tramite ACP; meno funzionalita."
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "URL server OpenCode esistente",
                        subtitle: "Override opzionale per un server OpenCode gestito dall’utente."
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
                title: "ACP personalizzato"
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
              title: "Modalità di instradamento",
              footer:
                "Scegli come instradare Codex. App Server è l'impostazione predefinita consigliata. Il cambio locale/remoto e la ripresa funzionano con App Server; ACP resta disponibile come fallback legacy.",
            },
            installOverrides: {
              title: "Override origine installazione",
              footer:
                "Opzionale. Lascia vuoto per usare le origini di installazione predefinite.",
            },
          },
          fields: {
            codexBackendMode: {
              title: "Modalità di instradamento di Codex",
              subtitle: "Seleziona App Server, ACP o MCP.",
              options: {
                appServer: {
                  title: "Server dell'app",
                  subtitle: "Modalità ufficiale consigliata di Codex app-server",
                },
                acp: {
                  title: "ACP",
                  subtitle: "Instrada Codex tramite ACP (codex-acp)",
                },
                mcp: {
                  title: "MCP",
                  subtitle: "Modalità MCP predefinita di Codex",
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
    itemDensity: "Densità elementi",
    itemDensityDescription: "Scegli quanto grandi devono apparire righe e impostazioni in tutta l'app",
    itemDensityOptions: {
      comfortable: "Predefinita",
      comfortableDescription: "Usa dimensioni e spaziatura standard per le righe",
      cozy: "Intermedia",
      cozyDescription: "Usa righe leggermente più compatte senza arrivare al layout compatto",
      compact: "Compatta",
      compactDescription: "Mostra più righe sullo schermo con spaziatura ridotta",
    },
  },

  settingsChannelBridges: {
    unsupported: "I ponti di canale non sono supportati in questo ambiente.",
    enableInFeatures: "Abilita i ponti di canale",
    enableInFeaturesSubtitle: "I ponti di canale sono sperimentali e disattivati per impostazione predefinita.",
    description: "I ponti di canale ti permettono di collegare chat esterne (Telegram) alle sessioni e inoltrare i messaggi all'agente.",
    telegramTitle: "Telegram",
    telegramFooter: "Configura Telegram tramite CLI, poi gestisci i collegamenti in Telegram con /sessions, /attach, /detach, /help.",
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
      expEmbeddedTerminal: "Terminale incorporato",
      expEmbeddedTerminalSubtitle:
        "Apri un vero terminale nelle sessioni.",
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
      expChannelBridges: "Bridge di canale",
      expChannelBridgesSubtitle: "Collega Telegram e altri canali di chat alle sessioni Happier (sperimentale)",
      expMemorySearch: "Ricerca memoria",
      expMemorySearchSubtitle:
        "Abilita schermate e impostazioni di ricerca memoria locale",
    expSessionsDirect: "Sessioni dirette",
    expSessionsDirectSubtitle: "Mostra e apri nella barra laterale le sessioni dirette basate sul provider",
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
    permissionDeniedReadOnlyMode: "Negato dalla modalità Sola lettura (le azioni di scrittura sono negate).",
    permissionCanceled: "Permesso annullato",
    permissionCanceledSessionInactive: "La sessione è inattiva — questa richiesta di permesso non può essere approvata.",
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
      voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
      `Limite sessione vocale: circa ${duration}.`,
      voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
      `La sessione vocale terminerà tra circa ${duration}.`,
      voiceSessionLimitExpired:
      "La sessione vocale ha raggiunto il limite di tempo corrente ed è terminata.",
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
      "Il server di ripresa di Codex non è installato su questa macchina",
    codexResumeNotInstalledMessage:
      "Per riprendere una conversazione di Codex, installa il server di ripresa di Codex sulla macchina di destinazione (Dettagli macchina → Installables).",
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
      },
      codexAcp: {
        title: "Adattatore Codex ACP",
      },
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
      lastInstallLog: "Ultimo log di installazione",
      installLogTitle: "Log di installazione",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
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
    checkout: {
      selectTitle: "Seleziona checkout",
      noWorktree: "Cartella corrente",
      noWorktreeSubtitle:
        "Usa la cartella già selezionata senza collegare un checkout del workspace.",
      noWorktreeSectionTitle: "Cartella corrente",
      existingWorktreesSectionTitle: "Checkout collegati",
      actionsSectionTitle: "Azioni",
      newWorktree: "Nuovo worktree",
      newWorktreeSubtitle: "Crea e usa un nuovo worktree Git per questa sessione.",
      existingWorktree: "Worktree esistente",
      existingWorktreeSubtitle:
        "Scegli un worktree Git esistente per questa sessione.",
      existingWorktreeEmptyTitle: "Nessun worktree esistente",
      existingWorktreeEmptySubtitle:
        "Crea prima un worktree Git oppure scegli Nuovo worktree.",
      newWorktreeDetailWorkspace:
        "Crea un nuovo checkout collegato in questo workspace.",
      newWorktreeDetailBranch:
        "Parti dallo stato attuale del repository e scegli un nuovo nome branch/worktree.",
      branchPickerTitle: "Da dove partire",
      branchPickerCurrentHead: "Ramo corrente",
      branchPickerCurrentHeadDescription:
        "Parti dal ramo attualmente selezionato in questo repository.",
      branchPickerEmpty: "Nessun ramo disponibile per questo repository.",
      branchPickerSearchPlaceholder: "Cerca rami…",
      branchPickerRefreshA11y: "Aggiorna rami",
      branchPickerLoadingA11y: "Caricamento rami",
      branchPickerRefreshingA11y: "Aggiornamento rami",
      primaryDetailDescription:
        "Usa il checkout principale collegato di questo workspace sulla macchina selezionata.",
      gitWorktreeDetailDescription:
        "Usa un checkout Git worktree già collegato per questa sessione.",
      existingBranchWorktreeDescription:
        "Questo ramo ha già un worktree. Puoi riutilizzarlo direttamente oppure creare da lì un nuovo ramo.",
      existingBranchDescription:
        "Questo ramo può essere usato direttamente in un nuovo worktree, oppure puoi creare da lì un nuovo ramo.",
      createNewBranchFromBranchHint:
        "Usa Applica per creare un nuovo ramo e worktree da questo ramo.",
      useExistingBranchAction: "Usa ramo esistente",
      useExistingWorktreeAction: "Usa worktree esistente",
      detailBranch: ({ branch }: { branch: string }) => `Ramo: ${branch}`,
      detailPath: ({ path }: { path: string }) => `Percorso: ${path}`,
      detailLinkedWorkspace: "Collegato all'area di lavoro corrente.",
    },
    selectSessionTypeTitle: "Seleziona tipo di sessione",
    selectSessionTypeDescription:
      "Scegli una sessione semplice o una collegata a una worktree Git.",
    searchPathsPlaceholder: "Cerca percorsi...",
    noMachinesFound:
      "Nessuna macchina trovata. Avvia prima una sessione Happier sul tuo computer.",
    allMachinesOffline: "Tutte le macchine sembrano offline",
    machineOfflineInlineTitle: "La macchina è offline",
    machineOfflineInlineBody:
      "Avvia il daemon su questa macchina o scegli un’altra macchina prima di creare una sessione.",
    machineOfflineCannotStartStatus: "offline (impossibile avviare la sessione)",
    automationChip: {
      default: "Automatizza",
      interval: ({ minutes }: { minutes: number }) => `Ogni ${minutes} min`,
      cron: "Programmazione cron",
    },
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
      truncatedDirectoryInfo: ({ count }: { count: number }) => `Mostrati i primi ${count} elementi`,
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
    profileSelection: {
      workspaceDefault: "Predefinito dell'area di lavoro",
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
      chipOptional: ({ agent }: { agent: string }) => `Riprendi sessione ${agent}`,
      pickerTitle: "Riprendi sessione",
      subtitle: ({ agent }: { agent: string }) =>
        `Incolla un ID sessione ${agent} per riprendere`,
      placeholder: ({ agent }: { agent: string }) =>
        `Incolla ID sessione ${agent}…`,
      browse: "Sfoglia sessioni",
      paste: "Incolla",
      save: "Salva",
      clearAndRemove: "Cancella",
      helpText: "Puoi trovare gli ID sessione nella schermata Info sessione.",
      cannotApplyBody:
        "Questo ID di ripresa non può essere applicato ora. Happier avvierà invece una nuova sessione.",
    },
    codexResumeBanner: {
      title: "Server di ripresa di Codex",
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
      installTitle: "Installare il server di ripresa di Codex?",
      updateTitle: "Aggiornare il server di ripresa di Codex?",
      reinstallTitle: "Reinstallare il server di ripresa di Codex?",
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

  sessionHandoff: sessionHandoffTranslationExtensions.it,

  session: {
    inputPlaceholder: "Scrivi un messaggio ...",
    toolCalls: "Chiamate strumento",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} in più…`,
    forking: {
      dividerTitle: "Derivato da un contesto precedente",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Derivato da ${parent}`,
      dividerSubtitle: "Contesto precedente (sola lettura)",
      openParent: "Apri",
      openParentA11y: "Apri la sessione padre",
      forkFromMessageA11y: "Deriva da questo messaggio",
	    },
	    rollback: {
	      latestTurnA11y: "Ripristina l'ultimo turno",
	      beforeUserMessageA11y: 'Ripristina fino a prima di questo messaggio',
	    },
	    resuming: "Ripresa in corso...",
	    resumeFailed: "Impossibile riprendere la sessione",
	    pendingQueuedResumeFailedTitle: "Messaggio in coda",
	    pendingQueuedResumeFailedBody:
	      "Il tuo messaggio è stato salvato nella coda dei messaggi in sospeso, ma Happier non è riuscito a riprendere questa sessione. Riprova per avviarla.",
	    invalidLinkTitle: "Link di sessione non valido",
	    invalidLinkDescription: "Il link della sessione è mancante o non valido. Controlla l’URL e riprova.",
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
          openSubagents: ({ count }: { count: number }) => (count > 0 ? `Apri agenti (${count})` : 'Apri agenti'),
          participants: {
            to: 'A',
            lead: 'Principale',
            sendToTitle: 'Invia a',
            broadcast: ({ teamId }: { teamId: string }) => `Trasmissione: ${teamId}`,
            executionRun: ({ runId }: { runId: string }) => `Esecuzione ${runId}`,
            cardTo: ({ label }: { label: string }) => `A: ${label}`,
            unsupportedAttachmentsOrReviewComments: 'L’invio a un destinatario non supporta ancora allegati o commenti di revisione.',
          },
          subagents: {
            messages: {
              teamLabel: ({ teamId }: { teamId: string }) => `Squadra: ${teamId}`,
              memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
                `${memberLabel} · ${teamId}`,
              launch: {
                createTeamTitle: "Crea team",
                createMemberTitle: "Avvia compagno di squadra",
              },
              command: {
                deleteTeamTitle: "Elimina team",
                deleteMemberTitle: "Arresta compagno di squadra",
              },
            },
                        panel: {
              title: "Agenti",
              active: "Attivi",
              recent: "Recenti",
              emptyActive: "Nessun agente attivo.",
              emptyRecent: "Nessun agente recente per ora.",
              openFull: "Apri vista completa",
              openAdvancedRun: "Dettagli esecuzione",
              send: "Invia messaggio",
              delete: "Elimina",
              launchSectionTitle: "Avvio",
              launchSectionSubtitle: "Avvia nuovi agenti ed esecuzioni da questa sessione.",
              sectionCount: ({ count }: { count: number }) => `${count}`,
              groupCount: ({ count }: { count: number }) => `${count} agenti`,
              launchExecutionRunsTitle: "Avvia esecuzioni",
              launchExecutionRunsSubtitle: "Apri il launcher delle esecuzioni con preset di revisione, piano o delega.",
              launchExecutionRunsAdvanced: "Avanzate…",
              launchClaudeTeamsTitle: "Avvia team Claude",
              launchClaudeTeamsSubtitle: "Crea un team o avvia un compagno con comandi strutturati dei team Claude.",
              teamIdLabel: "ID team",
              teamIdPlaceholder: "id-team",
              teamDescriptionPlaceholder: "Di cosa si occupa questo team?",
              launchClaudeTeamA11y: "Crea team Claude",
              launchClaudeTeamAction: "Crea team",
              teammateTeamIdLabel: "Team del compagno",
              teammateLabelPlaceholder: "Etichetta del compagno",
              teammateInstructionsPlaceholder: "Cosa deve fare questo compagno?",
              launchTeammateA11y: "Avvia compagno",
              launchTeammateAction: "Avvia compagno",
              typeFact: ({ value }: { value: string }) => `Tipo: ${value}`,
              providerFact: ({ value }: { value: string }) => `Fornitore: ${value}`,
              backendFact: ({ value }: { value: string }) => `Backend: ${value}`,
              intentFact: ({ value }: { value: string }) => `Intenzione: ${value}`,
              errors: {
                teamIdRequired: "Inserisci prima un ID team.",
                memberTeamIdRequired: "Inserisci prima l'ID team del compagno.",
                memberLabelRequired: "Inserisci prima un'etichetta per il compagno.",
                memberInstructionsRequired: "Inserisci prima le istruzioni per il compagno.",
              },
            },
            details: {
              unavailable: "Questa trascrizione dell'agente non è più disponibile.",
            },
            kind: {
              execution_run: "Esecuzione",
              agent_team_member: "Agente del team",
              subagent_sidechain: "Subagente",
            },
            intent: {
              review: "Revisione",
              plan: "Piano",
              delegate: "Delega",
            },
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
              unpinTabA11y: "Rimuovi fissaggio scheda",
              pinnedTabA11y: "Scheda fissata",
              closeTabA11y: "Chiudi scheda",
              enterFocusModeA11y: "Entra in modalità focus editor",
              exitFocusModeA11y: "Esci dalla modalità focus editor",
        },
  
      actionsDraft: {
        noInputHints: "Questa azione non ha suggerimenti di input.",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `${field} è obbligatorio.`,
        },
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
      questionsTitle: "Domande del revisore",
      assumptionsTitle: "Ipotesi",
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
        untriaged: "In sospeso",
        accept: "Implementa correzione",
        reject: "Ignora",
        defer: "Decidi più tardi",
        needsRefinement: "Chiedi chiarimenti",
      },
      refinementPlaceholder: "Cosa richiede chiarimenti?",
      actions: {
        applyTriage: "Applica azioni di revisione",
        applying: "Applicazione…",
        askReviewer: "Chiedi al revisore",
        answerQuestion: "Rispondi al revisore",
        applyAcceptedFindings: "Implementa correzioni selezionate",
        sendFollowUp: "Invia follow-up",
        sending: "Invio…",
      },
      errors: {
        applyTriageFailed: "Impossibile applicare le azioni di revisione.",
        followUpFailed: "Impossibile inviare il follow-up della revisione.",
        applyAcceptedFailed: "Impossibile inviare le correzioni selezionate.",
      },
    },

        pendingMessages: {
          title: "Messaggi in sospeso",
          indicator: ({ count }: { count: number }) => `In sospeso (${count})`,
          badgeLabel: ({ count }: { count: number }) =>
            count > 0 ? `In sospeso (+${count})` : "In sospeso",
	          empty: "Nessun messaggio in sospeso.",
	          decryptFailed: "Impossibile decifrare questo messaggio in sospeso.",
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
      bargeIn: "Interrompi",
      cancelTurn: "Annulla risposta",
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

  devVoiceQa: {
    menuTitle: "Banco di prova QA vocale",
    menuSubtitle: "Controlla il vero agente vocale con prompt di testo",
    title: "Banco di prova QA vocale",
    subtitle: "Avvia il runtime vocale configurato e invia prompt senza usare il microfono.",
    instructions: "Usa questa schermata per testare il vero agente vocale locale o una sessione ElevenLabs con prompt di testo deterministici. Lascia vuoto l'ID sessione per usare il target vocale corrente o la sessione globale dell'agente vocale.",
    configurationTitle: "Configurazione",
    configuredProvider: "Provider configurato",
    qaProvider: "Provider QA attivo",
    qaStatus: "Stato QA",
    targetSession: "Sessione di destinazione corrente",
    runtimeSession: "Sessione runtime attiva",
    inputsTitle: "Input",
    sessionIdLabel: "Override ID sessione",
    sessionIdPlaceholder: "Lascia vuoto per usare il target vocale corrente",
    initialContextLabel: "Contesto iniziale",
    initialContextPlaceholder: "Contesto opzionale inviato all'avvio della sessione QA",
    promptLabel: "Richiesta",
    promptPlaceholder: "Digita il testo da inviare all'agente vocale",
    contextUpdateLabel: "Aggiornamento contesto",
    contextUpdatePlaceholder: "Aggiornamento di contesto opzionale successivo",
    actionsTitle: "Azioni",
    sendContext: "Invia contesto",
    usesCurrentProvider: "Questo banco di prova usa sempre le impostazioni vocali correnti e le integrazioni runtime reali.",
    localModeHint: "Il QA locale richiede Local voice con la modalità conversazione impostata su Agent.",
    elevenLabsHint: "Il QA ElevenLabs richiede che il provider ElevenLabs sia configurato e che la sessione realtime si connetta correttamente.",
    transcriptTitle: "Trascrizione QA",
    transcriptEmpty: "Nessuna trascrizione QA.",
    activityTitle: "Attività vocale",
    activityEmpty: "Nessuna attività vocale acquisita per la sessione QA attiva.",
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
    retention: {
      title: "Criterio di conservazione",
      summary: "Riepilogo",
      keepForever: "Nessuna eliminazione automatica",
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Elimina le sessioni inattive dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Elimina i dati dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })}.`,
      sessionNotice: ({ count }: { count: number }) => `Questo server elimina le sessioni inattive dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })} di inattività.`,
      sessions: "Sessioni",
      accountChanges: "Modifiche account",
      voiceSessionLeases: "Lease delle sessioni vocali",
      feedItems: "Elementi del feed",
      sessionShareAccessLogs: "Log di accesso alle condivisioni di sessione",
      publicShareAccessLogs: "Log di accesso alle condivisioni pubbliche",
      terminalAuthRequests: "Richieste di autorizzazione terminale",
      accountAuthRequests: "Richieste di autorizzazione account",
      authPairingSessions: "Sessioni di pairing autenticazione",
      repeatKeys: "Chiavi di ripetizione",
      globalLocks: "Blocchi globali",
      automationRuns: "Esecuzioni automazioni",
      automationRunEvents: "Eventi di esecuzione automazioni",
    },
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
    storagePersistedTab: "Sincronizzate",
    storageDirectTab: "Dirette",
    renameWorkspace: 'Rinomina area di lavoro',
    renameWorkspacePromptTitle: 'Rinomina area di lavoro',
    renameWorkspacePromptPlaceholder: 'Inserisci un nome...',
    resetWorkspaceName: 'Reimposta nome',
  },

  directSessions: {
    browseTitle: "Sfoglia le sessioni del provider",
    browseOpenExisting: "Sfoglia le sessioni del provider",
    browseFiltersTitle: "Seleziona origine",
    browseMachines: "Macchine",
    browseProviders: "Provider",
    browseSources: "Sorgenti",
    browseSourceCodexUserHome: "La mia home di Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} servizi collegati`,
    browseSourceClaudeDefault: "Configurazione predefinita di Claude",
    browseSourceOpenCodeDefault: "Server OpenCode predefinito",
    browseCandidates: "Sessioni disponibili",
    browseNoMachines: "Non ci sono ancora macchine disponibili per le sessioni dirette.",
    browseNoCandidates: "Nessuna sessione del provider trovata per questa macchina e questo provider.",
    browseActivityRunning: "In esecuzione",
        browseActivityRunningNow: "In esecuzione",
    browseActivityRecent: "Recente",
    browseActivityIdle: "Inattiva",
    browseActivityUnknown: "Sconosciuta",
        browseSearchPlaceholder: "Cerca nelle sessioni caricate…",
        browseNoSearchResults: "Nessuna sessione caricata corrisponde ancora a questa ricerca.",
    browseLoadMore: "Carica altre sessioni",
    browseFailedToLoad: "Impossibile caricare le sessioni del provider.",
    browseLinkFailed: "Impossibile collegare la sessione del provider selezionata.",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: 'Checkout principale',
            git_worktree: 'worktree Git',
        },
    },
    sourceControlWorkspace: {
        createTitle: 'Crea workspace collegato',
        createSubtitle: 'Aggiungi questo checkout a un\'area di lavoro collegata e aprine le impostazioni.',
        otherCheckoutsTitle: 'Altri checkout',
        unlinkedWorktreesTitle: 'Worktree non collegati',
        createSessionInWorktreeTitle: 'Crea sessione qui',
        adoptWorktreeTitle: 'Aggiungi worktree al workspace',
    },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "Informazioni sulla sessione",
	    killSession: "Termina sessione",
    killSessionConfirm: "Sei sicuro di voler terminare questa sessione?",
    stopSession: "Ferma sessione",
    stopSessionConfirm: "Sei sicuro di voler fermare questa sessione?",
    archiveSession: "Archivia sessione",
    archiveSessionConfirm: "Sei sicuro di voler archiviare questa sessione?",
    workspaceTitle: "Area di lavoro",
    workspaceLabel: "Area di lavoro",
    linkWorkspaceTitle: "Collega questo workspace",
    linkWorkspaceSubtitle: "Crea un workspace collegato da questo percorso di sessione e aprine le impostazioni.",
    openWorkspaceTitle: "Apri workspace",
    openWorkspaceSubtitle: "Apri i dettagli e le impostazioni del workspace collegato.",
    createWorktreeTitle: "Crea worktree",
    createWorktreeSubtitle: "Avvia una nuova sessione che creerà un Git worktree in questo workspace collegato.",
    locationLabel: "Posizione",
    checkoutLabel: "Check-out",
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
    kiroSessionId: "ID sessione Kiro",
    kiroSessionIdCopied: "ID sessione Kiro copiato negli appunti",
    customAcpSessionId: "ID sessione ACP personalizzata",
    customAcpSessionIdCopied: "ID sessione ACP personalizzata copiato negli appunti",
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
    updateCliInstructions: "Esegui happier self update",
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
      kiro: "Kiro",
      customAcp: "ACP personalizzato",
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
    agentTeamView: {
      team: "Squadra",
      member: "Membro",
      type: "Tipo",
      content: "Contenuto",
      status: "Stato",
      description: "Descrizione",
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
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `Crea subagente: ${subject}`,
      createTask: "Crea subagente",
      listTasks: "Elenca subagenti",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `Aggiorna subagente ${id} → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `Aggiorna subagente ${id}`,
      updateTask: "Aggiorna subagente",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `+${count} altri strumenti`,
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
      subAgent: "Sub-agente",
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
      turnDiffRecap: "Riepilogo delle modifiche di questo turno",
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
	    repositoryTree: {
	      actions: {
	        copyPath: "Copia percorso",
	        download: "Scarica",
	        downloadAsZip: "Scarica come ZIP",
	      },
	      dropToUpload: "Trascina i file per caricare",
	      rename: {
	        title: "Rinomina",
	        body: "Inserisci un nuovo percorso relativo alla radice del progetto.",
	        invalidPath:
	          "Percorso non valido. Usa un percorso relativo al workspace come src/new-file.ts.",
	        failed: "Impossibile rinominare.",
	        conflicts: {
	          title: "La destinazione esiste già",
	          body: ({ path }: { path: string }) => `"${path}" esiste già. Cosa vuoi fare?`,
	        },
	      },
	      deleteFolder: {
	        title: "Eliminare la cartella?",
	        body: ({ path }: { path: string }) =>
	          `Eliminare la cartella ${path} e tutto il suo contenuto?`,
	        confirm: "Elimina cartella",
	      },
	      deleteFile: {
	        title: "Eliminare il file?",
	        body: ({ path }: { path: string }) => `Eliminare il file ${path}?`,
	      },
	      delete: {
	        failed: "Impossibile eliminare.",
	      },
	      download: {
	        notReady: "Il download non è ancora disponibile.",
	      },
	    },
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
    branchSwitchDialog: {
      title: "Cambia ramo",
      body: "Hai modifiche non committate. Come vuoi gestirle?",
      leaveTitle: ({ branch }: { branch: string }) => `Lascia le mie modifiche su ${branch}`,
      leaveSubtitle: "Crea uno stash sul ramo corrente e cambia.",
      bringTitle: ({ branch }: { branch: string }) => `Porta le mie modifiche su ${branch}`,
      bringSubtitle: "Prova a cambiare e mantenere le modifiche sul nuovo ramo.",
    },
    branchMenu: {
      openA11y: "Apri menu dei rami",
      failedToLoad: "Impossibile caricare i rami.",
      unavailable: "Elenco dei rami non disponibile",
      empty: "Nessun ramo trovato",
      searchPlaceholder: "Cerca rami...",
        category: {
        actions: "Azioni",
        branches: "Rami",
        worktrees: "Worktree",
        remote: "Remoti",
        local: "Locali",
        options: "Opzioni",
      },
      publish: {
        title: "Pubblica ramo",
        subtitle: "Invia il ramo corrente a un ramo remoto upstream",
        short: "Pubblica",
        failed: "Impossibile pubblicare il ramo.",
      },
      create: {
        title: "Crea ramo",
        subtitle: ({ name }: { name: string }) => `Crea \"${name}\"`,
        failed: "Impossibile creare il ramo.",
      },
      switch: {
        failed: "Impossibile cambiare ramo.",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `Remoto upstream: ${upstream}`,
      },
      remotes: {
        show: "Mostra rami remoti",
        hide: "Nascondi rami remoti",
        subtitle: "Includi i rami remoti nell'elenco",
      },
      worktrees: {
        createFromCurrentBranchTitle: "Nuovo worktree dal ramo corrente",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) =>
          `Crea un nuovo worktree da ${branch} e avvia lì una sessione.`,
        createFromCurrentBranchDetachedSubtitle:
          "Passa a un ramo prima di creare un worktree dal ramo corrente.",
        createFromAnotherBranchTitle: "Nuovo worktree da un altro ramo",
        createFromAnotherBranchSubtitle:
          "Apri il flusso nuova sessione per scegliere un altro ramo o riutilizzare un worktree esistente.",
        removeTitle: "Rimuovi worktree",
        removeSubtitle: ({ target }: { target: string }) =>
          `Rimuovi ${target} da questo repository.`,
        removeConfirmTitle: "Rimuovere il worktree?",
        removeConfirmBody: ({ path }: { path: string }) =>
          `Rimuovere il worktree in ${path}? Questa operazione non può essere annullata.`,
        removeConfirmButton: "Rimuovi worktree",
        pruneTitle: "Pulisci worktree obsoleti",
        pruneSubtitle: "Pulisci i metadati dei worktree obsoleti per questo repository.",
        createFailed: "Impossibile creare il worktree.",
        removeFailed: "Impossibile rimuovere il worktree.",
        pruneFailed: "Impossibile pulire i worktree obsoleti.",
      },
      stashOverwrite: {
        title: "Sovrascrivere lo stash del ramo?",
        body: ({ branch }: { branch: string }) =>
          `Esiste già uno stash per ${branch}. Sovrascriverlo?`,
        confirm: "Sovrascrivi stash",
      },
    },
    stash: {
      summaryA11y: "Apri dettagli stash",
      summaryTitle: "Stash gestiti",
      detailsTitle: "Stash gestiti",
      empty: "Nessuno stash gestito.",
      failedToLoad: "Impossibile caricare gli stash.",
      failedToLoadDiff: "Impossibile caricare la diff dello stash.",
      diffTruncated: "Diff troncata (limite di output).",
      writeDisabled: "Le operazioni di scrittura del controllo versione sono disabilitate.",
      noSelection: "Seleziona uno stash per continuare.",
      selectA11y: ({ stash }: { stash: string }) => `Seleziona stash ${stash}`,
      restore: "Ripristina",
      discard: "Scarta",
      restoreFailed: "Impossibile ripristinare lo stash.",
      discardFailed: "Impossibile scartare lo stash.",
      restoreConfirm: {
        title: "Ripristinare le modifiche nello stash?",
        body: "Applicherà le modifiche salvate al tuo working tree. I conflitti potrebbero richiedere una risoluzione manuale.",
        confirm: "Ripristina",
      },
      discardConfirm: {
        title: "Scartare le modifiche nello stash?",
        body: "Questo eliminerà definitivamente questo stash.",
        confirm: "Scarta",
      },
    },
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} in stage • ${unstaged} non in stage`,
    branchSummary: {
      ahead: "Avanti",
      behind: "Indietro",
      included: "Incluso",
      staged: "In stage",
      pending: "In sospeso",
      unstaged: "Non in stage",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Remoto upstream ${upstream}`,
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
    latestTurnChanges: ({ count }: { count: number }) =>
      `Modifiche dell'ultimo turno (${count})`,
    latestTurnDescription:
      'Modifiche supportate dal provider per il turno completato più recente.',
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
    noLatestTurnChanges:
      "Nessuna modifica dell'ultimo turno rilevata.",
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
      fileTooLargeToPreview: "Il file è troppo grande per l'anteprima",
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
	          suggestionReady: "È pronto un suggerimento. Applicarlo?",
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
      hiddenFiles: "Mostra file nascosti",
      details: "Dettagli",
      upload: "Carica",
      uploadFiles: "Carica file",
      uploadFolder: "Carica cartella",
      allRepositoryFiles: "Tutti i file del repository",
      repositoryView: "Vista repository",
      turnView: "Vista turno",
      sessionView: "Vista sessione",
      review: "Revisione",
      list: "Elenco",
      scm: "Git",
    },
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `Preparazione caricamento (${count} file)…`,
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
      }) => `Caricamento ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `Download ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "Conflitti di caricamento",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount} di ${totalCount} file esistono già. Cosa vuoi fare?`,
        keepBoth: {
          title: "Mantieni entrambi",
          subtitle:
            "Aggiungi “ (1)”, “ (2)”, … ai nomi in conflitto.",
        },
        replace: {
          title: "Sostituisci",
          subtitle: "Sovrascrivi i file esistenti.",
        },
        skip: {
          title: "Salta",
          subtitle: "Carica solo i file che non esistono già.",
        },
      },
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
      titles: {
        executionRun: "Esecuzione",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent} · esecuzione`,
      },
      labels: {
        status: "Stato",
        statusValue: ({ value }: { value: string }) => `Stato: ${value}`,
        runId: ({ value }: { value: string }) => `ID esecuzione: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permessi: ${value}`,
        mode: ({ value }: { value: string }) => `Modalità: ${value}`,
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

        settingsActions: {
        aboutSubtitle: "Scegli dove viene mostrata ogni azione nell’app, nella voce e nelle integrazioni. I riquadri non disponibili restano visibili così puoi capire cosa è bloccato da funzionalità, privacy o supporto runtime.",
        aboutFooter: "Queste impostazioni si applicano globalmente ai valori predefiniti del tuo account. I riquadri non disponibili spiegano perché una destinazione è attualmente bloccata.",
        searchPlaceholder: "Cerca azioni",
        noResults: "Nessuna azione corrisponde alla ricerca attuale.",
        noDescription: "Nessuna descrizione ancora disponibile.",
        requireApproval: "Richiedi approvazione",
        sections: {
            app: "Nell’app",
            voice: "Voce",
            integrations: "Integrazioni",
        },
        badges: {
            unavailable: "Non disponibile",
        },
        reasons: {
            voiceFeature: "Abilita le impostazioni dell’assistente vocale per usare questa destinazione.",
            voiceInventoryPrivacy: "Attiva Condividi inventario dispositivo nelle impostazioni privacy dell’assistente vocale per usare questa destinazione.",
            mcpFeature: "Abilita i server MCP per esporre questa azione tramite MCP.",
            executionRunsFeature: "Abilita le execution run per usare questa azione o destinazione.",
            memorySearchFeature: "Abilita la ricerca memoria locale per usare questa azione.",
            sessionHandoffFeature: "Abilita il supporto handoff sessione per usare questa azione.",
            notAvailableInThisApp: "Questa destinazione non è ancora disponibile in questo client.",
        },
        targets: {
            session_header: {
                title: "Intestazione sessione",
                subtitle: "Visibile nella barra strumenti dell’intestazione sessione.",
            },
            session_action_menu: {
                title: "Menu sessione",
                subtitle: "Visibile nel menu azioni della sessione.",
            },
            session_info: {
                title: "Dettagli sessione",
                subtitle: "Visibile nella schermata informazioni sessione.",
            },
            command_palette: {
                title: "Palette comandi",
                subtitle: "Visibile nella palette comandi globale.",
            },
            slash_command: {
                title: "Comando slash",
                subtitle: "Disponibile dai selettori azione in stile slash command.",
            },
            agent_input_chips: {
                title: "Chip del composer",
                subtitle: "Mostrato come chip rapidi vicino all’input dell’agente.",
            },
            voice_panel: {
                title: "Pannello vocale",
                subtitle: "Mostrato nel pannello dell’assistente vocale.",
            },
            run_list: {
                title: "Elenco esecuzioni",
                subtitle: "Visibile negli elenchi delle execution run.",
            },
            run_card: {
                title: "Schede esecuzione",
                subtitle: "Visibile sulle schede delle execution run.",
            },
            voice_tool: {
                title: "Strumento vocale",
                subtitle: "Disponibile all’agente vocale come strumento invocabile.",
            },
            voice_action_block: {
                title: "Blocco azione vocale",
                subtitle: "Mostrato dentro ai blocchi e alle affordance delle azioni vocali.",
            },
            session_agent: {
                title: "Agente di sessione",
                subtitle: "Disponibile per gli agenti nella sessione come strumento richiamabile.",
            },
            mcp: {
                title: "MCP",
                subtitle: "Disponibile tramite il catalogo azioni MCP.",
            },
            cli: {
                title: "CLI di controllo sessione",
                subtitle: "Disponibile tramite la superficie CLI di controllo sessione.",
            },
            contextual_ui: {
                title: "UI contestuale",
                subtitle: "Mostrata nelle superfici UI contestuali che non hanno un posizionamento dedicato.",
            },
        },
    },

settingsSession: {
      sessionList: {
          title: 'Elenco sessioni',
          footer: 'Personalizza cosa appare in ogni riga della sessione.',
          tagsTitle: 'Tag della sessione',
          tagsEnabledSubtitle: "Controlli tag visibili nell'elenco sessioni",
          tagsDisabledSubtitle: 'Controlli tag nascosti',
      },
      input: {
          title: 'Immissione',
          footer: "Configura aspetto e comportamento della barra di input dell'agente.",
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Modalità remota predefinita di Windows',
      },
      advanced: {
          title: 'Avanzate',
      },
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
          cardTapActionTitle: "Azione al tocco",
          timelineChrome: {
            title: "Stile strumenti nella timeline",
            cardsTitle: "Schede",
          cardsSubtitle:
            "Schede strumento con contenuto inline (in base al livello di dettaglio).",
          activityFeedTitle: "Feed strumenti",
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
          defaultDetailTitle: "Dettaglio predefinito (feed strumenti)",
          expandedDetailTitle: "Dettaglio espanso (feed strumenti)",
          tapActionTitle: "Azione al tocco (feed strumenti)",
          tapAction: {
            expandTitle: "Espandi",
            expandSubtitle: "Tocca per espandere o comprimere i dettagli inline.",
            openTitle: "Apri",
            openSubtitle: "Tocca per aprire la schermata vista completa strumento.",
          },
          defaultExpandedTitle: "Espanso per impostazione predefinita",
          defaultExpandedSubtitle:
            "Espandi le righe strumento per impostazione predefinita nel feed strumenti.",
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
        codeDiffs: 'Codice e diff',
        codeDiffsFooter: 'Configura come codice e diff vengono mostrati nella trascrizione.',
        layoutTitle: "Disposizione",
        layoutFooter:
          "Scegli tra una trascrizione lineare e il raggruppamento per turni.",
        layoutPickerTitle: "Layout trascrizione",
        layout: {
          linearTitle: "Lineare",
          linearSubtitle: "Mostra i messaggi come lista piatta.",
          turnsTitle: "Turni",
          turnsSubtitle: "Raggruppa i messaggi in turni utente/assistente.",
        },
        toolCallsGroupTitle: "Raggruppa chiamate strumento",
        toolCallsGroupSubtitle:
          "Compatta le chiamate strumento in una sezione chiamate strumento dentro ogni turno.",
        toolCallsGroupBackgroundTitle: "Sfondo gruppo chiamate",
        toolCallsGroupBackgroundSubtitle:
          "Mostra uno sfondo dietro i gruppi di chiamate in modalità feed strumenti.",
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
            jumpToBottomTitle: "Vai in fondo",
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
            "Controlla come si formano i gruppi di chiamate strumento dentro i turni.",
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
          toolCallsStrategyTitle: "Strategia raggruppamento chiamate",
          toolCallsStrategy: {
            consecutiveTitle: "Strumenti consecutivi (predefinito)",
            consecutiveSubtitle:
              "Raggruppa solo chiamate strumento consecutive in chiamate strumento.",
            allToolsTitle: "Tutti gli strumenti nel turno",
            allToolsSubtitle:
              "Raggruppa tutte le chiamate strumento del turno in una sola sezione chiamate strumento.",
          },
            toolCallsCollapsedPreviewCountTitle: "Anteprima (compresso)",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Mostra gli ultimi ${value} strumenti quando Chiamate strumento è compresso.`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "Disattivato",
              offSubtitle: "Mostra solo l'intestazione di chiamate strumento.",
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
      handoff: settingsSessionHandoffTranslationExtensions.it,
      defaultPermissions: {
        title: "Permessi predefiniti",
        footer:
          "Si applica quando avvii una nuova sessione. I profili possono sovrascriverlo facoltativamente.",
        applyPermissionChangesTitle: "Applica cambiamenti permessi",
        applyPermissionChangesImmediateSubtitle:
          "Applica subito alle sessioni in esecuzione (aggiorna i metadati della sessione).",
        applyPermissionChangesNextPromptSubtitle: "Applica solo al prossimo messaggio.",
      },
          defaultStorage: {
              title: "Archiviazione predefinita della sessione",
              footer: "Scegli se le nuove sessioni iniziano come sessioni Happier sincronizzate o come sessioni dirette supportate dal provider.",
              globalTitle: "Predefinito globale",
              persistedSubtitle: "Salva le nuove sessioni in Happier e sincronizzale tra i dispositivi per impostazione predefinita.",
              directSubtitle: "Avvia sessioni dirette legate alla macchina quando il provider lo supporta.",
              globalSubtitle: ({ label }: { label: string }) => `Predefinito globale: ${label}`,
              useGlobalDefault: "Usa predefinito globale",
              currently: ({ label }: { label: string }) => `Attualmente: ${label}`,
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
        summaryRunner: {
          title: "Generatore di riepiloghi (su richiesta)",
          backendTitle: "Motore",
          backendPlaceholder: "claude (es.)",
          searchBackendsPlaceholder: "Cerca backend…",
          modelTitle: "Modello (LLM)",
          modelPlaceholder: "default (es.)",
          searchModelsPlaceholder: "Cerca modelli…",
          notSet: "Non impostato",
          customTitle: "Personalizzato",
          customBackendIdSubtitle: "Inserisci un id backend (es. claude).",
          customModelIdSubtitle: "Inserisci un id modello (es. default).",
        },
        recentMessagesTitle: "Messaggi recenti da includere",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Limite seed (caratteri)",
        maxSeedCharsPlaceholder: "50000",
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
          styleDefaultSubtitle: "Schede: Riepilogo. Feed strumenti: Compatto.",
          expandedStyleDefaultTitle: "Predefinito (consigliato)",
          expandedStyleDefaultSubtitle: "Schede: Completo. Feed strumenti: Riepilogo.",
      },
      terminalConnect: {
        title: "Connessione terminale",
        legacySecretExportTitle: "Esportazione segreto legacy (compatibilità)",
        legacySecretExportEnabledSubtitle:
          "Abilitato: esporta il segreto legacy del tuo account nel terminale così i terminali più vecchi possono connettersi. Non consigliato.",
        legacySecretExportDisabledSubtitle:
          "Disabilitato (consigliato): effettua il provisioning dei terminali solo con la chiave contenuto (Terminal Connect V2).",
      },
  },
  windowsRemoteSessionLaunchMode: {
    hidden: "Nascosta",
    shortHidden: "Nascosta",
    hiddenSubtitle: "Avvia la sessione in background senza aprire una finestra del terminale.",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "Apri la sessione in una finestra dedicata di Windows Terminal.",
    console: "Console",
    shortConsole: "Console",
    consoleSubtitle: "Apri la sessione in una finestra standard della console di Windows.",
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
	        actions: {
	          createNew: "Crea nuovo",
	          updateExisting: "Aggiorna esistente",
	        },
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
        "Apri ElevenLabs → Developers → API Keys → Create API key → copia la chiave.",
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
        machineRecovery: {
          switchTitle: "Macchina vocale non disponibile",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `La macchina vocale corrente (${currentMachine}) non è disponibile.\n\nSpostare la voce su ${nextMachine}?`,
          switchAction: "Cambia macchina",
          replayTitle: "Portare la conversazione?",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `Puoi ripartire da zero su ${nextMachine}, oppure cambiare macchina e riprodurre il contesto vocale recente dalla macchina precedente.`,
          replayAction: "Cambia e riproduci il contesto vocale recente",
          startFreshAction: "Inizia da zero",
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
          enableSubtitle:
            "Trasmetti il testo parziale dell’agente mentre viene generato (usato per l’audio in streaming).",
          enableTtsTitle: "Abilita streaming TTS",
          enableTtsSubtitle:
            "Riproduci la risposta mentre è in streaming (richiede lo streaming).",
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
        "Test TTS non riuscito. Controlla URL base, chiave API, modello e voce.",
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
      `Questa connessione è per ${serverUrl}. Vuoi cambiare server e continuare?`,
  },

  terminalEmbedded: {
    dockMenuA11y: "Aggancia terminale",
    settings: {
      locationTitle: "Posizione del terminale incorporato",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "Invio",
    },
    location: {
      sidebar: "Barra laterale",
      details: "Pannello dettagli",
      bottom: "Pannello inferiore",
    },
    errors: {
      missingMachineTarget: "Questa sessione non ha una macchina di destinazione.",
      rpcTargetUnavailable: "RPC della macchina non disponibile per questa macchina.",
      machineUnreachable: "La macchina non è raggiungibile.",
      disabled: "Il supporto terminale è disabilitato nella configurazione del daemon. Abilitalo e riavvia il daemon.",
      notFound: "Sessione terminale non trovata. Prova a riavviare.",
      cwdDenied: "Il daemon non ha il permesso di usare questa directory di lavoro.",
      spawnFailed: "Impossibile avviare il processo del terminale.",
      invalidRequest: "Richiesta terminale non valida.",
      busy: "Il terminale è occupato. Riprova.",
    },
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
      "Crittografia end-to-end predefinita, con ripristino dell'account sugli altri tuoi dispositivi.",
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
	    failedToCopyToClipboard: "Impossibile copiare negli appunti",
	  },

     machine: {
    launchNewSessionInDirectory: "Avvia nuova sessione nella directory",
    offlineUnableToSpawn: "Avvio disabilitato quando la macchina è offline",
    offlineHelp:
      "• Assicurati che il tuo computer sia online\n• Esegui `happier daemon status` per diagnosticare\n• Stai usando l'ultima versione della CLI? Esegui `happier self update`",
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
    detectedCliDetected: "Rilevata",
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
      remoteSessionModeTitle: "Modalità sessione remota",
      remoteSessionModeOverrideTitle: "Sostituisci la modalità globale delle sessioni Windows",
      remoteSessionModeOverrideEnabledSubtitle:
        "Questa macchina usa la propria modalità di sessione remota Windows.",
      remoteSessionModeOverrideDisabledSubtitle:
        "Questa macchina segue la tua modalità globale di sessione remota Windows.",
      windowsTerminalUnavailableSuffix: "Windows Terminal non è rilevato su questa macchina.",
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
    sessionRunningLocallyAndRemotely:
      "Questa sessione è collegata localmente in OpenCode ed è ancora controllabile dall’app.",
    switchingToRemote: "Passaggio alla modalità remota…",
    switchToLocal: "Passa a locale",
    switchToRemote: "Passa a remoto",
    detachLocalTerminal: "Scollega terminale",
    directSessionTakeoverAvailable:
      "Questa sessione diretta è disponibile sulla tua macchina. Prendila in carico in Happier per controllarla qui.",
    directSessionMachineOffline:
      "Questa sessione diretta non è attualmente disponibile perché la macchina è offline.",
    switchingToDirectTakeover: "Presa in carico di questa sessione diretta…",
    switchingToPersistedTakeover: "Presa in carico e sincronizzazione di questa sessione…",
    takeOverDirect: "Prendi in carico",
    takeOverPersist: "Prendi in carico + Sincronizza",
    directTakeoverDialogTitle: "Continuare questa sessione diretta in Happier?",
    directTakeoverDialogBody: "Scegli come vuoi che Happier prenda il controllo. Diretto continua a usare la trascrizione del provider. Sincronizza importa la trascrizione in Happier.",
    directTakeoverDialogDirectTitle: "Prendi in carico",
    directTakeoverDialogDirectBody: "Controlla questa sessione in Happier senza sincronizzare la trascrizione dentro Happier.",
    directTakeoverDialogPersistTitle: "Prendi in carico + Sincronizza",
    directTakeoverDialogPersistBody: "Importa la trascrizione in Happier e continua con tutte le funzioni di una sessione sincronizzata.",
    directTakeoverDialogForceStopTitle: "Provare prima a fermare il processo locale",
    directTakeoverDialogForceStopBody: "Happier ha trovato un processo locale attendibile per questa sessione. Attivalo se vuoi che Happier lo fermi prima di prendere il controllo.",
    directTakeoverForceStopConfirmTitle: "Fermare prima il processo locale?",
    directTakeoverForceStopConfirmBody: "Happier ha trovato un processo locale attendibile per questa sessione diretta. Fermarlo prima di prendere il controllo qui?",
    directTakeoverForceStopConfirmAction: "Ferma e prendi in carico",
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
    emptyTitle: "Nessuna attività degli amici",
    emptyDescription: "Aggiungi amici per condividere sessioni e vedere l’attività qui.",
    activity: "Attività",
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
