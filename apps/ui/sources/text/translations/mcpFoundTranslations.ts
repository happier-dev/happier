// "Found on your machines" for MCP servers (P7 §T6/§T9): the servers each machine's agents already have set
// up, grouped by machine and Agent. Mounted under `capabilities.mcpFound`.

export type McpFoundTranslation = Readonly<{
  purpose: string;
  checkAgain: string;
  add: string;
  inHappier: string;
  setUpIn: (params: Readonly<{ agent: string }>) => string;
  offIn: (params: Readonly<{ agent: string }>) => string;
  looking: string;
  nothingHere: string;
  lastKnown: (params: Readonly<{ time: string }>) => string;
  offlineBring: (params: Readonly<{ machine: string }>) => string;
  offlineUnseen: (params: Readonly<{ count: number }>) => string;
  scanFailed: (params: Readonly<{ machine: string }>) => string;
  tryAgain: string;
  olderMachine: (params: Readonly<{ machine: string }>) => string;
  noMachinesTitle: string;
  noMachinesBody: string;
  warningReadFailed: (params: Readonly<{ agent: string }>) => string;
  warningReadFailedNoAgent: string;
  warningParseFailed: (params: Readonly<{ agent: string }>) => string;
  warningParseFailedNoAgent: string;
  warningUnsupported: (params: Readonly<{ agent: string }>) => string;
  warningUnsupportedNoAgent: string;
  quietEmpty: (params: Readonly<{ count: number; others: boolean }>) => string;
  quietLooking: (params: Readonly<{ count: number }>) => string;
}>;

const en: McpFoundTranslation = {
  purpose: 'MCP servers your agents already have set up on each machine. Add one to Happier and every session gets it, on every machine.',
  checkAgain: 'Check again',
  add: 'Add',
  inHappier: 'In Happier',
  setUpIn: ({ agent }) => `Set up in ${agent}`,
  offIn: ({ agent }) => `Off in ${agent}`,
  looking: 'Looking…',
  nothingHere: 'No MCP servers found here.',
  lastKnown: ({ time }) => `last known ${time}`,
  offlineBring: ({ machine }) => `Bring ${machine} online to add from it.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 offline machine hasn't been looked at yet. Bring it online to see its MCP servers.`
      : `${count} offline machines haven't been looked at yet. Bring one online to see its MCP servers.`,
  scanFailed: ({ machine }) => `Couldn't read ${machine}'s MCP servers`,
  tryAgain: 'Try again',
  olderMachine: ({ machine }) => `${machine} needs a newer Happier to list its MCP servers.`,
  noMachinesTitle: 'No machines yet',
  noMachinesBody: 'Connect a machine to see the MCP servers your agents already have set up on it.',
  warningReadFailed: ({ agent }) => `Couldn't read ${agent}'s MCP settings`,
  warningReadFailedNoAgent: "Couldn't read an MCP settings file",
  warningParseFailed: ({ agent }) => `Couldn't understand ${agent}'s MCP settings`,
  warningParseFailedNoAgent: "Couldn't understand an MCP settings file",
  warningUnsupported: ({ agent }) => `Some of ${agent}'s MCP servers can't be read yet`,
  warningUnsupportedNoAgent: "Some MCP servers here can't be read yet",
  quietEmpty: ({ count, others }) => `No MCP servers found on ${count} ${others ? 'other ' : ''}${count === 1 ? 'machine' : 'machines'}`,
  quietLooking: ({ count }) =>
    `Looking on ${count} ${count === 1 ? 'machine' : 'machines'}…`,
};

