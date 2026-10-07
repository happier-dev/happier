

export type HomeComposerTranslation = Readonly<{
    starter: Readonly<{ explain: string; fixTest: string; automation: string }>;
    goodFirstSession: string;
    suggestionsLabel: string;
    summarizeProjectSince: (params: Readonly<{ project: string; day: string }>) => string;
    summarizeProjectToday: (params: Readonly<{ project: string }>) => string;
    sessionsSince: (params: Readonly<{ count: number; day: string }>) => string;
    sessionsToday: (params: Readonly<{ count: number }>) => string;
}>;



export const starterPrompts = {
    starter: {
        explain: 'Explain how Happier is organized',
        fixTest: 'Find a failing test and fix it',
        automation: 'Create an automation that runs every morning',
    },
    goodFirstSession: 'A good first session',
};


export const homeComposerTranslationsEnglish = { en: {
        ...starterPrompts,
        suggestionsLabel: 'Suggestions',
        summarizeProjectSince: ({ project, day }) => `Summarize what changed in ${project} since ${day}`,
        summarizeProjectToday: ({ project }) => `Summarize what changed in ${project} today`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 session since ${day}` : `${count} sessions since ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 session today' : `${count} sessions today`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "en">;