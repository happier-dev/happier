import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const HETZNER_PRICE_LABELS = {
  en: { compute: 'Compute', primaryIpv4: 'Primary IPv4', primaryIpv6: 'Primary IPv6' },
  de: { compute: 'Rechenleistung', primaryIpv4: 'Primäre IPv4', primaryIpv6: 'Primäre IPv6' },
  ru: { compute: 'Вычисления', primaryIpv4: 'Основной IPv4', primaryIpv6: 'Основной IPv6' },
  pl: { compute: 'Moc obliczeniowa', primaryIpv4: 'Podstawowy IPv4', primaryIpv6: 'Podstawowy IPv6' },
  es: { compute: 'Cómputo', primaryIpv4: 'IPv4 principal', primaryIpv6: 'IPv6 principal' },
  fr: { compute: 'Calcul', primaryIpv4: 'IPv4 principale', primaryIpv6: 'IPv6 principale' },
  it: { compute: 'Calcolo', primaryIpv4: 'IPv4 primario', primaryIpv6: 'IPv6 primario' },
  pt: { compute: 'Computação', primaryIpv4: 'IPv4 principal', primaryIpv6: 'IPv6 principal' },
  ca: { compute: 'Càlcul', primaryIpv4: 'IPv4 principal', primaryIpv6: 'IPv6 principal' },
  'zh-Hans': { compute: '计算', primaryIpv4: '主 IPv4', primaryIpv6: '主 IPv6' },
  'zh-Hant': { compute: '運算', primaryIpv4: '主要 IPv4', primaryIpv6: '主要 IPv6' },
  ja: { compute: 'コンピューティング', primaryIpv4: 'プライマリ IPv4', primaryIpv6: 'プライマリ IPv6' },
} as const;

const CONFIGURATION_TRANSLATION_BUNDLES = Object.freeze(
  Object.entries(HETZNER_PRICE_LABELS).map(([locale, labels]) => ({
    locale,
    messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineHetzner.prices.${id}`, value])),
  })),
) satisfies readonly UiTranslationBundle[];

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"server","description":"A cloud server with a persistent disk.","ready":"Account connected","unavailable":"Account unavailable"},
  "de": {"kind":"Server","description":"Ein Cloud-Server mit dauerhaftem Speicher.","ready":"Konto verbunden","unavailable":"Konto nicht verfügbar"},
  "ru": {"kind":"сервер","description":"Облачный сервер с постоянным диском.","ready":"Аккаунт подключён","unavailable":"Аккаунт недоступен"},
  "pl": {"kind":"serwer","description":"Serwer w chmurze z trwałym dyskiem.","ready":"Konto połączone","unavailable":"Konto niedostępne"},
  "es": {"kind":"servidor","description":"Un servidor en la nube con disco persistente.","ready":"Cuenta conectada","unavailable":"Cuenta no disponible"},
  "fr": {"kind":"serveur","description":"Un serveur cloud avec un disque persistant.","ready":"Compte connecté","unavailable":"Compte indisponible"},
  "it": {"kind":"server","description":"Un server cloud con disco persistente.","ready":"Account collegato","unavailable":"Account non disponibile"},
  "pt": {"kind":"servidor","description":"Um servidor na nuvem com disco persistente.","ready":"Conta conectada","unavailable":"Conta indisponível"},
  "ca": {"kind":"servidor","description":"Un servidor al núvol amb disc persistent.","ready":"Compte connectat","unavailable":"Compte no disponible"},
  "zh-Hans": {"kind":"服务器","description":"配备持久磁盘的云服务器。","ready":"账户已连接","unavailable":"账户不可用"},
  "zh-Hant": {"kind":"伺服器","description":"配備持久磁碟的雲端伺服器。","ready":"帳戶已連接","unavailable":"帳戶不可用"},
  "ja": {"kind":"サーバー","description":"永続ディスクを持つクラウドサーバー。","ready":"アカウント接続済み","unavailable":"アカウント利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineHetzner.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const HETZNER_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = CONFIGURATION_TRANSLATION_BUNDLES.map(bundle => ({
  ...bundle, messages: { ...bundle.messages, ...Object.fromEntries(Object.entries(MACHINE_PRESENTATION_LABELS[bundle.locale as keyof typeof MACHINE_PRESENTATION_LABELS])
    .map(([id, value]) => ['machineHetzner.presentation.' + id, value])) },
}));
import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
