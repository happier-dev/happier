type SyncDebugGlobal = typeof globalThis & {
    __HAPPIER_DEBUG_SYNC_LOGS__?: unknown;
};

export type SyncLogger = Readonly<{
    log: (message: string) => void;
}>;

export function isSyncDebugLoggingEnabled(): boolean {
    if (typeof globalThis !== 'undefined' && (globalThis as SyncDebugGlobal).__HAPPIER_DEBUG_SYNC_LOGS__ === true) {
        return true;
    }
    return typeof localStorage !== 'undefined' && localStorage.getItem('happier.debug.syncLogs') === '1';
}

export function writeSyncDebugLog(logger: SyncLogger, message: string): void {
    if (!isSyncDebugLoggingEnabled()) return;
    logger.log(message);
}
