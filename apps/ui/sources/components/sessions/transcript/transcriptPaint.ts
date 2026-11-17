import { fixedThemePaint, tokenThemePaint, type ThemePaint, type ThemePaintFacets } from '@/theme/profiles/themePaint';
import { glassContentFillPaint } from '@/components/ui/glass/glassSurfacePaint';

/** Markdown's caller can supply text ink; an assistant wrapper itself paints no fill. */
export function resolveTranscriptPaint(theme: Readonly<{ colors: unknown }>, surface: 'user-bubble', part: 'text', textColor?: string): Readonly<{ foreground: ThemePaint }>;
export function resolveTranscriptPaint(theme: Readonly<{ colors: unknown }>, surface: 'user-bubble' | 'assistant-text', part: 'root', textColor?: string): Readonly<{ background: ThemePaint }>;
export function resolveTranscriptPaint(theme: Readonly<{ colors: unknown }>, surface: 'user-bubble' | 'assistant-text', part: 'root' | 'text', textColor?: string): ThemePaintFacets;
export function resolveTranscriptPaint(theme: Readonly<{ colors: unknown }>, surface: 'user-bubble' | 'assistant-text', part: 'root' | 'text', textColor?: string): ThemePaintFacets {
    return surface === 'user-bubble' && part === 'text'
        ? { foreground: textColor === undefined ? tokenThemePaint(theme, 'text.primary') : fixedThemePaint(textColor) }
        : { background: surface === 'user-bubble'
            ? glassContentFillPaint(tokenThemePaint(theme, 'message.user.background'), tokenThemePaint(theme, 'surface.selected'))
            : fixedThemePaint('transparent') };
}
