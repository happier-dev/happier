function djb2Hash(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

export function buildHappierShikiThemeKey(params: Readonly<{
    type: 'light' | 'dark';
    colors: Record<string, unknown>;
}>): string {
    const c: any = params.colors as any;
    const parts = [
        params.type,
        c?.surfaceHigh ?? '',
        c?.surface ?? '',
        c?.text ?? '',
        c?.textSecondary ?? '',
        c?.syntaxDefault ?? '',
        c?.syntaxKeyword ?? '',
        c?.syntaxString ?? '',
        c?.syntaxNumber ?? '',
        c?.syntaxComment ?? '',
        c?.syntaxFunction ?? '',
    ].map((v) => String(v ?? '')).join('|');
    return `happier-${params.type}-${djb2Hash(parts)}`;
}
