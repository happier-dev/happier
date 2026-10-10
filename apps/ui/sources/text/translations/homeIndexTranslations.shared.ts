

export type HomeIndexTranslation = Readonly<{
    greetingMorning: (params: Readonly<{ name: string }>) => string;
    greetingAfternoon: (params: Readonly<{ name: string }>) => string;
    greetingEvening: (params: Readonly<{ name: string }>) => string;
    greetingMorningAnonymous: string;
    greetingAfternoonAnonymous: string;
    greetingEveningAnonymous: string;
    sessionsWorking: (params: Readonly<{ count: number }>) => string;
    sessionsNeedYou: (params: Readonly<{ count: number }>) => string;
    sessionsAwaitingResponse: (params: Readonly<{ count: number }>) => string;
    nothingRunning: string;
    customize: string;
    customizeTitle: string;
    customizeDescription: string;
    /** Home while it is being customized: the bar under the greeting. */
    customizing: string;
    customizingHint: string;
    /** Opens the list that shows, hides and orders Home's sections. */
    sections: string;
    /** The one drop target that ends the page while customizing. */
    newRow: string;
    newRowVerb: string;
    addWidget: string;
    reset: string;
    alwaysShown: string;
    builtIn: string;
    startDescription: string;
    attentionDescription: string;
    machinesDescription: string;
    hiddenSetupSteps: string;
    showAgain: (params: Readonly<{ count: number }>) => string;
    reorderHandle: (params: Readonly<{ section: string }>) => string;
}>;


export const homeIndexTranslationsEnglish = { en: {
        greetingMorning: ({ name }) => `Good morning, ${name}`,
        greetingAfternoon: ({ name }) => `Good afternoon, ${name}`,
        greetingEvening: ({ name }) => `Good evening, ${name}`,
        greetingMorningAnonymous: 'Good morning',
        greetingAfternoonAnonymous: 'Good afternoon',
        greetingEveningAnonymous: 'Good evening',
        sessionsWorking: ({ count }) => (count === 1 ? '1 session working' : `${count} sessions working`),
        sessionsNeedYou: ({ count }) => `${count} needs you`,
        sessionsAwaitingResponse: ({ count }) => count === 1 ? '1 session is waiting for your response' : `${count} sessions are waiting for your response`,
        nothingRunning: 'Nothing running yet',
        customize: 'Customize',
        customizeTitle: 'Customize Home',
        customizeDescription: 'Drag to reorder. Saved to your account, so every device shows the same Home.',
        customizing: "Customizing Home",
        customizingHint: "Drag widgets into, out of and between groups",
        sections: "Sections",
        newRow: "Drop here to start a new row",
        newRowVerb: "Move to a new row",
        addWidget: "Add widget",
        reset: 'Reset',
        alwaysShown: 'Always shown',
        builtIn: 'Built in',
        startDescription: 'Composer and suggestions',
        attentionDescription: 'Shown whenever something needs you',
        machinesDescription: 'Built in · a grid of your machines',
        hiddenSetupSteps: 'Hidden setup steps',
        showAgain: ({ count }) => `${count} · Show again`,
        reorderHandle: ({ section }) => `Reorder ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "en">;
