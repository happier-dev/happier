/**
 * Copy for Find (⌘F, Find lab `ffind`): the shared Find bar's controls and count slot, the surface names
 * its field carries ("Find in chat"), and the quiet notes a surface shows under the bar when its search
 * cannot cover everything (older messages, offline, a terminal's kept scrollback).
 */
type FindTranslations = Readonly<{
    open: string;
    openedForMatch: string;
    foldAgain: string;
    showHiddenLines: (params: Readonly<{ count: number }>) => string;
    surface: Readonly<{
        chat: string;
        changes: string;
        file: string;
        terminal: (params: Readonly<{ name: string }>) => string;
    }>;
    previous: string;
    next: string;
    matchCase: string;
    regex: string;
    /** The regex switch's printed name on the phone's options row. */
    regexShort: string;
    /** The phone's options disclosure. */
    options: string;
    close: string;
    done: string;
    stop: string;
    noMatches: string;
    noneFound: string;
    invalidPattern: string;
    offline: string;
    unsupported: string;
    /** "3 of 8" with a current match, "8 matches" without one. */
    count: (params: Readonly<{ current: number | null; total: number }>) => string;
    files: (params: Readonly<{ count: number }>) => string;
    soFar: string;
    loaded: string;
    note: Readonly<{
        searchingOlder: string;
        offlineOlder: string;
        terminalKept: (params: Readonly<{ lines: string }>) => string;
    }>;
}>;

/** Polish and Russian pick one of three forms: one, a few (2–4, not 12–14), many. */
function slavicPlural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (count === 1) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/** Russian "one" also covers 21, 31… */
function russianPlural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

const en: FindTranslations = {
    open: 'Find…',
    openedForMatch: 'Opened for a match', foldAgain: 'Fold again', showHiddenLines: ({ count }) => `Show ${count} hidden ${count === 1 ? 'line' : 'lines'}`,
    surface: {
        chat: 'Find in chat',
        changes: 'Find in changes',
        file: 'Find in file',
        terminal: ({ name }) => `Find in ${name}`,
    },
    previous: 'Previous match',
    next: 'Next match',
    matchCase: 'Match case',
    regex: 'Use regular expression',
    regexShort: 'Regular expression',
    options: 'Match options',
    close: 'Close Find',
    done: 'Done',
    stop: 'Stop',
    noMatches: 'No matches',
    noneFound: 'None found',
    invalidPattern: 'Invalid pattern',
    offline: 'Offline',
    unsupported: 'Not searchable here',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'match' : 'matches'}` : `${current} of ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'file' : 'files'}`,
    soFar: 'so far',
    loaded: 'loaded',
    note: {
        searchingOlder: 'Looking through older messages, decrypted on this device',
        offlineOlder: 'Older messages can be searched once you’re back online.',
        terminalKept: ({ lines }) => `Searched the last ${lines} lines this terminal keeps.`,
    },
};

const ca: FindTranslations = {
    open: 'Cerca…',
    openedForMatch: 'Obert per una coincidència', foldAgain: 'Torna a plegar', showHiddenLines: ({ count }) => `Mostra ${count} línies ocultes`,
    surface: {
        chat: 'Cerca al xat',
        changes: 'Cerca als canvis',
        file: 'Cerca al fitxer',
        terminal: ({ name }) => `Cerca a ${name}`,
    },
    previous: 'Coincidència anterior',
    next: 'Coincidència següent',
    matchCase: 'Distingeix majúscules',
    regex: 'Usa una expressió regular',
    regexShort: 'Expressió regular',
    options: 'Opcions de cerca',
    close: 'Tanca la cerca',
    done: 'Fet',
    stop: 'Atura',
    noMatches: 'Cap coincidència',
    noneFound: 'No s’ha trobat res',
    invalidPattern: 'Patró no vàlid',
    offline: 'Sense connexió',
    unsupported: 'Aquí no es pot cercar',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'coincidència' : 'coincidències'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
    soFar: 'de moment',
    loaded: 'carregades',
    note: {
        searchingOlder: 'Revisant missatges anteriors, desxifrats en aquest dispositiu',
        offlineOlder: 'Podràs cercar els missatges anteriors quan tornis a estar en línia.',
        terminalKept: ({ lines }) => `S’han cercat les últimes ${lines} línies que conserva aquest terminal.`,
    },
};

const de: FindTranslations = {
    open: 'Suchen…',
    openedForMatch: 'Für einen Treffer geöffnet', foldAgain: 'Wieder einklappen', showHiddenLines: ({ count }) => `${count} ausgeblendete Zeilen anzeigen`,
    surface: {
        chat: 'Im Chat suchen',
        changes: 'In Änderungen suchen',
        file: 'In Datei suchen',
        terminal: ({ name }) => `In ${name} suchen`,
    },
    previous: 'Vorheriger Treffer',
    next: 'Nächster Treffer',
    matchCase: 'Groß-/Kleinschreibung beachten',
    regex: 'Regulären Ausdruck verwenden',
    regexShort: 'Regulärer Ausdruck',
    options: 'Suchoptionen',
    close: 'Suche schließen',
    done: 'Fertig',
    stop: 'Stopp',
    noMatches: 'Keine Treffer',
    noneFound: 'Nichts gefunden',
    invalidPattern: 'Ungültiges Muster',
    offline: 'Keine Verbindung',
    unsupported: 'Hier nicht durchsuchbar',
    count: ({ current, total }) => (current === null ? `${total} Treffer` : `${current} von ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
    soFar: 'bisher',
    loaded: 'geladen',
    note: {
        searchingOlder: 'Ältere Nachrichten werden durchsucht und auf diesem Gerät entschlüsselt',
        offlineOlder: 'Ältere Nachrichten lassen sich durchsuchen, sobald du wieder online bist.',
        terminalKept: ({ lines }) => `Die letzten ${lines} Zeilen durchsucht, die dieses Terminal behält.`,
    },
};

