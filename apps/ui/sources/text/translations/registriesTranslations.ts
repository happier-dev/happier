// Registry select, the Registries view (P4 U6) and the skills Add modal (P6 U6.4). Mounted under
// `capabilities.registries` and `capabilities.skillAdd`.

type Kind = Readonly<{ kind: 'skill' | 'mcpServer' | 'agent' | 'plugin' }>;
type Count = Readonly<{ count: number }>;

const kindNoun = (kind: Kind['kind'], plural: boolean): string => {
  switch (kind) {
    case 'skill':
      return plural ? 'skills' : 'skill';
    case 'mcpServer':
      return plural ? 'MCP servers' : 'MCP server';
    case 'agent':
      return plural ? 'agents' : 'agent';
    case 'plugin':
      return plural ? 'plugins' : 'plugin';
  }
};
const compact = (count: number, decimal = '.'): string =>
  count >= 1000
    ? `${(count / 1000)
        .toFixed(count >= 10_000 ? 0 : 1)
        .replace(/\.0$/, '')
        .replace('.', decimal)}k`
    : String(count);

export type RegistriesTranslation = Readonly<{
  status: Readonly<{ updatedEarlier: string }>;
  select: Readonly<{
    label: string;
    all: string;
    addRegistry: string;
    manage: string;
  }>;
  format: Readonly<{
    builtIn: string;
    git: string;
    skillsSh: string;
    claudeMarketplace: string;
    mcpRegistry: string;
    acpRegistry: string;
    happierCatalog: string;
    happierNpm: string;
    addedBy: (params: Readonly<{ plugin: string }>) => string;
    off: string;
  }>;
  itemCount: (params: Kind & Count) => string;
  view: Readonly<{
    title: string;
    purpose: (params: Kind) => string;
    listLabel: string;
    newRow: string;
    newRowBody: string;
    empty: string;
  }>;
  add: Readonly<{
    title: string;
    purpose: (params: Kind) => string;
    link: string;
    linkPlaceholder: string;
    checking: string;
    found: (params: Kind & Count) => string;
    foundNoCount: string;
    name: string;
    whatYouCanAdd: string;
    gitTitle: string;
    gitBody: (params: Kind) => string;
    marketplaceTitle: string;
    marketplaceBody: string;
    mcpRegistryTitle: string;
    mcpRegistryBody: string;
    acpRegistryTitle: string;
    acpRegistryBody: string;
    catalogTitle: string;
    catalogBody: string;
    submit: string;
    cancel: string;
    organisation: string;
    unknownFormat: string;
    needsToken: (params: Readonly<{ host: string }>) => string;
    tokenRejected: string;
    httpsRequired: string;
    credentialsInLink: string;
    unreachable: string;
    alreadyAdded: string;
    failed: string;
  }>;
  detail: Readonly<{
    builtInPurpose: string;
    pluginPurpose: (params: Readonly<{ plugin: string }>) => string;
    userPurpose: (params: Kind) => string;
    nameTitle: string;
    nameBody: string;
    sourceTitle: string;
    refOn: (params: Readonly<{ ref: string }>) => string;
    refresh: string;
    refreshNow: string;
    checked: (params: Readonly<{ time: string }>) => string;
    notChecked: string;
    useTitle: string;
    useBody: (params: Kind) => string;
    fromItTitle: (params: Kind) => string;
    fromItRow: (params: Readonly<{ ref: string }>) => string;
    fromItRowNoRef: string;
    remove: string;
    removeConfirm: string;
    removeNote: (params: Kind) => string;
    removeFailed: string;
    updateFailed: string;
    tokenTitle: string;
    tokenNone: (params: Readonly<{ host: string }>) => string;
    tokenSet: (params: Readonly<{ name: string; host: string }>) => string;
    tokenGitHubHost: string;
    tokenAdd: string;
    tokenChange: string;
    tokenPickTitle: string;
    tokenAdded: string;
    tokenRemoved: string;
    undo: string;
  }>;
}>;

const en: RegistriesTranslation = {
  status: { updatedEarlier: "Updated earlier" },
  select: {
    label: 'Registry',
    all: 'All registries',
    addRegistry: 'Add a registry…',
    manage: 'Manage registries',
  },
  format: {
    builtIn: 'Built in',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Claude marketplace',
    mcpRegistry: 'MCP Registry',
    acpRegistry: 'ACP Registry',
    happierCatalog: 'Happier catalog',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Added by ${plugin}`,
    off: 'Off',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count)} ${kindNoun(kind, count !== 1)}`,
  view: {
    title: 'Registries',
    purpose: ({ kind }) => `Where Browse looks for ${kindNoun(kind, true)}.`,
    listLabel: 'Registries',
    newRow: 'New registry',
    newRowBody: 'Paste a link to start',
    empty: 'Add a registry',
  },
  add: {
    title: 'Add a registry',
    purpose: ({ kind }) =>
      `A place to browse ${kindNoun(kind, true)} from. Happier only reads it; nothing in it runs.`,
    link: 'Link',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Checking the link…',
    found: ({ kind, count }) =>
      `${compact(count)} ${kindNoun(kind, count !== 1)}`,
    foundNoCount: 'Ready to browse',
    name: 'Name',
    whatYouCanAdd: 'What you can add',
    gitTitle: 'A Git repository',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Any folder with a SKILL.md, for example github.com/anthropics/skills'
        : 'A repository Happier can read over HTTPS',
    marketplaceTitle: 'A Claude plugin marketplace',
    marketplaceBody:
      'A marketplace.json; Happier lists the skills inside its plugins',
    mcpRegistryTitle: 'An MCP Registry',
    mcpRegistryBody:
      'The official registry or a sub-registry that serves /v0.1/servers',
    acpRegistryTitle: 'An ACP Registry',
    acpRegistryBody: 'A registry.json listing agents and how to install them',
    catalogTitle: 'A Happier catalog',
    catalogBody: 'A catalog.json listing plugins',
    submit: 'Add registry',
    cancel: 'Cancel',
    organisation: 'This is an organisation. Add one of its repositories.',
    unknownFormat:
      'This link isn’t a Git repository, a Claude marketplace, an MCP Registry or an ACP Registry.',
    needsToken: ({ host }) =>
      `This registry asked for a token. It’s sent only to ${host}.`,
    tokenRejected: 'That token was rejected. Choose another.',
    httpsRequired: 'Use an https:// link',
    credentialsInLink: 'Remove the username and password from this link',
    unreachable: 'Couldn’t reach this link. Check it and try again.',
    alreadyAdded: 'Already in your registries',
    failed: 'Couldn’t add this registry. Try again.',
  },
  detail: {
    builtInPurpose:
      'Built into Happier. You can turn it off, but not remove it.',
    pluginPurpose: ({ plugin }) =>
      `Added by ${plugin}. It goes away when the plugin does.`,
    userPurpose: ({ kind }) =>
      `A registry you added. Happier reads the ${kindNoun(kind, true)} in it; nothing in it runs.`,
    nameTitle: 'Name',
    nameBody: 'How it appears in the registry menu.',
    sourceTitle: 'Source',
    refOn: ({ ref }) => `on ${ref}`,
    refresh: 'Refresh',
    refreshNow: 'Refresh now',
    checked: ({ time }) => `Checked ${time}`,
    notChecked: 'Reads again when you browse it',
    useTitle: 'Use in Browse',
    useBody: ({ kind }) =>
      `Turn it off to stop listing its ${kindNoun(kind, true)}. Nothing you added from it changes.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Skills from it in your library'
        : `${kindNoun(kind, true).replace(/^./, (c) => c.toUpperCase())} you added from it`,
    fromItRow: ({ ref }) => `Pinned to ${ref} · removing the registry keeps it`,
    fromItRowNoRef: 'Removing the registry keeps it',
    remove: 'Remove registry',
    removeConfirm: "This removes the registry from Browse. Anything you added from it stays installed or in your library. You can add the registry again later.",
    removeNote: ({ kind }) =>
      `${kindNoun(kind, true).replace(/^./, (c) => c.toUpperCase())} you added from it stay in your library.`,
    removeFailed: 'Couldn’t remove this registry. Try again.',
    updateFailed: 'Couldn’t save the change. Try again.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) => `For private registries, or a higher limit. Sent only to ${host}.`,
    tokenSet: ({ name, host }) => `${name} · sent only to ${host}`,
    tokenGitHubHost: 'GitHub, for this repository',
    tokenAdd: 'Add token',
    tokenChange: 'Change',
    tokenPickTitle: 'Choose a token',
    tokenAdded: 'Token saved',
    tokenRemoved: 'Token removed',
    undo: 'Undo',
  },
};

export type SkillAddTranslation = Readonly<{
  title: string;
  modes: Readonly<{
    browse: string;
    link: string;
    upload: string;
    write: string;
  }>;
  searchPlaceholder: (params: Readonly<{ count: number | null }>) => string;
  groupAll: string;
  groupPicks: string;
  groupSource: (params: Readonly<{ source: string }>) => string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  emptyTitle: string;
  emptyBody: string;
  clear: string;
  add: string;
  inLibrary: string;
  open: string;
  addToLibrary: string;
  pinnedTo: (params: Readonly<{ ref: string }>) => string;
  via: (params: Readonly<{ source: string }>) => string;
  outsideReferences: (params: Count) => string;
  outsideReferencesMore: (params: Count) => string;
  alsoAdds: (params: Readonly<{ name: string }>) => string;
  detail: Readonly<{
    whereTitle: string;
    whereBody: string;
    installsTitle: string;
    runsScriptsBody: (params: Count) => string;
    hasFilesBody: (params: Count) => string;
    textOnlyBody: string;
    tokensWhenUsed: (params: Readonly<{ count: string }>) => string;
    alwaysOnBody: (params: Readonly<{ count: string }>) => string;
    sourceBody: (params: Readonly<{ source: string; ref: string }>) => string;
    nextTitle: string;
    next1: string;
    next2: string;
    next3: string;
    filesTitle: (params: Count) => string;
    problemTooLarge: string;
    problemUnsupported: string;
    problemRemoved: string;
    loading: string;
    loadFailed: string;
  }>;
  partial: Readonly<{
    rules: string;
    content: (params: Readonly<{ names: string }>) => string;
    tryAgain: string;
    retrying: string;
  }>;
  link: Readonly<{
    title: string;
    body: string;
    placeholder: string;
    find: string;
    finding: string;
    found: (params: Count) => string;
    none: string;
    invalid: string;
    failed: string;
    addSelected: (params: Count) => string;
    selectAll: string;
    openOne: string;
    chooseWhich: string;
  }>;
  upload: Readonly<{
    title: string;
    body: string;
    dropHere: string;
    chooseZip: string;
    chooseFolder: string;
    neverRuns: string;
    reading: string;
    invalidName: (params: Readonly<{ file: string }>) => string;
    unreadable: (params: Readonly<{ file: string }>) => string;
    found: (params: Count) => string;
    noSkill: string;
    failed: string;
  }>;
}>;

const enSkillAdd: SkillAddTranslation = {
  title: 'Add a skill',
  modes: {
    browse: 'Browse',
    link: 'From a link',
    upload: 'Upload',
    write: 'Write',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Search skills'
      : `Search ${compact(count)} skills`,
  groupAll: 'In your registries',
  groupPicks: 'Happier picks',
  groupSource: ({ source }) => `From ${source}`,
  noMatch: ({ query }) => `No skills match “${query}”`,
  emptyTitle: 'No skills to browse yet',
  emptyBody:
    'The registries you use don’t list any skills right now. Add a registry from the menu above, or write a skill of your own.',
  clear: 'Clear',
  add: 'Add',
  inLibrary: 'In your library',
  open: 'Open',
  addToLibrary: 'Add to library',
  pinnedTo: ({ ref }) => `Pinned to ${ref}`,
  via: ({ source }) => `via ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Refers to one file that won’t be included.' : `Refers to ${count} files that won’t be included.`,
  outsideReferencesMore: ({ count }) => `and ${count} more`,
  alsoAdds: ({ name }) => `Also adds ${name}, which it refers to`,
  detail: {
    whereTitle: 'Where it’s on',
    whereBody: 'Every machine and agent, unless you narrow it now.',
    installsTitle: 'What it installs',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'One script' : `${count} scripts`}. Nothing runs when you add it; an agent may run them when it uses the skill, under the session’s permissions.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'One file' : `${count} files`} beside its instructions. Nothing in them runs.`,
    textOnlyBody: 'Instructions only. Nothing in it runs.',
    tokensWhenUsed: ({ count }) => `About ${count} tokens when used`,
    alwaysOnBody: ({ count }) =>
      `${count} tokens in every session for its description, so agents know it’s there.`,
    sourceBody: ({ source, ref }) =>
      `Found on ${source} · pinned to ${ref} · changes wait for your review`,
    nextTitle: 'What happens next',
    next1: 'It’s saved to your library, end-to-end encrypted.',
    next2:
      'The next session on each machine gets it. Running sessions don’t change.',
    next3: 'Your own skill folders aren’t touched.',
    filesTitle: ({ count }) => (count === 1 ? 'One file' : `${count} files`),
    problemTooLarge: 'Bigger than a skill can be, so it can’t be added.',
    problemUnsupported:
      'Uses a symlink or submodule; Happier can’t add it safely.',
    problemRemoved: 'No longer in its registry.',
    loading: 'Reading it…',
    loadFailed: 'Couldn’t read this skill. Try again.',
  },
  partial: {
    rules: 'Added · Couldn’t set where it’s on',
    content: ({ names }) => names ? `Couldn’t add ${names}. Added skills are kept.` : 'Couldn’t finish adding skills. Added skills are kept.',
    tryAgain: 'Try again',
    retrying: 'Setting where it’s on…',
  },
  link: {
    title: 'From a link',
    body: 'Paste a GitHub repository or folder. Happier lists the skills in it, pinned to the current commit.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Find skills',
    finding: 'Looking for skills…',
    found: ({ count }) =>
      count === 1
        ? 'One skill in this repository'
        : `${count} skills in this repository`,
    none: 'No skills in this repository. A skill is a folder with a SKILL.md.',
    invalid: 'Paste a full link, starting with https://',
    failed: 'Couldn’t read this link. Check it and try again.',
    addSelected: ({ count }) =>
      count === 1 ? 'Add 1 skill' : `Add ${count} skills`,
    selectAll: 'Select all',
    openOne: 'Open one to see what it installs.',
    chooseWhich: 'Choose which to add',
  },
  upload: {
    title: 'Upload',
    body: 'A skill folder or a .zip with a SKILL.md inside. It’s read here; nothing runs.',
    dropHere: 'Drop a folder or a .zip here',
    chooseZip: 'Choose a .zip',
    chooseFolder: 'Choose a folder',
    neverRuns: 'Uploads are checked here and never run.',
    reading: 'Reading…',
    invalidName: ({ file }) =>
      `“${file}” has a name that can’t be saved on every machine. Rename it and try again.`,
    found: ({ count }) =>
      count === 1
        ? 'One skill in this upload'
        : `${count} skills in this upload`,
    unreadable: ({ file }) => `Couldn’t read “${file}”.`,
    noSkill: 'No SKILL.md in what you chose.',
    failed: 'Couldn’t read this upload. Try again.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Per-locale nouns. `counted` follows a number ("3 skills"), `plural` is the plain nominative plural used inside a
// sentence or as a title, and `object` is the plural form that follows "stop listing" (it differs from `plural`
// only where the language inflects it: Russian genitive, Polish accusative).
// ---------------------------------------------------------------------------------------------------------------
type NounKind = Kind['kind'];
type Nouns = Readonly<{
  counted: (kind: NounKind, count: number) => string;
  plural: (kind: NounKind) => string;
  object: (kind: NounKind) => string;
}>;
type CountForm = 'one' | 'few' | 'many';
type SlavicForms = Readonly<{
  one: string;
  few: string;
  many: string;
  plural: string;
  object: string;
}>;

const cap = (text: string): string => text.replace(/^./, (c) => c.toUpperCase());

const pairNouns = (
  table: Record<NounKind, readonly [string, string]>,
  isSingular: (count: number) => boolean = (count) => count === 1,
): Nouns => ({
  counted: (kind, count) => table[kind][isSingular(count) ? 0 : 1],
  plural: (kind) => table[kind][1],
  object: (kind) => table[kind][1],
});
// East Asian locales have one form; the count word sits in the sentence.
const bareNouns = (table: Record<NounKind, string>): Nouns => ({
  counted: (kind) => table[kind],
  plural: (kind) => table[kind],
  object: (kind) => table[kind],
});
// A compact figure such as "1.2k" always takes the plural (genitive plural) form.
const slavicNouns = (
  table: Record<NounKind, SlavicForms>,
  form: (count: number) => CountForm,
): Nouns => ({
  counted: (kind, count) => table[kind][count >= 1000 ? 'many' : form(count)],
  plural: (kind) => table[kind].plural,
  object: (kind) => table[kind].object,
});
const russianForm = (count: number): CountForm => {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return 'one';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'few';
  return 'many';
};
const polishForm = (count: number): CountForm => {
  if (count === 1) return 'one';
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
    ? 'few'
    : 'many';
};
const pickForm = (
  form: CountForm,
  forms: Readonly<Record<CountForm, string>>,
): string => forms[form];

// ---------------------------------------------------------------------------------------------------------------
// Catalan
// ---------------------------------------------------------------------------------------------------------------
const caNouns = pairNouns({
  skill: ['habilitat', 'habilitats'],
  mcpServer: ['servidor MCP', 'servidors MCP'],
  agent: ['agent', 'agents'],
  plugin: ['connector', 'connectors'],
});

const ca: RegistriesTranslation = {
  status: { updatedEarlier: "Actualitzat anteriorment" },
  select: {
    label: 'Registre',
    all: 'Tots els registres',
    addRegistry: 'Afegeix un registre…',
    manage: 'Gestiona els registres',
  },
  format: {
    builtIn: 'Integrat',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace de Claude',
    mcpRegistry: 'Registre MCP',
    acpRegistry: 'Registre ACP',
    happierCatalog: 'Catàleg de Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Afegit per ${plugin}`,
    off: 'Desactivat',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${caNouns.counted(kind, count)}`,
  view: {
    title: 'Registres',
    purpose: ({ kind }) =>
      `Els llocs on Explora cerca ${caNouns.plural(kind)}.`,
    listLabel: 'Registres',
    newRow: 'Nou registre',
    newRowBody: 'Enganxa un enllaç per començar',
    empty: 'Afegeix un registre',
  },
  add: {
    title: 'Afegeix un registre',
    purpose: ({ kind }) =>
      `Un lloc des d’on explorar ${caNouns.plural(kind)}. Happier només el llegeix; res del que conté s’executa.`,
    link: 'Enllaç',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Comprovant l’enllaç…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${caNouns.counted(kind, count)}`,
    foundNoCount: 'A punt per explorar',
    name: 'Nom',
    whatYouCanAdd: 'Què pots afegir',
    gitTitle: 'Un repositori Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Qualsevol carpeta amb un SKILL.md, per exemple github.com/anthropics/skills'
        : 'Un repositori que Happier pugui llegir per HTTPS',
    marketplaceTitle: 'Un marketplace de connectors de Claude',
    marketplaceBody:
      'Un marketplace.json; Happier mostra les habilitats dels seus connectors',
    mcpRegistryTitle: 'Un registre MCP',
    mcpRegistryBody:
      'El registre oficial o un subregistre que serveixi /v0.1/servers',
    acpRegistryTitle: 'Un registre ACP',
    acpRegistryBody: 'Un registry.json amb els agents i com instal·lar-los',
    catalogTitle: 'Un catàleg de Happier',
    catalogBody: 'Un catalog.json amb connectors',
    submit: 'Afegeix el registre',
    cancel: 'Cancel·la',
    organisation: 'Això és una organització. Afegeix-ne un dels repositoris.',
    unknownFormat:
      'Aquest enllaç no és un repositori Git, un marketplace de Claude, un registre MCP ni un registre ACP.',
    needsToken: ({ host }) =>
      `Aquest registre ha demanat un token. Només s’enviarà a ${host}.`,
    tokenRejected: 'S’ha rebutjat aquest token. Tria’n un altre.',
    httpsRequired: 'Fes servir un enllaç https://',
    credentialsInLink: 'Elimina el nom d’usuari i la contrasenya d’aquest enllaç',
    unreachable: 'No s’ha pogut contactar amb aquest enllaç. Comprova’l i torna-ho a provar.',
    alreadyAdded: 'Ja és als teus registres',
    failed: 'No s’ha pogut afegir aquest registre. Torna-ho a provar.',
  },
  detail: {
    builtInPurpose:
      'Integrat a Happier. Pots desactivar-lo, però no eliminar-lo.',
    pluginPurpose: ({ plugin }) =>
      `Afegit per ${plugin}. Desapareix quan ho fa el connector.`,
    userPurpose: ({ kind }) =>
      `Un registre que has afegit, amb ${caNouns.plural(kind)}. Happier només el llegeix; res del que conté s’executa.`,
    nameTitle: 'Nom',
    nameBody: 'Com apareix al menú de registres.',
    sourceTitle: 'Origen',
    refOn: ({ ref }) => `a ${ref}`,
    refresh: 'Actualitza',
    refreshNow: 'Actualitza ara',
    checked: ({ time }) => `Comprovat ${time}`,
    notChecked: 'Es torna a llegir quan l’explores',
    useTitle: 'Fes-lo servir a Explora',
    useBody: ({ kind }) =>
      `Desactiva’l per deixar de llistar ${caNouns.object(kind)} d’aquest registre. Res del que n’has afegit canvia.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Habilitats d’aquest registre a la teva biblioteca'
        : `${cap(caNouns.plural(kind))} que n’has afegit`,
    fromItRow: ({ ref }) => `Fixat a ${ref} · si elimines el registre, es manté`,
    fromItRowNoRef: 'Si elimines el registre, es manté',
    remove: 'Elimina el registre',
    removeConfirm: "Això elimina el registre d’Explora. Tot el que hi hagis afegit continua instal·lat o a la biblioteca. Pots tornar a afegir el registre més endavant.",
    removeNote: () => 'El que n’has afegit es queda a la teva biblioteca.',
    removeFailed: 'No s’ha pogut eliminar aquest registre. Torna-ho a provar.',
    updateFailed: 'No s’ha pogut desar el canvi. Torna-ho a provar.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Per a registres privats o un límit més alt. Només s’envia a ${host}.`,
    tokenSet: ({ name, host }) => `${name} · només s’envia a ${host}`,
    tokenGitHubHost: 'GitHub, per a aquest repositori',
    tokenAdd: 'Afegeix un token',
    tokenChange: 'Canvia',
    tokenPickTitle: 'Tria un token',
    tokenAdded: 'Token desat',
    tokenRemoved: 'Token eliminat',
    undo: 'Desfés',
  },
};

