import type { TranslationKeyNoParams } from '@/text';

/**
 * The pages "This machine" pushes in the detail pane (lab `DD`), in the order its rows list them. The machine's
 * work (workers, runs, recent sessions, terminals) is not one of them: it stays in place on the Overview (MPG-8).
 */
export const MACHINE_THIS_MACHINE_PAGES = ['sharing', 'agents', 'terminal', 'computer', 'installables', 'doctor', 'connection', 'security', 'details'] as const;
export type MachineThisMachinePageId = typeof MACHINE_THIS_MACHINE_PAGES[number];

/** Every page a machine pushes: This machine's rows, then the Overview's Alerts row (plan 20 VIT-15). */
export const MACHINE_SUB_PAGES = [...MACHINE_THIS_MACHINE_PAGES, 'alerts'] as const;
export type MachineSubPageId = typeof MACHINE_SUB_PAGES[number];

export function isMachineSubPageId(value: unknown): value is MachineSubPageId {
    return typeof value === 'string' && (MACHINE_SUB_PAGES as readonly string[]).includes(value);
}

/** Each sub-page's title: its This machine row and its own page header say the same word. */
export const MACHINE_SUB_PAGE_TITLE_KEYS = {
    sharing: 'machineDetailPage.subPages.sharing',
    agents: 'machineDetailPage.subPages.agents',
    terminal: 'machineDetailPage.subPages.terminal',
    computer: 'machineDetailPage.subPages.computer',
    connection: 'machineDetailPage.subPages.connection',
    security: 'machineDetailPage.subPages.security',
    installables: 'machineDetailPage.subPages.tools',
    doctor: 'machineDetailPage.subPages.doctor',
    details: 'machineDetailPage.subPages.details',
    alerts: 'machineVitals.alerts.title',
} as const satisfies Record<MachineSubPageId, TranslationKeyNoParams>;
