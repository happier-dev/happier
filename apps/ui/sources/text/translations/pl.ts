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
    title: "Runs",
    empty: "No runs yet.",
  },

  common: {
    // Simple string constants
    add: "Dodaj",
    actions: "Akcje",
    cancel: "Anuluj",
    close: "Zamknij",
    authenticate: "Uwierzytelnij",
    save: "Zapisz",
    saveAs: "Zapisz jako",
    error: "Błąd",
    success: "Sukces",
    ok: "OK",
    continue: "Kontynuuj",
    back: "Wstecz",
    create: "Utwórz",
    rename: "Zmień nazwę",
    remove: "Remove",
    signOut: "Sign out",
    keep: "Keep",
    reset: "Resetuj",
    logout: "Wyloguj",
    yes: "Tak",
    no: "Nie",
    discard: "Odrzuć",
    discardChanges: "Odrzuć zmiany",
    unsavedChangesWarning: "Masz niezapisane zmiany.",
    keepEditing: "Kontynuuj edycję",
    version: "Wersja",
    details: "Szczegóły",
    copied: "Skopiowano",
    copy: "Kopiuj",
    scanning: "Skanowanie...",
    urlPlaceholder: "https://example.com",
    home: "Główna",
    message: "Wiadomość",
    send: "Wyślij",
    files: "Pliki",
    fileViewer: "Przeglądarka plików",
    loading: "Ładowanie...",
    retry: "Ponów",
    or: "lub",
    delete: "Usuń",
    optional: "opcjonalnie",
    noMatches: "Brak dopasowań",
    all: "Wszystko",
    machine: "maszyna",
    clearSearch: "Wyczyść wyszukiwanie",
    refresh: "Odśwież",
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
    status: "Status",
  },

  status: {
    connected: "połączono",
    connecting: "łączenie",
    disconnected: "rozłączono",
    error: "błąd",
    online: "w sieci",
    offline: "poza siecią",
    lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
    permissionRequired: "wymagane uprawnienie",
    activeNow: "Aktywny teraz",
    unknown: "nieznane",
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
    openMachine: "Otwórz maszynę",
    terminalUrlPlaceholder: "happier://terminal?...",
    restoreQrInstructions:
      "1. Otwórz Happier na urządzeniu mobilnym\n2. Przejdź do Ustawienia → Konto\n3. Dotknij „Połącz nowe urządzenie”\n4. Zeskanuj ten kod QR",
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
    },
  },

  settings: {
    title: "Ustawienia",
    connectedAccounts: "Połączone konta",
    connectedAccountsDisabled: "Connected services are disabled.",
    connectAccount: "Połącz konto",
    github: "GitHub",
    machines: "Maszyny",
    features: "Funkcje",
    social: "Społeczność",
    account: "Konto",
    accountSubtitle: "Zarządzaj szczegółami konta",
    appearance: "Wygląd",
    appearanceSubtitle: "Dostosuj wygląd aplikacji",
    voiceAssistant: "Asystent głosowy",
    voiceAssistantSubtitle: "Konfiguruj preferencje interakcji głosowej",
    memorySearch: "Lokalne wyszukiwanie pamięci",
    memorySearchSubtitle: "Szukaj w poprzednich rozmowach (lokalnie na urządzeniu)",
    featuresTitle: "Funkcje",
    featuresSubtitle: "Włącz lub wyłącz funkcje aplikacji",
    developer: "Deweloper",
    developerTools: "Narzędzia deweloperskie",
    about: "O aplikacji",
    aboutFooter:
      "Happier Coder to mobilny klient Codex i Claude Code. Jest w pełni szyfrowany end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu. Nie jest powiązany z Anthropic.",
    whatsNew: "Co nowego",
    whatsNewSubtitle: "Zobacz najnowsze aktualizacje i ulepszenia",
    reportIssue: "Zgłoś problem",
    privacyPolicy: "Polityka prywatności",
    termsOfService: "Warunki użytkowania",
    eula: "EULA",
    supportUs: "Wesprzyj nas",
    supportUsSubtitlePro: "Dziękujemy za wsparcie!",
    supportUsSubtitle: "Wesprzyj rozwój projektu",
    scanQrCodeToAuthenticate: "Zeskanuj kod QR, aby się uwierzytelnić",
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
    terminal: "Terminal",
    session: "Sesja",
    sessionSubtitleTmuxEnabled: "Tmux włączony",
    sessionSubtitleMessageSendingAndTmux: "Wysyłanie wiadomości i tmux",
    servers: "Serwery",
    serversSubtitle: "Zapisane serwery, grupy i ustawienia domyślne",

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

  settingsProviders: {
    title: "Ustawienia dostawcy AI",
    entrySubtitle: "Skonfiguruj opcje specyficzne dla dostawcy",
    footer:
      "Skonfiguruj opcje specyficzne dla dostawcy. Te ustawienia mogą wpływać na zachowanie sesji.",
    providerSubtitle: "Ustawienia specyficzne dla dostawcy",
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
    expScmOperations: "Operacje kontroli wersji",
    expScmOperationsSubtitle:
      "Włącz eksperymentalne operacje zapisu kontroli wersji (stage/commit/push/pull)",
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
    voice: "Głos",
    voiceSubtitle: "Włącz funkcje głosowe",
    expVoiceAgent: "Voice agent",
    expVoiceAgentSubtitle: "Enable daemon-backed voice agent surfaces (requires execution runs)",
    expConnectedServices: "Connected services",
    expConnectedServicesSubtitle: "Enable connected services settings and session bindings",
    expConnectedServicesQuotas: "Connected services quotas",
    expConnectedServicesQuotasSubtitle: "Show quota badges and usage meters for connected services",
    expMemorySearch: "Memory search",
    expMemorySearchSubtitle: "Enable local memory search screens and settings",
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
    historyScope: "Message history",
    historyScopePerSession: "Cycle history per terminal",
    historyScopeGlobal: "Cycle history across all terminals",
    historyScopeModalTitle: "Message history",
    historyScopeModalMessage:
      "Choose whether ArrowUp/ArrowDown cycles through messages sent in this terminal only, or across all terminals.",
    historyScopePerSessionOption: "Per terminal",
    historyScopeGlobalOption: "Global",
    commandPalette: "Paleta poleceń",
    commandPaletteEnabled: "Naciśnij ⌘K, aby otworzyć",
    commandPaletteDisabled: "Szybki dostęp do poleceń wyłączony",
    markdownCopyV2: "Kopiowanie Markdown v2",
    markdownCopyV2Subtitle: "Długie naciśnięcie otwiera modal kopiowania",
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
    environmentBadge: "Environment badge",
    environmentBadgeSubtitle:
      "Show a small badge next to the Happier title indicating the current app environment",
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
      title: "Codex resume",
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
    resuming: "Wznawianie...",
    resumeFailed: "Nie udało się wznowić sesji",
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

  voiceAssistant: {
    connecting: "Łączenie...",
    active: "Asystent głosowy aktywny",
    connectionError: "Błąd połączenia",
    label: "Asystent głosowy",
    tapToEnd: "Dotknij, aby zakończyć",
  },

  voiceSurface: {
    start: "Start",
    stop: "Stop",
    selectSessionToStart: "Wybierz sesje, aby uruchomic glos",
    targetSession: "Sesja docelowa",
    noTarget: "Nie wybrano sesji",
    clearTarget: "Wyczysc cel",
  },

  voiceActivity: {
    title: "Aktywnosc glosowa",
    empty: "Brak aktywnosci glosowej.",
    clear: "Wyczysc",
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
    searchOrAddPlaceholder: "Szukaj lub dodaj tagi",
    editTagsLabel: "Edytuj tagi",
    noTagsFound: "Brak tagów",
    newTagItem: "Nowy tag…",
    newTagTitle: "Nowy tag",
    newTagMessage: "Wpisz nazwę nowego tagu.",
    newTagConfirm: "Dodaj",
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
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
    copilotSessionId: "Copilot Session ID",
    copilotSessionIdCopied: "Copilot Session ID copied to clipboard",
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
    pinSession: "Przypnij sesję",
    unpinSession: "Odepnij sesję",
    copyResumeCommand: "Kopiuj komendę wznowienia",
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
    host: "Host",
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
      on: "Indexing on",
      off: "Indexing off",
    },
    model: {
      title: "MODEL",
      configureInCli: "Skonfiguruj modele w ustawieniach CLI",
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
    taskView: {
      initializing: "Inicjalizacja agenta...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} ${plural({ count, one: "więcej narzędzie", few: "więcej narzędzia", many: "więcej narzędzi" })}`,
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `Edycja ${index} z ${total}`,
      replaceAll: "Zamień wszystkie",
    },
    names: {
      task: "Zadanie",
      terminal: "Terminal",
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
      viewDiff: "Diff",
      turnDiff: "Turn diff",
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
    detachedHead: "odłączony HEAD",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
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
    notRepo: "To nie jest repozytorium kontroli wersji",
    notUnderSourceControl: "Ten katalog nie jest pod kontrolą wersji",
    searching: "Wyszukiwanie plików...",
	    noFilesFound: "Nie znaleziono plików",
	    noFilesInProject: "Brak plików w projekcie",
	    repositoryFolderLoadFailed: "Nie można wczytać folderu",
	    repositoryCollapseAll: "Zwiń wszystko",
	    reviewFilterPlaceholder: "Filtruj pliki...",
	    reviewNoMatches: "Brak dopasowań",
	    reviewLargeDiffOneAtATime: "Wykryto duży diff; pokazuję po jednym pliku.",
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
    loadingFile: ({ fileName }: { fileName: string }) =>
      `Ładowanie ${fileName}...`,
    binaryFile: "Plik binarny",
    cannotDisplayBinary: "Nie można wyświetlić zawartości pliku binarnego",
    diff: "Różnice",
    file: "Plik",
    fileEmpty: "Plik jest pusty",
    noChanges: "Brak zmian do wyświetlenia",
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
        autoTitle: "Auto",
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
          autoTitle: "Auto",
          autoSubtitle: "Pozwol na automatyczne fragmenty (szum).",
        },
      },
    },
    byo: {
      title: "Użyj mojego ElevenLabs",
      configured:
        "Skonfigurowano. Użycie głosu będzie rozliczane na Twoim koncie ElevenLabs.",
      notConfigured:
        "Wpisz swój klucz API ElevenLabs i ID agenta, aby używać głosu bez subskrypcji.",
      createAccount: "Utwórz konto ElevenLabs",
      createAccountSubtitle:
        "Zarejestruj się (lub zaloguj) przed utworzeniem klucza API",
      openApiKeys: "Open ElevenLabs API keys",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "How to create an API key",
      apiKeyHelpSubtitle:
        "Step-by-step help for creating and copying your ElevenLabs API key",
      apiKeyHelpDialogTitle: "Create an ElevenLabs API key",
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
      conversationMode: "Tryb rozmowy",
      conversationModeSubtitle:
        "Bezpośrednio do sesji lub agent głosowy z jawnym commitem",
      mediatorBackend: "Backend agenta głosowego",
      mediatorBackendSubtitle:
        "Daemon (używa backendu Happier) lub OpenAI-compatible HTTP",
      mediatorBackendDaemon: "Daemon",
      mediatorBackendOpenAi: "OpenAI-compatible HTTP",
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
      chatBaseUrl: "Chat Base URL",
      chatBaseUrlTitle: "Chat Base URL",
      chatBaseUrlDescription:
        "Bazowy URL do endpointu chat completion kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      chatApiKey: "Chat API Key",
      chatApiKeyTitle: "Chat API Key",
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
      chatTemperature: "Chat temperature",
      chatTemperatureSubtitle: "Kontroluje losowość (0–2)",
      chatTemperatureTitle: "Chat temperature",
      chatTemperatureDescription: "Wpisz liczbę od 0 do 2.",
      chatTemperatureInvalid: "Wpisz liczbę od 0 do 2.",
      chatMaxTokens: "Chat max tokens",
      chatMaxTokensSubtitle: "Limit długości odpowiedzi (puste = domyślne)",
      chatMaxTokensTitle: "Chat max tokens",
      chatMaxTokensDescription:
        "Wpisz dodatnią liczbę całkowitą lub zostaw puste dla domyślnej.",
      chatMaxTokensPlaceholder: "Puste = domyślne",
      chatMaxTokensUnlimited: "Domyślne",
      chatMaxTokensInvalid: "Wpisz dodatnią liczbę lub zostaw puste.",
      sttBaseUrl: "STT Base URL",
      sttBaseUrlTitle: "STT Base URL",
      sttBaseUrlDescription:
        "Bazowy URL do endpointu transkrypcji kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      sttApiKey: "STT API Key",
      sttApiKeyTitle: "STT API Key",
      sttApiKeyDescription:
        "Opcjonalny klucz API dla serwera STT (przechowywany zaszyfrowany). Zostaw puste, aby wyczyścić.",
      sttModel: "Model STT",
      sttModelSubtitle: "Nazwa modelu wysyłana w żądaniach transkrypcji",
      sttModelTitle: "Model STT",
      sttModelDescription:
        "Nazwa modelu wysyłana do serwera STT (pole kompatybilne z OpenAI).",
      deviceStt: "Device STT (experimental)",
      deviceSttSubtitle:
        "Use on-device speech recognition instead of an OpenAI-compatible endpoint",
      ttsBaseUrl: "TTS Base URL",
      ttsBaseUrlTitle: "TTS Base URL",
      ttsBaseUrlDescription:
        "Bazowy URL do endpointu mowy kompatybilnego z OpenAI (zwykle kończy się na /v1).",
      ttsApiKey: "TTS API Key",
      ttsApiKeyTitle: "TTS API Key",
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

      autoSpeak: "Automatycznie odtwarzaj odpowiedzi",
      autoSpeakSubtitle:
        "Odtwarzaj następną odpowiedź asystenta po wysłaniu wiadomości głosowej",
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
      shareDeviceInventory: "Share device inventory",
      shareDeviceInventorySubtitle: "Allow voice to list recent workspaces, machines, and servers",
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
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "Informacje o koncie",
    status: "Status",
    statusActive: "Aktywny",
    statusNotAuthenticated: "Nie uwierzytelniony",
    anonymousId: "ID anonimowe",
    publicId: "ID publiczne",
    notAvailable: "Niedostępne",
    linkNewDevice: "Połącz nowe urządzenie",
    linkNewDeviceSubtitle: "Zeskanuj kod QR, aby połączyć urządzenie",
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
    dangerZone: "Strefa niebezpieczna",
    logout: "Wyloguj",
    logoutSubtitle: "Wyloguj się i wyczyść dane lokalne",
    logoutConfirm:
      "Czy na pewno chcesz się wylogować? Upewnij się, że masz kopię zapasową klucza tajnego!",
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
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "Połącz terminal",
    linkNewDevice: "Połącz nowe urządzenie",
    restoreWithSecretKey: "Przywróć kluczem tajnym",
    whatsNew: "Co nowego",
    friends: "Przyjaciele",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Mobilny klient Codex i Claude Code",
    subtitle:
      "Szyfrowanie end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu.",
    createAccount: "Utwórz konto",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `Kontynuuj z ${provider}`,
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
    daemon: "Demon",
    status: "Status",
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
	      removeMachine: "Remove Machine",
	      removeMachineSubtitle:
	        "Revokes this machine and removes it from your account.",
	      removeMachineConfirmBody:
	        "This will revoke access from this machine (including access keys and automation assignments). You can reconnect later by signing in again from the CLI.",
	      removeMachineAlreadyRemoved:
	        "This machine has already been removed from your account.",
	    },
	    lastKnownPid: "Ostatni znany PID",
	    lastKnownHttpPort: "Ostatni znany port HTTP",
	    startedAt: "Uruchomiony o",
	    cliVersion: "Wersja CLI",
    daemonStateVersion: "Wersja stanu daemon",
    activeSessions: ({ count }: { count: number }) =>
      `Aktywne sesje (${count})`,
    machineGroup: "Maszyna",
    host: "Host",
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
    model: "Model",
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
      copilotSubtitleExperimental: "GitHub Copilot CLI (experimental)",
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
