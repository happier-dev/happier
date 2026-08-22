export const GROK_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (experimental)',
    'sessionInfo.grokSessionId': 'Grok session ID',
    'sessionInfo.grokSessionIdCopied': 'Grok session ID copied',
  }),
  ru: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (экспериментально)',
    'sessionInfo.grokSessionId': 'Идентификатор сессии Grok',
    'sessionInfo.grokSessionIdCopied': 'Идентификатор сессии Grok скопирован',
  }),
  pl: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (eksperymentalne)',
    'sessionInfo.grokSessionId': 'Identyfikator sesji Grok',
    'sessionInfo.grokSessionIdCopied': 'Skopiowano identyfikator sesji Grok',
  }),
  es: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (experimental)',
    'sessionInfo.grokSessionId': 'ID de sesión de Grok',
    'sessionInfo.grokSessionIdCopied': 'ID de sesión de Grok copiado',
  }),
  fr: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (expérimental)',
    'sessionInfo.grokSessionId': 'Identifiant de session Grok',
    'sessionInfo.grokSessionIdCopied': 'Identifiant de session Grok copié',
  }),
  it: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (sperimentale)',
    'sessionInfo.grokSessionId': 'ID sessione Grok',
    'sessionInfo.grokSessionIdCopied': 'ID sessione Grok copiato',
  }),
  pt: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (experimental)',
    'sessionInfo.grokSessionId': 'ID da sessão Grok',
    'sessionInfo.grokSessionIdCopied': 'ID da sessão Grok copiado',
  }),
  ca: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI (experimental)',
    'sessionInfo.grokSessionId': 'ID de sessió de Grok',
    'sessionInfo.grokSessionIdCopied': 'S’ha copiat l’ID de sessió de Grok',
  }),
  'zh-Hans': Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI（实验性）',
    'sessionInfo.grokSessionId': 'Grok 会话 ID',
    'sessionInfo.grokSessionIdCopied': '已复制 Grok 会话 ID',
  }),
  'zh-Hant': Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI（實驗性）',
    'sessionInfo.grokSessionId': 'Grok 工作階段 ID',
    'sessionInfo.grokSessionIdCopied': '已複製 Grok 工作階段 ID',
  }),
  ja: Object.freeze({
    'agentInput.agent.grok': 'Grok',
    'profiles.aiBackend.grokSubtitleExperimental': 'Grok Build CLI（実験的）',
    'sessionInfo.grokSessionId': 'Grok セッション ID',
    'sessionInfo.grokSessionIdCopied': 'Grok セッション ID をコピーしました',
  }),
});

export const GROK_UI_TRANSLATION_BUNDLES = Object.freeze([
  { locale: 'en', messages: GROK_UI_TRANSLATIONS.en },
  { locale: 'ru', messages: GROK_UI_TRANSLATIONS.ru },
  { locale: 'pl', messages: GROK_UI_TRANSLATIONS.pl },
  { locale: 'es', messages: GROK_UI_TRANSLATIONS.es },
  { locale: 'fr', messages: GROK_UI_TRANSLATIONS.fr },
  { locale: 'it', messages: GROK_UI_TRANSLATIONS.it },
  { locale: 'pt', messages: GROK_UI_TRANSLATIONS.pt },
  { locale: 'ca', messages: GROK_UI_TRANSLATIONS.ca },
  { locale: 'zh-Hans', messages: GROK_UI_TRANSLATIONS['zh-Hans'] },
  { locale: 'zh-Hant', messages: GROK_UI_TRANSLATIONS['zh-Hant'] },
  { locale: 'ja', messages: GROK_UI_TRANSLATIONS.ja },
] as const);
