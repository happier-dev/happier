// Skills page family copy (P6): the rail, the homepage and its moments. Mounted under `capabilities.skills`.

type Count = Readonly<{ count: number }>;

export type SkillsPageTranslation = Readonly<{
  title: string;
  pageDescription: string;
  searchPlaceholder: string;
  addSkill: string;
  allSkills: string;
  needLook: (params: Count) => string;
  inUse: string;
  off: string;
  updates: string;
  noOwnSkills: string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  loadFailed: string;
  saved: Readonly<{
    saved: string;
    notAttached: string;
    attachAgain: string;
    liveNow: string;
    loadsAfterTurn: string;
    restartNow: string;
    needsRestart: string;
    view: string;
    liveNowDetail: (params: Readonly<{ name: string }>) => string;
    loadsAfterTurnDetail: string;
    restartDetail: string;
    restartTerminalDetail: string;
    notAttachedDetail: string;
    onlyUses: (params: Readonly<{ name: string }>) => string;
  }>;
  maker: Readonly<{
    title: string;
    anyone: string;
    you: string;
    anyBot: string;
    registries: string;
    session: string;
    person: string;
    unknown: string;
    openSession: string;
    createdHere: string;
  }>;
  pane: Readonly<{ thisBot: string; yours: string; registries: string; other: string; allSkills: string }>;
  home: Readonly<{
    reach: (
      params: Readonly<{ count: number; agents: string; machines: number }>,
    ) => string;
    reachNeedLook: (params: Count) => string;
    reachNone: string;
    reachWaiting: (params: Count) => string;
    unsupported: (params: Readonly<{ count: number; agents: string }>) => string;
    unsupportedNote: (params: Readonly<{ agents: string }>) => string;
    noMachines: string;
    catchesUp: (params: Readonly<{ machines: string }>) => string;
    catchUpCount: (params: Readonly<{ count: number }>) => string;
    mapLabel: (
      params: Readonly<{ skills: number; machines: number }>,
    ) => string;
    offlineLastKnown: (params: Readonly<{ time: string }>) => string;
    offline: string;
    noAgents: string;
    noSkillAgents: string;
    moreMachines: (params: Readonly<{ count: number }>) => string;
    needsLook: string;
    updateWaiting: string;
    modifiedUpstream: string;
    removedFromSource: string;
    maskedOn: (params: Readonly<{ machine: string }>) => string;
    unreadable: string;
    byId: (params: Readonly<{ id: string }>) => string;
    writeOwn: string;
    review: string;
    decide: string;
    whereTitle: string;
    whereBody: string;
    firstHeadline: string;
    firstPurpose: string;
    firstSentence: (params: Readonly<{ on: number; off: number }>) => string;
    choose: string;
    chooseOff: (params: Count) => string;
    nothingElse: string;
    emptyTitle: string;
    emptyBody: string;
    emptySentence: string;
  }>;
}>;

const en: SkillsPageTranslation = {
  pane: { thisBot: "Made by this Bot", yours: "Yours", registries: "From your registries", other: "Other skills", allSkills: "All your skills" },
  saved: {
    saved: "Saved to your skills",
    notAttached: "Not attached here",
    attachAgain: "Attach again",
    liveNow: "Live now",
    loadsAfterTurn: "Loads after this turn",
    restartNow: "Restart now",
    needsRestart: "Needs a restart to load",
    view: "View",
    liveNowDetail: ({ name }) => name + " uses it from its next message.",
    loadsAfterTurnDetail: "It joins between turns. The conversation is kept.",
    restartDetail: "Restarting keeps the conversation.",
    restartTerminalDetail: "Restart it from its terminal. The conversation is kept.",
    notAttachedDetail: "It’s in your skills; this session didn’t take it.",
    onlyUses: ({ name }) => "only " + name + " uses it",
  },
  maker: {
    title: "Made by",
    anyone: "Anyone",
    you: "You",
    anyBot: "Any Bot",
    registries: "From registries",
    session: "Session",
    person: "Another person",
    unknown: "Unknown maker",
    openSession: "Open session",
    createdHere: "Created in Happier",
  },
  title: 'Skills',
  pageDescription:
    'Instructions your agents pick up when a task needs them. Add a skill once and it reaches every machine.',
  searchPlaceholder: 'Search skills',
  addSkill: 'Add a skill',
  allSkills: 'All skills',
  needLook: ({ count }) =>
    count === 1 ? '1 needs a look' : `${count} need a look`,
  inUse: 'In use',
  off: 'Off',
  updates: 'Updates',
  noOwnSkills: 'No skills of your own yet',
  noMatch: ({ query }) => `No skills match “${query}”`,
  loadFailed: 'Couldn’t load your skills',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'skill reaches' : 'skills reach'} ${agents} on ${machines} ${machines === 1 ? 'machine' : 'machines'}`,
    reachNeedLook: ({ count }) =>
      `, and ${count} ${count === 1 ? 'needs' : 'need'} a look`,
    reachNone: 'None of your skills is on anywhere yet',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'skill is' : 'skills are'} on. ${count === 1 ? 'It reaches' : 'They reach'} your agents once a machine says which ones it has.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'skill is' : 'skills are'} on, but ${agents} can’t use skills.`,
    unsupportedNote: ({ agents }) => `${agents} can’t use skills.`,
    noMachines: 'Your skills reach the first machine you connect.',
    catchesUp: ({ machines }) => `${machines} catches up when it’s back.`,
    catchUpCount: ({ count }) => `${count} offline machines catch up when they’re back.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} skills across ${machines} machines`,
    offlineLastKnown: ({ time }) => `Offline · last known ${time}`,
    offline: 'Offline',
    noAgents: 'No agents yet',
    noSkillAgents: 'No agent here uses skills',
    moreMachines: ({ count }) => `${count} more machines`,
    needsLook: 'Needs a look',
    updateWaiting: 'A newer version is waiting where it came from.',
    modifiedUpstream: 'You changed it, and the source changed too.',
    removedFromSource: 'Its source no longer has it. Keep your copy, or remove it.',
    maskedOn: ({ machine }) => `${machine}'s own copy wins there.`,
    unreadable: "Couldn't read this skill.",
    byId: ({ id }) => `Skill ${id}`,
    writeOwn: 'Write your own',
    review: 'Review',
    decide: 'Choose',
    whereTitle: 'Where it’s on',
    whereBody:
      'A new skill is on everywhere. Narrow it to a project or a machine, or keep it from one agent; the most specific rule wins, and any session can still add or drop one.',
    firstHeadline: 'Your skills now reach every machine',
    firstPurpose:
      'A skill is a folder of instructions, sometimes with scripts, that an agent picks up when a task needs it. Yours now follow you to every machine.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'skill is' : 'skills are'} on where you already used ${on === 1 ? 'it' : 'them'}. ` : ''}${off} wait under your Home until you choose.`,
    choose: 'Choose what’s on',
    chooseOff: ({ count }) => `${count} off`,
    nothingElse: 'Nothing else changes until you choose.',
    emptyTitle: 'Teach your agents once',
    emptyBody:
      'A skill is a folder of instructions an agent picks up when a task needs it. Add one here and every agent on every machine gets it.',
    emptySentence:
      'Machines circle your Home. A skill you add rides to every one of them, for every agent on it.',
  },
};

