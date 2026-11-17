/** Pets that travel with templates and shared Bots (PET-SHARE): the Copy row, its outcome, and a viewer's "Add <pet>". */
export type PetShareWords = Readonly<{
  copyRow: string;
  copyRowOn: string;
  copyRowOff: string;
  copyRowUnavailable: string;
  copyCouldNotAdd: string;
  copyLibraryFull: string;
  copySyncOff: string;
  offerLine: string;
  offerAdd: string;
  offerCouldNotAdd: string;
  offerLibraryFull: string;
  offerSyncOff: string;
  offerUnreachable: string;
  chooserRegistryNote: string;
}>;

const en: PetShareWords = {
    copyRow: 'Pet: {name}',
    copyRowOn: 'Joins your pets, and your copy wears it.',
    copyRowOff: 'Your copy wears its own face.',
    copyRowUnavailable: "Pets aren't on for this Home, so your copy wears its own face.",
    copyCouldNotAdd:
      "Couldn't add {name} to your pets, so {bot} wears its own face.",
    copyLibraryFull: 'Your pets are full, so {bot} wears its own face.',
    copySyncOff: 'Pet sync is off, so {bot} wears its own face.',
    offerLine: "Its face is a pet you don't have yet.",
    offerAdd: 'Add {name}',
    offerCouldNotAdd: "Couldn't add {name}.",
    offerLibraryFull: 'Your pets are full. Remove one in Settings › Pets.',
    offerSyncOff: 'Adding pets needs pet sync.',
    offerUnreachable: "Couldn't reach {name}'s catalog.",
    chooserRegistryNote:
      'People you share this Bot with see {name} once they add it.',
};

const fill = (text: string, values: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

/** Builds one locale's copy; each locale root supplies its own words. */
export function petShareCopy(w: PetShareWords) {
  return {
    copyRow: ({ name }: { name: string }) => fill(w.copyRow, { name }),
    copyRowOn: w.copyRowOn,
    copyRowOff: w.copyRowOff,
    copyRowUnavailable: w.copyRowUnavailable,
    copyCouldNotAdd: ({ name, bot }: { name: string; bot: string }) =>
      fill(w.copyCouldNotAdd, { name, bot }),
    copyLibraryFull: ({ bot }: { bot: string }) =>
      fill(w.copyLibraryFull, { bot }),
    copySyncOff: ({ bot }: { bot: string }) => fill(w.copySyncOff, { bot }),
    offerLine: w.offerLine,
    offerAdd: ({ name }: { name: string }) => fill(w.offerAdd, { name }),
    offerCouldNotAdd: ({ name }: { name: string }) =>
      fill(w.offerCouldNotAdd, { name }),
    offerLibraryFull: w.offerLibraryFull,
    offerSyncOff: w.offerSyncOff,
    offerUnreachable: ({ name }: { name: string }) =>
      fill(w.offerUnreachable, { name }),
    chooserRegistryNote: ({ name }: { name: string }) =>
      fill(w.chooserRegistryNote, { name }),
  };
}

export const petShareTranslations = {
  en: petShareCopy(en),
};
