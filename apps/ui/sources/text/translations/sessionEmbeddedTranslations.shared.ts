

export function translated(value: typeof en): typeof en { return value; }



export const en = {
    unavailable: 'This session isn’t available',
    respondInSession: 'Open the session to respond.',
    regionLabel: ({ title }: { title: string }) => `Session: ${title}`,
    /** The embedded new chat's line above the composer, before anything has been said. */
    newChatWelcome: 'What should we work on?',
};


export const sessionEmbeddedTranslationsEnglish = { en } as const;