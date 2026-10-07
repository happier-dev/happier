

export type SecretsSettingsCopy = { [K in keyof typeof en]: (typeof en)[K] };



export const en = {
    purpose: 'API keys and tokens your agents and MCP servers use. A value is never shown again after you save it.',
    yoursTitle: 'Your secrets',
    yoursDescription: 'Secrets you saved or own. Pick them wherever Happier asks for a key.',
    sharedWithYouTitle: 'Shared with you',
    sharedWithYouDescription: 'Other people let you use these. You can pick them, but not see or change them.',
    add: 'Add secret',
    newSecret: 'New secret',
    emptyTitle: 'No secrets yet',
    emptyDescription: 'Add an API key or token once, then pick it wherever Happier asks for one.',
    staleTitle: 'Shared secrets could not refresh',
    staleDescription: 'Showing the last known list.',
    valueTitle: 'Value',
    valueSaved: 'Saved. It is never shown again.',
    keepTitle: 'Keep it',
    keepPersonal: 'Personal',
    keepShared: 'Shared',
    keepPersonalDescription: 'Stored in your account. Only you can use it.',
    keepSharedDescription: 'Stored on this Home, so you can share it with people, Teams or Groups.',
    accessTitle: 'Who can use it',
    accessOnlyYou: 'Only you',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'You and 1 recipient' : `You and ${count} recipients`),
    sharePersonalDescription: 'Sharing moves it to this Home. It cannot become personal again.',
    share: 'Share',
    manage: 'Manage',
    storageTitle: 'Storage',
    storageE2ee: 'End-to-end encrypted',
    storageE2eeDescription: 'Only the people you share it with can read it.',
    storagePlain: 'Home-managed',
    storagePlainDescription: 'This Home stores it and can read it to deliver it.',
    save: 'Save secret',
};


export const secretsSettingsTranslationsEnglish = { en } as const;