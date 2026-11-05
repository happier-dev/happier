// MCP servers homepage copy (P7 U7.11, lab hm-A and mp-E): the reach map, its legend, the present line,
// the first visit, the brand-new and empty states. Mounted under `capabilities.mcpHome`.

type Count = Readonly<{ count: number }>;

export type McpHomeTranslation = Readonly<{
  purpose: string;
  loadFailed: string;
  firstHeadline: string;
  firstPurpose: string;
  firstDismiss: string;
  groupAccount: string;
  groupMachine: string;
  newAccountBody: string;
  newMachineBody: string;
  factAs: (params: Readonly<{ identity: string }>) => string;
  factSignedIn: string;
  factKey: string;
  present: (
    params: Readonly<{ servers: number; tools: number; tokens: string }>,
  ) => string;
  presentNoTools: (params: Count) => string;
  presentNone: string;
  needYou: (params: Count) => string;
  needsTitle: string;
  needsAccount: string;
  needsAccountTools: (params: Count) => string;
  needsKey: string;
  needsKeyNamed: (params: Readonly<{ names: string }>) => string;
  previewSignedInAs: (params: Readonly<{ identity: string }>) => string;
  previewSignedIn: string;
  previewKey: string;
  previewMachine: string;
  previewOff: string;
  previewExpired: string;
  previewSignIn: string;
  previewNeedsKey: string;
  newTitle: string;
  newBody: string;
  browse: string;
  paste: string;
  shelfTitle: string;
  shelfFrom: (params: Readonly<{ source: string }>) => string;
  shelfAdd: string;
  foundTitle: string;
  foundBody: string;
  foundLine: (params: Readonly<{ count: number; machine: string }>) => string;
  foundLineMachines: (
    params: Readonly<{ count: number; machines: number }>,
  ) => string;
  foundLineBody: string;
  review: string;
  mapLabel: (params: Count) => string;
  more: (params: Count) => string;
}>;

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

