type Count = Readonly<{ count: number }>;
export type Labels = Readonly<{
  title: string;
  purpose: string;
  searchPlaceholder: string;
  groupBy: string;
  groupKind: string;
  groupMachine: string;
  groupProject: string;
  status: string;
  /** The present-tense line: what is managed, and on how many Machines when that is known. */
  present: (params: Count) => string;
  presentAcross: (
    params: Readonly<{ count: number; machines: number }>,
  ) => string;
  needYou: (params: Count) => string;
  /** Plugins that ship with Happier, counted apart from what the person added. */
  includedMore: (params: Count) => string;
  includedBody: string;
  partial: string;
  needsYou: string;
  all: (params: Count) => string;
  allUnknown: string;
  fewer: string;
  /** A kind section with nothing from the Machines that answered, and its way to browse that kind. */
  sectionNone: string;
  browserProfileEmpty: string;
  browseKind: string;
  sectionUnavailable: string;
  sectionPartial: string;
  /** A read that settled short of everything (a Machine or source didn't answer): no pending glyph. */
  sectionIncomplete: string;
  accountGroup: string;
  accountGroupBody: string;
  unassignedGroup: string;
  unassignedGroupBody: string;
  noProjectGroup: string;
  noProjectGroupBody: string;
  everyMachine: string;
  /** An App whose own page doesn't exist yet: said, never a spinner or a guessed route. */
  appNoPage: string;
  machineFallback: string;
  emptyTitle: string;
  emptyBody: string;
  browse: string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  noMatchFilters: string;
  clear: string;
  unavailable: string;
  machineTitle: string;
  machineBody: string;
  openInInstalled: string;
}>;

export const storeInstalledTranslations = {
  en: {
    title: 'Installed',
    purpose:
      'Everything Happier manages, on every Machine and in every project: where it runs, whether it’s fine, and what needs you.',
    searchPlaceholder: 'Search everything Happier manages',
    groupBy: 'Group by',
    groupKind: 'Kind',
    groupMachine: 'Machine',
    groupProject: 'Project',
    status: 'Status',
    present: ({ count }) =>
      count === 1
        ? 'Happier manages 1 thing for you.'
        : `Happier manages ${count} things for you.`,
    presentAcross: ({ count, machines }) =>
      `Happier manages ${count === 1 ? '1 thing' : `${count} things`} across ${machines === 1 ? '1 Machine' : `${machines} Machines`}.`,
    needYou: ({ count }) =>
      count === 1 ? '1 needs you.' : `${count} need you.`,
    includedMore: ({ count }) => `${count} more ${count === 1 ? 'is' : 'are'} included with Happier.`,
    includedBody: 'These ship with Happier and update with it.',
    partial: 'Some of it hasn’t loaded yet, so this may not be everything.',
    needsYou: 'Needs you',
    all: ({ count }) => `All ${count}`,
    allUnknown: 'All',
    fewer: 'Fewer',
    sectionNone: 'Nothing yet.',
    browserProfileEmpty: 'Browser profile with no extensions yet',
    browseKind: 'Browse',
    sectionUnavailable: 'Couldn’t load these right now.',
    sectionPartial: 'Some of these haven’t loaded yet.',
    sectionIncomplete: 'Some of these couldn’t be read, so this may not be everything.',
    accountGroup: 'Your account',
    accountGroupBody: 'Not tied to one Machine or project.',
    unassignedGroup: 'Not placed yet',
    unassignedGroupBody: 'Where these run isn’t known yet.',
    noProjectGroup: 'No project',
    noProjectGroupBody: 'Not associated with a project.',
    everyMachine: 'Every Machine',
    appNoPage: 'No page to open yet',
    machineFallback: 'A Machine',
    emptyTitle: 'Nothing here yet',
    emptyBody:
      'MCP servers, skills, agents, providers and plugins you add show up here, with where they run and what needs you.',
    browse: 'Browse the Store',
    noMatch: ({ query }) => `Nothing matches “${query}”`,
    noMatchFilters: 'Nothing matches these filters',
    clear: 'Clear',
    unavailable: 'Installed can’t be shown for this account right now.',
    machineTitle: 'What’s on this machine',
    machineBody: 'Everything Happier manages here.',
    openInInstalled: 'Open in Installed',
  },
} as const satisfies Pick<Record<string, Labels>, 'en'>;
