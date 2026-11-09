// The MCP server Add modal (P7 U7.10): Catalog details, Paste a config and the Custom handoff. Mounted under
// `capabilities.mcpAdd`. Non-English locales carry the English block until the locale sweep.

type Count = Readonly<{ count: number }>;
type Source = Readonly<{ source: string }>;

const compact = (count: number): string =>
  count >= 1000
    ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
    : String(count);

export type McpAddTranslation = Readonly<{
  title: string;
  subtitle: string;
  modes: Readonly<{ catalog: string; paste: string; custom: string }>;
  searchPlaceholder: (params: Readonly<{ count: number | null }>) => string;
  groupAll: string;
  groupPicks: string;
  groupSource: (params: Source) => string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  nothingHere: string;
  clear: string;
  add: string;
  addServer: string;
  open: string;
  inCatalog: string;
  via: (params: Source) => string;
  detail: Readonly<{
    needsTitle: string;
    needsBody: string;
    nothingNeeded: string;
    keySaved: string;
    runsTitle: string;
    signInTitle: (params: Readonly<{ name: string }>) => string;
    signInBody: string;
    runsRemote: string;
    runsNpx: string;
    runsUvx: string;
    runsDocker: string;
    nextTitle: string;
    nextSaved: string;
    nextSavedKey: string;
    nextSignIn: string;
    nextSessions: string;
    nextUntouched: string;
    signInNote: (params: Readonly<{ host: string }>) => string;
    runsNote: string;
    stillNeeded: (params: Count) => string;
    unsupported: string;
    deprecated: string;
    loading: string;
    loadFailed: string;
    retry: string;
    chooseValue: string;
  }>;
  paste: Readonly<{
    label: string;
    placeholder: string;
    empty: string;
    found: (params: Count) => string;
    foundBody: string;
    local: string;
    remote: string;
    provenance: string;
    runsLocal: string;
    transport: string;
    http: string;
    sse: string;
    keySaved: (params: Readonly<{ key: string; name: string }>) => string;
    needsValues: string;
    otherValues: string;
    skipped: (params: Readonly<{ name: string }>) => string;
    skippedPaste: (params: Readonly<{ name: string }>) => string;
    addN: (params: Count) => string;
    footNote: string;
    stillNeeded: (params: Count) => string;
    unreadable: string;
    noServers: string;
    warnings: string;
    addFailed: string;
  }>;
  /** Custom (lab `n:custom`): how Happier reaches the server, then its own form. */
  custom: Readonly<{
    reachTitle: string;
    command: string;
    commandBody: string;
    remote: string;
    remoteBody: string;
    nothingSaved: string;
    runsCommand: string;
    runsRemote: string;
    needsCommand: string;
    needsAddress: string;
    needsName: string;
    adding: string;
  }>;
}>;