const en: McpHomeTranslation = {
  loadFailed: 'Couldn’t load your servers',
  purpose:
    'Tools your agents can call: your issue tracker, a browser, a database. Sign in once and every machine can use them.',
  firstHeadline: 'Your servers now follow you',
  firstPurpose:
    'They kept working where they were. Now a server that needs a sign-in works too: sign in once, from any device, and every machine can use it.',
  firstDismiss: 'Got it',
  groupAccount: 'Signed in once, on every machine',
  groupMachine: 'Runs on your machines',
  newAccountBody:
    'Linear, Sentry or Notion: sign in from any device, even your phone.',
  newMachineBody:
    'A browser or a database: Happier starts it on the machine your session runs on.',
  factAs: ({ identity }) => `as ${identity}`,
  factSignedIn: 'Signed in',
  factKey: 'API key · saved secret',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'server gives', 'servers give')} your agents ${tools} ${plural(tools, 'tool', 'tools')}, about ${tokens} tokens of context.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'server is', 'servers are')} on for your agents.`,
  presentNone: 'No server is on yet.',
  needYou: ({ count }) => ` ${count} ${plural(count, 'needs', 'need')} you.`,
  needsTitle: 'Needs you',
  needsAccount: 'Fix it once, from any device, and every machine can use it',
  needsAccountTools: ({ count }) =>
    `Fix it once, from any device, and every machine gets its ${count} ${plural(count, 'tool', 'tools')} back`,
  needsKey: 'Add the key once as a saved secret, and every machine can use it',
  needsKeyNamed: ({ names }) => `Add ${names} once as a saved secret, and every machine can use it`,
  previewSignedInAs: ({ identity }) =>
    `Signed in as ${identity}, for every machine`,
  previewSignedIn: 'Signed in once, for every machine',
  previewKey: 'Its key is a saved secret, used on every machine',
  previewMachine: 'Starts on the machine your session runs on',
  previewOff: 'Off: no agent gets it',
  previewExpired:
    'Its sign-in ran out. Reconnect once and every machine has it back.',
  previewSignIn: 'Sign in once, from any device, and every machine can use it.',
  previewNeedsKey:
    'It needs a key. Add it once, as a saved secret, and every machine can start it.',
  newTitle: 'Give your agents more tools',
  newBody:
    'An MCP server gives your agents tools: your issue tracker, a browser, a database. Add one here, sign in once, and it works on every machine.',
  browse: 'Browse servers',
  paste: 'Paste a config',
  shelfTitle: 'Suggested servers',
  shelfFrom: ({ source }) =>
    `From ${source}. Add one and it works on every machine.`,
  shelfAdd: 'Add',
  foundTitle: 'Found on your machines',
  foundBody:
    'Set up inside an agent, not in Happier yet. Add one and it follows you.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'server is', 'servers are')} already on ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'server is', 'servers are')} already on ${machines} machines`,
  foundLineBody:
    'Set up in your agents. Add them and they follow you to every machine.',
  review: 'Review',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'MCP server', 'MCP servers')} around your Home`,
  more: ({ count }) => `+${count}`,
};

const pluralSlavic = (
  count: number,
  one: string,
  few: string,
  many: string,
) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (count === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const pluralRu = (count: number, one: string, few: string, many: string) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const ca: McpHomeTranslation = {
  loadFailed: 'No s’han pogut carregar els teus servidors',
  purpose:
    'Eines que els teus agents poden cridar: el teu gestor d’incidències, un navegador, una base de dades. Inicia la sessió una vegada i totes les màquines les poden fer servir.',
  firstHeadline: 'Ara els teus servidors et segueixen',
  firstPurpose:
    'Han continuat funcionant allà on eren. Ara també funciona un servidor que necessita iniciar la sessió: fes-ho una vegada, des de qualsevol dispositiu, i totes les màquines el poden fer servir.',
  firstDismiss: 'Entesos',
  groupAccount: 'Sessió iniciada una vegada, a totes les màquines',
  groupMachine: 'S’executen a les teves màquines',
  newAccountBody:
    'Linear, Sentry o Notion: inicia la sessió des de qualsevol dispositiu, fins i tot el mòbil.',
  newMachineBody:
    'Un navegador o una base de dades: Happier l’inicia a la màquina on s’executa la teva sessió.',
  factAs: ({ identity }) => `com a ${identity}`,
  factSignedIn: 'Sessió iniciada',
  factKey: 'Clau d’API · secret desat',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'servidor dona', 'servidors donen')} als teus agents ${tools} ${plural(tools, 'eina', 'eines')}, uns ${tokens} tokens de context.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'servidor està activat', 'servidors estan activats')} per als teus agents.`,
  presentNone: 'Encara no hi ha cap servidor activat.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'et necessita', 'et necessiten')}.`,
  needsTitle: 'Et necessita',
  needsAccount: 'Arregla-ho una vegada, des de qualsevol dispositiu, i totes les màquines el podran fer servir',
  needsAccountTools: ({ count }) =>
    `Arregla-ho una vegada, des de qualsevol dispositiu, i totes les màquines recuperen les seves ${count} ${plural(count, 'eina', 'eines')}`,
  needsKey: 'Afegeix la clau una vegada com a secret desat i totes les màquines el podran fer servir',
  needsKeyNamed: ({ names }) => `Afegeix ${names} una vegada com a secret desat i totes les màquines el podran fer servir`,
  previewSignedInAs: ({ identity }) =>
    `Sessió iniciada com a ${identity}, per a totes les màquines`,
  previewSignedIn: 'Sessió iniciada una vegada, per a totes les màquines',
  previewKey: 'La seva clau és un secret desat, que s’usa a totes les màquines',
  previewMachine: 'S’inicia a la màquina on s’executa la teva sessió',
  previewOff: 'Desactivat: cap agent no el rep',
  previewExpired:
    'Ha caducat l’inici de sessió. Reconnecta una vegada i totes les màquines el recuperen.',
  previewSignIn:
    'Inicia la sessió una vegada, des de qualsevol dispositiu, i totes les màquines el poden fer servir.',
  previewNeedsKey:
    'Necessita una clau. Afegeix-la una vegada, com a secret desat, i totes les màquines el poden iniciar.',
  newTitle: 'Dona més eines als teus agents',
  newBody:
    'Un servidor MCP dona eines als teus agents: el teu gestor d’incidències, un navegador, una base de dades. Afegeix-ne un aquí, inicia la sessió una vegada i funciona a totes les màquines.',
  browse: 'Explora els servidors',
  paste: 'Enganxa una configuració',
  shelfTitle: 'Servidors suggerits',
  shelfFrom: ({ source }) =>
    `De ${source}. Afegeix-ne un i funciona a totes les màquines.`,
  shelfAdd: 'Afegeix',
  foundTitle: 'Trobats a les teves màquines',
  foundBody:
    'Configurats dins d’un agent, encara no a Happier. Afegeix-ne un i et segueix.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'servidor ja és', 'servidors ja són')} a ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'servidor ja és', 'servidors ja són')} a ${machines} màquines`,
  foundLineBody:
    'Configurats als teus agents. Afegeix-los i et segueixen a totes les màquines.',
  review: 'Revisa',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'servidor MCP', 'servidors MCP')} al voltant del teu Home`,
  more: ({ count }) => `+${count}`,
};

const de: McpHomeTranslation = {
  loadFailed: 'Deine Server konnten nicht geladen werden',
  purpose:
    'Tools, die deine Agenten aufrufen können: dein Issue-Tracker, ein Browser, eine Datenbank. Einmal anmelden, und jede Maschine kann sie nutzen.',
  firstHeadline: 'Deine Server folgen dir jetzt',
  firstPurpose:
    'Sie liefen dort weiter, wo sie waren. Jetzt funktioniert auch ein Server, der eine Anmeldung braucht: Melde dich einmal an, von jedem Gerät, und jede Maschine kann ihn nutzen.',
  firstDismiss: 'Verstanden',
  groupAccount: 'Einmal angemeldet, auf jeder Maschine',
  groupMachine: 'Läuft auf deinen Maschinen',
  newAccountBody:
    'Linear, Sentry oder Notion: Melde dich von jedem Gerät an, sogar vom Handy.',
  newMachineBody:
    'Ein Browser oder eine Datenbank: Happier startet sie auf der Maschine, auf der deine Sitzung läuft.',
  factAs: ({ identity }) => `als ${identity}`,
  factSignedIn: 'Angemeldet',
  factKey: 'API-Schlüssel · gespeichertes Secret',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'Server gibt', 'Server geben')} deinen Agenten ${tools} ${plural(tools, 'Tool', 'Tools')}, etwa ${tokens} Tokens Kontext.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'Server ist', 'Server sind')} für deine Agenten aktiv.`,
  presentNone: 'Noch ist kein Server aktiv.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'braucht', 'brauchen')} dich.`,
  needsTitle: 'Braucht dich',
  needsAccount: 'Einmal beheben, von jedem Gerät aus, und jede Maschine kann ihn nutzen',
  needsAccountTools: ({ count }) =>
    `Einmal beheben, von jedem Gerät aus, und jede Maschine bekommt ihre ${count} ${plural(count, 'Tool', 'Tools')} zurück`,
  needsKey: 'Füge den Schlüssel einmal als gespeichertes Secret hinzu, und jede Maschine kann ihn nutzen',
  needsKeyNamed: ({ names }) => `Füge ${names} einmal als gespeichertes Secret hinzu, und jede Maschine kann ihn nutzen`,
  previewSignedInAs: ({ identity }) =>
    `Angemeldet als ${identity}, für jede Maschine`,
  previewSignedIn: 'Einmal angemeldet, für jede Maschine',
  previewKey:
    'Sein Schlüssel ist ein gespeichertes Secret und wird auf jeder Maschine genutzt',
  previewMachine: 'Startet auf der Maschine, auf der deine Sitzung läuft',
  previewOff: 'Aus: Kein Agent bekommt ihn',
  previewExpired:
    'Die Anmeldung ist abgelaufen. Verbinde einmal neu, und jede Maschine hat ihn wieder.',
  previewSignIn:
    'Melde dich einmal an, von jedem Gerät, und jede Maschine kann ihn nutzen.',
  previewNeedsKey:
    'Er braucht einen Schlüssel. Füge ihn einmal als gespeichertes Secret hinzu, und jede Maschine kann ihn starten.',
  newTitle: 'Gib deinen Agenten mehr Tools',
  newBody:
    'Ein MCP-Server gibt deinen Agenten Tools: deinen Issue-Tracker, einen Browser, eine Datenbank. Füge hier einen hinzu, melde dich einmal an, und er funktioniert auf jeder Maschine.',
  browse: 'Server durchsuchen',
  paste: 'Konfiguration einfügen',
  shelfTitle: 'Vorgeschlagene Server',
  shelfFrom: ({ source }) =>
    `Von ${source}. Füge einen hinzu, und er funktioniert auf jeder Maschine.`,
  shelfAdd: 'Hinzufügen',
  foundTitle: 'Auf deinen Maschinen gefunden',
  foundBody:
    'In einem Agenten eingerichtet, noch nicht in Happier. Füge einen hinzu, und er folgt dir.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'Server ist', 'Server sind')} bereits auf ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'Server ist', 'Server sind')} bereits auf ${machines} Maschinen`,
  foundLineBody:
    'In deinen Agenten eingerichtet. Füge sie hinzu, und sie folgen dir auf jede Maschine.',
  review: 'Ansehen',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'MCP-Server', 'MCP-Server')} rund um dein Home`,
  more: ({ count }) => `+${count}`,
};

const es: McpHomeTranslation = {
  loadFailed: 'No se pudieron cargar tus servidores',
  purpose:
    'Herramientas que tus agentes pueden llamar: tu gestor de incidencias, un navegador, una base de datos. Inicia sesión una vez y todas las máquinas pueden usarlas.',
  firstHeadline: 'Ahora tus servidores te siguen',
  firstPurpose:
    'Siguieron funcionando donde estaban. Ahora también funciona un servidor que necesita iniciar sesión: hazlo una vez, desde cualquier dispositivo, y todas las máquinas pueden usarlo.',
  firstDismiss: 'Entendido',
  groupAccount: 'Sesión iniciada una vez, en todas las máquinas',
  groupMachine: 'Se ejecutan en tus máquinas',
  newAccountBody:
    'Linear, Sentry o Notion: inicia sesión desde cualquier dispositivo, incluso el móvil.',
  newMachineBody:
    'Un navegador o una base de datos: Happier lo inicia en la máquina donde se ejecuta tu sesión.',
  factAs: ({ identity }) => `como ${identity}`,
  factSignedIn: 'Sesión iniciada',
  factKey: 'Clave de API · secreto guardado',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'servidor da', 'servidores dan')} a tus agentes ${tools} ${plural(tools, 'herramienta', 'herramientas')}, unos ${tokens} tokens de contexto.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'servidor está activado', 'servidores están activados')} para tus agentes.`,
  presentNone: 'Aún no hay ningún servidor activado.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'te necesita', 'te necesitan')}.`,
  needsTitle: 'Te necesita',
  needsAccount: 'Arréglalo una vez, desde cualquier dispositivo, y todas las máquinas podrán usarlo',
  needsAccountTools: ({ count }) =>
    `Arréglalo una vez, desde cualquier dispositivo, y todas las máquinas recuperan sus ${count} ${plural(count, 'herramienta', 'herramientas')}`,
  needsKey: 'Añade la clave una vez como secreto guardado y todas las máquinas podrán usarlo',
  needsKeyNamed: ({ names }) => `Añade ${names} una vez como secreto guardado y todas las máquinas podrán usarlo`,
  previewSignedInAs: ({ identity }) =>
    `Sesión iniciada como ${identity}, para todas las máquinas`,
  previewSignedIn: 'Sesión iniciada una vez, para todas las máquinas',
  previewKey: 'Su clave es un secreto guardado, usado en todas las máquinas',
  previewMachine: 'Se inicia en la máquina donde se ejecuta tu sesión',
  previewOff: 'Desactivado: ningún agente lo recibe',
  previewExpired:
    'Su inicio de sesión caducó. Reconecta una vez y todas las máquinas lo recuperan.',
  previewSignIn:
    'Inicia sesión una vez, desde cualquier dispositivo, y todas las máquinas pueden usarlo.',
  previewNeedsKey:
    'Necesita una clave. Añádela una vez, como secreto guardado, y todas las máquinas pueden iniciarlo.',
  newTitle: 'Dale más herramientas a tus agentes',
  newBody:
    'Un servidor MCP da herramientas a tus agentes: tu gestor de incidencias, un navegador, una base de datos. Añade uno aquí, inicia sesión una vez y funciona en todas las máquinas.',
  browse: 'Explorar servidores',
  paste: 'Pegar una configuración',
  shelfTitle: 'Servidores sugeridos',
  shelfFrom: ({ source }) =>
    `De ${source}. Añade uno y funciona en todas las máquinas.`,
  shelfAdd: 'Añadir',
  foundTitle: 'Encontrados en tus máquinas',
  foundBody:
    'Configurados dentro de un agente, todavía no en Happier. Añade uno y te sigue.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'servidor ya está', 'servidores ya están')} en ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'servidor ya está', 'servidores ya están')} en ${machines} máquinas`,
  foundLineBody:
    'Configurados en tus agentes. Añádelos y te siguen a todas las máquinas.',
  review: 'Revisar',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'servidor MCP', 'servidores MCP')} alrededor de tu Home`,
  more: ({ count }) => `+${count}`,
};

const fr: McpHomeTranslation = {
  loadFailed: 'Impossible de charger vos serveurs',
  purpose:
    'Des outils que vos agents peuvent appeler : votre suivi de tickets, un navigateur, une base de données. Connectez-vous une fois et chaque machine peut les utiliser.',
  firstHeadline: 'Vos serveurs vous suivent désormais',
  firstPurpose:
    'Ils ont continué à fonctionner là où ils étaient. Désormais, un serveur qui demande une connexion fonctionne aussi : connectez-vous une fois, depuis n’importe quel appareil, et chaque machine peut l’utiliser.',
  firstDismiss: 'Compris',
  groupAccount: 'Connecté une fois, sur toutes les machines',
  groupMachine: 'S’exécutent sur vos machines',
  newAccountBody:
    'Linear, Sentry ou Notion : connectez-vous depuis n’importe quel appareil, même votre téléphone.',
  newMachineBody:
    'Un navigateur ou une base de données : Happier le démarre sur la machine où tourne votre session.',
  factAs: ({ identity }) => `en tant que ${identity}`,
  factSignedIn: 'Connecté',
  factKey: 'Clé API · secret enregistré',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'serveur donne', 'serveurs donnent')} à vos agents ${tools} ${plural(tools, 'outil', 'outils')}, environ ${tokens} tokens de contexte.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'serveur est activé', 'serveurs sont activés')} pour vos agents.`,
  presentNone: 'Aucun serveur n’est encore activé.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'a besoin de vous', 'ont besoin de vous')}.`,
  needsTitle: 'A besoin de vous',
  needsAccount: 'Réglez-le une fois, depuis n’importe quel appareil, et chaque machine peut l’utiliser',
  needsAccountTools: ({ count }) =>
    `Réglez-le une fois, depuis n’importe quel appareil, et chaque machine retrouve ses ${count} ${plural(count, 'outil', 'outils')}`,
  needsKey: 'Ajoutez la clé une fois comme secret enregistré, et chaque machine peut l’utiliser',
  needsKeyNamed: ({ names }) => `Ajoutez ${names} une fois comme secret enregistré, et chaque machine peut l’utiliser`,
  previewSignedInAs: ({ identity }) =>
    `Connecté en tant que ${identity}, pour toutes les machines`,
  previewSignedIn: 'Connecté une fois, pour toutes les machines',
  previewKey:
    'Sa clé est un secret enregistré, utilisé sur toutes les machines',
  previewMachine: 'Démarre sur la machine où tourne votre session',
  previewOff: 'Désactivé : aucun agent ne le reçoit',
  previewExpired:
    'Sa connexion a expiré. Reconnectez-le une fois et toutes les machines le retrouvent.',
  previewSignIn:
    'Connectez-vous une fois, depuis n’importe quel appareil, et chaque machine peut l’utiliser.',
  previewNeedsKey:
    'Il a besoin d’une clé. Ajoutez-la une fois, comme secret enregistré, et chaque machine peut le démarrer.',
  newTitle: 'Donnez plus d’outils à vos agents',
  newBody:
    'Un serveur MCP donne des outils à vos agents : votre suivi de tickets, un navigateur, une base de données. Ajoutez-en un ici, connectez-vous une fois, et il fonctionne sur toutes les machines.',
  browse: 'Parcourir les serveurs',
  paste: 'Coller une configuration',
  shelfTitle: 'Serveurs suggérés',
  shelfFrom: ({ source }) =>
    `Depuis ${source}. Ajoutez-en un et il fonctionne sur toutes les machines.`,
  shelfAdd: 'Ajouter',
  foundTitle: 'Trouvés sur vos machines',
  foundBody:
    'Configurés dans un agent, pas encore dans Happier. Ajoutez-en un et il vous suit.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'serveur est déjà', 'serveurs sont déjà')} sur ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'serveur est déjà', 'serveurs sont déjà')} sur ${machines} machines`,
  foundLineBody:
    'Configurés dans vos agents. Ajoutez-les et ils vous suivent sur toutes les machines.',
  review: 'Examiner',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'serveur MCP', 'serveurs MCP')} autour de votre Home`,
  more: ({ count }) => `+${count}`,
};

const it: McpHomeTranslation = {
  loadFailed: 'Impossibile caricare i tuoi server',
  purpose:
    'Strumenti che i tuoi agenti possono chiamare: il tuo issue tracker, un browser, un database. Accedi una volta e ogni macchina può usarli.',
  firstHeadline: 'Ora i tuoi server ti seguono',
  firstPurpose:
    'Hanno continuato a funzionare dov’erano. Ora funziona anche un server che richiede l’accesso: accedi una volta, da qualsiasi dispositivo, e ogni macchina può usarlo.',
  firstDismiss: 'Ho capito',
  groupAccount: 'Accesso fatto una volta, su ogni macchina',
  groupMachine: 'Girano sulle tue macchine',
  newAccountBody:
    'Linear, Sentry o Notion: accedi da qualsiasi dispositivo, anche dal telefono.',
  newMachineBody:
    'Un browser o un database: Happier lo avvia sulla macchina dove gira la tua sessione.',
  factAs: ({ identity }) => `come ${identity}`,
  factSignedIn: 'Accesso effettuato',
  factKey: 'Chiave API · segreto salvato',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'server dà', 'server danno')} ai tuoi agenti ${tools} ${plural(tools, 'strumento', 'strumenti')}, circa ${tokens} token di contesto.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'server è attivo', 'server sono attivi')} per i tuoi agenti.`,
  presentNone: 'Nessun server è ancora attivo.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'ha bisogno di te', 'hanno bisogno di te')}.`,
  needsTitle: 'Ha bisogno di te',
  needsAccount: 'Sistemalo una volta, da qualsiasi dispositivo, e ogni macchina potrà usarlo',
  needsAccountTools: ({ count }) =>
    `Sistemalo una volta, da qualsiasi dispositivo, e ogni macchina riavrà i suoi ${count} ${plural(count, 'strumento', 'strumenti')}`,
  needsKey: 'Aggiungi la chiave una volta come segreto salvato e ogni macchina potrà usarlo',
  needsKeyNamed: ({ names }) => `Aggiungi ${names} una volta come segreto salvato e ogni macchina potrà usarlo`,
  previewSignedInAs: ({ identity }) =>
    `Accesso come ${identity}, per ogni macchina`,
  previewSignedIn: 'Accesso fatto una volta, per ogni macchina',
  previewKey: 'La sua chiave è un segreto salvato, usato su ogni macchina',
  previewMachine: 'Si avvia sulla macchina dove gira la tua sessione',
  previewOff: 'Disattivato: nessun agente lo riceve',
  previewExpired:
    'Il suo accesso è scaduto. Riconnettilo una volta e ogni macchina lo riavrà.',
  previewSignIn:
    'Accedi una volta, da qualsiasi dispositivo, e ogni macchina può usarlo.',
  previewNeedsKey:
    'Serve una chiave. Aggiungila una volta, come segreto salvato, e ogni macchina può avviarlo.',
  newTitle: 'Dai più strumenti ai tuoi agenti',
  newBody:
    'Un server MCP dà strumenti ai tuoi agenti: il tuo issue tracker, un browser, un database. Aggiungine uno qui, accedi una volta e funziona su ogni macchina.',
  browse: 'Sfoglia i server',
  paste: 'Incolla una configurazione',
  shelfTitle: 'Server suggeriti',
  shelfFrom: ({ source }) =>
    `Da ${source}. Aggiungine uno e funziona su ogni macchina.`,
  shelfAdd: 'Aggiungi',
  foundTitle: 'Trovati sulle tue macchine',
  foundBody:
    'Configurati dentro un agente, non ancora in Happier. Aggiungine uno e ti segue.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'server è già', 'server sono già')} su ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'server è già', 'server sono già')} su ${machines} macchine`,
  foundLineBody:
    'Configurati nei tuoi agenti. Aggiungili e ti seguono su ogni macchina.',
  review: 'Rivedi',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'server MCP', 'server MCP')} intorno alla tua Home`,
  more: ({ count }) => `+${count}`,
};

const ja: McpHomeTranslation = {
  loadFailed: 'サーバーを読み込めませんでした',
  purpose:
    'エージェントが呼び出せるツール: Issue トラッカー、ブラウザ、データベースなど。一度サインインすれば、すべてのマシンで使えます。',
  firstHeadline: 'サーバーがあなたについてくるようになりました',
  firstPurpose:
    'これまでどおり、元の場所で動き続けます。さらに、サインインが必要なサーバーも使えるようになりました。どのデバイスからでも一度サインインすれば、すべてのマシンで使えます。',
  firstDismiss: 'わかりました',
  groupAccount: '一度のサインインで、すべてのマシンに',
  groupMachine: 'あなたのマシンで動作',
  newAccountBody:
    'Linear、Sentry、Notion など: どのデバイスからでも、スマートフォンからでもサインインできます。',
  newMachineBody:
    'ブラウザやデータベースなど: セッションが動いているマシンで Happier が起動します。',
  factAs: ({ identity }) => `${identity} として`,
  factSignedIn: 'サインイン済み',
  factKey: 'API キー・保存したシークレット',
  present: ({ servers, tools, tokens }) =>
    `${servers} 台のサーバーがエージェントに ${tools} 個のツールを提供しています。コンテキストは約 ${tokens} トークンです。`,
  presentNoTools: ({ count }) =>
    `${count} 台のサーバーがエージェント向けにオンです。`,
  presentNone: 'オンのサーバーはまだありません。',
  needYou: ({ count }) => ` ${count} 台は対応が必要です。`,
  needsTitle: '対応が必要',
  needsAccount: 'どのデバイスからでも一度直せば、すべてのマシンで使えます',
  needsAccountTools: ({ count }) =>
    `どのデバイスからでも一度直せば、すべてのマシンで ${count} 個のツールが戻ります`,
  needsKey: 'キーを保存したシークレットとして一度追加すれば、すべてのマシンで使えます',
  needsKeyNamed: ({ names }) => `${names} を保存したシークレットとして一度追加すれば、すべてのマシンで使えます`,
  previewSignedInAs: ({ identity }) =>
    `${identity} としてサインイン済み、すべてのマシンで利用可`,
  previewSignedIn: '一度のサインインで、すべてのマシンで利用可',
  previewKey: 'キーは保存したシークレットで、すべてのマシンで使われます',
  previewMachine: 'セッションが動いているマシンで起動します',
  previewOff: 'オフ: どのエージェントにも渡りません',
  previewExpired:
    'サインインの有効期限が切れました。一度再接続すれば、すべてのマシンで元どおり使えます。',
  previewSignIn:
    'どのデバイスからでも一度サインインすれば、すべてのマシンで使えます。',
  previewNeedsKey:
    'キーが必要です。保存したシークレットとして一度追加すれば、すべてのマシンで起動できます。',
  newTitle: 'エージェントにもっとツールを',
  newBody:
    'MCP サーバーはエージェントにツールを渡します。Issue トラッカー、ブラウザ、データベースなど。ここで追加して一度サインインすれば、すべてのマシンで使えます。',
  browse: 'サーバーを探す',
  paste: '設定を貼り付け',
  shelfTitle: 'おすすめのサーバー',
  shelfFrom: ({ source }) =>
    `${source} から。追加すれば、すべてのマシンで使えます。`,
  shelfAdd: '追加',
  foundTitle: 'マシンで見つかりました',
  foundBody:
    'エージェント内で設定済みで、Happier にはまだありません。追加すると、あなたについてきます。',
  foundLine: ({ count, machine }) =>
    `${count} 台のサーバーがすでに ${machine} にあります`,
  foundLineMachines: ({ count, machines }) =>
    `${count} 台のサーバーがすでに ${machines} 台のマシンにあります`,
  foundLineBody:
    'エージェントで設定済みです。追加すれば、すべてのマシンについてきます。',
  review: '確認',
  mapLabel: ({ count }) => `Home の周りに MCP サーバー ${count} 台`,
  more: ({ count }) => `+${count}`,
};

const pl: McpHomeTranslation = {
  loadFailed: 'Nie udało się wczytać Twoich serwerów',
  purpose:
    'Narzędzia, które mogą wywoływać Twoi agenci: Twój system zgłoszeń, przeglądarka, baza danych. Zaloguj się raz, a każda maszyna będzie mogła z nich korzystać.',
  firstHeadline: 'Twoje serwery podążają teraz za Tobą',
  firstPurpose:
    'Działały dalej tam, gdzie były. Teraz działa też serwer, który wymaga logowania: zaloguj się raz, z dowolnego urządzenia, a każda maszyna będzie mogła z niego korzystać.',
  firstDismiss: 'Jasne',
  groupAccount: 'Zalogowano raz, na każdej maszynie',
  groupMachine: 'Działają na Twoich maszynach',
  newAccountBody:
    'Linear, Sentry lub Notion: zaloguj się z dowolnego urządzenia, nawet z telefonu.',
  newMachineBody:
    'Przeglądarka lub baza danych: Happier uruchamia ją na maszynie, na której działa Twoja sesja.',
  factAs: ({ identity }) => `jako ${identity}`,
  factSignedIn: 'Zalogowano',
  factKey: 'Klucz API · zapisany sekret',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${pluralSlavic(servers, 'serwer daje', 'serwery dają', 'serwerów daje')} Twoim agentom ${tools} ${pluralSlavic(tools, 'narzędzie', 'narzędzia', 'narzędzi')}, około ${tokens} tokenów kontekstu.`,
  presentNoTools: ({ count }) =>
    `${count} ${pluralSlavic(count, 'serwer jest włączony', 'serwery są włączone', 'serwerów jest włączonych')} dla Twoich agentów.`,
  presentNone: 'Żaden serwer nie jest jeszcze włączony.',
  needYou: ({ count }) =>
    ` ${count} ${pluralSlavic(count, 'potrzebuje', 'potrzebują', 'potrzebuje')} Ciebie.`,
  needsTitle: 'Potrzebuje Ciebie',
  needsAccount: 'Napraw to raz, z dowolnego urządzenia, a każda maszyna będzie mogła go używać',
  needsAccountTools: ({ count }) =>
    `Napraw to raz, z dowolnego urządzenia, a każda maszyna odzyska ${count} ${pluralSlavic(count, 'narzędzie', 'narzędzia', 'narzędzi')}`,
  needsKey: 'Dodaj klucz raz jako zapisany sekret, a każda maszyna będzie mogła go używać',
  needsKeyNamed: ({ names }) => `Dodaj ${names} raz jako zapisany sekret, a każda maszyna będzie mogła go używać`,
  previewSignedInAs: ({ identity }) =>
    `Zalogowano jako ${identity}, dla każdej maszyny`,
  previewSignedIn: 'Zalogowano raz, dla każdej maszyny',
  previewKey: 'Jego klucz to zapisany sekret, używany na każdej maszynie',
  previewMachine: 'Uruchamia się na maszynie, na której działa Twoja sesja',
  previewOff: 'Wyłączony: żaden agent go nie dostaje',
  previewExpired:
    'Logowanie wygasło. Połącz ponownie raz, a każda maszyna znów go ma.',
  previewSignIn:
    'Zaloguj się raz, z dowolnego urządzenia, a każda maszyna będzie mogła z niego korzystać.',
  previewNeedsKey:
    'Potrzebuje klucza. Dodaj go raz, jako zapisany sekret, a każda maszyna będzie mogła go uruchomić.',
  newTitle: 'Daj swoim agentom więcej narzędzi',
  newBody:
    'Serwer MCP daje Twoim agentom narzędzia: system zgłoszeń, przeglądarkę, bazę danych. Dodaj go tutaj, zaloguj się raz, a będzie działać na każdej maszynie.',
  browse: 'Przeglądaj serwery',
  paste: 'Wklej konfigurację',
  shelfTitle: 'Proponowane serwery',
  shelfFrom: ({ source }) =>
    `Z ${source}. Dodaj serwer, a będzie działać na każdej maszynie.`,
  shelfAdd: 'Dodaj',
  foundTitle: 'Znaleziono na Twoich maszynach',
  foundBody:
    'Skonfigurowane w agencie, jeszcze nie w Happier. Dodaj serwer, a podąży za Tobą.',
  foundLine: ({ count, machine }) =>
    `${count} ${pluralSlavic(count, 'serwer jest już', 'serwery są już', 'serwerów jest już')} na ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${pluralSlavic(count, 'serwer jest już', 'serwery są już', 'serwerów jest już')} na ${machines} ${pluralSlavic(machines, 'maszynie', 'maszynach', 'maszynach')}`,
  foundLineBody:
    'Skonfigurowane w Twoich agentach. Dodaj je, a podążą za Tobą na każdą maszynę.',
  review: 'Przejrzyj',
  mapLabel: ({ count }) =>
    `${count} ${pluralSlavic(count, 'serwer MCP', 'serwery MCP', 'serwerów MCP')} wokół Twojego Home`,
  more: ({ count }) => `+${count}`,
};