const ca: McpFoundTranslation = {
  purpose: 'Servidors MCP que els teus agents ja tenen configurats a cada màquina. Afegeix-ne un a Happier i totes les sessions el tindran, a totes les màquines.',
  checkAgain: 'Torna a comprovar',
  add: 'Afegeix',
  inHappier: 'A Happier',
  setUpIn: ({ agent }) => `Configurat a ${agent}`,
  offIn: ({ agent }) => `Desactivat a ${agent}`,
  looking: 'Cercant…',
  nothingHere: "No s'han trobat servidors MCP aquí.",
  lastKnown: ({ time }) => `últim conegut ${time}`,
  offlineBring: ({ machine }) => `Connecta ${machine} per afegir-ne des d'allà.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? "1 màquina fora de línia encara no s'ha revisat. Connecta-la per veure'n els servidors MCP."
      : `${count} màquines fora de línia encara no s'han revisat. Connecta'n una per veure'n els servidors MCP.`,
  scanFailed: ({ machine }) => `No s'han pogut llegir els servidors MCP de ${machine}`,
  tryAgain: 'Torna-ho a provar',
  olderMachine: ({ machine }) => `${machine} necessita un Happier més nou per llistar els seus servidors MCP.`,
  noMachinesTitle: 'Encara no hi ha màquines',
  noMachinesBody: 'Connecta una màquina per veure els servidors MCP que els teus agents ja hi tenen configurats.',
  warningReadFailed: ({ agent }) => `No s'ha pogut llegir la configuració MCP de ${agent}`,
  warningReadFailedNoAgent: "No s'ha pogut llegir un fitxer de configuració MCP",
  warningParseFailed: ({ agent }) => `No s'ha pogut interpretar la configuració MCP de ${agent}`,
  warningParseFailedNoAgent: "No s'ha pogut interpretar un fitxer de configuració MCP",
  warningUnsupported: ({ agent }) => `Alguns servidors MCP de ${agent} encara no es poden llegir`,
  warningUnsupportedNoAgent: "Alguns servidors MCP d'aquí encara no es poden llegir",
  quietEmpty: ({ count, others }) => `No s’ha trobat cap servidor MCP en ${count} ${count === 1 ? (others ? 'altra màquina' : 'màquina') : (others ? 'altres màquines' : 'màquines')}`,
  quietLooking: ({ count }) =>
    `Cercant en ${count} ${count === 1 ? 'màquina' : 'màquines'}…`,
};

