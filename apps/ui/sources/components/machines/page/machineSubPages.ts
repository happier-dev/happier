import type { TranslationKeyNoParams } from '@/text';

import type { MachinePageTabParams } from './machinePageTabQuery';

/**
 * The pages "This machine" pushes in the detail pane (lab `DD`), in the order its rows list them. The machine's
 * work (workers, runs, recent sessions, terminals) is not one of them: it stays in place on the Overview (MPG-8).
 */
export const MACHINE_THIS_MACHINE_PAGES = ['agents', 'terminal', 'computer', 'doctor', 'connection', 'details'] as const;
export type MachineThisMachinePageId = typeof MACHINE_THIS_MACHINE_PAGES[number];

/** Every page a machine pushes: This machine's rows, then the Overview's Alerts row (plan 20 VIT-15). */
export const MACHINE_SUB_PAGES = [...MACHINE_THIS_MACHINE_PAGES, 'alerts'] as const;
export type MachineSubPageId = typeof MACHINE_SUB_PAGES[number];

export function isMachineSubPageId(value: unknown): value is MachineSubPageId {
    return typeof value === 'string' && (MACHINE_SUB_PAGES as readonly string[]).includes(value);
}

/**
 * Pages that moved into a tab (MACH-COMPOSE D1): Security is a tab, and Network and Sharing are pages it pushes; Tools is
 * a page the Setup tab pushes. An
 * older link to one of them (`/machines/<id>/network`) opens its place in the tab; anything else is not moved.
 */
const MOVED_TO_TAB: Readonly<Record<string, MachinePageTabParams>> = {
    security: { id: 'security' },
    network: { id: 'security', page: 'network' },
    sharing: { id: 'security', page: 'sharing' },
    installables: { id: 'setup', page: 'tools' },
};

export function machineSubPageMovedToTab(page: string | undefined): MachinePageTabParams | null {
    return page !== undefined && Object.hasOwn(MOVED_TO_TAB, page) ? MOVED_TO_TAB[page]! : null;
}

/** Each sub-page's title: its This machine row and its own page header say the same word. */
export const MACHINE_SUB_PAGE_TITLE_KEYS = {
    agents: 'machineDetailPage.subPages.agents',
    terminal: 'machineDetailPage.subPages.terminal',
    computer: 'machineDetailPage.subPages.computer',
    connection: 'machineDetailPage.subPages.connection',
    doctor: 'machineDetailPage.subPages.doctor',
    details: 'machineDetailPage.subPages.details',
    alerts: 'machineVitals.alerts.title',
} as const satisfies Record<MachineSubPageId, TranslationKeyNoParams>;
