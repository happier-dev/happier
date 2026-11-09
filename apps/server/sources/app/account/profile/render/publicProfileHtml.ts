import type { PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { HAPPIER_DEFAULT_SURFACE_COLORS } from '@happier-dev/plugin-ui/environment';
import { renderPublicProfileBody, type PublicProfileBodyInput } from './publicProfileRenderer.generated.mjs';
import { PUBLIC_PROFILE_LOCALE, PUBLIC_PROFILE_STATE_LABELS } from './publicProfileLabels';
import { PUBLIC_PROFILE_FONT_FAMILY } from './publicProfileEnvironment';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

/** Trusted document shell only: the entire visible page is the portable shared component. */
export function renderPublicProfileHtml(result: PublicProfileReadResultV1, hero?: PublicProfileBodyInput['hero'],
    options: Readonly<{ service?: string; nowMs?: number }> = {}): string {
    const view = result.kind === 'published' ? result.view : null;
    // A paused or unavailable page has no view to theme it; it follows the visitor's own appearance.
    const theme = view?.appearance.theme ?? 'auto';
    const scheme = theme === 'dark' ? 'dark' : 'light';
    // Every page has a phone edition: its brand bar keeps only the brand, and its band and blocks recompose.
    const renderEdition = (selected: 'light' | 'dark') => {
        const body = { result, scheme: selected, ...(hero ? { hero } : {}), ...(options.service ? { service: options.service } : {}),
            ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }) };
        const wide = renderPublicProfileBody(body);
        const phone = renderPublicProfileBody({ ...body, singleColumn: true });
        return { css: phone.css, markup: `<div class="public-profile-wide">${wide.markup}</div><div class="public-profile-phone">${phone.markup}</div>` };
    };
    const rendered = renderEdition(scheme);
    const dark = theme === 'auto' ? renderEdition('dark') : null;
    const title = view ? `${view.identity.name ?? `@${view.handle}`} · ${view.service.displayName}`
        : result.kind === 'paused' ? `${result.identity.name ?? `@${result.handle}`} · ${PUBLIC_PROFILE_STATE_LABELS.paused}` : PUBLIC_PROFILE_STATE_LABELS.unavailable;
    const description = view?.metadata.bio ?? (view ? `Public activity shared by @${view.handle}.` : title);
    const og = view ? new URL(view.urls.og) : null;
    const fontBase = view ? new URL('v1/public/profiles/assets/fonts/', new URL('./', view.urls.page)).toString() : './v1/public/profiles/assets/fonts/';
    const ink = HAPPIER_DEFAULT_SURFACE_COLORS[scheme];
    const faces = [['Inter-Regular.ttf', 400], ['Inter-Medium.ttf', 500], ['Inter-SemiBold.ttf', 600]] as const;
    const fonts = faces.map(([file, weight]) => `@font-face{font-family:Inter;src:url("${fontBase}${file}") format("truetype");font-weight:${weight};font-style:normal;font-display:swap}`).join('')
        + [['Noto Sans Arabic', 'NotoSansArabic-Regular.ttf', 'truetype'], ['Noto Sans CJK SC', 'NotoSansCJKsc-Regular.otf', 'opentype'],
            ['Noto Emoji', 'NotoEmoji%5Bwght%5D.ttf', 'truetype']].map(([family, file, format]) =>
            `@font-face{font-family:"${family}";src:url("${fontBase}${file}") format("${format}");font-style:normal;font-display:swap}`).join('');
    const head = view && og ? `<link rel="canonical" href="${html(view.urls.page)}"><link rel="alternate" type="application/json" href="${html(view.urls.json)}"><meta property="og:type" content="profile"><meta property="og:url" content="${html(view.urls.page)}"><meta property="og:title" content="${html(title)}"><meta property="og:description" content="${html(description)}"><meta property="og:image" content="${html(og.toString())}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${html(title)}"><meta name="twitter:image" content="${html(og.toString())}">` : '';
    // RNW styles can contain admitted declarative values. Escape HTML's raw-text
    // delimiter at this final CSS boundary, independently of component escaping.
    const auto = dark ? `.public-profile-dark{display:none}@media(prefers-color-scheme:dark){.public-profile-light{display:none}.public-profile-dark{display:block}html,body{background:${HAPPIER_DEFAULT_SURFACE_COLORS.dark.background};color:${HAPPIER_DEFAULT_SURFACE_COLORS.dark.foreground}}}` : '';
    const responsive = `.public-profile-phone{display:none}@media(${HAPPIER_PUBLIC_PROFILE_HERO_METRICS.singleColumnBelowWidthPx}px > width){.public-profile-wide{display:none}.public-profile-phone{display:block}}`;
    const css = `${fonts}${dark?.css ?? rendered.css}\nhtml,body{min-height:100%;background:${ink.background};color:${ink.foreground}}body{font-family:${PUBLIC_PROFILE_FONT_FAMILY},sans-serif}a{color:inherit}${auto}${responsive}`.replaceAll('<', '\\3c ');
    const body = dark ? `<div class="public-profile-light">${rendered.markup}</div><div class="public-profile-dark">${dark.markup}</div>` : rendered.markup;
    return `<!doctype html><html lang="${PUBLIC_PROFILE_LOCALE}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><meta name="description" content="${html(description)}"><meta name="robots" content="${view?.indexable ? 'index,follow' : 'noindex,nofollow'}">${head}<style>${css}</style></head><body>${body}</body></html>`;
}

function html(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