const de: McpFoundTranslation = {
  purpose: 'MCP-Server, die deine Agenten auf jeder Maschine bereits eingerichtet haben. Füge einen zu Happier hinzu, und jede Sitzung bekommt ihn, auf jeder Maschine.',
  checkAgain: 'Erneut prüfen',
  add: 'Hinzufügen',
  inHappier: 'In Happier',
  setUpIn: ({ agent }) => `Eingerichtet in ${agent}`,
  offIn: ({ agent }) => `Aus in ${agent}`,
  looking: 'Wird gesucht…',
  nothingHere: 'Hier wurden keine MCP-Server gefunden.',
  lastKnown: ({ time }) => `zuletzt bekannt ${time}`,
  offlineBring: ({ machine }) => `Bring ${machine} online, um von dort hinzuzufügen.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 Offline-Maschine wurde noch nicht durchsucht. Bring sie online, um ihre MCP-Server zu sehen.'
      : `${count} Offline-Maschinen wurden noch nicht durchsucht. Bring eine online, um ihre MCP-Server zu sehen.`,
  scanFailed: ({ machine }) => `Die MCP-Server von ${machine} konnten nicht gelesen werden`,
  tryAgain: 'Erneut versuchen',
  olderMachine: ({ machine }) => `${machine} braucht ein neueres Happier, um seine MCP-Server aufzulisten.`,
  noMachinesTitle: 'Noch keine Maschinen',
  noMachinesBody: 'Verbinde eine Maschine, um die MCP-Server zu sehen, die deine Agenten dort schon eingerichtet haben.',
  warningReadFailed: ({ agent }) => `Die MCP-Einstellungen von ${agent} konnten nicht gelesen werden`,
  warningReadFailedNoAgent: 'Eine MCP-Einstellungsdatei konnte nicht gelesen werden',
  warningParseFailed: ({ agent }) => `Die MCP-Einstellungen von ${agent} konnten nicht verstanden werden`,
  warningParseFailedNoAgent: 'Eine MCP-Einstellungsdatei konnte nicht verstanden werden',
  warningUnsupported: ({ agent }) => `Einige MCP-Server von ${agent} können noch nicht gelesen werden`,
  warningUnsupportedNoAgent: 'Einige MCP-Server hier können noch nicht gelesen werden',
  quietEmpty: ({ count, others }) => `Keine MCP-Server auf ${count} ${others ? (count === 1 ? 'weiteren ' : 'weiteren ') : ''}${count === 1 ? 'Maschine' : 'Maschinen'} gefunden`,
  quietLooking: ({ count }) =>
    `Suche auf ${count} ${count === 1 ? 'Maschine' : 'Maschinen'}…`,
};

const es: McpFoundTranslation = {
  purpose: 'Servidores MCP que tus agentes ya tienen configurados en cada máquina. Añade uno a Happier y todas las sesiones lo tendrán, en todas las máquinas.',
  checkAgain: 'Volver a comprobar',
  add: 'Añadir',
  inHappier: 'En Happier',
  setUpIn: ({ agent }) => `Configurado en ${agent}`,
  offIn: ({ agent }) => `Desactivado en ${agent}`,
  looking: 'Buscando…',
  nothingHere: 'No se encontraron servidores MCP aquí.',
  lastKnown: ({ time }) => `último conocido ${time}`,
  offlineBring: ({ machine }) => `Conecta ${machine} para añadir desde allí.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 máquina sin conexión aún no se ha revisado. Conéctala para ver sus servidores MCP.'
      : `${count} máquinas sin conexión aún no se han revisado. Conecta una para ver sus servidores MCP.`,
  scanFailed: ({ machine }) => `No se pudieron leer los servidores MCP de ${machine}`,
  tryAgain: 'Reintentar',
  olderMachine: ({ machine }) => `${machine} necesita un Happier más reciente para listar sus servidores MCP.`,
  noMachinesTitle: 'Aún no hay máquinas',
  noMachinesBody: 'Conecta una máquina para ver los servidores MCP que tus agentes ya tienen configurados en ella.',
  warningReadFailed: ({ agent }) => `No se pudo leer la configuración MCP de ${agent}`,
  warningReadFailedNoAgent: 'No se pudo leer un archivo de configuración MCP',
  warningParseFailed: ({ agent }) => `No se pudo interpretar la configuración MCP de ${agent}`,
  warningParseFailedNoAgent: 'No se pudo interpretar un archivo de configuración MCP',
  warningUnsupported: ({ agent }) => `Algunos servidores MCP de ${agent} aún no se pueden leer`,
  warningUnsupportedNoAgent: 'Algunos servidores MCP de aquí aún no se pueden leer',
  quietEmpty: ({ count, others }) => `No se encontraron servidores MCP en ${count} ${count === 1 ? (others ? 'máquina más' : 'máquina') : (others ? 'máquinas más' : 'máquinas')}`,
  quietLooking: ({ count }) =>
    `Buscando en ${count} ${count === 1 ? 'máquina' : 'máquinas'}…`,
};

