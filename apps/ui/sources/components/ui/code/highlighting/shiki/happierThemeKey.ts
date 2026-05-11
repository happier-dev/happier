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
    const surface = c?.surface as { base?: unknown; inset?: unknown } | undefined;
    const text = c?.text as { primary?: unknown; secondary?: unknown } | undefined;
    const syntax = c?.syntax as Record<string, unknown> | undefined;
    const parts = [
        params.type,
        surface?.inset ?? '',
        surface?.base ?? '',
        text?.primary ?? '',
        text?.secondary ?? '',
        syntax?.default ?? '',
        syntax?.keyword ?? '',
        syntax?.string ?? '',
        syntax?.number ?? '',
        syntax?.comment ?? '',
        syntax?.function ?? '',
    ].map((v) => String(v ?? '')).join('|');
    return `happier-${params.type}-${djb2Hash(parts)}`;
}
