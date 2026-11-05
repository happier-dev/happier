import { storeTranslations } from './storeTranslations';
import { skillsPageTranslations } from './skillsPageTranslations';
import { sessionCapabilityTranslations } from './sessionCapabilityTranslations';
import { capabilityNoticeTranslations } from './capabilityNoticeTranslations';
import { capabilityDetailTranslations } from './capabilityDetailTranslations';
import { skillDetailTranslations } from './skillDetailTranslations';
import { skillsFoundTranslations } from './skillsFoundTranslations';
import { skillsUpdatesTranslations } from './skillsUpdatesTranslations';
import { mcpPageTranslations } from './mcpPageTranslations';
import { valueRefRowsTranslations } from './valueRefRowsTranslations';
import { mcpAddTranslations } from './mcpAddTranslations';
import { agentAddTranslations } from './agentAddTranslations';
import { mcpSignInTranslations } from './mcpSignInTranslations';
import { mcpHomeTranslations } from './mcpHomeTranslations';
import { registriesTranslations, skillAddTranslations } from './registriesTranslations';
import { profileSeedsTranslations } from './profileSeedsTranslations';
import { scopeSectionTranslations } from './scopeSectionTranslations';
// Shared capability UI kit copy (P5): "Where it's on" words and the capability status vocabulary.
// One block per locale; each locale root mounts its own block as `capabilities`.

export type CapabilityPlaceKind = 'machine' | 'project' | 'folder';
/** One clause's subject: an Agent, a place, or both ("for Gemini in happier"). */
export type CapabilityClauseParams = Readonly<{
  agent?: string;
  place?: string;
  placeKind?: CapabilityPlaceKind;
}>;
type ItemKind = Readonly<{ kind: 'skill' | 'mcp_server' }>;

export type CapabilityKitTranslation = Readonly<{
  where: Readonly<{
    onEverywhere: string;
    everywhere: string;
    off: string;
    only: (params: CapabilityClauseParams) => string;
    on: (params: CapabilityClauseParams) => string;
    except: (params: CapabilityClauseParams) => string;
    exceptions: (params: Readonly<{ count: number }>) => string;
    more: (params: Readonly<{ count: number }>) => string;
    effect: Readonly<{
      everywhereOn: string;
      everywhereOff: string;
      agentNever: (params: ItemKind) => string;
      agentEverywhereOn: string;
      machineOn: string;
      machineOff: string;
      projectOn: string;
      projectOff: string;
      folderOn: string;
      folderOff: string;
      agentAtOn: (
        params: Readonly<{
          agent: string;
          place: string;
          placeKind: CapabilityPlaceKind;
        }>,
      ) => string;
      agentAtOff: (
        params: Readonly<{
          agent: string;
          place: string;
          placeKind: CapabilityPlaceKind;
        }>,
      ) => string;
    }>;
    available: (
      params: Readonly<{ agents: string; machines: string; projects?: string }>,
    ) => string;
    availableNowhere: string;
    offlineNote: (params: Readonly<{ machine: string }>) => string;
    /** Several offline machines, said once. */
    offlineNoteMany: (params: Readonly<{ count: number }>) => string;
    cantTake: (params: Readonly<{ agent: string } & ItemKind>) => string;
  }>;
  control: Readonly<{
    title: string;
    description: string;
    everywhereLabel: string;
    on: string;
    off: string;
    turnedOnIn: string;
    except: string;
    nowhereYet: string;
    addException: string;
    addPlace: string;
    menuAgent: string;
    menuAgentEverywhere: string;
    menuMachine: string;
    menuProject: string;
    menuProjectEverywhere: string;
    offline: string;
    machineCount: (params: Readonly<{ count: number }>) => string;
    allAgents: string;
    agentOnly: (params: Readonly<{ agent: string }>) => string;
    whichAgents: (params: Readonly<{ place: string }>) => string;
    remove: (params: Readonly<{ target: string }>) => string;
    staysOff: (params: Readonly<{ agents: string }>) => string;
    change: string;
    changeFailed: string;
  }>;
  add: Readonly<{
    closeDetails: string;
    backTo: (params: Readonly<{ title: string }>) => string;
    added: string;
    done: string;
    addFailed: string;
    modesLabel: string;
    searchLabel: string;
  }>;
  facts: Readonly<{
    textOnly: string;
    hasFiles: string;
    runsScripts: string;
    tokensWhenUsed: (params: Readonly<{ count: string }>) => string;
    toolCount: (params: Readonly<{ count: number; shown: string }>) => string;
    tokensPerTurn: (params: Readonly<{ count: string }>) => string;
    you: string;
    happier: string;
    pinnedTo: (params: Readonly<{ ref: string }>) => string;
    inYourLibrary: string;
  }>;
  status: Readonly<{
    off: string;
    signin: string;
    moreAccess: string;
    key: string;
    cantrun: (params: Readonly<{ machine?: string }>) => string;
    offline: string;
    update: string;
    modified: string;
    pinned: string;
    unused: string;
    unusedExplanation: (params: Readonly<{ agents: string }>) => string;
    error: (params: Readonly<{ machine?: string }>) => string;
    masked: (params: Readonly<{ machine?: string }>) => string;
    signing: string;
    connected: string;
    expired: string;
    revoked: string;
    fix: Readonly<{
      signIn: string;
      reconnect: string;
      addKey: string;
      howToFix: string;
      tryAgain: string;
      reviewUpdate: string;
      compare: string;
      turnOn: string;
      grantAccess: string;
    }>;
  }>;
}>;

const join = (...parts: readonly (string | false | undefined)[]) =>
  parts.filter(Boolean).join(' ');

