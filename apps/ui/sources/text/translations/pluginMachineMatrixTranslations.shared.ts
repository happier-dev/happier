

export const english = {
    machineMatrix: {
        title: 'Across your machines',
        footer: 'Read-only. Installing, updating and every other plugin action runs on the machine selected above.',
        empty: 'No machine has reported a plugin installation for this Account yet.',
        unavailable: 'Account plugin availability has not loaded yet, so machine states are unknown.',
        incomplete: ({ count }: { count: number }) => `This list may be incomplete: ${count} server(s) have not reported their machines yet.`,
        summary: ({ installed, total }: { installed: number; total: number }) => `Installed and current on ${installed} of ${total} machines`,
        lastObserved: ({ ago }: { ago: string }) => `last seen ${ago}`,
        state: {
            installedCurrent: 'Installed and current',
            disabled: 'Disabled',
            untrusted: 'Not trusted',
            incompatible: 'Different release',
            localOnly: 'Local to this machine',
            staleOffline: 'Last known, machine offline',
            absent: 'Not installed',
            unknown: 'Unknown',
        },
    },
} as const;


export const pluginMachineMatrixTranslationsEnglish = { en: english } as const;