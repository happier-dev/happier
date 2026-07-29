export type ScmHostingProviderRuntimeDescriptor = Readonly<{
    id: string;
    kind: string;
    displayName: string;
    baseUrl: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls?: readonly string[];
        allowedOrigins?: readonly string[];
    }>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] | null {
    if (!Array.isArray(value) || value.some((entry) => readNonEmptyString(entry) === null)) return null;
    return value.map((entry) => (entry as string).trim());
}

function readSchemeArray(value: unknown): readonly string[] | null {
    const schemes = readStringArray(value);
    return schemes && schemes.every((scheme) => /^[a-z][a-z0-9+.-]*:$/iu.test(scheme)) ? schemes : null;
}

function readHttpUrlArray(value: unknown, requireOrigin: boolean): readonly string[] | null {
    const entries = readStringArray(value);
    if (!entries) return null;
    for (const entry of entries) {
        try {
            const parsed = new URL(entry);
            if (
                !['http:', 'https:'].includes(parsed.protocol)
                || parsed.username
                || parsed.password
                || parsed.search
                || parsed.hash
            ) return null;
            if (requireOrigin && parsed.origin !== entry) return null;
        } catch {
            return null;
        }
    }
    return entries;
}

function readRuntimeBaseUrl(value: unknown): string | null {
    const baseUrl = readNonEmptyString(value);
    if (!baseUrl) return null;
    try {
        const parsed = new URL(baseUrl);
        if (
            !['http:', 'https:'].includes(parsed.protocol)
            || parsed.username
            || parsed.password
            || parsed.search
            || parsed.hash
        ) return null;
        return baseUrl;
    } catch {
        return null;
    }
}

export function readScmHostingProviderRuntimeDescriptor(value: unknown): ScmHostingProviderRuntimeDescriptor | null {
    if (!isRecord(value)) return null;
    const id = readNonEmptyString(value.id);
    const kind = readNonEmptyString(value.kind);
    const displayName = readNonEmptyString(value.displayName);
    const baseUrl = readRuntimeBaseUrl(value.baseUrl);
    if (!id || !kind || !displayName || !baseUrl) return null;

    let urlSafety: ScmHostingProviderRuntimeDescriptor['urlSafety'];
    if (value.urlSafety !== undefined) {
        if (!isRecord(value.urlSafety)) return null;
        const allowedSchemes = readSchemeArray(value.urlSafety.allowedSchemes);
        const allowedBaseUrls = value.urlSafety.allowedBaseUrls === undefined
            ? undefined
            : readHttpUrlArray(value.urlSafety.allowedBaseUrls, false);
        const allowedOrigins = value.urlSafety.allowedOrigins === undefined
            ? undefined
            : readHttpUrlArray(value.urlSafety.allowedOrigins, true);
        if (!allowedSchemes || allowedBaseUrls === null || allowedOrigins === null) return null;
        urlSafety = {
            allowedSchemes,
            ...(allowedBaseUrls ? { allowedBaseUrls } : {}),
            ...(allowedOrigins ? { allowedOrigins } : {}),
        };
    }

    return {
        id,
        kind,
        displayName,
        baseUrl,
        ...(urlSafety ? { urlSafety } : {}),
    };
}
