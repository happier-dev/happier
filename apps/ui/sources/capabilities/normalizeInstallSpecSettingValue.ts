export function normalizeInstallSpecSettingValue(raw: unknown): string | null {
    const spec = typeof raw === 'string' ? raw.trim() : '';
    if (!spec) return null;
    // Install specs are intended to be npm install targets passed as a single argv element.
    // If the value contains whitespace/newlines, it is often a pasted instruction string and
    // will reliably fail. Treat whitespace as invalid and fall back to the daemon default.
    if (/\s/.test(spec)) return null;
    return spec;
}