const fr: McpFoundTranslation = {
  purpose: 'Les serveurs MCP que vos agents ont déjà configurés sur chaque machine. Ajoutez-en un à Happier et chaque session l’aura, sur chaque machine.',
  checkAgain: 'Vérifier à nouveau',
  add: 'Ajouter',
  inHappier: 'Dans Happier',
  setUpIn: ({ agent }) => `Configuré dans ${agent}`,
  offIn: ({ agent }) => `Désactivé dans ${agent}`,
  looking: 'Recherche…',
  nothingHere: 'Aucun serveur MCP trouvé ici.',
  lastKnown: ({ time }) => `dernier état connu ${time}`,
  offlineBring: ({ machine }) => `Reconnectez ${machine} pour ajouter depuis cette machine.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 machine hors ligne n’a pas encore été examinée. Reconnectez-la pour voir ses serveurs MCP.'
      : `${count} machines hors ligne n’ont pas encore été examinées. Reconnectez-en une pour voir ses serveurs MCP.`,
  scanFailed: ({ machine }) => `Impossible de lire les serveurs MCP de ${machine}`,
  tryAgain: 'Réessayer',
  olderMachine: ({ machine }) => `${machine} a besoin d’une version plus récente de Happier pour lister ses serveurs MCP.`,
  noMachinesTitle: 'Aucune machine pour l’instant',
  noMachinesBody: 'Connectez une machine pour voir les serveurs MCP que vos agents y ont déjà configurés.',
  warningReadFailed: ({ agent }) => `Impossible de lire les réglages MCP de ${agent}`,
  warningReadFailedNoAgent: 'Impossible de lire un fichier de réglages MCP',
  warningParseFailed: ({ agent }) => `Impossible d’interpréter les réglages MCP de ${agent}`,
  warningParseFailedNoAgent: 'Impossible d’interpréter un fichier de réglages MCP',
  warningUnsupported: ({ agent }) => `Certains serveurs MCP de ${agent} ne peuvent pas encore être lus`,
  warningUnsupportedNoAgent: 'Certains serveurs MCP ici ne peuvent pas encore être lus',
  quietEmpty: ({ count, others }) => `Aucun serveur MCP trouvé sur ${count} ${count === 1 ? (others ? 'autre machine' : 'machine') : (others ? 'autres machines' : 'machines')}`,
  quietLooking: ({ count }) =>
    `Recherche sur ${count} ${count === 1 ? 'machine' : 'machines'}…`,
};

const it: McpFoundTranslation = {
  purpose: 'Server MCP che i tuoi agenti hanno già configurato su ogni macchina. Aggiungine uno a Happier e ogni sessione lo avrà, su ogni macchina.',
  checkAgain: 'Ricontrolla',
  add: 'Aggiungi',
  inHappier: 'In Happier',
  setUpIn: ({ agent }) => `Configurato in ${agent}`,
  offIn: ({ agent }) => `Disattivato in ${agent}`,
  looking: 'Ricerca…',
  nothingHere: 'Nessun server MCP trovato qui.',
  lastKnown: ({ time }) => `ultimo stato noto ${time}`,
  offlineBring: ({ machine }) => `Porta ${machine} online per aggiungere da lì.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 macchina offline non è ancora stata esaminata. Portala online per vederne i server MCP.'
      : `${count} macchine offline non sono ancora state esaminate. Portane una online per vederne i server MCP.`,
  scanFailed: ({ machine }) => `Impossibile leggere i server MCP di ${machine}`,
  tryAgain: 'Riprova',
  olderMachine: ({ machine }) => `${machine} richiede un Happier più recente per elencare i suoi server MCP.`,
  noMachinesTitle: 'Ancora nessuna macchina',
  noMachinesBody: 'Collega una macchina per vedere i server MCP che i tuoi agenti vi hanno già configurato.',
  warningReadFailed: ({ agent }) => `Impossibile leggere le impostazioni MCP di ${agent}`,
  warningReadFailedNoAgent: 'Impossibile leggere un file di impostazioni MCP',
  warningParseFailed: ({ agent }) => `Impossibile interpretare le impostazioni MCP di ${agent}`,
  warningParseFailedNoAgent: 'Impossibile interpretare un file di impostazioni MCP',
  warningUnsupported: ({ agent }) => `Alcuni server MCP di ${agent} non si possono ancora leggere`,
  warningUnsupportedNoAgent: 'Alcuni server MCP qui non si possono ancora leggere',
  quietEmpty: ({ count, others }) => `Nessun server MCP trovato su ${count} ${count === 1 ? (others ? 'altra macchina' : 'macchina') : (others ? 'altre macchine' : 'macchine')}`,
  quietLooking: ({ count }) =>
    `Ricerca su ${count} ${count === 1 ? 'macchina' : 'macchine'}…`,
};