const en: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'On everywhere',
    everywhere: 'Everywhere',
    off: 'Off',
    only: ({ agent, place, placeKind }) =>
      join(
        'Only',
        agent && `for ${agent}`,
        place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      agent
        ? join(
            'on for',
            agent,
            place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
          )
        : placeKind === 'machine'
          ? `on ${place}`
          : `on in ${place}`,
    except: ({ agent, place, placeKind }) =>
      join(
        'except',
        agent,
        place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1 ? '1 exception' : `${count} exceptions`,
    more: ({ count }) => `${count} more`,
    effect: {
      everywhereOn: 'Every machine and agent, and the ones you add later',
      everywhereOff: 'Off unless a rule below turns it on',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Never gets this skill, wherever it’s on'
          : 'Never gets this server, wherever it’s on',
      agentEverywhereOn: 'Gets it even where the rest is off',
      machineOn: 'Every agent on this machine',
      machineOff: 'No agent on this machine',
      projectOn: 'In this project, on every machine',
      projectOff: 'Not in this project, on any machine',
      folderOn: 'In this folder on this machine',
      folderOff: 'Not in this folder',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} gets it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} doesn’t get it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Available to ${agents} on ${machines}${projects ? `, only in ${projects}` : ''}`,
    availableNowhere: 'Not available anywhere yet',
    offlineNote: ({ machine }) =>
      `${machine} is offline. It gets this when it’s back.`,
    offlineNoteMany: ({ count }) =>
      `${count} offline machines get it when they’re back.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} can’t load skills.`
        : `${agent} can’t use MCP servers.`,
  },
  control: {
    title: 'Where it’s on',
    description: 'Set it once and every machine follows. The most specific rule wins.',
    everywhereLabel: 'Everywhere on or off',
    on: 'On',
    off: 'Off',
    turnedOnIn: 'Turned on in',
    except: 'Except',
    nowhereYet: 'Nowhere yet. Add a project, a machine or an agent.',
    addException: 'Add an exception',
    addPlace: 'Add a place',
    menuAgent: 'An agent',
    menuAgentEverywhere: 'An agent, everywhere',
    menuMachine: 'A machine',
    menuProject: 'A project',
    menuProjectEverywhere: 'A project, on every machine',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 machine' : `${count} machines`,
    allAgents: 'All agents',
    agentOnly: ({ agent }) => `${agent} only`,
    whichAgents: ({ place }) => `Which agents in ${place}`,
    remove: ({ target }) => `Remove the rule for ${target}`,
    staysOff: ({ agents }) => `${agents} stays off here`,
    change: 'Change',
    changeFailed: 'Couldn’t save that change.',
  },
  add: {
    closeDetails: 'Close details',
    backTo: ({ title }) => `Back to ${title}`,
    added: 'Added',
    done: 'Done',
    addFailed: 'Couldn’t add it. Try again.',
    modesLabel: 'Ways to add',
    searchLabel: 'Search',
  },
  facts: {
    textOnly: 'Text only',
    hasFiles: 'Has files',
    runsScripts: 'Runs scripts',
    tokensWhenUsed: ({ count }) => `${count} tokens`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} tool` : `${shown} tools`),
    tokensPerTurn: ({ count }) => `${count} tokens a turn`,
    you: 'You',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Pinned to ${ref}`,
    inYourLibrary: 'In your library',
  },
  status: {
    off: 'Off',
    signin: 'Needs sign-in',
    moreAccess: 'Needs more access',
    key: 'Needs a key',
    cantrun: ({ machine }) =>
      machine ? `Can’t run on ${machine}` : 'Can’t run',
    offline: 'Offline',
    update: 'Update available',
    modified: 'Modified',
    pinned: 'Pinned',
    unused: 'Not used recently',
    unusedExplanation: ({ agents }) =>
      `Use is recorded for ${agents} and agents that read skills through Happier`,
    error: ({ machine }) =>
      machine ? `Stopped on ${machine}` : 'Couldn’t start',
    masked: ({ machine }) =>
      machine ? `${machine}’s copy wins` : 'Another copy wins',
    signing: 'Signing in…',
    connected: 'Connected',
    expired: 'Sign-in expired',
    revoked: 'Access revoked',
    fix: {
      signIn: 'Sign in',
      reconnect: 'Reconnect',
      addKey: 'Add a key',
      howToFix: 'How to fix',
      tryAgain: 'Try again',
      reviewUpdate: 'Review update',
      compare: 'Compare',
      turnOn: 'Turn on',
      grantAccess: 'Grant access',
    },
  },
};

const ca: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Activat a tot arreu',
    everywhere: 'A tot arreu',
    off: 'Desactivat',
    only: ({ agent, place, placeKind }) =>
      join(
        'Només',
        agent && `per a ${agent}`,
        place && `a ${place}`,
      ),
    on: ({ agent, place }) =>
      join('activat', agent && `per a ${agent}`, place && `a ${place}`),
    except: ({ agent, place }) => join('excepte', agent, place && `a ${place}`),
    exceptions: ({ count }) =>
      count === 1 ? '1 excepció' : `${count} excepcions`,
    more: ({ count }) => `${count} més`,
    effect: {
      everywhereOn:
        'Totes les màquines i agents, i els que afegeixis més endavant',
      everywhereOff: 'Desactivat tret que una regla de sota l’activi',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'No rep mai aquesta habilitat, on sigui que estigui activada'
          : 'No rep mai aquest servidor, on sigui que estigui activat',
      agentEverywhereOn: 'El rep fins i tot on la resta està desactivada',
      machineOn: 'Tots els agents d’aquesta màquina',
      machineOff: 'Cap agent d’aquesta màquina',
      projectOn: 'En aquest projecte, a totes les màquines',
      projectOff: 'No en aquest projecte, a cap màquina',
      folderOn: 'En aquesta carpeta d’aquesta màquina',
      folderOff: 'No en aquesta carpeta',
      agentAtOn: ({ agent, place }) => `${agent} el rep a ${place}`,
      agentAtOff: ({ agent, place }) => `${agent} no el rep a ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Disponible per a ${agents} a ${machines}${projects ? `, només a ${projects}` : ''}`,
    availableNowhere: 'Encara no està disponible enlloc',
    offlineNote: ({ machine }) =>
      `${machine} està fora de línia. El rebrà quan torni.`,
    offlineNoteMany: ({ count }) =>
      `${count} màquines fora de línia ho rebran quan tornin.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} no pot carregar habilitats.`
        : `${agent} no pot fer servir servidors MCP.`,
  },
  control: {
    title: 'On està actiu',
    description: 'Defineix-ho una vegada i totes les màquines ho segueixen. Guanya la regla més específica.',
    everywhereLabel: 'Activat o desactivat a tot arreu',
    on: 'Sí',
    off: 'No',
    turnedOnIn: 'Activat a',
    except: 'Excepte',
    nowhereYet: 'Encara enlloc. Afegeix un projecte, una màquina o un agent.',
    addException: 'Afegeix una excepció',
    addPlace: 'Afegeix un lloc',
    menuAgent: 'Un agent',
    menuAgentEverywhere: 'Un agent, a tot arreu',
    menuMachine: 'Una màquina',
    menuProject: 'Un projecte',
    menuProjectEverywhere: 'Un projecte, a totes les màquines',
    offline: 'fora de línia',
    machineCount: ({ count }) => count === 1 ? '1 màquina' : `${count} màquines`,
    allAgents: 'Tots els agents',
    agentOnly: ({ agent }) => `Només ${agent}`,
    whichAgents: ({ place }) => `Quins agents a ${place}`,
    remove: ({ target }) => `Elimina la regla de ${target}`,
    staysOff: ({ agents }) => `${agents} continua desactivat aquí`,
    change: 'Canvia',
    changeFailed: 'No s’ha pogut desar el canvi.',
  },
  add: {
    closeDetails: 'Tanca els detalls',
    backTo: ({ title }) => `Torna a ${title}`,
    added: 'Afegit',
    done: 'Fet',
    addFailed: 'No s’ha pogut afegir. Torna-ho a provar.',
    modesLabel: 'Maneres d’afegir',
    searchLabel: 'Cerca',
  },
  facts: {
    textOnly: 'Només text',
    hasFiles: 'Té fitxers',
    runsScripts: 'Executa scripts',
    tokensWhenUsed: ({ count }) => `${count} tokens`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} eina` : `${shown} eines`),
    tokensPerTurn: ({ count }) => `${count} tokens per torn`,
    you: 'Tu',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Fixat a ${ref}`,
    inYourLibrary: 'A la teva biblioteca',
  },
  status: {
    off: 'Desactivat',
    signin: 'Cal iniciar sessió',
    moreAccess: 'Cal més accés',
    key: 'Cal una clau',
    cantrun: ({ machine }) =>
      machine ? `No es pot executar a ${machine}` : 'No es pot executar',
    offline: 'Fora de línia',
    update: 'Actualització disponible',
    modified: 'Modificat',
    pinned: 'Fixat',
    unused: 'No s’ha fet servir recentment',
    unusedExplanation: ({ agents }) =>
      `L’ús es registra per a ${agents} i els agents que llegeixen habilitats a través de Happier`,
    error: ({ machine }) =>
      machine ? `Aturat a ${machine}` : 'No s’ha pogut iniciar',
    masked: ({ machine }) =>
      machine ? `Guanya la còpia de ${machine}` : 'Guanya una altra còpia',
    signing: 'Iniciant sessió…',
    connected: 'Connectat',
    expired: 'La sessió ha caducat',
    revoked: 'Accés revocat',
    fix: {
      signIn: 'Inicia sessió',
      reconnect: 'Torna a connectar',
      addKey: 'Afegeix una clau',
      howToFix: 'Com solucionar-ho',
      tryAgain: 'Torna-ho a provar',
      reviewUpdate: 'Revisa l’actualització',
      compare: 'Compara',
      turnOn: 'Activa',
      grantAccess: 'Concedeix accés',
    },
  },
};

const de: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Überall an',
    everywhere: 'Überall',
    off: 'Aus',
    only: ({ agent, place, placeKind }) =>
      join(
        'Nur',
        agent && `für ${agent}`,
        place && `${placeKind === 'machine' ? 'auf' : 'in'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      join(
        'an',
        agent && `für ${agent}`,
        place && `${placeKind === 'machine' ? 'auf' : 'in'} ${place}`,
      ),
    except: ({ agent, place, placeKind }) =>
      join(
        'außer',
        agent,
        place && `${placeKind === 'machine' ? 'auf' : 'in'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1 ? '1 Ausnahme' : `${count} Ausnahmen`,
    more: ({ count }) => `${count} weitere`,
    effect: {
      everywhereOn: 'Jede Maschine und jeder Agent, auch später hinzugefügte',
      everywhereOff: 'Aus, außer eine Regel unten schaltet es ein',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Bekommt diesen Skill nie, wo immer er an ist'
          : 'Bekommt diesen Server nie, wo immer er an ist',
      agentEverywhereOn: 'Bekommt es auch dort, wo der Rest aus ist',
      machineOn: 'Jeder Agent auf dieser Maschine',
      machineOff: 'Kein Agent auf dieser Maschine',
      projectOn: 'In diesem Projekt, auf jeder Maschine',
      projectOff: 'Nicht in diesem Projekt, auf keiner Maschine',
      folderOn: 'In diesem Ordner auf dieser Maschine',
      folderOff: 'Nicht in diesem Ordner',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} bekommt es ${placeKind === 'machine' ? 'auf' : 'in'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} bekommt es nicht ${placeKind === 'machine' ? 'auf' : 'in'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Verfügbar für ${agents} auf ${machines}${projects ? `, nur in ${projects}` : ''}`,
    availableNowhere: 'Noch nirgends verfügbar',
    offlineNote: ({ machine }) =>
      `${machine} ist offline. Es bekommt dies, sobald es zurück ist.`,
    offlineNoteMany: ({ count }) =>
      `${count} Geräte sind offline. Sie bekommen dies, sobald sie zurück sind.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} kann keine Skills laden.`
        : `${agent} kann keine MCP-Server nutzen.`,
  },
  control: {
    title: 'Wo es aktiv ist',
    description: 'Einmal festlegen, jede Maschine folgt. Die genaueste Regel gewinnt.',
    everywhereLabel: 'Überall an oder aus',
    on: 'An',
    off: 'Aus',
    turnedOnIn: 'Eingeschaltet in',
    except: 'Außer',
    nowhereYet: 'Noch nirgends. Füge ein Projekt, eine Maschine oder einen Agenten hinzu.',
    addException: 'Ausnahme hinzufügen',
    addPlace: 'Ort hinzufügen',
    menuAgent: 'Ein Agent',
    menuAgentEverywhere: 'Ein Agent, überall',
    menuMachine: 'Eine Maschine',
    menuProject: 'Ein Projekt',
    menuProjectEverywhere: 'Ein Projekt, auf jeder Maschine',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 Maschine' : `${count} Maschinen`,
    allAgents: 'Alle Agenten',
    agentOnly: ({ agent }) => `Nur ${agent}`,
    whichAgents: ({ place }) => `Welche Agenten in ${place}`,
    remove: ({ target }) => `Regel für ${target} entfernen`,
    staysOff: ({ agents }) => `${agents} bleibt hier aus`,
    change: 'Ändern',
    changeFailed: 'Die Änderung konnte nicht gespeichert werden.',
  },
  add: {
    closeDetails: 'Details schließen',
    backTo: ({ title }) => `Zurück zu ${title}`,
    added: 'Hinzugefügt',
    done: 'Fertig',
    addFailed: 'Konnte nicht hinzugefügt werden. Erneut versuchen.',
    modesLabel: 'Arten zum Hinzufügen',
    searchLabel: 'Suchen',
  },
  facts: {
    textOnly: 'Nur Text',
    hasFiles: 'Enthält Dateien',
    runsScripts: 'Führt Skripte aus',
    tokensWhenUsed: ({ count }) => `${count} Tokens`,
    toolCount: ({ shown }) => `${shown} Tools`,
    tokensPerTurn: ({ count }) => `${count} Tokens pro Runde`,
    you: 'Du',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Fixiert auf ${ref}`,
    inYourLibrary: 'In deiner Bibliothek',
  },
  status: {
    off: 'Aus',
    signin: 'Anmeldung nötig',
    moreAccess: 'Mehr Zugriff nötig',
    key: 'Schlüssel nötig',
    cantrun: ({ machine }) =>
      machine ? `Läuft nicht auf ${machine}` : 'Läuft nicht',
    offline: 'Offline',
    update: 'Update verfügbar',
    modified: 'Geändert',
    pinned: 'Fixiert',
    unused: 'Länger nicht benutzt',
    unusedExplanation: ({ agents }) =>
      `Die Nutzung wird für ${agents} und Agents erfasst, die Skills über Happier lesen`,
    error: ({ machine }) =>
      machine ? `Auf ${machine} gestoppt` : 'Konnte nicht starten',
    masked: ({ machine }) =>
      machine ? `Die Kopie von ${machine} gilt` : 'Eine andere Kopie gilt',
    signing: 'Anmeldung läuft…',
    connected: 'Verbunden',
    expired: 'Anmeldung abgelaufen',
    revoked: 'Zugriff widerrufen',
    fix: {
      signIn: 'Anmelden',
      reconnect: 'Neu verbinden',
      addKey: 'Schlüssel hinzufügen',
      howToFix: 'So behebst du es',
      tryAgain: 'Erneut versuchen',
      reviewUpdate: 'Update prüfen',
      compare: 'Vergleichen',
      turnOn: 'Einschalten',
      grantAccess: 'Zugriff gewähren',
    },
  },
};

const es: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Activado en todas partes',
    everywhere: 'En todas partes',
    off: 'Desactivado',
    only: ({ agent, place }) =>
      join('Solo', agent && `para ${agent}`, place && `en ${place}`),
    on: ({ agent, place }) =>
      join('activado', agent && `para ${agent}`, place && `en ${place}`),
    except: ({ agent, place }) =>
      join('excepto', agent, place && `en ${place}`),
    exceptions: ({ count }) =>
      count === 1 ? '1 excepción' : `${count} excepciones`,
    more: ({ count }) => `${count} más`,
    effect: {
      everywhereOn: 'Todas las máquinas y agentes, y los que añadas después',
      everywhereOff: 'Desactivado salvo que una regla de abajo lo active',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Nunca recibe esta habilidad, esté donde esté activada'
          : 'Nunca recibe este servidor, esté donde esté activado',
      agentEverywhereOn: 'Lo recibe incluso donde el resto está desactivado',
      machineOn: 'Todos los agentes de esta máquina',
      machineOff: 'Ningún agente de esta máquina',
      projectOn: 'En este proyecto, en todas las máquinas',
      projectOff: 'No en este proyecto, en ninguna máquina',
      folderOn: 'En esta carpeta de esta máquina',
      folderOff: 'No en esta carpeta',
      agentAtOn: ({ agent, place }) => `${agent} lo recibe en ${place}`,
      agentAtOff: ({ agent, place }) => `${agent} no lo recibe en ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Disponible para ${agents} en ${machines}${projects ? `, solo en ${projects}` : ''}`,
    availableNowhere: 'Aún no está disponible en ningún sitio',
    offlineNote: ({ machine }) =>
      `${machine} está sin conexión. Lo recibirá cuando vuelva.`,
    offlineNoteMany: ({ count }) =>
      `${count} máquinas sin conexión lo recibirán cuando vuelvan.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} no puede cargar habilidades.`
        : `${agent} no puede usar servidores MCP.`,
  },
  control: {
    title: 'Dónde está activo',
    description: 'Configúralo una vez y todas las máquinas lo siguen. Gana la regla más específica.',
    everywhereLabel: 'Activado o desactivado en todas partes',
    on: 'Sí',
    off: 'No',
    turnedOnIn: 'Activado en',
    except: 'Excepto',
    nowhereYet: 'Todavía en ningún sitio. Añade un proyecto, una máquina o un agente.',
    addException: 'Añadir una excepción',
    addPlace: 'Añadir un lugar',
    menuAgent: 'Un agente',
    menuAgentEverywhere: 'Un agente, en todas partes',
    menuMachine: 'Una máquina',
    menuProject: 'Un proyecto',
    menuProjectEverywhere: 'Un proyecto, en todas las máquinas',
    offline: 'sin conexión',
    machineCount: ({ count }) => count === 1 ? '1 máquina' : `${count} máquinas`,
    allAgents: 'Todos los agentes',
    agentOnly: ({ agent }) => `Solo ${agent}`,
    whichAgents: ({ place }) => `Qué agentes en ${place}`,
    remove: ({ target }) => `Quitar la regla de ${target}`,
    staysOff: ({ agents }) => `${agents} sigue desactivado aquí`,
    change: 'Cambiar',
    changeFailed: 'No se pudo guardar el cambio.',
  },
  add: {
    closeDetails: 'Cerrar detalles',
    backTo: ({ title }) => `Volver a ${title}`,
    added: 'Añadido',
    done: 'Listo',
    addFailed: 'No se pudo añadir. Inténtalo de nuevo.',
    modesLabel: 'Formas de añadir',
    searchLabel: 'Buscar',
  },
  facts: {
    textOnly: 'Solo texto',
    hasFiles: 'Tiene archivos',
    runsScripts: 'Ejecuta scripts',
    tokensWhenUsed: ({ count }) => `${count} tokens`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} herramienta` : `${shown} herramientas`),
    tokensPerTurn: ({ count }) => `${count} tokens por turno`,
    you: 'Tú',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Fijado en ${ref}`,
    inYourLibrary: 'En tu biblioteca',
  },
  status: {
    off: 'Desactivado',
    signin: 'Requiere iniciar sesión',
    moreAccess: 'Requiere más acceso',
    key: 'Requiere una clave',
    cantrun: ({ machine }) =>
      machine ? `No puede ejecutarse en ${machine}` : 'No puede ejecutarse',
    offline: 'Sin conexión',
    update: 'Actualización disponible',
    modified: 'Modificado',
    pinned: 'Fijado',
    unused: 'Sin uso reciente',
    unusedExplanation: ({ agents }) =>
      `El uso se registra para ${agents} y los agentes que leen habilidades a través de Happier`,
    error: ({ machine }) =>
      machine ? `Detenido en ${machine}` : 'No se pudo iniciar',
    masked: ({ machine }) =>
      machine ? `Prevalece la copia de ${machine}` : 'Prevalece otra copia',
    signing: 'Iniciando sesión…',
    connected: 'Conectado',
    expired: 'La sesión ha caducado',
    revoked: 'Acceso revocado',
    fix: {
      signIn: 'Iniciar sesión',
      reconnect: 'Reconectar',
      addKey: 'Añadir una clave',
      howToFix: 'Cómo solucionarlo',
      tryAgain: 'Reintentar',
      reviewUpdate: 'Revisar actualización',
      compare: 'Comparar',
      turnOn: 'Activar',
      grantAccess: 'Conceder acceso',
    },
  },
};

const fr: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Activé partout',
    everywhere: 'Partout',
    off: 'Désactivé',
    only: ({ agent, place, placeKind }) =>
      join(
        'Seulement',
        agent && `pour ${agent}`,
        place && `${placeKind === 'machine' ? 'sur' : 'dans'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      join(
        'activé',
        agent && `pour ${agent}`,
        place && `${placeKind === 'machine' ? 'sur' : 'dans'} ${place}`,
      ),
    except: ({ agent, place, placeKind }) =>
      join(
        'sauf',
        agent,
        place && `${placeKind === 'machine' ? 'sur' : 'dans'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1 ? '1 exception' : `${count} exceptions`,
    more: ({ count }) => `${count} de plus`,
    effect: {
      everywhereOn:
        'Toutes les machines et tous les agents, y compris ceux ajoutés plus tard',
      everywhereOff: 'Désactivé sauf si une règle ci-dessous l’active',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Ne reçoit jamais cette compétence, où qu’elle soit activée'
          : 'Ne reçoit jamais ce serveur, où qu’il soit activé',
      agentEverywhereOn: 'La reçoit même là où le reste est désactivé',
      machineOn: 'Tous les agents de cette machine',
      machineOff: 'Aucun agent de cette machine',
      projectOn: 'Dans ce projet, sur toutes les machines',
      projectOff: 'Pas dans ce projet, sur aucune machine',
      folderOn: 'Dans ce dossier sur cette machine',
      folderOff: 'Pas dans ce dossier',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} la reçoit ${placeKind === 'machine' ? 'sur' : 'dans'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} ne la reçoit pas ${placeKind === 'machine' ? 'sur' : 'dans'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Disponible pour ${agents} sur ${machines}${projects ? `, uniquement dans ${projects}` : ''}`,
    availableNowhere: 'Disponible nulle part pour l’instant',
    offlineNote: ({ machine }) =>
      `${machine} est hors ligne. Il la recevra à son retour.`,
    offlineNoteMany: ({ count }) =>
      `${count} machines hors ligne la recevront à leur retour.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} ne peut pas charger de compétences.`
        : `${agent} ne peut pas utiliser de serveurs MCP.`,
  },
  control: {
    title: 'Où c’est actif',
    description: 'Réglez-le une fois et chaque machine suit. La règle la plus précise l’emporte.',
    everywhereLabel: 'Activé ou désactivé partout',
    on: 'Oui',
    off: 'Non',
    turnedOnIn: 'Activé dans',
    except: 'Sauf',
    nowhereYet: 'Nulle part pour l’instant. Ajoutez un projet, une machine ou un agent.',
    addException: 'Ajouter une exception',
    addPlace: 'Ajouter un lieu',
    menuAgent: 'Un agent',
    menuAgentEverywhere: 'Un agent, partout',
    menuMachine: 'Une machine',
    menuProject: 'Un projet',
    menuProjectEverywhere: 'Un projet, sur chaque machine',
    offline: 'hors ligne',
    machineCount: ({ count }) => count === 1 ? '1 machine' : `${count} machines`,
    allAgents: 'Tous les agents',
    agentOnly: ({ agent }) => `${agent} uniquement`,
    whichAgents: ({ place }) => `Quels agents dans ${place}`,
    remove: ({ target }) => `Retirer la règle pour ${target}`,
    staysOff: ({ agents }) => `${agents} reste désactivé ici`,
    change: 'Modifier',
    changeFailed: 'Impossible d’enregistrer ce changement.',
  },
  add: {
    closeDetails: 'Fermer les détails',
    backTo: ({ title }) => `Retour à ${title}`,
    added: 'Ajouté',
    done: 'Terminé',
    addFailed: 'Impossible de l’ajouter. Réessayez.',
    modesLabel: 'Façons d’ajouter',
    searchLabel: 'Rechercher',
  },
  facts: {
    textOnly: 'Texte seul',
    hasFiles: 'Contient des fichiers',
    runsScripts: 'Exécute des scripts',
    tokensWhenUsed: ({ count }) => `${count} jetons`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} outil` : `${shown} outils`),
    tokensPerTurn: ({ count }) => `${count} jetons par tour`,
    you: 'Vous',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Épinglé à ${ref}`,
    inYourLibrary: 'Dans votre bibliothèque',
  },
  status: {
    off: 'Désactivé',
    signin: 'Connexion requise',
    moreAccess: 'Accès supplémentaire requis',
    key: 'Clé requise',
    cantrun: ({ machine }) =>
      machine
        ? `Ne peut pas s’exécuter sur ${machine}`
        : 'Ne peut pas s’exécuter',
    offline: 'Hors ligne',
    update: 'Mise à jour disponible',
    modified: 'Modifié',
    pinned: 'Épinglé',
    unused: 'Pas utilisé récemment',
    unusedExplanation: ({ agents }) =>
      `L’utilisation est enregistrée pour ${agents} et les agents qui lisent les compétences via Happier`,
    error: ({ machine }) =>
      machine ? `Arrêté sur ${machine}` : 'Impossible de démarrer',
    masked: ({ machine }) =>
      machine
        ? `La copie de ${machine} l’emporte`
        : 'Une autre copie l’emporte',
    signing: 'Connexion…',
    connected: 'Connecté',
    expired: 'Connexion expirée',
    revoked: 'Accès révoqué',
    fix: {
      signIn: 'Se connecter',
      reconnect: 'Reconnecter',
      addKey: 'Ajouter une clé',
      howToFix: 'Comment corriger',
      tryAgain: 'Réessayer',
      reviewUpdate: 'Examiner la mise à jour',
      compare: 'Comparer',
      turnOn: 'Activer',
      grantAccess: 'Accorder l’accès',
    },
  },
};

