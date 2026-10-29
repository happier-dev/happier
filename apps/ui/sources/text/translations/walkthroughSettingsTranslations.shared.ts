

export type Copy = typeof en;



export const en = {
    title: 'Walkthroughs', description: 'An AI-written reading order, with an explanation beside the exact changes and optional commit proposals. Runs on the machine that has the code.',
    enabled: 'Explain changes', enabledDescription: 'Add a reading order and explanations to a comparison. Files remain available without a model.',
    model: 'Summary model', modelDescription: 'Used for explanations, walkthroughs and commit proposals.', chooseModel: 'Choose a model', sessionModel: 'Session model', searchModels: 'Search models',
    unavailable: 'Model unavailable. Choose another.',
    loadModels: 'Find more models',
    loadFailed: 'Couldn’t load saved walkthroughs.',
    chooseModelFirst: 'Choose a summary model first.',
    outputLanguage: "Output language",
    outputLanguageDescription: "Explanations follow the app language unless you choose another. Code and references stay unchanged.",
    appLanguage: "App language",
    investigateSurroundingFiles: "Read surrounding files",
    investigateSurroundingFilesDescription: "Lets the writer check nearby files as they were before and after the change. Files are only read, never changed.",
    defaultModel: "Default",
    costLow: "Low cost",
    costStandard: "Standard cost",
    costPremium: "Premium cost",
    loadingModels: 'Loading models…',
    noModels: 'No models found',
    chooseMachineForModels: 'Choose a machine first to see its models.',
    loadModelsFailed: "Couldn’t load models. Try again.",
    startFailure: {
        notInstalled: { title: 'Not installed on this machine', next: 'Check its command and working directory, then try again.' },
        cannotRun: { title: 'Can’t run on this machine', next: 'Check its execution permissions, then try again.' },
        other: { title: 'Couldn’t start on this machine', next: 'Try again in a moment.' },
    },
    hiddenModels: ({ count }: { count: number }) => `${count} ${count === 1 ? 'model' : 'models'} can’t write walkthroughs`,
    automaticUnavailable: {
        signIn: 'Not picked automatically until you sign in on this machine.',
        authUnknown: 'Sign-in couldn’t be checked, so it isn’t picked automatically. Try again.',
        connected: 'Its connected account isn’t available, so it isn’t picked automatically. Check Connected services.',
    },
    moreAgents: "More agents",
    findModelsFor: ({ agent }: { agent: string }) => `Find models for ${agent}`,
    groupedUnavailable: {
        signIn: { title: ({ count }: { count: number }) => `${count} agents need you to sign in on this machine`, next: "They aren’t picked automatically until then. Choose one to find its models." },
        authUnknown: { title: ({ count }: { count: number }) => `Sign-in couldn’t be checked for ${count} agents`, next: "They aren’t picked automatically. Try again, or choose one to find its models." },
        connected: { title: ({ count }: { count: number }) => `Connected accounts aren’t available for ${count} agents`, next: "They aren’t picked automatically. Check Connected services." },
    },
    catalogNotice: {
        refreshFailed: { title: "Couldn’t refresh models", next: "Showing the last list. Try again." },
        accountMetadata: { title: "Some models may be missing", next: "Couldn’t read your connected accounts. Try again." },
    },
    chooseMachine: 'Choose a machine to see its saved walkthroughs.',
    waitingMachine: ({ machine }: { machine: string }) => `Waiting for ${machine}. Its saved walkthroughs appear once it responds.`,
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
