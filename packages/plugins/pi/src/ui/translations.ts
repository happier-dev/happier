export const PI_UI_TRANSLATIONS = Object.freeze({
  en: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Agent directory',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Optional Pi data root. Leave empty to use ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Storage',
    'settingsAgents.plugins.pi.sections.storage.footer': 'This directory is used only for Pi sessions started or discovered by Happier.',
  }),
  ru: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Каталог агента',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Необязательный корневой каталог данных Pi. Оставьте пустым, чтобы использовать ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Хранилище',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Этот каталог используется только для сеансов Pi, запущенных или обнаруженных Happier.',
  }),
  pl: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Katalog agenta',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Opcjonalny katalog główny danych Pi. Pozostaw puste, aby użyć ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Pamięć',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Ten katalog jest używany wyłącznie dla sesji Pi uruchomionych lub wykrytych przez Happier.',
  }),
  es: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Directorio del agente',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Raíz de datos opcional de Pi. Déjalo vacío para usar ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Almacenamiento',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Este directorio solo se usa para sesiones de Pi iniciadas o detectadas por Happier.',
  }),
  fr: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Répertoire de l’agent',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Racine de données Pi facultative. Laissez vide pour utiliser ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Stockage',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Ce répertoire sert uniquement aux sessions Pi lancées ou découvertes par Happier.',
  }),
  it: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Directory dell’agente',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Directory principale facoltativa dei dati di Pi. Lascia vuoto per usare ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Archiviazione',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Questa directory viene usata solo per le sessioni Pi avviate o rilevate da Happier.',
  }),
  pt: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Diretório do agente',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Raiz de dados opcional do Pi. Deixe em branco para usar ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Armazenamento',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Este diretório é usado apenas para sessões do Pi iniciadas ou detetadas pelo Happier.',
  }),
  ca: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'Directori de l’agent',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': 'Arrel de dades opcional de Pi. Deixa-ho buit per utilitzar ~/.pi/agent.',
    'settingsAgents.plugins.pi.sections.storage.title': 'Emmagatzematge',
    'settingsAgents.plugins.pi.sections.storage.footer': 'Aquest directori només s’utilitza per a sessions de Pi iniciades o detectades per Happier.',
  }),
  'zh-Hans': Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': '代理目录',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': '可选的 Pi 数据根目录。留空则使用 ~/.pi/agent。',
    'settingsAgents.plugins.pi.sections.storage.title': '存储',
    'settingsAgents.plugins.pi.sections.storage.footer': '此目录仅用于 Happier 启动或发现的 Pi 会话。',
  }),
  'zh-Hant': Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': '代理目錄',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': '可選的 Pi 資料根目錄。留空則使用 ~/.pi/agent。',
    'settingsAgents.plugins.pi.sections.storage.title': '儲存空間',
    'settingsAgents.plugins.pi.sections.storage.footer': '此目錄僅供 Happier 啟動或找到的 Pi 工作階段使用。',
  }),
  ja: Object.freeze({
    'settingsAgents.plugins.pi.title': 'Pi',
    'settingsAgents.plugins.pi.fields.piAgentDir.title': 'エージェントディレクトリ',
    'settingsAgents.plugins.pi.fields.piAgentDir.subtitle': '任意の Pi データルートです。空欄の場合は ~/.pi/agent を使用します。',
    'settingsAgents.plugins.pi.sections.storage.title': 'ストレージ',
    'settingsAgents.plugins.pi.sections.storage.footer': 'このディレクトリは、Happier が開始または検出した Pi セッションにのみ使用されます。',
  }),
});

export const PI_UI_TRANSLATION_BUNDLES = Object.freeze(
  Object.entries(PI_UI_TRANSLATIONS).map(([locale, messages]) => ({ locale, messages })),
);