const it: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Attivo ovunque',
    everywhere: 'Ovunque',
    off: 'Disattivato',
    only: ({ agent, place, placeKind }) =>
      join(
        'Solo',
        agent && `per ${agent}`,
        place && `${placeKind === 'machine' ? 'su' : 'in'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      join(
        'attivo',
        agent && `per ${agent}`,
        place && `${placeKind === 'machine' ? 'su' : 'in'} ${place}`,
      ),
    except: ({ agent, place, placeKind }) =>
      join(
        'tranne',
        agent,
        place && `${placeKind === 'machine' ? 'su' : 'in'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1 ? '1 eccezione' : `${count} eccezioni`,
    more: ({ count }) => `altri ${count}`,
    effect: {
      everywhereOn: 'Ogni macchina e agente, e quelli che aggiungerai',
      everywhereOff: 'Disattivato salvo che una regola sotto lo attivi',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Non riceve mai questa skill, ovunque sia attiva'
          : 'Non riceve mai questo server, ovunque sia attivo',
      agentEverywhereOn: 'Lo riceve anche dove il resto è disattivato',
      machineOn: 'Ogni agente su questa macchina',
      machineOff: 'Nessun agente su questa macchina',
      projectOn: 'In questo progetto, su ogni macchina',
      projectOff: 'Non in questo progetto, su nessuna macchina',
      folderOn: 'In questa cartella su questa macchina',
      folderOff: 'Non in questa cartella',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} lo riceve ${placeKind === 'machine' ? 'su' : 'in'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} non lo riceve ${placeKind === 'machine' ? 'su' : 'in'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Disponibile per ${agents} su ${machines}${projects ? `, solo in ${projects}` : ''}`,
    availableNowhere: 'Non ancora disponibile da nessuna parte',
    offlineNote: ({ machine }) =>
      `${machine} è offline. Lo riceverà quando torna.`,
    offlineNoteMany: ({ count }) =>
      `${count} macchine offline lo riceveranno quando tornano.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} non può caricare skill.`
        : `${agent} non può usare server MCP.`,
  },
  control: {
    title: 'Dove è attivo',
    description: 'Impostalo una volta e ogni macchina si adegua. Vince la regola più specifica.',
    everywhereLabel: 'Attivo o spento ovunque',
    on: 'Sì',
    off: 'No',
    turnedOnIn: 'Attivo in',
    except: 'Tranne',
    nowhereYet: 'Ancora da nessuna parte. Aggiungi un progetto, una macchina o un agente.',
    addException: 'Aggiungi un’eccezione',
    addPlace: 'Aggiungi un luogo',
    menuAgent: 'Un agente',
    menuAgentEverywhere: 'Un agente, ovunque',
    menuMachine: 'Una macchina',
    menuProject: 'Un progetto',
    menuProjectEverywhere: 'Un progetto, su ogni macchina',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 macchina' : `${count} macchine`,
    allAgents: 'Tutti gli agenti',
    agentOnly: ({ agent }) => `Solo ${agent}`,
    whichAgents: ({ place }) => `Quali agenti in ${place}`,
    remove: ({ target }) => `Rimuovi la regola per ${target}`,
    staysOff: ({ agents }) => `${agents} resta spento qui`,
    change: 'Cambia',
    changeFailed: 'Impossibile salvare la modifica.',
  },
  add: {
    closeDetails: 'Chiudi dettagli',
    backTo: ({ title }) => `Torna a ${title}`,
    added: 'Aggiunto',
    done: 'Fatto',
    addFailed: 'Impossibile aggiungerlo. Riprova.',
    modesLabel: 'Modi per aggiungere',
    searchLabel: 'Cerca',
  },
  facts: {
    textOnly: 'Solo testo',
    hasFiles: 'Contiene file',
    runsScripts: 'Esegue script',
    tokensWhenUsed: ({ count }) => `${count} token`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} strumento` : `${shown} strumenti`),
    tokensPerTurn: ({ count }) => `${count} token per turno`,
    you: 'Tu',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Fissato a ${ref}`,
    inYourLibrary: 'Nella tua libreria',
  },
  status: {
    off: 'Disattivato',
    signin: 'Accesso richiesto',
    moreAccess: 'Serve più accesso',
    key: 'Serve una chiave',
    cantrun: ({ machine }) =>
      machine
        ? `Non può essere eseguito su ${machine}`
        : 'Non può essere eseguito',
    offline: 'Offline',
    update: 'Aggiornamento disponibile',
    modified: 'Modificato',
    pinned: 'Fissato',
    unused: 'Non usato di recente',
    unusedExplanation: ({ agents }) =>
      `L’uso viene registrato per ${agents} e per gli agenti che leggono le skill tramite Happier`,
    error: ({ machine }) =>
      machine ? `Fermato su ${machine}` : 'Impossibile avviare',
    masked: ({ machine }) =>
      machine ? `Prevale la copia di ${machine}` : 'Prevale un’altra copia',
    signing: 'Accesso in corso…',
    connected: 'Connesso',
    expired: 'Accesso scaduto',
    revoked: 'Accesso revocato',
    fix: {
      signIn: 'Accedi',
      reconnect: 'Riconnetti',
      addKey: 'Aggiungi una chiave',
      howToFix: 'Come risolvere',
      tryAgain: 'Riprova',
      reviewUpdate: 'Rivedi aggiornamento',
      compare: 'Confronta',
      turnOn: 'Attiva',
      grantAccess: 'Concedi accesso',
    },
  },
};

const ja: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'すべてでオン',
    everywhere: 'すべて',
    off: 'オフ',
    only: ({ agent, place }) =>
      `${[place, agent && `${agent} 向け`].filter(Boolean).join(' · ')}のみ`,
    on: ({ agent, place }) =>
      `${[place, agent && `${agent} 向け`].filter(Boolean).join(' · ')}ではオン`,
    except: ({ agent, place }) =>
      `${[place, agent].filter(Boolean).join(' · ')}を除く`,
    exceptions: ({ count }) => `例外 ${count} 件`,
    more: ({ count }) => `ほか ${count} 件`,
    effect: {
      everywhereOn: 'すべてのマシンとエージェント、今後追加するものも含む',
      everywhereOff: '下のルールでオンにしない限りオフ',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'どこでオンでも、このスキルを受け取りません'
          : 'どこでオンでも、このサーバーを受け取りません',
      agentEverywhereOn: '他がオフの場所でも受け取ります',
      machineOn: 'このマシンのすべてのエージェント',
      machineOff: 'このマシンのエージェントには提供しません',
      projectOn: 'このプロジェクトで、すべてのマシン',
      projectOff: 'このプロジェクトでは、どのマシンでも提供しません',
      folderOn: 'このマシンのこのフォルダー',
      folderOff: 'このフォルダーでは提供しません',
      agentAtOn: ({ agent, place }) => `${agent} は ${place} で受け取ります`,
      agentAtOff: ({ agent, place }) =>
        `${agent} は ${place} では受け取りません`,
    },
    available: ({ agents, machines, projects }) =>
      `${machines} の ${agents} で利用できます${projects ? `（${projects} のみ）` : ''}`,
    availableNowhere: 'まだどこでも利用できません',
    offlineNote: ({ machine }) =>
      `${machine} はオフラインです。戻ったときに受け取ります。`,
    offlineNoteMany: ({ count }) =>
      `オフラインのマシン ${count} 台は、戻ったときに受け取ります。`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} はスキルを読み込めません。`
        : `${agent} は MCP サーバーを使えません。`,
  },
  control: {
    title: '有効な場所',
    description: '一度設定すればすべてのマシンに反映されます。最も具体的なルールが優先されます。',
    everywhereLabel: 'すべての場所でオンまたはオフ',
    on: 'オン',
    off: 'オフ',
    turnedOnIn: 'オンにする場所',
    except: '除外',
    nowhereYet: 'まだどこにもありません。プロジェクト、マシン、またはエージェントを追加してください。',
    addException: '除外を追加',
    addPlace: '場所を追加',
    menuAgent: 'エージェント',
    menuAgentEverywhere: 'エージェント(すべての場所)',
    menuMachine: 'マシン',
    menuProject: 'プロジェクト',
    menuProjectEverywhere: 'プロジェクト(すべてのマシン)',
    offline: 'オフライン',
    machineCount: ({ count }) => `${count}台のマシン`,
    allAgents: 'すべてのエージェント',
    agentOnly: ({ agent }) => `${agent}のみ`,
    whichAgents: ({ place }) => `${place}で使うエージェント`,
    remove: ({ target }) => `${target}のルールを削除`,
    staysOff: ({ agents }) => `${agents}はここでもオフのままです`,
    change: '変更',
    changeFailed: '変更を保存できませんでした。',
  },
  add: {
    closeDetails: '詳細を閉じる',
    backTo: ({ title }) => `戻る: ${title}`,
    added: '追加済み',
    done: '完了',
    addFailed: '追加できませんでした。もう一度お試しください。',
    modesLabel: '追加方法',
    searchLabel: '検索',
  },
  facts: {
    textOnly: 'テキストのみ',
    hasFiles: 'ファイルあり',
    runsScripts: 'スクリプトを実行',
    tokensWhenUsed: ({ count }) => `${count} トークン`,
    toolCount: ({ shown }) => `${shown} ツール`,
    tokensPerTurn: ({ count }) => `${count} トークン/ターン`,
    you: 'あなた',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `固定: ${ref}`,
    inYourLibrary: 'ライブラリにあります',
  },
  status: {
    off: 'オフ',
    signin: 'サインインが必要',
    moreAccess: '追加のアクセスが必要',
    key: 'キーが必要',
    cantrun: ({ machine }) =>
      machine ? `${machine} で実行できません` : '実行できません',
    offline: 'オフライン',
    update: 'アップデートあり',
    modified: '変更済み',
    pinned: '固定',
    unused: '最近使われていません',
    unusedExplanation: ({ agents }) =>
      `使用状況は ${agents} と、Happier 経由でスキルを読むエージェントで記録されます`,
    error: ({ machine }) =>
      machine ? `${machine} で停止` : '起動できませんでした',
    masked: ({ machine }) =>
      machine ? `${machine} のコピーが優先` : '別のコピーが優先',
    signing: 'サインイン中…',
    connected: '接続済み',
    expired: 'サインインの期限切れ',
    revoked: 'アクセスが取り消されました',
    fix: {
      signIn: 'サインイン',
      reconnect: '再接続',
      addKey: 'キーを追加',
      howToFix: '解決方法',
      tryAgain: '再試行',
      reviewUpdate: 'アップデートを確認',
      compare: '比較',
      turnOn: 'オンにする',
      grantAccess: 'アクセスを許可',
    },
  },
};

