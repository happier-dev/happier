

export type Copy = typeof en;



export const en = {
    title: 'Walkthroughs', description: 'An AI-written reading order, with an explanation beside the exact changes and optional commit proposals. Runs on the machine that has the code.',
    enabled: 'Explain changes', enabledDescription: 'Add a reading order and explanations to a comparison. Files remain available without a model.',
    model: 'Summary model', modelDescription: 'Used for explanations, walkthroughs and commit proposals.', chooseModel: 'Choose a model', searchModels: 'Search models',
    unsupported: 'Can’t write walkthroughs', unavailable: 'Model unavailable. Choose another.',
    prefetch: 'Prepare after each turn', prefetchDescription: 'Prepares a walkthrough when the agent finishes a turn.',
    saved: 'Saved walkthroughs', savedDescription: 'Saved on this machine, including your edits.', clear: 'Clear',
    unavailableData: 'Reconnect the machine to load saved walkthroughs and costs.', costUnavailable: 'Last 7 days · cost unavailable',
    clearTitle: 'Clear saved walkthroughs?', clearDescription: ({ machine }: { machine: string }) => `Delete saved walkthroughs and your manual edits on ${machine}, plus your review marks for those comparisons. Other machines are not affected.`,
    savedCount: ({ count, bytes }: { count: number; bytes: string }) => `${count} saved · ${bytes}`,
    cost: ({ amount, partial }: { amount: string; partial: boolean }) => `Last 7 days · ${amount}${partial ? ' · some costs unavailable' : ''}`,
    clearFailed: 'Some walkthroughs could not be cleared. Reload and try again.',
};



export const copy = (value: Copy) => ({ walkthroughSettings: value });


export const walkthroughSettingsTranslationsEnglish = { en: copy(en) };