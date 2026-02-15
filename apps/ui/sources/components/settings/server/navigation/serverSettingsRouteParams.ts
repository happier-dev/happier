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

export function parseServerSettingsRouteParams(params: Readonly<{ url?: ParamValue; auto?: ParamValue }>): Readonly<{ url: string | null; auto: boolean }> {
    const url = firstString(params.url).trim();
    const autoRaw = firstString(params.auto);
    return {
        url: url ? url : null,
        auto: autoRaw ? parseBoolean(autoRaw) : false,
    };
}

