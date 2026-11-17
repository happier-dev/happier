// Skill detail and new-skill draft copy (P6 U6.3, sd D/E/Dp, sx X1/X2). Mounted under `capabilities.skillDetail`.

type Count = Readonly<{ count: number }>;

export type SkillDetailTranslation = Readonly<{
  whereDescription: string;
  tokensWhenUsed: (params: Readonly<{ tokens: string }>) => string;
  menu: Readonly<{
    duplicate: string;
    makeCopy: string;
    moveToFolder: string;
    noFolder: string;
    exportZip: string;
    copyLink: string;
    linkCopied: string;
  }>;
  banner: Readonly<{
    couldntLoadTitle: string;
    couldntLoadBody: string;
  }>;
  instructions: Readonly<{
    title: string;
    edit: string;
    done: string;
    preview: string;
    showAll: string;
    showLess: string;
    saving: string;
    saved: string;
    saveFailed: string;
    conflict: string;
    reviewBoth: string;
    keepMine: string;
    takeTheirs: string;
    yours: string;
    theirs: string;
    lintOk: string;
    lintMissingName: string;
    lintMissingDescription: string;
    lintNoFrontmatter: string;
    readOnlyPlugin: string;
  }>;
  files: Readonly<{
    title: string;
    description: (params: Count) => string;
    descriptionScripts: (
      params: Readonly<{ count: number; scripts: number }>,
    ) => string;
    script: string;
    addFile: string;
    addFilePrompt: string;
    addFilePlaceholder: string;
    remove: string;
    removeTitle: (params: Readonly<{ path: string }>) => string;
    removeBody: string;
    more: (params: Count) => string;
    binary: string;
    loading: string;
    afterAdd: string;
  }>;
  source: Readonly<{
    title: string;
    descriptionReview: string;
    descriptionAuto: string;
    descriptionPinned: string;
    descriptionOwn: string;
    writtenByYou: string;
    writtenByYouBody: string;
    uploadedByYou: string;
    foundOn: (params: Readonly<{ machine: string }>) => string;
    foundOnBody: (params: Readonly<{ path: string }>) => string;
    firstParty: string;
    verifiedByDigest: string;
    noDigestPublished: string;
    added: (params: Readonly<{ date: string }>) => string;
    updates: string;
    upToDate: string;
    updateAvailable: string;
    removedFromSource: string;
    notChecked: string;
    checked: (params: Readonly<{ time: string }>) => string;
    checkNow: string;
    view: string;
    auto: string;
    autoBody: string;
    pin: string;
    pinBody: string;
    checkFailed: string;
  }>;
  machines: Readonly<{
    description: string;
    nowhere: string;
    offline: string;
    lastKnown: (params: Readonly<{ time: string }>) => string;
    masked: (params: Readonly<{ agent: string; machine: string }>) => string;
    cantLoad: (params: Readonly<{ agents: string }>) => string;
    previewFailed: (params: Readonly<{ agent: string }>) => string;
    checking: string;
    projectNote: string;
    noAgent: string;
    offlineCount: (params: Count) => string;
    summaryOn: (params: Readonly<{ agents: string; machine: string }>) => string;
    summaryOnMany: (params: Readonly<{ agents: string; count: number }>) => string;
  }>;
  details: Readonly<{
    title: string;
    summary: string;
    revision: string;
    contentHash: string;
    alsoInstall: (params: Readonly<{ machine: string }>) => string;
    alsoInstallBody: string;
    installed: string;
    install: string;
  }>;
  leave: Readonly<{
    remove: string;
    footnote: string;
    confirmTitle: (params: Readonly<{ name: string }>) => string;
    confirmBody: string;
    confirm: string;
  }>;
  draft: Readonly<{
    title: string;
    purpose: string;
    add: string;
    adding: string;
    addFailed: string;
  }>;
}>;

