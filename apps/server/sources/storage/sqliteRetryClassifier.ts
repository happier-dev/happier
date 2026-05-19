function errorMessage(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string") return error.message;
    if (error && typeof error === "object" && "message" in error) {
        const value = (error as { message?: unknown }).message;
        if (typeof value === "string") return value;
    }
    return "";
}

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) return null;
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : null;
}

export function isRetryableSqliteWriteError(error: unknown): boolean {
    const code = errorCode(error);
    if (code === "SQLITE_BUSY") return true;
    if (code === "P1008") return true;
    if (code === "P2024") return true;
    if (code === "P2028") return true;

    const message = errorMessage(error).toLowerCase();
    return (
        message.includes("socket timeout") ||
        message.includes("database failed to respond") ||
        message.includes("database is locked") ||
        message.includes("sqlite_busy")
    );
}
