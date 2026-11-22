

export type ShareSheetTranslations = Readonly<{
    publicLink: Readonly<{ description: string; workflowDescription: string; workflowGrants: string; grants: string; linkLabel: string; gone: string; audit: string; auditEmpty: string; ownerUpdateRequired: string; ownerUpdateRequiredDescription: string }>;
    suggestions: (params: Readonly<{ kind: string }>) => string;
    profileAgentsMore: (params: Readonly<{ count: number }>) => string;
    whoHasAccess: string;
    whoHasAccessStale: string;
    owner: string;
    you: string;
    addPlaceholder: string;
    person: string;
    group: string;
    team: string;
    accessLevel: string;
    accessibleControl: (params: Readonly<{ name: string; control: string; value: string }>) => string;
    remove: string;
    confirmRemove: string;
    removedAnnouncement: (params: Readonly<{ name: string }>) => string;
    removeLosesPerson: (params: Readonly<{ name: string }>) => string;
    removeLosesMembers: (params: Readonly<{ name: string }>) => string;
    removeKeepsOtherAccess: string;
    removeKeepsTheirWork: string;
    browseAll: string;
    browsePeople: string;
    browseTeams: string;
    browseGroups: string;
    membersOnlyLink: string;
    allLoaded: string;
    noConnectedPeople: string;
    noMatchingPeople: (params: Readonly<{ query: string }>) => string;
    copyLink: string;
    linkCopied: string;
    copyLinkFailed: string;
    sendCopy: string;
    cantAdd: string;
    secrets: Readonly<{
        levels: Readonly<{ canUse: string }>;
        help: Readonly<{ use: string }>;
        oneLevel: string;
    }>;
    credentials: Readonly<{
        title: string;
        levels: Readonly<{ canUse: string }>;
        help: Readonly<{ use: string }>;
        description: string;
        footnote: string;
        searchPlaceholder: string;
    }>;
    tasks: Readonly<{
        shareTitle: (params: Readonly<{ name: string }>) => string;
        title: string;
        levels: Readonly<{ canView: string; canEdit: string }>;
        help: Readonly<{ view: string; edit: string }>;
        notes: Readonly<{ linkedAccess: string; encrypted: string }>;
        disclosure: Readonly<{
            title: string;
            notes: string;
            links: string;
            linkedSessions: string;
            blockedBy: string;
            tasks: (params: Readonly<{ count: number }>) => string;
        }>;
        readiness: Readonly<{
            homeManaged: string;
            setupRequired: string;
            repairRequired: string;
            keysPending: string;
            membersKeysPending: (params: Readonly<{ count: number }>) => string;
            sendKeys: string;
        }>;
        errors: Readonly<{ unavailable: string; updateRequired: string; ownerOnly: string; notFound: string; noAccess: string; subjectUnavailable: string; failed: string }>;
    }>;
    documents: Readonly<{
        title: string;
        shareTitle: (params: Readonly<{ name: string }>) => string;
        shareMenu: string;
        levels: Readonly<{ canUse: string; canRead: string; canEdit: string; admin: string }>;
        help: Readonly<{
            workflowUse: string;
            documentUse: string;
            promptUse: string;
            boardUse: string;
            dashboardUse: string;
            roleUse: string;
            profileUse: string;
            editForEveryone: string;
            adminOwnerShares: string;
        }>;
        notes: Readonly<{ personalRuns: string; teamRuns: string; roleLive: string; profileSecrets: string; dashboardAccess: string }>;
        privateChoices: Readonly<{
            title: string;
            account: (params: Readonly<{ widget: string; service: string }>) => string;
            letViewersPick: string;
            removeChoice: string;
            authoredInput: (params: Readonly<{ widget: string }>) => string;
        }>;
        linkedWorkflows: Readonly<{
            title: (params: Readonly<{ audience: string }>) => string;
            shared: string;
            loadFailed: string;
            notNow: string;
        }>;
        errors: Readonly<{ unavailable: string; ownerOnly: string; noAccess: string; notFound: string; subjectUnavailable: string; failed: string }>;
    }>;
}>;


