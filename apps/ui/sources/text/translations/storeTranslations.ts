// The Store's kind pages, search results and listing pane (S40). Mounted under `capabilities.store`.

import { storeSoftwareTranslations, type StoreSoftwareTranslation } from './storeSoftwareTranslations';
import { storeAppTranslations } from './storeAppTranslations';
import { storeBrowserExtensionTranslations, storeBrowserExtensionInstallTranslations, storeBrowserExtensionProfileTranslations,
    type StoreBrowserExtensionInstallTranslation, type StoreBrowserExtensionProfileTranslation } from './storeBrowserExtensionTranslations';
import { storeAppPageTranslations, type StoreAppPageTranslation } from './storeAppPageTranslations';

type Source = Readonly<{ source: string }>;
type Query = Readonly<{ query: string }>;
type KindCopy = Readonly<{
  title: string;
  description: string;
  search: string;
}>;

export type StoreTranslation = Readonly<{
  /** Plural kind names used within sentences, preserving locale-specific capitalization. */
  setupFamilyTitle: string;
  checksFamilyTitle: string;
  kindSentenceNames: Readonly<Record<keyof StoreTranslation['kindWord'] | 'watchedService' | 'setup' | 'configuredCheck', string>>;
  allProjects: string;
  browseStore: string;
  suggestionsTitle: string;
  becauseRepository: (params: Readonly<{ repository: string }>) => string;
  kinds: Readonly<{
    app: KindCopy;
    browserExtension: KindCopy;
    mcpServer: KindCopy;
    skill: KindCopy;
    agent: KindCopy;
    provider: KindCopy;
    plugin: KindCopy;
    software: Pick<KindCopy, 'title'>;
  }>;
  kindWord: Readonly<{
    app: string;
    browserExtension: string;
    mcpServer: string;
    skill: string;
    agent: string;
    provider: string;
    plugin: string;
    software: string;
  }>;
  picksTitle: string;
  picksDescription: string;
  fromSource: (params: Source) => string;
  builtIn: string;
  builtInDescription: string;
  allCatalogs: string;
  /** A catalog whose name is not held: never its raw id. */
  unnamedCatalog: string;
  pasteCompose: string;
  runImage: string;
  definitionNoProjects: string;
  catalogLabel: string;
  loadMore: string;
  add: string;
  added: string;
  retry: string;
  /** One line for several catalogs that didn't answer; the names wait behind Details. */
  sourcesUnreachable: (params: Readonly<{ count: number }>) => string;
  hideSources: string;
  noMatch: (params: Query) => string;
  emptyTitle: string;
  emptyBody: string;
  clear: string;
  listingLabel: string;
  openAsPage: string;
  /** A selected listing that cannot show its details (S40-UI-B). */
  listing: Readonly<{
    removed: string;
    removedBody: string;
    failed: string;
    open: string;
  }>;
  /** All-kind search results (S40-UI-B). */
  search: Readonly<{
    all: string;
    kind: string;
    category: string;
    invalid: string;
    partial: string;
    results: (params: Readonly<{ count: number }>) => string;
    /** A kind section's link to every match of that kind ("All 12"). */
    allOf: (params: Readonly<{ count: number }>) => string;
  }>;
  /** Discover, Browse by job, a job and a category (S40-UI-A). */
  discover: Readonly<{
    title: string;
    purpose: string;
    search: string;
    /** The phone's narrower field. */
    searchShort: string;
    featured: string;
    jobsTitle: string;
    allJobs: string;
    all: string;
    browseGroup: string;
    sourcesAndDevelopers: string;
    jobsPurpose: string;
    jobMissingTitle: string;
    jobMissingBody: string;
    categoryMissingTitle: string;
    categoryMissingBody: string;
    browseAll: string;
    kindsTitle: string;
    kindsDescription: string;
    jobWays: (params: Readonly<{ count: number }>) => string;
  }>;
  /** Store → Updates (S40-UI-C). */
  updates: Readonly<{
    title: string;
    purpose: string;
    checkNow: string;
    checking: string;
    checkedAt: (params: Readonly<{ time: string }>) => string;
    coverage: (params: Readonly<{ count: number }>) => string;
    ready: string;
    needsChoice: string;
    unchecked: string;
    checkFailed: string;
    someUnchecked: (params: Readonly<{ count: number }>) => string;
    upToDate: string;
    upToDateBody: string;
    notChecked: string;
    notCheckedBody: string;
    noSources: string;
    noSourcesBody: string;
    review: string;
    choose: string;
    phoneRow: string;
  }>;
}>;

const en: StoreTranslation = {
  allProjects: "All projects",
  browseStore: "Browse Store",
  suggestionsTitle: "Suggested for this project",
  becauseRepository: ({ repository }) => `Uses ${repository}`,
  kinds: {
    app: storeAppTranslations.en,
    browserExtension: storeBrowserExtensionTranslations.en,
    mcpServer: {
      title: 'MCP servers',
      description:
        'Tools and data your agents can reach: trackers, databases, browsers and docs.',
      search: 'Search MCP servers',
    },
    skill: {
      title: 'Skills',
      description:
        'Instructions and scripts your agents load when a task calls for them.',
      search: 'Search skills',
    },
    agent: {
      title: 'Agents',
      description:
        'Coding agents Happier can run on your Machines, built in or from a registry.',
      search: 'Search agents',
    },
    provider: {
      title: 'Providers',
      description:
        'Where your agents’ models come from, hosted or on your own Machines.',
      search: 'Search providers',
    },
    plugin: {
      title: 'Plugins',
      description:
        'New pages, sources and Actions for Happier. Plugins run as trusted code on the Machine you choose.',
      search: 'Search plugins',
    },
    software: { title: 'Software' },
  },
  kindWord: {
    app: storeAppTranslations.en.word,
    browserExtension: storeBrowserExtensionTranslations.en.word,
    mcpServer: 'MCP server',
    skill: 'Skill',
    agent: 'Agent',
    provider: 'Provider',
    plugin: 'Plugin',
    software: 'Software',
  },
  setupFamilyTitle: 'Setup',
  checksFamilyTitle: 'Checks',
  kindSentenceNames: { setup: 'setup', configuredCheck: 'checks', app: 'apps', browserExtension: 'browser extensions', mcpServer: 'MCP servers', skill: 'skills', agent: 'agents', provider: 'providers', plugin: 'plugins', software: 'software', watchedService: 'watched services' },
  picksTitle: 'Happier picks',
  picksDescription: 'Checked and kept up to date by Happier.',
  fromSource: ({ source }) => `From ${source}`,
  builtIn: 'Built into Happier',
  builtInDescription: 'Ready to set up on any of your Machines.',
  allCatalogs: 'All catalogs',
  unnamedCatalog: 'A catalog',
  pasteCompose: "Paste a Compose file",
  runImage: "Run an image",
  definitionNoProjects: "Add a project first.",
  catalogLabel: 'Catalog',
  loadMore: 'Load more',
  add: 'Add',
  added: 'Added',
  retry: 'Retry',
  sourcesUnreachable: ({ count }) => `Couldn’t reach ${count} sources`,
  hideSources: 'Hide',
  noMatch: ({ query }) => `Nothing matches “${query}”.`,
  emptyTitle: 'Nothing here yet',
  emptyBody: 'Catalogs you add show what they offer here.',
  clear: 'Clear',
  listingLabel: 'Listing',
  openAsPage: 'Open as page',
  listing: {
    removed: 'No longer in this catalog',
    removedBody: 'It may have moved or been withdrawn. Search the Store to find it again.',
    failed: 'Couldn\'t load this listing',
    open: 'Open',
  },
  search: {
    all: 'All',
    kind: 'Kind',
    category: 'Category',
    invalid: 'This search link can’t be read.',
    partial: 'Showing what’s loaded so far. Load more to search further.',
    results: ({ count }) => (count === 1 ? '1 result' : `${count} results`),
    allOf: ({ count }) => `All ${count}`,
  },
  discover: {
    title: 'Discover',
    purpose: 'Apps for your Machines, and MCP servers, skills, agents, model providers and plugins for your sessions.',
    search: 'Search apps, MCP servers, skills, agents, providers and plugins',
    searchShort: 'Search the Store',
    featured: 'Featured',
    jobsTitle: 'Browse by job',
    allJobs: 'All jobs',
    all: 'All',
    browseGroup: 'Browse',
    sourcesAndDevelopers: 'Sources and developers',
    jobsPurpose: 'Start from what you want done. Each choice opens on its own, so you add only what you need.',
    jobMissingTitle: 'This job is no longer offered',
    jobMissingBody: 'It was removed from the Happier catalog, or the catalog can’t be reached right now.',
    categoryMissingTitle: 'This category is no longer offered',
    categoryMissingBody: 'It was removed from the Happier catalog, or the catalog can’t be reached right now.',
    browseAll: 'Browse all',
    kindsTitle: 'Browse by kind',
    kindsDescription: 'Everything Happier can add, one kind at a time.',
    jobWays: ({ count }) => (count === 1 ? '1 way' : `${count} ways`),
  },
  updates: {
    title: 'Updates',
    purpose: 'Newer versions from where your browser extensions, MCP servers, skills and agents came from. Nothing changes until you choose.',
    checkNow: 'Check now',
    checking: 'Checking…',
    checkedAt: ({ time }) => `Checked ${time}.`,
    coverage: ({ count }) => `${count} checked.`,
    ready: 'Ready to update. You haven’t changed it.',
    needsChoice: 'You changed it, and its source changed too. Choose per file.',
    unchecked: 'Couldn’t check',
    checkFailed: 'Couldn’t check for updates.',
    someUnchecked: ({ count }) => (count === 1 ? '1 item couldn’t be checked.' : `${count} items couldn’t be checked.`),
    upToDate: 'Browser extensions, MCP servers, skills and agents are up to date',
    upToDateBody: 'A newer version shows here when its source publishes one.',
    notChecked: 'Nothing waiting that Happier knows of',
    notCheckedBody: 'Check now to ask each source for newer versions.',
    noSources: 'No browser extensions, MCP servers, skills or agents to update',
    noSourcesBody: 'What you add from a catalog shows here when its source publishes a newer version.',
    review: 'Review',
    choose: 'Choose',
    phoneRow: 'Updates',
  },
};

