/** Existing Context load choices, offered in words and stored in characters. */
export const CONTEXT_LOAD_CHARS_PER_WORD = 6;
export const CONTEXT_LOAD_WORD_OPTIONS = [500, 1500, 4000] as const;
export type PromptStackBudgetChoice = Readonly<{ id: string; maxChars: number | null; title: string }>;

export function promptStackBudgetChoices(maxChars: number | undefined, labels: Readonly<{
    everything: string;
    words: (count: number) => string;
}>): readonly PromptStackBudgetChoice[] {
    const choices: PromptStackBudgetChoice[] = CONTEXT_LOAD_WORD_OPTIONS.map(count => ({
        id: String(count), maxChars: count * CONTEXT_LOAD_CHARS_PER_WORD, title: labels.words(count),
    }));
    // A retained Action/client value is displayed in words, but selecting it must preserve its exact budget.
    if (maxChars !== undefined && !choices.some(choice => choice.maxChars === maxChars)) {
        choices.push({ id: `chars.${maxChars}`, maxChars,
            title: labels.words(Math.max(1, Math.round(maxChars / CONTEXT_LOAD_CHARS_PER_WORD))) });
    }
    return [{ id: 'all', maxChars: null, title: labels.everything },
        ...choices.sort((a, b) => a.maxChars! - b.maxChars!)];
}
