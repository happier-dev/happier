import type { TranslationStructure } from "../_types";

const mcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle: 'Utwórz serwer, zaimportuj JSON hosta albo zainstaluj zalecany preset.',
  mcpServersHeroSubtitle: ({ configuredCount }: { configuredCount: number }) => `${configuredCount} skonfigurowano w Happier`,
  mcpServersHeroSubtitleEmpty: 'Utwórz serwery raz, sprawdź, gdzie mają zastosowanie, i zaimportuj to, czego już używają inne narzędzia.',
  mcpServersSegmentConfigured: 'Skonfigurowane',
  mcpServersSegmentConfiguredSubtitle: 'Twój katalog Happier',
  mcpServersSegmentDetected: 'Wykryte',
  mcpServersSegmentDetectedSubtitle: 'Znalezione w plikach konfiguracyjnych dostawcy',
  mcpServersSegmentPreview: 'Podgląd',
  mcpServersSegmentPreviewSubtitle: 'To otrzyma ta sesja',
  mcpServersAdvancedTitle: 'Zaawansowane',
  mcpServersAdvancedSubtitle: 'Tryb ścisły i zachowanie walidacji',
  mcpServersDetectedDirectoryTitle: 'Katalog projektu',
  mcpServersDetectedDirectorySubtitle: 'Opcjonalna ścieżka workspace dla konfiguracji na poziomie projektu',
  mcpServersDetectedDirectoryPlaceholder: '/ścieżka/do/projektu',
  mcpServersPreviewAgentTitle: 'Zaplecze',
  mcpServersPreviewMachineTitle: 'Maszyna',
  mcpServersPreviewDeliveryTitle: 'Dostarczanie narzędzi',
  mcpServersPreviewDirectoryTitle: 'Katalog workspace',
  mcpServersPreviewDirectorySubtitle: 'Wybierz folder, w którym planujesz rozpocząć sesję',
  mcpServersPreviewDirectoryPlaceholder: '/ścieżka/do/workspace',
  mcpServersPreviewRefreshTitle: 'Odśwież podgląd',
  mcpServersPreviewRefreshSubtitle: 'Rozwiąż serwery MCP Happier i natywne serwery MCP dostawcy dla tego kontekstu',
  mcpServersPreviewEmptyTitle: 'Brak podglądu',
  mcpServersPreviewEmptySubtitle: 'Wybierz backend, maszynę i katalog, a potem odśwież, aby sprawdzić rzeczywisty zestaw MCP.',
  mcpServersPreviewDirectoryRequired: 'Wybierz katalog, aby wyświetlić podgląd tej sesji.',
  mcpServersBuiltInDescription: 'Zawsze dostępne w sesjach Happier.',
  mcpServersSourceHappier: 'Happier',
  mcpServersSourceBuiltIn: 'Wbudowane',
  mcpServersSourceDetected: 'Wykryte',
  mcpServersQuickInstallTitle: 'Szybka instalacja',
  mcpServersQuickInstallSubtitle: 'Zainstaluj popularne serwery MCP dla deweloperów jednym krokiem.',
  mcpServersQuickInstallAction: 'Zainstaluj',
  mcpServersQuickInstallEmptyTitle: 'Wybierz preset',
  mcpServersQuickInstallEmptySubtitle: 'Wybierz jeden z zalecanych serwerów MCP, aby kontynuować.',
  mcpServersEditAction: 'Edytuj',
  mcpServersDeleteAction: 'Usuń',
  mcpServersAddServerFlowSubtitle: 'Skonfiguruj serwer ręcznie, zaimportuj JSON hosta albo zacznij od wybranego presetu.',
  mcpServersAddFlowConfigureTitle: 'Konfiguruj',
  mcpServersAddFlowConfigureSubtitle: 'Ręczna konfiguracja',
  mcpServersAddFlowImportJsonTitle: 'Importuj JSON',
  mcpServersAddFlowImportJsonSubtitle: 'Wklej konfigurację hosta',
  mcpServersAddFlowQuickInstallTitle: 'Szybka instalacja',
  mcpServersAddFlowQuickInstallSubtitle: 'Wybrane presety',
  mcpServersFieldCommandLine: 'Wiersz polecenia',
  mcpServersFieldCommandLinePlaceholder: 'npx -y @modelcontextprotocol/server-playwright',
  mcpServersTransportLocalTitle: 'Polecenie lokalne',
  mcpServersTransportLocalSubtitle: 'Uruchamia się na wybranej maszynie',
  mcpServersTransportHttpTitle: 'Zdalny HTTP',
  mcpServersTransportHttpSubtitle: 'Most z punktu końcowego HTTP',
  mcpServersTransportSseTitle: 'Zdalny SSE',
  mcpServersTransportSseSubtitle: 'Most ze zdarzeń wysyłanych przez serwer',
  mcpServersAdvancedCommandEditorTitle: 'Zaawansowany edytor poleceń',
  mcpServersAdvancedCommandEditorSubtitle: 'Podziel polecenie i argumenty ręcznie',
  mcpServersCancelSubtitle: 'Wyjdź bez zapisywania tego szkicu',
  mcpServersImportJsonTitle: 'Wklej JSON hosta MCP',
  mcpServersImportJsonSubtitle: 'Obsługujemy popularne formaty używane w README i hostach desktopowych.',
  mcpServersImportJsonPlaceholder: '{"mcpServers":{"podglad":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: 'Błąd importu',
  mcpServersImportJsonWarningsTitle: 'Ostrzeżenia importu',
  mcpServersImportJsonEmptyTitle: 'Nie przeanalizowano jeszcze serwerów',
  mcpServersImportJsonEmptySubtitle: 'Wklej JSON MCP hosta, aby podejrzeć serwery przed importem.',
  mcpServersImportJsonAction: 'Importuj serwery',
  mcpServersImportMappingSavedSecret: 'Użyj zapisanego sekretu',
  mcpServersImportMappingMachineEnv: 'Użyj zmiennych środowiskowych maszyny',
  mcpServersImportSecretNamePlaceholder: 'Nazwa zapisanego sekretu',
  mcpServersImportSecretValuePlaceholder: 'Wartość zapisanego sekretu',
  mcpServersImportMachineEnvPlaceholder: 'ENV_VAR_NAME',
  mcpServersImportMappingMissingSecretName: ({ input }: { input: string }) => `Podaj nazwę zapisanego sekretu dla ${input}.`,
  mcpServersImportMappingMissingSecretValue: ({ input }: { input: string }) => `Podaj wartość zapisanego sekretu dla ${input} albo przełącz na zmienne środowiskowe maszyny.`,
  mcpServersImportMappingMissingMachineEnvName: ({ input }: { input: string }) => `Podaj nazwę zmiennej środowiskowej maszyny dla ${input}.`,
  mcpServersAuthSavedSecret: 'Zapisany sekret',
  mcpServersAuthMachineEnv: 'Zmienne środowiskowe maszyny',
  mcpServersAuthPlainText: 'Zwykły tekst',
  mcpServersAuthUnknown: 'Nieznane uwierzytelnianie',
  mcpServersAuthNone: 'Brak uwierzytelniania',
  mcpServersScopeAllMachines: 'Wszystkie maszyny',
  mcpServersScopeMachine: 'Maszyna',
  mcpServersScopeWorkspace: 'Przestrzeń robocza',
  mcpServersScopeProviderProject: 'Konfiguracja projektu dostawcy',
  mcpServersScopeProviderUser: 'Konfiguracja użytkownika dostawcy',
  mcpServersScopeBuiltIn: 'Wbudowane',
  mcpServersStatusActive: 'Aktywny',
  mcpServersStatusAvailable: 'Dostępny',
  mcpServersStatusUnavailable: 'Niedostępny',
  mcpServersStatusDetected: ({ provider }: { provider: string }) => `Włączone w ${provider}`,
  mcpServersStatusDisabledInProvider: ({ provider }: { provider: string }) => `Wyłączone w ${provider}`,
  mcpServersEditorAppliesTo: 'Dotyczy',
  mcpServersEditorAppliesToSubtitle: 'Wybierz, gdzie Happier ma domyślnie dodawać ten serwer.',
  mcpServersAddApplyRule: 'Dodaj regułę dotyczy',
  mcpServersAddApplyRuleSubtitle: 'Wybierz, gdzie ten serwer ma być domyślnie stosowany.',
  mcpServersAddApplyRuleHelp: 'Zapisz tę regułę dotyczy, aby stała się częścią tej konfiguracji serwera.',
  mcpServersAddApplyRuleSave: 'Zapisz regułę dotyczy',
  mcpServersDeliveryNativeTitle: 'Natywny MCP',
  mcpServersDeliveryNativeSubtitle: 'Ten backend otrzymuje narzędzia Happier jako natywne serwery MCP.',
  mcpServersDeliveryShellBridgeTitle: 'Most powłoki Happier',
  mcpServersDeliveryShellBridgeSubtitle: 'Ten backend wywołuje narzędzia Happier przez most `happier tools`.',
  mcpServersDeliveryUnsupportedTitle: 'Nieobsługiwane',
  mcpServersDeliveryUnsupportedSubtitle: 'Ten backend obecnie nie otrzymuje narzędzi Happier.',
} as const;

const newSessionMcpTranslationExtension = {
  mcpChipLabel: 'MCP',
  mcpChipLabelWithCount: ({ count }: { count: number }) => `MCP ${count}`,
  mcpModalTitle: 'Serwery MCP',
  mcpModalSubtitle: ({ machineName, directory }: { machineName: string; directory: string }) =>
    `Podgląd serwerów MCP dostępnych na ${machineName} dla ${directory}.`,
  mcpManagedToggleTitle: 'Zarządzane serwery MCP',
  mcpManagedToggleSubtitle: 'Uwzględnij zarządzane serwery MCP, gdy są dostępne dla tej sesji.',
  mcpOpenSettingsTitle: 'Otwórz ustawienia MCP',
  mcpOpenSettingsSubtitle: 'Zarządzaj skonfigurowanymi serwerami, powiązaniami i opcjami importu.',
  mcpUnavailableNoContextTitle: 'Najpierw wybierz maszynę i katalog',
  mcpUnavailableNoContextSubtitle: 'Podgląd MCP wymaga zarówno maszyny docelowej, jak i katalogu roboczego.',
  mcpSelectedSectionTitle: 'Wybrane',
  mcpAvailableSectionTitle: 'Dostępne',
  mcpUnavailableSectionTitle: 'Niedostępne',
  mcpDetectedSectionTitle: 'Wykryte w konfiguracjach dostawców',
  mcpDetectedSectionTitleForAgent: ({ agentName }: { agentName: string }) => `Wykryte w konfiguracji ${agentName}`,
  mcpDetectedEmptyTitle: 'Brak wykrytych serwerów MCP',
  mcpDetectedEmptySubtitle: 'Odśwież, aby przeskanować pliki konfiguracyjne dostawcy na tej maszynie.',
  mcpDetectedUnsupportedTitle: 'Wykryte serwery MCP są niedostępne',
  mcpDetectedUnsupportedSubtitle: 'Zaktualizuj Happier na tej maszynie, aby włączyć skanowanie konfiguracji dostawcy.',
  mcpHappierSectionTitle: 'Serwery MCP Happier',
  mcpHappierEmptyTitle: 'Brak serwerów MCP zdefiniowanych w Happier',
  mcpHappierEmptySubtitle: 'Zdefiniuj serwery MCP w ustawieniach, aby używać ich w sesjach.',
  mcpReasonActiveByDefault: 'Dołączone domyślnie',
  mcpReasonForcedIncluded: 'Wymagane przez konfigurację',
  mcpReasonForcedExcluded: 'Wykluczone przez konfigurację',
  mcpReasonManagedDisabled: 'Zarządzane serwery MCP są wyłączone',
  mcpReasonBindingDisabled: 'Wyłączone przez powiązanie serwera',
  mcpReasonAvailablePortable: 'Zgodne z tą sesją',
  mcpReasonNotPortable: 'Niezgodne z tą sesją',
} as const;

const settingsAppearanceTranslationExtension = {
  sessionListDensity: {
    title: 'Gęstość listy sesji',
    subtitle: 'Wybierz, jak sesje są wyświetlane na pasku bocznym',
    detailed: 'Szczegółowa',
    detailedDescription: 'Pełnowymiarowe wiersze z awatarami i statusem',
    cozy: 'Pośrednia',
    cozyDescription: 'Mniejsze wiersze z awatarami',
    narrow: 'Wąska',
    narrowDescription: 'Minimalne wiersze bez awatarów',
  },
} as const;

const plAcpCatalogSettingsExtension = {
    acpCatalog: 'Backendy ACP',
    acpCatalogSubtitle: 'Zarządzaj wbudowanymi i własnymi backendami ACP',
    acpCatalogBuiltIn: 'Wbudowany ACP',
    acpCatalogBuiltInFooter:
        'Wbudowane ogólne agenty ACP są zdefiniowane we wspólnym katalogu i uruchamiane przez wspólne środowisko uruchomieniowe ACP.',
    acpCatalogBackends: 'Własne backendy',
    acpCatalogBackendsFooter:
        'Każdy własny backend to wybieralna definicja CLI zgodna z ACP, z własnym uruchamianiem, ustawieniami domyślnymi i konfiguracją uwierzytelniania.',
    acpCatalogBackendsEmptyTitle: 'Brak własnych backendów ACP',
    acpCatalogBackendsEmptySubtitle: 'Dodaj backend, aby utworzyć wybieralny własny backend ACP.',
    acpCatalogAddBackend: 'Dodaj backend ACP',
    acpCatalogAddBackendSubtitle: 'Utwórz własny backend ACP',
    acpCatalogBackendEditorTitle: 'Backend ACP',
    acpCatalogBasics: 'Podstawy',
    acpCatalogLauncher: 'Uruchamianie',
    acpCatalogEnv: 'Środowisko',
    acpCatalogAddEnv: 'Dodaj zmienną środowiskową',
    acpCatalogAddEnvSubtitle: 'Zapisuj wartości dosłowne lub podpinaj Zapisane Sekrety',
    acpCatalogEnvEmptyTitle: 'Brak zmiennych środowiskowych',
    acpCatalogEnvEmptySubtitle: 'Dodaj zmienne uruchomieniowe dla tego backendu.',
    acpCatalogAuth: 'Uwierzytelnianie',
    acpCatalogAuthSupport: 'Obsługa uwierzytelniania',
    acpCatalogAuthParser: 'Parser statusu',
    acpCatalogCapabilities: 'Możliwości',
    acpCatalogTransportProfile: 'Profil transportu',
    acpCatalogSupportsModes: 'Obsługuje tryby',
    acpCatalogSupportsModels: 'Obsługuje modele',
    acpCatalogSupportsConfigOptions: 'Obsługuje opcje konfiguracji',
    acpCatalogPromptImageSupport: 'Obsługa obrazów w promptach',
    acpCatalogFieldId: 'ID',
    acpCatalogFieldName: 'Nazwa',
    acpCatalogFieldTitle: 'Tytuł',
    acpCatalogFieldDescription: 'Opis',
    acpCatalogFieldCommand: 'Polecenie',
    acpCatalogFieldArgs: 'Argumenty (po jednym w wierszu)',
    acpCatalogMachineLoginKey: 'Klucz logowania maszyny',
    acpCatalogDocsUrl: 'Adres URL dokumentacji',
    acpCatalogLoginCommand: 'Polecenie logowania',
    acpCatalogLoginArgs: 'Argumenty logowania (po jednym w wierszu)',
    acpCatalogStatusCommand: 'Tokeny polecenia statusu (po jednym w wierszu)',
    acpCatalogDefaultMode: 'Tryb domyślny',
    acpCatalogDefaultModel: 'Model domyślny',
    acpCatalogDeleteBackendTitle: 'Usunąć backend ACP?',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `Usunąć "${name}"?`,
    acpCatalogValidationFailed: 'Ustawienia katalogu ACP są nieprawidłowe.',
} as const;

const acpCatalogTranslationExtension = {
  settings: plAcpCatalogSettingsExtension,
  newSession: {},
} as const;