const de: SkillsPageTranslation = {
  pane: { thisBot: "Von diesem Bot erstellt", yours: "Deine", registries: "Aus deinen Registries", other: "Andere Skills", allSkills: "Alle deine Skills" },
  saved: {
    saved: "In deinen Skills gespeichert",
    notAttached: "Hier nicht angehängt",
    attachAgain: "Erneut anhängen",
    liveNow: "Jetzt aktiv",
    loadsAfterTurn: "Wird nach diesem Zug geladen",
    restartNow: "Jetzt neu starten",
    needsRestart: "Braucht einen Neustart",
    view: "Ansehen",
    liveNowDetail: ({ name }) => name + " nutzt ihn ab der nächsten Nachricht.",
    loadsAfterTurnDetail: "Er kommt zwischen zwei Zügen dazu. Das Gespräch bleibt erhalten.",
    restartDetail: "Ein Neustart behält das Gespräch.",
    restartTerminalDetail: "Starte sie im Terminal neu. Das Gespräch bleibt erhalten.",
    notAttachedDetail: "Er ist in deinen Skills; diese Sitzung hat ihn nicht übernommen.",
    onlyUses: ({ name }) => "nur " + name + " nutzt ihn",
  },
  maker: {
    title: "Erstellt von",
    anyone: "Allen",
    you: "Dir",
    anyBot: "Jedem Bot",
    registries: "Aus Registries",
    session: "Sitzung",
    person: "Eine andere Person",
    unknown: "Unbekannter Ersteller",
    openSession: "Sitzung öffnen",
    createdHere: "In Happier erstellt",
  },
  title: 'Skills',
  pageDescription:
    'Anweisungen, die deine Agenten nutzen, wenn eine Aufgabe sie braucht. Füge einen Skill einmal hinzu, und er erreicht jede Maschine.',
  searchPlaceholder: 'Skills suchen',
  addSkill: 'Skill hinzufügen',
  allSkills: 'Alle Skills',
  needLook: ({ count }) =>
    count === 1 ? '1 braucht einen Blick' : `${count} brauchen einen Blick`,
  inUse: 'In Gebrauch',
  off: 'Aus',
  updates: 'Updates',
  noOwnSkills: 'Noch keine eigenen Skills',
  noMatch: ({ query }) => `Keine Skills passen zu „${query}“`,
  loadFailed: 'Deine Skills konnten nicht geladen werden',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'Skill erreicht' : 'Skills erreichen'} ${agents} auf ${machines} ${machines === 1 ? 'Maschine' : 'Maschinen'}`,
    reachNeedLook: ({ count }) =>
      `, und ${count} ${count === 1 ? 'braucht' : 'brauchen'} einen Blick`,
    reachNone: 'Noch ist keiner deiner Skills irgendwo an',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'Skill ist' : 'Skills sind'} an. Sie erreichen deine Agents, sobald eine Maschine meldet, welche sie hat.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'Skill ist' : 'Skills sind'} an, aber ${agents} kann keine Skills nutzen.`,
    unsupportedNote: ({ agents }) => `${agents} kann keine Skills nutzen.`,
    noMachines: 'Deine Skills erreichen die erste Maschine, die du verbindest.',
    catchesUp: ({ machines }) => `${machines} holt auf, sobald sie zurück ist.`,
    catchUpCount: ({ count }) => `${count} Offline-Maschinen holen auf, sobald sie zurück sind.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} Skills auf ${machines} Maschinen`,
    offlineLastKnown: ({ time }) => `Offline · zuletzt bekannt ${time}`,
    offline: 'Offline',
    noAgents: 'Noch keine Agenten',
    noSkillAgents: 'Kein Agent hier nutzt Skills',
    moreMachines: ({ count }) => `${count} weitere Maschinen`,
    needsLook: 'Braucht einen Blick',
    updateWaiting: 'Eine neuere Version wartet an ihrer Quelle.',
    modifiedUpstream: 'Du hast ihn geändert, und die Quelle auch.',
    removedFromSource: 'Die Quelle hat ihn nicht mehr. Behalte deine Kopie oder entferne ihn.',
    maskedOn: ({ machine }) => `Dort gewinnt die eigene Kopie von ${machine}.`,
    unreadable: 'Dieser Skill konnte nicht gelesen werden.',
    byId: ({ id }) => `Skill ${id}`,
    writeOwn: 'Selbst schreiben',
    review: 'Ansehen',
    decide: 'Entscheiden',
    whereTitle: 'Wo er an ist',
    whereBody:
      'Ein neuer Skill ist überall an. Beschränke ihn auf ein Projekt oder eine Maschine oder halte ihn von einem Agenten fern; die genaueste Regel gewinnt, und jede Sitzung kann einen hinzufügen oder weglassen.',
    firstHeadline: 'Deine Skills erreichen jetzt jede Maschine',
    firstPurpose:
      'Ein Skill ist ein Ordner mit Anweisungen, manchmal mit Skripten, den ein Agent nutzt, wenn eine Aufgabe ihn braucht. Deine folgen dir jetzt auf jede Maschine.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'Skill ist' : 'Skills sind'} dort an, wo du ${on === 1 ? 'ihn' : 'sie'} schon genutzt hast. ` : ''}${off} warten unter deinem Home, bis du wählst.`,
    choose: 'Auswählen, was an ist',
    chooseOff: ({ count }) => `${count} aus`,
    nothingElse: 'Sonst ändert sich nichts, bis du wählst.',
    emptyTitle: 'Bring es deinen Agenten einmal bei',
    emptyBody:
      'Ein Skill ist ein Ordner mit Anweisungen, den ein Agent nutzt, wenn eine Aufgabe ihn braucht. Füge hier einen hinzu, und jeder Agent auf jeder Maschine bekommt ihn.',
    emptySentence:
      'Maschinen kreisen um dein Home. Ein Skill, den du hinzufügst, reist zu jeder von ihnen, für jeden Agenten darauf.',
  },
};

const fr: SkillsPageTranslation = {
  pane: { thisBot: "Créées par ce Bot", yours: "Les tiennes", registries: "De tes registres", other: "Autres compétences", allSkills: "Toutes tes compétences" },
  saved: {
    saved: "Enregistré dans vos skills",
    notAttached: "Non attaché ici",
    attachAgain: "Attacher à nouveau",
    liveNow: "Actif maintenant",
    loadsAfterTurn: "Se charge après ce tour",
    restartNow: "Redémarrer maintenant",
    needsRestart: "Redémarrage nécessaire",
    view: "Voir",
    liveNowDetail: ({ name }) => name + " l’utilise dès son prochain message.",
    loadsAfterTurnDetail: "Elle arrive entre deux tours. La conversation est conservée.",
    restartDetail: "Redémarrer conserve la conversation.",
    restartTerminalDetail: "Redémarre-la depuis son terminal. La conversation est conservée.",
    notAttachedDetail: "Elle est dans tes compétences ; cette session ne l’a pas prise.",
    onlyUses: ({ name }) => "seul " + name + " l’utilise",
  },
  maker: {
    title: "Créé par",
    anyone: "Tout le monde",
    you: "Vous",
    anyBot: "Tout bot",
    registries: "Depuis les registres",
    session: "Session",
    person: "Une autre personne",
    unknown: "Créateur inconnu",
    openSession: "Ouvrir la session",
    createdHere: "Créé dans Happier",
  },
  title: 'Skills',
  pageDescription:
    'Des instructions que vos agents utilisent quand une tâche en a besoin. Ajoutez un skill une fois et il atteint chaque machine.',
  searchPlaceholder: 'Rechercher des skills',
  addSkill: 'Ajouter un skill',
  allSkills: 'Tous les skills',
  needLook: ({ count }) =>
    count === 1 ? '1 à vérifier' : `${count} à vérifier`,
  inUse: 'Utilisés',
  off: 'Désactivés',
  updates: 'Mises à jour',
  noOwnSkills: 'Aucun skill à vous pour l’instant',
  noMatch: ({ query }) => `Aucun skill ne correspond à « ${query} »`,
  loadFailed: 'Impossible de charger vos skills',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'skill atteint' : 'skills atteignent'} ${agents} sur ${machines} ${machines === 1 ? 'machine' : 'machines'}`,
    reachNeedLook: ({ count }) => `, et ${count} à vérifier`,
    reachNone: 'Aucun de vos skills n’est encore activé',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'skill est activé' : 'skills sont activés'}. Ils atteignent vos agents dès qu’une machine indique lesquels elle a.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'skill est activé' : 'skills sont activés'}, mais ${agents} ne peut pas utiliser de skills.`,
    unsupportedNote: ({ agents }) => `${agents} ne peut pas utiliser de skills.`,
    noMachines:
      'Vos skills atteindront la première machine que vous connectez.',
    catchesUp: ({ machines }) => `${machines} se mettra à jour à son retour.`,
    catchUpCount: ({ count }) => `${count} machines hors ligne se mettront à jour à leur retour.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} skills sur ${machines} machines`,
    offlineLastKnown: ({ time }) => `Hors ligne · dernier état ${time}`,
    offline: 'Hors ligne',
    noAgents: 'Aucun agent pour l’instant',
    noSkillAgents: 'Aucun agent ici n’utilise de skills',
    moreMachines: ({ count }) => `${count} autres machines`,
    needsLook: 'À vérifier',
    updateWaiting: 'Une version plus récente attend à sa source.',
    modifiedUpstream: 'Vous l’avez modifié, et la source aussi.',
    removedFromSource: 'Sa source ne l’a plus. Gardez votre copie, ou retirez-le.',
    maskedOn: ({ machine }) => `La copie de ${machine} l’emporte là-bas.`,
    unreadable: 'Impossible de lire cette compétence.',
    byId: ({ id }) => `Compétence ${id}`,
    writeOwn: 'Écrire la vôtre',
    review: 'Examiner',
    decide: 'Choisir',
    whereTitle: 'Où il est activé',
    whereBody:
      'Un nouveau skill est activé partout. Limitez-le à un projet ou une machine, ou retirez-le à un agent ; la règle la plus précise l’emporte, et chaque session peut en ajouter ou en retirer un.',
    firstHeadline: 'Vos skills atteignent maintenant chaque machine',
    firstPurpose:
      'Un skill est un dossier d’instructions, parfois avec des scripts, qu’un agent utilise quand une tâche en a besoin. Les vôtres vous suivent maintenant sur chaque machine.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'skill est activé' : 'skills sont activés'} là où vous les utilisiez déjà. ` : ''}${off} attendent sous votre Home jusqu’à votre choix.`,
    choose: 'Choisir ce qui est activé',
    chooseOff: ({ count }) => `${count} désactivés`,
    nothingElse: 'Rien d’autre ne change avant votre choix.',
    emptyTitle: 'Apprenez-le une fois à vos agents',
    emptyBody:
      'Un skill est un dossier d’instructions qu’un agent utilise quand une tâche en a besoin. Ajoutez-en un ici et chaque agent sur chaque machine le reçoit.',
    emptySentence:
      'Les machines gravitent autour de votre Home. Un skill que vous ajoutez voyage jusqu’à chacune d’elles, pour chaque agent.',
  },
};

