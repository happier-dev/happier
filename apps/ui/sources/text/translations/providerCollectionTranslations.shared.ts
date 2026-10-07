

export type ProviderCollectionCopy = typeof en;



export const en = {
    settingsProvidersCollection: {
        description: 'Connect a model source once and use its models with every compatible agent.',
        foundOn: ({ machine }: { machine: string }) => `Found on ${machine}`,
        foundOnThisMachine: 'Found on this machine',
        connect: 'Connect',
        start: 'Start',
        test: 'Test',
        addProvider: 'Add a provider',
        customEndpoint: 'Custom endpoint',
        menuOwnCategory: 'Your own',
        menuCatalogCategory: 'From the catalog',
        newTitle: 'New provider',
        emptyDescription: 'Add a provider from the catalog, or your own compatible endpoint.',
        machineScopeLabel: 'Set up on',
        invitationTitle: 'Bring your own models',
        invitationDescription: 'Connect a provider once and its models appear in every compatible agent’s model picker. Local servers like Ollama run on your machine.',
        invitationNeedsMachine: 'Providers are connected and checked on one of your machines. Add a machine to get started.',
        setUpMachine: 'Set up a machine',
        duplicateAsCustom: 'Copy as a custom provider',
        discard: 'Discard',
        enabled: 'Enabled',
        enabledDescription: 'Offer its models in agent model pickers',
        saved: 'Saved',
        replace: 'Replace',
        addKey: 'Choose key',
        apiKeyDefaultDescription: 'Used on every machine unless one has its own key.',
        apiKeyMachineDescription: 'Used on this machine instead of the default key.',
        availabilityTitle: 'Availability',
        availabilityDescription: 'Where agents can use this provider.',
        modelsDescription: 'Choose which models agents offer in their model pickers.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} of ${total} shown in model pickers`,
        modelsFilter: ({ count }: { count: number }) => `Filter ${count} models`,
        connectionTitle: 'Connection',
        nameDescription: 'Shown in the provider list and in model pickers.',
        nameRequired: 'Add a name.',
        nameTooLong: ({ max }: { max: number }) => `Use ${max} characters or fewer.`,
        managedTitle: 'Managed local service',
        endpointsTitle: 'Endpoints',
        endpointsDescription: 'Leave empty to use the addresses the provider supplies.',
        overridesDescription: 'Where requests go. Change the address for every machine, or only for this one.',
        afterSavingTitle: 'After saving',
        destinationDescription: 'Where Happier will send this provider’s requests.',
        destinationPending: 'Appears once every endpoint is filled in.',
    },
};


export const providerCollectionTranslationsEnglish = { en } as const;