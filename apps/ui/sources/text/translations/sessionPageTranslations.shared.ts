

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
            activityDescription: 'What the agent is doing, and whether you hear about it.',
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