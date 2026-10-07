

export type MachineParams = { machine: string };



export const en = {
    sectionTitle: 'Connections',
    sectionDescription: 'How your devices reach your machines.',
    directTitle: 'Connect directly when possible',
    directOnDescription: 'Previews, live views and file transfers go straight between your devices when they can reach each other, and through Happier when they can’t.',
    directOffDescription: 'Everything goes through Happier. Nothing connects to your machines directly; on the same network this is a little slower.',
    serverDenied: 'Your Home’s server sends everything through Happier, so there’s nothing to choose here.',
    machineSectionTitle: 'Connection',
    machineTitle: ({ machine }: MachineParams) => `Connect to ${machine}`,
    machineOptionDefault: 'Default',
    machineOptionDirect: 'Directly',
    machineOptionRelay: 'Through Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Follows your account: directly when ${machine} can be reached, otherwise through Happier.`,
    machineDefaultOffDescription: 'Follows your account: always through Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Directly when ${machine} can be reached, even if your account says otherwise.`,
    machineRelayDescription: 'Always through Happier, even on the same network.',
};


export const settingsConnectionsTranslationsEnglish = { en };