const es: FindTranslations = {
    open: 'Buscar…',
    openedForMatch: 'Abierto por una coincidencia', foldAgain: 'Volver a plegar', showHiddenLines: ({ count }) => `Mostrar ${count} líneas ocultas`,
    surface: {
        chat: 'Buscar en el chat',
        changes: 'Buscar en los cambios',
        file: 'Buscar en el archivo',
        terminal: ({ name }) => `Buscar en ${name}`,
    },
    previous: 'Coincidencia anterior',
    next: 'Coincidencia siguiente',
    matchCase: 'Distinguir mayúsculas',
    regex: 'Usar expresión regular',
    regexShort: 'Expresión regular',
    options: 'Opciones de búsqueda',
    close: 'Cerrar búsqueda',
    done: 'Listo',
    stop: 'Detener',
    noMatches: 'Sin coincidencias',
    noneFound: 'Nada encontrado',
    invalidPattern: 'Patrón no válido',
    offline: 'Sin conexión',
    unsupported: 'Aquí no se puede buscar',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'coincidencia' : 'coincidencias'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'archivo' : 'archivos'}`,
    soFar: 'por ahora',
    loaded: 'cargadas',
    note: {
        searchingOlder: 'Revisando mensajes anteriores, descifrados en este dispositivo',
        offlineOlder: 'Podrás buscar en los mensajes anteriores cuando vuelvas a estar en línea.',
        terminalKept: ({ lines }) => `Se buscó en las últimas ${lines} líneas que conserva este terminal.`,
    },
};

const fr: FindTranslations = {
    open: 'Rechercher…',
    openedForMatch: 'Ouvert pour une correspondance', foldAgain: 'Replier', showHiddenLines: ({ count }) => `Afficher ${count} lignes masquées`,
    surface: {
        chat: 'Rechercher dans le chat',
        changes: 'Rechercher dans les modifications',
        file: 'Rechercher dans le fichier',
        terminal: ({ name }) => `Rechercher dans ${name}`,
    },
    previous: 'Occurrence précédente',
    next: 'Occurrence suivante',
    matchCase: 'Respecter la casse',
    regex: 'Utiliser une expression régulière',
    regexShort: 'Expression régulière',
    options: 'Options de recherche',
    close: 'Fermer la recherche',
    done: 'Terminé',
    stop: 'Arrêter',
    noMatches: 'Aucune occurrence',
    noneFound: 'Rien trouvé',
    invalidPattern: 'Motif non valide',
    offline: 'Hors ligne',
    unsupported: 'Recherche impossible ici',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'occurrence' : 'occurrences'}` : `${current} sur ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
    soFar: 'pour l’instant',
    loaded: 'chargées',
    note: {
        searchingOlder: 'Recherche dans les messages plus anciens, déchiffrés sur cet appareil',
        offlineOlder: 'Les messages plus anciens pourront être recherchés une fois de retour en ligne.',
        terminalKept: ({ lines }) => `Recherche effectuée dans les ${lines} dernières lignes conservées par ce terminal.`,
    },
};

const it: FindTranslations = {
    open: 'Trova…',
    openedForMatch: 'Aperto per una corrispondenza', foldAgain: 'Comprimi di nuovo', showHiddenLines: ({ count }) => `Mostra ${count} righe nascoste`,
    surface: {
        chat: 'Trova nella chat',
        changes: 'Trova nelle modifiche',
        file: 'Trova nel file',
        terminal: ({ name }) => `Trova in ${name}`,
    },
    previous: 'Corrispondenza precedente',
    next: 'Corrispondenza successiva',
    matchCase: 'Maiuscole/minuscole',
    regex: 'Usa espressione regolare',
    regexShort: 'Espressione regolare',
    options: 'Opzioni di ricerca',
    close: 'Chiudi ricerca',
    done: 'Fine',
    stop: 'Interrompi',
    noMatches: 'Nessuna corrispondenza',
    noneFound: 'Nessun risultato',
    invalidPattern: 'Modello non valido',
    offline: 'Non in linea',
    unsupported: 'Qui non è possibile cercare',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'corrispondenza' : 'corrispondenze'}` : `${current} di ${total}`),
    files: ({ count }) => `${count} file`,
    soFar: 'finora',
    loaded: 'caricate',
    note: {
        searchingOlder: 'Ricerca nei messaggi meno recenti, decifrati su questo dispositivo',
        offlineOlder: 'Potrai cercare nei messaggi meno recenti quando tornerai online.',
        terminalKept: ({ lines }) => `Cercato nelle ultime ${lines} righe conservate da questo terminale.`,
    },
};

