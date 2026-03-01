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
        name: "Sesión programada",
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
    actions: "Acciones",
    moreActions: "Más acciones",
    moreActionsHint: "Abre un menú con más acciones",
    cancel: "Cancelar",
    close: "Cerrar",
      open: "Abrir",
      done: "Hecho",
      reorder: "Reordenar",
      authenticate: "Autenticar",
      save: "Guardar",
    saveAs: "Guardar como",
    error: "Error",
    success: "Éxito",
    ok: "OK",
    continue: "Continuar",
    back: "Atrás",
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
    expand: "Expandir",
    collapse: "Colapsar",
    command: "Comando",
    scanning: "Escaneando...",
    urlPlaceholder: "https://ejemplo.com",
    home: "Inicio",
    message: "Mensaje",
    send: "Enviar",
    attach: "Adjuntar",
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
      groupTitle: "Incrustaciones",
      groupFooter:
        "Opcional: descarga un modelo local para mejorar las coincidencias semánticas al usar el modo Profundo.",
      enableTitle: "Habilitar embeddings",
      enableSubtitle:
        "Mejora el ranking de la búsqueda profunda (descarga un modelo en el primer uso)",
      modelTitle: "Modelo de embeddings",
      promptBody: "Introduce un id de modelo local de transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
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
      groupTitle: "Subagente",
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
    },
  },

  settings: {
    title: "Configuración",
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
    developer: "Desarrollador",
    developerTools: "Herramientas de desarrollador",
    about: "Acerca de",
    actionsSettingsAboutSubtitle:
      "Habilita o deshabilita acciones globalmente, por superficie (UI/voz/MCP) y por ubicación (dónde aparecen en la interfaz). Las acciones deshabilitadas se bloquean de forma segura en tiempo de ejecución.",
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
    servers: "Servidores",
    serversSubtitle: "Servidores guardados, grupos y valores predeterminados",
    systemStatus: "Estado del sistema",
    systemStatusSubtitle: "Servidores, cuenta, máquinas, daemon",

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
      currentServer: "Servidor actual",
      identity: "Identidad conectada",
      configuredServers: "Servidores configurados",
      machinesActiveServer: "Máquinas (servidor activo)",
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
      activeServer: "Servidor activo",
    },
    identity: {
      accountId: "ID de cuenta",
      username: "Nombre de usuario",
    },
    servers: {
      noneConfigured: "No hay servidores configurados",
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
        loading: "Obteniendo servidor/cuenta del daemon…",
        invalid: "No se pudo leer el doctor snapshot desde la máquina",
      },
      daemonAttributionUnknown: "Servidor/cuenta del daemon: desconocido",
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
      runDiagnosisSubtitle: "Detecta desajustes de servidor/cuenta/daemon",
      refreshMachineAttribution: "Actualizar atribución del daemon",
      refreshMachineAttributionSubtitle: "Obtén servidor/cuenta del daemon para algunas máquinas en línea",
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
      activeServer: "Servidor activo",
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
      pasteRedirectUrlPromptBody:
        "Después de completar OAuth, copia la URL final redirigida desde la barra de direcciones del navegador y pégala aquí.",
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
        "Si la página de verificación indica que la autorización por código de dispositivo está desactivada, activa “Enable device code authorization for Codex” en la configuración de ChatGPT e inténtalo de nuevo.",
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
      uploadTtl: {
        title: "TTL de subida (ms)",
        promptTitle: "TTL de subida (ms)",
        promptMessage:
          "Cuánto tiempo puede permanecer inactiva una subida antes de caducar.",
        invalidValueMessage: "Introduce un número entre 5000 y 3600000.",
      },
      chunkSize: {
        title: "Tamaño de bloque preferido (bytes)",
        promptTitle: "Tamaño de bloque preferido (bytes)",
        promptMessage: "El CLI puede limitarlo a límites seguros.",
        invalidValueMessage: "Introduce un número entre 4096 y 1048576.",
      },
    },
  },

  settingsSourceControl: {
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

  settingsNotifications: {
    push: {
      title: "Notificaciones push",
      footer:
        "Estas notificaciones se envían desde tu CLI mediante Expo cuando tu sesión necesita atención.",
      enabledSubtitle: "Permitir notificaciones push en esta cuenta",
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
      resumeSupportRuntimeGatedAcpLoadSession:
        "Controlado en tiempo de ejecución vía ACP loadSession",
      resumeSupportNotSupported: "No compatible",
      sessionModeNone: "Sin modos ACP",
      sessionModeAcpPolicyPresets: "Preajustes de políticas ACP",
      sessionModeAcpAgentModes: "Modos de agente ACP",
      sessionModeStaticAgentModes: "Modos de agente estáticos",
      runtimeSwitchNone: "Sin cambio en tiempo de ejecución",
      runtimeSwitchMetadataGating: "Controlado por metadatos",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
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
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `Instalar CLI de ${provider}`,
        reinstallTitle: ({ provider }: { provider: string }) => `Reinstalar CLI de ${provider}`,
        autoInstallUnavailable: "La instalación automática no está disponible para esta máquina.",
        installSubtitle: "Instala la CLI del proveedor en la máquina seleccionada (mejor esfuerzo).",
        reinstallSubtitle: "Vuelve a ejecutar el instalador del proveedor aunque la CLI ya esté presente.",
        noMachineSelected: "No se seleccionó ninguna máquina.",
        installNotSupported: "La instalación no está soportada en esta máquina.",
        installFailed: "La instalación falló.",
        installed: "Instalado.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL de la guía de configuración",
      connectedServiceTitle: "Servicio conectado",
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
      expMemorySearch: "Búsqueda de memoria",
      expMemorySearchSubtitle:
        "Habilitar pantallas y ajustes de búsqueda de memoria local",
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
      title: "Reanudación de Codex",
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
    activity: "Actividad",
    activityCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} más…`,
    forking: {
      dividerTitle: "Bifurcado desde un contexto anterior",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Bifurcado desde ${parent}`,
      dividerSubtitle: "Contexto anterior (solo lectura)",
      openParent: "Abrir",
      openParentA11y: "Abrir sesión padre",
      forkFromMessageA11y: "Bifurcar desde este mensaje",
    },
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
          openRuns: "Abrir ejecuciones de la sesión",
          openAutomations: "Abrir automatizaciones de la sesión",
          participants: {
            to: 'A',
            lead: 'Principal',
            sendToTitle: 'Enviar a',
            broadcast: ({ teamId }: { teamId: string }) => `Difusión: ${teamId}`,
            executionRun: ({ runId }: { runId: string }) => `Ejecución ${runId}`,
            cardTo: ({ label }: { label: string }) => `A: ${label}`,
            unsupportedAttachmentsOrReviewComments: 'Enviar a un destinatario aún no admite adjuntos ni comentarios de revisión.',
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
                pinnedTabA11y: "Pestaña fijada",
                closeTabA11y: "Cerrar pestaña",
                enterFocusModeA11y: "Entrar en modo de enfoque del editor",
                exitFocusModeA11y: "Salir del modo de enfoque del editor",
        },
  
      actionsDraft: {
        noInputHints: "Esta acción no tiene sugerencias de entrada.",
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
        untriaged: "Sin clasificar",
        accept: "Aceptar",
        reject: "Rechazar",
        defer: "Aplazar",
        needsRefinement: "Requiere refinamiento",
      },
      refinementPlaceholder: "Comentario opcional para refinamiento",
      actions: {
        applyTriage: "Aplicar clasificación",
        applying: "Aplicando…",
        applyAcceptedFindings: "Aplicar hallazgos aceptados",
        sending: "Enviando…",
      },
      errors: {
        applyTriageFailed: "No se pudo aplicar la clasificación.",
        applyAcceptedFailed: "No se pudieron aplicar los hallazgos aceptados.",
      },
    },

        pendingMessages: {
          title: "Mensajes pendientes",
          indicator: ({ count }: { count: number }) => `Pendiente (${count})`,
          badgeLabel: ({ count }: { count: number }) => (count > 0 ? `Pendiente (+${count})` : "Pendiente"),
          empty: "No hay mensajes pendientes.",
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
    useThisServer: "Usar este servidor",
    autoConfigHint:
      "Si alojas tu propio servidor: configúralo primero, luego inicia sesión (o crea una cuenta) y, por último, conecta tu terminal.",
    renameServer: "Renombrar servidor",
    renameServerPrompt: "Introduce un nuevo nombre para este servidor.",
    renameServerGroup: "Renombrar grupo de servidores",
    renameServerGroupPrompt:
      "Introduce un nuevo nombre para este grupo de servidores.",
    serverNamePlaceholder: "Nombre del servidor",
    cannotRenameCloud: "No puedes renombrar el servidor en la nube.",
    removeServer: "Eliminar servidor",
    removeServerConfirm: ({ name }: { name: string }) =>
      `¿Eliminar "${name}" de los servidores guardados?`,
    removeServerGroup: "Eliminar grupo de servidores",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `¿Eliminar "${name}" de los grupos de servidores guardados?`,
    cannotRemoveCloud: "No puedes eliminar el servidor en la nube.",
    signOutThisServer: "¿Cerrar sesión también en este servidor?",
    signOutThisServerPrompt:
      "Se encontraron credenciales guardadas para este servidor en este dispositivo.",
    savedServersTitle: "Servidores guardados",
    signedIn: "Con sesión iniciada",
    signedOut: "Sesión cerrada",
    authStatusUnknown: "Estado de autenticación desconocido",
    switchToServer: "Cambiar a este servidor",
    active: "Activo",
    default: "Predeterminado",
    addServerTitle: "Añadir servidor",
    switchForThisTab: "Cambiar para esta pestaña",
    makeDefaultOnDevice: "Hacer predeterminado en este dispositivo",
    serverNameLabel: "Nombre del servidor",
    addAndUse: "Añadir y usar",
      addTargetsTitle: "Añadir",
      addServerSubtitle: "Añade un servidor nuevo y cámbiate a él",
      notificationAddServerHint: "Este servidor aún no está guardado en este dispositivo. Añádelo abajo para continuar.",
      serverCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, singular: "servidor", plural: "servidores" })}`,
      useCanonicalServerUrlTitle: "¿Usar la URL canónica del servidor?",
    useCanonicalServerUrlBody:
      "Este servidor anuncia una URL canónica que debería funcionar desde otros dispositivos. ¿Quieres usarla en lugar de la que ingresaste?",
    insecureHttpUrlTitle: "URL del servidor insegura",
    insecureHttpUrlBody:
      "Esta URL usa http:// y puede que no funcione desde tu teléfono o fuera de tu LAN. Usa HTTPS si es posible. ¿Continuar de todos modos?",
    signedOutSwitchConfirmTitle: "No estás conectado",
    signedOutSwitchConfirmBody:
      "¿Cambiar a este servidor y continuar a la pantalla de inicio para que puedas iniciar sesión o crear una cuenta?",
    addServerGroupTitle: "Añadir grupo de servidores",
    addServerGroupSubtitle: "Crea un grupo reutilizable de servidores",
    serverGroupNameLabel: "Nombre del grupo",
    serverGroupNamePlaceholder: "Mi grupo de servidores",
    serverGroupServersLabel: "Servidores",
    saveServerGroup: "Guardar grupo",
    serverGroupMustHaveServer:
      "Un grupo de servidores debe incluir al menos un servidor.",
    multiServerView: {
      title: "Vista concurrente de múltiples servidores",
      footer:
        "Elige si quieres combinar varios servidores en una sola lista de sesiones.",
      enableTitle: "Habilitar vista concurrente",
      enableSubtitle:
        "Mostrar juntas las sesiones de los servidores seleccionados",
      presentationTitle: "Modo de presentación",
      presentation: {
        flatWithBadges: "Lista plana con insignias de servidor",
        groupedByServer: "Agrupado por servidor",
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
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "Terminar sesión",
    killSessionConfirm: "¿Seguro que quieres terminar esta sesión?",
    stopSession: "Detener sesión",
    stopSessionConfirm: "¿Seguro que quieres detener esta sesión?",
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
      badgeA11y: ({ name }: { name: string }) => `Modo: ${name}`,
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
    taskView: {
      initializing: "Inicializando agente...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} más ${plural({ count, singular: "herramienta", plural: "herramientas" })}`,
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
      allRepositoryFiles: "Todos los archivos del repositorio",
      repositoryView: "Vista del repositorio",
      sessionView: "Vista de la sesión",
      review: "Revisión",
      list: "Lista",
      scm: "Git",
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
      labels: {
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

    settingsSession: {
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
          cardTapActionTitle: "Acción al tocar (tarjeta)",
          timelineChrome: {
            title: "Estilo de herramientas en la línea de tiempo",
            cardsTitle: "Tarjetas",
          cardsSubtitle:
            "Tarjetas de herramientas con contenido en línea (según el nivel de detalle).",
          activityFeedTitle: "Feed de actividad",
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
          defaultDetailTitle: "Detalle predeterminado (feed de actividad)",
          expandedDetailTitle: "Detalle expandido (feed de actividad)",
          tapActionTitle: "Acción al tocar (feed de actividad)",
          tapAction: {
            expandTitle: "Expandir",
            expandSubtitle: "Tocar expande o contrae detalles en línea.",
            openTitle: "Abrir",
            openSubtitle: "Tocar abre la vista completa de la herramienta.",
          },
          defaultExpandedTitle: "Expandido por defecto",
          defaultExpandedSubtitle:
            "Expandir filas por defecto en el feed de actividad.",
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
        layoutTitle: "Diseño",
        layoutFooter:
          "Elige entre una transcripción lineal y el agrupamiento por turnos.",
        layoutPickerTitle: "Diseño de transcripción",
        layout: {
          linearTitle: "Lineal (actual)",
          linearSubtitle: "Muestra los mensajes como una lista plana.",
          turnsTitle: "Turnos",
          turnsSubtitle: "Agrupa mensajes en turnos usuario/asistente.",
        },
        activityGroupTitle: "Agrupar herramientas en Actividad",
        activityGroupSubtitle:
          "Compacta llamadas de herramientas en una sección Actividad dentro de cada turno.",
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
          jumpToBottomTitle: "Botón de ir al final",
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
            "Controla cómo se forma Actividad dentro de los turnos.",
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
          activityStrategyTitle: "Estrategia de agrupación de Actividad",
          activityStrategy: {
            consecutiveTitle: "Herramientas consecutivas (predeterminado)",
            consecutiveSubtitle:
              "Agrupa solo llamadas consecutivas en Actividad.",
            allToolsTitle: "Todas las herramientas del turno",
            allToolsSubtitle:
              "Agrupa todas las herramientas del turno en una sola sección Actividad.",
          },
            activityCollapsedPreviewCountTitle: "Vista previa (colapsado)",
            activityCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Muestra las últimas ${value} herramientas cuando Actividad está colapsado.`,
            activityCollapsedPreviewCount: {
              offTitle: "Desactivado",
              offSubtitle: "Muestra solo el encabezado de Actividad.",
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
      actionsEntry: {
        footer:
          "Habilita acciones por superficie y ubicación (UI, voz, MCP) y controla dónde aparecen.",
        openSubtitle: "Abrir ajustes de acciones",
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
        recentMessagesTitle: "Mensajes recientes a incluir",
        recentMessagesPlaceholder: "16",
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
          styleDefaultSubtitle: "Tarjetas: Resumen. Feed de actividad: Compacto.",
          expandedStyleDefaultTitle: "Predeterminado (recomendado)",
          expandedStyleDefaultSubtitle: "Tarjetas: Completo. Feed de actividad: Resumen.",
      },
      terminalConnect: {
        title: "Conexión del terminal",
        legacySecretExportTitle: "Exportación de secreto heredada (compatibilidad)",
        legacySecretExportEnabledSubtitle:
          "Activado: exporta el secreto heredado de tu cuenta al terminal para que terminales antiguos puedan conectarse. No recomendado.",
        legacySecretExportDisabledSubtitle:
          "Desactivado (recomendado): aprovisiona terminales solo con la clave de contenido (Terminal Connect V2).",
      },
    sessionList: {
      title: "Lista de sesiones",
      footer: "Personaliza lo que aparece en cada fila de sesión.",
      tagsTitle: "Etiquetas de sesión",
      tagsEnabledSubtitle: "Controles de etiquetas visibles en la lista de sesiones",
      tagsDisabledSubtitle: "Controles de etiquetas ocultos",
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
          enableTtsTitle: "Activar streaming de TTS",
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
      "Cifrado de extremo a extremo y tu cuenta se guarda solo en tu dispositivo.",
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
    serverUnavailableTitle: "No se puede conectar al servidor",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `No podemos conectarnos a ${serverUrl}. Reintenta o cambia el servidor para continuar.`,
    serverIncompatibleTitle: "Servidor no compatible",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `El servidor en ${serverUrl} devolvió una respuesta inesperada. Actualiza el servidor o cambia de servidor para continuar.`,
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
    defaultPermissions: {
      title: "Permisos predeterminados",
      footer:
        "Sobrescribe los permisos predeterminados a nivel de cuenta para nuevas sesiones cuando se selecciona este perfil.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `Predeterminado de la cuenta: ${label}`,
      useAccountDefault: "Usar predeterminado de la cuenta",
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
