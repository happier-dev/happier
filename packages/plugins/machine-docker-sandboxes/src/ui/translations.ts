import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const DOCKER_SANDBOXES_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'machineDocker.lifetime.unavailable': "This sandbox can't keep Happier running with the current setup.",
  }),
  de: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Diese Sandbox kann Happier mit der aktuellen Einrichtung nicht am Laufen halten.',
  }),
  ru: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Эта песочница не может поддерживать работу Happier при текущей настройке.',
  }),
  pl: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Ta piaskownica nie może utrzymać działania Happier przy obecnej konfiguracji.',
  }),
  es: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Este entorno aislado no puede mantener Happier en ejecución con la configuración actual.',
  }),
  fr: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Ce bac à sable ne peut pas maintenir Happier en cours d’exécution avec la configuration actuelle.',
  }),
  it: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Questo ambiente isolato non può mantenere Happier in esecuzione con la configurazione attuale.',
  }),
  pt: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Este ambiente isolado não pode manter o Happier em execução com a configuração atual.',
  }),
  ca: Object.freeze({
    'machineDocker.lifetime.unavailable': 'Aquest entorn aïllat no pot mantenir Happier en execució amb la configuració actual.',
  }),
  'zh-Hans': Object.freeze({
    'machineDocker.lifetime.unavailable': '在当前配置下，此沙盒无法让 Happier 持续运行。',
  }),
  'zh-Hant': Object.freeze({
    'machineDocker.lifetime.unavailable': '在目前設定下，此沙盒無法讓 Happier 持續執行。',
  }),
  ja: Object.freeze({
    'machineDocker.lifetime.unavailable': '現在の設定では、このサンドボックスで Happier の実行を維持できません。',
  }),
});

const CONFIGURATION_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.en },
  { locale: 'de', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.de },
  { locale: 'ru', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: DOCKER_SANDBOXES_UI_TRANSLATIONS.ja },
] as const satisfies readonly UiTranslationBundle[]);

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"An isolated machine for coding and development.","ready":"Installed","unavailable":"Not installed", "docker_sandbox_version_unqualified": "Docker version unsupported"},
  "de": {"kind":"Sandbox","description":"Eine isolierte Maschine zum Programmieren und Entwickeln.","ready":"Installiert","unavailable":"Nicht installiert", "docker_sandbox_version_unqualified": "Docker-Version nicht unterstützt"},
  "ru": {"kind":"песочница","description":"Изолированная машина для программирования и разработки.","ready":"Установлено","unavailable":"Не установлено", "docker_sandbox_version_unqualified": "Версия Docker не поддерживается"},
  "pl": {"kind":"piaskownica","description":"Izolowana maszyna do programowania i tworzenia aplikacji.","ready":"Zainstalowano","unavailable":"Nie zainstalowano", "docker_sandbox_version_unqualified": "Nieobsługiwana wersja Docker"},
  "es": {"kind":"sandbox","description":"Una máquina aislada para programar y desarrollar.","ready":"Instalado","unavailable":"No instalado", "docker_sandbox_version_unqualified": "Versión de Docker no compatible"},
  "fr": {"kind":"sandbox","description":"Une machine isolée pour le code et le développement.","ready":"Installé","unavailable":"Non installé", "docker_sandbox_version_unqualified": "Version de Docker non prise en charge"},
  "it": {"kind":"sandbox","description":"Una macchina isolata per programmare e sviluppare.","ready":"Installato","unavailable":"Non installato", "docker_sandbox_version_unqualified": "Versione Docker non supportata"},
  "pt": {"kind":"sandbox","description":"Uma máquina isolada para programar e desenvolver.","ready":"Instalado","unavailable":"Não instalado", "docker_sandbox_version_unqualified": "Versão do Docker não suportada"},
  "ca": {"kind":"sandbox","description":"Una màquina aïllada per programar i desenvolupar.","ready":"Instal·lat","unavailable":"No instal·lat", "docker_sandbox_version_unqualified": "Versió de Docker no compatible"},
  "zh-Hans": {"kind":"沙盒","description":"用于编程和开发的隔离机器。","ready":"已安装","unavailable":"未安装", "docker_sandbox_version_unqualified": "Docker 版本不受支持"},
  "zh-Hant": {"kind":"沙盒","description":"用於程式設計和開發的隔離機器。","ready":"已安裝","unavailable":"未安裝", "docker_sandbox_version_unqualified": "Docker 版本不受支援"},
  "ja": {"kind":"サンドボックス","description":"コーディングと開発のための隔離されたマシン。","ready":"インストール済み","unavailable":"未インストール", "docker_sandbox_version_unqualified": "Docker バージョン非対応"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineDocker.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const DOCKER_SANDBOXES_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = CONFIGURATION_TRANSLATION_BUNDLES.map(bundle => ({
  ...bundle, messages: { ...bundle.messages, ...Object.fromEntries(Object.entries(MACHINE_PRESENTATION_LABELS[bundle.locale as keyof typeof MACHINE_PRESENTATION_LABELS])
    .map(([id, value]) => ['machineDocker.presentation.' + id, value])) },
}));
import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
