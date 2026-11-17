// Skills homepage destinations (P6 U6.6/U6.7 and the registries shelf): Updates with its per-file
// choices, first-run "Choose what's on", and "From your registries". Mounted under `capabilities.skillsUpdates`.

type Count = Readonly<{ count: number }>;

export type SkillsUpdatesTranslation = Readonly<{
  updates: Readonly<{
    title: string;
    purpose: string;
    checkNow: string;
    checking: string;
    readyTitle: string;
    readyBody: string;
    choiceTitle: string;
    choiceBody: (params: Readonly<{ name: string }>) => string;
    refChange: (params: Readonly<{ from: string; to: string }>) => string;
    newerWaiting: string;
    linesChanged: (params: Readonly<{ count: number; file: string }>) => string;
    filesChanged: (params: Count) => string;
    viewChanges: string;
    hideChanges: string;
    update: string;
    fileDiffers: (params: Count) => string;
    fileTheirsOnly: string;
    fileMineOnly: string;
    fileUnchanged: string;
    nothingToChoose: string;
    keepNote: (params: Readonly<{ name: string }>) => string;
    notNow: string;
    applyChoices: string;
    upToDate: string;
    noSources: string;
    updatedTitle: string;
    checkedAt: (params: Readonly<{ time: string }>) => string;
    checkFailed: string;
    diffFailed: string;
    applyFailed: string;
    applied: (params: Readonly<{ ref: string }>) => string;
    tryAgain: string;
  }>;
  choose: Readonly<{
    purpose: (params: Readonly<{ total: number; off: number }>) => string;
    purposeIdle: string;
    migratedTitle: (params: Count) => string;
    migratedBody: (params: Readonly<{ names: string }>) => string;
    listTitle: string;
    selectAll: string;
    selectNone: string;
    usedOn: (params: Readonly<{ date: string }>) => string;
    selected: (params: Count) => string;
    turnOn: (params: Count) => string;
    failed: string;
    nothingWaits: string;
  }>;
  shelf: Readonly<{
    title: string;
    titleNew: string;
    browseAll: string;
    fromSource: (params: Readonly<{ source: string }>) => string;
    add: string;
    inLibrary: string;
    addFailed: string;
  }>;
}>;

const en: SkillsUpdatesTranslation = {
  updates: {
    title: 'Updates',
    purpose:
      'Newer versions from the places your skills came from. Nothing changes until you choose.',
    checkNow: 'Check now',
    checking: 'Checking…',
    readyTitle: 'Ready to update',
    readyBody: 'You haven’t changed these, so taking the update is safe.',
    choiceTitle: 'Needs your choice',
    choiceBody: ({ name }) =>
      `You edited ${name}, and its source has a newer version. Choose per file; both sides are shown.`,
    refChange: ({ from, to }) => `from ${from} to ${to}`,
    newerWaiting: 'A newer version is waiting',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'line' : 'lines'} changed in ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'file' : 'files'} changed`,
    viewChanges: 'View changes',
    hideChanges: 'Hide changes',
    update: 'Update',
    fileDiffers: ({ count }) =>
      `Yours and theirs differ · ${count} ${count === 1 ? 'line' : 'lines'}`,
    fileTheirsOnly: 'New in theirs',
    fileMineOnly: 'Only in yours',
    fileUnchanged: 'Unchanged',
    nothingToChoose: 'Nothing to choose',
    keepNote: ({ name }) =>
      `Keeping any file of yours keeps ${name} marked Modified, so later updates still ask.`,
    notNow: 'Not now',
    applyChoices: 'Apply choices',
    upToDate: 'Everything is up to date',
    noSources: 'None of your skills come from a source that updates. Skills you add from GitHub or a registry show their newer versions here.',
    updatedTitle: 'Updated',
    checkedAt: ({ time }) => `Checked ${time}`,
    checkFailed: 'Couldn’t check for updates.',
    diffFailed: 'Couldn’t load the changes.',
    applyFailed: 'Couldn’t update it.',
    applied: ({ ref }) => `Updated to ${ref}`,
    tryAgain: 'Try again',
  },
  choose: {
    purpose: ({ total, off }) =>
      `You have ${total} skills in your library. ${off} stay off until you choose, so your sessions don’t change yet.`,
    purposeIdle: 'Decide which of your skills your agents get.',
    migratedTitle: ({ count }) =>
      `${count} ${count === 1 ? 'is' : 'are'} already on, where you used ${count === 1 ? 'it' : 'them'}`,
    migratedBody: ({ names }) =>
      `${names} came from your Account or project context, so they stay on where you used them.`,
    listTitle: 'Choose what your agents get',
    selectAll: 'Select all',
    selectNone: 'Select none',
    usedOn: ({ date }) => `Used ${date}`,
    selected: ({ count }) => `${count} selected`,
    turnOn: ({ count }) => `Turn on ${count} everywhere`,
    failed: 'Couldn’t turn them on. Your choices are kept.',
    nothingWaits:
      'Every skill already has a place. Turn one on or narrow it from its own page.',
  },
  shelf: {
    title: 'From your registries',
    titleNew: 'Start with one of these',
    browseAll: 'Browse all',
    fromSource: ({ source }) => `New and popular on ${source}.`,
    add: 'Add',
    inLibrary: 'In your library',
    addFailed: 'Couldn’t add it',
  },
};

export const skillsUpdatesTranslations = {
  en,
} as const;
