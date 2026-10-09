import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const MODAL_CONFIGURATION_LABELS = {
  en: {
    appReference: 'Existing App',
    imageReference: 'Registry image',
    cpu: 'Physical CPU cores',
    memoryMb: 'Memory (MiB)',
    timeoutMs: 'Native lifetime (ms)',
    timeoutDescription: 'Whole seconds, from 1 second to 24 hours.',
  },
  de: {
    appReference: 'Vorhandene App',
    imageReference: 'Registry-Image',
    cpu: 'Physische CPU-Kerne',
    memoryMb: 'Arbeitsspeicher (MiB)',
    timeoutMs: 'Native Laufzeit (ms)',
    timeoutDescription: 'Ganze Sekunden, von 1 Sekunde bis 24 Stunden.',
  },
  ru: {
    appReference: 'Существующее приложение',
    imageReference: 'Образ из реестра',
    cpu: 'Физические ядра CPU',
    memoryMb: 'Память (MiB)',
    timeoutMs: 'Нативное время жизни (ms)',
    timeoutDescription: 'Целые секунды, от 1 секунды до 24 часов.',
  },
  pl: {
    appReference: 'Istniejąca aplikacja',
    imageReference: 'Obraz z rejestru',
    cpu: 'Fizyczne rdzenie CPU',
    memoryMb: 'Pamięć (MiB)',
    timeoutMs: 'Natywny czas życia (ms)',
    timeoutDescription: 'Pełne sekundy, od 1 sekundy do 24 godzin.',
  },
  es: {
    appReference: 'Aplicación existente',
    imageReference: 'Imagen del registro',
    cpu: 'Núcleos físicos de CPU',
    memoryMb: 'Memoria (MiB)',
    timeoutMs: 'Duración nativa (ms)',
    timeoutDescription: 'Segundos enteros, de 1 segundo a 24 horas.',
  },
  fr: {
    appReference: 'Application existante',
    imageReference: 'Image du registre',
    cpu: 'Cœurs CPU physiques',
    memoryMb: 'Mémoire (MiB)',
    timeoutMs: 'Durée de vie native (ms)',
    timeoutDescription: 'Secondes entières, de 1 seconde à 24 heures.',
  },
  it: {
    appReference: 'App esistente',
    imageReference: 'Immagine del registro',
    cpu: 'Core CPU fisici',
    memoryMb: 'Memoria (MiB)',
    timeoutMs: 'Durata nativa (ms)',
    timeoutDescription: 'Secondi interi, da 1 secondo a 24 ore.',
  },
  pt: {
    appReference: 'Aplicativo existente',
    imageReference: 'Imagem do registro',
    cpu: 'Núcleos físicos de CPU',
    memoryMb: 'Memória (MiB)',
    timeoutMs: 'Duração nativa (ms)',
    timeoutDescription: 'Segundos inteiros, de 1 segundo a 24 horas.',
  },
  ca: {
    appReference: 'Aplicació existent',
    imageReference: 'Imatge del registre',
    cpu: 'Nuclis físics de CPU',
    memoryMb: 'Memòria (MiB)',
    timeoutMs: 'Durada nativa (ms)',
    timeoutDescription: 'Segons enters, d’1 segon a 24 hores.',
  },
  'zh-Hans': {
    appReference: '现有应用',
    imageReference: '镜像仓库中的镜像',
    cpu: '物理 CPU 核心',
    memoryMb: '内存（MiB）',
    timeoutMs: '原生运行时长（ms）',
    timeoutDescription: '以整秒为单位，从 1 秒到 24 小时。',
  },
  'zh-Hant': {
    appReference: '現有應用程式',
    imageReference: '映像登錄庫中的映像',
    cpu: '實體 CPU 核心',
    memoryMb: '記憶體（MiB）',
    timeoutMs: '原生執行時間（ms）',
    timeoutDescription: '以整秒為單位，從 1 秒到 24 小時。',
  },
  ja: {
    appReference: '既存の App',
    imageReference: 'レジストリイメージ',
    cpu: '物理 CPU コア',
    memoryMb: 'メモリ（MiB）',
    timeoutMs: 'ネイティブの有効期間（ms）',
    timeoutDescription: '1 秒から 24 時間までの整数秒。',
  },
} as const;

const CONFIGURATION_TRANSLATION_BUNDLES = Object.freeze(
  Object.entries(MODAL_CONFIGURATION_LABELS).map(([locale, labels]) => ({
    locale,
    messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineModal.configure.${id}`, value])),
  })),
) satisfies readonly UiTranslationBundle[];

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"On-demand cloud sandboxes with a native lifetime.","ready":"Account connected","unavailable":"Account unavailable"},
  "de": {"kind":"Sandbox","description":"Cloud-Sandboxes auf Abruf mit nativer Laufzeit.","ready":"Konto verbunden","unavailable":"Konto nicht verfügbar"},
  "ru": {"kind":"песочница","description":"Облачные песочницы по запросу с нативным сроком работы.","ready":"Аккаунт подключён","unavailable":"Аккаунт недоступен"},
  "pl": {"kind":"piaskownica","description":"Piaskownice w chmurze na żądanie z natywnym czasem działania.","ready":"Konto połączone","unavailable":"Konto niedostępne"},
  "es": {"kind":"sandbox","description":"Sandboxes en la nube bajo demanda con duración nativa.","ready":"Cuenta conectada","unavailable":"Cuenta no disponible"},
  "fr": {"kind":"sandbox","description":"Des sandboxes cloud à la demande avec une durée de vie native.","ready":"Compte connecté","unavailable":"Compte indisponible"},
  "it": {"kind":"sandbox","description":"Sandbox cloud su richiesta con durata nativa.","ready":"Account collegato","unavailable":"Account non disponibile"},
  "pt": {"kind":"sandbox","description":"Sandboxes na nuvem sob demanda com duração nativa.","ready":"Conta conectada","unavailable":"Conta indisponível"},
  "ca": {"kind":"sandbox","description":"Sandboxes al núvol sota demanda amb durada nativa.","ready":"Compte connectat","unavailable":"Compte no disponible"},
  "zh-Hans": {"kind":"沙盒","description":"按需提供并遵循原生运行期限的云沙盒。","ready":"账户已连接","unavailable":"账户不可用"},
  "zh-Hant": {"kind":"沙盒","description":"隨需提供並遵循原生執行期限的雲端沙盒。","ready":"帳戶已連接","unavailable":"帳戶不可用"},
  "ja": {"kind":"サンドボックス","description":"ネイティブの有効期間に従うオンデマンドのクラウドサンドボックス。","ready":"アカウント接続済み","unavailable":"アカウント利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineModal.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const MODAL_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = CONFIGURATION_TRANSLATION_BUNDLES.map(bundle => ({
  ...bundle, messages: { ...bundle.messages, ...Object.fromEntries(Object.entries(MACHINE_PRESENTATION_LABELS[bundle.locale as keyof typeof MACHINE_PRESENTATION_LABELS])
    .map(([id, value]) => ['machineModal.presentation.' + id, value])) },
}));
import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
