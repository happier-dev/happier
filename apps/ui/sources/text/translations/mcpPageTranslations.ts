// MCP servers page family copy (P7 U7.8): the rail, the server detail and its sections. Mounted under `capabilities.mcp`.

type Count = Readonly<{ count: number }>;

export type McpPageTranslation = Readonly<{
  allServers: string;
  foundOnMachines: string;
  inUse: string;
  off: string;
  fromPlugins: string;
  builtIn: string;
  builtInHappier: string;
  builtInHappierDescription: string;
  builtInActions: string;
  remote: string;
  local: string;
  config: McpConfigTranslation;
  tools: Readonly<{
    title: string;
    description: string;
    defaultTitle: string;
    defaultAsk: string;
    defaultReadOnly: string;
    defaultAll: string;
    defaultAskDescription: string;
    defaultReadOnlyDescription: string;
    defaultAllDescription: string;
    off: string;
    ask: string;
    allow: string;
    search: (params: Count) => string;
    filterAll: string;
    filterReadOnly: string;
    filterWrites: string;
    filterDestructive: string;
    filterSetByYou: string;
    readOnly: string;
    writes: string;
    destructive: string;
    setByYou: string;
    backToDefault: (params: Readonly<{ value: string }>) => string;
    useDefault: (params: Readonly<{ value: string }>) => string;
    showAll: (params: Count) => string;
    cost: (params: Readonly<{ count: number; tokens: string }>) => string;
    onDemand: (params: Readonly<{ agents: string; count: number }>) => string;
    notApply: (params: Readonly<{ agents: string }>) => string;
    blocked: (params: Readonly<{ agents: string }>) => string;
    hiddenRestart: (params: Readonly<{ agents: string }>) => string;
    notListed: string;
    lastListed: (params: Readonly<{ date: string }>) => string;
    loadFailed: string;
    noMatch: string;
    setFailed: string;
  }>;
  detail: Readonly<{
    configurationTitle: string;
    configurationDescription: string;
    machinesDescription: string;
    test: string;
    onNowhere: string;
    toolsOn: (params: Count) => string;
    checked: (params: Readonly<{ time: string }>) => string;
    notChecked: string;
    lastKnown: (params: Readonly<{ time: string }>) => string;
    summary: (params: Readonly<{ ready: number; problems: number; offline: number; unchecked: number }>) => string;
    detailsTitle: string;
    versionLine: (params: Readonly<{ version: string; protocol?: string }>) => string;
    /** A server added from a registry: its upstream state, and reviewing a newer version before applying it. */
    update: Readonly<{
      title: string;
      upToDate: string;
      available: (params: Readonly<{ version: string }>) => string;
      checkFailed: string;
      removed: string;
      checkNow: string;
      review: string;
      readFailed: string;
      changesTitle: (params: Readonly<{ version: string }>) => string;
      changesBody: string;
      now: string;
      after: string;
      apply: string;
      applyFailed: string;
    }>;
    serverInstructions: string;
    lastError: string;
    copy: string;
    removeServer: string;
    removeFootnote: string;
    /** Changed elsewhere · Review (P7 F11/F17): the open edit met another writer's change. */
    conflict: Readonly<{
      reason: string;
      review: string;
      title: string;
      description: string;
      current: string;
      yours: string;
      notSet: string;
      machines: string;
      keepMine: string;
      useCurrent: string;
      removedTitle: string;
      removedDescription: string;
      discard: string;
    }>;
    copyInstallLink: string;
    installLinkLabel: string;
    duplicate: string;
    fromPlugin: (params: Readonly<{ plugin: string }>) => string;
    pluginFootnote: (params: Readonly<{ plugin: string }>) => string;
    banner: Readonly<{
      expiredTitle: (params: Readonly<{ name: string }>) => string;
      expiredBody: (params: Readonly<{ name: string; date?: string; count?: number }>) => string;
      signinTitle: (params: Readonly<{ name: string }>) => string;
      signinBody: string;
      moreAccessTitle: (params: Readonly<{ name: string }>) => string;
      moreAccessBody: string;
      revokedTitle: (params: Readonly<{ name: string }>) => string;
      revokedBody: string;
      keyTitle: (params: Readonly<{ name: string }>) => string;
      keyBody: string;
      errorTitle: (params: Readonly<{ name: string; machine: string }>) => string;
      errorBody: string;
      cantrunTitle: (params: Readonly<{ name: string; machine: string }>) => string;
      cantrunBody: (params: Readonly<{ runtime: string }>) => string;
    }>;
  }>;
}>;