const pt: McpHomeTranslation = {
  loadFailed: 'Não foi possível carregar seus servidores',
  purpose:
    'Ferramentas que seus agentes podem chamar: seu rastreador de issues, um navegador, um banco de dados. Entre uma vez e todas as máquinas podem usá-las.',
  firstHeadline: 'Seus servidores agora seguem você',
  firstPurpose:
    'Eles continuaram funcionando onde estavam. Agora um servidor que precisa de login também funciona: entre uma vez, de qualquer dispositivo, e todas as máquinas podem usá-lo.',
  firstDismiss: 'Entendi',
  groupAccount: 'Login feito uma vez, em todas as máquinas',
  groupMachine: 'Rodam nas suas máquinas',
  newAccountBody:
    'Linear, Sentry ou Notion: entre de qualquer dispositivo, até do celular.',
  newMachineBody:
    'Um navegador ou um banco de dados: o Happier o inicia na máquina em que sua sessão roda.',
  factAs: ({ identity }) => `como ${identity}`,
  factSignedIn: 'Conectado',
  factKey: 'Chave de API · segredo salvo',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'servidor dá', 'servidores dão')} aos seus agentes ${tools} ${plural(tools, 'ferramenta', 'ferramentas')}, cerca de ${tokens} tokens de contexto.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'servidor está ativado', 'servidores estão ativados')} para seus agentes.`,
  presentNone: 'Nenhum servidor está ativado ainda.',
  needYou: ({ count }) =>
    ` ${count} ${plural(count, 'precisa de você', 'precisam de você')}.`,
  needsTitle: 'Precisa de você',
  needsAccount: 'Resolva uma vez, de qualquer dispositivo, e todas as máquinas podem usá-lo',
  needsAccountTools: ({ count }) =>
    `Resolva uma vez, de qualquer dispositivo, e todas as máquinas recuperam suas ${count} ${plural(count, 'ferramenta', 'ferramentas')}`,
  needsKey: 'Adicione a chave uma vez como segredo salvo, e todas as máquinas podem usá-lo',
  needsKeyNamed: ({ names }) => `Adicione ${names} uma vez como segredo salvo, e todas as máquinas podem usá-lo`,
  previewSignedInAs: ({ identity }) =>
    `Conectado como ${identity}, para todas as máquinas`,
  previewSignedIn: 'Login feito uma vez, para todas as máquinas',
  previewKey: 'A chave dele é um segredo salvo, usado em todas as máquinas',
  previewMachine: 'Inicia na máquina em que sua sessão roda',
  previewOff: 'Desativado: nenhum agente o recebe',
  previewExpired:
    'O login expirou. Reconecte uma vez e todas as máquinas o recuperam.',
  previewSignIn:
    'Entre uma vez, de qualquer dispositivo, e todas as máquinas podem usá-lo.',
  previewNeedsKey:
    'Ele precisa de uma chave. Adicione-a uma vez, como segredo salvo, e todas as máquinas podem iniciá-lo.',
  newTitle: 'Dê mais ferramentas aos seus agentes',
  newBody:
    'Um servidor MCP dá ferramentas aos seus agentes: seu rastreador de issues, um navegador, um banco de dados. Adicione um aqui, entre uma vez e ele funciona em todas as máquinas.',
  browse: 'Explorar servidores',
  paste: 'Colar uma configuração',
  shelfTitle: 'Servidores sugeridos',
  shelfFrom: ({ source }) =>
    `De ${source}. Adicione um e ele funciona em todas as máquinas.`,
  shelfAdd: 'Adicionar',
  foundTitle: 'Encontrados nas suas máquinas',
  foundBody:
    'Configurados dentro de um agente, ainda não no Happier. Adicione um e ele segue você.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'servidor já está', 'servidores já estão')} em ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'servidor já está', 'servidores já estão')} em ${machines} máquinas`,
  foundLineBody:
    'Configurados nos seus agentes. Adicione-os e eles seguem você para todas as máquinas.',
  review: 'Revisar',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'servidor MCP', 'servidores MCP')} ao redor da sua Home`,
  more: ({ count }) => `+${count}`,
};

const ru: McpHomeTranslation = {
  loadFailed: 'Не удалось загрузить ваши серверы',
  purpose:
    'Инструменты, которые могут вызывать ваши агенты: трекер задач, браузер, база данных. Войдите один раз, и каждая машина сможет ими пользоваться.',
  firstHeadline: 'Теперь ваши серверы следуют за вами',
  firstPurpose:
    'Они продолжили работать там, где были. Теперь работает и сервер, которому нужен вход: войдите один раз, с любого устройства, и каждая машина сможет им пользоваться.',
  firstDismiss: 'Понятно',
  groupAccount: 'Вход выполнен один раз, на всех машинах',
  groupMachine: 'Работают на ваших машинах',
  newAccountBody:
    'Linear, Sentry или Notion: войдите с любого устройства, даже с телефона.',
  newMachineBody:
    'Браузер или база данных: Happier запускает их на машине, где идёт ваша сессия.',
  factAs: ({ identity }) => `как ${identity}`,
  factSignedIn: 'Вход выполнен',
  factKey: 'API-ключ · сохранённый секрет',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${pluralRu(servers, 'сервер даёт', 'сервера дают', 'серверов дают')} вашим агентам ${tools} ${pluralRu(tools, 'инструмент', 'инструмента', 'инструментов')}, около ${tokens} токенов контекста.`,
  presentNoTools: ({ count }) =>
    `${count} ${pluralRu(count, 'сервер включён', 'сервера включены', 'серверов включено')} для ваших агентов.`,
  presentNone: 'Ни один сервер пока не включён.',
  needYou: ({ count }) =>
    ` ${count} ${pluralRu(count, 'ждёт', 'ждут', 'ждут')} вас.`,
  needsTitle: 'Ждут вас',
  needsAccount: 'Исправьте один раз с любого устройства, и каждая машина сможет им пользоваться',
  needsAccountTools: ({ count }) =>
    `Исправьте один раз с любого устройства, и каждая машина вернёт свои ${count} ${pluralRu(count, 'инструмент', 'инструмента', 'инструментов')}`,
  needsKey: 'Добавьте ключ один раз как сохранённый секрет, и каждая машина сможет им пользоваться',
  needsKeyNamed: ({ names }) => `Добавьте ${names} один раз как сохранённый секрет, и каждая машина сможет им пользоваться`,
  previewSignedInAs: ({ identity }) =>
    `Вход выполнен как ${identity}, для всех машин`,
  previewSignedIn: 'Вход выполнен один раз, для всех машин',
  previewKey: 'Его ключ — сохранённый секрет, он используется на всех машинах',
  previewMachine: 'Запускается на машине, где идёт ваша сессия',
  previewOff: 'Выключен: ни один агент его не получает',
  previewExpired:
    'Срок входа истёк. Подключите заново один раз, и он снова будет на всех машинах.',
  previewSignIn:
    'Войдите один раз, с любого устройства, и каждая машина сможет им пользоваться.',
  previewNeedsKey:
    'Ему нужен ключ. Добавьте его один раз как сохранённый секрет, и каждая машина сможет его запустить.',
  newTitle: 'Дайте агентам больше инструментов',
  newBody:
    'MCP-сервер даёт вашим агентам инструменты: трекер задач, браузер, базу данных. Добавьте его здесь, войдите один раз, и он заработает на всех машинах.',
  browse: 'Обзор серверов',
  paste: 'Вставить конфигурацию',
  shelfTitle: 'Рекомендуемые серверы',
  shelfFrom: ({ source }) =>
    `Из ${source}. Добавьте сервер, и он заработает на всех машинах.`,
  shelfAdd: 'Добавить',
  foundTitle: 'Найдено на ваших машинах',
  foundBody:
    'Настроены внутри агента, в Happier их ещё нет. Добавьте сервер, и он последует за вами.',
  foundLine: ({ count, machine }) =>
    `${count} ${pluralRu(count, 'сервер уже на', 'сервера уже на', 'серверов уже на')} ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${pluralRu(count, 'сервер уже на', 'сервера уже на', 'серверов уже на')} ${machines} ${pluralRu(machines, 'машине', 'машинах', 'машинах')}`,
  foundLineBody:
    'Настроены в ваших агентах. Добавьте их, и они последуют за вами на все машины.',
  review: 'Посмотреть',
  mapLabel: ({ count }) =>
    `${count} ${pluralRu(count, 'MCP-сервер', 'MCP-сервера', 'MCP-серверов')} вокруг вашего Home`,
  more: ({ count }) => `+${count}`,
};

