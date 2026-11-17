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

export const es: SkillsPageTranslation = {
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

export const skillsPageTranslations = {
  en,
} as const;