const ca: StoreTranslation = {
  setupFamilyTitle: 'Configuració',
  checksFamilyTitle: 'Comprovacions',
  kindSentenceNames: { setup: 'configuració', configuredCheck: 'comprovacions', app: 'aplicacions', browserExtension: 'extensions del navegador', mcpServer: 'servidors MCP', skill: 'habilitats', agent: 'agents', provider: 'proveïdors', plugin: 'connectors', software: 'programari', watchedService: 'serveis supervisats' },
  allProjects: "Tots els projectes",
  browseStore: "Explora la botiga",
  suggestionsTitle: "Suggeriments per a aquest projecte",
  becauseRepository: ({ repository }) => `Fa servir ${repository}`,
  kinds: {
    app: storeAppTranslations.ca,
    browserExtension: storeBrowserExtensionTranslations.ca,
    software: { title: 'Programari' },
    mcpServer: {
      title: 'Servidors MCP',
      description:
        'Eines i dades a l’abast dels teus agents: gestors, bases de dades, navegadors i documentació.',
      search: 'Cerca servidors MCP',
    },
    skill: {
      title: 'Habilitats',
      description:
        'Instruccions i scripts que els teus agents carreguen quan una tasca ho demana.',
      search: 'Cerca habilitats',
    },
    agent: {
      title: 'Agents',
      description:
        'Agents de programació que Happier pot executar a les teves Màquines, integrats o d’un registre.',
      search: 'Cerca agents',
    },
    provider: {
      title: 'Proveïdors',
      description:
        'D’on vénen els models dels teus agents, allotjats o a les teves Màquines.',
      search: 'Cerca proveïdors',
    },
    plugin: {
      title: 'Connectors',
      description:
        'Pàgines, fonts i Accions noves per a Happier. Els connectors s’executen com a codi de confiança a la Màquina que triïs.',
      search: 'Cerca connectors',
    },
  },
  kindWord: {
    app: storeAppTranslations.ca.word,
    browserExtension: storeBrowserExtensionTranslations.ca.word,
    mcpServer: 'Servidor MCP',
    skill: 'Habilitat',
    software: 'Programari',
    agent: 'Agent',
    provider: 'Proveïdor',
    plugin: 'Connector',
  },
  picksTitle: 'Selecció de Happier',
  picksDescription: 'Revisats i mantinguts al dia per Happier.',
  fromSource: ({ source }) => `De ${source}`,
  builtIn: 'Integrats a Happier',
  builtInDescription:
    'A punt per configurar a qualsevol de les teves Màquines.',
  allCatalogs: 'Tots els catàlegs',
  unnamedCatalog: 'Un catàleg',
  pasteCompose: "Enganxa un fitxer Compose",
  runImage: "Executa una imatge",
  definitionNoProjects: "Primer afegeix un projecte.",
  catalogLabel: 'Catàleg',
  loadMore: 'Carrega’n més',
  add: 'Afegeix',
  added: 'Afegit',
  retry: 'Torna-ho a provar',
  sourcesUnreachable: ({ count }) => `No es pot contactar amb ${count} fonts`,
  hideSources: 'Amaga',
  noMatch: ({ query }) => `Res no coincideix amb «${query}».`,
  emptyTitle: 'Encara no hi ha res',
  emptyBody: 'Els catàlegs que afegeixis mostraran aquí el que ofereixen.',
  clear: 'Esborra',
  listingLabel: 'Fitxa',
  openAsPage: 'Obre com a pàgina',
  listing: {
    removed: 'Ja no és en aquest catàleg',
    removedBody: 'Potser s\'ha mogut o retirat. Cerca a la botiga per tornar-lo a trobar.',
    failed: 'No s\'ha pogut carregar aquesta fitxa',
    open: 'Obre',
  },
  search: {
    all: 'Tot',
    kind: 'Tipus',
    category: 'Categoria',
    invalid: 'Aquest enllaç de cerca no es pot llegir.',
    partial: 'Es mostra el que s’ha carregat fins ara. Carrega’n més per cercar més enllà.',
    results: ({ count }) => (count === 1 ? '1 resultat' : `${count} resultats`),
    allOf: ({ count }) => `Tot ${count}`,
  },
  discover: {
    title: 'Descobreix',
    purpose: 'Aplicacions per a les teves màquines, i servidors MCP, skills, agents, proveïdors de models i plugins per a les teves sessions.',
    search: 'Cerca aplicacions, servidors MCP, skills, agents, proveïdors i plugins',
    searchShort: 'Cerca a la Store',
    featured: 'Destacat',
    jobsTitle: 'Explora per tasca',
    allJobs: 'Totes les tasques',
    all: 'Tot',
    browseGroup: 'Explora',
    sourcesAndDevelopers: 'Fonts i desenvolupament',
    jobsPurpose: 'Comença pel que vols fer. Cada opció s’obre per separat: només afegeixes el que necessites.',
    jobMissingTitle: 'Aquesta tasca ja no s’ofereix',
    jobMissingBody: 'S’ha retirat del catàleg de Happier o ara no es pot accedir al catàleg.',
    categoryMissingTitle: 'Aquesta categoria ja no s’ofereix',
    categoryMissingBody: 'S’ha retirat del catàleg de Happier o ara no es pot accedir al catàleg.',
    browseAll: 'Explora-ho tot',
    kindsTitle: 'Explora per tipus',
    kindsDescription: 'Tot el que Happier pot afegir, per tipus.',
    jobWays: ({ count }) => (count === 1 ? '1 manera' : `${count} maneres`),
  },
  updates: {
    title: 'Actualitzacions',
    purpose: 'Versions més noves d’on provenen les teves extensions del navegador, servidors MCP, habilitats i agents. Res no canvia fins que triïs.',
    checkNow: 'Comprova ara',
    checking: 'Comprovant…',
    checkedAt: ({ time }) => `Comprovat a les ${time}.`,
    coverage: ({ count }) => `${count} comprovats.`,
    ready: 'A punt per actualitzar. No l’has canviat.',
    needsChoice: 'L’has canviat, i el seu origen també. Tria per fitxer.',
    unchecked: 'No s’ha pogut comprovar',
    checkFailed: 'No s’han pogut comprovar les actualitzacions.',
    someUnchecked: ({ count }) => (count === 1 ? 'No s’ha pogut comprovar 1 element.' : `No s’han pogut comprovar ${count} elements.`),
    upToDate: 'Els servidors MCP, les habilitats i els agents estan al dia',
    upToDateBody: 'Aquí apareix una versió més nova quan el seu origen en publica una.',
    notChecked: 'Res pendent que Happier sàpiga',
    notCheckedBody: 'Comprova ara per demanar versions més noves a cada origen.',
    noSources: 'No hi ha servidors MCP, habilitats ni agents per actualitzar',
    noSourcesBody: 'El que afegeixis d’un catàleg apareix aquí quan el seu origen publica una versió més nova.',
    review: 'Revisa',
    choose: 'Tria',
    phoneRow: 'Actualitzacions',
  },
};

const de: StoreTranslation = {
  setupFamilyTitle: 'Einrichtung',
  checksFamilyTitle: 'Prüfungen',
  kindSentenceNames: { setup: 'Einrichtung', configuredCheck: 'Prüfungen', app: 'Apps', browserExtension: 'Browser-Erweiterungen', mcpServer: 'MCP-Server', skill: 'Skills', agent: 'Agenten', provider: 'Anbieter', plugin: 'Plugins', software: 'Software', watchedService: 'überwachte Dienste' },
  allProjects: "Alle Projekte",
  browseStore: "Store durchsuchen",
  suggestionsTitle: "Für dieses Projekt empfohlen",
  becauseRepository: ({ repository }) => `Verwendet ${repository}`,
  kinds: {
    app: storeAppTranslations.de,
    browserExtension: storeBrowserExtensionTranslations.de,
    software: { title: 'Software' },
    mcpServer: {
      title: 'MCP-Server',
      description:
        'Werkzeuge und Daten für deine Agents: Tracker, Datenbanken, Browser und Dokumentation.',
      search: 'MCP-Server suchen',
    },
    skill: {
      title: 'Skills',
      description:
        'Anleitungen und Skripte, die deine Agents laden, wenn eine Aufgabe sie braucht.',
      search: 'Skills suchen',
    },
    agent: {
      title: 'Agents',
      description:
        'Coding-Agents, die Happier auf deinen Maschinen ausführen kann, eingebaut oder aus einer Registry.',
      search: 'Agents suchen',
    },
    provider: {
      title: 'Anbieter',
      description:
        'Woher die Modelle deiner Agents kommen, gehostet oder auf deinen eigenen Maschinen.',
      search: 'Anbieter suchen',
    },
    plugin: {
      title: 'Plugins',
      description:
        'Neue Seiten, Quellen und Aktionen für Happier. Plugins laufen als vertrauenswürdiger Code auf der Maschine deiner Wahl.',
      search: 'Plugins suchen',
    },
  },
  kindWord: {
    app: storeAppTranslations.de.word,
    browserExtension: storeBrowserExtensionTranslations.de.word,
    mcpServer: 'MCP-Server',
    software: 'Software',
    skill: 'Skill',
    agent: 'Agent',
    provider: 'Anbieter',
    plugin: 'Plugin',
  },
  picksTitle: 'Happier-Auswahl',
  picksDescription: 'Von Happier geprüft und aktuell gehalten.',
  fromSource: ({ source }) => `Aus ${source}`,
  builtIn: 'In Happier enthalten',
  builtInDescription: 'Bereit zur Einrichtung auf jeder deiner Maschinen.',
  allCatalogs: 'Alle Kataloge',
  unnamedCatalog: 'Ein Katalog',
  pasteCompose: "Compose-Datei einfügen",
  runImage: "Image ausführen",
  definitionNoProjects: "Füge zuerst ein Projekt hinzu.",
  catalogLabel: 'Katalog',
  loadMore: 'Mehr laden',
  add: 'Hinzufügen',
  added: 'Hinzugefügt',
  retry: 'Erneut versuchen',
  sourcesUnreachable: ({ count }) => `${count} Quellen nicht erreichbar`,
  hideSources: 'Ausblenden',
  noMatch: ({ query }) => `Nichts passt zu „${query}“.`,
  emptyTitle: 'Noch nichts hier',
  emptyBody: 'Kataloge, die du hinzufügst, zeigen hier, was sie anbieten.',
  clear: 'Löschen',
  listingLabel: 'Eintrag',
  openAsPage: 'Als Seite öffnen',
  listing: {
    removed: 'Nicht mehr in diesem Katalog',
    removedBody: 'Vielleicht wurde es verschoben oder zurückgezogen. Suche im Store, um es wiederzufinden.',
    failed: 'Dieser Eintrag konnte nicht geladen werden',
    open: 'Öffnen',
  },
  search: {
    all: 'Alle',
    kind: 'Art',
    category: 'Kategorie',
    invalid: 'Dieser Suchlink kann nicht gelesen werden.',
    partial: 'Zeigt, was bisher geladen ist. Lade mehr, um weiter zu suchen.',
    results: ({ count }) => (count === 1 ? '1 Ergebnis' : `${count} Ergebnisse`),
    allOf: ({ count }) => `Alle ${count}`,
  },
  discover: {
    title: 'Entdecken',
    purpose: 'Apps für deine Maschinen sowie MCP-Server, Skills, Agenten, Modellanbieter und Plugins für deine Sitzungen.',
    search: 'Apps, MCP-Server, Skills, Agenten, Anbieter und Plugins suchen',
    searchShort: 'Im Store suchen',
    featured: 'Empfohlen',
    jobsTitle: 'Nach Aufgabe stöbern',
    allJobs: 'Alle Aufgaben',
    all: 'Alle',
    browseGroup: 'Stöbern',
    sourcesAndDevelopers: 'Quellen und Entwicklung',
    jobsPurpose: 'Beginne mit dem, was du erledigen willst. Jede Wahl öffnet sich einzeln, du fügst nur hinzu, was du brauchst.',
    jobMissingTitle: 'Diese Aufgabe wird nicht mehr angeboten',
    jobMissingBody: 'Sie wurde aus dem Happier-Katalog entfernt, oder der Katalog ist gerade nicht erreichbar.',
    categoryMissingTitle: 'Diese Kategorie wird nicht mehr angeboten',
    categoryMissingBody: 'Sie wurde aus dem Happier-Katalog entfernt, oder der Katalog ist gerade nicht erreichbar.',
    browseAll: 'Alles durchsuchen',
    kindsTitle: 'Nach Art stöbern',
    kindsDescription: 'Alles, was Happier hinzufügen kann, nach Art.',
    jobWays: ({ count }) => (count === 1 ? '1 Weg' : `${count} Wege`),
  },
  updates: {
    title: 'Updates',
    purpose: 'Neuere Versionen von dort, woher deine Browser-Erweiterungen, MCP-Server, Skills und Agents stammen. Nichts ändert sich, bis du wählst.',
    checkNow: 'Jetzt prüfen',
    checking: 'Wird geprüft…',
    checkedAt: ({ time }) => `Geprüft um ${time}.`,
    coverage: ({ count }) => `${count} geprüft.`,
    ready: 'Bereit zum Aktualisieren. Du hast es nicht geändert.',
    needsChoice: 'Du hast es geändert, und die Quelle auch. Wähle pro Datei.',
    unchecked: 'Konnte nicht prüfen',
    checkFailed: 'Updates konnten nicht geprüft werden.',
    someUnchecked: ({ count }) => (count === 1 ? '1 Element konnte nicht geprüft werden.' : `${count} Elemente konnten nicht geprüft werden.`),
    upToDate: 'MCP-Server, Skills und Agents sind aktuell',
    upToDateBody: 'Eine neuere Version erscheint hier, sobald die Quelle eine veröffentlicht.',
    notChecked: 'Nichts wartet, soweit Happier weiß',
    notCheckedBody: 'Prüfe jetzt, um jede Quelle nach neueren Versionen zu fragen.',
    noSources: 'Keine MCP-Server, Skills oder Agents zu aktualisieren',
    noSourcesBody: 'Was du aus einem Katalog hinzufügst, erscheint hier, sobald die Quelle eine neuere Version veröffentlicht.',
    review: 'Prüfen',
    choose: 'Wählen',
    phoneRow: 'Updates',
  },
};

