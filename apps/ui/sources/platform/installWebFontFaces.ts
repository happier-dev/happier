import { Asset } from 'expo-asset';

const WEB_FONT_STYLE_ID = 'happier-web-font-faces';

function escapeCssString(value: string): string {
    // Enough for our controlled font family names; avoid pulling in a heavier CSS escaping dependency.
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function resolveFontUri(fontModule: unknown): string | null {
    if (!fontModule) return null;

    if (typeof fontModule === 'string' || typeof fontModule === 'number') {
        return Asset.fromModule(fontModule).uri;
    }

    if (
        typeof fontModule === 'object'
        && 'uri' in fontModule
        && typeof (fontModule as { uri?: unknown }).uri === 'string'
    ) {
        return (fontModule as { uri: string }).uri;
    }

    return null;
}

function createFontFaceRule(fontFamily: string, uri: string): string {
    const lower = uri.toLowerCase();
    const format =
        lower.endsWith('.woff2') ? 'woff2'
        : lower.endsWith('.woff') ? 'woff'
        : lower.endsWith('.otf') ? 'opentype'
        : lower.endsWith('.ttf') ? 'truetype'
        : null;
    const src = format ? `url("${uri}") format("${format}")` : `url("${uri}")`;

    return `@font-face{font-family:"${escapeCssString(fontFamily)}";src:${src};font-display:swap;}`;
}

export async function installWebFontFaces(fontMap: Readonly<Record<string, unknown>>): Promise<void> {
    if (typeof document === 'undefined') return;
    if (typeof document.getElementById !== 'function') return;
    if (typeof document.createElement !== 'function') return;
    if (!document.head) return;

    const rules: string[] = [];
    const fontFamilies: string[] = [];
    for (const [fontFamily, fontModule] of Object.entries(fontMap)) {
        try {
            const uri = resolveFontUri(fontModule);
            if (!uri) continue;

            rules.push(createFontFaceRule(fontFamily, uri));
            fontFamilies.push(fontFamily);
        } catch {
            // A single unavailable asset is a definitive failure for that face; load the others.
        }
    }

    if (rules.length === 0) return;

    try {
        if (!document.getElementById(WEB_FONT_STYLE_ID)) {
            const style = document.createElement('style');
            style.id = WEB_FONT_STYLE_ID;
            style.textContent = rules.join('\n');
            document.head.appendChild(style);
        }
    } catch {
        // Font injection is best-effort and must not block app startup after a definitive failure.
        return;
    }

    try {
        const fontFaceSet = document.fonts;
        if (!fontFaceSet || typeof fontFaceSet.load !== 'function') return;

        await Promise.allSettled(
            fontFamilies.map(async (fontFamily) => {
                await fontFaceSet.load(`1em "${escapeCssString(fontFamily)}"`);
            }),
        );
    } catch {
        // A missing or malformed FontFaceSet must not brick startup.
    }
}
