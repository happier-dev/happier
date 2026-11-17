import { machineWidgetBodyTranslations } from './machineWidgetBodyTranslations.shared';

export const machinePhrase = (before: string, after: string) => ({ machine }: { machine: string }) => `${before}${machine}${after}`;
export const amountPhrase = (before: string, after: string) => ({ amount }: { amount: string }) => `${before}${amount}${after}`;
export const countPhrase = (before: string, after: string) => ({ count }: { count: number }) => `${before}${count}${after}`;

export const en = {
    ask: { title: 'Ask an agent', placeholder: machinePhrase('Ask about ', '…'), description: 'It can read what this page shows and propose changes. Nothing is stopped or deleted without your approval.', offline: machinePhrase('', ' is offline, so an agent can’t look at it right now.') },
    askSuggestions: {
        prompts: {
            memory: machinePhrase('Why is ', ' short on memory?'),
            disk: machinePhrase('Find space I can free on ', ''),
            storage: machinePhrase('Explain Happier’s storage on ', ''),
            leftBehind: machinePhrase('Review the processes left behind on ', ''),
            guard: machinePhrase('Explain what turning on Guard would do on ', ''),
            overview: machinePhrase('Review resource use on ', ''),
            processes: machinePhrase('What is using the most memory on ', '?'),
            weeklyReview: 'Review storage every Monday',
            lastReport: machinePhrase('Explain the last resource report from ', ''),
            lastStorageReport: machinePhrase('Review the last storage report from ', ''),
            notifyWhenBack: machinePhrase('Tell me when ', ' is back'),
            notifyWhenBackConsent: machinePhrase('I agree to enable ongoing Machine offline alerts and recovery updates for ', '.'),
            setupDocker: machinePhrase("Set up Docker on ", ""),
            setupReview: machinePhrase("Check what is set up on ", ""),
            setupHarden: machinePhrase("Harden SSH and the firewall on ", ""),
            securityAccess: machinePhrase("Explain who can do what on ", ""),
            securityNetwork: machinePhrase("Check what is open to the internet on ", ""),
            securityUpdates: machinePhrase("Review the updates waiting on ", ""),
        },
        reasons: {
            setup: "You review every change first",
            security: "Read only until you approve",
            memory: 'Memory pressure needs a look',
            disk: amountPhrase('', ' free on this volume'),
            storage: amountPhrase('Happier is using ', ''),
            leftBehind: countPhrase('', ' processes left behind'),
            guard: 'Memory guard is off',
            calm: 'This machine is calm',
            currentReport: 'From this machine’s resource report',
            weeklyReview: 'A weekly proposal to review',
            offline: 'This machine is offline; use its last report',
        },
    },
    widgets: {
        body: machineWidgetBodyTranslations.en,
        machine_vitals: 'Vitals', machine_fleet: 'Machines', machine_metric: 'Metric',
        machine_top_consumers: 'Using the most', machine_left_behind: 'Left behind',
        machine_storage: 'Storage', machine_worktrees: 'Worktrees', machine_guard: 'Guard',
        machine_activity: 'Activity', machine_cleanup_suggestion: 'Suggestion',
        followsSessionMachine: 'Follows this session’s machine',
        inputs: {
            volume: 'Volume', range: 'Range', scope: 'Scope', style: 'Style', metrics: 'Metrics',
            warnAbove: 'Warn above', cpu: 'CPU', memory: 'Memory', diskFree: 'Disk free',
            network: 'Network', oneHour: '1 hour', oneDay: '24 hours', sevenDays: '7 days',
            machineScope: 'Machine', sessionScope: 'Session', sparklines: 'Sparklines',
            bars: 'Bars', numbers: 'Numbers', rings: 'Rings', disk: 'Disk',
        },
    },
};

export const machineResourceUiTranslations = {
    en,
} satisfies Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zhHans' | 'zhHant', typeof en>, 'en'>;