const es: StoreTranslation = {
  setupFamilyTitle: 'Configuración',
  checksFamilyTitle: 'Comprobaciones',
  kindSentenceNames: { setup: 'configuración', configuredCheck: 'comprobaciones', app: 'aplicaciones', browserExtension: 'extensiones del navegador', mcpServer: 'servidores MCP', skill: 'habilidades', agent: 'agentes', provider: 'proveedores', plugin: 'complementos', software: 'software', watchedService: 'servicios supervisados' },
  allProjects: "Todos los proyectos",
  browseStore: "Explorar la tienda",
  suggestionsTitle: "Sugerencias para este proyecto",
  becauseRepository: ({ repository }) => `Usa ${repository}`,
  kinds: {
    app: storeAppTranslations.es,
    browserExtension: storeBrowserExtensionTranslations.es,
    software: { title: 'Software' },
    mcpServer: {
      title: 'Servidores MCP',
      description:
        'Herramientas y datos al alcance de tus agentes: gestores, bases de datos, navegadores y documentación.',
      search: 'Buscar servidores MCP',
    },
    skill: {
      title: 'Habilidades',
      description:
        'Instrucciones y scripts que tus agentes cargan cuando una tarea lo pide.',
      search: 'Buscar habilidades',
    },
    agent: {
      title: 'Agentes',
      description:
        'Agentes de programación que Happier puede ejecutar en tus Máquinas, integrados o de un registro.',
      search: 'Buscar agentes',
    },
    provider: {
      title: 'Proveedores',
      description:
        'De dónde vienen los modelos de tus agentes, alojados o en tus propias Máquinas.',
      search: 'Buscar proveedores',
    },
    plugin: {
      title: 'Plugins',
      description:
        'Páginas, fuentes y Acciones nuevas para Happier. Los plugins se ejecutan como código de confianza en la Máquina que elijas.',
      search: 'Buscar plugins',
    },
  },
  kindWord: {
    app: storeAppTranslations.es.word,
    browserExtension: storeBrowserExtensionTranslations.es.word,
    mcpServer: 'Servidor MCP',
    skill: 'Habilidad',
    software: 'Software',
    agent: 'Agente',
    provider: 'Proveedor',
    plugin: 'Plugin',
  },
  picksTitle: 'Selección de Happier',
  picksDescription: 'Revisados y mantenidos al día por Happier.',
  fromSource: ({ source }) => `De ${source}`,
  builtIn: 'Incluidos en Happier',
  builtInDescription: 'Listos para configurar en cualquiera de tus Máquinas.',
  allCatalogs: 'Todos los catálogos',
  unnamedCatalog: 'Un catálogo',
  pasteCompose: "Pegar un archivo Compose",
  runImage: "Ejecutar una imagen",
  definitionNoProjects: "Añade primero un proyecto.",
  catalogLabel: 'Catálogo',
  loadMore: 'Cargar más',
  add: 'Añadir',
  added: 'Añadido',
  retry: 'Reintentar',
  sourcesUnreachable: ({ count }) => `${count} fuentes inaccesibles`,
  hideSources: 'Ocultar',
  noMatch: ({ query }) => `Nada coincide con «${query}».`,
  emptyTitle: 'Aún no hay nada',
  emptyBody: 'Los catálogos que añadas mostrarán aquí lo que ofrecen.',
  clear: 'Borrar',
  listingLabel: 'Ficha',
  openAsPage: 'Abrir como página',
  listing: {
    removed: 'Ya no está en este catálogo',
    removedBody: 'Puede que se haya movido o retirado. Busca en la tienda para encontrarlo de nuevo.',
    failed: 'No se pudo cargar esta ficha',
    open: 'Abrir',
  },
  search: {
    all: 'Todo',
    kind: 'Tipo',
    category: 'Categoría',
    invalid: 'No se puede leer este enlace de búsqueda.',
    partial: 'Se muestra lo cargado hasta ahora. Carga más para seguir buscando.',
    results: ({ count }) => (count === 1 ? '1 resultado' : `${count} resultados`),
    allOf: ({ count }) => `Todo ${count}`,
  },
  discover: {
    title: 'Descubrir',
    purpose: 'Aplicaciones para tus máquinas, y servidores MCP, skills, agentes, proveedores de modelos y plugins para tus sesiones.',
    search: 'Buscar aplicaciones, servidores MCP, skills, agentes, proveedores y plugins',
    searchShort: 'Buscar en la Store',
    featured: 'Destacado',
    jobsTitle: 'Explorar por tarea',
    allJobs: 'Todas las tareas',
    all: 'Todo',
    browseGroup: 'Explorar',
    sourcesAndDevelopers: 'Fuentes y desarrollo',
    jobsPurpose: 'Empieza por lo que quieres hacer. Cada opción se abre por separado: añades solo lo que necesitas.',
    jobMissingTitle: 'Esta tarea ya no se ofrece',
    jobMissingBody: 'Se retiró del catálogo de Happier o el catálogo no está disponible ahora.',
    categoryMissingTitle: 'Esta categoría ya no se ofrece',
    categoryMissingBody: 'Se retiró del catálogo de Happier o el catálogo no está disponible ahora.',
    browseAll: 'Explorar todo',
    kindsTitle: 'Explorar por tipo',
    kindsDescription: 'Todo lo que Happier puede añadir, por tipo.',
    jobWays: ({ count }) => (count === 1 ? '1 forma' : `${count} formas`),
  },
  updates: {
    title: 'Actualizaciones',
    purpose: 'Versiones más nuevas de donde vienen tus extensiones del navegador, servidores MCP, habilidades y agentes. Nada cambia hasta que elijas.',
    checkNow: 'Comprobar ahora',
    checking: 'Comprobando…',
    checkedAt: ({ time }) => `Comprobado a las ${time}.`,
    coverage: ({ count }) => `${count} comprobados.`,
    ready: 'Listo para actualizar. No lo has cambiado.',
    needsChoice: 'Lo cambiaste, y su origen también. Elige por archivo.',
    unchecked: 'No se pudo comprobar',
    checkFailed: 'No se pudieron comprobar las actualizaciones.',
    someUnchecked: ({ count }) => (count === 1 ? 'No se pudo comprobar 1 elemento.' : `No se pudieron comprobar ${count} elementos.`),
    upToDate: 'Los servidores MCP, las habilidades y los agentes están al día',
    upToDateBody: 'Aquí aparece una versión más nueva cuando su origen publica una.',
    notChecked: 'Nada pendiente que Happier sepa',
    notCheckedBody: 'Comprueba ahora para pedir versiones más nuevas a cada origen.',
    noSources: 'No hay servidores MCP, habilidades ni agentes que actualizar',
    noSourcesBody: 'Lo que añadas de un catálogo aparece aquí cuando su origen publica una versión más nueva.',
    review: 'Revisar',
    choose: 'Elegir',
    phoneRow: 'Actualizaciones',
  },
};

