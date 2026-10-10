

export type ShareSheetTranslations = Readonly<{
    publicLink: Readonly<{ description: string; workflowDescription: string; workflowGrants: string; grants: string; audit: string; auditEmpty: string; ownerUpdateRequired: string; ownerUpdateRequiredDescription: string }>;
    suggestions: (params: Readonly<{ kind: string }>) => string;
    profileAgentsMore: (params: Readonly<{ count: number }>) => string;
    roleRunsIn: (params: Readonly<{ kind: string }>) => string;
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
    browseAll: string;
    browsePeople: string;
    browseTeams: string;
    browseGroups: string;
    membersOnlyLink: string;
    allLoaded: string;
    copyLink: string;
    linkCopied: string;
    copyLinkFailed: string;
    sendCopy: string;
    secrets: Readonly<{
        levels: Readonly<{ canUse: string }>;
        help: Readonly<{ use: string }>;
        oneLevel: string;
    }>;
    documents: Readonly<{
        title: string;
        shareTitle: (params: Readonly<{ name: string }>) => string;
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
        errors: Readonly<{ unavailable: string; ownerOnly: string; noAccess: string; notFound: string; subjectUnavailable: string; failed: string }>;
    }>;
}>;


export const shareSheetTranslationsEnglish = { en: {
        publicLink: { workflowDescription: "Anyone with the link can read this workflow, without an account.", workflowGrants: "Read-only workflow.", description: "Anyone with the link can read this document, without an account.", grants: "Read-only document.", audit: "Access log", auditEmpty: "No visits recorded yet.", ownerUpdateRequired: "This link is being updated by its owner", ownerUpdateRequiredDescription: "Ask the owner to open Happier, then try this link again." },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `Suggested ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `+${count} more`,
        roleRunsIn: ({ kind }: Readonly<{ kind: string }>) => `Runs in ${kind}`,
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
        browseAll: 'Browse all',
        browsePeople: 'Browse all people',
        browseTeams: 'Browse all Teams',
        browseGroups: 'Browse all Team groups',
        membersOnlyLink: 'Copy link is for people who already have access.',
        allLoaded: 'All results loaded',
        copyLink: 'Copy link',
        linkCopied: 'Link copied',
        copyLinkFailed: 'Couldn’t copy the link.',
        sendCopy: 'Send a copy instead',
        secrets: {
            levels: { canUse: 'Can use' },
            help: { use: 'it in runs; its value is never shown' },
            oneLevel: 'A Saved Secret is only used by runs, and its value never leaves, so it has one level.',
        },
        documents: {
            title: 'Sharing',
            shareTitle: ({ name }) => `Share ${name}`,
            levels: { canUse: 'Can use', canRead: 'Can read', canEdit: 'Can edit', admin: 'Admin' },
            help: {
                workflowUse: 'see and run it',
                roleUse: "in their sessions; personal changes stay in their Settings",
                profileUse: 'start sessions with it',
                documentUse: 'open and copy it on any of their devices',
                promptUse: "it in their sessions",
                boardUse: 'see the board; each card opens only what they can already open',
                dashboardUse: 'See this dashboard; each widget shows only what you can already open.',
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
