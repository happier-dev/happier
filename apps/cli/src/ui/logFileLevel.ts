export type FileLogLevel = 'debug' | 'info' | 'warn' | 'silent';

const LEVEL_ORDER: Readonly<Record<FileLogLevel, number>> = {
    debug: 0,
    info: 1,
    warn: 2,
    silent: 3,
};

function parseFileLogLevel(rawValue: string | undefined): FileLogLevel | null {
    const value = rawValue?.trim().toLowerCase();
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'silent') return value;
    return null;
}

export function resolveFileLogLevel(params: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    isDaemonProcess: boolean;
}>): FileLogLevel {
    const explicit = parseFileLogLevel(params.env.HAPPIER_LOG_LEVEL);
    if (explicit) return explicit;
    if (params.env.DEBUG) return 'debug';
    return params.isDaemonProcess ? 'debug' : 'info';
}

export function isFileLogLevelEnabled(
    configuredLevel: FileLogLevel,
    entryLevel: Exclude<FileLogLevel, 'silent'>,
): boolean {
    if (configuredLevel === 'silent') return false;
    return LEVEL_ORDER[entryLevel] >= LEVEL_ORDER[configuredLevel];
}
