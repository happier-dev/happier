/** Track (P5 U7) and the phone working capsule: strip capsule, phone Watch capsule. */
export const fileTrackTranslations = {
    en: { track: 'Track', tracking: 'Tracking', paused: 'Paused', resume: 'Resume', turnOnA11y: ({ agent }: { agent: string }) => `Follow ${agent}'s edits`, turnOffA11y: ({ agent }: { agent: string }) => `Stop following ${agent}'s edits`, resumeA11y: ({ agent }: { agent: string }) => `Resume following ${agent}'s edits`, writing: 'Writing', watch: 'Watch', agentWorking: ({ agent }: { agent: string }) => `${agent} is working`, view: 'View', needsYou: 'Needs you', caretA11y: ({ agent }: { agent: string }) => `${agent} is writing here` },
} as const;
