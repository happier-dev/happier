import { storeSoftwareTranslations, type StoreSoftwareTranslation } from './storeSoftwareTranslations';
import { storeAppPageTranslations, type StoreAppPageTranslation } from './storeAppPageTranslations';

export type StoreTranslation = Readonly<{
  retry: string;
  sourcesUnreachable: (params: Readonly<{ count: number }>) => string;
  hideSources: string;
}>;

const en: StoreTranslation = {
  retry: 'Try again',
  sourcesUnreachable: ({ count }) => `${count} sources unreachable`,
  hideSources: 'Hide',
};
const ca: StoreTranslation = {
  retry: 'Torna-ho a provar',
  sourcesUnreachable: ({ count }) => `${count} fonts inaccessibles`,
  hideSources: 'Amaga',
};
const de: StoreTranslation = {
  retry: 'Erneut versuchen',
  sourcesUnreachable: ({ count }) => `${count} Quellen nicht erreichbar`,
  hideSources: 'Ausblenden',
};
const es: StoreTranslation = {
  retry: 'Reintentar',
  sourcesUnreachable: ({ count }) => `${count} fuentes inaccesibles`,
  hideSources: 'Ocultar',
};
const fr: StoreTranslation = {
  retry: 'Réessayer',
  sourcesUnreachable: ({ count }) => `${count} sources injoignables`,
  hideSources: 'Masquer',
};
const it: StoreTranslation = {
  retry: 'Riprova',
  sourcesUnreachable: ({ count }) => `${count} fonti non raggiungibili`,
  hideSources: 'Nascondi',
};
const ja: StoreTranslation = {
  retry: '再試行',
  sourcesUnreachable: ({ count }) => `${count} 件のソースに接続できません`,
  hideSources: '非表示',
};
const pl: StoreTranslation = {
  retry: 'Spróbuj ponownie',
  sourcesUnreachable: ({ count }) => `Niedostępne źródła: ${count}`,
  hideSources: 'Ukryj',
};
const pt: StoreTranslation = {
  retry: 'Tentar novamente',
  sourcesUnreachable: ({ count }) => `${count} fontes inacessíveis`,
  hideSources: 'Ocultar',
};
const ru: StoreTranslation = {
  retry: 'Повторить',
  sourcesUnreachable: ({ count }) => `Недоступно источников: ${count}`,
  hideSources: 'Скрыть',
};
const zhHans: StoreTranslation = {
  retry: '重试',
  sourcesUnreachable: ({ count }) => `${count} 个来源无法连接`,
  hideSources: '隐藏',
};
const zhHant: StoreTranslation = {
  retry: '重試',
  sourcesUnreachable: ({ count }) => `${count} 個來源無法連線`,
  hideSources: '隱藏',
};

const storeByLocale = {
  en: { ...en, softwarePage: storeSoftwareTranslations.en, appPage: storeAppPageTranslations.en },
  ca: { ...ca, softwarePage: storeSoftwareTranslations.ca, appPage: storeAppPageTranslations.ca },
  de: { ...de, softwarePage: storeSoftwareTranslations.de, appPage: storeAppPageTranslations.de },
  es: { ...es, softwarePage: storeSoftwareTranslations.es, appPage: storeAppPageTranslations.es },
  fr: { ...fr, softwarePage: storeSoftwareTranslations.fr, appPage: storeAppPageTranslations.fr },
  it: { ...it, softwarePage: storeSoftwareTranslations.it, appPage: storeAppPageTranslations.it },
  ja: { ...ja, softwarePage: storeSoftwareTranslations.ja, appPage: storeAppPageTranslations.ja },
  pl: { ...pl, softwarePage: storeSoftwareTranslations.pl, appPage: storeAppPageTranslations.pl },
  pt: { ...pt, softwarePage: storeSoftwareTranslations.pt, appPage: storeAppPageTranslations.pt },
  ru: { ...ru, softwarePage: storeSoftwareTranslations.ru, appPage: storeAppPageTranslations.ru },
  zhHans: { ...zhHans, softwarePage: storeSoftwareTranslations.zhHans, appPage: storeAppPageTranslations.zhHans },
  zhHant: { ...zhHant, softwarePage: storeSoftwareTranslations.zhHant, appPage: storeAppPageTranslations.zhHant },
} satisfies Record<string, StoreTranslation & Readonly<{ softwarePage: StoreSoftwareTranslation; appPage: StoreAppPageTranslation }>>;

export const storeTranslations: Readonly<
  Record<keyof typeof storeByLocale, StoreTranslation & Readonly<{ softwarePage: StoreSoftwareTranslation; appPage: StoreAppPageTranslation }>>
> = storeByLocale;
