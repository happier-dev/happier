type LocaleCopyShape<T> = T extends string ? string : T extends (...args: infer Args) => infer Result ? (...args: Args) => Result : T extends object ? { [Key in keyof T]: LocaleCopyShape<T[Key]> } : T;
declare const repeatable: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", LocaleCopyShape<typeof repeatableEnglish.en>>;



export type Edit = { name: string; definitionId: string; headerVersion: number; bodyVersion: number };



export type RepeatableMessage = { text: string };



export type Copy = typeof en;


export const repeatableEnglish = { en: { repeatable: 'Make this repeatable', repeatableDescription: 'Ask the agent to turn what worked here into a workflow you can run again.', repeatablePrompt: 'Turn what we did here into a workflow I can run again. Draft it, check it with workflow.validate and save it, but don\'t run it.', repeatableMessagePrompt: 'Turn what we did in this message into a workflow I can run again. Draft it, check it with workflow.validate and save it, but don\'t run it.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };



export const en = {
    ...repeatableEnglish.en,
    create: 'Create with an agent', edit: 'Edit with an agent', agent: 'Agent',
    description: 'A new session drafts the workflow with you, checks it and saves it. Nothing runs until you choose Run now.',
    changedByAgent: 'Changed by the agent', saved: 'Saved by the agent just now',
    savedAge: ({ age }: { age: string }) => `Saved by the agent ${age}`,
    savedWorkflow: ({ name }: { name: string }) => `Saved workflow · ${name}`,
    updated: 'Updated the workflow', changed: ({ count }: { count: number }) => `Updated the workflow · ${count} steps changed`,
    openEditor: 'Open in editor', openSession: 'Open in Sessions',
    createPrompt: 'Draft a workflow with me, check it with workflow.validate, then save it. Don\'t run it.',
    createLead: 'Help me create a workflow that ',
    editPrompt: ({ name, definitionId, headerVersion, bodyVersion }: Edit) => `The saved workflow “${name}” has id ${definitionId} and revision: header ${headerVersion}, body ${bodyVersion}. Change it with workflow.definition.edit, and use workflow.definition.update only to replace it whole. Check it with workflow.validate before saving. Don't run it.`,
    editLead: ({ name }: { name: string }) => `Help me change ${name}: `,
};


export const workflowAgentAuthoringTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "en"> = { en };