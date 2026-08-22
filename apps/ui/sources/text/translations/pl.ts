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
import { pluginAccountReleaseSelectionTranslations } from './pluginAccountReleaseSelectionTranslations';
import { pluginInvocationLogTranslations } from './pluginInvocationLogTranslations';
import { eventAutomationComposerTranslations } from './eventAutomationComposerTranslations';

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
  mcpServersDeliveryShellBridgeSubtitle: 'Ten backend wywołuje narzędzia Happier przez most happier tools.',
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
  themeProfiles: {
    title: 'Motywy',
    editorTitle: 'Profil tematyczny',
    activeGroup: 'Aktywny motyw',
    activeFooter: 'Wybierz motyw używany przez interfejs. Zarządzaj niestandardowymi motywami na ekranie motywów.',
    builtInGroup: 'Wbudowane motywy',
    builtInFooter: 'Wbudowane motywy są tylko do odczytu. Zduplikuj jeden, aby dostosować go lokalnie.',
    customGroup: 'Niestandardowe motywy',
    customFooter: 'Stuknij motyw, aby go aktywować, lub użyj akcji na wierszach, aby go edytować, powielić lub usunąć.',
    defaultTheme: 'Domyślny motyw',
    defaultThemeSubtitle: 'Użyj Happier kolorów motywu bez niestandardowego profilu',
    active: 'Aktywny',
    customProfileSubtitle: 'Niestandardowy profil motywu lokalnego',
    tapToActivate: 'Kliknij, aby aktywować',
    actionsGroup: 'Działania tematyczne',
    createProfile: 'Utwórz motyw',
    createProfileSubtitle: 'Zacznij od dowolnego wbudowanego lub niestandardowego motywu',
    importProfile: 'Importuj motyw',
    importProfileSubtitle: 'Wklej JSON lub wybierz plik profilu motywu Happier',
    exportProfile: 'Eksportuj motyw',
    exportProfileSubtitle: 'Eksportuj ten motyw jako JSON',
    presetsGroup: 'Wbudowane ustawienia wstępne',
    presetsFooter: 'Wbudowane profile są tylko do odczytu. Sklonuj jeden, aby go dostosować.',
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
    readOnlyPreset: 'Wstępnie ustawione tylko do odczytu',
    clonePreset: 'Predefiniowane klonowanie',
    cloneProfile: 'Klonuj profil',
    duplicateTheme: 'Zduplikowany motyw',
    editProfile: 'Edytuj profil',
    newProfileName: ({ count }: { count: number }) => `Motyw niestandardowy ${count}`,
    cloneName: ({ name }: { name: string }) => `Kopia ${name}`,
    detailsGroup: 'Szczegóły',
    presetGroup: 'Wstępnie ustawione',
    presetSource: 'Wstępnie ustawione',
    presetSourceSubtitle: 'Wybierz motyw, który będzie punktem wyjścia',
    assetAppearance: 'Wygląd majątku',
    assetAppearanceSubtitle: 'Wybierz, czy ten motyw ma używać jasnych czy ciemnych zasobów aplikacji.',
    replacePresetTitle: 'Zamienić obecne kolory?',
    replacePresetSubtitle: 'Zmiana ustawienia wstępnego spowoduje zastąpienie bieżących kolorów roboczych. Niezapisane zmiany kolorów zostaną odrzucone.',
    profileName: 'Nazwa profilu',
    editorModeGroup: 'Tryb tematyczny',
    editorModeFooter: 'Ten motyw edytuje tryb kolorów wybrany przez jego ustawienie wstępne.',
    editorMode: 'Wariant',
    lightMode: 'Światło',
    darkMode: 'Ciemny',
    previewTitle: 'Podgląd motywu',
    previewSubtitle: 'Lokalny podgląd powierzchni, tekstu, kontrolek, stanu i kolorów składni w piaskownicy.',
    previewButton: 'Akcja podstawowa',
    previewStatus: 'Gotowy',
    previewCode: 'const theme = "happier";',
    colorInputPlaceholder: '#RRGGBB, rgba(...), transparent',
    tokenSubtitle: 'Zastąpienie publicznego tokenu koloru',
    recentColors: 'Najnowsze kolory',
    colorPickerFallback: 'Wprowadź wartość koloru lub użyj ponownie ostatnio używanego koloru.',
    invalidColor: 'Use hex, rgb(...), rgba(...), or transparent.',
    invalidProfileName: 'Nieprawidłowa nazwa profilu.',
    profileLimitReached: 'Osiągnięto limit motywów.',
    contrastWarning: 'Niski kontrast dla tej pary żetonów. Nadal możesz zapisać lub zresetować.',
    resetToken: 'Zresetuj token',
    resetGroup: 'Zresetuj i dezaktywuj',
    resetMode: 'Zresetuj kolory motywu',
    deactivateProfile: 'Użyj motywu domyślnego',
    deactivateProfileSubtitle: 'Dezaktywuj profil niestandardowy i zachowaj go',
    deleteProfile: 'Usuń profil',
    deleteProfileSubtitle: 'Usuń ten lokalny niestandardowy profil motywu',
    saveAndActivate: 'Zapisz i aktywuj',
    missingProfile: 'Nie znaleziono profilu motywu',
    importFooter: ({ formats }: { formats: string }) => `Obsługiwane formaty: ${formats}. Nieznane tokeny są zgłaszane jako ostrzeżenia.`,
    importJson: 'Motyw JSON',
    importJsonPlaceholder: "Wklej tutaj JSON swojego motywu",
    importFile: 'Wybierz plik',
    importWarnings: ({ count }: { count: number }) => `Podczas importowania znaleziono ostrzeżenia: ${count}.`,
    importErrors: {
      invalidJson: 'Wklejony tekst jest nieprawidłowy JSON.',
      unsupportedSchema: 'Ta wersja profilu motywu nie jest obsługiwana.',
      invalidProfile: 'Nie można zaimportować tego profilu motywu.',
      tooLarge: 'Ten profil motywu JSON jest za duży.',
    },
    exportFooter: 'Wyeksportowany JSON zawiera wszystkie publiczne wartości tokenów kolorów dla tego motywu.',
    exportJson: 'Eksportuj JSON',
    copyExportJson: 'Skopiuj JSON',
    downloadExportJson: 'Pobierz JSON',
    noProfiles: 'Nie ma jeszcze niestandardowych motywów',
    groups: {
      background: 'Tło',
      surface: 'Powierzchnie',
      border: 'Granice',
      effect: 'Efekty',
      chrome: 'Chrom',
      text: 'Tekst',
      state: 'Stan',
      control: 'Sterowanie',
      composer: 'Kompozytor',
      message: 'Wiadomości',
      syntax: 'Składnia',
      versionControl: 'Kontrola wersji',
      diff: 'Różnice',
      permission: 'Uprawnienia',
      overlay: 'Nakładki',
    },
  },
  sessionListDensity: {
    title: 'Gęstość listy sesji',
    subtitle: 'Wybierz, jak sesje są wyświetlane na pasku bocznym',
    detailed: 'Szczegółowa',
    detailedDescription: 'Pełnowymiarowe wiersze z awatarami i statusem',
    cozy: 'Pośrednia',
    cozyDescription: 'Mniejsze wiersze z awatarami',
    narrow: 'Wąska',
    narrowDescription: 'Wąskie wiersze z mikroawatarami',
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
      convertToPersistedTitle: 'Przekształć w Happier',
      convertToPersistedSubtitle: 'Zaimportuj transkrypt i kontynuuj jako sesję Happier.',
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
export const pl = {
    transferRecovery: {
        title: 'Dokończ przygotowane przesyłanie',
        message: 'Plik dotarł do maszyny, ale końcowy zapis wymaga uwagi. Ponów tylko finalizację albo odrzuć przygotowane przesyłanie.',
        retryFinalization: 'Ponów finalizację',
        discardStagedUpload: 'Odrzuć przygotowane przesyłanie',
        discarded: 'Przygotowane przesyłanie zostało odrzucone.',
        unavailable: 'To przygotowane przesyłanie nie jest już dostępne.',
    },
    voice: voiceReadinessTranslations.pl,
    pluginPermissions: pluginPermissionTranslations.pl,
    sessionRemotePermissionGrants: sessionRemotePermissionGrantTranslations.pl,
    pluginSurfaces: {
        state: {
            loading: { title: 'Ładowanie treści wtyczki', reason: 'Wyświetlana jest dostępna treść, podczas gdy Happier ładuje najnowszą aktualizację.' },
            refreshing: { title: 'Odświeżanie treści wtyczki', reason: 'Wyświetlana jest ostatnia dostępna treść, podczas gdy Happier sprawdza aktualizacje.' },
            stale: { title: 'Treść wtyczki może być nieaktualna', reason: 'Wyświetlana jest ostatnia dostępna treść. Spróbuj ponownie, aby sprawdzić aktualizacje.' },
            offline: { title: 'Treść wtyczki jest offline', reason: 'Do czasu ponownego połączenia ostatnia dostępna treść jest wyświetlana tylko do odczytu.' },
        },
        offlineSnapshot: {
            accessibilityLabel: ({ title }: { title: string }) =>
                `Migawka offline: ${title}. Treść jest tylko do odczytu do czasu ponownego połączenia.`,
        },
        hostRenderer: {
            descriptorPanel: {
                accessibilityLabel: 'Panel wtyczki',
                untitled: 'Panel wtyczki',
            },
        },
        appPage: {
            title: 'Strony wtyczek',
            subtitle: 'Pełnoekranowe miejsca docelowe udostępniane przez zainstalowane wtyczki.',
            empty: 'Brak dostępnych stron wtyczek.',
            unknown: 'Ta strona wtyczki jest niedostępna. Wtyczka może się wczytywać, być wyłączona lub odinstalowana.',
        },
        appScopeRightSidebar: {
            empty: 'Brak dostępnych kart wtyczek aplikacji.',
        },
    },
    settingsKeyboard: {
        title: 'Skróty klawiaturowe',
        entrySubtitle: 'Odkrywaj i kontroluj skróty do aplikacji',
        generalGroupTitle: 'Sterowanie klawiaturą',
        generalGroupFooter: 'Preferencje dotyczące skrótów są przechowywane lokalnie na tym urządzeniu.',
        enableShortcutsTitle: 'Włącz ujednolicone skróty',
        enableShortcutsSubtitle: 'Użyj nowego rejestru poleceń klawiaturowych dla skrótów do aplikacji.',
        singleKeyTitle: 'Skróty jednoklawiszowe',
        singleKeySubtitle: 'Zezwalaj na skróty, takie jak ? gdy wprowadzanie tekstu nie jest skupione.',
        conflictsTitle: ({ count }: { count: number }) => `${count} shortcut conflict${count === 1 ? '' : 's'} detected`,
        conflictsSubtitle: ({ count }: { count: number }) => `${count} command${count === 1 ? '' : 's'} need review before all shortcuts can be active.`,
        conflictsGroupTitle: 'Diagnostyka',
        commandsGroupTitle: 'Polecenia',
        commandsGroupFooter: 'Wartości domyślne są wyświetlane z rejestru skrótów. Ustaw niestandardowy skrót, wyłącz polecenie lub zresetuj je, aby przywrócić domyślne powiązanie.',
        noDefaultShortcut: 'Brak domyślnego skrótu',
        setCommandButton: 'Zestaw',
        setCommandAccessibility: ({ command }: { command: string }) => `Set ${command} shortcut`,
        setShortcutPromptTitle: ({ command }: { command: string }) => `Set shortcut for ${command}`,
        setShortcutPromptMessage: 'Wprowadź skrót, taki jak Alt+K, Alt+ArrowDown, Mod+Enter lub ?.',
        setShortcutPromptPlaceholder: 'Alt+K',
        setShortcutInvalidTitle: 'Nieprawidłowy skrót',
        setShortcutInvalidMessage: 'Wprowadź co najmniej jeden klawisz niemodyfikujący, opcjonalnie za pomocą Mod, Ctrl, Shift lub Alt.',
        resetCommandAccessibility: ({ command }: { command: string }) => `Reset ${command} shortcut`,
        commands: {
            composerAbortConfirm: 'Potwierdź przerwanie',
            composerFocus: 'Ustaw fokus na edytorze',
            composerSendImmediate: 'Wyślij natychmiast',
            composerSendPending: 'Wyślij do kolejki oczekujących',
            commandPaletteOpen: 'Otwórz paletę poleceń',
            modeCycle: 'Przełącz tryb',
            shortcutsHelpOpen: 'Otwórz pomoc skrótów',
            sessionNew: 'Utwórz nową sesję',
            sessionMruNext: 'Następna ostatnia sesja',
            sessionMruPrevious: 'Poprzednia ostatnia sesja',
            sessionVisibleNext: 'Następna widoczna sesja',
            sessionVisiblePrevious: 'Poprzednia widoczna sesja',
            sessionsRowMoveUp: 'Przesuń wybrany wiersz w górę',
            sessionsRowMoveDown: 'Przesuń wybrany wiersz w dół',
            sessionsRowMoveToFolder: 'Przenieś wybrany wiersz do folderu',
            sessionsRowMoveToWorkspaceRoot: 'Przenieś wybrany wiersz do katalogu głównego obszaru roboczego',
            sessionsSelectionToggleFocused: 'Wybierz sesję skupioną',
            sessionsSelectionExtendUp: 'Rozszerz wybór sesji w górę',
            sessionsSelectionExtendDown: 'Rozszerz wybór sesji w dół',
            sessionsSelectionSelectAll: 'Wybierz wszystkie widoczne sesje',
            sessionsSelectionClear: 'Wyczyść wybór sesji',
            settingsOpen: 'Otwórz ustawienia',
            transcriptSelectionCancel: 'Anuluj wybór transkrypcji',
            transcriptSelectionCopy: 'Skopiuj wybrane wiadomości z transkrypcją',
            transcriptSelectionSelectAll: 'Wybierz wszystkie transkrypcje wiadomości',
            transcriptSelectionSendToSession: 'Wyślij wybrane wiadomości z transkrypcją do sesji',
            transcriptScrollBottom: 'Przewiń transkrypcję na dół',
            transcriptScrollPageDown: 'Przewiń transkrypcję stronę w dół',
            transcriptScrollPageUp: 'Przewiń transkrypcję stronę w górę',
            transcriptScrollTop: 'Przewiń transkrypcję na górę',

            permissionCycle: "Tryb uprawnień rowerowych",
            splitCanvasCloseLeaf: "Zamknij podział",
            splitCanvasFocusDown: "Podział ostrości poniżej",
            splitCanvasFocusLeft: "Ustaw fokus na podział po lewej",
            splitCanvasFocusRight: "Ustaw fokus na podział po prawej",
            splitCanvasFocusUp: "Ustaw fokus na podział powyżej",
            splitCanvasRestoreMaximize: "Przywróć zmaksymalizowany podział",
            splitCanvasSplitDown: "Podziel w dół",
            splitCanvasSplitRight: "Podziel w prawo",
            splitCanvasToggleMaximize: "Przełącz maksymalizację podziału",
            transcriptMessageNext: "Następna wiadomość",
            transcriptMessagePrevious: "Poprzednia wiadomość",},
    },

  tabs: {
    // Tab navigation labels
    inbox: "Skrzynka",
    friends: "Przyjaciele",
    sessions: "Sesje",
    settings: "Ustawienia",

    projects: "Projekty",},

  transcript: {


    unsupportedContent: {

      unparsedUserMessage: 'Nieprzeanalizowana wiadomość użytkownika',

      unparsedAgentMessage: 'Nieprzeanalizowana wiadomość asystenta',

      unsupportedAgentOutput: 'Nieobsługiwane wyjście',

      unsupportedTranscriptRecord: 'Nieobsługiwany rekord',

    },

    selection: {

      enterA11y: 'Włącz tryb zaznaczania',

      exitA11y: 'Wyłącz tryb zaznaczania',

      rowA11y: ({ role, preview }: { role: string; preview: string }) => `${role}: ${preview}`,

      selectedCount: ({ count }: { count: number }) => count === 1 ? '1 message selected' : `${count} messages selected`,

      selectAll: 'Zaznacz wszystko',

      deselectAll: 'Odznacz wszystko',

      cancel: 'Anuluj',

      copy: 'Kopiuj',

      copyA11y: ({ count }: { count: number }) => count === 1 ? 'Copy 1 message' : `Copy ${count} messages`,

      send: 'Wyślij',

      sendA11y: ({ count }: { count: number }) => count === 1 ? 'Send 1 message to another session' : `Send ${count} messages to another session`,

      copySuccess: 'Skopiowano',

      copyFailed: 'Kopiowanie nie powiodło się',

      sendTo: {

        modalTitle: 'Wyślij do sesji',

        modalSubtitle: 'Dodaj wybrane wiadomości do szkicu innej sesji',

        newSession: 'Nowa sesja',

        newSessionSubtitle: 'Dodaj do szkicu nowej sesji',

        searchPlaceholder: 'Search sessions...',

        noResults: 'Brak pasujących sesji',

        currentExcluded: 'Bieżąca sesja nie jest pokazana',

        preview: 'Podgląd',

        previewNote: 'To pojawi się w polu tworzenia wiadomości sesji docelowej',

        addNote: 'Dodaj notatkę (opcjonalnie)',

        addNotePlaceholder: 'Type a note to prepend...',

        send: 'Wyślij',

        cancel: 'Anuluj',

        sendFailed: 'Nie udało się wysłać',

        sendSuccessNavigating: 'Wysłano — otwieranie sesji',

      },

    },

    progress: {

      catchingUp: 'Nadrabianie zaległości…',

    },

  },


  inbox: {
    openSession: ({ session }: { session: string }) => `Otwórz sesję: ${session}`,
    // Inbox screen
    emptyTitle: "Wszystko jest na bieżąco",
    emptyDescription: "Nie ma teraz oczekujących próśb ani aktualizacji.",
    approvals: "Zatwierdzenia",
    permissions: "Uprawnienia",
    unreadSessions: "Nieprzeczytane sesje",
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
    proposedComments: ({ count }: { count: number }) => `${count} ${count === 1 ? "proponowany komentarz" : "proponowanych komentarzy"}`,
    generation: ({ generation }: { generation: string }) => `Generacja: ${generation}`,
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
    templateBehaviorInsertOnSend: "Wstaw przy wysyłaniu",
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
    unsupportedReference: ({ reference }: { reference: string }) =>
        `Automatyzacje zapisują tylko tekst wiadomości, więc ${reference} nie wskazywałoby już tego, co wybrano. Usuń to z wiadomości albo wskaż ścieżkę pliku.`,
    list: {
      interval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Co ${minutes} min${timezone ? ` (${timezone})` : ""}`,
      cron: ({ expression, timezone }: { expression: string | null; timezone: string | null }) => `Cron${expression ? `: ${expression}` : ""}${timezone ? ` (${timezone})` : ""}`,
      schedule: "Harmonogram",
      event: ({ eventId }: { eventId: string }) => `Zdarzenie: ${eventId}`,
      manual: "Ręczne",
      conversationTrigger: "Wyzwalacz konwersacji",
      noNextRun: "Brak następnego uruchomienia",
      nextRun: ({ time }: { time: string }) => `Następne: ${time}`,
      nextRunPending: "Następne uruchomienie oczekuje",
    },
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
        name: "Podsumuj ostatnią aktywność",
        description: "Notatki dla siebie",
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
      sentence: {
        run: "Uruchom",
        every: "co",
        onSchedule: "według harmonogramu",
        runEvery: "Uruchamiaj co",
        minutes: "minut",
        presets: "Presety",
        intervalUnits: {
          minutes: "Minuty",
          hours: "Godziny",
          days: "Dni",
        },
        cronFieldGuide: {
          minute: "Minuta",
          hour: "Godzina",
          dayOfMonth: "Dzień",
          month: "Miesiąc",
          weekday: "Dzień tyg.",
        },
        useCron: "Użyj wyrażenia cron",
        useInterval: "Przełącz na interwał",
        addNotes: "Dodaj notatki",
        notes: "NOTATKI",
        localTimezone: "czas lokalny",
        scheduleControlA11y: "Edytuj harmonogram automatyzacji",
        intervalValue: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} dni`;
          if (minutes === 60) return "1 godzina";
          if (minutes % 60 === 0) return `${minutes / 60} godz.`;
          return `${minutes} min`;
        },
        intervalCadence: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `co ${minutes / (24 * 60)} dni`;
          if (minutes === 60) return "co godzinę";
          if (minutes % 60 === 0) return `co ${minutes / 60} godz.`;
          return `co ${minutes} min`;
        },
        cronPresets: {
          weekdays9am: "Dni robocze o 9:00",
          hourly: "Co godzinę",
          monday9am: "Poniedziałek o 9:00",
          dailyMidnight: "Codziennie o północy",
        },
        cronCadences: {
          weekdays9am: "w dni robocze o 9:00",
          hourly: "co godzinę",
          monday9am: "w poniedziałki o 9:00",
          dailyMidnight: "codziennie o północy",
        },
        cronCadenceExpression: ({ expression }: { expression: string }) => `według harmonogramu cron ${expression}`,
        timezone: ({ timezone }: { timezone: string }) => `Strefa czasowa: ${timezone}`,
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
      event: {
        watcherTitle: "Obserwator zdarzeń",
        watcherUnwatched: "Brak obserwatora",
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
      loadMoreRuns: "Wczytaj więcej uruchomień",
      runMeta: {
        originTitle: "Pochodzenie",
        origin: {
          scheduled: "Zaplanowane",
          manual: "Ręczne",
          pluginEvent: "Zdarzenie",
          conversation: "Rozmowa",
        },
        state: {
          queued: "W kolejce",
          claimed: "Przejęte",
          running: "W toku",
          succeeded: "Powodzenie",
          failed: "Niepowodzenie",
          cancelled: "Anulowano",
          expired: "Wygasło",
          dispatch_failed: "Wysyłka nieudana",
          skipped: "Pominięte",
          missed: "Nieodebrane",
          outcome_uncertain: "Wynik niepewny",
        },
        occurred: ({ time }: { time: string }) => `Wystąpiło: ${time}`,
        invoked: ({ time }: { time: string }) => `Wywołano: ${time}`,
        admitted: ({ time }: { time: string }) => `Przyjęto: ${time}`,
        occurrenceTitle: "Wystąpienie",
        sourceTitle: "Źródło obserwacji",
        scheduled: ({ time }: { time: string }) => `Zaplanowano: ${time}`,
        updated: ({ time }: { time: string }) => `Zaktualizowano: ${time}`,
        error: ({ message }: { message: string }) => `Błąd: ${message}`,
      },
      runDetail: {
        title: "Szczegóły przyjęcia",
        recipe: "Przyjęta recepta",
        recipeAbsent: "Nie zapisano prywatnych szczegółów przyjęcia.",
        templateVersion: "Wersja szablonu",
        event: "Zdarzenie",
        conversation: "Rozmowa",
        sourceInstance: "Instancja źródła",
        filter: "Filtr",
        filterMatched: "Dopasowano",
        payload: "Dane",
        input: "Dane wejściowe",
        target: "Zamrożony cel",
        outputCeiling: "Limit wyjścia",
        existingSession: ({ sessionId }: { sessionId: string }) => `Istniejąca sesja: ${sessionId}`,
        newSession: ({ machineId, directory }: { machineId: string; directory: string }) => `Nowa sesja na ${machineId}: ${directory}`,
        executionRun: ({ permissionMode }: { permissionMode: string }) => `Uruchomienie wykonania · ${permissionMode}`,
        prompt: "Zamrożony prompt",
        result: "Wynik końcowy",
        resultAbsent: "Nie zapisano wyniku końcowego.",
        failureDetail: "Szczegóły błędu",
        failureDetailAbsent: "Nie zapisano prywatnych szczegółów błędu.",
        predecessorSummary: "Istnieje podsumowanie poprzednika, ale nie można go odczytać w tych szczegółach.",
        currentnessUnavailable: "Prywatne szczegóły uruchomienia są tymczasowo niedostępne podczas zmiany szyfrowania konta.",
        materialUnavailable: "To urządzenie nie ma aktualnego klucza szyfrowania konta.",
        modeMismatch: "Zachowane prywatne szczegóły używają innego trybu szyfrowania konta.",
        contentInvalid: "Zachowane prywatne szczegóły są nieprawidłowe.",
        invalidTemplate: "Przyjęty szablon jest nieprawidłowy. To uruchomienie nie zostanie wysłane ani ponowione.",
        outcomeUnknown: "Wynik wysłania jest nieznany. Happier nie wyśle ponownie zamrożonego celu.",
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
    destructiveActionHint: "To działanie jest destrukcyjne i nie można go cofnąć.",
    cancel: "Anuluj",
    submit: "Prześlij",
    close: "Zamknij",
    dismissKeyboard: 'Ukryj klawiaturę',
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
		    warning: "Ostrzeżenie",
		    info: "Informacje",
		    comingSoon: "Wkrótce",
		    ok: "OK",
		    continue: "Kontynuuj",
		    back: "Wstecz",
        previous: "Poprzedni",
        next: "Następny",
	    start: "Rozpocznij",
	    run: "Uruchom",
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
    pasteImage: "Wklej obraz",
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
    notProvided: "Nie podano",
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

    more: "Więcej",
    skip: "Pomiń",
    maximize: "Maksymalizuj",
    restore: "Przywróć",
    name: "Nazwa",
    blocked: "Zablokowane",
    active: "Aktywne",
    inactive: "Nieaktywne",
    running: "Uruchamianie…",
    login: "Zaloguj się",
    install: "Zainstaluj",
    enable: "Włącz",
    disable: "Wyłącz",
    tabs: "Karty",
    logs: "Logi",
    share: "Udostępnij",
    unreachable: "Nieosiągalne",},

  ui: {
    resizableDockedPane: {
      resizeA11y: "Zmień rozmiar panelu",
      resizeHint:
        "Użyj klawiszy strzałek lub działań dostosowania, aby zmienić rozmiar",
    },
    modalPane: {
      right: "Prawy pasek boczny",
      details: "Panel szczegółów",
      bottom: "Dolny panel",
      dismiss: ({ pane }: { pane: string }) => `Zamknij ${pane}`,
    },
    pluginUi: {
      loading: "Ładowanie",
      empty: "Nie ma nic do wyświetlenia",
      error: "Coś poszło nie tak",
      moreActions: "Więcej działań",
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
    working: "pracuje...",
    workingRetained: "pracuje, oczekiwanie na aktualizacje…",
        backgroundActive: 'pracuje w tle',
        workingExternally: 'Pracuje zewnętrznie',
        needsInputExternally: 'Wymaga zewnętrznej odpowiedzi',
        retryingExternally: 'Ponawia zewnętrznie',
        ready: 'Gotowe',
        recentlyActive: 'Ostatnio aktywne',
        externalStatusUnknown: 'Nieznany status zewnętrzny',
    readyForReview: "gotowe do przeglądu",
    keptInAttention: "zatrzymana w sekcji uwagi",
    canceled: "Anulowano",
    offline: "poza siecią",
    lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
    actionRequired: "wymagana akcja",
    waitingForYourResponse: "Oczekiwanie na odpowiedź",
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
    nowShort: "teraz",
    minutesAgoShort: ({ count }: { count: number }) => `${count}m temu`,
    hoursAgoShort: ({ count }: { count: number }) => `${count}g temu`,
    daysAgoShort: ({ count }: { count: number }) => `${count}d temu`,
  },
  commandMenu: {
    empty: 'Brak wyników',
  },


  selectionList: {
    emptyMatch: "Brak dopasowań",
    clearInput: "Wyczyść",
    backTo: ({ label }: { label: string }) => `Powrót do ${label}`,
    dynamicSectionError: "Coś poszło nie tak",
    pathNotFound: "Nie znaleziono ścieżki",
    backShortcut: "wstecz",
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
    secretKeyInputLabel: "Klucz tajny",
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
            "Jeśli Twoja maszyna jest nieosiągalna z UI, uruchom happier doctor --json na komputerze i wklej tutaj.",
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
            empty: "Lokalne wyszukiwanie pamięci jest włączone, ale nie zindeksowano jeszcze treści do wyszukiwania",
            indexing: "Lokalne wyszukiwanie pamięci indeksuje treść transkryptów",
            waiting: "Lokalne wyszukiwanie pamięci czeka przed następnym indeksowaniem",
            error: "Lokalne wyszukiwanie pamięci wymaga uwagi",
            readyLight: "Lekki indeks gotowy na tej maszynie",
            readyDeep: "Głęboki indeks gotowy na tej maszynie",
            unavailableLight: "Lekki indeks nie jest jeszcze gotowy na tej maszynie",
            unavailableDeep: "Głęboki indeks nie jest jeszcze gotowy na tej maszynie",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
            diskUsageFormatted: ({ light, deep }: { light: string; deep: string }) => `Light ${light} · Deep ${deep}`,
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
    indexContents: {
      groupTitle: "Zawartość indeksu",
      title: "Treść do wyszukiwania",
      subtitle: ({ sessions, lightShards, deepChunks }: { sessions: number; lightShards: number; deepChunks: number }) =>
        `${sessions} sesji · ${lightShards} lekkich shardów · ${deepChunks} głębokich fragmentów`,
    },
    queue: {
      groupTitle: "Uzupełnianie i kolejka",
      title: "Kolejka indeksowania",
      subtitle: ({ selected, queued, indexing, indexed, empty, failed, waiting }: { selected: number; queued: number; indexing: number; indexed: number; empty: number; failed: number; waiting: number }) =>
        `${selected} wybranych · ${queued} w kolejce · ${indexing} indeksowanych · ${indexed} zindeksowanych · ${empty} pustych · ${failed} nieudanych · ${waiting} oczekujących`,
      workerPhase: ({ phase }: { phase: string }) => `Bieżąca faza: ${phase}`,
    },
    lastRun: {
      groupTitle: "Ostatnie indeksowanie",
      title: "Ostatnie uruchomienie",
      subtitle: ({ considered, processed, semanticRows, failures }: { considered: number; processed: number; semanticRows: number; failures: number }) =>
        `${considered} rozważonych · ${processed} przetworzonych · ${semanticRows} wierszy semantycznych · ${failures} błędów`,
    },
    coverage: {
      title: "Zakres treści",
      footer: "Określa, która semantyczna treść transkryptów jest indeksowana w wybranych sesjach.",
      triggerTitle: "Zakres",
      options: {
        fullTitle: "Cała wybrana historia",
        fullSubtitle: "Indeksuj każdą wybraną wiadomość użytkownika i asystenta",
        latestMessagesTitle: "Najnowsze wiadomości",
        latestMessagesSubtitle: "Indeksuj ograniczoną liczbę najnowszych wiadomości semantycznych na sesję",
        latestDaysTitle: "Najnowsze dni",
        latestDaysSubtitle: "Indeksuj wiadomości semantyczne z ostatniego okna dni",
        sinceEnabledTitle: "Od włączenia",
        sinceEnabledSubtitle: "Indeksuj treść utworzoną po włączeniu lokalnej pamięci",
      },
    },
    contentPolicy: {
      title: "Indeksowana treść",
      footer: "Wiadomości użytkownika i asystenta są indeksowane domyślnie. Wrażliwe szczegóły dostawcy pozostają wyłączone, chyba że zostaną jawnie włączone.",
      userMessagesTitle: "Wiadomości użytkownika",
      userMessagesSubtitle: "Uwzględnia prompty i odpowiedzi napisane przez Ciebie",
      assistantMessagesTitle: "Wiadomości asystenta",
      assistantMessagesSubtitle: "Uwzględnia końcowe odpowiedzi asystenta",
      reasoningTitle: "Rozumowanie",
      reasoningSubtitle: "Uwzględnia podsumowania rozumowania tylko wtedy, gdy daemon je obsługuje",
      toolSummariesTitle: "Podsumowania narzędzi",
      toolSummariesSubtitle: "Uwzględnia oczyszczone podsumowania aktywności narzędzi",
      toolOutputsTitle: "Surowe wyjścia narzędzi",
      toolOutputsSubtitle: "Pozostaw wyłączone, chyba że celowo chcesz uwzględnić surowy tekst wyjść narzędzi w lokalnych indeksach",
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
      overview: 'Przegląd',

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
      statusInstallRequired: 'Zainstaluj Tailscale, aby kontynuować',
      statusLoginRequired: 'Zaloguj się do Tailscale, aby kontynuować',
      statusNeedsApproval: 'Oczekiwanie na zatwierdzenie Tailscale',
      shareableUrlTitle: 'Udostępnialny prywatny adres URL',
      approvalTitle: 'Wymagane zatwierdzenie',
      approvalSubtitle: 'Dokończ proces zatwierdzania w Tailscale i wróć tutaj.',
      installTitle: 'Wymagana instalacja',
      installSubtitle: 'Zainstaluj Tailscale, a potem wróć tutaj.',
      loginTitle: 'Wymagane logowanie',
      loginSubtitle: 'Dokończ logowanie do Tailscale, a potem wróć tutaj.',
      enableAction: 'Włącz prywatny dostęp z Tailscale',
      refreshAction: 'Sprawdź ponownie prywatny dostęp',
      openApprovalAction: 'Otwórz zatwierdzanie Tailscale',
      openInstallAction: 'Otwórz pobieranie Tailscale',
      openLoginAction: 'Otwórz logowanie Tailscale',
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
      featuresTitle: "Funkcje",
      featuresSubtitle: "Włącz lub wyłącz funkcje aplikacji",
      pets: "Zwierzaki",
      petsSubtitle: "Wybierz Blink i zwierzaki towarzyszące na urządzeniu",
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

          remoteHostsTitle: "Hosty zdalne",
          remoteHostsDesktopOnlyTitle: "Hosty zdalne są dostępne tylko na desktopie",
          remoteHostsDesktopOnlySubtitle: "Zarządzaj zapisanymi hostami SSH na desktopie.",
          remoteHostsManagementDisabledTitle: "Zarządzanie hostami zdalnymi jest wyłączone",
          remoteHostsManagementDisabledSubtitle: "Ta wersja nie pozwala zarządzać hostami zdalnymi.",
          remoteHostsEmptyTitle: "Brak hostów zdalnych",
          remoteHostsEmptySubtitle: "Dodaj host zdalny, aby ponownie używać danych SSH w konfiguracji.",
          remoteHostsAddHost: "Dodaj host zdalny",
          remoteHostsAddHostTitle: "Dodaj host zdalny",
          remoteHostsEditHostTitle: "Edytuj host zdalny",
          remoteHostsHostGroupTitle: "Serwer",
          remoteHostsSshGroupTitle: "SSH",
          remoteHostsSecretMaterialGroupTitle: "Materiał tajny",
          remoteHostsSavePasswordLabel: "Zapisz hasło",
          remoteHostsPasswordSavedTitle: "Hasło zapisane",
          remoteHostsPasswordSavedSubtitle: "Pozostaw puste, aby zachować bez zmian.",
          remoteHostsStorePrivateKeyLabel: "Zapisz klucz prywatny (zaszyfrowany)",
          remoteHostsPrivateKeyLabel: "Klucz prywatny",
          remoteHostsPrivateKeySavedHint: "Klucz prywatny jest już zapisany. Pozostaw puste, aby zachować bez zmian.",
          remoteHostsSecretMaterialDisabledTitle: "Zapisywanie sekretów wyłączone",
          remoteHostsSecretMaterialDisabledSubtitle: "Ta kompilacja nie pozwala przechowywać haseł ani kluczy prywatnych.",
          remoteHostsSetupAsMachineTitle: "Skonfiguruj jako maszynę Happier",
          remoteHostsSetupAsMachineFailed: "Nie udało się skonfigurować tego hosta jako maszyny Happier.",
          remoteHostsConnectFromThisDeviceTitle: "Połącz z tego urządzenia",
          remoteHostsConnectFromThisDeviceSubtitle: "Tylko to urządzenie. Otwiera lokalny tunel SSH dla tej sesji aplikacji.",
          remoteHostsConnectFromThisDeviceFailed: "Nie udało się otworzyć lokalnego tunelu SSH.",
          remoteHostsNativeSshTunnelRequiresEngine: "Natywne tunele SSH wymagają kompilacji natywnego silnika SSH, zanim będzie można je uruchomić z tego urządzenia.",
          remoteHostsSshTunnelGroupTitle: "Połącz z hostem zdalnym z tego urządzenia",
          remoteHostsSshTunnelActiveTitle: ({ host }: { host: string }) => `Tunel SSH aktywny dla ${host}`,
          remoteHostsSshTunnelActiveSubtitle: ({ url }: { url: string }) => `Tylko to urządzenie. Lokalny punkt końcowy: ${url}`,
          remoteHostsSshTunnelStopTitle: "Zatrzymaj lokalny tunel SSH",
          remoteHostsUseAsRelayHostTitle: "Użyj jako hosta Relay",
          remoteHostsUseAsRelayHostSubtitle: "Skonfiguruj dostęp Relay na tym hoście SSH.",
          remoteHostsConfigureAccessTitle: "Skonfiguruj dostęp",
          remoteHostsConfigureAccessSubtitle: "Wybierz, jak ten host zdalny będzie osiągalny.",
          remoteHostsOpenDetailsTitle: "Szczegóły hosta",
          remoteHostsRelayAccessGroupTitle: "Dostęp zdalny",
          remoteHostsRelayAccessActiveTitle: ({ host }: { host: string }) => `Konfigurowanie dostępu dla ${host}`,
          remoteHostsRelayAccessActiveSubtitle: "Polecenia dostępu Relay działają na hoście zdalnym przez SSH. To nie tworzy tunelu SSH.",
          remoteHostsMissingServerUrl: "Wybierz serwer przed skonfigurowaniem maszyny zdalnej.",
          remoteHostsRelayAccessIdentityFileRequired: "Dostęp Relay na tym hoście wymaga lokalnego pliku tożsamości SSH.",
          remoteHostsTestConnectionTitle: "Test połączenia",
          remoteHostsInstallOrUpdateCliTitle: "Zainstaluj lub zaktualizuj CLI",
          remoteHostsDaemonServiceInstallOrUpdateTitle: "Zainstaluj lub zaktualizuj usługę demona",
          remoteHostsDaemonServiceStartTitle: "Uruchom usługę demona",
          remoteHostsDaemonServiceStopTitle: "Zatrzymaj usługę demona",
          remoteHostsDaemonServiceRestartTitle: "Uruchom ponownie usługę demona",
          remoteHostsRelayRuntimeStatusTitle: "Status runtime Relay",
          remoteHostsRelayRuntimeInstallOrUpdateTitle: "Zainstaluj lub zaktualizuj runtime Relay",
          remoteHostsRelayRuntimeStartTitle: "Uruchom runtime Relay",
          remoteHostsRelayRuntimeStopTitle: "Zatrzymaj runtime Relay",
          remoteHostsRelayRuntimeRestartTitle: "Uruchom ponownie runtime Relay",
          remoteHostsPortLine: ({ port }: { port: number }) => `Port: ${port}`,
          remoteHostsActiveTaskTitle: "Zadanie systemowe",
          remoteHostsHostTrustTitle: "Zaufać hostowi SSH?",
          remoteHostsReplaceHostKeyTitle: "Zastąpić klucz hosta SSH?",
          remoteHostsReplaceHostKeyAction: "Zastąp klucz hosta",
          remoteHostsHostKeyCurrentFingerprintLabel: "Obecny zaufany odcisk",
          remoteHostsHostKeyNewFingerprintLabel: "Nowy odcisk",
          remoteHostsPasswordRequiredTitle: "Wymagane hasło SSH",
          remoteHostsRememberHostKeyTitle: "Zapamiętać ten klucz hosta SSH?",
          remoteHostsRememberHostKeyAction: "Zaufaj i zapamiętaj",
          remoteHostsTrustOnceAction: "Zaufaj raz",
          remoteHostsPrivateKeyPassphraseTitle: "Hasło do klucza prywatnego SSH",
          remoteHostsKeyboardInteractiveTitle: "Uwierzytelnianie SSH",
          remoteHostsKeyboardInteractivePromptLabel: "Monit SSH",
          remoteHostsTrustedHostKeysTitle: "Zaufane klucze hostów SSH",
          remoteHostsTrustedHostKeyRemoveTitle: "Usunąć zaufany klucz hosta SSH?",
          remoteHostsTrustedHostKeysClearTitle: "Wyczyść zaufane klucze hostów SSH",
          remoteHostsConnectionSucceeded: "Połączenie udane.",
          remoteHostsConnectionFailed: "Połączenie nieudane.",
          sshConfiguredHostPickerTitle: "Sugerowane hosty SSH",
          sshConfiguredHostPickerSubtitle: "Wypełnij z lokalnej konfiguracji SSH lub known_hosts.",
          sshConfiguredHostPickerRefreshingSubtitle: "Odświeżanie sugestii; pokazujemy ostatnie wyniki.",
          sshConfiguredHostPickerSourceSshConfig: "Konfiguracja SSH",
          sshConfiguredHostPickerSourceKnownHosts: "known_hosts",
          sshConfiguredHostPickerUnsupportedTitle: "Wprowadź dane SSH ręcznie",
          sshConfiguredHostPickerUnsupportedSubtitle: "Lokalne wykrywanie SSH jest dostępne tylko w aplikacji desktopowej.",
          sshConfiguredHostPickerLoadingTitle: "Wyszukiwanie hostów SSH…",
          sshConfiguredHostPickerLoadingSubtitle: "Sprawdzanie lokalnej konfiguracji SSH i known_hosts przez most desktopowy.",
          sshConfiguredHostPickerEmptyTitle: "Brak sugerowanych hostów SSH",
          sshConfiguredHostPickerEmptySubtitle: "Wprowadź dane SSH ręcznie albo odśwież po zmianie konfiguracji SSH.",
          sshConfiguredHostPickerErrorTitle: "Nie udało się załadować sugestii SSH",
          sshConfiguredHostPickerRefreshTitle: "Odśwież sugestie SSH",
          sshConfiguredHostPickerRefreshingTitle: "Odświeżanie sugestii SSH",
          machineSetupStepResolveRelay: "Sprawdzanie istniejących komponentów",
          machineSetupStepCheckAuth: "Sprawdzanie stanu logowania",
          machineSetupStepConfigureRelay: "Łączenie z Relay",
          machineSetupStepAuthRequest: "Zatwierdź ten komputer",
          machineSetupStepAuthWait: "Oczekiwanie na zatwierdzenie",
          machineSetupStepInstallService: "Instalowanie usługi w tle",
          machineSetupStepStartService: "Uruchamianie usługi w tle",
          machineSetupStepVerifyService: "Weryfikowanie usługi w tle",
          machineSetupRemoteSshTargetPlaceholder: "user@host",
          machineSetupRemoteSshUsernameLabel: "Nazwa użytkownika SSH",
          machineSetupRemoteSshUsernamePlaceholder: "ubuntu",
          machineSetupRemoteSshHostLabel: "Host SSH",
          machineSetupRemoteSshHostPlaceholder: "example.test",
          machineSetupRemoteSshPortLabel: "Port SSH",
          machineSetupRemoteSshPortPlaceholder: "22",
          machineSetupRemoteSshAuthMethodLabel: "Metoda uwierzytelniania",
          machineSetupRemoteSshPasswordAuthLabel: "Użyj hasła",
          machineSetupRemoteSshPrivateKeyMaterialLabel: "Wklej klucz prywatny",
          machineSetupRemoteSshPasswordLabel: "Hasło SSH",
          relayAccess: {
      title: 'Dostęp do Relay',
      footer: 'Wybierz, jak telefon łączy się z tym Relay.',
      statusTitle: 'Stan',
      statusNotConfigured: 'Jeszcze nie skonfigurowano',
      statusWorking: 'Sprawdzanie dostępu do Relay',
      statusEnabled: 'Włączone',
      statusDisabled: 'Wyłączone',
      statusNeedsAuth: 'Wymagane logowanie',
      statusError: 'Błąd',
      statusUnknown: 'Nieznany',
      shareableUrlTitle: 'Udostępnialny URL',
      methodTitle: 'Metoda dostępu',
      saveAction: 'Zapisz metodę dostępu',
      disableAction: 'Wyłącz dostęp do Relay',
      refreshAction: 'Odśwież stan dostępu',
      progressStepInspect: 'Sprawdź bieżącą konfigurację',
      progressStepCheck: 'Sprawdź stan dostępu',
      progressStepPersist: 'Zapisz konfigurację dostępu',
      progressStepApply: 'Zastosuj konfigurację dostępu',
      progressStepVerify: 'Zweryfikuj URL dostępu',
      progressStepDisable: 'Wyłącz dostęp do Relay',
      providers: {
        localOnly: {
          title: 'Tylko lokalnie',
          subtitle: 'Tylko ten komputer może łączyć się z Relay.',
        },
        lan: {
          title: 'LAN / własny URL',
          subtitle: 'Użyj URL, który już masz (IP LAN lub tunel).',
        },
        tailscaleServe: {
          title: 'Tailscale Serve',
          subtitle: 'Prywatny URL dla tailnetu (zalecane).',
        },
        tailscaleFunnel: {
          title: 'Tailscale Funnel',
          subtitle: 'Publiczny URL przez Funnel.',
        },
        cloudflareNamed: {
          title: 'Tunel Cloudflare',
          subtitle: 'Publiczny URL przez nazwany tunel Cloudflare.',
        },
      },
      fields: {
        urlLabel: 'URL Relay',
        hostnameLabel: 'Nazwa hosta',
        tokenLabel: 'Token',
      },
      missingUrl: 'Wpisz URL Relay, aby kontynuować.',
      missingHostname: 'Wpisz nazwę hosta, aby kontynuować.',
      missingToken: 'Wpisz token, aby kontynuować.',
      webHandoffTitle: 'Uruchom to na komputerze',
      webHandoffSubtitle: 'Użyj CLI, aby skonfigurować dostęp do Relay, a potem wróć tutaj i odśwież.',
    },
          accessEndpoints: {
      status: {
        refreshing: 'Odświeżanie kanałów dostępu',
      },
      scope: {
        availableToOtherDevices: 'Dostępne dla innych urządzeń',
        thisDeviceOnly: 'Tylko to urządzenie',
      },
      direction: {
        makeCurrentServerReachable: 'Udostępnij ten serwer',
        reachRemoteServerFromThisDevice: 'Połącz się z serwerem zdalnym z tego urządzenia',
        unknown: 'Kanał dostępu',
      },
      kind: {
        'relay-access-provider': 'Dostęp Relay',
        'ssh-tunnel-desktop': 'Tunel SSH na komputerze',
        'ssh-tunnel-native': 'Natywny tunel SSH',
        'server-profile-url': 'URL serwera',
        'peer-mediation': 'Mediacja peer-to-peer',
        'manual-url': 'Ręczny URL',
      },
      recommendedUse: {
        'multi-device': 'Najlepsze dla innych urządzeń',
        'native-this-device': 'Działa w tej natywnej aplikacji',
        'hosted-web': 'Działa z hostowanej wersji web',
        'lan-only': 'Tylko LAN lub sieć prywatna',
        diagnostic: 'Wymaga uwagi',
      },
      limitation: {
        'this-device-only': 'Tylko to urządzenie',
        'not-hosted-web-compatible': 'Niedostępne w hostowanej wersji web',
        'not-public-share-url': 'To nie jest publiczny URL udostępniania',
        'session-scoped': 'Ograniczone do sesji',
        'authentication-failed': 'Uwierzytelnienie SSH nie powiodło się',
        'foreground-only': 'Wymaga pozostawienia aplikacji na pierwszym planie',
        'host-key-mismatch': 'Klucz SSH hosta się zmienił',
        'host-key-rejected': 'Klucz SSH hosta został odrzucony',
        'host-key-untrusted': 'Klucz SSH hosta nie jest jeszcze zaufany',
        'platform-suspended': 'Wstrzymane, gdy aplikacja jest zawieszona',
        'loopback-bind-failed': 'Nie można powiązać lokalnego portu tunelu',
        'network-captive-portal': 'Sieć przechwyciła połączenie SSH',
        'remote-service-unreachable': 'Usługa zdalna jest nieosiągalna przez tunel',
        'requires-auth': 'Wymaga uwierzytelnienia SSH',
        'requires-host-key-trust': 'Wymaga zaufania kluczowi hosta',
      },
      remediation: {
        tailscale: {
          install: 'Zainstaluj Tailscale',
          login: 'Zaloguj się do Tailscale',
          serve: {
            enable: 'Włącz Tailscale Serve',
            approve: 'Zatwierdź Tailscale Serve',
          },
          funnel: {
            approve: 'Zatwierdź Tailscale Funnel',
          },
        },
        cloudflare: {
          configure: 'Skonfiguruj tunel Cloudflare',
        },
        serverProfile: {
          configureShareableUrl: 'Skonfiguruj URL do udostępniania',
        },
        remoteHost: {
          add: 'Dodaj host zdalny',
          setup: 'Skonfiguruj host zdalny',
        },
        sshTunnel: {
          start: 'Uruchom tunel SSH',
          reuse: 'Użyj istniejącego tunelu SSH',
          stop: 'Zatrzymaj tunel SSH',
          authenticate: 'Uwierzytelnij tunel SSH',
          trustHost: 'Zaufaj kluczowi hosta SSH',
        },
      },
    },
          systemTaskOpenLogs: "Otwórz logi",
          systemTaskOpenLogsFailed: "Nie udało się otworzyć folderu logów.",},

		  systemStatus: {
		    sections: {
		      application: "Aplikacja",
		      updates: "Aktualizacje",
		      appHealth: "Stan aplikacji i synchronizacji",
		      currentServer: "Bieżący Relay",
      identity: "Zalogowana tożsamość",
      configuredServers: "Skonfigurowane Relaye",
      machinesActiveServer: "Maszyny (aktywny Relay)",
      machinesOtherServer: ({ server }: { server: string }) => `Maszyny (${server})`,
      actions: "Akcje",
    },
    application: {
      appVersion: "Wersja aplikacji",
      nativeVersion: "Wersja natywna",
      buildNumber: "Numer kompilacji",
      applicationId: "ID aplikacji",
      updateChannel: "Kanał aktualizacji",
      updateId: "ID bieżącej aktualizacji",
      runtimeVersion: "Wersja runtime",
      updateCreatedAt: "Data bieżącej aktualizacji",
      launchSource: "Źródło uruchomienia",
      launchSourceEmbedded: "Osadzony binarny natywny",
      launchSourceOta: "Pobrana aktualizacja OTA",
      launchSourceUnknown: "Nieznane",
    },
    updates: {
      otaStatus: "Status OTA",
      lastChecked: "Ostatnie sprawdzenie",
      openStore: "Otwórz aktualizację sklepu",
      available: "Dostępne",
      checkNow: "Sprawdź teraz",
      checkNowSubtitle: "Ręcznie sprawdź, czy na bieżącym kanale jest nowsza aktualizacja OTA.",
      applyNow: "Zastosuj aktualizację teraz",
      disabled: "Wyłączone",
      applying: "Trwa stosowanie aktualizacji",
      readyToApply: "Gotowe do zastosowania",
      downloading: "Pobieranie",
      downloadingProgress: ({ progress }: { progress: string }) => `Pobieranie (${progress})`,
      checking: "Sprawdzanie",
      error: "Błąd",
      upToDate: "Aktualne",
      unknown: "Nieznane",
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
      footer: "Wskazówka: uruchom happier doctor --json na komputerze i wklej tutaj.",
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
      github: "GitHub",

      bitbucket: "Bitbucket",},
    title: "Połączone usługi",
    authChip: {
      label: "Autoryzacja",
      labelWithCount: ({ count }: { count: number }) => `Autoryzacja: ${count}`,
      nativeLabel: "Natywna",
      connectedCountLabel: ({ count }: { count: number }) => `${count} połączone`,
    },
    authSwitch: {
      switchFailed: 'Nie udało się zmienić autoryzacji dla tej sesji.',
      confirmAction: 'Zmień autoryzację',
      errors: {
        groupGenerationConflict: 'Grupa kont zmieniła się przed zakończeniem przełączania. Odśwież listę kont i spróbuj ponownie.',
        providerStateSharingRequired: 'Provider state sharing must be enabled before this account can be used for the running session.',
        notGroupSelection: 'Choose an account group so Happier can switch away from an exhausted account automatically.',
        connectedServiceRequired: 'Choose a connected account before using this recovery action for the session.',
        profileActionRequired: 'The selected connected account needs attention before it can be used.',
        providerStateSharingUnavailable: 'Nie można sprawdzić ustawień udostępniania stanu dostawcy na tej maszynie. Odśwież połączenie z demonem i spróbuj ponownie.',
        profileDisconnected: 'Wybrane połączone konto wymaga ponownego uwierzytelnienia przed użyciem.',
        profileMissing: 'Wybrane połączone konto nie jest już dostępne. Odśwież listę kont i wybierz inne konto.',
        groupMissing: 'Wybrana grupa kont nie jest już dostępna. Odśwież listę kont i wybierz inną grupę.',
        metadataUpdateFailed: 'Sesja nie mogła zapisać nowego wyboru uwierzytelnienia. Spróbuj ponownie po zakończeniu synchronizacji sesji.',
        restartFailed: 'Nie można ponownie uruchomić sesji z nowym wyborem uwierzytelnienia. Zatrzymaj sesję i spróbuj ponownie.',
        hotApplyFailed: 'Działająca sesja odrzuciła nowy wybór uwierzytelnienia. Uruchom sesję ponownie i spróbuj jeszcze raz.',
        agentMismatch: 'Ten wybór uwierzytelnienia nie pasuje do backendu sesji.',
        sessionNotFound: 'Ta sesja nie jest już dostępna na wybranej maszynie.',
        unsupportedService: 'Ten backend nie obsługuje wybranej połączonej usługi.',
      },
      status: {
        liveApplied: 'Uwierzytelnianie przełączone w działającej sesji',
        credentialsRefreshed: 'Uwierzytelnianie odświeżone',
        restarting: 'Ponowne uruchamianie sesji',
        appliesOnNextResume: 'Zastosuje się przy następnym wznowieniu',
        retry: 'Authentication switch needs retry',
        partialApplication: "Uwierzytelnianie częściowo przełączone",
        partialApplicationServiceFailed: ({ service }: { service: string }) => `${service}: uwierzytelnianie nie powiodło się`,
        partialApplicationServiceNotApplied: ({ service }: { service: string }) => `${service}: uwierzytelnianie niezastosowane`,
      },
      partialApply: {
        title: 'Uwierzytelnianie przełączone częściowo',
        body: 'Nowe konto zostało zapisane, ale zastosowanie go do tej działającej sesji nie powiodło się w pełni. Ponów próbę lub przywróć, aby zachować tę sesję na poprzednim koncie.',
        retry: 'Ponów zastosowanie do tej sesji',
        revert: 'Przywróć poprzednie konto',
      },
    },
    errors: {
      credentialReferencedByGroup: 'To połączone konto jest używane przez grupę kont. Odłączenie usunie je z tych grup i w razie potrzeby wyczyści aktywny wybór.',
      runtimeCooldown: ({ time }: { time: string }) => `This account is cooling down until ${time}.`,
      runtimeCooldownOverrideTitle: 'Przełączyć na konto w czasie schładzania?',
      runtimeCooldownOverrideBody: ({ time }: { time: string }) =>
        `This account is cooling down until ${time}. Switch manually anyway?`,
      runtimeCooldownOverrideConfirm: 'Przełącz mimo to',
      unknownResetTime: 'nieznany czas',
      generationConflict: 'Ta grupa kont zmieniła się przed zakończeniem działania. Odśwież listę kont i spróbuj ponownie.',
      generationConflictWithGeneration: ({ generation }: { generation: number }) =>
        `This account group changed before the action completed. Refresh the account list and try again. Current generation: ${generation}.`,
      generationRequired: 'Ta akcja wymaga świeżej wersji grupy kont. Odśwież listę kont i spróbuj ponownie.',
      groupNotFound: 'Ta grupa kont już nie istnieje. Odśwież listę kont i spróbuj ponownie.',
      groupMemberNotFound: 'To konto nie jest już członkiem grupy. Odśwież listę kont i spróbuj ponownie.',
      profileNotFound: 'To połączone konto już nie istnieje. Odśwież listę kont i spróbuj ponownie.',
      activeProfileNotMember: 'Tylko włączeni członkowie grupy mogą być ustawieni jako aktywni.',
      fallbackDisabled: 'Fallback kont jest wyłączony na tym serwerze.',
      duplicateMember: 'To konto jest już w grupie.',
      groupAlreadyExists: 'Grupa kont o tym id już istnieje.',
      invalidGroup: 'Ta grupa kont jest nieprawidłowa. Sprawdź ustawienia i spróbuj ponownie.',
      requestFailedWithStatus: ({ status }: { status: number }) => `The connected-service request failed (${status}). Refresh and try again.`,
      generic: 'Akcja połączonej usługi nie powiodła się. Odśwież i spróbuj ponownie.',
    },
    diagnostics: {
      title: {
        provider_session_state_unavailable_for_resume: 'Przełączenie niedostępne',
        connected_service_materialization_identity_missing: 'Brakuje tożsamości usługi połączonej',
        resume_reachability_inputs_missing: 'Nie można zweryfikować wznowienia sesji',
        metadata_update_failed: 'Nie zapisano wyboru uwierzytelniania',
        no_eligible_group_member: 'Brak dostępnego konta zapasowego',
        recovery_retry_scheduled: 'Zaplanowano odzyskiwanie dostawcy',
                recovery_dead_lettered: 'Odzyskiwanie dostawcy wymaga uwagi',
                provider_account_adoption_mismatch: 'Dostawca nie przełączył konta',
                post_switch_verification_failed: 'Nie udało się zweryfikować konta dostawcy',
                connected_service_credential_reconnect_required: "Połączone konto wymaga ponownego połączenia",
                connected_service_credential_refresh_unavailable: "Odświeżanie połączonego konta jest tymczasowo niedostępne",
                claude_subscription_missing_claude_code_scope: 'Dostęp Claude Code wymaga ponownego połączenia',
        claude_subscription_native_auth_materialization_failed: 'Nie można było przygotować poświadczeń Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Token konfiguracyjny Claude nie może uruchomić trybu Unified',
      },
      status: {
        providerSessionStateUnavailableForResume: "Nie można było przenieść stanu sesji",
        providerAccountAdoptionMismatch: "Dostawca pozostał na innym koncie",
        postSwitchVerificationFailed: "Nie można było zweryfikować konta dostawcy",
        recoveryRetryScheduled: "Zaplanowano ponowną próbę odzyskiwania dostawcy",
        metadataUpdateFailed: "Nie można było zapisać wyboru uwierzytelniania",
        noEligibleGroupMember: "Brak kwalifikującego się konta zapasowego",
        provider_session_state_unavailable_for_resume: 'Nie udało się przenieść stanu sesji',
        connected_service_materialization_identity_missing: 'Brakuje tożsamości usługi połączonej',
        resume_reachability_inputs_missing: 'Nie można zweryfikować wznowienia sesji',
        metadata_update_failed: 'Nie udało się zapisać wyboru uwierzytelniania sesji',
        no_eligible_group_member: 'Żadne konto zapasowe nie jest dostępne',
        recovery_retry_scheduled: 'Zaplanowano ponowienie odzyskiwania dostawcy',
                recovery_dead_lettered: 'Odzyskiwanie dostawcy osiągnęło limit ponowień',
                provider_account_adoption_mismatch: 'Dostawca pozostał na innym koncie',
                post_switch_verification_failed: 'Nie udało się zweryfikować konta dostawcy',
                connected_service_credential_reconnect_required: "Połączone konto wymaga ponownego połączenia",
                connected_service_credential_refresh_unavailable: "Odświeżanie połączonego konta tymczasowo się nie powiodło",
                claude_subscription_missing_claude_code_scope: 'Połącz ponownie subskrypcję Claude dla Claude Code',
        claude_subscription_native_auth_materialization_failed: 'Nie można było przygotować natywnego uwierzytelniania Claude Code',
        claude_subscription_setup_token_not_supported_for_unified: 'Połącz ponownie Claude przez OAuth dla trybu Unified',
      },
      body: {
        default: "Sprawdź połączone konta i spróbuj ponownie.",
        provider_session_state_unavailable_for_resume: 'Sprawdź połączone konta, a potem rozpocznij nową sesję z wybranym kontem albo kontynuuj z bieżącym kontem.',
        connected_service_materialization_identity_missing: 'W tej sesji brakuje tożsamości usługi połączonej potrzebnej do ponownego użycia zmaterializowanego stanu dostawcy. Zacznij od nowa na wybranym koncie albo kontynuuj z bieżącym kontem.',
        resume_reachability_inputs_missing: 'Daemon nie mógł zweryfikować stanu wznawiania dostawcy, bo brakowało wymaganych danych.',
        metadata_update_failed: 'Sesja nie mogła zapisać nowego wyboru uwierzytelniania. Spróbuj ponownie po zakończeniu synchronizacji sesji.',
        no_eligible_group_member: 'Żadne konto w tej grupie nie kwalifikuje się obecnie jako zapasowe. Sprawdź połączone konta i w razie potrzeby połącz profil ponownie.',
        recovery_retry_scheduled: 'Happier zaplanował ponowienie odzyskiwania dostawcy. Możesz ponowić teraz albo sprawdzić połączone konta.',
                recovery_dead_lettered: 'Happier wyczerpał automatyczne ponowienia odzyskiwania dostawcy. Sprawdź połączone konta albo połącz ponownie wybrany profil.',
                provider_account_adoption_mismatch: 'Dostawca pozostał na innym koncie po przełączeniu. Sprawdź połączone konta albo ponów przełączenie.',
                post_switch_verification_failed: 'Happier nie mógł zweryfikować, czy dostawca przyjął wybrane konto. Sprawdź połączone konta albo ponów przełączenie.',
                connected_service_credential_reconnect_required: "Wybrane połączone konto musi zostać połączone ponownie, zanim będzie można wznowić tę sesję. Połącz profil ponownie, a potem spróbuj jeszcze raz.",
                connected_service_credential_refresh_unavailable: "Nie udało się odświeżyć wybranego połączonego konta. Spróbuj ponownie za chwilę.",
                claude_subscription_missing_claude_code_scope: 'Ten profil Claude został połączony przed nadaniem zakresów Claude Code. Połącz go ponownie, a potem ponów sesję lub przełączenie grupy.',
        claude_subscription_native_auth_materialization_failed: 'Happier nie mógł utworzyć natywnego pliku poświadczeń Claude Code dla tego profilu. Połącz profil ponownie albo wybierz innego członka grupy.',
        claude_subscription_setup_token_not_supported_for_unified: 'Tryb Claude Unified musi uruchamiać CLI Claude z natywnymi poświadczeniami OAuth. Połącz ten profil ponownie przez OAuth zamiast tokenu konfiguracyjnego.',
      },
      actions: {
        viewLatestFork: "Zobacz najnowszy fork",
        viewNativeFork: "Zobacz natywny fork",
      },
    },
    reconnect: {
      identityMismatchTitle: 'Wykryto inne konto dostawcy',
      identityMismatchBody: 'Te dane wygladaja na przypisane do innego konta dostawcy. Kontynuuj tylko wtedy, gdy chcesz zastapic zapisana tozsamosc tego profilu.',
      identityMismatchConfirm: 'Zastap tozsamosc',
      targetMismatch: 'To ponowne połączenie zwróciło dane logowania dla innego połączonego profilu. Rozpocznij ponowne połączenie jeszcze raz z profilu docelowego.',
    },
    defaultAuth: {
      poolSuggestion: {
        body: ({ pool }: { pool: string }) => `Użyj puli ${pool}, aby sesje rotowały i omijały limity szybkości.`,
        accept: "Użyj puli",
        dismiss: "Odrzuć",
      },
      title: "Domyślna konfiguracja backendu",
      footer:
        "Wybierz, którego połączonego konta ma używać każdy backend przy uruchamianiu nowej sesji.",
      agentDetailTitle: "Domyślne uwierzytelnianie",
      agentDetailFooter:
        "Zapisuje tę samą wartość domyślną, której używają ustawienia połączonych usług.",
      rowDetail: "Domyślne",
      warning: {
        connected_profile_unavailable:
          "Domyślne połączone konto jest niedostępne; używane jest uwierzytelnianie natywne.",
        connected_group_unavailable:
          "Domyślna połączona grupa jest niedostępna; używane jest uwierzytelnianie natywne.",
        connected_group_disabled:
          "Połączone grupy są tutaj wyłączone; używane jest uwierzytelnianie natywne.",
        connected_service_unsupported:
          "Ten backend nie obsługuje tej połączonej usługi; używane jest uwierzytelnianie natywne.",
      },
    },
    list: {
      empty: "Brak połączonych usług.",
      connectedCount: ({ count }: { count: number }) =>
        `${count} ${plural({ count, one: "połączona usługa", few: "połączone usługi", many: "połączonych usług" })}`,
      needsReauth: "wymaga ponownej autoryzacji",
      notConnected: "niepołączone",
    },
    providerStateSharing: {
      title: "Udostępnianie stanu dostawcy",
      footer: "Uwierzytelnianie usług połączonych pozostaje odizolowane. Konfiguracja i stan sesji mogą być udostępniane tylko tam, gdzie dostawca obsługuje to bezpiecznie.",
      configTitle: "Udostępniaj konfigurację dostawcy",
      agentConfigTitle: ({ agent }: { agent: string }) => `Udostępnianie konfiguracji: ${agent}`,
      configLinkedTitle: "Linkuj aktywną konfigurację",
      configLinkedSubtitle: "Używaj linków tam, gdzie są obsługiwane, aby sesje usług połączonych czytały bieżącą konfigurację dostawcy.",
      configCopiedTitle: "Kopiuj migawkę konfiguracji",
      configCopiedSubtitle: "Kopiuj konfigurację dostawcy za każdym razem, gdy materializowane jest uwierzytelnianie.",
      configIsolatedTitle: "Izoluj konfigurację",
      configIsolatedSubtitle: "Nie udostępniaj natywnej konfiguracji dostawcy katalogom domowym usług połączonych.",
      stateTitle: "Udostępniaj sesje i stan dostawcy",
      agentStateTitle: ({ agent }: { agent: string }) => `Udostępnianie sesji i stanu: ${agent}`,
      stateEnabledSubtitle: "Pozwól obsługiwanym dostawcom wznawiać te same sesje między uwierzytelnianiem natywnym i połączonym.",
      stateDisabledSubtitle: "Trzymaj sesje i lokalny stan dostawcy oddzielnie, chyba że włączy je przepływ specyficzny dla dostawcy.",
      sharedStatePrivacyTitle: "Udostępnij stan dostawcy",
      sharedStatePrivacyBody: ({ agent }: { agent: string }) =>
        `${agent} może odczytywać lokalne pliki sesji dostawcy z katalogów usług połączonych. Włączaj to tylko dla kont, które możesz bezpiecznie powiązać.`,
      unavailable: {
        notImplemented: "Udostępnianie nie jest jeszcze dostępne dla tego dostawcy.",
        dynamicDiagnosticsRequired: "Przed włączeniem udostępnianie wymaga sprawdzenia dostępności w czasie działania.",
      },
    },
    quota: {
      loading: "Ładowanie…",
      error: ({ message }: { message: string }) => `Błąd: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `Ostatnia aktualizacja: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `Ostatnia aktualizacja: ${time} • nieaktualne`,
      noData: "Brak danych limitu",
      planLabel: ({ plan }: { plan: string }) => `Plan: ${plan}`,
      remaining: ({ percent }: { percent: string }) => `Pozostało ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `Pozostało ${percent} · reset za ${reset}`,
      usageCount: ({ used, limit }: { used: number; limit: number }) => `Użyto ${used}/${limit}`,
      recoveryCreditTitle: ({ count }: { count: number }) => count === 1 ? 'Dostępny 1 reset użycia' : `Dostępne resety użycia: ${count}`,
      recoveryCreditSubtitle: 'Zastosuj reset użycia, aby natychmiast przywrócić wyczerpany limit.',
      recoveryCreditExpires: ({ time }: { time: string }) => `Najwcześniej wygasa ${time}.`,
      recoveryCreditApplying: 'Stosowanie…',
      recoveryCreditMachineUnavailable: 'Żadna dostępna maszyna nie może teraz zastosować tego resetu.',
      recoveryCreditNothingToReset: 'Żadne wyczerpane okno użytkowania nie wymaga obecnie resetowania.',
      recoveryCreditBadge: ({ count }: { count: number }) => count === 1 ? '1 reset' : `${count} resety`,
      duration: {
        now: 'teraz',
        outdated: 'Przestarzałe',
        daysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    account: {
      configurationTitle: 'Ustawienia konta',
      configurationUpdatedTitle: 'Zaktualizowano ustawienia konta',
      configurationInvalid: 'Ustawienia konta są nieprawidłowe. Sprawdź każde pole i tam, gdzie to wymagane, podaj dokładny origin HTTPS bez danych logowania.',
      configurationRefreshApplied: 'Nowe ustawienia zostały zapisane, a połączone konto odświeżone.',
      configurationReconnectApplied: 'Nowe ustawienia zostały zapisane, a połączone konto połączone ponownie.',
      refreshA11y: 'Odśwież użycie i limity',
      usedDetail: ({ used, limit }: { used: string; limit: string }) => `Użyto ${used}/${limit}`,
      usageCaption: 'Użycie',
      resetsCaption: 'Resety',
      poolsLabel: 'Pule',
      poolsCount: ({ count }: { count: number }) => count === 1 ? '1 pula' : `${count} pule`,
      planEmailSubtitle: ({ plan, email }: { plan: string; email: string }) => `${plan} · ${email}`,
      activeMemberA11y: 'Aktywne konto',
      setActiveA11y: 'Ustaw jako aktywne konto',
      memberEnabledLabel: 'Konto włączone',
      resets: {
        now: 'teraz',
        inDays: ({ days }: { days: number }) => days === 1 ? 'za 1 dzień' : `za ${days} dni`,
        available: 'Dostępny reset użycia',
        rowLabel: ({ date, countdown }: { date: string; countdown: string }) =>
          countdown ? `Wygasa ${date} · ${countdown}` : `Wygasa ${date}`,
        confirmTitle: 'Zastosować reset użycia?',
        confirmMessage: 'To zużyje jeden dostępny reset dla tego połączonego konta.',
        confirmCta: 'Zastosuj reset',
        use: 'Użyj',
      },
    },
    pools: {
      title: 'Pule',
      autoBadge: 'Automatycznie',
      manualBadge: 'Ręcznie',
      memberWarningsA11y: ({ count }: { count: number }) =>
        count === 1 ? '1 członek wymaga uwagi' : `${count} członków wymaga uwagi`,
      create: {
        title: 'Utwórz pulę',
        subtitle: 'Grupuj połączone konta do automatycznego fallbacku.',
      },
      empty: {
        title: 'Brak pul',
        subtitle: 'Utwórz pulę, aby kierować sesje między wieloma połączonymi kontami.',
      },
      loadError: {
        title: "Nie udało się załadować pul",
        subtitle: "Nie udało się załadować pul kont. Sprawdź połączenie i spróbuj ponownie.",
        staleTitle: "Wyświetlane są ostatnio znane pule",
        staleSubtitle: "Nie udało się odświeżyć najnowszej listy pul. Spróbuj ponownie, aby ją zaktualizować.",
        retry: "Spróbuj ponownie",
      },
      detail: {
        summaryTitle: 'Podsumowanie',
        summary: ({ count, strategy }: { count: number; strategy: string }) =>
          `${count} kont${count === 1 ? 'o' : 'a'} · ${strategy}`,
        membersTitle: 'Członkowie',
        moveUp: 'Przenieś w górę',
        moveDown: 'Przenieś w dół',
        noMembersTitle: 'Brak członków',
        noMembersSubtitle: 'Dodaj połączone konto do tej puli.',
        serverActiveStatusTitle: "Zapisano na serwerze",
        serverActiveStatusSubtitle: "To jest trwale zapisane aktywne konto. Maszyny offline zastosują je po ponownym połączeniu; ten ekran nie oznacza, że wszystkie maszyny zakończyły synchronizację.",
        manualApplyDivergenceTitle: "Przełączono na serwerze, ale nie w aktywnych sesjach",
        manualApplyDivergenceSubtitle: ({ detail }: { detail: string }) => `Aktywne konto zmieniono na serwerze, ale nie udało się zastosować go do aktywnych sesji (${detail}). Ponów próbę lub przywróć, aby wszystko pozostało na poprzednim koncie.`,
        manualApplyRetry: "Ponów zastosowanie w aktywnych sesjach",
        manualApplyRevert: "Przywróć poprzednie konto",
        machineTarget: {
            title: "Nie można zastosować do działającej sesji",
            noBoundSession: "Żadna działająca sesja nie używa teraz tej puli, więc zmiany nie można zastosować na żywo. Uruchom sesję w tej puli i spróbuj ponownie.",
            offline: "Maszyna z sesją tej puli jest offline, więc zmiana nie może do niej dotrzeć. Przywróć maszynę online i spróbuj ponownie.",
        },
        behaviorTitle: 'Zachowanie',
        advancedTitle: 'Zaawansowane',
        advancedSubtitle: 'Dostosuj wyzwalacze fallbacku i zachowanie odzyskiwania.',
      },
      behavior: {
        autoRestorePrimaryTitle: 'Przywróć główne po resecie',
        autoRestorePrimarySubtitle: 'Wróć do konta głównego, gdy jego limit użycia się zresetuje.',
        switchOnGroupSubtitle: 'Pozwól, aby ten warunek uruchamiał automatyczne przełączenie puli.',
        switchOn: {
          usageLimit: 'Limit użycia',
          authExpired: 'Uwierzytelnienie wygasło',
          accountChanged: 'Konto zmienione',
          refreshFailure: 'Odświeżanie nie powiodło się',
        },
      },
      delete: {
        title: 'Usuń pulę',
        subtitle: 'Usuń tę pulę i jej konfigurację fallbacku.',
        confirmTitle: 'Usunąć pulę?',
        confirmMessage: ({ name }: { name: string }) =>
          `Usunąć ${name}? Sesje nie będą już używać tej puli.`,
      },
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
      segments: { accounts: "Konta", pools: "Pule" },
      unknownService: "Nieznana połączona usługa.",
      actionsGroupTitle: "Akcje",
      actions: {
        setDefault: "Ustaw jako domyślny",
        unsetDefault: "Usuń domyślny",
        editLabel: "Edytuj etykietę",
        reconnect: "Połącz ponownie",
        openAccount: "Otwórz konto",
      },
      setDefaultProfileTitle: "Ustaw domyślny profil",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `Domyślny: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "Wybierz, który profil ma być domyślnie zaznaczony",
      setProfileLabelTitle: "Ustaw etykietę profilu",
      setProfileLabelSubtitle:
        "Opcjonalna etykieta widoczna w selektorach logowania",
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
      connectAccessTokenTitle: "Połącz token dostępu",
      connectAccessTokenSubtitle: "Wklej osobisty token dostępu GitHub",
      openGithubTokenTemplateTitle: "Utwórz token GitHub",
      openGithubTokenTemplateSubtitle: "Otwórz GitHub z wypełnionymi uprawnieniami potrzebnymi Happier",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `Odłączyć ${service} (${profileId})?`,
      disconnectGroupCleanupConfirmBody: ({ service, profileId, groups }: { service: string; profileId: string; groups: string }) =>
        `Odłączyć ${service} (${profileId}) i usunąć z ${groups}?`,
      prompts: {
        profileIdTitle: "Id profilu",
        profileIdBody: "Użyj krótkiej etykiety, np. work, personal, alt.",
        apiKeyTitle: "Klucz API",
        apiKeyBody: "Wklej swój klucz API Anthropic.",
        apiKeyPlaceholder: "np. sk-ant-…",
        setupTokenTitle: "Token konfiguracji",
        setupTokenBody: "Wklej swój setup-token Claude (z claude setup-token).",
        setupTokenPlaceholder: "np. sk-ant-oat01-…",
        accessTokenTitle: "Token dostępu",
        accessTokenBody: "Wklej swój osobisty token dostępu GitHub. Użyj tokena fine-grained z uprawnieniami Contents, Pull requests i Administration ustawionymi na odczyt i zapis, aby przepływy PR i publikowania repozytoriów mogły działać.",
        accessTokenPlaceholder: "github_pat_…",
        profileLabelTitle: "Etykieta profilu",
        profileLabelBody: "Opcjonalne. Wyświetlane w wyborze autoryzacji.",
        profileLabelPlaceholder: "Konto służbowe",

        personalAccessTokenTitle: "Token dostępu osobistego",
        personalAccessTokenBody: "Wklej swój fine-grained personal access token GitHub.",
        personalAccessTokenPlaceholder: "github_pat_…",
        apiTokenTitle: "Token API",
        apiTokenBody: "Wklej token API dostawcy albo hasło aplikacji.",
        apiTokenPlaceholder: "Token API",},
      alerts: {
        invalidProfileIdTitle: "Nieprawidłowe id profilu",
        invalidProfileIdBody:
          "Użyj liter, cyfr, myślnika lub podkreślenia (maks. 64).",
        unknownProfileTitle: "Nieznany profil",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `Nie istnieje profil \"${profileId}\" dla ${service}.`,
        failedToOpenTokenSetupUrl: "Nie udało się otworzyć ustawień tokena GitHub.",
      },
      profiles: {
        empty: "Brak profili.",
        connected: "Połączono",
        defaultBadge: "Domyślny",
        needsReauth: "Wymaga ponownej autoryzacji",
      },
      groups: {
        title: "Grupy kont",
        empty: "Nie ma jeszcze grup kont.",
        subtitle: ({ count }: { count: number }) => `${count} konta`,
        subtitleWithActive: ({ profileId, count }: { profileId: string; count: number }) =>
          `Aktywne: ${profileId} • ${count} konta`,
        actionsTitle: "Akcje grupy kont",
        createTitle: "Utwórz grupę kont",
        createSubtitle: "Grupuj połączone profile do odzyskiwania awaryjnego.",
        noProfilesTitle: "Brak połączonych profili",
        noProfilesBody: "Połącz co najmniej jeden profil przed utworzeniem grupy kont.",
        invalidGroupTitle: "Nieprawidłowe ID grupy",
        invalidGroupBody: "Użyj liter, cyfr, kropek, myślników lub podkreśleń (maks. 64).",
        statusReady: "Gotowe",
        statusSwitching: "Przełączanie",
        statusExhausted: "Wyczerpane",
        statusError: "Błąd",
        statusUnknown: "Nieznany",
        statusNeedsMembers: "Wymaga włączonych członków",
        activeMember: ({ profileId }: { profileId: string }) => `Aktywne: ${profileId}`,
        enabledMembers: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} włączonych`,
        autoFallbackEnabled: "Automatyczne przełączenie włączone",
        autoFallbackDisabled: "Automatyczne przełączenie wyłączone",
        strategyPriority: "Kolejność priorytetów",
        strategyLeastLimited: "Najpierw najmniej ograniczone",
        strategyManual: "Przełączanie ręczne",
        priority: ({ priority }: { priority: string }) => `Priorytet ${priority}`,
        cooldown: ({ time }: { time: string }) => `Okres oczekiwania do ${time}`,
        memberActive: "Aktywny członek",
        memberEnabled: "Włączony",
        memberDisabled: "Wyłączony",
        memberPriority: ({ priority }: { priority: number }) => `Priorytet ${priority}`,
        memberExhaustedUntil: ({ time }: { time: string }) => `Wyczerpane do ${time}`,
        memberQuotaExhaustedUntil: ({ time }: { time: string }) => `Limit użycia do ${time}`,
        memberRateLimitedUntil: ({ time }: { time: string }) => `Limit częstotliwości do ${time}`,
        memberCapacityLimitedUntil: ({ time }: { time: string }) => `Ograniczona pojemność do ${time}`,
        memberAuthInvalidUntil: ({ time }: { time: string }) => `Nieprawidłowe uwierzytelnienie do ${time}`,
        memberPlanUnavailableUntil: ({ time }: { time: string }) => `Plan niedostępny do ${time}`,
        memberValidationBlockedUntil: ({ time }: { time: string }) => `Walidacja zablokowana do ${time}`,
        memberLastFailure: ({ reason }: { reason: string }) => `Ostatni problem: ${reason}`,
        warningNoEnabledMembers: "Brak włączonych członków dostępnych dla przełączenia awaryjnego.",
        warningNoFallbackMember: "Dodaj lub włącz kolejnego członka, zanim automatyczne przełączenie będzie mogło zmieniać konta.",
        deleteTitle: "Usunąć grupę kont?",
        deleteBody: ({ groupId }: { groupId: string }) => `Usunąć „${groupId}”? Profile pozostaną połączone.`,
        prompts: {
          groupIdTitle: "ID grupy",
          groupIdBody: "Użyj krótkiej etykiety, takiej jak team, work lub fallback.",
          groupIdPlaceholder: "zespol",
        },
      },
      groupActions: {
        editTitle: "Edytuj grupę",
        searchMembersPlaceholder: "Szukaj profili",
        noProfilesAvailable: "Brak dostępnych połączonych profili.",
        membersTitle: "Członkowie",
        membersSubtitle: "Zaznacz profile, które mają należeć do tej grupy.",
        accountFallbackDisabled: "Automatyczny fallback jest wyłączony na tym serwerze.",
        enableFallback: "Włącz automatyczne przełączenie",
        disableFallback: "Wyłącz automatyczne przełączenie",
        makeActive: "Ustaw jako aktywne",
        useManualStrategy: "Użyj przełączania ręcznego",
        usePriorityStrategy: "Użyj kolejności priorytetów",
        activeMember: "Aktywny członek",
        manualApplyFailedTitle: "Konto zmienione, aktualizacja demona niepełna",
        manualApplyFailedBody: "Aktywne konto zmieniło się na serwerze, ale nie udało się zaktualizować jednej lub więcej uruchomionych sesji lokalnych. Uruchom ponownie albo wznów te sesje, jeśli nadal używają poprzedniego konta.",
        enableMember: "Włącz członka",
        disableMember: "Wyłącz członka",
        editPriority: "Edytuj priorytet",
        priorityTitle: "Priorytet członka",
        priorityBody: "Niższe liczby są próbowane jako pierwsze.",
        invalidPriorityTitle: "Nieprawidłowy priorytet",
        invalidPriorityBody: "Wprowadź liczbę całkowitą.",
        removeMember: "Usuń członka",
        removeMemberConfirmTitle: "Usuń członka",
        removeMemberConfirmBody: ({ profileId }: { profileId: string }) => `Usunąć "${profileId}" z tej grupy?`,
        runtimeFallbackUnsupported: 'Automatyczne przełączanie jest niedostępne dla tej połączonej usługi.',
        removeMembersConfirmBody: ({ count, members }: { count: number; members: string }) => `Usunąć ${count === 1 ? "tego członka" : `tych członków (${count})`} z tej puli?\n\n${members}`,
        manageMembersTitle: 'Zarządzaj członkami',
        manageMembersSubtitle: ({ count, total }: { count: number; total: number }) => `${count} z ${total} kont`,
      },
      groupDetail: {
        routeTitle: "Grupa",
        nameTitle: "Nazwa grupy",
        namePromptBody: "Wybierz nazwę widoczną w ustawieniach i selektorach uwierzytelniania.",
        groupIdTitle: "ID grupy",
        membersTitle: "Członkowie",
        membersSubtitle: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} włączonych`,
        optionsTitle: "Opcje",
        autoSwitchTitle: "Automatyczne przełączenie",
        autoSwitchEnabledSubtitle: "Przełącz na innego członka, gdy aktywne konto wymaga odzyskiwania.",
        autoSwitchDisabledSubtitle: "Używaj aktywnego członka, dopóki nie zmienisz go ręcznie.",
        strategyTitle: "Strategia wyboru",
        strategyPriorityTitle: "Kolejność priorytetów",
        strategyPrioritySubtitle: "Najpierw próbuj niższych numerów priorytetu.",
        strategyLeastLimitedTitle: "Najpierw najmniej ograniczony",
        strategyLeastLimitedSubtitle: "Preferuj członka z największym użytecznym limitem.",
        strategyManualTitle: "Przełączanie ręczne",
        strategyManualSubtitle: "Używaj tylko aktywnego członka, dopóki nie zostanie zmieniony ręcznie.",
        softSwitchThresholdTitle: "Próg miękkiego przełączenia",
        softSwitchThresholdSubtitle: ({ percent }: { percent: string }) => `Przełącz poniżej ${percent}% pozostałego limitu, gdy dostępny jest lepszy członek.`,
        softSwitchThresholdPromptTitle: "Próg miękkiego przełączenia",
        softSwitchThresholdPromptBody: "Wpisz pozostały procent, przy którym Happier powinien preferować bezpieczniejsze konto. Użyj 0, aby wyłączyć miękkie przełączanie.",
        invalidSoftSwitchThresholdTitle: "Nieprawidłowy próg",
        invalidSoftSwitchThresholdBody: "Wpisz liczbę od 0 do 100.",
        staleProbeTitle: "Sprawdzaj nieświeży limit po",
        staleProbeSubtitle: ({ minutes }: { minutes: string }) => `Sprawdź ponownie, gdy dane limitu są starsze niż ${minutes} min.`,
        staleProbePromptTitle: "Sprawdzaj nieświeży limit po",
        staleProbePromptBody: "Wpisz, przez ile minut dane limitu mogą być ponownie używane, zanim Happier sprawdzi je ponownie.",
        invalidStaleProbeTitle: "Nieprawidłowy interwał sprawdzania",
        invalidStaleProbeBody: "Wpisz co najmniej 1 minutę.",
        switchBudgetTitle: "Limity automatycznego przełączania",
        switchBudgetSubtitle: ({ perTurn, perHour }: { perTurn: string; perHour: string }) => `Maksymalnie ${perTurn} automatycznych przełączeń na turę i ${perHour} na godzinę sesji.`,
        recoveryModeTitle: "Tryb odzyskiwania",
        recoveryModeOffSubtitle: "Nie odzyskuj tej grupy automatycznie.",
        recoveryModeWaitUntilResetSubtitle: "Poczekaj na zresetowanie limitu, a następnie wznów.",
        recoveryModeSwitchThenResumeSubtitle: "Przełącz na innego członka, a następnie wznów.",
        recoveryModeSwitchOrWaitSubtitle: "Przełącz na innego członka, gdy to możliwe; w przeciwnym razie poczekaj na reset.",
        recoveryPromptTitle: "Monity odzyskiwania",
        recoveryPromptSubtitle: "Używaj standardowych monitów odzyskiwania i wznawiania dla tej grupy.",
        missingTitle: "Nie znaleziono grupy",
        missingBody: ({ service, groupId }: { service: string; groupId: string }) =>
          `Nie istnieje grupa "${groupId}" dla ${service}.`,
      },

      connectPersonalAccessTokenTitle: "Połącz token dostępu osobistego",
      connectPersonalAccessTokenSubtitle: "Wklej fine-grained personal access token",
      connectApiTokenTitle: "Połącz token API",
      connectApiTokenSubtitle: "Wklej token API dostawcy albo hasło aplikacji",
      openTokenSetupTitle: "Otwórz konfigurację tokenu",
      openTokenSetupSubtitle: "Otwórz stronę konfiguracji dostawcy",
      openPersonalAccessTokenSetupTitle: "Utwórz personal access token",
      openPersonalAccessTokenSetupSubtitle: "Otwórz konfigurację fine-grained tokenu GitHub",},
    profile: {
      profileId: "Id profilu",
      status: "Stan",
      email: "E-mail",
      accountId: "Id konta",
      providerAccountId: "Id konta dostawcy",
      quotaTitle: "Limity",
      defaultSubtitle: "Ten profil jest domyślnie wybrany",
      setDefaultSubtitle: "Użyj tego profilu domyślnie",
      disconnectSubtitle: "Usuń poświadczenia dla tego profilu",
      reconnectSubtitle: "Ponownie uwierzytelnij ten profil",
      replaceTokenSubtitle: "Zastąp poświadczenia dla tego profilu",
      connectionGroupTitle: "Połączenie",
      connectedVia: "Połączono przez",
      connectedViaToken: "Token dostępu",
      connectedViaOauth: "OAuth",
      lastRefreshed: "Ostatnio odświeżono",
      refreshQuotaNow: "Odśwież limit teraz",
      refreshQuotaNowSubtitle: "Pobierz najnowsze użycie dla tego konta.",
      poolsGroupTitle: "Pule",
      pools: {
        emptyTitle: "W żadnej puli",
        emptySubtitle: "Dodaj to konto do puli, aby uzyskać automatyczne przełączanie.",
      },
      addToPool: "Dodaj do puli",
      addToPoolSubtitle: "Użyj tego konta jako zapasowego w puli.",
      settingsGroupTitle: "Ustawienia",
      setDefaultRowTitle: "Ustaw jako domyślne",
      removeGroupTitle: "Usuń",
    },
    authModal: {
      nativeAuthTitle: "Natywne uwierzytelnianie backendu",
      nativeAuthSubtitle: "Użyj lokalnego logowania CLI / kluczy API",
            groupSubtitle: 'Grupa kont',
      connectedServicesTitle: "Użyj połączonych usług",
      connectedServicesSubtitle: "Pobierz i zmaterializuj z chmury Happier",
      notConnectedTitle: "Brak połączonych usług",
      notConnectedSubtitle: "Dotknij, aby otworzyć ustawienia",
      profileLabel: "Profil",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "Plik zbyt duży",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `Pominięto ${count} ${plural({ count, one: "plik", few: "pliki", many: "plików" })}, które przekraczają maksymalny rozmiar załącznika.`,
      noClipboardImageTitle: "Brak obrazu w schowku",
      noClipboardImageBody: "Skopiuj obraz, a potem wklej go jako załącznik.",
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
        invalidDirectoryMessage: "Użyj ścieżki względnej, np. .happier/uploads.",
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
    markdownEditMode: {
      title: 'Domyslny tryb edycji Markdown',
      footer: 'Wybierz, jak pliki Markdown otwieraja sie do edycji. Tryb wizualny oferuje edytor WYSIWYG; tryb surowy edytuje zrodlo Markdown bezposrednio. Pliki, ktorych nie da sie bezpiecznie przekonwertowac w obie strony, zawsze otwieraja sie jako surowe.',
      options: {
        rich: {
          title: 'Wizualny (WYSIWYG)',
          subtitle: 'Edytuj Markdown wizualnie z formatowaniem na zywo.',
        },
        raw: {
          title: 'Tekst surowy',
          subtitle: 'Edytuj zrodlo Markdown bezposrednio.',
        },
      },
      disabledReason: {
        mdx: 'Edycja jako tekst surowy, poniewaz to plik MDX.',
        tooLarge: 'Edycja jako tekst surowy, poniewaz ten plik jest zbyt duzy dla edytora wizualnego.',
        referenceLinks: 'Edycja jako tekst surowy, poniewaz ten plik zawiera linki w stylu referencyjnym.',
        footnotes: 'Edycja jako tekst surowy, poniewaz ten plik zawiera przypisy.',
        htmlOrJsx: 'Edycja jako tekst surowy, poniewaz ten plik zawiera HTML lub JSX.',
      },
    },
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
      pull: {
        title: "Pytaj przed pull",
        subtitle: "Pokaż potwierdzenie przed pobraniem zmian zdalnych.",
      },
      push: {
        title: "Pytaj przed push",
        subtitle: "Pokaż potwierdzenie przed wysłaniem lokalnych commitów.",
      },

      confirmBeforePulling: {
        title: "Potwierdzaj przed pull",
        subtitle: "Pytaj przed pobraniem i scaleniem zmian zdalnych.",
      },
      confirmBeforePushing: {
        title: "Potwierdzaj przed push",
        subtitle: "Pytaj przed wysłaniem lokalnych commitów na remote.",
      },
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
      },},
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
    title: 'Pulpit',
    footer: 'Steruje integracjami pulpitu Tauri na tym komputerze.',
    startOnLoginTitle: 'Uruchamiaj przy logowaniu',
    startOnLoginSubtitle: 'Uruchamiaj Happier automatycznie po zalogowaniu się na tym komputerze.',

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
    title: 'Zwierzaki',
    previewTitle: 'Towarzysz Blink',
    previewSubtitle: 'Mały towarzysz dla stanu sesji i uwagi wymaganej przy przeglądzie.',
    disabledTitle: 'Zwierzaki są wyłączone',
    disabledSubtitle: 'Włącz Zwierzaki w funkcjach, aby używać towarzyszy na tym urządzeniu.',
    disabledByServerTitle: 'Ten serwer wyłączył zwierzaki',
    disabledByServerSubtitle: 'Administrator wyłączył towarzyszy-zwierzaki dla tego serwera.',
    accountTitle: 'Domyślne ustawienie konta',
    enabledTitle: 'Włącz zwierzaki',
    enabledSubtitle: 'Pokazuj powierzchnie towarzysza dla tego konta.',
    companionSizeTitle: 'Rozmiar zwierzaka',
    companionSizeSubtitle: 'Dostosuj rozmiar towarzysza na tym urządzeniu.',
    companionSizeValue: ({ percent }: { percent: number }) => `${percent}%`,
    deviceOverrideTitle: 'Używaj na tym urządzeniu',
    deviceOverrideSubtitle: 'Lokalnie nadpisz ustawienie zwierzaka z konta.',
    sourceTitle: 'Źródło zwierzaka',
    builtInSubtitle: 'Wbudowany w Happier.',
    builtInBlinkSubtitle: 'Zamienia sygnały sesji w spokojne małe kontrolki statusu.',
    builtInFurySubtitle: 'Testuje trudne przepływy, zanim trafią na produkcję.',
    builtInMiloSubtitle: 'Pilnuje porządku w UI i drzemie na nieudanych testach.',
    builtInOliSubtitle: 'Wysyła ciche poprawki, zanim build je zauważy.',
    builtInTitiSubtitle: 'Triage’uje notatki release ze skupieniem staff seniora.',
    localLibraryTitle: 'To urządzenie',
    localLibraryFooter: 'Lokalne zwierzaki pozostają na tym urządzeniu, chyba że zaimportujesz je na konto.',
    helpDocsTitle: 'Pomoc zwierzaków',
    helpDocsSubtitle: 'Otwórz dokumentację Happier dotyczącą konfiguracji i rozwiązywania problemów.',
    detectCodexPetsTitle: 'Wykrywaj zwierzaki Codex',
    detectCodexPetsSubtitle: 'Szukaj zgodnych zwierzaków w lokalnych Codex homes.',
    detectedCodexPetsTileSubtitle: 'Znaleziony w Codex i gotowy do dołączenia do tego urządzenia.',
    detectedCodexPetsEmptyTitle: 'Nie znaleziono zwierzaków Codex',
    detectedCodexPetsEmptySubtitle: 'Utwórz jednego w Codex, a potem uruchom wykrywanie ponownie.',
    detectedCodexPetsErrorTitle: 'Nie udało się wykryć zwierzaków Codex',
    detectedCodexPetsErrorSubtitle: 'Sprawdź, czy daemon jest połączony, i spróbuj ponownie.',
    detectedCodexPetsNoTargetTitle: 'Brak dostępnego daemona',
    detectedCodexPetsNoTargetSubtitle: 'Uruchom Happier na tym komputerze, a potem ponownie wykryj zwierzaki Codex.',
    detectedCodexPetsDaemonMismatchTitle: 'Zaktualizuj daemon, aby wykrywać zwierzaki',
    detectedCodexPetsDaemonMismatchSubtitle: 'Ten daemon nie udostępnia jeszcze wykrywania zwierzaków. Odśwież stack i spróbuj ponownie.',
    useOnThisDeviceTitle: 'Używaj na tym urządzeniu',
    useOnThisDeviceSubtitle: 'Wybierz lokalnego zwierzaka bez zmiany domyślnego ustawienia konta.',
    importedLocalSubtitle: 'Zaimportowany z Codex na tym urządzeniu.',
    removeFromDeviceTitle: 'Usuń z urządzenia',
    removeFromDeviceSubtitle: 'Usuń tego lokalnego zwierzaka z tego urządzenia.',
    accountLibraryTitle: 'Biblioteka konta',
    accountLibraryFooter: 'Zsynchronizowane zwierzaki są dostępne na zalogowanych urządzeniach.',
    accountPetTileSubtitle: 'Zsynchronizowany z Twojego konta.',
    removeFromDeviceDaemonErrorTitle: 'Usunięto lokalnie; czyszczenie demona nie powiodło się',
    removeFromDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `Zwierzak został usunięty z listy tego urządzenia, ale czyszczenie demona zwróciło ${code}.`,
    importToDeviceDaemonErrorTitle: 'Nie udało się zaimportować zwierzaka',
    importToDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `Demon nie mógł zaimportować tego zwierzaka. Wykryj ponownie zwierzaki Codex i spróbuj jeszcze raz. (${code})`,
    importToAccountTitle: 'Importuj na konto',
    importToAccountSubtitle: 'Prześlij zgodnego lokalnego zwierzaka do użycia na wielu urządzeniach.',
    desktopOverlayTitle: 'Nakładka pulpitu',
    overlayTrayTitle: 'Aktywność zwierzaka',
    overlayStatusWaiting: 'Oczekuje',
    overlayStatusFailed: 'Niepowodzenie',
    overlayStatusReview: 'Przegląd',
    overlayStatusRunning: 'Uruchomione',
    overlayQuickReplyPlaceholder: 'Szybka odpowiedź',
    overlayReplyAction: 'Odpowiedz',
    overlayQuickReplyAction: 'Wyślij szybką odpowiedź',
    overlayDismissAction: 'Odrzuć aktywność',
    overlayTuckAction: 'Schowaj',
    overlayClosePetAction: 'Zamknij zwierzaka',
    desktopOverlayEnabledTitle: 'Włącz nakładkę pulpitu',
    desktopOverlayEnabledSubtitle: 'Pokazuj zwierzaka w przezroczystym oknie towarzysza na pulpicie.',
    desktopOverlayDeviceOverrideTitle: 'Nakładka pulpitu na tym urządzeniu',
    desktopOverlayVisibilityModeTitle: 'Widoczność nakładki na tym urządzeniu',
    desktopOverlayVisibilityModeSubtitle: 'Wybierz, kiedy lokalnie pokazywać zwierzaka na pulpicie.',
    desktopOverlayResetPositionTitle: 'Resetuj pozycję',
    desktopOverlayResetPositionSubtitle: 'Przenieś nakładkę z powrotem do prawego dolnego rogu.',
    overrideInherit: 'Wartość konta',
    overrideEnabled: 'Włączone',
    overrideDisabled: 'Wyłączone',
    visibilityModeInherit: 'Wartość konta',
    visibilityModeAlwaysWhenEnabled: 'Zawsze po włączeniu',
    visibilityModeAttentionOrActive: 'Uwaga lub aktywność',
    visibilityModeAttentionOnly: 'Tylko uwaga',
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
    desktop: {
      title: 'Powiadomienia desktopowe',
      footer: 'Sprawdza lokalne dostarczanie powiadomień dla tej aplikacji desktopowej.',
      permission: {
        title: 'Uprawnienie systemowe',
        checkingSubtitle: 'Sprawdzanie uprawnienia powiadomień macOS',
        grantedSubtitle: 'macOS pozwala tej aplikacji wysyłać powiadomienia',
        notGrantedSubtitle: 'Stuknij, aby poprosić o uprawnienie powiadomień macOS',
        errorSubtitle: 'Nie można odczytać uprawnienia powiadomień macOS',
      },
    },
    push: {
      title: "Powiadomienia push",
      footer:
        "Te powiadomienia są wysyłane z Twojego CLI przez Expo, gdy sesja wymaga Twojej uwagi.",
      enabledSubtitle: "Zezwól na powiadomienia push dla tego konta",
      troubleshootTitle: "Rozwiązywanie problemów",
      troubleshootSubtitle: "Sprawdź uprawnienia i zarejestrowane urządzenia",
    },
    pushPriming: {
        title: 'Włączyć powiadomienia?',
        body: 'Happier może informować, gdy agent zakończy pracę, potrzebuje decyzji o uprawnieniach lub czeka na Ciebie. Możesz to zmienić w każdej chwili w Ustawieniach.',
        accept: 'Włącz',
        decline: 'Nie teraz',
        blockedTitle: 'Powiadomienia są zablokowane',
        blockedBody: 'Powiadomienia dla tej aplikacji są wyłączone w ustawieniach systemu. Otwórz ustawienia, aby je zezwolić.',
        openSettings: 'Otwórz ustawienia',
        openSettingsFailed: 'Nie udało się otworzyć ustawień systemu.',
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
        runtimeUnavailable: 'Niedostępne',
        runtimeUnavailableSubtitle: 'Nie udało się połączyć z usługą powiadomień na tym urządzeniu.',
        runtimeTimeoutSubtitle: 'Usługa powiadomień nie odpowiedziała. Sprawdź połączenie z serwerem deweloperskim i spróbuj ponownie.',
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
        checkingSubtitle: 'Odczytywanie tokenu tego urządzenia…',
        runtimeUnavailableSubtitle: 'Nie udało się połączyć z usługą powiadomień na tym urządzeniu.',
        runtimeTimeoutSubtitle: 'Usługa powiadomień nie odpowiedziała na czas.',
        deviceUnavailableSubtitle: 'Ta kompilacja nie może dostarczyć tokenu push. Sprawdź, czy powiadomienia push są włączone dla tej kompilacji.',
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

      account: "Domyślne konto",
      accountDescription:
        "Użyj zachowania powiadomień w aplikacji z konta na tym urządzeniu",},
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

    activitySurfaces: {
      title: 'Powierzchnie aktywności',
      footer: 'Steruje Live Activities, Dynamic Island i widgetami na tym urządzeniu.',
      enabledSubtitle: 'Włącz widoczne powierzchnie sesji na tym urządzeniu',
      shared: {
        title: 'Wspólne zachowanie',
        footer: 'Wybierz, jak mają działać dotknięcia i treści podglądu we wszystkich powierzchniach aktywności.',
      },
      tapTargetTitle: 'Cel dotknięcia',
      tapTargetOpenSessionTitle: 'Otwórz bieżącą sesję',
      tapTargetOpenSessionsTitle: 'Otwórz aktywne sesje',
      privacyTitle: 'Prywatność',
      privacyStatusOnlyTitle: 'Tylko stan',
      privacyTitleOnlyTitle: 'Tylko tytuł',
      privacyIncludePreviewTitle: 'Uwzględnij tekst podglądu',
      liveActivities: {
        title: 'Live Activities',
        footer: 'Steruje prezentacją na ekranie blokady i w Dynamic Island na iPhonie.',
        enabledSubtitle: 'Włącz Live Activities na tym urządzeniu',
        strategyTitle: 'Activity strategy',
        strategySubtitle: 'Wybierz, czy jedna aktywność ma podążać za najważniejszą sesją, czy pozostać przypięta.',
        focusedTitle: 'Skupiona sesja',
        attentionTitle: 'Uwaga',
        runningTitle: 'Sesje w trakcie',
        dynamicPrimaryTitle: 'Dynamic primary',
        pinnedPrimaryTitle: 'Pinned primary',
        sessionSpecificTitle: 'Session specific',
        presentationTitle: 'Tryb prezentacji',
        presentationSubtitle: 'Wybierz, jak Live Activities mają wyróżniać bieżącą sesję.',
        maxConcurrentTitle: 'Maksymalna liczba równoczesnych aktywności',
        maxConcurrentOneTitle: '1 aktywność',
        maxConcurrentTwoTitle: '2 aktywności',
        maxConcurrentFourTitle: '4 aktywności',
        previewTextTitle: 'Tekst podglądu',
        actionButtonsTitle: 'Przyciski akcji',
        includeReadyTitle: 'Uwzględnij gotowe sesje',
        includeThinkingTitle: 'Uwzględnij sesje myślące',
        remoteUpdates: {
          title: 'Zdalne aktualizacje',
          footer: 'Diagnostyka wybranego serwera do aktualizowania Live Activities, gdy aplikacja nie jest już na pierwszym planie.',
          effectiveModeTitle: 'Rzeczywista dostawa',
          effectiveMode: {
            hosted_happier_relay: 'Hostowany relay',
            direct_apns: 'Bezpośrednie APNs',
            background_wake_best_effort: 'Wybudzanie w tle',
            local_only: 'Tylko lokalne runtime',
            disabled: 'Wyłączone',
          },
          details: {
            available: 'Dostępne',
            unavailable: 'Niedostępne',
            blocked: 'Zablokowane',
            missingCredentials: 'Brak danych uwierzytelniających',
            bestEffort: 'Najlepsza próba',
            selected: 'Wybrane',
            fallback: 'Awaryjne',
            preferred_unavailable: 'Tylko lokalnie',
            local_only: 'Tylko lokalnie',
            disabled: 'Wyłączone',
            runtimeOnly: 'Tylko runtime',
          },
          hostedRelayTitle: 'Hostowany relay Happier',
          hostedRelayAvailableSubtitle: 'Hostowany relay jest skonfigurowany dla tego wybranego serwera.',
          hostedRelayDisabledSubtitle: 'Hostowany relay jest wyłączony dla tego serwera self-hosted.',
          hostedRelayBlockedSubtitle: 'Tożsamość hostowanego relay i obsługa dostawcy nie są jeszcze zaimplementowane.',
          hostedRelayUnavailableSubtitle: 'Hostowany relay nie jest dostępny z tego wybranego serwera.',
          directApnsTitle: 'Bezpośrednie APNs',
          directApnsConfiguredSubtitle: 'Dane uwierzytelniające bezpośredniego APNs są skonfigurowane bez ujawniania sekretów.',
          directApnsMissingCredentialsSubtitle: 'Bezpośrednie APNs nie ma serwerowej konfiguracji danych uwierzytelniających.',
          directApnsUnavailableSubtitle: 'Bezpośrednie APNs jest niedostępne dla tego wybranego serwera.',
          backgroundWakeTitle: 'Wybudzanie w tle',
          backgroundWakeBestEffortSubtitle: 'Wybudzanie w tle może spróbować odświeżyć dane, ale iOS może je opóźnić lub odrzucić.',
          backgroundWakeDisabledSubtitle: 'Awaryjne wybudzanie w tle jest wyłączone na tym wybranym serwerze.',
          localOnlyTitle: 'Aktualizacje tylko lokalne',
          localOnlyRuntimeSubtitle: 'Aktualizacje tylko lokalne działają, gdy runtime aplikacji może się wykonywać; nie obiecują aktualizacji po zamknięciu aplikacji.',
        },
      },
      widgets: {
        title: 'Widgety ekranu głównego',
        footer: 'Steruje widokiem ogólnym widgetów wyświetlanym na ekranie głównym urządzenia.',
        enabledSubtitle: 'Włącz widgety na tym urządzeniu',
        summaryTitle: 'Podsumowanie',
        attentionTitle: 'Uwaga',
        runningTitle: 'Sesje w trakcie',
        previewTextTitle: 'Tekst podglądu',
        machinePathTitle: 'Maszyna i ścieżka',
      },
    },
    quietHours: {
      title: 'Godziny ciszy',
      footer: 'Godziny ciszy konta domyślnie obowiązują wszędzie. Nadpisania urządzenia wpływają tylko na to urządzenie.',
      accountOffTitle: 'Brak godzin ciszy konta',
      accountOffSubtitle: 'Dostarczaj powiadomienia konta o każdej porze',
      accountNightlyTitle: 'Każdej nocy od 22:00 do 7:00',
      accountNightlySubtitle: 'Wyciszaj lub pomijaj kanały uwagi nocą',
      deviceAccountTitle: 'To urządzenie używa godzin konta',
      deviceAccountSubtitle: 'Użyj zsynchronizowanej polityki godzin ciszy konta',
      deviceDisabledTitle: 'Wyłącz godziny ciszy na tym urządzeniu',
      deviceDisabledSubtitle: 'Pozwól temu urządzeniu dostarczać powiadomienia także podczas godzin ciszy konta',
      deviceCustomNightlyTitle: 'To urządzenie używa nocnych godzin ciszy',
      deviceCustomNightlySubtitle: 'Nadpisz godziny konta zakresem od 22:00 do 7:00 na tym urządzeniu',
    },
    sounds: {
      title: 'Dźwięki',
      footer: 'Domyślne dźwięki konta synchronizują się wszędzie. To urządzenie może wyciszać lokalne dźwięki.',
      accountHappierTitle: 'Dźwięki Happier',
      accountHappierSubtitle: 'Użyj łagodniejszego tonu dla aktualizacji i jaśniejszego, gdy potrzebna jest uwaga',
      accountDefaultTitle: 'Domyślny systemowy',
      accountDefaultSubtitle: 'Użyj dźwięku powiadomień platformy',
      accountSilentTitle: 'Cicho',
      accountSilentSubtitle: 'Dostarczaj powiadomienia bez dźwięku',
      deviceEnabledTitle: 'Odtwarzaj dźwięki na tym urządzeniu',
      deviceEnabledSubtitle: 'Nadpisanie urządzenia dla lokalnych dźwięków powiadomień',
      previewTitle: 'Podgląd dźwięku',
      previewSubtitle: 'Wyślij lokalne powiadomienie testowe na tym urządzeniu',
      previewNotificationTitle: 'Podgląd dźwięku powiadomienia',
      previewNotificationBody: 'Tak będzie działał obecny dźwięk powiadomień.',
    },},

    notifications: {
      actions: {
        allow: 'Zezwól',
        deny: 'Odmów',
        answer: 'Odpowiedz',

        other: 'Inne',
        alwaysAllowTool: ({ tool }: { tool: string }) => `Zawsze zezwalaj: ${tool}`,},
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

  settingsProviders: settingsProvidersTranslations.pl,

  settingsAgents: {
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
      channelPlugin: "Wtyczka",
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
      installInfoUseAgentCliInstaller: "Użyj instalatora CLI dostawcy",
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
                    claudeUnifiedTerminal: {
                        title: "Zunifikowany terminal Claude",
                        footer: "Uruchamia Claude Code w sesji hostowanej przez terminal i pozwala Happier przekazywać obsługiwane prompty przez host terminala."
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
                    claudeUnifiedTerminalEnabled: {
                        title: "Użyj trybu zunifikowanego terminala",
                        subtitle: "Utrzymuje Claude Code jako kanoniczną sesję terminala i wysyła obsługiwane prompty Happier do tej sesji."
                    },
                    claudeUnifiedTerminalHost: {
                        title: "Host terminala",
                        subtitle: "Wybierz, którego multipleksera terminala Happier używa dla zunifikowanych sesji Claude.",
                        options: {
                            auto: {
                                title: 'Automatycznie',
                                subtitle: "Preferuje najlepszy obsługiwany host na tej maszynie."
                            },
                            tmux: {
                                title: "tmux",
                                subtitle: "Używa tmux, gdy jest dostępny."
                            },
                            zellij: {
                                title: 'zellij',
                                subtitle: "Używa Zellij, gdy jest dostępny i obsługiwany."
                            }
                        }
                    },
                    claudeUnifiedTerminalResumeChoice: {
                        title: "Wznawianie duzych sesji",
                        subtitle: "Wybierz, jak Happier odpowiada, gdy Claude pyta, jak wznowic duza sesje.",
                        options: {
                            ask_every_time: {
                                title: "Pytaj za kazdym razem",
                                subtitle: "Pokazuj akcje uzytkownika w sesji za kazdym razem, gdy Claude zapyta."
                            },
                            resume_from_summary: {
                                title: "Wznow z podsumowania",
                                subtitle: "Uzyj podsumowania Claude, aby szybciej wznowic duza sesje."
                            },
                            resume_full_session: {
                                title: "Wznow pelna sesje",
                                subtitle: "Zaladuj pelny kontekst sesji, gdy Claude zaoferuje wybor."
                            }
                        }
                    },
                    claudeUnifiedTerminalWorkspaceTrust: {
                        title: "Zaufanie obszaru roboczego",
                        subtitle: "Wybierz sposób, w jaki Happier ma odpowiedzieć, gdy Claude pyta, czy ufać obszarowi roboczemu.",
                        options: {
                            ask_every_time: {
                                title: "Zapytaj za każdym razem",
                                subtitle: "Pokaż dokładne pytanie dotyczące zaufania obszaru roboczego w sesji."
                            },
                            always_trust_happier_workspaces: {
                                title: "Zawsze ufaj obszarom roboczym Happier.",
                                subtitle: "Zaufaj aktualnie odzyskanemu monitowi Claude dotyczącemu obszarów roboczych otwartych przez Happier."
                            },
                            always_reject_happier_workspaces: {
                                title: "Zawsze odrzucaj Happier obszarów roboczych",
                                subtitle: "Odrzuć aktualnie przechwycony monit Claude dotyczący obszarów roboczych otwartych przez Happier."
                            }
                        }
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Użyj Agent SDK (zdalnie)",
                        subtitle: "Używa oficjalnego @anthropic-ai/claude-agent-sdk w trybie zdalnym."
                    },
                    claudeRemoteDebugEnabled: {
                        title: "Tryb debug",
                        subtitle: "Włącza logi debug Claude Code (odpowiednik --debug)."
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "Szczegółowo",
                        subtitle: "Włącza szczegółowe logowanie (odpowiednik --verbose)."
                    },
                    claudeRemoteDebugCategories: {
                        title: "Kategorie debug",
                        subtitle: "Opcjonalny filtr kategorii. Gdy pusty, Claude loguje wszystkie kategorie debug.",
                        options: {
                            api: {
                                title: "API",
                                subtitle: "Żądania i odpowiedzi HTTP/API."
                            },
                            mcp: {
                                title: "MCP",
                                subtitle: "Połączenia serwerów MCP i ruch narzędzi."
                            },
                            hooks: {
                                title: "Hooks",
                                subtitle: "Cykl życia hooków i uruchamianie poleceń."
                            },
                            file: {
                                title: "Pliki",
                                subtitle: "Operacje systemu plików i helpery plików."
                            },
                            '1p': {
                                title: "1p",
                                subtitle: "Wewnętrzna kategoria first-party."
                            }
                        }
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
                        footer: "Pozostaw puste, aby użyć zarządzanego przez Happier cyklu życia serwera OpenCode. Ustaw bezwzględny adres HTTPS dla dowolnego serwera, który prowadzisz samodzielnie, albo HTTP tylko dla localhost. Hasło wpisz w polu poniżej, nigdy w adresie URL."
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
                        subtitle: "Opcjonalne nadpisanie dla serwera prowadzonego przez Ciebie. HTTPS może używać dowolnego hosta; HTTP jest ograniczone do localhost."
                    },
                    opencodeServerPassword: {
                        title: "Hasło istniejącego serwera OpenCode",
                        subtitle: "Ustaw tylko jeśli Twój serwer OpenCode działa z OPENCODE_SERVER_PASSWORD. Przechowywane w postaci zaszyfrowanej na tym urządzeniu i nigdy nie synchronizowane."
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
                title: "Kimi",
                sections: {
                    compatibility: {
                        title: 'Zgodność',
                        footer: 'Używaj trybu zgodności tylko w środowiskach Linux/kontenerowych, w których uruchamianie Kimi ACP się zawiesza.'
                    }
                },
                fields: {
                    kimiAcpPythonSelector: {
                        title: 'Selektor stdio Pythona',
                        subtitle: 'Wybierz, jak Happier uruchamia pętlę stdio Pythona dla Kimi ACP.',
                        options: {
                            auto: {
                                title: 'Automatycznie',
                                subtitle: 'Użyj domyślnego selektora Pythona Kimi.'
                            },
                            poll: {
                                title: 'Tryb zgodności',
                                subtitle: 'Użyj poll() zamiast epoll() dla stdio Kimi ACP.'
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
                        title: "Środowisko uruchomieniowe",
                        footer: "Wybierz, jak startują sesje Antigravity. Tryb CLI używa logowania subskrypcyjnego z ograniczonym sterowaniem na żywo; tryb SDK używa Gemini API albo danych Vertex."
                    }
                },
                fields: {
                    antigravityRuntimeMode: {
                        title: "Tryb uruchomieniowy",
                        subtitle: "Wybierz automatyczne routowanie, tryb print CLI z subskrypcją albo tryb SDK.",
                        options: {
                            auto: {
                                title: "Automatycznie",
                                subtitle: "Preferuj CLI subskrypcyjne, gdy jest dostępne, potem dane SDK."
                            },
                            cliPrint: {
                                title: "Antigravity CLI (subskrypcja)",
                                subtitle: "Używa trybu print agy z lokalnym logowaniem; zatwierdzanie narzędzi na żywo jest ograniczone."
                            },
                            sdk: {
                                title: "SDK Antigravity (Gemini API / Vertex)",
                                subtitle: "Używa klucza Gemini API albo danych Vertex przez SDK."
                            }
                        }
                    }
                }
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

  workspaceCockpit: {
    sessionPosition: ({ position, total }: { position: number; total: number }) => position + ' z ' + total,
    previousSession: 'Poprzednia sesja',
    nextSession: 'Następna sesja',
    switchedToSession: ({ name, position, total }: { name: string; position: number; total: number }) => 'Przełączono na ' + name + ', ' + position + ' z ' + total,
    openCockpit: 'Otwórz kokpit',
    openClassicView: 'Otwórz widok klasyczny',
    tabs: 'Karty',
  },

  settingsAppearance: {
    tabBarAppearance: {
      title: 'Pasek kart',
      footer: 'Dostosuj dolny pasek kart.',
      showLabels: 'Pokaż etykiety kart',
      size: 'Rozmiar paska kart',
      sizeCompact: 'Kompaktowy',
      sizeRegular: 'Normalny',
      sizeLarge: 'Duży',
    },
    glass: {
      title: 'Powierzchnie szklane',
      footer: 'Użyj półprzezroczystego materiału rozmycia dla pływających szklanych powierzchni — paska kart, przycisku przejścia na dół i innych.',
      enable: 'Rozmycie szkła',
      intensity: 'Intensywność rozmycia',
      intensityLight: 'Lekka',
      intensityRegular: 'Normalna',
      intensityStrong: 'Mocna',
      composer: 'Szklany edytor',
      composerHint: 'Dopasuj do paska kart — użyj jego koloru powierzchni i rzuć cień na edytor wiadomości.',
    },
    tabBarBadges: {
      title: 'Odznaki paska kart',
      footer: 'Wybierz, które odznaki pojawiają się na dolnym pasku kart.',
      gitTitle: 'Odznaka karty Git',
      gitChangedFiles: 'Zmienione pliki',
      gitDiffLines: 'Dodane i usunięte wiersze',
      gitOff: 'Wyłączone',
    },
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
    contentWidth: "Szerokość treści",
    contentWidthDescription:
      "Wybierz, jak szeroko może rozciągać się główna treść",
    contentWidthOptions: {
      compact: "Kompaktowa",
      compactDescription: "Ogranicz główną treść do 850 px",
      medium: "Średnia",
      mediumDescription: "Pozwól głównej treści osiągać 960 px",
      full: "Pełna szerokość",
      fullDescription: "Użyj dostępnej szerokości okna",
    },
    backdropBlur: "Rozmycie tła",
    backdropBlurDescription:
      "Używaj rozmycia tła za modalami i menu. Wyłącz, aby poprawić wydajność przeglądarki.",
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
      meshGradient: "Gradient siatkowy",
      meshGradientOrganic: "Gradient siatkowy: organiczny",
      meshGradientRows: "Gradient siatkowy: rzędy",
      meshGradientColumns: "Gradient siatkowy: kolumny",
      meshGradientDiagonal: "Gradient siatkowy: przekątna",
      meshGradientOval: "Gradient siatkowy: owal",
      meshGradientWaves: "Gradient siatkowy: fale",
      meshGradientSoftNoise: "Gradient siatkowy: miękki szum",
      photoGradient: "Gradient warstwowy",
      photoGradientRows: "Gradient warstwowy: rzędy",
      photoGradientColumns: "Gradient warstwowy: kolumny",
      photoGradientDiagonal: "Gradient warstwowy: przekątna",
      photoGradientWaves: "Gradient warstwowy: fale",
      photoGradientOval: "Gradient warstwowy: owal",
      photoGradientValueNoise: "Gradient warstwowy: miękki szum",
      photoGradientVoronoi: "Gradient warstwowy: komórki",
      photoGradientMeshGrid: "Gradient warstwowy: siatka",
    },
    showFlavorIcons: "Pokaż ikony dostawcy AI",
    showFlavorIconsDescription:
      "Wyświetlaj ikony dostawcy AI na awatarach sesji",
    compactSessionView: "Kompaktowy widok sesji",
    compactSessionViewDescription:
      "Pokazuj aktywne sesje w bardziej zwartym układzie",
    compactSessionViewMinimal: "Minimalny widok kompaktowy",
    compactSessionViewMinimalDescription:
      "Użyj najwęższego układu wiersza sesji",
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

    settingsNavSidebar: "Pasek boczny ustawień",
    settingsNavSidebarDescription:
      "Pokaż pasek boczny nawigacji ustawień (web/tablet)",},

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
      expMarkdownRichEditor: 'Edytor Markdown z formatowaniem',
      expMarkdownRichEditorSubtitle:
        'Włącz edytor Markdown z formatowaniem (WYSIWYG) w edytorze plików, z awaryjnym trybem surowym w razie potrzeby',
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
      expVoiceDaemonInference: 'Wnioskowanie głosowe demona',
      expVoiceDaemonInferenceSubtitle: 'Włącz sterowanie lokalnym wnioskowaniem głosowym przez demona',
      expLiveActivities: 'Live Activities',
      expLiveActivitiesSubtitle: 'Włącz powierzchnie Live Activities dla postępu sesji',
      expHomeScreenWidgets: 'Widżety ekranu głównego',
      expHomeScreenWidgetsSubtitle: 'Włącz widżety ekranu głównego dla aktywności Happier',
      expConnectedServicesQuotas: "Limity połączonych usług",
      expConnectedServicesQuotasSubtitle:
        "Pokaż odznaki limitów i wskaźniki użycia dla połączonych usług",
      expMemorySearch: "Wyszukiwanie pamięci",
      expMemorySearchSubtitle:
        "Włącz ekrany i ustawienia lokalnego wyszukiwania pamięci",
    expSessionsDirect: "Sesje zewnętrzne",
    expSessionsDirectSubtitle: "Odkrywaj i łącz istniejące sesje agentów na pasku bocznym",
    expSessionsFolders: "Foldery sesji",
    expSessionsFoldersSubtitle: "Porządkuj sesje Happier z paska bocznego w folderach obszaru roboczego",
    expPetsCompanion: "Zwierzaki",
    expPetsCompanionSubtitle: "Włącz powierzchnie towarzysza Blink i lokalny wybór zwierzaków",
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
      historyScopePerSession: "Przewijaj historię na sesję",
      historyScopeGlobal: "Przewijaj historię we wszystkich sesjach",
      historyScopeModalTitle: "Historia wiadomości",
      historyScopeModalMessage:
        "Wybierz, czy Strzałka w górę/Strzałka w dół przewija tylko wiadomości wysłane w tej sesji, czy we wszystkich sesjach.",
      historyScopePerSessionOption: "Na sesję",
      historyScopeGlobalOption: "Globalnie",
      commandPalette: "Paleta poleceń",
      commandPaletteEnabled: "Użyj skrótu, aby otworzyć",
      commandPaletteDisabled: "Szybki dostęp do poleceń wyłączony",
      hideInactiveSessions: "Ukryj nieaktywne sesje",
      hideInactiveSessionsSubtitle: "Wyświetlaj tylko aktywne czaty na liście",
      hiddenInactiveSessionsEmptyStateTitle: "Brak aktywnych sesji w tej chwili",
      hiddenInactiveSessionsEmptyStateSubtitle: "Nieaktywne sesje są ukryte na tej liście",
      hiddenInactiveSessionsSectionTitle: "Nieaktywne sesje",
      hiddenInactiveSessionsSectionSubtitle: "Ukryte na głównej liście, ponieważ są tam pokazywane tylko aktywne czaty",
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
      signupDisabled: "Ten serwer ma wyłączone zakładanie nowych kont. Zaloguj się na istniejące konto lub poproś administratora serwera o włączenie rejestracji.",
      failedToForkSession: "Nie udało się utworzyć gałęzi sesji",
      daemonUnavailableTitle: "Demon niedostępny",
      daemonUnavailableBody:
        "Happier nie może połączyć się z demonem na tej maszynie. Może być offline, w trakcie uruchamiania lub odłączony od serwera.",
      tryAgain: "Spróbuj ponownie",
      contactSupport:
        "Skontaktuj się z pomocą techniczną, jeśli problem będzie się powtarzał",
      sessionNotFound: "Sesja nie została znaleziona",
      voiceSessionFailed: "Nie udało się uruchomić sesji głosowej",
      dictationFailed: "Dyktowanie nie powiodło się",
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

    sourceControlUnavailableForSession: "Kontrola wersji jest niedostępna dla tej sesji.",},

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
      githubCli: {
        title: "CLI GitHuba",
      },

      gh: {
        title: "GitHub Interfejs wiersza polecenia",
      },},
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
		      pendingWorktreeSubtitle: ({ branch, path }: { branch: string; path: string }) => `Z ${branch} · ${path}`,
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
      "Nie udało się uruchomić sesji. Spróbuj ponownie lub sprawdź wybraną maszynę i ustawienia sesji.",
    actionMethodUnavailable: "Zaktualizuj Happier na docelowej maszynie, aby utworzyć nową sesję.",
    sessionTimeout:
      "Przekroczono czas uruchamiania sesji. Maszyna może działać wolno lub daemon może nie odpowiadać.",
    notConnectedToServer:
      "Brak połączenia z serwerem. Sprawdź połączenie internetowe.",
    daemonRpcUnavailableTitle: "Demon niedostępny",
    daemonRpcUnavailableBody:
      "Happier nie może połączyć się z demonem na tej maszynie. Może być offline, w trakcie uruchamiania lub odłączony od serwera.",
    launchStillPendingTitle: "Uruchamianie nadal trwa",
    launchStillPendingBody:
      "Happier nie potwierdził jeszcze nowej sesji. Żądanie uruchomienia jest nadal zapisane. Spróbuj ponownie, aby kontynuować to samo uruchomienie bez tworzenia duplikatu sesji.",
    connectedServiceSwitchUnavailable: {
      startFreshAction: "Zacznij od nowa na nowym koncie",
    },
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
      inThisFolderTitle: "W tym folderze",
      openInTreeBrowserLabel: "Otwórz w przeglądarce drzewa",
      openFolderLabel: "Pokaż zawartość folderu",
      emptyInThisFolder: "Brak dopasowań w tym folderze",
      favoriteAdd: "Dodaj do ulubionych",
      favoriteRemove: "Usuń z ulubionych",
      hints: {
        navigate: "nawiguj",
        commit: "zatwierdź ścieżkę",
        autocomplete: "autouzupełnianie",
        walkUp: "poziom wyżej",
      },
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
      createTitle: "Nowy worktree z gałęzi",
      backToRoot: "Drzewa robocze",
      searchPlaceholder: "Szukaj worktrees",
      searchBranchPlaceholder: "Szukaj gałęzi",
      sections: {
        localBranches: "GAŁĘZIE LOKALNE",
        remoteBranches: "GAŁĘZIE ZDALNE",
      },
      statusPill: {
        clean: "czysty",
        idle: "nieaktywny",
        // FR4-10: StatusPill renders the count separately; suffix-only.
        changesSuffix: ({ count }: { count: number }) =>
          plural({ count, one: "zmiana", few: "zmiany", many: "zmian" }),
      },
      branchRow: {
        reuseLabel: "Ma worktree",
        reuseSubtitle: ({ path }: { path: string }) => path,
      },
      nameStep: {
        title: "Nazwij swój worktree",
        backLabel: "Gałęzie",
        placeholder: "Nazwij ten worktree",
        emptyHint: "To będzie nazwa nowej gałęzi i worktree.",
        suggestedSectionTitle: "Sugerowane",
        suggestedSubtitle: "Użyj wygenerowanej nazwy",
        useSuggested: ({ name }: { name: string }) => `Użyj sugerowanej nazwy: ${name}`,
        createNamed: ({ name }: { name: string }) => `Utwórz worktree: ${name}`,
        customHint: "Albo wpisz nazwę powyżej, aby utworzyć własny worktree",
        hints: {
          create: "utwórz",
          back: "wstecz",
        },
      },
      reuseOrCreate: {
        title: "Gałąź ma już worktree",
        useExisting: "Użyj istniejącego worktree",
        createNew: "Utwórz nowy worktree z tej gałęzi",
        createNewSubtitle: "Odgałęź do nowego nazwanego worktree",
      },
      hints: {
        navigate: "nawiguj",
        select: "wybierz",
        back: "wstecz",
      },
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
        githubCliBanner: {
            title: 'GitHub Interfejs wiersza polecenia',
            install: 'Zainstaluj',
            update: 'Zaktualizuj',
            reinstall: 'Zainstaluj ponownie',
        },
    githubCliInstallModal: {
      installTitle: "Zainstalować GitHub CLI?",
      updateTitle: "Zaktualizować GitHub CLI?",
      reinstallTitle: "Zainstalować ponownie GitHub CLI?",
      description:
        "Instaluje GitHub CLI, aby Happier mógł używać lokalnego uwierzytelnienia GitHub w przepływach pull request.",
    },

    ghCliBanner: {
      title: "GitHub Interfejs wiersza polecenia",
      install: "Zainstaluj",
      update: "Zaktualizuj",
      reinstall: "Zainstaluj ponownie",
    },
    ghCliInstallModal: {
      installTitle: "Zainstalować GitHub CLI?",
      updateTitle: "Zaktualizować GitHub CLI?",
      reinstallTitle: "Zainstalować ponownie GitHub CLI?",
      description:
        "To instaluje opcjonalną zależność GitHub CLI używaną przez przepływy kontroli źródeł GitHub po potwierdzeniu.",
    },},

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
    providerBinding: providerSessionTranslations.pl,
    transcriptNavigation: {
      title: "Nawiguj",
      modeAll: "Wszystkie",
      modePinned: "Przypięte",
      entryCount: ({ count }: { count: number }) => `${count} ${count === 1 ? "pozycja" : "pozycji"}`,
      pinnedCount: ({ count }: { count: number }) => `${count} przypięte`,
      emptyPinnedTitle: "Brak przypiętych wiadomości",
      emptyPinnedBody: "Przypnij wiadomości, aby zachować tutaj ważne tury.",
      emptyAllTitle: "Brak pozycji nawigacji",
      emptyAllBody: "Tury użytkownika i przypięte wiadomości pojawią się tutaj.",
      entryA11y: ({ label }: { label: string }) => `Przejdź do ${label}`,
      entryPinnedA11y: ({ label }: { label: string }) => `Przejdź do przypiętej wiadomości: ${label}`,
      fallbackPinnedAssistant: "Przypięta wiadomość asystenta",
      fallbackPinnedTool: "Przypięta wiadomość narzędzia",
      fallbackPinnedMessage: "Przypięta wiadomość",
      pinMessageA11y: "Przypnij wiadomość",
      unpinMessageA11y: "Odepnij wiadomość",
      pinToolCallA11y: "Przypnij wywołanie narzędzia",
      unpinToolCallA11y: "Odepnij wywołanie narzędzia",
      jumpFailed: "Nie udało się przejść do tej wiadomości.",
      replyNotLoaded: "Odpowiedź nie została wczytana",
      awaitingReply: "Oczekiwanie na odpowiedź",
      loadingBody: "Wczytywanie nawigacji transkrypcji…",
      railScrollUpA11y: "Przewiń nawigację w górę",
      railScrollDownA11y: "Przewiń nawigację w dół",
      emptyPinnedHint: "Najedź kursorem na wiadomość i wybierz ikonę pinezki, aby ją przypiąć.",
      emptyPinnedPrivacy: "Przypięte wiadomości są zapisywane tylko na tym urządzeniu.",
    },

    inputPlaceholder: "Wpisz wiadomość...",
    workState: {
      accessibilityLabel: "Stan pracy sesji",
      commandDescription: "Ustaw lub sprawdź cel sesji",
      unsupportedTitle: "Cel niedostępny",
      unsupportedMessage:
        "Ten backend nie obsługuje jeszcze edytowalnych celów sesji.",
      notReadyTitle: "Elementy sterujące celem nie są jeszcze gotowe",
      notReadyMessage:
        "Ta sesja wciąż się uruchamia. Spróbuj ustawić cel ponownie za chwilę.",
      noCurrentGoalTitle: "Brak celu do zaktualizowania",
      noCurrentGoalMessage:
        "Ustaw cel, zanim go wstrzymasz lub wznowisz.",
      dirtyCloseTitle: "Odrzucić zmiany celu?",
      dirtyCloseBody: "Niezapisane zmiany celu zostaną utracone.",
      emptyPlaceholder: "Jeszcze nic tu nie ma",
      badge: {
        goal: ({ title }: { title: string }) => `Cel: ${title}`,
        goalPaused: "Cel wstrzymany",
        goalBlocked: "Cel zablokowany",
        goalBudgetLimited: "Cel ograniczony budżetem",
        goalComplete: "Cel ukończony",
        item: ({ title }: { title: string }) => title,
      },
      group: {
        active: "Aktywne",
        pending: "Oczekujące",
        blockedPaused: "Zablokowane lub wstrzymane",
        done: "Ukończone lub anulowane",
      },
      workflow: {
          sectionTitle: "Aktywne przepływy pracy",
          goalActive: "Cel aktywny",
          goalLabel: ({ title }: { title: string }) => `Cel: ${title}`,
          bare: "Przepływ pracy",
          agentsFallback: ({ fraction }: { fraction: string }) => `Przepływ pracy ${fraction} agentów`,
          olderRunsHidden: ({ count }: { count: number }) => `${count} starszych uruchomień ukrytych`,
          phaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
          plural: ({ count }: { count: number }) => `${count} przepływy pracy`,
          pluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} przepływy pracy · ${agents} agentów`,
          join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
          permissionBlocked: "Wymaga przeglądu",
      },
      goal: {
        title: "Cel",
        placeholder: "Na czym ta sesja powinna się skupić?",
        set: "Ustaw cel",
        pause: "Wstrzymaj",
        resume: "Wznów",
        clear: "Wyczyść",
        clearTitle: "Wyczyścić cel?",
        clearBody: "Usuwa edytowalny cel z tej sesji.",
        statusActive: "Aktywne",
        statusPaused: "Wstrzymane",
        statusComplete: "Ukończone",
        statusBudgetLimited: "Ograniczone budżetem",
        statusInterrupted: "Przerwano",
        setTitle: "Ustaw cel",
        setSubtitle: "Nadaj sesji cel, aby agent trzymał się tematu.",
        addBudget: "+ Dodaj limit budżetu (opcjonalnie)",
        removeBudget: "Usuń budżet",
        noUsageYet: "Brak zużycia",
        tokenBudget: "Budżet tokenów",
        tokensSuffix: ({ count }: { count: string }) => `${count} tokenów`,
        budgetProgress: ({ used, budget }: { used: string; budget: string }) => `${used} / ${budget}`,
        budgetCaption: ({ budget }: { budget: string }) => `z budżetu ${budget}`,
        budgetPlaceholder: "Limit tokenów",
        invalidBudget: "Wpisz dodatni budżet tokenów.",
        pending: "Ustawianie celu…",
        stillWaiting: "Wciąż czekam na potwierdzenie…",
        accessibilityCurrent: ({ objective }: { objective: string }) => `Bieżący cel: ${objective}`,
        errorUnsupportedResponse: "Nieobsługiwana odpowiedź z RPC sesji",
        errorUnknown: "Nieznany błąd",
        errorCannotResume: "Nie można wznowić sesji, aby zaktualizować natywny cel",
      },
    },
    usageLimitRecovery: {
      banner: {
        title: "Osiągnięto limit użycia",
        body: "Happier może poczekać na reset limitu i automatycznie wznowić tę sesję.",
        waitingTitle: "Oczekiwanie na reset limitu użycia",
        waitingBody: "Happier sprawdzi ponownie, gdy dostawca powinien przyjmować żądania.",
        readyTitle: "Limit użycia został zresetowany",
        readyBody: "Możesz teraz wznowić tę sesję.",
        resetCreditSummary: ({ count, expiresAt }: { count: number; expiresAt: string | null }) => {
          const label = count === 1 ? "1 reset użycia" : `${count} resetów użycia`;
          return expiresAt ? `${label} dostępny. Najwcześniej wygasa ${expiresAt}.` : `${label} dostępny.`;
        },
      },
      actions: {
        enable: "Wznów po zresetowaniu limitu",
        cancel: "Anuluj oczekiwanie",
        checkNow: "Sprawdź limit teraz",
        resumeNow: "Wznów teraz",
        switchFallbackNow: "Przełącz na konto zapasowe",
        switchAccountNow: "Przełącz konto teraz",
        consumeResetCredit: "Zastosuj reset użycia",
        retryTemporaryThrottle: "Ponów teraz",
        remember: "Zawsze czekaj i wznawiaj",
        forget: "Pytaj za każdym razem",
        hideBanner: "Ukryj baner limitu użycia",
        showBanner: "Pokaż baner limitu użycia",
      },
      status: {
        ready: "Limit użycia",
        resumeReady: "Gotowe do wznowienia",
        checking: "Sprawdzanie limitu",
        waiting: "Oczekiwanie na reset",
        waitingForQuotaReset: "Oczekiwanie na reset limitu",
        accountRotationPending: "Oczekuje rotacja konta",
        temporaryThrottle: "Tymczasowe ograniczenie",
      },
    },
    composerBanners: {
        showBannerAction: 'Pokaż baner',
        hideBannerAction: 'Ukryj baner',
    },
    staleRunner: {
      banner: {
        title: "Runner sesji jest nieaktualny",
        body: "Ta sesja nadal działa na starszym kodzie środowiska uruchomieniowego. Uruchom runner ponownie, aby użyć bieżącego runtime daemona.",
        pendingBody: "Ponowne uruchamianie runnera sesji na bieżącym runtime daemona.",
        busyBody: "Runner jest teraz zajęty. Spróbuj ponownie po zakończeniu bieżącej pracy.",
        failedBody: "Nie udało się ponownie uruchomić runnera. Sesja nadal jest dostępna na obecnym runnerze.",
        unavailableBody: "Ponowne uruchomienie jest niedostępne dla tej sesji. Sesja może nadal działać na obecnym runnerze.",
      },
      actions: {
        restart: "Uruchom runner ponownie",
        restarting: "Uruchamianie...",
        hideBanner: "Ukryj baner starego runnera",
        showBanner: "Pokaż baner starego runnera",
      },
      status: {
        stale: "Aktualizacja runnera",
        restarting: "Restart runnera",
        busy: "Runner zajęty",
        failed: "Restart runnera nieudany",
      },
    },
    rightPanel: {
      tabs: {
        git: "Git",
      },
    },
    toolCalls: "Wywołania narzędzi",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} więcej…`,
    agentContinuation: {
      currentAgentAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Prowadzi tę sesję.`,
      currentAgentLastUsedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Ostatnio używany przez tę sesję.`,
      currentAgentLastReportedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Ostatnio zgłoszony dla tej sesji.`,
      armedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}. Wybrany do następnej wiadomości.`,
      detailTitle: ({ agent }: { agent: string }) => `Kontynuuj z ${agent}`,
      sendLabel: ({ agent }: { agent: string }) => `Kontynuuj z ${agent}`,
      detailDescription: 'Ostatnia część rozmowy zostaje zachowana jako tekst; obrazy i pliki nie. Nic nie zostanie wysłane do następnej wiadomości.',
      detailDescriptionEmpty: 'Nie ma jeszcze rozmowy do zachowania. Nic nie zostanie wysłane do następnej wiadomości.',
      announcement: ({ agent }: { agent: string }) => `Wybrano ${agent} do następnej wiadomości. Nic nie zostało wysłane.`,
      dividerTitle: ({ from: from_, to }: { from: string; to: string }) => `Ta sesja została przejęta z ${from_} na ${to}`,
      handedOver: {
          open: "Pokaż kontekst przekazany w tym miejscu",
          title: "Przekazany kontekst",
          reconstructed: "Odtworzone teraz z transkrypcji tej sesji, a nie zapisane w tamtym momencie — może więc różnić się od tego, co zostało wysłane. Tego, co śledził poprzedni Agent, ani jego własnego dziennika nie da się odtworzyć, więc zostały pominięte.",
          loading: "Odtwarzanie…",
          empty: "Nic nie zostało przekazane. Nie było wcześniejszej rozmowy do odtworzenia.",
          unavailableOperation: "Zaktualizuj lub połącz ponownie CLI na tej maszynie, aby to odtworzyć.",
          notRebuildable: "Kontekst został tutaj przekazany, ale transkrypcja tej sesji już go nie zawiera, więc nie da się go odtworzyć.",
          unavailableSource: "Happier nie mógł odczytać transkrypcji tej sesji, więc nie da się tego odtworzyć.",
          unreachable: "Happier nie mógł połączyć się z maszyną hostującą tę sesję.",
          retryAction: "Spróbuj ponownie",
          jumpAction: "Przejdź do ostatniej uwzględnionej wiadomości",
      },
      checking: "Sprawdzanie dostępności…",
      unavailable: {
        unsupportedSession: ({ agent }: { agent: string }) => `Tej sesji nie można kontynuować z ${agent}.`,
        updateCli: "Zaktualizuj CLI na tej maszynie, aby zmienić agenta.",
        updateOrReconnect: "Zaktualizuj lub połącz ponownie CLI, aby zmienić agenta.",
        targetNoSessions: ({ agent }: { agent: string }) => `${agent} nie może prowadzić sesji.`,
        targetNotProven: ({ agent }: { agent: string }) => `Zmiana na ${agent} nie jest jeszcze obsługiwana.`,
        targetUnavailable: ({ agent }: { agent: string }) => `${agent} nie jest dostępny na tej maszynie.`,
      },
      transition: {
        rejected: {
          unsupportedOperation: 'Ta sesja nie obsługuje zmiany agenta. Nic nie zostało wysłane.',
          forbidden: 'Nie masz uprawnień, aby zmienić agenta tej sesji. Nic nie zostało wysłane.',
          sameTarget: ({ agent }: { agent: string }) => `Ta sesja już działa na ${agent}. Nic nie zostało wysłane.`,
          staleSelection: 'Sesja zmieniła się w trakcie wyboru. Nic nie zostało wysłane — spróbuj ponownie.',
          targetUnavailable: ({ agent }: { agent: string }) => `${agent} nie jest dostępny na tym komputerze. Nic nie zostało wysłane.`,
          sourceNotIdle: ({ agent }: { agent: string }) => `${agent} nadal pracuje. Nic nie zostało wysłane — spróbuj ponownie po zakończeniu.`,
          sourceStopFailed: ({ agent }: { agent: string }) => `Nie udało się zatrzymać ${agent}, więc nic się nie zmieniło. Nic nie zostało wysłane.`,
        },
        conflictingDestination: ({ agent }: { agent: string }) => `Nic nie zostało wysłane. Ta wiadomość ma już inny cel, więc nie może jednocześnie przełączyć tej sesji na ${agent}. Usuń jedno z dwóch i wyślij ponownie.`,
        sourceStopped: ({ source, agent }: { source: string; agent: string }) => `${source} został zatrzymany, ale przełączenie na ${agent} nie zostało ukończone. Twoja wiadomość nie została wysłana.`,
        switched: ({ agent }: { agent: string }) => `Ta sesja to teraz ${agent}, ale Twoja wiadomość nie została wysłana. Wyślij ją ponownie.`,
        /** Compact status for the collapsed composer banner badge. */
        badgeLabel: 'Zmiana Agenta',
        /** Delegates to the Session’s existing resume owner; never a second start path. */
        resumeAction: 'Wznów sesję',
        unknown: 'Happier nie mógł potwierdzić, co się stało. Sprawdź tę sesję przed ponownym wysłaniem.',
      },
    },
    sourceContext: {
        chipLabel: ({ session }: { session: string }) => `Z ${session}`,
        unknownSession: "innej sesji",
        detailTitle: "Kontynuacja innej sesji",
        detailBodyLatest: ({ session }: { session: string }) => `Rozmowa z ${session} zostanie przeniesiona jako kontekst tej nowej sesji.`,
        detailBodyAtMessage: ({ session }: { session: string }) => `Rozmowa z ${session}, aż do wybranej wiadomości, zostanie przeniesiona jako kontekst tej nowej sesji.`,
        carriedOver: "Rozmowa zostanie przeniesiona",
        removeAction: "Usuń",
        removeA11y: "Usuń rozmowę źródłową",
        keepAction: "Zostaw",
        serverMismatch: "Ta rozmowa znajduje się na innym serwerze Happier. Wróć do niego albo usuń rozmowę źródłową, aby zacząć od nowa.",
    },
    forking: {
      dividerTitle: "Rozgałęziono z wcześniejszego kontekstu",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `Rozgałęziono z ${parent}`,
      dividerSubtitle: "Starszy kontekst (tylko do odczytu)",
      openParent: "Otwórz",
      openParentA11y: "Otwórz sesję nadrzędną",
      forkFromMessageA11y: "Utwórz gałąź z tego komunikatu",
      strategy: {
          title: "Utwórz gałąź tej sesji",
          subtitleLatest: "Rozgałęź od miejsca, w którym jest teraz ta rozmowa.",
          subtitleFromMessage: "Rozgałęź od tego miejsca w rozmowie.",
          recommended: "Zalecane",
          native: {
              title: "Gałąź natywna",
              subtitle: "Agent rozgałęzia własną rozmowę. Najbliżej oryginału.",
          },
          replay: {
              title: "Gałąź przez Replay",
              subtitle: "Happier odtwarza dotychczasową rozmowę jako kontekst nowej sesji.",
          },
          configure: {
              title: "Skonfiguruj nową sesję",
              subtitle: "Wybierz innego agenta, model, maszynę lub folder i zabierz tę rozmowę ze sobą.",
          },
          unavailable: {
              nativeAgent: "Ten agent nie może rozgałęzić własnej rozmowy.",
              nativeFromMessage: "Ten agent może rozgałęzić całą rozmowę, ale nie od wcześniejszej wiadomości.",
              nativeProviderBound: "Agent nie może rozgałęzić sesji powiązanej z kontem dostawcy.",
              replayOff: "Replay jest wyłączony w Ustawieniach.",
              replaySettingsAction: "Ustawienia Replay",
          },
          progress: {
              creatingNative: "Tworzenie gałęzi natywnej…",
              creatingReplay: "Tworzenie gałęzi Replay…",
              opening: "Otwieranie gałęzi…",
              stalledTitle: "Gałąź została utworzona",
              stalledBody: "Jeszcze się tu nie pojawiła. Spróbuj otworzyć ją ponownie.",
              openAction: "Otwórz gałąź",
          },
          unknown: {
              title: "Happier nie potwierdził utworzenia gałęzi",
              body: "Żądanie zostało wysłane, więc gałąź może już istnieć. Sprawdź to zamiast tworzyć ją ponownie, bo druga próba może utworzyć duplikat.",
              checkAction: "Sprawdź gałąź",
              checking: "Szukanie gałęzi…",
              noneFound: "Nie ma jeszcze pasującej gałęzi. Może się nadal uruchamiać, więc możesz sprawdzić ponownie.",
              ambiguous: "Pojawiła się więcej niż jedna pasująca gałąź. Otwórz listę sesji, aby wybrać właściwą.",
          },
          failure: {
              updateRequired: "Zaktualizuj lub połącz ponownie CLI na tej maszynie, aby rozgałęzić tę sesję.",
              generic: "Happier nie mógł utworzyć gałęzi.",
          },
      },
	    },
	    transcriptGap: {
	      earlierMessages: "Wcześniejsze wiadomości",
	      laterMessages: "Późniejsze wiadomości",
	    },
	    rollback: {
	      latestTurnA11y: 'Cofnij ostatnia ture',
	      beforeUserMessageA11y: 'Cofnij do chwili przed ta wiadomoscia',

	      checkpointCode: {
	        title: 'Opcje cofania',
	        conversationUnavailable: 'Cofanie rozmowy nie jest dostepne dla tej sesji.',
	        codeOnlyConfirmation: 'Rozumiem, ze rozmowa pozostanie bez zmian.',
	        showAdvanced: 'Pokaz zaawansowane opcje tylko kodu',
	        choices: {
	          conversation_only: {
	            title: 'Tylko rozmowa',
	            description: 'Cofa transkrypcje bez zmiany plikow.',
	          },
	          conversation_and_code_with_stash: {
	            title: 'Rozmowa i kod, z Git stash',
	            description: 'Tworzy checkpoint Happier, zapisuje zmiany w stash i stosuje odwrotny patch.',
	          },
	          conversation_and_code_without_stash: {
	            title: 'Rozmowa i kod, bez Git stash',
	            description: 'Tworzy checkpoint Happier i stosuje odwrotny patch w tym worktree.',
	          },
	          code_only_with_stash: {
	            title: 'Tylko kod, z Git stash',
	            description: 'Zaawansowane: zostawia transkrypcje bez zmian i cofa pliki po stash.',
	          },
	          code_only_without_stash: {
	            title: 'Tylko kod, bez Git stash',
	            description: 'Zaawansowane: zostawia transkrypcje bez zmian i cofa pliki tylko z checkpointem Happier.',
	          },
	        },
	      },},
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

          backgroundFollow: "Śledzenie w tle",},
      detailsPanel: {
        emptyHint: "Otwórz plik lub diff z prawego panelu.",
        unsupportedTab: "Nieobsługiwana karta szczegółów.",
        closeA11y: "Zamknij szczegóły",
          openRightSidebarA11y: "Otwórz prawy pasek boczny",
          closeRightSidebarA11y: "Zamknij prawy pasek boczny",
          openTabA11y: ({ title }: { title: string }) => `Otwórz kartę ${title}`,
          pinTabA11y: "Przypnij kartę",
          unpinTabA11y: "Odepnij kartę",
          pinnedTabA11y: "Przypięta karta",
          closeTabA11y: "Zamknij kartę",
          enterFocusModeA11y: "Włącz tryb skupienia panelu",
          exitFocusModeA11y: "Wyłącz tryb skupienia panelu",

        emptyTitle: "Brak otwartych kart",},

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
        deliveryStatus: {
          blocked: 'Zablokowano',
          delivering: 'Dostarczanie',
          queuedInClaude: 'W kolejce w Claude',
        },
        queuedReasons: {
          waitingForForegroundTurn: 'Oczekiwanie na zakończenie bieżącej tury',
          waitingForRuntimeActivity: 'Oczekiwanie na zakończenie aktywności środowiska',
          runtimeActivityUnknown: 'Oczekiwanie na stan aktywności środowiska',
          waitingForPredecessor: 'Oczekiwanie na wcześniejszą wiadomość',
          waitingForRuntime: 'Oczekiwanie na środowisko sesji',
          unsupportedAction: 'Akcja dostarczenia wymaga sprawdzenia',
        },
        deliveryBlockedReasons: {
          terminalComposerDraft: 'Szkic terminala blokuje dostarczenie',
          captureStyleUnavailable: 'Przechwytywanie terminala nie może zweryfikować edytora',
          providerUnavailableBeforeAcceptance: 'Dostawca jest tymczasowo niedostępny',
          ambiguousTerminalDelivery: 'Stan dostarczenia jest niejednoznaczny',
          terminalHostUnreachable: 'Host terminala jest nieosiągalny',
          runtimeDisposedBeforeDelivery: 'Runtime zamknął się przed dostarczeniem',
          runtimeConfigBlocked: 'Konfiguracja runtime blokuje dostarczenie',
          invalidPromptText: 'Nie można dostarczyć tekstu wiadomości',
          manualUserHandled: 'Oznaczono jako obsłużone',
          attemptExpiredBeforeWrite: 'Próba dostarczenia wygasła przed zapisem',
          providerRejectedBeforeAcceptance: 'Dostawca odrzucił wiadomość',
          payloadTooLarge: 'Wiadomość jest za duża',
          unknown: 'Status dostarczenia wymaga sprawdzenia',
        },
	        empty: "Brak oczekujących wiadomości.",
	        decryptFailed: "Nie udało się odszyfrować tej oczekującej wiadomości.",
	        nonSteerableNotice: "Bieżąca tura nie może przyjąć wstawienia po tej zmianie trybu. Wiadomość uruchomi się później albo użyj Wyślij teraz, aby przerwać.",
	        steerBlockedTerminalDraftNotice: 'Oczekiwanie: szkic w polu tekstowym terminala blokuje dostarczenie. Wyczyść go w terminalu lub przerwij turę.',
        clearComposer: {
          action: 'Wyczyść pole',
          clearing: 'Czyszczenie…',
          confirmTitle: 'Wyczyścić pole tekstowe terminala?',
          confirmBody: 'Spowoduje to odrzucenie niewysłanego tekstu znajdującego się w polu tekstowym terminala.',
          errors: {
            failed: 'Nie udało się wyczyścić pola tekstowego terminala.',
            unsupported: 'Ta sesja nie obsługuje czyszczenia pola tekstowego terminala z Happier.',
            noLiveTerminal: 'Dla tej sesji nie ma dostępnego aktywnego terminala.',
            generating: 'Claude aktualnie generuje odpowiedź, więc nie można bezpiecznie wyczyścić pola tekstowego.',
            notSafe: 'Terminal pokazuje okno dialogowe albo inny niebezpieczny stan. Wyczyść go w terminalu.',
            captureUnavailable: 'Happier nie mógł odczytać stanu terminala.',
          },
        },
	        actions: {
          up: "W górę",
          down: "W dół",
          edit: "Edytuj",
            viewMore: "Pokaż więcej",
            viewLess: "Pokaż mniej",
          steerNow: "Wstaw teraz",
          sendNow: "Wyślij teraz",
          sendToAgentNow: "Wyślij teraz do agenta",
          sendNowInterrupt: "Wyślij teraz (przerwij)",
          retryDelivery: "Ponów",
          interruptAndRunNow: "Przerwij i uruchom teraz",
          markHandled: "Oznacz jako obsłużone",
          requeue: "Przywróć do kolejki",
        },
        editPrompt: {
          title: "Edytuj oczekującą wiadomość",
        },
        removeConfirm: {
          title: "Usunąć oczekującą wiadomość?",
          body: "To usunie oczekującą wiadomość.",
        },
        discardConfirm: {
          title: "Odrzucić oczekujące dostarczenie?",
          body: "Wiadomość pozostanie w transkrypcie jako odrzucona i nie zostanie wysłana do agenta.",
        },
        steerConfirm: {
          title: "Wstawić teraz?",
          body: "Doda tę wiadomość do bieżącej tury bez jej przerywania.",
        },
        sendConfirm: {
          title: "Wyślij teraz?",
          interruptTitle: "Wyślij teraz (przerwij)?",
          backgroundTitle: "Wysłać teraz do agenta?",
          body: "To przerwie bieżącą turę i wyśle tę wiadomość natychmiast.",
          backgroundBody: "Agent otrzyma tę wiadomość teraz. Praca w tle będzie kontynuowana.",
          resumeBody: "To wznowi sesję i natychmiast wyśle tę wiadomość.",
        },
        markHandledConfirm: {
          title: "Oznaczyć oczekującą wiadomość jako obsłużoną?",
          body: "To wyczyści zablokowany stan dostarczenia bez wysyłania wiadomości.",
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
          retryDeliveryFailed: "Nie udało się ponowić oczekującego dostarczenia",
          actionConflict: "Stan tej oczekującej wiadomości zmienił się podczas wykonywania działania. Sprawdź jej bieżący stan i spróbuj ponownie.",
          discardFailed: "Nie udało się odrzucić oczekującego dostarczenia",
          markHandledFailed: "Nie udało się oznaczyć oczekującego dostarczenia jako obsłużonego",
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
      stopSharingDescription: "Cofa bezpośredni dostęp tej osoby.",
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
      publicLinkDescription: "Każdy, kto ma ten link, może anonimowo wyświetlić sesję. Usuń lub wygeneruj link ponownie, aby odebrać dostęp wszystkim.",
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
        shortcutsHelpTitle: 'Skróty klawiaturowe',
        shortcutsHelpBody: ({ shortcuts }: { shortcuts: string }) => `Aktywne skróty:\n${shortcuts}`,
        shortcutsHelpEmpty: 'Na tym urządzeniu nie ma aktywnych skrótów.',
        shortcutsHelpCommandPalette: 'Otwórz paletę poleceń',
        shortcutsHelpHelp: 'Otwórz skróty klawiaturowe',
        shortcutsHelpNewSession: 'Nowa sesja',
        commands: {
            sessionsCategory: 'Sesje',
            navigationCategory: 'Nawigacja',
            recentSessionsCategory: 'Ostatnie sesje',
            runsCategory: 'Biegnie',
            voiceCategory: 'Głos',
            systemCategory: 'Systemu',
            developerCategory: 'Deweloper',
            newSessionTitle: 'Nowa sesja',
            newSessionSubtitle: 'Rozpocznij nową sesję czatu',
            viewAllSessionsTitle: 'Wyświetl wszystkie sesje',
            viewAllSessionsSubtitle: 'Przeglądaj historię czatów',
            settingsTitle: 'Ustawienia',
            settingsSubtitle: 'Skonfiguruj swoje preferencje',
            accountTitle: 'Konto',
            accountSubtitle: 'Zarządzaj swoim kontem',
            connectTerminalTitle: 'Zeskanuj kod QR, aby podłączyć terminal',
            connectTerminalSubtitle: 'Zatwierdź połączenie pokazane w terminalu',
            memorySearchTitle: 'Szukaj w pamięci',
            memorySearchSubtitle: 'Przeszukaj wcześniejsze rozmowy',
            sessionFallbackTitle: ({ id }: { id: string }) => `Session ${id}`,
            sessionFallbackSubtitle: 'Przełącz na sesję',
            sessionRequiredTitle: 'Wymagana sesja',
            sessionRequiredBody: 'Najpierw otwórz sesję, aby to polecenie mogło na nią skierować.',
            startReviewRunTitle: 'Rozpocznij przebieg przeglądu',
            startPlanRunTitle: 'Rozpocznij realizację planu',
            startDelegationRunTitle: 'Rozpocznij przebieg delegowania',
            executionRunsSubtitle: 'Egzekucja przebiega',
            openSessionRunsTitle: 'Sesja otwarta',
            runsForCurrentSessionSubtitle: 'Działa dla bieżącej sesji',
            runsAcrossMachinesSubtitle: 'Działa na maszynach',
            resetVoiceAgentTitle: 'Zresetuj agenta głosowego',
            voiceSubtitle: 'Głos',
            signOutTitle: 'Wyloguj się',
            signOutSubtitle: 'Wyloguj się ze swojego konta',
            developerMenuTitle: 'Menu programisty',
            developerMenuSubtitle: 'Uzyskaj dostęp do narzędzi programistycznych',
        },
    pets: {
      category: "Zwierzaki",
      wakeTitle: "Obudź zwierzaka",
      wakeSubtitle: "Pokaż towarzysza na tej powierzchni.",
      tuckTitle: "Schowaj zwierzaka",
      tuckSubtitle: "Ukryj towarzysza na tej powierzchni.",
      resetPositionTitle: "Resetuj pozycję zwierzaka",
      resetPositionSubtitle: "Przenieś towarzysza z powrotem w domyślne miejsce.",
      chooseTitle: "Wybierz zwierzaka",
      chooseSubtitle: "Otwórz ustawienia zwierzaków.",
      refreshCodexTitle: "Odśwież zwierzaki Codex",
      refreshCodexSubtitle: "Otwórz ustawienia i wykryj lokalne zwierzaki Codex.",
    },
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
    customInputA11y: "Niestandardowy identyfikator modelu",
    optionControlA11y: ({ name }: { name: string }) => `Opcja modelu: ${name}`,
    effectiveLabel: ({ label }: { label: string }) => `Aktywny: ${label}`,
  },

  voiceAssistant: {
    connecting: "Łączenie...",
    active: "Asystent głosowy aktywny",
    connectionError: "Błąd połączenia",
    label: "Asystent głosowy",
    tapToEnd: "Dotknij, aby zakończyć",
    startDictation: "Rozpocznij dyktowanie",
    startVoice: "Uruchom głos",
    startGlobalVoice: "Uruchom głos globalny",
    endVoice: "Zakończ głos",
    transcribing: "Transkrypcja…",
    endDictation: "Zakończ dyktowanie",
  },

  voiceSurface: {
    reviewCredentials: 'Sprawdź dane logowania',
    connectAgent: 'Połącz',
    installAgentRuntime: 'Zainstaluj',
    updateAgentRuntime: 'Uaktualnij',
    start: "Uruchom",
    stop: "Zatrzymaj",
    selectSessionToStart: "Wybierz sesje, aby uruchomic glos",
    targetSession: "Sesja docelowa",
    conversationalTranscriptUnavailable: "Transkrypcja rozmowy jest niedostępna dla tej sesji głosowej",
    orbLabel: "Glos",
    orbStartHint: "Rozpoczyna rozmowe glosowa. Przesun w gore, aby otworzyc rozmowe.",
    orbEndHint: "Konczy rozmowe glosowa. Rozpoczeta praca nad kodem dziala dalej. Przesun w gore, aby otworzyc rozmowe.",
    orbMinimiseHint: "Minimalizuje glos",
    orbExpand: "Rozwin glos",
    orbCollapse: "Zwin glos",
    delegatedWorking: "Pracuje…",
    composerStartHint: "Rozpoczyna rozmowe glosowa o tej sesji.",
    composerGlobalStartHint: "Rozpoczyna rozmowe glosowa niepowiazana z zadna sesja.",
    composerEndHint: "Konczy rozmowe glosowa. Rozpoczeta praca nad kodem jest kontynuowana.",
    noTarget: "Nie wybrano sesji",
    clearTarget: "Wyczysc cel",
    a11y: {
      teleport: "Przenieś agenta głosowego",
      toggleActivity: "Przełącz aktywność głosową",
      clearActivity: "Wyczyść aktywność głosową",
      bargeIn: "Przerwij",
      cancelTurn: "Anuluj odpowiedź",
      openConversation: "Otwórz rozmowę głosową",
      microphoneActive: "Mikrofon aktywny",
      microphoneInactive: "Mikrofon nieaktywny",
      microphoneMuted: "Mikrofon wyciszony",
      providerDataDisclosure: ({ provider }: { provider: string }) => `Jak ${provider} przetwarza dane głosowe`,

      mute: "Wycisz mikrofon",
      unmute: "Włącz mikrofon",},
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

    recordedAudio: {
      title: "QA STT dla nagranego audio",
      uriLabel: "URI nagranego audio",
      uriPlaceholder: "file:///recording.wav albo wybierz plik webowy",
      daemonPackIdLabel: "Nadpisanie ID pakietu STT daemona",
      daemonPackIdPlaceholder: "Opcjonalnie: zastosuj ustawienia QA STT daemona local_neural przed transkrypcją",
      daemonMachineIdLabel: "Nadpisanie ID maszyny daemona",
      daemonMachineIdPlaceholder: "Opcjonalnie: przygotuj cel maszyny dla ID sesji nagranego audio",
      daemonBasePathLabel: "Nadpisanie ścieżki bazowej daemona",
      daemonBasePathPlaceholder: "Opcjonalnie: przygotuj ścieżkę bazową maszyny dla STT daemona",
      chooseFile: "Wybierz nagrane audio",
      noFileSelected: "Nie wybrano nagranego audio",
      transcribe: "Transkrybuj nagrane audio",
      statusLabel: "Stan",
      noResult: "Brak wyniku transkrypcji",
    },},

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
      automaticDeletionEnabled: "Automatyczne usuwanie jest włączone",
      detailsUnavailable: "Automatyczne usuwanie jest włączone, ale ten klient nie może wyświetlić wszystkich aktywnych zasad",
      singlePolicySummary: ({ domain, policy }: { domain: string; policy: string }) => `${domain}: ${policy}`,
      relayCleanupSummary: ({ policies }: { policies: string }) => `Ten relay usuwa ${policies}.`,
      relayCleanupAfterDays: ({ domain, count }: { domain: string; count: number }) => `${domain} po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}`,
      relayCleanupInactiveSessionsAfterDays: ({ count }: { count: number }) => `nieaktywne sesje po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}`,
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `Usuwa nieaktywne sesje po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}.`,
      deleteOlderThanDays: ({ count }: { count: number }) => `Usuwa dane po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })}.`,
      sessionNotice: ({ count }: { count: number }) => `Ten serwer usuwa nieaktywne sesje po ${count} ${plural({ count, one: 'dniu', few: 'dniach', many: 'dniach' })} bezczynności.`,
      sessions: "Sesje",
      sidechainMessages: "Transkrypcje podagentów",
      usageEvents: "Zdarzenia użycia",
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

    reachabilityRemediation: {
      failedToOpenInstallLink: "Nie udało się otworzyć strony instalacji Tailscale.",
      tailscale: {
        title: "Ten relay używa Tailscale",
        desktopBody: "Ten komputer nie mógł połączyć się z relayem przez Tailscale. Tailscale może nie być zainstalowany, zalogowany albo podłączony do właściwego tailnetu na tym komputerze.",
        webBody: "Ta przeglądarka nie mogła połączyć się z relayem przez Tailscale. Otwórz Tailscale na tym urządzeniu, upewnij się, że jest połączony z właściwym tailnetem, a następnie spróbuj ponownie.",
        nativeBody: "To urządzenie nie mogło połączyć się z relayem przez Tailscale. Otwórz Tailscale, upewnij się, że jest połączony z właściwym tailnetem, a następnie spróbuj ponownie.",
        installAction: "Zainstaluj Tailscale",
        desktopPrepareAction: "Przygotuj Tailscale",
      },
    },},

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
    storagePersistedTab: "Happier",
    storageAllFilter: "Wszystkie",
    storageFilterCategory: "Sesje",
    storageExternalFilter: "Zewnętrzne",
    storageDirectTab: "Bezpośrednie",
    renameWorkspace: 'Zmień nazwę przestrzeni roboczej',
    renameWorkspacePromptTitle: 'Zmień nazwę przestrzeni roboczej',
    renameWorkspacePromptPlaceholder: 'Wprowadź nazwę...',
    resetWorkspaceName: 'Resetuj nazwę',
    viewOptions: 'Opcje widoku',
    searchSessions: 'Szukaj sesji',
    searchSessionsPlaceholder: 'Szukaj sesji...',
    filterByTags: 'Filtruj według tagów',
    folders: 'Foldery',
    addFolder: 'Dodaj folder',
    addFolderPromptTitle: 'Dodaj folder',
    addSubfolder: 'Dodaj podfolder',
    addSubfolderPromptTitle: 'Dodaj podfolder',
    folderNamePlaceholder: 'Nazwa folderu',
    renameFolder: 'Zmień nazwę folderu',
    renameFolderPromptTitle: 'Zmień nazwę folderu',
    moveFolder: 'Przenieś folder',
    deleteFolder: 'Usuń folder',
    deleteFolderPromptTitle: 'Usuń folder',
    deleteFolderPromptDescription: 'Sesje w tym folderze pozostaną w obszarze roboczym.',
    newSessionInFolder: 'Nowa sesja w folderze',
    clearFolderFocus: 'Wyczyść fokus folderu',
    folderViewTree: 'Widok folderów',
    folderViewOff: 'Ukryj foldery',
    moveToFolder: 'Przenieś do folderu',
    moveToWorkspaceRoot: 'Katalog główny przestrzeni roboczej',
    sessionFallbackLabel: 'Sesja',
    moveSheetTitle: ({ item }: { item: string }) => 'Move ' + item,
    moveSheetDestinationLabel: 'Miejsce docelowe',
    moveSheetSubmit: 'Rusz się',
    moveSheetSearchPlaceholder: 'Search folders...',
    moveSheetEmpty: 'Brak dostępnych celów ruchu',
    moveSheetDestinations: 'Miejsca docelowe',
    moveSheetDisabledDescendant: 'Nie można przejść do samego siebie ani do folderu podrzędnego.',
    moveSheetDisabledMaxDepth: 'Przekroczyłoby to limit głębokości folderu.',
    moveSheetDisabledCurrent: 'Już w tym miejscu.',
    moveSheetDisabledUnavailable: 'To miejsce docelowe jest niedostępne.',
    dragHandleA11yLabel: 'Przeciągnij uchwyt',
    dragA11yPickedUp: ({ item }: { item: string }) => 'Picked up ' + item + '.',
    dragA11yDroppedReorder: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' near ' + destination + '.',
    dragA11yDroppedNest: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' into ' + destination + '.',
    dragA11yDroppedRoot: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' to ' + destination + '.',
    dragA11yCancelled: ({ item }: { item: string }) => 'Move cancelled for ' + item + '.',
    dragA11yBlocked: ({ item, reason }: { item: string; reason: string }) => 'Could not move ' + item + ': ' + reason,
    dragA11yBlockedDescendantCycle: 'miejsce docelowe znajduje się w przeniesionym folderze',
    dragA11yBlockedLeafCannotBeParent: 'sesje nie mogą zawierać innych elementów',
    dragA11yBlockedMaxDepth: 'osiągnięto limit głębokości folderu',
    dragA11yBlockedSamePosition: 'już na tym stanowisku',
    dragA11yBlockedWorkspaceScope: 'miejsce docelowe znajduje się w innym obszarze roboczym',
    dragA11yBlockedNoTarget: 'nie wybrano miejsca docelowego',
    dragA11yBlockedDirectSession: 'sesji bezpośrednich nie można przenosić do folderów',
    dragA11yBlockedFeatureDisabled: 'foldery sesji nie są włączone',
    dragA11yBlockedUnsupportedItem: 'tego elementu nie można przenieść do folderów',
    hideInactiveSessions: 'Ukryj nieaktywne sesje',
    showInactiveSessions: 'Pokaż nieaktywne sesje',
    attentionSectionTitle: 'Wymaga uwagi',
    workingSectionTitle: 'Pracuje',
        backgroundWorkingSectionTitle: 'Pracuje w tle',
    selectionSelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionA11ySelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionCheckboxA11yLabel: 'Wybierz sesję',
    selectionSelectAction: 'Wybierz',
    selectionSelectAllVisible: 'Zaznacz wszystko',
    selectionSelectAllVisibleA11yLabel: 'Wybierz wszystkie widoczne sesje',
    selectionMoveSheetSourceLabel: ({ count }: { count: number }) => count === 1 ? '1 selected session' : `${count} selected sessions`,
    selectionAddTags: 'Dodaj tagi',
    selectionRemoveTags: 'Usuń tagi',
    selectionSetTags: 'Ustaw tagi',
    selectionAddTagsPromptTitle: 'Dodaj tagi',
    selectionRemoveTagsPromptTitle: 'Usuń tagi',
    selectionSetTagsPromptTitle: 'Ustaw tagi',
    selectionTagsPromptMessage: 'Oddziel tagi przecinkami.',
    selectionTagsPlaceholder: 'tag-jeden, tag-dwa',
    selectionCancelA11yLabel: 'Anuluj wybór sesji',
    selectionProgress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total} complete`,
    selectionCancelRunningA11yLabel: 'Anuluj akcję dla wybranych sesji',
    selectionResult: ({ succeeded, failed, skipped }: { succeeded: number; failed: number; skipped: number }) => `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    selectionDismissResultA11yLabel: 'Ukryj wynik akcji dla wybranych sesji',
    selectionConfirm: ({ action, count }: { action: string; count: number }) => `${action} ${count} selected ${count === 1 ? 'session' : 'sessions'}?`,
    selectionConfirmA11yLabel: ({ action }: { action: string }) => `Confirm ${action}`,

    emptyState: {
      title: "Nie ma jeszcze sesji",
      description: "Rozpocznij sesję na jednej ze swoich maszyn online.",
      descriptionPrefix: "Rozpocznij sesję na jednej ze swoich maszyn, używając ",
      descriptionSuffix: " w terminalu lub używając przycisków poniżej.",
      actionsTitle: "Rozpocznij sesję",
      startSessionOnMachine: ({ machine }: { machine: string }) => `Rozpocznij sesję na ${machine}`,
      startSessionOnMachineSubtitle: "Wybierz folder i otwórz nową sesję na tej maszynie.",
      reconnectMachineActionSubtitle: "Połącz ponownie usługę działającą w tle, aby ta maszyna mogła znów uruchamiać sesje.",
      startDaemonActionSubtitle: "Zainstaluj lub uruchom ponownie usługę działającą w tle potrzebną do uruchamiania sesji.",
    },
    openProject: 'Otwórz projekt',
    workspaceRoot: "Katalog główny obszaru roboczego",
    failedToMoveSessionToFolder: "Nie udało się przenieść sesji do folderu.",
    newFolderDefaultName: "Nowy folder",},

  directSessions: {
    browseTitle: "Przeglądaj sesje zewnętrzne",
    browseOpenExisting: "Przeglądaj sesje zewnętrzne",
    browseActionSubtitle: "Wybierz maszynę, agenta i sesję, aby otworzyć ją tutaj.",
    browseFiltersTitle: "Wybierz źródło",
    browseMachines: "Maszyny",
    browseAgents: "Agenci",
    browseSources: "Źródła",
    browseSourceCodexUserHome: "Mój katalog Codex",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Połączone usługi ${service}`,
    browseSourceClaudeDefault: "Domyślna konfiguracja Claude",
    browseSourceOpenCodeDefault: "Domyślny serwer OpenCode",
    browseCandidates: "Dostępne sesje",
    browseNoMachines: "Na razie nie ma dostępnych maszyn dla sesji bezpośrednich.",
    browseNoCandidates: "Nie znaleziono sesji zewnętrznych dla tej maszyny i agenta.",
    browseActivityRunning: "Uruchomiona",
        browseActivityRunningNow: "Uruchomiona teraz",
    browseActivityRecent: "Niedawna",
    browseActivityIdle: "Bezczynna",
    browseActivityUnknown: "Nieznana",
        browseSearchPlaceholder: "Szukaj sesji…",
        browseNoSearchResults: "Żadna sesja nie pasuje jeszcze do tego wyszukiwania.",
    browseLoadMore: "Wczytaj więcej sesji",
    browseFailedToLoad: "Nie udało się wczytać sesji zewnętrznych.",
    browseLinkFailed: "Nie udało się połączyć wybranej sesji zewnętrznej.",
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
    cursorSessionId: "ID sesji Cursor",
    cursorSessionIdCopied: "ID sesji Cursor skopiowano do schowka",
    metadataCopied: "Metadane skopiowane do schowka",
    failedToCopyMetadata: "Nie udało się skopiować metadanych",
    copyDebugInformation: "Kopiuj informacje",
    debugInformationCopyLabel: "Informacje",
    providerSessionLogs: ({ provider }: { provider: string }) => `Logi sesji ${provider}`,
    failedToKillSession: "Nie udało się zakończyć sesji",
    failedToStopSession: "Nie udało się zatrzymać sesji",
    failedToArchiveSession: "Nie udało się zarchiwizować sesji",
    connectionStatus: "Status połączenia",
    created: "Utworzono",
    lastUpdated: "Ostatnia aktualizacja",
    sequence: "Sekwencja",
    quickActions: "Szybkie akcje",
    markSessionRead: "Oznacz jako przeczytaną",
    markSessionReadSubtitle: "Wyczyść nieprzeczytaną uwagę dla tej sesji",
    markSessionUnread: "Oznacz jako nieprzeczytaną",
    markSessionUnreadSubtitle: "Zostaw tę sesję na liście nieprzeczytanych",
    keepInAttention: "Zostaw w sekcji Wymaga uwagi",
    keepInAttentionSubtitle: "Zostanie tutaj nawet po przeczytaniu",
    removeFromAttention: "Usuń z sekcji Wymaga uwagi",
    removeFromAttentionSubtitle: "Po przeczytaniu znów zejdzie niżej na liście",
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
    inactiveAndArchivedSessions: "Nieaktywne i zarchiwizowane sesje",
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
    newSessionSameSetup: "Nowa sesja z tą samą konfiguracją",
    newSessionSameSetupSubtitle: "Użyj ponownie maszyny, folderu, silnika, modelu i opcji tej sesji.",
    failedToRenameSession: "Nie udało się zmienić nazwy sesji",
    failedToMarkSessionRead: "Nie udało się oznaczyć sesji jako przeczytanej",
    failedToMarkSessionUnread: "Nie udało się oznaczyć sesji jako nieprzeczytanej",
    sessionRenamed: "Pomyślnie zmieniono nazwę sesji",

	    openInSplitRight: "Otwórz w podziale po prawej",
	    openInSplitDown: "Otwórz w podziale poniżej",
	    revealInCurrentSplit: "Pokaż w bieżącym podziale",},

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
      chipPicker: {
          selectedOptionAccessibilityLabel: ({ option }: { option: string }) => `${option}. Wybrano.`,
      },
    suggestionGroups: {
      files: 'Pliki',
      plugins: 'Wtyczki',
      sessions: 'Sesje',
      references: 'Odwołania',
      skills: 'Umiejętności',
      commands: 'Polecenia',
    },
    stopCodingTurn: "Zatrzymaj turę programowania",
      nonSteerableSend: {
        title: 'Agent jest zajęty',
        modeChangeMessage: 'Zmiany trybu uprawnień nie można zastosować do trwającej tury.',
        providerConfigMessage: 'Zmiany tego ustawienia dostawcy nie można zastosować do trwającej tury.',
        specialCommandMessage: 'Tego polecenia nie można wykonać podczas aktywnej tury.',
        interruptAndSend: 'Przerwij i wyślij teraz',
        applySettingAndSteer: 'Zastosuj ustawienie i steruj teraz',
        applyNamedSettingAndSteer: ({ setting, value }: { setting: string; value: string }) => `Zastosuj ${setting} → ${value} i steruj teraz`,
        steerWithoutApplying: 'Steruj teraz bez stosowania (zastosuje się przy następnej wiadomości)',
        queueForAfterTurn: 'Dodaj do kolejki po turze',
      },
    dropToAttach: "Upuść, aby dołączyć pliki",
    providerUsage: {
      title: "Użycie dostawcy",
      accessibilityLabel: ({ value }: { value: string }) =>
        `Użycie dostawcy: pozostało ${value}`,
      remaining: ({ percent }: { percent: string }) => `pozostało ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) =>
        `pozostało ${percent} · reset za ${reset}`,
      usedCount: ({ used, limit }: { used: string; limit: string }) =>
        `${used}/${limit} użyto`,
      duration: {
        now: "teraz",
        outdated: 'Przestarzałe',
        daysHours: ({ days, hours }: { days: number; hours: number }) =>
          `${days}d ${hours}g`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
          `${hours}g ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}g`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
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
      safeYolo: "Auto",
      yolo: "YOLO",
      plan: "Tryb planowania",
      bypassPermissions: "Tryb YOLO",
      badgeAccept: "Akceptuj",
      badgePlan: "Plan",
      badgeReadOnly: "Tylko do odczytu",
      badgeSafeYolo: "Auto",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "Akceptuj wszystkie edycje",
      badgeBypassAllPermissions: "Omiń wszystkie uprawnienia",
      badgePlanMode: "Tryb planowania",
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
      customAcp: "Custom ACP",
      pi: "Pi",
      copilot: "Copilot",

      ohMyPi: "oh-my-pi",},
    auggieIndexingChip: {
      on: "Indeksowanie: włączone",
      off: "Indeksowanie: wyłączone",
    },
      model: {
        title: "MODEL",
        useCliSettings: "Użyj ustawień CLI",
        running: ({ model }: { model: string }) => `Uruchomiony: ${model}`,
        lastUsed: ({ model }: { model: string }) => `Ostatnio używany: ${model}`,
        lastReported: ({ model }: { model: string }) => `Ostatnio zgłoszony: ${model}`,
        applyTimingNextMessage: "Obowiązuje od następnej wiadomości",
        applyTimingNewSession: "Obowiązuje po rozpoczęciu nowej sesji",
        selectedForResume: "Wybrany model zostanie użyty po wznowieniu tej sesji.",
        configureInCli: "Skonfiguruj modele w ustawieniach CLI",
        unavailable: "Wykrywanie modeli jest niedostępne dla tego dostawcy na tej maszynie.",
        extendedContextToggleLabel: "Kontekst 1 mln tokenów",
        extendedContextToggleDescription: "Użyj rozszerzonego okna kontekstu o pojemności 1 mln tokenów dla tego modelu.",
        customDescription: "Użyj id modelu, którego nie ma na liście.",
        customPromptBody: "Wpisz id modelu",
        customPlaceholder: "np. claude-3.5-sonnet",
      },
    codexPermissionMode: {
      title: "TRYB UPRAWNIEŃ",
      default: "Ustawienia CLI",
      plan: "Tryb planowania",
      readOnly: "Tryb tylko do odczytu",
      safeYolo: "Auto",
      yolo: "YOLO",
      badgePlan: "Plan",
      badgeReadOnly: "Tylko do odczytu",
      badgeSafeYolo: "Auto",
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
      windowTitle: "Okno kontekstu",
      usedDetail: ({
        percent,
        used,
        total,
      }: {
        percent: string;
        used: string;
        total: string;
      }) => `${percent} • wykorzystano ${used}/${total} kontekstu`,
      description: "Automatycznie kompaktuje kontekst, gdy jest to potrzebne.",
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
      optionsUnavailable: "Opcje konfiguracji są niedostępne dla tego dostawcy na tej maszynie.",
      currentValue: ({ value }: { value: string }) => `Aktualnie: ${value}`,
      optionOverriddenBy: ({ name }: { name: string }) => `Nadpisane przez ${name}`,
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
    showFullContent: "Pokaż całą treść",
    showLessContent: "Pokaż mniej",
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
    workflowView: {
      title: "Tytuł",
      description: "Opis",
      status: "Stan",
      summary: "Podsumowanie",
      run: "Uruchomienie",
      task: "Zadanie",
      toolUse: "Użycie narzędzia",
    },
    workflowActivityView: {
        untitled: "Przepływ pracy",
        loading: "Ładowanie…",
        unavailable: "Szczegóły niedostępne",
        noDetail: "Brak dalszych szczegółów",
        statusActive: "Uruchomiony",
        statusComplete: "Ukończony",
      statusFailed: "Nieudany",
      statusStopped: "Zatrzymany",
      statusInterrupted: "Przerwano",
      statusBlocked: "Zablokowany",
        statusCancelled: "Anulowany",
        statusUnknown: "Nieznany",
        phaseUntitled: "Faza",
        phaseActivity: "Aktywność",
        phaseComplete: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} ukończonych`,
        phaseActive: ({ count }: { count: number }) => `${count} aktywnych`,
        phaseFailed: ({ count }: { count: number }) => `${count} nieudanych`,
        phaseBlocked: ({ count }: { count: number }) => `${count} zablokowanych`,
        phasePending: ({ count }: { count: number }) => `${count} oczekujących`,
        phaseSummary: ({ index, total, complete, agents }: { index: number; total: number; complete: number; agents: number }) => `Faza ${index} z ${total} · ${complete}/${agents} agentów`,
        agentFraction: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} agentów`,
        agentsCount: ({ count }: { count: number }) => `${count} agentów`,
        tokens: ({ tokens }: { tokens: string }) => `${tokens} tokenów`,
        toolCalls: ({ count }: { count: number }) => `${count} narzędzi`,
        showMore: ({ count }: { count: number }) => `Pokaż ${count}`,
        detailShowMore: 'Pokaż więcej',
        detailShowLess: 'Pokaż mniej',
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
    taskOutputView: {
      waitingForTask: "Oczekiwanie na zakończenie zadania w tle.",
    },
    taskStopView: {
      stoppedCommandLabel: "Zatrzymane polecenie",
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
      claudeDialogNotice: {
        header: 'Okno dialogowe Claude',
        question: 'Claude wyświetla okno dialogowe. Otwórz terminal, aby je sprawdzić i wybrać sposób kontynuacji.',
        openTerminal: 'Otwórz terminal',
        description: 'Sprawdź okno dialogowe i odpowiedz na nie w terminalu Claude.',
      },
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
      pullRequests: {
        checkoutLocalTitle: "Pobierz pull request",
        checkoutLocalSubtitle: "Wklej URL PR lub merge requesta, numer albo komendę checkout.",
        openWorktreeTitle: "Otwórz pull request w worktree",
        openWorktreeSubtitle: "Przygotuj pull request w osobnym worktree i uruchom tam sesję.",
        promptTitle: "Referencja pull requesta",
        promptBody: "Wklej URL pull requesta lub merge requesta, numer albo komendę checkout.",
        promptPlaceholder: "https://github.com/owner/repo/pull/123",
        invalidReferenceBody: "Podaj prawidłową referencję pull requesta lub merge requesta.",
        checkoutFailed: "Nie udało się pobrać pull requesta.",
        worktreeFailed: "Nie udało się przygotować worktree dla pull requesta.",
      },
      indexLock: {
        title: "Usunąć nieaktualną blokadę Git?",
        body: "Git zgłosił blokadę indeksu. Jeśli nie działa inna komenda Git, Happier może usunąć nieaktualną blokadę i spróbować ponownie.",
        confirm: "Usuń blokadę i ponów",
        recoveryFailed: "Nie udało się usunąć blokady indeksu Git.",
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
    agentReportedTurnChanges: ({ count }: { count: number }) =>
      `Zmiany zgłoszone przez agenta (${count})`,
    checkpointTurnChanges: ({ count }: { count: number }) =>
      `Zmiany punktu kontrolnego (${count})`,
    selectedForCommitChanges: ({ count }: { count: number }) =>
      `Wybrane do commita (${count})`,
    latestTurnDescription:
      'Zmiany pochodzące od dostawcy z ostatnio zakończonej tury.',
    agentReportedTurnDescription:
      'Zmiany jawnie zgłoszone przez agenta dla bieżącej tury.',
    checkpointUnavailable:
      'Treść punktu kontrolnego jest niedostępna dla tej tury.',
    checkpointAttributionShared:
      'Atrybucja punktu kontrolnego jest współdzielona z inną aktywnością worktree.',
    checkpointAttributionUnknown:
      'Nie można określić atrybucji punktu kontrolnego.',
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
    repositoryInit: {
      initialize: "Zainicjuj repozytorium",
      initializing: "Inicjowanie…",
      confirmTitle: "Zainicjować repozytorium?",
      confirmBody: "Utworzy repozytorium Git w tym folderze. Istniejące pliki nie zostaną dodane do stagingu ani zatwierdzone.",
      errors: {
        failed: "Nie udało się zainicjować repozytorium.",
      },
    },
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
        frontmatterReadOnly: 'Frontmatter (tylko do odczytu)',
      },
      fileEditingUnsupported:
        "Edycja plików nie jest obsługiwana przez podłączonego daemona. Zaktualizuj Happier na maszynie, aby włączyć operacje zapisu.",
      fileChangedExternally:
        "Ten plik zmienił się na dysku podczas edycji. Szkic pozostał bez zmian; sprawdź najnowszą wersję pliku przed zapisaniem.",
      selectionFailed: "Nie udało się zaktualizować wyboru",
      openReviewCommentsFailed: "Nie udało się otworzyć komentarzy do przeglądu",
        reviewComments: {
          title: ({ count }: { count: number }) => `Komentarze przeglądu (${count})`,
          placeholder: "Dodaj komentarz do przeglądu…",
          jump: "Przejdź",
          addCommentA11y: "Dodaj komentarz",
          closeCommentA11y: "Zamknij komentarz",
          draftsChipLabel: ({ count }: { count: number }) => `Przegląd (${count})`,
          modalSubtitle: "Sprawdź, które komentarze zostaną wysłane z następną wiadomością.",
          modalSummary: ({ included, count }: { included: number; count: number }) =>
            `${included} z ${count} wybranych do następnego promptu`,
          detachOrDiscardTitle: "Usunąć komentarze przeglądu?",
          detachOrDiscardBody:
            "Odłączenie zachowa komentarze, ale wykluczy je z następnego promptu. Odrzucenie je usunie.",
          detachFromPrompt: "Odłącz od promptu",
          durable: {
            headerTitle: "Komentarze przeglądu",
            count: ({ count }: { count: number }) => `${count}`,
            empty: "Nie ma jeszcze komentarzy przeglądu",
            engine: "Silnik",
            stale: "Nieaktualne",
            outdated: "Przestarzałe",
            binarySnapshot: "Migawka binarna",
            minified: "Prawdopodobnie zminifikowane",
            submoduleSnapshot: "Migawka submodułu",
            symlinkSnapshot: "Migawka dowiązania symbolicznego",
            textSnapshot: "Migawka tekstu",
            tooLargeSnapshot: "Migawka jest za duża",
            encryptedSnapshot: "Zaszyfrowana migawka",
            truncated: "Obcięte",
            bidiControls: "Kontrolki bidi",
            redacted: "Zredagowane",
            contentUnavailable: "Treść niedostępna",
            edit: "Edytuj",
            resolve: "Rozwiąż",
            dismiss: "Odrzuć",
            reopen: "Otwórz ponownie",
            redact: "Zredaguj",
            reply: "Odpowiedz",
            replyUnavailable: "Odpowiedź niedostępna",
            bulkResolve: "Rozwiąż widoczne",
            bulkDismiss: "Odrzuć widoczne",
            bulkPartialFailure: "Niektórych komentarzy nie zaktualizowano",
            bulkFailure: ({ commentId, errorCode }: { commentId: string; errorCode: string }) => `${commentId}: ${errorCode}`,
            filtersTitle: "Filtry",
            showActive: "Aktywne",
            showHistory: "Historia",
            refresh: "Odśwież",
            loadFailed: "Nie udało się wczytać komentarzy przeglądu",
            transitionReason: "Zaktualizowano z panelu komentarzy przeglądu.",
            bulkTransitionReason: "Aktualizacja zbiorcza z panelu komentarzy przeglądu.",
            editPromptTitle: "Edytuj komentarz przeglądu",
            editPromptBody: "Zaktualizuj treść zapisanego komentarza.",
            replyPromptTitle: "Odpowiedz na komentarz przeglądu",
            replyPromptBody: "Dodaj odpowiedź do trwałego wątku komentarzy.",
            states: {
              proposed: "Zaproponowane",
              open: "Otwarte",
              delegated: "Delegowane",
              pendingReview: "Oczekuje na przegląd",
              resolved: "Rozwiązane",
              dismissed: "Odrzucone",
            },
            directWriteGrant: {
              title: "Bezpośredni zapis komentarzy przeglądu",
              body: ({ pluginId }: { pluginId: string }) => `${pluginId} prosi o uprawnienie do bezpośredniego zapisu komentarzy przeglądu.`,
              grant: "Przyznaj bezpośredni zapis",
              cancel: "Nie teraz",
              revoke: "Cofnij",
            },
          },
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
      commitAdjacentPush: {
        accessibilityLabel: ({ target }: { target: string }) => `Push do ${target}`,
        confirm: {
          title: "Wysłać lokalne commity?",
          body: ({ target }: { target: string }) =>
            `Wyślij lokalne commity do ${target}.`,
          push: "Tak",
          notNow: "Nie",
          pushAndDontAskAgain: "Push i nie pytaj ponownie",
        },
      },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `Ładowanie ${fileName}...`,
        binaryFile: "Plik binarny",
        imagePreviewTooLarge: "Podgląd obrazu jest zbyt duży, aby go wyświetlić",
        sessionMedia: {
          generatedImageA11y: ({ name }: { name: string }) => `Otwórz wygenerowany obraz ${name}`,
          attachmentImageA11y: ({ name }: { name: string }) => `Otwórz załączony obraz ${name}`,
          toolArtifactImageA11y: ({ name }: { name: string }) => `Otwórz obraz artefaktu narzędzia ${name}`,
          generatedVideoA11y: ({ name }: { name: string }) => `Otwórz wygenerowane wideo ${name}`,
          attachmentVideoA11y: ({ name }: { name: string }) => `Otwórz załączone wideo ${name}`,
          toolArtifactVideoA11y: ({ name }: { name: string }) => `Otwórz wideo artefaktu narzędzia ${name}`,
          previewImageA11y: ({ name, current, total }: { name: string; current: number; total: number }) => `Obraz ${current} z ${total}: ${name}`,

          previewUnavailableA11y: "Podgląd multimediów niedostępny",
          unavailableImageA11y: ({ name }: { name: string }) => `${name} unavailable`,},
        cannotDisplayBinary: "Nie można wyświetlić zawartości pliku binarnego",
        diff: "Różnice",
      file: "Plik",
      markdown: "Przecena",
    diffModes: {
      pending: "Oczekujące",
      included: "Uwzględnione",
      combined: "Połączone",
    },
    fileActions: {
      selectForCommit: "Wybierz do commitu",
      selectFilesToCommit: "Wybierz pliki do commitu",
      stageFile: "Dodaj do stage",
      removeFromSelection: "Usuń z zaznaczenia",
      removeFromCommitSelection: "Usuń z wyboru do commitu",
      unstageFile: "Usuń ze stage",
      selectionHint:
        "Wybierz Uwzględnione lub Oczekujące, aby włączyć wybór linii.",
      selectedLines: {
        selectLinesForCommit: "Wybierz linie do commitu",
        stageSelectedLines: "Dodaj zaznaczone linie do stage",
        unstageSelectedLines: "Usuń zaznaczone linie ze stage",
      },
      clearSelection: "Wyczyść zaznaczenie",

      rangeSelection: "Wybór zakresu",
      selectEntireFileForCommit: "Wybierz cały plik do zatwierdzenia",},
	    toolbar: {
	      changedFiles: "Zmienione pliki",
	      hiddenFiles: "Pokaż ukryte pliki",
	      details: "Szczegóły",
	      upload: "Prześlij",
	      uploadFiles: "Prześlij pliki",
	      uploadFolder: "Prześlij folder",
      allRepositoryFiles: "Wszystkie pliki repozytorium",
      repositoryView: "Widok repozytorium",
      selectedForCommitView: "Wybrane do commita",
      turnView: "Widok tury",
      sessionView: "Widok sesji",
      view: "Widok",
      review: "Przegląd",
      list: "Lista",
      scm: "Git",

	      agentReportedTurnView: "Tura zgłoszona przez agenta",
	      checkpointTurnView: "Tura checkpointu",},
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
      update: {
        remotes: {
          title: "Zdalne",
          empty: "Dla tego repozytorium nie skonfigurowano zdalnych.",
          addTitle: "Dodaj zdalne",
          editTitle: ({ name }: { name: string }) => `Edytuj ${name}`,
          add: "Dodaj zdalne",
          remove: "Usuń",
          nameLabel: "Nazwa zdalnego",
          fetchUrlLabel: "URL fetch",
          pushUrlLabel: "URL push",
          namePlaceholder: "pochodzenie",
          fetchUrlPlaceholder: "URL fetch",
          pushUrlPlaceholder: "URL push (opcjonalnie)",
          noFetchUrl: "Brak URL fetch",
          removeConfirmTitle: "Usunąć zdalne?",
          removeConfirmBody: ({ name }: { name: string }) =>
            `Usunąć ${name} z tego repozytorium?`,
          errors: {
            nameRequired: "Wpisz nazwę zdalnego.",
            fetchUrlRequired: "Wpisz URL fetch.",
            addFailed: "Nie udało się dodać zdalnego.",
            saveFailed: "Nie udało się zaktualizować zdalnego.",
            removeFailed: "Nie udało się usunąć zdalnego.",
          },
        },
        publishRepository: {
          title: "Opublikuj w GitHub",
          body: "Utwórz repozytorium GitHub i dodaj je jako origin.",
          ownerLabel: "Właściciel",
          repositoryNameLabel: "Nazwa repozytorium",
          repositoryNamePlaceholder: "nazwa-repozytorium",
          visibilityLabel: "Widoczność",
          private: "Prywatne",
          public: "Publiczne",
          internal: "Wewnętrzne",
          remoteKindLabel: "URL zdalny",
          httpsRemote: "Zdalne HTTPS",
          sshRemote: "Zdalne SSH",
          originConflictLabel: "Istniejący origin",
          keepOrigin: "Nie zastępuj",
          setOriginUrl: "Ustaw URL origin",
          pushCurrentBranch: "Wypchnij bieżącą gałąź",
          publish: "Opublikuj repozytorium",
          publishing: "Publikowanie…",
          noTargets: "Połącz GitHub albo zaloguj się przez gh CLI, aby opublikować to repozytorium.",
          errors: {
            targetRequired: "Wybierz konto lub organizację GitHub.",
            nameRequired: "Wpisz nazwę repozytorium.",
            loadTargetsFailed: "Nie udało się wczytać celów publikacji GitHub.",
            publishFailed: "Nie udało się opublikować repozytorium.",
          },

          commitRequired: 'Utwórz commit przed publikacją z włączonym wypychaniem gałęzi.',
          unsafeUrl: 'Dostawca zwrócił akcję przeglądarki poza dozwolonym adresem URL.',
          originConflictRemediation: 'Wybierz, czy zachować istniejący remote origin, czy zaktualizować go do nowego hostowanego repozytorium.',
          auth: {
              connectedAccountReady: 'Połączona usługa GitHub jest dostępna.',
              providerCliReady: 'Uwierzytelniony GitHub CLI jest dostępny.',
          },
          remediation: {
              connectGitHub: 'Połącz GitHub',
              installGh: 'Zainstaluj GitHub CLI',
              useManagedGh: 'Użyj zarządzanego GitHub CLI',
              authenticateGh: 'Uwierzytelnij GitHub CLI',
              openBrowser: 'Otwórz przeglądarkę',
          },},
        branchIntegration: {
          title: "Merge i rebase",
          sourceLabel: "Gałąź źródłowa",
          sourcePlaceholder: "Gałąź lub zdalna referencja",
          merge: "Scal",
          rebase: "Przebazuj",
          continue: "Kontynuuj",
          abort: "Przerwij",
          operationInProgress: ({ operation, source }: { operation: string; source: string }) =>
            `${operation} w toku z ${source}`,
          errors: {
            sourceRequired: "Wpisz gałąź lub referencję źródłową.",
            mergeFailed: "Nie udało się scalić gałęzi.",
            rebaseFailed: "Nie udało się wykonać rebase gałęzi.",
            continueFailed: "Nie udało się kontynuować operacji.",
            abortFailed: "Nie udało się przerwać operacji.",
          },
        },
        pullRequests: {
          title: "Żądanie pull",
          readyTitle: "Gotowe do otwarcia pull requesta",
          view: "Pokaż PR",
          openOrReuse: "Otwórz lub użyj PR",
          pushAndOpen: "Wypchnij i otwórz PR",
          createFeatureBranch: "Utwórz gałąź funkcji",
          createFeatureBranchAndOpen: "Utwórz gałąź i otwórz PR",
          featureBranchPromptTitle: "Nazwa gałęzi funkcji",
          featureBranchPromptBody: "Happier przełączy się na tę gałąź przed kontynuacją.",
          defaultBranchRequiresFeature: "Utwórz gałąź funkcji przed otwarciem pull requesta z gałęzi domyślnej.",
          defaultBranchDenied: "Nie można otwierać pull requestów bezpośrednio z gałęzi domyślnej.",
          states: {
            ready: "Gotowe",
            open: "Otwarty",
            closed: "Zamknięty",
            merged: "Scalony",
          },
          status: {
            creating: "Otwieranie pull requesta…",
            creatingFeatureBranch: "Tworzenie gałęzi funkcji…",
            creatingFeatureBranchPullRequest: "Tworzenie gałęzi funkcji i otwieranie pull requesta…",
            pushingAndCreating: "Wypychanie gałęzi i otwieranie pull requesta…",
          },
          unavailable: {
            notRepositoryTitle: "Nie wykryto repozytorium",
            notRepositoryBody: "Akcje pull requesta pojawią się, gdy ta sesja będzie połączona z repozytorium kontroli wersji.",
            unknownProviderTitle: "Nie wykryto dostawcy hostingu",
            unknownProviderBody: "Dodaj zdalny GitHub, GitLab lub Bitbucket, aby włączyć akcje pull requesta.",
            noBranchTitle: "Nie wybrano gałęzi",
            noBranchBody: "Przełącz się na gałąź przed otwarciem pull requesta.",
            detachedHeadTitle: "Odłączony HEAD",
            detachedHeadBody: "Przełącz się na gałąź przed otwarciem pull requesta.",
          },
          errors: {
            featureBranchRequired: "Utwórz gałąź funkcji przed otwarciem pull requesta.",
            openFailed: "Nie udało się otworzyć pull requesta.",
            branchNameRequired: "Wpisz nazwę gałęzi funkcji.",
            createBranchFailed: "Nie udało się utworzyć gałęzi funkcji.",
            stackedFailed: "Nie udało się ukończyć przepływu pull requesta.",
          },
        },

        pullRequest: {
            title: "Prośba o scalenie",
            existing: "Istniejąca prośba o scalenie",
            ready: "Można utworzyć prośbę o scalenie",
            branchPair: ({ head, base }: { head: string; base: string }) =>
                `${head} do ${base}`,
            open: "Otwórz prośbę o scalenie",
            create: "Utwórz prośbę o scalenie",
            openCompose: "Otwórz tworzenie",
            unsafeUrl: "Dostawca zwrócił link poza dozwolonym adresem URL repozytorium.",
            defaultBranch: {
                confirmTitle: "Utworzyć gałąź funkcji?",
                confirmBody: "Utwórz gałąź funkcji przed otwarciem prośby o scalenie dla tej zmiany na gałęzi domyślnej.",
                confirm: "Utwórz gałąź",
            },
        },
        publish: {
            title: "Opublikuj repozytorium",
            description: "Utwórz hostowane repozytorium i podłącz je jako zdalne.",
            repositoryNameLabel: "Nazwa repozytorium",
            ownerLabel: "Właściciel",
            visibilityLabel: "Widoczność",
            protocolLabel: "Zdalny URL",
            pushCurrentBranch: "Wyślij bieżącą gałąź",
            commitRequired: "Utwórz commit przed publikacją z włączonym wysłaniem gałęzi.",
            submit: "Opublikuj repozytorium",
            unavailable: "Publikowanie nie jest dostępne dla tego repozytorium.",
            unsafeUrl: "Dostawca zwrócił akcję przeglądarki poza dozwolonym adresem URL.",
            auth: {
                connectedAccountReady: "Połączona usługa GitHub jest dostępna.",
                providerCliReady: "Uwierzytelniony GitHub CLI jest dostępny.",
            },
            remediation: {
                connectGitHub: "Połącz GitHub",
                installGh: "Zainstaluj GitHub CLI",
                useManagedGh: "Użyj zarządzanego GitHub CLI",
                authenticateGh: "Uwierzytelnij GitHub CLI",
                openBrowser: "Otwórz przeglądarkę",
            },
            visibility: {
                private: "Prywatne",
                public: "Publiczne",
                internal: "Wewnętrzne",
            },
            protocol: {
                https: "HTTPS",
                ssh: "SSH",
            },
            remoteConflict: {
                label: "Istniejące zdalne origin",
                fail: "Zachowaj istniejące origin",
                setUrl: "Zastąp URL origin",
                remediation: "Wybierz, czy zachować istniejące zdalne origin, czy zaktualizować je do nowego hostowanego repozytorium.",
            },
        },},

      repositoryInit: {
          action: "Zainicjuj repozytorium",
          confirmTitle: "Zainicjować repozytorium?",
          confirmBody: "Utwórz metadane kontroli źródła dla tego folderu, aby można było śledzić zmiany.",
          confirm: "Zainicjuj",
          failed: "Nie udało się zainicjować repozytorium.",
      },},

    indexLockRecovery: {
      title: "Usunąć przestarzałą blokadę indeksu Git?",
      body: "Happier może usunąć plik index.lock rozwiązany przez Git dla tego repozytorium i ponowić nieudaną operację kontroli kodu tylko raz. Nie uruchamia reset, clean, restore ani szerokiej naprawy.",
      confirm: "Usuń blokadę i ponów",
      failed: ({ error }: { error: string }) => `Odzyskiwanie blokady indeksu nie powiodło się: ${error}`,
    },
    checkpointAttributionExclusive:
      'Zawartość checkpointu jest dokładna dla tego przedziału tury, a worktree był wyłączny dla tej sesji.',
    noAgentReportedTurnChanges:
      "Nie wykryto zmian zgłoszonych przez agenta dla tej tury.",
    noCheckpointTurnChanges:
      "Nie wykryto zmian checkpointu dla tej tury.",},

  localServices: {
    inventory: {
      title: 'Usługi lokalne',
      loadingTitle: 'Skanowanie usług lokalnych',
      emptyTitle: 'Nie wykryto usług lokalnych',
      errorTitle: 'Skanowanie usług lokalnych wymaga uwagi',
      refreshing: 'Odświeżanie',
      state: {
        listening: 'Nasłuchuje',
        stale: 'Nieaktualne',
        gone: 'Niedostępne',
        unknown: 'Nieznane',
      },
      address: ({ value }: { value: string }) => `Address: ${value}`,
      folder: ({ value }: { value: string }) => `Folder: ${value}`,
      label: ({ value }: { value: string }) => `Label: ${value}`,
      process: ({ value }: { value: string }) => `Process: ${value}`,
      workspace: ({ value }: { value: string }) => `Workspace: ${value}`,
      confidence: ({ value }: { value: string }) => `Confidence: ${value}`,
            confidenceLabel: {
                strong: 'Wysoka pewność dopasowania',
                moderate: 'Prawdopodobne dopasowanie',
                tentative: 'Wstępne dopasowanie',
            },
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      countBadge: ({ total, running }: { total: string; running: string }) => `${total} services · ${running} running`,
    },
    session: {
      thisSessionTitle: 'Ta sesja',
      workspaceTitle: 'Obszar roboczy',
    },
    scope: {
      workspace: 'Ten obszar roboczy',
      machine: 'Ta maszyna',
      toggleA11y: 'Przełącz zakres usług między tym obszarem roboczym a tą maszyną',
    },
    source: {
      detected: 'Wykryto',
      managed: 'Zarządzane',
      packageScript: 'Skrypt pakietu',
      preview: 'Podgląd',
      terminalUrl: 'URL terminala',
      fileAsset: 'Zasób pliku',
      recent: 'Ostatnie',
    },
    band: {
      machine: 'Inne usługi maszyny',
      suggestions: 'Sugestie',
    },
    rowStatus: {
      running: 'Działa',
      starting: 'Uruchamianie',
      stale: 'Nieaktualne',
      stopped: 'Zatrzymano',
      unavailable: 'Niedostępne',
    },
    managed: {
      title: 'Usługi zarządzane',
      emptyTitle: 'Brak usług zarządzanych',
      owner: ({ value }: { value: string }) => `Owner: ${value}`,
      route: ({ value }: { value: string }) => `Route: ${value}`,
      launchMode: ({ value }: { value: string }) => `Mode: ${value}`,
            launchModeLabel: {
                detectedAfterStart: 'Wykryto po uruchomieniu',
                assignedAtStart: 'Port przypisany przy starcie',
                registeredByTool: 'Zarejestrowane przez narzędzie',
            },
      url: ({ value }: { value: string }) => `URL: ${value}`,
      inventory: ({ value }: { value: string }) => `Inventory: ${value}`,
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      stopActionA11y: 'Zatrzymaj usługę zarządzaną',
      restartActionA11y: 'Uruchom ponownie usługę zarządzaną',
      status: {
        starting: 'Uruchamianie',
        detecting: 'Wykrywanie',
        running: 'Działa',
        unhealthy: 'Niesprawne',
        stopping: 'Zatrzymywanie',
        stopped: 'Zatrzymane',
        failed: 'Niepowodzenie',
      },
    },
    launcher: {
      title: 'Launchpad',
      refreshing: 'Odświeżanie usług lokalnych',
      openInBrowserA11y: 'Otwórz usługę lokalną w przeglądarce',
      status: {
        ready: 'Gotowe do podglądu',
        managed: 'Usługa zarządzana',
        unavailableGeneric: "Ta usługa jest obecnie niedostępna.",
      },
      unavailableReason: {
        launchUnavailable: "Tej usługi nie można uruchomić z tego miejsca.",
        previewRegistrationUnavailable: "Ta usługa nie może zarejestrować podglądu.",
        browserTargetUnavailable: "Tej usługi nie można otworzyć w przeglądarce.",
        starting: "Ta usługa wciąż się uruchamia.",
        stale: "Ta usługa została wykryta, ale już nie odpowiada.",
        unavailable: "Ta usługa jest obecnie niedostępna.",
      },
    },
    publicPreview: {
      title: 'Publiczne podglądy',
      createSubtitle: 'Utwórz link podglądu do udostępnienia',
      activeSubtitle: 'Link do udostępnienia jest aktywny',
      secretLinkMode: 'Sekretny link',
      disabledPolicySubtitle: 'Publiczne podglądy są wyłączone dla tej usługi.',
      disabledUnsupportedModeSubtitle: 'Happier tworzy teraz tylko publiczne podglądy z sekretnym linkiem.',
      disabledLimitSubtitle: 'Osiągnięto limit publicznych podglądów. Unieważnij istniejący link przed utworzeniem kolejnego.',
      disabledNoPreviewSubtitle: 'Otwórz podgląd lokalny przed utworzeniem linku publicznego.',
      disabledReason: {
        auditUnavailable: 'Rejestrowanie audytu publicznego podglądu jest niedostępne.',
        dnsTlsUnavailable: 'Publiczne podglądy czekają, aż DNS/TLS będzie gotowe.',
        expired: 'Ten link publicznego podglądu wygasł.',
        policyInvalid: 'Zasady publicznego podglądu są niekompletne.',
        previewNotEligible: 'Ten lokalny podgląd nie kwalifikuje się do linku publicznego.',
        publicBaseUrlUnavailable: 'Bazowy URL publicznego podglądu nie jest skonfigurowany.',
        rateLimitUnavailable: 'Limitowanie publicznego podglądu jest niedostępne.',
        rateLimited: 'Ten link publicznego podglądu jest ograniczony limitem.',
        relayUnavailable: 'Relay publicznego podglądu jest niedostępny.',
        revoked: 'Ten link publicznego podglądu został unieważniony.',
        secretLinkUnavailable: 'Publiczne podglądy z sekretnym linkiem nie są skonfigurowane.',
        sessionNotAuthorized: 'Nie masz dostępu do utworzenia linku publicznego dla tej sesji.',
      },
      createActionA11y: 'Utwórz publiczny link podglądu',
      revokeActionA11y: 'Unieważnij publiczny link podglądu',
      confirmTitle: 'Udostępnić usługę publicznie?',
      confirmMessage: ({ service }: { service: string }) =>
        `„${service}” stanie się publicznie dostępny w internecie przez udostępniany sekretny link.`,
      confirmCta: 'Utwórz link publiczny',
            revokeConfirmTitle: 'Cofnąć link publiczny?',
            revokeConfirmMessage: ({ url }: { url: string }) => `Cofnąć publiczny link podglądu ${url}? Każdy, kto go używa, utraci dostęp.`,
            revokeConfirmCta: 'Cofnij link',
    },
    actions: {
      terminateDetectedA11y: 'Zakończ wykrytą usługę lokalną',
      terminatePidOnlyConfidence: 'Pewność zakończenia: tylko tożsamość PID; wymagane potwierdzenie',
            copyAddressA11y: 'Kopiuj adres usługi',
            terminateConfirmTitle: 'Zakończyć usługę?',
            terminateConfirmMessage: ({ service }: { service: string }) => `Zakończyć ${service}? Użyj tego tylko wtedy, gdy masz pewność, że to właściwy proces.`,
            terminateConfirmCta: 'Zakończ',
            stopConfirmTitle: 'Zatrzymać usługę?',
            stopConfirmMessage: ({ service }: { service: string }) => `Zatrzymać ${service}? Usługa nie będzie osiągalna, dopóki nie uruchomi się ponownie.`,
            stopConfirmCta: 'Zatrzymaj',
    },
  },

  browserContext: {
    composer: {
      attachPageReference: 'Dołącz stronę',
      startAnnotation: 'Dodaj adnotację strony',
      cancelAnnotation: 'Anuluj adnotację',
      attachAnnotation: 'Dołącz adnotację',
      contextUnavailable: 'Kontekst przeglądarki jest niedostępny',
      attachedPage: ({ title }: { title: string }) => `Strona: ${title}`,
      attachedPageStale: ({ title }: { title: string }) => `Odśwież kontekst strony: ${title}`,
      attachedCount: ({ count }: { count: string }) => `${count} kontekstów przeglądarki`,
      removeAttachedContext: 'Usuń kontekst przeglądarki',
      untitledPage: 'Strona bez tytułu',
    },
  },

  browserRecording: {
    actions: {
      start: 'Rozpocznij nagrywanie',
      stop: 'Zatrzymaj nagrywanie',
      cancel: 'Anuluj nagrywanie',
    },
    fidelity: {
        pixel: 'Przechwytywanie wizualne',
        cdp: 'Przechwytywanie przeglądarki',
        injectedPage: 'Przechwytywanie strony',
        nativeCallback: 'Przechwytywanie natywne',
        streamFrame: 'Przechwytywanie strumienia',
        previewProxy: 'Przechwytywanie podglądu',
        unavailable: 'Oczekiwanie na przechwytywanie',
    },
    status: {
      noView: 'Nie wybrano widoku przeglądarki.',
      unavailable: ({ reason }: { reason: string }) => `Nagrywanie niedostępne: ${reason}`,
      ready: ({ fidelity }: { fidelity: string }) => `Nagrywanie gotowe (${fidelity})`,
      recording: ({ elapsed, fidelity }: { elapsed: string; fidelity: string }) => `Nagrywanie ${elapsed} (${fidelity})`,
      temporary: 'Tymczasowe',
      attached: 'Dołączone',
      discarded: 'Odrzucone',
    },
  },

  browserAutomation: {
    actions: {
      cancel: 'Anuluj automatyzację',
    },
    status: {
      noView: 'Nie wybrano widoku przeglądarki.',
      unavailable: 'Automatyzacja niedostępna',
            running: 'Automatyzacja działa',
            readyForActions: 'Automatyzacja gotowa',
      ready: ({ authority }: { authority: string }) => `Automatyzacja gotowa (${authority})`,
      active: ({ requestId }: { requestId: string }) => `Automatyzacja działa: ${requestId}`,
    },
    timeline: {
      entry: ({ action, status }: { action: string; status: string }) => `${action}: ${status}`,
            action: {
                inspect: 'Sprawdź stronę',
                interact: 'Interakcja ze stroną',
                navigate: 'Nawiguj po stronie',
                browserAction: 'Działanie przeglądarki',
            },
            status: {
                succeeded: 'Gotowe',
                failed: 'Niepowodzenie',
                canceled: 'Anulowano',
                timedOut: 'Przekroczono czas',
                stale: 'Nieaktualna strona',
                blocked: 'Zablokowano',
                unsupported: 'Nieobsługiwane',
            },
    },
  },

  browserSurface: {
    title: 'Przeglądarka',
    openA11y: 'Otwórz przeglądarkę',
    openHint: 'Otwiera launchpad przeglądarki w szczegółach.',
    openDisabledA11y: 'Przeglądarka niedostępna',
  },

  browserLaunchpad: {
    refreshing: 'Odświeżanie celów przeglądarki',
    sections: {
      running: 'Działające podglądy',
      managed: 'Usługi zarządzane',
      plugin: 'UI wtyczek',
      recent: 'Ostatnie',
      unavailable: 'Niedostępne',
    },
    status: {
      ready: 'Gotowe do otwarcia',
      managed: 'Usługa zarządzana',
      plugin: 'UI wtyczki',
      recent: 'Ostatni cel',
      openUnavailable: 'Otwieranie jest niedostępne',
      unavailableGeneric: "Ten cel jest obecnie niedostępny.",
    },
    guidance: {
      title: 'Nic jeszcze nie działa',
      body: 'Uruchom serwer deweloperski, a porty localhost tego obszaru roboczego pojawią się tutaj automatycznie. Możesz też wpisać dowolny adres powyżej.',
    },
    urlEntry: {
      label: 'Otwórz adres',
      placeholder: 'Wpisz URL',
      open: 'Otwórz adres',
      invalid: 'Wpisz prawidłowy adres http lub https.',
    },
    error: {
      title: 'Cele przeglądarki wymagają uwagi',
      subtitle: ({ reason }: { reason: string }) => `Odświeżanie nie powiodło się: ${reason}`,
    },
  },

  browserShell: {
    address: {
      label: 'Adres przeglądarki',
      placeholder: 'Wpisz URL',
            copy: 'Kopiuj URL',
    },
        frame: {
            errorTitle: 'Nie udało się wczytać strony',
        },
    nonFramable: {
      title: 'Ta witryna nie zezwala na osadzanie.',
      openInSystemBrowser: 'Otwórz w przeglądarce systemowej',
    },
    toolbar: {
      back: 'Wstecz',
      forward: 'Dalej',
      reload: 'Odśwież',
      stop: 'Zatrzymaj',
      openNativeDevtools: 'Otwórz natywne narzędzia deweloperskie',
      reloadAfterCrash: 'Załaduj stronę ponownie',
    },
    tabs: {
      newTab: 'Nowa karta',
    },
    origin: {
      newTab: 'Nowa karta',
      localPreview: 'Podgląd lokalny',
      hostedPlugin: 'UI wtyczki',
      external: 'Zewnętrzny URL',
      streamed: 'Przeglądarka strumieniowana',
      simulator: 'Symulator',
    },
    security: {
      secure: 'Połączenie bezpieczne',
      local: 'Połączenie lokalne',
      insecure: 'Niezabezpieczone',
      internal: 'Powierzchnia wewnętrzna',
      unknown: 'Nieznany stan połączenia',
    },
    title: {
      untitled: 'Strona bez tytułu',
    },
    overflow: {
      open: 'Więcej narzędzi przeglądarki',
      title: 'Narzędzia przeglądarki',
    },
    profile: {
      title: 'Status profilu przeglądarki',
      modeLabel: 'Tryb',
      storageLabel: 'Pamięć',
      permissionsLabel: 'Uprawnienia',
      unavailable: 'Niedostępne',
      mode: {
        ephemeral: 'Tymczasowy',
        session: 'Sesja',
        user: 'Użytkownik',
        plugin: 'Wtyczka',
      },
      storage: {
        unavailable: 'Brak partycji',
        ephemeral: 'Tymczasowa',
        session: 'Sesja',
        persistent: 'Trwała',
        plugin: 'Wtyczka',
      },
      permissions: {
        none: 'Brak uprawnień',
        active: ({ count }: { count: number }) => `${count} aktywne`,
        prompt: 'Pytaj',
        denied: 'Odmowa',
      },
      management: {
        createProfile: 'Nowy profil',
        selectProfile: 'Wybierz profil',
        revokePermission: 'Cofnij',
        clearStorage: 'Wyczyść pamięć',
      },
    },
    privacy: {
      title: 'Prywatność i bezpieczeństwo',
    },
    status: {
      noView: 'Nie wybrano widoku przeglądarki.',
      empty: 'Nie załadowano żadnej strony.',
      noUrl: 'Nie załadowano URL.',
      loading: 'Ładowanie…',
      crashed: 'Ta strona przestała odpowiadać i została zamknięta.',
    },
    unavailable: {
      generic: "Ta strona jest obecnie niedostępna.",
      desktopEngineUnavailable: "Wbudowany silnik przeglądarki jest niedostępny na tym komputerze.",
      desktopWebView: "Wbudowany silnik przeglądarki jest niedostępny na tym komputerze.",
      desktopWebViewUnsupportedPlatform: "Wbudowane przeglądanie nie jest jeszcze dostępne na tej platformie.",
      externalUrlPolicyDenied: "Ta witryna jest zablokowana przez Twoje zasady bezpieczeństwa.",
      externalUrlUnavailable: "Tej witryny nie można otworzyć we wbudowanej przeglądarce.",
      simulatorPreviewUnavailable: "Podgląd symulatora jest obecnie niedostępny.",
      sidecarRuntimeUnavailable: "Środowisko przeglądarki jest obecnie niedostępne.",
      streamedBrowserUnavailable: "Przeglądarka strumieniowa jest obecnie niedostępna.",
      hostUnavailable: "Utracono połączenie z hostem przeglądarki.",
      targetKindUnavailable: "Tego celu nie można otworzyć we wbudowanej przeglądarce.",
      browserProfileMissing: "Dla tej strony nie jest dostępny żaden profil przeglądarki.",
      hostedPluginBlocked: "Ta strona wtyczki jest zablokowana przez jej zasady bezpieczeństwa.",
      invalidUrl: "Tego adresu nie można otworzyć.",
      ownerDisconnected: "Utracono połączenie z właścicielem strony.",
      surface: {
        disabled: "Wbudowane przeglądanie jest wyłączone.",
        viewTargetsDisabled: "Cele przeglądarki są wyłączone.",
        hostLost: "Utracono połączenie z hostem przeglądarki.",
        adapterRecovering: "Ponowne łączenie z przeglądarką…",
        liveStateLost: "Utracono aktywną sesję przeglądarki.",
        unsupportedTarget: "Tego celu nie można otworzyć we wbudowanej przeglądarce.",
      },
    },
    devtools: {
      title: 'Diagnostyka',
      collapse: 'Zwiń diagnostykę',
      expand: 'Rozwiń diagnostykę',
      close: 'Ukryj diagnostykę',
      open: 'Pokaż diagnostykę',
      section: {
        console: 'Konsola',
                pageErrors: 'Błędy strony',
        network: 'Sieć',
        elements: 'Elementy',
        resources: 'Zasoby',
        storage: 'Pamięć',
        info: 'Informacje',
        performance: 'Wydajność',
      },
    },
  },

  streamPlayer: {
    status: {
      opening: 'Otwieranie strumienia…',
      playing: 'Na żywo',
      degraded: 'Obniżona jakość',
      reconnecting: 'Ponowne łączenie…',
      stopped: 'Zatrzymano',
      unavailable: 'Strumień niedostępny',
      errorGeneric: 'Błąd strumienia',
      decoderUnavailable: 'Dekodowanie wideo jest niedostępne w tej przeglądarce.',
      preservingLastFrame: 'Wyświetlanie ostatniej klatki',
      permissionExpired: 'Uprawnienie wygasło',
      leaseExpired: 'Uprawnienie sterowania wygasło',
      lowBandwidth: 'Niska przepustowość',
      degradedCodec: 'Kodek w trybie obniżonej jakości',
    },
    actions: {
      requestKeyframe: 'Poproś o klatkę kluczową',
      lowerQuality: 'Obniż jakość',
    },
    controls: {
      readOnly: 'Tylko odczyt',
      controlling: 'Sterowanie',
      controlsUnavailable: 'Sterowanie niedostępne',
      controlsAvailable: 'Sterowanie dostępne',
    },
    renderer: {
      fallback: 'Renderer zapasowy',
    },
  },

  simulatorPreview: {
    picker: {
      title: 'Urządzenia',
      empty: 'Brak dostępnych urządzeń symulatora.',
    },
    status: {
      connecting: 'Łączenie z urządzeniem…',
      restoring: 'Przywracanie podglądu…',
    },
    availability: {
      available: 'Dostępne',
      degraded: 'Obniżona jakość',
      unavailable: 'Niedostępne',
      noDevices: 'Brak dostępnych urządzeń symulatora.',
      captureUnavailable: 'Przechwytywanie jest niedostępne dla tego urządzenia.',
      resourceUnavailable: 'Ten zasób symulatora jest niedostępny.',
      captureDegraded: 'Przechwytywanie ma obniżoną jakość.',
      streamDegraded: 'Jakość strumienia jest obniżona.',
      lastFrame: 'Wyświetlanie ostatniej dostępnej klatki.',
      streamUnavailable: 'Strumień jest niedostępny.',
      unavailableGeneric: 'Podgląd urządzenia jest obecnie niedostępny.',
    },
    toolbar: {
      heldByOther: 'Zajęte przez innego widza',
            heldByOtherWithHolder: ({ holder }: { holder: string }) => `Utrzymuje ${holder}`,
      acquireControl: 'Przejmij sterowanie',
      releaseControl: 'Zwolnij sterowanie',
      renewControl: 'Odnów sterowanie',
      snapshot: 'Zrzut',
            refreshFrame: 'Odśwież klatkę',
            quality: 'Jakość',
            reduceBandwidth: 'Zmniejsz przepustowość',
      fps: 'Limit 30 FPS',
      scale: 'Limit 1080 px',
      rotateLeft: 'Obróć w lewo',
      homeButton: 'Dom',
      backButton: 'Wstecz',
      recentButton: 'Ostatnie',
      volumeUp: 'Głośniej',
      volumeDown: 'Ciszej',
            moreControls: 'Więcej elementów sterowania urządzeniem',
    },
    sidebands: {
      title: 'Diagnostyka',
      logs: 'Logi',
      accessibilityTree: 'Dostępność',
      deviceConfig: 'Konfiguracja urządzenia',
      appMetadata: 'Metadane aplikacji',
      networkDiagnostics: 'Sieć',
      route: 'Trasa',
      captureHealth: 'Stan przechwytywania',
      refresh: 'Odśwież',
      empty: 'Brak danych.',
            open: 'Otwórz diagnostykę',
            close: 'Zamknij diagnostykę',
            refreshA11y: ({ section }: { section: string }) => `Odśwież ${section}`,
            arrayValue: ({ count }: { count: string }) => `${count} elementów`,
            objectValue: ({ count }: { count: string }) => `${count} pól`,
            valueUnavailable: 'Niedostępne',
            fields: {
                level: 'Poziom',
                message: 'Komunikat',
                route: 'Trasa',
                status: 'Stan',
                reason: 'Powód',
            },
    },
    diagnostics: {
      item: ({ reasonCode }: { reasonCode: string }) => `Diagnostyka: ${reasonCode}`,
    },
  },

  browserDiagnostics: {
    previewProxy: {
      title: 'Diagnostyka podglądu',
      status: {
        available: 'Dostępne',
        stale: 'Nieaktualne',
        unavailable: 'Niedostępne',
      },
      fidelity: {
        previewProxy: 'Proxy podglądu',
        unavailable: 'Niedostępne',
        cdp: 'CDP',
        injectedPage: 'Wstrzyknięta strona',
        nativeCallback: 'Natywny callback',
        streamFrame: 'Klatka strumienia',
      },
      activeFlows: ({ count }: { count: string }) => `${count} aktywnych przepływów`,
      attributionAllViews: 'Ruch dla tego podglądu, wszystkie widoki',
      staleNotice: 'Diagnostyka jest nieaktualna; połącz ponownie, aby pobrać nową migawkę.',
      unavailableReason: ({ reasonCode }: { reasonCode: string }) => `Diagnostyka niedostępna: ${reasonCode}`,
      networkEmpty: 'Nie przechwycono jeszcze ruchu podglądu.',
      familyAvailable: ({ family }: { family: string }) => `${family}: dostępne`,
      familyUnavailable: ({ family }: { family: string }) => `${family}: niedostępne`,
      httpFlow: ({ method, path, statusCode }: { method: string; path: string; statusCode: string }) => `${method} ${path} - ${statusCode}`,
      webSocketFlow: ({ subprotocol }: { subprotocol: string }) => `WebSocket - ${subprotocol}`,
      tunnelFlow: ({ flowId }: { flowId: string }) => `Tunel ${flowId}`,
      flowBytes: ({ bytesIn, bytesOut }: { bytesIn: string; bytesOut: string }) => `Wejście ${bytesIn} B / wyjście ${bytesOut} B`,
      flowMessages: ({ messagesIn, messagesOut }: { messagesIn: string; messagesOut: string }) => `Wiadomości ${messagesIn}/${messagesOut}`,
    },
    host: {
      title: 'Diagnostyka przeglądarki',
      eventCount: ({ count }: { count: string }) => `${count} zdarzeń diagnostycznych`,
      untrustedNotice: 'Diagnostyka wstrzyknięta może zostać zmieniona przez stronę i ma niższą wierność.',
      untrustedEvent: 'Niezaufane zdarzenie wstrzyknięte',
      eventsEmpty: 'Nie przechwycono jeszcze diagnostyki przeglądarki.',
      eventTitle: ({ family, kind }: { family: string; kind: string }) => `${family} - ${kind}`,
            eventTitles: {
                pageError: 'Błąd strony',
                console: 'Komunikat konsoli',
            },
            eventKinds: {
                pageError: 'Błąd strony',
                consoleEntry: 'Wpis konsoli',
                network: 'Zdarzenie sieciowe',
                event: 'Zdarzenie',
            },
      eventSummaryUnavailable: 'Brak dostępnych metadanych',
      families: {
        console: 'Konsola',
                pageError: 'Błędy strony',
        elements: 'Elementy',
        resources: 'Zasoby',
        storage: 'Pamięć',
        performance: 'Wydajność',
        network: 'Sieć',
        pageInfo: 'Informacje o stronie',
                other: 'Diagnostyka',
            },
      detail: {
        keys: ({ count }: { count: string }) => `Klucze (${count})`,
        entries: ({ count }: { count: string }) => `Zasoby (${count})`,
      },
      fields: {
        method: 'Metoda',
        status: 'Stan',
        url: 'URL',
        duration: 'Czas',
        requestSize: 'Żądanie',
        responseSize: 'Odpowiedź',
        socket: 'Gniazdo',
        state: 'Stan',
        framesSent: 'Wysłane ramki',
        framesReceived: 'Odebrane ramki',
        bytesSent: 'Wysłane bajty',
        bytesReceived: 'Odebrane bajty',
        messages: 'Wiadomości',
        protocol: 'Protokół',
        selector: 'Selektor',
        backendNode: 'Węzeł backendu',
        rect: 'Prostokąt',
        accessibleName: 'Nazwa dostępności',
        storageType: 'Typ pamięci',
        keyCount: 'Klucze',
        truncated: 'Obcięte',
        level: 'Poziom',
        arguments: 'Argumenty',
        message: 'Wiadomość',
        serviceWorker: 'Worker usługi',
        webgl: 'Stan WebGL',
        webrtc: 'Stan WebRTC',
        nodeCount: 'Węzły',
        elementCount: 'Elementy',
        maxDepth: 'Maks. głębokość',
        readyState: 'Stan gotowości',
        lcp: 'LCP',
        cls: 'CLS',
        inp: 'INP',
        fcp: 'FCP',
        longTasks: 'Długie zadania',
        longTaskTime: 'Czas długich zadań',
        responseEnd: 'Koniec odpowiedzi',
        domContentLoaded: 'DOM gotowy',
        loadEventEnd: 'Koniec ładowania',
        type: 'Typ',
      },
      interaction: {
        title: 'Diagnostyka interaktywna',
        enabled: 'Diagnostyka interaktywna włączona',
        disabled: 'Diagnostyka interaktywna wyłączona',
        unavailable: ({ reasonCode }: { reasonCode: string }) => `Diagnostyka interaktywna niedostępna: ${reasonCode}`,
        ownerOnly: 'Tylko właściciel sesji może włączyć diagnostykę interaktywną.',
        enable: 'Włącz interakcję',
        disable: 'Wyłącz interakcję',
        startPicker: 'Wybierz element',
        cancelPicker: 'Anuluj wybieranie',
        pickerActive: 'Wybieranie elementu aktywne',
        pickerUnavailable: 'Wybieranie elementu niedostępne',
        eval: {
            title: 'Konsola',
            placeholder: 'Oceń wyrażenie',
            run: 'Uruchom',
            empty: 'Nie oceniono jeszcze żadnych wyrażeń.',
            resultLabel: 'Wynik',
            statusPending: 'Ocenianie…',
            statusCompleted: 'Zakończono',
            statusFailed: 'Niepowodzenie',
            statusTimedOut: 'Przekroczono czas',
            statusBlocked: 'Zablokowano',
            statusDegraded: 'Kolektor zdegradowany',
            error: ({ reasonCode }: { reasonCode: string }) => `Błąd: ${reasonCode}`,
            expand: 'Rozwiń',
            collapse: 'Zwiń',
            loading: 'Ładowanie właściwości…',
            noProperties: 'Brak właściwości.',
            propertiesFailed: ({ reasonCode }: { reasonCode: string }) => `Właściwości niedostępne: ${reasonCode}`,
        },
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
        profiles: "Profile",
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
        selectProfile: ({ profile }: { profile: string }) => `Wybierz profil ${profile}`,
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
        detailSearchPlaceholder: 'Szukaj powierzchni',
        noResults: 'Żadne akcje nie pasują do bieżącego wyszukiwania.',
        noTargetsMatch: 'Żadne powierzchnie nie pasują do bieżącego wyszukiwania.',
        noDescription: 'Opis nie jest jeszcze dostępny.',
        requireApproval: 'Wymagaj zatwierdzenia',
        invalidActionTitle: 'Nie znaleziono akcji',
        invalidActionSubtitle: 'Ta akcja nie jest już dostępna w tej wersji.',
        configureActionAccessibilityLabel: 'Skonfiguruj akcję',
        approvalHelpTitle: 'Tryby zatwierdzania',
        approvalHelpBody: '„Najpierw zapytaj” pokazuje potwierdzenie przed uruchomieniem tej akcji z tej powierzchni. „Dozwolone” pozwala uruchamiać akcję z tej powierzchni bez prośby o zatwierdzenie.',
        toolExposure: {
            title: 'Ekspozycja narzędzia',
            footer: 'Określa, czy obsługiwane akcje pojawiają się jako narzędzia bezpośrednie, czy są dostępne tylko przez odkrywanie akcji.',
            subtitle: 'Steruje rejestracją narzędzia bezpośredniego dla tej powierzchni.',
            disabledSubtitle: 'Włącz tę powierzchnię przed zmianą ekspozycji narzędzia.',
            options: {
                default: {
                    subtitle: 'Użyj domyślnego ustawienia produktu dla tej powierzchni.',
                },
                defaultDiscoverableOnly: {
                    title: 'Użyj domyślnego (tylko odkrywalne)',
                },
                defaultDirect: {
                    title: 'Użyj domyślnego (narzędzie bezpośrednie)',
                },
                discoverableOnly: {
                    title: 'Tylko odkrywalne',
                    subtitle: 'Dostępne przez odkrywanie akcji bez dodawania narzędzia bezpośredniego.',
                },
                direct: {
                    title: 'Narzędzie bezpośrednie',
                    subtitle: 'Zarejestruj tę akcję jako narzędzie wywoływane bezpośrednio.',
                },
            },
        },
        spawnPolicy: {
            title: 'Zasady tworzenia sesji AI',
            footer: 'Te kontrolki dotyczą tylko sytuacji, gdy asystent w sesji Happier tworzy inną sesję. Odziedziczone ustawienia sesji nadrzędnej pozostają dozwolone; zablokowane elementy odrzucają jawne nadpisania czytelnym błędem.',
            toggles: {
                allowCustomDirectory: { title: 'Niestandardowy katalog', subtitle: 'Pozwala asystentowi wybrać inny katalog roboczy.' },
                allowCrossMachine: { title: 'Cele na innych maszynach', subtitle: 'Pozwala utworzyć sesję na innej dostępnej maszynie.' },
                allowBackendTargetOverride: { title: 'Cel backendu', subtitle: 'Pozwala wybrać innego agenta lub cel backendu.' },
                allowModelOverride: { title: 'Model AI', subtitle: 'Pozwala wybrać model zamiast dziedziczyć model nadrzędny.' },
                allowPermissionModeOverride: { title: 'Tryb uprawnień', subtitle: 'Pozwala na nadpisania równe lub niższe. Eskalacje nadal są odrzucane.' },
                allowAgentModeOverride: { title: 'Tryb agenta', subtitle: 'Pozwala wybrać tryb agenta lub sesji.' },
                allowConfigOptionOverrides: { title: 'Opcje konfiguracji', subtitle: 'Pozwala na opcje dostawcy, takie jak wysiłek rozumowania i workflow.' },
                allowProfileOverride: { title: 'Profil', subtitle: 'Pozwala wybrać profil po identyfikatorze bez ujawniania sekretów.' },
                allowEnvironmentVariables: { title: 'Zmienne środowiskowe', subtitle: 'Pozwala na jawne zmienne środowiskowe w nowych sesjach.' },
                allowConnectedServicesOverride: { title: 'Połączone usługi', subtitle: 'Pozwala wybrać powiązania połączonych usług przez referencję.' },
                allowMcpSelectionOverride: { title: 'Wybór MCP', subtitle: 'Pozwala nadpisać odziedziczony wybór serwerów MCP.' },
                allowTranscriptStorageOverride: { title: 'Przechowywanie transkrypcji', subtitle: 'Pozwala wybrać zgodny tryb przechowywania.' },
            },
            permissionCeiling: {
                title: 'Limit uprawnień',
                subtitle: 'Opcjonalny dodatkowy limit poniżej uprawnień wywołującego.',
                options: {
                    inherit: { title: 'Bez dodatkowego limitu', subtitle: 'Użyj uprawnień wywołującego jako jedynego limitu.' },
                    default: { title: 'Domyślny', subtitle: 'Wymaga normalnego zachowania zatwierdzania lub niższego.' },
                    acceptEdits: { title: 'Akceptuj edycje', subtitle: 'Pozwala na automatyczne edycje, ale nie pełne obejście.' },
                    bypassPermissions: { title: 'Omiń uprawnienia', subtitle: 'Pozwala na pełne obejście tylko wtedy, gdy wywołujący też je ma.' },
                    plan: { title: 'Planowanie', subtitle: 'Ogranicza tworzone sesje do planowania lub tylko odczytu.' },
                    'read-only': { title: 'Tylko odczyt', subtitle: 'Ogranicza tworzone sesje do zachowania tylko do odczytu.' },
                    'safe-yolo': { title: 'Bezpieczne yolo', subtitle: 'Pozwala na bezpieczne automatyczne zapisy w obszarze roboczym.' },
                    yolo: { title: 'Tryb yolo', subtitle: 'Pozwala do yolo tylko wtedy, gdy wywołujący też je ma.' },
                },
            },
        },
        status: {
            allowed: ({ count }: { count: number }) => `${count} dozwolone`,
            askFirst: ({ count }: { count: number }) => `${count} najpierw zapytaj`,
            off: ({ count }: { count: number }) => `${count} wyłączone`,
            unavailable: ({ count }: { count: number }) => `${count} niedostępne`,
        },
        modes: {
            off: 'Wyłączone',
            askFirst: 'Najpierw zapytaj',
            allowed: 'Dozwolone',
        },
        sections: {
            app: 'W aplikacji',
            voice: 'Głos',
            integrations: 'Integracje',
        },
        families: {
            browser: {
                title: 'Przeglądarka',
            },
            simulator: {
                title: 'Symulator',
            },
            localServices: {
                title: 'Usługi lokalne',
            },
            plugins: {
                title: 'Wtyczki',
            },
            session: {
                title: 'Sesje',
            },
            scm: {
                title: 'Kontrola wersji',
            },
            general: {
                title: 'Ogólne',
            },
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
            requiredByAgentPolicy: 'Zasady wymagają zatwierdzenia dla agenta. Ta akcja zawsze pyta najpierw.',
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
            pending_messages: {
                title: 'Oczekujące wiadomości',
                subtitle: 'Widoczne w kontrolkach oczekujących wiadomości pod transkrypcją sesji.',
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
            agent: {
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

            voice: {
                title: 'Głos',
                subtitle: 'Dostępne dla agenta głosowego jako wywoływalna powierzchnia.',
            },},
    },

settingsSession: {
	      sessionList: {
	          title: 'Lista sesji',
	          footer: 'Dostosuj, co jest widoczne w wierszu sesji.',
	          tagsTitle: 'Tagi sesji',
	          tagsEnabledSubtitle: 'Kontrolki tagów widoczne na liście sesji',
	          tagsDisabledSubtitle: 'Kontrolki tagów ukryte',
	          workingStatusAnimatedTextTitle: 'Animowany tekst pracy',
	          workingStatusAnimatedTextEnabledSubtitle: 'Zmieniaj czasowniki pracy podczas działania sesji',
	          workingStatusAnimatedTextDisabledSubtitle: 'Pokazuj stałą etykietę pracuje... podczas działania sesji',
	          narrowWorkingIndicatorTitle: 'Wąski wskaźnik pracy',
	          narrowWorkingIndicatorSpinnerSelectedSubtitle: 'Pokaż mały neutralny spinner w wąskich wierszach',
	          narrowWorkingIndicatorPulseSelectedSubtitle: 'Pokaż pulsującą kropkę w wąskich wierszach',
	          narrowWorkingIndicatorSpinnerTitle: 'Przędzarka',
	          narrowWorkingIndicatorSpinnerSubtitle: 'Kompaktowy neutralny spinner, gdy sesja pracuje.',
	          narrowWorkingIndicatorPulseTitle: 'Pulsująca kropka',
	          narrowWorkingIndicatorPulseSubtitle: 'Kompaktowa animowana kropka, gdy sesja pracuje.',
	          workingIndicatorTitle: 'Wskaźnik pracy',
	          workingIndicatorSpinnerSelectedSubtitle: 'Pokazuj mały neutralny spinner, gdy sesje pracują',
	          workingIndicatorPulseSelectedSubtitle: 'Pokazuj pulsującą kropkę, gdy sesje pracują',
	          workingIndicatorSpinnerTitle: 'Przędzarka',
	          workingIndicatorSpinnerSubtitle: 'Kompaktowy neutralny spinner, gdy sesja pracuje.',
	          workingIndicatorPulseTitle: 'Pulsująca kropka',
	          workingIndicatorPulseSubtitle: 'Kompaktowa animowana kropka, gdy sesja pracuje.',
	          identityDisplayTitle: 'Tożsamość sesji',
	          identityDisplaySubtitle: 'Wybierz, co pojawia się przed nazwami sesji na liście.',
	          identityDisplayAvatarTitle: 'Awatar',
	          identityDisplayAvatarSubtitle: 'Pokaż wygenerowany awatar każdej sesji.',
	          identityDisplayAgentLogoTitle: 'Logo agenta',
	          identityDisplayAgentLogoSubtitle: 'Pokaż logo agenta dla każdej sesji.',
	          identityDisplayNoneTitle: 'Brak',
	          identityDisplayNoneSubtitle: 'Ukryj znacznik tożsamości w wierszach sesji.',
	          headerIdentityDisplayTitle: 'Tożsamość nagłówka sesji',
	          headerIdentityDisplaySubtitle: 'Wybierz, co pojawia się przed tytułem wewnątrz sesji.',
	          headerIdentityDisplayAvatarTitle: 'Awatar',
	          headerIdentityDisplayAvatarSubtitle: 'Pokaż wygenerowany awatar sesji.',
	          headerIdentityDisplayAgentLogoTitle: 'Logo agenta',
	          headerIdentityDisplayAgentLogoSubtitle: 'Pokaż logo agenta obsługującego sesję.',
	          headerIdentityDisplayNoneTitle: 'Brak',
	          headerIdentityDisplayNoneSubtitle: 'Zacznij nagłówek od tytułu sesji.',
	          activeColorTitle: 'Aktywny kolor tytułu',
	          activeColorSubtitle: 'Wybierz, które sesje używają aktywnego koloru tytułu.',
	          activeColorActivityAndAttentionTitle: 'Aktywność i uwaga',
	          activeColorActivityAndAttentionSubtitle: 'Używaj aktywnego koloru dla sesji pracujących i wymagających uwagi.',
	          activeColorAttentionOnlyTitle: 'Tylko uwaga',
	          activeColorAttentionOnlySubtitle: 'Używaj aktywnego koloru tylko dla sesji wymagających Twojej uwagi.',
	          activeColorAllActiveTitle: 'Wszystkie aktywne sesje',
	          activeColorAllActiveSubtitle: 'Używaj aktywnego koloru dla każdej aktywnej i połączonej sesji.',
	          sectionModeTitle: 'Sekcje sesji',
	          sectionModeSubtitle: 'Wybierz, czy sesje są rozdzielane według aktywności.',
	          sectionModeActivitySelectedSubtitle: 'Oddziel sesje aktywne i nieaktywne',
	          sectionModeSingleSelectedSubtitle: 'Pokaż jedną sekcję sesji pogrupowaną według workspace',
	          sectionModeActivityTitle: 'Aktywne i nieaktywne',
	          sectionModeActivitySubtitle: 'Oddziel sesje według aktywności przed grupowaniem według workspace.',
	          sectionModeSingleTitle: 'Wszystkie sesje razem',
	          sectionModeSingleSubtitle: 'Użyj jednej sekcji sesji i zachowaj grupowanie według workspace dla każdej sesji.',
	          menuSections: {
	              sortBy: 'Sortuj według',
	              show: 'Pokaż',
	              folderSortMode: 'Kolejność folderów',

	              organize: 'Organizuj',},
	          orderingTitle: 'Kolejność sesji',
	          orderingSubtitle: 'Wybierz sposób sortowania sesji w ich grupach.',
	          orderingOptions: {
	              custom: 'Niestandardowa',
	              created: 'Utworzenie',
	              updated: 'Aktualizacja',
	          },
	          folderSortModeTitle: 'Kolejność folderów',
	          folderSortModeSubtitle: 'Wybierz, jak foldery i sesje współdzielą listę.',
	          folderSortModeFoldersFirstTitle: 'Najpierw foldery',
	          folderSortModeFoldersFirstSubtitle: 'Grupuj foldery nad sesjami w każdym obszarze roboczym lub folderze.',
	          folderSortModeMixedTitle: 'Mieszane',
	          folderSortModeMixedSubtitle: 'Pozwól folderom i sesjom zachować dokładną wspólną kolejność.',
	          folderSortModeMixedDisabledInDateModeSubtitle: 'Mieszana kolejność folderów jest dostępna w trybie niestandardowym.',
	          attentionPromotionModeTitle: 'Sesje wymagające uwagi',
	          attentionPromotionModeSubtitle: 'Wybierz, gdzie pojawiają się sesje czekające na Ciebie lub gotowe do przeglądu',
	          attentionPromotionModeOffTitle: 'Zostaw w zwykłym miejscu',
	          attentionPromotionModeOffSubtitle: 'Zachowaj listę dokładnie według grup i sortowania',
	          attentionPromotionModeGlobalTitle: 'Grupuj u góry',
	          attentionPromotionModeGlobalSubtitle: 'Pokaż jedną sekcję uwagi nad resztą',
	          attentionPromotionModeWithinGroupsTitle: 'Przenieś na górę bieżącej grupy',
	          attentionPromotionModeWithinGroupsSubtitle: 'Zachowaj sesje w ich folderze lub obszarze roboczym',
	          attentionStandingDefaultTitle: 'Zatrzymuj sesje w sekcji Wymaga uwagi',
	          attentionStandingDefaultEnabledSubtitle: 'Każda sesja zostaje, dopóki jej nie usuniesz',
	          attentionStandingDefaultDisabledSubtitle: 'Zatrzymuj sesje pojedynczo',
	          attentionStandingDefaultUnavailableSubtitle: 'Najpierw wybierz umiejscowienie w Sesje wymagające uwagi',
	          workingPlacementModeTitle: 'Pracujące sesje',
	          workingPlacementModeSubtitle: 'Wybierz, gdzie pojawiają się sesje, które właśnie pracują',
	          workingPlacementModeOffTitle: 'Zostaw w zwykłym miejscu',
	          workingPlacementModeOffSubtitle: 'Zachowaj pracujące sesje dokładnie według grup i sortowania',
	          workingPlacementModeGlobalTitle: 'Grupuj u góry',
	          workingPlacementModeGlobalSubtitle: 'Pokaż sekcję pracy pod sesjami wymagającymi uwagi',
	          workingPlacementModeWithinGroupsTitle: 'Przenieś na górę bieżącej grupy',
	          workingPlacementModeWithinGroupsSubtitle: 'Zachowaj pracujące sesje w ich folderze lub obszarze roboczym',
	          workspacePathDisplayTitle: 'Nazwy obszarów roboczych',
	          workspacePathDisplayNameSelectedSubtitle: 'Domyślnie pokazuj nazwę ostatniego folderu',
	          workspacePathDisplayPathSelectedSubtitle: 'Pokazuj pełną ścieżkę obszaru roboczego',
	          workspacePathDisplayName: 'Nazwa folderu',
	          workspacePathDisplayNameDescription: 'Użyj ostatniego segmentu ścieżki, chyba że zmieniono nazwę obszaru roboczego.',
	          workspacePathDisplayPath: 'Pełna ścieżka',
	          workspacePathDisplayPathDescription: 'Użyj sformatowanej ścieżki obszaru roboczego, chyba że zmieniono jego nazwę.',
	          workspaceFaviconsTitle: 'Favikony obszarów roboczych',
	          workspaceFaviconsEnabledSubtitle: 'Pokazuj wykryte favikony projektu obok nazw obszarów roboczych',
	          workspaceFaviconsDisabledSubtitle: 'Ukryj favikony projektu w nagłówkach obszarów roboczych',
	          workspaceMachineSubtitlesTitle: 'Nazwy maszyn',
	          workspaceMachineSubtitlesEnabledSubtitle: 'Pokazuj nazwę maszyny pod nazwami obszarów roboczych, gdy jest potrzebna',
	          workspaceMachineSubtitlesDisabledSubtitle: 'Ukryj nazwy maszyn w nagłówkach obszarów roboczych',

	          folderTreeView: "Widok drzewa folderów",},
	      mobileWorkspaceExperience: {
	          groupTitle: 'Mobilny obszar roboczy',
	          groupFooter: 'Określa sposób organizacji ekranów sesji na telefonach.',
	          title: 'Tryb kokpitu',
	          subtitle: 'Wybierz układ telefonu używany w sesjach.',
	          options: {
	              cockpitTitle: 'Kokpit',
	              cockpitSubtitle: 'Użyj dolnych kart dla czatu, plików, Git, kart i terminala.',
	              classicTitle: 'Klasyczny',
	              classicSubtitle: 'Użyj poprzedniego układu ekranu sesji.',
	          },
	      },
	      input: {
	          title: 'Wygląd wprowadzania',
	          footer: 'Skonfiguruj wygląd paska wprowadzania agenta.',
	      },
          detailedBehavior: { title: 'Szczegółowe zachowanie sesji', footer: 'Otwórz osobne strony dla kompozytora, limitów dostawcy, wznawiania i terminala.' },
          rootGroups: {
              launchDefaults: { title: 'Domyślne ustawienia nowej sesji', footer: 'Wybierz, jak rozpoczynają się nowe sesje i które wybory są zapamiętywane.' },
              listOrganization: { title: 'Organizacja listy sesji', footer: 'Kontroluj kolejność, grupowanie, sekcje, nieaktywne sesje i domyślny panel na komputerze.' },
              rowDetails: { title: 'Szczegóły wierszy sesji', footer: 'Wybierz, które etykiety i szczegóły wizualne pojawiają się w każdym wierszu sesji.' },
              activitySignals: { title: 'Sygnały aktywności i stanu', footer: 'Kontroluj, jak wyróżniane są sesje aktywne, pracujące i wymagające uwagi.' },
              mobileLayout: { title: 'Układ sesji na telefonie', footer: 'Wybierz układ telefonu używany wewnątrz sesji.' },
              agentPersonalization: { title: 'Instrukcje promptu dla agenta', footer: 'Kontroluj instrukcje, które proszą agentów o nazywanie sesji i sugerowanie odpowiedzi.' },
          },
          composer: { title: 'Kompozytor i wysyłanie', entrySubtitle: 'Enter do wysyłania, historia, wygląd kompozytora i wysyłanie, gdy agent pracuje.' },
          providerLimits: { title: 'Limity i użycie dostawcy', entrySubtitle: 'Odzyskiwanie po limitach użycia i wskaźnik użycia obok kompozytora.' },
          resume: { title: 'Wznawianie i przekazanie', entrySubtitle: 'Wznawianie przez odtworzenie transkryptu i domyślne przenoszenie sesji między maszynami.' },
          runtime: { title: 'Środowisko i terminal', entrySubtitle: 'Tmux, okna Windows Terminal i zgodność Terminal Connect.' },
      banners: {
          title: 'Banery',
          footer: 'Banery nad polem wiadomości można zwinąć do plakietki stanu. Wybierz, czy ma to być zapamiętywane.',
          rememberVisibilityTitle: 'Zapamiętuj widoczność banerów',
          rememberVisibilitySubtitle: 'Zamknięte banery pozostają ukryte we wszystkich sesjach na tym urządzeniu.',
          resetHiddenTitle: 'Pokaż wszystkie ukryte banery',
          resetHiddenSubtitle: 'Wyczyść banery ukryte na tym urządzeniu.',
      },
      inputBehavior: {
          title: 'Zachowanie wprowadzania',
          footer: 'Skonfiguruj wysyłanie klawiszem Enter i zachowanie historii wiadomości.',
          enterToSendEnabledNativeSubtitle: 'Naciśnij Enter, aby wysłać',
      },
      windows: {
          title: 'Windows',
          defaultModeTitle: 'Domyślny tryb zdalnej sesji Windows',
          windowNameTitle: 'Nazwa okna Windows Terminal',
          windowNamePlaceholder: 'happier',
          windowNameHint: 'Sesje otwierane w Windows Terminal używają tego nazwanego okna, aby nowe sesje mogły pojawiać się jako karty.',
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
        pendingDrainModeTitle: "Przetwarzanie kolejki oczekujących",
        pendingDrainModeFooter:
          "Wybierz, czy agent pobiera jedną wiadomość przy każdej gotowości, czy grupuje całą kolejkę oczekujących.",
        pendingDrainMode: {
          oneAtATimeTitle: "Jedna wiadomość naraz",
          oneAtATimeSubtitle:
            "Przetwarzaj tylko następną oczekującą wiadomość za każdym razem, gdy agent jest gotowy.",
          drainAllTitle: "Opróżnij wszystkie oczekujące",
          drainAllSubtitle:
            "Przetwarzaj razem wszystkie wiadomości w kolejce przy następnej gotowości (starsze zachowanie).",
        },
        pendingDeliveryTimingTitle: "Czas kolejki oczekujących",
        pendingDeliveryTimingFooter:
          "Wybierz, kiedy można dostarczać wiadomości już oczekujące. Nowe wysyłki nadal używają powyższego trybu wysyłania.",
        pendingDeliveryTiming: {
          afterForegroundReadyTitle: "Po odpowiedzi głównej",
          afterForegroundReadySubtitle:
            "Dostarczaj wiadomości z kolejki, gdy główny krok jest gotowy, nawet jeśli praca w tle trwa dalej.",
          afterRuntimeIdleTitle: "Gdy cała aktywność jest bezczynna",
          afterRuntimeIdleSubtitle:
            "Trzymaj wiadomości w kolejce, aż główny krok będzie gotowy, a aktywność w tle będzie bezczynna.",
        },
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
        nonSteerablePromptTitle: 'Gdy wiadomość nie może sterować aktywną turą',
        nonSteerablePromptFooter: 'Zmiany trybu uprawnień oraz /clear lub /compact nie mogą zostać zastosowane w trakcie tury. Wybierz, co Happier robi z taką wiadomością, gdy agent jest zajęty.',
        nonSteerablePrompt: {
            onTitle: 'Pytaj za każdym razem',
            onSubtitle: 'Zaproponuj „Przerwij i wyślij teraz” lub „Dodaj do kolejki po turze”.',
            offTitle: 'Wyłączone (starsze zachowanie)',
            offSubtitle: 'Wysyłaj jak dotychczas, nawet jeśli zmiana nie może zostać zastosowana w trakcie tury.',
        },
      },
      usageLimitRecovery: {
        title: "Odzyskiwanie po limicie użycia",
        autoWaitTitle: "Automatycznie czekaj i wznów",
        autoWaitEnabledSubtitle: "Sesje z limitem użycia mogą czekać na reset i wznowić się automatycznie.",
        autoWaitDisabledSubtitle: "Pytaj przed oczekiwaniem na reset limitu użycia.",
        resumePromptTitle: "Prompt wznowienia",
        resumePromptStandardTitle: "Standardowy",
        resumePromptStandardSubtitle: "Wyślij normalny prompt kontynuacji, gdy odzyskiwanie wznawia sesję.",
        resumePromptOffTitle: "Wyłączony",
        resumePromptOffSubtitle: "Wznów bez wysyłania dodatkowego promptu kontynuacji.",
        resumePromptCustomTitle: "Wyślij własny prompt",
        resumePromptCustomSubtitle: "Po odzyskaniu wyślij własny prompt kontynuacji.",
        customResumePromptTitle: "Własny prompt kontynuacji",
        customResumePromptPlaceholder: "Kontynuuj od miejsca, w którym skończyłeś.",
      },
      providerUsageGauge: {
        title: "Użycie dostawcy",
        footer:
          "Steruje wskaźnikiem limitu obok pola wpisywania, gdy dostępne są wiarygodne dane użycia dostawcy.",
        visibilityTitle: "Pokaż wskaźnik użycia dostawcy",
        visibilityEnabledSubtitle:
          "Pokazuj pozostały limit dostawcy obok pola wpisywania, gdy jest dostępny.",
        visibilityHiddenSubtitle: "Ukryj limit dostawcy przy polu wpisywania.",
        windowTitle: "Okno wskaźnika",
        windowMostConstrainedTitle: "Najbardziej ograniczone",
        windowMostConstrainedSubtitle:
          "Pokazuj wiarygodne okno limitu z najmniejszym pozostałym limitem.",
        windowDailyTitle: "Dzienne",
        windowDailySubtitle: "Preferuj dzienne okno limitu.",
        windowWeeklyTitle: "Tygodniowe",
        windowWeeklySubtitle: "Preferuj tygodniowe okno limitu.",
        windowSessionTitle: "Sesja",
        windowSessionSubtitle: "Preferuj okno limitu bieżącej sesji.",
        windowPrimaryTitle: "Główne",
        windowPrimarySubtitle: "Preferuj główne okno limitu dostawcy.",
        windowSecondaryTitle: "Dodatkowe",
        windowSecondarySubtitle: "Preferuj dodatkowe okno limitu dostawcy.",
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
        messageTimestampsTitle: "Pokaż godzinę i datę pod wiadomościami",
        messageTimestampsSubtitle:
          "Wyświetlaj znacznik czasu każdej wiadomości użytkownika i asystenta pod wiadomością.",
        messageTimestamps: {
          hoverWebHiddenMobileTitle: "Po najechaniu w webie, ukryte na telefonie",
          hoverWebHiddenMobileSubtitle:
            "Pokazuj znaczniki czasu z akcjami wiadomości w webie i ukrywaj je na telefonie.",
          hoverWebAlwaysMobileTitle: "Po najechaniu w webie, zawsze na telefonie",
          hoverWebAlwaysMobileSubtitle:
            "Pokazuj znaczniki czasu z akcjami wiadomości w webie i zawsze pokazuj je na telefonie.",
          alwaysTitle: "Zawsze widoczne",
          alwaysSubtitle: "Zawsze pokazuj znaczniki czasu pod wiadomościami transkryptu.",
          neverTitle: "Nigdy",
          neverSubtitle: "Ukrywaj znaczniki czasu pod wiadomościami transkryptu.",
        },
        messageActions: {
          groupTitle: 'Akcje wiadomości',
          groupFooter: 'Skonfiguruj zaznaczanie wiadomości i akcje przekazywania w transkrypcie.',
          selectionEnabled: {
            title: 'Włącz zaznaczanie wiadomości',
            subtitle: 'Pokaż ikonę zaznaczania pod wiadomościami, aby kopiować lub przekazywać je zbiorczo',
          },
          sendToSessionEnabled: {
            title: 'Włącz wysyłanie do sesji',
            subtitle: 'Pokaż zbiorczą akcję wysyłania, która dodaje wybrane wiadomości do szkicu innej sesji',
          },
          template: {
            title: 'Szablon wysyłania do sesji',
            subtitle: 'Użyj {{MESSAGES}}, {{SELECTED_COUNT}} i {{SOURCE_SESSION_NAME}} jako symboli zastępczych',
            placeholder: '{{MESSAGES}}',
            warningMissingPlaceholder: 'Wskazówka: dodaj {{MESSAGES}}, aby określić, gdzie pojawią się wybrane wiadomości',
          },
          bulkCopyFormat: {
            title: 'Format kopiowania',
            subtitle: 'Jak formatować skopiowane wiadomości',
            markdownLabeled: 'Markdown z etykietami ról (zalecane)',
            plain: 'Zwykły tekst',
          },
        },
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
          jumpToBottomButtonNewActivityLabel: ({ count }: { count: number }) => `${count} ${count === 1 ? "nowy element aktywności" : "nowe elementy aktywności"}, skocz na dół`,
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
            streamingPartialOutputTitle: "Pokaż częściowy streaming",
            streamingPartialOutputSubtitle:
              "Gdy wyłączone, wiadomości asystenta pojawiają się dopiero po zakończeniu.",
            thinkingPulseStaleTitle: "Okno wygasania myślenia",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `Obecnie: ${value}ms`,
            thinkingPulseStalePromptTitle: "Okno wygasania myślenia (ms)",
            thinkingPulseStalePromptBody:
              "Ukryj aktywne myślenie po tym czasie bez aktualizacji.",
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
      sessionCreation: {
        title: "Modal nowej sesji",
        footer: "Wybierz, jak otwiera się modal nowej sesji i jak wypełniają go skróty projektu.",
        modalModeTitle: "Tryb modalu nowej sesji",
        modalModeSimpleTitle: "Prosty",
        modalModeSimpleSubtitle: "Otwiera kompaktowy modal z kompozytorem na pierwszym planie.",
        modalModeWizardTitle: "Kreator",
        modalModeWizardSubtitle: "Otwiera konfigurację krokową z oddzielnymi selektorami.",
        presentationGroupTitle: "Powierzchnia nowej sesji",
        presentationGroupFooter: "Wybierz, czy Nowa sesja otwiera się jako ekran routingu czy modal.",
        presentationModeTitle: "Prezentacja nowej sesji",
        presentationModeSubtitle: "Steruje trasą używaną podczas otwierania Nowej sesji.",
        presentationAutoTitle: "Automatycznie",
        presentationAutoSubtitle: "Używa domyślnej prezentacji modalnej na każdej platformie.",
        presentationScreenTitle: "Ekran",
        presentationScreenSubtitle: "Otwiera Nową sesję w głównym obszarze z kompozytorem przypiętym na dole.",
        presentationModalTitle: "Okno modalne",
        presentationModalSubtitle: "Otwiera Nową sesję nad bieżącą przestrzenią roboczą jako zamykalny modal.",
        wizardModeTitle: "Tryb kreatora",
        wizardModeEnabledSubtitle: "Otwiera konfigurację krokową z oddzielnymi selektorami.",
        wizardModeDisabledSubtitle: "Używa kompaktowego modalu z kompozytorem na pierwszym planie.",
        rememberLastProjectSelectionsTitle: "Pamiętaj ostatnie wybory sesji projektu",
        rememberLastProjectSelectionsEnabledSubtitle:
          "Skróty projektu używają ponownie maszyny, folderu, silnika, modelu i opcji najnowszej sesji.",
        rememberLastProjectSelectionsDisabledSubtitle:
          "Skróty projektu tylko wstępnie wybierają maszynę i folder projektu.",
        rememberLastEngineSelectionsTitle: "Pamiętaj ostatni model i opcje dla każdego silnika",
        rememberLastEngineSelectionsEnabledSubtitle:
          "Nowe sesje przywracają ostatni model, tryb i opcje silnika wybrane na tym koncie.",
        rememberLastEngineSelectionsDisabledSubtitle:
          "Nowe sesje używają wartości domyślnych, chyba że skrót projektu lub szkic podaje konfigurację.",
        wizardSettingsTitle: "Kreator nowej sesji",
        wizardSettingsSubtitle: "Wybierz, czy każdy selektor kreatora ma być listą czy menu rozwijanym.",
        wizardDispositionTitle: "Układ kreatora",
        wizardDispositionSubtitle: "Wybierz, które selektory kreatora są listami lub menu rozwijanymi.",
        wizardLayoutTitle: "Układ kreatora",
        wizardLayoutFooter: "Określa rozmieszczenie sekcji kreatora na szerokich ekranach.",
        wizardColumnsTitle: "Układ dwukolumnowy",
        wizardColumnsEnabledSubtitle: "Umieszcza powiązane selektory obok siebie na szerokich ekranach.",
        wizardColumnsDisabledSubtitle: "Układa wszystkie selektory kreatora w jednej kolumnie.",
        wizardPresentationTitle: "Układ selektorów kreatora",
        wizardPresentationFooter:
          "Auto zostawia krótkie sekcje jako listy i przełącza długie sekcje na przeszukiwalne menu rozwijane.",
        wizardPresentationAutoTitle: "Automat",
        wizardPresentationAutoSubtitle:
          "Pozwól Happier wybrać najlepszy układ dla ilości treści.",
        wizardPresentationListTitle: "Lista",
        wizardPresentationListSubtitle: "Pokaż wszystkie wiersze bezpośrednio w kreatorze.",
        wizardPresentationDropdownTitle: "Menu rozwijane",
        wizardPresentationDropdownSubtitle: "Pokaż kompaktowy wiersz otwierający pełny selektor.",
      },
          promptPersonalization: {
              title: 'Szybka personalizacja',
              footer: 'Wybierz, które wbudowane instrukcje Happier mają być dodawane do nowych sesji agenta. Nie powoduje to ukrycia opcji, które agent już wysłał.',
              askAgentToRenameSessionsTitle: 'Aktualizacje tytułów sesji',
              askAgentToRenameSessionsNeverTitle: 'Nigdy',
              askAgentToRenameSessionsNeverSubtitle: 'Nie monituj agentów o ustawienie tytułów sesji.',
              askAgentToRenameSessionsInitialTitle: 'Na początku sesji',
              askAgentToRenameSessionsInitialSubtitle: 'Monituj agentów o ustawienie krótkiego tytułu z pierwszej wiadomości użytkownika.',
              askAgentToRenameSessionsOngoingTitle: 'Kiedy zmieni się zadanie',
              askAgentToRenameSessionsOngoingSubtitle: 'Monituj agentów o ustawienie tytułów na początku sesji i po zmianie zadania.',
              askAgentToRenameSessionsInitialSelectedSubtitle: 'Na początku sesji agenci są proszeni o ustawienie tytułu.',
              askAgentToRenameSessionsOngoingSelectedSubtitle: 'Agenci są proszeni o aktualizację tytułów w przypadku zmiany zadania.',
              askAgentToRenameSessionsDisabledSubtitle: 'Agenci nie są proszeni o ustawienie tytułów; ręczna zmiana nazwy nadal działa.',
              askAgentToSuggestReplyOptionsTitle: 'Poproś agenta o zasugerowanie opcji odpowiedzi',
              askAgentToSuggestReplyOptionsEnabledSubtitle: 'Monit prosi agentów o zaproponowanie opcji szybkiej odpowiedzi, jeśli jest to przydatne.',
              askAgentToSuggestReplyOptionsDisabledSubtitle: 'Monit nie wymaga od agentów dodania opcji szybkiej odpowiedzi.',
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
          defaultStorage: {
              title: 'Domyślny typ sesji',
              footer: 'Wybierz, czy nowe sesje mają zaczynać jako sesje Happier, czy jako bezpośrednie sesje oparte na dostawcy.',
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
          requiresModelNotice: "Wybierz poniżej model podsumowania. Bez niego powtórka użyje tylko ostatnich wiadomości.",
          requiresExecutionRunsNotice: "Podsumowania wymagają uruchomień, które są wyłączone na tym koncie. Powtórka użyje tylko ostatnich wiadomości.",
        },
        recentMessagesTitle: "Ostatnie wiadomości do dołączenia",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "Limit seed (znaki)",
        maxSeedCharsPlaceholder: "50000",
        maxSeedCharsRange: ({ min, max }: { min: number; max: number }) => `Od ${min} do ${max} znaków. Liczba spoza tego zakresu zostanie zapisana jako najbliższa granica.`,
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
    windowsTerminalSubtitle: "Otwórz sesję jako kartę we współdzielonym oknie Windows Terminal.",
    console: "Konsola",
    shortConsole: "Konsola",
    consoleSubtitle: "Otwórz sesję w standardowym oknie konsoli Windows.",
  },

  settingsVoice: {
    ...voiceDiagnosticsTranslations.pl,
    intents: {
      dictation: { title: 'Dyktowanie', subtitle: 'Zamień jedną wypowiedź na tekst w polu wprowadzania.' },
      conversations: { title: 'Rozmowy głosowe', subtitle: 'Wybierz dostawcę i skonfiguruj jego główne ustawienia.' },
      privacy: { title: 'Prywatność i dane', subtitle: 'Sprawdź przetwarzanie przez dostawcę, udostępnianie kontekstu i historię głosu.', processingTitle: 'Przetwarzanie przez dostawcę' },
      advanced: { title: 'Zaawansowane', subtitle: 'Skonfiguruj interfejs Voice, maszynę wykonawczą i diagnostykę.' },
    },
    history: {
      title: 'Historia głosu',
      sectionTitle: 'Historia',
      sectionFooter: 'Przeglądaj lub usuwaj transkrypcje globalnych i bezkontekstowych rozmów głosowych.',
      entryTitle: 'Historia głosu',
      entrySubtitle: 'Wyszukuj, eksportuj lub czyść zapisane transkrypcje głosowe.',
      searchTitle: 'Przeszukaj wczytaną historię',
      searchFooter: 'Wyszukiwanie obejmuje wiadomości głosowe już odszyfrowane na tym urządzeniu.',
      searchPlaceholder: 'Szukaj transkrypcji lub dostawców',
      searchAccessibilityLabel: 'Przeszukaj historię głosu',
      actionsTitle: 'Działania historii',
      loading: 'Wczytywanie historii głosu…',
      emptyTitle: 'Brak historii głosu',
      emptyBody: 'Transkrypcje samodzielnych i globalnych rozmów głosowych pojawią się tutaj po zapisaniu.',
      noResultsTitle: 'Brak wyników we wczytanej historii',
      noResultsBody: 'Spróbuj innego wyszukiwania lub wczytaj starsze wiadomości.',
      loadOlderTitle: 'Wczytaj starsze wiadomości',
      loadOlderSubtitle: 'Odszyfruj poprzednią stronę historii głosu na tym urządzeniu.',
      loadOlderFooter: 'Starsze wiadomości pozostają na serwerze do czasu wczytania lub wyczyszczenia.',
      loadingOlder: 'Wczytywanie starszych wiadomości…',
      loadOlderFailed: 'Nie udało się wczytać starszej historii głosu.',
      exportTitle: 'Eksportuj historię głosu',
      exportSubtitle: 'Wczytaj pozostałą ograniczoną historię i zapisz ją jako JSON.',
      exporting: 'Przygotowywanie eksportu…',
      exportSucceeded: 'Eksport historii głosu jest gotowy.',
      exportFailed: 'Nie udało się wyeksportować historii głosu.',
      clearTitle: 'Wyczyść historię głosu',
      clearSubtitle: 'Usuń całą samodzielną historię głosu dla tego konta.',
      clearing: 'Czyszczenie historii głosu…',
      clearConfirmTitle: 'Wyczyścić historię głosu?',
      clearConfirmBody: 'Spowoduje to trwałe usunięcie całej samodzielnej historii głosu dla tego konta. Tej operacji nie można cofnąć.',
      clearConfirmAction: 'Wyczyść historię',
      clearSucceeded: 'Historia głosu została wyczyszczona.',
      clearActiveCall: 'Zakończ rozmowę głosową przed wyczyszczeniem historii głosu.',
      clearFailed: 'Nie udało się wyczyścić historii głosu.',
      errorTitle: 'Historia głosu jest niedostępna',
      errorBody: 'Happier nie mógł wczytać zaszyfrowanej historii tego konta. Sprawdź połączenie i spróbuj ponownie.',
      upgradeRequiredTitle: 'Do wczytania historii głosu wymagane jest uaktualnienie',
      upgradeRequiredBody: 'Ten serwer nie obsługuje formatu zaszyfrowanej historii używanego przez to konto. Zaktualizuj Happier na serwerze, a następnie wczytaj ponownie.',
      supersededTitle: 'Aktywne konto uległo zmianie',
      supersededBody: 'Żądanie zatrzymano, zanim mogło użyć innego konta. Wczytaj ponownie, aby bezpiecznie kontynuować.',
      retry: 'Spróbuj ponownie',
      roleYou: 'Ty',
      roleAssistant: 'Asystent',
    },
    dictation: {
      title: 'Dyktowanie',
      footer: 'Wybierz dostawcę zamiany mowy na tekst dla mikrofonu edytora. To ustawienie jest niezależne od Głosu konwersacyjnego, chyba że jawnie je połączysz.',
      provider: 'Dostawca zamiany mowy na tekst',
      providerSubtitle: 'Wybierz osobnego dostawcę dla Dyktowania albo jawnie użyj ustawień Głosu lokalnego.',
      sameAsLocal: 'Tak samo jak Głos lokalny',
      sameAsLocalSubtitle: 'Jawnie używaj wyboru zamiany mowy na tekst z Głosu lokalnego.',
      language: 'Język dyktowania',
      languageSubtitle: 'Opcjonalna wskazówka językowa używana tylko podczas Dyktowania.',
      readiness: {
        title: 'Gotowość dyktowania',
        footer: 'Kontrola odczytuje tylko zapisane ustawienia oraz bieżący stan maszyny i modelu. Nie otwiera mikrofonu, nie wysyła dźwięku ani nie kontaktuje się z dostawcą.',
        check: 'Sprawdź konfigurację',
        checkSubtitle: 'Pasywnie zweryfikuj wybraną konfigurację Dyktowania.',
        result: 'Stan konfiguracji',
        ready: 'Dyktowanie jest gotowe.',
        needsSetup: 'Konfiguracja jest niepełna. Sprawdź szczegóły wybranego dostawcy.',
        installing: 'Trwa instalowanie wymaganego modelu mowy.',
        incompatible: 'Wybrany dostawca nie jest zgodny z tą platformą lub konfiguracją.',
        unavailable: 'Nie udało się potwierdzić gotowości na podstawie bieżących danych lokalnych.',
      },
    },
    setupCheck: {
      title: 'Gotowość dostawcy',
      footer: 'Kontrola odczytuje tylko zapisane ustawienia i bieżące lokalne dane gotowości. Nie otwiera mikrofonu, nie uruchamia Głosu, nie wysyła dźwięku ani nie kontaktuje się z dostawcą.',
      check: 'Sprawdź konfigurację',
      checkSubtitle: 'Pasywnie sprawdź konfigurację wybranego dostawcy Głosu.',
      result: 'Stan konfiguracji',
    },
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
      openaiRealtime: "OpenAI Realtime",
      openaiRealtimeSubtitle: "Użyj zapisanego klucza API lub jawnie wybranego konta OpenAI",
      grokRealtime: "Grok Voice · BYOK",
      grokRealtimeSubtitle: "Użyj własnego klucza API xAI do głosu na żywo",
    },
    realtimeProviders: {
      ...voiceProviderPrivacyTranslations.pl,
      ...voiceRealtimeProviderSetupTranslations.pl,
      operationFailed: 'Nie udało się zaktualizować ustawienia. Spróbuj ponownie.',
      operationFailedUnsaved: 'Nie udało się zaktualizować ustawienia. Zmiany nie zostały zapisane.',
      operationFailedVoiceNotFound: 'Wybrany głos nie jest dostępny na połączonym koncie. Wybierz inny głos, a następnie uruchom tę akcję ponownie. Zmiany nie zostały zapisane.',
      operationFailedStage: ({ stage }: { stage: string }) => `Nieudany krok: ${stage}`,
      operationFailedStatus: ({ status }: { status: number }) => `Odpowiedź dostawcy: HTTP ${status}`,
      codex: {
        sectionTitle: "Konto Codex Live",
        accountTitle: "Globalne konto głosowe",
        accountSubtitle: "Wybierz dokładne konto lub grupę kont Połączonych usług używaną przez globalny Codex Voice. Głos bezpośredni zawsze używa otwartej sesji.",
        privacyDisclosure: "Dźwięk i rozmowa Codex Live są wysyłane z tego urządzenia do OpenAI przez WebRTC. Wybrana sesja Codex i konto Connected Services działają przez wybraną maszynę. OpenAI może otrzymywać ograniczony kontekst uruchomienia i sesji oraz delegowane wyniki Codex, aby rozmowa mogła być kontynuowana, a odpowiedzi odczytywane głosowo. Serwer i relay Happier nie przesyłają dźwięku Codex Live; daemon/app-server Happier nadal obsługuje sygnalizację, cykl życia sesji, delegowanie, narzędzia i kontrolę uprawnień. Mogą uczestniczyć przekaźniki sieciowe obsługiwane przez dostawcę. Codex lub OpenAI mogą przechowywać instrukcje deweloperskie, materiały rozmowy w czasie rzeczywistym i powiązane dane diagnostyczne w natywnym magazynie środowiska dostawcy zgodnie z zasadami wybranego konta i dostawcy; Happier nie usuwa ani nie przepisuje tych danych dostawcy.",
      },
    },
    ui: {
      title: "Powierzchnia glosowa",
      footer: "Opcjonalny feed zdarzen glosowych na ekranie (nie trafia do sesji).",
      activityFeedEnabled: "Wlacz feed aktywnosci glosowej",
      activityFeedEnabledSubtitle: "Pokazuj ostatnie zdarzenia glosowe na ekranie",
      activityFeedAutoExpandOnStart: "Automatycznie rozwin na starcie",
      activityFeedAutoExpandOnStartSubtitle: "Rozwijaj feed automatycznie po starcie glosu",
      orbEnabled: "Plywajaca kula glosu",
      orbEnabledSubtitle: "Pokaz przeciagalnego towarzysza glosu na tym urzadzeniu. Glos pozostaje dostepny z paska bocznego i pola tekstowego.",
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
          speed: {
            title: "Prędkość",
            subtitle: "0.7–1.2. Puste = domyślne.",
            promptTitle: "Prędkość (0.7–1.2)",
            promptBody:
              "Wpisz liczbę od 0.7 do 1.2. Zostaw puste, aby użyć domyślnego.",
            invalid: "Wpisz liczbę od 0.7 do 1.2.",
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
    externalCredentials: {
      ...voiceExternalCredentialApprovalTranslations.pl,
      apiKeyTitle: "Klucz API",
      promptTitle: "Połącz tego dostawcę głosu",
      promptDescription: "Wklej klucz API dostawcy. Zostanie zapisany na Twoim koncie i wysłany wyłącznie do punktu końcowego dostawcy zadeklarowanego przez wtyczkę; kod wykonawczy wtyczki go nie otrzymuje.",
      footer: "Zapisane klucze są przechowywane na Twoim koncie. Host przekazuje je do zadeklarowanego punktu końcowego dostawcy; kod wtyczki otrzymuje tylko wynik operacji.",
      rawPromptDescription: "Wklej klucz API dostawcy. Kod wtyczki w zadeklarowanym środowisku uruchomieniowym tego dostawcy otrzymuje wybrane poświadczenie bezpośrednio i może go użyć lub skopiować.",
      rawFooter: "Bezpośredni dostęp do poświadczenia pozwala kodowi wtyczki w zadeklarowanym środowisku uruchomieniowym bezpośrednio otrzymać wybrane poświadczenie oraz go użyć lub skopiować. Sprawdź dostęp przed użyciem.",
      rawCredentialAccessReviewBody: ({ pluginId, localId, credentialSlot, source, realm, phase }: { pluginId: string; localId: string; credentialSlot: string; source: string; realm: string; phase: string }) =>
        `Kod wtyczki dla ${pluginId}/${localId} otrzymuje wybrane poświadczenie ${source} dla ${credentialSlot} podczas ${phase} w środowisku ${realm}. Może go użyć lub skopiować.`,
      ready: "Klucz API zapisany",
      missing: "Wymagany klucz API",
      unavailable: "Konfiguracja poświadczeń jest niedostępna",
    },
    local: {
      ...voiceLocalCredentialTranslations.pl,
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
          machineCredentialRestrictionBody: "Zapisany klucz jest ograniczony do certyfikatu aplikacji Android i nie może być używany przez wybraną maszynę. Wprowadź osobny klucz API zgodny z maszyną; istniejąca zsynchronizowana wartość pozostanie bez zmian dla starszych klientów.",
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

        provider: {
          title: "Lokalna sieć neuronowa (beta)",
          subtitle:
            "STT przez daemon w wersji web; natywne pakiety strumieniowe Sherpa pozostają dostępne tam, gdzie są obsługiwane.",
          detail: "Sherpa STT",
        },},
      executionMachine: {
        groupTitle: "Lokalne środowisko głosowe",
        groupFooter: "Wybierz maszynę dla lokalnej mowy, zarządzania modelami i agenta głosowego.",
        title: "Maszyna wykonawcza",
        fallbackSubtitle: "Wybierz maszynę dla lokalnego głosu.",
        autoTitle: "Automatycznie",
        autoSubtitle: "Wybierz dostępną maszynę na podstawie ostatniej aktywności.",
        onlineLabel: "W Internecie",
        offlineLabel: "Nieaktywny",
        unknownMachineLabel: "Nieznana maszyna",
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

      localNeuralTts: {
        provider: {
          title: "Lokalny neuronowy (beta)",
          subtitle: "Neuralne TTS przez daemon w przeglądarce, z pakietami modelu na urządzeniu tam, gdzie są obsługiwane.",
          detail: "Lokalny neuronowy",
        },
      },
      openaiCompatStt: {
        provider: {
          title: "Endpoint zgodny z OpenAI",
          subtitle: "Użyj własnego serwera transkrypcji zgodnego z Whisper.",
          detail: "Punkt końcowy",
        },
      },
      openaiCompatTts: {
        provider: {
          title: "Endpoint zgodny z OpenAI",
          subtitle: "Użyj własnego lokalnego lub zdalnego serwera TTS zgodnego z OpenAI.",
          detail: "Punkt końcowy",
        },
      },
      deviceSttDetail: "Urządzenie",
      deviceTtsDetail: "Urządzenie",
      daemonInference: {
        execution: {
          title: "Lokalne wykonanie neuronowe",
          subtitle: "Wybierz, czy lokalny głos neuronowy działa na urządzeniu czy w daemonie.",
          options: { auto: "Automatycznie", device: "Urządzenie", daemon: "Daemon głosowy" },
          optionSubtitles: {
            auto: "Preferuje zalecaną ścieżkę wykonania dla tej platformy.",
            device: "Uruchamia lokalny głos neuronowy bezpośrednio na tym urządzeniu, gdy jest obsługiwany.",
            daemon: "Uruchamia lokalny głos neuronowy przez daemon voice-home.",
          },
        },
        service: {
          title: "Usługa inferencji daemona",
          subtitle: "Status usługi inferencji daemona voice-home.",
        },
        model: {
          title: "Pakiet modelu daemona",
          subtitleTts: "Zainstaluj i odśwież pakiet modelu TTS daemona.",
          subtitleStt: "Zainstaluj i odśwież pakiet modelu STT daemona.",
        },
        remove: {
          title: "Usuń pliki modelu daemona",
          subtitle: "Usuń pliki modelu po stronie daemona dla tego pakietu.",
          detailInstalled: "Usuń zainstalowane pliki daemona",
        },
        states: {
          loading: "Ładowanie…",
          machineUnreachable: "Daemon voice-home jest niedostępny.",
          unavailable: "Inferencja daemona jest niedostępna.",
          runtimeUnavailable: "Runtime daemona jest niedostępny.",
          relayDisabled: "Relay daemona jest wyłączony.",
          relayCapped: "Osiągnięto limit pojemności relay daemona.",
          requestTimeout: "Przekroczono limit czasu żądania do demona.",
          warming: "Rozgrzewanie modelu…",
          ready: "Gotowe",
          degraded: "Zdegradowane",
          idle: "Bezczynne",
          installing: "Instalowanie…",
          installed: "Zainstalowano",
          installError: "Instalacja nie powiodła się",
          notInstalled: "Nie zainstalowano",
          latencyDemoted: "Opóźnienie jest zdegradowane; w tej rozmowie używany jest głos urządzenia.",
          fallbackToDevice: "Powrót do głosu urządzenia.",
        },
      },
      models: {
          title: "Lokalne modele głosu",
          statusTitle: "Usługa modeli",
          footer: "Zainstaluj pakiety lokalnych modeli głosu na demonie głosowym i wybierz domyślny dla każdego typu.",
          sttGroupTitle: "Modele mowy na tekst",
          ttsGroupTitle: "Modele tekstu na mowę",
          defaultBadge: "Domyślny",
          defaultSubtitle: "Domyślny dla tego typu",
          installSubtitle: "Dotknij, aby zainstalować na demonie",
          setDefaultSubtitle: "Dotknij, aby ustawić jako domyślny",
          unknownSubtitle: "Status niedostępny",
          modelFiles: ({ size }: { size: string }) => `Pliki modelu: ${size}`,
          removeConfirmTitle: "Usuń pakiet modelu",
          removeConfirmBody: ({ name }: { name: string }) => `Usunąć pliki po stronie demona dla ${name}?`,
          state: {
              notInstalled: "Nie zainstalowano",
              downloading: "Pobieranie…",
              installed: "Zainstalowano",
              warming: "Rozgrzewanie…",
              ready: "Gotowe",
              evicted: "Wyładowano",
              error: "Instalacja nie powiodła się",
              unknown: "Status niedostępny",
          },
      },
      machineErrors: {
        mic_permission_denied: "Odmowa dostępu do mikrofonu.",
        mic_ended: "Wejście mikrofonu zakończyło się.",
        mic_plateau: "Dźwięk z mikrofonu przestał napływać.",
        transport_disconnect: "Połączenie głosowe zostało rozłączone.",
        provider_error: "Usługa głosowa zakończyła się błędem.",
        provider_auth_invalid: "Dodaj lub zaktualizuj klucz API wybranego dostawcy głosu.",
        audio_context_suspended: "Wyjście audio zostało wstrzymane.",
        stt_timeout: "Przekroczono limit czasu uruchamiania nasłuchu.",
        tts_failed: "Nie udało się wygenerować mowy.",
        turn_aborted: "Anulowano turę głosową.",
        authentication_required: "Połącz wybranego agenta, aby korzystać z funkcji głosowych.",
        session_unavailable: "Wybrana sesja nie jest już dostępna dla funkcji głosowych.",
        unsupported_runtime: "Zainstaluj środowisko wybranego agenta, aby korzystać z funkcji głosowych.",
        update_required: "Uaktualnij środowisko wybranego agenta, aby korzystać z funkcji głosowych.",
        feature_unavailable: "Funkcje głosowe są niedostępne dla środowiska wybranego agenta.",
      },},
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
      currentUiContextModeTitle: "Kontekst bieżącego interfejsu",
      currentUiContextModeSubtitle:
        "Wybierz, kiedy Voice może korzystać z ograniczonego kontekstu semantycznego aktywnego okna aplikacji Happier lub karty przeglądarki.",
      currentUiContextMode: {
        offTitle: "Wyłączone",
        offSubtitle: "Voice nie otrzymuje z tego klienta kontekstu bieżącego interfejsu ani poleceń kontekstowych.",
        onDemandTitle: "Na żądanie",
        onDemandSubtitle: "Gdy o to poprosisz, Voice może odczytać ograniczony kontekst semantyczny tego okna aplikacji lub karty przeglądarki. Polecenia kontekstowe nadal podlegają osobnym zabezpieczeniom.",
        automaticTitle: "Automatycznie",
        automaticSubtitle: "Voice otrzymuje też automatycznie podstawowe metadane nawigacji. Szczegółowy kontekst pozostaje dostępny na żądanie, a polecenia kontekstowe nadal podlegają osobnym zabezpieczeniom.",
      },
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
    updateShort: "Aktualizuj",
    updateAvailable: "Dostępna aktualizacja",
    pressToApply: "Naciśnij, aby zastosować aktualizację",
    whatsNew: "Co nowego",
    seeLatest: "Zobacz najnowsze aktualizacje i ulepszenia",
    nativeUpdateAvailable: "Dostępna aktualizacja aplikacji",
    tapToUpdateAppStore: "Naciśnij, aby zaktualizować w App Store",
    tapToUpdatePlayStore: "Naciśnij, aby zaktualizować w Sklepie Play",

    checkNowTitle: "Sprawdź teraz",
    checkNowSubtitle: "Sprawdź, czy są dostępne aktualizacje aplikacji.",
    lastCheckedTitle: "Ostatnio sprawdzono",},

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: string }) => `Wersja ${version}`,
    noEntriesAvailable: "Brak dostępnych wpisów dziennika zmian.",
  },

  releaseNotes: {
    viewFullChangelog: "Zobacz pełne informacje o wydaniu",
    mediaUnavailable: "Media niedostępne",
    storyDeck: {
      dragToDismiss: "Przeciągnij, aby zamknąć",
      letsGo: "Zaczynajmy!",
      slideAnnouncement: ({ title, current, total }: { title: string; current: number; total: number }) => `${title} - ${current} / ${total}`,
    },
    defaultTitle: "Co nowego",
    onboardingShowcase: {
                "title": "Witamy w Happier",
                "subtitle": "Twoi agenci AI wszędzie tam, gdzie pracujesz.",
                "cards": {
                    "welcome": {
                        "title": "Witamy w Happier",
                        "everywhereTitle": "Twoi agenci AI wszędzie tam, gdzie pracujesz",
                        "everywhereBody": "Claude Code, Codex, OpenCode, Pi i wiele więcej: na telefonie, tablecie, w przeglądarce albo na desktopie.",
                        "cockpitTitle": "Twój mobilny kokpit",
                        "cockpitBody": "Czat, pliki, Git, edytor, terminal. Wszystko, czego potrzebujesz, żeby budować i wysyłać kolejny projekt, pod ręką.",
                        "existingTitle": "Istniejące sesje, już dostępne",
                        "existingBody": "Każdą sesję Claude, Codex albo OpenCode uruchomioną na Twojej maszynie możesz otworzyć w Happier na żywo.",
                        "voiceTitle": "Asystent głosowy do wspólnego myślenia",
                        "voiceBody": "Zapytaj, co robią Twoi agenci, zatwierdzaj prośby o uprawnienia i wysyłaj wiadomości. Bez użycia rąk.",
                        "reviewTitle": "Przeglądaj diffy i zostawiaj komentarze",
                        "reviewBody": "Oznacz konkretne linie w plikach albo diffach, wybierz notatki do wysłania i przekaż je prosto agentowi.",
                        "subagentsTitle": "Subagenci między providerami",
                        "subagentsBody": "Uruchamiaj subagentów Codex z sesji Claude. Dziel pracę między agentów. Przekazuj wiadomości między sesjami.",
                        "tuisTitle": "Używaj swoich ulubionych TUI",
                        "tuisBody": "Uruchamiaj Claude Code, Codex albo OpenCode w ich natywnym terminalowym UI. Happier przechwytuje je i synchronizuje na wszystkie urządzenia.",
                        "inboxTitle": "Jedna skrzynka. Każda sesja.",
                        "inboxBody": "Wszystkie oczekujące zatwierdzenia, prośby o uprawnienia i nieprzeczytana aktywność, ze wszystkich sesji i maszyn, w jednym miejscu.",
                        "mcpTitle": "Jedna konfiguracja MCP. Każdy provider.",
                        "mcpBody": "Zdefiniuj serwery MCP raz. Działają we wszystkich backendach, także u providerów bez natywnego wsparcia MCP.",
                        "controlTitle": "Kolejkuj, steruj, fork, rollback",
                        "controlBody": "Kolejkuj wiadomości, gdy agent jest zajęty. Steruj trwającą turą. Forkuj z dowolnej wiadomości. Cofnij, gdy trzeba.",
                        "automationsTitle": "Automatyzacje",
                        "automationsBody": "Planuj cykliczne sesje agentów do monitorowania PR-ów, sprawdzania issue albo regularnego wykonywania dowolnych zadań.",
                        "accountsTitle": "Wiele kont i śledzenie limitów",
                        "accountsBody": "Połącz wiele kont Claude albo OpenAI: prywatne, służbowe, zespołowe. Monitoruj użycie każdego bezpośrednio w aplikacji.",
                        "promptsTitle": "Prompty, skills i profile",
                        "promptsBody": "Prompty wielokrotnego użytku, pakiety skills i profile backendów, synchronizowane między każdą sesją i urządzeniem.",
                        "privacyTitle": "Open-source. Szyfrowanie end-to-end. Self-hosting.",
                        "privacyBody": "Twoje sesje pozostają prywatne. Kod jest otwarty. Uruchom własny serwer jedną komendą.",
                        "petsTitle": "Poznaj Pets",
                        "petsBody": "Mały towarzysz na długie sesje. Przydatny? Może. Uroczy? Zdecydowanie."
                    ,
                        row1Title: "Sesje na każdym urządzeniu",
                        row1Body: "Wracaj tam, gdzie skończyłeś — telefon, tablet, web czy desktop.",
                        row2Title: "Działaj szybciej, dostarczaj wcześniej",
                        row2Body: "Synchronizacja w czasie rzeczywistym dba o terminal, agentów i pliki.",
                        row3Title: "Prywatność domyślnie",
                        row3Body: "Szyfrowanie end-to-end sprawia, że Twoja praca pozostaje Twoja.",},
                    "anywhere": {
                        "title": "Zacznij gdziekolwiek. Kontynuuj wszędzie.",
                        "wideTitle": "Zacznij gdziekolwiek.\nKontynuuj wszędzie.",
                        "body": "Uruchom sesję z dowolnego miejsca. Śledź ją na żywo, wysyłaj wiadomości i zatwierdzaj uprawnienia z telefonu, przeglądarki albo desktopu.",
                        "alt": "Abstrakcyjny obraz zastępczy dla sesji agentów między urządzeniami."
                    },
                    "terminalTuis": {
                        "title": "Kochasz terminal? My też!",
                        "wideTitle": "Kochasz terminal?\nMy też!",
                        "body": "Uruchamiaj Claude Code, Codex albo OpenCode w ich natywnym terminalowym UI. Śledź, wysyłaj wiadomości i zatwierdzaj uprawnienia z telefonu.",
                        "alt": "Abstrakcyjny obraz zastępczy dla synchronizacji terminalowego TUI."
                    },
                    "cockpit": {
                        "title": "Wszystko, czego potrzebujesz. Jednym stuknięciem.",
                        "wideTitle": "Wszystko, czego potrzebujesz.\nJednym stuknięciem",
                        "body": "Czat, pliki, Git, edytor, terminal. Rozmawiaj z agentem, przeglądaj i edytuj pliki, sprawdzaj diffy, zarządzaj gałęziami Git, otwieraj PR-y i terminal na żywo.",
                        "alt": "Abstrakcyjny obraz zastępczy dla mobilnego kokpitu."
                    ,
                        row1Title: "Tryb cockpit",
                        row1Body: "Śledź aktywnych agentów w skupionym widoku mobilnym.",
                        row2Title: "Przeskakuj jednym stuknięciem",
                        row2Body: "Przechodź między czatem, plikami, Git, terminalem i szczegółami bez układu desktopowego.",
                        row3Title: "Wysyłaj szybko",
                        row3Body: "Odpowiadaj z cockpit, gdy agent potrzebuje lekkiego popchnięcia.",},
                    "existingSessions": {
                        "title": "Istniejące sesje Claude, Codex, OpenCode? Już są.",
                        "body": "Przeglądaj dowolne sesje Claude, Codex albo OpenCode, aktualnie uruchomione lub nie.",
                        "alt": "Abstrakcyjny obraz zastępczy dla istniejących sesji providerów."
                    },
                    "voiceAssistant": {
                        "title": "Kolega, z którym możesz porozmawiać",
                        "wideTitle": "Asystent głosowy: kolega, z którym możesz porozmawiać",
                        "body": "Asystent głosowy monitoruje wszystkie uruchomione sesje. Omawiaj kolejne zmiany, zatwierdzaj uprawnienia i rób znacznie więcej bez użycia rąk.",
                        "alt": "Abstrakcyjny obraz zastępczy dla asystenta głosowego."
                    },
                    "reviewComments": {
                        "title": "Przeglądaj kod i zostawiaj komentarze",
                        "body": "Przeglądaj zmiany i diffy agenta. Oznacz dokładne linie, którymi chcesz się zająć. Wyślij je do agenta w bieżącej sesji albo nowej.",
                        "alt": "Abstrakcyjny obraz zastępczy dla komentarzy przeglądu."
                    ,
                        row1Title: "Komentuj dokładne linie",
                        row1Body: "Zostawiaj feedback bezpośrednio przy liniach plików i diffów.",
                        row2Title: "Wybierz, co wysłać",
                        row2Body: "Sprawdź, edytuj, odłącz lub dołącz komentarze przed wysłaniem do agenta.",
                        row3Title: "Zachowaj kontekst",
                        row3Body: "Wyślij uporządkowany kontekst review do bieżącej lub nowej sesji.",},
                    "subagents": {
                        "title": "Jedna sesja, subagenci wielu providerów",
                        "body": "Uruchamiaj Codex, Claude albo innych subagentów w dowolnej sesji. Wykorzystaj moc każdego z nich i pozwól im pracować razem w tej samej sesji.",
                        "alt": "Abstrakcyjny obraz zastępczy dla subagentów między providerami."
                    },
                    "inbox": {
                        "title": "Nigdy więcej nie zgub wątku",
                        "body": "Masz 10 sesji naraz i tracisz z oczu, co wymaga Twojej uwagi? Skrzynka pokazuje całą aktywność ze wszystkich sesji i maszyn.",
                        "alt": "Abstrakcyjny obraz zastępczy dla globalnej skrzynki."
                    },
                    "mcp": {
                        "title": "Jedna konfiguracja. Każdy provider.",
                        "wideTitle": "Jedna konfiguracja.\nKażdy provider.",
                        "body": "Zdefiniuj MCP raz w Happier, a zadziałają we wszystkich backendach, nawet tych bez natywnego wsparcia MCP. Zarządzaj skills, promptami i nie tylko!",
                        "alt": "Abstrakcyjny obraz zastępczy dla współdzielonej konfiguracji MCP."
                    },
                    "queue": {
                        "title": "Kolejkuj, steruj, fork, rollback",
                        "body": "Kolejkuj wiadomości, gdy agent jest zajęty. Steruj trwającą sesją. Forkuj z dowolnej wiadomości. Cofnij, jeśli coś pójdzie nie tak.",
                        "alt": "Abstrakcyjny obraz zastępczy dla narzędzi kontroli sesji."
                    },
                    "automations": {
                        "title": "Twój agent, według harmonogramu",
                        "body": "Planuj cykliczne sesje do monitorowania pull requestów, sprawdzania issue albo regularnego wykonywania dowolnych zadań.",
                        "alt": "Abstrakcyjny obraz zastępczy dla zaplanowanych automatyzacji agentów."
                    },
                    "accounts": {
                        "title": "Wiele kont i śledzenie limitów",
                        "body": "Połącz wiele kont OpenAI albo Claude. Monitoruj użycie i limity każdego bezpośrednio w aplikacji.",
                        "alt": "Abstrakcyjny obraz zastępczy dla połączonych kont i limitów."
                    },
                    "privacy": {
                        "title": "Open-source. Szyfrowanie end-to-end.",
                        "wideTitle": "Open-source.\nSzyfrowanie end-to-end.",
                        "body": "Twój kod, prompty i treść sesji są szyfrowane na urządzeniu, zanim trafią na jakikolwiek serwer. Prywatne z założenia. Otwarte domyślnie.",
                        "alt": "Abstrakcyjny obraz zastępczy dla prywatności i self-hostingu."
                    },
                    "pets": {
                        "title": "Nigdy nie czuj się sam. Poznaj Pets.",
                        "wideTitle": "Nigdy nie czuj się sam.\nPoznaj Pets.",
                        "body": "Mały towarzysz, który pomaga trzymać rytm między sesjami. Przydatny? Może. Uroczy? Zdecydowanie.",
                        "alt": "Abstrakcyjny obraz zastępczy dla Pets."
                    ,
                        row1Title: "Mały towarzysz",
                        row1Body: "Pomaga utrzymać rytm między sesjami.",
                        row2Title: "Śledzi aktywność",
                        row2Body: "Pokazuje aktywność sesji na desktopie i mobile.",
                        row3Title: "Przydatne? Może.",
                        row3Body: "Urocze? Zdecydowanie.",}
                ,
                    sourceControl: {
            title: "Zbuduj i wyślij",
            body: "Twórz i publikuj branche, zarządzaj remote, przeglądaj zmienione pliki i otwieraj pull requesty bez opuszczania Happier.",
            alt: "Abstrakcyjny obraz zastępczy kontroli źródeł.",
            row1Title: "Branche i publikowanie",
            row1Body: "Twórz branche, zarządzaj remote i pushuj zmiany bez opuszczania Happier.",
            row2Title: "Otwieraj pull requesty",
            row2Body: "Użyj istniejącego PR albo utwórz nowy z sesji.",
            row3Title: "Przeglądaj zmienione pliki",
            row3Body: "Skup się na wybranych plikach, gdy changeset robi się duży.",
        },
                    markdown: {
            title: "Płynniejsze streamowanie, bogatszy markdown",
            body: "Odpowiedzi streamowane są płynniejsze, a bogatszy Markdown ułatwia czytanie długich odpowiedzi, kodu, list i diagramów.",
            alt: "Abstrakcyjny obraz zastępczy renderowania Markdown.",
            row1Title: "Output nadąża",
            row1Body: "Odpowiedzi streamowane są płynniejsze, gdy agenci piszą.",
            row2Title: "Mocniejszy markdown",
            row2Body: "Bloki kodu, listy, tabele i długie odpowiedzi renderują się pewniej.",
            row3Title: "Czytelniejsza kompaktacja",
            row3Body: "Zdarzenia cyklu życia łatwiej śledzić w transkrypcie.",
        },
                    media: {
            title: "Obrazy bezpośrednio w transkrypcie",
            body: "Poproś Codex i wspieranych agentów o generowanie obrazów, a potem podglądaj wyniki bezpośrednio w Happier.",
            alt: "Abstrakcyjny obraz zastępczy generowanych mediów.",
            row1Title: "Generuj obrazy",
            row1Body: "Poproś Codex i wspieranych agentów o tworzenie obrazów.",
            row2Title: "Podgląd inline",
            row2Body: "Wygenerowane obrazy pojawiają się bezpośrednio w rozmowach Happier.",
            row3Title: "Zapisane z sesją",
            row3Body: "Media przechodzą tym samym pipeline sesji co Twoja praca.",
        },
                    desktop: {
            title: "Bardziej dopracowana aplikacja desktopowa",
            body: "Czystsza powłoka desktopowa, bardziej dopracowany chrome, bezpieczniejsze odstępy i status aktualizacji we właściwym miejscu.",
            alt: "Abstrakcyjny obraz zastępczy aplikacji desktopowej.",
            row1Title: "Czystszy chrome",
            row1Body: "Kontrole sidebara i status aktualizacji lepiej pasują do aplikacji.",
            row2Title: "Więcej skupienia",
            row2Body: "Okna i powierzchnie sesji mniej przeszkadzają.",
            row3Title: "Bezpieczniejszy układ",
            row3Body: "Odstępy desktopowe lepiej obsługują chrome platformy i ekrany z notchem.",
        },}
            },
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
    largePasteTitle: "Wkleić dużą zawartość do terminala?",
    largePasteDescription: "Ta wklejana zawartość jest duża i może uruchomić polecenia w terminalu. Sprawdź ją przed kontynuowaniem.",
    largePasteConfirm: "Wklej do terminala",
    settings: {
      locationTitle: "Lokalizacja wbudowanego terminala",
      rendererTitle: "Renderer terminala",
      rendererAuto: "Automatycznie",
      rendererAutoDescription: "Używaj dostępnego renderera xterm.js, chyba że renderer natywny spełnia wszystkie wymagania.",
      rendererXtermWebView: "xterm.js Widok internetowy",
      rendererXtermWebViewDescription: "Renderer zgodności z najlepszym wsparciem dostępności.",
      rendererNativeExperimental: "Natywny (eksperymentalny)",
      rendererNativeExperimentalDescription: "Preferuj Ghostty na iOS lub Termux na Androidzie, gdy wszystkie natywne bramki przejdą.",
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

    openNewTabA11y: "Otwórz nową kartę terminala",},

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

    // Unified onboarding redesign — BrandPanel (left pane / mobile hero)
    brandTaglineLine1: "Zacznij gdziekolwiek.",
    brandTaglineLine2: "Kontynuuj wszędzie.",
    brandSubTagline: "Jedno centrum kontroli dla każdego agenta kodującego — na każdym urządzeniu, które posiadasz.",
    brandTrustStrip: "SZYFROWANIE END-TO-END · OTWARTE ŹRÓDŁA · SELF-HOSTING",
    providerMarkRowAccessibilityLabel: "Obsługiwane agenty kodujące AI",

    // Unified onboarding redesign — welcome decision (right pane)
    welcomeQuestionTitle: "Witaj.",
    welcomeQuestionSubtitle: "Jesteś tu pierwszy raz?",
    welcomeQuestionBody: "Happier to centrum kontroli twoich agentów kodujących AI. E-mail nie jest potrzebny. Twoje konto to klucz prywatny generowany na tym urządzeniu.",

    welcomePrimaryButton: "Pierwszy raz tutaj — zaczynajmy",
    welcomePrimarySubtitle: "Jedno dotknięcie. Bez formularzy. Twój klucz zostaje tutaj.",

    welcomeSecondaryButton: "Zaloguj się — używam już Happier",
    welcomeSecondarySubtitle: "Zeskanuj kod QR albo wpisz swój klucz tajny",

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
    welcomeReturningTitle1: "Witaj z powrotem.",
    welcomeReturningTitle2: "Miło Cię widzieć.",
    welcomeReturningTitle3: "Dobrze, że jesteś.",
    welcomeReturningTitle4: "Witaj w domu.",
    welcomeReturningSubtitle1: "Wróćmy do pracy.",
    welcomeReturningSubtitle2: "Gotowy, by zacząć?",
    welcomeReturningSubtitle3: "Co dziś tworzymy?",

    // Returning-user buttons. For returning users we invert the visual
    // hierarchy: Login becomes the filled primary action (probability of
    // intent is high), Start fresh becomes the bordered secondary action.
    // "I already use Happier" is dropped from the login button title for
    // returning users because — they obviously do already use Happier.
    welcomeReturningLoginButton: "Zaloguj się — wróćmy do pracy",
    welcomeReturningStartFreshButton: "Zacznij od nowa — utwórz nowe konto",
    welcomeReturningStartFreshSubtitle: "Wygeneruj nowy klucz na tym urządzeniu.",

    // Welcome step footer links
    welcomeFooterRelay: "Samodzielny hosting?",
    welcomeFooterRelayAction: "Użyj własnego Relay",
    // Shown in place of welcomeFooterRelay when the active server is a
    // custom (non-Happier-Cloud) relay. The action below the label is the
    // relay's host (optionally with :port) followed by a small pencil
    // icon so the user can tap to edit. Long hostnames are truncated with
    // a tail-ellipsis to avoid colliding with the right-side Docs group.
    welcomeFooterRelayActiveLabel: "Twój relay:",
    welcomeFooterRelayEditAccessibility: "Zmień relay",
    welcomeFooterDocs: "Potrzebujesz pomocy?",
    welcomeFooterDocsAction: "Dokumentacja",
    welcomeFooterGithubLabel: "Repozytorium GitHub",
    welcomeFooterDiscordLabel: "Społeczność Discord",

    // Mobile brand hero CTA
    brandHeroGetStarted: "Zacznij",
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
	          welcomeTitle: 'Witamy w Happier',
		          welcomeBody: 'Happier łączy telefon i komputery przez Relay, dzięki czemu Twoje sesje podążają za Tobą wszędzie.',
		          welcomeBody2: 'Open source. Szyfrowanie end‑to‑end. Zero‑knowledge.',
		          welcomeBody3: 'Zrobione przez deweloperów, dla deweloperów.',
		          providersShowcaseLabel: 'Działa z:',
          letsStart: 'Zaczynajmy',
          scanQrCode: 'Skanuj kod QR',
          recommendedBadge: 'Polecane',
	          relayCloudTitle: 'Happier Cloud',
	          relayCloudSubtitle: 'Najprostszy hostowany Relay do szybkiego startu',
	          relayOnThisComputerTitle: 'Na tym komputerze',
	          relayOnThisComputerSubtitle: 'Uruchom Relay lokalnie na tym komputerze i dodaj Tailscale, aby telefon mógł się łączyć',
	          relayOnYourComputerTitle: 'Na Twoim komputerze',
	          relayOnYourComputerSubtitle: 'Uruchom Relay lokalnie na Twoim komputerze i dodaj Tailscale, aby telefon mógł się łączyć',
	          relayOnRemoteComputerTitle: 'Skonfiguruj Relay na zdalnym komputerze',
	          relayOnRemoteComputerSubtitle: 'Hostuj Relay na zdalnym komputerze przez SSH',
	          remoteRelayHostInstallTitle: 'Hostuj Relay na zdalnym komputerze',
	          relayAccessWizardTitle: 'Jak telefon ma łączyć się z tym Relay?',
	          relayAccessUrlTitle: 'URL Relay',
	          relayAccessUrlSubtitle: 'Wpisz adres URL, do którego telefon ma dostęp.',
	          relayAccessUrlBody: 'Może to być adres LAN, własna domena lub URL tunelu — ważne, aby telefon mógł go otworzyć.',
	          relayAccessCloudflareTitle: 'Tunel Cloudflare',
	          relayAccessCloudflareSubtitle: 'Udostępnij Relay przez Cloudflare Named Tunnel.',
	          relayAccessCloudflareBody: 'Utwórz lub wybierz Named Tunnel, a my skonfigurujemy przekierowanie do lokalnego Relay.',
          changeRelay: 'Zmień Relay',
          relayCustomUrlTitle: 'Istniejący Relay',
          relayCustomUrlSubtitle: 'Użyj adresu URL Relay, który już masz uruchomiony',
          authRestoreTitle: 'Przywróć lub dodaj to urządzenie',
          authRestoreSubtitle: 'Użyj kodu QR lub linku, aby połączyć to urządzenie',
          authSecretKeyTitle: 'Zaloguj się kluczem tajnym',
          authSecretKeySubtitle: 'Wpisz swój klucz tajny, aby zalogować się do Happier',
          authLostAccessTitle: 'Brak dostępu?',
          authLostAccessSubtitle: 'Zresetuj konto u swojego dostawcy tożsamości',
          webRelayHostHandoffTitle: 'Skonfiguruj Relay na tym komputerze',
          webRelayHostHandoffBody: 'Aby hostować Relay na tym komputerze, użyj aplikacji desktopowej lub CLI. Poprowadzimy Cię, a potem wkleisz tutaj URL Relay, aby kontynuować.',
          webDesktopOnlyTitle: 'Wymagana aplikacja desktopowa',
          webDesktopOnlyBody: 'Otwórz aplikację desktopową, aby skonfigurować ten komputer. Aplikacja webowa może pokazywać status, ale nie może zainstalować ani skonfigurować usługi w tle.',
          webDesktopOnlyPrimary: 'Mam URL Relay',
          webDesktopOnlyDesktopAppTitle: 'Kontynuuj tę konfigurację w aplikacji desktopowej',
          webDesktopOnlyDesktopAppSubtitle: 'Pobierz i otwórz Happier, aby skonfigurować ten komputer w trybie przewodnika.',
          webDesktopOnlyDesktopAppButton: 'Pobierz aplikację desktopową',
          webDesktopOnlyCliTitle: 'Zainstaluj CLI na tym komputerze',
          webDesktopOnlyCliSubtitle: 'Uruchom to raz w terminalu (Node nie jest wymagany).',
          handoffPlatformPosixLabel: 'macOS/Linux',
          handoffPlatformMacosLabel: 'macOS',
          handoffPlatformLinuxLabel: 'Linuksa',
          handoffPlatformWindowsLabel: 'Windows',
          orDividerLabel: 'lub',
          webDesktopOnlySetupCommandTitle: 'Skonfiguruj ten komputer za pomocą CLI',
          webDesktopOnlySetupCommandSubtitle: 'Uruchom jedną komendę, aby skonfigurować Relay, zalogować się (jeśli trzeba) i zainstalować usługę w tle.',
          webDesktopOnlySetupRemotePrereqsSubtitle: 'Uruchom jedną komendę, aby skonfigurować Relay i zalogować się przed konfiguracją zdalnego komputera przez SSH.',
          webDesktopHandoffDesktopAppOption: 'Korzystaj z aplikacji desktopowej (Polecane)',
          webDesktopHandoffDesktopAppSubtitle: 'Pobierz i otwórz Happier, aby hostować Relay z przewodnikiem.',
          webDesktopHandoffCliOption: 'Korzystaj z terminala (CLI)',
          webDesktopHandoffCliSubtitle: 'Uruchom kilka poleceń, aby hostować Relay, a następnie wklej tutaj wypisany URL Relay.',
          webDesktopOnlyRelayInstallTitle: 'Hostuj Relay na tym komputerze',
	          webDesktopOnlyRelayInstallSubtitle: 'To instaluje i uruchamia host Relay. Następnie wklej tutaj wyświetlony URL Relay.',
	          webDesktopOnlyRelayStatusTitle: 'Pobierz URL Relay',
	          webDesktopOnlyRelayStatusSubtitle: 'Uruchom to, aby wyświetlić URL Relay, a następnie wklej go tutaj.',
	          webDesktopOnlyOptionalNextTitle: 'Opcjonalnie: bezpieczny dostęp i dostawcy',
	          webDesktopOnlyOptionalNextBody: 'Po zainstalowaniu Happier otwórz Ustawienia → Bezpieczny dostęp (Tailscale), aby połączyć telefon, oraz Ustawienia → Dostawcy, aby zainstalować preferowane narzędzia.',
			          preAuthTitle: 'Gdzie działa Twój relay?',
	          preAuthBody: 'Twój relay przekazuje wiadomości między telefonem a komputerami. Wybierz, gdzie działa — możesz to później zmienić.',
          preAuthContinueHint: 'Po kontynuowaniu Happier cofnie Cię do logowania na wybranym Relay, a potem wróci tutaj, aby dokończyć konfigurację.',
	    currentRelayTitle: 'Bieżący serwer',
	    selectedRelayFooterLabel: 'Bieżący serwer',
	    selectedRelayFooterLine: ({ relay }: { relay: string }) => `Aktywny serwer: ${relay}`,
	    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `Aktywny Relay: ${relayUrl}`,
	    accountWillLiveOnRelay: ({ relayUrl }: { relayUrl: string }) => `Twoje konto będzie na ${relayUrl}.`,
	    savedRelaysTitle: 'Zapisane Relay',
        removeRelayConfirmTitle: 'Usunąć relay?',
        removeRelayConfirmBody: 'To usunie go z zapisanych relay na tym urządzeniu.',
	    customRelayUrlLabel: 'URL Relay',
    relayNameLabel: 'Nazwa Relay',
    addAndUseRelay: 'Dodaj Relay',
    changeRelayAction: 'Użyj innego adresu URL Relay',
          continueToAuth: 'Kontynuuj z wybranym Relay',
          continueWithLocalRelayAction: 'Kontynuuj z tym lokalnym Relay',
    postAuthTitle: 'Dokończ konfigurację tego komputera',
    postAuthBody: 'Jesteś zalogowany. Kontynuuj lokalny proces konfiguracji, aby ten komputer był gotowy dla wybranego Relay.',
    setupThisComputerTitle: 'Skonfiguruj ten komputer',
    controlPanelTitle: 'Podsumowanie gotowości',
    activeRelaySummaryTitle: 'Aktywny Relay',
    thisComputerSummaryTitle: 'Ten komputer',
    nextActionSummaryTitle: 'Następna akcja',
    thisComputerReady: 'Gotowe dla tego Relay',
    nextActionReady: 'Utwórz pierwszą sesję albo dodaj poniżej kolejny komputer.',
    thisComputerStages: {
        installToolsTitle: 'Zainstaluj narzędzia Happier',
        installToolsSubtitle: 'Zainstaluj lokalne narzędzia wiersza poleceń Happier potrzebne do skonfigurowania tego komputera.',
        installToolsReadySubtitle: 'Lokalne narzędzia Happier są już dostępne na tym komputerze.',
        installToolsDetails: 'Upewniamy się, że zarządzane środowisko uruchomieniowe Happier używane przez lokalną konfigurację jest dostępne, i synchronizujemy pasujące polecenie terminalowe dla tego kanału wydań.',
        installToolsChildTitle: 'Zainstaluj lokalne narzędzia wiersza poleceń Happier',
        useRelayTitle: 'Użyj tego Relay',
        useRelayAccountMismatchSubtitle: 'Przełącz się na konto powiązane z tym serwerem, zanim przejdziesz dalej.',
        useRelayNeedsAuthSubtitle: 'Zaloguj się lub utwórz konto, aby kontynuować konfigurację tego serwera.',
        useRelaySignedInSubtitle: 'Bieżące konto jest już zalogowane i gotowe do użycia z tym serwerem.',
        useRelayServerMismatchSubtitle: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `Serwer aplikacji: ${activeRelayUrl}. Usługa w tle: ${daemonRelayUrl}.`,
        useRelayConnectedSubtitle: ({ relayUrl }: { relayUrl: string }) => `Połączono z ${relayUrl}.`,
        useRelayMissingSubtitle: 'Wybierz lub dodaj serwer, aby kontynuować.',
        useRelayDetails: 'Potwierdzamy, którego Relay i którego konta ten komputer powinien używać przed rozpoczęciem lokalnej rejestracji.',
        backgroundServiceTitle: 'Usługa w tle',
        backgroundServiceDecisionSubtitle: 'Wybierz, jak ten komputer ma przejąć domyślną usługę w tle.',
        backgroundServiceRunningSubtitle: 'Usługa w tle jest zainstalowana i działa.',
        backgroundServiceInstalledSubtitle: 'Usługa w tle jest zainstalowana i wymaga uruchomienia.',
        backgroundServiceSubtitle: 'Zainstaluj i uruchom usługę w tle dla tego komputera.',
        backgroundServiceDetails: 'Usługa w tle utrzymuje ten komputer w gotowości do przyszłych uruchomień i automatycznie ponownie łączy go z wybranym Relay.',
        backgroundServiceReleaseChannelChildTitle: 'Rozwiąż własność kanału wydań',
        backgroundServiceConflictChildTitle: 'Rozwiąż istniejące konflikty usługi w tle',
        registerComputerTitle: 'Zarejestruj ten komputer',
        registerComputerDoneSubtitle: 'Ten komputer jest już zarejestrowany na Twoim koncie.',
        registerComputerNeedsAuthSubtitle: 'Zaloguj się przed zarejestrowaniem tego komputera.',
        registerComputerReconnectSubtitle: 'Po aktualizacji ustawień serwera połącz ten komputer ponownie.',
        registerComputerSubtitle: 'Połącz ten komputer z Twoim kontem na wybranym serwerze.',
        registerComputerDetails: 'Rejestrujemy ten komputer na Twoim koncie w wybranym Relay, aby lokalne sesje i funkcje działające w tle mogły poprawnie identyfikować tę maszynę.',
        footerHint: 'Obsługujemy za Ciebie niskopoziomowe kroki konfiguracji i pokazujemy tylko decyzje wymagające Twojego udziału.',
    },
    resumeIntentTitle: 'Kontynuuj konfigurację na tym komputerze',
          resumeIntentBody: 'Zaloguj się lub utwórz konto, aby kontynuować konfigurację tego komputera dla wybranego Relay.',
          openSetupAction: 'Skonfiguruj ten komputer',
          openSetupWizardAction: 'Otwórz kreator konfiguracji',
          openSetupWizardSubtitle: 'Użyj kreatora, aby skonfigurować Happier na komputerze.',
          setupNewMachineAction: 'Skonfiguruj nową maszynę',
          setupNewRelayAction: 'Skonfiguruj nowy relay',
          remoteHosts: {
              hostPickerTitle: 'Zdalny host',
              hostPickerSubtitle: 'Użyj zapisanego profilu SSH lub dodaj nowy.',
              newHostOption: 'Nowy host…',
              saveHostTitle: 'Zapisz ten host',
              saveHostSubtitle: 'Zapisz ten profil SSH na swoim koncie.',
              savePasswordTitle: 'Zapisz hasło',
              savePasswordSubtitle: 'Przechowuj hasło SSH zaszyfrowane w spoczynku.',
              savePrivateKeyTitle: 'Zapisz klucz prywatny',
              savePrivateKeySubtitle: 'Przechowuj klucz prywatny SSH zaszyfrowany w spoczynku.',
              privateKeyLabel: 'Klucz prywatny',
          },
          remoteSshChecklist: {
              planTitle: 'Sprawdź plan konfiguracji',
              planSubtitleMachine: 'Ten plan instaluje zdalne CLI, konfiguruje Relay i instaluje usługę w tle.',
              planSubtitleRelayHost: 'Ten plan instaluje zdalne CLI, konfiguruje Relay i instaluje runtime Relay.',
              executionTitle: 'Konfigurowanie zdalnej maszyny',
              executionSubtitle: 'Poniższa lista kontrolna aktualizuje się podczas uruchamiania zdalnego bootstrapu.',
              completeTitle: 'Zdalna maszyna gotowa',
              completeSubtitleMachine: 'Konfiguracja zdalnej maszyny zakończyła się pomyślnie.',
              trustHostTitle: 'Zaufaj hostowi SSH',
              trustHostSubtitle: 'Zweryfikuj odcisk palca zdalnej maszyny przed połączeniem.',
              trustHostDetails: 'Weryfikujemy klucz hosta SSH i odrzucamy nieoczekiwane odciski palca, chyba że jawnie im zaufasz.',
              installCliTitle: 'Zainstaluj Happier CLI',
              installCliSubtitle: 'Skopiuj Happier CLI na zdalną maszynę.',
              installCliDetails: 'Zdalna maszyna potrzebuje Happier CLI, aby można było wykonać resztę bootstrapu.',
              configureRelayTitle: 'Skonfiguruj Relay',
              configureRelaySubtitle: 'Skieruj zdalną maszynę na aktywny Relay i aplikację web.',
              configureRelayDetails: 'Zdalne CLI jest konfigurowane tak, aby łączyć się z aktywnym Relay i uwierzytelniać tę maszynę na Twoim koncie.',
              installDaemonTitle: 'Zainstaluj usługę w tle',
              installDaemonSubtitle: 'Utrzymuj Happier uruchomione w tle na zdalnej maszynie.',
              installDaemonDetails: 'Usługa w tle utrzymuje zdalną maszynę połączoną i gotową na przyszłe sesje.',
              startFailed: 'Nie udało się rozpocząć zdalnej konfiguracji SSH.',
              continueFailed: 'Nie udało się kontynuować zdalnej konfiguracji SSH.',
          },
          confirmSwitchRelayTitle: 'Zmień Relay?',
          confirmSwitchRelaySubtitle: 'Użyj tego Relay jako aktywnego. Możesz to zmienić później w Ustawieniach.',
          confirmSwitchRelayKeepTitle: 'Zachowaj obecny Relay',
          confirmSwitchRelayKeepSubtitle: 'Kontynuuj bez przełączania Relay na razie',
          confirmSwitchRelaySwitchTitle: 'Zmień na ten Relay',
          confirmSwitchRelaySwitchSubtitle: 'Na nowym Relay może być wymagane ponowne zalogowanie',
          confirmSwitchRelayWarning: 'Możesz zmienić relay później w Ustawienia → Relay.',
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
      "• Upewnij się, że komputer jest online\n• Uruchom happier daemon status, aby zdiagnozować\n• Czy używasz najnowszej wersji CLI? Uruchom happier self update",
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
      replacementRepair: {
        replaceWithMachine: "Oznacz jako zastąpioną",
        replaceWithMachineSubtitle: ({ machine }: { machine: string }) =>
          `Użyj ${machine} jako zastępstwa tej maszyny.`,
        chooseReplacementSubtitle: "Wybierz maszynę, która zastępuje tę maszynę.",
        pickerTitle: "Wybierz maszynę zastępczą",
        pickerCandidatesTitle: "Kwalifikujące się maszyny",
        confirmTitle: "Oznaczyć maszynę jako zastąpioną?",
        confirmBody: ({ machine }: { machine: string }) =>
          `Przyszłe uruchomienia i stare sesje tej maszyny będą używać ${machine}.`,
        confirmAction: "Zastąp",
        undo: "Cofnij zastąpienie",
        undoSubtitle: ({ machine }: { machine: string }) =>
          `Ta maszyna jest obecnie zastąpiona przez ${machine}.`,
        undoConfirmTitle: "Cofnąć zastąpienie maszyny?",
        undoConfirmBody:
          "Ta maszyna znów pojawi się jako cel uruchamiania, jeśli będzie dostępna.",
        undoAction: "Cofnij",
        error: "Nie udało się zaktualizować zastąpienia maszyny.",
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

    backgroundServiceModes: {
      generic: "usługa w tle",
      defaultFollowing: "domyślna usługa w tle",
      legacyPinned: "starsza przypięta usługa w tle",
    },
    backgroundServicePrompt: {
        targetServer: 'Serwer docelowy',
        targetReleaseChannel: 'Docelowy kanał wydania',
        existingServices: 'Istniejące usługi:',
        running: 'uruchomiona',
    },
    repairBackgroundServiceAction: "Napraw usługę w tle",
    repairBackgroundServiceProgressTitle: "Naprawianie usługi w tle",
    runtimeInventory: 'Inwentarz środowiska wykonawczego Happier',
    runtimeInventoryOverview: 'Przegląd',
    runtimeInventoryInstallations: 'Instalacje',
    runtimeInventoryServices: 'Usługi',
    runtimeInventoryWarnings: 'Ostrzeżenia',
    doctorRepairSummary: 'Podsumowanie naprawy',
    doctorRepairFindingsSummary: ({ total, warning, error, actionable }: {
        total: number;
        warning: number;
        error: number;
        actionable: number;
    }) => `${total} ustaleń • ${warning} ostrzeżeń • ${error} błędów • ${actionable} do naprawy`,
    localRelays: 'Lokalne Relaye',
    runtimeSummary: ({ cliVersion, daemonVersion, daemonRing, installationCount, serviceCount, warningCount }: {
        cliVersion: string;
        daemonVersion: string;
        daemonRing: string;
        installationCount: number;
        serviceCount: number;
        warningCount: number;
    }) => `CLI ${cliVersion} • daemon ${daemonVersion} (${daemonRing}) • ${installationCount} installations • ${serviceCount} services • ${warningCount} warnings`,
    transferExposure: {
      title: "Ekspozycja transferu",
      status: "Ekspozycja transferu",
      loopbackHttp: "Loopback (lokalnie)",
      tailscaleServeHttps: "Tailscale Serve (HTTPS)",
      stateUnknown: "Nieznane",
      stateDisabled: "Wyłączone",
      stateUnconfigured: "Nieskonfigurowane",
      stateApprovalNeeded: "Wymaga zatwierdzenia",
      stateInactive: "Skonfigurowane (nieaktywne)",
      stateStale: "Skonfigurowane (nieaktualne)",
      stateActive: "Aktywne",
      stateUnavailable: "Niedostępne",
    },},

  message: {
      sessionReferenceUnavailable: "Sesja niedostępna",
      sessionReferenceOpen: ({ name }: { name: string }) => `Otwórz sesję ${name}`,
    switchedToMode: ({ mode }: { mode: string }) =>
      `Przełączono na tryb ${mode}`,
    discarded: "Odrzucono",
    recoveredHistory: "Odzyskana historia",
    pluginAttribution: ({ pluginId }: { pluginId: string }) => `Z wtyczki ${pluginId}`,
    unknownEvent: "Nieznane zdarzenie",
    runtimeConfigOutcomeAppliesBeforeNextMessage: 'Zostanie zastosowane przed następną wiadomością',
    runtimeConfigOutcomeQueuedUntilReady: 'W kolejce do czasu gotowości',
    runtimeConfigOutcomeAlreadySet: 'Już ustawione',
    runtimeConfigOutcomeSessionMode: 'Tryb sesji',
    runtimeConfigOutcomeKeyModel: 'Modelka',
    runtimeConfigOutcomeKeyFallbackModel: 'Model zapasowy',
    runtimeConfigOutcomeKeyPermissionMode: 'Tryb uprawnień',
    runtimeConfigOutcomeKeyReasoningEffort: 'Wysiłek rozumowania',
    runtimeConfigOutcomeKeyMaxThinkingTokens: 'Budżet rozumowania',
    runtimeConfigOutcomeKeyLaunchOption: 'Opcja uruchomienia',
    runtimeConfigOutcomeRequiresRestart: 'Wymagany restart',
    runtimeConfigOutcomeRequiresInteractiveControl: 'Wymaga interakcji w terminalu',
    runtimeConfigOutcomeUnsupported: 'Nieobsługiwane',
    runtimeConfigOutcomeFailed: 'Nie udało się zastosować',
    contextCompactionStarted: "Kompaktowanie kontekstu...",
    contextCompactionCompleted: "Kontekst skompaktowany",
    contextCompactionFailed: "Kompaktowanie kontekstu nie powiodło się",
    contextCompactionCancelled: "Kompaktowanie kontekstu anulowane",
    contextCompactionPaused: "Kontekst skompaktowany; wyślij wiadomość, aby kontynuować",
    usageLimitUntil: ({ time }: { time: string }) =>
      `Osiągnięto limit użycia do ${time}`,
    connectedServiceAccountSwitch: ({ provider, from, to }: { provider: string; from: string; to: string }) =>
      `Konto ${provider} przełączono z ${from} na ${to}`,
    connectedServiceGroupAccountSwitch: ({ provider, group, from, to }: { provider: string; group: string; from: string; to: string }) =>
      `Grupę ${group} dla ${provider} przełączono z ${from} na ${to}`,
    connectedServiceSwitchGroupSelection: ({ group, profile }: { group: string; profile: string }) =>
      `grupa ${group} · ${profile}`,
    connectedServiceSwitchProfileSelection: ({ profile }: { profile: string }) => `profil ${profile}`,
    connectedServiceSwitchDeferred: 'Przełączenie konta odroczone do granicy tury',
    connectedServiceSwitchDeferredIdle: 'Przełączenie konta odroczone do chwili bezczynności sesji',
    connectedServiceSwitchDeferralCompleted: 'Przełączenie konta gotowe',
    connectedServiceSwitchDeferralCancelled: 'Przełączenie konta anulowane',
    connectedServiceSwitchDeferralSuperseded: 'Przełączenie konta zastąpione nowszym',
    agentStateSharingDegraded: 'Udostępnianie stanu dostawcy zastosowane częściowo',
    agentQuotaWait: ({ time }: { time: string }) =>
      `Oczekiwanie na reset limitu dostawcy o ${time}`,
    agentQuotaRecovered: "Limit dostawcy odzyskany",
    connectedServiceRuntimeAuthRecoveryRecovered: "Uwierzytelnianie dostawcy odzyskane",
    connectedServiceRuntimeAuthRecoveryCancelled: "Odzyskiwanie uwierzytelniania dostawcy anulowane",
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
    switchToRemote: "Przełącz na zdalny",
    detachLocalTerminal: "Odłącz terminal",
    directSessionTakeoverAvailable:
      "Ta bezpośrednia sesja jest dostępna na Twojej maszynie. Przejmij ją w Happier, aby sterować nią tutaj.",
    directSessionMachineOffline:
      "Ta bezpośrednia sesja jest obecnie niedostępna, ponieważ maszyna jest offline.",
    switchingToDirectTakeover: "Przejmowanie tej bezpośredniej sesji…",
    switchingToPersistedTakeover: "Przejmowanie i importowanie tej sesji…",
    takeOverDirect: "Przejmij",
    takeOverPersist: "Przejmij i importuj",
    directTakeoverDialogTitle: "Kontynuować tę bezpośrednią sesję w Happier?",
    directTakeoverDialogBody: "Wybierz, jak Happier ma przejąć kontrolę. Tryb bezpośredni nadal korzysta z transkryptu dostawcy. Import przenosi transkrypt do Happier.",
    directTakeoverDialogDirectTitle: "Przejmij",
    directTakeoverDialogDirectBody: "Steruj tą sesją w Happier bez importowania transkryptu do Happier.",
    directTakeoverDialogPersistTitle: "Przejmij i importuj",
    directTakeoverDialogPersistBody: "Zaimportuj transkrypt do Happier i kontynuuj z pełnym zestawem funkcji sesji Happier.",

    externalSessionTakeoverAvailable:
      "Ta zewnętrzna sesja jest gotowa do przejęcia w Happier.",
    externalSessionMachineOffline:
      "Ta zewnętrzna sesja jest obecnie niedostępna, ponieważ maszyna jest offline.",
    checkingExternalSessionTakeover: "Sprawdzanie opcji przejęcia…",
    externalSessionStatusUnavailable: "Happier nie może teraz sprawdzić tej sesji zewnętrznej. Sprawdź połączenie maszyny i spróbuj ponownie.",
    externalSessionProcessRunning: "Agent tej zewnętrznej sesji nadal wydaje się działać.",
    externalSessionRecheck: "Sprawdź ponownie",
    externalSessionTakeoverBlocked: "Happier nie może potwierdzić zatrzymania zewnętrznego Agenta. Zatrzymaj go w terminalu i spróbuj ponownie.",},

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
        yesForCommandName: "Tak, zezwól na każde pasujące polecenie w tej sesji",
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

      // Slash menu commands (Lane G)
      slash: {
          heading1: { label: 'Nagłówek 1', description: 'Duży nagłówek' },
          heading2: { label: 'Nagłówek 2', description: 'Średni nagłówek' },
          heading3: { label: 'Nagłówek 3', description: 'Mały nagłówek' },
          bulletList: { label: 'Lista punktowana', description: 'Lista nieuporządkowana' },
          orderedList: { label: 'Lista numerowana', description: 'Lista uporządkowana' },
          taskList: { label: 'Lista zadań', description: 'Lista z polami wyboru' },
          blockquote: { label: 'Cytat', description: 'Blok cytatu' },
          codeBlock: { label: 'Blok kodu', description: 'Blok kodu' },
          horizontalRule: { label: 'Separator', description: 'Linia pozioma' },
          groups: { headings: 'Nagłówki', lists: 'Listy', blocks: 'Bloki' },
      },

      // Link bubble (Lane H)
      linkBubble: {
          open: 'Otwórz',
          edit: 'Edytuj',
          unlink: 'Usuń link',
          cancel: 'Anuluj',
          save: 'Zapisz',
          inputPlaceholder: 'Wklej lub wpisz link…',
      },
    },

    // Accessibility labels for the rich markdown editor formatting toolbar.
    markdownEditorToolbar: {
      bold: "Pogrubienie",
      italic: "Kursywa",
      strikethrough: "Przekreślenie",
      code: "Kod w wierszu",
      heading1: "Nagłówek 1",
      heading2: "Nagłówek 2",
      heading3: "Nagłówek 3",
      bulletList: "Lista punktowana",
      orderedList: "Lista numerowana",
      taskList: "Lista zadań",
      blockquote: "Cytat",
      codeBlock: "Blok kodu",
      horizontalRule: "Separator",
      openLink: "Otwórz link",
      unlink: "Usuń link",
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
    noData: {
      title: "Brak danych o użyciu",
      subtitle: "Dane o użyciu pojawią się tutaj po pierwszej sesji.",
    },
    errors: {
      notAuthenticated: "Zaloguj się, aby zobaczyć użycie.",
      failedToLoad: "Nie udało się wczytać użycia.",
    },

    lastYear: "Ostatni rok",
    costMode: "Tryb kosztów",
    auto: "Automatycznie",
    reported: "Raportowane",
    estimated: "Szacowane",
    insights: "Analizy",
    activity: "Aktywność",
    timeline: "Oś czasu",
    leaders: "Liderzy",
    activeDays: "Aktywne dni",
    modelsTried: "Wypróbowane modele",
    favoriteModelChanges: "Zmiany ulubionego modelu",
    busiestWindow: "Najaktywniejsze okno",
    activityCalendarSubtitle: "Mapa cieplna kalendarza",
    mostActiveMonths: "Najaktywniejsze miesiące wybranego okresu",
    dailyActivity: "Dzienna aktywność w wybranym okresie",
    mostActiveWeekdays: "Najaktywniejsze dni tygodnia",
    mostActiveHours: "Najaktywniejsze godziny dnia",
    events: "zdarzeń",
    source: "Źródło",
    sessionUsage: "Użycie sesji",
    longestStreak: 'Najdłuższa passa',
    dailyRhythm: 'Rytm dobowy',
    eventsLabel: 'Zdarzenia',
    daysShort: ({ count }: { count: number }) => `${count}d`,
    updatedCaption: 'Zaktualizowano przed chwilą',
    whenYouWork: 'Kiedy pracujesz',
    periodTodayShort: 'Dziś',
    period7dShort: '7d',
    period30dShort: '30d',
    periodYearShort: '1r',
    busiestTag: 'najbardziej aktywna',
    vsPreviousPeriod: 'wobec poprzedniego okresu',
    workRhythm: 'Rytm pracy',
    weeks: "Tygodnie",
    messagesCaption: ({ count }: { count: number }) => `${count.toLocaleString()} wiadomości`,
    modelMix: {
        title: "Miks modeli w czasie",
        other: "Inne",
    },
    showAll: 'Pokaż wszystko',
    showLess: 'Pokaż mniej',
    exportCsv: 'Pobierz CSV',
    efficiency: {
        cacheHitRate: 'Współczynnik trafień w pamięć podręczną',
        cacheHitCaption: 'Udział tokenów wejściowych z pamięci podręcznej',
        costPerMtok: 'Koszt za Mtok',
        costPerMtokCaption: 'Efektywna łączna stawka za milion tokenów',
    },

    cacheSavings: 'Oszczędność pamięci podręcznej',
    banner: {
        lifetimeTokens: 'Tokeny łącznie',
        peakTokens: 'Tokeny szczytowe',
        tokenActivity: 'Aktywność tokenów',
        daily: 'Dziennie',
        weekly: 'Tygodniowo',
        cumulative: 'Skumulowane',
        activityInsights: 'Statystyki aktywności',
        mostUsed: 'Najczęściej używane',
        days: ({ count }: { count: number }) => `${count} dni`,
    },
    tokenMix: {
        input: 'Wejście',
        output: 'Wyjście',
        reasoning: 'Rozumowanie',
        cacheRead: 'Odczyt cache',
        cacheWrite: 'Zapis cache',
    },
    recap: {
        play: 'Odtwórz podsumowanie',
        shareImage: 'Udostępnij jako obraz',
    },
    context: {
        title: 'Kontekst i wydajność',
        utilization: 'Użyty kontekst',
        window: 'Okno',
        tokenMixTitle: 'Struktura tokenów',
    },
    summary: {
      title: "Podsumowanie użycia",
      currentStreak: "Bieżąca passa",
      currentStreakSubtitle: ({ count }: { count: number }) => `${count} active days in the last 30`,
      currentStreakSubtitleForPeriod: ({ count, period }: { count: number; period: string }) => `${count} active days · ${period}`,
      thisWeek: "Ten tydzień",
      thisWeekSubtitle: "Ostatnie tempo",
      topModel: "Najczęstszy model",
      engine: "Silnik",
      export: {
        session: "Sesja",
        period: "Okres",
        metric: "Metryka",
        costMode: "Tryb kosztów",
        totalTokens: "Łączna liczba tokenów",
        totalCost: "Łączny koszt",
        activeDays: "Aktywne dni",
        topModel: "Główny model",
        topEngine: "Główny silnik",
        modelTimeline: "Oś czasu modeli",
        engineTimeline: "Oś czasu silników",
      },
    },},

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
          "Uruchom claude, a następnie wpisz /login, aby się zalogować.",
        warning:
          "Uwaga: ustawienie ANTHROPIC_AUTH_TOKEN zastępuje logowanie CLI.",
      },
      codex: {
        title: "Codex",
        instructions: "Uruchom codex login, aby się zalogować.",
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
      title: 'Domyślny typ sesji',
      footer: 'Nadpisuje domyślny dla konta typ sesji Happier/bezpośredniej dla nowych sesji, gdy wybrany jest ten profil.',
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
      cursorSubtitleExperimental: "CLI Cursor Agent (eksperymentalne)",

      ohMyPiSubtitleExperimental: "oh-my-pi CLI (eksperymentalne)",},
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

    projects: {
    emptyTitle: "Brak projektów",
    emptyDescription: "Projekty pozwalają przeglądać i edytować pliki oraz używać Git na Twoich maszynach poza sesjami.",
    groups: {
      pinned: "Przypięte",
      addFirst: "Dodaj projekt",
    },
    actions: {
      addProjectToMachine: "Dodaj projekt do tej maszyny",
      addProject: "Dodaj projekt",
      addProjectOnMachine: ({ machine }: { machine: string }) => `Dodaj projekt na ${machine}`,
      chooseProjectFolderOnMachine: ({ machine }: { machine: string }) => `Wybierz folder na ${machine}`,
      chooseProjectFolderSubtitle: "Dodaj go jako projekt, aby przeglądać i edytować pliki oraz używać Git.",
      pin: "Przypnij",
      unpin: "Odepnij",
      remove: "Usuń",
    },
    sourceControl: {
      noSessionAvailableDetails: "Uruchom sesję w tym folderze, aby włączyć Kontrolę wersji w Projektach.",
    },
    details: {
      emptyBody: "Otwórz Pliki lub Kontrolę wersji, aby podglądać tutaj pliki i różnice.",
      placeholderFileBody: "Podgląd pliku „{title}” pojawi się tutaj.",
      placeholderScmReviewBody: "Podglądy diffów pojawią się tutaj.",
      placeholderCommitBody: "Szczegóły commita pojawią się tutaj.",
      placeholderUnsupportedBody: "Ta karta szczegółów nie jest jeszcze obsługiwana w Projektach.",
    },
    detail: {
      notFoundTitle: "Nie znaleziono projektu",
      notFoundDescription: "Ten projekt mógł zostać usunięty lub należy do innego serwera.",
      missingWorktreeRecovered: "Wybrany worktree już nie istnieje. Przywrócono katalog główny projektu.",
      groupTitle: "Projekt",
      fields: {
        name: "Nazwa",
        machine: "Maszyna",
        path: "Ścieżka",
      },
      comingSoonGroupTitle: "Wkrótce",
      comingSoonFooter:
        "Pliki, kontrola wersji, różnice i terminal pojawią się tutaj w kolejnej fazie refaktoryzacji.",
      comingSoon: {
        filesAndScmTitle: "Pliki i kontrola wersji",
        filesAndScmSubtitle:
          "Ten ekran ponownie wykorzysta istniejący pasek boczny i panele szczegółów, ale w zakresie przestrzeni roboczej zamiast sesji.",
      },
    },
  },
   settingsPlugins: {
      ...pluginWebhookAdministrationTranslations['pl'],
      ...pluginAccountDataEraseTranslations.pl,
      ...pluginAccountReleaseSelectionTranslations.pl,
      ...pluginInvocationLogTranslations.pl,
      ...eventAutomationComposerTranslations.pl,
          title: "Katalog wtyczek",
          subtitle: "Przeglądaj wyselekcjonowane opisy wtyczek i zarządzaj zainstalowanymi wtyczkami na tym urządzeniu.",
          appPanelsTitle: "Panele wtyczek",
          appPanelsSubtitle: "Otwórz panele aplikacji dodane przez zainstalowane wtyczki.",
          executionOriginReleaseContentConflict: "Zawartość wydania nie jest zgodna. Opublikuj nową wersję.",
          readOnlyProjectionUnavailable: "Szczegóły wtyczek z pamięci podręcznej są tylko do odczytu: to urządzenie jest osiągalne, ale nie udało się wczytać jego rejestru wtyczek. Ponów próbę, aby zarządzać wtyczkami.",
          readOnlyAccountRecovery: "Szczegóły konta wtyczki są dostępne, ale szczegóły dotyczące konkretnego urządzenia będą niedostępne, dopóki nie będzie dostępna zgodna instalacja wtyczki.",
          readOnlySnapshot: "Gdy to urządzenie jest rozłączone, szczegóły wtyczek z pamięci podręcznej są tylko do odczytu. Połącz urządzenie ponownie, aby zarządzać wtyczkami.",
          viewSelectorLabel: "Widoki zarządzania wtyczkami",
          views: { installed: "Zainstalowane", discover: "Odkrywaj", development: "Tworzenie", diagnostics: "Diagnostyka" },
          developmentTitle: "Tworzenie",
          developmentFooter: "Zatwierdzone źródła lokalne i diagnostyka deweloperska zgłoszone przez to urządzenie.",
          developmentEmpty: "Nie zgłoszono źródeł deweloperskich",
          developmentEmptySubtitle: "To urządzenie nie zgłosiło zatwierdzonych źródeł lokalnych ani diagnostyki obserwowania i przeładowywania.",
          developmentCreate: "Utwórz wtyczkę",
          developmentCreateSubtitle: "Tworzy lokalny szablon wtyczki na tym komputerze.",
          developmentCreateSucceeded: "Utworzono szablon wtyczki.",
          developmentSourceInstall: "Rozwijaj lokalny folder wtyczki",
          developmentSourceInstallSubtitle: "Pozwól demonowi na tym komputerze zbudować i uruchomić wtyczkę z Twojego folderu. Najpierw zatwierdzasz dokładny folder.",
          developmentSourceInstallTitle: "Folder wtyczki",
          developmentSourceInstallBody: "Podaj pełną ścieżkę do folderu projektu wtyczki na tym komputerze.",
          developmentSourceInstallSucceeded: "Źródło deweloperskie zatwierdzone i rzutowane.",
          developmentSourceInstallFailed: ({ outcome }: { outcome: string }) => `Nie zainstalowano źródła deweloperskiego (${outcome}).`,
          developmentTrustSourceRootTitle: "Zaufać temu folderowi wtyczki?",
          developmentTrustSourceRootBody: ({ path }: { path: string }) => `Happier zainstaluje zależności, zbuduje i uruchomi kod z:\n\n${path}\n\nKontynuuj tylko wtedy, gdy ufasz wszystkiemu w tym folderze i wszystkiemu, co może zostać pobrane. Samą wtyczkę sprawdzisz w następnym kroku.`,
          developmentTrustSourceRootConfirm: "Zaufaj folderowi",
          pendingChangesTitle: "Czeka na Twoją decyzję",
          pendingChangesFooter: "Zmiany wtyczek przygotowane na tej maszynie. Agent może przygotować zmianę, ale zatwierdzić ją możesz tylko Ty.",
          pendingChangesReviewHint: "Pokazuje pełny przegląd, zanim cokolwiek zostanie zaufane.",
          pendingChangeSourceRootSubtitle: ({ path }: { path: string }) => `Folder wtyczki: ${path}`,
          pendingChangeInstallSubtitle: ({ pluginId, source }: { pluginId: string; source: string }) => `${pluginId} z ${source}`,
          pendingChangeApplying: "Ta zmiana została już zatwierdzona i jest stosowana.",
          pendingChangeExpired: "Ta zmiana wygasła przed podjęciem decyzji. Poproś o nią ponownie.",
          pendingChangeRejected: "Zmiana wtyczki została odrzucona.",
          pendingChangeConfirmRejectBody: "Przygotowana zmiana zostanie odrzucona. Nic nie jest instalowane ani zaufane.",
          pendingChangeFailed: ({ outcome }: { outcome: string }) => `Nie zastosowano zmiany wtyczki (${outcome}).`,
          developmentCreateDirectoryTitle: "Folder wtyczki",
          developmentCreateDirectoryBody: "Podaj nowy bezwzględny folder na wybranym komputerze. Folder nie może jeszcze istnieć.",
          developmentCreateNameTitle: "Nazwa wtyczki",
          developmentCreateNameBody: "Podaj wyświetlaną nazwę wtyczki.",
          developmentCreateIdTitle: "Identyfikator wtyczki",
          developmentCreateIdBody: "Podaj małą, rozdzielaną kropkami przestrzeń nazw właściciela spoza happier.*.",
          developmentCreateSurfaceTitle: "Powierzchnia interfejsu wtyczki",
          developmentCreateSurfaceBody: "Wybierz powierzchnię interfejsu, od której zaczyna ta wtyczka. React Native renderuje się także w przeglądarce.",
          developmentCreateSurfaceReactNative: "React Native",
          developmentCreateSurfaceHostedWeb: "Hostowany web",
          developmentCreateSurfaceNone: "Bez interfejsu",
          developmentCreateConfirmTitle: "Utworzyć szablon wtyczki?",
          developmentCreateConfirmBody: ({ pluginId, targetDir }: { pluginId: string; targetDir: string }) => `Utworzyć ${pluginId} w ${targetDir}?`,
          developmentWatchConfigured: "Zatwierdzenie obserwowania skonfigurowane",
          developmentReloadClear: "Brak bieżącej diagnostyki przeładowania",
          developmentReloadAttention: "Diagnostyka przeładowania wymaga uwagi",
          developmentTest: "Przetestuj wtyczkę",
          developmentTestSubtitle: "Sprawdza zbudowany punkt wejścia w zarządzanym środowisku Happier.",
          developmentTestSucceeded: "Test wtyczki zakończył się powodzeniem.",
          developmentPack: "Spakuj wtyczkę",
          developmentPackSubtitle: "Tworzy sprawdzone archiwum instalacyjne obok zatwierdzonego folderu źródłowego.",
          developmentPackSucceeded: "Pakiet utworzono obok folderu źródłowego.",
          diagnosticsSnapshotTitle: "Diagnostyka",
          diagnosticsSnapshotFooter: "Bieżąca diagnostyka zgłoszona przez rejestr wtyczek na tym urządzeniu.",
          diagnosticsSnapshotEmpty: "Brak bieżącej diagnostyki wtyczek",
          diagnosticsSnapshotEmptySubtitle: "Bieżąca diagnostyka rejestru pojawi się tutaj, gdy urządzenie ją zgłosi.",
          catalogUrlLabel: "Adres URL katalogu",
          loadCatalog: "Wczytaj katalog",
          installAndTrust: "Zainstaluj i zaufaj",
          marketplaceWithdrawnTitle: "Wycofano z marketplace",
          marketplaceWithdrawnBody: "Ta pozycja została wycofana z wybranego marketplace. Nowe instalacje i aktualizacje są zablokowane.",
          marketplaceWithdrawnInstalledBody: "Ta pozycja została wycofana z wybranego marketplace. Nowe instalacje i aktualizacje są zablokowane. Zainstalowana wtyczka pozostaje włączona, dopóki jej nie wyłączysz lub nie odinstalujesz.",
          trustPolicy: {
            localTrusted: "Zaufane lokalnie",
            trusted: "Zaufane",
            prompt: "Wymaga zatwierdzenia",
            untrusted: "Niezaufane",
          },
          sourceKind: {
            bundled: "Wbudowane",
            path: "Ścieżka lokalna",
            marketplace: "Rynek wtyczek",
            package: "Rejestr pakietów",
            archive: "Archiwum",
            catalog: "Katalog",
          },
          unknownValue: ({ value }: { value: string }) => `Inne: ${value}`,
          emptySubtitle: "Ten katalog nie zwrócił żadnych opisów.",
          detailTitle: "Szczegóły wtyczki",
          managePlugin: "Zarządzaj wtyczką",
          provenanceTitle: "Źródło i zaufanie",
          diagnosticsTitle: "Diagnostyka wtyczki",
          registryDiagnosticsTitle: "Diagnostyka rejestru",
          agentUiDiagnosticsTitle: "Diagnostyka interfejsu agenta",
          contributionsTitle: "Projektowane wkłady",
          unsupportedDescriptorField: "To pole opisu nie jest obsługiwane przez tę wersję Happier.",
          noDescriptors: "Dla tej sekcji nie zaprojektowano opisów renderowanych przez hosta.",
          marketplaceInstallReviewTitle: ({ name, version }: { name: string; version: string }) => `Zainstalować i zaufać ${name} ${version}?`,
          marketplaceInstallReviewBlockedNewerVersions: 'Nowsze wersje zablokowane przed pobraniem:',
          marketplaceInstallReviewRawCredentialAccess: ({ details }: { details: string }) => `Bezpośredni dostęp do poświadczeń Voice:\n${details}`,
          marketplaceInstallReviewRawCredentialAccessItem: ({ contribution, credential, source, realm, phase, request }: { contribution: string; credential: string; source: string; realm: string; phase: string; request: string }) =>
            `${contribution}: ${credential}; źródło ${source}; środowisko ${realm}; faza ${phase}; żądanie ${request}. Kod wtyczki w środowisku ${realm} otrzymuje wybrane poświadczenie bezpośrednio i może go użyć lub skopiować.`,
          marketplaceInstallReviewBody: ({ identity, verification, executableRealms, contributions, uiArtifacts, requiredAccess, optionalAccess, compatibility }: { identity: string; verification: string; executableRealms: string; contributions: string; uiArtifacts: string; requiredAccess: string; optionalAccess: string; compatibility: string }) => `Tożsamość:\n${identity}\n\nSygnały weryfikacji:\n${verification}\n\nKod wykonywalny: ${executableRealms}\nWkłady: ${contributions}\nArtefakty interfejsu: ${uiArtifacts}\n\nZaufany kod demona i React Native działa z uprawnieniami aplikacji lub procesu i może bezpośrednio używać plików, sieci, środowiska i procesów. Wymieniony poniżej dostęp do hosta opisuje usługi pośredniczone przez Happier; nie jest to piaskownica dla wykonywalnego kodu wtyczki.\n\nWymagane ujawnienia i usługi współpracujące:\n${requiredAccess}\n\nOpcjonalne zasoby hosta (domyślnie wyłączone):\n${optionalAccess}\n\nZgodność i aktualizacje:\n${compatibility}`,
          marketplaceInstallDecisionFailed: ({ outcome }: { outcome: string }) => `Wtyczka nie została zainstalowana (${outcome}).`,
          marketplaceChangeDecisionFailed: ({ action, outcome }: { action: string; outcome: string }) => `${action} nie powiodło się (${outcome}).`,
          pluginChangeConfirmBody: ({ action, name }: { action: string; name: string }) => `Potwierdź „${action}” dla ${name}.`,
          forgetTrust: "Usuń zaufanie",
          rollback: "Wycofaj",
          uninstall: "Odinstaluj",
          marketplaceUpdateVersion: ({ installedVersion, availableVersion }: { installedVersion: string; availableVersion: string }) => `Zaktualizuj z wersji ${installedVersion} do ${availableVersion}.`,
          marketplaceCommunityUnreviewedTitle: "Niezweryfikowany kod społeczności",
          marketplaceCommunityUnreviewedBody: "Ten zewnętrzny pakiet npm nie został sprawdzony przez Happier. „Zainstaluj i zaufaj” zatwierdza zadeklarowany kod wykonywalny i dostęp do hosta po zweryfikowaniu przez demona dokładnej wersji i integralności. Zaufany kod demona i React Native działa z uprawnieniami aplikacji lub procesu; wymieniony dostęp do hosta nie jest piaskownicą.",
          genericSettingsTitle: "Ustawienia wtyczki",
          genericSettingsFooter: "Przechowywane lokalnie dla tej wtyczki na tym komputerze.",
          genericSettingsLoading: "Wczytywanie ustawień wtyczki",
          genericSettingsUnavailable: "Ustawienia wtyczki są niedostępne dla tego komputera.",
          genericSettingsLoadError: "Nie udało się wczytać ustawień wtyczki.",
          genericSettingsSaveError: "Nie udało się zapisać ustawienia wtyczki.",
          genericSettingsEmpty: "Ta wtyczka nie udostępnia edytowalnych ustawień.",
          registriesTitle: "Prywatne rejestry npm",
          registriesFooter: "Logowanie do rejestru steruje wyłącznie dostępem do pakietów. Zainstalowane i zaufane wtyczki pozostają dostępne po usunięciu rejestru lub wylogowaniu.",
          registriesAdd: "Dodaj rejestr",
          registriesAddTitle: "Dodaj prywatny rejestr",
          registriesAddOriginBody: "Wprowadź pochodzenie HTTPS rejestru bez danych logowania.",
          registriesInvalidOriginTitle: "Nieprawidłowe pochodzenie rejestru",
          registriesInvalidOriginBody: "Użyj pochodzenia HTTPS bez danych logowania, ścieżki, zapytania ani fragmentu.",
          registriesNameTitle: "Nazwa rejestru",
          registriesNameBody: "Wybierz nazwę widoczną tylko w ustawieniach Happier.",
          registriesScopesTitle: "Zakresy pakietów",
          registriesScopesBody: "Opcjonalne zakresy rozdzielone przecinkami, kierowane do tego rejestru.",
          registriesScopesPlaceholder: "@firma, @zespol",
          registriesDefaultTitle: "Domyślny rejestr pakietów",
          registriesDefaultBody: "Używać tego rejestru dla pakietów bez zakresu, które nie są kierowane do innego skonfigurowanego źródła?",
          registriesUseAsDefault: "Użyj jako domyślnego",
          registriesScopedOnly: "Tylko pakiety z zakresem",
          registriesPrivateNetworkTitle: "Dostęp do sieci prywatnej",
          registriesPrivateNetworkBody: "Zezwolić temu pochodzeniu rejestru na rozpoznawanie prywatnych lub lokalnych adresów sieciowych? Pozostaw wyłączone dla rejestrów internetowych.",
          registriesAllowPrivateNetwork: "Zezwól na sieć prywatną",
          registriesPublicOnly: "Tylko adresy publiczne",
          registriesLogin: "Zaloguj się",
          registriesLoginTitle: "Token rejestru",
          registriesLoginBody: "Wklej token tego rejestru. Jest szyfrowany na wybranym komputerze i nie jest przechowywany w tej aplikacji.",
          registriesLogout: "Wyloguj się",
          registriesEdit: "Edytuj rejestr",
          registriesTest: "Przetestuj połączenie",
          registriesMarketplaceBindingsTitle: "Powiązania rejestrów marketplace",
          registriesMarketplaceBind: ({ profile, source }: { profile: string; source: string }) => `Użyj ${profile} dla ${source}`,
          registriesMarketplaceUnbind: ({ source }: { source: string }) => `Przestań używać prywatnego rejestru dla ${source}`,
          registriesRemove: "Usuń rejestr",
          registriesRemoveTitle: "Usunąć prywatny rejestr?",
          registriesRemoveBody: ({ name }: { name: string }) => `Usunąć ${name}? Zainstalowane wtyczki pozostaną zainstalowane i zaufane; przyszłe pobrania i aktualizacje z tego rejestru zostaną wstrzymane.`,
          registriesAvailability: {
            unknown: "Nie sprawdzono",
            available: "Dostępny",
            sign_in_required: "Wymagane logowanie",
            offline: "Poza siecią",
          },
          registriesUpdatePaused: "Aktualizacje wstrzymane",
          registriesPauseReason: {
            credentials_missing: "Brak danych logowania do rejestru",
            authentication_failed: "Uwierzytelnianie rejestru nie powiodło się",
            profile_removed: "Profil rejestru został usunięty",
            offline: "Rejestr jest offline",
          },
          registriesErrorTitle: "Operacja rejestru nie powiodła się",
          registriesErrorBody: "Odśwież listę rejestrów i spróbuj ponownie.",
          registriesInvalidProfileTitle: "Nieprawidłowe ustawienia rejestru",
          registriesInvalidProfileBody: "Sprawdź nazwę rejestru i zakresy pakietów, a następnie spróbuj ponownie.",
          registriesNoMachine: "Wybierz komputer, aby zarządzać prywatnymi rejestrami.",
          registriesLoadError: "Nie udało się wczytać ustawień prywatnego rejestru.",
          registriesEmpty: "Nie skonfigurowano prywatnych rejestrów.",
        },
    settingsScmDiffSummary: {
    title: 'Podsumowania diffów',
    enabledTitle: 'Włącz podsumowania diffów',
    enabledSubtitle:
      'Zezwalaj na podsumowania diffów kontroli źródeł generowane przez AI.',
    prefetchTitle: 'Wstępnie pobieraj podsumowania',
    prefetchSubtitle:
      'Generuj podsumowania z wyprzedzeniem tylko wtedy, gdy ta preferencja jest włączona.',
    modelOverrideTitle: 'Model podsumowania',
    modelOverrideSubtitle:
      'Opcjonalny rozpoznany profil runtime używany do podsumowań diffów.',
    modelOverrideDefault: 'Użyj domyślnego runtime',
    cacheTitle: 'Pamięć podręczna podsumowań',
    cacheSubtitle:
      'Podsumowania checkpointów są używane ponownie według potwierdzenia; podsumowania working tree pozostają tymczasowe.',
  },
    externalSessions: {
        ...externalSessionOperationTranslations.pl,
        ...externalSessionSettingsTranslations.pl,
        settingsTitle: 'Sesje zewnętrzne',
        settingsEntrySubtitle: 'Sprawdź, jak Happier obsługuje sesje uruchomione poza aplikacją.',
        settingsSafetyGroupTitle: 'Jak to działa',
        settingsPassiveTitle: 'Domyślnie tylko do odczytu',
        settingsPassiveSubtitle: 'Otwarcie tej strony jest pasywne. Nigdy nie uruchamia ani nie wznawia Agenta, nie zmienia jego konfiguracji, nie instaluje hooków ani nie rozpoczyna śledzenia sesji.',
        settingsFollowGroupTitle: 'Pasywne śledzenie',
        settingsRestoreTitle: 'Kontynuuj pasywne śledzenie po restarcie',
        settingsRestoreEnabledSubtitle: 'Po restarcie demona ponownie połącz sesje, które wyraźnie śledzisz.',
        settingsRestoreDisabledSubtitle: 'Nie łącz ponownie śledzonych sesji po restarcie demona.',
        settingsRestoreFooter: 'Przywracanie tylko obserwuje istniejące źródło Agenta. Nigdy nie uruchamia ani nie wznawia Agenta.',
        settingsNotificationsTitle: 'Powiadomienia',
        settingsNotificationsActiveSubtitle: 'Powiadomienia o gotowości dotyczą tylko sesji z włączonym pasywnym śledzeniem.',
        settingsNotificationsInactiveSubtitle: 'Włącz pasywne śledzenie sesji, aby otrzymywać jej powiadomienia.',
        settingsActiveFollowsGroupTitle: 'Śledzenie sesji',
        settingsActiveFollowsFooter: 'Każdy wybór dotyczy tylko tej sesji. Inne sesje nigdy nie są włączane automatycznie.',
        settingsActiveFollowsEmptyTitle: 'Brak sesji zewnętrznych',
        settingsActiveFollowsEmptySubtitle: 'Połączone sesje zewnętrzne pojawią się tutaj z bieżącym stanem śledzenia.',
        settingsFollowToggleHint: 'Uruchamia lub zatrzymuje pasywne śledzenie tej sesji w tle.',
        followStatusDisabled: 'Nie jest śledzona',
        followStatusPaused: 'Śledzenie wstrzymane',
        followStatusReacquiring: 'Ponowne łączenie śledzenia…',
        followStatusActive: 'Aktywne śledzenie',
        followStatusError: 'Śledzenie wymaga uwagi',
        followStatusUnknown: 'Stan śledzenia niedostępny',
        followStatusMachineOffline: 'Maszyna jest offline — pasywne śledzenie zostanie wznowione po ponownym połączeniu',
        followStatusUnsupported: 'Ten Agent nie obsługuje pasywnego śledzenia',
        followUpdateFailed: 'Nie udało się zaktualizować pasywnego śledzenia tej sesji. Spróbuj ponownie.',
    browseTitle: "Przeglądaj sesje zewnętrzne",
    browseOpenExisting: "Przeglądaj sesje zewnętrzne",
    browseActionSubtitle: "Wybierz maszynę, agenta i sesję, aby otworzyć ją tutaj.",
    emptyStateTitle: "Przeglądaj istniejącą sesję",
    emptyStateDescription: "Otwieraj sesje Claude, Codex i OpenCode z podłączonych maszyn.",
    browseFiltersTitle: "Wybierz źródło",
    browseMachines: "Maszyny",
    browseAgents: "Agenci",
    browseSources: "Źródła",
    browseSourceCodexUserHome: "Mój katalog Codex",
        browseSourceCodexConnectedServices: ({ service }: { service: string }) => `Połączone usługi ${service}`,
    browseSourceClaudeDefault: "Domyślna konfiguracja Claude",
    browseSourceOpenCodeDefault: "Domyślny serwer OpenCode",
    browseCandidates: "Dostępne sesje",
    browseNoMachines: "Na razie nie ma dostępnych maszyn dla sesji bezpośrednich.",
    browseNoCandidates: "Nie znaleziono sesji zewnętrznych dla tej maszyny i agenta.",
    browseActivityRunning: "Uruchomiona",
        browseActivityRunningNow: "Uruchomiona teraz",
    browseActivityRecent: "Niedawna",
    browseActivityIdle: "Bezczynna",
    browseActivityUnknown: "Nieznana",
        browseSearchPlaceholder: "Szukaj wczytanych sesji…",
        browseNoSearchResults: "Żadna wczytana sesja nie pasuje jeszcze do tego wyszukiwania.",
    browseIndexing: "Indeksowanie sesji zewnętrznych…",
    browseIndexingProgress: ({ scanned, total }: { scanned: number; total: number }) => `Zindeksowano ${scanned} z ${total} sesji`,
    browseIndexingCancelled: "Indeksowanie zatrzymano. Spróbuj ponownie, gdy zechcesz.",
    browseLoadMore: "Wczytaj więcej sesji",
    browseFailedToLoad: "Nie udało się wczytać sesji zewnętrznych.",
    browseLinkFailed: "Nie udało się połączyć wybranej sesji zewnętrznej.",
  },
    pluginReactNative: {
    unavailable: "Interfejs React Native wtyczki niedostępny",
    disabled: "Interfejs React Native wtyczki wyłączony",
    fallback: "Używanie fallbacku wtyczki",
    reset: {
      requested: {
        title: "Resetowanie interfejsu wtyczki",
        reason: "Happier czeka na potwierdzenie resetowania.",
      },
      awaitingProjection: {
        title: "Oczekiwanie na zresetowanie wtyczki",
        reason: "Happier czeka na zaktualizowany stan wtyczki.",
      },
      complete: {
        title: "Interfejs wtyczki został zresetowany",
        reason: "Interfejs wtyczki jest ponownie dostępny.",
      },
      failed: {
        title: "Nie udało się zresetować interfejsu wtyczki",
        reason: "Spróbuj zresetować go ponownie.",
      },
    },
  },
    pluginRuntime: {
        unavailableGeneric: 'Ten widok wtyczki jest obecnie niedostępny.',
        crashLoop: 'Wtyczka została zatrzymana po wielokrotnych awariach.',
        disabledByPolicy: 'Ten widok wtyczki jest wyłączony przez bieżące ustawienia lub zgodność.',
        hostedWebUnavailableTitle: 'Hostowany widok wtyczki jest niedostępny',
        hostedWebPolicyDenied: 'Ten widok wtyczki nie jest dostępny na tej powierzchni. Sprawdź ustawienia dostępności lub użyj obsługiwanej powierzchni.',
        hostedWebSandboxUnavailable: 'Ta wtyczka nie deklaruje ustawień izolacji potrzebnych do wyświetlenia tego widoku. Zaktualizuj wtyczkę i spróbuj ponownie.',
        hostedWebSecurityUnavailable: 'Ustawień bezpieczeństwa tej wtyczki nie można zastosować w tym widoku. Zaktualizuj wtyczkę lub użyj obsługiwanego hosta.',
        hostedWebFrameOriginUnavailable: 'Happier nie mógł ustalić zaufanego adresu dla tego widoku. Odśwież i spróbuj ponownie.',
        hostedWebBridgeNonceUnavailable: 'Happier nie mógł ustanowić bezpiecznego połączenia z tym widokiem. Odśwież i spróbuj ponownie.',
        hostedWebBridgeTimeout: 'Ten widok wtyczki nie zakończył łączenia. Odśwież i spróbuj ponownie.',
        hostedWebEndpointPolicyDenied: 'Adres tego widoku jest zablokowany przez jego zasady bezpieczeństwa. Sprawdź ustawienia wtyczki lub użyj obsługiwanego hosta.',
        missingRequirement: 'Temu widokowi wtyczki brakuje wymagania na tym urządzeniu.',
    },
    settingsSearch: {
    placeholder: "Szukaj ustawień",
  },
    onboardingJourney: {
        accessibility: {
            skipToContent: "Przejdź do treści",
        },
  },} as const;

export type TranslationsPl = typeof pl;