const ja: FindTranslations = {
    open: '検索…',
    openedForMatch: '一致箇所を表示しています', foldAgain: '再び折りたたむ', showHiddenLines: ({ count }) => `非表示の${count}行を表示`,
    surface: {
        chat: 'チャット内を検索',
        changes: '変更内を検索',
        file: 'ファイル内を検索',
        terminal: ({ name }) => `${name} 内を検索`,
    },
    previous: '前の一致',
    next: '次の一致',
    matchCase: '大文字と小文字を区別',
    regex: '正規表現を使用',
    regexShort: '正規表現',
    options: '検索オプション',
    close: '検索を閉じる',
    done: '完了',
    stop: '停止',
    noMatches: '一致なし',
    noneFound: '見つかりません',
    invalidPattern: '無効なパターン',
    offline: 'オフライン',
    unsupported: 'ここでは検索できません',
    count: ({ current, total }) => (current === null ? `${total} 件` : `${current} / ${total}`),
    files: ({ count }) => `${count} ファイル`,
    soFar: '（検索中）',
    loaded: '（読み込み済み）',
    note: {
        searchingOlder: '過去のメッセージを検索中（このデバイス上で復号）',
        offlineOlder: 'オンラインに戻ると過去のメッセージを検索できます。',
        terminalKept: ({ lines }) => `このターミナルが保持している直近 ${lines} 行を検索しました。`,
    },
};

