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
        name: "Запланированная сессия",
        description: "Что должна делать эта автоматизация?",
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
    actions: "Действия",
    moreActions: "Другие действия",
    moreActionsHint: "Открывает меню с другими действиями",
    cancel: "Отмена",
    close: "Закрыть",
    open: "Открыть",
    done: "Готово",
    reorder: "Упорядочить",
    authenticate: "Авторизация",
    save: "Сохранить",
    saveAs: "Сохранить как",
    error: "Ошибка",
    success: "Успешно",
    ok: "ОК",
    continue: "Продолжить",
    back: "Назад",
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
    expand: "Развернуть",
    collapse: "Свернуть",
    command: "Команда",
    scanning: "Сканирование...",
    urlPlaceholder: "https://example.com",
    home: "Главная",
    message: "Сообщение",
    send: "Отправить",
    attach: "Прикрепить",
    linkFile: "Связать файл",
    files: "Файлы",
    path: "Путь",
    fileViewer: "Просмотр файла",
    loading: "Загрузка...",
    none: "—",
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
  },

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
          placeholder: '{ "capturedAt": "...", ... }',
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
      groupTitle: "Эмбеддинги",
      groupFooter:
        "Необязательно: загрузите локальную модель, чтобы улучшить семантические совпадения в режиме Deep.",
      enableTitle: "Включить эмбеддинги",
      enableSubtitle:
        "Улучшает ранжирование для глубокого поиска (скачает модель при первом использовании)",
      modelTitle: "Модель эмбеддингов",
      promptBody: "Введите id локальной модели transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
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
        groupTitle: "Субагент",
        disabled: {
          footer:
            "Execution runs отключены. Включите Execution Runs в Настройки → Функции, чтобы использовать подсказки для делегирования.",
          enableExecutionRuns: {
            title: "Включить Execution Runs",
            subtitle: "Открыть настройки «Функции»",
          },
        },
        footer:
          "Правила добавляются к системному промпту, чтобы основной агент знал, когда и как вы предпочитаете запускать саб-агентные прогоны.",
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
      },
    },

  settings: {
    title: "Настройки",
    connectedAccounts: "Подключенные аккаунты",
    connectedAccountsDisabled: "Подключённые сервисы отключены.",
    connectAccount: "Подключить аккаунт",
    github: "GitHub",
    machines: "Машины",
    features: "Функции",
    social: "Социальное",
    account: "Аккаунт",
    accountSubtitle: "Управление учетной записью",
    addYourPhone: "Добавить телефон",
    addYourPhoneSubtitle: "Показать QR‑код, чтобы войти на телефоне",
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
      executionRunsSubtitle: "Execution runs на разных машинах",
      connectedServices: "Подключенные сервисы",
      connectedServicesSubtitle: "Подписки Claude/Codex и OAuth‑профили",
      featuresTitle: "Возможности",
      featuresSubtitle: "Включить или отключить функции приложения",
    developer: "Разработчик",
    developerTools: "Инструменты разработчика",
    about: "О программе",
    actionsSettingsAboutSubtitle:
      "Включайте или отключайте действия глобально, по поверхности (UI/голос/MCP) и по размещению (где они отображаются в интерфейсе). Отключённые действия блокируются по принципу fail‑closed во время выполнения.",
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
    servers: "Серверы",
    serversSubtitle: "Сохранённые серверы, группы и значения по умолчанию",
    systemStatus: "Состояние системы",
    systemStatusSubtitle: "Серверы, аккаунт, машины, демон",

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

  systemStatus: {
    sections: {
      appHealth: "Состояние приложения и синхронизации",
      currentServer: "Текущий сервер",
      identity: "Вход в аккаунт",
      configuredServers: "Настроенные серверы",
      machinesActiveServer: "Машины (активный сервер)",
      machinesOtherServer: ({ server }: { server: string }) => `Машины (${server})`,
      actions: "Действия",
    },
    ui: {
      dataReady: "Данные готовы",
      realtime: "В реальном времени",
      socket: "Сокет",
      socketLastError: ({ error }: { error: string }) => `Последняя ошибка: ${error}`,
      lastSync: "Последняя синхронизация",
    },
    server: {
      activeServer: "Активный сервер",
    },
    identity: {
      accountId: "ID аккаунта",
      username: "Имя пользователя",
    },
    servers: {
      noneConfigured: "Серверы не настроены",
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
        loading: "Получаем сервер/аккаунт демона…",
        invalid: "Не удалось прочитать doctor snapshot с машины",
      },
      daemonAttributionUnknown: "Сервер/аккаунт демона: неизвестно",
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
      runDiagnosisSubtitle: "Выявляет несоответствия сервер/аккаунт/демон",
      refreshMachineAttribution: "Обновить атрибуцию демона",
      refreshMachineAttributionSubtitle: "Получить сервер/аккаунт демона для нескольких машин в сети",
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
      activeServer: "Активный сервер",
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
      placeholder: '{ "capturedAt": "...", ... }',
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
    },
    title: "Подключённые сервисы",
    authChip: {
      label: "Авторизация",
      labelWithCount: ({ count }: { count: number }) => `Авторизация: ${count}`,
    },
    list: {
      empty: "Пока нет подключённых сервисов.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "подключённый", few: "подключённых", many: "подключённых" })}`,
      needsReauth: "нужна повторная авторизация",
      notConnected: "не подключено",
    },
    quota: {
      loading: "Загрузка…",
      error: ({ message }: { message: string }) => `Ошибка: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `Обновлено: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Обновлено: ${time} • устарело`,
      noData: "Пока нет данных по квоте",
      planLabel: ({ plan }: { plan: string }) => `План: ${plan}`,
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
      unknownService: "Неизвестный подключённый сервис.",
      actionsGroupTitle: "Действия",
      actions: {
        setDefault: "Сделать по умолчанию",
        unsetDefault: "Снять по умолчанию",
        editLabel: "Редактировать метку",
        reconnect: "Переподключить",
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
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Отключить ${service} (${profileId})?`,
      prompts: {
        profileIdTitle: "ID профиля",
        profileIdBody: "Используйте короткую метку, например work, personal, alt.",
        apiKeyTitle: "API-ключ",
        apiKeyBody: "Вставьте ваш API-ключ Anthropic.",
        apiKeyPlaceholder: "например, sk-ant-…",
        setupTokenTitle: "Токен настройки",
        setupTokenBody: "Вставьте ваш setup-token Claude (из claude setup-token).",
        setupTokenPlaceholder: "например, sk-ant-oat01-…",
        profileLabelTitle: "Метка профиля",
        profileLabelBody: "Необязательно. Показывается в списках авторизации.",
        profileLabelPlaceholder: "Рабочий аккаунт",
      },
      alerts: {
        invalidProfileIdTitle: "Недопустимый ID профиля",
        invalidProfileIdBody:
          "Используйте буквы, цифры, дефис или подчёркивание (макс. 64).",
        unknownProfileTitle: "Неизвестный профиль",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Профиля «${profileId}» не существует для ${service}.`,
      },
      profiles: {
        empty: "Профилей пока нет.",
        connected: "Подключён",
        defaultBadge: "По умолчанию",
        needsReauth: "Нужна повторная авторизация",
      },
    },
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
    },
    authModal: {
      nativeAuthTitle: "Нативная авторизация бэкенда",
      nativeAuthSubtitle: "Используйте локальный логин CLI / API‑ключи",
      connectedServicesTitle: "Использовать подключённые сервисы",
      connectedServicesSubtitle: "Загрузить и материализовать из облака Happier",
      notConnectedTitle: "Не подключено",
      notConnectedSubtitle: "Нажмите, чтобы открыть настройки",
      profileLabel: "Профиль",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Файл слишком большой",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Пропущено ${count} ${plural({ count, one: "файл", few: "файла", many: "файлов" })}, превышающих максимальный размер вложений.`,
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
      uploadTtl: {
        title: "TTL загрузки (мс)",
        promptTitle: "TTL загрузки (мс)",
        promptMessage:
          "Как долго загрузка может оставаться без активности до истечения срока.",
        invalidValueMessage: "Введите число от 5000 до 3600000.",
      },
      chunkSize: {
        title: "Предпочтительный размер чанка (байт)",
        promptTitle: "Предпочтительный размер чанка (байт)",
        promptMessage: "CLI может ограничить это безопасными пределами.",
        invalidValueMessage: "Введите число от 4096 до 1048576.",
      },
    },
  },

  settingsSourceControl: {
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
      },
    },
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
        "Необязательно: генерировать предложения для сообщения коммита с помощью одноразовой задачи LLM. Требуется поддержка execution runs на демоне.",
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

  settingsNotifications: {
    push: {
      title: "Push-уведомления",
      footer:
        "Эти уведомления отправляются вашим CLI через Expo, когда вашей сессии требуется внимание.",
      enabledSubtitle: "Разрешить push-уведомления для этого аккаунта",
    },
    types: {
      title: "Типы",
      footer: "Отключите отдельные типы, если вам нужны не все уведомления.",
      ready: {
        title: "Готово",
        subtitle:
          "Уведомлять, когда ход завершён и агент ждёт вашей команды",
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
  },

    notifications: {
      actions: {
        allow: 'Разрешить',
        deny: 'Отклонить',
        answer: 'Ответить',
      },
      channels: {
        default: 'По умолчанию',
        permissionRequests: 'Запросы разрешений',
        userActionRequests: 'Запросы действий',
      },
    },

  settingsProviders: {
    title: "Настройки провайдера ИИ",
    entrySubtitle: "Настройте параметры для конкретного провайдера",
    footer:
      "Настройте параметры для конкретного провайдера. Эти настройки могут повлиять на поведение сессии.",
    providerSubtitle: "Параметры для конкретного провайдера",
    stateEnabled: "Включён",
    stateDisabled: "Отключён",
    channelStable: "Стабильный",
    channelExperimental: "Экспериментальный",
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
    resumeSupportRuntimeGatedAcpLoadSession:
      "Через ACP loadSession в рантайме",
    resumeSupportNotSupported: "Не поддерживается",
    sessionModeNone: "Нет режимов ACP",
    sessionModeAcpPolicyPresets: "Пресеты политик ACP",
    sessionModeAcpAgentModes: "Режимы агентов ACP",
    sessionModeStaticAgentModes: "Статические режимы агента",
    runtimeSwitchNone: "Нет переключения в рантайме",
    runtimeSwitchMetadataGating: "Через метаданные",
    runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
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
    installInfoUseProviderCliInstaller: "Используйте установщик CLI провайдера",
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
      noMachineSelected: "Машина не выбрана.",
      installNotSupported: "Установка не поддерживается на этой машине.",
      installFailed: "Установка не удалась.",
      installed: "Установлено.",
      logPath: ({ logPath }: { logPath: string }) => `Лог: ${logPath}`,
    },
    setupGuideUrlTitle: "URL руководства по настройке",
    connectedServiceTitle: "Подключённый сервис",
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
    editorFocusMode: "Режим фокуса редактора",
    editorFocusModeDescription:
      "Скрывать чат и боковую панель при просмотре файлов (web/tablet)",
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
    expConnectedServices: "Подключённые сервисы",
    expConnectedServicesSubtitle: "Включить настройки подключённых сервисов и привязку к сессиям",
    expConnectedServicesQuotas: "Квоты подключённых сервисов",
    expConnectedServicesQuotasSubtitle: "Показывать бейджи квот и счётчики использования подключённых сервисов",
    expMemorySearch: "Поиск по памяти",
    expMemorySearchSubtitle: "Включить экраны и настройки локального поиска по памяти",
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
    historyScopePerSession: "Перебор истории по терминалу",
    historyScopeGlobal: "Перебор истории по всем терминалам",
    historyScopeModalTitle: "История сообщений",
    historyScopeModalMessage:
      "Выберите, перебирает ли ArrowUp/ArrowDown сообщения только этого терминала или всех терминалов.",
    historyScopePerSessionOption: "По терминалу",
    historyScopeGlobalOption: "Глобально",
      commandPalette: "Палитра команд",
      commandPaletteEnabled: "Нажмите ⌘K для открытия",
      commandPaletteDisabled: "Быстрый доступ к командам отключён",
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
      "Чтобы использовать эксперимент Codex ACP, установите codex-acp на целевой машине (Детали машины → Installables) или отключите эксперимент.",
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
    daemonRpcUnavailableTitle: "Демон недоступен",
    daemonRpcUnavailableBody:
      "Happier не может подключиться к демону на этой машине. Он может быть офлайн, ещё запускаться или быть отключён от сервера.",
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
      title: "Возобновление Codex",
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
    useThisServer: "Использовать этот сервер",
    autoConfigHint:
      "Если вы хостите сами: сначала настройте сервер, затем войдите (или создайте аккаунт), затем подключите терминал.",
    renameServer: "Переименовать сервер",
    renameServerPrompt: "Введите новое имя для этого сервера.",
    renameServerGroup: "Переименовать группу серверов",
    renameServerGroupPrompt: "Введите новое имя для этой группы серверов.",
    serverNamePlaceholder: "Имя сервера",
    cannotRenameCloud: "Облачный сервер нельзя переименовать.",
    removeServer: "Удалить сервер",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Удалить "${name}" из сохранённых серверов?`,
    removeServerGroup: "Удалить группу серверов",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Удалить "${name}" из сохранённых групп серверов?`,
    cannotRemoveCloud: "Облачный сервер нельзя удалить.",
    signOutThisServer: "Также выйти с этого сервера?",
    signOutThisServerPrompt:
      "На этом устройстве найдены сохранённые учётные данные для этого сервера.",
    savedServersTitle: "Сохранённые серверы",
    signedIn: "Авторизован",
    signedOut: "Не авторизован",
    authStatusUnknown: "Статус авторизации неизвестен",
    switchToServer: "Переключиться на этот сервер",
    active: "Активный",
    default: "По умолчанию",
    addServerTitle: "Добавить сервер",
    switchForThisTab: "Переключить для этой вкладки",
    makeDefaultOnDevice: "Сделать по умолчанию на этом устройстве",
    serverNameLabel: "Имя сервера",
    addAndUse: "Добавить и использовать",
    addTargetsTitle: "Добавить",
    addServerSubtitle: "Добавить новый сервер и переключиться на него",
    notificationAddServerHint: "Этот сервер ещё не сохранён на этом устройстве. Добавьте его ниже, чтобы продолжить.",
    serverCount: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "сервер", few: "сервера", many: "серверов" })}`,
    useCanonicalServerUrlTitle: "Использовать канонический URL сервера?",
    useCanonicalServerUrlBody:
      "Этот сервер сообщает канонический URL, который должен работать с других устройств. Использовать его вместо введённого?",
    insecureHttpUrlTitle: "Небезопасный URL сервера",
    insecureHttpUrlBody:
      "Этот URL использует http:// и может не работать с телефона или вне вашей LAN. По возможности используйте HTTPS. Продолжить всё равно?",
    signedOutSwitchConfirmTitle: "Вы не подключены",
    signedOutSwitchConfirmBody:
      "Переключиться на этот сервер и перейти на главный экран, чтобы вы могли войти или создать аккаунт?",
    addServerGroupTitle: "Добавить группу серверов",
    addServerGroupSubtitle: "Создать группу серверов для повторного использования",
    serverGroupNameLabel: "Имя группы",
    serverGroupNamePlaceholder: "Моя группа серверов",
    serverGroupServersLabel: "Серверы",
    saveServerGroup: "Сохранить группу",
    serverGroupMustHaveServer: "Группа серверов должна включать хотя бы один сервер.",
    multiServerView: {
      title: "Параллельный просмотр нескольких серверов",
      footer: "Выберите, объединять ли несколько серверов в одном списке сессий.",
      enableTitle: "Включить параллельный просмотр",
      enableSubtitle: "Показывать вместе сессии выбранных серверов",
      presentationTitle: "Режим отображения",
      presentation: {
        flatWithBadges: "Плоский список с бейджами серверов",
        groupedByServer: "Сгруппировано по серверу",
      },
    },
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

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Сервер: ${server}`,
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
    copilotSessionId: "ID сессии Copilot",
    copilotSessionIdCopied: "ID сессии Copilot скопирован в буфер обмена",
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
    forkSession: "Создать ветку сессии",
    forkSessionSubtitle: "Создать новую сессию из последнего контекста",
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
    actionRequired: "требуется действие",
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
  },

  session: {
    inputPlaceholder: "Введите сообщение...",
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
        openRuns: "Открыть запуски сессии",
        openAutomations: "Открыть автоматизации сессии",
        participants: {
          to: 'Кому',
          lead: 'Главный',
          sendToTitle: 'Отправить',
          broadcast: ({ teamId }: { teamId: string }) => `Рассылка: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `Запуск ${runId}`,
          cardTo: ({ label }: { label: string }) => `Кому: ${label}`,
          unsupportedAttachmentsOrReviewComments: 'Отправка получателю пока не поддерживает вложения или комментарии ревью.',
        },
        actionMenu: {
          openA11y: "Открыть действия сессии",
        },
      detailsPanel: {
        emptyHint: "Откройте файл или diff на правой панели.",
        unsupportedTab: "Эта вкладка деталей не поддерживается.",
        closeA11y: "Закрыть детали",
          openTabA11y: ({ title }: { title: string }) => `Открыть вкладку ${title}`,
          pinTabA11y: "Закрепить вкладку",
          pinnedTabA11y: "Закрепленная вкладка",
          closeTabA11y: "Закрыть вкладку",
          enterFocusModeA11y: "Включить режим фокуса редактора",
          exitFocusModeA11y: "Выключить режим фокуса редактора",
      },
  
      actionsDraft: {
        noInputHints: "У этого действия нет подсказок ввода.",
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
        untriaged: "Не классифицировано",
        accept: "Принять",
        reject: "Отклонить",
        defer: "Отложить",
        needsRefinement: "Требует уточнения",
      },
      refinementPlaceholder: "Необязательный комментарий для уточнения",
      actions: {
        applyTriage: "Применить классификацию",
        applying: "Применение…",
        applyAcceptedFindings: "Применить принятые замечания",
        sending: "Отправка…",
      },
      errors: {
        applyTriageFailed: "Не удалось применить классификацию.",
        applyAcceptedFailed: "Не удалось применить принятые замечания.",
      },
    },

        pendingMessages: {
          title: "Отложенные сообщения",
          indicator: ({ count }: { count: number }) => `Ожидает (${count})`,
          badgeLabel: ({ count }: { count: number }) =>
            count > 0 ? `Ожидает (+${count})` : "Ожидает",
          empty: "Нет отложенных сообщений.",
          actions: {
          up: "Вверх",
          down: "Вниз",
          edit: "Редактировать",
            viewMore: "Показать ещё",
            viewLess: "Показать меньше",
          steerNow: "Направить сейчас",
          sendNow: "Отправить сейчас",
          sendNowInterrupt: "Отправить сейчас (прервать)",
          requeue: "Вернуть в очередь",
        },
        editPrompt: {
          title: "Редактировать отложенное сообщение",
        },
        removeConfirm: {
          title: "Удалить отложенное сообщение?",
          body: "Это удалит отложенное сообщение.",
        },
        steerConfirm: {
          title: "Направить сейчас?",
          body: "Это добавит сообщение в текущий ход без его остановки.",
        },
        sendConfirm: {
          title: "Отправить сейчас?",
          interruptTitle: "Отправить сейчас (прервать)?",
          body: "Это остановит текущий ход и отправит сообщение немедленно.",
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
    effectiveLabel: ({ label }: { label: string }) => `Фактически: ${label}`,
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
          a11y: {
            teleport: "Телепортировать голосового агента",
            toggleActivity: "Переключить голосовую активность",
            clearActivity: "Очистить голосовую активность",
          },
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
      effectiveLabel: ({ label }: { label: string }) => `Эффективно: ${label}`,
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
      copilot: "Copilot",
    },
    auggieIndexingChip: {
      on: "Индексация включена",
      off: "Индексация выключена",
    },
      model: {
        title: "МОДЕЛЬ",
        useCliSettings: "Использовать настройки CLI",
        configureInCli: "Настройте модели в настройках CLI",
        customDescription: "Использовать ID модели, которого нет в списке.",
        customPromptBody: "Введите ID модели",
        customPlaceholder: "например: claude-3.5-sonnet",
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
    mode: {
      sectionTitle: "Режим",
      badge: ({ name }: { name: string }) => `Режим: ${name}`,
      badgePending: ({ name }: { name: string }) => `Режим: ${name} (ожидает)`,
      badgeA11y: ({ name }: { name: string }) => `Режим: ${name}`,
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
      currentValue: ({ value }: { value: string }) => `Текущий: ${value}`,
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
    taskView: {
      initializing: "Инициализация агента...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} ещё ${plural({ count, one: "инструмент", few: "инструмента", many: "инструментов" })}`,
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
    notRepo: "Не является репозиторием системы контроля версий",
    notUnderSourceControl: "Эта папка не находится под управлением системы контроля версий",
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
      fileWriteFailed: "Не удалось записать файл",
      fileEditor: {
        experimentalHint:
          "Редактирование экспериментально. Сохраните, чтобы записать изменения обратно в worktree сессии.",
      },
      fileEditingUnsupported:
        "Редактирование файлов не поддерживается подключённым демоном. Обновите Happier на машине, чтобы включить операции записи.",
      selectionFailed: "Не удалось обновить выбор",
      openReviewCommentsFailed: "Не удалось открыть комментарии к ревью",
        reviewComments: {
          title: ({ count }: { count: number }) => `Комментарии ревью (${count})`,
          placeholder: "Добавьте комментарий к ревью…",
          jump: "Перейти",
          addCommentA11y: "Добавить комментарий",
          closeCommentA11y: "Закрыть комментарий",
          draftsChipLabel: ({ count }: { count: number }) => `Ревью (${count})`,
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
          commit: "Сделать коммит",
          generateFailed: "Не удалось сгенерировать сообщение коммита",
          generatorDisabled: "Генератор сообщений коммита отключён",
        },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Загрузка ${fileName}...`,
        binaryFile: "Бинарный файл",
        imagePreviewTooLarge: "Предпросмотр изображения слишком большой для отображения",
        cannotDisplayBinary: "Невозможно отобразить содержимое бинарного файла",
        diff: "Различия",
      file: "Файл",
    diffModes: {
      pending: "Ожидает",
      included: "Включено",
      combined: "Объединено",
    },
    fileActions: {
      selectForCommit: "Выбрать для коммита",
      stageFile: "Добавить в stage",
      removeFromSelection: "Убрать из выбора",
      unstageFile: "Убрать из stage",
      selectionHint:
        "Выберите «Включено» или «Ожидает», чтобы включить выбор строк.",
      selectedLines: {
        selectLinesForCommit: "Выбрать строки для коммита",
        stageSelectedLines: "Добавить выбранные строки в stage",
        unstageSelectedLines: "Убрать выбранные строки из stage",
      },
      clearSelection: "Очистить выбор",
    },
    toolbar: {
      changedFiles: "Изменённые файлы",
      allRepositoryFiles: "Все файлы репозитория",
      repositoryView: "Вид репозитория",
      sessionView: "Вид сессии",
      review: "Ревью",
      list: "Список",
      scm: "Git",
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
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Запустить выполнение",
      sections: {
        intent: "Назначение",
        permissions: "Разрешения",
        backends: "Бэкенды",
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
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Переключить бэкенд ${backendId}`,
      },
    },
    details: {
      labels: {
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

  settingsNotifications: {
    foregroundBehavior: {
      title: "Уведомления в приложении",
      footer: "Управляет уведомлениями, пока вы используете приложение. Уведомления для просматриваемой сессии всегда скрываются.",
      full: "Полные",
      fullDescription: "Показывать баннер и воспроизводить звук",
      silent: "Тихие",
      silentDescription: "Показывать баннер без звука",
      off: "Выкл.",
      offDescription: "Только значок, без баннера",
    },
  },

  settingsSession: {
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
        layoutTitle: "Макет",
        layoutFooter:
          "Выберите между простой линейной стенограммой и группировкой по ходам.",
        layoutPickerTitle: "Макет стенограммы",
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
            thinkingPulseStaleTitle: "Окно устаревания размышления",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Текущее: ${value}ms`,
            thinkingPulseStalePromptTitle: "Окно устаревания размышления (ms)",
            thinkingPulseStalePromptBody:
              "Скрывать активное размышление после этого времени без обновлений.",
            listImplementationTitle: "Реализация списка транскрипта",
            listImplementationSubtitle: "Переключить движок списка (debug).",
            listImplementation: {
              flashTitle: "FlashList v2 (рекомендуется)",
              flashSubtitle: "Лучшая производительность для длинных транскриптов.",
              legacyTitle: "Устаревший FlatList",
              legacySubtitle: "Запасной вариант для отладки совместимости.",
            },
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
      actionsEntry: {
        footer:
          "Включайте действия по поверхности и размещению (UI, голос, MCP) и контролируйте, где они появляются.",
        openSubtitle: "Открыть настройки действий",
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
      agentReuseDialog: {
        title: "Агент Happier уже существует",
        messageWithId: ({ name, id }: { name: string; id: string }) =>
          `Мы нашли существующего агента ElevenLabs («${name}», id: ${id}).\n\nХотите обновить его или создать нового?`,
        messageNoId: ({ name }: { name: string }) =>
          `Мы нашли существующего агента ElevenLabs («${name}»).\n\nХотите обновить его или создать нового?`,
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
      apiKeyPlaceholder: "xi-api-key",
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
          enableTtsTitle: "Включить стриминг TTS",
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
      `Это подключение для ${serverUrl}. Переключить сервер и продолжить?`,
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
      "Сквозное шифрование, аккаунт хранится только на вашем устройстве.",
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
    serverUnavailableTitle: "Не удаётся подключиться к серверу",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Мы не можем подключиться к ${serverUrl}. Повторите попытку или смените сервер, чтобы продолжить.`,
    serverIncompatibleTitle: "Сервер не поддерживается",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Сервер по адресу ${serverUrl} вернул неожиданный ответ. Обновите сервер или смените сервер, чтобы продолжить.`,
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
      valueExample: "sk-...",
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
    defaultPermissions: {
      title: "Разрешения по умолчанию",
      footer:
        "Переопределяет разрешения по умолчанию на уровне аккаунта для новых сессий, когда выбран этот профиль.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `По умолчанию для аккаунта: ${label}`,
      useAccountDefault: "Использовать значение аккаунта",
      currently: ({ label }: { label: string }) => `Сейчас: ${label}`,
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
      copilotSubtitleExperimental: "GitHub Copilot CLI (экспериментально)",
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
