type Count = Readonly<{ count: number }>;
type Labels = Readonly<{
  title: string;
  purpose: string;
  searchPlaceholder: string;
  groupBy: string;
  groupKind: string;
  groupMachine: string;
  groupProject: string;
  status: string;
  /** The present-tense line: what is managed, and on how many Machines when that is known. */
  present: (params: Count) => string;
  presentAcross: (
    params: Readonly<{ count: number; machines: number }>,
  ) => string;
  needYou: (params: Count) => string;
  /** Plugins that ship with Happier, counted apart from what the person added. */
  includedMore: (params: Count) => string;
  includedBody: string;
  partial: string;
  needsYou: string;
  all: (params: Count) => string;
  allUnknown: string;
  fewer: string;
  /** A kind section with nothing from the Machines that answered, and its way to browse that kind. */
  sectionNone: string;
  browserProfileEmpty: string;
  browseKind: string;
  sectionUnavailable: string;
  sectionPartial: string;
  /** A read that settled short of everything (a Machine or source didn't answer): no pending glyph. */
  sectionIncomplete: string;
  accountGroup: string;
  accountGroupBody: string;
  unassignedGroup: string;
  unassignedGroupBody: string;
  noProjectGroup: string;
  noProjectGroupBody: string;
  everyMachine: string;
  /** An App whose own page doesn't exist yet: said, never a spinner or a guessed route. */
  appNoPage: string;
  machineFallback: string;
  emptyTitle: string;
  emptyBody: string;
  browse: string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  noMatchFilters: string;
  clear: string;
  unavailable: string;
  machineTitle: string;
  machineBody: string;
  openInInstalled: string;
}>;

