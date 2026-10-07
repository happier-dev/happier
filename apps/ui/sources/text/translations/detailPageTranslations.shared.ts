

export type DetailPageTranslations = Readonly<{
    approval: Readonly<{
        requestTitle: string;
        requestDescription: string;
        failureTitle: string;
        homeUnavailableTitle: string;
        contextTitle: string;
        contextDescription: string;
        proposalsDescription: string;
    }>;
    runs: Readonly<{
        description: string;
        filterLabel: string;
        filterRunning: string;
        filterAll: string;
        onHome: (params: Readonly<{ home: string }>) => string;
    }>;
    person: Readonly<{
        placeholderTitle: string;
        friendshipTitle: string;
        sharedSessionsDescription: string;
        linkedAccountsTitle: string;
        linkedAccountsDescription: string;
    }>;
    friendsManage: Readonly<{
        description: string;
        requestsTitle: string;
        requestsDescription: string;
        sentTitle: string;
        sentDescription: string;
        friendsTitle: string;
        friendsDescription: string;
    }>;
}>;


export const detailPageTranslationsEnglish = { en: {
        approval: {
            requestTitle: 'Request',
            requestDescription: 'What was asked and where it stands.',
            failureTitle: 'Why it failed',
            homeUnavailableTitle: 'Home unavailable',
            contextTitle: 'Requested by',
            contextDescription: 'The session and agent that asked for this.',
            proposalsDescription: 'Posted to the review if you approve.',
        },
        runs: {
            description: 'Background runs on your machines.',
            filterLabel: 'Runs to show',
            filterRunning: 'Running',
            filterAll: 'All',
            onHome: ({ home }) => `On ${home}`,
        },
        person: {
            placeholderTitle: 'Person',
            friendshipTitle: 'Friendship',
            sharedSessionsDescription: 'Sessions this friend shares with you, view only.',
            linkedAccountsTitle: 'Linked accounts',
            linkedAccountsDescription: 'Where else they sign in. Opens in your browser.',
        },
        friendsManage: {
            description: 'People you work with on Happier, and requests between you.',
            requestsTitle: 'Friend requests',
            requestsDescription: 'Open a request to accept or decline it.',
            sentTitle: 'Sent requests',
            sentDescription: 'Waiting for them to accept.',
            friendsTitle: 'Friends',
            friendsDescription: 'Open a friend to see what they share with you.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "en">;