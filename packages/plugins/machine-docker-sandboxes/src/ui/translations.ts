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

export const DOCKER_SANDBOXES_UI_TRANSLATION_BUNDLES = Object.freeze([
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