/** Configuration (md C): the catalog entry's values, edited in place and saved on blur. */
export type McpConfigTranslation = Readonly<{
  transport: string;
  command: string;
  commandDescription: string;
  arguments: string;
  argument: (params: Readonly<{ position: number }>) => string;
  removeArgument: (params: Readonly<{ position: number }>) => string;
  addArgument: string;
  workingFolder: string;
  workingFolderDescription: string;
  sessionFolder: string;
  aFolder: string;
  folderPath: string;
  environment: string;
  environmentDescription: string;
  addVariable: string;
  address: string;
  addressDescription: string;
  headers: string;
  headersDescription: string;
  addHeader: string;
  saved: string;
  saving: string;
  saveFailed: string;
  different: string;
  differentNone: string;
  differentOne: (params: Readonly<{ machine: string }>) => string;
  differentOn: (params: Readonly<{ machine: string }>) => string;
  addDifference: string;
  addAnother: string;
  differentCount: (params: Readonly<{ count: number }>) => string;
  differsFolder: (params: Readonly<{ path: string }>) => string;
  differsCommand: string;
  differsArguments: string;
  differsAddress: string;
  differsValues: (params: Readonly<{ names: string }>) => string;
  inFolderOn: (params: Readonly<{ folder: string; machine: string }>) => string;
  removeDifference: string;
}>;

export type McpPageBase = Omit<McpPageTranslation, 'config'>;

const configEn: McpConfigTranslation = {
  transport: 'Runs as',
  command: 'Command',
  commandDescription: 'The program each machine starts.',
  arguments: 'Arguments',
  argument: ({ position }) => `Argument ${position}`,
  removeArgument: ({ position }) => `Remove argument ${position}`,
  addArgument: 'Add an argument',
  workingFolder: 'Working folder',
  workingFolderDescription: 'Where the program starts.',
  sessionFolder: 'The session’s project folder',
  aFolder: 'A folder on the machine',
  folderPath: 'Folder',
  environment: 'Environment',
  environmentDescription: 'Values the program reads. Secrets stay end-to-end encrypted and are only written into the session on the machine.',
  addVariable: 'Add a variable',
  address: 'Address',
  addressDescription: 'Where Happier connects; every machine uses the same one.',
  headers: 'Headers',
  headersDescription: 'Sent with every request. A secret shows its name, never its value.',
  addHeader: 'Add a header',
  saved: 'Saved · applies to new sessions',
  saving: 'Saving…',
  saveFailed: 'Couldn’t save. Your edit is still here.',
  different: 'Different on a machine…',
  differentNone: 'Every machine uses these values',
  differentOne: ({ machine }) => `${machine} is different`,
  differentOn: ({ machine }) => `Different on ${machine}`,
  addDifference: 'Add a machine difference',
  addAnother: 'Another machine',
  differentCount: ({ count }) => `${count} machines are different`,
  differsFolder: ({ path }) => `Working folder ${path}`,
  differsCommand: 'Command',
  differsArguments: 'Arguments',
  differsAddress: 'Address',
  differsValues: ({ names }) => names,
  inFolderOn: ({ folder, machine }) => `In ${folder} on ${machine}`,
  removeDifference: 'Remove',
};

