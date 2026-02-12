function parseCsvUserIds(raw: string | undefined): string[] {
    const value = (raw ?? "").trim();
    if (!value) return [];
    return Array.from(
        new Set(
            value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
        ),
    );
}

export function resolveServerOwnerUserIds(env: NodeJS.ProcessEnv): string[] {
    return parseCsvUserIds(env.HAPPIER_SERVER_OWNER_USER_IDS);
}

export function isServerOwnerUserId(env: NodeJS.ProcessEnv, userId: string): boolean {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) return false;
    return resolveServerOwnerUserIds(env).includes(normalizedUserId);
}
