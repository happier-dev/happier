export const COPILOT_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot',
  }),
  ru: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  pl: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  es: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  fr: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  it: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  pt: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  ca: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  'zh-Hans': Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  'zh-Hant': Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
  ja: Object.freeze({ 'agentInput.connectedServiceLabel.copilot': 'GitHub Copilot' }),
});

export const COPILOT_UI_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: COPILOT_UI_TRANSLATIONS.en },
  { locale: 'ru', messages: COPILOT_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: COPILOT_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: COPILOT_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: COPILOT_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: COPILOT_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: COPILOT_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: COPILOT_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: COPILOT_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: COPILOT_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: COPILOT_UI_TRANSLATIONS.ja },
] as const);
