import type { DesktopServiceAutostartMode } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import type { ThisComputerServiceRow, ThisComputerServiceRows } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import type { t as translate } from '@/text';

/**
 * Every string of the native tray menu, localized here because the native menu cannot translate.
 * The native side persists them so menu-bar mode (no web UI) still speaks the app's language; each
 * one it is missing falls back to English there. Keys are the R16 payload contract's; `title` is
 * the product name, never translated, so the native side's own value stands.
 */
export type DesktopTrayLabels = Readonly<{
    open: string;
    openInHappier: string;
    settings: string;
    startAtLogin: string;
    quit: string;
    stopServicesAndQuit: string;
    connected: string;
    offline: string;
    needsAttention: string;
    /** "{count} running", appended to a row whose sessions the app can see (A13-07); `{count}` filled natively. */
    sessions: string;
    start: string;
    restart: string;
    stop: string;
    userOwned: string;
    checking: string;
    readFailed: string;
    incomplete: string;
    noServices: string;
    working: string;
    stopConfirmTitle: string;
    stopConfirmBody: string;
    stopAllConfirmTitle: string;
    stopAllConfirmBody: string;
    stopConfirmAction: string;
    cancel: string;
    actionFailedTitle: string;
    quitWaitForSystemTasks: string;
    loginItemFailed: string;
}>;

/** A row as the native menu renders it: the executor's, plus the Home's name when the app knows one. */
export type DesktopTrayServiceRow = ThisComputerServiceRow & Readonly<{ name?: string }>;

export type DesktopTrayServices =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed' }>
    | Readonly<{ status: 'listed'; rows: readonly DesktopTrayServiceRow[]; complete: boolean }>;

/** The menu half of the tray payload; the status half is `buildDesktopTrayState`. */
export type DesktopTrayMenuState = Readonly<{
    labels: DesktopTrayLabels;
    services: DesktopTrayServices;
    serviceAutostart: DesktopServiceAutostartMode | null;
    /** The producer's running managed-service count, forwarded unchanged; `null` = unknown. */
    runningManagedServiceCount: number | null;
    /** The status task's params from the one spec builder, replayed natively in menu-bar mode. */
    taskParams: Readonly<Record<string, unknown>>;
}>;

/** The native side fills this literal with the Home's host. */
const RELAY_PLACEHOLDER = '{relay}';
const COUNT_PLACEHOLDER = '{count}';

export function buildDesktopTrayLabels(t: typeof translate): DesktopTrayLabels {
    return {
        open: t('settingsDesktop.tray.open'),
        openInHappier: t('settingsDesktop.tray.openInHappier'),
        settings: t('settingsDesktop.tray.settings'),
        startAtLogin: t('settingsDesktop.tray.startAtLogin'),
        quit: t('settingsDesktop.tray.quit'),
        stopServicesAndQuit: t('settingsDesktop.tray.stopServicesAndQuit'),
        // The same words Settings › This computer and the popover use for these states.
        connected: t('machine.thisComputer.servers.connected'),
        offline: t('machine.thisComputer.servers.offline'),
        needsAttention: t('machine.thisComputer.servers.attention'),
        sessions: t('settingsDesktop.tray.sessions', { count: COUNT_PLACEHOLDER }),
        start: t('settingsDesktop.tray.start'),
        restart: t('settingsDesktop.tray.restart'),
        stop: t('settingsDesktop.tray.stop'),
        userOwned: t('settingsDesktop.tray.userOwned'),
        checking: t('settingsDesktop.tray.checking'),
        readFailed: t('settingsDesktop.tray.readFailed'),
        incomplete: t('settingsDesktop.tray.incomplete'),
        noServices: t('settingsDesktop.tray.noServices'),
        working: t('settingsDesktop.tray.working'),
        stopConfirmTitle: t('settingsDesktop.tray.stopConfirmTitle', { relay: RELAY_PLACEHOLDER }),
        stopConfirmBody: t('settingsDesktop.tray.stopConfirmBody', { relay: RELAY_PLACEHOLDER }),
        stopAllConfirmTitle: t('settingsDesktop.tray.stopAllConfirmTitle'),
        stopAllConfirmBody: t('settingsDesktop.tray.stopAllConfirmBody'),
        stopConfirmAction: t('settingsDesktop.tray.stopConfirmAction'),
        cancel: t('common.cancel'),
        actionFailedTitle: t('settingsDesktop.tray.actionFailedTitle'),
        quitWaitForSystemTasks: t('settingsDesktop.tray.quitWaitForSystemTasks'),
        loginItemFailed: t('settingsDesktop.tray.loginItemFailed'),
    };
}

export function buildDesktopTrayMenuState(params: Readonly<{
    services: ThisComputerServiceRows;
    serviceAutostart: DesktopServiceAutostartMode | null;
    runningManagedServiceCount?: number | null;
    taskParams: Readonly<Record<string, unknown>>;
    /** The Home's display name for a service's relay, or `null` (the native menu then shows its host). */
    homeNameFor: (relayUrl: string) => string | null;
    t: typeof translate;
}>): DesktopTrayMenuState {
    const services: DesktopTrayServices = params.services.status === 'listed'
        ? {
            status: 'listed',
            complete: params.services.complete,
            rows: params.services.rows.map((row) => {
                const name = params.homeNameFor(row.relayUrl)?.trim();
                return name ? { ...row, name } : row;
            }),
        }
        : params.services;
    return {
        labels: buildDesktopTrayLabels(params.t),
        services,
        serviceAutostart: params.serviceAutostart,
        runningManagedServiceCount: params.runningManagedServiceCount ?? null,
        taskParams: params.taskParams,
    };
}