export const storeInstalledTranslations = {
  en: {
    title: 'Installed',
    purpose:
      'Everything Happier manages, on every Machine and in every project: where it runs, whether it’s fine, and what needs you.',
    searchPlaceholder: 'Search everything Happier manages',
    groupBy: 'Group by',
    groupKind: 'Kind',
    groupMachine: 'Machine',
    groupProject: 'Project',
    status: 'Status',
    present: ({ count }) =>
      count === 1
        ? 'Happier manages 1 thing for you.'
        : `Happier manages ${count} things for you.`,
    presentAcross: ({ count, machines }) =>
      `Happier manages ${count === 1 ? '1 thing' : `${count} things`} across ${machines === 1 ? '1 Machine' : `${machines} Machines`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 needs you.' : `${count} need you.`,
    includedMore: ({ count }) => `${count} more ${count === 1 ? 'is' : 'are'} included with Happier.`,
    includedBody: 'These ship with Happier and update with it.',
    partial: 'Some of it hasn’t loaded yet, so this may not be everything.',
    needsYou: 'Needs you',
    all: ({ count }) => `All ${count}`,
    allUnknown: 'All',
    fewer: 'Fewer',
    sectionNone: 'Nothing yet.',
    browserProfileEmpty: 'Browser profile with no extensions yet',
    browseKind: 'Browse',
    sectionUnavailable: 'Couldn’t load these right now.',
    sectionPartial: 'Some of these haven’t loaded yet.',
    sectionIncomplete: 'Some of these couldn’t be read, so this may not be everything.',
    accountGroup: 'Your account',
    accountGroupBody: 'Not tied to one Machine or project.',
    unassignedGroup: 'Not placed yet',
    unassignedGroupBody: 'Where these run isn’t known yet.',
    noProjectGroup: 'No project',
    noProjectGroupBody: 'Not associated with a project.',
    everyMachine: 'Every Machine',
    appNoPage: 'No page to open yet',
    machineFallback: 'A Machine',
    emptyTitle: 'Nothing here yet',
    emptyBody:
      'MCP servers, skills, agents, providers and plugins you add show up here, with where they run and what needs you.',
    browse: 'Browse the Store',
    noMatch: ({ query }) => `Nothing matches “${query}”`,
    noMatchFilters: 'Nothing matches these filters',
    clear: 'Clear',
    unavailable: 'Installed can’t be shown for this account right now.',
    machineTitle: 'What’s on this Machine',
    machineBody: 'Everything Happier manages here.',
    openInInstalled: 'Open in Installed',
  },
  fr: {
    title: 'Installé',
    purpose:
      'Tout ce que Happier gère, sur chaque Machine et dans chaque projet : où ça tourne, si tout va bien, et ce qui a besoin de vous.',
    searchPlaceholder: 'Rechercher dans tout ce que Happier gère',
    groupBy: 'Grouper par',
    groupKind: 'Type',
    groupMachine: 'Machine',
    groupProject: 'Projet',
    status: 'État',
    present: ({ count }) =>
      count === 1
        ? 'Happier gère 1 élément pour vous.'
        : `Happier gère ${count} éléments pour vous.`,
    presentAcross: ({ count, machines }) =>
      `Happier gère ${count === 1 ? '1 élément' : `${count} éléments`} sur ${machines === 1 ? '1 machine' : `${machines} machines`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 a besoin de vous.' : `${count} ont besoin de vous.`,
    includedMore: ({ count }) => `${count} de plus ${count === 1 ? 'est inclus' : 'sont inclus'} avec Happier.`,
    includedBody: 'Ils sont livrés avec Happier et se mettent à jour avec lui.',
    partial:
      'Une partie n’est pas encore chargée : ce n’est peut-être pas tout.',
    needsYou: 'Besoin de vous',
    all: ({ count }) => `Tout (${count})`,
    allUnknown: 'Tout',
    fewer: 'Moins',
    sectionNone: 'Rien pour l’instant.',
    browserProfileEmpty: 'Profil de navigateur, sans extension pour l’instant',
    browseKind: 'Parcourir',
    sectionUnavailable: 'Impossible de les charger pour le moment.',
    sectionPartial: 'Une partie n’est pas encore chargée.',
    sectionIncomplete: 'Une partie n’a pas pu être lue ; la liste n’est peut-être pas complète.',
    accountGroup: 'Votre compte',
    accountGroupBody: 'Lié à aucune Machine ni à aucun projet.',
    unassignedGroup: 'Emplacement inconnu',
    unassignedGroupBody: 'On ne sait pas encore où ils tournent.',
    noProjectGroup: 'Aucun projet',
    noProjectGroupBody: 'Associé à aucun projet.',
    everyMachine: 'Toutes les machines',
    appNoPage: 'Pas encore de page à ouvrir',
    machineFallback: 'Une Machine',
    emptyTitle: 'Rien pour l’instant',
    emptyBody:
      'Les serveurs MCP, skills, agents, fournisseurs et plugins que vous ajoutez apparaissent ici, avec l’endroit où ils tournent et ce qui a besoin de vous.',
    browse: 'Parcourir le Store',
    noMatch: ({ query }) => `Aucun résultat pour « ${query} »`,
    noMatchFilters: 'Aucun résultat avec ces filtres',
    clear: 'Effacer',
    unavailable:
      'Installé ne peut pas être affiché pour ce compte pour le moment.',
    machineTitle: 'Sur cette Machine',
    machineBody: 'Tout ce que Happier gère ici.',
    openInInstalled: 'Ouvrir dans Installé',
  },
  de: {
    title: 'Installiert',
    purpose:
      'Alles, was Happier verwaltet, auf jeder Machine und in jedem Projekt: wo es läuft, ob alles in Ordnung ist und was dich braucht.',
    searchPlaceholder: 'Alles durchsuchen, was Happier verwaltet',
    groupBy: 'Gruppieren nach',
    groupKind: 'Art',
    groupMachine: 'Machine',
    groupProject: 'Projekt',
    status: 'Status',
    present: ({ count }) =>
      count === 1
        ? 'Happier verwaltet 1 Element für dich.'
        : `Happier verwaltet ${count} Elemente für dich.`,
    presentAcross: ({ count, machines }) =>
      `Happier verwaltet ${count === 1 ? '1 Element' : `${count} Elemente`} auf ${machines === 1 ? '1 Rechner' : `${machines} Rechner`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 braucht dich.' : `${count} brauchen dich.`,
    includedMore: ({ count }) => `${count} weitere ${count === 1 ? 'ist' : 'sind'} in Happier enthalten.`,
    includedBody: 'Sie kommen mit Happier und werden mit Happier aktualisiert.',
    partial: 'Ein Teil ist noch nicht geladen, das ist vielleicht nicht alles.',
    needsYou: 'Braucht dich',
    all: ({ count }) => `Alle ${count}`,
    allUnknown: 'Alle',
    fewer: 'Weniger',
    sectionNone: 'Noch nichts.',
    browserProfileEmpty: 'Browserprofil, noch ohne Erweiterungen',
    browseKind: 'Durchsuchen',
    sectionUnavailable: 'Konnte gerade nicht geladen werden.',
    sectionPartial: 'Ein Teil ist noch nicht geladen.',
    sectionIncomplete: 'Ein Teil konnte nicht gelesen werden; die Liste ist vielleicht nicht vollständig.',
    accountGroup: 'Dein Konto',
    accountGroupBody: 'An keine Machine und kein Projekt gebunden.',
    unassignedGroup: 'Noch ohne Ort',
    unassignedGroupBody: 'Wo diese laufen, ist noch nicht bekannt.',
    noProjectGroup: 'Kein Projekt',
    noProjectGroupBody: 'Keinem Projekt zugeordnet.',
    everyMachine: 'Alle Rechner',
    appNoPage: 'Noch keine Seite zum Öffnen',
    machineFallback: 'Eine Machine',
    emptyTitle: 'Noch nichts hier',
    emptyBody:
      'MCP-Server, Skills, Agents, Anbieter und Plugins, die du hinzufügst, erscheinen hier – mit Ort und dem, was dich braucht.',
    browse: 'Store durchsuchen',
    noMatch: ({ query }) => `Keine Treffer für „${query}“`,
    noMatchFilters: 'Keine Treffer für diese Filter',
    clear: 'Zurücksetzen',
    unavailable:
      'Installiert kann für dieses Konto gerade nicht angezeigt werden.',
    machineTitle: 'Auf dieser Machine',
    machineBody: 'Alles, was Happier hier verwaltet.',
    openInInstalled: 'In Installiert öffnen',
  },
  es: {
    title: 'Instalado',
    purpose:
      'Todo lo que Happier gestiona, en cada Machine y en cada proyecto: dónde se ejecuta, si va bien y qué te necesita.',
    searchPlaceholder: 'Buscar en todo lo que Happier gestiona',
    groupBy: 'Agrupar por',
    groupKind: 'Tipo',
    groupMachine: 'Machine',
    groupProject: 'Proyecto',
    status: 'Estado',
    present: ({ count }) =>
      count === 1
        ? 'Happier gestiona 1 elemento por ti.'
        : `Happier gestiona ${count} elementos por ti.`,
    presentAcross: ({ count, machines }) =>
      `Happier gestiona ${count === 1 ? '1 elemento' : `${count} elementos`} en ${machines === 1 ? '1 máquina' : `${machines} máquinas`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 te necesita.' : `${count} te necesitan.`,
    includedMore: ({ count }) => `${count} más ${count === 1 ? 'viene incluido' : 'vienen incluidos'} con Happier.`,
    includedBody: 'Vienen con Happier y se actualizan con él.',
    partial: 'Una parte aún no se ha cargado, así que puede que no esté todo.',
    needsYou: 'Te necesita',
    all: ({ count }) => `Todos (${count})`,
    allUnknown: 'Todos',
    fewer: 'Menos',
    sectionNone: 'Todavía nada.',
    browserProfileEmpty: 'Perfil de navegador, aún sin extensiones',
    browseKind: 'Explorar',
    sectionUnavailable: 'No se pudieron cargar ahora.',
    sectionPartial: 'Una parte aún no se ha cargado.',
    sectionIncomplete: 'Una parte no se pudo leer; puede que no esté todo.',
    accountGroup: 'Tu cuenta',
    accountGroupBody: 'No está ligado a una Machine ni a un proyecto.',
    unassignedGroup: 'Sin ubicación aún',
    unassignedGroupBody: 'Aún no se sabe dónde se ejecutan.',
    noProjectGroup: 'Sin proyecto',
    noProjectGroupBody: 'No están asociados a ningún proyecto.',
    everyMachine: 'Todas las máquinas',
    appNoPage: 'Aún no hay página para abrir',
    machineFallback: 'Una Machine',
    emptyTitle: 'Aún no hay nada',
    emptyBody:
      'Los servidores MCP, skills, agentes, proveedores y plugins que añadas aparecen aquí, con dónde se ejecutan y qué te necesita.',
    browse: 'Explorar la Store',
    noMatch: ({ query }) => `Nada coincide con «${query}»`,
    noMatchFilters: 'Nada coincide con estos filtros',
    clear: 'Borrar',
    unavailable: 'Instalado no se puede mostrar para esta cuenta ahora.',
    machineTitle: 'En esta Machine',
    machineBody: 'Todo lo que Happier gestiona aquí.',
    openInInstalled: 'Abrir en Instalado',
  },
  ca: {
    title: 'Instal·lat',
    purpose:
      'Tot el que Happier gestiona, a cada Machine i a cada projecte: on s’executa, si va bé i què et necessita.',
    searchPlaceholder: 'Cerca en tot el que Happier gestiona',
    groupBy: 'Agrupa per',
    groupKind: 'Tipus',
    groupMachine: 'Machine',
    groupProject: 'Projecte',
    status: 'Estat',
    present: ({ count }) =>
      count === 1
        ? 'Happier gestiona 1 element per tu.'
        : `Happier gestiona ${count} elements per tu.`,
    presentAcross: ({ count, machines }) =>
      `Happier gestiona ${count === 1 ? '1 element' : `${count} elements`} a ${machines === 1 ? '1 màquina' : `${machines} màquines`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 et necessita.' : `${count} et necessiten.`,
    includedMore: ({ count }) => `${count} més ${count === 1 ? 've inclòs' : 'vénen inclosos'} amb Happier.`,
    includedBody: 'Vénen amb Happier i s’actualitzen amb ell.',
    partial: 'Una part encara no s’ha carregat, potser no hi és tot.',
    needsYou: 'Et necessita',
    all: ({ count }) => `Tots (${count})`,
    allUnknown: 'Tots',
    fewer: 'Menys',
    sectionNone: 'Encara res.',
    browserProfileEmpty: 'Perfil del navegador, encara sense extensions',
    browseKind: 'Explora',
    sectionUnavailable: 'No s’han pogut carregar ara.',
    sectionPartial: 'Una part encara no s’ha carregat.',
    sectionIncomplete: 'Una part no s’ha pogut llegir; potser no hi és tot.',
    accountGroup: 'El teu compte',
    accountGroupBody: 'No està lligat a cap Machine ni projecte.',
    unassignedGroup: 'Encara sense ubicació',
    unassignedGroupBody: 'Encara no se sap on s’executen.',
    noProjectGroup: 'Sense projecte',
    noProjectGroupBody: 'No estan associats a cap projecte.',
    everyMachine: 'Totes les màquines',
    appNoPage: 'Encara no hi ha cap pàgina per obrir',
    machineFallback: 'Una Machine',
    emptyTitle: 'Encara no hi ha res',
    emptyBody:
      'Els servidors MCP, skills, agents, proveïdors i plugins que afegeixis apareixen aquí, amb on s’executen i què et necessita.',
    browse: 'Explora la Store',
    noMatch: ({ query }) => `Res no coincideix amb «${query}»`,
    noMatchFilters: 'Res no coincideix amb aquests filtres',
    clear: 'Esborra',
    unavailable: 'Instal·lat no es pot mostrar per a aquest compte ara.',
    machineTitle: 'En aquesta Machine',
    machineBody: 'Tot el que Happier gestiona aquí.',
    openInInstalled: 'Obre a Instal·lat',
  },
  it: {
    title: 'Installato',
    purpose:
      'Tutto ciò che Happier gestisce, su ogni Machine e in ogni progetto: dove gira, se va tutto bene e cosa ha bisogno di te.',
    searchPlaceholder: 'Cerca in tutto ciò che Happier gestisce',
    groupBy: 'Raggruppa per',
    groupKind: 'Tipo',
    groupMachine: 'Machine',
    groupProject: 'Progetto',
    status: 'Stato',
    present: ({ count }) =>
      count === 1
        ? 'Happier gestisce 1 elemento per te.'
        : `Happier gestisce ${count} elementi per te.`,
    presentAcross: ({ count, machines }) =>
      `Happier gestisce ${count === 1 ? '1 elemento' : `${count} elementi`} su ${machines === 1 ? '1 macchina' : `${machines} macchine`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 ha bisogno di te.' : `${count} hanno bisogno di te.`,
    includedMore: ({ count }) => `Altri ${count} ${count === 1 ? 'è incluso' : 'sono inclusi'} in Happier.`,
    includedBody: 'Arrivano con Happier e si aggiornano insieme a lui.',
    partial:
      'Una parte non è ancora caricata, quindi potrebbe non essere tutto.',
    needsYou: 'Ha bisogno di te',
    all: ({ count }) => `Tutti (${count})`,
    allUnknown: 'Tutti',
    fewer: 'Meno',
    sectionNone: 'Ancora niente.',
    browserProfileEmpty: 'Profilo del browser, ancora senza estensioni',
    browseKind: 'Sfoglia',
    sectionUnavailable: 'Impossibile caricarli ora.',
    sectionPartial: 'Una parte non è ancora caricata.',
    sectionIncomplete: 'Una parte non è stata letta; l’elenco potrebbe non essere completo.',
    accountGroup: 'Il tuo account',
    accountGroupBody: 'Non legato a una Machine o a un progetto.',
    unassignedGroup: 'Posizione non ancora nota',
    unassignedGroupBody: 'Non si sa ancora dove girano.',
    noProjectGroup: 'Nessun progetto',
    noProjectGroupBody: 'Non associati a un progetto.',
    everyMachine: 'Tutte le macchine',
    appNoPage: 'Nessuna pagina da aprire per ora',
    machineFallback: 'Una Machine',
    emptyTitle: 'Ancora niente',
    emptyBody:
      'Server MCP, skill, agenti, provider e plugin che aggiungi compaiono qui, con dove girano e cosa ha bisogno di te.',
    browse: 'Sfoglia lo Store',
    noMatch: ({ query }) => `Nessun risultato per «${query}»`,
    noMatchFilters: 'Nessun risultato con questi filtri',
    clear: 'Cancella',
    unavailable: 'Installato non può essere mostrato per questo account ora.',
    machineTitle: 'Su questa Machine',
    machineBody: 'Tutto ciò che Happier gestisce qui.',
    openInInstalled: 'Apri in Installato',
  },
  pt: {
    title: 'Instalado',
    purpose:
      'Tudo o que o Happier gerencia, em cada Machine e em cada projeto: onde roda, se está tudo bem e o que precisa de você.',
    searchPlaceholder: 'Pesquisar em tudo o que o Happier gerencia',
    groupBy: 'Agrupar por',
    groupKind: 'Tipo',
    groupMachine: 'Machine',
    groupProject: 'Projeto',
    status: 'Status',
    present: ({ count }) =>
      count === 1
        ? 'O Happier gerencia 1 item para você.'
        : `O Happier gerencia ${count} itens para você.`,
    presentAcross: ({ count, machines }) =>
      `O Happier gerencia ${count === 1 ? '1 item' : `${count} itens`} em ${machines === 1 ? '1 máquina' : `${machines} máquinas`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 precisa de você.' : `${count} precisam de você.`,
    includedMore: ({ count }) => `Mais ${count} ${count === 1 ? 'vem incluído' : 'vêm incluídos'} no Happier.`,
    includedBody: 'Vêm com o Happier e atualizam junto com ele.',
    partial: 'Uma parte ainda não carregou, então talvez não seja tudo.',
    needsYou: 'Precisa de você',
    all: ({ count }) => `Todos (${count})`,
    allUnknown: 'Todos',
    fewer: 'Menos',
    sectionNone: 'Ainda nada.',
    browserProfileEmpty: 'Perfil do navegador, ainda sem extensões',
    browseKind: 'Explorar',
    sectionUnavailable: 'Não foi possível carregar agora.',
    sectionPartial: 'Uma parte ainda não carregou.',
    sectionIncomplete: 'Uma parte não pôde ser lida; talvez não esteja tudo aqui.',
    accountGroup: 'Sua conta',
    accountGroupBody: 'Não está ligado a uma Machine nem a um projeto.',
    unassignedGroup: 'Sem local ainda',
    unassignedGroupBody: 'Ainda não se sabe onde rodam.',
    noProjectGroup: 'Sem projeto',
    noProjectGroupBody: 'Não associados a um projeto.',
    everyMachine: 'Todas as máquinas',
    appNoPage: 'Ainda não há página para abrir',
    machineFallback: 'Uma Machine',
    emptyTitle: 'Nada aqui ainda',
    emptyBody:
      'Servidores MCP, skills, agentes, provedores e plugins que você adicionar aparecem aqui, com onde rodam e o que precisa de você.',
    browse: 'Explorar a Store',
    noMatch: ({ query }) => `Nada corresponde a “${query}”`,
    noMatchFilters: 'Nada corresponde a estes filtros',
    clear: 'Limpar',
    unavailable: 'Instalado não pode ser mostrado para esta conta agora.',
    machineTitle: 'Nesta Machine',
    machineBody: 'Tudo o que o Happier gerencia aqui.',
    openInInstalled: 'Abrir em Instalado',
  },
  pl: {
    title: 'Zainstalowane',
    purpose:
      'Wszystko, czym zarządza Happier, na każdej Machine i w każdym projekcie: gdzie działa, czy wszystko gra i co wymaga twojej uwagi.',
    searchPlaceholder: 'Szukaj we wszystkim, czym zarządza Happier',
    groupBy: 'Grupuj według',
    groupKind: 'Rodzaj',
    groupMachine: 'Machine',
    groupProject: 'Projekt',
    status: 'Stan',
    present: ({ count }) => `Happier zarządza dla ciebie elementami: ${count}.`,
    presentAcross: ({ count, machines }) =>
      `Happier zarządza elementami: ${count}, na maszynach: ${machines}.`,
    needYou: ({ count }) => `Wymaga uwagi: ${count}.`,
    includedMore: ({ count }) => `Dołączone do Happier: jeszcze ${count}.`,
    includedBody: 'Są częścią Happier i aktualizują się razem z nim.',
    partial: 'Część jeszcze się nie wczytała, więc to może nie być wszystko.',
    needsYou: 'Wymaga uwagi',
    all: ({ count }) => `Wszystkie (${count})`,
    allUnknown: 'Wszystkie',
    fewer: 'Mniej',
    sectionNone: 'Na razie nic.',
    browserProfileEmpty: 'Profil przeglądarki, na razie bez rozszerzeń',
    browseKind: 'Przeglądaj',
    sectionUnavailable: 'Nie udało się ich teraz wczytać.',
    sectionPartial: 'Część jeszcze się nie wczytała.',
    sectionIncomplete: 'Części nie udało się odczytać, więc lista może być niepełna.',
    accountGroup: 'Twoje konto',
    accountGroupBody: 'Niezwiązane z żadną Machine ani projektem.',
    unassignedGroup: 'Jeszcze bez miejsca',
    unassignedGroupBody: 'Nie wiadomo jeszcze, gdzie działają.',
    noProjectGroup: 'Bez projektu',
    noProjectGroupBody: 'Nie są przypisane do projektu.',
    everyMachine: 'Wszystkie maszyny',
    appNoPage: 'Brak strony do otwarcia',
    machineFallback: 'Machine',
    emptyTitle: 'Na razie pusto',
    emptyBody:
      'Dodane serwery MCP, skille, agenci, dostawcy i wtyczki pojawią się tutaj – z miejscem działania i tym, co wymaga uwagi.',
    browse: 'Przeglądaj Store',
    noMatch: ({ query }) => `Nic nie pasuje do „${query}”`,
    noMatchFilters: 'Nic nie pasuje do tych filtrów',
    clear: 'Wyczyść',
    unavailable: 'Nie można teraz pokazać Zainstalowanych dla tego konta.',
    machineTitle: 'Na tej Machine',
    machineBody: 'Wszystko, czym Happier tu zarządza.',
    openInInstalled: 'Otwórz w Zainstalowanych',
  },
  ru: {
    title: 'Установлено',
    purpose:
      'Всё, чем управляет Happier, на каждой Machine и в каждом проекте: где работает, всё ли в порядке и что требует вашего внимания.',
    searchPlaceholder: 'Искать во всём, чем управляет Happier',
    groupBy: 'Группировать',
    groupKind: 'По типу',
    groupMachine: 'По Machine',
    groupProject: 'По проекту',
    status: 'Состояние',
    present: ({ count }) => `Happier управляет для вас: ${count}.`,
    presentAcross: ({ count, machines }) =>
      `Happier управляет для вас: ${count}, на машинах: ${machines}.`,
    needYou: ({ count }) => `Требуют внимания: ${count}.`,
    includedMore: ({ count }) => `Ещё ${count} входят в Happier.`,
    includedBody: 'Они поставляются с Happier и обновляются вместе с ним.',
    partial: 'Часть ещё не загрузилась, так что это может быть не всё.',
    needsYou: 'Требует внимания',
    all: ({ count }) => `Все (${count})`,
    allUnknown: 'Все',
    fewer: 'Меньше',
    sectionNone: 'Пока ничего.',
    browserProfileEmpty: 'Профиль браузера, пока без расширений',
    browseKind: 'Обзор',
    sectionUnavailable: 'Сейчас не удалось загрузить.',
    sectionPartial: 'Часть ещё не загрузилась.',
    sectionIncomplete: 'Часть не удалось прочитать, поэтому здесь может быть не всё.',
    accountGroup: 'Ваш аккаунт',
    accountGroupBody: 'Не привязано к Machine или проекту.',
    unassignedGroup: 'Место пока неизвестно',
    unassignedGroupBody: 'Пока неизвестно, где они работают.',
    noProjectGroup: 'Без проекта',
    noProjectGroupBody: 'Не связаны с проектом.',
    everyMachine: 'Все машины',
    appNoPage: 'Страницы пока нет',
    machineFallback: 'Machine',
    emptyTitle: 'Пока пусто',
    emptyBody:
      'Добавленные MCP-серверы, навыки, агенты, провайдеры и плагины появятся здесь — с тем, где они работают и что требует внимания.',
    browse: 'Открыть Store',
    noMatch: ({ query }) => `Ничего не найдено по запросу «${query}»`,
    noMatchFilters: 'С этими фильтрами ничего не найдено',
    clear: 'Сбросить',
    unavailable: 'Сейчас нельзя показать «Установлено» для этого аккаунта.',
    machineTitle: 'На этой Machine',
    machineBody: 'Всё, чем Happier управляет здесь.',
    openInInstalled: 'Открыть в «Установлено»',
  },
  ja: {
    title: 'インストール済み',
    purpose:
      'Happier が管理しているすべてを、すべての Machine とプロジェクトにわたって。どこで動いているか、問題ないか、対応が必要なものを表示します。',
    searchPlaceholder: 'Happier が管理しているものを検索',
    groupBy: 'グループ',
    groupKind: '種類',
    groupMachine: 'Machine',
    groupProject: 'プロジェクト',
    status: '状態',
    present: ({ count }) => `Happier が ${count} 件を管理しています。`,
    presentAcross: ({ count, machines }) =>
      `Happier が ${machines} 台のマシンで ${count} 件を管理しています。`,
    needYou: ({ count }) => `${count} 件が対応待ちです。`,
    includedMore: ({ count }) => `ほかに ${count} 件が Happier に含まれています。`,
    includedBody: 'Happier に同梱され、Happier と一緒に更新されます。',
    partial:
      '一部がまだ読み込まれていないため、すべてではない可能性があります。',
    needsYou: '対応が必要',
    all: ({ count }) => `すべて（${count}）`,
    allUnknown: 'すべて',
    fewer: '少なく表示',
    sectionNone: 'まだありません。',
    browserProfileEmpty: 'ブラウザプロファイル(拡張機能はまだありません)',
    browseKind: '見てみる',
    sectionUnavailable: '今は読み込めませんでした。',
    sectionPartial: '一部がまだ読み込まれていません。',
    sectionIncomplete: '一部を読み取れなかったため、すべてではない可能性があります。',
    accountGroup: 'アカウント',
    accountGroupBody: '特定の Machine やプロジェクトに結び付いていません。',
    unassignedGroup: '場所が未確定',
    unassignedGroupBody: 'どこで動いているかはまだわかりません。',
    noProjectGroup: 'プロジェクトなし',
    noProjectGroupBody: 'プロジェクトに関連付けられていません。',
    everyMachine: 'すべてのマシン',
    appNoPage: '開けるページはまだありません',
    machineFallback: 'Machine',
    emptyTitle: 'まだ何もありません',
    emptyBody:
      '追加した MCP サーバー、スキル、エージェント、プロバイダー、プラグインが、動いている場所と対応が必要なものと一緒にここに表示されます。',
    browse: 'Store を見る',
    noMatch: ({ query }) => `「${query}」に一致するものはありません`,
    noMatchFilters: 'このフィルターに一致するものはありません',
    clear: 'クリア',
    unavailable: 'このアカウントのインストール済みは今は表示できません。',
    machineTitle: 'この Machine にあるもの',
    machineBody: 'Happier がここで管理しているすべて。',
    openInInstalled: 'インストール済みで開く',
  },
  'zh-Hans': {
    title: '已安装',
    purpose:
      'Happier 管理的一切，覆盖每台 Machine 和每个项目：在哪里运行、是否正常，以及需要你处理什么。',
    searchPlaceholder: '搜索 Happier 管理的一切',
    groupBy: '分组方式',
    groupKind: '类型',
    groupMachine: 'Machine',
    groupProject: '项目',
    status: '状态',
    present: ({ count }) => `Happier 为你管理 ${count} 项。`,
    presentAcross: ({ count, machines }) =>
      `Happier 在 ${machines} 台机器上为你管理 ${count} 项。`,
    needYou: ({ count }) => `${count} 项需要你处理。`,
    includedMore: ({ count }) => `另有 ${count} 项随 Happier 附带。`,
    includedBody: '它们随 Happier 提供，并随 Happier 一起更新。',
    partial: '部分内容尚未加载，可能不是全部。',
    needsYou: '需要你处理',
    all: ({ count }) => `全部（${count}）`,
    allUnknown: '全部',
    fewer: '收起',
    sectionNone: '还没有。',
    browserProfileEmpty: '浏览器配置文件,还没有扩展',
    browseKind: '浏览',
    sectionUnavailable: '暂时无法加载。',
    sectionPartial: '部分内容尚未加载。',
    sectionIncomplete: '部分内容无法读取，因此这里可能不完整。',
    accountGroup: '你的账户',
    accountGroupBody: '不绑定某台 Machine 或某个项目。',
    unassignedGroup: '位置未知',
    unassignedGroupBody: '还不知道它们在哪里运行。',
    noProjectGroup: '无项目',
    noProjectGroupBody: '未关联到任何项目。',
    everyMachine: '所有机器',
    appNoPage: '暂无可打开的页面',
    machineFallback: 'Machine',
    emptyTitle: '这里还没有内容',
    emptyBody:
      '你添加的 MCP 服务器、技能、智能体、提供商和插件会显示在这里，并注明运行位置和需要你处理的事项。',
    browse: '浏览 Store',
    noMatch: ({ query }) => `没有与“${query}”匹配的内容`,
    noMatchFilters: '没有符合这些筛选条件的内容',
    clear: '清除',
    unavailable: '暂时无法显示此账户的已安装内容。',
    machineTitle: '这台 Machine 上有什么',
    machineBody: 'Happier 在这里管理的一切。',
    openInInstalled: '在已安装中打开',
  },
  'zh-Hant': {
    title: '已安裝',
    purpose:
      'Happier 管理的一切，涵蓋每台 Machine 與每個專案：在哪裡執行、是否正常，以及需要你處理什麼。',
    searchPlaceholder: '搜尋 Happier 管理的一切',
    groupBy: '分組方式',
    groupKind: '類型',
    groupMachine: 'Machine',
    groupProject: '專案',
    status: '狀態',
    present: ({ count }) => `Happier 為你管理 ${count} 項。`,
    presentAcross: ({ count, machines }) =>
      `Happier 在 ${machines} 台機器上為你管理 ${count} 項。`,
    needYou: ({ count }) => `${count} 項需要你處理。`,
    includedMore: ({ count }) => `另有 ${count} 項隨 Happier 附帶。`,
    includedBody: '它們隨 Happier 提供，並隨 Happier 一起更新。',
    partial: '部分內容尚未載入，可能不是全部。',
    needsYou: '需要你處理',
    all: ({ count }) => `全部（${count}）`,
    allUnknown: '全部',
    fewer: '收合',
    sectionNone: '還沒有。',
    browserProfileEmpty: '瀏覽器設定檔,還沒有擴充功能',
    browseKind: '瀏覽',
    sectionUnavailable: '暫時無法載入。',
    sectionPartial: '部分內容尚未載入。',
    sectionIncomplete: '部分內容無法讀取，因此這裡可能不完整。',
    accountGroup: '你的帳號',
    accountGroupBody: '不綁定某台 Machine 或某個專案。',
    unassignedGroup: '位置未知',
    unassignedGroupBody: '還不知道它們在哪裡執行。',
    noProjectGroup: '無專案',
    noProjectGroupBody: '未關聯至任何專案。',
    everyMachine: '所有機器',
    appNoPage: '暫無可開啟的頁面',
    machineFallback: 'Machine',
    emptyTitle: '這裡還沒有內容',
    emptyBody:
      '你新增的 MCP 伺服器、技能、智慧體、供應商和外掛會顯示在這裡，並註明執行位置與需要你處理的事項。',
    browse: '瀏覽 Store',
    noMatch: ({ query }) => `沒有與「${query}」相符的內容`,
    noMatchFilters: '沒有符合這些篩選條件的內容',
    clear: '清除',
    unavailable: '暫時無法顯示此帳號的已安裝內容。',
    machineTitle: '這台 Machine 上有什麼',
    machineBody: 'Happier 在這裡管理的一切。',
    openInInstalled: '在已安裝中開啟',
  },
} as const satisfies Record<string, Labels>;