const en: SkillDetailTranslation = {
  whereDescription:
    'Set it once and every machine follows. The most specific rule wins.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens when used`,
  menu: {
    duplicate: 'Duplicate',
    makeCopy: 'Make an editable copy',
    moveToFolder: 'Move to folder',
    noFolder: 'No folder',
    exportZip: 'Export as .zip',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
  },
  banner: {
    couldntLoadTitle: 'Couldn’t load this skill',
    couldntLoadBody:
      'Your library didn’t answer. Sessions keep the copy they already have.',
  },
  instructions: {
    title: 'Instructions',
    edit: 'Edit',
    done: 'Done',
    preview: 'Preview',
    showAll: 'Show all',
    showLess: 'Show less',
    saving: 'Saving…',
    saved: 'Saved · applies to new sessions',
    saveFailed: 'Couldn’t save. Your text is kept.',
    conflict: 'Changed on another device',
    reviewBoth: 'Review both',
    keepMine: 'Keep mine',
    takeTheirs: 'Take theirs',
    yours: 'Yours',
    theirs: 'Theirs',
    lintOk: 'Name and description are set',
    lintMissingName: 'Add a name to the frontmatter',
    lintMissingDescription: 'Add a description, so agents know when to use it',
    lintNoFrontmatter: 'Start with a frontmatter block: name and description',
    readOnlyPlugin: 'Ships with its plugin and follows its version.',
  },
  files: {
    title: 'Files',
    description: ({ count }) =>
      count === 1 ? '1 file, no scripts.' : `${count} files, no scripts.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} files, ${scripts === 1 ? '1 runs as a script' : `${scripts} run as scripts`}.`,
    script: 'Script',
    addFile: 'Add a file',
    addFilePrompt: 'Its path inside the skill.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Remove',
    removeTitle: ({ path }) => `Remove ${path}?`,
    removeBody: 'New sessions get the skill without it.',
    more: ({ count }) => `${count} more`,
    binary: 'Not a text file',
    loading: 'Opening…',
    afterAdd: 'Add more files once the skill is in your library.',
  },
  source: {
    title: 'Source and updates',
    descriptionReview: 'Changes from the source wait for your review.',
    descriptionAuto:
      'Changes from the source arrive on their own, unless you changed it.',
    descriptionPinned:
      'Pinned to a version. Changes from the source wait until you unpin.',
    descriptionOwn: 'Yours to change. Nothing updates it but you.',
    writtenByYou: 'Written by you',
    writtenByYouBody: 'Edit it here; every machine gets the change.',
    uploadedByYou: 'Uploaded by you',
    foundOn: ({ machine }) => `Found on ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Built into Happier · follows its version',
    verifiedByDigest: 'Verified by digest',
    noDigestPublished: 'No digest published',
    added: ({ date }) => `added ${date}`,
    updates: 'Updates',
    upToDate: 'Up to date',
    updateAvailable: 'Update available',
    removedFromSource: 'Its source no longer has it',
    notChecked: 'Not checked yet',
    checked: ({ time }) => `checked ${time}`,
    checkNow: 'Check now',
    view: 'View',
    auto: 'Update automatically',
    autoBody: 'Off for skills from other people, so you see every change first',
    pin: 'Pin to this version',
    pinBody: 'Keep this version until you unpin it',
    checkFailed: 'Couldn’t check the source',
  },
  machines: {
    description: 'What each machine’s agents get right now.',
    nowhere: 'It isn’t on for any machine yet.',
    offline: 'Machine offline',
    lastKnown: ({ time }) => `last known ${time}`,
    masked: ({ agent, machine }) => `${agent}: ${machine}’s own copy wins`,
    cantLoad: ({ agents }) => `${agents} can’t load skills here`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Checking…',
    projectNote: 'Inside a project, the project’s own copy can still win.',
    noAgent: 'No agent here gets it',
    offlineCount: ({ count }) => `${count} offline`,
    summaryOn: ({ agents, machine }) => `${agents} on ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} on ${count} machines`,
  },
  details: {
    title: 'Details',
    summary: 'Revision and copies outside Happier',
    revision: 'Revision',
    contentHash: 'Content hash',
    alsoInstall: ({ machine }) => `Also install on ${machine}`,
    alsoInstallBody:
      'For use outside Happier, in each agent’s own skills folder',
    installed: 'Installed',
    install: 'Install',
  },
  leave: {
    remove: 'Remove skill',
    footnote: 'Sessions running now keep it until they restart.',
    confirmTitle: ({ name }) => `Remove ${name}?`,
    confirmBody:
      'It leaves your library and every machine. Sessions running now keep it until they restart.',
    confirm: 'Remove',
  },
  draft: {
    title: 'New skill',
    purpose:
      'Teach your agents something once. They read the description to decide when to use it.',
    add: 'Add to library',
    adding: 'Adding…',
    addFailed: 'Couldn’t add the skill. Your text is kept.',
  },
};

export const skillDetailTranslations = {
  en,
} as const;
