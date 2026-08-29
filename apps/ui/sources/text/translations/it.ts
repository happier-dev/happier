import { settingsProvidersTranslations } from './settingsProvidersTranslations';
import { providerSessionTranslations } from './providerSessionTranslations';
import { externalSessionOperationTranslations } from './externalSessionOperationTranslations';
import { externalSessionSettingsTranslations } from './externalSessionSettingsTranslations';
import { pluginPermissionTranslations } from './pluginPermissionTranslations';
import { sessionRemotePermissionGrantTranslations } from './sessionRemotePermissionGrantTranslations';
import { voiceReadinessTranslations } from './voiceReadinessTranslations';
import { voiceDiagnosticsTranslations } from './voiceDiagnosticsTranslations';
import { voiceProviderPrivacyTranslations } from './voiceProviderPrivacyTranslations';
import { voiceRealtimeProviderSetupTranslations } from './voiceRealtimeProviderSetupTranslations';
import { voiceExternalCredentialApprovalTranslations } from './voiceExternalCredentialApprovalTranslations';
import { voiceLocalCredentialTranslations } from './voiceLocalCredentialTranslations';
import { pluginWebhookAdministrationTranslations } from './pluginWebhookAdministrationTranslations';
import { pluginAccountDataEraseTranslations } from './pluginAccountDataEraseTranslations';
import { apiTokenSettingsTranslations } from './apiTokenSettingsTranslations';
import { pluginAccountReleaseSelectionTranslations } from './pluginAccountReleaseSelectionTranslations';
import { pluginMachineMatrixTranslations } from './pluginMachineMatrixTranslations';
import { pluginInvocationLogTranslations } from './pluginInvocationLogTranslations';
import { eventAutomationComposerTranslations } from './eventAutomationComposerTranslations';
import { automationTriggerSetTranslations } from './automationTriggerSetTranslations';
import { actionOperationInboxTranslations } from './actionOperationInboxTranslations';
import { sessionDraftTranslations } from './sessionDraftTranslations';

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
  mcpServersDeliveryShellBridgeSubtitle: 'Questo backend chiama gli strumenti di Happier tramite il bridge happier tools.',
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
  themeProfiles: {
    title: 'Temi',
    editorTitle: 'Profilo del tema',
    activeGroup: 'Tema attivo',
    activeFooter: 'Scegli il tema utilizzato dall\'interfaccia. Gestisci temi personalizzati dalla schermata dei temi.',
    builtInGroup: 'Temi integrati',
    builtInFooter: 'I temi integrati sono di sola lettura. Duplicarne uno per personalizzarlo localmente.',
    customGroup: 'Temi personalizzati',
    customFooter: 'Tocca un tema per attivarlo oppure utilizza le azioni sulle righe per modificarlo, duplicarlo o eliminarlo.',
    defaultTheme: 'Tema predefinito',
    defaultThemeSubtitle: 'Utilizza i colori del tema Happier senza un profilo personalizzato',
    active: 'Attivo',
    customProfileSubtitle: 'Profilo tematico locale personalizzato',
    tapToActivate: 'Tocca per attivare',
    actionsGroup: 'Azioni a tema',
    createProfile: 'Crea tema',
    createProfileSubtitle: 'Inizia da qualsiasi tema integrato o personalizzato',
    importProfile: 'Importa tema',
    importProfileSubtitle: 'Incolla JSON o scegli un file di profilo del tema Happier',
    exportProfile: 'Tema di esportazione',
    exportProfileSubtitle: 'Esporta questo tema come JSON',
    presetsGroup: 'Preimpostazioni integrate',
    presetsFooter: 'I profili incorporati sono di sola lettura. Clonarne uno per personalizzarlo.',
    presets: {
      premiumDark: 'Crisp Dark',
      pitchDark: 'Pitch Dark',
      sunsetDark: 'Sunset Dark',
      nightDark: 'Night Dark',
      classicDark: 'Classic Dark',
      graphiteDark: 'Graphite Dark',
      tokyoNight: 'Tokyo Night',
      premiumLight: 'Crisp Light',
      paperLight: 'Paper Light',
      catppuccinMocha: 'Catppuccin Mocha',
      catppuccinMacchiato: 'Catppuccin Macchiato',
      catppuccinFrappe: 'Catppuccin Frappé',
      oneDarkPro: 'One Dark Pro',
      monokaiPro: 'Monokai Pro',
      githubDark: 'GitHub Dark',
      darkModern: 'Dark Modern',
      catppuccinLatte: 'Catppuccin Latte',
      githubLight: 'GitHub Light',
    },
    readOnlyPreset: 'Preimpostazione di sola lettura',
    clonePreset: 'Preimpostazione clone',
    cloneProfile: 'Profilo clone',
    duplicateTheme: 'Tema duplicato',
    editProfile: 'Modifica profilo',
    newProfileName: ({ count }: { count: number }) => `Tema personalizzato ${count}`,
    cloneName: ({ name }: { name: string }) => `Copia di ${name}`,
    detailsGroup: 'Dettagli',
    presetGroup: 'Preimpostato',
    presetSource: 'Preimpostato',
    presetSourceSubtitle: 'Scegli un tema da utilizzare come punto di partenza',
    assetAppearance: 'Aspetto delle risorse',
    assetAppearanceSubtitle: 'Scegli se questo tema utilizza risorse app chiare o scure.',
    replacePresetTitle: 'Sostituire i colori attuali?',
    replacePresetSubtitle: 'La modifica della preimpostazione sostituirà i colori della bozza corrente. Le modifiche ai colori non salvate verranno scartate.',
    profileName: 'Nome del profilo',
    editorModeGroup: 'Modalità tema',
    editorModeFooter: 'Questo tema modifica la modalità colore selezionata dal suo preset.',
    editorMode: 'Variante',
    lightMode: 'Luce',
    darkMode: 'Buio',
    previewTitle: 'Anteprima del tema',
    previewSubtitle: 'Un\'anteprima sandbox locale di superfici, testo, controlli, stato e colori della sintassi.',
    previewButton: 'Azione primaria',
    previewStatus: 'Pronto',
    previewCode: 'const theme = "happier";',
    colorInputPlaceholder: '#RRGGBB, rgba(...), transparent',
    tokenSubtitle: 'Sostituzione del token colore pubblico',
    recentColors: 'Colori recenti',
    colorPickerFallback: 'Inserisci un valore di colore o riutilizza un colore recente.',
    invalidColor: 'Use hex, rgb(...), rgba(...), or transparent.',
    invalidProfileName: 'Nome del profilo non valido.',
    profileLimitReached: 'Limite di temi raggiunto.',
    contrastWarning: 'Basso contrasto per questa coppia di token. Puoi ancora salvare o reimpostare.',
    resetToken: 'Reimposta gettone',
    resetGroup: 'Reimposta e disattiva',
    resetMode: 'Ripristina i colori del tema',
    deactivateProfile: 'Utilizza il tema predefinito',
    deactivateProfileSubtitle: 'Disattiva il profilo personalizzato e mantienilo salvato',
    deleteProfile: 'Elimina profilo',
    deleteProfileSubtitle: 'Rimuovi questo profilo del tema personalizzato locale',
    saveAndActivate: 'Salva e attiva',
    missingProfile: 'Profilo del tema non trovato',
    importFooter: ({ formats }: { formats: string }) => `Formati supportati: ${formats}. I token sconosciuti vengono segnalati come avvisi.`,
    importJson: 'Tema JSON',
    importJsonPlaceholder: "Incolla qui il JSON del tuo tema",
    importFile: 'Scegli file',
    importWarnings: ({ count }: { count: number }) => `Sono stati trovati ${count} avvisi durante l'importazione.`,
    importErrors: {
      invalidJson: 'Il testo incollato non è valido JSON.',
      unsupportedSchema: 'Questa versione del profilo del tema non è supportata.',
      invalidProfile: 'Non è stato possibile importare questo profilo del tema.',
      tooLarge: 'Questo profilo del tema JSON è troppo grande.',
    },
    exportFooter: 'JSON esportato include tutti i valori dei token colore pubblici per questo tema.',
    exportJson: 'Esporta JSON',
    copyExportJson: 'Copia JSON',
    downloadExportJson: 'Scarica JSON',
    noProfiles: 'Nessun tema personalizzato ancora',
    groups: {
      background: 'Sfondo',
      surface: 'Superfici',
      border: 'Confini',
      effect: 'Effetti',
      chrome: 'Cromo',
      text: 'Testo',
      state: 'Stato',
      control: 'Controlli',
      composer: 'Compositore',
      message: 'Messaggi',
      syntax: 'Sintassi',
      versionControl: 'Controllo della versione',
      diff: 'Diff',
      permission: 'Autorizzazioni',
      overlay: 'Sovrapposizioni',
    },
  },
  sessionListDensity: {
    title: 'Densità elenco sessioni',
    subtitle: 'Scegli come visualizzare le sessioni nella barra laterale',
    detailed: 'Dettagliata',
    detailedDescription: 'Righe a dimensione completa con avatar e stato',
    cozy: 'Intermedia',
    cozyDescription: 'Righe più piccole con avatar',
    narrow: 'Stretta',
    narrowDescription: 'Righe strette con micro-avatar',
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
      convertToPersistedTitle: 'Converti in Happier',
      convertToPersistedSubtitle: 'Importa la trascrizione e continua come sessione Happier.',
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
export const it = {
    ...sessionDraftTranslations,
    transferRecovery: {
        title: 'Completa il caricamento preparato',
        message: 'Il caricamento ha raggiunto la macchina, ma il salvataggio finale richiede attenzione. Riprova solo la finalizzazione oppure elimina il caricamento preparato.',
        retryFinalization: 'Riprova finalizzazione',
        discardStagedUpload: 'Elimina caricamento preparato',
        discarded: 'Il caricamento preparato è stato eliminato.',
        unavailable: 'Questo caricamento preparato non è più disponibile.',
    },
    voice: voiceReadinessTranslations.it,
    pluginPermissions: pluginPermissionTranslations.it,
    sessionRemotePermissionGrants: sessionRemotePermissionGrantTranslations.it,
    pluginSurfaces: {
        state: {
            loading: { title: 'Caricamento del contenuto del plugin', reason: 'Viene mostrato il contenuto disponibile mentre Happier carica l’ultimo aggiornamento.' },
            refreshing: { title: 'Aggiornamento del contenuto del plugin', reason: 'Viene mostrato l’ultimo contenuto disponibile mentre Happier verifica la presenza di aggiornamenti.' },
            stale: { title: 'Il contenuto del plugin potrebbe non essere aggiornato', reason: 'Viene mostrato l’ultimo contenuto disponibile. Riprova per verificare la presenza di aggiornamenti.' },
            offline: { title: 'Il contenuto del plugin è offline', reason: 'Viene mostrato l’ultimo contenuto disponibile in sola lettura fino alla riconnessione.' },
        },
        offlineSnapshot: {
            accessibilityLabel: ({ title }: { title: string }) =>
                `Snapshot offline di ${title}. Il contenuto è in sola lettura fino alla riconnessione.`,
        },
        hostRenderer: {
            descriptorPanel: {
                accessibilityLabel: 'Pannello del plugin',
                untitled: 'Pannello del plugin',
            },
        },
        appPage: {
            title: 'Pagine dei plugin',
            subtitle: 'Destinazioni a pagina intera fornite dai plugin installati.',
            empty: 'Nessuna pagina di plugin disponibile.',
            unknown: 'Questa pagina del plugin non è disponibile. Il plugin potrebbe essere in caricamento, disattivato o disinstallato.',
        },
        appScopeRightSidebar: {
            empty: "Nessuna scheda plugin dell'app disponibile.",
        },
    },
    settingsKeyboard: {
        title: 'Scorciatoie da tastiera',
        entrySubtitle: 'Scopri e controlla le scorciatoie delle app',
        generalGroupTitle: 'Controlli da tastiera',
        generalGroupFooter: 'Le preferenze di scelta rapida vengono archiviate localmente su questo dispositivo.',
        enableShortcutsTitle: 'Abilita scorciatoie unificate',
        enableShortcutsSubtitle: 'Utilizza il nuovo registro dei comandi da tastiera per le scorciatoie delle app.',
        singleKeyTitle: 'Scorciatoie a tasto singolo',
        singleKeySubtitle: 'Consenti scorciatoie come ? quando l\'immissione del testo non è focalizzata.',
        conflictsTitle: ({ count }: { count: number }) => `${count} shortcut conflict${count === 1 ? '' : 's'} detected`,
        conflictsSubtitle: ({ count }: { count: number }) => `${count} command${count === 1 ? '' : 's'} need review before all shortcuts can be active.`,
        conflictsGroupTitle: 'Diagnostica',
        commandsGroupTitle: 'Comandi',
        commandsGroupFooter: 'Le impostazioni predefinite vengono visualizzate dal registro dei collegamenti. Imposta una scorciatoia personalizzata, disabilita un comando o reimpostalo per ripristinare l\'associazione predefinita.',
        noDefaultShortcut: 'Nessuna scorciatoia predefinita',
        setCommandButton: 'Impostato',
        setCommandAccessibility: ({ command }: { command: string }) => `Set ${command} shortcut`,
        setShortcutPromptTitle: ({ command }: { command: string }) => `Set shortcut for ${command}`,
        setShortcutPromptMessage: 'Inserisci una scorciatoia come Alt+K, Alt+Freccia giù, Mod+Invio o ?.',
        setShortcutPromptPlaceholder: 'Alt+K',
        setShortcutInvalidTitle: 'Scorciatoia non valida',
        setShortcutInvalidMessage: 'Inserisci almeno un tasto non modificatore, facoltativamente con Mod, Ctrl, Maiusc o Alt.',
        resetCommandAccessibility: ({ command }: { command: string }) => `Reset ${command} shortcut`,
        commands: {
            composerAbortConfirm: 'Conferma interruzione',
            composerFocus: 'Metti a fuoco il compositore',
            composerSendImmediate: 'Invia subito',
            composerSendPending: 'Invia alla coda in sospeso',
            commandPaletteOpen: 'Apri palette comandi',
            browserAddressFocus: 'Attiva la barra degli indirizzi del browser',
            browserBack: 'Indietro nel browser',
            browserForward: 'Avanti nel browser',
            browserReload: 'Ricarica la pagina del browser',
            modeCycle: 'Cambia modalità',
            shortcutsHelpOpen: 'Apri guida scorciatoie',
            sessionNew: 'Crea nuova sessione',
            sessionMruNext: 'Sessione recente successiva',
            sessionMruPrevious: 'Sessione recente precedente',
            sessionVisibleNext: 'Sessione visibile successiva',
            sessionVisiblePrevious: 'Sessione visibile precedente',
            sessionsRowMoveUp: 'Sposta la riga selezionata verso l\'alto',
            sessionsRowMoveDown: 'Sposta la riga selezionata verso il basso',
            sessionsRowMoveToFolder: 'Sposta la riga selezionata nella cartella',
            sessionsRowMoveToWorkspaceRoot: 'Sposta la riga selezionata nella radice dell\'area di lavoro',
            sessionsSelectionToggleFocused: 'Seleziona una sessione mirata',
            sessionsSelectionExtendUp: 'Estendi la selezione della sessione',
            sessionsSelectionExtendDown: 'Estendi la selezione della sessione verso il basso',
            sessionsSelectionSelectAll: 'Seleziona tutte le sessioni visibili',
            sessionsSelectionClear: 'Cancella la selezione della sessione',
            settingsOpen: 'Apri impostazioni',
            transcriptSelectionCancel: 'Annulla la selezione della trascrizione',
            transcriptSelectionCopy: 'Copia i messaggi di trascrizione selezionati',
            transcriptSelectionSelectAll: 'Seleziona tutti i messaggi di trascrizione',
            transcriptSelectionSendToSession: 'Invia i messaggi di trascrizione selezionati alla sessione',
            transcriptScrollBottom: 'Vai alla fine della trascrizione',
            transcriptScrollPageDown: 'Scorri trascrizione giù di una pagina',
            transcriptScrollPageUp: 'Scorri trascrizione su di una pagina',
            transcriptScrollTop: 'Vai all’inizio della trascrizione',

            permissionCycle: "Modalità di autorizzazione del ciclo",
            splitCanvasCloseLeaf: "Chiudi divisione",
            splitCanvasFocusDown: "Focus suddiviso di seguito",
            splitCanvasFocusLeft: "Focalizza il riquadro a sinistra",
            splitCanvasFocusRight: "Focalizza il riquadro a destra",
            splitCanvasFocusUp: "Focalizza il riquadro sopra",
            splitCanvasRestoreMaximize: "Ripristina riquadro massimizzato",
            splitCanvasSplitDown: "Dividi verso il basso",
            splitCanvasSplitRight: "Dividi verso destra",
            splitCanvasToggleMaximize: "Attiva/disattiva massimizzazione riquadro",
            transcriptMessageNext: "Messaggio successivo",
            transcriptMessagePrevious: "Messaggio precedente",},
    },

  tabs: {
    // Tab navigation labels
    inbox: "Posta",
    friends: "Amici",
    sessions: "Sessioni",
    settings: "Impostazioni",

    projects: "Progetti",},

  transcript: {


    unsupportedContent: {

      unparsedUserMessage: 'Messaggio utente non analizzato',

      unparsedAgentMessage: 'Messaggio assistente non analizzato',

      unsupportedAgentOutput: 'Output non supportato',

      unsupportedTranscriptRecord: 'Record non supportato',

    },

    selection: {

      enterA11y: 'Entra in modalità selezione',

      exitA11y: 'Esci dalla modalità selezione',

      rowA11y: ({ role, preview }: { role: string; preview: string }) => `${role}: ${preview}`,

      selectedCount: ({ count }: { count: number }) => count === 1 ? '1 message selected' : `${count} messages selected`,

      selectAll: 'Seleziona tutto',

      deselectAll: 'Deseleziona tutto',

      cancel: 'Annulla',

      copy: 'Copia',

      copyA11y: ({ count }: { count: number }) => count === 1 ? 'Copy 1 message' : `Copy ${count} messages`,

      send: 'Invia',

      sendA11y: ({ count }: { count: number }) => count === 1 ? 'Send 1 message to another session' : `Send ${count} messages to another session`,

      copySuccess: 'Copiato',

      copyFailed: 'Copia non riuscita',

      sendTo: {

        modalTitle: 'Invia alla sessione',

        modalSubtitle: 'Aggiungi i messaggi selezionati alla bozza di un’altra sessione',

        newSession: 'Nuova sessione',

        newSessionSubtitle: 'Aggiungi alla bozza della nuova sessione',

        searchPlaceholder: 'Search sessions...',

        noResults: 'Nessuna sessione corrispondente',

        currentExcluded: 'La sessione corrente non è mostrata',

        preview: 'Anteprima',

        previewNote: 'Questo apparirà nel compositore di destinazione',

        addNote: 'Aggiungi una nota (facoltativo)',

        addNotePlaceholder: 'Type a note to prepend...',

        send: 'Invia',

        cancel: 'Annulla',

        sendFailed: 'Invio non riuscito',

        sendSuccessNavigating: 'Inviato — apertura sessione',

      },

    },

    progress: {

      catchingUp: 'Aggiornamento in corso…',

    },

  },


  inbox: {
        ...actionOperationInboxTranslations,
    openSession: ({ session }: { session: string }) => `Apri sessione: ${session}`,
    // Inbox screen
    emptyTitle: "Sei aggiornato",
    emptyDescription: "Nessuna richiesta o aggiornamento in sospeso al momento.",
    approvals: "Approvazioni",
    permissions: "Permessi",
    unreadSessions: "Sessioni non lette",
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
    proposedComments: ({ count }: { count: number }) => `${count} ${count === 1 ? "commento proposto" : "commenti proposti"}`,
    generation: ({ generation }: { generation: string }) => `Generazione: ${generation}`,
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
    templateBehaviorInsertOnSend: "Inserisci all'invio",
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
    ...automationTriggerSetTranslations.it,
    unsupportedReference: ({ reference }: { reference: string }) =>
        `Le automazioni salvano solo il testo del messaggio, quindi ${reference} non punterebbe più a ciò che hai scelto. Rimuovilo dal messaggio oppure menziona un percorso di file.`,
    list: {
      interval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Ogni ${minutes} min${timezone ? ` (${timezone})` : ""}`,
      cron: ({ expression, timezone }: { expression: string | null; timezone: string | null }) => `Cron${expression ? `: ${expression}` : ""}${timezone ? ` (${timezone})` : ""}`,
      schedule: "Pianificazione",
      event: ({ eventId }: { eventId: string }) => `Evento: ${eventId}`,
      sessionLifecycleParentTurn: ({ sessionId }: { sessionId: string }) => `Al termine di un turno · ${sessionId}`,
      noAutomaticTriggers: 'Nessun trigger automatico',
      moreTriggers: ({ count }: { count: number }) => `+${count} altri`,
      noNextRun: "Nessuna prossima esecuzione",
      nextRun: ({ time }: { time: string }) => `Prossima: ${time}`,
      nextRunPending: "Prossima esecuzione in attesa",
    },
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
      trigger: {
        target: 'OBIETTIVO DI ESECUZIONE',
        targetNewSession: 'Nuova sessione',
        targetExistingSession: 'Sessione esistente',
        targetExecutionRun: 'Esecuzione singola',
        chooseExistingSession: 'Scegli una sessione',
        searchEvents: 'Cerca eventi',
        executionNoTools: 'Senza strumenti',
        executionReadOnly: 'Sola lettura',
      },
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
        name: "Riassumi l’attività recente",
        description: "Note personali",
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
        "Aggiungi un'automazione per eseguire attività in questa sessione quando si attiva uno dei suoi trigger.",
      addAutomation: "Aggiungi automazione",
      failedToLoad: "Impossibile caricare le automazioni.",
    },
    screen: {
      emptyTitle: "Ancora nessuna automazione",
      emptyBody:
        "Creane una da Nuova sessione, poi aggiungi pianificazioni, eventi o trigger di turno esatti.",
      createAutomationA11y: "Crea automazione",
    },
    settings: {
      title: "Impostazioni delle automazioni",
      openSubtitle: "Configura la capacità e la conservazione della cronologia delle esecuzioni.",
      failedToLoad: "Impossibile caricare le impostazioni delle automazioni.",
      updateFailed: "Impossibile aggiornare le impostazioni delle automazioni.",
      maxActiveRunsPerMachine: "Numero massimo di esecuzioni attive per macchina",
      maxActiveRunsPerMachineSubtitle: "Limita quante esecuzioni ogni macchina può acquisire attivamente contemporaneamente.",
      maxActiveRunsPerMachinePrompt: "Inserisci un numero intero da 1 a 2.147.483.647.",
      maxActiveRunsPerMachineInvalid: "Inserisci un numero intero da 1 a 2.147.483.647.",
      runRetention: "Conserva per sempre la cronologia delle esecuzioni",
      runRetentionSubtitle: "Quando è disattivata, le esecuzioni completate idonee vengono conservate per 30 giorni.",
    },
    detail: {
      invalidId: "ID automazione non valido.",
      notFound: "Automazione non trovata.",
      unknownDate: "Sconosciuto",
      notScheduled: "Non pianificata",
      overviewGroupTitle: "Panoramica",
      overview: {
        nameTitle: "Nome",
        triggersTitle: "Pianificazione",
        statusTitle: "Stato",
        nextRunTitle: "Prossima esecuzione",
      },
      status: {
        active: "Attiva",
        paused: "In pausa",
      },
      event: {
        watcherTitle: "Osservatore degli eventi",
        watcherUnwatched: "Nessun osservatore",
        endpointTitle: "Endpoint webhook",
        observationPlacementTitle: "Posizione di osservazione degli eventi",
        endpointObservingSince: ({ time }: { time: string }) => `Riceve consegne da ${time}`,
        transportTitle: "How events arrive",
        transportCheckpointedPull: "Polling",
        transportDurablePush: "Webhook",
        disclosureCheckpointedPull: "The source is checked from its saved checkpoint. Delayed or unavailable sources may report gaps.",
        disclosureDurablePush: "Webhook delivery is best effort before the provider durably commits the event. Use polling when gap detection matters.",
        sourceStatusUnreported: "In attesa del primo rapporto",
        sourceStatusUnavailable: "Stato della sorgente non disponibile",
        sourceCatalogStatusUnavailable: "Attualità della sorgente non disponibile",
        watcherMachineUnknown: "Questa macchina non è più nel tuo account, quindi questo osservatore non può osservare eventi.",
        watcherMachineRevoked: "Questa macchina è stata revocata, quindi questo osservatore non può osservare eventi.",
        watcherMachineReplaced: "Questa macchina è stata sostituita, quindi questo osservatore non può osservare eventi.",
        watcherInstallationReplaced: "Questa macchina è stata reinstallata, quindi questo osservatore non potrà osservare eventi finché non verrà riconfigurato.",
        watcherMachineOffline: "Questa macchina è offline, quindi questo osservatore al momento non sta osservando eventi.",
      },
      actionsGroupTitle: "Azioni",
      runNowTitle: "Esegui ora",
      pauseAutomation: "Metti in pausa l'automazione",
      resumeAutomation: "Riprendi automazione",
      editAutomation: "Modifica automazione",
      deleteAutomation: "Elimina automazione",
      deleteConfirmTitle: "Elimina automazione",
      deleteConfirmMessage:
        "Questa automazione e la sua pianificazione verranno rimosse.",
      deleteConfirmButton: "Elimina",
      clearHistory: "Cancella la cronologia delle esecuzioni",
      clearHistorySubtitle: "Rimuove le esecuzioni completate che possono essere eliminate. Le esecuzioni attive restano disponibili.",
      clearHistoryConfirmTitle: "Cancellare la cronologia delle esecuzioni?",
      clearHistoryConfirmMessage: "Le esecuzioni completate idonee verranno rimosse definitivamente. Le esecuzioni attive resteranno disponibili.",
      clearHistoryConfirmButton: "Cancella cronologia",
      clearHistoryFailed: "Impossibile cancellare la cronologia delle esecuzioni.",
      machineAssignmentsTitle: "Assegnazioni macchina",
      machineAssignmentsFooter:
        "Abilita almeno una macchina perché questa automazione possa essere eseguita.",
      refreshFailed: "Impossibile aggiornare l'automazione.",
      runFailed: "Impossibile eseguire l'automazione.",
      deleteFailed: "Impossibile eliminare l'automazione.",
      assignmentsUpdateFailed:
        "Impossibile aggiornare le assegnazioni macchina.",
      recentRunsTitle: "Esecuzioni recenti",
      loadMoreRuns: "Carica altre esecuzioni",
      trigger: {
          identity: ({ id, revision }: { id: string; revision: number }) => `Trigger ${id} · revisione ${revision}`,
          sourceSession: 'Sessione di origine',
          sourceTurn: 'Turno di origine esatto',
          run: "Esecuzione associata",
          status: {
            waiting: "In attesa di questo turno",
            paused: "In pausa",
            triggered: "Attivata",
            running: "In esecuzione",
            finished: "Completata",
            sourceFailed: "Il turno di origine non è riuscito",
            sourceCancelled: "Il turno di origine è stato annullato",
            sourceUnavailable: "Origine non disponibile",
          },
      },
      runMeta: {
        triggerIdentityTitle: 'Identità del trigger',
        triggerIdentity: ({ id, revision }: { id: string; revision: number }) => `${id} · revisione ${revision}`,
        triggerRetired: 'Trigger ritirato',
        triggerRetiredSubtitle: 'Questa esecuzione conserva la propria causa immutabile anche se il trigger non fa più parte dell’automazione.',
        causeTitle: "Origine",
        cause: {
          schedule: "Pianificata",
          manual: "Manuale",
          pluginEvent: "Evento",
          sessionLifecycle: 'Turno della sessione completato',
          conversation: "Conversazione",
        },
        state: {
          queued: "In coda",
          claimed: "Assegnata",
          running: "In corso",
          succeeded: "Riuscita",
          failed: "Non riuscita",
          cancelled: "Annullata",
          expired: "Scaduta",
          dispatch_failed: "Invio non riuscito",
          skipped: "Saltata",
          missed: "Persa",
          outcome_uncertain: "Esito incerto",
        },
        occurred: ({ time }: { time: string }) => `Avvenuta: ${time}`,
        invoked: ({ time }: { time: string }) => `Invocata: ${time}`,
        admitted: ({ time }: { time: string }) => `Ammessa: ${time}`,
        occurrenceTitle: "Occorrenza",
        sourceTitle: "Sorgente di osservazione",
        eventReferenceTitle: "Riferimento evento",
                scheduled: ({ time }: { time: string }) => `Pianificata: ${time}`,
                updated: ({ time }: { time: string }) => `Aggiornata: ${time}`,
                error: ({ message }: { message: string }) => `Errore: ${message}`,
        attemptTitle: "Tentativo",
        attempt: ({ attempt }: { attempt: number }) => `Tentativo ${attempt}`,
        claimedByTitle: "Preso in carico da",
        claimedAt: ({ time }: { time: string }) => `Preso in carico: ${time}`,
        leaseExpires: ({ time }: { time: string }) => `La presa in carico scade: ${time}`,
        dispatchTitle: "Dispatch di esecuzione",
        dispatchAttempt: ({ attempt }: { attempt: number }) => `Tentativo di dispatch ${attempt}`,
        dispatchState: {
            notStarted: "Non avviato",
            dispatchPermitted: "Dispatch consentito",
            retryWaiting: "In attesa di riprovare",
            started: "Avviato",
            settled: "Concluso",
            outcomeUnknown: "Esito sconosciuto",
        },
        replyHandoffTitle: "Consegna della risposta",
        replyHandoffAttempt: ({ attempt }: { attempt: number }) => `Tentativo di consegna ${attempt}`,
        replyHandoffDue: ({ time }: { time: string }) => `Prossimo tentativo di consegna: ${time}`,
        replyHandoffState: {
            none: "Nessuna",
            awaitingResult: "In attesa del risultato",
            ready: "Pronta",
            handingOff: "In consegna",
            accepted: "Accettata",
            suppressed: "Soppressa",
            blocked: "Bloccata",
        },
        nativeExecutionTitle: "Esecuzione nativa",
        nativeExecutionCall: ({ callId }: { callId: string }) => `Chiamata ${callId}`,
        nativeExecutionSidechain: ({ sidechainId }: { sidechainId: string }) => `Sidechain ${sidechainId}`,
        historyTitle: "Che cosa è successo",
        historyEvent: {
            run_started: "Avviata",
            run_succeeded: "Riuscita",
            run_failed: "Fallita",
            run_cancelled: "Annullata",
            run_outcome_uncertain: "Esito diventato incerto",
            execution_dispatch_retry_scheduled: "Nuovo tentativo di invio pianificato",
            unknown: "Cambio di ciclo di vita",
        },
        historyReason: {
            cancelled_after_dispatch_permitted: "Annullata dopo che l’esecuzione esterna era già stata autorizzata",
            dispatch_result_missing_after_lease_expiry: "La macchina che l’aveva presa in carico non ha mai riportato l’esito dell’invio",
            automation_retired_after_lease_expiry: "L’automazione è stata ritirata mentre la sua presa in carico scadeva",
        },
      },
      runDetail: {
        title: "Dettagli ammessi",
        recipe: "Ricetta ammessa",
        recipeAbsent: "Non sono stati registrati dettagli privati ammessi.",
        templateVersion: "Versione del modello",
        event: "Evento",
        conversation: "Conversazione",
        sourceInstance: "Istanza dell'origine",
        filter: "Filtro",
        filterMatched: "Corrisponde",
        payload: "Dati",
        input: "Ingresso",
        target: "Destinazione congelata",
        outputCeiling: "Limite di output",
        existingSession: ({ sessionId }: { sessionId: string }) => `Sessione esistente: ${sessionId}`,
        newSession: ({ machineId, directory }: { machineId: string; directory: string }) => `Nuova sessione su ${machineId}: ${directory}`,
        executionRun: ({ permissionMode }: { permissionMode: string }) => `Esecuzione · ${permissionMode}`,
        prompt: "Prompt congelato",
        result: "Risultato finale",
        resultAbsent: "Non è stato registrato alcun risultato finale.",
        failureDetail: "Dettaglio dell'errore",
        failureDetailAbsent: "Non è stato registrato alcun dettaglio privato dell'errore.",
        predecessorSummary: "Esiste un riepilogo del predecessore, ma non è leggibile in questo dettaglio.",
        currentnessUnavailable: "I dettagli privati dell'esecuzione non sono temporaneamente disponibili mentre cambia la cifratura dell'account.",
        materialUnavailable: "Questo dispositivo non dispone della chiave di cifratura corrente dell'account.",
        modeMismatch: "I dettagli privati conservati usano una modalità di cifratura dell'account diversa.",
        contentInvalid: "I dettagli privati conservati non sono validi.",
        invalidTemplate: "Il modello ammesso non è valido. Questa esecuzione non verrà inviata né ritentata.",
        outcomeUnknown: "L'esito dell'invio è sconosciuto. Happier non invierà di nuovo la destinazione congelata.",
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
    destructiveActionHint: "Questa azione è distruttiva e non può essere annullata.",
    cancel: "Annulla",
    decline: "Rifiuta",
    submit: "Invia",
    close: "Chiudi",
    dismissKeyboard: 'Nascondi tastiera',
      open: "Apri",
      done: "Fatto",
      reorder: "Riordina",
      moveUp: "Sposta su",
      moveDown: "Sposta giù",
      authenticate: "Autentica",
      save: "Salva",
		    error: "Errore",
		    success: "Successo",
		    warning: "Avviso",
		    info: "Informazioni",
		    comingSoon: "Prossimamente",
		    ok: "OK",
		    continue: "Continua",
		    back: "Indietro",
        previous: "Precedente",
        next: "Successivo",
	    start: "Avvia",
	    run: "Esegui",
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
    pasteImage: "Incolla immagine",
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
    notProvided: "Non fornito",
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

    more: "Altro",
    skip: "Salta",
    maximize: "Massimizza",
    restore: "Ripristina",
    name: "Nome",
    blocked: "Bloccato",
    active: "Attivo",
    inactive: "Inattivo",
    running: "In esecuzione…",
    login: "Accedi",
    install: "Installa",
    enable: "Abilita",
    disable: "Disabilita",
    tabs: "Schede",
    logs: "Log",
    share: "Condividi",
    unreachable: "Irraggiungibile",},

  ui: {
    resizableDockedPane: {
      resizeA11y: "Ridimensiona pannello",
      resizeHint:
        "Usa le frecce della tastiera o le azioni di regolazione per ridimensionare",
    },
    modalPane: {
      right: "Barra laterale destra",
      details: "Pannello dei dettagli",
      bottom: "Pannello inferiore",
      dismiss: ({ pane }: { pane: string }) => `Chiudi ${pane}`,
    },
    pluginUi: {
      loading: "Caricamento",
      empty: "Nulla da mostrare",
      error: "Qualcosa è andato storto",
      moreActions: "Altre azioni",
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
      launchPlacement: {
          title: 'Dove vengono eseguite le sessioni',
          footer: 'È una preferenza, risolta all’avvio della sessione. Non memorizza mai una macchina come risposta.',
          none: 'Nessuna preferenza',
          automatic: 'Risolvi automaticamente',
          ask: 'Chiedi sempre',
          fixed: 'Sempre questa macchina',
          directory: 'Directory',
          directoryPlaceholder: 'Lascia vuoto per la radice del progetto risolto',
      },
      launchCheckout: {
          title: 'Copia di lavoro',
          footer: 'Come una sessione ottiene la copia di lavoro quando viene eseguita in un progetto.',
          none: 'Nessuna preferenza',
          reuseWorkspace: 'Riusa la copia del progetto',
          createWorktree: 'Crea un worktree',
          ask: 'Chiedi sempre',
      },
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
        instructions: "Esegui claude, poi digita /login per accedere.",
        warning:
          "Nota: impostare ANTHROPIC_AUTH_TOKEN sostituisce il login del CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Esegui codex login per accedere.",
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
      title: "Tipo di sessione predefinito",
      footer:
        "Sovrascrive il tipo di sessione predefinito Happier/diretto a livello account per le nuove sessioni quando questo profilo è selezionato.",
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
      cursorSubtitleExperimental: "CLI di Cursor Agent (sperimentale)",

      ohMyPiSubtitleExperimental: "CLI oh-my-pi (sperimentale)",},
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
    working: "al lavoro...",
    workingRetained: "al lavoro, in attesa di aggiornamenti…",
        backgroundActive: 'in esecuzione in background',
        workingExternally: 'Al lavoro esternamente',
        needsInputExternally: 'Richiede input esterno',
        retryingExternally: 'Nuovo tentativo esterno',
        ready: 'Pronto',
        recentlyActive: 'Attivo di recente',
        externalStatusUnknown: 'Stato esterno sconosciuto',
    readyForReview: "pronto per la revisione",
    keptInAttention: "mantenuta in attenzione",
    canceled: "Annullato",
    offline: "non in linea",
    lastSeen: ({ time }: { time: string }) => `visto l'ultima volta ${time}`,
    actionRequired: "azione richiesta",
    waitingForYourResponse: "In attesa della tua risposta",
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
    nowShort: "ora",
    minutesAgoShort: ({ count }: { count: number }) => `${count}m fa`,
    hoursAgoShort: ({ count }: { count: number }) => `${count}h fa`,
    daysAgoShort: ({ count }: { count: number }) => `${count}g fa`,
  },
  commandMenu: {
    empty: 'Nessun risultato',
  },


  selectionList: {
    emptyMatch: "Nessuna corrispondenza",
    clearInput: "Cancella",
    backTo: ({ label }: { label: string }) => `Torna a ${label}`,
    dynamicSectionError: "Qualcosa è andato storto",
    pathNotFound: "Percorso non trovato",
    backShortcut: "indietro",
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
    secretKeyInputLabel: "Chiave segreta",
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
            "Se la tua macchina non è raggiungibile dalla UI, esegui happier doctor --json sul computer e incollalo qui.",
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
            empty: "La ricerca memoria locale è abilitata, ma non è ancora stato indicizzato contenuto cercabile",
            indexing: "La ricerca memoria locale sta indicizzando contenuti delle trascrizioni",
            waiting: "La ricerca memoria locale è in attesa prima della prossima indicizzazione",
            error: "La ricerca memoria locale richiede attenzione",
            readyLight: "Indice leggero pronto su questa macchina",
            readyDeep: "Indice profondo pronto su questa macchina",
            unavailableLight: "L’indice leggero non è ancora pronto su questa macchina",
            unavailableDeep: "L’indice profondo non è ancora pronto su questa macchina",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Leggero ${lightMb} MB · Profondo ${deepMb} MB`,
            diskUsageFormatted: ({ light, deep }: { light: string; deep: string }) => `Leggero ${light} · Profondo ${deep}`,
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
    indexContents: {
      groupTitle: "Contenuto dell’indice",
      title: "Contenuto cercabile",
      subtitle: ({ sessions, lightShards, deepChunks }: { sessions: number; lightShards: number; deepChunks: number }) =>
        `${sessions} sessioni · ${lightShards} frammenti leggeri · ${deepChunks} chunk profondi`,
    },
    queue: {
      groupTitle: "Recupero storico e coda",
      title: "Coda di indicizzazione",
      subtitle: ({ selected, queued, indexing, indexed, empty, failed, waiting }: { selected: number; queued: number; indexing: number; indexed: number; empty: number; failed: number; waiting: number }) =>
        `${selected} selezionate · ${queued} in coda · ${indexing} in indicizzazione · ${indexed} indicizzate · ${empty} vuote · ${failed} fallite · ${waiting} in attesa`,
      workerPhase: ({ phase }: { phase: string }) => `Fase corrente: ${phase}`,
    },
    lastRun: {
      groupTitle: "Ultima indicizzazione",
      title: "Ultima esecuzione",
      subtitle: ({ considered, processed, semanticRows, failures }: { considered: number; processed: number; semanticRows: number; failures: number }) =>
        `${considered} considerate · ${processed} elaborate · ${semanticRows} righe semantiche · ${failures} errori`,
    },
    coverage: {
      title: "Copertura contenuti",
      footer: "Controlla quali contenuti semantici delle trascrizioni vengono indicizzati nelle sessioni selezionate.",
      triggerTitle: "Copertura",
      options: {
        fullTitle: "Tutta la cronologia selezionata",
        fullSubtitle: "Indicizza tutti i messaggi selezionati dell’utente e dell’assistente",
        latestMessagesTitle: "Messaggi recenti",
        latestMessagesSubtitle: "Indicizza un numero limitato di messaggi semantici recenti per sessione",
        latestDaysTitle: "Giorni recenti",
        latestDaysSubtitle: "Indicizza messaggi semantici da una finestra recente di giorni",
        sinceEnabledTitle: "Da quando è abilitata",
        sinceEnabledSubtitle: "Indicizza contenuti creati dopo l’abilitazione della memoria locale",
      },
    },
    contentPolicy: {
      title: "Contenuto indicizzato",
      footer: "I messaggi dell’utente e dell’assistente sono indicizzati per impostazione predefinita. I dettagli sensibili del provider restano disattivati salvo abilitazione esplicita.",
      userMessagesTitle: "Messaggi utente",
      userMessagesSubtitle: "Include prompt e risposte scritti da te",
      assistantMessagesTitle: "Messaggi assistente",
      assistantMessagesSubtitle: "Include le risposte finali dell’assistente",
      reasoningTitle: "Ragionamento",
      reasoningSubtitle: "Include riassunti del ragionamento solo quando il daemon li supporta",
      toolSummariesTitle: "Riepiloghi strumenti",
      toolSummariesSubtitle: "Include riepiloghi sanitizzati dell’attività degli strumenti",
      toolOutputsTitle: "Output strumenti grezzi",
      toolOutputsSubtitle: "Mantieni disattivato salvo voler includere testo grezzo degli output strumenti negli indici locali",
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
      overview: 'Panoramica',

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
    machineSetupAdoptExistingTitle: "Adotta installazione esistente",
    machineSetupAdoptExistingSubtitle: "Usa una configurazione esistente di daemon/servizio su questo computer",
    machineSetupAdoptExistingProgressTitle: "Verifica installazione esistente",
    machineSetupAdoptExistingNotReady: "Nessuna installazione pronta trovata. Avvia la configurazione su questo computer.",
    machineSetupSshMachineTitle: "Macchina remota via SSH",
    machineSetupSshMachineSubtitle: "Collega un dev box, una VM o un server tramite SSH",
    machineSetupStagesTitle: "Cosa succede",
    machineSetupStageConnect: "Connetti e verifica l’accesso",
    machineSetupStageInstall: "Installa Happier e associa la macchina",
    machineSetupStageFinish: "Completa la configurazione nel terminale integrato",
    machineSetupComingSoon: "L’avvio della macchina arriverà presto.",
    machineSetupTaskWaitingForInput: "In attesa di input",
    machineSetupRemoteSshTargetLabel: "Destinazione SSH",
    machineSetupRemoteSshAgentAuthLabel: "Usa l’agente SSH",
    machineSetupRemoteSshKeyFileAuthLabel: "Usa il file di identità",
    machineSetupRemoteSshIdentityFileLabel: "Percorso del file di identità",
    machineSetupRemoteRelayRuntimeLabel: "Installa anche il runtime Relay sulla macchina remota",
    machineSetupRemoteRelayRuntimeTitle: "Runtime Relay remoto",
    machineSetupRemoteRelayRuntimeReadyTitle: "Pronto sulla macchina remota",
    machineSetupRemoteRelayRuntimeReadySubtitle: "Il runtime Relay è stato installato durante la configurazione SSH. Usa l’URL del Relay remoto per i passaggi di rete successivi su quella macchina.",
    machineSetupRemoteRelayRuntimeUrlTitle: "URL del Relay remoto",
    machineSetupRemoteRelayKeepCurrentTitle: "Mantieni il Relay attuale",
    machineSetupRemoteRelayKeepCurrentSubtitle: "Salva questo URL del Relay senza cambiare.",
    machineSetupRemoteRelaySwitchTitle: "Passa a questo Relay",
    machineSetupRemoteRelaySwitchSubtitle: "Passa ora e continua la configurazione con il nuovo Relay.",
    machineSetupRemoteRelaySwitchConfirmTitle: "Passare a questo Relay?",
    machineSetupRemoteRelaySwitchConfirmBody: ({ relayUrl }: { relayUrl: string }) =>
      `Passare Happier a ${relayUrl} e continuare la configurazione?`,
    machineSetupRemotePromptTrustAction: "Considera affidabile la chiave host",
    machineSetupRemotePromptReplaceAction: "Sostituisci la chiave salvata",
    machineSetupRemotePromptApproveAction: "Approva associazione",
    localRelayRuntime: {
      title: 'Runtime locale del Relay',
      statusTitle: 'Stato',
      statusChecking: 'Verifica del runtime locale del Relay in corso',
      statusNotInstalled: 'Non ancora installato su questo computer',
      statusStopped: 'Installato, ma al momento non è in esecuzione',
      statusRunningHealthy: 'In esecuzione e risponde normalmente',
      statusRunningNeedsAttention: 'In esecuzione, ma i controlli di salute richiedono attenzione',
      versionTitle: 'Versione installata',
      relayUrlTitle: 'URL locale del Relay',
      installOrUpdateAction: 'Installa o aggiorna il runtime del Relay',
      startAction: 'Avvia il runtime del Relay',
      stopAction: 'Arresta il runtime del Relay',
      refreshAction: 'Aggiorna lo stato del Relay',
      footer: 'Gestisci il Relay self-hosted che gira su questo computer prima di connettere altri dispositivi.',
      progressTitle: 'Aggiornamento del runtime locale del Relay',
      progressStepInspect: 'Esamina il runtime locale del Relay',
      progressStepHealth: 'Controlla lo stato del Relay',
      progressStepInstall: 'Installa il runtime del Relay',
      progressStepStart: 'Avvia il runtime del Relay',
      progressStepStop: 'Arresta il runtime del Relay',
    },
    localTailscale: {
      title: 'Accesso privato con Tailscale',
      statusTitle: 'Stato',
      statusUnavailable: 'Prima avvia il runtime locale del Relay',
      statusIdle: 'Non ancora attivato',
      statusWorking: 'Configurazione dell’accesso privato sicuro in corso',
      statusReady: 'Pronto per essere usato dagli altri dispositivi del tailnet',
      statusInstallRequired: 'Installa Tailscale per continuare',
      statusLoginRequired: 'Accedi a Tailscale per continuare',
      statusNeedsApproval: 'In attesa dell’approvazione di Tailscale',
      shareableUrlTitle: 'URL privato condivisibile',
      approvalTitle: 'Approvazione richiesta',
      approvalSubtitle: 'Completa il flusso di approvazione di Tailscale, poi torna qui.',
      installTitle: 'Installazione richiesta',
      installSubtitle: 'Installa Tailscale, poi torna qui.',
      loginTitle: 'Accesso richiesto',
      loginSubtitle: 'Completa l’accesso a Tailscale, poi torna qui.',
      enableAction: 'Abilita l’accesso privato con Tailscale',
      refreshAction: 'Ricontrolla l’accesso privato',
      openApprovalAction: 'Apri l’approvazione di Tailscale',
      openInstallAction: 'Apri il download di Tailscale',
      openLoginAction: 'Apri l’accesso a Tailscale',
      footer: 'Questo mantiene l’accesso privato all’interno del tailnet. Anche il tuo telefono o un altro computer devono unirsi allo stesso tailnet.',
      progressTitle: 'Configurazione dell’accesso sicuro con Tailscale in corso',
      progressStepDetect: 'Controlla la disponibilità di Tailscale',
      progressStepInstall: 'Installa Tailscale',
      progressStepLogin: 'Accedi a Tailscale',
      progressStepServeEnable: 'Abilita l’accesso privato al Relay',
      progressStepVerifyUrl: 'Verifica l’URL condivisibile',
    },
    systemTaskStepPrepare: "Prepara l'attività",
    systemTaskStepInstallRuntime: "Installa il runtime",
    systemTaskStepFinish: "Completa la configurazione",
    systemTaskCurrentStepLabel: "Passaggio corrente",
    systemTaskLatestUpdateLabel: "Ultimo aggiornamento",
    systemTaskBridgeUnavailable: "Le attività di sistema non sono ancora disponibili in questa build.",
    systemTaskStartFailed: "Impossibile avviare l’attività di sistema.",
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
      pets: "Mascotte",
      petsSubtitle: "Scegli Blink e le mascotte compagne del dispositivo",
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
    servers: "Relay",
    serversSubtitle: "Relay salvati, gruppi e impostazioni predefinite",
		    systemStatus: "Stato del sistema",
		    systemStatusSubtitle: "Relay, account, macchine, daemon",
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

      remoteHostsTitle: "Host remoti",
      remoteHostsDesktopOnlyTitle: "Gli host remoti sono disponibili solo su desktop",
      remoteHostsDesktopOnlySubtitle: "Gestisci host SSH salvati su desktop.",
      remoteHostsManagementDisabledTitle: "La gestione degli host remoti è disabilitata",
      remoteHostsManagementDisabledSubtitle: "Questa build non consente di gestire gli host remoti.",
      remoteHostsEmptyTitle: "Nessun host remoto",
      remoteHostsEmptySubtitle: "Aggiungi un host remoto per riutilizzare le credenziali SSH nella configurazione.",
      remoteHostsAddHost: "Aggiungi host remoto",
      remoteHostsAddHostTitle: "Aggiungi host remoto",
      remoteHostsEditHostTitle: "Modifica host remoto",
      remoteHostsHostGroupTitle: "Server",
      remoteHostsSshGroupTitle: "SSH",
      remoteHostsSecretMaterialGroupTitle: "Materiale segreto",
      remoteHostsSavePasswordLabel: "Salva password",
      remoteHostsPasswordSavedTitle: "Password salvata",
      remoteHostsPasswordSavedSubtitle: "Lascia vuoto per mantenerla invariata.",
      remoteHostsStorePrivateKeyLabel: "Salva chiave privata (cifrata)",
      remoteHostsPrivateKeyLabel: "Chiave privata",
      remoteHostsPrivateKeySavedHint: "Una chiave privata è già salvata. Lascia vuoto per mantenerla invariata.",
      remoteHostsSecretMaterialDisabledTitle: "Salvataggio segreti disabilitato",
      remoteHostsSecretMaterialDisabledSubtitle: "Questa build non consente di memorizzare password o chiavi private.",
      remoteHostsSetupAsMachineTitle: "Configura come macchina Happier",
      remoteHostsSetupAsMachineFailed: "Impossibile configurare questo host come macchina Happier.",
      remoteHostsConnectFromThisDeviceTitle: "Connetti da questo dispositivo",
      remoteHostsConnectFromThisDeviceSubtitle: "Solo questo dispositivo. Apre un tunnel SSH locale per questa sessione dell’app.",
      remoteHostsConnectFromThisDeviceFailed: "Impossibile aprire il tunnel SSH locale.",
      remoteHostsNativeSshTunnelRequiresEngine: "I tunnel SSH nativi richiedono la build del motore SSH nativo prima di poter essere avviati da questo dispositivo.",
      remoteHostsSshTunnelGroupTitle: "Raggiungi l’host remoto da questo dispositivo",
      remoteHostsSshTunnelActiveTitle: ({ host }: { host: string }) => `Tunnel SSH attivo per ${host}`,
      remoteHostsSshTunnelActiveSubtitle: ({ url }: { url: string }) => `Solo questo dispositivo. Endpoint locale: ${url}`,
      remoteHostsSshTunnelStopTitle: "Ferma tunnel SSH locale",
      remoteHostsUseAsRelayHostTitle: "Usa come host relay",
      remoteHostsUseAsRelayHostSubtitle: "Configura l'accesso relay su questo host SSH.",
      remoteHostsConfigureAccessTitle: "Configura accesso",
      remoteHostsConfigureAccessSubtitle: "Scegli come rendere raggiungibile questo host remoto.",
      remoteHostsOpenDetailsTitle: "Dettagli host",
      remoteHostsRelayAccessGroupTitle: "Accesso remoto",
      remoteHostsRelayAccessActiveTitle: ({ host }: { host: string }) => `Configurazione dell'accesso per ${host}`,
      remoteHostsRelayAccessActiveSubtitle: "I comandi di accesso relay vengono eseguiti sull'host remoto tramite SSH. Questo non crea un tunnel SSH.",
      remoteHostsMissingServerUrl: "Seleziona un server prima di configurare una macchina remota.",
      remoteHostsRelayAccessIdentityFileRequired: "L'accesso relay su questo host richiede un file di identità SSH locale.",
      remoteHostsTestConnectionTitle: "Test connessione",
      remoteHostsInstallOrUpdateCliTitle: "Installa o aggiorna la CLI",
      remoteHostsDaemonServiceInstallOrUpdateTitle: "Installa o aggiorna il servizio del demone",
      remoteHostsDaemonServiceStartTitle: "Avvia il servizio del demone",
      remoteHostsDaemonServiceStopTitle: "Arresta il servizio del demone",
      remoteHostsDaemonServiceRestartTitle: "Riavvia il servizio del demone",
      remoteHostsRelayRuntimeStatusTitle: "Stato del runtime del relay",
      remoteHostsRelayRuntimeInstallOrUpdateTitle: "Installa o aggiorna il runtime del relay",
      remoteHostsRelayRuntimeStartTitle: "Avvia il runtime del relay",
      remoteHostsRelayRuntimeStopTitle: "Arresta il runtime del relay",
      remoteHostsRelayRuntimeRestartTitle: "Riavvia il runtime del relay",
      remoteHostsPortLine: ({ port }: { port: number }) => `Porta: ${port}`,
      remoteHostsActiveTaskTitle: "Attività di sistema",
      remoteHostsHostTrustTitle: "Vuoi fidarti dell'host SSH?",
      remoteHostsReplaceHostKeyTitle: "Sostituire la chiave host SSH?",
      remoteHostsReplaceHostKeyAction: "Sostituisci chiave host",
      remoteHostsHostKeyCurrentFingerprintLabel: "Impronta attendibile attuale",
      remoteHostsHostKeyNewFingerprintLabel: "Nuova impronta",
      remoteHostsPasswordRequiredTitle: "Password SSH richiesta",
      remoteHostsRememberHostKeyTitle: "Ricordare questa chiave host SSH?",
      remoteHostsRememberHostKeyAction: "Fidati e ricorda",
      remoteHostsTrustOnceAction: "Fidati una volta",
      remoteHostsPrivateKeyPassphraseTitle: "Passphrase della chiave privata SSH",
      remoteHostsKeyboardInteractiveTitle: "Autenticazione SSH",
      remoteHostsKeyboardInteractivePromptLabel: "Prompt SSH",
      remoteHostsTrustedHostKeysTitle: "Chiavi host SSH attendibili",
      remoteHostsTrustedHostKeyRemoveTitle: "Rimuovere la chiave host SSH attendibile?",
      remoteHostsTrustedHostKeysClearTitle: "Cancella chiavi host SSH attendibili",
      remoteHostsConnectionSucceeded: "Connessione riuscita.",
      remoteHostsConnectionFailed: "Connessione non riuscita.",
      sshConfiguredHostPickerTitle: "Host SSH suggeriti",
      sshConfiguredHostPickerSubtitle: "Compila dalla configurazione SSH locale o da known_hosts.",
      sshConfiguredHostPickerRefreshingSubtitle: "Aggiornamento suggerimenti; vengono mostrati gli ultimi risultati.",
      sshConfiguredHostPickerSourceSshConfig: "Configurazione SSH",
      sshConfiguredHostPickerSourceKnownHosts: "known_hosts",
      sshConfiguredHostPickerUnsupportedTitle: "Inserisci manualmente i dettagli SSH",
      sshConfiguredHostPickerUnsupportedSubtitle: "La rilevazione SSH locale è disponibile solo nell’app desktop.",
      sshConfiguredHostPickerLoadingTitle: "Ricerca host SSH…",
      sshConfiguredHostPickerLoadingSubtitle: "Controllo della configurazione SSH locale e di known_hosts tramite il bridge desktop.",
      sshConfiguredHostPickerEmptyTitle: "Nessun host SSH suggerito",
      sshConfiguredHostPickerEmptySubtitle: "Inserisci manualmente i dettagli SSH o aggiorna dopo aver modificato la configurazione SSH.",
      sshConfiguredHostPickerErrorTitle: "Impossibile caricare i suggerimenti SSH",
      sshConfiguredHostPickerRefreshTitle: "Aggiorna suggerimenti SSH",
      sshConfiguredHostPickerRefreshingTitle: "Aggiornamento suggerimenti SSH",
      machineSetupStepResolveRelay: "Controllo dei componenti esistenti",
      machineSetupStepCheckAuth: "Verifica dello stato di accesso",
      machineSetupStepConfigureRelay: "Connessione al Relay",
      machineSetupStepAuthRequest: "Approva questo computer",
      machineSetupStepAuthWait: "In attesa di approvazione",
      machineSetupStepInstallService: "Installazione del servizio in background",
      machineSetupStepStartService: "Avvio del servizio in background",
      machineSetupStepVerifyService: "Verifica del servizio in background",
      machineSetupRemoteSshTargetPlaceholder: "user@host",
      machineSetupRemoteSshUsernameLabel: "Nome utente SSH",
      machineSetupRemoteSshUsernamePlaceholder: "ubuntu",
      machineSetupRemoteSshHostLabel: "Host SSH",
      machineSetupRemoteSshHostPlaceholder: "example.test",
      machineSetupRemoteSshPortLabel: "Porta SSH",
      machineSetupRemoteSshPortPlaceholder: "22",
      machineSetupRemoteSshAuthMethodLabel: "Metodo di autenticazione",
      machineSetupRemoteSshPasswordAuthLabel: "Usa password",
      machineSetupRemoteSshPrivateKeyMaterialLabel: "Incolla la chiave privata",
      machineSetupRemoteSshPasswordLabel: "Password SSH",
      relayAccess: {
      title: 'Accesso al Relay',
      footer: 'Scegli come il tuo telefono raggiunge questo Relay.',
      statusTitle: 'Stato',
      statusNotConfigured: 'Non ancora configurato',
      statusWorking: 'Verifica accesso al Relay',
      statusEnabled: 'Abilitato',
      statusDisabled: 'Disabilitato',
      statusNeedsAuth: 'Accesso richiesto',
      statusError: 'Errore',
      statusUnknown: 'Sconosciuto',
      shareableUrlTitle: 'URL condivisibile',
      methodTitle: 'Metodo di accesso',
      saveAction: 'Salva metodo di accesso',
      disableAction: 'Disabilita accesso al Relay',
      refreshAction: 'Aggiorna stato accesso',
      progressStepInspect: 'Ispeziona la configurazione corrente',
      progressStepCheck: 'Controlla lo stato di accesso',
      progressStepPersist: "Salva la configurazione dell'accesso",
      progressStepApply: "Applica la configurazione dell'accesso",
      progressStepVerify: "Verifica l'URL di accesso",
      progressStepDisable: "Disabilita l'accesso al Relay",
      providers: {
        localOnly: {
          title: 'Solo locale',
          subtitle: 'Solo questo computer può raggiungere il Relay.',
        },
        lan: {
          title: 'LAN / URL personalizzato',
          subtitle: 'Usa un URL che hai già (IP LAN o tunnel).',
        },
        tailscaleServe: {
          title: 'Tailscale Serve',
          subtitle: 'URL privato per il tuo tailnet (consigliato).',
        },
        tailscaleFunnel: {
          title: 'Tailscale Funnel',
          subtitle: 'URL pubblico tramite Funnel.',
        },
        cloudflareNamed: {
          title: 'Tunnel Cloudflare',
          subtitle: 'URL pubblico tramite un tunnel Cloudflare con nome.',
        },
      },
      fields: {
        urlLabel: 'URL del Relay',
        hostnameLabel: 'Nome host',
        tokenLabel: 'Token',
      },
      missingUrl: 'Inserisci un URL del Relay per continuare.',
      missingHostname: 'Inserisci un nome host per continuare.',
      missingToken: 'Inserisci un token per continuare.',
      webHandoffTitle: 'Esegui questo sul tuo computer',
      webHandoffSubtitle: "Usa la CLI per configurare l'accesso al relay, poi torna qui e aggiorna.",
    },
      accessEndpoints: {
      status: {
        refreshing: 'Aggiornamento dei canali di accesso',
      },
      scope: {
        availableToOtherDevices: 'Disponibile per altri dispositivi',
        thisDeviceOnly: 'Solo questo dispositivo',
      },
      direction: {
        makeCurrentServerReachable: 'Rendi raggiungibile questo server',
        reachRemoteServerFromThisDevice: 'Raggiungi un server remoto da questo dispositivo',
        unknown: 'Canale di accesso',
      },
      kind: {
        'relay-access-provider': 'Accesso relay',
        'ssh-tunnel-desktop': 'Tunnel SSH desktop',
        'ssh-tunnel-native': 'Tunnel SSH nativo',
        'server-profile-url': 'URL server',
        'peer-mediation': 'Mediazione peer',
        'manual-url': 'URL manuale',
      },
      recommendedUse: {
        'multi-device': 'Ideale per altri dispositivi',
        'native-this-device': 'Funziona in questa app nativa',
        'hosted-web': 'Funziona dal web ospitato',
        'lan-only': 'Solo LAN o rete privata',
        diagnostic: 'Richiede attenzione',
      },
      limitation: {
        'this-device-only': 'Solo questo dispositivo',
        'not-hosted-web-compatible': 'Non disponibile per il web ospitato',
        'not-public-share-url': 'Non è un URL pubblico condivisibile',
        'session-scoped': 'Limitato alla sessione',
        'authentication-failed': 'Autenticazione SSH non riuscita',
        'foreground-only': 'Richiede che l’app resti in primo piano',
        'host-key-mismatch': 'La chiave SSH dell’host è cambiata',
        'host-key-rejected': 'La chiave SSH dell’host è stata rifiutata',
        'host-key-untrusted': 'La chiave SSH dell’host non è ancora attendibile',
        'platform-suspended': 'In pausa mentre l’app è sospesa',
        'loopback-bind-failed': 'Impossibile associare la porta locale del tunnel',
        'network-captive-portal': 'La rete ha intercettato la connessione SSH',
        'remote-service-unreachable': 'Il servizio remoto non è raggiungibile tramite il tunnel',
        'requires-auth': 'Richiede autenticazione SSH',
        'requires-host-key-trust': 'Richiede fiducia nella chiave host',
      },
      remediation: {
        tailscale: {
          install: 'Installa Tailscale',
          login: 'Accedi a Tailscale',
          serve: {
            enable: 'Abilita Tailscale Serve',
            approve: 'Approva Tailscale Serve',
          },
          funnel: {
            approve: 'Approva Tailscale Funnel',
          },
        },
        cloudflare: {
          configure: 'Configura il tunnel Cloudflare',
        },
        serverProfile: {
          configureShareableUrl: 'Configura URL condivisibile',
        },
        remoteHost: {
          add: 'Aggiungi host remoto',
          setup: 'Configura host remoto',
        },
        sshTunnel: {
          start: 'Avvia tunnel SSH',
          reuse: 'Usa tunnel SSH esistente',
          stop: 'Arresta tunnel SSH',
          authenticate: 'Autentica tunnel SSH',
          trustHost: 'Considera attendibile la chiave host SSH',
        },
      },
    },
      systemTaskOpenLogs: "Apri log",
      systemTaskOpenLogsFailed: "Impossibile aprire la cartella dei log.",},

  systemStatus: {
    sections: {
      application: "Applicazione",
      updates: "Aggiornamenti",
      appHealth: "Salute app e sincronizzazione",
      currentServer: "Relay attuale",
      identity: "Identità autenticata",
      configuredServers: "Relay configurati",
      machinesActiveServer: "Macchine (relay attivo)",
      machinesOtherServer: ({ server }: { server: string }) => `Macchine (${server})`,
      actions: "Azioni",
    },
    application: {
      appVersion: "Versione app",
      nativeVersion: "Versione nativa",
      buildNumber: "Numero build",
      applicationId: "ID applicazione",
      updateChannel: "Canale aggiornamenti",
      updateId: "ID aggiornamento corrente",
      runtimeVersion: "Versione runtime",
      updateCreatedAt: "Data aggiornamento corrente",
      launchSource: "Origine avvio",
      launchSourceEmbedded: "Binario nativo integrato",
      launchSourceOta: "Aggiornamento OTA scaricato",
      launchSourceUnknown: "Sconosciuto",
    },
    updates: {
      otaStatus: "Stato OTA",
      lastChecked: "Ultimo controllo",
      openStore: "Apri aggiornamento store",
      available: "Disponibile",
      checkNow: "Controlla ora",
      checkNowSubtitle: "Controlla manualmente se esiste un OTA più recente sul canale corrente.",
      applyNow: "Applica aggiornamento ora",
      disabled: "Disabilitato",
      applying: "Applicazione aggiornamento",
      readyToApply: "Pronto da applicare",
      downloading: "Download in corso",
      downloadingProgress: ({ progress }: { progress: string }) => `Download in corso (${progress})`,
      checking: "Controllo in corso",
      error: "Errore",
      upToDate: "Aggiornato",
      unknown: "Sconosciuto",
    },
    ui: {
      dataReady: "Dati pronti",
      realtime: "Tempo reale",
      socket: "Socket (WebSocket)",
      socketLastError: ({ error }: { error: string }) => `Ultimo errore: ${error}`,
      lastSync: "Ultima sincronizzazione",
    },
    server: {
      activeServer: "Relay attivo",
    },
    identity: {
      accountId: "ID account",
      username: "Nome utente",
    },
    servers: {
      noneConfigured: "Nessun relay configurato",
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
        loading: "Recupero relay/account del daemon…",
        invalid: "Impossibile leggere lo snapshot doctor dalla macchina",
      },
      daemonAttributionUnknown: "Relay/account del daemon: sconosciuto",
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
      runDiagnosisSubtitle: "Rileva mismatch di relay/account/daemon",
      refreshMachineAttribution: "Aggiorna attribuzione daemon",
      refreshMachineAttributionSubtitle: "Recupera relay/account del daemon per alcune macchine online",
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
      activeServer: "Relay attivo",
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
      footer: "Suggerimento: esegui happier doctor --json sul computer e incollalo qui.",
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
    accountScopeMismatchTitle: 'Cambia account del server per continuare',
    accountScopeMismatchDescription: 'Questa macchina appartiene all’account di un altro server. Passa a quell’account del server per gestirne gli account collegati.',
    purposeTargets: {
      requiredPrompt: 'Scegli un account o un gruppo',
      legacyUnavailable: 'Questo server non può ancora mostrare le destinazioni degli account connessi',
    },
    fallbackName: "Servizio connesso",
    serviceNames: {
      claudeSubscription: "Abbonamento Claude",
      openaiCodex: "Codex di OpenAI",
      openai: "Chiave API OpenAI",
      anthropic: "Chiave API Anthropic",
      gemini: "Gemini di Google",
      github: "GitHub",

      bitbucket: "Bitbucket",},
    title: "Servizi connessi",
    authChip: {
      label: "Autenticazione",
      labelWithCount: ({ count }: { count: number }) => `Autenticazione: ${count}`,
      nativeLabel: "Nativa",
      connectedCountLabel: ({ count }: { count: number }) => `${count} connessi`,
    },
    authSwitch: {
      switchFailed: 'Impossibile cambiare l\'autenticazione per questa sessione.',
      confirmAction: 'Cambia autenticazione',
      errors: {
        groupGenerationConflict: 'Il gruppo di account è cambiato prima del completamento del cambio. Aggiorna l’elenco degli account e riprova.',
        providerStateSharingRequired: 'Provider state sharing must be enabled before this account can be used for the running session.',
        notGroupSelection: 'Choose an account group so Happier can switch away from an exhausted account automatically.',
        connectedServiceRequired: 'Choose a connected account before using this recovery action for the session.',
        profileActionRequired: 'The selected connected account needs attention before it can be used.',
        providerStateSharingUnavailable: 'Non è stato possibile controllare le impostazioni di condivisione dello stato del provider su questa macchina. Aggiorna la connessione al daemon e riprova.',
        profileDisconnected: 'L’account connesso selezionato deve essere autenticato di nuovo prima dell’uso.',
        profileMissing: 'L’account connesso selezionato non è più disponibile. Aggiorna l’elenco degli account e scegline un altro.',
        groupMissing: 'Il gruppo di account selezionato non è più disponibile. Aggiorna l’elenco degli account e scegli un altro gruppo.',
        metadataUpdateFailed: 'La sessione non ha potuto salvare la nuova selezione di autenticazione. Riprova dopo il completamento della sincronizzazione.',
        restartFailed: 'Non è stato possibile riavviare la sessione con la nuova selezione di autenticazione. Arresta la sessione e riprova.',
        hotApplyFailed: 'La sessione in esecuzione ha rifiutato la nuova selezione di autenticazione. Riavvia la sessione e riprova.',
        agentMismatch: 'Questa selezione di autenticazione non corrisponde al backend della sessione.',
        sessionNotFound: 'Questa sessione non è più disponibile sulla macchina selezionata.',
        unsupportedService: 'Questo backend non supporta il servizio connesso selezionato.',
      },
      status: {
        liveApplied: 'Autenticazione cambiata nella sessione in esecuzione',
        credentialsRefreshed: 'Autenticazione aggiornata',
        restarting: 'Riavvio sessione',
        appliesOnNextResume: 'Si applica al prossimo ripristino',
        retry: 'Authentication switch needs retry',
        partialApplication: "Autenticazione cambiata parzialmente",
        partialApplicationServiceFailed: ({ service }: { service: string }) => `${service}: autenticazione non riuscita`,
        partialApplicationServiceNotApplied: ({ service }: { service: string }) => `${service}: autenticazione non applicata`,
      },
      partialApply: {
        title: 'Autenticazione cambiata parzialmente',
        body: 'Il nuovo account è stato salvato, ma l\'applicazione a questa sessione attiva non è stata completata del tutto. Riprova o ripristina per mantenere questa sessione sull\'account precedente.',
        retry: 'Riprova ad applicare a questa sessione',
        revert: 'Ripristina l\'account precedente',
      },
    },
    errors: {
      credentialReferencedByGroup: 'Questo account connesso è usato da un gruppo di account. Disconnetterlo lo rimuoverà da quei gruppi e lo eliminerà come attivo dove necessario.',
      runtimeCooldown: ({ time }: { time: string }) => `This account is cooling down until ${time}.`,
      runtimeCooldownOverrideTitle: 'Passare a un account in raffreddamento?',
      runtimeCooldownOverrideBody: ({ time }: { time: string }) =>
        `This account is cooling down until ${time}. Switch manually anyway?`,
      runtimeCooldownOverrideConfirm: 'Passa comunque',
      unknownResetTime: 'un orario sconosciuto',
      generationConflict: 'Questo gruppo di account è cambiato prima del completamento dell’azione. Aggiorna l’elenco account e riprova.',
      generationConflictWithGeneration: ({ generation }: { generation: number }) =>
        `This account group changed before the action completed. Refresh the account list and try again. Current generation: ${generation}.`,
      generationRequired: 'Questa azione richiede una versione aggiornata del gruppo di account. Aggiorna l’elenco account e riprova.',
      groupNotFound: 'Questo gruppo di account non esiste più. Aggiorna l’elenco account e riprova.',
      groupMemberNotFound: 'Questo account non è più membro del gruppo. Aggiorna l’elenco account e riprova.',
      profileNotFound: 'Questo account connesso non esiste più. Aggiorna l’elenco account e riprova.',
      activeProfileNotMember: 'Solo i membri abilitati del gruppo possono essere resi attivi.',
      fallbackDisabled: 'Il fallback degli account è disattivato su questo server.',
      duplicateMember: 'Questo account è già nel gruppo.',
      groupAlreadyExists: 'Esiste già un gruppo di account con questo id.',
      groupCapacityExhausted: 'Questo account ha già il numero massimo di gruppi di account. Eliminane uno che non ti serve più e riprova.',
      connectedAccountCapacityExhausted: 'Questo account ha già il numero massimo di account collegati. Scollegane uno che non ti serve più e riprova.',
      invalidGroup: 'Questo gruppo di account non è valido. Controlla le impostazioni e riprova.',
      requestFailedWithStatus: ({ status }: { status: number }) => `The connected-service request failed (${status}). Refresh and try again.`,
      generic: 'L’azione del servizio connesso non è riuscita. Aggiorna e riprova.',
    },
    diagnostics: {
      title: {
        provider_session_state_unavailable_for_resume: 'Cambio non disponibile',
        connected_service_materialization_identity_missing: 'Identità del servizio connesso mancante',
        resume_reachability_inputs_missing: 'Impossibile verificare la ripresa della sessione',
        metadata_update_failed: 'La selezione dell\'autenticazione non è stata salvata',
        no_eligible_group_member: 'Nessun account di fallback disponibile',
        recovery_retry_scheduled: 'Recupero del provider pianificato',
                recovery_dead_lettered: 'Il recupero del provider richiede attenzione',
                provider_account_adoption_mismatch: 'Il provider non ha cambiato account',
                post_switch_verification_failed: 'Impossibile verificare l\'account del provider',
                connected_service_credential_reconnect_required: "L'account collegato deve essere riconnesso",
                connected_service_credential_refresh_unavailable: "L'aggiornamento dell'account collegato non è temporaneamente disponibile",
                claude_subscription_missing_claude_code_scope: 'L\'accesso a Claude Code richiede una nuova connessione',
        claude_subscription_native_auth_materialization_failed: 'Non è stato possibile preparare le credenziali di Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Il token di configurazione di Claude non può avviare la modalità Unified',
      },
      status: {
        providerSessionStateUnavailableForResume: "Impossibile trasferire lo stato della sessione",
        providerAccountAdoptionMismatch: "Il provider è rimasto su un altro account",
        postSwitchVerificationFailed: "Impossibile verificare l'account del provider",
        recoveryRetryScheduled: "Riprova del ripristino del provider pianificata",
        metadataUpdateFailed: "Impossibile salvare la selezione di autenticazione",
        noEligibleGroupMember: "Nessun account di riserva è idoneo",
        provider_session_state_unavailable_for_resume: 'Impossibile trasferire lo stato della sessione',
        connected_service_materialization_identity_missing: 'Identità del servizio connesso mancante',
        resume_reachability_inputs_missing: 'Impossibile verificare la ripresa della sessione',
        metadata_update_failed: 'Impossibile salvare la selezione di autenticazione della sessione',
        no_eligible_group_member: 'Nessun account di fallback è idoneo',
        recovery_retry_scheduled: 'Nuovo tentativo di recupero del provider pianificato',
                recovery_dead_lettered: 'Il recupero del provider ha raggiunto il limite di tentativi',
                provider_account_adoption_mismatch: 'Il provider è rimasto su un altro account',
                post_switch_verification_failed: 'Impossibile verificare l\'account del provider',
                connected_service_credential_reconnect_required: "L'account collegato deve essere riconnesso",
                connected_service_credential_refresh_unavailable: "L'aggiornamento dell'account collegato non è riuscito temporaneamente",
                claude_subscription_missing_claude_code_scope: 'Riconnetti l\'abbonamento Claude per Claude Code',
        claude_subscription_native_auth_materialization_failed: 'Non è stato possibile preparare l\'autenticazione nativa di Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Riconnetti Claude con OAuth per la modalità Unified',
      },
      body: {
        default: "Controlla gli account connessi e riprova.",
        provider_session_state_unavailable_for_resume: "Controlla gli account collegati, poi avvia una nuova sessione con l'account selezionato o continua con quello attuale.",
        connected_service_materialization_identity_missing: 'A questa sessione manca l\'identità del servizio connesso necessaria per riutilizzare lo stato materializzato del provider. Avvia una nuova sessione con l\'account selezionato o continua con l\'account attuale.',
        resume_reachability_inputs_missing: 'Il daemon non ha potuto verificare lo stato di ripresa del provider perché mancavano dati necessari.',
        metadata_update_failed: 'La sessione non ha potuto salvare la nuova selezione di autenticazione. Riprova dopo il termine della sincronizzazione della sessione.',
        no_eligible_group_member: 'Nessun account in questo gruppo è attualmente idoneo per il fallback. Controlla gli account connessi e riconnetti un profilo se necessario.',
        recovery_retry_scheduled: 'Happier ha pianificato un nuovo tentativo di recupero del provider. Puoi riprovare ora o controllare gli account connessi.',
                recovery_dead_lettered: 'Happier ha esaurito i tentativi automatici di recupero del provider. Controlla gli account connessi o riconnetti il profilo selezionato.',
                provider_account_adoption_mismatch: 'Il provider è rimasto su un altro account dopo il cambio. Controlla gli account connessi o riprova il cambio.',
                post_switch_verification_failed: 'Happier non ha potuto verificare che il provider abbia adottato l\'account selezionato. Controlla gli account connessi o riprova il cambio.',
                connected_service_credential_reconnect_required: "L'account collegato selezionato deve essere riconnesso prima che questa sessione possa riprendere. Riconnetti il profilo, poi riprova.",
                connected_service_credential_refresh_unavailable: "Happier non ha potuto aggiornare l'account collegato selezionato. Riprova tra poco.",
                claude_subscription_missing_claude_code_scope: 'Questo profilo Claude è stato collegato prima che fossero concessi gli ambiti di Claude Code. Ricollegalo, poi riprova la sessione o il cambio di gruppo.',
        claude_subscription_native_auth_materialization_failed: 'Happier non ha potuto creare il file delle credenziali native di Claude Code per questo profilo. Ricollega il profilo o scegli un altro membro del gruppo.',
        claude_subscription_setup_token_not_supported_for_unified: 'La modalità Claude Unified deve avviare la CLI di Claude con credenziali OAuth native. Ricollega questo profilo con OAuth invece di un token di configurazione.',
      },
      actions: {
        viewLatestFork: "Visualizza l'ultimo fork",
        viewNativeFork: "Visualizza fork nativo",
      },
    },
    reconnect: {
      identityMismatchTitle: 'Rilevato un account provider diverso',
      identityMismatchBody: 'Queste credenziali sembrano appartenere a un altro account del provider. Continua solo se vuoi sostituire l identita salvata per questo profilo.',
      identityMismatchConfirm: 'Sostituisci identita',
      targetMismatch: 'Questa riconnessione ha restituito credenziali per un altro profilo connesso. Avvia di nuovo la riconnessione dal profilo di destinazione.',
    },
    defaultAuth: {
      poolSuggestion: {
        body: ({ pool }: { pool: string }) => `Usa il pool ${pool} così le sessioni ruotano oltre i limiti di frequenza.`,
        accept: "Usa pool",
        dismiss: "Ignora",
      },
      title: "Configurazione backend predefinita",
      footer:
        "Scegli quale account connesso deve usare ogni backend quando inizia una nuova sessione.",
      agentDetailTitle: "Autenticazione predefinita",
      agentDetailFooter:
        "Scrive lo stesso valore predefinito usato dalle impostazioni dei servizi connessi.",
      rowDetail: "Predefinito",
      warning: {
        connected_profile_unavailable:
          "L'account connesso predefinito non è disponibile; viene usata l'autenticazione nativa.",
        connected_group_unavailable:
          "Il gruppo connesso predefinito non è disponibile; viene usata l'autenticazione nativa.",
        connected_group_disabled:
          "I gruppi connessi sono disattivati qui; viene usata l'autenticazione nativa.",
        connected_service_unsupported:
          "Questo backend non supporta quel servizio connesso; viene usata l'autenticazione nativa.",
      },
    },
    list: {
      empty: "Nessun servizio connesso per ora.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "connesso", plural: "connessi" })}`,
      needsReauth: "richiede ri-autenticazione",
      notConnected: "non connesso",
    },
    providerStateSharing: {
      title: "Condivisione stato provider",
      footer: "L'autenticazione dei servizi connessi resta isolata. Configurazione e stato sessione sono condivisi solo dove il provider lo supporta in modo sicuro.",
      configTitle: "Condividi configurazione provider",
      agentConfigTitle: ({ agent }: { agent: string }) => `Condivisione configurazione ${agent}`,
      configLinkedTitle: "Collega configurazione attiva",
      configLinkedSubtitle: "Usa collegamenti dove supportati così le sessioni connesse leggono la configurazione provider attuale.",
      configCopiedTitle: "Copia snapshot configurazione",
      configCopiedSubtitle: "Copia la configurazione provider ogni volta che l'autenticazione viene materializzata.",
      configIsolatedTitle: "Mantieni configurazione isolata",
      configIsolatedSubtitle: "Non condividere la configurazione nativa del provider con le home dei servizi connessi.",
      stateTitle: "Condividi sessioni e stato provider",
      agentStateTitle: ({ agent }: { agent: string }) => `Condivisione sessioni e stato ${agent}`,
      stateEnabledSubtitle: "Consenti ai provider supportati di riprendere le stesse sessioni tra autenticazione nativa e connessa.",
      stateDisabledSubtitle: "Mantieni separati sessioni e stato locale del provider salvo flussi specifici.",
      sharedStatePrivacyTitle: "Condividi stato provider",
      sharedStatePrivacyBody: ({ agent }: { agent: string }) =>
        `${agent} può leggere file di sessione locali del provider dalle home dei servizi connessi. Abilitalo solo per account che vuoi collegare.`,
      unavailable: {
        notImplemented: "La condivisione non è ancora disponibile per questo provider.",
        dynamicDiagnosticsRequired: "La condivisione richiede una verifica di disponibilità a runtime prima di essere abilitata.",
      },
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
      remaining: ({ percent }: { percent: string }) => `${percent} rimanente`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `${percent} rimasto · si reimposta tra ${reset}`,
      usageCount: ({ used, limit }: { used: number; limit: number }) => `${used}/${limit} usato`,
      recoveryCreditTitle: ({ count }: { count: number }) => count === 1 ? '1 ripristino utilizzo disponibile' : `${count} ripristini utilizzo disponibili`,
      recoveryCreditSubtitle: 'Applica un ripristino utilizzo per recuperare subito il limite esaurito.',
      recoveryCreditExpires: ({ time }: { time: string }) => `Scadenza più vicina ${time}.`,
      recoveryCreditApplying: 'Applicazione…',
      recoveryCreditMachineUnavailable: 'Nessuna macchina disponibile può applicare ora questo ripristino.',
      recoveryCreditNothingToReset: 'Nessuna finestra di utilizzo esaurita attualmente necessita di un ripristino.',
      recoveryCreditBadge: ({ count }: { count: number }) => count === 1 ? '1 ripristino' : `${count} ripristini`,
      duration: {
        now: 'ora',
        outdated: 'Non aggiornato',
        daysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    account: {
      configurationTitle: 'Impostazioni account',
      configurationUpdatedTitle: 'Impostazioni account aggiornate',
      configurationInvalid: "Le impostazioni dell'account non sono valide. Controlla ogni campo e usa un'origine HTTPS esatta e senza credenziali dove richiesto.",
      configurationRefreshApplied: "Le nuove impostazioni sono state salvate e l'account collegato è stato aggiornato.",
      configurationReconnectApplied: "Le nuove impostazioni sono state salvate e l'account collegato è stato riconnesso.",
      refreshA11y: 'Aggiorna utilizzo e limiti',
      usedDetail: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit} usato`,
      usageCaption: 'Utilizzo',
      resetsCaption: 'Ripristini',
      poolsLabel: 'Gruppi',
      poolsCount: ({ count }: { count: number }) => count === 1 ? '1 gruppo' : `${count} gruppi`,
      planEmailSubtitle: ({ plan, email }: { plan: string; email: string }) => `${plan} · ${email}`,
      activeMemberA11y: 'Account attivo',
      setActiveA11y: 'Imposta account attivo',
      memberEnabledLabel: 'Account abilitato',
      resets: {
        now: 'ora',
        inDays: ({ days }: { days: number }) => days === 1 ? 'tra 1 giorno' : `tra ${days} giorni`,
        available: 'Ripristino utilizzo disponibile',
        rowLabel: ({ date, countdown }: { date: string; countdown: string }) =>
          countdown ? `Scade ${date} · ${countdown}` : `Scade ${date}`,
        confirmTitle: 'Applicare il ripristino utilizzo?',
        confirmMessage: 'Questo consumerà un ripristino disponibile per questo account collegato.',
        confirmCta: 'Applica ripristino',
        use: 'Usa',
      },
    },
    pools: {
      title: 'Gruppi',
      autoBadge: 'Automatico',
      manualBadge: 'Manuale',
      memberWarningsA11y: ({ count }: { count: number }) =>
        count === 1 ? '1 membro richiede attenzione' : `${count} membri richiedono attenzione`,
      create: {
        title: 'Crea pool',
        subtitle: 'Raggruppa account collegati per il fallback automatico.',
      },
      empty: {
        title: 'Nessun pool ancora',
        subtitle: 'Crea un pool per instradare le sessioni tra più account collegati.',
      },
      loadError: {
        title: "Impossibile caricare i Pool",
        subtitle: "Impossibile caricare i Pool di account. Controlla la connessione e riprova.",
        staleTitle: "Mostrati gli ultimi Pool noti",
        staleSubtitle: "Impossibile aggiornare l'elenco dei Pool più recente. Riprova per aggiornarlo.",
        retry: "Riprova",
      },
      detail: {
        summaryTitle: 'Riepilogo',
        summary: ({ count, strategy }: { count: number; strategy: string }) =>
          `${count} account${count === 1 ? '' : 's'} · ${strategy}`,
        membersTitle: 'Membri',
        moveUp: 'Sposta su',
        moveDown: 'Sposta giù',
        noMembersTitle: 'Nessun membro ancora',
        noMembersSubtitle: 'Aggiungi un account collegato a questo pool.',
        serverActiveStatusTitle: "Salvato sul server",
        serverActiveStatusSubtitle: "Questo è l’account attivo permanente. Le macchine offline lo applicheranno quando si riconnetteranno; questa schermata non indica che tutte le macchine abbiano completato la convergenza.",
        manualApplyDivergenceTitle: "Cambiato sul server, non nelle sessioni attive",
        manualApplyDivergenceSubtitle: ({ detail }: { detail: string }) => `L'account attivo è cambiato sul server, ma non è stato possibile applicarlo alle sessioni attive (${detail}). Riprova o ripristina per mantenere tutto sull'account precedente.`,
        manualApplyRetry: "Riprova ad applicare alle sessioni attive",
        manualApplyRevert: "Ripristina l'account precedente",
        machineTarget: {
            title: "Impossibile applicare a una sessione attiva",
            noBoundSession: "Al momento nessuna sessione attiva usa questo Pool, quindi il cambio non può essere applicato in tempo reale. Avvia una sessione su questo Pool e riprova.",
            offline: "La macchina che esegue la sessione di questo Pool è offline, quindi il cambio non può raggiungerla. Riporta la macchina online e riprova.",
        },
        behaviorTitle: 'Comportamento',
        advancedTitle: 'Avanzate',
        advancedSubtitle: 'Regola i trigger di fallback e il comportamento di recupero.',
      },
      behavior: {
        autoRestorePrimaryTitle: 'Ripristina il primario dopo il reset',
        autoRestorePrimarySubtitle: 'Torna all’account primario quando il suo limite di utilizzo si reimposta.',
        switchOnGroupSubtitle: 'Consenti a questa condizione di attivare un cambio automatico di pool.',
        switchOn: {
          usageLimit: 'Limite di utilizzo',
          authExpired: 'Autenticazione scaduta',
          accountChanged: 'Account cambiato',
          refreshFailure: 'Aggiornamento non riuscito',
        },
      },
      delete: {
        title: 'Elimina pool',
        subtitle: 'Rimuovi questo pool e la sua configurazione di fallback.',
        confirmTitle: 'Eliminare il pool?',
        confirmMessage: ({ name }: { name: string }) =>
          `Eliminare ${name}? Le sessioni non useranno più questo pool.`,
      },
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
      segments: {
        accounts: "Account",
        pools: "Piscine",
      },
      unknownService: "Servizio connesso sconosciuto.",
      actionsGroupTitle: "Azioni",
      actions: {
        setDefault: "Imposta come predefinito",
        unsetDefault: "Rimuovi predefinito",
        editLabel: "Modifica etichetta",
        openAccount: "Apri account",
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
      connectAccessTokenTitle: "Connetti con token di accesso",
      connectAccessTokenSubtitle: "Incolla un token di accesso personale di GitHub",
      openGithubTokenTemplateTitle: "Crea token GitHub",
      openGithubTokenTemplateSubtitle: "Apri GitHub con i permessi necessari a Happier già compilati",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Disconnettere ${service} (${profileId})?`,
      disconnectGroupCleanupConfirmBody: ({ service, profileId, groups }: { service: string; profileId: string; groups: string }) =>
        `Disconnettere ${service} (${profileId}) e rimuoverlo da ${groups}?`,
      prompts: {
        profileIdTitle: "ID profilo",
        profileIdBody: "Usa un’etichetta breve come work, personal, alt.",
        apiKeyTitle: "Chiave API",
        apiKeyBody: "Incolla la tua chiave API di Anthropic.",
        apiKeyPlaceholder: "es. sk-ant-…",
        setupTokenTitle: "Token di configurazione",
        setupTokenBody: "Incolla il tuo setup-token di Claude (da claude setup-token).",
        setupTokenPlaceholder: "es. sk-ant-oat01-…",
        accessTokenTitle: "Token di accesso",
        accessTokenBody: "Incolla il tuo token di accesso personale di GitHub. Usa un token fine-grained con Contenuti, Pull request e Amministrazione in lettura e scrittura, così i flussi di PR e pubblicazione repository possono funzionare.",
        accessTokenPlaceholder: "github_pat_…",
        profileLabelTitle: "Etichetta profilo",
        profileLabelBody: "Facoltativo. Mostrato nei selettori di autenticazione.",
        profileLabelPlaceholder: "Account lavoro",

        personalAccessTokenTitle: "Token di accesso personale",
        personalAccessTokenBody: "Incolla il token di accesso personale fine-grained di GitHub.",
        personalAccessTokenPlaceholder: "github_pat_…",
        apiTokenTitle: "Token API",
        apiTokenBody: "Incolla il token API del provider o una password app.",
        apiTokenPlaceholder: "Token API",},
      alerts: {
        invalidProfileIdTitle: "ID profilo non valido",
        invalidProfileIdBody:
          "Usa lettere, numeri, trattino o underscore (max 64).",
        unknownProfileTitle: "Profilo sconosciuto",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Nessun profilo chiamato \"${profileId}\" esiste per ${service}.`,
        failedToOpenTokenSetupUrl: "Impossibile aprire le impostazioni del token GitHub.",
      },
      profiles: {
        empty: "Nessun profilo ancora.",
        connected: "Connesso",
        defaultBadge: "Predefinito",
        needsReauth: "Richiede ri-autenticazione",
      },
      groups: {
        title: "Gruppi account",
        empty: "Nessun gruppo account ancora.",
        subtitle: ({ count }: { count: number }) => `${count} account`,
        subtitleWithActive: ({ profileId, count }: { profileId: string; count: number }) =>
          `Attivo: ${profileId} • ${count} account`,
        actionsTitle: "Azioni gruppo account",
        createTitle: "Crea gruppo account",
        createSubtitle: "Raggruppa i profili connessi per il recupero con fallback.",
        noProfilesTitle: "Nessun profilo connesso",
        noProfilesBody: "Connetti almeno un profilo prima di creare un gruppo account.",
        invalidGroupTitle: "ID gruppo non valido",
        invalidGroupBody: "Usa lettere, numeri, punti, trattini o underscore (max 64).",
        statusReady: "Pronto",
        statusSwitching: "Cambio in corso",
        statusExhausted: "Esaurito",
        statusError: "Errore",
        statusUnknown: "Sconosciuto",
        statusNeedsMembers: "Servono membri abilitati",
        activeMember: ({ profileId }: { profileId: string }) => `Attivo: ${profileId}`,
        enabledMembers: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} abilitati`,
        autoFallbackEnabled: "Fallback automatico attivo",
        autoFallbackDisabled: "Fallback automatico disattivato",
        strategyPriority: "Ordine di priorità",
        strategyLeastLimited: "Meno limitato per primo",
        strategyManual: "Cambio manuale",
        priority: ({ priority }: { priority: string }) => `Priorità ${priority}`,
        cooldown: ({ time }: { time: string }) => `Cooldown fino a ${time}`,
        memberActive: "Membro attivo",
        memberEnabled: "Abilitato",
        memberDisabled: "Disabilitato",
        memberPriority: ({ priority }: { priority: number }) => `Priorità ${priority}`,
        memberExhaustedUntil: ({ time }: { time: string }) => `Esaurito fino a ${time}`,
        memberQuotaExhaustedUntil: ({ time }: { time: string }) => `Utilizzo limitato fino a ${time}`,
        memberRateLimitedUntil: ({ time }: { time: string }) => `Limite di frequenza fino a ${time}`,
        memberCapacityLimitedUntil: ({ time }: { time: string }) => `Capacità limitata fino a ${time}`,
        memberAuthInvalidUntil: ({ time }: { time: string }) => `Autenticazione non valida fino a ${time}`,
        memberPlanUnavailableUntil: ({ time }: { time: string }) => `Piano non disponibile fino a ${time}`,
        memberValidationBlockedUntil: ({ time }: { time: string }) => `Validazione bloccata fino a ${time}`,
        memberLastFailure: ({ reason }: { reason: string }) => `Ultimo problema: ${reason}`,
        warningNoEnabledMembers: "Nessun membro abilitato è disponibile per il fallback.",
        warningNoFallbackMember: "Aggiungi o abilita un altro membro prima che il fallback automatico possa cambiare account.",
        deleteTitle: "Eliminare il gruppo account?",
        deleteBody: ({ groupId }: { groupId: string }) => `Eliminare \"${groupId}\"? I profili resteranno connessi.`,
        prompts: {
          groupIdTitle: "ID gruppo",
          groupIdBody: "Usa un'etichetta breve come team, work o fallback.",
          groupIdPlaceholder: "squadra",
        },
      },
      groupActions: {
        editTitle: "Modifica gruppo",
        searchMembersPlaceholder: "Cerca profili",
        noProfilesAvailable: "Nessun profilo connesso disponibile.",
        membersTitle: "Membri",
        membersSubtitle: "Seleziona i profili da includere in questo gruppo.",
        accountFallbackDisabled: "Il fallback automatico è disattivato su questo server.",
        enableFallback: "Abilita fallback automatico",
        disableFallback: "Disabilita fallback automatico",
        makeActive: "Rendi attivo",
        useManualStrategy: "Usa cambio manuale",
        usePriorityStrategy: "Usa ordine di priorità",
        activeMember: "Membro attivo",
        manualApplyFailedTitle: "Account cambiato, aggiornamento del daemon incompleto",
        manualApplyFailedBody: "L'account attivo e cambiato sul server, ma una o piu sessioni locali in esecuzione non sono state aggiornate. Riavvia o riprendi quelle sessioni se continuano a usare l'account precedente.",
        enableMember: "Abilita membro",
        disableMember: "Disabilita membro",
        editPriority: "Modifica priorità",
        priorityTitle: "Priorità membro",
        priorityBody: "I numeri più bassi vengono provati per primi.",
        invalidPriorityTitle: "Priorità non valida",
        invalidPriorityBody: "Inserisci un numero intero.",
        removeMember: "Rimuovi membro",
        removeMemberConfirmTitle: "Rimuovi membro",
        removeMemberConfirmBody: ({ profileId }: { profileId: string }) => `Rimuovere "${profileId}" da questo gruppo?`,
        runtimeFallbackUnsupported: 'Il fallback automatico non è disponibile per questo servizio connesso.',
        removeMembersConfirmBody: ({ count, members }: { count: number; members: string }) => `Rimuovere ${count === 1 ? "questo membro" : `questi ${count} membri`} da questo Pool?\n\n${members}`,
        manageMembersTitle: 'Gestisci membri',
        manageMembersSubtitle: ({ count, total }: { count: number; total: number }) => `${count} di ${total} account`,
      },
      groupDetail: {
        routeTitle: "Gruppo",
        nameTitle: "Nome gruppo",
        namePromptBody: "Scegli il nome mostrato nelle impostazioni e nei selettori di autenticazione.",
        groupIdTitle: "ID gruppo",
        membersTitle: "Membri",
        membersSubtitle: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} abilitati`,
        optionsTitle: "Opzioni",
        autoSwitchTitle: "Fallback automatico",
        autoSwitchEnabledSubtitle: "Passa a un altro membro quando l'account attivo richiede recupero.",
        autoSwitchDisabledSubtitle: "Continua a usare il membro attivo finché non lo cambi manualmente.",
        strategyTitle: "Strategia di selezione",
        strategyPriorityTitle: "Ordine di priorità",
        strategyPrioritySubtitle: "Prova prima i numeri di priorità più bassi.",
        strategyLeastLimitedTitle: "Meno limitato prima",
        strategyLeastLimitedSubtitle: "Preferisci il membro con più quota utilizzabile.",
        strategyManualTitle: "Cambio manuale",
        strategyManualSubtitle: "Usa solo il membro attivo finché non viene cambiato manualmente.",
        softSwitchThresholdTitle: "Soglia di cambio leggero",
        softSwitchThresholdSubtitle: ({ percent }: { percent: string }) => `Cambia sotto il ${percent}% restante quando è disponibile un membro migliore.`,
        softSwitchThresholdPromptTitle: "Soglia di cambio leggero",
        softSwitchThresholdPromptBody: "Inserisci la percentuale restante sotto cui Happier dovrebbe preferire un account più sicuro. Usa 0 per disattivare il cambio leggero.",
        invalidSoftSwitchThresholdTitle: "Soglia non valida",
        invalidSoftSwitchThresholdBody: "Inserisci un numero da 0 a 100.",
        staleProbeTitle: "Controlla quota vecchia dopo",
        staleProbeSubtitle: ({ minutes }: { minutes: string }) => `Ricontrolla quando i dati quota hanno più di ${minutes} min.`,
        staleProbePromptTitle: "Controlla quota vecchia dopo",
        staleProbePromptBody: "Inserisci per quanti minuti i dati quota possono essere riutilizzati prima che Happier controlli di nuovo.",
        invalidStaleProbeTitle: "Intervallo di controllo non valido",
        invalidStaleProbeBody: "Inserisci almeno 1 minuto.",
        switchBudgetTitle: "Limiti di cambio automatico",
        switchBudgetSubtitle: ({ perTurn, perHour }: { perTurn: string; perHour: string }) => `Fino a ${perTurn} cambi automatici per turno e ${perHour} per ora di sessione.`,
        recoveryModeTitle: "Modalità di recupero",
        recoveryModeOffSubtitle: "Non recuperare automaticamente questo gruppo.",
        recoveryModeWaitUntilResetSubtitle: "Attendi il ripristino del limite, poi riprendi.",
        recoveryModeSwitchThenResumeSubtitle: "Passa a un altro membro, poi riprendi.",
        recoveryModeSwitchOrWaitSubtitle: "Passa a un altro membro quando possibile, altrimenti attendi il ripristino.",
        recoveryPromptTitle: "Prompt di recupero",
        recoveryPromptSubtitle: "Usa i prompt standard di recupero e ripresa per questo gruppo.",
        missingTitle: "Gruppo non trovato",
        missingBody: ({ service, groupId }: { service: string; groupId: string }) =>
          `Nessun gruppo chiamato "${groupId}" esiste per ${service}.`,
      },

      connectPersonalAccessTokenTitle: "Connetti token di accesso personale",
      connectPersonalAccessTokenSubtitle: "Incolla un token di accesso personale fine-grained",
      connectApiTokenTitle: "Connetti token API",
      connectApiTokenSubtitle: "Incolla un token API del provider o una password app",
      openTokenSetupTitle: "Apri configurazione token",
      openTokenSetupSubtitle: "Apri la pagina di configurazione del provider",
      openPersonalAccessTokenSetupTitle: "Crea token di accesso personale",
      openPersonalAccessTokenSetupSubtitle: "Apri la configurazione del token fine-grained di GitHub",},
    profile: {
      profileId: "ID profilo",
      status: "Stato",
      email: "E-mail",
      accountId: "ID account",
      providerAccountId: "ID account del provider",
      quotaTitle: "Quote",
      defaultSubtitle: "Questo profilo è selezionato come predefinito",
      setDefaultSubtitle: "Usa questo profilo come predefinito",
      disconnectSubtitle: "Rimuovi le credenziali per questo profilo",
      reconnectSubtitle: "Ri-autentica questo profilo",
      replaceTokenSubtitle: "Sostituisci le credenziali per questo profilo",
      connectionGroupTitle: "Connessione",
      connectedVia: "Connesso tramite",
      connectedViaToken: "Token di accesso",
      connectedViaOauth: "OAuth",
      lastRefreshed: "Ultimo aggiornamento",
      refreshQuotaNow: "Aggiorna quota ora",
      refreshQuotaNowSubtitle: "Recupera l'utilizzo più recente per questo account.",
      poolsGroupTitle: "Pool",
      pools: {
        emptyTitle: "In nessun Pool",
        emptySubtitle: "Aggiungi questo account a un Pool per il fallback automatico.",
      },
      addToPool: "Aggiungi a un Pool",
      addToPoolSubtitle: "Usa questo account come fallback in un Pool.",
      settingsGroupTitle: "Impostazioni",
      setDefaultRowTitle: "Imposta come predefinito",
      removeGroupTitle: "Rimuovi",
    },
    authModal: {
      nativeAuthTitle: "Autenticazione nativa del backend",
      nativeAuthSubtitle: "Usa il login della CLI locale / chiavi API",
            groupSubtitle: 'Gruppo di account',
      connectedServicesTitle: "Usa servizi connessi",
      connectedServicesSubtitle: "Recupera e materializza dal cloud di Happier",
      notConnectedTitle: "Nessun servizio connesso",
      notConnectedSubtitle: "Tocca per aprire le impostazioni",
      profileLabel: "Profilo",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "File troppo grande",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Saltati ${count} ${plural({ count, singular: "file", plural: "file" })} che superano la dimensione massima dell’allegato.`,
      noClipboardImageTitle: "Nessuna immagine negli appunti",
      noClipboardImageBody: "Copia un'immagine e incollala come allegato.",
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
        invalidDirectoryMessage: "Usa un percorso relativo come .happier/uploads.",
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
    markdownEditMode: {
      title: 'Modalita di modifica Markdown predefinita',
      footer: 'Scegli come si aprono i file Markdown per la modifica. La modalita avanzata offre un editor WYSIWYG; la modalita grezza modifica direttamente il sorgente Markdown. I file che non possono essere convertiti in modo sicuro in entrambe le direzioni si aprono sempre come grezzi.',
      options: {
        rich: {
          title: 'Avanzata (WYSIWYG)',
          subtitle: 'Modifica Markdown visivamente con formattazione in tempo reale.',
        },
        raw: {
          title: 'Testo grezzo',
          subtitle: 'Modifica direttamente il sorgente Markdown.',
        },
      },
      disabledReason: {
        mdx: 'Modifica come testo grezzo perche questo e un file MDX.',
        tooLarge: "Modifica come testo grezzo perche questo file e troppo grande per l'editor avanzato.",
        referenceLinks: 'Modifica come testo grezzo perche questo file contiene link in stile riferimento.',
        footnotes: 'Modifica come testo grezzo perche questo file contiene note a pie di pagina.',
        htmlOrJsx: 'Modifica come testo grezzo perche questo file contiene HTML o JSX.',
      },
    },
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
      pull: {
        title: "Chiedi prima del pull",
        subtitle: "Mostra una conferma prima di scaricare modifiche remote.",
      },
      push: {
        title: "Chiedi prima del push",
        subtitle: "Mostra una conferma prima di inviare commit locali.",
      },

      confirmBeforePulling: {
        title: "Conferma prima del pull",
        subtitle: "Chiede prima di scaricare e integrare modifiche remote.",
      },
      confirmBeforePushing: {
        title: "Conferma prima del push",
        subtitle: "Chiede prima di caricare commit locali sul remoto.",
      },
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
      },},
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

  settingsDesktop: {
    title: 'Scrivania',
    footer: 'Controlla le integrazioni desktop di Tauri su questo computer.',
    startOnLoginTitle: 'Avvia all’accesso',
    startOnLoginSubtitle: 'Avvia Happier automaticamente quando accedi a questo computer.',

    overlay: {
      title: 'Desktop overlay',
      footer: 'Controls the local floating activity surface on this device.',
      enabledTitle: 'Enable desktop overlay',
      enabledSubtitle: 'Show a local floating activity surface on this device',
      visibilityModeTitle: 'Visibility mode',
      visibilityModeSubtitle: 'Choose when the overlay should appear',
      visibilityAttentionOnlyTitle: 'Attention only',
      visibilityActiveSessionsTitle: 'Active sessions',
      visibilityAlwaysWhenEnabledTitle: 'Always when enabled',
      showWhenRunningTitle: 'Show when running',
      showWhenRunningSubtitle: 'Show the overlay while sessions are running',
      showWhenAttentionRequiredTitle: 'Show when attention is required',
      showWhenAttentionRequiredSubtitle: 'Show the overlay when a session needs your input',
      showWhenReadyTitle: 'Show when ready',
      showWhenReadySubtitle: 'Show the overlay when a turn finishes and waits for input',
      alwaysOnTopTitle: 'Always on top',
      alwaysOnTopSubtitle: 'Keep the overlay above other windows',
      interactionTitle: 'Interaction',
      interactionFooter: 'Choose how the overlay behaves while it is visible.',
      autoHideEnabledTitle: 'Auto-hide',
      autoHideEnabledSubtitle: 'Hide the overlay after it has been idle',
      autoHideDelayTitle: 'Auto-hide delay',
      autoHideDelaySubtitle: 'Choose how long the overlay waits before hiding',
      autoHideDelay3sTitle: '3 seconds',
      autoHideDelay6sTitle: '6 seconds',
      autoHideDelay10sTitle: '10 seconds',
      autoHideDelay30sTitle: '30 seconds',
      expandedBehaviorTitle: 'Expanded behavior',
      expandedBehaviorSubtitle: 'Choose how the overlay expands',
      expandedBehaviorClickTitle: 'Click',
      expandedBehaviorHoverTitle: 'Hover',
      expandedBehaviorShortcutOnlyTitle: 'Shortcut only',
      interactiveCollapsedTitle: 'Collapsed is interactive',
      interactiveCollapsedSubtitle: 'Allow the collapsed overlay to respond to clicks',
      collapsedClickActionTitle: 'Collapsed click action',
      collapsedClickActionSubtitle: 'Choose what the overlay does when collapsed',
      collapsedClickActionExpandOverlayTitle: 'Expand overlay',
      collapsedClickActionOpenPrimarySessionTitle: 'Open primary session',
      collapsedClickActionOpenSessionsTitle: 'Open sessions list',
      placementTitle: 'Placement',
      placementFooter: 'Choose where the overlay sits on the screen.',
      presentationModeTitle: 'Presentation mode',
            presentationModeSubtitle: 'Choose whether the overlay follows the display notch or floats freely',
            presentationAutomaticTitle: 'Automatic',
            presentationNotchIntegratedTitle: 'Notch-integrated',
            presentationFloatingOverlayTitle: 'Floating overlay',
            hostModeFallbackTitle: 'Host mode: Floating overlay',
            hostModeFallbackSubtitle: 'Notch-integrated mode is unavailable on this display, so the overlay falls back to a floating overlay.',
            placementModeTitle: 'Placement mode',
            placementModeSubtitle: 'Switch between anchored and custom placement',
      placementAnchoredTitle: 'Anchored',
      placementCustomTitle: 'Custom',
      anchorPresetTitle: 'Anchor preset',
      anchorPresetSubtitle: 'Pick the anchor used for the overlay position',
      anchorTopCenterTitle: 'Top center',
      anchorTopLeftTitle: 'Top left',
      anchorTopRightTitle: 'Top right',
      anchorBottomCenterTitle: 'Bottom center',
      anchorBottomLeftTitle: 'Bottom left',
      anchorBottomRightTitle: 'Bottom right',
      anchorLeftCenterTitle: 'Left center',
      anchorRightCenterTitle: 'Right center',
      allowRepositioningTitle: 'Allow repositioning',
      allowRepositioningSubtitle: 'Let the overlay be dragged into a custom position',
      lockPositionTitle: 'Lock position',
      lockPositionSubtitle: 'Keep the overlay fixed in place',
      resetPositionTitle: 'Reset position',
      resetPositionSubtitle: 'Return to the default anchored position',
      presentationTitle: 'Presentation',
      presentationFooter: 'Tune how the overlay looks when it is collapsed.',
      densityTitle: 'Density',
      densitySubtitle: 'Choose the amount of spacing used in the overlay',
      densityCompactTitle: 'Compact',
      densityComfortableTitle: 'Comfortable',
      compactStyleTitle: 'Compact style',
      compactStyleSubtitle: 'Choose the shape used for the collapsed overlay',
      compactStylePillTitle: 'Pill',
      compactStylePanelTitle: 'Panel',
      showSessionCountTitle: 'Show session count',
      showSessionCountSubtitle: 'Show how many sessions are currently represented',
      showPreviewTextTitle: 'Show preview text',
      showPreviewTextSubtitle: 'Show the latest preview text when space allows',
    },},

  settingsPets: {
    title: 'Mascotte',
    previewTitle: 'Compagno Blink',
    previewSubtitle: 'Un piccolo compagno per lo stato della sessione e le revisioni da seguire.',
    disabledTitle: 'Le mascotte sono disattivate',
    disabledSubtitle: 'Attiva Mascotte in Funzioni per usare i compagni su questo dispositivo.',
    disabledByServerTitle: 'Questo server ha disattivato le mascotte',
    disabledByServerSubtitle: 'L’amministratore ha disattivato i compagni mascotte per questo server.',
    accountTitle: 'Impostazione predefinita account',
    enabledTitle: 'Attiva mascotte',
    enabledSubtitle: 'Mostra le superfici di compagnia per questo account.',
    companionSizeTitle: 'Dimensione mascotte',
    companionSizeSubtitle: 'Regola la dimensione del compagno su questo dispositivo.',
    companionSizeValue: ({ percent }: { percent: number }) => `${percent}%`,
    deviceOverrideTitle: 'Usa su questo dispositivo',
    deviceOverrideSubtitle: 'Sovrascrivi localmente l’impostazione mascotte dell’account.',
    sourceTitle: 'Origine mascotte',
    builtInSubtitle: 'Incluso in Happier.',
    builtInBlinkSubtitle: 'Trasforma i segnali di sessione in piccole luci di stato tranquille.',
    builtInFurySubtitle: 'Stressa i flussi difficili prima che arrivino in produzione.',
    builtInMiloSubtitle: 'Tiene ordinata la UI e sonnecchia sui test falliti.',
    builtInOliSubtitle: 'Spedisce fix furtivi prima che la build se ne accorga.',
    builtInTitiSubtitle: 'Smista le note di release con attenzione da staff senior.',
    localLibraryTitle: 'Questo dispositivo',
    localLibraryFooter: 'Le mascotte locali restano su questo dispositivo salvo importazione nell’account.',
    helpDocsTitle: 'Aiuto mascotte',
    helpDocsSubtitle: 'Apri la documentazione Happier per configurazione e risoluzione problemi.',
    detectCodexPetsTitle: 'Rileva mascotte Codex',
    detectCodexPetsSubtitle: 'Cerca mascotte compatibili nelle home Codex locali.',
    detectedCodexPetsTileSubtitle: 'Trovata in Codex e pronta a unirsi a questo dispositivo.',
    detectedCodexPetsEmptyTitle: 'Nessuna mascotte Codex trovata',
    detectedCodexPetsEmptySubtitle: 'Creane una in Codex, quindi esegui di nuovo il rilevamento.',
    detectedCodexPetsErrorTitle: 'Impossibile rilevare mascotte Codex',
    detectedCodexPetsErrorSubtitle: 'Controlla che il daemon sia connesso e riprova.',
    detectedCodexPetsNoTargetTitle: 'Nessun daemon disponibile',
    detectedCodexPetsNoTargetSubtitle: 'Avvia Happier su questo computer, quindi rileva di nuovo le mascotte Codex.',
    detectedCodexPetsDaemonMismatchTitle: 'Aggiorna il daemon per rilevare mascotte',
    detectedCodexPetsDaemonMismatchSubtitle: 'Questo daemon non espone ancora il rilevamento mascotte. Aggiorna lo stack e riprova.',
    useOnThisDeviceTitle: 'Usa su questo dispositivo',
    useOnThisDeviceSubtitle: 'Seleziona una mascotte locale senza modificare il valore predefinito dell’account.',
    importedLocalSubtitle: 'Importata da Codex su questo dispositivo.',
    removeFromDeviceTitle: 'Rimuovi dal dispositivo',
    removeFromDeviceSubtitle: 'Rimuovi questa mascotte locale da questo dispositivo.',
    accountLibraryTitle: 'Libreria account',
    accountLibraryFooter: 'Le mascotte sincronizzate sono disponibili sui dispositivi con accesso.',
    accountPetTileSubtitle: 'Sincronizzata dal tuo account.',
    removeFromDeviceDaemonErrorTitle: 'Rimossa localmente; pulizia del daemon non riuscita',
    removeFromDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `La mascotte è stata rimossa dall’elenco di questo dispositivo, ma la pulizia del daemon ha restituito ${code}.`,
    importToDeviceDaemonErrorTitle: 'Impossibile importare la mascotte',
    importToDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `Il daemon non ha potuto importare questa mascotte. Rileva di nuovo le mascotte Codex e riprova. (${code})`,
    importToAccountTitle: 'Importa nell’account',
    importToAccountSubtitle: 'Carica una mascotte locale compatibile per usarla tra dispositivi.',
    desktopOverlayTitle: 'Sovrapposizione desktop',
    overlayTrayTitle: 'Attività della mascotte',
    overlayStatusWaiting: 'In attesa',
    overlayStatusFailed: 'Non riuscito',
    overlayStatusReview: 'Revisione',
    overlayStatusRunning: 'In esecuzione',
    overlayQuickReplyPlaceholder: 'Risposta rapida',
    overlayReplyAction: 'Rispondi',
    overlayQuickReplyAction: 'Invia risposta rapida',
    overlayDismissAction: 'Ignora attività',
    overlayTuckAction: 'Nascondi',
    overlayClosePetAction: 'Chiudi mascotte',
    desktopOverlayEnabledTitle: 'Attiva sovrapposizione desktop',
    desktopOverlayEnabledSubtitle: 'Mostra la mascotte in una finestra desktop trasparente.',
    desktopOverlayDeviceOverrideTitle: 'Sovrapposizione desktop su questo dispositivo',
    desktopOverlayVisibilityModeTitle: 'Visibilità della sovrapposizione su questo dispositivo',
    desktopOverlayVisibilityModeSubtitle: 'Scegli quando la mascotte desktop appare localmente.',
    desktopOverlayResetPositionTitle: 'Ripristina posizione',
    desktopOverlayResetPositionSubtitle: 'Riporta la sovrapposizione nell’angolo in basso a destra.',
    overrideInherit: 'Valore account',
    overrideEnabled: 'Attivato',
    overrideDisabled: 'Disattivato',
    visibilityModeInherit: 'Valore account',
    visibilityModeAlwaysWhenEnabled: 'Sempre quando attiva',
    visibilityModeAttentionOrActive: 'Attenzione o attività',
    visibilityModeAttentionOnly: 'Solo attenzione',
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
    desktop: {
      title: "Notifiche desktop",
      footer: "Verifica la consegna delle notifiche locali per questa app desktop.",
      permission: {
        title: "Permesso di sistema",
        checkingSubtitle: "Controllo del permesso notifiche di macOS",
        grantedSubtitle: "macOS consente a questa app di inviare notifiche",
        notGrantedSubtitle: "Tocca per richiedere il permesso notifiche di macOS",
        errorSubtitle: "Impossibile leggere il permesso notifiche di macOS",
      },
    },
    push: {
      title: "Notifiche push",
      footer:
        "Queste notifiche vengono inviate dal tuo CLI tramite Expo quando la sessione richiede attenzione.",
      enabledSubtitle: "Consenti le notifiche push su questo account",
      troubleshootTitle: "Risoluzione problemi",
      troubleshootSubtitle: "Vedi permessi e dispositivi registrati",
    },
    pushPriming: {
        title: 'Attivare le notifiche?',
        body: 'Happier può avvisarti quando un agente termina, richiede una decisione sui permessi o è in attesa. Puoi modificarlo in qualsiasi momento nelle Impostazioni.',
        accept: 'Attiva',
        decline: 'Non ora',
        blockedTitle: 'Le notifiche sono bloccate',
        blockedBody: 'Le notifiche sono disattivate per questa app nelle impostazioni di sistema. Apri le impostazioni per consentirle.',
        openSettings: 'Apri impostazioni',
        openSettingsFailed: 'Impossibile aprire le impostazioni di sistema.',
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
        runtimeUnavailable: 'Non disponibile',
        runtimeUnavailableSubtitle: 'Non è stato possibile raggiungere il servizio di notifiche su questo dispositivo.',
        runtimeTimeoutSubtitle: 'Il servizio di notifiche non ha risposto. Verifica la connessione al server di sviluppo e riprova.',
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
        checkingSubtitle: 'Lettura del token di questo dispositivo…',
        runtimeUnavailableSubtitle: 'Non è stato possibile raggiungere il servizio di notifiche su questo dispositivo.',
        runtimeTimeoutSubtitle: 'Il servizio di notifiche non ha risposto in tempo.',
        deviceUnavailableSubtitle: 'Questa build non può fornire un token push. Verifica che le notifiche push siano abilitate per questa build.',
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

      account: "Predefinito account",
      accountDescription:
        "Usa il comportamento delle notifiche in-app dell'account su questo dispositivo",},
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

    activitySurfaces: {
      title: "Superfici attività",
      footer:
        "Controlla Live Activities, Dynamic Island e widget su questo dispositivo.",
      enabledSubtitle:
        "Abilita le superfici di sessione visibili su questo dispositivo",
      shared: {
        title: "Comportamento condiviso",
        footer:
          "Scegli come devono comportarsi i tocchi e il contenuto di anteprima su tutte le superfici attività.",
      },
      tapTargetTitle: "Destinazione del tocco",
      tapTargetOpenSessionTitle: "Apri la sessione corrente",
      tapTargetOpenSessionsTitle: "Apri le sessioni attive",
      privacyTitle: "Privacy",
      privacyStatusOnlyTitle: "Solo stato",
      privacyTitleOnlyTitle: "Solo titolo",
      privacyIncludePreviewTitle: "Includi testo di anteprima",
      liveActivities: {
        title: "Live Activities",
        footer:
          "Controlla la presentazione sulla schermata di blocco e su Dynamic Island su iPhone.",
        enabledSubtitle: "Abilita le Live Activities su questo dispositivo",
        strategyTitle: 'Activity strategy',
        strategySubtitle: 'Scegli se un’attività segue la sessione più importante o resta fissata.',
        presentationTitle: 'Modalità di presentazione',
        presentationSubtitle: 'Scegli come le Live Activities devono mettere in evidenza la sessione corrente.',
        focusedTitle: "Sessione focalizzata",
        attentionTitle: "Attenzione",
        runningTitle: "Sessioni in corso",
        dynamicPrimaryTitle: 'Dynamic primary',
        pinnedPrimaryTitle: 'Pinned primary',
        sessionSpecificTitle: 'Session specific',
        maxConcurrentTitle: "Massimo di attività simultanee",
        maxConcurrentOneTitle: "1 attività",
        maxConcurrentTwoTitle: "2 attività",
        maxConcurrentFourTitle: "4 attività",
        previewTextTitle: "Testo di anteprima",
        actionButtonsTitle: "Pulsanti azione",
        includeReadyTitle: "Includi sessioni pronte",
        includeThinkingTitle: "Includi sessioni in pensiero",
        remoteUpdates: {
          title: "Aggiornamenti remoti",
          footer: "Diagnostica del server selezionato per aggiornare le Live Activities quando l'app non è più in primo piano.",
          effectiveModeTitle: "Consegna effettiva",
          effectiveMode: {
            hosted_happier_relay: "Relay ospitato",
            direct_apns: "APNs diretto",
            background_wake_best_effort: "Risveglio in background",
            local_only: "Solo runtime locale",
            disabled: "Disabilitato",
          },
          details: {
            available: "Disponibile",
            unavailable: "Non disponibile",
            blocked: "Bloccato",
            missingCredentials: "Credenziali mancanti",
            bestEffort: "Massimo impegno",
            selected: "Selezionato",
            fallback: "Ripiego",
            preferred_unavailable: "Solo locale",
            local_only: "Solo locale",
            disabled: "Disabilitato",
            runtimeOnly: "Solo runtime",
          },
          hostedRelayTitle: "Relay Happier ospitato",
          hostedRelayAvailableSubtitle: "Il relay ospitato è configurato per questo server selezionato.",
          hostedRelayDisabledSubtitle: "Il relay ospitato è disabilitato per questo server self-hosted.",
          hostedRelayBlockedSubtitle: "L'identità del relay ospitato e il supporto del provider non sono ancora implementati.",
          hostedRelayUnavailableSubtitle: "Il relay ospitato non è disponibile da questo server selezionato.",
          directApnsTitle: "APNs diretto",
          directApnsConfiguredSubtitle: "Le credenziali APNs dirette sono configurate senza esporre materiale segreto.",
          directApnsMissingCredentialsSubtitle: "Ad APNs diretto manca la configurazione server delle credenziali.",
          directApnsUnavailableSubtitle: "APNs diretto non è disponibile per questo server selezionato.",
          backgroundWakeTitle: "Risveglio in background",
          backgroundWakeBestEffortSubtitle: "Il risveglio in background può provare ad aggiornare, ma iOS può rinviarlo o scartarlo.",
          backgroundWakeDisabledSubtitle: "Il fallback di risveglio in background è disabilitato su questo server selezionato.",
          localOnlyTitle: "Aggiornamenti solo locali",
          localOnlyRuntimeSubtitle: "Gli aggiornamenti solo locali funzionano finché il runtime dell'app può essere eseguito; non promettono aggiornamenti con app chiusa.",
        },
      },
      widgets: {
        title: "Widget della schermata Home",
        footer:
          "Controlla la panoramica dei widget mostrata nella schermata Home del dispositivo.",
        enabledSubtitle: "Abilita i widget su questo dispositivo",
        summaryTitle: "Riepilogo",
        attentionTitle: "Attenzione",
        runningTitle: "Sessioni in corso",
        previewTextTitle: "Testo di anteprima",
        machinePathTitle: "Macchina e percorso",
      },
    },
    quietHours: {
      title: "Ore silenziose",
      footer: "Le ore silenziose dell'account si applicano ovunque per impostazione predefinita. Le modifiche del dispositivo valgono solo per questo dispositivo.",
      accountOffTitle: "Nessuna ora silenziosa dell'account",
      accountOffSubtitle: "Consegna le notifiche dell'account in qualsiasi momento",
      accountNightlyTitle: "Ogni notte, dalle 22:00 alle 7:00",
      accountNightlySubtitle: "Silenzia o sopprimi i canali di attenzione durante la notte",
      deviceAccountTitle: "Questo dispositivo segue gli orari dell'account",
      deviceAccountSubtitle: "Usa la policy sincronizzata delle ore silenziose dell'account",
      deviceDisabledTitle: "Disabilita le ore silenziose su questo dispositivo",
      deviceDisabledSubtitle: "Consenti a questo dispositivo di consegnare anche durante le ore silenziose dell'account",
      deviceCustomNightlyTitle: "Questo dispositivo usa ore silenziose notturne",
      deviceCustomNightlySubtitle: "Sostituisci gli orari dell'account con 22:00-7:00 su questo dispositivo",
    },
    sounds: {
      title: "Suoni",
      footer: "Le impostazioni audio predefinite dell'account si sincronizzano ovunque. Questo dispositivo può silenziare i suoni locali.",
      accountHappierTitle: "Suoni di Happier",
      accountHappierSubtitle: "Usa un tono più morbido per gli aggiornamenti e uno più chiaro quando serve attenzione",
      accountDefaultTitle: "Predefinito di sistema",
      accountDefaultSubtitle: "Usa il suono di notifica della piattaforma",
      accountSilentTitle: "Silenzioso",
      accountSilentSubtitle: "Consegna notifiche senza suono",
      deviceEnabledTitle: "Riproduci suoni su questo dispositivo",
      deviceEnabledSubtitle: "Sostituzione del dispositivo per i suoni delle notifiche locali",
      previewTitle: "Anteprima suono",
      previewSubtitle: "Invia una notifica locale di anteprima su questo dispositivo",
      previewNotificationTitle: "Anteprima del suono di notifica",
      previewNotificationBody: "Ecco come si comporterà il suono di notifica attuale.",
    },},

    notifications: {
      actions: {
        allow: 'Consenti',
        deny: 'Nega',
        answer: 'Rispondi',

        other: 'Altro',
        alwaysAllowTool: ({ tool }: { tool: string }) => `Consenti sempre ${tool}`,},
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

  settingsProviders: settingsProvidersTranslations.it,

  settingsAgents: {
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
      channelPlugin: "Plug-in",
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
      installInfoUseAgentCliInstaller: "Usa l'installer CLI del provider",
      setup: {
          selectionFooter: "Scegli uno o più provider, poi completali uno alla volta sulla macchina selezionata.",
          startTitle: "Configura i provider",
          startDescription: "Metti in coda i provider selezionati e completa installazione e accesso in un unico flusso canonico.",
          queueTitle: "Coda configurazione provider",
          queueDescription: ({ provider }: { provider: string }) => `Completa ${provider}, poi continua con il provider successivo nella coda.`,
          activeDescription: "Provider attuale nella coda",
          activeStatus: "In corso",
          completedStatus: "Completato",
          skippedStatus: "Saltato",
          skipAction: "Salta questo provider",
          completedTitle: "Configurazione provider completata",
          completedDescription: "Hai raggiunto la fine della coda di provider selezionata.",
      },
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
                    claudeUnifiedTerminal: {
                        title: "Terminale unificato Claude",
                        footer: "Esegue Claude Code in una sessione ospitata nel terminale e permette a Happier di inviare prompt supportati tramite l'host del terminale."
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
                    claudeUnifiedTerminalEnabled: {
                        title: "Usa la modalita terminale unificata",
                        subtitle: "Mantiene Claude Code come sessione terminale canonica e invia i prompt Happier supportati in quella sessione."
                    },
                    claudeUnifiedTerminalHost: {
                        title: "Host terminale",
                        subtitle: "Scegli quale multiplexer di terminale usa Happier per le sessioni Claude unificate.",
                        options: {
                            auto: {
                                title: 'Automatico',
                                subtitle: "Preferisce il miglior host supportato su questa macchina."
                            },
                            tmux: {
                                title: "tmux",
                                subtitle: "Usa tmux quando e disponibile."
                            },
                            zellij: {
                                title: 'zellij',
                                subtitle: "Usa Zellij quando e disponibile e supportato."
                            }
                        }
                    },
                    claudeUnifiedTerminalResumeChoice: {
                        title: "Ripresa di sessioni grandi",
                        subtitle: "Scegli come risponde Happier quando Claude chiede come riprendere una sessione grande.",
                        options: {
                            ask_every_time: {
                                title: "Chiedi ogni volta",
                                subtitle: "Mostra un'azione utente nella sessione ogni volta che Claude lo chiede."
                            },
                            resume_from_summary: {
                                title: "Riprendi dal riepilogo",
                                subtitle: "Usa il riepilogo di Claude per riprendere piu rapidamente le sessioni grandi."
                            },
                            resume_full_session: {
                                title: "Riprendi sessione completa",
                                subtitle: "Carica tutto il contesto della sessione quando Claude offre la scelta."
                            }
                        }
                    },
                    claudeUnifiedTerminalWorkspaceTrust: {
                        title: "Fiducia nello spazio di lavoro",
                        subtitle: "Scegli come Happier risponde quando Claude chiede se considerare attendibile uno spazio di lavoro.",
                        options: {
                            ask_every_time: {
                                title: "Chiedi ogni volta",
                                subtitle: "Mostra la domanda esatta sull'attendibilità dell'area di lavoro nella sessione."
                            },
                            always_trust_happier_workspaces: {
                                title: "Affidati sempre agli spazi di lavoro Happier.",
                                subtitle: "Considera attendibile il prompt Claude correntemente riconquistato per gli spazi di lavoro aperti da Happier."
                            },
                            always_reject_happier_workspaces: {
                                title: "Rifiuta sempre gli spazi di lavoro Happier.",
                                subtitle: "Rifiuta il prompt Claude corrente riconquistato per gli spazi di lavoro aperti da Happier."
                            }
                        }
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Usa Agent SDK (remoto)",
                        subtitle: "Usa l’@anthropic-ai/claude-agent-sdk ufficiale per la modalita remota."
                    },
                    claudeRemoteDebugEnabled: {
                        title: "Modalita debug",
                        subtitle: "Abilita i log di debug di Claude Code (equivalente a --debug)."
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "Dettagliato",
                        subtitle: "Abilita il logging verboso (equivalente a --verbose)."
                    },
                    claudeRemoteDebugCategories: {
                        title: "Categorie debug",
                        subtitle: "Filtro opzionale delle categorie. Se vuoto, Claude registra tutte le categorie debug.",
                        options: {
                            api: {
                                title: "API",
                                subtitle: "Richieste e risposte HTTP/API."
                            },
                            mcp: {
                                title: "MCP",
                                subtitle: "Connessioni ai server MCP e traffico degli strumenti."
                            },
                            hooks: {
                                title: "Hooks",
                                subtitle: "Ciclo di vita degli hook ed esecuzione dei comandi."
                            },
                            file: {
                                title: "File",
                                subtitle: "Operazioni sul filesystem e helper file."
                            },
                            '1p': {
                                title: "1p",
                                subtitle: "Categoria interna first-party."
                            }
                        }
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
                        footer: "Lascia vuoto per usare il ciclo di vita del server OpenCode gestito da Happier. Imposta un URL HTTPS assoluto per qualsiasi server gestito da te, oppure HTTP solo per localhost. Metti la password nel campo qui sotto, mai nell’URL."
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
                        subtitle: "Override opzionale per un server gestito da te. HTTPS può usare qualsiasi host; HTTP è limitato a localhost."
                    },
                    opencodeServerPassword: {
                        title: "Password del server OpenCode esistente",
                        subtitle: "Impostala solo se il tuo server OpenCode viene eseguito con OPENCODE_SERVER_PASSWORD. Viene salvata cifrata su questo dispositivo e non è mai sincronizzata."
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
                title: "Kimi",
                sections: {
                    compatibility: {
                        title: 'Compatibilità',
                        footer: 'Usa la modalità compatibilità solo in ambienti Linux/container in cui l\'avvio di Kimi ACP si blocca.'
                    }
                },
                fields: {
                    kimiAcpPythonSelector: {
                        title: 'Selettore stdio Python',
                        subtitle: 'Scegli come Happier avvia il ciclo stdio Python di Kimi ACP.',
                        options: {
                            auto: {
                                title: 'Automatico',
                                subtitle: 'Usa il selettore Python predefinito di Kimi.'
                            },
                            poll: {
                                title: 'Modalità compatibilità',
                                subtitle: 'Usa poll() invece di epoll() per lo stdio di Kimi ACP.'
                            }
                        }
                    }
                }
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
            antigravity: {
                title: "Antigravity",
                sections: {
                    runtime: {
                        title: "Ambiente di esecuzione",
                        footer: "Scegli come avviare le sessioni Antigravity. La modalità CLI usa il login dell'abbonamento con controlli live ridotti; la modalità SDK usa credenziali Gemini API o Vertex."
                    }
                },
                fields: {
                    antigravityRuntimeMode: {
                        title: "Modalità runtime",
                        subtitle: "Seleziona routing automatico, modalità print della CLI con abbonamento o modalità SDK.",
                        options: {
                            auto: {
                                title: "Automatico",
                                subtitle: "Preferisce la CLI con abbonamento quando disponibile, poi le credenziali SDK."
                            },
                            cliPrint: {
                                title: "Antigravity CLI (abbonamento)",
                                subtitle: "Usa la modalità print di agy con il login locale; le approvazioni live degli strumenti sono ridotte."
                            },
                            sdk: {
                                title: "SDK Antigravity (Gemini API / Vertex)",
                                subtitle: "Usa una chiave Gemini API o credenziali Vertex tramite l'SDK."
                            }
                        }
                    }
                }
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

  workspaceCockpit: {
    sessionPosition: ({ position, total }: { position: number; total: number }) => position + ' di ' + total,
    previousSession: 'Sessione precedente',
    nextSession: 'Sessione successiva',
    switchedToSession: ({ name, position, total }: { name: string; position: number; total: number }) => 'Passaggio a ' + name + ', ' + position + ' di ' + total,
    openCockpit: 'Apri cockpit',
    openClassicView: 'Apri vista classica',
    tabs: 'Schede',
  },

  settingsAppearance: {
    tabBarAppearance: {
      title: 'Barra schede',
      footer: 'Personalizza la barra delle schede in basso.',
      showLabels: 'Mostra etichette schede',
      size: 'Dimensione barra schede',
      sizeCompact: 'Compatta',
      sizeRegular: 'Normale',
      sizeLarge: 'Grande',
    },
    glass: {
      title: 'Superfici in vetro',
      footer: 'Usa un materiale sfocato traslucido per le superfici in vetro fluttuanti: la barra delle schede, il pulsante per andare in fondo e altro ancora.',
      enable: 'Sfocatura vetro',
      intensity: 'Intensità sfocatura',
      intensityLight: 'Leggera',
      intensityRegular: 'Normale',
      intensityStrong: 'Forte',
      composer: 'Compositore in vetro',
      composerHint: 'Abbina la barra delle schede — usa il suo colore di superficie e proietta un\'ombra per il compositore di messaggi.',
    },
    tabBarBadges: {
      title: 'Badge della barra schede',
      footer: 'Scegli quali badge mostrare nella barra delle schede in basso.',
      gitTitle: 'Badge della scheda Git',
      gitChangedFiles: 'File modificati',
      gitDiffLines: 'Righe aggiunte e rimosse',
      gitOff: 'Disattivato',
    },
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
    contentWidth: "Larghezza contenuto",
    contentWidthDescription:
      "Scegli quanto può allargarsi il contenuto principale",
    contentWidthOptions: {
      compact: "Compatta",
      compactDescription: "Mantieni il contenuto principale limitato a 850 px",
      medium: "Media",
      mediumDescription: "Consenti al contenuto principale di arrivare a 960 px",
      full: "Larghezza completa",
      fullDescription: "Usa la larghezza disponibile della finestra",
    },
    backdropBlur: "Sfocatura sfondo",
    backdropBlurDescription:
      "Usa la sfocatura dello sfondo dietro modali e menu. Disattivala per migliorare le prestazioni del browser.",
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
      meshGradient: "Gradiente mesh",
      meshGradientOrganic: "Gradiente mesh: organico",
      meshGradientRows: "Gradiente mesh: righe",
      meshGradientColumns: "Gradiente mesh: colonne",
      meshGradientDiagonal: "Gradiente mesh: diagonale",
      meshGradientOval: "Gradiente mesh: ovale",
      meshGradientWaves: "Gradiente mesh: onde",
      meshGradientSoftNoise: "Gradiente mesh: rumore morbido",
      photoGradient: "Gradiente stratificato",
      photoGradientRows: "Gradiente stratificato: righe",
      photoGradientColumns: "Gradiente stratificato: colonne",
      photoGradientDiagonal: "Gradiente stratificato: diagonale",
      photoGradientWaves: "Gradiente stratificato: onde",
      photoGradientOval: "Gradiente stratificato: ovale",
      photoGradientValueNoise: "Gradiente stratificato: rumore morbido",
      photoGradientVoronoi: "Gradiente stratificato: celle",
      photoGradientMeshGrid: "Gradiente stratificato: griglia",
    },
    showFlavorIcons: "Mostra icone provider IA",
    showFlavorIconsDescription:
      "Mostra le icone del provider IA sugli avatar di sessione",
    compactSessionView: "Vista sessioni compatta",
    compactSessionViewDescription:
      "Mostra le sessioni attive in un layout più compatto",
    compactSessionViewMinimal: "Vista compatta minima",
    compactSessionViewMinimalDescription:
      "Usa il layout di riga sessione più stretto",
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

    settingsNavSidebar: "Barra laterale delle impostazioni",
    settingsNavSidebarDescription:
      "Mostra la barra laterale di navigazione delle impostazioni (web/tablet)",},

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
      expMarkdownRichEditor: 'Editor Markdown avanzato',
      expMarkdownRichEditorSubtitle:
        "Abilita un editor avanzato (WYSIWYG) per i file Markdown nell'editor file, con ripiego al testo grezzo quando necessario",
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
      expVoiceDaemonInference: 'Inferenza vocale daemon',
      expVoiceDaemonInferenceSubtitle: 'Attiva i controlli di inferenza vocale locale gestiti dal daemon',
      expLiveActivities: 'Live Activities',
      expLiveActivitiesSubtitle: 'Attiva le superfici Live Activities per l’avanzamento della sessione',
      expHomeScreenWidgets: 'Widget schermata Home',
      expHomeScreenWidgetsSubtitle: 'Attiva i widget della schermata Home per l’attività Happier',
      expConnectedServicesQuotas: "Quote servizi connessi",
      expConnectedServicesQuotasSubtitle:
        "Mostra badge quota e indicatori di utilizzo per i servizi connessi",
      expMemorySearch: "Ricerca memoria",
      expMemorySearchSubtitle:
        "Abilita schermate e impostazioni di ricerca memoria locale",
    expSessionsDirect: "Sessioni esterne",
    expSessionsDirectSubtitle: "Scopri e collega sessioni esistenti degli agenti nella barra laterale",
    expSessionsFolders: "Cartelle sessioni",
    expSessionsFoldersSubtitle: "Organizza le sessioni Happier della barra laterale in cartelle workspace",
    expPetsCompanion: "Mascotte",
    expPetsCompanionSubtitle: "Attiva le superfici compagno di Blink e la selezione locale delle mascotte",
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
      historyScopePerSession: "Scorri cronologia per sessione",
      historyScopeGlobal: "Scorri cronologia su tutte le sessioni",
      historyScopeModalTitle: "Cronologia messaggi",
      historyScopeModalMessage:
        "Scegli se Freccia su/Freccia giù scorre solo i messaggi inviati in questa sessione o in tutte le sessioni.",
      historyScopePerSessionOption: "Per sessione",
      historyScopeGlobalOption: "Globale",
      commandPalette: "Palette comandi",
      commandPaletteEnabled: "Usa la scorciatoia per aprire",
      commandPaletteDisabled: "Accesso rapido ai comandi disabilitato",
      hideInactiveSessions: "Nascondi sessioni inattive",
      hideInactiveSessionsSubtitle: "Mostra solo le chat attive nella tua lista",
      hiddenInactiveSessionsEmptyStateTitle: "Nessuna sessione attiva in questo momento",
      hiddenInactiveSessionsEmptyStateSubtitle: "Le sessioni inattive sono nascoste in questo elenco",
      hiddenInactiveSessionsSectionTitle: "Sessioni inattive",
      hiddenInactiveSessionsSectionSubtitle: "Nascoste nell'elenco principale perché lì vengono mostrate solo le chat attive",
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
      signupDisabled: "Questo server ha disattivato la creazione di nuovi account. Accedi con un account esistente o chiedi all'amministratore del server di attivare le registrazioni.",
      failedToForkSession: "Impossibile derivare la sessione",
      daemonUnavailableTitle: "Daemon non disponibile",
      daemonUnavailableBody:
        "Happier non riesce a raggiungere il daemon su questa macchina. Potrebbe essere offline, in avvio o disconnesso dal server.",
      tryAgain: "Per favore riprova",
      contactSupport: "Contatta l'assistenza se il problema persiste",
      sessionNotFound: "Sessione non trovata",
      voiceSessionFailed: "Avvio della sessione vocale non riuscito",
      dictationFailed: "Dettatura non riuscita",
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

    sourceControlUnavailableForSession: "Il controllo del codice sorgente non è disponibile per questa sessione.",},

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
      githubCli: {
        title: "CLI GitHub",
      },

      gh: {
        title: "GitHub CLI",
      },},
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
      pendingWorktreeSubtitle: ({ branch, path }: { branch: string; path: string }) => `Da ${branch} · ${path}`,
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
      "Impossibile avviare la sessione. Riprova o controlla la macchina e le impostazioni della sessione selezionate.",
    actionMethodUnavailable: "Aggiorna Happier sulla macchina di destinazione per creare una nuova sessione.",
    sessionTimeout:
      "Avvio sessione scaduto. La macchina potrebbe essere lenta o il daemon potrebbe non rispondere.",
    notConnectedToServer:
      "Non connesso al server. Controlla la tua connessione Internet.",
    daemonRpcUnavailableTitle: "Daemon non disponibile",
    daemonRpcUnavailableBody:
      "Happier non riesce a raggiungere il daemon su questa macchina. Potrebbe essere offline, in avvio o disconnesso dal server.",
    launchStillPendingTitle: "L’avvio è ancora in corso",
    launchStillPendingBody:
      "Happier non ha ancora confermato la nuova sessione. La richiesta di avvio è ancora salvata. Riprova per continuare lo stesso avvio senza creare una sessione duplicata.",
    connectedServiceSwitchUnavailable: {
      startFreshAction: "Ricomincia da capo con il nuovo account",
    },
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
      inThisFolderTitle: "In questa cartella",
      openInTreeBrowserLabel: "Apri nel browser ad albero",
      openFolderLabel: "Mostra contenuto della cartella",
      emptyInThisFolder: "Nessuna corrispondenza in questa cartella",
      favoriteAdd: "Aggiungi ai preferiti",
      favoriteRemove: "Rimuovi dai preferiti",
      hints: {
        navigate: "naviga",
        commit: "conferma percorso",
        autocomplete: "completa",
        walkUp: "sali di un livello",
      },
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
      createTitle: "Nuova worktree da un branch",
      backToRoot: "Alberi di lavoro",
      searchPlaceholder: "Cerca worktrees",
      searchBranchPlaceholder: "Cerca branch",
      sections: {
        localBranches: "BRANCH LOCALI",
        remoteBranches: "BRANCH REMOTI",
      },
      statusPill: {
        clean: "pulita",
        idle: "inattivo",
        // FR4-10: StatusPill renders the count separately; suffix-only.
        changesSuffix: ({ count }: { count: number }) =>
          count === 1 ? "modifica" : "modifiche",
      },
      branchRow: {
        reuseLabel: "Ha un worktree",
        reuseSubtitle: ({ path }: { path: string }) => path,
      },
      nameStep: {
        title: "Assegna un nome al worktree",
        backLabel: "Branch",
        placeholder: "Assegna un nome a questo worktree",
        emptyHint: "Diventerà il nome del nuovo branch e del worktree.",
        suggestedSectionTitle: "Suggerito",
        suggestedSubtitle: "Usa il nome generato",
        useSuggested: ({ name }: { name: string }) => `Usa il nome suggerito: ${name}`,
        createNamed: ({ name }: { name: string }) => `Crea worktree: ${name}`,
        customHint: "Oppure digita un nome sopra per un worktree personalizzato",
        hints: {
          create: "crea",
          back: "indietro",
        },
      },
      reuseOrCreate: {
        title: "Il branch ha già un worktree",
        useExisting: "Usa worktree esistente",
        createNew: "Crea nuovo worktree da questo branch",
        createNewSubtitle: "Dirama in un nuovo worktree con nome",
      },
      hints: {
        navigate: "naviga",
        select: "seleziona",
        back: "indietro",
      },
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
        githubCliBanner: {
            title: 'GitHub CLI',
            install: 'Installa',
            update: 'Aggiorna',
            reinstall: 'Reinstalla',
        },
    githubCliInstallModal: {
      installTitle: "Installare GitHub CLI?",
      updateTitle: "Aggiornare GitHub CLI?",
      reinstallTitle: "Reinstallare GitHub CLI?",
      description:
        "Questo installa GitHub CLI così Happier può usare la tua autenticazione GitHub locale per i flussi di pull request.",
    },

    ghCliBanner: {
      title: "GitHub CLI",
      install: "Installa",
      update: "Aggiorna",
      reinstall: "Reinstalla",
    },
    ghCliInstallModal: {
      installTitle: "Installare GitHub CLI?",
      updateTitle: "Aggiornare GitHub CLI?",
      reinstallTitle: "Reinstallare GitHub CLI?",
      description:
        "Questo installa la dipendenza opzionale GitHub CLI usata dai flussi di controllo sorgente GitHub dopo la conferma.",
    },},

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
    providerBinding: providerSessionTranslations.it,
    transcriptNavigation: {
      title: "Naviga",
      modeAll: "Tutti",
      modePinned: "Fissati",
      entryCount: ({ count }: { count: number }) => `${count} ${count === 1 ? "voce" : "voci"}`,
      pinnedCount: ({ count }: { count: number }) => `${count} fissati`,
      emptyPinnedTitle: "Nessun messaggio fissato",
      emptyPinnedBody: "Fissa i messaggi per tenere qui i turni importanti.",
      emptyAllTitle: "Nessuna voce di navigazione",
      emptyAllBody: "I turni utente e i messaggi fissati appariranno qui.",
      entryA11y: ({ label }: { label: string }) => `Vai a ${label}`,
      entryPinnedA11y: ({ label }: { label: string }) => `Vai al messaggio fissato: ${label}`,
      fallbackPinnedAssistant: "Messaggio assistente fissato",
      fallbackPinnedTool: "Messaggio strumento fissato",
      fallbackPinnedMessage: "Messaggio fissato",
      pinMessageA11y: "Fissa messaggio",
      unpinMessageA11y: "Rimuovi fissaggio messaggio",
      pinToolCallA11y: "Fissa chiamata strumento",
      unpinToolCallA11y: "Rimuovi fissaggio chiamata strumento",
      jumpFailed: "Impossibile passare a questo messaggio.",
      replyNotLoaded: "Risposta non caricata",
      awaitingReply: "In attesa di risposta",
      loadingBody: "Caricamento della navigazione della trascrizione…",
      railScrollUpA11y: "Scorri la navigazione verso l’alto",
      railScrollDownA11y: "Scorri la navigazione verso il basso",
      emptyPinnedHint: "Passa il cursore su un messaggio e scegli l'icona di fissaggio per fissarlo.",
      emptyPinnedPrivacy: "I messaggi fissati vengono salvati solo su questo dispositivo.",
    },

    inputPlaceholder: "Scrivi un messaggio ...",
    workState: {
      accessibilityLabel: "Stato di lavoro della sessione",
      commandDescription: "Imposta o consulta l’obiettivo della sessione",
      unsupportedTitle: "Obiettivo non disponibile",
      unsupportedMessage:
        "Questo backend non supporta ancora obiettivi di sessione modificabili.",
      notReadyTitle: "Controlli dell'obiettivo non ancora pronti",
      notReadyMessage:
        "Questa sessione è ancora in fase di avvio. Riprova a impostare l'obiettivo tra un momento.",
      noCurrentGoalTitle: "Nessun obiettivo da aggiornare",
      noCurrentGoalMessage:
        "Imposta un obiettivo prima di metterlo in pausa o riprenderlo.",
      dirtyCloseTitle: "Scartare le modifiche all’obiettivo?",
      dirtyCloseBody: "Le modifiche non salvate all’obiettivo andranno perse.",
      emptyPlaceholder: "Ancora niente qui",
      badge: {
        goal: ({ title }: { title: string }) => `Obiettivo: ${title}`,
        goalPaused: "Obiettivo in pausa",
        goalBlocked: "Obiettivo bloccato",
        goalBudgetLimited: "Obiettivo limitato dal budget",
        goalComplete: "Obiettivo completato",
        item: ({ title }: { title: string }) => title,
      },
      group: {
        active: "Attivo",
        pending: "In sospeso",
        blockedPaused: "Bloccato o in pausa",
        done: "Completato o annullato",
      },
      workflow: {
          sectionTitle: "Flussi di lavoro attivi",
          goalActive: "Obiettivo attivo",
          goalLabel: ({ title }: { title: string }) => `Obiettivo: ${title}`,
          bare: "Flusso di lavoro",
          agentsFallback: ({ fraction }: { fraction: string }) => `Flusso di lavoro ${fraction} agenti`,
          olderRunsHidden: ({ count }: { count: number }) => `${count} esecuzioni precedenti nascoste`,
          phaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
          plural: ({ count }: { count: number }) => `${count} flussi di lavoro`,
          pluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} flussi di lavoro · ${agents} agenti`,
          join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
          permissionBlocked: "Richiede revisione",
      },
      goal: {
        title: "Obiettivo",
        placeholder: "Su cosa dovrebbe concentrarsi questa sessione?",
        set: "Imposta obiettivo",
        pause: "Pausa",
        resume: "Riprendi",
        clear: "Cancella",
        clearTitle: "Cancellare l’obiettivo?",
        clearBody: "Rimuove l’obiettivo modificabile da questa sessione.",
        statusActive: "Attivo",
        statusPaused: "In pausa",
        statusComplete: "Completato",
        statusBudgetLimited: "Limitato dal budget",
        statusInterrupted: "Interrotto",
        setTitle: "Imposta un obiettivo",
        setSubtitle: "Dai un focus a questa sessione così l’agente resta in carreggiata.",
        addBudget: "+ Aggiungi un limite di budget (opzionale)",
        removeBudget: "Rimuovi budget",
        noUsageYet: "Ancora nessun utilizzo",
        tokenBudget: "Budget token",
        tokensSuffix: ({ count }: { count: string }) => `${count} token`,
        budgetProgress: ({ used, budget }: { used: string; budget: string }) => `${used} / ${budget}`,
        budgetCaption: ({ budget }: { budget: string }) => `su ${budget} di budget`,
        budgetPlaceholder: "Limite token",
        invalidBudget: "Inserisci un budget token positivo.",
        pending: "Impostazione obiettivo…",
        stillWaiting: "In attesa di conferma…",
        accessibilityCurrent: ({ objective }: { objective: string }) => `Obiettivo attuale: ${objective}`,
        errorUnsupportedResponse: "Risposta RPC della sessione non supportata",
        errorUnknown: "Errore sconosciuto",
        errorCannotResume: "Impossibile riprendere la sessione per aggiornare l’obiettivo nativo",
      },
    },
    usageLimitRecovery: {
      banner: {
        title: "Limite di utilizzo raggiunto",
        body: "Happier può attendere il ripristino del limite e riprendere automaticamente questa sessione.",
        waitingTitle: "In attesa del ripristino del limite di utilizzo",
        waitingBody: "Happier controllerà di nuovo quando il provider dovrebbe accettare richieste.",
        readyTitle: "Limite di utilizzo reimpostato",
        readyBody: "Ora puoi riprendere questa sessione.",
        resetCreditSummary: ({ count, expiresAt }: { count: number; expiresAt: string | null }) => {
          const label = count === 1 ? "1 ripristino di utilizzo" : `${count} ripristini di utilizzo`;
          return expiresAt ? `${label} disponibile. Il primo scade il ${expiresAt}.` : `${label} disponibile.`;
        },
      },
      actions: {
        enable: "Riprendi quando il limite si reimposta",
        cancel: "Annulla attesa",
        checkNow: "Controlla il limite ora",
        resumeNow: "Riprendi ora",
        switchFallbackNow: "Passa all'account alternativo",
        switchAccountNow: "Cambia account ora",
        consumeResetCredit: "Applica ripristino utilizzo",
        retryTemporaryThrottle: "Riprova ora",
        remember: "Attendi e riprendi sempre",
        forget: "Chiedi ogni volta",
        hideBanner: "Nascondi banner del limite di utilizzo",
        showBanner: "Mostra banner del limite di utilizzo",
      },
      status: {
        ready: "Limite di utilizzo",
        resumeReady: "Pronto per riprendere",
        checking: "Controllo del limite",
        waiting: "In attesa del ripristino",
        waitingForQuotaReset: "In attesa del ripristino della quota",
        accountRotationPending: "Rotazione account in sospeso",
        temporaryThrottle: "Limitazione temporanea",
      },
    },
    composerBanners: {
        showBannerAction: 'Mostra banner',
        hideBannerAction: 'Nascondi banner',
    },
    staleRunner: {
      banner: {
        title: "Il runner della sessione non è aggiornato",
        body: "Questa sessione usa ancora codice runtime meno recente. Riavvia il runner per usare il runtime daemon corrente.",
        pendingBody: "Riavvio del runner della sessione sul runtime daemon corrente.",
        busyBody: "Il runner è occupato. Riprova al termine del lavoro corrente.",
        failedBody: "Impossibile riavviare il runner. La sessione resta disponibile sul runner esistente.",
        unavailableBody: "Il riavvio non è disponibile per questa sessione. La sessione può continuare sul runner esistente.",
      },
      actions: {
        restart: "Riavvia runner",
        restarting: "Riavvio...",
        hideBanner: "Nascondi avviso runner obsoleto",
        showBanner: "Mostra avviso runner obsoleto",
      },
      status: {
        stale: "Aggiornamento runner",
        restarting: "Riavvio runner",
        busy: "Runner occupato",
        failed: "Riavvio non riuscito",
      },
    },
    rightPanel: {
      tabs: {
        git: "Git",
      },
    },
    toolCalls: "Chiamate strumento",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} in più…`,
    agentContinuation: {
      currentAgentAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Esegue questa sessione.`,
      currentAgentLastUsedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Ultimo usato da questa sessione.`,
      currentAgentLastReportedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Ultimo segnalato per questa sessione.`,
      armedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Selezionato per il tuo prossimo messaggio.`,
      detailTitle: ({ agent }: { agent: string }) => `Continua con ${agent}`,
      sendLabel: ({ agent }: { agent: string }) => `Continua con ${agent}`,
      detailDescription: 'La conversazione recente resta come testo; immagini e file no. Non viene inviato nulla fino al prossimo messaggio.',
      detailDescriptionEmpty: 'Non c’è ancora una conversazione da conservare. Non viene inviato nulla fino al prossimo messaggio.',
      announcement: ({ agent }: { agent: string }) => `${agent} selezionato per il prossimo messaggio. Non è stato inviato nulla.`,
      dividerTitle: ({ from: from_, to }: { from: string; to: string }) => `Questa sessione è continuata da ${from_} a ${to}`,
      handedOver: {
          open: "Mostra il contesto trasferito qui",
          title: "Contesto trasferito",
          reconstructed: "Ricostruito ora dalla trascrizione di questa sessione, non salvato all’epoca: può quindi differire da ciò che è stato inviato. Ciò che l’Agent precedente stava seguendo, e il suo registro, non possono essere ricostruiti e vengono quindi omessi.",
          loading: "Ricostruzione…",
          empty: "Non è stato trasferito nulla. Non c’era alcuna conversazione precedente da riprodurre.",
          unavailableOperation: "Aggiorna o riconnetti la CLI su questa macchina per ricostruirlo.",
          notRebuildable: "Qui è stato trasferito del contesto, ma la trascrizione di questa sessione non lo contiene più, quindi non può essere ricostruito.",
          unavailableSource: "Happier non è riuscito a leggere la trascrizione di questa sessione, quindi non può ricostruirlo.",
          unreachable: "Happier non è riuscito a raggiungere la macchina che ospita questa sessione.",
          retryAction: "Riprova",
          jumpAction: "Vai all’ultimo messaggio incluso",
      },
      checking: "Verifica della disponibilità…",
      unavailable: {
        unsupportedSession: ({ agent }: { agent: string }) => `Questa sessione non può continuare con ${agent}.`,
        updateCli: "Aggiorna la CLI su questa macchina per cambiare agente.",
        updateOrReconnect: "Aggiorna o riconnetti la CLI per cambiare agente.",
        targetNoSessions: ({ agent }: { agent: string }) => `${agent} non può eseguire una sessione.`,
        targetNotProven: ({ agent }: { agent: string }) => `Il passaggio a ${agent} non è ancora supportato.`,
        targetUnavailable: ({ agent }: { agent: string }) => `${agent} non è disponibile su questa macchina.`,
      },
      transition: {
        rejected: {
          unsupportedOperation: 'Questa sessione non supporta il cambio di agente. Non è stato inviato nulla.',
          forbidden: 'Non hai i permessi per cambiare l’agente di questa sessione. Non è stato inviato nulla.',
          sameTarget: ({ agent }: { agent: string }) => `Questa sessione usa già ${agent}. Non è stato inviato nulla.`,
          staleSelection: 'La sessione è cambiata mentre sceglievi. Non è stato inviato nulla: riprova.',
          targetUnavailable: ({ agent }: { agent: string }) => `${agent} non è disponibile su questa macchina. Non è stato inviato nulla.`,
          sourceNotIdle: ({ agent }: { agent: string }) => `${agent} sta ancora lavorando. Non è stato inviato nulla: riprova quando ha finito.`,
          sourceStopFailed: ({ agent }: { agent: string }) => `Non è stato possibile arrestare ${agent}, quindi non è cambiato nulla. Non è stato inviato nulla.`,
        },
        conflictingDestination: ({ agent }: { agent: string }) => `Non è stato inviato nulla. Questo messaggio ha già un’altra destinazione, quindi non può anche passare questa sessione a ${agent}. Rimuovine uno dei due e invia di nuovo.`,
        sourceStopped: ({ source, agent }: { source: string; agent: string }) => `${source} si è arrestato, ma il passaggio a ${agent} non è stato completato. Il messaggio non è stato inviato.`,
        switched: ({ agent }: { agent: string }) => `Questa sessione ora usa ${agent}, ma il messaggio non è stato inviato. Invialo di nuovo.`,
        /** Compact status for the collapsed composer banner badge. */
        badgeLabel: 'Cambio di Agente',
        /** Delegates to the Session’s existing resume owner; never a second start path. */
        resumeAction: 'Riprendi sessione',
        unknown: 'Happier non è riuscito a confermare cosa è successo. Controlla questa sessione prima di inviare di nuovo.',
      },
    },
    sourceContext: {
        chipLabel: ({ session }: { session: string }) => `Da ${session}`,
        unknownSession: "un’altra sessione",
        detailTitle: "Continuazione da un’altra sessione",
        detailBodyLatest: ({ session }: { session: string }) => `La conversazione di ${session} verrà portata come contesto di questa nuova sessione.`,
        detailBodyAtMessage: ({ session }: { session: string }) => `La conversazione di ${session}, fino al messaggio scelto, verrà portata come contesto di questa nuova sessione.`,
        carriedOver: "La conversazione verrà portata con te",
        removeAction: "Rimuovi",
        removeA11y: "Rimuovi la conversazione di origine",
        keepAction: "Mantienila",
        serverMismatch: "Quella conversazione si trova su un altro server Happier. Torna a quel server oppure rimuovi la conversazione di origine per ripartire da zero.",
    },
    forking: {
      dividerTitle: "Derivato da un contesto precedente",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Derivato da ${parent}`,
      dividerSubtitle: "Contesto precedente (sola lettura)",
      openParent: "Apri",
      openParentA11y: "Apri la sessione padre",
      forkFromMessageA11y: "Deriva da questo messaggio",
      strategy: {
          title: "Deriva questa sessione",
          subtitleLatest: "Crea un ramo dal punto in cui si trova ora questa conversazione.",
          subtitleFromMessage: "Crea un ramo da questo punto della conversazione.",
          recommended: "Consigliato",
          native: {
              title: "Derivazione nativa",
              subtitle: "L’agente deriva la propria conversazione. Il più fedele all’originale.",
          },
          replay: {
              title: "Derivazione con Replay",
              subtitle: "Happier riproduce la conversazione fatta finora come contesto della nuova sessione.",
          },
          configure: {
              title: "Configura una nuova sessione",
              subtitle: "Scegli un altro agente, modello, macchina o cartella e porta con te questa conversazione.",
          },
          unavailable: {
              nativeAgent: "Questo agente non può derivare la propria conversazione.",
              nativeFromMessage: "Questo agente può derivare l’intera conversazione, ma non da un messaggio precedente.",
              nativeProviderBound: "L’agente non può derivare una sessione collegata a un account provider.",
              replayOff: "Replay è disattivato nelle Impostazioni.",
              replaySettingsAction: "Impostazioni Replay",
          },
          progress: {
              creatingNative: "Creazione della derivazione nativa…",
              creatingReplay: "Creazione della derivazione con Replay…",
              opening: "Apertura della derivazione…",
              stalledTitle: "La derivazione è stata creata",
              stalledBody: "Non è ancora comparsa qui. Prova ad aprirla di nuovo.",
              openAction: "Apri la derivazione",
          },
          unknown: {
              title: "Happier non ha potuto confermare la derivazione",
              body: "La richiesta è partita, quindi una derivazione potrebbe già esistere. Controlla invece di riprovare, perché un secondo tentativo potrebbe crearne una duplicata.",
              checkAction: "Cerca la derivazione",
              checking: "Ricerca della derivazione…",
              noneFound: "Ancora nessuna derivazione corrispondente. Potrebbe essere in avvio, puoi controllare di nuovo.",
              ambiguous: "È comparsa più di una derivazione corrispondente. Apri l’elenco delle sessioni per scegliere quella giusta.",
          },
          failure: {
              updateRequired: "Aggiorna o riconnetti la CLI su questa macchina per derivare questa sessione.",
              generic: "Happier non è riuscito a creare la derivazione.",
          },
      },
	    },
	    transcriptGap: {
	      earlierMessages: "Messaggi precedenti",
	      laterMessages: "Messaggi successivi",
	    },
	    rollback: {
	      latestTurnA11y: "Ripristina l'ultimo turno",
	      beforeUserMessageA11y: 'Ripristina fino a prima di questo messaggio',

	      checkpointCode: {
	        title: 'Opzioni di rollback',
	        conversationUnavailable: 'Il rollback della conversazione non e disponibile per questa sessione.',
	        codeOnlyConfirmation: 'Capisco che la conversazione rimarra invariata.',
	        showAdvanced: 'Mostra opzioni avanzate solo codice',
	        choices: {
	          conversation_only: {
	            title: 'Solo conversazione',
	            description: 'Ripristina la trascrizione senza modificare i file.',
	          },
	          conversation_and_code_with_stash: {
	            title: 'Conversazione e codice, con Git stash',
	            description: 'Crea un checkpoint Happier, salva le modifiche nello stash e applica la patch inversa.',
	          },
	          conversation_and_code_without_stash: {
	            title: 'Conversazione e codice, senza Git stash',
	            description: 'Crea un checkpoint Happier e applica la patch inversa in questo worktree.',
	          },
	          code_only_with_stash: {
	            title: 'Solo codice, con Git stash',
	            description: 'Avanzato: lascia invariata la trascrizione e ripristina i file dopo uno stash.',
	          },
	          code_only_without_stash: {
	            title: 'Solo codice, senza Git stash',
	            description: 'Avanzato: lascia invariata la trascrizione e ripristina i file solo con il checkpoint Happier.',
	          },
	        },
	      },},
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

            backgroundFollow: "Segui in background",},
        detailsPanel: {
          emptyHint: "Apri un file o un diff dal pannello di destra.",
          unsupportedTab: "Scheda dettagli non supportata.",
          closeA11y: "Chiudi dettagli",
              openRightSidebarA11y: "Apri barra laterale destra",
              closeRightSidebarA11y: "Chiudi barra laterale destra",
              openTabA11y: ({ title }: { title: string }) => `Apri scheda ${title}`,
              pinTabA11y: "Fissa scheda",
              unpinTabA11y: "Rimuovi fissaggio scheda",
              pinnedTabA11y: "Scheda fissata",
              closeTabA11y: "Chiudi scheda",
              enterFocusModeA11y: "Entra in modalità focus pannello",
              exitFocusModeA11y: "Esci dalla modalità focus pannello",

          emptyTitle: "Nessuna scheda aperta",},

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
          deliveryStatus: {
            blocked: 'Bloccato',
            delivering: 'Consegna in corso',
            queuedInClaude: 'In coda in Claude',
          },
          queuedReasons: {
            waitingForForegroundTurn: 'In attesa del turno corrente',
            waitingForRuntimeActivity: 'In attesa che termini l’attività di runtime',
            runtimeActivityUnknown: 'In attesa dello stato dell’attività di runtime',
            waitingForPredecessor: 'In attesa di un messaggio precedente',
            waitingForRuntime: 'In attesa del runtime della sessione',
            unsupportedAction: 'L’azione di consegna richiede una verifica',
          },
          deliveryBlockedReasons: {
            terminalComposerDraft: 'La bozza del terminale blocca la consegna',
            captureStyleUnavailable: 'L’acquisizione del terminale non può verificare il composer',
            providerUnavailableBeforeAcceptance: 'Il provider è temporaneamente non disponibile',
            ambiguousTerminalDelivery: 'Lo stato della consegna è ambiguo',
            terminalHostUnreachable: 'Host terminale non raggiungibile',
            runtimeDisposedBeforeDelivery: 'Runtime chiuso prima della consegna',
            runtimeConfigBlocked: 'La configurazione runtime blocca la consegna',
            invalidPromptText: 'Il testo del messaggio non può essere consegnato',
            manualUserHandled: 'Contrassegnato come gestito',
            attemptExpiredBeforeWrite: 'Il tentativo di consegna è scaduto prima della scrittura',
            providerRejectedBeforeAcceptance: 'Il provider ha rifiutato il messaggio',
            payloadTooLarge: 'Il messaggio è troppo grande',
            unknown: 'Lo stato della consegna richiede revisione',
          },
	          empty: "Nessun messaggio in sospeso.",
	          decryptFailed: "Impossibile decifrare questo messaggio in sospeso.",
	          nonSteerableNotice: "Il turno corrente non può accettare inserimenti dopo questo cambio di modalità. Verrà eseguito dopo, oppure usa Invia ora per interrompere.",
	          steerBlockedTerminalDraftNotice: 'In attesa: una bozza nel compositore del terminale blocca la consegna. Cancellala nel terminale o interrompi il turno.',
          clearComposer: {
            action: 'Svuota compositore',
            clearing: 'Svuotamento…',
            confirmTitle: 'Svuotare il compositore del terminale?',
            confirmBody: 'Questo eliminerà il testo non inviato attualmente nel compositore del terminale.',
            errors: {
              failed: 'Impossibile svuotare il compositore del terminale.',
              unsupported: 'Questa sessione non supporta lo svuotamento del compositore del terminale da Happier.',
              noLiveTerminal: 'Nessun terminale attivo è disponibile per questa sessione.',
              generating: 'Claude sta generando, quindi il compositore non può essere svuotato in sicurezza.',
              notSafe: 'Il terminale mostra una finestra di dialogo o un altro stato non sicuro. Svuotalo nel terminale.',
              captureUnavailable: 'Happier non ha potuto leggere lo stato del terminale.',
            },
          },
	          actions: {
            up: "Su",
            down: "Giù",
          edit: "Modifica",
            viewMore: "Mostra di più",
            viewLess: "Mostra meno",
          steerNow: "Inserisci ora",
          sendNow: "Invia ora",
          sendToAgentNow: "Invia ora all’agente",
          sendNowInterrupt: "Invia ora (interrompi)",
          retryDelivery: "Riprova",
          interruptAndRunNow: "Interrompi ed esegui ora",
          markHandled: "Segna come gestito",
          requeue: "Rimetti in coda",
        },
        editPrompt: {
          title: "Modifica messaggio in sospeso",
        },
        removeConfirm: {
          title: "Rimuovere il messaggio in sospeso?",
          body: "Questo eliminerà il messaggio in sospeso.",
        },
        discardConfirm: {
          title: "Scartare la consegna in sospeso?",
          body: "Questo manterrà il messaggio nella trascrizione come scartato senza inviarlo all'agente.",
        },
        steerConfirm: {
          title: "Inserire ora?",
          body: "Questo aggiungerà questo messaggio al turno corrente senza fermarlo.",
        },
        sendConfirm: {
          title: "Inviare ora?",
          interruptTitle: "Inviare ora (interrompere)?",
          backgroundTitle: "Inviare ora all’agente?",
          body: "Questo fermerà il turno corrente e invierà questo messaggio immediatamente.",
          backgroundBody: "L’agente riceverà questo messaggio ora. Il lavoro in background continuerà.",
          resumeBody: "Questo riprenderà la sessione e invierà immediatamente il messaggio.",
        },
        markHandledConfirm: {
          title: "Segnare il messaggio in sospeso come gestito?",
          body: "Questo cancellerà lo stato di consegna bloccata senza inviare il messaggio.",
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
          retryDeliveryFailed: "Impossibile riprovare la consegna in sospeso",
          actionConflict: "Questo messaggio in sospeso è cambiato durante l’applicazione dell’azione. Controlla lo stato attuale e riprova.",
          discardFailed: "Impossibile scartare la consegna in sospeso",
          markHandledFailed: "Impossibile segnare la consegna in sospeso come gestita",
        },
      },

      transcript: {

          olderLoadFailedTitle: 'Impossibile caricare i messaggi precedenti',

          olderLoadFailedBody: 'Il resto di questa conversazione è ancora qui. Riprova a caricare i messaggi precedenti.',

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
      stopSharingDescription: "Revoca l’accesso diretto di questa persona.",
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
        "Chiunque abbia questo link può visualizzare la sessione in modo anonimo. Eliminalo o rigeneralo per revocare l’accesso a tutti.",
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
        shortcutsHelpTitle: 'Scorciatoie da tastiera',
        shortcutsHelpBody: ({ shortcuts }: { shortcuts: string }) => `Scorciatoie attive:\n${shortcuts}`,
        shortcutsHelpEmpty: 'Nessuna scorciatoia attiva su questo dispositivo.',
        shortcutsHelpCommandPalette: 'Apri la palette dei comandi',
        shortcutsHelpHelp: 'Apri le scorciatoie da tastiera',
        shortcutsHelpNewSession: 'Nuova sessione',
        commands: {
            sessionsCategory: 'Sessioni',
            navigationCategory: 'Navigazione',
            recentSessionsCategory: 'Sessioni recenti',
            runsCategory: 'Corre',
            voiceCategory: 'Voce',
            systemCategory: 'Sistema',
            developerCategory: 'Sviluppatore',
            newSessionTitle: 'Nuova sessione',
            newSessionSubtitle: 'Avvia una nuova sessione di chat',
            viewAllSessionsTitle: 'Visualizza tutte le sessioni',
            viewAllSessionsSubtitle: 'Sfoglia la cronologia della chat',
            settingsTitle: 'Impostazioni',
            settingsSubtitle: 'Configura le tue preferenze',
            accountTitle: 'Conto',
            accountSubtitle: 'Gestisci il tuo account',
            connectTerminalTitle: 'Scansione QR per connettere il terminale',
            connectTerminalSubtitle: 'Approva la connessione mostrata nel tuo terminale',
            memorySearchTitle: 'Cerca memoria',
            memorySearchSubtitle: 'Cerca nelle conversazioni passate',
            sessionFallbackTitle: ({ id }: { id: string }) => `Session ${id}`,
            sessionFallbackSubtitle: 'Passa alla sessione',
            sessionRequiredTitle: 'Sessione richiesta',
            sessionRequiredBody: 'Aprire prima una sessione in modo che questo comando possa indirizzarla.',
            startReviewRunTitle: 'Avvia l\'esecuzione della revisione',
            startPlanRunTitle: 'Inizia l\'esecuzione del piano',
            startDelegationRunTitle: 'Avvia l\'esecuzione della delega',
            executionRunsSubtitle: 'L\'esecuzione viene eseguita',
            openSessionRunsTitle: 'Viene eseguita la sessione aperta',
            runsForCurrentSessionSubtitle: 'Viene eseguito per la sessione corrente',
            runsAcrossMachinesSubtitle: 'Funziona attraverso le macchine',
            resetVoiceAgentTitle: 'Reimposta l\'agente vocale',
            voiceSubtitle: 'Voce',
            signOutTitle: 'Esci',
            signOutSubtitle: 'Esci dal tuo account',
            developerMenuTitle: 'Menù sviluppatore',
            developerMenuSubtitle: 'Accedi agli strumenti per sviluppatori',
        },
    pets: {
      category: "Mascotte",
      wakeTitle: "Sveglia mascotte",
      wakeSubtitle: "Mostra la compagna su questa superficie.",
      tuckTitle: "Metti via la mascotte",
      tuckSubtitle: "Nasconde la compagna su questa superficie.",
      resetPositionTitle: "Ripristina posizione mascotte",
      resetPositionSubtitle: "Riporta la compagna nella posizione predefinita.",
      chooseTitle: "Scegli mascotte",
      chooseSubtitle: "Apri le impostazioni delle mascotte.",
      refreshCodexTitle: "Aggiorna mascotte Codex",
      refreshCodexSubtitle: "Apri le impostazioni e rileva le mascotte Codex locali.",
    },
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
    customInputA11y: "Identificatore modello personalizzato",
    optionControlA11y: ({ name }: { name: string }) => `Opzione modello: ${name}`,
    effectiveLabel: ({ label }: { label: string }) => `Effettivo: ${label}`,
  },

  voiceAssistant: {
    connecting: "Connessione...",
    reconnecting: "Riconnessione…",
    listening: "In ascolto",
    thinking: "Sta pensando…",
    speaking: "Sta parlando",
    microphonePermissionRequired: "Serve l’accesso al microfono",
    interrupted: "Interrotto",
    active: "Assistente vocale attivo",
    connectionError: "Errore di connessione",
    label: "Assistente vocale",
    tapToEnd: "Tocca per terminare",
    startDictation: "Avvia dettatura",
    startVoice: "Avvia Voce",
    startGlobalVoice: "Avvia Voce Globale",
    endVoice: "Termina Voce",
    transcribing: "Trascrizione…",
    endDictation: "Termina dettatura",
    dictationNoSpeech: "Nessun parlato rilevato",
    dictationErrors: {
      captureFailed: "La dettatura si è fermata perché la registrazione dal microfono non è riuscita. Controlla l’accesso al microfono e riprova.",
      providerUnavailable: "Il provider di dettatura selezionato non è disponibile. Controlla la sua configurazione e riprova.",
      captureStartDeadlineExceeded: "La dettatura non è riuscita ad avviarsi entro 60 secondi. Controlla l’accesso al microfono e riprova.",
      captureDurationExceeded: "La dettatura ha raggiunto il limite di ascolto di 60 secondi. Avviala di nuovo per continuare.",
      transcriptionDeadlineExceeded: "La trascrizione ha richiesto più di 30 secondi. Riprova con una dettatura più breve.",
      transcriptLimitExceeded: "Il testo dettato è troppo lungo per il composer. Prova una dettatura più breve.",
      transcriptionCredentialsRequired: "La dettatura richiede le credenziali del provider vocale selezionato. Controlla la configurazione e riprova.",
      transcriptionMachineUnavailable: "La macchina di dettatura o il modello vocale locale non è disponibile. Riconnettila o controlla il modello selezionato.",
      transcriptionTransferFailed: "Happier non ha potuto inviare la registrazione alla macchina di dettatura. Controlla la connessione e riprova.",
      transcriptionFailed: "Il provider vocale selezionato non ha potuto trascrivere la registrazione. Riprova o controlla la configurazione.",
      recordedAudioSizeUnavailable: "Happier non ha potuto verificare la dimensione della registrazione. Registra di nuovo.",
      recordedAudioLimitExceeded: "La registrazione supera il limite di 8 MB. Prova una dettatura più breve.",
      microphoneOwnedByVoice: "Termina Voice prima di avviare la dettatura.",
      microphoneOwnedByDictation: "La dettatura sta già usando il microfono. Termina quella in corso prima di avviarne un’altra.",
    },
  },

  voiceSurface: {
    reviewCredentials: 'Controlla le credenziali',
    connectAgent: 'Connetti',
    installAgentRuntime: 'Installa',
    updateAgentRuntime: 'Aggiorna',
    reconnect: 'Riconnetti',
    start: "Avvia",
    stop: "Ferma",
    selectSessionToStart: "Seleziona una sessione per avviare la voce",
    targetSession: "Sessione target",
    conversationalTranscriptUnavailable: "La trascrizione della conversazione non è disponibile per questa sessione vocale",
    orbLabel: "Voce",
    orbStartHint: "Avvia una conversazione parlata. Scorri verso l'alto per aprire la conversazione.",
    orbEndHint: "Termina la conversazione parlata. Il lavoro di codice gia avviato continua. Scorri verso l'alto per aprire la conversazione.",
    orbMinimiseHint: "Riduce la voce",
    orbExpand: "Espandi voce",
    orbCollapse: "Riduci voce",
    delegatedWorking: "Al lavoro…",
    composerStartHint: "Avvia una conversazione parlata su questa sessione.",
    composerGlobalStartHint: "Avvia una conversazione parlata non legata ad alcuna sessione.",
    composerEndHint: "Termina la conversazione parlata. Il lavoro di codice già avviato prosegue.",
    noTarget: "Nessuna sessione selezionata",
    clearTarget: "Cancella target",
    a11y: {
      teleport: "Teletrasporta l’agente vocale",
      toggleActivity: "Mostra/nascondi attività vocale",
      clearActivity: "Cancella attività vocale",
      bargeIn: "Interrompi",
      cancelTurn: "Annulla risposta",
      openConversation: "Apri la conversazione vocale",
      microphoneActive: "Microfono attivo",
      microphoneInactive: "Microfono inattivo",
      microphoneMuted: "Microfono disattivato",
      providerDataDisclosure: ({ provider }: { provider: string }) => `Come ${provider} gestisce i dati vocali`,

      mute: "Disattiva microfono",
      unmute: "Riattiva microfono",},
  },

  voiceActivity: {
    title: "Attività vocale",
    empty: "Nessuna attività vocale.",
    partial: "In diretta",
    corrected: "Aggiornato",
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

    recordedAudio: {
      title: "QA STT con audio registrato",
      uriLabel: "URI dell'audio registrato",
      uriPlaceholder: "file:///recording.wav oppure scegli un file web",
      daemonPackIdLabel: "Override ID pacchetto STT del daemon",
      daemonPackIdPlaceholder: "Opzionale: applica le impostazioni QA STT daemon local_neural prima della trascrizione",
      daemonMachineIdLabel: "Override ID macchina del daemon",
      daemonMachineIdPlaceholder: "Opzionale: prepara un target macchina per l'ID sessione dell'audio registrato",
      daemonBasePathLabel: "Override percorso base del daemon",
      daemonBasePathPlaceholder: "Opzionale: prepara il percorso base macchina per lo STT del daemon",
      chooseFile: "Scegli audio registrato",
      noFileSelected: "Nessun audio registrato selezionato",
      transcribe: "Trascrivi audio registrato",
      statusLabel: "Stato",
      noResult: "Nessun risultato di trascrizione",
    },},

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Impostazioni Relay",
    enterServerUrl: "Inserisci un URL del Relay",
    notValidHappyServer: "Non è un Happier Relay valido",
    changeServer: "Cambia Relay",
    continueWithServer: "Continuare con questo Relay?",
    resetToDefault: "Ripristina predefinito",
    resetServerDefault: "Ripristinare il Relay predefinito?",
    validating: "Verifica...",
    validatingServer: "Verifica del Relay...",
    serverReturnedError: "Il Relay ha restituito un errore",
    failedToConnectToServer: "Impossibile connettersi al Relay",
    currentlyUsingCustomServer: "Attualmente si usa un Relay personalizzato",
    customServerUrlLabel: "URL Relay personalizzato",
    advancedFeatureFooter:
      "Questa è una funzionalità avanzata. Cambia il Relay solo se sai cosa stai facendo. Dovrai disconnetterti e accedere di nuovo dopo aver cambiato Relay.",
    useThisServer: "Usa questo Relay",
    autoConfigHint:
      "Se fai self-hosting: configura prima il Relay, poi accedi (o crea un account) e infine collega il tuo terminale.",
    renameServer: "Rinomina Relay",
    renameServerPrompt: "Inserisci un nuovo nome per questo Relay.",
    renameServerGroup: "Rinomina gruppo di Relay",
    renameServerGroupPrompt: "Inserisci un nuovo nome per questo gruppo di Relay.",
    serverNamePlaceholder: "Nome del Relay",
    cannotRenameCloud: "Non puoi rinominare il Relay cloud.",
    removeServer: "Rimuovi Relay",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Rimuovere "${name}" dai Relay salvati?`,
    removeServerGroup: "Rimuovi gruppo di Relay",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Rimuovere "${name}" dai gruppi di Relay salvati?`,
    cannotRemoveCloud: "Non puoi rimuovere il Relay cloud.",
    signOutThisServer: "Vuoi disconnetterti anche da questo Relay?",
    signOutThisServerPrompt:
      "Sono state trovate credenziali salvate per questo Relay su questo dispositivo.",
    savedServersTitle: "Relay salvati",
    signedIn: "Connesso",
    signedOut: "Disconnesso",
    authStatusUnknown: "Stato di autenticazione sconosciuto",
    switchToServer: "Passa a questo Relay",
    active: "Attivo",
    default: "Predefinito",
    addServerTitle: "Aggiungi Relay",
    switchForThisTab: "Passa per questa scheda",
    makeDefaultOnDevice: "Imposta come predefinito su questo dispositivo",
    serverNameLabel: "Nome del Relay",
    addAndUse: "Aggiungi e usa",
      addTargetsTitle: "Aggiungi",
      addServerSubtitle: "Aggiungi un nuovo Relay e passa ad esso",
      notificationAddServerHint: "Questo Relay non è ancora salvato su questo dispositivo. Aggiungilo qui sotto per continuare.",
      serverCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "Relay", plural: "Relay" })}`,
      useCanonicalServerUrlTitle: "Usare l'URL canonico del Relay?",
    useCanonicalServerUrlBody:
      "Questo Relay annuncia un URL canonico che dovrebbe funzionare da altri dispositivi. Vuoi usarlo invece di quello inserito?",
    insecureHttpUrlTitle: "URL del Relay non sicuro",
    insecureHttpUrlBody:
      "Questo URL usa http:// e potrebbe non funzionare dal telefono o fuori dalla LAN. Usa HTTPS se possibile. Continuare comunque?",
    signedOutSwitchConfirmTitle: "Non sei connesso",
    signedOutSwitchConfirmBody:
      "Vuoi passare a questo Relay e tornare alla schermata iniziale per accedere o creare un account?",
    addServerGroupTitle: "Aggiungi gruppo di Relay",
    addServerGroupSubtitle: "Crea un gruppo di Relay riutilizzabile",
    serverGroupNameLabel: "Nome gruppo",
    serverGroupNamePlaceholder: "Il mio gruppo di Relay",
    serverGroupServersLabel: "Relay",
    saveServerGroup: "Salva gruppo",
    serverGroupMustHaveServer:
      "Un gruppo di Relay deve includere almeno un Relay.",
    relayDrift: {
        bannerDifferentRelayTitle: 'Il tuo servizio in background è connesso a un altro Relay',
        bannerDifferentRelayDescription: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `App: ${activeRelayUrl} · Servizio in background: ${daemonRelayUrl}`,
        bannerNeedsAuthTitle: 'Il tuo servizio in background deve accedere a questo Relay',
        bannerNeedsAuthDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `L’app sta usando ${activeRelayUrl}, ma il servizio in background ha ancora bisogno di approvazione o accesso.`,
        bannerNotConfiguredTitle: 'Il tuo servizio in background non è ancora connesso a questo Relay',
        bannerNotConfiguredDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `L’app sta usando ${activeRelayUrl}, ma questo computer non ha ancora terminato la connessione del servizio in background.`,
        bannerNotInstalledTitle: 'Il tuo servizio in background non è installato per questo Relay',
        bannerNotInstalledDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `L’app sta usando ${activeRelayUrl}, ma questo computer deve ancora installare il servizio in background per usarlo.`,
        bannerNotRunningTitle: 'Il tuo servizio in background è installato ma non è in esecuzione',
        bannerNotRunningDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `L’app sta usando ${activeRelayUrl}, ma il servizio in background è fermo e deve essere riavviato.`,
        repairAction: 'Connetti il servizio in background a questo Relay',
        progressTitle: 'Connessione del servizio in background a questo Relay in corso',
        progressStepPrepare: 'Prepara il servizio in background',
        progressStepConfigureRelay: 'Aggiorna la connessione al Relay',
        progressStepAuthenticate: 'Completa accesso e approvazione',
        progressStepFinish: 'Completa la riparazione',
        statusUnknown: 'Sconosciuto',
    },
    retention: {
      title: "Criterio di conservazione",
      summary: "Riepilogo",
      keepForever: "Nessuna eliminazione automatica",
      automaticDeletionEnabled: "L'eliminazione automatica è attiva",
      detailsUnavailable: "L'eliminazione automatica è attiva, ma questo client non può mostrare tutte le politiche attive",
      singlePolicySummary: ({ domain, policy }: { domain: string; policy: string }) => `${domain}: ${policy}`,
      relayCleanupSummary: ({ policies }: { policies: string }) => `Questo relay elimina ${policies}.`,
      relayCleanupAfterDays: ({ domain, count }: { domain: string; count: number }) => `${domain} dopo ${count} ${plural({ count, singular: 'giorno', plural: 'giorni' })}`,
      relayCleanupInactiveSessionsAfterDays: ({ count }: { count: number }) => `le sessioni inattive dopo ${count} ${plural({ count, singular: 'giorno', plural: 'giorni' })}`,
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Elimina le sessioni inattive dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Elimina i dati dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })}.`,
      sessionNotice: ({ count }: { count: number }) => `Questo Relay elimina le sessioni inattive dopo ${count} ${plural({ count, singular: "giorno", plural: "giorni" })} di inattività.`,
      sessions: "Sessioni",
      sidechainMessages: "Trascrizioni dei sottoagenti",
      usageEvents: "Eventi di utilizzo",
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
      title: "Vista concorrente multi-Relay",
      footer: "Scegli se combinare più Relay in un’unica lista di sessioni.",
      enableTitle: "Abilita vista concorrente",
      enableSubtitle: "Mostra insieme le sessioni dei Relay selezionati",
      presentationTitle: "Modalità di presentazione",
      presentation: {
        flatWithBadges: "Elenco piatto con badge del Relay",
        groupedByServer: "Raggruppato per Relay",
      },
    },

    reachabilityRemediation: {
      failedToOpenInstallLink: "Impossibile aprire la pagina di installazione di Tailscale.",
      tailscale: {
        title: "Questo relay usa Tailscale",
        desktopBody: "Questo computer non è riuscito a raggiungere il relay tramite Tailscale. Tailscale potrebbe non essere installato, non avere una sessione attiva o non essere connesso alla tailnet corretta su questo computer.",
        webBody: "Questo browser non è riuscito a raggiungere il relay tramite Tailscale. Apri Tailscale su questo dispositivo, assicurati che sia connesso alla tailnet corretta e riprova.",
        nativeBody: "Questo dispositivo non è riuscito a raggiungere il relay tramite Tailscale. Apri Tailscale, assicurati che sia connesso alla tailnet corretta e riprova.",
        installAction: "Installa Tailscale",
        desktopPrepareAction: "Prepara Tailscale",
      },
    },},

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
    storagePersistedTab: "Happier",
    storageAllFilter: "Tutte",
    storageFilterCategory: "Sessioni",
    storageExternalFilter: "Esterne",
    storageDirectTab: "Dirette",
    renameWorkspace: 'Rinomina area di lavoro',
    renameWorkspacePromptTitle: 'Rinomina area di lavoro',
    renameWorkspacePromptPlaceholder: 'Inserisci un nome...',
    resetWorkspaceName: 'Reimposta nome',
    viewOptions: 'Opzioni vista',
    searchSessions: 'Cerca sessioni',
    searchSessionsPlaceholder: 'Cerca sessioni...',
    filterByTags: 'Filtra per tag',
    folders: 'Cartelle',
    addFolder: 'Aggiungi cartella',
    addFolderPromptTitle: 'Aggiungi cartella',
    addSubfolder: 'Aggiungi sottocartella',
    addSubfolderPromptTitle: 'Aggiungi sottocartella',
    folderNamePlaceholder: 'Nome cartella',
    renameFolder: 'Rinomina cartella',
    renameFolderPromptTitle: 'Rinomina cartella',
    moveFolder: 'Sposta cartella',
    deleteFolder: 'Elimina cartella',
    deleteFolderPromptTitle: 'Elimina cartella',
    deleteFolderPromptDescription: 'Le sessioni in questa cartella resteranno nello spazio di lavoro.',
    newSessionInFolder: 'Nuova sessione nella cartella',
    clearFolderFocus: 'Cancella focus cartella',
    folderViewTree: 'Vista cartelle',
    folderViewOff: 'Nascondi cartelle',
    moveToFolder: 'Sposta nella cartella',
    moveToWorkspaceRoot: "Radice dell'area di lavoro",
    sessionFallbackLabel: 'Sessione',
    moveSheetTitle: ({ item }: { item: string }) => 'Move ' + item,
    moveSheetDestinationLabel: 'Destinazione',
    moveSheetSubmit: 'Muoviti',
    moveSheetSearchPlaceholder: 'Search folders...',
    moveSheetEmpty: 'Nessun bersaglio di spostamento disponibile',
    moveSheetDestinations: 'Destinazioni',
    moveSheetDisabledDescendant: 'Impossibile spostarsi in se stessa o in una cartella secondaria.',
    moveSheetDisabledMaxDepth: 'Ciò supererebbe il limite di profondità della cartella.',
    moveSheetDisabledCurrent: 'Già in questa posizione.',
    moveSheetDisabledUnavailable: 'Questa destinazione non è disponibile.',
    dragHandleA11yLabel: 'Maniglia di trascinamento',
    dragA11yPickedUp: ({ item }: { item: string }) => 'Picked up ' + item + '.',
    dragA11yDroppedReorder: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' near ' + destination + '.',
    dragA11yDroppedNest: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' into ' + destination + '.',
    dragA11yDroppedRoot: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' to ' + destination + '.',
    dragA11yCancelled: ({ item }: { item: string }) => 'Move cancelled for ' + item + '.',
    dragA11yBlocked: ({ item, reason }: { item: string; reason: string }) => 'Could not move ' + item + ': ' + reason,
    dragA11yBlockedDescendantCycle: 'la destinazione è all\'interno della cartella spostata',
    dragA11yBlockedLeafCannotBeParent: 'le sessioni non possono contenere altri elementi',
    dragA11yBlockedMaxDepth: 'limite di profondità della cartella raggiunto',
    dragA11yBlockedSamePosition: 'già in quella posizione',
    dragA11yBlockedWorkspaceScope: 'la destinazione si trova in un\'altra area di lavoro',
    dragA11yBlockedNoTarget: 'nessuna destinazione selezionata',
    dragA11yBlockedDirectSession: 'le sessioni dirette non possono essere spostate nelle cartelle',
    dragA11yBlockedFeatureDisabled: 'le cartelle di sessione non sono abilitate',
    dragA11yBlockedUnsupportedItem: 'questo elemento non può essere spostato nelle cartelle',
    hideInactiveSessions: 'Nascondi sessioni inattive',
    showInactiveSessions: 'Mostra sessioni inattive',
    attentionSectionTitle: 'Richiede attenzione',
    workingSectionTitle: 'In lavorazione',
        backgroundWorkingSectionTitle: 'In esecuzione in background',
    selectionSelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionA11ySelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionCheckboxA11yLabel: 'Seleziona sessione',
    selectionSelectAction: 'Seleziona',
    selectionSelectAllVisible: 'Seleziona tutto',
    selectionSelectAllVisibleA11yLabel: 'Seleziona tutte le sessioni visibili',
    selectionMoveSheetSourceLabel: ({ count }: { count: number }) => count === 1 ? '1 selected session' : `${count} selected sessions`,
    selectionAddTags: 'Aggiungi tag',
    selectionRemoveTags: 'Rimuovi tag',
    selectionSetTags: 'Imposta tag',
    selectionAddTagsPromptTitle: 'Aggiungi tag',
    selectionRemoveTagsPromptTitle: 'Rimuovi tag',
    selectionSetTagsPromptTitle: 'Imposta tag',
    selectionTagsPromptMessage: 'Separa i tag con virgole.',
    selectionTagsPlaceholder: 'tag-uno, tag-due',
    selectionCancelA11yLabel: 'Annulla selezione sessioni',
    selectionProgress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total} complete`,
    selectionCancelRunningA11yLabel: 'Annulla azione sulle sessioni selezionate',
    selectionResult: ({ succeeded, failed, skipped }: { succeeded: number; failed: number; skipped: number }) => `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    selectionDismissResultA11yLabel: 'Chiudi risultato dell’azione sulle sessioni selezionate',
    selectionConfirm: ({ action, count }: { action: string; count: number }) => `${action} ${count} selected ${count === 1 ? 'session' : 'sessions'}?`,
    selectionConfirmA11yLabel: ({ action }: { action: string }) => `Confirm ${action}`,

    emptyState: {
      title: "Non ci sono ancora sessioni",
      description: "Avvia una sessione su una delle tue macchine online.",
      descriptionPrefix: "Avvia una sessione su una delle tue macchine usando ",
      descriptionSuffix: " nel terminale, oppure usando i pulsanti qui sotto.",
      actionsTitle: "Avvia una sessione",
      startSessionOnMachine: ({ machine }: { machine: string }) => `Avvia una sessione su ${machine}`,
      startSessionOnMachineSubtitle: "Scegli una cartella e apri una nuova sessione su questa macchina.",
      reconnectMachineActionSubtitle: "Ricollega il servizio in background così questa macchina potrà avviare di nuovo le sessioni.",
      startDaemonActionSubtitle: "Installa o riavvia il servizio in background necessario per avviare le sessioni.",
    },
    openProject: 'Apri progetto',
    workspaceRoot: "Radice dell’area di lavoro",
    failedToMoveSessionToFolder: "Impossibile spostare la sessione nella cartella.",
    newFolderDefaultName: "Nuova cartella",},

  directSessions: {
    browseTitle: "Sfoglia le sessioni esterne",
    browseOpenExisting: "Sfoglia le sessioni esterne",
    browseActionSubtitle: "Scegli una macchina, un agente e una sessione per aprirla qui.",
    browseFiltersTitle: "Seleziona origine",
    browseMachines: "Macchine",
    browseAgents: "Agenti",
    browseSources: "Sorgenti",
    browseSourceCodexUserHome: "La mia home di Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} servizi collegati`,
    browseSourceClaudeDefault: "Configurazione predefinita di Claude",
    browseSourceOpenCodeDefault: "Server OpenCode predefinito",
    browseCandidates: "Sessioni disponibili",
    browseNoMachines: "Non ci sono ancora macchine disponibili per le sessioni dirette.",
    browseNoCandidates: "Nessuna sessione esterna trovata per questa macchina e questo agente.",
    browseActivityRunning: "In esecuzione",
        browseActivityRunningNow: "In esecuzione",
    browseActivityRecent: "Recente",
    browseActivityIdle: "Inattiva",
    browseActivityUnknown: "Sconosciuta",
        browseSearchPlaceholder: "Cerca sessioni…",
        browseNoSearchResults: "Nessuna sessione corrisponde ancora a questa ricerca.",
    browseLoadMore: "Carica altre sessioni",
    browseFailedToLoad: "Impossibile caricare le sessioni esterne.",
    browseLinkFailed: "Impossibile collegare la sessione esterna selezionata.",
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
    cursorSessionId: "ID sessione Cursor",
    cursorSessionIdCopied: "ID sessione Cursor copiato negli appunti",
    metadataCopied: "Metadati copiati negli appunti",
    failedToCopyMetadata: "Impossibile copiare i metadati",
    copyDebugInformation: "Copia informazioni",
    debugInformationCopyLabel: "Informazioni",
    providerSessionLogs: ({ provider }: { provider: string }) => `Log sessione ${provider}`,
    failedToKillSession: "Impossibile terminare la sessione",
    failedToStopSession: "Impossibile fermare la sessione",
    failedToArchiveSession: "Impossibile archiviare la sessione",
    connectionStatus: "Stato connessione",
    created: "Creato",
    lastUpdated: "Ultimo aggiornamento",
    sequence: "Sequenza",
    quickActions: "Azioni rapide",
    markSessionRead: "Segna come letta",
    markSessionReadSubtitle: "Rimuovi l'attenzione non letta per questa sessione",
    markSessionUnread: "Segna come non letta",
    markSessionUnreadSubtitle: "Mantieni questa sessione nell'elenco dei non letti",
    keepInAttention: "Mantieni in Richiede attenzione",
    keepInAttentionSubtitle: "La tiene qui anche dopo che l’hai letta",
    removeFromAttention: "Rimuovi da Richiede attenzione",
    removeFromAttentionSubtitle: "Falla tornare più in basso nell’elenco una volta letta",
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
    inactiveAndArchivedSessions: "Sessioni inattive e archiviate",
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
    newSessionSameSetup: "Nuova sessione con la stessa configurazione",
    newSessionSameSetupSubtitle: "Riutilizza macchina, cartella, motore, modello e opzioni di questa sessione.",
    failedToRenameSession: "Impossibile rinominare la sessione",
    failedToMarkSessionRead: "Impossibile segnare la sessione come letta",
    failedToMarkSessionUnread: "Impossibile segnare la sessione come non letta",
    sessionRenamed: "Sessione rinominata con successo",

	    openInSplitRight: "Apri in riquadro a destra",
	    openInSplitDown: "Apri in riquadro in basso",
	    revealInCurrentSplit: "Mostra nel riquadro corrente",},

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
      chipPicker: {
          selectedOptionAccessibilityLabel: ({ option }: { option: string }) => `${option}. Selezionato.`,
      },
    suggestionGroups: {
      files: 'File',
      plugins: 'Plugin',
      sessions: 'Sessioni',
      references: 'Riferimenti',
      skills: 'Competenze',
      commands: 'Comandi',
    },
    stopCodingTurn: "Interrompi turno di programmazione",
      nonSteerableSend: {
        title: 'L\'agente è occupato',
        modeChangeMessage: 'La modifica della modalità permessi non può essere applicata al turno in corso.',
        providerConfigMessage: 'La modifica di questa impostazione del provider non può essere applicata al turno in corso.',
        specialCommandMessage: 'Questo comando non può essere eseguito durante il turno attivo.',
        interruptAndSend: 'Interrompi e invia ora',
        applySettingAndSteer: "Applica l'impostazione e indirizza ora",
        applyNamedSettingAndSteer: ({ setting, value }: { setting: string; value: string }) => `Applica ${setting} → ${value} e indirizza ora`,
        steerWithoutApplying: 'Indirizza ora senza applicare (si applicherà al prossimo messaggio)',
        queueForAfterTurn: 'Metti in coda per dopo il turno',
      },
    dropToAttach: "Rilascia per allegare file",
    providerUsage: {
      title: "Utilizzo provider",
      accessibilityLabel: ({ value }: { value: string }) =>
        `Utilizzo provider: ${value} rimanente`,
      remaining: ({ percent }: { percent: string }) => `${percent} rimanente`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) =>
        `${percent} rimanente · si reimposta tra ${reset}`,
      usedCount: ({ used, limit }: { used: string; limit: string }) =>
        `${used}/${limit} usato`,
      duration: {
        now: "ora",
        outdated: 'Non aggiornato',
        daysHours: ({ days, hours }: { days: number; hours: number }) =>
          `${days}g ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
          `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
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
      safeYolo: "Auto",
      yolo: "YOLO",
      plan: "Modalità piano",
      bypassPermissions: "Modalità YOLO",
      badgeAccept: "Accetta",
      badgePlan: "Piano",
      badgeReadOnly: "Sola lettura",
      badgeSafeYolo: "Auto",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Accetta tutte le modifiche",
      badgeBypassAllPermissions: "Bypassa tutti i permessi",
      badgePlanMode: "Modalità piano",
    },
    agent: {
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      opencode: "OpenCode",
      antigravity: "Antigravity",
      gemini: "Gemini",
      auggie: "Auggie",
      qwen: "Qwen Code",
      kimi: "Kimi",
      kilo: "Kilo",
      kiro: "Kiro",
      customAcp: "ACP personalizzato",
      pi: "Pi",
      copilot: "Copilot",

      ohMyPi: "oh-my-pi",},
    auggieIndexingChip: {
      on: "Indicizzazione attiva",
      off: "Indicizzazione disattiva",
    },
      model: {
        title: "MODELLO",
        useCliSettings: "Usa le impostazioni CLI",
        running: ({ model }: { model: string }) => `In esecuzione: ${model}`,
        lastUsed: ({ model }: { model: string }) => `Ultimo usato: ${model}`,
        lastReported: ({ model }: { model: string }) => `Ultimo segnalato: ${model}`,
        applyTimingNextMessage: "Si applica dal prossimo messaggio",
        applyTimingNewSession: "Si applica quando avvii una nuova sessione",
        selectedForResume: "Il modello selezionato verrà usato alla ripresa di questa sessione.",
        configureInCli: "Configura i modelli nelle impostazioni CLI",
        unavailable: "Il rilevamento dei modelli non è disponibile per questo provider su questa macchina.",
        extendedContextToggleLabel: "Contesto da 1 milione di token",
        extendedContextToggleDescription: "Usa la finestra di contesto estesa da 1 milione di token per questo modello.",
        customDescription: "Usa un id modello che non è in elenco.",
        customPromptBody: "Inserisci un id modello",
        customPlaceholder: "es. claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "MODALITÀ PERMESSI",
      default: "Impostazioni CLI",
      plan: "Modalità piano",
      readOnly: "Modalità sola lettura",
      safeYolo: "Auto",
      yolo: "YOLO",
      badgePlan: "Piano",
      badgeReadOnly: "Modalità sola lettura",
      badgeSafeYolo: "Auto",
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
      windowTitle: "Finestra di contesto",
      usedDetail: ({
        percent,
        used,
        total,
      }: {
        percent: string;
        used: string;
        total: string;
      }) => `${percent} • ${used}/${total} di contesto usato`,
      description: "Compatta automaticamente il contesto quando necessario.",
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
      optionsUnavailable: "Le opzioni di configurazione non sono disponibili per questo provider su questa macchina.",
      currentValue: ({ value }: { value: string }) => `Attuale: ${value}`,
      optionOverriddenBy: ({ name }: { name: string }) => `Sostituito da ${name}`,
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
    showFullContent: "Mostra contenuto completo",
    showLessContent: "Mostra meno",
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
    workflowView: {
      title: "Titolo",
      description: "Descrizione",
      status: "Stato",
      summary: "Riepilogo",
      run: "Esecuzione",
      task: "Attività",
      toolUse: "Uso strumento",
    },
    workflowActivityView: {
        untitled: "Flusso di lavoro",
        loading: "Caricamento…",
        unavailable: "Dettagli non disponibili",
        noDetail: "Nessun altro dettaglio",
        statusActive: "In esecuzione",
        statusComplete: "Completato",
      statusFailed: "Non riuscito",
      statusStopped: "Interrotto",
      statusInterrupted: "Interrotto",
      statusBlocked: "Bloccato",
        statusCancelled: "Annullato",
        statusUnknown: "Sconosciuto",
        phaseUntitled: "Fase",
        phaseActivity: "Attività",
        phaseComplete: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} completati`,
        phaseActive: ({ count }: { count: number }) => `${count} attivi`,
        phaseFailed: ({ count }: { count: number }) => `${count} falliti`,
        phaseBlocked: ({ count }: { count: number }) => `${count} bloccati`,
        phasePending: ({ count }: { count: number }) => `${count} in attesa`,
        phaseSummary: ({ index, total, complete, agents }: { index: number; total: number; complete: number; agents: number }) => `Fase ${index} di ${total} · ${complete}/${agents} agenti`,
        agentFraction: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} agenti`,
        agentsCount: ({ count }: { count: number }) => `${count} agenti`,
        tokens: ({ tokens }: { tokens: string }) => `${tokens} token`,
        toolCalls: ({ count }: { count: number }) => `${count} strumenti`,
        showMore: ({ count }: { count: number }) => `Mostra ${count}`,
        detailShowMore: 'Mostra altro',
        detailShowLess: 'Mostra meno',
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
    taskOutputView: {
      waitingForTask: "In attesa che l’attività in background termini.",
    },
    taskStopView: {
      stoppedCommandLabel: "Comando interrotto",
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
      attachedTerminalNotice: {
        header: 'Finestra di dialogo del terminale',
        question: 'L’agente mostra una finestra di dialogo. Apri il terminale collegato per esaminarla e scegliere come continuare.',
        openTerminal: 'Apri terminale collegato',
        description: 'Esamina e rispondi alla finestra di dialogo nel terminale collegato.',
      },
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
      pullRequests: {
        checkoutLocalTitle: "Checkout della pull request",
        checkoutLocalSubtitle: "Incolla l'URL di una PR o merge request, un numero o un comando di checkout.",
        openWorktreeTitle: "Apri pull request in un worktree",
        openWorktreeSubtitle: "Prepara la pull request in un worktree separato e avvia una sessione lì.",
        promptTitle: "Riferimento pull request",
        promptBody: "Incolla l'URL di una pull request o merge request, un numero o un comando di checkout.",
        promptPlaceholder: "https://github.com/owner/repo/pull/123",
        invalidReferenceBody: "Inserisci un riferimento valido a una pull request o merge request.",
        checkoutFailed: "Checkout della pull request non riuscito.",
        worktreeFailed: "Preparazione del worktree della pull request non riuscita.",
      },
      indexLock: {
        title: "Rimuovere il lock Git obsoleto?",
        body: "Git ha segnalato un lock dell'indice. Se non è in esecuzione un altro comando Git, Happier può rimuovere il lock obsoleto e riprovare.",
        confirm: "Rimuovi lock e riprova",
        recoveryFailed: "Impossibile rimuovere il lock dell'indice Git.",
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
    agentReportedTurnChanges: ({ count }: { count: number }) =>
      `Modifiche segnalate dall'agente (${count})`,
    checkpointTurnChanges: ({ count }: { count: number }) =>
      `Modifiche del checkpoint (${count})`,
    selectedForCommitChanges: ({ count }: { count: number }) =>
      `Selezionati per il commit (${count})`,
    latestTurnDescription:
      'Modifiche supportate dal provider per il turno completato più recente.',
    agentReportedTurnDescription:
      "Modifiche segnalate esplicitamente dall'agente per il turno corrente.",
    checkpointUnavailable:
      'Il contenuto del checkpoint non è disponibile per questo turno.',
    checkpointAttributionShared:
      "L'attribuzione del checkpoint è condivisa con altra attività del worktree.",
    checkpointAttributionUnknown:
      "Impossibile determinare l'attribuzione del checkpoint.",
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
    sourceControlStale: {
        title: 'Il controllo versione richiede attenzione',
        body: 'Viene mostrato l’ultimo aggiornamento riuscito. L’aggiornamento più recente non è stato completato.',
    },
    repositoryInit: {
      initialize: "Inizializza repository",
      initializing: "Inizializzazione…",
      confirmTitle: "Inizializzare il repository?",
      confirmBody: "Crea un repository Git in questa cartella. I file esistenti non verranno aggiunti allo stage né committati.",
      errors: {
        failed: "Impossibile inizializzare il repository.",
      },
    },
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
      frontmatterReadOnly: 'Frontmatter (sola lettura)',
    },
      fileEditingUnsupported:
        "La modifica dei file non è supportata dal daemon connesso. Aggiorna Happier sulla macchina per abilitare le operazioni di scrittura.",
      fileChangedExternally:
        "Questo file è cambiato su disco mentre lo modificavi. La bozza è rimasta invariata; controlla il file più recente prima di salvare.",
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
          modalSubtitle: "Rivedi quali commenti verranno inviati con il prossimo messaggio.",
          modalSummary: ({ included, count }: { included: number; count: number }) =>
            `${included} di ${count} selezionati per il prossimo prompt`,
          detachOrDiscardTitle: "Rimuovere i commenti di revisione?",
          detachOrDiscardBody:
            "Scollega li mantiene salvati ma li esclude dal prossimo prompt. Scarta li elimina.",
          detachFromPrompt: "Scollega dal prompt",
          durable: {
            headerTitle: "Commenti di revisione",
            count: ({ count }: { count: number }) => `${count}`,
            empty: "Non ci sono ancora commenti di revisione",
            engine: "Motore",
            stale: "Obsoleto",
            outdated: "Non aggiornato",
            binarySnapshot: "Snapshot binario",
            minified: "Probabilmente minificato",
            submoduleSnapshot: "Snapshot del sottomodulo",
            symlinkSnapshot: "Snapshot del collegamento simbolico",
            textSnapshot: "Snapshot di testo",
            tooLargeSnapshot: "Snapshot troppo grande",
            encryptedSnapshot: "Snapshot cifrato",
            truncated: "Troncato",
            bidiControls: "Controlli bidi",
            redacted: "Redatto",
            contentUnavailable: "Contenuto non disponibile",
            edit: "Modifica",
            resolve: "Risolvi",
            dismiss: "Scarta",
            reopen: "Riapri",
            redact: "Oscura",
            reply: "Rispondi",
            replyUnavailable: "Risposta non disponibile",
            bulkResolve: "Risolvi visibili",
            bulkDismiss: "Scarta visibili",
            bulkPartialFailure: "Alcuni commenti non sono stati aggiornati",
            bulkFailure: ({ commentId, errorCode }: { commentId: string; errorCode: string }) => `${commentId}: ${errorCode}`,
            filtersTitle: "Filtri",
            showActive: "Attivi",
            showHistory: "Cronologia",
            refresh: "Aggiorna",
            loadFailed: "Impossibile caricare i commenti di revisione",
            transitionReason: "Aggiornato dal pannello dei commenti di revisione.",
            bulkTransitionReason: "Aggiornamento in blocco dal pannello dei commenti di revisione.",
            editPromptTitle: "Modifica commento di revisione",
            editPromptBody: "Aggiorna il corpo del commento salvato.",
            replyPromptTitle: "Rispondi al commento di revisione",
            replyPromptBody: "Aggiungi una risposta al thread durevole dei commenti.",
            states: {
              proposed: "Proposto",
              open: "Aperto",
              delegated: "Delegato",
              pendingReview: "Revisione in sospeso",
              resolved: "Risolto",
              dismissed: "Scartato",
            },
            directWriteGrant: {
              title: "Scritture dirette dei commenti di revisione",
              body: ({ pluginId }: { pluginId: string }) => `${pluginId} richiede il permesso di scrivere direttamente commenti di revisione.`,
              grant: "Concedi scrittura diretta",
              cancel: "Non ora",
              revoke: "Revoca",
            },
          },
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
      commitAdjacentPush: {
        accessibilityLabel: ({ target }: { target: string }) => `Push verso ${target}`,
        confirm: {
          title: "Inviare i commit locali?",
          body: ({ target }: { target: string }) =>
            `Invia i tuoi commit locali a ${target}.`,
          push: "Sì",
          notNow: "Non ora",
          pushAndDontAskAgain: "Push e non chiedere più",
        },
      },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Caricamento ${fileName}...`,
        binaryFile: "File binario",
        imagePreviewTooLarge: "L'anteprima dell'immagine è troppo grande per essere visualizzata",
        sessionMedia: {
          generatedImageA11y: ({ name }: { name: string }) => `Apri immagine generata ${name}`,
          attachmentImageA11y: ({ name }: { name: string }) => `Apri immagine allegata ${name}`,
          toolArtifactImageA11y: ({ name }: { name: string }) => `Apri immagine artefatto dello strumento ${name}`,
          generatedVideoA11y: ({ name }: { name: string }) => `Apri video generato ${name}`,
          attachmentVideoA11y: ({ name }: { name: string }) => `Apri video allegato ${name}`,
          toolArtifactVideoA11y: ({ name }: { name: string }) => `Apri video artefatto dello strumento ${name}`,
          previewImageA11y: ({ name, current, total }: { name: string; current: number; total: number }) => `Immagine ${current} di ${total}: ${name}`,

          previewUnavailableA11y: "Anteprima multimediale non disponibile",
          unavailableImageA11y: ({ name }: { name: string }) => `${name} unavailable`,},
        cannotDisplayBinary: "Impossibile mostrare il contenuto del file binario",
        diff: "Differenze",
      file: "Documento",
      markdown: "Ribasso",
    diffModes: {
      pending: "In sospeso",
      included: "Incluso",
      combined: "Combinato",
    },
    fileActions: {
      selectForCommit: "Seleziona per il commit",
      selectFilesToCommit: "Seleziona file per il commit",
      stageFile: "Metti in stage il file",
      removeFromSelection: "Rimuovi dalla selezione",
      removeFromCommitSelection: "Rimuovi dalla selezione del commit",
      unstageFile: "Rimuovi dallo stage",
      selectionHint:
        "Seleziona Incluso o In sospeso per abilitare la selezione delle righe.",
      selectedLines: {
        selectLinesForCommit: "Seleziona righe per il commit",
        stageSelectedLines: "Metti in stage le righe selezionate",
        unstageSelectedLines: "Rimuovi dallo stage le righe selezionate",
      },
      clearSelection: "Cancella selezione",

      rangeSelection: "Selezione della gamma",
      selectEntireFileForCommit: "Seleziona l'intero file per il commit",},
    toolbar: {
      changedFiles: "File modificati",
      hiddenFiles: "Mostra file nascosti",
      details: "Dettagli",
      upload: "Carica",
      uploadFiles: "Carica file",
      uploadFolder: "Carica cartella",
      allRepositoryFiles: "Tutti i file del repository",
      repositoryView: "Vista repository",
      selectedForCommitView: "Selezionati per il commit",
      turnView: "Vista turno",
      sessionView: "Vista sessione",
      view: "Vista",
      review: "Revisione",
      list: "Elenco",
      scm: "Git",

      agentReportedTurnView: "Turno segnalato dall'agente",
      checkpointTurnView: "Turno checkpoint",},
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
      update: {
        remotes: {
          title: "Remoti",
          empty: "Nessun remoto configurato per questo repository.",
          addTitle: "Aggiungi remoto",
          editTitle: ({ name }: { name: string }) => `Modifica ${name}`,
          add: "Aggiungi remoto",
          remove: "Rimuovi",
          nameLabel: "Nome remoto",
          fetchUrlLabel: "URL di fetch",
          pushUrlLabel: "URL di push",
          namePlaceholder: "origine",
          fetchUrlPlaceholder: "URL di fetch",
          pushUrlPlaceholder: "URL di push (opzionale)",
          noFetchUrl: "Nessun URL di fetch",
          removeConfirmTitle: "Rimuovere il remoto?",
          removeConfirmBody: ({ name }: { name: string }) =>
            `Rimuovere ${name} da questo repository?`,
          errors: {
            nameRequired: "Inserisci un nome remoto.",
            fetchUrlRequired: "Inserisci un URL di fetch.",
            addFailed: "Impossibile aggiungere il remoto.",
            saveFailed: "Impossibile aggiornare il remoto.",
            removeFailed: "Impossibile rimuovere il remoto.",
          },
        },
        publishRepository: {
          title: "Pubblica su GitHub",
          body: "Crea un repository GitHub e aggiungilo come origin.",
          ownerLabel: "Proprietario",
          repositoryNameLabel: "Nome repository",
          repositoryNamePlaceholder: "nome-repository",
          visibilityLabel: "Visibilità",
          private: "Privato",
          public: "Pubblico",
          internal: "Interno",
          remoteKindLabel: "URL remoto",
          httpsRemote: "Remoto HTTPS",
          sshRemote: "Remoto SSH",
          originConflictLabel: "Origin esistente",
          keepOrigin: "Non sostituire",
          setOriginUrl: "Imposta URL di origin",
          pushCurrentBranch: "Esegui push del branch attuale",
          publish: "Pubblica repository",
          publishing: "Pubblicazione…",
          targetsUnavailable: "Non è stato possibile verificare dove pubblicare questo repository.",
          errors: {
            targetRequired: "Scegli un account o un'organizzazione GitHub.",
            nameRequired: "Inserisci un nome repository.",
            loadTargetsFailed: "Impossibile caricare le destinazioni di pubblicazione GitHub.",
            publishFailed: "Impossibile pubblicare il repository.",
          },

          commitRequired: 'Crea un commit prima di pubblicare con il push del branch attivo.',
          unsafeUrl: 'Il provider ha restituito un’azione del browser fuori dall’URL consentito.',
          originConflictRemediation: 'Scegli se mantenere il remote origin esistente o aggiornarlo al nuovo repository ospitato.',
          auth: {
              connectedAccountReady: 'Il servizio GitHub connesso è disponibile.',
              providerCliReady: 'GitHub CLI autenticato è disponibile.',
          },
          remediation: {
              connectGitHub: 'Connetti GitHub',
              installGh: 'Installa GitHub CLI',
              useManagedGh: 'Usa GitHub CLI gestito',
              authenticateGh: 'Autentica GitHub CLI',
              openBrowser: 'Apri browser',
          },},
        branchIntegration: {
          title: "Merge e rebase",
          sourceLabel: "Branch sorgente",
          sourcePlaceholder: "Branch o riferimento remoto",
          merge: "Unisci",
          rebase: "Ribasa",
          continue: "Continua",
          abort: "Interrompi",
          operationInProgress: ({ operation, source }: { operation: string; source: string }) =>
            `${operation} in corso da ${source}`,
          errors: {
            sourceRequired: "Inserisci un branch o riferimento sorgente.",
            mergeFailed: "Impossibile eseguire il merge del branch.",
            rebaseFailed: "Impossibile eseguire il rebase del branch.",
            continueFailed: "Impossibile continuare l’operazione.",
            abortFailed: "Impossibile interrompere l’operazione.",
          },
        },
        pullRequests: {
          title: "Richiesta pull",
          readyTitle: "Pronto per aprire una pull request",
          view: "Apri PR",
          openOrReuse: "Apri o riusa PR",
          pushAndOpen: "Pubblica e apri PR",
          createFeatureBranch: "Crea branch di funzionalità",
          createFeatureBranchAndOpen: "Crea branch e apri PR",
          featureBranchPromptTitle: "Nome branch di funzionalità",
          featureBranchPromptBody: "Happier passerà a questo branch prima di continuare.",
          defaultBranchRequiresFeature: "Crea un branch di funzionalità prima di aprire una pull request dal branch predefinito.",
          defaultBranchDenied: "Non è possibile aprire pull request direttamente dal branch predefinito.",
          states: {
            ready: "Pronto",
            open: "Aperta",
            closed: "Chiusa",
            merged: "Unita",
          },
          status: {
            creating: "Apertura pull request…",
            creatingFeatureBranch: "Creazione branch di funzionalità…",
            creatingFeatureBranchPullRequest: "Creazione branch di funzionalità e apertura pull request…",
            pushingAndCreating: "Pubblicazione branch e apertura pull request…",
          },
          unavailable: {
            notRepositoryTitle: "Nessun repository rilevato",
            notRepositoryBody: "Le azioni pull request appaiono quando questa sessione è collegata a un repository di controllo versione.",
            unknownProviderTitle: "Nessun provider di hosting rilevato",
            unknownProviderBody: "Aggiungi un remoto GitHub, GitLab o Bitbucket per abilitare le azioni pull request.",
            noBranchTitle: "Nessun branch selezionato",
            noBranchBody: "Passa a un branch prima di aprire una pull request.",
            detachedHeadTitle: "HEAD scollegato",
            detachedHeadBody: "Passa a un branch prima di aprire una pull request.",
          },
          errors: {
            featureBranchRequired: "Crea un branch di funzionalità prima di aprire una pull request.",
            openFailed: "Impossibile aprire la pull request.",
            branchNameRequired: "Inserisci un nome di branch di funzionalità.",
            createBranchFailed: "Impossibile creare il branch di funzionalità.",
            stackedFailed: "Impossibile completare il flusso pull request.",
          },
        },

        pullRequest: {
            title: "Richiesta pull",
            existing: "Richiesta pull esistente",
            ready: "Pronto per creare una richiesta pull",
            branchPair: ({ head, base }: { head: string; base: string }) =>
                `${head} in ${base}`,
            open: "Apri richiesta pull",
            create: "Crea richiesta pull",
            openCompose: "Apri composizione",
            unsafeUrl: "Il provider ha restituito un link fuori dall'URL consentito del repository.",
            defaultBranch: {
                confirmTitle: "Creare un branch di funzionalità?",
                confirmBody: "Crea un branch di funzionalità prima di aprire la richiesta pull per questa modifica sul branch predefinito.",
                confirm: "Crea branch",
            },
        },
        publish: {
            title: "Pubblica repository",
            description: "Crea un repository ospitato e collegalo come remoto.",
            repositoryNameLabel: "Nome repository",
            ownerLabel: "Proprietario",
            visibilityLabel: "Visibilità",
            protocolLabel: "URL remoto",
            pushCurrentBranch: "Invia il branch corrente",
            commitRequired: "Crea un commit prima di pubblicare con l'invio del branch abilitato.",
            submit: "Pubblica repository",
            unavailable: "La pubblicazione non è disponibile per questo repository.",
            unsafeUrl: "Il provider ha restituito un'azione del browser fuori dall'URL consentito.",
            auth: {
                connectedAccountReady: "Il servizio connesso GitHub è disponibile.",
                providerCliReady: "La CLI GitHub autenticata è disponibile.",
            },
            remediation: {
                connectGitHub: "Connetti GitHub",
                installGh: "Installa la CLI GitHub",
                useManagedGh: "Usa la CLI GitHub gestita",
                authenticateGh: "Autentica la CLI GitHub",
                openBrowser: "Apri browser",
            },
            visibility: {
                private: "Privato",
                public: "Pubblico",
                internal: "Interno",
            },
            protocol: {
                https: "HTTPS",
                ssh: "SSH",
            },
            remoteConflict: {
                label: "Remote origin esistente",
                fail: "Mantieni origin esistente",
                setUrl: "Sostituisci URL di origin",
                remediation: "Scegli se mantenere il remote origin esistente o aggiornarlo al nuovo repository ospitato.",
            },
        },},

      repositoryInit: {
          action: "Inizializza repository",
          confirmTitle: "Inizializzare il repository?",
          confirmBody: "Crea i metadati di controllo del codice sorgente per questa cartella così le modifiche possono essere tracciate.",
          confirm: "Inizializza",
          failed: "Impossibile inizializzare il repository.",
      },},

    indexLockRecovery: {
      title: "Rimuovere il lock dell’indice Git obsoleto?",
      body: "Happier può rimuovere il file index.lock risolto da Git per questo repository e riprovare una sola volta l’operazione di controllo del codice non riuscita. Non esegue reset, clean, restore né riparazioni ampie.",
      confirm: "Rimuovi lock e riprova",
      failed: ({ error }: { error: string }) => `Recupero del lock dell’indice non riuscito: ${error}`,
    },
    checkpointAttributionExclusive:
      'Il contenuto del checkpoint è esatto per questo intervallo del turno e il worktree era esclusivo di questa sessione.',
    noAgentReportedTurnChanges:
      "Nessuna modifica segnalata dall'agente rilevata per questo turno.",
    noCheckpointTurnChanges:
      'Nessuna modifica del checkpoint rilevata per questo turno.',},

  localServices: {
    inventory: {
      title: 'Servizi locali',
      loadingTitle: 'Scansione dei servizi locali',
      emptyTitle: 'Nessun servizio locale rilevato',
      errorTitle: 'La scansione dei servizi locali richiede attenzione',
      refreshing: 'Aggiornamento',
      state: {
        listening: 'In ascolto',
        stale: 'Obsoleto',
        gone: 'Non disponibile',
        unknown: 'Sconosciuto',
      },
      address: ({ value }: { value: string }) => `Address: ${value}`,
      folder: ({ value }: { value: string }) => `Folder: ${value}`,
      label: ({ value }: { value: string }) => `Label: ${value}`,
      process: ({ value }: { value: string }) => `Process: ${value}`,
      workspace: ({ value }: { value: string }) => `Workspace: ${value}`,
      confidence: ({ value }: { value: string }) => `Confidence: ${value}`,
            confidenceLabel: {
                strong: 'Corrispondenza ad alta affidabilità',
                moderate: 'Corrispondenza probabile',
                tentative: 'Corrispondenza provvisoria',
            },
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      countBadge: ({ total, running }: { total: string; running: string }) => `${total} services · ${running} running`,
    },
    session: {
      thisSessionTitle: 'Questa sessione',
      workspaceTitle: 'Area di lavoro',
    },
    scope: {
      workspace: 'Questa area di lavoro',
      machine: 'Questa macchina',
      toggleA11y: 'Cambia l\'ambito dei servizi tra questa area di lavoro e questa macchina',
    },
    source: {
      detected: 'Rilevato',
      managed: 'Gestito',
      packageScript: 'Script del pacchetto',
      preview: 'Anteprima',
      terminalUrl: 'URL del terminale',
      fileAsset: 'Risorsa file',
      recent: 'Recente',
    },
    band: {
      machine: 'Altri servizi della macchina',
      suggestions: 'Suggerimenti',
    },
    rowStatus: {
      running: 'In esecuzione',
      starting: 'Avvio',
      stale: 'Obsoleto',
      stopped: 'Arrestato',
      unavailable: 'Non disponibile',
    },
    managed: {
      title: 'Servizi gestiti',
      emptyTitle: 'Nessun servizio gestito',
      owner: ({ value }: { value: string }) => `Owner: ${value}`,
      route: ({ value }: { value: string }) => `Route: ${value}`,
      launchMode: ({ value }: { value: string }) => `Mode: ${value}`,
            launchModeLabel: {
                detectedAfterStart: 'Rilevato dopo l’avvio',
                assignedAtStart: 'Porta assegnata all’avvio',
                registeredByTool: 'Registrato dallo strumento',
            },
      url: ({ value }: { value: string }) => `URL: ${value}`,
      inventory: ({ value }: { value: string }) => `Inventory: ${value}`,
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      stopActionA11y: 'Ferma servizio gestito',
      restartActionA11y: 'Riavvia servizio gestito',
      status: {
        starting: 'Avvio',
        detecting: 'Rilevamento',
        running: 'In esecuzione',
        unhealthy: 'Non sano',
        stopping: 'Arresto',
        stopped: 'Arrestato',
        failed: 'Non riuscito',
      },
    },
    launcher: {
      title: 'Launchpad',
      refreshing: 'Aggiornamento servizi locali',
      openInBrowserA11y: 'Apri il servizio locale nel browser',
      status: {
        ready: 'Pronto per l\'anteprima',
        managed: 'Servizio gestito',
        unavailableGeneric: "Questo servizio non è disponibile al momento.",
      },
      unavailableReason: {
        launchUnavailable: "Questo servizio non può essere avviato da qui.",
        previewRegistrationUnavailable: "Questo servizio non può registrare unanteprima.",
        browserTargetUnavailable: "Questo servizio non può essere aperto nel browser.",
        starting: "Questo servizio è ancora in fase di avvio.",
        stale: "Questo servizio è stato rilevato ma non risponde più.",
        unavailable: "Questo servizio non è disponibile al momento.",
      },
    },
    publicPreview: {
      title: 'Anteprime pubbliche',
      createSubtitle: 'Crea un link di anteprima condivisibile',
      activeSubtitle: 'Link condivisibile attivo',
      secretLinkMode: 'Link segreto',
      authenticatedMode: 'Accesso autenticato',
      publicMode: 'Chiunque abbia il link',
      expiredSubtitle: 'Link scaduto',
      expiresInMinutes: ({ count }: { count: number }) => `Scade tra ${count} min`,
      expiresInHours: ({ count }: { count: number }) => `Scade tra ${count} h`,
      expiresInDays: ({ count }: { count: number }) => `Scade tra ${count} g`,
      modePromptTitle: 'Tipo di link',
      ttlPromptTitle: 'Durata del link',
      ttlPromptMessage: ({ service }: { service: string }) => `Per quanto tempo il link pubblico a "${service}" deve restare valido?`,
      ttlOptionMinutes: ({ count }: { count: number }) => `${count} minuti`,
      ttlOptionHours: ({ count }: { count: number }) => `${count} ore`,
      ttlOptionDays: ({ count }: { count: number }) => `${count} giorni`,
      disabledPolicySubtitle: 'Le anteprime pubbliche sono disattivate per questo servizio.',
      disabledUnsupportedModeSubtitle: 'Al momento Happier crea solo anteprime pubbliche con link segreto.',
      disabledLimitSubtitle: 'Limite delle anteprime pubbliche raggiunto. Revoca un link esistente prima di crearne un altro.',
      disabledNoPreviewSubtitle: 'Apri un’anteprima locale prima di creare un link pubblico.',
      disabledReason: {
        auditUnavailable: 'Il registro di audit dell’anteprima pubblica non è disponibile.',
        dnsTlsUnavailable: 'Le anteprime pubbliche attendono che DNS/TLS sia pronto.',
        expired: 'Questo link di anteprima pubblica è scaduto.',
        linkLifetimeUnconfigured: 'Sul server non è configurata la durata del link di anteprima pubblica.',
        modeUnconfigured: 'Sul server non è configurata alcuna modalità di anteprima pubblica.',
        policyInvalid: 'La policy dell’anteprima pubblica è incompleta.',
        previewNotEligible: 'Questa anteprima locale non è idonea per un link pubblico.',
        previewServerDisabled: 'Le anteprime dei servizi locali sono disattivate sul server.',
        publicBaseUrlUnavailable: 'L’URL base dell’anteprima pubblica non è configurato.',
        rateLimitProfileUnconfigured: 'Sul server non è configurato alcun profilo di limite di frequenza per le anteprime pubbliche.',
        rateLimitUnavailable: 'Il rate limiting dell’anteprima pubblica non è disponibile.',
        rateLimited: 'Questo link di anteprima pubblica è limitato dal rate limit.',
        relayUnavailable: 'Il relay dell’anteprima pubblica non è disponibile.',
        revoked: 'Questo link di anteprima pubblica è stato revocato.',
        secretLinkUnavailable: 'Le anteprime pubbliche con link segreto non sono configurate.',
        serverDisabled: 'Le anteprime pubbliche sono disattivate sul server.',
        sessionNotAuthorized: 'Non hai accesso per creare un link pubblico per questa sessione.',
        tunnelPortsUnconfigured: 'Il server non consente alcuna porta di tunnel.',
        tunnelRelayDisabled: 'Il relay del server per i tunnel delle macchine è disattivato.',
        tunnelSigningUnconfigured: 'Il server non ha una chiave di firma per i tunnel delle macchine.',
      },
      createActionA11y: 'Crea link di anteprima pubblica',
      revokeActionA11y: 'Revoca link di anteprima pubblica',
      confirmTitle: 'Rendere pubblico il servizio?',
      confirmMessage: ({ service }: { service: string }) =>
        `"${service}" diventerà raggiungibile pubblicamente su Internet tramite un link segreto condivisibile.`,
      confirmCta: 'Crea link pubblico',
            revokeConfirmTitle: 'Revocare il link pubblico?',
            revokeConfirmMessage: ({ url }: { url: string }) => `Revocare il link di anteprima pubblica ${url}? Chi lo usa perderà l’accesso.`,
            revokeConfirmCta: 'Revoca link',
            consequenceReach: 'Chiunque abbia il link può aprire questo servizio. Non serve accedere.',
            consequenceExpiry: 'Il link smette di funzionare da solo quando scade la durata indicata qui sotto.',
            consequenceRevoke: 'Puoi revocarlo in qualsiasi momento, da questo pannello.',
            lifetimeLabel: 'Durata',
            linkTypeLabel: 'Tipo di link',
            revealUrlA11y: 'Mostra il link completo',
            hideUrlA11y: 'Nascondi il link',
            expiresInClock: ({ clock }: { clock: string }) => `Scade tra ${clock}`,
            groupFooter: 'I link pubblici vengono registrati nel log di audit di questa macchina.',
    },
    actions: {
      terminateDetectedA11y: 'Termina servizio locale rilevato',
      forgetA11y: 'Nascondi questo servizio dall\'elenco',
      terminatePidOnlyConfidence: 'Affidabilità terminazione: identità solo PID; conferma richiesta',
            copyAddressA11y: 'Copia indirizzo del servizio',
            terminateConfirmTitle: 'Terminare il servizio?',
            terminateConfirmMessage: ({ service }: { service: string }) => `Terminare ${service}? Usalo solo se sei sicuro che sia il processo corretto.`,
            terminateConfirmCta: 'Termina',
            stopConfirmTitle: 'Fermare il servizio?',
            stopConfirmMessage: ({ service }: { service: string }) => `Fermare ${service}? Il servizio non sarà raggiungibile finché non si riavvia.`,
            stopConfirmCta: 'Ferma',
            startA11y: 'Avvia servizio',
            failure: {
                title: 'Azione non completata',
                refused: 'La macchina ha rifiutato questa azione. Controlla i permessi dei servizi locali di questa macchina e riprova.',
                unavailable: 'Questa azione non è disponibile per questo servizio su questa macchina.',
                incomplete: 'L’azione non è stata portata a termine. Puoi riprovare.',
            },
            failureTitle: {
                start: ({ service }: { service: string }) => `Impossibile avviare ${service}`,
                open: ({ service }: { service: string }) => `Impossibile aprire ${service}`,
                terminate: ({ service }: { service: string }) => `Impossibile terminare ${service}`,
                forget: ({ service }: { service: string }) => `Impossibile nascondere ${service}`,
                stop: ({ service }: { service: string }) => `Impossibile fermare ${service}`,
                restart: ({ service }: { service: string }) => `Impossibile riavviare ${service}`,
                copyAddress: 'Impossibile copiare l’indirizzo',
                expose: 'Impossibile creare il link pubblico',
                revokeExposure: 'Impossibile revocare il link pubblico',
                copyExposure: 'Impossibile copiare il link pubblico',
            },
    },
  },

  browserContext: {
    composer: {
      attachPageReference: 'Allega pagina',
      startAnnotation: 'Annota pagina',
      cancelAnnotation: 'Annulla annotazione',
      attachAnnotation: 'Allega annotazione',
      contextUnavailable: 'Contesto del browser non disponibile',
      attachedPage: ({ title }: { title: string }) => `Pagina: ${title}`,
      attachedPageStale: ({ title }: { title: string }) => `Aggiorna contesto pagina: ${title}`,
      attachedCount: ({ count }: { count: string }) => `${count} contesti del browser`,
      removeAttachedContext: 'Rimuovi contesto del browser',
      untitledPage: 'Pagina senza titolo',
    },
    editor: {
      title: 'Annota',
      toolSelect: 'Seleziona',
      toolRegion: 'Area',
      toolDraw: 'Disegna',
      toolErase: 'Cancella',
      commentPlaceholder: 'Aggiungi un commento',
      attach: 'Allega annotazione',
      cancel: 'Annulla',
      captureUnavailable: 'L’acquisizione dell’annotazione non è disponibile per questa vista.',
      selectUnavailable: 'La selezione degli elementi non è disponibile per questa vista.',
      marked: ({ count }: { count: string }) => `${count} contrassegnati`,
      removeMark: ({ label }: { label: string }) => `Rimuovi ${label}`,
      markElement: ({ label }: { label: string }) => `Elemento ${label}`,
      markRegion: 'Area',
      markStroke: 'Disegno',
    },
  },

  browserRecording: {
    actions: {
      start: 'Avvia registrazione',
      stop: 'Interrompi registrazione',
      cancel: 'Annulla registrazione',
    },
    fidelity: {
        pixel: 'Acquisizione visiva',
        cdp: 'Acquisizione browser',
        injectedPage: 'Acquisizione pagina',
        nativeCallback: 'Acquisizione nativa',
        streamFrame: 'Acquisizione stream',
        previewProxy: 'Acquisizione anteprima',
        unavailable: 'Acquisizione in attesa',
    },
    status: {
      noView: 'Nessuna vista browser selezionata.',
      unavailable: ({ reason }: { reason: string }) => `Registrazione non disponibile: ${reason}`,
      ready: ({ fidelity }: { fidelity: string }) => `Registrazione pronta (${fidelity})`,
      recording: ({ elapsed, fidelity }: { elapsed: string; fidelity: string }) => `Registrazione ${elapsed} (${fidelity})`,
      temporary: 'Temporanea',
      attached: 'Allegata',
      discarded: 'Scartata',
    },
  },

  browserAutomation: {
    actions: {
      cancel: 'Annulla automazione',
    },
    status: {
      noView: 'Nessuna vista browser selezionata.',
      unavailable: 'Automazione non disponibile',
            running: 'Automazione in corso',
            readyForActions: 'Automazione pronta',
      ready: ({ authority }: { authority: string }) => `Automazione pronta (${authority})`,
      active: ({ requestId }: { requestId: string }) => `Automazione in corso: ${requestId}`,
    },
    timeline: {
      entry: ({ action, status }: { action: string; status: string }) => `${action}: ${status}`,
            action: {
                inspect: 'Ispeziona pagina',
                interact: 'Interagisci con la pagina',
                navigate: 'Naviga nella pagina',
                browserAction: 'Azione del browser',
            },
            status: {
                succeeded: 'Fatto',
                failed: 'Non riuscito',
                canceled: 'Annullato',
                timedOut: 'Tempo scaduto',
                stale: 'Pagina non aggiornata',
                blocked: 'Bloccato',
                unsupported: 'Non supportato',
            },
    },
  },

  browserSurface: {
    title: 'Navigatore',
    openA11y: 'Apri browser',
    openHint: 'Apre il launchpad del browser nei dettagli.',
    openDisabledA11y: 'Browser non disponibile',
  },

  browserLaunchpad: {
    refreshing: 'Aggiornamento destinazioni browser',
    sections: {
      running: 'Anteprime in esecuzione',
      managed: 'Servizi gestiti',
      plugin: 'UI plugin',
      recent: 'Recenti',
      unavailable: 'Non disponibili',
    },
    status: {
      ready: 'Pronto da aprire',
      managed: 'Servizio gestito',
      plugin: 'UI plugin',
      recent: 'Destinazione recente',
      openUnavailable: 'Apertura non disponibile',
      unavailableGeneric: "Questa destinazione non è disponibile al momento.",
    },
    guidance: {
      title: 'Ancora nulla in esecuzione',
      body: 'Avvia un server di sviluppo e le porte localhost di questo spazio di lavoro appariranno qui automaticamente. Puoi anche digitare qualsiasi indirizzo sopra.',
    },
    urlEntry: {
      label: 'Apri un indirizzo',
      placeholder: 'Inserisci un URL',
      open: 'Apri indirizzo',
      invalid: 'Inserisci un indirizzo http o https valido.',
    },
    error: {
      title: 'Le destinazioni browser richiedono attenzione',
      subtitle: ({ reason }: { reason: string }) => `Aggiornamento non riuscito: ${reason}`,
    },
  },

  browserShell: {
    address: {
      label: 'Indirizzo del browser',
      placeholder: 'Inserisci URL',
            copy: 'Copia URL',
            searchUnconfigured: 'Nessun motore di ricerca configurato: digita un indirizzo web.',
    },
        frame: {
            errorTitle: 'Caricamento pagina non riuscito',
        },
    nonFramable: {
      title: 'Questo sito rifiuta di essere incorporato.',
      openInSystemBrowser: 'Apri nel browser di sistema',
    },
    toolbar: {
      back: 'Indietro',
      forward: 'Avanti',
      reload: 'Ricarica',
      stop: 'Interrompi',
      openNativeDevtools: 'Apri strumenti di sviluppo nativi',
      reloadAfterCrash: 'Ricarica la pagina',
    },
    tabs: {
      newTab: 'Nuova scheda',
    },
    origin: {
      newTab: 'Nuova scheda',
      localPreview: 'Anteprima locale',
      hostedPlugin: 'UI plugin',
      external: 'URL esterno',
      streamed: 'Browser in streaming',
      simulator: 'Simulatore',
    },
    security: {
      secure: 'Connessione sicura',
      local: 'Connessione locale',
      insecure: 'Non sicura',
      internal: 'Superficie interna',
      unknown: 'Stato connessione sconosciuto',
    },
    title: {
      untitled: 'Pagina senza titolo',
    },
    overflow: {
      open: 'Altri strumenti del browser',
      title: 'Strumenti del browser',
    },
    profile: {
      title: 'Stato del profilo browser',
      modeLabel: 'Modalità',
      storageLabel: 'Archiviazione',
      permissionsLabel: 'Permessi',
      unavailable: 'Non disponibile',
      mode: {
        ephemeral: 'Effimero',
        session: 'Sessione',
        user: 'Utente',
        plugin: 'Estensione',
      },
      storage: {
        unavailable: 'Nessuna partizione',
        ephemeral: 'Effimero',
        session: 'Sessione',
        persistent: 'Persistente',
        plugin: 'Estensione',
      },
      permissions: {
        none: 'Nessun permesso',
        active: ({ count }: { count: number }) => `${count} attivi`,
        prompt: 'Chiedi',
        denied: 'Negato',
      },
      management: {
        createProfile: 'Nuovo profilo',
        selectProfile: 'Seleziona profilo',
        revokePermission: 'Revoca',
        clearStorage: 'Cancella archiviazione',
      },
    },
    privacy: {
      title: 'Privacy e sicurezza',
    },
    status: {
      noView: 'Nessuna vista browser selezionata.',
      empty: 'Nessuna pagina caricata.',
      noUrl: 'Nessun URL caricato.',
      loading: 'Caricamento…',
      crashed: 'Questa pagina ha smesso di rispondere ed è stata chiusa.',
    },
    unavailable: {
      generic: "Questa pagina non è disponibile al momento.",
      desktopEngineUnavailable: "Il motore del browser integrato non è disponibile su questo computer.",
      desktopWebView: "Il motore del browser integrato non è disponibile su questo computer. Puoi comunque aprire questa pagina nel browser di sistema.",
      desktopWebViewUnsupportedPlatform: "La navigazione integrata non è ancora disponibile su questa piattaforma.",
      externalUrlPolicyDenied: "Questo sito è bloccato dai tuoi criteri di sicurezza.",
      externalUrlUnavailable: "Questo sito non può essere aperto nel browser integrato.",
      simulatorPreviewUnavailable: "L'anteprima del simulatore non è disponibile al momento.",
      sidecarRuntimeUnavailable: "Il runtime del browser non è disponibile al momento.",
      streamedBrowserUnavailable: "Il browser in streaming non è disponibile al momento.",
      hostUnavailable: "Connessione persa con l'host del browser.",
      targetKindUnavailable: "Questa destinazione non può essere aperta nel browser integrato.",
      browserProfileMissing: "Nessun profilo del browser disponibile per questa pagina.",
      hostedPluginBlocked: "Questa pagina del plugin è bloccata dai suoi criteri di sicurezza.",
      invalidUrl: "Questo indirizzo non può essere aperto.",
      ownerDisconnected: "Connessione persa con il proprietario della pagina.",
      surface: {
        disabled: "La navigazione integrata è disattivata.",
        viewTargetsDisabled: "Le destinazioni del browser sono disattivate.",
        hostLost: "Connessione persa con l'host del browser.",
        adapterRecovering: "Riconnessione al browser…",
        liveStateLost: "Sessione del browser attiva persa.",
        unsupportedTarget: "Questa destinazione non può essere aperta nel browser integrato.",
      },
    },
    devtools: {
      title: 'Diagnostica',
      collapse: 'Comprimi la diagnostica',
      expand: 'Espandi la diagnostica',
      close: 'Nascondi la diagnostica',
      open: 'Mostra la diagnostica',
      section: {
        console: 'Consolle',
                pageErrors: 'Errori pagina',
        network: 'Rete',
        elements: 'Elementi',
        resources: 'Risorse',
        storage: 'Archiviazione',
        info: 'Informazioni',
        performance: 'Prestazioni',
      },
    },
  },

  streamPlayer: {
    status: {
      opening: 'Apertura stream…',
      playing: 'In diretta',
      degraded: 'Degradato',
      reconnecting: 'Riconnessione…',
      stopped: 'Interrotto',
      unavailable: 'Stream non disponibile',
      errorGeneric: 'Errore stream',
      decoderUnavailable: 'La decodifica video non è disponibile in questo browser.',
      preservingLastFrame: 'Ultimo frame visualizzato',
      permissionExpired: 'Autorizzazione scaduta',
      leaseExpired: 'Permesso di controllo scaduto',
      lowBandwidth: 'Banda ridotta',
      degradedCodec: 'Codec degradato',
    },
    actions: {
      requestKeyframe: 'Richiedi keyframe',
      lowerQuality: 'Riduci qualità',
    },
    controls: {
      readOnly: 'Sola lettura',
      controlling: 'Controllo attivo',
      controlsUnavailable: 'Controlli non disponibili',
      controlsAvailable: 'Controlli disponibili',
    },
    renderer: {
      fallback: 'Renderer di riserva',
    },
  },

  simulatorPreview: {
    picker: {
      title: 'Dispositivi',
      empty: 'Nessun dispositivo simulatore disponibile.',
    },
    status: {
      connecting: 'Connessione al dispositivo…',
      restoring: 'Ripristino dell’anteprima…',
    },
    availability: {
      available: 'Disponibile',
      degraded: 'Degradato',
      unavailable: 'Non disponibile',
      noDevices: 'Nessun dispositivo simulatore disponibile.',
      captureUnavailable: 'La cattura non è disponibile per questo dispositivo.',
      resourceUnavailable: 'Questa risorsa del simulatore non è disponibile.',
      captureDegraded: 'La cattura è degradata.',
      streamDegraded: 'La qualità dello stream è degradata.',
      lastFrame: 'Visualizzazione dell’ultimo frame disponibile.',
      streamUnavailable: 'Lo stream non è disponibile.',
      unavailableGeneric: 'L\'anteprima del dispositivo non è al momento disponibile.',
    },
    toolbar: {
      heldByOther: 'In uso da un altro viewer',
            heldByOtherWithHolder: ({ holder }: { holder: string }) => `Controllato da ${holder}`,
      acquireControl: 'Prendi controllo',
      releaseControl: 'Rilascia controllo',
      renewControl: 'Rinnova controllo',
      snapshot: 'Istantanea',
            refreshFrame: 'Aggiorna frame',
            quality: 'Qualità',
            reduceBandwidth: 'Riduci banda',
      fps: 'Limite 30 FPS',
      scale: 'Limite 1080 px',
      rotateLeft: 'Ruota a sinistra',
      homeButton: 'Casa',
      backButton: 'Indietro',
      recentButton: 'Recenti',
      volumeUp: 'Alza volume',
      volumeDown: 'Abbassa volume',
            moreControls: 'Altri controlli dispositivo',
    },
    sidebands: {
      title: 'Diagnostica',
      logs: 'Log',
      accessibilityTree: 'Accessibilità',
      deviceConfig: 'Configurazione dispositivo',
      appMetadata: 'Metadati app',
      networkDiagnostics: 'Rete',
      route: 'Percorso',
      captureHealth: 'Stato cattura',
      refresh: 'Aggiorna',
      empty: 'Nessun dato.',
            open: 'Apri diagnostica',
            close: 'Chiudi diagnostica',
            refreshA11y: ({ section }: { section: string }) => `Aggiorna ${section}`,
            arrayValue: ({ count }: { count: string }) => `${count} elementi`,
            objectValue: ({ count }: { count: string }) => `${count} campi`,
            valueUnavailable: 'Non disponibile',
            fields: {
                level: 'Livello',
                message: 'Messaggio',
                route: 'Percorso',
                status: 'Stato',
                reason: 'Motivo',
            },
    },
    diagnostics: {
      item: ({ reasonCode }: { reasonCode: string }) => `Diagnostica: ${reasonCode}`,
    },
  },

  browserDiagnostics: {
    previewProxy: {
      title: 'Diagnostica anteprima',
      status: {
        available: 'Disponibile',
        stale: 'Obsoleta',
        unavailable: 'Non disponibile',
      },
      fidelity: {
        previewProxy: 'Proxy anteprima',
        unavailable: 'Non disponibile',
        cdp: 'CDP',
        injectedPage: 'Pagina iniettata',
        nativeCallback: 'Callback nativa',
        streamFrame: 'Frame stream',
      },
      activeFlows: ({ count }: { count: string }) => `${count} flussi attivi`,
      attributionAllViews: 'Traffico per questa anteprima, tutte le viste',
      staleNotice: 'La diagnostica e obsoleta; riconnettiti per richiedere una nuova istantanea.',
      unavailableReason: ({ reasonCode }: { reasonCode: string }) => `Diagnostica non disponibile: ${reasonCode}`,
      networkEmpty: 'Nessun traffico anteprima catturato.',
      familyAvailable: ({ family }: { family: string }) => `${family}: disponibile`,
      familyUnavailable: ({ family }: { family: string }) => `${family}: non disponibile`,
      httpFlow: ({ method, path, statusCode }: { method: string; path: string; statusCode: string }) => `${method} ${path} - ${statusCode}`,
      webSocketFlow: ({ subprotocol }: { subprotocol: string }) => `WebSocket - ${subprotocol}`,
      tunnelFlow: ({ flowId }: { flowId: string }) => `Tunnel ${flowId}`,
      flowBytes: ({ bytesIn, bytesOut }: { bytesIn: string; bytesOut: string }) => `In ${bytesIn} B / out ${bytesOut} B`,
      flowMessages: ({ messagesIn, messagesOut }: { messagesIn: string; messagesOut: string }) => `Messaggi ${messagesIn}/${messagesOut}`,
    },
    host: {
      title: 'Diagnostica browser',
      eventCount: ({ count }: { count: string }) => `${count} eventi diagnostici`,
      untrustedNotice: 'La diagnostica iniettata puo essere alterata dalla pagina e ha fedelta inferiore.',
      untrustedEvent: 'Evento iniettato non attendibile',
      eventsEmpty: 'Nessuna diagnostica browser catturata.',
      eventTitle: ({ family, kind }: { family: string; kind: string }) => `${family} - ${kind}`,
            eventTitles: {
                pageError: 'Errore pagina',
                console: 'Messaggio console',
            },
            eventKinds: {
                pageError: 'Errore pagina',
                consoleEntry: 'Voce console',
                network: 'Evento di rete',
                event: 'Evento',
            },
      eventSummaryUnavailable: 'Nessun metadato disponibile',
      families: {
        console: 'Consolle',
                pageError: 'Errori pagina',
        elements: 'Elementi',
        resources: 'Risorse',
        storage: 'Archiviazione',
        performance: 'Prestazioni',
        network: 'Rete',
        pageInfo: 'Info pagina',
                other: 'Diagnostica',
            },
      detail: {
        keys: ({ count }: { count: string }) => `Chiavi (${count})`,
        entries: ({ count }: { count: string }) => `Risorse (${count})`,
      },
      fields: {
        method: 'Metodo',
        status: 'Stato',
        url: 'URL',
        duration: 'Tempo',
        requestSize: 'Richiesta',
        responseSize: 'Risposta',
        socket: 'Canale socket',
        state: 'Stato',
        framesSent: 'Frame inviati',
        framesReceived: 'Frame ricevuti',
        bytesSent: 'Byte inviati',
        bytesReceived: 'Byte ricevuti',
        messages: 'Messaggi',
        protocol: 'Protocollo',
        selector: 'Selettore',
        backendNode: 'Nodo backend',
        rect: 'Rettangolo',
        accessibleName: 'Nome accessibile',
        storageType: 'Tipo archiviazione',
        keyCount: 'Chiavi',
        truncated: 'Troncato',
        level: 'Livello',
        arguments: 'Argomenti',
        message: 'Messaggio',
        serviceWorker: 'Worker di servizio',
        webgl: 'Stato WebGL',
        webrtc: 'Stato WebRTC',
        nodeCount: 'Nodi',
        elementCount: 'Elementi',
        maxDepth: 'Profondità massima',
        readyState: 'Stato pronto',
        lcp: 'LCP',
        cls: 'CLS',
        inp: 'INP',
        fcp: 'FCP',
        longTasks: 'Task lunghi',
        longTaskTime: 'Tempo task lunghi',
        responseEnd: 'Fine risposta',
        domContentLoaded: 'DOM pronto',
        loadEventEnd: 'Fine caricamento',
        type: 'Tipo',
      },
      interaction: {
        title: 'Diagnostica interattiva',
        enabled: 'Diagnostica interattiva attivata',
        disabled: 'Diagnostica interattiva disattivata',
        unavailable: ({ reasonCode }: { reasonCode: string }) => `Diagnostica interattiva non disponibile: ${reasonCode}`,
        ownerOnly: 'Solo il proprietario della sessione puo attivare la diagnostica interattiva.',
        enable: 'Attiva interazione',
        disable: 'Disattiva interazione',
        startPicker: 'Seleziona elemento',
        cancelPicker: 'Annulla selettore',
        pickerActive: 'Selettore elementi attivo',
        pickerUnavailable: 'Selettore elementi non disponibile',
        eval: {
            title: 'Consolle',
            placeholder: 'Valuta un’espressione',
            run: 'Esegui',
            empty: 'Nessuna espressione valutata.',
            resultLabel: 'Risultato',
            statusPending: 'Valutazione…',
            statusCompleted: 'Completato',
            statusFailed: 'Non riuscito',
            statusTimedOut: 'Tempo scaduto',
            statusBlocked: 'Bloccato',
            statusDegraded: 'Collector degradato',
            error: ({ reasonCode }: { reasonCode: string }) => `Errore: ${reasonCode}`,
            expand: 'Espandi',
            collapse: 'Comprimi',
            loading: 'Caricamento proprietà…',
            noProperties: 'Nessuna proprietà.',
            propertiesFailed: ({ reasonCode }: { reasonCode: string }) => `Proprietà non disponibili: ${reasonCode}`,
        },
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
        profiles: "Profili",
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
        selectProfile: ({ profile }: { profile: string }) => `Seleziona profilo ${profile}`,
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
        detailSearchPlaceholder: "Cerca superfici",
        noResults: "Nessuna azione corrisponde alla ricerca attuale.",
        noTargetsMatch: "Nessuna superficie corrisponde alla ricerca attuale.",
        noDescription: "Nessuna descrizione ancora disponibile.",
        requireApproval: "Richiedi approvazione",
        invalidActionTitle: "Azione non trovata",
        invalidActionSubtitle: "Questa azione non è più disponibile in questa build.",
        configureActionAccessibilityLabel: "Configura azione",
        approvalHelpTitle: "Modalità di approvazione",
        approvalHelpBody: "“Chiedi prima” mostra una conferma prima che questa azione venga eseguita da quella superficie. “Consentito” permette l’esecuzione da quella superficie senza richiesta di approvazione.",
        contributed: {
            machineSelectionTitle: 'Scegli una macchina per le azioni fornite',
            machineSelectionBody: 'Seleziona una macchina per visualizzare e configurare le azioni dichiarate dai plugin installati.',
            removedDescription: 'Questa azione fornita non è più disponibile dalla macchina selezionata. Le impostazioni salvate vengono conservate.',
            removedTargetsTitle: 'Azione fornita non disponibile',
            removedTargetsBody: 'Questa azione non è attualmente dichiarata dalla macchina selezionata. Le impostazioni salvate restano disponibili qui.',
        },
        toolExposure: {
            title: "Esposizione strumento",
            footer: "Controlla se le azioni idonee compaiono come strumenti diretti o restano disponibili solo tramite individuazione delle azioni.",
            subtitle: "Controlla la registrazione dello strumento diretto per questa superficie.",
            disabledSubtitle: "Attiva questa superficie prima di modificare l’esposizione dello strumento.",
            options: {
                default: {
                    subtitle: "Usa l’impostazione predefinita del prodotto per questa superficie.",
                },
                defaultDiscoverableOnly: {
                    title: "Usa predefinito (solo individuabile)",
                },
                defaultDirect: {
                    title: "Usa predefinito (strumento diretto)",
                },
                discoverableOnly: {
                    title: "Solo individuabile",
                    subtitle: "Disponibile tramite individuazione delle azioni senza aggiungere uno strumento diretto.",
                },
                direct: {
                    title: "Strumento diretto",
                    subtitle: "Registra questa azione come strumento richiamabile direttamente.",
                },
            },
        },
        spawnPolicy: {
            title: "Criteri di creazione sessioni IA",
            footer: "Questi controlli si applicano solo quando un assistente dentro una sessione Happier crea un’altra sessione. Le impostazioni ereditate dalla sessione padre restano consentite; gli elementi negati rifiutano sostituzioni esplicite con un errore chiaro.",
            toggles: {
                allowCustomDirectory: { title: "Directory personalizzata", subtitle: "Consenti all’assistente di scegliere una directory di lavoro diversa." },
                allowCrossMachine: { title: "Destinazioni tra macchine", subtitle: "Consenti la creazione su un’altra macchina disponibile." },
                allowBackendTargetOverride: { title: "Destinazione backend", subtitle: "Consenti di scegliere un agente o una destinazione backend diversi." },
                allowModelOverride: { title: "Modello", subtitle: "Consenti di scegliere un modello invece di ereditare quello padre." },
                allowPermissionModeOverride: { title: "Modalità permessi", subtitle: "Consenti sostituzioni uguali o inferiori. Le escalation vengono comunque rifiutate." },
                allowAgentModeOverride: { title: "Modalità agente", subtitle: "Consenti di scegliere una modalità agente o sessione." },
                allowConfigOptionOverrides: { title: "Opzioni di configurazione", subtitle: "Consenti opzioni provider come sforzo di ragionamento e workflow." },
                allowProfileOverride: { title: "Profilo", subtitle: "Consenti di selezionare un profilo per id senza esporre segreti." },
                allowEnvironmentVariables: { title: "Variabili d’ambiente", subtitle: "Consenti variabili d’ambiente esplicite nelle nuove sessioni." },
                allowConnectedServicesOverride: { title: "Servizi connessi", subtitle: "Consenti di selezionare associazioni di servizi connessi per riferimento." },
                allowMcpSelectionOverride: { title: "Selezione MCP", subtitle: "Consenti di sostituire la selezione MCP ereditata." },
                allowTranscriptStorageOverride: { title: "Archiviazione trascrizione", subtitle: "Consenti di scegliere una modalità di archiviazione compatibile." },
            },
            permissionCeiling: {
                title: "Limite permessi",
                subtitle: "Limite aggiuntivo opzionale sotto i permessi del chiamante.",
                options: {
                    inherit: { title: "Nessun limite aggiuntivo", subtitle: "Usa i permessi del chiamante come unico limite." },
                    default: { title: "Predefinito", subtitle: "Richiede il normale comportamento di approvazione o inferiore." },
                    acceptEdits: { title: "Accetta modifiche", subtitle: "Consente modifiche automatiche ma non bypass completo." },
                    bypassPermissions: { title: "Bypass permessi", subtitle: "Consente fino al bypass completo solo se anche il chiamante lo possiede." },
                    plan: { title: "Piano", subtitle: "Limita le sessioni create a pianificazione o sola lettura." },
                    "read-only": { title: "Sola lettura", subtitle: "Limita le sessioni create al comportamento di sola lettura." },
                    "safe-yolo": { title: "Yolo sicuro", subtitle: "Consente scritture automatiche sicure nello spazio di lavoro." },
                    yolo: { title: "Modalità yolo", subtitle: "Consente fino a yolo solo se anche il chiamante lo possiede." },
                },
            },
        },
        status: {
            allowed: ({ count }: { count: number }) => `${count} consentite`,
            askFirst: ({ count }: { count: number }) => `${count} chiedi prima`,
            off: ({ count }: { count: number }) => `${count} disattivate`,
            unavailable: ({ count }: { count: number }) => `${count} non disponibili`,
        },
        modes: {
            off: "Disattivato",
            askFirst: "Chiedi prima",
            allowed: "Consentito",
        },
        sections: {
            app: "Nell’app",
            voice: "Voce",
            integrations: "Integrazioni",
        },
        families: {
            browser: {
                title: "Navigatore",
            },
            simulator: {
                title: "Simulatore",
            },
            localServices: {
                title: "Servizi locali",
            },
            plugins: {
                title: "Plugin",
            },
            session: {
                title: "Sessioni",
            },
            scm: {
                title: "Controllo versione",
            },
            general: {
                title: "Generale",
            },
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
            requiredByAgentPolicy: "I criteri richiedono l'approvazione per l'agente. Questa azione chiede sempre prima.",
            presentUserRequired: 'Questa operazione richiede la tua presenza in Happier. I token API e i plugin attendibili possono rilevarla, ma non eseguirla.',
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
            pending_messages: {
                title: "Messaggi in sospeso",
                subtitle: "Visibile nei controlli dei messaggi in sospeso sotto la trascrizione della sessione.",
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
            agent: {
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
            api: {
                title: 'API esterna e SDK',
                subtitle: 'Disponibile per i token API tramite HTTP e l’SDK.',
            },
            plugin: {
                title: 'Plugin attendibili',
                subtitle: 'Disponibile per i plugin integrati e installati attendibili.',
            },
            contextual_ui: {
                title: "UI contestuale",
                subtitle: "Mostrata nelle superfici UI contestuali che non hanno un posizionamento dedicato.",
            },

            voice: {
                title: "Voce",
                subtitle: "Disponibile all’agente vocale come superficie richiamabile.",
            },},
    },

settingsSession: {
    newSessionDraftEntry: {
        title: 'Bozze di nuova sessione',
        footer: 'Scegli se Nuova sessione continua la bozza su questo dispositivo o ne apre una nuova.',
        resumeTitle: 'Riprendi la bozza precedente',
        resumeSubtitle: 'Continua la bozza avviata da Nuova sessione su questo dispositivo.',
        freshTitle: 'Inizia sempre da zero',
        freshSubtitle: 'Apri una nuova bozza ogni volta che scegli Nuova sessione.',
    },
	      sessionList: {
	          title: 'Elenco sessioni',
	          footer: 'Personalizza cosa appare in ogni riga della sessione.',
	          tagsTitle: 'Tag della sessione',
	          tagsEnabledSubtitle: "Controlli tag visibili nell'elenco sessioni",
	          tagsDisabledSubtitle: 'Controlli tag nascosti',
	          workingStatusAnimatedTextTitle: 'Testo di lavoro animato',
	          workingStatusAnimatedTextEnabledSubtitle: 'Alterna verbi di lavoro mentre una sessione è in esecuzione',
	          workingStatusAnimatedTextDisabledSubtitle: 'Mostra un’etichetta fissa al lavoro... mentre una sessione è in esecuzione',
	          narrowWorkingIndicatorTitle: 'Indicatore di lavoro stretto',
	          narrowWorkingIndicatorSpinnerSelectedSubtitle: 'Mostra uno spinner piccolo e neutro nelle righe strette',
	          narrowWorkingIndicatorPulseSelectedSubtitle: 'Mostra un punto pulsante nelle righe strette',
	          narrowWorkingIndicatorSpinnerTitle: 'Filatore',
	          narrowWorkingIndicatorSpinnerSubtitle: 'Uno spinner compatto e neutro mentre la sessione lavora.',
	          narrowWorkingIndicatorPulseTitle: 'Punto pulsante',
	          narrowWorkingIndicatorPulseSubtitle: 'Un punto animato compatto mentre la sessione lavora.',
	          workingIndicatorTitle: 'Indicatore di lavoro',
	          workingIndicatorSpinnerSelectedSubtitle: 'Mostra un piccolo spinner neutro mentre le sessioni lavorano',
	          workingIndicatorPulseSelectedSubtitle: 'Mostra un punto pulsante mentre le sessioni lavorano',
	          workingIndicatorSpinnerTitle: 'Filatore',
	          workingIndicatorSpinnerSubtitle: 'Uno spinner compatto e neutro mentre la sessione lavora.',
	          workingIndicatorPulseTitle: 'Punto pulsante',
	          workingIndicatorPulseSubtitle: 'Un punto animato compatto mentre la sessione lavora.',
	          identityDisplayTitle: 'Identità della sessione',
	          identityDisplaySubtitle: 'Scegli cosa appare prima dei nomi delle sessioni nell’elenco.',
	          identityDisplayAvatarTitle: 'Avatar',
	          identityDisplayAvatarSubtitle: 'Mostra l’avatar generato di ogni sessione.',
	          identityDisplayAgentLogoTitle: 'Logo agente',
	          identityDisplayAgentLogoSubtitle: 'Mostra il logo dell’agente per ogni sessione.',
	          identityDisplayNoneTitle: 'Nessuno',
	          identityDisplayNoneSubtitle: 'Nascondi il marcatore di identità nelle righe delle sessioni.',
	          headerIdentityDisplayTitle: "Identità dell'intestazione",
	          headerIdentityDisplaySubtitle: 'Scegli cosa appare prima del titolo dentro una sessione.',
	          headerIdentityDisplayAvatarTitle: 'Avatar',
	          headerIdentityDisplayAvatarSubtitle: "Mostra l'avatar generato della sessione.",
	          headerIdentityDisplayAgentLogoTitle: "Logo dell'agente",
	          headerIdentityDisplayAgentLogoSubtitle: "Mostra il logo dell'agente che esegue la sessione.",
	          headerIdentityDisplayNoneTitle: 'Nessuno',
	          headerIdentityDisplayNoneSubtitle: "Inizia l'intestazione con il titolo della sessione.",
	          activeColorTitle: 'Colore attivo del titolo',
	          activeColorSubtitle: 'Scegli quali sessioni usano il colore attivo del titolo.',
	          activeColorActivityAndAttentionTitle: 'Attività e attenzione',
	          activeColorActivityAndAttentionSubtitle: 'Usa il colore attivo per sessioni in corso e sessioni che richiedono attenzione.',
	          activeColorAttentionOnlyTitle: 'Solo attenzione',
	          activeColorAttentionOnlySubtitle: 'Usa il colore attivo solo per le sessioni che richiedono la tua attenzione.',
	          activeColorAllActiveTitle: 'Tutte le sessioni attive',
	          activeColorAllActiveSubtitle: 'Usa il colore attivo per ogni sessione attiva e connessa.',
	          sectionModeTitle: 'Sezioni delle sessioni',
	          sectionModeSubtitle: 'Scegli se separare le sessioni per attivita.',
	          sectionModeActivitySelectedSubtitle: 'Separa sessioni attive e inattive',
	          sectionModeSingleSelectedSubtitle: 'Mostra una sola sezione sessioni raggruppata per workspace',
	          sectionModeActivityTitle: 'Attive e inattive',
	          sectionModeActivitySubtitle: 'Separa le sessioni per attivita prima di raggrupparle per workspace.',
	          sectionModeSingleTitle: 'Tutte le sessioni insieme',
	          sectionModeSingleSubtitle: 'Usa una sola sezione sessioni e mantieni il raggruppamento per workspace per ogni sessione.',
	          menuSections: {
	              sortBy: 'Ordina per',
	              show: 'Mostra',
	              folderSortMode: 'Ordine cartelle',

	              organize: 'Organizza',},
	          orderingTitle: 'Ordine delle sessioni',
	          orderingSubtitle: 'Scegli come ordinare le sessioni nei loro gruppi.',
	          orderingOptions: {
	              custom: 'Personalizzato',
	              created: 'Creazione',
	              updated: 'Aggiornamento',
	          },
	          folderSortModeTitle: 'Ordine cartelle',
	          folderSortModeSubtitle: 'Scegli come cartelle e sessioni condividono la lista.',
	          folderSortModeFoldersFirstTitle: 'Cartelle prima',
	          folderSortModeFoldersFirstSubtitle: 'Raggruppa le cartelle sopra le sessioni in ogni workspace o cartella.',
	          folderSortModeMixedTitle: 'Misto',
	          folderSortModeMixedSubtitle: 'Consenti a cartelle e sessioni di mantenere un ordine condiviso esatto.',
	          folderSortModeMixedDisabledInDateModeSubtitle: 'L’ordine misto delle cartelle e disponibile con l’ordine personalizzato.',
	          attentionPromotionModeTitle: 'Sessioni che richiedono attenzione',
	          attentionPromotionModeSubtitle: 'Scegli dove appaiono le sessioni in attesa di te o pronte per la revisione',
	          attentionPromotionModeOffTitle: 'Lascia nella posizione normale',
	          attentionPromotionModeOffSubtitle: 'Mantieni l\'elenco esattamente com\'è raggruppato e ordinato',
	          attentionPromotionModeGlobalTitle: 'Raggruppa in alto',
	          attentionPromotionModeGlobalSubtitle: 'Mostra una sezione di attenzione sopra il resto',
	          attentionPromotionModeWithinGroupsTitle: 'Sposta in cima al gruppo attuale',
	          attentionPromotionModeWithinGroupsSubtitle: 'Mantieni le sessioni nella loro cartella o area di lavoro',
	          attentionStandingDefaultTitle: 'Mantieni le sessioni in Richiede attenzione',
	          attentionStandingDefaultEnabledSubtitle: 'Ogni sessione resta finché non la rimuovi',
	          attentionStandingDefaultDisabledSubtitle: 'Mantieni le sessioni una alla volta',
	          attentionStandingDefaultUnavailableSubtitle: 'Scegli prima una posizione in Sessioni che richiedono attenzione',
	          workingPlacementModeTitle: 'Sessioni in lavorazione',
	          workingPlacementModeSubtitle: 'Scegli dove appaiono le sessioni attualmente in lavorazione',
	          workingPlacementModeOffTitle: 'Lascia nella posizione normale',
	          workingPlacementModeOffSubtitle: 'Mantieni le sessioni in lavorazione esattamente come sono raggruppate e ordinate',
	          workingPlacementModeGlobalTitle: 'Raggruppa in alto',
	          workingPlacementModeGlobalSubtitle: 'Mostra una sezione di lavoro sotto le sessioni che richiedono attenzione',
	          workingPlacementModeWithinGroupsTitle: 'Sposta in cima al gruppo attuale',
	          workingPlacementModeWithinGroupsSubtitle: 'Mantieni le sessioni in lavorazione nella loro cartella o area di lavoro',
	          workspacePathDisplayTitle: 'Nomi degli spazi di lavoro',
	          workspacePathDisplayNameSelectedSubtitle: 'Mostra il nome dell’ultima cartella per impostazione predefinita',
	          workspacePathDisplayPathSelectedSubtitle: 'Mostra il percorso completo dello spazio di lavoro',
	          workspacePathDisplayName: 'Nome cartella',
	          workspacePathDisplayNameDescription: 'Usa l’ultimo segmento del percorso, salvo se hai rinominato lo spazio di lavoro.',
	          workspacePathDisplayPath: 'Percorso completo',
	          workspacePathDisplayPathDescription: 'Usa il percorso formattato dello spazio di lavoro, salvo se lo hai rinominato.',
	          workspaceFaviconsTitle: 'Favicon degli spazi di lavoro',
	          workspaceFaviconsEnabledSubtitle: 'Mostra le favicon del progetto rilevate accanto ai nomi degli spazi di lavoro',
	          workspaceFaviconsDisabledSubtitle: 'Nascondi le favicon del progetto dalle intestazioni degli spazi di lavoro',
	          workspaceMachineSubtitlesTitle: 'Nomi macchina',
	          workspaceMachineSubtitlesEnabledSubtitle: 'Mostra il nome della macchina sotto i nomi degli spazi di lavoro quando serve',
	          workspaceMachineSubtitlesDisabledSubtitle: 'Nascondi i nomi macchina dalle intestazioni degli spazi di lavoro',

	          folderTreeView: "Visualizzazione ad albero delle cartelle",},
	      mobileWorkspaceExperience: {
	          groupTitle: 'Area di lavoro mobile',
	          groupFooter: 'Controlla come sono organizzate le schermate di sessione sui telefoni.',
	          title: 'Modalità cockpit',
	          subtitle: 'Scegli il layout per telefono usato nelle sessioni.',
	          options: {
	              cockpitTitle: 'Cruscotto',
	              cockpitSubtitle: 'Usa schede in basso per chat, file, Git, schede e terminale.',
	              classicTitle: 'Classico',
	              classicSubtitle: 'Usa il layout sessione precedente.',
	          },
	      },
	      input: {
	          title: 'Aspetto dell\'immissione',
	          footer: "Configura l'aspetto della barra di input dell'agente.",
	      },
          detailedBehavior: { title: 'Comportamento dettagliato sessione', footer: 'Apri pagine dedicate per compositore, limiti provider, ripresa e terminale.' },
          rootGroups: {
              launchDefaults: { title: 'Impostazioni predefinite nuova sessione', footer: 'Scegli come iniziano le nuove sessioni e quali scelte vengono ricordate.' },
              listOrganization: { title: 'Organizzazione elenco sessioni', footer: 'Controlla ordine, raggruppamento, sezioni, sessioni inattive e pannello desktop predefinito.' },
              rowDetails: { title: 'Dettagli righe sessione', footer: 'Scegli quali etichette e dettagli visivi compaiono in ogni riga della sessione.' },
              activitySignals: { title: 'Segnali di attività e stato', footer: 'Controlla come vengono evidenziate le sessioni attive, in esecuzione e che richiedono attenzione.' },
              mobileLayout: { title: 'Layout sessione mobile', footer: 'Scegli il layout per telefono usato dentro le sessioni.' },
              agentPersonalization: { title: 'Istruzioni prompt per l’agente', footer: 'Controlla le istruzioni che chiedono agli agenti di nominare le sessioni e suggerire risposte.' },
          },
          composer: { title: 'Compositore e invio', entrySubtitle: 'Invio con Enter, cronologia, aspetto del compositore e invio mentre l’agente è occupato.' },
          providerLimits: { title: 'Limiti e uso provider', entrySubtitle: 'Recupero dai limiti d’uso e indicatore di utilizzo accanto al compositore.' },
          resume: { title: 'Ripresa e handoff', entrySubtitle: 'Ripresa tramite replay del transcript e opzioni per spostare sessioni tra macchine.' },
          runtime: { title: 'Runtime e terminale', entrySubtitle: 'Tmux, finestre Windows Terminal e compatibilità Terminal Connect.' },
      banners: {
          title: 'Banner',
          footer: 'I banner sopra il campo di scrittura possono essere ridotti a un badge di stato. Scegli se ricordarlo.',
          rememberVisibilityTitle: 'Ricorda la visibilità dei banner',
          rememberVisibilitySubtitle: 'I banner che chiudi restano nascosti in tutte le sessioni su questo dispositivo.',
          resetHiddenTitle: 'Mostra tutti i banner nascosti',
          resetHiddenSubtitle: 'Cancella i banner nascosti su questo dispositivo.',
      },
      inputBehavior: {
          title: 'Comportamento dell\'immissione',
          footer: 'Configura Invio con Enter e il comportamento della cronologia dei messaggi.',
          enterToSendEnabledNativeSubtitle: 'Premi Invio per inviare',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Modalità remota predefinita di Windows',
          windowNameTitle: 'Nome finestra di Windows Terminal',
          windowNamePlaceholder: 'happier',
          windowNameHint: 'Le sessioni aperte in Windows Terminal usano questa finestra con nome, così le nuove sessioni possono apparire come schede.',
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
        pendingDrainModeTitle: "Elaborazione della coda in attesa",
        pendingDrainModeFooter:
          "Scegli se l'agente prende un messaggio per ogni punto di disponibilità o raggruppa tutta la coda in attesa.",
        pendingDrainMode: {
          oneAtATimeTitle: "Un messaggio alla volta",
          oneAtATimeSubtitle:
            "Elabora solo il messaggio in attesa successivo ogni volta che l'agente è pronto.",
          drainAllTitle: "Svuota tutti i messaggi in attesa",
          drainAllSubtitle:
            "Elabora insieme tutti i messaggi in coda al prossimo punto di disponibilità (comportamento legacy).",
        },
        pendingDeliveryTimingTitle: "Tempistica della coda in attesa",
        pendingDeliveryTimingFooter:
          "Scegli quando possono essere consegnati i messaggi già in In attesa. I nuovi invii continuano a seguire la modalità di invio sopra.",
        pendingDeliveryTiming: {
          afterForegroundReadyTitle: "Dopo la risposta principale",
          afterForegroundReadySubtitle:
            "Consegna i messaggi in coda quando il turno principale è pronto, anche se il lavoro in background continua.",
          afterRuntimeIdleTitle: "Quando tutta l'attività è inattiva",
          afterRuntimeIdleSubtitle:
            "Mantieni i messaggi in coda finché il turno principale è pronto e l'attività in background è inattiva.",
        },
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
        nonSteerablePromptTitle: 'Quando un messaggio non può guidare il turno attivo',
        nonSteerablePromptFooter: 'Le modifiche alla modalità permessi e /clear o /compact non possono essere applicate a metà turno. Scegli cosa fa Happier con questi messaggi mentre l\'agente è occupato.',
        nonSteerablePrompt: {
            onTitle: 'Chiedi ogni volta',
            onSubtitle: 'Offri “Interrompi e invia ora” o “Metti in coda per dopo il turno”.',
            offTitle: 'Disattivato (legacy)',
            offSubtitle: 'Invia come prima anche se la modifica non può essere applicata a metà turno.',
        },
      },
      usageLimitRecovery: {
        title: "Recupero dei limiti di utilizzo",
        autoWaitTitle: "Attendi e riprendi automaticamente",
        autoWaitEnabledSubtitle: "Le sessioni con limite di utilizzo possono attendere il ripristino e riprendere automaticamente.",
        autoWaitDisabledSubtitle: "Chiedi prima di attendere il ripristino di un limite di utilizzo.",
        resumePromptTitle: "Prompt di ripresa",
        resumePromptStandardTitle: 'Invia prompt di continuazione',
        resumePromptStandardSubtitle: "Invia il normale prompt di continuazione quando il recupero riprende una sessione.",
        resumePromptOffTitle: "Disattivato",
        resumePromptOffSubtitle: "Riprendi senza inviare un prompt di continuazione aggiuntivo.",
        resumePromptCustomTitle: "Invia prompt personalizzato",
        resumePromptCustomSubtitle: "Dopo il recupero, invia il tuo prompt di continuazione.",
        customResumePromptTitle: "Prompt di continuazione personalizzato",
        customResumePromptPlaceholder: "Continua da dove eri rimasto.",
      },
      providerUsageGauge: {
        title: "Uso del provider",
        footer:
          "Controlla l'indicatore di quota mostrato accanto al compositore quando è disponibile un uso affidabile del provider.",
        visibilityTitle: "Mostra l'indicatore di uso del provider",
        visibilityEnabledSubtitle:
          "Mostra la quota restante del provider accanto al compositore quando disponibile.",
        visibilityHiddenSubtitle: "Nascondi la quota del provider dal compositore.",
        windowTitle: "Finestra dell'indicatore",
        windowMostConstrainedTitle: "Più vincolata",
        windowMostConstrainedSubtitle:
          "Mostra la finestra di quota affidabile con meno quota restante.",
        windowDailyTitle: "Giornaliera",
        windowDailySubtitle: "Preferisci la finestra di quota giornaliera.",
        windowWeeklyTitle: "Settimanale",
        windowWeeklySubtitle: "Preferisci la finestra di quota settimanale.",
        windowSessionTitle: "Sessione",
        windowSessionSubtitle: "Preferisci la finestra di quota della sessione corrente.",
        windowPrimaryTitle: "Primaria",
        windowPrimarySubtitle: "Preferisci la finestra di quota primaria del provider.",
        windowSecondaryTitle: "Secondaria",
        windowSecondarySubtitle: "Preferisci la finestra di quota secondaria del provider.",
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
        messageTimestampsTitle: "Mostra ora e data sotto i messaggi",
        messageTimestampsSubtitle:
          "Mostra il timestamp di ogni messaggio utente e assistente sotto il messaggio.",
        messageTimestamps: {
          hoverWebHiddenMobileTitle: "Al passaggio sul web, nascosto su mobile",
          hoverWebHiddenMobileSubtitle:
            "Mostra le marche temporali con le azioni del messaggio sul web e nascondile su mobile.",
          hoverWebAlwaysMobileTitle: "Al passaggio sul web, sempre su mobile",
          hoverWebAlwaysMobileSubtitle:
            "Mostra le marche temporali con le azioni del messaggio sul web e mantienile visibili su mobile.",
          alwaysTitle: "Sempre visibile",
          alwaysSubtitle: "Mostra sempre le marche temporali sotto i messaggi della trascrizione.",
          neverTitle: "Mai",
          neverSubtitle: "Nascondi le marche temporali sotto i messaggi della trascrizione.",
        },
        messageActions: {
          groupTitle: 'Azioni messaggio',
          groupFooter: 'Configura la selezione dei messaggi e le azioni di inoltro nella trascrizione.',
          selectionEnabled: {
            title: 'Abilita selezione messaggi',
            subtitle: 'Mostra un’icona di selezione sotto i messaggi per copiarli o inoltrarli in blocco',
          },
          sendToSessionEnabled: {
            title: 'Abilita Invio alla sessione',
            subtitle: 'Mostra un’azione di invio in blocco che aggiunge i messaggi selezionati alla bozza di un’altra sessione',
          },
          template: {
            title: 'Template di invio alla sessione',
            subtitle: 'Usa {{MESSAGES}}, {{SELECTED_COUNT}} e {{SOURCE_SESSION_NAME}} come segnaposto',
            placeholder: '{{MESSAGES}}',
            warningMissingPlaceholder: 'Suggerimento: aggiungi {{MESSAGES}} per controllare dove appaiono i messaggi selezionati',
          },
          bulkCopyFormat: {
            title: 'Formato copia',
            subtitle: 'Come formattare i messaggi copiati',
            markdownLabeled: 'Markdown con etichette dei ruoli (consigliato)',
            plain: 'Testo semplice',
          },
        },
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
            jumpToBottomButtonNewActivityLabel: ({ count }: { count: number }) => `${count} ${count === 1 ? "nuova attività" : "nuove attività"}, vai in fondo`,
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
            streamingPartialOutputTitle: "Mostra output parziale in streaming",
            streamingPartialOutputSubtitle:
              "Se disattivato, i messaggi dell'assistente compaiono solo al completamento.",
            thinkingPulseStaleTitle: "Finestra di scadenza del pensiero",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Attuale: ${value}ms`,
            thinkingPulseStalePromptTitle: "Finestra di scadenza del pensiero (ms)",
            thinkingPulseStalePromptBody:
              "Nasconde il pensiero attivo dopo questo tempo senza aggiornamenti.",
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
      sessionCreation: {
        title: "Modale nuova sessione",
        footer: "Scegli come si apre il modale della nuova sessione e come lo preparano le scorciatoie di progetto.",
        modalModeTitle: "Modalita del modale nuova sessione",
        modalModeSimpleTitle: "Semplice",
        modalModeSimpleSubtitle: "Apre il modale compatto centrato sul compositore.",
        modalModeWizardTitle: "Procedura guidata",
        modalModeWizardSubtitle: "Apre la configurazione guidata con selettori separati.",
        presentationGroupTitle: "Superficie nuova sessione",
        presentationGroupFooter: "Scegli se Nuova sessione si apre come schermata instradata o come modale.",
        presentationModeTitle: "Presentazione nuova sessione",
        presentationModeSubtitle: "Controlla la route usata quando apri Nuova sessione.",
        presentationAutoTitle: "Automatica",
        presentationAutoSubtitle: "Usa la presentazione modale predefinita su ogni piattaforma.",
        presentationScreenTitle: "Schermata",
        presentationScreenSubtitle: "Apre Nuova sessione nell'area principale con il compositore ancorato in basso.",
        presentationModalTitle: "Modale",
        presentationModalSubtitle: "Apre Nuova sessione sopra l'area di lavoro corrente come modale richiudibile.",
        wizardModeTitle: "Modalita procedura guidata",
        wizardModeEnabledSubtitle: "Apre la configurazione guidata con selettori separati.",
        wizardModeDisabledSubtitle: "Usa il modale compatto centrato sul compositore.",
        rememberLastProjectSelectionsTitle: "Ricorda le ultime selezioni di sessione del progetto",
        rememberLastProjectSelectionsEnabledSubtitle:
          "Le scorciatoie di progetto riutilizzano macchina, cartella, motore, modello e opzioni della sessione più recente.",
        rememberLastProjectSelectionsDisabledSubtitle:
          "Le scorciatoie di progetto preselezionano solo macchina e cartella del progetto.",
        rememberLastEngineSelectionsTitle: "Ricorda l'ultimo modello e le opzioni per ogni motore",
        rememberLastEngineSelectionsEnabledSubtitle:
          "Le nuove sessioni ripristinano l'ultimo modello, modo e opzioni del motore selezionati in questo account.",
        rememberLastEngineSelectionsDisabledSubtitle:
          "Le nuove sessioni usano i valori predefiniti salvo che una scorciatoia di progetto o una bozza fornisca una configurazione.",
        wizardSettingsTitle: "Procedura guidata nuova sessione",
        wizardSettingsSubtitle: "Scegli se ogni selettore della procedura appare come lista o menu a discesa.",
        wizardDispositionTitle: "Disposizione della procedura",
        wizardDispositionSubtitle: "Scegli quali selettori della procedura appaiono come liste o menu a discesa.",
        wizardLayoutTitle: "Layout della procedura",
        wizardLayoutFooter: "Controlla come sono disposte le sezioni della procedura sugli schermi larghi.",
        wizardColumnsTitle: "Layout a due colonne",
        wizardColumnsEnabledSubtitle: "Affianca i selettori correlati sugli schermi larghi.",
        wizardColumnsDisabledSubtitle: "Impila tutti i selettori della procedura in una colonna.",
        wizardPresentationTitle: "Layout dei selettori della procedura",
        wizardPresentationFooter:
          "Auto mantiene le sezioni brevi come liste e passa quelle lunghe a menu a discesa ricercabili.",
        wizardPresentationAutoTitle: "Automatico",
        wizardPresentationAutoSubtitle:
          "Lascia che Happier scelga il layout migliore in base alla quantità di contenuto.",
        wizardPresentationListTitle: "Lista",
        wizardPresentationListSubtitle: "Mostra tutte le righe direttamente nella procedura.",
        wizardPresentationDropdownTitle: "Menu a discesa",
        wizardPresentationDropdownSubtitle: "Mostra una riga compatta che apre il selettore completo.",
      },
          promptPersonalization: {
              title: 'Personalizzazione immediata',
              footer: 'Scegli quali istruzioni integrate Happier aggiunge alle nuove sessioni dell\'agente. Ciò non nasconde le opzioni già inviate da un agente.',
              askAgentToRenameSessionsTitle: 'Aggiornamenti del titolo della sessione',
              askAgentToRenameSessionsNeverTitle: 'Mai',
              askAgentToRenameSessionsNeverSubtitle: 'Non chiedere agli agenti di impostare i titoli delle sessioni.',
              askAgentToRenameSessionsInitialTitle: 'All\'inizio della sessione',
              askAgentToRenameSessionsInitialSubtitle: 'Richiedere agli agenti di impostare un breve titolo dal primo messaggio dell\'utente.',
              askAgentToRenameSessionsOngoingTitle: 'Quando il compito cambia',
              askAgentToRenameSessionsOngoingSubtitle: 'Richiedere agli agenti di impostare i titoli all\'inizio della sessione e quando l\'attività cambia.',
              askAgentToRenameSessionsInitialSelectedSubtitle: 'Agli agenti viene richiesto di impostare un titolo all\'avvio della sessione.',
              askAgentToRenameSessionsOngoingSelectedSubtitle: 'Agli agenti viene richiesto di aggiornare i titoli quando l\'attività cambia.',
              askAgentToRenameSessionsDisabledSubtitle: 'Agli agenti non viene richiesto di impostare i titoli; la ridenominazione manuale funziona ancora.',
              askAgentToSuggestReplyOptionsTitle: 'Chiedi all\'agente di suggerire opzioni di risposta',
              askAgentToSuggestReplyOptionsEnabledSubtitle: 'La richiesta chiede agli agenti di proporre opzioni di risposta rapida quando utile.',
              askAgentToSuggestReplyOptionsDisabledSubtitle: 'La richiesta non chiede agli agenti di aggiungere opzioni di risposta rapida.',
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
          defaultStorage: {
              title: "Tipo di sessione predefinito",
              footer: "Scegli se le nuove sessioni iniziano come sessioni Happier o come sessioni dirette supportate dal provider.",
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
          requiresModelNotice: "Scegli sotto un modello per il riassunto. Senza, il replay ricade solo sui messaggi recenti.",
          requiresExecutionRunsNotice: "I riassunti richiedono le esecuzioni, disattivate su questo account. Il replay userà solo i messaggi recenti.",
        },
        recentMessagesTitle: "Messaggi recenti da includere",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Limite seed (caratteri)",
        maxSeedCharsPlaceholder: "50000",
        maxSeedCharsRange: ({ min, max }: { min: number; max: number }) => `Tra ${min} e ${max} caratteri. Un numero fuori da questo intervallo viene salvato al limite più vicino.`,
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
    windowsTerminalSubtitle: "Apri la sessione come scheda nella finestra condivisa di Windows Terminal.",
    console: "Console",
    shortConsole: "Console",
    consoleSubtitle: "Apri la sessione in una finestra standard della console di Windows.",
  },
  settingsVoice: {
    ...voiceDiagnosticsTranslations.it,
    intents: {
      dictation: { title: 'Dettatura', subtitle: 'Trasforma una frase pronunciata in testo nel compositore.' },
      conversations: { title: 'Conversazioni vocali', subtitle: 'Scegli un provider e configura le impostazioni principali.' },
      privacy: { title: 'Privacy e dati', subtitle: 'Controlla elaborazione del provider, condivisione del contesto e cronologia vocale.', processingTitle: 'Elaborazione del provider' },
      advanced: { title: 'Avanzate', subtitle: 'Configura interfaccia vocale, macchina di esecuzione e diagnostica.' },
    },
    history: {
      title: 'Cronologia vocale',
      sectionTitle: 'Cronologia',
      sectionFooter: 'Rivedi o elimina le trascrizioni delle conversazioni vocali globali e senza destinazione.',
      entryTitle: 'Cronologia vocale',
      entrySubtitle: 'Cerca, esporta o cancella le trascrizioni vocali salvate.',
      searchTitle: 'Cerca nella cronologia caricata',
      searchFooter: 'La ricerca usa i messaggi vocali già decifrati su questo dispositivo.',
      searchPlaceholder: 'Cerca trascrizioni o provider',
      searchAccessibilityLabel: 'Cerca nella cronologia vocale',
      actionsTitle: 'Azioni cronologia',
      loading: 'Caricamento cronologia vocale…',
      emptyTitle: 'Nessuna cronologia vocale',
      emptyBody: 'Le trascrizioni vocali globali e autonome appariranno qui dopo il salvataggio.',
      noResultsTitle: 'Nessun risultato nella cronologia caricata',
      noResultsBody: 'Prova un’altra ricerca o carica messaggi meno recenti.',
      loadOlderTitle: 'Carica messaggi meno recenti',
      loadOlderSubtitle: 'Decifra la pagina precedente della cronologia vocale su questo dispositivo.',
      loadOlderFooter: 'I messaggi meno recenti restano sul server finché non li carichi o cancelli.',
      loadingOlder: 'Caricamento messaggi meno recenti…',
      loadOlderFailed: 'Impossibile caricare la cronologia vocale precedente.',
      exportTitle: 'Esporta cronologia vocale',
      exportSubtitle: 'Carica la cronologia rimanente e salvala come JSON.',
      exporting: 'Preparazione esportazione…',
      exportSucceeded: 'L’esportazione della cronologia vocale è pronta.',
      exportFailed: 'Impossibile esportare la cronologia vocale.',
      clearTitle: 'Cancella cronologia vocale',
      clearSubtitle: 'Elimina l’intera cronologia vocale autonoma per questo account.',
      clearing: 'Cancellazione cronologia vocale…',
      clearConfirmTitle: 'Cancellare la cronologia vocale?',
      clearConfirmBody: 'L’intera cronologia vocale autonoma di questo account verrà eliminata definitivamente. L’azione non può essere annullata.',
      clearConfirmAction: 'Cancella cronologia',
      clearSucceeded: 'La cronologia vocale è stata cancellata.',
      clearActiveCall: 'Termina la conversazione vocale prima di cancellare la cronologia vocale.',
      clearFailed: 'Impossibile cancellare la cronologia vocale.',
      errorTitle: 'Cronologia vocale non disponibile',
      errorBody: 'Happier non ha potuto caricare la cronologia cifrata per questo account. Controlla la connessione e riprova.',
      upgradeRequiredTitle: 'È necessario un aggiornamento per caricare la cronologia vocale',
      upgradeRequiredBody: 'Questo server non supporta il formato della cronologia cifrata usato da questo account. Aggiorna Happier sul server, poi ricarica.',
      supersededTitle: 'L’account attivo è cambiato',
      supersededBody: 'La richiesta è stata interrotta prima di usare un altro account. Ricarica per continuare in sicurezza.',
      retry: 'Riprova',
      roleYou: 'Tu',
      roleAssistant: 'Assistente',
    },
    dictation: {
      title: 'Dettatura',
      footer: 'Scegli il provider di riconoscimento vocale per il microfono dell’editor. È separato dalla Voce conversazionale, a meno che non li colleghi esplicitamente.',
      provider: 'Provider di riconoscimento vocale',
      providerSubtitle: 'Scegli un provider dedicato alla Dettatura o segui esplicitamente la Voce locale.',
      sameAsLocal: 'Come Voce locale',
      sameAsLocalSubtitle: 'Segui esplicitamente la selezione di riconoscimento vocale della Voce locale.',
      language: 'Lingua della dettatura',
      languageSubtitle: 'Suggerimento linguistico facoltativo usato solo per la Dettatura.',
      readiness: {
        title: 'Preparazione della dettatura',
        footer: 'Il controllo legge solo le impostazioni salvate e lo stato corrente di macchina e modello. Non apre il microfono, non invia audio e non contatta provider.',
        check: 'Controlla configurazione',
        checkSubtitle: 'Verifica passivamente la configurazione di Dettatura selezionata.',
        result: 'Stato configurazione',
        ready: 'Pronto per la Dettatura.',
        needsSetup: 'La configurazione è incompleta. Controlla i dettagli del provider selezionato.',
        installing: 'È ancora in corso l’installazione di un modello vocale richiesto.',
        incompatible: 'Il provider selezionato non è compatibile con questa piattaforma o configurazione.',
        unavailable: 'Impossibile confermare la preparazione dai dati locali correnti.',
      },
    },
    setupCheck: {
      title: 'Preparazione del provider',
      footer: 'Il controllo legge solo le impostazioni salvate e i dati locali di preparazione. Non apre il microfono, non avvia la Voce, non invia audio e non contatta il provider. L’avvio di Voce ricontrolla la capacità legata alla sessione.',
      check: 'Controlla configurazione',
      checkSubtitle: 'Esamina passivamente la configurazione del provider Voce selezionato.',
      result: 'Stato configurazione',
    },
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
      openaiRealtime: "OpenAI Realtime",
      openaiRealtimeSubtitle: "Usa una chiave API salvata o un account OpenAI selezionato esplicitamente",
      grokRealtime: "Grok Voice · BYOK",
      grokRealtimeSubtitle: "Usa la tua chiave API xAI per la voce in tempo reale",
    },
    realtimeProviders: {
      ...voiceProviderPrivacyTranslations.it,
      ...voiceRealtimeProviderSetupTranslations.it,
      operationFailed: 'Impossibile aggiornare l\'impostazione. Riprova.',
      operationFailedUnsaved: 'Impossibile aggiornare l\'impostazione. Le modifiche non sono state salvate.',
      operationFailedVoiceNotFound: 'La voce selezionata non è disponibile nell\'account collegato. Scegli un\'altra voce, quindi esegui di nuovo questa azione. Le modifiche non sono state salvate.',
      operationFailedStage: ({ stage }: { stage: string }) => `Passaggio non riuscito: ${stage}`,
      operationFailedStatus: ({ status }: { status: number }) => `Risposta del provider: HTTP ${status}`,
      codex: {
        sectionTitle: "Account Codex Live",
        accountTitle: "Account Voce globale",
        accountSubtitle: "Scegli l'account o il gruppo di account esatto dei Servizi connessi usato da Codex Voice globale. La Voce diretta usa sempre la sessione aperta.",
        privacyDisclosure: "L'audio e la conversazione Codex Live vengono inviati da questo dispositivo a OpenAI tramite WebRTC. La sessione Codex e l'account Connected Services selezionati operano tramite la macchina selezionata. OpenAI può ricevere un contesto di avvio e di sessione limitato e i risultati Codex delegati, così la conversazione può continuare e le risposte possono essere pronunciate. Il server e il relay di Happier non trasportano l'audio Codex Live; il daemon/app-server di Happier gestisce comunque segnalazione, ciclo di vita della sessione, delega, strumenti e controllo delle autorizzazioni. Possono intervenire relay di rete gestiti dal provider. Codex o OpenAI possono conservare istruzioni dello sviluppatore, materiale della conversazione in tempo reale e diagnostica correlata nell'archiviazione nativa del runtime del provider secondo le politiche dell'account e del provider selezionati; Happier non elimina né riscrive questi dati del provider.",
      },
    },
    ui: {
      title: "Superficie vocale",
      footer: "Feed opzionale a schermo degli eventi vocali (non scritto nella sessione).",
      activityFeedEnabled: "Abilita feed attività vocale",
      activityFeedEnabledSubtitle: "Mostra eventi vocali recenti a schermo",
      activityFeedAutoExpandOnStart: "Espandi automaticamente all'avvio",
      activityFeedAutoExpandOnStartSubtitle: "Espandi il feed automaticamente quando la voce parte",
      orbEnabled: "Orb vocale fluttuante",
      orbEnabledSubtitle: "Mostra il compagno vocale trascinabile su questo dispositivo. La voce resta disponibile dalla barra laterale e dal compositore.",
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
          speed: {
            title: "Velocità",
            subtitle: "0.7–1.2. Lascia vuoto per il predefinito.",
            promptTitle: "Velocità (0.7–1.2)",
            promptBody:
              "Inserisci un numero tra 0.7 e 1.2. Lascia vuoto per usare il predefinito.",
            invalid: "Inserisci un numero tra 0.7 e 1.2.",
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
    externalCredentials: {
      ...voiceExternalCredentialApprovalTranslations.it,
      apiKeyTitle: "Chiave API",
      promptTitle: "Collega questo provider vocale",
      promptDescription: "Incolla la chiave API del provider. Verrà salvata nel tuo account e inviata solo all’endpoint dichiarato dal plugin; il codice runtime del plugin non la riceve.",
      footer: "Le chiavi salvate vengono archiviate nel tuo account. La mediazione dell’host le invia all’endpoint dichiarato del provider; il codice del plugin riceve solo il risultato dell’operazione.",
      rawPromptDescription: "Incolla la chiave API del provider. Il codice del plugin nel runtime dichiarato di questo provider riceve direttamente la credenziale selezionata e può usarla o copiarla.",
      rawFooter: "L’accesso diretto alla credenziale consente al codice del plugin nel runtime dichiarato di ricevere direttamente la credenziale selezionata e usarla o copiarla. Verifica l’accesso prima dell’uso.",
      rawCredentialAccessReviewBody: ({ pluginId, localId, credentialSlot, source, realm, phase }: { pluginId: string; localId: string; credentialSlot: string; source: string; realm: string; phase: string }) =>
        `Il codice del plugin per ${pluginId}/${localId} riceve la credenziale ${source} selezionata per ${credentialSlot} durante ${phase} nel runtime ${realm}. Può usarla o copiarla.`,
      ready: "Chiave API salvata",
      missing: "Chiave API richiesta",
      unavailable: "Configurazione delle credenziali non disponibile",
    },
    local: {
      ...voiceLocalCredentialTranslations.it,
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
          machineCredentialRestrictionBody: "La chiave salvata è limitata a un certificato di app Android e non può essere usata dalla macchina selezionata. Inserisci una chiave API separata compatibile con la macchina; il valore sincronizzato esistente resterà invariato per i client meno recenti.",
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

        provider: {
          title: "Neurale locale (beta)",
          subtitle:
            "STT tramite daemon sul web; i pacchetti di streaming Sherpa nativi restano disponibili quando supportati.",
          detail: "Motore Sherpa",
        },},
      executionMachine: {
        groupTitle: "Esecuzione vocale locale",
        groupFooter: "Scegli dove eseguire voce locale, gestione dei modelli e agente vocale.",
        title: "Macchina di esecuzione",
        fallbackSubtitle: "Scegli una macchina per la voce locale.",
        autoTitle: "Automatica",
        autoSubtitle: "Usa l’attività recente per scegliere una macchina disponibile.",
        onlineLabel: "In linea",
        offlineLabel: "Non in linea",
        unknownMachineLabel: "Macchina sconosciuta",
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

      localNeuralTts: {
        provider: {
          title: "Neurale locale (beta)",
          subtitle: "TTS neurale tramite daemon sul web, con pacchetti modello sul dispositivo dove supportato.",
          detail: "Neurale locale",
        },
      },
      openaiCompatStt: {
        provider: {
          title: "Endpoint compatibile con OpenAI",
          subtitle: "Usa il tuo server di trascrizione compatibile con Whisper.",
          detail: "Server",
        },
      },
      openaiCompatTts: {
        provider: {
          title: "Endpoint compatibile con OpenAI",
          subtitle: "Usa il tuo server TTS locale o remoto compatibile con OpenAI.",
          detail: "Server",
        },
      },
      deviceSttDetail: "Dispositivo",
      deviceTtsDetail: "Dispositivo",
      daemonInference: {
        execution: {
          title: "Esecuzione neurale locale",
          subtitle: "Scegli se la voce neurale locale viene eseguita sul dispositivo o sul daemon.",
          options: { auto: "Automatico", device: "Dispositivo", daemon: "Daemon vocale" },
          optionSubtitles: {
            auto: "Preferisce il percorso di esecuzione consigliato per questa piattaforma.",
            device: "Esegue la voce neurale locale direttamente su questo dispositivo quando supportato.",
            daemon: "Esegue la voce neurale locale tramite il daemon della voice home.",
          },
        },
        service: {
          title: "Servizio di inferenza del daemon",
          subtitle: "Stato del servizio di inferenza del daemon della voice home.",
        },
        model: {
          title: "Pacchetto modello del daemon",
          subtitleTts: "Installa e aggiorna il pacchetto modello TTS del daemon.",
          subtitleStt: "Installa e aggiorna il pacchetto modello STT del daemon.",
        },
        remove: {
          title: "Rimuovi file modello del daemon",
          subtitle: "Elimina i file modello lato daemon per questo pacchetto.",
          detailInstalled: "Rimuovi file daemon installati",
        },
        states: {
          loading: "Caricamento…",
          machineUnreachable: "Daemon della voice home non disponibile.",
          unavailable: "Inferenza del daemon non disponibile.",
          runtimeUnavailable: "Runtime del daemon non disponibile.",
          relayDisabled: "Relay del daemon disattivato.",
          relayCapped: "Capacità del relay del daemon raggiunta.",
          requestTimeout: "Richiesta al daemon scaduta.",
          warming: "Riscaldamento modello…",
          ready: "Pronto",
          degraded: "Degradato",
          idle: "Inattivo",
          installing: "Installazione…",
          installed: "Installato",
          installError: "Installazione non riuscita",
          notInstalled: "Non installato",
          latencyDemoted: "Latenza degradata; uso della voce del dispositivo per questa conversazione.",
          fallbackToDevice: "Ripiego alla voce del dispositivo.",
        },
      },
      models: {
          nativeOptions: {
              kokoroEnvironmentDefaultTitle: "Predefinito (dall’ambiente)",
              kokoroDefaultSubtitle: "Modello vocale neurale locale predefinito.",
              kokoroHigherQualitySubtitle: "Modello vocale Kokoro locale di qualità superiore.",
              kokoroEnvironmentDefaultSubtitle: "Usa i valori predefiniti del pacchetto di modelli Kokoro configurati nell’ambiente.",
              sherpaStreamingRecommendedSubtitle: "Streaming a bassa latenza (consigliato).",
          },
          title: "Modelli vocali locali",
          statusTitle: "Servizio modelli",
          footer: "Installa pacchetti di modelli vocali locali sul tuo daemon vocale e scegli quello predefinito per ogni tipo.",
          sttGroupTitle: "Modelli da voce a testo",
          ttsGroupTitle: "Modelli da testo a voce",
          defaultBadge: "Predefinito",
          defaultSubtitle: "Predefinito per questo tipo",
          installSubtitle: "Tocca per installare sul daemon",
          setDefaultSubtitle: "Tocca per usare come predefinito",
          unknownSubtitle: "Stato non disponibile",
          modelFiles: ({ size }: { size: string }) => `File del modello: ${size}`,
          removeConfirmTitle: "Rimuovi pacchetto modello",
          removeConfirmBody: ({ name }: { name: string }) => `Eliminare i file lato daemon per ${name}?`,
          state: {
              notInstalled: "Non installato",
              downloading: "Download…",
              installed: "Installato",
              warming: "Riscaldamento…",
              ready: "Pronto",
              evicted: "Scaricato",
              error: "Installazione non riuscita",
              unknown: "Stato non disponibile",
          },
      },
      machineErrors: {
        mic_permission_denied: "Autorizzazione al microfono negata.",
        mic_ended: "L'ingresso del microfono si è interrotto.",
        mic_plateau: "L'audio del microfono si è bloccato.",
        transport_disconnect: "La connessione vocale si è interrotta.",
        provider_error: "Il provider vocale ha restituito un errore.",
        provider_auth_invalid: "Aggiungi o aggiorna la chiave API del provider vocale selezionato.",
        audio_context_suspended: "L'uscita audio è sospesa.",
        stt_timeout: "Tempo scaduto per l'avvio dell'ascolto.",
        tts_failed: "La sintesi vocale non è riuscita.",
        turn_aborted: "Il turno vocale è stato annullato.",
        authentication_required: "Connetti l’agente selezionato per usare Voce.",
        session_unavailable: "La sessione selezionata non è più disponibile per Voce.",
        unsupported_runtime: "Installa il runtime dell’agente selezionato per usare Voce.",
        update_required: "Aggiorna il runtime dell’agente selezionato per usare Voce.",
        feature_unavailable: "Voce non è disponibile per il runtime dell’agente selezionato.",
      },},
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
      currentUiContextModeTitle: "Contesto dell’interfaccia corrente",
      currentUiContextModeSubtitle:
        "Scegli quando la voce può usare il contesto semantico limitato della finestra attiva dell’app Happier o della scheda del browser.",
      currentUiContextMode: {
        offTitle: "Disattivato",
        offSubtitle: "La voce non riceve il contesto dell’interfaccia corrente né i comandi contestuali da questo client.",
        onDemandTitle: "Su richiesta",
        onDemandSubtitle: "Quando lo chiedi, la voce può leggere il contesto semantico limitato di questa finestra dell’app o scheda del browser. I comandi contestuali restano soggetti a controlli separati.",
        automaticTitle: "Automatico",
        automaticSubtitle: "La voce riceve automaticamente anche i metadati di navigazione di base e l'apertura di una sessione ne condivide il contesto in base alle impostazioni di condivisione qui sopra. I comandi contestuali restano soggetti a controlli separati.",
      },
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
    history: {
      title: "Cronologia delle impostazioni",
      footer: "Ripristina le preferenze dell'account da uno snapshot salvato. Dati dell'app, segreti e credenziali restano ai valori attuali.",
      loading: "Caricamento cronologia…",
      empty: "Nessuno snapshot salvato",
      unavailable: "Cronologia non disponibile",
      entryTitle: ({ version }: { version: string }) => `Ripristina versione ${version}`,
      entrySubtitle: ({ recordedAt }: { recordedAt: string }) => `Salvato il ${recordedAt}`,
      restoreConfirmTitle: "Ripristinare le impostazioni?",
      restoreConfirmBody: "Le preferenze dell'account verranno sostituite con i valori dello snapshot selezionato.",
      restoreConfirmAction: "Ripristina",
      restoredTitle: "Impostazioni ripristinate",
      restoredBody: "Le preferenze dell'account sono state ripristinate dallo snapshot selezionato.",
      unchangedBody: "Le preferenze attuali dell'account corrispondono già allo snapshot selezionato.",
      conflictTitle: "Impostazioni modificate",
      conflictBody: ({ currentVersion }: { currentVersion: string }) => `Le impostazioni sono cambiate durante il ripristino (versione attuale ${currentVersion}). Non è stato scritto nulla: controlla le impostazioni attuali e riprova.`,
      outcomeUnknownBody: "Il ripristino potrebbe essere avvenuto o meno. Verifica le impostazioni attuali prima di riprovare.",
      invalidBody: "Lo snapshot selezionato non può essere ripristinato in sicurezza. Non è stato scritto nulla.",
      unavailableBody: "Impossibile ripristinare lo snapshot selezionato. Non è stato scritto nulla.",
    },
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
    deleteAccount: "Elimina account",
    deleteAccountSubtitle: "Elimina definitivamente questo account e i suoi dati dal server",
    deleteAccountConfirmTitle: "Eliminare questo account?",
    deleteAccountConfirmBody: "Questa operazione elimina definitivamente i dati dell’account archiviati sul server e non può essere annullata. Digita DELETE per continuare.",
    deleteAccountInvalidTitle: "La conferma non corrisponde",
    deleteAccountInvalidBody: "Digita esattamente DELETE per continuare.",
    deleteAccountFailedTitle: "Eliminazione non confermata",
    deleteAccountFailed: "Happier non ha potuto confermare l’eliminazione. L’accesso locale è stato mantenuto per consentirti di riprovare.",
    deleteAccountCleanupFailedTitle: "Account eliminato",
    deleteAccountCleanupFailed: "Il server ha confermato l’eliminazione, ma questo dispositivo non ha completato la cancellazione dei dati locali. Riapri Happier ed esci se l’account è ancora visibile.",
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
    updateShort: "Aggiorna",
    updateAvailable: "Aggiornamento disponibile",
    pressToApply: "Premi per applicare l'aggiornamento",
    whatsNew: "Novità",
    seeLatest: "Vedi gli ultimi aggiornamenti e miglioramenti",
    nativeUpdateAvailable: "Aggiornamento app disponibile",
    tapToUpdateAppStore: "Tocca per aggiornare nell'App Store",
    tapToUpdatePlayStore: "Tocca per aggiornare nel Play Store",

    checkNowTitle: "Controlla ora",
    checkNowSubtitle: "Controlla se sono disponibili aggiornamenti dell'app.",
    lastCheckedTitle: "Ultimo controllo",},

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: string }) => `Versione ${version}`,
    noEntriesAvailable: "Nessuna voce di changelog disponibile.",
  },

  releaseNotes: {
    viewFullChangelog: "Vedi tutte le note di rilascio",
    mediaUnavailable: "Contenuto multimediale non disponibile",
    storyDeck: {
      dragToDismiss: "Trascina per chiudere",
      letsGo: "Andiamo!",
      slideAnnouncement: ({ title, current, total }: { title: string; current: number; total: number }) => `${title} - ${current} / ${total}`,
    },
    defaultTitle: "Novità",
    onboardingShowcase: {
        details: PRODUCT_STORY_DETAILS_ENGLISH,
                "title": "Benvenuto in Happier",
                "subtitle": "I tuoi agenti IA, ovunque lavori.",
                "cards": {
                    "welcome": {
                        "title": "Benvenuto in Happier",
                        "everywhereTitle": "I tuoi agenti IA, ovunque lavori",
                        "everywhereBody": "Claude Code, Codex, OpenCode, Pi e molto altro: su telefono, tablet, browser o desktop.",
                        "cockpitTitle": "Il tuo cockpit mobile",
                        "cockpitBody": "Chat, file, Git, editor, terminale. Tutto ciò che ti serve per costruire e pubblicare il tuo prossimo progetto, a portata di mano.",
                        "existingTitle": "Sessioni esistenti, già disponibili",
                        "existingBody": "Qualsiasi sessione Claude, Codex o OpenCode in esecuzione sulla tua macchina, aprila in Happier in tempo reale.",
                        "voiceTitle": "Un assistente vocale con cui ragionare",
                        "voiceBody": "Chiedi cosa stanno facendo i tuoi agenti, approva richieste di permesso e invia messaggi. A mani libere.",
                        "reviewTitle": "Rivedi diff e lascia commenti",
                        "reviewBody": "Segna righe specifiche in file o diff, scegli quali note inviare e passale direttamente a un agente.",
                        "subagentsTitle": "Subagenti cross-provider",
                        "subagentsBody": "Avvia subagenti Codex da una sessione Claude. Dividi il lavoro tra agenti. Instrada messaggi tra sessioni.",
                        "tuisTitle": "Usa le tue TUI preferite",
                        "tuisBody": "Esegui Claude Code, Codex o OpenCode nella loro interfaccia terminale nativa. Happier la cattura e la sincronizza su ogni dispositivo.",
                        "inboxTitle": "Una inbox. Ogni sessione.",
                        "inboxBody": "Tutte le approvazioni pendenti, richieste di permesso e attività non lette, da ogni sessione e macchina, in un unico posto.",
                        "mcpTitle": "Una configurazione MCP. Ogni provider.",
                        "mcpBody": "Definisci i server MCP una sola volta. Funzionano su tutti i backend, inclusi i provider che non supportano MCP nativamente.",
                        "controlTitle": "Accoda, guida, biforca, ripristina",
                        "controlBody": "Accoda messaggi mentre l’agente è occupato. Guida un turno in corso. Biforca da qualsiasi messaggio. Annulla se serve.",
                        "automationsTitle": "Automazioni",
                        "automationsBody": "Pianifica sessioni ricorrenti per monitorare PR, controllare issue o eseguire qualsiasi attività a intervalli regolari.",
                        "accountsTitle": "Account multipli e monitoraggio quote",
                        "accountsBody": "Collega più account Claude o OpenAI: personale, lavoro, team. Monitora l’uso di ciascuno direttamente nell’app.",
                        "promptsTitle": "Prompt, skill e profili",
                        "promptsBody": "Prompt riutilizzabili, bundle di skill e profili backend, sincronizzati su ogni sessione e dispositivo.",
                        "privacyTitle": "Open-source. Crittografato end-to-end. Self-hostable.",
                        "privacyBody": "Le tue sessioni restano private. Il codice è aperto. Fai self-hosting con un solo comando.",
                        "petsTitle": "Scopri Pets",
                        "petsBody": "Un piccolo compagno per le sessioni lunghe. Utile? Forse. Affascinante? Sicuro."
                    ,
                        row1Title: "Sessioni su ogni dispositivo",
                        row1Body: "Riprendi da dove avevi lasciato: telefono, tablet, web o desktop.",
                        row2Title: "Vai veloce, consegna prima",
                        row2Body: "La sincronizzazione in tempo reale tiene allineati terminal, agenti e file.",
                        row3Title: "Privato per impostazione predefinita",
                        row3Body: "Crittografia end-to-end perché il tuo lavoro resti tuo.",},
                    "anywhere": {
                        "title": "Inizia ovunque. Continua dappertutto.",
                        "wideTitle": "Inizia ovunque.\nContinua dappertutto.",
                        "body": "Avvia una sessione da qualsiasi posto. Seguila in tempo reale, invia messaggi e approva permessi da telefono, browser o desktop.",
                        "alt": "Immagine segnaposto astratta per le sessioni agente cross-device."
                    },
                    "terminalTuis": {
                        "title": "Ami il terminale? Anche noi!",
                        "wideTitle": "Ami il terminale?\nAnche noi!",
                        "body": "Esegui Claude Code, Codex o OpenCode nella loro interfaccia terminale nativa. Segui, invia messaggi e approva permessi dal telefono.",
                        "alt": "Immagine segnaposto astratta per la sincronizzazione dell'interfaccia utente del terminale."
                    },
                    "cockpit": {
                        "title": "Tutto ciò che ti serve. A un tap.",
                        "wideTitle": "Tutto ciò che ti serve.\nA un tap",
                        "body": "Chat, file, Git, editor, terminale. Interagisci con l’agente, sfoglia e modifica file, rivedi diff, gestisci branch Git, apri PR e apri un terminale live.",
                        "alt": "Immagine segnaposto astratta per la cabina di pilotaggio mobile."
                    ,
                        row1Title: "Modalità cockpit",
                        row1Body: "Segui gli agenti attivi da una vista mobile concentrata.",
                        row2Title: "Salta in un tocco",
                        row2Body: "Passa tra chat, file, Git, terminale e dettagli senza il layout desktop.",
                        row3Title: "Invia rapidamente",
                        row3Body: "Rispondi dal cockpit quando un agente ha bisogno di una spinta.",},
                    "existingSessions": {
                        "title": "Sessioni Claude, Codex, OpenCode? Già presenti.",
                        "body": "Sfoglia qualsiasi sessione Claude, Codex o OpenCode, in esecuzione o meno.",
                        "alt": "Immagine segnaposto astratta per le sessioni del provider esistenti."
                    },
                    "voiceAssistant": {
                        "title": "Un collega con cui parlare",
                        "wideTitle": "Assistente vocale: un collega con cui parlare",
                        "body": "L’assistente vocale monitora tutte le sessioni in esecuzione. Ragiona sui prossimi cambiamenti, approva permessi e molto altro, a mani libere.",
                        "alt": "Immagine segnaposto astratta per l'assistente vocale."
                    },
                    "reviewComments": {
                        "title": "Rivedi codice e lascia commenti",
                        "body": "Sfoglia modifiche e diff del tuo agente. Segna le righe esatte che vuoi trattare. Inviale a un agente nella sessione corrente o in una nuova.",
                        "alt": "Immagine segnaposto astratta per i commenti di revisione."
                    ,
                        row1Title: "Commenta righe precise",
                        row1Body: "Lascia feedback direttamente su righe di file e diff.",
                        row2Title: "Scegli cosa inviare",
                        row2Body: "Rivedi, modifica, rimuovi o includi commenti prima di chiedere a un agente.",
                        row3Title: "Tieni il contesto",
                        row3Body: "Invia contesto di review strutturato alla sessione corrente o a una nuova sessione.",},
                    "subagents": {
                        "title": "Una sessione, subagenti multi-provider",
                        "body": "Avvia Codex, Claude o qualsiasi altro subagente in qualunque sessione. Usa la forza di ciascuno e falli lavorare tutti insieme nella stessa sessione.",
                        "alt": "Immagine segnaposto astratta per agenti secondari tra provider."
                    },
                    "inbox": {
                        "title": "Non perdere più il filo",
                        "body": "Hai 10 sessioni aperte e perdi di vista cosa richiede attenzione? La inbox mostra tutta l’attività, da ogni sessione e macchina.",
                        "alt": "Immagine segnaposto astratta per la posta in arrivo globale."
                    },
                    "mcp": {
                        "title": "Una configurazione. Ogni provider.",
                        "wideTitle": "Una configurazione.\nOgni provider.",
                        "body": "Definisci gli MCP una sola volta in Happier e funzionano su tutti i backend, anche quelli che non supportano MCP nativamente. Gestisci skill, prompt e altro!",
                        "alt": "Immagine segnaposto astratta per la configurazione MCP condivisa."
                    },
                    "queue": {
                        "title": "Accoda, guida, biforca, ripristina",
                        "body": "Accoda messaggi mentre l’agente è occupato. Guida una sessione in corso. Biforca da qualsiasi messaggio. Ripristina se qualcosa va storto.",
                        "alt": "Immagine segnaposto astratta per gli strumenti di controllo della sessione."
                    },
                    "automations": {
                        "title": "Il tuo agente, programmato",
                        "body": "Pianifica sessioni ricorrenti per monitorare pull request, controllare issue o eseguire qualsiasi attività a intervalli regolari.",
                        "alt": "Immagine segnaposto astratta per le automazioni degli agenti pianificati."
                    },
                    "accounts": {
                        "title": "Account multipli e monitoraggio quote",
                        "body": "Collega più account OpenAI o Claude. Monitora uso e quote direttamente nell’app.",
                        "alt": "Immagine segnaposto astratta per gli account e le quote connessi."
                    },
                    "privacy": {
                        "title": "Open-source. Crittografato end-to-end.",
                        "wideTitle": "Open-source.\nCrittografato end-to-end.",
                        "body": "Codice, prompt e contenuti di sessione vengono crittografati sul dispositivo prima di raggiungere qualsiasi server. Privato per design. Aperto per default.",
                        "alt": "Immagine segnaposto astratta per privacy e self-hosting."
                    },
                    "worktrees": {
                        "title": "Un worktree per sessione. O no.",
                        "wideTitle": "Un worktree per sessione.\nO no.",
                        "body": "Avvia una sessione nel suo worktree Git così più agent lavorano sullo stesso repository senza pestarsi i piedi, oppure parti dalla cartella in cui sei già.",
                        "alt": "Immagine segnaposto astratta per i worktree Git."
                    },
                    "handoff": {
                        "title": "Sposta una sessione tra macchine.",
                        "wideTitle": "Sposta una sessione in corso\nsu un’altra macchina.",
                        "body": "Passa una sessione in corso a un altro computer e riprendi da dove si era fermata, portandoti dietro l’albero di lavoro se vuoi.",
                        "alt": "Immagine segnaposto astratta per lo spostamento di una sessione tra macchine."
                    },
                    "pets": {
                        "title": "Non sentirti mai solo. Scopri Pets.",
                        "wideTitle": "Non sentirti mai solo.\nScopri Pets.",
                        "body": "Un piccolo compagno che ti aiuta a restare sul pezzo tra le sessioni. Utile? Forse. Affascinante? Sicuro.",
                        "alt": "Immagine segnaposto astratta per Animali domestici."
                    ,
                        row1Title: "Un piccolo compagno",
                        row1Body: "Ti aiuta a restare sul pezzo tra le sessioni.",
                        row2Title: "Segue l’attività",
                        row2Body: "Mostra attività di sessione su desktop e mobile.",
                        row3Title: "Utile? Forse.",
                        row3Body: "Affascinante? Sicuro.",}
                ,
                    sourceControl: {
            title: "Costruisci e pubblica",
            body: "Crea e pubblica branch, gestisci remote, rivedi file modificati e apri pull request senza lasciare Happier.",
            alt: "Immagine astratta segnaposto per il controllo di versione.",
            row1Title: "Branch e pubblicazione",
            row1Body: "Crea branch, gestisci remote e invia modifiche senza lasciare Happier.",
            row2Title: "Apri pull request",
            row2Body: "Riusa PR esistenti o creane una nuova dalla sessione.",
            row3Title: "Rivedi file modificati",
            row3Body: "Concentrati sui file selezionati quando il changeset è grande.",
        },
                    markdown: {
            title: "Streaming più fluido, markdown più ricco",
            body: "Le risposte in streaming sono più fluide, e il Markdown più ricco rende risposte lunghe, codice, liste e diagrammi più leggibili.",
            alt: "Immagine astratta segnaposto per rendering Markdown.",
            row1Title: "Output al passo",
            row1Body: "Le risposte in streaming sono più fluide mentre gli agenti scrivono.",
            row2Title: "Markdown più solido",
            row2Body: "Code fence, liste, tabelle e risposte lunghe vengono renderizzate meglio.",
            row3Title: "Compattazione più chiara",
            row3Body: "Gli eventi del ciclo di vita sono più facili da seguire nel transcript.",
        },
                    media: {
            title: "Immagini direttamente nel transcript",
            body: "Chiedi a Codex e agli agenti supportati di generare immagini, poi visualizza i risultati direttamente in Happier.",
            alt: "Immagine astratta segnaposto per media generati.",
            row1Title: "Genera immagini",
            row1Body: "Chiedi a Codex e agli agenti supportati di creare immagini.",
            row2Title: "Anteprima inline",
            row2Body: "Le immagini generate appaiono direttamente nelle conversazioni Happier.",
            row3Title: "Salvate con la sessione",
            row3Body: "I media viaggiano nello stesso pipeline di sessione del tuo lavoro.",
        },
                    desktop: {
            title: "Un’app desktop più curata",
            body: "Una shell desktop più pulita, con chrome più curato, spaziatura più sicura e stato aggiornamenti al posto giusto.",
            alt: "Immagine astratta segnaposto per app desktop.",
            row1Title: "Chrome più pulito",
            row1Body: "Controlli della sidebar e stato aggiornamenti sembrano più naturali.",
            row2Title: "Più focus",
            row2Body: "Finestre e superfici di sessione restano fuori dai piedi.",
            row3Title: "Layout più sicuro",
            row3Body: "La spaziatura desktop gestisce meglio chrome di piattaforma e display con notch.",
        },}
            },
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
    nativeAccessibility: {
      terminalLabel: 'Terminale',
      fallbackValue: 'Il contenuto del terminale nativo non è disponibile. Usa la WebView xterm per contenuti del terminale accessibili.',
      focusAction: 'Attiva il terminale',
      copySelectionAction: 'Copia selezione',
      selectAllAction: "Seleziona tutto l'output del terminale",
      openLinkAction: 'Apri il link selezionato',
    },
    dockMenuA11y: "Aggancia terminale",
    largePasteTitle: "Incollare un input grande nel terminale?",
    largePasteDescription: "Questo testo incollato è grande e potrebbe eseguire comandi nel terminale. Controllalo prima di continuare.",
    largePasteConfirm: "Incolla nel terminale",
    settings: {
      locationTitle: "Posizione del terminale incorporato",
      rendererTitle: "Renderer del terminale",
      rendererAuto: "Automatico",
      rendererAutoDescription: "Preferisce il renderer nativo quando tutti i controlli di sicurezza nativi sono superati e nessuno screen reader è attivo; passa alla visualizzazione Web accessibile di xterm.js mentre uno screen reader è attivo.",
      rendererXtermWebView: "xterm.js Visualizzazione Web",
      rendererXtermWebViewDescription: "Renderer di compatibilità con il miglior supporto per l’accessibilità.",
      rendererNative: "Nativo",
      rendererNativeDescription: "Usa il renderer nativo anche se gli screen reader devono ancora usare la visualizzazione Web accessibile di xterm.js; tutti gli altri controlli di sicurezza nativi restano validi.",
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

    openNewTabA11y: "Apri una nuova scheda del terminale",},

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
    serverUnavailableTitle: "Impossibile raggiungere il Relay",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Non riusciamo a connetterci a ${serverUrl}. Riprova o scegli un altro Relay per continuare.`,
    serverIncompatibleTitle: "Relay non supportato",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Il Relay su ${serverUrl} ha restituito una risposta inattesa. Aggiorna quel Relay o scegli un altro Relay per continuare.`,

    // Unified onboarding redesign — BrandPanel (left pane / mobile hero)
    brandTaglineLine1: "Inizia ovunque.",
    brandTaglineLine2: "Continua dappertutto.",
    brandSubTagline: "Un centro di controllo per ogni agente di codifica — su ogni dispositivo che possiedi.",
    brandTrustStrip: "CRITTOGRAFIA END-TO-END · OPEN SOURCE · SELF-HOSTABLE",
    providerMarkRowAccessibilityLabel: "Agenti di codifica IA supportati",

    // Unified onboarding redesign — welcome decision (right pane)
    welcomeQuestionTitle: "Benvenuto.",
    welcomeQuestionSubtitle: "È la prima volta qui?",
    welcomeQuestionBody: "Happier è il centro di controllo dei tuoi agenti di codifica IA. Nessuna email richiesta. Il tuo account è una chiave privata, generata su questo dispositivo.",

    welcomePrimaryButton: "Prima volta qui — iniziamo",
    welcomePrimarySubtitle: "Un tocco. Niente moduli. La tua chiave vive qui.",

    welcomeSecondaryButton: "Accedi — uso già Happier",
    welcomeSecondarySubtitle: "Scansiona un codice QR o inserisci la tua chiave segreta",

    // Unified onboarding redesign — returning-user copy variants.
    // Shown when localSettings.hasCompletedAuthOnce === true, i.e. the
    // user has already created an account or signed in at least once on
    // this device. A returning user gets a warmer, more personal welcome
    // than "First time here?".
    //
    // useReturningGreeting() picks ONE title and ONE subtitle from these
    // pools at random — per-mount, locked via useRef so it doesn't change
    // mid-render. Titles and subtitles are picked independently, so any
    // (4 × 3) = 12 combinations are possible. The intent is to make the
    // returning experience feel alive rather than canned.
    //
    // The title pool is "welcome"-style (greeting). Aim: fits on one
    // line at 44px on a ~370px wide pane. The subtitle pool is
    // "let's go"-style (inviting question or call-to-action). Aim: fits
    // on one or two lines at 44px.
    welcomeReturningTitle1: "Bentornato.",
    welcomeReturningTitle2: "Che bello vederti.",
    welcomeReturningTitle3: "Che bello averti qui.",
    welcomeReturningTitle4: "Bentornato a casa.",
    welcomeReturningSubtitle1: "Riprendiamo da dove eravamo.",
    welcomeReturningSubtitle2: "Pronto a iniziare?",
    welcomeReturningSubtitle3: "Cosa costruiamo oggi?",

    // Returning-user buttons. For returning users we invert the visual
    // hierarchy: Login becomes the filled primary action (probability of
    // intent is high), Start fresh becomes the bordered secondary action.
    // "I already use Happier" is dropped from the login button title for
    // returning users because — they obviously do already use Happier.
    welcomeReturningLoginButton: "Accedi — riprendiamo da dove eravamo",
    welcomeReturningStartFreshButton: "Ricomincia da capo — crea un nuovo account",
    welcomeReturningStartFreshSubtitle: "Genera una nuova chiave su questo dispositivo.",

    // Welcome step footer links
    welcomeFooterRelay: "Hosting autonomo?",
    welcomeFooterRelayAction: "Usa il tuo Relay",
    // Shown in place of welcomeFooterRelay when the active server is a
    // custom (non-Happier-Cloud) relay. The action below the label is the
    // relay's host (optionally with :port) followed by a small pencil
    // icon so the user can tap to edit. Long hostnames are truncated with
    // a tail-ellipsis to avoid colliding with the right-side Docs group.
    welcomeFooterRelayActiveLabel: "Il tuo relay:",
    welcomeFooterRelayEditAccessibility: "Cambia relay",
    welcomeFooterDocs: "Hai bisogno di aiuto?",
    welcomeFooterDocsAction: "Documentazione",
    welcomeFooterGithubLabel: "Repository GitHub",
    welcomeFooterDiscordLabel: "Community Discord",

    // Mobile brand hero CTA
    brandHeroGetStarted: "Inizia",
  },

      sessionGettingStarted: {

          title: {

              connectMachine: 'Configura questo computer',

              startDaemon: 'Riconnetti questo computer',

              createSession: 'Crea una sessione',

              selectSession: 'Seleziona una sessione',

              loading: 'Caricamento…',

          },
        cliFollowUpTitle: 'Alternativa dal terminale (facoltativa)',
        manualDisclosure: {
            show: 'Mostra i passaggi manuali del terminale',
            hide: 'Nascondi i passaggi manuali del terminale',
        },

          subtitle: {

              connectMachine: ({ targetLabel }: { targetLabel: string }) =>

                  `Usa il flusso di configurazione desktop per connettere questo computer a ${targetLabel}. Apri i passaggi manuali solo se preferisci la via del terminale.`,

              startDaemon: ({ targetLabel }: { targetLabel: string }) =>

                  `Usa il flusso di configurazione desktop per riconnettere il servizio in background di ${targetLabel}. Apri i passaggi manuali solo se sei già su quel computer.`,

              createSession: 'Avvia una nuova sessione con il pulsante + o dal tuo terminale.',

              selectSession: 'Scegli una sessione dalla barra laterale per vederla qui.',

              loading: 'Recupero di macchine e sessioni in corso…',

          },

          steps: {

              openSetup: {

                  title: 'Usa il flusso di configurazione desktop',

                  description: 'È il percorso consigliato. Configura il Relay, installa il servizio in background e mantiene il resto della configurazione nell’app.',

              },

              startDaemonOpenSetup: {

                  description: 'Usa il flusso di configurazione desktop per riconnettere o riparare il servizio in background su questo computer prima di passare ai comandi del terminale.',

              },

              installCli: {

                  title: 'Installa la CLI',

                  description: 'Esegui questo una sola volta sulla macchina che vuoi connettere.',

                  copyLabel: 'Comando di installazione',

              },

              serverSetup: {

                  title: 'Imposta il Relay attivo',

                  description: 'È un’operazione una tantum, così i comandi successivi useranno il Relay corretto.',

                  copyLabel: 'Configurazione Relay',

              },

              authLogin: {

                  title: 'Accedi',

                  description: 'Mostra un QR / link per collegare il tuo terminale al tuo account.',

                  copyLabel: 'Accesso autenticazione',

              },

              daemonInstall: {

                  title: 'Installa il servizio in background (consigliato)',

                  description: 'Mantiene Happier pronto in background per avvii remoti.',

                  copyLabel: 'Installazione daemon',

              },

              startDaemonInstall: {

                  description: 'Installa un servizio utente sempre attivo e lo avvia.',

              },

              daemonStart: {

                  title: 'Avvia il servizio in background una volta',

                  description: 'Usalo se ti serve solo in esecuzione adesso.',

                  copyLabel: 'Avvio daemon',

              },

              createSession: {

                  title: 'Crea una sessione',

                  description: 'Usa il pulsante + nell’app oppure esegui una di queste opzioni dal terminale.',

                  copyLabel: 'Crea sessione',

              },

              startSession: {

                  title: 'Avvia una sessione dal tuo computer',

                  description: 'Oppure usa il pulsante + nell’app.',

                  copyLabel: 'Avvia sessione',

              },

          },

      },


  setupOnboarding: {
	          screenTitle: 'Configura questo computer',
	          welcomeTitle: 'Benvenuto in Happier',
			          welcomeBody: 'Happier collega il tuo telefono e i tuoi computer tramite un Relay, così le tue sessioni ti seguono ovunque.',
			          welcomeBody2: 'Open source. Crittografia end‑to‑end. Zero‑knowledge.',
			          welcomeBody3: 'Creato dagli sviluppatori, per gli sviluppatori.',
			          providersShowcaseLabel: 'Funziona con:',
          letsStart: 'Iniziamo',
          scanQrCode: 'Scansiona codice QR',
          recommendedBadge: 'Consigliato',
	          relayCloudTitle: 'Happier Cloud',
	          relayCloudSubtitle: 'Relay ospitato — il modo più semplice per iniziare',
	          relayOnThisComputerTitle: 'Su questo computer',
	          relayOnThisComputerSubtitle: 'Esegui il relay in locale su questo computer e aggiungi Tailscale per l’accesso dal telefono',
	          relayOnYourComputerTitle: 'Sul tuo computer',
	          relayOnYourComputerSubtitle: 'Esegui il relay in locale sul tuo computer e aggiungi Tailscale per l’accesso dal telefono',
	          relayOnRemoteComputerTitle: 'Configura un relay su un computer remoto',
          relayOnRemoteComputerSubtitle: 'Ospita il relay su un computer remoto tramite SSH',
	          remoteRelayHostInstallTitle: 'Ospita un Relay sul computer remoto',
	          relayAccessWizardTitle: 'Come dovrebbe il tuo telefono raggiungere questo relay?',
	          relayAccessUrlTitle: 'URL del relay',
	          relayAccessUrlSubtitle: 'Inserisci un URL raggiungibile dal tuo telefono.',
	          relayAccessUrlBody: 'Può essere un indirizzo LAN, un dominio personalizzato o un URL di tunnel, purché il telefono possa aprirlo.',
	          relayAccessCloudflareTitle: 'Tunnel Cloudflare',
	          relayAccessCloudflareSubtitle: 'Espone il relay tramite un Named Tunnel di Cloudflare.',
	          relayAccessCloudflareBody: 'Crea o seleziona un Named Tunnel e lo configureremo per inoltrare al relay locale.',
          changeRelay: 'Cambia relay',
          relayCustomUrlTitle: 'Relay esistente',
          relayCustomUrlSubtitle: 'Usa un URL relay che hai già attivo',
          authRestoreTitle: 'Ripristina o aggiungi questo dispositivo',
          authRestoreSubtitle: 'Usa un codice QR o un link per collegare questo dispositivo',
          authSecretKeyTitle: 'Accedi con chiave segreta',
          authSecretKeySubtitle: 'Inserisci la tua chiave segreta per accedere a Happier',
          authLostAccessTitle: 'Hai perso l’accesso?',
          authLostAccessSubtitle: 'Reimposta l’account con il tuo provider di identità',
          webRelayHostHandoffTitle: 'Configura un Relay sul tuo computer',
          webRelayHostHandoffBody: 'Per ospitare un Relay su questo computer, usa l’app desktop o la CLI. Ti guideremo, poi potrai incollare qui l’URL del Relay per continuare.',
          webDesktopOnlyTitle: 'È richiesta l’app desktop',
          webDesktopOnlyBody: 'Apri l’app desktop per configurare questo computer. L’app web può mostrare lo stato, ma non può installare o configurare il servizio in background.',
          webDesktopOnlyPrimary: 'Ho un URL del Relay',
          webDesktopOnlyDesktopAppTitle: 'Continua questa configurazione nell’app desktop',
          webDesktopOnlyDesktopAppSubtitle: 'Scarica e apri Happier per configurare questo computer con una procedura guidata.',
          webDesktopOnlyDesktopAppButton: 'Scarica app desktop',
          webDesktopOnlyCliTitle: 'Installa la CLI su questo computer',
          webDesktopOnlyCliSubtitle: 'Esegui questo una volta in un terminale (Node non è richiesto).',
          handoffPlatformPosixLabel: 'macOS/Linux',
          handoffPlatformMacosLabel: 'macOS',
          handoffPlatformLinuxLabel: 'Linux',
          handoffPlatformWindowsLabel: 'Windows',
          orDividerLabel: 'o',
          webDesktopOnlySetupCommandTitle: 'Configura questo computer usando la CLI',
          webDesktopOnlySetupCommandSubtitle: 'Esegui un solo comando per configurare il relay, accedere se necessario e installare il servizio in background.',
          webDesktopOnlySetupRemotePrereqsSubtitle: 'Esegui un solo comando per configurare il relay e accedere prima di configurare un computer remoto via SSH.',
          webDesktopHandoffDesktopAppOption: 'Usa l’app desktop (consigliato)',
          webDesktopHandoffDesktopAppSubtitle: 'Scarica e apri Happier per ospitare un Relay con una configurazione guidata.',
          webDesktopHandoffCliOption: 'Usa il terminale (CLI)',
          webDesktopHandoffCliSubtitle: 'Esegui alcuni comandi per ospitare un Relay e poi incolla qui l’URL mostrato.',
          webDesktopOnlyRelayInstallTitle: 'Ospita un Relay su questo computer',
	          webDesktopOnlyRelayInstallSubtitle: 'Questo installa e avvia l’host del Relay.',
	          webDesktopOnlyRelayStatusTitle: 'Ottieni l’URL del Relay',
	          webDesktopOnlyRelayStatusSubtitle: 'Esegui questo comando per vedere l’URL del Relay e poi incollarlo qui.',
	          webDesktopOnlyOptionalNextTitle: 'Opzionale: accesso sicuro e provider',
	          webDesktopOnlyOptionalNextBody: 'Dopo aver installato Happier, apri Impostazioni → Accesso sicuro (Tailscale) per collegare il telefono e Impostazioni → Provider per installare gli strumenti che preferisci.',
			          preAuthTitle: 'Dove si trova il tuo relay?',
	          preAuthBody: 'Il tuo relay instrada i messaggi tra il tuo telefono e i tuoi computer. Scegli dove si trova: puoi cambiarlo più tardi.',
          preAuthContinueHint: 'Quando continui, Happier ti riporterà all’accesso sul Relay selezionato e poi tornerà qui per completare la configurazione.',
	    currentRelayTitle: 'Server attuale',
	    selectedRelayFooterLabel: 'Server attuale',
	    selectedRelayFooterLine: ({ relay }: { relay: string }) => `Server attivo: ${relay}`,
	    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Relay attivo: ${relayUrl}`,
	    accountWillLiveOnRelay: ({ relayUrl }: { relayUrl: string }) => `Il tuo account sarà su ${relayUrl}.`,
	    savedRelaysTitle: 'Relay salvati',
        removeRelayConfirmTitle: 'Rimuovere il relay?',
        removeRelayConfirmBody: 'Questo lo rimuove dai relay salvati su questo dispositivo.',
	    customRelayUrlLabel: 'URL del Relay',
    relayNameLabel: 'Nome del Relay',
    addAndUseRelay: 'Aggiungi Relay',
    changeRelayAction: 'Usa un URL Relay diverso',
	          continueToAuth: 'Continua con il Relay selezionato',
	          continueWithLocalRelayAction: 'Usa questo Relay locale e continua',
	          confirmSwitchRelayTitle: 'Passare a questo Relay?',
	          confirmSwitchRelaySubtitle: 'Questo renderà il Relay selezionato attivo su questo dispositivo.',
	          confirmSwitchRelayKeepTitle: 'Mantieni il Relay attuale',
	          confirmSwitchRelayKeepSubtitle: 'Continua senza cambiare Relay per ora',
	          confirmSwitchRelaySwitchTitle: 'Passa a questo Relay',
	          confirmSwitchRelaySwitchSubtitle: 'Potrebbe essere necessario accedere di nuovo sul nuovo Relay',
	          confirmSwitchRelayWarning: 'Puoi cambiare il relay più tardi in Impostazioni → Relay.',
	    postAuthTitle: 'Termina la configurazione di questo computer',
	    postAuthBody: 'Hai effettuato l’accesso. Continua con il flusso di configurazione locale per rendere questo computer pronto per il Relay selezionato.',
        setupThisComputerTitle: 'Configura questo computer',
	    controlPanelTitle: 'Riepilogo della prontezza',
    activeRelaySummaryTitle: 'Relay attivo',
    selectedRelaySummaryTitle: 'Relay selezionato',
    thisComputerSummaryTitle: 'Questo computer',
    nextActionSummaryTitle: 'Prossima azione',
    thisComputerReady: 'Pronto per questo Relay',
    nextActionReady: 'Crea la tua prima sessione o aggiungi un altro computer qui sotto.',
    thisComputerStages: {
        installToolsTitle: 'Installa gli strumenti di Happier',
        installToolsSubtitle: 'Installa gli strumenti locali da riga di comando di Happier necessari per configurare questo computer.',
        installToolsReadySubtitle: 'Gli strumenti locali di Happier sono già disponibili su questo computer.',
        installToolsDetails: 'Ci assicuriamo che il runtime gestito di Happier usato dalla configurazione locale sia disponibile e sincronizziamo il comando del terminale corrispondente per questo canale di rilascio.',
        installToolsChildTitle: 'Installa gli strumenti locali da riga di comando di Happier',
        useRelayTitle: 'Usa questo Relay',
        useRelayAccountMismatchSubtitle: 'Passa all’account associato a questo server prima di continuare.',
        useRelayNeedsAuthSubtitle: 'Accedi o crea un account per continuare la configurazione di questo server.',
        useRelaySignedInSubtitle: 'L’account attuale ha già eseguito l’accesso ed è pronto a usare questo server.',
        useRelayServerMismatchSubtitle: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `Server dell’app: ${activeRelayUrl}. Servizio in background: ${daemonRelayUrl}.`,
        useRelayConnectedSubtitle: ({ relayUrl }: { relayUrl: string }) => `Connesso a ${relayUrl}.`,
        useRelayMissingSubtitle: 'Scegli o aggiungi un server per continuare.',
        useRelayDetails: 'Confermiamo quale Relay e quale account deve usare questo computer prima che inizi la registrazione locale.',
        backgroundServiceTitle: 'Servizio in background',
        backgroundServiceDecisionSubtitle: 'Scegli come questo computer deve gestire il servizio in background predefinito.',
        backgroundServiceRunningSubtitle: 'Il servizio in background è installato ed è in esecuzione.',
        backgroundServiceInstalledSubtitle: 'Il servizio in background è installato e deve essere avviato.',
        backgroundServiceSubtitle: 'Installa e avvia il servizio in background per questo computer.',
        backgroundServiceDetails: 'Il servizio in background mantiene questo computer pronto per i prossimi avvii e lo ricollega automaticamente al Relay selezionato.',
        backgroundServiceReleaseChannelChildTitle: 'Risolvi la proprietà del canale di rilascio',
        backgroundServiceConflictChildTitle: 'Risolvi i conflitti esistenti del servizio in background',
        registerComputerTitle: 'Registra questo computer',
        registerComputerDoneSubtitle: 'Questo computer è già registrato al tuo account.',
        registerComputerNeedsAuthSubtitle: 'Accedi prima di registrare questo computer.',
        registerComputerReconnectSubtitle: 'Ricollega questo computer dopo aver aggiornato le impostazioni del server.',
        registerComputerSubtitle: 'Collega questo computer al tuo account sul server selezionato.',
        registerComputerDetails: 'Registriamo questo computer sul tuo account nel Relay selezionato così che le sessioni locali e le funzioni in background possano identificare correttamente questa macchina.',
        footerHint: 'Gestiamo noi i passaggi di configurazione di basso livello e mostriamo solo le decisioni che richiedono il tuo intervento.',
    },
    resumeIntentTitle: 'Continua la configurazione su questo computer',
          resumeIntentBody: 'Accedi o crea un account per continuare a configurare questo computer per il Relay selezionato.',
    openSetupAction: 'Configura questo computer',
    openSetupWizardAction: 'Apri la procedura guidata di configurazione',
    openSetupWizardSubtitle: 'Usa il flusso guidato per configurare Happier sul tuo computer.',
    setupNewMachineAction: 'Configura una nuova macchina',
    setupNewRelayAction: 'Configura un nuovo relay',
    remoteHosts: {
        hostPickerTitle: 'Host remoto',
        hostPickerSubtitle: 'Riusa un profilo SSH salvato o aggiungine uno nuovo.',
        newHostOption: 'Nuovo host…',
        saveHostTitle: 'Salva questo host',
        saveHostSubtitle: 'Salva questo profilo SSH nel tuo account.',
        savePasswordTitle: 'Salva password',
        savePasswordSubtitle: 'Memorizza la password SSH cifrata a riposo.',
        savePrivateKeyTitle: 'Salva chiave privata',
        savePrivateKeySubtitle: 'Memorizza la chiave privata SSH cifrata a riposo.',
        privateKeyLabel: 'Chiave privata',
    },
    remoteSshChecklist: {
        planTitle: 'Rivedi il piano di configurazione',
        planSubtitleMachine: 'Questo piano installa la CLI remota, configura il Relay e installa il servizio in background.',
        planSubtitleRelayHost: 'Questo piano installa la CLI remota, configura il Relay e installa il runtime del Relay.',
        executionTitle: 'Configurazione della macchina remota',
        executionSubtitle: "La checklist si aggiorna mentre l'avvio remoto è in esecuzione.",
        completeTitle: 'Macchina remota pronta',
        completeSubtitleMachine: 'La configurazione della macchina remota è terminata correttamente.',
        trustHostTitle: "Fidati dell'host SSH",
        trustHostSubtitle: "Verifica l'impronta della macchina remota prima di connetterti.",
        trustHostDetails: 'Verifichiamo la chiave host SSH e rifiutiamo impronte inattese a meno che tu non le consideri affidabili esplicitamente.',
        installCliTitle: 'Installa la CLI di Happier',
        installCliSubtitle: 'Copia la CLI di Happier sulla macchina remota.',
        installCliDetails: 'La macchina remota ha bisogno della CLI di Happier per eseguire il resto del bootstrap.',
        configureRelayTitle: 'Configura il Relay',
        configureRelaySubtitle: 'Punta la macchina remota al Relay attivo e alla web app.',
        configureRelayDetails: "La CLI remota viene configurata per comunicare con il Relay attivo e autenticare questa macchina al tuo account.",
        installDaemonTitle: 'Installa il servizio in background',
        installDaemonSubtitle: 'Mantieni Happier in esecuzione in background sulla macchina remota.',
        installDaemonDetails: 'Il servizio in background mantiene la macchina remota connessa e pronta per sessioni future.',
        startFailed: 'Impossibile avviare la configurazione SSH remota.',
        continueFailed: 'Impossibile continuare la configurazione SSH remota.',
    },
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
      "• Assicurati che il tuo computer sia online\n• Esegui happier daemon status per diagnosticare\n• Stai usando l'ultima versione della CLI? Esegui happier self update",
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
      replacementRepair: {
        replaceWithMachine: "Segna come sostituita",
        replaceWithMachineSubtitle: ({ machine }: { machine: string }) =>
          `Usa ${machine} come sostituzione per questa macchina.`,
        chooseReplacementSubtitle: "Scegli quale macchina sostituisce questa.",
        pickerTitle: "Scegli macchina sostitutiva",
        pickerCandidatesTitle: "Macchine idonee",
        confirmTitle: "Segnare la macchina come sostituita?",
        confirmBody: ({ machine }: { machine: string }) =>
          `I lanci futuri e le vecchie sessioni di questa macchina useranno ${machine}.`,
        confirmAction: "Sostituisci",
        undo: "Annulla sostituzione",
        undoSubtitle: ({ machine }: { machine: string }) =>
          `Questa macchina è attualmente sostituita da ${machine}.`,
        undoConfirmTitle: "Annullare la sostituzione della macchina?",
        undoConfirmBody:
          "Questa macchina riapparirà come destinazione di lancio se è disponibile.",
        undoAction: "Annulla",
        error: "Impossibile aggiornare la sostituzione della macchina.",
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

    backgroundServiceModes: {
      generic: "servizio in background",
      defaultFollowing: "servizio in background predefinito",
      legacyPinned: "servizio in background legacy fissato",
    },
    backgroundServicePrompt: {
        targetServer: 'Server di destinazione',
        targetReleaseChannel: 'Canale di rilascio di destinazione',
        existingServices: 'Servizi esistenti:',
        running: 'in esecuzione',
    },
    repairBackgroundServiceAction: "Ripara il servizio in background",
    repairBackgroundServiceProgressTitle: "Riparazione del servizio in background",
    runtimeInventory: 'Inventario del runtime di Happier',
    runtimeInventoryOverview: 'Panoramica',
    runtimeInventoryInstallations: 'Installazioni',
    runtimeInventoryServices: 'Servizi',
    runtimeInventoryWarnings: 'Avvisi',
    doctorRepairSummary: 'Riepilogo riparazione',
    doctorRepairFindingsSummary: ({ total, warning, error, actionable }: {
        total: number;
        warning: number;
        error: number;
        actionable: number;
    }) => `${total} risultati • ${warning} avvisi • ${error} errori • ${actionable} azionabili`,
    localRelays: 'Relay locali',
    runtimeSummary: ({ cliVersion, daemonVersion, daemonRing, installationCount, serviceCount, warningCount }: {
        cliVersion: string;
        daemonVersion: string;
        daemonRing: string;
        installationCount: number;
        serviceCount: number;
        warningCount: number;
    }) => `CLI ${cliVersion} • daemon ${daemonVersion} (${daemonRing}) • ${installationCount} installations • ${serviceCount} services • ${warningCount} warnings`,
    transferExposure: {
      title: "Esposizione trasferimento",
      status: "Esposizione trasferimento",
      loopbackHttp: "Loopback (locale)",
      tailscaleServeHttps: "Tailscale Serve (HTTPS)",
      stateUnknown: "Sconosciuto",
      stateDisabled: "Disattivato",
      stateUnconfigured: "Non configurato",
      stateApprovalNeeded: "Approvazione necessaria",
      stateInactive: "Configurato (inattivo)",
      stateStale: "Configurato (obsoleto)",
      stateActive: "Attivo",
      stateUnavailable: "Non disponibile",
    },},

  message: {
      sessionReferenceUnavailable: "Sessione non disponibile",
      sessionReferenceOpen: ({ name }: { name: string }) => `Apri la sessione ${name}`,
    switchedToMode: ({ mode }: { mode: string }) =>
      `Passato alla modalità ${mode}`,
    discarded: "Scartato",
    recoveredHistory: "Cronologia recuperata",
    pluginAttribution: ({ pluginId }: { pluginId: string }) => `Dal plugin ${pluginId}`,
    pluginAttributionExternal: ({ sender, pluginId }: { sender: string; pluginId: string }) => `Da ${sender} tramite il plugin ${pluginId}`,
    pluginAttributionExternalForwarded: ({ sender, pluginId }: { sender: string; pluginId: string }) => `Inoltrato da ${sender} tramite il plugin ${pluginId}`,
    pluginAttributionExternalSender: 'un mittente esterno',
    pluginAttributionExternalBot: 'un bot esterno',
    unknownEvent: "Evento sconosciuto",
    runtimeConfigOutcomeAppliesBeforeNextMessage: 'Si applicherà prima del tuo prossimo messaggio',
    runtimeConfigOutcomeQueuedUntilReady: 'In coda finché non è pronto',
    runtimeConfigOutcomeAlreadySet: 'Già impostato',
    runtimeConfigOutcomeSessionMode: 'Modalità sessione',
    runtimeConfigOutcomeKeyModel: 'Modello',
    runtimeConfigOutcomeKeyFallbackModel: 'Modello di riserva',
    runtimeConfigOutcomeKeyPermissionMode: 'Modalità permessi',
    runtimeConfigOutcomeKeyReasoningEffort: 'Sforzo di ragionamento',
    runtimeConfigOutcomeKeyMaxThinkingTokens: 'Budget di ragionamento',
    runtimeConfigOutcomeKeyLaunchOption: 'Opzione di avvio',
    runtimeConfigOutcomeRequiresRestart: 'Riavvio necessario',
    runtimeConfigOutcomeRequiresInteractiveControl: 'Richiede interazione nel terminale',
    runtimeConfigOutcomeUnsupported: 'Non supportato',
    runtimeConfigOutcomeFailed: 'Impossibile applicare',
    contextCompactionStarted: "Compattazione del contesto...",
    contextCompactionCompleted: "Contesto compattato",
    contextCompactionFailed: "Compattazione del contesto non riuscita",
    contextCompactionCancelled: "Compattazione del contesto annullata",
    contextCompactionPaused: "Contesto compattato; invia un messaggio per continuare",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Limite di utilizzo raggiunto fino a ${time}`,
    connectedServiceAccountSwitch: ({ provider, from, to }: { provider: string; from: string; to: string }) =>
      `Account ${provider} cambiato da ${from} a ${to}`,
    connectedServiceGroupAccountSwitch: ({ provider, group, from, to }: { provider: string; group: string; from: string; to: string }) =>
      `Gruppo ${group} di ${provider} cambiato da ${from} a ${to}`,
    connectedServiceSwitchGroupSelection: ({ group, profile }: { group: string; profile: string }) =>
      `gruppo ${group} · ${profile}`,
    connectedServiceSwitchProfileSelection: ({ profile }: { profile: string }) => `profilo ${profile}`,
    connectedServiceSwitchDeferred: 'Cambio account rinviato fino al limite del turno',
    connectedServiceSwitchDeferredIdle: 'Cambio account rinviato fino a quando la sessione è inattiva',
    connectedServiceSwitchDeferralCompleted: 'Cambio account pronto',
    connectedServiceSwitchDeferralCancelled: 'Cambio account annullato',
    connectedServiceSwitchDeferralSuperseded: 'Cambio account sostituito da uno più recente',
    agentStateSharingDegraded: 'Condivisione stato provider applicata parzialmente',
    agentQuotaWait: ({ time }: { time: string }) =>
      `In attesa del ripristino quota provider alle ${time}`,
    agentQuotaRecovered: "Quota provider recuperata",
    connectedServiceRuntimeAuthRecoveryRecovered: "Autenticazione provider recuperata",
    connectedServiceRuntimeAuthRecoveryCancelled: "Recupero autenticazione provider annullato",
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
    switchToRemote: "Passa a remoto",
    detachLocalTerminal: "Scollega terminale",
    directSessionTakeoverAvailable:
      "Questa sessione diretta è disponibile sulla tua macchina. Prendila in carico in Happier per controllarla qui.",
    directSessionMachineOffline:
      "Questa sessione diretta non è attualmente disponibile perché la macchina è offline.",
    switchingToDirectTakeover: "Presa in carico di questa sessione diretta…",
    switchingToPersistedTakeover: "Presa in carico e importazione di questa sessione…",
    takeOverDirect: "Prendi in carico",
    takeOverPersist: "Prendi in carico + importa",
    directTakeoverDialogTitle: "Continuare questa sessione diretta in Happier?",
    directTakeoverDialogBody: "Scegli come vuoi che Happier prenda il controllo. Diretto continua a usare la trascrizione del provider. Importa porta la trascrizione in Happier.",
    directTakeoverDialogDirectTitle: "Prendi in carico",
    directTakeoverDialogDirectBody: "Controlla questa sessione in Happier senza importare la trascrizione in Happier.",
    directTakeoverDialogPersistTitle: "Prendi in carico + importa",
    directTakeoverDialogPersistBody: "Importa la trascrizione in Happier e continua con tutte le funzioni di una sessione Happier.",

    externalSessionTakeoverAvailable:
      "Questa sessione esterna è pronta per essere presa in carico in Happier.",
    externalSessionMachineOffline:
      "Questa sessione esterna non è attualmente disponibile perché il computer è offline.",
    checkingExternalSessionTakeover: "Verifica delle opzioni di controllo…",
    externalSessionStatusUnavailable: "Happier non ha potuto verificare questa sessione esterna. Controlla la connessione della macchina e riprova.",
    externalSessionProcessRunning: "L'Agent di questa sessione esterna sembra essere ancora in esecuzione.",
    externalSessionRecheck: "Ricontrolla",
    externalSessionTakeoverBlocked: "Happier non ha potuto verificare che l'Agent esterno sia stato arrestato. Arrestalo nel terminale e riprova.",},

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
        yesForCommandName: "Sì, consenti qualsiasi comando corrispondente in questa sessione",
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

      // Slash menu commands (Lane G)
      slash: {
          heading1: { label: 'Intestazione 1', description: 'Intestazione grande' },
          heading2: { label: 'Intestazione 2', description: 'Intestazione media' },
          heading3: { label: 'Intestazione 3', description: 'Intestazione piccola' },
          bulletList: { label: 'Elenco puntato', description: 'Elenco non ordinato' },
          orderedList: { label: 'Elenco numerato', description: 'Elenco ordinato' },
          taskList: { label: 'Elenco attività', description: 'Elenco con caselle' },
          blockquote: { label: 'Citazione', description: 'Blocco citazione' },
          codeBlock: { label: 'Blocco codice', description: 'Blocco codice delimitato' },
          horizontalRule: { label: 'Divisore', description: 'Linea orizzontale' },
          groups: { headings: 'Intestazioni', lists: 'Elenchi', blocks: 'Blocchi' },
      },

      // Link bubble (Lane H)
      linkBubble: {
          open: 'Apri',
          edit: 'Modifica',
          unlink: 'Rimuovi link',
          cancel: 'Annulla',
          save: 'Salva',
          inputPlaceholder: 'Incolla o digita un link…',
      },
    },

    // Accessibility labels for the rich markdown editor formatting toolbar.
    markdownEditorToolbar: {
      bold: "Grassetto",
      italic: "Corsivo",
      strikethrough: "Barrato",
      code: "Codice in linea",
      heading1: "Titolo 1",
      heading2: "Titolo 2",
      heading3: "Titolo 3",
      bulletList: "Elenco puntato",
      orderedList: "Elenco numerato",
      taskList: "Elenco attivita",
      blockquote: "Citazione",
      codeBlock: "Blocco di codice",
      horizontalRule: "Separatore",
      openLink: "Apri link",
      unlink: "Rimuovi link",
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
    noData: {
      title: "Nessun dato di utilizzo disponibile",
      subtitle: "I dati di utilizzo appariranno qui dopo la prima sessione.",
    },
    errors: {
      notAuthenticated: "Accedi per visualizzare l'utilizzo.",
      failedToLoad: "Impossibile caricare l'utilizzo.",
    },

    lastYear: "Ultimo anno",
    costMode: "Modalità costo",
    auto: "Automatico",
    reported: "Segnalato",
    estimated: "Stimato",
    insights: "Approfondimenti",
    activity: "Attività",
    timeline: "Cronologia",
    leaders: "Classifica",
    activeDays: "Giorni attivi",
    modelsTried: "Modelli provati",
    favoriteModelChanges: "Cambi del modello preferito",
    busiestWindow: "Fascia più intensa",
    activityCalendarSubtitle: "Mappa di calore del calendario",
    mostActiveMonths: "Mesi più attivi del periodo selezionato",
    dailyActivity: "Attività giornaliera del periodo selezionato",
    mostActiveWeekdays: "Giorni della settimana più attivi",
    mostActiveHours: "Ore del giorno più attive",
    events: "eventi",
    source: "Origine",
    sessionUsage: "Utilizzo della sessione",
    longestStreak: 'Serie più lunga',
    dailyRhythm: 'Ritmo giornaliero',
    eventsLabel: 'Eventi',
    daysShort: ({ count }: { count: number }) => `${count}d`,
    updatedCaption: 'Aggiornato ora',
    whenYouWork: 'Quando lavori',
    periodTodayShort: 'Oggi',
    period7dShort: '7G',
    period30dShort: '30G',
    periodYearShort: '1A',
    busiestTag: 'il più attivo',
    vsPreviousPeriod: 'rispetto al periodo precedente',
    workRhythm: 'Ritmo di lavoro',
    weeks: "Settimane",
    messagesCaption: ({ count }: { count: number }) => `${count.toLocaleString()} messaggi`,
    modelMix: {
        title: "Mix di modelli nel tempo",
        other: "Altri",
    },
    showAll: 'Mostra tutto',
    showLess: 'Mostra meno',
    exportCsv: 'Scarica CSV',
    efficiency: {
        cacheHitRate: 'Tasso di hit della cache',
        cacheHitCaption: 'Quota di token di input serviti dalla cache',
        costPerMtok: 'Costo per Mtok',
        costPerMtokCaption: 'Tariffa media effettiva per milione di token',
    },

    cacheSavings: 'Risparmio cache',
    banner: {
        lifetimeTokens: 'Token complessivi',
        peakTokens: 'Token di picco',
        tokenActivity: 'Attività dei token',
        daily: 'Giornaliero',
        weekly: 'Settimanale',
        cumulative: 'Cumulativo',
        activityInsights: 'Approfondimenti attività',
        mostUsed: 'Più usati',
        days: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'}`,
    },
    tokenMix: {
        input: 'Ingresso',
        output: 'Uscita',
        reasoning: 'Ragionamento',
        cacheRead: 'Lettura cache',
        cacheWrite: 'Scrittura cache',
    },
    recap: {
        play: 'Riproduci riepilogo',
        shareImage: 'Condividi come immagine',
    },
    context: {
        title: 'Contesto ed efficienza',
        utilization: 'Contesto usato',
        window: 'Finestra',
        tokenMixTitle: 'Composizione token',
    },
    summary: {
      title: "Riepilogo utilizzo",
      currentStreak: "Serie attuale",
      currentStreakSubtitle: ({ count }: { count: number }) => `${count} active days in the last 30`,
      currentStreakSubtitleForPeriod: ({ count, period }: { count: number; period: string }) => `${count} active days · ${period}`,
      thisWeek: "Questa settimana",
      thisWeekSubtitle: "Slancio recente",
      topModel: "Modello di riferimento",
      engine: "Motore",
      export: {
        session: "Sessione",
        period: "Periodo",
        metric: "Metrica",
        costMode: "Modalità costo",
        totalTokens: "Token totali",
        totalCost: "Costo totale",
        activeDays: "Giorni attivi",
        topModel: "Modello principale",
        topEngine: "Motore principale",
        modelTimeline: "Cronologia dei modelli",
        engineTimeline: "Cronologia dei motori",
      },
    },},

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

    projects: {
    emptyTitle: "Ancora nessun progetto",
    emptyDescription: "I progetti ti permettono di esplorare e modificare file, e usare Git sulle tue macchine al di fuori delle sessioni.",
    groups: {
      pinned: "In evidenza",
      addFirst: "Aggiungi un progetto",
    },
    actions: {
      addProjectToMachine: "Aggiungi progetto a questa macchina",
      addProject: "Aggiungi progetto",
      addProjectOnMachine: ({ machine }: { machine: string }) => `Aggiungi un progetto su ${machine}`,
      chooseProjectFolderOnMachine: ({ machine }: { machine: string }) => `Scegli una cartella su ${machine}`,
      chooseProjectFolderSubtitle: "Aggiungila come progetto per sfogliare e modificare file, e usare Git.",
      pin: "Fissa",
      unpin: "Rimuovi fissaggio",
      remove: "Rimuovi",
    },
    sourceControl: {
      noSessionAvailableDetails: "Avvia una sessione in questa cartella per abilitare il Controllo versione nei Progetti.",
    },
    details: {
      emptyBody: "Apri File o Controllo versione per visualizzare qui anteprime di file e diff.",
      placeholderFileBody: "L'anteprima del file “{title}” apparirà qui.",
      placeholderScmReviewBody: "Le anteprime delle diff appariranno qui.",
      placeholderCommitBody: "I dettagli del commit appariranno qui.",
      placeholderUnsupportedBody: "Questa scheda dettagli non è ancora supportata in Progetti.",
    },
    detail: {
      notFoundTitle: "Progetto non trovato",
      notFoundDescription: "Questo progetto potrebbe essere stato rimosso o appartiene a un altro server.",
      missingWorktreeRecovered: "Il worktree selezionato non esiste più. Ripristinata la radice del progetto.",
      groupTitle: "Progetto",
      fields: {
        name: "Nome",
        machine: "Macchina",
        path: "Percorso",
      },
      comingSoonGroupTitle: "Prossimamente",
      comingSoonFooter:
        "File, controllo versione, diff e terminale appariranno qui nella prossima fase del refactor.",
      comingSoon: {
        filesAndScmTitle: "File e controllo versione",
        filesAndScmSubtitle:
          "Questa schermata riutilizzerà la barra laterale e i pannelli dei dettagli esistenti, ma con ambito di workspace invece che di sessione.",
      },
    },
  },
   ...apiTokenSettingsTranslations.it,
   settingsPlugins: {
      ...pluginWebhookAdministrationTranslations['it'],
      ...pluginAccountDataEraseTranslations.it,
      ...pluginAccountReleaseSelectionTranslations.it,
      ...pluginMachineMatrixTranslations.it,
      ...pluginInvocationLogTranslations.it,
      ...eventAutomationComposerTranslations.it,
    title: "Catalogo dei plugin",
    subtitle: "Sfoglia i descrittori dei plugin curati e gestisci i plugin installati su questo dispositivo.",
    appPanelsTitle: "Pannelli dei plugin",
    appPanelsSubtitle: "Apri i pannelli dell'app forniti dai plugin installati.",
    executionOriginReleaseContentConflict: "Il contenuto della versione non corrisponde. Pubblica una nuova versione.",
    readOnlyProjectionUnavailable: "I dettagli dei plugin nella cache sono di sola lettura: questo dispositivo è raggiungibile, ma non è stato possibile caricare il suo registro dei plugin. Riprova per gestire i plugin.",
    readOnlyAccountRecovery: "I dettagli dell'account del plugin sono disponibili, ma i dettagli specifici della macchina non saranno disponibili finché non sarà disponibile un'installazione del plugin compatibile.",
    readOnlySnapshot: "I dettagli dei plugin nella cache sono di sola lettura mentre questo dispositivo è disconnesso. Riconnettilo per gestire i plugin.",
    viewSelectorLabel: "Viste di gestione dei plugin",
    views: { installed: "Installati", discover: "Scopri", development: "Sviluppo", diagnostics: "Diagnostica" },
    developmentTitle: "Sviluppo",
    developmentFooter: "Sorgenti locali approvate e diagnostica di sviluppo segnalate da questo dispositivo.",
    developmentEmpty: "Nessuna sorgente di sviluppo segnalata",
    developmentEmptySubtitle: "Questo dispositivo non ha segnalato sorgenti locali approvate né diagnostica di osservazione e ricaricamento.",
    developmentCreate: "Crea plugin",
    developmentCreateSubtitle: "Crea un modello locale di plugin su questo computer.",
    developmentCreateSucceeded: "Modello del plugin creato.",
    developmentSourceInstall: "Sviluppa una cartella plugin locale",
    developmentSourceInstallSubtitle: "Consenti al daemon di questo computer di compilare ed eseguire un plugin da una cartella tua. Prima approvi la cartella esatta.",
    developmentSourceInstallTitle: "Cartella del plugin",
    developmentSourceInstallBody: "Inserisci il percorso completo della cartella del progetto del plugin su questo computer.",
    developmentSourceInstallSucceeded: "Sorgente di sviluppo approvata e proiettata.",
    developmentSourceInstallFailed: ({ outcome }: { outcome: string }) => `La sorgente di sviluppo non è stata installata (${outcome}).`,
    developmentTrustSourceRootTitle: "Vuoi fidarti di questa cartella plugin?",
    developmentTrustSourceRootBody: ({ path, machine, server }: { path: string; machine: string; server: string }) => `Happier installerà dipendenze, compilerà ed eseguirà codice da:\n\n${path} su ${machine} (${server})\n\nContinua solo se ti fidi di tutto ciò che si trova in quella cartella e di tutto ciò che può scaricare. Esaminerai il plugin nel passaggio successivo.`,
    developmentTrustSourceRootConfirm: "Fidati della cartella",
    pendingChangesTitle: "In attesa della tua decisione",
    pendingChangesFooter: "Modifiche ai plugin preparate su questa macchina. Un agente può prepararle, ma solo tu puoi approvarle.",
    pendingChangesReviewHint: "Mostra la revisione completa prima di concedere fiducia.",
    pendingChangeSourceRootSubtitle: ({ path }: { path: string }) => `Cartella del plugin: ${path}`,
    pendingChangeInstallSubtitle: ({ pluginId, source }: { pluginId: string; source: string }) => `${pluginId} da ${source}`,
    pendingChangeApplying: "Questa modifica è già stata decisa ed è in corso di applicazione.",
    pendingChangeExpired: "Questa modifica è scaduta prima di essere decisa. Richiedila di nuovo.",
    pendingChangeRejected: "La modifica del plugin è stata rifiutata.",
    pendingChangeConfirmRejectBody: "La modifica preparata viene scartata. Nulla viene installato o considerato attendibile.",
    pendingChangeFailed: ({ outcome }: { outcome: string }) => `La modifica del plugin non è stata applicata (${outcome}).`,
    developmentCreateDirectoryTitle: "Cartella del plugin",
    developmentCreateDirectoryBody: "Inserisci la nuova cartella assoluta sul computer selezionato. La cartella non deve esistere.",
    developmentCreateNameTitle: "Nome plugin",
    developmentCreateNameBody: "Inserisci il nome visualizzato per il plugin.",
    developmentCreateIdTitle: "ID plugin",
    developmentCreateIdBody: "Inserisci uno spazio dei nomi proprietario minuscolo, separato da punti e diverso da happier.*.",
    developmentCreateSurfaceTitle: "Superficie di interfaccia del plugin",
    developmentCreateSurfaceBody: "Scegli la superficie di interfaccia con cui inizia questo plugin. React Native viene renderizzato anche sul web.",
    developmentCreateSurfaceReactNative: "React Native",
    developmentCreateSurfaceHostedWeb: "Web ospitato",
    developmentCreateSurfaceNone: "Nessuna interfaccia",
    developmentCreateConfirmTitle: "Creare il modello del plugin?",
    developmentCreateConfirmBody: ({ pluginId, targetDir }: { pluginId: string; targetDir: string }) => `Creare ${pluginId} in ${targetDir}?`,
    developmentWatchConfigured: "Approvazione monitoraggio configurata",
    developmentReloadClear: "Nessuna diagnostica di ricaricamento attuale",
    developmentReloadAttention: "La diagnostica di ricaricamento richiede attenzione",
    developmentTest: "Testa plugin",
    developmentTestSubtitle: "Verifica il punto di ingresso compilato con il runtime gestito di Happier.",
    developmentTestSucceeded: "Test del plugin superato.",
    developmentPack: "Crea pacchetto plugin",
    developmentPackSubtitle: "Crea l'archivio installabile convalidato accanto alla cartella sorgente approvata.",
    developmentPackSucceeded: "Pacchetto creato accanto alla cartella sorgente.",
    diagnosticsSnapshotTitle: "Diagnostica",
    diagnosticsSnapshotFooter: "Diagnostica attuale segnalata dal registro dei plugin su questo dispositivo.",
    diagnosticsSnapshotEmpty: "Nessuna diagnostica attuale dei plugin",
    diagnosticsSnapshotEmptySubtitle: "La diagnostica attuale del registro apparirà qui quando questo dispositivo la segnalerà.",
    catalogUrlLabel: "URL del catalogo",
    loadCatalog: "Carica catalogo",
    installAndTrust: "Installa e autorizza",
    marketplaceWithdrawnTitle: "Ritirato dal marketplace",
    marketplaceWithdrawnBody: "Questa voce è stata ritirata dal marketplace selezionato. Le nuove installazioni e gli aggiornamenti sono bloccati.",
    marketplaceWithdrawnInstalledBody: "Questa voce è stata ritirata dal marketplace selezionato. Le nuove installazioni e gli aggiornamenti sono bloccati. Il plugin installato rimane abilitato finché non lo disabiliti o disinstalli.",
    trustPolicy: {
      localTrusted: "Attendibile localmente",
      trusted: "Attendibile",
      prompt: "Approvazione richiesta",
      untrusted: "Non attendibile",
    },
    sourceKind: {
      bundled: "Integrato",
      path: "Percorso locale",
      marketplace: "Mercato dei plugin",
      package: "Registro pacchetti",
      archive: "Archivio",
      catalog: "Catalogo",
    },
    unknownValue: ({ value }: { value: string }) => `Altro: ${value}`,
    emptySubtitle: "Questo catalogo non ha restituito descrittori.",
    detailTitle: "Dettagli del plugin",
    managePlugin: "Gestisci plugin",
    provenanceTitle: "Origine e attendibilità",
    diagnosticsTitle: "Diagnostica del plugin",
    registryDiagnosticsTitle: "Diagnostica del registro",
    agentUiDiagnosticsTitle: "Diagnostica dell'interfaccia dell'agente",
    contributionsTitle: "Contributi proiettati",
    unsupportedDescriptorField: "Questo campo descrittore non è supportato da questa versione di Happier.",
    noDescriptors: "Per questa sezione non sono stati proiettati descrittori renderizzati dall'host.",
    marketplaceInstallReviewTitle: ({ name, version }: { name: string; version: string }) => `Installare e considerare attendibile ${name} ${version}?`,
    marketplaceInstallReviewBlockedNewerVersions: 'Versioni più recenti bloccate prima del download:',
    marketplaceInstallReviewRawCredentialAccess: ({ details }: { details: string }) => `Accesso diretto alle credenziali Voice:\n${details}`,
    marketplaceInstallReviewRawCredentialAccessItem: ({ contribution, credential, source, realm, phase, request }: { contribution: string; credential: string; source: string; realm: string; phase: string; request: string }) =>
      `${contribution}: ${credential}; origine ${source}; runtime ${realm}; fase ${phase}; richiesta ${request}. Il codice del plugin nel runtime ${realm} riceve direttamente la credenziale selezionata e può usarla o copiarla.`,
    marketplaceInstallReviewBody: ({ identity, verification, executableRealms, contributions, uiArtifacts, requiredAccess, optionalAccess, compatibility }: { identity: string; verification: string; executableRealms: string; contributions: string; uiArtifacts: string; requiredAccess: string; optionalAccess: string; compatibility: string }) => `Identità:\n${identity}\n\nSegnali di verifica:\n${verification}\n\nCodice eseguibile: ${executableRealms}\nContributi: ${contributions}\nArtefatti UI: ${uiArtifacts}\n\nIl codice daemon e React Native considerato attendibile viene eseguito con l'autorità dell'applicazione o del processo e può usare direttamente file, rete, ambiente e processi. L'accesso host elencato di seguito descrive servizi mediati da Happier; non è una sandbox per il codice eseguibile del plugin.\n\nInformazioni e servizi cooperativi obbligatori:\n${requiredAccess}\n\nRisorse host facoltative (disattivate per impostazione predefinita):\n${optionalAccess}\n\nCompatibilità e aggiornamenti:\n${compatibility}`,
    marketplaceInstallDecisionFailed: ({ outcome }: { outcome: string }) => `Il plugin non è stato installato (${outcome}).`,
    marketplaceChangeDecisionFailed: ({ action, outcome }: { action: string; outcome: string }) => `${action} non riuscita (${outcome}).`,
    pluginChangeConfirmBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Conferma «${action}» per ${name} su ${machine} (${server}).`,
    pluginChangeConfirmTarget: ({ machine, server }: { machine: string; server: string }) => `Questa azione riguarda ${machine} (${server}).`,
    forgetTrust: "Dimentica attendibilità",
    rollback: "Ripristina versione",
    uninstall: "Disinstalla",
    marketplaceUpdateVersion: ({ installedVersion, availableVersion }: { installedVersion: string; availableVersion: string }) => `Aggiorna dalla versione ${installedVersion} alla ${availableVersion}.`,
    marketplaceCommunityUnreviewedTitle: "Codice della community non verificato",
    marketplaceCommunityUnreviewedBody: "Questo pacchetto npm di terze parti non è stato verificato da Happier. «Installa e considera attendibile» approva il codice eseguibile e l'accesso host dichiarati dopo che il daemon ha verificato esattamente versione e integrità. Il codice daemon e React Native considerato attendibile viene eseguito con l'autorità dell'applicazione o del processo; l'accesso host elencato non è una sandbox.",
    genericSettingsTitle: "Impostazioni del plugin",
    genericSettingsFooter: "Memorizzate localmente per questo plugin su questa macchina.",
    genericSettingsLoading: "Caricamento impostazioni del plugin",
    genericSettingsUnavailable: "Le impostazioni del plugin non sono disponibili per questa macchina.",
    genericSettingsLoadError: "Impossibile caricare le impostazioni del plugin.",
    genericSettingsSaveError: "Impossibile salvare l'impostazione del plugin.",
    genericSettingsEmpty: "Questo plugin non ha proiettato impostazioni modificabili.",
    registriesTitle: "Registri npm privati",
    registriesFooter: "L'accesso al registro controlla solo l'accesso ai pacchetti. I plugin installati e attendibili restano disponibili se un registro viene rimosso o disconnesso.",
    registriesAdd: "Aggiungi registro",
    registriesAddTitle: "Aggiungi registro privato",
    registriesAddOriginBody: "Inserisci l'origine HTTPS del registro senza credenziali.",
    registriesInvalidOriginTitle: "Origine del registro non valida",
    registriesInvalidOriginBody: "Usa un'origine HTTPS senza credenziali, percorso, query o frammento.",
    registriesNameTitle: "Nome del registro",
    registriesNameBody: "Scegli un nome mostrato solo nelle impostazioni di Happier.",
    registriesScopesTitle: "Ambiti dei pacchetti",
    registriesScopesBody: "Ambiti facoltativi separati da virgole instradati a questo registro.",
    registriesScopesPlaceholder: "@azienda, @team-it",
    registriesDefaultTitle: "Registro pacchetti predefinito",
    registriesDefaultBody: "Usare questo registro per i pacchetti senza ambito non instradati a un'altra origine configurata?",
    registriesUseAsDefault: "Usa come predefinito",
    registriesScopedOnly: "Solo pacchetti con ambito",
    registriesPrivateNetworkTitle: "Accesso alla rete privata",
    registriesPrivateNetworkBody: "Consentire all'origine del registro di risolversi in indirizzi di rete privati o locali? Lascia disattivato per i registri ospitati su Internet.",
    registriesAllowPrivateNetwork: "Consenti rete privata",
    registriesPublicOnly: "Solo indirizzi pubblici",
    registriesLogin: "Accedi",
    registriesLoginTitle: "Token del registro",
    registriesLoginBody: "Incolla un token per questo registro. Viene cifrato sulla macchina selezionata e non viene memorizzato nell'app.",
    registriesLogout: "Esci",
    registriesEdit: "Modifica registro",
    registriesTest: "Prova connessione",
    registriesMarketplaceBindingsTitle: "Associazioni dei registri del marketplace",
    registriesMarketplaceBind: ({ profile, source }: { profile: string; source: string }) => `Usa ${profile} per ${source}`,
    registriesMarketplaceUnbind: ({ source }: { source: string }) => `Non usare più un registro privato per ${source}`,
    registriesRemove: "Rimuovi registro",
    registriesRemoveTitle: "Rimuovere il registro privato?",
    registriesRemoveBody: ({ name }: { name: string }) => `Rimuovere ${name}? I plugin installati restano installati e attendibili; i download e gli aggiornamenti futuri da questo registro verranno sospesi.`,
    registriesAvailability: {
      unknown: "Non verificato",
      available: "Disponibile",
      sign_in_required: "Accesso richiesto",
      offline: "Non in linea",
    },
    registriesUpdatePaused: "Aggiornamenti sospesi",
    registriesPauseReason: {
      credentials_missing: "Mancano le credenziali del registro",
      authentication_failed: "Autenticazione del registro non riuscita",
      profile_removed: "Il profilo del registro è stato rimosso",
      offline: "Il registro è offline",
    },
    registriesErrorTitle: "Operazione del registro non riuscita",
    registriesErrorBody: "Aggiorna l'elenco dei registri e riprova.",
    registriesInvalidProfileTitle: "Impostazioni del registro non valide",
    registriesInvalidProfileBody: "Controlla il nome del registro e gli ambiti dei pacchetti, quindi riprova.",
    registriesNoMachine: "Seleziona una macchina per gestire i registri privati.",
    registriesLoadError: "Impossibile caricare le impostazioni dei registri privati.",
    registriesEmpty: "Nessun registro privato configurato.",
  },
    settingsScmDiffSummary: {
    title: 'Riepiloghi diff',
    enabledTitle: 'Abilita riepiloghi diff',
    enabledSubtitle:
      'Consenti riepiloghi generati dall’IA per i diff del controllo sorgente.',
    prefetchTitle: 'Precarica riepiloghi',
    prefetchSubtitle:
      'Genera riepiloghi in anticipo solo quando questa preferenza è attiva.',
    modelOverrideTitle: 'Modello di riepilogo',
    modelOverrideSubtitle:
      'Profilo runtime risolto opzionale usato per i riepiloghi diff.',
    modelOverrideDefault: 'Usa il valore predefinito del runtime',
    cacheTitle: 'Cache riepiloghi',
    cacheSubtitle:
      'I riepiloghi dei checkpoint vengono riutilizzati per ricevuta; quelli del working tree restano temporanei.',
  },
    externalSessions: {
        ...externalSessionOperationTranslations.it,
        ...externalSessionSettingsTranslations.it,
        settingsTitle: 'Sessioni esterne',
        settingsEntrySubtitle: 'Controlla come Happier gestisce le sessioni avviate fuori dall’app.',
        settingsSafetyGroupTitle: 'Come funziona',
        settingsPassiveTitle: 'Sola lettura per impostazione predefinita',
        settingsPassiveSubtitle: 'Aprire questa pagina è un’azione passiva. Non avvia o riprende mai un Agent, non ne modifica la configurazione, non installa hook e non inizia a seguire una sessione.',
        settingsFollowGroupTitle: 'Monitoraggio passivo',
        settingsRestoreTitle: 'Mantieni il monitoraggio passivo dopo il riavvio',
        settingsRestoreEnabledSubtitle: 'Riconnetti le sessioni che segui esplicitamente quando il daemon si riavvia.',
        settingsRestoreDisabledSubtitle: 'Non riconnettere le sessioni seguite dopo il riavvio del daemon.',
        settingsRestoreFooter: 'Il ripristino osserva solo una sorgente Agent esistente. Non avvia né riprende mai l’Agent.',
        settingsNotificationsTitle: 'Notifiche',
        settingsNotificationsActiveSubtitle: 'Le notifiche di disponibilità si applicano solo alle sessioni con monitoraggio passivo attivo.',
        settingsNotificationsInactiveSubtitle: 'Attiva il monitoraggio passivo per una sessione per riceverne le notifiche.',
        settingsActiveFollowsGroupTitle: 'Sessioni monitorate',
        settingsActiveFollowsFooter: 'Ogni scelta si applica solo a quella sessione. Le altre sessioni non vengono mai attivate automaticamente.',
        settingsActiveFollowsEmptyTitle: 'Nessuna sessione esterna',
        settingsActiveFollowsEmptySubtitle: 'Le sessioni esterne collegate appariranno qui con il loro stato corrente.',
        settingsFollowToggleHint: 'Avvia o interrompe il monitoraggio passivo in background per questa sessione.',
        followStatusDisabled: 'Non monitorata',
        followStatusPaused: 'Monitoraggio in pausa',
        followStatusReacquiring: 'Riconnessione del monitoraggio…',
        followStatusActive: 'Monitoraggio attivo',
        followStatusError: 'Il monitoraggio richiede attenzione',
        followStatusUnknown: 'Stato del monitoraggio non disponibile',
        followStatusMachineOffline: 'La macchina è offline; il monitoraggio passivo riprenderà alla riconnessione',
        followStatusUnsupported: 'Questo Agent non supporta il monitoraggio passivo',
        followUpdateFailed: 'Happier non ha potuto aggiornare il monitoraggio passivo per questa sessione. Riprova.',
    browseTitle: "Sfoglia le sessioni esterne",
    browseOpenExisting: "Sfoglia le sessioni esterne",
    browseActionSubtitle: "Scegli una macchina, un agente e una sessione per aprirla qui.",
    emptyStateTitle: "Sfoglia una sessione esistente",
    emptyStateDescription: "Apri sessioni di Claude, Codex e OpenCode dalle tue macchine collegate.",
    browseFiltersTitle: "Seleziona origine",
    browseMachines: "Macchine",
    browseAgents: "Agenti",
    browseSources: "Sorgenti",
    browseSourceCodexUserHome: "La mia home di Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} servizi collegati`,
    browseSourceClaudeDefault: "Configurazione predefinita di Claude",
    browseSourceOpenCodeDefault: "Server OpenCode predefinito",
    browseCandidates: "Sessioni disponibili",
    browseNoMachines: "Non ci sono ancora macchine disponibili per le sessioni dirette.",
    browseNoCandidates: "Nessuna sessione esterna trovata per questa macchina e questo agente.",
    browseActivityRunning: "In esecuzione",
        browseActivityRunningNow: "In esecuzione",
    browseActivityRecent: "Recente",
    browseActivityIdle: "Inattiva",
    browseActivityUnknown: "Sconosciuta",
        browseSearchPlaceholder: "Cerca nelle sessioni caricate…",
        browseNoSearchResults: "Nessuna sessione caricata corrisponde ancora a questa ricerca.",
    browseIndexing: "Indicizzazione delle sessioni esterne…",
    browseIndexingProgress: ({ scanned, total }: { scanned: number; total: number }) => `${scanned} di ${total} sessioni indicizzate`,
    browseIndexingCancelled: "Indicizzazione interrotta. Riprova quando vuoi.",
    browseLoadMore: "Carica altre sessioni",
    browseFailedToLoad: "Impossibile caricare le sessioni esterne.",
    browseLinkFailed: "Impossibile collegare la sessione esterna selezionata.",
  },
    pluginReactNative: {
    unavailable: "UI React Native del plugin non disponibile",
    disabled: "UI React Native del plugin disattivata",
    fallback: "Uso del fallback del plugin",
    reset: {
      requested: {
        title: "Reimpostazione dell'UI del plugin",
        reason: "Happier attende la conferma della reimpostazione.",
      },
      awaitingProjection: {
        title: "In attesa della reimpostazione del plugin",
        reason: "Happier attende lo stato aggiornato del plugin.",
      },
      complete: {
        title: "L'interfaccia del plugin è stata reimpostata",
        reason: "L'interfaccia del plugin è di nuovo disponibile.",
      },
      failed: {
        title: "Impossibile reimpostare l'UI del plugin",
        reason: "Prova a reimpostarla di nuovo.",
      },
    },
  },
    pluginRuntime: {
        unavailableGeneric: 'Questa vista del plugin non è al momento disponibile.',
        crashLoop: 'Il plugin è stato arrestato dopo ripetuti arresti anomali.',
        disabledByPolicy: 'Questa vista del plugin è disattivata dalle impostazioni o dalla compatibilità attuali.',
        hostedWebUnavailableTitle: 'La vista ospitata del plugin non è disponibile',
        hostedWebPolicyDenied: 'Questa vista del plugin non è disponibile in questa superficie. Controlla le impostazioni di disponibilità o usa una superficie supportata.',
        hostedWebSandboxUnavailable: 'Questo plugin non dichiara le impostazioni di isolamento necessarie per mostrare questa vista. Aggiorna il plugin e riprova.',
        hostedWebSecurityUnavailable: 'Le impostazioni di sicurezza del plugin non possono essere applicate in questa vista. Aggiorna il plugin o usa un host supportato.',
        hostedWebFrameOriginUnavailable: 'Happier non ha potuto stabilire un indirizzo attendibile per questa vista. Aggiorna la pagina e riprova.',
        hostedWebBridgeNonceUnavailable: 'Happier non ha potuto stabilire una connessione sicura con questa vista. Aggiorna la pagina e riprova.',
        hostedWebBridgeTimeout: 'Questa vista del plugin non ha completato la connessione. Aggiorna la pagina e riprova.',
        hostedWebEndpointPolicyDenied: 'L’indirizzo di questa vista è bloccato dalla relativa politica di sicurezza. Controlla le impostazioni del plugin o usa un host supportato.',
        missingRequirement: 'A questa vista del plugin manca un requisito su questo dispositivo.',
    },
    settingsSearch: {
    placeholder: "Cerca impostazioni",
  },
    onboardingJourney: {
        accessibility: {
            skipToContent: "Vai al contenuto",
        },
  },} as const;

export type TranslationsIt = typeof it;
import { PRODUCT_STORY_DETAILS_ENGLISH } from '@happier-dev/brand/product-story';
