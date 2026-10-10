

export type Progress = Readonly<{ completed: number; total: number }>;



export const en = {
    definitions: 'Definitions',
    observedProgress: ({ status }: { status: string }) => `Observed: ${status}`,
    stepsProgress: ({ completed, total }: Progress) => `${completed} of ${total} steps`,
    loopProgress: ({ completed, total }: Progress) => `${completed} of ${total} items`,
    startedByAgent: 'Started by an agent',
    startedByTrigger: 'Started by a trigger',
};


export const workflowRunListTranslationsEnglish = { en } satisfies Pick<Record<string, typeof en>, "en">;
