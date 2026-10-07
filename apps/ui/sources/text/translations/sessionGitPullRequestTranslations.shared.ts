

export type ProviderArgs = { provider: string };



export type GitPullRequestCopy = typeof en;



export const en = {
    form: {
        title: 'New pull request',
        expand: 'Open in a Details pane',
        moveBack: 'Move back to the sidebar',
        close: 'Close the form (the draft is kept)',
        base: 'Merges into',
        titlePlaceholder: 'Title',
        bodyPlaceholder: 'What changed and why',
        draft: 'Draft',
        create: 'Create pull request',
        creating: 'Creating…',
        continueOn: ({ provider }: ProviderArgs) => `Continue on ${provider}`,
        pointer: 'The new pull request is open in Details',
        pointerShow: 'Show',
        openedProviderPage: ({ provider }: ProviderArgs) => `${provider} is open to finish it; your text is kept here.`,
    },
    failure: {
        authFailed: ({ provider }: ProviderArgs) => `${provider} didn’t accept the sign-in from this machine`,
        network: ({ provider }: ProviderArgs) => `Couldn’t reach ${provider}`,
        machineOffline: 'The machine is offline; your draft is kept',
        blocked: 'Another Git operation is running; try again when it finishes',
        other: 'The pull request wasn’t created',
    },
    card: {
        number: ({ number }: { number: number }) => `#${number}`,
        intoBase: ({ base }: { base: string }) => `into ${base}`,
        state: { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', unknown: 'Pull request' },
        checks: { pending: 'Checks running', success: 'Checks passed', failure: 'Checks failed', unknown: 'Checks' },
        openOn: ({ provider }: ProviderArgs) => `Open on ${provider}`,
        copyLink: 'Copy link',
        copied: 'Link copied',
    },
    settings: {
        placementTitle: 'Open new pull requests in',
        placementDescription: 'On a phone the form always opens as its own page.',
        sidebar: 'Sidebar',
        details: 'Details pane',
    },
};


export const sessionGitPullRequestTranslationsEnglish = { en };