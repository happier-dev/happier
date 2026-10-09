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

export const HETZNER_UI_TRANSLATION_BUNDLES = Object.freeze(
  Object.entries(HETZNER_PRICE_LABELS).map(([locale, labels]) => ({
    locale,
    messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => [`machineHetzner.prices.${id}`, value])),
  })),
) satisfies readonly UiTranslationBundle[];
