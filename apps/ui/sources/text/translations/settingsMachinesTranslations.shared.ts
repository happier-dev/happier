

export const en = {
    scopeChooseComputer: 'Choose computer',
    scopeSetUpComputer: 'Set up a computer',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} is offline.`,
    defaultsTitle: "Machine defaults",
    localVirtualMachines: "Local virtual machines",
    runningOnly: "Cloud billed only while running",
    stoppedBilled: "Cloud billed while stopped",
    billingUnknown: "Billing unknown",
    pageDescription: 'The computers your sessions run on, and the pools that choose between them.',
    thisComputerTitle: 'This computer',
    thisComputerRowSubtitle: 'Background service and command line',
    thisComputerPageDescription: 'The Happier background service and command line on this device.',
    setupSectionTitle: 'Setup',
    setupRowSubtitle: 'Install Happier here and connect it to your Home.',
    addPageDescription: 'Connect a computer so agents can run your sessions on it.',
    addFromComputerTitle: 'Add machines from a computer',
    addFromComputerDescription: 'Open Happier on the computer you want to add, or connect one over SSH from Happier on a desktop or in a browser.',
    searchPlaceholder: 'Search machines',
    count: ({ count }: { count: number }) => (count === 1 ? '1 machine' : `${count} machines`),
    daemonTitle: 'Background service',
    daemonDescription: 'Runs your sessions on this computer and keeps it connected to your Home.',
    unreadableTitle: ({ home }: { home: string }) => `Couldn’t read the machines on ${home}`,
};


export const settingsMachinesTranslationsEnglish = { en };
