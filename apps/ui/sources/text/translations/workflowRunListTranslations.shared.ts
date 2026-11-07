

export type Progress = Readonly<{ completed: number; total: number }>;



export const en = {
    definitions: 'Definitions',
    stepsProgress: ({ completed, total }: Progress) => `${completed} of ${total} ${total === 1 ? 'step' : 'steps'} finished`,
    loopProgress: ({ completed, total }: Progress) => `${completed} of ${total} items`,
    startedByAgent: 'Started by an agent',
    startedByTrigger: 'Started by a trigger',
};


export const workflowRunListTranslationsEnglish = { en } satisfies Pick<Record<string, typeof en>, "en">;
