import type { TranslationStructure } from "../_types";

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
    inbox: "Amigos",
    sessions: "Terminales",
    settings: "Configuración",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Sin actividad de amigos",
    emptyDescription:
      "Añade amigos para compartir sesiones y ver actividad aquí.",
    updates: "Actividad",
  },

  runs: {
    title: "Runs",
    empty: "No runs yet.",
  },

  common: {
    // Simple string constants
    add: "Añadir",
    actions: "Acciones",
    cancel: "Cancelar",
    close: "Cerrar",
    authenticate: "Autenticar",
    save: "Guardar",
    saveAs: "Guardar como",
    error: "Error",
    success: "Éxito",
    ok: "OK",
    continue: "Continuar",
    back: "Atrás",
    create: "Crear",
    rename: "Renombrar",
    remove: "Remove",
    signOut: "Sign out",
    keep: "Keep",
    reset: "Restablecer",
    logout: "Cerrar sesión",
    yes: "Sí",
    no: "No",
    discard: "Descartar",
    discardChanges: "Descartar cambios",
    unsavedChangesWarning: "Tienes cambios sin guardar.",
    keepEditing: "Seguir editando",
    version: "Versión",
    details: "Detalles",
    copied: "Copiado",
    copy: "Copiar",
    scanning: "Escaneando...",
    urlPlaceholder: "https://ejemplo.com",
    home: "Inicio",
    message: "Mensaje",
    send: "Enviar",
    files: "Archivos",
    fileViewer: "Visor de archivos",
    loading: "Cargando...",
    retry: "Reintentar",
    delete: "Eliminar",
    optional: "opcional",
    noMatches: "Sin coincidencias",
    all: "Todo",
    machine: "máquina",
    clearSearch: "Limpiar búsqueda",
    refresh: "Actualizar",
  },

  dropdown: {
    category: {
      general: "General",
      results: "Resultados",
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
    permissionRequired: "permiso requerido",
    activeNow: "Activo ahora",
    unknown: "desconocido",
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
    openMachine: "Abrir máquina",
    terminalUrlPlaceholder: "happier://terminal?...",
    restoreQrInstructions:
      '1. Abre Happier en tu dispositivo móvil\n2. Ve a Configuración → Cuenta\n3. Toca "Vincular nuevo dispositivo"\n4. Escanea este código QR',
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
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Conectar ${name}`,
      runCommandInTerminal: "Ejecuta el siguiente comando en tu terminal:",
    },
  },

  settings: {
    title: "Configuración",
    connectedAccounts: "Cuentas conectadas",
    connectAccount: "Conectar cuenta",
    github: "GitHub",
    machines: "Máquinas",
    features: "Características",
    social: "Social",
    account: "Cuenta",
    accountSubtitle: "Gestiona los detalles de tu cuenta",
    appearance: "Apariencia",
    appearanceSubtitle: "Personaliza como se ve la app",
    voiceAssistant: "Asistente de voz",
    voiceAssistantSubtitle: "Configura las preferencias de voz",
    featuresTitle: "Características",
    featuresSubtitle: "Habilitar o deshabilitar funciones de la aplicación",
    developer: "Desarrollador",
    developerTools: "Herramientas de desarrollador",
    about: "Acerca de",
    aboutFooter:
      "Happier Coder es un cliente móvil para Codex y Claude Code. Todo está cifrado de extremo a extremo y tu cuenta se guarda solo en tu dispositivo. No está afiliado con Anthropic.",
    whatsNew: "Novedades",
    whatsNewSubtitle: "Ve las últimas actualizaciones y mejoras",
    reportIssue: "Reportar un problema",
    privacyPolicy: "Política de privacidad",
    termsOfService: "Términos de servicio",
    eula: "EULA",
    supportUs: "Apóyanos",
    supportUsSubtitlePro: "¡Gracias por su apoyo!",
    supportUsSubtitle: "Apoya el desarrollo del proyecto",
    scanQrCodeToAuthenticate: "Escanea el código QR para autenticarte",
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
    terminal: "Terminal",
    session: "Sesión",
    sessionSubtitleTmuxEnabled: "Tmux activado",
    sessionSubtitleMessageSendingAndTmux: "Envío de mensajes y tmux",
    servers: "Servidores",
    serversSubtitle: "Servidores guardados, grupos y valores predeterminados",

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

  settingsProviders: {
    title: "Configuración del proveedor de IA",
    entrySubtitle: "Configura opciones específicas del proveedor",
    footer:
      "Configura opciones específicas del proveedor. Estos ajustes pueden afectar el comportamiento de la sesión.",
    providerSubtitle: "Ajustes específicos del proveedor",
    stateEnabled: "Enabled",
    stateDisabled: "Disabled",
    channelStable: "Stable",
    channelExperimental: "Experimental",
    supported: "Supported",
    notSupported: "Not supported",
    allowed: "Allowed",
    notAllowed: "Not allowed",
    notAvailable: "Not available",
    enabledTitle: "Enabled",
    enabledSubtitle: "Use this backend in pickers, profiles, and sessions",
    releaseChannelTitle: "Release channel",
    capabilitiesTitle: "Capabilities",
    resumeSupportTitle: "Resume support",
    sessionModeSupportTitle: "Session mode support",
    runtimeModeSwitchingTitle: "Runtime mode switching",
    localControlTitle: "Local control",
    resumeSupportSupported: "Supported",
    resumeSupportSupportedExperimental: "Supported (experimental)",
    resumeSupportRuntimeGatedAcpLoadSession:
      "Runtime-gated via ACP loadSession",
    resumeSupportNotSupported: "Not supported",
    sessionModeNone: "No ACP modes",
    sessionModeAcpPolicyPresets: "ACP policy presets",
    sessionModeAcpAgentModes: "ACP agent modes",
    runtimeSwitchNone: "No runtime switch",
    runtimeSwitchMetadataGating: "Metadata-gated",
    runtimeSwitchAcpSetSessionMode: "ACP setSessionMode",
    runtimeSwitchProviderNative: "Provider native",
    modelsTitle: "Models",
    modelSelectionTitle: "Model selection",
    freeformModelIdsTitle: "Freeform model IDs",
    defaultModelTitle: "Default model",
    catalogModelListTitle: "Catalog model list",
    catalogModelListEmpty: "No catalog models available",
    dynamicModelProbeTitle: "Dynamic model probing",
    dynamicModelProbeAuto: "Auto",
    dynamicModelProbeStaticOnly: "Static only",
    nonAcpApplyScopeTitle: "Non-ACP model apply scope",
    nonAcpApplyScopeSpawnOnly: "Apply on session start",
    nonAcpApplyScopeNextPrompt: "Apply on next prompt",
    acpApplyBehaviorTitle: "ACP model apply behavior",
    acpApplyBehaviorSetModel: "Set model live",
    acpApplyBehaviorRestartSession: "Restart session",
    acpConfigOptionTitle: "ACP model config option id",
    cliConnectionTitle: "CLI & Connection",
    detectedCliTitle: "Detected CLI",
    installSetupTitle: "Install / setup",
    installInfoSeeSetupGuide: "See setup guide",
    installInfoUseProviderCliInstaller: "Use the provider CLI installer",
    setupGuideUrlTitle: "Setup guide URL",
    connectedServiceTitle: "Connected service",
    notFoundTitle: "Proveedor no encontrado",
    notFoundSubtitle: "Este proveedor no tiene pantalla de configuración.",
    noOptionsAvailable: "No hay opciones disponibles",
    invalidNumber: "Número inválido",
    invalidJson: "JSON inválido",
  },

  settingsAppearance: {
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
      auto: "Auto",
      wrap: "Ajustar",
      scroll: "Desplazable",
      collapsed: "Contraído",
    },
    agentInputChipDensity: "Densidad de chips de acción",
    agentInputChipDensityDescription:
      "Elige si los chips de acción muestran etiquetas o íconos",
    agentInputChipDensityOptions: {
      auto: "Auto",
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
    expAutomations: "Automations",
    expAutomationsSubtitle: "Enable automations UI surfaces and scheduling",
    expExecutionRuns: "Execution runs",
    expExecutionRunsSubtitle:
      "Enable execution runs (sub-agents / reviews) control plane surfaces",
    expUsageReporting: "Usage reporting",
    expUsageReportingSubtitle: "Habilitar pantallas de uso y reporte de tokens",
    expScmOperations: "Operaciones de control de versiones",
    expScmOperationsSubtitle:
      "Habilitar operaciones de escritura experimentales de control de versiones (stage/commit/push/pull)",
    expFilesReviewComments: "File review comments",
    expFilesReviewCommentsSubtitle:
      "Add line-level review comments from file and diff views, then send them as a structured message",
    expFilesDiffSyntaxHighlighting: "Diff syntax highlighting",
    expFilesDiffSyntaxHighlightingSubtitle:
      "Enable syntax highlighting in diff and code views (with performance limits)",
    expFilesAdvancedSyntaxHighlighting: "Advanced syntax highlighting",
    expFilesAdvancedSyntaxHighlightingSubtitle:
      "Use heavier, higher-fidelity syntax highlighting (web only, may be slower)",
    expFilesEditor: "Embedded file editor",
    expFilesEditorSubtitle:
      "Enable editing files directly from the file browser (Monaco on web/desktop, CodeMirror on native)",
    expShowThinkingMessages: "Show thinking messages",
    expShowThinkingMessagesSubtitle:
      "Mostrar mensajes de pensamiento/estado del asistente en el chat",
    expSessionType: "Session type selector",
    expSessionTypeSubtitle:
      "Mostrar el selector de tipo de sesión (simple vs worktree)",
    expZen: "Zen",
    expZenSubtitle: "Habilitar la entrada de navegación Zen",
    expVoiceAuthFlow: "Voice auth flow",
    expVoiceAuthFlowSubtitle:
      "Usar flujo autenticado de token de voz (con paywall)",
    expFriends: "Amigos",
    expFriendsSubtitle: "Activa las funciones de amigos (pestaña Bandeja de entrada y compartir sesiones)",
    webFeatures: "Características web",
    webFeaturesDescription:
      "Características disponibles solo en la versión web de la aplicación.",
    enterToSend: "Enter para enviar",
    enterToSendEnabled:
      "Presiona Enter para enviar (Shift+Enter para una nueva línea)",
    enterToSendDisabled: "Enter inserta una nueva línea",
    historyScope: "Message history",
    historyScopePerSession: "Cycle history per terminal",
    historyScopeGlobal: "Cycle history across all terminals",
    historyScopeModalTitle: "Message history",
    historyScopeModalMessage:
      "Choose whether ArrowUp/ArrowDown cycles through messages sent in this terminal only, or across all terminals.",
    historyScopePerSessionOption: "Per terminal",
    historyScopeGlobalOption: "Global",
    commandPalette: "Paleta de comandos",
    commandPaletteEnabled: "Presione ⌘K para abrir",
    commandPaletteDisabled: "Acceso rápido a comandos deshabilitado",
    markdownCopyV2: "Copia de Markdown v2",
    markdownCopyV2Subtitle: "Pulsación larga abre modal de copiado",
    hideInactiveSessions: "Ocultar sesiones inactivas",
    hideInactiveSessionsSubtitle: "Muestra solo los chats activos en tu lista",
    groupInactiveSessionsByProject: "Agrupar sesiones inactivas por proyecto",
    groupInactiveSessionsByProjectSubtitle:
      "Organiza los chats inactivos por proyecto",
    environmentBadge: "Environment badge",
    environmentBadgeSubtitle:
      "Show a small badge next to the Happier title indicating the current app environment",
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
    fileNotFound: "Archivo no encontrado",
    invalidFormat: "Formato inválido",
    operationFailed: "Operación falló",
    tryAgain: "Intenta de nuevo",
    contactSupport: "Contacta soporte si el problema persiste",
    sessionNotFound: "Sesión no encontrada",
    voiceSessionFailed: "Falló al iniciar sesión de voz",
    voiceServiceUnavailable:
      "El servicio de voz no está disponible temporalmente",
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
      "Codex resume no está instalado en esta máquina",
    codexResumeNotInstalledMessage:
      "Para reanudar una conversación de Codex, instala el servidor de reanudación de Codex en la máquina de destino (Detalles de la máquina → Reanudación de Codex).",
    codexAcpNotInstalledTitle: "Codex ACP no está instalado en esta máquina",
    codexAcpNotInstalledMessage:
      "Para usar el experimento de Codex ACP, instala codex-acp en la máquina de destino (Detalles de la máquina → Codex ACP) o desactiva el experimento.",
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
        installSpecTitle: "Fuente de instalación de Codex resume",
      },
      codexAcp: {
        title: "Adaptador ACP de Codex",
        installSpecTitle: "Fuente de instalación de Codex ACP",
      },
      installSpecDescription:
        "Especificación de NPM/Git/archivo pasada a `npm install` (experimental). Déjalo vacío para usar el valor predeterminado del daemon.",
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
      installSpecPlaceholder:
        "p. ej. file:/ruta/al/paquete o github:propietario/repo#rama",
      lastInstallLog: "Último registro de instalación",
      installLogTitle: "Registro de instalación",
    },
  },

  newSession: {
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
    selectSessionTypeTitle: "Seleccionar tipo de sesión",
    selectSessionTypeDescription:
      "Elige una sesión simple o una vinculada a un worktree de Git.",
    searchPathsPlaceholder: "Buscar rutas...",
    noMachinesFound:
      "No se encontraron máquinas. Inicia una sesión de Happier en tu computadora primero.",
    allMachinesOffline: "Todas las máquinas están desconectadas",
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
      simple: "Simple",
      worktree: "Worktree",
      comingSoon: "Próximamente",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Requiere ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) => `${cli} CLI no detectado`,
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
      pickerTitle: "Reanudar sesión",
      subtitle: ({ agent }: { agent: string }) =>
        `Pega un ID de sesión de ${agent} para reanudar`,
      placeholder: ({ agent }: { agent: string }) =>
        `Pega el ID de sesión de ${agent}…`,
      paste: "Pegar",
      save: "Guardar",
      clearAndRemove: "Borrar",
      helpText:
        "Puedes encontrar los IDs de sesión en la pantalla de información de sesión.",
      cannotApplyBody:
        "Este ID de reanudación no se puede aplicar ahora. Happier iniciará una nueva sesión en su lugar.",
    },
    codexResumeBanner: {
      title: "Codex resume",
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
      installTitle: "¿Instalar Codex resume?",
      updateTitle: "¿Actualizar Codex resume?",
      reinstallTitle: "¿Reinstalar Codex resume?",
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

  session: {
    inputPlaceholder: "Escriba un mensaje ...",
    resuming: "Reanudando...",
    resumeFailed: "No se pudo reanudar la sesión",
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
  },

  voiceActivity: {
    title: "Actividad de voz",
    empty: "Aún no hay actividad de voz.",
    clear: "Limpiar",
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Configuración del servidor",
    enterServerUrl: "Ingresa una URL de servidor",
    notValidHappyServer: "No es un servidor Happier válido",
    changeServer: "Cambiar servidor",
    continueWithServer: "¿Continuar con este servidor?",
    resetToDefault: "Restablecer por defecto",
    resetServerDefault: "¿Restablecer servidor por defecto?",
    validating: "Validando...",
    validatingServer: "Validando servidor...",
    serverReturnedError: "El servidor devolvió un error",
    failedToConnectToServer: "Falló al conectar con el servidor",
    currentlyUsingCustomServer: "Actualmente usando servidor personalizado",
    customServerUrlLabel: "URL del servidor personalizado",
    advancedFeatureFooter:
      "Esta es una característica avanzada. Solo cambia el servidor si sabes lo que haces. Necesitarás cerrar sesión e iniciarla nuevamente después de cambiar servidores.",
    useThisServer: "Use this server",
    autoConfigHint:
      "If you’re self-hosting: configure the server first, then sign in (or create an account), then connect your terminal.",
    renameServer: "Rename server",
    renameServerPrompt: "Enter a new name for this server.",
    renameServerGroup: "Rename server group",
    renameServerGroupPrompt: "Enter a new name for this server group.",
    serverNamePlaceholder: "Server name",
    cannotRenameCloud: "You can’t rename the cloud server.",
    removeServer: "Remove server",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Remove "${name}" from saved servers?`,
    removeServerGroup: "Remove server group",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Remove "${name}" from saved server groups?`,
    cannotRemoveCloud: "You can’t remove the cloud server.",
    signOutThisServer: "Also sign out from this server?",
    signOutThisServerPrompt:
      "Stored credentials were found for this server on this device.",
    savedServersTitle: "Saved servers",
    signedIn: "Signed in",
    signedOut: "Signed out",
    authStatusUnknown: "Auth status unknown",
    switchToServer: "Switch to this server",
    active: "Active",
    default: "Default",
    addServerTitle: "Add server",
    switchForThisTab: "Switch for this tab",
    makeDefaultOnDevice: "Make default on this device",
    serverNameLabel: "Server name",
    addAndUse: "Add and use",
    addTargetsTitle: "Add",
    addServerSubtitle: "Add a new server and switch to it",
    addServerGroupTitle: "Add server group",
    addServerGroupSubtitle: "Create a reusable group of servers",
    serverGroupNameLabel: "Group name",
    serverGroupNamePlaceholder: "My server group",
    serverGroupServersLabel: "Servers",
    saveServerGroup: "Save group",
    serverGroupMustHaveServer: "A server group must include at least one server.",
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "Terminar sesión",
    killSessionConfirm: "¿Seguro que quieres terminar esta sesión?",
    archiveSession: "Archivar sesión",
    archiveSessionConfirm: "¿Seguro que quieres archivar esta sesión?",
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
    piSessionId: "ID de sesión de Pi",
    piSessionIdCopied: "ID de sesión de Pi copiado al portapapeles",
    metadataCopied: "Metadatos copiados al portapapeles",
    failedToCopyMetadata: "Falló al copiar metadatos",
    failedToKillSession: "Falló al terminar sesión",
    failedToArchiveSession: "Falló al archivar sesión",
    connectionStatus: "Estado de conexión",
    created: "Creado",
    lastUpdated: "Última actualización",
    sequence: "Secuencia",
    quickActions: "Acciones rápidas",
    copyResumeCommand: "Copiar comando de reanudación",
    viewMachine: "Ver máquina",
    viewMachineSubtitle: "Ver detalles de máquina y sesiones",
    killSessionSubtitle: "Terminar inmediatamente la sesión",
    archiveSessionSubtitle: "Archivar esta sesión y detenerla",
    metadata: "Metadatos",
    host: "Host",
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
      "Por favor ejecute npm install -g @happier-dev/cli@latest",
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
    failedToRenameSession: "Error al renombrar la sesión",
    sessionRenamed: "Sesión renombrada exitosamente",
  },

  components: {
    emptyMainScreen: {
      // Used by EmptyMainScreen component
      readyToCode: "¿Listo para programar?",
      installCli: "Instale el Happier CLI",
      runIt: "Ejecútelo",
      scanQrCode: "Escanee el código QR",
      openCamera: "Abrir cámara",
      installCommand: "$ npm i -g @happier-dev/cli",
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
      pi: "Pi",
    },
    auggieIndexingChip: {
      on: "Indexing on",
      off: "Indexing off",
    },
    model: {
      title: "MODELO",
      configureInCli: "Configurar modelos en la configuración del CLI",
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
    taskView: {
      initializing: "Inicializando agente...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} más ${plural({ count, singular: "herramienta", plural: "herramientas" })}`,
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Edición ${index} de ${total}`,
      replaceAll: "Reemplazar todo",
    },
    names: {
      task: "Tarea",
      terminal: "Terminal",
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
      viewDiff: "Cambios del archivo actual",
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
    detachedHead: "HEAD separado",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} preparados • ${unstaged} sin preparar`,
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `Repository changed files (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Session-attributed changes (${count})`,
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Other repository changes (${count})`,
    attributionReliabilityHigh:
      "Best effort attribution. Repository view remains the source of truth.",
    attributionReliabilityLimited:
      "Reliability limited: multiple sessions are active for this repository. Showing direct attribution only.",
    attributionLegendFull:
      "direct = from this session operations, inferred = snapshot-based attribution",
    attributionLegendDirectOnly: "direct = from this session operations",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} inferred file${count === 1 ? "" : "s"} kept in repository-only changes.`,
    noSessionAttributedChanges:
      "No session-attributed changes currently detected.",
    notRepo: "No es un repositorio de control de versiones",
    notUnderSourceControl: "Este directorio no está bajo control de versiones",
    searching: "Buscando archivos...",
	    noFilesFound: "No se encontraron archivos",
	    noFilesInProject: "No hay archivos en el proyecto",
	    repositoryFolderLoadFailed: "No se pudo cargar la carpeta",
	    repositoryCollapseAll: "Contraer todo",
	    reviewFilterPlaceholder: "Filtrar archivos...",
	    reviewNoMatches: "Sin coincidencias",
	    reviewLargeDiffOneAtATime: "Diff grande detectado; se muestra un archivo a la vez.",
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
    loadingFile: ({ fileName }: { fileName: string }) =>
      `Cargando ${fileName}...`,
    binaryFile: "Archivo binario",
    cannotDisplayBinary: "No se puede mostrar el contenido del archivo binario",
    diff: "Diferencias",
    file: "Archivo",
    fileEmpty: "El archivo está vacío",
    noChanges: "No hay cambios que mostrar",
  },

  settingsSession: {
    messageSending: {
      title: "Message sending",
      footer:
        "Controls what happens when you send a message while the agent is running.",
      queueInAgentTitle: "Queue in agent (current)",
      queueInAgentSubtitle:
        "Write to transcript immediately; agent processes when ready.",
      interruptTitle: "Interrupt & send",
      interruptSubtitle: "Abort current turn, then send immediately.",
      pendingTitle: "Pending until ready",
      pendingSubtitle:
        "Keep messages in a pending queue; agent pulls when ready.",
      busySteerPolicyTitle: "When the agent is busy (steer-capable)",
      busySteerPolicyFooter:
        "If the agent supports in-flight steering, choose whether messages steer immediately or go to Pending first.",
      busySteerPolicy: {
        steerImmediatelyTitle: "Steer immediately",
        steerImmediatelySubtitle:
          "Send right away and steer the current turn (no interrupt).",
        queueForReviewTitle: "Queue in Pending",
        queueForReviewSubtitle:
          "Put messages into Pending first; send later using “Steer now”.",
      },
    },
    toolRendering: {
      title: "Tool rendering",
      footer:
        "Controls how much tool detail is shown in the session timeline. This is a UI preference; it does not change agent behavior.",
      defaultToolDetailLevelTitle: "Default tool detail level",
      localControlDefaultTitle: "Local-control default",
      showDebugByDefaultTitle: "Show debug by default",
      showDebugByDefaultSubtitle:
        "Auto-expand raw tool payloads in the full tool view.",
    },
    toolDetailOverrides: {
      title: "Tool detail overrides",
      footer:
        "Override the detail level for specific tools. Overrides apply to the canonical tool name (V2), after legacy normalization.",
    },
    replayResume: {
      title: "Replay resume",
      footer:
        "When vendor resume is unavailable, optionally replay recent transcript messages into a new session as context.",
      enabledTitle: "Enable replay resume",
      enabledSubtitleOn:
        "Offer replay-based resume when vendor resume is unavailable.",
      enabledSubtitleOff: "Do not offer replay-based resume.",
      strategyTitle: "Replay strategy",
      strategy: {
        recentTitle: "Recent messages",
        recentSubtitle: "Use only the most recent transcript messages.",
        summaryRecentTitle: "Summary + recent (experimental)",
        summaryRecentSubtitle:
          "Include a short summary and recent messages (best-effort).",
      },
      recentMessagesTitle: "Recent messages to include",
      recentMessagesPlaceholder: "16",
    },
    defaultPermissions: {
      title: "Default permissions",
      footer:
        "Applies when starting a new session. Profiles can optionally override this.",
      applyPermissionChangesTitle: "Apply permission changes",
      applyPermissionChangesImmediateSubtitle:
        "Apply immediately for running sessions (updates session metadata).",
      applyPermissionChangesNextPromptSubtitle: "Apply on next message only.",
    },
    toolDetailLevel: {
      titleOnlyTitle: "Title only",
      titleOnlySubtitle: "Show only the tool name (no body) in the timeline.",
      summaryTitle: "Summary",
      summarySubtitle: "Show a compact, safe summary in the timeline.",
      fullTitle: "Full",
      fullSubtitle: "Show full details inline in the timeline.",
      defaultTitle: "Default",
      defaultSubtitle: "Use the global default.",
    },
    terminalConnect: {
      title: "Terminal connect",
      legacySecretExportTitle: "Legacy secret export (compatibility)",
      legacySecretExportEnabledSubtitle:
        "Enabled: exports your legacy account secret to the terminal so older terminals can connect. Not recommended.",
      legacySecretExportDisabledSubtitle:
        "Disabled (recommended): provision terminals with the content key only (Terminal Connect V2).",
    },
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
        autoTitle: "Auto",
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
          autoTitle: "Auto",
          autoSubtitle: "Permitir fragmentos automáticos (ruidoso).",
        },
      },
    },
    byo: {
      title: "Usar mi ElevenLabs",
      configured:
        "Configurado. El uso de voz se facturará a tu cuenta de ElevenLabs.",
      notConfigured:
        "Introduce tu clave API de ElevenLabs y el ID del Agente para usar voz sin una suscripción.",
      createAccount: "Crear cuenta de ElevenLabs",
      createAccountSubtitle:
        "Regístrate (o inicia sesión) antes de crear una clave API",
      openApiKeys: "Open ElevenLabs API keys",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "How to create an API key",
      apiKeyHelpSubtitle:
        "Step-by-step help for creating and copying your ElevenLabs API key",
      apiKeyHelpDialogTitle: "Create an ElevenLabs API key",
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
      voiceSearchPlaceholder: "Search voices",
      speakerBoostTitle: "Speaker boost",
      speakerBoostSubtitle: "Improve clarity and presence (optional).",
      speakerBoostAuto: "Auto",
      speakerBoostAutoSubtitle: "Use ElevenLabs default.",
      speakerBoostOn: "On",
      speakerBoostOnSubtitle: "Force enable speaker boost.",
      speakerBoostOff: "Off",
      speakerBoostOffSubtitle: "Force disable speaker boost.",
      voiceGroupTitle: "Voice",
      voiceGroupFooter:
        "Choose how your ElevenLabs agent speaks. Changes apply when you update the agent.",
      provisioningGroupTitle: "Agent provisioning",
      provisioningGroupFooter:
        "If you change voice/tuning, tap Update Agent to apply it in ElevenLabs.",
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
      conversationMode: "Modo de conversación",
      conversationModeSubtitle:
        "Directo a la sesión, o mediador con commit explícito",
      mediatorBackend: "Backend del mediador",
      mediatorBackendSubtitle:
        "Daemon (usa tu backend de Happier) u OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Daemon",
      mediatorBackendOpenAi: "OpenAI-compatible HTTP",
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
      deviceStt: "Device STT (experimental)",
      deviceSttSubtitle:
        "Use on-device speech recognition instead of an OpenAI-compatible endpoint",
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
      testTts: "Test TTS",
      testTtsSubtitle:
        "Play a short sample using your configured local TTS (device TTS or endpoint)",
      testTtsSample: "Hello from Happier. This is a test of your local TTS.",
      testTtsMissingBaseUrl: "Set a TTS Base URL first.",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "Device TTS (experimental)",
      deviceTtsSubtitle:
        "Use on-device speech synthesis instead of an OpenAI-compatible endpoint",
      ttsProvider: "TTS Provider",
      ttsProviderSubtitle:
        "Choose device TTS, an OpenAI-compatible endpoint, or Kokoro (web/desktop)",

      autoSpeak: "Auto-reproducir respuestas",
      autoSpeakSubtitle:
        "Reproduce la siguiente respuesta del asistente después de enviar tu mensaje de voz",
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
    linkNewDevice: "Vincular nuevo dispositivo",
    linkNewDeviceSubtitle: "Escanear código QR para vincular dispositivo",
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
    dangerZone: "Zona peligrosa",
    logout: "Cerrar sesión",
    logoutSubtitle: "Cerrar sesión y limpiar datos locales",
    logoutConfirm:
      "¿Seguro que quieres cerrar sesión? ¡Asegúrate de haber guardado tu clave secreta!",
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

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Autenticar terminal",
    pasteUrlFromTerminal: "Pega la URL de autenticación de tu terminal",
    deviceLinkedSuccessfully: "Dispositivo vinculado exitosamente",
    terminalConnectedSuccessfully: "Terminal conectado exitosamente",
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
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "Conectar terminal",
    linkNewDevice: "Vincular nuevo dispositivo",
    restoreWithSecretKey: "Restaurar con clave secreta",
    whatsNew: "Novedades",
    friends: "Amigos",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Cliente móvil de Codex y Claude Code",
    subtitle:
      "Cifrado de extremo a extremo y tu cuenta se guarda solo en tu dispositivo.",
    createAccount: "Crear cuenta",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Continuar con ${provider}`,
    linkOrRestoreAccount: "Vincular o restaurar cuenta",
    loginWithMobileApp: "Iniciar sesión con aplicación móvil",
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
  },

  machine: {
    offlineUnableToSpawn:
      "El lanzador está deshabilitado mientras la máquina está desconectada",
    offlineHelp:
      "• Asegúrate de que tu computadora esté en línea\n• Ejecuta `happier daemon status` para diagnosticar\n• ¿Estás usando la última versión del CLI? Actualiza con `npm install -g @happier-dev/cli@latest`",
    launchNewSessionInDirectory: "Iniciar nueva sesión en directorio",
    daemon: "Demonio",
    status: "Estado",
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
    lastKnownPid: "Último PID conocido",
    lastKnownHttpPort: "Último puerto HTTP conocido",
    startedAt: "Iniciado en",
    cliVersion: "Versión del CLI",
    daemonStateVersion: "Versión del estado del daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Sesiones activas (${count})`,
    machineGroup: "Máquina",
    host: "Host",
    machineId: "ID de máquina",
    username: "Nombre de usuario",
    homeDirectory: "Directorio principal",
    platform: "Plataforma",
    architecture: "Arquitectura",
    lastSeen: "Visto por última vez",
    never: "Nunca",
    metadataVersion: "Versión de metadatos",
    detectedClis: "CLI detectados",
    detectedCliNotDetected: "No detectado",
    detectedCliUnknown: "Desconocido",
    detectedCliNotSupported: "No compatible (actualiza @happier-dev/cli)",
    untitledSession: "Sesión sin título",
    back: "Atrás",
    notFound: "Máquina no encontrada",
    unknownMachine: "máquina desconocida",
    unknownPath: "ruta desconocida",
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
    switchToRemote: "Cambiar a remoto",
    localModeAvailable: "El modo local está disponible para esta sesión.",
    localModeUnavailableMachineOffline:
      "El modo local no está disponible mientras esta máquina esté sin conexión.",
    localModeUnavailableDaemonStarted:
      "El modo local no está disponible para sesiones iniciadas por el daemon.",
    localModeUnavailableNeedsResume:
      "El modo local requiere soporte de reanudación para este proveedor.",
    switchToLocal: "Cambiar a local",
  },

  codex: {
    // Codex permission dialog buttons
    permissions: {
      yesAlwaysAllowCommand: "Sí, permitir globalmente",
      yesForSession: "Sí, y no preguntar por esta sesión",
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
    tokens: "Tokens",
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
    defaultSessionType: "Tipo de sesión predeterminado",
    defaultPermissionMode: {
      title: "Modo de permisos predeterminado",
      descriptions: {
        default: "Pedir permisos",
        acceptEdits: "Aprobar ediciones automáticamente",
        plan: "Planificar antes de ejecutar",
        bypassPermissions: "Omitir todos los permisos",
      },
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
      piSubtitleExperimental: "CLI de Pi (experimental)",
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
