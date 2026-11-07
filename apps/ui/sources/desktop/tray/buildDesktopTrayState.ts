import type {
    ConnectionHealthKind,
    ConnectionHealthMachineLabelKey,
    ConnectionHealthStatusLabelKey,
} from '@/components/navigation/connectionStatus/connectionHealthTypes';
import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import type { ThisComputerRelayRows } from '@/setup/thisComputerRelayRows';
import { t as translate } from '@/text';

/**
 * Every string of the native tray menu (`src-tauri/src/tray/model.rs` `TrayLabels`), localized
 * here because the native menu cannot translate (U14). The native side persists them, so menu-bar
 * mode — where no web UI runs — still speaks the app's language; each missing one is English there.
 * `{relay}` is filled in natively.
 */
export type DesktopTrayLabels = Readonly<{
    title: string;
    open: string;
    openInHappier: string;
    settings: string;
    lockNow: string;
    startAtLogin: string;
    /** The plain Quit while the login-start setting is unknown. */
    quit: string;
    /** D11-1 — Quit with the setting on: the tray exits, the services keep running. */
    quitKeepServices: string;
    /** D11-1 — Quit with the setting off: every service the app manages stops first. */
    quitStopServices: string;
    stopServicesAndQuit: string;
    connected: string;
    offline: string;
    needsAttention: string;
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
    loginItemFailed: string;
    /** R16 (c) — "Sessions: {count}", `{count}` filled natively on the app relay's row. */
    sessions: string;
}>;

/**
 * This computer's background services, one row per relay (`listThisComputerRelayRows`: the
 * executor's rows, the app relay judged against the app's account). The native menu renders them
 * as they are — it decides no state and no action.
 */
export type DesktopTrayServices =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed' }>
    | Readonly<{
        status: 'listed';
        rows: readonly Readonly<{
            relayUrl: string;
            name: string;
            state: string;
            appManaged: boolean;
            actions: readonly string[];
            /** R16 (c) — agent sessions on the app relay's row, only when the app can see them; absent is unknown. */
            activeSessionCount?: number;
        }>[];
        complete: boolean;
    }>;

/** The tray icon is the plain Happier mark; the status is read in its menu as "label · detail". */
export type DesktopTrayState = Readonly<{
    label: string;
    detail: string;
    labels: DesktopTrayLabels;
    appLockEnabled: boolean;
    /**
     * R13 (e) — the one optional "Updates available (3)…" item, localized here; absent when there
     * is nothing to act on.
     */
    updatesLabel?: string;
    /** `false` while the item only reports ("Updating…"); absent = enabled. */
    updatesEnabled?: boolean;
    services: DesktopTrayServices;
    /** The one login-start setting (R16 b): the tray's "Start at login" item and the app's login item. */
    serviceAutostart: DesktopBackgroundServiceAutostartMode | null;
    /** The status task's params from the one spec builder, replayed natively in menu-bar mode. */
    taskParams: Readonly<Record<string, unknown>>;
}>;

type Translate = typeof translate;

/** A template the native side fills: the translation run with a literal `{relay}` placeholder. */
const RELAY_PLACEHOLDER = '{relay}';
const COUNT_PLACEHOLDER = '{count}';

export function buildDesktopTrayLabels(t: Translate): DesktopTrayLabels {
    return {
        title: 'Happier',
        open: t('settingsDesktop.trayOpen'),
        openInHappier: t('settingsDesktop.trayOpenInHappier'),
        settings: t('settingsDesktop.traySettings'),
        lockNow: t('appLock.lockNow'),
        startAtLogin: t('settingsDesktop.trayStartAtLogin'),
        quit: t('settingsDesktop.trayQuit'),
        quitKeepServices: t('settingsDesktop.trayQuitKeepServices'),
        quitStopServices: t('settingsDesktop.trayQuitStopServices'),
        stopServicesAndQuit: t('settingsDesktop.trayStopAndQuit'),
        connected: t('connectionStatus.thisComputerRelayConnected'),
        offline: t('connectionStatus.thisComputerRelayOffline'),
        needsAttention: t('connectionStatus.thisComputerRelayNeedsAttention'),
        start: t('settingsDesktop.trayStart'),
        restart: t('settingsDesktop.trayRestart'),
        stop: t('settingsDesktop.trayStop'),
        userOwned: t('settingsDesktop.trayUserOwned'),
        checking: t('settingsDesktop.trayChecking'),
        readFailed: t('settingsDesktop.trayReadFailed'),
        incomplete: t('settingsDesktop.trayIncomplete'),
        noServices: t('settingsDesktop.trayNoServices'),
        working: t('settingsDesktop.trayWorking'),
        stopConfirmTitle: t('settingsDesktop.trayStopConfirmTitle', { relay: RELAY_PLACEHOLDER }),
        stopConfirmBody: t('settingsDesktop.trayStopConfirmBody', { relay: RELAY_PLACEHOLDER }),
        stopAllConfirmTitle: t('settingsDesktop.trayStopAllConfirmTitle'),
        stopAllConfirmBody: t('settingsDesktop.trayStopAllConfirmBody'),
        stopConfirmAction: t('settingsDesktop.trayStopConfirmAction'),
        cancel: t('common.cancel'),
        actionFailedTitle: t('settingsDesktop.trayActionFailedTitle'),
        loginItemFailed: t('settingsDesktop.trayLoginItemFailed'),
        sessions: t('settingsDesktop.traySessions', { count: COUNT_PLACEHOLDER }),
    };
}

