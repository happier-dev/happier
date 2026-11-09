

export type Parts = Readonly<{ completed: number; total: number }>;


export const walkthroughProgressTranslationsEnglish = { 'en': { parts: ({ completed, total }: Parts) => `${completed}/${total} parts complete`, merge: 'Putting the walkthrough together…', titleEdited: 'Edited title', changed: 'Changed', moved: 'Moved' } };
