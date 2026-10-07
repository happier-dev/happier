

export const en = {
    row: {
        notSet: 'Not set',
    },
    keepGoing: {
        title: 'Keep going until done',
        nativeDescription: ({ agent }: { agent: string }) => `${agent} keeps working toward the goal on its own.`,
        description: ({ rounds }: { rounds: number }) => `After each of your turns, an agent checks the goal and continues until it's done, out of budget or making no progress, for at most ${rounds} ${rounds === 1 ? 'round' : 'rounds'}.`,
        roundsPrefix: 'Stop after',
        roundsSuffix: 'rounds',
        roundsLabel: 'Rounds before stopping',
        strikesPrefix: 'Stop after',
        strikesSuffix: 'checks without progress',
        strikesLabel: 'Checks without progress before stopping',
        secondOpinionTitle: 'Ask for a second opinion before finishing',
        secondOpinionDescription: 'Before the goal is marked done, a second agent checks it. If it disagrees, you get a notification and the goal stays open.',
        budgetUnreported: ({ agent }: { agent: string }) => `${agent} doesn't report token usage, so only the rounds and progress checks apply.`,
    },
};


export const goalControlTranslationsEnglish = { en };