const memoryEmbeddingsTranslationExtension = {
  status: {
    embeddingsTitle: 'Środowisko osadzeń',
    embeddingsProviderTitle: 'Dostawca osadzeń',
    embeddingsModelTitle: 'Model osadzeń',
    embeddingsDisabled: 'Osadzenia są wyłączone',
    embeddingsReady: 'Osadzenia są gotowe',
    embeddingsDownloading: 'Model osadzeń jest pobierany',
    embeddingsFallback: 'Osadzenia niedostępne, używany jest tryb tylko tekstowy',
    embeddingsUnavailable: 'Osadzenia niedostępne',
    embeddingsError: 'Nie udało się zainicjować osadzeń',
    embeddingsProviderLocal: 'Model lokalny',
    embeddingsProviderOpenAiCompatible: 'Punkt końcowy zgodny z OpenAI',
  },
  embeddings: {
    groupTitle: 'Osadzenia',
    groupFooter:
      'Opcjonalnie: popraw ranking głębokiego wyszukiwania za pomocą lokalnego modelu lub własnego punktu końcowego zgodnego z OpenAI.',
    mode: {
      title: 'Tryb osadzeń',
      options: {
        disabledTitle: 'Wyłączone',
        disabledSubtitle: 'Używaj tylko tekstowego rankingu dla głębokiego wyszukiwania',
        balancedTitle: 'Zrównoważony',
        balancedSubtitle: 'Szybki sprawdzony lokalny preset',
        longContextTitle: 'Długi kontekst',
        longContextSubtitle: 'Lepszy dla większych fragmentów rozmów',
        qualityTitle: 'Jakość',
        qualitySubtitle: 'Droższy lokalny preset do oceny',
        customTitle: 'Niestandardowy',
        customSubtitle: 'Wybierz własnego dostawcę i model',
      },
    },
    provider: {
      title: 'Dostawca',
      options: {
        localTitle: 'Model lokalny',
        localSubtitle: 'Zarządzany przez Happier i pobierany przy pierwszym użyciu',
        openAiCompatibleTitle: 'Punkt końcowy zgodny z OpenAI',
        openAiCompatibleSubtitle: 'Użyj własnego serwera osadzeń i klucza API',
      },
    },
    notSet: 'Nie ustawiono',
    secretSet: 'Ustawiono',
    secretNotSet: 'Nie ustawiono',
    queryPrefixTitle: 'Prefiks zapytania',
    queryPrefixPromptBody: 'Opcjonalny prefiks dodawany do zapytań użytkownika przed osadzeniem.',
    documentPrefixTitle: 'Prefiks dokumentu',
    documentPrefixPromptBody: 'Opcjonalny prefiks dodawany do indeksowanych fragmentów pamięci przed osadzeniem.',
    openAi: {
      baseUrlTitle: 'Bazowy URL',
      baseUrlPromptBody: 'Wprowadź bazowy URL dla zgodnego z OpenAI endpoint osadzeń.',
      modelTitle: 'Model zdalny',
      modelPromptBody: 'Wprowadź identyfikator modelu osadzeń, który ma zostać wysłany do zdalnego endpointu.',
      apiKeyTitle: 'Klucz API',
      apiKeyPromptBody: 'Wprowadź klucz API używany przez zdalny endpoint osadzeń.',
      dimensionsTitle: 'Wymiary',
      dimensionsPromptBody: 'Opcjonalne nadpisanie wymiaru wyjściowego dla wspieranych endpointów.',
    },
    advanced: {
      ftsWeightTitle: 'Waga rankingu tekstowego',
      ftsWeightPromptBody: 'Względna waga rankingu pełnotekstowego SQLite przy łączeniu wyników.',
      embeddingWeightTitle: 'Waga rankingu osadzeń',
      embeddingWeightPromptBody: 'Względna waga podobieństwa osadzeń przy łączeniu wyników.',
    },
  },
} as const;

const promptLibraryUxRefinementTranslationExtension = {
  pl: {
    promptsSubtitle: 'Wielokrotnego użytku dokumenty promptów',
    skillsSubtitle: 'Wielokrotnego użytku pakiety umiejętności',
    addPrompt: 'Dodaj nowy prompt',
    addPromptSubtitle: 'Utwórz nowy dokument promptu',
    addSkill: 'Dodaj nową umiejętność',
    addSkillSubtitle: 'Utwórz nowy pakiet umiejętności',
    newTemplateSubtitle: 'Utwórz wielokrotnego użytku szablon slash',
    noPrompts: 'Brak promptów',
    noPromptsSubtitle: 'Utwórz prompt, aby zacząć budować szablony i dodatki do promptu systemowego.',
    noSkills: 'Brak umiejętności',
    noSkillsSubtitle: 'Utwórz pakiet umiejętności, aby ponownie używać instrukcji SKILL.md.',
    imported: 'Zaimportowane',
    builtIn: 'Wbudowane',
    general: 'Ogólne',
    promptNameLabel: 'Nazwa promptu',
    promptContent: 'Treść promptu',
    skillNameLabel: 'Nazwa umiejętności',
    skillContent: 'Treść SKILL.md',
    supportingFiles: 'Pliki pomocnicze',
    supportingFilesEmptyTitle: 'Brak plików pomocniczych',
    supportingFilesEmptySubtitle: 'Dodaj pliki wielokrotnego użytku, aby eksportować je razem z tą umiejętnością.',
    supportingFilesSaveFirstTitle: 'Najpierw zapisz tę umiejętność',
    supportingFilesSaveFirstSubtitle: 'Utwórz umiejętność, zanim dodasz pliki pomocnicze.',
    addSupportingFile: 'Dodaj plik pomocniczy',
    addSupportingFileSubtitle: 'Utwórz kolejny plik w tym pakiecie umiejętności',
    editSupportingFile: 'Edytuj plik pomocniczy',
    newSupportingFile: 'Nowy plik pomocniczy',
    supportingFilePathLabel: 'Ścieżka pliku',
    supportingFilePathPlaceholder: 'templates/review.md',
    supportingFileContent: 'Zawartość pliku',
    supportingFileTextSubtitle: 'Plik tekstowy',
    supportingFileBinarySubtitle: 'Plik binarny · tylko eksport',
    deleteSupportingFileTitle: 'Usunąć plik pomocniczy?',
    deleteSupportingFileConfirm: 'To usunie plik z pakietu umiejętności.',
    linkedAssetsCount: ({ count }: { count: number }) => `${count} eksport${count === 1 ? '' : 'y'}`,
    manageExternalAssets: 'Zarządzaj zasobami zewnętrznymi',
    deleteLibraryItemTitle: 'Usunąć element biblioteki?',
    deleteLibraryItemBody: 'To usunie element z biblioteki i odłączy szablony lub dodatki do promptu systemowego, które go używają.',
    folders: 'Foldery',
    foldersSubtitle: 'Porządkuj prompty i umiejętności w nazwanych folderach',
    addFolder: 'Dodaj folder',
    addFolderSubtitle: 'Utwórz folder wielokrotnego użytku dla elementów biblioteki',
    foldersEmptyTitle: 'Brak folderów',
    foldersEmptySubtitle: 'Utwórz folder, aby porządkować prompty i umiejętności.',
    renameFolder: 'Zmień nazwę folderu',
    deleteFolderTitle: 'Usunąć folder?',
    deleteFolderBody: 'To usunie przypisanie folderu z promptów i umiejętności, które go używają.',
    folderUsageCount: ({ count }: { count: number }) => `${count} element${count === 1 ? '' : 'ów'}`,
    folderLabel: 'Folder biblioteki',
    folderPlaceholder: 'Nazwa folderu',
    tagsLabel: 'Tagi',
    tagsPlaceholder: 'tag-jeden, tag-dwa',
    addToStackSubtitle: 'Wybierz prompt lub umiejętność do dodania tutaj',
    externalAssetsImportAction: 'Importuj',
    externalAssetsLinkedTo: ({ title }: { title: string }) => `Połączono z ${title}`,
    externalAssetsExportTarget: 'Cel',
    externalAssetsInstallMethod: 'Sposób instalacji',
    externalAssetsInstallMethodCopy: 'Kopiuj pliki',
    externalAssetsInstallMethodCopySubtitle: 'Zapisuje samodzielną kopię w wybranym miejscu docelowym',
    externalAssetsInstallMethodSymlink: 'Dowiązanie symboliczne (zalecane)',
    externalAssetsInstallMethodSymlinkSubtitle: 'Łączy miejsce docelowe z kopią zarządzaną przez Happier, aby łatwiej aktualizować',
    registriesAddGitSourceSubtitle: 'Dodaj repozytorium Git lub lokalny checkout jako źródło rejestru',
    registriesSourceTitleLabel: 'Tytuł źródła',
    registriesSourceUrlLabel: 'URL repozytorium lub ścieżka lokalna',
    registriesSearchLabel: 'Szukaj w rejestrze',
    registriesSearchPlaceholder: 'Szukaj umiejętności (np. design)',
    registriesItemSource: 'Repozytorium źródłowe',
    registriesItemPath: 'Ścieżka rejestru',
    registriesItemFiles: 'Pliki pomocnicze',
    registriesItemPreview: 'Podgląd SKILL.md',
    registriesItemPreviewUnavailable: 'Brak podglądu SKILL.md dla tego elementu rejestru.',
    registriesItemImportSubtitle: 'Importuj ten pakiet umiejętności do biblioteki Happier',
    registriesItemInstallAction: 'Zainstaluj na maszynie',
    registriesItemInstallConfirmTitle: 'Zainstalować element rejestru?',
    registriesItemInstallConfirmBody: 'To importuje umiejętność do biblioteki i instaluje ją w wybranym miejscu na maszynie.',
    templateTargetPromptLabel: 'Prompt docelowy',
    templateTargetPromptPlaceholder: 'Wybierz prompt',
    editSelectedPrompt: 'Edytuj wybrany prompt',
    editSelectedPromptDisabled: 'Najpierw wybierz prompt',
    templateNameLabel: 'Nazwa szablonu',
    templateTokenLabel: 'Komenda slash',
    templatesEmptyTitle: 'Brak szablonów',
    templatesEmptySubtitle: 'Utwórz szablon slash, aby szybko wstawiać prompty.',
    librarySearchPlaceholder: 'Przeszukaj bibliotekę',
  },
} as const;

const sessionHandoffTranslationExtensions = {
  pl: {
    activeWarning: {
      title: 'Ta sesja nadal działa na tym urządzeniu',
      message: 'Przekazanie zatrzyma tę sesję na tym urządzeniu przed przeniesieniem jej na wybrane urządzenie.',
      confirm: 'Przekaż i zatrzymaj tutaj',
    },
    progress: {
      title: 'Przekazywanie sesji',
      message: 'Przygotowujemy maszynę docelową i przenosimy stan sesji.',
      planned: 'Zaplanowane',
      transferred: 'Przesłane',
      remaining: 'Pozostało',
      timeline: {
        scanSource: 'Skanowanie źródła',
        plan: 'Planowanie zmian',
        transferBlobs: 'Przesyłanie plików',
        stageTarget: 'Przygotowywanie celu',
        apply: 'Zastosowanie zmian',
        importSession: 'Importowanie sesji',
        finalize: 'Finalizowanie',
      },
    },
    failure: {
      title: 'Przekazanie sesji nie powiodło się',
      message: 'Nie udało się ukończyć przekazania. Możesz spróbować ponownie.',
    },
    recovery: {
      title: 'Sesja została zatrzymana tutaj przed ukończeniem przekazania',
      messageAfterSourceStop:
        'Happier już zatrzymał tę sesję na tym urządzeniu, ale nie mógł dokończyć jej uruchamiania na urządzeniu docelowym. Uruchom ją ponownie tutaj albo pozostaw zatrzymaną, dopóki nie przywrócisz urządzenia docelowego.',
      restartOnSource: 'Uruchom ponownie na źródle',
      keepStopped: 'Pozostaw zatrzymaną',
    },
  },
} as const;