const pl: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Włączone wszędzie',
    everywhere: 'Wszędzie',
    off: 'Wyłączone',
    only: ({ agent, place, placeKind }) =>
      join(
        'Tylko',
        agent && `dla ${agent}`,
        place && `${placeKind === 'machine' ? 'na' : 'w'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      join(
        'włączone',
        agent && `dla ${agent}`,
        place && `${placeKind === 'machine' ? 'na' : 'w'} ${place}`,
      ),
    except: ({ agent, place, placeKind }) =>
      join(
        'oprócz',
        agent,
        place && `${placeKind === 'machine' ? 'na' : 'w'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1
        ? '1 wyjątek'
        : count % 10 >= 2 &&
            count % 10 <= 4 &&
            (count % 100 < 12 || count % 100 > 14)
          ? `${count} wyjątki`
          : `${count} wyjątków`,
    more: ({ count }) => `jeszcze ${count}`,
    effect: {
      everywhereOn: 'Każda maszyna i agent, także dodane później',
      everywhereOff: 'Wyłączone, chyba że reguła poniżej to włączy',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Nigdy nie dostaje tej umiejętności, gdziekolwiek jest włączona'
          : 'Nigdy nie dostaje tego serwera, gdziekolwiek jest włączony',
      agentEverywhereOn: 'Dostaje to nawet tam, gdzie reszta jest wyłączona',
      machineOn: 'Każdy agent na tej maszynie',
      machineOff: 'Żaden agent na tej maszynie',
      projectOn: 'W tym projekcie, na każdej maszynie',
      projectOff: 'Nie w tym projekcie, na żadnej maszynie',
      folderOn: 'W tym folderze na tej maszynie',
      folderOff: 'Nie w tym folderze',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} dostaje to ${placeKind === 'machine' ? 'na' : 'w'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} nie dostaje tego ${placeKind === 'machine' ? 'na' : 'w'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Dostępne dla ${agents} na ${machines}${projects ? `, tylko w ${projects}` : ''}`,
    availableNowhere: 'Jeszcze nigdzie niedostępne',
    offlineNote: ({ machine }) =>
      `${machine} jest offline. Dostanie to po powrocie.`,
    offlineNoteMany: ({ count }) =>
      `${count} maszyn offline dostanie to po powrocie.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} nie może wczytywać umiejętności.`
        : `${agent} nie może używać serwerów MCP.`,
  },
  control: {
    title: 'Gdzie jest włączone',
    description: 'Ustaw raz, a każda maszyna się dostosuje. Wygrywa najbardziej szczegółowa reguła.',
    everywhereLabel: 'Włączone lub wyłączone wszędzie',
    on: 'Wł.',
    off: 'Wył.',
    turnedOnIn: 'Włączone w',
    except: 'Oprócz',
    nowhereYet: 'Jeszcze nigdzie. Dodaj projekt, maszynę lub agenta.',
    addException: 'Dodaj wyjątek',
    addPlace: 'Dodaj miejsce',
    menuAgent: 'Agent',
    menuAgentEverywhere: 'Agent, wszędzie',
    menuMachine: 'Maszyna',
    menuProject: 'Projekt',
    menuProjectEverywhere: 'Projekt, na każdej maszynie',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 maszyna' : count < 5 ? `${count} maszyny` : `${count} maszyn`,
    allAgents: 'Wszyscy agenci',
    agentOnly: ({ agent }) => `Tylko ${agent}`,
    whichAgents: ({ place }) => `Którzy agenci w ${place}`,
    remove: ({ target }) => `Usuń regułę dla ${target}`,
    staysOff: ({ agents }) => `${agents} pozostaje tu wyłączony`,
    change: 'Zmień',
    changeFailed: 'Nie udało się zapisać zmiany.',
  },
  add: {
    closeDetails: 'Zamknij szczegóły',
    backTo: ({ title }) => `Wróć do ${title}`,
    added: 'Dodano',
    done: 'Gotowe',
    addFailed: 'Nie udało się dodać. Spróbuj ponownie.',
    modesLabel: 'Sposoby dodawania',
    searchLabel: 'Szukaj',
  },
  facts: {
    textOnly: 'Tylko tekst',
    hasFiles: 'Zawiera pliki',
    runsScripts: 'Uruchamia skrypty',
    tokensWhenUsed: ({ count }) => `${count} tokenów`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} narzędzie` : count < 5 ? `${shown} narzędzia` : `${shown} narzędzi`),
    tokensPerTurn: ({ count }) => `${count} tokenów na turę`,
    you: 'Ty',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Przypięte do ${ref}`,
    inYourLibrary: 'W twojej bibliotece',
  },
  status: {
    off: 'Wyłączone',
    signin: 'Wymaga logowania',
    moreAccess: 'Wymaga szerszego dostępu',
    key: 'Wymaga klucza',
    cantrun: ({ machine }) =>
      machine ? `Nie działa na ${machine}` : 'Nie działa',
    offline: 'Offline',
    update: 'Dostępna aktualizacja',
    modified: 'Zmodyfikowane',
    pinned: 'Przypięte',
    unused: 'Nieużywane ostatnio',
    unusedExplanation: ({ agents }) =>
      `Użycie jest rejestrowane dla ${agents} i agentów, które czytają umiejętności przez Happier`,
    error: ({ machine }) =>
      machine ? `Zatrzymane na ${machine}` : 'Nie udało się uruchomić',
    masked: ({ machine }) =>
      machine ? `Wygrywa kopia z ${machine}` : 'Wygrywa inna kopia',
    signing: 'Logowanie…',
    connected: 'Połączono',
    expired: 'Logowanie wygasło',
    revoked: 'Dostęp cofnięty',
    fix: {
      signIn: 'Zaloguj się',
      reconnect: 'Połącz ponownie',
      addKey: 'Dodaj klucz',
      howToFix: 'Jak to naprawić',
      tryAgain: 'Spróbuj ponownie',
      reviewUpdate: 'Przejrzyj aktualizację',
      compare: 'Porównaj',
      turnOn: 'Włącz',
      grantAccess: 'Przyznaj dostęp',
    },
  },
};

const pt: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Ativado em todo lugar',
    everywhere: 'Em todo lugar',
    off: 'Desativado',
    only: ({ agent, place }) =>
      join('Só', agent && `para ${agent}`, place && `em ${place}`),
    on: ({ agent, place }) =>
      join('ativado', agent && `para ${agent}`, place && `em ${place}`),
    except: ({ agent, place }) => join('exceto', agent, place && `em ${place}`),
    exceptions: ({ count }) =>
      count === 1 ? '1 exceção' : `${count} exceções`,
    more: ({ count }) => `mais ${count}`,
    effect: {
      everywhereOn:
        'Todas as máquinas e agentes, e os que você adicionar depois',
      everywhereOff: 'Desativado, a menos que uma regra abaixo o ative',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Nunca recebe esta habilidade, onde quer que esteja ativada'
          : 'Nunca recebe este servidor, onde quer que esteja ativado',
      agentEverywhereOn: 'Recebe mesmo onde o resto está desativado',
      machineOn: 'Todos os agentes desta máquina',
      machineOff: 'Nenhum agente desta máquina',
      projectOn: 'Neste projeto, em todas as máquinas',
      projectOff: 'Não neste projeto, em nenhuma máquina',
      folderOn: 'Nesta pasta desta máquina',
      folderOff: 'Não nesta pasta',
      agentAtOn: ({ agent, place }) => `${agent} recebe em ${place}`,
      agentAtOff: ({ agent, place }) => `${agent} não recebe em ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Disponível para ${agents} em ${machines}${projects ? `, apenas em ${projects}` : ''}`,
    availableNowhere: 'Ainda não está disponível em lugar nenhum',
    offlineNote: ({ machine }) =>
      `${machine} está offline. Vai receber quando voltar.`,
    offlineNoteMany: ({ count }) =>
      `${count} máquinas offline vão receber quando voltarem.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} não pode carregar habilidades.`
        : `${agent} não pode usar servidores MCP.`,
  },
  control: {
    title: 'Onde está ativo',
    description: 'Defina uma vez e todas as máquinas seguem. Vence a regra mais específica.',
    everywhereLabel: 'Ativado ou desativado em todo lugar',
    on: 'Sim',
    off: 'Não',
    turnedOnIn: 'Ativado em',
    except: 'Exceto',
    nowhereYet: 'Ainda em lugar nenhum. Adicione um projeto, uma máquina ou um agente.',
    addException: 'Adicionar uma exceção',
    addPlace: 'Adicionar um lugar',
    menuAgent: 'Um agente',
    menuAgentEverywhere: 'Um agente, em todo lugar',
    menuMachine: 'Uma máquina',
    menuProject: 'Um projeto',
    menuProjectEverywhere: 'Um projeto, em todas as máquinas',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 máquina' : `${count} máquinas`,
    allAgents: 'Todos os agentes',
    agentOnly: ({ agent }) => `Só ${agent}`,
    whichAgents: ({ place }) => `Quais agentes em ${place}`,
    remove: ({ target }) => `Remover a regra de ${target}`,
    staysOff: ({ agents }) => `${agents} continua desativado aqui`,
    change: 'Alterar',
    changeFailed: 'Não foi possível salvar a alteração.',
  },
  add: {
    closeDetails: 'Fechar detalhes',
    backTo: ({ title }) => `Voltar para ${title}`,
    added: 'Adicionado',
    done: 'Concluído',
    addFailed: 'Não foi possível adicionar. Tente novamente.',
    modesLabel: 'Formas de adicionar',
    searchLabel: 'Pesquisar',
  },
  facts: {
    textOnly: 'Só texto',
    hasFiles: 'Tem arquivos',
    runsScripts: 'Executa scripts',
    tokensWhenUsed: ({ count }) => `${count} tokens`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} ferramenta` : `${shown} ferramentas`),
    tokensPerTurn: ({ count }) => `${count} tokens por turno`,
    you: 'Você',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Fixado em ${ref}`,
    inYourLibrary: 'Na sua biblioteca',
  },
  status: {
    off: 'Desativado',
    signin: 'Requer login',
    moreAccess: 'Requer mais acesso',
    key: 'Requer uma chave',
    cantrun: ({ machine }) => (machine ? `Não roda em ${machine}` : 'Não roda'),
    offline: 'Offline',
    update: 'Atualização disponível',
    modified: 'Modificado',
    pinned: 'Fixado',
    unused: 'Sem uso recente',
    unusedExplanation: ({ agents }) =>
      `O uso é registrado para ${agents} e agentes que leem habilidades pelo Happier`,
    error: ({ machine }) =>
      machine ? `Parado em ${machine}` : 'Não foi possível iniciar',
    masked: ({ machine }) =>
      machine ? `A cópia de ${machine} prevalece` : 'Outra cópia prevalece',
    signing: 'Entrando…',
    connected: 'Conectado',
    expired: 'Login expirado',
    revoked: 'Acesso revogado',
    fix: {
      signIn: 'Entrar',
      reconnect: 'Reconectar',
      addKey: 'Adicionar uma chave',
      howToFix: 'Como corrigir',
      tryAgain: 'Tentar novamente',
      reviewUpdate: 'Revisar atualização',
      compare: 'Comparar',
      turnOn: 'Ativar',
      grantAccess: 'Conceder acesso',
    },
  },
};

const ru: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'Включено везде',
    everywhere: 'Везде',
    off: 'Выключено',
    only: ({ agent, place, placeKind }) =>
      join(
        'Только',
        agent && `для ${agent}`,
        place && `${placeKind === 'machine' ? 'на' : 'в'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      join(
        'включено',
        agent && `для ${agent}`,
        place && `${placeKind === 'machine' ? 'на' : 'в'} ${place}`,
      ),
    except: ({ agent, place, placeKind }) =>
      join(
        'кроме',
        agent,
        place && `${placeKind === 'machine' ? 'на' : 'в'} ${place}`,
      ),
    exceptions: ({ count }) => {
      const mod10 = count % 10,
        mod100 = count % 100;
      if (mod10 === 1 && mod100 !== 11) return `${count} исключение`;
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
        return `${count} исключения`;
      return `${count} исключений`;
    },
    more: ({ count }) => `ещё ${count}`,
    effect: {
      everywhereOn: 'Все машины и агенты, включая добавленные позже',
      everywhereOff: 'Выключено, если правило ниже не включит',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Никогда не получает этот навык, где бы он ни был включён'
          : 'Никогда не получает этот сервер, где бы он ни был включён',
      agentEverywhereOn: 'Получает даже там, где остальное выключено',
      machineOn: 'Все агенты на этой машине',
      machineOff: 'Ни один агент на этой машине',
      projectOn: 'В этом проекте, на всех машинах',
      projectOff: 'Не в этом проекте, ни на одной машине',
      folderOn: 'В этой папке на этой машине',
      folderOff: 'Не в этой папке',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} получает ${placeKind === 'machine' ? 'на' : 'в'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} не получает ${placeKind === 'machine' ? 'на' : 'в'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Доступно для ${agents} на ${machines}${projects ? `, только в ${projects}` : ''}`,
    availableNowhere: 'Пока нигде не доступно',
    offlineNote: ({ machine }) =>
      `${machine} не в сети. Получит, когда вернётся.`,
    offlineNoteMany: ({ count }) =>
      `${count} машин не в сети получат это, когда вернутся.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} не может загружать навыки.`
        : `${agent} не может использовать MCP-серверы.`,
  },
  control: {
    title: 'Где включено',
    description: 'Настройте один раз, и все машины последуют. Побеждает самое точное правило.',
    everywhereLabel: 'Включено или выключено везде',
    on: 'Вкл',
    off: 'Выкл',
    turnedOnIn: 'Включено в',
    except: 'Кроме',
    nowhereYet: 'Пока нигде. Добавьте проект, машину или агента.',
    addException: 'Добавить исключение',
    addPlace: 'Добавить место',
    menuAgent: 'Агент',
    menuAgentEverywhere: 'Агент, везде',
    menuMachine: 'Машина',
    menuProject: 'Проект',
    menuProjectEverywhere: 'Проект, на каждой машине',
    offline: 'не в сети',
    machineCount: ({ count }) => count % 10 === 1 && count % 100 !== 11 ? `${count} машина` : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? `${count} машины` : `${count} машин`,
    allAgents: 'Все агенты',
    agentOnly: ({ agent }) => `Только ${agent}`,
    whichAgents: ({ place }) => `Какие агенты в ${place}`,
    remove: ({ target }) => `Удалить правило для ${target}`,
    staysOff: ({ agents }) => `${agents} здесь остаётся выключен`,
    change: 'Изменить',
    changeFailed: 'Не удалось сохранить изменение.',
  },
  add: {
    closeDetails: 'Закрыть подробности',
    backTo: ({ title }) => `Назад: ${title}`,
    added: 'Добавлено',
    done: 'Готово',
    addFailed: 'Не удалось добавить. Попробуйте ещё раз.',
    modesLabel: 'Способы добавить',
    searchLabel: 'Поиск',
  },
  facts: {
    textOnly: 'Только текст',
    hasFiles: 'Есть файлы',
    runsScripts: 'Запускает скрипты',
    tokensWhenUsed: ({ count }) => `${count} токенов`,
    toolCount: ({ count, shown }) => (count % 10 === 1 && count % 100 !== 11 ? `${shown} инструмент` : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? `${shown} инструмента` : `${shown} инструментов`),
    tokensPerTurn: ({ count }) => `${count} токенов за ход`,
    you: 'Вы',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Закреплено на ${ref}`,
    inYourLibrary: 'В вашей библиотеке',
  },
  status: {
    off: 'Выключено',
    signin: 'Нужен вход',
    moreAccess: 'Нужен расширенный доступ',
    key: 'Нужен ключ',
    cantrun: ({ machine }) =>
      machine ? `Не запускается на ${machine}` : 'Не запускается',
    offline: 'Не в сети',
    update: 'Есть обновление',
    modified: 'Изменено',
    pinned: 'Закреплено',
    unused: 'Давно не использовался',
    unusedExplanation: ({ agents }) =>
      `Использование учитывается для ${agents} и агентов, читающих навыки через Happier`,
    error: ({ machine }) =>
      machine ? `Остановлено на ${machine}` : 'Не удалось запустить',
    masked: ({ machine }) =>
      machine ? `Действует копия с ${machine}` : 'Действует другая копия',
    signing: 'Вход…',
    connected: 'Подключено',
    expired: 'Вход истёк',
    revoked: 'Доступ отозван',
    fix: {
      signIn: 'Войти',
      reconnect: 'Переподключить',
      addKey: 'Добавить ключ',
      howToFix: 'Как исправить',
      tryAgain: 'Повторить',
      reviewUpdate: 'Просмотреть обновление',
      compare: 'Сравнить',
      turnOn: 'Включить',
      grantAccess: 'Дать доступ',
    },
  },
};

