import { storeSoftwareTranslations, type StoreSoftwareTranslation } from './storeSoftwareTranslations';
import { storeAppPageTranslations, type StoreAppPageTranslation } from './storeAppPageTranslations';

export type StoreTranslation = Readonly<{}>;

const en: StoreTranslation = {};
const ca: StoreTranslation = {};
const de: StoreTranslation = {};
const es: StoreTranslation = {};
const fr: StoreTranslation = {};
const it: StoreTranslation = {};
const ja: StoreTranslation = {};
const pl: StoreTranslation = {};
const pt: StoreTranslation = {};
const ru: StoreTranslation = {};
const zhHans: StoreTranslation = {};
const zhHant: StoreTranslation = {};

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