function toTrayServices(rows: ThisComputerRelayRows, appRelaySessionCount: number | null): DesktopTrayServices {
    if (rows.status !== 'listed') return rows;
    return {
        status: 'listed',
        rows: rows.rows.map((row) => ({
            relayUrl: row.relayUrl,
            name: row.host,
            state: row.state,
            appManaged: row.appManaged,
            actions: row.actions,
            ...(row.appRelay && appRelaySessionCount !== null ? { activeSessionCount: appRelaySessionCount } : {}),
        })),
        complete: rows.complete,
    };
}

/**
 * When the one "this computer" projection has something to say, it is the truest description the
 * tray can give — including when the account has no machine, or only offline ones, because the
 * reason is usually this computer's daemon being connected somewhere else (U7). Server-level
 * failures keep their own status: they are about the connection, not about this computer.
 */
const HEALTH_KINDS_THAT_DEFER_TO_THIS_COMPUTER: ReadonlySet<ConnectionHealthKind> = new Set(['healthy', 'no_machine', 'machine_offline']);

export function buildDesktopTrayState(params: Readonly<{
    health: Readonly<{
        kind: ConnectionHealthKind;
        machineCount: number;
        onlineCount: number;
        statusLabelKey: ConnectionHealthStatusLabelKey;
        machineLabelKey: ConnectionHealthMachineLabelKey;
    }>;
    /** The drift summary's one sentence naming what this computer is connected to (U7/R17). */
    thisComputerSentence?: string | null;
    /** The Updates summary's tray item (`describeUpdatesTrayItem`); `null` = no item. */
    updatesItem?: Readonly<{ label: string; enabled: boolean }> | null;
    appLockEnabled?: boolean;
    services: ThisComputerRelayRows;
    /** Agent sessions the app can see on its relay's service here (`null`: it cannot see them). */
    appRelaySessionCount?: number | null;
    serviceAutostart: DesktopBackgroundServiceAutostartMode | null;
    taskParams: Readonly<Record<string, unknown>>;
    t: Translate;
}>): DesktopTrayState {
    const common = {
        labels: buildDesktopTrayLabels(params.t),
        appLockEnabled: params.appLockEnabled ?? false,
        ...(params.updatesItem ? { updatesLabel: params.updatesItem.label, updatesEnabled: params.updatesItem.enabled } : null),
        services: toTrayServices(params.services, params.appRelaySessionCount ?? null),
        serviceAutostart: params.serviceAutostart,
        taskParams: params.taskParams,
    };
    const sentence = typeof params.thisComputerSentence === 'string'
        ? params.thisComputerSentence.trim()
        : '';
    if (sentence && HEALTH_KINDS_THAT_DEFER_TO_THIS_COMPUTER.has(params.health.kind)) {
        return {
            label: params.t('status.actionRequired'),
            detail: sentence,
            ...common,
        };
    }

    const label = params.t(params.health.statusLabelKey);
    const machineLabel = params.t(params.health.machineLabelKey);
    const showCounts = params.health.machineCount > 0;

    return {
        label,
        detail: showCounts ? `${machineLabel} · ${params.health.onlineCount}/${params.health.machineCount}` : machineLabel,
        ...common,
    };
}
