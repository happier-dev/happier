import type { TranslationStructure } from "../_types";

/**
 * Russian plural helper function
 * Russian has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Russian plural rules
 */
function plural({
  count,
  one,
  few,
  many,
}: {
  count: number;
  one: string;
  few: string;
  many: string;
}): string {
  const n = Math.abs(count);
  const n10 = n % 10;
  const n100 = n % 100;

  // Rule: ends in 1 but not 11
  if (n10 === 1 && n100 !== 11) return one;

  // Rule: ends in 2-4 but not 12-14
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;

  // Rule: everything else (0, 5-9, 11-19, etc.)
  return many;
}

/**
 * Russian translations for the Happier app
 * Must match the exact structure of the English translations
 */
export const ru: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "Друзья",
    sessions: "Терминалы",
    settings: "Настройки",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Нет активности друзей",
    emptyDescription:
      "Добавьте друзей, чтобы делиться сессиями и видеть активность здесь.",
    updates: "Активность",
  },

  runs: {
    title: "Runs",
    empty: "No runs yet.",
  },

  common: {
    // Simple string constants
    add: "Добавить",
    actions: "Действия",
    cancel: "Отмена",
    close: "Закрыть",
    authenticate: "Авторизация",
    save: "Сохранить",
    saveAs: "Сохранить как",
    error: "Ошибка",
    success: "Успешно",
    ok: "ОК",
    continue: "Продолжить",
    back: "Назад",
    create: "Создать",
    rename: "Переименовать",
    remove: "Remove",
    signOut: "Sign out",
    keep: "Keep",
    reset: "Сбросить",
    logout: "Выйти",
    yes: "Да",
    no: "Нет",
    discard: "Отменить",
    discardChanges: "Отменить изменения",
    unsavedChangesWarning: "У вас есть несохранённые изменения.",
    keepEditing: "Продолжить редактирование",
    version: "Версия",
    details: "Детали",
    copied: "Скопировано",
    copy: "Копировать",
    scanning: "Сканирование...",
    urlPlaceholder: "https://example.com",
    home: "Главная",
    message: "Сообщение",
    send: "Отправить",
    files: "Файлы",
    fileViewer: "Просмотр файла",
    loading: "Загрузка...",
    retry: "Повторить",
    or: "или",
    delete: "Удалить",
    optional: "необязательно",
    noMatches: "Нет совпадений",
    all: "Все",
    machine: "машина",
    clearSearch: "Очистить поиск",
    refresh: "Обновить",
  },

  dropdown: {
    category: {
      general: "Общее",
      results: "Результаты",
    },
    createItem: {
      prefix: "Добавить",
    },
  },

  connect: {
    restoreAccount: "Восстановить аккаунт",
    enterSecretKey: "Пожалуйста, введите секретный ключ",
    invalidSecretKey: "Неверный секретный ключ. Проверьте и попробуйте снова.",
    enterUrlManually: "Ввести URL вручную",
    openMachine: "Открыть машину",
    terminalUrlPlaceholder: "happier://terminal?...",
    restoreQrInstructions:
      "1. Откройте Happier на мобильном устройстве\n2. Перейдите в Настройки → Аккаунт\n3. Нажмите «Подключить новое устройство»\n4. Отсканируйте этот QR‑код",
    restoreWithSecretKeyInstead: "Восстановить по секретному ключу",
    restoreWithSecretKeyDescription:
      "Введите секретный ключ, чтобы восстановить доступ к аккаунту.",
    lostAccessLink: "Потеряли доступ?",
    lostAccessTitle: "Потеряли доступ к аккаунту?",
    lostAccessBody:
      "Если у вас больше нет устройства, привязанного к этому аккаунту, и вы потеряли секретный ключ, вы можете сбросить аккаунт через провайдера идентификации. Будет создан новый аккаунт Happier. Старую зашифрованную историю восстановить нельзя.",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `Продолжить с ${provider}`,
    lostAccessConfirmTitle: "Сбросить аккаунт?",
    lostAccessConfirmBody:
      "Будет создан новый аккаунт и повторно привязан провайдер. Старую зашифрованную историю восстановить нельзя.",
    lostAccessConfirmButton: "Сбросить и продолжить",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    linkNewDeviceTitle: "Привязать новое устройство",
    linkNewDeviceSubtitle: "Отсканируйте QR-код, отображаемый на новом устройстве, чтобы привязать его к этой учетной записи",
    linkNewDeviceQrInstructions: "Откройте Happier на новом устройстве и отобразите QR-код",
    scanQrCodeOnDevice: "Сканировать QR-код",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Подключить ${name}`,
      runCommandInTerminal: "Выполните следующую команду в терминале:",
    },
  },

  settings: {
    title: "Настройки",
    connectedAccounts: "Подключенные аккаунты",
    connectedAccountsDisabled: "Connected services are disabled.",
    connectAccount: "Подключить аккаунт",
    github: "GitHub",
    machines: "Машины",
    features: "Функции",
    social: "Социальное",
    account: "Аккаунт",
    accountSubtitle: "Управление учетной записью",
    appearance: "Внешний вид",
    appearanceSubtitle: "Настройка внешнего вида приложения",
    voiceAssistant: "Голосовой ассистент",
    voiceAssistantSubtitle: "Настройка предпочтений голосового взаимодействия",
    memorySearch: "Локальный поиск по памяти",
    memorySearchSubtitle: "Поиск по прошлым разговорам (локально на устройстве)",
    featuresTitle: "Возможности",
    featuresSubtitle: "Включить или отключить функции приложения",
    developer: "Разработчик",
    developerTools: "Инструменты разработчика",
    about: "О программе",
    aboutFooter:
      "Happier Coder — мобильное приложение для работы с Codex и Claude Code. Использует сквозное шифрование, все данные аккаунта хранятся только на вашем устройстве. Не связано с Anthropic.",
    whatsNew: "Что нового",
    whatsNewSubtitle: "Посмотреть последние обновления и улучшения",
    reportIssue: "Сообщить о проблеме",
    privacyPolicy: "Политика конфиденциальности",
    termsOfService: "Условия использования",
    eula: "EULA",
    supportUs: "Поддержите нас",
    supportUsSubtitlePro: "Спасибо за вашу поддержку!",
    supportUsSubtitle: "Поддержать разработку проекта",
    scanQrCodeToAuthenticate: "Отсканируйте QR-код для авторизации",
    githubConnected: ({ login }: { login: string }) =>
      `Подключен как @${login}`,
    connectGithubAccount: "Подключить аккаунт GitHub",
    claudeAuthSuccess: "Успешно подключено к Claude",
    exchangingTokens: "Обмен токенов...",
    usage: "Использование",
    usageSubtitle: "Просмотр использования API и затрат",
    profiles: "Профили",
    profilesSubtitle: "Управление профилями переменных окружения для сессий",
    secrets: "Секреты",
    secretsSubtitle:
      "Управление сохранёнными секретами (после ввода больше не показываются)",
    terminal: "Терминал",
    session: "Сессия",
    sessionSubtitleTmuxEnabled: "Tmux включён",
    sessionSubtitleMessageSendingAndTmux: "Отправка сообщений и tmux",
    servers: "Серверы",
    serversSubtitle: "Сохранённые серверы, группы и значения по умолчанию",

    // Dynamic settings messages
    accountConnected: ({ service }: { service: string }) =>
      `Аккаунт ${service} подключен`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} ${status === "online" ? "в сети" : "не в сети"}`,
    featureToggled: ({
      feature,
      enabled,
    }: {
      feature: string;
      enabled: boolean;
    }) => `${feature} ${enabled ? "включена" : "отключена"}`,
  },

  settingsProviders: {
    title: "Настройки провайдера ИИ",
    entrySubtitle: "Настройте параметры для конкретного провайдера",
    footer:
      "Настройте параметры для конкретного провайдера. Эти настройки могут повлиять на поведение сессии.",
    providerSubtitle: "Параметры для конкретного провайдера",
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
    notFoundTitle: "Провайдер не найден",
    notFoundSubtitle: "У этого провайдера нет экрана настроек.",
    noOptionsAvailable: "Нет доступных вариантов",
    invalidNumber: "Некорректное число",
    invalidJson: "Некорректный JSON",
  },

  settingsAppearance: {
    // Appearance settings screen
    theme: "Тема",
    themeDescription: "Выберите предпочтительную цветовую схему",
    themeOptions: {
      adaptive: "Адаптивная",
      light: "Светлая",
      dark: "Тёмная",
    },
    themeDescriptions: {
      adaptive: "Следовать настройкам системы",
      light: "Всегда использовать светлую тему",
      dark: "Всегда использовать тёмную тему",
    },
    display: "Отображение",
    displayDescription: "Управление макетом и интервалами",
    inlineToolCalls: "Встроенные вызовы инструментов",
    inlineToolCallsDescription:
      "Отображать вызовы инструментов прямо в сообщениях чата",
    expandTodoLists: "Развернуть списки задач",
    expandTodoListsDescription: "Показывать все задачи вместо только изменений",
    showLineNumbersInDiffs: "Показывать номера строк в различиях",
    showLineNumbersInDiffsDescription:
      "Отображать номера строк в различиях кода",
    showLineNumbersInToolViews:
      "Показывать номера строк в представлениях инструментов",
    showLineNumbersInToolViewsDescription:
      "Отображать номера строк в различиях представлений инструментов",
    wrapLinesInDiffs: "Перенос строк в различиях",
    wrapLinesInDiffsDescription:
      "Переносить длинные строки вместо горизонтальной прокрутки в представлениях различий",
    alwaysShowContextSize: "Всегда показывать размер контекста",
    alwaysShowContextSizeDescription:
      "Отображать использование контекста даже когда не близко к лимиту",
    agentInputActionBarLayout: "Панель действий ввода",
    agentInputActionBarLayoutDescription:
      "Выберите, как отображаются действия над полем ввода",
    agentInputActionBarLayoutOptions: {
      auto: "Авто",
      wrap: "Перенос",
      scroll: "Прокрутка",
      collapsed: "Свернуто",
    },
    agentInputChipDensity: "Плотность чипов действий",
    agentInputChipDensityDescription:
      "Выберите, показывать ли чипы действий с подписями или только значками",
    agentInputChipDensityOptions: {
      auto: "Авто",
      labels: "Подписи",
      icons: "Только значки",
    },
    avatarStyle: "Стиль аватара",
    avatarStyleDescription: "Выберите внешний вид аватара сессии",
    avatarOptions: {
      pixelated: "Пиксельная",
      gradient: "Градиентная",
      brutalist: "Бруталистская",
    },
    showFlavorIcons: "Показывать иконки провайдеров ИИ",
    showFlavorIconsDescription:
      "Отображать иконки провайдеров ИИ на аватарах сессий",
    compactSessionView: "Компактный вид сессий",
    compactSessionViewDescription:
      "Отображать активные сессии в более компактном виде",
    compactSessionViewMinimal: "Минимальный компактный вид",
    compactSessionViewMinimalDescription:
      "Скрыть аватары и показать очень компактный макет строки сессии",
  },

  settingsFeatures: {
    // Features settings screen
    experiments: "Эксперименты",
    experimentsDescription:
      "Включить экспериментальные функции, которые всё ещё разрабатываются. Эти функции могут быть нестабильными или изменяться без предупреждения.",
    experimentalFeatures: "Экспериментальные функции",
    experimentalFeaturesEnabled: "Экспериментальные функции включены",
    experimentalFeaturesDisabled: "Используются только стабильные функции",
    experimentalOptions: "Экспериментальные опции",
    experimentalOptionsDescription:
      "Выберите, какие экспериментальные функции включены.",
    expAutomations: "Automations",
    expAutomationsSubtitle: "Enable automations UI surfaces and scheduling",
    expExecutionRuns: "Execution runs",
    expExecutionRunsSubtitle:
      "Enable execution runs (sub-agents / reviews) control plane surfaces",
    expAttachmentsUploads: "Attachment uploads",
    expAttachmentsUploadsSubtitle:
      "Enable file/image uploads so the agent can read them from disk",
    expUsageReporting: "Usage reporting",
    expUsageReportingSubtitle: "Enable usage and token reporting screens",
    expScmOperations: "Операции контроля версий",
    expScmOperationsSubtitle:
      "Включить экспериментальные операции записи контроля версий (stage/commit/push/pull)",
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
      "Show assistant thinking/status messages in chat",
    expSessionType: "Session type selector",
    expSessionTypeSubtitle:
      "Show the session type selector (simple vs worktree)",
    expZen: "Zen",
    expZenSubtitle: "Enable the Zen navigation entry",
    expVoiceAuthFlow: "Voice auth flow",
    expVoiceAuthFlowSubtitle:
      "Use authenticated voice token flow (paywall-aware)",
    voice: "Голос",
    voiceSubtitle: "Включить голосовые функции",
    expVoiceAgent: "Voice agent",
    expVoiceAgentSubtitle: "Enable daemon-backed voice agent surfaces (requires execution runs)",
    expConnectedServices: "Connected services",
    expConnectedServicesSubtitle: "Enable connected services settings and session bindings",
    expConnectedServicesQuotas: "Connected services quotas",
    expConnectedServicesQuotasSubtitle: "Show quota badges and usage meters for connected services",
    expMemorySearch: "Memory search",
    expMemorySearchSubtitle: "Enable local memory search screens and settings",
    expFriends: "Друзья",
    expFriendsSubtitle: "Включить функции друзей (вкладка «Входящие» и обмен сессиями)",
    webFeatures: "Веб-функции",
    webFeaturesDescription:
      "Функции, доступные только в веб-версии приложения.",
    enterToSend: "Enter для отправки",
    enterToSendEnabled:
      "Нажмите Enter для отправки (Shift+Enter для новой строки)",
    enterToSendDisabled: "Enter вставляет новую строку",
    historyScope: "Message history",
    historyScopePerSession: "Cycle history per terminal",
    historyScopeGlobal: "Cycle history across all terminals",
    historyScopeModalTitle: "Message history",
    historyScopeModalMessage:
      "Choose whether ArrowUp/ArrowDown cycles through messages sent in this terminal only, or across all terminals.",
    historyScopePerSessionOption: "Per terminal",
    historyScopeGlobalOption: "Global",
    commandPalette: "Палитра команд",
    commandPaletteEnabled: "Нажмите ⌘K для открытия",
    commandPaletteDisabled: "Быстрый доступ к командам отключён",
    markdownCopyV2: "Копирование Markdown v2",
    markdownCopyV2Subtitle:
      "Долгое нажатие открывает модальное окно копирования",
    hideInactiveSessions: "Скрывать неактивные сессии",
    hideInactiveSessionsSubtitle: "Показывать в списке только активные чаты",
    sessionListActiveGrouping: "Группировка активных сессий",
    sessionListActiveGroupingSubtitle:
      "Выберите, как активные сессии группируются в боковой панели",
    sessionListInactiveGrouping: "Группировка неактивных сессий",
    sessionListInactiveGroupingSubtitle:
      "Выберите, как неактивные сессии группируются в боковой панели",
    sessionListGrouping: {
      projectTitle: "Проект",
      projectSubtitle: "Группировать сессии по машине и пути",
      dateTitle: "Дата",
      dateSubtitle: "Группировать сессии по дате последней активности",
    },
    groupInactiveSessionsByProject:
      "Группировать неактивные сессии по проектам",
    groupInactiveSessionsByProjectSubtitle:
      "Организовать неактивные чаты по проектам",
    environmentBadge: "Environment badge",
    environmentBadgeSubtitle:
      "Show a small badge next to the Happier title indicating the current app environment",
    enhancedSessionWizard: "Улучшенный мастер сессий",
    enhancedSessionWizardEnabled: "Лаунчер с профилем активен",
    enhancedSessionWizardDisabled: "Используется стандартный лаунчер",
    profiles: "Профили ИИ",
    profilesEnabled: "Выбор профилей включён",
    profilesDisabled: "Выбор профилей отключён",
    pickerSearch: "Поиск в выборе",
    pickerSearchSubtitle: "Показывать поле поиска в выборе машины и пути",
    machinePickerSearch: "Поиск машин",
    machinePickerSearchSubtitle: "Показывать поле поиска при выборе машины",
    pathPickerSearch: "Поиск путей",
    pathPickerSearchSubtitle: "Показывать поле поиска при выборе пути",
  },

	  errors: {
    networkError: "Произошла ошибка сети",
    serverError: "Произошла ошибка сервера",
    unknownError: "Произошла неизвестная ошибка",
    connectionTimeout: "Время соединения истекло",
    authenticationFailed: "Ошибка авторизации",
    permissionDenied: "Доступ запрещен",
    fileNotFound: "Файл не найден",
    invalidFormat: "Неверный формат",
    operationFailed: "Операция не выполнена",
    tryAgain: "Пожалуйста, попробуйте снова",
    contactSupport: "Если проблема сохранится, обратитесь в поддержку",
    sessionNotFound: "Сессия не найдена",
	    voiceSessionFailed: "Не удалось запустить голосовую сессию",
	    voiceServiceUnavailable: "Голосовой сервис временно недоступен",
	    voiceAlreadyStarting: "Голос уже запускается в другой сессии",
	    oauthInitializationFailed: "Не удалось инициализировать процесс OAuth",
	    tokenStorageFailed: "Не удалось сохранить токены аутентификации",
	    oauthStateMismatch: "Ошибка проверки безопасности. Попробуйте снова",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} уже привязан к существующему аккаунту Happier. Чтобы войти на этом устройстве, привяжите его с устройства, на котором вы уже вошли.`,
    tokenExchangeFailed: "Не удалось обменять код авторизации",
    oauthAuthorizationDenied: "В авторизации отказано",
    webViewLoadFailed: "Не удалось загрузить страницу аутентификации",
    failedToLoadProfile: "Не удалось загрузить профиль пользователя",
    userNotFound: "Пользователь не найден",
    sessionDeleted: "Сессия недоступна",
    sessionDeletedDescription:
      "Возможно, она была удалена или у вас больше нет доступа.",

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
    }) => `${field} должно быть от ${min} до ${max}`,
    retryIn: ({ seconds }: { seconds: number }) =>
      `Повторить через ${seconds} ${plural({ count: seconds, one: "секунду", few: "секунды", many: "секунд" })}`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (Ошибка ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `Не удалось отключить ${service}`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `Не удалось подключить ${service}. Пожалуйста, попробуйте снова.`,
    failedToLoadFriends: "Не удалось загрузить список друзей",
    failedToAcceptRequest: "Не удалось принять запрос в друзья",
    failedToRejectRequest: "Не удалось отклонить запрос в друзья",
    failedToRemoveFriend: "Не удалось удалить друга",
    searchFailed: "Поиск не удался. Пожалуйста, попробуйте снова.",
    failedToSendRequest: "Не удалось отправить запрос в друзья",
    failedToResumeSession: "Не удалось возобновить сессию",
    failedToSendMessage: "Не удалось отправить сообщение",
    failedToSwitchControl: "Не удалось переключить режим управления",
    cannotShareWithSelf: "Нельзя поделиться с самим собой",
    canOnlyShareWithFriends: "Можно делиться только с друзьями",
    shareNotFound: "Общий доступ не найден",
    publicShareNotFound: "Публичная ссылка не найдена или истекла",
    consentRequired: "Требуется согласие для доступа",
    maxUsesReached: "Достигнут лимит использований",
    invalidShareLink: "Недействительная или просроченная ссылка для обмена",
    missingPermissionId: "Отсутствует идентификатор запроса разрешения",
    codexResumeNotInstalledTitle: "Codex resume не установлен на этой машине",
    codexResumeNotInstalledMessage:
      "Чтобы возобновить разговор Codex, установите сервер возобновления Codex на целевой машине (Детали машины → Возобновление Codex).",
    codexAcpNotInstalledTitle: "Codex ACP не установлен на этой машине",
    codexAcpNotInstalledMessage:
      "Чтобы использовать эксперимент Codex ACP, установите codex-acp на целевой машине (Детали машины → Codex ACP) или отключите эксперимент.",
  },

  deps: {
    installNotSupported:
      "Обновите Happier CLI, чтобы установить эту зависимость.",
    installFailed: "Не удалось установить",
    installed: "Установлено",
    installLog: ({ path }: { path: string }) => `Лог установки: ${path}`,
    installable: {
      codexResume: {
        title: "Сервер возобновления Codex",
        installSpecTitle: "Источник установки Codex resume",
      },
      codexAcp: {
        title: "Адаптер Codex ACP",
        installSpecTitle: "Источник установки Codex ACP",
      },
      installSpecDescription:
        "Спецификация NPM/Git/file для `npm install` (экспериментально). Оставьте пустым, чтобы использовать значение демона по умолчанию.",
    },
    ui: {
      notAvailable: "Недоступно",
      notAvailableUpdateCli: "Недоступно (обновите CLI)",
      errorRefresh: "Ошибка (обновить)",
      installed: "Установлено",
      installedWithVersion: ({ version }: { version: string }) =>
        `Установлено (v${version})`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) =>
        `Установлено (v${installedVersion}) — доступно обновление (v${latestVersion})`,
      notInstalled: "Не установлено",
      latest: "Последняя",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version} (tag: ${tag})`,
      registryCheck: "Проверка реестра",
      registryCheckFailed: ({ error }: { error: string }) => `Ошибка: ${error}`,
      installSource: "Источник установки",
      installSourceDefault: "(по умолчанию)",
      installSpecPlaceholder:
        "например, file:/path/to/pkg или github:owner/repo#branch",
      lastInstallLog: "Последний лог установки",
      installLogTitle: "Лог установки",
    },
  },

  newSession: {
    // Used by new-session screen and launch flows
    title: "Начать новую сессию",
    selectAiProfileTitle: "Выбрать профиль ИИ",
    selectAiProfileDescription:
      "Выберите профиль ИИ, чтобы применить переменные окружения и настройки по умолчанию к вашей сессии.",
    changeProfile: "Сменить профиль",
    aiBackendSelectedByProfile:
      "Бэкенд ИИ выбирается вашим профилем. Чтобы изменить его, выберите другой профиль.",
    selectAiBackendTitle: "Выбрать бэкенд ИИ",
    aiBackendLimitedByProfileAndMachineClis:
      "Ограничено выбранным профилем и доступными CLI на этой машине.",
    aiBackendSelectWhichAiRuns:
      "Выберите, какой ИИ будет работать в вашей сессии.",
    aiBackendNotCompatibleWithSelectedProfile:
      "Несовместимо с выбранным профилем.",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `${cli} CLI не обнаружен на этой машине.`,
    selectMachineTitle: "Выбрать машину",
    selectMachineDescription: "Выберите, где будет выполняться эта сессия.",
    selectPathTitle: "Выбрать путь",
    selectWorkingDirectoryTitle: "Выбрать рабочую директорию",
    selectWorkingDirectoryDescription:
      "Выберите папку, используемую для команд и контекста.",
    selectPermissionModeTitle: "Выбрать режим разрешений",
    selectPermissionModeDescription:
      "Настройте, насколько строго действия требуют подтверждения.",
    selectModelTitle: "Выбрать модель ИИ",
    selectModelDescription: "Выберите модель, используемую этой сессией.",
    selectSessionTypeTitle: "Выбрать тип сессии",
    selectSessionTypeDescription:
      "Выберите простую сессию или сессию, привязанную к Git worktree.",
    searchPathsPlaceholder: "Поиск путей...",
    noMachinesFound:
      "Машины не найдены. Сначала запустите сессию Happier на вашем компьютере.",
    allMachinesOffline: "Все машины не в сети",
    machineDetails: "Посмотреть детали машины →",
    directoryDoesNotExist: "Директория не найдена",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `Директория ${directory} не существует. Хотите создать её?`,
    sessionStarted: "Сессия запущена",
    sessionStartedMessage: "Сессия успешно запущена.",
    sessionSpawningFailed: "Ошибка создания сессии - ID сессии не получен.",
    failedToStart:
      "Не удалось запустить сессию. Убедитесь, что daemon запущен на целевой машине.",
    sessionTimeout:
      "Время запуска сессии истекло. Машина может работать медленно или daemon не отвечает.",
    notConnectedToServer:
      "Нет подключения к серверу. Проверьте интернет-соединение.",
    startingSession: "Запуск сессии...",
    startNewSessionInFolder: "Новая сессия здесь",
    noMachineSelected: "Пожалуйста, выберите машину для запуска сессии",
    noPathSelected: "Пожалуйста, выберите директорию для запуска сессии",
    machinePicker: {
      searchPlaceholder: "Поиск машин...",
      recentTitle: "Недавние",
      favoritesTitle: "Избранное",
      allTitle: "Все",
      emptyMessage: "Нет доступных машин",
    },
    pathPicker: {
      enterPathTitle: "Введите путь",
      enterPathPlaceholder: "Введите путь...",
      customPathTitle: "Пользовательский путь",
      recentTitle: "Недавние",
      favoritesTitle: "Избранное",
      suggestedTitle: "Рекомендуемые",
      allTitle: "Все",
      emptyRecent: "Нет недавних путей",
      emptyFavorites: "Нет избранных путей",
      emptySuggested: "Нет рекомендуемых путей",
      emptyAll: "Нет путей",
    },
    sessionType: {
      title: "Тип сессии",
      simple: "Простая",
      worktree: "Рабочее дерево",
      comingSoon: "Скоро будет доступно",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Требуется ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) => `${cli} CLI не обнаружен`,
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `${cli} CLI не обнаружен`,
      dontShowFor: "Не показывать это предупреждение для",
      thisMachine: "этой машины",
      anyMachine: "любой машины",
      installCommand: ({ command }: { command: string }) =>
        `Установить: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `Установите ${cli} CLI, если доступно •`,
      viewInstallationGuide: "Открыть руководство по установке →",
      viewGeminiDocs: "Открыть документацию Gemini →",
    },
    worktree: {
      creating: ({ name }: { name: string }) =>
        `Создание worktree '${name}'...`,
      notGitRepo: "Worktree требует наличия git репозитория",
      failed: ({ error }: { error: string }) =>
        `Не удалось создать worktree: ${error}`,
      success: "Worktree успешно создан",
    },
    resume: {
      title: "Продолжить сессию",
      optional: "Продолжить: необязательно",
      pickerTitle: "Продолжить сессию",
      subtitle: ({ agent }: { agent: string }) =>
        `Вставьте ID сессии ${agent} для продолжения`,
      placeholder: ({ agent }: { agent: string }) =>
        `Вставьте ID сессии ${agent}…`,
      paste: "Вставить",
      save: "Сохранить",
      clearAndRemove: "Очистить",
      helpText: "ID сессии можно найти на экране информации о сессии.",
      cannotApplyBody:
        "Этот ID возобновления сейчас нельзя применить. Happier вместо этого начнёт новую сессию.",
    },
    codexResumeBanner: {
      title: "Codex resume",
      updateAvailable: "Доступно обновление",
      systemCodexVersion: ({ version }: { version: string }) =>
        `Системный Codex: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Сервер Codex resume: ${version}`,
      notInstalled: "не установлен",
      latestVersion: ({ version }: { version: string }) =>
        `(последняя ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `Проверка реестра не удалась: ${error}`,
      install: "Установить",
      update: "Обновить",
      reinstall: "Переустановить",
    },
    codexResumeInstallModal: {
      installTitle: "Установить Codex resume?",
      updateTitle: "Обновить Codex resume?",
      reinstallTitle: "Переустановить Codex resume?",
      description:
        "Это установит экспериментальный wrapper MCP-сервера Codex, используемый только для операций возобновления.",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "Установить",
      update: "Обновить",
      reinstall: "Переустановить",
    },
    codexAcpInstallModal: {
      installTitle: "Установить Codex ACP?",
      updateTitle: "Обновить Codex ACP?",
      reinstallTitle: "Переустановить Codex ACP?",
      description:
        "Это установит экспериментальный ACP-адаптер для Codex, который поддерживает загрузку/возобновление тредов.",
    },
  },

  sessionHistory: {
    // Used by session history screen
    title: "История сессий",
    empty: "Сессии не найдены",
    today: "Сегодня",
    yesterday: "Вчера",
    daysAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "день", few: "дня", many: "дней" })} назад`,
    viewAll: "Посмотреть все сессии",
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Настройка сервера",
    enterServerUrl: "Пожалуйста, введите URL сервера",
    notValidHappyServer: "Это не валидный сервер Happier",
    changeServer: "Изменить сервер",
    continueWithServer: "Продолжить с этим сервером?",
    resetToDefault: "Сбросить по умолчанию",
    resetServerDefault: "Сбросить сервер по умолчанию?",
    validating: "Проверка...",
    validatingServer: "Проверка сервера...",
    serverReturnedError: "Сервер вернул ошибку",
    failedToConnectToServer: "Не удалось подключиться к серверу",
    currentlyUsingCustomServer: "Сейчас используется пользовательский сервер",
    customServerUrlLabel: "URL пользовательского сервера",
    advancedFeatureFooter:
      "Это расширенная функция. Изменяйте сервер только если знаете, что делаете. Вам нужно будет выйти и войти снова после изменения серверов.",
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

  sessionTags: {
    searchOrAddPlaceholder: "Найти или добавить теги",
    editTagsLabel: "Редактировать теги",
    noTagsFound: "Теги не найдены",
    newTagItem: "Новый тег…",
    newTagTitle: "Новый тег",
    newTagMessage: "Введите название нового тега.",
    newTagConfirm: "Добавить",
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "Завершить сессию",
    killSessionConfirm: "Вы уверены, что хотите завершить эту сессию?",
    stopSession: "Остановить сессию",
    stopSessionConfirm: "Вы уверены, что хотите остановить эту сессию?",
    archiveSession: "Архивировать сессию",
    archiveSessionConfirm: "Вы уверены, что хотите архивировать эту сессию?",
    happySessionIdCopied: "ID сессии Happier скопирован в буфер обмена",
    failedToCopySessionId: "Не удалось скопировать ID сессии Happier",
    happySessionId: "ID сессии Happier",
    claudeCodeSessionId: "ID сессии Claude Code",
    claudeCodeSessionIdCopied:
      "ID сессии Claude Code скопирован в буфер обмена",
    aiProfile: "Профиль ИИ",
    aiProvider: "Поставщик ИИ",
    failedToCopyClaudeCodeSessionId:
      "Не удалось скопировать ID сессии Claude Code",
    codexSessionId: "ID сессии Codex",
    codexSessionIdCopied: "ID сессии Codex скопирован в буфер обмена",
    failedToCopyCodexSessionId: "Не удалось скопировать ID сессии Codex",
    opencodeSessionId: "ID сессии OpenCode",
    opencodeSessionIdCopied: "ID сессии OpenCode скопирован в буфер обмена",
    geminiSessionId: "ID сессии Gemini",
    geminiSessionIdCopied: "ID сессии Gemini скопирован в буфер обмена",
    auggieSessionId: "ID сессии Auggie",
    auggieSessionIdCopied: "ID сессии Auggie скопирован в буфер обмена",
    qwenSessionId: "ID сессии Qwen Code",
    qwenSessionIdCopied: "ID сессии Qwen Code скопирован в буфер обмена",
    kimiSessionId: "ID сессии Kimi",
    kimiSessionIdCopied: "ID сессии Kimi скопирован в буфер обмена",
    kiloSessionId: "ID сессии Kilo",
    kiloSessionIdCopied: "ID сессии Kilo скопирован в буфер обмена",
    piSessionId: "ID сессии Pi",
    piSessionIdCopied: "ID сессии Pi скопирован в буфер обмена",
    metadataCopied: "Метаданные скопированы в буфер обмена",
    failedToCopyMetadata: "Не удалось скопировать метаданные",
    failedToKillSession: "Не удалось завершить сессию",
    failedToStopSession: "Не удалось остановить сессию",
    failedToArchiveSession: "Не удалось архивировать сессию",
    connectionStatus: "Статус подключения",
    created: "Создано",
    lastUpdated: "Последнее обновление",
    sequence: "Последовательность",
    quickActions: "Быстрые действия",
    pinSession: "Закрепить сессию",
    unpinSession: "Открепить сессию",
    copyResumeCommand: "Скопировать команду возобновления",
    viewMachine: "Посмотреть машину",
    viewMachineSubtitle: "Посмотреть детали машины и сессии",
    killSessionSubtitle: "Немедленно завершить сессию",
    stopSessionSubtitle: "Остановить процесс сессии",
    archiveSessionSubtitle: "Переместить эту сессию в Архив",
    archivedSessions: "Архивированные сессии",
    unarchiveSession: "Разархивировать сессию",
    unarchiveSessionConfirm: "Вы уверены, что хотите разархивировать эту сессию?",
    unarchiveSessionSubtitle: "Переместить эту сессию обратно в Неактивные",
    failedToUnarchiveSession: "Не удалось разархивировать сессию",
    metadata: "Метаданные",
    host: "Хост",
    path: "Путь",
    operatingSystem: "Операционная система",
    processId: "ID процесса",
    happyHome: "Домашний каталог Happier",
    attachFromTerminal: "Подключиться из терминала",
    tmuxTarget: "Цель tmux",
    tmuxFallback: "Fallback tmux",
    copyMetadata: "Копировать метаданные",
    agentState: "Состояние агента",
    rawJsonDevMode: "Сырой JSON (режим разработчика)",
    sessionStatus: "Статус сессии",
    fullSessionObject: "Полный объект сессии",
    controlledByUser: "Управляется пользователем",
    pendingRequests: "Ожидающие запросы",
    activity: "Активность",
    thinking: "Думает",
    thinkingSince: "Думает с",
    thinkingLevel: "Уровень размышлений",
    cliVersion: "Версия CLI",
    cliVersionOutdated: "Требуется обновление CLI",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `Установлена версия ${currentVersion}. Обновите до ${requiredVersion} или новее`,
    updateCliInstructions:
      "Пожалуйста, выполните npm install -g @happier-dev/cli@latest",
    deleteSession: "Удалить сессию",
    deleteSessionSubtitle: "Удалить эту сессию навсегда",
    deleteSessionConfirm: "Удалить сессию навсегда?",
    deleteSessionWarning:
      "Это действие нельзя отменить. Все сообщения и данные, связанные с этой сессией, будут удалены навсегда.",
    failedToDeleteSession: "Не удалось удалить сессию",
    sessionDeleted: "Сессия успешно удалена",
    manageSharing: "Управление доступом",
    manageSharingSubtitle:
      "Поделиться сессией с друзьями или создать публичную ссылку",
    renameSession: "Переименовать сессию",
    renameSessionSubtitle: "Изменить отображаемое имя сессии",
    renameSessionPlaceholder: "Введите название сессии...",
    failedToRenameSession: "Не удалось переименовать сессию",
    sessionRenamed: "Сессия успешно переименована",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "Готовы к программированию?",
      installCli: "Установите Happier CLI",
      runIt: "Запустите его",
      scanQrCode: "Отсканируйте QR-код",
      openCamera: "Открыть камеру",
      installCommand: "$ npm i -g @happier-dev/cli",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "Сообщений пока нет",
      created: ({ time }: { time: string }) => `Создано ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "Нет активных сессий",
      startNewSessionDescription:
        "Запустите новую сессию на любой из подключённых машин.",
      startNewSessionButton: "Новая сессия",
      openTerminalToStart:
        "Откройте новый терминал на компьютере, чтобы начать сессию.",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "Что нужно сделать?",
    },
    home: {
      noTasksYet: "Пока нет задач. Нажмите +, чтобы добавить.",
    },
    view: {
      workOnTask: "Работать над задачей",
      clarify: "Уточнить",
      delete: "Удалить",
      linkedSessions: "Связанные сессии",
      tapTaskTextToEdit: "Нажмите на текст задачи, чтобы отредактировать",
    },
  },

  profile: {
    userProfile: "Профиль пользователя",
    details: "Детали",
    firstName: "Имя",
    lastName: "Фамилия",
    username: "Имя пользователя",
    status: "Статус",
  },

  status: {
    connected: "подключено",
    connecting: "подключение",
    disconnected: "отключено",
    error: "ошибка",
    online: "в сети",
    offline: "не в сети",
    lastSeen: ({ time }: { time: string }) => `в сети ${time}`,
    permissionRequired: "требуется разрешение",
    activeNow: "Активен сейчас",
    unknown: "неизвестно",
  },

  time: {
    justNow: "только что",
    minutesAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "минуту", few: "минуты", many: "минут" })} назад`,
    hoursAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "час", few: "часа", many: "часов" })} назад`,
  },

  session: {
    inputPlaceholder: "Введите сообщение...",
    resuming: "Возобновление...",
    resumeFailed: "Не удалось возобновить сессию",
    resumeSupportNoteChecking:
      "Примечание: Happier всё ещё проверяет, может ли эта машина возобновить сессию провайдера.",
    resumeSupportNoteUnverified:
      "Примечание: Happier не смог проверить поддержку возобновления на этой машине.",
    resumeSupportDetails: {
      cliNotDetected: "CLI не обнаружен на машине.",
      capabilityProbeFailed: "Не удалось проверить возможности.",
      acpProbeFailed: "Не удалось выполнить ACP-проверку.",
      loadSessionFalse: "Агент не поддерживает загрузку сессий.",
    },
    inactiveResumable: "Неактивна (можно возобновить)",
    inactiveMachineOffline: "Неактивна (машина не в сети)",
    inactiveNotResumable: "Неактивна",
    inactiveNotResumableNoticeTitle: "Эту сессию нельзя возобновить",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `Эта сессия завершена и не может быть возобновлена, потому что ${provider} не поддерживает восстановление контекста здесь. Начните новую сессию, чтобы продолжить.`,
    machineOfflineNoticeTitle: "Машина не в сети",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” не в сети, поэтому Happier пока не может возобновить эту сессию. Подключите машину, чтобы продолжить.`,
    machineOfflineCannotResume:
      "Машина не в сети. Подключите её, чтобы возобновить эту сессию.",
    sharing: {
      title: "Общий доступ",
      directSharing: "Прямой доступ",
      addShare: "Поделиться с другом",
      accessLevel: "Уровень доступа",
      shareWith: "Поделиться с",
      sharedWith: "Доступ предоставлен",
      noShares: "Не поделено",
      viewOnly: "Только просмотр",
      viewOnlyDescription:
        "Можно просматривать, но нельзя отправлять сообщения.",
      viewOnlyMode: "Только просмотр (общая сессия)",
      noEditPermission: "У вас доступ только для чтения к этой сессии.",
      canEdit: "Можно редактировать",
      canEditDescription: "Можно отправлять сообщения.",
      canManage: "Можно управлять",
      canManageDescription: "Можно управлять настройками общего доступа.",
      manageSharingDenied:
        "У вас нет прав на управление настройками общего доступа для этой сессии.",
      stopSharing: "Прекратить доступ",
      recipientMissingKeys:
        "Этот пользователь ещё не зарегистрировал ключи шифрования.",
      permissionApprovals: "Может подтверждать разрешения",
      allowPermissionApprovals: "Разрешить подтверждение разрешений",
      allowPermissionApprovalsDescription:
        "Позволяет этому пользователю подтверждать запросы разрешений и запускать инструменты на вашем компьютере.",
      permissionApprovalsDisabledTitle: "Подтверждение разрешений отключено",
      permissionApprovalsDisabledPublic:
        "Публичные ссылки доступны только для просмотра. Подтверждение разрешений недоступно.",
      permissionApprovalsDisabledReadOnly:
        "У вас доступ только для чтения к этой сессии.",
      permissionApprovalsDisabledNotGranted:
        "Владелец не разрешил вам подтверждать разрешения для этой сессии.",
      publicReadOnlyTitle: "Публичная ссылка (только просмотр)",
      publicReadOnlyBody:
        "Эта сессия опубликована по публичной ссылке. Вы можете просматривать сообщения и вывод инструментов, но не можете взаимодействовать или подтверждать разрешения.",

      publicLink: "Публичная ссылка",
      publicLinkActive: "Публичная ссылка активна",
      publicLinkDescription:
        "Создайте ссылку, по которой любой сможет просмотреть эту сессию.",
      createPublicLink: "Создать публичную ссылку",
      regeneratePublicLink: "Пересоздать публичную ссылку",
      deletePublicLink: "Удалить публичную ссылку",
      linkToken: "Токен ссылки",
      tokenNotRecoverable: "Токен недоступен",
      tokenNotRecoverableDescription:
        "По соображениям безопасности токены публичных ссылок хранятся в виде хеша и не могут быть восстановлены. Пересоздайте ссылку, чтобы создать новый токен.",

      expiresIn: "Истекает через",
      expiresOn: "Истекает",
      days7: "7 дней",
      days30: "30 дней",
      never: "Никогда",

      maxUsesLabel: "Максимум использований",
      unlimited: "Без ограничений",
      uses10: "10 использований",
      uses50: "50 использований",
      usageCount: "Количество использований",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} использований`,
      usageCountUnlimited: ({ used }: { used: number }) =>
        `${used} использований`,

      requireConsent: "Требовать согласие",
      requireConsentDescription:
        "Запрашивать согласие перед тем, как логировать доступ.",
      consentRequired: "Требуется согласие",
      consentDescription:
        "Эта ссылка требует вашего согласия на запись IP-адреса и user agent.",
      acceptAndView: "Принять и просмотреть",
      sharedBy: ({ name }: { name: string }) => `Поделился ${name}`,

      shareNotFound: "Ссылка не найдена или истекла",
      failedToDecrypt: "Не удалось расшифровать сессию",
      noMessages: "Сообщений пока нет",
      session: "Сессия",
    },
  },

  commandPalette: {
    placeholder: "Введите команду или поиск...",
    noCommandsFound: "Команды не найдены",
  },

  commandView: {
    completedWithNoOutput: "[Команда завершена без вывода]",
  },

	  voiceAssistant: {
	    connecting: "Подключение...",
	    active: "Голосовой ассистент активен",
	    connectionError: "Ошибка соединения",
	    label: "Голосовой ассистент",
	    tapToEnd: "Нажмите, чтобы завершить",
	  },

		  voiceSurface: {
		    start: "Старт",
		    stop: "Стоп",
		    selectSessionToStart: "Выберите сессию, чтобы запустить голос",
		    targetSession: "Целевая сессия",
		    noTarget: "Сессия не выбрана",
		    clearTarget: "Очистить цель",
		  },

	  voiceActivity: {
	    title: "Голосовая активность",
	    empty: "Пока нет голосовой активности.",
	    clear: "Очистить",
	  },

	  agentInput: {
	    dropToAttach: "Перетащите, чтобы прикрепить файлы",
	    envVars: {
	      title: "Переменные окружения",
	      titleWithCount: ({ count }: { count: number }) =>
	        `Переменные окружения (${count})`,
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
      title: "РЕЖИМ РАЗРЕШЕНИЙ",
      default: "По умолчанию",
      readOnly: "Только чтение",
      acceptEdits: "Принимать правки",
      safeYolo: "Безопасный YOLO",
      yolo: "YOLO",
      plan: "Режим планирования",
      bypassPermissions: "YOLO режим",
      badgeAccept: "Принять",
      badgePlan: "План",
      badgeReadOnly: "Только чтение",
      badgeSafeYolo: "Безопасный YOLO",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Принимать все правки",
      badgeBypassAllPermissions: "Обход всех разрешений",
      badgePlanMode: "Режим планирования",
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
      on: "Индексация включена",
      off: "Индексация выключена",
    },
    model: {
      title: "МОДЕЛЬ",
      configureInCli: "Настройте модели в настройках CLI",
    },
    codexPermissionMode: {
      title: "РЕЖИМ РАЗРЕШЕНИЙ CODEX",
      default: "Настройки CLI",
      plan: "Режим планирования",
      readOnly: "Только чтение",
      safeYolo: "Безопасный YOLO",
      yolo: "YOLO",
      badgePlan: "План",
      badgeReadOnly: "Только чтение",
      badgeSafeYolo: "Безопасный YOLO",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "МОДЕЛЬ CODEX",
      gpt5CodexLow: "gpt-5-codex низкий",
      gpt5CodexMedium: "gpt-5-codex средний",
      gpt5CodexHigh: "gpt-5-codex высокий",
      gpt5Minimal: "GPT-5 Минимальный",
      gpt5Low: "GPT-5 Низкий",
      gpt5Medium: "GPT-5 Средний",
      gpt5High: "GPT-5 Высокий",
    },
    geminiPermissionMode: {
      title: "РЕЖИМ РАЗРЕШЕНИЙ",
      default: "По умолчанию",
      readOnly: "Только чтение",
      safeYolo: "Безопасный YOLO",
      yolo: "YOLO",
      badgeReadOnly: "Только чтение",
      badgeSafeYolo: "Безопасный YOLO",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "МОДЕЛЬ GEMINI",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "Самая мощная",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "Быстро и эффективно",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "Самая быстрая",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `Осталось ${percent}%`,
    },
    suggestion: {
      fileLabel: "ФАЙЛ",
      folderLabel: "ПАПКА",
    },
    actionMenu: {
      title: "ДЕЙСТВИЯ",
      files: "Файлы",
      stop: "Остановить",
    },
    noMachinesAvailable: "Нет машин",
  },

  machineLauncher: {
    showLess: "Показать меньше",
    showAll: ({ count }: { count: number }) =>
      `Показать все (${count} ${plural({ count, one: "путь", few: "пути", many: "путей" })})`,
    enterCustomPath: "Ввести свой путь",
    offlineUnableToSpawn: "Невозможно создать сессию, машина offline",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "Открыть детали",
    expand: "Развернуть/свернуть",
    input: "Входные данные",
    output: "Результат",
  },

  tools: {
    fullView: {
      description: "Описание",
      inputParams: "Входные параметры",
      output: "Результат",
      error: "Ошибка",
      completed: "Инструмент выполнен успешно",
      noOutput: "Результат не получен",
      running: "Выполняется...",
      debug: "Отладка",
      show: "Показать",
      hide: "Скрыть",
      rawJsonDevMode: "Исходный JSON (режим разработчика)",
    },
    taskView: {
      initializing: "Инициализация агента...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} ещё ${plural({ count, one: "инструмент", few: "инструмента", many: "инструментов" })}`,
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Правка ${index} из ${total}`,
      replaceAll: "Заменить все",
    },
    names: {
      task: "Задача",
      terminal: "Терминал",
      searchFiles: "Поиск файлов",
      search: "Поиск",
      searchContent: "Поиск содержимого",
      listFiles: "Список файлов",
      planProposal: "Предложение плана",
      readFile: "Чтение файла",
      editFile: "Редактирование файла",
      writeFile: "Запись файла",
      fetchUrl: "Получение URL",
      readNotebook: "Чтение блокнота",
      editNotebook: "Редактирование блокнота",
      todoList: "Список задач",
      webSearch: "Веб-поиск",
      reasoning: "Рассуждение",
      applyChanges: "Обновить файл",
      viewDiff: "Diff",
      turnDiff: "Turn diff",
      question: "Вопрос",
      changeTitle: "Изменить заголовок",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `Терминал(команда: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `Поиск(шаблон: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `Поиск(путь: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) =>
        `Получение URL(адрес: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `Редактирование блокнота(файл: ${path}, режим: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Список задач(количество: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Веб-поиск(запрос: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(шаблон: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} ${plural({ count, one: "правка", few: "правки", many: "правок" })})`,
      readingFile: ({ file }: { file: string }) => `Чтение ${file}`,
      writingFile: ({ file }: { file: string }) => `Запись ${file}`,
      modifyingFile: ({ file }: { file: string }) => `Изменение ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `Изменение ${count} ${plural({ count, one: "файла", few: "файлов", many: "файлов" })}`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} и ещё ${count}`,
      showingDiff: "Показ изменений",
    },
    askUserQuestion: {
      submit: "Отправить ответ",
      multipleQuestions: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "вопрос", few: "вопроса", many: "вопросов" })}`,
      other: "Другое",
      otherDescription: "Введите свой ответ",
      otherPlaceholder: "Введите ваш ответ...",
    },
    exitPlanMode: {
      approve: "Одобрить план",
      reject: "Отклонить",
      requestChanges: "Попросить изменения",
      requestChangesPlaceholder:
        "Напишите Claude, что вы хотите изменить в этом плане…",
      requestChangesSend: "Отправить комментарий",
      requestChangesEmpty: "Пожалуйста, напишите, что вы хотите изменить.",
      requestChangesFailed:
        "Не удалось отправить запрос на изменения. Попробуйте снова.",
      responded: "Ответ отправлен",
      approvalMessage:
        "Я одобряю этот план. Пожалуйста, продолжайте реализацию.",
      rejectionMessage:
        "Я не одобряю этот план. Пожалуйста, переработайте его или спросите, какие изменения я хочу.",
    },
  },

  files: {
    searchPlaceholder: "Поиск файлов...",
    detachedHead: "отделённый HEAD",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} подготовлено • ${unstaged} не подготовлено`,
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
    notRepo: "Не является репозиторием системы контроля версий",
    notUnderSourceControl: "Эта папка не находится под управлением системы контроля версий",
    searching: "Поиск файлов...",
	    noFilesFound: "Файлы не найдены",
	    noFilesInProject: "Файлов в проекте нет",
	    repositoryFolderLoadFailed: "Не удалось загрузить папку",
	    repositoryCollapseAll: "Свернуть все",
	    reviewFilterPlaceholder: "Фильтр файлов...",
	    reviewNoMatches: "Нет совпадений",
	    reviewLargeDiffOneAtATime: "Обнаружен большой diff; показываю по одному файлу.",
	    reviewDiffRequestFailed: "Не удалось загрузить diff",
	    reviewUnableToLoadDiff: "Не удалось загрузить diff",
	    tryDifferentTerm: "Попробуйте другой поисковый запрос",
	    searchResults: ({ count }: { count: number }) =>
	      `Результаты поиска (${count})`,
    projectRoot: "Корень проекта",
    stagedChanges: ({ count }: { count: number }) =>
      `Подготовленные изменения (${count})`,
    unstagedChanges: ({ count }: { count: number }) =>
      `Неподготовленные изменения (${count})`,
    // File viewer strings
    loadingFile: ({ fileName }: { fileName: string }) =>
      `Загрузка ${fileName}...`,
    binaryFile: "Бинарный файл",
    cannotDisplayBinary: "Невозможно отобразить содержимое бинарного файла",
    diff: "Различия",
    file: "Файл",
    fileEmpty: "Файл пустой",
    noChanges: "Нет изменений для отображения",
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
    thinking: {
      title: "Thinking",
      footer:
        "Controls how agent thinking messages appear in the session transcript.",
      displayModeTitle: "Thinking display",
      displayMode: {
        inlineTitle: "Inline (default)",
        inlineSubtitle: "Show thinking messages directly in the transcript.",
        toolTitle: "Tool card",
        toolSubtitle: "Show thinking messages as a Reasoning tool card.",
        hiddenTitle: "Hidden",
        hiddenSubtitle: "Hide thinking messages from the transcript.",
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
    permissions: {
      title: "Permissions",
      entrySubtitle: "Open permissions settings",
      footer:
        "Configure default permissions and how changes apply to running sessions.",
      applyChangesFooter:
        "Choose when permission changes take effect for running sessions.",
      backendFooter:
        "Set the default permission mode used when starting sessions with this backend.",
      defaultPermissionModeTitle: "Default permission mode",
      applyTiming: {
        immediateTitle: "Apply immediately",
        nextPromptTitle: "Apply on next message",
      },
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
    sessionList: {
      title: "Список сессий",
      footer: "Настройте, что показывается в каждой строке сессии.",
      tagsTitle: "Теги сессии",
      tagsEnabledSubtitle: "Управление тегами отображается в списке",
      tagsDisabledSubtitle: "Управление тегами скрыто",
    },
  },
  settingsVoice: {
    // Voice settings screen
    modeTitle: "Голос",
    modeDescription:
      "Настройте голосовые функции. Вы можете полностью отключить голос, использовать Happier Voice (требуется подписка) или использовать свой аккаунт ElevenLabs.",
    mode: {
      off: "Выключено",
      offSubtitle: "Отключить все голосовые функции",
      happier: "Happier Voice",
      happierSubtitle: "Использовать Happier Voice (требуется подписка)",
      local: "Локальный OSS голос",
      localSubtitle:
        "Использовать локальные OpenAI-совместимые STT/TTS эндпоинты",
      byo: "Свой ElevenLabs",
      byoSubtitle: "Использовать свой API-ключ и агента ElevenLabs",
    },
    ui: {
      title: "Голосовая поверхность",
      footer: "Необязательный экранный фид голосовых событий (не записывается в сессию).",
      activityFeedEnabled: "Включить фид голосовой активности",
      activityFeedEnabledSubtitle: "Показывать недавние голосовые события на экране",
      activityFeedAutoExpandOnStart: "Авто-раскрытие при старте",
      activityFeedAutoExpandOnStartSubtitle: "Автоматически раскрывать фид при запуске голоса",
      scopeTitle: "Скоуп голоса по умолчанию",
      scopeSubtitle: "Выберите: глобально (аккаунт) или в рамках сессии по умолчанию.",
      scopeGlobal: "Глобально (аккаунт)",
      scopeGlobalSubtitle: "Голос остается видимым при навигации",
      scopeSession: "Сессия",
      scopeSessionSubtitle: "Голос управляется в сессии, где он был запущен",
      surfaceLocationTitle: "Размещение",
      surfaceLocationSubtitle: "Выберите где отображается голосовая поверхность.",
      surfaceLocation: {
        autoTitle: "Авто",
        autoSubtitle: "Глобально в сайдбаре; сессия в сессии.",
        sidebarTitle: "Сайдбар",
        sidebarSubtitle: "Показывать в сайдбаре.",
        sessionTitle: "Сессия",
        sessionSubtitle: "Показывать над полем ввода в сессии.",
      },
      updates: {
        title: "Обновления сессий",
        footer: "Настройте какой контекст получает голосовой ассистент.",
        activeSessionTitle: "Активная целевая сессия",
        activeSessionSubtitle: "Что отправлять автоматически для целевой сессии.",
        otherSessionsTitle: "Другие сессии",
        otherSessionsSubtitle: "Что отправлять автоматически для нецелевых сессий.",
        level: {
          noneTitle: "Нет",
          noneSubtitle: "Не отправлять автоматические обновления.",
          activityTitle: "Только активность",
          activitySubtitle: "Только счетчики и время.",
          summariesTitle: "Сводки",
          summariesSubtitle: "Короткие безопасные сводки (без текста сообщений).",
          snippetsTitle: "Сниппеты",
          snippetsSubtitle: "Короткие фрагменты сообщений (риск приватности).",
        },
        snippetsMaxMessagesTitle: "Макс. сообщений",
        snippetsMaxMessagesSubtitle: "Лимит сообщений на обновление.",
        includeUserMessagesInSnippetsTitle: "Включать ваши сообщения",
        includeUserMessagesInSnippetsSubtitle: "Если включено, сниппеты могут включать ваши сообщения.",
        otherSessionsSnippetsModeTitle: "Сниппеты других сессий",
        otherSessionsSnippetsModeSubtitle: "Когда разрешены сниппеты для других сессий.",
        otherSessionsSnippetsMode: {
          neverTitle: "Никогда",
          neverSubtitle: "Отключить сниппеты для других сессий.",
          onDemandTitle: "По запросу",
          onDemandSubtitle: "Разрешать только по явному запросу пользователя.",
          autoTitle: "Авто",
          autoSubtitle: "Разрешать автоматические сниппеты (шумно).",
        },
      },
    },
    byo: {
      title: "Свой ElevenLabs",
      configured:
        "Настроено. Использование голоса будет списываться с вашего аккаунта ElevenLabs.",
      notConfigured:
        "Введите API-ключ ElevenLabs и ID агента, чтобы использовать голос без подписки.",
      createAccount: "Создать аккаунт ElevenLabs",
      createAccountSubtitle:
        "Зарегистрируйтесь (или войдите), прежде чем создавать API-ключ",
      openApiKeys: "Open ElevenLabs API keys",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "How to create an API key",
      apiKeyHelpSubtitle:
        "Step-by-step help for creating and copying your ElevenLabs API key",
      apiKeyHelpDialogTitle: "Create an ElevenLabs API key",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Создать агента Happier",
      autoprovCreateSubtitle:
        "Создать и настроить агента Happier в вашем аккаунте ElevenLabs с помощью API-ключа",
      autoprovUpdate: "Обновить агента",
      autoprovUpdateSubtitle: "Обновить агента до последнего шаблона Happier",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `Агент создан: ${agentId}`,
      autoprovUpdated: "Агент обновлён",
      autoprovFailed:
        "Не удалось создать/обновить агента. Пожалуйста, попробуйте ещё раз.",
      agentId: "ID агента",
      agentIdSet: "Установлено",
      agentIdNotSet: "Не установлено",
      agentIdTitle: "ID агента ElevenLabs",
      agentIdDescription: "Введите ID агента из панели управления ElevenLabs.",
      agentIdPlaceholder: "agent_...",
      apiKey: "API-ключ",
      apiKeySet: "Установлено",
      apiKeyNotSet: "Не установлено",
      apiKeyTitle: "API-ключ ElevenLabs",
      apiKeyDescription:
        "Введите ваш API-ключ ElevenLabs. Он хранится на устройстве в зашифрованном виде.",
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
      apiKeySaveFailed:
        "Не удалось сохранить API-ключ. Пожалуйста, попробуйте ещё раз.",
      disconnect: "Отключить",
      disconnectSubtitle:
        "Удалить сохранённые на этом устройстве данные ElevenLabs",
      disconnectTitle: "Отключить ElevenLabs",
      disconnectDescription:
        "Это удалит сохранённые на этом устройстве API-ключ ElevenLabs и ID агента.",
      disconnectConfirm: "Отключить",
    },
    local: {
      title: "Локальный OSS голос",
      footer:
        "Настройте OpenAI-совместимые эндпоинты для распознавания речи (STT) и озвучивания (TTS).",
      localhostWarning:
        "Примечание: «localhost» и «127.0.0.1» обычно не работают на телефонах. Используйте LAN IP компьютера или туннель.",
      notSet: "Не установлено",
      apiKeySet: "Установлено",
      apiKeyNotSet: "Не установлено",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "Необязательно",
      apiKeySaveFailed:
        "Не удалось сохранить API-ключ. Пожалуйста, попробуйте ещё раз.",
      conversationMode: "Режим разговора",
      conversationModeSubtitle:
        "Напрямую в сессию, или через медиатор с явным коммитом",
      mediatorBackend: "Бэкенд медиатора",
      mediatorBackendSubtitle:
        "Демон (использует ваш бэкенд Happier) или OpenAI-совместимый HTTP",
      mediatorBackendDaemon: "Демон",
      mediatorBackendOpenAi: "OpenAI-совместимый HTTP",
      mediatorAgentSource: "Источник агента медиатора",
      mediatorAgentSourceSubtitle:
        "Использовать бэкенд сессии или принудительно выбрать конкретный агент",
      mediatorAgentSourceSession: "Бэкенд сессии",
      mediatorAgentSourceAgent: "Конкретный агент",
      mediatorAgentId: "Агент медиатора",
      mediatorAgentIdSubtitle:
        "Какой агент-бэкенд использовать для медиатора (когда не используется сессия)",
      mediatorPermissionPolicy: "Разрешения медиатора",
      mediatorPermissionPolicySubtitle:
        "Ограничьте использование инструментов во время медиации",
      mediatorPermissionReadOnly: "Только чтение",
      mediatorPermissionNoTools: "Без инструментов",
      mediatorVerbosity: "Подробность медиатора",
      mediatorVerbositySubtitle: "Насколько подробным должен быть медиатор",
      mediatorVerbosityShort: "Коротко",
      mediatorVerbosityBalanced: "Сбалансированно",
      mediatorIdleTtl: "TTL бездействия медиатора",
      mediatorIdleTtlSubtitle: "Авто-остановка после бездействия (60–3600с)",
      mediatorIdleTtlTitle: "TTL бездействия медиатора (секунды)",
      mediatorIdleTtlDescription: "Введите число от 60 до 3600.",
      mediatorIdleTtlInvalid: "Введите число от 60 до 3600.",
      mediatorChatModelSource: "Источник модели медиатора (чат)",
      mediatorChatModelSourceSubtitle:
        "Использовать модель сессии или свою быструю модель",
      mediatorChatModelSourceSession: "Модель сессии",
      mediatorChatModelSourceCustom: "Своя модель",
      mediatorCommitModelSource: "Источник модели медиатора (коммит)",
      mediatorCommitModelSourceSubtitle:
        "Использовать модель чата, модель сессии или свою модель",
      mediatorCommitModelSourceChat: "Модель чата",
      mediatorCommitModelSourceSession: "Модель сессии",
      mediatorCommitModelSourceCustom: "Своя модель",
      chatBaseUrl: "Chat Base URL",
      chatBaseUrlTitle: "Chat Base URL",
      chatBaseUrlDescription:
        "Базовый URL для OpenAI-совместимого chat completion эндпоинта (обычно заканчивается на /v1).",
      chatApiKey: "Chat API-ключ",
      chatApiKeyTitle: "Chat API-ключ",
      chatApiKeyDescription:
        "Необязательный API-ключ для chat сервера (хранится в зашифрованном виде). Оставьте пустым, чтобы очистить.",
      chatModel: "Chat модель",
      chatModelSubtitle: "Быстрая модель для живого голосового диалога",
      chatModelTitle: "Chat модель",
      chatModelDescription:
        "Имя модели, отправляемое на chat сервер (OpenAI-совместимое поле).",
      modelCustomTitle: "Свой…",
      modelCustomSubtitle: "Введите ID модели",
      commitModel: "Commit модель",
      commitModelSubtitle:
        "Модель для генерации финального сообщения-инструкции",
      commitModelTitle: "Commit модель",
      commitModelDescription:
        "Имя модели, отправляемое при генерации финального commit сообщения.",
      chatTemperature: "Chat temperature",
      chatTemperatureSubtitle: "Управляет случайностью (0–2)",
      chatTemperatureTitle: "Chat temperature",
      chatTemperatureDescription: "Введите число от 0 до 2.",
      chatTemperatureInvalid: "Введите число от 0 до 2.",
      chatMaxTokens: "Chat max tokens",
      chatMaxTokensSubtitle: "Ограничить длину ответа (пусто = по умолчанию)",
      chatMaxTokensTitle: "Chat max tokens",
      chatMaxTokensDescription:
        "Введите положительное целое число или оставьте пустым.",
      chatMaxTokensPlaceholder: "Пусто = по умолчанию",
      chatMaxTokensUnlimited: "По умолчанию",
      chatMaxTokensInvalid: "Введите положительное число или оставьте пустым.",
      sttBaseUrl: "STT Base URL",
      sttBaseUrlTitle: "STT Base URL",
      sttBaseUrlDescription:
        "Базовый URL для OpenAI-совместимого эндпоинта транскрибации (обычно заканчивается на /v1).",
      sttApiKey: "STT API-ключ",
      sttApiKeyTitle: "STT API-ключ",
      sttApiKeyDescription:
        "Необязательный API-ключ для STT сервера (хранится в зашифрованном виде). Оставьте пустым, чтобы очистить.",
      sttModel: "STT модель",
      sttModelSubtitle: "Имя модели, отправляемое в запросах транскрибации",
      sttModelTitle: "STT модель",
      sttModelDescription:
        "Имя модели, отправляемое на STT сервер (OpenAI-совместимое поле).",
      deviceStt: "Device STT (experimental)",
      deviceSttSubtitle:
        "Use on-device speech recognition instead of an OpenAI-compatible endpoint",
      ttsBaseUrl: "TTS Base URL",
      ttsBaseUrlTitle: "TTS Base URL",
      ttsBaseUrlDescription:
        "Базовый URL для OpenAI-совместимого эндпоинта озвучивания (обычно заканчивается на /v1).",
      ttsApiKey: "TTS API-ключ",
      ttsApiKeyTitle: "TTS API-ключ",
      ttsApiKeyDescription:
        "Необязательный API-ключ для TTS сервера (хранится в зашифрованном виде). Оставьте пустым, чтобы очистить.",
      ttsModel: "TTS модель",
      ttsModelSubtitle: "Имя модели, отправляемое в запросах озвучивания",
      ttsModelTitle: "TTS модель",
      ttsModelDescription:
        "Имя модели, отправляемое на TTS сервер (OpenAI-совместимое поле).",
      ttsVoice: "TTS голос",
      ttsVoiceSubtitle: "Имя/ID голоса, отправляемое в запросах озвучивания",
      ttsVoiceTitle: "TTS голос",
      ttsVoiceDescription:
        "Имя/ID голоса, отправляемое на TTS сервер (OpenAI-совместимое поле).",
      ttsFormat: "TTS формат",
      ttsFormatSubtitle: "Формат аудио, возвращаемый TTS",
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

      autoSpeak: "Авто-озвучивание ответов",
      autoSpeakSubtitle:
        "Озвучивать следующий ответ ассистента после отправки голосового сообщения",
    },
    privacy: {
      title: "Конфиденциальность",
      footer: "Голосовые провайдеры получают выбранный контекст сессии.",
      shareSessionSummary: "Передавать краткое описание сессии",
      shareSessionSummarySubtitle:
        "Добавлять summary сессии в голосовой контекст",
      shareRecentMessages: "Передавать последние сообщения",
      shareRecentMessagesSubtitle:
        "Добавлять последние сообщения в голосовой контекст",
      recentMessagesCount: "Количество последних сообщений",
      recentMessagesCountSubtitle:
        "Сколько последних сообщений включать (0–50)",
      recentMessagesCountTitle: "Количество последних сообщений",
      recentMessagesCountDescription: "Введите число от 0 до 50.",
      recentMessagesCountInvalid: "Введите число от 0 до 50.",
      shareToolNames: "Передавать имена инструментов",
      shareToolNamesSubtitle: "Добавлять имена/описания инструментов в голосовой контекст",
      shareDeviceInventory: "Share device inventory",
      shareDeviceInventorySubtitle: "Allow voice to list recent workspaces, machines, and servers",
      shareToolArgs: "Передавать аргументы инструментов",
      shareToolArgsSubtitle: "Добавлять аргументы инструментов (может содержать пути или секреты)",
      sharePermissionRequests: "Передавать запросы разрешений",
      sharePermissionRequestsSubtitle: "Пересылать запросы разрешений в голос",
      shareFilePaths: "Передавать локальные пути",
      shareFilePathsSubtitle:
        "Добавлять локальные пути в голосовой контекст (не рекомендуется)",
    },
    languageTitle: "Язык",
    languageDescription:
      "Выберите предпочтительный язык для взаимодействия с голосовым помощником. Эта настройка синхронизируется на всех ваших устройствах.",
    preferredLanguage: "Предпочтительный язык",
    preferredLanguageSubtitle:
      "Язык, используемый для ответов голосового помощника",
    language: {
      searchPlaceholder: "Поиск языков...",
      title: "Языки",
      footer: ({ count }: { count: number }) =>
        `Доступно ${count} ${plural({ count, one: "язык", few: "языка", many: "языков" })}`,
      autoDetect: "Автоопределение",
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Информация об аккаунте",
    status: "Статус",
    statusActive: "Активный",
    statusNotAuthenticated: "Не авторизован",
    anonymousId: "Анонимный ID",
    publicId: "Публичный ID",
    notAvailable: "Недоступно",
    linkNewDevice: "Привязать новое устройство",
    linkNewDeviceSubtitle: "Отсканируйте QR-код для привязки устройства",
    profile: "Профиль",
    name: "Имя",
    github: "GitHub",
    showGitHubOnProfile: "Показывать в профиле",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `Показывать ${provider} в профиле`,
    tapToDisconnect: "Нажмите для отключения",
    server: "Сервер",
    backup: "Резервная копия",
    backupDescription:
      "Ваш секретный ключ - единственный способ восстановить ваш аккаунт. Сохраните его в безопасном месте, например в менеджере паролей.",
    secretKey: "Секретный ключ",
    tapToReveal: "Нажмите для показа",
    tapToHide: "Нажмите для скрытия",
    secretKeyLabel: "СЕКРЕТНЫЙ КЛЮЧ (НАЖМИТЕ ДЛЯ КОПИРОВАНИЯ)",
    secretKeyCopied:
      "Секретный ключ скопирован в буфер обмена. Сохраните его в безопасном месте!",
    secretKeyCopyFailed: "Не удалось скопировать секретный ключ",
    privacy: "Конфиденциальность",
    privacyDescription:
      "Помогите улучшить приложение, поделившись анонимными данными об использовании. Никакая личная информация не собирается.",
    analytics: "Аналитика",
    analyticsDisabled: "Данные не передаются",
    analyticsEnabled: "Анонимные данные об использовании передаются",
    dangerZone: "Опасная зона",
    logout: "Выйти",
    logoutSubtitle: "Выйти из аккаунта и очистить локальные данные",
    logoutConfirm:
      "Вы уверены, что хотите выйти? Убедитесь, что вы сохранили резервную копию секретного ключа!",
  },

  connectButton: {
    authenticate: "Авторизация терминала",
    authenticateWithUrlPaste: "Авторизация терминала через URL",
    pasteAuthUrl: "Вставьте авторизационный URL из терминала",
  },

  updateBanner: {
    updateAvailable: "Доступно обновление",
    pressToApply: "Нажмите, чтобы применить обновление",
    whatsNew: "Что нового",
    seeLatest: "Посмотреть последние обновления и улучшения",
    nativeUpdateAvailable: "Доступно обновление приложения",
    tapToUpdateAppStore: "Нажмите для обновления в App Store",
    tapToUpdatePlayStore: "Нажмите для обновления в Play Store",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `Версия ${version}`,
    noEntriesAvailable: "Записи журнала изменений недоступны.",
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Требуется веб-браузер",
    webBrowserRequiredDescription:
      "Ссылки подключения терминала можно открывать только в веб-браузере по соображениям безопасности. Используйте сканер QR-кодов или откройте эту ссылку на компьютере.",
    processingConnection: "Обработка подключения...",
    invalidConnectionLink: "Неверная ссылка подключения",
    invalidConnectionLinkDescription:
      "Ссылка подключения отсутствует или неверна. Проверьте URL и попробуйте снова.",
    connectTerminal: "Подключить терминал",
    terminalRequestDescription:
      "Терминал запрашивает подключение к вашему аккаунту Happier Coder. Это позволит терминалу безопасно отправлять и получать сообщения.",
    connectionDetails: "Детали подключения",
    publicKey: "Публичный ключ",
    encryption: "Шифрование",
    endToEndEncrypted: "Сквозное шифрование",
    acceptConnection: "Принять подключение",
    connecting: "Подключение...",
    reject: "Отклонить",
    security: "Безопасность",
    securityFooter:
      "Эта ссылка подключения была безопасно обработана в вашем браузере и никогда не отправлялась на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.",
    securityFooterDevice:
      "Это подключение было безопасно обработано на вашем устройстве и никогда не отправлялось на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.",
    clientSideProcessing: "Обработка на стороне клиента",
    linkProcessedLocally: "Ссылка обработана локально в браузере",
    linkProcessedOnDevice: "Ссылка обработана локально на устройстве",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `This connection is for ${serverUrl}. Switch servers and continue?`,
  },

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Авторизация терминала",
    pasteUrlFromTerminal: "Вставьте URL авторизации из вашего терминала",
    deviceLinkedSuccessfully: "Устройство успешно связано",
    terminalConnectedSuccessfully: "Терминал успешно подключен",
    terminalAlreadyConnected: "Подключение уже использовано",
    terminalConnectionAlreadyUsedDescription: "Эта ссылка для подключения уже была использована другим устройством. Чтобы подключить несколько устройств к одному терминалу, выйдите из системы и войдите в одну и ту же учетную запись на всех устройствах.",
    authRequestExpired: "Подключение истекло",
    authRequestExpiredDescription: "Срок действия ссылки для подключения истек. Создайте новую ссылку с вашего терминала.",
    pleaseSignInFirst: "Please sign in (or create an account) first.",
    invalidAuthUrl: "Неверный URL авторизации",
    microphoneAccessRequiredTitle: "Требуется доступ к микрофону",
    microphoneAccessRequiredRequestPermission:
      "Happier нужен доступ к микрофону для голосового чата. Разрешите доступ, когда появится запрос.",
    microphoneAccessRequiredEnableInSettings:
      "Happier нужен доступ к микрофону для голосового чата. Включите доступ к микрофону в настройках устройства.",
    microphoneAccessRequiredBrowserInstructions:
      "Разрешите доступ к микрофону в настройках браузера. Возможно, нужно нажать на значок замка в адресной строке и включить разрешение микрофона для этого сайта.",
    openSettings: "Открыть настройки",
    developerMode: "Режим разработчика",
    developerModeEnabled: "Режим разработчика включен",
    developerModeDisabled: "Режим разработчика отключен",
    disconnectGithub: "Отключить GitHub",
    disconnectGithubConfirm:
      "При отключении функция «Друзья» и возможность делиться с друзьями станут недоступны, пока вы не подключите GitHub снова.",
    disconnectService: ({ service }: { service: string }) =>
      `Отключить ${service}`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `Вы уверены, что хотите отключить ${service} от вашего аккаунта?`,
    disconnect: "Отключить",
    failedToConnectTerminal: "Не удалось подключить терминал",
    cameraPermissionsRequiredToConnectTerminal:
      "Для подключения терминала требуется доступ к камере",
    failedToLinkDevice: "Не удалось связать устройство",
    cameraPermissionsRequiredToScanQr:
      "Для сканирования QR-кодов требуется доступ к камере",
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "Подключить терминал",
    linkNewDevice: "Связать новое устройство",
    restoreWithSecretKey: "Восстановить секретным ключом",
    whatsNew: "Что нового",
    friends: "Друзья",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Мобильный клиент Codex и Claude Code",
    subtitle:
      "Сквозное шифрование, аккаунт хранится только на вашем устройстве.",
    createAccount: "Создать аккаунт",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Продолжить через ${provider}`,
    linkOrRestoreAccount: "Связать или восстановить аккаунт",
    loginWithMobileApp: "Войти через мобильное приложение",
  },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "Нравится приложение?",
    feedbackPrompt: "Мы будем рады вашему отзыву!",
    yesILoveIt: "Да, мне нравится!",
    notReally: "Не совсем",
  },

  items: {
    // Used by Item component for copy toast
    copiedToClipboard: ({ label }: { label: string }) =>
      `${label} скопировано в буфер обмена`,
  },

  machine: {
    offlineUnableToSpawn: "Запуск отключён: машина офлайн",
    offlineHelp:
      "• Убедитесь, что компьютер онлайн\n• Выполните `happier daemon status` для диагностики\n• Используете последнюю версию CLI? Обновите командой `npm install -g @happier-dev/cli@latest`",
    launchNewSessionInDirectory: "Запустить новую сессию в папке",
    daemon: "Демон",
    status: "Статус",
    stopDaemon: "Остановить daemon",
    stopDaemonConfirmTitle: "Остановить демон?",
    stopDaemonConfirmBody:
      "Вы не сможете создавать новые сессии на этой машине, пока не перезапустите демон на компьютере. Текущие сессии останутся активными.",
    daemonStoppedTitle: "Демон остановлен",
    stopDaemonFailed: "Не удалось остановить демон. Возможно, он не запущен.",
    renameTitle: "Переименовать машину",
    renameDescription:
      "Дайте этой машине имя. Оставьте пустым, чтобы использовать hostname по умолчанию.",
    renamePlaceholder: "Введите имя машины",
    renamedSuccess: "Машина успешно переименована",
    renameFailed: "Не удалось переименовать машину",
    lastKnownPid: "Последний известный PID",
    lastKnownHttpPort: "Последний известный HTTP порт",
    startedAt: "Запущен в",
    cliVersion: "Версия CLI",
    daemonStateVersion: "Версия состояния daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Активные сессии (${count})`,
    machineGroup: "Машина",
    host: "Хост",
    machineId: "ID машины",
    username: "Имя пользователя",
    homeDirectory: "Домашний каталог",
    platform: "Платформа",
    architecture: "Архитектура",
    lastSeen: "Последняя активность",
    never: "Никогда",
    metadataVersion: "Версия метаданных",
    detectedClis: "Обнаруженные CLI",
    detectedCliNotDetected: "Не обнаружено",
    detectedCliUnknown: "Неизвестно",
    detectedCliNotSupported: "Не поддерживается (обновите @happier-dev/cli)",
    untitledSession: "Безымянная сессия",
    back: "Назад",
    notFound: "Машина не найдена",
    unknownMachine: "неизвестная машина",
    unknownPath: "неизвестный путь",
    tmux: {
      overrideTitle: "Переопределить глобальные настройки tmux",
      overrideEnabledSubtitle:
        "Пользовательские настройки tmux применяются к новым сессиям на этой машине.",
      overrideDisabledSubtitle:
        "Новые сессии используют глобальные настройки tmux.",
      notDetectedSubtitle: "tmux не обнаружен на этой машине.",
      notDetectedMessage:
        "tmux не обнаружен на этой машине. Установите tmux и обновите обнаружение.",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "Показывать консоль для удалённых сессий",
      remoteSessionConsoleVisibleSubtitle:
        "Удалённые сессии открываются в видимом окне консоли на этой машине.",
      remoteSessionConsoleHiddenSubtitle:
        "Удалённые сессии запускаются скрыто, чтобы избежать мерцания/открытия окон.",
      remoteSessionConsoleUpdateFailed:
        "Не удалось обновить настройку консоли для Windows-сессий.",
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) =>
      `Переключено в режим ${mode}`,
    discarded: "Отброшено",
    unknownEvent: "Неизвестное событие",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Лимит использования достигнут до ${time}`,
    unknownTime: "неизвестное время",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "Разрешения отображаются только в терминале. Сбросьте их или отправьте сообщение, чтобы управлять из приложения.",
    sessionRunningLocally:
      "Эта сессия запущена локально на этом компьютере. Вы можете переключиться на удалённый режим, чтобы управлять из приложения.",
    switchToRemote: "Переключиться на удалённый",
    localModeAvailable: "Локальный режим доступен для этой сессии.",
    localModeUnavailableMachineOffline:
      "Локальный режим недоступен, пока эта машина офлайн.",
    localModeUnavailableDaemonStarted:
      "Локальный режим недоступен для сессий, запущенных демоном.",
    localModeUnavailableNeedsResume:
      "Локальный режим требует поддержки возобновления для этого провайдера.",
    switchToLocal: "Переключиться на локальный",
  },

  codex: {
    // Codex permission dialog buttons
    permissions: {
      yesAlwaysAllowCommand: "Да, разрешить глобально",
      yesForSession: "Да, и не спрашивать для этой сессии",
      stopAndExplain: "Остановить и объяснить, что делать",
    },
  },

  claude: {
    // Claude permission dialog buttons
    permissions: {
      yesAllowAllEdits: "Да, разрешить все правки в этой сессии",
      yesForTool: "Да, больше не спрашивать для этого инструмента",
      yesForCommandPrefix:
        "Да, больше не спрашивать для этого префикса команды",
      yesForSubcommand: "Да, больше не спрашивать для этой подкоманды",
      yesForCommandName: "Да, больше не спрашивать для этой команды",
      noTellClaude: "Нет, дать обратную связь",
    },
  },

  settingsLanguage: {
    // Language settings screen
    title: "Язык",
    description:
      "Выберите предпочтительный язык интерфейса приложения. Настройки синхронизируются на всех ваших устройствах.",
    currentLanguage: "Текущий язык",
    automatic: "Автоматически",
    automaticSubtitle: "Определять по настройкам устройства",
    needsRestart: "Язык изменён",
    needsRestartMessage:
      "Приложение нужно перезапустить для применения новых языковых настроек.",
    restartNow: "Перезапустить",
  },

  textSelection: {
    // Text selection screen
    selectText: "Выделить диапазон текста",
    title: "Выделить текст",
    noTextProvided: "Текст не предоставлен",
    textNotFound: "Текст не найден или устарел",
    textCopied: "Текст скопирован в буфер обмена",
    failedToCopy: "Не удалось скопировать текст в буфер обмена",
    noTextToCopy: "Нет текста для копирования",
    failedToOpen:
      "Не удалось открыть выбор текста. Пожалуйста, попробуйте снова.",
  },

  markdown: {
    // Markdown copy functionality
    codeCopied: "Код скопирован",
    copyFailed: "Ошибка копирования",
    mermaidRenderFailed: "Не удалось отобразить диаграмму mermaid",
  },

  artifacts: {
    // Artifacts feature
    title: "Артефакты",
    countSingular: "1 артефакт",
    countPlural: ({ count }: { count: number }) => {
      const n = Math.abs(count);
      const n10 = n % 10;
      const n100 = n % 100;

      if (n10 === 1 && n100 !== 11) {
        return `${count} артефакт`;
      }
      if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) {
        return `${count} артефакта`;
      }
      return `${count} артефактов`;
    },
    empty: "Артефактов пока нет",
    emptyDescription: "Создайте первый артефакт, чтобы начать",
    new: "Новый артефакт",
    edit: "Редактировать артефакт",
    delete: "Удалить",
    updateError:
      "Не удалось обновить артефакт. Пожалуйста, попробуйте еще раз.",
    deleteError: "Не удалось удалить артефакт. Пожалуйста, попробуйте снова.",
    notFound: "Артефакт не найден",
    discardChanges: "Отменить изменения?",
    discardChangesDescription:
      "У вас есть несохраненные изменения. Вы уверены, что хотите их отменить?",
    deleteConfirm: "Удалить артефакт?",
    deleteConfirmDescription: "Это действие нельзя отменить",
    noContent: "Нет содержимого",
    untitled: "Без названия",
    titleLabel: "ЗАГОЛОВОК",
    titlePlaceholder: "Введите заголовок для вашего артефакта",
    bodyLabel: "СОДЕРЖИМОЕ",
    bodyPlaceholder: "Напишите ваш контент здесь...",
    emptyFieldsError: "Пожалуйста, введите заголовок или содержимое",
    createError: "Не удалось создать артефакт. Пожалуйста, попробуйте снова.",
    save: "Сохранить",
    saving: "Сохранение...",
    loading: "Загрузка артефактов...",
    error: "Не удалось загрузить артефакт",
  },

  friends: {
    // Friends feature
    title: "Друзья",
    manageFriends: "Управляйте своими друзьями и связями",
    sharedSessions: "Общие сессии",
    noSharedSessions: "Пока нет общих сессий",
    searchTitle: "Найти друзей",
    pendingRequests: "Запросы в друзья",
    myFriends: "Мои друзья",
    noFriendsYet: "У вас пока нет друзей",
    findFriends: "Найти друзей",
    remove: "Удалить",
    pendingRequest: "Ожидается",
    sentOn: ({ date }: { date: string }) => `Отправлено ${date}`,
    accept: "Принять",
    reject: "Отклонить",
    addFriend: "Добавить в друзья",
    alreadyFriends: "Уже в друзьях",
    requestPending: "Запрос отправлен",
    searchInstructions: "Введите имя пользователя для поиска друзей",
    searchPlaceholder: "Введите имя пользователя...",
    searching: "Поиск...",
    userNotFound: "Пользователь не найден",
    noUserFound: "Пользователь с таким именем не найден",
    checkUsername: "Пожалуйста, проверьте имя пользователя и попробуйте снова",
    howToFind: "Как найти друзей",
    findInstructions:
      "Ищите друзей по имени пользователя. В зависимости от сервера вам может потребоваться подключить провайдера или выбрать имя пользователя, чтобы использовать Друзей.",
    requestSent: "Запрос в друзья отправлен!",
    requestAccepted: "Запрос в друзья принят!",
    requestRejected: "Запрос в друзья отклонён",
    friendRemoved: "Друг удалён",
    confirmRemove: "Удалить из друзей",
    confirmRemoveMessage: "Вы уверены, что хотите удалить этого друга?",
    cannotAddYourself: "Вы не можете отправить запрос в друзья самому себе",
    bothMustHaveGithub:
      "Оба пользователя должны подключить требуемого провайдера, чтобы стать друзьями",
    status: {
      none: "Не подключен",
      requested: "Запрос отправлен",
      pending: "Запрос ожидается",
      friend: "Друзья",
      rejected: "Отклонено",
    },
    acceptRequest: "Принять запрос",
    removeFriend: "Удалить из друзей",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `Вы уверены, что хотите удалить ${name} из друзей?`,
    requestSentDescription: ({ name }: { name: string }) =>
      `Ваш запрос в друзья отправлен пользователю ${name}`,
    requestFriendship: "Отправить запрос в друзья",
    cancelRequest: "Отменить запрос в друзья",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `Отменить ваш запрос в друзья к ${name}?`,
    denyRequest: "Отклонить запрос",
    nowFriendsWith: ({ name }: { name: string }) =>
      `Теперь вы друзья с ${name}`,
    disabled: "Друзья отключены на этом сервере.",
    username: {
      required: "Выберите имя пользователя, чтобы пользоваться друзьями.",
      taken: "Это имя пользователя уже занято.",
      invalid: "Это имя пользователя недопустимо.",
      disabled: "Друзья по имени пользователя не включены на этом сервере.",
      preferredNotAvailable:
        "Ваше предпочитаемое имя пользователя недоступно на этом сервере. Пожалуйста, выберите другое.",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `Ваше предпочитаемое имя пользователя @${login} недоступно на этом сервере. Пожалуйста, выберите другое.`,
    },
    githubGate: {
      title: "Подключите GitHub, чтобы пользоваться друзьями",
      body: "Друзья используют имена пользователей GitHub для поиска и обмена.",
      connect: "Подключить GitHub",
      notAvailable: "Недоступно?",
      notConfigured: "GitHub OAuth не настроен на этом сервере.",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `Подключите ${provider}, чтобы пользоваться друзьями`,
      body: ({ provider }: { provider: string }) =>
        `Друзья используют имена пользователей ${provider} для поиска и обмена.`,
      connect: ({ provider }: { provider: string }) => `Подключить ${provider}`,
      notAvailable: "Недоступно?",
      notConfigured: ({ provider }: { provider: string }) =>
        `${provider} OAuth не настроен на этом сервере.`,
    },
  },

  usage: {
    // Usage panel strings
    today: "Сегодня",
    last7Days: "Последние 7 дней",
    last30Days: "Последние 30 дней",
    totalTokens: "Всего токенов",
    totalCost: "Общая стоимость",
    tokens: "Токены",
    cost: "Стоимость",
    usageOverTime: "Использование во времени",
    byModel: "По модели",
    noData: "Данные об использовании недоступны",
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} отправил вам запрос в друзья`,
    friendRequestGeneric: "Новый запрос в друзья",
    friendAccepted: ({ name }: { name: string }) =>
      `Вы теперь друзья с ${name}`,
    friendAcceptedGeneric: "Запрос в друзья принят",
  },

  secrets: {
    addTitle: "Новый секрет",
    savedTitle: "Сохранённые секреты",
    badgeReady: "Секреты",
    badgeRequired: "Требуется секрет",
    missingForProfile: ({ env }: { env: string | null }) =>
      `Не хватает секрета (${env ?? "секрет"}). Настройте его на машине или выберите/введите секрет.`,
    defaultForProfileTitle: "Секрет по умолчанию",
    defineDefaultForProfileTitle:
      "Установить секрет по умолчанию для этого профиля",
    addSubtitle: "Добавить сохранённый секрет",
    noneTitle: "Нет",
    noneSubtitle:
      "Используйте окружение машины или введите секрет для этой сессии",
    emptyTitle: "Нет сохранённых ключей",
    emptySubtitle:
      "Добавьте секрет, чтобы использовать профили с требованием секрета без переменных окружения на машине.",
    savedHiddenSubtitle: "Сохранён (значение скрыто)",
    defaultLabel: "По умолчанию",
    fields: {
      name: "Имя",
      value: "Значение",
    },
    placeholders: {
      nameExample: "например, Work OpenAI",
    },
    validation: {
      nameRequired: "Имя обязательно.",
      valueRequired: "Значение обязательно.",
    },
    actions: {
      replace: "Заменить",
      replaceValue: "Заменить значение",
      setDefault: "Сделать по умолчанию",
      unsetDefault: "Убрать по умолчанию",
    },
    prompts: {
      renameTitle: "Переименовать секрет",
      renameDescription: "Обновите понятное имя для этого ключа.",
      replaceValueTitle: "Заменить значение секрета",
      replaceValueDescription:
        "Вставьте новое значение секрета. После сохранения оно больше не будет показано.",
      deleteTitle: "Удалить секрет",
      deleteConfirm: ({ name }: { name: string }) =>
        `Удалить «${name}»? Это нельзя отменить.`,
    },
  },

  profiles: {
    // Profile management feature
    title: "Профили",
    subtitle: "Управление профилями переменных окружения для сессий",
    sessionUses: ({ profile }: { profile: string }) =>
      `Эта сессия использует: ${profile}`,
    profilesFixedPerSession:
      "Профили фиксированы для каждой сессии. Чтобы использовать другой профиль, начните новую сессию.",
    noProfile: "Без Профиля",
    noProfileDescription: "Использовать настройки окружения по умолчанию",
    defaultModel: "Модель по Умолчанию",
    addProfile: "Добавить Профиль",
    profileName: "Имя Профиля",
    enterName: "Введите имя профиля",
    baseURL: "Базовый URL",
    authToken: "Токен Аутентификации",
    enterToken: "Введите токен аутентификации",
    model: "Модель",
    tmuxSession: "Сессия Tmux",
    enterTmuxSession: "Введите имя сессии tmux",
    tmuxTempDir: "Временный каталог Tmux",
    enterTmuxTempDir: "Введите путь к временному каталогу",
    tmuxUpdateEnvironment: "Обновлять окружение автоматически",
    nameRequired: "Имя профиля обязательно",
    deleteConfirm: ({ name }: { name: string }) =>
      `Вы уверены, что хотите удалить профиль "${name}"?`,
    editProfile: "Редактировать Профиль",
    addProfileTitle: "Добавить Новый Профиль",
    builtIn: "Встроенный",
    custom: "Пользовательский",
    builtInSaveAsHint:
      "Сохранение встроенного профиля создаёт новый пользовательский профиль.",
    builtInNames: {
      anthropic: "Anthropic (по умолчанию)",
      deepseek: "DeepSeek (Рассуждение)",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (по умолчанию)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (по умолчанию)",
      geminiApiKey: "Gemini (API key)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "Избранное",
      custom: "Ваши профили",
      builtIn: "Встроенные профили",
    },
    actions: {
      viewEnvironmentVariables: "Переменные окружения",
      addToFavorites: "Добавить в избранное",
      removeFromFavorites: "Убрать из избранного",
      editProfile: "Редактировать профиль",
      duplicateProfile: "Дублировать профиль",
      deleteProfile: "Удалить профиль",
    },
    copySuffix: "(Копия)",
    duplicateName: "Профиль с таким названием уже существует",
    setupInstructions: {
      title: "Инструкции по настройке",
      viewCloudGuide: "Открыть официальное руководство",
    },
    machineLogin: {
      title: "Требуется вход на машине",
      subtitle: "Этот профиль использует кэш входа CLI на выбранной машине.",
      status: {
        loggedIn: "Вход выполнен",
        notLoggedIn: "Вход не выполнен",
      },
      claudeCode: {
        title: "Claude Code",
        instructions:
          "Запустите `claude`, затем введите `/login`, чтобы войти.",
        warning:
          "Примечание: установка `ANTHROPIC_AUTH_TOKEN` переопределяет вход через CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Выполните `codex login`, чтобы войти.",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "Выполните `gemini auth`, чтобы войти.",
      },
    },
    requirements: {
      secretRequired: "Секрет",
      configured: "Настроен на машине",
      notConfigured: "Не настроен",
      checking: "Проверка…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `Этот профиль требует настройки ${env} на машине.`,
      modalTitle: "Требуется секрет",
      modalBody:
        "Для этого профиля требуется секрет.\n\nДоступные варианты:\n• Использовать окружение машины (рекомендуется)\n• Использовать сохранённый секрет из настроек приложения\n• Ввести секрет только для этой сессии",
      sectionTitle: "Требования",
      sectionSubtitle:
        "Эти поля используются для предварительной проверки готовности и чтобы избежать неожиданных ошибок.",
      secretEnvVarPromptDescription:
        "Введите имя обязательной секретной переменной окружения (например, OPENAI_API_KEY).",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `Для этого профиля требуется ${env}. Выберите один вариант ниже.`,
      modalHelpGeneric:
        "Для этого профиля требуется секрет. Выберите один вариант ниже.",
      chooseOptionTitle: "Выберите вариант",
      machineEnvStatus: {
        theMachine: "машине",
        checkFor: ({ env }: { env: string }) => `Проверить ${env}`,
        checking: ({ env }: { env: string }) => `Проверяем ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${env} найден на ${machine}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${env} не найден на ${machine}`,
      },
      machineEnvSubtitle: {
        checking: "Проверяем окружение демона…",
        found: "Найдено в окружении демона на машине.",
        notFound:
          "Укажите значение в окружении демона на машине и перезапустите демон.",
      },
      options: {
        none: {
          title: "Нет",
          subtitle: "Не требует секрета или входа через CLI.",
        },
        machineLogin: {
          subtitle: "Требуется вход через CLI на целевой машине.",
          longSubtitle:
            "Требуется быть авторизованным через CLI для выбранного бэкенда ИИ на целевой машине.",
        },
        useMachineEnvironment: {
          title: "Использовать окружение машины",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `Использовать ${env} из окружения демона.`,
          subtitleGeneric: "Использовать секрет из окружения демона.",
        },
        useSavedSecret: {
          title: "Использовать сохранённый секрет",
          subtitle: "Выберите (или добавьте) сохранённый секрет в приложении.",
        },
        enterOnce: {
          title: "Ввести секрет",
          subtitle:
            "Вставьте секрет только для этой сессии (он не будет сохранён).",
        },
      },
      secretEnvVar: {
        title: "Переменная окружения для секрета",
        subtitle:
          "Введите имя переменной окружения, которую этот провайдер ожидает для секрета (например, OPENAI_API_KEY).",
        label: "Имя переменной окружения",
      },
      sections: {
        machineEnvironment: "Окружение машины",
        useOnceTitle: "Использовать один раз",
        useOnceLabel: "Введите секрет",
        useOnceFooter:
          "Вставьте секрет только для этой сессии. Он не будет сохранён.",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "Использовать секрет, который уже есть на машине.",
        },
        useOnceButton: "Использовать один раз (только для сессии)",
      },
    },
    defaultSessionType: "Тип сессии по умолчанию",
    defaultPermissionMode: {
      title: "Режим разрешений по умолчанию",
      descriptions: {
        default: "Запрашивать разрешения",
        acceptEdits: "Авто-одобрять правки",
        plan: "Планировать перед выполнением",
        bypassPermissions: "Пропускать все разрешения",
      },
    },
    aiBackend: {
      title: "Бекенд ИИ",
      selectAtLeastOneError: "Выберите хотя бы один бекенд ИИ.",
      claudeSubtitle: "CLI Claude",
      codexSubtitle: "CLI Codex",
      opencodeSubtitle: "CLI OpenCode",
      geminiSubtitleExperimental: "Gemini CLI (экспериментально)",
      auggieSubtitle: "Auggie CLI",
      qwenSubtitleExperimental: "Qwen Code CLI (экспериментально)",
      kimiSubtitleExperimental: "Kimi CLI (экспериментально)",
      kiloSubtitleExperimental: "Kilo CLI (экспериментально)",
      piSubtitleExperimental: "Pi CLI (экспериментально)",
    },
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Запускать сессии в Tmux",
      spawnSessionsEnabledSubtitle: "Сессии запускаются в новых окнах tmux.",
      spawnSessionsDisabledSubtitle:
        "Сессии запускаются в обычной оболочке (без интеграции с tmux)",
      isolatedServerTitle: "Изолированный сервер tmux",
      isolatedServerEnabledSubtitle:
        "Запускать сессии в изолированном сервере tmux (рекомендуется).",
      isolatedServerDisabledSubtitle:
        "Запускать сессии в вашем tmux-сервере по умолчанию.",
      sessionNamePlaceholder: "Пусто = текущая/последняя сессия",
      tempDirPlaceholder: "Оставьте пустым для автогенерации",
    },
    previewMachine: {
      title: "Предпросмотр машины",
      itemTitle: "Машина предпросмотра для переменных окружения",
      selectMachine: "Выбрать машину",
      resolveSubtitle:
        "Используется только для предпросмотра вычисленных значений ниже (не меняет то, что сохраняется).",
      selectSubtitle:
        "Выберите машину, чтобы просмотреть вычисленные значения ниже.",
    },
    environmentVariables: {
      title: "Переменные окружения",
      addVariable: "Добавить переменную",
      namePlaceholder: "Имя переменной (например, MY_CUSTOM_VAR)",
      valuePlaceholder: "Значение (например, my-value или ${MY_VAR})",
      validation: {
        nameRequired: "Введите имя переменной.",
        invalidNameFormat:
          "Имена переменных должны содержать заглавные буквы, цифры и подчёркивания и не могут начинаться с цифры.",
        duplicateName: "Такая переменная уже существует.",
      },
      card: {
        valueLabel: "Значение:",
        fallbackValueLabel: "Значение по умолчанию:",
        valueInputPlaceholder: "Значение",
        defaultValueInputPlaceholder: "Значение по умолчанию",
        fallbackDisabledForVault:
          "Fallback отключён при использовании хранилища секретов.",
        secretNotRetrieved:
          "Секретное значение — не извлекается из соображений безопасности",
        secretToggleLabel: "Скрыть значение в UI",
        secretToggleSubtitle:
          "Скрывает значение в UI и не извлекает его с машины для предварительного просмотра.",
        secretToggleEnforcedByDaemon: "Принудительно демоном",
        secretToggleEnforcedByVault: "Принудительно хранилищем секретов",
        secretToggleResetToAuto: "Сбросить на авто",
        requirementRequiredLabel: "Обязательно",
        requirementRequiredSubtitle:
          "Блокирует создание сессии, если переменная отсутствует.",
        requirementUseVaultLabel: "Использовать хранилище секретов",
        requirementUseVaultSubtitle:
          "Использовать сохранённый секрет (без fallback-значений).",
        defaultSecretLabel: "Секрет по умолчанию",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `Переопределение документированного значения: ${expectedValue}`,
        useMachineEnvToggle: "Использовать значение из окружения машины",
        resolvedOnSessionStart:
          "Разрешается при запуске сессии на выбранной машине.",
        sourceVariableLabel: "Переменная-источник",
        sourceVariablePlaceholder:
          "Имя переменной-источника (например, Z_AI_MODEL)",
        checkingMachine: ({ machine }: { machine: string }) =>
          `Проверка ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `Пусто на ${machine}`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Пусто на ${machine} (используется значение по умолчанию)`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `Не найдено на ${machine}`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Не найдено на ${machine} (используется значение по умолчанию)`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `Значение найдено на ${machine}`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `Отличается от документированного значения: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} — скрыто из соображений безопасности`,
        hiddenValue: "***скрыто***",
        emptyValue: "(пусто)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `Сессия получит: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `Переменные окружения · ${profileName}`,
        descriptionPrefix:
          "Эти переменные окружения отправляются при запуске сессии. Значения разрешаются демоном на",
        descriptionFallbackMachine: "выбранной машине",
        descriptionSuffix: ".",
        emptyMessage: "Для этого профиля не заданы переменные окружения.",
        checkingSuffix: "(проверка…)",
        detail: {
          fixed: "Фиксированное",
          machine: "Машина",
          checking: "Проверка",
          fallback: "По умолчанию",
          missing: "Отсутствует",
        },
      },
    },
    delete: {
      title: "Удалить Профиль",
      message: ({ name }: { name: string }) =>
        `Вы уверены, что хотите удалить "${name}"? Это действие нельзя отменить.`,
      confirm: "Удалить",
      cancel: "Отмена",
    },
  },
} as const;

export type TranslationsRu = typeof ru;