const pl: FindTranslations = {
    open: 'Znajdź…',
    openedForMatch: 'Otwarto dla dopasowania', foldAgain: 'Zwiń ponownie', showHiddenLines: ({ count }) => `Pokaż ${count} ${slavicPlural(count, 'ukryty wiersz', 'ukryte wiersze', 'ukrytych wierszy')}`,
    surface: {
        chat: 'Znajdź w czacie',
        changes: 'Znajdź w zmianach',
        file: 'Znajdź w pliku',
        terminal: ({ name }) => `Znajdź w ${name}`,
    },
    previous: 'Poprzednie dopasowanie',
    next: 'Następne dopasowanie',
    matchCase: 'Uwzględniaj wielkość liter',
    regex: 'Użyj wyrażenia regularnego',
    regexShort: 'Wyrażenie regularne',
    options: 'Opcje wyszukiwania',
    close: 'Zamknij wyszukiwanie',
    done: 'Gotowe',
    stop: 'Zatrzymaj',
    noMatches: 'Brak dopasowań',
    noneFound: 'Nic nie znaleziono',
    invalidPattern: 'Nieprawidłowy wzorzec',
    offline: 'Brak połączenia',
    unsupported: 'Tu nie można wyszukiwać',
    count: ({ current, total }) => (current === null ? `${total} ${slavicPlural(total, 'dopasowanie', 'dopasowania', 'dopasowań')}` : `${current} z ${total}`),
    files: ({ count }) => `${count} ${slavicPlural(count, 'plik', 'pliki', 'plików')}`,
    soFar: 'na razie',
    loaded: 'wczytane',
    note: {
        searchingOlder: 'Przeszukiwanie starszych wiadomości, odszyfrowanych na tym urządzeniu',
        offlineOlder: 'Starsze wiadomości przeszukasz po powrocie do trybu online.',
        terminalKept: ({ lines }) => `Przeszukano ostatnie ${lines} wierszy przechowywanych przez ten terminal.`,
    },
};

const pt: FindTranslations = {
    open: 'Buscar…',
    openedForMatch: 'Aberto para uma correspondência', foldAgain: 'Recolher novamente', showHiddenLines: ({ count }) => `Mostrar ${count} linhas ocultas`,
    surface: {
        chat: 'Localizar no chat',
        changes: 'Localizar nas alterações',
        file: 'Localizar no arquivo',
        terminal: ({ name }) => `Localizar em ${name}`,
    },
    previous: 'Correspondência anterior',
    next: 'Próxima correspondência',
    matchCase: 'Diferenciar maiúsculas',
    regex: 'Usar expressão regular',
    regexShort: 'Expressão regular',
    options: 'Opções de pesquisa',
    close: 'Fechar busca',
    done: 'Concluído',
    stop: 'Parar',
    noMatches: 'Nenhuma correspondência',
    noneFound: 'Nada encontrado',
    invalidPattern: 'Padrão inválido',
    offline: 'Sem conexão',
    unsupported: 'Não é possível buscar aqui',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'correspondência' : 'correspondências'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
    soFar: 'até agora',
    loaded: 'carregadas',
    note: {
        searchingOlder: 'Buscando nas mensagens anteriores, descriptografadas neste dispositivo',
        offlineOlder: 'Você poderá buscar nas mensagens anteriores quando voltar a ficar online.',
        terminalKept: ({ lines }) => `Busca feita nas últimas ${lines} linhas que este terminal mantém.`,
    },
};

