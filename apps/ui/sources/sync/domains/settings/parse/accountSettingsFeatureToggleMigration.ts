export function migrateAccountFeatureToggles(params: {
    featureToggles: unknown;
    inputSchemaVersion: number;
    supportedSchemaVersion: number;
}): Record<string, boolean> {
    const map = params.featureToggles && typeof params.featureToggles === 'object' && !Array.isArray(params.featureToggles)
        ? { ...(params.featureToggles as Record<string, unknown>) }
        : {};

    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(map)) {
        if (typeof value === 'boolean') {
            next[key] = value;
        }
    }

    const legacyFriendsToggle = next['inbox.friends'];
    if (typeof legacyFriendsToggle === 'boolean' && typeof next['social.friends'] !== 'boolean') {
        next['social.friends'] = legacyFriendsToggle;
    }
    delete next['inbox.friends'];

    // Promotion boundaries are fixed: later schema upgrades must preserve opt-outs.
    if (params.inputSchemaVersion < 7 && next['files.editor'] === false) {
        delete next['files.editor'];
    }

    return next;
}
