

export function translated(value: typeof english): typeof english {
    return value;
}



export const english = {
    sessionPages: {
        info: {
            continueTitle: 'Continue',
            continueDescription: 'Start new work from where this session is.',
            organizeTitle: 'Organize',
            organizeDescription: 'Where this session shows up in your lists.',
            activityDescription: 'What the agent is doing now.',
            detailsTitle: 'Details',
            detailsDescription: 'Identifiers and history, for support and scripts.',
            environmentTitle: 'Environment',
            environmentDescription: 'The machine, folder and agent this session runs with.',
            agentStateDescription: 'Who is steering the agent and what it is waiting on.',
            relatedTitle: 'Related',
            relatedDescription: 'Other pages for this session.',
            developerTitle: 'Developer',
            developerDescription: 'Raw records for debugging, shown in developer mode.',
            leaveLabel: 'Stop, archive or delete',
            leaveFootnote: 'Stopping ends the running process. Archived sessions can be restored. Deleting removes the session and its messages for good.',
            setupTitle: "Setup",
            setupDescription: "How the agent works in this session.",
            aboutTitle: "About",
            peopleTitle: "People and access",
            leaveTitle: "Leave",
            tags: "Tags",
            addTag: "Tag",
            pinned: "Pinned",
            follow: "Follow",
            keepInNeedsYou: "Keep in Needs you",
            keepInNeedsYouSubtitle: "Stays there until you clear it.",
            fork: "Fork…",
            forkDetail: "Native, replay or configure",
            handOff: "Hand off…",
            handOffDetail: "Another machine or agent",
            people: "People",
            sharing: "Sharing",
            folder: "Folder",
            agent: "Agent",
            started: "Started",
            resumeCommand: "Resume command",
            connection: "Connection",
            cli: "CLI",
            cliOutdatedValue: ({ version }: { version: string }) => `${version} · update`,
            controlledBy: "Controlled by",
            controlledByYou: "You",
            usage: "Usage",
            usageDetail: "Tokens and cost",
            copyAllDetails: "Copy all details",
            copyAllDetailsNote: "Paths and secrets redacted",
            showMore: ({ count }: { count: number }) => `Show ${count} more`,
            showFewer: "Show fewer",
            view: "View",
            allAutomations: "All automations",
            resume: "Resume",
            unarchive: "Unarchive",
            openToResume: "Open to resume",
            section: "Section",
            sectionNone: "None",
            cliNoticeTitle: ({ machine }: { machine: string }) => `Update the CLI on ${machine}`,
            cliNoticeReason: ({ version, command }: { version: string; command: string }) => `Some session features need Happier CLI ${version}. Run ${command} there.`,
            addNote: "Add a note",
        },
        follow: {
            description: 'Choose whether this session notifies you and speaks through voice.',
        },
        permissions: {
            description: 'Tools you allowed from another device for this session. Revoke any you no longer want.',
        },
        automations: {
            description: 'Work that runs in this session on a schedule, an event, or when a turn finishes.',
        },
        newRun: {
            description: 'Start a sub-agent run from this session.',
            transcriptReadOnly: 'This is saved history. Reconnect to this Home to continue the conversation.',
            daemonReadOnly: 'This history comes from the agent process. Reconnect to this Home to continue the conversation.',
        },
    },
};


export const sessionPageTranslationsEnglish = { en: english };