const es: SkillsPageTranslation = {
  pane: { thisBot: "Creadas por este Bot", yours: "Tuyas", registries: "De tus registros", other: "Otras habilidades", allSkills: "Todas tus habilidades" },
  saved: {
    saved: "Guardado en tus skills",
    notAttached: "No está adjunto aquí",
    attachAgain: "Adjuntar de nuevo",
    liveNow: "Activo ahora",
    loadsAfterTurn: "Se carga después de este turno",
    restartNow: "Reiniciar ahora",
    needsRestart: "Necesita reiniciar",
    view: "Ver",
    liveNowDetail: ({ name }) => name + " la usa desde su próximo mensaje.",
    loadsAfterTurnDetail: "Se suma entre turnos. La conversación se conserva.",
    restartDetail: "Reiniciar conserva la conversación.",
    restartTerminalDetail: "Reiníciala desde su terminal. La conversación se conserva.",
    notAttachedDetail: "Está en tus habilidades; esta sesión no la tomó.",
    onlyUses: ({ name }) => "solo " + name + " la usa",
  },
  maker: {
    title: "Creado por",
    anyone: "Cualquiera",
    you: "Tú",
    anyBot: "Cualquier bot",
    registries: "De registros",
    session: "Sesión",
    person: "Otra persona",
    unknown: "Creador desconocido",
    openSession: "Abrir sesión",
    createdHere: "Creado en Happier",
  },
  title: 'Habilidades',
  pageDescription:
    'Instrucciones que tus agentes usan cuando una tarea las necesita. Añade una habilidad una vez y llega a todas tus máquinas.',
  searchPlaceholder: 'Buscar habilidades',
  addSkill: 'Añadir una habilidad',
  allSkills: 'Todas las habilidades',
  needLook: ({ count }) =>
    count === 1 ? '1 necesita revisión' : `${count} necesitan revisión`,
  inUse: 'En uso',
  off: 'Desactivadas',
  updates: 'Actualizaciones',
  noOwnSkills: 'Aún no tienes habilidades propias',
  noMatch: ({ query }) => `Ninguna habilidad coincide con «${query}»`,
  loadFailed: 'No se pudieron cargar tus habilidades',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'habilidad llega' : 'habilidades llegan'} a ${agents} en ${machines} ${machines === 1 ? 'máquina' : 'máquinas'}`,
    reachNeedLook: ({ count }) =>
      `, y ${count} ${count === 1 ? 'necesita' : 'necesitan'} revisión`,
    reachNone: 'Ninguna de tus habilidades está activada todavía',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'habilidad está activada' : 'habilidades están activadas'}. Llegan a tus agentes en cuanto una máquina indique cuáles tiene.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'habilidad está activada' : 'habilidades están activadas'}, pero ${agents} no puede usar habilidades.`,
    unsupportedNote: ({ agents }) => `${agents} no puede usar habilidades.`,
    noMachines: 'Tus habilidades llegarán a la primera máquina que conectes.',
    catchesUp: ({ machines }) => `${machines} se pondrá al día cuando vuelva.`,
    catchUpCount: ({ count }) => `${count} máquinas sin conexión se pondrán al día cuando vuelvan.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} habilidades en ${machines} máquinas`,
    offlineLastKnown: ({ time }) => `Sin conexión · último estado ${time}`,
    offline: 'Sin conexión',
    noAgents: 'Aún no hay agentes',
    noSkillAgents: 'Ningún agente aquí usa habilidades',
    moreMachines: ({ count }) => `${count} máquinas más`,
    needsLook: 'Necesitan revisión',
    updateWaiting: 'Hay una versión más nueva en su origen.',
    modifiedUpstream: 'La cambiaste y el origen también cambió.',
    removedFromSource: 'Su origen ya no la tiene. Conserva tu copia o quítala.',
    maskedOn: ({ machine }) => `Allí gana la copia propia de ${machine}.`,
    unreadable: 'No se pudo leer esta habilidad.',
    byId: ({ id }) => `Habilidad ${id}`,
    writeOwn: 'Escribir la tuya',
    review: 'Revisar',
    decide: 'Elegir',
    whereTitle: 'Dónde está activada',
    whereBody:
      'Una habilidad nueva está activada en todas partes. Limítala a un proyecto o una máquina, o quítasela a un agente; gana la regla más específica, y cualquier sesión puede añadir o quitar una.',
    firstHeadline: 'Tus habilidades ya llegan a todas tus máquinas',
    firstPurpose:
      'Una habilidad es una carpeta de instrucciones, a veces con scripts, que un agente usa cuando una tarea la necesita. Las tuyas ahora te siguen a todas tus máquinas.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'habilidad está activada' : 'habilidades están activadas'} donde ya las usabas. ` : ''}${off} esperan bajo tu Home hasta que elijas.`,
    choose: 'Elegir qué está activado',
    chooseOff: ({ count }) => `${count} desactivadas`,
    nothingElse: 'Nada más cambia hasta que elijas.',
    emptyTitle: 'Enseña a tus agentes una sola vez',
    emptyBody:
      'Una habilidad es una carpeta de instrucciones que un agente usa cuando una tarea la necesita. Añade una aquí y todos los agentes de todas tus máquinas la reciben.',
    emptySentence:
      'Las máquinas giran alrededor de tu Home. Una habilidad que añadas viaja a cada una de ellas, para cada agente.',
  },
};