const zhHans: McpHomeTranslation = {
  loadFailed: '无法加载你的服务器',
  purpose:
    '你的智能体可以调用的工具：问题跟踪器、浏览器、数据库。登录一次，每台机器都能使用。',
  firstHeadline: '你的服务器现在会跟着你',
  firstPurpose:
    '它们仍在原来的地方正常运行。现在，需要登录的服务器也能用了：在任意设备上登录一次，每台机器都能使用。',
  firstDismiss: '知道了',
  groupAccount: '登录一次，所有机器通用',
  groupMachine: '在你的机器上运行',
  newAccountBody: 'Linear、Sentry 或 Notion：在任意设备上登录，手机也可以。',
  newMachineBody: '浏览器或数据库：Happier 会在你的会话所在的机器上启动它。',
  factAs: ({ identity }) => `以 ${identity} 身份`,
  factSignedIn: '已登录',
  factKey: 'API 密钥 · 已保存的机密',
  present: ({ servers, tools, tokens }) =>
    `${servers} 个服务器为你的智能体提供 ${tools} 个工具，约占 ${tokens} 个上下文 token。`,
  presentNoTools: ({ count }) => `已为你的智能体开启 ${count} 个服务器。`,
  presentNone: '还没有开启任何服务器。',
  needYou: ({ count }) => ` ${count} 个需要你处理。`,
  needsTitle: '需要你处理',
  needsAccount: '从任意设备修复一次，每台机器都能使用',
  needsAccountTools: ({ count }) => `从任意设备修复一次，每台机器都会找回 ${count} 个工具`,
  needsKey: '把密钥作为已保存的机密添加一次，每台机器都能使用',
  needsKeyNamed: ({ names }) => `把 ${names} 作为已保存的机密添加一次，每台机器都能使用`,
  previewSignedInAs: ({ identity }) =>
    `已以 ${identity} 身份登录，所有机器通用`,
  previewSignedIn: '登录一次，所有机器通用',
  previewKey: '它的密钥是已保存的机密，在每台机器上使用',
  previewMachine: '在你的会话所在的机器上启动',
  previewOff: '已关闭：没有智能体会获得它',
  previewExpired: '登录已过期。重新连接一次，每台机器就能恢复使用。',
  previewSignIn: '在任意设备上登录一次，每台机器都能使用。',
  previewNeedsKey:
    '它需要一个密钥。将其作为已保存的机密添加一次，每台机器都能启动它。',
  newTitle: '为你的智能体添加更多工具',
  newBody:
    'MCP 服务器能为你的智能体提供工具：问题跟踪器、浏览器、数据库。在这里添加一个，登录一次，每台机器都能用。',
  browse: '浏览服务器',
  paste: '粘贴配置',
  shelfTitle: '推荐的服务器',
  shelfFrom: ({ source }) => `来自 ${source}。添加后，每台机器都能用。`,
  shelfAdd: '添加',
  foundTitle: '在你的机器上发现',
  foundBody: '在智能体中配置，尚未加入 Happier。添加后，它会跟着你。',
  foundLine: ({ count, machine }) => `${machine} 上已有 ${count} 个服务器`,
  foundLineMachines: ({ count, machines }) =>
    `${machines} 台机器上已有 ${count} 个服务器`,
  foundLineBody: '在你的智能体中配置。添加后，它们会跟着你到每台机器。',
  review: '查看',
  mapLabel: ({ count }) => `Home 周围有 ${count} 个 MCP 服务器`,
  more: ({ count }) => `+${count}`,
};

