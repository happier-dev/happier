

export type Parts = Readonly<{ completed: number; total: number; admitted: number }>;


export const walkthroughProgressTranslationsEnglish = { 'en': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} parts complete · ${admitted} admitted`, merge: 'Putting the walkthrough together…', titleEdited: 'Edited title', changed: 'Changed', moved: 'Moved', filesReadUnavailable: 'Files-read progress unavailable' } };