const en: McpAddTranslation = {
  title: 'Add an MCP server',
  subtitle: 'From a registry, a config you already use, or your own command.',
  modes: { catalog: 'Catalog', paste: 'Paste a config', custom: 'Custom' },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Search servers'
      : `Search ${compact(count)} servers`,
  groupAll: 'In your registries',
  groupPicks: 'Happier picks',
  groupSource: ({ source }) => `From ${source}`,
  noMatch: ({ query }) => `No servers match “${query}”`,
  nothingHere: 'Nothing to browse here yet',
  clear: 'Clear',
  add: 'Add',
  addServer: 'Add server',
  open: 'Open',
  inCatalog: 'Added',
  via: ({ source }) => `via ${source}`,
  detail: {
    needsTitle: 'What it needs',
    needsBody: 'From the server’s declared inputs.',
    nothingNeeded: 'Nothing to set up.',
    keySaved: 'A key is saved to your secrets. Only your devices can read it.',
    runsTitle: 'What runs where',
    signInTitle: ({ name }) => `Sign in to ${name}`,
    signInBody:
      'You approve access once, on any device. Every machine then uses that sign-in; agents never see the token.',
    runsRemote: 'Remote. Each machine connects to it directly.',
    runsNpx:
      'Runs on each machine with npx. Happier provides it, so there’s nothing to install.',
    runsUvx:
      'Runs on each machine with uvx. A machine without uv can’t start it yet.',
    runsDocker:
      'Runs in Docker on each machine, so Docker has to be installed there.',
    nextTitle: 'What happens next',
    nextSaved: 'It’s saved to your Account, end-to-end encrypted.',
    nextSavedKey:
      'It’s saved to your Account, end-to-end encrypted, with its key as a Saved Secret.',
    nextSignIn:
      'You sign in to it once, on this device; every machine then uses that sign-in.',
    nextSessions:
      'The next session on each machine gets it. Running sessions don’t change.',
    nextUntouched: 'Your agents’ own config files aren’t touched.',
    signInNote: ({ host }) => `Opens ${host} in your browser to approve.`,
    runsNote: 'Nothing runs until a session starts.',
    stillNeeded: ({ count }) =>
      count === 1 ? 'One value still needed' : `${count} values still needed`,
    unsupported: 'Happier can’t run this server’s package type yet.',
    deprecated: 'Marked deprecated in its registry.',
    loading: 'Reading it…',
    loadFailed: 'Couldn’t read this server. Try again.',
    retry: 'Try again',
    chooseValue: 'Needs a value',
  },
  paste: {
    label: 'Config to add',
    placeholder: '{ "mcpServers": { … } }   or an install link',
    empty: 'Paste a server config or an install link to see what it adds.',
    found: ({ count }) =>
      count === 1 ? 'Found 1 server' : `Found ${count} servers`,
    foundBody:
      'Nothing runs until you add them. Sign-ins and keys are asked for next.',
    local: 'Local',
    remote: 'Remote',
    provenance: 'From your paste',
    runsLocal: 'Runs on each machine with the command you pasted.',
    transport: 'Connects over',
    http: 'Streamable HTTP',
    sse: 'SSE',
    keySaved: ({ key, name }) =>
      `${key} was pasted as plain text. It will be saved as the secret ${name}, never kept in the config.`,
    needsValues: 'Needs a value',
    otherValues: 'Other values',
    skipped: ({ name }) => `${name} is already added. Skipped.`,
    skippedPaste: ({ name }) => `${name} appears twice in this paste. Skipped.`,
    addN: ({ count }) => (count === 1 ? 'Add server' : `Add ${count} servers`),
    footNote: 'Keys found in a paste are moved into Saved Secrets.',
    stillNeeded: ({ count }) =>
      count === 1 ? 'One value still needed' : `${count} values still needed`,
    unreadable: 'This isn’t a config or an install link Happier can read.',
    noServers: 'No servers in this paste.',
    warnings: 'Left out',
    addFailed: 'Couldn’t add these servers. Try again.',
  },
  custom: {
    reachTitle: 'How Happier reaches it',
    command: 'A command on your machines',
    commandBody: 'npx, uvx, docker or any program',
    remote: 'A remote address',
    remoteBody: 'Streamable HTTP or SSE, with headers',
    nothingSaved: 'Nothing is saved until you add it.',
    runsCommand: 'Runs on each machine with its command',
    runsRemote: 'Reached at its address from each session',
    needsCommand: 'Add the command it runs first.',
    needsAddress: 'Add a full https:// address first.',
    needsName: 'Name it in lowercase letters, digits, - or _.',
    adding: 'Adding…',
  },
};

const locales = [
  'en',
  'ca',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'pl',
  'pt',
  'ru',
  'zhHans',
  'zhHant',
] as const;

