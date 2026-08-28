const MOBILE_ROW_REVISION_PATTERN = /^mobile-row:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeLoadedNativeBundleRevision(value: unknown): string | null {
    const revision = typeof value === 'string' ? value.trim() : '';
    return MOBILE_ROW_REVISION_PATTERN.test(revision) ? revision : null;
}

/**
 * Compile-time fact embedded by the canonical managed Metro runner. It is not
 * read from Maestro, app storage, a server response, or another runtime owner.
 */
export function readLoadedNativeBundleRevision(): string | null {
    return normalizeLoadedNativeBundleRevision(
        process.env.EXPO_PUBLIC_HAPPIER_MOBILE_BUNDLE_REVISION,
    );
}
