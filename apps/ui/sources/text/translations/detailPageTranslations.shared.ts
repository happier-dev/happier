

export type DetailPageTranslations = Readonly<{
    approval: Readonly<{
        requestTitle: string;
        requestDescription: string;
        failureTitle: string;
        homeUnavailableTitle: string;
        contextTitle: string;
        contextDescription: string;
        sessionOnHome: (params: Readonly<{ home: string }>) => string;
        sessionElsewhere: string;
        requesterYou: string;
        requesterGuard: string;
        requesterGuardDescription: string;
        origin: Readonly<Record<'voice' | 'agent' | 'mcp' | 'cli' | 'ui' | 'api' | 'plugin' | 'workflowRun' | 'system', string>>;
        proposalsDescription: string;
        requester: Readonly<{
            title: string;
            descriptionYou: string;
            descriptionOther: (params: Readonly<{ name: string }>) => string;
            askedBy: string;
            anotherPerson: string;
            waitingFor: (params: Readonly<{ name: string }>) => string;
            confirmedBy: string;
            declinedBy: string;
            thread: Readonly<{
                youConfirm: string;
                review: string;
                waiting: (params: Readonly<{ name: string }>) => string;
                using: (params: Readonly<{ label: string }>) => string;
                usingAccount: string;
                usingTeam: string;
                ownerAccount: (params: Readonly<{ name: string }>) => string;
                ownerTeam: (params: Readonly<{ name: string }>) => string;
                ownerTeamUnnamed: string;
                why: string;
                confirmedPending: (params: Readonly<{ name: string }>) => string;
                done: (params: Readonly<{ name: string }>) => string;
                declined: (params: Readonly<{ name: string }>) => string;
                canceled: string;
                uncertain: string;
                failed: string;
            }>;
        }>;
    }>;
    runs: Readonly<{
        description: string;
        filterLabel: string;
        filterRunning: string;
        filterAll: string;
        onHome: (params: Readonly<{ home: string }>) => string;
        emptyRunning: string;
        emptyAll: string;
        emptyDescription: string;
        machinesTitle: string;
        otherMachinesTitle: string;
        uncheckedDescription: (params: Readonly<{ count: number }>) => string;
        machineNotChecked: string;
        machineNotShared: string;
        machineReadFailed: string;
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
            sessionOnHome: ({ home }) => `A session on ${home}`,
            sessionElsewhere: 'A session that isn’t on this device',
            requesterYou: 'You',
            requesterGuard: 'Happier Guard',
            requesterGuardDescription: 'Guard found this and is asking before it acts.',
            origin: {
                voice: 'Asked by voice',
                agent: 'Asked by an agent',
                mcp: 'Asked through a connected tool',
                cli: 'Asked from the command line',
                ui: 'Asked in the app',
                api: 'Asked through the API',
                plugin: 'Asked by a plugin',
                workflowRun: 'Asked by a Workflow Run',
                system: 'Asked by Happier',
            },
            proposalsDescription: 'Posted to the review if you approve.',
            requester: {
                title: 'Who confirms',
                descriptionYou: 'You asked for this, so you confirm it.',
                descriptionOther: ({ name }) => `${name} asked for this, so only they can confirm it.`,
                askedBy: 'Asked by',
                anotherPerson: 'Another person',
                waitingFor: ({ name }) => `Waiting for ${name} to confirm`,
                confirmedBy: 'Confirmed by',
                declinedBy: 'Declined by',
                thread: {
                    youConfirm: 'You asked, so you confirm',
                    review: 'Review and confirm…',
                    waiting: ({ name }) => `Waiting for ${name} to confirm. Only the person who asked can.`,
                    using: ({ label }) => `Using ${label}`,
                    usingAccount: 'Using a connected account',
                    usingTeam: 'Using a Team setup',
                    ownerAccount: ({ name }) => `Owned by ${name}`,
                    ownerTeam: ({ name }) => `Owned by Team ${name}`,
                    ownerTeamUnnamed: 'Owned by a Team',
                    why: 'Set up for this kind of write',
                    confirmedPending: ({ name }) => `Confirmed by ${name} · waiting for the result`,
                    done: ({ name }) => `Done · confirmed by ${name}`,
                    declined: ({ name }) => `Declined by ${name} · nothing was written`,
                    canceled: 'Canceled · nothing was written',
                    uncertain: 'Not known yet whether this went through. Don’t confirm again.',
                    failed: 'Didn’t go through',
                },
            },
        },
        runs: {
            description: 'Background runs on your machines.',
            filterLabel: 'Runs to show',
            filterRunning: 'Running',
            filterAll: 'All',
            onHome: ({ home }) => `On ${home}`,
            emptyRunning: 'Nothing running right now',
            emptyAll: 'No runs yet',
            emptyDescription: 'Background runs your agents start on these machines show up here.',
            machinesTitle: 'Machines',
            otherMachinesTitle: 'Other machines',
            uncheckedDescription: ({ count }) => `Couldn’t check runs on ${count} of these machines.`,
            machineNotChecked: 'Not checked',
            machineNotShared: 'Not shared with you',
            machineReadFailed: 'Couldn’t read',
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