const fr: StoreTranslation = {
  setupFamilyTitle: 'Configuration',
  checksFamilyTitle: 'Vérifications',
  kindSentenceNames: { setup: 'configuration', configuredCheck: 'vérifications', app: 'applications', browserExtension: 'extensions du navigateur', mcpServer: 'serveurs MCP', skill: 'compétences', agent: 'agents', provider: 'fournisseurs', plugin: 'extensions', software: 'logiciels', watchedService: 'services surveillés' },
  allProjects: "Tous les projets",
  browseStore: "Parcourir le Store",
  suggestionsTitle: "Suggestions pour ce projet",
  becauseRepository: ({ repository }) => `Utilise ${repository}`,
  kinds: {
    app: storeAppTranslations.fr,
    browserExtension: storeBrowserExtensionTranslations.fr,
    software: { title: 'Logiciels' },
    mcpServer: {
      title: 'Serveurs MCP',
      description:
        'Les outils et données que tes agents peuvent atteindre : suivi, bases de données, navigateurs et docs.',
      search: 'Rechercher des serveurs MCP',
    },
    skill: {
      title: 'Compétences',
      description:
        'Des instructions et scripts que tes agents chargent quand une tâche les demande.',
      search: 'Rechercher des compétences',
    },
    agent: {
      title: 'Agents',
      description:
        'Les agents de code que Happier peut lancer sur tes Machines, intégrés ou issus d’un registre.',
      search: 'Rechercher des agents',
    },
    provider: {
      title: 'Fournisseurs',
      description:
        'D’où viennent les modèles de tes agents, hébergés ou sur tes propres Machines.',
      search: 'Rechercher des fournisseurs',
    },
    plugin: {
      title: 'Plugins',
      description:
        'De nouvelles pages, sources et Actions pour Happier. Les plugins s’exécutent comme code de confiance sur la Machine choisie.',
      search: 'Rechercher des plugins',
    },
  },
  kindWord: {
    app: storeAppTranslations.fr.word,
    browserExtension: storeBrowserExtensionTranslations.fr.word,
    mcpServer: 'Serveur MCP',
    software: 'Logiciel',
    skill: 'Compétence',
    agent: 'Agent',
    provider: 'Fournisseur',
    plugin: 'Plugin',
  },
  picksTitle: 'Sélection Happier',
  picksDescription: 'Vérifiés et tenus à jour par Happier.',
  fromSource: ({ source }) => `De ${source}`,
  builtIn: 'Inclus dans Happier',
  builtInDescription:
    'Prêts à configurer sur n’importe laquelle de tes Machines.',
  allCatalogs: 'Tous les catalogues',
  unnamedCatalog: 'Un catalogue',
  pasteCompose: "Coller un fichier Compose",
  runImage: "Exécuter une image",
  definitionNoProjects: "Ajoutez d’abord un projet.",
  catalogLabel: 'Catalogue',
  loadMore: 'Charger plus',
  add: 'Ajouter',
  added: 'Ajouté',
  retry: 'Réessayer',
  sourcesUnreachable: ({ count }) => `Impossible de joindre ${count} sources`,
  hideSources: 'Masquer',
  noMatch: ({ query }) => `Rien ne correspond à « ${query} ».`,
  emptyTitle: 'Rien ici pour l’instant',
  emptyBody: 'Les catalogues que vous ajoutez affichent ici ce qu’ils proposent.',
  clear: 'Effacer',
  listingLabel: 'Fiche',
  openAsPage: 'Ouvrir en page',
  listing: {
    removed: 'N\'est plus dans ce catalogue',
    removedBody: 'Il a peut-être été déplacé ou retiré. Cherchez dans le Store pour le retrouver.',
    failed: 'Impossible de charger cette fiche',
    open: 'Ouvrir',
  },
  search: {
    all: 'Tout',
    kind: 'Type',
    category: 'Catégorie',
    invalid: 'Ce lien de recherche est illisible.',
    partial: 'Affiche ce qui est chargé pour l’instant. Chargez-en plus pour chercher plus loin.',
    results: ({ count }) => (count === 1 ? '1 résultat' : `${count} résultats`),
    allOf: ({ count }) => `Tout ${count}`,
  },
  discover: {
    title: 'Découvrir',
    purpose: 'Des applications pour vos machines, et des serveurs MCP, skills, agents, fournisseurs de modèles et plugins pour vos sessions.',
    search: 'Rechercher des applications, serveurs MCP, skills, agents, fournisseurs et plugins',
    searchShort: 'Rechercher dans le Store',
    featured: 'À la une',
    jobsTitle: 'Parcourir par tâche',
    allJobs: 'Toutes les tâches',
    all: 'Tout',
    browseGroup: 'Parcourir',
    sourcesAndDevelopers: 'Sources et développement',
    jobsPurpose: 'Partez de ce que vous voulez faire. Chaque choix s’ouvre séparément : vous n’ajoutez que ce dont vous avez besoin.',
    jobMissingTitle: 'Cette tâche n’est plus proposée',
    jobMissingBody: 'Elle a été retirée du catalogue Happier, ou le catalogue est injoignable pour le moment.',
    categoryMissingTitle: 'Cette catégorie n’est plus proposée',
    categoryMissingBody: 'Elle a été retirée du catalogue Happier, ou le catalogue est injoignable pour le moment.',
    browseAll: 'Tout parcourir',
    kindsTitle: 'Parcourir par type',
    kindsDescription: 'Tout ce que Happier peut ajouter, type par type.',
    jobWays: ({ count }) => (count === 1 ? '1 façon' : `${count} façons`),
  },
  updates: {
    title: 'Mises à jour',
    purpose: 'Les nouvelles versions venant de l’origine de vos extensions du navigateur, serveurs MCP, compétences et agents. Rien ne change tant que vous ne choisissez pas.',
    checkNow: 'Vérifier maintenant',
    checking: 'Vérification…',
    checkedAt: ({ time }) => `Vérifié à ${time}.`,
    coverage: ({ count }) => `${count} vérifiés.`,
    ready: 'Prêt à mettre à jour. Vous ne l’avez pas modifié.',
    needsChoice: 'Vous l’avez modifié, et sa source aussi. Choisissez par fichier.',
    unchecked: 'Vérification impossible',
    checkFailed: 'Impossible de vérifier les mises à jour.',
    someUnchecked: ({ count }) => (count === 1 ? '1 élément n’a pas pu être vérifié.' : `${count} éléments n’ont pas pu être vérifiés.`),
    upToDate: 'Les serveurs MCP, compétences et agents sont à jour',
    upToDateBody: 'Une nouvelle version apparaît ici quand sa source en publie une.',
    notChecked: 'Rien en attente à la connaissance de Happier',
    notCheckedBody: 'Vérifiez maintenant pour demander les nouvelles versions à chaque source.',
    noSources: 'Aucun serveur MCP, compétence ou agent à mettre à jour',
    noSourcesBody: 'Ce que vous ajoutez depuis un catalogue apparaît ici quand sa source publie une nouvelle version.',
    review: 'Examiner',
    choose: 'Choisir',
    phoneRow: 'Mises à jour',
  },
};

const it: StoreTranslation = {
  setupFamilyTitle: 'Configurazione',
  checksFamilyTitle: 'Controlli',
  kindSentenceNames: { setup: 'configurazione', configuredCheck: 'controlli', app: 'app', browserExtension: 'estensioni del browser', mcpServer: 'server MCP', skill: 'skill', agent: 'agenti', provider: 'fornitori', plugin: 'plugin', software: 'software', watchedService: 'servizi monitorati' },
  allProjects: "Tutti i progetti",
  browseStore: "Esplora lo Store",
  suggestionsTitle: "Suggerimenti per questo progetto",
  becauseRepository: ({ repository }) => `Usa ${repository}`,
  kinds: {
    app: storeAppTranslations.it,
    browserExtension: storeBrowserExtensionTranslations.it,
    software: { title: 'Software' },
    mcpServer: {
      title: 'Server MCP',
      description:
        'Strumenti e dati a portata dei tuoi agenti: tracker, database, browser e documentazione.',
      search: 'Cerca server MCP',
    },
    skill: {
      title: 'Skill',
      description:
        'Istruzioni e script che i tuoi agenti caricano quando un’attività li richiede.',
      search: 'Cerca skill',
    },
    agent: {
      title: 'Agenti',
      description:
        'Agenti di programmazione che Happier può eseguire sulle tue Macchine, integrati o da un registro.',
      search: 'Cerca agenti',
    },
    provider: {
      title: 'Provider',
      description:
        'Da dove arrivano i modelli dei tuoi agenti, ospitati o sulle tue Macchine.',
      search: 'Cerca provider',
    },
    plugin: {
      title: 'Plugin',
      description:
        'Nuove pagine, fonti e Azioni per Happier. I plugin girano come codice attendibile sulla Macchina che scegli.',
      search: 'Cerca plugin',
    },
  },
  kindWord: {
    app: storeAppTranslations.it.word,
    browserExtension: storeBrowserExtensionTranslations.it.word,
    mcpServer: 'Server MCP',
    software: 'Software',
    skill: 'Skill',
    agent: 'Agente',
    provider: 'Provider',
    plugin: 'Plugin',
  },
  picksTitle: 'Scelti da Happier',
  picksDescription: 'Verificati e tenuti aggiornati da Happier.',
  fromSource: ({ source }) => `Da ${source}`,
  builtIn: 'Inclusi in Happier',
  builtInDescription: 'Pronti da configurare su qualsiasi tua Macchina.',
  allCatalogs: 'Tutti i cataloghi',
  unnamedCatalog: 'Un catalogo',
  pasteCompose: "Incolla un file Compose",
  runImage: "Esegui un’immagine",
  definitionNoProjects: "Aggiungi prima un progetto.",
  catalogLabel: 'Catalogo',
  loadMore: 'Carica altri',
  add: 'Aggiungi',
  added: 'Aggiunto',
  retry: 'Riprova',
  sourcesUnreachable: ({ count }) => `${count} fonti non raggiungibili`,
  hideSources: 'Nascondi',
  noMatch: ({ query }) => `Nessun risultato per «${query}».`,
  emptyTitle: 'Ancora niente qui',
  emptyBody: 'I cataloghi che aggiungi mostrano qui ciò che offrono.',
  clear: 'Cancella',
  listingLabel: 'Scheda',
  openAsPage: 'Apri come pagina',
  listing: {
    removed: 'Non è più in questo catalogo',
    removedBody: 'Potrebbe essere stato spostato o ritirato. Cerca nello Store per ritrovarlo.',
    failed: 'Impossibile caricare questa scheda',
    open: 'Apri',
  },
  search: {
    all: 'Tutto',
    kind: 'Tipo',
    category: 'Categoria',
    invalid: 'Questo link di ricerca non è leggibile.',
    partial: 'Mostra ciò che è stato caricato finora. Caricane altri per cercare oltre.',
    results: ({ count }) => (count === 1 ? '1 risultato' : `${count} risultati`),
    allOf: ({ count }) => `Tutto ${count}`,
  },
  discover: {
    title: 'Scopri',
    purpose: 'App per le tue macchine, e server MCP, skill, agenti, fornitori di modelli e plugin per le tue sessioni.',
    search: 'Cerca app, server MCP, skill, agenti, fornitori e plugin',
    searchShort: 'Cerca nello Store',
    featured: 'In evidenza',
    jobsTitle: 'Sfoglia per attività',
    allJobs: 'Tutte le attività',
    all: 'Tutti',
    browseGroup: 'Sfoglia',
    sourcesAndDevelopers: 'Fonti e sviluppo',
    jobsPurpose: 'Parti da ciò che vuoi fare. Ogni scelta si apre da sola: aggiungi solo ciò che ti serve.',
    jobMissingTitle: 'Questa attività non è più offerta',
    jobMissingBody: 'È stata rimossa dal catalogo Happier, oppure il catalogo non è raggiungibile ora.',
    categoryMissingTitle: 'Questa categoria non è più offerta',
    categoryMissingBody: 'È stata rimossa dal catalogo Happier, oppure il catalogo non è raggiungibile ora.',
    browseAll: 'Sfoglia tutto',
    kindsTitle: 'Sfoglia per tipo',
    kindsDescription: 'Tutto ciò che Happier può aggiungere, per tipo.',
    jobWays: ({ count }) => (count === 1 ? '1 modo' : `${count} modi`),
  },
  updates: {
    title: 'Aggiornamenti',
    purpose: 'Versioni più recenti da dove provengono le tue estensioni del browser, i server MCP, le skill e gli agenti. Nulla cambia finché non scegli.',
    checkNow: 'Controlla ora',
    checking: 'Controllo…',
    checkedAt: ({ time }) => `Controllato alle ${time}.`,
    coverage: ({ count }) => `${count} controllati.`,
    ready: 'Pronto da aggiornare. Non l’hai modificato.',
    needsChoice: 'L’hai modificato, e anche la sua origine. Scegli per file.',
    unchecked: 'Impossibile controllare',
    checkFailed: 'Impossibile controllare gli aggiornamenti.',
    someUnchecked: ({ count }) => (count === 1 ? 'Impossibile controllare 1 elemento.' : `Impossibile controllare ${count} elementi.`),
    upToDate: 'Server MCP, skill e agenti sono aggiornati',
    upToDateBody: 'Una versione più recente appare qui quando la sua origine ne pubblica una.',
    notChecked: 'Nulla in attesa che Happier sappia',
    notCheckedBody: 'Controlla ora per chiedere a ogni origine versioni più recenti.',
    noSources: 'Nessun server MCP, skill o agente da aggiornare',
    noSourcesBody: 'Ciò che aggiungi da un catalogo appare qui quando la sua origine pubblica una versione più recente.',
    review: 'Rivedi',
    choose: 'Scegli',
    phoneRow: 'Aggiornamenti',
  },
};

