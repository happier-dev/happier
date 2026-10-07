import { workflowRunVisibilityTranslationsEnglish as workflowRunVisibilityTranslations } from './workflowRunVisibilityTranslations.shared';



export const en = {
    visibility: workflowRunVisibilityTranslations.en,
    runWithAnotherAgent: 'Run again with another agent',
    agentForStep: ({ step }: { step: string }) => `Agent for ${step}`,
    chooseAgent: 'Choose an agent or role',
};


export const workflowRunCompositionTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "en"> = { en };