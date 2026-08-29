export const CLIPROXYAPI_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'managedPurpose.openai.title': 'Use OpenAI upstream account',
    'managedPurpose.anthropic.title': 'Use Anthropic upstream account',
  }),
  de: Object.freeze({
    'managedPurpose.openai.title': 'OpenAI-Upstream-Konto verwenden',
    'managedPurpose.anthropic.title': 'Anthropic-Upstream-Konto verwenden',
  }),
  ru: Object.freeze({
    'managedPurpose.openai.title': 'Использовать вышестоящую учётную запись OpenAI',
    'managedPurpose.anthropic.title': 'Использовать вышестоящую учётную запись Anthropic',
  }),
  pl: Object.freeze({
    'managedPurpose.openai.title': 'Użyj nadrzędnego konta OpenAI',
    'managedPurpose.anthropic.title': 'Użyj nadrzędnego konta Anthropic',
  }),
  es: Object.freeze({
    'managedPurpose.openai.title': 'Usar la cuenta de OpenAI de origen',
    'managedPurpose.anthropic.title': 'Usar la cuenta de Anthropic de origen',
  }),
  fr: Object.freeze({
    'managedPurpose.openai.title': 'Utiliser le compte OpenAI en amont',
    'managedPurpose.anthropic.title': 'Utiliser le compte Anthropic en amont',
  }),
  it: Object.freeze({
    'managedPurpose.openai.title': 'Usa l’account OpenAI upstream',
    'managedPurpose.anthropic.title': 'Usa l’account Anthropic upstream',
  }),
  pt: Object.freeze({
    'managedPurpose.openai.title': 'Usar a conta OpenAI de origem',
    'managedPurpose.anthropic.title': 'Usar a conta Anthropic de origem',
  }),
  ca: Object.freeze({
    'managedPurpose.openai.title': 'Utilitza el compte OpenAI d’origen',
    'managedPurpose.anthropic.title': 'Utilitza el compte Anthropic d’origen',
  }),
  'zh-Hans': Object.freeze({
    'managedPurpose.openai.title': '使用上游 OpenAI 帐户',
    'managedPurpose.anthropic.title': '使用上游 Anthropic 帐户',
  }),
  'zh-Hant': Object.freeze({
    'managedPurpose.openai.title': '使用上游 OpenAI 帳戶',
    'managedPurpose.anthropic.title': '使用上游 Anthropic 帳戶',
  }),
  ja: Object.freeze({
    'managedPurpose.openai.title': '上流の OpenAI アカウントを使用',
    'managedPurpose.anthropic.title': '上流の Anthropic アカウントを使用',
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
