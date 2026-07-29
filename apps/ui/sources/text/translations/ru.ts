import { settingsProvidersTranslations } from './settingsProvidersTranslations';
import { providerSessionTranslations } from './providerSessionTranslations';
import { externalSessionOperationTranslations } from './externalSessionOperationTranslations';
import { externalSessionSettingsTranslations } from './externalSessionSettingsTranslations';
import { pluginPermissionTranslations } from './pluginPermissionTranslations';
import { voiceReadinessTranslations } from './voiceReadinessTranslations';
import { voiceProviderPrivacyTranslations } from './voiceProviderPrivacyTranslations';

const mcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle: 'Создайте сервер, импортируйте JSON хоста или установите рекомендуемый пресет.',
  mcpServersHeroSubtitle: ({ configuredCount }: { configuredCount: number }) => `${configuredCount} настроено в Happier`,
  mcpServersHeroSubtitleEmpty:
    'Создайте серверы один раз, просматривайте, где они применяются, и импортируйте то, что уже используют другие инструменты.',
  mcpServersSegmentConfigured: 'Настроено',
  mcpServersSegmentConfiguredSubtitle: 'Ваш каталог Happier',
  mcpServersSegmentDetected: 'Обнаружено',
  mcpServersSegmentDetectedSubtitle: 'Найдено в файлах конфигурации провайдера',
  mcpServersSegmentPreview: 'Предпросмотр',
  mcpServersSegmentPreviewSubtitle: 'Что получит эта сессия',
  mcpServersAdvancedTitle: 'Дополнительно',
  mcpServersAdvancedSubtitle: 'Строгий режим и поведение проверки',
  mcpServersDetectedDirectoryTitle: 'Каталог проекта',
  mcpServersDetectedDirectorySubtitle: 'Необязательный путь к рабочему пространству для конфигураций уровня проекта',
  mcpServersDetectedDirectoryPlaceholder: '/путь/к/проекту',
  mcpServersPreviewAgentTitle: 'Бэкенд',
  mcpServersPreviewMachineTitle: 'Машина',
  mcpServersPreviewDeliveryTitle: 'Доставка инструментов',
  mcpServersPreviewDirectoryTitle: 'Каталог рабочего пространства',
  mcpServersPreviewDirectorySubtitle: 'Выберите папку, в которой планируете начать сессию',
  mcpServersPreviewDirectoryPlaceholder: '/путь/к/рабочему-пространству',
  mcpServersPreviewRefreshTitle: 'Обновить предпросмотр',
  mcpServersPreviewRefreshSubtitle: 'Определить MCP-серверы Happier и нативные MCP-серверы провайдера для этого контекста',
  mcpServersPreviewEmptyTitle: 'Пока нет предпросмотра',
  mcpServersPreviewEmptySubtitle: 'Выберите бэкенд, машину и каталог, затем обновите, чтобы проверить итоговый набор MCP.',
  mcpServersPreviewDirectoryRequired: 'Выберите каталог для предпросмотра этой сессии.',
  mcpServersBuiltInDescription: 'Всегда доступно в сессиях Happier.',
  mcpServersSourceHappier: 'Happier',
  mcpServersSourceBuiltIn: 'Встроенный',
  mcpServersSourceDetected: 'Обнаружено',
  mcpServersQuickInstallTitle: 'Быстрая установка',
  mcpServersQuickInstallSubtitle: 'Установите распространённые MCP-серверы для разработчиков в один шаг.',
  mcpServersQuickInstallAction: 'Установить',
  mcpServersQuickInstallEmptyTitle: 'Выберите пресет',
  mcpServersQuickInstallEmptySubtitle: 'Выберите один из рекомендуемых MCP-серверов, чтобы продолжить.',
  mcpServersEditAction: 'Редактировать',
  mcpServersDeleteAction: 'Удалить',
  mcpServersAddServerFlowSubtitle: 'Настройте сервер вручную, импортируйте JSON хоста или начните с подобранного пресета.',
  mcpServersAddFlowConfigureTitle: 'Настроить',
  mcpServersAddFlowConfigureSubtitle: 'Ручная настройка',
  mcpServersAddFlowImportJsonTitle: 'Импортировать JSON',
  mcpServersAddFlowImportJsonSubtitle: 'Вставить конфигурацию хоста',
  mcpServersAddFlowQuickInstallTitle: 'Быстрая установка',
  mcpServersAddFlowQuickInstallSubtitle: 'Подобранные пресеты',
  mcpServersFieldCommandLine: 'Командная строка',
  mcpServersFieldCommandLinePlaceholder: 'npx -y @modelcontextprotocol/server-playwright',
  mcpServersTransportLocalTitle: 'Локальная команда',
  mcpServersTransportLocalSubtitle: 'Выполняется на выбранной машине',
  mcpServersTransportHttpTitle: 'Удалённый HTTP',
  mcpServersTransportHttpSubtitle: 'Мост из HTTP-эндпоинта',
  mcpServersTransportSseTitle: 'Удалённый SSE',
  mcpServersTransportSseSubtitle: 'Мост из событий, отправляемых сервером',
  mcpServersAdvancedCommandEditorTitle: 'Расширенный редактор команды',
  mcpServersAdvancedCommandEditorSubtitle: 'Разделите команду и аргументы вручную',
  mcpServersCancelSubtitle: 'Выйти без сохранения этого черновика',
  mcpServersImportJsonTitle: 'Вставьте JSON хоста MCP',
  mcpServersImportJsonSubtitle: 'Мы поддерживаем распространённые форматы из README и настольных хостов.',
  mcpServersImportJsonPlaceholder: '{"mcpServers":{"проверка":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: 'Ошибка импорта',
  mcpServersImportJsonWarningsTitle: 'Предупреждения импорта',
  mcpServersImportJsonEmptyTitle: 'Серверы ещё не распознаны',
  mcpServersImportJsonEmptySubtitle: 'Вставьте JSON MCP-хоста, чтобы просмотреть серверы перед импортом.',
  mcpServersImportJsonAction: 'Импортировать серверы',
  mcpServersImportMappingSavedSecret: 'Использовать сохранённый секрет',
  mcpServersImportMappingMachineEnv: 'Использовать переменные окружения машины',
  mcpServersImportSecretNamePlaceholder: 'Имя сохранённого секрета',
  mcpServersImportSecretValuePlaceholder: 'Значение сохранённого секрета',
  mcpServersImportMachineEnvPlaceholder: 'ENV_VAR_NAME',
  mcpServersImportMappingMissingSecretName: ({ input }: { input: string }) => `Введите имя сохранённого секрета для ${input}.`,
  mcpServersImportMappingMissingSecretValue: ({ input }: { input: string }) =>
    `Введите значение сохранённого секрета для ${input} или переключитесь на переменные окружения машины.`,
  mcpServersImportMappingMissingMachineEnvName: ({ input }: { input: string }) => `Введите имя переменной окружения машины для ${input}.`,
  mcpServersAuthSavedSecret: 'Сохранённый секрет',
  mcpServersAuthMachineEnv: 'Переменные окружения машины',
  mcpServersAuthPlainText: 'Обычный текст',
  mcpServersAuthUnknown: 'Неизвестная аутентификация',
  mcpServersAuthNone: 'Нет аутентификации',
  mcpServersScopeAllMachines: 'Все машины',
  mcpServersScopeMachine: 'Машина',
  mcpServersScopeWorkspace: 'Рабочее пространство',
  mcpServersScopeProviderProject: 'Конфигурация проекта провайдера',
  mcpServersScopeProviderUser: 'Пользовательская конфигурация провайдера',
  mcpServersScopeBuiltIn: 'Встроенный',
  mcpServersStatusActive: 'Активно',
  mcpServersStatusAvailable: 'Доступно',
  mcpServersStatusUnavailable: 'Недоступно',
  mcpServersStatusDetected: ({ provider }: { provider: string }) => `Включено в ${provider}`,
  mcpServersStatusDisabledInProvider: ({ provider }: { provider: string }) => `Отключено в ${provider}`,
  mcpServersEditorAppliesTo: 'Применяется к',
  mcpServersEditorAppliesToSubtitle: 'Выберите, куда Happier должен добавлять этот сервер по умолчанию.',
  mcpServersAddApplyRule: 'Добавить правило применения',
  mcpServersAddApplyRuleSubtitle: 'Выберите, где этот сервер должен применяться по умолчанию.',
  mcpServersAddApplyRuleHelp: 'Сохраните это правило применения, чтобы включить его в эту конфигурацию сервера.',
  mcpServersAddApplyRuleSave: 'Сохранить правило применения',
  mcpServersDeliveryNativeTitle: 'Нативный MCP',
  mcpServersDeliveryNativeSubtitle: 'Этот бэкенд получает инструменты Happier как нативные MCP-серверы.',
  mcpServersDeliveryShellBridgeTitle: 'Оболочечный мост Happier',
  mcpServersDeliveryShellBridgeSubtitle: 'Этот бэкенд вызывает инструменты Happier через мост `happier tools`.',
  mcpServersDeliveryUnsupportedTitle: 'Не поддерживается',
  mcpServersDeliveryUnsupportedSubtitle: 'Этот бэкенд пока не получает инструменты Happier.',
} as const;

const newSessionMcpTranslationExtension = {
  mcpChipLabel: 'MCP',
  mcpChipLabelWithCount: ({ count }: { count: number }) => `MCP ${count}`,
  mcpModalTitle: 'Серверы MCP',
  mcpModalSubtitle: ({ machineName, directory }: { machineName: string; directory: string }) =>
    `Просмотрите серверы MCP, доступные на ${machineName} для ${directory}.`,
  mcpManagedToggleTitle: 'Управляемые серверы MCP',
  mcpManagedToggleSubtitle: 'Включать управляемые серверы MCP, когда они доступны для этой сессии.',
  mcpOpenSettingsTitle: 'Открыть настройки MCP',
  mcpOpenSettingsSubtitle: 'Управляйте настроенными серверами, привязками и параметрами импорта.',
  mcpUnavailableNoContextTitle: 'Сначала выберите машину и директорию',
  mcpUnavailableNoContextSubtitle: 'Для предварительного просмотра MCP нужны и целевая машина, и рабочая директория.',
  mcpSelectedSectionTitle: 'Выбрано',
  mcpAvailableSectionTitle: 'Доступно',
  mcpUnavailableSectionTitle: 'Недоступно',
  mcpDetectedSectionTitle: 'Обнаружено в конфигурациях провайдеров',
  mcpDetectedSectionTitleForAgent: ({ agentName }: { agentName: string }) => `Обнаружено в конфигурации ${agentName}`,
  mcpDetectedEmptyTitle: 'Нет обнаруженных MCP серверов',
  mcpDetectedEmptySubtitle: 'Обновите, чтобы просканировать конфигурации провайдеров на этой машине.',
  mcpDetectedUnsupportedTitle: 'Обнаруженные MCP серверы недоступны',
  mcpDetectedUnsupportedSubtitle: 'Обновите Happier на этой машине, чтобы включить сканирование конфигураций провайдера.',
  mcpHappierSectionTitle: 'Серверы MCP Happier',
  mcpHappierEmptyTitle: 'В Happier не определены серверы MCP',
  mcpHappierEmptySubtitle: 'Определите серверы MCP в настройках, чтобы использовать их в сессиях.',
  mcpReasonActiveByDefault: 'Включено по умолчанию',
  mcpReasonForcedIncluded: 'Требуется конфигурацией',
  mcpReasonForcedExcluded: 'Исключено конфигурацией',
  mcpReasonManagedDisabled: 'Управляемые серверы MCP отключены',
  mcpReasonBindingDisabled: 'Отключено привязкой сервера',
  mcpReasonAvailablePortable: 'Подходит для этой сессии',
  mcpReasonNotPortable: 'Не подходит для этой сессии',
} as const;

const settingsAppearanceTranslationExtension = {
  themeProfiles: {
    title: 'Themes',
    editorTitle: 'Theme profile',
    activeGroup: 'Active theme',
    activeFooter: 'Choose the theme used by the interface. Manage custom themes from the themes screen.',
    builtInGroup: 'Built-in themes',
    builtInFooter: 'Built-in themes are read-only. Duplicate one to customize it locally.',
    customGroup: 'Custom themes',
    customFooter: 'Tap a theme to activate it, or use row actions to edit, duplicate, or delete it.',
    defaultTheme: 'Default theme',
    defaultThemeSubtitle: 'Use Happier theme colors without a custom profile',
    active: 'Active',
    customProfileSubtitle: 'Custom local theme profile',
    tapToActivate: 'Tap to activate',
    actionsGroup: 'Theme actions',
    createProfile: 'Create theme',
    createProfileSubtitle: 'Start from any built-in or custom theme',
    importProfile: 'Import theme',
    importProfileSubtitle: 'Paste JSON or choose a Happier theme profile file',
    exportProfile: 'Export theme',
    exportProfileSubtitle: 'Export this theme as JSON',
    presetsGroup: 'Built-in presets',
    presetsFooter: 'Built-in profiles are read-only. Clone one to customize it.',
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
    readOnlyPreset: 'Read-only preset',
    clonePreset: 'Clone preset',
    cloneProfile: 'Clone profile',
    duplicateTheme: 'Duplicate theme',
    editProfile: 'Edit profile',
    newProfileName: ({ count }: { count: number }) => `Custom theme ${count}`,
    cloneName: ({ name }: { name: string }) => `${name} copy`,
    detailsGroup: 'Details',
    presetGroup: 'Preset',
    presetSource: 'Preset',
    presetSourceSubtitle: 'Choose a theme to use as the starting point',
    assetAppearance: 'Asset appearance',
    assetAppearanceSubtitle: 'Choose whether this theme uses light or dark app assets.',
    replacePresetTitle: 'Replace current colors?',
    replacePresetSubtitle: 'Changing preset will replace the current draft colors. Unsaved color edits will be discarded.',
    profileName: 'Profile name',
    editorModeGroup: 'Theme mode',
    editorModeFooter: 'This theme edits the color mode selected by its preset.',
    editorMode: 'Variant',
    lightMode: 'Light',
    darkMode: 'Dark',
    previewTitle: 'Theme preview',
    previewSubtitle: 'A local sandbox preview of surfaces, text, controls, state, and syntax colors.',
    previewButton: 'Primary action',
    previewStatus: 'Ready',
    previewCode: 'const theme = "happier";',
    colorInputPlaceholder: '#RRGGBB, rgba(...), transparent',
    tokenSubtitle: 'Public color token override',
    recentColors: 'Recent colors',
    colorPickerFallback: 'Enter a color value or reuse a recent color.',
    invalidColor: 'Use hex, rgb(...), rgba(...), or transparent.',
    invalidProfileName: 'Invalid profile name.',
    profileLimitReached: 'Theme limit reached.',
    contrastWarning: 'Low contrast for this token pair. You can still save or reset.',
    resetToken: 'Reset token',
    resetGroup: 'Reset and deactivate',
    resetMode: 'Reset theme colors',
    deactivateProfile: 'Use default theme',
    deactivateProfileSubtitle: 'Deactivate the custom profile and keep it saved',
    deleteProfile: 'Delete profile',
    deleteProfileSubtitle: 'Remove this local custom theme profile',
    saveAndActivate: 'Save & Activate',
    missingProfile: 'Theme profile not found',
    importFooter: ({ formats }: { formats: string }) => `Supported formats: ${formats}. Unknown tokens are reported as warnings.`,
    importJson: 'Theme JSON',
    importJsonPlaceholder: "Paste your theme's JSON here",
    importFile: 'Choose file',
    importWarnings: ({ count }: { count: number }) => `${count} warning(s) were found while importing.`,
    importErrors: {
      invalidJson: 'The pasted text is not valid JSON.',
      unsupportedSchema: 'This theme profile version is not supported.',
      invalidProfile: 'This theme profile could not be imported.',
      tooLarge: 'This theme profile JSON is too large.',
    },
    exportFooter: 'Exported JSON includes all public color token values for this theme.',
    exportJson: 'Export JSON',
    copyExportJson: 'Copy JSON',
    downloadExportJson: 'Download JSON',
    noProfiles: 'No custom themes yet',
    groups: {
      background: 'Background',
      surface: 'Surfaces',
      border: 'Borders',
      effect: 'Effects',
      chrome: 'Chrome',
      text: 'Text',
      state: 'Состояние',
      control: 'Controls',
      composer: 'Composer',
      message: 'Messages',
      syntax: 'Syntax',
      versionControl: 'Version control',
      diff: 'Diffs',
      permission: 'Permissions',
      overlay: 'Overlays',
    },
  },
  sessionListDensity: {
    title: 'Плотность списка сессий',
    subtitle: 'Выберите, как сессии отображаются на боковой панели',
    detailed: 'Подробная',
    detailedDescription: 'Полноразмерные строки с аватарами и статусом',
    cozy: 'Средняя',
    cozyDescription: 'Более компактные строки с аватарами',
    narrow: 'Узкая',
    narrowDescription: 'Узкие строки с микроаватарами',
  },
} as const;

const acpCatalogTranslationExtension = {
  settings: {
    acpCatalog: 'ACP-бэкенды',
    acpCatalogSubtitle: 'Управляйте встроенными и пользовательскими ACP-бэкендами',
    acpCatalogBuiltIn: 'Встроенный ACP',
    acpCatalogBuiltInFooter:
      'Встроенные универсальные агенты ACP определены в общем каталоге и запускаются через общую среду выполнения ACP.',
    acpCatalogBackends: 'Пользовательские бэкенды',
    acpCatalogBackendsFooter:
      'Каждый пользовательский бэкенд — это выбираемая CLI-конфигурация, совместимая с ACP, со своим запуском, настройками по умолчанию и параметрами аутентификации.',
    acpCatalogBackendsEmptyTitle: 'Пользовательских ACP-бэкендов нет',
    acpCatalogBackendsEmptySubtitle: 'Добавьте бэкенд, чтобы создать доступный для выбора пользовательский ACP-бэкенд.',
    acpCatalogAddBackend: 'Добавить ACP-бэкенд',
    acpCatalogAddBackendSubtitle: 'Создать пользовательский ACP-бэкенд',
    acpCatalogBackendEditorTitle: 'ACP-бэкенд',
    acpCatalogBasics: 'Основное',
    acpCatalogLauncher: 'Запуск',
    acpCatalogEnv: 'Окружение',
    acpCatalogAddEnv: 'Добавить переменную окружения',
    acpCatalogAddEnvSubtitle: 'Сохраняйте литеральные значения или привязывайте сохранённые секреты',
    acpCatalogEnvEmptyTitle: 'Нет переменных окружения',
    acpCatalogEnvEmptySubtitle: 'Добавьте переменные запуска для этого бэкенда.',
    acpCatalogAuth: 'Аутентификация',
    acpCatalogAuthSupport: 'Поддержка аутентификации',
    acpCatalogAuthParser: 'Парсер статуса',
    acpCatalogCapabilities: 'Возможности',
    acpCatalogTransportProfile: 'Профиль транспорта',
    acpCatalogSupportsModes: 'Поддержка режимов',
    acpCatalogSupportsModels: 'Поддержка моделей',
    acpCatalogSupportsConfigOptions: 'Поддержка параметров конфигурации',
    acpCatalogPromptImageSupport: 'Поддержка изображений в промпте',
    acpCatalogFieldId: 'ID',
    acpCatalogFieldName: 'Имя',
    acpCatalogFieldTitle: 'Название',
    acpCatalogFieldDescription: 'Описание',
    acpCatalogFieldCommand: 'Команда',
    acpCatalogFieldArgs: 'Аргументы (по одному на строку)',
    acpCatalogMachineLoginKey: 'Ключ входа на машине',
    acpCatalogDocsUrl: 'URL документации',
    acpCatalogLoginCommand: 'Команда входа',
    acpCatalogLoginArgs: 'Аргументы входа (по одному на строку)',
    acpCatalogStatusCommand: 'Токены команды статуса (по одному на строку)',
    acpCatalogDefaultMode: 'Режим по умолчанию',
    acpCatalogDefaultModel: 'Модель по умолчанию',
    acpCatalogDeleteBackendTitle: 'Удалить ACP-бэкенд?',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `Удалить «${name}»?`,
    acpCatalogValidationFailed: 'Настройки каталога ACP недействительны.',
  },
  newSession: {},
} as const;

const memoryEmbeddingsTranslationExtension = {
  status: {
    embeddingsTitle: 'Среда выполнения эмбеддингов',
    embeddingsProviderTitle: 'Провайдер эмбеддингов',
    embeddingsModelTitle: 'Модель эмбеддингов',
    embeddingsDisabled: 'Эмбеддинги отключены',
    embeddingsReady: 'Эмбеддинги готовы',
    embeddingsDownloading: 'Загрузка модели эмбеддингов',
    embeddingsFallback: 'Эмбеддинги недоступны; используется режим только текста',
    embeddingsUnavailable: 'Эмбеддинги недоступны',
    embeddingsError: 'Не удалось инициализировать эмбеддинги',
    embeddingsProviderLocal: 'Локальная модель',
    embeddingsProviderOpenAiCompatible: 'Эндпоинт, совместимый с OpenAI',
  },
  embeddings: {
    groupTitle: 'Эмбеддинги',
    groupFooter:
      'Необязательно: улучшите ранжирование глубокого поиска с помощью локальной модели или собственного эндпоинта, совместимого с OpenAI.',
    mode: {
      title: 'Режим эмбеддингов',
      options: {
        disabledTitle: 'Выкл.',
        disabledSubtitle: 'Использовать только текстовое ранжирование для глубокого поиска',
        balancedTitle: 'Сбалансированный',
        balancedSubtitle: 'Быстрый проверенный локальный пресет',
        longContextTitle: 'Длинный контекст',
        longContextSubtitle: 'Лучше для более крупных фрагментов беседы',
        qualityTitle: 'Качество',
        qualitySubtitle: 'Более дорогой локальный пресет для оценки',
        customTitle: 'Пользовательский',
        customSubtitle: 'Выберите своего провайдера и модель',
      },
    },
    provider: {
      title: 'Провайдер',
      options: {
        localTitle: 'Локальная модель',
        localSubtitle: 'Управляется Happier и загружается при первом использовании',
        openAiCompatibleTitle: 'Эндпоинт, совместимый с OpenAI',
        openAiCompatibleSubtitle: 'Используйте свой сервер эмбеддингов и API‑ключ',
      },
    },
    notSet: 'Не задано',
    secretSet: 'Задано',
    secretNotSet: 'Не задано',
    queryPrefixTitle: 'Префикс запроса',
    queryPrefixPromptBody:
      'Необязательный префикс, добавляемый к поисковым запросам пользователя перед построением эмбеддингов.',
    documentPrefixTitle: 'Префикс документа',
    documentPrefixPromptBody:
      'Необязательный префикс, добавляемый к индексированным фрагментам памяти перед построением эмбеддингов.',
    openAi: {
      baseUrlTitle: 'Базовый URL',
      baseUrlPromptBody: 'Введите базовый URL для вашего эндпоинта эмбеддингов, совместимого с OpenAI.',
      modelTitle: 'Удалённая модель',
      modelPromptBody: 'Введите id модели эмбеддингов для запроса к удалённому эндпоинту.',
      apiKeyTitle: 'API-ключ',
      apiKeyPromptBody: 'Введите API‑ключ, используемый для удалённого эндпоинта эмбеддингов.',
      dimensionsTitle: 'Размерность',
      dimensionsPromptBody: 'Необязательное переопределение размерности вывода для эндпоинтов, которые это поддерживают.',
    },
    advanced: {
      ftsWeightTitle: 'Вес текстового ранжирования',
      ftsWeightPromptBody: 'Относительный вес полнотекстового ранжирования SQLite при объединении результатов.',
      embeddingWeightTitle: 'Вес ранжирования эмбеддингов',
      embeddingWeightPromptBody: 'Относительный вес сходства эмбеддингов при объединении результатов.',
    },
  },
} as const;

const promptLibraryUxRefinementTranslationExtension = {
  ru: {
    promptsSubtitle: 'Переиспользуемые документы промптов',
    skillsSubtitle: 'Переиспользуемые пакеты навыков',
    addPrompt: 'Добавить новый промпт',
    addPromptSubtitle: 'Создать новый документ промпта',
    addSkill: 'Добавить новый навык',
    addSkillSubtitle: 'Создать новый пакет навыка',
    newTemplateSubtitle: 'Создать переиспользуемый slash-шаблон',
    noPrompts: 'Промптов пока нет',
    noPromptsSubtitle: 'Создайте промпт, чтобы начать использовать шаблоны и дополнения к системному промпту.',
    noSkills: 'Навыков пока нет',
    noSkillsSubtitle: 'Создайте пакет навыка, чтобы переиспользовать инструкции из SKILL.md.',
    imported: 'Импортировано',
    builtIn: 'Встроенное',
    general: 'Общее',
    promptNameLabel: 'Название промпта',
    promptContent: 'Содержимое промпта',
    skillNameLabel: 'Название навыка',
    skillContent: 'Содержимое SKILL.md',
    supportingFiles: 'Вспомогательные файлы',
    supportingFilesEmptyTitle: 'Вспомогательных файлов пока нет',
    supportingFilesEmptySubtitle: 'Добавьте переиспользуемые файлы, чтобы экспортировать их вместе с этим навыком.',
    supportingFilesSaveFirstTitle: 'Сначала сохраните этот навык',
    supportingFilesSaveFirstSubtitle: 'Сначала создайте навык, а затем добавляйте вспомогательные файлы.',
    addSupportingFile: 'Добавить вспомогательный файл',
    addSupportingFileSubtitle: 'Создать еще один файл в этом пакете навыка',
    editSupportingFile: 'Редактировать вспомогательный файл',
    newSupportingFile: 'Новый вспомогательный файл',
    supportingFilePathLabel: 'Путь к файлу',
    supportingFilePathPlaceholder: 'templates/review.md',
    supportingFileContent: 'Содержимое файла',
    supportingFileTextSubtitle: 'Текстовый файл',
    supportingFileBinarySubtitle: 'Бинарный файл · только экспорт',
    deleteSupportingFileTitle: 'Удалить вспомогательный файл?',
    deleteSupportingFileConfirm: 'Это удалит файл из пакета навыка.',
    linkedAssetsCount: ({ count }: { count: number }) => `${count} экспорт${count === 1 ? '' : 'ов'}`,
    manageExternalAssets: 'Управлять внешними ресурсами',
    deleteLibraryItemTitle: 'Удалить элемент библиотеки?',
    deleteLibraryItemBody:
      'Это удалит элемент из библиотеки и отвяжет шаблоны или дополнения к системному промпту, которые на него ссылаются.',
    folders: 'Папки',
    foldersSubtitle: 'Организуйте промпты и навыки по именованным папкам',
    addFolder: 'Добавить папку',
    addFolderSubtitle: 'Создайте папку для элементов библиотеки',
    foldersEmptyTitle: 'Папок пока нет',
    foldersEmptySubtitle: 'Создайте папку, чтобы упорядочить промпты и навыки.',
    renameFolder: 'Переименовать папку',
    deleteFolderTitle: 'Удалить папку?',
    deleteFolderBody: 'Это снимет назначение папки у промптов и навыков, которые её используют.',
    folderUsageCount: ({ count }: { count: number }) => `${count} элемент${count === 1 ? '' : 'ов'}`,
    folderLabel: 'Папка',
    folderPlaceholder: 'Название папки',
    tagsLabel: 'Теги',
    tagsPlaceholder: 'тег-один, тег-два',
    addToStackSubtitle: 'Выберите промпт или навык, чтобы добавить сюда',
    externalAssetsImportAction: 'Импортировать',
    externalAssetsLinkedTo: ({ title }: { title: string }) => `Связано с ${title}`,
    externalAssetsExportTarget: 'Назначение',
    externalAssetsInstallMethod: 'Способ установки',
    externalAssetsInstallMethodCopy: 'Копировать файлы',
    externalAssetsInstallMethodCopySubtitle: 'Записывает отдельную копию в выбранное место назначения',
    externalAssetsInstallMethodSymlink: 'Символическая ссылка (рекомендуется)',
    externalAssetsInstallMethodSymlinkSubtitle:
      'Связывает место назначения с копией под управлением Happier для более простых обновлений',
    registriesAddGitSourceSubtitle: 'Добавьте Git-репозиторий или локальную копию как источник реестра',
    registriesSourceTitleLabel: 'Название источника',
    registriesSourceUrlLabel: 'URL репозитория или локальный путь',
    registriesSearchLabel: 'Поиск в реестре',
    registriesSearchPlaceholder: 'Ищите навыки (например: design)',
    registriesItemSource: 'Исходный репозиторий',
    registriesItemPath: 'Путь в реестре',
    registriesItemFiles: 'Вспомогательные файлы',
    registriesItemPreview: 'Предпросмотр SKILL.md',
    registriesItemPreviewUnavailable: 'Для этого элемента реестра недоступен предпросмотр SKILL.md.',
    registriesItemImportSubtitle: 'Импортируйте этот пакет навыка в библиотеку Happier',
    registriesItemInstallAction: 'Установить на машину',
    registriesItemInstallConfirmTitle: 'Установить элемент реестра?',
    registriesItemInstallConfirmBody: 'Это импортирует навык в вашу библиотеку и установит его в выбранное место на машине.',
    templateTargetPromptLabel: 'Промпт',
    templateTargetPromptPlaceholder: 'Выберите промпт',
    editSelectedPrompt: 'Редактировать выбранный промпт',
    editSelectedPromptDisabled: 'Сначала выберите промпт',
    templateNameLabel: 'Название шаблона',
    templateTokenLabel: 'Slash-команда',
    templatesEmptyTitle: 'Шаблонов пока нет',
    templatesEmptySubtitle: 'Создайте slash-шаблон, чтобы быстро вставлять промпты.',
    librarySearchPlaceholder: 'Поиск в библиотеке',
  },
} as const;

const sessionHandoffTranslationExtensions = {
  ru: {
    activeWarning: {
      title: 'Этот сеанс все еще запущен на этом устройстве',
      message: 'Перед передачей на выбранное устройство Happier остановит этот сеанс на текущем устройстве.',
      confirm: 'Передать и остановить здесь',
    },
    progress: {
      title: 'Передача сессии',
      message: 'Подготавливаем целевую машину и переносим состояние сессии.',
      planned: 'Запланировано',
      transferred: 'Передано',
      remaining: 'Осталось',
      timeline: {
        scanSource: 'Сканирование источника',
        plan: 'Планирование изменений',
        transferBlobs: 'Передача файлов',
        stageTarget: 'Подготовка цели',
        apply: 'Применение изменений',
        importSession: 'Импорт сессии',
        finalize: 'Завершение',
      },
    },
    failure: {
      title: 'Не удалось передать сессию',
      message: 'Не удалось завершить передачу. Вы можете повторить попытку.',
    },
    recovery: {
      title: 'Сеанс был остановлен здесь до завершения передачи',
      messageAfterSourceStop:
        'Happier уже остановил этот сеанс на текущем устройстве, но не смог завершить запуск на целевом устройстве. Перезапустите его здесь или оставьте остановленным, пока восстанавливаете целевое устройство.',
      restartOnSource: 'Перезапустить на исходной машине',
      keepStopped: 'Оставить остановленной',
    },
  },
} as const;

const settingsSessionHandoffTranslationExtensions = {
  ru: {
    title: 'Передача сессии',
    groupTitle: 'Передача сессии',
    groupFooter: 'Выберите параметры по умолчанию для переноса сессии между машинами.',
    entrySubtitle: 'Открыть настройки передачи',
    workspaceTransfer: {
      groupTitle: 'Передача рабочей области',
      groupFooter: 'Решите, нужно ли при передаче копировать рабочую область и как по умолчанию обрабатывать конфликты.',
      title: 'Переносить рабочую область',
      enabledSubtitle: 'По умолчанию копировать рабочую область на целевую машину.',
      disabledSubtitle: 'По умолчанию не изменять рабочую область на целевой машине.',
      strategy: {
        title: 'Стратегия передачи рабочей области',
        subtitle: 'Выберите полный снимок рабочей области или синхронизацию только изменений.',
        transferSnapshotTitle: 'Передать снимок',
        transferSnapshotSubtitle: 'Экспортировать и перенести полный снимок рабочей области.',
        syncChangesTitle: 'Синхронизировать изменения',
        syncChangesSubtitle: 'Сравнить исходную и целевую рабочие области и применить только нужные односторонние изменения.',
      },
    },
    conflictPolicy: {
      title: 'Политика конфликтов рабочей области',
      subtitle: 'Выберите, что делать, если целевой путь уже существует.',
      createSiblingCopyTitle: 'Создать соседнюю копию',
      createSiblingCopySubtitle: 'Сохранить существующий целевой путь и создать соседнюю копию для передачи.',
      replaceExistingTitle: 'Заменить существующий путь',
      replaceExistingSubtitle: 'Заменить существующий целевой путь после подтверждения.',
    },
    includeIgnoredMode: {
      title: 'Игнорируемые файлы',
      subtitle: 'Выберите, как обрабатывать git-ignored файлы при передаче рабочей области.',
      excludeTitle: 'Исключать игнорируемые файлы',
      excludeSubtitle: 'По умолчанию пропускать игнорируемые файлы.',
      includeSelectedTitle: 'Включать выбранные игнорируемые файлы',
      includeSelectedSubtitle: 'Копировать только игнорируемые пути, которые соответствуют настроенным glob-маскам.',
      globsTitle: 'Glob-маски для включения игнорируемых файлов',
      globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
      title: 'Режим цели для direct-сессии',
      subtitle: 'Выберите, что делать при передаче direct-сессии.',
      groupTitle: 'Передача direct-сессии',
      groupFooter: 'Применяется только когда исходная сессия сейчас прямая.',
      keepDirectTitle: 'Оставить прямой',
      keepDirectSubtitle: 'Возобновить целевую сессию как прямую, если провайдер это поддерживает.',
      convertToPersistedTitle: 'Преобразовать в Happier',
      convertToPersistedSubtitle: 'Импортируйте стенограмму и продолжите как сеанс Happier.',
    },
  },
} as const;

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
export const ru = {
    transferRecovery: {
        title: 'Завершить подготовленную загрузку',
        message: 'Файл загружен на машину, но финальное сохранение требует внимания. Повторите только завершение или удалите подготовленную загрузку.',
        retryFinalization: 'Повторить завершение',
        discardStagedUpload: 'Удалить подготовленную загрузку',
        discarded: 'Подготовленная загрузка удалена.',
        unavailable: 'Эта подготовленная загрузка больше недоступна.',
    },
    voice: voiceReadinessTranslations.ru,
    pluginPermissions: pluginPermissionTranslations.ru,
    pluginSurfaces: {
        offlineSnapshot: {
            accessibilityLabel: ({ title }: { title: string }) =>
                `Офлайн-снимок ${title}. До повторного подключения содержимое доступно только для чтения.`,
        },
        hostRenderer: {
            descriptorPanel: {
                accessibilityLabel: 'Панель плагина',
                untitled: 'Панель плагина',
            },
        },
        appScopeRightSidebar: {
            empty: 'Нет доступных вкладок плагинов приложения.',
        },
    },
    settingsKeyboard: {
        title: 'Keyboard shortcuts',
        entrySubtitle: 'Discover and control app shortcuts',
        generalGroupTitle: 'Keyboard controls',
        generalGroupFooter: 'Shortcut preferences are stored locally on this device.',
        enableShortcutsTitle: 'Enable unified shortcuts',
        enableShortcutsSubtitle: 'Use the new keyboard command registry for app shortcuts.',
        singleKeyTitle: 'Single-key shortcuts',
        singleKeySubtitle: 'Allow shortcuts such as ? when text input is not focused.',
        conflictsTitle: ({ count }: { count: number }) => `${count} shortcut conflict${count === 1 ? '' : 's'} detected`,
        conflictsSubtitle: ({ count }: { count: number }) => `${count} command${count === 1 ? '' : 's'} need review before all shortcuts can be active.`,
        conflictsGroupTitle: 'Diagnostics',
        commandsGroupTitle: 'Commands',
        commandsGroupFooter: 'Defaults are shown from the shortcut registry. Set a custom shortcut, disable a command, or reset it to recover the default binding.',
        noDefaultShortcut: 'No default shortcut',
        setCommandButton: 'Set',
        setCommandAccessibility: ({ command }: { command: string }) => `Set ${command} shortcut`,
        setShortcutPromptTitle: ({ command }: { command: string }) => `Set shortcut for ${command}`,
        setShortcutPromptMessage: 'Enter a shortcut such as Alt+K, Alt+ArrowDown, Mod+Enter, or ?.',
        setShortcutPromptPlaceholder: 'Alt+K',
        setShortcutInvalidTitle: 'Invalid shortcut',
        setShortcutInvalidMessage: 'Enter at least one non-modifier key, optionally with Mod, Ctrl, Shift, or Alt.',
        resetCommandAccessibility: ({ command }: { command: string }) => `Reset ${command} shortcut`,
        commands: {
            composerAbortConfirm: 'Подтвердить остановку',
            composerFocus: 'Перейти к вводу',
            composerSendImmediate: 'Отправить сразу',
            composerSendPending: 'Отправить в очередь ожидания',
            commandPaletteOpen: 'Открыть палитру команд',
            modeCycle: 'Переключить режим',
            shortcutsHelpOpen: 'Открыть справку по сочетаниям',
            sessionNew: 'Создать новый сеанс',
            sessionMruNext: 'Следующий недавний сеанс',
            sessionMruPrevious: 'Предыдущий недавний сеанс',
            sessionVisibleNext: 'Следующий видимый сеанс',
            sessionVisiblePrevious: 'Предыдущий видимый сеанс',
            sessionsRowMoveUp: 'Move selected row up',
            sessionsRowMoveDown: 'Move selected row down',
            sessionsRowMoveToFolder: 'Move selected row to folder',
            sessionsRowMoveToWorkspaceRoot: 'Move selected row to workspace root',
            sessionsSelectionToggleFocused: 'Select focused session',
            sessionsSelectionExtendUp: 'Extend session selection up',
            sessionsSelectionExtendDown: 'Extend session selection down',
            sessionsSelectionSelectAll: 'Select all visible sessions',
            sessionsSelectionClear: 'Clear session selection',
            settingsOpen: 'Открыть настройки',
            transcriptSelectionCancel: 'Cancel transcript selection',
            transcriptSelectionCopy: 'Copy selected transcript messages',
            transcriptSelectionSelectAll: 'Select all transcript messages',
            transcriptSelectionSendToSession: 'Send selected transcript messages to session',
            transcriptScrollBottom: 'К концу стенограммы',
            transcriptScrollPageDown: 'Прокрутить стенограмму на страницу вниз',
            transcriptScrollPageUp: 'Прокрутить стенограмму на страницу вверх',
            transcriptScrollTop: 'К началу стенограммы',

            permissionCycle: "Cycle permission mode",
            splitCanvasCloseLeaf: "Close split",
            splitCanvasFocusDown: "Focus split below",
            splitCanvasFocusLeft: "Фокус на раздел слева",
            splitCanvasFocusRight: "Фокус на раздел справа",
            splitCanvasFocusUp: "Фокус на раздел выше",
            splitCanvasRestoreMaximize: "Восстановить развёрнутый раздел",
            splitCanvasSplitDown: "Разделить вниз",
            splitCanvasSplitRight: "Разделить вправо",
            splitCanvasToggleMaximize: "Переключить разворачивание раздела",
            transcriptMessageNext: "Следующее сообщение",
            transcriptMessagePrevious: "Предыдущее сообщение",},
    },

  tabs: {
    // Tab navigation labels
    inbox: "Входящие",
    friends: "Друзья",
    sessions: "Сессии",
    settings: "Настройки",

    projects: "Проекты",},

  transcript: {


    unsupportedContent: {

      unparsedUserMessage: 'Нераспознанное сообщение пользователя',

      unparsedAgentMessage: 'Нераспознанное сообщение ассистента',

      unsupportedAgentOutput: 'Неподдерживаемый вывод',

      unsupportedTranscriptRecord: 'Неподдерживаемая запись',

    },

    selection: {

      enterA11y: 'Войти в режим выбора',

      exitA11y: 'Выйти из режима выбора',

      rowA11y: ({ role, preview }: { role: string; preview: string }) => `${role}: ${preview}`,

      selectedCount: ({ count }: { count: number }) => count === 1 ? '1 message selected' : `${count} messages selected`,

      selectAll: 'Выбрать все',

      deselectAll: 'Снять выбор',

      cancel: 'Отмена',

      copy: 'Копировать',

      copyA11y: ({ count }: { count: number }) => count === 1 ? 'Copy 1 message' : `Copy ${count} messages`,

      send: 'Отправить',

      sendA11y: ({ count }: { count: number }) => count === 1 ? 'Send 1 message to another session' : `Send ${count} messages to another session`,

      copySuccess: 'Скопировано',

      copyFailed: 'Не удалось скопировать',

      sendTo: {

        modalTitle: 'Отправить в сессию',

        modalSubtitle: 'Добавить выбранные сообщения в черновик другой сессии',

        newSession: 'Новая сессия',

        newSessionSubtitle: 'Добавить в черновик новой сессии',

        searchPlaceholder: 'Search sessions...',

        noResults: 'Подходящих сессий нет',

        currentExcluded: 'Текущая сессия не показана',

        preview: 'Предпросмотр',

        previewNote: 'Так это будет выглядеть в поле ввода целевой сессии',

        addNote: 'Добавить примечание (необязательно)',

        addNotePlaceholder: 'Type a note to prepend...',

        send: 'Отправить',

        cancel: 'Отмена',

        sendFailed: 'Не удалось отправить',

        sendSuccessNavigating: 'Отправлено — открываем сессию',

      },

    },

    progress: {

      catchingUp: 'Догружаем…',

    },

  },


  inbox: {
    openSession: ({ session }: { session: string }) => `Открыть сессию: ${session}`,
    // Inbox screen
    emptyTitle: "Вы в курсе всего",
    emptyDescription: "Сейчас нет ожидающих запросов или обновлений.",
    approvals: "Подтверждения",
    permissions: "Разрешения",
    unreadSessions: "Непрочитанные сессии",
    updates: "Активность",
  },

  approvals: {
    title: "Подтверждение",
    untitled: "Подтверждение без названия",
    details: "Детали",
    fieldStatus: "Статус",
    fieldAction: "Действие",
    approve: "Подтвердить",
    reject: "Отклонить",
    loadError: "Не удалось загрузить подтверждение.",
    decisionError: "Не удалось обновить подтверждение.",
    confirmApproveTitle: "Подтвердить запрос?",
    confirmApproveBody: "Это выполнит запрошенное действие.",
    confirmRejectTitle: "Отклонить запрос?",
    confirmRejectBody: "Это отклонит запрос.",
    proposedComments: ({ count }: { count: number }) => `${count} ${count === 1 ? "предложенный комментарий" : "предложенных комментариев"}`,
    generation: ({ generation }: { generation: string }) => `Поколение: ${generation}`,
    status: {
      open: "Ожидает",
      approved: "Подтверждено",
      rejected: "Отклонено",
      executed: "Выполнено",
      failed: "Ошибка",
      canceled: "Отменено",
    },
  },

  promptLibrary: {
    sections: "Разделы",
    library: "Библиотека",
    librarySubtitle: "Управляйте промптами и навыками",
    create: "Создать",
    newPrompt: "Новый промпт",
    newSkill: "Новый навык",
    prompts: "Промпты",
    skills: "Навыки",
    untitledPrompt: "Промпт без названия",
    untitledSkill: "Навык без названия",
    origin: "Источник",
    schema: "Схема",
    editPrompt: "Редактировать промпт",
    editSkill: "Редактировать навык",
    titlePlaceholder: "Название",
	    saveError: "Не удалось сохранить.",
	    templates: "Шаблоны",
	    templatesSubtitle: "Создавайте и управляйте /slash шаблонами",
	    newTemplate: "Новый шаблон",
	    stacks: "Стеки",
	    stacksSubtitle: "Добавляйте промпты и навыки к сессиям и профилям",
        externalAssets: "Внешние ассеты",
        externalAssetsSubtitle: "Импортируйте навыки и ассеты подсказок с подключённых машин",
        externalAssetsContext: "Контекст обнаружения",
        externalAssetsMachine: "Машина",
        externalAssetsScope: "Область",
        externalAssetsProjectScope: "Проект",
        externalAssetsProjectScopeSubtitle: "Искать ассеты в пределах пути рабочей области",
        externalAssetsUserScope: "Пользователь",
        externalAssetsUserScopeSubtitle: "Искать ассеты в папках уровня пользователя",
        externalAssetsProjectDirectory: "Каталог проекта",
        externalAssetsProjectDirectoryRequired: "Выберите каталог проекта перед импортом или экспортом ресурсов уровня проекта.",
        externalAssetsRefresh: "Обновить внешние ассеты",
        externalAssetsRefreshSubtitle: "Найти ассеты подсказок для выбранной машины и области",
        externalAssetsTypes: "Типы ассетов",
        externalAssetsNoMachine: "Выберите машину, чтобы продолжить.",
        externalAssetsNoTypes: "Нет типов внешних ассетов",
        externalAssetsNoTypesSubtitle: "Эта машина пока не предоставляет адаптеры ассетов подсказок.",
        externalAssetsNoItems: "Внешние ассеты не найдены",
        externalAssetsNoItemsSubtitle: "Обновите после выбора машины, области или каталога.",
        externalAssetsUnsupportedImport: "Сюда можно импортировать только bundle-ассеты подсказок.",
        externalAssetsExportTitle: "Экспортировать внешний ресурс",
        externalAssetsExportOptions: "Параметры экспорта",
        externalAssetsExportType: "Тип ресурса",
        externalAssetsExportAction: "Экспортировать",
        externalAssetsExportConfirmTitle: "Экспортировать внешний ресурс?",
        externalAssetsExportConfirmBody: "Это запишет выбранный ресурс промпта во внешнее расположение.",
        externalAssetsExportTargetPathPlaceholder: "Целевой путь (например, review/code.md)",
        externalAssetsExportTargetNamePlaceholder: "Целевое имя (например, reviewer)",
        externalAssetsDeleteConfirmTitle: "Удалить внешний ресурс?",
        externalAssetsDeleteConfirmBody: "Это удалит связанный внешний ресурс с диска.",
        externalAssetsLinkedTitle: "Связанный внешний ресурс",
        registries: "Реестры",
        registriesSubtitle: "Просматривайте реестры навыков и импортируйте bundles в библиотеку",
        registriesContext: "Контекст реестра",
        registriesNoMachine: "Выберите машину, чтобы продолжить.",
        registriesRefresh: "Обновить реестры",
        registriesRefreshSubtitle: "Загрузить встроенные и настроенные источники реестров для выбранной машины",
        registriesAddGitSource: "Добавить источник Git",
        registriesAddGitSourceAction: "Сохранить источник Git",
        registriesAddGitSourceActionSubtitle: "Сохранить этот репозиторий как источник реестра",
        registriesAddGitSourceError: "Укажите и название, и URL репозитория.",
        registriesSourceTitlePlaceholder: "Название источника",
        registriesSourceUrlPlaceholder: "URL репозитория или локальный путь",
        registriesSources: "Источники",
        registriesNoSources: "Источники реестров не загружены",
        registriesNoSourcesSubtitle: "Добавьте источник Git или обновите, чтобы загрузить встроенные источники.",
        registriesItems: "Элементы реестра",
        registriesNoItems: "Нет элементов реестра",
        registriesNoItemsSubtitle: "Выберите источник, чтобы просканировать доступные навыки.",
	    editTemplate: "Редактировать шаблон",
    tokenPlaceholder: "Токен (например, /daily)",
    codingStack: "Стек кода",
    codingStackSubtitle: "Применяется к сессиям кодинга",
    voiceStack: "Стек голоса",
    voiceStackSubtitle: "Применяется к Happier Voice",
    profileStacks: "Стеки профилей",
    profileStacksSubtitle: ({ count }: { count: number }) => {
      const mod10 = count % 10;
      const mod100 = count % 100;
      if (mod10 === 1 && mod100 !== 11) return `${count} профиль`;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${count} профиля`;
      return `${count} профилей`;
    },
    profileStackCount: ({ count }: { count: number }) => {
      const mod10 = count % 10;
      const mod100 = count % 100;
      if (mod10 === 1 && mod100 !== 11) return `${count} элемент`;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${count} элемента`;
      return `${count} элементов`;
    },
    noProfilesTitle: "Нет профилей",
    noProfilesSubtitle: "Создайте профиль, чтобы использовать стеки профиля.",
    stackEntries: "Элементы стека",
    stackPlacementSkill: "Инструкции навыка",
    stackPlacementComposer: "Вставка в композер",
    stackPlacementSystem: "Добавить в систему",
    stackEmptyTitle: "Стек пуст",
    stackEmptySubtitle: "Добавьте промпты или навыки, чтобы начать.",
    actions: "Действия",
    addToStack: "Добавить в стек",
    stackAlreadyContainsPrompt: "В этом стеке уже есть этот элемент.",
    stackPickerNoPrompts: "Промптов пока нет.",
    stackPickerNoSkills: "Навыков пока нет.",
    removeFromStack: "Удалить из стека?",
    removeFromStackConfirm: "Элемент будет удалён из стека.",
    deleteTemplate: "Удалить шаблон?",
    deleteTemplateConfirm: "Шаблон будет удалён.",
    templateTokenReserved: "Этот токен зарезервирован.",
    templateTokenConflictsWithAction: "Этот токен конфликтует со встроенным действием.",
    templateTokenDuplicate: "Этот токен уже используется.",
    templateTarget: "Целевой промпт",
    templateBehavior: "Поведение",
    templateBehaviorInsert: "Вставить",
    templateBehaviorInsertOnSend: "Вставить при отправке",
    templateBehaviorInsertAndSend: "Вставить и отправить",
    templateAllowArgs: "Разрешить аргументы",
    templateAllowArgsSubtitle: "Если включено, текст после токена передаётся как $args.",
        ...promptLibraryUxRefinementTranslationExtension.ru,
  },

  runs: {
    title: "Запуски",
    empty: "Запусков пока нет.",
    showFinished: "Показывать завершённые",
    unknownMachine: "Неизвестная машина",
    failedToLoad: "Не удалось загрузить запуски",
    noMachinesAvailable: "Нет доступных машин.",
    groupLabel: ({ groupId }: { groupId: string }) => `Группа ${groupId}`,
    serverTitle: ({ serverId }: { serverId: string }) => `Сервер ${serverId}`,
    machinesSubtitle: "Машины",
    openMachine: "Открыть машину",
    a11y: {
      toggleFinished: "Переключить завершённые запуски",
      refresh: "Обновить запуски",
    },
    openSession: "Открыть сессию",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `Сессия ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `запуск ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `PID ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "Не удалось загрузить запуск",
      latestToolResultTitle: "Последний результат инструмента",
      a11y: {
        refreshRun: "Обновить запуск",
      },
    },
    stop: {
      stopRunA11y: "Остановить запуск",
      stopLabel: "Остановить запуск",
      stoppingLabel: "Остановка…",
      stopRunFailedTitle: "Не удалось остановить запуск",
      stopRunFailedBody:
        "Остановка этого запуска через RPC сессии не удалась. Остановить весь процесс сессии вместо этого? Это разрушительно и остановит все запуски в этой сессии.",
      stopSession: "Остановить сессию",
      failedToStopRun: "Не удалось остановить запуск",
      failedToStopSession: "Не удалось остановить сессию",
    },
    send: {
      placeholder: "Отправить в запуск…",
      a11y: {
        sendToRun: "Отправить в запуск",
      },
      sendLabel: "Отправить",
      sendingLabel: "Отправка…",
      failedToSend: "Не удалось отправить",
    },
    delivery: {
      title: "Доставка",
      cardDelivery: ({ label }: { label: string }) => `Доставка: ${label}`,
      steerLabel: "Управлять",
      steerHelp:
        "Отправить управляющее сообщение, пока выполнение занято (если поддерживается).",
      interruptLabel: "Прервать",
      interruptHelp:
        "Отменить текущий ход, затем отправить сообщение как новый ход.",
      promptLabel: "Промпт",
    },
  },

  sessionLog: {
    title: "Лог сессии",
    devModeRequiredTitle: "Требуется режим разработчика",
    devModeRequiredBody:
      "Включите режим разработчика в настройках, чтобы просматривать логи сессии.",
    logPathTitle: "Путь к логу",
    unavailable: "Недоступно",
    logPathCopyLabel: "Путь к логу сессии",
    refreshTailTitle: "Обновить хвост лога",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `Прочитать последние ${maxBytes} байт`,
    copyVisibleTitle: "Скопировать видимый лог",
    copyVisibleSubtitleLoaded:
      "Скопировать текущий хвост в буфер обмена",
    copyVisibleSubtitleEmpty: "Лог не загружен",
    copyLogLabel: "Лог сессии",
    statusTitle: "Статус лога",
    readErrorTitle: "Ошибка чтения",
    tailTitle: "Хвост лога",
    tailTitleTruncated: "Хвост лога (усечён)",
    noOutputYet: "(Пока нет вывода лога)",
    readFailed: "Не удалось прочитать лог сессии",
  },

  automations: {
    openA11y: "Открыть автоматизации",
    gate: {
      disabledTitle: "Автоматизации отключены",
      disabledBody:
        "Включите их в Настройках, затем включите Эксперименты и Автоматизации.",
    },
    edit: {
      title: "Редактировать автоматизацию",
      saveAutomationLabel: "Сохранить автоматизацию",
      messageLabel: "СООБЩЕНИЕ",
      messagePlaceholder: "Сообщение для отправки",
      messageHelpText:
        "Это сообщение будет поставлено в очередь в сессию как ожидающее сообщение пользователя.",
      updateFailed: "Не удалось обновить автоматизацию.",
      loadTemplateFailed: "Не удалось загрузить шаблон автоматизации.",
    },
    form: {
      groupAutomationTitle: "Автоматизация",
      groupScheduleTitle: "Расписание",
      toggleEnableTitle: "Включить автоматизацию",
      toggleEnableSubtitle:
        "Создайте этот новый шаблон сессии как запланированную автоматизацию вместо немедленного запуска.",
      toggleEnabledTitle: "Включено",
      toggleEnabledSubtitle:
        "При отключении запланированные запуски выполняться не будут.",
      labels: {
        name: "ИМЯ",
        descriptionOptional: "ОПИСАНИЕ (НЕОБЯЗАТЕЛЬНО)",
        everyMinutes: "КАЖДЫЕ (МИНУТЫ)",
        cronExpression: "CRON-ВЫРАЖЕНИЕ",
        timezoneOptional: "ЧАСОВОЙ ПОЯС (НЕОБЯЗАТЕЛЬНО)",
      },
      placeholders: {
        name: "Сводка недавней активности",
        description: "Заметки для себя",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC или America/New_York",
      },
      schedule: {
        intervalTitle: "Интервал",
        intervalSubtitle: "Запускать каждые N минут.",
        cronTitle: "Cron-выражение",
        cronSubtitle: "Продвинутое выражение расписания.",
        cronHelpText:
          "Стандартный cron из 5 полей: минута час день-месяца месяц день-недели.",
      },
      sentence: {
        run: "Запускать",
        every: "каждые",
        onSchedule: "по расписанию",
        runEvery: "Запускать каждые",
        minutes: "минут",
        presets: "Пресеты",
        intervalUnits: {
          minutes: "Минуты",
          hours: "Часы",
          days: "Дни",
        },
        cronFieldGuide: {
          minute: "Минута",
          hour: "Час",
          dayOfMonth: "День",
          month: "Месяц",
          weekday: "День нед.",
        },
        useCron: "Использовать cron-выражение",
        useInterval: "Переключиться на интервал",
        addNotes: "Добавить заметки",
        notes: "ЗАМЕТКИ",
        localTimezone: "местное время",
        scheduleControlA11y: "Изменить расписание автоматизации",
        intervalValue: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} дн.`;
          if (minutes === 60) return "1 час";
          if (minutes % 60 === 0) return `${minutes / 60} ч`;
          return `${minutes} мин`;
        },
        intervalCadence: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `каждые ${minutes / (24 * 60)} дн.`;
          if (minutes === 60) return "каждый час";
          if (minutes % 60 === 0) return `каждые ${minutes / 60} ч`;
          return `каждые ${minutes} мин`;
        },
        cronPresets: {
          weekdays9am: "Будни в 9:00",
          hourly: "Каждый час",
          monday9am: "Понедельник в 9:00",
          dailyMidnight: "Каждый день в полночь",
        },
        cronCadences: {
          weekdays9am: "по будням в 9:00",
          hourly: "каждый час",
          monday9am: "по понедельникам в 9:00",
          dailyMidnight: "каждый день в полночь",
        },
        cronCadenceExpression: ({ expression }: { expression: string }) => `по cron-расписанию ${expression}`,
        timezone: ({ timezone }: { timezone: string }) => `Часовой пояс: ${timezone}`,
      },
    },
    session: {
      emptyTitle: "Нет автоматизаций",
      emptyBody:
        "Добавьте автоматизацию, чтобы ставить запланированные сообщения в очередь этой сессии.",
      addAutomation: "Добавить автоматизацию",
      failedToLoad: "Не удалось загрузить автоматизации.",
    },
    screen: {
      emptyTitle: "Автоматизаций пока нет",
      emptyBody:
        "Создайте её через поток «Новая сессия», чтобы запускать запланированные сессии на ваших машинах.",
      createAutomationA11y: "Создать автоматизацию",
    },
    detail: {
      invalidId: "Недопустимый идентификатор автоматизации.",
      notFound: "Автоматизация не найдена.",
      unknownDate: "Неизвестно",
      notScheduled: "Не запланировано",
      overviewGroupTitle: "Обзор",
      overview: {
        nameTitle: "Имя",
        scheduleTitle: "Расписание",
        statusTitle: "Статус",
        nextRunTitle: "Следующий запуск",
      },
      status: {
        active: "Активна",
        paused: "Приостановлена",
      },
      actionsGroupTitle: "Действия",
      runNowTitle: "Запустить сейчас",
      runNowQueuedBadge: "В очереди",
      runNowQueuedLine: "В очереди.",
      runNowQueuedSubtitle:
        "В очереди. Назначенный демон выполнит запуск, когда будет доступен.",
      pauseAutomation: "Приостановить автоматизацию",
      resumeAutomation: "Возобновить автоматизацию",
      editAutomation: "Редактировать автоматизацию",
      deleteAutomation: "Удалить автоматизацию",
      deleteConfirmTitle: "Удалить автоматизацию",
      deleteConfirmMessage: "Эта автоматизация и её расписание будут удалены.",
      deleteConfirmButton: "Удалить",
      machineAssignmentsTitle: "Назначения машин",
      machineAssignmentsFooter:
        "Включите хотя бы одну машину, чтобы автоматизация могла выполняться.",
      refreshFailed: "Не удалось обновить автоматизацию.",
      runFailed: "Не удалось запустить автоматизацию.",
      deleteFailed: "Не удалось удалить автоматизацию.",
      assignmentsUpdateFailed: "Не удалось обновить назначения машин.",
      recentRunsTitle: "Недавние запуски",
      runMeta: {
        scheduled: ({ time }: { time: string }) => `Запланировано: ${time}`,
        updated: ({ time }: { time: string }) => `Обновлено: ${time}`,
        error: ({ message }: { message: string }) => `Ошибка: ${message}`,
      },
    },
    create: {
      defaultName: "Запланированное сообщение",
      createFailed: "Не удалось создать автоматизацию.",
      unavailableGroupTitle: "Недоступно",
      cannotCreateForSession: "Нельзя создать автоматизацию для этой сессии",
      sessionNotFound: "Сессия не найдена.",
      missingMachineId: "У этой сессии отсутствует идентификатор машины.",
      missingResumeKey:
        "Для этой сессии ещё не загружен ключ шифрования для возобновления.",
      createButtonTitle: "Создать автоматизацию",
    },
  },

  appCrash: {
    title: "Что-то пошло не так",
    subtitle:
      "В Happier произошла непредвиденная ошибка. Можно перезапустить интерфейс приложения или скопировать детали для поддержки.",
    detailsTitle: "Детали ошибки",
    restart: "Перезапустить приложение",
    restartAndReportIssue: "Перезапустить и отправить отчёт об ошибке",
    copyDetails: "Скопировать детали ошибки",
  },

  webCryptoGate: {
    title: "Требуется защищённое соединение",
    subtitle:
      "Эта страница использует WebCrypto для защиты данных. WebCrypto недоступен для этого источника, потому что браузеры требуют защищённый контекст.",
    howToFix: "Как исправить",
    fixHttps: "Откройте UI по HTTPS (рекомендуется).",
    fixTunnel:
      "Если нужен доступ по LAN, используйте HTTPS-туннель или обратный прокси с TLS.",
    fixLocalhost:
      "Если вы на той же машине, используйте http://localhost (loopback считается защищённым).",
    currentOrigin: "Текущий источник",
    secureContext: "Защищённый контекст",
    copyDetails: "Скопировать детали",
    reload: "Перезагрузить",
  },

  common: {
    // Simple string constants
    add: "Добавить",
    edit: "Редактировать",
    duplicate: "Дублировать",
    actions: "Действия",
    moreActions: "Другие действия",
    moreActionsHint: "Открывает меню с другими действиями",
    cancel: "Отмена",
    close: "Закрыть",
    open: "Открыть",
    done: "Готово",
    reorder: "Упорядочить",
    moveUp: "Переместить вверх",
    moveDown: "Переместить вниз",
    authenticate: "Авторизация",
    save: "Сохранить",
    saveAs: "Сохранить как",
		    error: "Ошибка",
		    success: "Успешно",
		    info: "Инфо",
		    comingSoon: "Скоро",
		    ok: "ОК",
		    continue: "Продолжить",
		    back: "Назад",
        previous: "Предыдущий",
        next: "Следующий",
	    start: "Запустить",
	    create: "Создать",
    rename: "Переименовать",
    remove: "Удалить",
    update: "Обновить",
    commit: "Коммит",
    history: "История",
      applied: "Применено",
      signOut: "Выйти",
      keep: "Оставить",
      use: "Использовать",
      reset: "Сбросить",
      logout: "Выйти",
      yes: "Да",
      no: "Нет",
    on: "Вкл.",
    off: "Выкл.",
    discard: "Отменить",
    discardChanges: "Отменить изменения",
    unsavedChangesWarning: "У вас есть несохранённые изменения.",
    keepEditing: "Продолжить редактирование",
    version: "Версия",
    details: "Детали",
    copied: "Скопировано",
    copy: "Копировать",
    copyWithLabel: ({ label }: { label: string }) => `Копировать ${label}`,
    paste: "Вставить",
    pasteImage: "Вставить изображение",
    expand: "Развернуть",
    collapse: "Свернуть",
    command: "Команда",
    scanning: "Сканирование...",
    urlPlaceholder: "https://example.com",
    home: "Главная",
    message: "Сообщение",
    send: "Отправить",
    attach: "Прикрепить",
    addImage: "Добавить изображение",
    addFile: "Добавить файл",
    linkFile: "Связать файл",
    files: "Файлы",
    path: "Путь",
    fileViewer: "Просмотр файла",
    loading: "Загрузка...",
    none: "—",
    notProvided: "Не предоставлено",
    unavailable: "Недоступно",
    dialog: "Диалог",
    retry: "Повторить",
    or: "или",
    delete: "Удалить",
    deleted: "Удалено",
    optional: "необязательно",
    noMatches: "Нет совпадений",
    all: "Все",
    machine: "машина",
    clearSearch: "Очистить поиск",
    refresh: "Обновить",
    default: "По умолчанию",
    enabled: "Включено",
    disabled: "Отключено",
    requestFailed: "Запрос не выполнен.",

    more: "Ещё",
    skip: "Пропустить",
    maximize: "Развернуть",
    restore: "Восстановить",
    name: "Имя",
    blocked: "Заблокировано",
    active: "Активные",
    inactive: "Неактивные",
    running: "Выполняется…",
    login: "Войти",
    install: "Установить",
    enable: "Включить",
    disable: "Отключить",
    tabs: "Вкладки",
    logs: "Журналы",
    share: "Поделиться",
    unreachable: "Недостижимо",},

  ui: {
    resizableDockedPane: {
      resizeA11y: "Изменить размер панели",
      resizeHint:
        "Используйте стрелки влево и вправо, чтобы изменить размер",
    },
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
    scanComputerQrUnavailableTitle: "Сканирование QR с компьютера недоступно",
    scanComputerQrUnavailableBody:
      "Этот способ входа отключён на этом сервере. Используйте другой вариант ниже, чтобы восстановить аккаунт.",
    scanComputerQrInstructions: "Отсканируйте QR-код, показанный в Happier на компьютере (Настройки → Добавить телефон).",
    scanComputerQrButton: "Сканировать QR для входа",
    waitingForApproval: "Ожидание подтверждения…",
    showQrInstead: "Показать QR‑код вместо этого",
    addPhoneQrInstructions: "Отсканируйте этот QR‑код в мобильном приложении Happier, чтобы войти на телефоне.",
    serverUrlNotEmbeddedTitle: "Настройте сервер на телефоне",
    serverUrlNotEmbeddedBody:
      "Этот QR‑код не может включать адрес сервера, потому что он настроен на localhost. На телефоне откройте Настройки → Серверы и добавьте URL, доступный с телефона (LAN IP или Tailscale), затем отсканируйте снова.",
    pairingRequestTitle: "Запрос на привязку",
    pairingRequestBody: "Убедитесь, что этот код совпадает с тем, что отображается на телефоне, затем подтвердите.",
    pairingAlreadyRequestedTitle: "Код уже использован",
    pairingAlreadyRequestedBody:
      "Этот QR‑код уже был отсканирован на другом телефоне. Попросите компьютер сгенерировать новый.",
    deviceLabel: "Устройство",
    confirmCodeLabel: "Код подтверждения",
    approveButton: "Подтвердить",
    generateNewQrCode: "Сгенерировать новый QR‑код",
    pairingQrExpired: "Этот QR‑код истёк. Сгенерируйте новый.",
    openMachine: "Открыть машину",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "На устройстве, где вы уже вошли в аккаунт, откройте Настройки → Аккаунт и отсканируйте этот QR‑код.",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} подтверждён`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `Мы нашли существующий аккаунт Happier, связанный с ${provider}. Чтобы завершить вход на этом устройстве, восстановите ключ аккаунта с помощью QR‑кода или секретного ключа.`,
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
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `Выполните следующую команду в терминале:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "Предпросмотр недоступен",
        previewUnavailableBody: "Не удалось собрать предпросмотр диагностики.",
        submittedTitle: "Отчёт об ошибке отправлен",
        submittedExistingIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) =>
          `Комментарий опубликован в issue #${issueNumber}.\n\nID отчёта: ${reportId}`,
        submittedNewIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) => `Issue #${issueNumber} создан.\n\nID отчёта: ${reportId}`,
        submitFailedTitle: "Отправка не удалась",
        submitFailedFallbackMessage: "Не удалось отправить этот отчёт.",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\nОткрыть вместо этого предварительно заполненное GitHub issue?`,
        openFallbackIssueButton: "Открыть fallback issue",
      },
      diagnostics: {
        title: "Диагностика",
        subtitle:
          "Выберите, что включить, и предварительно просмотрите перед отправкой.",
        includeTitle: "Включить диагностику",
        includeSubtitle:
          "Приложите обезличенные артефакты отладки для более быстрого разбора.",
        disabledByServerSuffix: " (отключено сервером)",
        pasteDoctorJson: {
          title: "CLI doctor JSON (необязательно)",
          subtitle:
            "Если машина недоступна из UI, выполните `happier doctor --json` на компьютере и вставьте сюда.",
          placeholder: "{ \"capturedAt\": \"...\", ... }",
          invalid: ({ error }: { error: string }) => `Некорректный doctor JSON: ${error}`,
          valid: "Doctor JSON выглядит корректным и будет приложен к отчёту.",
        },
        previewButton: "Предпросмотр диагностики",
        preview: {
          title: "Предпросмотр диагностики",
          helper:
            "Эти артефакты будут загружены вместе с отчётом (санитизированы и с ограничением размера). Нажмите на элемент, чтобы посмотреть его содержимое целиком.",
          empty: "Артефакты диагностики не будут отправлены.",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `Открыть ${filename}`,
        },
        kinds: {
          app: {
            title: "Диагностика приложения",
            detail:
              "Логи приложения, недавние действия пользователя и сводка сессии.",
          },
          daemon: {
            title: "Диагностика демона",
            detail:
              "Сводка демона и последние логи демона с выбранных машин.",
          },
          stackService: {
            title: "Диагностика Stack-сервиса",
            detail: "Контекст стека и последние логи стека (если доступны).",
          },
          server: {
            title: "Диагностика сервера",
            detail: "Снимок текущего активного сервера.",
          },
        },
      },
      issueDetails: {
        title: "Опишите проблему",
        subtitle:
          "Добавьте достаточно деталей, чтобы мы могли быстро воспроизвести и диагностировать.",
        titleLabel: "Заголовок (обязательно)",
        titlePlaceholder: "Короткий заголовок",
        githubUsernameLabel: "Имя пользователя GitHub (необязательно)",
        githubUsernamePlaceholder:
          "Используется как контактная информация в тексте issue",
        summaryLabel: "Краткое описание (обязательно)",
        summaryPlaceholder: "Описание в один абзац",
        currentBehaviorLabel: "Текущее поведение (необязательно)",
        currentBehaviorPlaceholder: "Что происходит на самом деле?",
        expectedBehaviorLabel: "Ожидаемое поведение (необязательно)",
        expectedBehaviorPlaceholder: "Что должно происходить вместо этого?",
        reproductionStepsLabel: "Шаги воспроизведения (необязательно)",
        reproductionStepsPlaceholder:
          "1. Откройте Happier\n2. Запустите сессию\n3. ...",
        whatChangedLabel: "Что изменилось недавно (необязательно)",
        whatChangedPlaceholder:
          "Обновления, изменения конфигурации, новые шаги настройки...",
      },
      similarIssues: {
        title: "Возможные дубликаты",
        subtitle:
          "Если один из этих вариантов подходит, вы можете оставить отчёт в комментарии вместо открытия нового issue.",
        searching: "Поиск issues…",
        selectedTitle: ({ number }: { number: number }) =>
          `Используется issue #${number}`,
        selectedSubtitle: "Нажмите, чтобы вернуться к созданию нового issue.",
        useIssueA11y: ({ number }: { number: number }) => `Использовать issue #${number}`,
        issueState: {
          open: "Открытое issue",
          closed: "Закрытое issue",
        },
      },
      frequencySeverity: {
        title: "Частота и серьёзность",
        frequencyLabel: "Частота",
        severityLabel: "Серьёзность",
        frequency: {
          always: "Всегда",
          often: "Часто",
          sometimes: "Иногда",
          once: "Один раз",
        },
        severity: {
          blocker: "Блокирует",
          high: "Высокая",
          medium: "Средняя",
          low: "Низкая",
        },
      },
      environment: {
        title: "Окружение (можно редактировать)",
        appVersionLabel: "Версия приложения",
        platformLabel: "Платформа",
        osVersionLabel: "Версия ОС",
        deviceModelLabel: "Модель устройства",
        serverUrlLabel: "URL сервера",
        serverVersionLabel: "Версия сервера (необязательно)",
        deploymentTypeLabel: "Тип развертывания",
        deploymentType: {
          cloud: "Облако",
          selfHosted: "Самостоятельный хостинг",
          enterprise: "Корпоративный",
        },
      },
      consent: {
        title: "Согласие",
        understandTitle:
          "Я понимаю, что диагностика может включать технические метаданные",
        understandSubtitle:
          "Не включайте пароли, токены доступа или приватные ключи.",
      },
      submit: {
        requiredFieldsHint:
          "Заполните обязательные поля, чтобы включить отправку.",
        submitting: "Отправка отчёта…",
        addToIssue: ({ number }: { number: number }) =>
          `Добавить в issue #${number}`,
        submitNew: "Отправить отчёт об ошибке",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer:
        "Включите поиск по памяти в «Функции», чтобы настроить локальную индексацию.",
      title: "Поиск по памяти отключён",
      subtitle: "Откройте Настройки → Функции и включите memory.search",
      openFeatureSettings: "Открыть настройки функций",
      alertTitle: "Поиск по памяти отключён",
      alertBody: "Включите memory.search в Настройки → Функции.",
    },
    enabled: {
      title: "Включено",
      subtitle: "Создавать и поддерживать локальный индекс на этой машине",
      footer:
        "Когда включено, Happier строит локальный индекс на устройстве на основе расшифрованных транскриптов для быстрого поиска и восстановления.",
    },
    budgets: {
      groupTitle: "Лимит диска",
      groupFooter:
        "Ограничивает объём диска, который может использовать локальный индекс памяти (вытеснение best-effort).",
      mbLabel: ({ mb }: { mb: number }) => `${mb} МБ`,
      lightTitle: "Лимит лёгкого индекса",
      lightPromptTitle: "Лимит лёгкого индекса",
      lightPromptBody:
        "Макс. МБ для лёгкого (сводных шардов) индекса на этой машине.",
      deepTitle: "Лимит глубокого индекса",
      deepPromptTitle: "Лимит глубокого индекса",
      deepPromptBody:
        "Макс. МБ для глубокого (chunk) индекса на этой машине.",
    },
    privacy: {
      groupTitle: "Конфиденциальность",
      groupFooter:
        "Удаляет локальные производные индексы и кэши моделей при отключении поиска по памяти.",
      deleteOnDisableTitle: "Удалять при отключении",
      deleteOnDisableSubtitle:
        "Удаляет локальные индексы и кэши, когда поиск по памяти отключён",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `Машина: ${machine}`,
      searchPlaceholder: "Поиск по памяти",
      enableLocalSearch: "Включить локальный поиск по памяти",
      emptyResults: "Результаты по памяти пока отсутствуют",
    },
    status: {
      title: "Статус локального индекса",
      diskUsageTitle: "Использование диска",
      disabled: "Поиск по локальной памяти отключен на этом компьютере",
      empty: "Локальный поиск по памяти включён, но доступное для поиска содержимое ещё не проиндексировано",
      indexing: "Локальный поиск по памяти индексирует содержимое транскриптов",
      waiting: "Локальный поиск по памяти ожидает следующего запуска индексации",
      error: "Локальный поиск по памяти требует внимания",
      readyLight: "Лёгкий индекс готов на этой машине",
      readyDeep: "Глубокий индекс готов на этой машине",
      unavailableLight: "Лёгкий индекс ещё не готов на этой машине",
      unavailableDeep: "Глубокий индекс ещё не готов на этом компьютере",
      diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Лёгкий ${lightMb} МБ · Глубокий ${deepMb} МБ`,
      diskUsageFormatted: ({ light, deep }: { light: string; deep: string }) => `Лёгкий ${light} · Глубокий ${deep}`,
      diskUsageUnavailable: "Использование диска недоступно",
      ...memoryEmbeddingsTranslationExtension.status,
    },
    machine: {
      title: "Машина",
      changeTitle: "Сменить машину",
      noMachine: "Нет машины",
    },
    indexMode: {
      title: "Режим индексации",
      footer:
        "Лёгкий режим хранит небольшие фрагменты-сводки. Глубокий может находить больше, но использует больше диска.",
      triggerTitle: "Режим",
      options: {
        lightTitle: "Лёгкий (рекомендуется)",
        lightSubtitle: "Только фрагменты-сводки",
        deepTitle: "Глубокий",
        deepSubtitle: "Индексировать фрагменты сообщений локально",
      },
    },
    backfill: {
      title: "Дозаполнение",
      footer:
        "Определяет, сколько истории индексировать при включении локальной памяти.",
      triggerTitle: "Политика",
      options: {
        newOnlyTitle: "Только новое (рекомендуется)",
        newOnlySubtitle: "Индексировать только созданное после включения",
        last30DaysTitle: "Последние 30 дней",
        last30DaysSubtitle: "Дозаполнить недавние сессии",
        allHistoryTitle: "Вся история",
        allHistorySubtitle: "Дозаполнить всё (может занять время)",
      },
    },
    indexContents: {
      groupTitle: "Содержимое индекса",
      title: "Доступное для поиска содержимое",
      subtitle: ({ sessions, lightShards, deepChunks }: { sessions: number; lightShards: number; deepChunks: number }) =>
        `${sessions} сессий · ${lightShards} лёгких шардов · ${deepChunks} глубоких фрагментов`,
    },
    queue: {
      groupTitle: "Дозаполнение и очередь",
      title: "Очередь индексации",
      subtitle: ({ selected, queued, indexing, indexed, empty, failed, waiting }: { selected: number; queued: number; indexing: number; indexed: number; empty: number; failed: number; waiting: number }) =>
        `${selected} выбрано · ${queued} в очереди · ${indexing} индексируется · ${indexed} проиндексировано · ${empty} пусто · ${failed} с ошибками · ${waiting} ожидает`,
      workerPhase: ({ phase }: { phase: string }) => `Текущая фаза: ${phase}`,
    },
    lastRun: {
      groupTitle: "Последний запуск индексации",
      title: "Последний запуск",
      subtitle: ({ considered, processed, semanticRows, failures }: { considered: number; processed: number; semanticRows: number; failures: number }) =>
        `${considered} рассмотрено · ${processed} обработано · ${semanticRows} семантических строк · ${failures} ошибок`,
    },
    coverage: {
      title: "Охват содержимого",
      footer: "Управляет тем, какое семантическое содержимое транскриптов индексируется в выбранных сессиях.",
      triggerTitle: "Охват",
      options: {
        fullTitle: "Вся выбранная история",
        fullSubtitle: "Индексировать все выбранные сообщения пользователя и ассистента",
        latestMessagesTitle: "Последние сообщения",
        latestMessagesSubtitle: "Индексировать ограниченное число последних семантических сообщений на сессию",
        latestDaysTitle: "Последние дни",
        latestDaysSubtitle: "Индексировать семантические сообщения из недавнего окна дней",
        sinceEnabledTitle: "С момента включения",
        sinceEnabledSubtitle: "Индексировать содержимое, созданное после включения локальной памяти",
      },
    },
    contentPolicy: {
      title: "Индексируемое содержимое",
      footer: "Сообщения пользователя и ассистента индексируются по умолчанию. Чувствительные сведения провайдера остаются выключенными, если их явно не включить.",
      userMessagesTitle: "Сообщения пользователя",
      userMessagesSubtitle: "Включать промпты и ответы, написанные вами",
      assistantMessagesTitle: "Сообщения ассистента",
      assistantMessagesSubtitle: "Включать финальные ответы ассистента",
      reasoningTitle: "Рассуждения",
      reasoningSubtitle: "Включать сводки рассуждений только если daemon их поддерживает",
      toolSummariesTitle: "Сводки инструментов",
      toolSummariesSubtitle: "Включать очищенные сводки активности инструментов",
      toolOutputsTitle: "Сырые выводы инструментов",
      toolOutputsSubtitle: "Оставьте выключенным, если вы не хотите включать сырой текст выводов инструментов в локальные индексы",
    },
    hints: {
      title: "Генерация подсказок памяти",
      footer:
        "Управляет тем, как создаются фрагменты-сводки для лёгкого поиска по памяти.",
      backend: {
        title: "Бэкенд суммаризации",
        promptTitle: "Бэкенд суммаризации",
        promptBody:
          "Введите id бэкенда для execution-run (например, claude, codex).",
      },
      model: {
        title: "Модель суммаризации",
        promptTitle: "Модель суммаризации",
        promptBody: "Введите id модели, который будет передан в бэкенд.",
      },
      permissions: {
        triggerTitle: "Разрешения суммаризатора",
        options: {
          noToolsTitle: "Без инструментов (рекомендуется)",
          noToolsSubtitle: "Только суммаризация текста",
          readOnlyTitle: "Только чтение",
          readOnlySubtitle:
            "Разрешить не изменяющие инструменты (если поддерживается)",
        },
      },
    },
    embeddings: {
      modelTitle: "Модель эмбеддингов",
      promptBody: "Введите id локальной модели transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
    },
  },

    subAgentGuidance: {
      ruleEditor: {
      header: {
        newRule: "Новое правило",
        editRule: "Редактировать правило",
      },
      enabled: {
        title: "Включено",
      },
      enabledState: {
        enabled: "Включено",
        disabled: "Отключено",
      },
      common: {
        noPreference: "Без предпочтений",
      },
      titleField: {
        label: "Название (необязательно)",
        placeholder: "например, работа с UI",
      },
      descriptionField: {
        label: "Когда агенту следует делегировать?",
        placeholder: "Опишите, когда/как делегировать…",
      },
      backendPicker: {
        title: "Предпочтительный бэкенд (необязательно)",
        searchPlaceholder: "Поиск бэкендов",
        noPreference: {
          subtitle: "Пусть агент выберет бэкенд.",
        },
      },
      modelPicker: {
        title: "Предпочтительная модель (необязательно)",
        searchPlaceholder: "Поиск моделей",
        noPreference: {
          subtitle: "Пусть бэкенд выберет модель по умолчанию.",
        },
      },
      intent: {
        title: "Предпочтительное намерение (необязательно)",
        noPreference: {
          subtitle: "Пусть агент решит намерение.",
        },
        options: {
          review: {
            title: "Ревью",
            subtitle: "Код-ревью / находки.",
          },
          plan: {
            title: "Планирование",
            subtitle: "Планирование / архитектура.",
          },
          delegate: {
            title: "Делегирование",
            subtitle: "Делегирование / выполнение.",
          },
        },
      },
        exampleToolCalls: {
          label: "Примеры вызовов инструментов (необязательно, по одному в строке)",
          placeholder: "например: execution.run.start …",
        },
      },
        settings: {
        groupTitle: "Субагенты",
        disabled: {
          footer:
            "Запуски выполнения отключены. Включите запуски выполнения в Настройки → Функции, чтобы использовать подсказки для делегирования.",
          enableExecutionRuns: {
            title: "Включить запуски выполнения",
            subtitle: "Открыть настройки «Функции»",
          },
        },
        footer:
          "Правила добавляются к системному промпту, чтобы основной агент знал, когда и как вы предпочитаете запускать субагентов.",
        overview: {
          groupTitle: "Обзор",
          footer:
            "Используйте эту страницу, чтобы настроить руководство субагента и перейти к настройкам соответствующего поставщика, серверной части и сеанса.",
          explainerTitle: "Что контролирует эта страница",
          explainerSubtitle:
            "Руководство по делегированию субагентов, а также ссылки на настройки субагентов для конкретного поставщика.",
          happierStatusTitle: "Субагенты",
          happierStatusEnabledSubtitle:
            "Включено. Вы можете запускать субагентов из поддерживаемых сеансов.",
          happierStatusDisabledSubtitle:
            "Отключено. Откройте настройки функций, чтобы включить субагентов.",
        },
        related: {
          groupTitle: "Связанные настройки",
          footer:
            "Запуск субагентов и управление ими также зависят от поведения сеанса, провайдеров и настроенных серверных частей.",
          sessionTitle: "Поведение сеанса",
          sessionSubtitle:
            "Отправка сообщений, управление занятостью и поведение повтора/возобновления.",
          providersTitle: "Провайдеры",
          providersSubtitle:
            "Настройки аутентификации, среды выполнения и агента для конкретного поставщика.",
          backendsTitle: "Каталог ACP",
          backendsSubtitle: "Настроенные серверные части и пользовательские цели запуска.",
        },
        enableInjection: {
          title: "Включить внедрение подсказок",
        },
        characterBudget: {
          title: "Лимит символов",
          subtitle: ({ value }: { value: string }) => `${value} символов`,
          promptTitle: "Лимит символов",
          promptBody:
            "Максимум символов, которые будут добавлены в системный промпт.",
        },
        rules: {
          groupTitle: "Правила подсказок",
          footerEnabled:
            "Нажмите на правило, чтобы изменить. Агент использует их как подсказки для делегирования.",
          footerDisabled: "Включите внедрение, чтобы активировать правила.",
          emptyTitle: "Пока нет правил",
          emptySubtitle: "Добавьте правило, чтобы направлять делегирование.",
          addRuleTitle: "Добавить правило",
          addRuleSubtitle: "Создать новое правило подсказок",
          untitled: "Без названия",
          descriptionFallback: "Опишите, когда делегировать.",
          tapToEdit: "Нажмите, чтобы изменить",
          meta: {
            target: ({ value }: { value: string }) => `Цель: ${value}`,
            model: ({ value }: { value: string }) => `Модель: ${value}`,
            intent: ({ value }: { value: string }) => `Намерение: ${value}`,
          },
        },
        preview: {
          title: "Предпросмотр",
          footer:
            "Это (обрезанный) текст, который добавляется к системному промпту.",
          systemPromptLabel: "Системный промпт (добавлено)",
        },
        providers: {
          claude: {
            title: "Агенты команды Claude",
            footer: "Поведение субагента, зависящее от поставщика, остается во владении экрана настроек поставщика.",
            openTitle: "Параметры субагентов Claude",
            openSubtitle: "Управляйте Agent Teams и другим поведением субагентов, специфичным для Claude.",
          },
        },
      },
    },

  settings: {
    title: "Настройки",

    // Main settings hub category groups
    profileAndAccount: 'Профиль и аккаунт',
    aiAndAgents: 'ИИ и агенты',
    sessionsBehavior: 'Сессии и поведение',
    general: 'Общие',
    filesAndSourceControl: 'Файлы и контроль версий',
    system: 'Система',

    // Renamed / promoted items
    sessions: 'Сессии',
    transcript: 'Стенограмма',
    transcriptSubtitle: 'Размышления, отображение инструментов и кода',
    permissions: 'Разрешения',
    permissionsSubtitle: 'Режим разрешений и поведение подтверждений',
    filesSourceControl: 'Файлы и контроль версий',
    filesSourceControlSubtitle: 'Редактор, diff и интеграция с контролем версий',
    workspaces: 'Рабочие области',
    workspacesSubtitle: 'Управление связанными рабочими областями, расположениями и checkout',

    connectedAccounts: "Подключенные аккаунты",
    connectAccount: "Подключить аккаунт",
    github: "GitHub",
    machines: "Машины",
    features: "Функции",
    social: "Социальное",
    account: "Аккаунт",
    accountSubtitle: "Управление учетной записью",
    addYourPhone: "Добавить телефон",
    addYourPhoneSubtitle: "Показать QR‑код, чтобы войти на телефоне",
    addMachine: "Добавить машину",
    machineSetupCurrentMachineTitle: "Этот компьютер",
    machineSetupCurrentMachineSubtitle: "Разверните Happier напрямую на этом устройстве",
    machineSetupAdoptExistingTitle: "Использовать существующую установку",
    machineSetupAdoptExistingSubtitle: "Использовать существующую настройку демона/службы на этом компьютере",
    machineSetupAdoptExistingProgressTitle: "Проверка существующей установки",
    machineSetupAdoptExistingNotReady: "Готовая установка не найдена. Запустите настройку на этом компьютере.",
    machineSetupSshMachineTitle: "Удаленная машина через SSH",
    machineSetupSshMachineSubtitle: "Подключите dev-бокс, виртуальную машину или сервер с помощью SSH.",
    machineSetupStagesTitle: "Что происходит",
    machineSetupStageConnect: "Подключитесь и подтвердите доступ",
    machineSetupStageInstall: "Установите Happier и выполните сопряжение машины",
    machineSetupStageFinish: "Завершите настройку во встроенном терминале",
    machineSetupComingSoon: "Скоро появится возможность загрузки машины.",
    machineSetupTaskWaitingForInput: "Ожидание ввода",
    machineSetupRemoteSshTargetLabel: "SSH-адрес",
    machineSetupRemoteSshAgentAuthLabel: "Использовать SSH-агент",
    machineSetupRemoteSshKeyFileAuthLabel: "Использовать файл ключа",
    machineSetupRemoteSshIdentityFileLabel: "Путь к файлу ключа",
    machineSetupRemoteRelayRuntimeLabel: "Также установить Relay Runtime на удалённую машину",
    machineSetupRemoteRelayRuntimeTitle: "Удалённый Relay Runtime",
    machineSetupRemoteRelayRuntimeReadyTitle: "Готово на удалённой машине",
    machineSetupRemoteRelayRuntimeReadySubtitle: "Relay Runtime был установлен во время настройки по SSH. Используйте удалённый URL Relay в следующих сетевых шагах на этой машине.",
    machineSetupRemoteRelayRuntimeUrlTitle: "Удалённый URL Relay",
    machineSetupRemoteRelayKeepCurrentTitle: "Оставить текущий Relay",
    machineSetupRemoteRelayKeepCurrentSubtitle: "Сохранить этот URL Relay без переключения.",
    machineSetupRemoteRelaySwitchTitle: "Переключиться на этот Relay",
    machineSetupRemoteRelaySwitchSubtitle: "Переключитесь сейчас и продолжите настройку с новым Relay.",
    machineSetupRemoteRelaySwitchConfirmTitle: "Переключить Relay?",
    machineSetupRemoteRelaySwitchConfirmBody: ({ relayUrl }: { relayUrl: string }) =>
      `Переключить Happier на ${relayUrl} и продолжить настройку?`,
    machineSetupRemotePromptTrustAction: "Доверять ключу хоста",
    machineSetupRemotePromptReplaceAction: "Заменить сохранённый ключ",
    machineSetupRemotePromptApproveAction: "Одобрить сопряжение",
    localRelayRuntime: {
      title: "Локальный Relay Runtime",
      statusTitle: "Статус",
      statusChecking: "Проверка локального Relay Runtime",
      statusNotInstalled: "Ещё не установлен на этом компьютере",
      statusStopped: "Установлен, но сейчас не запущен",
      statusRunningHealthy: "Запущен и отвечает нормально",
      statusRunningNeedsAttention: "Запущен, но проверка здоровья требует внимания",
      versionTitle: "Установленная версия",
      relayUrlTitle: "Локальный URL Relay",
      installOrUpdateAction: "Установить или обновить Relay Runtime",
      startAction: "Запустить Relay Runtime",
      stopAction: "Остановить Relay Runtime",
      refreshAction: "Обновить статус Relay",
      footer: "Управляйте self-hosted Relay на этом компьютере перед подключением других устройств.",
      progressTitle: "Обновление локального Relay Runtime",
      progressStepInspect: "Проверить локальный Relay Runtime",
      progressStepHealth: "Проверить здоровье Relay",
      progressStepInstall: "Установить Relay Runtime",
      progressStepStart: "Запустить Relay Runtime",
      progressStepStop: "Остановить Relay Runtime",
    },
    localTailscale: {
      title: "Приватный доступ через Tailscale",
      statusTitle: "Статус",
      statusUnavailable: "Сначала запустите локальный Relay Runtime",
      statusIdle: "Пока не включено",
      statusWorking: "Настраиваем безопасный приватный доступ",
      statusReady: "Готово для использования с других устройств tailnet",
      statusInstallRequired: "Установите Tailscale, чтобы продолжить",
      statusLoginRequired: "Войдите в Tailscale, чтобы продолжить",
      statusNeedsApproval: "Ожидаем подтверждения в Tailscale",
      shareableUrlTitle: "Приватный URL для доступа",
      approvalTitle: "Требуется подтверждение",
      approvalSubtitle: "Завершите подтверждение в Tailscale, затем вернитесь сюда.",
      installTitle: "Требуется установка",
      installSubtitle: "Установите Tailscale и вернитесь сюда.",
      loginTitle: "Требуется вход",
      loginSubtitle: "Завершите вход в Tailscale и вернитесь сюда.",
      enableAction: "Включить приватный доступ через Tailscale",
      refreshAction: "Повторно проверить доступ",
      openApprovalAction: "Открыть подтверждение Tailscale",
      openInstallAction: "Открыть загрузку Tailscale",
      openLoginAction: "Открыть вход в Tailscale",
      footer: "Доступ остаётся приватным внутри tailnet. Телефон или другой компьютер тоже должны быть в этом tailnet.",
      progressTitle: "Настройка приватного доступа через Tailscale",
      progressStepDetect: "Проверить доступность Tailscale",
      progressStepInstall: "Установить Tailscale",
      progressStepLogin: "Войти в Tailscale",
      progressStepServeEnable: "Включить приватный доступ к Relay",
      progressStepVerifyUrl: "Проверить приватный URL",
    },
    systemTaskStepPrepare: "Подготовить задачу",
    systemTaskStepInstallRuntime: "Установить среду выполнения",
    systemTaskStepFinish: "Завершить настройку",
    systemTaskCurrentStepLabel: "Текущий шаг",
    systemTaskLatestUpdateLabel: "Последнее обновление",
    systemTaskBridgeUnavailable: "Системные задачи пока недоступны в этой сборке.",
    systemTaskStartFailed: "Не удалось запустить системную задачу.",
    appearance: "Внешний вид",
    appearanceSubtitle: "Настройка внешнего вида приложения",
      voiceAssistant: "Голосовой ассистент",
      voiceAssistantSubtitle: "Настройка предпочтений голосового взаимодействия",
      memorySearch: "Локальный поиск по памяти",
      memorySearchSubtitle: "Поиск по прошлым разговорам (локально на устройстве)",
      notifications: "Уведомления",
      notificationsSubtitle: "Настройки push-уведомлений",
      attachments: "Вложения",
      attachmentsSubtitle: "Настройки загрузки файлов",
      sourceControl: "Контроль версий",
      sourceControlSubtitle: "Стратегия коммитов и поведение бэкенда",
      automations: "Автоматизации",
      automationsSubtitle: "Управление расписаниями и повторяющимися запусками",
      executionRunsSubtitle: "Запуски выполнения на разных машинах",
      connectedServices: "Подключенные сервисы",
      connectedServicesSubtitle: "Подписки Claude/Codex и OAuth‑профили",
      channelBridges: "Мосты каналов",
      channelBridgesSubtitle: "Подключайте внешние чаты (Telegram) к сессиям",
      featuresTitle: "Возможности",
      featuresSubtitle: "Включить или отключить функции приложения",
      pets: "Питомцы",
      petsSubtitle: "Выберите Blink и питомцев-компаньонов для устройства",
    developer: "Разработчик",
    developerTools: "Инструменты разработчика",
    about: "О программе",
    actionsSettingsAboutSubtitle:
      "Включайте или отключайте действия глобально, по поверхности (UI/голос/MCP) и по размещению (где они отображаются в интерфейсе). Отключённые действия блокируются по принципу fail‑closed во время выполнения.",
    aboutFooter:
      "Happier Coder — мобильное приложение для работы с Codex и Claude Code. По умолчанию использует сквозное шифрование, с восстановлением аккаунта на других ваших устройствах. Не связано с Anthropic.",
    whatsNew: "Что нового",
    whatsNewSubtitle: "Посмотреть последние обновления и улучшения",
    reportIssue: "Сообщить о проблеме",
    privacyPolicy: "Политика конфиденциальности",
    termsOfService: "Условия использования",
    rateUs: "Оценить Happier",
    rateUsSubtitle: "Если вам нравится приложение, быстрая оценка очень поможет нам",
    eula: "EULA",
    supportUs: "Поддержите нас",
    supportUsSubtitlePro: "Спасибо за вашу поддержку!",
    supportUsSubtitle: "Поддержать разработку проекта",
    scanQrCodeToAuthenticate: "Отсканируйте QR‑код, чтобы подключить терминал",
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
        actionsSubtitle: "Выберите, где будет отображаться каждое действие в приложении, голосовой связи и интеграции.",
    prompts: "Промпты и скиллы",
    promptsSubtitle: "Библиотека промптов, шаблоны и стеки",
    servers: "Relay",
			    serversSubtitle: "Сохранённые Relay, группы и значения по умолчанию",
				    systemStatus: "Состояние системы",
				    systemStatusSubtitle: "Relay, аккаунт, машины, демон",
		    mcpServers: "MCP-серверы",
		    mcpServersSubtitle: "Управление серверами MCP и привязками",
		    mcpServersComingSoon: "Настройки серверов MCP появятся в ближайшее время.",
		    mcpServersStrictMode: "Строгий режим",
		    mcpServersStrictModeSubtitle: "Закрытие при сбое, если настройки сервера MCP недействительны.",
		    mcpServersCatalogTitle: "Каталог",
		    mcpServersUnnamed: "Безымянный сервер",
		    mcpServersEmptyTitle: "Серверов MCP пока нет",
		    mcpServersEmptySubtitle: "Добавьте серверы MCP, чтобы использовать их в сеансах.",
		    mcpServersAddServer: "Добавить сервер",
		    mcpServersAddServerSubtitle: "Создайте новую запись сервера MCP.",
		    mcpServersEditorTitle: "MCP-сервер",
		    mcpServersPickSecretTitle: "Выберите секрет",
		    mcpServersPickSecretNoneSubtitle: "Секрет не выбран",
		    mcpServersEditorBasics: "Основы",
		    mcpServersEditorStdio: "студия",
		    mcpServersEditorRemote: "Удаленный",
		    mcpServersEditorBindings: "Привязки",
		    mcpServersFieldName: "Имя",
		    mcpServersFieldTitle: "Заголовок",
		    mcpServersFieldTitlePlaceholder: "Необязательный отображаемый заголовок",
		    mcpServersFieldTransport: "Транспорт",
		    mcpServersFieldCommand: "Команда",
		    mcpServersFieldArgs: "Аргументы",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "Связывание",
		    mcpServersBindingEnabled: "Включено",
		    mcpServersBindingEnabledSubtitle: "Включить или выключить эту привязку",
		    mcpServersBindingTarget: "Цель",
		    mcpServersBindingTargetSubtitle: "Где доступен этот сервер",
		    mcpServersBindingMachine: "Машина",
		    mcpServersBindingMachineSubtitle: "Выберите машину",
		    mcpServersBindingDeleteSubtitle: "Удалить эту привязку",
		    mcpServersBindingTargetAllMachines: "Все машины",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `Machine: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `Workspace: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "Включить на каждой машине",
		    mcpServersBindingTargetMachineTitle: "Машина",
		    mcpServersBindingTargetMachineSubtitle: "Включить на одной машине",
		    mcpServersBindingTargetWorkspaceTitle: "Рабочая область",
		    mcpServersBindingTargetWorkspaceSubtitle: "Включить только для определенного пути к рабочей области",
		    mcpServersValidationFailed: "Настройки сервера MCP недействительны.",
		    mcpServersServerNotFound: "Сервер не найден.",
		    mcpServersBindingsEmptyTitle: "Привязок пока нет",
		    mcpServersBindingsEmptySubtitle: "Добавьте привязку для использования этого сервера.",
		    mcpServersAddBinding: "Добавить привязку",
		    mcpServersAddBindingSubtitle: "Включите этот сервер для компьютеров или рабочих пространств.",
		    mcpServersSaveDisabledSubtitle: "Нет изменений для сохранения.",
		    mcpServersDeleteTitle: "Удалить MCP-сервер?",
		    mcpServersDeleteConfirm: ({ name }: { name: string }) => `Delete "${name}"?`,
		    mcpServersDeleteSubtitle: "Удалите этот сервер из своего каталога",
		    mcpServersNoMachineSelected: "Машина не выбрана",
		    mcpServersDetectedTitle: "Обнаружено из конфигураций провайдера",
		    mcpServersDetectedMachineTitle: "Машина",
		    mcpServersDetectedRefreshTitle: "Обновить обнаруженные серверы",
		    mcpServersDetectedRefreshSubtitle: "Сканировать файлы конфигурации поставщика на этом компьютере",
		    mcpServersDetectedWarningsTitle: "Предупреждения об обнаружении",
		    mcpServersDetectedEmptyTitle: "Серверы MCP не обнаружены",
		    mcpServersDetectedEmptySubtitle: "Нажмите «Обновить», чтобы просканировать конфигурации Claude/Codex/OpenCode.",
		    mcpServersImportTitle: "Импортировать сервер MCP?",
		    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) => `Import "${name}" from ${provider}?`,
		    mcpServersImportAction: "Импорт",
		    mcpServersBindingSummaryAllMachines: "Все машины",
		    mcpServersBindingSummaryMachines: ({ count }: { count: number }) => `${count} machine${count === 1 ? "" : "s"}`,
		    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) => `${count} workspace${count === 1 ? "" : "s"}`,
		    mcpServersBindingSummaryNone: "Не связан",
		    mcpServersPickWorkspaceTitle: "Выберите корень рабочей области",
		    mcpServersBindingWorkspaceRootTitle: "Корень рабочей области",
		    mcpServersBindingOverridesTitle: "Переопределения",
		    mcpServersBindingOverridesNone: "Никаких переопределений",
		    mcpServersBindingOverridesCount: ({ count }: { count: number }) => `${count} override${count === 1 ? "" : "s"}`,
		    mcpServersEditorEnv: "Среда",
		    mcpServersEnvAdd: "Добавить переменную окружения",
		    mcpServersEnvAddSubtitle: "Установите переменные среды для этого сервера",
		    mcpServersEnvEmptyTitle: "Нет переменных окружения",
		    mcpServersEnvEmptySubtitle: "Добавьте переменные окружения или используйте сохраненные секреты.",
		    mcpServersEditorHeaders: "Заголовки",
		    mcpServersHeadersAdd: "Добавить заголовок",
		    mcpServersHeadersAddSubtitle: "Установите заголовки HTTP/SSE для этого сервера",
		    mcpServersHeadersEmptyTitle: "Нет заголовков",
		    mcpServersHeadersEmptySubtitle: "Добавьте заголовки, если ваш сервер требует авторизации.",
		    mcpServersEnvEditorTitle: "Редактировать переменную окружения",
		    mcpServersHeadersEditorTitle: "Изменить заголовок",
		    mcpServersEnvKeyLabel: "Имя переменной окружения",
		    mcpServersEnvKeyPlaceholder: "API_KEY",
		    mcpServersHeaderKeyLabel: "Название заголовка",
		    mcpServersHeaderKeyPlaceholder: "Авторизация",
		    mcpServersValueSourceTitle: "Источник значения",
		    mcpServersArgsPlaceholder: "--flag\nvalue",
		    mcpServersValueSourceLiteral: "Буквальный",
		    mcpServersValueSourceLiteralSubtitle: "Сохраните значение (поддерживаются шаблоны ${VAR})",
		    mcpServersValueSourceSavedSecret: "Сохраненный секрет",
		    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `Сохранённый секрет: ${name}`,
		    mcpServersValueSourceSavedSecretSubtitle: "Ссылка на сохраненный секрет",
		    mcpServersValueLiteralLabel: "Ценить",
		    mcpServersValueLiteralPlaceholder: "Значение или ${ENV_VAR}",
		    mcpServersValueSecretLabel: "Сохраненный секрет",
		    mcpServersValueSecretSelect: "Выберите секрет",
		    mcpServersValueSecretSelectSubtitle: "Выберите сохраненный секрет",
		    mcpServersKeyInvalid: "Ключ недействителен.",
		    mcpServersKeyAlreadyExists: "Ключ уже существует.",
		    mcpServersOverridesStdioTitle: "Стдио переопределяет",
		    mcpServersOverridesCommandTitle: "Команда отмены",
		    mcpServersOverridesCommandSubtitle: "Используйте другую команду для этой привязки",
		    mcpServersOverridesArgsTitle: "Переопределить аргументы",
		    mcpServersOverridesArgsSubtitle: "Используйте разные аргументы для этой привязки (пробел = пустые аргументы)",
		    mcpServersOverridesRemoteTitle: "Удаленное переопределение",
		    mcpServersOverridesUrlTitle: "Переопределить URL-адрес",
		    mcpServersOverridesUrlSubtitle: "Используйте другой URL-адрес для этой привязки",
		    mcpServersOverridesEnvPatchTitle: "Патч конверта",
		    mcpServersOverridesEnvPatchEmptyTitle: "Никаких переопределений окружения",
		    mcpServersOverridesEnvPatchEmptySubtitle: "Добавьте переопределения или удаления для переменных окружения.",
		    mcpServersOverridesHeadersPatchTitle: "Патч заголовков",
		    mcpServersOverridesHeadersPatchEmptyTitle: "Нет переопределения заголовка",
		    mcpServersOverridesHeadersPatchEmptySubtitle: "Добавьте переопределения или удаления заголовков.",
		    mcpServersOverridesDeleteValue: "Удалить этот ключ для этой привязки",
		    mcpServersOverridesEnvPatchAddTitle: "Добавить переопределение окружения",
		    mcpServersOverridesEnvPatchAddSubtitle: "Установите или переопределите переменную env для этой привязки.",
		    mcpServersOverridesEnvPatchDeleteTitle: "Удалить ключ окружения",
		    mcpServersOverridesEnvPatchDeleteSubtitle: "Удалите переменную env для этой привязки.",
		    mcpServersOverridesHeadersPatchAddTitle: "Добавить переопределение заголовка",
		    mcpServersOverridesHeadersPatchAddSubtitle: "Установить или переопределить заголовок для этой привязки",
		    mcpServersOverridesHeadersPatchDeleteTitle: "Удалить ключ заголовка",
		    mcpServersOverridesHeadersPatchDeleteSubtitle: "Удалить заголовок для этой привязки",
		    mcpServersOverridesDeleteEnvTitle: "Удалить ключ окружения",
		    mcpServersOverridesDeleteEnvPrompt: "Введите имя переменной среды, которую необходимо удалить для этой привязки.",
		    mcpServersOverridesDeleteHeaderTitle: "Удалить ключ заголовка",
		    mcpServersOverridesDeleteHeaderPrompt: "Введите имя заголовка, который необходимо удалить для этой привязки.",
		    mcpServersOverridesCommandRequired: "Переопределение команды включено, но пусто.",
		    mcpServersOverridesUrlRequired: "Переопределение URL-адреса включено, но пусто.",
		    mcpServersTestTitle: "Тест",
		    mcpServersTestFooter: "Запускается на выбранной машине. ",
		    mcpServersTestMachineTitle: "Тест на машине",
		    mcpServersTestBindingTitle: "Использовать привязку",
		    mcpServersTestNoBinding: "Нет привязки",
		    mcpServersTestNoBindingSubtitle: "Тестирование без переопределения привязки",
		    mcpServersTestDirectoryTitle: "Рабочий каталог",
		    mcpServersTestDirectorySubtitle: "Нажмите, чтобы установить каталог",
		    mcpServersTestDirectoryPrompt: "Введите рабочий каталог для теста.",
		    mcpServersTestRunTitle: "Тестовый сервер",
		    mcpServersTestRunSubtitle: "Подключите и перечислите инструменты",
		    mcpServersTestResultOkTitle: "Тест пройден",
		    mcpServersTestResultOkSubtitle: ({ toolCount, durationMs }: { toolCount: number; durationMs: number }) => `${toolCount} tools · ${durationMs}ms`,
		    mcpServersTestResultErrorTitle: "Тест не пройден",
		    ...mcpServersUxTranslationExtension,
            ...acpCatalogTranslationExtension.settings,

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

    remoteHostsTitle: "Удалённые хосты",
    remoteHostsDesktopOnlyTitle: "Удалённые хосты доступны только на десктопе",
    remoteHostsDesktopOnlySubtitle: "Управляйте сохранёнными SSH-хостами на десктопе.",
    remoteHostsManagementDisabledTitle: "Управление удалёнными хостами отключено",
    remoteHostsManagementDisabledSubtitle: "Эта сборка не позволяет управлять удалёнными хостами.",
    remoteHostsEmptyTitle: "Нет удалённых хостов",
    remoteHostsEmptySubtitle: "Добавьте удалённый хост, чтобы переиспользовать SSH-учётные данные в настройке.",
    remoteHostsAddHost: "Добавить удалённый хост",
    remoteHostsAddHostTitle: "Добавить удалённый хост",
    remoteHostsEditHostTitle: "Редактировать удалённый хост",
    remoteHostsHostGroupTitle: "Хост",
    remoteHostsSshGroupTitle: "SSH",
    remoteHostsSecretMaterialGroupTitle: "Секретные данные",
    remoteHostsSavePasswordLabel: "Сохранить пароль",
    remoteHostsPasswordSavedTitle: "Пароль сохранён",
    remoteHostsPasswordSavedSubtitle: "Оставьте пустым, чтобы не менять.",
    remoteHostsStorePrivateKeyLabel: "Сохранить приватный ключ (зашифрованный)",
    remoteHostsPrivateKeyLabel: "Приватный ключ",
    remoteHostsPrivateKeySavedHint: "Приватный ключ уже сохранён. Оставьте пустым, чтобы не менять.",
    remoteHostsSecretMaterialDisabledTitle: "Сохранение секретов отключено",
    remoteHostsSecretMaterialDisabledSubtitle: "Эта сборка не позволяет хранить пароли или приватные ключи.",
    remoteHostsSetupAsMachineTitle: "Настроить как машину Happier",
    remoteHostsSetupAsMachineFailed: "Не удалось настроить этот хост как машину Happier.",
    remoteHostsConnectFromThisDeviceTitle: "Подключиться с этого устройства",
    remoteHostsConnectFromThisDeviceSubtitle: "Только это устройство. Открывает локальный SSH-туннель для этой сессии приложения.",
    remoteHostsConnectFromThisDeviceFailed: "Не удалось открыть локальный SSH-туннель.",
    remoteHostsNativeSshTunnelRequiresEngine: "Для запуска нативных SSH-туннелей с этого устройства нужна сборка нативного SSH-движка.",
    remoteHostsSshTunnelGroupTitle: "Доступ к удаленному хосту с этого устройства",
    remoteHostsSshTunnelActiveTitle: ({ host }: { host: string }) => `SSH-туннель активен для ${host}`,
    remoteHostsSshTunnelActiveSubtitle: ({ url }: { url: string }) => `Только это устройство. Локальная конечная точка: ${url}`,
    remoteHostsSshTunnelStopTitle: "Остановить локальный SSH-туннель",
    remoteHostsUseAsRelayHostTitle: "Использовать как хост Relay",
    remoteHostsUseAsRelayHostSubtitle: "Настройте доступ Relay на этом SSH-хосте.",
    remoteHostsConfigureAccessTitle: "Настроить доступ",
    remoteHostsConfigureAccessSubtitle: "Выберите, как этот удалённый хост будет доступен.",
    remoteHostsOpenDetailsTitle: "Сведения о хосте",
    remoteHostsRelayAccessGroupTitle: "Удалённый доступ",
    remoteHostsRelayAccessActiveTitle: ({ host }: { host: string }) => `Настройка доступа для ${host}`,
    remoteHostsRelayAccessActiveSubtitle: "Команды доступа Relay выполняются на удалённом хосте через SSH. Это не создаёт SSH-туннель.",
    remoteHostsMissingServerUrl: "Выберите сервер перед настройкой удалённой машины.",
    remoteHostsRelayAccessIdentityFileRequired: "Для доступа Relay на этом хосте нужен локальный файл идентификации SSH.",
    remoteHostsTestConnectionTitle: "Проверить соединение",
    remoteHostsInstallOrUpdateCliTitle: "Установить или обновить CLI",
    remoteHostsDaemonServiceInstallOrUpdateTitle: "Установить или обновить службу демона",
    remoteHostsDaemonServiceStartTitle: "Запустить службу демона",
    remoteHostsDaemonServiceStopTitle: "Остановить службу демона",
    remoteHostsDaemonServiceRestartTitle: "Перезапустить службу демона",
    remoteHostsRelayRuntimeStatusTitle: "Статус среды выполнения Relay",
    remoteHostsRelayRuntimeInstallOrUpdateTitle: "Установить или обновить среду выполнения Relay",
    remoteHostsRelayRuntimeStartTitle: "Запустить среду выполнения Relay",
    remoteHostsRelayRuntimeStopTitle: "Остановить среду выполнения Relay",
    remoteHostsRelayRuntimeRestartTitle: "Перезапустить среду выполнения Relay",
    remoteHostsPortLine: ({ port }: { port: number }) => `Порт: ${port}`,
    remoteHostsActiveTaskTitle: "Системная задача",
    remoteHostsHostTrustTitle: "Доверять SSH-хосту?",
    remoteHostsReplaceHostKeyTitle: "Заменить ключ SSH-хоста?",
    remoteHostsReplaceHostKeyAction: "Заменить ключ хоста",
    remoteHostsHostKeyCurrentFingerprintLabel: "Текущий доверенный отпечаток",
    remoteHostsHostKeyNewFingerprintLabel: "Новый отпечаток",
    remoteHostsPasswordRequiredTitle: "Требуется пароль SSH",
    remoteHostsRememberHostKeyTitle: "Запомнить этот ключ SSH-хоста?",
    remoteHostsRememberHostKeyAction: "Доверять и запомнить",
    remoteHostsTrustOnceAction: "Доверять один раз",
    remoteHostsPrivateKeyPassphraseTitle: "Парольная фраза закрытого ключа SSH",
    remoteHostsKeyboardInteractiveTitle: "Аутентификация SSH",
    remoteHostsKeyboardInteractivePromptLabel: "Запрос SSH",
    remoteHostsTrustedHostKeysTitle: "Доверенные ключи SSH-хостов",
    remoteHostsTrustedHostKeyRemoveTitle: "Удалить доверенный ключ SSH-хоста?",
    remoteHostsTrustedHostKeysClearTitle: "Очистить доверенные ключи SSH-хостов",
    remoteHostsConnectionSucceeded: "Соединение успешно.",
    remoteHostsConnectionFailed: "Не удалось подключиться.",
    sshConfiguredHostPickerTitle: "Предложенные SSH-хосты",
    sshConfiguredHostPickerSubtitle: "Заполните из локальной конфигурации SSH или known_hosts.",
    sshConfiguredHostPickerRefreshingSubtitle: "Обновляем предложения; показываем последние результаты.",
    sshConfiguredHostPickerSourceSshConfig: "Конфигурация SSH",
    sshConfiguredHostPickerSourceKnownHosts: "known_hosts",
    sshConfiguredHostPickerUnsupportedTitle: "Введите данные SSH вручную",
    sshConfiguredHostPickerUnsupportedSubtitle: "Локальное обнаружение SSH доступно только в настольном приложении.",
    sshConfiguredHostPickerLoadingTitle: "Поиск SSH-хостов…",
    sshConfiguredHostPickerLoadingSubtitle: "Проверяем локальную конфигурацию SSH и known_hosts через настольный мост.",
    sshConfiguredHostPickerEmptyTitle: "Нет предложенных SSH-хостов",
    sshConfiguredHostPickerEmptySubtitle: "Введите данные SSH вручную или обновите после изменения конфигурации SSH.",
    sshConfiguredHostPickerErrorTitle: "Не удалось загрузить SSH-предложения",
    sshConfiguredHostPickerRefreshTitle: "Обновить SSH-предложения",
    sshConfiguredHostPickerRefreshingTitle: "Обновляем SSH-предложения",
    machineSetupStepResolveRelay: "Проверка существующих компонентов",
    machineSetupStepCheckAuth: "Проверка статуса входа",
    machineSetupStepConfigureRelay: "Подключение к Relay",
    machineSetupStepAuthRequest: "Подтвердите этот компьютер",
    machineSetupStepAuthWait: "Ожидание подтверждения",
    machineSetupStepInstallService: "Установка фоновой службы",
    machineSetupStepStartService: "Запуск фоновой службы",
    machineSetupStepVerifyService: "Проверка фоновой службы",
    machineSetupRemoteSshTargetPlaceholder: "user@host",
    machineSetupRemoteSshUsernameLabel: "Имя пользователя SSH",
    machineSetupRemoteSshUsernamePlaceholder: "ubuntu",
    machineSetupRemoteSshHostLabel: "Хост SSH",
    machineSetupRemoteSshHostPlaceholder: "example.test",
    machineSetupRemoteSshPortLabel: "Порт SSH",
    machineSetupRemoteSshPortPlaceholder: "22",
    machineSetupRemoteSshAuthMethodLabel: "Метод аутентификации",
    machineSetupRemoteSshPasswordAuthLabel: "Использовать пароль",
    machineSetupRemoteSshPrivateKeyMaterialLabel: "Вставьте приватный ключ",
    machineSetupRemoteSshPasswordLabel: "Пароль SSH",
    relayAccess: {
      title: "Доступ к Relay",
      footer: "Выберите, как телефон подключается к этому Relay.",
      statusTitle: "Статус",
      statusNotConfigured: "Ещё не настроено",
      statusWorking: "Проверяем доступ",
      statusEnabled: "Включено",
      statusDisabled: "Выключено",
      statusNeedsAuth: "Требуется вход",
      statusError: "Ошибка",
      statusUnknown: "Неизвестно",
      shareableUrlTitle: "Общий URL",
      methodTitle: "Способ доступа",
      saveAction: "Сохранить способ доступа",
      disableAction: "Отключить доступ к Relay",
      refreshAction: "Обновить статус доступа",
      progressStepInspect: "Проверить текущую конфигурацию",
      progressStepCheck: "Проверить статус доступа",
      progressStepPersist: "Сохранить конфигурацию доступа",
      progressStepApply: "Применить конфигурацию доступа",
      progressStepVerify: "Проверить URL доступа",
      progressStepDisable: "Отключить доступ к Relay",
      providers: {
        localOnly: {
          title: "Только локально",
          subtitle: "К Relay можно подключиться только с этого компьютера.",
        },
        lan: {
          title: "LAN / свой URL",
          subtitle: "Используйте уже существующий URL (LAN IP или туннель).",
        },
        tailscaleServe: {
          title: "Tailscale Serve",
          subtitle: "Приватный URL для вашего tailnet (рекомендуется).",
        },
        tailscaleFunnel: {
          title: "Tailscale Funnel",
          subtitle: "Публичный URL через Funnel.",
        },
        cloudflareNamed: {
          title: "Туннель Cloudflare",
          subtitle: "Публичный URL через именованный Cloudflare Tunnel.",
        },
      },
      fields: {
        urlLabel: "URL Relay",
        hostnameLabel: "Имя хоста",
        tokenLabel: "Токен",
      },
      missingUrl: "Введите URL Relay, чтобы продолжить.",
      missingHostname: "Введите имя хоста, чтобы продолжить.",
      missingToken: "Введите токен, чтобы продолжить.",
      webHandoffTitle: "Запустите на компьютере",
      webHandoffSubtitle: "Используйте CLI для настройки доступа к Relay, затем вернитесь сюда и обновите.",
    },
    accessEndpoints: {
      status: {
        refreshing: 'Обновление каналов доступа',
      },
      scope: {
        availableToOtherDevices: 'Доступно для других устройств',
        thisDeviceOnly: 'Только это устройство',
      },
      direction: {
        makeCurrentServerReachable: 'Сделать этот сервер доступным',
        reachRemoteServerFromThisDevice: 'Подключиться к удалённому серверу с этого устройства',
        unknown: 'Канал доступа',
      },
      kind: {
        'relay-access-provider': 'Доступ через Relay',
        'ssh-tunnel-desktop': 'Настольный SSH-туннель',
        'ssh-tunnel-native': 'Нативный SSH-туннель',
        'server-profile-url': 'URL сервера',
        'peer-mediation': 'Посредничество между узлами',
        'manual-url': 'URL вручную',
      },
      recommendedUse: {
        'multi-device': 'Лучше для других устройств',
        'native-this-device': 'Работает в этом нативном приложении',
        'hosted-web': 'Работает из размещённой веб-версии',
        'lan-only': 'Только LAN или частная сеть',
        diagnostic: 'Требует внимания',
      },
      limitation: {
        'this-device-only': 'Только это устройство',
        'not-hosted-web-compatible': 'Недоступно для размещённой веб-версии',
        'not-public-share-url': 'Это не публичный URL для общего доступа',
        'session-scoped': 'Ограничено сеансом',
        'authentication-failed': 'SSH-аутентификация не удалась',
        'foreground-only': 'Требует, чтобы приложение оставалось на переднем плане',
        'host-key-mismatch': 'SSH-ключ хоста изменился',
        'host-key-rejected': 'SSH-ключ хоста был отклонён',
        'host-key-untrusted': 'SSH-ключ хоста пока не является доверенным',
        'platform-suspended': 'Приостановлено, пока приложение остановлено системой',
        'loopback-bind-failed': 'Не удалось привязать локальный порт туннеля',
        'network-captive-portal': 'Сеть перехватила SSH-соединение',
        'remote-service-unreachable': 'Удалённый сервис недоступен через туннель',
        'requires-auth': 'Требуется SSH-аутентификация',
        'requires-host-key-trust': 'Требуется доверие к ключу хоста',
      },
      remediation: {
        tailscale: {
          install: 'Установить Tailscale',
          login: 'Войти в Tailscale',
          serve: {
            enable: 'Включить Tailscale Serve',
            approve: 'Одобрить Tailscale Serve',
          },
          funnel: {
            approve: 'Одобрить Tailscale Funnel',
          },
        },
        cloudflare: {
          configure: 'Настроить туннель Cloudflare',
        },
        serverProfile: {
          configureShareableUrl: 'Настроить URL для общего доступа',
        },
        remoteHost: {
          add: 'Добавить удалённый хост',
          setup: 'Настроить удалённый хост',
        },
        sshTunnel: {
          start: 'Запустить SSH-туннель',
          reuse: 'Использовать существующий SSH-туннель',
          stop: 'Остановить SSH-туннель',
          authenticate: 'Аутентифицировать SSH-туннель',
          trustHost: 'Доверять SSH-ключу хоста',
        },
      },
    },
    systemTaskOpenLogs: "Открыть логи",
    systemTaskOpenLogsFailed: "Не удалось открыть папку логов.",},

		  systemStatus: {
		    sections: {
		      application: "Приложение",
		      updates: "Обновления",
		      appHealth: "Состояние приложения и синхронизации",
		      currentServer: "Текущий Relay",
      identity: "Вход в аккаунт",
      configuredServers: "Настроенные Relay",
      machinesActiveServer: "Машины (активный Relay)",
      machinesOtherServer: ({ server }: { server: string }) => `Машины (${server})`,
      actions: "Действия",
    },
    application: {
      appVersion: "Версия приложения",
      nativeVersion: "Нативная версия",
      buildNumber: "Номер сборки",
      applicationId: "ID приложения",
      updateChannel: "Канал обновления",
      updateId: "ID текущего обновления",
      runtimeVersion: "Версия runtime",
      updateCreatedAt: "Время текущего обновления",
      launchSource: "Источник запуска",
      launchSourceEmbedded: "Встроенный нативный бинарник",
      launchSourceOta: "Загруженное OTA-обновление",
      launchSourceUnknown: "Неизвестно",
    },
    updates: {
      otaStatus: "Статус OTA",
      lastChecked: "Последняя проверка",
      openStore: "Открыть обновление в магазине",
      available: "Доступно",
      checkNow: "Проверить сейчас",
      checkNowSubtitle: "Вручную проверить, есть ли более новое OTA-обновление в текущем канале.",
      applyNow: "Применить обновление сейчас",
      disabled: "Отключено",
      applying: "Применение обновления",
      readyToApply: "Готово к применению",
      downloading: "Загрузка",
      downloadingProgress: ({ progress }: { progress: string }) => `Загрузка (${progress})`,
      checking: "Проверка",
      error: "Ошибка",
      upToDate: "Актуально",
      unknown: "Неизвестно",
    },
    ui: {
      dataReady: "Данные готовы",
      realtime: "В реальном времени",
      socket: "Сокет",
      socketLastError: ({ error }: { error: string }) => `Последняя ошибка: ${error}`,
      lastSync: "Последняя синхронизация",
    },
    server: {
      activeServer: "Активный Relay",
    },
    identity: {
      accountId: "ID аккаунта",
      username: "Имя пользователя",
    },
    servers: {
      noneConfigured: "Relay не настроены",
      active: "Активный",
    },
    machines: {
      none: "Нет машин",
      status: ({ status }: { status: string }) => `Статус: ${status}`,
    },
    machine: {
      unknownHost: "Неизвестная машина",
      online: "В сети",
      offline: "Не в сети",
      fetchDoctorSnapshot: {
        loading: "Получаем relay/аккаунт демона…",
        invalid: "Не удалось прочитать doctor snapshot с машины",
      },
      daemonAttributionUnknown: "Relay/аккаунт демона: неизвестно",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `Демон: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `Проверено: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "Несоответствие",
    time: {
      secondsAgo: ({ count }: { count: number }) => `${count}с назад`,
      minutesAgo: ({ count }: { count: number }) => `${count}м назад`,
      hoursAgo: ({ count }: { count: number }) => `${count}ч назад`,
      daysAgo: ({ count }: { count: number }) => `${count}д назад`,
    },
    actions: {
      runDiagnosis: "Запустить диагностику",
      runDiagnosisSubtitle: "Выявляет несоответствия relay/аккаунт/демон",
      refreshMachineAttribution: "Обновить атрибуцию демона",
      refreshMachineAttributionSubtitle: "Получить relay/аккаунт демона для нескольких машин в сети",
      copyJson: "Скопировать JSON состояния системы",
      copyJsonSubtitle: "Поделиться безопасным снимком для поддержки",
    },
  },

  diagnosis: {
    title: "Диагностика",
    sections: {
      overview: "Обзор",
      actions: "Действия",
      pasteDoctorJson: "Вставить CLI doctor JSON",
      machineRuns: "Машины",
      serverProbe: "Проверка сервера",
      findings: "Результаты",
    },
    overview: {
      activeServer: "Активный Relay",
      account: "Аккаунт",
      onlineMachines: "Машины в сети (активный сервер)",
      cachedAttribution: ({ count }: { count: number }) => `Доступно doctor snapshot в кэше: ${count}`,
    },
    actions: {
      run: "Запустить диагностику",
      runSubtitle: "Проверяет сервер, аккаунт, машины и куда подключён демон",
      copyReport: "Скопировать отчёт диагностики",
      copyReportSubtitle: "Скопировать безопасный JSON‑отчёт для поддержки",
    },
    pasteDoctorJson: {
      footer: "Совет: выполните `happier doctor --json` на компьютере и вставьте сюда.",
      placeholder: "{ \"capturedAt\": \"...\", ... }",
      parse: "Проверить вставленный JSON",
      ok: "Вставленный doctor JSON выглядит корректным.",
      helper: "Необязательно: вставьте doctor JSON, чтобы диагностировать несоответствия, если машина недоступна.",
      error: ({ error }: { error: string }) => `Некорректный doctor JSON: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "Машина вернула некорректный doctor snapshot",
    },
    machineRuns: {
      none: "Нет доступных машин в сети",
      idle: "Ожидание",
      loading: "Выполняется…",
      ready: "Готово",
      error: "Ошибка",
    },
    serverProbe: {
      title: "Диагностика сервера",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "Запустите диагностику, чтобы увидеть результаты",
      notRunSubtitle: "Запускаются безопасные, редактированные проверки (без логов, если не включать диагностику в баг‑репорт).",
      none: "Проблем не обнаружено",
      noneSubtitle: "Если проблема остаётся, отправьте баг‑репорт с диагностикой.",
      code: ({ code }: { code: string }) => `Код: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `Детали для ${code}`,
        steps: {
          reportIssue: "Отправьте баг‑репорт и приложите этот отчёт диагностики.",
        },
      },
      serverMismatch: {
        title: "Несоответствие сервера (UI vs демон)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Демон: ${machine}`,
        steps: {
          chooseAccount: "Определитесь, какой сервер/аккаунт использовать.",
          switchUiServer: "Сделайте так, чтобы UI и демон использовали один и тот же сервер.",
          restartDaemon: "Перезапустите демон с правильным сервером и попробуйте снова.",
        },
      },
      serverMismatchPasted: {
        title: "Несоответствие сервера (UI vs вставленное)",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • Вставлено: ${pasted}`,
      },
      settingsMismatch: {
        title: "Несоответствие настроек CLI и фактического сервера",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • resolved: ${resolved}`,
      },
      accountMismatch: {
        title: "Несоответствие аккаунта (UI vs демон)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Демон: ${machine}`,
        steps: {
          signInSameAccount: "Убедитесь, что UI и CLI входят в один и тот же аккаунт на одном сервере.",
          cliReauth: "В CLI: выйдите и заново выполните авторизацию на нужном сервере.",
        },
      },
      machineMissingAccount: {
        title: "У машины нет информации об аккаунте",
      },
      noOnlineMachines: {
        title: "Нет машин в сети",
        steps: {
          startDaemon: "Запустите демон (и убедитесь, что он работает постоянно).",
          checkNetwork: "Проверьте сеть и попробуйте снова.",
        },
      },
      serverDiagnosticsDisabled: {
        title: "Диагностика сервера отключена",
        steps: {
          ok: "Это нормально, если на вашем сервере диагностика отключена.",
        },
      },
      serverAuthError: {
        title: "Ошибка авторизации сервера (401)",
      },
      serverUnreachable: {
        title: "Сервер недоступен",
        steps: {
          checkServerUrl: "Проверьте URL сервера и подключение к сети.",
          tryAgain: "Повторите попытку чуть позже.",
        },
      },
      serverHttpError: {
        title: "HTTP‑ошибка диагностики сервера",
        subtitle: ({ status }: { status: string }) => `Сервер ответил: ${status}`,
      },
      activeServerNotInProfiles: {
        title: "Активный сервер не найден в сохранённых профилях",
      },
      multipleServers: {
        title: "Обнаружено несколько серверов на разных машинах",
      },
    },
  },

  connectedServices: {
    fallbackName: "Подключённый сервис",
    serviceNames: {
      claudeSubscription: "Подписка Claude",
      openaiCodex: "Codex от OpenAI",
      openai: "Ключ API OpenAI",
      anthropic: "Ключ API Anthropic",
      gemini: "Gemini от Google",
      github: "GitHub",

      bitbucket: "Bitbucket",},
    title: "Подключённые сервисы",
    authChip: {
      label: "Авторизация",
      labelWithCount: ({ count }: { count: number }) => `Авторизация: ${count}`,
      nativeLabel: "Нативная",
      connectedCountLabel: ({ count }: { count: number }) => `${count} подключено`,
    },
    authSwitch: {
      switchFailed: 'Не удалось сменить авторизацию для этой сессии.',
      confirmAction: 'Сменить авторизацию',
      errors: {
        groupGenerationConflict: 'Группа аккаунтов изменилась до завершения переключения. Обновите список аккаунтов и попробуйте снова.',
        providerStateSharingRequired: 'Provider state sharing must be enabled before this account can be used for the running session.',
        notGroupSelection: 'Choose an account group so Happier can switch away from an exhausted account automatically.',
        connectedServiceRequired: 'Choose a connected account before using this recovery action for the session.',
        profileActionRequired: 'The selected connected account needs attention before it can be used.',
        providerStateSharingUnavailable: 'Не удалось проверить настройки общего состояния провайдера на этой машине. Обновите подключение к демону и попробуйте снова.',
        profileDisconnected: 'Выбранный подключенный аккаунт нужно повторно аутентифицировать перед использованием.',
        profileMissing: 'Выбранный подключенный аккаунт больше недоступен. Обновите список аккаунтов и выберите другой.',
        groupMissing: 'Выбранная группа аккаунтов больше недоступна. Обновите список аккаунтов и выберите другую группу.',
        metadataUpdateFailed: 'Сессии не удалось сохранить новый выбор аутентификации. Попробуйте снова после завершения синхронизации сессии.',
        restartFailed: 'Не удалось перезапустить сессию с новым выбором аутентификации. Остановите сессию и попробуйте снова.',
        hotApplyFailed: 'Запущенная сессия отклонила новый выбор аутентификации. Перезапустите сессию и попробуйте снова.',
        agentMismatch: 'Этот выбор аутентификации не соответствует бэкенду сессии.',
        sessionNotFound: 'Эта сессия больше недоступна на выбранной машине.',
        unsupportedService: 'Этот бэкенд не поддерживает выбранный подключенный сервис.',
      },
      status: {
        liveApplied: 'Аутентификация переключена в текущем сеансе',
        credentialsRefreshed: 'Аутентификация обновлена',
        restarting: 'Перезапуск сессии',
        appliesOnNextResume: 'Применится при следующем возобновлении',
        retry: 'Authentication switch needs retry',
        partialApplication: "Аутентификация частично переключена",
        partialApplicationServiceFailed: ({ service }: { service: string }) => `${service}: аутентификация не удалась`,
        partialApplicationServiceNotApplied: ({ service }: { service: string }) => `${service}: аутентификация не применена`,
      },
      partialApply: {
        title: 'Аутентификация переключена частично',
        body: 'Новый аккаунт сохранён, но применить его к этой активной сессии удалось не полностью. Повторите попытку или откатите, чтобы оставить эту сессию на прежнем аккаунте.',
        retry: 'Повторить применение к этой сессии',
        revert: 'Вернуться к прежнему аккаунту',
      },
    },
    errors: {
      credentialReferencedByGroup: 'Эта подключённая учётная запись используется группой аккаунтов. Отключение удалит её из этих групп и при необходимости сбросит активный выбор.',
      runtimeCooldown: ({ time }: { time: string }) => `This account is cooling down until ${time}.`,
      runtimeCooldownOverrideTitle: 'Переключиться на аккаунт в режиме ожидания?',
      runtimeCooldownOverrideBody: ({ time }: { time: string }) =>
        `This account is cooling down until ${time}. Switch manually anyway?`,
      runtimeCooldownOverrideConfirm: 'Всё равно переключить',
      unknownResetTime: 'неизвестное время',
      generationConflict: 'Эта группа аккаунтов изменилась до завершения действия. Обновите список аккаунтов и повторите попытку.',
      generationConflictWithGeneration: ({ generation }: { generation: number }) =>
        `This account group changed before the action completed. Refresh the account list and try again. Current generation: ${generation}.`,
      generationRequired: 'Для этого действия нужна свежая версия группы аккаунтов. Обновите список аккаунтов и повторите попытку.',
      groupNotFound: 'Эта группа аккаунтов больше не существует. Обновите список аккаунтов и повторите попытку.',
      groupMemberNotFound: 'Этот аккаунт больше не входит в группу. Обновите список аккаунтов и повторите попытку.',
      profileNotFound: 'Этот подключённый аккаунт больше не существует. Обновите список аккаунтов и повторите попытку.',
      activeProfileNotMember: 'Активными можно сделать только включённых участников группы.',
      fallbackDisabled: 'Резервный выбор аккаунтов отключён на этом сервере.',
      duplicateMember: 'Этот аккаунт уже есть в группе.',
      groupAlreadyExists: 'Группа аккаунтов с таким id уже существует.',
      invalidGroup: 'Эта группа аккаунтов недействительна. Проверьте настройки и повторите попытку.',
      requestFailedWithStatus: ({ status }: { status: number }) => `The connected-service request failed (${status}). Refresh and try again.`,
      generic: 'Действие подключённого сервиса не выполнено. Обновите данные и повторите попытку.',
    },
    diagnostics: {
      title: {
        provider_session_state_unavailable_for_resume: 'Переключение недоступно',
        connected_service_materialization_identity_missing: 'Отсутствует идентификатор подключённого сервиса',
        resume_reachability_inputs_missing: 'Возобновление сессии нельзя проверить',
        metadata_update_failed: 'Выбор аутентификации не сохранён',
        no_eligible_group_member: 'Нет доступного резервного аккаунта',
        recovery_retry_scheduled: 'Восстановление провайдера запланировано',
                recovery_dead_lettered: 'Восстановление провайдера требует внимания',
                provider_account_adoption_mismatch: 'Провайдер не переключил аккаунт',
                post_switch_verification_failed: 'Аккаунт провайдера не удалось проверить',
                connected_service_credential_reconnect_required: "Подключенную учетную запись нужно переподключить",
                claude_subscription_missing_claude_code_scope: 'Для доступа к Claude Code нужно переподключение',
        claude_subscription_native_auth_materialization_failed: 'Не удалось подготовить учетные данные Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Токен настройки Claude не может запустить режим Unified',
      },
      status: {
        providerSessionStateUnavailableForResume: "Не удалось перенести состояние сеанса",
        providerAccountAdoptionMismatch: "Провайдер остался в другом аккаунте",
        postSwitchVerificationFailed: "Не удалось проверить аккаунт провайдера",
        recoveryRetryScheduled: "Повтор восстановления провайдера запланирован",
        metadataUpdateFailed: "Не удалось сохранить выбор аутентификации",
        noEligibleGroupMember: "Нет подходящего резервного аккаунта",
        provider_session_state_unavailable_for_resume: 'Состояние сессии не удалось перенести',
        connected_service_materialization_identity_missing: 'Отсутствует идентификатор подключённого сервиса',
        resume_reachability_inputs_missing: 'Возобновление сессии нельзя проверить',
        metadata_update_failed: 'Не удалось сохранить выбор аутентификации сессии',
        no_eligible_group_member: 'Нет подходящего резервного аккаунта',
        recovery_retry_scheduled: 'Запланирован повтор восстановления провайдера',
                recovery_dead_lettered: 'Восстановление провайдера исчерпало лимит повторов',
                provider_account_adoption_mismatch: 'Провайдер остался в другом аккаунте',
                post_switch_verification_failed: 'Аккаунт провайдера не удалось проверить',
                connected_service_credential_reconnect_required: "Подключенную учетную запись нужно переподключить",
                claude_subscription_missing_claude_code_scope: 'Переподключите подписку Claude для Claude Code',
        claude_subscription_native_auth_materialization_failed: 'Не удалось подготовить нативную авторизацию Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Переподключите Claude через OAuth для режима Unified',
      },
      body: {
        default: "Проверьте подключённые аккаунты и повторите попытку.",
        provider_session_state_unavailable_for_resume: ({ reason, agentId }: { reason: string; agentId: string }) =>
          `Проверьте подключенные аккаунты, затем начните новую сессию с выбранным аккаунтом или продолжите с текущим. ${agentId}: ${reason}.`,
        connected_service_materialization_identity_missing: 'В этой сессии нет идентификатора подключённого сервиса, нужного для повторного использования материализованного состояния провайдера. Начните заново с выбранным аккаунтом или продолжите с текущим.',
        resume_reachability_inputs_missing: ({ reason, agentId }: { reason: string; agentId: string }) =>
          `Демон не смог проверить состояние возобновления провайдера, потому что отсутствовали необходимые данные. ${agentId}: ${reason}.`,
        metadata_update_failed: 'Сессия не смогла сохранить новый выбор аутентификации. Повторите попытку после завершения синхронизации сессии.',
        no_eligible_group_member: 'Сейчас в этой группе нет аккаунта, подходящего для резерва. Проверьте подключённые аккаунты и при необходимости переподключите профиль.',
        recovery_retry_scheduled: 'Happier запланировал повтор восстановления провайдера. Можно повторить сейчас или проверить подключённые аккаунты.',
                recovery_dead_lettered: 'Happier исчерпал автоматические повторы восстановления провайдера. Проверьте подключённые аккаунты или переподключите выбранный профиль.',
                provider_account_adoption_mismatch: 'После переключения провайдер остался в другом аккаунте. Проверьте подключённые аккаунты или повторите переключение.',
                post_switch_verification_failed: 'Happier не смог проверить, что провайдер принял выбранный аккаунт. Проверьте подключённые аккаунты или повторите переключение.',
                connected_service_credential_reconnect_required: "Выбранную подключенную учетную запись нужно переподключить, прежде чем эту сессию можно будет возобновить. Переподключите профиль и повторите попытку.",
                claude_subscription_missing_claude_code_scope: 'Этот профиль Claude был подключен до выдачи областей Claude Code. Переподключите его, затем повторите сессию или переключение группы.',
        claude_subscription_native_auth_materialization_failed: 'Happier не смог создать файл нативных учетных данных Claude Code для этого профиля. Переподключите профиль или выберите другого участника группы.',
        claude_subscription_setup_token_not_supported_for_unified: 'Режим Claude Unified должен запускать CLI Claude с нативными учетными данными OAuth. Переподключите этот профиль через OAuth вместо токена настройки.',
      },
      actions: {
        viewLatestFork: "Открыть последнюю ветку",
        viewNativeFork: "Открыть нативную ветку",
      },
    },
    reconnect: {
      identityMismatchTitle: 'Обнаружен другой аккаунт провайдера',
      identityMismatchBody: 'Эти учетные данные похожи на данные другого аккаунта провайдера. Продолжайте только если хотите заменить сохраненную идентичность этого профиля.',
      identityMismatchConfirm: 'Заменить идентичность',
      targetMismatch: 'Это повторное подключение вернуло учётные данные для другого подключённого профиля. Запустите повторное подключение заново из целевого профиля.',
    },
    defaultAuth: {
      poolSuggestion: {
        body: ({ pool }: { pool: string }) => `Используйте пул ${pool}, чтобы сессии переключались в обход лимитов.`,
        accept: "Использовать пул",
        dismiss: "Скрыть",
      },
      title: "Конфигурация бэкенда по умолчанию",
      footer:
        "Выберите подключенный аккаунт, который каждый бэкенд будет использовать при запуске новой сессии.",
      agentDetailTitle: "Аутентификация по умолчанию",
      agentDetailFooter:
        "Записывает то же значение по умолчанию, что используется в настройках подключенных сервисов.",
      rowDetail: "По умолчанию",
      warning: {
        connected_profile_unavailable:
          "Подключенный аккаунт по умолчанию недоступен; используется нативная аутентификация.",
        connected_group_unavailable:
          "Подключенная группа по умолчанию недоступна; используется нативная аутентификация.",
        connected_group_disabled:
          "Подключенные группы здесь отключены; используется нативная аутентификация.",
        connected_service_unsupported:
          "Этот бэкенд не поддерживает этот подключенный сервис; используется нативная аутентификация.",
      },
    },
    list: {
      empty: "Пока нет подключённых сервисов.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "подключённый", few: "подключённых", many: "подключённых" })}`,
      needsReauth: "нужна повторная авторизация",
      notConnected: "не подключено",
    },
    providerStateSharing: {
      title: "Общее состояние провайдера",
      footer: "Авторизация подключённых сервисов остаётся изолированной. Конфигурация и состояние сессий используются совместно только там, где провайдер поддерживает это безопасно.",
      configTitle: "Использовать общую конфигурацию провайдера",
      agentConfigTitle: ({ agent }: { agent: string }) => `Общая конфигурация ${agent}`,
      configLinkedTitle: "Связать активную конфигурацию",
      configLinkedSubtitle: "Использовать ссылки там, где они поддерживаются, чтобы подключённые сессии читали текущую конфигурацию провайдера.",
      configCopiedTitle: "Копировать снимок конфигурации",
      configCopiedSubtitle: "Копировать конфигурацию провайдера при каждой материализации авторизации.",
      configIsolatedTitle: "Изолировать конфигурацию",
      configIsolatedSubtitle: "Не передавать нативную конфигурацию провайдера в home подключённых сервисов.",
      stateTitle: "Использовать общие сессии и состояние провайдера",
      agentStateTitle: ({ agent }: { agent: string }) => `Общие сессии и состояние ${agent}`,
      stateEnabledSubtitle: "Позволить поддерживаемым провайдерам возобновлять те же сессии между нативной и подключённой авторизацией.",
      stateDisabledSubtitle: "Хранить сессии и локальное состояние провайдера отдельно, если специальный поток провайдера не включил общий доступ.",
      sharedStatePrivacyTitle: "Использовать общее состояние провайдера",
      sharedStatePrivacyBody: ({ agent }: { agent: string }) =>
        `${agent} может читать локальные файлы сессий провайдера из home подключённых сервисов. Включайте это только для аккаунтов, которые готовы связать.`,
      unavailable: {
        notImplemented: "Общий доступ пока недоступен для этого провайдера.",
        dynamicDiagnosticsRequired: "Перед включением общего доступа нужна проверка доступности во время выполнения.",
      },
    },
    quota: {
      loading: "Загрузка…",
      error: ({ message }: { message: string }) => `Ошибка: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `Обновлено: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Обновлено: ${time} • устарело`,
      noData: "Пока нет данных по квоте",
      planLabel: ({ plan }: { plan: string }) => `План: ${plan}`,
      remaining: ({ percent }: { percent: string }) => `Осталось ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `Осталось ${percent} · сброс через ${reset}`,
      usageCount: ({ used, limit }: { used: number; limit: number }) => `Использовано ${used}/${limit}`,
      recoveryCreditTitle: ({ count }: { count: number }) => count === 1 ? 'Доступен 1 сброс лимита' : `Доступно сбросов лимита: ${count}`,
      recoveryCreditSubtitle: 'Примените сброс лимита, чтобы сразу восстановить исчерпанный лимит.',
      recoveryCreditExpires: ({ time }: { time: string }) => `Ближайшее истечение ${time}.`,
      recoveryCreditApplying: 'Применение…',
      recoveryCreditMachineUnavailable: 'Сейчас нет доступной машины, которая может применить этот сброс.',
      recoveryCreditNothingToReset: 'No exhausted usage window currently needs a reset.',
      recoveryCreditBadge: ({ count }: { count: number }) => count === 1 ? '1 сброс' : `${count} сброса`,
      duration: {
        now: 'сейчас',
        outdated: 'Неактуально',
        daysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    account: {
      refreshA11y: 'Обновить использование и лимиты',
      usedDetail: ({ used, limit }: { used: string; limit: string }) => `Использовано ${used}/${limit}`,
      usageCaption: 'Использование',
      resetsCaption: 'Сбросы',
      poolsLabel: 'Пулы',
      poolsCount: ({ count }: { count: number }) => count === 1 ? '1 пул' : `${count} пула`,
      planEmailSubtitle: ({ plan, email }: { plan: string; email: string }) => `${plan} · ${email}`,
      activeMemberA11y: 'Активный аккаунт',
      setActiveA11y: 'Сделать аккаунт активным',
      memberEnabledLabel: 'Аккаунт включен',
      resets: {
        now: 'сейчас',
        inDays: ({ days }: { days: number }) => days === 1 ? 'через 1 день' : `через ${days} дн.`,
        available: 'Доступен сброс лимита',
        rowLabel: ({ date, countdown }: { date: string; countdown: string }) =>
          countdown ? `Истекает ${date} · ${countdown}` : `Истекает ${date}`,
        confirmTitle: 'Применить сброс лимита?',
        confirmMessage: 'Это израсходует один доступный сброс для этого подключенного аккаунта.',
        confirmCta: 'Применить сброс',
        use: 'Использовать',
      },
    },
    pools: {
      title: 'Пулы',
      autoBadge: 'Авто',
      manualBadge: 'Вручную',
      memberWarningsA11y: ({ count }: { count: number }) =>
        count === 1 ? '1 участник требует внимания' : `${count} участников требуют внимания`,
      create: {
        title: 'Создать пул',
        subtitle: 'Группируйте подключенные аккаунты для автоматического fallback.',
      },
      empty: {
        title: 'Пулов пока нет',
        subtitle: 'Создайте пул, чтобы направлять сессии между несколькими подключенными аккаунтами.',
      },
      loadError: {
        title: "Не удалось загрузить пулы",
        subtitle: "Не удалось загрузить пулы аккаунтов. Проверьте подключение и повторите попытку.",
        staleTitle: "Показаны последние известные пулы",
        staleSubtitle: "Не удалось обновить последний список пулов. Повторите попытку, чтобы обновить его.",
        retry: "Повторить попытку",
      },
      detail: {
        summaryTitle: 'Сводка',
        summary: ({ count, strategy }: { count: number; strategy: string }) =>
          `${count} аккаунт${count === 1 ? '' : 'а'} · ${strategy}`,
        membersTitle: 'Участники',
        moveUp: 'Переместить вверх',
        moveDown: 'Переместить вниз',
        noMembersTitle: 'Участников пока нет',
        noMembersSubtitle: 'Добавьте подключенный аккаунт в этот пул.',
        serverActiveStatusTitle: "Сохранено на сервере",
        serverActiveStatusSubtitle: "Это сохранённая активная учётная запись. Офлайн-машины применят её после подключения; этот экран не утверждает, что все машины уже синхронизированы.",
        manualApplyDivergenceTitle: "Переключено на сервере, но не в активных сессиях",
        manualApplyDivergenceSubtitle: ({ detail }: { detail: string }) => `Активный аккаунт изменён на сервере, но применить его к активным сессиям не удалось (${detail}). Повторите попытку или вернитесь, чтобы всё осталось на предыдущем аккаунте.`,
        manualApplyRetry: "Повторить применение к активным сессиям",
        manualApplyRevert: "Вернуться к предыдущему аккаунту",
        machineTarget: {
            title: "Невозможно применить к активной сессии",
            noBoundSession: "Сейчас ни одна активная сессия не использует этот пул, поэтому переключение нельзя применить вживую. Запустите сессию в этом пуле и повторите попытку.",
            offline: "Машина, на которой выполняется сессия этого пула, офлайн, поэтому переключение не может её достичь. Верните машину в онлайн и повторите попытку.",
        },
        behaviorTitle: 'Поведение',
        advancedTitle: 'Дополнительно',
        advancedSubtitle: 'Настройте триггеры fallback и поведение восстановления.',
      },
      behavior: {
        autoRestorePrimaryTitle: 'Восстанавливать основной после сброса',
        autoRestorePrimarySubtitle: 'Возвращаться к основному аккаунту, когда его лимит использования сброшен.',
        switchOnGroupSubtitle: 'Разрешить этому условию запускать автоматическое переключение пула.',
        switchOn: {
          usageLimit: 'Лимит использования',
          authExpired: 'Аутентификация истекла',
          accountChanged: 'Аккаунт изменился',
          refreshFailure: 'Сбой обновления',
        },
      },
      delete: {
        title: 'Удалить пул',
        subtitle: 'Удалить этот пул и его конфигурацию fallback.',
        confirmTitle: 'Удалить пул?',
        confirmMessage: ({ name }: { name: string }) =>
          `Удалить ${name}? Сессии больше не будут использовать этот пул.`,
      },
    },
    oauthPaste: {
      invalidConfig: "Неверная конфигурация подключённого сервиса.",
      connectWebGroupTitle: "Подключить (web)",
      connectWebDescription:
        "Откройте URL авторизации, завершите OAuth в браузере, затем скопируйте и вставьте итоговый URL редиректа обратно в Happier.",
      openAuthorizationUrl: "Открыть URL авторизации",
      opensInNewTab: "Откроется в новой вкладке",
      preparing: "Подготовка…",
      pasteRedirectUrl: "Вставить URL редиректа",
      pasteRedirectUrlPlaceholder: "Вставить URL редиректа",
      pasteRedirectUrlPromptBody:
        "После завершения OAuth скопируйте итоговый URL редиректа из адресной строки браузера и вставьте его сюда.",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "Следующий шаг: войдите на открывшейся странице. Claude может показать строку кода вместо автоматического редиректа.",
          pasteRedirectUrlPromptBody:
            "1) Войдите на открывшейся странице. 2) Скопируйте итоговый URL или полное значение \"code#state\", показанное Claude. 3) Вставьте его в поле ниже.",
          pasteRedirectUrlPlaceholder: "Вставьте URL редиректа или code#state",
          errors: {
            missingState:
              "Отсутствует состояние OAuth. Если Claude показывает код, скопируйте полное значение \"code#state\", а не только код.",
          },
        },
      },
      tryDeviceInstead: "Попробовать аутентификацию устройства",
      tryEmbeddedInstead: "Попробовать встроенный браузер",
      working: "Выполняется…",
      alerts: {
        connectedTitle: "Подключено",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) подключено.`,
        failedToOpenUrl: "Не удалось открыть URL",
        failedToConnect: "Не удалось подключиться",
      },
      errors: {
        missingState: "Отсутствует состояние OAuth в URL редиректа.",
        stateMismatch: "Состояние OAuth не совпадает.",
      },
    },
    oauthEmbedded: {
      title: "Подключить (встроенный браузер)",
      description:
        "Запустите вход во встроенном браузере. Если не получится, используйте метод вставки URL редиректа.",
      startButton: "Начать вход",
    },
    deviceAuth: {
      invalidConfig: "Неверная конфигурация подключённого сервиса.",
      title: "Подключить (устройство)",
      description:
        "Откройте страницу проверки, введите код и держите этот экран открытым, пока подключение не завершится.",
      openVerificationUrl: "Открыть страницу проверки",
      userCode: "Код пользователя",
      securityHint:
        "Совет: нажмите «Копировать», чтобы скопировать код. Вводите его только на auth.openai.com. Никому не сообщайте этот код.",
      deviceAuthDisabledHint:
        "Если страница проверки сообщает, что авторизация по коду устройства отключена, включите «Enable device code authorization for Codex» в настройках ChatGPT и попробуйте снова.",
      preparing: "Подготовка…",
      waiting: "Ожидание подтверждения…",
      polling: "Проверка подтверждения…",
      usePasteInstead: "Вместо этого вставьте URL перенаправления",
      useBrowserInstead: "Вместо этого используйте встроенный браузер",
      alerts: {
        connectedTitle: "Подключено",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) подключено.`,
        failedToConnect: "Не удалось подключиться",
        failedToStart: "Не удалось запустить аутентификацию устройства",
      },
    },
    detail: {
      segments: { accounts: "Аккаунты", pools: "Пулы" },
      unknownService: "Неизвестный подключённый сервис.",
      actionsGroupTitle: "Действия",
      actions: {
        setDefault: "Сделать по умолчанию",
        unsetDefault: "Снять по умолчанию",
        editLabel: "Редактировать метку",
        reconnect: "Переподключить",
        openAccount: "Открыть аккаунт",
      },
      setDefaultProfileTitle: "Назначить профиль по умолчанию",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `По умолчанию: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Выберите профиль, который будет выбран по умолчанию",
      setProfileLabelTitle: "Задать метку профиля",
      setProfileLabelSubtitle:
        "Необязательная метка, отображаемая в списках авторизации",
      addOauthProfileTitle: "Добавить профиль OAuth",
      addOauthProfileSubtitle: "Подключить новый профиль аккаунта",
      addOauthProfileDeviceTitle: "Добавить через аутентификацию устройства",
      addOauthProfileDeviceSubtitle: "Рекомендуется для web/удалённых сред",
      addOauthProfilePasteTitle: "Добавить через вставку редиректа",
      addOauthProfilePasteSubtitle: "Ручной поток копирования/вставки URL редиректа",
      addOauthProfileBrowserTitle: "Добавить через встроенный браузер",
      addOauthProfileBrowserSubtitle: "Используйте встроенный браузер, если поддерживается",
      connectApiKeyTitle: "Подключить через API-ключ",
      connectApiKeySubtitle: "Вставьте API-ключ Anthropic",
      connectSetupTokenTitle: "Подключить setup-token",
      connectSetupTokenSubtitle: "Вставьте setup-token Claude (из claude setup-token)",
      connectAccessTokenTitle: "Подключить токен доступа",
      connectAccessTokenSubtitle: "Вставьте персональный токен доступа GitHub",
      openGithubTokenTemplateTitle: "Создать токен GitHub",
      openGithubTokenTemplateSubtitle: "Открыть GitHub с уже заполненными разрешениями, нужными Happier",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Отключить ${service} (${profileId})?`,
      disconnectGroupCleanupConfirmBody: ({ service, profileId, groups }: { service: string; profileId: string; groups: string }) =>
        `Отключить ${service} (${profileId}) и удалить из ${groups}?`,
      prompts: {
        profileIdTitle: "ID профиля",
        profileIdBody: "Используйте короткую метку, например work, personal, alt.",
        apiKeyTitle: "API-ключ",
        apiKeyBody: "Вставьте ваш API-ключ Anthropic.",
        apiKeyPlaceholder: "например, sk-ant-…",
        setupTokenTitle: "Токен настройки",
        setupTokenBody: "Вставьте ваш setup-token Claude (из claude setup-token).",
        setupTokenPlaceholder: "например, sk-ant-oat01-…",
        accessTokenTitle: "Токен доступа",
        accessTokenBody: "Вставьте ваш персональный токен доступа GitHub. Используйте fine-grained token с разрешениями Contents, Pull requests и Administration на чтение и запись, чтобы работали PR и публикация репозиториев.",
        accessTokenPlaceholder: "github_pat_…",
        profileLabelTitle: "Метка профиля",
        profileLabelBody: "Необязательно. Показывается в списках авторизации.",
        profileLabelPlaceholder: "Рабочий аккаунт",

        personalAccessTokenTitle: "Персональный токен доступа",
        personalAccessTokenBody: "Вставьте fine-grained personal access token GitHub.",
        personalAccessTokenPlaceholder: "github_pat_…",
        apiTokenTitle: "API-токен",
        apiTokenBody: "Вставьте API token провайдера или app password.",
        apiTokenPlaceholder: "API token",},
      alerts: {
        invalidProfileIdTitle: "Недопустимый ID профиля",
        invalidProfileIdBody:
          "Используйте буквы, цифры, дефис или подчёркивание (макс. 64).",
        unknownProfileTitle: "Неизвестный профиль",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Профиля «${profileId}» не существует для ${service}.`,
        failedToOpenTokenSetupUrl: "Не удалось открыть настройки токена GitHub.",
      },
      profiles: {
        empty: "Профилей пока нет.",
        connected: "Подключён",
        defaultBadge: "По умолчанию",
        needsReauth: "Нужна повторная авторизация",
      },
      groups: {
        title: "Группы аккаунтов",
        empty: "Групп аккаунтов пока нет.",
        subtitle: ({ count }: { count: number }) => `${count} аккаунтов`,
        subtitleWithActive: ({ profileId, count }: { profileId: string; count: number }) =>
          `Активный: ${profileId} • ${count} аккаунтов`,
        actionsTitle: "Действия группы аккаунтов",
        createTitle: "Создать группу аккаунтов",
        createSubtitle: "Группируйте подключённые профили для восстановления через fallback.",
        noProfilesTitle: "Нет подключённых профилей",
        noProfilesBody: "Подключите хотя бы один профиль перед созданием группы аккаунтов.",
        invalidGroupTitle: "Недопустимый ID группы",
        invalidGroupBody: "Используйте буквы, цифры, точки, дефисы или подчёркивания (макс. 64).",
        statusReady: "Готово",
        statusSwitching: "Переключение",
        statusExhausted: "Исчерпано",
        statusError: "Ошибка",
        statusUnknown: "Неизвестно",
        statusNeedsMembers: "Нужны включённые участники",
        activeMember: ({ profileId }: { profileId: string }) => `Активный: ${profileId}`,
        enabledMembers: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} включено`,
        autoFallbackEnabled: "Автоматический резерв включен",
        autoFallbackDisabled: "Автоматический резерв выключен",
        strategyPriority: "Порядок приоритета",
        strategyLeastLimited: "Сначала наименее ограниченный",
        strategyManual: "Ручное переключение",
        priority: ({ priority }: { priority: string }) => `Приоритет ${priority}`,
        cooldown: ({ time }: { time: string }) => `Пауза до ${time}`,
        memberActive: "Активный участник",
        memberEnabled: "Включён",
        memberDisabled: "Отключён",
        memberPriority: ({ priority }: { priority: number }) => `Приоритет ${priority}`,
        memberExhaustedUntil: ({ time }: { time: string }) => `Исчерпано до ${time}`,
        memberQuotaExhaustedUntil: ({ time }: { time: string }) => `Использование ограничено до ${time}`,
        memberRateLimitedUntil: ({ time }: { time: string }) => `Ограничение частоты до ${time}`,
        memberCapacityLimitedUntil: ({ time }: { time: string }) => `Ёмкость ограничена до ${time}`,
        memberAuthInvalidUntil: ({ time }: { time: string }) => `Авторизация недействительна до ${time}`,
        memberPlanUnavailableUntil: ({ time }: { time: string }) => `План недоступен до ${time}`,
        memberValidationBlockedUntil: ({ time }: { time: string }) => `Проверка заблокирована до ${time}`,
        memberLastFailure: ({ reason }: { reason: string }) => `Последняя проблема: ${reason}`,
        warningNoEnabledMembers: "Нет включенных участников, доступных для резерва.",
        warningNoFallbackMember: "Добавьте или включите еще одного участника, прежде чем автоматический резерв сможет менять аккаунты.",
        deleteTitle: "Удалить группу аккаунтов?",
        deleteBody: ({ groupId }: { groupId: string }) => `Удалить «${groupId}»? Профили останутся подключёнными.`,
        prompts: {
          groupIdTitle: "ID группы",
          groupIdBody: "Используйте короткую метку вроде team, work или fallback.",
          groupIdPlaceholder: "komanda",
        },
      },
      groupActions: {
        editTitle: "Изменить группу",
        searchMembersPlaceholder: "Поиск профилей",
        noProfilesAvailable: "Нет доступных подключённых профилей.",
        membersTitle: "Участники",
        membersSubtitle: "Отметьте профили, которые нужно включить в эту группу.",
        accountFallbackDisabled: "Автоматический fallback отключён на этом сервере.",
        enableFallback: "Включить автоматический резерв",
        disableFallback: "Выключить автоматический резерв",
        makeActive: "Сделать активным",
        useManualStrategy: "Использовать ручное переключение",
        usePriorityStrategy: "Использовать порядок приоритета",
        activeMember: "Активный участник",
        manualApplyFailedTitle: "Аккаунт переключен, обновление демона не завершено",
        manualApplyFailedBody: "Активный аккаунт изменен на сервере, но один или несколько локальных запущенных сеансов не удалось обновить. Перезапустите или возобновите эти сеансы, если они продолжают использовать прежний аккаунт.",
        enableMember: "Включить участника",
        disableMember: "Отключить участника",
        editPriority: "Изменить приоритет",
        priorityTitle: "Приоритет участника",
        priorityBody: "Меньшие числа пробуются первыми.",
        invalidPriorityTitle: "Недопустимый приоритет",
        invalidPriorityBody: "Введите целое число.",
        removeMember: "Удалить участника",
        removeMemberConfirmTitle: "Удалить участника",
        removeMemberConfirmBody: ({ profileId }: { profileId: string }) => `Удалить "${profileId}" из этой группы?`,
      },
      groupDetail: {
        routeTitle: "Группа",
        nameTitle: "Название группы",
        namePromptBody: "Выберите имя, которое будет показано в настройках и выборе авторизации.",
        groupIdTitle: "ID группы",
        membersTitle: "Участники",
        membersSubtitle: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} включено`,
        optionsTitle: "Параметры",
        autoSwitchTitle: "Автоматический резерв",
        autoSwitchEnabledSubtitle: "Переключаться на другого участника, когда активному аккаунту нужно восстановление.",
        autoSwitchDisabledSubtitle: "Использовать активного участника, пока вы не переключите его вручную.",
        strategyTitle: "Стратегия выбора",
        strategyPriorityTitle: "Порядок приоритета",
        strategyPrioritySubtitle: "Сначала пробовать меньшие номера приоритета.",
        strategyLeastLimitedTitle: "Сначала менее ограниченный",
        strategyLeastLimitedSubtitle: "Предпочитать участника с наибольшей пригодной квотой.",
        strategyManualTitle: "Ручное переключение",
        strategyManualSubtitle: "Использовать только активного участника, пока он не будет изменен вручную.",
        softSwitchThresholdTitle: "Порог мягкого переключения",
        softSwitchThresholdSubtitle: ({ percent }: { percent: string }) => `Переключаться ниже ${percent}% остатка, если доступен более безопасный участник.`,
        softSwitchThresholdPromptTitle: "Порог мягкого переключения",
        softSwitchThresholdPromptBody: "Введите процент остатка, при котором Happier должен предпочесть более безопасный аккаунт. Используйте 0, чтобы отключить мягкое переключение.",
        invalidSoftSwitchThresholdTitle: "Недопустимый порог",
        invalidSoftSwitchThresholdBody: "Введите число от 0 до 100.",
        staleProbeTitle: "Проверять устаревшую квоту через",
        staleProbeSubtitle: ({ minutes }: { minutes: string }) => `Проверять снова, когда данные квоты старше ${minutes} мин.`,
        staleProbePromptTitle: "Проверять устаревшую квоту через",
        staleProbePromptBody: "Введите, сколько минут можно повторно использовать данные квоты, прежде чем Happier проверит их снова.",
        invalidStaleProbeTitle: "Недопустимый интервал проверки",
        invalidStaleProbeBody: "Введите не менее 1 минуты.",
        switchBudgetTitle: "Лимиты автоматического переключения",
        switchBudgetSubtitle: ({ perTurn, perHour }: { perTurn: string; perHour: string }) => `До ${perTurn} автоматических переключений за ход и ${perHour} за час сессии.`,
        recoveryModeTitle: "Режим восстановления",
        recoveryModeOffSubtitle: "Не восстанавливать эту группу автоматически.",
        recoveryModeWaitUntilResetSubtitle: "Дождаться сброса лимита, затем возобновить.",
        recoveryModeSwitchThenResumeSubtitle: "Переключиться на другого участника, затем возобновить.",
        recoveryModeSwitchOrWaitSubtitle: "Переключиться на другого участника, если возможно, иначе дождаться сброса.",
        recoveryPromptTitle: "Подсказки восстановления",
        recoveryPromptSubtitle: "Использовать стандартные подсказки восстановления и возобновления для этой группы.",
        missingTitle: "Группа не найдена",
        missingBody: ({ service, groupId }: { service: string; groupId: string }) =>
          `Группа "${groupId}" не существует для ${service}.`,
      },

      connectPersonalAccessTokenTitle: "Подключить personal access token",
      connectPersonalAccessTokenSubtitle: "Вставьте fine-grained personal access token",
      connectApiTokenTitle: "Подключить API token",
      connectApiTokenSubtitle: "Вставьте API token провайдера или app password",
      openTokenSetupTitle: "Открыть настройку токена",
      openTokenSetupSubtitle: "Открыть страницу настройки провайдера",
      openPersonalAccessTokenSetupTitle: "Создать personal access token",
      openPersonalAccessTokenSetupSubtitle: "Открыть настройку fine-grained токена GitHub",},
    profile: {
      profileId: "ID профиля",
      status: "Статус",
      email: "Эл. почта",
      accountId: "ID аккаунта",
      quotaTitle: "Квоты",
      defaultSubtitle: "Этот профиль выбран по умолчанию",
      setDefaultSubtitle: "Использовать этот профиль по умолчанию",
      disconnectSubtitle: "Удалить учётные данные этого профиля",
      reconnectSubtitle: "Повторно авторизовать этот профиль",
      replaceTokenSubtitle: "Заменить учётные данные этого профиля",
      connectionGroupTitle: "Подключение",
      connectedVia: "Подключено через",
      connectedViaToken: "Токен доступа",
      connectedViaOauth: "OAuth",
      lastRefreshed: "Последнее обновление",
      refreshQuotaNow: "Обновить квоту сейчас",
      refreshQuotaNowSubtitle: "Получить актуальное использование для этого аккаунта.",
      poolsGroupTitle: "Пулы",
      pools: {
        emptyTitle: "Ни в одном пуле",
        emptySubtitle: "Добавьте этот аккаунт в пул для автоматического резерва.",
      },
      addToPool: "Добавить в пул",
      addToPoolSubtitle: "Использовать этот аккаунт как резервный в пуле.",
      settingsGroupTitle: "Настройки",
      setDefaultRowTitle: "Сделать по умолчанию",
      removeGroupTitle: "Удалить",
    },
    authModal: {
      nativeAuthTitle: "Нативная авторизация бэкенда",
      nativeAuthSubtitle: "Используйте локальный логин CLI / API‑ключи",
            groupSubtitle: 'Группа аккаунтов',
      connectedServicesTitle: "Использовать подключённые сервисы",
      connectedServicesSubtitle: "Загрузить и материализовать из облака Happier",
      notConnectedTitle: "Нет подключенных сервисов",
      notConnectedSubtitle: "Нажмите, чтобы открыть настройки",
      profileLabel: "Профиль",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Файл слишком большой",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Пропущено ${count} ${plural({ count, one: "файл", few: "файла", many: "файлов" })}, превышающих максимальный размер вложений.`,
      noClipboardImageTitle: "В буфере нет изображения",
      noClipboardImageBody: "Скопируйте изображение, затем вставьте его как вложение.",
    },
  },

  settingsAttachments: {
    disabled: {
      title: "Вложения",
      footer: "Эта функция отключена сервером или политикой сборки.",
    },
    fileUploads: {
      title: "Загрузка файлов",
    },
    uploadLocation: {
      title: "Место загрузки",
      footer:
        "Загрузки в директорию workspace — самый совместимый вариант. Загрузки во временную директорию ОС могут помочь избежать артефактов в репозитории, но могут быть недоступны для чтения в более строгих песочницах.",
      options: {
        workspace: {
          title: "Директория workspace (рекомендуется)",
          subtitle:
            "Загрузки записываются в директорию относительно workspace, чтобы песочница агента могла надёжно читать их.",
        },
        osTemp: {
          title: "Временная директория ОС",
          subtitle:
            "Загрузки записываются во временную директорию ОС. Это может не работать в более строгих песочницах.",
        },
      },
    },
    workspaceDirectory: {
      title: "Директория workspace",
      footer:
        "Используется только когда место загрузки установлено на Директория workspace.",
      uploadsDirectory: {
        title: "Директория загрузок",
        promptTitle: "Директория загрузок",
        promptMessage:
          "Введите директорию относительно workspace (без абсолютных путей, без ..).",
        invalidDirectoryTitle: "Некорректная директория",
        invalidDirectoryMessage:
          "Используйте относительный путь, например `.happier/uploads`.",
      },
    },
    sourceControlIgnore: {
      title: "Исключения для контроля версий",
      footer:
        "Локальные исключения помогают избежать случайных коммитов. Если выбрать .gitignore, это может изменить отслеживаемый файл.",
      options: {
        gitInfoExclude: {
          title: "Игнорировать локально (.git/info/exclude) (рекомендуется)",
          subtitle:
            "Предотвращает случайные коммиты без изменения файлов репозитория.",
        },
        gitignore: {
          title: "Игнорировать через .gitignore",
          subtitle:
            "Добавляет запись в файл .gitignore в workspace (может быть закоммичено).",
        },
        none: {
          title: "Не добавлять правила игнора",
          subtitle:
            "Загрузки могут попасть в контроль версий в зависимости от настроек репозитория.",
        },
      },
      writeIgnoreRules: {
        title: "Записывать правила игнора",
      },
    },
    limits: {
      title: "Лимиты",
      footer:
        "Эти лимиты применяются локальным обработчиком загрузок CLI (по возможности).",
      invalidValueTitle: "Некорректное значение",
      maxAttachmentSize: {
        title: "Макс. размер вложения (байт)",
        promptTitle: "Макс. размер вложения (байт)",
        promptMessage: "Пример: 26214400 для 25MB.",
        invalidValueMessage: "Введите число от 1024 до 1073741824.",
      },
    },
  },

  settingsSourceControl: {
  title: 'Файлы и контроль версий',
  editor: 'Редактор',
  editorFooter: 'Настройте поведение редактора файлов.',
  editorAutoSave: 'Автосохранение',
  editorAutoSaveDescription: 'Автоматически сохранять файлы после редактирования.',
  markdownEditMode: {
    title: 'Режим редактирования Markdown по умолчанию',
    footer: 'Выберите, как открываются файлы Markdown для редактирования. Rich - это WYSIWYG-редактор; raw редактирует исходный код Markdown напрямую. Файлы, которые нельзя безопасно преобразовать туда и обратно, всегда открываются как raw.',
    options: {
      rich: {
        title: 'Расширенный (WYSIWYG)',
        subtitle: 'Редактируйте Markdown визуально с живым форматированием.',
      },
      raw: {
        title: 'Исходный текст',
        subtitle: 'Редактируйте исходный код Markdown напрямую.',
      },
    },
    disabledReason: {
      mdx: 'Редактирование как обычный текст, потому что это файл MDX.',
      tooLarge: 'Редактирование как обычный текст, потому что этот файл слишком велик для редактора Rich.',
      referenceLinks: 'Редактирование как обычный текст, потому что этот файл содержит ссылки в формате reference.',
      footnotes: 'Редактирование как обычный текст, потому что этот файл содержит сноски.',
      htmlOrJsx: 'Редактирование как обычный текст, потому что этот файл содержит HTML или JSX.',
    },
  },
    commitStrategy: {
      title: "Стратегия коммита",
      footer:
        "Атомарный коммит избегает взаимных помех в индексе при работе нескольких агентов. Staging в Git включает интерактивные сценарии include/exclude.",
      options: {
        atomic: {
          title: "Атомарный коммит (рекомендуется)",
          subtitle:
            "Без live‑staging в индексе репозитория. Коммитит все ожидающие изменения одной RPC‑операцией.",
        },
        gitStaging: {
          title: "Рабочий процесс staging в Git",
          subtitle:
            "Включает include/exclude и частичный staging по строкам для репозиториев Git.",
        },
      },
    },
    gitRoutingPreference: {
      title: "Предпочтение маршрутизации для .git",
      footer:
        "Выберите, какой бэкенд предпочитать, когда режим репозитория — .git.",
      options: {
        git: {
          title: "Репозитории .git используют Git",
          subtitle: "По умолчанию и рекомендовано для совместимости.",
        },
        sapling: {
          title: "Репозитории .git предпочитают Sapling",
          subtitle:
            "Использовать Sapling, когда доступны и Git, и Sapling.",
        },
      },
    },
    remoteConfirmation: {
      title: "Подтверждение удалённых операций",
      footer:
        "Управляет тем, требуют ли операции pull/push подтверждения.",
      pull: {
        title: "Спрашивать перед pull",
        subtitle: "Показывать подтверждение перед получением удалённых изменений.",
      },
      push: {
        title: "Спрашивать перед push",
        subtitle: "Показывать подтверждение перед отправкой локальных коммитов.",
      },

      confirmBeforePulling: {
        title: "Подтверждать перед pull",
        subtitle:
          "Спрашивать перед загрузкой и объединением удалённых изменений.",
      },
      confirmBeforePushing: {
        title: "Подтверждать перед push",
        subtitle:
          "Спрашивать перед отправкой локальных коммитов на remote.",
      },
      options: {
        always: {
          title: "Всегда подтверждать pull/push",
          subtitle: "Показывать диалоги подтверждения для pull и push.",
        },
        pushOnly: {
          title: "Подтверждать только push",
          subtitle: "Pull выполняется сразу; push требует подтверждения.",
        },
        never: {
          title: "Никогда не подтверждать",
          subtitle: "Выполнять pull и push сразу.",
        },
      },},
    pushRejectionRecovery: {
      title: "Восстановление при отказе push",
      footer:
        "Поведение, когда push отклонён, потому что ветка отстаёт от upstream.",
      options: {
        promptFetch: {
          title: "Спросить перед fetch",
          subtitle:
            "Спрашивать перед запуском fetch, когда push отклонён из‑за non‑fast‑forward.",
        },
        autoFetch: {
          title: "Авто‑fetch",
          subtitle:
            "Автоматически запускать fetch после отклонения non‑fast‑forward push.",
        },
        manual: {
          title: "Ручное восстановление",
          subtitle:
            "Не запускать fetch автоматически после отклонения push.",
        },
      },
    },
    commitMessageGenerator: {
      title: "Генератор сообщения коммита",
      footer:
        "Необязательно: генерировать предложения для сообщения коммита с помощью одноразовой задачи LLM. Требуется поддержка запусков выполнения на демоне.",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `Бэкенд генератора: ${backendId}`,
      backendItemSubtitle:
        "ID бэкенда, используемый для одноразовой генерации сообщения коммита.",
      backendPromptTitle: "Бэкенд для сообщения коммита",
      backendPromptMessage: "Введите ID бэкенда",
      instructionsPlaceholder: "Инструкции для сообщения коммита",
    },
    commitAttribution: {
      title: "Авторство коммита",
      footer:
        "Если включено, сообщения коммитов, сгенерированные ИИ, будут содержать кредиты Co‑Authored‑By.",
      includeCoAuthoredBy: {
        title: "Добавлять Co‑Authored‑By",
      },
    },
    filesDisplay: {
      title: "Отображение файлов",
      footer:
        "Подсветка синтаксиса экспериментальная и может отключаться для очень больших diff.",
      diffRenderer: {
        options: {
          pierre: {
            title: "Рендерер diff: Pierre",
            subtitle:
              "Лучшее отображение diff на web/desktop. Использует worker‑pipeline и безопасно делает fallback при недоступности.",
          },
          happier: {
            title: "Рендерер diff: Happier",
            subtitle:
              "Fallback‑рендерер для совместимости и диагностики.",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Макет diff: Единый",
            subtitle:
              "Линейный вид (одна колонка). Лучше для узких экранов и быстрого просмотра.",
          },
          split: {
            title: "Макет diff: Рядом",
            subtitle:
              "Разделённый вид (две колонки). Лучше для больших экранов и точных сравнений.",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "Подсветка синтаксиса: Выкл",
            subtitle: "Показывать diff и файлы как обычный моноширинный текст.",
          },
          simple: {
            title: "Подсветка синтаксиса: Простая",
            subtitle:
              "Быстрая подсветка по токенам для распространённых языков.",
          },
          advanced: {
            title: "Подсветка синтаксиса: Расширенная",
            subtitle:
              "Более точная подсветка на web/desktop; fallback на простую в native.",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "Плотность изменённых файлов: Комфортная",
            subtitle: "Более крупные строки с более читаемыми подписями и статусом.",
          },
          compact: {
            title: "Плотность изменённых файлов: Компактная",
            subtitle:
              "Более компактные строки, чтобы легче просматривать при большом числе изменений.",
          },
        },
      },
    },
    backends: {
      backendGroupTitle: ({ backendTitle }: { backendTitle: string }) =>
        `Бэкенд: ${backendTitle}`,
      defaultDiffItemTitle: ({
        backendTitle,
        diffModeTitle,
      }: {
        backendTitle: string;
        diffModeTitle: string;
      }) => `Diff по умолчанию для ${backendTitle}: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "Режим по умолчанию при просмотре файлов с включёнными и ожидающими дельтами.",
    },
    diffMode: {
      pending: "Ожидающие",
      combined: "Объединённый",
      included: "Включённые",
    },
  },

  settingsDesktop: {
    title: 'Рабочий стол',
    footer: 'Управляет интеграциями Tauri для рабочего стола на этом компьютере.',
    startOnLoginTitle: 'Запускать при входе',
    startOnLoginSubtitle: 'Автоматически запускать Happier при входе на этом компьютере.',

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
    title: 'Питомцы',
    previewTitle: 'Компаньон Blink',
    previewSubtitle: 'Небольшой компаньон для состояния сессии и внимания к ревью.',
    disabledTitle: 'Питомцы отключены',
    disabledSubtitle: 'Включите Питомцев в функциях, чтобы использовать компаньонов на этом устройстве.',
    disabledByServerTitle: 'Питомцы отключены на этом сервере',
    disabledByServerSubtitle: 'Администратор отключил питомцев-компаньонов для этого сервера.',
    accountTitle: 'Значение аккаунта по умолчанию',
    enabledTitle: 'Включить питомцев',
    enabledSubtitle: 'Показывать поверхности компаньона для этого аккаунта.',
    companionSizeTitle: 'Размер питомца',
    companionSizeSubtitle: 'Настройте размер компаньона на этом устройстве.',
    companionSizeValue: ({ percent }: { percent: number }) => `${percent}%`,
    deviceOverrideTitle: 'Использовать на этом устройстве',
    deviceOverrideSubtitle: 'Локально переопределить настройку питомца из аккаунта.',
    sourceTitle: 'Источник питомца',
    builtInSubtitle: 'Встроено в Happier.',
    builtInBlinkSubtitle: 'Превращает сигналы сессии в спокойные маленькие индикаторы.',
    builtInFurySubtitle: 'Стресс-тестирует сложные потоки до попадания в продакшен.',
    builtInMiloSubtitle: 'Держит UI в порядке и дремлет на упавших тестах.',
    builtInOliSubtitle: 'Тихо отправляет фиксы, пока сборка не заметила.',
    builtInTitiSubtitle: 'Разбирает релизные заметки с фокусом senior staff.',
    localLibraryTitle: 'Это устройство',
    localLibraryFooter: 'Локальные питомцы остаются на этом устройстве, пока вы не импортируете их в аккаунт.',
    helpDocsTitle: 'Справка по питомцам',
    helpDocsSubtitle: 'Открыть документацию Happier по настройке и устранению неполадок.',
    detectCodexPetsTitle: 'Обнаруживать питомцев Codex',
    detectCodexPetsSubtitle: 'Искать совместимых питомцев в локальных Codex homes.',
    detectedCodexPetsTileSubtitle: 'Найден в Codex и готов присоединиться к этому устройству.',
    detectedCodexPetsEmptyTitle: 'Питомцы Codex не найдены',
    detectedCodexPetsEmptySubtitle: 'Создайте питомца в Codex, затем запустите обнаружение снова.',
    detectedCodexPetsErrorTitle: 'Не удалось обнаружить питомцев Codex',
    detectedCodexPetsErrorSubtitle: 'Проверьте, что daemon подключен, и попробуйте снова.',
    detectedCodexPetsNoTargetTitle: 'Нет доступного daemon',
    detectedCodexPetsNoTargetSubtitle: 'Запустите Happier на этом компьютере, затем снова обнаружьте питомцев Codex.',
    detectedCodexPetsDaemonMismatchTitle: 'Обновите daemon для обнаружения питомцев',
    detectedCodexPetsDaemonMismatchSubtitle: 'Этот daemon еще не предоставляет обнаружение питомцев. Обновите stack и попробуйте снова.',
    useOnThisDeviceTitle: 'Использовать на этом устройстве',
    useOnThisDeviceSubtitle: 'Выберите локального питомца без изменения значения аккаунта по умолчанию.',
    importedLocalSubtitle: 'Импортировано из Codex на этом устройстве.',
    removeFromDeviceTitle: 'Удалить с устройства',
    removeFromDeviceSubtitle: 'Удалить этого локального питомца с этого устройства.',
    accountLibraryTitle: 'Библиотека аккаунта',
    accountLibraryFooter: 'Синхронизированные питомцы доступны на ваших устройствах с входом в аккаунт.',
    accountPetTileSubtitle: 'Синхронизировано из вашего аккаунта.',
    removeFromDeviceDaemonErrorTitle: 'Удалено локально; очистка демона не удалась',
    removeFromDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `Питомец удален из списка этого устройства, но очистка демона вернула ${code}.`,
    importToDeviceDaemonErrorTitle: 'Не удалось импортировать питомца',
    importToDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `Демон не смог импортировать этого питомца. Снова обнаружьте питомцев Codex и повторите попытку. (${code})`,
    importToAccountTitle: 'Импортировать в аккаунт',
    importToAccountSubtitle: 'Загрузите совместимого локального питомца для использования на разных устройствах.',
    desktopOverlayTitle: 'Оверлей рабочего стола',
    overlayTrayTitle: 'Активность питомца',
    overlayStatusWaiting: 'Ожидание',
    overlayStatusFailed: 'Ошибка',
    overlayStatusReview: 'Проверка',
    overlayStatusRunning: 'Выполняется',
    overlayQuickReplyPlaceholder: 'Быстрый ответ',
    overlayReplyAction: 'Ответить',
    overlayQuickReplyAction: 'Отправить быстрый ответ',
    overlayDismissAction: 'Скрыть активность',
    overlayTuckAction: 'Спрятать',
    overlayClosePetAction: 'Закрыть питомца',
    desktopOverlayEnabledTitle: 'Включить оверлей рабочего стола',
    desktopOverlayEnabledSubtitle: 'Показывать питомца в прозрачном окне-компаньоне рабочего стола.',
    desktopOverlayDeviceOverrideTitle: 'Оверлей рабочего стола на этом устройстве',
    desktopOverlayVisibilityModeTitle: 'Видимость оверлея на этом устройстве',
    desktopOverlayVisibilityModeSubtitle: 'Выберите, когда локально показывать питомца на рабочем столе.',
    desktopOverlayResetPositionTitle: 'Сбросить позицию',
    desktopOverlayResetPositionSubtitle: 'Вернуть оверлей в правый нижний угол.',
    overrideInherit: 'Значение аккаунта',
    overrideEnabled: 'Включено',
    overrideDisabled: 'Отключено',
    visibilityModeInherit: 'Значение аккаунта',
    visibilityModeAlwaysWhenEnabled: 'Всегда, когда включено',
    visibilityModeAttentionOrActive: 'Внимание или активность',
    visibilityModeAttentionOnly: 'Только внимание',
  },

  settingsNotifications: {
    push: {
      title: "Push-уведомления",
      footer:
        "Эти уведомления отправляются вашим CLI через Expo, когда вашей сессии требуется внимание.",
      enabledSubtitle: "Разрешить push-уведомления для этого аккаунта",
      troubleshootTitle: "Устранение неполадок",
      troubleshootSubtitle: "Проверить разрешения и зарегистрированные устройства",
    },
    pushPriming: {
        title: 'Включить уведомления?',
        body: 'Happier может сообщать, когда агент завершил работу, нужно решение о разрешении или он ждёт вас. Это можно изменить в любой момент в настройках.',
        accept: 'Включить',
        decline: 'Не сейчас',
        blockedTitle: 'Уведомления заблокированы',
        blockedBody: 'Уведомления для этого приложения отключены в системных настройках. Откройте настройки, чтобы разрешить их.',
        openSettings: 'Открыть настройки',
        openSettingsFailed: 'Не удалось открыть системные настройки.',
    },
    pushTroubleshooting: {
      status: {
        title: "Статус",
        footer: "Проверяет настройку аккаунта, разрешение ОС и состояние регистрации на сервере.",
        accountSettingTitle: "Настройка аккаунта",
        accountSettingEnabledSubtitle: "Push-уведомления включены для этого аккаунта",
        accountSettingDisabledSubtitle: "Push-уведомления отключены для этого аккаунта",
      },
      permission: {
        title: "Разрешение",
        loading: "Загрузка…",
        loadingSubtitle: "Проверяем разрешения для уведомлений",
        runtimeUnavailable: 'Недоступно',
        runtimeUnavailableSubtitle: 'Не удалось обратиться к службе уведомлений на этом устройстве.',
        runtimeTimeoutSubtitle: 'Служба уведомлений не ответила. Проверьте подключение к серверу разработки и повторите попытку.',
        unsupported: "Не поддерживается",
        unsupportedSubtitle: "Разрешения push недоступны в веб-версии.",
        allowed: "Разрешено",
        allowedSubtitle: "Уведомления разрешены для этого приложения.",
        denied: "Запрещено",
        notRequested: "Не запрошено",
        canAskAgainSubtitle: "Нажмите, чтобы запросить разрешение.",
        openSettingsSubtitle: "Нажмите, чтобы открыть системные настройки.",
      },
      token: {
        title: "Это устройство",
        subtitle: ({ fingerprint }: { fingerprint: string }) =>
          `Текущий токен: ${fingerprint}`,
        unavailableSubtitle: "Не удалось получить push-токен Expo.",
        checkingSubtitle: 'Чтение токена этого устройства…',
        runtimeUnavailableSubtitle: 'Не удалось обратиться к службе уведомлений на этом устройстве.',
        runtimeTimeoutSubtitle: 'Служба уведомлений не ответила вовремя.',
        deviceUnavailableSubtitle: 'Эта сборка не может выдать push-токен. Убедитесь, что push-уведомления включены для этой сборки.',
        registered: "Зарегистрирован",
      },
      actions: {
        title: "Действия",
        footer: "Используйте эти шаги, если push-уведомления не приходят.",
        requestPermissionTitle: "Запросить разрешение",
        requestPermissionSubtitle: "Попросить ОС выдать разрешение на уведомления.",
        reregisterTitle: "Перерегистрировать токен",
        reregisterSubtitle: "Снова отправить токен этого устройства на сервер.",
        refreshTitle: "Обновить",
        refreshSubtitle: "Перезагрузить разрешение, токен и устройства на сервере.",
      },
      devices: {
        title: "Зарегистрированные устройства",
        footer: ({ count, serverUrl }: { count: string; serverUrl: string }) =>
          `${count} токен(ов) на ${serverUrl}`,
        emptyTitle: "Нет устройств",
        emptySubtitle: "На сервере нет зарегистрированных push-токенов для этого аккаунта.",
        clientServerUrl: ({ url }: { url: string }) => `Сервер: ${url}`,
        registeredAt: ({ at }: { at: string }) => `Зарегистрировано: ${at}`,
        lastSeenAt: ({ at }: { at: string }) => `Последняя активность: ${at}`,
        thisDevice: "Это устройство",
      },
      loadError: "Не удалось загрузить статус push-уведомлений.",
      authRequired: "Войдите в аккаунт, чтобы управлять push-уведомлениями.",
      remove: {
        confirmTitle: "Удалить устройство",
        confirmBody: ({ fingerprint }: { fingerprint: string }) =>
          `Удалить push-токен ${fingerprint}?`,
        error: "Не удалось удалить push-токен.",
      },
    },
    webhooks: {
      title: "Уведомления вебхука",
      footer: "Отправляйте уведомления об удаленных действиях дополнительным конечным точкам веб-перехватчика в этой учетной записи.",
      addTitle: "Добавить вебхук",
      addSubtitle: "Доставлять уведомления на другую конечную точку",
      emptyTitle: "Нет каналов вебхуков",
      emptySubtitle: "Добавьте вебхук для доставки событий удаленной активности за пределы Expo.",
      enabledTitle: "Включить вебхук",
      enabledSubtitle: "Уведомления вебхука включены",
      disabledSubtitle: "Уведомления вебхука отключены",
      channelEnabledSubtitle: "Разрешить этой конечной точке получать уведомления об активности",
      urlPromptTitle: "URL вебхука",
      urlPromptSubtitle: "Введите целевой URL-адрес для этого веб-перехватчика уведомлений.",
      urlPromptPlaceholder: 'https://hooks.example.test/notify',
      invalidUrlTitle: "Неверный URL вебхука",
      invalidUrlSubtitle: "Введите действительный URL-адрес HTTP или HTTPS.",
      deleteTitle: "Удалить вебхук",
      deleteConfirm: ({ url }: { url: string }) =>
        `Прекратить отправлять уведомления на ${url}?`,
      signingSecretTitle: "Секрет подписания",
      signingSecretEmptySubtitle: "Добавьте общий секрет для подписи полезных данных веб-перехватчика.",
      signingSecretConfiguredSubtitle: "Полезные данные Webhook подписываются общим секретом.",
      signingSecretPromptTitle: "Секрет подписи вебхука",
      signingSecretPromptSubtitleAdd: "Введите общий секретный ключ, чтобы подписать эту полезную нагрузку веб-перехватчика.",
      signingSecretPromptSubtitleReplace: "Введите новый общий секрет, чтобы заменить существующий секрет подписи.",
      signingSecretPromptPlaceholder: "общий секрет",
      signingSecretClearAction: "Очистить секрет",
      readyTitle: "Готовый",
      readySubtitle: "Отправляйте, когда ход закончится и агент будет ждать вашей команды.",
      readyPreviewTitle: "Превью готовых сообщений",
      readyPreviewSubtitle: "Включить последний текст сообщения помощника в готовые уведомления для этого вебхука.",
      permissionRequestsTitle: "Запросы на разрешение",
      permissionRequestsSubtitle: "Отправлять, когда сеанс заблокирован в ожидании одобрения",
      userActionsTitle: "Запросы на действия",
      userActionsSubtitle: "Отправлять, когда сеансу требуется ответ или подтверждение.",
    },
    badges: {
      title: "Значки на этом устройстве",
      footer: "Выберите, какая активность влияет на значок приложения на этом устройстве.",
      enabledTitle: "Включить значки",
      enabledSubtitle: "Показывать значок приложения, когда требуется внимание",
      unreadTitle: "Непрочитанные сессии",
      unreadSubtitle: "Считать сессии с непрочитанной активностью в транскрипте",
      permissionRequestsTitle: "Запросы разрешений",
      permissionRequestsSubtitle: "Считать сессии, ожидающие одобрения",
      userActionsTitle: "Запросы действий",
      userActionsSubtitle: "Считать сессии, ожидающие ответа или подтверждения",
      queuedTitle: "Ожидает отправки",
      queuedSubtitle: "Считать сессии с очередью работы, которую нужно отправить",
      friendRequestsTitle: "Запросы в друзья",
      friendRequestsSubtitle: "Добавлять входящие запросы в друзья к числовому значку",
      desktopDotTitle: "Точка в доке (десктоп)",
      desktopDotSubtitle: "На десктопе показывать точку, когда есть только нечисловая активность во входящих",
    },
    local: {
      title: "Локальные уведомления на этом устройстве",
      footer: "Эти настройки влияют на то, как уведомления показываются на этом устройстве.",
      enabledSubtitle: "Разрешить этому устройству показывать локальные уведомления",
      readyTitle: "Готовый",
      readySubtitle: "Показывать локальное уведомление об окончании поворота",
      readyPreviewTitle: "Превью готовых сообщений",
      readyPreviewSubtitle: "Включить последнее сообщение помощника в готовые уведомления на этом устройстве.",
      permissionRequestsTitle: "Запросы на разрешение",
      permissionRequestsSubtitle: "Показывать локальное уведомление, когда сеанс требует одобрения",
      userActionsTitle: "Запросы на действия",
      userActionsSubtitle: "Показывать локальное уведомление, когда сеансу требуется ваше участие",
    },
    desktop: {
      title: "Уведомления рабочего стола",
      footer: "Проверяет локальную доставку уведомлений для этого desktop-приложения.",
      permission: {
        title: "Системное разрешение",
        checkingSubtitle: "Проверяем разрешение уведомлений macOS",
        grantedSubtitle: "macOS разрешает этому приложению отправлять уведомления",
        notGrantedSubtitle: "Нажмите, чтобы запросить разрешение уведомлений macOS",
        errorSubtitle: "Не удалось прочитать разрешение уведомлений macOS",
      },
    },
    foregroundBehavior: {
      title: "Уведомления в приложении",
      footer:
        "Управляет уведомлениями, пока вы используете приложение. Уведомления для просматриваемой сессии всегда скрываются.",
      full: "Полные",
      fullDescription: "Показывать баннер и воспроизводить звук",
      silent: "Тихие",
      silentDescription: "Показывать баннер без звука",
      off: "Выкл.",
      offDescription: "Только значок, без баннера",

      account: "По умолчанию аккаунта",
      accountDescription:
        "Использовать поведение уведомлений в приложении из настроек аккаунта на этом устройстве",},
    types: {
      title: "Типы",
      footer: "Отключите отдельные типы, если вам нужны не все уведомления.",
      ready: {
        title: "Готово",
        subtitle:
          "Уведомлять, когда ход завершён и агент ждёт вашей команды",
      },
      readyPreview: {
        title: "Превью готовых сообщений",
        subtitle: "Включите последний текст сообщения помощника в push-уведомления о готовых поворотах.",
      },
      permissionRequests: {
        title: "Запросы разрешений",
        subtitle:
          "Уведомлять, когда сессия заблокирована и ждёт одобрения",
      },
      userActions: {
        title: "Запросы действий",
        subtitle:
          "Уведомлять, когда сессии нужен ответ или подтверждение",
      },
    },

    activitySurfaces: {
      title: 'Поверхности активности',
      footer: 'Управляет Live Activities, Dynamic Island и виджетами на этом устройстве.',
      enabledSubtitle: 'Включить видимые поверхности сессий на этом устройстве',
      shared: {
        title: 'Общее поведение',
        footer: 'Выберите, как должны работать нажатия и превью во всех поверхностях активности.',
      },
      tapTargetTitle: 'Действие при нажатии',
      tapTargetOpenSessionTitle: 'Открыть текущую сессию',
      tapTargetOpenSessionsTitle: 'Открыть активные сессии',
      privacyTitle: 'Конфиденциальность',
      privacyStatusOnlyTitle: 'Только статус',
      privacyTitleOnlyTitle: 'Только заголовок',
      privacyIncludePreviewTitle: 'Включать текст превью',
      liveActivities: {
        title: 'Live Activities',
        footer: 'Управляет отображением на экране блокировки и в Dynamic Island на iPhone.',
        enabledSubtitle: 'Включить Live Activities на этом устройстве',
        strategyTitle: 'Activity strategy',
        strategySubtitle: 'Выберите, должна ли одна активность следовать за самой важной сессией или оставаться закреплённой.',
        presentationTitle: 'Режим отображения',
        presentationSubtitle: 'Выберите, как Live Activities должны выделять текущую сессию.',
        focusedTitle: 'Фокусная сессия',
        attentionTitle: 'Внимание',
        runningTitle: 'Активные сессии',
        dynamicPrimaryTitle: 'Dynamic primary',
        pinnedPrimaryTitle: 'Pinned primary',
        sessionSpecificTitle: 'Session specific',
        maxConcurrentTitle: 'Максимум одновременных активностей',
        maxConcurrentOneTitle: '1 активность',
        maxConcurrentTwoTitle: '2 активности',
        maxConcurrentFourTitle: '4 активности',
        previewTextTitle: 'Текст превью',
        actionButtonsTitle: 'Кнопки действий',
        includeReadyTitle: 'Включать готовые сессии',
        includeThinkingTitle: 'Включать думающие сессии',
        remoteUpdates: {
          title: 'Удаленные обновления',
          footer: 'Диагностика выбранного сервера для обновления Live Activities, когда приложение больше не на переднем плане.',
          effectiveModeTitle: 'Фактическая доставка',
          effectiveMode: {
            hosted_happier_relay: 'Хостируемый ретранслятор',
            direct_apns: 'Прямой APNs',
            background_wake_best_effort: 'Фоновое пробуждение',
            local_only: 'Только локальная среда',
            disabled: 'Отключено',
          },
          details: {
            available: 'Доступно',
            unavailable: 'Недоступно',
            blocked: 'Заблокировано',
            missingCredentials: 'Нет учетных данных',
            bestEffort: 'По возможности',
            selected: 'Выбрано',
            fallback: 'Запасной вариант',
            preferred_unavailable: 'Только локально',
            local_only: 'Только локально',
            disabled: 'Отключено',
            runtimeOnly: 'Только среда выполнения',
          },
          hostedRelayTitle: 'Хостируемый ретранслятор Happier',
          hostedRelayAvailableSubtitle: 'Хостируемый ретранслятор настроен для выбранного сервера.',
          hostedRelayDisabledSubtitle: 'Хостируемый ретранслятор отключен для этого self-hosted сервера.',
          hostedRelayBlockedSubtitle: 'Идентификация ретранслятора и поддержка провайдера еще не реализованы.',
          hostedRelayUnavailableSubtitle: 'Хостируемый ретранслятор недоступен с выбранного сервера.',
          directApnsTitle: 'Прямой APNs',
          directApnsConfiguredSubtitle: 'Учетные данные прямого APNs настроены без раскрытия секретов.',
          directApnsMissingCredentialsSubtitle: 'Для прямого APNs не хватает серверной настройки учетных данных.',
          directApnsUnavailableSubtitle: 'Прямой APNs недоступен для выбранного сервера.',
          backgroundWakeTitle: 'Фоновое пробуждение',
          backgroundWakeBestEffortSubtitle: 'Фоновое пробуждение может попытаться обновить данные, но iOS может отложить или отбросить его.',
          backgroundWakeDisabledSubtitle: 'Запасной режим фонового пробуждения отключен на выбранном сервере.',
          localOnlyTitle: 'Только локальные обновления',
          localOnlyRuntimeSubtitle: 'Локальные обновления работают, пока может выполняться среда приложения; они не обещают обновления после завершения приложения.',
        },
      },
      widgets: {
        title: 'Виджеты домашнего экрана',
        footer: 'Управляет обзором виджетов, показываемым на домашнем экране устройства.',
        enabledSubtitle: 'Включить виджеты на этом устройстве',
        summaryTitle: 'Сводка',
        attentionTitle: 'Внимание',
        runningTitle: 'Активные сессии',
        previewTextTitle: 'Текст превью',
        machinePathTitle: 'Машина и путь',
      },
    },
    quietHours: {
      title: "Тихие часы",
      footer: "Тихие часы аккаунта по умолчанию действуют везде. Переопределения устройства влияют только на это устройство.",
      accountOffTitle: "Без тихих часов аккаунта",
      accountOffSubtitle: "Доставлять уведомления аккаунта в любое время",
      accountNightlyTitle: "Каждую ночь с 22:00 до 7:00",
      accountNightlySubtitle: "Отключать звук или подавлять каналы внимания ночью",
      deviceAccountTitle: "Это устройство следует часам аккаунта",
      deviceAccountSubtitle: "Использовать синхронизированную политику тихих часов аккаунта",
      deviceDisabledTitle: "Отключить тихие часы на этом устройстве",
      deviceDisabledSubtitle: "Разрешить доставку на этом устройстве даже во время тихих часов аккаунта",
      deviceCustomNightlyTitle: "Это устройство использует ночные тихие часы",
      deviceCustomNightlySubtitle: "Переопределить часы аккаунта интервалом с 22:00 до 7:00 на этом устройстве",
    },
    sounds: {
      title: "Звуки",
      footer: "Настройки звука аккаунта синхронизируются везде. Это устройство может отключать локальные звуки.",
      accountHappierTitle: "Звуки Happier",
      accountHappierSubtitle: "Использовать мягкий тон для обновлений и более яркий тон, когда требуется внимание",
      accountDefaultTitle: "Системный звук",
      accountDefaultSubtitle: "Использовать звук уведомлений платформы",
      accountSilentTitle: "Без звука",
      accountSilentSubtitle: "Доставлять уведомления без звука",
      deviceEnabledTitle: "Воспроизводить звуки на этом устройстве",
      deviceEnabledSubtitle: "Переопределение устройства для локальных звуков уведомлений",
      previewTitle: "Предпросмотр звука",
      previewSubtitle: "Отправить локальное тестовое уведомление на этом устройстве",
      previewNotificationTitle: "Предпросмотр звука уведомления",
      previewNotificationBody: "Так будет работать текущий звук уведомлений.",
    },},

    notifications: {
      actions: {
        allow: 'Разрешить',
        deny: 'Отклонить',
        answer: 'Ответить',

        other: 'Другое',
        alwaysAllowTool: ({ tool }: { tool: string }) => `Всегда разрешать ${tool}`,},
      activity: {
        defaultSessionTitle: "Сессия",
        readyFallbackBody: "Поворот закончен. ",
        permissionFallbackBody: "Требуется одобрение.",
        userActionFallbackBody: "Эта сессия нуждается в вашем вкладе.",
      },
      channels: {
        default: 'По умолчанию',
        permissionRequests: 'Запросы разрешений',
        userActionRequests: 'Запросы действий',
      },
    },

  settingsProviders: settingsProvidersTranslations.ru,

  settingsAgents: {
    title: "Настройки провайдера ИИ",
    entrySubtitle: "Настройте параметры для конкретного провайдера",
    footer:
      "Настройте параметры для конкретного провайдера. Эти настройки могут повлиять на поведение сессии.",
      configuration: 'Конфигурация',
      cliConnection: 'Подключение CLI',
      capabilities: 'Возможности',
      models: 'Модели',
    providerSubtitle: "Параметры для конкретного провайдера",
    stateEnabled: "Включён",
    stateDisabled: "Отключён",
    channelStable: "Стабильный",
    channelExperimental: "Экспериментальный",
    channelPlugin: "Плагин",
    supported: "Поддерживается",
    notSupported: "Не поддерживается",
    allowed: "Разрешено",
    notAllowed: "Не разрешено",
    notAvailable: "Недоступно",
    enabledTitle: "Включён",
    enabledSubtitle: "Использовать этот бэкенд в выборе, профилях и сессиях",
    releaseChannelTitle: "Канал выпуска",
    capabilitiesTitle: "Возможности",
    resumeSupportTitle: "Поддержка возобновления",
    sessionModeSupportTitle: "Поддержка режимов сессии",
    runtimeModeSwitchingTitle: "Переключение режима в рантайме",
    localControlTitle: "Локальное управление",
    resumeSupportSupported: "Поддерживается",
    resumeSupportSupportedExperimental: "Поддерживается (экспериментально)",
    resumeSupportNotSupported: "Не поддерживается",
    sessionModeNone: "Нет режимов ACP",
    sessionModeAcpPolicyPresets: "Пресеты политик ACP",
    sessionModeAcpAgentModes: "Режимы агентов ACP",
    sessionModeDynamicPolicyModes: "Динамические режимы политик",
    sessionModeDynamicAgentModes: "Динамические режимы агента",
    sessionModeStaticAgentModes: "Статические режимы агента",
    runtimeSwitchNone: "Нет переключения в рантайме",
    runtimeSwitchMetadataGating: "Через метаданные",
    runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
    runtimeSwitchSessionModeApi: "API режима сессии",
    runtimeSwitchProviderNative: "Нативный провайдер",
    modelsTitle: "Модели",
    modelSelectionTitle: "Выбор модели",
    freeformModelIdsTitle: "Произвольные ID моделей",
    defaultModelTitle: "Модель по умолчанию",
    catalogModelListTitle: "Каталог моделей",
    catalogModelListEmpty: "Каталог моделей пуст",
    dynamicModelProbeTitle: "Динамическое обнаружение моделей",
    dynamicModelProbeAuto: "Авто",
    dynamicModelProbeStaticOnly: "Только статические",
    nonAcpApplyScopeTitle: "Область применения модели (без ACP)",
    nonAcpApplyScopeSpawnOnly: "Применить при старте сессии",
    nonAcpApplyScopeNextPrompt: "Применить при следующем запросе",
    acpApplyBehaviorTitle: "Поведение применения модели (ACP)",
    acpApplyBehaviorSetModel: "Установить модель на лету",
    acpApplyBehaviorRestartSession: "Перезапустить сессию",
    acpConfigOptionTitle: "ID опции конфигурации модели ACP",
    cliConnectionTitle: "CLI и подключение",
    targetMachineTitle: "Целевая машина",
    detectedCliTitle: "Обнаруженный CLI",
    installSetupTitle: "Установка / настройка",
    installInfoSeeSetupGuide: "Смотрите руководство по настройке",
    installInfoUseAgentCliInstaller: "Используйте установщик CLI провайдера",
    setup: {
        selectionFooter: "Выберите одного или нескольких провайдеров, затем настройте их по очереди на выбранной машине.",
        startTitle: "Настроить провайдеров",
        startDescription: "Добавьте выбранных провайдеров в очередь и пройдите установку и вход в одном каноническом потоке.",
        queueTitle: "Очередь настройки провайдеров",
        queueDescription: ({ provider }: { provider: string }) => `Завершите настройку ${provider}, затем переходите к следующему провайдеру в очереди.`,
        activeDescription: "Текущий провайдер в очереди настройки",
        activeStatus: "В процессе",
        completedStatus: "Готово",
        skippedStatus: "Пропущено",
        skipAction: "Пропустить этого провайдера",
        completedTitle: "Настройка провайдеров завершена",
        completedDescription: "Вы дошли до конца выбранной очереди провайдеров.",
    },
    cliSourcePreference: {
      title: "Предпочтение источника CLI",
      subtitle:
        "Выберите, должен ли Happier предпочитать системный CLI или управляемую установку, когда доступны оба варианта.",
      options: {
        systemFirst: {
          title: "Сначала системная установка",
          subtitle: "Предпочитать CLI, уже установленный на этой машине.",
        },
        managedFirst: {
          title: "Сначала управляемая установка",
          subtitle: "Предпочитать CLI, установленный Happier для этого провайдера.",
        },
      },
    },
    cliInstaller: {
      installTitle: ({ provider }: { provider: string }) =>
        `Установить ${provider} CLI`,
      reinstallTitle: ({ provider }: { provider: string }) =>
        `Переустановить ${provider} CLI`,
      autoInstallUnavailable: "Авто-установка недоступна для этой машины.",
      installSubtitle:
        "Устанавливает CLI провайдера на выбранной машине (best-effort).",
      reinstallSubtitle:
        "Повторно запускает установщик провайдера, даже если CLI уже установлен.",
      confirmInstallTitle: ({ provider }: { provider: string }) => `Установить ${provider} CLI?`,
      confirmReinstallTitle: ({ provider }: { provider: string }) => `Переустановить ${provider} CLI?`,
      confirmBody: ({ provider }: { provider: string }) =>
        `Это запустит команды установщика ${provider} на выбранной машине. Продолжайте только если доверяете провайдеру.`,
      confirmInstallConfirm: "Установить",
      confirmReinstallConfirm: "Переустановить",
      noMachineSelected: "Машина не выбрана.",
      installNotSupported: "Установка не поддерживается на этой машине.",
      installFailed: "Установка не удалась.",
      installed: "Установлено.",
      logPath: ({ logPath }: { logPath: string }) => `Лог: ${logPath}`,
    },
    setupGuideUrlTitle: "URL руководства по настройке",
    authentication: {
      title: "Аутентификация",
      footer: "Проверьте локальное состояние аутентификации CLI и запустите вход, если он поддерживается.",
      terminalTitle: "Терминал входа провайдера",
      logInTitle: "Войти",
      logInSubtitle: "Откройте терминал и запустите вход в провайдера на этой машине.",
      reauthenticateTitle: "Повторно войти",
      reauthenticateSubtitle: "Откройте терминал и обновите вход в провайдера на этой машине.",
      checkNowTitle: "Проверить сейчас",
      checkNowSubtitle: "Обновить обнаруженное локальное состояние аутентификации.",
      statusTitle: "Статус",
      loggedInAsTitle: "Выполнен вход как",
      methodTitle: "Способ аутентификации",
      sourceTitle: "Источник учётных данных",
      reasonTitle: "Проблема",
      lastCheckedTitle: "Последняя проверка",
      stateUnknown: "Неизвестно",
      stateLoggedIn: "Выполнен вход",
      stateLoggedOut: "Выполнен выход",
      methods: {
        apiKeyEnv: "Переменная окружения ключа API",
        authTokenEnv: "Переменная окружения токена аутентификации",
        credentialsFile: "Файл учётных данных",
        oauthCli: "OAuth-вход через CLI",
        configFile: "Файл конфигурации",
        gcloudAdc: "Учётные данные приложения Google Cloud по умолчанию",
        unknown: "Неизвестно",
      },
      reasons: {
        missingCredentials: "Отсутствуют учётные данные",
        expired: "Срок действия учётных данных истёк",
        cliMissing: "CLI не установлен",
        probeFailed: "Проверка статуса не удалась",
        timeout: "Истекло время ожидания проверки статуса",
        unsupported: "Локальная аутентификация не поддерживается",
        interactiveBlocked: "Интерактивный вход заблокирован",
        notConfigured: "Не настроено",
      },
      sources: {
        environment: "Окружение",
        file: "Файл",
        command: "Команда",
        mixed: "Смешанный",
      },
    },
    connectedServiceTitle: "Подключённый сервис",
    notFoundTitle: "Провайдер не найден",
    notFoundSubtitle: "У этого провайдера нет экрана настроек.",
    noOptionsAvailable: "Нет доступных вариантов",
    invalidNumber: "Некорректное число",
    invalidJson: "Некорректный JSON",
    plugins: {
            claude: {
                title: "Claude (удаленно)",
                sections: {
                    claudeCodeExperiments: {
                        title: "Эксперименты Claude Code",
                        footer: "Эти настройки применяются как к локальным сессиям Claude (терминал), так и к удаленным сессиям Claude (Agent SDK), запущенным из Happier."
                    },
                    claudeUnifiedTerminal: {
                        title: "Единый терминал Claude",
                        footer: "Запускает Claude Code в терминальной сессии и позволяет Happier передавать поддерживаемые промпты через терминальный хост."
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK (удаленный режим)",
                        footer: "В удаленном режиме Claude работает на вашей машине, но управляется из интерфейса Happier. Локальный режим — это TUI Claude Code в терминале. Эти настройки влияют только на удаленный режим."
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Принудительно включить Agent Teams",
                        subtitle: "Включает экспериментальный Agent Teams в Claude Code (рой агентов) во всех сессиях Claude, запущенных из Happier."
                    },
                    claudeUnifiedTerminalEnabled: {
                        title: "Использовать единый терминальный режим",
                        subtitle: "Сохраняет Claude Code как каноническую терминальную сессию и отправляет поддерживаемые промпты Happier в эту сессию."
                    },
                    claudeUnifiedTerminalHost: {
                        title: "Терминальный хост",
                        subtitle: "Выберите, какой терминальный мультиплексор Happier использует для единых сессий Claude.",
                        options: {
                            auto: {
                                title: "Авто",
                                subtitle: "Предпочитать лучший поддерживаемый хост на этой машине."
                            },
                            tmux: {
                                title: "tmux",
                                subtitle: "Использовать tmux, когда он доступен."
                            },
                            zellij: {
                                title: 'zellij',
                                subtitle: "Использовать Zellij, когда он доступен и поддерживается."
                            }
                        }
                    },
                    claudeUnifiedTerminalResumeChoice: {
                        title: "Возобновление больших сессий",
                        subtitle: "Выберите, как Happier отвечает, когда Claude спрашивает, как возобновить большую сессию.",
                        options: {
                            ask_every_time: {
                                title: "Спрашивать каждый раз",
                                subtitle: "Показывает действие пользователя в сессии каждый раз, когда Claude спрашивает."
                            },
                            resume_from_summary: {
                                title: "Возобновить из сводки",
                                subtitle: "Использует сводку Claude, чтобы большие сессии возобновлялись быстрее."
                            },
                            resume_full_session: {
                                title: "Возобновить полную сессию",
                                subtitle: "Загружает весь контекст сессии, когда Claude предлагает выбор."
                            }
                        }
                    },
                    claudeUnifiedTerminalWorkspaceTrust: {
                        title: "Workspace trust",
                        subtitle: "Choose how Happier responds when Claude asks whether to trust a workspace.",
                        options: {
                            ask_every_time: {
                                title: "Ask every time",
                                subtitle: "Show the exact workspace trust question in the session."
                            },
                            always_trust_happier_workspaces: {
                                title: "Always trust Happier workspaces",
                                subtitle: "Trust the current recaptured Claude prompt for workspaces opened by Happier."
                            },
                            always_reject_happier_workspaces: {
                                title: "Always reject Happier workspaces",
                                subtitle: "Reject the current recaptured Claude prompt for workspaces opened by Happier."
                            }
                        }
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Использовать Agent SDK (удаленно)",
                        subtitle: "Использовать официальный @anthropic-ai/claude-agent-sdk для удаленного режима."
                    },
                    claudeRemoteDebugEnabled: {
                        title: "Режим debug",
                        subtitle: "Включает debug-логи Claude Code (эквивалент --debug)."
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "Подробно",
                        subtitle: "Включает подробное логирование (эквивалент --verbose)."
                    },
                    claudeRemoteDebugCategories: {
                        title: "Категории debug",
                        subtitle: "Необязательный фильтр категорий. Если пусто, Claude логирует все категории debug.",
                        options: {
                            api: {
                                title: "API",
                                subtitle: "HTTP/API запросы и ответы."
                            },
                            mcp: {
                                title: "MCP",
                                subtitle: "Подключения MCP серверов и трафик инструментов."
                            },
                            hooks: {
                                title: "Hooks",
                                subtitle: "Жизненный цикл хуков и выполнение команд."
                            },
                            file: {
                                title: "Файлы",
                                subtitle: "Операции файловой системы и вспомогательные функции."
                            },
                            '1p': {
                                title: "1p",
                                subtitle: "Внутренняя first-party категория."
                            }
                        }
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "Источники настроек",
                        subtitle: "Определяет, какие настройки Claude загружаются.",
                        options: {
                            user: {
                                title: "Пользователь",
                                subtitle: "Загружает глобальную пользовательскую конфигурацию Claude."
                            },
                            project: {
                                title: "Проект",
                                subtitle: "Загружает настройки репозитория (включая CLAUDE.md)."
                            },
                            local: {
                                title: "Локально",
                                subtitle: "Загружает только локальные переопределения."
                            }
                        }
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "Экспериментально: локальный мост разрешений",
                        subtitle: "Перенаправляет запросы разрешений Claude в локальном режиме в Happier, чтобы вы могли одобрять или отклонять их из интерфейса."
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "Оставлять запросы открытыми до ответа",
                        subtitle: "Когда включено, Happier держит локальные запросы разрешений Claude в ожидании, пока вы не подтвердите или не отклоните их в интерфейсе."
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "Необязательный таймаут разрешений (секунды)",
                        subtitle: "Используется только когда бесконечное ожидание отключено. По истечении этого времени Happier возвращается к терминальному запросу Claude."
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "Контрольные точки файлов + /rewind",
                        subtitle: "Включает контрольные точки файлов и /rewind (только файлы; диалог не откатывается). Используйте /checkpoints для списка и /rewind --confirm для применения (большие накладные расходы)."
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "Максимум thinking-токенов",
                        subtitle: "Ограничивает внутренний бюджет рассуждений Claude (null = по умолчанию)."
                    },
                    claudeRemoteDisableTodos: {
                        title: "Отключить TODO",
                        subtitle: "Запрещает Claude создавать TODO в удаленном режиме."
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "Строгая конфигурация MCP-сервера",
                        subtitle: "Завершается ошибкой, если любая конфигурация MCP-сервера недействительна."
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "Расширенные параметры (JSON)",
                        subtitle: "Продвинутые переопределения Agent SDK для опытных пользователей (проверяются на клиенте)."
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "Режим бэкенда",
                        footer: "Серверный режим открывает вопросы и нативный форк. Режим ACP — устаревший резервный вариант."
                    },
                    server: {
                        title: "Подключение к серверу",
                        footer: "Оставьте пустым, чтобы использовать управляемый Happier жизненный цикл сервера OpenCode. Укажите абсолютный URL http(s), чтобы подключиться к существующему серверу OpenCode."
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "Режим бэкенда OpenCode",
                        subtitle: "Выберите интеграционный бэкенд.",
                        options: {
                            server: {
                                title: "Сервер (рекомендуется)",
                                subtitle: "Использует серверные API OpenCode для более богатых функций и надежности."
                            },
                            acp: {
                                title: "ACP (устаревший)",
                                subtitle: "Направляет OpenCode через ACP; функций меньше."
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "URL существующего сервера OpenCode",
                        subtitle: "Необязательное переопределение для пользовательского сервера OpenCode."
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
                title: "Пользовательский ACP"
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
                        title: 'Совместимость',
                        footer: 'Используйте режим совместимости только в Linux/контейнерных средах, где запуск Kimi ACP зависает.'
                    }
                },
                fields: {
                    kimiAcpPythonSelector: {
                        title: 'Выбор Python stdio',
                        subtitle: 'Выберите, как Happier запускает stdio-цикл Python для Kimi ACP.',
                        options: {
                            auto: {
                                title: 'Автоматически',
                                subtitle: 'Использовать выбор Python по умолчанию для Kimi.'
                            },
                            poll: {
                                title: 'Режим совместимости',
                                subtitle: 'Использовать poll() вместо epoll() для stdio Kimi ACP.'
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
                        title: "Среда выполнения",
                        footer: "Выберите, как запускать сессии Antigravity. Режим CLI использует вход по подписке с ограниченным live-управлением; режим SDK использует Gemini API или учётные данные Vertex."
                    }
                },
                fields: {
                    antigravityRuntimeMode: {
                        title: "Режим выполнения",
                        subtitle: "Выберите авто-маршрутизацию, print-режим CLI с подпиской или режим SDK.",
                        options: {
                            auto: {
                                title: "Авто",
                                subtitle: "Сначала использовать CLI с подпиской, если он доступен, затем учётные данные SDK."
                            },
                            cliPrint: {
                                title: "Antigravity CLI (подписка)",
                                subtitle: "Использует print-режим agy с локальным входом; live-подтверждения инструментов ограничены."
                            },
                            sdk: {
                                title: "SDK Antigravity (Gemini API / Vertex)",
                                subtitle: "Использует ключ Gemini API или учётные данные Vertex через SDK."
                            }
                        }
                    }
                }
            },
            codex: {
        title: "Codex",
        sections: {
          backendMode: {
            title: "Режим маршрутизации",
            footer:
              "Выберите, как маршрутизировать Codex. App Server — рекомендуемый вариант по умолчанию. Переключение локальный/удалённый и возобновление работают с App Server; ACP остаётся как устаревший запасной вариант.",
          },
          installOverrides: {
            title: "Переопределение источника установки",
            footer:
              "Необязательно. Оставьте пустым, чтобы использовать источники установки по умолчанию.",
          },
        },
        fields: {
          codexBackendMode: {
            title: "Режим маршрутизации Codex",
            subtitle: "Выберите App Server, ACP или MCP.",
            options: {
              appServer: {
                title: "Сервер приложений",
                subtitle: "Рекомендуемый официальный режим Codex app-server",
              },
              acp: {
                title: "ACP",
                subtitle: "Маршрутизировать Codex через ACP (codex-acp)",
              },
              mcp: {
                title: "MCP",
                subtitle: "Режим Codex MCP по умолчанию",
              },
            },
          },
        },
      },
    },
  },

  workspaceCockpit: {
    openCockpit: 'Открыть cockpit',
    openClassicView: 'Открыть классический вид',
    tabs: 'Вкладки',
  },

  settingsAppearance: {
    tabBarAppearance: {
      title: 'Панель вкладок',
      footer: 'Настройте нижнюю панель вкладок.',
      showLabels: 'Показывать подписи вкладок',
      size: 'Размер панели вкладок',
      sizeCompact: 'Компактный',
      sizeRegular: 'Обычный',
      sizeLarge: 'Большой',
    },
    glass: {
      title: 'Стеклянные поверхности',
      footer: 'Используйте полупрозрачный материал размытия для плавающих стеклянных поверхностей — панели вкладок, кнопки перехода вниз и других.',
      enable: 'Размытие стекла',
      intensity: 'Интенсивность размытия',
      intensityLight: 'Слабая',
      intensityRegular: 'Обычная',
      intensityStrong: 'Сильная',
      composer: 'Стеклянный редактор',
      composerHint: 'Подстройтесь под панель вкладок — используйте её цвет поверхности и отбрасывайте тень для редактора сообщений.',
    },
    tabBarBadges: {
      title: 'Значки панели вкладок',
      footer: 'Выберите, какие значки отображаются на нижней панели вкладок.',
      gitTitle: 'Значок вкладки Git',
      gitChangedFiles: 'Изменённые файлы',
      gitDiffLines: 'Добавленные и удалённые строки',
      gitOff: 'Выкл.',
    },
    ...settingsAppearanceTranslationExtension,
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
    contentWidth: "Ширина содержимого",
    contentWidthDescription:
      "Выберите, насколько широко может растягиваться основное содержимое",
    contentWidthOptions: {
      compact: "Компактная",
      compactDescription: "Ограничить основное содержимое 850 px",
      medium: "Средняя",
      mediumDescription: "Разрешить основному содержимому ширину до 960 px",
      full: "На всю ширину",
      fullDescription: "Использовать доступную ширину окна",
    },
    backdropBlur: "Размытие фона",
    backdropBlurDescription:
      "Использовать размытие фона за модальными окнами и меню. Отключите, чтобы повысить производительность браузера.",
    multiPanePanels: "Правые панели",
    multiPanePanelsDescription:
      "Показывать изменяемые по размеру правые панели для файлов и контроля версий (web/tablet)",
    sessionsRightPaneDefaultOpen: "Всегда показывать правую боковую панель в сессиях",
    sessionsRightPaneDefaultOpenDescription:
      "Автоматически открывать правую боковую панель при входе в сессию (web/tablet)",
    detailsPaneTabsBehavior: "Вкладки редактора",
    detailsPaneTabsBehaviorDescription:
      "Выберите поведение вкладок файлов в панели редактора",
    detailsPaneTabsBehaviorOptions: {
      preview: "Вкладка предпросмотра",
      persistent: "Постоянные вкладки",
    },
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
      meshGradient: "Сеточный градиент",
      meshGradientOrganic: "Сеточный градиент: органика",
      meshGradientRows: "Сеточный градиент: ряды",
      meshGradientColumns: "Сеточный градиент: колонки",
      meshGradientDiagonal: "Сеточный градиент: диагональ",
      meshGradientOval: "Сеточный градиент: овал",
      meshGradientWaves: "Сеточный градиент: волны",
      meshGradientSoftNoise: "Сеточный градиент: мягкий шум",
      photoGradient: "Слоистый градиент",
      photoGradientRows: "Слоистый градиент: ряды",
      photoGradientColumns: "Слоистый градиент: колонки",
      photoGradientDiagonal: "Слоистый градиент: диагональ",
      photoGradientWaves: "Слоистый градиент: волны",
      photoGradientOval: "Слоистый градиент: овал",
      photoGradientValueNoise: "Слоистый градиент: мягкий шум",
      photoGradientVoronoi: "Слоистый градиент: ячейки",
      photoGradientMeshGrid: "Слоистый градиент: сетка",
    },
    showFlavorIcons: "Показывать иконки провайдеров ИИ",
    showFlavorIconsDescription:
      "Отображать иконки провайдеров ИИ на аватарах сессий",
    compactSessionView: "Компактный вид сессий",
    compactSessionViewDescription:
      "Отображать активные сессии в более компактном виде",
    compactSessionViewMinimal: "Минимальный компактный вид",
    compactSessionViewMinimalDescription:
      "Использовать самый узкий макет строки сессии",
    text: "Текст",
    textDescription: "Настройка размера текста в приложении",
    textSize: "Размер текста",
    textSizeDescription: "Сделать текст больше или меньше",
    textSizeOptions: {
      xxsmall: "Очень очень маленький",
      xsmall: "Очень маленький",
      small: "Маленький",
      default: "По умолчанию",
      large: "Большой",
      xlarge: "Очень большой",
      xxlarge: "Очень очень большой",
    },
    itemDensity: "Плотность элементов",
    itemDensityDescription: "Выберите размер строк списков и настроек во всём приложении",
    itemDensityOptions: {
      comfortable: "Стандартная",
      comfortableDescription: "Использовать стандартный размер и интервалы строк",
      cozy: "Средняя",
      cozyDescription: "Использовать немного более плотные строки без перехода к компактному виду",
      compact: "Компактная",
      compactDescription: "Показывать больше строк на экране с меньшими интервалами",
    },

    settingsNavSidebar: "Боковая панель настроек",
    settingsNavSidebarDescription:
      "Показывать боковую панель навигации по настройкам (web/tablet)",},

  settingsChannelBridges: {
    unsupported: "Мосты каналов не поддерживаются в этой среде.",
    enableInFeatures: "Включить мосты каналов",
    enableInFeaturesSubtitle: "Мосты каналов — экспериментальная функция и по умолчанию отключены.",
    description: "Мосты каналов позволяют привязывать внешние чаты (Telegram) к сессиям и пересылать сообщения агенту.",
    telegramTitle: "Telegram",
    telegramFooter: "Настройте Telegram через CLI, затем управляйте привязками в Telegram с помощью /sessions, /attach, /detach, /help.",
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
    localTogglesTitle: "Функции",
    localTogglesFooter:
      "Локальные переключатели по функциям (независимо от поддержки сервера).",
    featureDiagnostics: {
      title: "Диагностика функций",
      footer:
        "Итоговые решения по функциям (политика сборки, локальная политика, проверки демона/сервера и область действия).",
      decisionUnknown: "неизвестно",
      decisionEnabled: "включено",
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
    expAutomations: "Автоматизации",
    expAutomationsSubtitle: "Включить интерфейс автоматизаций и планирование",
    expExecutionRuns: "Запуски выполнений",
    expExecutionRunsSubtitle:
      "Включить панель управления запусками (суб-агенты / ревью)",
    expAttachmentsUploads: "Загрузка вложений",
    expAttachmentsUploadsSubtitle:
      "Включить загрузку файлов/изображений для чтения агентом с диска",
    expUsageReporting: "Отчёты об использовании",
    expUsageReportingSubtitle: "Включить экраны отчётов об использовании и токенах",
    expScmOperations: "Операции контроля версий",
    expScmOperationsSubtitle:
      "Включить экспериментальные операции записи контроля версий (stage/commit/push/pull)",
    expFilesReviewComments: "Комментарии к файлам",
    expFilesReviewCommentsSubtitle:
      "Добавлять построчные комментарии из просмотра файлов и diff, отправлять как структурированное сообщение",
    expFilesDiffSyntaxHighlighting: "Подсветка синтаксиса в diff",
    expFilesDiffSyntaxHighlightingSubtitle:
      "Включить подсветку синтаксиса в diff и просмотре кода (с ограничениями производительности)",
    expFilesAdvancedSyntaxHighlighting: "Расширенная подсветка синтаксиса",
    expFilesAdvancedSyntaxHighlightingSubtitle:
      "Использовать более точную подсветку синтаксиса (только веб, может замедлять)",
    expFilesEditor: "Встроенный редактор файлов",
    expFilesEditorSubtitle:
      "Редактирование файлов прямо в файловом менеджере (Monaco на вебе/десктопе, CodeMirror на мобильных)",
    expMarkdownRichEditor: "Редактор Markdown с форматированием",
    expMarkdownRichEditorSubtitle:
      "Включить редактор Markdown с форматированием (WYSIWYG) в редакторе файлов, с откатом к исходному тексту при необходимости",
    expEmbeddedTerminal: "Встроенный терминал",
    expEmbeddedTerminalSubtitle:
      "Откройте настоящий терминал внутри сессий.",
    expSessionType: "Выбор типа сессии",
    expSessionTypeSubtitle:
      "Показывать выбор типа сессии (простая или worktree)",
    expZen: "Zen",
    expZenSubtitle: "Включить навигацию Zen",
    expVoiceAuthFlow: "Авторизация голоса",
    expVoiceAuthFlowSubtitle:
      "Использовать авторизованный голосовой поток (с учётом подписки)",
    voice: "Голос",
    voiceSubtitle: "Включить голосовые функции",
    expVoiceAgent: "Голосовой агент",
    expVoiceAgentSubtitle: "Включить голосовые поверхности на базе демона (требуются запуски выполнений)",
    expVoiceDaemonInference: 'Голосовой вывод через daemon',
    expVoiceDaemonInferenceSubtitle: 'Включить локальные голосовые элементы управления через daemon',
    expLiveActivities: 'Live Activities',
    expLiveActivitiesSubtitle: 'Включить поверхности Live Activities для прогресса сессии',
    expHomeScreenWidgets: 'Виджеты главного экрана',
    expHomeScreenWidgetsSubtitle: 'Включить виджеты главного экрана для активности Happier',
    expConnectedServicesQuotas: "Квоты подключённых сервисов",
    expConnectedServicesQuotasSubtitle: "Показывать бейджи квот и счётчики использования подключённых сервисов",
    expChannelBridges: "Мосты каналов",
    expChannelBridgesSubtitle: "Подключайте Telegram и другие чаты к сессиям Happier (экспериментально)",
    expMemorySearch: "Поиск по памяти",
    expMemorySearchSubtitle: "Включить экраны и настройки локального поиска по памяти",
    expSessionsDirect: "Внешние сессии",
    expSessionsDirectSubtitle: "Находите и связывайте существующие сессии агентов на боковой панели",
    expSessionsFolders: "Папки сессий",
    expSessionsFoldersSubtitle: "Организуйте сеансы Happier на боковой панели по папкам рабочих пространств",
    expPetsCompanion: "Питомцы",
    expPetsCompanionSubtitle: "Включить поверхности компаньона Blink и локальный выбор питомцев",
    expFriends: "Друзья",
    expFriendsSubtitle: "Включить функции друзей (вкладка «Входящие» и обмен сессиями)",
    webFeatures: "Веб-функции",
    webFeaturesDescription:
      "Функции, доступные только в веб-версии приложения.",
    enterToSend: "Enter для отправки",
    enterToSendEnabled:
      "Нажмите Enter для отправки (Shift+Enter для новой строки)",
    enterToSendDisabled: "Enter вставляет новую строку",
    historyScope: "История сообщений",
    historyScopePerSession: "Перебор истории по сессии",
    historyScopeGlobal: "Перебор истории по всем сессиям",
    historyScopeModalTitle: "История сообщений",
    historyScopeModalMessage:
      "Выберите, перебирает ли ArrowUp/ArrowDown сообщения только этой сессии или всех сессий.",
    historyScopePerSessionOption: "По сессии",
    historyScopeGlobalOption: "Глобально",
      commandPalette: "Палитра команд",
      commandPaletteEnabled: "Используйте сочетание клавиш для открытия",
      commandPaletteDisabled: "Быстрый доступ к командам отключён",
      hideInactiveSessions: "Скрывать неактивные сессии",
      hideInactiveSessionsSubtitle: "Показывать в списке только активные чаты",
      hiddenInactiveSessionsEmptyStateTitle: "Сейчас нет активных сессий",
      hiddenInactiveSessionsEmptyStateSubtitle: "Неактивные сессии скрыты в этом списке",
      hiddenInactiveSessionsSectionTitle: "Неактивные сессии",
      hiddenInactiveSessionsSectionSubtitle: "Скрыты в основном списке, потому что там показываются только активные чаты",
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
    environmentBadge: "Бейдж окружения",
    environmentBadgeSubtitle:
      "Показывать маленький бейдж рядом с названием Happier с текущим окружением приложения",
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
    permissionDeniedReadOnlyMode: "Отклонено режимом «Только чтение» (операции записи запрещены).",
    permissionCanceled: "Разрешение отменено",
    permissionCanceledSessionInactive: "Сессия неактивна — этот запрос разрешения нельзя подтвердить.",
      fileNotFound: "Файл не найден",
      invalidFormat: "Неверный формат",
      operationFailed: "Операция не выполнена",
      failedToForkSession: "Не удалось создать ветку сессии",
      daemonUnavailableTitle: "Демон недоступен",
      daemonUnavailableBody:
        "Happier не может подключиться к демону на этой машине. Он может быть офлайн, ещё запускаться или быть отключён от сервера.",
      tryAgain: "Пожалуйста, попробуйте снова",
      contactSupport: "Если проблема сохранится, обратитесь в поддержку",
      sessionNotFound: "Сессия не найдена",
        voiceSessionFailed: "Не удалось запустить голосовую сессию",
        dictationFailed: "Не удалось выполнить диктовку",
        voiceServiceUnavailable: "Голосовой сервис временно недоступен",
        voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
          `Лимит голосовой сессии: примерно ${duration}.`,
        voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
          `Голосовая сессия завершится примерно через ${duration}.`,
        voiceSessionLimitExpired:
          "Голосовая сессия достигла текущего лимита времени и завершилась.",
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
    codexResumeNotInstalledTitle: "Сервер возобновления Codex не установлен на этой машине",
    codexResumeNotInstalledMessage:
      "Чтобы возобновить разговор Codex, установите сервер возобновления Codex на целевой машине (Детали машины → Installables).",
    codexAcpNotInstalledTitle: "Codex ACP не установлен на этой машине",
    codexAcpNotInstalledMessage:
      "Чтобы использовать эксперимент Codex ACP, установите codex-acp на целевой машине (Детали машины → Installables) или отключите эксперимент.",

    sourceControlUnavailableForSession: "Source control is unavailable for this session.",},

  deps: {
    installNotSupported:
      "Обновите Happier CLI, чтобы установить эту зависимость.",
    installFailed: "Не удалось установить",
    installed: "Установлено",
    installLog: ({ path }: { path: string }) => `Лог установки: ${path}`,
    installable: {
      codexResume: {
        title: "Сервер возобновления Codex",
      },
      codexAcp: {
        title: "Адаптер Codex ACP",
      },
      githubCli: {
        title: "CLI GitHub",
      },

      gh: {
        title: "GitHub CLI",
      },},
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
      lastInstallLog: "Последний лог установки",
      installLogTitle: "Лог установки",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
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
	    checkout: {
	      selectTitle: "Выбрать checkout",
	      noWorktree: "Текущая папка",
          noWorktreeSubtitle: "Использовать уже выбранную папку без привязки checkout workspace.",
          noWorktreeSectionTitle: "Текущая папка",
	          existingWorktreesSectionTitle: "Связанные checkouts",
	          actionsSectionTitle: "Действия",
		      newWorktree: "Новый worktree",
		      newWorktreeSubtitle: "Создайте и используйте новый Git worktree для этой сессии.",
		      pendingWorktreeSubtitle: ({ branch, path }: { branch: string; path: string }) => `Из ${branch} · ${path}`,
              existingWorktree: "Существующий worktree",
              existingWorktreeSubtitle: "Выберите существующий Git worktree для этой сессии.",
              existingWorktreeEmptyTitle: "Нет существующих worktree",
              existingWorktreeEmptySubtitle: "Сначала создайте Git worktree или выберите Новый worktree.",
	          newWorktreeDetailWorkspace: "Создать новый связанный checkout в этом workspace.",
	          newWorktreeDetailBranch: "Использовать текущее состояние репозитория и выбрать новое имя ветки/worktree.",
          branchPickerTitle: "Начать с",
          branchPickerCurrentHead: "Текущий филиал",
          branchPickerCurrentHeadDescription: "Начните с ветки, извлеченной в данный момент в этом репозитории.",
          branchPickerEmpty: "Для этого репозитория нет доступных ветвей.",
          branchPickerSearchPlaceholder: "Поиск веток…",
          branchPickerRefreshA11y: "Обновить ветки",
          branchPickerLoadingA11y: "Загрузка веток",
          branchPickerRefreshingA11y: "Обновление ветвей",
          primaryDetailDescription: "Использовать основной связанный checkout этого workspace на выбранной машине.",
          gitWorktreeDetailDescription: "Использовать уже связанный Git worktree checkout для этой сессии.",
          existingBranchWorktreeDescription: "В этой ветке уже есть рабочее дерево. ",
          existingBranchDescription: "Эту ветку можно использовать непосредственно в новом рабочем дереве или создать на ее основе новую ветку.",
          createNewBranchFromBranchHint: "Используйте Apply, чтобы создать новую ветку и рабочее дерево из этой ветки.",
          useExistingBranchAction: "Использовать существующую ветку",
          useExistingWorktreeAction: "Использовать существующее рабочее дерево",
          detailBranch: ({ branch }: { branch: string }) => `Ветка: ${branch}`,
          detailPath: ({ path }: { path: string }) => `Путь: ${path}`,
          detailLinkedWorkspace: "Связано с текущим рабочим пространством.",
	    },
	    selectSessionTypeTitle: "Выбрать тип сессии",
	    selectSessionTypeDescription:
	      "Выберите простую сессию или сессию, привязанную к Git worktree.",
	    searchPathsPlaceholder: "Поиск путей...",
	    noMachinesFound:
	      "Машины не найдены. Сначала запустите сессию Happier на вашем компьютере.",
	    allMachinesOffline: "Все машины не в сети",
	    machineOfflineInlineTitle: "Машина офлайн",
	    machineOfflineInlineBody:
	      "Запустите демон на этой машине или выберите другую перед созданием сессии.",
	    machineOfflineCannotStartStatus: "не в сети (нельзя начать сессию)",
        automationChip: {
            default: 'Автоматизировать',
            interval: ({ minutes }: { minutes: number }) => `Каждые ${minutes} мин`,
            cron: 'Cron-расписание',
        },
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
    daemonRpcUnavailableTitle: "Демон недоступен",
    daemonRpcUnavailableBody:
      "Happier не может подключиться к демону на этой машине. Он может быть офлайн, ещё запускаться или быть отключён от сервера.",
    launchStillPendingTitle: "Запуск всё ещё выполняется",
    launchStillPendingBody:
      "Happier ещё не подтвердил новую сессию. Запрос на запуск сохранён. Повторите попытку, чтобы продолжить тот же запуск без создания дубликата сессии.",
    connectedServiceSwitchUnavailable: {
      title: "Переключение недоступно",
      body: ({ reason, agentId }: { reason: string; agentId: string }) =>
        `Эту сессию нельзя продолжить под новой учётной записью, поскольку её предыдущий разговор ${agentId} не удалось перенести (${reason}).\n\nВместо этого вы можете начать заново под новой учётной записью — это запустит новый разговор без предыдущей истории.`,
      startFreshAction: "Начать заново под новой учётной записью",
    },
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
      truncatedDirectoryInfo: ({ count }: { count: number }) => `Показаны первые ${count} элементов`,
      recentTitle: "Недавние",
      favoritesTitle: "Избранное",
      suggestedTitle: "Рекомендуемые",
      allTitle: "Все",
      emptyRecent: "Нет недавних путей",
      emptyFavorites: "Нет избранных путей",
      emptySuggested: "Нет рекомендуемых путей",
      emptyAll: "Нет путей",
      inThisFolderTitle: "В этой папке",
      openInTreeBrowserLabel: "Открыть в дереве",
      openFolderLabel: "Показать содержимое папки",
      emptyInThisFolder: "Нет совпадений в этой папке",
      favoriteAdd: "Добавить в избранное",
      favoriteRemove: "Удалить из избранного",
      hints: {
        navigate: "навигация",
        commit: "подтвердить путь",
        autocomplete: "автодополнение",
        walkUp: "на уровень выше",
      },
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
    profileSelection: {
      workspaceDefault: "По умолчанию для рабочего пространства",
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
      createTitle: "Новый worktree из ветки",
      backToRoot: "Worktrees",
      searchPlaceholder: "Поиск worktrees",
      searchBranchPlaceholder: "Поиск веток",
      sections: {
        localBranches: "ЛОКАЛЬНЫЕ ВЕТКИ",
        remoteBranches: "УДАЛЁННЫЕ ВЕТКИ",
      },
      statusPill: {
        clean: "чисто",
        idle: "неактивно",
        // FR4-10: StatusPill renders the count separately; suffix-only.
        changesSuffix: ({ count }: { count: number }) =>
          plural({ count, one: "изменение", few: "изменения", many: "изменений" }),
      },
      branchRow: {
        reuseLabel: "Есть worktree",
        reuseSubtitle: ({ path }: { path: string }) => path,
      },
      nameStep: {
        title: "Назовите worktree",
        backLabel: "Ветки",
        placeholder: "Назовите этот worktree",
        emptyHint: "Это станет именем новой ветки и worktree.",
        suggestedSectionTitle: "Предложено",
        suggestedSubtitle: "Использовать сгенерированное имя",
        useSuggested: ({ name }: { name: string }) => `Использовать предложенное имя: ${name}`,
        createNamed: ({ name }: { name: string }) => `Создать worktree: ${name}`,
        customHint: "Или введите имя выше для своего worktree",
        hints: {
          create: "создать",
          back: "назад",
        },
      },
      reuseOrCreate: {
        title: "У ветки уже есть worktree",
        useExisting: "Использовать существующий worktree",
        createNew: "Создать новый worktree из этой ветки",
        createNewSubtitle: "Ответвить в новый worktree с именем",
      },
      hints: {
        navigate: "навигация",
        select: "выбрать",
        back: "назад",
      },
    },
    resume: {
      title: "Продолжить сессию",
      optional: "Продолжить: необязательно",
      chipOptional: ({ agent }: { agent: string }) => `Продолжить сессию ${agent}`,
      pickerTitle: "Продолжить сессию",
      subtitle: ({ agent }: { agent: string }) =>
        `Вставьте ID сессии ${agent} для продолжения`,
      placeholder: ({ agent }: { agent: string }) =>
        `Вставьте ID сессии ${agent}…`,
      browse: "Просмотреть сеансы",
      paste: "Вставить",
      save: "Сохранить",
      clearAndRemove: "Очистить",
      helpText: "ID сессии можно найти на экране информации о сессии.",
      cannotApplyBody:
        "Этот ID возобновления сейчас нельзя применить. Happier вместо этого начнёт новую сессию.",
    },
    codexResumeBanner: {
      title: "Сервер возобновления Codex",
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
      installTitle: "Установить сервер возобновления Codex?",
      updateTitle: "Обновить сервер возобновления Codex?",
      reinstallTitle: "Переустановить сервер возобновления Codex?",
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
        githubCliBanner: {
            title: 'GitHub CLI',
            install: 'Установить',
            update: 'Обновить',
            reinstall: 'Переустановить',
        },
    githubCliInstallModal: {
      installTitle: "Установить GitHub CLI?",
      updateTitle: "Обновить GitHub CLI?",
      reinstallTitle: "Переустановить GitHub CLI?",
      description:
        "Устанавливает GitHub CLI, чтобы Happier мог использовать вашу локальную аутентификацию GitHub в сценариях pull request.",
    },

    ghCliBanner: {
      title: "GitHub CLI",
      install: "Установить",
      update: "Обновить",
      reinstall: "Переустановить",
    },
    ghCliInstallModal: {
      installTitle: "Установить GitHub CLI?",
      updateTitle: "Обновить GitHub CLI?",
      reinstallTitle: "Переустановить GitHub CLI?",
      description:
        "Это установит необязательную зависимость GitHub CLI, используемую рабочими процессами GitHub для контроля исходного кода, после вашего подтверждения.",
    },},

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

  sessionHandoff: sessionHandoffTranslationExtensions.ru,

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Настройки Relay",
    enterServerUrl: "Пожалуйста, введите URL Relay",
    notValidHappyServer: "Это не валидный Relay Happier",
    changeServer: "Изменить Relay",
    continueWithServer: "Продолжить с этим Relay?",
    resetToDefault: "Сбросить по умолчанию",
    resetServerDefault: "Сбросить Relay по умолчанию?",
    validating: "Проверка...",
    validatingServer: "Проверка Relay...",
    serverReturnedError: "Relay вернул ошибку",
    failedToConnectToServer: "Не удалось подключиться к Relay",
    currentlyUsingCustomServer: "Сейчас используется пользовательский Relay",
    customServerUrlLabel: "URL пользовательского Relay",
    advancedFeatureFooter:
      "Это расширенная функция. Изменяйте Relay только если знаете, что делаете. Вам нужно будет выйти и войти снова после изменения Relays.",
    useThisServer: "Использовать этот Relay",
    autoConfigHint:
      "Если вы хостите сами: сначала настройте Relay, затем войдите (или создайте аккаунт), затем подключите терминал.",
    renameServer: "Переименовать Relay",
    renameServerPrompt: "Введите новое имя для этого Relay.",
    renameServerGroup: "Переименовать группу Relay",
    renameServerGroupPrompt: "Введите новое имя для этой группы Relay.",
    serverNamePlaceholder: "Имя Relay",
    cannotRenameCloud: "Облачный Relay нельзя переименовать.",
    removeServer: "Удалить Relay",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Удалить "${name}" из сохранённых Relay?`,
    removeServerGroup: "Удалить группу Relay",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Удалить "${name}" из сохранённых групп Relay?`,
    cannotRemoveCloud: "Облачный Relay нельзя удалить.",
    signOutThisServer: "Также выйти с этого Relay?",
    signOutThisServerPrompt:
      "На этом устройстве найдены сохранённые учётные данные для этого Relay.",
    savedServersTitle: "Сохранённые Relay",
    signedIn: "Авторизован",
    signedOut: "Не авторизован",
    authStatusUnknown: "Статус авторизации неизвестен",
    switchToServer: "Переключиться на этот Relay",
    active: "Активный",
    default: "По умолчанию",
    addServerTitle: "Добавить Relay",
    switchForThisTab: "Переключить для этой вкладки",
    makeDefaultOnDevice: "Сделать по умолчанию на этом устройстве",
    serverNameLabel: "Имя Relay",
    addAndUse: "Добавить и использовать",
    addTargetsTitle: "Добавить",
    addServerSubtitle: "Добавить новый Relay и переключиться на него",
    notificationAddServerHint: "Этот Relay ещё не сохранён на этом устройстве. Добавьте его ниже, чтобы продолжить.",
    serverCount: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "Relay", few: "Relay", many: "Relay" })}`,
    useCanonicalServerUrlTitle: "Использовать канонический URL Relay?",
    useCanonicalServerUrlBody:
      "Этот Relay сообщает канонический URL, который должен работать с других устройств. Использовать его вместо введённого?",
    insecureHttpUrlTitle: "Небезопасный URL Relay",
    insecureHttpUrlBody:
      "Этот URL использует http:// и может не работать с телефона или вне вашей LAN. По возможности используйте HTTPS. Продолжить всё равно?",
    signedOutSwitchConfirmTitle: "Вы не подключены",
    signedOutSwitchConfirmBody:
      "Переключиться на этот Relay и перейти на главный экран, чтобы вы могли войти или создать аккаунт?",
    addServerGroupTitle: "Добавить группу Relay",
    addServerGroupSubtitle: "Создать группу Relay для повторного использования",
    serverGroupNameLabel: "Имя группы",
    serverGroupNamePlaceholder: "Моя группа Relay",
    serverGroupServersLabel: "Relay",
    saveServerGroup: "Сохранить группу",
    serverGroupMustHaveServer: "Группа Relay должна включать хотя бы один Relay.",
    relayDrift: {
        bannerDifferentRelayTitle: "Фоновая служба подключена к другому Relay",
        bannerDifferentRelayDescription: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) => `App: ${activeRelayUrl} · Background service: ${daemonRelayUrl}`,
        bannerNeedsAuthTitle: "Фоновой службе нужно войти в этот Relay",
        bannerNeedsAuthDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `The app is using ${activeRelayUrl}, but the background service still needs approval or sign-in.`,
        bannerNotConfiguredTitle: "Фоновая служба ещё не подключена к этому Relay",
        bannerNotConfiguredDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `The app is using ${activeRelayUrl}, but this computer has not finished connecting the background service.`,
        bannerNotInstalledTitle: "Фоновая служба не установлена для этого Relay",
        bannerNotInstalledDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `The app is using ${activeRelayUrl}, but this computer still needs to install the background service for it.`,
        bannerNotRunningTitle: "Фоновая служба установлена, но не запущена",
        bannerNotRunningDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `The app is using ${activeRelayUrl}, but the background service is stopped and needs to be started again.`,
        repairAction: "Подключить фоновую службу к этому Relay",
        progressTitle: 'Подключение фоновой службы к этому Relay',
        progressStepPrepare: 'Подготовить фоновую службу',
        progressStepConfigureRelay: 'Обновить подключение к Relay',
        progressStepAuthenticate: 'Завершить вход и подтверждение',
        progressStepFinish: 'Завершить восстановление',
        statusUnknown: "Неизвестно",
    },
    retention: {
        title: "Политика хранения",
        summary: "Сводка",
        keepForever: "Без автоматического удаления",
        deleteInactiveSessionsDays: ({ count }: { count: number }) => `Удаляет неактивные сессии через ${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })}.`,
        deleteOlderThanDays: ({ count }: { count: number }) => `Удаляет данные через ${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })}.`,
        sessionNotice: ({ count }: { count: number }) => `Этот Relay удаляет неактивные сессии после ${count} ${plural({ count, one: 'дня', few: 'дней', many: 'дней' })} бездействия.`,
        sessions: "Сессии",
        accountChanges: "Изменения аккаунта",
        voiceSessionLeases: "Аренды голосовых сессий",
        feedItems: "Элементы ленты",
        sessionShareAccessLogs: "Журналы доступа к общим сессиям",
        publicShareAccessLogs: "Журналы доступа к публичным ссылкам",
        terminalAuthRequests: "Запросы авторизации терминала",
        accountAuthRequests: "Запросы авторизации аккаунта",
        authPairingSessions: "Сессии сопряжения авторизации",
        repeatKeys: "Ключи повторов",
        globalLocks: "Глобальные блокировки",
        automationRuns: "Запуски автоматизаций",
        automationRunEvents: "События запусков автоматизаций",
    },
    multiServerView: {
      title: "Параллельный просмотр нескольких Relay",
      footer: "Выберите, объединять ли несколько Relay в одном списке сессий.",
      enableTitle: "Включить параллельный просмотр",
      enableSubtitle: "Показывать вместе сессии выбранных Relay",
      presentationTitle: "Режим отображения",
      presentation: {
        flatWithBadges: "Плоский список с бейджами Relay",
        groupedByServer: "Сгруппировано по Relay",
      },
    },

    reachabilityRemediation: {
      failedToOpenInstallLink: "Не удалось открыть страницу установки Tailscale.",
      tailscale: {
        title: "Этот Relay использует Tailscale",
        desktopBody: "Этот компьютер не смог подключиться к Relay через Tailscale. Возможно, Tailscale не установлен, вы не вошли в него или он не подключён к нужному tailnet на этом компьютере.",
        webBody: "Этот браузер не смог подключиться к Relay через Tailscale. Откройте Tailscale на этом устройстве, убедитесь, что он подключён к нужному tailnet, и повторите попытку.",
        nativeBody: "Это устройство не смогло подключиться к Relay через Tailscale. Откройте Tailscale, убедитесь, что он подключён к нужному tailnet, и повторите попытку.",
        installAction: "Установить Tailscale",
        desktopPrepareAction: "Подготовить Tailscale",
      },
    },},

  sessionTags: {
    searchOrAddPlaceholder: "Найти или добавить теги",
    editTagsLabel: "Редактировать теги",
    noTagsFound: "Теги не найдены",
    newTagItem: "Новый тег…",
    newTagTitle: "Новый тег",
    newTagMessage: "Введите название нового тега.",
    newTagConfirm: "Добавить",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Сервер: ${server}`,
    storagePersistedTab: "Happier",
    storageAllFilter: "Все",
    storageFilterCategory: "Сессии",
    storageExternalFilter: "Внешние",
    storageDirectTab: "Прямые",
    renameWorkspace: 'Переименовать рабочую область',
    renameWorkspacePromptTitle: 'Переименовать рабочую область',
    renameWorkspacePromptPlaceholder: 'Введите название...',
    resetWorkspaceName: 'Сбросить название',
    viewOptions: 'Параметры вида',
    searchSessions: 'Поиск сеансов',
    searchSessionsPlaceholder: 'Поиск сеансов...',
    filterByTags: 'Фильтр по тегам',
    folders: 'Папки',
    addFolder: 'Добавить папку',
    addFolderPromptTitle: 'Добавить папку',
    addSubfolder: 'Добавить подпапку',
    addSubfolderPromptTitle: 'Добавить подпапку',
    folderNamePlaceholder: 'Название папки',
    renameFolder: 'Переименовать папку',
    renameFolderPromptTitle: 'Переименовать папку',
    moveFolder: 'Переместить папку',
    deleteFolder: 'Удалить папку',
    deleteFolderPromptTitle: 'Удалить папку',
    deleteFolderPromptDescription: 'Сессии в этой папке останутся в рабочей области.',
    newSessionInFolder: 'Новая сессия в папке',
    clearFolderFocus: 'Сбросить фокус папки',
    folderViewTree: 'Вид папок',
    folderViewOff: 'Скрыть папки',
    moveToFolder: 'Переместить в папку',
    moveToWorkspaceRoot: 'Корень рабочей области',
    sessionFallbackLabel: 'Session',
    moveSheetTitle: ({ item }: { item: string }) => 'Move ' + item,
    moveSheetDestinationLabel: 'Destination',
    moveSheetSubmit: 'Move',
    moveSheetSearchPlaceholder: 'Search folders...',
    moveSheetEmpty: 'No move targets available',
    moveSheetDestinations: 'Destinations',
    moveSheetDisabledDescendant: 'Cannot move into itself or a child folder.',
    moveSheetDisabledMaxDepth: 'This would exceed the folder depth limit.',
    moveSheetDisabledCurrent: 'Already in this location.',
    moveSheetDisabledUnavailable: 'This destination is not available.',
    dragHandleA11yLabel: 'Drag handle',
    dragA11yPickedUp: ({ item }: { item: string }) => 'Picked up ' + item + '.',
    dragA11yDroppedReorder: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' near ' + destination + '.',
    dragA11yDroppedNest: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' into ' + destination + '.',
    dragA11yDroppedRoot: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' to ' + destination + '.',
    dragA11yCancelled: ({ item }: { item: string }) => 'Move cancelled for ' + item + '.',
    dragA11yBlocked: ({ item, reason }: { item: string; reason: string }) => 'Could not move ' + item + ': ' + reason,
    dragA11yBlockedDescendantCycle: 'destination is inside the moved folder',
    dragA11yBlockedLeafCannotBeParent: 'sessions cannot contain other items',
    dragA11yBlockedMaxDepth: 'folder depth limit reached',
    dragA11yBlockedSamePosition: 'already in that position',
    dragA11yBlockedWorkspaceScope: 'destination is in another workspace',
    dragA11yBlockedNoTarget: 'no destination selected',
    dragA11yBlockedDirectSession: 'direct sessions cannot be moved to folders',
    dragA11yBlockedFeatureDisabled: 'session folders are not enabled',
    dragA11yBlockedUnsupportedItem: 'this item cannot be moved to folders',
    hideInactiveSessions: 'Скрыть неактивные сессии',
    showInactiveSessions: 'Показать неактивные сессии',
    attentionSectionTitle: 'Требует внимания',
    workingSectionTitle: 'В работе',
        backgroundWorkingSectionTitle: 'Работает в фоне',
    selectionSelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionA11ySelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionCheckboxA11yLabel: 'Select session',
    selectionSelectAction: 'Select',
    selectionSelectAllVisible: 'Select all',
    selectionSelectAllVisibleA11yLabel: 'Выбрать все видимые сессии',
    selectionMoveSheetSourceLabel: ({ count }: { count: number }) => count === 1 ? '1 selected session' : `${count} selected sessions`,
    selectionAddTags: 'Добавить теги',
    selectionRemoveTags: 'Удалить теги',
    selectionSetTags: 'Задать теги',
    selectionAddTagsPromptTitle: 'Добавить теги',
    selectionRemoveTagsPromptTitle: 'Удалить теги',
    selectionSetTagsPromptTitle: 'Задать теги',
    selectionTagsPromptMessage: 'Разделяйте теги запятыми.',
    selectionTagsPlaceholder: 'тег-один, тег-два',
    selectionCancelA11yLabel: 'Отменить выбор сессий',
    selectionProgress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total} complete`,
    selectionCancelRunningA11yLabel: 'Отменить действие для выбранных сессий',
    selectionResult: ({ succeeded, failed, skipped }: { succeeded: number; failed: number; skipped: number }) => `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    selectionDismissResultA11yLabel: 'Скрыть результат действия для выбранных сессий',
    selectionConfirm: ({ action, count }: { action: string; count: number }) => `${action} ${count} selected ${count === 1 ? 'session' : 'sessions'}?`,
    selectionConfirmA11yLabel: ({ action }: { action: string }) => `Confirm ${action}`,

    emptyState: {
      title: "Сессий пока нет",
      description: "Запустите сессию на одной из ваших машин в сети.",
      descriptionPrefix: "Запустите сессию на одной из ваших машин с помощью ",
      descriptionSuffix: " в терминале или с помощью кнопок ниже.",
      actionsTitle: "Запустить сессию",
      startSessionOnMachine: ({ machine }: { machine: string }) => `Запустить сессию на ${machine}`,
      startSessionOnMachineSubtitle: "Выберите папку и откройте новую сессию на этой машине.",
      reconnectMachineActionSubtitle: "Повторно подключите фоновую службу, чтобы эта машина снова могла запускать сессии.",
      startDaemonActionSubtitle: "Установите или перезапустите фоновую службу, необходимую для запуска сессий.",
    },
    openProject: 'Открыть проект',
    workspaceRoot: "Корень рабочей области",
    failedToMoveSessionToFolder: "Не удалось переместить сессию в папку.",
    newFolderDefaultName: "Новая папка",},

  directSessions: {
    browseTitle: "Просмотр внешних сессий",
    browseOpenExisting: "Просмотр внешних сессий",
    browseActionSubtitle: "Выберите машину, агента и сессию, чтобы открыть её здесь.",
    browseFiltersTitle: "Выберите источник",
    browseMachines: "Машины",
    browseAgents: "Агенты",
    browseSources: "Источники",
    browseSourceCodexUserHome: "Мой каталог Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Подключённые сервисы ${service}`,
    browseSourceClaudeDefault: "Стандартная конфигурация Claude",
    browseSourceOpenCodeDefault: "Стандартный сервер OpenCode",
    browseCandidates: "Доступные сессии",
    browseNoMachines: "Для прямых сессий пока нет доступных машин.",
    browseNoCandidates: "Для этой машины и агента внешние сессии не найдены.",
    browseActivityRunning: "Запущена",
        browseActivityRunningNow: "Запущена сейчас",
    browseActivityRecent: "Недавняя",
    browseActivityIdle: "Неактивна",
    browseActivityUnknown: "Неизвестно",
        browseSearchPlaceholder: "Искать сессии…",
        browseNoSearchResults: "Ни одна сессия пока не соответствует этому поиску.",
    browseLoadMore: "Загрузить ещё сессии",
    browseFailedToLoad: "Не удалось загрузить внешние сессии.",
    browseLinkFailed: "Не удалось привязать выбранную внешнюю сессию.",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: 'Основной checkout',
            git_worktree: "Рабочее дерево Git",
        },
    },
    sourceControlWorkspace: {
        createTitle: 'Создать связанное рабочее пространство',
        createSubtitle: 'Добавьте этот checkout в связанное рабочее пространство и откройте его настройки.',
        otherCheckoutsTitle: 'Другие checkouts',
        unlinkedWorktreesTitle: 'Несвязанные worktree',
        createSessionInWorktreeTitle: 'Создать сессию здесь',
        adoptWorktreeTitle: 'Добавить worktree в рабочее пространство',
    },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "Информация о сессии",
	    killSession: "Завершить сессию",
    killSessionConfirm: "Вы уверены, что хотите завершить эту сессию?",
    stopSession: "Остановить сессию",
    stopSessionConfirm: "Вы уверены, что хотите остановить эту сессию?",
    archiveSession: "Архивировать сессию",
    archiveSessionConfirm: "Вы уверены, что хотите архивировать эту сессию?",
    workspaceTitle: "Рабочее пространство",
    workspaceLabel: "Рабочее пространство",
    linkWorkspaceTitle: "Связать это рабочее пространство",
    linkWorkspaceSubtitle: "Создайте связанное рабочее пространство из этого пути сессии и откройте его настройки.",
    openWorkspaceTitle: "Открыть рабочее пространство",
    openWorkspaceSubtitle: "Откройте сведения и настройки связанного рабочего пространства.",
    createWorktreeTitle: "Создать worktree",
    createWorktreeSubtitle: "Запустите новую сессию, которая создаст Git worktree в этом связанном рабочем пространстве.",
    locationLabel: "Расположение",
    checkoutLabel: "Проверить",
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
    kiroSessionId: "ID сессии Kiro",
    kiroSessionIdCopied: "ID сессии Kiro скопирован в буфер обмена",
    customAcpSessionId: "ID пользовательской ACP-сессии",
    customAcpSessionIdCopied: "ID пользовательской ACP-сессии скопирован в буфер обмена",
    piSessionId: "ID сессии Pi",
    piSessionIdCopied: "ID сессии Pi скопирован в буфер обмена",
    copilotSessionId: "ID сессии Copilot",
    copilotSessionIdCopied: "ID сессии Copilot скопирован в буфер обмена",
    cursorSessionId: "ID сессии Cursor",
    cursorSessionIdCopied: "ID сессии Cursor скопирован в буфер обмена",
    metadataCopied: "Метаданные скопированы в буфер обмена",
    failedToCopyMetadata: "Не удалось скопировать метаданные",
    copyDebugInformation: "Копировать информацию",
    debugInformationCopyLabel: "Информация",
    providerSessionLogs: ({ provider }: { provider: string }) => `Журналы сеанса ${provider}`,
    failedToKillSession: "Не удалось завершить сессию",
    failedToStopSession: "Не удалось остановить сессию",
    failedToArchiveSession: "Не удалось архивировать сессию",
    connectionStatus: "Статус подключения",
    created: "Создано",
    lastUpdated: "Последнее обновление",
    sequence: "Последовательность",
    quickActions: "Быстрые действия",
    markSessionRead: "Отметить как прочитанную",
    markSessionReadSubtitle: "Снять непрочитанное внимание с этой сессии",
    markSessionUnread: "Отметить как непрочитанную",
    markSessionUnreadSubtitle: "Оставить эту сессию в списке непрочитанных",
    executionRunsSubtitle: "Посмотреть запуски этой сессии",
    automationsTitle: "Автоматизации",
    automationsSubtitle: "Управляйте запланированными сообщениями для этой сессии",
    viewSessionLogTitle: "Открыть лог сессии",
    viewSessionLogSubtitle: "Открыть хвост лога в реальном времени для этой сессии",
    pinSession: "Закрепить сессию",
    unpinSession: "Открепить сессию",
    copyResumeCommand: "Скопировать команду возобновления",
    resumeCommand: ({ sessionId }: { sessionId: string }) =>
      `happier resume ${sessionId}`,
    viewMachine: "Посмотреть машину",
    viewMachineSubtitle: "Посмотреть детали машины и сессии",
    killSessionSubtitle: "Немедленно завершить сессию",
    stopSessionSubtitle: "Остановить процесс сессии",
    archiveSessionSubtitle: "Переместить эту сессию в Архив",
    archivedSessions: "Архивированные сессии",
    inactiveAndArchivedSessions: "Неактивные и архивированные сессии",
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
    tmuxFallback: "Запасной tmux",
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
      "Пожалуйста, выполните happier self update",
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
    forkSession: "Создать ветку сессии",
    forkSessionSubtitle: "Создать новую сессию из последнего контекста",
    newSessionSameSetup: "Новая сессия с той же настройкой",
    newSessionSameSetupSubtitle: "Повторно использовать машину, папку, движок, модель и параметры этой сессии.",
    failedToRenameSession: "Не удалось переименовать сессию",
    failedToMarkSessionRead: "Не удалось отметить сессию как прочитанную",
    failedToMarkSessionUnread: "Не удалось отметить сессию как непрочитанную",
    sessionRenamed: "Сессия успешно переименована",

	    openInSplitRight: "Открыть в разделении справа",
	    openInSplitDown: "Открыть в разделении снизу",
	    revealInCurrentSplit: "Показать в текущем разделении",},

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "Готовы к программированию?",
      installCli: "Установите Happier CLI",
      runIt: "Запустите его",
      scanQrCode: "Отсканируйте QR-код",
      openCamera: "Открыть камеру",
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
    working: "работаю...",
    workingRetained: "работает, ожидание обновлений…",
        backgroundActive: 'работает в фоне',
        workingExternally: 'Работает во внешнем агенте',
        needsInputExternally: 'Ожидает ввода во внешнем агенте',
        retryingExternally: 'Повторяет попытку во внешнем агенте',
        ready: 'Готово',
        recentlyActive: 'Недавно был активен',
        externalStatusUnknown: 'Внешний статус неизвестен',
    readyForReview: "готово к проверке",
    offline: "не в сети",
    lastSeen: ({ time }: { time: string }) => `в сети ${time}`,
    actionRequired: "требуется действие",
    waitingForYourResponse: "Ожидание вашего ответа",
    permissionRequired: "требуется разрешение",
    activeNow: "Активен сейчас",
    unknown: "неизвестно",
  },

  connectionStatus: {
    title: "Соединение",
    labels: {
      server: "Сервер",
      socket: "Сокет",
      authenticated: "Авторизовано",
      lastSync: "Последняя синхронизация",
      nextRetry: "Следующая попытка",
      lastError: "Последняя ошибка",
    },
  },

  time: {
    justNow: "только что",
    minutesAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "минуту", few: "минуты", many: "минут" })} назад`,
    hoursAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "час", few: "часа", many: "часов" })} назад`,
    nowShort: "сейчас",
    minutesAgoShort: ({ count }: { count: number }) => `${count}м назад`,
    hoursAgoShort: ({ count }: { count: number }) => `${count}ч назад`,
    daysAgoShort: ({ count }: { count: number }) => `${count}д назад`,
  },
  commandMenu: {
    empty: 'Нет результатов',
  },


  selectionList: {
    emptyMatch: "Совпадений нет",
    clearInput: "Очистить",
    backTo: ({ label }: { label: string }) => `Назад к ${label}`,
    dynamicSectionError: "Что-то пошло не так",
    pathNotFound: "Путь не найден",
    backShortcut: "назад",
  },

  session: {
    providerBinding: providerSessionTranslations.ru,
    transcriptNavigation: {
      title: "Навигация",
      modeAll: "Все",
      modePinned: "Закрепленные",
      entryCount: ({ count }: { count: number }) => `${count} записей`,
      pinnedCount: ({ count }: { count: number }) => `${count} закреплено`,
      emptyPinnedTitle: "Нет закрепленных сообщений",
      emptyPinnedBody: "Закрепляйте сообщения, чтобы важные шаги были здесь.",
      emptyAllTitle: "Нет записей навигации",
      emptyAllBody: "Здесь появятся шаги пользователя и закрепленные сообщения.",
      entryA11y: ({ label }: { label: string }) => `Перейти к ${label}`,
      entryPinnedA11y: ({ label }: { label: string }) => `Перейти к закрепленному сообщению: ${label}`,
      fallbackPinnedAssistant: "Закрепленное сообщение ассистента",
      fallbackPinnedTool: "Закрепленное сообщение инструмента",
      fallbackPinnedMessage: "Закрепленное сообщение",
      pinMessageA11y: "Закрепить сообщение",
      unpinMessageA11y: "Открепить сообщение",
      pinToolCallA11y: "Закрепить вызов инструмента",
      unpinToolCallA11y: "Открепить вызов инструмента",
      jumpFailed: "Не удалось перейти к этому сообщению.",
      replyNotLoaded: "Ответ не загружен",
      awaitingReply: "Ожидание ответа",
      loadingBody: "Загрузка навигации по диалогу…",
      emptyPinnedHint: "Наведите курсор на сообщение и выберите значок закрепления, чтобы закрепить его.",
      emptyPinnedPrivacy: "Закрепленные сообщения сохраняются только на этом устройстве.",
    },

    inputPlaceholder: "Введите сообщение...",
    workState: {
      accessibilityLabel: "Рабочее состояние сеанса",
      commandDescription: "Задать или посмотреть цель сеанса",
      unsupportedTitle: "Цель недоступна",
      unsupportedMessage:
        "Этот backend пока не поддерживает редактируемые цели сеанса.",
      notReadyTitle: "Элементы управления целью ещё не готовы",
      notReadyMessage:
        "Этот сеанс ещё запускается. Попробуйте задать цель через мгновение.",
      noCurrentGoalTitle: "Нет цели для обновления",
      noCurrentGoalMessage:
        "Задайте цель, прежде чем приостанавливать или возобновлять ее.",
      dirtyCloseTitle: "Отменить изменения цели?",
      dirtyCloseBody: "Несохраненные изменения цели будут потеряны.",
      emptyPlaceholder: "Здесь пока ничего нет",
      badge: {
        goal: ({ title }: { title: string }) => `Цель: ${title}`,
        goalPaused: "Цель приостановлена",
        goalBlocked: "Цель заблокирована",
        goalBudgetLimited: "Цель ограничена бюджетом",
        goalComplete: "Цель выполнена",
        item: ({ title }: { title: string }) => title,
      },
      group: {
        active: "Активные",
        pending: "Ожидающие",
        blockedPaused: "Заблокированы или приостановлены",
        done: "Выполнены или отменены",
      },
      workflow: {
          sectionTitle: "Активные рабочие процессы",
          goalActive: "Цель активна",
          goalLabel: ({ title }: { title: string }) => `Цель: ${title}`,
          bare: "Рабочий процесс",
          agentsFallback: ({ fraction }: { fraction: string }) => `Рабочий процесс ${fraction} агентов`,
          olderRunsHidden: ({ count }: { count: number }) => `${count} предыдущих запусков скрыто`,
          phaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
          plural: ({ count }: { count: number }) => `${count} рабочих процессов`,
          pluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} рабочих процессов · ${agents} агентов`,
          join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
          permissionBlocked: "Требует проверки",
      },
      goal: {
        title: "Цель",
        placeholder: "На чем должен сосредоточиться этот сеанс?",
        set: "Задать цель",
        pause: "Пауза",
        resume: "Возобновить",
        clear: "Очистить",
        clearTitle: "Очистить цель?",
        clearBody: "Это удалит редактируемую цель из этого сеанса.",
        statusActive: "Активна",
        statusPaused: "Приостановлена",
        statusComplete: "Выполнена",
        statusBudgetLimited: "Ограничена бюджетом",
        statusInterrupted: "Прервано",
        setTitle: "Задайте цель",
        setSubtitle: "Задайте фокус сессии, чтобы агент не отклонялся от цели.",
        addBudget: "+ Добавить лимит бюджета (необязательно)",
        removeBudget: "Убрать бюджет",
        noUsageYet: "Пока нет расхода",
        tokenBudget: "Бюджет токенов",
        tokensSuffix: ({ count }: { count: string }) => `${count} токенов`,
        budgetProgress: ({ used, budget }: { used: string; budget: string }) => `${used} / ${budget}`,
        budgetCaption: ({ budget }: { budget: string }) => `из бюджета ${budget}`,
        budgetPlaceholder: "Лимит токенов",
        invalidBudget: "Введите положительный бюджет токенов.",
        pending: "Установка цели…",
        stillWaiting: "Ожидание подтверждения…",
        accessibilityCurrent: ({ objective }: { objective: string }) => `Текущая цель: ${objective}`,
        errorUnsupportedResponse: "Неподдерживаемый ответ от RPC сеанса",
        errorUnknown: "Неизвестная ошибка",
        errorCannotResume: "Не удалось возобновить сеанс для обновления нативной цели",
      },
    },
    usageLimitRecovery: {
      banner: {
        title: "Достигнут лимит использования",
        body: "Happier может дождаться сброса лимита и автоматически возобновить этот сеанс.",
        waitingTitle: "Ожидание сброса лимита использования",
        waitingBody: "Happier проверит снова, когда провайдер, как ожидается, начнет принимать запросы.",
        readyTitle: "Лимит использования сброшен",
        readyBody: "Теперь можно возобновить этот сеанс.",
        resetCreditSummary: ({ count, expiresAt }: { count: number; expiresAt: string | null }) => {
          const label = count === 1 ? "1 сброс использования" : `${count} сбросов использования`;
          return expiresAt ? `${label} доступен. Ближайший истекает ${expiresAt}.` : `${label} доступен.`;
        },
      },
      actions: {
        enable: "Возобновить после сброса лимита",
        cancel: "Отменить ожидание",
        checkNow: "Проверить лимит сейчас",
        resumeNow: "Возобновить сейчас",
        switchFallbackNow: "Переключиться на резервную учетную запись",
        switchAccountNow: "Переключить учетную запись сейчас",
        consumeResetCredit: "Применить сброс использования",
        retryTemporaryThrottle: "Повторить сейчас",
        remember: "Всегда ждать и возобновлять",
        forget: "Спрашивать каждый раз",
        hideBanner: "Скрыть баннер лимита использования",
        showBanner: "Показать баннер лимита использования",
      },
      status: {
        ready: "Лимит использования",
        resumeReady: "Готово к возобновлению",
        checking: "Проверка лимита",
        waiting: "Ожидание сброса",
        waitingForQuotaReset: "Ожидание сброса квоты",
        accountRotationPending: "Ожидается смена аккаунта",
        temporaryThrottle: "Временное ограничение",
      },
    },
    composerBanners: {
        showBannerAction: 'Показать баннер',
        hideBannerAction: 'Скрыть баннер',
    },
    staleRunner: {
      banner: {
        title: "Раннер сеанса устарел",
        body: "Этот сеанс все еще работает на старой CLI Happier. Перезапустите раннер, чтобы использовать текущий runtime демона.",
        pendingBody: "Перезапускаем раннер сеанса на текущем runtime демона.",
        busyBody: "Раннер сейчас занят. Повторите попытку после завершения текущей работы.",
        failedBody: "Не удалось перезапустить раннер. Сеанс остается доступен на текущем раннере.",
      },
      actions: {
        restart: "Перезапустить раннер",
        restarting: "Перезапуск...",
        hideBanner: "Скрыть баннер устаревшего раннера",
        showBanner: "Показать баннер устаревшего раннера",
      },
      status: {
        stale: "Обновление раннера",
        restarting: "Перезапуск раннера",
        busy: "Раннер занят",
        failed: "Перезапуск не удался",
      },
    },
    rightPanel: {
      tabs: {
        git: "Git",
      },
    },
    toolCalls: "Вызовы инструментов",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} ещё…`,
    forking: {
      dividerTitle: "Ветка из предыдущего контекста",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Ветка из ${parent}`,
      dividerSubtitle: "Предыдущий контекст (только чтение)",
      openParent: "Открыть",
      openParentA11y: "Открыть родительскую сессию",
      forkFromMessageA11y: "Создать ветку от этого сообщения",
	    },
	    transcriptGap: {
	      earlierMessages: "Более ранние сообщения",
	      laterMessages: "Более поздние сообщения",
	    },
	    rollback: {
	      latestTurnA11y: 'Откатить последний ход',
	      beforeUserMessageA11y: 'Откатить к состоянию до этого сообщения',

	      checkpointCode: {
	        title: 'Варианты отката',
	        conversationUnavailable: 'Откат разговора недоступен для этой сессии.',
	        codeOnlyConfirmation: 'Я понимаю, что разговор останется без изменений.',
	        showAdvanced: 'Показать расширенные параметры только для кода',
	        choices: {
	          conversation_only: {
	            title: 'Только разговор',
	            description: 'Откатить транскрипт без изменения файлов.',
	          },
	          conversation_and_code_with_stash: {
	            title: 'Разговор и код, с Git stash',
	            description: 'Создать checkpoint Happier, сохранить изменения в stash и применить обратный patch.',
	          },
	          conversation_and_code_without_stash: {
	            title: 'Разговор и код, без Git stash',
	            description: 'Создать checkpoint Happier и применить обратный patch в этом worktree.',
	          },
	          code_only_with_stash: {
	            title: 'Только код, с Git stash',
	            description: 'Расширенно: оставить разговор без изменений и откатить файлы после stash.',
	          },
	          code_only_without_stash: {
	            title: 'Только код, без Git stash',
	            description: 'Расширенно: оставить разговор без изменений и откатить файлы только с checkpoint Happier.',
	          },
	        },
	      },},
	    resuming: "Возобновление...",
	    resumeFailed: "Не удалось возобновить сессию",
	    pendingQueuedResumeFailedTitle: "Сообщение поставлено в очередь",
	    pendingQueuedResumeFailedBody:
	      "Ваше сообщение сохранено в очереди ожидания, но Happier не смог возобновить эту сессию. Нажмите «Повторить», чтобы запустить её.",
	    invalidLinkTitle: "Недействительная ссылка на сессию",
	    invalidLinkDescription: "Ссылка на сессию отсутствует или недействительна. Проверьте URL и попробуйте снова.",
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
        openRuns: "Открыть запуски сессии",
        openAutomations: "Открыть автоматизации сессии",
        openSubagents: ({ count }: { count: number }) => (count > 0 ? `Открыть агентов (${count})` : 'Открыть агентов'),
        participants: {
          to: 'Кому',
          lead: 'Главный',
          sendToTitle: 'Отправить',
          broadcast: ({ teamId }: { teamId: string }) => `Рассылка: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `Запуск ${runId}`,
          cardTo: ({ label }: { label: string }) => `Кому: ${label}`,
          unsupportedAttachmentsOrReviewComments: 'Отправка получателю пока не поддерживает вложения или комментарии ревью.',
        },
        subagents: {
          messages: {
            teamLabel: ({ teamId }: { teamId: string }) => `Команда: ${teamId}`,
            memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
              `${memberLabel} · ${teamId}`,
            launch: {
              createTeamTitle: "Создать команду",
              createMemberTitle: "Запустить участника команды",
            },
            command: {
              deleteTeamTitle: "Удалить команду",
              deleteMemberTitle: "Отключить участника команды",
            },
          },
                    panel: {
            title: "Агенты",
            active: "Активные",
            recent: "Недавние",
            emptyActive: "Нет активных агентов.",
            emptyRecent: "Пока нет недавних агентов.",
            openFull: "Открыть полное представление",
            openAdvancedRun: "Детали запуска",
            send: "Отправить сообщение",
            delete: "Удалить",
            launchSectionTitle: "Запуск",
            launchSectionSubtitle: "Запускайте новых агентов и выполнения из этой сессии.",
            sectionCount: ({ count }: { count: number }) => `${count}`,
            groupCount: ({ count }: { count: number }) => `${count} агентов`,
            launchExecutionRunsTitle: "Запустить выполнения",
            launchExecutionRunsSubtitle: "Открыть запуск выполнения с шаблонами обзора, плана или делегирования.",
            launchExecutionRunsAdvanced: "Расширенные…",
            launchClaudeTeamsTitle: "Запустить команды Claude",
            launchClaudeTeamsSubtitle: "Создайте команду или запустите участника с помощью структурированных команд Claude для команд.",
            teamIdLabel: "ID команды",
            teamIdPlaceholder: "id-команды",
            teamDescriptionPlaceholder: "За что отвечает эта команда?",
            launchClaudeTeamA11y: "Создать команду Claude",
            launchClaudeTeamAction: "Создать команду",
            teammateTeamIdLabel: "Команда участника",
            teammateLabelPlaceholder: "Метка участника",
            teammateInstructionsPlaceholder: "Что должен делать этот участник?",
            launchTeammateA11y: "Запустить участника",
            launchTeammateAction: "Запустить участника",
            typeFact: ({ value }: { value: string }) => `Тип: ${value}`,
            providerFact: ({ value }: { value: string }) => `Провайдер: ${value}`,
            backendFact: ({ value }: { value: string }) => `Бэкенд: ${value}`,
            intentFact: ({ value }: { value: string }) => `Намерение: ${value}`,
            errors: {
              teamIdRequired: "Сначала введите ID команды.",
              memberTeamIdRequired: "Сначала введите ID команды участника.",
              memberLabelRequired: "Сначала введите метку участника.",
              memberInstructionsRequired: "Сначала введите инструкции для участника.",
            },
          },
          details: {
            unavailable: "Этот транскрипт агента больше недоступен.",
          },
          kind: {
            execution_run: "Запуск выполнения",
            agent_team_member: "Командный агент",
            subagent_sidechain: "Субагент",
          },
          intent: {
            review: "Ревью",
            plan: "План",
            delegate: "Делегирование",
          },
        },
        actionMenu: {
          openA11y: "Открыть действия сессии",

          backgroundFollow: "Фоновое сопровождение",},
      detailsPanel: {
        emptyHint: "Откройте файл или diff на правой панели.",
        unsupportedTab: "Эта вкладка деталей не поддерживается.",
        closeA11y: "Закрыть детали",
          openRightSidebarA11y: "Открыть правую боковую панель",
          closeRightSidebarA11y: "Закрыть правую боковую панель",
          openTabA11y: ({ title }: { title: string }) => `Открыть вкладку ${title}`,
          pinTabA11y: "Закрепить вкладку",
          unpinTabA11y: "Открепить вкладку",
          pinnedTabA11y: "Закрепленная вкладка",
          closeTabA11y: "Закрыть вкладку",
          enterFocusModeA11y: "Включить режим фокуса панели",
          exitFocusModeA11y: "Выключить режим фокуса панели",

        emptyTitle: "Нет открытых вкладок",},

      actionsDraft: {
        noInputHints: "У этого действия нет подсказок ввода.",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `Поле «${field}» обязательно.`,
        },
      },

    planOutput: {
      title: "План",
      recommendedBackend: "Рекомендуемый бэкенд",
      risks: "Риски",
      milestones: "Вехи",
      adoptPlan: "Принять план",
      sending: "Отправка…",
      failedToAdopt: "Не удалось принять план",
      a11y: {
        adoptPlan: "Принять план",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `Замечания ревью (${count})`,
      questionsTitle: "Вопросы от ревьюера",
      assumptionsTitle: "Предположения",
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
        untriaged: "Ожидает решения",
        accept: "Исправить",
        reject: "Игнорировать",
        defer: "Решить позже",
        needsRefinement: "Запросить уточнение",
      },
      refinementPlaceholder: "Что нужно уточнить?",
      actions: {
        applyTriage: "Применить действия по ревью",
        applying: "Применение…",
        askReviewer: "Спросить ревьюера",
        answerQuestion: "Ответить ревьюеру",
        applyAcceptedFindings: "Исправить выбранные замечания",
        sendFollowUp: "Отправить уточнение",
        sending: "Отправка…",
      },
      errors: {
        applyTriageFailed: "Не удалось применить действия по ревью.",
        followUpFailed: "Не удалось отправить уточнение по ревью.",
        applyAcceptedFailed: "Не удалось отправить выбранные исправления.",
      },
    },

        pendingMessages: {
          title: "Отложенные сообщения",
          indicator: ({ count }: { count: number }) => `Ожидает (${count})`,
          badgeLabel: ({ count }: { count: number }) =>
            count > 0 ? `Ожидает (+${count})` : "Ожидает",
          deliveryStatus: {
            blocked: 'Заблокировано',
            delivering: 'Доставляется',
            queuedInClaude: 'В очереди в Claude',
          },
          queuedReasons: {
            waitingForForegroundTurn: 'Ожидание завершения текущего хода',
            waitingForRuntimeActivity: 'Ожидание завершения активности среды',
            runtimeActivityUnknown: 'Ожидание состояния активности среды',
            waitingForPredecessor: 'Ожидание предыдущего сообщения',
            waitingForRuntime: 'Ожидание среды выполнения сеанса',
            unsupportedAction: 'Действие доставки требует проверки',
          },
          deliveryBlockedReasons: {
            terminalComposerDraft: 'Черновик терминала блокирует доставку',
            captureStyleUnavailable: 'Захват терминала не может проверить composer',
            providerUnavailableBeforeAcceptance: 'Провайдер временно недоступен',
            ambiguousTerminalDelivery: 'Состояние доставки неоднозначно',
            terminalHostUnreachable: 'Хост терминала недоступен',
            runtimeDisposedBeforeDelivery: 'Runtime закрылся до доставки',
            runtimeConfigBlocked: 'Конфигурация runtime блокирует доставку',
            invalidPromptText: 'Текст сообщения нельзя доставить',
            manualUserHandled: 'Отмечено как обработанное',
            attemptExpiredBeforeWrite: 'Попытка доставки истекла до записи',
            providerRejectedBeforeAcceptance: 'Провайдер отклонил сообщение',
            payloadTooLarge: 'Сообщение слишком большое',
            unknown: 'Статус доставки требует проверки',
          },
	          empty: "Нет отложенных сообщений.",
	          decryptFailed: "Не удалось расшифровать это отложенное сообщение.",
	          nonSteerableNotice: "Текущий ход не может принять уточнение после этого изменения режима. Сообщение выполнится следующим, либо используйте Отправить сейчас, чтобы прервать.",
	          steerBlockedTerminalDraftNotice: 'Ожидание: черновик в поле ввода терминала блокирует доставку. Очистите его в терминале или прервите ход.',
          clearComposer: {
            action: 'Очистить ввод',
            clearing: 'Очистка…',
            confirmTitle: 'Очистить поле ввода терминала?',
            confirmBody: 'Это удалит неотправленный текст, который сейчас находится в поле ввода терминала.',
            errors: {
              failed: 'Не удалось очистить поле ввода терминала.',
              unsupported: 'Эта сессия не поддерживает очистку поля ввода терминала из Happier.',
              noLiveTerminal: 'Для этой сессии нет доступного активного терминала.',
              generating: 'Claude сейчас генерирует ответ, поэтому поле ввода нельзя безопасно очистить.',
              notSafe: 'В терминале открыт диалог или другое небезопасное состояние. Очистите его в терминале.',
              captureUnavailable: 'Happier не удалось прочитать состояние терминала.',
            },
          },
	          actions: {
          up: "Вверх",
          down: "Вниз",
          edit: "Редактировать",
            viewMore: "Показать ещё",
            viewLess: "Показать меньше",
          steerNow: "Направить сейчас",
          sendNow: "Отправить сейчас",
          sendToAgentNow: "Отправить агенту сейчас",
          sendNowInterrupt: "Отправить сейчас (прервать)",
          retryDelivery: "Повторить",
          interruptAndRunNow: "Прервать и запустить сейчас",
          markHandled: "Отметить обработанным",
          requeue: "Вернуть в очередь",
        },
        editPrompt: {
          title: "Редактировать отложенное сообщение",
        },
        removeConfirm: {
          title: "Удалить отложенное сообщение?",
          body: "Это удалит отложенное сообщение.",
        },
        discardConfirm: {
          title: "Отбросить отложенную доставку?",
          body: "Сообщение останется в transcript как отброшенное и не будет отправлено агенту.",
        },
        steerConfirm: {
          title: "Направить сейчас?",
          body: "Это добавит сообщение в текущий ход без его остановки.",
        },
        sendConfirm: {
          title: "Отправить сейчас?",
          interruptTitle: "Отправить сейчас (прервать)?",
          backgroundTitle: "Отправить агенту сейчас?",
          body: "Это остановит текущий ход и отправит сообщение немедленно.",
          backgroundBody: "Агент получит это сообщение сейчас. Фоновая работа продолжится.",
          resumeBody: "Это возобновит сеанс и немедленно отправит сообщение.",
        },
        markHandledConfirm: {
          title: "Отметить отложенное сообщение обработанным?",
          body: "Это очистит состояние заблокированной доставки без отправки сообщения.",
        },
        discarded: {
          title: "Отброшенные сообщения",
          subtitle:
            "Эти сообщения не были отправлены агенту (например, при переключении с удалённого на локальный режим).",
          label: "Отброшено",
          removeConfirm: {
            title: "Удалить отброшенное сообщение?",
            body: "Это удалит отброшенное сообщение.",
          },
        },
        errors: {
          updateFailed: "Не удалось обновить отложенное сообщение",
          deleteFailed: "Не удалось удалить отложенное сообщение",
          sendFailed: "Не удалось отправить отложенное сообщение",
          restoreFailed: "Не удалось восстановить отброшенное сообщение",
          deleteDiscardedFailed: "Не удалось удалить отброшенное сообщение",
          sendDiscardedFailed: "Не удалось отправить отброшенное сообщение",
          reorderFailed: "Не удалось изменить порядок отложенных сообщений",
          retryDeliveryFailed: "Не удалось повторить отложенную доставку",
          discardFailed: "Не удалось отбросить отложенную доставку",
          markHandledFailed: "Не удалось отметить отложенную доставку обработанной",
        },
      },
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
      stopSharingDescription: "Отзывает прямой доступ этого пользователя.",
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
      permissionApprovalsDisabledInactive:
        "Эта сессия неактивна. Подтверждение разрешений недоступно.",
      permissionApprovalsDisabledNotGranted:
        "Владелец не разрешил вам подтверждать разрешения для этой сессии.",
      publicReadOnlyTitle: "Публичная ссылка (только просмотр)",
      publicReadOnlyBody:
        "Эта сессия опубликована по публичной ссылке. Вы можете просматривать сообщения и вывод инструментов, но не можете взаимодействовать или подтверждать разрешения.",

      publicLink: "Публичная ссылка",
      publicLinkActive: "Публичная ссылка активна",
      publicLinkDescription:
        "Любой, у кого есть эта ссылка, может анонимно просмотреть сессию. Удалите или обновите ссылку, чтобы отозвать доступ у всех.",
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
        shortcutsHelpTitle: 'Сочетания клавиш',
        shortcutsHelpBody: ({ shortcuts }: { shortcuts: string }) => `Активные сочетания:\n${shortcuts}`,
        shortcutsHelpEmpty: 'На этом устройстве нет активных сочетаний.',
        shortcutsHelpCommandPalette: 'Открыть палитру команд',
        shortcutsHelpHelp: 'Открыть сочетания клавиш',
        shortcutsHelpNewSession: 'Новая сессия',
        commands: {
            sessionsCategory: 'Sessions',
            navigationCategory: 'Navigation',
            recentSessionsCategory: 'Recent Sessions',
            runsCategory: 'Runs',
            voiceCategory: 'Voice',
            systemCategory: 'System',
            developerCategory: 'Developer',
            newSessionTitle: 'New Session',
            newSessionSubtitle: 'Start a new chat session',
            viewAllSessionsTitle: 'View All Sessions',
            viewAllSessionsSubtitle: 'Browse your chat history',
            settingsTitle: 'Settings',
            settingsSubtitle: 'Configure your preferences',
            accountTitle: 'Account',
            accountSubtitle: 'Manage your account',
            connectTerminalTitle: 'Scan QR to connect terminal',
            connectTerminalSubtitle: 'Approve the connection shown in your terminal',
            memorySearchTitle: 'Search Memory',
            memorySearchSubtitle: 'Search across past conversations',
            sessionFallbackTitle: ({ id }: { id: string }) => `Session ${id}`,
            sessionFallbackSubtitle: 'Switch to session',
            sessionRequiredTitle: 'Session required',
            sessionRequiredBody: 'Open a session first so this command can target it.',
            startReviewRunTitle: 'Start review run',
            startPlanRunTitle: 'Start plan run',
            startDelegationRunTitle: 'Start delegation run',
            executionRunsSubtitle: 'Execution runs',
            openSessionRunsTitle: 'Open session runs',
            runsForCurrentSessionSubtitle: 'Runs for current session',
            runsAcrossMachinesSubtitle: 'Runs across machines',
            resetVoiceAgentTitle: 'Reset voice agent',
            voiceSubtitle: 'Voice',
            signOutTitle: 'Sign Out',
            signOutSubtitle: 'Sign out of your account',
            developerMenuTitle: 'Developer Menu',
            developerMenuSubtitle: 'Access developer tools',
        },
    pets: {
      category: "Питомцы",
      wakeTitle: "Разбудить питомца",
      wakeSubtitle: "Показать компаньона на этой поверхности.",
      tuckTitle: "Убрать питомца",
      tuckSubtitle: "Скрыть компаньона на этой поверхности.",
      resetPositionTitle: "Сбросить позицию питомца",
      resetPositionSubtitle: "Вернуть компаньона в место по умолчанию.",
      chooseTitle: "Выбрать питомца",
      chooseSubtitle: "Открыть настройки питомцев.",
      refreshCodexTitle: "Обновить питомцев Codex",
      refreshCodexSubtitle: "Открыть настройки и найти локальных питомцев Codex.",
    },
  },

  commandView: {
    completedWithNoOutput: "[Команда завершена без вывода]",
  },

  delegation: {
    output: {
      title: "Делегирование",
      deliverablesTitle: "Результаты",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "Обновить модели",
    loadingModelsA11y: "Загрузка моделей…",
    refreshingModelsA11y: "Обновление моделей…",
    searchPlaceholder: "Поиск моделей…",
    customTitle: "Пользовательский…",
    customInputA11y: "Пользовательский идентификатор модели",
    optionControlA11y: ({ name }: { name: string }) => `Параметр модели: ${name}`,
    effectiveLabel: ({ label }: { label: string }) => `Фактически: ${label}`,
  },

      voiceAssistant: {
        connecting: "Подключение...",
        active: "Голосовой ассистент активен",
        connectionError: "Ошибка соединения",
        label: "Голосовой ассистент",
      tapToEnd: "Нажмите, чтобы завершить",
      startDictation: "Начать диктовку",
      startVoice: "Запустить голос",
      endVoice: "Завершить голос",
      transcribing: "Расшифровка…",
      endDictation: "Завершить диктовку",
    },

        voiceSurface: {
            reviewCredentials: 'Проверить учётные данные',
            connectAgent: 'Подключить',
            installAgentRuntime: 'Установить',
            updateAgentRuntime: 'Обновить',
          start: "Старт",
          stop: "Стоп",
          selectSessionToStart: "Выберите сессию, чтобы запустить голос",
          targetSession: "Целевая сессия",
          conversationalTranscriptUnavailable: "Расшифровка разговора недоступна для этого голосового сеанса",
          noTarget: "Сессия не выбрана",
          clearTarget: "Очистить цель",
          a11y: {
            teleport: "Телепортировать голосового агента",
            toggleActivity: "Переключить голосовую активность",
            clearActivity: "Очистить голосовую активность",
            bargeIn: "Перебить",
            cancelTurn: "Отменить ответ",
            openConversation: "Открыть голосовой разговор",
            microphoneActive: "Микрофон включён",
            microphoneInactive: "Микрофон неактивен",
            microphoneMuted: "Микрофон выключен",
            providerDataDisclosure: ({ provider }: { provider: string }) => `Как ${provider} обрабатывает голосовые данные`,

            mute: "Выключить микрофон",
            unmute: "Включить микрофон",},
        },

      voiceActivity: {
        title: "Голосовая активность",
        empty: "Пока нет голосовой активности.",
        clear: "Очистить",
        format: {
          voiceAgent: "Голосовой агент",
          you: "Вы",
          assistant: "Ассистент",
          assistantStreaming: "Ассистент…",
          action: "Действие",
          error: "Ошибка",
          status: "Статус",
          started: "Запущено",
          stopped: "Остановлено",
          errorFallback: "ошибка",
          eventFallback: "событие",
        },
      },

      devVoiceQa: {
        menuTitle: "Стенд QA для голоса",
        menuSubtitle: "Управляйте реальным голосовым агентом текстовыми запросами",
        title: "Стенд QA для голоса",
        subtitle: "Запустите настроенный голосовой рантайм и отправляйте запросы без микрофона.",
        instructions: "Используйте этот экран, чтобы проверять реального локального голосового агента или сеанс ElevenLabs с детерминированными текстовыми запросами. Оставьте идентификатор сеанса пустым, чтобы использовать текущую голосовую цель или глобальный сеанс голосового агента.",
        configurationTitle: "Конфигурация",
        configuredProvider: "Настроенный провайдер",
        qaProvider: "Активный провайдер QA",
        qaStatus: "Статус QA",
        targetSession: "Текущий целевой сеанс",
        runtimeSession: "Активный сеанс рантайма",
        inputsTitle: "Входные данные",
        sessionIdLabel: "Переопределение ID сеанса",
        sessionIdPlaceholder: "Оставьте пустым, чтобы использовать текущую голосовую цель",
        initialContextLabel: "Начальный контекст",
        initialContextPlaceholder: "Необязательный контекст, отправляемый при запуске QA-сеанса",
        promptLabel: "Запрос",
        promptPlaceholder: "Введите текст, который хотите отправить голосовому агенту",
        contextUpdateLabel: "Обновление контекста",
        contextUpdatePlaceholder: "Необязательное последующее обновление контекста",
        actionsTitle: "Действия",
        sendContext: "Отправить контекст",
        usesCurrentProvider: "Этот стенд всегда использует ваши текущие голосовые настройки и реальные интеграции рантайма.",
        localModeHint: "Для локального QA требуется Local voice с режимом разговора Agent.",
        elevenLabsHint: "Для QA ElevenLabs провайдер ElevenLabs должен быть настроен, а сеанс реального времени должен успешно подключиться.",
        transcriptTitle: "Расшифровка QA",
        transcriptEmpty: "Расшифровка QA пока отсутствует.",
        activityTitle: "Голосовая активность",
        activityEmpty: "Для текущего QA-сеанса пока нет записанной голосовой активности.",

        recordedAudio: {
          title: "QA STT для записанного аудио",
          uriLabel: "URI записанного аудио",
          uriPlaceholder: "file:///recording.wav или выберите веб-файл",
          daemonPackIdLabel: "Переопределение ID пакета STT daemon",
          daemonPackIdPlaceholder: "Необязательно: применить настройки QA STT daemon local_neural перед расшифровкой",
          daemonMachineIdLabel: "Переопределение ID машины daemon",
          daemonMachineIdPlaceholder: "Необязательно: подготовить машинную цель для ID сеанса записанного аудио",
          daemonBasePathLabel: "Переопределение базового пути daemon",
          daemonBasePathPlaceholder: "Необязательно: подготовить базовый путь машины для STT daemon",
          chooseFile: "Выбрать записанное аудио",
          noFileSelected: "Записанное аудио не выбрано",
          transcribe: "Расшифровать записанное аудио",
          statusLabel: "Статус",
          noResult: "Нет результата расшифровки",
        },},

    agentInput: {
      stopCodingTurn: "Остановить ход программирования",
        nonSteerableSend: {
            title: 'Агент занят',
            modeChangeMessage: 'Изменение режима разрешений нельзя применить к выполняющемуся ходу.',
            providerConfigMessage: 'Изменение этой настройки провайдера нельзя применить к выполняющемуся ходу.',
            specialCommandMessage: 'Эту команду нельзя выполнить во время активного хода.',
            interruptAndSend: 'Прервать и отправить сейчас',
            applySettingAndSteer: 'Применить настройку и направить сейчас',
            applyNamedSettingAndSteer: ({ setting, value }: { setting: string; value: string }) => `Применить ${setting} → ${value} и направить сейчас`,
            steerWithoutApplying: 'Направить сейчас без применения (применится со следующим сообщением)',
            queueForAfterTurn: 'В очередь после хода',
        },
      dropToAttach: "Перетащите, чтобы прикрепить файлы",
      providerUsage: {
        title: "Использование провайдера",
        accessibilityLabel: ({ value }: { value: string }) =>
          `Использование провайдера: осталось ${value}`,
        remaining: ({ percent }: { percent: string }) => `осталось ${percent}`,
        remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) =>
          `осталось ${percent} · сброс через ${reset}`,
        usedCount: ({ used, limit }: { used: string; limit: string }) =>
          `${used}/${limit} использовано`,
        duration: {
          now: "сейчас",
          outdated: 'Неактуально',
          daysHours: ({ days, hours }: { days: number; hours: number }) =>
            `${days}д ${hours}ч`,
          hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
            `${hours}ч ${minutes}м`,
          hours: ({ hours }: { hours: number }) => `${hours}ч`,
          minutes: ({ minutes }: { minutes: number }) => `${minutes}м`,
        },
      },
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
      effectiveLabel: ({ label }: { label: string }) => `Эффективно: ${label}`,
      default: "По умолчанию",
      readOnly: "Только чтение",
      acceptEdits: "Принимать правки",
      safeYolo: "Авто",
      yolo: "YOLO",
      plan: "Режим планирования",
      bypassPermissions: "YOLO режим",
      badgeAccept: "Принять",
      badgePlan: "План",
      badgeReadOnly: "Только чтение",
      badgeSafeYolo: "Авто",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Принимать все правки",
      badgeBypassAllPermissions: "Обход всех разрешений",
      badgePlanMode: "Режим планирования",
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
      customAcp: "Пользовательский АКП",
      pi: "Pi",
      copilot: "Copilot",

      ohMyPi: "oh-my-pi",},
    auggieIndexingChip: {
      on: "Индексация включена",
      off: "Индексация выключена",
    },
      model: {
        title: "МОДЕЛЬ",
        useCliSettings: "Использовать настройки CLI",
        running: ({ model }: { model: string }) => `Запущена: ${model}`,
        lastUsed: ({ model }: { model: string }) => `Последняя использованная: ${model}`,
        lastReported: ({ model }: { model: string }) => `Последняя сообщённая: ${model}`,
        selectedForResume: "Выбранная модель будет использоваться после возобновления этой сессии.",
        configureInCli: "Настройте модели в настройках CLI",
        unavailable: "Обнаружение моделей недоступно для этого провайдера на этой машине.",
        customDescription: "Использовать ID модели, которого нет в списке.",
        customPromptBody: "Введите ID модели",
        customPlaceholder: "например: claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "РЕЖИМ РАЗРЕШЕНИЙ",
      default: "Настройки CLI",
      plan: "Режим планирования",
      readOnly: "Только чтение",
      safeYolo: "Авто",
      yolo: "YOLO",
      badgePlan: "План",
      badgeReadOnly: "Только чтение",
      badgeSafeYolo: "Авто",
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
      windowTitle: "Окно контекста",
      usedDetail: ({
        percent,
        used,
        total,
      }: {
        percent: string;
        used: string;
        total: string;
      }) => `${percent} • использовано ${used}/${total} контекста`,
      description: "Автоматически уплотняет контекст, когда это необходимо.",
    },
    suggestion: {
      fileLabel: "ФАЙЛ",
      folderLabel: "ПАПКА",
    },
    mode: {
      sectionTitle: "Режим",
      badge: ({ name }: { name: string }) => `Режим: ${name}`,
      badgePending: ({ name }: { name: string }) => `Режим: ${name} (ожидает)`,
      refreshModesA11y: "Обновить режимы",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Ожидает: переключение с ${from} на ${to}`,
      currentMode: ({ name }: { name: string }) => `Текущий: ${name}`,
      loadingModes: "Загрузка режимов…",
      refreshingModes: "Обновление режимов…",
      useDefaultModeHint: "Использовать режим по умолчанию для этого агента.",
      startIn: ({ name }: { name: string }) => `Запуск в: ${name}`,
      build: "Создание",
      buildDescription: "Поведение по умолчанию",
      plan: "План",
      planDescription: "Сначала подумать",
    },
    acp: {
      modeSectionTitle: "Режим",
      refreshModesA11y: "Обновить режимы",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Ожидает: переключение с ${from} на ${to}`,
      currentMode: ({ name }: { name: string }) => `Текущий: ${name}`,
      loadingModes: "Загрузка режимов…",
      refreshingModes: "Обновление режимов…",
      useDefaultModeHint: "Использовать режим по умолчанию для этого агента.",
      startIn: ({ name }: { name: string }) => `Запуск в: ${name}`,
      optionsSectionTitle: "Параметры",
      optionsUnavailable: "Параметры конфигурации недоступны для этого провайдера на этой машине.",
      currentValue: ({ value }: { value: string }) => `Текущий: ${value}`,
      optionOverriddenBy: ({ name }: { name: string }) => `Переопределено: ${name}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `Ожидает: ${current} → ${requested}`,
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
    showFullContent: "Показать полностью",
    showLessContent: "Показать меньше",
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} ещё`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}с`,
      unknownToolTitle: "Инструмент",
    },
    bashView: {
      commandDiffTitle: "Сырая команда",
      commandDiffHint:
        "Предпросмотр команды скрывает короткий префикс очистки окружения, чтобы его было легче читать. Полная сырая команда показана ниже.",
    },
    webFetch: {
      httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
    },
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
    agentTeamView: {
      team: "Команда",
      member: "Участник",
      type: "Тип",
      content: "Содержимое",
      status: "Статус",
      description: "Описание",
    },
    workflowView: {
      title: "Заголовок",
      description: "Описание",
      status: "Статус",
      summary: "Сводка",
      run: "Запуск",
      task: "Задача",
      toolUse: "Использование инструмента",
    },
    workflowActivityView: {
        untitled: "Рабочий процесс",
        loading: "Загрузка…",
        unavailable: "Сведения недоступны",
        noDetail: "Больше нет сведений",
        statusActive: "Выполняется",
        statusComplete: "Завершено",
      statusFailed: "Ошибка",
      statusStopped: "Остановлено",
      statusInterrupted: "Прервано",
      statusBlocked: "Заблокировано",
        statusCancelled: "Отменено",
        statusUnknown: "Неизвестно",
        phaseUntitled: "Этап",
        phaseActivity: "Активность",
        phaseComplete: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} завершено`,
        phaseActive: ({ count }: { count: number }) => `${count} активно`,
        phaseFailed: ({ count }: { count: number }) => `${count} с ошибкой`,
        phaseBlocked: ({ count }: { count: number }) => `${count} заблокировано`,
        phasePending: ({ count }: { count: number }) => `${count} в ожидании`,
        phaseSummary: ({ index, total, complete, agents }: { index: number; total: number; complete: number; agents: number }) => `Этап ${index} из ${total} · ${complete}/${agents} агентов`,
        agentFraction: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} агентов`,
        agentsCount: ({ count }: { count: number }) => `${count} агентов`,
        tokens: ({ tokens }: { tokens: string }) => `${tokens} токенов`,
        toolCalls: ({ count }: { count: number }) => `${count} инструментов`,
        showMore: ({ count }: { count: number }) => `Показать ${count}`,
        detailShowMore: 'Показать больше',
        detailShowLess: 'Показать меньше',
    },
    subAgentRunView: {
      planTitle: "План",
      delegateTitle: "Делегирование",
      reviewDigestTitle: "Сводка ревью",
    },
    changeTitleView: {
      titleLabel: "Заголовок",
    },
    enterPlanMode: {
      title: "Включен режим планирования",
      body:
        "Теперь агент сначала будет предлагать структурированный план перед тем, как выполнять действия. Когда будете готовы, вы можете выйти из режима планирования или запросить изменения.",
    },
    structuredResult: {
      exit: "Код выхода",
      stdout: "Стандартный вывод",
      stderr: "Стандартная ошибка",
      diff: "Различия",
      result: "Результат",
      items: "Элементы",
      more: ({ count }: { count: number }) => `+${count} ещё`,
    },
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `Создать субагента: ${subject}`,
      createTask: "Создать субагента",
      listTasks: "Показать субагентов",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `Обновить субагента ${id} → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `Обновить субагента ${id}`,
      updateTask: "Обновить субагента",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `+${count} ещё инструментов`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "Индексация рабочего пространства",
      description:
        "Индексация помогает агенту быстрее искать по вашему коду и давать более точные ответы. Она может просканировать файлы в рабочем пространстве.",
      optionFallback: "Вариант",
      chooseOptionHint: "Выберите вариант ниже, чтобы продолжить.",
    },
    acpHistoryImport: {
      title: "Импортировать историю сессии?",
      defaultNote:
        "Эта история сессии отличается от того, что уже есть в Happier. Импорт может создать дубликаты.",
      counts: {
        local: ({ count }: { count: number }) => `Локально: ${count}`,
        remote: ({ count }: { count: number }) => `Удалённо: ${count}`,
      },
      preview: {
        localTail: "Локально (хвост)",
        remoteTail: "Удалённо (хвост)",
        unknownRole: "неизвестно",
      },
      actions: {
        import: "Импортировать",
        skip: "Пропустить",
      },
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Правка ${index} из ${total}`,
      replaceAll: "Заменить все",
      summaryEdits: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "правка", few: "правки", many: "правок" })}`,
    },
    names: {
      task: "Задача",
      subAgent: "Субагент",
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
      viewDiff: "Изменения в файле",
      turnDiff: "Изменения за ход",
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
      turnDiffRecap: "Сводка изменений за этот ход",
    },
    askUserQuestion: {
      claudeDialogNotice: {
        header: 'Диалог Claude',
        question: 'Claude показывает диалог. Откройте терминал, чтобы проверить его и выбрать, как продолжить.',
        openTerminal: 'Открыть терминал',
        description: 'Проверьте диалог и ответьте на него в терминале Claude.',
      },
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
      planMissing:
        "Текст плана не был предоставлен. Посмотрите план в сообщении выше или попросите агента включить его в запрос на одобрение.",
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
    clearSearchA11y: "Очистить поиск",
    createFileA11y: "Создать файл",
    createFolderA11y: "Создать папку",
    createFilePromptTitle: "Создать файл",
    createFilePromptBody: "Введите путь относительно корня проекта.",
    createFileInvalidPath:
      "Недопустимый путь файла. Используйте путь относительно workspace, например src/new-file.ts.",
    createFileFailed: "Не удалось создать файл.",
	    createFolderPromptTitle: "Создать папку",
	    createFolderPromptBody: "Введите путь папки относительно корня проекта.",
	    createFolderInvalidPath:
	      "Недопустимый путь папки. Используйте путь относительно workspace, например src/new-folder.",
	    createFolderFailed: "Не удалось создать папку.",
	    repositoryTree: {
	      actions: {
	        copyPath: "Копировать путь",
	        download: "Скачать",
	        downloadAsZip: "Скачать как ZIP",
	      },
	      dropToUpload: "Перетащите файлы для загрузки",
	      rename: {
	        title: "Переименовать",
	        body: "Введите новый путь относительно корня проекта.",
	        invalidPath:
	          "Недопустимый путь. Используйте путь относительно workspace, например src/new-file.ts.",
	        failed: "Не удалось переименовать.",
	        conflicts: {
	          title: "Цель уже существует",
	          body: ({ path }: { path: string }) => `«${path}» уже существует. Что вы хотите сделать?`,
	        },
	      },
	      deleteFolder: {
	        title: "Удалить папку?",
	        body: ({ path }: { path: string }) =>
	          `Удалить папку ${path} и всё её содержимое?`,
	        confirm: "Удалить папку",
	      },
	      deleteFile: {
	        title: "Удалить файл?",
	        body: ({ path }: { path: string }) => `Удалить файл ${path}?`,
	      },
	      delete: {
	        failed: "Не удалось удалить.",
	      },
	      download: {
	        notReady: "Скачивание пока недоступно.",
	      },
	    },
	    changeRow: {
	      viewDiffA11y: ({ file }: { file: string }) => `Показать diff для ${file}`,
	      status: {
	        untracked: "Неотслеживаемый файл",
        added: "Новый файл",
        deleted: "Удалённый файл",
        renamed: "Переименованный файл",
        copied: "Скопированный файл",
        conflicted: "Файл с конфликтом",
        modified: "Изменённый файл",
      },
    },
    projectLinkPicker: {
      title: "Привязать файл проекта",
      searchFailed: "Поиск не удался. Попробуйте ещё раз.",
    },
    detachedHead: "отделённый HEAD",
    branchSwitchDialog: {
      title: "Переключить ветку",
      body: "У вас есть незакоммиченные изменения. Как вы хотите поступить?",
      leaveTitle: ({ branch }: { branch: string }) => `Оставить мои изменения на ${branch}`,
      leaveSubtitle: "Создать stash на текущей ветке и переключиться.",
      bringTitle: ({ branch }: { branch: string }) => `Перенести мои изменения на ${branch}`,
      bringSubtitle: "Попробовать переключиться и сохранить изменения на новой ветке.",
    },
    branchMenu: {
      openA11y: "Открыть меню веток",
      failedToLoad: "Не удалось загрузить ветки.",
      unavailable: "Список веток недоступен",
      empty: "Ветки не найдены",
      searchPlaceholder: "Поиск веток...",
      category: {
        actions: "Действия",
        branches: "Ветки",
        worktrees: "Рабочие деревья",
        remote: "Удалённые",
        local: "Локальные",
        options: "Параметры",
      },
      publish: {
        title: "Опубликовать ветку",
        subtitle: "Запушить текущую ветку в upstream-ветку на удалённом репозитории",
        short: "Опубликовать",
        failed: "Не удалось опубликовать ветку.",
      },
      create: {
        title: "Создать ветку",
        subtitle: ({ name }: { name: string }) => `Создать "${name}"`,
        failed: "Не удалось создать ветку.",
      },
      switch: {
        failed: "Не удалось переключить ветку.",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `Upstream: ${upstream}`,
      },
      remotes: {
        show: "Показать удалённые ветки",
        hide: "Скрыть удалённые ветки",
        subtitle: "Включать удалённые ветки в список",
      },
      worktrees: {
        createFromCurrentBranchTitle: "Новое рабочее дерево из текущей ветки",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) => `Create a new worktree from ${branch} and start a session there.`,
        createFromCurrentBranchDetachedSubtitle: "Переключитесь на ветку перед созданием рабочего дерева из текущей ветки.",
        createFromAnotherBranchTitle: "Новое рабочее дерево из другой ветки",
        createFromAnotherBranchSubtitle: "Откройте поток нового сеанса, чтобы выбрать другую ветвь или повторно использовать существующее рабочее дерево.",
        removeTitle: "Удалить рабочее дерево",
        removeSubtitle: ({ target }: { target: string }) => `Remove ${target} from this repository.`,
        removeConfirmTitle: "Удалить рабочее дерево?",
        removeConfirmBody: ({ path }: { path: string }) => `Remove the worktree at ${path}? This cannot be undone.`,
        removeConfirmButton: "Удалить рабочее дерево",
        pruneTitle: "Обрезайте залежавшиеся рабочие деревья",
        pruneSubtitle: "Очистите устаревшие метаданные рабочего дерева для этого репозитория.",
        createFailed: "Не удалось создать рабочее дерево.",
        removeFailed: "Не удалось удалить рабочее дерево.",
        pruneFailed: "Не удалось обрезать рабочие деревья.",
      },
      pullRequests: {
        checkoutLocalTitle: "Получить pull request",
        checkoutLocalSubtitle: "Вставьте URL PR или merge request, номер либо команду checkout.",
        openWorktreeTitle: "Открыть pull request в рабочем дереве",
        openWorktreeSubtitle: "Подготовить pull request в отдельном рабочем дереве и запустить там сессию.",
        promptTitle: "Ссылка на pull request",
        promptBody: "Вставьте URL pull request или merge request, номер либо команду checkout.",
        promptPlaceholder: "https://github.com/owner/repo/pull/123",
        invalidReferenceBody: "Введите корректную ссылку на pull request или merge request.",
        checkoutFailed: "Не удалось получить pull request.",
        worktreeFailed: "Не удалось подготовить рабочее дерево pull request.",
      },
      indexLock: {
        title: "Удалить устаревшую блокировку Git?",
        body: "Git сообщил о блокировке индекса. Если другая команда Git не выполняется, Happier может удалить устаревшую блокировку и повторить попытку.",
        confirm: "Удалить блокировку и повторить",
        recoveryFailed: "Не удалось удалить блокировку индекса Git.",
      },
      stashOverwrite: {
        title: "Перезаписать stash для ветки?",
        body: ({ branch }: { branch: string }) =>
          `Stash для ${branch} уже существует. Перезаписать его?`,
        confirm: "Перезаписать stash",
      },
    },
    stash: {
      summaryA11y: "Открыть детали stash",
      summaryTitle: "Управляемые stash-и",
      detailsTitle: "Управляемые stash-и",
      empty: "Нет управляемых stash-ей.",
      failedToLoad: "Не удалось загрузить stash-и.",
      failedToLoadDiff: "Не удалось загрузить diff stash-а.",
      diffTruncated: "Diff обрезан (лимит вывода).",
      writeDisabled: "Операции записи в контроле версий отключены.",
      noSelection: "Выберите stash, чтобы продолжить.",
      selectA11y: ({ stash }: { stash: string }) => `Выбрать stash ${stash}`,
      restore: "Восстановить",
      discard: "Удалить",
      restoreFailed: "Не удалось восстановить stash.",
      discardFailed: "Не удалось удалить stash.",
      restoreConfirm: {
        title: "Восстановить изменения из stash-а?",
        body: "Применит сохранённые изменения к рабочему дереву. Конфликты могут потребовать ручного разрешения.",
        confirm: "Восстановить",
      },
      discardConfirm: {
        title: "Удалить изменения из stash-а?",
        body: "Это навсегда удалит этот stash.",
        confirm: "Удалить",
      },
    },
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} подготовлено • ${unstaged} не подготовлено`,
    branchSummary: {
      ahead: "Впереди",
      behind: "Позади",
      included: "Включено",
      staged: "Подготовлено",
      pending: "Ожидает",
      unstaged: "Не подготовлено",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "Нет upstream",
    },
    stageActions: {
      selectPendingDiffMode:
        "Выберите режим diff «Ожидает», чтобы выбрать строки для коммита.",
      unableToBuildPatchFromSelection:
        "Не удалось собрать патч из выбранных строк.",
      diffChangedRefreshAndReselect:
        "Diff изменился — обновите и выберите строки заново.",
    },
    discardChangesFor: ({ path }: { path: string }) => `Отменить изменения для ${path}`,
    commitSelection: {
      addToCommit: "Добавить в коммит",
      removeFromCommit: "Убрать из коммита",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "файл", few: "файла", many: "файлов" })}`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `Изменённые файлы репозитория (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Изменения, привязанные к сессии (${count})`,
    latestTurnChanges: ({ count }: { count: number }) =>
      `Изменения последнего хода (${count})`,
    agentReportedTurnChanges: ({ count }: { count: number }) =>
      `Изменения, о которых сообщил агент (${count})`,
    checkpointTurnChanges: ({ count }: { count: number }) =>
      `Изменения контрольной точки (${count})`,
    selectedForCommitChanges: ({ count }: { count: number }) =>
      `Выбрано для коммита (${count})`,
    latestTurnDescription:
      'Изменения от провайдера из последнего завершённого хода.',
    agentReportedTurnDescription:
      'Изменения, явно указанные агентом для текущего хода.',
    checkpointUnavailable:
      'Содержимое контрольной точки недоступно для этого хода.',
    checkpointAttributionShared:
      'Атрибуция контрольной точки разделена с другой активностью worktree.',
    checkpointAttributionUnknown:
      'Не удалось определить атрибуцию контрольной точки.',
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Прочие изменения репозитория (${count})`,
    attributionReliabilityHigh:
      "Наилучшая атрибуция. Представление репозитория остаётся источником истины.",
    attributionReliabilityLimited:
      "Надёжность ограничена: несколько сессий активны для этого репозитория. Показана только прямая атрибуция.",
    attributionLegendFull:
      "прямая = из операций этой сессии, выведенная = атрибуция на основе снимков",
    attributionLegendDirectOnly: "прямая = из операций этой сессии",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "выведенный файл оставлен", few: "выведенных файла оставлены", many: "выведенных файлов оставлены" })} в изменениях только репозитория.`,
    noSessionAttributedChanges:
      "Изменения, привязанные к сессии, не обнаружены.",
    noLatestTurnChanges:
      "Изменения последнего хода пока не обнаружены.",
    notRepo: "Не является репозиторием системы контроля версий",
    notUnderSourceControl: "Эта папка не находится под управлением системы контроля версий",
    repositoryInit: {
      initialize: "Инициализировать репозиторий",
      initializing: "Инициализация…",
      confirmTitle: "Инициализировать репозиторий?",
      confirmBody: "Создает Git-репозиторий в этой папке. Существующие файлы не будут добавлены в индекс или закоммичены.",
      errors: {
        failed: "Не удалось инициализировать репозиторий.",
      },
    },
    searching: "Поиск файлов...",
      noFilesFound: "Файлы не найдены",
      noFilesInProject: "Файлов в проекте нет",
      repositoryFolderLoadFailed: "Не удалось загрузить папку",
      repositoryCollapseAll: "Свернуть все",
    sourceControlOperationsLog: {
      title: "Недавние операции контроля версий",
      allSessions: "Все сессии",
      thisSession: "Эта сессия",
      emptyThisSession: "Нет недавних операций для этой сессии.",
    },
    operationsHistory: {
      recentCommits: "Недавние коммиты",
      noCommitsAvailable: "Коммиты недоступны.",
      loadMore: "Загрузить ещё коммиты",
    },
      reviewFilterPlaceholder: "Фильтр файлов...",
      reviewNoMatches: "Нет совпадений",
      reviewLargeDiffOneAtATime: "Обнаружен большой diff; изменения будут подгружаться при прокрутке.",
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
	      fileReadFailed: "Не удалось прочитать файл",
	      fileTooLargeToPreview: "Файл слишком большой для предварительного просмотра",
	      fileWriteFailed: "Не удалось записать файл",
	      fileEditor: {
	        experimentalHint:
	          "Редактирование экспериментально. Сохраните, чтобы записать изменения обратно в worktree сессии.",
	        frontmatterReadOnly: "Frontmatter (только для чтения)",
      },
      fileEditingUnsupported:
        "Редактирование файлов не поддерживается подключённым демоном. Обновите Happier на машине, чтобы включить операции записи.",
      fileChangedExternally:
        "Этот файл изменился на диске, пока вы его редактировали. Черновик оставлен без изменений; проверьте последнюю версию файла перед сохранением.",
      selectionFailed: "Не удалось обновить выбор",
      openReviewCommentsFailed: "Не удалось открыть комментарии к ревью",
        reviewComments: {
          title: ({ count }: { count: number }) => `Комментарии ревью (${count})`,
          placeholder: "Добавьте комментарий к ревью…",
          jump: "Перейти",
          addCommentA11y: "Добавить комментарий",
          closeCommentA11y: "Закрыть комментарий",
          draftsChipLabel: ({ count }: { count: number }) => `Ревью (${count})`,
          modalSubtitle: "Проверьте, какие комментарии будут отправлены со следующим сообщением.",
          modalSummary: ({ included, count }: { included: number; count: number }) =>
            `${included} из ${count} выбрано для следующего промпта`,
          detachOrDiscardTitle: "Убрать комментарии ревью?",
          detachOrDiscardBody:
            "Открепление сохранит комментарии, но исключит их из следующего промпта. Удаление удалит их полностью.",
          detachFromPrompt: "Открепить от промпта",
          durable: {
            headerTitle: "Комментарии ревью",
            count: ({ count }: { count: number }) => `${count}`,
            empty: "Комментариев ревью пока нет",
            engine: "Движок",
            stale: "Устарело",
            outdated: "Неактуально",
            binarySnapshot: "Бинарный снимок",
            minified: "Вероятно минифицировано",
            submoduleSnapshot: "Снимок подмодуля",
            symlinkSnapshot: "Снимок символьной ссылки",
            textSnapshot: "Текстовый снимок",
            tooLargeSnapshot: "Снимок слишком большой",
            encryptedSnapshot: "Зашифрованный снимок",
            truncated: "Обрезано",
            bidiControls: "Bidi-символы",
            redacted: "Отредактировано",
            contentUnavailable: "Содержимое недоступно",
            edit: "Редактировать",
            resolve: "Решить",
            dismiss: "Отклонить",
            reopen: "Открыть снова",
            redact: "Скрыть",
            reply: "Ответить",
            replyUnavailable: "Ответ недоступен",
            bulkResolve: "Решить видимые",
            bulkDismiss: "Отклонить видимые",
            bulkPartialFailure: "Некоторые комментарии не обновлены",
            bulkFailure: ({ commentId, errorCode }: { commentId: string; errorCode: string }) => `${commentId}: ${errorCode}`,
            filtersTitle: "Фильтры",
            showActive: "Активные",
            showHistory: "История",
            refresh: "Обновить",
            loadFailed: "Не удалось загрузить комментарии ревью",
            transitionReason: "Обновлено из панели комментариев ревью.",
            bulkTransitionReason: "Массовое обновление из панели комментариев ревью.",
            editPromptTitle: "Редактировать комментарий ревью",
            editPromptBody: "Обновите текст сохранённого комментария.",
            replyPromptTitle: "Ответить на комментарий ревью",
            replyPromptBody: "Добавьте ответ в устойчивую ветку комментариев.",
            states: {
              proposed: "Предложено",
              open: "Открыто",
              delegated: "Делегировано",
              pendingReview: "Ожидает ревью",
              resolved: "Решено",
              dismissed: "Отклонено",
            },
            directWriteGrant: {
              title: "Прямая запись комментариев ревью",
              body: ({ pluginId }: { pluginId: string }) => `${pluginId} запрашивает разрешение напрямую записывать комментарии ревью.`,
              grant: "Разрешить прямую запись",
              cancel: "Не сейчас",
              revoke: "Отозвать",
            },
          },
          errors: {
            empty: "Комментарий не может быть пустым",
            couldNotMapSelection: "Не удалось сопоставить выделение со строкой diff",
          },
        },
        commitDetails: {
          missingContext: "Не хватает контекста коммита",
          failedToLoadDiff: "Не удалось загрузить diff коммита",
          diffUnavailableTitle: "Diff коммита недоступен",
          diffUnavailableHint:
            "Попробуйте открыть коммит снова на экране «Файлы».",
          commitLabel: "Коммит",
          running: ({ operation }: { operation: string }) =>
            `Выполняется: ${operation}`,
          revert: {
            title: "Откатить коммит",
            button: "Откатить коммит",
            confirm: "Откатить",
            success: "Коммит успешно откатан",
            failed: "Не удалось откатить коммит",
          },
        },
        commitRevertUnavailable: "Откат недоступен для этого коммита.",
	        commitMessageEditor: {
	          placeholder: "Сообщение коммита",
	          generate: "Сгенерировать",
	          generating: "Генерация…",
	          applySuggestion: "Применить предложение",
	          suggestionReady: "Готова подсказка. Применить?",
	          commit: "Сделать коммит",
	          generateFailed: "Не удалось сгенерировать сообщение коммита",
	          generatorDisabled: "Генератор сообщений коммита отключён",
	        },
      commitAdjacentPush: {
        accessibilityLabel: ({ target }: { target: string }) => `Push в ${target}`,
        confirm: {
          title: "Отправить локальные коммиты?",
          body: ({ target }: { target: string }) =>
            `Отправить локальные коммиты в ${target}.`,
          push: "Да",
          notNow: "Нет",
          pushAndDontAskAgain: "Push и больше не спрашивать",
        },
      },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Загрузка ${fileName}...`,
        binaryFile: "Бинарный файл",
        imagePreviewTooLarge: "Предпросмотр изображения слишком большой для отображения",
        sessionMedia: {
          generatedImageA11y: ({ name }: { name: string }) => `Открыть сгенерированное изображение ${name}`,
          attachmentImageA11y: ({ name }: { name: string }) => `Открыть прикрепленное изображение ${name}`,
          toolArtifactImageA11y: ({ name }: { name: string }) => `Открыть изображение артефакта инструмента ${name}`,
          generatedVideoA11y: ({ name }: { name: string }) => `Открыть сгенерированное видео ${name}`,
          attachmentVideoA11y: ({ name }: { name: string }) => `Открыть прикрепленное видео ${name}`,
          toolArtifactVideoA11y: ({ name }: { name: string }) => `Открыть видео артефакта инструмента ${name}`,

          previewUnavailableA11y: "Media preview unavailable",
          unavailableImageA11y: ({ name }: { name: string }) => `${name} unavailable`,},
        cannotDisplayBinary: "Невозможно отобразить содержимое бинарного файла",
        diff: "Различия",
      file: "Файл",
      markdown: "Markdown",
    diffModes: {
      pending: "Ожидает",
      included: "Включено",
      combined: "Объединено",
    },
    fileActions: {
      selectForCommit: "Выбрать для коммита",
      selectFilesToCommit: "Выбрать файлы для коммита",
      stageFile: "Добавить в stage",
      removeFromSelection: "Убрать из выбора",
      removeFromCommitSelection: "Убрать из выбора для коммита",
      unstageFile: "Убрать из stage",
      selectionHint:
        "Выберите «Включено» или «Ожидает», чтобы включить выбор строк.",
      selectedLines: {
        selectLinesForCommit: "Выбрать строки для коммита",
        stageSelectedLines: "Добавить выбранные строки в stage",
        unstageSelectedLines: "Убрать выбранные строки из stage",
      },
      clearSelection: "Очистить выбор",

      rangeSelection: "Range selection",
      selectEntireFileForCommit: "Select entire file for commit",},
	    toolbar: {
	      changedFiles: "Изменённые файлы",
	      hiddenFiles: "Показать скрытые файлы",
	      details: "Подробности",
	      upload: "Загрузить",
	      uploadFiles: "Загрузить файлы",
	      uploadFolder: "Загрузить папку",
      allRepositoryFiles: "Все файлы репозитория",
      repositoryView: "Вид репозитория",
      selectedForCommitView: "Выбрано для коммита",
      turnView: "Вид хода",
      sessionView: "Вид сессии",
      view: "Вид",
      review: "Ревью",
      list: "Список",
      scm: "Git",

	      agentReportedTurnView: "Ход по отчёту агента",
	      checkpointTurnView: "Ход checkpoint",},
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `Подготовка загрузки (${count} файлов)…`,
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
      }) => `Загрузка ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `Скачивание ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "Конфликты загрузки",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount} из ${totalCount} файлов уже существуют. Что сделать?`,
        keepBoth: {
          title: "Сохранить оба",
          subtitle:
            "Добавить « (1)», « (2)», … к конфликтующим именам.",
        },
        replace: {
          title: "Заменить",
          subtitle: "Перезаписать существующие файлы.",
        },
        skip: {
          title: "Пропустить",
          subtitle: "Загружать только файлы, которых ещё нет.",
        },
      },
    },
    fileEmpty: "Файл пустой",
    noChanges: "Нет изменений для отображения",
    sourceControlOperations: {
      title: "Контроль версий",
      actorThisSession: "эта сессия",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `сессия ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `Выполняется: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `Операции контроля версий заблокированы ${actor}.`,
      globalLock:
        "Операции временно заблокированы, потому что другая сессия выполняет команду контроля версий.",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "Выбран 1 файл для следующего коммита."
          : `Выбрано ${count} файлов для следующего коммита.`,
      clear: "Очистить",
      conflictsDetected:
        "Обнаружены конфликты. Коммит, pull и push заблокированы до их устранения.",
      actions: {
        fetch: "Получить",
        pull: "Скачать",
        push: "Отправить",
      },
      blockedHints: {
        lock: "Блокировка",
        commitBlocked: "Коммит заблокирован",
        pullBlocked: "Pull заблокирован",
        pushBlocked: "Push заблокирован",
      },
      update: {
        remotes: {
          title: "Удаленные репозитории",
          empty: "Для этого репозитория не настроены удаленные репозитории.",
          addTitle: "Добавить удаленный репозиторий",
          editTitle: ({ name }: { name: string }) => `Изменить ${name}`,
          add: "Добавить удаленный",
          remove: "Удалить",
          nameLabel: "Имя удаленного",
          fetchUrlLabel: "URL для fetch",
          pushUrlLabel: "URL для push",
          namePlaceholder: "origin",
          fetchUrlPlaceholder: "URL для fetch",
          pushUrlPlaceholder: "URL для push (необязательно)",
          noFetchUrl: "Нет URL для fetch",
          removeConfirmTitle: "Удалить удаленный репозиторий?",
          removeConfirmBody: ({ name }: { name: string }) =>
            `Удалить ${name} из этого репозитория?`,
          errors: {
            nameRequired: "Введите имя удаленного репозитория.",
            fetchUrlRequired: "Введите URL для fetch.",
            addFailed: "Не удалось добавить удаленный репозиторий.",
            saveFailed: "Не удалось обновить удаленный репозиторий.",
            removeFailed: "Не удалось удалить удаленный репозиторий.",
          },
        },
        publishRepository: {
          title: "Опубликовать в GitHub",
          body: "Создает репозиторий GitHub и добавляет его как origin.",
          ownerLabel: "Владелец",
          repositoryNameLabel: "Имя репозитория",
          repositoryNamePlaceholder: "имя-репозитория",
          visibilityLabel: "Видимость",
          private: "Приватный",
          public: "Публичный",
          internal: "Внутренний",
          remoteKindLabel: "URL удаленного репозитория",
          httpsRemote: "Удаленный HTTPS",
          sshRemote: "Удаленный SSH",
          originConflictLabel: "Существующий origin",
          keepOrigin: "Не заменять",
          setOriginUrl: "Задать URL origin",
          pushCurrentBranch: "Отправить текущую ветку",
          publish: "Опубликовать репозиторий",
          publishing: "Публикация…",
          noTargets: "Подключите GitHub или войдите через gh CLI, чтобы опубликовать этот репозиторий.",
          errors: {
            targetRequired: "Выберите аккаунт или организацию GitHub.",
            nameRequired: "Введите имя репозитория.",
            loadTargetsFailed: "Не удалось загрузить цели публикации GitHub.",
            publishFailed: "Не удалось опубликовать репозиторий.",
          },

          commitRequired: 'Создайте коммит перед публикацией с включённой отправкой ветки.',
          unsafeUrl: 'Провайдер вернул действие браузера вне разрешённого URL.',
          originConflictRemediation: 'Выберите, оставить существующий remote origin или обновить его на новый размещённый репозиторий.',
          auth: {
              connectedAccountReady: 'Подключённый сервис GitHub доступен.',
              providerCliReady: 'Аутентифицированный GitHub CLI доступен.',
          },
          remediation: {
              connectGitHub: 'Подключить GitHub',
              installGh: 'Установить GitHub CLI',
              useManagedGh: 'Использовать управляемый GitHub CLI',
              authenticateGh: 'Аутентифицировать GitHub CLI',
              openBrowser: 'Открыть браузер',
          },},
        branchIntegration: {
          title: "Merge и rebase",
          sourceLabel: "Исходная ветка",
          sourcePlaceholder: "Ветка или удаленная ссылка",
          merge: "Слить",
          rebase: "Перебазировать",
          continue: "Продолжить",
          abort: "Отменить",
          operationInProgress: ({ operation, source }: { operation: string; source: string }) =>
            `${operation} выполняется из ${source}`,
          errors: {
            sourceRequired: "Введите исходную ветку или ссылку.",
            mergeFailed: "Не удалось выполнить merge ветки.",
            rebaseFailed: "Не удалось выполнить rebase ветки.",
            continueFailed: "Не удалось продолжить операцию.",
            abortFailed: "Не удалось отменить операцию.",
          },
        },
        pullRequests: {
          title: "Запрос на слияние",
          readyTitle: "Готово к открытию pull request",
          view: "Открыть PR",
          openOrReuse: "Открыть или использовать PR",
          pushAndOpen: "Отправить и открыть PR",
          createFeatureBranch: "Создать feature-ветку",
          createFeatureBranchAndOpen: "Создать ветку и открыть PR",
          featureBranchPromptTitle: "Имя feature-ветки",
          featureBranchPromptBody: "Happier переключится на эту ветку перед продолжением.",
          defaultBranchRequiresFeature: "Создайте feature-ветку перед открытием pull request из ветки по умолчанию.",
          defaultBranchDenied: "Нельзя открывать pull request напрямую из ветки по умолчанию.",
          states: {
            ready: "Готово",
            open: "Открыт",
            closed: "Закрыт",
            merged: "Слит",
          },
          status: {
            creating: "Открытие pull request…",
            creatingFeatureBranch: "Создание feature-ветки…",
            creatingFeatureBranchPullRequest: "Создание feature-ветки и открытие pull request…",
            pushingAndCreating: "Отправка ветки и открытие pull request…",
          },
          unavailable: {
            notRepositoryTitle: "Репозиторий не обнаружен",
            notRepositoryBody: "Действия pull request появятся, когда эта сессия будет подключена к репозиторию системы контроля версий.",
            unknownProviderTitle: "Провайдер хостинга не обнаружен",
            unknownProviderBody: "Добавьте remote GitHub, GitLab или Bitbucket, чтобы включить действия pull request.",
            noBranchTitle: "Ветка не выбрана",
            noBranchBody: "Переключитесь на ветку перед открытием pull request.",
            detachedHeadTitle: "Отсоединенный HEAD",
            detachedHeadBody: "Переключитесь на ветку перед открытием pull request.",
          },
          errors: {
            featureBranchRequired: "Создайте feature-ветку перед открытием pull request.",
            openFailed: "Не удалось открыть pull request.",
            branchNameRequired: "Введите имя feature-ветки.",
            createBranchFailed: "Не удалось создать feature-ветку.",
            stackedFailed: "Не удалось завершить workflow pull request.",
          },
        },

        pullRequest: {
            title: "Запрос на слияние",
            existing: "Существующий запрос на слияние",
            ready: "Можно создать запрос на слияние",
            branchPair: ({ head, base }: { head: string; base: string }) =>
                `${head} в ${base}`,
            open: "Открыть запрос на слияние",
            create: "Создать запрос на слияние",
            openCompose: "Открыть создание",
            unsafeUrl: "Провайдер вернул ссылку за пределами разрешенного URL репозитория.",
            defaultBranch: {
                confirmTitle: "Создать функциональную ветку?",
                confirmBody: "Создайте функциональную ветку перед открытием запроса на слияние для этого изменения в ветке по умолчанию.",
                confirm: "Создать ветку",
            },
        },
        publish: {
            title: "Опубликовать репозиторий",
            description: "Создать репозиторий на хостинге и подключить его как удаленный.",
            repositoryNameLabel: "Имя репозитория",
            ownerLabel: "Владелец",
            visibilityLabel: "Видимость",
            protocolLabel: "URL удаленного репозитория",
            pushCurrentBranch: "Отправить текущую ветку",
            commitRequired: "Создайте коммит перед публикацией с включенной отправкой ветки.",
            submit: "Опубликовать репозиторий",
            unavailable: "Публикация недоступна для этого репозитория.",
            unsafeUrl: "Провайдер вернул действие браузера за пределами разрешенного URL.",
            auth: {
                connectedAccountReady: "Подключенный сервис GitHub доступен.",
                providerCliReady: "Аутентифицированный GitHub CLI доступен.",
            },
            remediation: {
                connectGitHub: "Подключить GitHub",
                installGh: "Установить GitHub CLI",
                useManagedGh: "Использовать управляемый GitHub CLI",
                authenticateGh: "Аутентифицировать GitHub CLI",
                openBrowser: "Открыть браузер",
            },
            visibility: {
                private: "Приватный",
                public: "Публичный",
                internal: "Внутренний",
            },
            protocol: {
                https: "HTTPS",
                ssh: "SSH",
            },
            remoteConflict: {
                label: "Существующий удаленный origin",
                fail: "Сохранить существующий origin",
                setUrl: "Заменить URL origin",
                remediation: "Выберите, сохранить существующий удаленный origin или обновить его до нового репозитория на хостинге.",
            },
        },},

      repositoryInit: {
          action: "Инициализировать репозиторий",
          confirmTitle: "Инициализировать репозиторий?",
          confirmBody: "Создать метаданные системы контроля версий для этой папки, чтобы отслеживать изменения.",
          confirm: "Инициализировать",
          failed: "Не удалось инициализировать репозиторий.",
      },},

    indexLockRecovery: {
      title: "Удалить устаревшую блокировку индекса Git?",
      body: "Happier может удалить файл index.lock, разрешённый Git для этого репозитория, и один раз повторить неудачную операцию с контролем кода. Это не выполняет reset, clean, restore или широкое восстановление.",
      confirm: "Удалить блокировку и повторить",
      failed: ({ error }: { error: string }) => `Не удалось восстановить блокировку индекса: ${error}`,
    },
    checkpointAttributionExclusive:
      'Содержимое checkpoint точно для этого интервала хода, и worktree был эксклюзивен для этой сессии.',
    noAgentReportedTurnChanges:
      "Для этого хода не обнаружены изменения, о которых сообщил агент.",
    noCheckpointTurnChanges:
      "Для этого хода не обнаружены изменения checkpoint.",},

  localServices: {
    inventory: {
      title: 'Локальные службы',
      loadingTitle: 'Сканирование локальных служб',
      emptyTitle: 'Локальные службы не обнаружены',
      errorTitle: 'Сканирование локальных служб требует внимания',
      refreshing: 'Обновление',
      state: {
        listening: 'Слушает',
        stale: 'Устарело',
        gone: 'Недоступно',
        unknown: 'Неизвестно',
      },
      address: ({ value }: { value: string }) => `Address: ${value}`,
      folder: ({ value }: { value: string }) => `Folder: ${value}`,
      label: ({ value }: { value: string }) => `Label: ${value}`,
      process: ({ value }: { value: string }) => `Process: ${value}`,
      workspace: ({ value }: { value: string }) => `Workspace: ${value}`,
      confidence: ({ value }: { value: string }) => `Confidence: ${value}`,
            confidenceLabel: {
                strong: 'Высокая точность совпадения',
                moderate: 'Вероятное совпадение',
                tentative: 'Предварительное совпадение',
            },
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      countBadge: ({ total, running }: { total: string; running: string }) => `${total} services · ${running} running`,
    },
    session: {
      thisSessionTitle: 'Эта сессия',
      workspaceTitle: 'Рабочее пространство',
    },
    scope: {
      workspace: 'Это рабочее пространство',
      machine: 'Эта машина',
      toggleA11y: 'Переключить область служб между этим рабочим пространством и этой машиной',
    },
    source: {
      detected: 'Обнаружено',
      managed: 'Управляемый',
      packageScript: 'Скрипт пакета',
      preview: 'Предпросмотр',
      terminalUrl: 'URL терминала',
      fileAsset: 'Файловый ресурс',
      recent: 'Недавние',
    },
    band: {
      machine: 'Другие службы машины',
      suggestions: 'Предложения',
    },
    rowStatus: {
      running: 'Выполняется',
      starting: 'Запуск',
      stale: 'Устаревший',
      stopped: 'Остановлено',
      unavailable: 'Недоступно',
    },
    managed: {
      title: 'Управляемые службы',
      emptyTitle: 'Нет управляемых служб',
      owner: ({ value }: { value: string }) => `Owner: ${value}`,
      route: ({ value }: { value: string }) => `Route: ${value}`,
      launchMode: ({ value }: { value: string }) => `Mode: ${value}`,
            launchModeLabel: {
                detectedAfterStart: 'Обнаружено после запуска',
                assignedAtStart: 'Порт назначен при запуске',
                registeredByTool: 'Зарегистрировано инструментом',
            },
      url: ({ value }: { value: string }) => `URL: ${value}`,
      inventory: ({ value }: { value: string }) => `Inventory: ${value}`,
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      stopActionA11y: 'Остановить управляемый сервис',
      restartActionA11y: 'Перезапустить управляемый сервис',
      status: {
        starting: 'Запускается',
        detecting: 'Определяется',
        running: 'Работает',
        unhealthy: 'Неполадки',
        stopping: 'Останавливается',
        stopped: 'Остановлено',
        failed: 'Сбой',
      },
    },
    launcher: {
      title: 'Панель запуска',
      refreshing: 'Обновление локальных сервисов',
      openInBrowserA11y: 'Открыть локальный сервис в браузере',
      status: {
        ready: 'Готово к предпросмотру',
        managed: 'Управляемая служба',
        unavailableGeneric: "Эта служба сейчас недоступна.",
      },
      unavailableReason: {
        launchUnavailable: "Эту службу нельзя запустить отсюда.",
        previewRegistrationUnavailable: "Эта служба не может зарегистрировать предпросмотр.",
        browserTargetUnavailable: "Эту службу нельзя открыть в браузере.",
        starting: "Эта служба ещё запускается.",
        stale: "Эта служба обнаружена, но больше не отвечает.",
        unavailable: "Эта служба сейчас недоступна.",
      },
    },
    publicPreview: {
      title: 'Публичные предпросмотры',
      createSubtitle: 'Создать ссылку предпросмотра для общего доступа',
      activeSubtitle: 'Ссылка для общего доступа активна',
      secretLinkMode: 'Секретная ссылка',
      disabledPolicySubtitle: 'Публичные предпросмотры отключены для этого сервиса.',
      disabledUnsupportedModeSubtitle: 'Сейчас Happier создает только публичные предпросмотры по секретной ссылке.',
      disabledLimitSubtitle: 'Достигнут лимит публичных предпросмотров. Отзовите существующую ссылку перед созданием новой.',
      disabledNoPreviewSubtitle: 'Откройте локальный предпросмотр перед созданием публичной ссылки.',
      disabledReason: {
        auditUnavailable: 'Журнал аудита публичного предпросмотра недоступен.',
        dnsTlsUnavailable: 'Публичные предпросмотры ожидают готовности DNS/TLS.',
        expired: 'Эта ссылка публичного предпросмотра истекла.',
        policyInvalid: 'Политика публичного предпросмотра неполная.',
        previewNotEligible: 'Этот локальный предпросмотр не подходит для публичной ссылки.',
        publicBaseUrlUnavailable: 'Базовый URL публичного предпросмотра не настроен.',
        rateLimitUnavailable: 'Ограничение частоты публичного предпросмотра недоступно.',
        rateLimited: 'Эта ссылка публичного предпросмотра ограничена по частоте.',
        relayUnavailable: 'Релей публичного предпросмотра недоступен.',
        revoked: 'Эта ссылка публичного предпросмотра была отозвана.',
        secretLinkUnavailable: 'Публичные предпросмотры по секретной ссылке не настроены.',
        sessionNotAuthorized: 'У вас нет доступа для создания публичной ссылки для этой сессии.',
      },
      createActionA11y: 'Создать публичную ссылку предпросмотра',
      revokeActionA11y: 'Отозвать публичную ссылку предпросмотра',
      confirmTitle: 'Сделать сервис публичным?',
      confirmMessage: ({ service }: { service: string }) =>
        `«${service}» станет публично доступен в интернете по общей секретной ссылке.`,
      confirmCta: 'Создать публичную ссылку',
            revokeConfirmTitle: 'Отозвать публичную ссылку?',
            revokeConfirmMessage: ({ url }: { url: string }) => `Отозвать публичную ссылку предпросмотра ${url}? Все, кто ее использует, потеряют доступ.`,
            revokeConfirmCta: 'Отозвать ссылку',
    },
    actions: {
      terminateDetectedA11y: 'Завершить обнаруженный локальный сервис',
      terminatePidOnlyConfidence: 'Надежность завершения: только PID; требуется подтверждение',
            copyAddressA11y: 'Скопировать адрес службы',
            terminateConfirmTitle: 'Завершить службу?',
            terminateConfirmMessage: ({ service }: { service: string }) => `Завершить ${service}? Используйте это только если уверены, что это нужный процесс.`,
            terminateConfirmCta: 'Завершить',
            stopConfirmTitle: 'Остановить службу?',
            stopConfirmMessage: ({ service }: { service: string }) => `Остановить ${service}? Служба будет недоступна, пока не запустится снова.`,
            stopConfirmCta: 'Остановить',
    },
  },

  browserContext: {
    composer: {
      attachPageReference: 'Прикрепить страницу',
      startAnnotation: 'Аннотировать страницу',
      cancelAnnotation: 'Отменить аннотацию',
      attachAnnotation: 'Прикрепить аннотацию',
      contextUnavailable: 'Контекст браузера недоступен',
      attachedPage: ({ title }: { title: string }) => `Страница: ${title}`,
      attachedPageStale: ({ title }: { title: string }) => `Обновите контекст страницы: ${title}`,
      attachedCount: ({ count }: { count: string }) => `${count} контекстов браузера`,
      removeAttachedContext: 'Удалить контекст браузера',
      untitledPage: 'Страница без названия',
    },
  },

  browserRecording: {
    actions: {
      start: 'Начать запись',
      stop: 'Остановить запись',
      cancel: 'Отменить запись',
    },
    fidelity: {
        pixel: 'Визуальный захват',
        cdp: 'Захват браузера',
        injectedPage: 'Захват страницы',
        nativeCallback: 'Нативный захват',
        streamFrame: 'Захват потока',
        previewProxy: 'Захват предпросмотра',
        unavailable: 'Ожидание захвата',
    },
    status: {
      noView: 'Представление браузера не выбрано.',
      unavailable: ({ reason }: { reason: string }) => `Запись недоступна: ${reason}`,
      ready: ({ fidelity }: { fidelity: string }) => `Запись готова (${fidelity})`,
      recording: ({ elapsed, fidelity }: { elapsed: string; fidelity: string }) => `Запись ${elapsed} (${fidelity})`,
      temporary: 'Временная',
      attached: 'Прикреплена',
      discarded: 'Отклонена',
    },
  },

  browserAutomation: {
    actions: {
      cancel: 'Отменить автоматизацию',
    },
    status: {
      noView: 'Представление браузера не выбрано.',
      unavailable: 'Автоматизация недоступна',
            running: 'Автоматизация выполняется',
            readyForActions: 'Автоматизация готова',
      ready: ({ authority }: { authority: string }) => `Автоматизация готова (${authority})`,
      active: ({ requestId }: { requestId: string }) => `Автоматизация выполняется: ${requestId}`,
    },
    timeline: {
      entry: ({ action, status }: { action: string; status: string }) => `${action}: ${status}`,
            action: {
                inspect: 'Проверить страницу',
                interact: 'Взаимодействовать со страницей',
                navigate: 'Перейти по странице',
                browserAction: 'Действие браузера',
            },
            status: {
                succeeded: 'Готово',
                failed: 'Ошибка',
                canceled: 'Отменено',
                timedOut: 'Истекло время ожидания',
                stale: 'Устаревшая страница',
                blocked: 'Заблокировано',
                unsupported: 'Не поддерживается',
            },
    },
  },

  browserSurface: {
    title: 'Браузер',
    openA11y: 'Открыть браузер',
    openHint: 'Открывает панель запуска браузера в деталях.',
    openDisabledA11y: 'Браузер недоступен',
  },

  browserLaunchpad: {
    refreshing: 'Обновление целей браузера',
    sections: {
      running: 'Запущенные предпросмотры',
      managed: 'Управляемые сервисы',
      plugin: 'Интерфейс плагинов',
      recent: 'Недавние',
      unavailable: 'Недоступно',
    },
    status: {
      ready: 'Готово к открытию',
      managed: 'Управляемый сервис',
      plugin: 'Интерфейс плагина',
      recent: 'Недавняя цель',
      openUnavailable: 'Открытие недоступно',
      unavailableGeneric: "Эта цель сейчас недоступна.",
    },
    guidance: {
      title: 'Пока ничего не запущено',
      body: 'Запустите сервер разработки, и порты localhost этого рабочего пространства появятся здесь автоматически. Вы также можете ввести любой адрес выше.',
    },
    urlEntry: {
      label: 'Открыть адрес',
      placeholder: 'Введите URL',
      open: 'Открыть адрес',
      invalid: 'Введите корректный адрес http или https.',
    },
    error: {
      title: 'Цели браузера требуют внимания',
      subtitle: ({ reason }: { reason: string }) => `Ошибка обновления: ${reason}`,
    },
  },

  browserShell: {
    address: {
      label: 'Адрес браузера',
      placeholder: 'Введите URL',
            copy: 'Скопировать URL',
    },
        frame: {
            errorTitle: 'Страница не загрузилась',
        },
    nonFramable: {
      title: 'Этот сайт запрещает встраивание.',
      openInSystemBrowser: 'Открыть в системном браузере',
    },
    toolbar: {
      back: 'Назад',
      forward: 'Вперед',
      reload: 'Перезагрузить',
      stop: 'Остановить',
      openNativeDevtools: 'Открыть встроенные инструменты разработчика',
      reloadAfterCrash: 'Перезагрузить страницу',
    },
    tabs: {
      newTab: 'Новая вкладка',
    },
    origin: {
      newTab: 'Новая вкладка',
      localPreview: 'Локальный предпросмотр',
      hostedPlugin: 'Интерфейс плагина',
      external: 'Внешний URL',
      streamed: 'Потоковый браузер',
      simulator: 'Симулятор',
    },
    security: {
      secure: 'Безопасное соединение',
      local: 'Локальное соединение',
      insecure: 'Небезопасно',
      internal: 'Внутренняя поверхность',
      unknown: 'Состояние соединения неизвестно',
    },
    title: {
      untitled: 'Страница без названия',
    },
    overflow: {
      open: 'Дополнительные инструменты браузера',
      title: 'Инструменты браузера',
    },
    profile: {
      title: 'Состояние профиля браузера',
      modeLabel: 'Режим',
      storageLabel: 'Хранилище',
      permissionsLabel: 'Разрешения',
      unavailable: 'Недоступно',
      mode: {
        ephemeral: 'Временный',
        session: 'Сессия',
        user: 'Пользователь',
        plugin: 'Плагин',
      },
      storage: {
        unavailable: 'Нет раздела',
        ephemeral: 'Временное',
        session: 'Сессия',
        persistent: 'Постоянное',
        plugin: 'Плагин',
      },
      permissions: {
        none: 'Нет разрешений',
        active: ({ count }: { count: number }) => `${count} активн.`,
        prompt: 'Запрос',
        denied: 'Запрещено',
      },
      management: {
        createProfile: 'Новый профиль',
        selectProfile: 'Выбрать профиль',
        revokePermission: 'Отозвать',
        clearStorage: 'Очистить хранилище',
      },
    },
    privacy: {
      title: 'Конфиденциальность и безопасность',
    },
    status: {
      noView: 'Вид браузера не выбран.',
      empty: 'Страница не загружена.',
      noUrl: 'URL не загружен.',
      loading: 'Загрузка…',
      crashed: 'Эта страница перестала отвечать и была закрыта.',
    },
    unavailable: {
      generic: "Эта страница сейчас недоступна.",
      desktopEngineUnavailable: "Встроенный движок браузера недоступен на этом компьютере.",
      desktopWebView: "Встроенный движок браузера недоступен на этом компьютере.",
      desktopWebViewUnsupportedPlatform: "Встроенный просмотр пока недоступен на этой платформе.",
      externalUrlPolicyDenied: "Этот сайт заблокирован вашей политикой безопасности.",
      externalUrlUnavailable: "Этот сайт нельзя открыть во встроенном браузере.",
      simulatorPreviewUnavailable: "Предпросмотр симулятора сейчас недоступен.",
      sidecarRuntimeUnavailable: "Среда браузера сейчас недоступна.",
      streamedBrowserUnavailable: "Потоковый браузер сейчас недоступен.",
      hostUnavailable: "Потеряно соединение с хостом браузера.",
      targetKindUnavailable: "Эту цель нельзя открыть во встроенном браузере.",
      browserProfileMissing: "Для этой страницы нет доступного профиля браузера.",
      hostedPluginBlocked: "Эта страница плагина заблокирована его политикой безопасности.",
      invalidUrl: "Этот адрес нельзя открыть.",
      ownerDisconnected: "Потеряно соединение с владельцем страницы.",
      surface: {
        disabled: "Встроенный просмотр отключён.",
        viewTargetsDisabled: "Цели браузера отключены.",
        hostLost: "Потеряно соединение с хостом браузера.",
        adapterRecovering: "Повторное подключение к браузеру…",
        liveStateLost: "Активный сеанс браузера потерян.",
        unsupportedTarget: "Эту цель нельзя открыть во встроенном браузере.",
      },
    },
    devtools: {
      title: 'Диагностика',
      collapse: 'Свернуть диагностику',
      expand: 'Развернуть диагностику',
      close: 'Скрыть диагностику',
      open: 'Показать диагностику',
      section: {
        console: 'Консоль',
                pageErrors: 'Ошибки страницы',
        network: 'Сеть',
        elements: 'Элементы',
        resources: 'Ресурсы',
        storage: 'Хранилище',
        info: 'Сведения',
        performance: 'Производительность',
      },
    },
  },

  streamPlayer: {
    status: {
      opening: 'Открытие потока…',
      playing: 'В эфире',
      degraded: 'Пониженное качество',
      reconnecting: 'Повторное подключение…',
      stopped: 'Остановлено',
      unavailable: 'Поток недоступен',
      errorGeneric: 'Ошибка потока',
      decoderUnavailable: 'Декодирование видео недоступно в этом браузере.',
      preservingLastFrame: 'Показывается последний кадр',
      permissionExpired: 'Разрешение истекло',
      leaseExpired: 'Срок управления истек',
      lowBandwidth: 'Низкая пропускная способность',
      degradedCodec: 'Кодек в режиме пониженного качества',
    },
    actions: {
      requestKeyframe: 'Запросить ключевой кадр',
      lowerQuality: 'Снизить качество',
    },
    controls: {
      readOnly: 'Только просмотр',
      controlling: 'Управление',
      controlsUnavailable: 'Управление недоступно',
      controlsAvailable: 'Управление доступно',
    },
    renderer: {
      fallback: 'Резервный рендерер',
    },
  },

  simulatorPreview: {
    picker: {
      title: 'Устройства',
      empty: 'Нет доступных устройств симулятора.',
    },
    status: {
      connecting: 'Подключение к устройству…',
      restoring: 'Восстановление предпросмотра…',
    },
    availability: {
      available: 'Доступно',
      degraded: 'Пониженное качество',
      unavailable: 'Недоступно',
      noDevices: 'Нет доступных устройств симулятора.',
      captureUnavailable: 'Захват недоступен для этого устройства.',
      resourceUnavailable: 'Этот ресурс симулятора недоступен.',
      captureDegraded: 'Захват работает с пониженным качеством.',
      streamDegraded: 'Качество потока понижено.',
      lastFrame: 'Показывается последний доступный кадр.',
      streamUnavailable: 'Поток недоступен.',
      unavailableGeneric: 'Предпросмотр устройства сейчас недоступен.',
    },
    toolbar: {
      heldByOther: 'Занято другим зрителем',
            heldByOtherWithHolder: ({ holder }: { holder: string }) => `Удерживает ${holder}`,
      acquireControl: 'Взять управление',
      releaseControl: 'Освободить управление',
      renewControl: 'Продлить управление',
      snapshot: 'Снимок',
            refreshFrame: 'Обновить кадр',
            quality: 'Качество',
            reduceBandwidth: 'Снизить расход трафика',
      fps: 'Лимит 30 FPS',
      scale: 'Лимит 1080 px',
      rotateLeft: 'Повернуть влево',
      homeButton: 'Домой',
      backButton: 'Назад',
      recentButton: 'Недавние',
      volumeUp: 'Громче',
      volumeDown: 'Тише',
            moreControls: 'Дополнительные элементы управления устройством',
    },
    sidebands: {
      title: 'Диагностика',
      logs: 'Логи',
      accessibilityTree: 'Доступность',
      deviceConfig: 'Конфигурация устройства',
      appMetadata: 'Метаданные приложения',
      networkDiagnostics: 'Сеть',
      route: 'Маршрут',
      captureHealth: 'Состояние захвата',
      refresh: 'Обновить',
      empty: 'Данных пока нет.',
            open: 'Открыть диагностику',
            close: 'Закрыть диагностику',
            refreshA11y: ({ section }: { section: string }) => `Обновить ${section}`,
            arrayValue: ({ count }: { count: string }) => `${count} элементов`,
            objectValue: ({ count }: { count: string }) => `${count} полей`,
            valueUnavailable: 'Недоступно',
            fields: {
                level: 'Уровень',
                message: 'Сообщение',
                route: 'Маршрут',
                status: 'Статус',
                reason: 'Причина',
            },
    },
    diagnostics: {
      item: ({ reasonCode }: { reasonCode: string }) => `Диагностика: ${reasonCode}`,
    },
  },

  browserDiagnostics: {
    previewProxy: {
      title: 'Диагностика предпросмотра',
      status: {
        available: 'Доступно',
        stale: 'Устарело',
        unavailable: 'Недоступно',
      },
      fidelity: {
        previewProxy: 'Прокси предпросмотра',
        unavailable: 'Недоступно',
        cdp: 'CDP',
        injectedPage: 'Внедренная страница',
        nativeCallback: 'Нативный callback',
        streamFrame: 'Кадр потока',
      },
      activeFlows: ({ count }: { count: string }) => `${count} активных потоков`,
      attributionAllViews: 'Трафик этого предпросмотра, все представления',
      staleNotice: 'Диагностика устарела; переподключитесь, чтобы запросить новый снимок.',
      unavailableReason: ({ reasonCode }: { reasonCode: string }) => `Диагностика недоступна: ${reasonCode}`,
      networkEmpty: 'Трафик предпросмотра еще не захвачен.',
      familyAvailable: ({ family }: { family: string }) => `${family}: доступно`,
      familyUnavailable: ({ family }: { family: string }) => `${family}: недоступно`,
      httpFlow: ({ method, path, statusCode }: { method: string; path: string; statusCode: string }) => `${method} ${path} - ${statusCode}`,
      webSocketFlow: ({ subprotocol }: { subprotocol: string }) => `WebSocket - ${subprotocol}`,
      tunnelFlow: ({ flowId }: { flowId: string }) => `Туннель ${flowId}`,
      flowBytes: ({ bytesIn, bytesOut }: { bytesIn: string; bytesOut: string }) => `Вход ${bytesIn} B / выход ${bytesOut} B`,
      flowMessages: ({ messagesIn, messagesOut }: { messagesIn: string; messagesOut: string }) => `Сообщения ${messagesIn}/${messagesOut}`,
    },
    host: {
      title: 'Диагностика браузера',
      eventCount: ({ count }: { count: string }) => `${count} диагностических событий`,
      untrustedNotice: 'Внедренная диагностика может быть изменена страницей и имеет более низкую точность.',
      untrustedEvent: 'Недоверенное внедренное событие',
      eventsEmpty: 'Диагностика браузера еще не захвачена.',
      eventTitle: ({ family, kind }: { family: string; kind: string }) => `${family} - ${kind}`,
            eventTitles: {
                pageError: 'Ошибка страницы',
                console: 'Сообщение консоли',
            },
            eventKinds: {
                pageError: 'Ошибка страницы',
                consoleEntry: 'Запись консоли',
                network: 'Сетевое событие',
                event: 'Событие',
            },
      eventSummaryUnavailable: 'Метаданные недоступны',
      families: {
        console: 'Консоль',
                pageError: 'Ошибки страницы',
        elements: 'Элементы',
        resources: 'Ресурсы',
        storage: 'Хранилище',
        performance: 'Производительность',
        network: 'Сеть',
        pageInfo: 'Информация о странице',
                other: 'Диагностика',
            },
      detail: {
        keys: ({ count }: { count: string }) => `Ключи (${count})`,
        entries: ({ count }: { count: string }) => `Ресурсы (${count})`,
      },
      fields: {
        method: 'Метод',
        status: 'Статус',
        url: 'URL',
        duration: 'Время',
        requestSize: 'Запрос',
        responseSize: 'Ответ',
        socket: 'Сокет',
        state: 'Состояние',
        framesSent: 'Кадры отправлены',
        framesReceived: 'Кадры получены',
        bytesSent: 'Байты отправлены',
        bytesReceived: 'Байты получены',
        messages: 'Сообщения',
        protocol: 'Протокол',
        selector: 'Селектор',
        backendNode: 'Узел backend',
        rect: 'Прямоугольник',
        accessibleName: 'Доступное имя',
        storageType: 'Тип хранилища',
        keyCount: 'Ключи',
        truncated: 'Обрезано',
        level: 'Уровень',
        arguments: 'Аргументы',
        message: 'Сообщение',
        serviceWorker: 'Сервис-воркер',
        webgl: 'Состояние WebGL',
        webrtc: 'Состояние WebRTC',
        nodeCount: 'Узлы',
        elementCount: 'Элементы',
        maxDepth: 'Макс. глубина',
        readyState: 'Состояние готовности',
        lcp: 'LCP',
        cls: 'CLS',
        inp: 'INP',
        fcp: 'FCP',
        longTasks: 'Долгие задачи',
        longTaskTime: 'Время долгих задач',
        responseEnd: 'Конец ответа',
        domContentLoaded: 'DOM готов',
        loadEventEnd: 'Завершение загрузки',
        type: 'Тип',
      },
      interaction: {
        title: 'Интерактивная диагностика',
        enabled: 'Интерактивная диагностика включена',
        disabled: 'Интерактивная диагностика выключена',
        unavailable: ({ reasonCode }: { reasonCode: string }) => `Интерактивная диагностика недоступна: ${reasonCode}`,
        ownerOnly: 'Только владелец сеанса может включить интерактивную диагностику.',
        enable: 'Включить взаимодействие',
        disable: 'Выключить взаимодействие',
        startPicker: 'Выбрать элемент',
        cancelPicker: 'Отменить выбор',
        pickerActive: 'Выбор элемента активен',
        pickerUnavailable: 'Выбор элемента недоступен',
        eval: {
            title: 'Консоль',
            placeholder: 'Оценить выражение',
            run: 'Выполнить',
            empty: 'Выражения еще не выполнялись.',
            resultLabel: 'Результат',
            statusPending: 'Вычисление…',
            statusCompleted: 'Завершено',
            statusFailed: 'Ошибка',
            statusTimedOut: 'Истекло время ожидания',
            statusBlocked: 'Заблокировано',
            statusDegraded: 'Сборщик работает с ограничениями',
            error: ({ reasonCode }: { reasonCode: string }) => `Ошибка: ${reasonCode}`,
            expand: 'Развернуть',
            collapse: 'Свернуть',
            loading: 'Загрузка свойств…',
            noProperties: 'Нет свойств.',
            propertiesFailed: ({ reasonCode }: { reasonCode: string }) => `Свойства недоступны: ${reasonCode}`,
        },
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Запустить выполнение",
      sections: {
        intent: "Назначение",
        permissions: "Разрешения",
        backends: "Бэкенды",
        profiles: "Профили",
        instructions: "Инструкции",
      },
      intents: {
        review: "Ревью",
        plan: "План",
        delegate: "Делегировать",
      },
      permissionModes: {
        readOnly: "Только чтение",
        default: "По умолчанию",
      },
      instructionsPlaceholder: "Что должен сделать подагент?",
      actions: {
        start: "Запустить",
      },
      guidancePreview: "Предпросмотр подсказок",
      a11y: {
        startRun: "Запустить выполнение",
        cancel: "Отмена",
        selectIntent: ({ intent }: { intent: string }) =>
          `Выбрать назначение ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `Выбрать разрешения ${mode}`,
        selectProfile: ({ profile }: { profile: string }) => `Выбрать профиль ${profile}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Переключить бэкенд ${backendId}`,
      },
    },
    details: {
      titles: {
        executionRun: "Запуск выполнения",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent}: запуск выполнения`,
      },
      labels: {
        status: "Статус",
        statusValue: ({ value }: { value: string }) => `Status: ${value}`,
        runId: ({ value }: { value: string }) => `Run ID: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permissions: ${value}`,
        mode: ({ value }: { value: string }) => `Mode: ${value}`,
        intent: "Намерение",
        backendId: "ID бэкенда",
        permissionMode: "Режим разрешений",
        retentionPolicy: "Политика хранения",
        runClass: "Класс запуска",
        ioMode: "Режим ввода/вывода",
      },
      timestamps: {
        started: "Начато",
        finished: "Завершено",
      },
    },
  },

      settingsActions: {
        aboutSubtitle: "Выберите, где каждое действие будет отображаться в приложении, голосовой связи и интеграции. ",
        aboutFooter: "Эти настройки применяются глобально к настройкам вашей учетной записи по умолчанию. ",
        searchPlaceholder: "Действия поиска",
        detailSearchPlaceholder: "Поиск поверхностей",
        noResults: "Нет действий, соответствующих вашему текущему запросу.",
        noTargetsMatch: "Нет поверхностей, соответствующих текущему поиску.",
        noDescription: "Описание пока отсутствует.",
        requireApproval: "Требовать одобрения",
        invalidActionTitle: "Действие не найдено",
        invalidActionSubtitle: "Это действие больше недоступно в этой сборке.",
        configureActionAccessibilityLabel: "Настроить действие",
        approvalHelpTitle: "Режимы одобрения",
        approvalHelpBody: "«Сначала спрашивать» показывает подтверждение перед запуском этого действия из этой поверхности. «Разрешено» позволяет запускать его из этой поверхности без запроса одобрения.",
        toolExposure: {
            title: "Экспонирование инструмента",
            footer: "Определяет, показываются ли подходящие действия как прямые инструменты или доступны только через поиск действий.",
            subtitle: "Управляет регистрацией прямого инструмента для этой поверхности.",
            disabledSubtitle: "Включите эту поверхность перед изменением экспонирования инструмента.",
            options: {
                default: {
                    subtitle: "Использовать значение продукта по умолчанию для этой поверхности.",
                },
                defaultDiscoverableOnly: {
                    title: "Использовать по умолчанию (только поиск)",
                },
                defaultDirect: {
                    title: "Использовать по умолчанию (прямой инструмент)",
                },
                discoverableOnly: {
                    title: "Только поиск",
                    subtitle: "Доступно через поиск действий без добавления прямого инструмента.",
                },
                direct: {
                    title: "Прямой инструмент",
                    subtitle: "Зарегистрировать это действие как инструмент для прямого вызова.",
                },
            },
        },
        spawnPolicy: {
            title: "Политика создания AI-сессий",
            footer: "Эти настройки применяются только когда ассистент внутри сессии Happier создает другую сессию. Унаследованные настройки родительской сессии остаются разрешены; запрещенные элементы отклоняют явные переопределения с понятной ошибкой.",
            toggles: {
                allowCustomDirectory: { title: "Другой каталог", subtitle: "Разрешить ассистенту выбрать другой рабочий каталог." },
                allowCrossMachine: { title: "Цели на других машинах", subtitle: "Разрешить создание на другой доступной машине." },
                allowBackendTargetOverride: { title: "Цель backend", subtitle: "Разрешить выбрать другого агента или другую цель backend." },
                allowModelOverride: { title: "Модель", subtitle: "Разрешить выбрать модель вместо наследования родительской модели." },
                allowPermissionModeOverride: { title: "Режим разрешений", subtitle: "Разрешить равные или более низкие переопределения. Повышение прав все равно отклоняется." },
                allowAgentModeOverride: { title: "Режим агента", subtitle: "Разрешить выбрать режим агента или сессии." },
                allowConfigOptionOverrides: { title: "Параметры конфигурации", subtitle: "Разрешить параметры провайдера, например усилие рассуждения и workflow." },
                allowProfileOverride: { title: "Профиль", subtitle: "Разрешить выбор профиля по id без раскрытия секретов." },
                allowEnvironmentVariables: { title: "Переменные окружения", subtitle: "Разрешить явные переменные окружения в новых сессиях." },
                allowConnectedServicesOverride: { title: "Подключенные сервисы", subtitle: "Разрешить выбор привязок подключенных сервисов по ссылке." },
                allowMcpSelectionOverride: { title: "Выбор MCP", subtitle: "Разрешить переопределить унаследованный выбор серверов MCP." },
                allowTranscriptStorageOverride: { title: "Хранение транскрипта", subtitle: "Разрешить выбрать совместимый режим хранения." },
            },
            permissionCeiling: {
                title: "Потолок разрешений",
                subtitle: "Необязательный дополнительный потолок ниже разрешений вызывающей сессии.",
                options: {
                    inherit: { title: "Без дополнительного потолка", subtitle: "Использовать разрешения вызывающей сессии как единственный потолок." },
                    default: { title: "По умолчанию", subtitle: "Требует обычного поведения подтверждений или ниже." },
                    acceptEdits: { title: "Принимать правки", subtitle: "Разрешает автоматические правки, но не полный bypass." },
                    bypassPermissions: { title: "Обход разрешений", subtitle: "Разрешает полный обход только если он есть у вызывающей сессии." },
                    plan: { title: "План", subtitle: "Ограничивает созданные сессии планированием или только чтением." },
                    "read-only": { title: "Только чтение", subtitle: "Ограничивает созданные сессии режимом только чтения." },
                    "safe-yolo": { title: "Безопасный yolo", subtitle: "Разрешает безопасные автоматические записи в рабочей области." },
                    yolo: { title: "Режим yolo", subtitle: "Разрешает до yolo только если он есть у вызывающей сессии." },
                },
            },
        },
        status: {
            allowed: ({ count }: { count: number }) => `${count} разрешено`,
            askFirst: ({ count }: { count: number }) => `${count} сначала спрашивать`,
            off: ({ count }: { count: number }) => `${count} выкл.`,
            unavailable: ({ count }: { count: number }) => `${count} недоступно`,
        },
        modes: {
            off: "Выкл.",
            askFirst: "Сначала спрашивать",
            allowed: "Разрешено",
        },
        sections: {
            app: "В приложении",
            voice: "Голос",
            integrations: "Интеграции",
        },
        families: {
            browser: {
                title: "Браузер",
            },
            simulator: {
                title: "Симулятор",
            },
            localServices: {
                title: "Локальные сервисы",
            },
            plugins: {
                title: "Плагины",
            },
            session: {
                title: "Сессии",
            },
            scm: {
                title: "Контроль версий",
            },
            general: {
                title: "Общие",
            },
        },
        badges: {
            unavailable: "Недоступно",
        },
        reasons: {
            voiceFeature: "Включите настройки голосового помощника, чтобы использовать эту цель.",
            voiceInventoryPrivacy: "Чтобы использовать эту цель, включите параметр «Поделиться инвентарем устройства» в настройках конфиденциальности Voice Assistant.",
            mcpFeature: "Включите серверы MCP, чтобы отображать это действие через MCP.",
            executionRunsFeature: "Включите запуски выполнения, чтобы использовать это действие или цель.",
            memorySearchFeature: "Чтобы использовать это действие, включите поиск в локальной памяти.",
            sessionHandoffFeature: "Чтобы использовать это действие, включите поддержку передачи обслуживания сеанса.",
            notAvailableInThisApp: 'Эта точка показа пока недоступна в этом клиенте.',
            requiredByAgentPolicy: 'Политика требует подтверждения для агента. Это действие всегда сначала спрашивает.',
        },
        targets: {
            session_header: {
                title: "Заголовок сеанса",
                subtitle: "Виден на панели инструментов заголовка сеанса.",
            },
            session_action_menu: {
                title: "Меню сеанса",
                subtitle: "Видно в меню действий сеанса.",
            },
            session_info: {
                title: "Детали сеанса",
                subtitle: "Виден на экране информации о сеансе.",
            },
            pending_messages: {
                title: "Ожидающие сообщения",
                subtitle: "Отображается в элементах управления ожидающими сообщениями под транскриптом сеанса.",
            },
            command_palette: {
                title: "Палитра команд",
                subtitle: "Виден в глобальной палитре команд.",
            },
            slash_command: {
                title: "Слэш-команда",
                subtitle: "Доступно в средствах выбора действий в стиле косой черты.",
            },
            agent_input_chips: {
                title: "Композиторские фишки",
                subtitle: "Отображается в виде быстрых фишек рядом с входом агента.",
            },
            voice_panel: {
                title: "Голосовая панель",
                subtitle: "Отображается на панели голосового помощника.",
            },
            run_list: {
                title: "Список запусков",
                subtitle: "Виден из списков выполнения.",
            },
            run_card: {
                title: "Запустить карты",
                subtitle: "Видно на карточках выполнения.",
            },
            voice_tool: {
                title: "Голосовой инструмент",
                subtitle: "Доступен голосовому агенту в качестве вызываемого инструмента.",
            },
            voice_action_block: {
                title: "Блок голосовых действий",
                subtitle: "Показано внутри блоков голосовых действий и возможностей.",
            },
            agent: {
                title: "Агент сессии",
                subtitle: "Доступно для агентов внутри сессии как вызываемый инструмент.",
            },
            mcp: {
                title: 'MCP',
                subtitle: "Доступно через каталог действий MCP.",
            },
            cli: {
                title: "Интерфейс командной строки управления сеансом",
                subtitle: "Доступно через интерфейс командной строки управления сеансом.",
            },
            contextual_ui: {
                title: "Контекстный пользовательский интерфейс",
                subtitle: "Отображается на контекстных поверхностях пользовательского интерфейса, которые не имеют специального размещения.",
            },

            voice: {
                title: "Голос",
                subtitle: "Доступно голосовому агенту как вызываемая поверхность.",
            },},
    },

settingsSession: {
	    sessionList: {
	        title: 'Список сессий',
	        footer: 'Настройте, что показывается в каждой строке сессии.',
	        tagsTitle: 'Теги сессии',
	        tagsEnabledSubtitle: 'Управление тегами отображается в списке',
	        tagsDisabledSubtitle: 'Управление тегами скрыто',
	        workingStatusAnimatedTextTitle: 'Анимированный рабочий текст',
	        workingStatusAnimatedTextEnabledSubtitle: 'Менять рабочие глаголы, пока сессия выполняется',
	        workingStatusAnimatedTextDisabledSubtitle: 'Показывать постоянную метку работаю..., пока сессия выполняется',
	        narrowWorkingIndicatorTitle: 'Индикатор работы в узком списке',
	        narrowWorkingIndicatorSpinnerSelectedSubtitle: 'Показывать небольшой нейтральный спиннер в узких строках',
	        narrowWorkingIndicatorPulseSelectedSubtitle: 'Показывать пульсирующую точку в узких строках',
	        narrowWorkingIndicatorSpinnerTitle: 'Спиннер',
	        narrowWorkingIndicatorSpinnerSubtitle: 'Компактный нейтральный спиннер, пока сессия работает.',
	        narrowWorkingIndicatorPulseTitle: 'Пульсирующая точка',
	        narrowWorkingIndicatorPulseSubtitle: 'Компактная анимированная точка, пока сессия работает.',
	        workingIndicatorTitle: 'Индикатор работы',
	        workingIndicatorSpinnerSelectedSubtitle: 'Показывать небольшой нейтральный спиннер, пока сессии работают',
	        workingIndicatorPulseSelectedSubtitle: 'Показывать пульсирующую точку, пока сессии работают',
	        workingIndicatorSpinnerTitle: 'Спиннер',
	        workingIndicatorSpinnerSubtitle: 'Компактный нейтральный спиннер, пока сессия работает.',
	        workingIndicatorPulseTitle: 'Пульсирующая точка',
	        workingIndicatorPulseSubtitle: 'Компактная анимированная точка, пока сессия работает.',
	        identityDisplayTitle: 'Идентификатор сессии',
	        identityDisplaySubtitle: 'Выберите, что показывать перед названиями сессий в списке.',
	        identityDisplayAvatarTitle: 'Аватар',
	        identityDisplayAvatarSubtitle: 'Показывать созданный аватар каждой сессии.',
	        identityDisplayAgentLogoTitle: 'Логотип агента',
	        identityDisplayAgentLogoSubtitle: 'Показывать логотип агента каждой сессии.',
	        identityDisplayNoneTitle: 'Нет',
	        identityDisplayNoneSubtitle: 'Скрыть идентификатор в строках сессий.',
	        activeColorTitle: 'Активный цвет заголовка',
	        activeColorSubtitle: 'Выберите, какие сессии используют активный цвет заголовка.',
	        activeColorActivityAndAttentionTitle: 'Активность и внимание',
	        activeColorActivityAndAttentionSubtitle: 'Использовать активный цвет для работающих сессий и сессий, требующих внимания.',
	        activeColorAttentionOnlyTitle: 'Только внимание',
	        activeColorAttentionOnlySubtitle: 'Использовать активный цвет только для сессий, требующих вашего внимания.',
	        activeColorAllActiveTitle: 'Все активные сессии',
	        activeColorAllActiveSubtitle: 'Использовать активный цвет для каждой активной подключенной сессии.',
	        sectionModeTitle: 'Разделы сессий',
	        sectionModeSubtitle: 'Выберите, разделять ли сессии по активности.',
	        sectionModeActivitySelectedSubtitle: 'Разделять активные и неактивные сессии',
	        sectionModeSingleSelectedSubtitle: 'Показывать один раздел сессий, сгруппированный по workspace',
	        sectionModeActivityTitle: 'Активные и неактивные',
	        sectionModeActivitySubtitle: 'Разделять сессии по активности перед группировкой по workspace.',
	        sectionModeSingleTitle: 'Все сессии вместе',
	        sectionModeSingleSubtitle: 'Использовать один раздел сессий и сохранять группировку по workspace для каждой сессии.',
	        menuSections: {
	          sortBy: 'Сортировка',
	          show: 'Показ',
	          folderSortMode: 'Порядок папок',

	          organize: 'Организация',},
	        orderingTitle: 'Порядок сессий',
	        orderingSubtitle: 'Выберите, как сортировать сессии внутри групп.',
	        orderingOptions: {
	          custom: 'Пользовательский',
	          created: 'Создание',
	          updated: 'Обновление',
	        },
	        folderSortModeTitle: 'Порядок папок',
	        folderSortModeSubtitle: 'Выберите, как папки и сессии делят общий список.',
	        folderSortModeFoldersFirstTitle: 'Сначала папки',
	        folderSortModeFoldersFirstSubtitle: 'Группировать папки над сессиями в каждом рабочем пространстве или папке.',
	        folderSortModeMixedTitle: 'Смешанный порядок',
	        folderSortModeMixedSubtitle: 'Позволить папкам и сессиям сохранять точный общий порядок.',
	        folderSortModeMixedDisabledInDateModeSubtitle: 'Смешанный порядок папок доступен в пользовательском порядке.',
	        attentionPromotionModeTitle: 'Сессии, требующие внимания',
	        attentionPromotionModeSubtitle: 'Выберите, где показывать сессии, ожидающие вас или готовые к проверке',
	        attentionPromotionModeOffTitle: 'Оставлять на обычном месте',
	        attentionPromotionModeOffSubtitle: 'Сохранять список с текущей группировкой и сортировкой',
	        attentionPromotionModeGlobalTitle: 'Группировать вверху',
	        attentionPromotionModeGlobalSubtitle: 'Показывать одну секцию внимания выше остальных',
	        attentionPromotionModeWithinGroupsTitle: 'Перемещать вверх текущей группы',
	        attentionPromotionModeWithinGroupsSubtitle: 'Оставлять сессии в их папке или рабочей области',
	        workingPlacementModeTitle: 'Сессии в работе',
	        workingPlacementModeSubtitle: 'Выберите, где показывать сессии, которые сейчас работают',
	        workingPlacementModeOffTitle: 'Оставить на обычном месте',
	        workingPlacementModeOffSubtitle: 'Сохранять сессии в работе точно по текущей группировке и сортировке',
	        workingPlacementModeGlobalTitle: 'Группировать сверху',
	        workingPlacementModeGlobalSubtitle: 'Показывать секцию работы под сессиями, требующими внимания',
	        workingPlacementModeWithinGroupsTitle: 'Переместить вверх текущей группы',
	        workingPlacementModeWithinGroupsSubtitle: 'Оставлять сессии в работе в их папке или рабочей области',
	        workspacePathDisplayTitle: 'Имена рабочих пространств',
	        workspacePathDisplayNameSelectedSubtitle: 'По умолчанию показывать имя последней папки',
	        workspacePathDisplayPathSelectedSubtitle: 'Показывать полный путь рабочего пространства',
	        workspacePathDisplayName: 'Имя папки',
	        workspacePathDisplayNameDescription: 'Использовать последний сегмент пути, если рабочее пространство не переименовано.',
	        workspacePathDisplayPath: 'Полный путь',
	        workspacePathDisplayPathDescription: 'Использовать форматированный путь рабочего пространства, если оно не переименовано.',
	        workspaceFaviconsTitle: 'Фавиконы рабочих пространств',
	        workspaceFaviconsEnabledSubtitle: 'Показывать найденные фавиконы проекта рядом с именами рабочих пространств',
	        workspaceFaviconsDisabledSubtitle: 'Скрывать фавиконы проекта в заголовках рабочих пространств',
	        workspaceMachineSubtitlesTitle: 'Имена машин',
	        workspaceMachineSubtitlesEnabledSubtitle: 'Показывать имя машины под именами рабочих пространств, когда это нужно',
	        workspaceMachineSubtitlesDisabledSubtitle: 'Скрывать имена машин в заголовках рабочих пространств',

	        folderTreeView: "Folder tree view",},
	    mobileWorkspaceExperience: {
	        groupTitle: 'Мобильное рабочее пространство',
	        groupFooter: 'Управляет тем, как экраны сессии организованы на телефонах.',
	        title: 'Режим кокпита',
	        subtitle: 'Выберите макет для телефона внутри сессий.',
	        options: {
	            cockpitTitle: 'Кокпит',
	            cockpitSubtitle: 'Использовать нижние вкладки для чата, файлов, Git, вкладок и терминала.',
	            classicTitle: 'Классический',
	            classicSubtitle: 'Использовать прежний макет экрана сессии.',
	        },
	    },
	    input: {
	        title: 'Внешний вид ввода',
	        footer: 'Настройте внешний вид панели ввода агента.',
	    },
        detailedBehavior: { title: 'Подробное поведение сессии', footer: 'Откройте отдельные страницы для ввода, лимитов провайдера, возобновления и терминала.' },
        rootGroups: {
            launchDefaults: { title: 'Настройки новой сессии по умолчанию', footer: 'Выберите, как начинаются новые сессии и какие варианты запоминаются.' },
            listOrganization: { title: 'Организация списка сессий', footer: 'Настройте порядок, группировку, разделы, неактивные сессии и стандартную панель на компьютере.' },
            rowDetails: { title: 'Детали строк сессий', footer: 'Выберите, какие метки и визуальные детали показываются в каждой строке сессии.' },
            activitySignals: { title: 'Сигналы активности и статуса', footer: 'Настройте, как выделяются активные, выполняющиеся и требующие внимания сессии.' },
            mobileLayout: { title: 'Мобильная компоновка сессии', footer: 'Выберите компоновку телефона, используемую внутри сессий.' },
            agentPersonalization: { title: 'Инструкции prompt для агента', footer: 'Настройте инструкции, которые просят агентов называть сессии и предлагать ответы.' },
        },
        composer: { title: 'Ввод и отправка', entrySubtitle: 'Отправка по Enter, история, внешний вид ввода и отправка, когда агент занят.' },
        providerLimits: { title: 'Лимиты и использование провайдера', entrySubtitle: 'Восстановление после лимитов и индикатор использования рядом с вводом.' },
        resume: { title: 'Возобновление и передача', entrySubtitle: 'Возобновление через повтор transcript и настройки переноса сессий между машинами.' },
        runtime: { title: 'Среда выполнения и терминал', entrySubtitle: 'Tmux, окна Windows Terminal и совместимость Terminal Connect.' },
    banners: {
        title: 'Баннеры',
        footer: 'Баннеры над полем ввода можно свернуть в значок состояния. Выберите, запоминать ли это.',
        rememberVisibilityTitle: 'Запоминать видимость баннеров',
        rememberVisibilitySubtitle: 'Закрытые баннеры остаются скрытыми во всех сессиях на этом устройстве.',
        resetHiddenTitle: 'Показать все скрытые баннеры',
        resetHiddenSubtitle: 'Очистить список баннеров, скрытых на этом устройстве.',
    },
    inputBehavior: {
        title: 'Поведение ввода',
        footer: 'Настройте отправку по Enter и поведение истории сообщений.',
        enterToSendEnabledNativeSubtitle: 'Нажмите Enter, чтобы отправить',
    },
    windows: {
        title: 'Windows',
        defaultModeTitle: 'Режим удалённой сессии Windows по умолчанию',
        windowNameTitle: 'Имя окна Windows Terminal',
        windowNamePlaceholder: 'happier',
        windowNameHint: 'Сессии, открытые в Windows Terminal, используют это именованное окно, чтобы новые сессии могли появляться как вкладки.',
    },
    advanced: {
        title: 'Дополнительно',
    },
    messageSending: {
      title: "Отправка сообщений",
      footer:
        "Определяет, что происходит при отправке сообщения, пока агент работает.",
        queueInAgentTitle: "В очередь агента (текущий)",
        queueInAgentSubtitle:
          "Записать в стенограмму сразу; агент обработает, когда будет готов.",
        interruptTitle: "Прервать и отправить",
        interruptSubtitle: "Прервать текущий ход, затем отправить немедленно.",
        pendingTitle: "Ожидание готовности",
        pendingSubtitle:
          "Сообщения ожидают в очереди; агент забирает, когда готов.",
        pendingDrainModeTitle: "Обработка очереди ожидания",
        pendingDrainModeFooter:
          "Выберите, забирает ли агент одно сообщение при каждой готовности или обрабатывает всю очередь ожидания сразу.",
        pendingDrainMode: {
          oneAtATimeTitle: "По одному сообщению",
          oneAtATimeSubtitle:
            "Обрабатывать только следующее ожидающее сообщение каждый раз, когда агент готов.",
          drainAllTitle: "Обработать всю очередь",
          drainAllSubtitle:
            "Обработать все сообщения в очереди вместе при следующей готовности (старое поведение).",
        },
        pendingDeliveryTimingTitle: "Время очереди ожидания",
        pendingDeliveryTimingFooter:
          "Выберите, когда уже ожидающие сообщения можно доставлять. Новые отправки по-прежнему следуют выбранному выше режиму отправки.",
        pendingDeliveryTiming: {
          afterForegroundReadyTitle: "После основного ответа",
          afterForegroundReadySubtitle:
            "Доставлять сообщения из очереди, когда основной ход готов, даже если фоновая работа продолжается.",
          afterRuntimeIdleTitle: "Когда вся активность простаивает",
          afterRuntimeIdleSubtitle:
            "Держать сообщения в очереди, пока основной ход не будет готов и фоновая активность не станет неактивной.",
        },
        busySteerPolicyTitle: "Когда агент занят (с поддержкой управления)",
        busySteerPolicyFooter:
          "Если агент поддерживает управление на лету, выберите, отправлять ли сообщения сразу или сначала в «Ожидание».",
        busySteerPolicy: {
          steerImmediatelyTitle: "Управлять сразу",
          steerImmediatelySubtitle:
            "Отправить сразу и направить текущий ход (без прерывания).",
          queueForReviewTitle: "В очередь «Ожидание»",
          queueForReviewSubtitle:
            "Сначала поместить в «Ожидание»; отправить позже через «Направить сейчас».",
        },
        nonSteerablePromptTitle: 'Когда сообщение нельзя направить в активный ход',
        nonSteerablePromptFooter: 'Смена режима разрешений и /clear или /compact не применяются в середине хода. Выберите, что Happier делает с такими сообщениями, пока агент занят.',
        nonSteerablePrompt: {
            onTitle: 'Спрашивать каждый раз',
            onSubtitle: 'Предлагать «Прервать и отправить сейчас» или «В очередь после хода».',
            offTitle: 'Выкл. (как раньше)',
            offSubtitle: 'Отправлять как раньше, даже если изменение не применится в середине хода.',
        },
      },
      usageLimitRecovery: {
        title: "Восстановление после лимита использования",
        autoWaitTitle: "Автоматически ждать и возобновлять",
        autoWaitEnabledSubtitle: "Сеансы с лимитом использования могут ждать сброса и возобновляться автоматически.",
        autoWaitDisabledSubtitle: "Спрашивать перед ожиданием сброса лимита использования.",
        resumePromptTitle: "Промпт возобновления",
        resumePromptStandardTitle: "Стандартный",
        resumePromptStandardSubtitle: "Отправлять обычный промпт продолжения, когда восстановление возобновляет сеанс.",
        resumePromptOffTitle: "Выключено",
        resumePromptOffSubtitle: "Возобновлять без дополнительного промпта продолжения.",
        resumePromptCustomTitle: "Отправлять свой промпт",
        resumePromptCustomSubtitle: "После восстановления отправлять собственный промпт продолжения.",
        customResumePromptTitle: "Свой промпт продолжения",
        customResumePromptPlaceholder: "Продолжай с того места, где остановился.",
      },
      providerUsageGauge: {
        title: "Использование провайдера",
        footer:
          "Управляет индикатором квоты рядом с полем ввода, когда доступны надёжные данные использования провайдера.",
        visibilityTitle: "Показывать индикатор использования провайдера",
        visibilityEnabledSubtitle:
          "Показывать оставшуюся квоту провайдера рядом с полем ввода, когда она доступна.",
        visibilityHiddenSubtitle: "Скрыть квоту провайдера рядом с полем ввода.",
        windowTitle: "Окно индикатора",
        windowMostConstrainedTitle: "Самое ограниченное",
        windowMostConstrainedSubtitle:
          "Показывать надёжное окно квоты с наименьшим остатком.",
        windowDailyTitle: "Дневное",
        windowDailySubtitle: "Предпочитать дневное окно квоты.",
        windowWeeklyTitle: "Недельное",
        windowWeeklySubtitle: "Предпочитать недельное окно квоты.",
        windowSessionTitle: "Сессия",
        windowSessionSubtitle: "Предпочитать окно квоты текущей сессии.",
        windowPrimaryTitle: "Основное",
        windowPrimarySubtitle: "Предпочитать основное окно квоты провайдера.",
        windowSecondaryTitle: "Дополнительное",
        windowSecondarySubtitle: "Предпочитать дополнительное окно квоты провайдера.",
      },
      thinking: {
        title: "Размышления",
        footer:
          "Определяет, как сообщения размышлений агента отображаются в стенограмме сессии.",
          displayModeTitle: "Отображение размышлений",
          displayMode: {
            inlineSummaryTitle: "Встроенное (сводка)",
            inlineSummarySubtitle: "Показывать однострочную сводку; нажмите, чтобы раскрыть.",
            inlineTitle: "Встроенное (полностью)",
            inlineSubtitle: "Показывать полный текст размышлений прямо в стенограмме.",
            toolTitle: "Карточка инструмента",
            toolSubtitle: "Показывать размышления как карточку инструмента «Рассуждение».",
            hiddenTitle: "Скрытое",
            hiddenSubtitle: "Скрывать размышления из стенограммы.",
          },
              inlineChromeTitle: "Карточки размышлений",
              inlineChromeSubtitle: "Показывать встроенные размышления с лёгким фоном карточки.",
        },
      toolRendering: {
        title: "Отображение инструментов",
          footer:
            "Определяет, сколько деталей инструментов показывается на шкале времени сессии. Это настройка интерфейса, не влияет на поведение агента.",
          defaultToolDetailLevelTitle: "Уровень детализации по умолчанию",
          expandedToolDetailLevelTitle: "Уровень деталей при раскрытии",
          cardTapActionTitle: "Действие по нажатию",
          timelineChrome: {
            title: "Стиль инструментов в таймлайне",
            cardsTitle: "Карточки",
          cardsSubtitle:
            "Карточки инструментов с содержимым внутри (в зависимости от уровня детализации).",
          activityFeedTitle: "Лента инструментов",
          activityFeedSubtitle:
            "Компактные строки, оптимизированные для высокой плотности инструментов.",
        },
        cardDensity: {
          title: "Плотность карточек",
          comfortableTitle: "Комфортно",
          comfortableSubtitle: "Больше отступов и более чёткое разделение.",
          compactTitle: "Компактно",
          compactSubtitle: "Более плотные заголовки и меньше отступов.",
        },
        activityFeed: {
          defaultDetailTitle: "Детали по умолчанию (лента инструментов)",
          expandedDetailTitle: "Детали при раскрытии (лента инструментов)",
          tapActionTitle: "Действие по нажатию (лента инструментов)",
          tapAction: {
            expandTitle: "Раскрыть",
            expandSubtitle: "Нажатие раскрывает или сворачивает детали внутри.",
            openTitle: "Открыть",
            openSubtitle: "Нажатие открывает экран полного просмотра инструмента.",
          },
          defaultExpandedTitle: "Раскрывать по умолчанию",
          defaultExpandedSubtitle:
            "Раскрывать строки инструментов по умолчанию в ленте инструментов.",
        },
        localControlDefaultTitle: "По умолчанию для локального управления",
        showDebugByDefaultTitle: "Показывать отладку по умолчанию",
        showDebugByDefaultSubtitle:
          "Авторазворот исходных данных инструмента в полном просмотре.",
      },
      transcript: {
        title: "Стенограмма",
        entrySubtitle: "Открыть настройки стенограммы",
        footer:
          "Настройте отображение чатов и поведение стенограммы.",
        codeDiffs: 'Код и diff',
        codeDiffsFooter: 'Настройте отображение кода и diff в стенограмме.',
        layoutTitle: "Макет",
        layoutFooter:
          "Выберите между простой линейной стенограммой и группировкой по ходам.",
        layoutPickerTitle: "Макет стенограммы",
        messageTimestampsTitle: "Показывать время и дату под сообщениями",
        messageTimestampsSubtitle:
          "Показывать отметку времени каждого сообщения пользователя и ассистента под сообщением.",
        messageTimestamps: {
          hoverWebHiddenMobileTitle: "При наведении в вебе, скрыто на мобильных",
          hoverWebHiddenMobileSubtitle:
            "Показывать метки времени вместе с действиями сообщения в вебе и скрывать их на мобильных.",
          hoverWebAlwaysMobileTitle: "При наведении в вебе, всегда на мобильных",
          hoverWebAlwaysMobileSubtitle:
            "Показывать метки времени вместе с действиями сообщения в вебе и всегда показывать их на мобильных.",
          alwaysTitle: "Всегда показывать",
          alwaysSubtitle: "Всегда показывать метки времени под сообщениями стенограммы.",
          neverTitle: "Никогда",
          neverSubtitle: "Скрывать метки времени под сообщениями стенограммы.",
        },
        messageActions: {
          groupTitle: 'Действия с сообщениями',
          groupFooter: 'Настройте выбор сообщений и действия пересылки в стенограмме.',
          selectionEnabled: {
            title: 'Включить выбор сообщений',
            subtitle: 'Показывать значок выбора под сообщениями, чтобы копировать или пересылать их массово',
          },
          sendToSessionEnabled: {
            title: 'Включить отправку в сессию',
            subtitle: 'Показывать массовое действие отправки, которое добавляет выбранные сообщения в черновик другой сессии',
          },
          template: {
            title: 'Шаблон отправки в сессию',
            subtitle: 'Используйте {{MESSAGES}}, {{SELECTED_COUNT}} и {{SOURCE_SESSION_NAME}} как заполнители',
            placeholder: '{{MESSAGES}}',
            warningMissingPlaceholder: 'Совет: добавьте {{MESSAGES}}, чтобы задать место для выбранных сообщений',
          },
          bulkCopyFormat: {
            title: 'Формат копирования',
            subtitle: 'Как форматировать скопированные сообщения',
            markdownLabeled: 'Markdown с метками ролей (рекомендуется)',
            plain: 'Обычный текст',
          },
        },
        layout: {
          linearTitle: "Линейный",
          linearSubtitle: "Показывать сообщения как плоский список.",
          turnsTitle: "Ходы",
          turnsSubtitle: "Группировать сообщения в ходы пользователь/ассистент.",
        },
        toolCallsGroupTitle: "Группировать вызовы инструментов",
        toolCallsGroupSubtitle:
          "Компактно группировать вызовы инструментов в секцию «Вызовы инструментов» внутри каждого хода.",
        toolCallsGroupBackgroundTitle: "Фон групп вызовов",
        toolCallsGroupBackgroundSubtitle:
          "Показывать фон за группами вызовов в режиме ленты инструментов.",
        toolAppearanceTitle: "Вид инструментов",
        toolAppearanceSubtitle:
          "Настройте, как инструменты выглядят в стенограмме.",
        motionTitle: "Анимации",
        motionFooter: "Управляйте анимациями в стенограмме.",
        motionPickerTitle: "Анимации",
        motion: {
          offTitle: "Выключено",
          offSubtitle: "Отключить анимации стенограммы.",
          subtleTitle: "Ненавязчиво (по умолчанию)",
          subtleSubtitle: "Быстрая минимальная анимация для новой активности.",
          fullTitle: "Полно",
          fullSubtitle: "Более выразительные анимации и переходы.",
        },
        advancedMotionTitle: "Расширенные анимации…",
        advancedMotionSubtitle:
          "Настройте окно свежести и переключатели анимаций.",
        scrollTitle: "Прокрутка",
        scrollFooter:
          "Управляйте закреплением снизу и кнопкой перехода к низу.",
        scrollPinTitle: "Закрепить внизу",
          scrollPinSubtitle:
            "Следовать за новыми сообщениями, когда вы внизу.",
          jumpToBottomTitle: "Перейти вниз",
          jumpToBottomButtonLabel: "К низу",
          jumpToBottomButtonNewActivityLabel: ({ count }: { count: number }) => `Новая активность: ${count}. К низу`,
          jumpToBottomSubtitle:
            "Показывать кнопку, когда вы прокрутили вверх и пришла новая активность.",
            advancedScrollTitle: "Расширенная прокрутка…",
          advancedScrollSubtitle: "Настройте пороги и счётчики.",
          advancedTitle: "Расширенные…",
          advancedSubtitle: "Настройки производительности и отладки.",
          advanced: {
            turnGroupingTitle: "Группировка ходов",
            turnGroupingFooter:
            "Определяет, как формируются группы вызовов инструментов внутри ходов.",
            performanceTitle: "Производительность",
            performanceFooter: "Настройки производительности для стриминга и списка.",
            coalesceEnabledTitle: "Объединять обновления стриминга",
            coalesceEnabledSubtitle:
              "Объединять обновления сокета, чтобы прокрутка оставалась плавной.",
            coalesceWindowTitle: "Окно объединения",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `Текущее: ${value}ms`,
            coalesceWindowPromptTitle: "Окно объединения (ms)",
            coalesceWindowPromptBody:
              "Установите, как часто буферизированные обновления стриминга применяются к стору.",
            coalesceMaxBatchTitle: "Макс. размер пакета",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `Текущее: ${value}`,
            coalesceMaxBatchPromptTitle: "Макс. размер пакета",
            coalesceMaxBatchPromptBody:
              "Установите верхний предел сообщений, применяемых за один flush.",
            streamingPartialOutputTitle: "Показывать частичный вывод при стриминге",
            streamingPartialOutputSubtitle:
              "Если выключено, сообщения ассистента появятся только после завершения.",
            thinkingPulseStaleTitle: "Окно устаревания размышления",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Текущее: ${value}ms`,
            thinkingPulseStalePromptTitle: "Окно устаревания размышления (ms)",
            thinkingPulseStalePromptBody:
              "Скрывать активное размышление после этого времени без обновлений.",
          toolCallsStrategyTitle: "Стратегия группировки вызовов",
          toolCallsStrategy: {
            consecutiveTitle: "Последовательные инструменты (по умолчанию)",
            consecutiveSubtitle:
              "Группировать в «Вызовы инструментов» только последовательные вызовы инструментов.",
            allToolsTitle: "Все инструменты в ходе",
            allToolsSubtitle:
              "Группировать все вызовы инструментов в ходе в одну секцию «Вызовы инструментов».",
          },
            toolCallsCollapsedPreviewCountTitle: "Предпросмотр (свернуто)",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Показывать последние ${value} инструмент(а/ов), когда «Вызовы инструментов» свернуты.`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "Выключено",
              offSubtitle: "Показывать только заголовок «Вызовы инструментов».",
              oneTitle: "1 инструмент",
              oneSubtitle: "Показывать самый последний инструмент в виде строки предпросмотра.",
              twoTitle: "2 инструмента",
              twoSubtitle: "Показывать 2 последних инструмента в виде строк предпросмотра.",
              threeTitle: "3 инструмента",
              threeSubtitle: "Показывать 3 последних инструмента в виде строк предпросмотра.",
              countTitle: ({ value }: { value: string }) => `${value} инструментов`,
              countSubtitle: ({ value }: { value: string }) =>
                `Показывать ${value} последних инструментов в виде строк предпросмотра.`,
            },
          motionTitle: "Анимации (расшир.)",
          motionFooter:
            "Анимации ограничены окном свежести, чтобы история оставалась стабильной.",
          freshnessTitle: "Окно свежести",
          freshnessSubtitle: ({ value }: { value: string }) => `Текущее: ${value}ms`,
          freshnessPromptTitle: "Окно свежести (ms)",
          freshnessPromptBody:
            "Установите, как долго новые элементы считаются «свежими» для анимаций.",
          animateNewItemsTitle: "Анимировать новые элементы",
          animateNewItemsSubtitle:
            "Анимировать новые потоковые сообщения и инструменты.",
          animateToolExpandCollapseTitle:
            "Анимировать раскрытие/сворачивание инструмента",
          animateToolExpandCollapseSubtitle:
            "Анимировать переходы раскрытия/сворачивания внутри.",
          animateToolExpandCollapseFreshOnlyTitle:
            "Раскрытие/сворачивание только для свежих",
          animateToolExpandCollapseFreshOnlySubtitle:
            "Анимировать раскрытие/сворачивание только для свежих инструментов.",
          animateThinkingTitle: "Анимировать размышления",
          animateThinkingSubtitle:
            "Анимировать потоковые сообщения размышления, когда они видимы.",
          scrollTitle: "Прокрутка (расшир.)",
          scrollFooter:
            "Настройте пороги закрепления и поведение перехода вниз.",
          pinOffsetTitle: "Порог смещения закрепления",
          pinOffsetSubtitle: ({ value }: { value: string }) => `Текущее: ${value}px`,
          pinOffsetPromptTitle: "Порог смещения закрепления (px)",
          pinOffsetPromptBody:
            "Установите, насколько далеко от низа считается закреплённым.",
          autoFollowTitle: "Автоследование при закреплении",
          autoFollowSubtitle:
            "Когда закреплено, автоматически следовать за новой активностью.",
          jumpMinNewCountTitle: "Минимум новых для кнопки",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `Текущее: ${value}`,
          jumpMinNewCountPromptTitle: "Минимум новых (кнопка)",
          jumpMinNewCountPromptBody:
            "Показывать кнопку только после этого количества новых элементов.",
          jumpAnimateScrollTitle: "Анимировать переход вниз",
          jumpAnimateScrollSubtitle:
            "Анимировать прокрутку при переходе вниз.",
        },
      },
        toolDetailOverrides: {
          title: "Переопределения детализации инструментов",
          entrySubtitle: "Переопределить отдельные инструменты",
          footer:
            "Переопределить уровень детализации для конкретных инструментов. Применяется к каноническому имени инструмента (V2) после нормализации.",
          expandedTitle: "Переопределения раскрытого вида",
          expandedFooter: "Переопределить уровень детализации при раскрытии для конкретных инструментов.",
        },
      permissions: {
        title: "Разрешения",
        entrySubtitle: "Открыть настройки разрешений",
        footer:
          "Настройте разрешения по умолчанию и порядок применения изменений к запущенным сессиям.",
        promptSurfaceTitle: "Запросы разрешений",
        promptSurfaceFooter:
          "Выберите, где во время сессии показывать запросы на подтверждение.",
        applyChangesFooter:
          "Выберите, когда изменения разрешений вступают в силу для запущенных сессий.",
        backendFooter:
          "Задайте режим разрешений по умолчанию при запуске сессий с этим бэкендом.",
        defaultPermissionModeTitle: "Режим разрешений по умолчанию",
        promptSurface: {
          composerTitle: "Рядом с вводом (рекомендуется)",
          composerSubtitle: "Показывать подробные карточки разрешений рядом с вводом.",
          transcriptTitle: "В стенограмме",
          transcriptSubtitle: "Показывать запросы разрешений внутри сообщений инструментов.",
          bothTitle: "Оба",
          bothSubtitle: "Показывать рядом с вводом и внутри стенограммы.",
        },
        applyTiming: {
          immediateTitle: "Применить немедленно",
          nextPromptTitle: "Применить при следующем сообщении",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "Открыть настройки суб-агента",
      },
      handoff: settingsSessionHandoffTranslationExtensions.ru,
      sessionCreation: {
        title: "Модальное окно новой сессии",
        footer: "Выберите, как открывается модальное окно новой сессии и как быстрые действия проекта заполняют его.",
        modalModeTitle: "Режим модального окна новой сессии",
        modalModeSimpleTitle: "Простой",
        modalModeSimpleSubtitle: "Открывает компактное окно с фокусом на поле ввода.",
        modalModeWizardTitle: "Мастер",
        modalModeWizardSubtitle: "Открывает пошаговую настройку с отдельными селекторами.",
        presentationGroupTitle: "Поверхность новой сессии",
        presentationGroupFooter: "Выберите, открывается ли Новая сессия как экран маршрута или как модальное окно.",
        presentationModeTitle: "Представление новой сессии",
        presentationModeSubtitle: "Управляет маршрутом, который используется при открытии Новой сессии.",
        presentationAutoTitle: "Авто",
        presentationAutoSubtitle: "Использует представление в модальном окне по умолчанию на каждой платформе.",
        presentationScreenTitle: "Экран",
        presentationScreenSubtitle: "Открывает Новую сессию в основной области с композитором, закрепленным снизу.",
        presentationModalTitle: "Модальное окно",
        presentationModalSubtitle: "Открывает Новую сессию поверх текущей рабочей области как закрываемое модальное окно.",
        wizardModeTitle: "Режим мастера",
        wizardModeEnabledSubtitle: "Открывает пошаговую настройку с отдельными селекторами.",
        wizardModeDisabledSubtitle: "Использует компактное окно с фокусом на поле ввода.",
        rememberLastProjectSelectionsTitle: "Запоминать последние выборы сессии проекта",
        rememberLastProjectSelectionsEnabledSubtitle:
          "Быстрые действия проекта повторно используют машину, папку, движок, модель и параметры самой новой сессии.",
        rememberLastProjectSelectionsDisabledSubtitle:
          "Быстрые действия проекта только предварительно выбирают машину и папку проекта.",
        rememberLastEngineSelectionsTitle: "Запоминать последнюю модель и параметры для каждого движка",
        rememberLastEngineSelectionsEnabledSubtitle:
          "Новые сессии восстанавливают последнюю модель, режим и параметры движка, выбранные в этом аккаунте.",
        rememberLastEngineSelectionsDisabledSubtitle:
          "Новые сессии используют значения по умолчанию, если ярлык проекта или черновик не задает настройку.",
        wizardSettingsTitle: "Мастер новой сессии",
        wizardSettingsSubtitle: "Выберите, показывать каждый селектор мастера списком или выпадающим меню.",
        wizardDispositionTitle: "Расположение мастера",
        wizardDispositionSubtitle: "Выберите, какие селекторы мастера показывать списками или выпадающими меню.",
        wizardLayoutTitle: "Макет мастера",
        wizardLayoutFooter: "Управляет расположением разделов мастера на широких экранах.",
        wizardColumnsTitle: "Макет в две колонки",
        wizardColumnsEnabledSubtitle: "Размещает связанные селекторы рядом на широких экранах.",
        wizardColumnsDisabledSubtitle: "Размещает все селекторы мастера в одной колонке.",
        wizardPresentationTitle: "Макет селекторов мастера",
        wizardPresentationFooter:
          "Auto оставляет короткие разделы списками и переключает длинные разделы на выпадающие меню с поиском.",
        wizardPresentationAutoTitle: "Auto",
        wizardPresentationAutoSubtitle:
          "Позвольте Happier выбрать лучший макет для объема содержимого.",
        wizardPresentationListTitle: "Список",
        wizardPresentationListSubtitle: "Показывать все строки прямо в мастере.",
        wizardPresentationDropdownTitle: "Выпадающее меню",
        wizardPresentationDropdownSubtitle: "Показывать компактную строку, открывающую полный селектор.",
      },
          promptPersonalization: {
              title: 'Prompt personalization',
              footer: 'Choose which built-in instructions Happier adds to new agent sessions. This does not hide options an agent already sends.',
              askAgentToRenameSessionsTitle: 'Session title updates',
              askAgentToRenameSessionsNeverTitle: 'Never',
              askAgentToRenameSessionsNeverSubtitle: 'Do not prompt agents to set session titles.',
              askAgentToRenameSessionsInitialTitle: 'At session start',
              askAgentToRenameSessionsInitialSubtitle: 'Prompt agents to set a short title from the first user message.',
              askAgentToRenameSessionsOngoingTitle: 'When the task changes',
              askAgentToRenameSessionsOngoingSubtitle: 'Prompt agents to set titles at session start and when the task changes.',
              askAgentToRenameSessionsInitialSelectedSubtitle: 'Agents are prompted to set a title at session start.',
              askAgentToRenameSessionsOngoingSelectedSubtitle: 'Agents are prompted to update titles when the task changes.',
              askAgentToRenameSessionsDisabledSubtitle: 'Agents are not prompted to set titles; manual renaming still works.',
              askAgentToSuggestReplyOptionsTitle: 'Ask the agent to suggest reply options',
              askAgentToSuggestReplyOptionsEnabledSubtitle: 'The prompt asks agents to propose quick reply options when useful.',
              askAgentToSuggestReplyOptionsDisabledSubtitle: 'The prompt does not ask agents to add quick reply options.',
          },
      defaultPermissions: {
        title: "Разрешения по умолчанию",
        footer:
          "Применяются при запуске новой сессии. Профили могут переопределять.",
        applyPermissionChangesTitle: "Применение изменений разрешений",
        applyPermissionChangesImmediateSubtitle:
          "Применить немедленно для запущенных сессий (обновление метаданных сессии).",
        applyPermissionChangesNextPromptSubtitle: "Применить только при следующем сообщении.",
      },
          defaultStorage: {
              title: "Тип сеанса по умолчанию",
              footer: "Выберите, будут ли новые сеансы начинаться как сеансы Happier или как прямые сеансы, поддерживаемые провайдером.",
              globalTitle: "Глобальное значение по умолчанию",
              persistedSubtitle: "Сохраняйте новые сеансы в Happier и синхронизируйте их между устройствами по умолчанию.",
              directSubtitle: "Запускайте прямые сеансы с привязкой к компьютеру, если поставщик поддерживает это.",
              globalSubtitle: ({ label }: { label: string }) => `Global default: ${label}`,
              useGlobalDefault: "Использовать глобальное значение по умолчанию",
              currently: ({ label }: { label: string }) => `Currently: ${label}`,
          },
      replayResume: {
        title: "Воспроизведение для возобновления",
        footer:
          "Когда возобновление провайдера недоступно, можно воспроизвести недавние сообщения стенограммы в новой сессии как контекст.",
        enabledTitle: "Включить воспроизведение для возобновления",
        enabledSubtitleOn:
          "Предлагать возобновление через воспроизведение, когда возобновление провайдера недоступно.",
        enabledSubtitleOff: "Не предлагать возобновление через воспроизведение.",
        strategyTitle: "Стратегия воспроизведения",
        strategy: {
          recentTitle: "Недавние сообщения",
          recentSubtitle: "Использовать только последние сообщения стенограммы.",
          summaryRecentTitle: "Сводка + недавние (экспериментально)",
          summaryRecentSubtitle:
            "Включить краткую сводку и недавние сообщения (по возможности).",
        },
        summaryRunner: {
          title: "Генератор сводок (по запросу)",
          backendTitle: "Бэкенд",
          backendPlaceholder: "claude (пример)",
          searchBackendsPlaceholder: "Поиск бэкендов…",
          modelTitle: "Модель (LLM)",
          modelPlaceholder: "default (пример)",
          searchModelsPlaceholder: "Поиск моделей…",
          notSet: "Не задано",
          customTitle: "Пользовательский",
          customBackendIdSubtitle: "Введите id бэкенда (напр. claude).",
          customModelIdSubtitle: "Введите id модели (напр. default).",
        },
        recentMessagesTitle: "Количество недавних сообщений",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Лимит seed (символы)",
        maxSeedCharsPlaceholder: "50000",
      },
      toolDetailLevel: {
        titleOnlyTitle: "Только заголовок",
        titleOnlySubtitle: "Показывать только название инструмента на шкале времени (без подзаголовка, без тела).",
        compactTitle: "Компактно",
        compactSubtitle: "Показывать название инструмента + короткий подзаголовок в одной строке (без тела).",
        summaryTitle: "Сводка",
        summarySubtitle: "Показывать компактную, безопасную сводку на шкале времени.",
        fullTitle: "Полное",
        fullSubtitle: "Показывать полные детали прямо на шкале времени.",
        defaultTitle: "По умолчанию",
        defaultSubtitle: "Использовать глобальную настройку по умолчанию.",
          styleDefaultTitle: "По умолчанию (рекомендуется)",
          styleDefaultSubtitle: "Карточки: Сводка. Лента инструментов: Компактно.",
          expandedStyleDefaultTitle: "По умолчанию (рекомендуется)",
          expandedStyleDefaultSubtitle: "Карточки: Полное. Лента инструментов: Сводка.",
      },
      terminalConnect: {
        title: "Подключение терминала",
        legacySecretExportTitle: "Экспорт устаревшего секрета (совместимость)",
        legacySecretExportEnabledSubtitle:
          "Включено: экспортирует устаревший секрет аккаунта в терминал для подключения старых терминалов. Не рекомендуется.",
        legacySecretExportDisabledSubtitle:
          "Отключено (рекомендуется): использовать только ключ контента для терминалов (Terminal Connect V2).",
      },
  },
  windowsRemoteSessionLaunchMode: {
    hidden: "Скрытый",
    shortHidden: "Скрытый",
    hiddenSubtitle: "Запускает сессию в фоне без открытия окна терминала.",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "Открывает сессию как вкладку в общем окне Windows Terminal.",
    console: "Консоль",
    shortConsole: "Консоль",
    consoleSubtitle: "Открывает сессию в стандартном окне консоли Windows.",
  },
  settingsVoice: {
    history: {
      title: 'История голоса',
      sectionTitle: 'История',
      sectionFooter: 'Просматривайте или удаляйте расшифровки глобальных и автономных голосовых разговоров.',
      entryTitle: 'История голоса',
      entrySubtitle: 'Ищите, экспортируйте или очищайте сохранённые голосовые расшифровки.',
      searchTitle: 'Поиск в загруженной истории',
      searchFooter: 'Поиск выполняется по голосовым сообщениям, уже расшифрованным на этом устройстве.',
      searchPlaceholder: 'Поиск расшифровок или провайдеров',
      searchAccessibilityLabel: 'Поиск в истории голоса',
      actionsTitle: 'Действия с историей',
      loading: 'Загрузка истории голоса…',
      emptyTitle: 'Истории голоса пока нет',
      emptyBody: 'Расшифровки автономного и глобального голоса появятся здесь после сохранения.',
      noResultsTitle: 'В загруженной истории нет совпадений',
      noResultsBody: 'Попробуйте другой запрос или загрузите более старые сообщения.',
      loadOlderTitle: 'Загрузить старые сообщения',
      loadOlderSubtitle: 'Расшифровать предыдущую страницу истории голоса на этом устройстве.',
      loadOlderFooter: 'Старые сообщения остаются на сервере, пока вы их не загрузите или не очистите.',
      loadingOlder: 'Загрузка старых сообщений…',
      loadOlderFailed: 'Не удалось загрузить старую историю голоса.',
      exportTitle: 'Экспортировать историю голоса',
      exportSubtitle: 'Загрузить оставшуюся ограниченную историю и сохранить её в JSON.',
      exporting: 'Подготовка экспорта…',
      exportSucceeded: 'Экспорт истории голоса готов.',
      exportFailed: 'Не удалось экспортировать историю голоса.',
      clearTitle: 'Очистить историю голоса',
      clearSubtitle: 'Удалить всю автономную историю голоса для этой учётной записи.',
      clearing: 'Очистка истории голоса…',
      clearConfirmTitle: 'Очистить историю голоса?',
      clearConfirmBody: 'Вся автономная история голоса для этой учётной записи будет удалена без возможности восстановления.',
      clearConfirmAction: 'Очистить историю',
      clearSucceeded: 'История голоса очищена.',
      clearActiveCall: 'Завершите голосовой сеанс перед очисткой истории голоса.',
      clearFailed: 'Не удалось очистить историю голоса.',
      errorTitle: 'История голоса недоступна',
      errorBody: 'Happier не удалось загрузить зашифрованную историю этой учётной записи. Проверьте подключение и повторите попытку.',
      supersededTitle: 'Активная учётная запись изменилась',
      supersededBody: 'Запрос был остановлен до того, как смог использовать другую учётную запись. Перезагрузите страницу для безопасного продолжения.',
      retry: 'Повторить',
      roleYou: 'Вы',
      roleAssistant: 'Ассистент',
    },
    dictation: {
      title: 'Диктовка',
      footer: 'Выберите поставщика распознавания речи для микрофона редактора. Эта настройка не зависит от разговорного Голоса, если вы явно их не свяжете.',
      provider: 'Поставщик распознавания речи',
      providerSubtitle: 'Выберите отдельного поставщика для Диктовки или явно используйте настройки локального Голоса.',
      sameAsLocal: 'Как у локального Голоса',
      sameAsLocalSubtitle: 'Явно использовать выбор распознавания речи из локального Голоса.',
      language: 'Язык диктовки',
      languageSubtitle: 'Необязательная подсказка языка, используемая только для Диктовки.',
      readiness: {
        title: 'Готовность диктовки',
        footer: 'Проверка только читает сохранённые настройки и текущее состояние машины и модели. Она не включает микрофон, не отправляет аудио и не обращается к поставщику.',
        check: 'Проверить настройку',
        checkSubtitle: 'Пассивно проверить выбранную конфигурацию Диктовки.',
        result: 'Состояние настройки',
        ready: 'Диктовка готова.',
        needsSetup: 'Настройка не завершена. Проверьте параметры выбранного поставщика.',
        installing: 'Необходимая речевая модель ещё устанавливается.',
        incompatible: 'Выбранный поставщик несовместим с этой платформой или конфигурацией.',
        unavailable: 'Не удалось подтвердить готовность по текущим локальным данным.',
      },
    },
    setupCheck: {
      title: 'Готовность поставщика',
      footer: 'Проверка только читает сохранённые настройки и текущие локальные данные готовности. Она не включает микрофон, не запускает Голос, не отправляет аудио и не обращается к поставщику.',
      check: 'Проверить настройку',
      checkSubtitle: 'Пассивно проверить конфигурацию выбранного поставщика Голоса.',
      result: 'Состояние настройки',
    },
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
    realtimeProviders: {
      ...voiceProviderPrivacyTranslations.ru,
      codex: {
        sectionTitle: "Аккаунт Codex Live",
        accountTitle: "Глобальный голосовой аккаунт",
        accountSubtitle: "Выберите конкретный аккаунт или группу аккаунтов Подключённых сервисов для глобального Codex Voice. Прямой голосовой режим всегда использует открытую сессию.",
        privacyDisclosure: "Аудио и разговор Codex Live отправляются с этого устройства в OpenAI через WebRTC. Выбранная сессия Codex и учётная запись Connected Services работают через выбранную машину. OpenAI может получать ограниченный контекст запуска и сессии и делегированные результаты Codex, чтобы разговор мог продолжаться, а ответы — озвучиваться. Сервер и relay Happier не передают аудио Codex Live; daemon/app-server Happier по-прежнему обеспечивает сигнализацию, жизненный цикл сессии, делегирование, инструменты и управление разрешениями. В передаче могут участвовать сетевые relay-серверы провайдера. Codex или OpenAI могут хранить инструкции разработчика, материалы разговора в реальном времени и связанные диагностические данные в собственном хранилище среды выполнения согласно политикам выбранной учётной записи и провайдера; Happier не удаляет и не переписывает эти данные провайдера.",
      },
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
	      agentReuseDialog: {
	        title: "Агент Happier уже существует",
	        messageWithId: ({ name, id }: { name: string; id: string }) =>
	          `Мы нашли существующего агента ElevenLabs («${name}», id: ${id}).\n\nХотите обновить его или создать нового?`,
	        messageNoId: ({ name }: { name: string }) =>
	          `Мы нашли существующего агента ElevenLabs («${name}»).\n\nХотите обновить его или создать нового?`,
	        actions: {
	          createNew: "Создать новый",
	          updateExisting: "Обновить существующий",
	        },
	      },
      configured:
        "Настроено. Использование голоса будет списываться с вашего аккаунта ElevenLabs.",
      notConfigured:
        "Введите API-ключ ElevenLabs и ID агента, чтобы использовать голос без подписки.",
      createAccount: "Создать аккаунт ElevenLabs",
      createAccountSubtitle:
        "Зарегистрируйтесь (или войдите), прежде чем создавать API-ключ",
      openApiKeys: "Открыть API-ключи ElevenLabs",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "Как создать API-ключ",
      apiKeyHelpSubtitle:
        "Пошаговая инструкция по созданию и копированию API-ключа ElevenLabs",
      apiKeyHelpDialogTitle: "Создание API-ключа ElevenLabs",
      apiKeyHelpDialogBody:
        "Откройте ElevenLabs → Developers → API Keys → Create API key → скопируйте ключ.",
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
      apiKeyPlaceholder: "xi-api-ключ",
      voiceSearchPlaceholder: "Поиск голосов",
      speakerBoostTitle: "Усиление голоса",
      speakerBoostSubtitle: "Улучшить чёткость и присутствие (необязательно).",
      speakerBoostAuto: "Авто",
      speakerBoostAutoSubtitle: "Использовать настройку ElevenLabs по умолчанию.",
      speakerBoostOn: "Вкл",
      speakerBoostOnSubtitle: "Принудительно включить усиление голоса.",
      speakerBoostOff: "Выкл",
      speakerBoostOffSubtitle: "Принудительно отключить усиление голоса.",
      voiceGroupTitle: "Голос",
      voiceGroupFooter:
        "Выберите, как говорит ваш агент ElevenLabs. Изменения применяются при обновлении агента.",
      provisioningGroupTitle: "Подготовка агента",
      provisioningGroupFooter:
        "Если вы меняете голос/настройки, нажмите «Обновить агента» для применения в ElevenLabs.",
      realtime: {
        call: {
          title: "Звонок",
          welcome: {
            title: "Приветствие",
            subtitle: "Необязательное приветствие в начале звонка.",
            detail: {
              off: "Выкл.",
              immediate: "Сразу",
              onFirstTurn: "На первом обращении",
            },
            options: {
              offSubtitle: "Без приветствия.",
              immediateSubtitle:
                "Приветствовать сразу после подключения звонка.",
              onFirstTurnSubtitle:
                "Приветствовать в начале первого ответа.",
            },
          },
        },
        voicePicker: {
          title: "Голос",
          subtitle: "Выберите голос ElevenLabs для ответов.",
          missingApiKeyTitle: "Добавьте API-ключ, чтобы загрузить голоса",
          loadingTitle: "Загрузка голосов…",
          errorTitle: "Не удалось загрузить голоса",
          errorSubtitle: "Проверьте API-ключ и попробуйте снова.",
        },
        modelPicker: {
          title: "Модель",
          subtitle:
            "Необязательно: переопределить id модели TTS ElevenLabs.",
          detailAuto: "Авто",
          options: {
            autoTitle: "Авто",
            autoSubtitle: "Использовать модель ElevenLabs по умолчанию.",
            multilingualV2Subtitle: "Частый выбор по умолчанию (мультиязычная).",
            turboV2Subtitle:
              "Меньше задержка (если доступно в вашем тарифе).",
            turboV25Subtitle: "Turbo 2.5 (если доступно).",
            customTitle: "Своя…",
            customSubtitle: "Введите id модели.",
          },
          prompt: {
            title: "ID модели",
            body: "Введите id модели ElevenLabs или оставьте пустым, чтобы использовать по умолчанию.",
          },
        },
        voiceSettings: {
          default: "По умолчанию",
          stability: {
            title: "Стабильность",
            subtitle: "0–1. Пусто = по умолчанию.",
            promptTitle: "Стабильность (0–1)",
            promptBody:
              "Введите число от 0 до 1. Оставьте пустым, чтобы использовать по умолчанию.",
            invalid: "Введите число от 0 до 1.",
          },
          similarityBoost: {
            title: "Усиление сходства",
            subtitle: "0–1. Пусто = по умолчанию.",
            promptTitle: "Усиление сходства (0–1)",
            promptBody:
              "Введите число от 0 до 1. Оставьте пустым, чтобы использовать по умолчанию.",
            invalid: "Введите число от 0 до 1.",
          },
          style: {
            title: "Стиль",
            subtitle: "0–1. Пусто = по умолчанию.",
            promptTitle: "Стиль (0–1)",
            promptBody:
              "Введите число от 0 до 1. Оставьте пустым, чтобы использовать по умолчанию.",
            invalid: "Введите число от 0 до 1.",
          },
          speed: {
            title: "Скорость",
            subtitle: "0.5–2. Пусто = по умолчанию.",
            promptTitle: "Скорость (0.5–2)",
            promptBody:
              "Введите число от 0.5 до 2. Оставьте пустым, чтобы использовать по умолчанию.",
            invalid: "Введите число от 0.5 до 2.",
          },
        },
        getStartedTitle: "Начать",
      },
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
    externalCredentials: {
      apiKeyTitle: "Ключ API",
      promptTitle: "Подключить этого голосового провайдера",
      promptDescription: "Вставьте ключ API провайдера. Он будет сохранён в вашей учётной записи и отправлен только на адрес провайдера, объявленный плагином; код выполнения плагина ключ не получает.",
      footer: "Ключ хранится в вашей учётной записи. Хост отправляет его на объявленный адрес провайдера; код плагина получает только результат операции.",
      ready: "Ключ API сохранён",
      missing: "Требуется ключ API",
      unavailable: "Настройка учётных данных недоступна",
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
      googleCloudTts: {
        provider: {
          title: "Google Cloud: синтез речи",
          subtitle:
            "Используйте свой API‑ключ Google Cloud для синтеза аудио.",
          detail: "Google Cloud (GCP)",
        },
        common: {
          default: "По умолчанию",
        },
        apiKey: {
          title: "API‑ключ Google Cloud",
          promptTitle: "API‑ключ Google Cloud",
          promptBody:
            "Создайте API‑ключ с включенным Text-to-Speech API. Опционально: ограничьте ключ этим приложением (iOS bundle id / Android package+SHA1).",
        },
        androidCertSha1: {
          title: "SHA‑1 сертификата Android (необязательно)",
          subtitle:
            "Нужно только если вы ограничили API‑ключ своим Android‑приложением.",
          promptTitle: "SHA‑1 сертификата Android",
          promptBody: "Пример: AA:BB:CC:... (из сертификата подписи).",
        },
        language: {
          title: "Язык",
          subtitle: "Необязательный фильтр списка голосов.",
          searchPlaceholder: "Поиск языков",
          allTitle: "Все",
          allSubtitle: "Показывать голоса для всех языков.",
        },
        speakingRate: {
          title: "Скорость речи",
          subtitle: "0.25–4.0 (пусто = по умолчанию для голоса).",
          promptTitle: "Скорость речи",
          promptBody:
            "Задайте скорость речи (0.25–4.0). Оставьте пустым для значения по умолчанию.",
        },
        pitch: {
          title: "Высота",
          subtitle: "-20–20 (пусто = по умолчанию для голоса).",
          promptTitle: "Высота",
          promptBody:
            "Задайте высоту (-20–20). Оставьте пустым для значения по умолчанию.",
        },
        voice: {
          title: "Голос",
          subtitle: "Выберите голос Google Cloud.",
          searchPlaceholder: "Поиск голосов",
          selectPrompt: "Выбрать…",
          setApiKeyPrompt: "Укажите API‑ключ",
          loadingTitle: "Загрузка голосов…",
        },
        format: {
          title: "Формат",
          subtitle: "MP3 меньше; WAV без сжатия.",
          mp3Subtitle: "Меньше размер, широкая совместимость.",
          wavSubtitle: "Больше размер, без сжатия.",
        },
        alerts: {
          missingApiKey: "Отсутствует API‑ключ Google Cloud.",
          missingVoice: "Сначала выберите голос Google Cloud.",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Google Gemini (аудио)",
          subtitle: "Расшифровывайте аудио с помощью мультимодальных моделей Gemini.",
          detail: "Gemini от Google",
        },
        apiKey: {
          title: "API-ключ Gemini",
          promptTitle: "API-ключ Gemini",
          promptBody: "Создайте API-ключ в Google AI Studio (Gemini API).",
        },
        model: {
          title: "Модель Gemini",
          subtitle: "Выберите модель Gemini для транскрипции.",
          searchPlaceholder: "Поиск моделей",
          customTitle: "Пользовательский id модели…",
          customSubtitle: "Введите имя модели вручную.",
          loadingModelsTitle: "Загрузка моделей…",
          promptTitle: "Модель Gemini",
          promptBody: "Пример: gemini-2.5-flash",
        },
        language: {
          title: "Язык",
          subtitle: "Необязательная подсказка для повышения точности транскрипции.",
          searchPlaceholder: "Поиск языков",
          autoTitle: "Авто",
          autoSubtitle: "Не передавать языковую подсказку.",
        },
      },
      kokoro: {
        common: {
          default: "По умолчанию",
          none: "Нет",
        },
        runtime: {
          title: "Среда выполнения Kokoro",
          unsupportedSubtitle: "Kokoro не поддерживается на этом устройстве/в этой среде.",
          unavailableDetail: "Недоступно",
        },
        manifest: {
          title: "Манифест пакета модели",
          subtitle:
            "По умолчанию используются пакеты моделей Happier (переопределяется через EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS).",
          detailResolved: "Определён",
          detailMissing: "Отсутствует",
        },
        assetPack: {
          title: "Пакет модели Kokoro",
          subtitleNative: "Выберите набор ресурсов Kokoro.",
          subtitleWeb: "Выберите конфигурацию среды Kokoro.",
        },
        model: {
          title: "Модель Kokoro",
          subtitleNative: "Скачайте необходимые файлы для синтеза на устройстве.",
          subtitleWeb: "Скачивается по запросу. Использует WebAssembly (бета).",
        },
        modelStatus: {
          downloading: "Загрузка…",
          downloadingPrefix: "Загрузка",
          ready: "Готово",
          error: "Ошибка",
          notDownloaded: "Не скачано",
        },
        removeAssets: {
          title: "Удалить файлы Kokoro",
          subtitle: "Освободите место, удалив скачанные файлы Kokoro.",
          detailRemove: "Удалить",
          confirmTitle: "Удалить файлы Kokoro?",
          confirmBody: "Это удалит скачанные файлы Kokoro с этого устройства.",
          confirmButton: "Удалить",
        },
        updates: {
          title: "Проверить обновления модели",
          subtitle: "Вручную проверить, доступен ли более новый пакет модели.",
          check: "Проверить",
          upToDate: "Актуально",
          updateAvailable: "Доступно обновление",
        },
        alerts: {
          runtimeUnsupported: {
            body: "Kokoro не поддерживается на этом устройстве/в этой среде.",
          },
          missingManifest: {
            title: "Отсутствует URL манифеста",
            body: "Не удалось определить URL манифеста пакета модели. Проверьте EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (или устаревшие переменные окружения Kokoro).",
          },
          notInstalledTitle: "Не установлено",
          notInstalledBody:
            "Сначала скачайте пакет модели, чтобы включить проверку обновлений.",
          upToDateTitle: "Актуально",
          upToDateBody: "Для этого пакета модели нет доступных обновлений.",
          updateAvailableTitle: "Доступно обновление",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Скачать последнюю версию этого пакета модели сейчас?${remoteBuild ? `\n\nУдалённая сборка: ${remoteBuild}` : ""}`,
          updatedTitle: "Обновлено",
          updatedBody: "Пакет модели успешно обновлён.",
          updateFailedTitle: "Ошибка обновления",
          updateFailedBody: ({ message }: { message: string }) =>
            `Не удалось обновить этот пакет модели.\n\n${message}`,
        },
        voice: {
          title: "Голос",
          subtitleNative: "Выберите голос Kokoro.",
          searchPlaceholder: "Поиск голосов",
          titleWeb: "Голос Kokoro",
          subtitleWeb: "Выберите голос на устройстве для ответов.",
          loadingVoicesTitle: "Загрузка голосов…",
        },
        speed: {
          title: "Скорость",
          subtitle: "Настройка скорости речи (0,5–2,0).",
        },
        web: {
          warmingUp: "Подготовка…",
          clearCache: {
            confirmTitle: "Очистить кэш Kokoro?",
            confirmBody:
              "Это удалит скачанные файлы модели и голоса Kokoro с этого устройства.",
            confirmButton: "Очистить",
          },
          cacheDetail: {
            modelFiles: "Файлы модели",
            voices: "Голоса",
          },
          cache: {
            title: "Кэш Kokoro",
            subtitle: "Управляйте скачанными файлами Kokoro на этом устройстве.",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "Пакет модели",
          subtitle: "Id пакета модели STT (streaming).",
        },
        modelFiles: {
          title: "Файлы модели",
          subtitle:
            "Скачайте необходимые файлы, чтобы включить потоковый STT на устройстве.",
        },
        removeModelFiles: {
          title: "Удалить файлы модели",
          subtitle: "Освободите место, удалив скачанные файлы модели.",
          confirmTitle: "Удалить файлы модели?",
          confirmBody:
            "Это удалит скачанный пакет модели STT с этого устройства.",
        },
        status: {
          installed: "Установлено",
          installedWithBuild: ({ build }: { build: string }) =>
            `Установлено • ${build}`,
          notInstalled: "Не установлено",
        },
        language: {
          title: "Язык",
          subtitle: "Необязательный языковой тег BCP-47.",
          promptTitle: "Язык",
          promptBody: "Введите языковой тег BCP-47 (например: en, en-US).",
        },
        alerts: {
          downloadFailedTitle: "Ошибка загрузки",
          downloadFailedBody: ({ message }: { message: string }) =>
            `Не удалось скачать этот пакет модели.\n\n${message}`,
          notInstalledTitle: "Не установлено",
          notInstalledBody:
            "Сначала скачайте пакет модели, чтобы включить проверку обновлений.",
          upToDateBody:
            "Для этого пакета модели нет доступных обновлений.",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Скачать последнюю версию этого пакета модели сейчас?${remoteBuild ? `\n\nУдалённая сборка: ${remoteBuild}` : ""}`,
          updatedTitle: "Обновлено",
          updatedBody: "Пакет модели успешно обновлён.",
          updateFailedTitle: "Ошибка обновления",
          updateFailedBody: ({ message }: { message: string }) =>
            `Не удалось обновить этот пакет модели.\n\n${message}`,
        },

        provider: {
          title: "Локальная нейросеть (бета)",
          subtitle: "STT через daemon в веб-версии; при поддержке доступны дополнительные нативные Sherpa streaming-пакеты.",
          detail: "Sherpa STT",
        },},
      executionMachine: {
        groupTitle: "Локальная голосовая среда",
        groupFooter: "Выберите машину для локальной речи, управления моделями и голосового агента.",
        title: "Машина выполнения",
        fallbackSubtitle: "Выберите машину для локального голоса.",
        autoTitle: "Автоматически",
        autoSubtitle: "Выбирать доступную машину по недавней активности.",
        onlineLabel: "В сети",
        offlineLabel: "Не в сети",
        unknownMachineLabel: "Неизвестная машина",
      },
      conversationMode: "Режим разговора",
      conversationModeSubtitle:
        "Напрямую в сессию, или через медиатор с явным коммитом",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "Использовать голосового агента (явный коммит, контроль инструментов).",
          directTitle: "Прямая сессия",
          directSubtitle: "Говорите напрямую в активную сессию.",
        },
        handsFree: {
          title: "Хэндс‑фри",
          enableTitle: "Включить hands-free",
          silenceTitle: "Таймаут тишины (мс)",
          minSpeechTitle: "Минимальная речь (мс)",
        },
        customBackendIdSubtitle: "Введите пользовательский id бэкенда.",
        searchBackendsPlaceholder: "Поиск бэкендов",
        searchModelsPlaceholder: "Поиск моделей",
        machineAutoSubtitle:
          "Автовыбор машины на основе недавнего использования.",
        rootSessionPolicy: {
          title: "Политика корневой сессии",
          fallbackSubtitle: "Выберите политику.",
          singleTitle: "Одиночная",
          singleSubtitle: "Каждый раз создавать новую корневую сессию.",
          keepWarmTitle: "Держать тёплой",
          keepWarmSubtitle:
            "По возможности переиспользовать тёплую корневую сессию.",
          maxWarmRootsTitle: "Макс. тёплых корней",
          maxWarmRootsSubtitle:
            "Ограничить число тёплых корневых сессий.",
        },
        persistence: {
          title: "Сохранение транскрипта",
          ephemeralTitle: "Временно",
          ephemeralSubtitle:
            "Не сохранять состояние голосового агента между сессиями.",
          persistentTitle: "Постоянно",
          persistentSubtitle:
            "Сохранять состояние голосового агента между сессиями (с возобновлением).",
        },
        resetVoiceAgent: {
          title: "Сбросить состояние голосового агента",
          subtitle: "Очищает постоянное состояние голосового агента.",
          confirmBody:
            "Это очистит сохранённое состояние голосового агента. Отменить нельзя.",
        },
        agentSettings: {
          title: "Голосовой агент",
        },
        backend: {
          daemonSubtitle:
            "Использует ваш бэкенд Happier и поддерживает возобновление провайдера.",
          openAiSubtitle:
            "Подключение к OpenAI-совместимым HTTP эндпоинтам.",
        },
        agentMachine: {
          title: "Машина агента",
          fallbackSubtitle: "Выберите, где запускать голосового агента.",
          stayInVoiceHomeTitle: "Оставаться в voice home",
          stayInVoiceHomeEnabledSubtitle:
            "Держать агента на машине voice home.",
          stayInVoiceHomeDisabledSubtitle:
            "Разрешить агенту следовать за машиной сессии.",
          allowTeleportTitle: "Разрешить телепорт",
          teleportEnabledSubtitle:
            "Разрешить перенос агента на другую машину при необходимости.",
          teleportDisabledSubtitle: "Телепорт отключён.",
        },
        machineRecovery: {
          switchTitle: "Голосовая машина недоступна",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `Текущая голосовая машина (${currentMachine}) недоступна.\n\nПереключить голос на ${nextMachine}?`,
          switchAction: "Переключить машину",
          replayTitle: "Перенести разговор?",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `Можно начать заново на ${nextMachine} или переключиться и воспроизвести недавний голосовой контекст с предыдущей машины.`,
          replayAction: "Переключить и воспроизвести недавний голосовой контекст",
          startFreshAction: "Начать заново",
        },
        agentSource: {
          followSessionTitle: "Следовать за сессией",
          followSessionSubtitle: "Использовать бэкенд и конфигурацию сессии.",
          fixedAgentTitle: "Фиксированный агент",
          fixedAgentSubtitle:
            "Всегда использовать конкретный агент-бэкенд.",
        },
        permissionPolicy: {
          readOnlySubtitle: "Видит контекст, но не может запускать инструменты.",
          noToolsSubtitle:
            "Должен избегать запросов инструментов и никогда не запускать инструменты.",
        },
        chatModelSource: {
          sessionSubtitle:
            "Использовать конфигурацию модели сессии для чата агента.",
          customSubtitle:
            "Переопределить id модели чата голосового агента.",
        },
        chatModelId: {
          title: "ID модели чата голосового агента",
          subtitle:
            "Используется, когда источник модели чата задан как пользовательская модель.",
        },
        commitModelSource: {
          chatSubtitle: "Использовать модель чата агента для коммитов.",
          sessionSubtitle:
            "Использовать конфигурацию модели сессии для коммитов.",
          customSubtitle:
            "Переопределить id модели коммита голосового агента.",
        },
        commitModelId: {
          title: "ID модели коммита голосового агента",
          subtitle:
            "Используется, когда источник модели коммита задан как пользовательская модель.",
        },
        commitIsolation: {
          title: "Изоляция коммитов",
          subtitle:
            "Использовать отдельную vendor-сессию для генерации коммитов (для опытных).",
        },
        resumability: {
          modeTitle: "Возобновление",
          replayTitle: "Повтор",
          replaySubtitle: "Возобновлять, проигрывая недавние сообщения.",
          providerResumeTitle: "Возобновление провайдера",
          providerResumeSubtitle:
            "Возобновлять по состоянию сессии провайдера (если поддерживается).",
          disabledVoiceAgent: "Требуется Happier Voice Agent.",
          disabledDaemonBackend: "Требуется бэкенд Демон.",
          disabledAgentNoProviderResume:
            "Выбранный агент не поддерживает возобновление провайдера.",
        },
        providerResumeFallback: {
          title: "Фолбэк на повтор",
          subtitle:
            "Если возобновление провайдера не удалось, перейти на повтор.",
        },
        replayRecentMessagesPromptBody:
          "Сколько недавних сообщений включить (1–100).",
        prewarm: {
          title: "Прогрев при подключении",
          subtitle: "Запускать голосового агента сразу при подключении.",
        },
        welcome: {
          title: "Приветственное сообщение",
          offTitle: "Выкл.",
          offSubtitle: "Не отправлять приветственное сообщение.",
          immediateTitle: "Сразу",
          immediateSubtitle:
            "Отправить приветствие сразу после запуска агента.",
          onFirstTurnTitle: "На первом обращении",
          onFirstTurnSubtitle:
            "Отправить приветствие, когда вы заговорите впервые.",
        },
        verbosity: {
          shortSubtitle: "Держать ответы агента краткими.",
          balancedSubtitle:
            "Разрешать чуть больше деталей при необходимости.",
        },
        streaming: {
          title: "Стриминг",
          enableTitle: "Включить стриминг",
          enableSubtitle:
            "Транслировать частичный текст агента по мере генерации (используется для потоковой речи).",
          enableTtsTitle: "Включить стриминг TTS",
          enableTtsSubtitle:
            "Озвучивать ответ во время стриминга (требуется стриминг).",
          ttsChunkCharsTitle: "Размер чанка TTS (символы)",
          ttsChunkCharsPromptBody:
            "Сколько символов буферизовать перед запросом следующего чанка TTS (32–2000).",
        },
        network: {
          title: "Сеть",
          timeoutTitle: "Таймаут сети (мс)",
          timeoutPromptBody:
            "Таймаут запросов к вашим эндпоинтам (1000–60000).",
        },
      },
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
      chatBaseUrl: "Базовый URL чата",
      chatBaseUrlTitle: "Базовый URL чата",
      chatBaseUrlDescription:
        "Базовый URL для OpenAI-совместимого chat completion эндпоинта (обычно заканчивается на /v1).",
      chatApiKey: "Chat API-ключ",
      chatApiKeyTitle: "Chat API-ключ",
      chatApiKeyDescription:
        "Необязательный API-ключ для chat сервера (хранится в зашифрованном виде). Оставьте пустым, чтобы очистить.",
      chatModel: "Модель чата",
      chatModelSubtitle: "Быстрая модель для живого голосового диалога",
      chatModelTitle: "Модель чата",
      chatModelDescription:
        "Имя модели, отправляемое на chat сервер (OpenAI-совместимое поле).",
      modelCustomTitle: "Свой…",
      modelCustomSubtitle: "Введите ID модели",
      commitModel: "Модель коммита",
      commitModelSubtitle:
        "Модель для генерации финального сообщения-инструкции",
      commitModelTitle: "Модель коммита",
      commitModelDescription:
        "Имя модели, отправляемое при генерации финального commit сообщения.",
      chatTemperature: "Температура чата",
      chatTemperatureSubtitle: "Управляет случайностью (0–2)",
      chatTemperatureTitle: "Температура чата",
      chatTemperatureDescription: "Введите число от 0 до 2.",
      chatTemperatureInvalid: "Введите число от 0 до 2.",
      chatMaxTokens: "Макс. токенов чата",
      chatMaxTokensSubtitle: "Ограничить длину ответа (пусто = по умолчанию)",
      chatMaxTokensTitle: "Макс. токенов чата",
      chatMaxTokensDescription:
        "Введите положительное целое число или оставьте пустым.",
      chatMaxTokensPlaceholder: "Пусто = по умолчанию",
      chatMaxTokensUnlimited: "По умолчанию",
      chatMaxTokensInvalid: "Введите положительное число или оставьте пустым.",
      sttBaseUrl: "Базовый URL STT",
      sttBaseUrlTitle: "Речь в текст",
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
      deviceStt: "STT на устройстве (экспериментально)",
      deviceSttSubtitle:
        "Использовать распознавание речи на устройстве вместо OpenAI-совместимого эндпоинта",
      sttProvider: "Провайдер STT",
      neuralStt: {
        title: "STT на устройстве",
        webNotAvailableSubtitle:
          "Недоступно в вебе. Используйте STT устройства, OpenAI-совместимый или Gemini STT.",
      },
      ttsBaseUrl: "Базовый URL TTS",
      ttsBaseUrlTitle: "Текст в речь",
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
      ttsFormatOptions: {
        mp3Subtitle: "Меньший размер, широкая совместимость.",
        wavSubtitle: "Больший размер, без сжатия.",
      },
      testTts: "Тест TTS",
      testTtsSubtitle:
        "Воспроизвести короткий пример с текущими настройками локального TTS (на устройстве или через эндпоинт)",
      testTtsSample: "Привет от Happier. Это тест вашего локального TTS.",
      testTtsMissingBaseUrl: "Сначала укажите TTS Base URL.",
      testTtsFailed:
        "Тест TTS не удался. Проверьте base URL, API-ключ, модель и голос.",
      deviceTts: "TTS на устройстве (экспериментально)",
      deviceTtsSubtitle:
        "Использовать синтез речи на устройстве вместо OpenAI-совместимого эндпоинта",
      ttsProvider: "Провайдер TTS",
      ttsProviderSubtitle:
        "Выберите TTS на устройстве, OpenAI-совместимый эндпоинт или Kokoro (веб/десктоп)",

      autoSpeak: "Авто-озвучивание ответов",
      autoSpeakSubtitle:
        "Озвучивать следующий ответ ассистента после отправки голосового сообщения",
      bargeIn: "Перебивание",
      speaking: "Говорит…",

      localNeuralTts: {
        provider: {
          title: "Локальная нейросеть (бета)",
          subtitle: "Нейросетевой TTS через daemon в веб-версии; пакеты моделей на устройстве там, где поддерживаются.",
          detail: "Локальная нейросеть",
        },
      },
      deviceSttDetail: "Устройство",
      deviceTtsDetail: "Устройство",
      openaiCompatStt: {
        provider: {
          title: "OpenAI-совместимый endpoint",
          subtitle: "Используйте свой сервер транскрибации, совместимый с Whisper.",
          detail: "Эндпоинт",
        },
      },
      openaiCompatTts: {
        provider: {
          title: "OpenAI-совместимый endpoint",
          subtitle: "Используйте свой локальный или удалённый TTS-сервер, совместимый с OpenAI.",
          detail: "Эндпоинт",
        },
      },
      daemonInference: {
        execution: {
          title: "Локальное нейросетевое выполнение",
          subtitle: "Выберите, где работает локальный нейросетевой голос: на устройстве или в daemon.",
          options: { auto: "Авто", device: "Устройство", daemon: "Голосовой daemon" },
          optionSubtitles: {
            auto: "Предпочитать рекомендуемый путь выполнения для этой платформы.",
            device: "Запускать локальный нейросетевой голос прямо на этом устройстве, если поддерживается.",
            daemon: "Запускать локальный нейросетевой голос через daemon voice-home.",
          },
        },
        service: {
          title: "Сервис инференса daemon",
          subtitle: "Статус сервиса инференса daemon voice-home.",
        },
        model: {
          title: "Пакет модели daemon",
          subtitleTts: "Установить и обновить пакет модели TTS для daemon.",
          subtitleStt: "Установить и обновить пакет модели STT для daemon.",
        },
        remove: {
          title: "Удалить файлы модели daemon",
          subtitle: "Удалить файлы модели на стороне daemon для этого пакета.",
          detailInstalled: "Удалить установленные файлы daemon",
        },
        states: {
          loading: "Загрузка…",
          machineUnreachable: "Daemon voice-home недоступен.",
          unavailable: "Инференс daemon недоступен.",
          runtimeUnavailable: "Runtime daemon недоступен.",
          relayDisabled: "Relay daemon отключен.",
          relayCapped: "Достигнут лимит емкости relay daemon.",
          requestTimeout: "Время ожидания запроса к daemon истекло.",
          warming: "Прогрев модели…",
          ready: "Готово",
          degraded: "Деградировано",
          idle: "Ожидание",
          installing: "Установка…",
          installed: "Установлено",
          installError: "Ошибка установки",
          notInstalled: "Не установлено",
          latencyDemoted: "Задержка ухудшилась; для этой беседы используется речь устройства.",
          fallbackToDevice: "Возврат к речи устройства.",
        },
      },
      models: {
          title: "Локальные голосовые модели",
          statusTitle: "Служба моделей",
          footer: "Установите пакеты локальных голосовых моделей на голосовой демон и выберите модель по умолчанию для каждого типа.",
          sttGroupTitle: "Модели распознавания речи",
          ttsGroupTitle: "Модели синтеза речи",
          defaultBadge: "По умолчанию",
          defaultSubtitle: "По умолчанию для этого типа",
          installSubtitle: "Нажмите, чтобы установить на демон",
          setDefaultSubtitle: "Нажмите, чтобы использовать по умолчанию",
          unknownSubtitle: "Статус недоступен",
          memory: ({ size }: { size: string }) => `${size} в памяти`,
          removeConfirmTitle: "Удалить пакет модели",
          removeConfirmBody: ({ name }: { name: string }) => `Удалить файлы на стороне демона для ${name}?`,
          state: {
              notInstalled: "Не установлено",
              downloading: "Загрузка…",
              installed: "Установлено",
              warming: "Прогрев…",
              ready: "Готово",
              evicted: "Выгружено",
              error: "Ошибка установки",
              unknown: "Статус недоступен",
          },
      },
      machineErrors: {
        mic_permission_denied: "Доступ к микрофону запрещён.",
        mic_ended: "Ввод с микрофона завершился.",
        mic_plateau: "Звук с микрофона перестал поступать.",
        transport_disconnect: "Голосовое соединение разорвано.",
        provider_error: "Голосовой провайдер завершился с ошибкой.",
        provider_auth_invalid: "Добавьте или обновите API-ключ выбранного голосового провайдера.",
        audio_context_suspended: "Вывод звука приостановлен.",
        stt_timeout: "Истекло время ожидания начала прослушивания.",
        tts_failed: "Не удалось синтезировать речь.",
        turn_aborted: "Голосовой ход отменён.",
        authentication_required: "Подключите выбранного агента, чтобы использовать голосовой режим.",
        session_unavailable: "Выбранный сеанс больше недоступен для голосового режима.",
        unsupported_runtime: "Установите среду выбранного агента, чтобы использовать голосовой режим.",
        update_required: "Обновите среду выбранного агента, чтобы использовать голосовой режим.",
        feature_unavailable: "Голосовой режим недоступен для среды выбранного агента.",
      },},
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
      shareDeviceInventory: "Передавать список устройств",
      shareDeviceInventorySubtitle: "Разрешить голосу просматривать недавние рабочие области, машины и серверы",
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
      autoDetectSubtitle: "Пусть распознавание решит само (рекомендуется).",
      customTitle: "Пользовательский…",
      customSubtitle: "Введите языковой тег BCP-47.",
      options: {
        english: "Английский",
        englishUs: "Английский (США)",
        french: "Французский",
        spanish: "Испанский",
      },
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
    linkNewDevice: "Сканировать QR для привязки нового устройства",
    linkNewDeviceSubtitle: "Отсканируйте QR‑код, показанный на новом устройстве",
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
    crashReports: "Отчёты о сбоях",
    crashReportsDisabled: "Отчёты о сбоях не отправляются",
    crashReportsEnabled: "Отчёты о сбоях отправляются",
    dangerZone: "Опасная зона",
    logout: "Выйти",
    logoutSubtitle: "Выйти из аккаунта и очистить локальные данные",
    logoutConfirm:
      "Вы уверены, что хотите выйти? Убедитесь, что вы сохранили резервную копию секретного ключа!",
    encryptionUpdateFailed: "Не удалось обновить настройку шифрования",
    secretKeyMissing: "Секретный ключ недоступен. Сначала восстановите аккаунт.",
    restoreRequiredTitle: "Требуется восстановление",
    restoreRequiredBody:
      "У этого аккаунта есть зашифрованная история. Чтобы снова включить шифрование на этом устройстве, восстановите секретный ключ. Если вы потеряли ключ, можно сбросить аккаунт и начать заново (старую зашифрованную историю восстановить нельзя).",
  },

  connectButton: {
    authenticate: "Авторизация терминала",
    authenticateWithUrlPaste: "Авторизация терминала через URL",
    pasteAuthUrl: "Вставьте авторизационный URL из терминала",
  },

  updateBanner: {
    updateShort: "Обновить",
    updateAvailable: "Доступно обновление",
    pressToApply: "Нажмите, чтобы применить обновление",
    whatsNew: "Что нового",
    seeLatest: "Посмотреть последние обновления и улучшения",
    nativeUpdateAvailable: "Доступно обновление приложения",
    tapToUpdateAppStore: "Нажмите для обновления в App Store",
    tapToUpdatePlayStore: "Нажмите для обновления в Play Store",

    checkNowTitle: "Проверить сейчас",
    checkNowSubtitle: "Проверить, доступны ли обновления приложения.",
    lastCheckedTitle: "Последняя проверка",},

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: string }) => `Версия ${version}`,
    noEntriesAvailable: "Записи журнала изменений недоступны.",
  },

  releaseNotes: {
    viewFullChangelog: "Все примечания к выпуску",
    mediaUnavailable: "Медиа недоступно",
    storyDeck: {
      dragToDismiss: "Потяните, чтобы закрыть",
      letsGo: "Поехали!",
      slideAnnouncement: ({ title, current, total }: { title: string; current: number; total: number }) => `${title} - ${current} / ${total}`,
    },
    defaultTitle: "Что нового",
    onboardingShowcase: {
                "title": "Добро пожаловать в Happier",
                "subtitle": "Ваши AI-агенты везде, где вы работаете.",
                "cards": {
                    "welcome": {
                        "title": "Добро пожаловать в Happier",
                        "everywhereTitle": "Ваши AI-агенты везде, где вы работаете",
                        "everywhereBody": "Claude Code, Codex, OpenCode, Pi и многое другое: на телефоне, планшете, в браузере или на desktop.",
                        "cockpitTitle": "Ваш мобильный cockpit",
                        "cockpitBody": "Чат, файлы, Git, редактор, терминал. Всё, что нужно, чтобы собрать и отправить следующий проект, у вас под рукой.",
                        "existingTitle": "Существующие сессии уже здесь",
                        "existingBody": "Любую сессию Claude, Codex или OpenCode, запущенную на вашей машине, можно открыть в Happier вживую.",
                        "voiceTitle": "Голосовой ассистент для брейншторма",
                        "voiceBody": "Спросите, что делают ваши агенты, одобряйте запросы разрешений и отправляйте сообщения. Без рук.",
                        "reviewTitle": "Проверяйте diff и оставляйте комментарии",
                        "reviewBody": "Отмечайте конкретные строки в файлах или diff, выбирайте заметки для отправки и передавайте их агенту.",
                        "subagentsTitle": "Subagents между провайдерами",
                        "subagentsBody": "Запускайте subagents Codex из сессии Claude. Делите работу между агентами. Маршрутизируйте сообщения между сессиями.",
                        "tuisTitle": "Используйте любимые TUI",
                        "tuisBody": "Запускайте Claude Code, Codex или OpenCode в их нативном терминальном UI. Happier захватывает его и синхронизирует на все устройства.",
                        "inboxTitle": "Один inbox. Каждая сессия.",
                        "inboxBody": "Все ожидающие одобрения, запросы разрешений и непрочитанная активность по всем сессиям и машинам в одном месте.",
                        "mcpTitle": "Один MCP-конфиг. Каждый провайдер.",
                        "mcpBody": "Определите MCP-серверы один раз. Они работают во всех backend, включая провайдеров без нативной поддержки MCP.",
                        "controlTitle": "Ставьте в очередь, направляйте, fork, rollback",
                        "controlBody": "Ставьте сообщения в очередь, пока агент занят. Направляйте текущий turn. Делайте fork от любого сообщения. Откатывайте при необходимости.",
                        "automationsTitle": "Автоматизации",
                        "automationsBody": "Планируйте регулярные сессии агентов для мониторинга PR, проверки issues или выполнения любых задач по расписанию.",
                        "accountsTitle": "Несколько аккаунтов и квоты",
                        "accountsBody": "Подключайте несколько аккаунтов Claude или OpenAI: личный, рабочий, командный. Отслеживайте использование каждого прямо в приложении.",
                        "promptsTitle": "Prompts, skills и профили",
                        "promptsBody": "Переиспользуемые prompts, bundles skills и backend-профили, синхронизированные между всеми сессиями и устройствами.",
                        "privacyTitle": "Open-source. End-to-end encryption. Self-hostable.",
                        "privacyBody": "Ваши сессии остаются приватными. Исходный код открыт. Self-host одной командой.",
                        "petsTitle": "Познакомьтесь с Pets",
                        "petsBody": "Маленький компаньон для долгих сессий. Полезный? Возможно. Очаровательный? Определённо."
                    ,
                        row1Title: "Сессии на любом устройстве",
                        row1Body: "Продолжайте с того места, где остановились — телефон, планшет, веб или десктоп.",
                        row2Title: "Двигайтесь быстрее, выпускайте раньше",
                        row2Body: "Синхронизация в реальном времени держит терминал, агенты и файлы в едином ритме.",
                        row3Title: "По умолчанию приватно",
                        row3Body: "Сквозное шифрование — ваша работа остаётся вашей.",},
                    "anywhere": {
                        "title": "Начните где угодно. Продолжайте везде.",
                        "wideTitle": "Начните где угодно.\nПродолжайте везде.",
                        "body": "Запустите сессию откуда угодно. Следите вживую, отправляйте сообщения и одобряйте разрешения с телефона, браузера или desktop.",
                        "alt": "Абстрактное изображение-заглушка для сессий агентов между устройствами."
                    },
                    "terminalTuis": {
                        "title": "Любите терминал? Мы тоже!",
                        "wideTitle": "Любите терминал?\nМы тоже!",
                        "body": "Запускайте Claude Code, Codex или OpenCode в их нативном терминальном UI. Следите, отправляйте сообщения и одобряйте разрешения с телефона.",
                        "alt": "Абстрактное изображение-заглушка для синхронизации терминального TUI."
                    },
                    "cockpit": {
                        "title": "Всё, что нужно. В одно касание.",
                        "wideTitle": "Всё, что нужно.\nВ одно касание",
                        "body": "Чат, файлы, Git, редактор, терминал. Взаимодействуйте с агентом, просматривайте и редактируйте файлы, проверяйте diff, управляйте ветками Git, открывайте PR и живой терминал.",
                        "alt": "Абстрактное изображение-заглушка для мобильного cockpit."
                    ,
                        row1Title: "Режим cockpit",
                        row1Body: "Следите за активными агентами в сфокусированном мобильном виде.",
                        row2Title: "Переход в одно касание",
                        row2Body: "Переключайтесь между чатом, файлами, Git, терминалом и деталями без десктопной раскладки.",
                        row3Title: "Быстрая отправка",
                        row3Body: "Отвечайте из cockpit, когда агенту нужен небольшой толчок.",},
                    "existingSessions": {
                        "title": "Сессии Claude, Codex, OpenCode? Уже здесь.",
                        "body": "Просматривайте любые сессии Claude, Codex или OpenCode, запущенные сейчас или нет.",
                        "alt": "Абстрактное изображение-заглушка для существующих сессий провайдеров."
                    },
                    "voiceAssistant": {
                        "title": "Коллега, с которым можно поговорить",
                        "wideTitle": "Голосовой ассистент: коллега, с которым можно поговорить",
                        "body": "Голосовой ассистент следит за всеми запущенными сессиями. Обсуждайте следующие изменения, одобряйте разрешения и многое другое без рук.",
                        "alt": "Абстрактное изображение-заглушка для голосового ассистента."
                    },
                    "reviewComments": {
                        "title": "Проверяйте код и оставляйте комментарии",
                        "body": "Просматривайте изменения и diff вашего агента. Отмечайте точные строки, которые хотите исправить. Отправляйте их агенту в текущей сессии или новой.",
                        "alt": "Абстрактное изображение-заглушка для review comments."
                    ,
                        row1Title: "Комментарии к точным строкам",
                        row1Body: "Оставляйте отзывы прямо на строках файлов и diff.",
                        row2Title: "Выбирайте, что отправить",
                        row2Body: "Проверяйте, редактируйте, убирайте или добавляйте комментарии перед отправкой агенту.",
                        row3Title: "Контекст сохраняется",
                        row3Body: "Отправляйте структурированный контекст ревью в текущую или новую сессию.",},
                    "subagents": {
                        "title": "Одна сессия, subagents разных провайдеров",
                        "body": "Запускайте Codex, Claude или других subagents в любой сессии. Используйте сильные стороны каждого и заставьте их работать вместе в одной сессии.",
                        "alt": "Абстрактное изображение-заглушка для subagents между провайдерами."
                    },
                    "inbox": {
                        "title": "Больше не теряйте нить",
                        "body": "Запущено 10 сессий, и непонятно, что требует вашего внимания? Inbox показывает всю активность по всем сессиям и машинам.",
                        "alt": "Абстрактное изображение-заглушка для глобального inbox."
                    },
                    "mcp": {
                        "title": "Один конфиг. Каждый провайдер.",
                        "wideTitle": "Один конфиг.\nКаждый провайдер.",
                        "body": "Определите MCP один раз в Happier, и они работают во всех backend, даже тех, где нет нативной поддержки MCP. Управляйте skills, prompts и не только!",
                        "alt": "Абстрактное изображение-заглушка для общей конфигурации MCP."
                    },
                    "queue": {
                        "title": "Очередь, steering, fork, rollback",
                        "body": "Ставьте сообщения в очередь, пока агент занят. Направляйте текущую сессию. Делайте fork от любого сообщения. Откатывайтесь, если всё пошло не туда.",
                        "alt": "Абстрактное изображение-заглушка для инструментов контроля сессии."
                    },
                    "automations": {
                        "title": "Ваш агент по расписанию",
                        "body": "Планируйте регулярные сессии для мониторинга pull requests, проверки issues или выполнения любых задач по расписанию.",
                        "alt": "Абстрактное изображение-заглушка для запланированных автоматизаций агентов."
                    },
                    "accounts": {
                        "title": "Мультиаккаунты и отслеживание квот",
                        "body": "Подключайте несколько аккаунтов OpenAI или Claude. Отслеживайте использование и квоты каждого прямо в приложении.",
                        "alt": "Абстрактное изображение-заглушка для подключенных аккаунтов и квот."
                    },
                    "privacy": {
                        "title": "Open-source. End-to-end encryption.",
                        "wideTitle": "Открытый исходный код.\nСквозное шифрование.",
                        "body": "Ваш код, prompts и содержимое сессий шифруются на устройстве до отправки на любой сервер. Private by design. Open by default.",
                        "alt": "Абстрактное изображение-заглушка для приватности и self-hosting."
                    },
                    "pets": {
                        "title": "Никогда не оставайтесь одни. Meet Pets.",
                        "wideTitle": "Никогда не оставайтесь одни.\nПознакомьтесь с Pets.",
                        "body": "Маленький компаньон, который помогает держать фокус между сессиями. Полезный? Возможно. Очаровательный? Определённо.",
                        "alt": "Абстрактное изображение-заглушка для Pets."
                    ,
                        row1Title: "Маленький спутник",
                        row1Body: "Помогает не терять фокус между сессиями.",
                        row2Title: "Следит за активностью",
                        row2Body: "Показывает активность сессий на desktop и mobile.",
                        row3Title: "Полезно? Возможно.",
                        row3Body: "Очаровательно? Точно.",}
                ,
                    sourceControl: {
            title: "Соберите и отправьте",
            body: "Создавайте и публикуйте ветки, управляйте remotes, просматривайте изменённые файлы и открывайте pull request, не выходя из Happier.",
            alt: "Абстрактное изображение-заглушка source control.",
            row1Title: "Ветки и публикация",
            row1Body: "Создавайте ветки, управляйте remotes и отправляйте изменения, не выходя из Happier.",
            row2Title: "Открывайте pull request",
            row2Body: "Используйте существующий PR или создавайте новый из сессии.",
            row3Title: "Просмотр изменённых файлов",
            row3Body: "Фокусируйтесь на выбранных файлах, когда changeset становится большим.",
        },
                    markdown: {
            title: "Плавнее streaming, богаче markdown",
            body: "Streaming-ответы выглядят плавнее, а более богатый Markdown упрощает чтение длинных ответов, кода, списков и диаграмм.",
            alt: "Абстрактное изображение-заглушка Markdown.",
            row1Title: "Вывод успевает",
            row1Body: "Streaming-ответы выглядят плавнее, пока агенты пишут.",
            row2Title: "Markdown надёжнее",
            row2Body: "Блоки кода, списки, таблицы и длинные ответы отображаются стабильнее.",
            row3Title: "Компактация понятнее",
            row3Body: "События жизненного цикла легче отслеживать в транскрипте.",
        },
                    media: {
            title: "Изображения прямо в транскрипте",
            body: "Попросите Codex и поддерживаемых агентов генерировать изображения, а затем просматривайте результат прямо в Happier.",
            alt: "Абстрактное изображение-заглушка сгенерированных медиа.",
            row1Title: "Генерируйте изображения",
            row1Body: "Попросите Codex и поддерживаемых агентов создать изображения.",
            row2Title: "Предпросмотр внутри",
            row2Body: "Сгенерированные изображения появляются прямо в беседах Happier.",
            row3Title: "Сохранено с сессией",
            row3Body: "Медиа проходит через тот же session pipeline, что и ваша работа.",
        },
                    desktop: {
            title: "Более отполированное desktop-приложение",
            body: "Более чистая desktop-оболочка с отполированным chrome, безопасными отступами и статусом обновлений на своём месте.",
            alt: "Абстрактное изображение-заглушка desktop-приложения.",
            row1Title: "Чище chrome",
            row1Body: "Контролы sidebar и статус обновлений выглядят естественнее.",
            row2Title: "Больше фокуса",
            row2Body: "Окна и поверхности сессии меньше мешают работе.",
            row3Title: "Надёжнее layout",
            row3Body: "Desktop-отступы лучше учитывают platform chrome и экраны с notch.",
        },}
            },
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
      `Это подключение для ${serverUrl}. Переключить сервер и продолжить?`,
  },

  terminalEmbedded: {
    dockMenuA11y: "Закрепить терминал",
    largePasteTitle: "Вставить большой ввод в терминал?",
    largePasteDescription: "Этот вставляемый текст большой и может выполнить команды в терминале. Проверьте его перед продолжением.",
    largePasteConfirm: "Вставить в терминал",
    settings: {
      locationTitle: "Расположение встроенного терминала",
      rendererTitle: "Рендерер терминала",
      rendererAuto: "Автоматически",
      rendererAutoDescription: "Использовать доступный рендерер xterm.js, если нативный рендерер не прошёл все проверки.",
      rendererXtermWebView: "xterm.js WebView",
      rendererXtermWebViewDescription: "Совместимый рендерер с лучшей поддержкой доступности.",
      rendererNativeExperimental: "Нативный (экспериментальный)",
      rendererNativeExperimentalDescription: "Предпочитать Ghostty на iOS или Termux на Android, когда пройдены все нативные проверки.",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "Ввод",
    },
    location: {
      sidebar: "Боковая панель",
      details: "Панель деталей",
      bottom: "Нижняя панель",
    },
    errors: {
      missingMachineTarget: "В этой сессии отсутствует цель машины.",
      rpcTargetUnavailable: "RPC машины недоступен для этой машины.",
      machineUnreachable: "Машина недоступна.",
      disabled: "Поддержка терминала отключена в конфигурации демона. Включите её и перезапустите демон.",
      notFound: "Сессия терминала не найдена. Попробуйте перезапустить.",
      cwdDenied: "У демона нет прав на использование этого рабочего каталога.",
      spawnFailed: "Не удалось запустить процесс терминала.",
      invalidRequest: "Неверный запрос терминала.",
      busy: "Терминал занят. Попробуйте снова.",
    },

    openNewTabA11y: "Открыть новую вкладку терминала",},

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
    pleaseSignInFirst: "Сначала войдите в аккаунт (или создайте новый).",
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
    qrScannerUnavailable:
      "Не удалось открыть сканер QR. Попробуйте снова или введите URL вручную.",
  },

    navigation: {
      // Navigation titles and screen headers
      connectTerminal: "Подключить терминал",
      linkNewDevice: "Связать новое устройство",
      restoreWithSecretKey: "Восстановить секретным ключом",
      whatsNew: "Что нового",
      friends: "Друзья",
      automations: "Автоматизации",
      automation: "Автоматизация",
      newAutomation: "Новая автоматизация",
      sourceControl: "Контроль версий",
      developerTools: "Инструменты разработчика",
      listComponentsDemo: "Демо компонентов списка",
      typography: "Типографика",
      colors: "Цвета",
      toolViewsDemo: "Демо представлений инструментов",
      maskedProgress: "Маскированный прогресс",
      shimmerViewDemo: "Демо эффекта Shimmer",
      multiTextInput: "Многострочный ввод текста",
      connectClaude: "Подключиться к Claude",
      zenNewTask: "Новая задача",
      zenTaskDetails: "Детали задачи",
    },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Мобильный клиент Codex и Claude Code",
    subtitle:
      "Сквозное шифрование по умолчанию, с восстановлением аккаунта на других ваших устройствах.",
    createAccount: "Создать аккаунт",
    chooseEncryptionTitle: "Выберите шифрование",
    chooseEncryptionBody: "Этот сервер поддерживает как зашифрованные, так и незашифрованные аккаунты. Выберите, как вы хотите хранить данные аккаунта.",
    chooseEncryptionEncrypted: "Продолжить со сквозным шифрованием",
    chooseEncryptionPlain: "Продолжить без шифрования",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Продолжить через ${provider}`,
    signInWithCertificate: "Войти по сертификату",
    linkOrRestoreAccount: "Связать или восстановить аккаунт",
    loginWithMobileApp: "Войти через мобильное приложение",
    serverUnavailableTitle: "Не удаётся подключиться к Relay",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Мы не можем подключиться к ${serverUrl}. Повторите попытку или выберите другой Relay, чтобы продолжить.`,
    serverIncompatibleTitle: "Relay не поддерживается",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Relay по адресу ${serverUrl} вернул неожиданный ответ. Обновите этот Relay или выберите другой Relay, чтобы продолжить.`,

    // Unified onboarding redesign — BrandPanel (left pane / mobile hero)
    brandTaglineLine1: "Начни где угодно.",
    brandTaglineLine2: "Продолжай где угодно.",
    brandSubTagline: "Единый центр управления для каждого агента-программиста — на всех ваших устройствах.",
    brandTrustStrip: "СКВОЗНОЕ ШИФРОВАНИЕ · ОТКРЫТЫЙ ИСХОДНЫЙ КОД · SELF-HOSTING",
    providerMarkRowAccessibilityLabel: "Поддерживаемые ИИ-агенты для программирования",

    // Unified onboarding redesign — welcome decision (right pane)
    welcomeQuestionTitle: "Добро пожаловать.",
    welcomeQuestionSubtitle: "Вы здесь впервые?",
    welcomeQuestionBody: "Happier — это центр управления вашими ИИ-агентами для программирования. Email не нужен. Ваш аккаунт — это приватный ключ, сгенерированный на этом устройстве.",

    welcomePrimaryButton: "Впервые здесь — начнём",
    welcomePrimarySubtitle: "Одно касание. Без форм. Ваш ключ хранится здесь.",

    welcomeSecondaryButton: "Войти — я уже пользуюсь Happier",
    welcomeSecondarySubtitle: "Отсканируйте QR-код или введите секретный ключ",

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
    welcomeReturningTitle1: "С возвращением.",
    welcomeReturningTitle2: "Рады вас видеть.",
    welcomeReturningTitle3: "Хорошо, что вы здесь.",
    welcomeReturningTitle4: "Добро пожаловать домой.",
    welcomeReturningSubtitle1: "Продолжим с того же места.",
    welcomeReturningSubtitle2: "Готовы приступить?",
    welcomeReturningSubtitle3: "Что строим сегодня?",

    // Returning-user buttons. For returning users we invert the visual
    // hierarchy: Login becomes the filled primary action (probability of
    // intent is high), Start fresh becomes the bordered secondary action.
    // "I already use Happier" is dropped from the login button title for
    // returning users because — they obviously do already use Happier.
    welcomeReturningLoginButton: "Войти — продолжим с того же места",
    welcomeReturningStartFreshButton: "Начать заново — создать новый аккаунт",
    welcomeReturningStartFreshSubtitle: "Сгенерируйте новый ключ на этом устройстве.",

    // Welcome step footer links
    welcomeFooterRelay: "Self-hosting?",
    welcomeFooterRelayAction: "Используйте свой Relay",
    // Shown in place of welcomeFooterRelay when the active server is a
    // custom (non-Happier-Cloud) relay. The action below the label is the
    // relay's host (optionally with :port) followed by a small pencil
    // icon so the user can tap to edit. Long hostnames are truncated with
    // a tail-ellipsis to avoid colliding with the right-side Docs group.
    welcomeFooterRelayActiveLabel: "Ваш relay:",
    welcomeFooterRelayEditAccessibility: "Изменить relay",
    welcomeFooterDocs: "Нужна помощь?",
    welcomeFooterDocsAction: "Документация",
    welcomeFooterGithubLabel: "Репозиторий GitHub",
    welcomeFooterDiscordLabel: "Сообщество Discord",

    // Mobile brand hero CTA
    brandHeroGetStarted: "Начать",
  },

  sessionGettingStarted: {
    title: {
      connectMachine: "Настроить этот компьютер",
      startDaemon: "Переподключить этот компьютер",
      createSession: "Создать сессию",
      selectSession: "Выбрать сессию",
      loading: "Загрузка…",
    },
    cliFollowUpTitle: "Альтернатива через терминал (необязательно)",
    manualDisclosure: {
      show: "Показать шаги для терминала",
      hide: "Скрыть шаги для терминала",
    },
    subtitle: {
      connectMachine: ({ targetLabel }: { targetLabel: string }) =>
        `Используйте настольный мастер настройки, чтобы подключить этот компьютер к ${targetLabel}. Откройте ручные шаги только если предпочитаете путь через терминал.`,
      startDaemon: ({ targetLabel }: { targetLabel: string }) =>
        `Используйте настольный мастер настройки, чтобы переподключить фоновую службу для ${targetLabel}. Откройте ручные шаги только если вы уже на этом компьютере.`,
      createSession: "Начните новую сессию кнопкой + или из терминала.",
      selectSession: "Выберите сессию в боковой панели, чтобы открыть её здесь.",
      loading: "Загружаем ваши машины и сессии…",
    },
    steps: {
      openSetup: {
        title: "Использовать настольный мастер настройки",
        description: "Рекомендуемый путь. Он настраивает Relay, устанавливает фоновую службу и оставляет остальную часть настройки в приложении.",
      },
      startDaemonOpenSetup: {
        description: "Используйте настольный мастер настройки, чтобы переподключить или восстановить фоновую службу на этом компьютере, прежде чем переходить к терминальным командам.",
      },
      installCli: {
        title: "Установить CLI",
        description: "Запустите это один раз на машине, которую хотите подключить.",
        copyLabel: "Команда установки",
      },
      serverSetup: {
        title: "Выбрать активный Relay",
        description: "Один раз, чтобы следующие команды работали с нужным Relay.",
        copyLabel: "Настройка Relay",
      },
      authLogin: {
        title: "Войти",
        description: "Выведет QR-код или ссылку, чтобы привязать терминал к вашему аккаунту.",
        copyLabel: "Вход",
      },
      daemonInstall: {
        title: "Установить фоновую службу (рекомендуется)",
        description: "Держит Happier готовым в фоне для удалённых запусков.",
        copyLabel: "Установка службы",
      },
      startDaemonInstall: {
        description: "Устанавливает всегда активную пользовательскую службу и запускает её.",
      },
      daemonStart: {
        title: "Запустить фоновую службу один раз",
        description: "Используйте, если она нужна только сейчас.",
        copyLabel: "Запуск службы",
      },
      createSession: {
        title: "Создать сессию",
        description: "Используйте кнопку + в приложении или выполните одну из этих команд в терминале.",
        copyLabel: "Создание сессии",
      },
      startSession: {
        title: "Запустить сессию с этого компьютера",
        description: "Или используйте кнопку + в приложении.",
        copyLabel: "Запуск сессии",
      },
    },
  },

  setupOnboarding: {
		    screenTitle: "Настроить этот компьютер",
		    welcomeTitle: "Добро пожаловать в Happier",
			    welcomeBody: "Happier соединяет ваш телефон и компьютеры через Relay, чтобы ваши сессии были доступны везде.",
			    welcomeBody2: "Открытый исходный код. Сквозное шифрование. Zero‑knowledge.",
			    welcomeBody3: "Сделано разработчиками для разработчиков.",
			    providersShowcaseLabel: "Работает с:",
	    letsStart: "Начнём",
	    scanQrCode: "Сканировать QR-код",
    recommendedBadge: "Рекомендуется",
	    relayCloudTitle: "Happier Cloud",
	    relayCloudSubtitle: "Самый простой вариант — размещённый Relay",
	    relayOnThisComputerTitle: "На этом компьютере",
	    relayOnThisComputerSubtitle: "Запустите Relay локально на этом компьютере и добавьте Tailscale для доступа с телефона",
	    relayOnYourComputerTitle: "На вашем компьютере",
	    relayOnYourComputerSubtitle: "Запустите Relay локально на вашем компьютере и добавьте Tailscale для доступа с телефона",
	    relayOnRemoteComputerTitle: "Настроить Relay на удалённом компьютере",
	    relayOnRemoteComputerSubtitle: "Разместите Relay на удалённом компьютере через SSH",
	    remoteRelayHostInstallTitle: "Разместить Relay на удалённом компьютере",
	    relayAccessWizardTitle: "Как телефону подключаться к этому Relay?",
	    relayAccessUrlTitle: "URL Relay",
	    relayAccessUrlSubtitle: "Введите URL, доступный вашему телефону.",
	    relayAccessUrlBody: "Это может быть LAN‑адрес, пользовательский домен или URL туннеля — главное, чтобы телефон мог его открыть.",
	    relayAccessCloudflareTitle: "Туннель Cloudflare",
	    relayAccessCloudflareSubtitle: "Откройте Relay через Cloudflare Named Tunnel.",
	    relayAccessCloudflareBody: "Создайте или выберите Named Tunnel, затем мы настроим его для перенаправления трафика на локальный Relay.",
	    changeRelay: "Сменить Relay",
	    relayCustomUrlTitle: "Существующий Relay",
	    relayCustomUrlSubtitle: "Используйте URL Relay, который уже запущен",
    authRestoreTitle: "Восстановить или добавить это устройство",
    authRestoreSubtitle: "Используйте QR-код или ссылку, чтобы подключить это устройство",
    authSecretKeyTitle: "Войти с секретным ключом",
    authSecretKeySubtitle: "Введите секретный ключ, чтобы войти в Happier",
    authLostAccessTitle: "Потеряли доступ?",
    authLostAccessSubtitle: "Сбросьте аккаунт через вашего провайдера идентификации",
    webRelayHostHandoffTitle: "Настройте Relay на этом компьютере",
    webRelayHostHandoffBody: "Чтобы разместить Relay на этом компьютере, используйте десктоп‑приложение или CLI. Мы проведём вас по шагам, затем вы сможете вставить сюда URL Relay, чтобы продолжить.",
    webDesktopOnlyTitle: "Требуется приложение для компьютера",
    webDesktopOnlyBody: "Откройте приложение для компьютера, чтобы настроить этот компьютер. Веб‑приложение может показывать статус, но не может установить или настроить фоновую службу.",
    webDesktopOnlyPrimary: "У меня есть URL Relay",
    webDesktopOnlyDesktopAppTitle: "Продолжить настройку в приложении для компьютера",
    webDesktopOnlyDesktopAppSubtitle: "Скачайте и откройте Happier, чтобы настроить этот компьютер с помощью мастера.",
    webDesktopOnlyDesktopAppButton: "Скачать приложение",
    webDesktopOnlyCliTitle: "Установите CLI на этот компьютер",
    webDesktopOnlyCliSubtitle: "Выполните это один раз в терминале (Node не требуется).",
    handoffPlatformPosixLabel: "macOS/Linux",
    handoffPlatformMacosLabel: "macOS",
    handoffPlatformLinuxLabel: "Linux",
    handoffPlatformWindowsLabel: "Windows",
    orDividerLabel: "или",
    webDesktopOnlySetupCommandTitle: "Настройте этот компьютер через CLI",
    webDesktopOnlySetupCommandSubtitle: "Выполните одну команду, чтобы настроить Relay, войти при необходимости и установить фоновую службу.",
    webDesktopOnlySetupRemotePrereqsSubtitle: "Выполните одну команду, чтобы настроить Relay и войти перед настройкой удалённого компьютера по SSH.",
    webDesktopHandoffDesktopAppOption: "С помощью десктоп‑приложения (рекомендуется)",
    webDesktopHandoffDesktopAppSubtitle: "Скачайте и откройте Happier, чтобы разместить Relay с пошаговой настройкой.",
    webDesktopHandoffCliOption: "С помощью терминала (CLI)",
    webDesktopHandoffCliSubtitle: "Выполните несколько команд, чтобы разместить Relay, затем вставьте сюда выведенный URL Relay.",
    webDesktopOnlyRelayInstallTitle: "Запустите Relay на этом компьютере",
	    webDesktopOnlyRelayInstallSubtitle: "Это установит и запустит хост Relay. Затем вставьте сюда показанный URL Relay.",
	    webDesktopOnlyRelayStatusTitle: "Получите URL Relay",
	    webDesktopOnlyRelayStatusSubtitle: "Выполните команду, чтобы увидеть URL Relay, затем вставьте его здесь.",
	    webDesktopOnlyOptionalNextTitle: "Необязательно: защищённый доступ и провайдеры",
	    webDesktopOnlyOptionalNextBody: "После установки Happier откройте Настройки → Защищённый доступ (Tailscale), чтобы подключить телефон, и Настройки → Провайдеры, чтобы установить нужные инструменты.",
			    preAuthTitle: "Где находится ваш relay?",
	    preAuthBody: "Ваш relay пересылает сообщения между телефоном и компьютерами. Выберите, где он будет работать — это можно изменить позже.",
    preAuthContinueHint: "После продолжения Happier вернёт вас на экран входа для выбранного Relay, а затем вернётся сюда, чтобы завершить настройку.",
	    currentRelayTitle: "Текущий сервер",
	    selectedRelayFooterLabel: "Текущий сервер",
	    selectedRelayFooterLine: ({ relay }: { relay: string }) => `Активный сервер: ${relay}`,
	    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Текущий Relay: ${relayUrl}`,
	    accountWillLiveOnRelay: ({ relayUrl }: { relayUrl: string }) => `Ваш аккаунт будет на ${relayUrl}.`,
	    savedRelaysTitle: "Сохранённые Relay",
        removeRelayConfirmTitle: "Удалить relay?",
        removeRelayConfirmBody: "Это удалит его из сохранённых relay на этом устройстве.",
	    customRelayUrlLabel: "URL Relay",
    relayNameLabel: "Имя Relay",
    addAndUseRelay: "Добавить Relay",
    changeRelayAction: "Использовать другой URL Relay",
    continueToAuth: "Продолжить с выбранным Relay",
    continueWithLocalRelayAction: "Продолжить с этим локальным Relay",
    postAuthTitle: "Завершите настройку этого компьютера",
    postAuthBody: "Вы вошли. Продолжите локальную настройку, чтобы подготовить этот компьютер для выбранного Relay.",
    setupThisComputerTitle: "Настроить этот компьютер",
    controlPanelTitle: "Сводка готовности",
    activeRelaySummaryTitle: "Активный Relay",
    thisComputerSummaryTitle: "Этот компьютер",
    nextActionSummaryTitle: "Следующее действие",
    thisComputerReady: "Готов к этому Relay",
    nextActionReady: "Создайте первую сессию или добавьте ещё один компьютер ниже.",
    thisComputerStages: {
        installToolsTitle: 'Установить инструменты Happier',
        installToolsSubtitle: 'Установите локальные инструменты командной строки Happier, необходимые для настройки этого компьютера.',
        installToolsReadySubtitle: 'Локальные инструменты Happier уже доступны на этом компьютере.',
        installToolsDetails: 'Мы проверяем, что управляемая среда выполнения Happier, используемая для локальной настройки, доступна, и синхронизируем соответствующую команду терминала для этого канала релиза.',
        installToolsChildTitle: 'Установить локальные инструменты командной строки Happier',
        useRelayTitle: 'Использовать этот Relay',
        useRelayAccountMismatchSubtitle: 'Переключитесь на учетную запись, которая относится к этому серверу, прежде чем продолжить.',
        useRelayNeedsAuthSubtitle: 'Войдите или создайте учетную запись, чтобы продолжить настройку этого сервера.',
        useRelaySignedInSubtitle: 'Текущая учетная запись уже вошла в систему и готова использовать этот сервер.',
        useRelayServerMismatchSubtitle: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `Сервер приложения: ${activeRelayUrl}. Фоновая служба: ${daemonRelayUrl}.`,
        useRelayConnectedSubtitle: ({ relayUrl }: { relayUrl: string }) => `Подключено к ${relayUrl}.`,
        useRelayMissingSubtitle: 'Выберите или добавьте сервер, чтобы продолжить.',
        useRelayDetails: 'Мы подтверждаем, какой Relay и какая учетная запись должны использоваться на этом компьютере до начала локальной регистрации.',
        backgroundServiceTitle: 'Фоновая служба',
        backgroundServiceDecisionSubtitle: 'Выберите, как этот компьютер должен владеть фоновой службой по умолчанию.',
        backgroundServiceRunningSubtitle: 'Фоновая служба установлена и запущена.',
        backgroundServiceInstalledSubtitle: 'Фоновая служба установлена, но ее нужно запустить.',
        backgroundServiceSubtitle: 'Установите и запустите фоновую службу на этом компьютере.',
        backgroundServiceDetails: 'Фоновая служба поддерживает готовность этого компьютера к будущим запускам и автоматически переподключает его к выбранному Relay.',
        backgroundServiceReleaseChannelChildTitle: 'Разрешить владение каналом релиза',
        backgroundServiceConflictChildTitle: 'Разрешить существующие конфликты фоновой службы',
        registerComputerTitle: 'Зарегистрировать этот компьютер',
        registerComputerDoneSubtitle: 'Этот компьютер уже зарегистрирован в вашей учетной записи.',
        registerComputerNeedsAuthSubtitle: 'Войдите перед регистрацией этого компьютера.',
        registerComputerReconnectSubtitle: 'Повторно подключите этот компьютер после обновления настроек сервера.',
        registerComputerSubtitle: 'Подключите этот компьютер к вашей учетной записи на выбранном сервере.',
        registerComputerDetails: 'Мы регистрируем этот компьютер в вашей учетной записи на выбранном Relay, чтобы локальные сессии и фоновые функции могли корректно определять эту машину.',
        footerHint: 'Мы выполняем низкоуровневые шаги настройки за вас и показываем только те решения, где требуется ваше участие.',
    },
    resumeIntentTitle: "Продолжить настройку на этом компьютере",
    resumeIntentBody: "Войдите или создайте аккаунт, чтобы продолжить настройку этого компьютера для выбранного Relay.",
    openSetupAction: "Настроить этот компьютер",
    openSetupWizardAction: "Открыть мастер настройки",
    openSetupWizardSubtitle: "Используйте пошаговую настройку, чтобы настроить Happier на вашем компьютере.",
    setupNewMachineAction: "Настроить новую машину",
    setupNewRelayAction: "Настроить новый Relay",
    remoteHosts: {
      hostPickerTitle: "Удалённый хост",
      hostPickerSubtitle: "Используйте сохранённый профиль SSH или добавьте новый.",
      newHostOption: "Новый хост…",
      saveHostTitle: "Сохранить этот хост",
      saveHostSubtitle: "Сохранить этот профиль SSH в аккаунте.",
      savePasswordTitle: "Сохранить пароль",
      savePasswordSubtitle: "Хранить пароль SSH зашифрованным.",
      savePrivateKeyTitle: "Сохранить приватный ключ",
      savePrivateKeySubtitle: "Хранить приватный ключ SSH зашифрованным.",
      privateKeyLabel: "Приватный ключ",
    },
    remoteSshChecklist: {
      planTitle: "Проверьте план настройки",
      planSubtitleMachine: "Этот план устанавливает удалённую CLI, настраивает Relay и устанавливает фоновую службу.",
      planSubtitleRelayHost: "Этот план устанавливает удалённую CLI, настраивает Relay и устанавливает runtime Relay.",
      executionTitle: "Настройка удалённой машины",
      executionSubtitle: "Чек‑лист ниже обновляется по мере выполнения удалённого bootstrap.",
      completeTitle: "Удалённая машина готова",
      completeSubtitleMachine: "Настройка удалённой машины успешно завершена.",
      trustHostTitle: "Доверять SSH‑хосту",
      trustHostSubtitle: "Проверьте отпечаток удалённой машины перед подключением.",
      trustHostDetails: "Мы проверяем ключ SSH‑хоста и отклоняем неожиданные отпечатки, пока вы явно не подтвердите доверие.",
      installCliTitle: "Установить Happier CLI",
      installCliSubtitle: "Скопировать Happier CLI на удалённую машину.",
      installCliDetails: "Удалённой машине нужна Happier CLI, чтобы выполнить остальные шаги bootstrap.",
      configureRelayTitle: "Настроить Relay",
      configureRelaySubtitle: "Указать удалённой машине активный Relay и веб‑приложение.",
      configureRelayDetails: "Удалённая CLI настраивается для работы с активным Relay и аутентификации этой машины в вашем аккаунте.",
      installDaemonTitle: "Установить фоновую службу",
      installDaemonSubtitle: "Держать Happier запущенным в фоне на удалённой машине.",
      installDaemonDetails: "Фоновая служба сохраняет подключение удалённой машины и готовность для будущих сессий.",
      startFailed: "Не удалось начать удалённую настройку SSH.",
      continueFailed: "Не удалось продолжить удалённую настройку SSH.",
    },
    confirmSwitchRelayTitle: "Сменить Relay?",
    confirmSwitchRelaySubtitle: "Использовать этот Relay как активный. Можно изменить позже в настройках.",
    confirmSwitchRelayKeepTitle: "Оставить текущий Relay",
    confirmSwitchRelayKeepSubtitle: "Продолжить без смены Relay сейчас",
    confirmSwitchRelaySwitchTitle: "Сменить на этот Relay",
    confirmSwitchRelaySwitchSubtitle: "На новом Relay может потребоваться снова войти",
    confirmSwitchRelayWarning: "Вы можете изменить relay позже в Настройки → Relay.",
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
	    failedToCopyToClipboard: "Не удалось скопировать в буфер обмена",
	  },

    machine: {
    offlineUnableToSpawn: "Запуск отключён: машина офлайн",
    offlineHelp:
      "• Убедитесь, что компьютер онлайн\n• Выполните `happier daemon status` для диагностики\n• Используете последнюю версию CLI? Выполните `happier self update`",
    launchNewSessionInDirectory: "Запустить новую сессию в папке",
    customPathPlaceholder: "Введите свой путь",
    tools: {
      title: "Инструменты",
      installablesTitle: "Устанавливаемые",
      installablesSubtitle:
        "Управляйте устанавливаемыми инструментами для этой машины.",
    },
    installables: {
      screenTitle: "Устанавливаемые",
      aboutGroupTitle: "О разделе",
      aboutSubtitle:
        "Управляйте инструментами, которые Happier может устанавливать и поддерживать в актуальном состоянии на этой машине.",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title} (экспериментально)`,
      autoInstallTitle: "Автоустановка при необходимости",
      autoInstallSubtitle:
        "Устанавливает в фоне, когда это требуется для выбранного бэкенда (best‑effort).",
      autoUpdateTitle: "Автообновление",
      autoUpdatePromptTitle: "Автообновление",
      autoUpdatePromptBody:
        "Выберите, как Happier должен обрабатывать обновления для этого устанавливаемого элемента.",
      autoUpdateModes: {
        off: "Выключено",
        notify: "Уведомлять",
        auto: "Авто",
      },
    },
    daemon: "Демон",
    status: "Статус",
    daemonStatus: {
      unknown: "Неизвестно",
      stopped: "Остановлен",
      likelyAlive: "Вероятно, работает",
    },
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
      actions: {
        removeMachine: "Удалить машину",
        removeMachineSubtitle:
          "Отзывает доступ этой машины и удаляет её из вашего аккаунта.",
        removeMachineConfirmBody:
          "Это отзовёт доступ с этой машины (включая ключи доступа и назначения автоматизаций). Вы сможете подключиться позже, снова войдя через CLI.",
        removeMachineAlreadyRemoved:
          "Эта машина уже удалена из вашего аккаунта.",
      },
      replacementRepair: {
        replaceWithMachine: "Отметить как заменённую",
        replaceWithMachineSubtitle: ({ machine }: { machine: string }) =>
          `Использовать ${machine} как замену для этой машины.`,
        chooseReplacementSubtitle: "Выберите машину, которая заменяет эту.",
        pickerTitle: "Выберите заменяющую машину",
        pickerCandidatesTitle: "Подходящие машины",
        confirmTitle: "Отметить машину как заменённую?",
        confirmBody: ({ machine }: { machine: string }) =>
          `Будущие запуски и старые сессии этой машины будут использовать ${machine}.`,
        confirmAction: "Заменить",
        undo: "Отменить замену",
        undoSubtitle: ({ machine }: { machine: string }) =>
          `Эта машина сейчас заменена на ${machine}.`,
        undoConfirmTitle: "Отменить замену машины?",
        undoConfirmBody:
          "Эта машина снова появится как цель запуска, если она доступна.",
        undoAction: "Отменить",
        error: "Не удалось обновить замену машины.",
      },
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
    detectedCliDetected: "Обнаружено",
    detectedCliNotDetected: "Не обнаружено",
    detectedCliUnknown: "Неизвестно",
    detectedCliNotSupported: "Не поддерживается (обновите @happier-dev/cli)",
    untitledSession: "Безымянная сессия",
    back: "Назад",
    notFound: "Машина не найдена",
    unknownMachine: "неизвестная машина",
    unknownPath: "неизвестный путь",
    previousSessionsTitle: "Предыдущие сессии (до 5 последних)",
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
      remoteSessionModeTitle: "Режим удалённой сессии",
      remoteSessionModeOverrideTitle: "Переопределить глобальный режим Windows-сессии",
      remoteSessionModeOverrideEnabledSubtitle:
        "Эта машина использует собственный режим удалённой сессии Windows.",
      remoteSessionModeOverrideDisabledSubtitle:
        "Эта машина использует ваш глобальный режим удалённой сессии Windows.",
      windowsTerminalUnavailableSuffix: "Windows Terminal не обнаружен на этой машине.",
    },

    backgroundServiceModes: {
      generic: "фоновая служба",
      defaultFollowing: "фоновая служба по умолчанию",
      legacyPinned: "устаревшая закреплённая фоновая служба",
    },
    backgroundServicePrompt: {
        targetServer: 'Целевой сервер',
        targetReleaseChannel: 'Целевой канал релиза',
        existingServices: 'Существующие службы:',
        running: 'запущена',
    },
    repairBackgroundServiceAction: "Восстановить фоновую службу",
    repairBackgroundServiceProgressTitle: "Восстанавливаем фоновую службу",
    runtimeInventory: 'Инвентарь рантайма Happier',
    runtimeInventoryOverview: 'Обзор',
    runtimeInventoryInstallations: 'Установки',
    runtimeInventoryServices: 'Сервисы',
    runtimeInventoryWarnings: 'Предупреждения',
    doctorRepairSummary: 'Сводка исправления',
    doctorRepairFindingsSummary: ({ total, warning, error, actionable }: {
        total: number;
        warning: number;
        error: number;
        actionable: number;
    }) => `${total} находок • ${warning} предупреждений • ${error} ошибок • ${actionable} можно исправить`,
    localRelays: 'Локальные Relay',
    runtimeSummary: ({ cliVersion, daemonVersion, daemonRing, installationCount, serviceCount, warningCount }: {
        cliVersion: string;
        daemonVersion: string;
        daemonRing: string;
        installationCount: number;
        serviceCount: number;
        warningCount: number;
    }) => `CLI ${cliVersion} • daemon ${daemonVersion} (${daemonRing}) • ${installationCount} installations • ${serviceCount} services • ${warningCount} warnings`,
    transferExposure: {
      title: "Публикация передачи",
      status: "Публикация передачи",
      loopbackHttp: "Loopback (локально)",
      tailscaleServeHttps: "Tailscale Serve (HTTPS)",
      stateUnknown: "Неизвестно",
      stateDisabled: "Отключено",
      stateUnconfigured: "Не настроено",
      stateApprovalNeeded: "Требуется подтверждение",
      stateInactive: "Настроено (неактивно)",
      stateStale: "Настроено (устарело)",
      stateActive: "Активно",
      stateUnavailable: "Недоступно",
    },},

  message: {
    switchedToMode: ({ mode }: { mode: string }) =>
      `Переключено в режим ${mode}`,
    discarded: "Отброшено",
    recoveredHistory: "Восстановленная история",
    unknownEvent: "Неизвестное событие",
    runtimeConfigOutcomeAppliesBeforeNextMessage: 'Применится перед вашим следующим сообщением',
    runtimeConfigOutcomeQueuedUntilReady: 'В очереди до готовности',
    runtimeConfigOutcomeAlreadySet: 'Уже установлено',
    runtimeConfigOutcomeSessionMode: 'Режим сессии',
    runtimeConfigOutcomeKeyModel: 'Модель',
    runtimeConfigOutcomeKeyFallbackModel: 'Резервная модель',
    runtimeConfigOutcomeKeyPermissionMode: 'Режим разрешений',
    runtimeConfigOutcomeKeyReasoningEffort: 'Уровень рассуждений',
    runtimeConfigOutcomeKeyMaxThinkingTokens: 'Бюджет рассуждений',
    runtimeConfigOutcomeKeyLaunchOption: 'Параметр запуска',
    runtimeConfigOutcomeRequiresRestart: 'Требуется перезапуск',
    runtimeConfigOutcomeRequiresInteractiveControl: 'Требуется действие в терминале',
    runtimeConfigOutcomeUnsupported: 'Не поддерживается',
    runtimeConfigOutcomeFailed: 'Не удалось применить',
    contextCompactionStarted: "Сжатие контекста...",
    contextCompactionCompleted: "Контекст сжат",
    contextCompactionFailed: "Не удалось сжать контекст",
    contextCompactionCancelled: "Сжатие контекста отменено",
    contextCompactionPaused: "Контекст сжат; отправьте сообщение, чтобы продолжить",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Лимит использования достигнут до ${time}`,
    connectedServiceAccountSwitch: ({ provider, from, to }: { provider: string; from: string; to: string }) =>
      `Аккаунт ${provider} переключен с ${from} на ${to}`,
    connectedServiceGroupAccountSwitch: ({ provider, group, from, to }: { provider: string; group: string; from: string; to: string }) =>
      `Группа ${group} для ${provider} переключена с ${from} на ${to}`,
    connectedServiceSwitchGroupSelection: ({ group, profile }: { group: string; profile: string }) =>
      `группа ${group} · ${profile}`,
    connectedServiceSwitchProfileSelection: ({ profile }: { profile: string }) => `профиль ${profile}`,
    connectedServiceSwitchDeferred: 'Переключение аккаунта отложено до границы хода',
    connectedServiceSwitchDeferredIdle: 'Переключение аккаунта отложено до простоя сессии',
    connectedServiceSwitchDeferralCompleted: 'Переключение аккаунта готово',
    connectedServiceSwitchDeferralCancelled: 'Переключение аккаунта отменено',
    connectedServiceSwitchDeferralSuperseded: 'Переключение аккаунта заменено более новым',
    agentStateSharingDegraded: 'Совместное использование состояния провайдера применено частично',
    agentQuotaWait: ({ time }: { time: string }) =>
      `Ожидание сброса квоты провайдера в ${time}`,
    agentQuotaRecovered: "Квота провайдера восстановлена",
    connectedServiceRuntimeAuthRecoveryRecovered: "Аутентификация провайдера восстановлена",
    connectedServiceRuntimeAuthRecoveryCancelled: "Восстановление аутентификации провайдера отменено",
    unknownTime: "неизвестное время",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "Разрешения отображаются только в терминале. Сбросьте их или отправьте сообщение, чтобы управлять из приложения.",
    sessionRunningLocally:
      "Эта сессия запущена локально на этом компьютере. Вы можете переключиться на удалённый режим, чтобы управлять из приложения.",
    sessionRunningLocallyAndRemotely:
      "Эта сессия локально подключена в OpenCode и по-прежнему управляется из приложения.",
    switchingToRemote: "Переключение в удалённый режим…",
    switchToRemote: "Переключиться на удалённый",
    detachLocalTerminal: "Отсоединить терминал",
    directSessionTakeoverAvailable:
      "Эта прямая сессия доступна на вашей машине. Возьмите её под контроль в Happier, чтобы управлять ею здесь.",
    directSessionMachineOffline:
      "Эта прямая сессия сейчас недоступна, потому что машина офлайн.",
    switchingToDirectTakeover: "Берём эту прямую сессию под контроль…",
    switchingToPersistedTakeover: "Берём сессию под контроль и импортируем её…",
    takeOverDirect: "Взять под контроль",
    takeOverPersist: "Взять под контроль и импортировать",
    directTakeoverDialogTitle: "Продолжить эту прямую сессию в Happier?",
    directTakeoverDialogBody: "Выберите, как Happier должен взять управление. Прямой режим продолжает использовать стенограмму провайдера. Импорт переносит стенограмму в Happier.",
    directTakeoverDialogDirectTitle: "Взять под контроль",
    directTakeoverDialogDirectBody: "Управляйте этой сессией в Happier без импорта стенограммы в Happier.",
    directTakeoverDialogPersistTitle: "Взять под контроль и импортировать",
    directTakeoverDialogPersistBody: "Импортируйте стенограмму в Happier и продолжайте с полным набором возможностей сеанса Happier.",
    directTakeoverDialogForceStopTitle: "Сначала попробовать остановить локальный процесс",
    directTakeoverDialogForceStopBody: "Happier обнаружил доверенный локальный процесс для этой сессии. Включите это, если хотите, чтобы Happier остановил его перед захватом.",
    directTakeoverForceStopConfirmTitle: "Сначала остановить локальный процесс?",
    directTakeoverForceStopConfirmBody: "Happier обнаружил доверенный локальный процесс для этой прямой сессии. Остановить его перед захватом здесь?",
    directTakeoverForceStopConfirmAction: "Остановить и взять под контроль",

    externalSessionTakeoverAvailable:
      "Эта внешняя сессия готова к перехвату управления в Happier.",
    externalSessionMachineOffline:
      "Эта внешняя сессия сейчас недоступна, потому что машина не в сети.",
    checkingExternalSessionTakeover: "Проверяем варианты перехвата…",
    externalSessionStatusUnavailable: "Happier не удалось проверить внешнюю сессию. Проверьте подключение машины и повторите попытку.",
    externalSessionProcessRunning: "Похоже, Agent этой внешней сессии всё ещё работает.",
    externalSessionRecheck: "Проверить снова",
    externalSessionTakeoverBlocked: "Happier не удалось подтвердить остановку внешнего Agent. Остановите его в терминале и повторите попытку.",},

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "Да, разрешить глобально",
        yesForSession: "Да, и не спрашивать для этой сессии",
        stop: "Остановить",
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
        stop: "Остановить",
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
      diffLabel: "Дифф",
      codeLabel: "Код",

      // Slash menu commands (Lane G)
      slash: {
          heading1: { label: 'Заголовок 1', description: 'Большой заголовок' },
          heading2: { label: 'Заголовок 2', description: 'Средний заголовок' },
          heading3: { label: 'Заголовок 3', description: 'Малый заголовок' },
          bulletList: { label: 'Маркированный список', description: 'Неупорядоченный список' },
          orderedList: { label: 'Нумерованный список', description: 'Упорядоченный список' },
          taskList: { label: 'Список задач', description: 'Список с флажками' },
          blockquote: { label: 'Цитата', description: 'Блок цитаты' },
          codeBlock: { label: 'Блок кода', description: 'Блок кода' },
          horizontalRule: { label: 'Разделитель', description: 'Горизонтальная линия' },
          groups: { headings: 'Заголовки', lists: 'Списки', blocks: 'Блоки' },
      },

      // Link bubble (Lane H)
      linkBubble: {
          open: 'Открыть',
          edit: 'Изменить',
          unlink: 'Удалить ссылку',
          cancel: 'Отмена',
          save: 'Сохранить',
          inputPlaceholder: 'Вставьте или введите ссылку…',
      },
    },

    // Accessibility labels for the rich markdown editor formatting toolbar.
    markdownEditorToolbar: {
      bold: "Полужирный",
      italic: "Курсив",
      strikethrough: "Зачёркнутый",
      code: "Встроенный код",
      heading1: "Заголовок 1",
      heading2: "Заголовок 2",
      heading3: "Заголовок 3",
      bulletList: "Маркированный список",
      orderedList: "Нумерованный список",
      taskList: "Список задач",
      blockquote: "Цитата",
      codeBlock: "Блок кода",
      horizontalRule: "Разделитель",
      openLink: "Открыть ссылку",
      unlink: "Удалить ссылку",
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
    emptyTitle: "Нет активности друзей",
    emptyDescription: "Добавьте друзей, чтобы делиться сессиями и видеть активность здесь.",
    activity: "Активность",
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
    noData: {
      title: "Данные об использовании недоступны",
      subtitle: "Данные об использовании появятся здесь после первого сеанса.",
    },
    errors: {
      notAuthenticated: "Войдите, чтобы просматривать использование.",
      failedToLoad: "Не удалось загрузить данные об использовании.",
    },

    lastYear: "Последний год",
    costMode: "Режим стоимости",
    auto: "Авто",
    reported: "По данным",
    estimated: "Оценочно",
    insights: "Аналитика",
    activity: "Активность",
    timeline: "Хронология",
    leaders: "Лидеры",
    activeDays: "Активные дни",
    modelsTried: "Опробованные модели",
    favoriteModelChanges: "Изменения любимой модели",
    busiestWindow: "Самый активный период",
    activityCalendarSubtitle: "Тепловая карта календаря",
    mostActiveMonths: "Самые активные месяцы выбранного периода",
    dailyActivity: "Ежедневная активность за выбранный период",
    mostActiveWeekdays: "Самые активные дни недели",
    mostActiveHours: "Самые активные часы дня",
    events: "событий",
    source: "Источник",
    sessionUsage: "Использование сессии",
    longestStreak: 'Самая длинная серия',
    dailyRhythm: 'Суточный ритм',
    eventsLabel: 'События',
    daysShort: ({ count }: { count: number }) => `${count}d`,
    updatedCaption: 'Обновлено только что',
    whenYouWork: 'Когда вы работаете',
    periodTodayShort: 'Сегодня',
    period7dShort: '7д',
    period30dShort: '30д',
    periodYearShort: '1г',
    busiestTag: 'пик',
    vsPreviousPeriod: 'к предыдущему периоду',
    workRhythm: 'Ритм работы',
    weeks: "Недели",
    messagesCaption: ({ count }: { count: number }) => `${count.toLocaleString()} сообщений`,
    modelMix: {
        title: "Состав моделей во времени",
        other: "Другое",
    },
    showAll: 'Показать все',
    showLess: 'Показать меньше',
    exportCsv: 'Скачать CSV',
    efficiency: {
        cacheHitRate: 'Доля попаданий в кэш',
        cacheHitCaption: 'Доля входных токенов, полученных из кэша',
        costPerMtok: 'Стоимость за Mtok',
        costPerMtokCaption: 'Эффективная средняя ставка за миллион токенов',
    },

    cacheSavings: 'Экономия кэша',
    banner: {
        lifetimeTokens: 'Токенов за всё время',
        peakTokens: 'Пиковые токены',
        tokenActivity: 'Активность токенов',
        daily: 'По дням',
        weekly: 'По неделям',
        cumulative: 'Накопительно',
        activityInsights: 'Статистика активности',
        mostUsed: 'Чаще всего',
        days: ({ count }: { count: number }) => `${count} дн.`,
    },
    tokenMix: {
        input: 'Ввод',
        output: 'Вывод',
        reasoning: 'Рассуждение',
        cacheRead: 'Чтение кэша',
        cacheWrite: 'Запись кэша',
    },
    recap: {
        play: 'Смотреть итоги',
        shareImage: 'Поделиться изображением',
    },
    context: {
        title: 'Контекст и эффективность',
        utilization: 'Использовано контекста',
        window: 'Окно',
        tokenMixTitle: 'Состав токенов',
    },
    summary: {
      title: "Сводка использования",
      currentStreak: "Текущая серия",
      currentStreakSubtitle: ({ count }: { count: number }) => `${count} active days in the last 30`,
      currentStreakSubtitleForPeriod: ({ count, period }: { count: number; period: string }) => `${count} active days · ${period}`,
      thisWeek: "Эта неделя",
      thisWeekSubtitle: "Недавний темп",
      topModel: "Основная модель",
      engine: "Движок",
      export: {
        session: "Сессия",
        period: "Период",
        metric: "Метрика",
        costMode: "Режим стоимости",
        totalTokens: "Всего токенов",
        totalCost: "Общая стоимость",
        activeDays: "Активные дни",
        topModel: "Основная модель",
        topEngine: "Основной движок",
        modelTimeline: "Хронология моделей",
        engineTimeline: "Хронология движков",
      },
    },},

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
      valueExample: "ск-...",
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
      geminiApiKey: "Gemini (ключ API)",
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
    defaultPermissionMode: {
      title: "Режим разрешений по умолчанию",
      descriptions: {
        default: "Запрашивать разрешения",
        acceptEdits: "Авто-одобрять правки",
        plan: "Планировать перед выполнением",
        bypassPermissions: "Пропускать все разрешения",
      },
    },
    defaultPermissions: {
      title: "Разрешения по умолчанию",
      footer:
        "Переопределяет разрешения по умолчанию на уровне аккаунта для новых сессий, когда выбран этот профиль.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `По умолчанию для аккаунта: ${label}`,
      useAccountDefault: "Использовать значение аккаунта",
      currently: ({ label }: { label: string }) => `Сейчас: ${label}`,
    },
    defaultStorage: {
      title: "Тип сеанса по умолчанию",
      footer: "Переопределяет тип сеанса Happier/прямого сеанса по умолчанию на уровне учетной записи для новых сеансов, когда выбран этот профиль.",
      accountDefaultSubtitle: ({ label }: { label: string }) => `Account default: ${label}`,
      useAccountDefault: "Использовать учетную запись по умолчанию",
      currently: ({ label }: { label: string }) => `Currently: ${label}`,
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
      kiroSubtitleExperimental: "Kiro CLI (экспериментально)",
      customAcpSubtitleExperimental: "Пользовательский ACP CLI (экспериментально)",
      piSubtitleExperimental: "Pi CLI (экспериментально)",
      copilotSubtitleExperimental: "GitHub Copilot CLI (экспериментально)",
      cursorSubtitleExperimental: "CLI Cursor Agent (экспериментально)",

      ohMyPiSubtitleExperimental: "oh-my-pi CLI (экспериментально)",},
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

    projects: {
    emptyTitle: "Проектов пока нет",
    emptyDescription: "Проекты позволяют просматривать и редактировать файлы, а также использовать Git на ваших машинах вне сессий.",
    groups: {
      pinned: "Закреплённые",
      addFirst: "Добавить проект",
    },
    actions: {
      addProjectToMachine: "Добавить проект на эту машину",
      addProject: "Добавить проект",
      addProjectOnMachine: ({ machine }: { machine: string }) => `Добавить проект на ${machine}`,
      chooseProjectFolderOnMachine: ({ machine }: { machine: string }) => `Выберите папку на ${machine}`,
      chooseProjectFolderSubtitle: "Добавьте её как проект, чтобы просматривать и редактировать файлы, а также использовать Git.",
      pin: "Закрепить",
      unpin: "Открепить",
      remove: "Удалить",
    },
    sourceControl: {
      noSessionAvailableDetails: "Запустите сессию в этой папке, чтобы включить управление версиями в Проектах.",
    },
    details: {
      emptyBody: "Откройте Файлы или Управление версиями, чтобы просматривать здесь файлы и различия.",
      placeholderFileBody: "Предпросмотр файла «{title}» появится здесь.",
      placeholderScmReviewBody: "Предпросмотры изменений появятся здесь.",
      placeholderCommitBody: "Сведения о коммите появятся здесь.",
      placeholderUnsupportedBody: "Эта вкладка деталей пока не поддерживается в Проектах.",
    },
    detail: {
      notFoundTitle: "Проект не найден",
      notFoundDescription: "Этот проект мог быть удалён или принадлежит другому серверу.",
      missingWorktreeRecovered: "Выбранный worktree больше не существует. Выполнен возврат к корню проекта.",
      groupTitle: "Проект",
      fields: {
        name: "Имя",
        machine: "Машина",
        path: "Путь",
      },
      comingSoonGroupTitle: "Скоро",
      comingSoonFooter:
        "Файлы, управление версиями, изменения и терминал появятся здесь на следующем этапе рефакторинга.",
      comingSoon: {
        filesAndScmTitle: "Файлы и управление версиями",
        filesAndScmSubtitle:
          "Этот экран повторно использует существующую боковую панель и панели деталей, но в рамках рабочей области, а не сессии.",
      },
    },
  },
    settingsPlugins: {
    title: "Каталог плагинов",
    subtitle: "Просматривайте отобранные дескрипторы плагинов и управляйте установленными плагинами на этом устройстве.",
    appPanelsTitle: "Панели плагинов",
    appPanelsSubtitle: "Открывайте панели приложения, добавленные установленными плагинами.",
    readOnlySnapshot: "Пока это устройство отключено, сведения о плагинах из кэша доступны только для чтения. Подключите устройство снова, чтобы управлять плагинами.",
    viewSelectorLabel: "Представления управления плагинами",
    views: { installed: "Установленные", discover: "Обзор", development: "Разработка", diagnostics: "Диагностика" },
    developmentTitle: "Разработка",
    developmentFooter: "Одобренные локальные источники и диагностика разработки, сообщённые этим устройством.",
    developmentEmpty: "Источники разработки не сообщены",
    developmentEmptySubtitle: "Это устройство не сообщило об одобренных локальных источниках или диагностике наблюдения и перезагрузки.",
    developmentCreate: "Создать плагин",
    developmentCreateSubtitle: "Создаёт локальный шаблон плагина на этом компьютере.",
    developmentCreateSucceeded: "Шаблон плагина создан.",
    developmentCreateDirectoryTitle: "Папка плагина",
    developmentCreateDirectoryBody: "Введите новую абсолютную папку на выбранном компьютере. Папка ещё не должна существовать.",
    developmentCreateNameTitle: "Название плагина",
    developmentCreateNameBody: "Введите отображаемое название плагина.",
    developmentCreateIdTitle: "ID плагина",
    developmentCreateIdBody: "Введите строчное пространство имён владельца с точками, не относящееся к happier.*.",
    developmentCreateConfirmTitle: "Создать шаблон плагина?",
    developmentCreateConfirmBody: ({ pluginId, targetDir }: { pluginId: string; targetDir: string }) => `Создать ${pluginId} в ${targetDir}?`,
    developmentWatchConfigured: "Разрешение на наблюдение настроено",
    developmentReloadClear: "Текущих диагностик перезагрузки нет",
    developmentReloadAttention: "Диагностика перезагрузки требует внимания",
    developmentTest: "Проверить плагин",
    developmentTestSubtitle: "Проверяет собранную точку входа в управляемой среде Happier.",
    developmentTestSucceeded: "Проверка плагина пройдена.",
    developmentPack: "Упаковать плагин",
    developmentPackSubtitle: "Создаёт проверенный установочный архив рядом с одобренной папкой исходников.",
    developmentPackSucceeded: "Пакет создан рядом с папкой исходников.",
    diagnosticsSnapshotTitle: "Диагностика",
    diagnosticsSnapshotFooter: "Текущая диагностика, сообщённая реестром плагинов на этом устройстве.",
    diagnosticsSnapshotEmpty: "Нет текущей диагностики плагинов",
    diagnosticsSnapshotEmptySubtitle: "Текущая диагностика реестра появится здесь, когда устройство сообщит её.",
    catalogUrlLabel: "URL каталога",
    loadCatalog: "Загрузить каталог",
    installAndTrust: "Установить и доверять",
    marketplaceWithdrawnTitle: "Удалено из маркетплейса",
    marketplaceWithdrawnBody: "Эта публикация удалена из выбранного маркетплейса. Новые установки и обновления заблокированы.",
    marketplaceWithdrawnInstalledBody: "Эта публикация удалена из выбранного маркетплейса. Новые установки и обновления заблокированы. Установленный плагин останется включённым, пока вы не отключите или не удалите его.",
    trustPolicy: {
      localTrusted: "Локально доверенный",
      trusted: "Доверенный",
      prompt: "Требуется подтверждение",
      untrusted: "Недоверенный",
    },
    sourceKind: {
      bundled: "Встроенный",
      path: "Локальный путь",
      marketplace: "Маркетплейс",
      package: "Реестр пакетов",
      archive: "Архив",
      catalog: "Каталог",
    },
    unknownValue: ({ value }: { value: string }) => `Другое: ${value}`,
    emptySubtitle: "Этот каталог не вернул дескрипторов.",
    detailTitle: "Сведения о плагине",
    provenanceTitle: "Источник и доверие",
    diagnosticsTitle: "Диагностика плагина",
    registryDiagnosticsTitle: "Диагностика реестра",
    contributionsTitle: "Спроецированные расширения",
    unsupportedDescriptorField: "Это поле дескриптора не поддерживается этой версией Happier.",
    noDescriptors: "Для этого раздела нет спроецированных дескрипторов, отображаемых хостом.",
    marketplaceInstallReviewTitle: ({ name, version }: { name: string; version: string }) => `Установить и доверять ${name} ${version}?`,
    marketplaceInstallReviewBody: ({ identity, verification, executableRealms, contributions, uiArtifacts, requiredAccess, optionalAccess, compatibility }: { identity: string; verification: string; executableRealms: string; contributions: string; uiArtifacts: string; requiredAccess: string; optionalAccess: string; compatibility: string }) => `Идентификация:\n${identity}\n\nСигналы проверки:\n${verification}\n\nИсполняемый код: ${executableRealms}\nВозможности: ${contributions}\nАртефакты интерфейса: ${uiArtifacts}\n\nДоверенный код демона и React Native выполняется с полномочиями приложения или процесса и может напрямую использовать файлы, сеть, окружение и процессы. Указанный ниже доступ к хосту описывает сервисы, посредником для которых выступает Happier; это не песочница для исполняемого кода плагина.\n\nОбязательные раскрытия и кооперативные сервисы:\n${requiredAccess}\n\nНеобязательные ресурсы хоста (по умолчанию отключены):\n${optionalAccess}\n\nСовместимость и обновления:\n${compatibility}`,
    marketplaceInstallDecisionFailed: ({ outcome }: { outcome: string }) => `Плагин не установлен (${outcome}).`,
    marketplaceChangeDecisionFailed: ({ action, outcome }: { action: string; outcome: string }) => `${action}: сбой (${outcome}).`,
    pluginChangeConfirmBody: ({ action, name }: { action: string; name: string }) => `Подтвердите «${action}» для ${name}.`,
    forgetTrust: "Забыть доверие",
    rollback: "Откатить",
    uninstall: "Удалить плагин",
    marketplaceUpdateVersion: ({ installedVersion, availableVersion }: { installedVersion: string; availableVersion: string }) => `Обновить с версии ${installedVersion} до ${availableVersion}.`,
    marketplaceCommunityUnreviewedTitle: "Непроверенный код сообщества",
    marketplaceCommunityUnreviewedBody: "Этот сторонний npm-пакет не проверен Happier. «Установить и доверять» разрешает объявленный исполняемый код и доступ к хосту после проверки демоном точной версии и целостности. Доверенный код демона и React Native выполняется с полномочиями приложения или процесса; указанный доступ к хосту не является песочницей.",
    genericSettingsTitle: "Настройки плагина",
    genericSettingsFooter: "Хранятся локально для этого плагина на этой машине.",
    genericSettingsLoading: "Загрузка настроек плагина",
    genericSettingsUnavailable: "Настройки плагина недоступны для этой машины.",
    genericSettingsLoadError: "Не удалось загрузить настройки плагина.",
    genericSettingsSaveError: "Не удалось сохранить настройку плагина.",
    genericSettingsEmpty: "Этот плагин не предоставил редактируемых настроек.",
    registriesTitle: "Частные реестры npm",
    registriesFooter: "Вход в реестр управляет только доступом к пакетам. Установленные доверенные плагины останутся доступны после удаления реестра или выхода из него.",
    registriesAdd: "Добавить реестр",
    registriesAddTitle: "Добавить частный реестр",
    registriesAddOriginBody: "Введите HTTPS-адрес реестра без учётных данных.",
    registriesInvalidOriginTitle: "Недопустимый адрес реестра",
    registriesInvalidOriginBody: "Используйте HTTPS-адрес без учётных данных, пути, запроса и фрагмента.",
    registriesNameTitle: "Название реестра",
    registriesNameBody: "Выберите название, отображаемое только в настройках Happier.",
    registriesScopesTitle: "Области пакетов",
    registriesScopesBody: "Необязательные области через запятую, направляемые в этот реестр.",
    registriesScopesPlaceholder: "@company-ru, @team-ru",
    registriesDefaultTitle: "Реестр пакетов по умолчанию",
    registriesDefaultBody: "Использовать этот реестр для пакетов без области, не направленных в другой настроенный источник?",
    registriesUseAsDefault: "Использовать по умолчанию",
    registriesScopedOnly: "Только пакеты с областью",
    registriesPrivateNetworkTitle: "Доступ к частной сети",
    registriesPrivateNetworkBody: "Разрешить этому адресу реестра указывать на частные или локальные сетевые адреса? Оставьте выключенным для интернет-реестров.",
    registriesAllowPrivateNetwork: "Разрешить частную сеть",
    registriesPublicOnly: "Только публичные адреса",
    registriesLogin: "Войти",
    registriesLoginTitle: "Токен реестра",
    registriesLoginBody: "Вставьте токен этого реестра. Он шифруется на выбранной машине и не хранится в приложении.",
    registriesLogout: "Выйти",
    registriesEdit: "Изменить реестр",
    registriesTest: "Проверить подключение",
    registriesMarketplaceBindingsTitle: "Привязки реестров маркетплейса",
    registriesMarketplaceBind: ({ profile, source }: { profile: string; source: string }) => `Использовать ${profile} для ${source}`,
    registriesMarketplaceUnbind: ({ source }: { source: string }) => `Не использовать частный реестр для ${source}`,
    registriesRemove: "Удалить реестр",
    registriesRemoveTitle: "Удалить частный реестр?",
    registriesRemoveBody: ({ name }: { name: string }) => `Удалить ${name}? Установленные плагины останутся установленными и доверенными; будущие загрузки и обновления из этого реестра будут приостановлены.`,
    registriesAvailability: {
      unknown: "Не проверено",
      available: "Доступно",
      sign_in_required: "Требуется вход",
      offline: "Не в сети",
    },
    registriesUpdatePaused: "Обновления приостановлены",
    registriesPauseReason: {
      credentials_missing: "Отсутствуют учётные данные реестра",
      authentication_failed: "Ошибка аутентификации реестра",
      profile_removed: "Профиль реестра удалён",
      offline: "Реестр не в сети",
    },
    registriesErrorTitle: "Операция с реестром не выполнена",
    registriesErrorBody: "Обновите список реестров и повторите попытку.",
    registriesInvalidProfileTitle: "Недопустимые настройки реестра",
    registriesInvalidProfileBody: "Проверьте название реестра и области пакетов, затем повторите попытку.",
    registriesNoMachine: "Выберите машину для управления частными реестрами.",
    registriesLoadError: "Не удалось загрузить настройки частного реестра.",
    registriesEmpty: "Частные реестры не настроены.",
  },
    settingsScmDiffSummary: {
  title: 'Сводки diff',
  enabledTitle: 'Включить сводки diff',
  enabledSubtitle: 'Разрешает AI-сводки для изменений системы контроля версий.',
  prefetchTitle: 'Предзагружать сводки',
  prefetchSubtitle: 'Генерирует сводки заранее только при включенной настройке.',
  modelOverrideTitle: 'Модель сводки',
  modelOverrideSubtitle: 'Необязательный разрешенный runtime-профиль для сводок diff.',
  modelOverrideDefault: 'Использовать значение runtime по умолчанию',
  cacheTitle: 'Кэш сводок',
  cacheSubtitle: 'Сводки checkpoint повторно используются по квитанции; сводки working tree остаются временными.',
  },
    externalSessions: {
        ...externalSessionOperationTranslations.ru,
        ...externalSessionSettingsTranslations.ru,
        settingsTitle: 'Внешние сессии',
        settingsEntrySubtitle: 'Посмотрите, как Happier работает с сессиями, запущенными вне приложения.',
        settingsSafetyGroupTitle: 'Как это работает',
        settingsPassiveTitle: 'По умолчанию только чтение',
        settingsPassiveSubtitle: 'Открытие этой страницы пассивно. Оно не запускает и не возобновляет Agent, не меняет его настройки, не устанавливает хуки и не начинает отслеживание сессии.',
        settingsFollowGroupTitle: 'Пассивное отслеживание',
        settingsRestoreTitle: 'Продолжать пассивное отслеживание после перезапуска',
        settingsRestoreEnabledSubtitle: 'Повторно подключать явно выбранные сессии после перезапуска демона.',
        settingsRestoreDisabledSubtitle: 'Не подключать отслеживаемые сессии после перезапуска демона.',
        settingsRestoreFooter: 'Восстановление только наблюдает за существующим источником Agent. Оно никогда не запускает и не возобновляет Agent.',
        settingsNotificationsTitle: 'Уведомления',
        settingsNotificationsActiveSubtitle: 'Уведомления о готовности применяются только к сессиям с включённым пассивным отслеживанием.',
        settingsNotificationsInactiveSubtitle: 'Включите пассивное отслеживание сессии, чтобы получать её уведомления.',
        settingsActiveFollowsGroupTitle: 'Отслеживание сессий',
        settingsActiveFollowsFooter: 'Каждый выбор применяется только к этой сессии. Другие сессии никогда не включаются автоматически.',
        settingsActiveFollowsEmptyTitle: 'Внешних сессий пока нет',
        settingsActiveFollowsEmptySubtitle: 'Связанные внешние сессии появятся здесь с текущим состоянием отслеживания.',
        settingsFollowToggleHint: 'Запускает или останавливает пассивное фоновое отслеживание этой сессии.',
        followStatusDisabled: 'Не отслеживается',
        followStatusPaused: 'Отслеживание приостановлено',
        followStatusReacquiring: 'Повторное подключение…',
        followStatusActive: 'Активное отслеживание',
        followStatusError: 'Отслеживание требует внимания',
        followStatusUnknown: 'Состояние отслеживания недоступно',
        followStatusMachineOffline: 'Машина не в сети — пассивное отслеживание продолжится после подключения',
        followStatusUnsupported: 'Этот Agent не поддерживает пассивное отслеживание',
        followUpdateFailed: 'Не удалось обновить пассивное отслеживание этой сессии. Повторите попытку.',
    browseTitle: "Просмотр внешних сессий",
    browseOpenExisting: "Просмотр внешних сессий",
    browseActionSubtitle: "Выберите машину, агента и сессию, чтобы открыть её здесь.",
    emptyStateTitle: "Откройте существующую сессию",
    emptyStateDescription: "Открывайте сессии Claude, Codex и OpenCode с ваших подключённых машин.",
    browseFiltersTitle: "Выберите источник",
    browseMachines: "Машины",
    browseAgents: "Агенты",
    browseSources: "Источники",
    browseSourceCodexUserHome: "Мой каталог Codex",
        browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Подключённые сервисы ${service}`,
    browseSourceClaudeDefault: "Стандартная конфигурация Claude",
    browseSourceOpenCodeDefault: "Стандартный сервер OpenCode",
    browseCandidates: "Доступные сессии",
    browseNoMachines: "Для прямых сессий пока нет доступных машин.",
    browseNoCandidates: "Для этой машины и агента внешние сессии не найдены.",
    browseActivityRunning: "Запущена",
        browseActivityRunningNow: "Запущена сейчас",
    browseActivityRecent: "Недавняя",
    browseActivityIdle: "Неактивна",
    browseActivityUnknown: "Неизвестно",
        browseSearchPlaceholder: "Искать среди загруженных сессий…",
        browseNoSearchResults: "Ни одна загруженная сессия пока не соответствует этому поиску.",
    browseIndexing: "Индексирование внешних сессий…",
    browseIndexingProgress: ({ scanned, total }: { scanned: number; total: number }) => `Проиндексировано ${scanned} из ${total} сессий`,
    browseIndexingCancelled: "Индексирование остановлено. Повторите попытку, когда будете готовы.",
    browseLoadMore: "Загрузить ещё сессии",
    browseFailedToLoad: "Не удалось загрузить внешние сессии.",
    browseLinkFailed: "Не удалось привязать выбранную внешнюю сессию.",
  },
    pluginReactNative: {
    unavailable: "React Native UI плагина недоступен",
    disabled: "React Native UI плагина отключен",
    fallback: "Используется fallback плагина",
  },
    pluginRuntime: {
        unavailableGeneric: 'Это представление плагина сейчас недоступно.',
        crashLoop: 'Плагин остановлен после повторных сбоев.',
        disabledByPolicy: 'Это представление плагина отключено текущими настройками или несовместимостью.',
        missingRequirement: 'Для этого представления плагина не хватает требования на этом устройстве.',
    },
    settingsSearch: {
    placeholder: "Поиск настроек",
  },} as const;

export type TranslationsRu = typeof ru;
