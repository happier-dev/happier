export const CODEX_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (Experimental)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Speak directly with the active Codex agent session.',
  }),
  ru: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (экспериментально)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Говорите напрямую с активной сессией агента Codex.',
  }),
  pl: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (eksperymentalne)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Rozmawiaj bezpośrednio z aktywną sesją agenta Codex.',
  }),
  es: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (experimental)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Habla directamente con la sesión activa del agente Codex.',
  }),
  fr: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (expérimental)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Parlez directement avec la session active de l’agent Codex.',
  }),
  it: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (sperimentale)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Parla direttamente con la sessione attiva dell’agente Codex.',
  }),
  pt: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (experimental)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Fale diretamente com a sessão ativa do agente Codex.',
  }),
  ca: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime (experimental)',
    'settingsVoice.mode.codexRealtimeSubtitle': 'Parla directament amb la sessió activa de l’agent Codex.',
  }),
  'zh-Hans': Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex 实时模式（实验性）',
    'settingsVoice.mode.codexRealtimeSubtitle': '直接与当前 Codex 智能体会话交谈。',
  }),
  'zh-Hant': Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex 即時模式（實驗性）',
    'settingsVoice.mode.codexRealtimeSubtitle': '直接與目前的 Codex 代理程式工作階段交談。',
  }),
  ja: Object.freeze({
    'agentInput.connectedServiceLabel.codex': 'OpenAI Codex',
    'settingsVoice.mode.codexRealtime': 'Codex Realtime（実験的）',
    'settingsVoice.mode.codexRealtimeSubtitle': 'アクティブな Codex エージェントセッションと直接会話します。',
  }),
});

export const CODEX_UI_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: CODEX_UI_TRANSLATIONS.en },
  { locale: 'ru', messages: CODEX_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: CODEX_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: CODEX_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: CODEX_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: CODEX_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: CODEX_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: CODEX_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: CODEX_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: CODEX_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: CODEX_UI_TRANSLATIONS.ja },
] as const);