const ja: McpFoundTranslation = {
  purpose: '各マシンでエージェントがすでに設定している MCP サーバーです。Happier に追加すると、すべてのマシンのすべてのセッションで使えます。',
  checkAgain: 'もう一度確認',
  add: '追加',
  inHappier: 'Happier に追加済み',
  setUpIn: ({ agent }) => `${agent} で設定`,
  offIn: ({ agent }) => `${agent} ではオフ`,
  looking: '確認中…',
  nothingHere: 'ここには MCP サーバーが見つかりません。',
  lastKnown: ({ time }) => `最終確認 ${time}`,
  offlineBring: ({ machine }) => `${machine} をオンラインにすると、ここから追加できます。`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? 'オフラインのマシン 1 台はまだ確認されていません。オンラインにすると MCP サーバーが表示されます。'
      : `オフラインのマシン ${count} 台はまだ確認されていません。オンラインにすると MCP サーバーが表示されます。`,
  scanFailed: ({ machine }) => `${machine} の MCP サーバーを読み取れませんでした`,
  tryAgain: '再試行',
  olderMachine: ({ machine }) => `${machine} の MCP サーバーを一覧表示するには、新しい Happier が必要です。`,
  noMachinesTitle: 'マシンがまだありません',
  noMachinesBody: 'マシンを接続すると、エージェントがすでに設定している MCP サーバーが表示されます。',
  warningReadFailed: ({ agent }) => `${agent} の MCP 設定を読み取れませんでした`,
  warningReadFailedNoAgent: 'MCP 設定ファイルを読み取れませんでした',
  warningParseFailed: ({ agent }) => `${agent} の MCP 設定を解釈できませんでした`,
  warningParseFailedNoAgent: 'MCP 設定ファイルを解釈できませんでした',
  warningUnsupported: ({ agent }) => `${agent} の一部の MCP サーバーはまだ読み取れません`,
  warningUnsupportedNoAgent: 'ここにある一部の MCP サーバーはまだ読み取れません',
  quietEmpty: ({ count, others }) => `${others ? 'ほかの' : ''}${count} 台のマシンでは MCP サーバーが見つかりませんでした`,
  quietLooking: ({ count }) =>
    `${count} 台のマシンを探しています…`,
};

const pl: McpFoundTranslation = {
  purpose: 'Serwery MCP, które Twoi agenci mają już skonfigurowane na każdej maszynie. Dodaj jeden do Happier, a każda sesja go dostanie, na każdej maszynie.',
  checkAgain: 'Sprawdź ponownie',
  add: 'Dodaj',
  inHappier: 'W Happier',
  setUpIn: ({ agent }) => `Skonfigurowany w ${agent}`,
  offIn: ({ agent }) => `Wyłączony w ${agent}`,
  looking: 'Szukanie…',
  nothingHere: 'Nie znaleziono tu serwerów MCP.',
  lastKnown: ({ time }) => `ostatnio znane ${time}`,
  offlineBring: ({ machine }) => `Połącz ${machine}, aby dodawać z tej maszyny.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 maszyna offline nie została jeszcze sprawdzona. Połącz ją, aby zobaczyć jej serwery MCP.'
      : `Maszyny offline (${count}) nie zostały jeszcze sprawdzone. Połącz jedną, aby zobaczyć jej serwery MCP.`,
  scanFailed: ({ machine }) => `Nie udało się odczytać serwerów MCP z ${machine}`,
  tryAgain: 'Spróbuj ponownie',
  olderMachine: ({ machine }) => `${machine} potrzebuje nowszego Happier, aby wyświetlić swoje serwery MCP.`,
  noMachinesTitle: 'Brak maszyn',
  noMachinesBody: 'Połącz maszynę, aby zobaczyć serwery MCP, które Twoi agenci już na niej skonfigurowali.',
  warningReadFailed: ({ agent }) => `Nie udało się odczytać ustawień MCP ${agent}`,
  warningReadFailedNoAgent: 'Nie udało się odczytać pliku ustawień MCP',
  warningParseFailed: ({ agent }) => `Nie udało się zinterpretować ustawień MCP ${agent}`,
  warningParseFailedNoAgent: 'Nie udało się zinterpretować pliku ustawień MCP',
  warningUnsupported: ({ agent }) => `Niektórych serwerów MCP ${agent} nie da się jeszcze odczytać`,
  warningUnsupportedNoAgent: 'Niektórych serwerów MCP tutaj nie da się jeszcze odczytać',
  quietEmpty: ({ count, others }) => `Nie znaleziono serwerów MCP na ${count} ${others ? 'innych ' : ''}maszynach`,
  quietLooking: ({ count }) =>
    `Szukanie na maszynach: ${count}…`,
};

const pt: McpFoundTranslation = {
  purpose: 'Servidores MCP que os seus agentes já configuraram em cada máquina. Adicione um ao Happier e todas as sessões o terão, em todas as máquinas.',
  checkAgain: 'Verificar novamente',
  add: 'Adicionar',
  inHappier: 'No Happier',
  setUpIn: ({ agent }) => `Configurado no ${agent}`,
  offIn: ({ agent }) => `Desativado no ${agent}`,
  looking: 'A procurar…',
  nothingHere: 'Nenhum servidor MCP encontrado aqui.',
  lastKnown: ({ time }) => `último conhecido ${time}`,
  offlineBring: ({ machine }) => `Ligue ${machine} para adicionar a partir dela.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 máquina offline ainda não foi verificada. Ligue-a para ver os seus servidores MCP.'
      : `${count} máquinas offline ainda não foram verificadas. Ligue uma para ver os seus servidores MCP.`,
  scanFailed: ({ machine }) => `Não foi possível ler os servidores MCP de ${machine}`,
  tryAgain: 'Tentar novamente',
  olderMachine: ({ machine }) => `${machine} precisa de um Happier mais recente para listar os seus servidores MCP.`,
  noMachinesTitle: 'Ainda sem máquinas',
  noMachinesBody: 'Ligue uma máquina para ver os servidores MCP que os seus agentes já configuraram nela.',
  warningReadFailed: ({ agent }) => `Não foi possível ler as definições MCP do ${agent}`,
  warningReadFailedNoAgent: 'Não foi possível ler um ficheiro de definições MCP',
  warningParseFailed: ({ agent }) => `Não foi possível interpretar as definições MCP do ${agent}`,
  warningParseFailedNoAgent: 'Não foi possível interpretar um ficheiro de definições MCP',
  warningUnsupported: ({ agent }) => `Alguns servidores MCP do ${agent} ainda não podem ser lidos`,
  warningUnsupportedNoAgent: 'Alguns servidores MCP aqui ainda não podem ser lidos',
  quietEmpty: ({ count, others }) => `Nenhum servidor MCP encontrado em ${count} ${count === 1 ? (others ? 'outra máquina' : 'máquina') : (others ? 'outras máquinas' : 'máquinas')}`,
  quietLooking: ({ count }) =>
    `A procurar em ${count} ${count === 1 ? 'máquina' : 'máquinas'}…`,
};

