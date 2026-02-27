type ParamValue = string | string[] | undefined;

function firstString(value: ParamValue): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0] ?? '';
    return '';
}

function parseBoolean(value: string): boolean {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseSource(value: string): 'notification' | null {
    const v = value.trim().toLowerCase();
    if (v === 'notification') return 'notification';
    return null;
}

export function parseServerSettingsRouteParams(params: Readonly<{ url?: ParamValue; auto?: ParamValue; source?: ParamValue }>): Readonly<{ url: string | null; auto: boolean; source: 'notification' | null }> {
    const url = firstString(params.url).trim();
    const autoRaw = firstString(params.auto);
    const sourceRaw = firstString(params.source);
    return {
        url: url ? url : null,
        auto: autoRaw ? parseBoolean(autoRaw) : false,
        source: sourceRaw ? parseSource(sourceRaw) : null,
    };
}