const en: McpPageBase = {
  allServers: 'All servers',
  foundOnMachines: 'Found on your machines',
  inUse: 'In use',
  off: 'Off',
  fromPlugins: 'From plugins',
  builtIn: 'Built in',
  builtInHappier: 'Happier',
  builtInHappierDescription: 'Sessions, files, machines and your Actions',
  builtInActions: 'Actions',
  remote: 'Remote',
  local: 'Local',
  tools: {
    title: 'Tools',
    description: 'What your agents may call. Ask shows an approval card, Allow runs without asking, Off hides the tool.',
    defaultTitle: 'Default for tools',
    defaultAsk: 'Ask',
    defaultReadOnly: 'Allow read-only',
    defaultAll: 'Allow all',
    defaultAskDescription: 'Every tool asks first. A tool you set yourself keeps its setting.',
    defaultReadOnlyDescription: 'Read-only tools run without asking; anything that writes asks first. A tool you set yourself keeps its setting.',
    defaultAllDescription: 'Every tool runs without asking. A tool you set yourself keeps its setting.',
    off: 'Off',
    ask: 'Ask',
    allow: 'Allow',
    search: ({ count }) => `Search ${count} tools`,
    filterAll: 'All',
    filterReadOnly: 'Read-only',
    filterWrites: 'Writes',
    filterDestructive: 'Destructive',
    filterSetByYou: 'Set by you',
    readOnly: 'Read-only',
    writes: 'Writes',
    destructive: 'Destructive',
    setByYou: 'Set by you',
    backToDefault: ({ value }) => `Set by you · use the default (${value}) again`,
    useDefault: ({ value }) => `Use the default (${value})`,
    showAll: ({ count }) => `Show all ${count} tools`,
    cost: ({ count, tokens }) => `${count} ${count === 1 ? 'tool' : 'tools'} · ${tokens} tokens when they all load.`,
    onDemand: ({ agents, count }) => `${agents} ${agents.includes(' and ') ? 'load' : 'loads'} a tool only when it needs it; other agents load all ${count} when a session starts.`,
    notApply: ({ agents }) => `Tool settings don’t apply to ${agents}: they decide for themselves.`,
    blocked: ({ agents }) => `In ${agents}, Off blocks a tool when it’s called instead of hiding it.`,
    hiddenRestart: ({ agents }) => `Turning a hidden tool back on applies to new ${agents} sessions.`,
    notListed: 'Its tools appear after the first Test on a machine.',
    lastListed: ({ date }) => `Last listed ${date}. They come back when the sign-in does.`,
    loadFailed: 'Couldn’t read its tools.',
    noMatch: 'No tools match.',
    setFailed: 'Couldn’t save that. Try again.',
  },
  detail: {
    configurationTitle: 'Configuration',
    configurationDescription: 'Edit any value in place; it applies to new sessions on every machine.',
    machinesDescription: 'Happier connects from each machine, so each one is checked.',
    test: 'Test',
    onNowhere: 'It isn’t on for any machine yet.',
    toolsOn: ({ count }) => `${count} ${count === 1 ? 'tool' : 'tools'}`,
    checked: ({ time }) => `checked ${time}`,
    notChecked: 'not checked yet',
    lastKnown: ({ time }) => `last known ${time}`,
    summary: ({ ready, problems, offline, unchecked }) => {
      const total = ready + problems + offline + unchecked;
      if (total > 1 && ready === total) return `Ready on all ${total}`;
      if (total > 1 && offline === total) return `All ${total} offline`;
      return [
        ready > 0 ? `Ready on ${ready}` : null,
        problems > 0 ? `${problems} need${problems === 1 ? 's' : ''} a look` : null,
        unchecked > 0 ? `${unchecked} to test` : null,
        offline > 0 ? `${offline} offline` : null,
      ].filter(Boolean).join(' · ');
    },
    detailsTitle: 'Details',
    versionLine: ({ version, protocol }) => protocol ? `Version ${version} · protocol ${protocol}` : `Version ${version}`,
    update: {
      title: 'Updates',
      upToDate: 'Up to date',
      available: ({ version }) => `Version ${version} is available`,
      checkFailed: 'Couldn’t check for updates',
      removed: 'The registry no longer lists this server. It keeps working as it is.',
      checkNow: 'Check now',
      review: 'Review',
      readFailed: 'Couldn’t read the new version. Try again.',
      changesTitle: ({ version }) => `Update to ${version}`,
      changesBody: 'Your name, values, tools and where it’s on stay as they are.',
      now: 'Now',
      after: 'After the update',
      apply: 'Update',
      applyFailed: 'Couldn’t update. Your choices are kept.',
    },
    serverInstructions: 'Server instructions',
    lastError: 'Last test output',
    copy: 'Copy',
    removeServer: 'Remove server',
    removeFootnote: 'Takes it out of every session on every machine and deletes its sign-in.',
    conflict: {
      reason: 'Changed elsewhere',
      review: 'Review',
      title: 'Review the changes',
      description: 'This server changed on another device while you were editing it. Choose which values stay.',
      current: 'Current',
      yours: 'Yours',
      notSet: 'Not set',
      machines: 'Machine differences',
      keepMine: 'Keep mine',
      useCurrent: 'Use current',
      removedTitle: 'Removed elsewhere',
      removedDescription: 'This server was removed on another device. Your edits can’t be saved.',
      discard: 'Discard my edits',
    },
    copyInstallLink: 'Copy install link',
    installLinkLabel: 'Install link',
    duplicate: 'Duplicate',
    fromPlugin: ({ plugin }) => `From ${plugin}`,
    pluginFootnote: ({ plugin }) => `Comes with ${plugin}. Uninstall the plugin to remove it.`,
    banner: {
      expiredTitle: ({ name }) => `${name}’s sign-in expired`,
      expiredBody: ({ name, date, count }) => `${name} stopped accepting it${date ? ` on ${date}` : ''}. Sessions start without its ${count ? `${count} tools` : 'tools'} until you reconnect. Reconnecting once works on every machine.`,
      signinTitle: ({ name }) => `Sign in to ${name}`,
      signinBody: 'Sessions start without its tools until you sign in. Signing in once works on every machine.',
      moreAccessTitle: ({ name }) => `${name} needs more access`,
      moreAccessBody: 'A tool asked for access your sign-in doesn’t have. Grant it once and every machine follows.',
      revokedTitle: ({ name }) => `${name} no longer has access`,
      revokedBody: 'The sign-in was revoked. Sessions start without its tools until you sign in again.',
      keyTitle: ({ name }) => `${name} needs a key`,
      keyBody: 'A value it needs isn’t saved yet. Sessions start without it until you add one.',
      errorTitle: ({ name, machine }) => `${name} stopped on ${machine}`,
      errorBody: 'Sessions there start without its tools. The last test output is under Details.',
      cantrunTitle: ({ name, machine }) => `${name} can’t run on ${machine}`,
      cantrunBody: ({ runtime }) => `That machine needs ${runtime}. Sessions there start without it; other machines are fine.`,
    },
  },
};

export const mcpPageTranslations = {
  en: { ...en, config: configEn },
} as const satisfies Pick<Record<string, McpPageTranslation>, 'en'>;