const zhHans: CapabilityKitTranslation = {
  where: {
    onEverywhere: '全部开启',
    everywhere: '全部',
    off: '关闭',
    only: ({ agent, place }) =>
      `仅${[place && `在 ${place}`, agent && `对 ${agent}`].filter(Boolean).join(' ')}`,
    on: ({ agent, place }) =>
      `${[place && `在 ${place}`, agent && `对 ${agent}`].filter(Boolean).join(' ')}开启`,
    except: ({ agent, place }) =>
      `${[place && `在 ${place}`, agent && `对 ${agent}`].filter(Boolean).join(' ')}除外`,
    exceptions: ({ count }) => `${count} 个例外`,
    more: ({ count }) => `另外 ${count} 个`,
    effect: {
      everywhereOn: '所有机器和代理，包括之后添加的',
      everywhereOff: '关闭，除非下方规则开启',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? '无论在哪里开启，都不会获得此技能'
          : '无论在哪里开启，都不会获得此服务器',
      agentEverywhereOn: '即使其他地方关闭也会获得',
      machineOn: '这台机器上的所有代理',
      machineOff: '这台机器上的代理都不会获得',
      projectOn: '在此项目中，所有机器',
      projectOff: '不在此项目中，任何机器都不会获得',
      folderOn: '这台机器上的此文件夹',
      folderOff: '不在此文件夹中',
      agentAtOn: ({ agent, place }) => `${agent} 在 ${place} 获得`,
      agentAtOff: ({ agent, place }) => `${agent} 在 ${place} 不获得`,
    },
    available: ({ agents, machines, projects }) => `${machines} 上的 ${agents} 可用${projects ? `，仅限 ${projects}` : ''}`,
    availableNowhere: '尚未在任何地方可用',
    offlineNote: ({ machine }) => `${machine} 已离线。恢复后会获得。`,
    offlineNoteMany: ({ count }) =>
      `${count} 台离线的机器恢复后会获得。`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} 无法加载技能。`
        : `${agent} 无法使用 MCP 服务器。`,
  },
  control: {
    title: '启用范围',
    description: '设置一次,每台机器都会跟随。最具体的规则优先。',
    everywhereLabel: '在所有位置开启或关闭',
    on: '开',
    off: '关',
    turnedOnIn: '启用于',
    except: '除外',
    nowhereYet: '还没有任何位置。添加一个项目、一台机器或一个智能体。',
    addException: '添加例外',
    addPlace: '添加位置',
    menuAgent: '智能体',
    menuAgentEverywhere: '智能体(所有位置)',
    menuMachine: '机器',
    menuProject: '项目',
    menuProjectEverywhere: '项目(所有机器)',
    offline: '离线',
    machineCount: ({ count }) => `${count} 台机器`,
    allAgents: '所有智能体',
    agentOnly: ({ agent }) => `仅 ${agent}`,
    whichAgents: ({ place }) => `${place} 中的智能体`,
    remove: ({ target }) => `删除 ${target} 的规则`,
    staysOff: ({ agents }) => `${agents} 在这里仍保持关闭`,
    change: '更改',
    changeFailed: '无法保存此更改。',
  },
  add: {
    closeDetails: '关闭详情',
    backTo: ({ title }) => `返回 ${title}`,
    added: '已添加',
    done: '完成',
    addFailed: '无法添加，请重试。',
    modesLabel: '添加方式',
    searchLabel: '搜索',
  },
  facts: {
    textOnly: '仅文本',
    hasFiles: '包含文件',
    runsScripts: '运行脚本',
    tokensWhenUsed: ({ count }) => `${count} 个令牌`,
    toolCount: ({ shown }) => `${shown} 个工具`,
    tokensPerTurn: ({ count }) => `${count} 个令牌/轮`,
    you: '你',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `固定到 ${ref}`,
    inYourLibrary: '在你的库中',
  },
  status: {
    off: '关闭',
    signin: '需要登录',
    moreAccess: '需要更多权限',
    key: '需要密钥',
    cantrun: ({ machine }) =>
      machine ? `无法在 ${machine} 上运行` : '无法运行',
    offline: '离线',
    update: '有可用更新',
    modified: '已修改',
    pinned: '已固定',
    unused: '最近未使用',
    unusedExplanation: ({ agents }) =>
      `会记录 ${agents} 以及通过 Happier 读取技能的代理的使用情况`,
    error: ({ machine }) => (machine ? `已在 ${machine} 上停止` : '无法启动'),
    masked: ({ machine }) =>
      machine ? `${machine} 的副本优先` : '另一份副本优先',
    signing: '正在登录…',
    connected: '已连接',
    expired: '登录已过期',
    revoked: '访问已撤销',
    fix: {
      signIn: '登录',
      reconnect: '重新连接',
      addKey: '添加密钥',
      howToFix: '如何修复',
      tryAgain: '重试',
      reviewUpdate: '查看更新',
      compare: '比较',
      turnOn: '开启',
      grantAccess: '授予访问权限',
    },
  },
};

const zhHant: CapabilityKitTranslation = {
  where: {
    onEverywhere: '全部開啟',
    everywhere: '全部',
    off: '關閉',
    only: ({ agent, place }) =>
      `僅${[place && `在 ${place}`, agent && `對 ${agent}`].filter(Boolean).join(' ')}`,
    on: ({ agent, place }) =>
      `${[place && `在 ${place}`, agent && `對 ${agent}`].filter(Boolean).join(' ')}開啟`,
    except: ({ agent, place }) =>
      `${[place && `在 ${place}`, agent && `對 ${agent}`].filter(Boolean).join(' ')}除外`,
    exceptions: ({ count }) => `${count} 個例外`,
    more: ({ count }) => `另外 ${count} 個`,
    effect: {
      everywhereOn: '所有機器和代理，包括之後新增的',
      everywhereOff: '關閉，除非下方規則開啟',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? '無論在哪裡開啟，都不會取得此技能'
          : '無論在哪裡開啟，都不會取得此伺服器',
      agentEverywhereOn: '即使其他地方關閉也會取得',
      machineOn: '這台機器上的所有代理',
      machineOff: '這台機器上的代理都不會取得',
      projectOn: '在此專案中，所有機器',
      projectOff: '不在此專案中，任何機器都不會取得',
      folderOn: '這台機器上的此資料夾',
      folderOff: '不在此資料夾中',
      agentAtOn: ({ agent, place }) => `${agent} 在 ${place} 取得`,
      agentAtOff: ({ agent, place }) => `${agent} 在 ${place} 不取得`,
    },
    available: ({ agents, machines, projects }) => `${machines} 上的 ${agents} 可用${projects ? `，僅限 ${projects}` : ''}`,
    availableNowhere: '尚未在任何地方可用',
    offlineNote: ({ machine }) => `${machine} 已離線。恢復後會取得。`,
    offlineNoteMany: ({ count }) =>
      `${count} 台離線的機器恢復後會取得。`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} 無法載入技能。`
        : `${agent} 無法使用 MCP 伺服器。`,
  },
  control: {
    title: '啟用範圍',
    description: '設定一次,每台機器都會跟隨。最具體的規則優先。',
    everywhereLabel: '在所有位置開啟或關閉',
    on: '開',
    off: '關',
    turnedOnIn: '啟用於',
    except: '除外',
    nowhereYet: '還沒有任何位置。新增一個專案、一台機器或一個代理。',
    addException: '新增例外',
    addPlace: '新增位置',
    menuAgent: '代理',
    menuAgentEverywhere: '代理(所有位置)',
    menuMachine: '機器',
    menuProject: '專案',
    menuProjectEverywhere: '專案(所有機器)',
    offline: '離線',
    machineCount: ({ count }) => `${count} 台機器`,
    allAgents: '所有代理',
    agentOnly: ({ agent }) => `僅 ${agent}`,
    whichAgents: ({ place }) => `${place} 中的代理`,
    remove: ({ target }) => `刪除 ${target} 的規則`,
    staysOff: ({ agents }) => `${agents} 在這裡仍保持關閉`,
    change: '變更',
    changeFailed: '無法儲存此變更。',
  },
  add: {
    closeDetails: '關閉詳情',
    backTo: ({ title }) => `返回 ${title}`,
    added: '已新增',
    done: '完成',
    addFailed: '無法新增，請再試一次。',
    modesLabel: '新增方式',
    searchLabel: '搜尋',
  },
  facts: {
    textOnly: '僅文字',
    hasFiles: '包含檔案',
    runsScripts: '執行指令碼',
    tokensWhenUsed: ({ count }) => `${count} 個權杖`,
    toolCount: ({ shown }) => `${shown} 個工具`,
    tokensPerTurn: ({ count }) => `${count} 個權杖/輪`,
    you: '你',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `釘選到 ${ref}`,
    inYourLibrary: '在你的資料庫中',
  },
  status: {
    off: '關閉',
    signin: '需要登入',
    moreAccess: '需要更多權限',
    key: '需要金鑰',
    cantrun: ({ machine }) =>
      machine ? `無法在 ${machine} 上執行` : '無法執行',
    offline: '離線',
    update: '有可用更新',
    modified: '已修改',
    pinned: '已釘選',
    unused: '最近未使用',
    unusedExplanation: ({ agents }) =>
      `會記錄 ${agents} 以及透過 Happier 讀取技能的代理的使用情況`,
    error: ({ machine }) => (machine ? `已在 ${machine} 上停止` : '無法啟動'),
    masked: ({ machine }) =>
      machine ? `${machine} 的副本優先` : '另一份副本優先',
    signing: '正在登入…',
    connected: '已連線',
    expired: '登入已過期',
    revoked: '存取已撤銷',
    fix: {
      signIn: '登入',
      reconnect: '重新連線',
      addKey: '新增金鑰',
      howToFix: '如何修正',
      tryAgain: '重試',
      reviewUpdate: '查看更新',
      compare: '比較',
      turnOn: '開啟',
      grantAccess: '授予存取權',
    },
  },
};

