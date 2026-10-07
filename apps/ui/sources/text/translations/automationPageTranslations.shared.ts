

export function translated(value: typeof english): typeof english {
    return value;
}



export function slavicPlural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (count === 1) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}



export const english = {
    automationPages: {
        index: {
            description: 'Work that starts on its own: on a schedule, from an Event, or when a Session turn finishes.',
        },
        settings: {
            description: 'How much automation work each machine takes on, and how long finished runs are kept.',
            capacityTitle: 'Capacity',
            capacityDescription: 'Applies to every machine that runs automations.',
            historyTitle: 'Run history',
            historyDescription: 'Finished runs you can still open from an automation.',
        },
        detail: {
            description: 'Starts work on its own whenever one of its triggers fires.',
            triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 trigger' : `${count} triggers`),
            overviewDescription: 'What it runs, and how to start or change it.',
            runNowSubtitle: 'Start a run now, without waiting for a trigger.',
            editSubtitle: 'Change its name, what it runs and its triggers.',
            machineAssignmentsDescription: 'Machines that can pick up this automation’s runs.',
        },
        run: {
            description: 'What started this run, where it ran and what it produced.',
            statusTitle: 'Status',
            statusDescription: 'Where this run is now, and what you can still do with it.',
            causeTitle: 'What started it',
            causeDescription: 'The trigger and event that admitted this run. They never change afterwards.',
        },
        gate: {
            serverTitle: 'Automations are off on this Home',
            serverBody: 'This Home’s administrators have turned automations off. Ask one of them to turn them back on.',
            openFeatures: 'Open Features settings',
            unknownTitle: 'Can\'t check automations right now',
            unknownBody: 'Happier couldn\'t reach this Home to check whether automations are on. Check again when it\'s back online.',
            unsupportedTitle: 'This Home doesn\'t support automations yet',
            unsupportedBody: 'Its server predates automations. Update the Home\'s server to use them.',
            unsupportedContextTitle: 'Automations aren\'t available here',
            unsupportedContextBody: 'The Homes you\'re viewing don\'t all support automations.',
        },
        editor: {
            description: 'Name it, choose what it runs, then add the triggers that start it.',
        },
    },
};


export const automationPageTranslationsEnglish = { en: english };