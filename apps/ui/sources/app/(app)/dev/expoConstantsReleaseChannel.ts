function toNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveExpoReleaseChannel(input: {
    updatesReleaseChannel?: unknown;
    updatesChannel?: unknown;
    manifestReleaseChannel?: unknown;
    expoConfigReleaseChannel?: unknown;
}): string | null {
    return (
        toNonEmptyString(input.updatesReleaseChannel) ??
        toNonEmptyString(input.updatesChannel) ??
        toNonEmptyString(input.manifestReleaseChannel) ??
        toNonEmptyString(input.expoConfigReleaseChannel) ??
        null
    );
}
