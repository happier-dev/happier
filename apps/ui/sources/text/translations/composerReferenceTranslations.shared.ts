export type Labels = Readonly<{
    imageNumber: (params: Readonly<{ number: number }>) => string;
    imageAccessibility: (params: Readonly<{ number: number; name: string }>) => string;
    attachmentRemoved: string;
    open: string;
    removeFromMessage: string;
    kindSession: string;
    kindFolder: string;
    kindSkill: string;
    kindPlugin: string;
    kindWorkflow: string;
    kindWidget: string;
    unavailableDetail: string;
    removedDetail: string;
    hintMention: string;
    kindFile: string;
    tabAll: string;
    hintNextKind: string;
    noMatches: (params: Readonly<{ query: string }>) => string;
    nothingToMention: string;
    noMatchesDetail: string;
}>;

export const composerReferenceTranslations = {
    en: { imageNumber: ({ number }) => `Image #${number}`, imageAccessibility: ({ number, name }) => `Image ${number}, ${name}`, attachmentRemoved: 'Attachment removed', open: 'Open', removeFromMessage: 'Remove from message', kindSession: 'Session', kindFolder: 'Folder', kindSkill: 'Skill', kindPlugin: 'Plugin', kindWorkflow: 'Workflow', kindWidget: 'Widget', unavailableDetail: 'Not available right now. It is sent as its name.', removedDetail: 'Its attachment was removed. It is left out when you send.', hintMention: 'Mention', kindFile: "File", tabAll: "All", hintNextKind: "Next kind", noMatches: ({ query }) => `No matches for “${query}”`, nothingToMention: "Nothing to mention yet", noMatchesDetail: "Try another word, or drag the item here." },
} satisfies Pick<Record<string, Labels>, 'en'>;