export const shareSheetTranslationsEnglish = { en: {
        publicLink: { workflowDescription: "Anyone with the link can read this workflow, without an account.", workflowGrants: "Read-only workflow.", description: "Anyone with the link can read this document, without an account.", grants: "Read-only document.", linkLabel: "Link to this document", gone: "This link was already turned off or replaced.", audit: "Access log", auditEmpty: "No visits recorded yet.", ownerUpdateRequired: "This link is being updated by its owner", ownerUpdateRequiredDescription: "Ask the owner to open Happier, then try this link again." },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `Suggested ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `+${count} more`,
        whoHasAccess: 'Who has access',
        whoHasAccessStale: 'Who has access · may be out of date',
        owner: 'Owner',
        you: 'You',
        addPlaceholder: 'Add people or Teams',
        person: 'Person',
        group: 'Team group',
        team: 'Team',
        accessLevel: 'Access level',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Remove access',
        confirmRemove: 'Confirm removal',
        removedAnnouncement: ({ name }) => `${name} no longer has access`,
        removeLosesPerson: ({ name }) => `${name} loses access to it on every device.`,
        removeLosesMembers: ({ name }) => `${name} members lose access to it on every device.`,
        removeKeepsOtherAccess: "Access shared with them another way stays.",
        removeKeepsTheirWork: "Their own checkouts, sessions and widgets stay theirs.",
        browseAll: 'Browse all',
        browsePeople: 'Browse all people',
        browseTeams: 'Browse all Teams',
        browseGroups: 'Browse all Team Groups',
        membersOnlyLink: 'Copy link is for people who already have access.',
        allLoaded: 'All results loaded',
        noConnectedPeople: 'Only people you’re connected with appear here.',
        noMatchingPeople: ({ query }) => `No friend or teammate matches “${query}”. Connect first to share.`,
        copyLink: 'Copy link',
        linkCopied: 'Link copied',
        copyLinkFailed: 'Couldn’t copy the link.',
        sendCopy: 'Send a copy instead',
        cantAdd: 'Can’t be added',
        tasks: {
            shareTitle: ({ name }) => `Share ${name}`,
            title: "Task sharing",
            levels: { canView: "Can view", canEdit: "Can edit" },
            help: { view: "read the task, its notes and links", edit: "change it for everyone it’s shared with" },
            notes: { linkedAccess: "Linked Sessions and tasks keep their own access.", encrypted: "Your tasks are end-to-end encrypted, so people who use Home-managed storage can’t open them." },
            disclosure: {
                title: "What they’ll see",
                notes: "Notes",
                links: "Links",
                linkedSessions: "Linked Sessions",
                blockedBy: "Blocked by",
                tasks: ({ count }) => count === 1 ? "1 task" : `${count} tasks`,
            },
            readiness: {
                homeManaged: "Can’t open it: uses Home-managed storage",
                setupRequired: "Can’t open it until they finish encryption setup",
                repairRequired: "Can’t open it until their encryption keys are repaired",
                keysPending: "Waiting for keys",
                membersKeysPending: ({ count }) => count === 1 ? "1 member waiting for keys" : `${count} members waiting for keys`,
                sendKeys: "Send keys now",
            },
            errors: {
                unavailable: "Sharing isn’t available for this task.",
                updateRequired: "This Home needs a Happier update before tasks can be shared.",
                ownerOnly: "Only the owner can change who has access.",
                notFound: "This task is no longer available.",
                noAccess: "You no longer have access to this task.",
                subjectUnavailable: "This person, group, or Team can’t receive access.",
                failed: "Couldn’t update sharing. Try again.",
            },
        },
        secrets: {
            levels: { canUse: "Give them the value" },
            help: { use: "They can see and copy this value, and use it without your Machine. You can stop future access, but a copy already obtained cannot be taken back. Rotate or revoke the credential with its provider to invalidate that copy." },
            oneLevel: "Sharing gives recipients the value. Only you can manage it.",
        },
        credentials: {
            title: 'Who can use it',
            levels: { canUse: 'Can use it' },
            help: { use: 'their agents run through your machine; they never see it' },
            description: 'Choose a Team. Next you pick which machine its use runs through and who in the Team gets it.',
            footnote: 'Members\' agents use it through your machine. They never see it.',
            searchPlaceholder: 'Add a Team',
        },
        documents: {
            title: 'Sharing',
            shareTitle: ({ name }) => `Share ${name}`,
            shareMenu: 'Share…',
            levels: { canUse: 'Can use', canRead: 'Can read', canEdit: 'Can edit', admin: 'Admin' },
            help: {
                workflowUse: 'see and run it',
                roleUse: "apply it in their sessions; personal changes stay in their Settings",
                profileUse: 'start sessions with it',
                documentUse: 'open and copy it on any of their devices',
                promptUse: "insert it in their sessions",
                boardUse: 'see the board; each card opens only what they can already open',
                dashboardUse: 'see this dashboard; each widget shows only what you can already open.',
                editForEveryone: 'change it for everyone it’s shared with',
                adminOwnerShares: 'change it and manage sharing',
            },
            notes: {
                personalRuns: 'Runs and triggers stay with whoever starts them.',
                teamRuns: 'The team sees every run.',
                roleLive: 'Changes you make reach everyone it’s shared with.',
                profileSecrets: 'Profiles refer to Saved Secrets; their values never travel.',
                dashboardAccess: 'People you add open it as themselves. Widgets, definitions, connections, machines and repositories each need their own access.',
            },
            privateChoices: {
                title: 'Private connection choices',
                account: ({ widget, service }) => `${widget} uses your ${service} account`,
                letViewersPick: 'Let viewers pick',
                removeChoice: 'Remove the choice',
                authoredInput: ({ widget }) => `Edit ${widget} to remove its private inputs before sharing.`,
            },
            linkedWorkflows: {
                title: ({ audience }) => `Also share this profile’s Workflows with ${audience}?`,
                shared: 'Shared',
                loadFailed: 'Couldn’t load the Workflows that use this profile.',
                notNow: 'Not now',
            },
            errors: {
                unavailable: 'Sharing isn’t available here yet.',
                ownerOnly: 'Only the owner or an administrator can change who has access.',
                noAccess: 'You no longer have access.',
                notFound: 'This is no longer available.',
                subjectUnavailable: 'This person, group, or Team can’t receive access.',
                failed: 'Couldn’t update sharing. Try again.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "en">;
