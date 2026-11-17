import type { SurfacePart } from '@happier-dev/plugin-sdk/ui';
import type { Theme } from '@/theme';
import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';

/** Header containers paint no fill; their child facts keep their own status and identity ink. */
export function resolveSessionHeaderPaint(theme: Theme, part: 'title'): Readonly<{ foreground: ThemePaint }>;
export function resolveSessionHeaderPaint(theme: Theme, part: 'root' | 'facts'): Readonly<{ background: ThemePaint }>;
export function resolveSessionHeaderPaint(theme: Theme, part: SurfacePart<'chat-header'>): ThemePaintFacets;
export function resolveSessionHeaderPaint(theme: Theme, part: SurfacePart<'chat-header'>): ThemePaintFacets {
    return part === 'title' ? { foreground: tokenThemePaint(theme, 'chrome.header.foreground') }
        : { background: fixedThemePaint('transparent') };
}