const ca: SkillsPageTranslation = {
  pane: { thisBot: "Creades per aquest Bot", yours: "Teves", registries: "Dels teus registres", other: "Altres habilitats", allSkills: "Totes les teves habilitats" },
  saved: {
    saved: "Desat als teus skills",
    notAttached: "No està adjunt aquí",
    attachAgain: "Torna a adjuntar",
    liveNow: "Actiu ara",
    loadsAfterTurn: "Es carrega després d’aquest torn",
    restartNow: "Reinicia ara",
    needsRestart: "Cal reiniciar",
    view: "Mostra",
    liveNowDetail: ({ name }) => name + " la fa servir des del pròxim missatge.",
    loadsAfterTurnDetail: "S’afegeix entre torns. La conversa es conserva.",
    restartDetail: "Reiniciar conserva la conversa.",
    restartTerminalDetail: "Reinicia-la des del seu terminal. La conversa es conserva.",
    notAttachedDetail: "És a les teves habilitats; aquesta sessió no l’ha agafada.",
    onlyUses: ({ name }) => "només " + name + " la fa servir",
  },
  maker: {
    title: "Creat per",
    anyone: "Qualsevol",
    you: "Tu",
    anyBot: "Qualsevol bot",
    registries: "De registres",
    session: "Sessió",
    person: "Una altra persona",
    unknown: "Creador desconegut",
    openSession: "Obre la sessió",
    createdHere: "Creat a Happier",
  },
  ...es,
  title: 'Habilitats',
  pageDescription:
    'Instruccions que els teus agents fan servir quan una tasca les necessita. Afegeix una habilitat un cop i arriba a totes les màquines.',
  searchPlaceholder: 'Cerca habilitats',
  addSkill: 'Afegeix una habilitat',
  allSkills: 'Totes les habilitats',
  needLook: ({ count }) =>
    count === 1 ? '1 necessita revisió' : `${count} necessiten revisió`,
  inUse: 'En ús',
  off: 'Desactivades',
  updates: 'Actualitzacions',
  noOwnSkills: 'Encara no tens habilitats pròpies',
  noMatch: ({ query }) => `Cap habilitat coincideix amb «${query}»`,
  loadFailed: 'No s’han pogut carregar les teves habilitats',
  home: {
    ...es.home,
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'habilitat arriba' : 'habilitats arriben'} a ${agents} en ${machines} ${machines === 1 ? 'màquina' : 'màquines'}`,
    reachNeedLook: ({ count }) =>
      `, i ${count} ${count === 1 ? 'necessita' : 'necessiten'} revisió`,
    reachNone: 'Cap de les teves habilitats està activada encara',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'habilitat està activada' : 'habilitats estan activades'}. Arriben als teus agents quan una màquina indiqui quins té.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'habilitat està activada' : 'habilitats estan activades'}, però ${agents} no pot fer servir habilitats.`,
    unsupportedNote: ({ agents }) => `${agents} no pot fer servir habilitats.`,
    noMachines:
      'Les teves habilitats arribaran a la primera màquina que connectis.',
    catchesUp: ({ machines }) => `${machines} es posarà al dia quan torni.`,
    catchUpCount: ({ count }) => `${count} màquines fora de línia es posaran al dia quan tornin.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} habilitats en ${machines} màquines`,
    offlineLastKnown: ({ time }) => `Fora de línia · últim estat ${time}`,
    offline: 'Fora de línia',
    noAgents: 'Encara no hi ha agents',
    noSkillAgents: 'Cap agent d’aquí fa servir habilitats',
    moreMachines: ({ count }) => `${count} màquines més`,
    needsLook: 'Necessiten revisió',
    updateWaiting: 'Hi ha una versió més nova al seu origen.',
    modifiedUpstream: 'L’has canviada, i l’origen també ha canviat.',
    removedFromSource: 'El seu origen ja no la té. Conserva la teva còpia o treu-la.',
    maskedOn: ({ machine }) => `Allà guanya la còpia pròpia de ${machine}.`,
    unreadable: 'No s’ha pogut llegir aquesta habilitat.',
    byId: ({ id }) => `Habilitat ${id}`,
    writeOwn: 'Escriu-ne una',
    review: 'Revisa',
    decide: 'Tria',
    whereTitle: 'On està activada',
    whereBody: 
      'Una habilitat nova està activada a tot arreu. Limita-la a un projecte o una màquina, o desactiva-la per a un agent; la regla més específica guanya, i qualsevol sessió encara pot afegir-ne o treure’n una.',
    firstHeadline: 'Les teves habilitats ara arriben a totes les màquines',
    firstPurpose: 
      'Una habilitat és una carpeta d’instruccions, de vegades amb scripts, que un agent fa servir quan una tasca la necessita. Ara les teves et segueixen a totes les màquines.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'habilitat està activada' : 'habilitats estan activades'} on ja les feies servir. ` : ''}${off} esperen a la teva Home fins que triïs.`,
    choose: 'Tria què està activat',
    chooseOff: ({ count }) => `${count} desactivades`,
    nothingElse: 'Res més canvia fins que triïs.',
    emptyTitle: 'Ensenya-ho als teus agents un sol cop',
    emptyBody: 
      'Una habilitat és una carpeta d’instruccions que un agent fa servir quan una tasca la necessita. Afegeix-ne una aquí i tots els agents de totes les màquines la tindran.',
    emptySentence:
      'Les màquines giren al voltant de la teva Home. Una habilitat que afegeixis viatja a cadascuna, per a cada agent.',
  },
};

const it: SkillsPageTranslation = {
  pane: { thisBot: "Create da questo Bot", yours: "Le tue", registries: "Dai tuoi registri", other: "Altre abilità", allSkills: "Tutte le tue abilità" },
  saved: {
    saved: "Salvato nei tuoi skill",
    notAttached: "Non collegato qui",
    attachAgain: "Collega di nuovo",
    liveNow: "Attivo ora",
    loadsAfterTurn: "Si carica dopo questo turno",
    restartNow: "Riavvia ora",
    needsRestart: "Serve un riavvio",
    view: "Vedi",
    liveNowDetail: ({ name }) => name + " la usa dal prossimo messaggio.",
    loadsAfterTurnDetail: "Si aggiunge tra un turno e l’altro. La conversazione resta.",
    restartDetail: "Il riavvio mantiene la conversazione.",
    restartTerminalDetail: "Riavviala dal suo terminale. La conversazione resta.",
    notAttachedDetail: "È nelle tue abilità; questa sessione non l’ha presa.",
    onlyUses: ({ name }) => "solo " + name + " la usa",
  },
  maker: {
    title: "Creato da",
    anyone: "Chiunque",
    you: "Te",
    anyBot: "Qualsiasi bot",
    registries: "Dai registri",
    session: "Sessione",
    person: "Un’altra persona",
    unknown: "Autore sconosciuto",
    openSession: "Apri sessione",
    createdHere: "Creato in Happier",
  },
  title: 'Skill',
  pageDescription:
    'Istruzioni che i tuoi agenti usano quando un compito ne ha bisogno. Aggiungi una skill una volta e raggiunge ogni macchina.',
  searchPlaceholder: 'Cerca skill',
  addSkill: 'Aggiungi una skill',
  allSkills: 'Tutte le skill',
  needLook: ({ count }) =>
    count === 1 ? '1 da controllare' : `${count} da controllare`,
  inUse: 'In uso',
  off: 'Disattivate',
  updates: 'Aggiornamenti',
  noOwnSkills: 'Ancora nessuna skill tua',
  noMatch: ({ query }) => `Nessuna skill corrisponde a «${query}»`,
  loadFailed: 'Impossibile caricare le tue skill',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} skill ${count === 1 ? 'raggiunge' : 'raggiungono'} ${agents} su ${machines} ${machines === 1 ? 'macchina' : 'macchine'}`,
    reachNeedLook: ({ count }) => `, e ${count} da controllare`,
    reachNone: 'Nessuna delle tue skill è ancora attiva',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'skill è attiva' : 'skill sono attive'}. Raggiungono i tuoi agenti appena una macchina indica quali ha.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'skill è attiva' : 'skill sono attive'}, ma ${agents} non può usare skill.`,
    unsupportedNote: ({ agents }) => `${agents} non può usare skill.`,
    noMachines: 'Le tue skill raggiungeranno la prima macchina che colleghi.',
    catchesUp: ({ machines }) => `${machines} si aggiornerà quando torna.`,
    catchUpCount: ({ count }) => `${count} macchine offline si aggiorneranno quando tornano.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} skill su ${machines} macchine`,
    offlineLastKnown: ({ time }) => `Offline · ultimo stato ${time}`,
    offline: 'Offline',
    noAgents: 'Ancora nessun agente',
    noSkillAgents: 'Nessun agente qui usa skill',
    moreMachines: ({ count }) => `Altre ${count} macchine`,
    needsLook: 'Da controllare',
    updateWaiting: 'Una versione più recente aspetta alla sua fonte.',
    modifiedUpstream: 'L’hai modificata, e anche la fonte è cambiata.',
    removedFromSource: 'La sua fonte non la contiene più. Tieni la tua copia o rimuovila.',
    maskedOn: ({ machine }) => `Lì vince la copia di ${machine}.`,
    unreadable: 'Impossibile leggere questa skill.',
    byId: ({ id }) => `Skill ${id}`,
    writeOwn: 'Scrivine una',
    review: 'Rivedi',
    decide: 'Scegli',
    whereTitle: 'Dove è attiva',
    whereBody:
      'Una nuova skill è attiva ovunque. Limitala a un progetto o a una macchina, o escludila da un agente; vince la regola più specifica, e ogni sessione può aggiungerne o toglierne una.',
    firstHeadline: 'Le tue skill ora raggiungono ogni macchina',
    firstPurpose:
      'Una skill è una cartella di istruzioni, a volte con script, che un agente usa quando un compito ne ha bisogno. Le tue ora ti seguono su ogni macchina.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} skill ${on === 1 ? 'è attiva' : 'sono attive'} dove le usavi già. ` : ''}${off} aspettano sotto la tua Home finché non scegli.`,
    choose: 'Scegli cosa è attivo',
    chooseOff: ({ count }) => `${count} disattivate`,
    nothingElse: 'Nient’altro cambia finché non scegli.',
    emptyTitle: 'Insegnalo ai tuoi agenti una volta',
    emptyBody:
      'Una skill è una cartella di istruzioni che un agente usa quando un compito ne ha bisogno. Aggiungine una qui e ogni agente su ogni macchina la riceve.',
    emptySentence:
      'Le macchine orbitano intorno alla tua Home. Una skill che aggiungi arriva su ognuna, per ogni agente.',
  },
};

