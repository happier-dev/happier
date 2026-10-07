

export type MachineAddTranslation = Readonly<{
    newMachine: string;
    waiting: string;
    connected: string;
    failed: string;
    cancelled: string;
    cannotReachHost: string;
    choosePath: string;
    switchHome: string;
}>;


export const machineAddTranslationsEnglish = { en: { newMachine: 'New machine', waiting: 'Waiting for it to connect', connected: 'Connected', failed: 'Could not add this machine', cancelled: 'Cancelled', cannotReachHost: 'Cannot reach the host. Check the address and SSH access.', choosePath: 'Choose how to add a machine', switchHome: 'Return to this Home to continue' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "en">;