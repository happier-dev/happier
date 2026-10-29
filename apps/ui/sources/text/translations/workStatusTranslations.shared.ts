

export type WorkStatusTranslations = Readonly<{
    buckets: Readonly<{
        needs_you: string;
        working: string;
        finished: string;
        idle: string;
        offline: string;
    }>;
    /** The short word a pending request shows in a row's status slot. */
    words: Readonly<{
        permission: string;
        question: string;
    }>;
}>;



export const en: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Needs you',
        working: 'Working',
        finished: 'Finished',
        idle: 'Idle',
        offline: 'Offline',
    },
    words: {
        permission: 'Permission',
        question: 'Question',
    },
};


export const workStatusTranslationsEnglish = { en: { ...en, task: { stopped: 'Stopped', linkFailed: "The session was created, but its task link wasn’t saved. Retry to link the same session." } } };