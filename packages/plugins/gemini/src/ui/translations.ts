export const GEMINI_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'agentInput.connectedServiceLabel.gemini': 'Google Gemini',
  }),
  ru: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  pl: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  es: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  fr: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  it: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  pt: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  ca: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  'zh-Hans': Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  'zh-Hant': Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
  ja: Object.freeze({ 'agentInput.connectedServiceLabel.gemini': 'Google Gemini' }),
});

export const GEMINI_UI_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: GEMINI_UI_TRANSLATIONS.en },
  { locale: 'ru', messages: GEMINI_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: GEMINI_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: GEMINI_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: GEMINI_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: GEMINI_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: GEMINI_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: GEMINI_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: GEMINI_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: GEMINI_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: GEMINI_UI_TRANSLATIONS.ja },
] as const);
