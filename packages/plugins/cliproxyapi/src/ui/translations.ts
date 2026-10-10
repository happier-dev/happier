export const CLIPROXYAPI_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'managedPurpose.openai.title': 'ChatGPT account or pool',
    'managedPurpose.anthropic.title': 'Claude account or pool',
  }),
  de: Object.freeze({
    'managedPurpose.openai.title': 'ChatGPT-Konto oder Pool',
    'managedPurpose.anthropic.title': 'Claude-Konto oder Pool',
  }),
  ru: Object.freeze({
    'managedPurpose.openai.title': 'Учётная запись или пул ChatGPT',
    'managedPurpose.anthropic.title': 'Учётная запись или пул Claude',
  }),
  pl: Object.freeze({
    'managedPurpose.openai.title': 'Konto lub pula ChatGPT',
    'managedPurpose.anthropic.title': 'Konto lub pula Claude',
  }),
  es: Object.freeze({
    'managedPurpose.openai.title': 'Cuenta o grupo de ChatGPT',
    'managedPurpose.anthropic.title': 'Cuenta o grupo de Claude',
  }),
  fr: Object.freeze({
    'managedPurpose.openai.title': 'Compte ou groupe ChatGPT',
    'managedPurpose.anthropic.title': 'Compte ou groupe Claude',
  }),
  it: Object.freeze({
    'managedPurpose.openai.title': 'Account o pool ChatGPT',
    'managedPurpose.anthropic.title': 'Account o pool Claude',
  }),
  pt: Object.freeze({
    'managedPurpose.openai.title': 'Conta ou grupo do ChatGPT',
    'managedPurpose.anthropic.title': 'Conta ou grupo do Claude',
  }),
  ca: Object.freeze({
    'managedPurpose.openai.title': 'Compte o grup de ChatGPT',
    'managedPurpose.anthropic.title': 'Compte o grup de Claude',
  }),
  'zh-Hans': Object.freeze({
    'managedPurpose.openai.title': 'ChatGPT 帐户或帐户池',
    'managedPurpose.anthropic.title': 'Claude 帐户或帐户池',
  }),
  'zh-Hant': Object.freeze({
    'managedPurpose.openai.title': 'ChatGPT 帳戶或帳戶集區',
    'managedPurpose.anthropic.title': 'Claude 帳戶或帳戶集區',
  }),
  ja: Object.freeze({
    'managedPurpose.openai.title': 'ChatGPT アカウントまたはプール',
    'managedPurpose.anthropic.title': 'Claude アカウントまたはプール',
  }),
});

export const CLIPROXYAPI_UI_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: CLIPROXYAPI_UI_TRANSLATIONS.en },
  { locale: 'de', messages: CLIPROXYAPI_UI_TRANSLATIONS.de },
  { locale: 'ru', messages: CLIPROXYAPI_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: CLIPROXYAPI_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: CLIPROXYAPI_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: CLIPROXYAPI_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: CLIPROXYAPI_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: CLIPROXYAPI_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: CLIPROXYAPI_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: CLIPROXYAPI_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: CLIPROXYAPI_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: CLIPROXYAPI_UI_TRANSLATIONS.ja },
] as const);
