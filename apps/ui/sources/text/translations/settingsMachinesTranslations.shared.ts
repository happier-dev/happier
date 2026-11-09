

export const en = {
    scopeSetUpComputer: 'Set up a machine',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} is offline.`,
    defaultsTitle: "Machine defaults",
    localVirtualMachines: "Local virtual machines",
    runningOnly: "Cloud billed only while running",
    stoppedBilled: "Cloud billed while stopped",
    billingUnknown: "Billing unknown",
    pageDescription: 'The machines your sessions run on, and the pools that choose between them.',
    thisComputerTitle: 'This machine',
    thisComputerRowSubtitle: 'Background service and command line',
    thisComputerPageDescription: 'The Happier background service and command line on this device.',
    setupSectionTitle: 'Setup',
    setupRowSubtitle: 'Install Happier here and connect it to your Home.',
    addPageDescription: 'Connect a machine so agents can run your sessions on it.',
    addFromComputerTitle: 'Add machines from a desktop',
    addFromComputerDescription: 'Open Happier on the machine you want to add, or connect one over SSH from Happier on a desktop or in a browser.',
    searchPlaceholder: 'Search machines',
    count: ({ count }: { count: number }) => (count === 1 ? '1 machine' : `${count} machines`),
    daemonTitle: 'Background service',
    daemonDescription: 'Runs your sessions on this machine and keeps it connected to your Home.',
    unreadableTitle: ({ home }: { home: string }) => `Couldn’t read the machines on ${home}`,
    indexViewTitle: 'All machines view',
    indexViewDescription: 'Show All machines as a list or as one card per machine. Saved on this device.',
};


export const settingsMachinesTranslationsEnglish = { en };
