type NativeUpdateLogger = Readonly<{
    log: (message: string) => void;
}>;

function formatNativeUpdateFetchFailure(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

export function logNativeUpdateFetchFailure(error: unknown, logger: NativeUpdateLogger): void {
    logger.log(`[fetchNativeUpdate] Error: ${formatNativeUpdateFetchFailure(error)}`);
}
