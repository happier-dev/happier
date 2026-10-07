

export const en = {
    title: 'Approve this command line?',
    body: ({ command }: { command: string }) => `Happier didn’t install the command line at ${command}. Approving lets it read and write this account’s sessions. Only approve one you put there yourself.`,
    bodyUnknownCommand: 'Happier didn’t install this command line. Approving lets it read and write this account’s sessions. Only approve one you put there yourself.',
    approve: 'Approve',
};


export const cliTrustPromptTranslationsEnglish = { en: en };