const localizedAddCopy = {
  ca: {
    title: 'Afegeix un servidor MCP',
    paste: { provenance: 'Del text que has enganxat', runsLocal: 'S’executa a cada màquina amb l’ordre que has enganxat.' },
    custom: {
      reachTitle: 'Com hi accedeix Happier',
      command: 'Una ordre a les teves màquines',
      commandBody: 'npx, uvx, docker o qualsevol programa',
      remote: 'Una adreça remota',
      remoteBody: 'Streamable HTTP o SSE, amb capçaleres',
      nothingSaved: 'No es desa res fins que l’afegeixes.',
      runsCommand: 'S’executa a cada màquina amb la seva ordre',
      runsRemote: 'Cada sessió hi accedeix a través de la seva adreça',
      needsCommand: 'Afegeix primer l’ordre que executa.',
      needsAddress: 'Afegeix primer una adreça https:// completa.',
      needsName: 'Fes servir lletres minúscules, dígits, - o _ per al nom.',
      adding: 'Afegint…',
    },
  },
  de: {
    title: 'MCP-Server hinzufügen',
    paste: { provenance: 'Aus deinem eingefügten Text', runsLocal: 'Läuft auf jedem Rechner mit dem eingefügten Befehl.' },
    custom: {
      reachTitle: 'So erreicht Happier den Server',
      command: 'Ein Befehl auf deinen Rechnern',
      commandBody: 'npx, uvx, docker oder ein anderes Programm',
      remote: 'Eine entfernte Adresse',
      remoteBody: 'Streamable HTTP oder SSE mit Headern',
      nothingSaved: 'Erst beim Hinzufügen wird etwas gespeichert.',
      runsCommand: 'Läuft auf jedem Rechner mit seinem Befehl',
      runsRemote: 'Jede Sitzung erreicht ihn über seine Adresse',
      needsCommand: 'Gib zuerst den auszuführenden Befehl ein.',
      needsAddress: 'Gib zuerst eine vollständige https://-Adresse ein.',
      needsName: 'Verwende Kleinbuchstaben, Ziffern, - oder _ für den Namen.',
      adding: 'Wird hinzugefügt…',
    },
  },
  es: {
    title: 'Añadir un servidor MCP',
    paste: { provenance: 'Del texto que has pegado', runsLocal: 'Se ejecuta en cada máquina con el comando que has pegado.' },
    custom: {
      reachTitle: 'Cómo accede Happier al servidor',
      command: 'Un comando en tus máquinas',
      commandBody: 'npx, uvx, docker o cualquier programa',
      remote: 'Una dirección remota',
      remoteBody: 'Streamable HTTP o SSE, con cabeceras',
      nothingSaved: 'No se guarda nada hasta que lo añades.',
      runsCommand: 'Se ejecuta en cada máquina con su comando',
      runsRemote: 'Cada sesión accede a él mediante su dirección',
      needsCommand: 'Añade primero el comando que ejecuta.',
      needsAddress: 'Añade primero una dirección https:// completa.',
      needsName: 'Usa letras minúsculas, dígitos, - o _ para el nombre.',
      adding: 'Añadiendo…',
    },
  },
  fr: {
    title: 'Ajouter un serveur MCP',
    paste: { provenance: 'Depuis le texte collé', runsLocal: 'S’exécute sur chaque machine avec la commande collée.' },
    custom: {
      reachTitle: 'Comment Happier accède au serveur',
      command: 'Une commande sur tes machines',
      commandBody: 'npx, uvx, docker ou tout autre programme',
      remote: 'Une adresse distante',
      remoteBody: 'Streamable HTTP ou SSE, avec des en-têtes',
      nothingSaved: 'Rien n’est enregistré avant l’ajout.',
      runsCommand: 'S’exécute sur chaque machine avec sa commande',
      runsRemote: 'Chaque session y accède à son adresse',
      needsCommand: 'Ajoute d’abord la commande à exécuter.',
      needsAddress: 'Ajoute d’abord une adresse https:// complète.',
      needsName: 'Utilise des lettres minuscules, des chiffres, - ou _ pour le nom.',
      adding: 'Ajout en cours…',
    },
  },
  it: {
    title: 'Aggiungi un server MCP',
    paste: { provenance: 'Dal testo che hai incollato', runsLocal: 'Viene eseguito su ogni macchina con il comando che hai incollato.' },
    custom: {
      reachTitle: 'Come Happier raggiunge il server',
      command: 'Un comando sulle tue macchine',
      commandBody: 'npx, uvx, docker o qualsiasi programma',
      remote: 'Un indirizzo remoto',
      remoteBody: 'Streamable HTTP o SSE, con intestazioni',
      nothingSaved: 'Non viene salvato nulla finché non lo aggiungi.',
      runsCommand: 'Viene eseguito su ogni macchina con il suo comando',
      runsRemote: 'Ogni sessione lo raggiunge al suo indirizzo',
      needsCommand: 'Aggiungi prima il comando da eseguire.',
      needsAddress: 'Aggiungi prima un indirizzo https:// completo.',
      needsName: 'Usa lettere minuscole, cifre, - o _ per il nome.',
      adding: 'Aggiunta in corso…',
    },
  },
  ja: {
    title: 'MCP サーバーを追加',
    paste: { provenance: '貼り付けた内容から', runsLocal: '貼り付けたコマンドで各マシン上で実行されます。' },
    custom: {
      reachTitle: 'Happier の接続方法',
      command: '各マシン上のコマンド',
      commandBody: 'npx、uvx、docker などのプログラム',
      remote: 'リモートアドレス',
      remoteBody: 'ヘッダー付きの Streamable HTTP または SSE',
      nothingSaved: '追加するまで何も保存されません。',
      runsCommand: '各マシン上で指定のコマンドを実行します',
      runsRemote: '各セッションから指定のアドレスに接続します',
      needsCommand: 'まず実行するコマンドを追加してください。',
      needsAddress: 'まず完全な https:// アドレスを追加してください。',
      needsName: '名前には英小文字、数字、-、_ を使用してください。',
      adding: '追加中…',
    },
  },
  pl: {
    title: 'Dodaj serwer MCP',
    paste: { provenance: 'Z wklejonego tekstu', runsLocal: 'Działa na każdej maszynie z użyciem wklejonego polecenia.' },
    custom: {
      reachTitle: 'Jak Happier łączy się z serwerem',
      command: 'Polecenie na twoich maszynach',
      commandBody: 'npx, uvx, docker lub dowolny program',
      remote: 'Adres zdalny',
      remoteBody: 'Streamable HTTP lub SSE z nagłówkami',
      nothingSaved: 'Nic nie zostanie zapisane, dopóki go nie dodasz.',
      runsCommand: 'Działa na każdej maszynie z użyciem swojego polecenia',
      runsRemote: 'Każda sesja łączy się z jego adresem',
      needsCommand: 'Najpierw dodaj polecenie do uruchomienia.',
      needsAddress: 'Najpierw dodaj pełny adres https://.',
      needsName: 'Użyj w nazwie małych liter, cyfr, - lub _.',
      adding: 'Dodawanie…',
    },
  },
  pt: {
    title: 'Adicionar um servidor MCP',
    paste: { provenance: 'Do texto que você colou', runsLocal: 'Executa em cada máquina com o comando que você colou.' },
    custom: {
      reachTitle: 'Como o Happier acessa o servidor',
      command: 'Um comando nas suas máquinas',
      commandBody: 'npx, uvx, docker ou qualquer programa',
      remote: 'Um endereço remoto',
      remoteBody: 'Streamable HTTP ou SSE, com cabeçalhos',
      nothingSaved: 'Nada é salvo até você adicioná-lo.',
      runsCommand: 'Executa em cada máquina com seu comando',
      runsRemote: 'Cada sessão acessa seu endereço',
      needsCommand: 'Primeiro, adicione o comando a executar.',
      needsAddress: 'Primeiro, adicione um endereço https:// completo.',
      needsName: 'Use letras minúsculas, dígitos, - ou _ no nome.',
      adding: 'Adicionando…',
    },
  },
  ru: {
    title: 'Добавить MCP-сервер',
    paste: { provenance: 'Из вставленного текста', runsLocal: 'Запускается на каждой машине с помощью вставленной команды.' },
    custom: {
      reachTitle: 'Как Happier подключается к серверу',
      command: 'Команда на ваших машинах',
      commandBody: 'npx, uvx, docker или любая программа',
      remote: 'Удалённый адрес',
      remoteBody: 'Streamable HTTP или SSE с заголовками',
      nothingSaved: 'Ничего не сохраняется до добавления.',
      runsCommand: 'Запускается на каждой машине своей командой',
      runsRemote: 'Каждая сессия подключается к его адресу',
      needsCommand: 'Сначала добавьте команду для запуска.',
      needsAddress: 'Сначала добавьте полный адрес https://.',
      needsName: 'Используйте в имени строчные латинские буквы, цифры, - или _.',
      adding: 'Добавление…',
    },
  },
  zhHans: {
    title: '添加 MCP 服务器',
    paste: { provenance: '来自粘贴的内容', runsLocal: '使用粘贴的命令在每台机器上运行。' },
    custom: {
      reachTitle: 'Happier 如何连接服务器',
      command: '在你的机器上运行命令',
      commandBody: 'npx、uvx、docker 或任何程序',
      remote: '远程地址',
      remoteBody: '带请求头的 Streamable HTTP 或 SSE',
      nothingSaved: '添加之前不会保存任何内容。',
      runsCommand: '使用指定命令在每台机器上运行',
      runsRemote: '每个会话通过指定地址连接',
      needsCommand: '请先添加要运行的命令。',
      needsAddress: '请先添加完整的 https:// 地址。',
      needsName: '名称请使用小写英文字母、数字、- 或 _。',
      adding: '正在添加…',
    },
  },
  zhHant: {
    title: '新增 MCP 伺服器',
    paste: { provenance: '來自貼上的內容', runsLocal: '使用貼上的命令在每台機器上執行。' },
    custom: {
      reachTitle: 'Happier 如何連線至伺服器',
      command: '在你的機器上執行命令',
      commandBody: 'npx、uvx、docker 或任何程式',
      remote: '遠端位址',
      remoteBody: '帶請求標頭的 Streamable HTTP 或 SSE',
      nothingSaved: '新增之前不會儲存任何內容。',
      runsCommand: '使用指定命令在每台機器上執行',
      runsRemote: '每個工作階段透過指定位址連線',
      needsCommand: '請先新增要執行的命令。',
      needsAddress: '請先新增完整的 https:// 位址。',
      needsName: '名稱請使用小寫英文字母、數字、- 或 _。',
      adding: '正在新增…',
    },
  },
} satisfies Record<Exclude<(typeof locales)[number], 'en'>,
  Pick<McpAddTranslation, 'title' | 'custom'> & { paste: Pick<McpAddTranslation['paste'], 'provenance' | 'runsLocal'> }>;

export const mcpAddTranslations = Object.fromEntries(
  locales.map((locale) => [locale, locale === 'en' ? en : {
    ...en,
    ...localizedAddCopy[locale],
    paste: { ...en.paste, ...localizedAddCopy[locale].paste },
  }]),
) as Record<(typeof locales)[number], McpAddTranslation>;