const zhHant: McpHomeTranslation = {
  loadFailed: '無法載入你的伺服器',
  purpose:
    '你的代理可以呼叫的工具：問題追蹤器、瀏覽器、資料庫。登入一次，每台機器都能使用。',
  firstHeadline: '你的伺服器現在會跟著你',
  firstPurpose:
    '它們仍在原來的地方正常運作。現在，需要登入的伺服器也能用了：在任何裝置上登入一次，每台機器都能使用。',
  firstDismiss: '知道了',
  groupAccount: '登入一次，所有機器通用',
  groupMachine: '在你的機器上執行',
  newAccountBody: 'Linear、Sentry 或 Notion：在任何裝置上登入，手機也可以。',
  newMachineBody: '瀏覽器或資料庫：Happier 會在你的工作階段所在的機器上啟動它。',
  factAs: ({ identity }) => `以 ${identity} 身分`,
  factSignedIn: '已登入',
  factKey: 'API 金鑰 · 已儲存的機密',
  present: ({ servers, tools, tokens }) =>
    `${servers} 個伺服器為你的代理提供 ${tools} 個工具，約佔 ${tokens} 個上下文 token。`,
  presentNoTools: ({ count }) => `已為你的代理開啟 ${count} 個伺服器。`,
  presentNone: '還沒有開啟任何伺服器。',
  needYou: ({ count }) => ` ${count} 個需要你處理。`,
  needsTitle: '需要你處理',
  needsAccount: '從任何裝置修復一次，每台機器都能使用',
  needsAccountTools: ({ count }) => `從任何裝置修復一次，每台機器都會找回 ${count} 個工具`,
  needsKey: '把金鑰作為已儲存的機密新增一次，每台機器都能使用',
  needsKeyNamed: ({ names }) => `把 ${names} 作為已儲存的機密新增一次，每台機器都能使用`,
  previewSignedInAs: ({ identity }) =>
    `已以 ${identity} 身分登入，所有機器通用`,
  previewSignedIn: '登入一次，所有機器通用',
  previewKey: '它的金鑰是已儲存的機密，在每台機器上使用',
  previewMachine: '在你的工作階段所在的機器上啟動',
  previewOff: '已關閉：沒有代理會取得它',
  previewExpired: '登入已過期。重新連線一次，每台機器就能恢復使用。',
  previewSignIn: '在任何裝置上登入一次，每台機器都能使用。',
  previewNeedsKey:
    '它需要一個金鑰。將其作為已儲存的機密新增一次，每台機器都能啟動它。',
  newTitle: '為你的代理加入更多工具',
  newBody:
    'MCP 伺服器能為你的代理提供工具：問題追蹤器、瀏覽器、資料庫。在這裡新增一個，登入一次，每台機器都能用。',
  browse: '瀏覽伺服器',
  paste: '貼上設定',
  shelfTitle: '推薦的伺服器',
  shelfFrom: ({ source }) => `來自 ${source}。新增後，每台機器都能用。`,
  shelfAdd: '新增',
  foundTitle: '在你的機器上發現',
  foundBody: '在代理中設定，尚未加入 Happier。新增後，它會跟著你。',
  foundLine: ({ count, machine }) => `${machine} 上已有 ${count} 個伺服器`,
  foundLineMachines: ({ count, machines }) =>
    `${machines} 台機器上已有 ${count} 個伺服器`,
  foundLineBody: '在你的代理中設定。新增後，它們會跟著你到每台機器。',
  review: '檢視',
  mapLabel: ({ count }) => `Home 周圍有 ${count} 個 MCP 伺服器`,
  more: ({ count }) => `+${count}`,
};

export const mcpHomeTranslations = {
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
} as const satisfies Record<string, McpHomeTranslation>;