const pt: SkillsPageTranslation = {
  pane: { thisBot: "Criadas por este Bot", yours: "Suas", registries: "Dos seus registros", other: "Outras habilidades", allSkills: "Todas as suas habilidades" },
  saved: {
    saved: "Salvo nos seus skills",
    notAttached: "Não anexado aqui",
    attachAgain: "Anexar novamente",
    liveNow: "Ativo agora",
    loadsAfterTurn: "Carrega após este turno",
    restartNow: "Reiniciar agora",
    needsRestart: "Precisa reiniciar",
    view: "Ver",
    liveNowDetail: ({ name }) => name + " a usa a partir da próxima mensagem.",
    loadsAfterTurnDetail: "Ela entra entre os turnos. A conversa é mantida.",
    restartDetail: "Reiniciar mantém a conversa.",
    restartTerminalDetail: "Reinicie pelo terminal. A conversa é mantida.",
    notAttachedDetail: "Está nas suas habilidades; esta sessão não a recebeu.",
    onlyUses: ({ name }) => "só " + name + " a usa",
  },
  maker: {
    title: "Criado por",
    anyone: "Qualquer pessoa",
    you: "Você",
    anyBot: "Qualquer bot",
    registries: "Dos registros",
    session: "Sessão",
    person: "Outra pessoa",
    unknown: "Criador desconhecido",
    openSession: "Abrir sessão",
    createdHere: "Criado no Happier",
  },
  ...es,
  pageDescription:
    'Instruções que os seus agentes usam quando uma tarefa precisa delas. Adicione uma habilidade uma vez e ela chega a todas as máquinas.',
  searchPlaceholder: 'Pesquisar habilidades',
  addSkill: 'Adicionar uma habilidade',
  allSkills: 'Todas as habilidades',
  needLook: ({ count }) =>
    count === 1 ? '1 precisa de atenção' : `${count} precisam de atenção`,
  inUse: 'Em uso',
  off: 'Desativadas',
  updates: 'Atualizações',
  noOwnSkills: 'Ainda não há habilidades suas',
  noMatch: ({ query }) => `Nenhuma habilidade corresponde a “${query}”`,
  loadFailed: 'Não foi possível carregar as suas habilidades',
  home: {
    ...es.home,
    reach: ({ count, agents, machines }) =>
      `${count} ${count === 1 ? 'habilidade chega' : 'habilidades chegam'} a ${agents} em ${machines} ${machines === 1 ? 'máquina' : 'máquinas'}`,
    reachNeedLook: ({ count }) =>
      `, e ${count} ${count === 1 ? 'precisa' : 'precisam'} de atenção`,
    reachNone: 'Nenhuma das suas habilidades está ativada ainda',
    reachWaiting: ({ count }) =>
      `${count} ${count === 1 ? 'habilidade está ativada' : 'habilidades estão ativadas'}. Chegam aos seus agentes assim que uma máquina indicar quais tem.`,
    unsupported: ({ count, agents }) =>
      `${count} ${count === 1 ? 'habilidade está ativada' : 'habilidades estão ativadas'}, mas ${agents} não pode usar habilidades.`,
    unsupportedNote: ({ agents }) => `${agents} não pode usar habilidades.`,
    noMachines: 'As suas habilidades chegarão à primeira máquina que ligar.',
    catchesUp: ({ machines }) => `${machines} atualiza-se quando voltar.`,
    catchUpCount: ({ count }) => `${count} máquinas offline atualizam-se quando voltarem.`,
    mapLabel: ({ skills, machines }) =>
      `${skills} habilidades em ${machines} máquinas`,
    offlineLastKnown: ({ time }) => `Offline · último estado ${time}`,
    offline: 'Offline',
    noAgents: 'Ainda não há agentes',
    noSkillAgents: 'Nenhum agente aqui usa habilidades',
    moreMachines: ({ count }) => `Mais ${count} máquinas`,
    needsLook: 'Precisam de atenção',
    updateWaiting: 'Há uma versão mais recente na origem.',
    modifiedUpstream: 'Alterou-a, e a origem também mudou.',
    removedFromSource: 'A origem já não a tem. Mantenha a sua cópia ou remova-a.',
    maskedOn: ({ machine }) => `Lá prevalece a cópia de ${machine}.`,
    unreadable: 'Não foi possível ler esta habilidade.',
    byId: ({ id }) => `Habilidade ${id}`,
    writeOwn: 'Escrever a sua',
    review: 'Rever',
    decide: 'Escolher',
    whereTitle: 'Onde está ativada',
    whereBody: 
      'Uma habilidade nova fica ativada em todo o lado. Limite-a a um projeto ou a uma máquina, ou desative-a para um agente; a regra mais específica ganha, e qualquer sessão ainda pode adicionar ou retirar uma.',
    firstHeadline: 'As suas habilidades chegam agora a todas as máquinas',
    firstPurpose: 
      'Uma habilidade é uma pasta de instruções, por vezes com scripts, que um agente usa quando uma tarefa precisa dela. As suas seguem-no agora para todas as máquinas.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} ${on === 1 ? 'habilidade está ativada' : 'habilidades estão ativadas'} onde já as usava. ` : ''}${off} esperam na sua Home até escolher.`,
    choose: 'Escolher o que está ativo',
    chooseOff: ({ count }) => `${count} desativadas`,
    nothingElse: 'Nada mais muda até escolher.',
    emptyTitle: 'Ensine os seus agentes uma vez',
    emptyBody: 
      'Uma habilidade é uma pasta de instruções que um agente usa quando uma tarefa precisa dela. Adicione uma aqui e todos os agentes em todas as máquinas a recebem.',
    emptySentence:
      'As máquinas orbitam a sua Home. Uma habilidade que adicionar viaja até cada uma delas, para cada agente.',
  },
};