const ja: StoreTranslation = {
  setupFamilyTitle: 'セットアップ',
  checksFamilyTitle: 'チェック',
  kindSentenceNames: { setup: 'セットアップ', configuredCheck: 'チェック', app: 'アプリ', browserExtension: 'ブラウザー拡張機能', mcpServer: 'MCP サーバー', skill: 'スキル', agent: 'エージェント', provider: 'プロバイダー', plugin: 'プラグイン', software: 'ソフトウェア', watchedService: '監視対象サービス' },
  allProjects: "すべてのプロジェクト",
  browseStore: "ストアを見る",
  suggestionsTitle: "このプロジェクトへのおすすめ",
  becauseRepository: ({ repository }) => `使用中 ${repository}`,
  kinds: {
    app: storeAppTranslations.ja,
    browserExtension: storeBrowserExtensionTranslations.ja,
    software: { title: 'ソフトウェア' },
    mcpServer: {
      title: 'MCP サーバー',
      description:
        'エージェントが使えるツールとデータ：トラッカー、データベース、ブラウザー、ドキュメント。',
      search: 'MCP サーバーを検索',
    },
    skill: {
      title: 'スキル',
      description: 'タスクに応じてエージェントが読み込む手順とスクリプト。',
      search: 'スキルを検索',
    },
    agent: {
      title: 'エージェント',
      description:
        'Happier があなたのマシンで実行できるコーディングエージェント。組み込みまたはレジストリから。',
      search: 'エージェントを検索',
    },
    provider: {
      title: 'プロバイダー',
      description:
        'エージェントのモデルの提供元。ホスト型、または自分のマシン上。',
      search: 'プロバイダーを検索',
    },
    plugin: {
      title: 'プラグイン',
      description:
        'Happier に新しいページ、ソース、アクションを追加します。プラグインは選んだマシンで信頼済みコードとして動きます。',
      search: 'プラグインを検索',
    },
  },
  kindWord: {
    app: storeAppTranslations.ja.word,
    browserExtension: storeBrowserExtensionTranslations.ja.word,
    mcpServer: 'MCP サーバー',
    software: 'ソフトウェア',
    skill: 'スキル',
    agent: 'エージェント',
    provider: 'プロバイダー',
    plugin: 'プラグイン',
  },
  picksTitle: 'Happier のおすすめ',
  picksDescription: 'Happier が確認し、最新に保っています。',
  fromSource: ({ source }) => `${source} から`,
  builtIn: 'Happier に組み込み',
  builtInDescription: 'どのマシンでもすぐに設定できます。',
  allCatalogs: 'すべてのカタログ',
  unnamedCatalog: 'カタログ',
  pasteCompose: "Compose ファイルを貼り付け",
  runImage: "イメージを実行",
  definitionNoProjects: "先にプロジェクトを追加してください。",
  catalogLabel: 'カタログ',
  loadMore: 'さらに読み込む',
  add: '追加',
  added: '追加済み',
  retry: '再試行',
  sourcesUnreachable: ({ count }) => `${count} 件のソースに接続できません`,
  hideSources: '非表示',
  noMatch: ({ query }) => `「${query}」に一致するものはありません。`,
  emptyTitle: 'まだ何もありません',
  emptyBody: '追加したカタログの内容がここに表示されます。',
  clear: 'クリア',
  listingLabel: '掲載情報',
  openAsPage: 'ページとして開く',
  listing: {
    removed: 'このカタログにはもうありません',
    removedBody: '移動または取り下げられた可能性があります。ストアで検索して見つけてください。',
    failed: 'この掲載情報を読み込めませんでした',
    open: '開く',
  },
  search: {
    all: 'すべて',
    kind: '種類',
    category: 'カテゴリ',
    invalid: 'この検索リンクは読み取れません。',
    partial: 'これまでに読み込んだ分を表示しています。さらに読み込むと検索を続けます。',
    results: ({ count }) => (`${count} 件`),
    allOf: ({ count }) => `すべて ${count}`,
  },
  discover: {
    title: '見つける',
    purpose: 'マシンで動かすアプリと、セッションで使う MCP サーバー、スキル、エージェント、モデルプロバイダー、プラグイン。',
    search: 'アプリ、MCP サーバー、スキル、エージェント、プロバイダー、プラグインを検索',
    searchShort: 'Store を検索',
    featured: '注目',
    jobsTitle: 'やりたいことから探す',
    allJobs: 'すべてのやりたいこと',
    all: 'すべて',
    browseGroup: '探す',
    sourcesAndDevelopers: 'ソースと開発',
    jobsPurpose: 'やりたいことから始めましょう。選択肢は個別に開くので、必要なものだけを追加できます。',
    jobMissingTitle: 'このやりたいことは提供されていません',
    jobMissingBody: 'Happier カタログから削除されたか、現在カタログに接続できません。',
    categoryMissingTitle: 'このカテゴリは提供されていません',
    categoryMissingBody: 'Happier カタログから削除されたか、現在カタログに接続できません。',
    browseAll: 'すべて見る',
    kindsTitle: '種類から探す',
    kindsDescription: 'Happier に追加できるものを種類ごとに。',
    jobWays: ({ count }) => (count === 1 ? '1 通り' : `${count} 通り`),
  },
  updates: {
    title: 'アップデート',
    purpose: 'ブラウザー拡張機能、MCP サーバー、スキル、エージェントの取得元にある新しいバージョンです。選ぶまで何も変わりません。',
    checkNow: '今すぐ確認',
    checking: '確認中…',
    checkedAt: ({ time }) => `${time} に確認。`,
    coverage: ({ count }) => `${count} 件を確認。`,
    ready: '更新できます。変更していません。',
    needsChoice: 'あなたが変更し、取得元も変更されました。ファイルごとに選んでください。',
    unchecked: '確認できませんでした',
    checkFailed: 'アップデートを確認できませんでした。',
    someUnchecked: ({ count }) => (count === 1 ? '1 件を確認できませんでした。' : `${count} 件を確認できませんでした。`),
    upToDate: 'MCP サーバー、スキル、エージェントは最新です',
    upToDateBody: '取得元が新しいバージョンを公開すると、ここに表示されます。',
    notChecked: 'Happier が把握している待機中の項目はありません',
    notCheckedBody: '今すぐ確認して、各取得元に新しいバージョンを問い合わせます。',
    noSources: '更新できる MCP サーバー、スキル、エージェントはありません',
    noSourcesBody: 'カタログから追加したものは、取得元が新しいバージョンを公開するとここに表示されます。',
    review: '確認',
    choose: '選択',
    phoneRow: 'アップデート',
  },
};