const ru: FindTranslations = {
    open: 'Найти…',
    openedForMatch: 'Открыто для совпадения', foldAgain: 'Свернуть снова', showHiddenLines: ({ count }) => `Показать ${count} ${russianPlural(count, 'скрытую строку', 'скрытые строки', 'скрытых строк')}`,
    surface: {
        chat: 'Найти в чате',
        changes: 'Найти в изменениях',
        file: 'Найти в файле',
        terminal: ({ name }) => `Найти в ${name}`,
    },
    previous: 'Предыдущее совпадение',
    next: 'Следующее совпадение',
    matchCase: 'Учитывать регистр',
    regex: 'Регулярное выражение',
    regexShort: 'Регулярное выражение',
    options: 'Параметры поиска',
    close: 'Закрыть поиск',
    done: 'Готово',
    stop: 'Остановить',
    noMatches: 'Нет совпадений',
    noneFound: 'Ничего не найдено',
    invalidPattern: 'Неверный шаблон',
    offline: 'Офлайн',
    unsupported: 'Здесь поиск недоступен',
    count: ({ current, total }) => (current === null ? `${total} ${russianPlural(total, 'совпадение', 'совпадения', 'совпадений')}` : `${current} из ${total}`),
    files: ({ count }) => `${count} ${russianPlural(count, 'файл', 'файла', 'файлов')}`,
    soFar: 'пока',
    loaded: 'загружено',
    note: {
        searchingOlder: 'Поиск по более ранним сообщениям, расшифрованным на этом устройстве',
        offlineOlder: 'Более ранние сообщения можно будет найти, когда вы снова будете онлайн.',
        terminalKept: ({ lines }) => `Поиск выполнен по последним ${lines} строкам, которые хранит этот терминал.`,
    },
};

const zhHans: FindTranslations = {
    open: '查找…',
    openedForMatch: '已展开匹配位置', foldAgain: '重新折叠', showHiddenLines: ({ count }) => `显示 ${count} 个隐藏行`,
    surface: {
        chat: '在聊天中查找',
        changes: '在更改中查找',
        file: '在文件中查找',
        terminal: ({ name }) => `在 ${name} 中查找`,
    },
    previous: '上一个匹配',
    next: '下一个匹配',
    matchCase: '区分大小写',
    regex: '使用正则表达式',
    regexShort: '正则表达式',
    options: '搜索选项',
    close: '关闭查找',
    done: '完成',
    stop: '停止',
    noMatches: '无匹配',
    noneFound: '未找到',
    invalidPattern: '无效的模式',
    offline: '离线',
    unsupported: '此处无法查找',
    count: ({ current, total }) => (current === null ? `${total} 个匹配` : `${current}/${total}`),
    files: ({ count }) => `${count} 个文件`,
    soFar: '（进行中）',
    loaded: '（已加载）',
    note: {
        searchingOlder: '正在查找较早的消息，在此设备上解密',
        offlineOlder: '恢复联网后即可查找较早的消息。',
        terminalKept: ({ lines }) => `已查找此终端保留的最近 ${lines} 行。`,
    },
};

const zhHant: FindTranslations = {
    open: '尋找…',
    openedForMatch: '已展開相符位置', foldAgain: '重新摺疊', showHiddenLines: ({ count }) => `顯示 ${count} 個隱藏行`,
    surface: {
        chat: '在聊天中尋找',
        changes: '在變更中尋找',
        file: '在檔案中尋找',
        terminal: ({ name }) => `在 ${name} 中尋找`,
    },
    previous: '上一個相符項目',
    next: '下一個相符項目',
    matchCase: '區分大小寫',
    regex: '使用規則運算式',
    regexShort: '規則運算式',
    options: '搜尋選項',
    close: '關閉尋找',
    done: '完成',
    stop: '停止',
    noMatches: '沒有相符項目',
    noneFound: '未找到',
    invalidPattern: '無效的模式',
    offline: '離線',
    unsupported: '此處無法尋找',
    count: ({ current, total }) => (current === null ? `${total} 個相符項目` : `${current}/${total}`),
    files: ({ count }) => `${count} 個檔案`,
    soFar: '（進行中）',
    loaded: '（已載入）',
    note: {
        searchingOlder: '正在尋找較早的訊息，於此裝置上解密',
        offlineOlder: '恢復連線後即可尋找較早的訊息。',
        terminalKept: ({ lines }) => `已尋找此終端機保留的最近 ${lines} 行。`,
    },
};

export const findTranslations = {
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
};