const ru: McpFoundTranslation = {
  purpose: 'MCP-серверы, которые ваши агенты уже настроили на каждой машине. Добавьте один в Happier — и он будет в каждой сессии, на каждой машине.',
  checkAgain: 'Проверить снова',
  add: 'Добавить',
  inHappier: 'В Happier',
  setUpIn: ({ agent }) => `Настроен в ${agent}`,
  offIn: ({ agent }) => `Выключен в ${agent}`,
  looking: 'Поиск…',
  nothingHere: 'MCP-серверы здесь не найдены.',
  lastKnown: ({ time }) => `последнее известное ${time}`,
  offlineBring: ({ machine }) => `Подключите ${machine}, чтобы добавлять с неё.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? '1 машина не в сети ещё не проверена. Подключите её, чтобы увидеть её MCP-серверы.'
      : `Машины не в сети (${count}) ещё не проверены. Подключите одну, чтобы увидеть её MCP-серверы.`,
  scanFailed: ({ machine }) => `Не удалось прочитать MCP-серверы на ${machine}`,
  tryAgain: 'Повторить',
  olderMachine: ({ machine }) => `${machine} нужна более новая версия Happier, чтобы показать её MCP-серверы.`,
  noMachinesTitle: 'Машин пока нет',
  noMachinesBody: 'Подключите машину, чтобы увидеть MCP-серверы, которые ваши агенты уже на ней настроили.',
  warningReadFailed: ({ agent }) => `Не удалось прочитать настройки MCP ${agent}`,
  warningReadFailedNoAgent: 'Не удалось прочитать файл настроек MCP',
  warningParseFailed: ({ agent }) => `Не удалось разобрать настройки MCP ${agent}`,
  warningParseFailedNoAgent: 'Не удалось разобрать файл настроек MCP',
  warningUnsupported: ({ agent }) => `Некоторые MCP-серверы ${agent} пока нельзя прочитать`,
  warningUnsupportedNoAgent: 'Некоторые MCP-серверы здесь пока нельзя прочитать',
  quietEmpty: ({ count, others }) => `MCP-серверы не найдены на ${others ? 'других ' : ''}машинах: ${count}`,
  quietLooking: ({ count }) =>
    `Поиск на машинах: ${count}…`,
};

const zhHans: McpFoundTranslation = {
  purpose: '你的代理已在各台机器上设置的 MCP 服务器。添加到 Happier 后，每台机器上的每个会话都能使用。',
  checkAgain: '再次检查',
  add: '添加',
  inHappier: '已在 Happier 中',
  setUpIn: ({ agent }) => `在 ${agent} 中设置`,
  offIn: ({ agent }) => `在 ${agent} 中已关闭`,
  looking: '正在查找…',
  nothingHere: '这里没有找到 MCP 服务器。',
  lastKnown: ({ time }) => `最后已知 ${time}`,
  offlineBring: ({ machine }) => `让 ${machine} 上线后即可从中添加。`,
  offlineUnseen: ({ count }) => `${count} 台离线机器尚未查看。让其上线即可看到它的 MCP 服务器。`,
  scanFailed: ({ machine }) => `无法读取 ${machine} 的 MCP 服务器`,
  tryAgain: '重试',
  olderMachine: ({ machine }) => `${machine} 需要更新的 Happier 才能列出其 MCP 服务器。`,
  noMachinesTitle: '还没有机器',
  noMachinesBody: '连接一台机器，即可看到你的代理已在其上设置的 MCP 服务器。',
  warningReadFailed: ({ agent }) => `无法读取 ${agent} 的 MCP 设置`,
  warningReadFailedNoAgent: '无法读取一个 MCP 设置文件',
  warningParseFailed: ({ agent }) => `无法解析 ${agent} 的 MCP 设置`,
  warningParseFailedNoAgent: '无法解析一个 MCP 设置文件',
  warningUnsupported: ({ agent }) => `${agent} 的部分 MCP 服务器暂时无法读取`,
  warningUnsupportedNoAgent: '这里的部分 MCP 服务器暂时无法读取',
  quietEmpty: ({ count, others }) => `在${others ? '其他 ' : ''} ${count} 台机器上未找到 MCP 服务器`,
  quietLooking: ({ count }) =>
    `正在 ${count} 台机器上查找…`,
};

const zhHant: McpFoundTranslation = {
  purpose: '你的代理已在各台機器上設定的 MCP 伺服器。加入 Happier 後，每台機器上的每個工作階段都能使用。',
  checkAgain: '再次檢查',
  add: '加入',
  inHappier: '已在 Happier 中',
  setUpIn: ({ agent }) => `在 ${agent} 中設定`,
  offIn: ({ agent }) => `在 ${agent} 中已關閉`,
  looking: '正在尋找…',
  nothingHere: '這裡沒有找到 MCP 伺服器。',
  lastKnown: ({ time }) => `最後已知 ${time}`,
  offlineBring: ({ machine }) => `讓 ${machine} 上線後即可從中加入。`,
  offlineUnseen: ({ count }) => `${count} 台離線機器尚未查看。讓其上線即可看到它的 MCP 伺服器。`,
  scanFailed: ({ machine }) => `無法讀取 ${machine} 的 MCP 伺服器`,
  tryAgain: '重試',
  olderMachine: ({ machine }) => `${machine} 需要更新的 Happier 才能列出其 MCP 伺服器。`,
  noMachinesTitle: '還沒有機器',
  noMachinesBody: '連接一台機器，即可看到你的代理已在其上設定的 MCP 伺服器。',
  warningReadFailed: ({ agent }) => `無法讀取 ${agent} 的 MCP 設定`,
  warningReadFailedNoAgent: '無法讀取一個 MCP 設定檔',
  warningParseFailed: ({ agent }) => `無法解析 ${agent} 的 MCP 設定`,
  warningParseFailedNoAgent: '無法解析一個 MCP 設定檔',
  warningUnsupported: ({ agent }) => `${agent} 的部分 MCP 伺服器暫時無法讀取`,
  warningUnsupportedNoAgent: '這裡的部分 MCP 伺服器暫時無法讀取',
  quietEmpty: ({ count, others }) => `在${others ? '其他 ' : ''} ${count} 台機器上未找到 MCP 伺服器`,
  quietLooking: ({ count }) =>
    `正在 ${count} 台機器上尋找…`,
};

export const mcpFoundTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  zhHans,
  zhHant,
} as const;