const pl: SkillsPageTranslation = {
  pane: { thisBot: "Utworzone przez tego Bota", yours: "Twoje", registries: "Z Twoich rejestrów", other: "Inne umiejętności", allSkills: "Wszystkie Twoje umiejętności" },
  saved: {
    saved: "Zapisano w Twoich umiejętnościach",
    notAttached: "Nie dołączono tutaj",
    attachAgain: "Dołącz ponownie",
    liveNow: "Aktywne teraz",
    loadsAfterTurn: "Załaduje się po tej turze",
    restartNow: "Uruchom ponownie",
    needsRestart: "Wymaga ponownego uruchomienia",
    view: "Pokaż",
    liveNowDetail: ({ name }) => name + " używa jej od następnej wiadomości.",
    loadsAfterTurnDetail: "Dołącza między turami. Rozmowa zostaje.",
    restartDetail: "Ponowne uruchomienie zachowuje rozmowę.",
    restartTerminalDetail: "Uruchom ją ponownie z terminala. Rozmowa zostaje.",
    notAttachedDetail: "Jest w twoich umiejętnościach; ta sesja jej nie przyjęła.",
    onlyUses: ({ name }) => "używa jej tylko " + name,
  },
  maker: {
    title: "Utworzone przez",
    anyone: "Każdego",
    you: "Ciebie",
    anyBot: "Dowolnego bota",
    registries: "Z rejestrów",
    session: "Sesja",
    person: "Inna osoba",
    unknown: "Nieznany twórca",
    openSession: "Otwórz sesję",
    createdHere: "Utworzono w Happier",
  },
  title: 'Umiejętności',
  pageDescription:
    'Instrukcje, z których agenci korzystają, gdy zadanie tego wymaga. Dodaj umiejętność raz, a trafi na każdą maszynę.',
  searchPlaceholder: 'Szukaj umiejętności',
  addSkill: 'Dodaj umiejętność',
  allSkills: 'Wszystkie umiejętności',
  needLook: ({ count }) => `${count} do sprawdzenia`,
  inUse: 'W użyciu',
  off: 'Wyłączone',
  updates: 'Aktualizacje',
  noOwnSkills: 'Brak jeszcze własnych umiejętności',
  noMatch: ({ query }) => `Żadna umiejętność nie pasuje do „${query}”`,
  loadFailed: 'Nie udało się wczytać umiejętności',
  home: {
    reach: ({ count, agents, machines }) =>
      `Umiejętności: ${count} · ${agents} · maszyny: ${machines}`,
    reachNeedLook: ({ count }) => `, ${count} do sprawdzenia`,
    reachNone: 'Żadna umiejętność nie jest jeszcze włączona',
    reachWaiting: ({ count }) =>
      `Włączone umiejętności: ${count}. Dotrą do twoich agentów, gdy maszyna poda, których używa.`,
    unsupported: ({ count, agents }) =>
      `Włączone umiejętności: ${count}, ale ${agents} nie obsługuje umiejętności.`,
    unsupportedNote: ({ agents }) => `${agents} nie obsługuje umiejętności.`,
    noMachines: 'Umiejętności trafią na pierwszą podłączoną maszynę.',
    catchesUp: ({ machines }) => `${machines} nadrobi zaległości po powrocie.`,
    catchUpCount: ({ count }) => `Maszyny offline (${count}) nadrobią zaległości po powrocie.`,
    mapLabel: ({ skills, machines }) =>
      `Umiejętności: ${skills}, maszyny: ${machines}`,
    offlineLastKnown: ({ time }) => `Offline · ostatni stan ${time}`,
    offline: 'Offline',
    noAgents: 'Brak agentów',
    noSkillAgents: 'Żaden agent tutaj nie używa umiejętności',
    moreMachines: ({ count }) => `Jeszcze ${count} maszyn`,
    needsLook: 'Do sprawdzenia',
    updateWaiting: 'W źródle czeka nowsza wersja.',
    modifiedUpstream: 'Zmieniono ją u Ciebie i w źródle.',
    removedFromSource: 'Źródło już jej nie ma. Zachowaj swoją kopię albo ją usuń.',
    maskedOn: ({ machine }) => `Tam wygrywa własna kopia ${machine}.`,
    unreadable: 'Nie udało się odczytać tej umiejętności.',
    byId: ({ id }) => `Umiejętność ${id}`,
    writeOwn: 'Napisz własną',
    review: 'Przejrzyj',
    decide: 'Wybierz',
    whereTitle: 'Gdzie jest włączona',
    whereBody:
      'Nowa umiejętność jest włączona wszędzie. Ogranicz ją do projektu lub maszyny albo wyłącz dla agenta; wygrywa najbardziej szczegółowa reguła, a każda sesja może ją dodać lub pominąć.',
    firstHeadline: 'Twoje umiejętności trafiają teraz na każdą maszynę',
    firstPurpose:
      'Umiejętność to folder z instrukcjami, czasem ze skryptami, z którego agent korzysta, gdy zadanie tego wymaga. Twoje są teraz na każdej maszynie.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `Włączone tam, gdzie już ich używano: ${on}. Czekają pod Twoim Home, aż wybierzesz: ` : ''}${off}.`,
    choose: 'Wybierz, co jest włączone',
    chooseOff: ({ count }) => `${count} wyłączone`,
    nothingElse: 'Nic więcej się nie zmieni, dopóki nie wybierzesz.',
    emptyTitle: 'Naucz agentów raz',
    emptyBody:
      'Umiejętność to folder z instrukcjami, z którego agent korzysta, gdy zadanie tego wymaga. Dodaj ją tutaj, a otrzyma ją każdy agent na każdej maszynie.',
    emptySentence:
      'Maszyny krążą wokół twojego Home. Dodana umiejętność trafia na każdą z nich, do każdego agenta.',
  },
};

