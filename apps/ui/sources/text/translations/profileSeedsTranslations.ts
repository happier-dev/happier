// "Skills this Profile adds" in the Profile editor (P6 U6.12): mounted under `capabilities.profileSeeds`.

export type ProfileSeedsTranslation = Readonly<{
  title: string;
  description: string;
  add: string;
  /** Names the picker (the phone sheet's title). */
  addTitle: string;
  searchPlaceholder: string;
  nothingToAdd: string;
  empty: string;
  emptyLibrary: string;
  openSkills: string;
  missing: string;
  /** The row of a seed whose library has not answered: never the raw id. */
  pending: string;
  /** A seed the library knows but cannot open right now: named, never called missing. */
  unreadableItem: string;
  remove: ({ skill }: { skill: string }) => string;
  reading: string;
  unreadable: string;
  tryAgain: string;
}>;

const en: ProfileSeedsTranslation = {
  title: 'Skills this Profile adds',
  description: 'Added for sessions with this Profile, on top of what your rules give.',
  add: 'Add',
  addTitle: 'Add a skill',
  searchPlaceholder: 'Search your skills',
  nothingToAdd: 'Every skill in your library is already added.',
  empty: 'None yet. Sessions with this Profile get what your rules give.',
  emptyLibrary: 'Your library has no skills yet.',
  openSkills: 'Open Skills',
  missing: 'Not in your library',
  pending: 'Skill',
  unreadableItem: 'Can’t be read right now',
  remove: ({ skill }) => `Remove ${skill}`,
  reading: 'Reading your skills…',
  unreadable: 'Couldn’t read your skills',
  tryAgain: 'Try again',
};

export const profileSeedsTranslations = { en, } as const;