const pl: StoreTranslation = {
  setupFamilyTitle: 'Konfiguracja',
  checksFamilyTitle: 'Sprawdzenia',
  kindSentenceNames: { setup: 'konfiguracja', configuredCheck: 'sprawdzenia', app: 'aplikacje', browserExtension: 'rozszerzenia przeglądarki', mcpServer: 'serwery MCP', skill: 'umiejętności', agent: 'agenci', provider: 'dostawcy', plugin: 'wtyczki', software: 'oprogramowanie', watchedService: 'monitorowane usługi' },
  allProjects: "Wszystkie projekty",
  browseStore: "Przeglądaj sklep",
  suggestionsTitle: "Propozycje dla tego projektu",
  becauseRepository: ({ repository }) => `Korzysta z ${repository}`,
  kinds: {
    app: storeAppTranslations.pl,
    browserExtension: storeBrowserExtensionTranslations.pl,
    software: { title: 'Oprogramowanie' },
    mcpServer: {
      title: 'Serwery MCP',
      description:
        'Narzędzia i dane dla twoich agentów: trackery, bazy danych, przeglądarki i dokumentacja.',
      search: 'Szukaj serwerów MCP',
    },
    skill: {
      title: 'Umiejętności',
      description:
        'Instrukcje i skrypty, które agenci wczytują, gdy zadanie tego wymaga.',
      search: 'Szukaj umiejętności',
    },
    agent: {
      title: 'Agenci',
      description:
        'Agenci kodujący, których Happier może uruchomić na twoich Maszynach, wbudowani lub z rejestru.',
      search: 'Szukaj agentów',
    },
    provider: {
      title: 'Dostawcy',
      description:
        'Skąd pochodzą modele twoich agentów: hostowane lub na twoich Maszynach.',
      search: 'Szukaj dostawców',
    },
    plugin: {
      title: 'Wtyczki',
      description:
        'Nowe strony, źródła i Akcje dla Happier. Wtyczki działają jako zaufany kod na wybranej Maszynie.',
      search: 'Szukaj wtyczek',
    },
  },
  kindWord: {
    app: storeAppTranslations.pl.word,
    browserExtension: storeBrowserExtensionTranslations.pl.word,
    mcpServer: 'Serwer MCP',
    software: 'Oprogramowanie',
    skill: 'Umiejętność',
    agent: 'Agent',
    provider: 'Dostawca',
    plugin: 'Wtyczka',
  },
  picksTitle: 'Wybór Happier',
  picksDescription: 'Sprawdzone i aktualizowane przez Happier.',
  fromSource: ({ source }) => `Z ${source}`,
  builtIn: 'Wbudowane w Happier',
  builtInDescription: 'Gotowe do skonfigurowania na każdej twojej Maszynie.',
  allCatalogs: 'Wszystkie katalogi',
  unnamedCatalog: 'Katalog',
  pasteCompose: "Wklej plik Compose",
  runImage: "Uruchom obraz",
  definitionNoProjects: "Najpierw dodaj projekt.",
  catalogLabel: 'Katalog',
  loadMore: 'Wczytaj więcej',
  add: 'Dodaj',
  added: 'Dodano',
  retry: 'Spróbuj ponownie',
  sourcesUnreachable: ({ count }) => `Niedostępne źródła: ${count}`,
  hideSources: 'Ukryj',
  noMatch: ({ query }) => `Nic nie pasuje do „${query}”.`,
  emptyTitle: 'Na razie nic tu nie ma',
  emptyBody: 'Dodane katalogi pokażą tutaj, co oferują.',
  clear: 'Wyczyść',
  listingLabel: 'Opis',
  openAsPage: 'Otwórz jako stronę',
  listing: {
    removed: 'Nie ma go już w tym katalogu',
    removedBody: 'Mógł zostać przeniesiony lub wycofany. Wyszukaj go w Sklepie.',
    failed: 'Nie udało się wczytać tej karty',
    open: 'Otwórz',
  },
  search: {
    all: 'Wszystko',
    kind: 'Rodzaj',
    category: 'Kategoria',
    invalid: 'Nie można odczytać tego linku wyszukiwania.',
    partial: 'Pokazuje to, co dotąd wczytano. Wczytaj więcej, aby szukać dalej.',
    results: ({ count }) => (`Wyniki: ${count}`),
    allOf: ({ count }) => `Wszystko ${count}`,
  },
  discover: {
    title: 'Odkrywaj',
    purpose: 'Aplikacje dla Twoich maszyn oraz serwery MCP, skille, agenci, dostawcy modeli i wtyczki dla Twoich sesji.',
    search: 'Szukaj aplikacji, serwerów MCP, skilli, agentów, dostawców i wtyczek',
    searchShort: 'Szukaj w Store',
    featured: 'Polecane',
    jobsTitle: 'Przeglądaj według zadania',
    allJobs: 'Wszystkie zadania',
    all: 'Wszystkie',
    browseGroup: 'Przeglądaj',
    sourcesAndDevelopers: 'Źródła i programowanie',
    jobsPurpose: 'Zacznij od tego, co chcesz zrobić. Każdy wybór otwiera się osobno, więc dodajesz tylko to, czego potrzebujesz.',
    jobMissingTitle: 'To zadanie nie jest już oferowane',
    jobMissingBody: 'Zostało usunięte z katalogu Happier albo katalog jest teraz niedostępny.',
    categoryMissingTitle: 'Ta kategoria nie jest już oferowana',
    categoryMissingBody: 'Została usunięta z katalogu Happier albo katalog jest teraz niedostępny.',
    browseAll: 'Przeglądaj wszystko',
    kindsTitle: 'Przeglądaj według rodzaju',
    kindsDescription: 'Wszystko, co Happier może dodać, według rodzaju.',
    jobWays: ({ count }) => (count === 1 ? '1 sposób' : `${count} sposoby`),
  },
  updates: {
    title: 'Aktualizacje',
    purpose: 'Nowsze wersje ze źródeł Twoich rozszerzeń przeglądarki, serwerów MCP, umiejętności i agentów. Nic się nie zmieni, dopóki nie wybierzesz.',
    checkNow: 'Sprawdź teraz',
    checking: 'Sprawdzanie…',
    checkedAt: ({ time }) => `Sprawdzono o ${time}.`,
    coverage: ({ count }) => `Sprawdzono ${count}.`,
    ready: 'Gotowe do aktualizacji. Nie zmieniałeś tego.',
    needsChoice: 'Zmieniłeś to, a źródło również. Wybierz dla każdego pliku.',
    unchecked: 'Nie udało się sprawdzić',
    checkFailed: 'Nie udało się sprawdzić aktualizacji.',
    someUnchecked: ({ count }) => (count === 1 ? 'Nie udało się sprawdzić 1 elementu.' : `Nie udało się sprawdzić ${count} elementów.`),
    upToDate: 'Serwery MCP, umiejętności i agenci są aktualni',
    upToDateBody: 'Nowsza wersja pojawi się tutaj, gdy źródło ją opublikuje.',
    notChecked: 'Nic nie czeka, o czym Happier wie',
    notCheckedBody: 'Sprawdź teraz, aby zapytać każde źródło o nowsze wersje.',
    noSources: 'Brak serwerów MCP, umiejętności ani agentów do aktualizacji',
    noSourcesBody: 'To, co dodasz z katalogu, pojawi się tutaj, gdy źródło opublikuje nowszą wersję.',
    review: 'Przejrzyj',
    choose: 'Wybierz',
    phoneRow: 'Aktualizacje',
  },
};

const pt: StoreTranslation = {
  setupFamilyTitle: 'Configuração',
  checksFamilyTitle: 'Verificações',
  kindSentenceNames: { setup: 'configuração', configuredCheck: 'verificações', app: 'aplicativos', browserExtension: 'extensões do navegador', mcpServer: 'servidores MCP', skill: 'skills', agent: 'agentes', provider: 'provedores', plugin: 'plugins', software: 'software', watchedService: 'serviços monitorados' },
  allProjects: "Todos os projetos",
  browseStore: "Explorar a loja",
  suggestionsTitle: "Sugestões para este projeto",
  becauseRepository: ({ repository }) => `Usa ${repository}`,
  kinds: {
    app: storeAppTranslations.pt,
    browserExtension: storeBrowserExtensionTranslations.pt,
    software: { title: 'Software' },
    mcpServer: {
      title: 'Servidores MCP',
      description:
        'Ferramentas e dados ao alcance dos seus agentes: rastreadores, bancos de dados, navegadores e documentação.',
      search: 'Pesquisar servidores MCP',
    },
    skill: {
      title: 'Habilidades',
      description:
        'Instruções e scripts que seus agentes carregam quando uma tarefa pede.',
      search: 'Pesquisar habilidades',
    },
    agent: {
      title: 'Agentes',
      description:
        'Agentes de programação que o Happier pode executar nas suas Máquinas, integrados ou de um registro.',
      search: 'Pesquisar agentes',
    },
    provider: {
      title: 'Provedores',
      description:
        'De onde vêm os modelos dos seus agentes, hospedados ou nas suas próprias Máquinas.',
      search: 'Pesquisar provedores',
    },
    plugin: {
      title: 'Plugins',
      description:
        'Novas páginas, fontes e Ações para o Happier. Plugins rodam como código confiável na Máquina que você escolher.',
      search: 'Pesquisar plugins',
    },
  },
  kindWord: {
    app: storeAppTranslations.pt.word,
    browserExtension: storeBrowserExtensionTranslations.pt.word,
    mcpServer: 'Servidor MCP',
    skill: 'Habilidade',
    software: 'Software',
    agent: 'Agente',
    provider: 'Provedor',
    plugin: 'Plugin',
  },
  picksTitle: 'Escolhas do Happier',
  picksDescription: 'Verificados e mantidos em dia pelo Happier.',
  fromSource: ({ source }) => `De ${source}`,
  builtIn: 'Incluídos no Happier',
  builtInDescription:
    'Prontos para configurar em qualquer uma das suas Máquinas.',
  allCatalogs: 'Todos os catálogos',
  unnamedCatalog: 'Um catálogo',
  pasteCompose: "Colar um arquivo Compose",
  runImage: "Executar uma imagem",
  definitionNoProjects: "Adicione um projeto primeiro.",
  catalogLabel: 'Catálogo',
  loadMore: 'Carregar mais',
  add: 'Adicionar',
  added: 'Adicionado',
  retry: 'Tentar novamente',
  sourcesUnreachable: ({ count }) => `${count} fontes inacessíveis`,
  hideSources: 'Ocultar',
  noMatch: ({ query }) => `Nada corresponde a “${query}”.`,
  emptyTitle: 'Nada aqui ainda',
  emptyBody: 'Os catálogos que você adicionar mostram aqui o que oferecem.',
  clear: 'Limpar',
  listingLabel: 'Ficha',
  openAsPage: 'Abrir como página',
  listing: {
    removed: 'Já não está neste catálogo',
    removedBody: 'Pode ter sido movido ou retirado. Pesquise na loja para encontrá-lo de novo.',
    failed: 'Não foi possível carregar esta ficha',
    open: 'Abrir',
  },
  search: {
    all: 'Tudo',
    kind: 'Tipo',
    category: 'Categoria',
    invalid: 'Não é possível ler este link de busca.',
    partial: 'Mostrando o que já foi carregado. Carregue mais para continuar a busca.',
    results: ({ count }) => (count === 1 ? '1 resultado' : `${count} resultados`),
    allOf: ({ count }) => `Tudo ${count}`,
  },
  discover: {
    title: 'Descobrir',
    purpose: 'Aplicativos para as suas máquinas, e servidores MCP, skills, agentes, provedores de modelos e plugins para as suas sessões.',
    search: 'Pesquisar aplicativos, servidores MCP, skills, agentes, provedores e plugins',
    searchShort: 'Pesquisar na Store',
    featured: 'Destaque',
    jobsTitle: 'Explorar por tarefa',
    allJobs: 'Todas as tarefas',
    all: 'Todos',
    browseGroup: 'Explorar',
    sourcesAndDevelopers: 'Fontes e desenvolvimento',
    jobsPurpose: 'Comece pelo que quer fazer. Cada opção abre separadamente: adiciona apenas o que precisa.',
    jobMissingTitle: 'Esta tarefa já não é oferecida',
    jobMissingBody: 'Foi removida do catálogo do Happier, ou o catálogo não está acessível agora.',
    categoryMissingTitle: 'Esta categoria já não é oferecida',
    categoryMissingBody: 'Foi removida do catálogo do Happier, ou o catálogo não está acessível agora.',
    browseAll: 'Explorar tudo',
    kindsTitle: 'Explorar por tipo',
    kindsDescription: 'Tudo o que o Happier pode adicionar, por tipo.',
    jobWays: ({ count }) => (count === 1 ? '1 forma' : `${count} formas`),
  },
  updates: {
    title: 'Atualizações',
    purpose: 'Versões mais novas de onde vieram suas extensões do navegador, servidores MCP, skills e agentes. Nada muda até você escolher.',
    checkNow: 'Verificar agora',
    checking: 'Verificando…',
    checkedAt: ({ time }) => `Verificado às ${time}.`,
    coverage: ({ count }) => `${count} verificados.`,
    ready: 'Pronto para atualizar. Você não o alterou.',
    needsChoice: 'Você o alterou, e a origem também. Escolha por arquivo.',
    unchecked: 'Não foi possível verificar',
    checkFailed: 'Não foi possível verificar atualizações.',
    someUnchecked: ({ count }) => (count === 1 ? 'Não foi possível verificar 1 item.' : `Não foi possível verificar ${count} itens.`),
    upToDate: 'Servidores MCP, skills e agentes estão atualizados',
    upToDateBody: 'Uma versão mais nova aparece aqui quando a origem publica uma.',
    notChecked: 'Nada pendente que o Happier saiba',
    notCheckedBody: 'Verifique agora para pedir versões mais novas a cada origem.',
    noSources: 'Nenhum servidor MCP, skill ou agente para atualizar',
    noSourcesBody: 'O que você adicionar de um catálogo aparece aqui quando a origem publicar uma versão mais nova.',
    review: 'Revisar',
    choose: 'Escolher',
    phoneRow: 'Atualizações',
  },
};