const settingsSessionHandoffTranslationExtensions = {
  pl: {
    title: 'Przekazanie sesji',
    groupTitle: 'Przekazanie sesji',
    groupFooter: 'Wybierz domyslne opcje przenoszenia sesji miedzy maszynami.',
    entrySubtitle: 'Otworz ustawienia przekazania',
    workspaceTransfer: {
      groupTitle: 'Przenoszenie obszaru roboczego',
      groupFooter: 'Zdecyduj, czy przekazanie ma kopiowac obszar roboczy i jak domyslnie obslugiwac konflikty.',
      title: 'Przenos obszar roboczy',
      enabledSubtitle: 'Domyslnie kopiuj obszar roboczy na maszyne docelowa.',
      disabledSubtitle: 'Domyslnie pozostaw obszar roboczy na maszynie docelowej bez zmian.',
      strategy: {
        title: 'Strategia przenoszenia obszaru roboczego',
        subtitle: 'Wybierz pelny zrzut obszaru roboczego albo synchronizacje tylko zmian.',
        transferSnapshotTitle: 'Przenies zrzut',
        transferSnapshotSubtitle: 'Wyeksportuj i przenies pelny zrzut obszaru roboczego.',
        syncChangesTitle: 'Synchronizuj zmiany',
        syncChangesSubtitle: 'Porownaj zrodlo z celem i zastosuj tylko potrzebne jednostronne zmiany.',
      },
    },
    conflictPolicy: {
      title: 'Polityka konfliktow obszaru roboczego',
      subtitle: 'Wybierz, co ma sie stac, gdy sciezka docelowa juz istnieje.',
      createSiblingCopyTitle: 'Utworz kopie obok',
      createSiblingCopySubtitle: 'Zachowaj istniejaca sciezke docelowa i utworz kopie obok na potrzeby przekazania.',
      replaceExistingTitle: 'Zastap istniejaca sciezke',
      replaceExistingSubtitle: 'Zastap istniejaca sciezke docelowa po potwierdzeniu.',
    },
    includeIgnoredMode: {
      title: 'Ignorowane pliki',
      subtitle: 'Wybierz, jak traktowac pliki ignorowane przez gita podczas przenoszenia obszaru roboczego.',
      excludeTitle: 'Pomin ignorowane pliki',
      excludeSubtitle: 'Domyslnie pomijaj ignorowane pliki.',
      includeSelectedTitle: 'Dolacz wybrane ignorowane pliki',
      includeSelectedSubtitle: 'Kopiuj tylko ignorowane sciezki pasujace do skonfigurowanych globow.',
      globsTitle: 'Globy dolaczania ignorowanych plikow',
      globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
      title: 'Tryb celu dla sesji direct',
      subtitle: 'Wybierz, co ma sie stac podczas przekazywania sesji direct.',
      groupTitle: 'Przekazanie sesji direct',
      groupFooter: 'Dotyczy tylko sytuacji, gdy sesja zrodlowa jest obecnie direct.',
      keepDirectTitle: 'Pozostaw direct',
      keepDirectSubtitle: 'Wznow sesje docelowa jako direct, jesli dostawca to obsluguje.',
      convertToPersistedTitle: 'Przeksztalc w synchronizowana',
      convertToPersistedSubtitle: 'Zaimportuj transkrypt i kontynuuj jako synchronizowana sesje Happier.',
    },
  },
} as const;

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
    inbox: "Skrzynka",
    friends: "Przyjaciele",
    sessions: "Sesje",
    settings: "Ustawienia",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "Wszystko jest na bieżąco",
    emptyDescription: "Nie ma teraz oczekujących próśb ani aktualizacji.",
    approvals: "Zatwierdzenia",
    permissions: "Uprawnienia",
    updates: "Aktywność",
  },

  approvals: {
    title: "Zatwierdzenie",
    untitled: "Zatwierdzenie bez tytułu",
    details: "Szczegóły",
    fieldStatus: "Stan",
    fieldAction: "Akcja",
    approve: "Zatwierdź",
    reject: "Odrzuć",
    loadError: "Nie udało się wczytać zatwierdzenia.",
    decisionError: "Nie udało się zaktualizować zatwierdzenia.",
    confirmApproveTitle: "Zatwierdzić prośbę?",
    confirmApproveBody: "Spowoduje to wykonanie żądanej akcji.",
    confirmRejectTitle: "Odrzucić prośbę?",
    confirmRejectBody: "Spowoduje to odrzucenie prośby.",
    status: {
      open: "Oczekuje",
      approved: "Zatwierdzone",
      rejected: "Odrzucone",
      executed: "Wykonane",
      failed: "Nieudane",
      canceled: "Anulowane",
    },
  },

  promptLibrary: {
    sections: "Sekcje",
    library: "Biblioteka",
    librarySubtitle: "Zarządzaj promptami i umiejętnościami",
    create: "Utwórz",
    newPrompt: "Nowy prompt",
    newSkill: "Nowa umiejętność",
    prompts: "Prompty",
    skills: "Umiejętności",
    untitledPrompt: "Prompt bez tytułu",
    untitledSkill: "Umiejętność bez tytułu",
    origin: "Pochodzenie",
    schema: "Schemat",
    editPrompt: "Edytuj prompt",
    editSkill: "Edytuj umiejętność",
    titlePlaceholder: "Tytuł",
	    saveError: "Nie udało się zapisać.",
	    templates: "Szablony",
	    templatesSubtitle: "Twórz i zarządzaj szablonami /slash",
	    newTemplate: "Nowy szablon",
	    stacks: "Stosy",
	    stacksSubtitle: "Dołączaj prompty i umiejętności do sesji i profili",
        externalAssets: "Zasoby zewnętrzne",
        externalAssetsSubtitle: "Importuj umiejętności i zasoby promptów z podłączonych maszyn",
        externalAssetsContext: "Kontekst odkrywania",
        externalAssetsMachine: "Maszyna",
        externalAssetsScope: "Zakres",
        externalAssetsProjectScope: "Projekt",
        externalAssetsProjectScopeSubtitle: "Odkrywaj zasoby w ścieżce obszaru roboczego",
        externalAssetsUserScope: "Użytkownik",
        externalAssetsUserScopeSubtitle: "Odkrywaj zasoby w folderach użytkownika",
        externalAssetsProjectDirectory: "Katalog projektu",
        externalAssetsProjectDirectoryRequired: "Wybierz katalog projektu przed importem lub eksportem zasobów o zakresie projektu.",
        externalAssetsRefresh: "Odśwież zasoby zewnętrzne",
        externalAssetsRefreshSubtitle: "Odkrywaj zasoby promptów dla wybranej maszyny i zakresu",
        externalAssetsTypes: "Typy zasobów",
        externalAssetsNoMachine: "Wybierz maszynę, aby kontynuować.",
        externalAssetsNoTypes: "Brak typów zasobów zewnętrznych",
        externalAssetsNoTypesSubtitle: "Ta maszyna nie udostępnia jeszcze adapterów zasobów promptów.",
        externalAssetsNoItems: "Nie znaleziono zasobów zewnętrznych",
        externalAssetsNoItemsSubtitle: "Odśwież po wybraniu maszyny, zakresu lub katalogu.",
        externalAssetsUnsupportedImport: "Tutaj można importować tylko zasoby promptów oparte na bundle.",
        externalAssetsExportTitle: "Eksportuj zasób zewnętrzny",
        externalAssetsExportOptions: "Opcje eksportu",
        externalAssetsExportType: "Typ zasobu",
        externalAssetsExportAction: "Eksportuj",
        externalAssetsExportConfirmTitle: "Wyeksportować zasób zewnętrzny?",
        externalAssetsExportConfirmBody: "Spowoduje to zapisanie wybranego zasobu promptu w lokalizacji zewnętrznej.",
        externalAssetsExportTargetPathPlaceholder: "Ścieżka docelowa (np. review/code.md)",
        externalAssetsExportTargetNamePlaceholder: "Nazwa docelowa (np. reviewer)",
        externalAssetsDeleteConfirmTitle: "Usunąć zasób zewnętrzny?",
        externalAssetsDeleteConfirmBody: "Spowoduje to usunięcie połączonego zasobu zewnętrznego z dysku.",
        externalAssetsLinkedTitle: "Połączony zasób zewnętrzny",
        registries: "Rejestry",
        registriesSubtitle: "Przeglądaj rejestry umiejętności i importuj bundlowane pakiety do biblioteki",
        registriesContext: "Kontekst rejestru",
        registriesNoMachine: "Wybierz maszynę, aby kontynuować.",
        registriesRefresh: "Odśwież rejestry",
        registriesRefreshSubtitle: "Wczytaj wbudowane i skonfigurowane źródła rejestrów dla wybranej maszyny",
        registriesAddGitSource: "Dodaj źródło Git",
        registriesAddGitSourceAction: "Zapisz źródło Git",
        registriesAddGitSourceActionSubtitle: "Zapisz to repozytorium jako źródło rejestru",
        registriesAddGitSourceError: "Dodaj zarówno tytuł, jak i adres URL repozytorium.",
        registriesSourceTitlePlaceholder: "Tytuł źródła",
        registriesSourceUrlPlaceholder: "Adres URL repozytorium lub ścieżka lokalna",
        registriesSources: "Źródła",
        registriesNoSources: "Nie wczytano źródeł rejestru",
        registriesNoSourcesSubtitle: "Dodaj źródło Git lub odśwież, aby wczytać wbudowane źródła.",
        registriesItems: "Elementy rejestru",
        registriesNoItems: "Brak elementów rejestru",
        registriesNoItemsSubtitle: "Wybierz źródło, aby przeskanować dostępne umiejętności.",
	    editTemplate: "Edytuj szablon",
    tokenPlaceholder: "Token (np. /daily)",
    codingStack: "Stos kodowania",
    codingStackSubtitle: "Stosowany w sesjach kodowania",
    voiceStack: "Stos głosu",
    voiceStackSubtitle: "Stosowany w Happier Voice",
    profileStacks: "Stosy profili",
    profileStacksSubtitle: ({ count }: { count: number }) => {
      if (count === 1) return "1 profil";
      const mod10 = count % 10;
      const mod100 = count % 100;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${count} profile`;
      return `${count} profili`;
    },
    profileStackCount: ({ count }: { count: number }) => {
      if (count === 1) return "1 element";
      const mod10 = count % 10;
      const mod100 = count % 100;
      if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${count} elementy`;
      return `${count} elementów`;
    },
    noProfilesTitle: "Brak profili",
    noProfilesSubtitle: "Utwórz profil, aby używać stosów profili.",
    stackEntries: "Pozycje stosu",
    stackPlacementSkill: "Instrukcje umiejętności",
    stackPlacementComposer: "Wstaw do kompozytora",
    stackPlacementSystem: "Dodaj do systemu",
    stackEmptyTitle: "Ten stos jest pusty",
    stackEmptySubtitle: "Dodaj prompty lub umiejętności, aby zacząć.",
    actions: "Akcje",
    addToStack: "Dodaj do stosu",
    stackAlreadyContainsPrompt: "Ten stos już zawiera ten element.",
    stackPickerNoPrompts: "Brak promptów.",
    stackPickerNoSkills: "Brak umiejętności.",
    removeFromStack: "Usunąć ze stosu?",
    removeFromStackConfirm: "To usunie element ze stosu.",
    deleteTemplate: "Usunąć szablon?",
    deleteTemplateConfirm: "To usunie szablon.",
    templateTokenReserved: "Ten token jest zarezerwowany.",
    templateTokenConflictsWithAction: "Ten token koliduje z wbudowaną akcją.",
    templateTokenDuplicate: "Ten token jest już używany.",
    templateTarget: "Docelowy prompt",
    templateBehavior: "Zachowanie",
    templateBehaviorInsert: "Wstaw",
    templateBehaviorInsertAndSend: "Wstaw i wyślij",
    templateAllowArgs: "Zezwól na argumenty",
    templateAllowArgsSubtitle: "Jeśli włączone, tekst po tokenie jest przekazywany jako $args.",
        ...promptLibraryUxRefinementTranslationExtension.pl,
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
        delivery: {
          title: "Sposób wysyłki",
          cardDelivery: ({ label }: { label: string }) => `Sposób wysyłki: ${label}`,
          steerLabel: "Steruj",
          steerHelp: "Wyślij wiadomość sterującą, gdy uruchomienie jest zajęte (jeśli obsługiwane).",
          interruptLabel: "Przerwij",
          interruptHelp: "Anuluj bieżącą turę, a następnie wyślij wiadomość jako nową turę.",
          promptLabel: "Polecenie",
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
        name: "Codzienne podsumowanie",
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
    duplicate: "Duplikuj",
    actions: "Akcje",
    moreActions: "Więcej działań",
    moreActionsHint: "Otwiera menu z dodatkowymi działaniami",
    cancel: "Anuluj",
    close: "Zamknij",
      open: "Otwórz",
      done: "Gotowe",
      reorder: "Zmień kolejność",
      moveUp: "Przenieś w górę",
      moveDown: "Przenieś w dół",
      authenticate: "Uwierzytelnij",
      save: "Zapisz",
    saveAs: "Zapisz jako",
		    error: "Błąd",
		    success: "Sukces",
		    info: "Informacje",
		    comingSoon: "Wkrótce",
		    ok: "OK",
		    continue: "Kontynuuj",
		    back: "Wstecz",
        previous: "Poprzedni",
        next: "Następny",
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
    paste: "Wklej",
    expand: "Rozwiń",
    collapse: "Zwiń",
    command: "Polecenie",
    scanning: "Skanowanie...",
    urlPlaceholder: "https://example.com",
    home: "Główna",
    message: "Wiadomość",
    send: "Wyślij",
    attach: "Dołącz",
    addImage: "Dodaj obraz",
    addFile: "Dodaj plik",
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
      emptyResults: "Brak jeszcze wyników pamięci",
    },
        status: {
            title: "Stan lokalnego indeksu",
            diskUsageTitle: "Użycie dysku",
            disabled: "Lokalne wyszukiwanie pamięci jest wyłączone na tej maszynie",
            readyLight: "Lekki indeks gotowy na tej maszynie",
            readyDeep: "Głęboki indeks gotowy na tej maszynie",
            unavailableLight: "Lekki indeks nie jest jeszcze gotowy na tej maszynie",
            unavailableDeep: "Głęboki indeks nie jest jeszcze gotowy na tej maszynie",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
            diskUsageUnavailable: "Użycie dysku niedostępne",
            ...memoryEmbeddingsTranslationExtension.status,
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
      modelTitle: "Model embeddings",
      promptBody: "Wpisz identyfikator lokalnego modelu transformers.",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
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
          groupTitle: "Subagenci",
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
          overview: {
            groupTitle: "Przegląd",
            footer:
              "Użyj tej strony, aby skonfigurować wskazówki dla subagentów i przejść do powiązanych ustawień dostawcy, backendu i sesji.",
            explainerTitle: "Co kontroluje ta strona",
            explainerSubtitle:
              "Wskazówki delegowania dla subagentów oraz linki do ustawień subagentów specyficznych dla dostawców.",
            happierStatusTitle: "Subagenci",
            happierStatusEnabledSubtitle:
              "Włączone. Możesz uruchamiać subagentów z obsługiwanych sesji.",
            happierStatusDisabledSubtitle:
              "Wyłączone. Otwórz ustawienia Funkcje, aby włączyć subagentów.",
          },
          related: {
            groupTitle: "Powiązane ustawienia",
            footer:
              "Uruchamianie i kontrola subagentów zależą także od zachowania sesji, dostawców i skonfigurowanych backendów.",
            sessionTitle: "Zachowanie sesji",
            sessionSubtitle:
              "Wysyłanie wiadomości, sterowanie zajętością i zachowanie odtwarzania/wznawiania.",
            providersTitle: "Dostawcy",
            providersSubtitle:
              "Uwierzytelnianie, środowisko uruchomieniowe i ustawienia agentów specyficzne dla dostawcy.",
            backendsTitle: "Katalog ACP",
            backendsSubtitle: "Skonfigurowane backendy i niestandardowe cele uruchamiania.",
          },
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
          providers: {
            claude: {
              title: "Agenci zespołu Claude",
              footer: "Zachowanie subagentów specyficzne dla dostawcy pozostaje własnością ekranu ustawień dostawcy.",
              openTitle: "Opcje subagentów Claude",
              openSubtitle: "Zarządzaj Agent Teams i innymi zachowaniami subagentów specyficznymi dla Claude.",
            },
          },
        },
      },

        settings: {
          title: "Ustawienia",

          // Main settings hub category groups
      profileAndAccount: 'Profil i konto',
      aiAndAgents: 'AI i agenci',
      sessionsBehavior: 'Sesje i zachowanie',
      general: 'Ogólne',
      filesAndSourceControl: 'Pliki i kontrola źródeł',
      system: 'Systemowe',

          // Renamed / promoted items
      sessions: 'Sesje',
      transcript: 'Transkrypt',
      transcriptSubtitle: 'Myślenie, renderowanie narzędzi i wyświetlanie kodu',
      permissions: 'Uprawnienia',
      permissionsSubtitle: 'Tryb uprawnień i zachowanie zatwierdzeń',
      filesSourceControl: 'Pliki i kontrola źródeł',
      filesSourceControlSubtitle: 'Edytor, diffy i integracja z kontrolą źródeł',
      workspaces: 'Obszary robocze',
      workspacesSubtitle: 'Zarządzaj powiązanymi obszarami roboczymi, lokalizacjami i checkoutami',

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
    addMachine: "Dodaj maszynę",
    machineSetupCurrentMachineTitle: "Ten komputer",
    machineSetupCurrentMachineSubtitle: "Uruchom Happier bezpośrednio na tym urządzeniu",
    machineSetupAdoptExistingTitle: "Użyj istniejącej instalacji",
    machineSetupAdoptExistingSubtitle: "Wykorzystaj istniejącą konfigurację demona/usługi na tym komputerze",
    machineSetupAdoptExistingProgressTitle: "Sprawdzanie istniejącej instalacji",
    machineSetupAdoptExistingNotReady: "Nie znaleziono gotowej instalacji. Uruchom konfigurację na tym komputerze.",
    machineSetupSshMachineTitle: "Zdalna maszyna przez SSH",
    machineSetupSshMachineSubtitle: "Połącz przez SSH komputer deweloperski, VM lub serwer",
    machineSetupStagesTitle: "Co się stanie",
    machineSetupStageConnect: "Połącz i zweryfikuj dostęp",
    machineSetupStageInstall: "Zainstaluj Happier i sparuj maszynę",
    machineSetupStageFinish: "Dokończ konfigurację we wbudowanym terminalu",
    machineSetupComingSoon: "Konfiguracja maszyny już wkrótce.",
    machineSetupTaskWaitingForInput: "Oczekiwanie na dane wejściowe",
    machineSetupRemoteSshTargetLabel: "Cel SSH",
    machineSetupRemoteSshAgentAuthLabel: "Użyj agenta SSH",
    machineSetupRemoteSshKeyFileAuthLabel: "Użyj pliku tożsamości",
    machineSetupRemoteSshIdentityFileLabel: "Ścieżka pliku tożsamości",
    machineSetupRemoteRelayRuntimeLabel: "Zainstaluj też Relay Runtime na zdalnej maszynie",
    machineSetupRemoteRelayRuntimeTitle: "Zdalny Relay Runtime",
    machineSetupRemoteRelayRuntimeReadyTitle: "Gotowe na zdalnej maszynie",
    machineSetupRemoteRelayRuntimeReadySubtitle: "Relay Runtime został zainstalowany podczas konfiguracji SSH. W kolejnych krokach sieciowych na tej maszynie użyj zdalnego adresu URL Relay.",
    machineSetupRemoteRelayRuntimeUrlTitle: "Zdalny adres URL Relay",
    machineSetupRemoteRelayKeepCurrentTitle: "Zachowaj bieżący Relay",
    machineSetupRemoteRelayKeepCurrentSubtitle: "Zapisz ten adres URL Relay bez przełączania.",
    machineSetupRemoteRelaySwitchTitle: "Przełącz na ten Relay",
    machineSetupRemoteRelaySwitchSubtitle: "Przełącz teraz i kontynuuj konfigurację z nowym Relay.",
    machineSetupRemoteRelaySwitchConfirmTitle: "Przełączyć Relay?",
    machineSetupRemoteRelaySwitchConfirmBody: ({ relayUrl }: { relayUrl: string }) =>
      `Przełączyć Happier na ${relayUrl} i kontynuować konfigurację?`,
    machineSetupRemotePromptTrustAction: "Zaufaj kluczowi hosta",
    machineSetupRemotePromptReplaceAction: "Zastąp zapisany klucz",
    machineSetupRemotePromptApproveAction: "Zatwierdź parowanie",
    localRelayRuntime: {
      title: 'Lokalny Relay Runtime',
      statusTitle: 'Stan',
      statusChecking: 'Sprawdzanie lokalnego Relay Runtime',
      statusNotInstalled: 'Jeszcze nie zainstalowano na tym komputerze',
      statusStopped: 'Zainstalowany, ale obecnie nie działa',
      statusRunningHealthy: 'Działa i odpowiada normalnie',
      statusRunningNeedsAttention: 'Działa, ale kontrola stanu wymaga uwagi',
      versionTitle: 'Zainstalowana wersja',
      relayUrlTitle: 'Lokalny adres URL Relay',
      installOrUpdateAction: 'Zainstaluj lub zaktualizuj Relay Runtime',
      startAction: 'Uruchom Relay Runtime',
      stopAction: 'Zatrzymaj Relay Runtime',
      refreshAction: 'Odśwież stan Relay',
      footer: 'Zarządzaj samodzielnie hostowanym Relay działającym na tym komputerze, zanim połączysz inne urządzenia.',
      progressTitle: 'Aktualizowanie lokalnego Relay Runtime',
      progressStepInspect: 'Sprawdź lokalny Relay Runtime',
      progressStepHealth: 'Sprawdź stan Relay',
      progressStepInstall: 'Zainstaluj Relay Runtime',
      progressStepStart: 'Uruchom Relay Runtime',
      progressStepStop: 'Zatrzymaj Relay Runtime',
    },
    localTailscale: {
      title: 'Prywatny dostęp z Tailscale',
      statusTitle: 'Stan',
      statusUnavailable: 'Najpierw uruchom lokalny Relay Runtime',
      statusIdle: 'Jeszcze nie włączono',
      statusWorking: 'Konfigurowanie bezpiecznego prywatnego dostępu',
      statusReady: 'Gotowe do użycia z innych urządzeń tailnet',
      statusInstallRequired: 'Install Tailscale to continue',
      statusLoginRequired: 'Sign in to Tailscale to continue',
      statusNeedsApproval: 'Oczekiwanie na zatwierdzenie Tailscale',
      shareableUrlTitle: 'Udostępnialny prywatny adres URL',
      approvalTitle: 'Wymagane zatwierdzenie',
      approvalSubtitle: 'Dokończ proces zatwierdzania w Tailscale i wróć tutaj.',
      installTitle: 'Install required',
      installSubtitle: 'Install Tailscale, then come back here.',
      loginTitle: 'Sign-in required',
      loginSubtitle: 'Complete the Tailscale sign-in flow, then come back here.',
      enableAction: 'Włącz prywatny dostęp z Tailscale',
      refreshAction: 'Sprawdź ponownie prywatny dostęp',
      openApprovalAction: 'Otwórz zatwierdzanie Tailscale',
      openInstallAction: 'Open Tailscale download',
      openLoginAction: 'Open Tailscale sign-in',
      footer: 'To utrzymuje dostęp wyłącznie w tailnecie. Twój telefon lub inny komputer również muszą dołączyć do tego samego tailnetu.',
      progressTitle: 'Konfigurowanie bezpiecznego dostępu Tailscale',
      progressStepDetect: 'Sprawdź dostępność Tailscale',
      progressStepInstall: 'Zainstaluj Tailscale',
      progressStepLogin: 'Zaloguj się do Tailscale',
      progressStepServeEnable: 'Włącz prywatny dostęp do Relay',
      progressStepVerifyUrl: 'Sprawdź udostępnialny adres URL',
    },
    systemTaskStepPrepare: "Przygotuj zadanie",
    systemTaskStepInstallRuntime: "Zainstaluj środowisko uruchomieniowe",
    systemTaskStepFinish: "Zakończ konfigurację",
    systemTaskCurrentStepLabel: "Bieżący krok",
    systemTaskLatestUpdateLabel: "Najnowsza aktualizacja",
    systemTaskBridgeUnavailable: "Zadania systemowe nie są jeszcze dostępne w tej kompilacji.",
    systemTaskStartFailed: "Nie udało się uruchomić zadania systemowego.",
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
      channelBridges: "Mosty kanałów",
      channelBridgesSubtitle: "Łącz zewnętrzne czaty (Telegram) z sesjami",
      featuresTitle: "Funkcje",
      featuresSubtitle: "Włącz lub wyłącz funkcje aplikacji",
    developer: "Deweloper",
    developerTools: "Narzędzia deweloperskie",
    about: "O aplikacji",
    actionsSettingsAboutSubtitle:
      "Włączaj lub wyłączaj akcje globalnie, dla powierzchni (UI/głos/MCP) oraz dla miejsc umieszczenia (gdzie pojawiają się w interfejsie). Wyłączone akcje są blokowane w trybie fail-closed w czasie działania.",
    aboutFooter:
      "Happier Coder to mobilny klient Codex i Claude Code. Domyślnie używa szyfrowania end-to-end, z przywracaniem konta na innych Twoich urządzeniach. Nie jest powiązany z Anthropic.",
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
        actionsSubtitle: 'Wybierz, gdzie każda akcja ma się pojawiać w aplikacji, w głosie i w integracjach.',
    prompts: "Prompty i umiejętności",
    promptsSubtitle: "Biblioteka promptów, szablony i stosy",
    servers: "Relaye",
    serversSubtitle: "Zapisane Relaye, grupy i ustawienia domyślne",
			    systemStatus: "Stan systemu",
			    systemStatusSubtitle: "Relaye, konto, maszyny, daemon",
		    mcpServers: "Serwery MCP",
		    mcpServersSubtitle: "Zarządzaj serwerami MCP i powiązaniami",
		    mcpServersComingSoon: "Ustawienia serwerów MCP będą wkrótce dostępne.",
		    mcpServersStrictMode: "Tryb ścisły",
		    mcpServersStrictModeSubtitle: "Zamykaj działanie, gdy ustawienia serwera MCP są nieprawidłowe.",
		    mcpServersCatalogTitle: "Katalog",
		    mcpServersUnnamed: "Nienazwany serwer",
		    mcpServersEmptyTitle: "Brak jeszcze serwerów MCP",
		    mcpServersEmptySubtitle: "Dodaj serwery MCP, aby używać ich w sesjach.",
		    mcpServersAddServer: "Dodaj serwer",
		    mcpServersAddServerSubtitle: "Utwórz nowy wpis serwera MCP",
		    mcpServersEditorTitle: "Serwer MCP",
		    mcpServersPickSecretTitle: "Wybierz sekret",
		    mcpServersPickSecretNoneSubtitle: "Nie wybrano sekretu",
		    mcpServersEditorBasics: "Podstawy",
		    mcpServersEditorStdio: "Wejście/wyjście standardowe",
		    mcpServersEditorRemote: "Zdalny",
		    mcpServersEditorBindings: "Powiązania",
		    mcpServersFieldName: "Nazwa",
		    mcpServersFieldTitle: "Tytuł",
		    mcpServersFieldTitlePlaceholder: "Opcjonalny tytuł wyświetlany",
		    mcpServersFieldTransport: "Rodzaj transportu",
		    mcpServersFieldCommand: "Polecenie",
		    mcpServersFieldArgs: "Argumenty",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "Powiązanie",
		    mcpServersBindingEnabled: "Włączone",
		    mcpServersBindingEnabledSubtitle: "Włącz lub wyłącz to powiązanie",
		    mcpServersBindingTarget: "Cel",
		    mcpServersBindingTargetSubtitle: "Gdzie ten serwer jest dostępny",
		    mcpServersBindingMachine: "Maszyna",
		    mcpServersBindingMachineSubtitle: "Wybierz maszynę",
		    mcpServersBindingDeleteSubtitle: "Usuń to powiązanie",
		    mcpServersBindingTargetAllMachines: "Wszystkie maszyny",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `Maszyna: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `Workspace: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "Włącz na każdej maszynie",
		    mcpServersBindingTargetMachineTitle: "Maszyna",
		    mcpServersBindingTargetMachineSubtitle: "Włącz na jednej maszynie",
		    mcpServersBindingTargetWorkspaceTitle: "Obszar roboczy",
		    mcpServersBindingTargetWorkspaceSubtitle: "Włącz tylko dla konkretnej ścieżki obszaru roboczego",
		    mcpServersValidationFailed: "Ustawienia serwera MCP są nieprawidłowe.",
		    mcpServersServerNotFound: "Nie znaleziono serwera.",
		    mcpServersBindingsEmptyTitle: "Brak jeszcze powiązań",
		    mcpServersBindingsEmptySubtitle: "Dodaj powiązanie, aby używać tego serwera.",
		    mcpServersAddBinding: "Dodaj powiązanie",
		    mcpServersAddBindingSubtitle: "Włącz ten serwer dla maszyn lub obszarów roboczych",
		    mcpServersSaveDisabledSubtitle: "Brak zmian do zapisania.",
			    mcpServersDeleteTitle: "Usunąć serwer MCP?",
			    mcpServersDeleteConfirm: ({ name }: { name: string }) => `Usunąć „${name}”?`,
			    mcpServersDeleteSubtitle: "Usuń ten serwer z katalogu",
			    mcpServersNoMachineSelected: "Nie wybrano maszyny",
			    mcpServersDetectedTitle: "Wykryte z konfiguracji dostawców",
			    mcpServersDetectedMachineTitle: "Maszyna",
			    mcpServersDetectedRefreshTitle: "Odśwież wykryte serwery",
			    mcpServersDetectedRefreshSubtitle: "Przeskanuj pliki konfiguracyjne dostawców na tej maszynie",
			    mcpServersDetectedWarningsTitle: "Ostrzeżenia o wykrywaniu",
			    mcpServersDetectedEmptyTitle: "Brak wykrytych serwerów MCP",
			    mcpServersDetectedEmptySubtitle: "Kliknij odśwież, aby przeskanować konfiguracje Claude/Codex/OpenCode.",
			    mcpServersImportTitle: "Zaimportować serwer MCP?",
			    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) =>
			      `Zaimportować „${name}” z ${provider}?`,
			    mcpServersImportAction: "Importuj",
			    mcpServersBindingSummaryAllMachines: "Wszystkie maszyny",
			    mcpServersBindingSummaryMachines: ({ count }: { count: number }) =>
			      count === 1 ? "1 maszyna" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? `${count} maszyny` : `${count} maszyn`,
			    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) =>
			      count === 1 ? "1 obszar roboczy" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? `${count} obszary robocze` : `${count} obszarów roboczych`,
			    mcpServersBindingSummaryNone: "Niepowiązany",
			    mcpServersPickWorkspaceTitle: "Wybierz główny katalog obszaru roboczego",
			    mcpServersBindingWorkspaceRootTitle: "Główny katalog obszaru roboczego",
			    mcpServersBindingOverridesTitle: "Nadpisania",
			    mcpServersBindingOverridesNone: "Brak nadpisań",
			    mcpServersBindingOverridesCount: ({ count }: { count: number }) =>
			      count === 1 ? "1 nadpisanie" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? `${count} nadpisania` : `${count} nadpisań`,
			    mcpServersEditorEnv: "Środowisko",
			    mcpServersEnvAdd: "Dodaj zmienną środowiskową",
			    mcpServersEnvAddSubtitle: "Ustaw zmienne środowiskowe dla tego serwera",
			    mcpServersEnvEmptyTitle: "Brak zmiennych środowiskowych",
			    mcpServersEnvEmptySubtitle: "Dodaj zmienne środowiskowe albo użyj zapisanych sekretów.",
			    mcpServersEditorHeaders: "Nagłówki",
			    mcpServersHeadersAdd: "Dodaj nagłówek",
			    mcpServersHeadersAddSubtitle: "Ustaw nagłówki HTTP/SSE dla tego serwera",
			    mcpServersHeadersEmptyTitle: "Brak nagłówków",
			    mcpServersHeadersEmptySubtitle: "Dodaj nagłówki, jeśli twój serwer wymaga uwierzytelniania.",
			    mcpServersEnvEditorTitle: "Edytuj zmienną środowiskową",
			    mcpServersHeadersEditorTitle: "Edytuj nagłówek",
			    mcpServersEnvKeyLabel: "Nazwa zmiennej środowiskowej",
			    mcpServersEnvKeyPlaceholder: "API_KEY",
			    mcpServersHeaderKeyLabel: "Nazwa nagłówka",
			    mcpServersHeaderKeyPlaceholder: "Authorization",
			    mcpServersValueSourceTitle: "Źródło wartości",
			    mcpServersArgsPlaceholder: "--flag\nwartość",
			    mcpServersValueSourceLiteral: "Literał",
			    mcpServersValueSourceLiteralSubtitle: "Przechowuj wartość (obsługuje szablony ${VAR})",
			    mcpServersValueSourceSavedSecret: "Zapisany sekret",
			    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `Zapisany sekret: ${name}`,
			    mcpServersValueSourceSavedSecretSubtitle: "Odwołaj się do zapisanego sekretu",
			    mcpServersValueLiteralLabel: "Wartość",
			    mcpServersValueLiteralPlaceholder: "Wartość lub ${ENV_VAR}",
			    mcpServersValueSecretLabel: "Zapisany sekret",
			    mcpServersValueSecretSelect: "Wybierz sekret",
			    mcpServersValueSecretSelectSubtitle: "Wybierz zapisany sekret",
			    mcpServersKeyInvalid: "Klucz jest nieprawidłowy.",
			    mcpServersKeyAlreadyExists: "Klucz już istnieje.",
			    mcpServersOverridesStdioTitle: "Nadpisania stdio",
			    mcpServersOverridesCommandTitle: "Nadpisz polecenie",
			    mcpServersOverridesCommandSubtitle: "Użyj innego polecenia dla tego powiązania",
			    mcpServersOverridesArgsTitle: "Nadpisz argumenty",
			    mcpServersOverridesArgsSubtitle: "Użyj innych argumentów dla tego powiązania (puste = brak argumentów)",
			    mcpServersOverridesRemoteTitle: "Zdalne nadpisania",
			    mcpServersOverridesUrlTitle: "Nadpisz URL",
			    mcpServersOverridesUrlSubtitle: "Użyj innego URL-a dla tego powiązania",
			    mcpServersOverridesEnvPatchTitle: "Zmiany środowiska",
			    mcpServersOverridesEnvPatchEmptyTitle: "Brak nadpisań środowiska",
			    mcpServersOverridesEnvPatchEmptySubtitle: "Dodaj nadpisania lub usunięcia dla zmiennych środowiskowych.",
			    mcpServersOverridesHeadersPatchTitle: "Zmiany nagłówków",
			    mcpServersOverridesHeadersPatchEmptyTitle: "Brak nadpisań nagłówków",
			    mcpServersOverridesHeadersPatchEmptySubtitle: "Dodaj nadpisania lub usunięcia dla nagłówków.",
			    mcpServersOverridesDeleteValue: "Usuń ten klucz dla tego powiązania",
			    mcpServersOverridesEnvPatchAddTitle: "Dodaj nadpisanie środowiska",
			    mcpServersOverridesEnvPatchAddSubtitle: "Ustaw lub nadpisz zmienną środowiskową dla tego powiązania",
			    mcpServersOverridesEnvPatchDeleteTitle: "Usuń klucz środowiska",
			    mcpServersOverridesEnvPatchDeleteSubtitle: "Usuń zmienną środowiskową dla tego powiązania",
			    mcpServersOverridesHeadersPatchAddTitle: "Dodaj nadpisanie nagłówka",
			    mcpServersOverridesHeadersPatchAddSubtitle: "Ustaw lub nadpisz nagłówek dla tego powiązania",
			    mcpServersOverridesHeadersPatchDeleteTitle: "Usuń klucz nagłówka",
			    mcpServersOverridesHeadersPatchDeleteSubtitle: "Usuń nagłówek dla tego powiązania",
			    mcpServersOverridesDeleteEnvTitle: "Usuń klucz środowiska",
			    mcpServersOverridesDeleteEnvPrompt: "Wpisz nazwę zmiennej środowiskowej do usunięcia dla tego powiązania.",
			    mcpServersOverridesDeleteHeaderTitle: "Usuń klucz nagłówka",
			    mcpServersOverridesDeleteHeaderPrompt: "Wpisz nazwę nagłówka do usunięcia dla tego powiązania.",
			    mcpServersOverridesCommandRequired: "Nadpisanie polecenia jest włączone, ale puste.",
			    mcpServersOverridesUrlRequired: "Nadpisanie URL-a jest włączone, ale puste.",
		    mcpServersTestTitle: "Test serwera",
			    mcpServersTestFooter: "Działa na wybranej maszynie. Żadne sekrety nie są pokazywane w wynikach.",
			    mcpServersTestMachineTitle: "Test na maszynie",
			    mcpServersTestBindingTitle: "Użyj powiązania",
			    mcpServersTestNoBinding: "Brak powiązania",
			    mcpServersTestNoBindingSubtitle: "Testuj bez nadpisań powiązania",
			    mcpServersTestDirectoryTitle: "Katalog roboczy",
			    mcpServersTestDirectorySubtitle: "Stuknij, aby ustawić katalog",
			    mcpServersTestDirectoryPrompt: "Wpisz katalog roboczy dla testu.",
			    mcpServersTestRunTitle: "Testuj serwer",
			    mcpServersTestRunSubtitle: "Połącz i wyświetl narzędzia",
			    mcpServersTestResultOkTitle: "Test zakończony powodzeniem",
			    mcpServersTestResultOkSubtitle: ({
			      toolCount,
			      durationMs,
			    }: {
			      toolCount: number;
			      durationMs: number;
			    }) => `${toolCount} narzędzi · ${durationMs} ms`,
			    mcpServersTestResultErrorTitle: "Test nie powiódł się",
        ...mcpServersUxTranslationExtension,
        ...acpCatalogTranslationExtension.settings,

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
		      currentServer: "Bieżący Relay",
      identity: "Zalogowana tożsamość",
      configuredServers: "Skonfigurowane Relaye",
      machinesActiveServer: "Maszyny (aktywny Relay)",
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
      activeServer: "Aktywny Relay",
    },
    identity: {
      accountId: "Id konta",
      username: "Nazwa użytkownika",
    },
    servers: {
      noneConfigured: "Brak skonfigurowanych Relayów",
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
        loading: "Pobieranie relaya/konta daemona…",
        invalid: "Nie udało się odczytać doctor snapshot z maszyny",
      },
      daemonAttributionUnknown: "Relay/konto daemona: nieznane",
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
      runDiagnosisSubtitle: "Wykrywa niezgodności relaya/konta/daemona",
      refreshMachineAttribution: "Odśwież atrybucję daemona",
      refreshMachineAttributionSubtitle: "Pobierz relay/konto daemona dla kilku maszyn online",
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
      activeServer: "Aktywny Relay",
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
    },
  },

  settingsSourceControl: {
    title: 'Pliki i kontrola źródeł',
    editor: 'Edytor',
    editorFooter: 'Skonfiguruj zachowanie edytora plików.',
    editorAutoSave: 'Autozapis',
    editorAutoSaveDescription: 'Automatycznie zapisuj pliki po edycji.',
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

  settingsDesktop: {
    title: 'Desktop',
    footer: 'Controls Tauri desktop integrations on this computer.',
    startOnLoginTitle: 'Launch at login',
    startOnLoginSubtitle: 'Start Happier automatically when you sign in to this computer.',
  },

  settingsNotifications: {
    badges: {
      title: 'Odznaki na tym urządzeniu',
      footer: 'Wybierz, które działania mają wpływać na odznakę ikony aplikacji na tym urządzeniu.',
      enabledTitle: 'Włącz odznaki',
      enabledSubtitle: 'Pokazuj odznakę ikony aplikacji, gdy aktywność wymaga uwagi',
      unreadTitle: 'Nieprzeczytane sesje',
      unreadSubtitle: 'Zliczaj sesje z nieprzeczytaną aktywnością w transkrypcie',
      permissionRequestsTitle: 'Prośby o uprawnienia',
      permissionRequestsSubtitle: 'Zliczaj sesje czekające na zatwierdzenie',
      userActionsTitle: 'Prośby o akcję',
      userActionsSubtitle: 'Zliczaj sesje czekające na odpowiedź lub potwierdzenie',
      queuedTitle: 'Zakolejkowane dane wejściowe użytkownika',
      queuedSubtitle: 'Zliczaj sesje z zakolejkowaną pracą, którą nadal trzeba wysłać',
      friendRequestsTitle: 'Prośby znajomych',
      friendRequestsSubtitle: 'Dodawaj przychodzące prośby znajomych do liczbowej odznaki',
      desktopDotTitle: 'Kropka dokowania na pulpicie',
      desktopDotSubtitle: 'Na komputerze pokazuj kropkę, gdy istnieje tylko nienumeryczna aktywność skrzynki odbiorczej',
    },
    local: {
      title: 'Powiadomienia lokalne na tym urządzeniu',
      footer: 'Te ustawienia wpływają na to, jak powiadomienia wyglądają na tym konkretnym urządzeniu.',
      enabledSubtitle: 'Zezwól temu urządzeniu na wyświetlanie lokalnych powiadomień',
      readyTitle: 'Gotowe',
      readySubtitle: 'Pokazuj lokalne powiadomienie, gdy tura się kończy',
      readyPreviewTitle: 'Podglądy wiadomości gotowości',
      readyPreviewSubtitle: 'Uwzględniaj najnowszą wiadomość asystenta w powiadomieniach gotowości na tym urządzeniu',
      permissionRequestsTitle: 'Prośby o uprawnienia',
      permissionRequestsSubtitle: 'Pokazuj lokalne powiadomienie, gdy sesja wymaga zatwierdzenia',
      userActionsTitle: 'Prośby o akcję',
      userActionsSubtitle: 'Pokazuj lokalne powiadomienie, gdy sesja wymaga Twojego wkładu',
    },
    push: {
      title: "Powiadomienia push",
      footer:
        "Te powiadomienia są wysyłane z Twojego CLI przez Expo, gdy sesja wymaga Twojej uwagi.",
      enabledSubtitle: "Zezwól na powiadomienia push dla tego konta",
      troubleshootTitle: "Rozwiązywanie problemów",
      troubleshootSubtitle: "Sprawdź uprawnienia i zarejestrowane urządzenia",
    },
    pushTroubleshooting: {
      status: {
        title: "Stan",
        footer: "Sprawdza ustawienie konta, uprawnienie systemu i rejestrację na serwerze.",
        accountSettingTitle: "Ustawienie konta",
        accountSettingEnabledSubtitle: "Powiadomienia push są włączone dla tego konta",
        accountSettingDisabledSubtitle: "Powiadomienia push są wyłączone dla tego konta",
      },
      permission: {
        title: "Uprawnienie",
        loading: "Ładowanie…",
        loadingSubtitle: "Sprawdzanie uprawnień powiadomień",
        unsupported: "Nieobsługiwane",
        unsupportedSubtitle: "Uprawnienia push nie są dostępne w web.",
        allowed: "Dozwolone",
        allowedSubtitle: "Powiadomienia są dozwolone dla tej aplikacji.",
        denied: "Odmówione",
        notRequested: "Niepoproszone",
        canAskAgainSubtitle: "Dotknij, aby poprosić o uprawnienie.",
        openSettingsSubtitle: "Dotknij, aby otworzyć ustawienia systemu.",
      },
      token: {
        title: "To urządzenie",
        subtitle: ({ fingerprint }: { fingerprint: string }) =>
          `Aktualny token: ${fingerprint}`,
        unavailableSubtitle: "Nie można odczytać tokenu push Expo.",
        registered: "Zarejestrowany",
      },
      actions: {
        title: "Akcje",
        footer: "Użyj tych kroków, jeśli powiadomienia push nie docierają.",
        requestPermissionTitle: "Poproś o uprawnienie",
        requestPermissionSubtitle: "Poproś system o uprawnienia do powiadomień.",
        reregisterTitle: "Zarejestruj token ponownie",
        reregisterSubtitle: "Wyślij ponownie token tego urządzenia na serwer.",
        refreshTitle: "Odśwież",
        refreshSubtitle: "Przeładuj uprawnienie, token i urządzenia na serwerze.",
      },
      devices: {
        title: "Zarejestrowane urządzenia",
        footer: ({ count, serverUrl }: { count: string; serverUrl: string }) =>
          `${serverUrl} — tokeny: ${count}`,
        emptyTitle: "Brak urządzeń",
        emptySubtitle: "Na serwerze nie ma zarejestrowanych tokenów push dla tego konta.",
        clientServerUrl: ({ url }: { url: string }) => `Serwer: ${url}`,
        registeredAt: ({ at }: { at: string }) => `Zarejestrowano: ${at}`,
        lastSeenAt: ({ at }: { at: string }) => `Ostatnio widziano: ${at}`,
        thisDevice: "To urządzenie",
      },
      loadError: "Nie udało się załadować stanu powiadomień push.",
      authRequired: "Zaloguj się, aby zarządzać powiadomieniami push.",
      remove: {
        confirmTitle: "Usuń urządzenie",
        confirmBody: ({ fingerprint }: { fingerprint: string }) =>
          `Usunąć token push ${fingerprint}?`,
        error: "Nie udało się usunąć tokenu push.",
      },
    },
    webhooks: {
      title: 'Powiadomienia webhook',
      footer: 'Wysyłaj zdalne powiadomienia o aktywności do dodatkowych endpointów webhook na tym koncie.',
      addTitle: 'Dodaj webhook',
      addSubtitle: 'Dostarczaj powiadomienia do innego endpointu',
      emptyTitle: 'Brak kanałów webhook',
      emptySubtitle: 'Dodaj webhook, aby dostarczać zdalne zdarzenia aktywności poza Expo push.',
      enabledTitle: 'Włącz webhook',
      enabledSubtitle: 'Powiadomienia webhook są włączone',
      disabledSubtitle: 'Powiadomienia webhook są wyłączone',
      channelEnabledSubtitle: 'Zezwól temu endpointowi na otrzymywanie powiadomień o aktywności',
      urlPromptTitle: 'URL webhooka',
      urlPromptSubtitle: 'Wpisz docelowy URL dla tego webhooka powiadomień.',
      urlPromptPlaceholder: 'https://hooks.example.test/notify',
      invalidUrlTitle: 'Nieprawidłowy URL webhooka',
      invalidUrlSubtitle: 'Wpisz prawidłowy URL HTTP lub HTTPS.',
      deleteTitle: 'Usuń webhook',
      deleteConfirm: ({ url }: { url: string }) =>
        `Przestać wysyłać powiadomienia do ${url}?`,
      signingSecretTitle: 'Sekret podpisu',
      signingSecretEmptySubtitle: 'Dodaj wspólny sekret, aby podpisywać payloady webhooka',
      signingSecretConfiguredSubtitle: 'Payloady webhooka są podpisywane wspólnym sekretem',
      signingSecretPromptTitle: 'Sekret podpisu webhooka',
      signingSecretPromptSubtitleAdd: 'Wpisz wspólny sekret, aby podpisywać ten payload webhooka.',
      signingSecretPromptSubtitleReplace: 'Wpisz nowy wspólny sekret, aby zastąpić istniejący sekret podpisu.',
      signingSecretPromptPlaceholder: 'shared-secret',
      signingSecretClearAction: 'Wyczyść sekret',
      readyTitle: 'Gotowe',
      readySubtitle: 'Wysyłaj, gdy tura się kończy, a agent czeka na Twoją komendę',
      readyPreviewTitle: 'Podglądy wiadomości gotowości',
      readyPreviewSubtitle: 'Uwzględniaj najnowszy tekst wiadomości asystenta w powiadomieniach gotowości dla tego webhooka',
      permissionRequestsTitle: 'Prośby o uprawnienia',
      permissionRequestsSubtitle: 'Wysyłaj, gdy sesja czeka na zatwierdzenie',
      userActionsTitle: 'Prośby o akcję',
      userActionsSubtitle: 'Wysyłaj, gdy sesja potrzebuje odpowiedzi lub potwierdzenia',
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
        title: 'Podglądy wiadomości gotowości',
        subtitle: 'Uwzględniaj najnowszy tekst wiadomości asystenta w powiadomieniach push dla tur gotowości',
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
        defaultSessionTitle: "Sesja",
        readyFallbackBody: "Tura zakończona. Otwórz sesję, aby kontynuować.",
        permissionFallbackBody: "Wymagane zatwierdzenie.",
        userActionFallbackBody: "Ta sesja wymaga Twojego wkładu.",
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
      configuration: 'Konfiguracja',
      cliConnection: 'Połączenie CLI',
      capabilities: 'Możliwości',
      models: 'Modele',
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
      resumeSupportNotSupported: "Nieobsługiwane",
      sessionModeNone: "Brak trybów ACP",
      sessionModeAcpPolicyPresets: "Presety polityk ACP",
      sessionModeAcpAgentModes: "Tryby agenta ACP",
      sessionModeDynamicPolicyModes: "Dynamiczne tryby polityk",
      sessionModeDynamicAgentModes: "Dynamiczne tryby agenta",
      sessionModeStaticAgentModes: "Statyczne tryby agenta",
      runtimeSwitchNone: "Brak przełączania w runtime",
      runtimeSwitchMetadataGating: "Kontrolowane metadanymi",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchSessionModeApi: "API trybu sesji",
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
      setup: {
        selectionFooter: "Wybierz jednego lub więcej dostawców i ukończ ich po kolei na wybranej maszynie.",
        startTitle: "Skonfiguruj dostawców",
        startDescription: "Dodaj wybranych dostawców do kolejki i przejdź przez instalację oraz logowanie w jednym kanonicznym przepływie.",
        queueTitle: "Kolejka konfiguracji dostawców",
        queueDescription: ({ provider }: { provider: string }) => `Zakończ ${provider}, a następnie przejdź do kolejnego dostawcy w kolejce.`,
        activeDescription: "Aktualny dostawca w kolejce konfiguracji",
        activeStatus: "W toku",
        completedStatus: "Ukończono",
        skippedStatus: "Pominięto",
        skipAction: "Pomiń tego dostawcę",
        completedTitle: "Konfiguracja dostawcy zakończona",
        completedDescription: "To już koniec kolejki wybranych dostawców.",
      },
      cliSourcePreference: {
        title: "Preferencja źródła CLI",
        subtitle:
          "Wybierz, czy Happier ma preferować systemowe CLI czy zarządzaną instalację, gdy oba są dostępne.",
        options: {
          systemFirst: {
            title: "Najpierw instalacja systemowa",
            subtitle: "Preferuj CLI już zainstalowane na tej maszynie.",
          },
          managedFirst: {
            title: "Najpierw instalacja zarządzana",
            subtitle: "Preferuj CLI zainstalowane przez Happier dla tego dostawcy.",
          },
        },
      },
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
        confirmInstallTitle: ({ provider }: { provider: string }) => `Zainstalować ${provider} CLI?`,
        confirmReinstallTitle: ({ provider }: { provider: string }) => `Zainstalować ponownie ${provider} CLI?`,
        confirmBody: ({ provider }: { provider: string }) =>
          `To uruchomi polecenia instalatora ${provider} na wybranej maszynie. Kontynuuj tylko jeśli ufasz dostawcy.`,
        confirmInstallConfirm: "Zainstaluj",
        confirmReinstallConfirm: "Zainstaluj ponownie",
        noMachineSelected: "Nie wybrano maszyny.",
        installNotSupported: "Instalacja nie jest obsługiwana na tej maszynie.",
        installFailed: "Instalacja nie powiodła się.",
        installed: "Zainstalowano.",
        logPath: ({ logPath }: { logPath: string }) => `Log: ${logPath}`,
      },
      setupGuideUrlTitle: "URL przewodnika konfiguracji",
      authentication: {
        title: "Uwierzytelnianie",
        footer: "Sprawdź stan lokalnego uwierzytelniania CLI i uruchom logowanie, jeśli jest obsługiwane.",
        terminalTitle: "Terminal logowania dostawcy",
        logInTitle: "Zaloguj się",
        logInSubtitle: "Otwórz terminal i uruchom logowanie dostawcy na tej maszynie.",
        reauthenticateTitle: "Uwierzytelnij ponownie",
        reauthenticateSubtitle: "Otwórz terminal i odśwież logowanie dostawcy na tej maszynie.",
        checkNowTitle: "Sprawdź teraz",
        checkNowSubtitle: "Odśwież wykryty stan lokalnego uwierzytelniania.",
        statusTitle: "Stan",
        loggedInAsTitle: "Zalogowano jako",
        methodTitle: "Metoda uwierzytelniania",
        sourceTitle: "Źródło poświadczeń",
        reasonTitle: "Problem",
        lastCheckedTitle: "Ostatnio sprawdzono",
        stateUnknown: "Nieznany",
        stateLoggedIn: "Zalogowano",
        stateLoggedOut: "Wylogowano",
        methods: {
          apiKeyEnv: "Zmienna środowiskowa klucza API",
          authTokenEnv: "Zmienna środowiskowa tokenu uwierzytelniania",
          credentialsFile: "Plik poświadczeń",
          oauthCli: "Logowanie OAuth w CLI",
          configFile: "Plik konfiguracyjny",
          gcloudAdc: "Domyślne poświadczenia aplikacji Google Cloud",
          unknown: "Nieznany",
        },
        reasons: {
          missingCredentials: "Brak poświadczeń",
          expired: "Poświadczenia wygasły",
          cliMissing: "CLI nie jest zainstalowane",
          probeFailed: "Sprawdzenie stanu nie powiodło się",
          timeout: "Sprawdzenie stanu przekroczyło limit czasu",
          unsupported: "Lokalne uwierzytelnianie nie jest obsługiwane",
          interactiveBlocked: "Logowanie interaktywne jest zablokowane",
          notConfigured: "Nie skonfigurowano",
        },
        sources: {
          environment: "Środowisko",
          file: "Plik",
          command: "Polecenie",
          mixed: "Mieszane",
        },
      },
      connectedServiceTitle: "Połączona usługa",
      notFoundTitle: "Nie znaleziono dostawcy",
      notFoundSubtitle: "Ten dostawca nie ma ekranu ustawień.",
      noOptionsAvailable: "Brak dostępnych opcji",
      invalidNumber: "Nieprawidłowa liczba",
    invalidJson: "Nieprawidłowy JSON",
      plugins: {
            claude: {
                title: "Claude (zdalnie)",
                sections: {
                    claudeCodeExperiments: {
                        title: "Eksperymenty Claude Code",
                        footer: "Te ustawienia dotyczą zarówno lokalnych sesji Claude (terminal), jak i zdalnych sesji Claude (Agent SDK) uruchamianych przez Happier."
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK (tryb zdalny)",
                        footer: "Tryb zdalny uruchamia Claude na twojej maszynie, ale sterowany z interfejsu Happier. Tryb lokalny to TUI Claude Code w terminalu. Te ustawienia wpływają tylko na tryb zdalny."
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Wymuś włączenie Agent Teams",
                        subtitle: "Włącza eksperymentalne Agent Teams w Claude Code (rój agentów) we wszystkich sesjach Claude uruchamianych przez Happier."
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Użyj Agent SDK (zdalnie)",
                        subtitle: "Używa oficjalnego @anthropic-ai/claude-agent-sdk w trybie zdalnym."
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "Źródła ustawień",
                        subtitle: "Kontroluje, które ustawienia Claude są ładowane.",
                        options: {
                            user: {
                                title: "Użytkownik",
                                subtitle: "Ładuje globalną konfigurację użytkownika Claude."
                            },
                            project: {
                                title: "Projekt",
                                subtitle: "Ładuje ustawienia repozytorium (w tym CLAUDE.md)."
                            },
                            local: {
                                title: "Lokalne",
                                subtitle: "Ładuje tylko lokalne nadpisania."
                            }
                        }
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "Eksperymentalne: lokalny most uprawnień",
                        subtitle: "Przekazuje prośby o uprawnienia z lokalnego trybu Claude do Happier, aby można było je zatwierdzać lub odrzucać z interfejsu."
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "Trzymaj żądania otwarte do odpowiedzi",
                        subtitle: "Po włączeniu Happier utrzymuje lokalne prośby o uprawnienia Claude w oczekiwaniu, aż zatwierdzisz lub odrzucisz je w interfejsie."
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "Opcjonalny limit czasu uprawnień (sekundy)",
                        subtitle: "Używane tylko wtedy, gdy nieograniczone oczekiwanie jest wyłączone. Po tym czasie Happier wraca do terminalowego promptu Claude."
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "Punkty kontrolne plików + /rewind",
                        subtitle: "Włącza punkty kontrolne plików i /rewind (tylko pliki; nie cofa rozmowy). Użyj /checkpoints, aby wyświetlić listę, i /rewind --confirm, aby zastosować (większy narzut)."
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "Maksymalna liczba tokenów myślenia",
                        subtitle: "Ogranicza wewnętrzny budżet rozumowania Claude (null = domyślnie)."
                    },
                    claudeRemoteDisableTodos: {
                        title: "Wyłącz TODO",
                        subtitle: "Uniemożliwia Claude tworzenie elementów TODO w trybie zdalnym."
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "Ścisła konfiguracja serwera MCP",
                        subtitle: "Kończy się błędem, jeśli jakakolwiek konfiguracja serwera MCP jest nieprawidłowa."
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "Zaawansowane opcje (JSON)",
                        subtitle: "Zaawansowane nadpisania Agent SDK dla zaawansowanych użytkowników (walidowane po stronie klienta)."
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "Tryb backendu",
                        footer: "Tryb serwerowy odblokowuje pytania i natywny fork. Tryb ACP to starszy tryb awaryjny."
                    },
                    server: {
                        title: "Połączenie z serwerem",
                        footer: "Pozostaw puste, aby użyć zarządzanego przez Happier cyklu życia serwera OpenCode. Ustaw bezwzględny adres URL http(s), aby połączyć się z istniejącym serwerem OpenCode."
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "Tryb backendu OpenCode",
                        subtitle: "Wybierz backend integracyjny.",
                        options: {
                            server: {
                                title: "Serwer (zalecane)",
                                subtitle: "Używa serwerowych API OpenCode dla bogatszych funkcji i większej niezawodności."
                            },
                            acp: {
                                title: "ACP (starsze)",
                                subtitle: "Kieruje OpenCode przez ACP; mniej funkcji."
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "URL istniejącego serwera OpenCode",
                        subtitle: "Opcjonalne nadpisanie dla serwera OpenCode zarządzanego przez użytkownika."
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
                title: "Własny ACP"
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
              title: "Tryb routingu",
              footer:
                "Wybierz sposób routowania Codex. Serwer aplikacji to zalecany domyślny wybór. Przełączanie lokalne/zdalne i wznawianie działają z Serwerem aplikacji; ACP pozostaje dostępne jako starszy tryb awaryjny.",
            },
            installOverrides: {
              title: "Nadpisania źródła instalacji",
              footer:
                "Opcjonalne. Pozostaw puste, aby użyć domyślnych źródeł instalacji.",
            },
          },
          fields: {
            codexBackendMode: {
              title: "Tryb routingu Codex",
              subtitle: "Wybierz Serwer aplikacji, ACP lub MCP.",
              options: {
                appServer: {
                  title: "Serwer aplikacji",
                  subtitle: "Zalecany oficjalny tryb routingu dla Codex przez Serwer aplikacji",
                },
                acp: {
                  title: "ACP",
                  subtitle: "Kieruj Codex przez ACP (codex-acp)",
                },
                mcp: {
                  title: "MCP",
                  subtitle: "Domyślny tryb Codex MCP",
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
    itemDensity: "Gęstość elementów",
    itemDensityDescription: "Wybierz rozmiar wierszy list i ustawień w całej aplikacji",
    itemDensityOptions: {
      comfortable: "Domyślna",
      comfortableDescription: "Używa standardowego rozmiaru i odstępów wierszy",
      cozy: "Pośrednia",
      cozyDescription: "Używa nieco ciaśniejszych wierszy bez przechodzenia do widoku kompaktowego",
      compact: "Kompaktowa",
      compactDescription: "Wyświetla więcej wierszy na ekranie przy mniejszych odstępach",
    },
  },

  settingsChannelBridges: {
    unsupported: "Mosty kanałów nie są obsługiwane w tym środowisku.",
    enableInFeatures: "Włącz mosty kanałów",
    enableInFeaturesSubtitle: "Mosty kanałów są eksperymentalne i domyślnie wyłączone.",
    description: "Mosty kanałów pozwalają podłączać zewnętrzne czaty (Telegram) do sesji i przekazywać wiadomości do agenta.",
    telegramTitle: "Telegram",
    telegramFooter: "Skonfiguruj Telegram przez CLI, a następnie zarządzaj powiązaniami w Telegramie za pomocą /sessions, /attach, /detach, /help.",
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
      expEmbeddedTerminal: "Wbudowany terminal",
      expEmbeddedTerminalSubtitle:
        "Otwórz prawdziwy terminal w sesjach.",
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
      expChannelBridges: "Mosty kanałów",
      expChannelBridgesSubtitle: "Połącz Telegram i inne kanały czatu z sesjami Happier (eksperymentalne)",
      expMemorySearch: "Wyszukiwanie pamięci",
      expMemorySearchSubtitle:
        "Włącz ekrany i ustawienia lokalnego wyszukiwania pamięci",
    expSessionsDirect: "Sesje bezpośrednie",
    expSessionsDirectSubtitle: "Wyświetlaj i otwieraj na pasku bocznym bezpośrednie sesje dostawcy",
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
    permissionDeniedReadOnlyMode: "Odrzucono w trybie Tylko odczyt (akcje zapisu są odrzucane).",
    permissionCanceled: "Uprawnienie anulowane",
    permissionCanceledSessionInactive: "Sesja jest nieaktywna — nie można zatwierdzić tego żądania uprawnień.",
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
    voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
      `Limit sesji głosowej: około ${duration}.`,
    voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
      `Sesja głosowa zakończy się za około ${duration}.`,
    voiceSessionLimitExpired:
      "Sesja głosowa osiągnęła bieżący limit czasu i została zakończona.",
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
      "Serwer wznawiania Codex nie jest zainstalowany na tej maszynie",
    codexResumeNotInstalledMessage:
      "Aby wznowić rozmowę Codex, zainstaluj serwer wznawiania Codex na maszynie docelowej (Szczegóły maszyny → Installables).",
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
      },
      codexAcp: {
        title: "Adapter Codex ACP",
      },
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
      lastInstallLog: "Ostatni log instalacji",
      installLogTitle: "Log instalacji",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
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
	    checkout: {
	      selectTitle: "Wybierz punkt startowy",
	      noWorktree: "Bieżący folder",
          noWorktreeSubtitle: "Użyj już wybranego folderu bez łączenia go z checkoutem obszaru roboczego.",
          noWorktreeSectionTitle: "Bieżący folder",
	          existingWorktreesSectionTitle: "Połączone checkouty",
	          actionsSectionTitle: "Akcje",
		      newWorktree: "Nowy worktree",
		      newWorktreeSubtitle: "Utwórz i użyj nowego worktree Git dla tej sesji.",
              existingWorktree: "Istniejący worktree",
              existingWorktreeSubtitle: "Wybierz istniejący worktree Git dla tej sesji.",
              existingWorktreeEmptyTitle: "Brak istniejących worktree",
              existingWorktreeEmptySubtitle: "Najpierw utwórz worktree Git lub wybierz Nowy worktree.",
	          newWorktreeDetailWorkspace: "Utwórz nowy połączony checkout w tym obszarze roboczym.",
	          newWorktreeDetailBranch: "Zacznij od bieżącego stanu repozytorium i wybierz nową nazwę gałęzi/worktree.",
          branchPickerTitle: "Rozpocznij od",
          branchPickerCurrentHead: "Bieżąca gałąź",
          branchPickerCurrentHeadDescription: "Rozpocznij od gałęzi aktualnie wybranej w tym repozytorium.",
          branchPickerEmpty: "Brak dostępnych gałęzi dla tego repozytorium.",
          branchPickerSearchPlaceholder: "Szukaj gałęzi…",
          branchPickerRefreshA11y: "Odśwież gałęzie",
          branchPickerLoadingA11y: "Wczytywanie gałęzi",
          branchPickerRefreshingA11y: "Odświeżanie gałęzi",
          primaryDetailDescription: "Użyj głównego połączonego checkoutu tego obszaru roboczego na wybranej maszynie.",
          gitWorktreeDetailDescription: "Użyj istniejącego połączonego checkoutu Git worktree dla tej sesji.",
          existingBranchWorktreeDescription: "Ta gałąź ma już worktree. Możesz użyć go bezpośrednio albo utworzyć z niej nową gałąź.",
          existingBranchDescription: "Ta gałąź może być użyta bezpośrednio w nowym worktree albo możesz utworzyć z niej nową gałąź.",
          createNewBranchFromBranchHint: "Użyj opcji Zastosuj, aby utworzyć z tej gałęzi nową gałąź i worktree.",
          useExistingBranchAction: "Użyj istniejącej gałęzi",
          useExistingWorktreeAction: "Użyj istniejącego worktree",
          detailBranch: ({ branch }: { branch: string }) => `Gałąź: ${branch}`,
          detailPath: ({ path }: { path: string }) => `Ścieżka: ${path}`,
          detailLinkedWorkspace: "Połączone z bieżącym obszarem roboczym.",
	    },
	    selectSessionTypeTitle: "Wybierz typ sesji",
	    selectSessionTypeDescription:
	      "Wybierz sesję prostą albo sesję powiązaną z worktree Git.",
	    searchPathsPlaceholder: "Szukaj ścieżek...",
	    noMachinesFound:
	      "Nie znaleziono maszyn. Najpierw uruchom sesję Happier na swoim komputerze.",
	    allMachinesOffline: "Wszystkie maszyny są poza siecią",
	    machineOfflineInlineTitle: "Maszyna jest offline",
	    machineOfflineInlineBody:
	      "Uruchom demona na tej maszynie lub wybierz inną maszynę przed utworzeniem sesji.",
	    machineOfflineCannotStartStatus: "offline (nie można rozpocząć sesji)",
        automationChip: {
            default: 'Automatyzuj',
            interval: ({ minutes }: { minutes: number }) => `Co ${minutes} min`,
            cron: 'Harmonogram cron',
        },
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
      truncatedDirectoryInfo: ({ count }: { count: number }) => `Pokazano pierwsze ${count} elementy`,
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
    profileSelection: {
      workspaceDefault: "Domyślne dla workspace",
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
      chipOptional: ({ agent }: { agent: string }) => `Wznów sesję ${agent}`,
      pickerTitle: "Wznów sesję",
      subtitle: ({ agent }: { agent: string }) =>
        `Wklej ID sesji ${agent}, aby wznowić`,
      placeholder: ({ agent }: { agent: string }) => `Wklej ID sesji ${agent}…`,
      browse: "Przeglądaj sesje",
      paste: "Wklej",
      save: "Zapisz",
      clearAndRemove: "Wyczyść",
      helpText: "ID sesji znajdziesz na ekranie informacji o sesji.",
      cannotApplyBody:
        "Nie można teraz zastosować tego ID wznowienia. Happier uruchomi zamiast tego nową sesję.",
    },
    codexResumeBanner: {
      title: "Serwer wznawiania Codex",
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
      installTitle: "Zainstalować serwer wznawiania Codex?",
      updateTitle: "Zaktualizować serwer wznawiania Codex?",
      reinstallTitle: "Zainstalować ponownie serwer wznawiania Codex?",
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

  sessionHandoff: sessionHandoffTranslationExtensions.pl,

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
	    rollback: {
	      latestTurnA11y: 'Cofnij ostatnia ture',
	      beforeUserMessageA11y: 'Cofnij do chwili przed ta wiadomoscia',
	    },
	    resuming: "Wznawianie...",
	    resumeFailed: "Nie udało się wznowić sesji",
	    pendingQueuedResumeFailedTitle: "Wiadomość w kolejce",
	    pendingQueuedResumeFailedBody:
	      "Twoja wiadomość została zapisana w kolejce oczekujących, ale Happier nie mógł wznowić tej sesji. Spróbuj ponownie, aby ją uruchomić.",
	    invalidLinkTitle: "Nieprawidłowy link do sesji",
	    invalidLinkDescription: "Link do sesji jest brakujący lub nieprawidłowy. Sprawdź URL i spróbuj ponownie.",
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
        openSubagents: ({ count }: { count: number }) => (count > 0 ? `Otwórz podagentów (${count})` : 'Otwórz podagentów'),
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
            typeFact: ({ value }: { value: string }) => `Typ: ${value}`,
            providerFact: ({ value }: { value: string }) => `Dostawca: ${value}`,
            backendFact: ({ value }: { value: string }) => `Backend: ${value}`,
            intentFact: ({ value }: { value: string }) => `Intencja: ${value}`,
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
            subagent_sidechain: "Podagent",
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
          unpinTabA11y: "Odepnij kartę",
          pinnedTabA11y: "Przypięta karta",
          closeTabA11y: "Zamknij kartę",
          enterFocusModeA11y: "Włącz tryb skupienia edytora",
          exitFocusModeA11y: "Wyłącz tryb skupienia edytora",
      },
  
      actionsDraft: {
        noInputHints: "Ta akcja nie ma podpowiedzi wejściowych.",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `${field} jest wymagane.`,
        },
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
      questionsTitle: "Pytania recenzenta",
      assumptionsTitle: "Założenia",
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
        untriaged: "Oczekuje",
        accept: "Wprowadź poprawkę",
        reject: "Ignoruj",
        defer: "Zdecyduj później",
        needsRefinement: "Poproś o wyjaśnienie",
      },
      refinementPlaceholder: "Co wymaga wyjaśnienia?",
      actions: {
        applyTriage: "Zastosuj działania przeglądu",
        applying: "Zastosowywanie…",
        askReviewer: "Zapytaj recenzenta",
        answerQuestion: "Odpowiedz recenzentowi",
        applyAcceptedFindings: "Wprowadź wybrane poprawki",
        sendFollowUp: "Wyślij doprecyzowanie",
        sending: "Wysyłanie…",
      },
      errors: {
        applyTriageFailed: "Nie udało się zastosować działań przeglądu.",
        followUpFailed: "Nie udało się wysłać doprecyzowania przeglądu.",
        applyAcceptedFailed: "Nie udało się wysłać wybranych poprawek.",
      },
    },

      pendingMessages: {
        title: "Wiadomości oczekujące",
        indicator: ({ count }: { count: number }) => `Oczekujące (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `Oczekujące (+${count})` : "Oczekujące",
	        empty: "Brak oczekujących wiadomości.",
	        decryptFailed: "Nie udało się odszyfrować tej oczekującej wiadomości.",
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
      bargeIn: "Przerwij",
      cancelTurn: "Anuluj odpowiedź",
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

  devVoiceQa: {
    menuTitle: "Panel QA głosu",
    menuSubtitle: "Steruj prawdziwym agentem głosowym za pomocą tekstowych promptów",
    title: "Panel QA głosu",
    subtitle: "Uruchom skonfigurowane środowisko głosowe i wysyłaj prompty bez używania mikrofonu.",
    instructions: "Użyj tego ekranu, aby testować prawdziwego lokalnego agenta głosowego lub sesję ElevenLabs za pomocą deterministycznych promptów tekstowych. Pozostaw identyfikator sesji pusty, aby kierować na bieżący cel głosowy albo globalną sesję agenta głosowego.",
    configurationTitle: "Konfiguracja",
    configuredProvider: "Skonfigurowany dostawca",
    qaProvider: "Aktywny dostawca QA",
    qaStatus: "Stan QA",
    targetSession: "Bieżąca sesja docelowa",
    runtimeSession: "Aktywna sesja środowiska",
    inputsTitle: "Dane wejściowe",
    sessionIdLabel: "Nadpisanie ID sesji",
    sessionIdPlaceholder: "Pozostaw puste, aby użyć bieżącego celu głosowego",
    initialContextLabel: "Kontekst początkowy",
    initialContextPlaceholder: "Opcjonalny kontekst wysyłany przy starcie sesji QA",
    promptLabel: "Polecenie",
    promptPlaceholder: "Wpisz tekst, który chcesz wysłać do agenta głosowego",
    contextUpdateLabel: "Aktualizacja kontekstu",
    contextUpdatePlaceholder: "Opcjonalna późniejsza aktualizacja kontekstu",
    actionsTitle: "Akcje",
    sendContext: "Wyślij kontekst",
    usesCurrentProvider: "Ten panel zawsze używa bieżących ustawień głosu i prawdziwych integracji środowiska.",
    localModeHint: "Lokalne QA wymaga Local voice z trybem rozmowy ustawionym na Agent.",
    elevenLabsHint: "QA ElevenLabs wymaga skonfigurowanego dostawcy ElevenLabs i pomyślnego połączenia sesji czasu rzeczywistego.",
    transcriptTitle: "Transkrypt QA",
    transcriptEmpty: "Brak transkryptu QA.",
    activityTitle: "Aktywność głosowa",
    activityEmpty: "Brak zarejestrowanej aktywności głosowej dla bieżącej sesji QA.",
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Ustawienia Relay",
    enterServerUrl: "Proszę wprowadzić URL Relay",
    notValidHappyServer: "To nie jest prawidłowy Relay Happier",
    changeServer: "Zmień Relay",
    continueWithServer: "Kontynuować z tym Relay?",
    resetToDefault: "Resetuj do domyślnego",
    resetServerDefault: "Zresetować Relay do domyślnego?",
    validating: "Sprawdzanie...",
    validatingServer: "Sprawdzanie Relay...",
    serverReturnedError: "Relay zwrócił błąd",
    failedToConnectToServer: "Nie udało się połączyć z Relay",
    currentlyUsingCustomServer: "Aktualnie używany jest niestandardowy Relay",
    customServerUrlLabel: "URL niestandardowego Relay",
    advancedFeatureFooter:
      "To jest zaawansowana funkcja. Zmieniaj Relay tylko jeśli wiesz, co robisz. Po zmianie Relay będziesz musiał się wylogować i zalogować ponownie.",
    useThisServer: "Użyj tego Relay",
    autoConfigHint:
      "Jeśli hostujesz samodzielnie: najpierw skonfiguruj Relay, potem zaloguj się (lub utwórz konto), a na końcu połącz terminal.",
    renameServer: "Zmień nazwę Relay",
    renameServerPrompt: "Wpisz nową nazwę tego Relay.",
    renameServerGroup: "Zmień nazwę grupy Relay",
    renameServerGroupPrompt: "Wpisz nową nazwę tej grupy Relay.",
    serverNamePlaceholder: "Nazwa Relay",
    cannotRenameCloud: "Nie możesz zmienić nazwy Relay w chmurze.",
    removeServer: "Usuń Relay",
    removeServerConfirm: ({ name }: { name: string }) =>
      `Usunąć "${name}" z zapisanych Relay?`,
    removeServerGroup: "Usuń grupę Relay",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `Usunąć "${name}" z zapisanych grup Relay?`,
    cannotRemoveCloud: "Nie możesz usunąć Relay w chmurze.",
    signOutThisServer: "Czy wylogować się także z tego Relay?",
    signOutThisServerPrompt:
      "Na tym urządzeniu znaleziono zapisane dane logowania dla tego Relay.",
    savedServersTitle: "Zapisane Relaye",
    signedIn: "Zalogowano",
    signedOut: "Wylogowano",
    authStatusUnknown: "Nieznany stan uwierzytelnienia",
    switchToServer: "Przełącz na ten Relay",
    active: "Aktywny",
    default: "Domyślny",
    addServerTitle: "Dodaj Relay",
    switchForThisTab: "Przełącz dla tej karty",
    makeDefaultOnDevice: "Ustaw jako domyślny na tym urządzeniu",
    serverNameLabel: "Nazwa Relay",
    addAndUse: "Dodaj i użyj",
    addTargetsTitle: "Dodaj",
    addServerSubtitle: "Dodaj nowy Relay i przełącz na niego",
    notificationAddServerHint: "Ten Relay nie jest jeszcze zapisany na tym urządzeniu. Dodaj go poniżej, aby kontynuować.",
    serverCount: ({ count }: { count: number }) =>
      `${count} ${plural({ count, one: "Relay", few: "Relaye", many: "Relayów" })}`,
    useCanonicalServerUrlTitle: "Użyć kanonicznego URL Relay?",
    useCanonicalServerUrlBody:
      "Ten Relay podaje kanoniczny adres URL, który powinien działać z innych urządzeń. Użyć go zamiast wprowadzonego?",
    insecureHttpUrlTitle: "Niezabezpieczony URL Relay",
    insecureHttpUrlBody:
      "Ten adres URL używa http:// i może nie działać z telefonu lub spoza Twojej sieci LAN. Jeśli to możliwe, użyj HTTPS. Kontynuować mimo to?",
    signedOutSwitchConfirmTitle: "Nie jesteś połączony",
    signedOutSwitchConfirmBody:
      "Przełączyć na ten Relay i przejść do ekranu głównego, aby móc się zalogować lub utworzyć konto?",
    addServerGroupTitle: "Dodaj grupę Relay",
    addServerGroupSubtitle: "Utwórz wielokrotnie używaną grupę Relay",
    serverGroupNameLabel: "Nazwa grupy",
    serverGroupNamePlaceholder: "Moja grupa Relay",
    serverGroupServersLabel: "Relaye",
    saveServerGroup: "Zapisz grupę",
    serverGroupMustHaveServer:
      "Grupa Relay musi zawierać co najmniej jeden Relay.",
    relayDrift: {
        bannerDifferentRelayTitle: 'Usługa w tle jest połączona z innym Relay',
        bannerDifferentRelayDescription: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) => `Aplikacja: ${activeRelayUrl} · Usługa w tle: ${daemonRelayUrl}`,
        bannerNeedsAuthTitle: 'Usługa w tle musi zalogować się do tego Relay',
        bannerNeedsAuthDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `Aplikacja używa ${activeRelayUrl}, ale usługa w tle nadal potrzebuje zatwierdzenia lub logowania.`,
        bannerNotConfiguredTitle: 'Usługa w tle nie jest jeszcze połączona z tym Relay',
        bannerNotConfiguredDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `Aplikacja używa ${activeRelayUrl}, ale ten komputer nie zakończył jeszcze łączenia usługi w tle.`,
        bannerNotInstalledTitle: 'Usługa w tle nie jest zainstalowana dla tego Relay',
        bannerNotInstalledDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `Aplikacja używa ${activeRelayUrl}, ale ten komputer nadal musi zainstalować usługę w tle dla tego Relay.`,
        bannerNotRunningTitle: 'Usługa w tle jest zainstalowana, ale nie działa',
        bannerNotRunningDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `Aplikacja używa ${activeRelayUrl}, ale usługa w tle jest zatrzymana i trzeba ją ponownie uruchomić.`,
        repairAction: 'Połącz usługę w tle z tym Relay',
        progressTitle: 'Łączenie usługi w tle z tym Relay',
        progressStepPrepare: 'Przygotuj usługę w tle',
        progressStepConfigureRelay: 'Zaktualizuj połączenie z Relay',
        progressStepAuthenticate: 'Dokończ logowanie i zatwierdzanie',
        progressStepFinish: 'Zakończ naprawę',
        statusUnknown: 'Nieznany',
    },
    retention: {
      title: "Polityka retencji",
      summary: "Podsumowanie",
      keepForever: "Bez automatycznego usuwania",
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Usuwa nieaktywne sesje po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Usuwa dane po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}.`,
      sessionNotice: ({ count }: { count: number }) => `Ten serwer usuwa nieaktywne sesje po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })} bezczynności.`,
      sessions: "Sesje",
      accountChanges: "Zmiany konta",
      voiceSessionLeases: "Dzierzawy sesji glosowych",
      feedItems: "Elementy kanalu",
      sessionShareAccessLogs: "Logi dostepu do udostepnionych sesji",
      publicShareAccessLogs: "Logi dostepu do publicznych udostepnien",
      terminalAuthRequests: "Zadania uwierzytelnienia terminala",
      accountAuthRequests: "Zadania uwierzytelnienia konta",
      authPairingSessions: "Sesje parowania uwierzytelniania",
      repeatKeys: "Klucze powtorzen",
      globalLocks: "Blokady globalne",
      automationRuns: "Uruchomienia automatyzacji",
      automationRunEvents: "Zdarzenia uruchomien automatyzacji",
    },
    multiServerView: {
      title: "Równoległy widok wielu Relay",
      footer: "Wybierz, czy łączyć wiele Relay w jednej liście sesji.",
      enableTitle: "Włącz widok równoległy",
      enableSubtitle: "Pokazuj razem sesje z wybranych Relay",
      presentationTitle: "Tryb prezentacji",
      presentation: {
        flatWithBadges: "Płaska lista z odznakami Relay",
        groupedByServer: "Pogrupowane według Relay",
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
    storagePersistedTab: "Synchronizowane",
    storageDirectTab: "Bezpośrednie",
    renameWorkspace: 'Zmień nazwę przestrzeni roboczej',
    renameWorkspacePromptTitle: 'Zmień nazwę przestrzeni roboczej',
    renameWorkspacePromptPlaceholder: 'Wprowadź nazwę...',
    resetWorkspaceName: 'Resetuj nazwę',
  },

  directSessions: {
    browseTitle: "Przeglądaj sesje dostawcy",
    browseOpenExisting: "Przeglądaj sesje dostawcy",
    browseFiltersTitle: "Wybierz źródło",
    browseMachines: "Maszyny",
    browseProviders: "Dostawcy",
    browseSources: "Źródła",
    browseSourceCodexUserHome: "Mój katalog Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} connected services`,
    browseSourceClaudeDefault: "Domyślna konfiguracja Claude",
    browseSourceOpenCodeDefault: "Domyślny serwer OpenCode",
    browseCandidates: "Dostępne sesje",
    browseNoMachines: "Na razie nie ma dostępnych maszyn dla sesji bezpośrednich.",
    browseNoCandidates: "Nie znaleziono sesji dostawcy dla tej maszyny i dostawcy.",
    browseActivityRunning: "Uruchomiona",
        browseActivityRunningNow: "Uruchomiona teraz",
    browseActivityRecent: "Niedawna",
    browseActivityIdle: "Bezczynna",
    browseActivityUnknown: "Nieznana",
        browseSearchPlaceholder: "Szukaj wczytanych sesji…",
        browseNoSearchResults: "Żadna wczytana sesja nie pasuje jeszcze do tego wyszukiwania.",
    browseLoadMore: "Wczytaj więcej sesji",
    browseFailedToLoad: "Nie udało się wczytać sesji dostawcy.",
    browseLinkFailed: "Nie udało się połączyć wybranej sesji dostawcy.",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: 'Główny checkout',
            git_worktree: 'Worktree Git',
        },
    },
    sourceControlWorkspace: {
        createTitle: 'Utwórz połączony obszar roboczy',
        createSubtitle: 'Dodaj ten checkout do połączonego obszaru roboczego i otwórz jego ustawienia.',
        otherCheckoutsTitle: 'Inne checkouty',
        unlinkedWorktreesTitle: 'Niepołączone worktree\'y',
        createSessionInWorktreeTitle: 'Utwórz tutaj sesję',
        adoptWorktreeTitle: 'Dodaj worktree do obszaru roboczego',
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
    workspaceTitle: "Obszar roboczy",
    workspaceLabel: "Obszar roboczy",
    linkWorkspaceTitle: "Połącz ten obszar roboczy",
    linkWorkspaceSubtitle: "Utwórz połączony obszar roboczy z tej ścieżki sesji i otwórz jego ustawienia.",
    openWorkspaceTitle: "Otwórz obszar roboczy",
    openWorkspaceSubtitle: "Otwórz szczegóły i ustawienia połączonego obszaru roboczego.",
    createWorktreeTitle: "Utwórz worktree",
    createWorktreeSubtitle: "Uruchom nową sesję, która utworzy Git worktree w tym połączonym obszarze roboczym.",
    locationLabel: "Lokalizacja",
    checkoutLabel: "Wybrany checkout",
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
    kiroSessionId: "ID sesji Kiro",
    kiroSessionIdCopied: "ID sesji Kiro skopiowane do schowka",
    customAcpSessionId: "ID sesji niestandardowego ACP",
    customAcpSessionIdCopied: "ID sesji niestandardowego ACP skopiowane do schowka",
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
      "Proszę uruchomić happier self update",
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
      kiro: "Kiro",
      customAcp: "Custom ACP",
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
      status: "Stan",
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
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `Utwórz subagenta: ${subject}`,
      createTask: "Utwórz subagenta",
      listTasks: "Pokaż subagentów",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `Zaktualizuj subagenta ${id} → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `Zaktualizuj subagenta ${id}`,
      updateTask: "Zaktualizuj subagenta",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `+${count} narzędzi więcej`,
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
      turnDiffRecap: "Podsumowanie zmian z tej tury",
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
	    repositoryTree: {
	      actions: {
	        copyPath: "Kopiuj ścieżkę",
	        download: "Pobierz",
	        downloadAsZip: "Pobierz jako ZIP",
	      },
	      dropToUpload: "Upuść pliki, aby przesłać",
	      rename: {
	        title: "Zmień nazwę",
	        body: "Wprowadź nową ścieżkę względną względem katalogu głównego projektu.",
	        invalidPath:
	          "Nieprawidłowa ścieżka. Użyj ścieżki względnej w obrębie workspace, np. src/new-file.ts.",
	        failed: "Nie udało się zmienić nazwy.",
	        conflicts: {
	          title: "Element docelowy już istnieje",
	          body: ({ path }: { path: string }) => `"${path}" już istnieje. Co chcesz zrobić?`,
	        },
	      },
	      deleteFolder: {
	        title: "Usunąć folder?",
	        body: ({ path }: { path: string }) =>
	          `Usunąć folder ${path} i całą jego zawartość?`,
	        confirm: "Usuń folder",
	      },
	      deleteFile: {
	        title: "Usunąć plik?",
	        body: ({ path }: { path: string }) => `Usunąć plik ${path}?`,
	      },
	      delete: {
	        failed: "Nie udało się usunąć.",
	      },
	      download: {
	        notReady: "Pobieranie nie jest jeszcze dostępne.",
	      },
	    },
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
    branchSwitchDialog: {
      title: "Przełącz gałąź",
      body: "Masz niezacommitowane zmiany. Jak chcesz je obsłużyć?",
      leaveTitle: ({ branch }: { branch: string }) => `Zostaw moje zmiany na ${branch}`,
      leaveSubtitle: "Utwórz stash na bieżącej gałęzi i przełącz.",
      bringTitle: ({ branch }: { branch: string }) => `Przenieś moje zmiany na ${branch}`,
      bringSubtitle: "Spróbuj przełączyć i zachować zmiany na nowej gałęzi.",
    },
    branchMenu: {
      openA11y: "Otwórz menu gałęzi",
      failedToLoad: "Nie udało się wczytać gałęzi.",
      unavailable: "Lista gałęzi niedostępna",
      empty: "Nie znaleziono gałęzi",
      searchPlaceholder: "Szukaj gałęzi...",
      category: {
        actions: "Akcje",
        branches: "Gałęzie",
        worktrees: "Worktree'y",
        remote: "Zdalne",
        local: "Lokalne",
        options: "Opcje",
      },
      publish: {
        title: "Opublikuj gałąź",
        subtitle: "Wypchnij bieżącą gałąź do zdalnej gałęzi upstream",
        short: "Opublikuj",
        failed: "Nie udało się opublikować gałęzi.",
      },
      create: {
        title: "Utwórz gałąź",
        subtitle: ({ name }: { name: string }) => `Utwórz "${name}"`,
        failed: "Nie udało się utworzyć gałęzi.",
      },
      switch: {
        failed: "Nie udało się przełączyć gałęzi.",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `Upstream: ${upstream}`,
      },
      remotes: {
        show: "Pokaż gałęzie zdalne",
        hide: "Ukryj gałęzie zdalne",
        subtitle: "Uwzględniaj gałęzie zdalne na liście",
      },
      worktrees: {
        createFromCurrentBranchTitle: "Nowy worktree z bieżącej gałęzi",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) => `Utwórz nowy worktree z ${branch} i rozpocznij tam sesję.`,
        createFromCurrentBranchDetachedSubtitle: "Przełącz się na gałąź przed utworzeniem worktree z bieżącej gałęzi.",
        createFromAnotherBranchTitle: "Nowy worktree z innej gałęzi",
        createFromAnotherBranchSubtitle: "Otwórz przepływ nowej sesji, aby wybrać inną gałąź lub użyć istniejącego worktree.",
        removeTitle: "Usuń worktree",
        removeSubtitle: ({ target }: { target: string }) => `Usuń ${target} z tego repozytorium.`,
        removeConfirmTitle: "Usunąć worktree?",
        removeConfirmBody: ({ path }: { path: string }) => `Usunąć worktree w lokalizacji ${path}? Tego nie można cofnąć.`,
        removeConfirmButton: "Usuń worktree",
        pruneTitle: "Oczyść nieaktualne worktree",
        pruneSubtitle: "Wyczyść nieaktualne metadane worktree dla tego repozytorium.",
        createFailed: "Nie udało się utworzyć worktree.",
        removeFailed: "Nie udało się usunąć worktree.",
        pruneFailed: "Nie udało się oczyścić worktree.",
      },
      stashOverwrite: {
        title: "Nadpisać stash gałęzi?",
        body: ({ branch }: { branch: string }) =>
          `Stash dla ${branch} już istnieje. Nadpisać go?`,
        confirm: "Nadpisz stash",
      },
    },
    stash: {
      summaryA11y: "Otwórz szczegóły stash",
      summaryTitle: "Zarządzane stashe",
      detailsTitle: "Zarządzane stashe",
      empty: "Brak zarządzanych stashy.",
      failedToLoad: "Nie udało się załadować stashy.",
      failedToLoadDiff: "Nie udało się załadować diffu stasha.",
      diffTruncated: "Diff ucięty (limit wyjścia).",
      writeDisabled: "Operacje zapisu kontroli źródła są wyłączone.",
      noSelection: "Wybierz stash, aby kontynuować.",
      selectA11y: ({ stash }: { stash: string }) => `Wybierz stash ${stash}`,
      restore: "Przywróć",
      discard: "Odrzuć",
      restoreFailed: "Nie udało się przywrócić stasha.",
      discardFailed: "Nie udało się odrzucić stasha.",
      restoreConfirm: {
        title: "Przywrócić zmiany ze stasha?",
        body: "Zastosuje zmiany ze stasha do katalogu roboczego. Konflikty mogą wymagać ręcznego rozwiązania.",
        confirm: "Przywróć",
      },
      discardConfirm: {
        title: "Odrzucić zmiany ze stasha?",
        body: "To trwale usunie ten stash.",
        confirm: "Odrzuć",
      },
    },
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
    latestTurnChanges: ({ count }: { count: number }) =>
      `Zmiany ostatniej tury (${count})`,
    latestTurnDescription:
      'Zmiany pochodzące od dostawcy z ostatnio zakończonej tury.',
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
    noLatestTurnChanges:
      "Obecnie nie wykryto zmian ostatniej tury.",
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
      fileTooLargeToPreview: "Plik jest zbyt duży, aby go wyświetlić",
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
	          suggestionReady: "Sugestia jest gotowa. Zastosować ją?",
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
	      hiddenFiles: "Pokaż ukryte pliki",
	      details: "Szczegóły",
	      upload: "Prześlij",
	      uploadFiles: "Prześlij pliki",
	      uploadFolder: "Prześlij folder",
	      allRepositoryFiles: "Wszystkie pliki repozytorium",
      repositoryView: "Widok repozytorium",
      turnView: "Widok tury",
      sessionView: "Widok sesji",
      review: "Przegląd",
      list: "Lista",
      scm: "Git",
    },
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `Przygotowywanie wysyłania (${count} plików)…`,
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
      }) => `Wysyłanie ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `Pobieranie ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "Konflikty przesyłania",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount} z ${totalCount} plików już istnieje. Co chcesz zrobić?`,
        keepBoth: {
          title: "Zachowaj oba",
          subtitle: "Dodaj „ (1)”, „ (2)”, … do nazw w konflikcie.",
        },
        replace: {
          title: "Zastąp",
          subtitle: "Nadpisz istniejące pliki.",
        },
        skip: {
          title: "Pomiń",
          subtitle: "Prześlij tylko pliki, które jeszcze nie istnieją.",
        },
      },
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
      titles: {
        executionRun: "Uruchomienie",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent} · uruchomienie`,
      },
      labels: {
        status: "Stan",
        statusValue: ({ value }: { value: string }) => `Status: ${value}`,
        runId: ({ value }: { value: string }) => `Run ID: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permissions: ${value}`,
        mode: ({ value }: { value: string }) => `Mode: ${value}`,
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

        settingsActions: {
        aboutSubtitle: 'Wybierz, gdzie każda akcja ma być widoczna w aplikacji, w głosie i w integracjach. Niedostępne kafelki pozostają widoczne, aby było jasne, co blokują funkcje, prywatność lub obsługa środowiska uruchomieniowego.',
        aboutFooter: 'Te ustawienia obowiązują globalnie jako domyślne dla konta. Niedostępne kafelki wyjaśniają, dlaczego dany cel jest obecnie zablokowany.',
        searchPlaceholder: 'Wyszukaj akcje',
        noResults: 'Żadne akcje nie pasują do bieżącego wyszukiwania.',
        noDescription: 'Opis nie jest jeszcze dostępny.',
        requireApproval: 'Wymagaj zatwierdzenia',
        sections: {
            app: 'W aplikacji',
            voice: 'Głos',
            integrations: 'Integracje',
        },
        badges: {
            unavailable: 'Niedostępne',
        },
        reasons: {
            voiceFeature: 'Włącz ustawienia Asystenta głosowego, aby użyć tego celu.',
            voiceInventoryPrivacy: 'Włącz opcję Udostępnij inwentarz urządzenia w ustawieniach prywatności Asystenta głosowego, aby użyć tego celu.',
            mcpFeature: 'Włącz serwery MCP, aby wystawiać tę akcję przez MCP.',
            executionRunsFeature: 'Włącz execution runs, aby użyć tej akcji lub celu.',
            memorySearchFeature: 'Włącz lokalne wyszukiwanie pamięci, aby użyć tej akcji.',
            sessionHandoffFeature: 'Włącz obsługę handoff sesji, aby użyć tej akcji.',
            notAvailableInThisApp: 'To miejsce wyświetlania nie jest jeszcze dostępne w tym kliencie.',
        },
        targets: {
            session_header: {
                title: 'Nagłówek sesji',
                subtitle: 'Widoczne na pasku narzędzi nagłówka sesji.',
            },
            session_action_menu: {
                title: 'Menu sesji',
                subtitle: 'Widoczne w menu akcji sesji.',
            },
            session_info: {
                title: 'Szczegóły sesji',
                subtitle: 'Widoczne na ekranie informacji o sesji.',
            },
            command_palette: {
                title: 'Paleta poleceń',
                subtitle: 'Widoczne w globalnej palecie poleceń.',
            },
            slash_command: {
                title: 'Polecenie slash',
                subtitle: 'Dostępne z selektorów akcji w stylu slash-command.',
            },
            agent_input_chips: {
                title: 'Kafelki kompozytora',
                subtitle: 'Wyświetlane jako szybkie kafelki obok pola wprowadzania agenta.',
            },
            voice_panel: {
                title: 'Panel głosowy',
                subtitle: 'Wyświetlane w panelu asystenta głosowego.',
            },
            run_list: {
                title: 'Lista uruchomień',
                subtitle: 'Widoczne na listach execution run.',
            },
            run_card: {
                title: 'Karty uruchomień',
                subtitle: 'Widoczne na kartach execution run.',
            },
            voice_tool: {
                title: 'Narzędzie głosowe',
                subtitle: 'Dostępne dla agenta głosowego jako wywoływalne narzędzie.',
            },
            voice_action_block: {
                title: 'Blok akcji głosowej',
                subtitle: 'Wyświetlane wewnątrz bloków akcji głosowej i ich elementów.',
            },
            session_agent: {
                title: 'Agent sesji',
                subtitle: 'Dostępne dla agentów w sesji jako wywoływalne narzędzie.',
            },
            mcp: {
                title: 'MCP',
                subtitle: 'Dostępne przez katalog akcji MCP.',
            },
            cli: {
                title: 'CLI sterowania sesją',
                subtitle: 'Dostępne przez interfejs CLI sterowania sesją.',
            },
            contextual_ui: {
                title: 'Interfejs kontekstowy',
                subtitle: 'Wyświetlane w kontekstowych powierzchniach UI bez dedykowanego miejsca.',
            },
        },
    },

settingsSession: {
      sessionList: {
          title: 'Lista sesji',
          footer: 'Dostosuj, co jest widoczne w wierszu sesji.',
          tagsTitle: 'Tagi sesji',
          tagsEnabledSubtitle: 'Kontrolki tagów widoczne na liście sesji',
          tagsDisabledSubtitle: 'Kontrolki tagów ukryte',
      },
      input: {
          title: 'Wprowadzanie',
          footer: 'Skonfiguruj wygląd i działanie paska wprowadzania agenta.',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Domyślny tryb zdalnej sesji Windows',
      },
      advanced: {
          title: 'Zaawansowane',
      },
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
        codeDiffs: 'Kod i diffy',
        codeDiffsFooter: 'Skonfiguruj sposób wyświetlania kodu i diffów w transkrypcie.',
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
      handoff: settingsSessionHandoffTranslationExtensions.pl,
      defaultPermissions: {
        title: "Domyślne uprawnienia",
        footer:
          "Stosowane przy uruchamianiu nowej sesji. Profile mogą to opcjonalnie nadpisać.",
        applyPermissionChangesTitle: "Zastosuj zmiany uprawnień",
        applyPermissionChangesImmediateSubtitle:
          "Zastosuj od razu w działających sesjach (aktualizuje metadane sesji).",
        applyPermissionChangesNextPromptSubtitle: "Zastosuj tylko przy następnej wiadomości.",
      },
          defaultStorage: {
              title: 'Domyślny magazyn sesji',
              footer: 'Wybierz, czy nowe sesje mają zaczynać jako synchronizowane sesje Happier, czy jako bezpośrednie sesje oparte na dostawcy.',
              globalTitle: 'Domyślne globalne',
              persistedSubtitle: 'Domyślnie zapisuj nowe sesje w Happier i synchronizuj je między urządzeniami.',
              directSubtitle: 'Uruchamiaj bezpośrednie sesje powiązane z maszyną, gdy dostawca to obsługuje.',
              globalSubtitle: ({ label }: { label: string }) => `Domyślne globalne: ${label}`,
              useGlobalDefault: 'Użyj domyślnego globalnego',
              currently: ({ label }: { label: string }) => `Aktualnie: ${label}`,
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
  },

  windowsRemoteSessionLaunchMode: {
    hidden: "Ukryty",
    shortHidden: "Ukryty",
    hiddenSubtitle: "Uruchom sesję w tle bez otwierania okna terminala.",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "Otwórz sesję w osobnym oknie Windows Terminal.",
    console: "Konsola",
    shortConsole: "Konsola",
    consoleSubtitle: "Otwórz sesję w standardowym oknie konsoli Windows.",
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
	        actions: {
	          createNew: "Utwórz nowy",
	          updateExisting: "Zaktualizuj istniejący",
	        },
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
        machineRecovery: {
          switchTitle: "Maszyna głosowa jest niedostępna",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `Bieżąca maszyna głosowa (${currentMachine}) jest niedostępna.\n\nPrzełączyć głos na ${nextMachine}?`,
          switchAction: "Przełącz maszynę",
          replayTitle: "Przenieść rozmowę?",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `Możesz zacząć od nowa na ${nextMachine} albo przełączyć maszynę i odtworzyć ostatni kontekst głosowy z poprzedniej maszyny.`,
          replayAction: "Przełącz i odtwórz ostatni kontekst głosowy",
          startFreshAction: "Zacznij od nowa",
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
          enableSubtitle:
            "Przesyłaj częściowy tekst agenta w trakcie generowania (używane do mowy w streamingu).",
          enableTtsTitle: "Włącz strumieniowanie TTS",
          enableTtsSubtitle:
            "Wypowiadaj odpowiedź podczas streamingu (wymaga streamingu).",
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

  terminalEmbedded: {
    dockMenuA11y: "Dokuj terminal",
    settings: {
      locationTitle: "Lokalizacja wbudowanego terminala",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "Enter ↵",
    },
    location: {
      sidebar: "Panel boczny",
      details: "Panel szczegółów",
      bottom: "Panel dolny",
    },
    errors: {
      missingMachineTarget: "Ta sesja nie ma ustawionego celu maszyny.",
      rpcTargetUnavailable: "RPC maszyny jest niedostępne dla tej maszyny.",
      machineUnreachable: "Nie można połączyć się z maszyną.",
      disabled: "Obsługa terminala jest wyłączona w konfiguracji demona. Włącz ją i uruchom ponownie demona.",
      notFound: "Nie znaleziono sesji terminala. Spróbuj uruchomić ponownie.",
      cwdDenied: "Demon nie ma uprawnień do użycia tego katalogu roboczego.",
      spawnFailed: "Nie udało się uruchomić procesu terminala.",
      invalidRequest: "Nieprawidłowe żądanie terminala.",
      busy: "Terminal jest zajęty. Spróbuj ponownie.",
    },
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
      "Domyślnie szyfrowane end-to-end, z przywracaniem konta na innych Twoich urządzeniach.",
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
    serverUnavailableTitle: "Nie można połączyć się z Relay",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `Nie możemy połączyć się z ${serverUrl}. Spróbuj ponownie lub wybierz inny Relay, aby kontynuować.`,
    serverIncompatibleTitle: "Relay nie jest obsługiwany",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `Relay pod adresem ${serverUrl} zwrócił nieoczekiwaną odpowiedź. Zaktualizuj ten Relay lub wybierz inny Relay, aby kontynuować.`,
  },

      sessionGettingStarted: {

          title: {

              connectMachine: 'Skonfiguruj ten komputer',

              startDaemon: 'Połącz ponownie ten komputer',

              createSession: 'Utwórz sesję',

              selectSession: 'Wybierz sesję',

              loading: 'Ładowanie…',

          },
        cliFollowUpTitle: 'Alternatywa w terminalu (opcjonalnie)',
        manualDisclosure: {
            show: 'Pokaż ręczne kroki terminala',
            hide: 'Ukryj ręczne kroki terminala',
        },

          subtitle: {

              connectMachine: ({ targetLabel }: { targetLabel: string }) =>

                  `Użyj desktopowego procesu konfiguracji, aby połączyć ten komputer z ${targetLabel}. Otwórz ręczne kroki tylko jeśli wolisz ścieżkę terminalową.`,

              startDaemon: ({ targetLabel }: { targetLabel: string }) =>

                  `Użyj desktopowego procesu konfiguracji, aby ponownie połączyć usługę w tle dla ${targetLabel}. Otwórz ręczne kroki tylko jeśli jesteś już na tym komputerze.`,

              createSession: 'Rozpocznij nową sesję przyciskiem + albo z terminala.',

              selectSession: 'Wybierz sesję z paska bocznego, aby zobaczyć ją tutaj.',

              loading: 'Pobieranie maszyn i sesji…',

          },

          steps: {

              openSetup: {

                  title: 'Użyj desktopowego procesu konfiguracji',

                  description: 'To zalecana ścieżka. Konfiguruje Relay, instaluje usługę w tle i resztę konfiguracji zostawia w aplikacji.',

              },

              startDaemonOpenSetup: {

                  description: 'Użyj desktopowego procesu konfiguracji, aby ponownie połączyć lub naprawić usługę w tle na tym komputerze, zanim przejdziesz do poleceń terminala.',

              },

              installCli: {

                  title: 'Zainstaluj CLI',

                  description: 'Uruchom to raz na maszynie, którą chcesz połączyć.',

                  copyLabel: 'Polecenie instalacji',

              },

              serverSetup: {

                  title: 'Ustaw aktywny Relay',

                  description: 'Jednorazowo, aby kolejne polecenia trafiały do właściwego Relay.',

                  copyLabel: 'Konfiguracja Relay',

              },

              authLogin: {

                  title: 'Zaloguj się',

                  description: 'Wyświetla kod QR / link do połączenia terminala z kontem.',

                  copyLabel: 'Logowanie auth',

              },

              daemonInstall: {

                  title: 'Zainstaluj usługę w tle (zalecane)',

                  description: 'Utrzymuje Happier w tle, gotowe do zdalnych uruchomień.',

                  copyLabel: 'Instalacja demona',

              },

              startDaemonInstall: {

                  description: 'Instaluje zawsze włączoną usługę użytkownika i ją uruchamia.',

              },

              daemonStart: {

                  title: 'Uruchom usługę w tle raz',

                  description: 'Użyj tego, jeśli potrzebujesz jej działać tylko teraz.',

                  copyLabel: 'Start demona',

              },

              createSession: {

                  title: 'Utwórz sesję',

                  description: 'Użyj przycisku + w aplikacji albo uruchom jedno z tych poleceń z terminala.',

                  copyLabel: 'Utwórz sesję',

              },

              startSession: {

                  title: 'Uruchom sesję z komputera',

                  description: 'Albo użyj przycisku + w aplikacji.',

                  copyLabel: 'Start sesji',

              },

          },

      },


  setupOnboarding: {
          screenTitle: 'Skonfiguruj ten komputer',
          webDesktopOnlyTitle: 'Wymagana aplikacja desktopowa',
          webDesktopOnlyBody: 'Otwórz aplikację desktopową, aby skonfigurować ten komputer. Aplikacja webowa może pokazywać status, ale nie może zainstalować ani skonfigurować usługi w tle.',
          preAuthTitle: 'Wybierz Relay przed zalogowaniem',
          preAuthBody: 'Wybierz Relay, którego chcesz używać na tym komputerze, zanim utworzysz, odtworzysz lub zalogujesz konto.',
          preAuthContinueHint: 'Po kontynuowaniu Happier cofnie Cię do logowania na wybranym Relay, a potem wróci tutaj, aby dokończyć konfigurację.',
    currentRelayTitle: 'Wybrany Relay',
    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Wybrany Relay: ${relayUrl}`,
    savedRelaysTitle: 'Zapisane Relay',
    customRelayUrlLabel: 'URL Relay',
    relayNameLabel: 'Nazwa Relay',
    addAndUseRelay: 'Dodaj Relay',
    changeRelayAction: 'Użyj innego adresu URL Relay',
          continueToAuth: 'Kontynuuj z wybranym Relay',
          continueWithLocalRelayAction: 'Kontynuuj z tym lokalnym Relay',
    postAuthTitle: 'Dokończ konfigurację tego komputera',
    postAuthBody: 'Jesteś zalogowany. Kontynuuj lokalny proces konfiguracji, aby ten komputer był gotowy dla wybranego Relay.',
    controlPanelTitle: 'Podsumowanie gotowości',
    activeRelaySummaryTitle: 'Aktywny Relay',
    thisComputerSummaryTitle: 'Ten komputer',
    nextActionSummaryTitle: 'Następna akcja',
    thisComputerReady: 'Gotowe dla tego Relay',
    nextActionReady: 'Utwórz pierwszą sesję albo dodaj poniżej kolejny komputer.',
    resumeIntentTitle: 'Kontynuuj konfigurację na tym komputerze',
          resumeIntentBody: 'Zaloguj się lub utwórz konto, aby kontynuować konfigurację tego komputera dla wybranego Relay.',
          openSetupAction: 'Skonfiguruj ten komputer',
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
	    failedToCopyToClipboard: "Nie udało się skopiować do schowka",
	  },

    machine: {
    offlineUnableToSpawn: "Launcher wyłączony, gdy maszyna jest offline",
    offlineHelp:
      "• Upewnij się, że komputer jest online\n• Uruchom `happier daemon status`, aby zdiagnozować\n• Czy używasz najnowszej wersji CLI? Uruchom `happier self update`",
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
    detectedCliDetected: "Wykryto",
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
      remoteSessionModeTitle: "Tryb sesji zdalnej",
      remoteSessionModeOverrideTitle: "Nadpisz globalny tryb sesji Windows",
      remoteSessionModeOverrideEnabledSubtitle:
        "Ta maszyna używa własnego trybu zdalnej sesji Windows.",
      remoteSessionModeOverrideDisabledSubtitle:
        "Ta maszyna korzysta z globalnego trybu zdalnej sesji Windows.",
      windowsTerminalUnavailableSuffix: "Windows Terminal nie został wykryty na tej maszynie.",
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
    sessionRunningLocallyAndRemotely:
      "Ta sesja jest lokalnie podłączona w OpenCode i nadal można nią sterować z aplikacji.",
    switchingToRemote: "Przełączanie na tryb zdalny…",
    switchToLocal: "Przełącz na lokalny",
    switchToRemote: "Przełącz na zdalny",
    detachLocalTerminal: "Odłącz terminal",
    directSessionTakeoverAvailable:
      "Ta bezpośrednia sesja jest dostępna na Twojej maszynie. Przejmij ją w Happier, aby sterować nią tutaj.",
    directSessionMachineOffline:
      "Ta bezpośrednia sesja jest obecnie niedostępna, ponieważ maszyna jest offline.",
    switchingToDirectTakeover: "Przejmowanie tej bezpośredniej sesji…",
    switchingToPersistedTakeover: "Przejmowanie i synchronizowanie tej sesji…",
    takeOverDirect: "Przejmij",
    takeOverPersist: "Przejmij i synchronizuj",
    directTakeoverDialogTitle: "Kontynuować tę bezpośrednią sesję w Happier?",
    directTakeoverDialogBody: "Wybierz, jak Happier ma przejąć kontrolę. Tryb bezpośredni nadal korzysta z transkryptu dostawcy. Synchronizacja importuje transkrypt do Happier.",
    directTakeoverDialogDirectTitle: "Przejmij",
    directTakeoverDialogDirectBody: "Steruj tą sesją w Happier bez synchronizowania transkryptu do Happier.",
    directTakeoverDialogPersistTitle: "Przejmij i synchronizuj",
    directTakeoverDialogPersistBody: "Zaimportuj transkrypt do Happier i kontynuuj z pełnym zestawem funkcji synchronizowanej sesji.",
    directTakeoverDialogForceStopTitle: "Najpierw spróbować zatrzymać proces lokalny",
    directTakeoverDialogForceStopBody: "Happier znalazł zaufany lokalny proces dla tej sesji. Włącz to, jeśli chcesz, aby Happier zatrzymał go przed przejęciem.",
    directTakeoverForceStopConfirmTitle: "Najpierw zatrzymać proces lokalny?",
    directTakeoverForceStopConfirmBody: "Happier znalazł zaufany lokalny proces dla tej bezpośredniej sesji. Zatrzymać go przed przejęciem tutaj?",
    directTakeoverForceStopConfirmAction: "Zatrzymaj i przejmij",
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
    emptyTitle: "Brak aktywności przyjaciół",
    emptyDescription: "Dodaj przyjaciół, aby udostępniać sesje i widzieć aktywność tutaj.",
    activity: "Aktywność",
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
      codex: "Codex (Domyślny)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Domyślny)",
      geminiApiKey: "Gemini (klucz API)",
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
    defaultStorage: {
      title: 'Domyślny magazyn sesji',
      footer: 'Nadpisuje domyślny dla konta tryb synchronizowanej/bezpośredniej sesji dla nowych sesji, gdy wybrany jest ten profil.',
      accountDefaultSubtitle: ({ label }: { label: string }) => `Domyślne konto: ${label}`,
      useAccountDefault: 'Użyj domyślnego konta',
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
      kiroSubtitleExperimental: "Kiro CLI (eksperymentalne)",
      customAcpSubtitleExperimental: "Niestandardowy ACP CLI (eksperymentalne)",
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