const caSkillAdd: SkillAddTranslation = {
  title: 'Afegeix una habilitat',
  modes: {
    browse: 'Explora',
    link: 'Des d’un enllaç',
    upload: 'Puja',
    write: 'Escriu',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Cerca habilitats'
      : `Cerca entre ${compact(count, ',')} habilitats`,
  groupAll: 'Als teus registres',
  groupPicks: 'Selecció de Happier',
  groupSource: ({ source }) => `De ${source}`,
  noMatch: ({ query }) => `Cap habilitat coincideix amb «${query}»`,
  emptyTitle: 'Encara no hi ha habilitats per explorar',
  emptyBody:
    'Els registres que fas servir no llisten cap habilitat ara mateix. Afegeix un registre des del menú de dalt o escriu una habilitat pròpia.',
  clear: 'Neteja',
  add: 'Afegeix',
  inLibrary: 'A la teva biblioteca',
  open: 'Obre',
  addToLibrary: 'Afegeix a la biblioteca',
  pinnedTo: ({ ref }) => `Fixada a ${ref}`,
  via: ({ source }) => `via ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Fa referència a un fitxer que no s’inclourà.' : `Fa referència a ${count} fitxers que no s’inclouran.`,
  outsideReferencesMore: ({ count }) => `i ${count} més`,
  alsoAdds: ({ name }) => `També afegeix ${name}, a què fa referència`,
  detail: {
    whereTitle: 'On està activada',
    whereBody:
      'A totes les màquines i agents, tret que la limitis ara.',
    installsTitle: 'Què instal·la',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Un script' : `${count} scripts`}. En afegir-la no s’executa res; un agent pot executar-los quan faci servir l’habilitat, amb els permisos de la sessió.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Un fitxer' : `${count} fitxers`} al costat de les instruccions. Res d’això s’executa.`,
    textOnlyBody: 'Només instruccions. Res d’això s’executa.',
    tokensWhenUsed: ({ count }) => `Uns ${count} tokens quan es fa servir`,
    alwaysOnBody: ({ count }) =>
      `${count} tokens a cada sessió per a la descripció, perquè els agents sàpiguen que hi és.`,
    sourceBody: ({ source, ref }) =>
      `Trobada a ${source} · fixada a ${ref} · els canvis esperen la teva revisió`,
    nextTitle: 'Què passa després',
    next1: 'Es desa a la teva biblioteca, amb xifratge d’extrem a extrem.',
    next2:
      'La propera sessió de cada màquina la rebrà. Les sessions en curs no canvien.',
    next3: 'Les teves pròpies carpetes d’habilitats no es toquen.',
    filesTitle: ({ count }) => (count === 1 ? 'Un fitxer' : `${count} fitxers`),
    problemTooLarge:
      'És més gran del que pot ser una habilitat, així que no es pot afegir.',
    problemUnsupported:
      'Fa servir un enllaç simbòlic o un submòdul; Happier no pot afegir-la amb seguretat.',
    problemRemoved: 'Ja no és al seu registre.',
    loading: 'Llegint…',
    loadFailed: 'No s’ha pogut llegir aquesta habilitat. Torna-ho a provar.',
  },
  partial: {
    rules: 'Afegida · No s’ha pogut definir on està activada',
    content: ({ names }) => names ? `No s’ha pogut afegir ${names}. Es conserven les habilitats afegides.` : 'No s’han pogut acabar d’afegir les habilitats. Es conserven les habilitats afegides.',
    tryAgain: 'Torna-ho a provar',
    retrying: 'Definint on està activada…',
  },
  link: {
    title: 'Des d’un enllaç',
    body: 'Enganxa un repositori o una carpeta de GitHub. Happier en llista les habilitats, fixades a la confirmació actual.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Cerca habilitats',
    finding: 'Cercant habilitats…',
    found: ({ count }) =>
      count === 1
        ? 'Una habilitat en aquest repositori'
        : `${count} habilitats en aquest repositori`,
    none: 'No hi ha habilitats en aquest repositori. Una habilitat és una carpeta amb un SKILL.md.',
    invalid: 'Enganxa un enllaç complet, que comenci per https://',
    failed: 'No s’ha pogut llegir aquest enllaç. Comprova’l i torna-ho a provar.',
    addSelected: ({ count }) =>
      count === 1 ? 'Afegeix 1 habilitat' : `Afegeix ${count} habilitats`,
    selectAll: 'Selecciona-ho tot',
    openOne: 'Obre’n un per veure què instal·la.',
    chooseWhich: 'Tria quins vols afegir',
  },
  upload: {
    title: 'Puja',
    body: 'Una carpeta d’habilitat o un .zip amb un SKILL.md a dins. Es llegeix aquí; no s’executa res.',
    dropHere: 'Deixa aquí una carpeta o un .zip',
    chooseZip: 'Tria un .zip',
    chooseFolder: 'Tria una carpeta',
    neverRuns: 'Les pujades es comproven aquí i no s’executen mai.',
    reading: 'Llegint…',
    invalidName: ({ file }) =>
      `«${file}» té un nom que no es pot desar a totes les màquines. Canvia-li el nom i torna-ho a provar.`,
    found: ({ count }) =>
      count === 1
        ? 'Una habilitat en aquesta càrrega'
        : `${count} habilitats en aquesta càrrega`,
    unreadable: ({ file }) => `No s’ha pogut llegir «${file}».`,
    noSkill: 'No hi ha cap SKILL.md en el que has triat.',
    failed: 'No s’ha pogut llegir aquesta pujada. Torna-ho a provar.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// German
// ---------------------------------------------------------------------------------------------------------------
const deNouns = pairNouns({
  skill: ['Skill', 'Skills'],
  mcpServer: ['MCP-Server', 'MCP-Server'],
  agent: ['Agent', 'Agenten'],
  plugin: ['Plugin', 'Plugins'],
});

const de: RegistriesTranslation = {
  status: { updatedEarlier: "Zuvor aktualisiert" },
  select: {
    label: 'Registry',
    all: 'Alle Registries',
    addRegistry: 'Registry hinzufügen…',
    manage: 'Registries verwalten',
  },
  format: {
    builtIn: 'Integriert',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Claude-Marketplace',
    mcpRegistry: 'MCP Registry',
    acpRegistry: 'ACP Registry',
    happierCatalog: 'Happier-Katalog',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Hinzugefügt von ${plugin}`,
    off: 'Aus',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${deNouns.counted(kind, count)}`,
  view: {
    title: 'Registries',
    purpose: ({ kind }) =>
      `Wo Entdecken nach ${deNouns.plural(kind)} sucht.`,
    listLabel: 'Registries',
    newRow: 'Neue Registry',
    newRowBody: 'Füge einen Link ein, um zu starten',
    empty: 'Registry hinzufügen',
  },
  add: {
    title: 'Registry hinzufügen',
    purpose: ({ kind }) =>
      `Ein Ort, an dem du ${deNouns.plural(kind)} entdecken kannst. Happier liest ihn nur; nichts darin wird ausgeführt.`,
    link: 'Link',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Link wird geprüft…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${deNouns.counted(kind, count)}`,
    foundNoCount: 'Bereit zum Entdecken',
    name: 'Name',
    whatYouCanAdd: 'Was du hinzufügen kannst',
    gitTitle: 'Ein Git-Repository',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Jeder Ordner mit einer SKILL.md, zum Beispiel github.com/anthropics/skills'
        : 'Ein Repository, das Happier über HTTPS lesen kann',
    marketplaceTitle: 'Ein Claude-Plugin-Marketplace',
    marketplaceBody:
      'Eine marketplace.json; Happier listet die Skills in ihren Plugins auf',
    mcpRegistryTitle: 'Eine MCP Registry',
    mcpRegistryBody:
      'Die offizielle Registry oder eine Unter-Registry, die /v0.1/servers bereitstellt',
    acpRegistryTitle: 'Eine ACP Registry',
    acpRegistryBody:
      'Eine registry.json mit Agenten und Hinweisen zur Installation',
    catalogTitle: 'Ein Happier-Katalog',
    catalogBody: 'Eine catalog.json mit Plugins',
    submit: 'Registry hinzufügen',
    cancel: 'Abbrechen',
    organisation:
      'Das ist eine Organisation. Füge eines ihrer Repositories hinzu.',
    unknownFormat:
      'Dieser Link ist weder ein Git-Repository noch ein Claude-Marketplace, eine MCP Registry oder eine ACP Registry.',
    needsToken: ({ host }) =>
      `Diese Registry verlangt ein Token. Es wird nur an ${host} gesendet.`,
    tokenRejected: 'Dieses Token wurde abgelehnt. Wähle ein anderes.',
    httpsRequired: 'Verwende einen https://-Link',
    credentialsInLink: 'Entferne Benutzernamen und Passwort aus diesem Link',
    unreachable:
      'Dieser Link ist nicht erreichbar. Prüfe ihn und versuche es erneut.',
    alreadyAdded: 'Schon in deinen Registries',
    failed:
      'Diese Registry konnte nicht hinzugefügt werden. Versuche es erneut.',
  },
  detail: {
    builtInPurpose:
      'In Happier eingebaut. Du kannst sie ausschalten, aber nicht entfernen.',
    pluginPurpose: ({ plugin }) =>
      `Hinzugefügt von ${plugin}. Sie verschwindet, wenn das Plugin verschwindet.`,
    userPurpose: ({ kind }) =>
      `Eine Registry, die du hinzugefügt hast, mit ${deNouns.plural(kind)}. Happier liest sie nur; nichts darin wird ausgeführt.`,
    nameTitle: 'Name',
    nameBody: 'So erscheint sie im Registry-Menü.',
    sourceTitle: 'Quelle',
    refOn: ({ ref }) => `auf ${ref}`,
    refresh: 'Aktualisieren',
    refreshNow: 'Jetzt aktualisieren',
    checked: ({ time }) => `Geprüft ${time}`,
    notChecked: 'Wird neu gelesen, wenn du sie durchsuchst',
    useTitle: 'In Entdecken verwenden',
    useBody: ({ kind }) =>
      `Schalte sie aus, damit ${deNouns.object(kind)} aus ihr nicht mehr aufgelistet werden. Was du daraus hinzugefügt hast, bleibt unverändert.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Skills daraus in deiner Bibliothek'
        : `${cap(deNouns.plural(kind))}, die du daraus hinzugefügt hast`,
    fromItRow: ({ ref }) =>
      `Angeheftet an ${ref} · bleibt erhalten, wenn du die Registry entfernst`,
    fromItRowNoRef: 'Bleibt erhalten, wenn du die Registry entfernst',
    remove: 'Registry entfernen',
    removeConfirm: "Die Registry wird aus Durchsuchen entfernt. Alles, was du daraus hinzugefügt hast, bleibt installiert oder in deiner Bibliothek. Du kannst die Registry später wieder hinzufügen.",
    removeNote: ({ kind }) =>
      `${cap(deNouns.plural(kind))}, die du daraus hinzugefügt hast, bleiben in deiner Bibliothek.`,
    removeFailed:
      'Diese Registry konnte nicht entfernt werden. Versuche es erneut.',
    updateFailed:
      'Die Änderung konnte nicht gespeichert werden. Versuche es erneut.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Für private Registries oder ein höheres Limit. Wird nur an ${host} gesendet.`,
    tokenSet: ({ name, host }) => `${name} · wird nur an ${host} gesendet`,
    tokenGitHubHost: 'GitHub, für dieses Repository',
    tokenAdd: 'Token hinzufügen',
    tokenChange: 'Ändern',
    tokenPickTitle: 'Token auswählen',
    tokenAdded: 'Token gespeichert',
    tokenRemoved: 'Token entfernt',
    undo: 'Rückgängig',
  },
};

const deSkillAdd: SkillAddTranslation = {
  title: 'Skill hinzufügen',
  modes: {
    browse: 'Entdecken',
    link: 'Per Link',
    upload: 'Hochladen',
    write: 'Schreiben',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Skills suchen'
      : `${compact(count, ',')} Skills durchsuchen`,
  groupAll: 'In deinen Registries',
  groupPicks: 'Happier-Auswahl',
  groupSource: ({ source }) => `Von ${source}`,
  noMatch: ({ query }) => `Keine Skills passen zu „${query}“`,
  emptyTitle: 'Noch keine Skills zu entdecken',
  emptyBody:
    'Die Registries, die Sie nutzen, listen derzeit keine Skills. Fügen Sie über das Menü oben eine Registry hinzu oder schreiben Sie selbst einen Skill.',
  clear: 'Leeren',
  add: 'Hinzufügen',
  inLibrary: 'In deiner Bibliothek',
  open: 'Öffnen',
  addToLibrary: 'Zur Bibliothek hinzufügen',
  pinnedTo: ({ ref }) => `Angeheftet an ${ref}`,
  via: ({ source }) => `über ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Verweist auf eine Datei, die nicht enthalten ist.' : `Verweist auf ${count} Dateien, die nicht enthalten sind.`,
  outsideReferencesMore: ({ count }) => `und ${count} weitere`,
  alsoAdds: ({ name }) => `Fügt außerdem ${name} hinzu, auf das es verweist`,
  detail: {
    whereTitle: 'Wo er an ist',
    whereBody:
      'Auf jeder Maschine und bei jedem Agenten, außer du beschränkst ihn jetzt.',
    installsTitle: 'Was installiert wird',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Ein Skript' : `${count} Skripte`}. Beim Hinzufügen läuft nichts; ein Agent kann sie ausführen, wenn er den Skill nutzt, mit den Rechten der Sitzung.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Eine Datei' : `${count} Dateien`} neben den Anweisungen. Nichts davon wird ausgeführt.`,
    textOnlyBody: 'Nur Anweisungen. Nichts davon wird ausgeführt.',
    tokensWhenUsed: ({ count }) => `Etwa ${count} Tokens bei Nutzung`,
    alwaysOnBody: ({ count }) =>
      `${count} Tokens in jeder Sitzung für die Beschreibung, damit Agenten wissen, dass er da ist.`,
    sourceBody: ({ source, ref }) =>
      `Gefunden auf ${source} · angeheftet an ${ref} · Änderungen warten auf deine Prüfung`,
    nextTitle: 'Was dann passiert',
    next1: 'Er wird Ende-zu-Ende-verschlüsselt in deiner Bibliothek gespeichert.',
    next2:
      'Die nächste Sitzung auf jeder Maschine bekommt ihn. Laufende Sitzungen ändern sich nicht.',
    next3: 'Deine eigenen Skill-Ordner bleiben unberührt.',
    filesTitle: ({ count }) => (count === 1 ? 'Eine Datei' : `${count} Dateien`),
    problemTooLarge:
      'Größer, als ein Skill sein darf, deshalb kann er nicht hinzugefügt werden.',
    problemUnsupported:
      'Nutzt einen Symlink oder ein Submodul; Happier kann ihn so nicht sicher hinzufügen.',
    problemRemoved: 'Nicht mehr in seiner Registry.',
    loading: 'Wird gelesen…',
    loadFailed: 'Dieser Skill konnte nicht gelesen werden. Versuche es erneut.',
  },
  partial: {
    rules: 'Hinzugefügt · „Wo er an ist“ konnte nicht gesetzt werden',
    content: ({ names }) => names ? `${names} konnte nicht hinzugefügt werden. Hinzugefügte Skills bleiben erhalten.` : 'Skills konnten nicht vollständig hinzugefügt werden. Hinzugefügte Skills bleiben erhalten.',
    tryAgain: 'Erneut versuchen',
    retrying: '„Wo er an ist“ wird gesetzt…',
  },
  link: {
    title: 'Per Link',
    body: 'Füge ein GitHub-Repository oder einen Ordner ein. Happier listet die Skills darin auf, angeheftet an den aktuellen Commit.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Skills finden',
    finding: 'Suche nach Skills…',
    found: ({ count }) =>
      count === 1
        ? 'Ein Skill in diesem Repository'
        : `${count} Skills in diesem Repository`,
    none: 'Keine Skills in diesem Repository. Ein Skill ist ein Ordner mit einer SKILL.md.',
    invalid: 'Füge einen vollständigen Link ein, der mit https:// beginnt',
    failed:
      'Dieser Link konnte nicht gelesen werden. Prüfe ihn und versuche es erneut.',
    addSelected: ({ count }) =>
      count === 1 ? 'Einen Skill hinzufügen' : `${count} Skills hinzufügen`,
    selectAll: 'Alle auswählen',
    openOne: 'Öffne einen, um zu sehen, was er installiert.',
    chooseWhich: 'Wähle aus, was hinzukommt',
  },
  upload: {
    title: 'Hochladen',
    body: 'Ein Skill-Ordner oder eine .zip mit einer SKILL.md darin. Sie wird hier gelesen; nichts wird ausgeführt.',
    dropHere: 'Ordner oder .zip hier ablegen',
    chooseZip: '.zip auswählen',
    chooseFolder: 'Ordner auswählen',
    neverRuns: 'Uploads werden hier geprüft und nie ausgeführt.',
    reading: 'Wird gelesen…',
    invalidName: ({ file }) =>
      `„${file}“ hat einen Namen, der nicht auf jeder Maschine gespeichert werden kann. Benenne sie um und versuche es erneut.`,
    found: ({ count }) =>
      count === 1
        ? 'Ein Skill in diesem Upload'
        : `${count} Skills in diesem Upload`,
    unreadable: ({ file }) => `„${file}“ konnte nicht gelesen werden.`,
    noSkill: 'Keine SKILL.md in deiner Auswahl.',
    failed: 'Dieser Upload konnte nicht gelesen werden. Versuche es erneut.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Spanish
// ---------------------------------------------------------------------------------------------------------------
const esNouns = pairNouns({
  skill: ['habilidad', 'habilidades'],
  mcpServer: ['servidor MCP', 'servidores MCP'],
  agent: ['agente', 'agentes'],
  plugin: ['plugin', 'plugins'],
});

const es: RegistriesTranslation = {
  status: { updatedEarlier: "Actualizado anteriormente" },
  select: {
    label: 'Registro',
    all: 'Todos los registros',
    addRegistry: 'Añadir un registro…',
    manage: 'Gestionar registros',
  },
  format: {
    builtIn: 'Integrado',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace de Claude',
    mcpRegistry: 'Registro MCP',
    acpRegistry: 'Registro ACP',
    happierCatalog: 'Catálogo de Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Añadido por ${plugin}`,
    off: 'Desactivado',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${esNouns.counted(kind, count)}`,
  view: {
    title: 'Registros',
    purpose: ({ kind }) =>
      `Los lugares donde Explorar busca ${esNouns.plural(kind)}.`,
    listLabel: 'Registros',
    newRow: 'Nuevo registro',
    newRowBody: 'Pega un enlace para empezar',
    empty: 'Añade un registro',
  },
  add: {
    title: 'Añadir un registro',
    purpose: ({ kind }) =>
      `Un lugar desde el que explorar ${esNouns.plural(kind)}. Happier solo lo lee; nada de lo que contiene se ejecuta.`,
    link: 'Enlace',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Comprobando el enlace…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${esNouns.counted(kind, count)}`,
    foundNoCount: 'Listo para explorar',
    name: 'Nombre',
    whatYouCanAdd: 'Qué puedes añadir',
    gitTitle: 'Un repositorio Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Cualquier carpeta con un SKILL.md, por ejemplo github.com/anthropics/skills'
        : 'Un repositorio que Happier pueda leer por HTTPS',
    marketplaceTitle: 'Un marketplace de plugins de Claude',
    marketplaceBody:
      'Un marketplace.json; Happier lista las habilidades de sus plugins',
    mcpRegistryTitle: 'Un registro MCP',
    mcpRegistryBody:
      'El registro oficial o un subregistro que sirva /v0.1/servers',
    acpRegistryTitle: 'Un registro ACP',
    acpRegistryBody: 'Un registry.json con agentes y cómo instalarlos',
    catalogTitle: 'Un catálogo de Happier',
    catalogBody: 'Un catalog.json con plugins',
    submit: 'Añadir registro',
    cancel: 'Cancelar',
    organisation: 'Esto es una organización. Añade uno de sus repositorios.',
    unknownFormat:
      'Este enlace no es un repositorio Git, un marketplace de Claude, un registro MCP ni un registro ACP.',
    needsToken: ({ host }) =>
      `Este registro ha pedido un token. Solo se envía a ${host}.`,
    tokenRejected: 'Se ha rechazado ese token. Elige otro.',
    httpsRequired: 'Usa un enlace https://',
    credentialsInLink: 'Elimina el nombre de usuario y la contraseña de este enlace',
    unreachable: 'No se pudo acceder a este enlace. Revísalo y vuelve a intentarlo.',
    alreadyAdded: 'Ya está en tus registros',
    failed: 'No se pudo añadir este registro. Vuelve a intentarlo.',
  },
  detail: {
    builtInPurpose:
      'Integrado en Happier. Puedes desactivarlo, pero no quitarlo.',
    pluginPurpose: ({ plugin }) =>
      `Añadido por ${plugin}. Desaparece cuando lo hace el plugin.`,
    userPurpose: ({ kind }) =>
      `Un registro que has añadido, con ${esNouns.plural(kind)}. Happier solo lo lee; nada de lo que contiene se ejecuta.`,
    nameTitle: 'Nombre',
    nameBody: 'Cómo aparece en el menú de registros.',
    sourceTitle: 'Origen',
    refOn: ({ ref }) => `en ${ref}`,
    refresh: 'Actualizar',
    refreshNow: 'Actualizar ahora',
    checked: ({ time }) => `Comprobado ${time}`,
    notChecked: 'Se vuelve a leer cuando lo exploras',
    useTitle: 'Usar en Explorar',
    useBody: ({ kind }) =>
      `Desactívalo para dejar de listar ${esNouns.object(kind)} de este registro. Nada de lo que añadiste desde él cambia.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Habilidades de este registro en tu biblioteca'
        : `${cap(esNouns.plural(kind))} que añadiste desde él`,
    fromItRow: ({ ref }) =>
      `Fijado a ${ref} · si quitas el registro, se conserva`,
    fromItRowNoRef: 'Si quitas el registro, se conserva',
    remove: 'Quitar registro',
    removeConfirm: "Esto elimina el registro de Explorar. Todo lo que hayas añadido desde él permanece instalado o en tu biblioteca. Puedes volver a añadir el registro más adelante.",
    removeNote: () => 'Lo que añadiste desde él se queda en tu biblioteca.',
    removeFailed: 'No se pudo quitar este registro. Vuelve a intentarlo.',
    updateFailed: 'No se pudo guardar el cambio. Vuelve a intentarlo.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Para registros privados o un límite más alto. Solo se envía a ${host}.`,
    tokenSet: ({ name, host }) => `${name} · solo se envía a ${host}`,
    tokenGitHubHost: 'GitHub, para este repositorio',
    tokenAdd: 'Añadir token',
    tokenChange: 'Cambiar',
    tokenPickTitle: 'Elige un token',
    tokenAdded: 'Token guardado',
    tokenRemoved: 'Token eliminado',
    undo: 'Deshacer',
  },
};

const esSkillAdd: SkillAddTranslation = {
  title: 'Añadir una habilidad',
  modes: {
    browse: 'Explorar',
    link: 'Desde un enlace',
    upload: 'Subir',
    write: 'Escribir',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Buscar habilidades'
      : `Buscar entre ${compact(count, ',')} habilidades`,
  groupAll: 'En tus registros',
  groupPicks: 'Selección de Happier',
  groupSource: ({ source }) => `De ${source}`,
  noMatch: ({ query }) => `Ninguna habilidad coincide con «${query}»`,
  emptyTitle: 'Aún no hay habilidades que explorar',
  emptyBody:
    'Los registros que usas no listan ninguna habilidad por ahora. Añade un registro desde el menú de arriba o escribe una habilidad propia.',
  clear: 'Borrar',
  add: 'Añadir',
  inLibrary: 'En tu biblioteca',
  open: 'Abrir',
  addToLibrary: 'Añadir a la biblioteca',
  pinnedTo: ({ ref }) => `Fijada a ${ref}`,
  via: ({ source }) => `vía ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Hace referencia a un archivo que no se incluirá.' : `Hace referencia a ${count} archivos que no se incluirán.`,
  outsideReferencesMore: ({ count }) => `y ${count} más`,
  alsoAdds: ({ name }) => `También añade ${name}, a la que hace referencia`,
  detail: {
    whereTitle: 'Dónde está activada',
    whereBody:
      'En todas las máquinas y agentes, salvo que la limites ahora.',
    installsTitle: 'Qué instala',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Un script' : `${count} scripts`}. Al añadirla no se ejecuta nada; un agente puede ejecutarlos cuando use la habilidad, con los permisos de la sesión.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Un archivo' : `${count} archivos`} junto a sus instrucciones. Nada de eso se ejecuta.`,
    textOnlyBody: 'Solo instrucciones. Nada de eso se ejecuta.',
    tokensWhenUsed: ({ count }) => `Unos ${count} tokens al usarla`,
    alwaysOnBody: ({ count }) =>
      `${count} tokens en cada sesión para su descripción, para que los agentes sepan que está ahí.`,
    sourceBody: ({ source, ref }) =>
      `Encontrada en ${source} · fijada a ${ref} · los cambios esperan tu revisión`,
    nextTitle: 'Qué pasa después',
    next1: 'Se guarda en tu biblioteca, con cifrado de extremo a extremo.',
    next2:
      'La próxima sesión de cada máquina la recibe. Las sesiones en curso no cambian.',
    next3: 'Tus propias carpetas de habilidades no se tocan.',
    filesTitle: ({ count }) => (count === 1 ? 'Un archivo' : `${count} archivos`),
    problemTooLarge:
      'Es más grande de lo que puede ser una habilidad, así que no se puede añadir.',
    problemUnsupported:
      'Usa un enlace simbólico o un submódulo; Happier no puede añadirla de forma segura.',
    problemRemoved: 'Ya no está en su registro.',
    loading: 'Leyendo…',
    loadFailed: 'No se pudo leer esta habilidad. Vuelve a intentarlo.',
  },
  partial: {
    rules: 'Añadida · No se pudo definir dónde está activada',
    content: ({ names }) => names ? `No se pudo añadir ${names}. Se conservan las habilidades añadidas.` : 'No se pudieron terminar de añadir las habilidades. Se conservan las habilidades añadidas.',
    tryAgain: 'Reintentar',
    retrying: 'Definiendo dónde está activada…',
  },
  link: {
    title: 'Desde un enlace',
    body: 'Pega un repositorio o una carpeta de GitHub. Happier lista las habilidades que contiene, fijadas al commit actual.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Buscar habilidades',
    finding: 'Buscando habilidades…',
    found: ({ count }) =>
      count === 1
        ? 'Una habilidad en este repositorio'
        : `${count} habilidades en este repositorio`,
    none: 'No hay habilidades en este repositorio. Una habilidad es una carpeta con un SKILL.md.',
    invalid: 'Pega un enlace completo, que empiece por https://',
    failed: 'No se pudo leer este enlace. Revísalo y vuelve a intentarlo.',
    addSelected: ({ count }) =>
      count === 1 ? 'Añadir 1 habilidad' : `Añadir ${count} habilidades`,
    selectAll: 'Seleccionar todo',
    openOne: 'Abre uno para ver qué instala.',
    chooseWhich: 'Elige cuáles añadir',
  },
  upload: {
    title: 'Subir',
    body: 'Una carpeta de habilidad o un .zip con un SKILL.md dentro. Se lee aquí; no se ejecuta nada.',
    dropHere: 'Suelta aquí una carpeta o un .zip',
    chooseZip: 'Elegir un .zip',
    chooseFolder: 'Elegir una carpeta',
    neverRuns: 'Las subidas se revisan aquí y nunca se ejecutan.',
    reading: 'Leyendo…',
    invalidName: ({ file }) =>
      `«${file}» tiene un nombre que no se puede guardar en todas las máquinas. Cámbiale el nombre y vuelve a intentarlo.`,
    found: ({ count }) =>
      count === 1
        ? 'Una habilidad en esta subida'
        : `${count} habilidades en esta subida`,
    unreadable: ({ file }) => `No se pudo leer «${file}».`,
    noSkill: 'No hay ningún SKILL.md en lo que elegiste.',
    failed: 'No se pudo leer esta subida. Vuelve a intentarlo.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// French
// ---------------------------------------------------------------------------------------------------------------
const frNouns = pairNouns(
  {
    skill: ['skill', 'skills'],
    mcpServer: ['serveur MCP', 'serveurs MCP'],
    agent: ['agent', 'agents'],
    plugin: ['plugin', 'plugins'],
  },
  (count) => count < 2,
);

const fr: RegistriesTranslation = {
  status: { updatedEarlier: "Mis à jour précédemment" },
  select: {
    label: 'Registre',
    all: 'Tous les registres',
    addRegistry: 'Ajouter un registre…',
    manage: 'Gérer les registres',
  },
  format: {
    builtIn: 'Intégré',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace Claude',
    mcpRegistry: 'Registre MCP',
    acpRegistry: 'Registre ACP',
    happierCatalog: 'Catalogue Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Ajouté par ${plugin}`,
    off: 'Désactivé',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${frNouns.counted(kind, count)}`,
  view: {
    title: 'Registres',
    purpose: ({ kind }) =>
      `Les endroits où Parcourir cherche des ${frNouns.plural(kind)}.`,
    listLabel: 'Registres',
    newRow: 'Nouveau registre',
    newRowBody: 'Collez un lien pour commencer',
    empty: 'Ajoutez un registre',
  },
  add: {
    title: 'Ajouter un registre',
    purpose: ({ kind }) =>
      `Un endroit où parcourir des ${frNouns.plural(kind)}. Happier ne fait que le lire ; rien de ce qu’il contient ne s’exécute.`,
    link: 'Lien',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Vérification du lien…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${frNouns.counted(kind, count)}`,
    foundNoCount: 'Prêt à parcourir',
    name: 'Nom',
    whatYouCanAdd: 'Ce que vous pouvez ajouter',
    gitTitle: 'Un dépôt Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Tout dossier contenant un SKILL.md, par exemple github.com/anthropics/skills'
        : 'Un dépôt que Happier peut lire en HTTPS',
    marketplaceTitle: 'Un marketplace de plugins Claude',
    marketplaceBody:
      'Un marketplace.json ; Happier liste les skills de ses plugins',
    mcpRegistryTitle: 'Un registre MCP',
    mcpRegistryBody:
      'Le registre officiel ou un sous-registre qui sert /v0.1/servers',
    acpRegistryTitle: 'Un registre ACP',
    acpRegistryBody: 'Un registry.json listant des agents et leur installation',
    catalogTitle: 'Un catalogue Happier',
    catalogBody: 'Un catalog.json listant des plugins',
    submit: 'Ajouter le registre',
    cancel: 'Annuler',
    organisation:
      'Il s’agit d’une organisation. Ajoutez l’un de ses dépôts.',
    unknownFormat:
      'Ce lien n’est ni un dépôt Git, ni un marketplace Claude, ni un registre MCP, ni un registre ACP.',
    needsToken: ({ host }) =>
      `Ce registre demande un jeton. Il n’est envoyé qu’à ${host}.`,
    tokenRejected: 'Ce jeton a été refusé. Choisissez-en un autre.',
    httpsRequired: 'Utilisez un lien https://',
    credentialsInLink: 'Retirez le nom d’utilisateur et le mot de passe de ce lien',
    unreachable: 'Impossible de joindre ce lien. Vérifiez-le et réessayez.',
    alreadyAdded: 'Déjà dans vos registres',
    failed: 'Impossible d’ajouter ce registre. Réessayez.',
  },
  detail: {
    builtInPurpose:
      'Intégré à Happier. Vous pouvez le désactiver, mais pas le supprimer.',
    pluginPurpose: ({ plugin }) =>
      `Ajouté par ${plugin}. Il disparaît avec le plugin.`,
    userPurpose: ({ kind }) =>
      `Un registre que vous avez ajouté, avec des ${frNouns.plural(kind)}. Happier ne fait que le lire ; rien de ce qu’il contient ne s’exécute.`,
    nameTitle: 'Nom',
    nameBody: 'Son nom dans le menu des registres.',
    sourceTitle: 'Source',
    refOn: ({ ref }) => `sur ${ref}`,
    refresh: 'Actualiser',
    refreshNow: 'Actualiser maintenant',
    checked: ({ time }) => `Vérifié ${time}`,
    notChecked: 'Relu quand vous le parcourez',
    useTitle: 'Utiliser dans Parcourir',
    useBody: ({ kind }) =>
      `Désactivez-le pour ne plus lister ses ${frNouns.object(kind)}. Rien de ce que vous en avez ajouté ne change.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Skills qui en viennent, dans votre bibliothèque'
        : `${cap(frNouns.plural(kind))} que vous en avez ajoutés`,
    fromItRow: ({ ref }) =>
      `Épinglé sur ${ref} · reste en place si vous supprimez le registre`,
    fromItRowNoRef: 'Reste en place si vous supprimez le registre',
    remove: 'Supprimer le registre',
    removeConfirm: "Le registre sera retiré de Parcourir. Tout ce que vous y avez ajouté reste installé ou dans votre bibliothèque. Vous pourrez ajouter à nouveau le registre plus tard.",
    removeNote: ({ kind }) =>
      `Les ${frNouns.plural(kind)} que vous en avez ajoutés restent dans votre bibliothèque.`,
    removeFailed: 'Impossible de supprimer ce registre. Réessayez.',
    updateFailed: 'Impossible d’enregistrer la modification. Réessayez.',
    tokenTitle: 'Jeton',
    tokenNone: ({ host }) =>
      `Pour les registres privés, ou une limite plus élevée. Envoyé uniquement à ${host}.`,
    tokenSet: ({ name, host }) => `${name} · envoyé uniquement à ${host}`,
    tokenGitHubHost: 'GitHub, pour ce dépôt',
    tokenAdd: 'Ajouter un jeton',
    tokenChange: 'Changer',
    tokenPickTitle: 'Choisir un jeton',
    tokenAdded: 'Jeton enregistré',
    tokenRemoved: 'Jeton supprimé',
    undo: 'Annuler',
  },
};

const frSkillAdd: SkillAddTranslation = {
  title: 'Ajouter un skill',
  modes: {
    browse: 'Parcourir',
    link: 'Depuis un lien',
    upload: 'Importer',
    write: 'Écrire',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Rechercher des skills'
      : `Rechercher parmi ${compact(count, ',')} skills`,
  groupAll: 'Dans vos registres',
  groupPicks: 'Sélection Happier',
  groupSource: ({ source }) => `De ${source}`,
  noMatch: ({ query }) => `Aucun skill ne correspond à « ${query} »`,
  emptyTitle: 'Aucune skill à parcourir pour l’instant',
  emptyBody:
    'Les registres que vous utilisez ne listent aucune skill pour le moment. Ajoutez un registre depuis le menu ci-dessus ou écrivez votre propre skill.',
  clear: 'Effacer',
  add: 'Ajouter',
  inLibrary: 'Dans votre bibliothèque',
  open: 'Ouvrir',
  addToLibrary: 'Ajouter à la bibliothèque',
  pinnedTo: ({ ref }) => `Épinglé sur ${ref}`,
  via: ({ source }) => `via ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Renvoie à un fichier qui ne sera pas inclus.' : `Renvoie à ${count} fichiers qui ne seront pas inclus.`,
  outsideReferencesMore: ({ count }) => `et ${count} de plus`,
  alsoAdds: ({ name }) => `Ajoute aussi ${name}, auquel il fait référence`,
  detail: {
    whereTitle: 'Où il est activé',
    whereBody:
      'Sur toutes les machines et pour tous les agents, sauf si vous le limitez maintenant.',
    installsTitle: 'Ce qu’il installe',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Un script' : `${count} scripts`}. Rien ne s’exécute à l’ajout ; un agent peut les exécuter quand il utilise le skill, avec les autorisations de la session.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Un fichier' : `${count} fichiers`} à côté de ses instructions. Rien de tout cela ne s’exécute.`,
    textOnlyBody: 'Des instructions seulement. Rien ne s’exécute.',
    tokensWhenUsed: ({ count }) => `Environ ${count} tokens à l’utilisation`,
    alwaysOnBody: ({ count }) =>
      `${count} tokens dans chaque session pour sa description, afin que les agents sachent qu’il est là.`,
    sourceBody: ({ source, ref }) =>
      `Trouvé sur ${source} · épinglé sur ${ref} · les changements attendent votre validation`,
    nextTitle: 'Ensuite',
    next1: 'Il est enregistré dans votre bibliothèque, chiffré de bout en bout.',
    next2:
      'La prochaine session de chaque machine l’aura. Les sessions en cours ne changent pas.',
    next3: 'Vos propres dossiers de skills ne sont pas touchés.',
    filesTitle: ({ count }) => (count === 1 ? 'Un fichier' : `${count} fichiers`),
    problemTooLarge:
      'Plus volumineux qu’un skill ne peut l’être, il ne peut donc pas être ajouté.',
    problemUnsupported:
      'Utilise un lien symbolique ou un sous-module ; Happier ne peut pas l’ajouter en toute sécurité.',
    problemRemoved: 'N’est plus dans son registre.',
    loading: 'Lecture…',
    loadFailed: 'Impossible de lire ce skill. Réessayez.',
  },
  partial: {
    rules: 'Ajouté · Impossible de définir où il est activé',
    content: ({ names }) => names ? `Impossible d’ajouter ${names}. Les compétences ajoutées sont conservées.` : 'Impossible de terminer l’ajout des compétences. Les compétences ajoutées sont conservées.',
    tryAgain: 'Réessayer',
    retrying: 'Définition de l’endroit où il est activé…',
  },
  link: {
    title: 'Depuis un lien',
    body: 'Collez un dépôt ou un dossier GitHub. Happier en liste les skills, épinglés sur le commit actuel.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Trouver des skills',
    finding: 'Recherche de skills…',
    found: ({ count }) =>
      count === 1
        ? 'Un skill dans ce dépôt'
        : `${count} skills dans ce dépôt`,
    none: 'Aucun skill dans ce dépôt. Un skill est un dossier avec un SKILL.md.',
    invalid: 'Collez un lien complet, commençant par https://',
    failed: 'Impossible de lire ce lien. Vérifiez-le et réessayez.',
    addSelected: ({ count }) =>
      count === 1 ? 'Ajouter 1 skill' : `Ajouter ${count} skills`,
    selectAll: 'Tout sélectionner',
    openOne: 'Ouvrez-en un pour voir ce qu’il installe.',
    chooseWhich: 'Choisissez lesquels ajouter',
  },
  upload: {
    title: 'Importer',
    body: 'Un dossier de skill ou un .zip contenant un SKILL.md. Il est lu ici ; rien ne s’exécute.',
    dropHere: 'Déposez un dossier ou un .zip ici',
    chooseZip: 'Choisir un .zip',
    chooseFolder: 'Choisir un dossier',
    neverRuns: 'Les imports sont vérifiés ici et ne s’exécutent jamais.',
    reading: 'Lecture…',
    invalidName: ({ file }) =>
      `« ${file} » a un nom qui ne peut pas être enregistré sur toutes les machines. Renommez-le et réessayez.`,
    found: ({ count }) =>
      count === 1
        ? 'Un skill dans cet envoi'
        : `${count} skills dans cet envoi`,
    unreadable: ({ file }) => `Impossible de lire « ${file} ».`,
    noSkill: 'Aucun SKILL.md dans votre sélection.',
    failed: 'Impossible de lire cet import. Réessayez.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Italian
// ---------------------------------------------------------------------------------------------------------------
const itNouns = pairNouns({
  skill: ['skill', 'skill'],
  mcpServer: ['server MCP', 'server MCP'],
  agent: ['agente', 'agenti'],
  plugin: ['plugin', 'plugin'],
});

const it: RegistriesTranslation = {
  status: { updatedEarlier: "Aggiornato in precedenza" },
  select: {
    label: 'Registro',
    all: 'Tutti i registri',
    addRegistry: 'Aggiungi un registro…',
    manage: 'Gestisci i registri',
  },
  format: {
    builtIn: 'Integrato',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace di Claude',
    mcpRegistry: 'Registro MCP',
    acpRegistry: 'Registro ACP',
    happierCatalog: 'Catalogo Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Aggiunto da ${plugin}`,
    off: 'Disattivato',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${itNouns.counted(kind, count)}`,
  view: {
    title: 'Registri',
    purpose: ({ kind }) => `Dove Esplora cerca ${itNouns.plural(kind)}.`,
    listLabel: 'Registri',
    newRow: 'Nuovo registro',
    newRowBody: 'Incolla un link per iniziare',
    empty: 'Aggiungi un registro',
  },
  add: {
    title: 'Aggiungi un registro',
    purpose: ({ kind }) =>
      `Un posto da cui esplorare ${itNouns.plural(kind)}. Happier lo legge soltanto; nulla di ciò che contiene viene eseguito.`,
    link: 'Link',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Controllo del link…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${itNouns.counted(kind, count)}`,
    foundNoCount: 'Pronto da esplorare',
    name: 'Nome',
    whatYouCanAdd: 'Cosa puoi aggiungere',
    gitTitle: 'Un repository Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Qualsiasi cartella con un file SKILL.md, ad esempio github.com/anthropics/skills'
        : 'Un repository che Happier può leggere via HTTPS',
    marketplaceTitle: 'Un marketplace di plugin di Claude',
    marketplaceBody:
      'Un marketplace.json; Happier elenca le skill dei suoi plugin',
    mcpRegistryTitle: 'Un registro MCP',
    mcpRegistryBody:
      'Il registro ufficiale o un sotto-registro che serve /v0.1/servers',
    acpRegistryTitle: 'Un registro ACP',
    acpRegistryBody: 'Un registry.json che elenca gli agenti e come installarli',
    catalogTitle: 'Un catalogo Happier',
    catalogBody: 'Un catalog.json che elenca i plugin',
    submit: 'Aggiungi registro',
    cancel: 'Annulla',
    organisation: 'Questa è un’organizzazione. Aggiungi uno dei suoi repository.',
    unknownFormat:
      'Questo link non è un repository Git, un marketplace di Claude, un registro MCP né un registro ACP.',
    needsToken: ({ host }) =>
      `Questo registro ha richiesto un token. Viene inviato solo a ${host}.`,
    tokenRejected: 'Token rifiutato. Scegline un altro.',
    httpsRequired: 'Usa un link https://',
    credentialsInLink: 'Rimuovi il nome utente e la password da questo link',
    unreachable: 'Impossibile raggiungere questo link. Controllalo e riprova.',
    alreadyAdded: 'Già nei tuoi registri',
    failed: 'Impossibile aggiungere questo registro. Riprova.',
  },
  detail: {
    builtInPurpose:
      'Integrato in Happier. Puoi disattivarlo, ma non rimuoverlo.',
    pluginPurpose: ({ plugin }) =>
      `Aggiunto da ${plugin}. Sparisce insieme al plugin.`,
    userPurpose: ({ kind }) =>
      `Un registro che hai aggiunto, con ${itNouns.plural(kind)}. Happier lo legge soltanto; nulla di ciò che contiene viene eseguito.`,
    nameTitle: 'Nome',
    nameBody: 'Come appare nel menu dei registri.',
    sourceTitle: 'Sorgente',
    refOn: ({ ref }) => `su ${ref}`,
    refresh: 'Aggiorna',
    refreshNow: 'Aggiorna ora',
    checked: ({ time }) => `Controllato ${time}`,
    notChecked: 'Viene riletto quando lo esplori',
    useTitle: 'Usa in Esplora',
    useBody: ({ kind }) =>
      `Disattivalo per smettere di elencare ${itNouns.object(kind)} di questo registro. Nulla di ciò che hai già aggiunto cambia.`,
    fromItTitle: ({ kind }) =>
      `${cap(itNouns.plural(kind))} da questo registro nella tua libreria`,
    fromItRow: ({ ref }) =>
      `Bloccato su ${ref} · resta anche se rimuovi il registro`,
    fromItRowNoRef: 'Resta anche se rimuovi il registro',
    remove: 'Rimuovi registro',
    removeConfirm: "Il registro viene rimosso da Esplora. Tutto ciò che hai aggiunto da questo registro resta installato o nella tua libreria. Puoi aggiungere di nuovo il registro in seguito.",
    removeNote: () =>
      'Ciò che hai aggiunto da questo registro resta nella tua libreria.',
    removeFailed: 'Impossibile rimuovere questo registro. Riprova.',
    updateFailed: 'Impossibile salvare la modifica. Riprova.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Per registri privati o un limite più alto. Inviato solo a ${host}.`,
    tokenSet: ({ name, host }) => `${name} · inviato solo a ${host}`,
    tokenGitHubHost: 'GitHub, per questo repository',
    tokenAdd: 'Aggiungi token',
    tokenChange: 'Cambia',
    tokenPickTitle: 'Scegli un token',
    tokenAdded: 'Token salvato',
    tokenRemoved: 'Token rimosso',
    undo: 'Annulla',
  },
};

const itSkillAdd: SkillAddTranslation = {
  title: 'Aggiungi una skill',
  modes: {
    browse: 'Esplora',
    link: 'Da un link',
    upload: 'Carica',
    write: 'Scrivi',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Cerca skill'
      : `Cerca tra ${compact(count, ',')} skill`,
  groupAll: 'Nei tuoi registri',
  groupPicks: 'Scelte di Happier',
  groupSource: ({ source }) => `Da ${source}`,
  noMatch: ({ query }) => `Nessuna skill corrisponde a «${query}»`,
  emptyTitle: 'Ancora nessuna skill da esplorare',
  emptyBody:
    'I registri che usi non elencano alcuna skill al momento. Aggiungi un registro dal menu qui sopra oppure scrivi una skill tua.',
  clear: 'Cancella',
  add: 'Aggiungi',
  inLibrary: 'Nella tua libreria',
  open: 'Apri',
  addToLibrary: 'Aggiungi alla libreria',
  pinnedTo: ({ ref }) => `Bloccata su ${ref}`,
  via: ({ source }) => `tramite ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Rimanda a un file che non sarà incluso.' : `Rimanda a ${count} file che non saranno inclusi.`,
  outsideReferencesMore: ({ count }) => `e altri ${count}`,
  alsoAdds: ({ name }) => `Aggiunge anche ${name}, a cui rimanda`,
  detail: {
    whereTitle: 'Dove è attiva',
    whereBody:
      'Su ogni macchina e per ogni agente, a meno che tu non la limiti adesso.',
    installsTitle: 'Cosa installa',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Uno script' : `${count} script`}. Niente viene eseguito quando la aggiungi; un agente può eseguirli quando usa la skill, con i permessi della sessione.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Un file' : `${count} file`} accanto alle sue istruzioni. Niente di tutto questo viene eseguito.`,
    textOnlyBody: 'Solo istruzioni. Niente viene eseguito.',
    tokensWhenUsed: ({ count }) => `Circa ${count} token quando viene usata`,
    alwaysOnBody: ({ count }) =>
      `${count} token in ogni sessione per la sua descrizione, così gli agenti sanno che c’è.`,
    sourceBody: ({ source, ref }) =>
      `Trovata su ${source} · bloccata su ${ref} · le modifiche aspettano la tua revisione`,
    nextTitle: 'Cosa succede dopo',
    next1: 'Viene salvata nella tua libreria, con crittografia end-to-end.',
    next2:
      'La prossima sessione su ogni macchina la riceve. Le sessioni in corso non cambiano.',
    next3: 'Le tue cartelle di skill non vengono toccate.',
    filesTitle: ({ count }) => (count === 1 ? 'Un file' : `${count} file`),
    problemTooLarge:
      'Più grande di quanto una skill possa essere, quindi non si può aggiungere.',
    problemUnsupported:
      'Usa un collegamento simbolico o un sottomodulo; Happier non può aggiungerla in modo sicuro.',
    problemRemoved: 'Non è più nel suo registro.',
    loading: 'Lettura…',
    loadFailed: 'Impossibile leggere questa skill. Riprova.',
  },
  partial: {
    rules: 'Aggiunta · Impossibile impostare dove è attiva',
    content: ({ names }) => names ? `Impossibile aggiungere ${names}. Le competenze aggiunte vengono conservate.` : 'Impossibile completare l’aggiunta delle competenze. Le competenze aggiunte vengono conservate.',
    tryAgain: 'Riprova',
    retrying: 'Imposto dove è attiva…',
  },
  link: {
    title: 'Da un link',
    body: 'Incolla un repository o una cartella GitHub. Happier ne elenca le skill, bloccate sul commit corrente.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Trova skill',
    finding: 'Cerco le skill…',
    found: ({ count }) =>
      count === 1
        ? 'Una skill in questo repository'
        : `${count} skill in questo repository`,
    none: 'Nessuna skill in questo repository. Una skill è una cartella con un file SKILL.md.',
    invalid: 'Incolla un link completo, che inizi con https://',
    failed: 'Impossibile leggere questo link. Controllalo e riprova.',
    addSelected: ({ count }) =>
      count === 1 ? 'Aggiungi 1 skill' : `Aggiungi ${count} skill`,
    selectAll: 'Seleziona tutto',
    openOne: 'Aprine uno per vedere cosa installa.',
    chooseWhich: 'Scegli quali aggiungere',
  },
  upload: {
    title: 'Carica',
    body: 'Una cartella di skill o uno .zip con dentro un file SKILL.md. Viene letto qui; non viene eseguito nulla.',
    dropHere: 'Trascina qui una cartella o uno .zip',
    chooseZip: 'Scegli uno .zip',
    chooseFolder: 'Scegli una cartella',
    neverRuns: 'I caricamenti vengono controllati qui e non vengono mai eseguiti.',
    reading: 'Lettura…',
    invalidName: ({ file }) =>
      `«${file}» ha un nome che non può essere salvato su ogni macchina. Rinominalo e riprova.`,
    found: ({ count }) =>
      count === 1
        ? 'Una skill in questo caricamento'
        : `${count} skill in questo caricamento`,
    unreadable: ({ file }) => `Impossibile leggere «${file}».`,
    noSkill: 'Nessun file SKILL.md in ciò che hai scelto.',
    failed: 'Impossibile leggere questo caricamento. Riprova.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Japanese
// ---------------------------------------------------------------------------------------------------------------
const jaNouns = bareNouns({
  skill: 'スキル',
  mcpServer: 'MCP サーバー',
  agent: 'エージェント',
  plugin: 'プラグイン',
});

const ja: RegistriesTranslation = {
  status: { updatedEarlier: "以前の更新内容" },
  select: {
    label: 'レジストリ',
    all: 'すべてのレジストリ',
    addRegistry: 'レジストリを追加…',
    manage: 'レジストリを管理',
  },
  format: {
    builtIn: '内蔵',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Claude マーケットプレイス',
    mcpRegistry: 'MCP レジストリ',
    acpRegistry: 'ACP レジストリ',
    happierCatalog: 'Happier カタログ',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `${plugin} が追加`,
    off: 'オフ',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count)} 件の${jaNouns.counted(kind, count)}`,
  view: {
    title: 'レジストリ',
    purpose: ({ kind }) =>
      `「探す」が${jaNouns.plural(kind)}を探す場所です。`,
    listLabel: 'レジストリ',
    newRow: '新しいレジストリ',
    newRowBody: 'リンクを貼り付けて始めます',
    empty: 'レジストリを追加',
  },
  add: {
    title: 'レジストリを追加',
    purpose: ({ kind }) =>
      `${jaNouns.plural(kind)}を探す元になる場所です。Happier は読み取るだけで、中身は何も実行しません。`,
    link: 'リンク',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'リンクを確認中…',
    found: ({ kind, count }) =>
      `${compact(count)} 件の${jaNouns.counted(kind, count)}`,
    foundNoCount: '探す準備ができました',
    name: '名前',
    whatYouCanAdd: '追加できるもの',
    gitTitle: 'Git リポジトリ',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'SKILL.md があるフォルダーならどれでも。例: github.com/anthropics/skills'
        : 'Happier が HTTPS で読み取れるリポジトリ',
    marketplaceTitle: 'Claude プラグインのマーケットプレイス',
    marketplaceBody:
      'marketplace.json。Happier がプラグイン内のスキルを一覧にします',
    mcpRegistryTitle: 'MCP レジストリ',
    mcpRegistryBody:
      '公式レジストリ、または /v0.1/servers を提供するサブレジストリ',
    acpRegistryTitle: 'ACP レジストリ',
    acpRegistryBody:
      'エージェントとそのインストール方法を一覧にした registry.json',
    catalogTitle: 'Happier カタログ',
    catalogBody: 'プラグインを一覧にした catalog.json',
    submit: 'レジストリを追加',
    cancel: 'キャンセル',
    organisation: 'これは組織です。その中のリポジトリを追加してください。',
    unknownFormat:
      'このリンクは、Git リポジトリ、Claude マーケットプレイス、MCP レジストリ、ACP レジストリのいずれでもありません。',
    needsToken: ({ host }) =>
      `このレジストリにはトークンが必要です。${host} にのみ送信されます。`,
    tokenRejected: 'このトークンは拒否されました。別のトークンを選んでください。',
    httpsRequired: 'https:// のリンクを使用してください',
    credentialsInLink: 'このリンクからユーザー名とパスワードを削除してください',
    unreachable:
      'このリンクに接続できませんでした。確認してからもう一度お試しください。',
    alreadyAdded: 'すでにレジストリにあります',
    failed: 'このレジストリを追加できませんでした。もう一度お試しください。',
  },
  detail: {
    builtInPurpose: 'Happier に内蔵されています。オフにできますが、削除はできません。',
    pluginPurpose: ({ plugin }) =>
      `${plugin} が追加しました。プラグインとともになくなります。`,
    userPurpose: ({ kind }) =>
      `追加したレジストリで、${jaNouns.plural(kind)}が入っています。Happier は読み取るだけで、中身は何も実行しません。`,
    nameTitle: '名前',
    nameBody: 'レジストリのメニューでの表示名です。',
    sourceTitle: 'ソース',
    refOn: ({ ref }) => `${ref} を参照`,
    refresh: '更新',
    refreshNow: '今すぐ更新',
    checked: ({ time }) => `${time} に確認`,
    notChecked: '探すときに読み直します',
    useTitle: '「探す」で使う',
    useBody: ({ kind }) =>
      `オフにすると、このレジストリの${jaNouns.object(kind)}が一覧に出なくなります。すでに追加したものは変わりません。`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'このレジストリ由来でライブラリにあるスキル'
        : `このレジストリから追加した${jaNouns.plural(kind)}`,
    fromItRow: ({ ref }) => `${ref} に固定 · レジストリを削除しても残ります`,
    fromItRowNoRef: 'レジストリを削除しても残ります',
    remove: 'レジストリを削除',
    removeConfirm: "このレジストリを「探す」から削除します。ここから追加したものはインストール済みのまま、またはライブラリに残ります。レジストリは後で再度追加できます。",
    removeNote: ({ kind }) =>
      `このレジストリから追加した${jaNouns.plural(kind)}は、ライブラリに残ります。`,
    removeFailed: 'このレジストリを削除できませんでした。もう一度お試しください。',
    updateFailed: '変更を保存できませんでした。もう一度お試しください。',
    tokenTitle: 'トークン',
    tokenNone: ({ host }) =>
      `プライベートなレジストリや、上限を引き上げるときに使います。${host} にのみ送信されます。`,
    tokenSet: ({ name, host }) => `${name} · ${host} にのみ送信`,
    tokenGitHubHost: 'GitHub（このリポジトリ用）',
    tokenAdd: 'トークンを追加',
    tokenChange: '変更',
    tokenPickTitle: 'トークンを選択',
    tokenAdded: 'トークンを保存しました',
    tokenRemoved: 'トークンを削除しました',
    undo: '元に戻す',
  },
};

const jaSkillAdd: SkillAddTranslation = {
  title: 'スキルを追加',
  modes: {
    browse: '探す',
    link: 'リンクから',
    upload: 'アップロード',
    write: '書く',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'スキルを検索'
      : `${compact(count)} 件のスキルを検索`,
  groupAll: 'レジストリ内',
  groupPicks: 'Happier のおすすめ',
  groupSource: ({ source }) => `${source} から`,
  noMatch: ({ query }) => `「${query}」に一致するスキルはありません`,
  emptyTitle: '探せるスキルはまだありません',
  emptyBody:
    '使用中のレジストリには、今のところスキルがありません。上のメニューからレジストリを追加するか、自分でスキルを書いてみましょう。',
  clear: 'クリア',
  add: '追加',
  inLibrary: 'ライブラリにあります',
  open: '開く',
  addToLibrary: 'ライブラリに追加',
  pinnedTo: ({ ref }) => `${ref} に固定`,
  via: ({ source }) => `${source} 経由`,
  outsideReferences: ({ count }) =>
    `含まれない ${count} 件のファイルを参照しています。`,
  outsideReferencesMore: ({ count }) => `ほか ${count} 件`,
  alsoAdds: ({ name }) => `参照先の ${name} も追加します`,
  detail: {
    whereTitle: 'オンになっている場所',
    whereBody:
      'いまここで絞り込まない限り、すべてのマシンとエージェントでオンになります。',
    installsTitle: 'インストールされるもの',
    runsScriptsBody: ({ count }) =>
      `スクリプト ${count} 件。追加しても何も実行されません。エージェントがスキルを使うときに、セッションの権限でスクリプトを実行することがあります。`,
    hasFilesBody: ({ count }) =>
      `手順書のほかにファイルが ${count} 件あります。中身は実行されません。`,
    textOnlyBody: '手順のみです。何も実行されません。',
    tokensWhenUsed: ({ count }) => `使用時に約 ${count} トークン`,
    alwaysOnBody: ({ count }) =>
      `エージェントが存在を把握できるよう、説明文として毎回のセッションで ${count} トークンを使います。`,
    sourceBody: ({ source, ref }) =>
      `${source} で見つかりました · ${ref} に固定 · 変更は確認するまで保留されます`,
    nextTitle: 'このあとの流れ',
    next1: 'エンドツーエンド暗号化で、ライブラリに保存されます。',
    next2:
      '各マシンの次のセッションから使えます。実行中のセッションは変わりません。',
    next3: 'ご自身のスキルフォルダーには触れません。',
    filesTitle: ({ count }) => `ファイル ${count} 件`,
    problemTooLarge:
      'スキルとして扱えるサイズを超えているため、追加できません。',
    problemUnsupported:
      'シンボリックリンクまたはサブモジュールを使っているため、Happier では安全に追加できません。',
    problemRemoved: 'レジストリからなくなりました。',
    loading: '読み込み中…',
    loadFailed: 'このスキルを読み込めませんでした。もう一度お試しください。',
  },
  partial: {
    rules: '追加しました · オンにする場所を設定できませんでした',
    content: ({ names }) => names ? `${names} を追加できませんでした。追加済みのスキルは保持されます。` : 'スキルの追加を完了できませんでした。追加済みのスキルは保持されます。',
    tryAgain: 'もう一度試す',
    retrying: 'オンにする場所を設定中…',
  },
  link: {
    title: 'リンクから',
    body: 'GitHub のリポジトリまたはフォルダーを貼り付けてください。Happier がその中のスキルを一覧にし、現在のコミットに固定します。',
    placeholder: 'https://github.com/owner/repository',
    find: 'スキルを探す',
    finding: 'スキルを探しています…',
    found: ({ count }) => `このリポジトリにスキルが ${count} 件あります`,
    none: 'このリポジトリにスキルはありません。スキルは SKILL.md を含むフォルダーです。',
    invalid: 'https:// で始まる完全なリンクを貼り付けてください',
    failed:
      'このリンクを読み込めませんでした。確認してからもう一度お試しください。',
    addSelected: ({ count }) => `スキルを ${count} 件追加`,
    selectAll: 'すべて選択',
    openOne: '開くと、インストールされる内容を確認できます。',
    chooseWhich: '追加するものを選択',
  },
  upload: {
    title: 'アップロード',
    body: 'SKILL.md を含むスキルのフォルダーまたは .zip です。ここで読み取るだけで、何も実行しません。',
    dropHere: 'フォルダーまたは .zip をここにドロップ',
    chooseZip: '.zip を選択',
    chooseFolder: 'フォルダーを選択',
    neverRuns: 'アップロードはここで確認され、実行されることはありません。',
    reading: '読み込み中…',
    invalidName: ({ file }) =>
      `「${file}」はすべてのマシンで保存できない名前です。名前を変えてからもう一度お試しください。`,
    found: ({ count }) =>
      `このアップロードにスキルが ${count} 件あります`,
    unreadable: ({ file }) => `「${file}」を読み込めませんでした。`,
    noSkill: '選択した内容に SKILL.md がありません。',
    failed: 'このアップロードを読み込めませんでした。もう一度お試しください。',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Polish
// ---------------------------------------------------------------------------------------------------------------
const plNouns = slavicNouns(
  {
    skill: {
      one: 'umiejętność',
      few: 'umiejętności',
      many: 'umiejętności',
      plural: 'umiejętności',
      object: 'umiejętności',
    },
    mcpServer: {
      one: 'serwer MCP',
      few: 'serwery MCP',
      many: 'serwerów MCP',
      plural: 'serwery MCP',
      object: 'serwery MCP',
    },
    agent: {
      one: 'agent',
      few: 'agenci',
      many: 'agentów',
      plural: 'agenci',
      object: 'agentów',
    },
    plugin: {
      one: 'wtyczka',
      few: 'wtyczki',
      many: 'wtyczek',
      plural: 'wtyczki',
      object: 'wtyczki',
    },
  },
  polishForm,
);

const pl: RegistriesTranslation = {
  status: { updatedEarlier: "Zaktualizowano wcześniej" },
  select: {
    label: 'Rejestr',
    all: 'Wszystkie rejestry',
    addRegistry: 'Dodaj rejestr…',
    manage: 'Zarządzaj rejestrami',
  },
  format: {
    builtIn: 'Wbudowany',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace Claude',
    mcpRegistry: 'Rejestr MCP',
    acpRegistry: 'Rejestr ACP',
    happierCatalog: 'Katalog Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Dodane przez ${plugin}`,
    off: 'Wyłączony',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${plNouns.counted(kind, count)}`,
  view: {
    title: 'Rejestry',
    purpose: ({ kind }) =>
      `Skąd w Przeglądaj pochodzą ${plNouns.plural(kind)}.`,
    listLabel: 'Rejestry',
    newRow: 'Nowy rejestr',
    newRowBody: 'Wklej link, aby zacząć',
    empty: 'Dodaj rejestr',
  },
  add: {
    title: 'Dodaj rejestr',
    purpose: ({ kind }) =>
      `Miejsce, z którego w Przeglądaj pochodzą ${plNouns.plural(kind)}. Happier tylko je czyta; nic z jego zawartości się nie uruchamia.`,
    link: 'Link',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Sprawdzanie linku…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${plNouns.counted(kind, count)}`,
    foundNoCount: 'Gotowe do przeglądania',
    name: 'Nazwa',
    whatYouCanAdd: 'Co możesz dodać',
    gitTitle: 'Repozytorium Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Dowolny folder z plikiem SKILL.md, na przykład github.com/anthropics/skills'
        : 'Repozytorium, które Happier może odczytać przez HTTPS',
    marketplaceTitle: 'Marketplace wtyczek Claude',
    marketplaceBody:
      'Plik marketplace.json; Happier wypisuje umiejętności z jego wtyczek',
    mcpRegistryTitle: 'Rejestr MCP',
    mcpRegistryBody:
      'Oficjalny rejestr lub podrejestr udostępniający /v0.1/servers',
    acpRegistryTitle: 'Rejestr ACP',
    acpRegistryBody:
      'Plik registry.json z listą agentów i sposobem ich instalacji',
    catalogTitle: 'Katalog Happier',
    catalogBody: 'Plik catalog.json z listą wtyczek',
    submit: 'Dodaj rejestr',
    cancel: 'Anuluj',
    organisation: 'To organizacja. Dodaj jedno z jej repozytoriów.',
    unknownFormat:
      'Ten link nie jest repozytorium Git, marketplace’em Claude, rejestrem MCP ani rejestrem ACP.',
    needsToken: ({ host }) =>
      `Ten rejestr wymaga tokenu. Zostanie wysłany tylko do ${host}.`,
    tokenRejected: 'Ten token został odrzucony. Wybierz inny.',
    httpsRequired: 'Użyj linku https://',
    credentialsInLink: 'Usuń nazwę użytkownika i hasło z tego linku',
    unreachable:
      'Nie można połączyć się z tym linkiem. Sprawdź go i spróbuj ponownie.',
    alreadyAdded: 'Już w Twoich rejestrach',
    failed: 'Nie udało się dodać tego rejestru. Spróbuj ponownie.',
  },
  detail: {
    builtInPurpose: 'Wbudowany w Happier. Możesz go wyłączyć, ale nie usunąć.',
    pluginPurpose: ({ plugin }) =>
      `Dodany przez ${plugin}. Znika razem z wtyczką.`,
    userPurpose: ({ kind }) =>
      `Dodany przez Ciebie rejestr (${plNouns.plural(kind)}). Happier tylko go czyta; nic z jego zawartości się nie uruchamia.`,
    nameTitle: 'Nazwa',
    nameBody: 'Tak wygląda w menu rejestrów.',
    sourceTitle: 'Źródło',
    refOn: ({ ref }) => `na ${ref}`,
    refresh: 'Odśwież',
    refreshNow: 'Odśwież teraz',
    checked: ({ time }) => `Sprawdzono ${time}`,
    notChecked: 'Odczytywany ponownie przy przeglądaniu',
    useTitle: 'Używaj w Przeglądaj',
    useBody: ({ kind }) =>
      `Wyłącz, aby przestać wyświetlać ${plNouns.object(kind)} z tego rejestru. Nic z tego, co już dodano, się nie zmieni.`,
    fromItTitle: ({ kind }) =>
      `${cap(plNouns.plural(kind))} z tego rejestru w Twojej bibliotece`,
    fromItRow: ({ ref }) =>
      `Przypięte do ${ref} · zostaje po usunięciu rejestru`,
    fromItRowNoRef: 'Zostaje po usunięciu rejestru',
    remove: 'Usuń rejestr',
    removeConfirm: "Rejestr zostanie usunięty z Przeglądaj. Wszystko, co z niego dodano, pozostanie zainstalowane lub w bibliotece. Rejestr możesz dodać ponownie później.",
    removeNote: ({ kind }) =>
      `${cap(plNouns.plural(kind))} z tego rejestru zostają w Twojej bibliotece.`,
    removeFailed: 'Nie udało się usunąć tego rejestru. Spróbuj ponownie.',
    updateFailed: 'Nie udało się zapisać zmiany. Spróbuj ponownie.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Dla prywatnych rejestrów lub wyższego limitu. Wysyłany tylko do ${host}.`,
    tokenSet: ({ name, host }) => `${name} · wysyłany tylko do ${host}`,
    tokenGitHubHost: 'GitHub, dla tego repozytorium',
    tokenAdd: 'Dodaj token',
    tokenChange: 'Zmień',
    tokenPickTitle: 'Wybierz token',
    tokenAdded: 'Token zapisany',
    tokenRemoved: 'Token usunięty',
    undo: 'Cofnij',
  },
};

const plSkillAdd: SkillAddTranslation = {
  title: 'Dodaj umiejętność',
  modes: {
    browse: 'Przeglądaj',
    link: 'Z linku',
    upload: 'Prześlij',
    write: 'Napisz',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Szukaj umiejętności'
      : `Szukaj wśród ${compact(count, ',')} umiejętności`,
  groupAll: 'W Twoich rejestrach',
  groupPicks: 'Wybór Happier',
  groupSource: ({ source }) => `Z ${source}`,
  noMatch: ({ query }) => `Żadna umiejętność nie pasuje do „${query}”`,
  emptyTitle: 'Nie ma jeszcze umiejętności do przeglądania',
  emptyBody:
    'Używane rejestry nie zawierają teraz żadnych umiejętności. Dodaj rejestr z menu powyżej albo napisz własną umiejętność.',
  clear: 'Wyczyść',
  add: 'Dodaj',
  inLibrary: 'W Twojej bibliotece',
  open: 'Otwórz',
  addToLibrary: 'Dodaj do biblioteki',
  pinnedTo: ({ ref }) => `Przypięta do ${ref}`,
  via: ({ source }) => `przez ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Odwołuje się do jednego pliku, który nie zostanie dołączony.' : `Odwołuje się do ${count} plików, które nie zostaną dołączone.`,
  outsideReferencesMore: ({ count }) => `i ${count} więcej`,
  alsoAdds: ({ name }) => `Dodaje też ${name}, do którego się odwołuje`,
  detail: {
    whereTitle: 'Gdzie jest włączona',
    whereBody:
      'Na każdej maszynie i u każdego agenta, chyba że zawęzisz to teraz.',
    installsTitle: 'Co instaluje',
    runsScriptsBody: ({ count }) =>
      `${pickForm(polishForm(count), { one: 'Jeden skrypt', few: `${count} skrypty`, many: `${count} skryptów` })}. Po dodaniu nic się nie uruchamia; agent może je uruchomić, gdy użyje umiejętności, z uprawnieniami sesji.`,
    hasFilesBody: ({ count }) =>
      `${pickForm(polishForm(count), { one: 'Jeden plik', few: `${count} pliki`, many: `${count} plików` })} obok instrukcji. Nic z tego się nie uruchamia.`,
    textOnlyBody: 'Same instrukcje. Nic się nie uruchamia.',
    tokensWhenUsed: ({ count }) => `Około ${count} tokenów przy użyciu`,
    alwaysOnBody: ({ count }) =>
      `${count} tokenów w każdej sesji na jej opis, by agenci wiedzieli, że tu jest.`,
    sourceBody: ({ source, ref }) =>
      `Znaleziona na ${source} · przypięta do ${ref} · zmiany czekają na Twoją weryfikację`,
    nextTitle: 'Co dalej',
    next1: 'Zapisuje się w Twojej bibliotece z szyfrowaniem end-to-end.',
    next2:
      'Najbliższa sesja na każdej maszynie ją dostanie. Trwające sesje się nie zmieniają.',
    next3: 'Twoje własne foldery z umiejętnościami pozostają nietknięte.',
    filesTitle: ({ count }) =>
      pickForm(polishForm(count), {
        one: 'Jeden plik',
        few: `${count} pliki`,
        many: `${count} plików`,
      }),
    problemTooLarge:
      'Większa, niż umiejętność może być, więc nie można jej dodać.',
    problemUnsupported:
      'Używa dowiązania symbolicznego lub podmodułu; Happier nie może jej bezpiecznie dodać.',
    problemRemoved: 'Nie ma jej już w swoim rejestrze.',
    loading: 'Odczytywanie…',
    loadFailed: 'Nie udało się odczytać tej umiejętności. Spróbuj ponownie.',
  },
  partial: {
    rules: 'Dodana · Nie udało się ustawić, gdzie jest włączona',
    content: ({ names }) => names ? `Nie udało się dodać ${names}. Dodane umiejętności są zachowane.` : 'Nie udało się dokończyć dodawania umiejętności. Dodane umiejętności są zachowane.',
    tryAgain: 'Spróbuj ponownie',
    retrying: 'Ustawianie, gdzie jest włączona…',
  },
  link: {
    title: 'Z linku',
    body: 'Wklej repozytorium lub folder z GitHub. Happier wypisze umiejętności w nim, przypięte do bieżącego commita.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Znajdź umiejętności',
    finding: 'Szukanie umiejętności…',
    found: ({ count }) =>
      count === 1
        ? 'Jedna umiejętność w tym repozytorium'
        : `${count} umiejętności w tym repozytorium`,
    none: 'Brak umiejętności w tym repozytorium. Umiejętność to folder z plikiem SKILL.md.',
    invalid: 'Wklej pełny link zaczynający się od https://',
    failed: 'Nie udało się odczytać tego linku. Sprawdź go i spróbuj ponownie.',
    addSelected: ({ count }) =>
      count === 1 ? 'Dodaj 1 umiejętność' : `Dodaj ${count} umiejętności`,
    selectAll: 'Zaznacz wszystko',
    openOne: 'Otwórz jeden, aby zobaczyć, co instaluje.',
    chooseWhich: 'Wybierz, co dodać',
  },
  upload: {
    title: 'Prześlij',
    body: 'Folder umiejętności lub plik .zip z plikiem SKILL.md w środku. Jest odczytywany tutaj; nic się nie uruchamia.',
    dropHere: 'Upuść tu folder lub plik .zip',
    chooseZip: 'Wybierz plik .zip',
    chooseFolder: 'Wybierz folder',
    neverRuns: 'Przesłane pliki są sprawdzane tutaj i nigdy nie są uruchamiane.',
    reading: 'Odczytywanie…',
    invalidName: ({ file }) =>
      `„${file}” ma nazwę, której nie da się zapisać na każdej maszynie. Zmień ją i spróbuj ponownie.`,
    found: ({ count }) =>
      count === 1
        ? 'Jedna umiejętność w tym przesłanym pliku'
        : `${count} umiejętności w tym przesłanym pliku`,
    unreadable: ({ file }) => `Nie udało się odczytać „${file}”.`,
    noSkill: 'W tym, co wybrano, nie ma pliku SKILL.md.',
    failed: 'Nie udało się odczytać tego przesłania. Spróbuj ponownie.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Portuguese (Brazil)
// ---------------------------------------------------------------------------------------------------------------
const ptNouns = pairNouns({
  skill: ['habilidade', 'habilidades'],
  mcpServer: ['servidor MCP', 'servidores MCP'],
  agent: ['agente', 'agentes'],
  plugin: ['plugin', 'plugins'],
});

const pt: RegistriesTranslation = {
  status: { updatedEarlier: "Atualizado anteriormente" },
  select: {
    label: 'Registro',
    all: 'Todos os registros',
    addRegistry: 'Adicionar um registro…',
    manage: 'Gerenciar registros',
  },
  format: {
    builtIn: 'Integrado',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Marketplace do Claude',
    mcpRegistry: 'Registro MCP',
    acpRegistry: 'Registro ACP',
    happierCatalog: 'Catálogo do Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Adicionado por ${plugin}`,
    off: 'Desativado',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${ptNouns.counted(kind, count)}`,
  view: {
    title: 'Registros',
    purpose: ({ kind }) =>
      `Os lugares onde Explorar procura ${ptNouns.plural(kind)}.`,
    listLabel: 'Registros',
    newRow: 'Novo registro',
    newRowBody: 'Cole um link para começar',
    empty: 'Adicione um registro',
  },
  add: {
    title: 'Adicionar um registro',
    purpose: ({ kind }) =>
      `Um lugar de onde explorar ${ptNouns.plural(kind)}. O Happier só o lê; nada do que ele contém é executado.`,
    link: 'Link',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Verificando o link…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${ptNouns.counted(kind, count)}`,
    foundNoCount: 'Pronto para explorar',
    name: 'Nome',
    whatYouCanAdd: 'O que você pode adicionar',
    gitTitle: 'Um repositório Git',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Qualquer pasta com um SKILL.md, por exemplo github.com/anthropics/skills'
        : 'Um repositório que o Happier consiga ler por HTTPS',
    marketplaceTitle: 'Um marketplace de plugins do Claude',
    marketplaceBody:
      'Um marketplace.json; o Happier lista as habilidades dos plugins dele',
    mcpRegistryTitle: 'Um registro MCP',
    mcpRegistryBody:
      'O registro oficial ou um sub-registro que sirva /v0.1/servers',
    acpRegistryTitle: 'Um registro ACP',
    acpRegistryBody: 'Um registry.json com agentes e como instalá-los',
    catalogTitle: 'Um catálogo do Happier',
    catalogBody: 'Um catalog.json com plugins',
    submit: 'Adicionar registro',
    cancel: 'Cancelar',
    organisation: 'Isto é uma organização. Adicione um dos repositórios dela.',
    unknownFormat:
      'Este link não é um repositório Git, um marketplace do Claude, um registro MCP nem um registro ACP.',
    needsToken: ({ host }) =>
      `Este registro pediu um token. Ele é enviado só para ${host}.`,
    tokenRejected: 'Esse token foi recusado. Escolha outro.',
    httpsRequired: 'Use um link https://',
    credentialsInLink: 'Remova o nome de usuário e a senha deste link',
    unreachable: 'Não foi possível acessar este link. Confira-o e tente de novo.',
    alreadyAdded: 'Já está nos seus registros',
    failed: 'Não foi possível adicionar este registro. Tente de novo.',
  },
  detail: {
    builtInPurpose:
      'Integrado ao Happier. Você pode desativá-lo, mas não removê-lo.',
    pluginPurpose: ({ plugin }) =>
      `Adicionado por ${plugin}. Some junto com o plugin.`,
    userPurpose: ({ kind }) =>
      `Um registro que você adicionou, com ${ptNouns.plural(kind)}. O Happier só o lê; nada do que ele contém é executado.`,
    nameTitle: 'Nome',
    nameBody: 'Como aparece no menu de registros.',
    sourceTitle: 'Origem',
    refOn: ({ ref }) => `em ${ref}`,
    refresh: 'Atualizar',
    refreshNow: 'Atualizar agora',
    checked: ({ time }) => `Verificado ${time}`,
    notChecked: 'É lido de novo quando você o explora',
    useTitle: 'Usar em Explorar',
    useBody: ({ kind }) =>
      `Desative para parar de listar ${ptNouns.object(kind)} deste registro. Nada do que você já adicionou muda.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Habilidades deste registro na sua biblioteca'
        : `${cap(ptNouns.plural(kind))} que você adicionou dele`,
    fromItRow: ({ ref }) =>
      `Fixado em ${ref} · continua se você remover o registro`,
    fromItRowNoRef: 'Continua se você remover o registro',
    remove: 'Remover registro',
    removeConfirm: "Isto remove o registro de Explorar. Tudo o que adicionou a partir dele continua instalado ou na sua biblioteca. Pode adicionar o registro novamente mais tarde.",
    removeNote: () => 'O que você adicionou dele fica na sua biblioteca.',
    removeFailed: 'Não foi possível remover este registro. Tente de novo.',
    updateFailed: 'Não foi possível salvar a alteração. Tente de novo.',
    tokenTitle: 'Token',
    tokenNone: ({ host }) =>
      `Para registros privados ou um limite maior. Enviado só para ${host}.`,
    tokenSet: ({ name, host }) => `${name} · enviado só para ${host}`,
    tokenGitHubHost: 'GitHub, para este repositório',
    tokenAdd: 'Adicionar token',
    tokenChange: 'Alterar',
    tokenPickTitle: 'Escolha um token',
    tokenAdded: 'Token salvo',
    tokenRemoved: 'Token removido',
    undo: 'Desfazer',
  },
};

const ptSkillAdd: SkillAddTranslation = {
  title: 'Adicionar uma habilidade',
  modes: {
    browse: 'Explorar',
    link: 'De um link',
    upload: 'Enviar',
    write: 'Escrever',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Pesquisar habilidades'
      : `Pesquisar ${compact(count, ',')} habilidades`,
  groupAll: 'Nos seus registros',
  groupPicks: 'Seleção do Happier',
  groupSource: ({ source }) => `De ${source}`,
  noMatch: ({ query }) => `Nenhuma habilidade corresponde a “${query}”`,
  emptyTitle: 'Ainda não há habilidades para explorar',
  emptyBody:
    'Os registos que você usa não listam nenhuma habilidade neste momento. Adicione um registo no menu acima ou escreva uma habilidade sua.',
  clear: 'Limpar',
  add: 'Adicionar',
  inLibrary: 'Na sua biblioteca',
  open: 'Abrir',
  addToLibrary: 'Adicionar à biblioteca',
  pinnedTo: ({ ref }) => `Fixada em ${ref}`,
  via: ({ source }) => `via ${source}`,
  outsideReferences: ({ count }) =>
    count === 1 ? 'Faz referência a um arquivo que não será incluído.' : `Faz referência a ${count} arquivos que não serão incluídos.`,
  outsideReferencesMore: ({ count }) => `e mais ${count}`,
  alsoAdds: ({ name }) => `Também adiciona ${name}, a que faz referência`,
  detail: {
    whereTitle: 'Onde está ativada',
    whereBody:
      'Em todas as máquinas e agentes, a menos que você restrinja agora.',
    installsTitle: 'O que ela instala',
    runsScriptsBody: ({ count }) =>
      `${count === 1 ? 'Um script' : `${count} scripts`}. Nada é executado ao adicionar; um agente pode executá-los quando usar a habilidade, com as permissões da sessão.`,
    hasFilesBody: ({ count }) =>
      `${count === 1 ? 'Um arquivo' : `${count} arquivos`} ao lado das instruções. Nada disso é executado.`,
    textOnlyBody: 'Somente instruções. Nada disso é executado.',
    tokensWhenUsed: ({ count }) => `Cerca de ${count} tokens quando usada`,
    alwaysOnBody: ({ count }) =>
      `${count} tokens em toda sessão para a descrição, para os agentes saberem que ela existe.`,
    sourceBody: ({ source, ref }) =>
      `Encontrada em ${source} · fixada em ${ref} · as alterações aguardam sua revisão`,
    nextTitle: 'O que acontece depois',
    next1: 'Ela é salva na sua biblioteca, com criptografia de ponta a ponta.',
    next2:
      'A próxima sessão em cada máquina a recebe. As sessões em andamento não mudam.',
    next3: 'Suas próprias pastas de habilidades não são alteradas.',
    filesTitle: ({ count }) => (count === 1 ? 'Um arquivo' : `${count} arquivos`),
    problemTooLarge:
      'Maior do que uma habilidade pode ser, por isso não dá para adicioná-la.',
    problemUnsupported:
      'Usa um link simbólico ou um submódulo; o Happier não consegue adicioná-la com segurança.',
    problemRemoved: 'Não está mais no registro.',
    loading: 'Lendo…',
    loadFailed: 'Não foi possível ler esta habilidade. Tente de novo.',
  },
  partial: {
    rules: 'Adicionada · Não foi possível definir onde está ativada',
    content: ({ names }) => names ? `Não foi possível adicionar ${names}. As habilidades adicionadas são mantidas.` : 'Não foi possível concluir a adição das habilidades. As habilidades adicionadas são mantidas.',
    tryAgain: 'Tentar de novo',
    retrying: 'Definindo onde está ativada…',
  },
  link: {
    title: 'De um link',
    body: 'Cole um repositório ou uma pasta do GitHub. O Happier lista as habilidades dele, fixadas no commit atual.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Encontrar habilidades',
    finding: 'Procurando habilidades…',
    found: ({ count }) =>
      count === 1
        ? 'Uma habilidade neste repositório'
        : `${count} habilidades neste repositório`,
    none: 'Nenhuma habilidade neste repositório. Uma habilidade é uma pasta com um SKILL.md.',
    invalid: 'Cole um link completo, começando com https://',
    failed: 'Não foi possível ler este link. Confira-o e tente de novo.',
    addSelected: ({ count }) =>
      count === 1 ? 'Adicionar 1 habilidade' : `Adicionar ${count} habilidades`,
    selectAll: 'Selecionar tudo',
    openOne: 'Abra um para ver o que ele instala.',
    chooseWhich: 'Escolha quais adicionar',
  },
  upload: {
    title: 'Enviar',
    body: 'Uma pasta de habilidade ou um .zip com um SKILL.md dentro. Ele é lido aqui; nada é executado.',
    dropHere: 'Solte uma pasta ou um .zip aqui',
    chooseZip: 'Escolher um .zip',
    chooseFolder: 'Escolher uma pasta',
    neverRuns: 'Os envios são verificados aqui e nunca são executados.',
    reading: 'Lendo…',
    invalidName: ({ file }) =>
      `“${file}” tem um nome que não pode ser salvo em todas as máquinas. Renomeie e tente de novo.`,
    found: ({ count }) =>
      count === 1
        ? 'Uma habilidade neste envio'
        : `${count} habilidades neste envio`,
    unreadable: ({ file }) => `Não foi possível ler “${file}”.`,
    noSkill: 'Nenhum SKILL.md no que você escolheu.',
    failed: 'Não foi possível ler este envio. Tente de novo.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Russian
// ---------------------------------------------------------------------------------------------------------------
const ruNouns = slavicNouns(
  {
    skill: {
      one: 'скилл',
      few: 'скилла',
      many: 'скиллов',
      plural: 'скиллы',
      object: 'скиллов',
    },
    mcpServer: {
      one: 'MCP-сервер',
      few: 'MCP-сервера',
      many: 'MCP-серверов',
      plural: 'MCP-серверы',
      object: 'MCP-серверов',
    },
    agent: {
      one: 'агент',
      few: 'агента',
      many: 'агентов',
      plural: 'агенты',
      object: 'агентов',
    },
    plugin: {
      one: 'плагин',
      few: 'плагина',
      many: 'плагинов',
      plural: 'плагины',
      object: 'плагинов',
    },
  },
  russianForm,
);

const ru: RegistriesTranslation = {
  status: { updatedEarlier: "Обновлено ранее" },
  select: {
    label: 'Реестр',
    all: 'Все реестры',
    addRegistry: 'Добавить реестр…',
    manage: 'Управление реестрами',
  },
  format: {
    builtIn: 'Встроенный',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Маркетплейс Claude',
    mcpRegistry: 'Реестр MCP',
    acpRegistry: 'Реестр ACP',
    happierCatalog: 'Каталог Happier',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `Добавлено: ${plugin}`,
    off: 'Выкл.',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count, ',')} ${ruNouns.counted(kind, count)}`,
  view: {
    title: 'Реестры',
    purpose: ({ kind }) =>
      `Откуда в «Обзоре» берутся ${ruNouns.plural(kind)}.`,
    listLabel: 'Реестры',
    newRow: 'Новый реестр',
    newRowBody: 'Вставьте ссылку, чтобы начать',
    empty: 'Добавьте реестр',
  },
  add: {
    title: 'Добавить реестр',
    purpose: ({ kind }) =>
      `Место, откуда в «Обзоре» берутся ${ruNouns.plural(kind)}. Happier только читает его; ничего из содержимого не запускается.`,
    link: 'Ссылка',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: 'Проверяем ссылку…',
    found: ({ kind, count }) =>
      `${compact(count, ',')} ${ruNouns.counted(kind, count)}`,
    foundNoCount: 'Готов к просмотру',
    name: 'Название',
    whatYouCanAdd: 'Что можно добавить',
    gitTitle: 'Git-репозиторий',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? 'Любая папка с файлом SKILL.md, например github.com/anthropics/skills'
        : 'Репозиторий, который Happier может читать по HTTPS',
    marketplaceTitle: 'Маркетплейс плагинов Claude',
    marketplaceBody:
      'Файл marketplace.json; Happier перечисляет скиллы из его плагинов',
    mcpRegistryTitle: 'Реестр MCP',
    mcpRegistryBody:
      'Официальный реестр или подреестр, который отдаёт /v0.1/servers',
    acpRegistryTitle: 'Реестр ACP',
    acpRegistryBody:
      'Файл registry.json со списком агентов и способом их установки',
    catalogTitle: 'Каталог Happier',
    catalogBody: 'Файл catalog.json со списком плагинов',
    submit: 'Добавить реестр',
    cancel: 'Отмена',
    organisation: 'Это организация. Добавьте один из её репозиториев.',
    unknownFormat:
      'Эта ссылка не ведёт ни на Git-репозиторий, ни на маркетплейс Claude, ни на реестр MCP, ни на реестр ACP.',
    needsToken: ({ host }) =>
      `Этому реестру нужен токен. Он отправляется только на ${host}.`,
    tokenRejected: 'Токен отклонён. Выберите другой.',
    httpsRequired: 'Используйте ссылку https://',
    credentialsInLink: 'Удалите имя пользователя и пароль из этой ссылки',
    unreachable:
      'Не удалось открыть ссылку. Проверьте её и повторите попытку.',
    alreadyAdded: 'Уже в ваших реестрах',
    failed: 'Не удалось добавить реестр. Повторите попытку.',
  },
  detail: {
    builtInPurpose: 'Встроен в Happier. Его можно выключить, но нельзя удалить.',
    pluginPurpose: ({ plugin }) =>
      `Добавлено: ${plugin}. Исчезнет вместе с плагином.`,
    userPurpose: ({ kind }) =>
      `Добавленный вами реестр: ${ruNouns.plural(kind)}. Happier только читает его; ничего из содержимого не запускается.`,
    nameTitle: 'Название',
    nameBody: 'Так он называется в меню реестров.',
    sourceTitle: 'Источник',
    refOn: ({ ref }) => `на ${ref}`,
    refresh: 'Обновить',
    refreshNow: 'Обновить сейчас',
    checked: ({ time }) => `Проверено ${time}`,
    notChecked: 'Перечитывается, когда вы его просматриваете',
    useTitle: 'Использовать в «Обзоре»',
    useBody: ({ kind }) =>
      `Выключите, чтобы в списке больше не было ${ruNouns.object(kind)} из него. Уже добавленное не изменится.`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? 'Скиллы из него в вашей библиотеке'
        : `${cap(ruNouns.plural(kind))}, добавленные из него`,
    fromItRow: ({ ref }) =>
      `Закреплено на ${ref} · останется, если удалить реестр`,
    fromItRowNoRef: 'Останется, если удалить реестр',
    remove: 'Удалить реестр',
    removeConfirm: "Реестр будет удалён из раздела обзора. Всё, что вы добавили из него, останется установленным или в библиотеке. Позже реестр можно добавить снова.",
    removeNote: ({ kind }) =>
      `${cap(ruNouns.plural(kind))}, добавленные из него, останутся в вашей библиотеке.`,
    removeFailed: 'Не удалось удалить реестр. Повторите попытку.',
    updateFailed: 'Не удалось сохранить изменение. Повторите попытку.',
    tokenTitle: 'Токен',
    tokenNone: ({ host }) =>
      `Для частных реестров или более высокого лимита. Отправляется только на ${host}.`,
    tokenSet: ({ name, host }) => `${name} · отправляется только на ${host}`,
    tokenGitHubHost: 'GitHub, для этого репозитория',
    tokenAdd: 'Добавить токен',
    tokenChange: 'Изменить',
    tokenPickTitle: 'Выберите токен',
    tokenAdded: 'Токен сохранён',
    tokenRemoved: 'Токен удалён',
    undo: 'Отменить',
  },
};

const ruSkillAdd: SkillAddTranslation = {
  title: 'Добавить скилл',
  modes: {
    browse: 'Обзор',
    link: 'По ссылке',
    upload: 'Загрузить',
    write: 'Написать',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Искать скиллы'
      : `Искать скиллы (${compact(count, ',')})`,
  groupAll: 'В ваших реестрах',
  groupPicks: 'Выбор Happier',
  groupSource: ({ source }) => `Из ${source}`,
  noMatch: ({ query }) => `Нет скиллов по запросу «${query}»`,
  emptyTitle: 'Пока нет скиллов для просмотра',
  emptyBody:
    'В используемых вами реестрах сейчас нет скиллов. Добавьте реестр через меню выше или напишите скилл сами.',
  clear: 'Очистить',
  add: 'Добавить',
  inLibrary: 'В вашей библиотеке',
  open: 'Открыть',
  addToLibrary: 'Добавить в библиотеку',
  pinnedTo: ({ ref }) => `Закреплён на ${ref}`,
  via: ({ source }) => `через ${source}`,
  outsideReferences: ({ count }) =>
    `Не включены файлы, на которые есть ссылки: ${count}.`,
  outsideReferencesMore: ({ count }) => `и ещё ${count}`,
  alsoAdds: ({ name }) => `Также добавит ${name}, на который он ссылается`,
  detail: {
    whereTitle: 'Где включён',
    whereBody:
      'На всех машинах и у всех агентов, если вы не ограничите это сейчас.',
    installsTitle: 'Что он устанавливает',
    runsScriptsBody: ({ count }) =>
      `${pickForm(russianForm(count), { one: count === 1 ? 'Один скрипт' : `${count} скрипт`, few: `${count} скрипта`, many: `${count} скриптов` })}. При добавлении ничего не запускается; агент может запустить их, когда использует скилл, с правами сессии.`,
    hasFilesBody: ({ count }) =>
      `${pickForm(russianForm(count), { one: count === 1 ? 'Один файл' : `${count} файл`, few: `${count} файла`, many: `${count} файлов` })} рядом с инструкциями. Ничего из этого не запускается.`,
    textOnlyBody: 'Только инструкции. Ничего не запускается.',
    tokensWhenUsed: ({ count }) => `Около ${count} токенов при использовании`,
    alwaysOnBody: ({ count }) =>
      `${count} токенов в каждой сессии на его описание, чтобы агенты знали, что он есть.`,
    sourceBody: ({ source, ref }) =>
      `Найден на ${source} · закреплён на ${ref} · изменения ждут вашей проверки`,
    nextTitle: 'Что будет дальше',
    next1: 'Он сохранится в вашей библиотеке со сквозным шифрованием.',
    next2:
      'Следующая сессия на каждой машине его получит. Запущенные сессии не изменятся.',
    next3: 'Ваши собственные папки со скиллами не затрагиваются.',
    filesTitle: ({ count }) =>
      pickForm(russianForm(count), {
        one: count === 1 ? 'Один файл' : `${count} файл`,
        few: `${count} файла`,
        many: `${count} файлов`,
      }),
    problemTooLarge:
      'Больше, чем может быть скилл, поэтому его нельзя добавить.',
    problemUnsupported:
      'Использует символическую ссылку или подмодуль; Happier не может безопасно его добавить.',
    problemRemoved: 'Больше нет в своём реестре.',
    loading: 'Читаем…',
    loadFailed: 'Не удалось прочитать этот скилл. Повторите попытку.',
  },
  partial: {
    rules: 'Добавлен · Не удалось задать, где он включён',
    content: ({ names }) => names ? `Не удалось добавить ${names}. Добавленные навыки сохранены.` : 'Не удалось завершить добавление навыков. Добавленные навыки сохранены.',
    tryAgain: 'Повторить',
    retrying: 'Задаём, где он включён…',
  },
  link: {
    title: 'По ссылке',
    body: 'Вставьте репозиторий или папку GitHub. Happier перечислит скиллы в ней, закреплённые на текущем коммите.',
    placeholder: 'https://github.com/owner/repository',
    find: 'Найти скиллы',
    finding: 'Ищем скиллы…',
    found: ({ count }) =>
      pickForm(russianForm(count), {
        one:
          count === 1
            ? 'Один скилл в этом репозитории'
            : `${count} скилл в этом репозитории`,
        few: `${count} скилла в этом репозитории`,
        many: `${count} скиллов в этом репозитории`,
      }),
    none: 'В этом репозитории нет скиллов. Скилл — это папка с файлом SKILL.md.',
    invalid: 'Вставьте полную ссылку, начинающуюся с https://',
    failed: 'Не удалось прочитать ссылку. Проверьте её и повторите попытку.',
    addSelected: ({ count }) =>
      pickForm(russianForm(count), {
        one: `Добавить ${count} скилл`,
        few: `Добавить ${count} скилла`,
        many: `Добавить ${count} скиллов`,
      }),
    selectAll: 'Выбрать все',
    openOne: 'Откройте любой, чтобы увидеть, что он устанавливает.',
    chooseWhich: 'Выберите, что добавить',
  },
  upload: {
    title: 'Загрузить',
    body: 'Папка со скиллом или .zip с файлом SKILL.md внутри. Читается только здесь; ничего не запускается.',
    dropHere: 'Перетащите сюда папку или .zip',
    chooseZip: 'Выбрать .zip',
    chooseFolder: 'Выбрать папку',
    neverRuns: 'Загрузки проверяются здесь и никогда не запускаются.',
    reading: 'Читаем…',
    invalidName: ({ file }) =>
      `У «${file}» имя, которое нельзя сохранить на всех машинах. Переименуйте и повторите попытку.`,
    found: ({ count }) =>
      pickForm(russianForm(count), {
        one:
          count === 1
            ? 'Один скилл в этой загрузке'
            : `${count} скилл в этой загрузке`,
        few: `${count} скилла в этой загрузке`,
        many: `${count} скиллов в этой загрузке`,
      }),
    unreadable: ({ file }) => `Не удалось прочитать «${file}».`,
    noSkill: 'В выбранном нет файла SKILL.md.',
    failed: 'Не удалось прочитать загрузку. Повторите попытку.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Chinese (Simplified)
// ---------------------------------------------------------------------------------------------------------------
const zhHansNouns = bareNouns({
  skill: '技能',
  mcpServer: 'MCP 服务器',
  agent: '智能体',
  plugin: '插件',
});

const zhHans: RegistriesTranslation = {
  status: { updatedEarlier: "此前已更新" },
  select: {
    label: '注册表',
    all: '所有注册表',
    addRegistry: '添加注册表…',
    manage: '管理注册表',
  },
  format: {
    builtIn: '内置',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Claude 插件市场',
    mcpRegistry: 'MCP 注册表',
    acpRegistry: 'ACP 注册表',
    happierCatalog: 'Happier 目录',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `由 ${plugin} 添加`,
    off: '关闭',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count)} 个${zhHansNouns.counted(kind, count)}`,
  view: {
    title: '注册表',
    purpose: ({ kind }) =>
      `“浏览”查找${zhHansNouns.plural(kind)}的位置。`,
    listLabel: '注册表',
    newRow: '新建注册表',
    newRowBody: '粘贴链接即可开始',
    empty: '添加注册表',
  },
  add: {
    title: '添加注册表',
    purpose: ({ kind }) =>
      `可从中浏览${zhHansNouns.plural(kind)}的地方。Happier 只读取它，其中的内容不会运行。`,
    link: '链接',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: '正在检查链接…',
    found: ({ kind, count }) =>
      `${compact(count)} 个${zhHansNouns.counted(kind, count)}`,
    foundNoCount: '可以浏览了',
    name: '名称',
    whatYouCanAdd: '可以添加什么',
    gitTitle: 'Git 仓库',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? '任何含有 SKILL.md 的文件夹，例如 github.com/anthropics/skills'
        : 'Happier 可通过 HTTPS 读取的仓库',
    marketplaceTitle: 'Claude 插件市场',
    marketplaceBody:
      'marketplace.json；Happier 会列出其中插件里的技能',
    mcpRegistryTitle: 'MCP 注册表',
    mcpRegistryBody: '官方注册表，或提供 /v0.1/servers 的子注册表',
    acpRegistryTitle: 'ACP 注册表',
    acpRegistryBody: '列出智能体及其安装方式的 registry.json',
    catalogTitle: 'Happier 目录',
    catalogBody: '列出插件的 catalog.json',
    submit: '添加注册表',
    cancel: '取消',
    organisation: '这是一个组织。请添加它的某个仓库。',
    unknownFormat:
      '此链接不是 Git 仓库、Claude 插件市场、MCP 注册表或 ACP 注册表。',
    needsToken: ({ host }) =>
      `此注册表需要令牌。仅会发送到 ${host}。`,
    tokenRejected: '该令牌被拒绝。请选择另一个。',
    httpsRequired: '请使用 https:// 链接',
    credentialsInLink: '请移除此链接中的用户名和密码',
    unreachable: '无法访问此链接。请检查后重试。',
    alreadyAdded: '已在你的注册表中',
    failed: '无法添加此注册表。请重试。',
  },
  detail: {
    builtInPurpose: 'Happier 内置。可以关闭，但不能移除。',
    pluginPurpose: ({ plugin }) =>
      `由 ${plugin} 添加。插件移除后它也会消失。`,
    userPurpose: ({ kind }) =>
      `你添加的注册表，包含${zhHansNouns.plural(kind)}。Happier 只读取它，其中的内容不会运行。`,
    nameTitle: '名称',
    nameBody: '它在注册表菜单中的显示名称。',
    sourceTitle: '来源',
    refOn: ({ ref }) => `在 ${ref} 上`,
    refresh: '刷新',
    refreshNow: '立即刷新',
    checked: ({ time }) => `上次检查：${time}`,
    notChecked: '浏览时重新读取',
    useTitle: '在“浏览”中使用',
    useBody: ({ kind }) =>
      `关闭后，将不再列出此注册表中的${zhHansNouns.object(kind)}。你已添加的内容不会改变。`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? '来自它、已在资料库中的技能'
        : `你从中添加的${zhHansNouns.plural(kind)}`,
    fromItRow: ({ ref }) => `固定到 ${ref} · 移除注册表后仍保留`,
    fromItRowNoRef: '移除注册表后仍保留',
    remove: '移除注册表',
    removeConfirm: "这会将注册表从浏览中移除。从中添加的内容仍保持安装或保留在你的库中。你可以稍后重新添加此注册表。",
    removeNote: ({ kind }) =>
      `你从中添加的${zhHansNouns.plural(kind)}会留在资料库中。`,
    removeFailed: '无法移除此注册表。请重试。',
    updateFailed: '无法保存更改。请重试。',
    tokenTitle: '令牌',
    tokenNone: ({ host }) =>
      `用于私有注册表或更高的限额。仅发送到 ${host}。`,
    tokenSet: ({ name, host }) => `${name} · 仅发送到 ${host}`,
    tokenGitHubHost: 'GitHub，用于此仓库',
    tokenAdd: '添加令牌',
    tokenChange: '更改',
    tokenPickTitle: '选择令牌',
    tokenAdded: '令牌已保存',
    tokenRemoved: '令牌已移除',
    undo: '撤销',
  },
};

const zhHansSkillAdd: SkillAddTranslation = {
  title: '添加技能',
  modes: {
    browse: '浏览',
    link: '从链接',
    upload: '上传',
    write: '编写',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? '搜索技能'
      : `搜索 ${compact(count)} 个技能`,
  groupAll: '在你的注册表中',
  groupPicks: 'Happier 精选',
  groupSource: ({ source }) => `来自 ${source}`,
  noMatch: ({ query }) => `没有与“${query}”匹配的技能`,
  emptyTitle: '暂时没有可浏览的技能',
  emptyBody:
    '你使用的注册表目前没有列出任何技能。可以从上方菜单添加注册表，或自己编写一个技能。',
  clear: '清除',
  add: '添加',
  inLibrary: '已在你的资料库',
  open: '打开',
  addToLibrary: '添加到资料库',
  pinnedTo: ({ ref }) => `固定到 ${ref}`,
  via: ({ source }) => `经由 ${source}`,
  outsideReferences: ({ count }) =>
    `引用了 ${count} 个不会被包含的文件。`,
  outsideReferencesMore: ({ count }) => `另外 ${count} 个`,
  alsoAdds: ({ name }) => `同时添加它引用的 ${name}`,
  detail: {
    whereTitle: '在哪里开启',
    whereBody: '所有机器和智能体，除非你现在就限定范围。',
    installsTitle: '它会安装什么',
    runsScriptsBody: ({ count }) =>
      `${count} 个脚本。添加时不会运行任何内容；智能体使用该技能时可能会以会话的权限运行它们。`,
    hasFilesBody: ({ count }) =>
      `指令旁有 ${count} 个文件。其中的内容不会运行。`,
    textOnlyBody: '只有指令。不会运行任何内容。',
    tokensWhenUsed: ({ count }) => `使用时约 ${count} 个 token`,
    alwaysOnBody: ({ count }) =>
      `每个会话中为它的描述占用 ${count} 个 token，好让智能体知道它的存在。`,
    sourceBody: ({ source, ref }) =>
      `在 ${source} 上找到 · 固定到 ${ref} · 更改会等待你审核`,
    nextTitle: '接下来会怎样',
    next1: '它会保存到你的资料库，并经过端到端加密。',
    next2: '每台机器的下一个会话会获得它。正在运行的会话不受影响。',
    next3: '你自己的技能文件夹不会被改动。',
    filesTitle: ({ count }) => `${count} 个文件`,
    problemTooLarge: '超出技能允许的大小，因此无法添加。',
    problemUnsupported: '使用了符号链接或子模块；Happier 无法安全地添加。',
    problemRemoved: '已不在其注册表中。',
    loading: '正在读取…',
    loadFailed: '无法读取此技能。请重试。',
  },
  partial: {
    rules: '已添加 · 无法设置在哪里开启',
    content: ({ names }) => names ? `无法添加 ${names}。已添加的技能会保留。` : '无法完成技能添加。已添加的技能会保留。',
    tryAgain: '重试',
    retrying: '正在设置在哪里开启…',
  },
  link: {
    title: '从链接',
    body: '粘贴一个 GitHub 仓库或文件夹。Happier 会列出其中的技能，并固定到当前提交。',
    placeholder: 'https://github.com/owner/repository',
    find: '查找技能',
    finding: '正在查找技能…',
    found: ({ count }) => `此仓库中有 ${count} 个技能`,
    none: '此仓库中没有技能。技能是含有 SKILL.md 的文件夹。',
    invalid: '请粘贴以 https:// 开头的完整链接',
    failed: '无法读取此链接。请检查后重试。',
    addSelected: ({ count }) => `添加 ${count} 个技能`,
    selectAll: '全选',
    openOne: '打开一个即可查看它会安装什么。',
    chooseWhich: '选择要添加的',
  },
  upload: {
    title: '上传',
    body: '一个技能文件夹，或内含 SKILL.md 的 .zip。只在此处读取，不会运行任何内容。',
    dropHere: '将文件夹或 .zip 拖到这里',
    chooseZip: '选择 .zip',
    chooseFolder: '选择文件夹',
    neverRuns: '上传内容只在这里检查，绝不会运行。',
    reading: '正在读取…',
    invalidName: ({ file }) =>
      `“${file}”的名称无法在所有机器上保存。请重命名后重试。`,
    found: ({ count }) =>
      `此上传中有 ${count} 个技能`,
    unreadable: ({ file }) => `无法读取“${file}”。`,
    noSkill: '你选择的内容中没有 SKILL.md。',
    failed: '无法读取此上传内容。请重试。',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Chinese (Traditional)
// ---------------------------------------------------------------------------------------------------------------
const zhHantNouns = bareNouns({
  skill: '技能',
  mcpServer: 'MCP 伺服器',
  agent: '代理',
  plugin: '外掛程式',
});

const zhHant: RegistriesTranslation = {
  status: { updatedEarlier: "先前已更新" },
  select: {
    label: '註冊表',
    all: '所有註冊表',
    addRegistry: '新增註冊表…',
    manage: '管理註冊表',
  },
  format: {
    builtIn: '內建',
    git: 'Git',
    skillsSh: 'skills.sh',
    claudeMarketplace: 'Claude 外掛程式市集',
    mcpRegistry: 'MCP 註冊表',
    acpRegistry: 'ACP 註冊表',
    happierCatalog: 'Happier 目錄',
    happierNpm: 'npm',
    addedBy: ({ plugin }) => `由 ${plugin} 新增`,
    off: '關閉',
  },
  itemCount: ({ kind, count }) =>
    `${compact(count)} 個${zhHantNouns.counted(kind, count)}`,
  view: {
    title: '註冊表',
    purpose: ({ kind }) =>
      `「瀏覽」尋找${zhHantNouns.plural(kind)}的位置。`,
    listLabel: '註冊表',
    newRow: '新註冊表',
    newRowBody: '貼上連結即可開始',
    empty: '新增註冊表',
  },
  add: {
    title: '新增註冊表',
    purpose: ({ kind }) =>
      `可從中瀏覽${zhHantNouns.plural(kind)}的地方。Happier 只會讀取它，其中的內容不會執行。`,
    link: '連結',
    linkPlaceholder: 'https://registry.example.com/catalog.json',
    checking: '正在檢查連結…',
    found: ({ kind, count }) =>
      `${compact(count)} 個${zhHantNouns.counted(kind, count)}`,
    foundNoCount: '可以瀏覽了',
    name: '名稱',
    whatYouCanAdd: '可以新增什麼',
    gitTitle: 'Git 儲存庫',
    gitBody: ({ kind }) =>
      kind === 'skill'
        ? '任何含有 SKILL.md 的資料夾，例如 github.com/anthropics/skills'
        : 'Happier 可透過 HTTPS 讀取的儲存庫',
    marketplaceTitle: 'Claude 外掛程式市集',
    marketplaceBody:
      'marketplace.json；Happier 會列出其中外掛程式裡的技能',
    mcpRegistryTitle: 'MCP 註冊表',
    mcpRegistryBody: '官方註冊表，或提供 /v0.1/servers 的子註冊表',
    acpRegistryTitle: 'ACP 註冊表',
    acpRegistryBody: '列出代理及其安裝方式的 registry.json',
    catalogTitle: 'Happier 目錄',
    catalogBody: '列出外掛程式的 catalog.json',
    submit: '新增註冊表',
    cancel: '取消',
    organisation: '這是一個組織。請新增它的其中一個儲存庫。',
    unknownFormat:
      '此連結不是 Git 儲存庫、Claude 外掛程式市集、MCP 註冊表或 ACP 註冊表。',
    needsToken: ({ host }) =>
      `此註冊表需要權杖。僅會傳送到 ${host}。`,
    tokenRejected: '該權杖被拒絕。請選擇另一個。',
    httpsRequired: '請使用 https:// 連結',
    credentialsInLink: '請移除此連結中的使用者名稱和密碼',
    unreachable: '無法連線到此連結。請檢查後重試。',
    alreadyAdded: '已在你的註冊表中',
    failed: '無法新增此註冊表。請重試。',
  },
  detail: {
    builtInPurpose: 'Happier 內建。可以關閉，但無法移除。',
    pluginPurpose: ({ plugin }) =>
      `由 ${plugin} 新增。外掛程式移除後它也會消失。`,
    userPurpose: ({ kind }) =>
      `你新增的註冊表，包含${zhHantNouns.plural(kind)}。Happier 只會讀取它，其中的內容不會執行。`,
    nameTitle: '名稱',
    nameBody: '它在註冊表選單中的顯示名稱。',
    sourceTitle: '來源',
    refOn: ({ ref }) => `在 ${ref} 上`,
    refresh: '重新整理',
    refreshNow: '立即重新整理',
    checked: ({ time }) => `上次檢查：${time}`,
    notChecked: '瀏覽時重新讀取',
    useTitle: '在「瀏覽」中使用',
    useBody: ({ kind }) =>
      `關閉後，將不再列出此註冊表中的${zhHantNouns.object(kind)}。你已新增的內容不會改變。`,
    fromItTitle: ({ kind }) =>
      kind === 'skill'
        ? '來自它、已在資料庫中的技能'
        : `你從中新增的${zhHantNouns.plural(kind)}`,
    fromItRow: ({ ref }) => `固定在 ${ref} · 移除註冊表後仍保留`,
    fromItRowNoRef: '移除註冊表後仍保留',
    remove: '移除註冊表',
    removeConfirm: "這會將登錄檔從瀏覽中移除。從中新增的內容仍保持安裝或保留在你的程式庫中。你可以稍後重新新增此登錄檔。",
    removeNote: ({ kind }) =>
      `你從中新增的${zhHantNouns.plural(kind)}會留在資料庫中。`,
    removeFailed: '無法移除此註冊表。請重試。',
    updateFailed: '無法儲存變更。請重試。',
    tokenTitle: '權杖',
    tokenNone: ({ host }) =>
      `用於私人註冊表或更高的額度。僅傳送到 ${host}。`,
    tokenSet: ({ name, host }) => `${name} · 僅傳送到 ${host}`,
    tokenGitHubHost: 'GitHub，用於此儲存庫',
    tokenAdd: '新增權杖',
    tokenChange: '變更',
    tokenPickTitle: '選擇權杖',
    tokenAdded: '權杖已儲存',
    tokenRemoved: '權杖已移除',
    undo: '復原',
  },
};

const zhHantSkillAdd: SkillAddTranslation = {
  title: '新增技能',
  modes: {
    browse: '瀏覽',
    link: '從連結',
    upload: '上傳',
    write: '撰寫',
  },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? '搜尋技能'
      : `搜尋 ${compact(count)} 個技能`,
  groupAll: '在你的註冊表中',
  groupPicks: 'Happier 精選',
  groupSource: ({ source }) => `來自 ${source}`,
  noMatch: ({ query }) => `沒有符合「${query}」的技能`,
  emptyTitle: '暫時沒有可瀏覽的技能',
  emptyBody:
    '你使用的登錄庫目前沒有列出任何技能。可以從上方選單新增登錄庫，或自行撰寫一個技能。',
  clear: '清除',
  add: '新增',
  inLibrary: '已在你的資料庫',
  open: '開啟',
  addToLibrary: '新增到資料庫',
  pinnedTo: ({ ref }) => `固定在 ${ref}`,
  via: ({ source }) => `經由 ${source}`,
  outsideReferences: ({ count }) =>
    `參照了 ${count} 個不會被包含的檔案。`,
  outsideReferencesMore: ({ count }) => `另有 ${count} 個`,
  alsoAdds: ({ name }) => `同時新增它引用的 ${name}`,
  detail: {
    whereTitle: '在哪裡開啟',
    whereBody: '所有機器和代理，除非你現在就限定範圍。',
    installsTitle: '它會安裝什麼',
    runsScriptsBody: ({ count }) =>
      `${count} 個腳本。新增時不會執行任何內容；代理使用該技能時可能會以工作階段的權限執行它們。`,
    hasFilesBody: ({ count }) =>
      `指令旁有 ${count} 個檔案。其中的內容不會執行。`,
    textOnlyBody: '只有指令。不會執行任何內容。',
    tokensWhenUsed: ({ count }) => `使用時約 ${count} 個 token`,
    alwaysOnBody: ({ count }) =>
      `每個工作階段中為它的說明佔用 ${count} 個 token，好讓代理知道它的存在。`,
    sourceBody: ({ source, ref }) =>
      `在 ${source} 上找到 · 固定在 ${ref} · 變更會等待你審核`,
    nextTitle: '接下來會怎樣',
    next1: '它會儲存到你的資料庫，並經過端對端加密。',
    next2: '每台機器的下一個工作階段會取得它。執行中的工作階段不受影響。',
    next3: '你自己的技能資料夾不會被更動。',
    filesTitle: ({ count }) => `${count} 個檔案`,
    problemTooLarge: '超出技能允許的大小，因此無法新增。',
    problemUnsupported: '使用了符號連結或子模組；Happier 無法安全地新增。',
    problemRemoved: '已不在其註冊表中。',
    loading: '正在讀取…',
    loadFailed: '無法讀取此技能。請重試。',
  },
  partial: {
    rules: '已新增 · 無法設定在哪裡開啟',
    content: ({ names }) => names ? `無法新增 ${names}。已新增的技能會保留。` : '無法完成技能新增。已新增的技能會保留。',
    tryAgain: '重試',
    retrying: '正在設定在哪裡開啟…',
  },
  link: {
    title: '從連結',
    body: '貼上 GitHub 儲存庫或資料夾。Happier 會列出其中的技能，並固定在目前的提交。',
    placeholder: 'https://github.com/owner/repository',
    find: '尋找技能',
    finding: '正在尋找技能…',
    found: ({ count }) => `此儲存庫中有 ${count} 個技能`,
    none: '此儲存庫中沒有技能。技能是含有 SKILL.md 的資料夾。',
    invalid: '請貼上以 https:// 開頭的完整連結',
    failed: '無法讀取此連結。請檢查後重試。',
    addSelected: ({ count }) => `新增 ${count} 個技能`,
    selectAll: '全選',
    openOne: '開啟一個即可查看它會安裝什麼。',
    chooseWhich: '選擇要新增的',
  },
  upload: {
    title: '上傳',
    body: '一個技能資料夾，或內含 SKILL.md 的 .zip。只會在此處讀取，不會執行任何內容。',
    dropHere: '將資料夾或 .zip 拖曳到這裡',
    chooseZip: '選擇 .zip',
    chooseFolder: '選擇資料夾',
    neverRuns: '上傳內容只在這裡檢查，絕不會執行。',
    reading: '正在讀取…',
    invalidName: ({ file }) =>
      `「${file}」的名稱無法在所有機器上儲存。請重新命名後重試。`,
    found: ({ count }) =>
      `此上傳中有 ${count} 個技能`,
    unreadable: ({ file }) => `無法讀取「${file}」。`,
    noSkill: '你選擇的內容中沒有 SKILL.md。',
    failed: '無法讀取此上傳內容。請重試。',
  },
};

const registriesByLocale = {
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
} satisfies Record<string, RegistriesTranslation>;
const skillAddByLocale = {
  en: enSkillAdd,
  ca: caSkillAdd,
  de: deSkillAdd,
  es: esSkillAdd,
  fr: frSkillAdd,
  it: itSkillAdd,
  ja: jaSkillAdd,
  pl: plSkillAdd,
  pt: ptSkillAdd,
  ru: ruSkillAdd,
  zhHans: zhHansSkillAdd,
  zhHant: zhHantSkillAdd,
} satisfies Record<string, SkillAddTranslation>;

export const registriesTranslations: Readonly<
  Record<keyof typeof registriesByLocale, RegistriesTranslation>
> = registriesByLocale;
export const skillAddTranslations: Readonly<
  Record<keyof typeof skillAddByLocale, SkillAddTranslation>
> = skillAddByLocale;