const ru: StoreTranslation = {
  setupFamilyTitle: 'Настройка',
  checksFamilyTitle: 'Проверки',
  kindSentenceNames: { setup: 'настройка', configuredCheck: 'проверки', app: 'приложения', browserExtension: 'расширения браузера', mcpServer: 'MCP-серверы', skill: 'навыки', agent: 'агенты', provider: 'поставщики', plugin: 'плагины', software: 'программное обеспечение', watchedService: 'отслеживаемые службы' },
  allProjects: "Все проекты",
  browseStore: "Открыть магазин",
  suggestionsTitle: "Рекомендации для этого проекта",
  becauseRepository: ({ repository }) => `Использует ${repository}`,
  kinds: {
    app: storeAppTranslations.ru,
    browserExtension: storeBrowserExtensionTranslations.ru,
    software: { title: 'Программы' },
    mcpServer: {
      title: 'MCP-серверы',
      description:
        'Инструменты и данные для ваших агентов: трекеры, базы данных, браузеры и документация.',
      search: 'Искать MCP-серверы',
    },
    skill: {
      title: 'Навыки',
      description:
        'Инструкции и скрипты, которые агенты загружают, когда этого требует задача.',
      search: 'Искать навыки',
    },
    agent: {
      title: 'Агенты',
      description:
        'Агенты для программирования, которые Happier запускает на ваших Машинах, встроенные или из реестра.',
      search: 'Искать агентов',
    },
    provider: {
      title: 'Провайдеры',
      description:
        'Откуда берутся модели ваших агентов: облачные или на ваших Машинах.',
      search: 'Искать провайдеров',
    },
    plugin: {
      title: 'Плагины',
      description:
        'Новые страницы, источники и Действия для Happier. Плагины работают как доверенный код на выбранной Машине.',
      search: 'Искать плагины',
    },
  },
  kindWord: {
    app: storeAppTranslations.ru.word,
    browserExtension: storeBrowserExtensionTranslations.ru.word,
    mcpServer: 'MCP-сервер',
    software: 'Программа',
    skill: 'Навык',
    agent: 'Агент',
    provider: 'Провайдер',
    plugin: 'Плагин',
  },
  picksTitle: 'Выбор Happier',
  picksDescription: 'Проверено и обновляется Happier.',
  fromSource: ({ source }) => `Из ${source}`,
  builtIn: 'Встроено в Happier',
  builtInDescription: 'Готово к настройке на любой вашей Машине.',
  allCatalogs: 'Все каталоги',
  unnamedCatalog: 'Каталог',
  pasteCompose: "Вставить файл Compose",
  runImage: "Запустить образ",
  definitionNoProjects: "Сначала добавьте проект.",
  catalogLabel: 'Каталог',
  loadMore: 'Загрузить ещё',
  add: 'Добавить',
  added: 'Добавлено',
  retry: 'Повторить',
  sourcesUnreachable: ({ count }) => `Недоступно источников: ${count}`,
  hideSources: 'Скрыть',
  noMatch: ({ query }) => `Ничего не найдено по «${query}».`,
  emptyTitle: 'Здесь пока пусто',
  emptyBody: 'Добавленные каталоги покажут здесь, что они предлагают.',
  clear: 'Очистить',
  listingLabel: 'Описание',
  openAsPage: 'Открыть страницей',
  listing: {
    removed: 'Больше нет в этом каталоге',
    removedBody: 'Возможно, его перенесли или отозвали. Найдите его через поиск в магазине.',
    failed: 'Не удалось загрузить карточку',
    open: 'Открыть',
  },
  search: {
    all: 'Все',
    kind: 'Тип',
    category: 'Категория',
    invalid: 'Не удаётся прочитать эту ссылку поиска.',
    partial: 'Показано то, что уже загружено. Загрузите ещё, чтобы искать дальше.',
    results: ({ count }) => (`Результатов: ${count}`),
    allOf: ({ count }) => `Все ${count}`,
  },
  discover: {
    title: 'Обзор',
    purpose: 'Приложения для ваших машин, а также MCP-серверы, навыки, агенты, поставщики моделей и плагины для ваших сессий.',
    search: 'Искать приложения, MCP-серверы, навыки, агентов, поставщиков и плагины',
    searchShort: 'Поиск в Store',
    featured: 'Рекомендуем',
    jobsTitle: 'Обзор по задачам',
    allJobs: 'Все задачи',
    all: 'Все',
    browseGroup: 'Обзор',
    sourcesAndDevelopers: 'Источники и разработка',
    jobsPurpose: 'Начните с того, что нужно сделать. Каждый вариант открывается отдельно — добавляйте только нужное.',
    jobMissingTitle: 'Эта задача больше не предлагается',
    jobMissingBody: 'Её убрали из каталога Happier, или каталог сейчас недоступен.',
    categoryMissingTitle: 'Эта категория больше не предлагается',
    categoryMissingBody: 'Её убрали из каталога Happier, или каталог сейчас недоступен.',
    browseAll: 'Смотреть всё',
    kindsTitle: 'Обзор по видам',
    kindsDescription: 'Всё, что может добавить Happier, по видам.',
    jobWays: ({ count }) => (count === 1 ? '1 способ' : `${count} способов`),
  },
  updates: {
    title: 'Обновления',
    purpose: 'Новые версии из источников ваших расширений браузера, MCP-серверов, навыков и агентов. Ничего не изменится, пока вы не выберете.',
    checkNow: 'Проверить сейчас',
    checking: 'Проверка…',
    checkedAt: ({ time }) => `Проверено в ${time}.`,
    coverage: ({ count }) => `Проверено ${count}.`,
    ready: 'Готово к обновлению. Вы это не меняли.',
    needsChoice: 'Вы это изменили, и источник тоже. Выберите для каждого файла.',
    unchecked: 'Не удалось проверить',
    checkFailed: 'Не удалось проверить обновления.',
    someUnchecked: ({ count }) => (count === 1 ? 'Не удалось проверить 1 элемент.' : `Не удалось проверить элементов: ${count}.`),
    upToDate: 'MCP-серверы, навыки и агенты актуальны',
    upToDateBody: 'Новая версия появится здесь, когда источник её опубликует.',
    notChecked: 'Happier не знает ни о чём ожидающем',
    notCheckedBody: 'Проверьте сейчас, чтобы спросить каждый источник о новых версиях.',
    noSources: 'Нет MCP-серверов, навыков и агентов для обновления',
    noSourcesBody: 'То, что вы добавите из каталога, появится здесь, когда источник опубликует новую версию.',
    review: 'Просмотреть',
    choose: 'Выбрать',
    phoneRow: 'Обновления',
  },
};

const zhHans: StoreTranslation = {
  setupFamilyTitle: '设置',
  checksFamilyTitle: '检查',
  kindSentenceNames: { setup: '设置', configuredCheck: '检查', app: '应用', browserExtension: '浏览器扩展', mcpServer: 'MCP 服务器', skill: '技能', agent: '代理', provider: '提供方', plugin: '插件', software: '软件', watchedService: '受监控服务' },
  allProjects: "所有项目",
  browseStore: "浏览商店",
  suggestionsTitle: "为此项目推荐",
  becauseRepository: ({ repository }) => `使用 ${repository}`,
  kinds: {
    app: storeAppTranslations.zhHans,
    browserExtension: storeBrowserExtensionTranslations.zhHans,
    software: { title: '软件' },
    mcpServer: {
      title: 'MCP 服务器',
      description:
        '你的智能体可以使用的工具和数据：跟踪器、数据库、浏览器和文档。',
      search: '搜索 MCP 服务器',
    },
    skill: {
      title: '技能',
      description: '任务需要时智能体加载的说明和脚本。',
      search: '搜索技能',
    },
    agent: {
      title: '智能体',
      description:
        'Happier 可以在你的机器上运行的编程智能体，内置或来自注册表。',
      search: '搜索智能体',
    },
    provider: {
      title: '提供方',
      description: '智能体所用模型的来源，托管的或在你自己的机器上。',
      search: '搜索提供方',
    },
    plugin: {
      title: '插件',
      description:
        '为 Happier 添加新页面、来源和操作。插件作为受信任代码在你选择的机器上运行。',
      search: '搜索插件',
    },
  },
  kindWord: {
    app: storeAppTranslations.zhHans.word,
    browserExtension: storeBrowserExtensionTranslations.zhHans.word,
    mcpServer: 'MCP 服务器',
    software: '软件',
    skill: '技能',
    agent: '智能体',
    provider: '提供方',
    plugin: '插件',
  },
  picksTitle: 'Happier 精选',
  picksDescription: '由 Happier 检查并保持更新。',
  fromSource: ({ source }) => `来自 ${source}`,
  builtIn: 'Happier 内置',
  builtInDescription: '可在你的任意机器上设置。',
  allCatalogs: '所有目录',
  unnamedCatalog: '某个目录',
  pasteCompose: "粘贴 Compose 文件",
  runImage: "运行镜像",
  definitionNoProjects: "请先添加项目。",
  catalogLabel: '目录',
  loadMore: '加载更多',
  add: '添加',
  added: '已添加',
  retry: '重试',
  sourcesUnreachable: ({ count }) => `${count} 个来源无法连接`,
  hideSources: '隐藏',
  noMatch: ({ query }) => `没有与“${query}”匹配的内容。`,
  emptyTitle: '这里还没有内容',
  emptyBody: '你添加的目录会在这里显示其提供的内容。',
  clear: '清除',
  listingLabel: '详情',
  openAsPage: '以页面打开',
  listing: {
    removed: '已不在此目录中',
    removedBody: '它可能已被移动或撤下。在商店中搜索即可再次找到。',
    failed: '无法加载此条目',
    open: '打开',
  },
  search: {
    all: '全部',
    kind: '类型',
    category: '类别',
    invalid: '无法读取此搜索链接。',
    partial: '显示目前已加载的结果。加载更多以继续搜索。',
    results: ({ count }) => (`${count} 个结果`),
    allOf: ({ count }) => `全部 ${count}`,
  },
  discover: {
    title: '发现',
    purpose: '在你的机器上运行的应用，以及用于会话的 MCP 服务器、技能、代理、模型提供方和插件。',
    search: '搜索应用、MCP 服务器、技能、代理、提供方和插件',
    searchShort: '搜索 Store',
    featured: '精选',
    jobsTitle: '按任务浏览',
    allJobs: '全部任务',
    all: '全部',
    browseGroup: '浏览',
    sourcesAndDevelopers: '来源与开发',
    jobsPurpose: '从你想完成的事开始。每个选项单独打开，只添加你需要的。',
    jobMissingTitle: '此任务已不再提供',
    jobMissingBody: '它已从 Happier 目录中移除，或目录暂时无法访问。',
    categoryMissingTitle: '此类别已不再提供',
    categoryMissingBody: '它已从 Happier 目录中移除，或目录暂时无法访问。',
    browseAll: '浏览全部',
    kindsTitle: '按类型浏览',
    kindsDescription: 'Happier 可以添加的一切，按类型。',
    jobWays: ({ count }) => (count === 1 ? '1 种方式' : `${count} 种方式`),
  },
  updates: {
    title: '更新',
    purpose: '来自你的浏览器扩展、MCP 服务器、技能和代理来源的新版本。在你选择之前不会有任何变化。',
    checkNow: '立即检查',
    checking: '正在检查…',
    checkedAt: ({ time }) => `检查于 ${time}。`,
    coverage: ({ count }) => `已检查 ${count} 项。`,
    ready: '可以更新。你没有改动它。',
    needsChoice: '你改动了它，来源也改动了。请逐个文件选择。',
    unchecked: '无法检查',
    checkFailed: '无法检查更新。',
    someUnchecked: ({ count }) => (count === 1 ? '有 1 项无法检查。' : `有 ${count} 项无法检查。`),
    upToDate: 'MCP 服务器、技能和代理都是最新的',
    upToDateBody: '来源发布新版本后会显示在这里。',
    notChecked: 'Happier 知道的内容中没有待处理项',
    notCheckedBody: '立即检查，向每个来源询问新版本。',
    noSources: '没有可更新的 MCP 服务器、技能或代理',
    noSourcesBody: '你从目录中添加的内容，在来源发布新版本后会显示在这里。',
    review: '查看',
    choose: '选择',
    phoneRow: '更新',
  },
};