const ru: SkillsPageTranslation = {
  pane: { thisBot: "Созданы этим Ботом", yours: "Ваши", registries: "Из ваших реестров", other: "Другие навыки", allSkills: "Все ваши навыки" },
  saved: {
    saved: "Сохранено в ваших навыках",
    notAttached: "Здесь не подключено",
    attachAgain: "Подключить снова",
    liveNow: "Уже активно",
    loadsAfterTurn: "Загрузится после этого хода",
    restartNow: "Перезапустить сейчас",
    needsRestart: "Нужен перезапуск",
    view: "Открыть",
    liveNowDetail: ({ name }) => name + " использует его со следующего сообщения.",
    loadsAfterTurnDetail: "Он подключится между ходами. Разговор сохранится.",
    restartDetail: "Перезапуск сохраняет разговор.",
    restartTerminalDetail: "Перезапустите сессию из терминала. Разговор сохранится.",
    notAttachedDetail: "Он есть в ваших навыках, но эта сессия его не приняла.",
    onlyUses: ({ name }) => "использует только " + name,
  },
  maker: {
    title: "Кем создано",
    anyone: "Кем угодно",
    you: "Вами",
    anyBot: "Любым ботом",
    registries: "Из реестров",
    session: "Сессия",
    person: "Другой человек",
    unknown: "Автор неизвестен",
    openSession: "Открыть сессию",
    createdHere: "Создано в Happier",
  },
  title: 'Скиллы',
  pageDescription:
    'Инструкции, которые агенты берут, когда задача их требует. Добавьте скилл один раз — и он будет на каждой машине.',
  searchPlaceholder: 'Искать скиллы',
  addSkill: 'Добавить скилл',
  allSkills: 'Все скиллы',
  needLook: ({ count }) => `Проверить: ${count}`,
  inUse: 'Используются',
  off: 'Выключены',
  updates: 'Обновления',
  noOwnSkills: 'Своих скиллов пока нет',
  noMatch: ({ query }) => `Нет скиллов по запросу «${query}»`,
  loadFailed: 'Не удалось загрузить скиллы',
  home: {
    reach: ({ count, agents, machines }) =>
      `Скиллов: ${count} · ${agents} · машин: ${machines}`,
    reachNeedLook: ({ count }) => `, проверить: ${count}`,
    reachNone: 'Ни один скилл пока не включён',
    reachWaiting: ({ count }) =>
      `Включено навыков: ${count}. Они дойдут до ваших агентов, как только машина сообщит, какие у неё есть.`,
    unsupported: ({ count, agents }) =>
      `Включено скиллов: ${count}, но ${agents} не умеет пользоваться скиллами.`,
    unsupportedNote: ({ agents }) => `${agents} не умеет пользоваться скиллами.`,
    noMachines: 'Скиллы появятся на первой подключённой машине.',
    catchesUp: ({ machines }) => `${machines} догонит, когда вернётся.`,
    catchUpCount: ({ count }) => `Машины не в сети (${count}) догонят, когда вернутся.`,
    mapLabel: ({ skills, machines }) =>
      `Скиллов: ${skills}, машин: ${machines}`,
    offlineLastKnown: ({ time }) => `Не в сети · последнее состояние ${time}`,
    offline: 'Не в сети',
    noAgents: 'Агентов пока нет',
    noSkillAgents: 'Здесь ни один агент не использует скиллы',
    moreMachines: ({ count }) => `Ещё машин: ${count}`,
    needsLook: 'Нужно проверить',
    updateWaiting: 'В источнике ждёт более новая версия.',
    modifiedUpstream: 'Вы изменили его, и источник тоже изменился.',
    removedFromSource: 'В источнике его больше нет. Оставьте свою копию или удалите его.',
    maskedOn: ({ machine }) => `Там действует собственная копия ${machine}.`,
    unreadable: 'Не удалось прочитать этот навык.',
    byId: ({ id }) => `Навык ${id}`,
    writeOwn: 'Написать свой',
    review: 'Посмотреть',
    decide: 'Выбрать',
    whereTitle: 'Где включён',
    whereBody:
      'Новый скилл включён везде. Ограничьте его проектом или машиной или скройте от агента; побеждает самое точное правило, а любая сессия может добавить или убрать скилл.',
    firstHeadline: 'Теперь ваши скиллы есть на каждой машине',
    firstPurpose:
      'Скилл — это папка с инструкциями, иногда со скриптами, которую агент берёт, когда задача её требует. Ваши теперь следуют за вами на каждую машину.',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `Включены там, где вы их уже использовали: ${on}. Ждут под вашим Home, пока вы не выберете: ` : ''}${off}.`,
    choose: 'Выбрать, что включено',
    chooseOff: ({ count }) => `Выключено: ${count}`,
    nothingElse: 'Больше ничего не изменится, пока вы не выберете.',
    emptyTitle: 'Научите агентов один раз',
    emptyBody:
      'Скилл — это папка с инструкциями, которую агент берёт, когда задача её требует. Добавьте его здесь, и его получит каждый агент на каждой машине.',
    emptySentence:
      'Машины вращаются вокруг вашего Home. Добавленный скилл попадает на каждую из них, к каждому агенту.',
  },
};

const ja: SkillsPageTranslation = {
  pane: { thisBot: "このBotが作成", yours: "あなたのスキル", registries: "レジストリから", other: "その他のスキル", allSkills: "すべてのスキル" },
  saved: {
    saved: "スキルに保存しました",
    notAttached: "このセッションには未追加",
    attachAgain: "もう一度追加",
    liveNow: "現在有効",
    loadsAfterTurn: "このターンの後に読み込み",
    restartNow: "今すぐ再起動",
    needsRestart: "読み込みには再起動が必要",
    view: "表示",
    liveNowDetail: ({ name }) => name + " は次のメッセージから使います。",
    loadsAfterTurnDetail: "ターンの合間に読み込まれます。会話はそのままです。",
    restartDetail: "再起動しても会話はそのままです。",
    restartTerminalDetail: "ターミナルから再起動してください。会話はそのままです。",
    notAttachedDetail: "スキルには保存されていますが、このセッションには入っていません。",
    onlyUses: ({ name }) => name + " だけが使います",
  },
  maker: {
    title: "作成者",
    anyone: "すべて",
    you: "あなた",
    anyBot: "すべてのボット",
    registries: "レジストリから",
    session: "セッション",
    person: "他の人",
    unknown: "作成者不明",
    openSession: "セッションを開く",
    createdHere: "Happierで作成",
  },
  title: 'スキル',
  pageDescription:
    'タスクに必要なときにエージェントが使う指示です。一度追加すれば、すべてのマシンに届きます。',
  searchPlaceholder: 'スキルを検索',
  addSkill: 'スキルを追加',
  allSkills: 'すべてのスキル',
  needLook: ({ count }) => `${count}件 要確認`,
  inUse: '使用中',
  off: 'オフ',
  updates: 'アップデート',
  noOwnSkills: '自分のスキルはまだありません',
  noMatch: ({ query }) => `「${query}」に一致するスキルはありません`,
  loadFailed: 'スキルを読み込めませんでした',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count}件のスキルが${machines}台のマシンの${agents}に届いています`,
    reachNeedLook: ({ count }) => `。${count}件が要確認`,
    reachNone: 'まだどのスキルもオンになっていません',
    reachWaiting: ({ count }) =>
      `${count} 件のスキルがオンです。マシンが手元のエージェントを知らせると届きます。`,
    unsupported: ({ count, agents }) =>
      `${count}件のスキルがオンですが、${agents}はスキルを使えません。`,
    unsupportedNote: ({ agents }) => `${agents}はスキルを使えません。`,
    noMachines: '最初に接続したマシンにスキルが届きます。',
    catchesUp: ({ machines }) => `${machines}は戻ったときに追いつきます。`,
    catchUpCount: ({ count }) => `オフラインの ${count} 台は、戻ったときに追いつきます。`,
    mapLabel: ({ skills, machines }) =>
      `${machines}台のマシンに${skills}件のスキル`,
    offlineLastKnown: ({ time }) => `オフライン · 最終確認 ${time}`,
    offline: 'オフライン',
    noAgents: 'エージェントはまだありません',
    noSkillAgents: 'ここにスキルを使うエージェントはいません',
    moreMachines: ({ count }) => `ほか ${count} 台のマシン`,
    needsLook: '要確認',
    updateWaiting: '取得元に新しいバージョンがあります。',
    modifiedUpstream: 'あなたも取得元も変更しています。',
    removedFromSource: '取得元から削除されました。手元のコピーを残すか、削除してください。',
    maskedOn: ({ machine }) => `そこでは ${machine} 自身のコピーが優先されます。`,
    unreadable: 'このスキルを読み込めませんでした。',
    byId: ({ id }) => `スキル ${id}`,
    writeOwn: '自分で書く',
    review: '確認',
    decide: '選ぶ',
    whereTitle: 'オンになっている場所',
    whereBody:
      '新しいスキルはどこでもオンです。プロジェクトやマシンに絞ったり、特定のエージェントから外したりできます。最も具体的なルールが優先され、各セッションで追加や除外もできます。',
    firstHeadline: 'スキルがすべてのマシンに届くようになりました',
    firstPurpose:
      'スキルは、タスクに必要なときにエージェントが使う指示のフォルダーです（スクリプトを含むこともあります）。あなたのスキルはすべてのマシンについてきます。',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on}件はすでに使っていた場所でオンです。` : ''}${off}件はあなたが選ぶまでHomeで待機します。`,
    choose: 'オンにするものを選ぶ',
    chooseOff: ({ count }) => `${count}件オフ`,
    nothingElse: '選ぶまでほかには何も変わりません。',
    emptyTitle: 'エージェントに一度だけ教える',
    emptyBody:
      'スキルは、タスクに必要なときにエージェントが使う指示のフォルダーです。ここで追加すると、すべてのマシンのすべてのエージェントに届きます。',
    emptySentence:
      'マシンはあなたの Home の周りを回っています。追加したスキルは、どのマシンのどのエージェントにも届きます。',
  },
};

