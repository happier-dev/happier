

export type MachineDetailPageTranslations = typeof english;



export function translated(value: MachineDetailPageTranslations): MachineDetailPageTranslations {
    return value;
}



export const english = {
    machineDetailPage: {
        description: 'Start sessions here and see what runs on this machine.',
        placeholderTitle: 'Machine',
        online: 'Online',
        offline: 'Offline',
        cliVersionFact: ({ version }: { version: string }) => `CLI ${version}`,
        replacedByFact: ({ machine }: { machine: string }) => `Replaced by ${machine}`,
        unavailableTitle: "This machine can't start sessions right now",
        startAction: 'Start session',
        tmuxSectionDescription: 'How new sessions on this machine use tmux.',
        windowsSectionDescription: 'How remote sessions open on this machine.',
        clisSectionDescription: 'Agent CLIs Happier found on this machine, and the tools it can install.',
        runsSectionDescription: 'Processes that sessions started on this machine.',
        recentSessionsTitle: 'Recent sessions',
        recentSessionsDescription: 'The five most recent sessions on this machine.',
        daemonSectionDescription: 'The background service that connects this machine to Happier.',
        stopDaemonDescription: "Running sessions keep going. New sessions can't start until you restart it on this machine.",
        stopDaemonAction: 'Stop',
        detailsTitle: 'Machine details',
    },
};


export const machineDetailPageTranslationsEnglish = { en: english };