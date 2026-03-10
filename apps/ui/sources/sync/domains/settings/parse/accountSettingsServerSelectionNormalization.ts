type ServerSelectionSettingsLike = Readonly<{
    serverSelectionActiveTargetKind?: unknown;
    serverSelectionActiveTargetId?: unknown;
}>;

type MutableServerSelectionSettingsLike = {
    -readonly [K in keyof ServerSelectionSettingsLike]?: ServerSelectionSettingsLike[K];
};

export function normalizeAccountSettingsServerSelection<
    TSettings extends Record<string, unknown> & ServerSelectionSettingsLike,
>(settings: TSettings): TSettings {
    const next: Record<string, unknown> & MutableServerSelectionSettingsLike = { ...settings };
    const kind = next.serverSelectionActiveTargetKind;
    const id = next.serverSelectionActiveTargetId;

    if (kind !== 'server' && kind !== 'group') {
        next.serverSelectionActiveTargetKind = null;
        next.serverSelectionActiveTargetId = null;
        return next as TSettings;
    }

    if (typeof id !== 'string' || id.trim().length === 0) {
        next.serverSelectionActiveTargetKind = null;
        next.serverSelectionActiveTargetId = null;
        return next as TSettings;
    }

    next.serverSelectionActiveTargetKind = kind;
    next.serverSelectionActiveTargetId = id;
    return next as TSettings;
}
