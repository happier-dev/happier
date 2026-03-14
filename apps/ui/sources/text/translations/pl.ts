import type { TranslationStructure } from "../_types";

/**
 * Polish plural helper function
 * Polish has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Polish plural rules
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

  // Rule: 1 (but not 11)
  if (n === 1) return one;

  // Rule: 2-4 but not 12-14
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;

  // Rule: everything else (0, 5-19, 11, 12-14, etc.)
  return many;
}

/**
 * Polish translations for the Happier app
 * Must match the exact structure of the English translations
 */
export const pl: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "Przyjaciele",
    sessions: "Terminale",
    settings: "Ustawienia",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Brak aktywności przyjaciół",
    emptyDescription:
      "Dodaj przyjaciół, aby udostępniać sesje i widzieć aktywność tutaj.",
    updates: "Aktywność",
  },

    runs: {
      title: "Uruchomienia",
      empty: "Brak uruchomień.",
        showFinished: "Pokaż zakończone",
        unknownMachine: "Nieznana maszyna",
        failedToLoad: "Nie udało się wczytać uruchomień",
        noMachinesAvailable: "Brak dostępnych maszyn.",
        groupLabel: ({ groupId }: { groupId: string }) => `Grupa ${groupId}`,
        serverTitle: ({ serverId }: { serverId: string }) => `Serwer ${serverId}`,
        machinesSubtitle: "Maszyny",
        openMachine: "Otwórz maszynę",
        a11y: {
          toggleFinished: "Przełącz zakończone uruchomienia",
          refresh: "Odśwież uruchomienia",
        },
        openSession: "Otwórz sesję",
        sessionTitle: ({ sessionId }: { sessionId: string }) => `Sesja ${sessionId}`,
        runLabel: ({ runId }: { runId: string }) => `uruchomienie ${runId}`,
        detail: {
          pid: ({ pid }: { pid: number }) => `PID ${pid}`,
          cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
          memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
        },
        runDetails: {
          failedToLoad: "Nie udało się wczytać uruchomienia",
          latestToolResultTitle: "Ostatni wynik narzędzia",
          a11y: {
            refreshRun: "Odśwież uruchomienie",
          },
        },
        stop: {
          stopRunA11y: "Zatrzymaj uruchomienie",
          stopLabel: "Zatrzymaj uruchomienie",
          stoppingLabel: "Zatrzymywanie…",
          stopRunFailedTitle: "Nie udało się zatrzymać uruchomienia",
          stopRunFailedBody:
            "Zatrzymanie tego uruchomienia przez RPC sesji nie powiodło się. Czy chcesz zatrzymać cały proces sesji? To jest destrukcyjne i zatrzyma wszystkie uruchomienia w tej sesji.",
          stopSession: "Zatrzymaj sesję",
          failedToStopRun: "Nie udało się zatrzymać uruchomienia",
          failedToStopSession: "Nie udało się zatrzymać sesji",
        },
        send: {
          placeholder: "Wyślij do uruchomienia…",
          a11y: {
            sendToRun: "Wyślij do uruchomienia",
          },
          sendLabel: "Wyślij",
          sendingLabel: "Wysyłanie…",
          failedToSend: "Nie udało się wysłać",
        },
    },

    sessionLog: {
      title: "Dziennik sesji",
      devModeRequiredTitle: "Wymagany jest tryb deweloperski",
      devModeRequiredBody:
        "Włącz tryb deweloperski w ustawieniach, aby zobaczyć logi sesji.",
      logPathTitle: "Ścieżka logu",
      unavailable: "Niedostępne",
      logPathCopyLabel: "Ścieżka dziennika sesji",
      refreshTailTitle: "Odśwież koniec logu",
      refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
        `Odczytaj ostatnie ${maxBytes} bajtów`,
      copyVisibleTitle: "Skopiuj widoczny log",
      copyVisibleSubtitleLoaded:
        "Skopiuj bieżący fragment do schowka",
      copyVisibleSubtitleEmpty: "Nie wczytano treści logu",
      copyLogLabel: "Dziennik sesji",
      statusTitle: "Status logu",
      readErrorTitle: "Błąd odczytu",
      tailTitle: "Koniec logu",
      tailTitleTruncated: "Koniec logu (ucięty)",
      noOutputYet: "(Brak wyjścia logu)",
      readFailed: "Nie udało się odczytać dziennika sesji",
    },

  automations: {
    openA11y: "Otwórz automatyzacje",
    gate: {
      disabledTitle: "Automatyzacje są wyłączone",
      disabledBody:
        "Włącz je w Ustawieniach, a następnie włącz Eksperymenty i Automatyzacje.",
    },
    edit: {
      title: "Edytuj automatyzację",
      saveAutomationLabel: "Zapisz automatyzację",
      messageLabel: "WIADOMOŚĆ",
      messagePlaceholder: "Wiadomość do wysłania",
      messageHelpText:
        "Ta wiadomość zostanie dodana do kolejki w sesji jako oczekująca wiadomość użytkownika.",
      updateFailed: "Nie udało się zaktualizować automatyzacji.",
      loadTemplateFailed: "Nie udało się wczytać szablonu automatyzacji.",
    },
    form: {
      groupAutomationTitle: "Automatyzacja",
      groupScheduleTitle: "Harmonogram",
      toggleEnableTitle: "Włącz automatyzację",
      toggleEnableSubtitle:
        "Utwórz ten nowy szablon sesji jako zaplanowaną automatyzację zamiast uruchamiać od razu.",
      toggleEnabledTitle: "Włączone",
      toggleEnabledSubtitle:
        "Gdy wyłączone, żadne zaplanowane uruchomienia nie zostaną wykonane.",
      labels: {
        name: "NAZWA",
        descriptionOptional: "OPIS (OPCJONALNIE)",
        everyMinutes: "CO ILE (MINUT)",
        cronExpression: "WYRAŻENIE CRON",
        timezoneOptional: "STREFA CZASOWA (OPCJONALNIE)",
      },
      placeholders: {
        name: "Zaplanowana sesja",
        description: "Co ma robić ta automatyzacja?",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC lub America/New_York",
      },
      schedule: {
        intervalTitle: "Interwał",
        intervalSubtitle: "Uruchamiaj co N minut.",
        cronTitle: "Wyrażenie cron",
        cronSubtitle: "Zaawansowane wyrażenie harmonogramu.",
        cronHelpText:
          "Standardowy cron 5‑polowy: minuta godzina dzień-miesiąca miesiąc dzień-tygodnia.",
      },
    },
    session: {
      emptyTitle: "Brak automatyzacji",
      emptyBody:
        "Dodaj automatyzację, aby dodawać do kolejki zaplanowane wiadomości w tej sesji.",
      addAutomation: "Dodaj automatyzację",
      failedToLoad: "Nie udało się wczytać automatyzacji.",
    },
    screen: {
      emptyTitle: "Brak automatyzacji",
      emptyBody:
        "Utwórz ją z poziomu nowej sesji, aby uruchamiać zaplanowane sesje na swoich maszynach.",
      createAutomationA11y: "Utwórz automatyzację",
    },
    detail: {
      invalidId: "Nieprawidłowy identyfikator automatyzacji.",
      notFound: "Nie znaleziono automatyzacji.",
      unknownDate: "Nieznane",
      notScheduled: "Nie zaplanowano",
      overviewGroupTitle: "Przegląd",
      overview: {
        nameTitle: "Nazwa",
        scheduleTitle: "Harmonogram",
        statusTitle: "Stan",
        nextRunTitle: "Następne uruchomienie",
      },
      status: {
        active: "Aktywna",
        paused: "Wstrzymana",
      },
      actionsGroupTitle: "Akcje",
      runNowTitle: "Uruchom teraz",
      runNowQueuedBadge: "W kolejce",
      runNowQueuedLine: "W kolejce.",
      runNowQueuedSubtitle:
        "W kolejce. Przypisany demon uruchomi ją, gdy będzie dostępny.",
      pauseAutomation: "Wstrzymaj automatyzację",
      resumeAutomation: "Wznów automatyzację",
      editAutomation: "Edytuj automatyzację",
      deleteAutomation: "Usuń automatyzację",
      deleteConfirmTitle: "Usuń automatyzację",
      deleteConfirmMessage: "Ta automatyzacja i jej harmonogram zostaną usunięte.",
      deleteConfirmButton: "Usuń",
      machineAssignmentsTitle: "Przypisania maszyn",
      machineAssignmentsFooter:
        "Włącz co najmniej jedną maszynę, aby automatyzacja mogła się uruchamiać.",
      refreshFailed: "Nie udało się odświeżyć automatyzacji.",
      runFailed: "Nie udało się uruchomić automatyzacji.",
      deleteFailed: "Nie udało się usunąć automatyzacji.",
      assignmentsUpdateFailed: "Nie udało się zaktualizować przypisań maszyn.",
      recentRunsTitle: "Ostatnie uruchomienia",
      runMeta: {
        scheduled: ({ time }: { time: string }) => `Zaplanowano: ${time}`,
        updated: ({ time }: { time: string }) => `Zaktualizowano: ${time}`,
        error: ({ message }: { message: string }) => `Błąd: ${message}`,
      },
    },
    create: {
      defaultName: "Zaplanowana wiadomość",
      createFailed: "Nie udało się utworzyć automatyzacji.",
      unavailableGroupTitle: "Niedostępne",
      cannotCreateForSession: "Nie można utworzyć automatyzacji dla tej sesji",
      sessionNotFound: "Nie znaleziono sesji.",
      missingMachineId: "Ta sesja nie ma identyfikatora maszyny.",
      missingResumeKey:
        "Ta sesja nie ma jeszcze wczytanego klucza szyfrowania do wznawiania.",
      createButtonTitle: "Utwórz automatyzację",
    },
  },

  appCrash: {
    title: "Coś poszło nie tak",
    subtitle:
      "W Happier wystąpił nieoczekiwany błąd. Możesz ponownie uruchomić interfejs aplikacji lub skopiować szczegóły dla pomocy.",
    detailsTitle: "Szczegóły błędu",
    restart: "Uruchom ponownie",
    restartAndReportIssue: "Uruchom ponownie i zgłoś błąd",
    copyDetails: "Kopiuj szczegóły błędu",
  },

  webCryptoGate: {
    title: "Wymagane jest bezpieczne połączenie",
    subtitle:
      "Ta strona wymaga WebCrypto, aby chronić Twoje dane. WebCrypto nie jest dostępne dla tego źródła, ponieważ przeglądarki wymagają bezpiecznego kontekstu.",
    howToFix: "Jak naprawić",
    fixHttps: "Otwórz UI przez HTTPS (zalecane).",
    fixTunnel:
      "Jeśli potrzebujesz dostępu z LAN, użyj tunelu HTTPS lub reverse proxy z TLS.",
    fixLocalhost:
      "Jeśli jesteś na tej samej maszynie, użyj http://localhost (loopback jest traktowany jako bezpieczny).",
    currentOrigin: "Bieżące źródło",
    secureContext: "Bezpieczny kontekst",
    copyDetails: "Kopiuj szczegóły",
    reload: "Odśwież",
  },

  common: {
    // Simple string constants
    add: "Dodaj",
    edit: "Edytuj",
    actions: "Akcje",
    moreActions: "Więcej działań",
    moreActionsHint: "Otwiera menu z dodatkowymi działaniami",
    cancel: "Anuluj",
    close: "Zamknij",
      open: "Otwórz",
      done: "Gotowe",
      reorder: "Zmień kolejność",
      authenticate: "Uwierzytelnij",
      save: "Zapisz",
    saveAs: "Zapisz jako",
    error: "Błąd",
    success: "Sukces",
    ok: "OK",
    continue: "Kontynuuj",
    back: "Wstecz",
    start: "Rozpocznij",
    create: "Utwórz",
      rename: "Zmień nazwę",
      remove: "Usuń",
      update: "Aktualizuj",
      commit: "Zatwierdź",
      history: "Historia",
      applied: "Zastosowano",
      signOut: "Wyloguj się",
      keep: "Zachowaj",
      use: "Użyj",
      reset: "Resetuj",
    logout: "Wyloguj",
    yes: "Tak",
    no: "Nie",
    on: "Włączone",
    off: "Wyłączone",
    discard: "Odrzuć",
    discardChanges: "Odrzuć zmiany",
    unsavedChangesWarning: "Masz niezapisane zmiany.",
    keepEditing: "Kontynuuj edycję",
    version: "Wersja",
    details: "Szczegóły",
    copied: "Skopiowano",
    copy: "Kopiuj",
    copyWithLabel: ({ label }: { label: string }) => `Kopiuj ${label}`,
    expand: "Rozwiń",
    collapse: "Zwiń",
    command: "Polecenie",
    scanning: "Skanowanie...",
    urlPlaceholder: "https://example.com",
    home: "Główna",
    message: "Wiadomość",
    send: "Wyślij",
    attach: "Dołącz",
    linkFile: "Połącz plik",
    files: "Pliki",
    path: "Ścieżka",
    fileViewer: "Przeglądarka plików",
    loading: "Ładowanie...",
    none: "—",
    unavailable: "Niedostępne",
    dialog: "Okno dialogowe",
    retry: "Ponów",
    or: "lub",
    delete: "Usuń",
    deleted: "Usunięto",
    optional: "opcjonalnie",
    noMatches: "Brak dopasowań",
    all: "Wszystko",
    machine: "maszyna",
    clearSearch: "Wyczyść wyszukiwanie",
    refresh: "Odśwież",
    default: "Domyślne",
    enabled: "Włączone",
    disabled: "Wyłączone",
    requestFailed: "Żądanie nie powiodło się.",
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "Zmień rozmiar panelu",
      resizeHint:
        "Użyj strzałek w lewo i w prawo, aby zmienić rozmiar",
    },
  },

  dropdown: {
    category: {
      general: "Ogólne",
      results: "Wyniki",
    },
    createItem: {
      prefix: "Dodaj",
    },
  },

  profile: {
    userProfile: "Profil użytkownika",
    details: "Szczegóły",
    firstName: "Imię",
      lastName: "Nazwisko",
      username: "Nazwa użytkownika",
      status: "Stan",
    },

  status: {
    connected: "połączono",
    connecting: "łączenie",
    disconnected: "rozłączono",
    error: "błąd",
    online: "w sieci",
    offline: "poza siecią",
    lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
    actionRequired: "wymagana akcja",
    permissionRequired: "wymagane uprawnienie",
    activeNow: "Aktywny teraz",
    unknown: "nieznane",
  },

  connectionStatus: {
    title: "Połączenie",
    labels: {
      server: "Serwer",
      socket: "Gniazdo",
      authenticated: "Uwierzytelniono",
      lastSync: "Ostatnia synchronizacja",
      nextRetry: "Następna próba",
      lastError: "Ostatni błąd",
    },
  },

  time: {
    justNow: "teraz",
    minutesAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "minuta", few: "minuty", many: "minut" })} temu`,
    hoursAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "godzina", few: "godziny", many: "godzin" })} temu`,
  },

  connect: {
    restoreAccount: "Przywróć konto",
    enterSecretKey: "Proszę wprowadzić klucz tajny",
    invalidSecretKey: "Nieprawidłowy klucz tajny. Sprawdź i spróbuj ponownie.",
    enterUrlManually: "Wprowadź URL ręcznie",
    scanComputerQrUnavailableTitle: "Skanowanie QR z komputera niedostępne",
    scanComputerQrUnavailableBody:
      "Ta metoda logowania jest wyłączona na tym serwerze. Użyj poniżej innej opcji, aby odzyskać konto.",
    scanComputerQrInstructions: "Zeskanuj kod QR wyświetlony w Happier na komputerze (Ustawienia → Dodaj telefon).",
    scanComputerQrButton: "Zeskanuj QR, aby się zalogować",
    waitingForApproval: "Oczekiwanie na zatwierdzenie…",
    showQrInstead: "Zamiast tego pokaż kod QR",
    addPhoneQrInstructions: "Zeskanuj ten kod QR w aplikacji mobilnej Happier, aby zalogować się na telefonie.",
    serverUrlNotEmbeddedTitle: "Skonfiguruj serwer na telefonie",
    serverUrlNotEmbeddedBody:
      "Ten kod QR nie może zawierać adresu serwera, ponieważ jest ustawiony na localhost. Na telefonie przejdź do Ustawienia → Serwery i dodaj URL, do którego telefon ma dostęp (LAN IP lub Tailscale), a następnie zeskanuj ponownie.",
    pairingRequestTitle: "Prośba o sparowanie",
    pairingRequestBody: "Sprawdź, czy ten kod zgadza się z tym na telefonie, a następnie zatwierdź.",
    pairingAlreadyRequestedTitle: "Kod już użyty",
    pairingAlreadyRequestedBody:
      "Ten kod QR został już zeskanowany na innym telefonie. Poproś komputer o wygenerowanie nowego.",
    deviceLabel: "Urządzenie",
    confirmCodeLabel: "Kod potwierdzenia",
    approveButton: "Zatwierdź",
    generateNewQrCode: "Wygeneruj nowy kod QR",
    pairingQrExpired: "Ten kod QR wygasł. Wygeneruj nowy.",
    openMachine: "Otwórz maszynę",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "Na urządzeniu, na którym jesteś już zalogowany(-a), przejdź do Ustawienia → Konto i zeskanuj ten kod QR.",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} zweryfikowano`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `Znaleźliśmy istniejące konto Happier powiązane z ${provider}. Aby dokończyć logowanie na tym urządzeniu, przywróć klucz konta za pomocą kodu QR lub klucza tajnego.`,
    restoreWithSecretKeyInstead: "Przywróć za pomocą klucza tajnego",
    restoreWithSecretKeyDescription:
      "Wpisz swój klucz tajny, aby odzyskać dostęp do konta.",
    lostAccessLink: "Brak dostępu?",
    lostAccessTitle: "Straciłeś dostęp do konta?",
    lostAccessBody:
      "Jeśli nie masz już żadnego urządzenia połączonego z tym kontem i zgubiłeś klucz tajny, możesz zresetować konto przez dostawcę tożsamości. Utworzy to nowe konto Happier. Nie da się odzyskać starej zaszyfrowanej historii.",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `Kontynuuj z ${provider}`,
    lostAccessConfirmTitle: "Zresetować konto?",
    lostAccessConfirmBody:
      "Zostanie utworzone nowe konto i ponownie powiązana tożsamość. Nie da się odzyskać starej zaszyfrowanej historii.",
    lostAccessConfirmButton: "Zresetuj i kontynuuj",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    linkNewDeviceTitle: "Połącz nowe urządzenie",
    linkNewDeviceSubtitle: "Zeskanuj kod QR wyświetlony na nowym urządzeniu, aby połączyć go z tym kontem",
    linkNewDeviceQrInstructions: "Otwórz Happier na nowym urządzeniu i wyświetl kod QR",
    scanQrCodeOnDevice: "Zeskanuj kod QR",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `Połącz ${name}`,
      runCommandInTerminal: "Uruchom poniższe polecenie w terminalu:",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `Uruchom poniższe polecenie w terminalu:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "Podgląd niedostępny",
        previewUnavailableBody:
          "Nie udało się zbudować podglądu diagnostyki.",
        submittedTitle: "Zgłoszenie błędu wysłane",
        submittedExistingIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) =>
          `Dodano komentarz do issue #${issueNumber}.\n\nID raportu: ${reportId}`,
        submittedNewIssueBody: ({
          issueNumber,
          reportId,
        }: {
          issueNumber: number;
          reportId: string;
        }) => `Utworzono issue #${issueNumber}.\n\nID raportu: ${reportId}`,
        submitFailedTitle: "Wysłanie nie powiodło się",
        submitFailedFallbackMessage: "Nie udało się wysłać tego zgłoszenia.",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\nCzy chcesz zamiast tego otworzyć wstępnie wypełnione issue na GitHubie?`,
        openFallbackIssueButton: "Otwórz zapasowe issue",
      },
      diagnostics: {
        title: "Diagnostyka",
        subtitle: "Wybierz, co dołączyć, i podejrzyj przed wysłaniem.",
        includeTitle: "Dołącz diagnostykę",
        includeSubtitle:
          "Dołącz zanonimizowane artefakty debugowania, aby przyspieszyć diagnozę.",
        disabledByServerSuffix: " (wyłączone przez serwer)",
        pasteDoctorJson: {
          title: "CLI doctor JSON (opcjonalnie)",
          subtitle:
            "Jeśli Twoja maszyna jest nieosiągalna z UI, uruchom `happier doctor --json` na komputerze i wklej tutaj.",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `Nieprawidłowy doctor JSON: ${error}`,
          valid: "Doctor JSON wygląda poprawnie i zostanie dołączony do zgłoszenia.",
        },
        previewButton: "Podgląd diagnostyki",
        preview: {
          title: "Podgląd diagnostyki",
          helper:
            "Te artefakty zostaną przesłane wraz ze zgłoszeniem (zsanityzowane i z limitem rozmiaru). Stuknij element, aby wyświetlić pełną zawartość.",
          empty: "Żadne artefakty diagnostyczne nie zostaną wysłane.",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `Otwórz ${filename}`,
        },
        kinds: {
          app: {
            title: "Diagnostyka aplikacji",
            detail:
              "Logi konsoli aplikacji, ostatnie działania użytkownika i podsumowanie sesji.",
          },
          daemon: {
            title: "Diagnostyka demona",
            detail:
              "Podsumowanie demona i ostatnie logi demona z wybranych maszyn.",
          },
          stackService: {
            title: "Diagnostyka usługi Stack",
            detail:
              "Kontekst stacka i ostatnie logi stacka (jeśli dostępne).",
          },
          server: {
            title: "Diagnostyka serwera",
            detail: "Zrzut serwera dla aktualnie aktywnego serwera.",
          },
        },
      },
      issueDetails: {
        title: "Opisz problem",
        subtitle:
          "Podaj tyle szczegółów, abyśmy mogli szybko odtworzyć i zdiagnozować.",
        titleLabel: "Tytuł (wymagane)",
        titlePlaceholder: "Krótki tytuł",
        githubUsernameLabel: "Nazwa użytkownika GitHub (opcjonalnie)",
        githubUsernamePlaceholder:
          "Używana jako kontakt w treści zgłoszenia",
        summaryLabel: "Krótki opis (wymagane)",
        summaryPlaceholder: "Jednoakapitowe podsumowanie",
        currentBehaviorLabel: "Aktualne zachowanie (opcjonalnie)",
        currentBehaviorPlaceholder: "Co faktycznie się dzieje?",
        expectedBehaviorLabel: "Oczekiwane zachowanie (opcjonalnie)",
        expectedBehaviorPlaceholder: "Co powinno się dziać zamiast tego?",
        reproductionStepsLabel: "Kroki odtworzenia (opcjonalnie)",
        reproductionStepsPlaceholder:
          "1. Otwórz Happier\n2. Uruchom sesję\n3. ...",
        whatChangedLabel: "Co ostatnio się zmieniło (opcjonalnie)",
        whatChangedPlaceholder:
          "Aktualizacje, zmiany konfiguracji, nowe kroki konfiguracji...",
      },
      similarIssues: {
        title: "Możliwe duplikaty",
        subtitle:
          "Jeśli jedna z tych pozycji pasuje, możesz dodać swój raport jako komentarz zamiast otwierać nowy issue.",
        searching: "Wyszukiwanie issue…",
        selectedTitle: ({ number }: { number: number }) => `Używasz issue #${number}`,
        selectedSubtitle: "Dotknij, aby wrócić do tworzenia nowego issue.",
        useIssueA11y: ({ number }: { number: number }) => `Użyj issue #${number}`,
        issueState: {
          open: "Otwarte issue",
          closed: "Zamknięte issue",
        },
      },
      frequencySeverity: {
        title: "Częstotliwość i ważność",
        frequencyLabel: "Częstotliwość",
        severityLabel: "Ważność",
        frequency: {
          always: "Zawsze",
          often: "Często",
          sometimes: "Czasami",
          once: "Raz",
        },
        severity: {
          blocker: "Blokujące",
          high: "Wysoka",
          medium: "Średnia",
          low: "Niska",
        },
      },
      environment: {
        title: "Środowisko (edytowalne)",
        appVersionLabel: "Wersja aplikacji",
        platformLabel: "Platforma",
        osVersionLabel: "Wersja systemu",
        deviceModelLabel: "Model urządzenia",
        serverUrlLabel: "URL serwera",
        serverVersionLabel: "Wersja serwera (opcjonalnie)",
        deploymentTypeLabel: "Typ wdrożenia",
        deploymentType: {
          cloud: "Chmura",
          selfHosted: "Własny hosting",
          enterprise: "Korporacyjne",
        },
      },
      consent: {
        title: "Zgoda",
        understandTitle:
          "Rozumiem, że diagnostyka może zawierać techniczne metadane",
        understandSubtitle:
          "Nie dołączaj haseł, tokenów dostępu ani kluczy prywatnych.",
      },
      submit: {
        requiredFieldsHint:
          "Uzupełnij wymagane pola, aby włączyć wysyłanie.",
        submitting: "Wysyłanie zgłoszenia…",
        addToIssue: ({ number }: { number: number }) =>
          `Dodaj do issue #${number}`,
        submitNew: "Wyślij zgłoszenie błędu",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer:
        "Włącz wyszukiwanie pamięci w Funkcjach, aby skonfigurować lokalne indeksowanie.",
      title: "Wyszukiwanie pamięci jest wyłączone",
      subtitle: "Otwórz Ustawienia → Funkcje, aby włączyć memory.search",
      openFeatureSettings: "Otwórz ustawienia funkcji",
      alertTitle: "Wyszukiwanie pamięci jest wyłączone",
      alertBody: "Włącz memory.search w Ustawienia → Funkcje.",
    },
    enabled: {
      title: "Włączone",
      subtitle: "Buduj i utrzymuj lokalny indeks na tej maszynie",
      footer:
        "Gdy włączone, Happier buduje lokalny indeks na urządzeniu na podstawie odszyfrowanych transkryptów, aby wspierać szybkie wyszukiwanie i przypominanie.",
    },
    budgets: {
      groupTitle: "Limit dysku",
      groupFooter:
        "Ogranicza ilość miejsca na dysku, jaką może użyć lokalny indeks pamięci (usuwanie w trybie best-effort).",
      mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
      lightTitle: "Limit indeksu Light",
      lightPromptTitle: "Limit indeksu Light",
      lightPromptBody:
        "Maks. MB dla indeksu Light (shardy podsumowań) na maszynie.",
      deepTitle: "Limit indeksu Deep",
      deepPromptTitle: "Limit indeksu Deep",
      deepPromptBody: "Maks. MB dla indeksu Deep (chunków) na maszynie.",
    },
    privacy: {
      groupTitle: "Prywatność",
      groupFooter:
        "Usuwa lokalne indeksy pochodne i cache modeli po wyłączeniu wyszukiwania w pamięci.",
      deleteOnDisableTitle: "Usuń przy wyłączeniu",
      deleteOnDisableSubtitle:
        "Usuwa lokalne indeksy i cache, gdy wyszukiwanie w pamięci jest wyłączone",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `Maszyna: ${machine}`,
      searchPlaceholder: "Wyszukaj w pamięci",
      enableLocalSearch: "Włącz lokalne wyszukiwanie pamięci",
    },
    machine: {
      title: "Maszyna",
      changeTitle: "Zmień maszynę",
      noMachine: "Brak maszyny",
    },
    indexMode: {
      title: "Tryb indeksu",
      footer:
        "Tryb lekki przechowuje małe fragmenty podsumowań. Tryb głęboki może znaleźć więcej, ale zużywa więcej dysku.",
      triggerTitle: "Tryb",
      options: {
        lightTitle: "Lekki (zalecane)",
        lightSubtitle: "Tylko fragmenty podsumowań",
        deepTitle: "Głęboki",
        deepSubtitle: "Indeksuj fragmenty wiadomości lokalnie",
      },
    },
    backfill: {
      title: "Uzupełnianie",
      footer:
        "Określa, ile historii jest indeksowane przy włączaniu lokalnej pamięci.",
      triggerTitle: "Polityka",
      options: {
        newOnlyTitle: "Tylko nowe (zalecane)",
        newOnlySubtitle: "Indeksuj tylko treści utworzone po włączeniu",
        last30DaysTitle: "Ostatnie 30 dni",
        last30DaysSubtitle: "Uzupełnij ostatnie sesje",
        allHistoryTitle: "Cała historia",
        allHistorySubtitle: "Uzupełnij wszystko (może potrwać)",
      },
    },
    hints: {
      title: "Generowanie wskazówek pamięci",
      footer:
        "Kontroluje, jak generowane są fragmenty podsumowań dla lekkiego wyszukiwania pamięci.",
      backend: {
        title: "Backend streszczacza",
        promptTitle: "Backend streszczacza",
        promptBody:
          "Wpisz id backendu dla execution-run (np. claude, codex).",
      },
      model: {
        title: "Model streszczacza",
        promptTitle: "Model streszczacza",
        promptBody: "Wpisz id modelu przekazywane do backendu.",
      },
      permissions: {
        triggerTitle: "Uprawnienia streszczacza",
        options: {
          noToolsTitle: "Brak narzędzi (zalecane)",
          noToolsSubtitle: "Tylko streszczanie tekstu",
          readOnlyTitle: "Tylko odczyt",
          readOnlySubtitle:
            "Zezwól na narzędzia niemodyfikujące, jeśli są obsługiwane",
        },
      },
    },
    embeddings: {
      groupTitle: "Osadzenia",
      groupFooter:
        "Opcjonalnie: pobierz lokalny model, aby poprawić dopasowania semantyczne w trybie Deep.",
      enableTitle: "Włącz embeddings",
      enableSubtitle:
        "Poprawia ranking dla głębokiego wyszukiwania (pobiera model przy pierwszym użyciu)",
      modelTitle: "Model embeddings",
      promptBody: "Wpisz identyfikator lokalnego modelu transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
    },
    },

      subAgentGuidance: {
        ruleEditor: {
        header: {
          newRule: "Nowa reguła",
          editRule: "Edytuj regułę",
        },
        enabled: {
          title: "Włączone",
        },
        enabledState: {
          enabled: "Włączone",
          disabled: "Wyłączone",
        },
        common: {
          noPreference: "Bez preferencji",
        },
        titleField: {
          label: "Tytuł (opcjonalnie)",
          placeholder: "np. prace nad UI",
        },
        descriptionField: {
          label: "Kiedy agent powinien delegować?",
          placeholder: "Opisz, kiedy/jak delegować…",
        },
        backendPicker: {
          title: "Preferowany backend (opcjonalnie)",
          searchPlaceholder: "Szukaj backendów",
          noPreference: {
            subtitle: "Pozwól agentowi wybrać backend.",
          },
        },
        modelPicker: {
          title: "Preferowany model (opcjonalnie)",
          searchPlaceholder: "Szukaj modeli",
          noPreference: {
            subtitle: "Pozwól backendowi wybrać domyślny model.",
          },
        },
        intent: {
          title: "Sugerowana intencja (opcjonalnie)",
          noPreference: {
            subtitle: "Pozwól agentowi zdecydować o intencji.",
          },
          options: {
            review: {
              title: "Przegląd",
              subtitle: "Przegląd kodu / ustalenia.",
            },
            plan: {
              title: "Planowanie",
              subtitle: "Planowanie / architektura.",
            },
            delegate: {
              title: "Deleguj",
              subtitle: "Delegowanie / wykonanie.",
            },
          },
        },
          exampleToolCalls: {
            label: "Przykładowe wywołania narzędzi (opcjonalnie, po jednym na linię)",
            placeholder: "np. execution.run.start …",
          },
        },
        settings: {
          groupTitle: "Subagent",
          disabled: {
            footer:
              "Execution runs są wyłączone. Włącz Execution Runs w Ustawienia → Funkcje, aby używać wskazówek delegowania.",
            enableExecutionRuns: {
              title: "Włącz Execution Runs",
              subtitle: "Otwórz ustawienia Funkcji",
            },
          },
          footer:
            "Reguły są dopisywane do promptu systemowego, aby główny agent wiedział, kiedy i jak wolisz uruchamiać runy subagenta.",
          enableInjection: {
            title: "Włącz wstrzykiwanie wskazówek",
          },
          characterBudget: {
            title: "Limit znaków",
            subtitle: ({ value }: { value: string }) => `${value} znaków`,
            promptTitle: "Limit znaków",
            promptBody:
              "Maksymalna liczba znaków do wstrzyknięcia do promptu systemowego.",
          },
          rules: {
            groupTitle: "Reguły wskazówek",
            footerEnabled:
              "Stuknij regułę, aby edytować. Agent używa ich jako wskazówek delegowania.",
            footerDisabled: "Włącz wstrzykiwanie, aby aktywować reguły.",
            emptyTitle: "Brak reguł",
            emptySubtitle: "Dodaj regułę, aby ukierunkować delegowanie.",
            addRuleTitle: "Dodaj regułę",
            addRuleSubtitle: "Utwórz nową regułę wskazówek",
            untitled: "Bez tytułu",
            descriptionFallback: "Opisz, kiedy delegować.",
            tapToEdit: "Stuknij, aby edytować",
            meta: {
              target: ({ value }: { value: string }) => `Cel: ${value}`,
              model: ({ value }: { value: string }) => `Model: ${value}`,
              intent: ({ value }: { value: string }) => `Intencja: ${value}`,
            },
          },
          preview: {
            title: "Podgląd",
            footer:
              "To jest (skrócony) tekst dopisywany do promptu systemowego.",
            systemPromptLabel: "Prompt systemowy (dodane)",
          },
        },
      },

        settings: {
          title: "Ustawienia",
          connectedAccounts: "Połączone konta",
        connectedAccountsDisabled: "Połączone usługi są wyłączone.",
    connectAccount: "Połącz konto",
    github: "GitHub",
    machines: "Maszyny",
    features: "Funkcje",
    social: "Społeczność",
    account: "Konto",
    accountSubtitle: "Zarządzaj szczegółami konta",
    addYourPhone: "Dodaj telefon",
    addYourPhoneSubtitle: "Pokaż kod QR, aby zalogować się na telefonie",
    appearance: "Wygląd",
    appearanceSubtitle: "Dostosuj wygląd aplikacji",
      voiceAssistant: "Asystent głosowy",
      voiceAssistantSubtitle: "Konfiguruj preferencje interakcji głosowej",
      memorySearch: "Lokalne wyszukiwanie pamięci",
      memorySearchSubtitle: "Szukaj w poprzednich rozmowach (lokalnie na urządzeniu)",
      notifications: "Powiadomienia",
      notificationsSubtitle: "Preferencje powiadomień push",
      attachments: "Załączniki",
      attachmentsSubtitle: "Ustawienia przesyłania plików",
      sourceControl: "Kontrola wersji",
      sourceControlSubtitle: "Strategia commitów i zachowanie backendu",
      automations: "Automatyzacje",
      automationsSubtitle: "Zarządzaj zaplanowanymi sesjami i cyklicznymi uruchomieniami",
      executionRunsSubtitle: "Execution runs na wielu maszynach",
      connectedServices: "Połączone usługi",
      connectedServicesSubtitle: "Subskrypcje Claude/Codex i profile OAuth",
      featuresTitle: "Funkcje",
      featuresSubtitle: "Włącz lub wyłącz funkcje aplikacji",
    developer: "Deweloper",
    developerTools: "Narzędzia deweloperskie",
    about: "O aplikacji",
    actionsSettingsAboutSubtitle:
      "Włączaj lub wyłączaj akcje globalnie, dla powierzchni (UI/głos/MCP) oraz dla miejsc umieszczenia (gdzie pojawiają się w interfejsie). Wyłączone akcje są blokowane w trybie fail-closed w czasie działania.",
    aboutFooter:
      "Happier Coder to mobilny klient Codex i Claude Code. Jest w pełni szyfrowany end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu. Nie jest powiązany z Anthropic.",
    whatsNew: "Co nowego",
    whatsNewSubtitle: "Zobacz najnowsze aktualizacje i ulepszenia",
    reportIssue: "Zgłoś problem",
    privacyPolicy: "Polityka prywatności",
    termsOfService: "Warunki użytkowania",
    rateUs: "Oceń Happier",
    rateUsSubtitle: "Jeśli podoba Ci się aplikacja, krótka ocena bardzo nam pomaga",
    eula: "EULA",
    supportUs: "Wesprzyj nas",
    supportUsSubtitlePro: "Dziękujemy za wsparcie!",
    supportUsSubtitle: "Wesprzyj rozwój projektu",
    scanQrCodeToAuthenticate: "Zeskanuj kod QR, aby połączyć terminal",
    githubConnected: ({ login }: { login: string }) =>
      `Połączono jako @${login}`,
    connectGithubAccount: "Połącz konto GitHub",
    claudeAuthSuccess: "Pomyślnie połączono z Claude",
    exchangingTokens: "Wymiana tokenów...",
    usage: "Użycie",
    usageSubtitle: "Zobacz użycie API i koszty",
    profiles: "Profile",
    profilesSubtitle: "Zarządzaj profilami zmiennych środowiskowych dla sesji",
    secrets: "Sekrety",
    secretsSubtitle:
      "Zarządzaj zapisanymi sekretami (po wpisaniu nie będą ponownie pokazywane)",
      terminal: "Terminał",
    session: "Sesja",
    sessionSubtitleTmuxEnabled: "Tmux włączony",
    sessionSubtitleMessageSendingAndTmux: "Wysyłanie wiadomości i tmux",
    servers: "Serwery",
    serversSubtitle: "Zapisane serwery, grupy i ustawienia domyślne",
    systemStatus: "Stan systemu",
    systemStatusSubtitle: "Serwery, konto, maszyny, daemon",

    // Dynamic settings messages
    accountConnected: ({ service }: { service: string }) =>
      `Konto ${service} połączone`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} jest ${status === "online" ? "w sieci" : "poza siecią"}`,
  featureToggled: ({
      feature,
      enabled,
    }: {
      feature: string;
      enabled: boolean;
    }) => `${feature} ${enabled ? "włączona" : "wyłączona"}`,
  },

  systemStatus: {
    sections: {
      appHealth: "Stan aplikacji i synchronizacji",
      currentServer: "Bieżący serwer",
      identity: "Zalogowana tożsamość",
      configuredServers: "Skonfigurowane serwery",
      machinesActiveServer: "Maszyny (aktywny serwer)",
      machinesOtherServer: ({ server }: { server: string }) => `Maszyny (${server})`,
      actions: "Akcje",
    },
    ui: {
      dataReady: "Dane gotowe",
      realtime: "Czas rzeczywisty",
      socket: "Socket (WebSocket)",
      socketLastError: ({ error }: { error: string }) => `Ostatni błąd: ${error}`,
      lastSync: "Ostatnia synchronizacja",
    },
    server: {
      activeServer: "Aktywny serwer",
    },
    identity: {
      accountId: "Id konta",
      username: "Nazwa użytkownika",
    },
    servers: {
      noneConfigured: "Brak skonfigurowanych serwerów",
      active: "Aktywny",
    },
    machines: {
      none: "Brak maszyn",
      status: ({ status }: { status: string }) => `Status: ${status}`,
    },
    machine: {
      unknownHost: "Nieznana maszyna",
      online: "W sieci",
      offline: "Poza siecią",
      fetchDoctorSnapshot: {
        loading: "Pobieranie serwera/konta daemona…",
        invalid: "Nie udało się odczytać doctor snapshot z maszyny",
      },
      daemonAttributionUnknown: "Serwer/konto daemona: nieznane",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `Daemon: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `Ostatnio sprawdzono: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "Niezgodność",
    time: {
      secondsAgo: ({ count }: { count: number }) => `${count}s temu`,
      minutesAgo: ({ count }: { count: number }) => `${count}m temu`,
      hoursAgo: ({ count }: { count: number }) => `${count}h temu`,
      daysAgo: ({ count }: { count: number }) => `${count}d temu`,
    },
    actions: {
      runDiagnosis: "Uruchom diagnostykę",
      runDiagnosisSubtitle: "Wykrywa niezgodności serwera/konta/daemona",
      refreshMachineAttribution: "Odśwież atrybucję daemona",
      refreshMachineAttributionSubtitle: "Pobierz serwer/konto daemona dla kilku maszyn online",
      copyJson: "Kopiuj JSON stanu systemu",
      copyJsonSubtitle: "Udostępnij zredagowany snapshot dla wsparcia",
    },
  },

  diagnosis: {
    title: "Diagnostyka",
    sections: {
      overview: "Podsumowanie",
      actions: "Akcje",
      pasteDoctorJson: "Wklej CLI doctor JSON",
      machineRuns: "Maszyny",
      serverProbe: "Sprawdzenie serwera",
      findings: "Wyniki",
    },
    overview: {
      activeServer: "Aktywny serwer",
      account: "Konto",
      onlineMachines: "Maszyny online (aktywny serwer)",
      cachedAttribution: ({ count }: { count: number }) => `Dostępne snapshoty doctor w cache: ${count}`,
    },
    actions: {
      run: "Uruchom diagnostykę",
      runSubtitle: "Sprawdza serwer, konto, maszyny i cel daemona",
      copyReport: "Kopiuj raport diagnostyki",
      copyReportSubtitle: "Kopiuj zredagowany raport JSON dla wsparcia",
    },
    pasteDoctorJson: {
      footer: "Wskazówka: uruchom `happier doctor --json` na komputerze i wklej tutaj.",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "Zweryfikuj wklejony JSON",
      ok: "Wklejony doctor JSON wygląda poprawnie.",
      helper: "Opcjonalnie: wklej doctor JSON, aby zdiagnozować niezgodności, gdy maszyna jest nieosiągalna.",
      error: ({ error }: { error: string }) => `Nieprawidłowy doctor JSON: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "Maszyna zwróciła nieprawidłowy doctor snapshot",
    },
    machineRuns: {
      none: "Brak dostępnych maszyn online",
      idle: "Bezczynne",
      loading: "Uruchamianie…",
      ready: "Gotowe",
      error: "Błąd",
    },
    serverProbe: {
      title: "Diagnostyka serwera",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "Uruchom diagnostykę, aby zobaczyć wyniki",
      notRunSubtitle: "To uruchamia bezpieczne, zredagowane sprawdzenia (bez logów, chyba że dołączysz diagnostykę w zgłoszeniu).",
      none: "Nie wykryto problemów",
      noneSubtitle: "Jeśli problem nadal występuje, wyślij zgłoszenie z diagnostyką.",
      code: ({ code }: { code: string }) => `Kod: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `Szczegóły dla ${code}`,
        steps: {
          reportIssue: "Wyślij zgłoszenie i dołącz ten raport diagnostyki.",
        },
      },
      serverMismatch: {
        title: "Niezgodność serwera (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          chooseAccount: "Zdecyduj, którego serwera/konta chcesz używać.",
          switchUiServer: "Ustaw UI i daemona na ten sam serwer.",
          restartDaemon: "Zrestartuj daemona dla właściwego serwera i spróbuj ponownie.",
        },
      },
      serverMismatchPasted: {
        title: "Niezgodność serwera (UI vs wklejone)",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • Wklejone: ${pasted}`,
      },
      settingsMismatch: {
        title: "Niezgodność między ustawieniami CLI a serwerem docelowym",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • resolved: ${resolved}`,
      },
      accountMismatch: {
        title: "Niezgodność konta (UI vs daemon)",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • Daemon: ${machine}`,
        steps: {
          signInSameAccount: "Upewnij się, że UI i CLI są zalogowane na to samo konto na tym samym serwerze.",
          cliReauth: "W CLI: wyloguj się i ponownie autoryzuj na właściwym serwerze.",
        },
      },
      machineMissingAccount: {
        title: "Maszyna nie ma informacji o koncie",
      },
      noOnlineMachines: {
        title: "Brak maszyn online",
        steps: {
          startDaemon: "Uruchom daemona (i upewnij się, że działa).",
          checkNetwork: "Sprawdź sieć i spróbuj ponownie.",
        },
      },
      serverDiagnosticsDisabled: {
        title: "Diagnostyka serwera wyłączona",
        steps: {
          ok: "To normalne, jeśli Twój serwer ma wyłączoną diagnostykę.",
        },
      },
      serverAuthError: {
        title: "Błąd autoryzacji serwera (401)",
      },
      serverUnreachable: {
        title: "Serwer nieosiągalny",
        steps: {
          checkServerUrl: "Sprawdź URL serwera i połączenie sieciowe.",
          tryAgain: "Spróbuj ponownie za chwilę.",
        },
      },
      serverHttpError: {
        title: "Błąd HTTP diagnostyki serwera",
        subtitle: ({ status }: { status: string }) => `Serwer odpowiedział: ${status}`,
      },
      activeServerNotInProfiles: {
        title: "Aktywny serwer nie znajduje się w zapisanych profilach",
      },
      multipleServers: {
        title: "Wykryto wiele serwerów na różnych maszynach",
      },
    },
  },

  connectedServices: {
    fallbackName: "Połączona usługa",
    serviceNames: {
      claudeSubscription: "Subskrypcja Claude",
      openaiCodex: "Codex od OpenAI",
      openai: "Klucz API OpenAI",
      anthropic: "Klucz API Anthropic",
      gemini: "Gemini od Google",
    },
    title: "Połączone usługi",
    authChip: {
      label: "Autoryzacja",
      labelWithCount: ({ count }: { count: number }) => `Autoryzacja: ${count}`,
    },
    list: {
      empty: "Brak połączonych usług.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "połączona usługa", few: "połączone usługi", many: "połączonych usług" })}`,
      needsReauth: "wymaga ponownej autoryzacji",
      notConnected: "niepołączone",
    },
    quota: {
      loading: "Ładowanie…",
      error: ({ message }: { message: string }) => `Błąd: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `Ostatnia aktualizacja: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Ostatnia aktualizacja: ${time} • nieaktualne`,
      noData: "Brak danych limitu",
      planLabel: ({ plan }: { plan: string }) => `Plan: ${plan}`,
    },
    oauthPaste: {
      invalidConfig: "Nieprawidłowa konfiguracja połączonej usługi.",
      connectWebGroupTitle: "Połącz (web)",
      connectWebDescription:
        "Otwórz URL autoryzacji, dokończ OAuth w przeglądarce, a następnie skopiuj i wklej końcowy przekierowany URL z powrotem do Happier.",
      openAuthorizationUrl: "Otwórz URL autoryzacji",
      opensInNewTab: "Otwiera się w nowej karcie",
      preparing: "Przygotowywanie…",
      pasteRedirectUrl: "Wklej URL przekierowania",
      pasteRedirectUrlPlaceholder: "Wklej URL przekierowania",
      pasteRedirectUrlPromptBody:
        "Po ukończeniu OAuth skopiuj końcowy przekierowany URL z paska adresu przeglądarki i wklej go tutaj.",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "Następny krok: zaloguj się na otwartej stronie. Claude może pokazać ciąg kodu zamiast automatycznego przekierowania.",
          pasteRedirectUrlPromptBody:
            "1) Zaloguj się na otwartej stronie. 2) Skopiuj końcowy URL albo pełną wartość \"code#state\" pokazaną przez Claude. 3) Wklej ją w polu poniżej.",
          pasteRedirectUrlPlaceholder: "Wklej URL przekierowania lub code#state",
          errors: {
            missingState:
              "Brakuje stanu OAuth. Jeśli Claude pokazuje kod, skopiuj pełną wartość \"code#state\", a nie sam kod.",
          },
        },
      },
      tryDeviceInstead: "Spróbuj uwierzytelniania urządzenia",
      tryEmbeddedInstead: "Spróbuj przeglądarki w aplikacji",
      working: "Przetwarzanie…",
      alerts: {
        connectedTitle: "Połączono",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) jest połączone.`,
        failedToOpenUrl: "Nie udało się otworzyć URL",
        failedToConnect: "Nie udało się połączyć",
      },
      errors: {
        missingState: "Brak stanu OAuth w URL przekierowania.",
        stateMismatch: "Stan OAuth nie zgadza się.",
      },
    },
    oauthEmbedded: {
      title: "Połącz (przeglądarka w aplikacji)",
      description:
        "Rozpocznij logowanie w osadzonej przeglądarce. Jeśli to nie zadziała, użyj metody wklejania przekierowania.",
      startButton: "Rozpocznij logowanie",
    },
    deviceAuth: {
      invalidConfig: "Nieprawidłowa konfiguracja połączonej usługi.",
      title: "Połącz (urządzenie)",
      description:
        "Otwórz stronę weryfikacji, wpisz kod i pozostaw ten ekran otwarty, aż połączenie zostanie zakończone.",
      openVerificationUrl: "Otwórz stronę weryfikacji",
      userCode: "Kod użytkownika",
      securityHint:
        "Wskazówka: stuknij Kopiuj, aby skopiować kod. Wpisuj go tylko na auth.openai.com. Nigdy nikomu go nie udostępniaj.",
      deviceAuthDisabledHint:
        "Jeśli strona weryfikacji informuje, że autoryzacja kodem urządzenia jest wyłączona, włącz „Enable device code authorization for Codex” w ustawieniach ChatGPT i spróbuj ponownie.",
      preparing: "Przygotowywanie…",
      waiting: "Oczekiwanie na zatwierdzenie…",
      polling: "Sprawdzanie zatwierdzenia…",
      usePasteInstead: "Użyj zamiast tego wklejonego URL przekierowania",
      useBrowserInstead: "Użyj zamiast tego przeglądarki w aplikacji",
      alerts: {
        connectedTitle: "Połączono",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId} (${profileId}) jest połączone.`,
        failedToConnect: "Nie udało się połączyć",
        failedToStart: "Nie udało się rozpocząć uwierzytelniania urządzenia",
      },
    },
    detail: {
      unknownService: "Nieznana połączona usługa.",
      actionsGroupTitle: "Akcje",
      actions: {
        setDefault: "Ustaw jako domyślny",
        unsetDefault: "Usuń domyślny",
        editLabel: "Edytuj etykietę",
        reconnect: "Połącz ponownie",
      },
      setDefaultProfileTitle: "Ustaw domyślny profil",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Domyślny: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Wybierz, który profil ma być domyślnie zaznaczony",
      setProfileLabelTitle: "Ustaw etykietę profilu",
      setProfileLabelSubtitle:
        "Opcjonalna etykieta widoczna w selektorach logowania",
      addOauthProfileTitle: "Dodaj profil OAuth",
      addOauthProfileSubtitle: "Połącz nowy profil konta",
      addOauthProfileDeviceTitle: "Dodaj przez uwierzytelnianie urządzenia",
      addOauthProfileDeviceSubtitle: "Zalecane dla web/środowisk zdalnych",
      addOauthProfilePasteTitle: "Dodaj przez wklejenie przekierowania",
      addOauthProfilePasteSubtitle: "Ręczny przepływ kopiuj/wklej URL przekierowania",
      addOauthProfileBrowserTitle: "Dodaj przez przeglądarkę w aplikacji",
      addOauthProfileBrowserSubtitle: "Użyj wbudowanej przeglądarki tam, gdzie to wspierane",
      connectApiKeyTitle: "Połącz kluczem API",
      connectApiKeySubtitle: "Wklej klucz API Anthropic",
      connectSetupTokenTitle: "Połącz setup-token",
      connectSetupTokenSubtitle: "Wklej setup-token Claude (z claude setup-token)",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Odłączyć ${service} (${profileId})?`,
      prompts: {
        profileIdTitle: "Id profilu",
        profileIdBody: "Użyj krótkiej etykiety, np. work, personal, alt.",
        apiKeyTitle: "Klucz API",
        apiKeyBody: "Wklej swój klucz API Anthropic.",
        apiKeyPlaceholder: "np. sk-ant-…",
        setupTokenTitle: "Token konfiguracji",
        setupTokenBody: "Wklej swój setup-token Claude (z claude setup-token).",
        setupTokenPlaceholder: "np. sk-ant-oat01-…",
        profileLabelTitle: "Etykieta profilu",
        profileLabelBody: "Opcjonalne. Wyświetlane w wyborze autoryzacji.",
        profileLabelPlaceholder: "Konto służbowe",
      },
      alerts: {
        invalidProfileIdTitle: "Nieprawidłowe id profilu",
        invalidProfileIdBody:
          "Użyj liter, cyfr, myślnika lub podkreślenia (maks. 64).",
        unknownProfileTitle: "Nieznany profil",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Nie istnieje profil \"${profileId}\" dla ${service}.`,
      },
      profiles: {
        empty: "Brak profili.",
        connected: "Połączono",
        defaultBadge: "Domyślny",
        needsReauth: "Wymaga ponownej autoryzacji",
      },
    },
    profile: {
      profileId: "Id profilu",
      status: "Stan",
      email: "E-mail",
      accountId: "Id konta",
      quotaTitle: "Limity",
      defaultSubtitle: "Ten profil jest domyślnie wybrany",
      setDefaultSubtitle: "Użyj tego profilu domyślnie",
      disconnectSubtitle: "Usuń poświadczenia dla tego profilu",
      reconnectSubtitle: "Ponownie uwierzytelnij ten profil",
    },
    authModal: {
      nativeAuthTitle: "Natywne uwierzytelnianie backendu",
      nativeAuthSubtitle: "Użyj lokalnego logowania CLI / kluczy API",
      connectedServicesTitle: "Użyj połączonych usług",
      connectedServicesSubtitle: "Pobierz i zmaterializuj z chmury Happier",
      notConnectedTitle: "Nie połączono",
      notConnectedSubtitle: "Dotknij, aby otworzyć ustawienia",
      profileLabel: "Profil",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Plik zbyt duży",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Pominięto ${count} ${plural({ count, one: "plik", few: "pliki", many: "plików" })}, które przekraczają maksymalny rozmiar załącznika.`,
    },
  },

  settingsAttachments: {
    disabled: {
      title: "Załączniki",
      footer:
        "Ta funkcja jest wyłączona przez serwer lub politykę kompilacji.",
    },
    fileUploads: {
      title: "Przesyłanie plików",
    },
    uploadLocation: {
      title: "Lokalizacja przesyłania",
      footer:
        "Przesyłanie do katalogu workspace to najbardziej kompatybilna opcja. Przesyłanie do katalogu tymczasowego systemu może pomóc uniknąć artefaktów w repozytorium, ale może nie być czytelne w bardziej restrykcyjnych sandboxach.",
      options: {
        workspace: {
          title: "Katalog workspace (zalecane)",
          subtitle:
            "Pliki są zapisywane w katalogu względnym względem workspace, aby sandbox agenta mógł je niezawodnie odczytać.",
        },
        osTemp: {
          title: "Katalog tymczasowy systemu",
          subtitle:
            "Pliki są zapisywane w katalogu tymczasowym systemu. To może nie działać w bardziej restrykcyjnych sandboxach.",
        },
      },
    },
    workspaceDirectory: {
      title: "Katalog workspace",
      footer:
        "Używane tylko wtedy, gdy lokalizacja przesyłania jest ustawiona na Katalog workspace.",
      uploadsDirectory: {
        title: "Katalog przesyłek",
        promptTitle: "Katalog przesyłek",
        promptMessage:
          "Wpisz katalog względny względem workspace (bez ścieżek bezwzględnych, bez ..).",
        invalidDirectoryTitle: "Nieprawidłowy katalog",
        invalidDirectoryMessage: "Użyj ścieżki względnej, np. `.happier/uploads`.",
      },
    },
    sourceControlIgnore: {
      title: "Ignorowanie w kontroli wersji",
      footer:
        "Lokalne ignorowanie pomaga uniknąć przypadkowych commitów. Jeśli wybierzesz .gitignore, może to zmodyfikować śledzony plik.",
      options: {
        gitInfoExclude: {
          title: "Ignoruj lokalnie (.git/info/exclude) (zalecane)",
          subtitle:
            "Zapobiega przypadkowym commitom bez modyfikowania plików repozytorium.",
        },
        gitignore: {
          title: "Ignoruj przez .gitignore",
          subtitle:
            "Dopisuje wpis do pliku .gitignore w workspace (może zostać commitowany).",
        },
        none: {
          title: "Nie zapisuj reguł ignorowania",
          subtitle:
            "Przesyłane pliki mogą zostać wykryte przez kontrolę wersji zależnie od konfiguracji repo.",
        },
      },
      writeIgnoreRules: {
        title: "Zapisuj reguły ignorowania",
      },
    },
    limits: {
      title: "Limity",
      footer:
        "Te limity są egzekwowane przez lokalny handler przesyłania w CLI (best-effort).",
      invalidValueTitle: "Nieprawidłowa wartość",
      maxAttachmentSize: {
        title: "Maks. rozmiar załącznika (bajty)",
        promptTitle: "Maks. rozmiar załącznika (bajty)",
        promptMessage: "Przykład: 26214400 dla 25MB.",
        invalidValueMessage: "Wpisz liczbę z zakresu 1024–1073741824.",
      },
      uploadTtl: {
        title: "TTL przesyłania (ms)",
        promptTitle: "TTL przesyłania (ms)",
        promptMessage:
          "Jak długo przesyłka może pozostawać bezczynna, zanim wygaśnie.",
        invalidValueMessage: "Wpisz liczbę z zakresu 5000–3600000.",
      },
      chunkSize: {
        title: "Preferowany rozmiar chunku (bajty)",
        promptTitle: "Preferowany rozmiar chunku (bajty)",
        promptMessage: "CLI może ograniczyć to do bezpiecznych wartości.",
        invalidValueMessage: "Wpisz liczbę z zakresu 4096–1048576.",
      },
    },
  },

  settingsSourceControl: {
    commitStrategy: {
      title: "Strategia commitu",
      footer:
        "Commit atomowy unika interferencji między agentami w indeksie. Staging Git umożliwia interaktywne przepływy include/exclude.",
      options: {
        atomic: {
          title: "Commit atomowy (zalecane)",
          subtitle:
            "Brak stagingu na żywo w indeksie repozytorium. Commituje wszystkie oczekujące zmiany w jednej operacji RPC.",
        },
        gitStaging: {
          title: "Przepływ stagingu Git",
          subtitle:
            "Włącza include/exclude oraz częściowy staging po liniach dla repozytoriów Git.",
        },
      },
    },
    gitRoutingPreference: {
      title: "Preferencja routingu dla .git",
      footer:
        "Wybierz, który backend preferować, gdy tryb repozytorium to .git.",
      options: {
        git: {
          title: "Repozytoria .git używają Git",
          subtitle: "Domyślne i zalecane dla kompatybilności.",
        },
        sapling: {
          title: "Repozytoria .git preferują Sapling",
          subtitle:
            "Używaj backendu Sapling, gdy dostępne są zarówno Git, jak i Sapling.",
        },
      },
    },
    remoteConfirmation: {
      title: "Potwierdzanie operacji zdalnych",
      footer: "Kontroluje, czy operacje pull/push wymagają potwierdzenia.",
      options: {
        always: {
          title: "Zawsze potwierdzaj pull/push",
          subtitle: "Pokazuj okna potwierdzenia dla operacji pull i push.",
        },
        pushOnly: {
          title: "Potwierdzaj tylko push",
          subtitle: "Pull uruchamia się od razu; push wymaga potwierdzenia.",
        },
        never: {
          title: "Nigdy nie potwierdzaj",
          subtitle: "Uruchamiaj pull i push natychmiast.",
        },
      },
    },
    pushRejectionRecovery: {
      title: "Odzyskiwanie po odrzuceniu push",
      footer:
        "Zachowanie, gdy push jest odrzucany, ponieważ gałąź jest za upstreamem.",
      options: {
        promptFetch: {
          title: "Zapytaj o fetch",
          subtitle:
            "Pytaj przed uruchomieniem fetch, gdy push non-fast-forward zostanie odrzucony.",
        },
        autoFetch: {
          title: "Automatyczny fetch",
          subtitle:
            "Automatycznie uruchamiaj fetch po odrzuceniu push non-fast-forward.",
        },
        manual: {
          title: "Ręczne odzyskiwanie",
          subtitle:
            "Nie uruchamiaj fetch automatycznie po odrzuceniu push.",
        },
      },
    },
    commitMessageGenerator: {
      title: "Generator wiadomości commitu",
      footer:
        "Opcjonalnie: generuj sugestie wiadomości commitu za pomocą jednorazowego zadania LLM. Wymaga wsparcia execution runs w daemonie.",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `Backend generatora: ${backendId}`,
      backendItemSubtitle:
        "Identyfikator backendu używany do jednorazowego generowania wiadomości commitu.",
      backendPromptTitle: "Backend wiadomości commitu",
      backendPromptMessage: "Wpisz identyfikator backendu",
      instructionsPlaceholder: "Instrukcje wiadomości commitu",
    },
    commitAttribution: {
      title: "Atrybucja commitu",
      footer:
        "Gdy włączone, wiadomości commitów generowane przez AI będą zawierały kredyty Co-Authored-By.",
      includeCoAuthoredBy: {
        title: "Dodaj Co-Authored-By",
      },
    },
    filesDisplay: {
      title: "Wyświetlanie plików",
      footer:
        "Podświetlanie składni jest eksperymentalne i może zostać wyłączone dla bardzo dużych diffów.",
      diffRenderer: {
        options: {
          pierre: {
            title: "Renderowanie diff: Pierre",
            subtitle:
              "Najlepsze renderowanie diffów na web/desktop. Używa pipeline z workerem i bezpiecznie przełącza się na fallback, gdy jest niedostępne.",
          },
          happier: {
            title: "Renderowanie diff: Happier",
            subtitle:
              "Renderer zapasowy dla kompatybilności i rozwiązywania problemów.",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Układ diff: Scalony",
            subtitle:
              "Widok liniowy (jedna kolumna). Najlepszy dla wąskich ekranów i szybkiego przeglądu.",
          },
          split: {
            title: "Układ diff: Obok siebie",
            subtitle:
              "Widok dzielony (dwie kolumny). Najlepszy dla dużych ekranów i precyzyjnych porównań.",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "Podświetlanie składni: Wyłączone",
            subtitle:
              "Renderuje diffy i pliki jako zwykły tekst monospaced.",
          },
          simple: {
            title: "Podświetlanie składni: Proste",
            subtitle:
              "Szybkie podświetlanie oparte na tokenach dla popularnych języków.",
          },
          advanced: {
            title: "Podświetlanie składni: Zaawansowane",
            subtitle:
              "Wyższa jakość na web/desktop; fallback do prostego na native.",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "Gęstość zmienionych plików: Wygodna",
            subtitle:
              "Większe wiersze z czytelniejszymi podtytułami i statusem.",
          },
          compact: {
            title: "Gęstość zmienionych plików: Kompaktowa",
            subtitle:
              "Mniejsze wiersze dla łatwiejszego skanowania, gdy zmieniono wiele plików.",
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
      }) => `Domyślny diff dla ${backendTitle}: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "Domyślny tryb podczas przeglądania plików z delta included i pending.",
    },
    diffMode: {
      pending: "Oczekujące",
      combined: "Połączone",
      included: "Dołączone",
    },
  },

  settingsNotifications: {
    badges: {
      title: 'Badges on this device',
      footer: 'Choose which activity contributes to the app icon badge on this device.',
      enabledTitle: 'Enable badges',
      enabledSubtitle: 'Show an app icon badge when activity needs attention',
      unreadTitle: 'Unread sessions',
      unreadSubtitle: 'Count sessions that have unread transcript activity',
      permissionRequestsTitle: 'Permission requests',
      permissionRequestsSubtitle: 'Count sessions waiting for approval',
      userActionsTitle: 'Action requests',
      userActionsSubtitle: 'Count sessions waiting for an answer or confirmation',
      queuedTitle: 'Queued user input',
      queuedSubtitle: 'Count sessions with queued work you still need to send',
      friendRequestsTitle: 'Friend requests',
      friendRequestsSubtitle: 'Add incoming friend requests to the numeric badge',
      desktopDotTitle: 'Desktop dock dot',
      desktopDotSubtitle: 'On desktop, show a dot when only non-numeric inbox activity exists',
    },
    local: {
      title: 'Local notifications on this device',
      footer: 'These controls affect how notifications appear on this specific device.',
      enabledSubtitle: 'Allow this device to show local notifications',
      readyTitle: 'Ready',
      readySubtitle: 'Show a local notification when a turn finishes',
      readyPreviewTitle: 'Ready message previews',
      readyPreviewSubtitle: 'Include the latest assistant message in ready notifications on this device',
      permissionRequestsTitle: 'Permission requests',
      permissionRequestsSubtitle: 'Show a local notification when a session needs approval',
      userActionsTitle: 'Action requests',
      userActionsSubtitle: 'Show a local notification when a session needs your input',
    },
    push: {
      title: "Powiadomienia push",
      footer:
        "Te powiadomienia są wysyłane z Twojego CLI przez Expo, gdy sesja wymaga Twojej uwagi.",
      enabledSubtitle: "Zezwól na powiadomienia push dla tego konta",
    },
    webhooks: {
      title: 'Webhook notifications',
      footer: 'Send remote activity notifications to additional webhook endpoints on this account.',
      addTitle: 'Add webhook',
      addSubtitle: 'Deliver notifications to another endpoint',
      emptyTitle: 'No webhook channels',
      emptySubtitle: 'Add a webhook to deliver remote activity events outside Expo push.',
      enabledTitle: 'Enable webhook',
      enabledSubtitle: 'Webhook notifications are enabled',
      disabledSubtitle: 'Webhook notifications are disabled',
      channelEnabledSubtitle: 'Allow this endpoint to receive activity notifications',
      urlPromptTitle: 'Webhook URL',
      urlPromptSubtitle: 'Enter the destination URL for this notification webhook.',
      urlPromptPlaceholder: 'https://hooks.example.test/notify',
      invalidUrlTitle: 'Invalid webhook URL',
            invalidUrlSubtitle: 'Enter a valid HTTP or HTTPS URL.',
            deleteTitle: 'Remove webhook',
            deleteConfirm: ({ url }: { url: string }) => `Stop sending notifications to ${url}?`,
            signingSecretTitle: 'Signing secret',
            signingSecretEmptySubtitle: 'Add a shared secret to sign webhook payloads',
            signingSecretConfiguredSubtitle: 'Webhook payloads are signed with a shared secret',
            signingSecretPromptTitle: 'Webhook signing secret',
            signingSecretPromptSubtitleAdd: 'Enter a shared secret to sign this webhook payload.',
            signingSecretPromptSubtitleReplace: 'Enter a new shared secret to replace the existing signing secret.',
            signingSecretPromptPlaceholder: 'shared-secret',
            signingSecretClearAction: 'Clear secret',
            readyTitle: 'Ready',
      readySubtitle: 'Send when a turn finishes and the agent is waiting for your command',
      readyPreviewTitle: 'Ready message previews',
      readyPreviewSubtitle: 'Include the latest assistant message text in ready notifications for this webhook',
      permissionRequestsTitle: 'Permission requests',
      permissionRequestsSubtitle: 'Send when a session is blocked waiting for approval',
      userActionsTitle: 'Action requests',
      userActionsSubtitle: 'Send when a session needs an answer or confirmation',
    },
    foregroundBehavior: {
      title: "Powiadomienia w aplikacji",
      footer:
        "Kontroluje powiadomienia podczas korzystania z aplikacji. Powiadomienia dla aktualnie przeglądanej sesji są zawsze wyciszane.",
      full: "Pełne",
      fullDescription: "Pokaż baner i odtwórz dźwięk",
      silent: "Ciche",
      silentDescription: "Pokaż baner bez dźwięku",
      off: "Wyłączone",
      offDescription: "Tylko plakietka, bez banera",
    },
    types: {
      title: "Typy",
      footer:
        "Wyłącz poszczególne typy, jeśli chcesz tylko wybrane alerty.",
      ready: {
        title: "Gotowe",
        subtitle:
          "Powiadamiaj, gdy tura się kończy i agent czeka na Twoją komendę",
      },
      readyPreview: {
        title: 'Ready message previews',
        subtitle: 'Include the latest assistant message text in push notifications for ready turns',
      },
      permissionRequests: {
        title: "Prośby o uprawnienia",
        subtitle:
          "Powiadamiaj, gdy sesja jest zablokowana i czeka na zatwierdzenie",
      },
      userActions: {
        title: "Prośby o akcję",
        subtitle:
          "Powiadamiaj, gdy sesja wymaga odpowiedzi lub potwierdzenia",
      },
    },
  },

    notifications: {
      actions: {
        allow: 'Zezwól',
        deny: 'Odmów',
        answer: 'Odpowiedz',
      },
      activity: {
        defaultSessionTitle: 'Session',
        readyFallbackBody: 'Turn finished. Open the session to continue.',
        permissionFallbackBody: 'Approval required.',
        userActionFallbackBody: 'This session needs your input.',
      },
      channels: {
        default: 'Domyślne',
        permissionRequests: 'Prośby o uprawnienia',
        userActionRequests: 'Prośby o działanie',
      },
    },

  settingsProviders: {
        title: "Ustawienia dostawcy AI",
        entrySubtitle: "Skonfiguruj opcje specyficzne dla dostawcy",
        footer:
        "Skonfiguruj opcje specyficzne dla dostawcy. Te ustawienia mogą wpływać na zachowanie sesji.",
      providerSubtitle: "Ustawienia specyficzne dla dostawcy",
      stateEnabled: "Włączone",
      stateDisabled: "Wyłączone",
      channelStable: "Stabilny",
      channelExperimental: "Eksperymentalny",
      supported: "Obsługiwane",
      notSupported: "Nieobsługiwane",
      allowed: "Dozwolone",
      notAllowed: "Niedozwolone",
      notAvailable: "Niedostępne",
      enabledTitle: "Włączone",
      enabledSubtitle: "Używaj tego backendu w selektorach, profilach i sesjach",
      releaseChannelTitle: "Kanał wydań",
      capabilitiesTitle: "Możliwości",
      resumeSupportTitle: "Obsługa wznawiania",
      sessionModeSupportTitle: "Obsługa trybu sesji",
      runtimeModeSwitchingTitle: "Przełączanie trybu w czasie działania",
      localControlTitle: "Sterowanie lokalne",
      resumeSupportSupported: "Obsługiwane",
      resumeSupportSupportedExperimental: "Obsługiwane (eksperymentalne)",
      resumeSupportRuntimeGatedAcpLoadSession:
        "Kontrolowane w runtime przez ACP loadSession",
      resumeSupportNotSupported: "Nieobsługiwane",
      sessionModeNone: "Brak trybów ACP",
      sessionModeAcpPolicyPresets: "Presety polityk ACP",
      sessionModeAcpAgentModes: "Tryby agenta ACP",
      sessionModeStaticAgentModes: "Statyczne tryby agenta",
      runtimeSwitchNone: "Brak przełączania w runtime",
      runtimeSwitchMetadataGating: "Kontrolowane metadanymi",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchProviderNative: "Natywne dla dostawcy",
      modelsTitle: "Modele",
      modelSelectionTitle: "Wybór modelu",
      freeformModelIdsTitle: "Dowolne identyfikatory modeli",
      defaultModelTitle: "Model domyślny",
      catalogModelListTitle: "Lista modeli katalogu",
      catalogModelListEmpty: "Brak dostępnych modeli katalogu",
      dynamicModelProbeTitle: "Dynamiczne wykrywanie modeli",
      dynamicModelProbeAuto: "Automatycznie",
      dynamicModelProbeStaticOnly: "Tylko statyczne",
      nonAcpApplyScopeTitle: "Zakres stosowania modelu (bez ACP)",
      nonAcpApplyScopeSpawnOnly: "Stosuj przy starcie sesji",
      nonAcpApplyScopeNextPrompt: "Stosuj przy następnym poleceniu",
      acpApplyBehaviorTitle: "Sposób stosowania modelu (ACP)",
      acpApplyBehaviorSetModel: "Ustawiaj model na żywo",
      acpApplyBehaviorRestartSession: "Restartuj sesję",
      acpConfigOptionTitle: "Id opcji konfiguracji modelu ACP",
      cliConnectionTitle: "CLI i połączenie",
      targetMachineTitle: "Maszyna docelowa",
      detectedCliTitle: "Wykryte CLI",
      installSetupTitle: "Instalacja / konfiguracja",
      installInfoSeeSetupGuide: "Zobacz przewodnik konfiguracji",
      installInfoUseProviderCliInstaller: "Użyj instalatora CLI dostawcy",
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) =>
          `Zainstaluj ${provider} CLI`,
        reinstallTitle: ({ provider }: { provider: string }) =>
          `Zainstaluj ponownie ${provider} CLI`,
        autoInstallUnavailable:
          "Automatyczna instalacja nie jest dostępna dla tej maszyny.",
        installSubtitle:
          "Instaluje CLI dostawcy na wybranej maszynie (best-effort).",
        reinstallSubtitle:
          "Uruchamia ponownie instalator dostawcy nawet jeśli CLI jest już zainstalowane.",
        noMachineSelected: "Nie wybrano maszyny.",
        installNotSupported: "Instalacja nie jest obsługiwana na tej maszynie.",
        installFailed: "Instalacja nie powiodła się.",
        installed: "Zainstalowano.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL przewodnika konfiguracji",
      connectedServiceTitle: "Połączona usługa",
      notFoundTitle: "Nie znaleziono dostawcy",
      notFoundSubtitle: "Ten dostawca nie ma ekranu ustawień.",
      noOptionsAvailable: "Brak dostępnych opcji",
      invalidNumber: "Nieprawidłowa liczba",
    invalidJson: "Nieprawidłowy JSON",
  },

  settingsAppearance: {
    // Appearance settings screen
    theme: "Motyw",
    themeDescription: "Wybierz preferowaną kolorystykę",
    themeOptions: {
      adaptive: "Adaptacyjny",
      light: "Jasny",
      dark: "Ciemny",
    },
    themeDescriptions: {
      adaptive: "Dopasuj do ustawień systemu",
      light: "Zawsze używaj jasnego motywu",
      dark: "Zawsze używaj ciemnego motywu",
    },
    display: "Wyświetlanie",
    displayDescription: "Kontroluj układ i odstępy",
    multiPanePanels: "Panele po prawej",
    multiPanePanelsDescription:
      "Pokaż skalowalne panele po prawej stronie dla plików i kontroli wersji (web/tablet)",
    sessionsRightPaneDefaultOpen: "Zawsze pokazuj prawy pasek boczny w sesjach",
    sessionsRightPaneDefaultOpenDescription:
      "Automatycznie otwieraj prawy pasek boczny po wejściu do sesji (web/tablet)",
    detailsPaneTabsBehavior: "Karty edytora",
    detailsPaneTabsBehaviorDescription:
      "Wybierz, jak zachowują się karty plików w panelu edytora",
    detailsPaneTabsBehaviorOptions: {
      preview: "Karta podglądu",
      persistent: "Trwałe karty",
    },
    editorFocusMode: "Tryb skupienia edytora",
    editorFocusModeDescription:
      "Ukryj rozmowę i pasek boczny podczas przeglądania plików (web/tablet)",
    inlineToolCalls: "Wbudowane wywołania narzędzi",
    inlineToolCallsDescription:
      "Wyświetlaj wywołania narzędzi bezpośrednio w wiadomościach czatu",
    expandTodoLists: "Rozwiń listy zadań",
    expandTodoListsDescription: "Pokazuj wszystkie zadania zamiast tylko zmian",
    showLineNumbersInDiffs: "Pokaż numery linii w różnicach",
    showLineNumbersInDiffsDescription:
      "Wyświetlaj numery linii w różnicach kodu",
    showLineNumbersInToolViews: "Pokaż numery linii w widokach narzędzi",
    showLineNumbersInToolViewsDescription:
      "Wyświetlaj numery linii w różnicach widoków narzędzi",
    wrapLinesInDiffs: "Zawijanie linii w różnicach",
    wrapLinesInDiffsDescription:
      "Zawijaj długie linie zamiast przewijania poziomego w widokach różnic",
    alwaysShowContextSize: "Zawsze pokazuj rozmiar kontekstu",
    alwaysShowContextSizeDescription:
      "Wyświetlaj użycie kontekstu nawet gdy nie jest blisko limitu",
    agentInputActionBarLayout: "Pasek akcji pola wpisywania",
    agentInputActionBarLayoutDescription:
      "Wybierz, jak wyświetlać chipy akcji nad polem wpisywania",
    agentInputActionBarLayoutOptions: {
      auto: "Automatycznie",
      wrap: "Zawijanie",
      scroll: "Przewijany",
      collapsed: "Zwinięty",
    },
    agentInputChipDensity: "Gęstość chipów akcji",
    agentInputChipDensityDescription:
      "Wybierz, czy chipy akcji pokazują etykiety czy ikony",
    agentInputChipDensityOptions: {
      auto: "Automatycznie",
      labels: "Etykiety",
      icons: "Tylko ikony",
    },
    avatarStyle: "Styl awatara",
    avatarStyleDescription: "Wybierz wygląd awatara sesji",
    avatarOptions: {
      pixelated: "Pikselowy",
      gradient: "Gradientowy",
      brutalist: "Brutalistyczny",
    },
    showFlavorIcons: "Pokaż ikony dostawcy AI",
    showFlavorIconsDescription:
      "Wyświetlaj ikony dostawcy AI na awatarach sesji",
    compactSessionView: "Kompaktowy widok sesji",
    compactSessionViewDescription:
      "Pokazuj aktywne sesje w bardziej zwartym układzie",
    compactSessionViewMinimal: "Minimalny widok kompaktowy",
    compactSessionViewMinimalDescription:
      "Usuń awatary i pokaż bardzo kompaktowy układ wiersza sesji",
    text: "Tekst",
    textDescription: "Dostosuj rozmiar tekstu w aplikacji",
    textSize: "Rozmiar tekstu",
    textSizeDescription: "Zwiększ lub zmniejsz tekst",
    textSizeOptions: {
      xxsmall: "Bardzo bardzo mały",
      xsmall: "Bardzo mały",
      small: "Mały",
      default: "Domyślny",
      large: "Duży",
      xlarge: "Bardzo duży",
      xxlarge: "Bardzo bardzo duży",
    },
  },

  settingsFeatures: {
    // Features settings screen
    experiments: "Eksperymenty",
    experimentsDescription:
      "Włącz eksperymentalne funkcje, które są nadal w rozwoju. Te funkcje mogą być niestabilne lub zmienić się bez ostrzeżenia.",
    experimentalFeatures: "Funkcje eksperymentalne",
    experimentalFeaturesEnabled: "Funkcje eksperymentalne włączone",
    experimentalFeaturesDisabled: "Używane tylko stabilne funkcje",
    experimentalOptions: "Opcje eksperymentalne",
      experimentalOptionsDescription:
        "Wybierz, które funkcje eksperymentalne są włączone.",
    localTogglesTitle: "Funkcje",
    localTogglesFooter:
      "Lokalne przełączniki funkcji (niezależnie od wsparcia serwera).",
    featureDiagnostics: {
      title: "Diagnostyka funkcji",
      footer:
        "Rozwiązane decyzje funkcji (polityka kompilacji, polityka lokalna, sondy demona/serwera i zakres).",
      decisionUnknown: "nieznane",
      decisionEnabled: "włączone",
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
      expAutomations: "Automatyzacje",
      expAutomationsSubtitle: "Włącz interfejs automatyzacji i harmonogram",
      expExecutionRuns: "Wykonania",
      expExecutionRunsSubtitle:
        "Włącz powierzchnie sterowania wykonaniami (sub-agenci / recenzje)",
      expAttachmentsUploads: "Wysyłanie załączników",
      expAttachmentsUploadsSubtitle:
        "Włącz przesyłanie plików/obrazów, aby agent mógł je czytać z dysku",
      expUsageReporting: "Raport użycia",
      expUsageReportingSubtitle: "Włącz ekrany użycia i raportowania tokenów",
    expScmOperations: "Operacje kontroli wersji",
    expScmOperationsSubtitle:
      "Włącz eksperymentalne operacje zapisu kontroli wersji (stage/commit/push/pull)",
      expFilesReviewComments: "Komentarze przeglądu plików",
      expFilesReviewCommentsSubtitle:
        "Dodawaj komentarze przeglądu na poziomie linii z widoków pliku i diff, a potem wyślij je jako ustrukturyzowaną wiadomość",
      expFilesDiffSyntaxHighlighting: "Podświetlanie składni w diff",
      expFilesDiffSyntaxHighlightingSubtitle:
        "Włącz podświetlanie składni w diff i widokach kodu (z limitami wydajności)",
      expFilesAdvancedSyntaxHighlighting: "Zaawansowane podświetlanie składni",
      expFilesAdvancedSyntaxHighlightingSubtitle:
        "Użyj cięższego, bardziej wiernego podświetlania składni (tylko web, może być wolniejsze)",
      expFilesEditor: "Wbudowany edytor plików",
      expFilesEditorSubtitle:
        "Włącz edycję plików bezpośrednio z przeglądarki plików (Monaco w web/desktop, CodeMirror w native)",
      expSessionType: "Wybór typu sesji",
      expSessionTypeSubtitle:
        "Pokaż wybór typu sesji (prosta vs worktree)",
      expZen: "Tryb Zen",
      expZenSubtitle: "Włącz wpis nawigacji Zen",
      expVoiceAuthFlow: "Przepływ uwierzytelniania głosu",
      expVoiceAuthFlowSubtitle:
        "Użyj uwierzytelnionego przepływu tokenu głosu (z paywallem)",
    voice: "Głos",
    voiceSubtitle: "Włącz funkcje głosowe",
      expVoiceAgent: "Agent głosowy",
      expVoiceAgentSubtitle:
        "Włącz powierzchnie agenta głosowego oparte o daemon (wymaga wykonań)",
      expConnectedServices: "Połączone usługi",
      expConnectedServicesSubtitle:
        "Włącz ustawienia połączonych usług i powiązania sesji",
      expConnectedServicesQuotas: "Limity połączonych usług",
      expConnectedServicesQuotasSubtitle:
        "Pokaż odznaki limitów i wskaźniki użycia dla połączonych usług",
      expMemorySearch: "Wyszukiwanie pamięci",
      expMemorySearchSubtitle:
        "Włącz ekrany i ustawienia lokalnego wyszukiwania pamięci",
    expFriends: "Znajomi",
    expFriendsSubtitle:
      "Włącz funkcje znajomych (karta Skrzynka odbiorcza i udostępnianie sesji)",
    webFeatures: "Funkcje webowe",
    webFeaturesDescription:
      "Funkcje dostępne tylko w wersji webowej aplikacji.",
    enterToSend: "Enter aby wysłać",
    enterToSendEnabled:
      "Naciśnij Enter, aby wysłać (Shift+Enter dla nowej linii)",
    enterToSendDisabled: "Enter wstawia nową linię",
      historyScope: "Historia wiadomości",
      historyScopePerSession: "Przewijaj historię na terminal",
      historyScopeGlobal: "Przewijaj historię we wszystkich terminalach",
      historyScopeModalTitle: "Historia wiadomości",
      historyScopeModalMessage:
        "Wybierz, czy Strzałka w górę/Strzałka w dół przewija tylko wiadomości wysłane w tym terminalu, czy we wszystkich terminalach.",
      historyScopePerSessionOption: "Na terminal",
      historyScopeGlobalOption: "Globalnie",
      commandPalette: "Paleta poleceń",
      commandPaletteEnabled: "Naciśnij ⌘K, aby otworzyć",
      commandPaletteDisabled: "Szybki dostęp do poleceń wyłączony",
      hideInactiveSessions: "Ukryj nieaktywne sesje",
      hideInactiveSessionsSubtitle: "Wyświetlaj tylko aktywne czaty na liście",
    sessionListActiveGrouping: "Grupowanie aktywnych sesji",
    sessionListActiveGroupingSubtitle:
      "Wybierz, jak aktywne sesje są grupowane na pasku bocznym",
    sessionListInactiveGrouping: "Grupowanie nieaktywnych sesji",
    sessionListInactiveGroupingSubtitle:
      "Wybierz, jak nieaktywne sesje są grupowane na pasku bocznym",
    sessionListGrouping: {
      projectTitle: "Projekt",
      projectSubtitle: "Grupuj sesje według maszyny i ścieżki",
      dateTitle: "Data",
      dateSubtitle: "Grupuj sesje według daty ostatniej aktywności",
    },
    groupInactiveSessionsByProject: "Grupuj nieaktywne sesje według projektu",
    groupInactiveSessionsByProjectSubtitle:
      "Porządkuj nieaktywne czaty według projektu",
      environmentBadge: "Odznaka środowiska",
      environmentBadgeSubtitle:
        "Pokaż małą odznakę obok tytułu Happier wskazującą bieżące środowisko aplikacji",
    enhancedSessionWizard: "Ulepszony kreator sesji",
    enhancedSessionWizardEnabled: "Aktywny launcher z profilem",
    enhancedSessionWizardDisabled: "Używanie standardowego launchera sesji",
    profiles: "Profile AI",
    profilesEnabled: "Wybór profili włączony",
    profilesDisabled: "Wybór profili wyłączony",
    pickerSearch: "Wyszukiwanie w selektorach",
    pickerSearchSubtitle:
      "Pokaż pole wyszukiwania w selektorach maszyn i ścieżek",
    machinePickerSearch: "Wyszukiwanie maszyn",
    machinePickerSearchSubtitle: "Pokaż pole wyszukiwania w selektorach maszyn",
    pathPickerSearch: "Wyszukiwanie ścieżek",
    pathPickerSearchSubtitle: "Pokaż pole wyszukiwania w selektorach ścieżek",
  },

  errors: {
    networkError: "Wystąpił błąd sieci",
    serverError: "Wystąpił błąd serwera",
    unknownError: "Wystąpił nieznany błąd",
    connectionTimeout: "Przekroczono czas oczekiwania na połączenie",
    authenticationFailed: "Uwierzytelnienie nie powiodło się",
    permissionDenied: "Brak uprawnień",
      fileNotFound: "Plik nie został znaleziony",
      invalidFormat: "Nieprawidłowy format",
      operationFailed: "Operacja nie powiodła się",
      failedToForkSession: "Nie udało się utworzyć gałęzi sesji",
      daemonUnavailableTitle: "Demon niedostępny",
      daemonUnavailableBody:
        "Happier nie może połączyć się z demonem na tej maszynie. Może być offline, w trakcie uruchamiania lub odłączony od serwera.",
      tryAgain: "Spróbuj ponownie",
      contactSupport:
        "Skontaktuj się z pomocą techniczną, jeśli problem będzie się powtarzał",
      sessionNotFound: "Sesja nie została znaleziona",
      voiceSessionFailed: "Nie udało się uruchomić sesji głosowej",
    voiceServiceUnavailable: "Usługa głosowa jest tymczasowo niedostępna",
    voiceAlreadyStarting: "Głos uruchamia się już w innej sesji",
    oauthInitializationFailed: "Nie udało się zainicjować przepływu OAuth",
    tokenStorageFailed: "Nie udało się zapisać tokenów uwierzytelniania",
    oauthStateMismatch:
      "Weryfikacja bezpieczeństwa nie powiodła się. Spróbuj ponownie",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} jest już połączony z istniejącym kontem Happier. Aby zalogować się na tym urządzeniu, połącz je z urządzenia, na którym jesteś już zalogowany.`,
    tokenExchangeFailed: "Nie udało się wymienić kodu autoryzacji",
    oauthAuthorizationDenied: "Autoryzacja została odrzucona",
    webViewLoadFailed: "Nie udało się załadować strony uwierzytelniania",
    failedToLoadProfile: "Nie udało się załadować profilu użytkownika",
    userNotFound: "Użytkownik nie został znaleziony",
    sessionDeleted: "Sesja nie jest dostępna",
    sessionDeletedDescription:
      "Mogła zostać usunięta lub możesz nie mieć już do niej dostępu.",

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
    }) => `${field} musi być między ${min} a ${max}`,
    retryIn: ({ seconds }: { seconds: number }) =>
      `Ponów próbę za ${seconds} ${plural({ count: seconds, one: "sekundę", few: "sekundy", many: "sekund" })}`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (Błąd ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `Nie udało się rozłączyć ${service}`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `Nie udało się połączyć z ${service}. Spróbuj ponownie.`,
    failedToLoadFriends: "Nie udało się załadować listy przyjaciół",
    failedToAcceptRequest:
      "Nie udało się zaakceptować zaproszenia do znajomych",
    failedToRejectRequest: "Nie udało się odrzucić zaproszenia do znajomych",
    failedToRemoveFriend: "Nie udało się usunąć przyjaciela",
    searchFailed: "Wyszukiwanie nie powiodło się. Spróbuj ponownie.",
    failedToSendRequest: "Nie udało się wysłać zaproszenia do znajomych",
    failedToResumeSession: "Nie udało się wznowić sesji",
    failedToSendMessage: "Nie udało się wysłać wiadomości",
    failedToSwitchControl: "Nie udało się przełączyć trybu sterowania",
    cannotShareWithSelf: "Nie możesz udostępnić sobie",
    canOnlyShareWithFriends: "Można udostępniać tylko znajomym",
    shareNotFound: "Udostępnienie nie zostało znalezione",
    publicShareNotFound:
      "Publiczne udostępnienie nie zostało znalezione lub wygasło",
    consentRequired: "Wymagana zgoda na dostęp",
    maxUsesReached: "Osiągnięto maksymalną liczbę użyć",
    invalidShareLink: "Nieprawidłowy lub wygasły link do udostępnienia",
    missingPermissionId: "Brak identyfikatora prośby o uprawnienie",
    codexResumeNotInstalledTitle:
      "Codex resume nie jest zainstalowane na tej maszynie",
    codexResumeNotInstalledMessage:
      "Aby wznowić rozmowę Codex, zainstaluj serwer wznawiania Codex na maszynie docelowej (Szczegóły maszyny → Wznawianie Codex).",
    codexAcpNotInstalledTitle:
      "Codex ACP nie jest zainstalowane na tej maszynie",
    codexAcpNotInstalledMessage:
      "Aby użyć eksperymentu Codex ACP, zainstaluj codex-acp na maszynie docelowej (Szczegóły maszyny → Installables) lub wyłącz eksperyment.",
  },

  deps: {
    installNotSupported:
      "Zaktualizuj Happier CLI, aby zainstalować tę zależność.",
    installFailed: "Instalacja nie powiodła się",
    installed: "Zainstalowano",
    installLog: ({ path }: { path: string }) => `Log instalacji: ${path}`,
    installable: {
      codexResume: {
        title: "Serwer wznawiania Codex",
        installSpecTitle: "Źródło instalacji Codex resume",
      },
      codexAcp: {
        title: "Adapter Codex ACP",
        installSpecTitle: "Źródło instalacji Codex ACP",
      },
      installSpecDescription:
        "Specyfikacja NPM/Git/file przekazywana do `npm install` (eksperymentalne). Pozostaw puste, aby użyć domyślnej wartości demona.",
    },
    ui: {
      notAvailable: "Niedostępne",
      notAvailableUpdateCli: "Niedostępne (zaktualizuj CLI)",
      errorRefresh: "Błąd (odśwież)",
      installed: "Zainstalowano",
      installedWithVersion: ({ version }: { version: string }) =>
        `Zainstalowano (v${version})`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) =>
        `Zainstalowano (v${installedVersion}) — dostępna aktualizacja (v${latestVersion})`,
      notInstalled: "Nie zainstalowano",
      latest: "Najnowsza",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version} (tag: ${tag})`,
      registryCheck: "Sprawdzenie rejestru",
      registryCheckFailed: ({ error }: { error: string }) =>
        `Niepowodzenie: ${error}`,
      installSource: "Źródło instalacji",
      installSourceDefault: "(domyślne)",
      installSpecPlaceholder:
        "np. file:/ścieżka/do/pakietu lub github:właściciel/repo#gałąź",
      lastInstallLog: "Ostatni log instalacji",
      installLogTitle: "Log instalacji",
    },
  },

  newSession: {
    // Used by new-session screen and launch flows
    title: "Rozpocznij nową sesję",
    selectAiProfileTitle: "Wybierz profil AI",
    selectAiProfileDescription:
      "Wybierz profil AI, aby zastosować zmienne środowiskowe i domyślne ustawienia do sesji.",
    changeProfile: "Zmień profil",
    aiBackendSelectedByProfile:
      "Backend AI jest wybierany przez profil. Aby go zmienić, wybierz inny profil.",
    selectAiBackendTitle: "Wybierz backend AI",
    aiBackendLimitedByProfileAndMachineClis:
      "Ograniczone przez wybrany profil i dostępne CLI na tej maszynie.",
    aiBackendSelectWhichAiRuns: "Wybierz, które AI uruchamia Twoją sesję.",
    aiBackendNotCompatibleWithSelectedProfile: "Niezgodne z wybranym profilem.",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `Nie wykryto CLI ${cli} na tej maszynie.`,
    selectMachineTitle: "Wybierz maszynę",
    selectMachineDescription: "Wybierz, gdzie ta sesja działa.",
    selectPathTitle: "Wybierz ścieżkę",
    selectWorkingDirectoryTitle: "Wybierz katalog roboczy",
    selectWorkingDirectoryDescription:
      "Wybierz folder używany dla poleceń i kontekstu.",
    selectPermissionModeTitle: "Wybierz tryb uprawnień",
    selectPermissionModeDescription:
      "Określ, jak ściśle akcje wymagają zatwierdzenia.",
    selectModelTitle: "Wybierz model AI",
    selectModelDescription: "Wybierz model używany przez tę sesję.",
	    selectSessionTypeTitle: "Wybierz typ sesji",
	    selectSessionTypeDescription:
	      "Wybierz sesję prostą lub powiązaną z Git worktree.",
	    searchPathsPlaceholder: "Szukaj ścieżek...",
	    noMachinesFound:
	      "Nie znaleziono maszyn. Najpierw uruchom sesję Happier na swoim komputerze.",
	    allMachinesOffline: "Wszystkie maszyny są poza siecią",
	    machineOfflineInlineTitle: "Maszyna jest offline",
	    machineOfflineInlineBody:
	      "Uruchom demona na tej maszynie lub wybierz inną maszynę przed utworzeniem sesji.",
	    machineOfflineCannotStartStatus: "offline (nie można rozpocząć sesji)",
	    machineDetails: "Zobacz szczegóły maszyny →",
	    directoryDoesNotExist: "Katalog nie został znaleziony",
	    createDirectoryConfirm: ({ directory }: { directory: string }) =>
	      `Katalog ${directory} nie istnieje. Czy chcesz go utworzyć?`,
	    sessionStarted: "Sesja rozpoczęta",
    sessionStartedMessage: "Sesja została pomyślnie rozpoczęta.",
    sessionSpawningFailed:
      "Tworzenie sesji nie powiodło się - nie zwrócono ID sesji.",
    failedToStart:
      "Nie udało się uruchomić sesji. Upewnij się, że daemon działa na docelowej maszynie.",
    sessionTimeout:
      "Przekroczono czas uruchamiania sesji. Maszyna może działać wolno lub daemon może nie odpowiadać.",
    notConnectedToServer:
      "Brak połączenia z serwerem. Sprawdź połączenie internetowe.",
    daemonRpcUnavailableTitle: "Demon niedostępny",
    daemonRpcUnavailableBody:
      "Happier nie może połączyć się z demonem na tej maszynie. Może być offline, w trakcie uruchamiania lub odłączony od serwera.",
    startingSession: "Rozpoczynanie sesji...",
    startNewSessionInFolder: "Nowa sesja tutaj",
    noMachineSelected: "Proszę wybrać maszynę do rozpoczęcia sesji",
    noPathSelected: "Proszę wybrać katalog do rozpoczęcia sesji",
    machinePicker: {
      searchPlaceholder: "Szukaj maszyn...",
      recentTitle: "Ostatnie",
      favoritesTitle: "Ulubione",
      allTitle: "Wszystkie",
      emptyMessage: "Brak dostępnych maszyn",
    },
    pathPicker: {
      enterPathTitle: "Wpisz ścieżkę",
      enterPathPlaceholder: "Wpisz ścieżkę...",
      customPathTitle: "Niestandardowa ścieżka",
      recentTitle: "Ostatnie",
      favoritesTitle: "Ulubione",
      suggestedTitle: "Sugerowane",
      allTitle: "Wszystkie",
      emptyRecent: "Brak ostatnich ścieżek",
      emptyFavorites: "Brak ulubionych ścieżek",
      emptySuggested: "Brak sugerowanych ścieżek",
      emptyAll: "Brak ścieżek",
    },
    sessionType: {
      title: "Typ sesji",
      simple: "Prosta",
      worktree: "Drzewo robocze",
      comingSoon: "Wkrótce dostępne",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `Wymaga ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) => `Nie wykryto CLI ${cli}`,
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `Nie wykryto CLI ${cli}`,
      dontShowFor: "Nie pokazuj tego komunikatu dla",
      thisMachine: "tej maszyny",
      anyMachine: "dowolnej maszyny",
      installCommand: ({ command }: { command: string }) =>
        `Zainstaluj: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `Zainstaluj CLI ${cli}, jeśli jest dostępne •`,
      viewInstallationGuide: "Zobacz instrukcję instalacji →",
      viewGeminiDocs: "Zobacz dokumentację Gemini →",
    },
    worktree: {
      creating: ({ name }: { name: string }) =>
        `Tworzenie worktree '${name}'...`,
      notGitRepo: "Worktree wymaga repozytorium git",
      failed: ({ error }: { error: string }) =>
        `Nie udało się utworzyć worktree: ${error}`,
      success: "Worktree został utworzony pomyślnie",
    },
    resume: {
      title: "Wznów sesję",
      optional: "Wznów: Opcjonalnie",
      pickerTitle: "Wznów sesję",
      subtitle: ({ agent }: { agent: string }) =>
        `Wklej ID sesji ${agent}, aby wznowić`,
      placeholder: ({ agent }: { agent: string }) => `Wklej ID sesji ${agent}…`,
      paste: "Wklej",
      save: "Zapisz",
      clearAndRemove: "Wyczyść",
      helpText: "ID sesji znajdziesz na ekranie informacji o sesji.",
      cannotApplyBody:
        "Nie można teraz zastosować tego ID wznowienia. Happier uruchomi zamiast tego nową sesję.",
    },
    codexResumeBanner: {
      title: "Wznawianie Codex",
      updateAvailable: "Dostępna aktualizacja",
      systemCodexVersion: ({ version }: { version: string }) =>
        `Systemowy Codex: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Serwer Codex resume: ${version}`,
      notInstalled: "nie zainstalowano",
      latestVersion: ({ version }: { version: string }) =>
        `(najnowsza ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `Sprawdzenie rejestru nie powiodło się: ${error}`,
      install: "Zainstaluj",
      update: "Zaktualizuj",
      reinstall: "Zainstaluj ponownie",
    },
    codexResumeInstallModal: {
      installTitle: "Zainstalować Codex resume?",
      updateTitle: "Zaktualizować Codex resume?",
      reinstallTitle: "Zainstalować ponownie Codex resume?",
      description:
        "To instaluje eksperymentalny wrapper serwera MCP Codex używany wyłącznie do operacji wznawiania.",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "Zainstaluj",
      update: "Zaktualizuj",
      reinstall: "Zainstaluj ponownie",
    },
    codexAcpInstallModal: {
      installTitle: "Zainstalować Codex ACP?",
      updateTitle: "Zaktualizować Codex ACP?",
      reinstallTitle: "Zainstalować ponownie Codex ACP?",
      description:
        "To instaluje eksperymentalny adapter ACP dla Codex, który obsługuje ładowanie/wznawianie wątków.",
    },
  },

  sessionHistory: {
    // Used by session history screen
    title: "Historia sesji",
    empty: "Nie znaleziono sesji",
    today: "Dzisiaj",
    yesterday: "Wczoraj",
    daysAgo: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "dzień", few: "dni", many: "dni" })} temu`,
    viewAll: "Zobacz wszystkie sesje",
  },

  session: {
    inputPlaceholder: "Wpisz wiadomość...",
    toolCalls: "Wywołania narzędzi",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} więcej…`,
    forking: {
      dividerTitle: "Rozgałęziono z wcześniejszego kontekstu",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Rozgałęziono z ${parent}`,
      dividerSubtitle: "Starszy kontekst (tylko do odczytu)",
      openParent: "Otwórz",
      openParentA11y: "Otwórz sesję nadrzędną",
      forkFromMessageA11y: "Utwórz gałąź z tego komunikatu",
    },
    resuming: "Wznawianie...",
    resumeFailed: "Nie udało się wznowić sesji",
    pendingQueuedResumeFailedTitle: "Wiadomość w kolejce",
    pendingQueuedResumeFailedBody: "Twoja wiadomość została zapisana w kolejce oczekujących, ale Happier nie mógł wznowić tej sesji. Spróbuj ponownie, aby ją uruchomić.",
    resumeSupportNoteChecking:
      "Uwaga: Happier wciąż sprawdza, czy ta maszyna może wznowić sesję dostawcy.",
    resumeSupportNoteUnverified:
      "Uwaga: Happier nie mógł zweryfikować obsługi wznawiania na tej maszynie.",
    resumeSupportDetails: {
      cliNotDetected: "Nie wykryto CLI na maszynie.",
      capabilityProbeFailed: "Nie udało się sprawdzić możliwości.",
      acpProbeFailed: "Nie udało się sprawdzić ACP.",
      loadSessionFalse: "Agent nie obsługuje ładowania sesji.",
    },
    inactiveResumable: "Nieaktywna (można wznowić)",
    inactiveMachineOffline: "Nieaktywna (maszyna offline)",
    inactiveNotResumable: "Nieaktywna",
    inactiveNotResumableNoticeTitle: "Nie można wznowić tej sesji",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `Ta sesja została zakończona i nie można jej wznowić, ponieważ ${provider} nie obsługuje przywracania kontekstu tutaj. Rozpocznij nową sesję, aby kontynuować.`,
    machineOfflineNoticeTitle: "Maszyna jest offline",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” jest offline, więc Happier nie może jeszcze wznowić tej sesji. Przywróć maszynę online, aby kontynuować.`,
      machineOfflineCannotResume:
        "Maszyna jest offline. Przywróć ją online, aby wznowić tę sesję.",
        openRuns: "Otwórz uruchomienia sesji",
        openAutomations: "Otwórz automatyzacje sesji",
        openSubagents: ({ count }: { count: number }) => (count > 0 ? `Open agents (${count})` : 'Open agents'),
        participants: {
          to: 'Do',
          lead: 'Główny',
          sendToTitle: 'Wyślij do',
          broadcast: ({ teamId }: { teamId: string }) => `Broadcast: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `Uruchomienie ${runId}`,
          cardTo: ({ label }: { label: string }) => `Do: ${label}`,
          unsupportedAttachmentsOrReviewComments: 'Wysyłanie do odbiorcy nie obsługuje jeszcze załączników ani komentarzy do przeglądu.',
        },
        subagents: {
          messages: {
            teamLabel: ({ teamId }: { teamId: string }) => `Team: ${teamId}`,
            memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
              `${memberLabel} · ${teamId}`,
            launch: {
              createTeamTitle: "Utwórz zespół",
              createMemberTitle: "Uruchom członka zespołu",
            },
            command: {
              deleteTeamTitle: "Usuń zespół",
              deleteMemberTitle: "Wyłącz członka zespołu",
            },
          },
                    panel: {
            title: "Agenci",
            active: "Aktywne",
            recent: "Ostatnie",
            emptyActive: "Brak aktywnych agentów.",
            emptyRecent: "Nie ma jeszcze ostatnich agentów.",
            openFull: "Otwórz pełny widok",
            openAdvancedRun: "Szczegóły uruchomienia",
            send: "Wyślij wiadomość",
            delete: "Usuń",
            launchSectionTitle: "Uruchamianie",
            launchSectionSubtitle: "Uruchamiaj nowe agenty i wykonania z poziomu tej sesji.",
            sectionCount: ({ count }: { count: number }) => `${count}`,
            groupCount: ({ count }: { count: number }) => `${count} agenty`,
            launchExecutionRunsTitle: "Uruchom wykonania",
            launchExecutionRunsSubtitle: "Otwórz uruchamianie wykonania z ustawieniami przeglądu, planu lub delegowania.",
            launchExecutionRunsAdvanced: "Zaawansowane…",
            launchClaudeTeamsTitle: "Uruchom zespoły Claude",
            launchClaudeTeamsSubtitle: "Utwórz zespół lub uruchom członka zespołu za pomocą uporządkowanych poleceń zespołów Claude.",
            teamIdLabel: "ID zespołu",
            teamIdPlaceholder: "id-zespołu",
            teamDescriptionPlaceholder: "Za co odpowiada ten zespół?",
            launchClaudeTeamA11y: "Utwórz zespół Claude",
            launchClaudeTeamAction: "Utwórz zespół",
            teammateTeamIdLabel: "Zespół członka",
            teammateLabelPlaceholder: "Etykieta członka",
            teammateInstructionsPlaceholder: "Co powinien robić ten członek zespołu?",
            launchTeammateA11y: "Uruchom członka zespołu",
            launchTeammateAction: "Uruchom członka zespołu",
            typeFact: ({ value }: { value: string }) => `Type: ${value}`,
            providerFact: ({ value }: { value: string }) => `Provider: ${value}`,
            backendFact: ({ value }: { value: string }) => `Backend: ${value}`,
            intentFact: ({ value }: { value: string }) => `Intent: ${value}`,
            errors: {
              teamIdRequired: "Najpierw wpisz ID zespołu.",
              memberTeamIdRequired: "Najpierw wpisz ID zespołu członka.",
              memberLabelRequired: "Najpierw wpisz etykietę członka.",
              memberInstructionsRequired: "Najpierw wpisz instrukcje dla członka.",
            },
          },
          details: {
            unavailable: "Ten zapis agenta nie jest już dostępny.",
          },
          kind: {
            execution_run: "Uruchomienie",
            agent_team_member: "Agent zespołu",
            task_sidechain: "Agent zadania",
          },
          intent: {
            review: "Przegląd",
            plan: "Planowanie",
            delegate: "Delegowanie",
          },
        },
        actionMenu: {
          openA11y: "Otwórz akcje sesji",
        },
      detailsPanel: {
        emptyHint: "Otwórz plik lub diff z prawego panelu.",
        unsupportedTab: "Nieobsługiwana karta szczegółów.",
        closeA11y: "Zamknij szczegóły",
          openTabA11y: ({ title }: { title: string }) => `Otwórz kartę ${title}`,
          pinTabA11y: "Przypnij kartę",
          pinnedTabA11y: "Przypięta karta",
          closeTabA11y: "Zamknij kartę",
          enterFocusModeA11y: "Włącz tryb skupienia edytora",
          exitFocusModeA11y: "Wyłącz tryb skupienia edytora",
      },
  
      actionsDraft: {
        noInputHints: "Ta akcja nie ma podpowiedzi wejściowych.",
      },

    planOutput: {
      title: "Plan działania",
      recommendedBackend: "Zalecany backend",
      risks: "Ryzyka",
      milestones: "Kamienie milowe",
      adoptPlan: "Przyjmij plan",
      sending: "Wysyłanie…",
      failedToAdopt: "Nie udało się zastosować planu",
      a11y: {
        adoptPlan: "Przyjmij plan",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `Wyniki przeglądu (${count})`,
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
        untriaged: "Nieprzypisane",
        accept: "Akceptuj",
        reject: "Odrzuć",
        defer: "Odłóż",
        needsRefinement: "Wymaga doprecyzowania",
      },
      refinementPlaceholder: "Opcjonalny komentarz do doprecyzowania",
      actions: {
        applyTriage: "Zastosuj klasyfikację",
        applying: "Zastosowywanie…",
        applyAcceptedFindings: "Zastosuj zaakceptowane wyniki",
        sending: "Wysyłanie…",
      },
      errors: {
        applyTriageFailed: "Nie udało się zastosować klasyfikacji.",
        applyAcceptedFailed: "Nie udało się zastosować zaakceptowanych wyników.",
      },
    },

      pendingMessages: {
        title: "Wiadomości oczekujące",
        indicator: ({ count }: { count: number }) => `Oczekujące (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `Oczekujące (+${count})` : "Oczekujące",
        empty: "Brak oczekujących wiadomości.",
        actions: {
          up: "W górę",
          down: "W dół",
          edit: "Edytuj",
            viewMore: "Pokaż więcej",
            viewLess: "Pokaż mniej",
          steerNow: "Wstaw teraz",
          sendNow: "Wyślij teraz",
          sendNowInterrupt: "Wyślij teraz (przerwij)",
          requeue: "Przywróć do kolejki",
        },
        editPrompt: {
          title: "Edytuj oczekującą wiadomość",
        },
        removeConfirm: {
          title: "Usunąć oczekującą wiadomość?",
          body: "To usunie oczekującą wiadomość.",
        },
        steerConfirm: {
          title: "Wstawić teraz?",
          body: "Doda tę wiadomość do bieżącej tury bez jej przerywania.",
        },
        sendConfirm: {
          title: "Wyślij teraz?",
          interruptTitle: "Wyślij teraz (przerwij)?",
          body: "To przerwie bieżącą turę i wyśle tę wiadomość natychmiast.",
        },
        discarded: {
          title: "Odrzucone wiadomości",
          subtitle:
            "Te wiadomości nie zostały wysłane do agenta (np. przy przełączaniu z zdalnego na lokalny).",
          label: "Odrzucone",
          removeConfirm: {
            title: "Usunąć odrzuconą wiadomość?",
            body: "To usunie odrzuconą wiadomość.",
          },
        },
        errors: {
          updateFailed: "Nie udało się zaktualizować oczekującej wiadomości",
          deleteFailed: "Nie udało się usunąć oczekującej wiadomości",
          sendFailed: "Nie udało się wysłać oczekującej wiadomości",
          restoreFailed: "Nie udało się przywrócić odrzuconej wiadomości",
          deleteDiscardedFailed: "Nie udało się usunąć odrzuconej wiadomości",
          sendDiscardedFailed: "Nie udało się wysłać odrzuconej wiadomości",
          reorderFailed: "Nie udało się zmienić kolejności oczekujących wiadomości",
        },
      },

      sharing: {
        title: "Udostępnianie",
        directSharing: "Udostępnianie bezpośrednie",
        addShare: "Udostępnij znajomemu",
      accessLevel: "Poziom dostępu",
      shareWith: "Udostępnij",
      sharedWith: "Udostępniono",
      noShares: "Nieudostępnione",
      viewOnly: "Tylko podgląd",
      viewOnlyDescription:
        "Może przeglądać sesję, ale nie może wysyłać wiadomości.",
      viewOnlyMode: "Tylko podgląd (sesja udostępniona)",
      noEditPermission: "Masz dostęp tylko do odczytu do tej sesji.",
      canEdit: "Może edytować",
      canEditDescription: "Może wysyłać wiadomości.",
      canManage: "Może zarządzać",
      canManageDescription: "Może zarządzać udostępnianiem.",
      manageSharingDenied:
        "Nie masz uprawnień do zarządzania ustawieniami udostępniania dla tej sesji.",
      stopSharing: "Zatrzymaj udostępnianie",
      recipientMissingKeys:
        "Ten użytkownik nie zarejestrował jeszcze kluczy szyfrowania.",
      permissionApprovals: "Może zatwierdzać uprawnienia",
      allowPermissionApprovals: "Zezwól na zatwierdzanie uprawnień",
      allowPermissionApprovalsDescription:
        "Pozwala temu użytkownikowi zatwierdzać prośby o uprawnienia i uruchamiać narzędzia na Twojej maszynie.",
      permissionApprovalsDisabledTitle:
        "Zatwierdzanie uprawnień jest wyłączone",
      permissionApprovalsDisabledPublic:
        "Linki publiczne są tylko do odczytu. Nie można zatwierdzać uprawnień.",
      permissionApprovalsDisabledReadOnly:
        "Masz dostęp tylko do odczytu do tej sesji.",
      permissionApprovalsDisabledInactive:
        "Ta sesja jest nieaktywna. Nie można zatwierdzać uprawnień.",
      permissionApprovalsDisabledNotGranted:
        "Właściciel nie pozwolił Ci zatwierdzać uprawnień dla tej sesji.",
      publicReadOnlyTitle: "Link publiczny (tylko do odczytu)",
      publicReadOnlyBody:
        "Ta sesja jest udostępniona przez link publiczny. Możesz przeglądać wiadomości i wyniki narzędzi, ale nie możesz wchodzić w interakcję ani zatwierdzać uprawnień.",

      publicLink: "Link publiczny",
      publicLinkActive: "Link publiczny jest aktywny",
      publicLinkDescription: "Utwórz link, aby każdy mógł zobaczyć tę sesję.",
      createPublicLink: "Utwórz link publiczny",
      regeneratePublicLink: "Wygeneruj nowy link publiczny",
      deletePublicLink: "Usuń link publiczny",
      linkToken: "Token linku",
      tokenNotRecoverable: "Token niedostępny",
      tokenNotRecoverableDescription:
        "Ze względów bezpieczeństwa tokeny linków publicznych są przechowywane jako hash i nie można ich odzyskać. Wygeneruj nowy link, aby utworzyć nowy token.",

      expiresIn: "Wygasa za",
      expiresOn: "Wygasa",
      days7: "7 dni",
      days30: "30 dni",
      never: "Nigdy",

      maxUsesLabel: "Maksymalna liczba użyć",
      unlimited: "Bez limitu",
      uses10: "10 użyć",
      uses50: "50 użyć",
      usageCount: "Liczba użyć",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} użyć`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} użyć`,

      requireConsent: "Wymagaj zgody",
      requireConsentDescription: "Poproś o zgodę przed rejestrowaniem dostępu.",
      consentRequired: "Wymagana zgoda",
      consentDescription:
        "Ten link wymaga Twojej zgody na zapisanie adresu IP i user agenta.",
      acceptAndView: "Akceptuj i wyświetl",
      sharedBy: ({ name }: { name: string }) => `Udostępnione przez ${name}`,

      shareNotFound: "Link udostępniania nie istnieje lub wygasł",
      failedToDecrypt: "Nie udało się odszyfrować sesji",
      noMessages: "Brak wiadomości",
      session: "Sesja",
    },
  },

  commandPalette: {
    placeholder: "Wpisz polecenie lub wyszukaj...",
    noCommandsFound: "Nie znaleziono poleceń",
  },

  commandView: {
    completedWithNoOutput: "[Polecenie zakończone bez danych wyjściowych]",
  },

  delegation: {
    output: {
      title: "Delegowanie",
      deliverablesTitle: "Rezultaty",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "Odśwież modele",
    loadingModelsA11y: "Wczytywanie modeli…",
    refreshingModelsA11y: "Odświeżanie modeli…",
    searchPlaceholder: "Szukaj modeli…",
    customTitle: "Niestandardowe…",
    effectiveLabel: ({ label }: { label: string }) => `Aktywny: ${label}`,
  },

  voiceAssistant: {
    connecting: "Łączenie...",
    active: "Asystent głosowy aktywny",
    connectionError: "Błąd połączenia",
    label: "Asystent głosowy",
    tapToEnd: "Dotknij, aby zakończyć",
  },

  voiceSurface: {
    start: "Uruchom",
    stop: "Zatrzymaj",
    selectSessionToStart: "Wybierz sesje, aby uruchomic glos",
    targetSession: "Sesja docelowa",
    noTarget: "Nie wybrano sesji",
    clearTarget: "Wyczysc cel",
    a11y: {
      teleport: "Przenieś agenta głosowego",
      toggleActivity: "Przełącz aktywność głosową",
      clearActivity: "Wyczyść aktywność głosową",
    },
  },

  voiceActivity: {
    title: "Aktywnosc glosowa",
    empty: "Brak aktywnosci glosowej.",
    clear: "Wyczysc",
    format: {
      voiceAgent: "Agent głosowy",
      you: "Ty",
      assistant: "Asystent",
      assistantStreaming: "Asystent…",
      action: "Akcja",
      error: "Błąd",
      status: "Stan",
      started: "Uruchomiono",
      stopped: "Zatrzymano",
      errorFallback: "błąd",
      eventFallback: "zdarzenie",
    },
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Konfiguracja serwera",
    enterServerUrl: "Proszę wprowadzić URL serwera",
    notValidHappyServer: "To nie jest prawidłowy serwer Happier",
    changeServer: "Zmień serwer",
    continueWithServer: "Kontynuować z tym serwerem?",
    resetToDefault: "Resetuj do domyślnego",
    resetServerDefault: "Zresetować serwer do domyślnego?",
    validating: "Sprawdzanie...",
    validatingServer: "Sprawdzanie serwera...",
    serverReturnedError: "Serwer zwrócił błąd",
    failedToConnectToServer: "Nie udało się połączyć z serwerem",
    currentlyUsingCustomServer: "Aktualnie używany jest niestandardowy serwer",
    customServerUrlLabel: "URL niestandardowego serwera",
    advancedFeatureFooter:
      "To jest zaawansowana funkcja. Zmieniaj serwer tylko jeśli wiesz, co robisz. Po zmianie serwera będziesz musiał się wylogować i zalogować ponownie.",
    useThisServer: "Użyj tego serwera",
    autoConfigHint:
      "Jeśli hostujesz samodzielnie: najpierw skonfiguruj serwer, potem zaloguj się (lub utwórz konto), a na końcu połącz terminal.",
    renameServer: "Zmień nazwę serwera",
    renameServerPrompt: "Wpisz nową nazwę tego serwera.",
    renameServerGroup: "Zmień nazwę grupy serwerów",
    renameServerGroupPrompt: "Wpisz nową nazwę tej grupy serwerów.",
    serverNamePlaceholder: "Nazwa serwera",
    cannotRenameCloud: "Nie możesz zmienić nazwy serwera w chmurze.",
    removeServer: "Usuń serwer",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Usunąć "${name}" z zapisanych serwerów?`,
    removeServerGroup: "Usuń grupę serwerów",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Usunąć "${name}" z zapisanych grup serwerów?`,
    cannotRemoveCloud: "Nie możesz usunąć serwera w chmurze.",
    signOutThisServer: "Czy wylogować się także z tego serwera?",
    signOutThisServerPrompt:
      "Na tym urządzeniu znaleziono zapisane dane logowania dla tego serwera.",
    savedServersTitle: "Zapisane serwery",
    signedIn: "Zalogowano",
    signedOut: "Wylogowano",
    authStatusUnknown: "Nieznany stan uwierzytelnienia",
    switchToServer: "Przełącz na ten serwer",
    active: "Aktywny",
    default: "Domyślny",
    addServerTitle: "Dodaj serwer",
    switchForThisTab: "Przełącz dla tej karty",
    makeDefaultOnDevice: "Ustaw jako domyślny na tym urządzeniu",
    serverNameLabel: "Nazwa serwera",
    addAndUse: "Dodaj i użyj",
    addTargetsTitle: "Dodaj",
    addServerSubtitle: "Dodaj nowy serwer i przełącz na niego",
    notificationAddServerHint: "Ten serwer nie jest jeszcze zapisany na tym urządzeniu. Dodaj go poniżej, aby kontynuować.",
    serverCount: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "serwer", few: "serwery", many: "serwerów" })}`,
    useCanonicalServerUrlTitle: "Użyć kanonicznego URL serwera?",
    useCanonicalServerUrlBody:
      "Ten serwer podaje kanoniczny adres URL, który powinien działać z innych urządzeń. Użyć go zamiast wprowadzonego?",
    insecureHttpUrlTitle: "Niezabezpieczony URL serwera",
    insecureHttpUrlBody:
      "Ten adres URL używa http:// i może nie działać z telefonu lub spoza Twojej sieci LAN. Jeśli to możliwe, użyj HTTPS. Kontynuować mimo to?",
    signedOutSwitchConfirmTitle: "Nie jesteś połączony",
    signedOutSwitchConfirmBody:
      "Przełączyć na ten serwer i przejść do ekranu głównego, aby móc się zalogować lub utworzyć konto?",
    addServerGroupTitle: "Dodaj grupę serwerów",
    addServerGroupSubtitle: "Utwórz wielokrotnie używaną grupę serwerów",
    serverGroupNameLabel: "Nazwa grupy",
    serverGroupNamePlaceholder: "Moja grupa serwerów",
    serverGroupServersLabel: "Serwery",
    saveServerGroup: "Zapisz grupę",
    serverGroupMustHaveServer:
    retention: {
      title: "Retention policy",
      summary: "Summary",
      keepForever: "No automatic deletion",
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Deletes inactive sessions after ${count} ${plural({ count, singular: 'day', plural: 'days' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Deletes data after ${count} ${plural({ count, singular: 'day', plural: 'days' })}.`,
      sessionNotice: ({ count }: { count: number }) => `This server deletes inactive sessions after ${count} ${plural({ count, singular: 'day', plural: 'days' })} of inactivity.`,
      sessions: "Sessions",
      accountChanges: "Account changes",
      voiceSessionLeases: "Voice session leases",
      feedItems: "Feed items",
      sessionShareAccessLogs: "Session share access logs",
      publicShareAccessLogs: "Public share access logs",
      terminalAuthRequests: "Terminal auth requests",
      accountAuthRequests: "Account auth requests",
      authPairingSessions: "Auth pairing sessions",
      repeatKeys: "Repeat keys",
      globalLocks: "Global locks",
      automationRuns: "Automation runs",
      automationRunEvents: "Automation run events",
    },
      "Grupa serwerów musi zawierać co najmniej jeden serwer.",
    multiServerView: {
      title: "Równoległy widok wielu serwerów",
      footer: "Wybierz, czy łączyć wiele serwerów w jednej liście sesji.",
      enableTitle: "Włącz widok równoległy",
      enableSubtitle: "Pokazuj razem sesje z wybranych serwerów",
      presentationTitle: "Tryb prezentacji",
      presentation: {
        flatWithBadges: "Płaska lista z odznakami serwerów",
        groupedByServer: "Pogrupowane według serwera",
      },
    },
  },

  sessionTags: {
    searchOrAddPlaceholder: "Szukaj lub dodaj tagi",
    editTagsLabel: "Edytuj tagi",
    noTagsFound: "Brak tagów",
    newTagItem: "Nowy tag…",
    newTagTitle: "Nowy tag",
    newTagMessage: "Wpisz nazwę nowego tagu.",
    newTagConfirm: "Dodaj",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `Serwer: ${server}`,
  },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "Informacje o sesji",
	    killSession: "Zakończ sesję",
    killSessionConfirm: "Czy na pewno chcesz zakończyć tę sesję?",
    stopSession: "Zatrzymaj sesję",
    stopSessionConfirm: "Czy na pewno chcesz zatrzymać tę sesję?",
    archiveSession: "Zarchiwizuj sesję",
    archiveSessionConfirm: "Czy na pewno chcesz zarchiwizować tę sesję?",
    happySessionIdCopied: "ID sesji Happier skopiowane do schowka",
    failedToCopySessionId: "Nie udało się skopiować ID sesji Happier",
    happySessionId: "ID sesji Happier",
    claudeCodeSessionId: "ID sesji Claude Code",
    claudeCodeSessionIdCopied: "ID sesji Claude Code skopiowane do schowka",
    aiProfile: "Profil AI",
    aiProvider: "Dostawca AI",
    failedToCopyClaudeCodeSessionId:
      "Nie udało się skopiować ID sesji Claude Code",
    codexSessionId: "ID sesji Codex",
    codexSessionIdCopied: "ID sesji Codex skopiowane do schowka",
    failedToCopyCodexSessionId: "Nie udało się skopiować ID sesji Codex",
    opencodeSessionId: "ID sesji OpenCode",
    opencodeSessionIdCopied: "ID sesji OpenCode skopiowane do schowka",
    auggieSessionId: "ID sesji Auggie",
    auggieSessionIdCopied: "ID sesji Auggie skopiowane do schowka",
    geminiSessionId: "ID sesji Gemini",
    geminiSessionIdCopied: "ID sesji Gemini skopiowane do schowka",
    qwenSessionId: "ID sesji Qwen Code",
    qwenSessionIdCopied: "ID sesji Qwen Code skopiowane do schowka",
    kimiSessionId: "ID sesji Kimi",
    kimiSessionIdCopied: "ID sesji Kimi skopiowane do schowka",
    kiloSessionId: "ID sesji Kilo",
    kiloSessionIdCopied: "ID sesji Kilo skopiowane do schowka",
    piSessionId: "ID sesji Pi",
    piSessionIdCopied: "ID sesji Pi skopiowane do schowka",
    copilotSessionId: "ID sesji Copilot",
    copilotSessionIdCopied: "ID sesji Copilot skopiowano do schowka",
    metadataCopied: "Metadane skopiowane do schowka",
    failedToCopyMetadata: "Nie udało się skopiować metadanych",
    failedToKillSession: "Nie udało się zakończyć sesji",
    failedToStopSession: "Nie udało się zatrzymać sesji",
    failedToArchiveSession: "Nie udało się zarchiwizować sesji",
    connectionStatus: "Status połączenia",
    created: "Utworzono",
    lastUpdated: "Ostatnia aktualizacja",
    sequence: "Sekwencja",
    quickActions: "Szybkie akcje",
    executionRunsSubtitle: "Zobacz uruchomienia tej sesji",
    automationsTitle: "Automatyzacje",
    automationsSubtitle: "Zarządzaj zaplanowanymi wiadomościami dla tej sesji",
    viewSessionLogTitle: "Zobacz log sesji",
    viewSessionLogSubtitle: "Otwórz podgląd końcówki logu na żywo dla tej sesji",
    pinSession: "Przypnij sesję",
    unpinSession: "Odepnij sesję",
    copyResumeCommand: "Kopiuj komendę wznowienia",
    resumeCommand: ({ sessionId }: { sessionId: string }) =>
      `happier resume ${sessionId}`,
    viewMachine: "Zobacz maszynę",
    viewMachineSubtitle: "Zobacz szczegóły maszyny i sesje",
    killSessionSubtitle: "Natychmiastowo zakończ sesję",
    stopSessionSubtitle: "Zatrzymaj proces sesji",
    archiveSessionSubtitle: "Przenieś tę sesję do Archiwum",
    archivedSessions: "Zarchiwizowane sesje",
    unarchiveSession: "Przywróć z archiwum",
    unarchiveSessionConfirm: "Czy na pewno chcesz przywrócić tę sesję z archiwum?",
    unarchiveSessionSubtitle: "Przenieś tę sesję z powrotem do Inaktywnych",
    failedToUnarchiveSession: "Nie udało się przywrócić sesji z archiwum",
    metadata: "Metadane",
    host: "Host (nazwa)",
    path: "Ścieżka",
    operatingSystem: "System operacyjny",
    processId: "ID procesu",
    happyHome: "Katalog domowy Happier",
    attachFromTerminal: "Dołącz z terminala",
    tmuxTarget: "Cel tmux",
    tmuxFallback: "Fallback tmux",
    copyMetadata: "Kopiuj metadane",
    agentState: "Stan agenta",
    rawJsonDevMode: "Surowy JSON (tryb deweloperski)",
    sessionStatus: "Status sesji",
    fullSessionObject: "Pełny obiekt sesji",
    controlledByUser: "Kontrolowany przez użytkownika",
    pendingRequests: "Oczekujące żądania",
    activity: "Aktywność",
    thinking: "Myśli",
    thinkingSince: "Myśli od",
    thinkingLevel: "Poziom myślenia",
    cliVersion: "Wersja CLI",
    cliVersionOutdated: "Wymagana aktualizacja CLI",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `Zainstalowana wersja ${currentVersion}. Zaktualizuj do ${requiredVersion} lub nowszej`,
    updateCliInstructions:
      "Proszę uruchomić npm install -g @happier-dev/cli@latest",
    deleteSession: "Usuń sesję",
    deleteSessionSubtitle: "Trwale usuń tę sesję",
    deleteSessionConfirm: "Usunąć sesję na stałe?",
    deleteSessionWarning:
      "Ta operacja jest nieodwracalna. Wszystkie wiadomości i dane powiązane z tą sesją zostaną trwale usunięte.",
    failedToDeleteSession: "Nie udało się usunąć sesji",
    sessionDeleted: "Sesja została pomyślnie usunięta",
    manageSharing: "Zarządzanie udostępnianiem",
    manageSharingSubtitle:
      "Udostępnij tę sesję znajomym lub utwórz publiczny link",
    renameSession: "Zmień nazwę sesji",
    renameSessionSubtitle: "Zmień wyświetlaną nazwę tej sesji",
    renameSessionPlaceholder: "Wprowadź nazwę sesji...",
    forkSession: "Utwórz gałąź sesji",
    forkSessionSubtitle: "Utwórz nową sesję z najnowszego kontekstu",
    failedToRenameSession: "Nie udało się zmienić nazwy sesji",
    sessionRenamed: "Pomyślnie zmieniono nazwę sesji",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "Gotowy do kodowania?",
      installCli: "Zainstaluj Happier CLI",
      runIt: "Uruchom je",
      scanQrCode: "Zeskanuj kod QR",
      openCamera: "Otwórz kamerę",
      installCommand: "$ npm i -g @happier-dev/cli",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "Brak wiadomości",
      created: ({ time }: { time: string }) => `Utworzono ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "Brak aktywnych sesji",
      startNewSessionDescription:
        "Rozpocznij nową sesję na dowolnej z połączonych maszyn.",
      startNewSessionButton: "Rozpocznij nową sesję",
      openTerminalToStart:
        "Otwórz nowy terminal na komputerze, aby rozpocząć sesję.",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "Co trzeba zrobić?",
    },
    home: {
      noTasksYet: "Brak zadań. Stuknij +, aby dodać.",
    },
    view: {
      workOnTask: "Pracuj nad zadaniem",
      clarify: "Doprecyzuj",
      delete: "Usuń",
      linkedSessions: "Powiązane sesje",
      tapTaskTextToEdit: "Stuknij tekst zadania, aby edytować",
    },
  },

  agentInput: {
    dropToAttach: "Upuść, aby dołączyć pliki",
    envVars: {
      title: "Zmienne środowiskowe",
      titleWithCount: ({ count }: { count: number }) =>
        `Zmienne środowiskowe (${count})`,
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
      title: "TRYB UPRAWNIEŃ",
      effectiveLabel: ({ label }: { label: string }) => `Obowiązuje: ${label}`,
      default: "Domyślny",
      readOnly: "Tylko do odczytu",
      acceptEdits: "Akceptuj edycje",
      safeYolo: "Bezpieczne YOLO",
      yolo: "YOLO",
      plan: "Tryb planowania",
      bypassPermissions: "Tryb YOLO",
      badgeAccept: "Akceptuj",
      badgePlan: "Plan",
      badgeReadOnly: "Tylko do odczytu",
      badgeSafeYolo: "Bezpieczne YOLO",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Akceptuj wszystkie edycje",
      badgeBypassAllPermissions: "Omiń wszystkie uprawnienia",
      badgePlanMode: "Tryb planowania",
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
      on: "Indeksowanie: włączone",
      off: "Indeksowanie: wyłączone",
    },
      model: {
        title: "MODEL",
        useCliSettings: "Użyj ustawień CLI",
        configureInCli: "Skonfiguruj modele w ustawieniach CLI",
        customDescription: "Użyj id modelu, którego nie ma na liście.",
        customPromptBody: "Wpisz id modelu",
        customPlaceholder: "np. claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "TRYB UPRAWNIEŃ CODEX",
      default: "Ustawienia CLI",
      plan: "Tryb planowania",
      readOnly: "Tryb tylko do odczytu",
      safeYolo: "Bezpieczne YOLO",
      yolo: "YOLO",
      badgePlan: "Plan",
      badgeReadOnly: "Tylko do odczytu",
      badgeSafeYolo: "Bezpieczne YOLO",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "MODEL CODEX",
      gpt5CodexLow: "gpt-5-codex niski",
      gpt5CodexMedium: "gpt-5-codex średni",
      gpt5CodexHigh: "gpt-5-codex wysoki",
      gpt5Minimal: "GPT-5 Minimalny",
      gpt5Low: "GPT-5 Niski",
      gpt5Medium: "GPT-5 Średni",
      gpt5High: "GPT-5 Wysoki",
    },
    geminiPermissionMode: {
      title: "TRYB UPRAWNIEŃ GEMINI",
      default: "Domyślny",
      readOnly: "Tylko do odczytu",
      safeYolo: "Bezpieczne YOLO",
      yolo: "YOLO",
      badgeReadOnly: "Tylko do odczytu",
      badgeSafeYolo: "Bezpieczne YOLO",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "MODEL GEMINI",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "Najbardziej zaawansowany",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "Szybki i wydajny",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "Najszybszy",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `Pozostało ${percent}%`,
    },
    suggestion: {
      fileLabel: "PLIK",
      folderLabel: "KATALOG",
    },
    mode: {
      sectionTitle: "Tryb",
      badge: ({ name }: { name: string }) => `Tryb: ${name}`,
      badgePending: ({ name }: { name: string }) => `Tryb: ${name} (oczekuje)`,
      badgeA11y: ({ name }: { name: string }) => `Tryb: ${name}`,
      refreshModesA11y: "Odśwież tryby",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Oczekuje: przełączanie z ${from} na ${to}`,
      currentMode: ({ name }: { name: string }) => `Aktualnie: ${name}`,
      loadingModes: "Ładowanie trybów…",
      refreshingModes: "Odświeżanie trybów…",
      useDefaultModeHint: "Użyj domyślnego trybu dla tego agenta.",
      startIn: ({ name }: { name: string }) => `Uruchom w: ${name}`,
      build: "Buduj",
      buildDescription: "Domyślne zachowanie",
      plan: "Planowanie",
      planDescription: "Najpierw pomyśl",
    },
    acp: {
      modeSectionTitle: "Tryb",
      refreshModesA11y: "Odśwież tryby",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `Oczekuje: przełączanie z ${from} na ${to}`,
      currentMode: ({ name }: { name: string }) => `Aktualnie: ${name}`,
      loadingModes: "Ładowanie trybów…",
      refreshingModes: "Odświeżanie trybów…",
      useDefaultModeHint: "Użyj domyślnego trybu dla tego agenta.",
      startIn: ({ name }: { name: string }) => `Uruchom w: ${name}`,
      optionsSectionTitle: "Opcje",
      currentValue: ({ value }: { value: string }) => `Aktualnie: ${value}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `Oczekuje: ${current} → ${requested}`,
    },
    actionMenu: {
      title: "AKCJE",
      files: "Pliki",
      stop: "Zatrzymaj",
    },
    noMachinesAvailable: "Brak maszyn",
  },

  machineLauncher: {
    showLess: "Pokaż mniej",
    showAll: ({ count }: { count: number }) =>
      `Pokaż wszystkie (${count} ${plural({ count, one: "ścieżka", few: "ścieżki", many: "ścieżek" })})`,
    enterCustomPath: "Wprowadź niestandardową ścieżkę",
    offlineUnableToSpawn: "Nie można utworzyć nowej sesji, offline",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "Otwórz szczegóły",
    expand: "Rozwiń/zwiń",
    input: "Wejście",
    output: "Wyjście",
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} więcej`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
      unknownToolTitle: "Narzędzie",
    },
    bashView: {
      commandDiffTitle: "Surowe polecenie",
      commandDiffHint:
        "Podgląd polecenia ukrywa krótki prefiks czyszczenia środowiska, aby zachować czytelność. Pełne surowe polecenie jest pokazane poniżej.",
    },
    webFetch: {
      httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
    },
    fullView: {
      description: "Opis",
      inputParams: "Parametry wejściowe",
      output: "Wyjście",
      error: "Błąd",
      completed: "Narzędzie ukończone pomyślnie",
      noOutput: "Nie wygenerowano żadnego wyjścia",
      running: "Narzędzie działa...",
      debug: "Debugowanie",
      show: "Pokaż",
      hide: "Ukryj",
      rawJsonDevMode: "Surowy JSON (tryb deweloperski)",
    },
    agentTeamView: {
      team: "Zespół",
      member: "Członek",
      type: "Typ",
      content: "Treść",
      status: "Status",
      description: "Opis",
    },
    subAgentRunView: {
      planTitle: "Plan działania",
      delegateTitle: "Delegowanie",
      reviewDigestTitle: "Skrót przeglądu",
    },
    changeTitleView: {
      titleLabel: "Tytuł",
    },
    enterPlanMode: {
      title: "Włączono tryb planowania",
      body:
        "Agent będzie teraz przedstawiać uporządkowany plan przed podjęciem działania. Gdy będziesz gotowy, możesz wyjść z trybu planowania lub poprosić o zmiany.",
    },
    structuredResult: {
      exit: "Kod wyjścia",
      stdout: "Standardowe wyjście",
      stderr: "Standardowy błąd",
      diff: "Różnice",
      result: "Wynik",
      items: "Elementy",
      more: ({ count }: { count: number }) => `+${count} więcej`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "Indeksowanie obszaru roboczego",
      description:
        "Indeksowanie pomaga agentowi szybciej przeszukiwać bazę kodu i udzielać dokładniejszych odpowiedzi. Może to skanować pliki w Twoim obszarze roboczym.",
      optionFallback: "Opcja",
      chooseOptionHint: "Aby kontynuować, wybierz jedną z opcji poniżej.",
    },
    acpHistoryImport: {
      title: "Zaimportować historię sesji?",
      defaultNote:
        "Ta historia sesji różni się od tego, co jest już w Happier. Import może spowodować duplikaty.",
      counts: {
        local: ({ count }: { count: number }) => `Lokalnie: ${count}`,
        remote: ({ count }: { count: number }) => `Zdalnie: ${count}`,
      },
      preview: {
        localTail: "Lokalnie (koniec)",
        remoteTail: "Zdalnie (koniec)",
        unknownRole: "nieznany",
      },
      actions: {
        import: "Importuj",
        skip: "Pomiń",
      },
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Edycja ${index} z ${total}`,
      replaceAll: "Zamień wszystkie",
      summaryEdits: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "edycja", few: "edycje", many: "edycji" })}`,
    },
    names: {
      task: "Zadanie",
      subAgent: "Podagent",
      terminal: "Konsola",
      searchFiles: "Wyszukaj pliki",
      search: "Wyszukaj",
      searchContent: "Wyszukaj zawartość",
      listFiles: "Lista plików",
      planProposal: "Propozycja planu",
      readFile: "Czytaj plik",
      editFile: "Edytuj plik",
      writeFile: "Zapisz plik",
      fetchUrl: "Pobierz URL",
      readNotebook: "Czytaj notatnik",
      editNotebook: "Edytuj notatnik",
      todoList: "Lista zadań",
      webSearch: "Wyszukiwanie w sieci",
      reasoning: "Rozumowanie",
      applyChanges: "Zaktualizuj plik",
      viewDiff: "Różnice",
      turnDiff: "Różnice tury",
      question: "Pytanie",
      changeTitle: "Zmień tytuł",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `Wyszukaj(wzorzec: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `Wyszukaj(ścieżka: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) => `Pobierz URL(url: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `Edytuj notatnik(plik: ${path}, tryb: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Lista zadań(liczba: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Wyszukiwanie w sieci(zapytanie: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(wzorzec: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} ${plural({ count, one: "edycja", few: "edycje", many: "edycji" })})`,
      readingFile: ({ file }: { file: string }) => `Odczytywanie ${file}`,
      writingFile: ({ file }: { file: string }) => `Zapisywanie ${file}`,
      modifyingFile: ({ file }: { file: string }) => `Modyfikowanie ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `Modyfikowanie ${count} ${plural({ count, one: "pliku", few: "plików", many: "plików" })}`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) =>
        `${file} i ${count} ${plural({ count, one: "więcej", few: "więcej", many: "więcej" })}`,
      showingDiff: "Pokazywanie zmian",
    },
    askUserQuestion: {
      submit: "Wyślij odpowiedź",
      multipleQuestions: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "pytanie", few: "pytania", many: "pytań" })}`,
      other: "Inne",
      otherDescription: "Wpisz własną odpowiedź",
      otherPlaceholder: "Wpisz swoją odpowiedź...",
    },
    exitPlanMode: {
      approve: "Zatwierdź plan",
      reject: "Odrzuć",
      requestChanges: "Poproś o zmiany",
      planMissing:
        "Nie podano treści planu. Sprawdź plan w wiadomości powyżej albo poproś agenta, aby dołączył go do prośby o zatwierdzenie.",
      requestChangesPlaceholder:
        "Napisz Claude, co chcesz zmienić w tym planie…",
      requestChangesSend: "Wyślij uwagi",
      requestChangesEmpty: "Wpisz, co chcesz zmienić.",
      requestChangesFailed:
        "Nie udało się poprosić o zmiany. Spróbuj ponownie.",
      responded: "Odpowiedź wysłana",
      approvalMessage:
        "Zatwierdzam ten plan. Proszę kontynuować implementację.",
      rejectionMessage:
        "Nie zatwierdzam tego planu. Proszę go poprawić lub zapytać mnie, jakie zmiany chciałbym wprowadzić.",
    },
  },

  files: {
    searchPlaceholder: "Wyszukaj pliki...",
    clearSearchA11y: "Wyczyść wyszukiwanie",
    createFileA11y: "Utwórz plik",
    createFolderA11y: "Utwórz folder",
    createFilePromptTitle: "Utwórz plik",
    createFilePromptBody: "Wprowadź ścieżkę względną względem katalogu głównego projektu.",
    createFileInvalidPath:
      "Nieprawidłowa ścieżka pliku. Użyj ścieżki względnej w obrębie workspace, np. src/new-file.ts.",
    createFileFailed: "Nie udało się utworzyć pliku.",
    createFolderPromptTitle: "Utwórz folder",
    createFolderPromptBody:
      "Wprowadź ścieżkę folderu względną względem katalogu głównego projektu.",
    createFolderInvalidPath:
      "Nieprawidłowa ścieżka folderu. Użyj ścieżki względnej w obrębie workspace, np. src/new-folder.",
    createFolderFailed: "Nie udało się utworzyć folderu.",
    changeRow: {
      viewDiffA11y: ({ file }: { file: string }) => `Pokaż diff dla ${file}`,
      status: {
        untracked: "Plik nieśledzony",
        added: "Nowy plik",
        deleted: "Usunięty plik",
        renamed: "Zmieniona nazwa pliku",
        copied: "Skopiowany plik",
        conflicted: "Plik w konflikcie",
        modified: "Zmodyfikowany plik",
      },
    },
    projectLinkPicker: {
      title: "Połącz plik projektu",
      searchFailed: "Wyszukiwanie nie powiodło się. Spróbuj ponownie.",
    },
    detachedHead: "odłączony HEAD",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
    branchSummary: {
      ahead: "Przed",
      behind: "Za",
      included: "Uwzględnione",
      staged: "Zindeksowane",
      pending: "Oczekujące",
      unstaged: "Niezindeksowane",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "Brak upstream",
    },
    stageActions: {
      selectPendingDiffMode:
        "Wybierz tryb diff „Oczekujące”, aby wybrać linie do commitu.",
      unableToBuildPatchFromSelection:
        "Nie udało się zbudować patcha z wybranych linii.",
      diffChangedRefreshAndReselect:
        "Diff się zmienił — odśwież i wybierz linie ponownie.",
    },
    discardChangesFor: ({ path }: { path: string }) => `Odrzuć zmiany dla ${path}`,
    commitSelection: {
      addToCommit: "Dodaj do commitu",
      removeFromCommit: "Usuń z commitu",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "plik", few: "pliki", many: "plików" })}`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `Repository changed files (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `Session-attributed changes (${count})`,
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `Other repository changes (${count})`,
    attributionReliabilityHigh:
      "Atrybucja best-effort. Widok repozytorium pozostaje źródłem prawdy.",
    attributionReliabilityLimited:
      "Ograniczona wiarygodność: wiele sesji jest aktywnych dla tego repozytorium. Pokazuję tylko bezpośrednią atrybucję.",
    attributionLegendFull:
      "direct = z operacji tej sesji, inferred = atrybucja na podstawie snapshotu",
    attributionLegendDirectOnly: "direct = z operacji tej sesji",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count} inferred file${count === 1 ? "" : "s"} kept in repository-only changes.`,
    noSessionAttributedChanges:
      "Obecnie nie wykryto zmian przypisanych do sesji.",
    notRepo: "To nie jest repozytorium kontroli wersji",
    notUnderSourceControl: "Ten katalog nie jest pod kontrolą wersji",
    searching: "Wyszukiwanie plików...",
      noFilesFound: "Nie znaleziono plików",
      noFilesInProject: "Brak plików w projekcie",
      repositoryFolderLoadFailed: "Nie można wczytać folderu",
      repositoryCollapseAll: "Zwiń wszystko",
    sourceControlOperationsLog: {
      title: "Ostatnie operacje kontroli wersji",
      allSessions: "Wszystkie sesje",
      thisSession: "Ta sesja",
      emptyThisSession: "Brak ostatnich operacji dla tej sesji.",
    },
    operationsHistory: {
      recentCommits: "Ostatnie commity",
      noCommitsAvailable: "Brak commitów.",
      loadMore: "Wczytaj więcej commitów",
    },
      reviewFilterPlaceholder: "Filtruj pliki...",
      reviewNoMatches: "Brak dopasowań",
      reviewLargeDiffOneAtATime: "Wykryto duży diff; różnice będą wczytywane podczas przewijania.",
      reviewDiffRequestFailed: "Nie można wczytać diffu",
      reviewUnableToLoadDiff: "Nie można wczytać diffu",
      tryDifferentTerm: "Spróbuj innego terminu wyszukiwania",
      searchResults: ({ count }: { count: number }) =>
        `Wyniki wyszukiwania (${count})`,
    projectRoot: "Katalog główny projektu",
    stagedChanges: ({ count }: { count: number }) =>
      `Przygotowane zmiany (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `Nieprzygotowane zmiany (${count})`,
      // File viewer strings
      fileReadFailed: "Nie udało się odczytać pliku",
      fileWriteFailed: "Nie udało się zapisać pliku",
      fileEditor: {
        experimentalHint:
          "Edycja jest eksperymentalna. Zapisz, aby zapisać zmiany z powrotem do worktree sesji.",
      },
      fileEditingUnsupported:
        "Edycja plików nie jest obsługiwana przez podłączonego daemona. Zaktualizuj Happier na maszynie, aby włączyć operacje zapisu.",
      selectionFailed: "Nie udało się zaktualizować wyboru",
      openReviewCommentsFailed: "Nie udało się otworzyć komentarzy do przeglądu",
        reviewComments: {
          title: ({ count }: { count: number }) => `Komentarze przeglądu (${count})`,
          placeholder: "Dodaj komentarz do przeglądu…",
          jump: "Przejdź",
          addCommentA11y: "Dodaj komentarz",
          closeCommentA11y: "Zamknij komentarz",
          draftsChipLabel: ({ count }: { count: number }) => `Przegląd (${count})`,
          errors: {
            empty: "Komentarz nie może być pusty",
            couldNotMapSelection: "Nie udało się powiązać zaznaczenia z linią diffu",
          },
        },
        commitDetails: {
          missingContext: "Brak kontekstu commitu",
          failedToLoadDiff: "Nie udało się wczytać diffu commitu",
          diffUnavailableTitle: "Diff commitu niedostępny",
          diffUnavailableHint:
            "Spróbuj ponownie otworzyć commit z ekranu Pliki.",
          commitLabel: "Zatwierdzenie",
          running: ({ operation }: { operation: string }) => `W toku: ${operation}`,
          revert: {
            title: "Cofnij commit",
            button: "Cofnij commit",
            confirm: "Cofnij",
            success: "Commit został cofnięty",
            failed: "Nie udało się cofnąć commitu",
          },
        },
        commitRevertUnavailable: "Cofnięcie jest niedostępne dla tego commitu.",
        commitMessageEditor: {
          placeholder: "Wiadomość commita",
          generate: "Wygeneruj",
          generating: "Generowanie…",
          applySuggestion: "Zastosuj sugestię",
          commit: "Wykonaj commit",
          generateFailed: "Nie udało się wygenerować wiadomości commitu",
          generatorDisabled: "Generator wiadomości commitu jest wyłączony",
        },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Ładowanie ${fileName}...`,
        binaryFile: "Plik binarny",
        imagePreviewTooLarge: "Podgląd obrazu jest zbyt duży, aby go wyświetlić",
        cannotDisplayBinary: "Nie można wyświetlić zawartości pliku binarnego",
        diff: "Różnice",
      file: "Plik",
    diffModes: {
      pending: "Oczekujące",
      included: "Uwzględnione",
      combined: "Połączone",
    },
    fileActions: {
      selectForCommit: "Wybierz do commitu",
      stageFile: "Dodaj do stage",
      removeFromSelection: "Usuń z zaznaczenia",
      unstageFile: "Usuń ze stage",
      selectionHint:
        "Wybierz Uwzględnione lub Oczekujące, aby włączyć wybór linii.",
      selectedLines: {
        selectLinesForCommit: "Wybierz linie do commitu",
        stageSelectedLines: "Dodaj zaznaczone linie do stage",
        unstageSelectedLines: "Usuń zaznaczone linie ze stage",
      },
      clearSelection: "Wyczyść zaznaczenie",
    },
    toolbar: {
      changedFiles: "Zmienione pliki",
      allRepositoryFiles: "Wszystkie pliki repozytorium",
      repositoryView: "Widok repozytorium",
      sessionView: "Widok sesji",
      review: "Przegląd",
      list: "Lista",
      scm: "Git",
    },
    fileEmpty: "Plik jest pusty",
    noChanges: "Brak zmian do wyświetlenia",
    sourceControlOperations: {
      title: "Kontrola wersji",
      actorThisSession: "ta sesja",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `sesja ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `W trakcie: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `Operacje kontroli wersji są zablokowane przez ${actor}.`,
      globalLock:
        "Operacje są tymczasowo zablokowane, ponieważ inna sesja uruchamia polecenie kontroli wersji.",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "Wybrano 1 plik do następnego commita."
          : `Wybrano ${count} plików do następnego commita.`,
      clear: "Wyczyść",
      conflictsDetected:
        "Wykryto konflikty. Commit, pull i push są zablokowane do czasu rozwiązania konfliktów.",
      actions: {
        fetch: "Pobierz",
        pull: "Pobierz i scal",
        push: "Wyślij",
      },
      blockedHints: {
        lock: "Blokada",
        commitBlocked: "Commit zablokowany",
        pullBlocked: "Pull zablokowany",
        pushBlocked: "Push zablokowany",
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "Uruchom wykonanie",
      sections: {
        intent: "Cel",
        permissions: "Uprawnienia",
        backends: "Backendy",
        instructions: "Instrukcje",
      },
      intents: {
        review: "Przegląd",
        plan: "Planowanie",
        delegate: "Deleguj",
      },
      permissionModes: {
        readOnly: "Tylko do odczytu",
        default: "Domyślne",
      },
      instructionsPlaceholder: "Co ma zrobić subagent?",
      actions: {
        start: "Uruchom",
      },
      guidancePreview: "Podgląd wskazówek",
      a11y: {
        startRun: "Uruchom wykonanie",
        cancel: "Anuluj",
        selectIntent: ({ intent }: { intent: string }) =>
          `Wybierz cel ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `Wybierz uprawnienia ${mode}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `Przełącz backend ${backendId}`,
      },
    },
    details: {
      labels: {
        intent: "Intencja",
        backendId: "Identyfikator backendu",
        permissionMode: "Tryb uprawnień",
        retentionPolicy: "Polityka retencji",
        runClass: "Klasa uruchomienia",
        ioMode: "Tryb I/O",
      },
      timestamps: {
        started: "Rozpoczęto",
        finished: "Zakończono",
      },
    },
  },

    settingsSession: {
      messageSending: {
        title: "Wysyłanie wiadomości",
        footer:
          "Określa, co dzieje się, gdy wysyłasz wiadomość, gdy agent pracuje.",
        queueInAgentTitle: "W kolejce agenta (obecnie)",
        queueInAgentSubtitle:
          "Zapisz od razu w transkrypcie; agent przetworzy, gdy będzie gotowy.",
        interruptTitle: "Przerwij i wyślij",
        interruptSubtitle: "Przerwij bieżący krok, a następnie wyślij natychmiast.",
        pendingTitle: "Oczekujące do gotowości",
        pendingSubtitle:
          "Trzymaj wiadomości w kolejce oczekujących; agent pobierze je, gdy będzie gotowy.",
        busySteerPolicyTitle: "Gdy agent jest zajęty (z obsługą sterowania)",
        busySteerPolicyFooter:
          "Jeśli agent obsługuje sterowanie w locie, wybierz, czy wiadomości mają sterować od razu, czy najpierw trafić do Oczekujących.",
        busySteerPolicy: {
          steerImmediatelyTitle: "Steruj od razu",
          steerImmediatelySubtitle:
            "Wyślij od razu i steruj bieżącym krokiem (bez przerywania).",
          queueForReviewTitle: "Do Oczekujących",
          queueForReviewSubtitle:
            "Najpierw umieść w Oczekujących; wyślij później przez \"Steruj teraz\".",
        },
      },
      thinking: {
        title: "Myślenie",
        footer:
          "Kontroluje, jak wiadomości myślenia agenta pojawiają się w transkrypcie sesji.",
          displayModeTitle: "Wyświetlanie myślenia",
          displayMode: {
            inlineSummaryTitle: "W linii (podsumowanie)",
            inlineSummarySubtitle: "Pokaż jednolinijkowe podsumowanie; dotknij, aby rozwinąć.",
            inlineTitle: "W linii (pełne)",
            inlineSubtitle: "Pokaż pełną treść myślenia bezpośrednio w transkrypcie.",
            toolTitle: "Karta narzędzia",
            toolSubtitle: "Pokazuj wiadomości myślenia jako kartę narzędzia \"Rozumowanie\".",
            hiddenTitle: "Ukryte",
            hiddenSubtitle: "Ukrywaj wiadomości myślenia w transkrypcie.",
          },
              inlineChromeTitle: "Karty myślenia",
              inlineChromeSubtitle: "Pokazuj myślenie w linii z subtelnym tłem karty.",
        },
      toolRendering: {
        title: "Renderowanie narzędzi",
          footer:
            "Kontroluje, ile szczegółów narzędzi jest pokazywanych w osi czasu sesji. To preferencja interfejsu; nie zmienia zachowania agenta.",
          defaultToolDetailLevelTitle: "Domyślny poziom szczegółów narzędzi",
          expandedToolDetailLevelTitle: "Poziom szczegółów po rozwinięciu",
          cardTapActionTitle: "Akcja dotknięcia",
          timelineChrome: {
            title: "Styl narzędzi w osi czasu",
            cardsTitle: "Karty",
          cardsSubtitle:
            "Karty narzędzi z treścią inline (zależnie od poziomu szczegółów).",
          activityFeedTitle: "Kanał narzędzi",
          activityFeedSubtitle:
            "Kompaktowe wiersze zoptymalizowane pod dużą liczbę narzędzi.",
        },
        cardDensity: {
          title: "Gęstość kart",
          comfortableTitle: "Wygodna",
          comfortableSubtitle: "Więcej odstępów i wyraźniejsze rozdzielenie.",
          compactTitle: "Kompaktowa",
          compactSubtitle: "Mniej odstępów i mniejsze nagłówki.",
        },
        activityFeed: {
          defaultDetailTitle: "Domyślne szczegóły (kanał narzędzi)",
          expandedDetailTitle: "Szczegóły po rozwinięciu (kanał narzędzi)",
          tapActionTitle: "Akcja dotknięcia (kanał narzędzi)",
          tapAction: {
            expandTitle: "Rozwiń",
            expandSubtitle:
              "Dotknięcie rozwija lub zwija szczegóły inline.",
            openTitle: "Otwórz",
            openSubtitle: "Dotknięcie otwiera pełny widok narzędzia.",
          },
          defaultExpandedTitle: "Domyślnie rozwinięte",
          defaultExpandedSubtitle:
            "Domyślnie rozwijaj wiersze narzędzi w kanale narzędzi.",
        },
        localControlDefaultTitle: "Domyślnie (kontrola lokalna)",
        showDebugByDefaultTitle: "Domyślnie pokazuj debug",
        showDebugByDefaultSubtitle:
          "Automatycznie rozwijaj surowe payloady narzędzi w pełnym widoku narzędzia.",
      },
      transcript: {
        title: "Transkrypt",
        entrySubtitle: "Otwórz ustawienia transkryptu",
        footer:
          "Dostosuj sposób wyświetlania czatów i zachowanie transkryptu.",
        layoutTitle: "Układ",
        layoutFooter:
          "Wybierz między prostym transkryptem liniowym a grupowaniem na tury.",
        layoutPickerTitle: "Układ transkryptu",
        layout: {
          linearTitle: "Liniowy",
          linearSubtitle: "Pokaż wiadomości jako płaską listę.",
          turnsTitle: "Tury",
          turnsSubtitle: "Grupuj wiadomości w tury użytkownik/asystent.",
        },
        toolCallsGroupTitle: "Grupuj wywołania narzędzi",
        toolCallsGroupSubtitle:
          "Kompaktuj wywołania narzędzi w sekcję wywołań narzędzi w każdej turze.",
        toolCallsGroupBackgroundTitle: "Tło grup wywołań",
        toolCallsGroupBackgroundSubtitle:
          "Pokaż tło za grupami wywołań w trybie feed narzędzi.",
        toolAppearanceTitle: "Wygląd narzędzi",
        toolAppearanceSubtitle:
          "Dostosuj wygląd narzędzi w transkrypcie.",
        motionTitle: "Animacje",
        motionFooter: "Kontroluj animacje w transkrypcie.",
        motionPickerTitle: "Animacje",
        motion: {
          offTitle: "Wyłączone",
          offSubtitle: "Wyłącz animacje transkryptu.",
          subtleTitle: "Subtelne (domyślne)",
          subtleSubtitle: "Szybki, minimalny ruch dla nowej aktywności.",
          fullTitle: "Pełne",
          fullSubtitle: "Bardziej ekspresyjne animacje i przejścia.",
        },
        advancedMotionTitle: "Zaawansowane animacje…",
        advancedMotionSubtitle:
          "Dostosuj okno świeżości i przełączniki animacji.",
        scrollTitle: "Przewijanie",
        scrollFooter:
          "Kontroluj przypięcie do dołu i zachowanie skoku na dół.",
          scrollPinTitle: "Przypnij do dołu",
          scrollPinSubtitle: "Podążaj za nowymi wiadomościami, gdy jesteś na dole.",
          jumpToBottomTitle: "Skocz na dół",
          jumpToBottomButtonLabel: "Skocz na dół",
          jumpToBottomSubtitle:
            "Pokaż przycisk, gdy przewiniesz w górę i pojawi się nowa aktywność.",
            advancedScrollTitle: "Zaawansowane przewijanie…",
          advancedScrollSubtitle: "Dostosuj progi i liczniki.",
          advancedTitle: "Zaawansowane…",
          advancedSubtitle: "Kontrole wydajności i debugowania.",
          advanced: {
            turnGroupingTitle: "Grupowanie tur",
            turnGroupingFooter:
            "Kontroluje, jak powstają grupy wywołań narzędzi w turach.",
            performanceTitle: "Wydajność",
            performanceFooter: "Ustawienia wydajności streamingu i list.",
            coalesceEnabledTitle: "Scalaj aktualizacje streamingu",
            coalesceEnabledSubtitle:
              "Scalaj aktualizacje z socketów, aby przewijanie było płynne.",
            coalesceWindowTitle: "Okno scalania",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}ms`,
            coalesceWindowPromptTitle: "Okno scalania (ms)",
            coalesceWindowPromptBody:
              "Ustaw, jak często buforowane aktualizacje streamingu są stosowane w store.",
            coalesceMaxBatchTitle: "Maksymalny rozmiar partii",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}`,
            coalesceMaxBatchPromptTitle: "Maksymalny rozmiar partii",
            coalesceMaxBatchPromptBody:
              "Ustaw górny limit liczby wiadomości stosowanych w jednym flush.",
            thinkingPulseStaleTitle: "Okno wygasania myślenia",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}ms`,
            thinkingPulseStalePromptTitle: "Okno wygasania myślenia (ms)",
            thinkingPulseStalePromptBody:
              "Ukryj aktywne myślenie po tym czasie bez aktualizacji.",
            listImplementationTitle: "Implementacja listy transkryptu",
            listImplementationSubtitle: "Przełącz silnik listy (debug).",
            listImplementation: {
              flashTitle: "FlashList v2 (zalecane)",
              flashSubtitle: "Najlepsza wydajność dla długich transkryptów.",
              legacyTitle: "Starszy FlatList",
              legacySubtitle: "Alternatywa do debugowania kompatybilności.",
            },
          toolCallsStrategyTitle: "Strategia grupowania wywołań",
          toolCallsStrategy: {
            consecutiveTitle: "Kolejne narzędzia (domyślne)",
            consecutiveSubtitle:
              "Grupuj tylko kolejne wywołania narzędzi w wywołaniach narzędzi.",
            allToolsTitle: "Wszystkie narzędzia w turze",
            allToolsSubtitle:
              "Grupuj wszystkie wywołania narzędzi w turze w jedną sekcję wywołań narzędzi.",
          },
            toolCallsCollapsedPreviewCountTitle: "Podgląd (zwinięte)",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `Pokaż ostatnie ${value} narzędzie(-a/-i), gdy Wywołania narzędzi jest zwinięte.`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "Wyłączone",
              offSubtitle: "Pokaż tylko nagłówek wywołań narzędzi.",
              oneTitle: "1 narzędzie",
              oneSubtitle: "Pokaż najnowsze narzędzie jako wiersz podglądu.",
              twoTitle: "2 narzędzia",
              twoSubtitle: "Pokaż 2 najnowsze narzędzia jako wiersze podglądu.",
              threeTitle: "3 narzędzia",
              threeSubtitle: "Pokaż 3 najnowsze narzędzia jako wiersze podglądu.",
              countTitle: ({ value }: { value: string }) => `${value} narzędzi`,
              countSubtitle: ({ value }: { value: string }) =>
                `Pokaż ${value} najnowszych narzędzi jako wiersze podglądu.`,
            },
          motionTitle: "Animacje (zaawansowane)",
          motionFooter:
            "Animacje są ograniczane oknem świeżości, aby historia pozostała stabilna.",
          freshnessTitle: "Okno świeżości",
          freshnessSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}ms`,
          freshnessPromptTitle: "Okno świeżości (ms)",
          freshnessPromptBody:
            "Ustaw, jak długo nowe elementy są „świeże” dla animacji.",
          animateNewItemsTitle: "Animuj nowe elementy",
          animateNewItemsSubtitle:
            "Animuj nowe wiadomości i narzędzia strumieniowane do transkryptu.",
          animateToolExpandCollapseTitle:
            "Animuj rozwijanie/zwijanie narzędzi",
          animateToolExpandCollapseSubtitle:
            "Animuj przejścia rozwijania/zwijania narzędzi inline.",
          animateToolExpandCollapseFreshOnlyTitle:
            "Rozwijanie/zwijanie tylko świeże",
          animateToolExpandCollapseFreshOnlySubtitle:
            "Animuj rozwijanie/zwijanie tylko dla świeżych narzędzi.",
          animateThinkingTitle: "Animuj myślenie",
          animateThinkingSubtitle:
            "Animuj strumieniowane wiadomości myślenia, gdy są widoczne.",
          scrollTitle: "Przewijanie (zaawansowane)",
          scrollFooter:
            "Dostosuj progi przypięcia i zachowanie skoku na dół.",
          pinOffsetTitle: "Próg odchylenia przypięcia",
          pinOffsetSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}px`,
          pinOffsetPromptTitle: "Próg odchylenia przypięcia (px)",
          pinOffsetPromptBody:
            "Ustaw, jak daleko od dołu nadal uznajemy za przypięte.",
          autoFollowTitle: "Automatyczne podążanie przy przypięciu",
          autoFollowSubtitle:
            "Gdy przypięte, automatycznie podążaj za nową aktywnością.",
          jumpMinNewCountTitle: "Minimalna liczba nowych dla przycisku",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}`,
          jumpMinNewCountPromptTitle: "Minimalna liczba nowych (przycisk)",
          jumpMinNewCountPromptBody:
            "Pokaż przycisk skoku na dół dopiero po tylu nowych elementach.",
          jumpAnimateScrollTitle: "Animuj skok na dół",
          jumpAnimateScrollSubtitle:
            "Animuj przewijanie podczas skoku na dół.",
        },
      },
        toolDetailOverrides: {
          title: "Nadpisania szczegółów narzędzi",
          entrySubtitle: "Nadpisz pojedyncze narzędzia",
          footer:
            "Nadpisz poziom szczegółów dla wybranych narzędzi. Nadpisania dotyczą kanonicznej nazwy narzędzia (V2) po normalizacji legacy.",
          expandedTitle: "Nadpisania szczegółów po rozwinięciu",
          expandedFooter: "Nadpisz poziom szczegółów po rozwinięciu dla wybranych narzędzi.",
        },
      permissions: {
        title: "Uprawnienia",
        entrySubtitle: "Otwórz ustawienia uprawnień",
        footer:
          "Skonfiguruj domyślne uprawnienia i sposób stosowania zmian do działających sesji.",
        promptSurfaceTitle: "Monity uprawnień",
        promptSurfaceFooter:
          "Wybierz, gdzie podczas sesji pojawiają się prośby o zatwierdzenie.",
        applyChangesFooter:
          "Wybierz, kiedy zmiany uprawnień zaczną obowiązywać w działających sesjach.",
        backendFooter:
          "Ustaw domyślny tryb uprawnień używany przy uruchamianiu sesji z tym backendem.",
        defaultPermissionModeTitle: "Domyślny tryb uprawnień",
        promptSurface: {
          composerTitle: "Przy polu wpisywania (zalecane)",
          composerSubtitle: "Pokazuj bogate karty uprawnień przy polu wpisywania.",
          transcriptTitle: "W transkrypcie",
          transcriptSubtitle:
            "Pokazuj monity uprawnień wewnątrz wiadomości narzędzi.",
          bothTitle: "Oba",
          bothSubtitle:
            "Pokazuj przy polu wpisywania i wewnątrz transkryptu.",
        },
        applyTiming: {
          immediateTitle: "Zastosuj od razu",
          nextPromptTitle: "Zastosuj przy następnej wiadomości",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "Otwórz ustawienia sub-agenta",
      },
      actionsEntry: {
        footer:
          "Włącz akcje per powierzchnia i umiejscowienie (UI, głos, MCP) oraz kontroluj, gdzie się pojawiają.",
        openSubtitle: "Otwórz ustawienia akcji",
      },
      defaultPermissions: {
        title: "Domyślne uprawnienia",
        footer:
          "Stosowane przy uruchamianiu nowej sesji. Profile mogą to opcjonalnie nadpisać.",
        applyPermissionChangesTitle: "Zastosuj zmiany uprawnień",
        applyPermissionChangesImmediateSubtitle:
          "Zastosuj od razu w działających sesjach (aktualizuje metadane sesji).",
        applyPermissionChangesNextPromptSubtitle: "Zastosuj tylko przy następnej wiadomości.",
      },
      replayResume: {
        title: "Wznawianie przez odtwarzanie",
        footer:
          "Gdy wznowienie dostawcy jest niedostępne, opcjonalnie odtwórz ostatnie wiadomości transkryptu w nowej sesji jako kontekst.",
        enabledTitle: "Włącz wznawianie przez odtwarzanie",
        enabledSubtitleOn:
          "Oferuj wznowienie przez odtwarzanie, gdy wznowienie dostawcy jest niedostępne.",
        enabledSubtitleOff: "Nie oferuj wznawiania przez odtwarzanie.",
        strategyTitle: "Strategia odtwarzania",
        strategy: {
          recentTitle: "Ostatnie wiadomości",
          recentSubtitle: "Użyj tylko najnowszych wiadomości transkryptu.",
          summaryRecentTitle: "Podsumowanie + ostatnie (eksperymentalne)",
          summaryRecentSubtitle:
            "Dołącz krótkie podsumowanie i ostatnie wiadomości (best-effort).",
        },
        summaryRunner: {
          title: "Generator podsumowań (na żądanie)",
          backendTitle: "Silnik",
          backendPlaceholder: "claude (np.)",
          searchBackendsPlaceholder: "Szukaj backendów…",
          modelTitle: "Model (LLM)",
          modelPlaceholder: "default (np.)",
          searchModelsPlaceholder: "Szukaj modeli…",
          notSet: "Nie ustawiono",
          customTitle: "Własny",
          customBackendIdSubtitle: "Wpisz id backendu (np. claude).",
          customModelIdSubtitle: "Wpisz id modelu (np. default).",
        },
        recentMessagesTitle: "Ostatnie wiadomości do dołączenia",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Limit seed (znaki)",
        maxSeedCharsPlaceholder: "50000",
      },
      toolDetailLevel: {
        titleOnlyTitle: "Tylko tytuł",
        titleOnlySubtitle:
          "Pokazuj tylko nazwę narzędzia w osi czasu (bez podtytułu, bez treści).",
        compactTitle: "Kompaktowy",
        compactSubtitle: "Pokazuj nazwę narzędzia + krótki podtytuł w tej samej linii (bez treści).",
        summaryTitle: "Podsumowanie",
        summarySubtitle: "Pokazuj kompaktowe, bezpieczne podsumowanie w osi czasu.",
        fullTitle: "Pełne",
        fullSubtitle: "Pokazuj pełne szczegóły w linii w osi czasu.",
        defaultTitle: "Domyślne",
        defaultSubtitle: "Użyj globalnej wartości domyślnej.",
          styleDefaultTitle: "Domyślne (zalecane)",
          styleDefaultSubtitle: "Karty: Podsumowanie. Kanał narzędzi: Kompaktowy.",
          expandedStyleDefaultTitle: "Domyślne (zalecane)",
          expandedStyleDefaultSubtitle: "Karty: Pełne. Kanał narzędzi: Podsumowanie.",
      },
      terminalConnect: {
        title: "Połączenie terminala",
        legacySecretExportTitle: "Eksport starego sekretu (zgodność)",
        legacySecretExportEnabledSubtitle:
          "Włączone: eksportuje stary sekret konta do terminala, aby starsze terminale mogły się połączyć. Niezalecane.",
        legacySecretExportDisabledSubtitle:
          "Wyłączone (zalecane): provisionuj terminale tylko kluczem treści (Terminal Connect V2).",
      },
    sessionList: {
      title: "Lista sesji",
      footer: "Dostosuj, co jest widoczne w wierszu sesji.",
      tagsTitle: "Tagi sesji",
      tagsEnabledSubtitle: "Kontrolki tagów widoczne na liście sesji",
      tagsDisabledSubtitle: "Kontrolki tagów ukryte",
    },
  },

  settingsVoice: {
    // Voice settings screen
    modeTitle: "Głos",
    modeDescription:
      "Skonfiguruj funkcje głosowe. Możesz całkowicie wyłączyć głos, użyć Happier Voice (wymaga subskrypcji) albo użyć własnego konta ElevenLabs.",
    mode: {
      off: "Wyłączone",
      offSubtitle: "Wyłącz wszystkie funkcje głosowe",
      happier: "Happier Voice",
      happierSubtitle: "Użyj Happier Voice (wymagana subskrypcja)",
      local: "Lokalny OSS Voice",
      localSubtitle:
        "Użyj lokalnych endpointów STT/TTS kompatybilnych z OpenAI",
      byo: "Użyj mojego ElevenLabs",
      byoSubtitle: "Użyj własnego klucza API i agenta ElevenLabs",
    },
    ui: {
      title: "Powierzchnia glosowa",
      footer: "Opcjonalny feed zdarzen glosowych na ekranie (nie trafia do sesji).",
      activityFeedEnabled: "Wlacz feed aktywnosci glosowej",
      activityFeedEnabledSubtitle: "Pokazuj ostatnie zdarzenia glosowe na ekranie",
      activityFeedAutoExpandOnStart: "Automatycznie rozwin na starcie",
      activityFeedAutoExpandOnStartSubtitle: "Rozwijaj feed automatycznie po starcie glosu",
      scopeTitle: "Domyslny zakres glosu",
      scopeSubtitle: "Wybierz, czy glos jest globalny (konto) czy sesyjny domyslnie.",
      scopeGlobal: "Globalny (konto)",
      scopeGlobalSubtitle: "Glos pozostaje widoczny podczas nawigacji",
      scopeSession: "Sesja",
      scopeSessionSubtitle: "Glos jest sterowany w sesji, w ktorej zostal uruchomiony",
      surfaceLocationTitle: "Umiejscowienie",
      surfaceLocationSubtitle: "Wybierz gdzie pojawia sie powierzchnia glosowa.",
      surfaceLocation: {
        autoTitle: "Automatycznie",
        autoSubtitle: "Globalny w pasku bocznym; sesyjny w sesji.",
        sidebarTitle: "Pasek boczny",
        sidebarSubtitle: "Pokaz w pasku bocznym.",
        sessionTitle: "Sesja",
        sessionSubtitle: "Pokaz nad polem wpisu w sesji.",
      },
      updates: {
        title: "Aktualizacje sesji",
        footer: "Kontroluj co asystent glosowy otrzymuje jako kontekst.",
        activeSessionTitle: "Aktywna sesja docelowa",
        activeSessionSubtitle: "Co wysylac automatycznie dla sesji docelowej.",
        otherSessionsTitle: "Inne sesje",
        otherSessionsSubtitle: "Co wysylac automatycznie dla pozostalych sesji.",
        level: {
          noneTitle: "Brak",
          noneSubtitle: "Nie wysylaj automatycznych aktualizacji.",
          activityTitle: "Tylko aktywnosc",
          activitySubtitle: "Tylko liczniki i znaczniki czasu.",
          summariesTitle: "Podsumowania",
          summariesSubtitle: "Krotkie, bezpieczne podsumowania (bez tresci wiadomosci).",
          snippetsTitle: "Fragmenty",
          snippetsSubtitle: "Krotkie fragmenty wiadomosci (ryzyko prywatnosci).",
        },
        snippetsMaxMessagesTitle: "Maks. wiadomosci",
        snippetsMaxMessagesSubtitle: "Limit ile wiadomosci uwzglednic w aktualizacji.",
        includeUserMessagesInSnippetsTitle: "Uwzglednij Twoje wiadomosci",
        includeUserMessagesInSnippetsSubtitle: "Jesli wlaczone, fragmenty moga zawierac Twoje wiadomosci.",
        otherSessionsSnippetsModeTitle: "Fragmenty innych sesji",
        otherSessionsSnippetsModeSubtitle: "Kontroluj kiedy fragmenty innych sesji sa dozwolone.",
        otherSessionsSnippetsMode: {
          neverTitle: "Nigdy",
          neverSubtitle: "Wylacz fragmenty innych sesji.",
          onDemandTitle: "Na zadanie",
          onDemandSubtitle: "Pozwol tylko gdy uzytkownik poprosi.",
          autoTitle: "Automatycznie",
          autoSubtitle: "Pozwol na automatyczne fragmenty (szum).",
        },
      },
    },
    byo: {
      title: "Użyj mojego ElevenLabs",
      agentReuseDialog: {
        title: "Agent Happier już istnieje",
        messageWithId: ({ name, id }: { name: string; id: string }) =>
          `Znaleźliśmy istniejącego agenta ElevenLabs („${name}”, id: ${id}).\n\nCzy chcesz go zaktualizować, czy utworzyć nowego?`,
        messageNoId: ({ name }: { name: string }) =>
          `Znaleźliśmy istniejącego agenta ElevenLabs („${name}”).\n\nCzy chcesz go zaktualizować, czy utworzyć nowego?`,
      },
      configured:
        "Skonfigurowano. Użycie głosu będzie rozliczane na Twoim koncie ElevenLabs.",
      notConfigured:
        "Wpisz swój klucz API ElevenLabs i ID agenta, aby używać głosu bez subskrypcji.",
      createAccount: "Utwórz konto ElevenLabs",
      createAccountSubtitle:
        "Zarejestruj się (lub zaloguj) przed utworzeniem klucza API",
      openApiKeys: "Otwórz klucze API ElevenLabs",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "Jak utworzyć klucz API",
      apiKeyHelpSubtitle:
        "Instrukcja krok po kroku tworzenia i kopiowania klucza API ElevenLabs",
      apiKeyHelpDialogTitle: "Utwórz klucz API ElevenLabs",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Utwórz agenta Happier",
      autoprovCreateSubtitle:
        "Utwórz i skonfiguruj agenta Happier na swoim koncie ElevenLabs używając klucza API",
      autoprovUpdate: "Aktualizuj agenta",
      autoprovUpdateSubtitle:
        "Zaktualizuj agenta do najnowszego szablonu Happier",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `Utworzono agenta: ${agentId}`,
      autoprovUpdated: "Agent zaktualizowany",
      autoprovFailed:
        "Nie udało się utworzyć/zaktualizować agenta. Spróbuj ponownie.",
      agentId: "ID agenta",
      agentIdSet: "Ustawiono",
      agentIdNotSet: "Nie ustawiono",
      agentIdTitle: "ID agenta ElevenLabs",
      agentIdDescription: "Wpisz ID agenta z panelu ElevenLabs.",
      agentIdPlaceholder: "agent_...",
      apiKey: "Klucz API",
      apiKeySet: "Ustawiono",
      apiKeyNotSet: "Nie ustawiono",
      apiKeyTitle: "Klucz API ElevenLabs",
      apiKeyDescription:
        "Wpisz swój klucz API ElevenLabs. Jest przechowywany na urządzeniu w formie zaszyfrowanej.",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "Szukaj głosów",
      speakerBoostTitle: "Wzmocnienie mówcy",
      speakerBoostSubtitle: "Poprawia wyrazistość i prezencję (opcjonalnie).",
      speakerBoostAuto: "Automatycznie",
      speakerBoostAutoSubtitle: "Użyj domyślnych ustawień ElevenLabs.",
      speakerBoostOn: "Włączone",
      speakerBoostOnSubtitle: "Wymuś włączenie wzmocnienia mówcy.",
      speakerBoostOff: "Wyłączone",
      speakerBoostOffSubtitle: "Wymuś wyłączenie wzmocnienia mówcy.",
      voiceGroupTitle: "Głos",
      voiceGroupFooter:
        "Wybierz, jak mówi Twój agent ElevenLabs. Zmiany zastosują się po aktualizacji agenta.",
      provisioningGroupTitle: "Aprowizacja agenta",
      provisioningGroupFooter:
        "Jeśli zmienisz głos lub strojenie, stuknij Aktualizuj agenta, aby zastosować zmiany w ElevenLabs.",
      realtime: {
        call: {
          title: "Połączenie",
          welcome: {
            title: "Wiadomość powitalna",
            subtitle: "Opcjonalne powitanie na początku połączenia.",
            detail: {
              off: "Wył.",
              immediate: "Natychmiast",
              onFirstTurn: "Przy pierwszej wypowiedzi",
            },
            options: {
              offSubtitle: "Bez powitania.",
              immediateSubtitle: "Powitaj zaraz po połączeniu.",
              onFirstTurnSubtitle: "Powitaj na początku pierwszej odpowiedzi.",
            },
          },
        },
        voicePicker: {
          title: "Głos",
          subtitle: "Wybierz głos ElevenLabs używany w odpowiedziach.",
          missingApiKeyTitle: "Dodaj klucz API, aby wczytać głosy",
          loadingTitle: "Wczytywanie głosów…",
          errorTitle: "Nie udało się wczytać głosów",
          errorSubtitle: "Sprawdź klucz API i spróbuj ponownie.",
        },
        modelPicker: {
          title: "Model TTS",
          subtitle:
            "Opcjonalnie: nadpisz identyfikator modelu TTS ElevenLabs.",
          detailAuto: "Automatycznie",
          options: {
            autoTitle: "Automatycznie",
            autoSubtitle: "Użyj domyślnego modelu ElevenLabs.",
            multilingualV2Subtitle: "Częsty domyślny wybór (wielojęzyczny).",
            turboV2Subtitle:
              "Niższe opóźnienie (jeśli dostępne w Twoim planie).",
            turboV25Subtitle: "Turbo 2.5 (jeśli dostępne).",
            customTitle: "Własny…",
            customSubtitle: "Wpisz id modelu.",
          },
          prompt: {
            title: "Id modelu",
            body: "Wpisz id modelu ElevenLabs lub zostaw puste, aby użyć domyślnego.",
          },
        },
        voiceSettings: {
          default: "Domyślne",
          stability: {
            title: "Stabilność",
            subtitle: "0–1. Puste = domyślne.",
            promptTitle: "Stabilność (0–1)",
            promptBody:
              "Wpisz liczbę od 0 do 1. Zostaw puste, aby użyć domyślnego.",
            invalid: "Wpisz liczbę od 0 do 1.",
          },
          similarityBoost: {
            title: "Wzmocnienie podobieństwa",
            subtitle: "0–1. Puste = domyślne.",
            promptTitle: "Wzmocnienie podobieństwa (0–1)",
            promptBody:
              "Wpisz liczbę od 0 do 1. Zostaw puste, aby użyć domyślnego.",
            invalid: "Wpisz liczbę od 0 do 1.",
          },
          style: {
            title: "Styl",
            subtitle: "0–1. Puste = domyślne.",
            promptTitle: "Styl (0–1)",
            promptBody:
              "Wpisz liczbę od 0 do 1. Zostaw puste, aby użyć domyślnego.",
            invalid: "Wpisz liczbę od 0 do 1.",
          },
          speed: {
            title: "Prędkość",
            subtitle: "0.5–2. Puste = domyślne.",
            promptTitle: "Prędkość (0.5–2)",
            promptBody:
              "Wpisz liczbę od 0.5 do 2. Zostaw puste, aby użyć domyślnego.",
            invalid: "Wpisz liczbę od 0.5 do 2.",
          },
        },
        getStartedTitle: "Zacznij",
      },
      apiKeySaveFailed: "Nie udało się zapisać klucza API. Spróbuj ponownie.",
      disconnect: "Rozłącz",
      disconnectSubtitle:
        "Usuń zapisane na tym urządzeniu dane uwierzytelniające ElevenLabs",
      disconnectTitle: "Rozłącz ElevenLabs",
      disconnectDescription:
        "Spowoduje to usunięcie zapisanego klucza API ElevenLabs i ID agenta z tego urządzenia.",
      disconnectConfirm: "Rozłącz",
    },
    local: {
      title: "Lokalny OSS Voice",
      footer:
        "Skonfiguruj endpointy kompatybilne z OpenAI dla STT (speech-to-text) i TTS (text-to-speech).",
      localhostWarning:
        "Uwaga: „localhost” i „127.0.0.1” zwykle nie działają na telefonach. Użyj adresu LAN komputera lub tunelu.",
      notSet: "Nie ustawiono",
      apiKeySet: "Ustawiono",
      apiKeyNotSet: "Nie ustawiono",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "Opcjonalne",
      apiKeySaveFailed: "Nie udało się zapisać klucza API. Spróbuj ponownie.",
      googleCloudTts: {
        provider: {
          title: "Google Cloud: Text‑to‑Speech",
          subtitle:
            "Użyj własnego klucza API Google Cloud do syntezy audio.",
          detail: "Google Cloud (GCP)",
        },
        common: {
          default: "Domyślne",
        },
        apiKey: {
          title: "Klucz API Google Cloud",
          promptTitle: "Klucz API Google Cloud",
          promptBody:
            "Utwórz klucz API z włączonym Text-to-Speech API. Opcjonalnie: ogranicz klucz do tej aplikacji (iOS bundle id / Android package+SHA1).",
        },
        androidCertSha1: {
          title: "SHA-1 certyfikatu Android (opcjonalnie)",
          subtitle:
            "Potrzebne tylko, jeśli ograniczysz klucz API do aplikacji Android.",
          promptTitle: "SHA-1 certyfikatu Android",
          promptBody: "Przykład: AA:BB:CC:... (z certyfikatu podpisywania).",
        },
        language: {
          title: "Język",
          subtitle: "Opcjonalny filtr listy głosów.",
          searchPlaceholder: "Szukaj języków",
          allTitle: "Wszystkie",
          allSubtitle: "Pokaż głosy dla wszystkich języków.",
        },
        speakingRate: {
          title: "Tempo mowy",
          subtitle: "0.25–4.0 (puste = domyślne dla głosu).",
          promptTitle: "Tempo mowy",
          promptBody:
            "Ustaw tempo mowy (0.25–4.0). Zostaw puste, aby użyć domyślnego.",
        },
        pitch: {
          title: "Wysokość tonu",
          subtitle: "-20–20 (puste = domyślne dla głosu).",
          promptTitle: "Wysokość tonu",
          promptBody:
            "Ustaw wysokość tonu (-20–20). Zostaw puste, aby użyć domyślnego.",
        },
        voice: {
          title: "Głos",
          subtitle: "Wybierz głos Google Cloud.",
          searchPlaceholder: "Szukaj głosów",
          selectPrompt: "Wybierz…",
          setApiKeyPrompt: "Ustaw klucz API",
          loadingTitle: "Wczytywanie głosów…",
        },
        format: {
          title: "Format audio",
          subtitle: "MP3 jest mniejsze; WAV jest bez kompresji.",
          mp3Subtitle: "Mniejszy rozmiar, szeroka kompatybilność.",
          wavSubtitle: "Większy rozmiar, bez kompresji.",
        },
        alerts: {
          missingApiKey: "Brak klucza API Google Cloud.",
          missingVoice: "Najpierw wybierz głos Google Cloud.",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Gemini od Google (audio)",
          subtitle: "Transkrybuj audio za pomocą multimodalnych modeli Gemini.",
          detail: "Gemini od Google",
        },
        apiKey: {
          title: "Klucz API Gemini",
          promptTitle: "Klucz API Gemini",
          promptBody: "Utwórz klucz API w Google AI Studio (Gemini API).",
        },
        model: {
          title: "Model Gemini",
          subtitle: "Wybierz model Gemini do transkrypcji.",
          searchPlaceholder: "Szukaj modeli",
          customTitle: "Własny identyfikator modelu…",
          customSubtitle: "Wpisz nazwę modelu ręcznie.",
          loadingModelsTitle: "Ładowanie modeli…",
          promptTitle: "Model Gemini",
          promptBody: "Przykład: gemini-2.5-flash",
        },
        language: {
          title: "Język",
          subtitle:
            "Opcjonalna podpowiedź, aby poprawić dokładność transkrypcji.",
          searchPlaceholder: "Szukaj języków",
          autoTitle: "Automatycznie",
          autoSubtitle: "Nie podawaj podpowiedzi językowej.",
        },
      },
      kokoro: {
        common: {
          default: "Domyślne",
          none: "Brak",
        },
        runtime: {
          title: "Środowisko Kokoro",
          unsupportedSubtitle:
            "Kokoro nie jest obsługiwane na tym urządzeniu/środowisku.",
          unavailableDetail: "Niedostępne",
        },
        manifest: {
          title: "Manifest pakietu modelu",
          subtitle:
            "Domyślnie używa pakietów modeli Happier (nadpisz przez EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS).",
          detailResolved: "Ustalono",
          detailMissing: "Brak",
        },
        assetPack: {
          title: "Pakiet modelu Kokoro",
          subtitleNative: "Wybierz pakiet zasobów dla Kokoro.",
          subtitleWeb: "Wybierz konfigurację środowiska dla Kokoro.",
        },
        model: {
          title: "Model Kokoro",
          subtitleNative:
            "Pobierz wymagane pliki, aby włączyć syntezę na urządzeniu.",
          subtitleWeb: "Pobierane na żądanie. WebAssembly (beta).",
        },
        modelStatus: {
          downloading: "Pobieranie…",
          downloadingPrefix: "Pobieranie",
          ready: "Gotowe",
          error: "Błąd",
          notDownloaded: "Nie pobrano",
        },
        removeAssets: {
          title: "Usuń zasoby Kokoro",
          subtitle: "Zwolnij miejsce, usuwając pobrane pliki Kokoro.",
          detailRemove: "Usuń",
          confirmTitle: "Usunąć zasoby Kokoro?",
          confirmBody:
            "Spowoduje to usunięcie pobranych plików Kokoro z tego urządzenia.",
          confirmButton: "Usuń",
        },
        updates: {
          title: "Sprawdź aktualizacje modelu",
          subtitle: "Ręcznie sprawdź, czy jest dostępny nowszy pakiet modelu.",
          check: "Sprawdź",
          upToDate: "Aktualne",
          updateAvailable: "Dostępna aktualizacja",
        },
        alerts: {
          runtimeUnsupported: {
            body: "Kokoro nie jest obsługiwane na tym urządzeniu/środowisku.",
          },
          missingManifest: {
            title: "Brak URL manifestu",
            body: "Nie można ustalić URL manifestu pakietu modelu. Sprawdź EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS (lub starsze zmienne środowiskowe Kokoro).",
          },
          notInstalledTitle: "Nie zainstalowano",
          notInstalledBody:
            "Najpierw pobierz pakiet modelu, aby włączyć sprawdzanie aktualizacji.",
          upToDateTitle: "Aktualne",
          upToDateBody: "Brak dostępnych aktualizacji dla tego pakietu modelu.",
          updateAvailableTitle: "Dostępna aktualizacja",
          updateAvailableBody: ({
            remoteBuild,
          }: {
            remoteBuild: string | null;
          }) =>
            `Pobrać najnowszą wersję tego pakietu modelu teraz?${remoteBuild ? `\n\nZdalna kompilacja: ${remoteBuild}` : ""}`,
          updatedTitle: "Zaktualizowano",
          updatedBody: "Pakiet modelu został pomyślnie zaktualizowany.",
          updateFailedTitle: "Aktualizacja nie powiodła się",
          updateFailedBody: ({ message }: { message: string }) =>
            `Nie można zaktualizować tego pakietu modelu.\n\n${message}`,
        },
        voice: {
          title: "Głos",
          subtitleNative: "Wybierz głos Kokoro.",
          searchPlaceholder: "Szukaj głosów",
          titleWeb: "Głos Kokoro",
          subtitleWeb: "Wybierz głos urządzenia używany w odpowiedziach.",
          loadingVoicesTitle: "Ładowanie głosów…",
        },
        speed: {
          title: "Szybkość",
          subtitle: "Dostosuj tempo mowy (0,5–2,0).",
        },
        web: {
          warmingUp: "Rozgrzewanie…",
          clearCache: {
            confirmTitle: "Wyczyścić cache Kokoro?",
            confirmBody:
              "To usunie pobrane pliki modelu i głosu Kokoro z tego urządzenia.",
            confirmButton: "Wyczyść",
          },
          cacheDetail: {
            modelFiles: "Pliki modelu",
            voices: "Głosy",
          },
          cache: {
            title: "Cache Kokoro",
            subtitle: "Zarządzaj pobranymi plikami Kokoro na tym urządzeniu.",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "Pakiet modelu",
          subtitle: "Id pakietu modelu STT (streaming).",
        },
        modelFiles: {
          title: "Pliki modelu",
          subtitle:
            "Pobierz wymagane pliki, aby włączyć streaming STT na urządzeniu.",
        },
        removeModelFiles: {
          title: "Usuń pliki modelu",
          subtitle: "Zwolnij miejsce, usuwając pobrane pliki modelu.",
          confirmTitle: "Usunąć pliki modelu?",
          confirmBody:
            "Spowoduje to usunięcie pobranego pakietu modelu STT z tego urządzenia.",
        },
        status: {
          installed: "Zainstalowano",
          installedWithBuild: ({ build }: { build: string }) =>
            `Zainstalowano • ${build}`,
          notInstalled: "Nie zainstalowano",
        },
        language: {
          title: "Język",
          subtitle: "Opcjonalny znacznik języka BCP-47.",
          promptTitle: "Język",
          promptBody: "Wpisz znacznik języka BCP-47 (np. en, en-US).",
        },
        alerts: {
          downloadFailedTitle: "Pobieranie nie powiodło się",
          downloadFailedBody: ({ message }: { message: string }) =>
            `Nie można pobrać tego pakietu modelu.\n\n${message}`,
          notInstalledTitle: "Nie zainstalowano",
          notInstalledBody:
            "Najpierw pobierz pakiet modelu, aby włączyć sprawdzanie aktualizacji.",
          upToDateBody: "Brak dostępnych aktualizacji dla tego pakietu modelu.",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `Pobrać teraz najnowszą wersję tego pakietu modelu?${remoteBuild ? `\n\nZdalny build: ${remoteBuild}` : ""}`,
          updatedTitle: "Zaktualizowano",
          updatedBody: "Pakiet modelu został zaktualizowany pomyślnie.",
          updateFailedTitle: "Aktualizacja nie powiodła się",
          updateFailedBody: ({ message }: { message: string }) =>
            `Nie można zaktualizować tego pakietu modelu.\n\n${message}`,
        },
      },
      conversationMode: "Tryb rozmowy",
      conversationModeSubtitle:
        "Bezpośrednio do sesji lub agent głosowy z jawnym commitem",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "Użyj agenta głosowego (jawny commit, kontrola narzędzi).",
          directTitle: "Bezpośrednia sesja",
          directSubtitle: "Mów bezpośrednio do aktywnej sesji.",
        },
        handsFree: {
          title: "Tryb hands‑free",
          enableTitle: "Włącz tryb hands-free",
          silenceTitle: "Limit ciszy (ms)",
          minSpeechTitle: "Minimalna mowa (ms)",
        },
        customBackendIdSubtitle: "Wpisz niestandardowy identyfikator backendu.",
        searchBackendsPlaceholder: "Szukaj backendów",
        searchModelsPlaceholder: "Szukaj modeli",
        machineAutoSubtitle:
          "Automatycznie wybieraj maszynę na podstawie ostatniego użycia.",
        rootSessionPolicy: {
          title: "Polityka sesji głównej",
          fallbackSubtitle: "Wybierz politykę.",
          singleTitle: "Pojedyncza",
          singleSubtitle: "Za każdym razem twórz nową sesję główną.",
          keepWarmTitle: "Utrzymuj w gotowości",
          keepWarmSubtitle:
            "W miarę możliwości używaj ponownie rozgrzanej sesji głównej.",
          maxWarmRootsTitle: "Maks. rozgrzanych korzeni",
          maxWarmRootsSubtitle:
            "Ogranicz liczbę rozgrzanych sesji głównych.",
        },
        persistence: {
          title: "Trwałość transkrypcji",
          ephemeralTitle: "Tymczasowa",
          ephemeralSubtitle:
            "Nie zapisuj stanu agenta głosowego między sesjami.",
          persistentTitle: "Trwała",
          persistentSubtitle:
            "Zapisuj stan agenta głosowego między sesjami (wznawialne).",
        },
        resetVoiceAgent: {
          title: "Zresetuj stan agenta głosowego",
          subtitle: "Czyści trwały stan agenta głosowego.",
          confirmBody:
            "To wyczyści zapisany stan agenta głosowego. Nie można tego cofnąć.",
        },
        agentSettings: {
          title: "Agent głosowy",
        },
        backend: {
          daemonSubtitle:
            "Używa backendu Happier i obsługuje wznawianie u dostawcy.",
          openAiSubtitle:
            "Połącz z endpointami HTTP zgodnymi z OpenAI.",
        },
        agentMachine: {
          title: "Maszyna agenta",
          fallbackSubtitle: "Wybierz, gdzie uruchomić agenta głosowego.",
          stayInVoiceHomeTitle: "Pozostań w voice home",
          stayInVoiceHomeEnabledSubtitle:
            "Utrzymuj agenta na maszynie voice home.",
          stayInVoiceHomeDisabledSubtitle:
            "Pozwól agentowi podążać za maszyną sesji.",
          allowTeleportTitle: "Zezwól na teleport",
          teleportEnabledSubtitle:
            "Pozwól przenosić agenta na inną maszynę, gdy to potrzebne.",
          teleportDisabledSubtitle: "Teleport wyłączony.",
        },
        agentSource: {
          followSessionTitle: "Podążaj za sesją",
          followSessionSubtitle: "Używaj backendu i konfiguracji sesji.",
          fixedAgentTitle: "Stały agent",
          fixedAgentSubtitle:
            "Zawsze używaj konkretnego backendu agenta.",
        },
        permissionPolicy: {
          readOnlySubtitle:
            "Może widzieć kontekst, ale nie może uruchamiać narzędzi.",
          noToolsSubtitle:
            "Powinien unikać próśb o narzędzia i nigdy ich nie uruchamiać.",
        },
        chatModelSource: {
          sessionSubtitle:
            "Użyj konfiguracji modelu sesji do czatu agenta.",
          customSubtitle:
            "Nadpisz identyfikator modelu czatu agenta głosowego.",
        },
        chatModelId: {
          title: "Id modelu czatu agenta głosowego",
          subtitle:
            "Używane, gdy źródło modelu czatu ustawiono na Własny model.",
        },
        commitModelSource: {
          chatSubtitle: "Użyj modelu czatu agenta do commitów.",
          sessionSubtitle:
            "Użyj konfiguracji modelu sesji do commitów.",
          customSubtitle:
            "Nadpisz identyfikator modelu commitów agenta głosowego.",
        },
        commitModelId: {
          title: "Id modelu commitów agenta głosowego",
          subtitle:
            "Używane, gdy źródło modelu commitów ustawiono na Własny model.",
        },
        commitIsolation: {
          title: "Izolacja commitów",
          subtitle:
            "Użyj oddzielnej sesji dostawcy do generowania commitów (zaawansowane).",
        },
        resumability: {
          modeTitle: "Wznawianie",
          replayTitle: "Odtwarzanie",
          replaySubtitle:
            "Wznawiaj poprzez odtworzenie ostatnich wiadomości.",
          providerResumeTitle: "Wznawianie dostawcy",
          providerResumeSubtitle:
            "Wznawiaj na podstawie stanu sesji dostawcy (gdy obsługiwane).",
          disabledVoiceAgent: "Wymaga Happier Voice Agent.",
          disabledDaemonBackend: "Wymaga backendu Daemon.",
          disabledAgentNoProviderResume:
            "Wybrany agent nie obsługuje wznawiania u dostawcy.",
        },
        providerResumeFallback: {
          title: "Zapasowo: odtwarzanie",
          subtitle:
            "Jeśli wznawianie dostawcy się nie powiedzie, przejdź na odtwarzanie.",
        },
        replayRecentMessagesPromptBody:
          "Ile ostatnich wiadomości uwzględnić (1–100).",
        prewarm: {
          title: "Rozgrzewaj przy połączeniu",
          subtitle: "Uruchamiaj agenta głosowego od razu po połączeniu.",
        },
        welcome: {
          title: "Wiadomość powitalna",
          offTitle: "Wył.",
          offSubtitle: "Nie wysyłaj wiadomości powitalnej.",
          immediateTitle: "Od razu",
          immediateSubtitle:
            "Wyślij powitanie zaraz po uruchomieniu agenta.",
          onFirstTurnTitle: "Przy pierwszej wypowiedzi",
          onFirstTurnSubtitle:
            "Wyślij powitanie, gdy odezwiesz się po raz pierwszy.",
        },
        verbosity: {
          shortSubtitle: "Utrzymuj odpowiedzi agenta krótkie.",
          balancedSubtitle:
            "Pozwól na trochę więcej szczegółów, gdy potrzeba.",
        },
        streaming: {
          title: "Strumieniowanie",
          enableTitle: "Włącz strumieniowanie",
          enableTtsTitle: "Włącz strumieniowanie TTS",
          ttsChunkCharsTitle: "Znaki w kawałku TTS",
          ttsChunkCharsPromptBody:
            "Ile znaków buforować przed pobraniem kolejnego kawałka TTS (32–2000).",
        },
        network: {
          title: "Sieć",
          timeoutTitle: "Limit czasu sieci (ms)",
          timeoutPromptBody:
            "Limit czasu żądań do Twoich endpointów (1000–60000).",
        },
      },
      mediatorBackend: "Backend agenta głosowego",
      mediatorBackendSubtitle:
        "Daemon (używa backendu Happier) lub OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Demon",
      mediatorBackendOpenAi: "HTTP zgodne z OpenAI",
      mediatorAgentSource: "Źródło agenta głosowego",
      mediatorAgentSourceSubtitle:
        "Użyj backendu sesji lub wymuś konkretny backend agenta",
      mediatorAgentSourceSession: "Backend sesji",
      mediatorAgentSourceAgent: "Konkretny agent",
      mediatorAgentId: "Agent głosowy",
      mediatorAgentIdSubtitle:
        "Którego backendu agenta użyć dla agenta głosowego (gdy nie używasz sesji)",
      mediatorPermissionPolicy: "Uprawnienia agenta głosowego",
      mediatorPermissionPolicySubtitle:
        "Ogranicz użycie narzędzi podczas działania agenta głosowego",
      mediatorPermissionReadOnly: "Tylko odczyt",
      mediatorPermissionNoTools: "Brak narzędzi",
      mediatorVerbosity: "Szczegółowość agenta głosowego",
      mediatorVerbositySubtitle: "Jak szczegółowy ma być agent głosowy",
      mediatorVerbosityShort: "Krótko",
      mediatorVerbosityBalanced: "Zrównoważone",
      mediatorIdleTtl: "TTL bezczynności agenta głosowego",
      mediatorIdleTtlSubtitle:
        "Automatyczne zatrzymanie po bezczynności (60–3600s)",
      mediatorIdleTtlTitle: "TTL bezczynności agenta głosowego (sekundy)",
      mediatorIdleTtlDescription: "Wpisz liczbę od 60 do 3600.",
      mediatorIdleTtlInvalid: "Wpisz liczbę od 60 do 3600.",
      mediatorChatModelSource: "Źródło modelu (chat)",
      mediatorChatModelSourceSubtitle:
        "Użyj modelu sesji lub własnego szybkiego modelu",
      mediatorChatModelSourceSession: "Model sesji",
      mediatorChatModelSourceCustom: "Własny model",
      mediatorCommitModelSource: "Źródło modelu (commit)",
      mediatorCommitModelSourceSubtitle:
        "Użyj modelu chatu, sesji lub własnego modelu",
      mediatorCommitModelSourceChat: "Model chatu",
      mediatorCommitModelSourceSession: "Model sesji",
      mediatorCommitModelSourceCustom: "Własny model",
      chatBaseUrl: "Bazowy URL czatu",
      chatBaseUrlTitle: "Bazowy URL czatu",
      chatBaseUrlDescription:
        "Bazowy URL do endpointu chat completion kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      chatApiKey: "Klucz API czatu",
      chatApiKeyTitle: "Klucz API czatu",
      chatApiKeyDescription:
        "Opcjonalny klucz API dla serwera chat (przechowywany zaszyfrowany). Zostaw puste, aby wyczyścić.",
      chatModel: "Model chat",
      chatModelSubtitle: "Szybki model używany do rozmowy głosowej",
      chatModelTitle: "Model chat",
      chatModelDescription:
        "Nazwa modelu wysyłana do serwera chat (pole kompatybilne z OpenAI).",
      modelCustomTitle: "Własny…",
      modelCustomSubtitle: "Wpisz ID modelu",
      commitModel: "Model commit",
      commitModelSubtitle: "Model używany do wygenerowania finalnej instrukcji",
      commitModelTitle: "Model commit",
      commitModelDescription:
        "Nazwa modelu wysyłana przy generowaniu finalnej wiadomości.",
      chatTemperature: "Temperatura czatu",
      chatTemperatureSubtitle: "Kontroluje losowość (0–2)",
      chatTemperatureTitle: "Temperatura czatu",
      chatTemperatureDescription: "Wpisz liczbę od 0 do 2.",
      chatTemperatureInvalid: "Wpisz liczbę od 0 do 2.",
      chatMaxTokens: "Maks. tokenów czatu",
      chatMaxTokensSubtitle: "Limit długości odpowiedzi (puste = domyślne)",
      chatMaxTokensTitle: "Maks. tokenów czatu",
      chatMaxTokensDescription:
        "Wpisz dodatnią liczbę całkowitą lub zostaw puste dla domyślnej.",
      chatMaxTokensPlaceholder: "Puste = domyślne",
      chatMaxTokensUnlimited: "Domyślne",
      chatMaxTokensInvalid: "Wpisz dodatnią liczbę lub zostaw puste.",
      sttBaseUrl: "Bazowy URL STT",
      sttBaseUrlTitle: "Bazowy URL STT",
      sttBaseUrlDescription:
        "Bazowy URL do endpointu transkrypcji kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      sttApiKey: "Klucz API STT",
      sttApiKeyTitle: "Klucz API STT",
      sttApiKeyDescription:
        "Opcjonalny klucz API dla serwera STT (przechowywany zaszyfrowany). Zostaw puste, aby wyczyścić.",
      sttModel: "Model STT",
      sttModelSubtitle: "Nazwa modelu wysyłana w żądaniach transkrypcji",
      sttModelTitle: "Model STT",
      sttModelDescription:
        "Nazwa modelu wysyłana do serwera STT (pole kompatybilne z OpenAI).",
      deviceStt: "STT urządzenia (eksperymentalne)",
      deviceSttSubtitle:
        "Użyj rozpoznawania mowy na urządzeniu zamiast OpenAI-compat endpointu",
      sttProvider: "Dostawca STT",
      neuralStt: {
        title: "STT na urządzeniu",
        webNotAvailableSubtitle:
          "Niedostępne w web. Użyj STT urządzenia, endpointu zgodnego z OpenAI lub Gemini STT.",
      },
      ttsBaseUrl: "Bazowy URL TTS",
      ttsBaseUrlTitle: "Bazowy URL TTS",
      ttsBaseUrlDescription:
        "Bazowy URL do endpointu mowy kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      ttsApiKey: "Klucz API TTS",
      ttsApiKeyTitle: "Klucz API TTS",
      ttsApiKeyDescription:
        "Opcjonalny klucz API dla serwera TTS (przechowywany zaszyfrowany). Zostaw puste, aby wyczyścić.",
      ttsModel: "Model TTS",
      ttsModelSubtitle: "Nazwa modelu wysyłana w żądaniach mowy",
      ttsModelTitle: "Model TTS",
      ttsModelDescription:
        "Nazwa modelu wysyłana do serwera TTS (pole kompatybilne z OpenAI).",
      ttsVoice: "Głos TTS",
      ttsVoiceSubtitle: "Nazwa/ID głosu wysyłana w żądaniach mowy",
      ttsVoiceTitle: "Głos TTS",
      ttsVoiceDescription:
        "Nazwa/ID głosu wysyłana do serwera TTS (pole kompatybilne z OpenAI).",
      ttsFormat: "Format TTS",
      ttsFormatSubtitle: "Format audio zwracany przez TTS",
      ttsFormatOptions: {
        mp3Subtitle: "Mniejszy plik, szeroka kompatybilność.",
        wavSubtitle: "Większy plik, bez kompresji.",
      },
      testTts: "Testuj TTS",
      testTtsSubtitle:
        "Odtwórz krótki przykład używając skonfigurowanego lokalnego TTS (na urządzeniu lub przez endpoint)",
      testTtsSample: "Cześć z Happier. To test Twojego lokalnego TTS.",
      testTtsMissingBaseUrl: "Najpierw ustaw bazowy URL TTS.",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "TTS urządzenia (eksperymentalne)",
      deviceTtsSubtitle:
        "Użyj syntezy mowy na urządzeniu zamiast OpenAI-compat endpointu",
      ttsProvider: "Dostawca TTS",
      ttsProviderSubtitle:
        "Wybierz TTS urządzenia, endpoint zgodny z OpenAI lub Kokoro (web/desktop)",

      autoSpeak: "Automatycznie odtwarzaj odpowiedzi",
      autoSpeakSubtitle:
        "Odtwarzaj następną odpowiedź asystenta po wysłaniu wiadomości głosowej",
      bargeIn: "Przerywanie",
      speaking: "Mówi…",
    },
    privacy: {
      title: "Prywatność",
      footer: "Dostawcy głosu otrzymują wybrany kontekst sesji.",
      shareSessionSummary: "Udostępniaj podsumowanie sesji",
      shareSessionSummarySubtitle:
        "Dołącz podsumowanie sesji do kontekstu głosowego",
      shareRecentMessages: "Udostępniaj ostatnie wiadomości",
      shareRecentMessagesSubtitle:
        "Dołącz ostatnie wiadomości do kontekstu głosowego",
      recentMessagesCount: "Liczba ostatnich wiadomości",
      recentMessagesCountSubtitle: "Ile ostatnich wiadomości dołączyć (0–50)",
      recentMessagesCountTitle: "Liczba ostatnich wiadomości",
      recentMessagesCountDescription: "Wpisz liczbę od 0 do 50.",
      recentMessagesCountInvalid: "Wpisz liczbę od 0 do 50.",
      shareToolNames: "Udostępniaj nazwy narzędzi",
      shareToolNamesSubtitle: "Dołącz nazwy/opisy narzędzi w kontekście głosowym",
      shareDeviceInventory: "Udostępniaj inwentarz urządzeń",
      shareDeviceInventorySubtitle:
        "Pozwól głosowi wyświetlać ostatnie workspace’y, maszyny i serwery",
      shareToolArgs: "Udostępniaj argumenty narzędzi",
      shareToolArgsSubtitle: "Dołącz argumenty narzędzi (może zawierać ścieżki lub sekrety)",
      sharePermissionRequests: "Udostępniaj prośby o uprawnienia",
      sharePermissionRequestsSubtitle: "Przekazuj prośby o uprawnienia do głosu",
      shareFilePaths: "Udostępniaj ścieżki plików",
      shareFilePathsSubtitle:
        "Dołącz lokalne ścieżki w kontekście głosowym (niezalecane)",
    },
    languageTitle: "Język",
    languageDescription:
      "Wybierz preferowany język dla interakcji z asystentem głosowym. To ustawienie synchronizuje się na wszystkich Twoich urządzeniach.",
    preferredLanguage: "Preferowany język",
    preferredLanguageSubtitle:
      "Język używany do odpowiedzi asystenta głosowego",
    language: {
      searchPlaceholder: "Wyszukaj języki...",
      title: "Języki",
      footer: ({ count }: { count: number }) =>
        `Dostępnych ${count} ${plural({ count, one: "język", few: "języki", many: "języków" })}`,
      autoDetect: "Automatyczne wykrywanie",
      autoDetectSubtitle: "Pozwól rozpoznawaniu zdecydować (zalecane).",
      customTitle: "Własne…",
      customSubtitle: "Wpisz znacznik języka BCP-47.",
      options: {
        english: "Angielski",
        englishUs: "Angielski (USA)",
        french: "Francuski",
        spanish: "Hiszpański",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Informacje o koncie",
    status: "Stan",
    statusActive: "Aktywny",
    statusNotAuthenticated: "Nie uwierzytelniony",
    anonymousId: "ID anonimowe",
    publicId: "ID publiczne",
    notAvailable: "Niedostępne",
    linkNewDevice: "Zeskanuj QR, aby połączyć nowe urządzenie",
    linkNewDeviceSubtitle: "Zeskanuj kod QR wyświetlony na nowym urządzeniu",
    profile: "Profil",
    name: "Nazwa",
    github: "GitHub",
    showGitHubOnProfile: "Pokaż w profilu",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `Pokaż ${provider} w profilu`,
    tapToDisconnect: "Dotknij, aby rozłączyć",
    server: "Serwer",
    backup: "Kopia zapasowa",
    backupDescription:
      "Twój klucz tajny to jedyny sposób na odzyskanie konta. Zapisz go w bezpiecznym miejscu, takim jak menedżer haseł.",
    secretKey: "Klucz tajny",
    tapToReveal: "Dotknij, aby pokazać",
    tapToHide: "Dotknij, aby ukryć",
    secretKeyLabel: "KLUCZ TAJNY (DOTKNIJ, ABY SKOPIOWAĆ)",
    secretKeyCopied:
      "Klucz tajny skopiowany do schowka. Przechowuj go w bezpiecznym miejscu!",
    secretKeyCopyFailed: "Nie udało się skopiować klucza tajnego",
    privacy: "Prywatność",
    privacyDescription:
      "Pomóż ulepszyć aplikację, udostępniając anonimowe dane o użytkowaniu. Nie zbieramy żadnych informacji osobistych.",
    analytics: "Analityka",
    analyticsDisabled: "Dane nie są udostępniane",
    analyticsEnabled: "Anonimowe dane o użytkowaniu są udostępniane",
    crashReports: "Raporty awarii",
    crashReportsDisabled: "Raporty awarii nie są udostępniane",
    crashReportsEnabled: "Raporty awarii są udostępniane",
    dangerZone: "Strefa niebezpieczna",
    logout: "Wyloguj",
    logoutSubtitle: "Wyloguj się i wyczyść dane lokalne",
    logoutConfirm:
      "Czy na pewno chcesz się wylogować? Upewnij się, że masz kopię zapasową klucza tajnego!",
    encryptionUpdateFailed: "Nie udało się zaktualizować ustawienia szyfrowania",
    secretKeyMissing: "Brak klucza tajnego. Najpierw przywróć konto.",
    restoreRequiredTitle: "Wymagane przywrócenie",
    restoreRequiredBody:
      "To konto ma zaszyfrowaną historię. Aby ponownie włączyć szyfrowanie na tym urządzeniu, przywróć swój klucz tajny. Jeśli zgubiłeś klucz, możesz zresetować konto i zacząć od nowa (starej zaszyfrowanej historii nie da się odzyskać).",
  },

  settingsLanguage: {
    // Language settings screen
    title: "Język",
    description:
      "Wybierz preferowany język interfejsu aplikacji. To ustawienie zostanie zsynchronizowane na wszystkich Twoich urządzeniach.",
    currentLanguage: "Aktualny język",
    automatic: "Automatycznie",
    automaticSubtitle: "Wykrywaj na podstawie ustawień urządzenia",
    needsRestart: "Język zmieniony",
    needsRestartMessage:
      "Aplikacja musi zostać uruchomiona ponownie, aby zastosować nowe ustawienia języka.",
    restartNow: "Uruchom ponownie",
  },

  connectButton: {
    authenticate: "Uwierzytelnij terminal",
    authenticateWithUrlPaste: "Uwierzytelnij terminal poprzez wklejenie URL",
    pasteAuthUrl: "Wklej URL uwierzytelnienia z terminala",
  },

  updateBanner: {
    updateAvailable: "Dostępna aktualizacja",
    pressToApply: "Naciśnij, aby zastosować aktualizację",
    whatsNew: "Co nowego",
    seeLatest: "Zobacz najnowsze aktualizacje i ulepszenia",
    nativeUpdateAvailable: "Dostępna aktualizacja aplikacji",
    tapToUpdateAppStore: "Naciśnij, aby zaktualizować w App Store",
    tapToUpdatePlayStore: "Naciśnij, aby zaktualizować w Sklepie Play",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `Wersja ${version}`,
    noEntriesAvailable: "Brak dostępnych wpisów dziennika zmian.",
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Wymagana przeglądarka internetowa",
    webBrowserRequiredDescription:
      "Linki połączenia terminala można otwierać tylko w przeglądarce internetowej ze względów bezpieczeństwa. Użyj skanera kodów QR lub otwórz ten link na komputerze.",
    processingConnection: "Przetwarzanie połączenia...",
    invalidConnectionLink: "Nieprawidłowy link połączenia",
    invalidConnectionLinkDescription:
      "Link połączenia jest nieprawidłowy lub go brakuje. Sprawdź URL i spróbuj ponownie.",
    connectTerminal: "Połącz terminal",
    terminalRequestDescription:
      "Terminal żąda połączenia z Twoim kontem Happier Coder. Pozwoli to terminalowi bezpiecznie wysyłać i odbierać wiadomości.",
    connectionDetails: "Szczegóły połączenia",
    publicKey: "Klucz publiczny",
    encryption: "Szyfrowanie",
    endToEndEncrypted: "Szyfrowanie end-to-end",
    acceptConnection: "Akceptuj połączenie",
    connecting: "Łączenie...",
    reject: "Odrzuć",
    security: "Bezpieczeństwo",
    securityFooter:
      "Ten link połączenia został bezpiecznie przetworzony w Twojej przeglądarce i nigdy nie został wysłany na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.",
    securityFooterDevice:
      "To połączenie zostało bezpiecznie przetworzone na Twoim urządzeniu i nigdy nie zostało wysłane na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.",
    clientSideProcessing: "Przetwarzanie po stronie klienta",
    linkProcessedLocally: "Link przetworzony lokalnie w przeglądarce",
    linkProcessedOnDevice: "Link przetworzony lokalnie na urządzeniu",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `To połączenie dotyczy ${serverUrl}. Przełączyć serwer i kontynuować?`,
  },

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "Uwierzytelnij terminal",
    pasteUrlFromTerminal: "Wklej URL uwierzytelnienia z terminala",
    deviceLinkedSuccessfully: "Urządzenie połączone pomyślnie",
    terminalConnectedSuccessfully: "Terminal połączony pomyślnie",
    terminalAlreadyConnected: "Połączenie zostało już użyte",
    terminalConnectionAlreadyUsedDescription: "Ten link połączenia został już użyty przez inne urządzenie. Aby połączyć wiele urządzeń z tym samym terminalem, wyloguj się i zaloguj na to samo konto na wszystkich urządzeniach.",
    authRequestExpired: "Połączenie wygasło",
    authRequestExpiredDescription: "Ten link połączenia wygasł. Wygeneruj nowy link ze swojego terminala.",
    pleaseSignInFirst: "Najpierw zaloguj się (lub utwórz konto).",
    invalidAuthUrl: "Nieprawidłowy URL uwierzytelnienia",
    microphoneAccessRequiredTitle: "Wymagany dostęp do mikrofonu",
    microphoneAccessRequiredRequestPermission:
      "Happier potrzebuje dostępu do mikrofonu do czatu głosowego. Udziel zgody, gdy pojawi się prośba.",
    microphoneAccessRequiredEnableInSettings:
      "Happier potrzebuje dostępu do mikrofonu do czatu głosowego. Włącz dostęp do mikrofonu w ustawieniach urządzenia.",
    microphoneAccessRequiredBrowserInstructions:
      "Zezwól na dostęp do mikrofonu w ustawieniach przeglądarki. Być może musisz kliknąć ikonę kłódki na pasku adresu i włączyć uprawnienie mikrofonu dla tej witryny.",
    openSettings: "Otwórz ustawienia",
    developerMode: "Tryb deweloperski",
    developerModeEnabled: "Tryb deweloperski włączony",
    developerModeDisabled: "Tryb deweloperski wyłączony",
    disconnectGithub: "Rozłącz GitHub",
    disconnectGithubConfirm:
      "Rozłączenie wyłączy Przyjaciół i udostępnianie przyjaciołom do czasu ponownego połączenia.",
    disconnectService: ({ service }: { service: string }) =>
      `Rozłącz ${service}`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `Czy na pewno chcesz rozłączyć ${service} ze swojego konta?`,
    disconnect: "Rozłącz",
    failedToConnectTerminal: "Nie udało się połączyć terminala",
    cameraPermissionsRequiredToConnectTerminal:
      "Uprawnienia do kamery są wymagane do połączenia terminala",
    failedToLinkDevice: "Nie udało się połączyć urządzenia",
    cameraPermissionsRequiredToScanQr:
      "Uprawnienia do kamery są wymagane do skanowania kodów QR",
    qrScannerUnavailable:
      "Nie można otworzyć skanera QR. Spróbuj ponownie lub wpisz URL ręcznie.",
  },

    navigation: {
      // Navigation titles and screen headers
      connectTerminal: "Połącz terminal",
      linkNewDevice: "Połącz nowe urządzenie",
      restoreWithSecretKey: "Przywróć kluczem tajnym",
      whatsNew: "Co nowego",
      friends: "Przyjaciele",
      automations: "Automatyzacje",
      automation: "Automatyzacja",
      newAutomation: "Nowa automatyzacja",
      sourceControl: "Kontrola wersji",
      developerTools: "Narzędzia deweloperskie",
      listComponentsDemo: "Demo komponentów listy",
      typography: "Typografia",
      colors: "Kolory",
      toolViewsDemo: "Demo widoków narzędzi",
      maskedProgress: "Maskowany postęp",
      shimmerViewDemo: "Demo efektu migotania",
      multiTextInput: "Wieloliniowe pole tekstowe",
      connectClaude: "Połącz z Claude",
      zenNewTask: "Nowe zadanie",
      zenTaskDetails: "Szczegóły zadania",
    },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Mobilny klient Codex i Claude Code",
    subtitle:
      "Szyfrowanie end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu.",
    createAccount: "Utwórz konto",
    chooseEncryptionTitle: "Wybierz szyfrowanie",
    chooseEncryptionBody: "Ten serwer obsługuje konta szyfrowane i nieszyfrowane. Wybierz, jak chcesz przechowywać dane konta.",
    chooseEncryptionEncrypted: "Kontynuuj z szyfrowaniem end‑to‑end",
    chooseEncryptionPlain: "Kontynuuj bez szyfrowania",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Kontynuuj z ${provider}`,
    signInWithCertificate: "Zaloguj się certyfikatem",
    linkOrRestoreAccount: "Połącz lub przywróć konto",
    loginWithMobileApp: "Zaloguj się przez aplikację mobilną",
    serverUnavailableTitle: "Nie można połączyć się z serwerem",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Nie możemy połączyć się z ${serverUrl}. Spróbuj ponownie lub zmień serwer, aby kontynuować.`,
    serverIncompatibleTitle: "Serwer nie jest obsługiwany",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Serwer pod adresem ${serverUrl} zwrócił nieoczekiwaną odpowiedź. Zaktualizuj serwer lub zmień serwer, aby kontynuować.`,
  },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "Podoba Ci się aplikacja?",
    feedbackPrompt: "Chcielibyśmy usłyszeć Twoją opinię!",
    yesILoveIt: "Tak, uwielbiam ją!",
    notReally: "Nie bardzo",
  },

  items: {
    // Used by Item component for copy toast
    copiedToClipboard: ({ label }: { label: string }) =>
      `${label} skopiowano do schowka`,
  },

    machine: {
    offlineUnableToSpawn: "Launcher wyłączony, gdy maszyna jest offline",
    offlineHelp:
      "• Upewnij się, że komputer jest online\n• Uruchom `happier daemon status`, aby zdiagnozować\n• Czy używasz najnowszej wersji CLI? Zaktualizuj poleceniem `npm install -g @happier-dev/cli@latest`",
    launchNewSessionInDirectory: "Uruchom nową sesję w katalogu",
    customPathPlaceholder: "Wpisz własną ścieżkę",
    tools: {
      title: "Narzędzia",
      installablesTitle: "Instalowalne",
      installablesSubtitle:
        "Zarządzaj instalowalnymi narzędziami dla tej maszyny.",
    },
    installables: {
      screenTitle: "Instalowalne",
      aboutGroupTitle: "Informacje",
      aboutSubtitle:
        "Zarządzaj narzędziami, które Happier może instalować i utrzymywać w aktualności na tej maszynie.",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title} (eksperymentalne)`,
      autoInstallTitle: "Automatyczna instalacja w razie potrzeby",
      autoInstallSubtitle:
        "Instaluje w tle, gdy jest to wymagane dla wybranego backendu (best‑effort).",
      autoUpdateTitle: "Automatyczna aktualizacja",
      autoUpdatePromptTitle: "Automatyczna aktualizacja",
      autoUpdatePromptBody:
        "Wybierz, jak Happier ma obsługiwać aktualizacje dla tego instalowalnego elementu.",
      autoUpdateModes: {
        off: "Wyłączone",
        notify: "Powiadamiaj",
        auto: "Automatycznie",
      },
    },
    daemon: "Demon",
    status: "Stan",
    daemonStatus: {
      unknown: "Nieznany",
      stopped: "Zatrzymany",
      likelyAlive: "Prawdopodobnie działa",
    },
    stopDaemon: "Zatrzymaj daemon",
    stopDaemonConfirmTitle: "Zatrzymać daemon?",
    stopDaemonConfirmBody:
      "Nie będziesz mógł tworzyć nowych sesji na tej maszynie, dopóki nie uruchomisz ponownie daemona na komputerze. Obecne sesje pozostaną aktywne.",
    daemonStoppedTitle: "Daemon zatrzymany",
    stopDaemonFailed: "Nie udało się zatrzymać daemona. Może nie działa.",
    renameTitle: "Zmień nazwę maszyny",
    renameDescription:
      "Nadaj tej maszynie własną nazwę. Pozostaw puste, aby użyć domyślnej nazwy hosta.",
      renamePlaceholder: "Wpisz nazwę maszyny",
      renamedSuccess: "Nazwa maszyny została zmieniona",
      renameFailed: "Nie udało się zmienić nazwy maszyny",
      actions: {
        removeMachine: "Usuń maszynę",
        removeMachineSubtitle:
          "Cofa uprawnienia tej maszyny i usuwa ją z Twojego konta.",
        removeMachineConfirmBody:
          "To cofnie dostęp z tej maszyny (w tym klucze dostępu i przypisania automatyzacji). Możesz połączyć ją ponownie, logując się jeszcze raz z CLI.",
        removeMachineAlreadyRemoved:
          "Ta maszyna została już usunięta z Twojego konta.",
      },
      lastKnownPid: "Ostatni znany PID",
      lastKnownHttpPort: "Ostatni znany port HTTP",
      startedAt: "Uruchomiony o",
      cliVersion: "Wersja CLI",
    daemonStateVersion: "Wersja stanu daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Aktywne sesje (${count})`,
    machineGroup: "Maszyna",
    host: "Host (nazwa)",
    machineId: "ID maszyny",
    username: "Nazwa użytkownika",
    homeDirectory: "Katalog domowy",
    platform: "Platforma",
    architecture: "Architektura",
    lastSeen: "Ostatnio widziana",
    never: "Nigdy",
    metadataVersion: "Wersja metadanych",
    detectedClis: "Wykryte CLI",
    detectedCliNotDetected: "Nie wykryto",
    detectedCliUnknown: "Nieznane",
    detectedCliNotSupported: "Nieobsługiwane (zaktualizuj @happier-dev/cli)",
    untitledSession: "Sesja bez nazwy",
    back: "Wstecz",
    notFound: "Nie znaleziono maszyny",
    unknownMachine: "nieznana maszyna",
    unknownPath: "nieznana ścieżka",
    previousSessionsTitle: "Poprzednie sesje (do 5 najnowszych)",
    tmux: {
      overrideTitle: "Zastąp globalne ustawienia tmux",
      overrideEnabledSubtitle:
        "Niestandardowe ustawienia tmux dotyczą nowych sesji na tej maszynie.",
      overrideDisabledSubtitle: "Nowe sesje używają globalnych ustawień tmux.",
      notDetectedSubtitle: "tmux nie został wykryty na tej maszynie.",
      notDetectedMessage:
        "tmux nie został wykryty na tej maszynie. Zainstaluj tmux i odśwież wykrywanie.",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "Pokaż konsolę dla sesji zdalnych",
      remoteSessionConsoleVisibleSubtitle:
        "Sesje zdalne otwierają się w widocznym oknie konsoli na tej maszynie.",
      remoteSessionConsoleHiddenSubtitle:
        "Sesje zdalne uruchamiają się ukryte, aby uniknąć otwierania/zamykania okien.",
      remoteSessionConsoleUpdateFailed:
        "Nie udało się zaktualizować ustawienia konsoli sesji w Windows.",
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) =>
      `Przełączono na tryb ${mode}`,
    discarded: "Odrzucono",
    unknownEvent: "Nieznane zdarzenie",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Osiągnięto limit użycia do ${time}`,
    unknownTime: "nieznany czas",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "Uprawnienia są widoczne tylko w terminalu. Zresetuj lub wyślij wiadomość, aby sterować z aplikacji.",
    sessionRunningLocally:
      "Ta sesja działa lokalnie na tym komputerze. Możesz przełączyć na zdalny, aby sterować z aplikacji.",
    switchToRemote: "Przełącz na zdalny",
    localModeAvailable: "Tryb lokalny jest dostępny dla tej sesji.",
    localModeUnavailableMachineOffline:
      "Tryb lokalny jest niedostępny, gdy ta maszyna jest offline.",
    localModeUnavailableDaemonStarted:
      "Tryb lokalny jest niedostępny dla sesji uruchomionych przez demona.",
    localModeUnavailableNeedsResume:
      "Tryb lokalny wymaga obsługi wznawiania dla tego dostawcy.",
    switchToLocal: "Przełącz na lokalny",
  },

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "Tak, zezwól globalnie",
        yesForSession: "Tak, i nie pytaj dla tej sesji",
        stop: "Zatrzymaj",
        stopAndExplain: "Zatrzymaj i wyjaśnij, co zrobić",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits: "Tak, zezwól na wszystkie edycje podczas tej sesji",
        yesForTool: "Tak, nie pytaj ponownie dla tego narzędzia",
        yesForCommandPrefix:
          "Tak, nie pytaj ponownie dla tego prefiksu polecenia",
        yesForSubcommand: "Tak, nie pytaj ponownie dla tego podpolecenia",
        yesForCommandName: "Tak, nie pytaj ponownie dla tego polecenia",
        stop: "Zatrzymaj",
        noTellClaude: "Nie, przekaż opinię",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "Wybierz zakres tekstu",
    title: "Wybierz tekst",
    noTextProvided: "Nie podano tekstu",
    textNotFound: "Tekst nie został znaleziony lub wygasł",
    textCopied: "Tekst skopiowany do schowka",
    failedToCopy: "Nie udało się skopiować tekstu do schowka",
    noTextToCopy: "Brak tekstu do skopiowania",
    failedToOpen: "Nie udało się otworzyć wyboru tekstu. Spróbuj ponownie.",
  },

    markdown: {
      // Markdown copy functionality
      codeCopied: "Kod skopiowany",
      copyFailed: "Błąd kopiowania",
      mermaidRenderFailed: "Nie udało się wyświetlić diagramu mermaid",
      diffLabel: "Różnice",
      codeLabel: "Kod",
    },

  artifacts: {
    // Artifacts feature
    title: "Artefakty",
    countSingular: "1 artefakt",
    countPlural: ({ count }: { count: number }) => {
      const n = Math.abs(count);
      const n10 = n % 10;
      const n100 = n % 100;

      // Polish plural rules: 1 (singular), 2-4 (few), 5+ (many)
      if (n === 1) {
        return `${count} artefakt`;
      }
      if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) {
        return `${count} artefakty`;
      }
      return `${count} artefaktów`;
    },
    empty: "Brak artefaktów",
    emptyDescription: "Utwórz pierwszy artefakt, aby rozpocząć",
    new: "Nowy artefakt",
    edit: "Edytuj artefakt",
    delete: "Usuń",
    updateError: "Nie udało się zaktualizować artefaktu. Spróbuj ponownie.",
    deleteError: "Nie udało się usunąć artefaktu. Spróbuj ponownie.",
    notFound: "Artefakt nie został znaleziony",
    discardChanges: "Odrzucić zmiany?",
    discardChangesDescription:
      "Masz niezapisane zmiany. Czy na pewno chcesz je odrzucić?",
    deleteConfirm: "Usunąć artefakt?",
    deleteConfirmDescription: "Tej operacji nie można cofnąć",
    noContent: "Brak treści",
    untitled: "Bez tytułu",
    titleLabel: "TYTUŁ",
    titlePlaceholder: "Wprowadź tytuł dla swojego artefaktu",
    bodyLabel: "TREŚĆ",
    bodyPlaceholder: "Napisz swoją treść tutaj...",
    emptyFieldsError: "Proszę wprowadzić tytuł lub treść",
    createError: "Nie udało się utworzyć artefaktu. Spróbuj ponownie.",
    save: "Zapisz",
    saving: "Zapisywanie...",
    loading: "Ładowanie artefaktów...",
    error: "Nie udało się załadować artefaktu",
  },

  friends: {
    // Friends feature
    title: "Przyjaciele",
    sharedSessions: "Udostępnione sesje",
    noSharedSessions: "Brak udostępnionych sesji",
    manageFriends: "Zarządzaj swoimi przyjaciółmi i połączeniami",
    searchTitle: "Znajdź przyjaciół",
    pendingRequests: "Zaproszenia do znajomych",
    myFriends: "Moi przyjaciele",
    noFriendsYet: "Nie masz jeszcze żadnych przyjaciół",
    findFriends: "Znajdź przyjaciół",
    remove: "Usuń",
    pendingRequest: "Oczekujące",
    sentOn: ({ date }: { date: string }) => `Wysłano ${date}`,
    accept: "Akceptuj",
    reject: "Odrzuć",
    addFriend: "Dodaj do znajomych",
    alreadyFriends: "Już jesteście znajomymi",
    requestPending: "Zaproszenie oczekuje",
    searchInstructions: "Wprowadź nazwę użytkownika, aby znaleźć przyjaciół",
    searchPlaceholder: "Wprowadź nazwę użytkownika...",
    searching: "Szukanie...",
    userNotFound: "Nie znaleziono użytkownika",
    noUserFound: "Nie znaleziono użytkownika o tej nazwie",
    checkUsername: "Sprawdź nazwę użytkownika i spróbuj ponownie",
    howToFind: "Jak znaleźć przyjaciół",
    findInstructions:
      "Szukaj przyjaciół po nazwie użytkownika. W zależności od serwera możesz musieć połączyć dostawcę lub wybrać nazwę użytkownika, aby korzystać z Przyjaciół.",
    requestSent: "Zaproszenie do znajomych wysłane!",
    requestAccepted: "Zaproszenie do znajomych zaakceptowane!",
    requestRejected: "Zaproszenie do znajomych odrzucone",
    friendRemoved: "Przyjaciel usunięty",
    confirmRemove: "Usuń przyjaciela",
    confirmRemoveMessage: "Czy na pewno chcesz usunąć tego przyjaciela?",
    cannotAddYourself: "Nie możesz wysłać zaproszenia do siebie",
    bothMustHaveGithub:
      "Obaj użytkownicy muszą mieć połączonego wymaganego dostawcę, aby zostać przyjaciółmi",
    status: {
      none: "Nie połączono",
      requested: "Zaproszenie wysłane",
      pending: "Zaproszenie oczekuje",
      friend: "Przyjaciele",
      rejected: "Odrzucone",
    },
    acceptRequest: "Zaakceptuj zaproszenie",
    removeFriend: "Usuń z przyjaciół",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `Czy na pewno chcesz usunąć ${name} z przyjaciół?`,
    requestSentDescription: ({ name }: { name: string }) =>
      `Twoje zaproszenie do grona przyjaciół zostało wysłane do ${name}`,
    requestFriendship: "Wyślij zaproszenie do znajomych",
    cancelRequest: "Anuluj zaproszenie do znajomych",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `Anulować zaproszenie do znajomych wysłane do ${name}?`,
    denyRequest: "Odrzuć zaproszenie",
    nowFriendsWith: ({ name }: { name: string }) =>
      `Teraz jesteś w gronie znajomych z ${name}`,
    disabled: "Przyjaciele są wyłączeni na tym serwerze.",
    username: {
      required: "Wybierz nazwę użytkownika, aby używać Przyjaciół.",
      taken: "Ta nazwa użytkownika jest już zajęta.",
      invalid: "Ta nazwa użytkownika nie jest dozwolona.",
      disabled:
        "Przyjaciele z nazwą użytkownika nie są włączeni na tym serwerze.",
      preferredNotAvailable:
        "Twoja preferowana nazwa użytkownika jest niedostępna na tym serwerze. Wybierz inną.",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `Twoja preferowana nazwa użytkownika @${login} jest niedostępna na tym serwerze. Wybierz inną.`,
    },
    githubGate: {
      title: "Połącz GitHub, aby używać Przyjaciół",
      body: "Przyjaciele używają nazw użytkowników GitHub do wyszukiwania i udostępniania.",
      connect: "Połącz GitHub",
      notAvailable: "Nie działa?",
      notConfigured: "GitHub OAuth nie jest skonfigurowany na tym serwerze.",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `Połącz ${provider}, aby używać Przyjaciół`,
      body: ({ provider }: { provider: string }) =>
        `Przyjaciele używają nazw użytkowników ${provider} do wyszukiwania i udostępniania.`,
      connect: ({ provider }: { provider: string }) => `Połącz ${provider}`,
      notAvailable: "Nie działa?",
      notConfigured: ({ provider }: { provider: string }) =>
        `${provider} OAuth nie jest skonfigurowany na tym serwerze.`,
    },
  },

  usage: {
    // Usage panel strings
    today: "Dzisiaj",
    last7Days: "Ostatnie 7 dni",
    last30Days: "Ostatnie 30 dni",
    totalTokens: "Łącznie tokenów",
    totalCost: "Całkowity koszt",
    tokens: "Tokeny",
    cost: "Koszt",
    usageOverTime: "Użycie w czasie",
    byModel: "Według modelu",
    noData: "Brak danych o użyciu",
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} wysłał Ci zaproszenie do znajomych`,
    friendRequestGeneric: "Nowe zaproszenie do znajomych",
    friendAccepted: ({ name }: { name: string }) =>
      `Jesteś teraz znajomym z ${name}`,
    friendAcceptedGeneric: "Zaproszenie do znajomych zaakceptowane",
  },

  secrets: {
    addTitle: "Nowy sekret",
    savedTitle: "Zapisane sekrety",
    badgeReady: "Sekret",
    badgeRequired: "Wymagany sekret",
    missingForProfile: ({ env }: { env: string | null }) =>
      `Brak sekretu (${env ?? "sekret"}). Skonfiguruj go na maszynie lub wybierz/wpisz sekret.`,
    defaultForProfileTitle: "Domyślny sekret",
    defineDefaultForProfileTitle: "Ustaw domyślny sekret dla tego profilu",
    addSubtitle: "Dodaj zapisany sekret",
    noneTitle: "Brak",
    noneSubtitle: "Użyj środowiska maszyny lub wpisz sekret dla tej sesji",
    emptyTitle: "Brak zapisanych sekretów",
    emptySubtitle:
      "Dodaj jeden, aby używać profili z sekretem bez ustawiania zmiennych środowiskowych na maszynie.",
    savedHiddenSubtitle: "Zapisany (wartość ukryta)",
    defaultLabel: "Domyślny",
    fields: {
      name: "Nazwa",
      value: "Wartość",
    },
    placeholders: {
      nameExample: "np. Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "Nazwa jest wymagana.",
      valueRequired: "Wartość jest wymagana.",
    },
    actions: {
      replace: "Zastąp",
      replaceValue: "Zastąp wartość",
      setDefault: "Ustaw jako domyślny",
      unsetDefault: "Usuń domyślny",
    },
    prompts: {
      renameTitle: "Zmień nazwę sekretu",
      renameDescription: "Zaktualizuj przyjazną nazwę dla tego sekretu.",
      replaceValueTitle: "Zastąp wartość sekretu",
      replaceValueDescription:
        "Wklej nową wartość sekretu. Ta wartość nie będzie ponownie wyświetlana po zapisaniu.",
      deleteTitle: "Usuń sekret",
      deleteConfirm: ({ name }: { name: string }) =>
        `Usunąć “${name}”? Tej czynności nie można cofnąć.`,
    },
  },

  profiles: {
    // Profile management feature
    title: "Profile",
    subtitle: "Zarządzaj profilami zmiennych środowiskowych dla sesji",
    sessionUses: ({ profile }: { profile: string }) =>
      `Ta sesja używa: ${profile}`,
    profilesFixedPerSession:
      "Profile są stałe dla sesji. Aby użyć innego profilu, rozpocznij nową sesję.",
    noProfile: "Brak Profilu",
    noProfileDescription: "Użyj domyślnych ustawień środowiska",
    defaultModel: "Domyślny Model",
    addProfile: "Dodaj Profil",
    profileName: "Nazwa Profilu",
    enterName: "Wprowadź nazwę profilu",
    baseURL: "Adres URL",
    authToken: "Token Autentykacji",
    enterToken: "Wprowadź token autentykacji",
    model: "Model AI",
    tmuxSession: "Sesja Tmux",
    enterTmuxSession: "Wprowadź nazwę sesji tmux",
    tmuxTempDir: "Katalog tymczasowy Tmux",
    enterTmuxTempDir: "Wprowadź ścieżkę do katalogu tymczasowego",
    tmuxUpdateEnvironment: "Aktualizuj środowisko automatycznie",
    nameRequired: "Nazwa profilu jest wymagana",
    deleteConfirm: ({ name }: { name: string }) =>
      `Czy na pewno chcesz usunąć profil "${name}"?`,
    editProfile: "Edytuj Profil",
    addProfileTitle: "Dodaj Nowy Profil",
    builtIn: "Wbudowane",
    custom: "Niestandardowe",
    builtInSaveAsHint:
      "Zapisanie wbudowanego profilu tworzy nowy profil niestandardowy.",
    builtInNames: {
      anthropic: "Anthropic (Domyślny)",
      deepseek: "DeepSeek (Reasoner)",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (Default)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Default)",
      geminiApiKey: "Gemini (API key)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "Ulubione",
      custom: "Twoje profile",
      builtIn: "Profile wbudowane",
    },
    actions: {
      viewEnvironmentVariables: "Zmienne środowiskowe",
      addToFavorites: "Dodaj do ulubionych",
      removeFromFavorites: "Usuń z ulubionych",
      editProfile: "Edytuj profil",
      duplicateProfile: "Duplikuj profil",
      deleteProfile: "Usuń profil",
    },
    copySuffix: "(Kopia)",
    duplicateName: "Profil o tej nazwie już istnieje",
    setupInstructions: {
      title: "Instrukcje konfiguracji",
      viewCloudGuide: "Zobacz oficjalny przewodnik konfiguracji",
    },
    machineLogin: {
      title: "Wymagane logowanie na maszynie",
      subtitle:
        "Ten profil korzysta z pamięci podręcznej logowania CLI na wybranej maszynie.",
      status: {
        loggedIn: "Zalogowano",
        notLoggedIn: "Nie zalogowano",
      },
      claudeCode: {
        title: "Claude Code",
        instructions:
          "Uruchom `claude`, a następnie wpisz `/login`, aby się zalogować.",
        warning:
          "Uwaga: ustawienie `ANTHROPIC_AUTH_TOKEN` zastępuje logowanie CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Uruchom `codex login`, aby się zalogować.",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "Uruchom `gemini auth`, aby się zalogować.",
      },
    },
    requirements: {
      secretRequired: "Sekret",
      configured: "Skonfigurowano na maszynie",
      notConfigured: "Nie skonfigurowano",
      checking: "Sprawdzanie…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `Ten profil wymaga skonfigurowania ${env} na maszynie.`,
      modalTitle: "Wymagany sekret",
      modalBody:
        "Ten profil wymaga sekretu.\n\nDostępne opcje:\n• Użyj środowiska maszyny (zalecane)\n• Użyj zapisanego sekretu z ustawień aplikacji\n• Wpisz sekret tylko dla tej sesji",
      sectionTitle: "Wymagania",
      sectionSubtitle:
        "Te pola służą do wstępnej weryfikacji i aby uniknąć niespodziewanych błędów.",
      secretEnvVarPromptDescription:
        "Wpisz nazwę wymaganej tajnej zmiennej środowiskowej (np. OPENAI_API_KEY).",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `Ten profil wymaga ${env}. Wybierz jedną z opcji poniżej.`,
      modalHelpGeneric:
        "Ten profil wymaga sekretu. Wybierz jedną z opcji poniżej.",
      chooseOptionTitle: "Wybierz opcję",
      machineEnvStatus: {
        theMachine: "maszynie",
        checkFor: ({ env }: { env: string }) => `Sprawdź ${env}`,
        checking: ({ env }: { env: string }) => `Sprawdzanie ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${env} znaleziono na ${machine}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${env} nie znaleziono na ${machine}`,
      },
      machineEnvSubtitle: {
        checking: "Sprawdzanie środowiska daemona…",
        found: "Znaleziono w środowisku daemona na maszynie.",
        notFound:
          "Ustaw w środowisku daemona na maszynie i uruchom ponownie daemona.",
      },
      options: {
        none: {
          title: "Brak",
          subtitle: "Nie wymaga sekretu ani logowania CLI.",
        },
        machineLogin: {
          subtitle: "Wymaga zalogowania przez CLI na maszynie docelowej.",
          longSubtitle:
            "Wymaga zalogowania w CLI dla wybranego backendu AI na maszynie docelowej.",
        },
        useMachineEnvironment: {
          title: "Użyj środowiska maszyny",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `Użyj ${env} ze środowiska daemona.`,
          subtitleGeneric: "Użyj sekretu ze środowiska daemona.",
        },
        useSavedSecret: {
          title: "Użyj zapisanego sekretu",
          subtitle: "Wybierz (lub dodaj) zapisany sekret w aplikacji.",
        },
        enterOnce: {
          title: "Wpisz sekret",
          subtitle: "Wklej sekret tylko dla tej sesji (nie zostanie zapisany).",
        },
      },
      secretEnvVar: {
        title: "Zmienna środowiskowa sekretu",
        subtitle:
          "Wpisz nazwę zmiennej środowiskowej, której ten dostawca oczekuje dla sekretu (np. OPENAI_API_KEY).",
        label: "Nazwa zmiennej środowiskowej",
      },
      sections: {
        machineEnvironment: "Środowisko maszyny",
        useOnceTitle: "Użyj raz",
        useOnceLabel: "Wprowadź sekret",
        useOnceFooter:
          "Wklej sekret tylko dla tej sesji. Nie zostanie zapisany.",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "Rozpocznij z kluczem już obecnym na maszynie.",
        },
        useOnceButton: "Użyj raz (tylko sesja)",
      },
    },
    defaultSessionType: "Domyślny typ sesji",
    defaultPermissionMode: {
      title: "Domyślny tryb uprawnień",
      descriptions: {
        default: "Pytaj o uprawnienia",
        acceptEdits: "Automatycznie zatwierdzaj edycje",
        plan: "Zaplanuj przed wykonaniem",
        bypassPermissions: "Pomiń wszystkie uprawnienia",
      },
    },
    defaultPermissions: {
      title: "Domyślne uprawnienia",
      footer:
        "Nadpisuje domyślne uprawnienia na poziomie konta dla nowych sesji, gdy ten profil jest wybrany.",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `Domyślne dla konta: ${label}`,
      useAccountDefault: "Użyj domyślnego konta",
      currently: ({ label }: { label: string }) => `Aktualnie: ${label}`,
    },
    aiBackend: {
      title: "Backend AI",
      selectAtLeastOneError: "Wybierz co najmniej jeden backend AI.",
      claudeSubtitle: "CLI Claude",
      codexSubtitle: "CLI Codex",
      opencodeSubtitle: "CLI OpenCode",
      geminiSubtitleExperimental: "CLI Gemini (eksperymentalne)",
      auggieSubtitle: "Auggie CLI",
      qwenSubtitleExperimental: "Qwen Code CLI (eksperymentalne)",
      kimiSubtitleExperimental: "Kimi CLI (eksperymentalne)",
      kiloSubtitleExperimental: "Kilo CLI (eksperymentalne)",
      piSubtitleExperimental: "Pi CLI (eksperymentalne)",
      copilotSubtitleExperimental: "GitHub Copilot CLI (eksperymentalne)",
    },
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Uruchamiaj sesje w Tmux",
      spawnSessionsEnabledSubtitle:
        "Sesje uruchamiają się w nowych oknach tmux.",
      spawnSessionsDisabledSubtitle:
        "Sesje uruchamiają się w zwykłej powłoce (bez integracji z tmux)",
      isolatedServerTitle: "Izolowany serwer tmux",
      isolatedServerEnabledSubtitle:
        "Uruchamiaj sesje w izolowanym serwerze tmux (zalecane).",
      isolatedServerDisabledSubtitle:
        "Uruchamiaj sesje w domyślnym serwerze tmux.",
      sessionNamePlaceholder: "Puste = bieżąca/najnowsza sesja",
      tempDirPlaceholder: "Pozostaw puste, aby wygenerować automatycznie",
    },
    previewMachine: {
      title: "Podgląd maszyny",
      itemTitle: "Maszyna podglądu dla zmiennych środowiskowych",
      selectMachine: "Wybierz maszynę",
      resolveSubtitle:
        "Służy tylko do podglądu rozwiązanych wartości poniżej (nie zmienia tego, co zostanie zapisane).",
      selectSubtitle:
        "Wybierz maszynę, aby podejrzeć rozwiązane wartości poniżej.",
    },
    environmentVariables: {
      title: "Zmienne środowiskowe",
      addVariable: "Dodaj zmienną",
      namePlaceholder: "Nazwa zmiennej (np. MY_CUSTOM_VAR)",
      valuePlaceholder: "Wartość (np. my-value lub ${MY_VAR})",
      validation: {
        nameRequired: "Wprowadź nazwę zmiennej.",
        invalidNameFormat:
          "Nazwy zmiennych muszą zawierać wielkie litery, cyfry i podkreślenia oraz nie mogą zaczynać się od cyfry.",
        duplicateName: "Taka zmienna już istnieje.",
      },
      card: {
        valueLabel: "Wartość:",
        fallbackValueLabel: "Wartość fallback:",
        valueInputPlaceholder: "Wartość",
        defaultValueInputPlaceholder: "Wartość domyślna",
        fallbackDisabledForVault:
          "Fallback jest wyłączony podczas używania sejfu sekretów.",
        secretNotRetrieved:
          "Wartość sekretna - nie jest pobierana ze względów bezpieczeństwa",
        secretToggleLabel: "Ukryj wartość w UI",
        secretToggleSubtitle:
          "Ukrywa wartość w UI i nie pobiera jej z maszyny na potrzeby podglądu.",
        secretToggleEnforcedByDaemon: "Wymuszone przez daemon",
        secretToggleEnforcedByVault: "Wymuszone przez sejf sekretów",
        secretToggleResetToAuto: "Przywróć automatyczne",
        requirementRequiredLabel: "Wymagane",
        requirementRequiredSubtitle:
          "Blokuje tworzenie sesji, jeśli zmienna jest brakująca.",
        requirementUseVaultLabel: "Użyj sejfu sekretów",
        requirementUseVaultSubtitle:
          "Użyj zapisanego sekretu (bez wartości fallback).",
        defaultSecretLabel: "Domyślny sekret",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `Nadpisywanie udokumentowanej wartości domyślnej: ${expectedValue}`,
        useMachineEnvToggle: "Użyj wartości ze środowiska maszyny",
        resolvedOnSessionStart:
          "Rozwiązywane podczas uruchamiania sesji na wybranej maszynie.",
        sourceVariableLabel: "Zmienna źródłowa",
        sourceVariablePlaceholder: "Nazwa zmiennej źródłowej (np. Z_AI_MODEL)",
        checkingMachine: ({ machine }: { machine: string }) =>
          `Sprawdzanie ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `Pusto na ${machine}`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Pusto na ${machine} (używam fallback)`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `Nie znaleziono na ${machine}`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `Nie znaleziono na ${machine} (używam fallback)`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `Znaleziono wartość na ${machine}`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `Różni się od udokumentowanej wartości: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - ukryte ze względów bezpieczeństwa`,
        hiddenValue: "***ukryte***",
        emptyValue: "(puste)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `Sesja otrzyma: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `Zmienne środowiskowe · ${profileName}`,
        descriptionPrefix:
          "Te zmienne środowiskowe są wysyłane podczas uruchamiania sesji. Wartości są rozwiązywane przez daemon na",
        descriptionFallbackMachine: "wybranej maszynie",
        descriptionSuffix: ".",
        emptyMessage:
          "Dla tego profilu nie ustawiono zmiennych środowiskowych.",
        checkingSuffix: "(sprawdzanie…)",
        detail: {
          fixed: "Stała",
          machine: "Maszyna",
          checking: "Sprawdzanie",
          fallback: "Wartość zapasowa",
          missing: "Brak",
        },
      },
    },
    delete: {
      title: "Usuń Profil",
      message: ({ name }: { name: string }) =>
        `Czy na pewno chcesz usunąć "${name}"? Tej czynności nie można cofnąć.`,
      confirm: "Usuń",
      cancel: "Anuluj",
    },
  },
} as const;

export type TranslationsPl = typeof pl;
