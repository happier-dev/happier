import type { SupportedLanguage } from '../_all';

const summary = {
    en: ['Installs {software}, then starts {name}.', 'Starts {name}.'],
    fr: ['Installe {software}, puis démarre {name}.', 'Démarre {name}.'],
    de: ['Installiert {software} und startet dann {name}.', 'Startet {name}.'],
    es: ['Instala {software} y después inicia {name}.', 'Inicia {name}.'],
    it: ['Installa {software}, poi avvia {name}.', 'Avvia {name}.'],
    pt: ['Instala {software} e depois inicia {name}.', 'Inicia {name}.'],
    ca: ['Instal·la {software} i després inicia {name}.', 'Inicia {name}.'],
    ja: ['{software}をインストールしてから{name}を起動します。', '{name}を起動します。'],
    ru: ['Установит {software}, затем запустит {name}.', 'Запустит {name}.'],
    pl: ['Instaluje {software}, a następnie uruchamia {name}.', 'Uruchamia {name}.'],
    'zh-Hans': ['安装{software}，然后启动{name}。', '启动{name}。'],
    'zh-Hant': ['安裝{software}，然後啟動{name}。', '啟動{name}。'],
} satisfies Record<SupportedLanguage, readonly [string, string]>;

const software = {
    en: ['Install', 'Found', 'Missing', 'Not known yet. Waiting for the chosen Machine.'],
    fr: ['Installer', 'Trouvé', 'Manquant', 'État inconnu. En attente de la machine choisie.'],
    de: ['Installieren', 'Gefunden', 'Fehlt', 'Noch unbekannt. Warten auf die gewählte Maschine.'],
    es: ['Instalar', 'Encontrado', 'Falta', 'Aún no se sabe. Esperando a la máquina elegida.'],
    it: ['Installa', 'Trovato', 'Mancante', 'Stato sconosciuto. In attesa della macchina scelta.'],
    pt: ['Instalar', 'Encontrado', 'Em falta', 'Ainda desconhecido. À espera da máquina escolhida.'],
    ca: ['Instal·la', 'Trobat', 'Falta', 'Encara no se sap. Esperant la màquina triada.'],
    ja: ['インストール', '検出済み', '未検出', 'まだ不明です。選択したマシンを待っています。'],
    ru: ['Установить', 'Найдено', 'Отсутствует', 'Пока неизвестно. Ожидание выбранной машины.'],
    pl: ['Zainstaluj', 'Znaleziono', 'Brak', 'Jeszcze nie wiadomo. Oczekiwanie na wybraną maszynę.'],
    'zh-Hans': ['安装', '已找到', '缺少', '尚不确定。正在等待所选机器。'],
    'zh-Hant': ['安裝', '已找到', '缺少', '尚不確定。正在等待所選機器。'],
} satisfies Record<SupportedLanguage, readonly string[]>;

function copy(words: readonly string[], language: SupportedLanguage) {
    return { connect: words[0]!, changeConnection: words[1]!, connectionSelected: words[2]!, keySelected: words[3]!,
        installThenStart: ({ software, name }: { software: string; name: string }) => summary[language][0]
            .replace('{software}', () => software).replace('{name}', () => name),
        startOnly: ({ name }: { name: string }) => summary[language][1].replace('{name}', () => name),
        skipNeed: words[4]!, useMcp: words[5]!, setupIncomplete: words[6]!,
        installSoftware: software[language][0]!, softwareFound: software[language][1]!,
        softwareMissing: software[language][2]!, softwareUnknown: software[language][3]! };
}
export const botTemplateSetupTranslations = {
    en: copy(['Connect', 'Change connection', 'Account selected', 'Saved key selected', 'Skip', 'Use this MCP server', 'Complete the required connections and inputs to continue.'], 'en'),
    fr: copy(['Connecter', 'Changer la connexion', 'Compte sélectionné', 'Clé enregistrée sélectionnée', 'Ignorer', 'Utiliser ce serveur MCP', 'Renseignez les connexions et les entrées requises pour continuer.'], 'fr'),
    de: copy(['Verbinden', 'Verbindung ändern', 'Konto ausgewählt', 'Gespeicherter Schlüssel ausgewählt', 'Überspringen', 'Diesen MCP-Server verwenden', 'Ergänze die erforderlichen Verbindungen und Eingaben, um fortzufahren.'], 'de'),
    es: copy(['Conectar', 'Cambiar conexión', 'Cuenta seleccionada', 'Clave guardada seleccionada', 'Omitir', 'Usar este servidor MCP', 'Completa las conexiones y entradas obligatorias para continuar.'], 'es'),
    it: copy(['Connetti', 'Cambia connessione', 'Account selezionato', 'Chiave salvata selezionata', 'Salta', 'Usa questo server MCP', 'Completa le connessioni e gli input obbligatori per continuare.'], 'it'),
    pt: copy(['Ligar', 'Alterar ligação', 'Conta selecionada', 'Chave guardada selecionada', 'Ignorar', 'Usar este servidor MCP', 'Preencha as ligações e entradas obrigatórias para continuar.'], 'pt'),
    ca: copy(['Connecta', 'Canvia la connexió', 'Compte seleccionat', 'Clau desada seleccionada', 'Omet', 'Fes servir aquest servidor MCP', 'Completa les connexions i entrades obligatòries per continuar.'], 'ca'),
    ja: copy(['接続', '接続を変更', 'アカウントを選択済み', '保存済みキーを選択済み', 'スキップ', 'このMCPサーバーを使用', '続行するには必須の接続と入力を設定してください。'], 'ja'),
    ru: copy(['Подключить', 'Изменить подключение', 'Учётная запись выбрана', 'Сохранённый ключ выбран', 'Пропустить', 'Использовать этот MCP-сервер', 'Заполните обязательные подключения и входные данные, чтобы продолжить.'], 'ru'),
    pl: copy(['Połącz', 'Zmień połączenie', 'Wybrano konto', 'Wybrano zapisany klucz', 'Pomiń', 'Użyj tego serwera MCP', 'Uzupełnij wymagane połączenia i dane wejściowe, aby kontynuować.'], 'pl'),
    'zh-Hans': copy(['连接', '更改连接', '已选择账户', '已选择保存的密钥', '跳过', '使用此MCP服务器', '请完成必需的连接和输入以继续。'], 'zh-Hans'),
    'zh-Hant': copy(['連接', '變更連接', '已選擇帳戶', '已選擇儲存的金鑰', '略過', '使用此MCP伺服器', '請完成必要的連接和輸入以繼續。'], 'zh-Hant'),
} satisfies Record<SupportedLanguage, ReturnType<typeof copy>>;