const zhHant: StoreTranslation = {
  setupFamilyTitle: '設定',
  checksFamilyTitle: '檢查',
  kindSentenceNames: { setup: '設定', configuredCheck: '檢查', app: '應用程式', browserExtension: '瀏覽器擴充功能', mcpServer: 'MCP 伺服器', skill: '技能', agent: '代理', provider: '提供者', plugin: '外掛', software: '軟體', watchedService: '受監控服務' },
  allProjects: "所有專案",
  browseStore: "瀏覽商店",
  suggestionsTitle: "為此專案推薦",
  becauseRepository: ({ repository }) => `使用 ${repository}`,
  kinds: {
    app: storeAppTranslations.zhHant,
    browserExtension: storeBrowserExtensionTranslations.zhHant,
    software: { title: '軟體' },
    mcpServer: {
      title: 'MCP 伺服器',
      description:
        '你的代理可以使用的工具和資料：追蹤器、資料庫、瀏覽器和文件。',
      search: '搜尋 MCP 伺服器',
    },
    skill: {
      title: '技能',
      description: '任務需要時代理載入的說明和指令碼。',
      search: '搜尋技能',
    },
    agent: {
      title: '代理',
      description:
        'Happier 可以在你的機器上執行的程式設計代理，內建或來自登錄檔。',
      search: '搜尋代理',
    },
    provider: {
      title: '提供者',
      description: '代理所用模型的來源，託管的或在你自己的機器上。',
      search: '搜尋提供者',
    },
    plugin: {
      title: '外掛',
      description:
        '為 Happier 新增頁面、來源和動作。外掛會以受信任的程式碼在你選擇的機器上執行。',
      search: '搜尋外掛',
    },
  },
  kindWord: {
    app: storeAppTranslations.zhHant.word,
    browserExtension: storeBrowserExtensionTranslations.zhHant.word,
    mcpServer: 'MCP 伺服器',
    software: '軟體',
    skill: '技能',
    agent: '代理',
    provider: '提供者',
    plugin: '外掛',
  },
  picksTitle: 'Happier 精選',
  picksDescription: '由 Happier 檢查並保持更新。',
  fromSource: ({ source }) => `來自 ${source}`,
  builtIn: 'Happier 內建',
  builtInDescription: '可在你的任何機器上設定。',
  allCatalogs: '所有目錄',
  unnamedCatalog: '某個目錄',
  pasteCompose: "貼上 Compose 檔案",
  runImage: "執行映像",
  definitionNoProjects: "請先新增專案。",
  catalogLabel: '目錄',
  loadMore: '載入更多',
  add: '新增',
  added: '已新增',
  retry: '重試',
  sourcesUnreachable: ({ count }) => `${count} 個來源無法連線`,
  hideSources: '隱藏',
  noMatch: ({ query }) => `沒有與「${query}」相符的內容。`,
  emptyTitle: '這裡還沒有內容',
  emptyBody: '你新增的目錄會在這裡顯示其提供的內容。',
  clear: '清除',
  listingLabel: '詳情',
  openAsPage: '以頁面開啟',
  listing: {
    removed: '已不在此目錄中',
    removedBody: '它可能已被移動或撤下。在商店中搜尋即可再次找到。',
    failed: '無法載入此項目',
    open: '開啟',
  },
  search: {
    all: '全部',
    kind: '類型',
    category: '類別',
    invalid: '無法讀取此搜尋連結。',
    partial: '顯示目前已載入的結果。載入更多以繼續搜尋。',
    results: ({ count }) => (`${count} 個結果`),
    allOf: ({ count }) => `全部 ${count}`,
  },
  discover: {
    title: '探索',
    purpose: '在你的機器上執行的應用程式，以及用於工作階段的 MCP 伺服器、技能、代理、模型提供者和外掛。',
    search: '搜尋應用程式、MCP 伺服器、技能、代理、提供者和外掛',
    searchShort: '搜尋 Store',
    featured: '精選',
    jobsTitle: '依任務瀏覽',
    allJobs: '全部任務',
    all: '全部',
    browseGroup: '瀏覽',
    sourcesAndDevelopers: '來源與開發',
    jobsPurpose: '從你想完成的事開始。每個選項各自開啟，只加入你需要的。',
    jobMissingTitle: '此任務已不再提供',
    jobMissingBody: '它已從 Happier 目錄中移除，或目錄暫時無法存取。',
    categoryMissingTitle: '此類別已不再提供',
    categoryMissingBody: '它已從 Happier 目錄中移除，或目錄暫時無法存取。',
    browseAll: '瀏覽全部',
    kindsTitle: '依類型瀏覽',
    kindsDescription: 'Happier 可以加入的一切，依類型。',
    jobWays: ({ count }) => (count === 1 ? '1 種方式' : `${count} 種方式`),
  },
  updates: {
    title: '更新',
    purpose: '來自你的瀏覽器擴充功能、MCP 伺服器、技能和代理來源的新版本。在你選擇之前不會有任何變化。',
    checkNow: '立即檢查',
    checking: '正在檢查…',
    checkedAt: ({ time }) => `檢查於 ${time}。`,
    coverage: ({ count }) => `已檢查 ${count} 項。`,
    ready: '可以更新。你沒有改動它。',
    needsChoice: '你改動了它，來源也改動了。請逐個檔案選擇。',
    unchecked: '無法檢查',
    checkFailed: '無法檢查更新。',
    someUnchecked: ({ count }) => (count === 1 ? '有 1 項無法檢查。' : `有 ${count} 項無法檢查。`),
    upToDate: 'MCP 伺服器、技能和代理都是最新的',
    upToDateBody: '來源發布新版本後會顯示在這裡。',
    notChecked: 'Happier 知道的內容中沒有待處理項目',
    notCheckedBody: '立即檢查，向每個來源詢問新版本。',
    noSources: '沒有可更新的 MCP 伺服器、技能或代理',
    noSourcesBody: '你從目錄中新增的內容，在來源發布新版本後會顯示在這裡。',
    review: '查看',
    choose: '選擇',
    phoneRow: '更新',
  },
};

const storeByLocale = {
  en: { ...en, softwarePage: storeSoftwareTranslations.en, appPage: storeAppPageTranslations.en, browserExtensionInstall: storeBrowserExtensionInstallTranslations.en, browserExtensionProfile: storeBrowserExtensionProfileTranslations.en },
  ca: { ...ca, softwarePage: storeSoftwareTranslations.ca, appPage: storeAppPageTranslations.ca, browserExtensionInstall: storeBrowserExtensionInstallTranslations.ca, browserExtensionProfile: storeBrowserExtensionProfileTranslations.ca },
  de: { ...de, softwarePage: storeSoftwareTranslations.de, appPage: storeAppPageTranslations.de, browserExtensionInstall: storeBrowserExtensionInstallTranslations.de, browserExtensionProfile: storeBrowserExtensionProfileTranslations.de },
  es: { ...es, softwarePage: storeSoftwareTranslations.es, appPage: storeAppPageTranslations.es, browserExtensionInstall: storeBrowserExtensionInstallTranslations.es, browserExtensionProfile: storeBrowserExtensionProfileTranslations.es },
  fr: { ...fr, softwarePage: storeSoftwareTranslations.fr, appPage: storeAppPageTranslations.fr, browserExtensionInstall: storeBrowserExtensionInstallTranslations.fr, browserExtensionProfile: storeBrowserExtensionProfileTranslations.fr },
  it: { ...it, softwarePage: storeSoftwareTranslations.it, appPage: storeAppPageTranslations.it, browserExtensionInstall: storeBrowserExtensionInstallTranslations.it, browserExtensionProfile: storeBrowserExtensionProfileTranslations.it },
  ja: { ...ja, softwarePage: storeSoftwareTranslations.ja, appPage: storeAppPageTranslations.ja, browserExtensionInstall: storeBrowserExtensionInstallTranslations.ja, browserExtensionProfile: storeBrowserExtensionProfileTranslations.ja },
  pl: { ...pl, softwarePage: storeSoftwareTranslations.pl, appPage: storeAppPageTranslations.pl, browserExtensionInstall: storeBrowserExtensionInstallTranslations.pl, browserExtensionProfile: storeBrowserExtensionProfileTranslations.pl },
  pt: { ...pt, softwarePage: storeSoftwareTranslations.pt, appPage: storeAppPageTranslations.pt, browserExtensionInstall: storeBrowserExtensionInstallTranslations.pt, browserExtensionProfile: storeBrowserExtensionProfileTranslations.pt },
  ru: { ...ru, softwarePage: storeSoftwareTranslations.ru, appPage: storeAppPageTranslations.ru, browserExtensionInstall: storeBrowserExtensionInstallTranslations.ru, browserExtensionProfile: storeBrowserExtensionProfileTranslations.ru },
  zhHans: { ...zhHans, softwarePage: storeSoftwareTranslations.zhHans, appPage: storeAppPageTranslations.zhHans, browserExtensionInstall: storeBrowserExtensionInstallTranslations.zhHans, browserExtensionProfile: storeBrowserExtensionProfileTranslations.zhHans },
  zhHant: { ...zhHant, softwarePage: storeSoftwareTranslations.zhHant, appPage: storeAppPageTranslations.zhHant, browserExtensionInstall: storeBrowserExtensionInstallTranslations.zhHant, browserExtensionProfile: storeBrowserExtensionProfileTranslations.zhHant },
} satisfies Record<string, StoreTranslation & Readonly<{ softwarePage: StoreSoftwareTranslation; appPage: StoreAppPageTranslation; browserExtensionInstall: StoreBrowserExtensionInstallTranslation; browserExtensionProfile: StoreBrowserExtensionProfileTranslation }>>;

export const storeTranslations: Readonly<
  Record<keyof typeof storeByLocale, StoreTranslation & Readonly<{ softwarePage: StoreSoftwareTranslation; appPage: StoreAppPageTranslation;
    browserExtensionInstall: StoreBrowserExtensionInstallTranslation; browserExtensionProfile: StoreBrowserExtensionProfileTranslation }>>
> = storeByLocale;
