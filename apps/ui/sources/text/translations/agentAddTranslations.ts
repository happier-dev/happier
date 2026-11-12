// The agent body of the capability Add modal (P9 U9.4): Browse (registries, Happier picks, plugins on npm), the
// details, the install progress and the install confirm. Mounted under `capabilities.agentAdd`. Non-English locales
// carry the English block until the locale sweep.

type Name = Readonly<{ name: string }>;
type Machine = Readonly<{ machine: string }>;

const en = {
  title: 'Add an agent',
  browse: 'Browse agents',
  browseDescription: 'From the ACP Registry and Happier plugins.',
  subtitle: 'From a registry, a Happier plugin, or your own command.',
  modes: { browse: 'Browse', command: 'From a command' },
  searchPlaceholder: 'Search agents',
  groupPicks: 'Happier picks',
  trustNote:
    "The ACP Registry checks that each agent starts and offers sign-in. It doesn't review what an agent does. Nothing is downloaded until you add one.",
  noMatch: ({ query }: Readonly<{ query: string }>) =>
    `No agents match “${query}”`,
  nothingHere: 'No agents in this registry yet.',
  clear: 'Clear',
  status: {
    builtIn: 'Built into Happier',
    open: 'Open',
    added: 'Added',
    cantRun: "Can't run here",
    unknown: 'Unknown',
    cantAddYet: "Can't add yet",
  },
  distribution: {
    archive: 'Binary download',
    npm: 'npm package',
    uv: 'uv tool',
  },
  addAgent: 'Add agent',
  openAgent: ({ name }: Name) => `Open ${name}`,
  footerNote: 'Nothing runs until you start a session with it.',
  detail: {
    machinesTitle: 'Your machines',
    machinesBody:
      "An agent runs on a machine once it's installed there. One download per system.",
    noMachines: 'Add a machine to install it.',
    canRun: 'Can run it',
    unknownFit: "Can't tell yet",
    build: ({ target }: Readonly<{ target: string }>) => `${target} build`,
    runsVia: {
      npm: 'Runs from its npm package',
      uv: 'Runs as a uv tool',
      command: 'Runs its own command',
      archive: 'Binary download',
    },
    noBuild: ({
      name,
      platform,
    }: Readonly<{ name: string; platform: string }>) =>
      `${name} has no build for ${platform}`,
    archiveUnsupported: ({ name }: Name) =>
      `${name}'s download for this system isn't a format Happier can unpack`,
    platformUnknown: "This machine hasn't said which system it runs",
    archUnknown: "This machine hasn't said which processor it has",
    offlineNote: 'Offline',
    offlineMany: ({ count }: Readonly<{ count: number }>) => `${count} machines offline`,
    offlineManyBody: "Each one checks and installs it when it's back online.",
    installTitle: 'Install',
    installNow: 'Now',
    installFirstUse: 'On first use',
    installNowBody: ({ machines }: Readonly<{ machines: string }>) =>
      `${machines} start downloading as soon as you add it.`,
    installFirstUseBody:
      'Each machine downloads it the first time a session starts with it.',
    installNoneNow:
      'No machine is online to download it now; each one installs it when a session first uses it.',
    trustTitle: "What you're trusting",
    trustBody: ({ name }: Name) =>
      `${name} runs as a program on your machines, with your access to them. The ACP Registry checks that it starts and offers sign-in, not what it does. It is not signed. Nothing downloads until you add it, and nothing runs until you start a session.`,
    checksumVerified: 'Checksum verified',
    checksumVerifiedBody:
      "Each machine checks its download against the registry's SHA-256 before anything runs.",
    checksumMissing: 'Checksum not published by the registry',
    checkedByRegistry: 'Checked by the ACP Registry',
    checkedByRegistryBody:
      'The registry checks that it starts and offers sign-in. It is not signed.',
    installsTitle: 'What it installs',
    installsArchive: ({ file }: Readonly<{ file: string }>) => file,
    installsArchiveBody:
      "Unpacked into Happier's own folder on each machine. Your own terminal setup isn't changed.",
    installsNpm: ({ pkg }: Readonly<{ pkg: string }>) => pkg,
    installsNpmBody:
      "Installed with Happier's own Node.js into Happier's folder. Your own terminal setup isn't changed.",
    installsUv: ({ pkg }: Readonly<{ pkg: string }>) => pkg,
    installsUvBody:
      "Installed with Happier's own uv into Happier's folder. Your own terminal setup isn't changed.",
    signInTitle: 'Sign-in',
    signInBody: ({ name }: Name) =>
      `${name} asks you to sign in the first time it starts. The registry carries no sign-in details.`,
    readFailed: "Couldn't read this agent",
    retry: 'Try again',
    loading: 'Reading the registry…',
    noRunnableMachine: 'None of your machines can run it',
    unsupportedEntry: "Happier can't install this entry yet",
  },
  builtIn: {
    callout: ({ agent }: Readonly<{ name: string; agent: string }>) =>
      `Happier already includes this agent, as ${agent}.`,
    calloutBody:
      'It is set up and updated by Happier on each machine, with nothing to add.',
    addSeparate: "Add the registry's version as a separate agent",
    addSeparateBody: ({ agent }: Readonly<{ agent: string }>) =>
      `It won't share ${agent}'s sign-in or settings.`,
  },
  plugin: {
    addsBody: "From the plugin's manifest.",
    trustBody:
      'A plugin runs as trusted code inside Happier on that machine, not in a sandbox.',
    installOn: 'Install on',
    reviewAndInstall: 'Review and install',
    footerNote: 'You review exactly what it can reach before it installs.',
    listTrustNote:
      'A plugin runs as trusted code on a machine. You review each one before it installs.',
  },
  pluginsEmpty: {
    title: 'No agent plugins on npm yet',
    body: "A Happier plugin can bring an agent with more than a command: its own settings, sign-in and tools. None that add an agent have been published so far.",
    browseRegistry: 'Browse the ACP Registry',
    publish: 'How to publish a plugin',
    registryReady: ({ count }: Readonly<{ count: number }>) =>
      count === 1
        ? '1 agent is ready to add from the ACP Registry.'
        : `${count} agents are ready to add from the ACP Registry.`,
  },
  adding: {
    inYourAgents: ({ name }: Name) => `${name} is in your agents.`,
    inYourAgentsBody:
      "It shows up for new sessions on a machine as soon as it's installed there.",
    title: 'Installing',
    body: 'You can close this. It keeps going on each machine.',
    waiting: 'Waiting',
    downloading: 'Downloading',
    bytes: ({ done, total }: Readonly<{ done: string; total: string }>) =>
      `${done} of ${total}`,
    checking: 'Checking that it starts',
    thenChecks: 'Then Happier checks that it starts.',
    installed: 'Installed',
    installedBody: 'Downloaded and checked that it starts',
    failed: 'Install failed',
    cancelled: 'Cancelled',
    tryAgain: 'Try again',
    install: 'Install',
    cancel: 'Cancel',
    offline: 'Machine offline',
    offlineBody: "Installs when it's back online.",
    firstUse: 'Installs on first use',
    firstUseBody: 'Downloads the first time a session starts with it.',
    footerOffline: ({ machine }: Machine) =>
      `${machine} installs when it's back online.`,
    done: 'Done',
  },
  confirm: {
    title: ({ name, version }: Readonly<{ name: string; version?: string }>) =>
      `Add ${name}${version ? ` ${version}` : ''}?`,
    now: ({ machines }: Readonly<{ machines: string }>) =>
      `Downloads now on ${machines}.`,
    firstUse: ({ machines }: Readonly<{ machines: string }>) =>
      `Downloads on ${machines} the first time a session uses it.`,
    nowhere: 'Nothing downloads until a session first uses it.',
    size: ({ size }: Readonly<{ size: string }>) => `Download size: ${size}.`,
    source: ({ host }: Readonly<{ host: string }>) => `From ${host}.`,
    vendorRecipe: ({ name }: Name) =>
      `This runs ${name}'s own installer on the machine.`,
    confirm: 'Add agent',
  },
} as const;

export type AgentAddTranslation = typeof en;

export const agentAddTranslations = {
  en,
  ca: en,
  de: en,
  es: en,
  fr: en,
  it: en,
  ja: en,
  pl: en,
  pt: en,
  ru: en,
  zhHans: en,
  zhHant: en,
} as const;
