import type { TranslationStructure } from "../_types";

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
  mcpServersDeliveryShellBridgeSubtitle: 'Este backend llama a las herramientas de Happier a través del puente `happier tools`.',
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
  sessionListDensity: {
    title: 'Densidad de la lista de sesiones',
    subtitle: 'Elige cómo se muestran las sesiones en la barra lateral',
    detailed: 'Detallada',
    detailedDescription: 'Filas de tamaño completo con avatares y estado',
    cozy: 'Intermedia',
    cozyDescription: 'Filas más pequeñas con avatares',
    narrow: 'Estrecha',
    narrowDescription: 'Filas mínimas sin avatares',
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
      convertToPersistedTitle: 'Convertir en sincronizada',
      convertToPersistedSubtitle: 'Importa la transcripcion y continua como una sesion sincronizada de Happier.',
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
export const es: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "Bandeja",
    friends: "Amigos",
    sessions: "Sesiones",
    settings: "Configuración",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Estás al día",
    emptyDescription: "No hay solicitudes ni actualizaciones pendientes ahora mismo.",
    approvals: "Aprobaciones",
    permissions: "Permisos",
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
    openA11y: "Abrir automatizaciones",
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
        name: "Resumen diario",
        description: "¿Qué debería hacer esta automatización?",
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
      runMeta: {
        scheduled: ({ time }: { time: string }) => `Programada: ${time}`,
        updated: ({ time }: { time: string }) => `Actualizada: ${time}`,
        error: ({ message }: { message: string }) => `Error: ${message}`,
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
    cancel: "Cancelar",
    close: "Cerrar",
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
		    info: "Información",
		    comingSoon: "Próximamente",
		    ok: "OK",
		    continue: "Continuar",
		    back: "Atrás",
        previous: "Anterior",
        next: "Siguiente",
	    start: "Iniciar",
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
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "Redimensionar panel",
      resizeHint: "Usa las flechas izquierda y derecha para redimensionar",
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
    offline: "desconectado",
    lastSeen: ({ time }: { time: string }) => `visto por última vez ${time}`,
    actionRequired: "acción requerida",
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
            "Si tu máquina no es accesible desde la UI, ejecuta `happier doctor --json` en tu ordenador y pégalo aquí.",
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
            readyLight: 'El índice ligero está listo en esta máquina',
            readyDeep: 'El índice profundo está listo en esta máquina',
            unavailableLight: 'El índice ligero todavía no está listo en esta máquina',
            unavailableDeep: 'El índice profundo todavía no está listo en esta máquina',
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
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
    connectedAccountsDisabled: "Los servicios conectados están deshabilitados.",
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
      statusInstallRequired: 'Install Tailscale to continue',
      statusLoginRequired: 'Sign in to Tailscale to continue',
      statusNeedsApproval: 'Esperando la aprobación de Tailscale',
      shareableUrlTitle: 'URL privada compartible',
      approvalTitle: 'Se requiere aprobación',
      approvalSubtitle: 'Termina el flujo de aprobación de Tailscale y vuelve aquí.',
      installTitle: 'Install required',
      installSubtitle: 'Install Tailscale, then come back here.',
      loginTitle: 'Sign-in required',
      loginSubtitle: 'Complete the Tailscale sign-in flow, then come back here.',
      enableAction: 'Activar acceso privado con Tailscale',
      refreshAction: 'Volver a comprobar el acceso privado',
      openApprovalAction: 'Abrir la aprobación de Tailscale',
      openInstallAction: 'Open Tailscale download',
      openLoginAction: 'Open Tailscale sign-in',
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
      channelBridges: "Puentes de canales",
      channelBridgesSubtitle: "Conecta chats externos (Telegram) a las sesiones",
      featuresTitle: "Características",
      featuresSubtitle: "Habilitar o deshabilitar funciones de la aplicación",
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
  },

  systemStatus: {
    sections: {
      appHealth: "Salud de la app y sincronización",
      currentServer: "Relay actual",
      identity: "Identidad conectada",
      configuredServers: "Relays configurados",
      machinesActiveServer: "Máquinas (relay activo)",
      machinesOtherServer: ({ server }: { server: string }) => `Máquinas (${server})`,
      actions: "Acciones",
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
      footer: "Consejo: ejecuta `happier doctor --json` en tu ordenador y pégalo aquí.",
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
    },
    title: "Servicios conectados",
    authChip: {
      label: "Autenticación",
      labelWithCount: ({ count }: { count: number }) => `Autenticación: ${count}`,
    },
    list: {
      empty: "No hay servicios conectados todavía.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "conectado", plural: "conectados" })}`,
      needsReauth: "requiere reautenticación",
      notConnected: "no conectado",
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
      unknownService: "Servicio conectado desconocido.",
      actionsGroupTitle: "Acciones",
      actions: {
        setDefault: "Establecer como predeterminado",
        unsetDefault: "Quitar predeterminado",
        editLabel: "Editar etiqueta",
        reconnect: "Reconectar",
      },
      setDefaultProfileTitle: "Establecer perfil predeterminado",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Predeterminado: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Elige qué perfil se selecciona de forma predeterminada",
      setProfileLabelTitle: "Establecer etiqueta del perfil",
      setProfileLabelSubtitle:
        "Etiqueta opcional mostrada en los selectores de autenticación",
      addOauthProfileTitle: "Añadir perfil OAuth",
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
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `¿Desconectar ${service} (${profileId})?`,
      prompts: {
        profileIdTitle: "ID de perfil",
        profileIdBody: "Usa una etiqueta corta como work, personal o alt.",
        apiKeyTitle: "Clave API",
        apiKeyBody: "Pega tu clave API de Anthropic.",
        apiKeyPlaceholder: "p. ej. sk-ant-…",
        setupTokenTitle: "Token de configuración",
        setupTokenBody: "Pega tu setup-token de Claude (de claude setup-token).",
        setupTokenPlaceholder: "p. ej. sk-ant-oat01-…",
        profileLabelTitle: "Etiqueta de perfil",
        profileLabelBody: "Opcional. Se muestra en los selectores de autenticación.",
        profileLabelPlaceholder: "Cuenta de trabajo",
      },
      alerts: {
        invalidProfileIdTitle: "ID de perfil no válido",
        invalidProfileIdBody: "Usa letras, números, guion o guion bajo (máx. 64).",
        unknownProfileTitle: "Perfil desconocido",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `No existe un perfil llamado \"${profileId}\" para ${service}.`,
      },
      profiles: {
        empty: "Aún no hay perfiles.",
        connected: "Conectado",
        defaultBadge: "Predeterminado",
        needsReauth: "Requiere reautenticación",
      },
    },
    profile: {
      profileId: "ID de perfil",
      status: "Estado",
      email: "Correo",
      accountId: "ID de cuenta",
      quotaTitle: "Cuotas",
      defaultSubtitle: "Este perfil está seleccionado por defecto",
      setDefaultSubtitle: "Usar este perfil por defecto",
      disconnectSubtitle: "Eliminar credenciales de este perfil",
      reconnectSubtitle: "Reautenticar este perfil",
    },
    authModal: {
      nativeAuthTitle: "Autenticación nativa del backend",
      nativeAuthSubtitle: "Usa tu login local del CLI / claves API",
      connectedServicesTitle: "Usar servicios conectados",
      connectedServicesSubtitle: "Obtener y materializar desde la nube de Happier",
      notConnectedTitle: "No conectado",
      notConnectedSubtitle: "Toca para abrir configuración",
      profileLabel: "Perfil",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Archivo demasiado grande",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Se omitieron ${count} ${plural({ count, singular: "archivo", plural: "archivos" })} que superan el tamaño máximo de adjunto.`,
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
        invalidDirectoryMessage: "Usa una ruta relativa como `.happier/uploads`.",
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
      },
    },
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
    title: 'Desktop',
    footer: 'Controls Tauri desktop integrations on this computer.',
    startOnLoginTitle: 'Launch at login',
    startOnLoginSubtitle: 'Start Happier automatically when you sign in to this computer.',
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
    push: {
      title: "Notificaciones push",
      footer:
        "Estas notificaciones se envían desde tu CLI mediante Expo cuando tu sesión necesita atención.",
      enabledSubtitle: "Permitir notificaciones push en esta cuenta",
      troubleshootTitle: "Solucionar problemas",
      troubleshootSubtitle: "Ver permisos y dispositivos registrados",
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
    },
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
  },

    notifications: {
      actions: {
        allow: 'Permitir',
        deny: 'Denegar',
        answer: 'Responder',
      },
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

  settingsProviders: {
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
      installInfoUseProviderCliInstaller: "Usa el instalador CLI del proveedor",
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
                    claudeRemoteAgentSdkEnabled: {
                        title: "Usar Agent SDK (remoto)",
                        subtitle: "Usa el @anthropic-ai/claude-agent-sdk oficial para el modo remoto."
                    },
                    claudeRemoteDebugEnabled: {
                        title: "Modo debug",
                        subtitle: "Activa los logs de depuración de Claude Code (equivalente a --debug)."
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "Verbose",
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
                        footer: "Déjalo vacío para usar el ciclo de vida del servidor OpenCode gestionado por Happier. Define una URL http(s) absoluta para conectarte a un servidor OpenCode existente."
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
                        subtitle: "Anulación opcional para un servidor OpenCode gestionado por el usuario."
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

  settingsAppearance: {
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
    editorFocusMode: "Modo enfoque del editor",
    editorFocusModeDescription:
      "Oculta la conversación y la barra lateral mientras revisas archivos (web/tablet)",
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
    },
    showFlavorIcons: "Mostrar íconos de proveedor de IA",
    showFlavorIconsDescription:
      "Mostrar íconos del proveedor de IA en los avatares de sesión",
    compactSessionView: "Vista compacta de sesiones",
    compactSessionViewDescription:
      "Mostrar sesiones activas en un diseño más compacto",
    compactSessionViewMinimal: "Vista compacta mínima",
    compactSessionViewMinimalDescription:
      "Quita los avatares y muestra un diseño de fila de sesión muy compacto",
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
  },

  settingsChannelBridges: {
    unsupported: "Los puentes de canales no están disponibles en este entorno.",
    enableInFeatures: "Activar puentes de canales",
    enableInFeaturesSubtitle: "Los puentes de canales son experimentales y están desactivados por defecto.",
    description: "Los puentes de canales te permiten adjuntar chats externos (Telegram) a las sesiones y reenviar mensajes al agente.",
    telegramTitle: "Telegram",
    telegramFooter: "Configura Telegram mediante la CLI y luego gestiona las vinculaciones en Telegram con /sessions, /attach, /detach, /help.",
  },

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
      expConnectedServices: "Servicios conectados",
      expConnectedServicesSubtitle:
        "Habilitar configuración de servicios conectados y vinculaciones de sesión",
      expConnectedServicesQuotas: "Cuotas de servicios conectados",
      expConnectedServicesQuotasSubtitle:
        "Mostrar insignias de cuota y medidores de uso para servicios conectados",
      expChannelBridges: "Puentes de canal",
      expChannelBridgesSubtitle: "Conecta Telegram y otros canales de chat a sesiones de Happier (experimental)",
      expMemorySearch: "Búsqueda de memoria",
      expMemorySearchSubtitle:
        "Habilitar pantallas y ajustes de búsqueda de memoria local",
    expSessionsDirect: "Sesiones directas",
    expSessionsDirectSubtitle: "Muestra y abre en la barra lateral sesiones directas respaldadas por el proveedor",
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
      historyScopePerSession: "Recorrer el historial por terminal",
      historyScopeGlobal: "Recorrer el historial en todos los terminales",
      historyScopeModalTitle: "Historial de mensajes",
      historyScopeModalMessage:
        "Elige si Flecha arriba/Flecha abajo recorre solo los mensajes enviados en este terminal, o en todos los terminales.",
      historyScopePerSessionOption: "Por terminal",
      historyScopeGlobalOption: "Global (todos)",
      commandPalette: "Paleta de comandos",
      commandPaletteEnabled: "Presione ⌘K para abrir",
      commandPaletteDisabled: "Acceso rápido a comandos deshabilitado",
      hideInactiveSessions: "Ocultar sesiones inactivas",
      hideInactiveSessionsSubtitle: "Muestra solo los chats activos en tu lista",
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
      failedToForkSession: "No se pudo bifurcar la sesión",
      daemonUnavailableTitle: "Daemon no disponible",
      daemonUnavailableBody:
        "Happier no puede comunicarse con el daemon en esta máquina. Puede estar sin conexión, iniciándose o desconectado del servidor.",
      tryAgain: "Intenta de nuevo",
      contactSupport: "Contacta soporte si el problema persiste",
      sessionNotFound: "Sesión no encontrada",
      voiceSessionFailed: "Falló al iniciar sesión de voz",
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
  },

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
    },
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
      "Falló al iniciar sesión. Asegúrate de que el daemon esté ejecutándose en la máquina objetivo.",
    sessionTimeout:
      "El inicio de sesión expiró. La máquina puede ser lenta o el daemon puede no estar respondiendo.",
    notConnectedToServer:
      "No conectado al servidor. Verifica tu conexión a internet.",
    daemonRpcUnavailableTitle: "Daemon no disponible",
    daemonRpcUnavailableBody:
      "Happier no puede comunicarse con el daemon en esta máquina. Puede estar sin conexión, iniciándose o desconectado del servidor.",
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
  },

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
    inputPlaceholder: "Escriba un mensaje ...",
    toolCalls: "Llamadas de herramientas",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} más…`,
    forking: {
      dividerTitle: "Bifurcado desde un contexto anterior",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Bifurcado desde ${parent}`,
      dividerSubtitle: "Contexto anterior (solo lectura)",
      openParent: "Abrir",
      openParentA11y: "Abrir sesión padre",
      forkFromMessageA11y: "Bifurcar desde este mensaje",
	    },
	    rollback: {
	      latestTurnA11y: 'Revertir el ultimo turno',
	      beforeUserMessageA11y: 'Revertir antes de este mensaje',
	    },
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
          },
        detailsPanel: {
            emptyHint: "Abre un archivo o un diff desde el panel derecho.",
            unsupportedTab: "Pestaña de detalles no compatible.",
            closeA11y: "Cerrar detalles",
                openTabA11y: ({ title }: { title: string }) => `Abrir pestaña ${title}`,
                pinTabA11y: "Fijar pestaña",
                unpinTabA11y: "Desanclar pestaña",
                pinnedTabA11y: "Pestaña fijada",
                closeTabA11y: "Cerrar pestaña",
                enterFocusModeA11y: "Entrar en modo de enfoque del editor",
                exitFocusModeA11y: "Salir del modo de enfoque del editor",
        },
  
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
          empty: "No hay mensajes pendientes.",
          decryptFailed: "No se pudo descifrar este mensaje pendiente.",
          actions: {
            up: "Arriba",
            down: "Abajo",
          edit: "Editar",
            viewMore: "Ver más",
            viewLess: "Ver menos",
          steerNow: "Insertar ahora",
          sendNow: "Enviar ahora",
          sendNowInterrupt: "Enviar ahora (interrumpir)",
          requeue: "Reencolar",
        },
        editPrompt: {
          title: "Editar mensaje pendiente",
        },
        removeConfirm: {
          title: "¿Eliminar mensaje pendiente?",
          body: "Esto eliminará el mensaje pendiente.",
        },
        steerConfirm: {
          title: "¿Insertar ahora?",
          body: "Esto añadirá este mensaje al turno actual sin detenerlo.",
        },
        sendConfirm: {
          title: "¿Enviar ahora?",
          interruptTitle: "¿Enviar ahora (interrumpir)?",
          body: "Esto detendrá el turno actual y enviará este mensaje inmediatamente.",
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
        },
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
        "Crea un enlace para que cualquiera pueda ver esta sesión.",
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
    effectiveLabel: ({ label }: { label: string }) => `Efectivo: ${label}`,
  },

  voiceAssistant: {
    connecting: "Conectando...",
    active: "Asistente de voz activo",
    connectionError: "Error de conexión",
    label: "Asistente de voz",
    tapToEnd: "Toca para finalizar",
  },

  voiceSurface: {
    start: "Iniciar",
    stop: "Detener",
    selectSessionToStart: "Selecciona una sesión para iniciar la voz",
    targetSession: "Sesión objetivo",
    noTarget: "Ninguna sesión seleccionada",
    clearTarget: "Limpiar objetivo",
    a11y: {
      teleport: "Teletransportar agente de voz",
      toggleActivity: "Mostrar/ocultar actividad de voz",
      clearActivity: "Borrar actividad de voz",
      bargeIn: "Interrumpir",
      cancelTurn: "Cancelar respuesta",
    },
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
  },

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
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Elimina sesiones inactivas despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Elimina datos despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })}.`,
      sessionNotice: ({ count }: { count: number }) => `Este servidor elimina sesiones inactivas despues de ${count} ${plural({ count, singular: 'dia', plural: 'dias' })} de inactividad.`,
      sessions: "Sesiones",
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
  },

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
    storagePersistedTab: "Sincronizadas",
    storageDirectTab: "Directas",
    renameWorkspace: 'Renombrar espacio de trabajo',
    renameWorkspacePromptTitle: 'Renombrar espacio de trabajo',
    renameWorkspacePromptPlaceholder: 'Introduce un nombre...',
    resetWorkspaceName: 'Restablecer nombre',
  },

  directSessions: {
    browseTitle: "Explorar sesiones del proveedor",
    browseOpenExisting: "Explorar sesiones del proveedor",
    browseFiltersTitle: "Seleccionar origen",
    browseMachines: "Máquinas",
    browseProviders: "Proveedores",
    browseSources: "Fuentes",
    browseSourceCodexUserHome: "Mi directorio Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} connected services`,
    browseSourceClaudeDefault: "Configuración predeterminada de Claude",
    browseSourceOpenCodeDefault: "Servidor predeterminado de OpenCode",
    browseCandidates: "Sesiones disponibles",
    browseNoMachines: "Aún no hay máquinas disponibles para sesiones directas.",
    browseNoCandidates: "No se encontraron sesiones del proveedor para esta máquina y este proveedor.",
    browseActivityRunning: "En ejecución",
        browseActivityRunningNow: "En ejecución",
    browseActivityRecent: "Reciente",
    browseActivityIdle: "Inactiva",
    browseActivityUnknown: "Desconocida",
        browseSearchPlaceholder: "Buscar sesiones cargadas…",
        browseNoSearchResults: "Ninguna sesión cargada coincide todavía con esta búsqueda.",
    browseLoadMore: "Cargar más sesiones",
    browseFailedToLoad: "No se pudieron cargar las sesiones del proveedor.",
    browseLinkFailed: "No se pudo vincular la sesión del proveedor seleccionada.",
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
    metadataCopied: "Metadatos copiados al portapapeles",
    failedToCopyMetadata: "Falló al copiar metadatos",
    failedToKillSession: "Falló al terminar sesión",
    failedToStopSession: "Falló al detener sesión",
    failedToArchiveSession: "Falló al archivar sesión",
    connectionStatus: "Estado de conexión",
    created: "Creado",
    lastUpdated: "Última actualización",
    sequence: "Secuencia",
    quickActions: "Acciones rápidas",
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
    failedToRenameSession: "Error al renombrar la sesión",
    sessionRenamed: "Sesión renombrada exitosamente",
  },

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
    dropToAttach: "Suelta para adjuntar archivos",
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
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      plan: "Modo de planificación",
      bypassPermissions: "Modo Yolo",
      badgeAccept: "Aceptar",
      badgePlan: "Plan",
      badgeReadOnly: "Solo lectura",
      badgeSafeYolo: "YOLO seguro",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Aceptar todas las ediciones",
      badgeBypassAllPermissions: "Omitir todos los permisos",
      badgePlanMode: "Modo de planificación",
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
      customAcp: "ACP personalizado",
      pi: "Pi",
      copilot: "Copilot",
    },
    auggieIndexingChip: {
      on: "Indexación activada",
      off: "Indexación desactivada",
    },
      model: {
        title: "MODELO",
        useCliSettings: "Usar la configuración del CLI",
        configureInCli: "Configurar modelos en la configuración del CLI",
        customDescription: "Usa un id de modelo que no esté en la lista.",
        customPromptBody: "Introduce un id de modelo",
        customPlaceholder: "p. ej., claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "MODO DE PERMISOS CODEX",
      default: "Configuración del CLI",
      plan: "Modo de planificación",
      readOnly: "Modo de solo lectura",
      safeYolo: "YOLO seguro",
      yolo: "YOLO",
      badgePlan: "Plan",
      badgeReadOnly: "Solo lectura",
      badgeSafeYolo: "YOLO seguro",
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
      currentValue: ({ value }: { value: string }) => `Actual: ${value}`,
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
    latestTurnDescription:
      "Cambios respaldados por el proveedor del turno completado más reciente.",
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
    },
      fileEditingUnsupported:
        "La edición de archivos no es compatible con el daemon conectado. Actualiza Happier en la máquina para habilitar operaciones de escritura.",
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
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Cargando ${fileName}...`,
        binaryFile: "Archivo binario",
        imagePreviewTooLarge: "La vista previa de la imagen es demasiado grande para mostrarse",
        cannotDisplayBinary: "No se puede mostrar el contenido del archivo binario",
        diff: "Diferencias",
      file: "Archivo",
    diffModes: {
      pending: "Pendiente",
      included: "Incluido",
      combined: "Combinado",
    },
    fileActions: {
      selectForCommit: "Seleccionar para el commit",
      stageFile: "Preparar archivo",
      removeFromSelection: "Quitar de la selección",
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
    },
    toolbar: {
      changedFiles: "Archivos modificados",
      hiddenFiles: "Mostrar archivos ocultos",
      details: "Detalles",
      upload: "Subir",
      uploadFiles: "Subir archivos",
      uploadFolder: "Subir carpeta",
      allRepositoryFiles: "Todos los archivos del repositorio",
      repositoryView: "Vista del repositorio",
      turnView: "Vista del turno",
      sessionView: "Vista de la sesión",
      review: "Revisión",
      list: "Lista",
      scm: "Git",
    },
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
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Iniciar ejecución",
      sections: {
        intent: "Intención",
        permissions: "Permisos",
        backends: "Motores",
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
        noResults: 'Ninguna acción coincide con tu búsqueda actual.',
        noDescription: 'Todavía no hay descripción disponible.',
        requireApproval: 'Requerir aprobación',
        sections: {
            app: 'En la app',
            voice: 'Voz',
            integrations: 'Integraciones',
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
            session_agent: {
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
            contextual_ui: {
                title: 'UI contextual',
                subtitle: 'Se muestra en superficies de UI contextual que no tienen una ubicación dedicada.',
            },
        },
    },

settingsSession: {
      sessionList: {
          title: 'Lista de sesiones',
          footer: 'Personaliza lo que aparece en cada fila de sesión.',
          tagsTitle: 'Etiquetas de sesión',
          tagsEnabledSubtitle: 'Controles de etiquetas visibles en la lista de sesiones',
          tagsDisabledSubtitle: 'Controles de etiquetas ocultos',
      },
      input: {
          title: 'Entrada',
          footer: 'Configura la apariencia y el comportamiento de la barra de entrada del agente.',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Modo remoto predeterminado de Windows',
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
            thinkingPulseStaleTitle: "Ventana de caducidad del pensamiento",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Actual: ${value}ms`,
            thinkingPulseStalePromptTitle: "Ventana de caducidad del pensamiento (ms)",
            thinkingPulseStalePromptBody:
              "Oculta el pensamiento activo tras este tiempo sin actualizaciones.",
            listImplementationTitle: "Implementación de la lista del transcript",
            listImplementationSubtitle: "Cambiar el motor de lista (depuración).",
            listImplementation: {
              flashTitle: "FlashList v2 (recomendado)",
              flashSubtitle: "Mejor rendimiento para transcripciones largas.",
              legacyTitle: "FlatList heredado",
              legacySubtitle: "Alternativa para depurar compatibilidad.",
            },
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
        },
        recentMessagesTitle: "Mensajes recientes a incluir",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Límite del seed (caracteres)",
        maxSeedCharsPlaceholder: "50000",
      },
      handoff: settingsSessionHandoffTranslationExtensions.es,
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
              title: 'Almacenamiento predeterminado de sesiones',
              footer: 'Elige si las nuevas sesiones comienzan como sesiones sincronizadas de Happier o como sesiones directas respaldadas por el proveedor.',
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
    windowsTerminalSubtitle: "Abre la sesión en una ventana dedicada de Windows Terminal.",
    console: "Consola",
    shortConsole: "Consola",
    consoleSubtitle: "Abre la sesión en una ventana estándar de consola de Windows.",
  },
  settingsVoice: {
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
    },
    ui: {
      title: "Superficie de voz",
      footer: "Feed opcional en pantalla de eventos de voz (no se escribe en la sesion).",
      activityFeedEnabled: "Habilitar feed de actividad de voz",
      activityFeedEnabledSubtitle: "Mostrar eventos recientes de voz en pantalla",
      activityFeedAutoExpandOnStart: "Expandir automaticamente al iniciar",
      activityFeedAutoExpandOnStartSubtitle: "Expandir el feed automaticamente cuando inicia la voz",
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
      speakerBoostTitle: "Refuerzo del hablante",
      speakerBoostSubtitle: "Mejora la claridad y la presencia (opcional).",
      speakerBoostAuto: "Automático",
      speakerBoostAutoSubtitle: "Usar el valor predeterminado de ElevenLabs.",
      speakerBoostOn: "Activado",
      speakerBoostOnSubtitle: "Forzar el refuerzo activado.",
      speakerBoostOff: "Desactivado",
      speakerBoostOffSubtitle: "Forzar el refuerzo desactivado.",
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
          style: {
            title: "Estilo",
            subtitle: "0–1. Déjalo en blanco para el predeterminado.",
            promptTitle: "Estilo (0–1)",
            promptBody:
              "Introduce un número entre 0 y 1. Déjalo en blanco para usar el predeterminado.",
            invalid: "Introduce un número entre 0 y 1.",
          },
          speed: {
            title: "Velocidad",
            subtitle: "0.5–2. Déjalo en blanco para el predeterminado.",
            promptTitle: "Velocidad (0.5–2)",
            promptBody:
              "Introduce un número entre 0.5 y 2. Déjalo en blanco para usar el predeterminado.",
            invalid: "Introduce un número entre 0.5 y 2.",
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
    local: {
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
    },
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
    updateAvailable: "Actualización disponible",
    pressToApply: "Presione para aplicar la actualización",
    whatsNew: "Novedades",
    seeLatest: "Ver las últimas actualizaciones y mejoras",
    nativeUpdateAvailable: "Actualización de la aplicación disponible",
    tapToUpdateAppStore: "Toque para actualizar en App Store",
    tapToUpdatePlayStore: "Toque para actualizar en Play Store",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `Versión ${version}`,
    noEntriesAvailable: "No hay entradas de registro de cambios disponibles.",
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
    settings: {
      locationTitle: "Ubicación del terminal incrustado",
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
  },

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
          webDesktopOnlyTitle: 'Se requiere la app de escritorio',
          webDesktopOnlyBody: 'Abre la app de escritorio para configurar este ordenador. La app web puede mostrar el estado, pero no puede instalar ni configurar el servicio en segundo plano.',
          preAuthTitle: 'Elige tu Relay antes de iniciar sesión',
          preAuthBody: 'Elige el Relay que quieres usar en este ordenador antes de crear, restaurar o iniciar sesión en una cuenta.',
          preAuthContinueHint: 'Cuando continúes, Happier te devolverá a iniciar sesión contra el Relay seleccionado y luego volverá aquí para terminar la configuración.',
    currentRelayTitle: 'Relay seleccionado',
    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Relay seleccionado: ${relayUrl}`,
    savedRelaysTitle: 'Relays guardados',
    customRelayUrlLabel: 'URL de Relay',
    relayNameLabel: 'Nombre de Relay',
    addAndUseRelay: 'Agregar Relay',
    changeRelayAction: 'Usar otra URL de Relay',
          continueToAuth: 'Continuar con el Relay seleccionado',
          continueWithLocalRelayAction: 'Usar este Relay local y continuar',
    postAuthTitle: 'Termina de configurar este ordenador',
    postAuthBody: 'Has iniciado sesión. Continúa con el flujo de configuración local para dejar este ordenador listo para el Relay seleccionado.',
    controlPanelTitle: 'Resumen de preparación',
    activeRelaySummaryTitle: 'Relay activo',
    thisComputerSummaryTitle: 'Este ordenador',
    nextActionSummaryTitle: 'Siguiente acción',
    thisComputerReady: 'Listo para este Relay',
    nextActionReady: 'Crea tu primera sesión o añade otro ordenador abajo.',
    resumeIntentTitle: 'Continuar la configuración en este ordenador',
          resumeIntentBody: 'Inicia sesión o crea una cuenta para seguir configurando este ordenador para el Relay seleccionado.',
    openSetupAction: 'Configura este ordenador',
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
      "• Asegúrate de que tu computadora esté en línea\n• Ejecuta `happier daemon status` para diagnosticar\n• ¿Estás usando la última versión del CLI? Ejecuta `happier self update`",
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
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) => `Cambiado al modo ${mode}`,
    discarded: "Descartado",
    unknownEvent: "Evento desconocido",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Límite de uso alcanzado hasta ${time}`,
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
    switchToLocal: "Cambiar a local",
    switchToRemote: "Cambiar a remoto",
    detachLocalTerminal: "Desconectar terminal",
    directSessionTakeoverAvailable:
      "Esta sesión directa está disponible en tu máquina. Tómala en Happier para controlarla aquí.",
    directSessionMachineOffline:
      "Esta sesión directa no está disponible en este momento porque la máquina está sin conexión.",
    switchingToDirectTakeover: "Tomando esta sesión directa…",
    switchingToPersistedTakeover: "Tomando y sincronizando esta sesión…",
    takeOverDirect: "Tomar control",
    takeOverPersist: "Tomar control + Sincronizar",
    directTakeoverDialogTitle: "¿Continuar esta sesión directa en Happier?",
    directTakeoverDialogBody: "Elige cómo quieres que Happier tome el control. Directo sigue usando la transcripción del proveedor. Sincronizar importa la transcripción a Happier.",
    directTakeoverDialogDirectTitle: "Tomar control",
    directTakeoverDialogDirectBody: "Controla esta sesión en Happier sin sincronizar la transcripción dentro de Happier.",
    directTakeoverDialogPersistTitle: "Tomar control + Sincronizar",
    directTakeoverDialogPersistBody: "Importa la transcripción a Happier y continúa con todas las funciones de una sesión sincronizada.",
    directTakeoverDialogForceStopTitle: "Intentar detener primero el proceso local",
    directTakeoverDialogForceStopBody: "Happier encontró un proceso local de confianza para esta sesión. Activa esto si quieres que Happier lo detenga antes de tomar el control.",
    directTakeoverForceStopConfirmTitle: "¿Detener primero el proceso local?",
    directTakeoverForceStopConfirmBody: "Happier encontró un proceso local de confianza para esta sesión directa. ¿Detenerlo antes de tomar el control aquí?",
    directTakeoverForceStopConfirmAction: "Detener y tomar control",
  },

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
        yesForCommandName: "Sí, no volver a preguntar para este comando",
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
    noData: "No hay datos de uso disponibles",
  },

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
          "Ejecuta `claude` y luego escribe `/login` para iniciar sesión.",
        warning:
          "Nota: establecer `ANTHROPIC_AUTH_TOKEN` sobrescribe el inicio de sesión del CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Ejecuta `codex login` para iniciar sesión.",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "Ejecuta `gemini auth` para iniciar sesión.",
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
      title: 'Almacenamiento predeterminado de sesiones',
      footer: 'Anula el modo predeterminado sincronizado/directo de la cuenta para las nuevas sesiones cuando se selecciona este perfil.',
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
    },
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
} as const;

export type TranslationsEs = typeof es;
