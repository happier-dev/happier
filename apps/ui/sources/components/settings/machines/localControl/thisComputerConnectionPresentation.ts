import { Modal } from '@/modal';
import { resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';
import type { ThisComputerConnection, ThisComputerServiceRow } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { t } from '@/text';

export type ThisComputerConnectionPresentation = Readonly<{
    title: string;
    /** One sentence naming the Home and, where they differ, both accounts. */
    description: string;
    /** The one action that repairs this state. */
    actionLabel: string;
}>;

/**
 * The single copy owner for a daemon that does not serve the app's Home and account. `null` when
 * it does: healthy states stay quiet.
 */
export function presentThisComputerConnection(
    connection: ThisComputerConnection,
): ThisComputerConnectionPresentation | null {
    const home = connection.homeLabel;
    const appAccount = connection.appAccountLabel;
    switch (connection.status) {
        case 'aligned':
            return null;
        case 'daemon_url_mismatch':
            return {
                title: t('machine.thisComputer.title.daemon_url_mismatch'),
                description: t('machine.thisComputer.description.daemon_url_mismatch', {
                    home,
                    daemonHome: connection.daemonHomeLabel ?? t('status.unknown'),
                }),
                actionLabel: t('machine.thisComputer.action.daemon_url_mismatch'),
            };
        case 'daemon_account_mismatch':
            return {
                title: t('machine.thisComputer.title.daemon_account_mismatch'),
                description: t('machine.thisComputer.description.daemon_account_mismatch', {
                    home,
                    daemonAccount: connection.daemonAccountLabel ?? t('status.unknown'),
                    appAccount,
                }),
                actionLabel: t('machine.thisComputer.action.daemon_account_mismatch', { appAccount }),
            };
        case 'daemon_needs_auth':
            return {
                title: t('machine.thisComputer.title.daemon_needs_auth'),
                description: t('machine.thisComputer.description.daemon_needs_auth', { home }),
                actionLabel: t('machine.thisComputer.action.daemon_needs_auth'),
            };
        case 'daemon_not_configured':
            return {
                title: t('machine.thisComputer.title.daemon_not_configured'),
                description: t('machine.thisComputer.description.daemon_not_configured', { home }),
                actionLabel: t('machine.thisComputer.action.daemon_not_configured'),
            };
        case 'daemon_not_installed':
            return {
                title: t('machine.thisComputer.title.daemon_not_installed'),
                description: t('machine.thisComputer.description.daemon_not_installed', { home }),
                actionLabel: t('machine.thisComputer.action.daemon_not_installed'),
            };
        case 'daemon_not_running':
            return {
                title: t('machine.thisComputer.title.daemon_not_running'),
                description: t('machine.thisComputer.description.daemon_not_running', { home }),
                actionLabel: t('machine.thisComputer.action.daemon_not_running'),
            };
    }
}

/**
 * Whether repairing this state moves this computer's daemon away from an account it is signed in
 * to: another account on this Home, or any account on another Home.
 */
export function isThisComputerAccountMove(connection: ThisComputerConnection): connection is ThisComputerConnection & Readonly<{ daemonAccountLabel: string }> {
    return connection.daemonAccountLabel != null
        && (connection.status === 'daemon_account_mismatch' || connection.status === 'daemon_url_mismatch');
}

/**
 * R10 D1: moving this computer's daemon away from an account it is signed in to is never silent.
 * The repair for another account (same Home or another Home) asks once, naming both accounts;
 * every other repair (not installed, stopped, unapproved) moves nobody and proceeds.
 */
export async function confirmThisComputerAccountMove(connection: ThisComputerConnection | null): Promise<boolean> {
    if (!connection || !isThisComputerAccountMove(connection)) return true;
    return await Modal.confirm(
        t('machine.thisComputer.moveConfirm.title', { appAccount: connection.appAccountLabel }),
        t('machine.thisComputer.moveConfirm.body', {
            home: connection.homeLabel,
            daemonHome: connection.daemonHomeLabel ?? connection.homeLabel,
            daemonAccount: connection.daemonAccountLabel,
            appAccount: connection.appAccountLabel,
        }),
        {
            cancelText: t('common.cancel'),
            confirmText: t('machine.thisComputer.moveConfirm.confirm'),
        },
    );
}

/**
 * One served Home's name and state, as every list of the Homes this computer serves reads it (R15 d):
 * the Home's name when the app knows one, else "this Home"; the app's own Home says so.
 */
export function presentThisComputerServiceRow(
    row: ThisComputerServiceRow,
    activeServer: Readonly<{ serverUrl: string | null | undefined; activeLocalRelayUrl?: string | null }>,
): Readonly<{ title: string; stateLabel: string }> {
    const home = resolveHomeDisplayNameForRelayUrl(row.relayUrl) ?? t('settingsAccount.thisHomeTitle');
    const isActiveHome = isDaemonOnActiveRelay({
        activeRelayUrl: activeServer.serverUrl,
        activeLocalRelayUrl: activeServer.activeLocalRelayUrl ?? null,
        daemonRelayUrl: row.relayUrl,
    }) === true;
    return {
        title: isActiveHome ? t('machine.thisComputer.servers.currentHome', { home }) : home,
        stateLabel: row.state === 'connected'
            ? t('machine.thisComputer.servers.connected')
            : row.state === 'offline'
                ? t('machine.thisComputer.servers.offline')
                : t('machine.thisComputer.servers.attention'),
    };
}

/** The repair operation names the repair the current state needs, when it needs one (Settings › This machine and every summary). */
export function resolveThisComputerRepairTitle(connection: ThisComputerConnection | null): string {
    switch (connection?.status) {
        case 'daemon_url_mismatch':
        case 'daemon_account_mismatch':
        case 'daemon_needs_auth':
        case 'daemon_not_configured':
            return presentThisComputerConnection(connection)?.actionLabel ?? t('machine.repairBackgroundServiceAction');
        default:
            return t('machine.repairBackgroundServiceAction');
    }
}
