// "Found on your machines" copy (P6 U6.5, sf F/Fp) and the opt-in "Also install on this machine" receipts
// on the skill detail. Mounted under `capabilities.skillsFound`.

export type SkillsFoundTranslation = Readonly<{
  title: string;
  purpose: string;
  checkAgain: string;
  add: string;
  addAll: (params: Readonly<{ count: number }>) => string;
  makeCopy: string;
  compare: string;
  hideCompare: string;
  inLibrary: string;
  adding: string;
  plugin: string;
  readBy: (params: Readonly<{ agents: string; count: number }>) => string;
  fromPlugin: (params: Readonly<{ plugin: string }>) => string;
  installedByHappier: string;
  masks: (params: Readonly<{ machine: string }>) => string;
  more: (params: Readonly<{ count: number }>) => string;
  showFewer: string;
  looking: string;
  nothingHere: string;
  quietEmpty: (params: Readonly<{ count: number; others: boolean }>) => string;
  quietLooking: (params: Readonly<{ count: number }>) => string;
  lastKnown: (params: Readonly<{ time: string }>) => string;
  offlineBring: (params: Readonly<{ machine: string }>) => string;
  offlineUnseen: (params: Readonly<{ count: number }>) => string;
  scanFailed: (params: Readonly<{ machine: string }>) => string;
  tryAgain: string;
  olderMachine: (params: Readonly<{ machine: string }>) => string;
  rootFailed: (params: Readonly<{ path: string }>) => string;
  noMachinesTitle: string;
  noMachinesBody: string;
  addFailed: (params: Readonly<{ name: string }>) => string;
  compareYours: string;
  compareTheirs: (params: Readonly<{ machine: string }>) => string;
  compareFailed: (params: Readonly<{ machine: string }>) => string;
  destination: string;
  homeBody: string;
  seeAll: (params: Readonly<{ count: number }>) => string;
  alreadyOnMachines: (params: Readonly<{ count: number }>) => string;
  install: Readonly<{
    installedIn: (params: Readonly<{ path: string }>) => string;
    externallyModified: (params: Readonly<{ machine: string }>) => string;
    removeAnyway: string;
    removeTitle: (params: Readonly<{ machine: string }>) => string;
    removeBody: string;
    remove: string;
    nativeConflict: (params: Readonly<{ machine: string }>) => string;
    failed: (params: Readonly<{ machine: string }>) => string;
    removeFailed: (params: Readonly<{ machine: string }>) => string;
    partial: (params: Readonly<{ machine: string }>) => string;
  }>;
}>;

export const en: SkillsFoundTranslation = {
  title: 'Found on your machines',
  purpose:
    'Skills your agents already keep on each machine. Happier never edits them. Add one to your library to have it on every machine.',
  checkAgain: 'Check again',
  add: 'Add to library',
  addAll: ({ count }) => `Add all ${count}`,
  makeCopy: 'Make a copy',
  compare: 'Compare',
  hideCompare: 'Hide',
  inLibrary: 'In your library',
  adding: 'Adding…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} reads it` : `${agents} read it`,
  fromPlugin: ({ plugin }) => `From the ${plugin} plugin`,
  installedByHappier: 'Installed by Happier',
  masks: ({ machine }) =>
    `Your library has a skill with this name. On ${machine} this copy wins, so agents there use it instead.`,
  more: ({ count }) => `${count} more`,
  showFewer: 'Show fewer',
  looking: 'Looking…',
  nothingHere: 'No skills found here.',
  quietEmpty: ({ count, others }) =>
    `No skills found on ${count} ${others ? 'other ' : ''}${count === 1 ? 'machine' : 'machines'}`,
  quietLooking: ({ count }) =>
    `Looking on ${count} ${count === 1 ? 'machine' : 'machines'}…`,
  lastKnown: ({ time }) => `last known ${time}`,
  offlineBring: ({ machine }) => `Bring ${machine} online to add from it.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 offline machine hasn't been looked at yet. Bring it online to see its skills.`
      : `${count} offline machines haven't been looked at yet. Bring one online to see its skills.`,
  scanFailed: ({ machine }) => `Couldn't read ${machine}'s skills`,
  tryAgain: 'Try again',
  olderMachine: ({ machine }) =>
    `${machine} needs a newer Happier to list its skills.`,
  rootFailed: ({ path }) => `Couldn't read ${path}`,
  noMachinesTitle: 'No machines yet',
  noMachinesBody:
    'Connect a machine to see the skills your agents already keep on it.',
  addFailed: ({ name }) => `Couldn't add ${name}. Nothing changed.`,
  compareYours: 'Your library',
  compareTheirs: ({ machine }) => `On ${machine}`,
  compareFailed: ({ machine }) => `Couldn't read the copy on ${machine}.`,
  destination: 'Found on your machines',
  homeBody:
    "Already in your agents' own folders. Add one to your library and it follows you everywhere.",
  seeAll: ({ count }) => `See all ${count}`,
  alreadyOnMachines: ({ count }) => `${count} skills are already on your machines`,
  install: {
    installedIn: ({ path }) => `Installed in ${path}`,
    externallyModified: ({ machine }) =>
      `The copy on ${machine} was edited outside Happier, so it was left as it is.`,
    removeAnyway: 'Remove anyway',
    removeTitle: ({ machine }) => `Remove from ${machine}?`,
    removeBody:
      'This deletes the copy Happier put in the agent folders there. Your library keeps the skill.',
    remove: 'Remove',
    nativeConflict: ({ machine }) =>
      `${machine} already has a different skill with this name in an agent folder. Happier left it alone.`,
    failed: ({ machine }) => `Couldn't install on ${machine}. Nothing changed.`,
    removeFailed: ({ machine }) => `Couldn't remove it from ${machine}.`,
    partial: ({ machine }) =>
      `Installed on ${machine} for some agents. Others couldn't be written.`,
  },
};

export const skillsFoundTranslations = {
  en,
} as const;
