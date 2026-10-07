import { workflowRunRoleTranslationsEnglish as workflowRunRoleTranslations } from './workflowRunRoleTranslations.shared';


import { workflowRunCompositionTranslationsEnglish as workflowRunCompositionTranslations } from './workflowRunCompositionTranslations.shared';



export type Copy = typeof en;



export const en = {
    ...workflowRunRoleTranslations.en,
    ...workflowRunCompositionTranslations.en,
    workflow: 'Workflow', inputs: 'Inputs', start: 'Start', starting: 'Starting…', stillStarting: 'Still starting…',
    needed: ({ count }: { count: number }) => `Inputs · ${count} needed`,
    neededNamed: ({ name }: { name: string }) => `Inputs · ${name} needed`,
    addToStart: ({ name }: { name: string }) => `${name} is needed to start`,
    required: 'Required to start', preview: 'What it will do', unsaved: 'Includes unsaved edits',
    remove: 'Return to a plain session', search: 'Find a workflow', builtin: 'Built-in', library: 'Your library',
    noInputs: 'No inputs needed', asksFor: ({ names }: { names: string }) => `Asks for ${names}`,
    optional: 'Optional — left empty', defaultValue: ({ value }: { value: string }) => `Default: ${value}`,
};


export const workflowStartTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "en"> = { en };