const zhHans: SkillsPageTranslation = {
  pane: { thisBot: "此 Bot 创建", yours: "你的技能", registries: "来自你的注册库", other: "其他技能", allSkills: "你的所有技能" },
  saved: {
    saved: "已保存到你的技能",
    notAttached: "未附加到此会话",
    attachAgain: "重新附加",
    liveNow: "现已生效",
    loadsAfterTurn: "本轮结束后加载",
    restartNow: "立即重启",
    needsRestart: "需要重启才能加载",
    view: "查看",
    liveNowDetail: ({ name }) => name + " 从下一条消息起使用它。",
    loadsAfterTurnDetail: "它会在两轮之间加入。对话保留。",
    restartDetail: "重启会保留对话。",
    restartTerminalDetail: "请在终端中重启。对话保留。",
    notAttachedDetail: "它已在你的技能中，但本会话没有加载。",
    onlyUses: ({ name }) => "仅 " + name + " 使用",
  },
  maker: {
    title: "创建者",
    anyone: "任何人",
    you: "你",
    anyBot: "任何机器人",
    registries: "来自注册表",
    session: "会话",
    person: "其他人",
    unknown: "创建者未知",
    openSession: "打开会话",
    createdHere: "在 Happier 中创建",
  },
  title: '技能',
  pageDescription:
    '任务需要时你的智能体会采用的指令。添加一次，技能就会到达每台机器。',
  searchPlaceholder: '搜索技能',
  addSkill: '添加技能',
  allSkills: '全部技能',
  needLook: ({ count }) => `${count} 个需要查看`,
  inUse: '使用中',
  off: '已关闭',
  updates: '更新',
  noOwnSkills: '还没有你自己的技能',
  noMatch: ({ query }) => `没有与“${query}”匹配的技能`,
  loadFailed: '无法加载你的技能',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} 个技能到达 ${machines} 台机器上的 ${agents}`,
    reachNeedLook: ({ count }) => `，${count} 个需要查看`,
    reachNone: '你的技能还没有在任何地方开启',
    reachWaiting: ({ count }) =>
      `已开启 ${count} 个技能。机器报告它有哪些智能体后，技能就会到达。`,
    unsupported: ({ count, agents }) =>
      `已开启 ${count} 个技能，但 ${agents} 无法使用技能。`,
    unsupportedNote: ({ agents }) => `${agents} 无法使用技能。`,
    noMachines: '你的技能会到达你连接的第一台机器。',
    catchesUp: ({ machines }) => `${machines} 回来后会跟上。`,
    catchUpCount: ({ count }) => `${count} 台离线机器回来后会跟上。`,
    mapLabel: ({ skills, machines }) =>
      `${machines} 台机器上的 ${skills} 个技能`,
    offlineLastKnown: ({ time }) => `离线 · 最后已知 ${time}`,
    offline: '离线',
    noAgents: '还没有智能体',
    noSkillAgents: '这里没有使用技能的智能体',
    moreMachines: ({ count }) => `另外 ${count} 台机器`,
    needsLook: '需要查看',
    updateWaiting: '来源处有更新的版本。',
    modifiedUpstream: '你改过它，来源也变了。',
    removedFromSource: '来源中已没有它。保留你的副本，或移除它。',
    maskedOn: ({ machine }) => `在那里，${machine} 自己的副本优先。`,
    unreadable: '无法读取此技能。',
    byId: ({ id }) => `技能 ${id}`,
    writeOwn: '自己编写',
    review: '查看',
    decide: '选择',
    whereTitle: '在哪里开启',
    whereBody:
      '新技能默认处处开启。可以把它限定到某个项目或机器，或对某个智能体关闭；最具体的规则优先，任何会话也可以自行添加或去掉。',
    firstHeadline: '你的技能现在会到达每台机器',
    firstPurpose:
      '技能是一个指令文件夹，有时带脚本，任务需要时智能体会采用它。你的技能现在会跟随你到每台机器。',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} 个技能在你用过的地方已开启。` : ''}${off} 个在你的 Home 中等待你选择。`,
    choose: '选择开启哪些',
    chooseOff: ({ count }) => `${count} 个已关闭`,
    nothingElse: '在你选择之前，其他一切不变。',
    emptyTitle: '一次教会你的智能体',
    emptyBody:
      '技能是一个指令文件夹，任务需要时智能体会采用它。在这里添加一个，每台机器上的每个智能体都会得到它。',
    emptySentence:
      '机器围绕着你的 Home。你添加的技能会到达每一台机器上的每个智能体。',
  },
};

const zhHant: SkillsPageTranslation = {
  pane: { thisBot: "此 Bot 建立", yours: "你的技能", registries: "來自你的登錄庫", other: "其他技能", allSkills: "你的所有技能" },
  saved: {
    saved: "已儲存至你的技能",
    notAttached: "未附加至此工作階段",
    attachAgain: "重新附加",
    liveNow: "現已生效",
    loadsAfterTurn: "本輪結束後載入",
    restartNow: "立即重新啟動",
    needsRestart: "需要重新啟動才能載入",
    view: "檢視",
    liveNowDetail: ({ name }) => name + " 從下一則訊息起使用它。",
    loadsAfterTurnDetail: "它會在兩輪之間加入。對話會保留。",
    restartDetail: "重新啟動會保留對話。",
    restartTerminalDetail: "請在終端機重新啟動。對話會保留。",
    notAttachedDetail: "它已在你的技能中，但此工作階段沒有載入。",
    onlyUses: ({ name }) => "僅 " + name + " 使用",
  },
  maker: {
    title: "建立者",
    anyone: "任何人",
    you: "你",
    anyBot: "任何機器人",
    registries: "來自登錄庫",
    session: "工作階段",
    person: "其他人",
    unknown: "建立者未知",
    openSession: "開啟工作階段",
    createdHere: "在 Happier 中建立",
  },
  title: '技能',
  pageDescription:
    '任務需要時你的代理會採用的指令。新增一次，技能就會到達每台機器。',
  searchPlaceholder: '搜尋技能',
  addSkill: '新增技能',
  allSkills: '所有技能',
  needLook: ({ count }) => `${count} 個需要查看`,
  inUse: '使用中',
  off: '已關閉',
  updates: '更新',
  noOwnSkills: '還沒有你自己的技能',
  noMatch: ({ query }) => `沒有符合「${query}」的技能`,
  loadFailed: '無法載入你的技能',
  home: {
    reach: ({ count, agents, machines }) =>
      `${count} 個技能到達 ${machines} 台機器上的 ${agents}`,
    reachNeedLook: ({ count }) => `，${count} 個需要查看`,
    reachNone: '你的技能還沒有在任何地方開啟',
    reachWaiting: ({ count }) =>
      `已開啟 ${count} 個技能。機器回報它有哪些智慧體後，技能就會到達。`,
    unsupported: ({ count, agents }) =>
      `已開啟 ${count} 個技能，但 ${agents} 無法使用技能。`,
    unsupportedNote: ({ agents }) => `${agents} 無法使用技能。`,
    noMachines: '你的技能會到達你連接的第一台機器。',
    catchesUp: ({ machines }) => `${machines} 回來後會跟上。`,
    catchUpCount: ({ count }) => `${count} 台離線機器回來後會跟上。`,
    mapLabel: ({ skills, machines }) =>
      `${machines} 台機器上的 ${skills} 個技能`,
    offlineLastKnown: ({ time }) => `離線 · 最後已知 ${time}`,
    offline: '離線',
    noAgents: '還沒有代理',
    noSkillAgents: '這裡沒有使用技能的智慧體',
    moreMachines: ({ count }) => `另外 ${count} 台機器`,
    needsLook: '需要查看',
    updateWaiting: '來源處有更新的版本。',
    modifiedUpstream: '你改過它，來源也變了。',
    removedFromSource: '來源中已沒有它。保留你的副本，或移除它。',
    maskedOn: ({ machine }) => `在那裡，${machine} 自己的副本優先。`,
    unreadable: '無法讀取此技能。',
    byId: ({ id }) => `技能 ${id}`,
    writeOwn: '自己撰寫',
    review: '查看',
    decide: '選擇',
    whereTitle: '在哪裡開啟',
    whereBody:
      '新技能預設處處開啟。可以把它限定到某個專案或機器，或對某個代理關閉；最具體的規則優先，任何工作階段也可以自行新增或移除。',
    firstHeadline: '你的技能現在會到達每台機器',
    firstPurpose:
      '技能是一個指令資料夾，有時附帶指令碼，任務需要時代理會採用它。你的技能現在會跟著你到每台機器。',
    firstSentence: ({ on, off }) =>
      `${on > 0 ? `${on} 個技能在你用過的地方已開啟。` : ''}${off} 個在你的 Home 中等你選擇。`,
    choose: '選擇開啟哪些',
    chooseOff: ({ count }) => `${count} 個已關閉`,
    nothingElse: '在你選擇之前，其他一切不變。',
    emptyTitle: '一次教會你的代理',
    emptyBody:
      '技能是一個指令資料夾，任務需要時代理會採用它。在這裡新增一個，每台機器上的每個代理都會得到它。',
    emptySentence:
      '機器圍繞著你的 Home。你新增的技能會到達每一台機器上的每個智慧體。',
  },
};

export const skillsPageTranslations = {
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
