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
import { pluginInvocationLogTranslations } from './pluginInvocationLogTranslations';
import { eventAutomationComposerTranslations } from './eventAutomationComposerTranslations';
import { actionOperationInboxTranslations } from './actionOperationInboxTranslations';

const mcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle: 'Crea un servidor, importa JSON del host o instala un preajuste recomendado.',
  mcpServersHeroSubtitle: ({ configuredCount }: { configuredCount: number }) => `${configuredCount} configurados en Happier`,
  mcpServersHeroSubtitleEmpty: 'Crea servidores una vez, previsualiza dónde se aplican e importa lo que ya usan otras herramientas.',
  mcpServersSegmentConfigured: 'Configurado',
  mcpServersSegmentConfiguredSubtitle: 'Tu catálogo de Happier',
  mcpServersSegmentDetected: 'Detectado',
  mcpServersSegmentDetectedSubtitle: 'Encontrado en archivos de configuración del proveedor',
  mcpServersSegmentPreview: 'Vista previa',
  mcpServersSegmentPreviewSubtitle: 'Lo que recibirá esta sesión',
  mcpServersAdvancedTitle: 'Avanzado',
  mcpServersAdvancedSubtitle: 'Modo estricto y comportamiento de validación',
  mcpServersDetectedDirectoryTitle: 'Directorio del proyecto',
  mcpServersDetectedDirectorySubtitle: 'Ruta opcional del workspace para configuraciones a nivel de proyecto',
  mcpServersDetectedDirectoryPlaceholder: '/ruta/al/proyecto',
  mcpServersPreviewAgentTitle: 'Servidor',
  mcpServersPreviewMachineTitle: 'Máquina',
  mcpServersPreviewDeliveryTitle: 'Entrega de herramientas',
  mcpServersPreviewDirectoryTitle: 'Directorio del workspace',
  mcpServersPreviewDirectorySubtitle: 'Elige la carpeta en la que piensas iniciar la sesión',
  mcpServersPreviewDirectoryPlaceholder: '/ruta/al/workspace',
  mcpServersPreviewRefreshTitle: 'Actualizar vista previa',
  mcpServersPreviewRefreshSubtitle: 'Resolver los servidores MCP de Happier y los nativos del proveedor para este contexto',
  mcpServersPreviewEmptyTitle: 'Aún no hay vista previa',
  mcpServersPreviewEmptySubtitle: 'Elige un backend, una máquina y un directorio, y luego actualiza para inspeccionar el conjunto MCP efectivo.',
  mcpServersPreviewDirectoryRequired: 'Elige un directorio para previsualizar esta sesión.',
  mcpServersBuiltInDescription: 'Siempre disponible en sesiones de Happier.',
  mcpServersSourceHappier: 'Happier',
  mcpServersSourceBuiltIn: 'Integrado',
  mcpServersSourceDetected: 'Detectado',
  mcpServersQuickInstallTitle: 'Instalación rápida',
  mcpServersQuickInstallSubtitle: 'Instala servidores MCP comunes para desarrollo en un solo paso.',
  mcpServersQuickInstallAction: 'Instalar',
  mcpServersQuickInstallEmptyTitle: 'Elige un preajuste',
  mcpServersQuickInstallEmptySubtitle: 'Selecciona uno de los servidores MCP recomendados para continuar.',
  mcpServersEditAction: 'Editar',
  mcpServersDeleteAction: 'Eliminar',
  mcpServersAddServerFlowSubtitle: 'Configura un servidor manualmente, importa JSON del host o empieza desde un preajuste seleccionado.',
  mcpServersAddFlowConfigureTitle: 'Configurar',
  mcpServersAddFlowConfigureSubtitle: 'Configuración manual',
  mcpServersAddFlowImportJsonTitle: 'Importar JSON',
  mcpServersAddFlowImportJsonSubtitle: 'Pega la configuración del host',
  mcpServersAddFlowQuickInstallTitle: 'Instalación rápida',
  mcpServersAddFlowQuickInstallSubtitle: 'Preajustes seleccionados',
  mcpServersFieldCommandLine: 'Línea de comandos',
  mcpServersFieldCommandLinePlaceholder: 'npx -y @modelcontextprotocol/server-playwright',
  mcpServersTransportLocalTitle: 'Comando local',
  mcpServersTransportLocalSubtitle: 'Se ejecuta en la máquina seleccionada',
  mcpServersTransportHttpTitle: 'HTTP remoto',
  mcpServersTransportHttpSubtitle: 'Puente desde un endpoint HTTP',
  mcpServersTransportSseTitle: 'SSE remoto',
  mcpServersTransportSseSubtitle: 'Puente desde eventos enviados por el servidor',
  mcpServersAdvancedCommandEditorTitle: 'Editor avanzado de comandos',
  mcpServersAdvancedCommandEditorSubtitle: 'Divide el comando y los argumentos manualmente',
  mcpServersCancelSubtitle: 'Salir sin guardar este borrador',
  mcpServersImportJsonTitle: 'Pega JSON del host MCP',
  mcpServersImportJsonSubtitle: 'Admitimos formatos comunes usados en README y hosts de escritorio.',
  mcpServersImportJsonPlaceholder: '{"mcpServers":{"prueba":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: 'Error de importación',
  mcpServersImportJsonWarningsTitle: 'Advertencias de importación',
  mcpServersImportJsonEmptyTitle: 'Todavía no hay servidores analizados',
  mcpServersImportJsonEmptySubtitle: 'Pega JSON MCP del host para previsualizar los servidores antes de importarlos.',
  mcpServersImportJsonAction: 'Importar servidores',
  mcpServersImportMappingSavedSecret: 'Usar secreto guardado',
  mcpServersImportMappingMachineEnv: 'Usar variables de entorno de la máquina',
  mcpServersImportSecretNamePlaceholder: 'Nombre del secreto guardado',
  mcpServersImportSecretValuePlaceholder: 'Valor del secreto guardado',
  mcpServersImportMachineEnvPlaceholder: 'ENV_VAR_NAME',
  mcpServersImportMappingMissingSecretName: ({ input }: { input: string }) => `Introduce un nombre de secreto guardado para ${input}.`,
  mcpServersImportMappingMissingSecretValue: ({ input }: { input: string }) => `Introduce un valor de secreto guardado para ${input} o cambia a variables de entorno de la máquina.`,
  mcpServersImportMappingMissingMachineEnvName: ({ input }: { input: string }) => `Introduce un nombre de variable de entorno de la máquina para ${input}.`,
  mcpServersAuthSavedSecret: 'Secreto guardado',
  mcpServersAuthMachineEnv: 'Variables de entorno de la máquina',
  mcpServersAuthPlainText: 'Texto plano',
  mcpServersAuthUnknown: 'Autenticación desconocida',
  mcpServersAuthNone: 'Sin autenticación',
  mcpServersScopeAllMachines: 'Todas las máquinas',
  mcpServersScopeMachine: 'Máquina',
  mcpServersScopeWorkspace: 'Espacio de trabajo',
  mcpServersScopeProviderProject: 'Configuración de proyecto del proveedor',
  mcpServersScopeProviderUser: 'Configuración de usuario del proveedor',
  mcpServersScopeBuiltIn: 'Integrado',
  mcpServersStatusActive: 'Activo',
  mcpServersStatusAvailable: 'Disponible',
  mcpServersStatusUnavailable: 'No disponible',
  mcpServersStatusDetected: ({ provider }: { provider: string }) => `Habilitado en ${provider}`,
  mcpServersStatusDisabledInProvider: ({ provider }: { provider: string }) => `Deshabilitado en ${provider}`,
  mcpServersEditorAppliesTo: 'Se aplica a',
  mcpServersEditorAppliesToSubtitle: 'Elige dónde debe añadir Happier este servidor de forma predeterminada.',
  mcpServersAddApplyRule: 'Añadir regla de aplicación',
  mcpServersAddApplyRuleSubtitle: 'Elige dónde debe aplicarse este servidor de forma predeterminada.',
  mcpServersAddApplyRuleHelp: 'Guarda esta regla de aplicación para incluirla en esta configuración de servidor.',
  mcpServersAddApplyRuleSave: 'Guardar regla de aplicación',
  mcpServersDeliveryNativeTitle: 'MCP nativo',
  mcpServersDeliveryNativeSubtitle: 'Este backend recibe las herramientas de Happier como servidores MCP nativos.',
  mcpServersDeliveryShellBridgeTitle: 'Puente de shell de Happier',
  mcpServersDeliveryShellBridgeSubtitle: 'Este backend llama a las herramientas de Happier a través del puente happier tools.',
  mcpServersDeliveryUnsupportedTitle: 'No compatible',
  mcpServersDeliveryUnsupportedSubtitle: 'Este backend todavía no recibe herramientas de Happier.',
} as const;

const newSessionMcpTranslationExtension = {
  mcpChipLabel: 'MCP',
  mcpChipLabelWithCount: ({ count }: { count: number }) => `MCP ${count}`,
  mcpModalTitle: 'Servidores MCP',
  mcpModalSubtitle: ({ machineName, directory }: { machineName: string; directory: string }) =>
    `Vista previa de los servidores MCP disponibles en ${machineName} para ${directory}.`,
  mcpManagedToggleTitle: 'Servidores MCP administrados',
  mcpManagedToggleSubtitle: 'Incluye los servidores MCP administrados cuando estén disponibles para esta sesión.',
  mcpOpenSettingsTitle: 'Abrir ajustes de MCP',
  mcpOpenSettingsSubtitle: 'Administra los servidores configurados, las vinculaciones y las opciones de importación.',
  mcpUnavailableNoContextTitle: 'Elige primero una máquina y un directorio',
  mcpUnavailableNoContextSubtitle: 'La vista previa de MCP necesita tanto una máquina de destino como un directorio de trabajo.',
  mcpSelectedSectionTitle: 'Seleccionados',
  mcpAvailableSectionTitle: 'Disponibles',
  mcpUnavailableSectionTitle: 'No disponibles',
  mcpDetectedSectionTitle: 'Detectados en configuraciones del proveedor',
  mcpDetectedSectionTitleForAgent: ({ agentName }: { agentName: string }) => `Detectados en la configuración de ${agentName}`,
  mcpDetectedEmptyTitle: 'No se detectaron servidores MCP',
  mcpDetectedEmptySubtitle: 'Actualiza para escanear los archivos de configuración del proveedor en esta máquina.',
  mcpDetectedUnsupportedTitle: 'Los servidores MCP detectados no están disponibles',
  mcpDetectedUnsupportedSubtitle: 'Actualiza Happier en esta máquina para habilitar el escaneo de la configuración del proveedor.',
  mcpHappierSectionTitle: 'Servidores MCP de Happier',
  mcpHappierEmptyTitle: 'No hay servidores MCP definidos en Happier',
  mcpHappierEmptySubtitle: 'Define servidores MCP en los ajustes para usarlos en las sesiones.',
  mcpReasonActiveByDefault: 'Incluidos por defecto',
  mcpReasonForcedIncluded: 'Requeridos por la configuración',
  mcpReasonForcedExcluded: 'Excluidos por la configuración',
  mcpReasonManagedDisabled: 'Los servidores MCP administrados están deshabilitados',
  mcpReasonBindingDisabled: 'Deshabilitados por la vinculación del servidor',
  mcpReasonAvailablePortable: 'Compatibles con esta sesión',
  mcpReasonNotPortable: 'No compatibles con esta sesión',
} as const;

const settingsAppearanceTranslationExtension = {
  themeProfiles: {
    title: 'Temas',
    editorTitle: 'Perfil temático',
    activeGroup: 'Tema activo',
    activeFooter: 'Elija el tema utilizado por la interfaz. Administre temas personalizados desde la pantalla de temas.',
    builtInGroup: 'Temas incorporados',
    builtInFooter: 'Los temas integrados son de sólo lectura. Duplique uno para personalizarlo localmente.',
    customGroup: 'Temas personalizados',
    customFooter: 'Toque un tema para activarlo o use acciones de fila para editarlo, duplicarlo o eliminarlo.',
    defaultTheme: 'Tema predeterminado',
    defaultThemeSubtitle: 'Utilice Happier colores de tema sin un perfil personalizado',
    active: 'Activo',
    customProfileSubtitle: 'Perfil de tema local personalizado',
    tapToActivate: 'Toca para activar',
    actionsGroup: 'Acciones temáticas',
    createProfile: 'Crear tema',
    createProfileSubtitle: 'Comience desde cualquier tema integrado o personalizado',
    importProfile: 'Importar tema',
    importProfileSubtitle: 'Pega JSON o elige un archivo de perfil de tema Happier',
    exportProfile: 'Tema de exportación',
    exportProfileSubtitle: 'Exporta este tema como JSON',
    presetsGroup: 'Preajustes incorporados',
    presetsFooter: 'Los perfiles integrados son de sólo lectura. Clona uno para personalizarlo.',
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
    readOnlyPreset: 'Preajuste de solo lectura',
    clonePreset: 'Clonar preestablecido',
    cloneProfile: 'Clonar perfil',
    duplicateTheme: 'Tema duplicado',
    editProfile: 'Editar perfil',
    newProfileName: ({ count }: { count: number }) => `Tema personalizado ${count}`,
    cloneName: ({ name }: { name: string }) => `Copia de ${name}`,
    detailsGroup: 'Detalles',
    presetGroup: 'Preestablecido',
    presetSource: 'Preestablecido',
    presetSourceSubtitle: 'Elija un tema para usar como punto de partida',
    assetAppearance: 'Aspecto del activo',
    assetAppearanceSubtitle: 'Elija si este tema utiliza recursos de aplicación claros u oscuros.',
    replacePresetTitle: '¿Reemplazar los colores actuales?',
    replacePresetSubtitle: 'Cambiar el ajuste preestablecido reemplazará los colores de borrador actuales. Se descartarán las ediciones de color no guardadas.',
    profileName: 'Nombre del perfil',
    editorModeGroup: 'Modo tema',
    editorModeFooter: 'Este tema edita el modo de color seleccionado por su ajuste preestablecido.',
    editorMode: 'Variante',
    lightMode: 'Luz',
    darkMode: 'oscuro',
    previewTitle: 'Vista previa del tema',
    previewSubtitle: 'Una vista previa local de la zona de pruebas de superficies, texto, controles, estado y colores de sintaxis.',
    previewButton: 'acción primaria',
    previewStatus: 'Listo',
    previewCode: 'const theme = "happier";',
    colorInputPlaceholder: '#RRGGBB, rgba(...), transparent',
    tokenSubtitle: 'Anulación de token de color público',
    recentColors: 'Colores recientes',
    colorPickerFallback: 'Introduzca un valor de color o reutilice un color reciente.',
    invalidColor: 'Use hex, rgb(...), rgba(...), or transparent.',
    invalidProfileName: 'Nombre de perfil no válido.',
    profileLimitReached: 'Se alcanzó el límite de temas.',
    contrastWarning: 'Bajo contraste para este par de tokens. Aún puedes guardar o restablecer.',
    resetToken: 'Restablecer token',
    resetGroup: 'Restablecer y desactivar',
    resetMode: 'Restablecer colores del tema',
    deactivateProfile: 'Usar tema predeterminado',
    deactivateProfileSubtitle: 'Desactiva el perfil personalizado y mantenlo guardado',
    deleteProfile: 'Eliminar perfil',
    deleteProfileSubtitle: 'Eliminar este perfil de tema personalizado local',
    saveAndActivate: 'Guardar y activar',
    missingProfile: 'Perfil del tema no encontrado',
    importFooter: ({ formats }: { formats: string }) => `Formatos compatibles: ${formats}. Los tokens desconocidos se muestran como advertencias.`,
    importJson: 'Tema JSON',
    importJsonPlaceholder: "Pega el JSON de tu tema aquí",
    importFile: 'Elige el archivo',
    importWarnings: ({ count }: { count: number }) => `Se encontraron ${count} advertencia(s) durante la importación.`,
    importErrors: {
      invalidJson: 'El texto pegado no es válido JSON.',
      unsupportedSchema: 'Esta versión del perfil del tema no es compatible.',
      invalidProfile: 'Este perfil de tema no se pudo importar.',
      tooLarge: 'Este perfil de tema JSON es demasiado grande.',
    },
    exportFooter: 'El JSON exportado incluye todos los valores de token de color públicos para este tema.',
    exportJson: 'Exportar JSON',
    copyExportJson: 'Copiar JSON',
    downloadExportJson: 'Descargar JSON',
    noProfiles: 'Aún no hay temas personalizados',
    groups: {
      background: 'Antecedentes',
      surface: 'Superficies',
      border: 'Fronteras',
      effect: 'Efectos',
      chrome: 'Cromo',
      text: 'Texto',
      state: 'Estado',
      control: 'Controles',
      composer: 'Compositor',
      message: 'Mensajes',
      syntax: 'Sintaxis',
      versionControl: 'Control de versiones',
      diff: 'diferencias',
      permission: 'Permisos',
      overlay: 'Superposiciones',
    },
  },
  sessionListDensity: {
    title: 'Densidad de la lista de sesiones',
    subtitle: 'Elige cómo se muestran las sesiones en la barra lateral',
    detailed: 'Detallada',
    detailedDescription: 'Filas de tamaño completo con avatares y estado',
    cozy: 'Intermedia',
    cozyDescription: 'Filas más pequeñas con avatares',
    narrow: 'Estrecha',
    narrowDescription: 'Filas estrechas con microavatares',
  },
} as const;

const acpCatalogTranslationExtension = {
  settings: {
    acpCatalog: 'Backends ACP',
    acpCatalogSubtitle: 'Gestiona los backends ACP integrados y personalizados',
    acpCatalogBuiltIn: 'ACP integrado',
    acpCatalogBuiltInFooter:
      'Los agentes ACP genéricos integrados se definen en el catálogo compartido y se ejecutan mediante el entorno de ejecución ACP compartido.',
    acpCatalogBackends: 'Backends personalizados',
    acpCatalogBackendsFooter:
      'Cada backend personalizado es una definición CLI compatible con ACP seleccionable, con su propio lanzador, valores predeterminados y configuración de autenticación.',
    acpCatalogBackendsEmptyTitle: 'No hay backends ACP personalizados',
    acpCatalogBackendsEmptySubtitle: 'Añade un backend para crear una opción de backend ACP personalizado seleccionable.',
    acpCatalogAddBackend: 'Añadir backend ACP',
    acpCatalogAddBackendSubtitle: 'Crear una opción de backend ACP personalizado',
    acpCatalogBackendEditorTitle: 'Backend ACP',
    acpCatalogBasics: 'Básicos',
    acpCatalogLauncher: 'Lanzador',
    acpCatalogEnv: 'Entorno',
    acpCatalogAddEnv: 'Añadir variable de entorno',
    acpCatalogAddEnvSubtitle: 'Guarda valores literales o vincula Secretos guardados',
    acpCatalogEnvEmptyTitle: 'No hay variables de entorno',
    acpCatalogEnvEmptySubtitle: 'Añade variables de inicio para este backend.',
    acpCatalogAuth: 'Autenticación',
    acpCatalogAuthSupport: 'Compatibilidad con autenticación',
    acpCatalogAuthParser: 'Analizador de estado',
    acpCatalogCapabilities: 'Capacidades',
    acpCatalogTransportProfile: 'Perfil de transporte',
    acpCatalogSupportsModes: 'Admite modos',
    acpCatalogSupportsModels: 'Admite modelos',
    acpCatalogSupportsConfigOptions: 'Admite opciones de configuración',
    acpCatalogPromptImageSupport: 'Compatibilidad con imágenes en prompts',
    acpCatalogFieldId: 'ID',
    acpCatalogFieldName: 'Nombre',
    acpCatalogFieldTitle: 'Título',
    acpCatalogFieldDescription: 'Descripción',
    acpCatalogFieldCommand: 'Comando',
    acpCatalogFieldArgs: 'Argumentos (uno por línea)',
    acpCatalogMachineLoginKey: 'Clave de inicio de sesión de la máquina',
    acpCatalogDocsUrl: 'URL de documentación',
    acpCatalogLoginCommand: 'Comando de inicio de sesión',
    acpCatalogLoginArgs: 'Argumentos de inicio de sesión (uno por línea)',
    acpCatalogStatusCommand: 'Tokens del comando de estado (uno por línea)',
    acpCatalogDefaultMode: 'Modo predeterminado',
    acpCatalogDefaultModel: 'Modelo predeterminado',
    acpCatalogDeleteBackendTitle: '¿Eliminar backend ACP?',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `¿Eliminar "${name}"?`,
    acpCatalogValidationFailed: 'La configuración del catálogo ACP no es válida.',
  },
  newSession: {},
} as const;

const memoryEmbeddingsTranslationExtension = {
  status: {
    embeddingsTitle: 'Tiempo de ejecución de embeddings',
    embeddingsProviderTitle: 'Proveedor de embeddings',
    embeddingsModelTitle: 'Modelo de embeddings',
    embeddingsDisabled: 'Los embeddings están desactivados',
    embeddingsReady: 'Los embeddings están listos',
    embeddingsDownloading: 'El modelo de embeddings se está descargando',
    embeddingsFallback: 'Embeddings no disponibles, usando reserva de solo texto',
    embeddingsUnavailable: 'Embeddings no disponibles',
    embeddingsError: 'No se pudieron inicializar los embeddings',
    embeddingsProviderLocal: 'Modelo local',
    embeddingsProviderOpenAiCompatible: 'Punto final compatible con OpenAI',
  },
  embeddings: {
    groupTitle: 'Vectores',
    groupFooter:
      'Opcional: mejora la clasificación de búsqueda profunda con un modelo local o con tu propio punto final compatible con OpenAI.',
    mode: {
      title: 'Modo de embeddings',
      options: {
        disabledTitle: 'Desactivado',
        disabledSubtitle: 'Usar clasificación solo de texto para búsqueda profunda',
        balancedTitle: 'Equilibrado',
        balancedSubtitle: 'Ajuste local rápido y validado',
        longContextTitle: 'Contexto largo',
        longContextSubtitle: 'Mejor para fragmentos de conversación más grandes',
        qualityTitle: 'Calidad',
        qualitySubtitle: 'Ajuste local de mayor coste para evaluación',
        customTitle: 'Personalizado',
        customSubtitle: 'Elige tu propio proveedor y modelo',
      },
    },
    provider: {
      title: 'Proveedor',
      options: {
        localTitle: 'Modelo local',
        localSubtitle: 'Gestionado por Happier y descargado en el primer uso',
        openAiCompatibleTitle: 'Punto final compatible con OpenAI',
        openAiCompatibleSubtitle: 'Usa tu propio servidor de embeddings y tu clave de API',
      },
    },
    notSet: 'No establecido',
    secretSet: 'Establecido',
    secretNotSet: 'No establecido',
    queryPrefixTitle: 'Prefijo de consulta',
    queryPrefixPromptBody: 'Prefijo opcional que se antepone a las búsquedas del usuario antes de generar embeddings.',
    documentPrefixTitle: 'Prefijo de documento',
    documentPrefixPromptBody: 'Prefijo opcional que se antepone a los fragmentos de memoria indexados antes de generar embeddings.',
    openAi: {
      baseUrlTitle: 'URL base',
      baseUrlPromptBody: 'Introduce la URL base de tu punto final de embeddings compatible con OpenAI.',
      modelTitle: 'Modelo remoto',
      modelPromptBody: 'Introduce el id del modelo de embeddings que se pedirá al punto final remoto.',
      apiKeyTitle: 'Clave de API',
      apiKeyPromptBody: 'Introduce la clave de API usada para el punto final remoto de embeddings.',
      dimensionsTitle: 'Dimensiones',
      dimensionsPromptBody: 'Anulación opcional de la dimensión de salida para puntos finales que la admitan.',
    },
    advanced: {
      ftsWeightTitle: 'Peso de clasificación de texto',
      ftsWeightPromptBody: 'Peso relativo de la clasificación full-text de SQLite al combinar resultados.',
      embeddingWeightTitle: 'Peso de clasificación de embeddings',
      embeddingWeightPromptBody: 'Peso relativo de la similitud de embeddings al combinar resultados.',
    },
  },
} as const;

const promptLibraryUxRefinementTranslationExtension = {
  es: {
    promptsSubtitle: 'Documentos de prompt reutilizables',
    skillsSubtitle: 'Paquetes de habilidades reutilizables',
    addPrompt: 'Añadir nuevo prompt',
    addPromptSubtitle: 'Crear un nuevo documento de prompt',
    addSkill: 'Añadir nueva habilidad',
    addSkillSubtitle: 'Crear un nuevo paquete de habilidad',
    newTemplateSubtitle: 'Crea una plantilla slash reutilizable',
    noPrompts: 'Aún no hay prompts',
    noPromptsSubtitle: 'Crea un prompt para empezar a construir plantillas y añadidos al prompt del sistema.',
    noSkills: 'Aún no hay habilidades',
    noSkillsSubtitle: 'Crea un paquete de habilidad para reutilizar instrucciones de SKILL.md.',
    imported: 'Importado',
    builtIn: 'Integrado',
    general: 'General de la biblioteca',
    promptNameLabel: 'Nombre del prompt',
    promptContent: 'Contenido del prompt',
    skillNameLabel: 'Nombre de la habilidad',
    skillContent: 'Contenido de SKILL.md',
    supportingFiles: 'Archivos de apoyo',
    supportingFilesEmptyTitle: 'Aún no hay archivos de apoyo',
    supportingFilesEmptySubtitle: 'Añade archivos reutilizables para exportarlos junto con esta habilidad.',
    supportingFilesSaveFirstTitle: 'Guarda primero esta habilidad',
    supportingFilesSaveFirstSubtitle: 'Crea la habilidad antes de añadir archivos de apoyo.',
    addSupportingFile: 'Añadir archivo de apoyo',
    addSupportingFileSubtitle: 'Crear otro archivo dentro de este paquete de habilidad',
    editSupportingFile: 'Editar archivo de apoyo',
    newSupportingFile: 'Nuevo archivo de apoyo',
    supportingFilePathLabel: 'Ruta del archivo',
    supportingFilePathPlaceholder: 'templates/review.md',
    supportingFileContent: 'Contenido del archivo',
    supportingFileTextSubtitle: 'Archivo de texto',
    supportingFileBinarySubtitle: 'Archivo binario · solo exportación',
    deleteSupportingFileTitle: '¿Eliminar archivo de apoyo?',
    deleteSupportingFileConfirm: 'Esto elimina el archivo del paquete de habilidad.',
    linkedAssetsCount: ({ count }: { count: number }) => `${count} exportación${count === 1 ? '' : 'es'}`,
    manageExternalAssets: 'Gestionar recursos externos',
    deleteLibraryItemTitle: '¿Eliminar elemento de la biblioteca?',
    deleteLibraryItemBody:
      'Esto elimina el elemento de tu biblioteca y desvincula cualquier plantilla o añadido al prompt del sistema que lo use.',
    folders: 'Carpetas',
    foldersSubtitle: 'Organiza prompts y habilidades en carpetas con nombre',
    addFolder: 'Añadir carpeta',
    addFolderSubtitle: 'Crea una carpeta reutilizable para elementos de la biblioteca',
    foldersEmptyTitle: 'Aún no hay carpetas',
    foldersEmptySubtitle: 'Crea una carpeta para organizar prompts y habilidades.',
    renameFolder: 'Renombrar carpeta',
    deleteFolderTitle: '¿Eliminar carpeta?',
    deleteFolderBody: 'Esto quitará la carpeta de los prompts y habilidades que la estén usando.',
    folderUsageCount: ({ count }: { count: number }) => `${count} elemento${count === 1 ? '' : 's'}`,
    folderLabel: 'Carpeta',
    folderPlaceholder: 'Nombre de la carpeta',
    tagsLabel: 'Etiquetas',
    tagsPlaceholder: 'tag-uno, tag-dos',
    addToStackSubtitle: 'Elige un prompt o una habilidad para añadir aquí',
    externalAssetsImportAction: 'Importar',
    externalAssetsLinkedTo: ({ title }: { title: string }) => `Vinculado a ${title}`,
    externalAssetsExportTarget: 'Destino',
    externalAssetsInstallMethod: 'Método de instalación',
    externalAssetsInstallMethodCopy: 'Copiar archivos',
    externalAssetsInstallMethodCopySubtitle: 'Escribe una copia independiente en el destino seleccionado',
    externalAssetsInstallMethodSymlink: 'Enlace simbólico (recomendado)',
    externalAssetsInstallMethodSymlinkSubtitle:
      'Vincula el destino a una copia gestionada por Happier para facilitar las actualizaciones',
    registriesAddGitSourceSubtitle: 'Añade un repositorio Git o una copia local como fuente de registro',
    registriesSourceTitleLabel: 'Título de la fuente',
    registriesSourceUrlLabel: 'URL del repositorio o ruta local',
    registriesSearchLabel: 'Buscar en el registro',
    registriesSearchPlaceholder: 'Busca habilidades (por ejemplo: design)',
    registriesItemSource: 'Repositorio fuente',
    registriesItemPath: 'Ruta del registro',
    registriesItemFiles: 'Archivos de apoyo',
    registriesItemPreview: 'Vista previa de SKILL.md',
    registriesItemPreviewUnavailable:
      'No hay una vista previa de SKILL.md disponible para este elemento del registro.',
    registriesItemImportSubtitle: 'Importa este paquete de habilidad a la biblioteca de Happier',
    registriesItemInstallAction: 'Instalar en la máquina',
    registriesItemInstallConfirmTitle: '¿Instalar elemento del registro?',
    registriesItemInstallConfirmBody:
      'Esto importa la habilidad a tu biblioteca y la instala en el destino de máquina seleccionado.',
    templateTargetPromptLabel: 'Prompt objetivo',
    templateTargetPromptPlaceholder: 'Selecciona un prompt',
    editSelectedPrompt: 'Editar el prompt seleccionado',
    editSelectedPromptDisabled: 'Selecciona primero un prompt',
    templateNameLabel: 'Nombre de la plantilla',
    templateTokenLabel: 'Comando slash',
    templatesEmptyTitle: 'Aún no hay plantillas',
    templatesEmptySubtitle: 'Crea una plantilla slash para insertar prompts rápidamente.',
    librarySearchPlaceholder: 'Buscar en la biblioteca',
  },
} as const;

const sessionHandoffTranslationExtensions = {
  es: {
    activeWarning: {
      title: 'Esta sesión sigue ejecutándose aquí',
      message: 'La transferencia detendrá esta sesión en esta máquina antes de transferirla a la máquina seleccionada.',
      confirm: 'Transferir y detener aquí',
    },
    progress: {
      title: 'Transfiriendo sesion',
      message: 'Preparando la maquina de destino y moviendo el estado de la sesion.',
      planned: 'Planificado',
      transferred: 'Transferido',
      remaining: 'Restante',
      timeline: {
        scanSource: 'Escaneando origen',
        plan: 'Planificando cambios',
        transferBlobs: 'Transfiriendo archivos',
        stageTarget: 'Preparando destino',
        apply: 'Aplicando cambios',
        importSession: 'Importando sesión',
        finalize: 'Finalizando',
      },
    },
    failure: {
      title: 'No se pudo transferir la sesion',
      message: 'No se pudo completar la transferencia. Puedes volver a intentarlo.',
    },
    recovery: {
      title: 'La sesión se detuvo aquí antes de completar la transferencia',
      messageAfterSourceStop:
        'Happier ya detuvo esta sesión en esta máquina, pero no pudo terminar de iniciarla en la máquina de destino. Reiníciala aquí o mantenla detenida mientras recuperas la máquina de destino.',
      restartOnSource: 'Reiniciar en el origen',
      keepStopped: 'Mantener detenida',
    },
  },
} as const;

const settingsSessionHandoffTranslationExtensions = {
  es: {
    title: 'Transferencia de sesion',
    groupTitle: 'Transferencia de sesion',
    groupFooter: 'Elige las opciones predeterminadas para mover una sesion entre maquinas.',
    entrySubtitle: 'Abrir valores predeterminados de transferencia',
    workspaceTransfer: {
      groupTitle: 'Transferencia del espacio de trabajo',
      groupFooter: 'Decide si la transferencia debe copiar el espacio de trabajo y como manejar los conflictos de forma predeterminada.',
      title: 'Transferir espacio de trabajo',
      enabledSubtitle: 'Copiar el espacio de trabajo a la maquina de destino de forma predeterminada.',
      disabledSubtitle: 'Mantener sin cambios el espacio de trabajo de destino de forma predeterminada.',
      strategy: {
        title: 'Estrategia de transferencia del espacio de trabajo',
        subtitle: 'Elige entre transferir una instantanea completa o sincronizar solo los cambios.',
        transferSnapshotTitle: 'Transferir instantanea',
        transferSnapshotSubtitle: 'Exporta y mueve una instantanea completa del espacio de trabajo.',
        syncChangesTitle: 'Sincronizar cambios',
        syncChangesSubtitle: 'Compara origen y destino y aplica solo los cambios unidireccionales necesarios.',
      },
    },
    conflictPolicy: {
      title: 'Politica de conflictos del espacio de trabajo',
      subtitle: 'Elige que sucede cuando la ruta de destino ya existe.',
      createSiblingCopyTitle: 'Crear copia hermana',
      createSiblingCopySubtitle: 'Conserva la ruta de destino existente y crea una copia hermana para la transferencia.',
      replaceExistingTitle: 'Reemplazar ruta existente',
      replaceExistingSubtitle: 'Reemplaza la ruta de destino existente despues de confirmar.',
    },
    includeIgnoredMode: {
      title: 'Archivos ignorados',
      subtitle: 'Elige como tratar los archivos ignorados por git durante la transferencia del espacio de trabajo.',
      excludeTitle: 'Excluir archivos ignorados',
      excludeSubtitle: 'Omitir los archivos ignorados de forma predeterminada.',
      includeSelectedTitle: 'Incluir archivos ignorados seleccionados',
      includeSelectedSubtitle: 'Copiar solo las rutas ignoradas que coincidan con los globos configurados.',
      globsTitle: 'Globos de inclusion de ignorados',
      globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
      title: 'Modo de destino para sesion directa',
      subtitle: 'Elige que debe pasar al transferir una sesion directa.',
      groupTitle: 'Transferencia de sesion directa',
      groupFooter: 'Solo se aplica cuando la sesion de origen es actualmente directa.',
      keepDirectTitle: 'Mantener directa',
      keepDirectSubtitle: 'Reanuda el destino como una sesion directa cuando el proveedor lo permita.',
      convertToPersistedTitle: 'Convertir a Happier',
      convertToPersistedSubtitle: 'Importa la transcripción y continúa como una sesión de Happier.',
    },
  },
} as const;

/**
 * Spanish plural helper function
 * Spanish has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Spanish plural rules
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
 * Spanish translations for the Happier app
 * Must match the exact structure of the English translations
 */
export const es = {
    transferRecovery: {
        title: 'Finalizar carga preparada',
        message: 'La carga llegó a la máquina, pero falta completar el guardado final. Reintenta solo la finalización o descarta la carga preparada.',
        retryFinalization: 'Reintentar finalización',
        discardStagedUpload: 'Descartar carga preparada',
        discarded: 'La carga preparada se descartó.',
        unavailable: 'Esta carga preparada ya no está disponible.',
    },
    voice: voiceReadinessTranslations.es,
    pluginPermissions: pluginPermissionTranslations.es,
    sessionRemotePermissionGrants: sessionRemotePermissionGrantTranslations.es,
    pluginSurfaces: {
        state: {
            loading: { title: 'Cargando contenido del complemento', reason: 'Se muestra el contenido disponible mientras Happier carga la última actualización.' },
            refreshing: { title: 'Actualizando contenido del complemento', reason: 'Se muestra el último contenido disponible mientras Happier busca actualizaciones.' },
            stale: { title: 'El contenido del complemento puede estar desactualizado', reason: 'Se muestra el último contenido disponible. Vuelve a intentarlo para buscar actualizaciones.' },
            offline: { title: 'El contenido del complemento está sin conexión', reason: 'Se muestra el último contenido disponible en modo de solo lectura hasta que se restablezca la conexión.' },
        },
        offlineSnapshot: {
            accessibilityLabel: ({ title }: { title: string }) =>
                `Vista sin conexión de ${title}. El contenido es de solo lectura hasta que se restablezca la conexión.`,
        },
        hostRenderer: {
            descriptorPanel: {
                accessibilityLabel: 'Panel del complemento',
                untitled: 'Panel del complemento',
            },
        },
        appPage: {
            title: 'Páginas de complementos',
            subtitle: 'Destinos de página completa aportados por los complementos instalados.',
            empty: 'No hay páginas de complemento disponibles.',
            unknown: 'Esta página de complemento no está disponible. El complemento puede estar cargándose, desactivado o desinstalado.',
        },
        appScopeRightSidebar: {
            empty: 'No hay pestañas de complemento de la aplicación disponibles.',
        },
    },
    settingsKeyboard: {
        title: 'Atajos de teclado',
        entrySubtitle: 'Descubra y controle los accesos directos a aplicaciones',
        generalGroupTitle: 'Controles de teclado',
        generalGroupFooter: 'Las preferencias de accesos directos se almacenan localmente en este dispositivo.',
        enableShortcutsTitle: 'Habilitar atajos unificados',
        enableShortcutsSubtitle: 'Utilice el nuevo registro de comandos de teclado para accesos directos a aplicaciones.',
        singleKeyTitle: 'Atajos de una sola tecla',
        singleKeySubtitle: '¿Permitir atajos como? cuando la entrada de texto no está enfocada.',
        conflictsTitle: ({ count }: { count: number }) => `${count} shortcut conflict${count === 1 ? '' : 's'} detected`,
        conflictsSubtitle: ({ count }: { count: number }) => `${count} command${count === 1 ? '' : 's'} need review before all shortcuts can be active.`,
        conflictsGroupTitle: 'Diagnóstico',
        commandsGroupTitle: 'Comandos',
        commandsGroupFooter: 'Los valores predeterminados se muestran en el registro de accesos directos. Configure un acceso directo personalizado, deshabilite un comando o restablezcalo para recuperar el enlace predeterminado.',
        noDefaultShortcut: 'Sin acceso directo predeterminado',
        setCommandButton: 'conjunto',
        setCommandAccessibility: ({ command }: { command: string }) => `Set ${command} shortcut`,
        setShortcutPromptTitle: ({ command }: { command: string }) => `Set shortcut for ${command}`,
        setShortcutPromptMessage: 'Ingrese un atajo como Alt+K, Alt+FlechaAbajo, Mod+Entrar o ?.',
        setShortcutPromptPlaceholder: 'Alt+K',
        setShortcutInvalidTitle: 'Atajo no válido',
        setShortcutInvalidMessage: 'Ingrese al menos una tecla que no sea modificadora, opcionalmente con Mod, Ctrl, Shift o Alt.',
        resetCommandAccessibility: ({ command }: { command: string }) => `Reset ${command} shortcut`,
        commands: {
            composerAbortConfirm: 'Confirmar cancelación',
            composerFocus: 'Enfocar el compositor',
            composerSendImmediate: 'Enviar de inmediato',
            composerSendPending: 'Enviar a la cola pendiente',
            commandPaletteOpen: 'Abrir paleta de comandos',
            modeCycle: 'Cambiar modo',
            shortcutsHelpOpen: 'Abrir ayuda de atajos',
            sessionNew: 'Crear nueva sesión',
            sessionMruNext: 'Siguiente sesión reciente',
            sessionMruPrevious: 'Sesión reciente anterior',
            sessionVisibleNext: 'Siguiente sesión visible',
            sessionVisiblePrevious: 'Sesión visible anterior',
            sessionsRowMoveUp: 'Mover la fila seleccionada hacia arriba',
            sessionsRowMoveDown: 'Mover la fila seleccionada hacia abajo',
            sessionsRowMoveToFolder: 'Mover la fila seleccionada a la carpeta',
            sessionsRowMoveToWorkspaceRoot: 'Mover la fila seleccionada a la raíz del espacio de trabajo',
            sessionsSelectionToggleFocused: 'Seleccionar sesión enfocada',
            sessionsSelectionExtendUp: 'Ampliar la selección de sesiones hacia arriba',
            sessionsSelectionExtendDown: 'Ampliar la selección de sesiones hacia abajo',
            sessionsSelectionSelectAll: 'Seleccionar todas las sesiones visibles',
            sessionsSelectionClear: 'Borrar selección de sesión',
            settingsOpen: 'Abrir ajustes',
            transcriptSelectionCancel: 'Cancelar selección de transcripción',
            transcriptSelectionCopy: 'Copiar mensajes de transcripción seleccionados',
            transcriptSelectionSelectAll: 'Seleccionar todos los mensajes transcritos',
            transcriptSelectionSendToSession: 'Enviar mensajes de transcripción seleccionados a la sesión',
            transcriptScrollBottom: 'Ir al final de la transcripción',
            transcriptScrollPageDown: 'Bajar una página de la transcripción',
            transcriptScrollPageUp: 'Subir una página de la transcripción',
            transcriptScrollTop: 'Ir al inicio de la transcripción',

            permissionCycle: "Modo de permiso de ciclo",
            splitCanvasCloseLeaf: "Cerrar división",
            splitCanvasFocusDown: "Enfoque dividido a continuación",
            splitCanvasFocusLeft: "Enfocar panel izquierdo",
            splitCanvasFocusRight: "Enfocar panel derecho",
            splitCanvasFocusUp: "Enfocar panel superior",
            splitCanvasRestoreMaximize: "Restaurar panel maximizado",
            splitCanvasSplitDown: "Dividir hacia abajo",
            splitCanvasSplitRight: "Dividir hacia la derecha",
            splitCanvasToggleMaximize: "Alternar maximización del panel",
            transcriptMessageNext: "Mensaje siguiente",
            transcriptMessagePrevious: "Mensaje anterior",},
    },

  tabs: {
    // Tab navigation labels
    inbox: "Bandeja",
    friends: "Amigos",
    sessions: "Sesiones",
    settings: "Configuración",

    projects: "Proyectos",},

  transcript: {


    unsupportedContent: {

      unparsedUserMessage: 'Mensaje de usuario no analizado',

      unparsedAgentMessage: 'Mensaje de asistente no analizado',

      unsupportedAgentOutput: 'Salida no compatible',

      unsupportedTranscriptRecord: 'Registro no compatible',

    },

    selection: {

      enterA11y: 'Entrar en modo de selección',

      exitA11y: 'Salir del modo de selección',

      rowA11y: ({ role, preview }: { role: string; preview: string }) => `${role}: ${preview}`,

      selectedCount: ({ count }: { count: number }) => count === 1 ? '1 message selected' : `${count} messages selected`,

      selectAll: 'Seleccionar todo',

      deselectAll: 'Deseleccionar todo',

      cancel: 'Cancelar',

      copy: 'Copiar',

      copyA11y: ({ count }: { count: number }) => count === 1 ? 'Copy 1 message' : `Copy ${count} messages`,

      send: 'Enviar',

      sendA11y: ({ count }: { count: number }) => count === 1 ? 'Send 1 message to another session' : `Send ${count} messages to another session`,

      copySuccess: 'Copiado',

      copyFailed: 'Error al copiar',

      sendTo: {

        modalTitle: 'Enviar a sesión',

        modalSubtitle: 'Añadir los mensajes seleccionados al borrador de otra sesión',

        newSession: 'Nueva sesión',

        newSessionSubtitle: 'Añadir al borrador de nueva sesión',

        searchPlaceholder: 'Search sessions...',

        noResults: 'No hay sesiones coincidentes',

        currentExcluded: 'La sesión actual no se muestra',

        preview: 'Vista previa',

        previewNote: 'Esto aparecerá en el compositor de destino',

        addNote: 'Añadir una nota (opcional)',

        addNotePlaceholder: 'Type a note to prepend...',

        send: 'Enviar',

        cancel: 'Cancelar',

        sendFailed: 'No se pudo enviar',

        sendSuccessNavigating: 'Enviado — abriendo sesión',

      },

    },

    progress: {

      catchingUp: 'Poniéndose al día…',

    },

  },


  inbox: {
    ...actionOperationInboxTranslations,
    openSession: ({ session }: { session: string }) => `Abrir sesión: ${session}`,
    // Inbox screen
    emptyTitle: "Estás al día",
    emptyDescription: "No hay solicitudes ni actualizaciones pendientes ahora mismo.",
    approvals: "Aprobaciones",
    permissions: "Permisos",
    unreadSessions: "Sesiones sin leer",
    updates: "Actividad",
  },

  approvals: {
    title: "Aprobación",
    untitled: "Aprobación sin título",
    details: "Detalles",
    fieldStatus: "Estado",
    fieldAction: "Acción",
    approve: "Aprobar",
    reject: "Rechazar",
    loadError: "No se pudo cargar la aprobación.",
    decisionError: "No se pudo actualizar la aprobación.",
    confirmApproveTitle: "¿Aprobar solicitud?",
    confirmApproveBody: "Esto ejecutará la acción solicitada.",
    confirmRejectTitle: "¿Rechazar solicitud?",
    confirmRejectBody: "Esto rechazará la solicitud.",
    proposedComments: ({ count }: { count: number }) => `${count} ${count === 1 ? "comentario propuesto" : "comentarios propuestos"}`,
    generation: ({ generation }: { generation: string }) => `Generación: ${generation}`,
    status: {
      open: "Pendiente",
      approved: "Aprobada",
      rejected: "Rechazada",
      executed: "Ejecutada",
      failed: "Fallida",
      canceled: "Cancelada",
    },
  },

  promptLibrary: {
    sections: "Secciones",
    library: "Biblioteca",
    librarySubtitle: "Gestiona prompts y habilidades",
    create: "Crear",
	    newPrompt: "Nuevo prompt",
	    templates: "Plantillas",
	    templatesSubtitle: "Crea y gestiona plantillas /slash",
	    newTemplate: "Nueva plantilla",
	    newSkill: "Nueva habilidad",
    prompts: "Indicaciones",
    skills: "Habilidades",
    untitledPrompt: "Prompt sin título",
    untitledSkill: "Habilidad sin título",
    origin: "Origen",
    schema: "Esquema",
    editPrompt: "Editar prompt",
    editSkill: "Editar habilidad",
    titlePlaceholder: "Título",
	    saveError: "No se pudo guardar.",
	    stacks: "Pilas",
	    stacksSubtitle: "Adjunta prompts y habilidades a sesiones y perfiles",
        externalAssets: "Recursos externos",
        externalAssetsSubtitle: "Importa habilidades y recursos de prompts desde máquinas conectadas",
        externalAssetsContext: "Contexto de descubrimiento",
        externalAssetsMachine: "Máquina",
        externalAssetsScope: "Ámbito",
        externalAssetsProjectScope: "Proyecto",
        externalAssetsProjectScopeSubtitle: "Descubre recursos dentro de la ruta de un espacio de trabajo",
        externalAssetsUserScope: "Usuario",
        externalAssetsUserScopeSubtitle: "Descubre recursos en carpetas de nivel de usuario",
        externalAssetsProjectDirectory: "Directorio del proyecto",
        externalAssetsProjectDirectoryRequired: "Elige un directorio del proyecto antes de importar o exportar recursos con ámbito de proyecto.",
        externalAssetsRefresh: "Actualizar recursos externos",
        externalAssetsRefreshSubtitle: "Descubre recursos de prompts para la máquina y el ámbito seleccionados",
        externalAssetsTypes: "Tipos de recursos",
        externalAssetsNoMachine: "Selecciona una máquina para continuar.",
        externalAssetsNoTypes: "No hay tipos de recursos externos",
        externalAssetsNoTypesSubtitle: "Esta máquina aún no expone adaptadores de recursos de prompts.",
        externalAssetsNoItems: "No se encontraron recursos externos",
        externalAssetsNoItemsSubtitle: "Actualiza después de elegir una máquina, un ámbito o un directorio.",
        externalAssetsUnsupportedImport: "Aquí solo se pueden importar recursos de prompts basados en bundles.",
        externalAssetsExportTitle: "Exportar recurso externo",
        externalAssetsExportOptions: "Opciones de exportación",
        externalAssetsExportType: "Tipo de recurso",
        externalAssetsExportAction: "Exportar",
        externalAssetsExportConfirmTitle: "¿Exportar recurso externo?",
        externalAssetsExportConfirmBody: "Esto escribirá el recurso de prompt seleccionado en la ubicación externa.",
        externalAssetsExportTargetPathPlaceholder: "Ruta de destino (p. ej., review/code.md)",
        externalAssetsExportTargetNamePlaceholder: "Nombre de destino (p. ej., reviewer)",
        externalAssetsDeleteConfirmTitle: "¿Eliminar recurso externo?",
        externalAssetsDeleteConfirmBody: "Esto eliminará del disco el recurso externo vinculado.",
        externalAssetsLinkedTitle: "Recurso externo vinculado",
        registries: "Registros",
        registriesSubtitle: "Explora registros de habilidades e importa bundles a la biblioteca",
        registriesContext: "Contexto del registro",
        registriesNoMachine: "Selecciona una máquina para continuar.",
        registriesRefresh: "Actualizar registros",
        registriesRefreshSubtitle: "Carga las fuentes de registro integradas y configuradas para la máquina seleccionada",
        registriesAddGitSource: "Agregar fuente Git",
        registriesAddGitSourceAction: "Guardar fuente Git",
        registriesAddGitSourceActionSubtitle: "Guardar este repositorio como fuente de registro",
        registriesAddGitSourceError: "Agrega tanto un título como una URL del repositorio.",
        registriesSourceTitlePlaceholder: "Título de la fuente",
        registriesSourceUrlPlaceholder: "URL del repositorio o ruta local",
        registriesSources: "Fuentes",
        registriesNoSources: "No se cargaron fuentes de registro",
        registriesNoSourcesSubtitle: "Agrega una fuente Git o actualiza para cargar las fuentes integradas.",
        registriesItems: "Elementos del registro",
        registriesNoItems: "No hay elementos del registro",
        registriesNoItemsSubtitle: "Selecciona una fuente para escanear las habilidades disponibles.",
	    editTemplate: "Editar plantilla",
    tokenPlaceholder: "Token (p. ej. /daily)",
    codingStack: "Pila de código",
    codingStackSubtitle: "Se aplica a las sesiones de código",
    voiceStack: "Pila de voz",
    voiceStackSubtitle: "Se aplica a Happier Voice",
    profileStacks: "Pilas de perfil",
    profileStacksSubtitle: ({ count }: { count: number }) => `${count} perfil${count === 1 ? "" : "es"}`,
    profileStackCount: ({ count }: { count: number }) => `${count} elemento${count === 1 ? "" : "s"}`,
    noProfilesTitle: "Sin perfiles",
    noProfilesSubtitle: "Crea un perfil para usar pilas de perfil.",
    stackEntries: "Elementos de la pila",
    stackPlacementSkill: "Instrucciones de habilidad",
    stackPlacementComposer: "Inserción en el compositor",
    stackPlacementSystem: "Añadir al sistema",
    stackEmptyTitle: "Nada en esta pila",
    stackEmptySubtitle: "Añade prompts o habilidades para empezar.",
    actions: "Acciones",
    addToStack: "Añadir a la pila",
    stackAlreadyContainsPrompt: "Esta pila ya contiene ese elemento.",
    stackPickerNoPrompts: "Aún no hay prompts.",
    stackPickerNoSkills: "Aún no hay habilidades.",
    removeFromStack: "¿Quitar de la pila?",
    removeFromStackConfirm: "Esto quitará el elemento de la pila.",
    deleteTemplate: "¿Eliminar plantilla?",
    deleteTemplateConfirm: "Esto eliminará la plantilla.",
    templateTokenReserved: "Ese token está reservado.",
    templateTokenConflictsWithAction: "Ese token entra en conflicto con una acción integrada.",
    templateTokenDuplicate: "Ese token ya está en uso.",
    templateTarget: "Prompt objetivo",
    templateBehavior: "Comportamiento",
    templateBehaviorInsert: "Insertar",
    templateBehaviorInsertOnSend: "Insertar al enviar",
    templateBehaviorInsertAndSend: "Insertar y enviar",
    templateAllowArgs: "Permitir argumentos",
    templateAllowArgsSubtitle: "Si está habilitado, el texto extra tras el token se pasa como $args.",
        ...promptLibraryUxRefinementTranslationExtension.es,
  },

  runs: {
    title: "Ejecuciones",
    empty: "Aún no hay ejecuciones.",
    groupLabel: ({ groupId }: { groupId: string }) => `Grupo ${groupId}`,
    showFinished: "Mostrar finalizadas",
    unknownMachine: "Máquina desconocida",
    failedToLoad: "No se pudieron cargar las ejecuciones",
    noMachinesAvailable: "No hay máquinas disponibles.",
    serverTitle: ({ serverId }: { serverId: string }) => `Servidor ${serverId}`,
    machinesSubtitle: "Máquinas",
    openMachine: "Abrir máquina",
    a11y: {
      toggleFinished: "Alternar ejecuciones finalizadas",
      refresh: "Actualizar ejecuciones",
    },
    openSession: "Abrir sesión",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `Sesión ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `ejecución ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `pid ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "No se pudo cargar la ejecución",
      latestToolResultTitle: "Último resultado de la herramienta",
      a11y: {
        refreshRun: "Actualizar ejecución",
      },
    },
    stop: {
      stopRunA11y: "Detener ejecución",
      stopLabel: "Detener ejecución",
      stoppingLabel: "Deteniendo…",
      stopRunFailedTitle: "No se pudo detener la ejecución",
      stopRunFailedBody:
        "Detener esta ejecución mediante RPC de la sesión falló. ¿Quieres detener el proceso completo de la sesión? Esto es destructivo y detendrá todas las ejecuciones de esa sesión.",
      stopSession: "Detener sesión",
      failedToStopRun: "No se pudo detener la ejecución",
      failedToStopSession: "No se pudo detener la sesión",
    },
    send: {
      placeholder: "Enviar a la ejecución…",
      a11y: {
        sendToRun: "Enviar a la ejecución",
      },
      sendLabel: "Enviar",
      sendingLabel: "Enviando…",
      failedToSend: "No se pudo enviar",
    },
    delivery: {
      title: "Entrega",
      cardDelivery: ({ label }: { label: string }) => `Entrega: ${label}`,
      steerLabel: "Guiar",
      steerHelp:
        "Envía un mensaje de dirección mientras la ejecución está ocupada (si es compatible).",
      interruptLabel: "Interrumpir",
      interruptHelp:
        "Cancela el turno actual y luego envía tu mensaje como un turno nuevo.",
      promptLabel: "Instrucción",
    },
  },

  sessionLog: {
    title: "Registro de sesión",
    devModeRequiredTitle: "Se requiere el modo desarrollador",
    devModeRequiredBody:
      "Activa el modo desarrollador en la configuración para ver los registros de sesión.",
    logPathTitle: "Ruta del registro",
    unavailable: "No disponible",
    logPathCopyLabel: "Ruta del registro de sesión",
    refreshTailTitle: "Actualizar final del registro",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `Leer los últimos ${maxBytes} bytes`,
    copyVisibleTitle: "Copiar registro visible",
    copyVisibleSubtitleLoaded:
      "Copiar el fragmento actual al portapapeles",
    copyVisibleSubtitleEmpty: "No hay contenido de registro cargado",
    copyLogLabel: "Registro de sesión",
    statusTitle: "Estado del registro",
    readErrorTitle: "Error de lectura",
    tailTitle: "Final del registro",
    tailTitleTruncated: "Final del registro (truncado)",
    noOutputYet: "(Aún no hay salida de registro)",
    readFailed: "No se pudo leer el registro de la sesión",
  },

  automations: {
    unsupportedReference: ({ reference }: { reference: string }) =>
        `Las automatizaciones solo guardan el texto del mensaje, así que ${reference} ya no apuntaría a lo que elegiste. Quítala del mensaje o menciona una ruta de archivo en su lugar.`,
    openA11y: "Abrir automatizaciones",
    list: {
      interval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Cada ${minutes} min${timezone ? ` (${timezone})` : ""}`,
      cron: ({ expression, timezone }: { expression: string | null; timezone: string | null }) => `Cron${expression ? `: ${expression}` : ""}${timezone ? ` (${timezone})` : ""}`,
      schedule: "Programación",
      event: ({ eventId }: { eventId: string }) => `Evento: ${eventId}`,
      manual: "manuales",
      conversationTrigger: "Disparador de conversación",
      noNextRun: "Sin próxima ejecución",
      nextRun: ({ time }: { time: string }) => `Próxima: ${time}`,
      nextRunPending: "Próxima ejecución pendiente",
    },
    gate: {
      disabledTitle: "Las automatizaciones están desactivadas",
      disabledBody:
        "Actívalas en Ajustes y luego activa Experimentos y Automatizaciones.",
    },
    edit: {
      title: "Editar automatización",
      saveAutomationLabel: "Guardar automatización",
      messageLabel: "MENSAJE",
      messagePlaceholder: "Mensaje para enviar",
      messageHelpText:
        "Este mensaje se pondrá en cola en la sesión como un mensaje de usuario pendiente.",
      updateFailed: "No se pudo actualizar la automatización.",
      loadTemplateFailed: "No se pudo cargar la plantilla de automatización.",
    },
    form: {
      groupAutomationTitle: "Automatización",
      groupScheduleTitle: "Programación",
      toggleEnableTitle: "Habilitar automatización",
      toggleEnableSubtitle:
        "Crea esta nueva plantilla de sesión como una automatización programada en lugar de iniciar inmediatamente.",
      toggleEnabledTitle: "Habilitada",
      toggleEnabledSubtitle:
        "Cuando está deshabilitada, no se ejecutarán las ejecuciones programadas.",
      labels: {
        name: "NOMBRE",
        descriptionOptional: "DESCRIPCIÓN (OPCIONAL)",
        everyMinutes: "CADA (MINUTOS)",
        cronExpression: "EXPRESIÓN CRON",
        timezoneOptional: "ZONA HORARIA (OPCIONAL)",
      },
      placeholders: {
        name: "Resumir la actividad reciente",
        description: "Notas para ti",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC o America/New_York",
      },
      schedule: {
        intervalTitle: "Intervalo",
        intervalSubtitle: "Ejecutar cada N minutos.",
        cronTitle: "Expresión cron",
        cronSubtitle: "Expresión de programación avanzada.",
        cronHelpText:
          "Cron estándar de 5 campos: minuto hora día-del-mes mes día-de-la-semana.",
      },
      sentence: {
        run: "Ejecutar",
        every: "cada",
        onSchedule: "según programación",
        runEvery: "Ejecutar cada",
        minutes: "minutos",
        presets: "Preajustes",
        intervalUnits: {
          minutes: "Minutos",
          hours: "Horas",
          days: "Días",
        },
        cronFieldGuide: {
          minute: "Minuto",
          hour: "Hora",
          dayOfMonth: "Día",
          month: "Mes",
          weekday: "Semana",
        },
        useCron: "Usar expresión cron",
        useInterval: "Cambiar a intervalo",
        addNotes: "Añadir notas",
        notes: "NOTAS",
        localTimezone: "hora local",
        scheduleControlA11y: "Editar programación de la automatización",
        intervalValue: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} día${minutes === 24 * 60 ? "" : "s"}`;
          if (minutes === 60) return "1 hora";
          if (minutes % 60 === 0) return `${minutes / 60} horas`;
          return `${minutes} minuto${minutes === 1 ? "" : "s"}`;
        },
        intervalCadence: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `cada ${minutes / (24 * 60)} día${minutes === 24 * 60 ? "" : "s"}`;
          if (minutes === 60) return "cada hora";
          if (minutes % 60 === 0) return `cada ${minutes / 60} horas`;
          return `cada ${minutes} minuto${minutes === 1 ? "" : "s"}`;
        },
        cronPresets: {
          weekdays9am: "Días laborables a las 9:00",
          hourly: "Cada hora",
          monday9am: "Lunes a las 9:00",
          dailyMidnight: "Cada día a medianoche",
        },
        cronCadences: {
          weekdays9am: "los días laborables a las 9:00",
          hourly: "cada hora",
          monday9am: "los lunes a las 9:00",
          dailyMidnight: "cada día a medianoche",
        },
        cronCadenceExpression: ({ expression }: { expression: string }) => `con programación cron ${expression}`,
        timezone: ({ timezone }: { timezone: string }) => `Zona horaria: ${timezone}`,
      },
    },
    session: {
      emptyTitle: "Sin automatizaciones",
      emptyBody:
        "Añade una automatización para poner en cola mensajes programados en esta sesión.",
      addAutomation: "Añadir automatización",
      failedToLoad: "No se pudieron cargar las automatizaciones.",
    },
    screen: {
      emptyTitle: "Aún no hay automatizaciones",
      emptyBody:
        "Crea una desde el flujo de Nueva sesión para ejecutar sesiones programadas en tus máquinas.",
      createAutomationA11y: "Crear automatización",
    },
    detail: {
      invalidId: "ID de automatización no válido.",
      notFound: "No se encontró la automatización.",
      unknownDate: "Desconocido",
      notScheduled: "No programada",
      overviewGroupTitle: "Resumen",
      overview: {
        nameTitle: "Nombre",
        scheduleTitle: "Programación",
        statusTitle: "Estado",
        nextRunTitle: "Próxima ejecución",
      },
      status: {
        active: "Activa",
        paused: "Pausada",
      },
      event: {
        watcherTitle: "Observador de eventos",
        watcherUnwatched: "Sin observador",
        endpointTitle: "Punto final de webhook",
        endpointObservingSince: ({ time }: { time: string }) => `Recibiendo entregas desde ${time}`,
        sourceStatusUnreported: "Esperando el primer informe",
        sourceCatalogStatusUnavailable: "Actualidad de la fuente no disponible",
        watcherMachineUnknown: "Esta máquina ya no está en tu cuenta, así que este observador no puede observar eventos.",
        watcherMachineRevoked: "Esta máquina fue revocada, así que este observador no puede observar eventos.",
        watcherMachineReplaced: "Esta máquina fue reemplazada, así que este observador no puede observar eventos.",
        watcherInstallationReplaced: "Esta máquina se reinstaló, así que este observador no podrá observar eventos hasta que se configure de nuevo.",
        watcherMachineOffline: "Esta máquina está sin conexión, así que este observador no está observando eventos ahora mismo.",
      },
      actionsGroupTitle: "Acciones",
      runNowTitle: "Ejecutar ahora",
      runNowQueuedBadge: "En cola",
      runNowQueuedLine: "En cola.",
      runNowQueuedSubtitle:
        "En cola. El daemon asignado la ejecutará cuando esté disponible.",
      pauseAutomation: "Pausar automatización",
      resumeAutomation: "Reanudar automatización",
      editAutomation: "Editar automatización",
      deleteAutomation: "Eliminar automatización",
      deleteConfirmTitle: "Eliminar automatización",
      deleteConfirmMessage: "Esta automatización y su programación se eliminarán.",
      deleteConfirmButton: "Eliminar",
      machineAssignmentsTitle: "Asignaciones de máquina",
      machineAssignmentsFooter:
        "Habilita al menos una máquina para que esta automatización se ejecute.",
      refreshFailed: "No se pudo actualizar la automatización.",
      runFailed: "No se pudo ejecutar la automatización.",
      deleteFailed: "No se pudo eliminar la automatización.",
      assignmentsUpdateFailed:
        "No se pudieron actualizar las asignaciones de máquina.",
      recentRunsTitle: "Ejecuciones recientes",
      loadMoreRuns: "Cargar más ejecuciones",
      runMeta: {
        originTitle: "Origen",
        origin: {
          scheduled: "Programada",
          manual: "manuales",
          pluginEvent: "Evento",
          conversation: "Conversación",
        },
        state: {
          queued: "En cola",
          claimed: "Reclamada",
          running: "En curso",
          succeeded: "Correcta",
          failed: "Fallida",
          cancelled: "Cancelada",
          expired: "Caducada",
          dispatch_failed: "Envío fallido",
          skipped: "Omitida",
          missed: "Perdida",
          outcome_uncertain: "Resultado incierto",
        },
        occurred: ({ time }: { time: string }) => `Ocurrió: ${time}`,
        invoked: ({ time }: { time: string }) => `Invocada: ${time}`,
        admitted: ({ time }: { time: string }) => `Admitida: ${time}`,
        occurrenceTitle: "Ocurrencia",
        sourceTitle: "Fuente de observación",
        scheduled: ({ time }: { time: string }) => `Programada: ${time}`,
        updated: ({ time }: { time: string }) => `Actualizada: ${time}`,
        error: ({ message }: { message: string }) => `Error: ${message}`,
        attemptTitle: "Intento",
        attempt: ({ attempt }: { attempt: number }) => `Intento ${attempt}`,
        claimedByTitle: "Asignado a",
        claimedAt: ({ time }: { time: string }) => `Asignado: ${time}`,
        leaseExpires: ({ time }: { time: string }) => `La asignación caduca: ${time}`,
        dispatchTitle: "Envío de ejecución",
        dispatchAttempt: ({ attempt }: { attempt: number }) => `Intento de envío ${attempt}`,
        dispatchState: {
            notStarted: "Sin iniciar",
            dispatchPermitted: "Envío permitido",
            retryWaiting: "Esperando para reintentar",
            started: "Iniciado",
            settled: "Resuelto",
            outcomeUnknown: "Resultado desconocido",
        },
        replyHandoffTitle: "Entrega de respuesta",
        replyHandoffAttempt: ({ attempt }: { attempt: number }) => `Intento de entrega ${attempt}`,
        replyHandoffDue: ({ time }: { time: string }) => `Próximo intento de entrega: ${time}`,
        replyHandoffState: {
            none: "Ninguna",
            awaitingResult: "Esperando el resultado",
            ready: "Lista",
            handingOff: "Entregando",
            accepted: "Aceptada",
            suppressed: "Suprimida",
            blocked: "Bloqueada",
        },
        nativeExecutionTitle: "Ejecución nativa",
        nativeExecutionCall: ({ callId }: { callId: string }) => `Llamada ${callId}`,
        nativeExecutionSidechain: ({ sidechainId }: { sidechainId: string }) => `Sidechain ${sidechainId}`,
        historyTitle: "Qué ocurrió",
        historyEvent: {
            run_started: "Iniciada",
            run_succeeded: "Completada",
            run_failed: "Fallida",
            run_cancelled: "Cancelada",
            run_outcome_uncertain: "El resultado pasó a ser incierto",
            execution_dispatch_retry_scheduled: "Reintento de envío programado",
            unknown: "Cambio de ciclo de vida",
        },
        historyReason: {
            cancelled_after_dispatch_permitted: "Cancelada después de que la ejecución externa ya estuviera autorizada",
            dispatch_result_missing_after_lease_expiry: "La máquina que la reclamó nunca informó del resultado del envío",
            automation_retired_after_lease_expiry: "La automatización se retiró mientras expiraba su reclamación",
        },
      },
      runDetail: {
        title: "Detalles admitidos",
        recipe: "Receta admitida",
        recipeAbsent: "No se registraron detalles privados admitidos.",
        templateVersion: "Versión de plantilla",
        event: "Evento",
        conversation: "Conversación",
        sourceInstance: "Instancia de origen",
        filter: "Filtro",
        filterMatched: "Coincide",
        payload: "Carga útil",
        input: "Entrada",
        target: "Destino congelado",
        outputCeiling: "Límite de salida",
        existingSession: ({ sessionId }: { sessionId: string }) => `Sesión existente: ${sessionId}`,
        newSession: ({ machineId, directory }: { machineId: string; directory: string }) => `Nueva sesión en ${machineId}: ${directory}`,
        executionRun: ({ permissionMode }: { permissionMode: string }) => `Ejecución · ${permissionMode}`,
        prompt: "Mensaje congelado",
        result: "Resultado final",
        resultAbsent: "No se registró ningún resultado final.",
        failureDetail: "Detalles del error",
        failureDetailAbsent: "No se registró ningún detalle privado del error.",
        predecessorSummary: "Hay un resumen predecesor, pero no se puede leer en este detalle.",
        currentnessUnavailable: "Los detalles privados de la ejecución no están disponibles temporalmente mientras cambia el cifrado de la cuenta.",
        materialUnavailable: "Este dispositivo no tiene la clave de cifrado actual de la cuenta.",
        modeMismatch: "Los detalles privados guardados usan un modo de cifrado de cuenta distinto.",
        contentInvalid: "Los detalles privados guardados no son válidos.",
        invalidTemplate: "La plantilla admitida no es válida. Esta ejecución no se enviará ni se reintentará.",
        outcomeUnknown: "Se desconoce el resultado del envío. Happier no volverá a enviar el destino congelado.",
      },
    },
    create: {
      defaultName: "Mensaje programado",
      createFailed: "No se pudo crear la automatización.",
      unavailableGroupTitle: "No disponible",
      cannotCreateForSession: "No se puede crear una automatización para esta sesión",
      sessionNotFound: "No se encontró la sesión.",
      missingMachineId: "A esta sesión le falta un ID de máquina.",
      missingResumeKey:
        "Esta sesión aún no tiene cargada una clave de cifrado de reanudación.",
      createButtonTitle: "Crear automatización",
    },
  },

  appCrash: {
    title: "Algo salió mal",
    subtitle:
      "Happier tuvo un error inesperado. Puedes reiniciar la interfaz de la app o copiar los detalles para soporte.",
    detailsTitle: "Detalles del error",
    restart: "Reiniciar app",
    restartAndReportIssue: "Reiniciar y abrir informe de error",
    copyDetails: "Copiar detalles del error",
  },

  webCryptoGate: {
    title: "Se requiere una conexión segura",
    subtitle:
      "Esta página necesita WebCrypto para mantener tus datos seguros. WebCrypto no está disponible en este origen porque los navegadores requieren un contexto seguro.",
    howToFix: "Cómo solucionarlo",
    fixHttps: "Abre la UI con HTTPS (recomendado).",
    fixTunnel:
      "Si necesitas acceso por LAN, usa un túnel HTTPS o un proxy inverso con TLS.",
    fixLocalhost:
      "Si estás en la misma máquina, usa http://localhost (el loopback se trata como seguro).",
    currentOrigin: "Origen actual",
    secureContext: "Contexto seguro",
    copyDetails: "Copiar detalles",
    reload: "Recargar",
  },

  common: {
    // Simple string constants
    add: "Añadir",
    edit: "Editar",
    duplicate: "Duplicar",
    actions: "Acciones",
    moreActions: "Más acciones",
    moreActionsHint: "Abre un menú con más acciones",
    destructiveActionHint: "Esta acción es destructiva y no se puede deshacer.",
    cancel: "Cancelar",
    decline: "Rechazar",
    submit: "Enviar",
    close: "Cerrar",
    dismissKeyboard: 'Ocultar teclado',
      open: "Abrir",
      done: "Hecho",
      reorder: "Reordenar",
      moveUp: "Mover arriba",
      moveDown: "Mover abajo",
      authenticate: "Autenticar",
      save: "Guardar",
    saveAs: "Guardar como",
		    error: "Error",
		    success: "Éxito",
		    warning: "Advertencia",
		    info: "Información",
		    comingSoon: "Próximamente",
		    ok: "OK",
		    continue: "Continuar",
		    back: "Atrás",
        previous: "Anterior",
        next: "Siguiente",
	    start: "Iniciar",
	    run: "Ejecutar",
	    create: "Crear",
    rename: "Renombrar",
    remove: "Eliminar",
    update: "Actualizar",
    commit: "Confirmar",
    history: "Historial",
    applied: "Aplicado",
    signOut: "Cerrar sesión",
    keep: "Conservar",
    use: "Usar",
    reset: "Restablecer",
    logout: "Cerrar sesión",
    yes: "Sí",
    no: "No",
    on: "Activado",
    off: "Desactivado",
    discard: "Descartar",
    discardChanges: "Descartar cambios",
    unsavedChangesWarning: "Tienes cambios sin guardar.",
    keepEditing: "Seguir editando",
    version: "Versión",
    details: "Detalles",
    copied: "Copiado",
    copy: "Copiar",
    copyWithLabel: ({ label }: { label: string }) => `Copiar ${label}`,
    paste: "Pegar",
    pasteImage: "Pegar imagen",
    expand: "Expandir",
    collapse: "Colapsar",
    command: "Comando",
    scanning: "Escaneando...",
    urlPlaceholder: "https://ejemplo.com",
    home: "Inicio",
    message: "Mensaje",
    send: "Enviar",
    attach: "Adjuntar",
    addImage: "Agregar imagen",
    addFile: "Agregar archivo",
    linkFile: "Vincular archivo",
    files: "Archivos",
    path: "Ruta",
    fileViewer: "Visor de archivos",
    loading: "Cargando...",
    none: "—",
    notProvided: "No proporcionado",
    unavailable: "No disponible",
    dialog: "Diálogo",
    retry: "Reintentar",
    or: "o",
    delete: "Eliminar",
    deleted: "Eliminado",
    optional: "opcional",
    noMatches: "Sin coincidencias",
    all: "Todo",
    machine: "máquina",
    clearSearch: "Limpiar búsqueda",
    refresh: "Actualizar",
    default: "Predeterminado",
    enabled: "Habilitado",
    disabled: "Deshabilitado",
    requestFailed: "La solicitud falló.",

    more: "Más",
    skip: "Omitir",
    maximize: "Maximizar",
    restore: "Restaurar",
    name: "Nombre",
    blocked: "Bloqueado",
    active: "Activo",
    inactive: "Inactivo",
    running: "En ejecución…",
    login: "Iniciar sesión",
    install: "Instalar",
    enable: "Activar",
    disable: "Desactivar",
    tabs: "Pestañas",
    logs: "Registros",
    share: "Compartir",
    unreachable: "Inalcanzable",},

  ui: {
    resizableDockedPane: {
      resizeA11y: "Redimensionar panel",
      resizeHint: "Usa las flechas del teclado o las acciones de ajuste para redimensionar",
    },
    modalPane: {
      right: "Barra lateral derecha",
      details: "Panel de detalles",
      bottom: "Panel inferior",
      dismiss: ({ pane }: { pane: string }) => `Cerrar ${pane}`,
    },
    pluginUi: {
      loading: "Cargando",
      empty: "Nada que mostrar",
      error: "Algo salió mal",
      moreActions: "Más acciones",
    },
  },

  dropdown: {
    category: {
      general: "Generales",
      results: "Resultados",
    },
    createItem: {
      prefix: "Agregar",
    },
  },

  profile: {
    userProfile: "Perfil de usuario",
    details: "Detalles",
    firstName: "Nombre",
    lastName: "Apellido",
    username: "Nombre de usuario",
    status: "Estado",
  },

  status: {
    connected: "conectado",
    connecting: "conectando",
    disconnected: "desconectado",
    error: "error",
    online: "en línea",
    working: "trabajando...",
    workingRetained: "trabajando, esperando actualizaciones…",
        backgroundActive: 'trabajando en segundo plano',
        workingExternally: 'Trabajando externamente',
        needsInputExternally: 'Necesita entrada externa',
        retryingExternally: 'Reintentando externamente',
        ready: 'Listo',
        recentlyActive: 'Activo recientemente',
        externalStatusUnknown: 'Estado externo desconocido',
    readyForReview: "listo para revisión",
    keptInAttention: "mantenida en atención",
    canceled: "Cancelado",
    offline: "desconectado",
    lastSeen: ({ time }: { time: string }) => `visto por última vez ${time}`,
    actionRequired: "acción requerida",
    waitingForYourResponse: "Esperando tu respuesta",
    permissionRequired: "permiso requerido",
    activeNow: "Activo ahora",
    unknown: "desconocido",
  },

  connectionStatus: {
    title: "Conexión",
    labels: {
      server: "Servidor",
      socket: "WebSocket",
      authenticated: "Autenticado",
      lastSync: "Última sincronización",
      nextRetry: "Próximo reintento",
      lastError: "Último error",
    },
  },

  time: {
    justNow: "ahora mismo",
    minutesAgo: ({ count }: { count: number }) =>
      `hace ${count} minuto${count !== 1 ? "s" : ""}`,
    hoursAgo: ({ count }: { count: number }) =>
      `hace ${count} hora${count !== 1 ? "s" : ""}`,
    nowShort: "ahora",
    minutesAgoShort: ({ count }: { count: number }) => `hace ${count}m`,
    hoursAgoShort: ({ count }: { count: number }) => `hace ${count}h`,
    daysAgoShort: ({ count }: { count: number }) => `hace ${count}d`,
  },
  commandMenu: {
    empty: 'Sin resultados',
  },


  selectionList: {
    emptyMatch: "Sin coincidencias",
    clearInput: "Borrar",
    backTo: ({ label }: { label: string }) => `Volver a ${label}`,
    dynamicSectionError: "Algo salió mal",
    pathNotFound: "Ruta no encontrada",
    backShortcut: "atrás",
  },

  connect: {
    restoreAccount: "Restaurar cuenta",
    enterSecretKey: "Ingresa tu clave secreta",
    invalidSecretKey: "Clave secreta inválida. Verifica e intenta de nuevo.",
    enterUrlManually: "Ingresar URL manualmente",
    scanComputerQrUnavailableTitle: "Escaneo de QR del ordenador no disponible",
    scanComputerQrUnavailableBody:
      "Este método de inicio de sesión está deshabilitado en este servidor. Usa otra opción a continuación para restaurar tu cuenta.",
    scanComputerQrInstructions: "Escanea el código QR que se muestra en Happier en tu computadora (Configuración → Añade tu teléfono).",
    scanComputerQrButton: "Escanear QR para iniciar sesión",
    waitingForApproval: "Esperando aprobación…",
    showQrInstead: "Mostrar un código QR en su lugar",
    addPhoneQrInstructions: "Escanea este código QR con la app móvil de Happier para iniciar sesión en tu teléfono.",
    serverUrlNotEmbeddedTitle: "Configura el servidor en tu teléfono",
    serverUrlNotEmbeddedBody:
      "Este código QR no puede incluir la dirección del servidor porque está configurada como localhost. En tu teléfono, ve a Configuración → Servidores y agrega una URL a la que el teléfono pueda acceder (IP de la LAN o Tailscale) y luego vuelve a escanear.",
    pairingRequestTitle: "Solicitud de vinculación",
    pairingRequestBody: "Verifica que este código coincida con el que ves en tu teléfono y luego aprueba.",
    pairingAlreadyRequestedTitle: "Código ya usado",
    pairingAlreadyRequestedBody:
      "Este código QR ya se escaneó en otro teléfono. Pide a la computadora que genere uno nuevo.",
    deviceLabel: "Dispositivo",
    confirmCodeLabel: "Código de confirmación",
    approveButton: "Aprobar",
    generateNewQrCode: "Generar nuevo código QR",
    pairingQrExpired: "Este código QR ha caducado. Genera uno nuevo.",
    openMachine: "Abrir máquina",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "En un dispositivo que ya haya iniciado sesión, ve a Configuración → Cuenta y escanea este código QR.",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} verificado`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `Encontramos una cuenta existente de Happier vinculada a ${provider}. Para terminar de iniciar sesión en este dispositivo, restaura tu clave de cuenta con el código QR o tu clave secreta.`,
    restoreWithSecretKeyInstead: "Restaurar con clave secreta",
    restoreWithSecretKeyDescription:
      "Ingresa tu clave secreta para recuperar el acceso a tu cuenta.",
    lostAccessLink: "¿Sin acceso?",
    lostAccessTitle: "¿Perdiste el acceso a tu cuenta?",
    lostAccessBody:
      "Si ya no tienes ningún dispositivo vinculado a esta cuenta y perdiste tu clave secreta, puedes restablecer tu cuenta con tu proveedor de identidad. Esto crea una nueva cuenta de Happier. No se puede recuperar tu historial cifrado anterior.",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `Continuar con ${provider}`,
    lostAccessConfirmTitle: "¿Restablecer cuenta?",
    lostAccessConfirmBody:
      "Esto creará una nueva cuenta y volverá a vincular tu identidad del proveedor. No se puede recuperar tu historial cifrado anterior.",
    lostAccessConfirmButton: "Restablecer y continuar",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    secretKeyInputLabel: "Clave secreta",
    linkNewDeviceTitle: "Vincular Nuevo Dispositivo",
    linkNewDeviceSubtitle: "Escanea el código QR que se muestra en tu nuevo dispositivo para vincularlo a esta cuenta",
    linkNewDeviceQrInstructions: "Abre Happier en tu nuevo dispositivo y muestra el código QR",
    scanQrCodeOnDevice: "Escanear Código QR",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Conectar ${name}`,
      runCommandInTerminal: "Ejecuta el siguiente comando en tu terminal:",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `Ejecuta el siguiente comando en tu terminal:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "Vista previa no disponible",
        previewUnavailableBody: "No se pudo generar la vista previa de diagnósticos.",
        submittedTitle: "Informe de error enviado",
        submittedExistingIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `Se publicó un comentario en el issue #${issueNumber}.\n\nID del informe: ${reportId}`,
        submittedNewIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `Se creó el issue #${issueNumber}.\n\nID del informe: ${reportId}`,
        submitFailedTitle: "El envío falló",
        submitFailedFallbackMessage: "No se pudo enviar este informe.",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\n¿Quieres abrir un issue de GitHub prellenado en su lugar?`,
        openFallbackIssueButton: "Abrir issue alternativa",
      },
      diagnostics: {
        title: "Diagnóstico",
        subtitle: "Elige qué incluir y revisa antes de enviar.",
        includeTitle: "Incluir diagnóstico",
        includeSubtitle:
          "Adjunta artefactos de depuración saneados para acelerar el diagnóstico.",
        disabledByServerSuffix: " (deshabilitado por el servidor)",
        pasteDoctorJson: {
          title: "CLI doctor JSON (opcional)",
          subtitle:
            "Si tu máquina no es accesible desde la UI, ejecuta happier doctor --json en tu ordenador y pégalo aquí.",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `Doctor JSON inválido: ${error}`,
          valid: "El doctor JSON parece válido y se adjuntará al reporte.",
        },
        previewButton: "Previsualizar diagnóstico",
        preview: {
          title: "Vista previa de diagnósticos",
          helper:
            "Estos artefactos se cargarán con tu informe (sanitizados y con tamaño limitado). Toca un elemento para ver su contenido completo.",
          empty: "No se enviaría ningún artefacto de diagnóstico.",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `Abrir ${filename}`,
        },
        kinds: {
          app: {
            title: "Diagnóstico de la app",
            detail:
              "Logs de la app, acciones recientes del usuario y resumen de la sesión.",
          },
          daemon: {
            title: "Diagnóstico del daemon",
            detail:
              "Resumen del daemon y logs recientes del daemon de las máquinas seleccionadas.",
          },
          stackService: {
            title: "Diagnóstico del servicio Stack",
            detail:
              "Contexto del stack y logs recientes del stack (si están disponibles).",
          },
          server: {
            title: "Diagnóstico del servidor",
            detail: "Snapshot del servidor actualmente activo.",
          },
        },
      },
      issueDetails: {
        title: "Describe el problema",
        subtitle:
          "Proporciona suficientes detalles para que podamos reproducir y diagnosticar rápidamente.",
        titleLabel: "Título (obligatorio)",
        titlePlaceholder: "Título corto",
        githubUsernameLabel: "Usuario de GitHub (opcional)",
        githubUsernamePlaceholder:
          "Se usa como contacto en el cuerpo del issue",
        summaryLabel: "Resumen conciso (obligatorio)",
        summaryPlaceholder: "Resumen de un párrafo",
        currentBehaviorLabel: "Comportamiento actual (opcional)",
        currentBehaviorPlaceholder: "¿Qué ocurre realmente?",
        expectedBehaviorLabel: "Comportamiento esperado (opcional)",
        expectedBehaviorPlaceholder: "¿Qué debería ocurrir en su lugar?",
        reproductionStepsLabel: "Pasos de reproducción (opcional)",
        reproductionStepsPlaceholder:
          "1. Abre Happier\n2. Inicia una sesión\n3. ...",
        whatChangedLabel: "Qué cambió recientemente (opcional)",
        whatChangedPlaceholder:
          "Actualizaciones, cambios de configuración, nuevos pasos de configuración...",
      },
      similarIssues: {
        title: "Posibles duplicados",
        subtitle:
          "Si alguno coincide, puedes publicar tu informe como comentario en lugar de abrir una incidencia nueva.",
        searching: "Buscando incidencias…",
        selectedTitle: ({ number }: { number: number }) =>
          `Usando la incidencia #${number}`,
        selectedSubtitle: "Toca para volver a crear una incidencia nueva.",
        useIssueA11y: ({ number }: { number: number }) =>
          `Usar la incidencia #${number}`,
        issueState: {
          open: "Incidencia abierta",
          closed: "Incidencia cerrada",
        },
      },
      frequencySeverity: {
        title: "Frecuencia y gravedad",
        frequencyLabel: "Frecuencia",
        severityLabel: "Gravedad",
        frequency: {
          always: "Siempre",
          often: "A menudo",
          sometimes: "A veces",
          once: "Una vez",
        },
        severity: {
          blocker: "Bloqueante",
          high: "Alta",
          medium: "Media",
          low: "Baja",
        },
      },
      environment: {
        title: "Entorno (editable)",
        appVersionLabel: "Versión de la app",
        platformLabel: "Plataforma",
        osVersionLabel: "Versión del SO",
        deviceModelLabel: "Modelo del dispositivo",
        serverUrlLabel: "URL del servidor",
        serverVersionLabel: "Versión del servidor (opcional)",
        deploymentTypeLabel: "Tipo de despliegue",
        deploymentType: {
          cloud: "Nube",
          selfHosted: "Autohospedado",
          enterprise: "Empresarial",
        },
      },
      consent: {
        title: "Consentimiento",
        understandTitle:
          "Entiendo que el diagnóstico puede incluir metadatos técnicos",
        understandSubtitle:
          "No incluyas contraseñas, tokens de acceso ni claves privadas.",
      },
      submit: {
        requiredFieldsHint:
          "Completa los campos obligatorios para habilitar el envío.",
        submitting: "Enviando informe…",
        addToIssue: ({ number }: { number: number }) =>
          `Añadir al issue #${number}`,
        submitNew: "Enviar reporte de error",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer:
        "Activa la búsqueda de memoria en Características para configurar la indexación local.",
      title: "La búsqueda de memoria está deshabilitada",
      subtitle: "Abre Configuración → Características para habilitar memory.search",
      openFeatureSettings: "Abrir ajustes de funciones",
      alertTitle: "Búsqueda de memoria deshabilitada",
      alertBody: "Habilita memory.search en Configuración → Características.",
    },
    enabled: {
      title: "Activado",
      subtitle: "Crear y mantener un índice local en esta máquina",
      footer:
        "Cuando está activado, Happier crea un índice local en el dispositivo a partir de transcripciones descifradas para facilitar el recuerdo y la búsqueda.",
    },
    budgets: {
      groupTitle: "Presupuesto de disco",
      groupFooter:
        "Limita el espacio en disco que puede usar el índice de memoria local (evicción por mejor esfuerzo).",
      mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
      lightTitle: "Presupuesto de índice ligero",
      lightPromptTitle: "Presupuesto de índice ligero",
      lightPromptBody:
        "MB máximos para el índice ligero (fragmentos de resumen) en esta máquina.",
      deepTitle: "Presupuesto de índice profundo",
      deepPromptTitle: "Presupuesto de índice profundo",
      deepPromptBody:
        "MB máximos para el índice profundo (fragmentos) en esta máquina.",
    },
    privacy: {
      groupTitle: "Privacidad",
      groupFooter:
        "Elimina índices derivados locales y cachés del modelo al desactivar la búsqueda de memoria.",
      deleteOnDisableTitle: "Eliminar al desactivar",
      deleteOnDisableSubtitle:
        "Elimina índices y cachés locales cuando la búsqueda de memoria está desactivada",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `Máquina: ${machine}`,
      searchPlaceholder: "Buscar en la memoria",
      enableLocalSearch: "Activar búsqueda de memoria local",
      emptyResults: 'Todavía no hay resultados de memoria',
    },
        status: {
            title: 'Estado del índice local',
            diskUsageTitle: 'Uso de disco',
            disabled: 'La búsqueda de memoria local está deshabilitada en esta máquina',
            empty: 'La búsqueda de memoria local está habilitada, pero aún no se ha indexado contenido buscable',
            indexing: 'La búsqueda de memoria local está indexando contenido de transcripciones',
            waiting: 'La búsqueda de memoria local está esperando antes de la próxima indexación',
            error: 'La búsqueda de memoria local necesita atención',
            readyLight: 'El índice ligero está listo en esta máquina',
            readyDeep: 'El índice profundo está listo en esta máquina',
            unavailableLight: 'El índice ligero todavía no está listo en esta máquina',
            unavailableDeep: 'El índice profundo todavía no está listo en esta máquina',
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
            diskUsageFormatted: ({ light, deep }: { light: string; deep: string }) => `Light ${light} · Deep ${deep}`,
            diskUsageUnavailable: 'Uso de disco no disponible',
            ...memoryEmbeddingsTranslationExtension.status,
        },
    machine: {
      title: "Máquina",
      changeTitle: "Cambiar máquina",
      noMachine: "Sin máquina",
    },
    indexMode: {
      title: "Modo de indexación",
      footer:
        "El modo ligero guarda pequeños fragmentos de resumen. El modo profundo puede encontrar más, pero usa más disco.",
      triggerTitle: "Modo",
      options: {
        lightTitle: "Ligero (recomendado)",
        lightSubtitle: "Solo fragmentos de resumen",
        deepTitle: "Profundo",
        deepSubtitle: "Indexar fragmentos de mensajes localmente",
      },
    },
    backfill: {
      title: "Relleno",
      footer:
        "Controla cuánta historia se indexa al habilitar la memoria local.",
      triggerTitle: "Política",
      options: {
        newOnlyTitle: "Solo nuevo (recomendado)",
        newOnlySubtitle: "Indexar solo contenido creado después de habilitar",
        last30DaysTitle: "Últimos 30 días",
        last30DaysSubtitle: "Rellenar sesiones recientes",
        allHistoryTitle: "Todo el historial",
        allHistorySubtitle: "Rellenar todo (puede tardar)",
      },
    },
    indexContents: {
      groupTitle: "Contenido del índice",
      title: "Contenido buscable",
      subtitle: ({ sessions, lightShards, deepChunks }: { sessions: number; lightShards: number; deepChunks: number }) =>
        `${sessions} sesiones · ${lightShards} fragmentos ligeros · ${deepChunks} fragmentos profundos`,
    },
    queue: {
      groupTitle: "Relleno y cola",
      title: "Cola de indexación",
      subtitle: ({ selected, queued, indexing, indexed, empty, failed, waiting }: { selected: number; queued: number; indexing: number; indexed: number; empty: number; failed: number; waiting: number }) =>
        `${selected} seleccionadas · ${queued} en cola · ${indexing} indexando · ${indexed} indexadas · ${empty} vacías · ${failed} fallidas · ${waiting} esperando`,
      workerPhase: ({ phase }: { phase: string }) => `Fase actual: ${phase}`,
    },
    lastRun: {
      groupTitle: "Última indexación",
      title: "Última ejecución",
      subtitle: ({ considered, processed, semanticRows, failures }: { considered: number; processed: number; semanticRows: number; failures: number }) =>
        `${considered} consideradas · ${processed} procesadas · ${semanticRows} filas semánticas · ${failures} fallos`,
    },
    coverage: {
      title: "Cobertura de contenido",
      footer: "Controla qué contenido semántico de transcripciones se indexa dentro de las sesiones seleccionadas.",
      triggerTitle: "Cobertura",
      options: {
        fullTitle: "Todo el historial seleccionado",
        fullSubtitle: "Indexar todos los mensajes seleccionados del usuario y del asistente",
        latestMessagesTitle: "Mensajes recientes",
        latestMessagesSubtitle: "Indexar un número limitado de mensajes semánticos recientes por sesión",
        latestDaysTitle: "Días recientes",
        latestDaysSubtitle: "Indexar mensajes semánticos de una ventana reciente de días",
        sinceEnabledTitle: "Desde que se habilitó",
        sinceEnabledSubtitle: "Indexar contenido creado después de habilitar la memoria local",
      },
    },
    contentPolicy: {
      title: "Contenido indexado",
      footer: "Los mensajes del usuario y del asistente se indexan por defecto. Los detalles sensibles del proveedor permanecen desactivados salvo activación explícita.",
      userMessagesTitle: "Mensajes del usuario",
      userMessagesSubtitle: "Incluye prompts y respuestas escritos por ti",
      assistantMessagesTitle: "Mensajes del asistente",
      assistantMessagesSubtitle: "Incluye respuestas finales del asistente",
      reasoningTitle: "Razonamiento",
      reasoningSubtitle: "Incluye resúmenes de razonamiento solo cuando el daemon los admite",
      toolSummariesTitle: "Resúmenes de herramientas",
      toolSummariesSubtitle: "Incluye resúmenes saneados de actividad de herramientas",
      toolOutputsTitle: "Salidas sin procesar de herramientas",
      toolOutputsSubtitle: "Mantener desactivado salvo que quieras incluir texto bruto de salidas de herramientas en índices locales",
    },
    hints: {
      title: "Generación de pistas de memoria",
      footer:
        "Controla cómo se generan los fragmentos de resumen para la búsqueda de memoria ligera.",
      backend: {
        title: "Backend del resumidor",
        promptTitle: "Backend del resumidor",
        promptBody:
          "Introduce un id de backend de execution-run (por ejemplo, claude, codex).",
      },
      model: {
        title: "Modelo del resumidor",
        promptTitle: "Modelo del resumidor",
        promptBody:
          "Introduce un id de modelo para pasar al backend.",
      },
      permissions: {
        triggerTitle: "Permisos del resumidor",
        options: {
          noToolsTitle: "Sin herramientas (recomendado)",
          noToolsSubtitle: "Solo resumir texto",
          readOnlyTitle: "Solo lectura",
          readOnlySubtitle:
            "Permitir herramientas no mutantes cuando se admitan",
        },
      },
    },
    embeddings: {
      modelTitle: "Modelo de embeddings",
      promptBody: "Introduce un id de modelo local de transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
    },
  },

  subAgentGuidance: {
    ruleEditor: {
      header: {
        newRule: "Nueva regla",
        editRule: "Editar regla",
      },
      enabled: {
        title: "Activado",
      },
      enabledState: {
        enabled: "Activado",
        disabled: "Desactivado",
      },
      common: {
        noPreference: "Sin preferencia",
      },
      titleField: {
        label: "Título (opcional)",
        placeholder: "p. ej., trabajo de UI",
      },
      descriptionField: {
        label: "¿Cuándo debería el agente delegar?",
        placeholder: "Describe cuándo/cómo delegar…",
      },
      backendPicker: {
        title: "Backend objetivo (opcional)",
        searchPlaceholder: "Buscar backends",
        noPreference: {
          subtitle: "Deja que el agente elija un backend.",
        },
      },
      modelPicker: {
        title: "Modelo objetivo (opcional)",
        searchPlaceholder: "Buscar modelos",
        noPreference: {
          subtitle: "Deja que el backend elija un modelo predeterminado.",
        },
      },
      intent: {
        title: "Intención sugerida (opcional)",
        noPreference: {
          subtitle: "Deja que el agente decida la intención.",
        },
        options: {
          review: {
            title: "Revisión",
            subtitle: "Revisión de código / hallazgos.",
          },
          plan: {
            title: "Planificación",
            subtitle: "Planificación / arquitectura.",
          },
          delegate: {
            title: "Delegar",
            subtitle: "Delegación / ejecución.",
          },
        },
      },
      exampleToolCalls: {
        label: "Ejemplos de llamadas a herramientas (opcional, una por línea)",
        placeholder: "p. ej., execution.run.start …",
      },
    },
        settings: {
      groupTitle: "Subagentes",
      disabled: {
        footer:
          "Execution runs está deshabilitado. Habilita Execution Runs en Configuración → Características para usar la guía de delegación.",
        enableExecutionRuns: {
          title: "Habilitar Execution Runs",
          subtitle: "Abrir configuración de Características",
        },
      },
      footer:
        "Las reglas se añaden al prompt del sistema para que el agente principal sepa cuándo y cómo prefieres lanzar ejecuciones de subagentes.",
      overview: {
        groupTitle: "Resumen",
        footer:
          "Usa esta página para configurar la guía de subagentes y saltar a ajustes relacionados de proveedor, backend y sesión.",
        explainerTitle: "Qué controla esta página",
        explainerSubtitle:
          "Orientación de delegación para los subagentes, con enlaces a ajustes de subagentes específicos del proveedor.",
        happierStatusTitle: "Subagentes",
        happierStatusEnabledSubtitle:
          "Activado. Puedes lanzar subagentes desde sesiones compatibles.",
        happierStatusDisabledSubtitle:
          "Desactivado. Abre Ajustes de características para habilitar los subagentes.",
      },
      related: {
        groupTitle: "Ajustes relacionados",
        footer:
          "El lanzamiento y control de subagentes también depende del comportamiento de la sesión, de los proveedores y de los backends configurados.",
        sessionTitle: "Comportamiento de la sesión",
        sessionSubtitle:
          "Envío de mensajes, dirección mientras está ocupado y comportamiento de repetición/reanudación.",
        providersTitle: "Proveedores",
        providersSubtitle:
          "Autenticación, runtime y ajustes de agente específicos del proveedor.",
        backendsTitle: "Catálogo ACP",
        backendsSubtitle: "Backends configurados y destinos de lanzamiento personalizados.",
      },
      enableInjection: {
        title: "Habilitar inyección de guía",
      },
      characterBudget: {
        title: "Límite de caracteres",
        subtitle: ({ value }: { value: string }) => `${value} caracteres`,
        promptTitle: "Límite de caracteres",
        promptBody: "Máximo de caracteres para inyectar en el prompt del sistema.",
      },
      rules: {
        groupTitle: "Reglas de guía",
        footerEnabled:
          "Toca una regla para editar. El agente las usa como pistas de delegación.",
        footerDisabled: "Habilita la inyección para activar las reglas.",
        emptyTitle: "Aún no hay reglas",
        emptySubtitle: "Añade una regla para guiar la delegación.",
        addRuleTitle: "Añadir regla",
        addRuleSubtitle: "Crear una nueva regla de guía",
        untitled: "Regla sin título",
        descriptionFallback: "Describe cuándo delegar.",
        tapToEdit: "Toca para editar",
        meta: {
          target: ({ value }: { value: string }) => `Objetivo: ${value}`,
          model: ({ value }: { value: string }) => `Modelo: ${value}`,
          intent: ({ value }: { value: string }) => `Intención: ${value}`,
        },
      },
      preview: {
        title: "Vista previa",
        footer:
          "Este es el texto (truncado) que se añade al prompt del sistema.",
        systemPromptLabel: "Prompt del sistema (añadido)",
      },
      providers: {
        claude: {
          title: "Agentes de equipo de Claude",
          footer: "El comportamiento de subagentes específico del proveedor sigue perteneciendo a la pantalla de ajustes del proveedor.",
          openTitle: "Opciones de subagente de Claude",
          openSubtitle: "Gestiona Agent Teams y otro comportamiento de subagentes específico de Claude.",
        },
      },
    },
  },

  settings: {
    title: "Configuración",
    overview: 'Resumen',

    // Main settings hub category groups
    profileAndAccount: 'Perfil y cuenta',
    aiAndAgents: 'IA y agentes',
    sessionsBehavior: 'Sesiones y comportamiento',
    general: 'Generales',
    filesAndSourceControl: 'Archivos y control de código fuente',
    system: 'Sistema',

    // Renamed / promoted items
    sessions: 'Sesiones',
    transcript: 'Transcripción',
    transcriptSubtitle: 'Pensamiento, renderizado de herramientas y visualización de código',
    permissions: 'Permisos',
    permissionsSubtitle: 'Modo de permisos y comportamiento de aprobación',
    filesSourceControl: 'Archivos y control de código fuente',
    filesSourceControlSubtitle: 'Editor, diffs e integración con el control de código fuente',
    workspaces: 'Espacios de trabajo',
    workspacesSubtitle: 'Gestiona espacios de trabajo vinculados, ubicaciones y copias de trabajo',

    connectedAccounts: "Cuentas conectadas",
    connectAccount: "Conectar cuenta",
    github: "GitHub",
    machines: "Máquinas",
    features: "Características",
    social: "Redes sociales",
    account: "Cuenta",
    accountSubtitle: "Gestiona los detalles de tu cuenta",
    addYourPhone: "Añade tu teléfono",
    addYourPhoneSubtitle: "Muestra un código QR para iniciar sesión en tu teléfono",
    addMachine: "Agregar una máquina",
    machineSetupCurrentMachineTitle: "Esta computadora",
    machineSetupCurrentMachineSubtitle: "Inicializa Happier directamente en este dispositivo",
    machineSetupAdoptExistingTitle: "Adoptar instalación existente",
    machineSetupAdoptExistingSubtitle: "Usa una configuración existente del daemon/servicio en esta computadora",
    machineSetupAdoptExistingProgressTitle: "Comprobando instalación existente",
    machineSetupAdoptExistingNotReady: "No se encontró ninguna instalación lista. Inicia la configuración en esta computadora.",
    machineSetupSshMachineTitle: "Máquina remota por SSH",
    machineSetupSshMachineSubtitle: "Conecta un equipo de desarrollo, una VM o un servidor mediante SSH",
    machineSetupStagesTitle: "Qué ocurre",
    machineSetupStageConnect: "Conectar y validar el acceso",
    machineSetupStageInstall: "Instalar Happier y emparejar la máquina",
    machineSetupStageFinish: "Finalizar la configuración en la terminal integrada",
    machineSetupComingSoon: "La inicialización de máquinas llegará pronto.",
    machineSetupTaskWaitingForInput: "Esperando entrada",
    machineSetupRemoteSshTargetLabel: "Destino SSH",
    machineSetupRemoteSshAgentAuthLabel: "Usar agente SSH",
    machineSetupRemoteSshKeyFileAuthLabel: "Usar archivo de identidad",
    machineSetupRemoteSshIdentityFileLabel: "Ruta del archivo de identidad",
    machineSetupRemoteRelayRuntimeLabel: "Instalar también el runtime de Relay en la máquina remota",
    machineSetupRemoteRelayRuntimeTitle: "Runtime de Relay remoto",
    machineSetupRemoteRelayRuntimeReadyTitle: "Listo en la máquina remota",
    machineSetupRemoteRelayRuntimeReadySubtitle: "El runtime de Relay se instaló durante la configuración por SSH. Usa la URL del Relay remoto en los siguientes pasos de red de esa máquina.",
    machineSetupRemoteRelayRuntimeUrlTitle: "URL del Relay remoto",
    machineSetupRemoteRelayKeepCurrentTitle: "Mantener el Relay actual",
    machineSetupRemoteRelayKeepCurrentSubtitle: "Guarda esta URL de Relay sin cambiar.",
    machineSetupRemoteRelaySwitchTitle: "Cambiar a este Relay",
    machineSetupRemoteRelaySwitchSubtitle: "Cambia ahora y continúa la configuración con el nuevo Relay.",
    machineSetupRemoteRelaySwitchConfirmTitle: "¿Cambiar de Relay?",
    machineSetupRemoteRelaySwitchConfirmBody: ({ relayUrl }: { relayUrl: string }) =>
      `Cambiar Happier a ${relayUrl} y continuar la configuración?`,
    machineSetupRemotePromptTrustAction: "Confiar en la clave del host",
    machineSetupRemotePromptReplaceAction: "Reemplazar la clave guardada",
    machineSetupRemotePromptApproveAction: "Aprobar emparejamiento",
    localRelayRuntime: {
      title: 'Runtime local de Relay',
      statusTitle: 'Estado',
      statusChecking: 'Comprobando el runtime local de Relay',
      statusNotInstalled: 'Aún no está instalado en este ordenador',
      statusStopped: 'Instalado, pero ahora mismo no se está ejecutando',
      statusRunningHealthy: 'En ejecución y respondiendo con normalidad',
      statusRunningNeedsAttention: 'En ejecución, pero las comprobaciones de salud necesitan atención',
      versionTitle: 'Versión instalada',
      relayUrlTitle: 'URL local de Relay',
      installOrUpdateAction: 'Instalar o actualizar el runtime de Relay',
      startAction: 'Iniciar el runtime de Relay',
      stopAction: 'Detener el runtime de Relay',
      refreshAction: 'Actualizar el estado de Relay',
      footer: 'Gestiona el Relay autohospedado que se ejecuta en este ordenador antes de conectar otros dispositivos.',
      progressTitle: 'Actualizando el runtime local de Relay',
      progressStepInspect: 'Inspeccionar el runtime local de Relay',
      progressStepHealth: 'Comprobar la salud de Relay',
      progressStepInstall: 'Instalar el runtime de Relay',
      progressStepStart: 'Iniciar el runtime de Relay',
      progressStepStop: 'Detener el runtime de Relay',
    },
    localTailscale: {
      title: 'Acceso privado con Tailscale',
      statusTitle: 'Estado',
      statusUnavailable: 'Primero inicia el runtime local de Relay',
      statusIdle: 'Aún no está activado',
      statusWorking: 'Configurando acceso privado seguro',
      statusReady: 'Listo para usarse desde otros dispositivos del tailnet',
      statusInstallRequired: 'Instala Tailscale para continuar',
      statusLoginRequired: 'Inicia sesión en Tailscale para continuar',
      statusNeedsApproval: 'Esperando la aprobación de Tailscale',
      shareableUrlTitle: 'URL privada compartible',
      approvalTitle: 'Se requiere aprobación',
      approvalSubtitle: 'Termina el flujo de aprobación de Tailscale y vuelve aquí.',
      installTitle: 'Instalación requerida',
      installSubtitle: 'Instala Tailscale y luego vuelve aquí.',
      loginTitle: 'Se requiere iniciar sesión',
      loginSubtitle: 'Completa el inicio de sesión en Tailscale y luego vuelve aquí.',
      enableAction: 'Activar acceso privado con Tailscale',
      refreshAction: 'Volver a comprobar el acceso privado',
      openApprovalAction: 'Abrir la aprobación de Tailscale',
      openInstallAction: 'Abrir descarga de Tailscale',
      openLoginAction: 'Abrir inicio de sesión de Tailscale',
      footer: 'Esto mantiene el acceso privado dentro del tailnet. Tu teléfono u otro ordenador también deben unirse al mismo tailnet.',
      progressTitle: 'Configurando el acceso seguro con Tailscale',
      progressStepDetect: 'Comprobar la disponibilidad de Tailscale',
      progressStepInstall: 'Instalar Tailscale',
      progressStepLogin: 'Iniciar sesión en Tailscale',
      progressStepServeEnable: 'Activar el acceso privado a Relay',
      progressStepVerifyUrl: 'Verificar la URL compartible',
    },
    systemTaskStepPrepare: "Preparar tarea",
    systemTaskStepInstallRuntime: "Instalar runtime",
    systemTaskStepFinish: "Finalizar configuración",
    systemTaskCurrentStepLabel: "Paso actual",
    systemTaskLatestUpdateLabel: "Última actualización",
    systemTaskBridgeUnavailable: "Las tareas del sistema aún no están disponibles en esta compilación.",
    systemTaskStartFailed: "No se pudo iniciar la tarea del sistema.",
    appearance: "Apariencia",
    appearanceSubtitle: "Personaliza como se ve la app",
      voiceAssistant: "Asistente de voz",
      voiceAssistantSubtitle: "Configura las preferencias de voz",
      memorySearch: "Búsqueda de memoria local",
      memorySearchSubtitle: "Busca en conversaciones anteriores (en el dispositivo)",
      notifications: "Notificaciones",
      notificationsSubtitle: "Preferencias de notificaciones push",
      attachments: "Adjuntos",
      attachmentsSubtitle: "Preferencias de subida de archivos",
      sourceControl: "Control de versiones",
      sourceControlSubtitle: "Estrategia de commits y comportamiento del backend",
      automations: "Automatizaciones",
      automationsSubtitle: "Gestiona sesiones programadas y ejecuciones recurrentes",
      executionRunsSubtitle: "Ejecuciones en distintas máquinas",
      connectedServices: "Servicios conectados",
      connectedServicesSubtitle: "Suscripciones de Claude/Codex y perfiles OAuth",
      featuresTitle: "Características",
      featuresSubtitle: "Habilitar o deshabilitar funciones de la aplicación",
      pets: "Mascotas",
      petsSubtitle: "Elige Blink y las mascotas compañeras del dispositivo",
    developer: "Desarrollador",
    developerTools: "Herramientas de desarrollador",
    about: "Acerca de",
    actionsSettingsAboutSubtitle:
      "Habilita o deshabilita acciones globalmente, por superficie (UI/voz/MCP) y por ubicación (dónde aparecen en la interfaz). Las acciones deshabilitadas se bloquean de forma segura en tiempo de ejecución.",
    aboutFooter:
      "Happier Coder es un cliente móvil para Codex y Claude Code. Usa cifrado de extremo a extremo por defecto, con restauración de la cuenta en tus otros dispositivos. No está afiliado con Anthropic.",
    whatsNew: "Novedades",
    whatsNewSubtitle: "Ve las últimas actualizaciones y mejoras",
    reportIssue: "Reportar un problema",
    privacyPolicy: "Política de privacidad",
    termsOfService: "Términos de servicio",
    rateUs: "Califica Happier",
    rateUsSubtitle: "Si te gusta la app, una calificación rápida nos ayuda mucho",
    eula: "EULA",
    supportUs: "Apóyanos",
    supportUsSubtitlePro: "¡Gracias por su apoyo!",
    supportUsSubtitle: "Apoya el desarrollo del proyecto",
    scanQrCodeToAuthenticate: "Escanea el código QR para conectar el terminal",
    githubConnected: ({ login }: { login: string }) =>
      `Conectado como @${login}`,
    connectGithubAccount: "Conecta tu cuenta de GitHub",
    claudeAuthSuccess: "Conectado exitosamente con Claude",
    exchangingTokens: "Intercambiando tokens...",
    usage: "Uso",
    usageSubtitle: "Ver tu uso de API y costos",
    profiles: "Perfiles",
    profilesSubtitle:
      "Gestionar perfiles de variables de entorno para sesiones",
    secrets: "Secretos",
    secretsSubtitle:
      "Gestiona los secretos guardados (no se vuelven a mostrar después de ingresarlos)",
    terminal: "Terminal (CLI)",
    session: "Sesión",
    sessionSubtitleTmuxEnabled: "Tmux activado",
    sessionSubtitleMessageSendingAndTmux: "Envío de mensajes y tmux",
        actionsSubtitle: 'Elige dónde aparece cada acción en la app, la voz y las integraciones.',
    prompts: "Prompts y habilidades",
    promptsSubtitle: "Biblioteca de prompts, plantillas y pilas",
    servers: "Relés",
    serversSubtitle: "Relays guardados, grupos y valores predeterminados",
		    systemStatus: "Estado del sistema",
		    systemStatusSubtitle: "Relays, cuenta, máquinas, daemon",
		    mcpServers: "Servidores MCP",
		    mcpServersSubtitle: "Gestiona servidores MCP y vinculaciones",
		    mcpServersComingSoon: "La configuración de servidores MCP llegará pronto.",
		    mcpServersStrictMode: "Modo estricto",
		    mcpServersStrictModeSubtitle: "Falla de forma cerrada cuando la configuración del servidor MCP no sea válida.",
		    mcpServersCatalogTitle: "Catálogo",
		    mcpServersUnnamed: "Servidor sin nombre",
		    mcpServersEmptyTitle: "Aún no hay servidores MCP",
		    mcpServersEmptySubtitle: "Añade servidores MCP para usarlos en sesiones.",
		    mcpServersAddServer: "Añadir servidor",
		    mcpServersAddServerSubtitle: "Crear una nueva entrada de servidor MCP",
		    mcpServersEditorTitle: "Servidor MCP",
		    mcpServersPickSecretTitle: "Elegir un secreto",
		    mcpServersPickSecretNoneSubtitle: "No se seleccionó ningún secreto",
		    mcpServersEditorBasics: "Básicos",
		    mcpServersEditorStdio: "Entrada/salida estándar",
		    mcpServersEditorRemote: "Remoto",
		    mcpServersEditorBindings: "Vinculaciones",
		    mcpServersFieldName: "Nombre",
		    mcpServersFieldTitle: "Título",
		    mcpServersFieldTitlePlaceholder: "Título de visualización opcional",
		    mcpServersFieldTransport: "Transporte",
		    mcpServersFieldCommand: "Comando",
		    mcpServersFieldArgs: "Argumentos",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "Vinculación",
		    mcpServersBindingEnabled: "Habilitado",
		    mcpServersBindingEnabledSubtitle: "Activa o desactiva esta vinculación",
		    mcpServersBindingTarget: "Destino",
		    mcpServersBindingTargetSubtitle: "Dónde está disponible este servidor",
		    mcpServersBindingMachine: "Máquina",
		    mcpServersBindingMachineSubtitle: "Selecciona una máquina",
		    mcpServersBindingDeleteSubtitle: "Eliminar esta vinculación",
		    mcpServersBindingTargetAllMachines: "Todas las máquinas",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `Máquina: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `Workspace: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "Habilitar en todas las máquinas",
		    mcpServersBindingTargetMachineTitle: "Máquina",
		    mcpServersBindingTargetMachineSubtitle: "Habilitar en una sola máquina",
		    mcpServersBindingTargetWorkspaceTitle: "Espacio de trabajo",
		    mcpServersBindingTargetWorkspaceSubtitle: "Habilitar solo para una ruta de espacio de trabajo específica",
		    mcpServersValidationFailed: "La configuración del servidor MCP no es válida.",
		    mcpServersServerNotFound: "Servidor no encontrado.",
		    mcpServersBindingsEmptyTitle: "Aún no hay vinculaciones",
		    mcpServersBindingsEmptySubtitle: "Añade una vinculación para usar este servidor.",
		    mcpServersAddBinding: "Añadir vinculación",
		    mcpServersAddBindingSubtitle: "Habilita este servidor para máquinas o espacios de trabajo",
		    mcpServersSaveDisabledSubtitle: "No hay cambios que guardar.",
			    mcpServersDeleteTitle: "¿Eliminar servidor MCP?",
			    mcpServersDeleteConfirm: ({ name }: { name: string }) => `Delete "${name}"?`,
			    mcpServersDeleteSubtitle: "Elimina este servidor de tu catálogo",
			    mcpServersNoMachineSelected: "No se seleccionó ninguna máquina",
			    mcpServersDetectedTitle: "Detectados a partir de configuraciones del proveedor",
			    mcpServersDetectedMachineTitle: "Máquina",
			    mcpServersDetectedRefreshTitle: "Actualizar servidores detectados",
			    mcpServersDetectedRefreshSubtitle: "Escanear archivos de configuración del proveedor en esta máquina",
			    mcpServersDetectedWarningsTitle: "Advertencias de detección",
			    mcpServersDetectedEmptyTitle: "No se detectaron servidores MCP",
			    mcpServersDetectedEmptySubtitle: "Pulsa actualizar para escanear las configuraciones de Claude/Codex/OpenCode.",
			    mcpServersImportTitle: "¿Importar servidor MCP?",
			    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) =>
			      `Import "${name}" from ${provider}?`,
			    mcpServersImportAction: "Importar",
			    mcpServersBindingSummaryAllMachines: "Todas las máquinas",
			    mcpServersBindingSummaryMachines: ({ count }: { count: number }) =>
			      `${count} machine${count === 1 ? "" : "s"}`,
			    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) =>
			      `${count} workspace${count === 1 ? "" : "s"}`,
			    mcpServersBindingSummaryNone: "Sin vinculación",
			    mcpServersPickWorkspaceTitle: "Elige la raíz del espacio de trabajo",
			    mcpServersBindingWorkspaceRootTitle: "Raíz del espacio de trabajo",
			    mcpServersBindingOverridesTitle: "Anulaciones",
			    mcpServersBindingOverridesNone: "Sin anulaciones",
			    mcpServersBindingOverridesCount: ({ count }: { count: number }) =>
			      `${count} override${count === 1 ? "" : "s"}`,
			    mcpServersEditorEnv: "Entorno",
			    mcpServersEnvAdd: "Añadir variable de entorno",
			    mcpServersEnvAddSubtitle: "Establece variables de entorno para este servidor",
			    mcpServersEnvEmptyTitle: "Sin variables de entorno",
			    mcpServersEnvEmptySubtitle: "Añade variables de entorno o usa Secretos guardados.",
			    mcpServersEditorHeaders: "Cabeceras",
			    mcpServersHeadersAdd: "Añadir cabecera",
			    mcpServersHeadersAddSubtitle: "Establece cabeceras HTTP/SSE para este servidor",
			    mcpServersHeadersEmptyTitle: "Sin cabeceras",
			    mcpServersHeadersEmptySubtitle: "Añade cabeceras si tu servidor requiere autenticación.",
			    mcpServersEnvEditorTitle: "Editar variable de entorno",
			    mcpServersHeadersEditorTitle: "Editar cabecera",
			    mcpServersEnvKeyLabel: "Nombre de la variable de entorno",
			    mcpServersEnvKeyPlaceholder: "API_KEY",
			    mcpServersHeaderKeyLabel: "Nombre de la cabecera",
			    mcpServersHeaderKeyPlaceholder: "Authorization",
			    mcpServersValueSourceTitle: "Origen del valor",
			    mcpServersArgsPlaceholder: "--flag\nvalue",
			    mcpServersValueSourceLiteral: "Valor literal",
			    mcpServersValueSourceLiteralSubtitle: "Almacena un valor (admite plantillas ${VAR})",
			    mcpServersValueSourceSavedSecret: "Secreto guardado",
			    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `Secreto guardado: ${name}`,
			    mcpServersValueSourceSavedSecretSubtitle: "Referencia un secreto guardado",
			    mcpServersValueLiteralLabel: "Valor",
			    mcpServersValueLiteralPlaceholder: "Valor o ${ENV_VAR}",
			    mcpServersValueSecretLabel: "Secreto guardado",
			    mcpServersValueSecretSelect: "Seleccionar secreto",
			    mcpServersValueSecretSelectSubtitle: "Elige un secreto guardado",
			    mcpServersKeyInvalid: "La clave no es válida.",
			    mcpServersKeyAlreadyExists: "La clave ya existe.",
			    mcpServersOverridesStdioTitle: "Anulaciones de Stdio",
			    mcpServersOverridesCommandTitle: "Anular comando",
			    mcpServersOverridesCommandSubtitle: "Usa un comando distinto para esta vinculación",
			    mcpServersOverridesArgsTitle: "Anular argumentos",
			    mcpServersOverridesArgsSubtitle: "Usa argumentos distintos para esta vinculación (en blanco = sin argumentos)",
			    mcpServersOverridesRemoteTitle: "Anulaciones remotas",
			    mcpServersOverridesUrlTitle: "Anular URL",
			    mcpServersOverridesUrlSubtitle: "Usa una URL distinta para esta vinculación",
			    mcpServersOverridesEnvPatchTitle: "Parche de entorno",
			    mcpServersOverridesEnvPatchEmptyTitle: "Sin anulaciones de entorno",
			    mcpServersOverridesEnvPatchEmptySubtitle: "Añade anulaciones o eliminaciones para variables de entorno.",
			    mcpServersOverridesHeadersPatchTitle: "Parche de cabeceras",
			    mcpServersOverridesHeadersPatchEmptyTitle: "Sin anulaciones de cabeceras",
			    mcpServersOverridesHeadersPatchEmptySubtitle: "Añade anulaciones o eliminaciones para cabeceras.",
			    mcpServersOverridesDeleteValue: "Elimina esta clave para esta vinculación",
			    mcpServersOverridesEnvPatchAddTitle: "Añadir anulación de entorno",
			    mcpServersOverridesEnvPatchAddSubtitle: "Define o anula una variable de entorno para esta vinculación",
			    mcpServersOverridesEnvPatchDeleteTitle: "Eliminar clave de entorno",
			    mcpServersOverridesEnvPatchDeleteSubtitle: "Elimina una variable de entorno para esta vinculación",
			    mcpServersOverridesHeadersPatchAddTitle: "Añadir anulación de cabecera",
			    mcpServersOverridesHeadersPatchAddSubtitle: "Define o anula una cabecera para esta vinculación",
			    mcpServersOverridesHeadersPatchDeleteTitle: "Eliminar clave de cabecera",
			    mcpServersOverridesHeadersPatchDeleteSubtitle: "Elimina una cabecera para esta vinculación",
			    mcpServersOverridesDeleteEnvTitle: "Eliminar clave de entorno",
			    mcpServersOverridesDeleteEnvPrompt: "Introduce el nombre de la variable de entorno que deseas eliminar para esta vinculación.",
			    mcpServersOverridesDeleteHeaderTitle: "Eliminar clave de cabecera",
			    mcpServersOverridesDeleteHeaderPrompt: "Introduce el nombre de la cabecera que deseas eliminar para esta vinculación.",
			    mcpServersOverridesCommandRequired: "La anulación del comando está habilitada pero vacía.",
			    mcpServersOverridesUrlRequired: "La anulación de URL está habilitada pero vacía.",
			    mcpServersTestTitle: "Probar",
			    mcpServersTestFooter: "Se ejecuta en la máquina seleccionada. No se muestran secretos en los resultados.",
			    mcpServersTestMachineTitle: "Probar en la máquina",
			    mcpServersTestBindingTitle: "Usar vinculación",
			    mcpServersTestNoBinding: "Sin vinculación",
			    mcpServersTestNoBindingSubtitle: "Probar sin anulaciones de vinculación",
			    mcpServersTestDirectoryTitle: "Directorio de trabajo",
			    mcpServersTestDirectorySubtitle: "Toca para elegir un directorio",
			    mcpServersTestDirectoryPrompt: "Introduce el directorio de trabajo para la prueba.",
			    mcpServersTestRunTitle: "Probar servidor",
			    mcpServersTestRunSubtitle: "Conectar y listar herramientas",
			    mcpServersTestResultOkTitle: "La prueba se completó correctamente",
			    mcpServersTestResultOkSubtitle: ({
			      toolCount,
			      durationMs,
			    }: {
			      toolCount: number;
			      durationMs: number;
			    }) => `${toolCount} tools · ${durationMs}ms`,
			    mcpServersTestResultErrorTitle: "La prueba falló",
        ...mcpServersUxTranslationExtension,
        ...acpCatalogTranslationExtension.settings,

			    // Dynamic settings messages
			    accountConnected: ({ service }: { service: string }) =>
			      `Cuenta de ${service} conectada`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} está ${status === "online" ? "en línea" : "desconectado"}`,
  featureToggled: ({
      feature,
      enabled,
    }: {
      feature: string;
      enabled: boolean;
    }) => `${feature} ${enabled ? "habilitada" : "deshabilitada"}`,

    remoteHostsTitle: "Hosts remotos",
    remoteHostsDesktopOnlyTitle: "Los hosts remotos solo están disponibles en escritorio",
    remoteHostsDesktopOnlySubtitle: "Gestiona hosts SSH guardados en escritorio.",
    remoteHostsManagementDisabledTitle: "La gestión de hosts remotos está deshabilitada",
    remoteHostsManagementDisabledSubtitle: "Esta compilación no permite gestionar hosts remotos.",
    remoteHostsEmptyTitle: "No hay hosts remotos",
    remoteHostsEmptySubtitle: "Añade un host remoto para reutilizar credenciales SSH en la configuración.",
    remoteHostsAddHost: "Añadir host remoto",
    remoteHostsAddHostTitle: "Añadir host remoto",
    remoteHostsEditHostTitle: "Editar host remoto",
    remoteHostsHostGroupTitle: "Servidor",
    remoteHostsSshGroupTitle: "SSH",
    remoteHostsSecretMaterialGroupTitle: "Material secreto",
    remoteHostsSavePasswordLabel: "Guardar contraseña",
    remoteHostsPasswordSavedTitle: "Contraseña guardada",
    remoteHostsPasswordSavedSubtitle: "Déjalo en blanco para mantenerla sin cambios.",
    remoteHostsStorePrivateKeyLabel: "Guardar clave privada (cifrada)",
    remoteHostsPrivateKeyLabel: "Clave privada",
    remoteHostsPrivateKeySavedHint: "Ya hay una clave privada guardada. Déjalo en blanco para mantenerla sin cambios.",
    remoteHostsSecretMaterialDisabledTitle: "Guardar secretos deshabilitado",
    remoteHostsSecretMaterialDisabledSubtitle: "Esta compilación no permite almacenar contraseñas ni claves privadas.",
    remoteHostsSetupAsMachineTitle: "Configurar como máquina Happier",
    remoteHostsSetupAsMachineFailed: "No se pudo configurar este host como máquina Happier.",
    remoteHostsConnectFromThisDeviceTitle: "Conectar desde este dispositivo",
    remoteHostsConnectFromThisDeviceSubtitle: "Solo este dispositivo. Abre un túnel SSH local para esta sesión de la app.",
    remoteHostsConnectFromThisDeviceFailed: "No se pudo abrir el túnel SSH local.",
    remoteHostsNativeSshTunnelRequiresEngine: "Los túneles SSH nativos necesitan la compilación del motor SSH nativo antes de poder iniciarse desde este dispositivo.",
    remoteHostsSshTunnelGroupTitle: "Acceder al host remoto desde este dispositivo",
    remoteHostsSshTunnelActiveTitle: ({ host }: { host: string }) => `Túnel SSH activo para ${host}`,
    remoteHostsSshTunnelActiveSubtitle: ({ url }: { url: string }) => `Solo este dispositivo. Endpoint local: ${url}`,
    remoteHostsSshTunnelStopTitle: "Detener túnel SSH local",
    remoteHostsUseAsRelayHostTitle: "Usar como host de Relay",
    remoteHostsUseAsRelayHostSubtitle: "Configura el acceso de Relay en este host SSH.",
    remoteHostsConfigureAccessTitle: "Configurar acceso",
    remoteHostsConfigureAccessSubtitle: "Elige cómo se puede acceder a este host remoto.",
    remoteHostsOpenDetailsTitle: "Detalles del host",
    remoteHostsRelayAccessGroupTitle: "Acceso remoto",
    remoteHostsRelayAccessActiveTitle: ({ host }: { host: string }) => `Configurando acceso para ${host}`,
    remoteHostsRelayAccessActiveSubtitle: "Los comandos de acceso de Relay se ejecutan en el host remoto por SSH. Esto no crea un túnel SSH.",
    remoteHostsMissingServerUrl: "Selecciona un servidor antes de configurar una máquina remota.",
    remoteHostsRelayAccessIdentityFileRequired: "El acceso de Relay en este host requiere un archivo de identidad SSH local.",
    remoteHostsTestConnectionTitle: "Probar conexión",
    remoteHostsInstallOrUpdateCliTitle: "Instalar o actualizar CLI",
    remoteHostsDaemonServiceInstallOrUpdateTitle: "Instalar o actualizar servicio del daemon",
    remoteHostsDaemonServiceStartTitle: "Iniciar servicio del daemon",
    remoteHostsDaemonServiceStopTitle: "Detener servicio del daemon",
    remoteHostsDaemonServiceRestartTitle: "Reiniciar servicio del daemon",
    remoteHostsRelayRuntimeStatusTitle: "Estado del runtime del relay",
    remoteHostsRelayRuntimeInstallOrUpdateTitle: "Instalar o actualizar runtime del relay",
    remoteHostsRelayRuntimeStartTitle: "Iniciar runtime del relay",
    remoteHostsRelayRuntimeStopTitle: "Detener runtime del relay",
    remoteHostsRelayRuntimeRestartTitle: "Reiniciar runtime del relay",
    remoteHostsPortLine: ({ port }: { port: number }) => `Puerto: ${port}`,
    remoteHostsActiveTaskTitle: "Tarea del sistema",
    remoteHostsHostTrustTitle: "¿Confiar en el host SSH?",
    remoteHostsReplaceHostKeyTitle: "¿Reemplazar la clave de host SSH?",
    remoteHostsReplaceHostKeyAction: "Reemplazar clave de host",
    remoteHostsHostKeyCurrentFingerprintLabel: "Huella confiable actual",
    remoteHostsHostKeyNewFingerprintLabel: "Nueva huella",
    remoteHostsPasswordRequiredTitle: "Se requiere contraseña SSH",
    remoteHostsRememberHostKeyTitle: "¿Recordar esta clave de host SSH?",
    remoteHostsRememberHostKeyAction: "Confiar y recordar",
    remoteHostsTrustOnceAction: "Confiar una vez",
    remoteHostsPrivateKeyPassphraseTitle: "Frase de contraseña de la clave privada SSH",
    remoteHostsKeyboardInteractiveTitle: "Autenticación SSH",
    remoteHostsKeyboardInteractivePromptLabel: "Solicitud SSH",
    remoteHostsTrustedHostKeysTitle: "Claves de host SSH de confianza",
    remoteHostsTrustedHostKeyRemoveTitle: "¿Eliminar la clave de host SSH de confianza?",
    remoteHostsTrustedHostKeysClearTitle: "Borrar claves de host SSH de confianza",
    remoteHostsConnectionSucceeded: "Conexión correcta.",
    remoteHostsConnectionFailed: "La conexión falló.",
    sshConfiguredHostPickerTitle: "Hosts SSH sugeridos",
    sshConfiguredHostPickerSubtitle: "Rellena desde tu configuración SSH local o known_hosts.",
    sshConfiguredHostPickerRefreshingSubtitle: "Actualizando sugerencias; se muestran los últimos resultados.",
    sshConfiguredHostPickerSourceSshConfig: "Configuración SSH",
    sshConfiguredHostPickerSourceKnownHosts: "known_hosts",
    sshConfiguredHostPickerUnsupportedTitle: "Introduce los detalles SSH manualmente",
    sshConfiguredHostPickerUnsupportedSubtitle: "El descubrimiento SSH local solo está disponible en la app de escritorio.",
    sshConfiguredHostPickerLoadingTitle: "Buscando hosts SSH…",
    sshConfiguredHostPickerLoadingSubtitle: "Comprobando la configuración SSH local y known_hosts mediante el puente de escritorio.",
    sshConfiguredHostPickerEmptyTitle: "No hay hosts SSH sugeridos",
    sshConfiguredHostPickerEmptySubtitle: "Introduce los detalles SSH manualmente o actualiza después de cambiar tu configuración SSH.",
    sshConfiguredHostPickerErrorTitle: "No se pudieron cargar las sugerencias SSH",
    sshConfiguredHostPickerRefreshTitle: "Actualizar sugerencias SSH",
    sshConfiguredHostPickerRefreshingTitle: "Actualizando sugerencias SSH",
    machineSetupStepResolveRelay: "Comprobando componentes existentes",
    machineSetupStepCheckAuth: "Comprobando estado de inicio de sesión",
    machineSetupStepConfigureRelay: "Conectando al relay",
    machineSetupStepAuthRequest: "Aprueba este ordenador",
    machineSetupStepAuthWait: "Esperando aprobación",
    machineSetupStepInstallService: "Instalando servicio en segundo plano",
    machineSetupStepStartService: "Iniciando servicio en segundo plano",
    machineSetupStepVerifyService: "Verificando servicio en segundo plano",
    machineSetupRemoteSshTargetPlaceholder: "user@host",
    machineSetupRemoteSshUsernameLabel: "Usuario SSH",
    machineSetupRemoteSshUsernamePlaceholder: "ubuntu",
    machineSetupRemoteSshHostLabel: "Host SSH",
    machineSetupRemoteSshHostPlaceholder: "example.test",
    machineSetupRemoteSshPortLabel: "Puerto SSH",
    machineSetupRemoteSshPortPlaceholder: "22",
    machineSetupRemoteSshAuthMethodLabel: "Método de autenticación",
    machineSetupRemoteSshPasswordAuthLabel: "Usar contraseña",
    machineSetupRemoteSshPrivateKeyMaterialLabel: "Pegar clave privada",
    machineSetupRemoteSshPasswordLabel: "Contraseña SSH",
    relayAccess: {
      title: 'Acceso al Relay',
      footer: 'Elige cómo tu teléfono llega a este Relay.',
      statusTitle: 'Estado',
      statusNotConfigured: 'Aún no configurado',
      statusWorking: 'Comprobando el acceso al Relay',
      statusEnabled: 'Activado',
      statusDisabled: 'Desactivado',
      statusNeedsAuth: 'Inicio de sesión requerido',
      statusError: 'Error',
      statusUnknown: 'Desconocido',
      shareableUrlTitle: 'URL para compartir',
      methodTitle: 'Método de acceso',
      saveAction: 'Guardar método de acceso',
      disableAction: 'Desactivar acceso al Relay',
      refreshAction: 'Actualizar estado de acceso',
      progressStepInspect: 'Inspeccionar la configuración actual',
      progressStepCheck: 'Comprobar el estado de acceso',
      progressStepPersist: 'Guardar la configuración de acceso',
      progressStepApply: 'Aplicar la configuración de acceso',
      progressStepVerify: 'Verificar la URL de acceso',
      progressStepDisable: 'Desactivar el acceso al Relay',
      providers: {
        localOnly: {
          title: 'Solo local',
          subtitle: 'Solo este ordenador puede acceder al Relay.',
        },
        lan: {
          title: 'LAN / URL personalizada',
          subtitle: 'Usa una URL que ya tengas (IP LAN o túnel).',
        },
        tailscaleServe: {
          title: 'Tailscale Serve',
          subtitle: 'URL privada para tu tailnet (recomendado).',
        },
        tailscaleFunnel: {
          title: 'Tailscale Funnel',
          subtitle: 'URL pública mediante Funnel.',
        },
        cloudflareNamed: {
          title: 'Túnel de Cloudflare',
          subtitle: 'URL pública mediante un túnel de Cloudflare con nombre.',
        },
      },
      fields: {
        urlLabel: 'URL del Relay',
        hostnameLabel: 'Nombre de host',
        tokenLabel: 'Token',
      },
      missingUrl: 'Introduce una URL del Relay para continuar.',
      missingHostname: 'Introduce un nombre de host para continuar.',
      missingToken: 'Introduce un token para continuar.',
      webHandoffTitle: 'Ejecuta esto en tu ordenador',
      webHandoffSubtitle: 'Usa el CLI para configurar el acceso al relay, luego vuelve aquí y actualiza.',
    },
    accessEndpoints: {
      status: {
        refreshing: 'Actualizando canales de acceso',
      },
      scope: {
        availableToOtherDevices: 'Disponible para otros dispositivos',
        thisDeviceOnly: 'Solo este dispositivo',
      },
      direction: {
        makeCurrentServerReachable: 'Hacer que este servidor sea accesible',
        reachRemoteServerFromThisDevice: 'Acceder a un servidor remoto desde este dispositivo',
        unknown: 'Canal de acceso',
      },
      kind: {
        'relay-access-provider': 'Acceso relay',
        'ssh-tunnel-desktop': 'Túnel SSH de escritorio',
        'ssh-tunnel-native': 'Túnel SSH nativo',
        'server-profile-url': 'URL del servidor',
        'peer-mediation': 'Mediación entre pares',
        'manual-url': 'URL manual',
      },
      recommendedUse: {
        'multi-device': 'Mejor para otros dispositivos',
        'native-this-device': 'Funciona en esta app nativa',
        'hosted-web': 'Funciona desde la web alojada',
        'lan-only': 'Solo LAN o red privada',
        diagnostic: 'Requiere atención',
      },
      limitation: {
        'this-device-only': 'Solo este dispositivo',
        'not-hosted-web-compatible': 'No disponible para la web alojada',
        'not-public-share-url': 'No es un URL público para compartir',
        'session-scoped': 'Limitado a la sesión',
        'authentication-failed': 'La autenticación SSH falló',
        'foreground-only': 'Requiere que la app permanezca en primer plano',
        'host-key-mismatch': 'La clave SSH del host cambió',
        'host-key-rejected': 'Se rechazó la clave SSH del host',
        'host-key-untrusted': 'La clave SSH del host aún no es de confianza',
        'platform-suspended': 'Pausado mientras la app está suspendida',
        'loopback-bind-failed': 'No se pudo enlazar el puerto local del túnel',
        'network-captive-portal': 'La red interceptó la conexión SSH',
        'remote-service-unreachable': 'No se puede acceder al servicio remoto a través del túnel',
        'requires-auth': 'Requiere autenticación SSH',
        'requires-host-key-trust': 'Requiere confiar en la clave del host',
      },
      remediation: {
        tailscale: {
          install: 'Instalar Tailscale',
          login: 'Iniciar sesión en Tailscale',
          serve: {
            enable: 'Activar Tailscale Serve',
            approve: 'Aprobar Tailscale Serve',
          },
          funnel: {
            approve: 'Aprobar Tailscale Funnel',
          },
        },
        cloudflare: {
          configure: 'Configurar túnel de Cloudflare',
        },
        serverProfile: {
          configureShareableUrl: 'Configurar URL compartible',
        },
        remoteHost: {
          add: 'Añadir host remoto',
          setup: 'Configurar host remoto',
        },
        sshTunnel: {
          start: 'Iniciar túnel SSH',
          reuse: 'Usar túnel SSH existente',
          stop: 'Detener túnel SSH',
          authenticate: 'Autenticar túnel SSH',
          trustHost: 'Confiar en la clave del host SSH',
        },
      },
    },
    systemTaskOpenLogs: "Abrir registros",
    systemTaskOpenLogsFailed: "No se pudo abrir la carpeta de registros.",},

  systemStatus: {
    sections: {
      application: "Aplicación",
      updates: "Actualizaciones",
      appHealth: "Salud de la app y sincronización",
      currentServer: "Relay actual",
      identity: "Identidad conectada",
      configuredServers: "Relays configurados",
      machinesActiveServer: "Máquinas (relay activo)",
      machinesOtherServer: ({ server }: { server: string }) => `Máquinas (${server})`,
      actions: "Acciones",
    },
    application: {
      appVersion: "Versión de la app",
      nativeVersion: "Versión nativa",
      buildNumber: "Número de compilación",
      applicationId: "ID de la aplicación",
      updateChannel: "Canal de actualización",
      updateId: "ID de la actualización actual",
      runtimeVersion: "Versión de runtime",
      updateCreatedAt: "Fecha de la actualización actual",
      launchSource: "Origen del inicio",
      launchSourceEmbedded: "Binario nativo integrado",
      launchSourceOta: "Actualización OTA descargada",
      launchSourceUnknown: "Desconocido",
    },
    updates: {
      otaStatus: "Estado OTA",
      lastChecked: "Última comprobación",
      openStore: "Abrir actualización de la tienda",
      available: "Disponible",
      checkNow: "Comprobar ahora",
      checkNowSubtitle: "Comprobar manualmente si hay una OTA nueva en el canal actual.",
      applyNow: "Aplicar actualización ahora",
      disabled: "Desactivado",
      applying: "Aplicando actualización",
      readyToApply: "Lista para aplicar",
      downloading: "Descargando",
      downloadingProgress: ({ progress }: { progress: string }) => `Descargando (${progress})`,
      checking: "Comprobando",
      error: "Fallo",
      upToDate: "Actualizado",
      unknown: "Desconocido",
    },
    ui: {
      dataReady: "Datos listos",
      realtime: "Tiempo real",
      socket: "Socket (WebSocket)",
      socketLastError: ({ error }: { error: string }) => `Último error: ${error}`,
      lastSync: "Última sincronización",
    },
    server: {
      activeServer: "Relay activo",
    },
    identity: {
      accountId: "ID de cuenta",
      username: "Nombre de usuario",
    },
    servers: {
      noneConfigured: "No hay relays configurados",
      active: "Activo",
    },
    machines: {
      none: "No hay máquinas",
      status: ({ status }: { status: string }) => `Estado: ${status}`,
    },
    machine: {
      unknownHost: "Máquina desconocida",
      online: "En línea",
      offline: "Sin conexión",
      fetchDoctorSnapshot: {
        loading: "Obteniendo relay/cuenta del daemon…",
        invalid: "No se pudo leer el doctor snapshot desde la máquina",
      },
      daemonAttributionUnknown: "Relay/cuenta del daemon: desconocido",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `Daemon: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `Última comprobación: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "Desajuste",
    time: {
      secondsAgo: ({ count }: { count: number }) => `hace ${count}s`,
      minutesAgo: ({ count }: { count: number }) => `hace ${count}m`,
      hoursAgo: ({ count }: { count: number }) => `hace ${count}h`,
      daysAgo: ({ count }: { count: number }) => `hace ${count}d`,
    },
    actions: {
      runDiagnosis: "Ejecutar diagnóstico",
      runDiagnosisSubtitle: "Detecta desajustes de relay/cuenta/daemon",
      refreshMachineAttribution: "Actualizar atribución del daemon",
      refreshMachineAttributionSubtitle: "Obtén relay/cuenta del daemon para algunas máquinas en línea",
      copyJson: "Copiar JSON de Estado del sistema",
      copyJsonSubtitle: "Comparte una instantánea redactada para soporte",
    },
  },

  diagnosis: {
    title: "Diagnóstico",
    sections: {
      overview: "Resumen",
      actions: "Acciones",
      pasteDoctorJson: "Pegar doctor JSON del CLI",
      machineRuns: "Ejecuciones en máquinas",
      serverProbe: "Prueba del servidor",
      findings: "Hallazgos",
    },
    overview: {
      activeServer: "Relay activo",
      account: "Cuenta",
      onlineMachines: "Máquinas en línea (servidor activo)",
      cachedAttribution: ({ count }: { count: number }) => `${count} doctor snapshot(s) en caché disponible(s)`,
    },
    actions: {
      run: "Ejecutar diagnóstico",
      runSubtitle: "Comprueba servidor, cuenta, máquinas y el objetivo del daemon",
      copyReport: "Copiar informe de diagnóstico",
      copyReportSubtitle: "Copia un informe JSON redactado para soporte",
    },
    pasteDoctorJson: {
      footer: "Consejo: ejecuta happier doctor --json en tu ordenador y pégalo aquí.",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "Validar JSON pegado",
      ok: "El doctor JSON pegado parece válido.",
      helper: "Opcional: pega doctor JSON para diagnosticar desajustes cuando tu máquina no es accesible.",
      error: ({ error }: { error: string }) => `Doctor JSON inválido: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "La máquina devolvió un doctor snapshot inválido",
    },
    machineRuns: {
      none: "No hay máquinas en línea disponibles",
      idle: "Inactivo",
      loading: "Ejecutando…",
      ready: "Listo",
      error: "Fallo",
    },
    serverProbe: {
      title: "Diagnósticos del servidor",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "Ejecuta el diagnóstico para ver resultados",
      notRunSubtitle: "Esto ejecuta comprobaciones seguras y redactadas (sin logs salvo que incluyas diagnósticos en un informe).",
      none: "No se detectaron problemas",
      noneSubtitle: "Si el problema persiste, envía un reporte con diagnósticos.",
      code: ({ code }: { code: string }) => `Código: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `Detalles para ${code}`,
        steps: {
          reportIssue: "Envía un reporte e incluye este informe de diagnóstico.",
        },
      },
      serverMismatch: {
        title: "Desajuste de servidor (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          chooseAccount: "Decide qué servidor/cuenta quieres usar.",
          switchUiServer: "Cambia la UI al mismo servidor que el daemon (o viceversa).",
          restartDaemon: "Reinicia el daemon apuntando al servidor correcto y vuelve a intentar.",
        },
      },
      serverMismatchPasted: {
        title: "Desajuste de servidor (UI vs doctor pegado)",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • Pegado: ${pasted}`,
      },
      settingsMismatch: {
        title: "Desajuste entre settings del CLI y servidor resuelto",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • resuelto: ${resolved}`,
      },
      accountMismatch: {
        title: "Desajuste de cuenta (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          signInSameAccount: "Asegúrate de que UI y CLI estén en la misma cuenta y servidor.",
          cliReauth: "En CLI: cierra sesión y autentica de nuevo en el servidor correcto.",
        },
      },
      machineMissingAccount: {
        title: "La máquina no tiene información de cuenta",
      },
      noOnlineMachines: {
        title: "No hay máquinas en línea",
        steps: {
          startDaemon: "Inicia el daemon (y asegúrate de que siga ejecutándose).",
          checkNetwork: "Comprueba la red e inténtalo de nuevo.",
        },
      },
      serverDiagnosticsDisabled: {
        title: "Diagnósticos del servidor deshabilitados",
        steps: {
          ok: "Esto es normal si tu servidor tiene los diagnósticos deshabilitados.",
        },
      },
      serverAuthError: {
        title: "Error de autenticación del servidor (401)",
      },
      serverUnreachable: {
        title: "Servidor inaccesible",
        steps: {
          checkServerUrl: "Verifica la URL del servidor y tu red.",
          tryAgain: "Inténtalo de nuevo en un momento.",
        },
      },
      serverHttpError: {
        title: "Error HTTP en diagnósticos del servidor",
        subtitle: ({ status }: { status: string }) => `El servidor respondió con ${status}`,
      },
      activeServerNotInProfiles: {
        title: "El servidor activo no está en los perfiles guardados",
      },
      multipleServers: {
        title: "Se detectaron varios servidores entre máquinas",
      },
    },
  },

  connectedServices: {
    fallbackName: "Servicio conectado",
    serviceNames: {
      claudeSubscription: "Suscripción de Claude",
      openaiCodex: "Codex de OpenAI",
      openai: "Clave API de OpenAI",
      anthropic: "Clave API de Anthropic",
      gemini: "Gemini de Google",
      github: "GitHub",

      bitbucket: "Bitbucket",},
    title: "Servicios conectados",
    authChip: {
      label: "Autenticación",
      labelWithCount: ({ count }: { count: number }) => `Autenticación: ${count}`,
      nativeLabel: "Nativa",
      connectedCountLabel: ({ count }: { count: number }) => `${count} conectados`,
    },
    authSwitch: {
      switchFailed: 'No se pudo cambiar la autenticación de esta sesión.',
      confirmAction: 'Cambiar autenticación',
      errors: {
        groupGenerationConflict: 'El grupo de cuentas cambió antes de que se completara el cambio. Actualiza la lista de cuentas e inténtalo de nuevo.',
        providerStateSharingRequired: 'Provider state sharing must be enabled before this account can be used for the running session.',
        notGroupSelection: 'Choose an account group so Happier can switch away from an exhausted account automatically.',
        connectedServiceRequired: 'Choose a connected account before using this recovery action for the session.',
        profileActionRequired: 'The selected connected account needs attention before it can be used.',
        providerStateSharingUnavailable: 'No se pudieron comprobar los ajustes de uso compartido del estado del proveedor en esta máquina. Actualiza la conexión del daemon e inténtalo de nuevo.',
        profileDisconnected: 'La cuenta conectada seleccionada debe volver a autenticarse antes de poder usarse.',
        profileMissing: 'La cuenta conectada seleccionada ya no está disponible. Actualiza la lista de cuentas y elige otra.',
        groupMissing: 'El grupo de cuentas seleccionado ya no está disponible. Actualiza la lista de cuentas y elige otro grupo.',
        metadataUpdateFailed: 'La sesión no pudo guardar la nueva selección de autenticación. Inténtalo de nuevo cuando termine de sincronizarse.',
        restartFailed: 'La sesión no pudo reiniciarse con la nueva selección de autenticación. Detén la sesión e inténtalo de nuevo.',
        hotApplyFailed: 'La sesión en ejecución rechazó la nueva selección de autenticación. Reinicia la sesión e inténtalo de nuevo.',
        agentMismatch: 'Esta selección de autenticación no coincide con el backend de la sesión.',
        sessionNotFound: 'Esta sesión ya no está disponible en la máquina seleccionada.',
        unsupportedService: 'Este backend no admite el servicio conectado seleccionado.',
      },
      status: {
        liveApplied: 'Autenticación cambiada en la sesión en ejecución',
        credentialsRefreshed: 'Autenticación actualizada',
        restarting: 'Reiniciando sesión',
        appliesOnNextResume: 'Se aplica al reanudar la próxima vez',
        retry: 'Authentication switch needs retry',
        partialApplication: "Autenticación cambiada parcialmente",
        partialApplicationServiceFailed: ({ service }: { service: string }) => `${service}: autenticación fallida`,
        partialApplicationServiceNotApplied: ({ service }: { service: string }) => `${service}: autenticación no aplicada`,
      },
      partialApply: {
        title: 'Autenticación cambiada parcialmente',
        body: 'La cuenta nueva se guardó, pero aplicarla a esta sesión en ejecución no se completó del todo. Reintenta o revierte para mantener esta sesión en la cuenta anterior.',
        retry: 'Reintentar aplicar a esta sesión',
        revert: 'Revertir a la cuenta anterior',
      },
    },
    errors: {
      credentialReferencedByGroup: 'Esta cuenta conectada se usa en un grupo de cuentas. Al desconectarla se eliminará de esos grupos y se limpiará como activa cuando sea necesario.',
      runtimeCooldown: ({ time }: { time: string }) => `This account is cooling down until ${time}.`,
      runtimeCooldownOverrideTitle: '¿Cambiar a una cuenta en espera?',
      runtimeCooldownOverrideBody: ({ time }: { time: string }) =>
        `This account is cooling down until ${time}. Switch manually anyway?`,
      runtimeCooldownOverrideConfirm: 'Cambiar igualmente',
      unknownResetTime: 'una hora desconocida',
      generationConflict: 'Este grupo de cuentas cambió antes de completar la acción. Actualiza la lista de cuentas e inténtalo de nuevo.',
      generationConflictWithGeneration: ({ generation }: { generation: number }) =>
        `This account group changed before the action completed. Refresh the account list and try again. Current generation: ${generation}.`,
      generationRequired: 'Esta acción necesita una versión reciente del grupo de cuentas. Actualiza la lista de cuentas e inténtalo de nuevo.',
      groupNotFound: 'Este grupo de cuentas ya no existe. Actualiza la lista de cuentas e inténtalo de nuevo.',
      groupMemberNotFound: 'Esta cuenta ya no pertenece al grupo. Actualiza la lista de cuentas e inténtalo de nuevo.',
      profileNotFound: 'Esta cuenta conectada ya no existe. Actualiza la lista de cuentas e inténtalo de nuevo.',
      activeProfileNotMember: 'Solo los miembros habilitados del grupo pueden marcarse como activos.',
      fallbackDisabled: 'La reserva de cuentas está desactivada en este servidor.',
      duplicateMember: 'Esta cuenta ya está en el grupo.',
      groupAlreadyExists: 'Ya existe un grupo de cuentas con este id.',
      invalidGroup: 'Este grupo de cuentas no es válido. Revisa su configuración e inténtalo de nuevo.',
      requestFailedWithStatus: ({ status }: { status: number }) => `The connected-service request failed (${status}). Refresh and try again.`,
      generic: 'La acción del servicio conectado falló. Actualiza e inténtalo de nuevo.',
    },
    diagnostics: {
      title: {
        provider_session_state_unavailable_for_resume: 'Cambio no disponible',
        connected_service_materialization_identity_missing: 'Falta la identidad del servicio conectado',
        resume_reachability_inputs_missing: 'No se puede verificar la reanudación de la sesión',
        metadata_update_failed: 'La selección de autenticación no se guardó',
        no_eligible_group_member: 'No hay cuenta de respaldo disponible',
        recovery_retry_scheduled: 'La recuperación del proveedor está programada',
                recovery_dead_lettered: 'La recuperación del proveedor requiere atención',
                provider_account_adoption_mismatch: 'El proveedor no cambió de cuenta',
                post_switch_verification_failed: 'No se pudo verificar la cuenta del proveedor',
                connected_service_credential_reconnect_required: "La cuenta conectada necesita reconexión",
                connected_service_credential_refresh_unavailable: "La actualización de la cuenta conectada no está disponible temporalmente",
                claude_subscription_missing_claude_code_scope: 'El acceso a Claude Code necesita reconexión',
        claude_subscription_native_auth_materialization_failed: 'No se pudieron preparar las credenciales de Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'El token de configuración de Claude no puede iniciar el modo Unified',
      },
      status: {
        providerSessionStateUnavailableForResume: "No se pudo trasladar el estado de la sesión",
        providerAccountAdoptionMismatch: "El proveedor permaneció en otra cuenta",
        postSwitchVerificationFailed: "No se pudo verificar la cuenta del proveedor",
        recoveryRetryScheduled: "Reintento de recuperación del proveedor programado",
        metadataUpdateFailed: "No se pudo guardar la selección de autenticación",
        noEligibleGroupMember: "No hay una cuenta alternativa elegible",
        provider_session_state_unavailable_for_resume: 'No se pudo transferir el estado de la sesión',
        connected_service_materialization_identity_missing: 'Falta la identidad del servicio conectado',
        resume_reachability_inputs_missing: 'No se puede verificar la reanudación de la sesión',
        metadata_update_failed: 'No se pudo guardar la selección de autenticación de la sesión',
        no_eligible_group_member: 'Ninguna cuenta de respaldo es apta',
        recovery_retry_scheduled: 'Reintento de recuperación del proveedor programado',
                recovery_dead_lettered: 'La recuperación del proveedor alcanzó su límite de reintentos',
                provider_account_adoption_mismatch: 'El proveedor permaneció en otra cuenta',
                post_switch_verification_failed: 'No se pudo verificar la cuenta del proveedor',
                connected_service_credential_reconnect_required: "La cuenta conectada necesita reconexión",
                connected_service_credential_refresh_unavailable: "La actualización de la cuenta conectada falló temporalmente",
                claude_subscription_missing_claude_code_scope: 'Vuelve a conectar la suscripción de Claude para Claude Code',
        claude_subscription_native_auth_materialization_failed: 'No se pudo preparar la autenticación nativa de Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Vuelve a conectar Claude con OAuth para el modo Unified',
      },
      body: {
        default: "Revisa las cuentas conectadas e inténtalo de nuevo.",
        provider_session_state_unavailable_for_resume: 'Revisa las cuentas conectadas, inicia una sesión nueva con la cuenta seleccionada o continúa con la cuenta actual.',
        connected_service_materialization_identity_missing: 'A esta sesión le falta la identidad del servicio conectado necesaria para reutilizar el estado materializado del proveedor. Inicia una sesión nueva con la cuenta seleccionada o continúa con la cuenta actual.',
        resume_reachability_inputs_missing: 'El daemon no pudo verificar el estado de reanudación del proveedor porque faltaban datos necesarios.',
        metadata_update_failed: 'La sesión no pudo guardar la nueva selección de autenticación. Vuelve a intentarlo cuando la sesión termine de sincronizar.',
        no_eligible_group_member: 'Ninguna cuenta de este grupo es apta actualmente para respaldo. Revisa las cuentas conectadas y reconecta un perfil si es necesario.',
        recovery_retry_scheduled: 'Happier programó un reintento de recuperación del proveedor. Puedes reintentar ahora o revisar las cuentas conectadas.',
                recovery_dead_lettered: 'Happier agotó los reintentos automáticos de recuperación del proveedor. Revisa las cuentas conectadas o reconecta el perfil seleccionado.',
                provider_account_adoption_mismatch: 'El proveedor permaneció en otra cuenta después del cambio. Revisa las cuentas conectadas o reintenta el cambio.',
                post_switch_verification_failed: 'Happier no pudo verificar que el proveedor adoptara la cuenta seleccionada. Revisa las cuentas conectadas o reintenta el cambio.',
                connected_service_credential_reconnect_required: "La cuenta conectada seleccionada debe volver a conectarse antes de poder reanudar esta sesión. Vuelve a conectar el perfil y vuelve a intentarlo.",
                connected_service_credential_refresh_unavailable: "Happier no pudo actualizar la cuenta conectada seleccionada. Vuelve a intentarlo en un momento.",
                claude_subscription_missing_claude_code_scope: 'Este perfil de Claude se conectó antes de que se concedieran los permisos de Claude Code. Vuelve a conectarlo y reintenta la sesión o el cambio de grupo.',
        claude_subscription_native_auth_materialization_failed: 'Happier no pudo crear el archivo de credenciales nativas de Claude Code para este perfil. Vuelve a conectar el perfil o elige otro miembro del grupo.',
        claude_subscription_setup_token_not_supported_for_unified: 'El modo Claude Unified debe iniciar la CLI de Claude con credenciales OAuth nativas. Vuelve a conectar este perfil con OAuth en lugar de un token de configuración.',
      },
      actions: {
        viewLatestFork: "Ver última bifurcación",
        viewNativeFork: "Ver bifurcación nativa",
      },
    },
    reconnect: {
      identityMismatchTitle: 'Se detecto una cuenta de proveedor diferente',
      identityMismatchBody: 'Esta credencial parece pertenecer a otra cuenta del proveedor. Continua solo si quieres reemplazar la identidad guardada para este perfil.',
      identityMismatchConfirm: 'Reemplazar identidad',
      targetMismatch: 'Esta reconexión devolvió credenciales para otro perfil conectado. Inicia la reconexión de nuevo desde el perfil de destino.',
    },
    defaultAuth: {
      poolSuggestion: {
        body: ({ pool }: { pool: string }) => `Usa el grupo ${pool} para que las sesiones roten y eviten los límites de uso.`,
        accept: "Usar grupo",
        dismiss: "Descartar",
      },
      title: "Configuración predeterminada del backend",
      footer:
        "Elige qué cuenta conectada debe usar cada backend cuando empieza una sesión nueva.",
      agentDetailTitle: "Autenticación predeterminada",
      agentDetailFooter:
        "Esto escribe el mismo valor predeterminado que se usa desde la configuración de servicios conectados.",
      rowDetail: "Predeterminado",
      warning: {
        connected_profile_unavailable:
          "La cuenta conectada predeterminada no está disponible; se usa la autenticación nativa.",
        connected_group_unavailable:
          "El grupo conectado predeterminado no está disponible; se usa la autenticación nativa.",
        connected_group_disabled:
          "Los grupos conectados están desactivados aquí; se usa la autenticación nativa.",
        connected_service_unsupported:
          "Este backend no admite ese servicio conectado; se usa la autenticación nativa.",
      },
    },
    list: {
      empty: "No hay servicios conectados todavía.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "conectado", plural: "conectados" })}`,
      needsReauth: "requiere reautenticación",
      notConnected: "no conectado",
    },
    providerStateSharing: {
      title: "Uso compartido del estado del proveedor",
      footer: "La autenticación de servicios conectados permanece aislada. La configuración y el estado de sesión solo se comparten cuando el proveedor lo admite de forma segura.",
      configTitle: "Compartir configuración del proveedor",
      agentConfigTitle: ({ agent }: { agent: string }) => `Compartir configuración de ${agent}`,
      configLinkedTitle: "Vincular configuración activa",
      configLinkedSubtitle: "Usa enlaces cuando sea compatible para que las sesiones conectadas lean la configuración actual del proveedor.",
      configCopiedTitle: "Copiar instantánea de configuración",
      configCopiedSubtitle: "Copia la configuración del proveedor cada vez que se materializa la autenticación.",
      configIsolatedTitle: "Mantener configuración aislada",
      configIsolatedSubtitle: "No compartas la configuración nativa del proveedor con los homes de servicios conectados.",
      stateTitle: "Compartir sesiones y estado del proveedor",
      agentStateTitle: ({ agent }: { agent: string }) => `Compartir sesiones y estado de ${agent}`,
      stateEnabledSubtitle: "Permite que los proveedores compatibles reanuden las mismas sesiones entre autenticación nativa y conectada.",
      stateDisabledSubtitle: "Mantén separadas las sesiones y el estado local del proveedor salvo que un flujo específico active el uso compartido.",
      sharedStatePrivacyTitle: "Compartir estado del proveedor",
      sharedStatePrivacyBody: ({ agent }: { agent: string }) =>
        `${agent} puede leer archivos locales de sesión del proveedor desde homes de servicios conectados. Actívalo solo para cuentas que aceptes vincular.`,
      unavailable: {
        notImplemented: "El uso compartido aún no está disponible para este proveedor.",
        dynamicDiagnosticsRequired: "El uso compartido necesita una comprobación de disponibilidad en tiempo de ejecución antes de activarse.",
      },
    },
    quota: {
      loading: "Cargando…",
      error: ({ message }: { message: string }) => `Error: ${message}`,
      lastUpdated: ({ time }: { time: string }) =>
        `Última actualización: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Última actualización: ${time} • desactualizado`,
      noData: "Aún no hay datos de cuota",
      planLabel: ({ plan }: { plan: string }) => `Plan: ${plan}`,
      remaining: ({ percent }: { percent: string }) => `Queda ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `Queda ${percent} · se restablece en ${reset}`,
      usageCount: ({ used, limit }: { used: number; limit: number }) => `${used}/${limit} usado`,
      recoveryCreditTitle: ({ count }: { count: number }) => count === 1 ? '1 restablecimiento de uso disponible' : `${count} restablecimientos de uso disponibles`,
      recoveryCreditSubtitle: 'Aplica un restablecimiento de uso para recuperar el límite agotado al instante.',
      recoveryCreditExpires: ({ time }: { time: string }) => `El primero caduca ${time}.`,
      recoveryCreditApplying: 'Aplicando…',
      recoveryCreditMachineUnavailable: 'Ninguna máquina disponible puede aplicar este restablecimiento ahora.',
      recoveryCreditNothingToReset: 'Actualmente no es necesario restablecer ninguna ventana de uso agotada.',
      recoveryCreditBadge: ({ count }: { count: number }) => count === 1 ? '1 restablecimiento' : `${count} restablecimientos`,
      duration: {
        now: 'ahora',
        outdated: 'Desactualizado',
        daysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    account: {
      configurationTitle: 'Ajustes de la cuenta',
      configurationUpdatedTitle: 'Ajustes de la cuenta actualizados',
      configurationInvalid: 'Los ajustes de la cuenta no son válidos. Revisa cada campo y usa un origen HTTPS exacto y sin credenciales donde sea necesario.',
      configurationRefreshApplied: 'Se guardaron los nuevos ajustes y se actualizó la cuenta conectada.',
      configurationReconnectApplied: 'Se guardaron los nuevos ajustes y se volvió a conectar la cuenta conectada.',
      refreshA11y: 'Actualizar uso y límites',
      usedDetail: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit} usado`,
      usageCaption: 'Uso',
      resetsCaption: 'Restablecimientos',
      poolsLabel: 'Grupos',
      poolsCount: ({ count }: { count: number }) => count === 1 ? '1 grupo' : `${count} grupos`,
      planEmailSubtitle: ({ plan, email }: { plan: string; email: string }) => `${plan} · ${email}`,
      activeMemberA11y: 'Cuenta activa',
      setActiveA11y: 'Marcar cuenta como activa',
      memberEnabledLabel: 'Cuenta habilitada',
      resets: {
        now: 'ahora',
        inDays: ({ days }: { days: number }) => days === 1 ? 'en 1 día' : `en ${days} días`,
        available: 'Restablecimiento de uso disponible',
        rowLabel: ({ date, countdown }: { date: string; countdown: string }) =>
          countdown ? `Caduca ${date} · ${countdown}` : `Caduca ${date}`,
        confirmTitle: '¿Aplicar restablecimiento de uso?',
        confirmMessage: 'Esto consumirá un restablecimiento disponible para esta cuenta conectada.',
        confirmCta: 'Aplicar restablecimiento',
        use: 'Usar',
      },
    },
    pools: {
      title: 'Grupos',
      autoBadge: 'Automático',
      manualBadge: 'Modo manual',
      memberWarningsA11y: ({ count }: { count: number }) =>
        count === 1 ? '1 miembro necesita atención' : `${count} miembros necesitan atención`,
      create: {
        title: 'Crear pool',
        subtitle: 'Agrupa cuentas conectadas para fallback automático.',
      },
      empty: {
        title: 'Aún no hay pools',
        subtitle: 'Crea un pool para enrutar sesiones entre varias cuentas conectadas.',
      },
      loadError: {
        title: "No se pudieron cargar los pools",
        subtitle: "No se pudieron cargar los pools de cuentas. Comprueba tu conexión e inténtalo de nuevo.",
        staleTitle: "Mostrando los últimos pools conocidos",
        staleSubtitle: "No se pudo actualizar la lista de pools más reciente. Inténtalo de nuevo para actualizarla.",
        retry: "Intentar de nuevo",
      },
      detail: {
        summaryTitle: 'Resumen',
        summary: ({ count, strategy }: { count: number; strategy: string }) =>
          `${count} cuenta${count === 1 ? '' : 's'} · ${strategy}`,
        membersTitle: 'Miembros',
        moveUp: 'Mover arriba',
        moveDown: 'Mover abajo',
        noMembersTitle: 'Aún no hay miembros',
        noMembersSubtitle: 'Añade una cuenta conectada a este pool.',
        serverActiveStatusTitle: "Guardado en el servidor",
        serverActiveStatusSubtitle: "Esta es la cuenta activa duradera. Las máquinas sin conexión la aplicarán cuando vuelvan a conectarse; esta pantalla no afirma que todas las máquinas hayan convergido.",
        manualApplyDivergenceTitle: "Cambiado en el servidor, no en las sesiones activas",
        manualApplyDivergenceSubtitle: ({ detail }: { detail: string }) => `La cuenta activa cambió en el servidor, pero no se pudo aplicar a las sesiones activas (${detail}). Reinténtalo o revierte para mantener todo en la cuenta anterior.`,
        manualApplyRetry: "Reintentar aplicar a las sesiones activas",
        manualApplyRevert: "Volver a la cuenta anterior",
        machineTarget: {
            title: "No se puede aplicar a una sesión en ejecución",
            noBoundSession: "Ninguna sesión en ejecución está usando este pool ahora mismo, así que el cambio no se puede aplicar en vivo. Inicia una sesión en este pool e inténtalo de nuevo.",
            offline: "La máquina que ejecuta la sesión de este pool está desconectada, así que el cambio no puede llegar a ella. Vuelve a conectar la máquina e inténtalo de nuevo.",
        },
        behaviorTitle: 'Comportamiento',
        advancedTitle: 'Avanzado',
        advancedSubtitle: 'Ajusta los activadores de fallback y el comportamiento de recuperación.',
      },
      behavior: {
        autoRestorePrimaryTitle: 'Restaurar principal tras el restablecimiento',
        autoRestorePrimarySubtitle: 'Vuelve a la cuenta principal cuando se restablezca su límite de uso.',
        switchOnGroupSubtitle: 'Permite que esta condición active un cambio automático de pool.',
        switchOn: {
          usageLimit: 'Límite de uso',
          authExpired: 'Autenticación caducada',
          accountChanged: 'Cuenta cambiada',
          refreshFailure: 'Actualización fallida',
        },
      },
      delete: {
        title: 'Eliminar pool',
        subtitle: 'Elimina este pool y su configuración de fallback.',
        confirmTitle: '¿Eliminar pool?',
        confirmMessage: ({ name }: { name: string }) =>
          `¿Eliminar ${name}? Las sesiones ya no usarán este pool.`,
      },
    },
    oauthPaste: {
      invalidConfig: "Configuración de servicio conectado no válida.",
      connectWebGroupTitle: "Conectar (web)",
      connectWebDescription:
        "Abre la URL de autorización, completa OAuth en tu navegador y luego copia/pega la URL final redirigida de vuelta en Happier.",
      openAuthorizationUrl: "Abrir URL de autorización",
      opensInNewTab: "Se abre en una nueva pestaña",
      preparing: "Preparando…",
      pasteRedirectUrl: "Pegar URL de redirección",
      pasteRedirectUrlPlaceholder: "Pegar URL de redirección",
      pasteRedirectUrlPromptBody:
        "Después de completar OAuth, copia la URL final redirigida desde la barra de direcciones del navegador y pégala aquí.",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "Siguiente paso: inicia sesión en la página que se abre. Claude puede mostrar un código en lugar de redirigir automáticamente.",
          pasteRedirectUrlPromptBody:
            "1) Inicia sesión en la página que se abre. 2) Copia la URL final o el valor completo \"code#state\" que muestra Claude. 3) Pégalo en el campo de abajo.",
          pasteRedirectUrlPlaceholder: "Pegar URL de redirección o code#state",
          errors: {
            missingState:
              "Falta el estado OAuth. Si Claude muestra un código, copia el valor completo \"code#state\", no solo el código.",
          },
        },
      },
      tryDeviceInstead: "Probar autenticación por dispositivo",
      tryEmbeddedInstead: "Probar navegador integrado",
      working: "Trabajando…",
      alerts: {
        connectedTitle: "Conectado",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) está conectado.`,
        failedToOpenUrl: "No se pudo abrir la URL",
        failedToConnect: "No se pudo conectar",
      },
      errors: {
        missingState: "Falta el estado OAuth en la URL de redirección.",
        stateMismatch: "El estado OAuth no coincide.",
      },
    },
    oauthEmbedded: {
      title: "Conectar (navegador en la app)",
      description:
        "Inicia sesión en un navegador integrado. Si falla, usa el método de pegar la redirección.",
      startButton: "Iniciar sesión",
    },
    deviceAuth: {
      invalidConfig: "Configuración del servicio conectado no válida.",
      title: "Conectar (dispositivo)",
      description:
        "Abre la página de verificación, introduce el código y mantén esta pantalla abierta hasta que se complete la conexión.",
      openVerificationUrl: "Abrir página de verificación",
      userCode: "Código de usuario",
      securityHint:
        "Consejo: toca Copiar para copiar el código. Introdúcelo solo en auth.openai.com. No lo compartas con nadie.",
      deviceAuthDisabledHint:
        "Si la página de verificación indica que la autorización por código de dispositivo está desactivada, activa “Habilita la autorización por código de dispositivo para Codex” en la configuración de ChatGPT e inténtalo de nuevo.",
      preparing: "Preparando…",
      waiting: "Esperando aprobación…",
      polling: "Comprobando aprobación…",
      usePasteInstead: "Usar URL de redirección pegada",
      useBrowserInstead: "Usar navegador integrado",
      alerts: {
        connectedTitle: "Conectado",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) está conectado.`,
        failedToConnect: "No se pudo conectar",
        failedToStart: "No se pudo iniciar la autenticación del dispositivo",
      },
    },
    detail: {
      segments: { accounts: "Cuentas", pools: "Piscinas" },
      unknownService: "Servicio conectado desconocido.",
      actionsGroupTitle: "Acciones",
      actions: {
        setDefault: "Establecer como predeterminado",
        unsetDefault: "Quitar predeterminado",
        editLabel: "Editar etiqueta",
        reconnect: "Reconectar",
        openAccount: "Abrir cuenta",
      },
      setDefaultProfileTitle: "Establecer perfil predeterminado",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Predeterminado: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Elige qué perfil se selecciona de forma predeterminada",
      setProfileLabelTitle: "Establecer etiqueta del perfil",
      setProfileLabelSubtitle:
        "Etiqueta opcional mostrada en los selectores de autenticación",
      addOauthProfileSubtitle: "Conectar un perfil de cuenta nuevo",
      addOauthProfileDeviceTitle: "Añadir con autenticación del dispositivo",
      addOauthProfileDeviceSubtitle: "Recomendado para web/entornos remotos",
      addOauthProfilePasteTitle: "Añadir pegando redirección",
      addOauthProfilePasteSubtitle: "Flujo manual de copiar/pegar URL de redirección",
      addOauthProfileBrowserTitle: "Añadir con navegador en la app",
      addOauthProfileBrowserSubtitle: "Usa un navegador integrado cuando sea compatible",
      connectApiKeyTitle: "Conectar con clave API",
      connectApiKeySubtitle: "Pega una clave API de Anthropic",
      connectSetupTokenTitle: "Conectar con setup-token",
      connectSetupTokenSubtitle: "Pega un setup-token de Claude (de claude setup-token)",
      connectAccessTokenTitle: "Conectar con token de acceso",
      connectAccessTokenSubtitle: "Pega un token de acceso personal de GitHub",
      openGithubTokenTemplateTitle: "Crear token de GitHub",
      openGithubTokenTemplateSubtitle: "Abre GitHub con los permisos que Happier necesita ya rellenados",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `¿Desconectar ${service} (${profileId})?`,
      disconnectGroupCleanupConfirmBody: ({ service, profileId, groups }: { service: string; profileId: string; groups: string }) =>
        `¿Desconectar ${service} (${profileId}) y quitarlo de ${groups}?`,
      prompts: {
        profileIdTitle: "ID de perfil",
        profileIdBody: "Usa una etiqueta corta como work, personal o alt.",
        apiKeyTitle: "Clave API",
        apiKeyBody: "Pega tu clave API de Anthropic.",
        apiKeyPlaceholder: "p. ej. sk-ant-…",
        setupTokenTitle: "Token de configuración",
        setupTokenBody: "Pega tu setup-token de Claude (de claude setup-token).",
        setupTokenPlaceholder: "p. ej. sk-ant-oat01-…",
        accessTokenTitle: "Token de acceso",
        accessTokenBody: "Pega tu token de acceso personal de GitHub. Usa un token de permisos detallados con Contenidos, Pull requests y Administración en lectura y escritura para que los flujos de PR y publicación de repositorios puedan ejecutarse.",
        accessTokenPlaceholder: "github_pat_…",
        profileLabelTitle: "Etiqueta de perfil",
        profileLabelBody: "Opcional. Se muestra en los selectores de autenticación.",
        profileLabelPlaceholder: "Cuenta de trabajo",

        personalAccessTokenTitle: "Token de acceso personal",
        personalAccessTokenBody: "Pega tu token de acceso personal granular de GitHub.",
        personalAccessTokenPlaceholder: "github_pat_…",
        apiTokenTitle: "Token API",
        apiTokenBody: "Pega tu token API del proveedor o una contraseña de app.",
        apiTokenPlaceholder: "Token API",},
      alerts: {
        invalidProfileIdTitle: "ID de perfil no válido",
        invalidProfileIdBody: "Usa letras, números, guion o guion bajo (máx. 64).",
        unknownProfileTitle: "Perfil desconocido",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `No existe un perfil llamado \"${profileId}\" para ${service}.`,
        failedToOpenTokenSetupUrl: "No se pudo abrir la configuración del token de GitHub.",
      },
      profiles: {
        empty: "Aún no hay perfiles.",
        connected: "Conectado",
        defaultBadge: "Predeterminado",
        needsReauth: "Requiere reautenticación",
      },
      groups: {
        title: "Grupos de cuentas",
        empty: "Aún no hay grupos de cuentas.",
        subtitle: ({ count }: { count: number }) => `${count} cuentas`,
        subtitleWithActive: ({ profileId, count }: { profileId: string; count: number }) =>
          `Activo: ${profileId} • ${count} cuentas`,
        actionsTitle: "Acciones del grupo de cuentas",
        createTitle: "Crear grupo de cuentas",
        createSubtitle: "Agrupa perfiles conectados para la recuperación con fallback.",
        noProfilesTitle: "No hay perfiles conectados",
        noProfilesBody: "Conecta al menos un perfil antes de crear un grupo de cuentas.",
        invalidGroupTitle: "ID de grupo no válido",
        invalidGroupBody: "Usa letras, números, puntos, guiones o guiones bajos (máx. 64).",
        statusReady: "Listo",
        statusSwitching: "Cambiando",
        statusExhausted: "Agotado",
        statusError: "Con error",
        statusUnknown: "Desconocido",
        statusNeedsMembers: "Necesita miembros habilitados",
        activeMember: ({ profileId }: { profileId: string }) => `Activo: ${profileId}`,
        enabledMembers: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} habilitados`,
        autoFallbackEnabled: "Respaldo automático activado",
        autoFallbackDisabled: "Respaldo automático desactivado",
        strategyPriority: "Orden de prioridad",
        strategyLeastLimited: "Menos limitado primero",
        strategyManual: "Cambio manual",
        priority: ({ priority }: { priority: string }) => `Prioridad ${priority}`,
        cooldown: ({ time }: { time: string }) => `En enfriamiento hasta ${time}`,
        memberActive: "Miembro activo",
        memberEnabled: "Activado",
        memberDisabled: "Desactivado",
        memberPriority: ({ priority }: { priority: number }) => `Prioridad ${priority}`,
        memberExhaustedUntil: ({ time }: { time: string }) => `Agotado hasta ${time}`,
        memberQuotaExhaustedUntil: ({ time }: { time: string }) => `Uso limitado hasta ${time}`,
        memberRateLimitedUntil: ({ time }: { time: string }) => `Límite de frecuencia hasta ${time}`,
        memberCapacityLimitedUntil: ({ time }: { time: string }) => `Capacidad limitada hasta ${time}`,
        memberAuthInvalidUntil: ({ time }: { time: string }) => `Autenticación no válida hasta ${time}`,
        memberPlanUnavailableUntil: ({ time }: { time: string }) => `Plan no disponible hasta ${time}`,
        memberValidationBlockedUntil: ({ time }: { time: string }) => `Validación bloqueada hasta ${time}`,
        memberLastFailure: ({ reason }: { reason: string }) => `Último problema: ${reason}`,
        warningNoEnabledMembers: "No hay miembros habilitados disponibles para el respaldo.",
        warningNoFallbackMember: "Agrega o habilita otro miembro antes de que el respaldo automático pueda cambiar de cuenta.",
        deleteTitle: "¿Eliminar grupo de cuentas?",
        deleteBody: ({ groupId }: { groupId: string }) => `¿Eliminar \"${groupId}\"? Los perfiles seguirán conectados.`,
        prompts: {
          groupIdTitle: "ID del grupo",
          groupIdBody: "Usa una etiqueta corta como team, work o fallback.",
          groupIdPlaceholder: "equipo",
        },
      },
      groupActions: {
        editTitle: "Editar grupo",
        searchMembersPlaceholder: "Buscar perfiles",
        noProfilesAvailable: "No hay perfiles conectados disponibles.",
        membersTitle: "Miembros",
        membersSubtitle: "Marca los perfiles que quieres incluir en este grupo.",
        accountFallbackDisabled: "El fallback automático está desactivado en este servidor.",
        enableFallback: "Habilitar respaldo automático",
        disableFallback: "Deshabilitar respaldo automático",
        makeActive: "Hacer activo",
        useManualStrategy: "Usar cambio manual",
        usePriorityStrategy: "Usar orden de prioridad",
        activeMember: "Miembro activo",
        manualApplyFailedTitle: "Cuenta cambiada, actualización del daemon incompleta",
        manualApplyFailedBody: "La cuenta activa cambió en el servidor, pero una o más sesiones locales en ejecución no pudieron actualizarse. Reinicia o reanuda esas sesiones si siguen usando la cuenta anterior.",
        enableMember: "Activar miembro",
        disableMember: "Desactivar miembro",
        editPriority: "Editar prioridad",
        priorityTitle: "Prioridad del miembro",
        priorityBody: "Los números más bajos se prueban primero.",
        invalidPriorityTitle: "Prioridad no válida",
        invalidPriorityBody: "Introduce un número entero.",
        removeMember: "Quitar miembro",
        removeMemberConfirmTitle: "Quitar miembro",
        removeMemberConfirmBody: ({ profileId }: { profileId: string }) => `¿Quitar "${profileId}" de este grupo?`,
        runtimeFallbackUnsupported: 'La conmutación automática no está disponible para este servicio conectado.',
        removeMembersConfirmBody: ({ count, members }: { count: number; members: string }) => `¿Quitar ${count === 1 ? "este miembro" : `estos ${count} miembros`} de este Pool?\n\n${members}`,
        manageMembersTitle: 'Gestionar miembros',
        manageMembersSubtitle: ({ count, total }: { count: number; total: number }) => `${count} de ${total} cuentas`,
      },
      groupDetail: {
        routeTitle: "Grupo",
        nameTitle: "Nombre del grupo",
        namePromptBody: "Elige el nombre que se mostrará en ajustes y selectores de autenticación.",
        groupIdTitle: "ID del grupo",
        membersTitle: "Miembros",
        membersSubtitle: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} habilitados`,
        optionsTitle: "Opciones",
        autoSwitchTitle: "Respaldo automático",
        autoSwitchEnabledSubtitle: "Cambia a otro miembro cuando la cuenta activa necesita recuperación.",
        autoSwitchDisabledSubtitle: "Sigue usando el miembro activo hasta que lo cambies manualmente.",
        strategyTitle: "Estrategia de selección",
        strategyPriorityTitle: "Orden de prioridad",
        strategyPrioritySubtitle: "Prueba primero los números de prioridad más bajos.",
        strategyLeastLimitedTitle: "Menos limitado primero",
        strategyLeastLimitedSubtitle: "Prefiere el miembro con más cuota utilizable.",
        strategyManualTitle: "Cambio manual",
        strategyManualSubtitle: "Usa solo el miembro activo hasta que se cambie manualmente.",
        softSwitchThresholdTitle: "Umbral de cambio suave",
        softSwitchThresholdSubtitle: ({ percent }: { percent: string }) => `Cambiar por debajo del ${percent}% restante cuando haya un miembro mejor disponible.`,
        softSwitchThresholdPromptTitle: "Umbral de cambio suave",
        softSwitchThresholdPromptBody: "Introduce el porcentaje restante a partir del cual Happier debe preferir una cuenta más segura. Usa 0 para desactivar el cambio suave.",
        invalidSoftSwitchThresholdTitle: "Umbral no válido",
        invalidSoftSwitchThresholdBody: "Introduce un número de 0 a 100.",
        staleProbeTitle: "Comprobar cuota antigua después de",
        staleProbeSubtitle: ({ minutes }: { minutes: string }) => `Volver a comprobar cuando los datos de cuota tengan más de ${minutes} min.`,
        staleProbePromptTitle: "Comprobar cuota antigua después de",
        staleProbePromptBody: "Introduce cuántos minutos pueden reutilizarse los datos de cuota antes de que Happier vuelva a comprobarlos.",
        invalidStaleProbeTitle: "Intervalo de comprobación no válido",
        invalidStaleProbeBody: "Introduce al menos 1 minuto.",
        switchBudgetTitle: "Límites de cambio automático",
        switchBudgetSubtitle: ({ perTurn, perHour }: { perTurn: string; perHour: string }) => `Hasta ${perTurn} cambios automáticos por turno y ${perHour} por hora de sesión.`,
        recoveryModeTitle: "Modo de recuperación",
        recoveryModeOffSubtitle: "No recuperar este grupo automáticamente.",
        recoveryModeWaitUntilResetSubtitle: "Espera a que se restablezca el límite y luego reanuda.",
        recoveryModeSwitchThenResumeSubtitle: "Cambia a otro miembro y luego reanuda.",
        recoveryModeSwitchOrWaitSubtitle: "Cambia a otro miembro cuando sea posible; si no, espera el restablecimiento.",
        recoveryPromptTitle: "Prompts de recuperación",
        recoveryPromptSubtitle: "Usa los prompts estándar de recuperación y reanudación para este grupo.",
        missingTitle: "Grupo no encontrado",
        missingBody: ({ service, groupId }: { service: string; groupId: string }) =>
          `No existe ningún grupo llamado "${groupId}" para ${service}.`,
      },

      connectPersonalAccessTokenTitle: "Conectar token de acceso personal",
      connectPersonalAccessTokenSubtitle: "Pega un token de acceso personal granular",
      connectApiTokenTitle: "Conectar token API",
      connectApiTokenSubtitle: "Pega un token API del proveedor o una contraseña de app",
      openTokenSetupTitle: "Abrir configuración del token",
      openTokenSetupSubtitle: "Abre la página de configuración del proveedor",
      openPersonalAccessTokenSetupTitle: "Crear token de acceso personal",
      openPersonalAccessTokenSetupSubtitle: "Abre la configuración del token granular de GitHub",},
    profile: {
      profileId: "ID de perfil",
      status: "Estado",
      email: "Correo",
      accountId: "ID de cuenta",
      providerAccountId: "ID de cuenta del proveedor",
      quotaTitle: "Cuotas",
      defaultSubtitle: "Este perfil está seleccionado por defecto",
      setDefaultSubtitle: "Usar este perfil por defecto",
      disconnectSubtitle: "Eliminar credenciales de este perfil",
      reconnectSubtitle: "Reautenticar este perfil",
      replaceTokenSubtitle: "Sustituir las credenciales de este perfil",
      connectionGroupTitle: "Conexión",
      connectedVia: "Conectado mediante",
      connectedViaToken: "Token de acceso",
      connectedViaOauth: "OAuth",
      lastRefreshed: "Última actualización",
      refreshQuotaNow: "Actualizar cuota ahora",
      refreshQuotaNowSubtitle: "Obtén el uso más reciente de esta cuenta.",
      poolsGroupTitle: "Piscinas",
      pools: {
        emptyTitle: "En ningún Pool",
        emptySubtitle: "Agrega esta cuenta a un Pool para el respaldo automático.",
      },
      addToPool: "Agregar a un Pool",
      addToPoolSubtitle: "Usa esta cuenta como respaldo en un Pool.",
      settingsGroupTitle: "Ajustes",
      setDefaultRowTitle: "Establecer como predeterminada",
      removeGroupTitle: "Eliminar",
    },
    authModal: {
      nativeAuthTitle: "Autenticación nativa del backend",
      nativeAuthSubtitle: "Usa tu login local del CLI / claves API",
            groupSubtitle: 'Grupo de cuentas',
      connectedServicesTitle: "Usar servicios conectados",
      connectedServicesSubtitle: "Obtener y materializar desde la nube de Happier",
      notConnectedTitle: "No hay servicios conectados",
      notConnectedSubtitle: "Toca para abrir configuración",
      profileLabel: "Perfil",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Archivo demasiado grande",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Se omitieron ${count} ${plural({ count, singular: "archivo", plural: "archivos" })} que superan el tamaño máximo de adjunto.`,
      noClipboardImageTitle: "No hay imagen en el portapapeles",
      noClipboardImageBody: "Copia una imagen y pégala como adjunto.",
    },
  },

  settingsAttachments: {
    disabled: {
      title: "Adjuntos",
      footer:
        "Esta función está deshabilitada por tu servidor o por la política de compilación.",
    },
    fileUploads: {
      title: "Subidas de archivos",
    },
    uploadLocation: {
      title: "Ubicación de subida",
      footer:
        "Las subidas en el espacio de trabajo son la opción más compatible. Las subidas al directorio temporal del sistema pueden ser útiles para evitar artefactos en el repositorio, pero pueden no ser legibles en sandboxes más estrictos.",
      options: {
        workspace: {
          title: "Directorio del espacio de trabajo (recomendado)",
          subtitle:
            "Las subidas se escriben en un directorio relativo al espacio de trabajo para que el sandbox del agente pueda leerlas de forma fiable.",
        },
        osTemp: {
          title: "Directorio temporal del sistema",
          subtitle:
            "Las subidas se escriben en el directorio temporal del sistema. Esto puede fallar en sandboxes más estrictos.",
        },
      },
    },
    workspaceDirectory: {
      title: "Directorio del espacio de trabajo",
      footer:
        "Solo se usa cuando la ubicación de subida está configurada como Directorio del espacio de trabajo.",
      uploadsDirectory: {
        title: "Directorio de subidas",
        promptTitle: "Directorio de subidas",
        promptMessage:
          "Introduce un directorio relativo al espacio de trabajo (sin rutas absolutas, sin ..).",
        invalidDirectoryTitle: "Directorio no válido",
        invalidDirectoryMessage: "Usa una ruta relativa como .happier/uploads.",
      },
    },
    sourceControlIgnore: {
      title: "Ignorar en control de versiones",
      footer:
        "Los ignorados solo locales evitan commits accidentales. Si eliges .gitignore, esto puede modificar un archivo rastreado.",
      options: {
        gitInfoExclude: {
          title: "Ignorar localmente (.git/info/exclude) (recomendado)",
          subtitle:
            "Evita commits accidentales sin modificar archivos del repositorio.",
        },
        gitignore: {
          title: "Ignorar mediante .gitignore",
          subtitle:
            "Escribe una entrada en el archivo .gitignore del espacio de trabajo (puede confirmarse).",
        },
        none: {
          title: "No escribir reglas de ignorado",
          subtitle:
            "Las subidas pueden ser detectadas por el control de versiones según la configuración del repositorio.",
        },
      },
      writeIgnoreRules: {
        title: "Escribir reglas de ignorado",
      },
    },
    limits: {
      title: "Límites",
      footer:
        "Estos límites los aplica el manejador local de subidas del CLI (mejor esfuerzo).",
      invalidValueTitle: "Valor no válido",
      maxAttachmentSize: {
        title: "Tamaño máximo del adjunto (bytes)",
        promptTitle: "Tamaño máximo del adjunto (bytes)",
        promptMessage: "Ejemplo: 26214400 para 25MB.",
        invalidValueMessage: "Introduce un número entre 1024 y 1073741824.",
      },
    },
  },

  settingsSourceControl: {
    title: 'Archivos y control de código fuente',
    editor: 'Editor de archivos',
    editorFooter: 'Configura el comportamiento del editor de archivos.',
    editorAutoSave: 'Guardado automático',
    editorAutoSaveDescription: 'Guarda los archivos automáticamente después de editarlos.',
    markdownEditMode: {
      title: 'Modo de edición Markdown predeterminado',
      footer: 'Elige cómo se abren los archivos Markdown para editar. El modo enriquecido ofrece un editor WYSIWYG; el modo sin formato edita el código Markdown directamente. Los archivos que no se pueden convertir de forma segura en ambos sentidos siempre se abren sin formato.',
      options: {
        rich: {
          title: 'Enriquecido (WYSIWYG)',
          subtitle: 'Edita Markdown visualmente con formato en vivo.',
        },
        raw: {
          title: 'Texto sin formato',
          subtitle: 'Edita el código Markdown directamente.',
        },
      },
      disabledReason: {
        mdx: 'Editando como texto sin formato porque es un archivo MDX.',
        tooLarge: 'Editando como texto sin formato porque este archivo es demasiado grande para el editor enriquecido.',
        referenceLinks: 'Editando como texto sin formato porque este archivo contiene enlaces de tipo referencia.',
        footnotes: 'Editando como texto sin formato porque este archivo contiene notas al pie.',
        htmlOrJsx: 'Editando como texto sin formato porque este archivo contiene HTML o JSX.',
      },
    },
    commitStrategy: {
      title: "Estrategia de commit",
      footer:
        "El commit atómico evita interferencias entre agentes en el índice. El staging de Git habilita flujos interactivos de incluir/excluir.",
      options: {
        atomic: {
          title: "Commit atómico (recomendado)",
          subtitle:
            "Sin staging en vivo en el índice del repositorio. Confirma todos los cambios pendientes en una sola operación RPC.",
        },
        gitStaging: {
          title: "Flujo de staging de Git",
          subtitle:
            "Habilita incluir/excluir y staging parcial por líneas para repositorios Git.",
        },
      },
    },
    gitRoutingPreference: {
      title: "Preferencia de enrutamiento para .git",
      footer:
        "Selecciona qué backend preferir cuando el modo del repositorio es .git.",
      options: {
        git: {
          title: "Los repositorios .git usan Git",
          subtitle: "Predeterminado y recomendado por compatibilidad.",
        },
        sapling: {
          title: "Los repositorios .git prefieren Sapling",
          subtitle:
            "Usa Sapling cuando estén disponibles tanto Git como Sapling.",
        },
      },
    },
    remoteConfirmation: {
      title: "Confirmación remota",
      footer: "Controla si las operaciones pull/push requieren confirmación.",
      pull: {
        title: "Preguntar antes de hacer pull",
        subtitle: "Muestra una confirmación antes de traer cambios remotos.",
      },
      push: {
        title: "Preguntar antes de hacer push",
        subtitle: "Muestra una confirmación antes de subir commits locales.",
      },

      confirmBeforePulling: {
        title: "Confirmar antes de hacer pull",
        subtitle: "Pregunta antes de descargar y fusionar cambios remotos.",
      },
      confirmBeforePushing: {
        title: "Confirmar antes de hacer push",
        subtitle: "Pregunta antes de subir commits locales al remoto.",
      },
      options: {
        always: {
          title: "Confirmar siempre pull/push",
          subtitle: "Muestra diálogos de confirmación para pull y push.",
        },
        pushOnly: {
          title: "Confirmar solo push",
          subtitle: "Pull se ejecuta de inmediato; push requiere confirmación.",
        },
        never: {
          title: "No confirmar nunca",
          subtitle: "Ejecuta pull y push inmediatamente.",
        },
      },},
    pushRejectionRecovery: {
      title: "Recuperación ante rechazo de push",
      footer:
        "Comportamiento cuando el push se rechaza porque la rama está detrás del upstream.",
      options: {
        promptFetch: {
          title: "Pedir confirmación para fetch",
          subtitle:
            "Pregunta antes de ejecutar fetch cuando el push no fast-forward es rechazado.",
        },
        autoFetch: {
          title: "Fetch automático",
          subtitle:
            "Ejecuta fetch automáticamente tras un rechazo no fast-forward.",
        },
        manual: {
          title: "Recuperación manual",
          subtitle: "No ejecutar fetch automáticamente tras el rechazo del push.",
        },
      },
    },
    commitMessageGenerator: {
      title: "Generador de mensajes de commit",
      footer:
        "Opcional: genera sugerencias de mensajes de commit usando una tarea LLM de una sola ejecución. Requiere soporte de execution runs en el daemon.",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `Backend del generador: ${backendId}`,
      backendItemSubtitle:
        "ID de backend usado para la generación puntual de mensajes de commit.",
      backendPromptTitle: "Backend de mensajes de commit",
      backendPromptMessage: "Introduce el ID del backend",
      instructionsPlaceholder: "Instrucciones del mensaje de commit",
    },
    commitAttribution: {
      title: "Atribución del commit",
      footer:
        "Cuando está habilitado, los mensajes de commit generados por IA incluirán créditos Co-Authored-By.",
      includeCoAuthoredBy: {
        title: "Incluir Co-Authored-By",
      },
    },
    filesDisplay: {
      title: "Visualización de archivos",
      footer:
        "El resaltado de sintaxis es experimental y puede deshabilitarse para diffs muy grandes.",
      diffRenderer: {
        options: {
          pierre: {
            title: "Renderizador de diff: Pierre",
            subtitle:
              "Mejor renderizado de diffs en web/escritorio. Usa una canalización con worker y hace fallback de forma segura si no está disponible.",
          },
          happier: {
            title: "Renderizador de diff: Happier",
            subtitle:
              "Renderizador de respaldo para compatibilidad y solución de problemas.",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Diseño de diff: Unificado",
            subtitle:
              "Vista en línea (una columna). Mejor para pantallas estrechas y lectura rápida.",
          },
          split: {
            title: "Diseño de diff: Lado a lado",
            subtitle:
              "Vista dividida (dos columnas). Mejor para pantallas grandes y comparaciones precisas.",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "Resaltado de sintaxis: Desactivado",
            subtitle:
              "Renderiza diffs y archivos como texto monoespaciado plano.",
          },
          simple: {
            title: "Resaltado de sintaxis: Simple",
            subtitle:
              "Resaltado rápido basado en tokens para lenguajes comunes.",
          },
          advanced: {
            title: "Resaltado de sintaxis: Avanzado",
            subtitle:
              "Resaltado de mayor fidelidad en web/escritorio; vuelve a simple en nativo.",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "Densidad de archivos cambiados: Cómoda",
            subtitle:
              "Filas más grandes con subtítulos y estado más claros.",
          },
          compact: {
            title: "Densidad de archivos cambiados: Compacta",
            subtitle:
              "Filas más pequeñas para escanear más fácilmente cuando cambian muchos archivos.",
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
      }) => `Diff predeterminado de ${backendTitle}: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "Modo predeterminado al ver archivos con cambios incluidos y pendientes.",
    },
    diffMode: {
      pending: "Pendiente",
      combined: "Combinado",
      included: "Incluido",
    },
  },

  settingsDesktop: {
    title: 'Escritorio',
    footer: 'Controla las integraciones de escritorio de Tauri en este ordenador.',
    startOnLoginTitle: 'Iniciar al acceder',
    startOnLoginSubtitle: 'Inicia Happier automáticamente cuando inicies sesión en este ordenador.',

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
    title: 'Mascotas',
    previewTitle: 'Blink compañero',
    previewSubtitle: 'Un pequeño compañero para el estado de la sesión y las revisiones pendientes.',
    disabledTitle: 'Las mascotas están desactivadas',
    disabledSubtitle: 'Activa Mascotas en Funciones para usar compañeros en este dispositivo.',
    disabledByServerTitle: 'Este servidor ha desactivado las mascotas',
    disabledByServerSubtitle: 'Tu administrador ha desactivado los compañeros de mascota para este servidor.',
    accountTitle: 'Valor predeterminado de la cuenta',
    enabledTitle: 'Activar mascotas',
    enabledSubtitle: 'Muestra superficies de compañía para esta cuenta.',
    companionSizeTitle: 'Tamaño de la mascota',
    companionSizeSubtitle: 'Ajusta el tamaño del compañero en este dispositivo.',
    companionSizeValue: ({ percent }: { percent: number }) => `${percent}%`,
    deviceOverrideTitle: 'Usar en este dispositivo',
    deviceOverrideSubtitle: 'Reemplaza localmente el ajuste de mascota de la cuenta.',
    sourceTitle: 'Origen de la mascota',
    builtInSubtitle: 'Incluido en Happier.',
    builtInBlinkSubtitle: 'Convierte señales de sesión en pequeñas luces de estado tranquilas.',
    builtInFurySubtitle: 'Prueba flujos complicados antes de que lleguen a producción.',
    builtInMiloSubtitle: 'Mantiene la UI ordenada y duerme sobre tests fallidos.',
    builtInOliSubtitle: 'Envía arreglos sigilosos antes de que el build se entere.',
    builtInTitiSubtitle: 'Clasifica notas de release con enfoque de staff sénior.',
    localLibraryTitle: 'Este dispositivo',
    localLibraryFooter: 'Las mascotas locales permanecen en este dispositivo salvo que las importes a tu cuenta.',
    helpDocsTitle: 'Ayuda de mascotas',
    helpDocsSubtitle: 'Abre la documentación de Happier para configuración y solución de problemas.',
    detectCodexPetsTitle: 'Detectar mascotas de Codex',
    detectCodexPetsSubtitle: 'Busca mascotas compatibles en los Codex homes locales.',
    detectedCodexPetsTileSubtitle: 'Encontrada en Codex y lista para unirse a este dispositivo.',
    detectedCodexPetsEmptyTitle: 'No se encontraron mascotas de Codex',
    detectedCodexPetsEmptySubtitle: 'Crea una en Codex y vuelve a ejecutar la detección.',
    detectedCodexPetsErrorTitle: 'No se pudieron detectar mascotas de Codex',
    detectedCodexPetsErrorSubtitle: 'Comprueba que el daemon esté conectado e inténtalo de nuevo.',
    detectedCodexPetsNoTargetTitle: 'No hay ningún daemon disponible',
    detectedCodexPetsNoTargetSubtitle: 'Inicia Happier en este ordenador y vuelve a detectar mascotas de Codex.',
    detectedCodexPetsDaemonMismatchTitle: 'Actualiza el daemon para detectar mascotas',
    detectedCodexPetsDaemonMismatchSubtitle: 'Este daemon aún no expone la detección de mascotas. Actualiza el stack e inténtalo de nuevo.',
    useOnThisDeviceTitle: 'Usar en este dispositivo',
    useOnThisDeviceSubtitle: 'Selecciona una mascota local sin cambiar el valor predeterminado de la cuenta.',
    importedLocalSubtitle: 'Importada desde Codex en este dispositivo.',
    removeFromDeviceTitle: 'Eliminar del dispositivo',
    removeFromDeviceSubtitle: 'Elimina esta mascota local de este dispositivo.',
    accountLibraryTitle: 'Biblioteca de la cuenta',
    accountLibraryFooter: 'Las mascotas sincronizadas están disponibles en tus dispositivos conectados.',
    accountPetTileSubtitle: 'Sincronizada desde tu cuenta.',
    removeFromDeviceDaemonErrorTitle: 'Eliminada localmente; falló la limpieza del daemon',
    removeFromDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `La mascota se eliminó de la lista de este dispositivo, pero la limpieza del daemon devolvió ${code}.`,
    importToDeviceDaemonErrorTitle: 'No se pudo importar la mascota',
    importToDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `El daemon no pudo importar esta mascota. Vuelve a detectar las mascotas de Codex e inténtalo otra vez. (${code})`,
    importToAccountTitle: 'Importar a la cuenta',
    importToAccountSubtitle: 'Sube una mascota local compatible para usarla entre dispositivos.',
    desktopOverlayTitle: 'Superposición de escritorio',
    overlayTrayTitle: 'Actividad de la mascota',
    overlayStatusWaiting: 'En espera',
    overlayStatusFailed: 'Error',
    overlayStatusReview: 'Revisión',
    overlayStatusRunning: 'En ejecución',
    overlayQuickReplyPlaceholder: 'Respuesta rápida',
    overlayReplyAction: 'Responder',
    overlayQuickReplyAction: 'Enviar respuesta rápida',
    overlayDismissAction: 'Descartar actividad',
    overlayTuckAction: 'Ocultar',
    overlayClosePetAction: 'Cerrar mascota',
    desktopOverlayEnabledTitle: 'Activar superposición de escritorio',
    desktopOverlayEnabledSubtitle: 'Muestra la mascota en una ventana transparente de compañía de escritorio.',
    desktopOverlayDeviceOverrideTitle: 'Superposición de escritorio en este dispositivo',
    desktopOverlayVisibilityModeTitle: 'Visibilidad de la superposición en este dispositivo',
    desktopOverlayVisibilityModeSubtitle: 'Elige cuándo aparece la mascota de escritorio localmente.',
    desktopOverlayResetPositionTitle: 'Restablecer posición',
    desktopOverlayResetPositionSubtitle: 'Devuelve la superposición a la esquina inferior derecha.',
    overrideInherit: 'Valor de la cuenta',
    overrideEnabled: 'Activado',
    overrideDisabled: 'Desactivado',
    visibilityModeInherit: 'Valor de la cuenta',
    visibilityModeAlwaysWhenEnabled: 'Siempre que esté activada',
    visibilityModeAttentionOrActive: 'Atención o activo',
    visibilityModeAttentionOnly: 'Solo atención',
  },

  settingsNotifications: {
    badges: {
      title: 'Insignias en este dispositivo',
      footer: 'Elige qué actividad contribuye a la insignia del icono de la app en este dispositivo.',
      enabledTitle: 'Habilitar insignias',
      enabledSubtitle: 'Mostrar una insignia en el icono de la app cuando la actividad requiera atención',
      unreadTitle: 'Sesiones sin leer',
      unreadSubtitle: 'Contar las sesiones que tienen actividad de transcripción sin leer',
      permissionRequestsTitle: 'Solicitudes de permiso',
      permissionRequestsSubtitle: 'Contar las sesiones que esperan aprobación',
      userActionsTitle: 'Solicitudes de acción',
      userActionsSubtitle: 'Contar las sesiones que esperan una respuesta o confirmación',
      queuedTitle: 'Entrada de usuario en cola',
      queuedSubtitle: 'Contar las sesiones con trabajo en cola que aún tienes que enviar',
      friendRequestsTitle: 'Solicitudes de amistad',
      friendRequestsSubtitle: 'Añadir las solicitudes de amistad entrantes a la insignia numérica',
      desktopDotTitle: 'Punto en el dock de escritorio',
      desktopDotSubtitle: 'En escritorio, mostrar un punto cuando solo exista actividad no numérica en la bandeja de entrada',
    },
    local: {
      title: 'Notificaciones locales en este dispositivo',
      footer: 'Estos controles afectan a cómo aparecen las notificaciones en este dispositivo concreto.',
      enabledSubtitle: 'Permitir que este dispositivo muestre notificaciones locales',
      readyTitle: 'Listo',
      readySubtitle: 'Muestra una notificación local cuando termina un turno',
      readyPreviewTitle: 'Vista previa de mensajes listos',
      readyPreviewSubtitle: 'Incluye el último mensaje del asistente en las notificaciones de listo de este dispositivo',
      permissionRequestsTitle: 'Solicitudes de permiso',
      permissionRequestsSubtitle: 'Muestra una notificación local cuando una sesión necesita aprobación',
      userActionsTitle: 'Solicitudes de acción',
      userActionsSubtitle: 'Muestra una notificación local cuando una sesión necesita tu intervención',
    },
    desktop: {
      title: 'Notificaciones de escritorio',
      footer: 'Comprueba la entrega de notificaciones locales para esta app de escritorio.',
      permission: {
        title: 'Permiso del sistema',
        checkingSubtitle: 'Comprobando el permiso de notificaciones de macOS',
        grantedSubtitle: 'macOS permite que esta app envíe notificaciones',
        notGrantedSubtitle: 'Toca para solicitar el permiso de notificaciones de macOS',
        errorSubtitle: 'No se pudo leer el permiso de notificaciones de macOS',
      },
    },
    push: {
      title: "Notificaciones push",
      footer:
        "Estas notificaciones se envían desde tu CLI mediante Expo cuando tu sesión necesita atención.",
      enabledSubtitle: "Permitir notificaciones push en esta cuenta",
      troubleshootTitle: "Solucionar problemas",
      troubleshootSubtitle: "Ver permisos y dispositivos registrados",
    },
    pushPriming: {
        title: '¿Activar las notificaciones?',
        body: 'Happier puede avisarte cuando un agente termina, necesita una decisión de permiso o está esperándote. Puedes cambiarlo cuando quieras en Ajustes.',
        accept: 'Activar',
        decline: 'Ahora no',
        blockedTitle: 'Las notificaciones están bloqueadas',
        blockedBody: 'Las notificaciones están desactivadas para esta app en los ajustes del sistema. Abre los ajustes para permitirlas.',
        openSettings: 'Abrir ajustes',
        openSettingsFailed: 'No se pudieron abrir los ajustes del sistema.',
    },
    pushTroubleshooting: {
      status: {
        title: "Estado",
        footer:
          "Comprueba el ajuste de la cuenta, el permiso del sistema y el estado de registro en el servidor.",
        accountSettingTitle: "Ajuste de la cuenta",
        accountSettingEnabledSubtitle:
          "Las notificaciones push están habilitadas en esta cuenta",
        accountSettingDisabledSubtitle:
          "Las notificaciones push están deshabilitadas en esta cuenta",
      },
      permission: {
        title: "Permiso",
        loading: "Cargando…",
        loadingSubtitle: "Comprobando permisos de notificaciones",
        runtimeUnavailable: 'No disponible',
        runtimeUnavailableSubtitle: 'No se pudo acceder al servicio de notificaciones en este dispositivo.',
        runtimeTimeoutSubtitle: 'El servicio de notificaciones no respondió. Revisa la conexión con el servidor de desarrollo y reinténtalo.',
        unsupported: "No compatible",
        unsupportedSubtitle: "Los permisos push no están disponibles en la web.",
        allowed: "Permitido",
        allowedSubtitle: "Las notificaciones están permitidas para esta app.",
        denied: "Denegado",
        notRequested: "No solicitado",
        canAskAgainSubtitle: "Toca para solicitar permiso.",
        openSettingsSubtitle: "Toca para abrir la configuración del sistema.",
      },
      token: {
        title: "Este dispositivo",
        subtitle: ({ fingerprint }: { fingerprint: string }) =>
          `Token actual: ${fingerprint}`,
        unavailableSubtitle: "No se pudo leer un token push de Expo.",
        checkingSubtitle: 'Leyendo el token de este dispositivo…',
        runtimeUnavailableSubtitle: 'No se pudo acceder al servicio de notificaciones en este dispositivo.',
        runtimeTimeoutSubtitle: 'El servicio de notificaciones no respondió a tiempo.',
        deviceUnavailableSubtitle: 'Esta compilación no puede proporcionar un token push. Comprueba que las notificaciones push estén habilitadas para esta compilación.',
        registered: "Registrado",
      },
      actions: {
        title: "Acciones",
        footer: "Usa estos pasos si las notificaciones push no están llegando.",
        requestPermissionTitle: "Solicitar permiso",
        requestPermissionSubtitle: "Pide al sistema el permiso de notificaciones.",
        reregisterTitle: "Volver a registrar el token",
        reregisterSubtitle:
          "Enviar de nuevo el token de este dispositivo al servidor.",
        refreshTitle: "Actualizar",
        refreshSubtitle: "Recargar permiso, token y dispositivos del servidor.",
      },
      devices: {
        title: "Dispositivos registrados",
        footer: ({ count, serverUrl }: { count: string; serverUrl: string }) =>
          `${count} token${Number(count) === 1 ? "" : "s"} en ${serverUrl}`,
        emptyTitle: "Sin dispositivos",
        emptySubtitle:
          "No hay tokens push registrados en el servidor para esta cuenta.",
        clientServerUrl: ({ url }: { url: string }) => `Servidor: ${url}`,
        registeredAt: ({ at }: { at: string }) => `Registrado: ${at}`,
        lastSeenAt: ({ at }: { at: string }) => `Visto por última vez: ${at}`,
        thisDevice: "Este dispositivo",
      },
      loadError: "No se pudo cargar el estado de las notificaciones push.",
      authRequired: "Inicia sesión para gestionar las notificaciones push.",
      remove: {
        confirmTitle: "Eliminar dispositivo",
        confirmBody: ({ fingerprint }: { fingerprint: string }) =>
          `¿Eliminar el token push ${fingerprint}?`,
        error: "No se pudo eliminar el token push.",
      },
    },
    webhooks: {
      title: 'Notificaciones por webhook',
      footer: 'Envía notificaciones de actividad remota a endpoints webhook adicionales en esta cuenta.',
      addTitle: 'Añadir webhook',
      addSubtitle: 'Enviar notificaciones a otro endpoint',
      emptyTitle: 'No hay canales webhook',
      emptySubtitle: 'Añade un webhook para entregar eventos de actividad remota fuera de Expo push.',
      enabledTitle: 'Habilitar webhook',
      enabledSubtitle: 'Las notificaciones por webhook están habilitadas',
      disabledSubtitle: 'Las notificaciones por webhook están deshabilitadas',
      channelEnabledSubtitle: 'Permite que este endpoint reciba notificaciones de actividad',
      urlPromptTitle: 'URL del webhook',
      urlPromptSubtitle: 'Introduce la URL de destino para este webhook de notificaciones.',
      urlPromptPlaceholder: 'https://hooks.example.test/notify',
      invalidUrlTitle: 'URL de webhook no válida',
            invalidUrlSubtitle: 'Introduce una URL HTTP o HTTPS válida.',
            deleteTitle: 'Eliminar webhook',
            deleteConfirm: ({ url }: { url: string }) => `¿Dejar de enviar notificaciones a ${url}?`,
            signingSecretTitle: 'Secreto de firma',
            signingSecretEmptySubtitle: 'Añade un secreto compartido para firmar los payloads del webhook',
            signingSecretConfiguredSubtitle: 'Los payloads del webhook se firman con un secreto compartido',
            signingSecretPromptTitle: 'Secreto de firma del webhook',
            signingSecretPromptSubtitleAdd: 'Introduce un secreto compartido para firmar este payload del webhook.',
            signingSecretPromptSubtitleReplace: 'Introduce un nuevo secreto compartido para reemplazar el secreto de firma existente.',
            signingSecretPromptPlaceholder: 'shared-secret',
            signingSecretClearAction: 'Borrar secreto',
            readyTitle: 'Listo',
      readySubtitle: 'Enviar cuando termina un turno y el agente está esperando tu instrucción',
      readyPreviewTitle: 'Vista previa de mensajes listos',
      readyPreviewSubtitle: 'Incluir el texto del último mensaje del asistente en las notificaciones de listo de este webhook',
      permissionRequestsTitle: 'Solicitudes de permiso',
      permissionRequestsSubtitle: 'Enviar cuando una sesión está bloqueada esperando aprobación',
      userActionsTitle: 'Solicitudes de acción',
      userActionsSubtitle: 'Enviar cuando una sesión necesita una respuesta o confirmación',
    },
    foregroundBehavior: {
      title: "Notificaciones en la app",
      footer:
        "Controla las notificaciones mientras usas la app. Las notificaciones de la sesión que estás viendo siempre se silencian.",
      full: "Completas",
      fullDescription: "Mostrar banner y reproducir sonido",
      silent: "Silenciosas",
      silentDescription: "Mostrar banner sin sonido",
      off: "Desactivadas",
      offDescription: "Solo insignia, sin banner",

      account: "Predeterminado de la cuenta",
      accountDescription:
        "Usar el comportamiento de notificaciones en la app de la cuenta en este dispositivo",},
    types: {
      title: "Tipos",
      footer:
        "Desactiva tipos individuales si solo quieres ciertas alertas.",
      ready: {
        title: "Listo",
        subtitle:
          "Notificar cuando un turno termina y el agente está esperando tu comando",
      },
      readyPreview: {
        title: 'Vista previa de mensajes listos',
        subtitle: 'Incluir el texto del último mensaje del asistente en las notificaciones push de turnos listos',
      },
      permissionRequests: {
        title: "Solicitudes de permiso",
        subtitle:
          "Notificar cuando una sesión está bloqueada esperando una aprobación",
      },
      userActions: {
        title: "Solicitudes de acción",
        subtitle: "Notificar cuando una sesión necesita una respuesta o confirmación",
      },
    },

    activitySurfaces: {
      title: 'Superficies de actividad',
      footer: 'Controla Live Activities, Dynamic Island y widgets en este dispositivo.',
      enabledSubtitle: 'Activa las superficies de sesión visibles en este dispositivo',
      shared: {
        title: 'Comportamiento compartido',
        footer: 'Elige cómo deben comportarse los toques y el contenido de vista previa en todas las superficies de actividad.',
      },
      tapTargetTitle: 'Destino del toque',
      tapTargetOpenSessionTitle: 'Abrir la sesión actual',
      tapTargetOpenSessionsTitle: 'Abrir sesiones activas',
      privacyTitle: 'Privacidad',
      privacyStatusOnlyTitle: 'Solo estado',
      privacyTitleOnlyTitle: 'Solo título',
      privacyIncludePreviewTitle: 'Incluir texto de vista previa',
      liveActivities: {
        title: 'Live Activities',
        footer: 'Controla la presentación en la pantalla bloqueada y en Dynamic Island en iPhone.',
        enabledSubtitle: 'Activa las Live Activities en este dispositivo',
        strategyTitle: 'Activity strategy',
        strategySubtitle: 'Elige si una actividad sigue la sesión más importante o se mantiene fijada.',
        focusedTitle: 'Sesión enfocada',
        attentionTitle: 'Atención',
        runningTitle: 'Sesiones en curso',
        dynamicPrimaryTitle: 'Dynamic primary',
        pinnedPrimaryTitle: 'Pinned primary',
        sessionSpecificTitle: 'Session specific',
        presentationTitle: 'Modo de presentación',
        presentationSubtitle: 'Elige cómo Live Activities debe destacar la sesión actual.',
        maxConcurrentTitle: 'Máximo de actividades simultáneas',
        maxConcurrentOneTitle: '1 actividad',
        maxConcurrentTwoTitle: '2 actividades',
        maxConcurrentFourTitle: '4 actividades',
        previewTextTitle: 'Texto de vista previa',
        actionButtonsTitle: 'Botones de acción',
        includeReadyTitle: 'Incluir sesiones listas',
        includeThinkingTitle: 'Incluir sesiones pensando',
        remoteUpdates: {
          title: 'Actualizaciones remotas',
          footer: 'Diagnóstico del servidor seleccionado para actualizar Live Activities cuando la app ya no está en primer plano.',
          effectiveModeTitle: 'Entrega efectiva',
          effectiveMode: {
            hosted_happier_relay: 'Relay alojado',
            direct_apns: 'APNs directo',
            background_wake_best_effort: 'Reactivación en segundo plano',
            local_only: 'Solo runtime local',
            disabled: 'Desactivado',
          },
          details: {
            available: 'Disponible',
            unavailable: 'No disponible',
            blocked: 'Bloqueado',
            missingCredentials: 'Faltan credenciales',
            bestEffort: 'Mejor esfuerzo',
            selected: 'Seleccionado',
            fallback: 'Reserva',
            preferred_unavailable: 'Solo local',
            local_only: 'Solo local',
            disabled: 'Desactivado',
            runtimeOnly: 'Solo runtime',
          },
          hostedRelayTitle: 'Relay alojado de Happier',
          hostedRelayAvailableSubtitle: 'El relay alojado está configurado para este servidor seleccionado.',
          hostedRelayDisabledSubtitle: 'El relay alojado está desactivado para este servidor self-hosted.',
          hostedRelayBlockedSubtitle: 'La identidad del relay alojado y el soporte del proveedor aún no están implementados.',
          hostedRelayUnavailableSubtitle: 'El relay alojado no está disponible desde este servidor seleccionado.',
          directApnsTitle: 'APNs directo',
          directApnsConfiguredSubtitle: 'Las credenciales de APNs directo están configuradas sin exponer material secreto.',
          directApnsMissingCredentialsSubtitle: 'A APNs directo le falta configuración de credenciales del servidor.',
          directApnsUnavailableSubtitle: 'APNs directo no está disponible para este servidor seleccionado.',
          backgroundWakeTitle: 'Reactivación en segundo plano',
          backgroundWakeBestEffortSubtitle: 'La reactivación en segundo plano puede intentar actualizar, pero iOS puede aplazarla o descartarla.',
          backgroundWakeDisabledSubtitle: 'La alternativa de reactivación en segundo plano está desactivada en este servidor seleccionado.',
          localOnlyTitle: 'Actualizaciones solo locales',
          localOnlyRuntimeSubtitle: 'Las actualizaciones solo locales funcionan mientras el runtime de la app puede ejecutarse; no prometen actualizaciones con la app cerrada.',
        },
      },
      widgets: {
        title: 'Widgets de la pantalla de inicio',
        footer: 'Controla la vista general de widgets que se muestra en la pantalla de inicio de tu dispositivo.',
        enabledSubtitle: 'Activa los widgets en este dispositivo',
        summaryTitle: 'Resumen',
        attentionTitle: 'Atención',
        runningTitle: 'Sesiones en curso',
        previewTextTitle: 'Texto de vista previa',
        machinePathTitle: 'Máquina y ruta',
      },
    },
    quietHours: {
      title: 'Horas de silencio',
      footer: 'Las horas de silencio de la cuenta se aplican en todas partes por defecto. Las anulaciones del dispositivo solo afectan a este dispositivo.',
      accountOffTitle: 'Sin horas de silencio de la cuenta',
      accountOffSubtitle: 'Entregar notificaciones de la cuenta en cualquier momento',
      accountNightlyTitle: 'Cada noche, de 22:00 a 7:00',
      accountNightlySubtitle: 'Silenciar o suprimir canales de atención durante la noche',
      deviceAccountTitle: 'Este dispositivo sigue el horario de la cuenta',
      deviceAccountSubtitle: 'Usar la política sincronizada de horas de silencio de la cuenta',
      deviceDisabledTitle: 'Desactivar horas de silencio en este dispositivo',
      deviceDisabledSubtitle: 'Permitir que este dispositivo entregue incluso cuando las horas de silencio de la cuenta estén activas',
      deviceCustomNightlyTitle: 'Este dispositivo usa horas de silencio nocturnas',
      deviceCustomNightlySubtitle: 'Anular el horario de la cuenta con 22:00 a 7:00 en este dispositivo',
    },
    sounds: {
      title: 'Sonidos',
      footer: 'Los sonidos predeterminados de la cuenta se sincronizan en todas partes. Este dispositivo puede silenciar sonidos locales.',
      accountHappierTitle: 'Sonidos de Happier',
      accountHappierSubtitle: 'Usar un tono suave para actualizaciones y uno más claro cuando se necesita atención',
      accountDefaultTitle: 'Predeterminado del sistema',
      accountDefaultSubtitle: 'Usar el sonido de notificación de la plataforma',
      accountSilentTitle: 'Silencioso',
      accountSilentSubtitle: 'Entregar notificaciones sin sonido',
      deviceEnabledTitle: 'Reproducir sonidos en este dispositivo',
      deviceEnabledSubtitle: 'Anulación del dispositivo para sonidos de notificación locales',
      previewTitle: 'Vista previa del sonido',
      previewSubtitle: 'Enviar una notificación local de prueba en este dispositivo',
      previewNotificationTitle: 'Vista previa del sonido de notificación',
      previewNotificationBody: 'Así se comportará el sonido de notificación actual.',
    },},

    notifications: {
      actions: {
        allow: 'Permitir',
        deny: 'Denegar',
        answer: 'Responder',

        other: 'Otro',
        alwaysAllowTool: ({ tool }: { tool: string }) => `Permitir siempre ${tool}`,},
      activity: {
        defaultSessionTitle: 'Sesión',
        readyFallbackBody: 'El turno terminó. Abre la sesión para continuar.',
        permissionFallbackBody: 'Se requiere aprobación.',
        userActionFallbackBody: 'Esta sesión necesita tu intervención.',
      },
      channels: {
        default: 'Predeterminado',
        permissionRequests: 'Solicitudes de permisos',
        userActionRequests: 'Solicitudes de acción',
      },
    },

  settingsProviders: settingsProvidersTranslations.es,

  settingsAgents: {
    title: "Configuración del proveedor de IA",
    entrySubtitle: "Configura opciones específicas del proveedor",
    footer:
        "Configura opciones específicas del proveedor. Estos ajustes pueden afectar el comportamiento de la sesión.",
      configuration: 'Configuración',
      cliConnection: 'Conexión CLI',
      capabilities: 'Capacidades',
      models: 'Modelos',
      providerSubtitle: "Ajustes específicos del proveedor",
      stateEnabled: "Habilitado",
      stateDisabled: "Deshabilitado",
      channelStable: "Estable",
      channelExperimental: "En pruebas",
      channelPlugin: "Complemento",
      supported: "Compatible",
      notSupported: "No compatible",
      allowed: "Permitido",
      notAllowed: "No permitido",
      notAvailable: "No disponible",
      enabledTitle: "Habilitado",
      enabledSubtitle: "Usa este backend en selectores, perfiles y sesiones",
      releaseChannelTitle: "Canal de lanzamiento",
      capabilitiesTitle: "Capacidades",
      resumeSupportTitle: "Soporte de reanudación",
      sessionModeSupportTitle: "Soporte de modo de sesión",
      runtimeModeSwitchingTitle: "Cambio de modo en tiempo de ejecución",
      localControlTitle: "Control local",
      resumeSupportSupported: "Compatible",
      resumeSupportSupportedExperimental: "Compatible (en pruebas)",
      resumeSupportNotSupported: "No compatible",
      sessionModeNone: "Sin modos ACP",
      sessionModeAcpPolicyPresets: "Preajustes de políticas ACP",
      sessionModeAcpAgentModes: "Modos de agente ACP",
      sessionModeDynamicPolicyModes: "Modos dinámicos de política",
      sessionModeDynamicAgentModes: "Modos dinámicos de agente",
      sessionModeStaticAgentModes: "Modos de agente estáticos",
      runtimeSwitchNone: "Sin cambio en tiempo de ejecución",
      runtimeSwitchMetadataGating: "Controlado por metadatos",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchSessionModeApi: "API de modo de sesión",
      runtimeSwitchProviderNative: "Nativo del proveedor",
      modelsTitle: "Modelos",
      modelSelectionTitle: "Selección de modelo",
      freeformModelIdsTitle: "IDs de modelo libres",
      defaultModelTitle: "Modelo predeterminado",
      catalogModelListTitle: "Lista de modelos del catálogo",
      catalogModelListEmpty: "No hay modelos de catálogo disponibles",
      dynamicModelProbeTitle: "Sondeo dinámico de modelos",
      dynamicModelProbeAuto: "Automático",
      dynamicModelProbeStaticOnly: "Solo estático",
      nonAcpApplyScopeTitle: "Ámbito de aplicación del modelo (sin ACP)",
      nonAcpApplyScopeSpawnOnly: "Aplicar al iniciar la sesión",
      nonAcpApplyScopeNextPrompt: "Aplicar en el próximo mensaje",
      acpApplyBehaviorTitle: "Comportamiento de aplicación del modelo (ACP)",
      acpApplyBehaviorSetModel: "Cambiar modelo en vivo",
      acpApplyBehaviorRestartSession: "Reiniciar sesión",
        acpConfigOptionTitle: "ID de opción de configuración del modelo ACP",
        cliConnectionTitle: "CLI y conexión",
        targetMachineTitle: "Máquina de destino",
        detectedCliTitle: "CLI detectado",
        installSetupTitle: "Instalación / configuración",
        installInfoSeeSetupGuide: "Ver guía de configuración",
      installInfoUseAgentCliInstaller: "Usa el instalador CLI del proveedor",
      setup: {
        selectionFooter: "Elige uno o más proveedores y complétalos uno por uno en la máquina seleccionada.",
        startTitle: "Configurar proveedores",
        startDescription: "Pon los proveedores seleccionados en cola y completa la instalación y el inicio de sesión en un único flujo canónico.",
        queueTitle: "Cola de configuración de proveedores",
        queueDescription: ({ provider }: { provider: string }) => `Termina ${provider} y luego continúa con el siguiente proveedor de la cola.`,
        activeDescription: "Proveedor actual en la cola de configuración",
        activeStatus: "En curso",
        completedStatus: "Completado",
        skippedStatus: "Omitido",
        skipAction: "Omitir este proveedor",
        completedTitle: "Configuración del proveedor completada",
        completedDescription: "Has llegado al final de la cola de proveedores seleccionados.",
      },
      cliSourcePreference: {
        title: "Preferencia del origen de la CLI",
        subtitle:
          "Elige si Happier debe priorizar la CLI del sistema o la instalación gestionada cuando ambas existan.",
        options: {
          systemFirst: {
            title: "Priorizar instalación del sistema",
            subtitle: "Prioriza la CLI ya instalada en esta máquina.",
          },
          managedFirst: {
            title: "Priorizar instalación gestionada",
            subtitle: "Prioriza la CLI instalada por Happier para este proveedor.",
          },
        },
      },
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `Instalar CLI de ${provider}`,
        reinstallTitle: ({ provider }: { provider: string }) => `Reinstalar CLI de ${provider}`,
        autoInstallUnavailable: "La instalación automática no está disponible para esta máquina.",
        installSubtitle: "Instala la CLI del proveedor en la máquina seleccionada (mejor esfuerzo).",
        reinstallSubtitle: "Vuelve a ejecutar el instalador del proveedor aunque la CLI ya esté presente.",
        confirmInstallTitle: ({ provider }: { provider: string }) => `¿Instalar la CLI de ${provider}?`,
        confirmReinstallTitle: ({ provider }: { provider: string }) => `¿Reinstalar la CLI de ${provider}?`,
        confirmBody: ({ provider }: { provider: string }) =>
          `Esto ejecutará los comandos del instalador de ${provider} en la máquina seleccionada. Continúa solo si confías en el proveedor.`,
        confirmInstallConfirm: "Instalar",
        confirmReinstallConfirm: "Reinstalar",
        noMachineSelected: "No se seleccionó ninguna máquina.",
        installNotSupported: "La instalación no está soportada en esta máquina.",
        installFailed: "La instalación falló.",
        installed: "Instalado.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL de la guía de configuración",
      authentication: {
        title: "Autenticación",
        footer: "Revisa el estado de autenticación del CLI local e inicia sesión cuando esté disponible.",
        terminalTitle: "Terminal de inicio de sesión del proveedor",
        logInTitle: "Iniciar sesión",
        logInSubtitle: "Abre un terminal y ejecuta el flujo de inicio de sesión del proveedor en esta máquina.",
        reauthenticateTitle: "Volver a autenticar",
        reauthenticateSubtitle: "Abre un terminal y renueva el inicio de sesión del proveedor en esta máquina.",
        checkNowTitle: "Comprobar ahora",
        checkNowSubtitle: "Actualiza el estado de autenticación local detectado.",
        statusTitle: "Estado",
        loggedInAsTitle: "Sesión iniciada como",
        methodTitle: "Método de autenticación",
        sourceTitle: "Origen de las credenciales",
        reasonTitle: "Problema",
        lastCheckedTitle: "Última comprobación",
        stateUnknown: "Desconocido",
        stateLoggedIn: "Con sesión iniciada",
        stateLoggedOut: "Con sesión cerrada",
        methods: {
          apiKeyEnv: "Variable de entorno de clave API",
          authTokenEnv: "Variable de entorno del token de autenticación",
          credentialsFile: "Archivo de credenciales",
          oauthCli: "Inicio de sesión OAuth del CLI",
          configFile: "Archivo de configuración",
          gcloudAdc: "Credenciales predeterminadas de la aplicación de Google Cloud",
          unknown: "Desconocido",
        },
        reasons: {
          missingCredentials: "Faltan credenciales",
          expired: "Credenciales caducadas",
          cliMissing: "CLI no instalado",
          probeFailed: "Falló la comprobación de estado",
          timeout: "La comprobación de estado agotó el tiempo",
          unsupported: "La autenticación local no es compatible",
          interactiveBlocked: "El inicio de sesión interactivo está bloqueado",
          notConfigured: "No configurado",
        },
        sources: {
          environment: "Entorno",
          file: "Archivo",
          command: "Comando",
          mixed: "Mixto",
        },
      },
      connectedServiceTitle: "Servicio conectado",
      notFoundTitle: "Proveedor no encontrado",
	      notFoundSubtitle: "Este proveedor no tiene pantalla de configuración.",
	      noOptionsAvailable: "No hay opciones disponibles",
	      invalidNumber: "Número inválido",
	    invalidJson: "JSON inválido",
	    plugins: {
            claude: {
                title: "Claude (remoto)",
                sections: {
                    claudeCodeExperiments: {
                        title: "Experimentos de Claude Code",
                        footer: "Estos ajustes se aplican tanto a Claude local (terminal) como a Claude remoto (Agent SDK) iniciados por Happier."
                    },
                    claudeUnifiedTerminal: {
                        title: "Terminal unificada de Claude",
                        footer: "Ejecuta Claude Code en una sesión alojada en terminal y permite que Happier entregue prompts compatibles a través del host de terminal."
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK (modo remoto)",
                        footer: "El modo remoto ejecuta Claude en tu máquina, pero controlado desde la interfaz de Happier. El modo local es la TUI de Claude Code en tu terminal. Estos ajustes solo afectan al modo remoto."
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Forzar activación de Agent Teams",
                        subtitle: "Activa Agent Teams experimental de Claude Code (enjambre de agentes) en todas las sesiones de Claude iniciadas por Happier."
                    },
                    claudeUnifiedTerminalEnabled: {
                        title: "Usar modo de terminal unificada",
                        subtitle: "Mantiene Claude Code como la sesión de terminal canónica y envía prompts compatibles de Happier a esa sesión."
                    },
                    claudeUnifiedTerminalHost: {
                        title: "Host de terminal",
                        subtitle: "Elige qué multiplexor de terminal usa Happier para sesiones unificadas de Claude.",
                        options: {
                            auto: {
                                title: "Automático",
                                subtitle: "Prefiere el mejor host compatible en esta máquina."
                            },
                            tmux: {
                                title: "tmux",
                                subtitle: "Usa tmux cuando esté disponible."
                            },
                            zellij: {
                                title: 'zellij',
                                subtitle: "Usa Zellij cuando esté disponible y sea compatible."
                            }
                        }
                    },
                    claudeUnifiedTerminalResumeChoice: {
                        title: "Reanudacion de sesiones grandes",
                        subtitle: "Elige como responde Happier cuando Claude pregunta como reanudar una sesion grande.",
                        options: {
                            ask_every_time: {
                                title: "Preguntar cada vez",
                                subtitle: "Muestra una accion de usuario en la sesion cada vez que Claude lo pida."
                            },
                            resume_from_summary: {
                                title: "Reanudar desde el resumen",
                                subtitle: "Usa el resumen de Claude para reanudar sesiones grandes mas rapido."
                            },
                            resume_full_session: {
                                title: "Reanudar sesion completa",
                                subtitle: "Carga todo el contexto de la sesion cuando Claude ofrezca la opcion."
                            }
                        }
                    },
                    claudeUnifiedTerminalWorkspaceTrust: {
                        title: "Confianza en el espacio de trabajo",
                        subtitle: "Elige cómo Happier responde cuando Claude te pregunta si confiar en un espacio de trabajo.",
                        options: {
                            ask_every_time: {
                                title: "pregunta cada vez",
                                subtitle: "Muestre la pregunta exacta sobre la confianza del espacio de trabajo en la sesión."
                            },
                            always_trust_happier_workspaces: {
                                title: "Confía siempre en Happier espacios de trabajo",
                                subtitle: "Confíe en el mensaje Claude recapturado actual para los espacios de trabajo abiertos por Happier."
                            },
                            always_reject_happier_workspaces: {
                                title: "Rechazar siempre Happier espacios de trabajo",
                                subtitle: "Rechace el mensaje Claude recapturado actual para los espacios de trabajo abiertos por Happier."
                            }
                        }
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Usar Agent SDK (remoto)",
                        subtitle: "Usa el @anthropic-ai/claude-agent-sdk oficial para el modo remoto."
                    },
                    claudeRemoteDebugEnabled: {
                        title: "Modo debug",
                        subtitle: "Activa los logs de depuración de Claude Code (equivalente a --debug)."
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "Detallado",
                        subtitle: "Activa el registro verboso (equivalente a --verbose)."
                    },
                    claudeRemoteDebugCategories: {
                        title: "Categorías de debug",
                        subtitle: "Filtro opcional de categorías. Si está vacío, Claude registra todas las categorías de debug.",
                        options: {
                            api: {
                                title: "API",
                                subtitle: "Solicitudes y respuestas HTTP/API."
                            },
                            mcp: {
                                title: "MCP",
                                subtitle: "Conexiones de servidores MCP y tráfico de herramientas."
                            },
                            hooks: {
                                title: "Hooks",
                                subtitle: "Ciclo de vida de hooks y ejecución de comandos."
                            },
                            file: {
                                title: "Archivos",
                                subtitle: "Operaciones del sistema de archivos y helpers."
                            },
                            '1p': {
                                title: "1p",
                                subtitle: "Categoría interna first-party."
                            }
                        }
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "Fuentes de ajustes",
                        subtitle: "Controla qué ajustes de Claude se cargan.",
                        options: {
                            user: {
                                title: "Usuario",
                                subtitle: "Carga la configuración global de usuario de Claude."
                            },
                            project: {
                                title: "Proyecto",
                                subtitle: "Carga la configuración del repositorio (incluido CLAUDE.md)."
                            },
                            local: {
                                title: "Local",
                                subtitle: "Carga anulaciones solo locales."
                            }
                        }
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "Experimental: puente de permisos local",
                        subtitle: "Reenvía las solicitudes de permiso del modo local de Claude a Happier para que puedas aprobarlas o denegarlas desde la interfaz."
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "Mantener solicitudes abiertas hasta responder",
                        subtitle: "Cuando está activado, Happier mantiene las solicitudes de permiso local de Claude pendientes hasta que las apruebes o rechaces desde la interfaz."
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "Tiempo de espera opcional de permisos (segundos)",
                        subtitle: "Solo se usa cuando la espera indefinida está desactivada. Tras este tiempo, Happier vuelve al prompt del terminal de Claude."
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "Checkpoints de archivos + /rewind",
                        subtitle: "Activa checkpoints de archivos y /rewind (solo archivos; no rebobina la conversación). Usa /checkpoints para listar y /rewind --confirm para aplicar (más sobrecarga)."
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "Máximo de tokens de razonamiento",
                        subtitle: "Limita el presupuesto interno de razonamiento de Claude (null = predeterminado)."
                    },
                    claudeRemoteDisableTodos: {
                        title: "Desactivar TODOs",
                        subtitle: "Evita que Claude cree elementos TODO en modo remoto."
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "Configuración estricta de servidor MCP",
                        subtitle: "Falla si alguna configuración de servidor MCP no es válida."
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "Opciones avanzadas (JSON)",
                        subtitle: "Anulaciones avanzadas del Agent SDK para usuarios expertos (validadas en cliente)."
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "Modo de backend",
                        footer: "El modo servidor desbloquea preguntas y bifurcación nativa. El modo ACP es una alternativa heredada."
                    },
                    server: {
                        title: "Conexión del servidor",
                        footer: "Déjalo vacío para usar el ciclo de vida del servidor OpenCode gestionado por Happier. Define una URL HTTPS absoluta para cualquier servidor que gestiones tú, o HTTP solo para localhost. Pon la contraseña en el campo de abajo, nunca en la URL."
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "Modo de backend de OpenCode",
                        subtitle: "Elige el backend de integración.",
                        options: {
                            server: {
                                title: "Servidor (recomendado)",
                                subtitle: "Usa las API de servidor de OpenCode para obtener más funciones y fiabilidad."
                            },
                            acp: {
                                title: "ACP (heredado)",
                                subtitle: "Enruta OpenCode mediante ACP; ofrece menos funciones."
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "URL de servidor OpenCode existente",
                        subtitle: "Anulación opcional para un servidor que gestionas tú. HTTPS puede usar cualquier host; HTTP se limita a localhost."
                    },
                    opencodeServerPassword: {
                        title: "Contraseña del servidor OpenCode existente",
                        subtitle: "Configúrala solo si tu servidor OpenCode se ejecuta con OPENCODE_SERVER_PASSWORD. Se guarda cifrada en este dispositivo y nunca se sincroniza."
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
                title: "Kimi",
                sections: {
                    compatibility: {
                        title: 'Compatibilidad',
                        footer: 'Usa el modo de compatibilidad solo en entornos Linux/contenedor donde el inicio de Kimi ACP se queda bloqueado.'
                    }
                },
                fields: {
                    kimiAcpPythonSelector: {
                        title: 'Selector de stdio de Python',
                        subtitle: 'Elige cómo inicia Happier el bucle stdio de Python de Kimi ACP.',
                        options: {
                            auto: {
                                title: 'Automático',
                                subtitle: 'Usa el selector de Python predeterminado de Kimi.'
                            },
                            poll: {
                                title: 'Modo de compatibilidad',
                                subtitle: 'Usa poll() en lugar de epoll() para el stdio de Kimi ACP.'
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
                        title: "Entorno de ejecución",
                        footer: "Elige cómo se inician las sesiones de Antigravity. El modo CLI usa tu inicio de sesión de suscripción con controles en vivo degradados; el modo SDK usa credenciales de Gemini API o Vertex."
                    }
                },
                fields: {
                    antigravityRuntimeMode: {
                        title: "Modo de runtime",
                        subtitle: "Selecciona enrutamiento automático, modo print de CLI con suscripción o modo SDK.",
                        options: {
                            auto: {
                                title: "Automático",
                                subtitle: "Prefiere la CLI de suscripción cuando esté disponible y luego credenciales del SDK."
                            },
                            cliPrint: {
                                title: "Antigravity CLI (suscripción)",
                                subtitle: "Usa el modo print de agy con tu login local; las aprobaciones de herramientas en vivo se degradan."
                            },
                            sdk: {
                                title: "SDK de Antigravity (Gemini API / Vertex)",
                                subtitle: "Usa una clave Gemini API o credenciales Vertex mediante el SDK."
                            }
                        }
                    }
                }
            },
            codex: {
	        title: "Codex",
	        sections: {
	          backendMode: {
	            title: "Modo de enrutamiento",
	            footer: "Elige cómo se enruta Codex. App Server es la opción predeterminada recomendada. El cambio local/remoto y la reanudación funcionan con App Server; ACP sigue disponible como fallback heredado.",
	          },
	          installOverrides: {
	            title: "Anulaciones de la fuente de instalación",
	            footer: "Opcional. Déjalo vacío para usar las fuentes de instalación predeterminadas.",
	          },
	        },
	        fields: {
	          codexBackendMode: {
	            title: "Modo de enrutamiento de Codex",
	            subtitle: "Selecciona App Server, ACP o MCP.",
	            options: {
	              appServer: {
	                title: "Servidor de la app",
	                subtitle: "Modo oficial recomendado de Codex app-server",
	              },
	              acp: {
	                title: "ACP",
	                subtitle: "Enruta Codex a través de ACP (codex-acp)",
	              },
	              mcp: {
	                title: "MCP",
	                subtitle: "Modo MCP predeterminado de Codex",
	              },
	            },
	          },
	        },
	      },
	    },
	  },

  workspaceCockpit: {
    sessionPosition: ({ position, total }: { position: number; total: number }) => position + ' de ' + total,
    previousSession: 'Sesión anterior',
    nextSession: 'Sesión siguiente',
    switchedToSession: ({ name, position, total }: { name: string; position: number; total: number }) => 'Has cambiado a ' + name + ', ' + position + ' de ' + total,
    openCockpit: 'Abrir cockpit',
    openClassicView: 'Abrir vista clásica',
    tabs: 'Pestañas',
  },

  settingsAppearance: {
    tabBarAppearance: {
      title: 'Barra de pestañas',
      footer: 'Personaliza la barra de pestañas inferior.',
      showLabels: 'Mostrar etiquetas de pestañas',
      size: 'Tamaño de la barra de pestañas',
      sizeCompact: 'Compacto',
      sizeRegular: 'Normal',
      sizeLarge: 'Grande',
    },
    glass: {
      title: 'Superficies de vidrio',
      footer: 'Usa un material de desenfoque translúcido para las superficies de vidrio flotantes: la barra de pestañas, el botón para ir al final y más.',
      enable: 'Desenfoque de vidrio',
      intensity: 'Intensidad del desenfoque',
      intensityLight: 'Ligera',
      intensityRegular: 'Normal',
      intensityStrong: 'Fuerte',
      composer: 'Compositor de vidrio',
      composerHint: 'Combina con la barra de pestañas — usa su color de superficie y proyecta una sombra para el compositor de mensajes.',
    },
    tabBarBadges: {
      title: 'Insignias de la barra de pestañas',
      footer: 'Elige qué insignias aparecen en la barra de pestañas inferior.',
      gitTitle: 'Insignia de la pestaña Git',
      gitChangedFiles: 'Archivos modificados',
      gitDiffLines: 'Líneas añadidas y eliminadas',
      gitOff: 'Desactivado',
    },
    ...settingsAppearanceTranslationExtension,
    // Appearance settings screen
    theme: "Tema",
    themeDescription: "Elige tu esquema de colores preferido",
    themeOptions: {
      adaptive: "Adaptativo",
      light: "Claro",
      dark: "Oscuro",
    },
    themeDescriptions: {
      adaptive: "Seguir configuración del sistema",
      light: "Usar siempre tema claro",
      dark: "Usar siempre tema oscuro",
    },
    display: "Pantalla",
    displayDescription: "Controla diseño y espaciado",
    contentWidth: "Ancho del contenido",
    contentWidthDescription:
      "Elige hasta qué ancho puede crecer el contenido principal",
    contentWidthOptions: {
      compact: "Compacto",
      compactDescription: "Mantén el contenido principal limitado a 850 px",
      medium: "Medio",
      mediumDescription: "Permite que el contenido principal llegue a 960 px",
      full: "Ancho completo",
      fullDescription: "Usa el ancho disponible de la ventana",
    },
    backdropBlur: "Desenfoque de fondo",
    backdropBlurDescription:
      "Usa desenfoque de fondo detrás de modales y menús. Desactívalo para mejorar el rendimiento del navegador.",
    multiPanePanels: "Paneles derechos",
    multiPanePanelsDescription:
      "Muestra paneles laterales redimensionables para archivos y control de código fuente (web/tablet)",
    sessionsRightPaneDefaultOpen:
      "Mostrar siempre la barra lateral derecha en las sesiones",
    sessionsRightPaneDefaultOpenDescription:
      "Abrir automáticamente la barra lateral derecha al entrar en una sesión (web/tablet)",
    detailsPaneTabsBehavior: "Pestañas del editor",
    detailsPaneTabsBehaviorDescription:
      "Elige cómo se comportan las pestañas de archivos en el panel del editor",
    detailsPaneTabsBehaviorOptions: {
      preview: "Pestaña de vista previa",
      persistent: "Pestañas persistentes",
    },
    inlineToolCalls: "Llamadas a herramientas en línea",
    inlineToolCallsDescription:
      "Mostrar llamadas a herramientas directamente en mensajes de chat",
    expandTodoLists: "Expandir listas de tareas",
    expandTodoListsDescription:
      "Mostrar todas las tareas en lugar de solo cambios",
    showLineNumbersInDiffs: "Mostrar números de línea en diferencias",
    showLineNumbersInDiffsDescription:
      "Mostrar números de línea en diferencias de código",
    showLineNumbersInToolViews:
      "Mostrar números de línea en vistas de herramientas",
    showLineNumbersInToolViewsDescription:
      "Mostrar números de línea en diferencias de vistas de herramientas",
    wrapLinesInDiffs: "Ajustar líneas en diferencias",
    wrapLinesInDiffsDescription:
      "Ajustar líneas largas en lugar de desplazamiento horizontal en vistas de diferencias",
    alwaysShowContextSize: "Mostrar siempre tamaño del contexto",
    alwaysShowContextSizeDescription:
      "Mostrar uso del contexto incluso cuando no esté cerca del límite",
    agentInputActionBarLayout: "Barra de acciones de entrada",
    agentInputActionBarLayoutDescription:
      "Elige cómo se muestran los chips de acción encima del campo de entrada",
    agentInputActionBarLayoutOptions: {
      auto: "Automático",
      wrap: "Ajustar",
      scroll: "Desplazable",
      collapsed: "Contraído",
    },
    agentInputChipDensity: "Densidad de chips de acción",
    agentInputChipDensityDescription:
      "Elige si los chips de acción muestran etiquetas o íconos",
    agentInputChipDensityOptions: {
      auto: "Automático",
      labels: "Etiquetas",
      icons: "Solo íconos",
    },
    avatarStyle: "Estilo de avatar",
    avatarStyleDescription: "Elige la apariencia del avatar de sesión",
    avatarOptions: {
      pixelated: "Pixelado",
      gradient: "Gradiente",
      brutalist: "Brutalista",
      meshGradient: "Degradado de malla",
      meshGradientOrganic: "Degradado de malla: orgánico",
      meshGradientRows: "Degradado de malla: filas",
      meshGradientColumns: "Degradado de malla: columnas",
      meshGradientDiagonal: "Degradado de malla: diagonal",
      meshGradientOval: "Degradado de malla: ovalado",
      meshGradientWaves: "Degradado de malla: ondas",
      meshGradientSoftNoise: "Degradado de malla: ruido suave",
      photoGradient: "Degradado en capas",
      photoGradientRows: "Degradado en capas: filas",
      photoGradientColumns: "Degradado en capas: columnas",
      photoGradientDiagonal: "Degradado en capas: diagonal",
      photoGradientWaves: "Degradado en capas: ondas",
      photoGradientOval: "Degradado en capas: óvalo",
      photoGradientValueNoise: "Degradado en capas: ruido suave",
      photoGradientVoronoi: "Degradado en capas: celdas",
      photoGradientMeshGrid: "Degradado en capas: cuadrícula",
    },
    showFlavorIcons: "Mostrar íconos de proveedor de IA",
    showFlavorIconsDescription:
      "Mostrar íconos del proveedor de IA en los avatares de sesión",
    compactSessionView: "Vista compacta de sesiones",
    compactSessionViewDescription:
      "Mostrar sesiones activas en un diseño más compacto",
    compactSessionViewMinimal: "Vista compacta mínima",
    compactSessionViewMinimalDescription:
      "Usa el diseño de fila de sesión más estrecho",
    text: "Texto",
    textDescription: "Ajusta el tamaño del texto en la app",
    textSize: "Tamaño del texto",
    textSizeDescription: "Haz el texto más grande o más pequeño",
    textSizeOptions: {
      xxsmall: "Muy muy pequeño",
      xsmall: "Muy pequeño",
      small: "Pequeño",
      default: "Predeterminado",
      large: "Grande",
      xlarge: "Muy grande",
      xxlarge: "Muy muy grande",
    },
    itemDensity: "Densidad de elementos",
    itemDensityDescription: "Elige el tamaño de las filas de listas y ajustes en toda la app",
    itemDensityOptions: {
      comfortable: "Predeterminada",
      comfortableDescription: "Usa el tamaño y espaciado estándar de las filas",
      cozy: "Intermedia",
      cozyDescription: "Usa filas un poco más compactas sin llegar al diseño compacto",
      compact: "Compacta",
      compactDescription: "Muestra más filas en pantalla con menos espaciado",
    },

    settingsNavSidebar: "Barra lateral de ajustes",
    settingsNavSidebarDescription:
      "Mostrar la barra lateral de navegación de ajustes (web/tablet)",},

  settingsFeatures: {
    // Features settings screen
    experiments: "Experimentos",
    experimentsDescription:
      "Habilitar características experimentales que aún están en desarrollo. Estas características pueden ser inestables o cambiar sin aviso.",
    experimentalFeatures: "Características experimentales",
    experimentalFeaturesEnabled: "Características experimentales habilitadas",
    experimentalFeaturesDisabled: "Usando solo características estables",
    experimentalOptions: "Opciones experimentales",
    experimentalOptionsDescription:
      "Elige qué funciones experimentales están activadas.",
    localTogglesTitle: "Funciones",
    localTogglesFooter:
      "Interruptores locales por función (independientes del soporte del servidor).",
    featureDiagnostics: {
      title: "Diagnósticos de funciones",
      footer:
        "Decisiones de funciones resueltas (política de build, política local, sondeos de daemon/servidor y alcance).",
      decisionUnknown: "desconocido",
      decisionEnabled: "habilitado",
      decisionBlocked: ({
        state,
        blockedBy,
        code,
      }: {
        state: string;
        blockedBy: string | null;
        code: string;
      }) => `${state} (bloqueadoPor=${blockedBy ?? "null"}, código=${code})`,
    },
        expAutomations: "Automatizaciones",
        expAutomationsSubtitle: "Habilitar interfaz de automatizaciones y programación",
        expExecutionRuns: "Ejecuciones",
      expExecutionRunsSubtitle:
        "Habilitar superficies de control para ejecuciones (subagentes / revisiones)",
      expAttachmentsUploads: "Subida de adjuntos",
      expAttachmentsUploadsSubtitle:
        "Habilitar la subida de archivos/imágenes para que el agente pueda leerlos desde el disco",
      expUsageReporting: "Informe de uso",
    expUsageReportingSubtitle: "Habilitar pantallas de uso y reporte de tokens",
    expScmOperations: "Operaciones de control de versiones",
    expScmOperationsSubtitle:
      "Habilitar operaciones de escritura experimentales de control de versiones (stage/commit/push/pull)",
      expFilesReviewComments: "Comentarios de revisión de archivos",
      expFilesReviewCommentsSubtitle:
        "Añade comentarios de revisión por línea desde las vistas de archivo y diff, y luego envíalos como un mensaje estructurado",
      expFilesDiffSyntaxHighlighting: "Resaltado de sintaxis en diffs",
      expFilesDiffSyntaxHighlightingSubtitle:
        "Habilita el resaltado de sintaxis en diffs y vistas de código (con límites de rendimiento)",
      expFilesAdvancedSyntaxHighlighting: "Resaltado de sintaxis avanzado",
      expFilesAdvancedSyntaxHighlightingSubtitle:
        "Usa un resaltado más pesado y de mayor fidelidad (solo web, puede ser más lento)",
      expFilesEditor: "Editor de archivos integrado",
      expFilesEditorSubtitle:
        "Habilita editar archivos directamente desde el explorador de archivos (Monaco en web/escritorio, CodeMirror en nativo)",
      expMarkdownRichEditor: 'Editor Markdown enriquecido',
      expMarkdownRichEditorSubtitle:
        'Habilita un editor enriquecido (WYSIWYG) para archivos Markdown en el editor de archivos, con respaldo sin formato cuando sea necesario',
      expEmbeddedTerminal: "Terminal integrado",
      expEmbeddedTerminalSubtitle:
        "Abre un terminal real dentro de las sesiones.",
      expSessionType: "Selector de tipo de sesión",
    expSessionTypeSubtitle:
      "Mostrar el selector de tipo de sesión (simple vs worktree)",
      expZen: "Modo Zen",
    expZenSubtitle: "Habilitar la entrada de navegación Zen",
      expVoiceAuthFlow: "Flujo de autenticación de voz",
    expVoiceAuthFlowSubtitle:
      "Usar flujo autenticado de token de voz (con paywall)",
    voice: "Voz",
    voiceSubtitle: "Activar funciones de voz",
      expVoiceAgent: "Agente de voz",
      expVoiceAgentSubtitle:
        "Habilitar superficies de agente de voz respaldadas por daemon (requiere ejecuciones)",
      expVoiceDaemonInference: 'Inferencia de voz del daemon',
      expVoiceDaemonInferenceSubtitle: 'Activa controles de inferencia de voz local respaldados por daemon',
      expLiveActivities: 'Live Activities',
      expLiveActivitiesSubtitle: 'Activa superficies de Live Activities para el progreso de la sesión',
      expHomeScreenWidgets: 'Widgets de pantalla de inicio',
      expHomeScreenWidgetsSubtitle: 'Activa widgets de pantalla de inicio para la actividad de Happier',
      expConnectedServicesQuotas: "Cuotas de servicios conectados",
      expConnectedServicesQuotasSubtitle:
        "Mostrar insignias de cuota y medidores de uso para servicios conectados",
      expMemorySearch: "Búsqueda de memoria",
      expMemorySearchSubtitle:
        "Habilitar pantallas y ajustes de búsqueda de memoria local",
    expSessionsDirect: "Sesiones externas",
    expSessionsDirectSubtitle: "Descubre y enlaza sesiones existentes de agentes en la barra lateral",
    expSessionsFolders: "Carpetas de sesiones",
    expSessionsFoldersSubtitle: "Organiza las sesiones Happier de la barra lateral en carpetas de espacio de trabajo",
    expPetsCompanion: "Mascotas",
    expPetsCompanionSubtitle: "Activa las superficies de compañía de Blink y la selección local de mascotas",
    expFriends: "Amigos",
    expFriendsSubtitle: "Activa las funciones de amigos (pestaña Bandeja de entrada y compartir sesiones)",
    webFeatures: "Características web",
    webFeaturesDescription:
      "Características disponibles solo en la versión web de la aplicación.",
    enterToSend: "Enter para enviar",
    enterToSendEnabled:
      "Presiona Enter para enviar (Shift+Enter para una nueva línea)",
    enterToSendDisabled: "Enter inserta una nueva línea",
      historyScope: "Historial de mensajes",
      historyScopePerSession: "Recorrer el historial por sesión",
      historyScopeGlobal: "Recorrer el historial en todas las sesiones",
      historyScopeModalTitle: "Historial de mensajes",
      historyScopeModalMessage:
        "Elige si Flecha arriba/Flecha abajo recorre solo los mensajes enviados en esta sesión, o en todas las sesiones.",
      historyScopePerSessionOption: "Por sesión",
      historyScopeGlobalOption: "Global (todos)",
      commandPalette: "Paleta de comandos",
      commandPaletteEnabled: "Usa el atajo para abrir",
      commandPaletteDisabled: "Acceso rápido a comandos deshabilitado",
      hideInactiveSessions: "Ocultar sesiones inactivas",
      hideInactiveSessionsSubtitle: "Muestra solo los chats activos en tu lista",
      hiddenInactiveSessionsEmptyStateTitle: "No hay sesiones activas ahora mismo",
      hiddenInactiveSessionsEmptyStateSubtitle: "Las sesiones inactivas están ocultas en esta lista",
      hiddenInactiveSessionsSectionTitle: "Sesiones inactivas",
      hiddenInactiveSessionsSectionSubtitle: "Ocultas en la lista principal porque allí solo se muestran los chats activos",
    sessionListActiveGrouping: "Agrupación de sesiones activas",
    sessionListActiveGroupingSubtitle:
      "Elige cómo se agrupan las sesiones activas en la barra lateral",
    sessionListInactiveGrouping: "Agrupación de sesiones inactivas",
    sessionListInactiveGroupingSubtitle:
      "Elige cómo se agrupan las sesiones inactivas en la barra lateral",
    sessionListGrouping: {
      projectTitle: "Proyecto",
      projectSubtitle: "Agrupa sesiones por máquina + ruta",
      dateTitle: "Fecha",
      dateSubtitle: "Agrupa sesiones por la fecha de la última actividad",
    },
    groupInactiveSessionsByProject: "Agrupar sesiones inactivas por proyecto",
    groupInactiveSessionsByProjectSubtitle:
      "Organiza los chats inactivos por proyecto",
      environmentBadge: "Insignia de entorno",
      environmentBadgeSubtitle:
        "Mostrar una pequeña insignia junto al título Happier indicando el entorno actual de la app",
    enhancedSessionWizard: "Asistente de sesión mejorado",
    enhancedSessionWizardEnabled: "Lanzador de sesión con perfil activo",
    enhancedSessionWizardDisabled: "Usando el lanzador de sesión estándar",
    profiles: "Perfiles de IA",
    profilesEnabled: "Selección de perfiles habilitada",
    profilesDisabled: "Selección de perfiles deshabilitada",
    pickerSearch: "Búsqueda en selectores",
    pickerSearchSubtitle:
      "Mostrar un campo de búsqueda en los selectores de máquina y ruta",
    machinePickerSearch: "Búsqueda de máquinas",
    machinePickerSearchSubtitle:
      "Mostrar un campo de búsqueda en los selectores de máquinas",
    pathPickerSearch: "Búsqueda de rutas",
    pathPickerSearchSubtitle:
      "Mostrar un campo de búsqueda en los selectores de rutas",
  },

  errors: {
    networkError: "Error de conexión",
    serverError: "Error del servidor",
    unknownError: "Error desconocido",
    connectionTimeout: "Se agotó el tiempo de conexión",
    authenticationFailed: "Falló la autenticación",
    permissionDenied: "Permiso denegado",
    permissionDeniedReadOnlyMode: "Denegado por el modo Solo lectura (las acciones de escritura están denegadas).",
    permissionCanceled: "Permiso cancelado",
    permissionCanceledSessionInactive: "La sesión está inactiva — no se puede aprobar esta solicitud de permiso.",
      fileNotFound: "Archivo no encontrado",
      invalidFormat: "Formato inválido",
      operationFailed: "Operación falló",
      signupDisabled: "Este servidor tiene desactivada la creación de cuentas nuevas. Inicia sesión con una cuenta existente o pide al administrador del servidor que active los registros.",
      failedToForkSession: "No se pudo bifurcar la sesión",
      daemonUnavailableTitle: "Daemon no disponible",
      daemonUnavailableBody:
        "Happier no puede comunicarse con el daemon en esta máquina. Puede estar sin conexión, iniciándose o desconectado del servidor.",
      tryAgain: "Intenta de nuevo",
      contactSupport: "Contacta soporte si el problema persiste",
      sessionNotFound: "Sesión no encontrada",
      voiceSessionFailed: "Falló al iniciar sesión de voz",
      dictationFailed: "Error de dictado",
      voiceServiceUnavailable:
      "El servicio de voz no está disponible temporalmente",
      voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
      `Límite de sesión de voz: aproximadamente ${duration}.`,
      voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
      `La sesión de voz terminará en aproximadamente ${duration}.`,
      voiceSessionLimitExpired:
      "La sesión de voz alcanzó el límite de tiempo actual y terminó.",
    voiceAlreadyStarting: "La voz ya se está iniciando en otra sesión",
    oauthInitializationFailed: "Falló al inicializar el flujo OAuth",
    tokenStorageFailed: "Falló al almacenar los tokens de autenticación",
    oauthStateMismatch: "Falló la validación de seguridad. Inténtalo de nuevo",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} ya está vinculado a una cuenta de Happier existente. Para iniciar sesión en este dispositivo, vincúlalo desde un dispositivo que ya haya iniciado sesión.`,
    tokenExchangeFailed: "Falló al intercambiar el código de autorización",
    oauthAuthorizationDenied: "La autorización fue denegada",
    webViewLoadFailed: "Falló al cargar la página de autenticación",
    failedToLoadProfile: "No se pudo cargar el perfil de usuario",
    userNotFound: "Usuario no encontrado",
    sessionDeleted: "La sesión no está disponible",
    sessionDeletedDescription:
      "Es posible que se haya eliminado o que ya no tengas acceso.",

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
    }) => `${field} debe estar entre ${min} y ${max}`,
    retryIn: ({ seconds }: { seconds: number }) =>
      `Intenta en ${seconds} ${seconds === 1 ? "segundo" : "segundos"}`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (Error ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `Falló al desconectar ${service}`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `No se pudo conectar ${service}. Por favor, inténtalo de nuevo.`,
    failedToLoadFriends: "No se pudo cargar la lista de amigos",
    failedToAcceptRequest: "No se pudo aceptar la solicitud de amistad",
    failedToRejectRequest: "No se pudo rechazar la solicitud de amistad",
    failedToRemoveFriend: "No se pudo eliminar al amigo",
    searchFailed: "La búsqueda falló. Por favor, intenta de nuevo.",
    failedToSendRequest: "No se pudo enviar la solicitud de amistad",
    failedToResumeSession: "No se pudo reanudar la sesión",
    failedToSendMessage: "No se pudo enviar el mensaje",
    failedToSwitchControl: "No se pudo cambiar el modo de control",
    cannotShareWithSelf: "No puedes compartir contigo mismo",
    canOnlyShareWithFriends: "Solo puedes compartir con amigos",
    shareNotFound: "Compartido no encontrado",
    publicShareNotFound: "Enlace público no encontrado o expirado",
    consentRequired: "Se requiere consentimiento para acceder",
    maxUsesReached: "Se alcanzó el máximo de usos",
    invalidShareLink: "Enlace de compartir inválido o expirado",
    missingPermissionId: "Falta el id de permiso",
    codexResumeNotInstalledTitle:
      "El servidor de reanudación de Codex no está instalado en esta máquina",
    codexResumeNotInstalledMessage:
      "Para reanudar una conversación de Codex, instala el servidor de reanudación de Codex en la máquina de destino (Detalles de la máquina → Installables).",
    codexAcpNotInstalledTitle: "Codex ACP no está instalado en esta máquina",
    codexAcpNotInstalledMessage:
      "Para usar el experimento de Codex ACP, instala codex-acp en la máquina de destino (Detalles de la máquina → Installables) o desactiva el experimento.",

    sourceControlUnavailableForSession: "El control de código fuente no está disponible para esta sesión.",},

  deps: {
    installNotSupported:
      "Actualiza Happier CLI para instalar esta dependencia.",
    installFailed: "Instalación fallida",
    installed: "Instalado",
    installLog: ({ path }: { path: string }) =>
      `Registro de instalación: ${path}`,
    installable: {
      codexResume: {
        title: "Servidor de reanudación de Codex",
      },
      codexAcp: {
        title: "Adaptador ACP de Codex",
      },
      githubCli: {
        title: "CLI de GitHub",
      },

      gh: {
        title: "GitHub CLI",
      },},
    ui: {
      notAvailable: "No disponible",
      notAvailableUpdateCli: "No disponible (actualiza la CLI)",
      errorRefresh: "Error (actualizar)",
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
        `Instalado (v${installedVersion}) — actualización disponible (v${latestVersion})`,
      notInstalled: "No instalado",
      latest: "Última",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version} (etiqueta: ${tag})`,
      registryCheck: "Comprobación del registro",
      registryCheckFailed: ({ error }: { error: string }) => `Falló: ${error}`,
      installSource: "Origen de instalación",
      installSourceDefault: "(predeterminado)",
      lastInstallLog: "Último registro de instalación",
      installLogTitle: "Registro de instalación",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
    // Used by new-session screen and launch flows
    title: "Iniciar nueva sesión",
    selectAiProfileTitle: "Seleccionar perfil de IA",
    selectAiProfileDescription:
      "Selecciona un perfil de IA para aplicar variables de entorno y valores predeterminados a tu sesión.",
    changeProfile: "Cambiar perfil",
    aiBackendSelectedByProfile:
      "El backend de IA lo selecciona tu perfil. Para cambiarlo, selecciona un perfil diferente.",
    selectAiBackendTitle: "Seleccionar backend de IA",
    aiBackendLimitedByProfileAndMachineClis:
      "Limitado por tu perfil seleccionado y los CLI disponibles en esta máquina.",
    aiBackendSelectWhichAiRuns: "Selecciona qué IA ejecuta tu sesión.",
    aiBackendNotCompatibleWithSelectedProfile:
      "No es compatible con el perfil seleccionado.",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `No se detectó el CLI de ${cli} en esta máquina.`,
    selectMachineTitle: "Seleccionar máquina",
    selectMachineDescription: "Elige dónde se ejecuta esta sesión.",
    selectPathTitle: "Seleccionar ruta",
    selectWorkingDirectoryTitle: "Seleccionar directorio de trabajo",
    selectWorkingDirectoryDescription:
      "Elige la carpeta usada para comandos y contexto.",
    selectPermissionModeTitle: "Seleccionar modo de permisos",
    selectPermissionModeDescription:
      "Controla qué tan estrictamente las acciones requieren aprobación.",
    selectModelTitle: "Seleccionar modelo de IA",
    selectModelDescription: "Elige el modelo usado por esta sesión.",
    checkout: {
      selectTitle: "Seleccionar copia de trabajo",
      noWorktree: "Carpeta actual",
      noWorktreeSubtitle:
        "Usa la carpeta ya seleccionada sin vincular una copia de trabajo del espacio de trabajo.",
      noWorktreeSectionTitle: "Carpeta actual",
      existingWorktreesSectionTitle: "Copias de trabajo vinculadas",
      actionsSectionTitle: "Acciones",
      newWorktree: "Nuevo worktree",
      newWorktreeSubtitle: "Crea y usa un nuevo worktree de Git para esta sesión.",
      pendingWorktreeSubtitle: ({ branch, path }: { branch: string; path: string }) => `Desde ${branch} · ${path}`,
      existingWorktree: "Worktree existente",
      existingWorktreeSubtitle: "Elige un worktree Git existente para esta sesión.",
      existingWorktreeEmptyTitle: "No hay worktrees existentes",
      existingWorktreeEmptySubtitle:
        "Crea un worktree de Git primero o elige Nuevo worktree.",
      newWorktreeDetailWorkspace:
        "Crea una nueva copia de trabajo vinculada dentro de este espacio de trabajo.",
      newWorktreeDetailBranch:
        "Parte del estado actual del repositorio y elige un nuevo nombre de rama/worktree.",
      branchPickerTitle: "Empezar desde",
      branchPickerCurrentHead: "Rama actual",
      branchPickerCurrentHeadDescription: "Empieza desde la rama que está actualmente comprobada en este repositorio.",
      branchPickerEmpty: "No hay ramas disponibles para este repositorio.",
      branchPickerSearchPlaceholder: "Buscar ramas…",
      branchPickerRefreshA11y: "Actualizar ramas",
      branchPickerLoadingA11y: "Cargando ramas",
      branchPickerRefreshingA11y: "Actualizando ramas",
      primaryDetailDescription:
        "Usa la copia de trabajo principal vinculada de este espacio de trabajo en la máquina seleccionada.",
      gitWorktreeDetailDescription:
        "Usa un worktree de Git ya vinculado para esta sesión.",
      existingBranchWorktreeDescription:
        "Esta rama ya tiene un worktree. Puedes reutilizarlo directamente o crear una nueva rama a partir de él.",
      existingBranchDescription:
        "Esta rama puede usarse directamente en un nuevo worktree, o puedes crear una nueva rama a partir de ella.",
      createNewBranchFromBranchHint:
        "Usa Aplicar para crear una nueva rama y un worktree a partir de esta rama.",
      useExistingBranchAction: "Usar rama existente",
      useExistingWorktreeAction: "Usar worktree existente",
      detailBranch: ({ branch }: { branch: string }) => `Rama: ${branch}`,
      detailPath: ({ path }: { path: string }) => `Ruta: ${path}`,
      detailLinkedWorkspace: "Vinculado al espacio de trabajo actual.",
    },
    selectSessionTypeTitle: "Seleccionar tipo de sesión",
    selectSessionTypeDescription:
      "Elige una sesión simple o una vinculada a un worktree de Git.",
    searchPathsPlaceholder: "Buscar rutas...",
    noMachinesFound:
      "No se encontraron máquinas. Inicia una sesión de Happier en tu computadora primero.",
    allMachinesOffline: "Todas las máquinas están desconectadas",
    machineOfflineInlineTitle: "La máquina está sin conexión",
    machineOfflineInlineBody:
      "Inicia el daemon en esta máquina o elige otra antes de crear una sesión.",
    machineOfflineCannotStartStatus:
      "sin conexión (no se puede iniciar la sesión)",
    automationChip: {
      default: "Automatizar",
      interval: ({ minutes }: { minutes: number }) => `Cada ${minutes} min`,
      cron: "Programación cron",
    },
    machineDetails: "Ver detalles de la máquina →",
    directoryDoesNotExist: "Directorio no encontrado",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `El directorio ${directory} no existe. ¿Deseas crearlo?`,
    sessionStarted: "Sesión iniciada",
    sessionStartedMessage: "La sesión se ha iniciado correctamente.",
    sessionSpawningFailed:
      "Falló la creación de sesión - no se devolvió ID de sesión.",
    failedToStart:
      "No se pudo iniciar la sesión. Inténtalo de nuevo o revisa la máquina y la configuración de sesión seleccionadas.",
    actionMethodUnavailable: "Actualiza Happier en la máquina de destino para crear una sesión nueva.",
    sessionTimeout:
      "El inicio de sesión expiró. La máquina puede ser lenta o el daemon puede no estar respondiendo.",
    notConnectedToServer:
      "No conectado al servidor. Verifica tu conexión a internet.",
    daemonRpcUnavailableTitle: "Daemon no disponible",
    daemonRpcUnavailableBody:
      "Happier no puede comunicarse con el daemon en esta máquina. Puede estar sin conexión, iniciándose o desconectado del servidor.",
    launchStillPendingTitle: "El inicio sigue en curso",
    launchStillPendingBody:
      "Happier aún no ha confirmado la nueva sesión. La solicitud de inicio sigue guardada. Vuelve a intentarlo para continuar el mismo inicio sin crear una sesión duplicada.",
    connectedServiceSwitchUnavailable: {
      startFreshAction: "Empezar de cero con la nueva cuenta",
    },
    startingSession: "Iniciando sesión...",
    startNewSessionInFolder: "Nueva sesión aquí",
    noMachineSelected:
      "Por favor, selecciona una máquina para iniciar la sesión",
    noPathSelected:
      "Por favor, selecciona un directorio para iniciar la sesión",
    machinePicker: {
      searchPlaceholder: "Buscar máquinas...",
      recentTitle: "Recientes",
      favoritesTitle: "Favoritos",
      allTitle: "Todas",
      emptyMessage: "No hay máquinas disponibles",
    },
    pathPicker: {
      enterPathTitle: "Ingresar ruta",
      enterPathPlaceholder: "Ingresa una ruta...",
      customPathTitle: "Ruta personalizada",
      truncatedDirectoryInfo: ({ count }: { count: number }) => `Mostrando los primeros ${count} elementos`,
      recentTitle: "Recientes",
      favoritesTitle: "Favoritos",
      suggestedTitle: "Sugeridas",
      allTitle: "Todas",
      emptyRecent: "No hay rutas recientes",
      emptyFavorites: "No hay rutas favoritas",
      emptySuggested: "No hay rutas sugeridas",
      emptyAll: "No hay rutas",
      inThisFolderTitle: "En esta carpeta",
      openInTreeBrowserLabel: "Abrir en el navegador de árbol",
      openFolderLabel: "Mostrar contenido de la carpeta",
      emptyInThisFolder: "Sin coincidencias en esta carpeta",
      favoriteAdd: "Añadir a favoritos",
      favoriteRemove: "Quitar de favoritos",
      hints: {
        navigate: "navegar",
        commit: "confirmar ruta",
        autocomplete: "autocompletar",
        walkUp: "subir un nivel",
      },
    },
    sessionType: {
      title: "Tipo de sesión",
      simple: "Sencilla",
      worktree: "Worktree (git)",
      comingSoon: "Próximamente",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Requiere ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) => `${cli} CLI no detectado`,
    },
    profileSelection: {
      workspaceDefault: "Predeterminado del espacio de trabajo",
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `${cli} CLI no detectado`,
      dontShowFor: "No mostrar este aviso para",
      thisMachine: "esta máquina",
      anyMachine: "cualquier máquina",
      installCommand: ({ command }: { command: string }) =>
        `Instalar: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `Instala ${cli} CLI si está disponible •`,
      viewInstallationGuide: "Ver guía de instalación →",
      viewGeminiDocs: "Ver documentación de Gemini →",
    },
    worktree: {
      creating: ({ name }: { name: string }) => `Creando worktree '${name}'...`,
      notGitRepo: "Los worktrees requieren un repositorio git",
      failed: ({ error }: { error: string }) =>
        `Error al crear worktree: ${error}`,
      success: "Worktree creado exitosamente",
      createTitle: "Nuevo worktree desde una rama",
      backToRoot: "árboles de trabajo",
      searchPlaceholder: "Buscar worktrees",
      searchBranchPlaceholder: "Buscar ramas",
      sections: {
        localBranches: "RAMAS LOCALES",
        remoteBranches: "RAMAS REMOTAS",
      },
      statusPill: {
        clean: "limpio",
        idle: "inactivo",
        // FR4-10: StatusPill renders the count separately; suffix-only.
        changesSuffix: ({ count }: { count: number }) =>
          count === 1 ? "cambio" : "cambios",
      },
      branchRow: {
        reuseLabel: "Tiene worktree",
        reuseSubtitle: ({ path }: { path: string }) => path,
      },
      nameStep: {
        title: "Nombra tu worktree",
        backLabel: "Ramas",
        placeholder: "Nombra este worktree",
        emptyHint: "Este será el nombre de la nueva rama y del worktree.",
        suggestedSectionTitle: "Sugerido",
        suggestedSubtitle: "Usar el nombre generado",
        useSuggested: ({ name }: { name: string }) => `Usar nombre sugerido: ${name}`,
        createNamed: ({ name }: { name: string }) => `Crear worktree: ${name}`,
        customHint: "O escribe un nombre arriba para un worktree personalizado",
        hints: {
          create: "crear",
          back: "atrás",
        },
      },
      reuseOrCreate: {
        title: "La rama ya tiene un worktree",
        useExisting: "Usar worktree existente",
        createNew: "Crear nuevo worktree desde esta rama",
        createNewSubtitle: "Deriva en un nuevo worktree con nombre",
      },
      hints: {
        navigate: "navegar",
        select: "seleccionar",
        back: "atrás",
      },
    },
    resume: {
      title: "Reanudar sesión",
      optional: "Reanudar: Opcional",
      chipOptional: ({ agent }: { agent: string }) => `Reanudar sesión de ${agent}`,
      pickerTitle: "Reanudar sesión",
      subtitle: ({ agent }: { agent: string }) =>
        `Pega un ID de sesión de ${agent} para reanudar`,
      placeholder: ({ agent }: { agent: string }) =>
        `Pega el ID de sesión de ${agent}…`,
      browse: "Explorar sesiones",
      paste: "Pegar",
      save: "Guardar",
      clearAndRemove: "Borrar",
      helpText:
        "Puedes encontrar los IDs de sesión en la pantalla de información de sesión.",
      cannotApplyBody:
        "Este ID de reanudación no se puede aplicar ahora. Happier iniciará una nueva sesión en su lugar.",
    },
    codexResumeBanner: {
      title: "Servidor de reanudación de Codex",
      updateAvailable: "Actualización disponible",
      systemCodexVersion: ({ version }: { version: string }) =>
        `Codex del sistema: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Servidor de Codex resume: ${version}`,
      notInstalled: "no instalado",
      latestVersion: ({ version }: { version: string }) =>
        `(última ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `La comprobación del registro falló: ${error}`,
      install: "Instalar",
      update: "Actualizar",
      reinstall: "Reinstalar",
    },
    codexResumeInstallModal: {
      installTitle: "¿Instalar el servidor de reanudación de Codex?",
      updateTitle: "¿Actualizar el servidor de reanudación de Codex?",
      reinstallTitle: "¿Reinstalar el servidor de reanudación de Codex?",
      description:
        "Esto instala un wrapper experimental de servidor MCP de Codex usado solo para operaciones de reanudación.",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "Instalar",
      update: "Actualizar",
      reinstall: "Reinstalar",
    },
    codexAcpInstallModal: {
      installTitle: "¿Instalar Codex ACP?",
      updateTitle: "¿Actualizar Codex ACP?",
      reinstallTitle: "¿Reinstalar Codex ACP?",
      description:
        "Esto instala un adaptador ACP experimental alrededor de Codex que admite cargar/reanudar hilos.",
    },
        githubCliBanner: {
            title: 'GitHub CLI',
            install: 'Instalar',
            update: 'Actualizar',
            reinstall: 'Reinstalar',
        },
    githubCliInstallModal: {
      installTitle: "¿Instalar GitHub CLI?",
      updateTitle: "¿Actualizar GitHub CLI?",
      reinstallTitle: "¿Reinstalar GitHub CLI?",
      description:
        "Esto instala GitHub CLI para que Happier pueda usar tu autenticación local de GitHub en flujos de pull request.",
    },

    ghCliBanner: {
      title: "GitHub CLI",
      install: "Instalar",
      update: "Actualizar",
      reinstall: "Reinstalar",
    },
    ghCliInstallModal: {
      installTitle: "¿Instalar GitHub CLI?",
      updateTitle: "¿Actualizar GitHub CLI?",
      reinstallTitle: "¿Reinstalar GitHub CLI?",
      description:
        "Esto instala la dependencia opcional GitHub CLI usada por los flujos de control de código de GitHub después de tu confirmación.",
    },},

  sessionHistory: {
    // Used by session history screen
    title: "Historial de sesiones",
    empty: "No se encontraron sesiones",
    today: "Hoy",
    yesterday: "Ayer",
    daysAgo: ({ count }: { count: number }) =>
      `hace ${count} ${count === 1 ? "día" : "días"}`,
    viewAll: "Ver todas las sesiones",
  },

  sessionHandoff: sessionHandoffTranslationExtensions.es,

  session: {
    providerBinding: providerSessionTranslations.es,
    transcriptNavigation: {
      title: "Navegar",
      modeAll: "Todo",
      modePinned: "Fijados",
      entryCount: ({ count }: { count: number }) => `${count} ${count === 1 ? "entrada" : "entradas"}`,
      pinnedCount: ({ count }: { count: number }) => `${count} fijados`,
      emptyPinnedTitle: "No hay mensajes fijados",
      emptyPinnedBody: "Fija mensajes para guardar aquí los turnos importantes.",
      emptyAllTitle: "No hay entradas de navegación",
      emptyAllBody: "Los turnos de usuario y mensajes fijados aparecerán aquí.",
      entryA11y: ({ label }: { label: string }) => `Saltar a ${label}`,
      entryPinnedA11y: ({ label }: { label: string }) => `Saltar al mensaje fijado: ${label}`,
      fallbackPinnedAssistant: "Mensaje de asistente fijado",
      fallbackPinnedTool: "Mensaje de herramienta fijado",
      fallbackPinnedMessage: "Mensaje fijado",
      pinMessageA11y: "Fijar mensaje",
      unpinMessageA11y: "Desanclar mensaje",
      pinToolCallA11y: "Fijar llamada de herramienta",
      unpinToolCallA11y: "Desanclar llamada de herramienta",
      jumpFailed: "No se pudo saltar a este mensaje.",
      replyNotLoaded: "Respuesta no cargada",
      awaitingReply: "Esperando respuesta",
      loadingBody: "Cargando la navegación de la transcripción…",
      railScrollUpA11y: "Desplazar la navegación hacia arriba",
      railScrollDownA11y: "Desplazar la navegación hacia abajo",
      emptyPinnedHint: "Pasa el cursor sobre un mensaje y elige el icono de fijar para fijarlo.",
      emptyPinnedPrivacy: "Los mensajes fijados solo se guardan en este dispositivo.",
    },

    inputPlaceholder: "Escriba un mensaje ...",
    workState: {
      accessibilityLabel: "Estado de trabajo de la sesión",
      commandDescription: "Definir o consultar el objetivo de la sesión",
      unsupportedTitle: "Objetivo no disponible",
      unsupportedMessage:
        "Este backend aún no admite objetivos de sesión editables.",
      notReadyTitle: "Los controles del objetivo aún no están listos",
      notReadyMessage:
        "Esta sesión todavía se está iniciando. Vuelve a definir el objetivo en un momento.",
      noCurrentGoalTitle: "No hay ningún objetivo que actualizar",
      noCurrentGoalMessage:
        "Define un objetivo antes de pausarlo o reanudarlo.",
      dirtyCloseTitle: "¿Descartar cambios del objetivo?",
      dirtyCloseBody: "Se perderán los cambios del objetivo sin guardar.",
      emptyPlaceholder: "Aún no hay nada aquí",
      badge: {
        goal: ({ title }: { title: string }) => `Objetivo: ${title}`,
        goalPaused: "Objetivo en pausa",
        goalBlocked: "Objetivo bloqueado",
        goalBudgetLimited: "Objetivo limitado por presupuesto",
        goalComplete: "Objetivo completado",
        item: ({ title }: { title: string }) => title,
      },
      group: {
        active: "Activo",
        pending: "Pendiente",
        blockedPaused: "Bloqueado o en pausa",
        done: "Completado o cancelado",
      },
      workflow: {
          sectionTitle: "Flujos de trabajo activos",
          goalActive: "Objetivo activo",
          goalLabel: ({ title }: { title: string }) => `Objetivo: ${title}`,
          bare: "Flujo de trabajo",
          agentsFallback: ({ fraction }: { fraction: string }) => `Flujo de trabajo ${fraction} agentes`,
          olderRunsHidden: ({ count }: { count: number }) => `${count} ejecuciones anteriores ocultas`,
          phaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
          plural: ({ count }: { count: number }) => `${count} flujos de trabajo`,
          pluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} flujos de trabajo · ${agents} agentes`,
          join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
          permissionBlocked: "Requiere revisión",
      },
      goal: {
        title: "Objetivo",
        placeholder: "¿En qué debería centrarse esta sesión?",
        set: "Definir objetivo",
        pause: "Pausar",
        resume: "Reanudar",
        clear: "Limpiar",
        clearTitle: "¿Borrar objetivo?",
        clearBody: "Esto elimina el objetivo editable de esta sesión.",
        statusActive: "Activo",
        statusPaused: "En pausa",
        statusComplete: "Completado",
        statusBudgetLimited: "Limitado por presupuesto",
        statusInterrupted: "Interrumpido",
        setTitle: "Define un objetivo",
        setSubtitle: "Da un enfoque a esta sesión para que el agente no se desvíe.",
        addBudget: "+ Añadir un límite de presupuesto (opcional)",
        removeBudget: "Quitar presupuesto",
        noUsageYet: "Sin uso todavía",
        tokenBudget: "Presupuesto de tokens",
        tokensSuffix: ({ count }: { count: string }) => `${count} tokens`,
        budgetProgress: ({ used, budget }: { used: string; budget: string }) => `${used} / ${budget}`,
        budgetCaption: ({ budget }: { budget: string }) => `de ${budget} de presupuesto`,
        budgetPlaceholder: "Límite de tokens",
        invalidBudget: "Introduce un presupuesto de tokens positivo.",
        pending: "Estableciendo objetivo…",
        stillWaiting: "Esperando la confirmación…",
        accessibilityCurrent: ({ objective }: { objective: string }) => `Objetivo actual: ${objective}`,
        errorUnsupportedResponse: "Respuesta no compatible del RPC de sesión",
        errorUnknown: "Error desconocido",
        errorCannotResume: "No se puede reanudar la sesión para actualizar el objetivo nativo",
      },
    },
    usageLimitRecovery: {
      banner: {
        title: "Límite de uso alcanzado",
        body: "Happier puede esperar a que se restablezca el límite y reanudar esta sesión automáticamente.",
        waitingTitle: "Esperando el restablecimiento del límite de uso",
        waitingBody: "Happier volverá a comprobar cuando se espere que el proveedor acepte solicitudes.",
        readyTitle: "El límite de uso se restableció",
        readyBody: "Ya puedes reanudar esta sesión.",
        resetCreditSummary: ({ count, expiresAt }: { count: number; expiresAt: string | null }) => {
          const label = count === 1 ? "1 restablecimiento de uso" : `${count} restablecimientos de uso`;
          return expiresAt ? `${label} disponible. El primero vence el ${expiresAt}.` : `${label} disponible.`;
        },
      },
      actions: {
        enable: "Reanudar cuando se restablezca el límite",
        cancel: "Cancelar espera",
        checkNow: "Comprobar límite ahora",
        resumeNow: "Reanudar ahora",
        switchFallbackNow: "Cambiar a la cuenta alternativa",
        switchAccountNow: "Cambiar de cuenta ahora",
        consumeResetCredit: "Aplicar restablecimiento de uso",
        retryTemporaryThrottle: "Reintentar ahora",
        remember: "Esperar y reanudar siempre",
        forget: "Preguntar cada vez",
        hideBanner: "Ocultar banner de límite de uso",
        showBanner: "Mostrar banner de límite de uso",
      },
      status: {
        ready: "Límite de uso",
        resumeReady: "Listo para reanudar",
        checking: "Comprobando límite",
        waiting: "Esperando restablecimiento",
        waitingForQuotaReset: "Esperando restablecimiento de cuota",
        accountRotationPending: "Rotación de cuenta pendiente",
        temporaryThrottle: "Limitación temporal",
      },
    },
    composerBanners: {
        showBannerAction: 'Mostrar aviso',
        hideBannerAction: 'Ocultar aviso',
    },
    staleRunner: {
      banner: {
        title: "El runner de la sesión no está actualizado",
        body: "Esta sesión aún se ejecuta con código de runtime anterior. Reinicia el runner para usar el runtime actual del daemon.",
        pendingBody: "Reiniciando el runner de la sesión con el runtime actual del daemon.",
        busyBody: "El runner está ocupado ahora mismo. Vuelve a intentarlo cuando termine el trabajo actual.",
        failedBody: "No se pudo reiniciar el runner. La sesión sigue disponible con el runner existente.",
        unavailableBody: "El reinicio no está disponible para esta sesión. La sesión puede seguir ejecutándose en el runner existente.",
      },
      actions: {
        restart: "Reiniciar runner",
        restarting: "Reiniciando...",
        hideBanner: "Ocultar aviso de runner antiguo",
        showBanner: "Mostrar aviso de runner antiguo",
      },
      status: {
        stale: "Actualización del runner",
        restarting: "Reiniciando runner",
        busy: "Runner ocupado",
        failed: "Falló el reinicio",
      },
    },
    rightPanel: {
      tabs: {
        git: "Git",
      },
    },
    toolCalls: "Llamadas de herramientas",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} más…`,
    agentContinuation: {
      currentAgentAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Ejecutando esta sesión.`,
      currentAgentLastUsedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Usado por última vez en esta sesión.`,
      currentAgentLastReportedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Último informado para esta sesión.`,
      armedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Seleccionado para tu próximo mensaje.`,
      detailTitle: ({ agent }: { agent: string }) => `Continuar con ${agent}`,
      sendLabel: ({ agent }: { agent: string }) => `Continuar con ${agent}`,
      detailDescription: 'Tu conversación reciente se mantiene como texto; las imágenes y los archivos no. No se envía nada hasta tu próximo mensaje.',
      detailDescriptionEmpty: 'Todavía no hay ninguna conversación que mantener. No se envía nada hasta tu próximo mensaje.',
      announcement: ({ agent }: { agent: string }) => `${agent} seleccionado para el próximo mensaje. No se ha enviado nada.`,
      dividerTitle: ({ from: from_, to }: { from: string; to: string }) => `Esta sesión continuó de ${from_} a ${to}`,
      handedOver: {
          open: "Mostrar el contexto transferido aquí",
          title: "Contexto transferido",
          reconstructed: "Reconstruido ahora a partir de la transcripción de esta sesión, no guardado en su momento, así que puede diferir de lo que se envió. Lo que el Agente anterior estaba siguiendo, y su propio registro, no se pueden reconstruir, así que se omiten.",
          loading: "Reconstruyendo…",
          empty: "No se transfirió nada. No había conversación anterior que reproducir.",
          unavailableOperation: "Actualiza o reconecta la CLI en esta máquina para reconstruirlo.",
          notRebuildable: "Aquí se transfirió contexto, pero la transcripción de esta sesión ya no lo contiene, así que no se puede reconstruir.",
          unavailableSource: "Happier no pudo leer la transcripción de esta sesión, así que no se puede reconstruir.",
          unreachable: "Happier no pudo contactar con la máquina que aloja esta sesión.",
          retryAction: "Reintentar",
          jumpAction: "Ir al último mensaje incluido",
      },
      checking: "Comprobando disponibilidad…",
      unavailable: {
        unsupportedSession: ({ agent }: { agent: string }) => `Esta sesión no puede continuar con ${agent}.`,
        updateCli: "Actualiza la CLI de esta máquina para cambiar de agente.",
        updateOrReconnect: "Actualiza o vuelve a conectar la CLI para cambiar de agente.",
        targetNoSessions: ({ agent }: { agent: string }) => `${agent} no puede ejecutar una sesión.`,
        targetNotProven: ({ agent }: { agent: string }) => `Todavía no se puede cambiar a ${agent}.`,
        targetUnavailable: ({ agent }: { agent: string }) => `${agent} no está disponible en esta máquina.`,
      },
      transition: {
        rejected: {
          unsupportedOperation: 'Esta sesión no admite el cambio de agente. No se ha enviado nada.',
          forbidden: 'No tienes permiso para cambiar el agente de esta sesión. No se ha enviado nada.',
          sameTarget: ({ agent }: { agent: string }) => `Esta sesión ya se ejecuta con ${agent}. No se ha enviado nada.`,
          staleSelection: 'La sesión cambió mientras elegías. No se ha enviado nada: inténtalo de nuevo.',
          targetUnavailable: ({ agent }: { agent: string }) => `${agent} no está disponible en esta máquina. No se ha enviado nada.`,
          sourceNotIdle: ({ agent }: { agent: string }) => `${agent} sigue trabajando. No se ha enviado nada: inténtalo cuando termine.`,
          sourceStopFailed: ({ agent }: { agent: string }) => `No se pudo detener ${agent}, así que nada ha cambiado. No se ha enviado nada.`,
        },
        conflictingDestination: ({ agent }: { agent: string }) => `No se ha enviado nada. Este mensaje ya tiene otro destino, así que no puede cambiar además esta sesión a ${agent}. Quita uno de los dos y vuelve a enviar.`,
        sourceStopped: ({ source, agent }: { source: string; agent: string }) => `${source} se detuvo, pero el cambio a ${agent} no se completó. Tu mensaje no se envió.`,
        switched: ({ agent }: { agent: string }) => `Esta sesión ahora es ${agent}, pero tu mensaje no se envió. Vuelve a enviarlo.`,
        /** Compact status for the collapsed composer banner badge. */
        badgeLabel: 'Cambio de Agente',
        /** Delegates to the Session’s existing resume owner; never a second start path. */
        resumeAction: 'Reanudar sesión',
        unknown: 'Happier no pudo confirmar qué ocurrió. Revisa esta sesión antes de volver a enviar.',
      },
    },
    sourceContext: {
        chipLabel: ({ session }: { session: string }) => `De ${session}`,
        unknownSession: "otra sesión",
        detailTitle: "Continuando desde otra sesión",
        detailBodyLatest: ({ session }: { session: string }) => `La conversación de ${session} se llevará como contexto de esta nueva sesión.`,
        detailBodyAtMessage: ({ session }: { session: string }) => `La conversación de ${session}, hasta el mensaje que elegiste, se llevará como contexto de esta nueva sesión.`,
        carriedOver: "La conversación se llevará",
        removeAction: "Quitar",
        removeA11y: "Quitar la conversación de origen",
        keepAction: "Mantenerla",
        serverMismatch: "Esa conversación está en otro servidor de Happier. Vuelve a él o quita la conversación de origen para empezar de cero.",
    },
    forking: {
      dividerTitle: "Bifurcado desde un contexto anterior",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Bifurcado desde ${parent}`,
      dividerSubtitle: "Contexto anterior (solo lectura)",
      openParent: "Abrir",
      openParentA11y: "Abrir sesión padre",
      forkFromMessageA11y: "Bifurcar desde este mensaje",
      strategy: {
          title: "Bifurcar esta sesión",
          subtitleLatest: "Crear una rama desde donde está ahora esta conversación.",
          subtitleFromMessage: "Crear una rama desde este punto de la conversación.",
          recommended: "Recomendado",
          native: {
              title: "Bifurcación nativa",
              subtitle: "El agente bifurca su propia conversación. Lo más fiel al original.",
          },
          replay: {
              title: "Bifurcación con Replay",
              subtitle: "Happier reproduce la conversación hasta ahora como contexto de la nueva sesión.",
          },
          configure: {
              title: "Configurar una sesión nueva",
              subtitle: "Elige otro agente, modelo, máquina o carpeta y lleva esta conversación contigo.",
          },
          unavailable: {
              nativeAgent: "Este agente no puede bifurcar su propia conversación.",
              nativeFromMessage: "Este agente puede bifurcar toda la conversación, pero no desde un mensaje anterior.",
              nativeProviderBound: "El agente no puede bifurcar una sesión vinculada a una cuenta de proveedor.",
              replayOff: "Replay está desactivado en Configuración.",
              replaySettingsAction: "Configuración de Replay",
          },
          progress: {
              creatingNative: "Creando la bifurcación nativa…",
              creatingReplay: "Creando la bifurcación con Replay…",
              opening: "Abriendo tu bifurcación…",
              stalledTitle: "Tu bifurcación se creó",
              stalledBody: "Todavía no aparece aquí. Intenta abrirla de nuevo.",
              openAction: "Abrir bifurcación",
          },
          unknown: {
              title: "Happier no pudo confirmar la bifurcación",
              body: "La solicitud salió, así que puede que ya exista una bifurcación. Compruébalo en lugar de volver a bifurcar, porque un segundo intento podría crear un duplicado.",
              checkAction: "Buscar la bifurcación",
              checking: "Buscando tu bifurcación…",
              noneFound: "Todavía no hay ninguna bifurcación coincidente. Puede que siga iniciándose, así que puedes volver a comprobarlo.",
              ambiguous: "Apareció más de una bifurcación coincidente. Abre tu lista de sesiones para elegir la correcta.",
          },
          failure: {
              updateRequired: "Actualiza o reconecta la CLI de esta máquina para bifurcar esta sesión.",
              generic: "Happier no pudo crear la bifurcación.",
          },
      },
	    },
	    transcriptGap: {
	      earlierMessages: "Mensajes anteriores",
	      laterMessages: "Mensajes posteriores",
	    },
	    rollback: {
	      latestTurnA11y: 'Revertir el ultimo turno',
	      beforeUserMessageA11y: 'Revertir antes de este mensaje',

	      checkpointCode: {
	        title: 'Opciones de reversión',
	        conversationUnavailable: 'La reversión de conversación no está disponible para esta sesión.',
	        codeOnlyConfirmation: 'Entiendo que la conversación no cambiará.',
	        showAdvanced: 'Mostrar opciones avanzadas solo de código',
	        choices: {
	          conversation_only: {
	            title: 'Solo conversación',
	            description: 'Revierte la transcripción sin cambiar archivos.',
	          },
	          conversation_and_code_with_stash: {
	            title: 'Conversación y código, con Git stash',
	            description: 'Crea un checkpoint de Happier, guarda cambios con stash y aplica el parche inverso.',
	          },
	          conversation_and_code_without_stash: {
	            title: 'Conversación y código, sin Git stash',
	            description: 'Crea un checkpoint de Happier y aplica el parche inverso en este worktree.',
	          },
	          code_only_with_stash: {
	            title: 'Solo código, con Git stash',
	            description: 'Avanzado: deja la transcripción intacta y revierte archivos tras un stash.',
	          },
	          code_only_without_stash: {
	            title: 'Solo código, sin Git stash',
	            description: 'Avanzado: deja la transcripción intacta y revierte archivos solo con el checkpoint de Happier.',
	          },
	        },
	      },},
	    resuming: "Reanudando...",
	    resumeFailed: "No se pudo reanudar la sesión",
	    pendingQueuedResumeFailedTitle: "Mensaje en cola",
	    pendingQueuedResumeFailedBody:
	      "Tu mensaje se guardó en la cola de pendientes, pero Happier no pudo reanudar esta sesión. Reintenta para iniciarla.",
	    invalidLinkTitle: "Enlace de sesión no válido",
	    invalidLinkDescription: "Falta el enlace de la sesión o no es válido. Comprueba la URL y vuelve a intentarlo.",
	    resumeSupportNoteChecking:
	      "Nota: Happier todavía está comprobando si esta máquina puede reanudar la sesión del proveedor.",
	    resumeSupportNoteUnverified:
	      "Nota: Happier no pudo verificar la compatibilidad de reanudación para esta máquina.",
    resumeSupportDetails: {
      cliNotDetected: "No se detectó la CLI en la máquina.",
      capabilityProbeFailed: "Falló la comprobación de capacidades.",
      acpProbeFailed: "Falló la comprobación ACP.",
      loadSessionFalse: "El agente no admite cargar sesiones.",
    },
    inactiveResumable: "Inactiva (reanudable)",
    inactiveMachineOffline: "Inactiva (máquina sin conexión)",
    inactiveNotResumable: "Inactiva",
    inactiveNotResumableNoticeTitle: "Esta sesión no se puede reanudar",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `Esta sesión terminó y no se puede reanudar porque ${provider} no admite restaurar su contexto aquí. Inicia una nueva sesión para continuar.`,
    machineOfflineNoticeTitle: "La máquina está sin conexión",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” está sin conexión, así que Happier no puede reanudar esta sesión todavía. Vuelve a conectarla para continuar.`,
      machineOfflineCannotResume:
        "La máquina está sin conexión. Vuelve a conectarla para reanudar esta sesión.",
          openRuns: "Abrir ejecuciones de la sesión",
          openAutomations: "Abrir automatizaciones de la sesión",
          openSubagents: ({ count }: { count: number }) => (count > 0 ? `Abrir agentes (${count})` : 'Abrir agentes'),
          participants: {
            to: 'A',
            lead: 'Principal',
            sendToTitle: 'Enviar a',
            broadcast: ({ teamId }: { teamId: string }) => `Difusión: ${teamId}`,
            executionRun: ({ runId }: { runId: string }) => `Ejecución ${runId}`,
            cardTo: ({ label }: { label: string }) => `A: ${label}`,
            unsupportedAttachmentsOrReviewComments: 'Enviar a un destinatario aún no admite adjuntos ni comentarios de revisión.',
          },
          subagents: {
            messages: {
              teamLabel: ({ teamId }: { teamId: string }) => `Team: ${teamId}`,
              memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
                `${memberLabel} · ${teamId}`,
              launch: {
                createTeamTitle: "Crear equipo",
                createMemberTitle: "Iniciar compañero",
              },
              command: {
                deleteTeamTitle: "Eliminar equipo",
                deleteMemberTitle: "Detener compañero",
              },
            },
                        panel: {
              title: "Agentes",
              active: "Activos",
              recent: "Recientes",
              emptyActive: "No hay agentes activos.",
              emptyRecent: "Todavía no hay agentes recientes.",
              openFull: "Abrir vista completa",
              openAdvancedRun: "Detalles de la ejecución",
              send: "Enviar mensaje",
              delete: "Eliminar",
              launchSectionTitle: "Iniciar",
              launchSectionSubtitle: "Inicia nuevos agentes y ejecuciones desde esta sesión.",
              sectionCount: ({ count }: { count: number }) => `${count}`,
              groupCount: ({ count }: { count: number }) => `${count} agentes`,
              launchExecutionRunsTitle: "Iniciar ejecuciones",
              launchExecutionRunsSubtitle: "Abre el lanzador de ejecuciones con preajustes de revisión, plan o delegación.",
              launchExecutionRunsAdvanced: "Avanzado…",
              launchClaudeTeamsTitle: "Iniciar equipos Claude",
              launchClaudeTeamsSubtitle: "Crea un equipo o lanza un compañero con comandos estructurados de equipos Claude.",
              teamIdLabel: "ID del equipo",
              teamIdPlaceholder: "id-del-equipo",
              teamDescriptionPlaceholder: "¿De qué se encarga este equipo?",
              launchClaudeTeamA11y: "Crear equipo Claude",
              launchClaudeTeamAction: "Crear equipo",
              teammateTeamIdLabel: "Equipo del compañero",
              teammateLabelPlaceholder: "Etiqueta del compañero",
              teammateInstructionsPlaceholder: "¿Qué debe hacer este compañero?",
              launchTeammateA11y: "Lanzar compañero",
              launchTeammateAction: "Lanzar compañero",
              typeFact: ({ value }: { value: string }) => `Tipo: ${value}`,
              providerFact: ({ value }: { value: string }) => `Proveedor: ${value}`,
              backendFact: ({ value }: { value: string }) => `Backend: ${value}`,
              intentFact: ({ value }: { value: string }) => `Intención: ${value}`,
              errors: {
                teamIdRequired: "Primero introduce un ID de equipo.",
                memberTeamIdRequired: "Primero introduce el ID del equipo del compañero.",
                memberLabelRequired: "Primero introduce una etiqueta para el compañero.",
                memberInstructionsRequired: "Primero introduce las instrucciones del compañero.",
              },
            },
            details: {
              unavailable: "Esta transcripción del agente ya no está disponible.",
            },
            kind: {
              execution_run: "Ejecución",
              agent_team_member: "Agente de equipo",
              subagent_sidechain: "Subagente",
            },
            intent: {
              review: "Revisión",
              plan: "Planificación",
              delegate: "Delegación",
            },
          },
          actionMenu: {
            openA11y: "Abrir acciones de la sesión",

            backgroundFollow: "Seguir en segundo plano",},
        detailsPanel: {
            emptyHint: "Abre un archivo o un diff desde el panel derecho.",
            unsupportedTab: "Pestaña de detalles no compatible.",
            closeA11y: "Cerrar detalles",
                openRightSidebarA11y: "Abrir barra lateral derecha",
                closeRightSidebarA11y: "Cerrar barra lateral derecha",
                openTabA11y: ({ title }: { title: string }) => `Abrir pestaña ${title}`,
                pinTabA11y: "Fijar pestaña",
                unpinTabA11y: "Desanclar pestaña",
                pinnedTabA11y: "Pestaña fijada",
                closeTabA11y: "Cerrar pestaña",
                enterFocusModeA11y: "Entrar en modo de enfoque del panel",
                exitFocusModeA11y: "Salir del modo de enfoque del panel",

            emptyTitle: "No hay pestañas abiertas",},

      actionsDraft: {
        noInputHints: "Esta acción no tiene sugerencias de entrada.",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `${field} es obligatorio.`,
        },
      },

    planOutput: {
      title: "Plan de trabajo",
      recommendedBackend: "Backend recomendado",
      risks: "Riesgos",
      milestones: "Hitos",
      adoptPlan: "Adoptar plan",
      sending: "Enviando…",
      failedToAdopt: "No se pudo adoptar el plan",
      a11y: {
        adoptPlan: "Adoptar plan",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `Hallazgos de revisión (${count})`,
      questionsTitle: "Preguntas del revisor",
      assumptionsTitle: "Suposiciones",
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
        untriaged: "Pendiente",
        accept: "Implementar corrección",
        reject: "Ignorar",
        defer: "Decidir más tarde",
        needsRefinement: "Pedir aclaración",
      },
      refinementPlaceholder: "¿Qué necesita aclaración?",
      actions: {
        applyTriage: "Aplicar acciones de revisión",
        applying: "Aplicando…",
        askReviewer: "Preguntar al revisor",
        answerQuestion: "Responder al revisor",
        applyAcceptedFindings: "Implementar correcciones seleccionadas",
        sendFollowUp: "Enviar seguimiento",
        sending: "Enviando…",
      },
      errors: {
        applyTriageFailed: "No se pudieron aplicar las acciones de revisión.",
        followUpFailed: "No se pudo enviar el seguimiento de la revisión.",
        applyAcceptedFailed: "No se pudieron enviar las correcciones seleccionadas.",
      },
    },

        pendingMessages: {
          title: "Mensajes pendientes",
          indicator: ({ count }: { count: number }) => `Pendiente (${count})`,
          badgeLabel: ({ count }: { count: number }) => (count > 0 ? `Pendiente (+${count})` : "Pendiente"),
          deliveryStatus: {
            blocked: 'Bloqueado',
            delivering: 'Entregando',
            queuedInClaude: 'En cola en Claude',
          },
          queuedReasons: {
            waitingForForegroundTurn: 'Esperando a que termine el turno actual',
            waitingForRuntimeActivity: 'Esperando a que termine la actividad en ejecución',
            runtimeActivityUnknown: 'Esperando el estado de la actividad en ejecución',
            waitingForPredecessor: 'Esperando un mensaje anterior',
            waitingForRuntime: 'Esperando el entorno de ejecución de la sesión',
            unsupportedAction: 'La acción de entrega necesita revisión',
          },
          deliveryBlockedReasons: {
            terminalComposerDraft: 'El borrador del terminal bloquea la entrega',
            captureStyleUnavailable: 'La captura del terminal no puede verificar el compositor',
            providerUnavailableBeforeAcceptance: 'El proveedor no está disponible temporalmente',
            ambiguousTerminalDelivery: 'El estado de entrega es ambiguo',
            terminalHostUnreachable: 'No se puede acceder al host del terminal',
            runtimeDisposedBeforeDelivery: 'El runtime se cerró antes de la entrega',
            runtimeConfigBlocked: 'La configuración del runtime bloquea la entrega',
            invalidPromptText: 'El texto del mensaje no se puede entregar',
            manualUserHandled: 'Marcado como gestionado',
            attemptExpiredBeforeWrite: 'El intento de entrega caducó antes de escribir',
            providerRejectedBeforeAcceptance: 'El proveedor rechazó el mensaje',
            payloadTooLarge: 'El mensaje es demasiado grande',
            unknown: 'El estado de entrega requiere revisión',
          },
          empty: "No hay mensajes pendientes.",
          decryptFailed: "No se pudo descifrar este mensaje pendiente.",
          nonSteerableNotice: "El turno actual no puede aceptar inserciones después de este cambio de modo. Se ejecutará después, o usa Enviar ahora para interrumpir.",
          steerBlockedTerminalDraftNotice: 'En espera: un borrador en el compositor del terminal bloquea la entrega. Bórralo en el terminal o interrumpe el turno.',
          clearComposer: {
            action: 'Borrar compositor',
            clearing: 'Borrando…',
            confirmTitle: '¿Borrar el compositor del terminal?',
            confirmBody: 'Esto descartará el texto sin enviar que está actualmente en el compositor del terminal.',
            errors: {
              failed: 'No se pudo borrar el compositor del terminal.',
              unsupported: 'Esta sesión no admite borrar el compositor del terminal desde Happier.',
              noLiveTerminal: 'No hay ningún terminal activo disponible para esta sesión.',
              generating: 'Claude está generando ahora mismo, así que no se puede borrar el compositor con seguridad.',
              notSafe: 'El terminal muestra un diálogo u otro estado no seguro. Bórralo en el terminal.',
              captureUnavailable: 'Happier no pudo leer el estado del terminal.',
            },
          },
          actions: {
            up: "Arriba",
            down: "Abajo",
          edit: "Editar",
            viewMore: "Ver más",
            viewLess: "Ver menos",
          steerNow: "Insertar ahora",
          sendNow: "Enviar ahora",
          sendToAgentNow: "Enviar al agente ahora",
          sendNowInterrupt: "Enviar ahora (interrumpir)",
          retryDelivery: "Reintentar",
          interruptAndRunNow: "Interrumpir y ejecutar ahora",
          markHandled: "Marcar como gestionado",
          requeue: "Reencolar",
        },
        editPrompt: {
          title: "Editar mensaje pendiente",
        },
        removeConfirm: {
          title: "¿Eliminar mensaje pendiente?",
          body: "Esto eliminará el mensaje pendiente.",
        },
        discardConfirm: {
          title: "¿Descartar entrega pendiente?",
          body: "Esto mantendrá el mensaje en la transcripción como descartado sin enviarlo al agente.",
        },
        steerConfirm: {
          title: "¿Insertar ahora?",
          body: "Esto añadirá este mensaje al turno actual sin detenerlo.",
        },
        sendConfirm: {
          title: "¿Enviar ahora?",
          interruptTitle: "¿Enviar ahora (interrumpir)?",
          backgroundTitle: "¿Enviar al agente ahora?",
          body: "Esto detendrá el turno actual y enviará este mensaje inmediatamente.",
          backgroundBody: "El agente recibirá este mensaje ahora. El trabajo en segundo plano continuará.",
          resumeBody: "Esto reanudará la sesión y enviará este mensaje inmediatamente.",
        },
        markHandledConfirm: {
          title: "¿Marcar mensaje pendiente como gestionado?",
          body: "Esto borrará el estado de entrega bloqueada sin enviar el mensaje.",
        },
        discarded: {
          title: "Mensajes descartados",
          subtitle:
            "Estos mensajes no se enviaron al agente (por ejemplo, al cambiar de remoto a local).",
          label: "Descartado",
          removeConfirm: {
            title: "¿Eliminar mensaje descartado?",
            body: "Esto eliminará el mensaje descartado.",
          },
        },
        errors: {
          updateFailed: "No se pudo actualizar el mensaje pendiente",
          deleteFailed: "No se pudo eliminar el mensaje pendiente",
          sendFailed: "No se pudo enviar el mensaje pendiente",
          restoreFailed: "No se pudo restaurar el mensaje descartado",
          deleteDiscardedFailed: "No se pudo eliminar el mensaje descartado",
          sendDiscardedFailed: "No se pudo enviar el mensaje descartado",
          reorderFailed: "No se pudo reordenar los mensajes pendientes",
          retryDeliveryFailed: "No se pudo reintentar la entrega pendiente",
          actionConflict: "Este mensaje pendiente cambió mientras se aplicaba la acción. Revisa su estado actual y vuelve a intentarlo.",
          discardFailed: "No se pudo descartar la entrega pendiente",
          markHandledFailed: "No se pudo marcar la entrega pendiente como gestionada",
        },
      },

      transcript: {

          olderLoadFailedTitle: 'No se pudieron cargar los mensajes anteriores',

          olderLoadFailedBody: 'El resto de esta conversación sigue ahí. Vuelve a intentar cargar los mensajes anteriores.',

      },


      sharing: {
        title: "Compartir",
        directSharing: "Compartir directamente",
        addShare: "Compartir con un amigo",
      accessLevel: "Nivel de acceso",
      shareWith: "Compartir con",
      sharedWith: "Compartido con",
      noShares: "No compartido",
      viewOnly: "Solo ver",
      viewOnlyDescription: "Puede ver la sesión, pero no enviar mensajes.",
      viewOnlyMode: "Solo ver (sesión compartida)",
      noEditPermission: "Tienes acceso de solo lectura a esta sesión.",
      canEdit: "Puede editar",
      canEditDescription: "Puede enviar mensajes.",
      canManage: "Puede administrar",
      canManageDescription:
        "Puede administrar la configuración de uso compartido.",
      manageSharingDenied:
        "No tienes permiso para administrar la configuración de uso compartido de esta sesión.",
      stopSharing: "Dejar de compartir",
      stopSharingDescription: "Revoca el acceso directo de esta persona.",
      recipientMissingKeys:
        "Este usuario aún no ha registrado claves de cifrado.",
      permissionApprovals: "Puede aprobar permisos",
      allowPermissionApprovals: "Permitir aprobar permisos",
      allowPermissionApprovalsDescription:
        "Permite que este usuario apruebe solicitudes de permiso y ejecute herramientas en tu máquina.",
      permissionApprovalsDisabledTitle:
        "La aprobación de permisos está deshabilitada",
      permissionApprovalsDisabledPublic:
        "Los enlaces públicos son de solo lectura. No se pueden aprobar permisos.",
      permissionApprovalsDisabledReadOnly:
        "Tienes acceso de solo lectura a esta sesión.",
      permissionApprovalsDisabledInactive:
        "Esta sesión está inactiva. No se pueden aprobar permisos.",
      permissionApprovalsDisabledNotGranted:
        "El propietario no te permitió aprobar permisos para esta sesión.",
      publicReadOnlyTitle: "Enlace público (solo lectura)",
      publicReadOnlyBody:
        "Esta sesión se comparte mediante un enlace público. Puedes ver mensajes y resultados de herramientas, pero no puedes interactuar ni aprobar permisos.",

      publicLink: "Enlace público",
      publicLinkActive: "El enlace público está activo",
      publicLinkDescription:
        "Cualquiera con este enlace puede ver la sesión de forma anónima. Elimínalo o regénéralo para revocar el acceso de todos.",
      createPublicLink: "Crear enlace público",
      regeneratePublicLink: "Regenerar enlace público",
      deletePublicLink: "Eliminar enlace público",
      linkToken: "Token del enlace",
      tokenNotRecoverable: "Token no disponible",
      tokenNotRecoverableDescription:
        "Por seguridad, los tokens de enlace público se almacenan con hash y no se pueden recuperar. Regenera el enlace para crear un nuevo token.",

      expiresIn: "Expira en",
      expiresOn: "Expira el",
      days7: "7 días",
      days30: "30 días",
      never: "Nunca",

      maxUsesLabel: "Usos máximos",
      unlimited: "Ilimitado",
      uses10: "10 usos",
      uses50: "50 usos",
      usageCount: "Número de usos",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} usos`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} usos`,

      requireConsent: "Requerir consentimiento",
      requireConsentDescription:
        "Pide consentimiento antes de registrar el acceso.",
      consentRequired: "Se requiere consentimiento",
      consentDescription:
        "Este enlace requiere tu consentimiento para registrar tu IP y agente de usuario.",
      acceptAndView: "Aceptar y ver",
      sharedBy: ({ name }: { name: string }) => `Compartido por ${name}`,

      shareNotFound: "El enlace compartido no existe o ha caducado",
      failedToDecrypt: "No se pudo descifrar la sesión",
      noMessages: "Aún no hay mensajes",
      session: "Sesión",
    },
  },

  commandPalette: {
    placeholder: "Escriba un comando o busque...",
    noCommandsFound: "No se encontraron comandos",
        shortcutsHelpTitle: 'Atajos de teclado',
        shortcutsHelpBody: ({ shortcuts }: { shortcuts: string }) => `Atajos activos:\n${shortcuts}`,
        shortcutsHelpEmpty: 'No hay atajos activos en este dispositivo.',
        shortcutsHelpCommandPalette: 'Abrir paleta de comandos',
        shortcutsHelpHelp: 'Abrir atajos de teclado',
        shortcutsHelpNewSession: 'Nueva sesión',
        commands: {
            sessionsCategory: 'Sesiones',
            navigationCategory: 'Navegación',
            recentSessionsCategory: 'Sesiones recientes',
            runsCategory: 'Corre',
            voiceCategory: 'Voz',
            systemCategory: 'Sistema',
            developerCategory: 'Desarrollador',
            newSessionTitle: 'Nueva sesión',
            newSessionSubtitle: 'Iniciar una nueva sesión de chat',
            viewAllSessionsTitle: 'Ver todas las sesiones',
            viewAllSessionsSubtitle: 'Explora tu historial de chat',
            settingsTitle: 'Configuración',
            settingsSubtitle: 'Configura tus preferencias',
            accountTitle: 'cuenta',
            accountSubtitle: 'Administra tu cuenta',
            connectTerminalTitle: 'Escanee QR para conectar el terminal',
            connectTerminalSubtitle: 'Aprueba la conexión que se muestra en tu terminal',
            memorySearchTitle: 'Memoria de búsqueda',
            memorySearchSubtitle: 'Buscar en conversaciones pasadas',
            sessionFallbackTitle: ({ id }: { id: string }) => `Session ${id}`,
            sessionFallbackSubtitle: 'Cambiar a sesión',
            sessionRequiredTitle: 'Sesión requerida',
            sessionRequiredBody: 'Primero abra una sesión para que este comando pueda apuntar a ella.',
            startReviewRunTitle: 'Iniciar ejecución de revisión',
            startPlanRunTitle: 'Iniciar ejecución del plan',
            startDelegationRunTitle: 'Iniciar ejecución de delegación',
            executionRunsSubtitle: 'Ejecuciones de ejecución',
            openSessionRunsTitle: 'Se ejecuta sesión abierta',
            runsForCurrentSessionSubtitle: 'Se ejecuta para la sesión actual',
            runsAcrossMachinesSubtitle: 'Corre a través de máquinas',
            resetVoiceAgentTitle: 'Restablecer agente de voz',
            voiceSubtitle: 'Voz',
            signOutTitle: 'Cerrar sesión',
            signOutSubtitle: 'Cerrar sesión en su cuenta',
            developerMenuTitle: 'Menú de desarrollador',
            developerMenuSubtitle: 'Acceder a herramientas de desarrollador',
        },
    pets: {
      category: "Mascotas",
      wakeTitle: "Despertar mascota",
      wakeSubtitle: "Muestra la compañera en esta superficie.",
      tuckTitle: "Guardar mascota",
      tuckSubtitle: "Oculta la compañera en esta superficie.",
      resetPositionTitle: "Restablecer posición de la mascota",
      resetPositionSubtitle: "Devuelve la compañera a su lugar predeterminado.",
      chooseTitle: "Elegir mascota",
      chooseSubtitle: "Abre la configuración de mascotas.",
      refreshCodexTitle: "Actualizar mascotas de Codex",
      refreshCodexSubtitle: "Abre la configuración y detecta mascotas locales de Codex.",
    },
  },

  commandView: {
    completedWithNoOutput: "[Comando completado sin salida]",
  },

  delegation: {
    output: {
      title: "Delegación",
      deliverablesTitle: "Entregables",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "Actualizar modelos",
    loadingModelsA11y: "Cargando modelos…",
    refreshingModelsA11y: "Actualizando modelos…",
    searchPlaceholder: "Buscar modelos…",
    customTitle: "Personalizado…",
    customInputA11y: "Identificador de modelo personalizado",
    optionControlA11y: ({ name }: { name: string }) => `Opción de modelo: ${name}`,
    effectiveLabel: ({ label }: { label: string }) => `Efectivo: ${label}`,
  },

  voiceAssistant: {
    connecting: "Conectando...",
    active: "Asistente de voz activo",
    connectionError: "Error de conexión",
    label: "Asistente de voz",
    tapToEnd: "Toca para finalizar",
    startDictation: "Iniciar dictado",
    startVoice: "Iniciar Voz",
    startGlobalVoice: "Iniciar Voz Global",
    endVoice: "Finalizar Voz",
    transcribing: "Transcribiendo…",
    endDictation: "Finalizar dictado",
  },

  voiceSurface: {
    reviewCredentials: 'Revisar credenciales',
    connectAgent: 'Conectar',
    installAgentRuntime: 'Instalar',
    updateAgentRuntime: 'Actualizar',
    start: "Iniciar",
    stop: "Detener",
    selectSessionToStart: "Selecciona una sesión para iniciar la voz",
    targetSession: "Sesión objetivo",
    conversationalTranscriptUnavailable: "La transcripción de la conversación no está disponible para esta sesión de voz",
    orbLabel: "Voz",
    orbStartHint: "Inicia una conversacion hablada. Desliza hacia arriba para abrir la conversacion.",
    orbEndHint: "Finaliza la conversacion hablada. El trabajo de codigo ya iniciado sigue en marcha. Desliza hacia arriba para abrir la conversacion.",
    orbMinimiseHint: "Minimiza la voz",
    orbExpand: "Expandir voz",
    orbCollapse: "Contraer voz",
    delegatedWorking: "Trabajando…",
    composerStartHint: "Inicia una conversación hablada sobre esta sesión.",
    composerGlobalStartHint: "Inicia una conversación hablada que no está vinculada a ninguna sesión.",
    composerEndHint: "Termina la conversación hablada. El trabajo de código ya iniciado continúa.",
    noTarget: "Ninguna sesión seleccionada",
    clearTarget: "Limpiar objetivo",
    a11y: {
      teleport: "Teletransportar agente de voz",
      toggleActivity: "Mostrar/ocultar actividad de voz",
      clearActivity: "Borrar actividad de voz",
      bargeIn: "Interrumpir",
      cancelTurn: "Cancelar respuesta",
      openConversation: "Abrir conversación de voz",
      microphoneActive: "Micrófono activo",
      microphoneInactive: "Micrófono inactivo",
      microphoneMuted: "Micrófono silenciado",
      providerDataDisclosure: ({ provider }: { provider: string }) => `Cómo gestiona ${provider} los datos de voz`,

      mute: "Silenciar micrófono",
      unmute: "Activar micrófono",},
  },

  voiceActivity: {
    title: "Actividad de voz",
    empty: "Aún no hay actividad de voz.",
    clear: "Limpiar",
    format: {
      voiceAgent: "Agente de voz",
      you: "Tú",
      assistant: "Asistente",
      assistantStreaming: "Asistente…",
      action: "Acción",
      error: "Fallo",
      status: "Estado",
      started: "Iniciado",
      stopped: "Detenido",
      errorFallback: "fallo",
      eventFallback: "evento",
    },
  },

  devVoiceQa: {
    menuTitle: "Banco de pruebas QA de voz",
    menuSubtitle: "Controla el agente de voz real con prompts de texto",
    title: "Banco de pruebas QA de voz",
    subtitle: "Inicia el runtime de voz configurado y envía prompts sin usar el micrófono.",
    instructions: "Usa esta pantalla para probar el agente de voz local real o una sesión de ElevenLabs con prompts de texto deterministas. Deja vacío el ID de sesión para usar el objetivo de voz actual o la sesión global del agente de voz.",
    configurationTitle: "Configuración",
    configuredProvider: "Proveedor configurado",
    qaProvider: "Proveedor QA activo",
    qaStatus: "Estado de QA",
    targetSession: "Sesión de destino actual",
    runtimeSession: "Sesión activa del runtime",
    inputsTitle: "Entradas",
    sessionIdLabel: "Anulación del ID de sesión",
    sessionIdPlaceholder: "Déjalo vacío para usar el objetivo de voz actual",
    initialContextLabel: "Contexto inicial",
    initialContextPlaceholder: "Contexto opcional enviado cuando se inicia la sesión de QA",
    promptLabel: "Instrucción",
    promptPlaceholder: "Escribe el texto que quieras enviar al agente de voz",
    contextUpdateLabel: "Actualización de contexto",
    contextUpdatePlaceholder: "Actualización de contexto opcional de seguimiento",
    actionsTitle: "Acciones",
    sendContext: "Enviar contexto",
    usesCurrentProvider: "Este banco de pruebas siempre usa tu configuración de voz actual y las integraciones reales del runtime.",
    localModeHint: "El QA local requiere Local voice con el modo de conversación configurado como Agent.",
    elevenLabsHint: "El QA de ElevenLabs requiere que tu proveedor de ElevenLabs esté configurado y que la sesión en tiempo real se conecte correctamente.",
    transcriptTitle: "Transcripción QA",
    transcriptEmpty: "Aún no hay transcripción QA.",
    activityTitle: "Actividad de voz",
    activityEmpty: "Aún no se ha capturado actividad de voz para la sesión QA activa.",

    recordedAudio: {
      title: "QA de STT con audio grabado",
      uriLabel: "URI del audio grabado",
      uriPlaceholder: "file:///recording.wav o elige un archivo web",
      daemonPackIdLabel: "Anulación del ID del paquete STT del daemon",
      daemonPackIdPlaceholder: "Opcional: aplica la configuración QA de STT daemon local_neural antes de transcribir",
      daemonMachineIdLabel: "Anulación del ID de máquina del daemon",
      daemonMachineIdPlaceholder: "Opcional: prepara un objetivo de máquina para el ID de sesión de audio grabado",
      daemonBasePathLabel: "Anulación de la ruta base del daemon",
      daemonBasePathPlaceholder: "Opcional: prepara la ruta base de la máquina para el STT del daemon",
      chooseFile: "Elegir audio grabado",
      noFileSelected: "No se seleccionó audio grabado",
      transcribe: "Transcribir audio grabado",
      statusLabel: "Estado",
      noResult: "Sin resultado de transcripción",
    },},

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Configuración del Relay",
    enterServerUrl: "Ingresa una URL de Relay",
    notValidHappyServer: "No es un Relay Happier válido",
    changeServer: "Cambiar Relay",
    continueWithServer: "¿Continuar con este Relay?",
    resetToDefault: "Restablecer por defecto",
    resetServerDefault: "¿Restablecer Relay por defecto?",
    validating: "Validando...",
    validatingServer: "Validando Relay...",
    serverReturnedError: "El Relay devolvió un error",
    failedToConnectToServer: "Falló al conectar con el Relay",
    currentlyUsingCustomServer: "Actualmente usando Relay personalizado",
    customServerUrlLabel: "URL del Relay personalizado",
    advancedFeatureFooter:
      "Esta es una característica avanzada. Solo cambia el Relay si sabes lo que haces. Necesitarás cerrar sesión e iniciarla nuevamente después de cambiar de Relays.",
    useThisServer: "Usar este Relay",
    autoConfigHint:
      "Si alojas tu propio Relay: configúralo primero, luego inicia sesión (o crea una cuenta) y, por último, conecta tu terminal.",
    renameServer: "Renombrar Relay",
    renameServerPrompt: "Introduce un nuevo nombre para este Relay.",
    renameServerGroup: "Renombrar grupo de Relays",
    renameServerGroupPrompt:
      "Introduce un nuevo nombre para este grupo de Relays.",
    serverNamePlaceholder: "Nombre del Relay",
    cannotRenameCloud: "No puedes renombrar el Relay en la nube.",
    removeServer: "Eliminar Relay",
    removeServerConfirm: ({ name }: { name: string }) =>
      `¿Eliminar "${name}" de los Relays guardados?`,
    removeServerGroup: "Eliminar grupo de Relays",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `¿Eliminar "${name}" de los grupos de Relays guardados?`,
    cannotRemoveCloud: "No puedes eliminar el Relay en la nube.",
    signOutThisServer: "¿Cerrar sesión también en este Relay?",
    signOutThisServerPrompt:
      "Se encontraron credenciales guardadas para este Relay en este dispositivo.",
    savedServersTitle: "Relays guardados",
    signedIn: "Con sesión iniciada",
    signedOut: "Sesión cerrada",
    authStatusUnknown: "Estado de autenticación desconocido",
    switchToServer: "Cambiar a este Relay",
    active: "Activo",
    default: "Predeterminado",
    addServerTitle: "Añadir Relay",
    switchForThisTab: "Cambiar para esta pestaña",
    makeDefaultOnDevice: "Hacer predeterminado en este dispositivo",
    serverNameLabel: "Nombre del Relay",
    addAndUse: "Añadir y usar",
      addTargetsTitle: "Añadir",
      addServerSubtitle: "Añade un Relay nuevo y cámbiate a él",
      notificationAddServerHint: "Este Relay aún no está guardado en este dispositivo. Añádelo abajo para continuar.",
      serverCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "Relay", plural: "Relays" })}`,
      useCanonicalServerUrlTitle: "¿Usar la URL canónica del Relay?",
    useCanonicalServerUrlBody:
      "Este Relay anuncia una URL canónica que debería funcionar desde otros dispositivos. ¿Quieres usarla en lugar de la que ingresaste?",
    insecureHttpUrlTitle: "URL del Relay insegura",
    insecureHttpUrlBody:
      "Esta URL usa http:// y puede que no funcione desde tu teléfono o fuera de tu LAN. Usa HTTPS si es posible. ¿Continuar de todos modos?",
    signedOutSwitchConfirmTitle: "No estás conectado",
    signedOutSwitchConfirmBody:
      "¿Cambiar a este Relay y continuar a la pantalla de inicio para que puedas iniciar sesión o crear una cuenta?",
    addServerGroupTitle: "Añadir grupo de Relays",
    addServerGroupSubtitle: "Crea un grupo reutilizable de Relays",
    serverGroupNameLabel: "Nombre del grupo",
    serverGroupNamePlaceholder: "Mi grupo de Relays",
    serverGroupServersLabel: "Relés",
    saveServerGroup: "Guardar grupo",
    serverGroupMustHaveServer:
      "Un grupo de Relays debe incluir al menos un Relay.",
    relayDrift: {
        bannerDifferentRelayTitle: 'El servicio en segundo plano está conectado a otro Relay',
        bannerDifferentRelayDescription: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `Aplicación: ${activeRelayUrl} · Servicio en segundo plano: ${daemonRelayUrl}`,
        bannerNeedsAuthTitle: 'El servicio en segundo plano debe iniciar sesión en este Relay',
        bannerNeedsAuthDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `La aplicación usa ${activeRelayUrl}, pero el servicio en segundo plano todavía necesita aprobación o inicio de sesión.`,
        bannerNotConfiguredTitle: 'El servicio en segundo plano aún no está conectado a este Relay',
        bannerNotConfiguredDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `La aplicación usa ${activeRelayUrl}, pero este ordenador todavía no ha terminado de conectar el servicio en segundo plano.`,
        bannerNotInstalledTitle: 'El servicio en segundo plano no está instalado para este Relay',
        bannerNotInstalledDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `La aplicación usa ${activeRelayUrl}, pero este ordenador todavía necesita instalar el servicio en segundo plano para él.`,
        bannerNotRunningTitle: 'El servicio en segundo plano está instalado pero no se está ejecutando',
        bannerNotRunningDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `La aplicación usa ${activeRelayUrl}, pero el servicio en segundo plano está detenido y debe iniciarse de nuevo.`,
        repairAction: 'Conectar el servicio en segundo plano a este Relay',
        progressTitle: 'Conectando el servicio en segundo plano a este Relay',
        progressStepPrepare: 'Preparar el servicio en segundo plano',
        progressStepConfigureRelay: 'Actualizar la conexión al Relay',
        progressStepAuthenticate: 'Finalizar el inicio de sesión y la aprobación',
        progressStepFinish: 'Completar la reparación',
        statusUnknown: 'Desconocido',
    },
    retention: {
      title: "Politica de retencion",
      summary: "Resumen",
      keepForever: "Sin eliminacion automatica",
      automaticDeletionEnabled: "La eliminación automática está activada",
      detailsUnavailable: "La eliminación automática está activada, pero este cliente no puede mostrar todas las políticas activas",
      singlePolicySummary: ({ domain, policy }: { domain: string; policy: string }) => `${domain}: ${policy}`,
      relayCleanupSummary: ({ policies }: { policies: string }) => `Este relay limpia ${policies}.`,
      relayCleanupAfterDays: ({ domain, count }: { domain: string; count: number }) => `${domain} después de ${count} ${plural({ count, singular: 'día', plural: 'días' })}`,
      relayCleanupInactiveSessionsAfterDays: ({ count }: { count: number }) => `sesiones inactivas después de ${count} ${plural({ count, singular: 'día', plural: 'días' })}`,
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Elimina sesiones inactivas despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Elimina datos despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      sessionNotice: ({ count }: { count: number }) => `Este servidor elimina sesiones inactivas despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })} de inactividad.`,
      sessions: "Sesiones",
      sidechainMessages: "Transcripciones de subagentes",
      usageEvents: "Eventos de uso",
      accountChanges: "Cambios de la cuenta",
      voiceSessionLeases: "Arrendamientos de sesiones de voz",
      feedItems: "Elementos del feed",
      sessionShareAccessLogs: "Registros de acceso a sesiones compartidas",
      publicShareAccessLogs: "Registros de acceso a enlaces publicos",
      terminalAuthRequests: "Solicitudes de autenticacion del terminal",
      accountAuthRequests: "Solicitudes de autenticacion de la cuenta",
      authPairingSessions: "Sesiones de emparejamiento de autenticacion",
      repeatKeys: "Claves de repeticion",
      globalLocks: "Bloqueos globales",
      automationRuns: "Ejecuciones de automatizacion",
      automationRunEvents: "Eventos de ejecucion de automatizacion",
    },
    multiServerView: {
      title: "Vista concurrente de múltiples Relays",
      footer:
        "Elige si quieres combinar varios Relays en una sola lista de sesiones.",
      enableTitle: "Habilitar vista concurrente",
      enableSubtitle:
        "Mostrar juntas las sesiones de los Relays seleccionados",
      presentationTitle: "Modo de presentación",
      presentation: {
        flatWithBadges: "Lista plana con insignias de Relay",
        groupedByServer: "Agrupado por Relay",
      },
    },

    reachabilityRemediation: {
      failedToOpenInstallLink: "No se pudo abrir la página de instalación de Tailscale.",
      tailscale: {
        title: "Este relay usa Tailscale",
        desktopBody: "Este ordenador no pudo alcanzar el relay por Tailscale. Puede que Tailscale no esté instalado, que no hayas iniciado sesión o que no esté conectado a la tailnet correcta en este ordenador.",
        webBody: "Este navegador no pudo alcanzar el relay por Tailscale. Abre Tailscale en este dispositivo, asegúrate de que esté conectado a la tailnet correcta y vuelve a intentarlo.",
        nativeBody: "Este dispositivo no pudo alcanzar el relay por Tailscale. Abre Tailscale, asegúrate de que esté conectado a la tailnet correcta y vuelve a intentarlo.",
        installAction: "Instalar Tailscale",
        desktopPrepareAction: "Preparar Tailscale",
      },
    },},

  sessionTags: {
    searchOrAddPlaceholder: "Buscar o añadir etiquetas",
    editTagsLabel: "Editar etiquetas",
    noTagsFound: "No se encontraron etiquetas",
    newTagItem: "Nueva etiqueta…",
    newTagTitle: "Nueva etiqueta",
    newTagMessage: "Introduce un nombre para la nueva etiqueta.",
    newTagConfirm: "Añadir",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Servidor: ${server}`,
    storagePersistedTab: "Happier",
    storageAllFilter: "Todas",
    storageFilterCategory: "Sesiones",
    storageExternalFilter: "Externas",
    storageDirectTab: "Directas",
    renameWorkspace: 'Renombrar espacio de trabajo',
    renameWorkspacePromptTitle: 'Renombrar espacio de trabajo',
    renameWorkspacePromptPlaceholder: 'Introduce un nombre...',
    resetWorkspaceName: 'Restablecer nombre',
    viewOptions: 'Opciones de vista',
    searchSessions: 'Buscar sesiones',
    searchSessionsPlaceholder: 'Buscar sesiones...',
    filterByTags: 'Filtrar por etiquetas',
    folders: 'Carpetas',
    addFolder: 'Añadir carpeta',
    addFolderPromptTitle: 'Añadir carpeta',
    addSubfolder: 'Añadir subcarpeta',
    addSubfolderPromptTitle: 'Añadir subcarpeta',
    folderNamePlaceholder: 'Nombre de carpeta',
    renameFolder: 'Renombrar carpeta',
    renameFolderPromptTitle: 'Renombrar carpeta',
    moveFolder: 'Mover carpeta',
    deleteFolder: 'Eliminar carpeta',
    deleteFolderPromptTitle: 'Eliminar carpeta',
    deleteFolderPromptDescription: 'Las sesiones de esta carpeta permanecerán en el espacio de trabajo.',
    newSessionInFolder: 'Nueva sesión en carpeta',
    clearFolderFocus: 'Borrar foco de carpeta',
    folderViewTree: 'Vista de carpetas',
    folderViewOff: 'Ocultar carpetas',
    moveToFolder: 'Mover a carpeta',
    moveToWorkspaceRoot: 'Raíz del espacio de trabajo',
    sessionFallbackLabel: 'Sesión',
    moveSheetTitle: ({ item }: { item: string }) => 'Move ' + item,
    moveSheetDestinationLabel: 'Destino',
    moveSheetSubmit: 'Mover',
    moveSheetSearchPlaceholder: 'Search folders...',
    moveSheetEmpty: 'No hay objetivos de movimiento disponibles',
    moveSheetDestinations: 'Destinos',
    moveSheetDisabledDescendant: 'No se puede mover a sí mismo ni a una carpeta secundaria.',
    moveSheetDisabledMaxDepth: 'Esto excedería el límite de profundidad de la carpeta.',
    moveSheetDisabledCurrent: 'Ya en este lugar.',
    moveSheetDisabledUnavailable: 'Este destino no está disponible.',
    dragHandleA11yLabel: 'Mango de arrastre',
    dragA11yPickedUp: ({ item }: { item: string }) => 'Picked up ' + item + '.',
    dragA11yDroppedReorder: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' near ' + destination + '.',
    dragA11yDroppedNest: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' into ' + destination + '.',
    dragA11yDroppedRoot: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' to ' + destination + '.',
    dragA11yCancelled: ({ item }: { item: string }) => 'Move cancelled for ' + item + '.',
    dragA11yBlocked: ({ item, reason }: { item: string; reason: string }) => 'Could not move ' + item + ': ' + reason,
    dragA11yBlockedDescendantCycle: 'el destino está dentro de la carpeta movida',
    dragA11yBlockedLeafCannotBeParent: 'Las sesiones no pueden contener otros elementos.',
    dragA11yBlockedMaxDepth: 'límite de profundidad de carpeta alcanzado',
    dragA11yBlockedSamePosition: 'Ya en esa posición',
    dragA11yBlockedWorkspaceScope: 'el destino está en otro espacio de trabajo',
    dragA11yBlockedNoTarget: 'ningún destino seleccionado',
    dragA11yBlockedDirectSession: 'Las sesiones directas no se pueden mover a carpetas.',
    dragA11yBlockedFeatureDisabled: 'las carpetas de sesión no están habilitadas',
    dragA11yBlockedUnsupportedItem: 'este elemento no se puede mover a carpetas',
    hideInactiveSessions: 'Ocultar sesiones inactivas',
    showInactiveSessions: 'Mostrar sesiones inactivas',
    attentionSectionTitle: 'Requiere atención',
    workingSectionTitle: 'Trabajando',
        backgroundWorkingSectionTitle: 'Trabajando en segundo plano',
    selectionSelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionA11ySelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionCheckboxA11yLabel: 'Seleccionar sesión',
    selectionSelectAction: 'Seleccionar',
    selectionSelectAllVisible: 'Seleccionar todo',
    selectionSelectAllVisibleA11yLabel: 'Seleccionar todas las sesiones visibles',
    selectionMoveSheetSourceLabel: ({ count }: { count: number }) => count === 1 ? '1 selected session' : `${count} selected sessions`,
    selectionAddTags: 'Añadir etiquetas',
    selectionRemoveTags: 'Quitar etiquetas',
    selectionSetTags: 'Establecer etiquetas',
    selectionAddTagsPromptTitle: 'Añadir etiquetas',
    selectionRemoveTagsPromptTitle: 'Quitar etiquetas',
    selectionSetTagsPromptTitle: 'Establecer etiquetas',
    selectionTagsPromptMessage: 'Separa las etiquetas con comas.',
    selectionTagsPlaceholder: 'etiqueta-uno, etiqueta-dos',
    selectionCancelA11yLabel: 'Cancelar selección de sesiones',
    selectionProgress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total} complete`,
    selectionCancelRunningA11yLabel: 'Cancelar acción de sesiones seleccionadas',
    selectionResult: ({ succeeded, failed, skipped }: { succeeded: number; failed: number; skipped: number }) => `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    selectionDismissResultA11yLabel: 'Descartar resultado de la acción de sesiones seleccionadas',
    selectionConfirm: ({ action, count }: { action: string; count: number }) => `${action} ${count} selected ${count === 1 ? 'session' : 'sessions'}?`,
    selectionConfirmA11yLabel: ({ action }: { action: string }) => `Confirm ${action}`,

    emptyState: {
      title: "Aún no hay sesiones",
      description: "Inicia una sesión en una de tus máquinas en línea.",
      descriptionPrefix: "Inicia una sesión en una de tus máquinas usando ",
      descriptionSuffix: " en tu terminal, o usando los botones de abajo.",
      actionsTitle: "Iniciar una sesión",
      startSessionOnMachine: ({ machine }: { machine: string }) => `Iniciar una sesión en ${machine}`,
      startSessionOnMachineSubtitle: "Elige una carpeta y abre una nueva sesión en esta máquina.",
      reconnectMachineActionSubtitle: "Vuelve a conectar el servicio en segundo plano para que esta máquina pueda iniciar sesiones de nuevo.",
      startDaemonActionSubtitle: "Instala o reinicia el servicio en segundo plano necesario para iniciar sesiones.",
    },
    openProject: 'Abrir proyecto',
    workspaceRoot: "Raíz del espacio de trabajo",
    failedToMoveSessionToFolder: "No se pudo mover la sesión a la carpeta.",
    newFolderDefaultName: "Carpeta nueva",},

  directSessions: {
    browseTitle: "Explorar sesiones externas",
    browseOpenExisting: "Explorar sesiones externas",
    browseActionSubtitle: "Elige una máquina, un agente y una sesión para abrirla aquí.",
    browseFiltersTitle: "Seleccionar origen",
    browseMachines: "Máquinas",
    browseAgents: "Agentes",
    browseSources: "Fuentes",
    browseSourceCodexUserHome: "Mi directorio Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Servicios conectados de ${service}`,
    browseSourceClaudeDefault: "Configuración predeterminada de Claude",
    browseSourceOpenCodeDefault: "Servidor predeterminado de OpenCode",
    browseCandidates: "Sesiones disponibles",
    browseNoMachines: "Aún no hay máquinas disponibles para sesiones directas.",
    browseNoCandidates: "No se encontraron sesiones externas para esta máquina y este agente.",
    browseActivityRunning: "En ejecución",
        browseActivityRunningNow: "En ejecución",
    browseActivityRecent: "Reciente",
    browseActivityIdle: "Inactiva",
    browseActivityUnknown: "Desconocida",
        browseSearchPlaceholder: "Buscar sesiones…",
        browseNoSearchResults: "Ninguna sesión coincide todavía con esta búsqueda.",
    browseLoadMore: "Cargar más sesiones",
    browseFailedToLoad: "No se pudieron cargar las sesiones externas.",
    browseLinkFailed: "No se pudo vincular la sesión externa seleccionada.",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: 'Copia de trabajo principal',
            git_worktree: 'árbol de trabajo de Git',
        },
    },
    sourceControlWorkspace: {
        createTitle: 'Crear espacio de trabajo vinculado',
        createSubtitle: 'Agrega esta copia de trabajo a un espacio de trabajo vinculado y abre su configuración.',
        otherCheckoutsTitle: 'Otras copias de trabajo',
        unlinkedWorktreesTitle: 'Árboles de trabajo sin vincular',
        createSessionInWorktreeTitle: 'Crear sesión aquí',
        adoptWorktreeTitle: 'Añadir worktree al espacio de trabajo',
    },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "Información de la sesión",
	    killSession: "Terminar sesión",
    killSessionConfirm: "¿Seguro que quieres terminar esta sesión?",
    stopSession: "Detener sesión",
    stopSessionConfirm: "¿Seguro que quieres detener esta sesión?",
    archiveSession: "Archivar sesión",
    archiveSessionConfirm: "¿Seguro que quieres archivar esta sesión?",
    workspaceTitle: "Espacio de trabajo",
    workspaceLabel: "Espacio de trabajo",
    linkWorkspaceTitle: "Vincular este espacio de trabajo",
    linkWorkspaceSubtitle: "Crea un espacio de trabajo vinculado desde esta ruta de sesión y abre su configuración.",
    openWorkspaceTitle: "Abrir espacio de trabajo",
    openWorkspaceSubtitle: "Abre los detalles y la configuración del espacio de trabajo vinculado.",
    createWorktreeTitle: "Crear worktree",
    createWorktreeSubtitle: "Inicia una nueva sesión que creará un worktree de Git en este espacio de trabajo vinculado.",
    locationLabel: "Ubicación",
    checkoutLabel: "Copia de trabajo",
    happySessionIdCopied: "ID de sesión de Happier copiado al portapapeles",
    failedToCopySessionId: "Falló al copiar ID de sesión de Happier",
    happySessionId: "ID de sesión de Happier",
    claudeCodeSessionId: "ID de sesión de Claude Code",
    claudeCodeSessionIdCopied:
      "ID de sesión de Claude Code copiado al portapapeles",
    aiProfile: "Perfil de IA",
    aiProvider: "Proveedor de IA",
    failedToCopyClaudeCodeSessionId:
      "Falló al copiar ID de sesión de Claude Code",
    codexSessionId: "ID de sesión de Codex",
    codexSessionIdCopied: "ID de sesión de Codex copiado al portapapeles",
    failedToCopyCodexSessionId: "Falló al copiar ID de sesión de Codex",
    opencodeSessionId: "ID de sesión de OpenCode",
    opencodeSessionIdCopied: "ID de sesión de OpenCode copiado al portapapeles",
    auggieSessionId: "ID de sesión de Auggie",
    auggieSessionIdCopied: "ID de sesión de Auggie copiado al portapapeles",
    geminiSessionId: "ID de sesión de Gemini",
    geminiSessionIdCopied: "ID de sesión de Gemini copiado al portapapeles",
    qwenSessionId: "ID de sesión de Qwen Code",
    qwenSessionIdCopied: "ID de sesión de Qwen Code copiado al portapapeles",
    kimiSessionId: "ID de sesión de Kimi",
    kimiSessionIdCopied: "ID de sesión de Kimi copiado al portapapeles",
    kiloSessionId: "ID de sesión de Kilo",
    kiloSessionIdCopied: "ID de sesión de Kilo copiado al portapapeles",
    kiroSessionId: "ID de sesión de Kiro",
    kiroSessionIdCopied: "ID de sesión de Kiro copiado al portapapeles",
    customAcpSessionId: "ID de sesión de ACP personalizado",
    customAcpSessionIdCopied: "ID de sesión de ACP personalizado copiado al portapapeles",
    piSessionId: "ID de sesión de Pi",
    piSessionIdCopied: "ID de sesión de Pi copiado al portapapeles",
    copilotSessionId: "ID de sesión de Copilot",
    copilotSessionIdCopied: "ID de sesión de Copilot copiado al portapapeles",
    cursorSessionId: "ID de sesión de Cursor",
    cursorSessionIdCopied: "ID de sesión de Cursor copiado al portapapeles",
    metadataCopied: "Metadatos copiados al portapapeles",
    failedToCopyMetadata: "Falló al copiar metadatos",
    copyDebugInformation: "Copiar información",
    debugInformationCopyLabel: "Información",
    providerSessionLogs: ({ provider }: { provider: string }) => `Registros de sesión de ${provider}`,
    failedToKillSession: "Falló al terminar sesión",
    failedToStopSession: "Falló al detener sesión",
    failedToArchiveSession: "Falló al archivar sesión",
    connectionStatus: "Estado de conexión",
    created: "Creado",
    lastUpdated: "Última actualización",
    sequence: "Secuencia",
    quickActions: "Acciones rápidas",
    markSessionRead: "Marcar como leída",
    markSessionReadSubtitle: "Quitar la atención no leída de esta sesión",
    markSessionUnread: "Marcar como no leída",
    markSessionUnreadSubtitle: "Mantener esta sesión en tu lista de no leídas",
    keepInAttention: "Mantener en Requiere atención",
    keepInAttentionSubtitle: "La mantiene aquí incluso después de leerla",
    removeFromAttention: "Quitar de Requiere atención",
    removeFromAttentionSubtitle: "Deja que vuelva a bajar en la lista al leerla",
    executionRunsSubtitle: "Ver ejecuciones de esta sesión",
    automationsTitle: "Automatizaciones",
    automationsSubtitle: "Gestiona mensajes programados para esta sesión",
    viewSessionLogTitle: "Ver registro de sesión",
    viewSessionLogSubtitle: "Abrir el final del registro en vivo para esta sesión",
    pinSession: "Fijar sesión",
    unpinSession: "Desfijar sesión",
    copyResumeCommand: "Copiar comando de reanudación",
    resumeCommand: ({ sessionId }: { sessionId: string }) => `happier resume ${sessionId}`,
    viewMachine: "Ver máquina",
    viewMachineSubtitle: "Ver detalles de máquina y sesiones",
    killSessionSubtitle: "Terminar inmediatamente la sesión",
    stopSessionSubtitle: "Detener el proceso de la sesión",
    archiveSessionSubtitle: "Mover esta sesión a Archivadas",
    archivedSessions: "Sesiones archivadas",
    inactiveAndArchivedSessions: "Sesiones inactivas y archivadas",
    unarchiveSession: "Desarchivar sesión",
    unarchiveSessionConfirm: "¿Seguro que quieres desarchivar esta sesión?",
    unarchiveSessionSubtitle: "Mover esta sesión de vuelta a Inactivas",
    failedToUnarchiveSession: "Falló al desarchivar sesión",
    metadata: "Metadatos",
    host: "Host (servidor)",
    path: "Ruta",
    operatingSystem: "Sistema operativo",
    processId: "ID del proceso",
    happyHome: "Directorio de Happier",
    attachFromTerminal: "Adjuntar desde la terminal",
    tmuxTarget: "Destino de tmux",
    tmuxFallback: "Fallback de tmux",
    copyMetadata: "Copiar metadatos",
    agentState: "Estado del agente",
    rawJsonDevMode: "JSON sin procesar (modo desarrollador)",
    sessionStatus: "Estado de la sesión",
    fullSessionObject: "Objeto de sesión completo",
    controlledByUser: "Controlado por el usuario",
    pendingRequests: "Solicitudes pendientes",
    activity: "Actividad",
    thinking: "Pensando",
    thinkingSince: "Pensando desde",
    thinkingLevel: "Nivel de pensamiento",
    cliVersion: "Versión del CLI",
    cliVersionOutdated: "Actualización de CLI requerida",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `Versión ${currentVersion} instalada. Actualice a ${requiredVersion} o posterior`,
    updateCliInstructions:
      "Por favor ejecute happier self update",
    deleteSession: "Eliminar sesión",
    deleteSessionSubtitle: "Eliminar permanentemente esta sesión",
    deleteSessionConfirm: "¿Eliminar sesión permanentemente?",
    deleteSessionWarning:
      "Esta acción no se puede deshacer. Todos los mensajes y datos asociados con esta sesión se eliminarán permanentemente.",
    failedToDeleteSession: "Error al eliminar la sesión",
    sessionDeleted: "Sesión eliminada exitosamente",
    manageSharing: "Gestionar acceso",
    manageSharingSubtitle:
      "Comparte esta sesión con amigos o crea un enlace público",
    renameSession: "Renombrar Sesión",
    renameSessionSubtitle: "Cambiar el nombre de visualización de esta sesión",
    renameSessionPlaceholder: "Introduce el nombre de la sesión...",
    forkSession: "Bifurcar sesión",
    forkSessionSubtitle: "Crear una nueva sesión desde el contexto más reciente",
    newSessionSameSetup: "Nueva sesión con la misma configuración",
    newSessionSameSetupSubtitle: "Reutiliza la máquina, la carpeta, el motor, el modelo y las opciones de esta sesión.",
    failedToRenameSession: "Error al renombrar la sesión",
    failedToMarkSessionRead: "Error al marcar la sesión como leída",
    failedToMarkSessionUnread: "Error al marcar la sesión como no leída",
    sessionRenamed: "Sesión renombrada exitosamente",

	    openInSplitRight: "Abrir en división a la derecha",
	    openInSplitDown: "Abrir en división abajo",
	    revealInCurrentSplit: "Mostrar en la división actual",},

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "¿Listo para programar?",
      installCli: "Instale el Happier CLI",
      runIt: "Ejecútelo",
      scanQrCode: "Escanee el código QR",
      openCamera: "Abrir cámara",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "Aún no hay mensajes",
      created: ({ time }: { time: string }) => `Creado ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "No hay sesiones activas",
      startNewSessionDescription:
        "Inicia una nueva sesión en cualquiera de tus máquinas conectadas.",
      startNewSessionButton: "Iniciar nueva sesión",
      openTerminalToStart:
        "Abre un nuevo terminal en tu computadora para iniciar una sesión.",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "¿Qué hay que hacer?",
    },
    home: {
      noTasksYet: "Aún no hay tareas. Toca + para añadir una.",
    },
    view: {
      workOnTask: "Trabajar en la tarea",
      clarify: "Aclarar",
      delete: "Eliminar",
      linkedSessions: "Sesiones vinculadas",
      tapTaskTextToEdit: "Toca el texto de la tarea para editar",
    },
  },

  agentInput: {
      chipPicker: {
          selectedOptionAccessibilityLabel: ({ option }: { option: string }) => `${option}. Seleccionado.`,
      },
    suggestionGroups: {
      files: 'Archivos',
      plugins: 'Complementos',
      sessions: 'Sesiones',
      references: 'Referencias',
      skills: 'Habilidades',
      commands: 'Comandos',
    },
    stopCodingTurn: "Detener turno de programación",
      nonSteerableSend: {
        title: 'El agente está ocupado',
        modeChangeMessage: 'El cambio de modo de permisos no puede aplicarse al turno en curso.',
        providerConfigMessage: 'El cambio de este ajuste del proveedor no puede aplicarse al turno en curso.',
        specialCommandMessage: 'Este comando no puede ejecutarse durante el turno activo.',
        interruptAndSend: 'Interrumpir y enviar ahora',
        applySettingAndSteer: 'Aplicar el ajuste y dirigir ahora',
        applyNamedSettingAndSteer: ({ setting, value }: { setting: string; value: string }) => `Aplicar ${setting} → ${value} y dirigir ahora`,
        steerWithoutApplying: 'Dirigir ahora sin aplicar (se aplicará en el próximo mensaje)',
        queueForAfterTurn: 'Poner en cola para después del turno',
      },
    dropToAttach: "Suelta para adjuntar archivos",
    providerUsage: {
      title: "Uso del proveedor",
      accessibilityLabel: ({ value }: { value: string }) =>
        `Uso del proveedor: queda ${value}`,
      remaining: ({ percent }: { percent: string }) => `queda ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) =>
        `queda ${percent} · se restablece en ${reset}`,
      usedCount: ({ used, limit }: { used: string; limit: string }) =>
        `${used}/${limit} usado`,
      duration: {
        now: "ahora",
        outdated: 'Desactualizado',
        daysHours: ({ days, hours }: { days: number; hours: number }) =>
          `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
          `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    envVars: {
      title: "Variables de entorno",
      titleWithCount: ({ count }: { count: number }) =>
        `Variables de entorno (${count})`,
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
      title: "MODO DE PERMISOS",
      effectiveLabel: ({ label }: { label: string }) => `Efectivo: ${label}`,
      default: "Por defecto",
      readOnly: "Solo lectura",
      acceptEdits: "Aceptar ediciones",
      safeYolo: "Auto",
      yolo: "YOLO",
      plan: "Modo de planificación",
      bypassPermissions: "Modo Yolo",
      badgeAccept: "Aceptar",
      badgePlan: "Plan",
      badgeReadOnly: "Solo lectura",
      badgeSafeYolo: "Auto",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Aceptar todas las ediciones",
      badgeBypassAllPermissions: "Omitir todos los permisos",
      badgePlanMode: "Modo de planificación",
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
      customAcp: "ACP personalizado",
      pi: "Pi",
      copilot: "Copilot",

      ohMyPi: "oh-my-pi",},
    auggieIndexingChip: {
      on: "Indexación activada",
      off: "Indexación desactivada",
    },
      model: {
        title: "MODELO",
        useCliSettings: "Usar la configuración del CLI",
        running: ({ model }: { model: string }) => `En ejecución: ${model}`,
        lastUsed: ({ model }: { model: string }) => `Último usado: ${model}`,
        lastReported: ({ model }: { model: string }) => `Último informado: ${model}`,
        applyTimingNextMessage: "Se aplica a partir de tu próximo mensaje",
        applyTimingNewSession: "Se aplica al iniciar una sesión nueva",
        selectedForResume: "El modelo seleccionado se usará cuando se reanude esta sesión.",
        configureInCli: "Configurar modelos en la configuración del CLI",
        unavailable: "La detección de modelos no está disponible para este proveedor en esta máquina.",
        extendedContextToggleLabel: "Contexto de 1 millón de tokens",
        extendedContextToggleDescription: "Usa la ventana de contexto ampliada de 1 millón de tokens para este modelo.",
        customDescription: "Usa un id de modelo que no esté en la lista.",
        customPromptBody: "Introduce un id de modelo",
        customPlaceholder: "p. ej., claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "MODO DE PERMISOS",
      default: "Configuración del CLI",
      plan: "Modo de planificación",
      readOnly: "Modo de solo lectura",
      safeYolo: "Auto",
      yolo: "YOLO",
      badgePlan: "Plan",
      badgeReadOnly: "Solo lectura",
      badgeSafeYolo: "Auto",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "MODELO CODEX",
      gpt5CodexLow: "gpt-5-codex bajo",
      gpt5CodexMedium: "gpt-5-codex medio",
      gpt5CodexHigh: "gpt-5-codex alto",
      gpt5Minimal: "GPT-5 Mínimo",
      gpt5Low: "GPT-5 Bajo",
      gpt5Medium: "GPT-5 Medio",
      gpt5High: "GPT-5 Alto",
    },
    geminiPermissionMode: {
      title: "MODO DE PERMISOS GEMINI",
      default: "Por defecto",
      readOnly: "Solo lectura",
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      badgeReadOnly: "Solo lectura",
      badgeSafeYolo: "YOLO seguro",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "MODELO GEMINI",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "Más capaz",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "Rápido y eficiente",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "Más rápido",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
      windowTitle: "Ventana de contexto",
      usedDetail: ({
        percent,
        used,
        total,
      }: {
        percent: string;
        used: string;
        total: string;
      }) => `${percent} • ${used}/${total} de contexto usado`,
      description: "Compacta automáticamente su contexto cuando es necesario.",
    },
    suggestion: {
      fileLabel: "ARCHIVO",
      folderLabel: "CARPETA",
    },
    mode: {
      sectionTitle: "Modo",
      badge: ({ name }: { name: string }) => `Modo: ${name}`,
      badgePending: ({ name }: { name: string }) => `Modo: ${name} (pendiente)`,
      refreshModesA11y: "Actualizar modos",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Pendiente: cambiando de ${from} a ${to}`,
      currentMode: ({ name }: { name: string }) => `Actual: ${name}`,
      loadingModes: "Cargando modos…",
      refreshingModes: "Actualizando modos…",
      useDefaultModeHint: "Usa el modo predeterminado para este agente.",
      startIn: ({ name }: { name: string }) => `Iniciar en: ${name}`,
      build: "Construir",
      buildDescription: "Comportamiento predeterminado",
      plan: "Planificación",
      planDescription: "Pensar primero",
    },
    acp: {
      modeSectionTitle: "Modo",
      refreshModesA11y: "Actualizar modos",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Pendiente: cambiando de ${from} a ${to}`,
      currentMode: ({ name }: { name: string }) => `Actual: ${name}`,
      loadingModes: "Cargando modos…",
      refreshingModes: "Actualizando modos…",
      useDefaultModeHint: "Usa el modo predeterminado para este agente.",
      startIn: ({ name }: { name: string }) => `Iniciar en: ${name}`,
      optionsSectionTitle: "Opciones",
      optionsUnavailable: "Las opciones de configuración no están disponibles para este proveedor en esta máquina.",
      currentValue: ({ value }: { value: string }) => `Actual: ${value}`,
      optionOverriddenBy: ({ name }: { name: string }) => `Anulado por ${name}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `Pendiente: ${current} → ${requested}`,
    },
    actionMenu: {
      title: "ACCIONES",
      files: "Archivos",
      stop: "Detener",
    },
    noMachinesAvailable: "Sin máquinas",
  },

  machineLauncher: {
    showLess: "Mostrar menos",
    showAll: ({ count }: { count: number }) => `Mostrar todos (${count} rutas)`,
    enterCustomPath: "Ingresar ruta personalizada",
    offlineUnableToSpawn: "No se puede crear nueva sesión, desconectado",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "Abrir detalles",
    expand: "Expandir/contraer",
    input: "Entrada",
    output: "Salida",
    showFullContent: "Mostrar contenido completo",
    showLessContent: "Mostrar menos",
  },

    tools: {
      common: {
        more: ({ count }: { count: number }) => `+${count} más`,
        elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
        unknownToolTitle: "Herramienta",
      },
    bashView: {
        commandDiffTitle: "Comando sin procesar",
        commandDiffHint:
          "La vista previa del comando oculta un prefijo corto de limpieza del entorno para mantenerlo legible. El comando sin procesar completo se muestra a continuación.",
    },
      webFetch: {
        httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
      },
    fullView: {
      description: "Descripción",
      inputParams: "Parámetros de entrada",
      output: "Salida",
      error: "Error",
      completed: "Herramienta completada exitosamente",
      noOutput: "No se produjo salida",
      running: "La herramienta está ejecutándose...",
      debug: "Depuración",
      show: "Mostrar",
      hide: "Ocultar",
      rawJsonDevMode: "JSON crudo (modo desarrollador)",
    },
    agentTeamView: {
      team: "Equipo",
      member: "Miembro",
      type: "Tipo",
      content: "Contenido",
      status: "Estado",
      description: "Descripción",
    },
    workflowView: {
      title: "Título",
      description: "Descripción",
      status: "Estado",
      summary: "Resumen",
      run: "Ejecución",
      task: "Tarea",
      toolUse: "Uso de herramienta",
    },
    workflowActivityView: {
        untitled: "Flujo de trabajo",
        loading: "Cargando…",
        unavailable: "Detalles no disponibles",
        noDetail: "Sin más detalles",
        statusActive: "En ejecución",
        statusComplete: "Completado",
      statusFailed: "Fallido",
      statusStopped: "Detenido",
      statusInterrupted: "Interrumpido",
      statusBlocked: "Bloqueado",
        statusCancelled: "Cancelado",
        statusUnknown: "Desconocido",
        phaseUntitled: "Fase",
        phaseActivity: "Actividad",
        phaseComplete: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} completados`,
        phaseActive: ({ count }: { count: number }) => `${count} activos`,
        phaseFailed: ({ count }: { count: number }) => `${count} fallidos`,
        phaseBlocked: ({ count }: { count: number }) => `${count} bloqueados`,
        phasePending: ({ count }: { count: number }) => `${count} pendientes`,
        phaseSummary: ({ index, total, complete, agents }: { index: number; total: number; complete: number; agents: number }) => `Fase ${index} de ${total} · ${complete}/${agents} agentes`,
        agentFraction: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} agentes`,
        agentsCount: ({ count }: { count: number }) => `${count} agentes`,
        tokens: ({ tokens }: { tokens: string }) => `${tokens} tokens`,
        toolCalls: ({ count }: { count: number }) => `${count} herramientas`,
        showMore: ({ count }: { count: number }) => `Mostrar ${count}`,
        detailShowMore: 'Mostrar más',
        detailShowLess: 'Mostrar menos',
    },
    subAgentRunView: {
      planTitle: "Plan de trabajo",
      delegateTitle: "Delegación",
      reviewDigestTitle: "Resumen de revisión",
    },
    changeTitleView: {
      titleLabel: "Título",
    },
    enterPlanMode: {
      title: "Se activó el modo plan",
      body:
        "Ahora el agente proporcionará un plan estructurado antes de actuar. Puedes salir del modo plan o solicitar cambios cuando estés listo.",
    },
    structuredResult: {
      exit: "Código de salida",
      stdout: "Salida estándar",
      stderr: "Error estándar",
      diff: "Diferencias",
      result: "Resultado",
      items: "Elementos",
      more: ({ count }: { count: number }) => `+${count} más`,
    },
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `Crear subagente: ${subject}`,
      createTask: "Crear subagente",
      listTasks: "Listar subagentes",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `Actualizar subagente ${id} → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `Actualizar subagente ${id}`,
      updateTask: "Actualizar subagente",
    },
    taskOutputView: {
      waitingForTask: "Esperando a que termine la tarea en segundo plano.",
    },
    taskStopView: {
      stoppedCommandLabel: "Comando detenido",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `+${count} herramientas más`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "Indexación del espacio de trabajo",
      description:
        "La indexación ayuda al agente a buscar en tu base de código más rápido y a dar respuestas más precisas. Puede escanear archivos de tu espacio de trabajo.",
      optionFallback: "Opción",
      chooseOptionHint: "Elige una opción a continuación para continuar.",
    },
    acpHistoryImport: {
      title: "¿Importar historial de la sesión?",
      defaultNote:
        "Este historial de la sesión difiere de lo que ya está en Happier. Importarlo puede crear duplicados.",
      counts: {
        local: ({ count }: { count: number }) => `Local: ${count}`,
        remote: ({ count }: { count: number }) => `Remoto: ${count}`,
      },
      preview: {
        localTail: "Local (final)",
        remoteTail: "Remoto (final)",
        unknownRole: "desconocido",
      },
      actions: {
        import: "Importar",
        skip: "Omitir",
      },
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Edición ${index} de ${total}`,
      replaceAll: "Reemplazar todo",
      summaryEdits: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "edición", plural: "ediciones" })}`,
    },
    names: {
      task: "Tarea",
      subAgent: "Subagente",
      terminal: "Consola",
      searchFiles: "Buscar archivos",
      search: "Buscar",
      searchContent: "Buscar contenido",
      listFiles: "Listar archivos",
      planProposal: "Propuesta de plan",
      readFile: "Leer archivo",
      editFile: "Editar archivo",
      writeFile: "Escribir archivo",
      fetchUrl: "Obtener URL",
      readNotebook: "Leer cuaderno",
      editNotebook: "Editar cuaderno",
      todoList: "Lista de tareas",
      webSearch: "Búsqueda web",
      reasoning: "Razonamiento",
      applyChanges: "Actualizar archivo",
      viewDiff: "Diferencias",
      turnDiff: "Diferencias del turno",
      question: "Pregunta",
      changeTitle: "Cambiar título",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `Buscar(patrón: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `Buscar(ruta: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) => `Obtener URL(url: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `Editar cuaderno(archivo: ${path}, modo: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Lista de tareas(cantidad: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Búsqueda web(consulta: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(patrón: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} ediciones)`,
      readingFile: ({ file }: { file: string }) => `Leyendo ${file}`,
      writingFile: ({ file }: { file: string }) => `Escribiendo ${file}`,
      modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `Modificando ${count} archivos`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} y ${count} más`,
      showingDiff: "Mostrando cambios",
      turnDiffRecap: "Resumen de los cambios de este turno",
    },
    askUserQuestion: {
      claudeDialogNotice: {
        header: 'Diálogo de Claude',
        question: 'Claude muestra un diálogo. Abre la terminal para revisarlo y elegir cómo continuar.',
        openTerminal: 'Abrir terminal',
        description: 'Revisa y responde el diálogo en la terminal de Claude.',
      },
      submit: "Enviar respuesta",
      multipleQuestions: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "pregunta", plural: "preguntas" })}`,
      other: "Otro",
      otherDescription: "Escribe tu propia respuesta",
      otherPlaceholder: "Escribe tu respuesta...",
    },
    exitPlanMode: {
      approve: "Aprobar plan",
      reject: "Rechazar",
      requestChanges: "Solicitar cambios",
      planMissing:
        "No se proporcionó el texto del plan. Consulta el plan en el mensaje anterior o pide al agente que lo incluya en la solicitud de aprobación.",
      requestChangesPlaceholder:
        "Dile a Claude qué quieres cambiar de este plan…",
      requestChangesSend: "Enviar comentarios",
      requestChangesEmpty: "Escribe qué quieres cambiar.",
      requestChangesFailed:
        "No se pudieron solicitar cambios. Inténtalo de nuevo.",
      responded: "Respuesta enviada",
      approvalMessage:
        "Apruebo este plan. Por favor, continúa con la implementación.",
      rejectionMessage:
        "No apruebo este plan. Por favor, revísalo o pregúntame qué cambios me gustaría.",
    },
  },

  files: {
    searchPlaceholder: "Buscar archivos...",
    clearSearchA11y: "Borrar búsqueda",
    createFileA11y: "Crear archivo",
    createFolderA11y: "Crear carpeta",
    createFilePromptTitle: "Crear archivo",
    createFilePromptBody: "Introduce una ruta relativa a la raíz del proyecto.",
    createFileInvalidPath:
      "Ruta de archivo no válida. Usa una ruta relativa al workspace como src/new-file.ts.",
    createFileFailed: "No se pudo crear el archivo.",
    createFolderPromptTitle: "Crear carpeta",
	    createFolderPromptBody: "Introduce una ruta de carpeta relativa a la raíz del proyecto.",
	    createFolderInvalidPath:
	      "Ruta de carpeta no válida. Usa una ruta relativa al workspace como src/new-folder.",
	    createFolderFailed: "No se pudo crear la carpeta.",
	    repositoryTree: {
	      actions: {
	        copyPath: "Copiar ruta",
	        download: "Descargar",
	        downloadAsZip: "Descargar como ZIP",
	      },
	      dropToUpload: "Suelta archivos para subir",
	      rename: {
	        title: "Renombrar",
	        body: "Introduce una nueva ruta relativa a la raíz del proyecto.",
	        invalidPath:
	          "Ruta no válida. Usa una ruta relativa al workspace como src/new-file.ts.",
	        failed: "No se pudo renombrar.",
	        conflicts: {
	          title: "El destino ya existe",
	          body: ({ path }: { path: string }) => `"${path}" ya existe. ¿Qué quieres hacer?`,
	        },
	      },
	      deleteFolder: {
	        title: "¿Eliminar carpeta?",
	        body: ({ path }: { path: string }) =>
	          `¿Eliminar la carpeta ${path} y todo su contenido?`,
	        confirm: "Eliminar carpeta",
	      },
	      deleteFile: {
	        title: "¿Eliminar archivo?",
	        body: ({ path }: { path: string }) => `¿Eliminar el archivo ${path}?`,
	      },
	      delete: {
	        failed: "No se pudo eliminar.",
	      },
	      download: {
	        notReady: "La descarga todavía no está disponible.",
	      },
	    },
	    changeRow: {
	      viewDiffA11y: ({ file }: { file: string }) => `Ver diff de ${file}`,
	      status: {
	        untracked: "Archivo no rastreado",
        added: "Archivo nuevo",
        deleted: "Archivo eliminado",
        renamed: "Archivo renombrado",
        copied: "Archivo copiado",
        conflicted: "Archivo en conflicto",
        modified: "Archivo modificado",
      },
    },
    projectLinkPicker: {
      title: "Vincular archivo del proyecto",
      searchFailed: "La búsqueda falló. Inténtalo de nuevo.",
    },
    detachedHead: "HEAD separado",
    branchSwitchDialog: {
      title: "Cambiar de rama",
      body: "Tienes cambios sin confirmar. ¿Cómo quieres manejarlos?",
      leaveTitle: ({ branch }: { branch: string }) => `Dejar mis cambios en ${branch}`,
      leaveSubtitle: "Crea un stash en la rama actual y cambia.",
      bringTitle: ({ branch }: { branch: string }) => `Llevar mis cambios a ${branch}`,
      bringSubtitle: "Intenta cambiar y mantener tus cambios en la nueva rama.",
    },
    branchMenu: {
      openA11y: "Abrir menú de ramas",
      failedToLoad: "No se pudieron cargar las ramas.",
      unavailable: "Lista de ramas no disponible",
      empty: "No se encontraron ramas",
      searchPlaceholder: "Buscar ramas...",
      category: {
        actions: "Acciones",
        branches: "Ramas",
        worktrees: "Árboles de trabajo",
        remote: "Remotas",
        local: "Locales",
        options: "Opciones",
      },
      publish: {
        title: "Publicar rama",
        subtitle: "Sube la rama actual a una rama remota upstream",
        short: "Publicar",
        failed: "No se pudo publicar la rama.",
      },
      create: {
        title: "Crear rama",
        subtitle: ({ name }: { name: string }) => `Crear "${name}"`,
        failed: "No se pudo crear la rama.",
      },
      switch: {
        failed: "No se pudo cambiar de rama.",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `Upstream: ${upstream}`,
      },
      remotes: {
        show: "Mostrar ramas remotas",
        hide: "Ocultar ramas remotas",
        subtitle: "Incluir ramas remotas en la lista",
      },
      worktrees: {
        createFromCurrentBranchTitle: "Nuevo worktree desde la rama actual",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) =>
          `Crea un nuevo worktree a partir de ${branch} e inicia una sesión allí.`,
        createFromCurrentBranchDetachedSubtitle:
          "Cambia a una rama antes de crear un worktree desde la rama actual.",
        createFromAnotherBranchTitle: "Nuevo worktree desde otra rama",
        createFromAnotherBranchSubtitle:
          "Abre el flujo de nueva sesión para elegir otra rama o reutilizar un worktree existente.",
        removeTitle: "Eliminar worktree",
        removeSubtitle: ({ target }: { target: string }) =>
          `Elimina ${target} de este repositorio.`,
        removeConfirmTitle: "¿Eliminar worktree?",
        removeConfirmBody: ({ path }: { path: string }) =>
          `¿Eliminar el worktree en ${path}? Esto no se puede deshacer.`,
        removeConfirmButton: "Eliminar worktree",
        pruneTitle: "Purgar worktrees obsoletos",
        pruneSubtitle: "Limpia los metadatos obsoletos de worktrees para este repositorio.",
        createFailed: "No se pudo crear el worktree.",
        removeFailed: "No se pudo eliminar el worktree.",
        pruneFailed: "No se pudieron purgar los worktrees.",
      },
      pullRequests: {
        checkoutLocalTitle: "Extraer pull request",
        checkoutLocalSubtitle: "Pega una URL de PR o merge request, un número o un comando de checkout.",
        openWorktreeTitle: "Abrir pull request en un worktree",
        openWorktreeSubtitle: "Prepara el pull request en un worktree separado e inicia una sesión allí.",
        promptTitle: "Referencia de pull request",
        promptBody: "Pega una URL de pull request o merge request, un número o un comando de checkout.",
        promptPlaceholder: "https://github.com/owner/repo/pull/123",
        invalidReferenceBody: "Introduce una referencia válida de pull request o merge request.",
        checkoutFailed: "No se pudo extraer el pull request.",
        worktreeFailed: "No se pudo preparar el worktree del pull request.",
      },
      indexLock: {
        title: "¿Eliminar bloqueo de Git obsoleto?",
        body: "Git informó de un bloqueo del índice. Si no hay otro comando de Git ejecutándose, Happier puede eliminar el bloqueo obsoleto y reintentar.",
        confirm: "Eliminar bloqueo y reintentar",
        recoveryFailed: "No se pudo eliminar el bloqueo del índice de Git.",
      },
      stashOverwrite: {
        title: "¿Sobrescribir el stash de la rama?",
        body: ({ branch }: { branch: string }) =>
          `Ya existe un stash para ${branch}. ¿Sobrescribirlo?`,
        confirm: "Sobrescribir stash",
      },
    },
    stash: {
      summaryA11y: "Abrir detalles del stash",
      summaryTitle: "Stashes gestionados",
      detailsTitle: "Stashes gestionados",
      empty: "No hay stashes gestionados.",
      failedToLoad: "No se pudieron cargar los stashes.",
      failedToLoadDiff: "No se pudo cargar el diff del stash.",
      diffTruncated: "Diff truncado (límite de salida).",
      writeDisabled: "Las operaciones de escritura de control de código fuente están deshabilitadas.",
      noSelection: "Selecciona un stash para continuar.",
      selectA11y: ({ stash }: { stash: string }) => `Seleccionar stash ${stash}`,
      restore: "Restaurar",
      discard: "Descartar",
      restoreFailed: "No se pudo restaurar el stash.",
      discardFailed: "No se pudo descartar el stash.",
      restoreConfirm: {
        title: "¿Restaurar cambios del stash?",
        body: "Aplicará los cambios guardados a tu árbol de trabajo. Los conflictos pueden requerir resolución manual.",
        confirm: "Restaurar",
      },
      discardConfirm: {
        title: "¿Descartar cambios del stash?",
        body: "Esto eliminará permanentemente este stash.",
        confirm: "Descartar",
      },
    },
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} preparados • ${unstaged} sin preparar`,
    branchSummary: {
      ahead: "Por delante",
      behind: "Por detrás",
      included: "Incluido",
      staged: "Preparado",
      pending: "Pendiente",
      unstaged: "Sin preparar",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "Sin upstream",
    },
    stageActions: {
      selectPendingDiffMode:
        "Selecciona el modo de diff Pendiente para elegir líneas para el commit.",
      unableToBuildPatchFromSelection:
        "No se pudo crear un parche a partir de las líneas seleccionadas.",
      diffChangedRefreshAndReselect:
        "El diff cambió; actualiza y vuelve a seleccionar las líneas.",
    },
    discardChangesFor: ({ path }: { path: string }) => `Descartar cambios de ${path}`,
    commitSelection: {
      addToCommit: "Agregar al commit",
      removeFromCommit: "Quitar del commit",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "archivo", plural: "archivos" })}`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `Repository changed files (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Cambios atribuidos a la sesión (${count})`,
    latestTurnChanges: ({ count }: { count: number }) =>
      `Cambios del último turno (${count})`,
    agentReportedTurnChanges: ({ count }: { count: number }) =>
      `Cambios informados por el agente (${count})`,
    checkpointTurnChanges: ({ count }: { count: number }) =>
      `Cambios del punto de control (${count})`,
    selectedForCommitChanges: ({ count }: { count: number }) =>
      `Seleccionados para el commit (${count})`,
    latestTurnDescription:
      "Cambios respaldados por el proveedor del turno completado más reciente.",
    agentReportedTurnDescription:
      "Cambios que el agente informó explícitamente para el turno actual.",
    checkpointUnavailable:
      "El contenido del punto de control no está disponible para este turno.",
    checkpointAttributionShared:
      "La atribución del punto de control se comparte con otra actividad del worktree.",
    checkpointAttributionUnknown:
      "No se pudo determinar la atribución del punto de control.",
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Otros cambios del repositorio (${count})`,
    attributionReliabilityHigh:
      "Atribución de mejor esfuerzo. La vista del repositorio sigue siendo la fuente de verdad.",
    attributionReliabilityLimited:
      "Fiabilidad limitada: hay varias sesiones activas para este repositorio. Mostrando solo atribución directa.",
    attributionLegendFull:
      "direct = de las operaciones de esta sesión, inferred = atribución basada en instantánea",
    attributionLegendDirectOnly: "direct = de las operaciones de esta sesión",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} archivo${count === 1 ? "" : "s"} inferido${count === 1 ? "" : "s"} mantenido${count === 1 ? "" : "s"} en cambios solo del repositorio.`,
    noSessionAttributedChanges:
      "No se detectaron cambios atribuidos a la sesión.",
    noLatestTurnChanges:
      "No se detectaron cambios del último turno.",
    notRepo: "No es un repositorio de control de versiones",
    notUnderSourceControl: "Este directorio no está bajo control de versiones",
    repositoryInit: {
      initialize: "Inicializar repositorio",
      initializing: "Inicializando…",
      confirmTitle: "¿Inicializar repositorio?",
      confirmBody: "Crea un repositorio Git en esta carpeta. Los archivos existentes no se prepararán ni se confirmarán.",
      errors: {
        failed: "No se pudo inicializar el repositorio.",
      },
    },
    searching: "Buscando archivos...",
      noFilesFound: "No se encontraron archivos",
      noFilesInProject: "No hay archivos en el proyecto",
      repositoryFolderLoadFailed: "No se pudo cargar la carpeta",
      repositoryCollapseAll: "Contraer todo",
    sourceControlOperationsLog: {
      title: "Operaciones recientes de control de versiones",
      allSessions: "Todas las sesiones",
      thisSession: "Esta sesión",
      emptyThisSession: "No hay operaciones recientes para esta sesión.",
    },
    operationsHistory: {
      recentCommits: "Commits recientes",
      noCommitsAvailable: "No hay commits disponibles.",
      loadMore: "Cargar más commits",
    },
      reviewFilterPlaceholder: "Filtrar archivos...",
      reviewNoMatches: "Sin coincidencias",
      reviewLargeDiffOneAtATime: "Diff grande detectado; los diffs se cargarán al desplazarte.",
      reviewDiffRequestFailed: "No se pudo cargar el diff",
      reviewUnableToLoadDiff: "No se pudo cargar el diff",
      tryDifferentTerm: "Intente un término de búsqueda diferente",
      searchResults: ({ count }: { count: number }) =>
        `Resultados de búsqueda (${count})`,
    projectRoot: "Raíz del proyecto",
    stagedChanges: ({ count }: { count: number }) =>
      `Cambios preparados (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `Cambios sin preparar (${count})`,
      // File viewer strings
      fileReadFailed: "No se pudo leer el archivo",
      fileTooLargeToPreview: "El archivo es demasiado grande para previsualizarlo",
      fileWriteFailed: "No se pudo escribir el archivo",
    fileEditor: {
      experimentalHint:
        "La edición es experimental. Guarda para escribir los cambios en el worktree de la sesión.",
      frontmatterReadOnly: 'Frontmatter (solo lectura)',
    },
      fileEditingUnsupported:
        "La edición de archivos no es compatible con el daemon conectado. Actualiza Happier en la máquina para habilitar operaciones de escritura.",
      fileChangedExternally:
        "Este archivo cambió en disco mientras lo editabas. Tu borrador se mantuvo sin cambios; revisa el archivo más reciente antes de guardar.",
      selectionFailed: "No se pudo actualizar la selección",
      openReviewCommentsFailed: "No se pudieron abrir los comentarios de revisión",
          reviewComments: {
          title: ({ count }: { count: number }) =>
            `Comentarios de revisión (${count})`,
            placeholder: "Añade un comentario de revisión…",
          jump: "Saltar",
          addCommentA11y: "Añadir comentario",
          closeCommentA11y: "Cerrar comentario",
          draftsChipLabel: ({ count }: { count: number }) => `Revisión (${count})`,
          modalSubtitle: "Revisa qué comentarios se enviarán con tu próximo mensaje.",
          modalSummary: ({ included, count }: { included: number; count: number }) =>
            `${included} de ${count} seleccionados para el próximo prompt`,
          detachOrDiscardTitle: "¿Quitar comentarios de revisión?",
          detachOrDiscardBody:
            "Desvincular los mantiene guardados pero los excluye del próximo prompt. Descartar los elimina.",
          detachFromPrompt: "Desvincular del prompt",
          durable: {
            headerTitle: "Comentarios de revisión",
            count: ({ count }: { count: number }) => `${count}`,
            empty: "Todavía no hay comentarios de revisión",
            engine: "Motor",
            stale: "Obsoleto",
            outdated: "Desactualizado",
            binarySnapshot: "Instantánea binaria",
            minified: "Probablemente minificado",
            submoduleSnapshot: "Instantánea de submódulo",
            symlinkSnapshot: "Instantánea de enlace simbólico",
            textSnapshot: "Instantánea de texto",
            tooLargeSnapshot: "Instantánea demasiado grande",
            encryptedSnapshot: "Instantánea cifrada",
            truncated: "Truncado",
            bidiControls: "Controles bidi",
            redacted: "Redactado",
            contentUnavailable: "Contenido no disponible",
            edit: "Editar",
            resolve: "Resolver",
            dismiss: "Descartar",
            reopen: "Reabrir",
            redact: "Redactar",
            reply: "Responder",
            replyUnavailable: "Respuesta no disponible",
            bulkResolve: "Resolver visibles",
            bulkDismiss: "Descartar visibles",
            bulkPartialFailure: "Algunos comentarios no se actualizaron",
            bulkFailure: ({ commentId, errorCode }: { commentId: string; errorCode: string }) => `${commentId}: ${errorCode}`,
            filtersTitle: "Filtros",
            showActive: "Activos",
            showHistory: "Historial",
            refresh: "Actualizar",
            loadFailed: "No se pudieron cargar los comentarios de revisión",
            transitionReason: "Actualizado desde el panel de comentarios de revisión.",
            bulkTransitionReason: "Actualización masiva desde el panel de comentarios de revisión.",
            editPromptTitle: "Editar comentario de revisión",
            editPromptBody: "Actualiza el cuerpo del comentario guardado.",
            replyPromptTitle: "Responder al comentario de revisión",
            replyPromptBody: "Añade una respuesta al hilo duradero de comentarios.",
            states: {
              proposed: "Propuesto",
              open: "Abierto",
              delegated: "Delegado",
              pendingReview: "Revisión pendiente",
              resolved: "Resuelto",
              dismissed: "Descartado",
            },
            directWriteGrant: {
              title: "Escrituras directas de comentarios de revisión",
              body: ({ pluginId }: { pluginId: string }) => `${pluginId} solicita permiso para escribir comentarios de revisión directamente.`,
              grant: "Conceder escritura directa",
              cancel: "Ahora no",
              revoke: "Revocar",
            },
          },
            errors: {
              empty: "El comentario no puede estar vacío",
              couldNotMapSelection: "No se pudo asignar la selección a una línea del diff",
            },
          },
        commitDetails: {
          missingContext: "Falta el contexto del commit",
          failedToLoadDiff: "No se pudo cargar el diff del commit",
          diffUnavailableTitle: "Diff del commit no disponible",
          diffUnavailableHint:
            "Intenta abrir el commit de nuevo desde la pantalla Archivos.",
          commitLabel: "Commit (Git)",
          running: ({ operation }: { operation: string }) =>
            `En ejecución: ${operation}`,
          revert: {
            title: "Revertir commit",
            button: "Revertir commit",
            confirm: "Revertir",
            success: "El commit se revirtió correctamente",
            failed: "No se pudo revertir el commit",
          },
        },
        commitRevertUnavailable: "Revertir no está disponible para este commit.",
	        commitMessageEditor: {
	          placeholder: "Mensaje de commit",
	          generate: "Generar",
	          generating: "Generando…",
	          applySuggestion: "Aplicar sugerencia",
	          suggestionReady: "Hay una sugerencia lista. ¿Aplicarla?",
	          commit: "Hacer commit",
	          generateFailed: "No se pudo generar el mensaje de commit",
	          generatorDisabled: "El generador de mensajes de commit está deshabilitado",
	        },
      commitAdjacentPush: {
        accessibilityLabel: ({ target }: { target: string }) => `Push a ${target}`,
        confirm: {
          title: "¿Hacer push de los commits locales?",
          body: ({ target }: { target: string }) =>
            `Sube tus commits locales a ${target}.`,
          push: "Sí",
          notNow: "Ahora no",
          pushAndDontAskAgain: "Push y no volver a preguntar",
        },
      },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Cargando ${fileName}...`,
        binaryFile: "Archivo binario",
        imagePreviewTooLarge: "La vista previa de la imagen es demasiado grande para mostrarse",
        sessionMedia: {
          generatedImageA11y: ({ name }: { name: string }) => `Abrir imagen generada ${name}`,
          attachmentImageA11y: ({ name }: { name: string }) => `Abrir imagen adjunta ${name}`,
          toolArtifactImageA11y: ({ name }: { name: string }) => `Abrir imagen de artefacto de herramienta ${name}`,
          generatedVideoA11y: ({ name }: { name: string }) => `Abrir video generado ${name}`,
          attachmentVideoA11y: ({ name }: { name: string }) => `Abrir video adjunto ${name}`,
          toolArtifactVideoA11y: ({ name }: { name: string }) => `Abrir video de artefacto de herramienta ${name}`,
          previewImageA11y: ({ name, current, total }: { name: string; current: number; total: number }) => `Imagen ${current} de ${total}: ${name}`,

          previewUnavailableA11y: "Vista previa de medios no disponible",
          unavailableImageA11y: ({ name }: { name: string }) => `${name} unavailable`,},
        cannotDisplayBinary: "No se puede mostrar el contenido del archivo binario",
        diff: "Diferencias",
      file: "Archivo",
      markdown: "Rebaja",
    diffModes: {
      pending: "Pendiente",
      included: "Incluido",
      combined: "Combinado",
    },
    fileActions: {
      selectForCommit: "Seleccionar para el commit",
      selectFilesToCommit: "Seleccionar archivos para el commit",
      stageFile: "Preparar archivo",
      removeFromSelection: "Quitar de la selección",
      removeFromCommitSelection: "Quitar de la selección del commit",
      unstageFile: "Quitar de preparación",
      selectionHint:
        "Selecciona Incluido o Pendiente para habilitar la selección de líneas.",
      selectedLines: {
        selectLinesForCommit: "Seleccionar líneas para el commit",
        stageSelectedLines: "Preparar líneas seleccionadas",
        unstageSelectedLines:
          "Quitar preparación de las líneas seleccionadas",
      },
      clearSelection: "Limpiar selección",

      rangeSelection: "Selección de rango",
      selectEntireFileForCommit: "Seleccionar el archivo completo para confirmar",},
    toolbar: {
      changedFiles: "Archivos modificados",
      hiddenFiles: "Mostrar archivos ocultos",
      details: "Detalles",
      upload: "Subir",
      uploadFiles: "Subir archivos",
      uploadFolder: "Subir carpeta",
      allRepositoryFiles: "Todos los archivos del repositorio",
      repositoryView: "Vista del repositorio",
      selectedForCommitView: "Seleccionados para el commit",
      turnView: "Vista del turno",
      sessionView: "Vista de la sesión",
      view: "Vista",
      review: "Revisión",
      list: "Lista",
      scm: "Git",

      agentReportedTurnView: "Turno informado por el agente",
      checkpointTurnView: "Turno del checkpoint",},
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `Preparando la subida (${count} archivos)…`,
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
      }) => `Subiendo ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `Descargando ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "Conflictos al subir",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount} de ${totalCount} archivos ya existen. ¿Qué quieres hacer?`,
        keepBoth: {
          title: "Conservar ambos",
          subtitle:
            "Añade “ (1)”, “ (2)”, … a los nombres en conflicto.",
        },
        replace: {
          title: "Reemplazar",
          subtitle: "Sobrescribir archivos existentes.",
        },
        skip: {
          title: "Omitir",
          subtitle: "Subir solo los archivos que no existan.",
        },
      },
    },
    fileEmpty: "El archivo está vacío",
    noChanges: "No hay cambios que mostrar",
    sourceControlOperations: {
      title: "Control de versiones",
      actorThisSession: "esta sesión",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `sesión ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `En ejecución: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `Las operaciones de control de versiones están bloqueadas por ${actor}.`,
      globalLock:
        "Las operaciones están bloqueadas temporalmente porque otra sesión está ejecutando un comando de control de versiones.",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "1 archivo seleccionado para el próximo commit."
          : `${count} archivos seleccionados para el próximo commit.`,
      clear: "Limpiar",
      conflictsDetected:
        "Conflictos detectados. Commit, pull y push están bloqueados hasta que se resuelvan los conflictos.",
      actions: {
        fetch: "Obtener",
        pull: "Traer",
        push: "Enviar",
      },
      blockedHints: {
        lock: "Bloqueo",
        commitBlocked: "Commit bloqueado",
        pullBlocked: "Pull bloqueado",
        pushBlocked: "Push bloqueado",
      },
      update: {
        remotes: {
          title: "Remotos",
          empty: "No hay remotos configurados para este repositorio.",
          addTitle: "Añadir remoto",
          editTitle: ({ name }: { name: string }) => `Editar ${name}`,
          add: "Añadir remoto",
          remove: "Eliminar",
          nameLabel: "Nombre del remoto",
          fetchUrlLabel: "URL de fetch",
          pushUrlLabel: "URL de push",
          namePlaceholder: "origen",
          fetchUrlPlaceholder: "URL de fetch",
          pushUrlPlaceholder: "URL de push (opcional)",
          noFetchUrl: "Sin URL de fetch",
          removeConfirmTitle: "¿Eliminar remoto?",
          removeConfirmBody: ({ name }: { name: string }) =>
            `¿Eliminar ${name} de este repositorio?`,
          errors: {
            nameRequired: "Introduce un nombre de remoto.",
            fetchUrlRequired: "Introduce una URL de fetch.",
            addFailed: "No se pudo añadir el remoto.",
            saveFailed: "No se pudo actualizar el remoto.",
            removeFailed: "No se pudo eliminar el remoto.",
          },
        },
        publishRepository: {
          title: "Publicar en GitHub",
          body: "Crea un repositorio de GitHub y añádelo como origin.",
          ownerLabel: "Propietario",
          repositoryNameLabel: "Nombre del repositorio",
          repositoryNamePlaceholder: "nombre-del-repositorio",
          visibilityLabel: "Visibilidad",
          private: "Privado",
          public: "Público",
          internal: "Interno",
          remoteKindLabel: "URL remota",
          httpsRemote: "Remoto HTTPS",
          sshRemote: "Remoto SSH",
          originConflictLabel: "Origin existente",
          keepOrigin: "No reemplazar",
          setOriginUrl: "Establecer URL de origin",
          pushCurrentBranch: "Subir rama actual",
          publish: "Publicar repositorio",
          publishing: "Publicando…",
          noTargets: "Conecta GitHub o inicia sesión con gh CLI para publicar este repositorio.",
          errors: {
            targetRequired: "Elige una cuenta u organización de GitHub.",
            nameRequired: "Introduce un nombre de repositorio.",
            loadTargetsFailed: "No se pudieron cargar los destinos de publicación de GitHub.",
            publishFailed: "No se pudo publicar el repositorio.",
          },

          commitRequired: 'Crea un commit antes de publicar con el envío de rama activado.',
          unsafeUrl: 'El proveedor devolvió una acción de navegador fuera de la URL permitida.',
          originConflictRemediation: 'Elige si conservar el remote origin existente o actualizarlo al nuevo repositorio alojado.',
          auth: {
              connectedAccountReady: 'El servicio conectado de GitHub está disponible.',
              providerCliReady: 'GitHub CLI autenticado está disponible.',
          },
          remediation: {
              connectGitHub: 'Conectar GitHub',
              installGh: 'Instalar GitHub CLI',
              useManagedGh: 'Usar GitHub CLI administrado',
              authenticateGh: 'Autenticar GitHub CLI',
              openBrowser: 'Abrir navegador',
          },},
        branchIntegration: {
          title: "Merge y rebase",
          sourceLabel: "Rama de origen",
          sourcePlaceholder: "Rama o referencia remota",
          merge: "Fusionar",
          rebase: "Rebasar",
          continue: "Continuar",
          abort: "Abortar",
          operationInProgress: ({ operation, source }: { operation: string; source: string }) =>
            `${operation} en curso desde ${source}`,
          errors: {
            sourceRequired: "Introduce una rama o referencia de origen.",
            mergeFailed: "No se pudo hacer merge de la rama.",
            rebaseFailed: "No se pudo hacer rebase de la rama.",
            continueFailed: "No se pudo continuar la operación.",
            abortFailed: "No se pudo abortar la operación.",
          },
        },
        pullRequests: {
          title: "Solicitud de extracción",
          readyTitle: "Listo para abrir una pull request",
          view: "Ver PR",
          openOrReuse: "Abrir o reutilizar PR",
          pushAndOpen: "Publicar y abrir PR",
          createFeatureBranch: "Crear rama de funcionalidad",
          createFeatureBranchAndOpen: "Crear rama y abrir PR",
          featureBranchPromptTitle: "Nombre de la rama de funcionalidad",
          featureBranchPromptBody: "Happier cambiará a esta rama antes de continuar.",
          defaultBranchRequiresFeature: "Crea una rama de funcionalidad antes de abrir una pull request desde la rama predeterminada.",
          defaultBranchDenied: "No se pueden abrir pull requests directamente desde la rama predeterminada.",
          states: {
            ready: "Listo",
            open: "Abierta",
            closed: "Cerrada",
            merged: "Fusionada",
          },
          status: {
            creating: "Abriendo pull request…",
            creatingFeatureBranch: "Creando rama de funcionalidad…",
            creatingFeatureBranchPullRequest: "Creando rama de funcionalidad y abriendo pull request…",
            pushingAndCreating: "Publicando rama y abriendo pull request…",
          },
          unavailable: {
            notRepositoryTitle: "No se detectó ningún repositorio",
            notRepositoryBody: "Las acciones de pull request aparecen cuando esta sesión está asociada a un repositorio de control de versiones.",
            unknownProviderTitle: "No se detectó ningún proveedor de alojamiento",
            unknownProviderBody: "Añade un remoto de GitHub, GitLab o Bitbucket para activar las acciones de pull request.",
            noBranchTitle: "No hay ninguna rama seleccionada",
            noBranchBody: "Cambia a una rama antes de abrir una pull request.",
            detachedHeadTitle: "HEAD separado",
            detachedHeadBody: "Cambia a una rama antes de abrir una pull request.",
          },
          errors: {
            featureBranchRequired: "Crea una rama de funcionalidad antes de abrir una pull request.",
            openFailed: "No se pudo abrir la pull request.",
            branchNameRequired: "Introduce un nombre de rama de funcionalidad.",
            createBranchFailed: "No se pudo crear la rama de funcionalidad.",
            stackedFailed: "No se pudo completar el flujo de pull request.",
          },
        },

        pullRequest: {
            title: "Solicitud de cambios",
            existing: "Solicitud de cambios existente",
            ready: "Listo para crear una solicitud de cambios",
            branchPair: ({ head, base }: { head: string; base: string }) =>
                `${head} hacia ${base}`,
            open: "Abrir solicitud de cambios",
            create: "Crear solicitud de cambios",
            openCompose: "Abrir composición",
            unsafeUrl: "El proveedor devolvió un enlace fuera de la URL permitida del repositorio.",
            defaultBranch: {
                confirmTitle: "¿Crear rama de función?",
                confirmBody: "Crea una rama de función antes de abrir la solicitud de cambios para este cambio en la rama predeterminada.",
                confirm: "Crear rama",
            },
        },
        publish: {
            title: "Publicar repositorio",
            description: "Crea un repositorio alojado y adjúntalo como remoto.",
            repositoryNameLabel: "Nombre del repositorio",
            ownerLabel: "Propietario",
            visibilityLabel: "Visibilidad",
            protocolLabel: "URL remota",
            pushCurrentBranch: "Enviar la rama actual",
            commitRequired: "Crea un commit antes de publicar con el envío de rama activado.",
            submit: "Publicar repositorio",
            unavailable: "La publicación no está disponible para este repositorio.",
            unsafeUrl: "El proveedor devolvió una acción del navegador fuera de la URL permitida.",
            auth: {
                connectedAccountReady: "El servicio conectado de GitHub está disponible.",
                providerCliReady: "La CLI de GitHub autenticada está disponible.",
            },
            remediation: {
                connectGitHub: "Conectar GitHub",
                installGh: "Instalar la CLI de GitHub",
                useManagedGh: "Usar la CLI de GitHub administrada",
                authenticateGh: "Autenticar la CLI de GitHub",
                openBrowser: "Abrir navegador",
            },
            visibility: {
                private: "Privado",
                public: "Público",
                internal: "Interno",
            },
            protocol: {
                https: "HTTPS",
                ssh: "SSH",
            },
            remoteConflict: {
                label: "Remoto origin existente",
                fail: "Mantener origin existente",
                setUrl: "Reemplazar URL de origin",
                remediation: "Elige si quieres mantener el remoto origin existente o actualizarlo al nuevo repositorio alojado.",
            },
        },},

      repositoryInit: {
          action: "Inicializar repositorio",
          confirmTitle: "¿Inicializar repositorio?",
          confirmBody: "Crea metadatos de control de código fuente para esta carpeta para poder rastrear los cambios.",
          confirm: "Inicializar",
          failed: "No se pudo inicializar el repositorio.",
      },},

    indexLockRecovery: {
      title: "¿Eliminar el bloqueo de índice de Git obsoleto?",
      body: "Happier puede eliminar el archivo index.lock resuelto por Git para este repositorio y reintentar la operación de control de código una sola vez. Esto no ejecuta reset, clean, restore ni ninguna reparación amplia.",
      confirm: "Eliminar bloqueo y reintentar",
      failed: ({ error }: { error: string }) => `Error al recuperar el bloqueo de índice: ${error}`,
    },
    checkpointAttributionExclusive:
      "El contenido del checkpoint es exacto para este intervalo de turno y el worktree era exclusivo de esta sesión.",
    noAgentReportedTurnChanges:
      "No se detectaron cambios informados por el agente para este turno.",
    noCheckpointTurnChanges:
      "No se detectaron cambios de checkpoint para este turno.",},

  localServices: {
    inventory: {
      title: 'Servicios locales',
      loadingTitle: 'Buscando servicios locales',
      emptyTitle: 'No se detectaron servicios locales',
      errorTitle: 'El escaneo de servicios locales necesita atención',
      refreshing: 'Actualizando',
      state: {
        listening: 'Escuchando',
        stale: 'Obsoleto',
        gone: 'No disponible',
        unknown: 'Desconocido',
      },
      address: ({ value }: { value: string }) => `Address: ${value}`,
      folder: ({ value }: { value: string }) => `Folder: ${value}`,
      label: ({ value }: { value: string }) => `Label: ${value}`,
      process: ({ value }: { value: string }) => `Process: ${value}`,
      workspace: ({ value }: { value: string }) => `Workspace: ${value}`,
      confidence: ({ value }: { value: string }) => `Confidence: ${value}`,
            confidenceLabel: {
                strong: 'Coincidencia de alta confianza',
                moderate: 'Coincidencia probable',
                tentative: 'Coincidencia tentativa',
            },
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      countBadge: ({ total, running }: { total: string; running: string }) => `${total} services · ${running} running`,
    },
    session: {
      thisSessionTitle: 'Esta sesión',
      workspaceTitle: 'Espacio de trabajo',
    },
    scope: {
      workspace: 'Este espacio de trabajo',
      machine: 'Esta máquina',
      toggleA11y: 'Alternar el alcance de los servicios entre este espacio de trabajo y esta máquina',
    },
    source: {
      detected: 'Detectado',
      managed: 'Gestionado',
      packageScript: 'Script de paquete',
      preview: 'Vista previa',
      terminalUrl: 'URL de terminal',
      fileAsset: 'Recurso de archivo',
      recent: 'Reciente',
    },
    band: {
      machine: 'Otros servicios de la máquina',
      suggestions: 'Sugerencias',
    },
    rowStatus: {
      running: 'En ejecución',
      starting: 'Iniciando',
      stale: 'Obsoleto',
      stopped: 'Detenido',
      unavailable: 'No disponible',
    },
    managed: {
      title: 'Servicios gestionados',
      emptyTitle: 'Sin servicios gestionados',
      owner: ({ value }: { value: string }) => `Owner: ${value}`,
      route: ({ value }: { value: string }) => `Route: ${value}`,
      launchMode: ({ value }: { value: string }) => `Mode: ${value}`,
            launchModeLabel: {
                detectedAfterStart: 'Detectado después del inicio',
                assignedAtStart: 'Puerto asignado al inicio',
                registeredByTool: 'Registrado por la herramienta',
            },
      url: ({ value }: { value: string }) => `URL: ${value}`,
      inventory: ({ value }: { value: string }) => `Inventory: ${value}`,
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      stopActionA11y: 'Detener servicio gestionado',
      restartActionA11y: 'Reiniciar servicio gestionado',
      status: {
        starting: 'Iniciando',
        detecting: 'Detectando',
        running: 'En ejecución',
        unhealthy: 'Con problemas',
        stopping: 'Deteniendo',
        stopped: 'Detenido',
        failed: 'Error',
      },
    },
    launcher: {
      title: 'Plataforma de lanzamiento',
      refreshing: 'Actualizando servicios locales',
      openInBrowserA11y: 'Abrir servicio local en el navegador',
      status: {
        ready: 'Listo para vista previa',
        managed: 'Servicio gestionado',
        unavailableGeneric: "Este servicio no está disponible ahora mismo.",
      },
      unavailableReason: {
        launchUnavailable: "Este servicio no se puede iniciar desde aquí.",
        previewRegistrationUnavailable: "Este servicio no puede registrar una vista previa.",
        browserTargetUnavailable: "Este servicio no se puede abrir en el navegador.",
        starting: "Este servicio todavía se está iniciando.",
        stale: "Este servicio se detectó pero ya no responde.",
        unavailable: "Este servicio no está disponible ahora mismo.",
      },
    },
    publicPreview: {
      title: 'Vistas previas públicas',
      createSubtitle: 'Crear un enlace de vista previa para compartir',
      activeSubtitle: 'Enlace compartible activo',
      secretLinkMode: 'Enlace secreto',
      disabledPolicySubtitle: 'Las vistas previas públicas están desactivadas para este servicio.',
      disabledUnsupportedModeSubtitle: 'Happier solo crea vistas previas públicas con enlace secreto por ahora.',
      disabledLimitSubtitle: 'Se alcanzó el límite de vistas previas públicas. Revoca un enlace existente antes de crear otro.',
      disabledNoPreviewSubtitle: 'Abre una vista previa local antes de crear un enlace público.',
      disabledReason: {
        auditRequirementDisabled: 'El registro de auditoría de vistas previas públicas es obligatorio pero está desactivado en el servidor.',
        auditUnavailable: 'El registro de auditoría de la vista previa pública no está disponible.',
        dnsTlsUnavailable: 'Las vistas previas públicas esperan a que DNS/TLS esté listo.',
        expired: 'Este enlace de vista previa pública ha caducado.',
        linkLifetimeUnconfigured: 'El servidor no tiene configurada la duración del enlace de vista previa pública.',
        modeUnconfigured: 'El servidor no tiene configurado ningún modo de vista previa pública.',
        policyInvalid: 'La política de vista previa pública está incompleta.',
        previewNotEligible: 'Esta vista previa local no es apta para un enlace público.',
        previewServerDisabled: 'Las vistas previas de servicios locales están desactivadas en el servidor.',
        publicBaseUrlUnavailable: 'La URL base de la vista previa pública no está configurada.',
        rateLimitProfileUnconfigured: 'El servidor no tiene configurado un perfil de límite de tasa para vistas previas públicas.',
        rateLimitUnavailable: 'La limitación de frecuencia de la vista previa pública no está disponible.',
        rateLimited: 'Este enlace de vista previa pública tiene límite de frecuencia.',
        relayUnavailable: 'El relay de vista previa pública no está disponible.',
        revoked: 'Este enlace de vista previa pública fue revocado.',
        secretLinkUnavailable: 'Las vistas previas públicas con enlace secreto no están configuradas.',
        serverDisabled: 'Las vistas previas públicas están desactivadas en el servidor.',
        sessionNotAuthorized: 'No tienes acceso para crear un enlace público para esta sesión.',
        tunnelPortsUnconfigured: 'El servidor no permite ningún puerto de túnel.',
        tunnelRelayDisabled: 'El relé del servidor para túneles de máquina está desactivado.',
      },
      createActionA11y: 'Crear enlace de vista previa pública',
      revokeActionA11y: 'Revocar enlace de vista previa pública',
      confirmTitle: '¿Hacer público el servicio?',
      confirmMessage: ({ service }: { service: string }) =>
        `"${service}" será accesible públicamente en Internet mediante un enlace secreto para compartir.`,
      confirmCta: 'Crear enlace público',
            revokeConfirmTitle: '¿Revocar enlace público?',
            revokeConfirmMessage: ({ url }: { url: string }) => `¿Revocar el enlace de vista previa pública ${url}? Quien lo use perderá el acceso.`,
            revokeConfirmCta: 'Revocar enlace',
    },
    actions: {
      terminateDetectedA11y: 'Terminar servicio local detectado',
      forgetA11y: 'Ocultar este servicio de la lista',
      terminatePidOnlyConfidence: 'Confianza de terminación: identidad solo por PID; se requiere confirmación',
            copyAddressA11y: 'Copiar dirección del servicio',
            terminateConfirmTitle: '¿Terminar servicio?',
            terminateConfirmMessage: ({ service }: { service: string }) => `¿Terminar ${service}? Usa esto solo cuando tengas claro que es el proceso correcto.`,
            terminateConfirmCta: 'Terminar',
            stopConfirmTitle: '¿Detener servicio?',
            stopConfirmMessage: ({ service }: { service: string }) => `¿Detener ${service}? El servicio no estará disponible hasta que vuelva a iniciarse.`,
            stopConfirmCta: 'Detener',
    },
  },

  browserContext: {
    composer: {
      attachPageReference: 'Adjuntar página',
      startAnnotation: 'Anotar página',
      cancelAnnotation: 'Cancelar anotación',
      attachAnnotation: 'Adjuntar anotación',
      contextUnavailable: 'Contexto del navegador no disponible',
      attachedPage: ({ title }: { title: string }) => `Página: ${title}`,
      attachedPageStale: ({ title }: { title: string }) => `Actualiza el contexto de la página: ${title}`,
      attachedCount: ({ count }: { count: string }) => `${count} contextos del navegador`,
      removeAttachedContext: 'Quitar contexto del navegador',
      untitledPage: 'Página sin título',
    },
    editor: {
      title: 'Anotar',
      toolSelect: 'Seleccionar',
      toolRegion: 'Región',
      toolDraw: 'Dibujar',
      toolErase: 'Borrar',
      commentPlaceholder: 'Añade un comentario',
      attach: 'Adjuntar anotación',
      cancel: 'Cancelar',
      captureUnavailable: 'La captura de anotaciones no está disponible para esta vista.',
      selectUnavailable: 'La selección de elementos no está disponible para esta vista.',
      marked: ({ count }: { count: string }) => `${count} marcados`,
      removeMark: ({ label }: { label: string }) => `Quitar ${label}`,
      markElement: ({ label }: { label: string }) => `Elemento ${label}`,
      markRegion: 'Región',
      markStroke: 'Dibujo',
    },
  },

  browserRecording: {
    actions: {
      start: 'Iniciar grabación',
      stop: 'Detener grabación',
      cancel: 'Cancelar grabación',
    },
    fidelity: {
        pixel: 'Captura visual',
        cdp: 'Captura del navegador',
        injectedPage: 'Captura de página',
        nativeCallback: 'Captura nativa',
        streamFrame: 'Captura de transmisión',
        previewProxy: 'Captura de vista previa',
        unavailable: 'Captura pendiente',
    },
    status: {
      noView: 'No hay ninguna vista del navegador seleccionada.',
      unavailable: ({ reason }: { reason: string }) => `Grabación no disponible: ${reason}`,
      ready: ({ fidelity }: { fidelity: string }) => `Grabación lista (${fidelity})`,
      recording: ({ elapsed, fidelity }: { elapsed: string; fidelity: string }) => `Grabando ${elapsed} (${fidelity})`,
      temporary: 'Temporal',
      attached: 'Adjunta',
      discarded: 'Descartada',
    },
  },

  browserAutomation: {
    actions: {
      cancel: 'Cancelar automatización',
    },
    status: {
      noView: 'No hay ninguna vista del navegador seleccionada.',
      unavailable: 'Automatización no disponible',
            running: 'Automatización en curso',
            readyForActions: 'Automatización lista',
      ready: ({ authority }: { authority: string }) => `Automatización lista (${authority})`,
      active: ({ requestId }: { requestId: string }) => `Automatización en curso: ${requestId}`,
    },
    timeline: {
      entry: ({ action, status }: { action: string; status: string }) => `${action}: ${status}`,
            action: {
                inspect: 'Inspeccionar página',
                interact: 'Interactuar con la página',
                navigate: 'Navegar por la página',
                browserAction: 'Acción del navegador',
            },
            status: {
                succeeded: 'Listo',
                failed: 'Fallido',
                canceled: 'Cancelado',
                timedOut: 'Tiempo agotado',
                stale: 'Página desactualizada',
                blocked: 'Bloqueado',
                unsupported: 'No compatible',
            },
    },
  },

  browserSurface: {
    title: 'Navegador',
    openA11y: 'Abrir navegador',
    openHint: 'Abre el panel de inicio del navegador en los detalles.',
    openDisabledA11y: 'Navegador no disponible',
  },

  browserLaunchpad: {
    refreshing: 'Actualizando destinos del navegador',
    sections: {
      running: 'Vistas previas en ejecución',
      managed: 'Servicios gestionados',
      plugin: 'UI de plugins',
      recent: 'Recientes',
      unavailable: 'No disponibles',
    },
    status: {
      ready: 'Listo para abrir',
      managed: 'Servicio gestionado',
      plugin: 'UI de plugin',
      recent: 'Destino reciente',
      openUnavailable: 'La apertura no está disponible',
      unavailableGeneric: "Este destino no está disponible ahora mismo.",
    },
    guidance: {
      title: 'Aún no hay nada en ejecución',
      body: 'Inicia un servidor de desarrollo y los puertos localhost de este espacio de trabajo aparecerán aquí automáticamente. También puedes escribir cualquier dirección arriba.',
    },
    urlEntry: {
      label: 'Abrir una dirección',
      placeholder: 'Introduce una URL',
      open: 'Abrir dirección',
      invalid: 'Introduce una dirección http o https válida.',
    },
    error: {
      title: 'Los destinos del navegador necesitan atención',
      subtitle: ({ reason }: { reason: string }) => `Error al actualizar: ${reason}`,
    },
  },

  browserShell: {
    address: {
      label: 'Dirección del navegador',
      placeholder: 'Introduce una URL',
            copy: 'Copiar URL',
            searchUnconfigured: 'No hay ningún buscador configurado: escribe una dirección web.',
    },
        frame: {
            errorTitle: 'La página no se pudo cargar',
        },
    nonFramable: {
      title: 'Este sitio no permite incrustarse.',
      openInSystemBrowser: 'Abrir en el navegador del sistema',
    },
    toolbar: {
      back: 'Atrás',
      forward: 'Adelante',
      reload: 'Recargar',
      stop: 'Detener',
      openNativeDevtools: 'Abrir herramientas de desarrollo nativas',
      reloadAfterCrash: 'Volver a cargar la página',
    },
    tabs: {
      newTab: 'Pestaña nueva',
    },
    origin: {
      newTab: 'Pestaña nueva',
      localPreview: 'Vista previa local',
      hostedPlugin: 'UI del plugin',
      external: 'URL externa',
      streamed: 'Navegador transmitido',
      simulator: 'Simulador',
    },
    security: {
      secure: 'Conexión segura',
      local: 'Conexión local',
      insecure: 'No segura',
      internal: 'Superficie interna',
      unknown: 'Estado de conexión desconocido',
    },
    title: {
      untitled: 'Página sin título',
    },
    overflow: {
      open: 'Más herramientas del navegador',
      title: 'Herramientas del navegador',
    },
    profile: {
      title: 'Estado del perfil del navegador',
      modeLabel: 'Modo',
      storageLabel: 'Almacenamiento',
      permissionsLabel: 'Permisos',
      unavailable: 'No disponible',
      mode: {
        ephemeral: 'Efímero',
        session: 'Sesión',
        user: 'Usuario',
        plugin: 'Complemento',
      },
      storage: {
        unavailable: 'Sin partición',
        ephemeral: 'Efímero',
        session: 'Sesión',
        persistent: 'Persistente',
        plugin: 'Complemento',
      },
      permissions: {
        none: 'Sin permisos',
        active: ({ count }: { count: number }) => `${count} activos`,
        prompt: 'Preguntar',
        denied: 'Denegado',
      },
      management: {
        createProfile: 'Nuevo perfil',
        selectProfile: 'Seleccionar perfil',
        revokePermission: 'Revocar',
        clearStorage: 'Borrar almacenamiento',
      },
    },
    privacy: {
      title: 'Privacidad y seguridad',
    },
    status: {
      noView: 'No hay ninguna vista del navegador seleccionada.',
      empty: 'No hay ninguna página cargada.',
      noUrl: 'No se ha cargado ninguna URL.',
      loading: 'Cargando…',
      crashed: 'Esta página dejó de responder y se cerró.',
    },
    unavailable: {
      generic: "Esta página no está disponible ahora mismo.",
      desktopEngineUnavailable: "El motor del navegador integrado no está disponible en este equipo.",
      desktopWebView: "El motor del navegador integrado no está disponible en este equipo. Aún puedes abrir esta página en el navegador del sistema.",
      desktopWebViewUnsupportedPlatform: "La navegación integrada aún no está disponible en esta plataforma.",
      externalUrlPolicyDenied: "Tu política de seguridad bloquea este sitio.",
      externalUrlUnavailable: "Este sitio no se puede abrir en el navegador integrado.",
      simulatorPreviewUnavailable: "La vista previa del simulador no está disponible ahora mismo.",
      sidecarRuntimeUnavailable: "El entorno del navegador no está disponible ahora mismo.",
      streamedBrowserUnavailable: "El navegador en streaming no está disponible ahora mismo.",
      hostUnavailable: "Se perdió la conexión con el host del navegador.",
      targetKindUnavailable: "Este destino no se puede abrir en el navegador integrado.",
      browserProfileMissing: "No hay ningún perfil de navegador disponible para esta página.",
      hostedPluginBlocked: "La política de seguridad bloquea esta página del complemento.",
      invalidUrl: "Esta dirección no se puede abrir.",
      ownerDisconnected: "Se perdió la conexión con el propietario de la página.",
      surface: {
        disabled: "La navegación integrada está desactivada.",
        viewTargetsDisabled: "Los destinos del navegador están desactivados.",
        hostLost: "Se perdió la conexión con el host del navegador.",
        adapterRecovering: "Reconectando con el navegador…",
        liveStateLost: "Se perdió la sesión activa del navegador.",
        unsupportedTarget: "Este destino no se puede abrir en el navegador integrado.",
      },
    },
    devtools: {
      title: 'Diagnósticos',
      collapse: 'Contraer diagnósticos',
      expand: 'Expandir diagnósticos',
      close: 'Ocultar diagnósticos',
      open: 'Mostrar diagnósticos',
      section: {
        console: 'Consola',
                pageErrors: 'Errores de página',
        network: 'Red',
        elements: 'Elementos',
        resources: 'Recursos',
        storage: 'Almacenamiento',
        info: 'Información',
        performance: 'Rendimiento',
      },
    },
  },

  streamPlayer: {
    status: {
      opening: 'Abriendo stream…',
      playing: 'En vivo',
      degraded: 'Degradado',
      reconnecting: 'Reconectando…',
      stopped: 'Detenido',
      unavailable: 'Stream no disponible',
      errorGeneric: 'Error de stream',
      decoderUnavailable: 'La decodificación de vídeo no está disponible en este navegador.',
      preservingLastFrame: 'Mostrando el último fotograma',
      permissionExpired: 'Permiso caducado',
      leaseExpired: 'Permiso de control caducado',
      lowBandwidth: 'Ancho de banda bajo',
      degradedCodec: 'Códec degradado',
    },
    actions: {
      requestKeyframe: 'Solicitar fotograma clave',
      lowerQuality: 'Bajar calidad',
    },
    controls: {
      readOnly: 'Solo lectura',
      controlling: 'Controlando',
      controlsUnavailable: 'Controles no disponibles',
      controlsAvailable: 'Controles disponibles',
    },
    renderer: {
      fallback: 'Renderizador de reserva',
    },
  },

  simulatorPreview: {
    picker: {
      title: 'Dispositivos',
      empty: 'No hay dispositivos de simulador disponibles.',
    },
    status: {
      connecting: 'Conectando con el dispositivo…',
      restoring: 'Restaurando la vista previa…',
    },
    availability: {
      available: 'Disponible',
      degraded: 'Degradado',
      unavailable: 'No disponible',
      noDevices: 'No hay dispositivos de simulador disponibles.',
      captureUnavailable: 'La captura no está disponible para este dispositivo.',
      resourceUnavailable: 'Este recurso de simulador no está disponible.',
      captureDegraded: 'La captura está degradada.',
      streamDegraded: 'La calidad del stream está degradada.',
      lastFrame: 'Mostrando el último fotograma disponible.',
      streamUnavailable: 'El stream no está disponible.',
      unavailableGeneric: 'La vista previa del dispositivo no está disponible en este momento.',
    },
    toolbar: {
      heldByOther: 'En uso por otro visor',
            heldByOtherWithHolder: ({ holder }: { holder: string }) => `Lo tiene ${holder}`,
      acquireControl: 'Tomar control',
      releaseControl: 'Liberar control',
      renewControl: 'Renovar control',
      snapshot: 'Captura',
            refreshFrame: 'Actualizar fotograma',
            quality: 'Calidad',
            reduceBandwidth: 'Reducir ancho de banda',
      fps: 'Límite 30 FPS',
      scale: 'Límite 1080 px',
      rotateLeft: 'Girar a la izquierda',
      homeButton: 'Inicio',
      backButton: 'Atrás',
      recentButton: 'Recientes',
      volumeUp: 'Subir volumen',
      volumeDown: 'Bajar volumen',
            moreControls: 'Más controles del dispositivo',
    },
    sidebands: {
      title: 'Diagnósticos',
      logs: 'Registros',
      accessibilityTree: 'Accesibilidad',
      deviceConfig: 'Configuración del dispositivo',
      appMetadata: 'Metadatos de la app',
      networkDiagnostics: 'Red',
      route: 'Ruta',
      captureHealth: 'Estado de captura',
      refresh: 'Actualizar',
      empty: 'Sin datos todavía.',
            open: 'Abrir diagnósticos',
            close: 'Cerrar diagnósticos',
            refreshA11y: ({ section }: { section: string }) => `Actualizar ${section}`,
            arrayValue: ({ count }: { count: string }) => `${count} elementos`,
            objectValue: ({ count }: { count: string }) => `${count} campos`,
            valueUnavailable: 'No disponible',
            fields: {
                level: 'Nivel',
                message: 'Mensaje',
                route: 'Ruta',
                status: 'Estado',
                reason: 'Motivo',
            },
    },
    diagnostics: {
      item: ({ reasonCode }: { reasonCode: string }) => `Diagnóstico: ${reasonCode}`,
    },
  },

  browserDiagnostics: {
    previewProxy: {
      title: 'Diagnósticos de vista previa',
      status: {
        available: 'Disponible',
        stale: 'Obsoleto',
        unavailable: 'No disponible',
      },
      fidelity: {
        previewProxy: 'Proxy de vista previa',
        unavailable: 'No disponible',
        cdp: 'CDP',
        injectedPage: 'Página inyectada',
        nativeCallback: 'Callback nativo',
        streamFrame: 'Fotograma de stream',
      },
      activeFlows: ({ count }: { count: string }) => `${count} flujos activos`,
      attributionAllViews: 'Tráfico de esta vista previa, todas las vistas',
      staleNotice: 'Los diagnósticos están obsoletos; reconecta para pedir una instantánea nueva.',
      unavailableReason: ({ reasonCode }: { reasonCode: string }) => `Diagnósticos no disponibles: ${reasonCode}`,
      networkEmpty: 'Aún no se capturó tráfico de vista previa.',
      familyAvailable: ({ family }: { family: string }) => `${family}: disponible`,
      familyUnavailable: ({ family }: { family: string }) => `${family}: no disponible`,
      httpFlow: ({ method, path, statusCode }: { method: string; path: string; statusCode: string }) => `${method} ${path} - ${statusCode}`,
      webSocketFlow: ({ subprotocol }: { subprotocol: string }) => `WebSocket - ${subprotocol}`,
      tunnelFlow: ({ flowId }: { flowId: string }) => `Túnel ${flowId}`,
      flowBytes: ({ bytesIn, bytesOut }: { bytesIn: string; bytesOut: string }) => `Entrada ${bytesIn} B / salida ${bytesOut} B`,
      flowMessages: ({ messagesIn, messagesOut }: { messagesIn: string; messagesOut: string }) => `Mensajes ${messagesIn}/${messagesOut}`,
    },
    host: {
      title: 'Diagnósticos del navegador',
      eventCount: ({ count }: { count: string }) => `${count} eventos de diagnóstico`,
      untrustedNotice: 'Los diagnósticos inyectados pueden ser manipulados por la página y tienen menor fidelidad.',
      untrustedEvent: 'Evento inyectado no confiable',
      eventsEmpty: 'Aún no se capturaron diagnósticos del navegador.',
      eventTitle: ({ family, kind }: { family: string; kind: string }) => `${family} - ${kind}`,
            eventTitles: {
                pageError: 'Error de página',
                console: 'Mensaje de consola',
            },
            eventKinds: {
                pageError: 'Error de página',
                consoleEntry: 'Entrada de consola',
                network: 'Evento de red',
                event: 'Evento',
            },
      eventSummaryUnavailable: 'No hay metadatos disponibles',
      families: {
        console: 'Consola',
                pageError: 'Errores de página',
        elements: 'Elementos',
        resources: 'Recursos',
        storage: 'Almacenamiento',
        performance: 'Rendimiento',
        network: 'Red',
        pageInfo: 'Información de la página',
                other: 'Diagnósticos',
            },
      detail: {
        keys: ({ count }: { count: string }) => `Claves (${count})`,
        entries: ({ count }: { count: string }) => `Recursos (${count})`,
      },
      fields: {
        method: 'Método',
        status: 'Estado',
        url: 'URL',
        duration: 'Tiempo',
        requestSize: 'Solicitud',
        responseSize: 'Respuesta',
        socket: 'Conector',
        state: 'Estado',
        framesSent: 'Fotogramas enviados',
        framesReceived: 'Fotogramas recibidos',
        bytesSent: 'Bytes enviados',
        bytesReceived: 'Bytes recibidos',
        messages: 'Mensajes',
        protocol: 'Protocolo',
        selector: 'Selector',
        backendNode: 'Nodo de backend',
        rect: 'Rectángulo',
        accessibleName: 'Nombre accesible',
        storageType: 'Tipo de almacenamiento',
        keyCount: 'Claves',
        truncated: 'Truncado',
        level: 'Nivel',
        arguments: 'Argumentos',
        message: 'Mensaje',
        serviceWorker: 'Trabajador de servicio',
        webgl: 'Estado de WebGL',
        webrtc: 'Estado de WebRTC',
        nodeCount: 'Nodos',
        elementCount: 'Elementos',
        maxDepth: 'Profundidad máxima',
        readyState: 'Estado de carga',
        lcp: 'LCP',
        cls: 'CLS',
        inp: 'INP',
        fcp: 'FCP',
        longTasks: 'Tareas largas',
        longTaskTime: 'Tiempo de tareas largas',
        responseEnd: 'Fin de respuesta',
        domContentLoaded: 'DOM listo',
        loadEventEnd: 'Fin de carga',
        type: 'Tipo',
      },
      interaction: {
        title: 'Diagnósticos interactivos',
        enabled: 'Diagnósticos interactivos activados',
        disabled: 'Diagnósticos interactivos desactivados',
        unavailable: ({ reasonCode }: { reasonCode: string }) => `Diagnósticos interactivos no disponibles: ${reasonCode}`,
        ownerOnly: 'Solo el propietario de la sesión puede activar los diagnósticos interactivos.',
        enable: 'Activar interacción',
        disable: 'Desactivar interacción',
        startPicker: 'Seleccionar elemento',
        cancelPicker: 'Cancelar selector',
        pickerActive: 'Selector de elementos activo',
        pickerUnavailable: 'Selector de elementos no disponible',
        eval: {
            title: 'Consola',
            placeholder: 'Evaluar una expresión',
            run: 'Ejecutar',
            empty: 'Aún no se evaluaron expresiones.',
            resultLabel: 'Resultado',
            statusPending: 'Evaluando…',
            statusCompleted: 'Completado',
            statusFailed: 'Fallido',
            statusTimedOut: 'Tiempo agotado',
            statusBlocked: 'Bloqueado',
            statusDegraded: 'Recopilador degradado',
            error: ({ reasonCode }: { reasonCode: string }) => `Error: ${reasonCode}`,
            expand: 'Expandir',
            collapse: 'Contraer',
            loading: 'Cargando propiedades…',
            noProperties: 'Sin propiedades.',
            propertiesFailed: ({ reasonCode }: { reasonCode: string }) => `Propiedades no disponibles: ${reasonCode}`,
        },
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Iniciar ejecución",
      sections: {
        intent: "Intención",
        permissions: "Permisos",
        backends: "Motores",
        profiles: "Perfiles",
        instructions: "Instrucciones",
      },
      intents: {
        review: "Revisión",
        plan: "Planificación",
        delegate: "Delegar",
      },
      permissionModes: {
        readOnly: "Solo lectura",
        default: "Predeterminado",
      },
      instructionsPlaceholder: "¿Qué debe hacer el subagente?",
      actions: {
        start: "Iniciar",
      },
      guidancePreview: "Vista previa de la guía",
      a11y: {
        startRun: "Iniciar ejecución",
        cancel: "Cancelar",
        selectIntent: ({ intent }: { intent: string }) =>
          `Seleccionar intención ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `Seleccionar permisos ${mode}`,
        selectProfile: ({ profile }: { profile: string }) => `Seleccionar perfil ${profile}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Alternar backend ${backendId}`,
      },
    },
    details: {
      titles: {
        executionRun: "Ejecución",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent} · ejecución`,
      },
      labels: {
        status: "Estado",
        statusValue: ({ value }: { value: string }) => `Status: ${value}`,
        runId: ({ value }: { value: string }) => `Run ID: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permissions: ${value}`,
        mode: ({ value }: { value: string }) => `Mode: ${value}`,
        intent: "Intención",
        backendId: "ID de backend",
        permissionMode: "Modo de permisos",
        retentionPolicy: "Política de retención",
        runClass: "Clase de ejecución",
        ioMode: "Modo E/S",
      },
      timestamps: {
        started: "Iniciado",
        finished: "Finalizado",
      },
    },
  },

        settingsActions: {
        aboutSubtitle: 'Elige dónde se muestra cada acción en la app, la voz y las integraciones. Los elementos no disponibles siguen visibles para que entiendas qué bloquean las funciones, la privacidad o el soporte en tiempo de ejecución.',
        aboutFooter: 'Estos ajustes se aplican globalmente a los valores predeterminados de tu cuenta. Los elementos no disponibles explican por qué un destino está bloqueado actualmente.',
        searchPlaceholder: 'Buscar acciones',
        detailSearchPlaceholder: 'Buscar superficies',
        noResults: 'Ninguna acción coincide con tu búsqueda actual.',
        noTargetsMatch: 'Ninguna superficie coincide con tu búsqueda actual.',
        noDescription: 'Todavía no hay descripción disponible.',
        requireApproval: 'Requerir aprobación',
        invalidActionTitle: 'Acción no encontrada',
        invalidActionSubtitle: 'Esta acción ya no está disponible en esta compilación.',
        configureActionAccessibilityLabel: 'Configurar acción',
        approvalHelpTitle: 'Modos de aprobación',
        approvalHelpBody: '“Preguntar primero” muestra una confirmación antes de que esta acción se ejecute desde esa superficie. “Permitido” deja que la acción se ejecute desde esa superficie sin pedir aprobación.',
        contributed: {
            machineSelectionTitle: 'Elige una máquina para las acciones aportadas',
            machineSelectionBody: 'Selecciona una máquina para ver y configurar las acciones declaradas por sus plugins instalados.',
            removedDescription: 'Esta acción aportada ya no está disponible desde la máquina seleccionada. Se conservan sus ajustes guardados.',
            removedTargetsTitle: 'Acción aportada no disponible',
            removedTargetsBody: 'La máquina seleccionada no declara esta acción actualmente. Sus ajustes guardados permanecen aquí.',
        },
        toolExposure: {
            title: 'Exposición de herramienta',
            footer: 'Controla si las acciones compatibles aparecen como herramientas directas o solo quedan disponibles mediante descubrimiento de acciones.',
            subtitle: 'Controla el registro de herramienta directa para esta superficie.',
            disabledSubtitle: 'Activa esta superficie antes de cambiar la exposición de herramienta.',
            options: {
                default: {
                    subtitle: 'Usa el valor predeterminado del producto para esta superficie.',
                },
                defaultDiscoverableOnly: {
                    title: 'Usar predeterminado (solo descubrible)',
                },
                defaultDirect: {
                    title: 'Usar predeterminado (herramienta directa)',
                },
                discoverableOnly: {
                    title: 'Solo descubrible',
                    subtitle: 'Disponible mediante descubrimiento de acciones sin añadir una herramienta directa.',
                },
                direct: {
                    title: 'Herramienta directa',
                    subtitle: 'Registra esta acción como una herramienta invocable directamente.',
                },
            },
        },
        spawnPolicy: {
            title: 'Política de creación de sesiones de IA',
            footer: 'Estos controles solo se aplican cuando un asistente dentro de una sesión de Happier crea otra sesión. La configuración heredada de la sesión padre sigue permitida; los elementos denegados rechazan sustituciones explícitas con un error claro.',
            toggles: {
                allowCustomDirectory: { title: 'Directorio personalizado', subtitle: 'Permite que el asistente elija otro directorio de trabajo.' },
                allowCrossMachine: { title: 'Destinos entre máquinas', subtitle: 'Permite crear la sesión en otra máquina disponible.' },
                allowBackendTargetOverride: { title: 'Destino de backend', subtitle: 'Permite elegir otro agente o destino de backend.' },
                allowModelOverride: { title: 'Modelo', subtitle: 'Permite elegir un modelo en lugar de heredar el modelo padre.' },
                allowPermissionModeOverride: { title: 'Modo de permisos', subtitle: 'Permite sustituciones iguales o inferiores. Las escaladas se siguen rechazando.' },
                allowAgentModeOverride: { title: 'Modo de agente', subtitle: 'Permite elegir un modo de agente o sesión.' },
                allowConfigOptionOverrides: { title: 'Opciones de configuración', subtitle: 'Permite opciones del proveedor como esfuerzo de razonamiento y flujos de trabajo.' },
                allowProfileOverride: { title: 'Perfil', subtitle: 'Permite seleccionar un perfil por id sin exponer secretos.' },
                allowEnvironmentVariables: { title: 'Variables de entorno', subtitle: 'Permite variables de entorno explícitas en sesiones nuevas.' },
                allowConnectedServicesOverride: { title: 'Servicios conectados', subtitle: 'Permite seleccionar vinculaciones de servicios conectados por referencia.' },
                allowMcpSelectionOverride: { title: 'Selección MCP', subtitle: 'Permite sustituir la selección heredada de servidores MCP.' },
                allowTranscriptStorageOverride: { title: 'Almacenamiento de transcripción', subtitle: 'Permite elegir un modo de almacenamiento compatible.' },
            },
            permissionCeiling: {
                title: 'Techo de permisos',
                subtitle: 'Techo adicional opcional por debajo del permiso del llamador.',
                options: {
                    inherit: { title: 'Sin techo adicional', subtitle: 'Usa el permiso del llamador como único techo.' },
                    default: { title: 'Predeterminado', subtitle: 'Requiere el comportamiento normal de aprobación o inferior.' },
                    acceptEdits: { title: 'Aceptar ediciones', subtitle: 'Permite ediciones automáticas, pero no omisión total.' },
                    bypassPermissions: { title: 'Omitir permisos', subtitle: 'Permite hasta omisión total solo si el llamador también la tiene.' },
                    plan: { title: 'Planificación', subtitle: 'Limita las sesiones creadas a planificación o solo lectura.' },
                    'read-only': { title: 'Solo lectura', subtitle: 'Limita las sesiones creadas a comportamiento de solo lectura.' },
                    'safe-yolo': { title: 'Yolo seguro', subtitle: 'Permite escrituras automáticas seguras en el espacio de trabajo.' },
                    yolo: { title: 'Modo yolo', subtitle: 'Permite hasta yolo solo si el llamador también lo tiene.' },
                },
            },
        },
        status: {
            allowed: ({ count }: { count: number }) => `${count} permitidos`,
            askFirst: ({ count }: { count: number }) => `${count} preguntar primero`,
            off: ({ count }: { count: number }) => `${count} desactivados`,
            unavailable: ({ count }: { count: number }) => `${count} no disponibles`,
        },
        modes: {
            off: 'Desactivado',
            askFirst: 'Preguntar primero',
            allowed: 'Permitido',
        },
        sections: {
            app: 'En la app',
            voice: 'Voz',
            integrations: 'Integraciones',
        },
        families: {
            browser: {
                title: 'Navegador',
            },
            simulator: {
                title: 'Simulador',
            },
            localServices: {
                title: 'Servicios locales',
            },
            plugins: {
                title: 'Complementos',
            },
            session: {
                title: 'Sesiones',
            },
            scm: {
                title: 'Control de versiones',
            },
            general: {
                title: 'generales',
            },
        },
        badges: {
            unavailable: 'No disponible',
        },
        reasons: {
            voiceFeature: 'Habilita los ajustes del Asistente de voz para usar este destino.',
            voiceInventoryPrivacy: 'Activa Compartir inventario del dispositivo en los ajustes de privacidad del Asistente de voz para usar este destino.',
            mcpFeature: 'Habilita los servidores MCP para mostrar esta acción a través de MCP.',
            executionRunsFeature: 'Habilita las ejecuciones para usar esta acción o destino.',
            memorySearchFeature: 'Habilita la Búsqueda de memoria local para usar esta acción.',
            sessionHandoffFeature: 'Habilita el soporte de traspaso de sesión para usar esta acción.',
            notAvailableInThisApp: 'Este destino aún no se muestra en este cliente.',
            requiredByAgentPolicy: 'La política exige aprobación para el agente. Esta acción siempre pregunta primero.',
        },
        targets: {
            session_header: {
                title: 'Encabezado de sesión',
                subtitle: 'Visible en la barra de herramientas del encabezado de sesión.',
            },
            session_action_menu: {
                title: 'Menú de sesión',
                subtitle: 'Visible en el menú de acciones de la sesión.',
            },
            session_info: {
                title: 'Detalles de la sesión',
                subtitle: 'Visible en la pantalla de información de la sesión.',
            },
            pending_messages: {
                title: 'Mensajes pendientes',
                subtitle: 'Visible en los controles de mensajes pendientes debajo de la transcripción de la sesión.',
            },
            command_palette: {
                title: 'Paleta de comandos',
                subtitle: 'Visible en la paleta de comandos global.',
            },
            slash_command: {
                title: 'Comando slash',
                subtitle: 'Disponible desde selectores de acciones estilo comando slash.',
            },
            agent_input_chips: {
                title: 'Chips del compositor',
                subtitle: 'Se muestran como chips rápidos junto a la entrada del agente.',
            },
            voice_panel: {
                title: 'Panel de voz',
                subtitle: 'Se muestran en el panel del asistente de voz.',
            },
            run_list: {
                title: 'Lista de ejecuciones',
                subtitle: 'Visible en las listas de ejecuciones.',
            },
            run_card: {
                title: 'Tarjetas de ejecución',
                subtitle: 'Visible en las tarjetas de ejecución.',
            },
            voice_tool: {
                title: 'Herramienta de voz',
                subtitle: 'Disponible para el agente de voz como una herramienta invocable.',
            },
            voice_action_block: {
                title: 'Bloque de acción de voz',
                subtitle: 'Se muestra dentro de bloques de acción de voz y sus elementos de interacción.',
            },
            agent: {
                title: 'Agente de sesión',
                subtitle: 'Disponible para agentes dentro de la sesión como herramienta invocable.',
            },
            mcp: {
                title: 'MCP',
                subtitle: 'Disponible a través del catálogo de acciones MCP.',
            },
            cli: {
                title: 'CLI de control de sesión',
                subtitle: 'Disponible a través de la superficie de CLI de control de sesión.',
            },
            api: {
                title: 'API',
                subtitle: 'Disponible mediante la API externa de acciones.',
            },
            plugin: {
                title: 'Plugins de confianza',
                subtitle: 'Disponible como acción para plugins de confianza.',
            },
            contextual_ui: {
                title: 'UI contextual',
                subtitle: 'Se muestra en superficies de UI contextual que no tienen una ubicación dedicada.',
            },

            voice: {
                title: 'Voz',
                subtitle: 'Disponible para el agente de voz como una superficie invocable.',
            },},
    },

settingsSession: {
	      sessionList: {
	          title: 'Lista de sesiones',
	          footer: 'Personaliza lo que aparece en cada fila de sesión.',
	          tagsTitle: 'Etiquetas de sesión',
	          tagsEnabledSubtitle: 'Controles de etiquetas visibles en la lista de sesiones',
	          tagsDisabledSubtitle: 'Controles de etiquetas ocultos',
	          workingStatusAnimatedTextTitle: 'Texto de trabajo animado',
	          workingStatusAnimatedTextEnabledSubtitle: 'Alterna verbos de trabajo mientras una sesión se ejecuta',
	          workingStatusAnimatedTextDisabledSubtitle: 'Muestra una etiqueta fija de trabajando... mientras una sesión se ejecuta',
	          narrowWorkingIndicatorTitle: 'Indicador de trabajo estrecho',
	          narrowWorkingIndicatorSpinnerSelectedSubtitle: 'Muestra un indicador giratorio pequeño y neutro en las filas estrechas',
	          narrowWorkingIndicatorPulseSelectedSubtitle: 'Muestra un punto pulsante en las filas estrechas',
	          narrowWorkingIndicatorSpinnerTitle: 'Indicador giratorio',
	          narrowWorkingIndicatorSpinnerSubtitle: 'Un indicador giratorio compacto y neutro mientras la sesión trabaja.',
	          narrowWorkingIndicatorPulseTitle: 'Punto pulsante',
	          narrowWorkingIndicatorPulseSubtitle: 'Un punto animado compacto mientras la sesión trabaja.',
	          workingIndicatorTitle: 'Indicador de trabajo',
	          workingIndicatorSpinnerSelectedSubtitle: 'Mostrar un indicador giratorio pequeño y neutro mientras las sesiones trabajan',
	          workingIndicatorPulseSelectedSubtitle: 'Mostrar un punto pulsante mientras las sesiones trabajan',
	          workingIndicatorSpinnerTitle: 'Indicador giratorio',
	          workingIndicatorSpinnerSubtitle: 'Un indicador giratorio compacto y neutro mientras la sesión trabaja.',
	          workingIndicatorPulseTitle: 'Punto pulsante',
	          workingIndicatorPulseSubtitle: 'Un punto animado compacto mientras la sesión trabaja.',
	          identityDisplayTitle: 'Identidad de sesión',
	          identityDisplaySubtitle: 'Elige qué aparece antes de los nombres de sesión en la lista.',
	          identityDisplayAvatarTitle: 'avatar',
	          identityDisplayAvatarSubtitle: 'Muestra el avatar generado de cada sesión.',
	          identityDisplayAgentLogoTitle: 'Logotipo del agente',
	          identityDisplayAgentLogoSubtitle: 'Muestra el logotipo del agente de cada sesión.',
	          identityDisplayNoneTitle: 'Ninguno',
	          identityDisplayNoneSubtitle: 'Oculta el marcador de identidad en las filas de sesión.',
	          headerIdentityDisplayTitle: 'Identidad del encabezado',
	          headerIdentityDisplaySubtitle: 'Elige qué aparece antes del título dentro de una sesión.',
	          headerIdentityDisplayAvatarTitle: 'avatar',
	          headerIdentityDisplayAvatarSubtitle: 'Muestra el avatar generado de la sesión.',
	          headerIdentityDisplayAgentLogoTitle: 'Logotipo del agente',
	          headerIdentityDisplayAgentLogoSubtitle: 'Muestra el logotipo del agente que ejecuta la sesión.',
	          headerIdentityDisplayNoneTitle: 'Ninguno',
	          headerIdentityDisplayNoneSubtitle: 'Empieza el encabezado con el título de la sesión.',
	          activeColorTitle: 'Color activo del título',
	          activeColorSubtitle: 'Elige qué sesiones usan el color activo del título.',
	          activeColorActivityAndAttentionTitle: 'Actividad y atención',
	          activeColorActivityAndAttentionSubtitle: 'Usa el color activo para sesiones en curso y sesiones que necesitan atención.',
	          activeColorAttentionOnlyTitle: 'Solo atención',
	          activeColorAttentionOnlySubtitle: 'Usa el color activo solo para sesiones que necesitan tu atención.',
	          activeColorAllActiveTitle: 'Todas las sesiones activas',
	          activeColorAllActiveSubtitle: 'Usa el color activo para cada sesión activa y conectada.',
	          sectionModeTitle: 'Secciones de sesiones',
	          sectionModeSubtitle: 'Elige si las sesiones se separan por actividad.',
	          sectionModeActivitySelectedSubtitle: 'Separa las sesiones activas e inactivas',
	          sectionModeSingleSelectedSubtitle: 'Muestra una sola seccion de sesiones agrupada por espacio de trabajo',
	          sectionModeActivityTitle: 'Activas e inactivas',
	          sectionModeActivitySubtitle: 'Separa las sesiones por actividad antes de agruparlas por espacio de trabajo.',
	          sectionModeSingleTitle: 'Todas las sesiones juntas',
	          sectionModeSingleSubtitle: 'Usa una sola seccion de sesiones y conserva la agrupacion por espacio de trabajo para cada sesion.',
	          menuSections: {
	              sortBy: 'Ordenar por',
	              show: 'Mostrar',
	              folderSortMode: 'Orden de carpetas',

	              organize: 'Organizar',},
	          orderingTitle: 'Orden de sesiones',
	          orderingSubtitle: 'Elige cómo se ordenan las sesiones dentro de sus grupos.',
	          orderingOptions: {
	              custom: 'Personalizado',
	              created: 'Creación',
	              updated: 'Actualización',
	          },
	          folderSortModeTitle: 'Orden de carpetas',
	          folderSortModeSubtitle: 'Elige cómo comparten la lista las carpetas y las sesiones.',
	          folderSortModeFoldersFirstTitle: 'Carpetas primero',
	          folderSortModeFoldersFirstSubtitle: 'Agrupa las carpetas por encima de las sesiones en cada espacio de trabajo o carpeta.',
	          folderSortModeMixedTitle: 'Mixto',
	          folderSortModeMixedSubtitle: 'Permite que carpetas y sesiones mantengan un orden compartido exacto.',
	          folderSortModeMixedDisabledInDateModeSubtitle: 'El orden mixto de carpetas esta disponible en el orden personalizado.',
	          attentionPromotionModeTitle: 'Sesiones que requieren atención',
	          attentionPromotionModeSubtitle: 'Elige dónde aparecen las sesiones que esperan tu acción o están listas para revisar',
	          attentionPromotionModeOffTitle: 'Dejar en su posición normal',
	          attentionPromotionModeOffSubtitle: 'Mantén la lista exactamente como está agrupada y ordenada',
	          attentionPromotionModeGlobalTitle: 'Agrupar arriba',
	          attentionPromotionModeGlobalSubtitle: 'Muestra una sección de atención por encima del resto',
	          attentionPromotionModeWithinGroupsTitle: 'Mover arriba del grupo actual',
	          attentionPromotionModeWithinGroupsSubtitle: 'Mantén las sesiones dentro de su carpeta o espacio de trabajo',
	          attentionStandingDefaultTitle: 'Mantener sesiones en Requiere atención',
	          attentionStandingDefaultEnabledSubtitle: 'Cada sesión se queda hasta que la quites',
	          attentionStandingDefaultDisabledSubtitle: 'Mantén las sesiones de una en una',
	          attentionStandingDefaultUnavailableSubtitle: 'Elige primero una ubicación en Sesiones que requieren atención',
	          workingPlacementModeTitle: 'Sesiones trabajando',
	          workingPlacementModeSubtitle: 'Elige dónde aparecen las sesiones que están trabajando ahora',
	          workingPlacementModeOffTitle: 'Dejar en la posición normal',
	          workingPlacementModeOffSubtitle: 'Mantén las sesiones trabajando exactamente como están agrupadas y ordenadas',
	          workingPlacementModeGlobalTitle: 'Agrupar arriba',
	          workingPlacementModeGlobalSubtitle: 'Muestra una sección de trabajo debajo de las sesiones que requieren atención',
	          workingPlacementModeWithinGroupsTitle: 'Mover arriba del grupo actual',
	          workingPlacementModeWithinGroupsSubtitle: 'Mantén las sesiones trabajando dentro de su carpeta o espacio de trabajo',
	          workspacePathDisplayTitle: 'Nombres de espacios de trabajo',
	          workspacePathDisplayNameSelectedSubtitle: 'Mostrar el último nombre de carpeta por defecto',
	          workspacePathDisplayPathSelectedSubtitle: 'Mostrar la ruta completa del espacio de trabajo',
	          workspacePathDisplayName: 'Nombre de carpeta',
	          workspacePathDisplayNameDescription: 'Usa el último segmento de la ruta salvo que hayas renombrado el espacio de trabajo.',
	          workspacePathDisplayPath: 'Ruta completa',
	          workspacePathDisplayPathDescription: 'Usa la ruta formateada del espacio de trabajo salvo que lo hayas renombrado.',
	          workspaceFaviconsTitle: 'Favicons de espacios de trabajo',
	          workspaceFaviconsEnabledSubtitle: 'Mostrar favicons detectados del proyecto junto a los nombres de espacios de trabajo',
	          workspaceFaviconsDisabledSubtitle: 'Ocultar favicons del proyecto en las cabeceras de espacios de trabajo',
	          workspaceMachineSubtitlesTitle: 'Nombres de máquina',
	          workspaceMachineSubtitlesEnabledSubtitle: 'Mostrar el nombre de la máquina debajo de los espacios de trabajo cuando haga falta',
	          workspaceMachineSubtitlesDisabledSubtitle: 'Ocultar los nombres de máquina de las cabeceras de espacios de trabajo',

	          folderTreeView: "Vista de árbol de carpetas",},
	      mobileWorkspaceExperience: {
	          groupTitle: 'Espacio de trabajo móvil',
	          groupFooter: 'Controla cómo se organizan las pantallas de sesión en teléfonos.',
	          title: 'Modo cockpit',
	          subtitle: 'Elige el diseño de teléfono usado dentro de las sesiones.',
	          options: {
	              cockpitTitle: 'Panel de control',
	              cockpitSubtitle: 'Usa pestañas inferiores para chat, archivos, Git, pestañas y terminal.',
	              classicTitle: 'Clásico',
	              classicSubtitle: 'Usa el diseño de sesión anterior.',
	          },
	      },
	      input: {
	          title: 'Apariencia de la entrada',
	          footer: 'Configura la apariencia de la barra de entrada del agente.',
	      },
          detailedBehavior: { title: 'Comportamiento detallado de sesión', footer: 'Abre páginas específicas para el compositor, límites del proveedor, reanudación y terminal.' },
          rootGroups: {
              launchDefaults: { title: 'Valores predeterminados de sesión nueva', footer: 'Elige cómo empiezan las sesiones nuevas y qué opciones se recuerdan.' },
              listOrganization: { title: 'Organización de la lista de sesiones', footer: 'Controla el orden, la agrupación, las secciones, las sesiones inactivas y el panel de escritorio predeterminado.' },
              rowDetails: { title: 'Detalles de las filas de sesión', footer: 'Elige qué etiquetas y detalles visuales aparecen en cada fila de sesión.' },
              activitySignals: { title: 'Señales de actividad y estado', footer: 'Controla cómo se destacan las sesiones activas, en ejecución y que necesitan atención.' },
              mobileLayout: { title: 'Diseño móvil de sesión', footer: 'Elige el diseño de teléfono que se usa dentro de las sesiones.' },
              agentPersonalization: { title: 'Instrucciones de prompt para el agente', footer: 'Controla las instrucciones que piden a los agentes nombrar sesiones y sugerir respuestas.' },
          },
          composer: { title: 'Compositor y envío', entrySubtitle: 'Enter para enviar, historial, apariencia del compositor y envío cuando el agente está ocupado.' },
          providerLimits: { title: 'Límites y uso del proveedor', entrySubtitle: 'Recuperación de límites de uso y medidor de uso junto al compositor.' },
          resume: { title: 'Reanudación y traspaso', entrySubtitle: 'Reanudación por repetición del transcript y opciones para mover sesiones entre máquinas.' },
          runtime: { title: 'Runtime y terminal', entrySubtitle: 'Tmux, ventanas de Windows Terminal y compatibilidad de Terminal Connect.' },
      banners: {
          title: 'Avisos',
          footer: 'Los avisos sobre el campo de mensaje pueden plegarse en una insignia de estado. Elige si se recuerda.',
          rememberVisibilityTitle: 'Recordar la visibilidad de los avisos',
          rememberVisibilitySubtitle: 'Los avisos que cierres seguirán ocultos en todas las sesiones de este dispositivo.',
          resetHiddenTitle: 'Mostrar todos los avisos ocultos',
          resetHiddenSubtitle: 'Borra los avisos ocultos en este dispositivo.',
      },
      inputBehavior: {
          title: 'Comportamiento de la entrada',
          footer: 'Configura Enviar con Intro y el comportamiento del historial de mensajes.',
          enterToSendEnabledNativeSubtitle: 'Pulsa Intro para enviar',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Modo remoto predeterminado de Windows',
          windowNameTitle: 'Nombre de la ventana de Windows Terminal',
          windowNamePlaceholder: 'happier',
          windowNameHint: 'Las sesiones abiertas en Windows Terminal usan esta ventana con nombre para que las nuevas sesiones puedan aparecer como pestañas.',
      },
      advanced: {
          title: 'Avanzado',
      },
      messageSending: {
        title: "Envío de mensajes",
        footer:
          "Controla lo que ocurre cuando envías un mensaje mientras el agente está ejecutándose.",
        queueInAgentTitle: "En cola en el agente (actual)",
        queueInAgentSubtitle:
          "Escribe en la transcripción de inmediato; el agente lo procesa cuando esté listo.",
        interruptTitle: "Interrumpir y enviar",
        interruptSubtitle: "Aborta el turno actual y envía de inmediato.",
        pendingTitle: "Pendiente hasta estar listo",
        pendingSubtitle:
          "Mantén los mensajes en una cola de pendientes; el agente los toma cuando esté listo.",
        pendingDrainModeTitle: "Procesamiento de pendientes",
        pendingDrainModeFooter:
          "Elige si el agente toma un mensaje por cada punto de disponibilidad o agrupa toda la cola pendiente.",
        pendingDrainMode: {
          oneAtATimeTitle: "Un mensaje a la vez",
          oneAtATimeSubtitle:
            "Procesa solo el siguiente mensaje pendiente cada vez que el agente queda listo.",
          drainAllTitle: "Vaciar todos los pendientes",
          drainAllSubtitle:
            "Procesa juntos todos los mensajes en cola en el próximo punto de disponibilidad (comportamiento heredado).",
        },
        pendingDeliveryTimingTitle: "Tiempo de la cola pendiente",
        pendingDeliveryTimingFooter:
          "Elige cuándo se pueden entregar los mensajes que ya están en Pendientes. Los envíos nuevos siguen usando el modo de envío de arriba.",
        pendingDeliveryTiming: {
          afterForegroundReadyTitle: "Después de la respuesta principal",
          afterForegroundReadySubtitle:
            "Entrega mensajes en cola cuando el turno principal esté listo, aunque continúe trabajo en segundo plano.",
          afterRuntimeIdleTitle: "Cuando toda la actividad esté inactiva",
          afterRuntimeIdleSubtitle:
            "Mantén los mensajes en cola hasta que el turno principal esté listo y la actividad en segundo plano esté inactiva.",
        },
        busySteerPolicyTitle: "Cuando el agente está ocupado (con dirección)",
        busySteerPolicyFooter:
          "Si el agente admite dirección en caliente, elige si los mensajes dirigen de inmediato o van primero a Pendientes.",
        busySteerPolicy: {
          steerImmediatelyTitle: "Dirigir de inmediato",
          steerImmediatelySubtitle:
            "Envía al instante y dirige el turno actual (sin interrumpir).",
          queueForReviewTitle: "Poner en Pendientes",
          queueForReviewSubtitle:
            "Pon los mensajes primero en Pendientes; envíalos después con \"Dirigir ahora\".",
        },
        nonSteerablePromptTitle: 'Cuando un mensaje no puede dirigir el turno activo',
        nonSteerablePromptFooter: 'Los cambios de modo de permisos y /clear o /compact no pueden aplicarse a mitad de turno. Elige qué hace Happier con esos mensajes mientras el agente está ocupado.',
        nonSteerablePrompt: {
            onTitle: 'Preguntar cada vez',
            onSubtitle: 'Ofrecer “Interrumpir y enviar ahora” o “Poner en cola para después del turno”.',
            offTitle: 'Desactivado (heredado)',
            offSubtitle: 'Enviar como antes aunque el cambio no pueda aplicarse a mitad de turno.',
        },
      },
      usageLimitRecovery: {
        title: "Recuperación de límites de uso",
        autoWaitTitle: "Esperar y reanudar automáticamente",
        autoWaitEnabledSubtitle: "Las sesiones con límite de uso pueden esperar el restablecimiento y reanudarse automáticamente.",
        autoWaitDisabledSubtitle: "Preguntar antes de esperar el restablecimiento de un límite de uso.",
        resumePromptTitle: "Prompt de reanudación",
        resumePromptStandardTitle: "Estándar",
        resumePromptStandardSubtitle: "Envía el prompt de continuación normal cuando la recuperación reanuda una sesión.",
        resumePromptOffTitle: "Desactivado",
        resumePromptOffSubtitle: "Reanuda sin enviar un prompt de continuación adicional.",
        resumePromptCustomTitle: "Enviar prompt personalizado",
        resumePromptCustomSubtitle: "Tras la recuperación, enviar tu propio prompt de continuación.",
        customResumePromptTitle: "Prompt de continuación personalizado",
        customResumePromptPlaceholder: "Continúa desde donde lo dejaste.",
      },
      providerUsageGauge: {
        title: "Uso del proveedor",
        footer:
          "Controla el indicador de cuota mostrado junto al compositor cuando hay uso fiable del proveedor.",
        visibilityTitle: "Mostrar indicador de uso del proveedor",
        visibilityEnabledSubtitle:
          "Muestra la cuota restante del proveedor junto al compositor cuando esté disponible.",
        visibilityHiddenSubtitle: "Oculta la cuota del proveedor en el compositor.",
        windowTitle: "Ventana del indicador",
        windowMostConstrainedTitle: "Más limitada",
        windowMostConstrainedSubtitle:
          "Muestra la ventana de cuota fiable con menos cuota restante.",
        windowDailyTitle: "Diaria",
        windowDailySubtitle: "Prefiere la ventana de cuota diaria.",
        windowWeeklyTitle: "Semanal",
        windowWeeklySubtitle: "Prefiere la ventana de cuota semanal.",
        windowSessionTitle: "Sesión",
        windowSessionSubtitle: "Prefiere la ventana de cuota de la sesión actual.",
        windowPrimaryTitle: "Primaria",
        windowPrimarySubtitle: "Prefiere la ventana de cuota primaria del proveedor.",
        windowSecondaryTitle: "Secundaria",
        windowSecondarySubtitle: "Prefiere la ventana de cuota secundaria del proveedor.",
      },
      thinking: {
        title: "Pensamiento",
        footer:
          "Controla cómo aparecen los mensajes de pensamiento del agente en la transcripción de la sesión.",
          displayModeTitle: "Visualización del pensamiento",
          displayMode: {
            inlineSummaryTitle: "En línea (resumen)",
            inlineSummarySubtitle: "Muestra un resumen de una línea; toca para expandir.",
            inlineTitle: "En línea (completo)",
            inlineSubtitle: "Muestra el mensaje de pensamiento completo directamente en la transcripción.",
            toolTitle: "Tarjeta de herramienta",
            toolSubtitle: "Muestra los mensajes de pensamiento como una tarjeta de herramienta de razonamiento.",
            hiddenTitle: "Oculto",
            hiddenSubtitle: "Oculta los mensajes de pensamiento de la transcripción.",
          },
              inlineChromeTitle: "Tarjetas de pensamiento",
              inlineChromeSubtitle: "Muestra el pensamiento en línea con un fondo de tarjeta sutil.",
        },
      toolRendering: {
        title: "Renderizado de herramientas",
          footer:
            "Controla cuántos detalles de herramientas se muestran en la línea de tiempo de la sesión. Es una preferencia de UI; no cambia el comportamiento del agente.",
          defaultToolDetailLevelTitle: "Nivel de detalle predeterminado",
          expandedToolDetailLevelTitle: "Nivel de detalle expandido",
          cardTapActionTitle: "Acción al tocar",
          timelineChrome: {
            title: "Estilo de herramientas en la línea de tiempo",
            cardsTitle: "Tarjetas",
          cardsSubtitle:
            "Tarjetas de herramientas con contenido en línea (según el nivel de detalle).",
          activityFeedTitle: "Feed de herramientas",
          activityFeedSubtitle:
            "Filas compactas optimizadas para alta densidad de herramientas.",
        },
        cardDensity: {
          title: "Densidad de tarjetas",
          comfortableTitle: "Cómodo",
          comfortableSubtitle: "Más espacio y separación más clara.",
          compactTitle: "Compacto",
          compactSubtitle: "Encabezados más ajustados y menos padding.",
        },
        activityFeed: {
          defaultDetailTitle: "Detalle predeterminado (feed de herramientas)",
          expandedDetailTitle: "Detalle expandido (feed de herramientas)",
          tapActionTitle: "Acción al tocar (feed de herramientas)",
          tapAction: {
            expandTitle: "Expandir",
            expandSubtitle: "Tocar expande o contrae detalles en línea.",
            openTitle: "Abrir",
            openSubtitle: "Tocar abre la vista completa de la herramienta.",
          },
          defaultExpandedTitle: "Expandido por defecto",
          defaultExpandedSubtitle:
            "Expandir filas por defecto en el feed de herramientas.",
        },
        localControlDefaultTitle: "Predeterminado (control local)",
        showDebugByDefaultTitle: "Mostrar depuración por defecto",
        showDebugByDefaultSubtitle:
          "Expande automáticamente las cargas útiles sin procesar en la vista completa de herramientas.",
      },
      transcript: {
        title: "Transcripción",
        entrySubtitle: "Abrir ajustes de transcripción",
        footer:
          "Personaliza cómo se muestran los chats y cómo se comporta la transcripción.",
        codeDiffs: 'Código y diffs',
        codeDiffsFooter: 'Configura cómo se muestra el código y el contenido de diff en la transcripción.',
        layoutTitle: "Diseño",
        layoutFooter:
          "Elige entre una transcripción lineal y el agrupamiento por turnos.",
        layoutPickerTitle: "Diseño de transcripción",
        messageTimestampsTitle: "Mostrar hora y fecha debajo de los mensajes",
        messageTimestampsSubtitle:
          "Muestra la marca de tiempo de cada mensaje de usuario y asistente debajo del mensaje.",
        messageTimestamps: {
          hoverWebHiddenMobileTitle: "Al pasar el cursor en web, oculto en móvil",
          hoverWebHiddenMobileSubtitle:
            "Muestra marcas de tiempo con las acciones del mensaje en web y ocúltalas en móvil.",
          hoverWebAlwaysMobileTitle: "Al pasar el cursor en web, siempre en móvil",
          hoverWebAlwaysMobileSubtitle:
            "Muestra marcas de tiempo con las acciones del mensaje en web y mantenlas visibles en móvil.",
          alwaysTitle: "Siempre visible",
          alwaysSubtitle: "Muestra siempre marcas de tiempo debajo de los mensajes de la transcripción.",
          neverTitle: "Nunca",
          neverSubtitle: "Oculta marcas de tiempo debajo de los mensajes de la transcripción.",
        },
        messageActions: {
          groupTitle: 'Acciones de mensajes',
          groupFooter: 'Configura la selección de mensajes y las acciones de reenvío en la transcripción.',
          selectionEnabled: {
            title: 'Activar selección de mensajes',
            subtitle: 'Mostrar un icono de selección bajo los mensajes para copiarlos o reenviarlos en bloque',
          },
          sendToSessionEnabled: {
            title: 'Activar Enviar a sesión',
            subtitle: 'Mostrar una acción de envío en bloque que añade los mensajes seleccionados al borrador de otra sesión',
          },
          template: {
            title: 'Plantilla para enviar a sesión',
            subtitle: 'Usa {{MESSAGES}}, {{SELECTED_COUNT}} y {{SOURCE_SESSION_NAME}} como marcadores de posición',
            placeholder: '{{MESSAGES}}',
            warningMissingPlaceholder: 'Consejo: añade {{MESSAGES}} para controlar dónde aparecen los mensajes seleccionados',
          },
          bulkCopyFormat: {
            title: 'Formato de copia',
            subtitle: 'Cómo formatear los mensajes copiados',
            markdownLabeled: 'Markdown con etiquetas de rol (recomendado)',
            plain: 'Texto sin formato',
          },
        },
        layout: {
          linearTitle: "Lineal",
          linearSubtitle: "Muestra los mensajes como una lista plana.",
          turnsTitle: "Turnos",
          turnsSubtitle: "Agrupa mensajes en turnos usuario/asistente.",
        },
        toolCallsGroupTitle: "Agrupar llamadas de herramientas",
        toolCallsGroupSubtitle:
          "Compacta llamadas de herramientas en una sección de llamadas de herramientas dentro de cada turno.",
        toolCallsGroupBackgroundTitle: "Fondo del grupo de llamadas",
        toolCallsGroupBackgroundSubtitle:
          "Muestra un fondo detrás de los grupos de llamadas en el modo de feed de herramientas.",
        toolAppearanceTitle: "Apariencia de herramientas",
        toolAppearanceSubtitle:
          "Personaliza cómo se ven las herramientas en la transcripción.",
        motionTitle: "Movimiento",
        motionFooter: "Controla las animaciones en la transcripción.",
        motionPickerTitle: "Animaciones",
        motion: {
          offTitle: "Desactivado",
          offSubtitle: "Desactiva animaciones de la transcripción.",
          subtleTitle: "Sutil (predeterminado)",
          subtleSubtitle: "Movimiento mínimo y rápido para actividad nueva.",
          fullTitle: "Completo",
          fullSubtitle: "Movimiento y transiciones más expresivos.",
        },
        advancedMotionTitle: "Movimiento avanzado…",
        advancedMotionSubtitle:
          "Ajusta ventana de frescura y toggles de animación.",
        scrollTitle: "Desplazamiento",
        scrollFooter: "Controla el anclaje y el salto al final.",
        scrollPinTitle: "Anclar al final",
          scrollPinSubtitle:
            "Seguir mensajes nuevos mientras estás al final.",
          jumpToBottomTitle: "Ir al final",
          jumpToBottomButtonLabel: "Ir al final",
          jumpToBottomButtonNewActivityLabel: ({ count }: { count: number }) => `${count} ${count === 1 ? "elemento nuevo de actividad" : "elementos nuevos de actividad"}, ir al final`,
            jumpToBottomSubtitle:
              "Mostrar un botón cuando subes y llega actividad nueva.",
            advancedScrollTitle: "Desplazamiento avanzado…",
          advancedScrollSubtitle: "Ajusta umbrales y contadores.",
          advancedTitle: "Avanzado…",
          advancedSubtitle: "Controles de rendimiento y depuración.",
          advanced: {
            turnGroupingTitle: "Agrupación por turnos",
            turnGroupingFooter:
            "Controla cómo se forman los grupos de llamadas de herramientas dentro de los turnos.",
            performanceTitle: "Rendimiento",
            performanceFooter: "Controles de rendimiento para streaming y listas.",
            coalesceEnabledTitle: "Agrupar actualizaciones en streaming",
            coalesceEnabledSubtitle:
              "Agrupa actualizaciones del socket para mantener el desplazamiento fluido.",
            coalesceWindowTitle: "Ventana de agrupación",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `Actual: ${value}ms`,
            coalesceWindowPromptTitle: "Ventana de agrupación (ms)",
            coalesceWindowPromptBody:
              "Define cada cuánto se aplican al store las actualizaciones agrupadas.",
            coalesceMaxBatchTitle: "Tamaño máximo del lote",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `Actual: ${value}`,
            coalesceMaxBatchPromptTitle: "Tamaño máximo del lote",
            coalesceMaxBatchPromptBody:
              "Define un límite superior de mensajes aplicados en una sola pasada.",
            streamingPartialOutputTitle: "Mostrar salida parcial en streaming",
            streamingPartialOutputSubtitle:
              "Cuando está desactivado, los mensajes del asistente aparecen solo al finalizar.",
            thinkingPulseStaleTitle: "Ventana de caducidad del pensamiento",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Actual: ${value}ms`,
            thinkingPulseStalePromptTitle: "Ventana de caducidad del pensamiento (ms)",
            thinkingPulseStalePromptBody:
              "Oculta el pensamiento activo tras este tiempo sin actualizaciones.",
          toolCallsStrategyTitle: "Estrategia de agrupación de llamadas",
          toolCallsStrategy: {
            consecutiveTitle: "Herramientas consecutivas (predeterminado)",
            consecutiveSubtitle:
              "Agrupa solo llamadas consecutivas en llamadas de herramientas.",
            allToolsTitle: "Todas las herramientas del turno",
            allToolsSubtitle:
              "Agrupa todas las herramientas del turno en una sola sección de llamadas de herramientas.",
          },
            toolCallsCollapsedPreviewCountTitle: "Vista previa (colapsado)",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Muestra las últimas ${value} herramientas cuando Llamadas de herramientas está colapsado.`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "Desactivado",
              offSubtitle: "Muestra solo el encabezado de llamadas de herramientas.",
              oneTitle: "1 herramienta",
              oneSubtitle: "Muestra la herramienta más reciente como fila de vista previa.",
              twoTitle: "2 herramientas",
              twoSubtitle: "Muestra las 2 herramientas más recientes como filas de vista previa.",
              threeTitle: "3 herramientas",
              threeSubtitle: "Muestra las 3 herramientas más recientes como filas de vista previa.",
              countTitle: ({ value }: { value: string }) => `${value} herramientas`,
              countSubtitle: ({ value }: { value: string }) =>
                `Muestra las ${value} herramientas más recientes como filas de vista previa.`,
            },
          motionTitle: "Movimiento (avanzado)",
          motionFooter:
            "Las animaciones están limitadas por frescura para mantener estable el historial.",
          freshnessTitle: "Ventana de frescura",
          freshnessSubtitle: ({ value }: { value: string }) => `Actual: ${value}ms`,
          freshnessPromptTitle: "Ventana de frescura (ms)",
          freshnessPromptBody:
            "Define cuánto tiempo los elementos nuevos se consideran “frescos” para animaciones.",
          animateNewItemsTitle: "Animar elementos nuevos",
          animateNewItemsSubtitle:
            "Animar mensajes y herramientas que llegan en streaming.",
          animateToolExpandCollapseTitle:
            "Animar expandir/contraer herramientas",
          animateToolExpandCollapseSubtitle:
            "Animar las transiciones de expandir/contraer en línea.",
          animateToolExpandCollapseFreshOnlyTitle:
            "Expandir/contraer solo frescos",
          animateToolExpandCollapseFreshOnlySubtitle:
            "Animar expandir/contraer solo para herramientas frescas.",
          animateThinkingTitle: "Animar pensamiento",
          animateThinkingSubtitle:
            "Animar mensajes de pensamiento en streaming cuando sean visibles.",
          scrollTitle: "Desplazamiento (avanzado)",
          scrollFooter:
            "Ajusta umbrales de anclaje y comportamiento del salto.",
          pinOffsetTitle: "Umbral de offset anclado",
          pinOffsetSubtitle: ({ value }: { value: string }) => `Actual: ${value}px`,
          pinOffsetPromptTitle: "Umbral de offset anclado (px)",
          pinOffsetPromptBody:
            "Define qué distancia del final cuenta como anclado.",
          autoFollowTitle: "Auto-seguir mientras está anclado",
          autoFollowSubtitle:
            "Cuando está anclado, seguir actividad nueva automáticamente.",
          jumpMinNewCountTitle: "Mínimo de nuevos para el botón",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `Actual: ${value}`,
          jumpMinNewCountPromptTitle: "Mínimo de nuevos (botón)",
          jumpMinNewCountPromptBody:
            "Mostrar el botón de ir al final solo después de este número de elementos nuevos.",
          jumpAnimateScrollTitle: "Animar salto al final",
          jumpAnimateScrollSubtitle:
            "Animar el desplazamiento al ir al final.",
        },
      },
        toolDetailOverrides: {
          title: "Anulaciones del detalle de herramientas",
          entrySubtitle: "Sobrescribir herramientas individuales",
          footer:
            "Sobrescribe el nivel de detalle para herramientas específicas. Las anulaciones se aplican al nombre canónico (V2), tras la normalización heredada.",
          expandedTitle: "Anulaciones de detalle expandido",
          expandedFooter: "Sobrescribe el nivel de detalle expandido para herramientas específicas.",
        },
      permissions: {
        title: "Permisos",
        entrySubtitle: "Abrir ajustes de permisos",
        footer:
          "Configura los permisos predeterminados y cómo se aplican los cambios a las sesiones en curso.",
        promptSurfaceTitle: "Solicitudes de permisos",
        promptSurfaceFooter:
          "Elige dónde aparecen las solicitudes de aprobación durante una sesión.",
        applyChangesFooter:
          "Elige cuándo los cambios de permisos surten efecto en las sesiones en curso.",
        backendFooter:
          "Establece el modo de permisos predeterminado al iniciar sesiones con este backend.",
        defaultPermissionModeTitle: "Modo de permisos predeterminado",
        promptSurface: {
          composerTitle: "Cerca del compositor (recomendado)",
          composerSubtitle: "Mostrar tarjetas ricas cerca del input.",
          transcriptTitle: "En la transcripción",
          transcriptSubtitle:
            "Mostrar solicitudes de permisos dentro de mensajes de herramientas.",
          bothTitle: "Ambos",
          bothSubtitle:
            "Mostrar solicitudes cerca del compositor y dentro de la transcripción.",
        },
        applyTiming: {
          immediateTitle: "Aplicar de inmediato",
          nextPromptTitle: "Aplicar en el próximo mensaje",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "Abrir ajustes de subagente",
      },
      replayResume: {
        title: "Reanudar con reproducción",
        footer:
          "Cuando la reanudación del proveedor no está disponible, opcionalmente reproduce mensajes recientes de la transcripción en una nueva sesión como contexto.",
        enabledTitle: "Habilitar reanudación con reproducción",
        enabledSubtitleOn:
          "Ofrece reanudación basada en reproducción cuando la reanudación del proveedor no esté disponible.",
        enabledSubtitleOff: "No ofrezcas reanudación basada en reproducción.",
        strategyTitle: "Estrategia de reproducción",
        strategy: {
          recentTitle: "Mensajes recientes",
          recentSubtitle: "Usa solo los mensajes más recientes de la transcripción.",
          summaryRecentTitle: "Resumen + recientes (experimental)",
          summaryRecentSubtitle:
            "Incluye un resumen breve y mensajes recientes (mejor esfuerzo).",
        },
        summaryRunner: {
          title: "Generador de resúmenes (a demanda)",
          backendTitle: "Motor",
          backendPlaceholder: "claude (ej.)",
          searchBackendsPlaceholder: "Buscar backends…",
          modelTitle: "Modelo (LLM)",
          modelPlaceholder: "default (ej.)",
          searchModelsPlaceholder: "Buscar modelos…",
          notSet: "No configurado",
          customTitle: "Personalizado",
          customBackendIdSubtitle: "Introduce un id de backend (p. ej. claude).",
          customModelIdSubtitle: "Introduce un id de modelo (p. ej. default).",
          requiresModelNotice: "Elige abajo un modelo de resumen. Sin él, la reproducción vuelve solo a los mensajes recientes.",
          requiresExecutionRunsNotice: "Los resúmenes necesitan ejecuciones, que están desactivadas en esta cuenta. La reproducción usará solo los mensajes recientes.",
        },
        recentMessagesTitle: "Mensajes recientes a incluir",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Límite del seed (caracteres)",
        maxSeedCharsPlaceholder: "50000",
        maxSeedCharsRange: ({ min, max }: { min: number; max: number }) => `Entre ${min} y ${max} caracteres. Un número fuera de este rango se guarda como el límite más cercano.`,
      },
      handoff: settingsSessionHandoffTranslationExtensions.es,
      sessionCreation: {
        title: "Modal de nueva sesión",
        footer: "Elige cómo se abre el modal de nueva sesión y cómo lo preparan los atajos de proyecto.",
        modalModeTitle: "Modo del modal de nueva sesión",
        modalModeSimpleTitle: "Sencillo",
        modalModeSimpleSubtitle: "Abre el modal compacto centrado en el compositor.",
        modalModeWizardTitle: "Asistente",
        modalModeWizardSubtitle: "Abre la configuración guiada con selectores separados.",
        presentationGroupTitle: "Superficie de nueva sesión",
        presentationGroupFooter: "Elige si Nueva sesión se abre como una pantalla enrutada o como un modal.",
        presentationModeTitle: "Presentación de nueva sesión",
        presentationModeSubtitle: "Controla la ruta usada al abrir Nueva sesión.",
        presentationAutoTitle: "Automático",
        presentationAutoSubtitle: "Usa la presentación modal predeterminada en cada plataforma.",
        presentationScreenTitle: "Pantalla",
        presentationScreenSubtitle: "Abre Nueva sesión en el área principal con el compositor anclado abajo.",
        presentationModalTitle: "Ventana modal",
        presentationModalSubtitle: "Abre Nueva sesión sobre el espacio de trabajo actual como un modal descartable.",
        wizardModeTitle: "Modo asistente",
        wizardModeEnabledSubtitle: "Abre la configuración guiada con selectores separados.",
        wizardModeDisabledSubtitle: "Usa el modal compacto centrado en el compositor.",
        rememberLastProjectSelectionsTitle: "Recordar las últimas selecciones de sesión del proyecto",
        rememberLastProjectSelectionsEnabledSubtitle:
          "Los atajos de proyecto reutilizan la máquina, la carpeta, el motor, el modelo y las opciones de la sesión más reciente.",
        rememberLastProjectSelectionsDisabledSubtitle:
          "Los atajos de proyecto solo preseleccionan la máquina y la carpeta del proyecto.",
        rememberLastEngineSelectionsTitle: "Recordar el último modelo y opciones de cada motor",
        rememberLastEngineSelectionsEnabledSubtitle:
          "Las nuevas sesiones restauran el último modelo, modo y opciones de motor que seleccionaste en esta cuenta.",
        rememberLastEngineSelectionsDisabledSubtitle:
          "Las nuevas sesiones usan los valores predeterminados salvo que un atajo de proyecto o borrador indique una configuración.",
        wizardSettingsTitle: "Asistente de nueva sesión",
        wizardSettingsSubtitle: "Elige si cada selector del asistente aparece como lista o desplegable.",
        wizardDispositionTitle: "Disposición del asistente",
        wizardDispositionSubtitle: "Elige qué selectores del asistente aparecen como listas o desplegables.",
        wizardLayoutTitle: "Diseño del asistente",
        wizardLayoutFooter: "Controla cómo se organizan las secciones del asistente en pantallas anchas.",
        wizardColumnsTitle: "Diseño en dos columnas",
        wizardColumnsEnabledSubtitle: "Coloca selectores relacionados uno al lado del otro en pantallas anchas.",
        wizardColumnsDisabledSubtitle: "Apila todos los selectores del asistente en una columna.",
        wizardPresentationTitle: "Diseño de selectores del asistente",
        wizardPresentationFooter:
          "Auto mantiene las secciones cortas como listas y cambia las largas a desplegables con búsqueda.",
        wizardPresentationAutoTitle: "Automático",
        wizardPresentationAutoSubtitle:
          "Deja que Happier elija el mejor diseño según la cantidad de contenido.",
        wizardPresentationListTitle: "Lista",
        wizardPresentationListSubtitle: "Muestra todas las filas directamente en el asistente.",
        wizardPresentationDropdownTitle: "Desplegable",
        wizardPresentationDropdownSubtitle: "Muestra una fila compacta que abre el selector completo.",
      },
          promptPersonalization: {
              title: 'Personalización inmediata',
              footer: 'Elija qué instrucciones integradas Happier agrega a las nuevas sesiones del agente. Esto no oculta las opciones que ya envía un agente.',
              askAgentToRenameSessionsTitle: 'Actualizaciones del título de la sesión',
              askAgentToRenameSessionsNeverTitle: 'nunca',
              askAgentToRenameSessionsNeverSubtitle: 'No solicite a los agentes que establezcan títulos de sesión.',
              askAgentToRenameSessionsInitialTitle: 'Al inicio de la sesión',
              askAgentToRenameSessionsInitialSubtitle: 'Solicite a los agentes que establezcan un título breve para el primer mensaje de usuario.',
              askAgentToRenameSessionsOngoingTitle: 'Cuando la tarea cambia',
              askAgentToRenameSessionsOngoingSubtitle: 'Solicite a los agentes que establezcan títulos al inicio de la sesión y cuando cambie la tarea.',
              askAgentToRenameSessionsInitialSelectedSubtitle: 'A los agentes se les solicita que establezcan un título al inicio de la sesión.',
              askAgentToRenameSessionsOngoingSelectedSubtitle: 'A los agentes se les solicita que actualicen los títulos cuando cambia la tarea.',
              askAgentToRenameSessionsDisabledSubtitle: 'A los agentes no se les solicita que establezcan títulos; El cambio de nombre manual todavía funciona.',
              askAgentToSuggestReplyOptionsTitle: 'Pídale al agente que sugiera opciones de respuesta',
              askAgentToSuggestReplyOptionsEnabledSubtitle: 'El mensaje solicita a los agentes que propongan opciones de respuesta rápida cuando sea útil.',
              askAgentToSuggestReplyOptionsDisabledSubtitle: 'El mensaje no solicita a los agentes que agreguen opciones de respuesta rápida.',
          },
      defaultPermissions: {
        title: "Permisos predeterminados",
        footer:
          "Se aplica al iniciar una nueva sesión. Los perfiles pueden anularlo opcionalmente.",
        applyPermissionChangesTitle: "Aplicar cambios de permisos",
        applyPermissionChangesImmediateSubtitle:
          "Aplicar de inmediato a las sesiones en curso (actualiza los metadatos de la sesión).",
        applyPermissionChangesNextPromptSubtitle: "Aplicar solo en el próximo mensaje.",
      },
          defaultStorage: {
              title: 'Tipo de sesión predeterminado',
              footer: 'Elige si las nuevas sesiones comienzan como sesiones de Happier o como sesiones directas respaldadas por el proveedor.',
              globalTitle: 'Predeterminado global',
              persistedSubtitle: 'Guarda las nuevas sesiones en Happier y sincronízalas entre dispositivos de forma predeterminada.',
              directSubtitle: 'Inicia sesiones directas vinculadas a la máquina cuando el proveedor lo admita.',
              globalSubtitle: ({ label }: { label: string }) => `Predeterminado global: ${label}`,
              useGlobalDefault: 'Usar el predeterminado global',
              currently: ({ label }: { label: string }) => `Actualmente: ${label}`,
          },
      toolDetailLevel: {
        titleOnlyTitle: "Solo título",
        titleOnlySubtitle:
          "Muestra solo el nombre de la herramienta en la línea de tiempo (sin subtítulo, sin cuerpo).",
        compactTitle: "Compacto",
        compactSubtitle: "Muestra el nombre de la herramienta + un subtítulo corto en la misma línea (sin cuerpo).",
        summaryTitle: "Resumen",
        summarySubtitle: "Muestra un resumen compacto y seguro en la línea de tiempo.",
        fullTitle: "Completo",
        fullSubtitle: "Muestra todos los detalles en línea en la línea de tiempo.",
        defaultTitle: "Predeterminado",
        defaultSubtitle: "Usa el valor predeterminado global.",
          styleDefaultTitle: "Predeterminado (recomendado)",
          styleDefaultSubtitle: "Tarjetas: Resumen. Feed de herramientas: Compacto.",
          expandedStyleDefaultTitle: "Predeterminado (recomendado)",
          expandedStyleDefaultSubtitle: "Tarjetas: Completo. Feed de herramientas: Resumen.",
      },
      terminalConnect: {
        title: "Conexión del terminal",
        legacySecretExportTitle: "Exportación de secreto heredada (compatibilidad)",
        legacySecretExportEnabledSubtitle:
          "Activado: exporta el secreto heredado de tu cuenta al terminal para que terminales antiguos puedan conectarse. No recomendado.",
        legacySecretExportDisabledSubtitle:
          "Desactivado (recomendado): aprovisiona terminales solo con la clave de contenido (Terminal Connect V2).",
      },
  },
  windowsRemoteSessionLaunchMode: {
    hidden: "Oculto",
    shortHidden: "Oculto",
    hiddenSubtitle: "Inicia la sesión en segundo plano sin abrir una ventana de terminal.",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "Abre la sesión como una pestaña en la ventana compartida de Windows Terminal.",
    console: "Consola",
    shortConsole: "Consola",
    consoleSubtitle: "Abre la sesión en una ventana estándar de consola de Windows.",
  },
  settingsVoice: {
    ...voiceDiagnosticsTranslations.es,
    intents: {
      dictation: { title: 'Dictado', subtitle: 'Convierte una frase hablada en texto del cuadro de redacción.' },
      conversations: { title: 'Conversaciones por voz', subtitle: 'Elige un proveedor y configura sus ajustes principales.' },
      privacy: { title: 'Privacidad y datos', subtitle: 'Revisa el procesamiento del proveedor, el contexto compartido y el historial de voz.', processingTitle: 'Procesamiento del proveedor' },
      advanced: { title: 'Avanzado', subtitle: 'Configura la interfaz de voz, la máquina de ejecución y los diagnósticos.' },
    },
    history: {
      title: 'Historial de voz',
      sectionTitle: 'Historial',
      sectionFooter: 'Revisa o elimina transcripciones de conversaciones de voz globales y sin destino.',
      entryTitle: 'Historial de voz',
      entrySubtitle: 'Busca, exporta o borra transcripciones de voz guardadas.',
      searchTitle: 'Buscar en el historial cargado',
      searchFooter: 'La búsqueda usa los mensajes de voz ya descifrados en este dispositivo.',
      searchPlaceholder: 'Buscar transcripciones o proveedores',
      searchAccessibilityLabel: 'Buscar en el historial de voz',
      actionsTitle: 'Acciones del historial',
      loading: 'Cargando el historial de voz…',
      emptyTitle: 'Aún no hay historial de voz',
      emptyBody: 'Las transcripciones de voz globales e independientes aparecerán aquí cuando se guarden.',
      noResultsTitle: 'No hay coincidencias en el historial cargado',
      noResultsBody: 'Prueba otra búsqueda o carga mensajes más antiguos.',
      loadOlderTitle: 'Cargar mensajes anteriores',
      loadOlderSubtitle: 'Descifra la página anterior del historial de voz en este dispositivo.',
      loadOlderFooter: 'Los mensajes antiguos permanecen en el servidor hasta que los cargues o borres.',
      loadingOlder: 'Cargando mensajes anteriores…',
      loadOlderFailed: 'No se pudo cargar el historial de voz anterior.',
      exportTitle: 'Exportar historial de voz',
      exportSubtitle: 'Carga el historial restante y guárdalo como JSON.',
      exporting: 'Preparando la exportación…',
      exportSucceeded: 'La exportación del historial de voz está lista.',
      exportFailed: 'No se pudo exportar el historial de voz.',
      clearTitle: 'Borrar historial de voz',
      clearSubtitle: 'Elimina todo el historial de voz independiente de esta cuenta.',
      clearing: 'Borrando el historial de voz…',
      clearConfirmTitle: '¿Borrar el historial de voz?',
      clearConfirmBody: 'Esto elimina permanentemente todo el historial de voz independiente de esta cuenta. No se puede deshacer.',
      clearConfirmAction: 'Borrar historial',
      clearSucceeded: 'Se borró el historial de voz.',
      clearActiveCall: 'Finaliza la conversación por voz antes de borrar el historial de voz.',
      clearFailed: 'No se pudo borrar el historial de voz.',
      errorTitle: 'El historial de voz no está disponible',
      errorBody: 'Happier no pudo cargar el historial cifrado de esta cuenta. Comprueba la conexión e inténtalo de nuevo.',
      upgradeRequiredTitle: 'Se requiere una actualización para cargar el historial de voz',
      upgradeRequiredBody: 'Este servidor no admite el formato de historial cifrado que usa esta cuenta. Actualiza Happier en el servidor y vuelve a cargar.',
      supersededTitle: 'La cuenta activa cambió',
      supersededBody: 'Esta solicitud se detuvo antes de poder usar otra cuenta. Vuelve a cargar para continuar de forma segura.',
      retry: 'Reintentar',
      roleYou: 'Tú',
      roleAssistant: 'Asistente',
    },
    dictation: {
      title: 'Dictado',
      footer: 'Elige el proveedor de voz a texto del micrófono del editor. Es independiente de la voz conversacional salvo que los vincules explícitamente.',
      provider: 'Proveedor de voz a texto',
      providerSubtitle: 'Elige un proveedor propio para Dictado o sigue explícitamente la Voz local.',
      sameAsLocal: 'Igual que Voz local',
      sameAsLocalSubtitle: 'Seguir explícitamente la selección de voz a texto de Voz local.',
      language: 'Idioma del dictado',
      languageSubtitle: 'Indicación de idioma opcional usada solo para Dictado.',
      readiness: {
        title: 'Preparación del dictado',
        footer: 'La comprobación solo lee la configuración guardada y el estado actual de la máquina y el modelo. No abre el micrófono, no envía audio ni contacta con un proveedor.',
        check: 'Comprobar configuración',
        checkSubtitle: 'Verificar pasivamente la configuración de Dictado seleccionada.',
        result: 'Estado de configuración',
        ready: 'Listo para Dictado.',
        needsSetup: 'La configuración está incompleta. Revisa los detalles del proveedor seleccionado.',
        installing: 'Aún se está instalando un modelo de voz necesario.',
        incompatible: 'El proveedor seleccionado no es compatible con esta plataforma o configuración.',
        unavailable: 'No se pudo confirmar la preparación con los datos locales actuales.',
      },
    },
    setupCheck: {
      title: 'Preparación del proveedor',
      footer: 'La comprobación solo lee la configuración guardada y los datos locales de preparación. No abre el micrófono, no inicia Voz, no envía audio ni contacta con el proveedor.',
      check: 'Comprobar configuración',
      checkSubtitle: 'Revisar pasivamente la configuración del proveedor de Voz seleccionado.',
      result: 'Estado de configuración',
    },
    // Voice settings screen
    modeTitle: "Voz",
    modeDescription:
      "Configura las funciones de voz. Puedes desactivar la voz por completo, usar Happier Voice (requiere suscripción) o usar tu propia cuenta de ElevenLabs.",
    mode: {
      off: "Desactivado",
      offSubtitle: "Desactivar todas las funciones de voz",
      happier: "Happier Voice",
      happierSubtitle: "Usar Happier Voice (requiere suscripción)",
      local: "Voz local OSS",
      localSubtitle: "Usar endpoints STT/TTS locales compatibles con OpenAI",
      byo: "Usar mi ElevenLabs",
      byoSubtitle: "Usar tu propia clave API y agente de ElevenLabs",
      openaiRealtime: "OpenAI Realtime",
      openaiRealtimeSubtitle: "Usa una clave API guardada o una cuenta de OpenAI seleccionada explícitamente",
      grokRealtime: "Grok Voice · BYOK",
      grokRealtimeSubtitle: "Usa tu propia clave API de xAI para la voz en directo",
    },
    realtimeProviders: {
      ...voiceProviderPrivacyTranslations.es,
      ...voiceRealtimeProviderSetupTranslations.es,
      operationFailed: 'No se pudo actualizar el ajuste. Inténtalo de nuevo.',
      operationFailedUnsaved: 'No se pudo actualizar el ajuste. Tus cambios no se guardaron.',
      operationFailedVoiceNotFound: 'La voz seleccionada no está disponible en la cuenta conectada. Elige otra voz y vuelve a ejecutar esta acción. Tus cambios no se guardaron.',
      operationFailedStage: ({ stage }: { stage: string }) => `Paso fallido: ${stage}`,
      operationFailedStatus: ({ status }: { status: number }) => `Respuesta del proveedor: HTTP ${status}`,
      codex: {
        sectionTitle: "Cuenta de Codex Live",
        accountTitle: "Cuenta global de Voz",
        accountSubtitle: "Elige la cuenta o el grupo de cuentas exacto de Servicios conectados que usará Codex Voice global. La Voz directa siempre usa la sesión abierta.",
        privacyDisclosure: "El audio y la conversación de Codex Live se envían desde este dispositivo a OpenAI mediante WebRTC. La sesión de Codex y la cuenta de Servicios conectados seleccionadas se ejecutan mediante la máquina seleccionada. OpenAI puede recibir contexto de inicio y de sesión acotado y resultados delegados de Codex para que la conversación continúe y las respuestas puedan pronunciarse. El servidor y el relay de Happier no transportan el audio de Codex Live; el daemon/app-server de Happier sí gestiona la señalización, el ciclo de vida de la sesión, la delegación, las herramientas y el control de permisos. Pueden intervenir relays de red operados por el proveedor. Codex u OpenAI pueden conservar instrucciones de desarrollador, material de la conversación en tiempo real y diagnósticos relacionados en almacenamiento nativo del proveedor según las políticas de la cuenta y del proveedor seleccionados; Happier no elimina ni reescribe esos datos del proveedor.",
      },
    },
    ui: {
      title: "Superficie de voz",
      footer: "Feed opcional en pantalla de eventos de voz (no se escribe en la sesion).",
      activityFeedEnabled: "Habilitar feed de actividad de voz",
      activityFeedEnabledSubtitle: "Mostrar eventos recientes de voz en pantalla",
      activityFeedAutoExpandOnStart: "Expandir automaticamente al iniciar",
      activityFeedAutoExpandOnStartSubtitle: "Expandir el feed automaticamente cuando inicia la voz",
      orbEnabled: "Orbe de voz flotante",
      orbEnabledSubtitle: "Muestra el companero de voz arrastrable en este dispositivo. La voz sigue disponible desde la barra lateral y el redactor.",
      scopeTitle: "Ambito predeterminado de voz",
      scopeSubtitle: "Elige si la voz es global (cuenta) o por sesion por defecto.",
      scopeGlobal: "Global (cuenta)",
      scopeGlobalSubtitle: "La voz sigue visible mientras navegas",
      scopeSession: "Sesion",
      scopeSessionSubtitle: "La voz se controla desde la sesion donde se inicio",
      surfaceLocationTitle: "Ubicación",
      surfaceLocationSubtitle: "Elige dónde aparece la superficie de voz.",
      surfaceLocation: {
        autoTitle: "Automático",
        autoSubtitle: "Ámbito global en la barra lateral; ámbito de sesión en la sesión.",
        sidebarTitle: "Barra lateral",
        sidebarSubtitle: "Mostrar en la barra lateral.",
        sessionTitle: "Sesión",
        sessionSubtitle: "Mostrar encima del input en la sesión.",
      },
      updates: {
        title: "Actualizaciones de sesión",
        footer: "Controla qué recibe el asistente de voz como contexto.",
        activeSessionTitle: "Sesión objetivo activa",
        activeSessionSubtitle: "Qué enviar automáticamente para la sesión objetivo.",
        otherSessionsTitle: "Otras sesiones",
        otherSessionsSubtitle: "Qué enviar automáticamente para sesiones no objetivo.",
        level: {
          noneTitle: "Ninguna",
          noneSubtitle: "No enviar actualizaciones automáticas.",
          activityTitle: "Solo actividad",
          activitySubtitle: "Solo contadores y marcas de tiempo.",
          summariesTitle: "Resúmenes",
          summariesSubtitle: "Resúmenes cortos (sin texto de mensajes).",
          snippetsTitle: "Fragmentos",
          snippetsSubtitle: "Fragmentos cortos de mensajes (riesgo de privacidad).",
        },
        snippetsMaxMessagesTitle: "Máx. mensajes en fragmentos",
        snippetsMaxMessagesSubtitle: "Limita cuántos mensajes se incluyen por actualización.",
        includeUserMessagesInSnippetsTitle: "Incluir tus mensajes",
        includeUserMessagesInSnippetsSubtitle: "Si está activado, los fragmentos pueden incluir tus mensajes.",
        otherSessionsSnippetsModeTitle: "Fragmentos de otras sesiones",
        otherSessionsSnippetsModeSubtitle: "Controla cuándo se permiten fragmentos de otras sesiones.",
        otherSessionsSnippetsMode: {
          neverTitle: "Nunca",
          neverSubtitle: "Deshabilitar fragmentos para otras sesiones.",
          onDemandTitle: "Bajo demanda",
          onDemandSubtitle: "Permitir solo cuando el usuario lo pida.",
          autoTitle: "Automático",
          autoSubtitle: "Permitir fragmentos automáticos (ruidoso).",
        },
      },
    },
    byo: {
      title: "Usar mi ElevenLabs",
	      agentReuseDialog: {
	        title: "El agente de Happier ya existe",
	        messageWithId: ({ name, id }: { name: string; id: string }) =>
	          `Encontramos un agente de ElevenLabs existente (“${name}”, id: ${id}).\n\n¿Quieres actualizarlo o crear uno nuevo?`,
	        messageNoId: ({ name }: { name: string }) =>
	          `Encontramos un agente de ElevenLabs existente (“${name}”).\n\n¿Quieres actualizarlo o crear uno nuevo?`,
	        actions: {
	          createNew: "Crear nuevo",
	          updateExisting: "Actualizar existente",
	        },
	      },
      configured:
        "Configurado. El uso de voz se facturará a tu cuenta de ElevenLabs.",
      notConfigured:
        "Introduce tu clave API de ElevenLabs y el ID del Agente para usar voz sin una suscripción.",
      createAccount: "Crear cuenta de ElevenLabs",
      createAccountSubtitle:
        "Regístrate (o inicia sesión) antes de crear una clave API",
      openApiKeys: "Abrir claves API de ElevenLabs",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "Cómo crear una clave API",
      apiKeyHelpSubtitle:
        "Ayuda paso a paso para crear y copiar tu clave API de ElevenLabs",
      apiKeyHelpDialogTitle: "Crear una clave API de ElevenLabs",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Crear agente Happier",
      autoprovCreateSubtitle:
        "Crea y configura un agente Happier en tu cuenta de ElevenLabs usando tu clave API",
      autoprovUpdate: "Actualizar agente",
      autoprovUpdateSubtitle:
        "Actualiza tu agente al último template de Happier",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `Agente creado: ${agentId}`,
      autoprovUpdated: "Agente actualizado",
      autoprovFailed:
        "No se pudo crear/actualizar el agente. Inténtalo de nuevo.",
      agentId: "ID del agente",
      agentIdSet: "Establecido",
      agentIdNotSet: "No establecido",
      agentIdTitle: "ID del Agente de ElevenLabs",
      agentIdDescription:
        "Introduce el ID del Agente desde tu panel de ElevenLabs.",
      agentIdPlaceholder: "agent_...",
      apiKey: "Clave API",
      apiKeySet: "Establecida",
      apiKeyNotSet: "No establecida",
      apiKeyTitle: "Clave API de ElevenLabs",
      apiKeyDescription:
        "Introduce tu clave API de ElevenLabs. Se almacena cifrada en el dispositivo.",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "Buscar voces",
      voiceGroupTitle: "Voz",
      voiceGroupFooter:
        "Elige cómo habla tu agente de ElevenLabs. Los cambios se aplican cuando actualizas el agente.",
      provisioningGroupTitle: "Aprovisionamiento del agente",
      provisioningGroupFooter:
        "Si cambias voz/ajustes, toca Actualizar agente para aplicarlo en ElevenLabs.",
      realtime: {
        call: {
          title: "Llamada",
          welcome: {
            title: "Mensaje de bienvenida",
            subtitle: "Saludo opcional al inicio de la llamada.",
            detail: {
              off: "Desactivado",
              immediate: "Inmediato",
              onFirstTurn: "En el primer turno",
            },
            options: {
              offSubtitle: "Sin saludo.",
              immediateSubtitle:
                "Saluda en cuanto se conecte la llamada.",
              onFirstTurnSubtitle:
                "Saluda al inicio de la primera respuesta.",
            },
          },
        },
        voicePicker: {
          title: "Voz",
          subtitle: "Elige la voz de ElevenLabs que se usa en las respuestas.",
          missingApiKeyTitle: "Añade una clave API para cargar voces",
          loadingTitle: "Cargando voces…",
          errorTitle: "No se pudieron cargar las voces",
          errorSubtitle: "Comprueba tu clave API e inténtalo de nuevo.",
        },
        modelPicker: {
          title: "Modelo",
          subtitle:
            "Opcional: sobrescribe el id del modelo TTS de ElevenLabs.",
          detailAuto: "Automático",
          options: {
            autoTitle: "Automático",
            autoSubtitle: "Usa el modelo predeterminado de ElevenLabs.",
            multilingualV2Subtitle: "Predeterminado común (multilingüe).",
            turboV2Subtitle:
              "Menor latencia (si está disponible en tu plan).",
            turboV25Subtitle: "Turbo 2.5 (si está disponible).",
            customTitle: "Personalizado…",
            customSubtitle: "Introduce un id de modelo.",
          },
          prompt: {
            title: "Id de modelo",
            body: "Introduce un id de modelo de ElevenLabs o déjalo en blanco para usar el predeterminado.",
          },
        },
        voiceSettings: {
          default: "Predeterminado",
          stability: {
            title: "Estabilidad",
            subtitle: "0–1. Déjalo en blanco para el predeterminado.",
            promptTitle: "Estabilidad (0–1)",
            promptBody:
              "Introduce un número entre 0 y 1. Déjalo en blanco para usar el predeterminado.",
            invalid: "Introduce un número entre 0 y 1.",
          },
          similarityBoost: {
            title: "Aumento de similitud",
            subtitle: "0–1. Déjalo en blanco para el predeterminado.",
            promptTitle: "Aumento de similitud (0–1)",
            promptBody:
              "Introduce un número entre 0 y 1. Déjalo en blanco para usar el predeterminado.",
            invalid: "Introduce un número entre 0 y 1.",
          },
          speed: {
            title: "Velocidad",
            subtitle: "0.7–1.2. Déjalo en blanco para el predeterminado.",
            promptTitle: "Velocidad (0.7–1.2)",
            promptBody:
              "Introduce un número entre 0.7 y 1.2. Déjalo en blanco para usar el predeterminado.",
            invalid: "Introduce un número entre 0.7 y 1.2.",
          },
        },
        getStartedTitle: "Primeros pasos",
      },
      apiKeySaveFailed: "No se pudo guardar la clave API. Inténtalo de nuevo.",
      disconnect: "Desconectar",
      disconnectSubtitle:
        "Eliminar las credenciales de ElevenLabs guardadas en este dispositivo",
      disconnectTitle: "Desconectar ElevenLabs",
      disconnectDescription:
        "Esto eliminará tu clave API de ElevenLabs y el ID del Agente guardados en este dispositivo.",
      disconnectConfirm: "Desconectar",
    },
    externalCredentials: {
      ...voiceExternalCredentialApprovalTranslations.es,
      apiKeyTitle: "Clave de API",
      promptTitle: "Conectar este proveedor de voz",
      promptDescription: "Pega la clave de API del proveedor. Se guardará en tu cuenta y solo se enviará al endpoint declarado por el complemento; el código de ejecución del complemento no la recibe.",
      footer: "Las claves guardadas se almacenan en tu cuenta. La mediación del host las envía al endpoint declarado del proveedor; el código del complemento solo recibe el resultado de la operación.",
      rawPromptDescription: "Pega la clave de API del proveedor. El código del complemento en el entorno de ejecución declarado de este proveedor recibe directamente la credencial seleccionada y puede usarla o copiarla.",
      rawFooter: "El acceso a credenciales sin mediación permite que el código del complemento en el entorno declarado reciba directamente la credencial seleccionada y la use o copie. Revisa el acceso antes de usarlo.",
      rawCredentialAccessReviewBody: ({ pluginId, localId, credentialSlot, source, realm, phase }: { pluginId: string; localId: string; credentialSlot: string; source: string; realm: string; phase: string }) =>
        `El código del complemento de ${pluginId}/${localId} recibe la credencial ${source} seleccionada para ${credentialSlot} durante ${phase} en el entorno ${realm}. Puede usarla o copiarla.`,
      ready: "Clave de API guardada",
      missing: "Se requiere una clave de API",
      unavailable: "La configuración de credenciales no está disponible",
    },
    local: {
      ...voiceLocalCredentialTranslations.es,
      title: "Voz local OSS",
      footer:
        "Configura endpoints compatibles con OpenAI para STT (speech-to-text) y TTS (text-to-speech).",
      localhostWarning:
        'Nota: "localhost" y "127.0.0.1" normalmente no funcionan en móviles. Usa la IP LAN de tu ordenador o un túnel.',
      notSet: "No establecido",
      apiKeySet: "Establecida",
      apiKeyNotSet: "No establecida",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "Opcional",
      apiKeySaveFailed: "No se pudo guardar la clave API. Inténtalo de nuevo.",
      googleCloudTts: {
        provider: {
          title: "Google Cloud: Text-to-Speech",
          subtitle:
            "Usa tu propia clave API de Google Cloud para sintetizar audio.",
          detail: "Google Cloud (GCP)",
        },
        common: {
          default: "Predeterminado",
        },
        apiKey: {
          machineCredentialRestrictionBody: "La clave guardada está restringida a un certificado de app de Android y la máquina seleccionada no puede usarla. Introduce una clave API independiente compatible con la máquina; el valor sincronizado existente permanecerá sin cambios para los clientes antiguos.",
          title: "Clave API de Google Cloud",
          promptTitle: "Clave API de Google Cloud",
          promptBody:
            "Crea una clave API con Text-to-Speech API habilitada. Opcional: restringe la clave a esta app (iOS bundle id / Android package+SHA1).",
        },
        androidCertSha1: {
          title: "SHA-1 del certificado Android (opcional)",
          subtitle:
            "Solo es necesario si restringes la clave API a tu app de Android.",
          promptTitle: "SHA-1 del certificado Android",
          promptBody:
            "Ejemplo: AA:BB:CC:... (de tu certificado de firma).",
        },
        language: {
          title: "Idioma",
          subtitle: "Filtro opcional para la lista de voces.",
          searchPlaceholder: "Buscar idiomas",
          allTitle: "Todos",
          allSubtitle: "Mostrar voces de todos los idiomas.",
        },
        speakingRate: {
          title: "Velocidad de habla",
          subtitle: "0.25–4.0 (en blanco = valor predeterminado de la voz).",
          promptTitle: "Velocidad de habla",
          promptBody:
            "Establece la velocidad de habla (0.25–4.0). Déjalo vacío para usar el predeterminado.",
        },
        pitch: {
          title: "Tono",
          subtitle: "-20–20 (en blanco = valor predeterminado de la voz).",
          promptTitle: "Tono",
          promptBody:
            "Establece el tono (-20–20). Déjalo vacío para usar el predeterminado.",
        },
        voice: {
          title: "Voz",
          subtitle: "Selecciona una voz de Google Cloud.",
          searchPlaceholder: "Buscar voces",
          selectPrompt: "Seleccionar…",
          setApiKeyPrompt: "Establecer clave API",
          loadingTitle: "Cargando voces…",
        },
        format: {
          title: "Formato",
          subtitle: "MP3 ocupa menos; WAV no está comprimido.",
          mp3Subtitle: "Menor tamaño, compatible ampliamente.",
          wavSubtitle: "Mayor tamaño, sin compresión.",
        },
        alerts: {
          missingApiKey: "Falta la clave API de Google Cloud.",
          missingVoice: "Selecciona primero una voz de Google Cloud.",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Gemini de Google (audio)",
          subtitle: "Transcribe audio usando modelos multimodales de Gemini.",
          detail: "Gemini de Google",
        },
        apiKey: {
          title: "Clave API de Gemini",
          promptTitle: "Clave API de Gemini",
          promptBody: "Crea una clave API en Google AI Studio (Gemini API).",
        },
        model: {
          title: "Modelo de Gemini",
          subtitle: "Elige qué modelo de Gemini usar para la transcripción.",
          searchPlaceholder: "Buscar modelos",
          customTitle: "ID de modelo personalizado…",
          customSubtitle: "Introduce un nombre de modelo manualmente.",
          loadingModelsTitle: "Cargando modelos…",
          promptTitle: "Modelo de Gemini",
          promptBody: "Ejemplo: gemini-2.5-flash",
        },
        language: {
          title: "Idioma",
          subtitle:
            "Sugerencia opcional para mejorar la precisión de la transcripción.",
          searchPlaceholder: "Buscar idiomas",
          autoTitle: "Automático",
          autoSubtitle: "No proporcionar una sugerencia de idioma.",
        },
      },
      kokoro: {
        common: {
          default: "Predeterminado",
          none: "N/D",
        },
        runtime: {
          title: "Entorno de Kokoro",
          unsupportedSubtitle: "Kokoro no es compatible con este dispositivo/entorno.",
          unavailableDetail: "No disponible",
        },
        manifest: {
          title: "Manifiesto del paquete de modelo",
          subtitle:
            "Por defecto usa paquetes de modelos de Happier (se puede sobrescribir con EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS).",
          detailResolved: "Resuelto",
          detailMissing: "Falta",
        },
        assetPack: {
          title: "Paquete de modelo Kokoro",
          subtitleNative: "Selecciona el paquete de recursos para Kokoro.",
          subtitleWeb: "Selecciona la configuración de runtime para Kokoro.",
        },
        model: {
          title: "Modelo Kokoro",
          subtitleNative:
            "Descarga los archivos necesarios para habilitar síntesis en el dispositivo.",
          subtitleWeb: "Descarga bajo demanda. Usa WebAssembly (beta).",
        },
        modelStatus: {
          downloading: "Descargando…",
          downloadingPrefix: "Descargando",
          ready: "Listo",
          error: "Fallo",
          notDownloaded: "No descargado",
        },
        removeAssets: {
          title: "Eliminar recursos de Kokoro",
          subtitle:
            "Libera almacenamiento eliminando los archivos descargados de Kokoro.",
          detailRemove: "Eliminar",
          confirmTitle: "¿Eliminar los recursos de Kokoro?",
          confirmBody:
            "Esto eliminará los archivos de Kokoro descargados de este dispositivo.",
          confirmButton: "Eliminar",
        },
        updates: {
          title: "Buscar actualizaciones del modelo",
          subtitle: "Comprueba manualmente si hay un paquete de modelo más nuevo.",
          check: "Buscar",
          upToDate: "Actualizado",
          updateAvailable: "Actualización disponible",
        },
        alerts: {
          runtimeUnsupported: {
            body: "Kokoro no es compatible con este dispositivo/entorno.",
          },
          missingManifest: {
            title: "Falta la URL del manifiesto",
            body: "No se pudo resolver la URL del manifiesto del paquete de modelo. Revisa EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (o variables de entorno antiguas de Kokoro).",
          },
          notInstalledTitle: "No instalado",
          notInstalledBody:
            "Descarga primero el paquete de modelos para habilitar la comprobación de actualizaciones.",
          upToDateTitle: "Actualizado",
          upToDateBody: "No hay actualizaciones disponibles para este paquete de modelos.",
          updateAvailableTitle: "Actualización disponible",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `¿Descargar ahora la versión más reciente de este paquete de modelos?${remoteBuild ? `\n\nBuild remoto: ${remoteBuild}` : ""}`,
          updatedTitle: "Actualizado",
          updatedBody: "Paquete de modelos actualizado correctamente.",
          updateFailedTitle: "La actualización falló",
          updateFailedBody: ({ message }: { message: string }) =>
            `No se pudo actualizar este paquete de modelos.\n\n${message}`,
        },
        voice: {
          title: "Voz",
          subtitleNative: "Selecciona la voz de Kokoro.",
          searchPlaceholder: "Buscar voces",
          titleWeb: "Voz de Kokoro",
          subtitleWeb: "Elige la voz del dispositivo usada para las respuestas.",
          loadingVoicesTitle: "Cargando voces…",
        },
        speed: {
          title: "Velocidad",
          subtitle: "Ajusta la velocidad de voz (0,5–2,0).",
        },
        web: {
          warmingUp: "Preparando…",
          clearCache: {
            confirmTitle: "¿Borrar la caché de Kokoro?",
            confirmBody:
              "Esto elimina los archivos descargados del modelo y de las voces de Kokoro de este dispositivo.",
            confirmButton: "Borrar",
          },
          cacheDetail: {
            modelFiles: "Archivos del modelo",
            voices: "Voces",
          },
          cache: {
            title: "Caché de Kokoro",
            subtitle: "Gestiona los archivos descargados de Kokoro en este dispositivo.",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "Paquete de modelos",
          subtitle: "ID del paquete de modelos STT en streaming.",
        },
        modelFiles: {
          title: "Archivos del modelo",
          subtitle:
            "Descarga los archivos necesarios para habilitar STT en streaming en el dispositivo.",
        },
        removeModelFiles: {
          title: "Eliminar archivos del modelo",
          subtitle:
            "Libera almacenamiento eliminando los archivos del modelo descargados.",
          confirmTitle: "¿Eliminar archivos del modelo?",
          confirmBody:
            "Esto eliminará el paquete de modelo STT descargado de este dispositivo.",
        },
        status: {
          installed: "Instalado",
          installedWithBuild: ({ build }: { build: string }) =>
            `Instalado • ${build}`,
          notInstalled: "No instalado",
        },
        language: {
          title: "Idioma",
          subtitle: "Etiqueta de idioma BCP-47 opcional.",
          promptTitle: "Idioma",
          promptBody:
            "Introduce una etiqueta de idioma BCP-47 (p. ej. en, en-US).",
        },
        alerts: {
          downloadFailedTitle: "La descarga falló",
          downloadFailedBody: ({ message }: { message: string }) =>
            `No se pudo descargar este paquete de modelos.\n\n${message}`,
          notInstalledTitle: "No instalado",
          notInstalledBody:
            "Descarga primero el paquete de modelos para habilitar la comprobación de actualizaciones.",
          upToDateBody:
            "No hay actualizaciones disponibles para este paquete de modelos.",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `¿Descargar ahora la última versión de este paquete de modelos?${remoteBuild ? `\n\nCompilación remota: ${remoteBuild}` : ""}`,
          updatedTitle: "Actualizado",
          updatedBody: "El paquete de modelos se actualizó correctamente.",
          updateFailedTitle: "La actualización falló",
          updateFailedBody: ({ message }: { message: string }) =>
            `No se pudo actualizar este paquete de modelos.\n\n${message}`,
        },

        provider: {
          title: "Neural local (beta)",
          subtitle:
            "STT mediante daemon en web; los paquetes nativos de streaming Sherpa siguen disponibles cuando son compatibles.",
          detail: "Sherpa STT",
        },},
      executionMachine: {
        groupTitle: "Ejecución de voz local",
        groupFooter: "Elige dónde se ejecutan la voz local, la gestión de modelos y el agente de voz.",
        title: "Máquina de ejecución",
        fallbackSubtitle: "Elige una máquina para la voz local.",
        autoTitle: "Automática",
        autoSubtitle: "Usa la actividad reciente para elegir una máquina disponible.",
        onlineLabel: "En línea",
        offlineLabel: "Sin conexión",
        unknownMachineLabel: "Máquina desconocida",
      },
      conversationMode: "Modo de conversación",
      conversationModeSubtitle:
        "Directo a la sesión, o mediador con commit explícito",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "Usa el agente de voz (commit explícito, control de herramientas).",
          directTitle: "Sesión directa",
          directSubtitle: "Habla directamente en la sesión activa.",
        },
        handsFree: {
          title: "Manos libres",
          enableTitle: "Activar manos libres",
          silenceTitle: "Tiempo de silencio (ms)",
          minSpeechTitle: "Habla mínima (ms)",
        },
        customBackendIdSubtitle: "Introduce un id de backend personalizado.",
        searchBackendsPlaceholder: "Buscar backends",
        searchModelsPlaceholder: "Buscar modelos",
        machineAutoSubtitle:
          "Selecciona automáticamente una máquina según tu uso reciente.",
        rootSessionPolicy: {
          title: "Política de sesión raíz",
          fallbackSubtitle: "Elige una política.",
          singleTitle: "Única",
          singleSubtitle: "Crear una nueva sesión raíz cada vez.",
          keepWarmTitle: "Mantener caliente",
          keepWarmSubtitle:
            "Reutilizar una sesión raíz caliente cuando sea posible.",
          maxWarmRootsTitle: "Máx. raíces calientes",
          maxWarmRootsSubtitle:
            "Limita cuántas sesiones raíz calientes se conservan.",
        },
        persistence: {
          title: "Persistencia de la transcripción",
          ephemeralTitle: "Efímera",
          ephemeralSubtitle:
            "No guardar el estado del agente de voz entre sesiones.",
          persistentTitle: "Persistente",
          persistentSubtitle:
            "Guardar el estado del agente de voz entre sesiones (reanudable).",
        },
        resetVoiceAgent: {
          title: "Restablecer estado del agente de voz",
          subtitle: "Borra el estado persistente del agente de voz.",
          confirmBody:
            "Esto borrará el estado guardado del agente de voz. No se puede deshacer.",
        },
        agentSettings: {
          title: "Agente de voz",
        },
        backend: {
          daemonSubtitle:
            "Usa tu backend de Happier y admite reanudación del proveedor.",
          openAiSubtitle: "Conecta a endpoints HTTP compatibles con OpenAI.",
        },
        agentMachine: {
          title: "Máquina del agente",
          fallbackSubtitle: "Elige dónde ejecutar el agente de voz.",
          stayInVoiceHomeTitle: "Mantener en voice home",
          stayInVoiceHomeEnabledSubtitle:
            "Mantener el agente en la máquina de voice home.",
          stayInVoiceHomeDisabledSubtitle:
            "Permitir que el agente siga la máquina de la sesión.",
          allowTeleportTitle: "Permitir teletransporte",
          teleportEnabledSubtitle:
            "Permite mover el agente a otra máquina cuando sea necesario.",
          teleportDisabledSubtitle: "Teletransporte desactivado.",
        },
        machineRecovery: {
          switchTitle: "Máquina de voz no disponible",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `La máquina de voz actual (${currentMachine}) no está disponible.\n\n¿Cambiar la voz a ${nextMachine}?`,
          switchAction: "Cambiar máquina",
          replayTitle: "¿Traer la conversación?",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `Puedes empezar de cero en ${nextMachine} o cambiar y reproducir el contexto de voz reciente desde la máquina anterior.`,
          replayAction: "Cambiar y reproducir el contexto de voz reciente",
          startFreshAction: "Empezar de cero",
        },
        agentSource: {
          followSessionTitle: "Seguir sesión",
          followSessionSubtitle:
            "Usar el backend y la configuración de la sesión.",
          fixedAgentTitle: "Agente fijo",
          fixedAgentSubtitle:
            "Usar siempre un backend de agente específico.",
        },
        permissionPolicy: {
          readOnlySubtitle:
            "Puede ver el contexto, pero no puede ejecutar herramientas.",
          noToolsSubtitle:
            "Debe evitar solicitudes de herramientas y nunca ejecutarlas.",
        },
        chatModelSource: {
          sessionSubtitle:
            "Usar la configuración del modelo de la sesión para el chat del agente.",
          customSubtitle:
            "Sobrescribir el id del modelo de chat del agente de voz.",
        },
        chatModelId: {
          title: "Id del modelo de chat del agente de voz",
          subtitle:
            "Se usa cuando el origen del modelo de chat está en Modelo personalizado.",
        },
        commitModelSource: {
          chatSubtitle: "Usar el modelo de chat del agente para los commits.",
          sessionSubtitle:
            "Usar la configuración del modelo de la sesión para los commits.",
          customSubtitle:
            "Sobrescribir el id del modelo de commit del agente de voz.",
        },
        commitModelId: {
          title: "Id del modelo de commit del agente de voz",
          subtitle:
            "Se usa cuando el origen del modelo de commit está en Modelo personalizado.",
        },
        commitIsolation: {
          title: "Aislamiento de commits",
          subtitle:
            "Usa una sesión del proveedor separada para generar commits (avanzado).",
        },
        resumability: {
          modeTitle: "Reanudación",
          replayTitle: "Reproducir",
          replaySubtitle: "Reanuda reproduciendo mensajes recientes.",
          providerResumeTitle: "Reanudación del proveedor",
          providerResumeSubtitle:
            "Reanuda usando el estado de la sesión del proveedor (si se admite).",
          disabledVoiceAgent: "Requiere Happier Voice Agent.",
          disabledDaemonBackend: "Requiere backend Daemon.",
          disabledAgentNoProviderResume:
            "El agente seleccionado no admite reanudación del proveedor.",
        },
        providerResumeFallback: {
          title: "Alternativa: reproducir",
          subtitle:
            "Si falla la reanudación del proveedor, usar reproducir.",
        },
        replayRecentMessagesPromptBody:
          "Cuántos mensajes recientes incluir (1–100).",
        prewarm: {
          title: "Precalentar al conectar",
          subtitle: "Inicia el agente de voz inmediatamente al conectar.",
        },
        welcome: {
          title: "Mensaje de bienvenida",
          offTitle: "Desactivado",
          offSubtitle: "No enviar mensaje de bienvenida.",
          immediateTitle: "Inmediato",
          immediateSubtitle:
            "Enviar un mensaje de bienvenida en cuanto el agente se inicie.",
          onFirstTurnTitle: "En el primer turno",
          onFirstTurnSubtitle:
            "Enviar bienvenida cuando hables por primera vez.",
        },
        verbosity: {
          shortSubtitle: "Mantén las respuestas del agente breves.",
          balancedSubtitle:
            "Permite un poco más de detalle cuando sea necesario.",
        },
        streaming: {
          title: "Transmisión",
          enableTitle: "Activar streaming",
          enableSubtitle:
            "Transmite el texto parcial del agente a medida que se genera (se usa para voz en streaming).",
          enableTtsTitle: "Activar streaming de TTS",
          enableTtsSubtitle:
            "Habla la respuesta mientras se transmite (requiere streaming).",
          ttsChunkCharsTitle: "Caracteres por bloque de TTS",
          ttsChunkCharsPromptBody:
            "Cuántos caracteres almacenar antes de pedir el siguiente bloque de TTS (32–2000).",
        },
        network: {
          title: "Red",
          timeoutTitle: "Tiempo de espera de red (ms)",
          timeoutPromptBody:
            "Tiempo de espera para solicitudes a tus endpoints (1000–60000).",
        },
      },
      mediatorBackend: "Backend del mediador",
      mediatorBackendSubtitle:
        "Daemon (usa tu backend de Happier) u OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Demonio",
      mediatorBackendOpenAi: "HTTP compatible con OpenAI",
      mediatorAgentSource: "Fuente del agente del mediador",
      mediatorAgentSourceSubtitle:
        "Usar el backend de la sesión o forzar un agente específico",
      mediatorAgentSourceSession: "Backend de la sesión",
      mediatorAgentSourceAgent: "Agente específico",
      mediatorAgentId: "Agente del mediador",
      mediatorAgentIdSubtitle:
        "Qué agente backend usar para el mediador (cuando no se usa la sesión)",
      mediatorPermissionPolicy: "Permisos del mediador",
      mediatorPermissionPolicySubtitle:
        "Restringe el uso de herramientas durante la mediación",
      mediatorPermissionReadOnly: "Solo lectura",
      mediatorPermissionNoTools: "Sin herramientas",
      mediatorVerbosity: "Verbosidad del mediador",
      mediatorVerbositySubtitle: "Qué tan detallado debe ser el mediador",
      mediatorVerbosityShort: "Corto",
      mediatorVerbosityBalanced: "Equilibrado",
      mediatorIdleTtl: "TTL de inactividad del mediador",
      mediatorIdleTtlSubtitle:
        "Detener automáticamente tras inactividad (60–3600s)",
      mediatorIdleTtlTitle: "TTL de inactividad del mediador (segundos)",
      mediatorIdleTtlDescription: "Introduce un número entre 60 y 3600.",
      mediatorIdleTtlInvalid: "Introduce un número entre 60 y 3600.",
      mediatorChatModelSource: "Origen del modelo (chat)",
      mediatorChatModelSourceSubtitle:
        "Usar el modelo de la sesión o un modelo rápido personalizado",
      mediatorChatModelSourceSession: "Modelo de la sesión",
      mediatorChatModelSourceCustom: "Modelo personalizado",
      mediatorCommitModelSource: "Origen del modelo (commit)",
      mediatorCommitModelSourceSubtitle:
        "Usar el modelo de chat, el de la sesión o un modelo personalizado",
      mediatorCommitModelSourceChat: "Modelo de chat",
      mediatorCommitModelSourceSession: "Modelo de la sesión",
      mediatorCommitModelSourceCustom: "Modelo personalizado",
      chatBaseUrl: "Base URL Chat",
      chatBaseUrlTitle: "Base URL Chat",
      chatBaseUrlDescription:
        "Base URL para el endpoint de chat completion compatible con OpenAI (normalmente termina en /v1).",
      chatApiKey: "Clave API Chat",
      chatApiKeyTitle: "Clave API Chat",
      chatApiKeyDescription:
        "Clave API opcional para tu servidor de chat (almacenada cifrada). Déjalo en blanco para borrar.",
      chatModel: "Modelo de chat",
      chatModelSubtitle: "Modelo rápido usado para la conversación de voz",
      chatModelTitle: "Modelo de chat",
      chatModelDescription:
        "Nombre del modelo a enviar a tu servidor de chat (campo compatible con OpenAI).",
      modelCustomTitle: "Personalizado…",
      modelCustomSubtitle: "Introduce un ID de modelo",
      commitModel: "Modelo de commit",
      commitModelSubtitle:
        "Modelo usado para generar el mensaje final de instrucciones",
      commitModelTitle: "Modelo de commit",
      commitModelDescription:
        "Nombre del modelo a usar al generar el mensaje final.",
      chatTemperature: "Temperatura del chat",
      chatTemperatureSubtitle: "Controla la aleatoriedad (0–2)",
      chatTemperatureTitle: "Temperatura del chat",
      chatTemperatureDescription: "Introduce un número entre 0 y 2.",
      chatTemperatureInvalid: "Introduce un número entre 0 y 2.",
      chatMaxTokens: "Máx. tokens (chat)",
      chatMaxTokensSubtitle: "Limita la longitud (en blanco = por defecto)",
      chatMaxTokensTitle: "Máx. tokens (chat)",
      chatMaxTokensDescription:
        "Introduce un entero positivo o deja en blanco para el valor por defecto.",
      chatMaxTokensPlaceholder: "En blanco = por defecto",
      chatMaxTokensUnlimited: "Por defecto",
      chatMaxTokensInvalid: "Introduce un número positivo o deja en blanco.",
      sttBaseUrl: "Base URL STT",
      sttBaseUrlTitle: "Base URL STT",
      sttBaseUrlDescription:
        "Base URL para el endpoint de transcripción compatible con OpenAI (normalmente termina en /v1).",
      sttApiKey: "Clave API STT",
      sttApiKeyTitle: "Clave API STT",
      sttApiKeyDescription:
        "Clave API opcional para tu servidor STT (almacenada cifrada). Déjalo en blanco para borrar.",
      sttModel: "Modelo STT",
      sttModelSubtitle:
        "Nombre del modelo enviado en solicitudes de transcripción",
      sttModelTitle: "Modelo STT",
      sttModelDescription:
        "Nombre del modelo a enviar a tu servidor STT (campo compatible con OpenAI).",
      deviceStt: "STT del dispositivo (experimental)",
      deviceSttSubtitle:
        "Usar reconocimiento de voz en el dispositivo en lugar de un endpoint compatible con OpenAI",
      sttProvider: "Proveedor de STT",
      neuralStt: {
        title: "STT en el dispositivo",
        webNotAvailableSubtitle:
          "No disponible en web. Usa Dispositivo, compatible con OpenAI o STT de Gemini.",
      },
      ttsBaseUrl: "Base URL TTS",
      ttsBaseUrlTitle: "Base URL TTS",
      ttsBaseUrlDescription:
        "Base URL para el endpoint de voz compatible con OpenAI (normalmente termina en /v1).",
      ttsApiKey: "Clave API TTS",
      ttsApiKeyTitle: "Clave API TTS",
      ttsApiKeyDescription:
        "Clave API opcional para tu servidor TTS (almacenada cifrada). Déjalo en blanco para borrar.",
      ttsModel: "Modelo TTS",
      ttsModelSubtitle: "Nombre del modelo enviado en solicitudes de voz",
      ttsModelTitle: "Modelo TTS",
      ttsModelDescription:
        "Nombre del modelo a enviar a tu servidor TTS (campo compatible con OpenAI).",
      ttsVoice: "Voz TTS",
      ttsVoiceSubtitle: "Nombre/ID de la voz enviado en solicitudes de voz",
      ttsVoiceTitle: "Voz TTS",
      ttsVoiceDescription:
        "Nombre/ID de la voz a enviar a tu servidor TTS (campo compatible con OpenAI).",
      ttsFormat: "Formato TTS",
      ttsFormatSubtitle: "Formato de audio devuelto por TTS",
      ttsFormatOptions: {
        mp3Subtitle: "Salida más pequeña, ampliamente compatible.",
        wavSubtitle: "Salida más grande, sin compresión.",
      },
      testTts: "Probar TTS",
      testTtsSubtitle:
        "Reproduce una muestra corta usando tu TTS local configurado (TTS del dispositivo o endpoint)",
      testTtsSample: "Hola desde Happier. Esta es una prueba de tu TTS local.",
      testTtsMissingBaseUrl: "Primero configura una URL base de TTS.",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "TTS del dispositivo (experimental)",
      deviceTtsSubtitle:
        "Usar síntesis de voz en el dispositivo en lugar de un endpoint compatible con OpenAI",
      ttsProvider: "Proveedor de TTS",
      ttsProviderSubtitle:
        "Elige TTS del dispositivo, un endpoint compatible con OpenAI o Kokoro (web/escritorio)",

      autoSpeak: "Auto-reproducir respuestas",
      autoSpeakSubtitle:
        "Reproduce la siguiente respuesta del asistente después de enviar tu mensaje de voz",
      bargeIn: "Interrupción (barge-in)",
      speaking: "Hablando…",

      localNeuralTts: {
        provider: {
          title: "Neural local (beta)",
          subtitle: "TTS neural respaldado por daemon en web, con paquetes de modelo en el dispositivo cuando sea compatible.",
          detail: "Neural local",
        },
      },
      openaiCompatStt: {
        provider: {
          title: "Endpoint compatible con OpenAI",
          subtitle: "Usar tu propio servidor de transcripción compatible con Whisper.",
          detail: "endpoint",
        },
      },
      openaiCompatTts: {
        provider: {
          title: "Endpoint compatible con OpenAI",
          subtitle: "Usar tu propio servidor TTS local o remoto compatible con OpenAI.",
          detail: "endpoint",
        },
      },
      deviceSttDetail: "Dispositivo",
      deviceTtsDetail: "Dispositivo",
      daemonInference: {
        execution: {
          title: "Ejecución neural local",
          subtitle: "Elige si la voz neural local se ejecuta en el dispositivo o en tu daemon.",
          options: { auto: "Automático", device: "Dispositivo", daemon: "Daemon de voz" },
          optionSubtitles: {
            auto: "Prefiere la ruta de ejecución recomendada para esta plataforma.",
            device: "Ejecuta la voz neural local directamente en este dispositivo cuando sea compatible.",
            daemon: "Ejecuta la voz neural local mediante tu daemon de voz principal.",
          },
        },
        service: {
          title: "Servicio de inferencia del daemon",
          subtitle: "Estado del servicio de inferencia del daemon de voz principal.",
        },
        model: {
          title: "Paquete de modelo del daemon",
          subtitleTts: "Instala y actualiza el paquete de modelo TTS del daemon.",
          subtitleStt: "Instala y actualiza el paquete de modelo STT del daemon.",
        },
        remove: {
          title: "Eliminar archivos de modelo del daemon",
          subtitle: "Elimina los archivos de modelo del lado del daemon para este paquete.",
          detailInstalled: "Eliminar archivos del daemon instalados",
        },
        states: {
          loading: "Cargando…",
          machineUnreachable: "El daemon de voz principal no está disponible.",
          unavailable: "La inferencia del daemon no está disponible.",
          runtimeUnavailable: "El runtime del daemon no está disponible.",
          relayDisabled: "El relay del daemon está desactivado.",
          relayCapped: "Se alcanzó la capacidad del relay del daemon.",
          requestTimeout: "La solicitud al daemon agotó el tiempo de espera.",
          warming: "Preparando el modelo…",
          ready: "Listo",
          degraded: "Degradado",
          idle: "Inactivo",
          installing: "Instalando…",
          installed: "Instalado",
          installError: "La instalación falló",
          notInstalled: "No instalado",
          latencyDemoted: "La latencia se degradó; usando voz del dispositivo para esta conversación.",
          fallbackToDevice: "Volviendo a voz del dispositivo.",
        },
      },
      models: {
          title: "Modelos de voz locales",
          statusTitle: "Servicio de modelos",
          footer: "Instala paquetes de modelos de voz locales en tu daemon de voz y elige el predeterminado para cada tipo.",
          sttGroupTitle: "Modelos de voz a texto",
          ttsGroupTitle: "Modelos de texto a voz",
          defaultBadge: "Predeterminado",
          defaultSubtitle: "Predeterminado para este tipo",
          installSubtitle: "Toca para instalar en el daemon",
          setDefaultSubtitle: "Toca para usar como predeterminado",
          unknownSubtitle: "Estado no disponible",
          modelFiles: ({ size }: { size: string }) => `Archivos del modelo: ${size}`,
          removeConfirmTitle: "Eliminar paquete de modelo",
          removeConfirmBody: ({ name }: { name: string }) => `¿Eliminar los archivos del daemon de ${name}?`,
          state: {
              notInstalled: "No instalado",
              downloading: "Descargando…",
              installed: "Instalado",
              warming: "Calentando…",
              ready: "Listo",
              evicted: "Descargado",
              error: "Error de instalación",
              unknown: "Estado no disponible",
          },
      },
      machineErrors: {
        mic_permission_denied: "Se denegó el permiso del micrófono.",
        mic_ended: "La entrada del micrófono terminó.",
        mic_plateau: "El audio del micrófono dejó de cambiar.",
        transport_disconnect: "La conexión de voz se desconectó.",
        provider_error: "El proveedor de voz falló.",
        provider_auth_invalid: "Añade o actualiza la clave API del proveedor de voz seleccionado.",
        audio_context_suspended: "La salida de audio está suspendida.",
        stt_timeout: "Se agotó el tiempo para iniciar la escucha.",
        tts_failed: "La síntesis de voz falló.",
        turn_aborted: "Se canceló el turno de voz.",
        authentication_required: "Conecta el agente seleccionado para usar Voz.",
        session_unavailable: "La sesión seleccionada ya no está disponible para Voz.",
        unsupported_runtime: "Instala el entorno del agente seleccionado para usar Voz.",
        update_required: "Actualiza el entorno del agente seleccionado para usar Voz.",
        feature_unavailable: "Voz no está disponible para el entorno del agente seleccionado.",
      },},
    privacy: {
      title: "Privacidad",
      footer:
        "Los proveedores de voz reciben el contexto de sesión seleccionado.",
      shareSessionSummary: "Compartir resumen de sesión",
      shareSessionSummarySubtitle:
        "Incluye el resumen de sesión en el contexto de voz",
      shareRecentMessages: "Compartir mensajes recientes",
      shareRecentMessagesSubtitle:
        "Incluye mensajes recientes en el contexto de voz",
      recentMessagesCount: "Cantidad de mensajes recientes",
      recentMessagesCountSubtitle: "Cuántos mensajes recientes incluir (0–50)",
      recentMessagesCountTitle: "Cantidad de mensajes recientes",
      recentMessagesCountDescription: "Introduce un número entre 0 y 50.",
      recentMessagesCountInvalid: "Introduce un número entre 0 y 50.",
      shareToolNames: "Compartir nombres de herramientas",
      shareToolNamesSubtitle: "Incluye nombres/descripciones de herramientas en el contexto de voz",
      shareDeviceInventory: "Compartir inventario del dispositivo",
      shareDeviceInventorySubtitle:
        "Permitir que la voz liste espacios de trabajo, máquinas y servidores recientes",
      shareToolArgs: "Compartir argumentos de herramientas",
      shareToolArgsSubtitle: "Incluye argumentos de herramientas (puede incluir rutas o secretos)",
      sharePermissionRequests: "Compartir solicitudes de permisos",
      sharePermissionRequestsSubtitle: "Reenvía solicitudes de permisos a voz",
      shareFilePaths: "Compartir rutas locales",
      shareFilePathsSubtitle:
        "Incluye rutas locales en el contexto de voz (no recomendado)",
      currentUiContextModeTitle: "Contexto de la interfaz actual",
      currentUiContextModeSubtitle:
        "Elige cuándo Voice puede usar contexto semántico limitado de la ventana activa de la app Happier o de la pestaña del navegador.",
      currentUiContextMode: {
        offTitle: "Desactivado",
        offSubtitle: "Voice no recibe contexto de la interfaz actual ni comandos contextuales de este cliente.",
        onDemandTitle: "Bajo demanda",
        onDemandSubtitle: "Cuando se lo pides, Voice puede leer contexto semántico limitado de esta ventana de la app o pestaña del navegador. Los comandos contextuales siguen sujetos a controles separados.",
        automaticTitle: "Automático",
        automaticSubtitle: "Voice también recibe automáticamente metadatos básicos de navegación, y abrir una sesión comparte el contexto de esa sesión según los ajustes de compartición de arriba. Los comandos contextuales siguen sujetos a controles separados.",
      },
    },
    languageTitle: "Idioma",
    languageDescription:
      "Elige tu idioma preferido para las interacciones con el asistente de voz. Esta configuración se sincroniza en todos tus dispositivos.",
    preferredLanguage: "Idioma preferido",
    preferredLanguageSubtitle:
      "Idioma usado para respuestas del asistente de voz",
    language: {
      searchPlaceholder: "Buscar idiomas...",
      title: "Idiomas",
      footer: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "idioma", plural: "idiomas" })} disponibles`,
      autoDetect: "Detectar automáticamente",
      autoDetectSubtitle: "Deja que el reconocedor decida (recomendado).",
      customTitle: "Personalizado…",
      customSubtitle: "Introduce una etiqueta de idioma BCP-47.",
      options: {
        english: "Inglés",
        englishUs: "Inglés (EE. UU.)",
        french: "Francés",
        spanish: "Español",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Información de la cuenta",
    status: "Estado",
    statusActive: "Activo",
    statusNotAuthenticated: "No autenticado",
    anonymousId: "ID anónimo",
    publicId: "ID público",
    notAvailable: "No disponible",
    linkNewDevice: "Escanear QR para vincular un nuevo dispositivo",
    linkNewDeviceSubtitle: "Escanea el código QR que se muestra en tu nuevo dispositivo",
    profile: "Perfil",
    name: "Nombre",
    github: "GitHub",
    showGitHubOnProfile: "Mostrar en el perfil",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `Mostrar ${provider} en el perfil`,
    tapToDisconnect: "Toque para desconectar",
    server: "Servidor",
    backup: "Copia de seguridad",
    backupDescription:
      "Tu clave secreta es la única forma de recuperar tu cuenta. Guárdala en un lugar seguro como un administrador de contraseñas.",
    secretKey: "Clave secreta",
    tapToReveal: "Toca para revelar",
    tapToHide: "Toca para ocultar",
    secretKeyLabel: "CLAVE SECRETA (TOCA PARA COPIAR)",
    secretKeyCopied:
      "Clave secreta copiada al portapapeles. ¡Guárdala en un lugar seguro!",
    secretKeyCopyFailed: "Falló al copiar la clave secreta",
    privacy: "Privacidad",
    privacyDescription:
      "Ayude a mejorar la aplicación compartiendo datos de uso anónimos. No se recopila información personal.",
    analytics: "Analíticas",
    analyticsDisabled: "No se comparten datos",
    analyticsEnabled: "Se comparten datos de uso anónimos",
    crashReports: "Informes de fallos",
    crashReportsDisabled: "No se comparten informes de fallos",
    crashReportsEnabled: "Se comparten informes de fallos",
    dangerZone: "Zona peligrosa",
    logout: "Cerrar sesión",
    logoutSubtitle: "Cerrar sesión y limpiar datos locales",
    logoutConfirm:
      "¿Seguro que quieres cerrar sesión? ¡Asegúrate de haber guardado tu clave secreta!",
    encryptionUpdateFailed: "No se pudo actualizar la configuración de cifrado.",
    secretKeyMissing: "Clave secreta no disponible. Primero restaura tu cuenta.",
    restoreRequiredTitle: "Se requiere restauración",
    restoreRequiredBody:
      "Esta cuenta tiene historial cifrado. Para volver a activar el cifrado en este dispositivo, restaura tu clave secreta. Si perdiste la clave, puedes restablecer la cuenta para empezar de cero (el historial cifrado anterior no se puede recuperar).",
  },

  settingsLanguage: {
    // Language settings screen
    title: "Idioma",
    description:
      "Elige tu idioma preferido para la interfaz de la aplicación. Esto se sincronizará en todos tus dispositivos.",
    currentLanguage: "Idioma actual",
    automatic: "Automático",
    automaticSubtitle: "Detectar desde configuración del dispositivo",
    needsRestart: "Idioma cambiado",
    needsRestartMessage:
      "La aplicación necesita reiniciarse para aplicar la nueva configuración de idioma.",
    restartNow: "Reiniciar ahora",
  },

  connectButton: {
    authenticate: "Autenticar terminal",
    authenticateWithUrlPaste: "Autenticar terminal con pegado de URL",
    pasteAuthUrl: "Pega la URL de autenticación de tu terminal",
  },

  updateBanner: {
    updateShort: "Actualizar",
    updateAvailable: "Actualización disponible",
    pressToApply: "Presione para aplicar la actualización",
    whatsNew: "Novedades",
    seeLatest: "Ver las últimas actualizaciones y mejoras",
    nativeUpdateAvailable: "Actualización de la aplicación disponible",
    tapToUpdateAppStore: "Toque para actualizar en App Store",
    tapToUpdatePlayStore: "Toque para actualizar en Play Store",

    checkNowTitle: "Comprobar ahora",
    checkNowSubtitle: "Comprueba si hay actualizaciones de la aplicación.",
    lastCheckedTitle: "Última comprobación",},

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: string }) => `Versión ${version}`,
    noEntriesAvailable: "No hay entradas de registro de cambios disponibles.",
  },

  releaseNotes: {
    viewFullChangelog: "Ver todas las notas de la versión",
    mediaUnavailable: "Contenido multimedia no disponible",
    storyDeck: {
      dragToDismiss: "Arrastra para cerrar",
      letsGo: "¡Vamos!",
      slideAnnouncement: ({ title, current, total }: { title: string; current: number; total: number }) => `${title} - ${current} / ${total}`,
    },
    defaultTitle: "Novedades",
    onboardingShowcase: {
                "title": "Bienvenido a Happier",
                "subtitle": "Tus agentes de IA, dondequiera que trabajes.",
                "cards": {
                    "welcome": {
                        "title": "Bienvenido a Happier",
                        "everywhereTitle": "Tus agentes de IA, dondequiera que trabajes",
                        "everywhereBody": "Claude Code, Codex, OpenCode, Pi y mucho más: en tu teléfono, tablet, navegador o escritorio.",
                        "cockpitTitle": "Tu cockpit móvil",
                        "cockpitBody": "Chat, archivos, Git, editor, terminal. Todo lo que necesitas para crear y lanzar tu próximo proyecto, al alcance de la mano.",
                        "existingTitle": "Sesiones existentes, ya disponibles",
                        "existingBody": "Cualquier sesión de Claude, Codex u OpenCode que se esté ejecutando en tu máquina, ábrela en Happier en directo.",
                        "voiceTitle": "Un asistente de voz para pensar juntos",
                        "voiceBody": "Pregunta qué están haciendo tus agentes, aprueba solicitudes de permiso y envía mensajes. Sin manos.",
                        "reviewTitle": "Revisa diffs y deja comentarios",
                        "reviewBody": "Marca líneas concretas en archivos o diffs, elige qué notas enviar y pásalas directamente a un agente.",
                        "subagentsTitle": "Subagentes entre proveedores",
                        "subagentsBody": "Lanza subagentes de Codex desde una sesión de Claude. Divide el trabajo entre agentes. Enruta mensajes entre sesiones.",
                        "tuisTitle": "Usa tus TUI favoritas",
                        "tuisBody": "Ejecuta Claude Code, Codex u OpenCode en su interfaz de terminal nativa. Happier lo captura y lo sincroniza con todos tus dispositivos.",
                        "inboxTitle": "Una bandeja. Todas las sesiones.",
                        "inboxBody": "Todas las aprobaciones pendientes, solicitudes de permiso y actividad sin leer, de cada sesión y máquina, en un solo lugar.",
                        "mcpTitle": "Una configuración MCP. Todos los proveedores.",
                        "mcpBody": "Define servidores MCP una sola vez. Funcionan en todos los backends, incluso con proveedores que no admiten MCP de forma nativa.",
                        "controlTitle": "Encola, guía, bifurca, revierte",
                        "controlBody": "Encola mensajes mientras el agente está ocupado. Guía un turno en curso. Bifurca desde cualquier mensaje. Deshaz si hace falta.",
                        "automationsTitle": "Automatizaciones",
                        "automationsBody": "Programa sesiones recurrentes de agentes para vigilar PRs, revisar issues o ejecutar cualquier tarea con regularidad.",
                        "accountsTitle": "Varias cuentas y seguimiento de cuota",
                        "accountsBody": "Conecta varias cuentas de Claude u OpenAI: personal, trabajo, equipo. Supervisa el uso de cada una directamente en la app.",
                        "promptsTitle": "Prompts, skills y perfiles",
                        "promptsBody": "Prompts reutilizables, paquetes de skills y perfiles de backend, sincronizados en cada sesión y dispositivo.",
                        "privacyTitle": "Código abierto. Cifrado de extremo a extremo. Autoalojable.",
                        "privacyBody": "Tus sesiones se mantienen privadas. El código es abierto. Autoalójalo con un solo comando.",
                        "petsTitle": "Conoce Pets",
                        "petsBody": "Un pequeño compañero para las sesiones largas. ¿Útil? Quizá. ¿Encantador? Sin duda."
                    ,
                        row1Title: "Sesiones en cualquier dispositivo",
                        row1Body: "Retoma donde lo dejaste: móvil, tablet, web o escritorio.",
                        row2Title: "Avanza rápido, entrega antes",
                        row2Body: "La sincronización en tiempo real mantiene tu terminal, agentes y archivos al día.",
                        row3Title: "Privado por defecto",
                        row3Body: "Cifrado de extremo a extremo para que tu trabajo siga siendo tuyo.",},
                    "anywhere": {
                        "title": "Empieza donde quieras. Continúa en todas partes.",
                        "wideTitle": "Empieza donde quieras.\nContinúa en todas partes.",
                        "body": "Lanza una sesión desde cualquier lugar. Síguela en directo, envía mensajes y aprueba permisos desde tu teléfono, navegador o escritorio.",
                        "alt": "Imagen de marcador de posición abstracta para sesiones de agentes entre dispositivos."
                    },
                    "terminalTuis": {
                        "title": "¿Te encanta el terminal? ¡A nosotros también!",
                        "wideTitle": "¿Te encanta el terminal?\n¡A nosotros también!",
                        "body": "Ejecuta Claude Code, Codex u OpenCode en su interfaz de terminal nativa. Síguelo, envía mensajes y aprueba permisos desde tu teléfono.",
                        "alt": "Imagen de marcador de posición abstracta para la sincronización de la interfaz de usuario del terminal."
                    },
                    "cockpit": {
                        "title": "Todo lo que necesitas. A un toque.",
                        "wideTitle": "Todo lo que necesitas.\nA un toque",
                        "body": "Chat, archivos, Git, editor, terminal. Interactúa con tu agente, navega y edita archivos, revisa diffs, gestiona ramas Git, abre PRs y abre un terminal en vivo.",
                        "alt": "Imagen de marcador de posición abstracta para la cabina móvil."
                    ,
                        row1Title: "Modo cockpit",
                        row1Body: "Sigue a los agentes activos desde una vista móvil enfocada.",
                        row2Title: "Salta en un toque",
                        row2Body: "Muévete entre chat, archivos, Git, terminal y detalles sin el diseño de escritorio.",
                        row3Title: "Envía rápido",
                        row3Body: "Responde desde cockpit cuando un agente necesita un empujón.",},
                    "existingSessions": {
                        "title": "¿Sesiones de Claude, Codex, OpenCode? Ya están ahí.",
                        "body": "Explora cualquier sesión de Claude, Codex u OpenCode, esté ejecutándose o no.",
                        "alt": "Imagen de marcador de posición abstracta para sesiones de proveedores existentes."
                    },
                    "voiceAssistant": {
                        "title": "Un colega con quien hablar",
                        "wideTitle": "Asistente de voz: un colega con quien hablar",
                        "body": "El asistente de voz supervisa todas tus sesiones en ejecución. Piensa tus próximos cambios en voz alta, aprueba permisos y mucho más, sin manos.",
                        "alt": "Imagen de marcador de posición abstracta para el asistente de voz."
                    },
                    "reviewComments": {
                        "title": "Revisa código y deja comentarios",
                        "body": "Explora los cambios y diffs de tu agente. Marca las líneas exactas que quieres abordar. Envíalas a un agente en la sesión actual o en una nueva.",
                        "alt": "Imagen de marcador de posición abstracta para comentarios de revisión."
                    ,
                        row1Title: "Comenta líneas exactas",
                        row1Body: "Deja feedback directamente en líneas de archivos y diffs.",
                        row2Title: "Elige qué enviar",
                        row2Body: "Revisa, edita, quita o incluye comentarios antes de pedir ayuda a un agente.",
                        row3Title: "Mantén el contexto",
                        row3Body: "Envía contexto de revisión estructurado a la sesión actual o a una nueva sesión.",},
                    "subagents": {
                        "title": "Una sesión, subagentes multiproveedor",
                        "body": "Inicia Codex, Claude o cualquier otro subagente en cualquier sesión. Usa la fortaleza de cada uno y haz que todos trabajen juntos en la misma sesión.",
                        "alt": "Imagen de marcador de posición abstracta para subagentes de proveedores cruzados."
                    },
                    "inbox": {
                        "title": "No pierdas el hilo nunca más",
                        "body": "¿Tienes 10 sesiones a la vez y pierdes de vista qué necesita tu atención? Tu bandeja muestra toda la actividad, de cada sesión y máquina.",
                        "alt": "Imagen de marcador de posición abstracta para la bandeja de entrada global."
                    },
                    "mcp": {
                        "title": "Una configuración. Todos los proveedores.",
                        "wideTitle": "Una configuración.\nTodos los proveedores.",
                        "body": "Define MCPs una vez en Happier y funcionan en todos los backends, incluso los que no admiten MCP de forma nativa. Gestiona skills, prompts y más.",
                        "alt": "Imagen de marcador de posición abstracta para la configuración MCP compartida."
                    },
                    "queue": {
                        "title": "Encola, guía, bifurca, revierte",
                        "body": "Encola mensajes mientras el agente está ocupado. Guía una sesión en curso. Bifurca desde cualquier mensaje. Revierte si algo se tuerce.",
                        "alt": "Imagen de marcador de posición abstracta para herramientas de control de sesiones."
                    },
                    "automations": {
                        "title": "Tu agente, programado",
                        "body": "Programa sesiones recurrentes para vigilar pull requests, revisar issues o ejecutar cualquier tarea con regularidad.",
                        "alt": "Imagen de marcador de posición abstracta para automatizaciones de agentes programadas."
                    },
                    "accounts": {
                        "title": "Varias cuentas y seguimiento de cuota",
                        "body": "Conecta varias cuentas de OpenAI o Claude. Monitoriza uso y cuotas de cada una directamente en la app.",
                        "alt": "Imagen de marcador de posición abstracta para cuentas y cuotas conectadas."
                    },
                    "privacy": {
                        "title": "Código abierto. Cifrado de extremo a extremo.",
                        "wideTitle": "Código abierto.\nCifrado de extremo a extremo.",
                        "body": "Tu código, prompts y contenido de sesión se cifran en tu dispositivo antes de llegar a cualquier servidor. Privado por diseño. Abierto por defecto.",
                        "alt": "Imagen de marcador de posición abstracta para privacidad y autohospedaje."
                    },
                    "pets": {
                        "title": "No te sientas solo. Conoce Pets.",
                        "wideTitle": "No te sientas solo.\nConoce Pets.",
                        "body": "Un pequeño compañero que te ayuda a mantener el rumbo entre sesiones. ¿Útil? Quizá. ¿Encantador? Sin duda.",
                        "alt": "Imagen de marcador de posición abstracta para mascotas."
                    ,
                        row1Title: "Un pequeño compañero",
                        row1Body: "Te ayuda a mantener el foco entre sesiones.",
                        row2Title: "Sigue la actividad",
                        row2Body: "Muestra actividad de sesión en escritorio y móvil.",
                        row3Title: "¿Útil? Quizá.",
                        row3Body: "¿Encantador? Sin duda.",}
                ,
                    sourceControl: {
            title: "Constrúyelo, publícalo",
            body: "Crea y publica ramas, gestiona remotos, revisa archivos cambiados y abre pull requests sin salir de Happier.",
            alt: "Imagen abstracta de marcador para control de código fuente.",
            row1Title: "Ramas y publicación",
            row1Body: "Crea ramas, gestiona remotos y sube cambios sin salir de Happier.",
            row2Title: "Abre pull requests",
            row2Body: "Reutiliza PR existentes o crea uno nuevo desde la sesión.",
            row3Title: "Revisa archivos cambiados",
            row3Body: "Concéntrate en archivos seleccionados cuando el cambio es grande.",
        },
                    markdown: {
            title: "Streaming más suave, markdown más rico",
            body: "Las respuestas en streaming se sienten más fluidas, y el Markdown más rico hace que respuestas largas, código, listas y diagramas sean más fáciles de leer.",
            alt: "Imagen abstracta de marcador para renderizado Markdown.",
            row1Title: "La salida sigue el ritmo",
            row1Body: "Las respuestas en streaming se sienten más fluidas mientras los agentes escriben.",
            row2Title: "Markdown más sólido",
            row2Body: "Bloques de código, listas, tablas y respuestas largas se renderizan con más fiabilidad.",
            row3Title: "Compactación más clara",
            row3Body: "Los eventos del ciclo de vida son más fáciles de seguir en la transcripción.",
        },
                    media: {
            title: "Imágenes dentro de la conversación",
            body: "Pide a Codex y a agentes compatibles que generen imágenes, y previsualiza los resultados directamente en Happier.",
            alt: "Imagen abstracta de marcador para medios generados.",
            row1Title: "Genera imágenes",
            row1Body: "Pide a Codex y a agentes compatibles que creen imágenes.",
            row2Title: "Vista previa inline",
            row2Body: "Las imágenes generadas aparecen directamente en las conversaciones de Happier.",
            row3Title: "Guardadas con la sesión",
            row3Body: "Los medios viajan por el mismo pipeline de sesión que tu trabajo.",
        },
                    desktop: {
            title: "Una app de escritorio más pulida",
            body: "Un shell de escritorio más limpio, con chrome más pulido, espaciado más seguro y estado de actualización donde corresponde.",
            alt: "Imagen abstracta de marcador para la app de escritorio.",
            row1Title: "Chrome más limpio",
            row1Body: "Los controles de la barra lateral y el estado de actualización encajan mejor.",
            row2Title: "Más foco",
            row2Body: "Las ventanas y superficies de sesión se apartan cuando hace falta.",
            row3Title: "Diseño más seguro",
            row3Body: "El espaciado de escritorio gestiona mejor el chrome de plataforma y las pantallas con notch.",
        },}
            },
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Se requiere navegador web",
    webBrowserRequiredDescription:
      "Los enlaces de conexión de terminal solo pueden abrirse en un navegador web por razones de seguridad. Usa el escáner de código QR o abre este enlace en una computadora.",
    processingConnection: "Procesando conexión...",
    invalidConnectionLink: "Enlace de conexión inválido",
    invalidConnectionLinkDescription:
      "El enlace de conexión falta o es inválido. Verifica la URL e intenta nuevamente.",
    connectTerminal: "Conectar terminal",
    terminalRequestDescription:
      "Un terminal está solicitando conectarse a tu cuenta de Happier Coder. Esto permitirá al terminal enviar y recibir mensajes de forma segura.",
    connectionDetails: "Detalles de conexión",
    publicKey: "Clave pública",
    encryption: "Cifrado",
    endToEndEncrypted: "Cifrado de extremo a extremo",
    acceptConnection: "Aceptar conexión",
    connecting: "Conectando...",
    reject: "Rechazar",
    security: "Seguridad",
    securityFooter:
      "Este enlace de conexión fue procesado de forma segura en tu navegador y nunca fue enviado a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.",
    securityFooterDevice:
      "Esta conexión fue procesada de forma segura en tu dispositivo y nunca fue enviada a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.",
    clientSideProcessing: "Procesamiento del lado del cliente",
    linkProcessedLocally: "Enlace procesado localmente en el navegador",
    linkProcessedOnDevice: "Enlace procesado localmente en el dispositivo",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `This connection is for ${serverUrl}. Switch servers and continue?`,
  },

  terminalEmbedded: {
    dockMenuA11y: "Acoplar terminal",
    largePasteTitle: "¿Pegar una entrada grande en el terminal?",
    largePasteDescription: "Este texto pegado es grande y puede ejecutar comandos en el terminal. Revísalo antes de continuar.",
    largePasteConfirm: "Pegar en el terminal",
    settings: {
      locationTitle: "Ubicación del terminal incrustado",
      rendererTitle: "Renderizador del terminal",
      rendererAuto: "Automático",
      rendererAutoDescription: "Usa el renderizador accesible xterm.js salvo que el renderizador nativo sea totalmente apto.",
      rendererXtermWebView: "xterm.js Vista web",
      rendererXtermWebViewDescription: "Renderizador de compatibilidad con el mejor soporte de accesibilidad.",
      rendererNativeExperimental: "Nativo (experimental)",
      rendererNativeExperimentalDescription: "Prefiere Ghostty en iOS o Termux en Android cuando todas las puertas nativas pasen.",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "Intro",
    },
    location: {
      sidebar: "Barra lateral",
      details: "Panel de detalles",
      bottom: "Panel inferior",
    },
    errors: {
      missingMachineTarget: "A esta sesión le falta un destino de máquina.",
      rpcTargetUnavailable: "El RPC de la máquina no está disponible para esta máquina.",
      machineUnreachable: "No se puede acceder a la máquina.",
      disabled: "El soporte de terminal está deshabilitado en la configuración del daemon. Actívalo y reinicia el daemon.",
      notFound: "No se encontró la sesión de terminal. Intenta reiniciar.",
      cwdDenied: "El daemon no tiene permiso para usar este directorio de trabajo.",
      spawnFailed: "No se pudo iniciar el proceso de terminal.",
      invalidRequest: "Solicitud de terminal inválida.",
      busy: "El terminal está ocupado. Inténtalo de nuevo.",
    },

    openNewTabA11y: "Abrir una nueva pestaña de terminal",},

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Autenticar terminal",
    pasteUrlFromTerminal: "Pega la URL de autenticación de tu terminal",
    deviceLinkedSuccessfully: "Dispositivo vinculado exitosamente",
    terminalConnectedSuccessfully: "Terminal conectado exitosamente",
    terminalAlreadyConnected: "Conexión Ya Utilizada",
    terminalConnectionAlreadyUsedDescription: "Este enlace de conexión ya fue utilizado por otro dispositivo. Para conectar múltiples dispositivos al mismo terminal, cierra sesión e inicia sesión en la misma cuenta en todos los dispositivos.",
    authRequestExpired: "Conexión Expirada",
    authRequestExpiredDescription: "Este enlace de conexión ha expirado. Por favor genera un nuevo enlace desde tu terminal.",
    pleaseSignInFirst: "Please sign in (or create an account) first.",
    invalidAuthUrl: "URL de autenticación inválida",
    microphoneAccessRequiredTitle: "Se requiere acceso al micrófono",
    microphoneAccessRequiredRequestPermission:
      "Happier necesita acceso a tu micrófono para el chat de voz. Concede el permiso cuando se te solicite.",
    microphoneAccessRequiredEnableInSettings:
      "Happier necesita acceso a tu micrófono para el chat de voz. Activa el acceso al micrófono en la configuración de tu dispositivo.",
    microphoneAccessRequiredBrowserInstructions:
      "Permite el acceso al micrófono en la configuración del navegador. Puede que debas hacer clic en el icono de candado en la barra de direcciones y habilitar el permiso del micrófono para este sitio.",
    openSettings: "Abrir configuración",
    developerMode: "Modo desarrollador",
    developerModeEnabled: "Modo desarrollador habilitado",
    developerModeDisabled: "Modo desarrollador deshabilitado",
    disconnectGithub: "Desconectar GitHub",
    disconnectGithubConfirm:
      "Al desconectar se desactivan Amigos y el uso compartido entre amigos hasta que vuelvas a conectar.",
    disconnectService: ({ service }: { service: string }) =>
      `Desconectar ${service}`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `¿Seguro que quieres desconectar ${service} de tu cuenta?`,
    disconnect: "Desconectar",
    failedToConnectTerminal: "Falló al conectar terminal",
    cameraPermissionsRequiredToConnectTerminal:
      "Se requieren permisos de cámara para conectar terminal",
    failedToLinkDevice: "Falló al vincular dispositivo",
    cameraPermissionsRequiredToScanQr:
      "Se requieren permisos de cámara para escanear códigos QR",
    qrScannerUnavailable:
      "No se pudo abrir el escáner de QR. Inténtalo de nuevo o introduce la URL manualmente.",
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "Conectar terminal",
    linkNewDevice: "Vincular nuevo dispositivo",
    restoreWithSecretKey: "Restaurar con clave secreta",
    whatsNew: "Novedades",
    friends: "Amigos",
    automations: "Automatizaciones",
    automation: "Automatización",
    newAutomation: "Nueva automatización",
    sourceControl: "Control de versiones",
    developerTools: "Herramientas de desarrollo",
    listComponentsDemo: "Demo de componentes de lista",
    typography: "Tipografía",
    colors: "Colores",
    toolViewsDemo: "Demo de vistas de herramientas",
    maskedProgress: "Progreso enmascarado",
    shimmerViewDemo: "Demo de efecto de brillo",
    multiTextInput: "Entrada de texto múltiple",
    connectClaude: "Conectar con Claude",
    zenNewTask: "Nueva tarea",
    zenTaskDetails: "Detalles de la tarea",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Cliente móvil de Codex y Claude Code",
    subtitle:
      "Cifrado de extremo a extremo por defecto, con restauración de la cuenta en tus otros dispositivos.",
    createAccount: "Crear cuenta",
    chooseEncryptionTitle: "Elige el cifrado",
    chooseEncryptionBody: "Este servidor admite cuentas cifradas y no cifradas. Elige cómo quieres almacenar los datos de tu cuenta.",
    chooseEncryptionEncrypted: "Continuar con cifrado de extremo a extremo",
    chooseEncryptionPlain: "Continuar sin cifrado",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Continuar con ${provider}`,
    signInWithCertificate: "Iniciar sesión con certificado",
    linkOrRestoreAccount: "Vincular o restaurar cuenta",
    loginWithMobileApp: "Iniciar sesión con aplicación móvil",
    serverUnavailableTitle: "No se puede conectar al Relay",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `No podemos conectarnos a ${serverUrl}. Reintenta o elige otro Relay para continuar.`,
    serverIncompatibleTitle: "Relay no compatible",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `El Relay en ${serverUrl} devolvió una respuesta inesperada. Actualiza ese Relay o elige otro Relay para continuar.`,

    // Unified onboarding redesign — BrandPanel (left pane / mobile hero)
    brandTaglineLine1: "Empieza en cualquier lugar.",
    brandTaglineLine2: "Continúa en todas partes.",
    brandSubTagline: "Un centro de control para todos tus agentes de codificación con IA, en cada dispositivo que tengas.",
    brandTrustStrip: "CIFRADO DE EXTREMO A EXTREMO · CÓDIGO ABIERTO · AUTOALOJABLE",
    providerMarkRowAccessibilityLabel: "Agentes de codificación con IA compatibles",

    // Unified onboarding redesign — welcome decision (right pane)
    welcomeQuestionTitle: "Te damos la bienvenida.",
    welcomeQuestionSubtitle: "¿Es tu primera vez aquí?",
    welcomeQuestionBody: "Happier es el centro de control de tus agentes de codificación con IA. No hace falta correo electrónico. Tu cuenta es una clave privada que se genera en este dispositivo.",

    welcomePrimaryButton: "Primera vez aquí — empecemos",
    welcomePrimarySubtitle: "Un toque. Sin formulario. Tu clave vive aquí.",

    welcomeSecondaryButton: "Iniciar sesión — ya uso Happier",
    welcomeSecondarySubtitle: "Escanea un código QR o introduce tu clave secreta",

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
    welcomeReturningTitle1: "Hola de nuevo.",
    welcomeReturningTitle2: "Qué bueno verte.",
    welcomeReturningTitle3: "Qué bien que estés aquí.",
    welcomeReturningTitle4: "Bienvenido a casa.",
    welcomeReturningSubtitle1: "Sigamos donde lo dejamos.",
    welcomeReturningSubtitle2: "¿Listo para empezar?",
    welcomeReturningSubtitle3: "¿Qué construimos hoy?",

    // Returning-user buttons. For returning users we invert the visual
    // hierarchy: Login becomes the filled primary action (probability of
    // intent is high), Start fresh becomes the bordered secondary action.
    // "I already use Happier" is dropped from the login button title for
    // returning users because — they obviously do already use Happier.
    welcomeReturningLoginButton: "Iniciar sesión — sigamos donde lo dejamos",
    welcomeReturningStartFreshButton: "Empieza de nuevo — crea una cuenta nueva",
    welcomeReturningStartFreshSubtitle: "Genera una clave nueva en este dispositivo.",

    // Welcome step footer links
    welcomeFooterRelay: "¿Autoalojado?",
    welcomeFooterRelayAction: "Usa tu propio Relay",
    // Shown in place of welcomeFooterRelay when the active server is a
    // custom (non-Happier-Cloud) relay. The action below the label is the
    // relay's host (optionally with :port) followed by a small pencil
    // icon so the user can tap to edit. Long hostnames are truncated with
    // a tail-ellipsis to avoid colliding with the right-side Docs group.
    welcomeFooterRelayActiveLabel: "Tu relay:",
    welcomeFooterRelayEditAccessibility: "Cambiar relay",
    welcomeFooterDocs: "¿Necesitas ayuda?",
    welcomeFooterDocsAction: "Documentación",
    welcomeFooterGithubLabel: "Repositorio de GitHub",
    welcomeFooterDiscordLabel: "Comunidad de Discord",

    // Mobile brand hero CTA
    brandHeroGetStarted: "Empezar",
  },

      sessionGettingStarted: {

          title: {

              connectMachine: 'Configura este ordenador',

              startDaemon: 'Reconecta este ordenador',

              createSession: 'Crea una sesión',

              selectSession: 'Selecciona una sesión',

              loading: 'Cargando…',

          },
        cliFollowUpTitle: 'Alternativa por terminal (opcional)',
        manualDisclosure: {
            show: 'Mostrar los pasos manuales del terminal',
            hide: 'Ocultar los pasos manuales del terminal',
        },

          subtitle: {

              connectMachine: ({ targetLabel }: { targetLabel: string }) =>

                  `Usa el flujo de configuración de escritorio para conectar este ordenador a ${targetLabel}. Abre los pasos manuales solo si prefieres la ruta del terminal.`,

              startDaemon: ({ targetLabel }: { targetLabel: string }) =>

                  `Usa el flujo de configuración de escritorio para reconectar el servicio en segundo plano de ${targetLabel}. Abre los pasos manuales solo si ya estás en ese ordenador.`,

              createSession: 'Inicia una sesión nueva con el botón + o desde tu terminal.',

              selectSession: 'Elige una sesión en la barra lateral para verla aquí.',

              loading: 'Obteniendo tus máquinas y sesiones…',

          },

          steps: {

              openSetup: {

                  title: 'Usa el flujo de configuración de escritorio',

                  description: 'Esta es la ruta recomendada. Configura el Relay, instala el servicio en segundo plano y mantiene el resto de la configuración en la app.',

              },

              startDaemonOpenSetup: {

                  description: 'Usa el flujo de configuración de escritorio para reconectar o reparar el servicio en segundo plano en este ordenador antes de recurrir a comandos de terminal.',

              },

              installCli: {

                  title: 'Instala la CLI',

                  description: 'Ejecuta esto una vez en la máquina que quieres conectar.',

                  copyLabel: 'Comando de instalación',

              },

              serverSetup: {

                  title: 'Establece el Relay activo',

                  description: 'Es un paso único para que los siguientes comandos apunten al Relay correcto.',

                  copyLabel: 'Configuración de Relay',

              },

              authLogin: {

                  title: 'Inicia sesión',

                  description: 'Esto muestra un QR o enlace para conectar tu terminal a tu cuenta.',

                  copyLabel: 'Inicio de sesión',

              },

              daemonInstall: {

                  title: 'Instala el servicio en segundo plano (recomendado)',

                  description: 'Mantiene Happier listo en segundo plano para inicios remotos.',

                  copyLabel: 'Instalación del daemon',

              },

              startDaemonInstall: {

                  description: 'Instala un servicio de usuario siempre activo y lo inicia.',

              },

              daemonStart: {

                  title: 'Inicia el servicio en segundo plano una vez',

                  description: 'Úsalo si solo lo necesitas en ejecución ahora mismo.',

                  copyLabel: 'Inicio del daemon',

              },

              createSession: {

                  title: 'Crea una sesión',

                  description: 'Usa el botón + de la app o ejecuta una de estas opciones desde tu terminal.',

                  copyLabel: 'Crear sesión',

              },

              startSession: {

                  title: 'Inicia una sesión desde tu ordenador',

                  description: 'O usa el botón + de la app.',

                  copyLabel: 'Iniciar sesión',

              },

          },

      },


  setupOnboarding: {
		          screenTitle: 'Configura este ordenador',
		          welcomeTitle: 'Bienvenido a Happier',
			          welcomeBody: 'Happier conecta tu teléfono y tus ordenadores a través de un Relay, para que tus sesiones te sigan en todas partes.',
			          welcomeBody2: 'Código abierto. Cifrado de extremo a extremo. Conocimiento cero.',
			          welcomeBody3: 'Hecho por desarrolladores, para desarrolladores.',
			          providersShowcaseLabel: 'Funciona con:',
	          letsStart: 'Empecemos',
	          scanQrCode: 'Escanear código QR',
          recommendedBadge: 'Recomendado',
	          relayCloudTitle: 'Happier Cloud',
	          relayCloudSubtitle: 'Relay alojado — la forma más fácil de empezar',
	          relayOnThisComputerTitle: 'En este ordenador',
	          relayOnThisComputerSubtitle: 'Ejecuta el relay localmente en este ordenador y añade Tailscale para acceso desde el teléfono',
	          relayOnYourComputerTitle: 'En tu ordenador',
	          relayOnYourComputerSubtitle: 'Ejecuta el relay localmente en tu ordenador y añade Tailscale para acceso desde el teléfono',
	          relayOnRemoteComputerTitle: 'Configura un relay en un ordenador remoto',
	          relayOnRemoteComputerSubtitle: 'Aloja el relay en un ordenador remoto por SSH',
	          remoteRelayHostInstallTitle: 'Aloja un Relay en el ordenador remoto',
	          relayAccessWizardTitle: '¿Cómo debería tu teléfono acceder a este relay?',
	          relayAccessUrlTitle: 'URL del relay',
	          relayAccessUrlSubtitle: 'Introduce un URL al que tu teléfono pueda acceder.',
	          relayAccessUrlBody: 'Puede ser una dirección LAN, un dominio personalizado o un URL de túnel, siempre que tu teléfono pueda abrirlo.',
	          relayAccessCloudflareTitle: 'Túnel de Cloudflare',
	          relayAccessCloudflareSubtitle: 'Expón tu relay mediante un túnel con nombre de Cloudflare.',
	          relayAccessCloudflareBody: 'Crea o selecciona un túnel con nombre y lo configuraremos para reenviar al relay local.',
          changeRelay: 'Cambiar relay',
          relayCustomUrlTitle: 'Relay existente',
          relayCustomUrlSubtitle: 'Usa una URL de relay que ya tengas en marcha',
          authRestoreTitle: 'Restaurar o añadir este dispositivo',
          authRestoreSubtitle: 'Usa un código QR o un enlace para conectar este dispositivo',
          authSecretKeyTitle: 'Iniciar sesión con clave secreta',
          authSecretKeySubtitle: 'Introduce tu clave secreta para iniciar sesión en Happier',
          authLostAccessTitle: '¿Perdiste el acceso?',
          authLostAccessSubtitle: 'Restablece tu cuenta con tu proveedor de identidad',
          webRelayHostHandoffTitle: 'Configura un Relay en tu ordenador',
          webRelayHostHandoffBody: 'Para alojar un Relay en este ordenador, usa la app de escritorio o la CLI. Te guiaremos y luego podrás pegar aquí la URL del Relay para continuar.',
          webDesktopOnlyTitle: 'Se requiere la app de escritorio',
          webDesktopOnlyBody: 'Abre la app de escritorio para configurar este ordenador. La app web puede mostrar el estado, pero no puede instalar ni configurar el servicio en segundo plano.',
          webDesktopOnlyPrimary: 'Tengo una URL de Relay',
          webDesktopOnlyDesktopAppTitle: 'Continúa esta configuración en la app de escritorio',
          webDesktopOnlyDesktopAppSubtitle: 'Descarga y abre Happier para configurar este ordenador con una guía.',
          webDesktopOnlyDesktopAppButton: 'Descargar app de escritorio',
          webDesktopOnlyCliTitle: 'Instala la CLI en este ordenador',
          webDesktopOnlyCliSubtitle: 'Ejecuta esto una vez en un terminal (no se requiere Node).',
          handoffPlatformPosixLabel: 'macOS/Linux',
          handoffPlatformMacosLabel: 'macos',
          handoffPlatformLinuxLabel: 'linux',
          handoffPlatformWindowsLabel: 'Windows',
          orDividerLabel: 'o',
          webDesktopOnlySetupCommandTitle: 'Configura este ordenador usando la CLI',
          webDesktopOnlySetupCommandSubtitle: 'Ejecuta un solo comando para configurar el relay, iniciar sesión si es necesario e instalar el servicio en segundo plano.',
          webDesktopOnlySetupRemotePrereqsSubtitle: 'Ejecuta un solo comando para configurar el relay e iniciar sesión antes de configurar un equipo remoto por SSH.',
          webDesktopHandoffDesktopAppOption: 'Usar la app de escritorio (recomendado)',
          webDesktopHandoffDesktopAppSubtitle: 'Descarga y abre Happier para alojar un Relay con un flujo guiado.',
          webDesktopHandoffCliOption: 'Usar el terminal (CLI)',
          webDesktopHandoffCliSubtitle: 'Ejecuta algunos comandos para alojar un Relay y luego pega aquí la URL que se muestre.',
          webDesktopOnlyRelayInstallTitle: 'Aloja un Relay en este ordenador',
	          webDesktopOnlyRelayInstallSubtitle: 'Esto instala y arranca el host de Relay. Luego pega aquí la URL de Relay que se muestre.',
	          webDesktopOnlyRelayStatusTitle: 'Obtén la URL de Relay',
	          webDesktopOnlyRelayStatusSubtitle: 'Ejecuta esto para ver la URL de Relay y luego pégala aquí.',
	          webDesktopOnlyOptionalNextTitle: 'Opcional: acceso seguro y proveedores',
	          webDesktopOnlyOptionalNextBody: 'Después de instalar Happier, abre Ajustes → Acceso seguro (Tailscale) para conectar tu teléfono, y Ajustes → Proveedores para instalar tus herramientas preferidas.',
			          preAuthTitle: '¿Dónde vive tu relay?',
	          preAuthBody: 'Tu relay enruta mensajes entre tu teléfono y tus ordenadores. Elige dónde vive: puedes cambiarlo más tarde.',
          preAuthContinueHint: 'Cuando continúes, Happier te devolverá a iniciar sesión contra el Relay seleccionado y luego volverá aquí para terminar la configuración.',
	    currentRelayTitle: 'Servidor actual',
	    selectedRelayFooterLabel: 'Servidor actual',
	    selectedRelayFooterLine: ({ relay }: { relay: string }) => `Servidor activo: ${relay}`,
	    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Relay actual: ${relayUrl}`,
	    accountWillLiveOnRelay: ({ relayUrl }: { relayUrl: string }) => `Tu cuenta estará en ${relayUrl}.`,
	    savedRelaysTitle: 'Relays guardados',
        removeRelayConfirmTitle: '¿Eliminar relay?',
        removeRelayConfirmBody: 'Esto lo elimina de tus relays guardados en este dispositivo.',
	    customRelayUrlLabel: 'URL de Relay',
    relayNameLabel: 'Nombre de Relay',
    addAndUseRelay: 'Agregar Relay',
    changeRelayAction: 'Usar otra URL de Relay',
	          continueToAuth: 'Continuar con el Relay seleccionado',
	          continueWithLocalRelayAction: 'Usar este Relay local y continuar',
	          confirmSwitchRelayTitle: '¿Cambiar a este Relay?',
	          confirmSwitchRelaySubtitle: 'Esto hará que el Relay seleccionado sea el activo en este dispositivo.',
	          confirmSwitchRelayKeepTitle: 'Mantener el Relay actual',
	          confirmSwitchRelayKeepSubtitle: 'Continuar sin cambiar de Relay por ahora',
	          confirmSwitchRelaySwitchTitle: 'Cambiar a este Relay',
	          confirmSwitchRelaySwitchSubtitle: 'Puede que necesites iniciar sesión de nuevo en el nuevo Relay',
	          confirmSwitchRelayWarning: 'Puedes cambiar tu relay más tarde en Ajustes → Relay.',
	    postAuthTitle: 'Termina de configurar este ordenador',
	    postAuthBody: 'Has iniciado sesión. Continúa con el flujo de configuración local para dejar este ordenador listo para el Relay seleccionado.',
        setupThisComputerTitle: 'Configura este ordenador',
	    controlPanelTitle: 'Resumen de preparación',
    activeRelaySummaryTitle: 'Relay activo',
    thisComputerSummaryTitle: 'Este ordenador',
    nextActionSummaryTitle: 'Siguiente acción',
    thisComputerReady: 'Listo para este Relay',
    nextActionReady: 'Crea tu primera sesión o añade otro ordenador abajo.',
    thisComputerStages: {
        installToolsTitle: 'Instala las herramientas de Happier',
        installToolsSubtitle: 'Instala las herramientas locales de línea de comandos de Happier necesarias para configurar este ordenador.',
        installToolsReadySubtitle: 'Las herramientas locales de Happier ya están disponibles en este ordenador.',
        installToolsDetails: 'Nos aseguramos de que el entorno de ejecución gestionado de Happier usado por la configuración local esté disponible y sincronizamos el comando de terminal correspondiente para este canal de lanzamiento.',
        installToolsChildTitle: 'Instala las herramientas locales de línea de comandos de Happier',
        useRelayTitle: 'Usa este Relay',
        useRelayAccountMismatchSubtitle: 'Cambia a la cuenta que pertenece a este servidor antes de continuar.',
        useRelayNeedsAuthSubtitle: 'Inicia sesión o crea una cuenta para continuar la configuración de este servidor.',
        useRelaySignedInSubtitle: 'La cuenta actual ya ha iniciado sesión y está lista para usar este servidor.',
        useRelayServerMismatchSubtitle: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `Servidor de la app: ${activeRelayUrl}. Servicio en segundo plano: ${daemonRelayUrl}.`,
        useRelayConnectedSubtitle: ({ relayUrl }: { relayUrl: string }) => `Conectado a ${relayUrl}.`,
        useRelayMissingSubtitle: 'Elige o añade un servidor para continuar.',
        useRelayDetails: 'Confirmamos qué Relay y qué cuenta debe usar este ordenador antes de iniciar el registro local.',
        backgroundServiceTitle: 'Servicio en segundo plano',
        backgroundServiceDecisionSubtitle: 'Elige cómo este ordenador debe asumir el servicio en segundo plano predeterminado.',
        backgroundServiceRunningSubtitle: 'El servicio en segundo plano está instalado y en ejecución.',
        backgroundServiceInstalledSubtitle: 'El servicio en segundo plano está instalado y debe iniciarse.',
        backgroundServiceSubtitle: 'Instala e inicia el servicio en segundo plano de este ordenador.',
        backgroundServiceDetails: 'El servicio en segundo plano mantiene este ordenador listo para futuros inicios y lo vuelve a conectar automáticamente al Relay seleccionado.',
        backgroundServiceReleaseChannelChildTitle: 'Resuelve la titularidad del canal de lanzamiento',
        backgroundServiceConflictChildTitle: 'Resuelve los conflictos existentes del servicio en segundo plano',
        registerComputerTitle: 'Registra este ordenador',
        registerComputerDoneSubtitle: 'Este ordenador ya está registrado en tu cuenta.',
        registerComputerNeedsAuthSubtitle: 'Inicia sesión antes de registrar este ordenador.',
        registerComputerReconnectSubtitle: 'Vuelve a conectar este ordenador después de actualizar la configuración del servidor.',
        registerComputerSubtitle: 'Conecta este ordenador a tu cuenta en el servidor seleccionado.',
        registerComputerDetails: 'Registramos este ordenador en tu cuenta en el Relay seleccionado para que las sesiones locales y las funciones en segundo plano puedan identificar correctamente esta máquina.',
        footerHint: 'Nos ocupamos de los pasos de configuración de bajo nivel y solo te mostramos las decisiones que requieren tu intervención.',
    },
    resumeIntentTitle: 'Continuar la configuración en este ordenador',
          resumeIntentBody: 'Inicia sesión o crea una cuenta para seguir configurando este ordenador para el Relay seleccionado.',
    openSetupAction: 'Configura este ordenador',
    openSetupWizardAction: 'Abrir asistente de configuración',
    openSetupWizardSubtitle: 'Usa el flujo guiado para configurar Happier en tu ordenador.',
    setupNewMachineAction: 'Configura una nueva máquina',
    setupNewRelayAction: 'Configura un nuevo relay',
    remoteHosts: {
        hostPickerTitle: 'Host remoto',
        hostPickerSubtitle: 'Reutiliza un perfil SSH guardado o añade uno nuevo.',
        newHostOption: 'Nuevo host…',
        saveHostTitle: 'Guardar este host',
        saveHostSubtitle: 'Guarda este perfil SSH en tu cuenta.',
        savePasswordTitle: 'Guardar contraseña',
        savePasswordSubtitle: 'Almacena la contraseña SSH cifrada en reposo.',
        savePrivateKeyTitle: 'Guardar clave privada',
        savePrivateKeySubtitle: 'Almacena la clave privada SSH cifrada en reposo.',
        privateKeyLabel: 'Clave privada',
    },
    remoteSshChecklist: {
        planTitle: 'Revisa el plan de configuración',
        planSubtitleMachine: 'Este plan instala la CLI remota, configura el Relay e instala el servicio en segundo plano.',
        planSubtitleRelayHost: 'Este plan instala la CLI remota, configura el Relay e instala el runtime del Relay.',
        executionTitle: 'Configurando la máquina remota',
        executionSubtitle: 'La lista de verificación se actualiza mientras se ejecuta el arranque remoto.',
        completeTitle: 'Máquina remota lista',
        completeSubtitleMachine: 'La configuración de la máquina remota finalizó correctamente.',
        trustHostTitle: 'Confiar en el host SSH',
        trustHostSubtitle: 'Verifica la huella de la máquina remota antes de conectarte.',
        trustHostDetails: 'Verificamos la clave de host SSH y rechazamos huellas inesperadas a menos que las aceptes explícitamente.',
        installCliTitle: 'Instalar la CLI de Happier',
        installCliSubtitle: 'Copia la CLI de Happier en la máquina remota.',
        installCliDetails: 'La máquina remota necesita la CLI de Happier para que el resto del arranque pueda ejecutarse allí.',
        configureRelayTitle: 'Configurar el Relay',
        configureRelaySubtitle: 'Apunta la máquina remota al Relay activo y a la app web.',
        configureRelayDetails: 'La CLI remota se configura para hablar con el Relay activo y autenticar esta máquina en tu cuenta.',
        installDaemonTitle: 'Instalar el servicio en segundo plano',
        installDaemonSubtitle: 'Mantén Happier ejecutándose en segundo plano en la máquina remota.',
        installDaemonDetails: 'El servicio en segundo plano mantiene la máquina remota conectada y lista para futuras sesiones.',
        startFailed: 'No se pudo iniciar la configuración SSH remota.',
        continueFailed: 'No se pudo continuar la configuración SSH remota.',
    },
      },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "¿Disfrutando la aplicación?",
    feedbackPrompt: "¡Nos encantaría escuchar tus comentarios!",
    yesILoveIt: "¡Sí, me encanta!",
    notReally: "No realmente",
  },

	  items: {
	    // Used by Item component for copy toast
	    copiedToClipboard: ({ label }: { label: string }) =>
	      `${label} copiado al portapapeles`,
	    failedToCopyToClipboard: "No se pudo copiar al portapapeles",
	  },

    machine: {
    offlineUnableToSpawn:
      "El lanzador está deshabilitado mientras la máquina está desconectada",
    offlineHelp:
      "• Asegúrate de que tu computadora esté en línea\n• Ejecuta happier daemon status para diagnosticar\n• ¿Estás usando la última versión del CLI? Ejecuta happier self update",
    launchNewSessionInDirectory: "Iniciar nueva sesión en directorio",
    customPathPlaceholder: "Ingresa una ruta personalizada",
    tools: {
      title: "Herramientas",
      installablesTitle: "Instalables",
      installablesSubtitle:
        "Gestiona las herramientas instalables para esta máquina.",
    },
    installables: {
      screenTitle: "Instalables",
      aboutGroupTitle: "Acerca de",
      aboutSubtitle:
        "Gestiona las herramientas que Happier puede instalar y mantener actualizadas en esta máquina.",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title} (experimental)`,
      autoInstallTitle: "Auto-instalar cuando sea necesario",
      autoInstallSubtitle:
        "Se instala en segundo plano cuando es necesario para un backend seleccionado (mejor esfuerzo).",
      autoUpdateTitle: "Auto-actualizar",
      autoUpdatePromptTitle: "Auto-actualizar",
      autoUpdatePromptBody:
        "Elige cómo debe gestionar Happier las actualizaciones de este instalable.",
      autoUpdateModes: {
        off: "Desactivado",
        notify: "Notificar",
        auto: "Automático",
      },
    },
    daemon: "Demonio",
    status: "Estado",
    daemonStatus: {
      unknown: "Desconocido",
      stopped: "Detenido",
      likelyAlive: "Probablemente activo",
    },
    stopDaemon: "Detener daemon",
    stopDaemonConfirmTitle: "¿Detener daemon?",
    stopDaemonConfirmBody:
      "No podrás crear nuevas sesiones en esta máquina hasta que reinicies el daemon en tu computadora. Tus sesiones actuales seguirán activas.",
    daemonStoppedTitle: "Daemon detenido",
    stopDaemonFailed:
      "No se pudo detener el daemon. Puede que no esté en ejecución.",
    renameTitle: "Renombrar máquina",
    renameDescription:
      "Dale a esta máquina un nombre personalizado. Déjalo vacío para usar el hostname predeterminado.",
      renamePlaceholder: "Ingresa el nombre de la máquina",
      renamedSuccess: "Máquina renombrada correctamente",
      renameFailed: "No se pudo renombrar la máquina",
      actions: {
        removeMachine: "Eliminar máquina",
        removeMachineSubtitle:
          "Revoca esta máquina y la elimina de tu cuenta.",
        removeMachineConfirmBody:
          "Esto revocará el acceso de esta máquina (incluidas las claves de acceso y asignaciones de automatización). Puedes volver a conectarla iniciando sesión de nuevo desde el CLI.",
        removeMachineAlreadyRemoved:
          "Esta máquina ya se ha eliminado de tu cuenta.",
      },
      replacementRepair: {
        replaceWithMachine: "Marcar como reemplazada",
        replaceWithMachineSubtitle: ({ machine }: { machine: string }) =>
          `Usar ${machine} como reemplazo de esta máquina.`,
        chooseReplacementSubtitle: "Elige qué máquina reemplaza a esta.",
        pickerTitle: "Elegir máquina de reemplazo",
        pickerCandidatesTitle: "Máquinas elegibles",
        confirmTitle: "¿Marcar máquina como reemplazada?",
        confirmBody: ({ machine }: { machine: string }) =>
          `Los lanzamientos futuros y las sesiones antiguas de esta máquina usarán ${machine}.`,
        confirmAction: "Reemplazar",
        undo: "Deshacer reemplazo",
        undoSubtitle: ({ machine }: { machine: string }) =>
          `Esta máquina está reemplazada actualmente por ${machine}.`,
        undoConfirmTitle: "¿Deshacer reemplazo de máquina?",
        undoConfirmBody:
          "Esta máquina volverá a aparecer como destino de lanzamiento si está disponible.",
        undoAction: "Deshacer",
        error: "No se pudo actualizar el reemplazo de la máquina.",
      },
      lastKnownPid: "Último PID conocido",
      lastKnownHttpPort: "Último puerto HTTP conocido",
      startedAt: "Iniciado en",
      cliVersion: "Versión del CLI",
    daemonStateVersion: "Versión del estado del daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Sesiones activas (${count})`,
    machineGroup: "Máquina",
    host: "Host (servidor)",
    machineId: "ID de máquina",
    username: "Nombre de usuario",
    homeDirectory: "Directorio principal",
    platform: "Plataforma",
    architecture: "Arquitectura",
    lastSeen: "Visto por última vez",
    never: "Nunca",
    metadataVersion: "Versión de metadatos",
    detectedClis: "CLI detectados",
    detectedCliDetected: "Detectado",
    detectedCliNotDetected: "No detectado",
    detectedCliUnknown: "Desconocido",
    detectedCliNotSupported: "No compatible (actualiza @happier-dev/cli)",
    untitledSession: "Sesión sin título",
    back: "Atrás",
    notFound: "Máquina no encontrada",
    unknownMachine: "máquina desconocida",
    unknownPath: "ruta desconocida",
    previousSessionsTitle: "Sesiones anteriores (hasta las 5 más recientes)",
    tmux: {
      overrideTitle: "Sobrescribir la configuración global de tmux",
      overrideEnabledSubtitle:
        "La configuración personalizada de tmux se aplica a las nuevas sesiones en esta máquina.",
      overrideDisabledSubtitle:
        "Las nuevas sesiones usan la configuración global de tmux.",
      notDetectedSubtitle: "tmux no se detecta en esta máquina.",
      notDetectedMessage:
        "tmux no se detecta en esta máquina. Instala tmux y actualiza la detección.",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "Mostrar consola para sesiones remotas",
      remoteSessionConsoleVisibleSubtitle:
        "Las sesiones remotas se abren en una ventana de consola visible en esta máquina.",
      remoteSessionConsoleHiddenSubtitle:
        "Las sesiones remotas se inician ocultas para evitar ventanas que se abren/cierran.",
      remoteSessionConsoleUpdateFailed:
        "No se pudo actualizar la configuración de consola de sesión en Windows.",
      remoteSessionModeTitle: "Modo de sesión remota",
      remoteSessionModeOverrideTitle: "Anular el modo global de sesión remota de Windows",
      remoteSessionModeOverrideEnabledSubtitle:
        "Esta máquina usa su propio modo de sesión remota de Windows.",
      remoteSessionModeOverrideDisabledSubtitle:
        "Esta máquina sigue tu modo global de sesión remota de Windows.",
      windowsTerminalUnavailableSuffix: "Windows Terminal no se detecta en esta máquina.",
    },

    backgroundServiceModes: {
      generic: "servicio en segundo plano",
      defaultFollowing: "servicio en segundo plano predeterminado",
      legacyPinned: "servicio en segundo plano fijado heredado",
    },
    backgroundServicePrompt: {
        targetServer: 'Servidor de destino',
        targetReleaseChannel: 'Canal de lanzamiento de destino',
        existingServices: 'Servicios existentes:',
        running: 'en ejecución',
    },
    repairBackgroundServiceAction: "Reparar servicio en segundo plano",
    repairBackgroundServiceProgressTitle: "Reparando servicio en segundo plano",
    runtimeInventory: 'Inventario del runtime de Happier',
    runtimeInventoryOverview: 'Resumen',
    runtimeInventoryInstallations: 'Instalaciones',
    runtimeInventoryServices: 'Servicios',
    runtimeInventoryWarnings: 'Advertencias',
    doctorRepairSummary: 'Resumen de reparación',
    doctorRepairFindingsSummary: ({ total, warning, error, actionable }: {
        total: number;
        warning: number;
        error: number;
        actionable: number;
    }) => `${total} hallazgos • ${warning} advertencias • ${error} errores • ${actionable} accionables`,
    localRelays: 'Relays locales',
    runtimeSummary: ({ cliVersion, daemonVersion, daemonRing, installationCount, serviceCount, warningCount }: {
        cliVersion: string;
        daemonVersion: string;
        daemonRing: string;
        installationCount: number;
        serviceCount: number;
        warningCount: number;
    }) => `CLI ${cliVersion} • daemon ${daemonVersion} (${daemonRing}) • ${installationCount} installations • ${serviceCount} services • ${warningCount} warnings`,
    transferExposure: {
      title: "Exposición de transferencia",
      status: "Exposición de transferencia",
      loopbackHttp: "Loopback (local)",
      tailscaleServeHttps: "Tailscale Serve (HTTPS)",
      stateUnknown: "Desconocido",
      stateDisabled: "Deshabilitado",
      stateUnconfigured: "Sin configurar",
      stateApprovalNeeded: "Se requiere aprobación",
      stateInactive: "Configurado (inactivo)",
      stateStale: "Configurado (obsoleto)",
      stateActive: "Activo",
      stateUnavailable: "No disponible",
    },},

  message: {
      sessionReferenceUnavailable: "Sesión no disponible",
      sessionReferenceOpen: ({ name }: { name: string }) => `Abrir la sesión ${name}`,
    switchedToMode: ({ mode }: { mode: string }) => `Cambiado al modo ${mode}`,
    discarded: "Descartado",
    recoveredHistory: "Historial recuperado",
    pluginAttribution: ({ pluginId }: { pluginId: string }) => `Del complemento ${pluginId}`,
    unknownEvent: "Evento desconocido",
    runtimeConfigOutcomeAppliesBeforeNextMessage: 'Se aplicará antes de tu próximo mensaje',
    runtimeConfigOutcomeQueuedUntilReady: 'En cola hasta que esté listo',
    runtimeConfigOutcomeAlreadySet: 'Ya configurado',
    runtimeConfigOutcomeSessionMode: 'Modo de sesión',
    runtimeConfigOutcomeKeyModel: 'Modelo',
    runtimeConfigOutcomeKeyFallbackModel: 'Modelo alternativo',
    runtimeConfigOutcomeKeyPermissionMode: 'Modo de permisos',
    runtimeConfigOutcomeKeyReasoningEffort: 'Esfuerzo de razonamiento',
    runtimeConfigOutcomeKeyMaxThinkingTokens: 'Presupuesto de razonamiento',
    runtimeConfigOutcomeKeyLaunchOption: 'Opción de inicio',
    runtimeConfigOutcomeRequiresRestart: 'Requiere reinicio',
    runtimeConfigOutcomeRequiresInteractiveControl: 'Requiere interacción en la terminal',
    runtimeConfigOutcomeUnsupported: 'No compatible',
    runtimeConfigOutcomeFailed: 'No se pudo aplicar',
    contextCompactionStarted: "Compactando contexto...",
    contextCompactionCompleted: "Contexto compactado",
    contextCompactionFailed: "Error al compactar el contexto",
    contextCompactionCancelled: "Compactación de contexto cancelada",
    contextCompactionPaused: "Contexto compactado; envía un mensaje para continuar",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Límite de uso alcanzado hasta ${time}`,
    connectedServiceAccountSwitch: ({ provider, from, to }: { provider: string; from: string; to: string }) =>
      `Cuenta de ${provider} cambiada de ${from} a ${to}`,
    connectedServiceGroupAccountSwitch: ({ provider, group, from, to }: { provider: string; group: string; from: string; to: string }) =>
      `Grupo ${group} de ${provider} cambiado de ${from} a ${to}`,
    connectedServiceSwitchGroupSelection: ({ group, profile }: { group: string; profile: string }) =>
      `grupo ${group} · ${profile}`,
    connectedServiceSwitchProfileSelection: ({ profile }: { profile: string }) => `perfil ${profile}`,
    connectedServiceSwitchDeferred: 'Cambio de cuenta aplazado hasta el límite de turno',
    connectedServiceSwitchDeferredIdle: 'Cambio de cuenta aplazado hasta que la sesión esté inactiva',
    connectedServiceSwitchDeferralCompleted: 'Cambio de cuenta listo',
    connectedServiceSwitchDeferralCancelled: 'Cambio de cuenta cancelado',
    connectedServiceSwitchDeferralSuperseded: 'Cambio de cuenta reemplazado por uno más reciente',
    agentStateSharingDegraded: 'Compartición de estado del proveedor aplicada parcialmente',
    agentQuotaWait: ({ time }: { time: string }) =>
      `Esperando a que la cuota del proveedor se restablezca a las ${time}`,
    agentQuotaRecovered: "Cuota del proveedor recuperada",
    connectedServiceRuntimeAuthRecoveryRecovered: "Autenticación del proveedor recuperada",
    connectedServiceRuntimeAuthRecoveryCancelled: "Recuperación de autenticación del proveedor cancelada",
    unknownTime: "tiempo desconocido",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "Los permisos se muestran solo en el terminal. Restablece o envía un mensaje para controlar desde la app.",
    sessionRunningLocally:
      "Esta sesión se está ejecutando localmente en este ordenador. Puedes cambiar a remoto para controlarla desde la app.",
    sessionRunningLocallyAndRemotely:
      "Esta sesión está conectada localmente en OpenCode y sigue siendo controlable desde la app.",
    switchingToRemote: "Cambiando al modo remoto…",
    switchToRemote: "Cambiar a remoto",
    detachLocalTerminal: "Desconectar terminal",
    directSessionTakeoverAvailable:
      "Esta sesión directa está disponible en tu máquina. Tómala en Happier para controlarla aquí.",
    directSessionMachineOffline:
      "Esta sesión directa no está disponible en este momento porque la máquina está sin conexión.",
    switchingToDirectTakeover: "Tomando esta sesión directa…",
    switchingToPersistedTakeover: "Tomando el control e importando esta sesión…",
    takeOverDirect: "Tomar control",
    takeOverPersist: "Tomar control + importar",
    directTakeoverDialogTitle: "¿Continuar esta sesión directa en Happier?",
    directTakeoverDialogBody: "Elige cómo quieres que Happier tome el control. Directo sigue usando la transcripción del proveedor. Importar lleva la transcripción a Happier.",
    directTakeoverDialogDirectTitle: "Tomar control",
    directTakeoverDialogDirectBody: "Controla esta sesión en Happier sin importar la transcripción a Happier.",
    directTakeoverDialogPersistTitle: "Tomar control + importar",
    directTakeoverDialogPersistBody: "Importa la transcripción a Happier y continúa con todas las funciones de una sesión Happier.",

    externalSessionTakeoverAvailable:
      "Esta sesión externa está lista para tomar el control en Happier.",
    externalSessionMachineOffline:
      "Esta sesión externa no está disponible en este momento porque la máquina está sin conexión.",
    checkingExternalSessionTakeover: "Comprobando las opciones de control…",
    externalSessionStatusUnavailable: "Happier no pudo comprobar esta sesión externa. Revisa la conexión de la máquina e inténtalo de nuevo.",
    externalSessionProcessRunning: "Parece que el Agent de esta sesión externa sigue ejecutándose.",
    externalSessionRecheck: "Volver a comprobar",
    externalSessionTakeoverBlocked: "Happier no pudo verificar que el Agent externo se haya detenido. Deténlo en su terminal e inténtalo de nuevo.",},

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "Sí, permitir globalmente",
        yesForSession: "Sí, y no preguntar por esta sesión",
        stop: "Detener",
        stopAndExplain: "Detener, y explicar qué hacer",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits: "Sí, permitir todas las ediciones durante esta sesión",
        yesForTool: "Sí, no volver a preguntar para esta herramienta",
        yesForCommandPrefix:
          "Sí, no volver a preguntar para este prefijo de comando",
        yesForSubcommand: "Sí, no volver a preguntar para este subcomando",
        yesForCommandName: "Sí, permitir cualquier comando coincidente en esta sesión",
        stop: "Detener",
        noTellClaude: "No, proporcionar comentarios",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "Seleccionar rango de texto",
    title: "Seleccionar texto",
    noTextProvided: "No se proporcionó texto",
    textNotFound: "Texto no encontrado o expirado",
    textCopied: "Texto copiado al portapapeles",
    failedToCopy: "Error al copiar el texto al portapapeles",
    noTextToCopy: "No hay texto disponible para copiar",
    failedToOpen: "No se pudo abrir la selección de texto. Intenta de nuevo.",
  },

    markdown: {
      // Markdown copy functionality
      codeCopied: "Código copiado",
      copyFailed: "Error al copiar",
      mermaidRenderFailed: "Error al renderizar el diagrama mermaid",
      diffLabel: "Diferencias",
      codeLabel: "Código",

      // Slash menu commands (Lane G)
      slash: {
          heading1: { label: 'Encabezado 1', description: 'Encabezado grande' },
          heading2: { label: 'Encabezado 2', description: 'Encabezado mediano' },
          heading3: { label: 'Encabezado 3', description: 'Encabezado pequeño' },
          bulletList: { label: 'Lista con viñetas', description: 'Lista no ordenada' },
          orderedList: { label: 'Lista numerada', description: 'Lista ordenada' },
          taskList: { label: 'Lista de tareas', description: 'Lista con casillas' },
          blockquote: { label: 'Cita', description: 'Bloque de cita' },
          codeBlock: { label: 'Bloque de código', description: 'Bloque de código delimitado' },
          horizontalRule: { label: 'Divisor', description: 'Línea horizontal' },
          groups: { headings: 'Encabezados', lists: 'Listas', blocks: 'Bloques' },
      },

      // Link bubble (Lane H)
      linkBubble: {
          open: 'Abrir',
          edit: 'Editar',
          unlink: 'Desvincular',
          cancel: 'Cancelar',
          save: 'Guardar',
          inputPlaceholder: 'Pegar o escribir un enlace…',
      },
    },

    // Accessibility labels for the rich markdown editor formatting toolbar.
    markdownEditorToolbar: {
      bold: "Negrita",
      italic: "Cursiva",
      strikethrough: "Tachado",
      code: "Código en linea",
      heading1: "Titulo 1",
      heading2: "Titulo 2",
      heading3: "Titulo 3",
      bulletList: "Lista con vinetas",
      orderedList: "Lista numerada",
      taskList: "Lista de tareas",
      blockquote: "Cita",
      codeBlock: "Bloque de codigo",
      horizontalRule: "Separador",
      openLink: "Abrir enlace",
      unlink: "Quitar enlace",
    },

    artifacts: {
    // Artifacts feature
    title: "Artefactos",
    countSingular: "1 artefacto",
    countPlural: ({ count }: { count: number }) => `${count} artefactos`,
    empty: "No hay artefactos aún",
    emptyDescription: "Crea tu primer artefacto para comenzar",
    new: "Nuevo artefacto",
    edit: "Editar artefacto",
    delete: "Eliminar",
    updateError:
      "No se pudo actualizar el artefacto. Por favor, intenta de nuevo.",
    deleteError: "No se pudo eliminar el artefacto. Intenta de nuevo.",
    notFound: "Artefacto no encontrado",
    discardChanges: "¿Descartar cambios?",
    discardChangesDescription:
      "Tienes cambios sin guardar. ¿Estás seguro de que quieres descartarlos?",
    deleteConfirm: "¿Eliminar artefacto?",
    deleteConfirmDescription: "Esta acción no se puede deshacer",
    noContent: "Sin contenido",
    untitled: "Sin título",
    titleLabel: "TÍTULO",
    titlePlaceholder: "Ingresa un título para tu artefacto",
    bodyLabel: "CONTENIDO",
    bodyPlaceholder: "Escribe tu contenido aquí...",
    emptyFieldsError: "Por favor, ingresa un título o contenido",
    createError: "No se pudo crear el artefacto. Por favor, intenta de nuevo.",
    save: "Guardar",
    saving: "Guardando...",
    loading: "Cargando artefactos...",
    error: "Error al cargar el artefacto",
  },

  friends: {
    // Friends feature
    title: "Amigos",
    sharedSessions: "Sesiones compartidas",
    noSharedSessions: "Aún no hay sesiones compartidas",
    manageFriends: "Administra tus amigos y conexiones",
    searchTitle: "Buscar amigos",
    pendingRequests: "Solicitudes de amistad",
    myFriends: "Mis amigos",
    noFriendsYet: "Aún no tienes amigos",
    findFriends: "Buscar amigos",
    remove: "Eliminar",
    pendingRequest: "Pendiente",
    sentOn: ({ date }: { date: string }) => `Enviado el ${date}`,
    accept: "Aceptar",
    reject: "Rechazar",
    addFriend: "Agregar amigo",
    alreadyFriends: "Ya son amigos",
    requestPending: "Solicitud pendiente",
    searchInstructions: "Ingresa un nombre de usuario para buscar amigos",
    searchPlaceholder: "Ingresa nombre de usuario...",
    searching: "Buscando...",
    userNotFound: "Usuario no encontrado",
    noUserFound: "No se encontró ningún usuario con ese nombre",
    checkUsername:
      "Por favor, verifica el nombre de usuario e intenta de nuevo",
    howToFind: "Cómo encontrar amigos",
    findInstructions:
      "Busca amigos por su nombre de usuario. Dependiendo de tu servidor, puede que necesites conectar un proveedor o elegir un nombre de usuario para usar Amigos.",
    emptyTitle: "Sin actividad de amigos",
    emptyDescription: "Añade amigos para compartir sesiones y ver actividad aquí.",
    activity: "Actividad",
    requestSent: "¡Solicitud de amistad enviada!",
    requestAccepted: "¡Solicitud de amistad aceptada!",
    requestRejected: "Solicitud de amistad rechazada",
    friendRemoved: "Amigo eliminado",
    confirmRemove: "Eliminar amigo",
    confirmRemoveMessage: "¿Estás seguro de que quieres eliminar a este amigo?",
    cannotAddYourself: "No puedes enviarte una solicitud de amistad a ti mismo",
    bothMustHaveGithub:
      "Ambos usuarios deben tener conectado el proveedor requerido para ser amigos",
    status: {
      none: "No conectado",
      requested: "Solicitud enviada",
      pending: "Solicitud pendiente",
      friend: "Amigos",
      rejected: "Rechazada",
    },
    acceptRequest: "Aceptar solicitud",
    removeFriend: "Eliminar de amigos",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `¿Estás seguro de que quieres eliminar a ${name} de tus amigos?`,
    requestSentDescription: ({ name }: { name: string }) =>
      `Tu solicitud de amistad ha sido enviada a ${name}`,
    requestFriendship: "Solicitar amistad",
    cancelRequest: "Cancelar solicitud de amistad",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `¿Cancelar tu solicitud de amistad a ${name}?`,
    denyRequest: "Rechazar solicitud",
    nowFriendsWith: ({ name }: { name: string }) =>
      `Ahora eres amigo de ${name}`,
    disabled: "Amigos está desactivado en este servidor.",
    username: {
      required: "Elige un nombre de usuario para usar Amigos.",
      taken: "Ese nombre de usuario ya está en uso.",
      invalid: "Ese nombre de usuario no está permitido.",
      disabled:
        "Amigos con nombre de usuario no está habilitado en este servidor.",
      preferredNotAvailable:
        "Tu nombre de usuario preferido no está disponible en este servidor. Por favor, elige otro.",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `Tu nombre de usuario preferido @${login} no está disponible en este servidor. Por favor, elige otro.`,
    },
    githubGate: {
      title: "Conecta GitHub para usar Amigos",
      body: "Amigos usa nombres de usuario de GitHub para descubrir y compartir.",
      connect: "Conectar GitHub",
      notAvailable: "¿No está disponible?",
      notConfigured: "GitHub OAuth no está configurado en este servidor.",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `Conecta ${provider} para usar Amigos`,
      body: ({ provider }: { provider: string }) =>
        `Amigos usa nombres de usuario de ${provider} para descubrir y compartir.`,
      connect: ({ provider }: { provider: string }) => `Conectar ${provider}`,
      notAvailable: "¿No está disponible?",
      notConfigured: ({ provider }: { provider: string }) =>
        `${provider} OAuth no está configurado en este servidor.`,
    },
  },

  usage: {
    // Usage panel strings
    today: "Hoy",
    last7Days: "Últimos 7 días",
    last30Days: "Últimos 30 días",
    totalTokens: "Tokens totales",
    totalCost: "Costo total",
    tokens: "Tokens (IA)",
    cost: "Costo",
    usageOverTime: "Uso a lo largo del tiempo",
    byModel: "Por modelo",
    noData: {
      title: "No hay datos de uso disponibles",
      subtitle: "Los datos de uso aparecerán aquí después de tu primera sesión.",
    },
    errors: {
      notAuthenticated: "Necesitas iniciar sesión para ver el uso.",
      failedToLoad: "No se pudo cargar el uso.",
    },

    lastYear: "Último año",
    costMode: "Modo de coste",
    auto: "Automático",
    reported: "Informado",
    estimated: "Estimado",
    insights: "Información",
    activity: "Actividad",
    timeline: "Cronología",
    leaders: "Líderes",
    activeDays: "Días activos",
    modelsTried: "Modelos probados",
    favoriteModelChanges: "Cambios del modelo favorito",
    busiestWindow: "Franja más activa",
    activityCalendarSubtitle: "Mapa de calor del calendario",
    mostActiveMonths: "Meses más activos del período seleccionado",
    dailyActivity: "Actividad diaria del período seleccionado",
    mostActiveWeekdays: "Días de la semana más activos",
    mostActiveHours: "Horas del día más activas",
    events: "eventos",
    source: "Origen",
    sessionUsage: "Uso de la sesión",
    longestStreak: 'Racha más larga',
    dailyRhythm: 'Ritmo diario',
    eventsLabel: 'Eventos',
    daysShort: ({ count }: { count: number }) => `${count}d`,
    updatedCaption: 'Actualizado ahora mismo',
    whenYouWork: 'Cuándo trabajas',
    periodTodayShort: 'Hoy',
    period7dShort: '7D',
    period30dShort: '30D',
    periodYearShort: '1A',
    busiestTag: 'la más activa',
    vsPreviousPeriod: 'frente al periodo anterior',
    workRhythm: 'Ritmo de trabajo',
    weeks: "Semanas",
    messagesCaption: ({ count }: { count: number }) => `${count.toLocaleString()} mensajes`,
    modelMix: {
        title: "Mezcla de modelos a lo largo del tiempo",
        other: "Otros",
    },
    showAll: 'Mostrar todo',
    showLess: 'Mostrar menos',
    exportCsv: 'Descargar CSV',
    efficiency: {
        cacheHitRate: 'Tasa de aciertos de caché',
        cacheHitCaption: 'Proporción de tokens de entrada servidos desde la caché',
        costPerMtok: 'Coste por Mtok',
        costPerMtokCaption: 'Tarifa efectiva combinada por millón de tokens',
    },

    cacheSavings: 'Ahorro de caché',
    banner: {
        lifetimeTokens: 'Tokens de por vida',
        peakTokens: 'Tokens máximos',
        tokenActivity: 'Actividad de tokens',
        daily: 'Diario',
        weekly: 'Semanal',
        cumulative: 'Acumulado',
        activityInsights: 'Estadísticas de actividad',
        mostUsed: 'Más usados',
        days: ({ count }: { count: number }) => `${count} ${count === 1 ? 'día' : 'días'}`,
    },
    tokenMix: {
        input: 'Entrada',
        output: 'Salida',
        reasoning: 'Razonamiento',
        cacheRead: 'Lectura de caché',
        cacheWrite: 'Escritura de caché',
    },
    recap: {
        play: 'Ver resumen',
        shareImage: 'Compartir como imagen',
    },
    context: {
        title: 'Contexto y eficiencia',
        utilization: 'Contexto usado',
        window: 'Ventana',
        tokenMixTitle: 'Mezcla de tokens',
    },
    summary: {
      title: "Resumen de uso",
      currentStreak: "Racha actual",
      currentStreakSubtitle: ({ count }: { count: number }) => `${count} active days in the last 30`,
      currentStreakSubtitleForPeriod: ({ count, period }: { count: number; period: string }) => `${count} active days · ${period}`,
      thisWeek: "Esta semana",
      thisWeekSubtitle: "Impulso reciente",
      topModel: "Modelo principal",
      engine: "Motor",
      export: {
        session: "Sesión",
        period: "Periodo",
        metric: "Métrica",
        costMode: "Modo de coste",
        totalTokens: "Tokens totales",
        totalCost: "Coste total",
        activeDays: "Días activos",
        topModel: "Modelo principal",
        topEngine: "Motor principal",
        modelTimeline: "Cronología de modelos",
        engineTimeline: "Cronología de motores",
      },
    },},

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} te envió una solicitud de amistad`,
    friendRequestGeneric: "Nueva solicitud de amistad",
    friendAccepted: ({ name }: { name: string }) =>
      `Ahora eres amigo de ${name}`,
    friendAcceptedGeneric: "Solicitud de amistad aceptada",
  },

  secrets: {
    addTitle: "Nuevo secreto",
    savedTitle: "Secretos guardados",
    badgeReady: "Secreto",
    badgeRequired: "Se requiere secreto",
    missingForProfile: ({ env }: { env: string | null }) =>
      `Falta el secreto (${env ?? "secreto"}). Configúralo en la máquina o selecciona/introduce un secreto.`,
    defaultForProfileTitle: "Secreto predeterminado",
    defineDefaultForProfileTitle:
      "Definir secreto predeterminado para este perfil",
    addSubtitle: "Agregar un secreto guardado",
    noneTitle: "Ninguna",
    noneSubtitle:
      "Usa el entorno de la máquina o ingresa un secreto para esta sesión",
    emptyTitle: "No hay secretos guardados",
    emptySubtitle:
      "Agrega uno para usar perfiles con secreto sin configurar variables de entorno en la máquina.",
    savedHiddenSubtitle: "Guardada (valor oculto)",
    defaultLabel: "Predeterminada",
    fields: {
      name: "Nombre",
      value: "Valor",
    },
    placeholders: {
      nameExample: "p. ej., Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "El nombre es obligatorio.",
      valueRequired: "El valor es obligatorio.",
    },
    actions: {
      replace: "Reemplazar",
      replaceValue: "Reemplazar valor",
      setDefault: "Establecer como predeterminada",
      unsetDefault: "Quitar como predeterminada",
    },
    prompts: {
      renameTitle: "Renombrar secreto",
      renameDescription: "Actualiza el nombre descriptivo de este secreto.",
      replaceValueTitle: "Reemplazar valor del secreto",
      replaceValueDescription:
        "Pega el nuevo valor del secreto. Este valor no se mostrará de nuevo después de guardarlo.",
      deleteTitle: "Eliminar secreto",
      deleteConfirm: ({ name }: { name: string }) =>
        `¿Eliminar “${name}”? Esto no se puede deshacer.`,
    },
  },

  profiles: {
    // Profile management feature
    title: "Perfiles",
    subtitle: "Gestionar perfiles de variables de entorno para sesiones",
    sessionUses: ({ profile }: { profile: string }) =>
      `Esta sesión usa: ${profile}`,
    profilesFixedPerSession:
      "Los perfiles son fijos por sesión. Para usar un perfil diferente, inicia una nueva sesión.",
    noProfile: "Sin Perfil",
    noProfileDescription: "Usar configuración de entorno predeterminada",
    defaultModel: "Modelo Predeterminado",
    addProfile: "Agregar Perfil",
    profileName: "Nombre del Perfil",
    enterName: "Ingrese el nombre del perfil",
    baseURL: "URL Base",
    authToken: "Token de Autenticación",
    enterToken: "Ingrese el token de autenticación",
    model: "Modelo",
    tmuxSession: "Sesión Tmux",
    enterTmuxSession: "Ingrese el nombre de la sesión tmux",
    tmuxTempDir: "Directorio Temporal de Tmux",
    enterTmuxTempDir: "Ingrese la ruta del directorio temporal",
    tmuxUpdateEnvironment: "Actualizar entorno automáticamente",
    nameRequired: "El nombre del perfil es requerido",
    deleteConfirm: ({ name }: { name: string }) =>
      `¿Estás seguro de que quieres eliminar el perfil "${name}"?`,
    editProfile: "Editar Perfil",
    addProfileTitle: "Agregar Nuevo Perfil",
    builtIn: "Integrado",
    custom: "Personalizado",
    builtInSaveAsHint:
      "Guardar un perfil integrado crea un nuevo perfil personalizado.",
    builtInNames: {
      anthropic: "Anthropic (Predeterminado)",
      deepseek: "DeepSeek (Razonamiento)",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (Predeterminado)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Predeterminado)",
      geminiApiKey: "Gemini (clave API)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "Favoritos",
      custom: "Tus perfiles",
      builtIn: "Perfiles integrados",
    },
    actions: {
      viewEnvironmentVariables: "Variables de entorno",
      addToFavorites: "Agregar a favoritos",
      removeFromFavorites: "Quitar de favoritos",
      editProfile: "Editar perfil",
      duplicateProfile: "Duplicar perfil",
      deleteProfile: "Eliminar perfil",
    },
    copySuffix: "(Copia)",
    duplicateName: "Ya existe un perfil con este nombre",
    setupInstructions: {
      title: "Instrucciones de configuración",
      viewCloudGuide: "Ver la guía oficial de configuración",
    },
    machineLogin: {
      title: "Se requiere iniciar sesión en la máquina",
      subtitle:
        "Este perfil depende de una caché de inicio de sesión del CLI en la máquina seleccionada.",
      status: {
        loggedIn: "Sesión iniciada",
        notLoggedIn: "No has iniciado sesión",
      },
      claudeCode: {
        title: "Claude Code",
        instructions:
          "Ejecuta claude y luego escribe /login para iniciar sesión.",
        warning:
          "Nota: establecer ANTHROPIC_AUTH_TOKEN sobrescribe el inicio de sesión del CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Ejecuta codex login para iniciar sesión.",
      },
    },
    requirements: {
      secretRequired: "Secreto",
      configured: "Configurada en la máquina",
      notConfigured: "No configurada",
      checking: "Comprobando…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `Este perfil requiere que ${env} esté configurado en la máquina.`,
      modalTitle: "Se requiere secreto",
      modalBody:
        "Este perfil requiere un secreto.\n\nOpciones disponibles:\n• Usar entorno de la máquina (recomendado)\n• Usar un secreto guardado en la configuración de la app\n• Ingresar un secreto solo para esta sesión",
      sectionTitle: "Requisitos",
      sectionSubtitle:
        "Estos campos se usan para comprobar el estado y evitar fallos inesperados.",
      secretEnvVarPromptDescription:
        "Ingresa el nombre de la variable de entorno secreta requerida (p. ej., OPENAI_API_KEY).",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `Este perfil necesita ${env}. Elige una opción abajo.`,
      modalHelpGeneric:
        "Este perfil necesita un secreto. Elige una opción abajo.",
      chooseOptionTitle: "Elige una opción",
      machineEnvStatus: {
        theMachine: "la máquina",
        checkFor: ({ env }: { env: string }) => `Comprobar ${env}`,
        checking: ({ env }: { env: string }) => `Comprobando ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${env} encontrado en ${machine}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${env} no encontrado en ${machine}`,
      },
      machineEnvSubtitle: {
        checking: "Comprobando el entorno del daemon…",
        found: "Encontrado en el entorno del daemon en la máquina.",
        notFound:
          "Configúralo en el entorno del daemon en la máquina y reinicia el daemon.",
      },
      options: {
        none: {
          title: "Ninguna",
          subtitle: "No requiere secreto ni inicio de sesión por CLI.",
        },
        machineLogin: {
          subtitle:
            "Requiere iniciar sesión mediante un CLI en la máquina de destino.",
          longSubtitle:
            "Requiere haber iniciado sesión mediante el CLI para el backend de IA que elijas en la máquina de destino.",
        },
        useMachineEnvironment: {
          title: "Usar entorno de la máquina",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `Usar ${env} del entorno del daemon.`,
          subtitleGeneric: "Usar el secreto del entorno del daemon.",
        },
        useSavedSecret: {
          title: "Usar un secreto guardado",
          subtitle: "Selecciona (o agrega) un secreto guardado en la app.",
        },
        enterOnce: {
          title: "Ingresar un secreto",
          subtitle: "Pega un secreto solo para esta sesión (no se guardará).",
        },
      },
      secretEnvVar: {
        title: "Variable de entorno del secreto",
        subtitle:
          "Ingresa el nombre de la variable de entorno que este proveedor espera para su secreto (p. ej., OPENAI_API_KEY).",
        label: "Nombre de la variable de entorno",
      },
      sections: {
        machineEnvironment: "Entorno de la máquina",
        useOnceTitle: "Usar una vez",
        useOnceLabel: "Ingresa un secreto",
        useOnceFooter: "Pega un secreto solo para esta sesión. No se guardará.",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "Comenzar con la clave ya presente en la máquina.",
        },
        useOnceButton: "Usar una vez (solo sesión)",
      },
    },
    defaultPermissionMode: {
      title: "Modo de permisos predeterminado",
      descriptions: {
        default: "Pedir permisos",
        acceptEdits: "Aprobar ediciones automáticamente",
        plan: "Planificar antes de ejecutar",
        bypassPermissions: "Omitir todos los permisos",
      },
    },
    defaultPermissions: {
      title: "Permisos predeterminados",
      footer:
        "Sobrescribe los permisos predeterminados a nivel de cuenta para nuevas sesiones cuando se selecciona este perfil.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `Predeterminado de la cuenta: ${label}`,
      useAccountDefault: "Usar predeterminado de la cuenta",
      currently: ({ label }: { label: string }) => `Actualmente: ${label}`,
    },
    defaultStorage: {
      title: 'Tipo de sesión predeterminado',
      footer: 'Anula el tipo de sesión predeterminado Happier/directo de la cuenta para las nuevas sesiones cuando se selecciona este perfil.',
      accountDefaultSubtitle: ({ label }: { label: string }) => `Predeterminado de la cuenta: ${label}`,
      useAccountDefault: 'Usar el valor predeterminado de la cuenta',
      currently: ({ label }: { label: string }) => `Actualmente: ${label}`,
    },
    aiBackend: {
      title: "Backend de IA",
      selectAtLeastOneError: "Selecciona al menos un backend de IA.",
      claudeSubtitle: "CLI de Claude",
      codexSubtitle: "CLI de Codex",
      opencodeSubtitle: "CLI de OpenCode",
      geminiSubtitleExperimental: "CLI de Gemini (experimental)",
      auggieSubtitle: "CLI de Auggie",
      qwenSubtitleExperimental: "CLI de Qwen Code (experimental)",
      kimiSubtitleExperimental: "CLI de Kimi (experimental)",
      kiloSubtitleExperimental: "CLI de Kilo (experimental)",
      kiroSubtitleExperimental: "CLI de Kiro (experimental)",
      customAcpSubtitleExperimental: "CLI de ACP personalizado (experimental)",
      piSubtitleExperimental: "CLI de Pi (experimental)",
      copilotSubtitleExperimental: "GitHub Copilot CLI (en pruebas)",
      cursorSubtitleExperimental: "CLI de Cursor Agent (experimental)",

      ohMyPiSubtitleExperimental: "CLI de oh-my-pi (experimental)",},
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Iniciar sesiones en Tmux",
      spawnSessionsEnabledSubtitle:
        "Las sesiones se abren en nuevas ventanas de tmux.",
      spawnSessionsDisabledSubtitle:
        "Las sesiones se abren en una shell normal (sin integración con tmux)",
      isolatedServerTitle: "Servidor tmux aislado",
      isolatedServerEnabledSubtitle:
        "Inicia sesiones en un servidor tmux aislado (recomendado).",
      isolatedServerDisabledSubtitle:
        "Inicia sesiones en tu servidor tmux predeterminado.",
      sessionNamePlaceholder: "Vacío = sesión actual/más reciente",
      tempDirPlaceholder: "Dejar vacío para generar automáticamente",
    },
    previewMachine: {
      title: "Vista previa de la máquina",
      itemTitle: "Máquina de vista previa para variables de entorno",
      selectMachine: "Seleccionar máquina",
      resolveSubtitle:
        "Se usa solo para previsualizar los valores resueltos abajo (no cambia lo que se guarda).",
      selectSubtitle:
        "Selecciona una máquina para previsualizar los valores resueltos abajo.",
    },
    environmentVariables: {
      title: "Variables de entorno",
      addVariable: "Añadir variable",
      namePlaceholder: "Nombre de variable (p. ej., MY_CUSTOM_VAR)",
      valuePlaceholder: "Valor (p. ej., mi-valor o ${MY_VAR})",
      validation: {
        nameRequired: "Introduce un nombre de variable.",
        invalidNameFormat:
          "Los nombres de variables deben ser letras mayúsculas, números y guiones bajos, y no pueden empezar por un número.",
        duplicateName: "Esa variable ya existe.",
      },
      card: {
        valueLabel: "Valor:",
        fallbackValueLabel: "Valor de respaldo:",
        valueInputPlaceholder: "Valor",
        defaultValueInputPlaceholder: "Valor predeterminado",
        fallbackDisabledForVault:
          "Los valores de respaldo están deshabilitados al usar el almacén de secretos.",
        secretNotRetrieved: "Valor secreto: no se recupera por seguridad",
        secretToggleLabel: "Ocultar el valor en la UI",
        secretToggleSubtitle:
          "Oculta el valor en la UI y evita obtenerlo de la máquina para la vista previa.",
        secretToggleEnforcedByDaemon: "Impuesto por el daemon",
        secretToggleEnforcedByVault: "Impuesto por el almacén de secretos",
        secretToggleResetToAuto: "Restablecer a automático",
        requirementRequiredLabel: "Obligatorio",
        requirementRequiredSubtitle:
          "Bloquea la creación de la sesión si falta la variable.",
        requirementUseVaultLabel: "Usar almacén de secretos",
        requirementUseVaultSubtitle:
          "Usar un secreto guardado (sin valores de respaldo).",
        defaultSecretLabel: "Secreto predeterminado",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `Sobrescribiendo el valor documentado: ${expectedValue}`,
        useMachineEnvToggle: "Usar valor del entorno de la máquina",
        resolvedOnSessionStart:
          "Se resuelve al iniciar la sesión en la máquina seleccionada.",
        sourceVariableLabel: "Variable de origen",
        sourceVariablePlaceholder:
          "Nombre de variable de origen (p. ej., Z_AI_MODEL)",
        checkingMachine: ({ machine }: { machine: string }) =>
          `Verificando ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `Vacío en ${machine}`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Vacío en ${machine} (usando respaldo)`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `No encontrado en ${machine}`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `No encontrado en ${machine} (usando respaldo)`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `Valor encontrado en ${machine}`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `Difiere del valor documentado: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - oculto por seguridad`,
        hiddenValue: "***oculto***",
        emptyValue: "(vacío)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `La sesión recibirá: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `Vars de entorno · ${profileName}`,
        descriptionPrefix:
          "Estas variables de entorno se envían al iniciar la sesión. Los valores se resuelven usando el daemon en",
        descriptionFallbackMachine: "la máquina seleccionada",
        descriptionSuffix: ".",
        emptyMessage:
          "No hay variables de entorno configuradas para este perfil.",
        checkingSuffix: "(verificando…)",
        detail: {
          fixed: "Fijo",
          machine: "Máquina",
          checking: "Verificando",
          fallback: "Respaldo",
          missing: "Falta",
        },
      },
    },
    delete: {
      title: "Eliminar Perfil",
      message: ({ name }: { name: string }) =>
        `¿Estás seguro de que quieres eliminar "${name}"? Esta acción no se puede deshacer.`,
      confirm: "Eliminar",
      cancel: "Cancelar",
    },
  },

    projects: {
    emptyTitle: "Aún no hay proyectos",
    emptyDescription: "Los proyectos te permiten explorar y editar archivos, y usar Git en tus máquinas fuera de las sesiones.",
    groups: {
      pinned: "Fijados",
      addFirst: "Añadir un proyecto",
    },
    actions: {
      addProjectToMachine: "Añadir proyecto a esta máquina",
      addProject: "Añadir proyecto",
      addProjectOnMachine: ({ machine }: { machine: string }) => `Añadir un proyecto en ${machine}`,
      chooseProjectFolderOnMachine: ({ machine }: { machine: string }) => `Elige una carpeta en ${machine}`,
      chooseProjectFolderSubtitle: "Añádela como proyecto para explorar y editar archivos, y usar Git.",
      pin: "Fijar",
      unpin: "Desfijar",
      remove: "Eliminar",
    },
    sourceControl: {
      noSessionAvailableDetails: "Inicia una sesión en esta carpeta para habilitar Control de código fuente en Proyectos.",
    },
    details: {
      emptyBody: "Abre Archivos o Control de código fuente para previsualizar archivos y diffs aquí.",
      placeholderFileBody: "La vista previa del archivo “{title}” aparecerá aquí.",
      placeholderScmReviewBody: "Las vistas previas de los diffs aparecerán aquí.",
      placeholderCommitBody: "Los detalles del commit aparecerán aquí.",
      placeholderUnsupportedBody: "Esta pestaña de detalles aún no es compatible con Proyectos.",
    },
    detail: {
      notFoundTitle: "Proyecto no encontrado",
      notFoundDescription: "Este proyecto puede haber sido eliminado o pertenece a otro servidor.",
      missingWorktreeRecovered: "El worktree seleccionado ya no existe. Se volvió a la raíz del proyecto.",
      groupTitle: "Proyecto",
      fields: {
        name: "Nombre",
        machine: "Máquina",
        path: "Ruta",
      },
      comingSoonGroupTitle: "Próximamente",
      comingSoonFooter:
        "Archivos, Control de código fuente, diffs y terminal aparecerán aquí en la próxima fase del refactor.",
      comingSoon: {
        filesAndScmTitle: "Archivos y Control de código fuente",
        filesAndScmSubtitle:
          "Esta pantalla reutilizará la barra lateral y los paneles de detalles existentes, pero con alcance de espacio de trabajo en lugar de sesión.",
      },
    },
  },
   ...apiTokenSettingsTranslations.es,
   settingsPlugins: {
      ...pluginWebhookAdministrationTranslations['es'],
      ...pluginAccountDataEraseTranslations.es,
      ...pluginAccountReleaseSelectionTranslations.es,
      ...pluginInvocationLogTranslations.es,
      ...eventAutomationComposerTranslations.es,
    title: "Catálogo de plugins",
    subtitle: "Explora descriptores de plugins seleccionados y gestiona los plugins instalados en este dispositivo.",
    appPanelsTitle: "Paneles de plugins",
    appPanelsSubtitle: "Abre paneles de la aplicación aportados por plugins instalados.",
    executionOriginReleaseContentConflict: "El contenido de la versión no coincide. Publica una versión nueva.",
    readOnlyProjectionUnavailable: "Los detalles de plugins en caché son de solo lectura: este dispositivo es accesible, pero no se pudo cargar su registro de plugins. Reintenta para gestionar plugins.",
    readOnlyAccountRecovery: "Los detalles de la cuenta del plugin están disponibles, pero los detalles específicos de la máquina no estarán disponibles hasta que haya una instalación de plugin compatible.",
    readOnlySnapshot: "Los detalles de plugins en caché son de solo lectura mientras este dispositivo está desconectado. Vuelve a conectarlo para gestionar plugins.",
    viewSelectorLabel: "Vistas de gestión de plugins",
    views: { installed: "Instalados", discover: "Descubrir", development: "Desarrollo", diagnostics: "Diagnósticos" },
    developmentTitle: "Desarrollo",
    developmentFooter: "Fuentes locales aprobadas y diagnósticos de desarrollo informados por este dispositivo.",
    developmentEmpty: "No se informaron fuentes de desarrollo",
    developmentEmptySubtitle: "Este dispositivo no informó fuentes locales aprobadas ni diagnósticos de observación y recarga.",
    developmentCreate: "Crear plugin",
    developmentCreateSubtitle: "Crea una plantilla local de plugin en este equipo.",
    developmentCreateSucceeded: "Plantilla del plugin creada.",
    developmentSourceInstall: "Desarrollar una carpeta de plugin local",
    developmentSourceInstallSubtitle: "Permite que el daemon de este equipo compile y ejecute un plugin desde una carpeta tuya. Primero apruebas la carpeta exacta.",
    developmentSourceInstallTitle: "Carpeta del plugin",
    developmentSourceInstallBody: "Introduce la ruta completa de la carpeta del proyecto del plugin en este equipo.",
    developmentSourceInstallSucceeded: "Fuente de desarrollo aprobada y proyectada.",
    developmentSourceInstallFailed: ({ outcome }: { outcome: string }) => `No se instaló la fuente de desarrollo (${outcome}).`,
    developmentTrustSourceRootTitle: "¿Confiar en esta carpeta de plugin?",
    developmentTrustSourceRootBody: ({ path }: { path: string }) => `Happier instalará dependencias, compilará y ejecutará código desde:\n\n${path}\n\nContinúa solo si confías en todo lo que hay en esa carpeta y en todo lo que pueda descargar. Revisarás el plugin en el siguiente paso.`,
    developmentTrustSourceRootConfirm: "Confiar en la carpeta",
    pendingChangesTitle: "Esperando tu decisión",
    pendingChangesFooter: "Cambios de plugin preparados en esta máquina. Un agente puede prepararlos, pero solo tú puedes aprobarlos.",
    pendingChangesReviewHint: "Muestra la revisión completa antes de confiar en nada.",
    pendingChangeSourceRootSubtitle: ({ path }: { path: string }) => `Carpeta del plugin: ${path}`,
    pendingChangeInstallSubtitle: ({ pluginId, source }: { pluginId: string; source: string }) => `${pluginId} desde ${source}`,
    pendingChangeApplying: "Este cambio ya se decidió y se está aplicando.",
    pendingChangeExpired: "Este cambio caducó antes de decidirse. Vuelve a solicitarlo.",
    pendingChangeRejected: "El cambio del plugin fue rechazado.",
    pendingChangeConfirmRejectBody: "El cambio preparado se descarta. No se instala ni se confía en nada.",
    pendingChangeFailed: ({ outcome }: { outcome: string }) => `El cambio del plugin no se aplicó (${outcome}).`,
    developmentCreateDirectoryTitle: "Carpeta del plugin",
    developmentCreateDirectoryBody: "Introduce la carpeta absoluta nueva en el equipo seleccionado. No debe existir aún.",
    developmentCreateNameTitle: "Nombre del plugin",
    developmentCreateNameBody: "Introduce el nombre visible del plugin.",
    developmentCreateIdTitle: "ID del plugin",
    developmentCreateIdBody: "Introduce un espacio de nombres de propietario en minúsculas, separado por puntos y fuera de happier.*.",
    developmentCreateSurfaceTitle: "Superficie de interfaz del plugin",
    developmentCreateSurfaceBody: "Elige la superficie de interfaz con la que empieza este plugin. React Native también se renderiza en la web.",
    developmentCreateSurfaceReactNative: "React Native",
    developmentCreateSurfaceHostedWeb: "Web alojada",
    developmentCreateSurfaceNone: "Sin interfaz",
    developmentCreateConfirmTitle: "¿Crear la plantilla del plugin?",
    developmentCreateConfirmBody: ({ pluginId, targetDir }: { pluginId: string; targetDir: string }) => `¿Crear ${pluginId} en ${targetDir}?`,
    developmentWatchConfigured: "Aprobación de vigilancia configurada",
    developmentReloadClear: "Sin diagnósticos de recarga actuales",
    developmentReloadAttention: "Los diagnósticos de recarga requieren atención",
    developmentTest: "Probar plugin",
    developmentTestSubtitle: "Comprueba la entrada compilada del plugin con el entorno administrado de Happier.",
    developmentTestSucceeded: "La prueba del plugin se completó correctamente.",
    developmentPack: "Empaquetar plugin",
    developmentPackSubtitle: "Crea el archivo instalable validado junto a la carpeta de origen aprobada.",
    developmentPackSucceeded: "El paquete se creó junto a la carpeta de origen.",
    diagnosticsSnapshotTitle: "Diagnósticos",
    diagnosticsSnapshotFooter: "Diagnósticos actuales informados por el registro de plugins en este dispositivo.",
    diagnosticsSnapshotEmpty: "No hay diagnósticos actuales de plugins",
    diagnosticsSnapshotEmptySubtitle: "Los diagnósticos actuales del registro aparecerán aquí cuando este dispositivo los informe.",
    catalogUrlLabel: "URL del catálogo",
    loadCatalog: "Cargar catálogo",
    installAndTrust: "Instalar y confiar",
    marketplaceWithdrawnTitle: "Retirado del marketplace",
    marketplaceWithdrawnBody: "Este listado se retiró del marketplace seleccionado. Las instalaciones y actualizaciones nuevas están bloqueadas.",
    marketplaceWithdrawnInstalledBody: "Este listado se retiró del marketplace seleccionado. Las instalaciones y actualizaciones nuevas están bloqueadas. El plugin instalado permanece habilitado hasta que lo deshabilites o desinstales.",
    trustPolicy: {
      localTrusted: "Confiable localmente",
      trusted: "Confiable",
      prompt: "Requiere aprobación",
      untrusted: "No confiable",
    },
    sourceKind: {
      bundled: "Incluido",
      path: "Ruta local",
      marketplace: "Mercado de plugins",
      package: "Registro de paquetes",
      archive: "Archivo",
      catalog: "Catálogo",
    },
    unknownValue: ({ value }: { value: string }) => `Otro: ${value}`,
    emptySubtitle: "Este catálogo no devolvió descriptores.",
    detailTitle: "Detalles del plugin",
    managePlugin: "Gestionar plugin",
    provenanceTitle: "Origen y confianza",
    diagnosticsTitle: "Diagnósticos del plugin",
    registryDiagnosticsTitle: "Diagnósticos del registro",
    agentUiDiagnosticsTitle: "Diagnósticos de la interfaz del agente",
    contributionsTitle: "Contribuciones proyectadas",
    unsupportedDescriptorField: "Este campo de descriptor no es compatible con esta versión de Happier.",
    noDescriptors: "No se proyectaron descriptores renderizados por el host para esta sección.",
    marketplaceInstallReviewTitle: ({ name, version }: { name: string; version: string }) => `¿Instalar y confiar en ${name} ${version}?`,
    marketplaceInstallReviewBlockedNewerVersions: 'Versiones más recientes bloqueadas antes de la descarga:',
    marketplaceInstallReviewRawCredentialAccess: ({ details }: { details: string }) => `Acceso sin mediación a credenciales de Voice:\n${details}`,
    marketplaceInstallReviewRawCredentialAccessItem: ({ contribution, credential, source, realm, phase, request }: { contribution: string; credential: string; source: string; realm: string; phase: string; request: string }) =>
      `${contribution}: ${credential}; fuente ${source}; entorno ${realm}; fase ${phase}; solicitud ${request}. El código del complemento en el entorno ${realm} recibe directamente la credencial seleccionada y puede usarla o copiarla.`,
    marketplaceInstallReviewBody: ({ identity, verification, executableRealms, contributions, uiArtifacts, requiredAccess, optionalAccess, compatibility }: { identity: string; verification: string; executableRealms: string; contributions: string; uiArtifacts: string; requiredAccess: string; optionalAccess: string; compatibility: string }) => `Identidad:\n${identity}\n\nSeñales de verificación:\n${verification}\n\nCódigo ejecutable: ${executableRealms}\nContribuciones: ${contributions}\nArtefactos de interfaz: ${uiArtifacts}\n\nEl código de daemon y React Native de confianza se ejecuta con la autoridad de la aplicación o del proceso y puede usar directamente archivos, red, entorno y procesos. El acceso al host que se muestra a continuación describe servicios mediados por Happier; no es un entorno aislado para el código ejecutable del plugin.\n\nDivulgaciones y servicios cooperativos obligatorios:\n${requiredAccess}\n\nRecursos opcionales del host (desactivados por defecto):\n${optionalAccess}\n\nCompatibilidad y actualizaciones:\n${compatibility}`,
    marketplaceInstallDecisionFailed: ({ outcome }: { outcome: string }) => `El plugin no se instaló (${outcome}).`,
    marketplaceChangeDecisionFailed: ({ action, outcome }: { action: string; outcome: string }) => `${action} falló (${outcome}).`,
    pluginChangeConfirmBody: ({ action, name }: { action: string; name: string }) => `Confirma «${action}» para ${name}.`,
    forgetTrust: "Olvidar confianza",
    rollback: "Revertir",
    uninstall: "Desinstalar",
    marketplaceUpdateVersion: ({ installedVersion, availableVersion }: { installedVersion: string; availableVersion: string }) => `Actualizar de la versión ${installedVersion} a la ${availableVersion}.`,
    marketplaceCommunityUnreviewedTitle: "Código de la comunidad sin revisar",
    marketplaceCommunityUnreviewedBody: "Este paquete npm de terceros no ha sido revisado por Happier. «Instalar y confiar» aprueba el código ejecutable y el acceso al host declarados después de que el daemon verifique esta versión e integridad exactas. El código de daemon y React Native de confianza se ejecuta con la autoridad de la aplicación o del proceso; el acceso al host indicado no es un entorno aislado.",
    genericSettingsTitle: "Ajustes del plugin",
    genericSettingsFooter: "Se guardan localmente para este plugin en esta máquina.",
    genericSettingsLoading: "Cargando los ajustes del plugin",
    genericSettingsUnavailable: "Los ajustes del plugin no están disponibles para esta máquina.",
    genericSettingsLoadError: "No se pudieron cargar los ajustes del plugin.",
    genericSettingsSaveError: "No se pudo guardar el ajuste del plugin.",
    genericSettingsEmpty: "Este plugin no proyectó ajustes editables.",
    registriesTitle: "Registros npm privados",
    registriesFooter: "El inicio de sesión en el registro solo controla el acceso a paquetes. Los plugins instalados y de confianza siguen disponibles si se elimina el registro o se cierra la sesión.",
    registriesAdd: "Añadir registro",
    registriesAddTitle: "Añadir registro privado",
    registriesAddOriginBody: "Introduce el origen HTTPS del registro sin credenciales.",
    registriesInvalidOriginTitle: "Origen del registro no válido",
    registriesInvalidOriginBody: "Usa un origen HTTPS sin credenciales, ruta, consulta ni fragmento.",
    registriesNameTitle: "Nombre del registro",
    registriesNameBody: "Elige un nombre que solo se mostrará en los ajustes de Happier.",
    registriesScopesTitle: "Ámbitos de paquetes",
    registriesScopesBody: "Ámbitos opcionales separados por comas que se dirigen a este registro.",
    registriesScopesPlaceholder: "@empresa, @equipo",
    registriesDefaultTitle: "Registro de paquetes predeterminado",
    registriesDefaultBody: "¿Usar este registro para paquetes sin ámbito que no se dirijan a otra fuente configurada?",
    registriesUseAsDefault: "Usar como predeterminado",
    registriesScopedOnly: "Solo paquetes con ámbito",
    registriesPrivateNetworkTitle: "Acceso a la red privada",
    registriesPrivateNetworkBody: "¿Permitir que el origen de este registro resuelva direcciones de red privadas o locales? Déjalo desactivado para registros alojados en Internet.",
    registriesAllowPrivateNetwork: "Permitir red privada",
    registriesPublicOnly: "Solo direcciones públicas",
    registriesLogin: "Iniciar sesión",
    registriesLoginTitle: "Token del registro",
    registriesLoginBody: "Pega un token para este registro. Se cifra en la máquina seleccionada y no se guarda en esta aplicación.",
    registriesLogout: "Cerrar sesión",
    registriesEdit: "Editar registro",
    registriesTest: "Probar conexión",
    registriesMarketplaceBindingsTitle: "Vinculaciones de registros del marketplace",
    registriesMarketplaceBind: ({ profile, source }: { profile: string; source: string }) => `Usar ${profile} para ${source}`,
    registriesMarketplaceUnbind: ({ source }: { source: string }) => `Dejar de usar un registro privado para ${source}`,
    registriesRemove: "Eliminar registro",
    registriesRemoveTitle: "¿Eliminar el registro privado?",
    registriesRemoveBody: ({ name }: { name: string }) => `¿Eliminar ${name}? Los plugins instalados seguirán instalados y siendo de confianza; se pausarán las descargas y actualizaciones futuras desde este registro.`,
    registriesAvailability: {
      unknown: "Sin comprobar",
      available: "Disponible",
      sign_in_required: "Se requiere iniciar sesión",
      offline: "Sin conexión",
    },
    registriesUpdatePaused: "Actualizaciones en pausa",
    registriesPauseReason: {
      credentials_missing: "Faltan las credenciales del registro",
      authentication_failed: "Falló la autenticación del registro",
      profile_removed: "Se eliminó el perfil del registro",
      offline: "El registro está sin conexión",
    },
    registriesErrorTitle: "Falló la operación del registro",
    registriesErrorBody: "Actualiza la lista de registros y vuelve a intentarlo.",
    registriesInvalidProfileTitle: "Ajustes del registro no válidos",
    registriesInvalidProfileBody: "Comprueba el nombre del registro y los ámbitos de paquetes, y vuelve a intentarlo.",
    registriesNoMachine: "Selecciona una máquina para gestionar registros privados.",
    registriesLoadError: "No se pudieron cargar los ajustes de registros privados.",
    registriesEmpty: "No hay registros privados configurados.",
  },
    settingsScmDiffSummary: {
    title: 'Resúmenes de diferencias',
    enabledTitle: 'Activar resúmenes de diferencias',
    enabledSubtitle:
      'Permite resúmenes generados con IA para diferencias de control de código fuente.',
    prefetchTitle: 'Precargar resúmenes',
    prefetchSubtitle:
      'Genera resúmenes con antelación solo cuando esta preferencia está activada.',
    modelOverrideTitle: 'Modelo de resumen',
    modelOverrideSubtitle:
      'Perfil de runtime resuelto opcional para los resúmenes de diferencias.',
    modelOverrideDefault: 'Usar el valor predeterminado del runtime',
    cacheTitle: 'Caché de resúmenes',
    cacheSubtitle:
      'Los resúmenes de checkpoint se reutilizan por recibo; los resúmenes del working tree son temporales.',
  },
    externalSessions: {
        ...externalSessionOperationTranslations.es,
        ...externalSessionSettingsTranslations.es,
        settingsTitle: 'Sesiones externas',
        settingsEntrySubtitle: 'Revisa cómo gestiona Happier las sesiones iniciadas fuera de la aplicación.',
        settingsSafetyGroupTitle: 'Cómo funciona',
        settingsPassiveTitle: 'Solo lectura de forma predeterminada',
        settingsPassiveSubtitle: 'Abrir esta página es una acción pasiva. Nunca inicia ni reanuda un Agent, cambia su configuración, instala hooks ni empieza a seguir una sesión.',
        settingsFollowGroupTitle: 'Seguimiento pasivo',
        settingsRestoreTitle: 'Mantener el seguimiento pasivo tras reiniciar',
        settingsRestoreEnabledSubtitle: 'Vuelve a conectar las sesiones que sigues explícitamente cuando se reinicia el daemon.',
        settingsRestoreDisabledSubtitle: 'No vuelvas a conectar las sesiones seguidas después de reiniciar el daemon.',
        settingsRestoreFooter: 'La restauración solo observa una fuente de Agent existente. Nunca inicia ni reanuda el Agent.',
        settingsNotificationsTitle: 'Notificaciones',
        settingsNotificationsActiveSubtitle: 'Las notificaciones de disponibilidad solo se aplican a sesiones con seguimiento pasivo activado.',
        settingsNotificationsInactiveSubtitle: 'Activa el seguimiento pasivo de una sesión para recibir sus notificaciones.',
        settingsActiveFollowsGroupTitle: 'Seguimiento de sesiones',
        settingsActiveFollowsFooter: 'Cada opción se aplica solo a esa sesión. Nunca se incluyen otras sesiones automáticamente.',
        settingsActiveFollowsEmptyTitle: 'Aún no hay sesiones externas',
        settingsActiveFollowsEmptySubtitle: 'Las sesiones externas vinculadas aparecerán aquí con su estado actual.',
        settingsFollowToggleHint: 'Inicia o detiene el seguimiento pasivo en segundo plano de esta sesión.',
        followStatusDisabled: 'Sin seguimiento',
        followStatusPaused: 'Seguimiento en pausa',
        followStatusReacquiring: 'Reconectando seguimiento…',
        followStatusActive: 'Seguimiento activo',
        followStatusError: 'El seguimiento requiere atención',
        followStatusUnknown: 'Estado de seguimiento no disponible',
        followStatusMachineOffline: 'La máquina está sin conexión; el seguimiento pasivo se reanudará cuando vuelva a conectarse',
        followStatusUnsupported: 'Este Agent no admite el seguimiento pasivo',
        followUpdateFailed: 'Happier no pudo actualizar el seguimiento pasivo de esta sesión. Inténtalo de nuevo.',
    browseTitle: "Explorar sesiones externas",
    browseOpenExisting: "Explorar sesiones externas",
    browseActionSubtitle: "Elige una máquina, un agente y una sesión para abrirla aquí.",
    emptyStateTitle: "Explora una sesión existente",
    emptyStateDescription: "Abre sesiones de Claude, Codex y OpenCode desde tus máquinas conectadas.",
    browseFiltersTitle: "Seleccionar origen",
    browseMachines: "Máquinas",
    browseAgents: "Agentes",
    browseSources: "Fuentes",
    browseSourceCodexUserHome: "Mi directorio Codex",
        browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Servicios conectados de ${service}`,
    browseSourceClaudeDefault: "Configuración predeterminada de Claude",
    browseSourceOpenCodeDefault: "Servidor predeterminado de OpenCode",
    browseCandidates: "Sesiones disponibles",
    browseNoMachines: "Aún no hay máquinas disponibles para sesiones directas.",
    browseNoCandidates: "No se encontraron sesiones externas para esta máquina y este agente.",
    browseActivityRunning: "En ejecución",
        browseActivityRunningNow: "En ejecución",
    browseActivityRecent: "Reciente",
    browseActivityIdle: "Inactiva",
    browseActivityUnknown: "Desconocida",
        browseSearchPlaceholder: "Buscar sesiones cargadas…",
        browseNoSearchResults: "Ninguna sesión cargada coincide todavía con esta búsqueda.",
    browseIndexing: "Indexando sesiones externas…",
    browseIndexingProgress: ({ scanned, total }: { scanned: number; total: number }) => `${scanned} de ${total} sesiones indexadas`,
    browseIndexingCancelled: "Se detuvo la indexación. Inténtalo de nuevo cuando quieras.",
    browseLoadMore: "Cargar más sesiones",
    browseFailedToLoad: "No se pudieron cargar las sesiones externas.",
    browseLinkFailed: "No se pudo vincular la sesión externa seleccionada.",
  },
    pluginReactNative: {
    unavailable: "Interfaz React Native del plugin no disponible",
    disabled: "Interfaz React Native del plugin desactivada",
    fallback: "Usando la alternativa del plugin",
    reset: {
      requested: {
        title: "Restableciendo la interfaz del plugin",
        reason: "Happier está esperando a que se confirme el restablecimiento.",
      },
      awaitingProjection: {
        title: "Esperando el restablecimiento del plugin",
        reason: "Happier está esperando el estado actualizado del plugin.",
      },
      complete: {
        title: "La interfaz del plugin se ha restablecido",
        reason: "La interfaz del plugin vuelve a estar disponible.",
      },
      failed: {
        title: "No se pudo restablecer la interfaz del plugin",
        reason: "Intenta restablecerla de nuevo.",
      },
    },
  },
    pluginRuntime: {
        unavailableGeneric: 'Esta vista del plugin no está disponible en este momento.',
        crashLoop: 'El plugin se detuvo tras fallos repetidos.',
        disabledByPolicy: 'Esta vista del plugin está desactivada por la configuración o compatibilidad actuales.',
        hostedWebUnavailableTitle: 'La vista alojada del plugin no está disponible',
        hostedWebPolicyDenied: 'Esta vista del plugin no está disponible en esta superficie. Revisa su configuración de disponibilidad o usa una superficie compatible.',
        hostedWebSandboxUnavailable: 'Este plugin no declara la configuración de aislamiento necesaria para mostrar esta vista. Actualiza el plugin e inténtalo de nuevo.',
        hostedWebSecurityUnavailable: 'La configuración de seguridad del plugin no se puede aplicar en esta vista. Actualiza el plugin o usa un host compatible.',
        hostedWebFrameOriginUnavailable: 'Happier no pudo establecer una dirección de confianza para esta vista. Actualízala e inténtalo de nuevo.',
        hostedWebBridgeNonceUnavailable: 'Happier no pudo establecer una conexión segura con esta vista. Actualízala e inténtalo de nuevo.',
        hostedWebBridgeTimeout: 'Esta vista del plugin no terminó de conectarse. Actualízala e inténtalo de nuevo.',
        hostedWebEndpointPolicyDenied: 'La dirección de esta vista está bloqueada por su política de seguridad. Revisa la configuración del plugin o usa un host compatible.',
        missingRequirement: 'A esta vista del plugin le falta un requisito en este dispositivo.',
    },
    settingsSearch: {
    placeholder: "Buscar ajustes",
  },
    onboardingJourney: {
        accessibility: {
            skipToContent: "Saltar al contenido",
        },
  },} as const;

export type TranslationsEs = typeof es;