// The Skills page family's copy rides in each locale's `capabilities` block as `capabilities.skills`.
export const capabilityKitTranslations = {
  en: { ...en, skills: skillsPageTranslations.en, session: sessionCapabilityTranslations.en, notice: capabilityNoticeTranslations.en, detail: capabilityDetailTranslations.en, skillDetail: skillDetailTranslations.en, skillsFound: skillsFoundTranslations.en, skillsUpdates: skillsUpdatesTranslations.en, mcp: mcpPageTranslations.en, valueRows: valueRefRowsTranslations.en, mcpSignIn: mcpSignInTranslations.en, mcpHome: mcpHomeTranslations.en, registries: registriesTranslations.en, skillAdd: skillAddTranslations.en, mcpAdd: mcpAddTranslations.en, agentAdd: agentAddTranslations.en, profileSeeds: profileSeedsTranslations.en, scopeSection: scopeSectionTranslations.en , store: storeTranslations.en },
  ca: { ...ca, skills: skillsPageTranslations.ca, session: sessionCapabilityTranslations.ca, notice: capabilityNoticeTranslations.ca, detail: capabilityDetailTranslations.ca, skillDetail: skillDetailTranslations.ca, skillsFound: skillsFoundTranslations.ca, skillsUpdates: skillsUpdatesTranslations.ca, mcp: mcpPageTranslations.ca, valueRows: valueRefRowsTranslations.ca, mcpSignIn: mcpSignInTranslations.ca, mcpHome: mcpHomeTranslations.ca, registries: registriesTranslations.ca, skillAdd: skillAddTranslations.ca, mcpAdd: mcpAddTranslations.ca, agentAdd: agentAddTranslations.ca, profileSeeds: profileSeedsTranslations.ca, scopeSection: scopeSectionTranslations.ca , store: storeTranslations.ca },
  de: { ...de, skills: skillsPageTranslations.de, session: sessionCapabilityTranslations.de, notice: capabilityNoticeTranslations.de, detail: capabilityDetailTranslations.de, skillDetail: skillDetailTranslations.de, skillsFound: skillsFoundTranslations.de, skillsUpdates: skillsUpdatesTranslations.de, mcp: mcpPageTranslations.de, valueRows: valueRefRowsTranslations.de, mcpSignIn: mcpSignInTranslations.de, mcpHome: mcpHomeTranslations.de, registries: registriesTranslations.de, skillAdd: skillAddTranslations.de, mcpAdd: mcpAddTranslations.de, agentAdd: agentAddTranslations.de, profileSeeds: profileSeedsTranslations.de, scopeSection: scopeSectionTranslations.de , store: storeTranslations.de },
  es: { ...es, skills: skillsPageTranslations.es, session: sessionCapabilityTranslations.es, notice: capabilityNoticeTranslations.es, detail: capabilityDetailTranslations.es, skillDetail: skillDetailTranslations.es, skillsFound: skillsFoundTranslations.es, skillsUpdates: skillsUpdatesTranslations.es, mcp: mcpPageTranslations.es, valueRows: valueRefRowsTranslations.es, mcpSignIn: mcpSignInTranslations.es, mcpHome: mcpHomeTranslations.es, registries: registriesTranslations.es, skillAdd: skillAddTranslations.es, mcpAdd: mcpAddTranslations.es, agentAdd: agentAddTranslations.es, profileSeeds: profileSeedsTranslations.es, scopeSection: scopeSectionTranslations.es , store: storeTranslations.es },
  fr: { ...fr, skills: skillsPageTranslations.fr, session: sessionCapabilityTranslations.fr, notice: capabilityNoticeTranslations.fr, detail: capabilityDetailTranslations.fr, skillDetail: skillDetailTranslations.fr, skillsFound: skillsFoundTranslations.fr, skillsUpdates: skillsUpdatesTranslations.fr, mcp: mcpPageTranslations.fr, valueRows: valueRefRowsTranslations.fr, mcpSignIn: mcpSignInTranslations.fr, mcpHome: mcpHomeTranslations.fr, registries: registriesTranslations.fr, skillAdd: skillAddTranslations.fr, mcpAdd: mcpAddTranslations.fr, agentAdd: agentAddTranslations.fr, profileSeeds: profileSeedsTranslations.fr, scopeSection: scopeSectionTranslations.fr , store: storeTranslations.fr },
  it: { ...it, skills: skillsPageTranslations.it, session: sessionCapabilityTranslations.it, notice: capabilityNoticeTranslations.it, detail: capabilityDetailTranslations.it, skillDetail: skillDetailTranslations.it, skillsFound: skillsFoundTranslations.it, skillsUpdates: skillsUpdatesTranslations.it, mcp: mcpPageTranslations.it, valueRows: valueRefRowsTranslations.it, mcpSignIn: mcpSignInTranslations.it, mcpHome: mcpHomeTranslations.it, registries: registriesTranslations.it, skillAdd: skillAddTranslations.it, mcpAdd: mcpAddTranslations.it, agentAdd: agentAddTranslations.it, profileSeeds: profileSeedsTranslations.it, scopeSection: scopeSectionTranslations.it , store: storeTranslations.it },
  ja: { ...ja, skills: skillsPageTranslations.ja, session: sessionCapabilityTranslations.ja, notice: capabilityNoticeTranslations.ja, detail: capabilityDetailTranslations.ja, skillDetail: skillDetailTranslations.ja, skillsFound: skillsFoundTranslations.ja, skillsUpdates: skillsUpdatesTranslations.ja, mcp: mcpPageTranslations.ja, valueRows: valueRefRowsTranslations.ja, mcpSignIn: mcpSignInTranslations.ja, mcpHome: mcpHomeTranslations.ja, registries: registriesTranslations.ja, skillAdd: skillAddTranslations.ja, mcpAdd: mcpAddTranslations.ja, agentAdd: agentAddTranslations.ja, profileSeeds: profileSeedsTranslations.ja, scopeSection: scopeSectionTranslations.ja , store: storeTranslations.ja },
  pl: { ...pl, skills: skillsPageTranslations.pl, session: sessionCapabilityTranslations.pl, notice: capabilityNoticeTranslations.pl, detail: capabilityDetailTranslations.pl, skillDetail: skillDetailTranslations.pl, skillsFound: skillsFoundTranslations.pl, skillsUpdates: skillsUpdatesTranslations.pl, mcp: mcpPageTranslations.pl, valueRows: valueRefRowsTranslations.pl, mcpSignIn: mcpSignInTranslations.pl, mcpHome: mcpHomeTranslations.pl, registries: registriesTranslations.pl, skillAdd: skillAddTranslations.pl, mcpAdd: mcpAddTranslations.pl, agentAdd: agentAddTranslations.pl, profileSeeds: profileSeedsTranslations.pl, scopeSection: scopeSectionTranslations.pl , store: storeTranslations.pl },
  pt: { ...pt, skills: skillsPageTranslations.pt, session: sessionCapabilityTranslations.pt, notice: capabilityNoticeTranslations.pt, detail: capabilityDetailTranslations.pt, skillDetail: skillDetailTranslations.pt, skillsFound: skillsFoundTranslations.pt, skillsUpdates: skillsUpdatesTranslations.pt, mcp: mcpPageTranslations.pt, valueRows: valueRefRowsTranslations.pt, mcpSignIn: mcpSignInTranslations.pt, mcpHome: mcpHomeTranslations.pt, registries: registriesTranslations.pt, skillAdd: skillAddTranslations.pt, mcpAdd: mcpAddTranslations.pt, agentAdd: agentAddTranslations.pt, profileSeeds: profileSeedsTranslations.pt, scopeSection: scopeSectionTranslations.pt , store: storeTranslations.pt },
  ru: { ...ru, skills: skillsPageTranslations.ru, session: sessionCapabilityTranslations.ru, notice: capabilityNoticeTranslations.ru, detail: capabilityDetailTranslations.ru, skillDetail: skillDetailTranslations.ru, skillsFound: skillsFoundTranslations.ru, skillsUpdates: skillsUpdatesTranslations.ru, mcp: mcpPageTranslations.ru, valueRows: valueRefRowsTranslations.ru, mcpSignIn: mcpSignInTranslations.ru, mcpHome: mcpHomeTranslations.ru, registries: registriesTranslations.ru, skillAdd: skillAddTranslations.ru, mcpAdd: mcpAddTranslations.ru, agentAdd: agentAddTranslations.ru, profileSeeds: profileSeedsTranslations.ru, scopeSection: scopeSectionTranslations.ru , store: storeTranslations.ru },
  zhHans: { ...zhHans, skills: skillsPageTranslations.zhHans, session: sessionCapabilityTranslations.zhHans, notice: capabilityNoticeTranslations.zhHans, detail: capabilityDetailTranslations.zhHans, skillDetail: skillDetailTranslations.zhHans, skillsFound: skillsFoundTranslations.zhHans, skillsUpdates: skillsUpdatesTranslations.zhHans, mcp: mcpPageTranslations.zhHans, valueRows: valueRefRowsTranslations.zhHans, mcpSignIn: mcpSignInTranslations.zhHans, mcpHome: mcpHomeTranslations.zhHans, registries: registriesTranslations.zhHans, skillAdd: skillAddTranslations.zhHans, mcpAdd: mcpAddTranslations.zhHans, agentAdd: agentAddTranslations.zhHans, profileSeeds: profileSeedsTranslations.zhHans, scopeSection: scopeSectionTranslations.zhHans , store: storeTranslations.zhHans },
  zhHant: { ...zhHant, skills: skillsPageTranslations.zhHant, session: sessionCapabilityTranslations.zhHant, notice: capabilityNoticeTranslations.zhHant, detail: capabilityDetailTranslations.zhHant, skillDetail: skillDetailTranslations.zhHant, skillsFound: skillsFoundTranslations.zhHant, skillsUpdates: skillsUpdatesTranslations.zhHant, mcp: mcpPageTranslations.zhHant, valueRows: valueRefRowsTranslations.zhHant, mcpSignIn: mcpSignInTranslations.zhHant, mcpHome: mcpHomeTranslations.zhHant, registries: registriesTranslations.zhHant, skillAdd: skillAddTranslations.zhHant, mcpAdd: mcpAddTranslations.zhHant, agentAdd: agentAddTranslations.zhHant, profileSeeds: profileSeedsTranslations.zhHant, scopeSection: scopeSectionTranslations.zhHant , store: storeTranslations.zhHant },
} as const;
