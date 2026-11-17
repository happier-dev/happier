import type { Theme } from '@/theme';
import { parseThemeColor } from '../../../theme/parseThemeColor';
import { deriveThemePaint, fixedThemePaint, tokenThemePaint, type ThemePaint } from '../../../theme/profiles/themePaint';

export type RoundButtonDisplay = 'default' | 'secondary' | 'destructive' | 'inverted' | 'quietDestructive';

/** The disabled primary keeps 38% of its ink over the page, as one solid colour. */
const DISABLED_PRIMARY_PRESENCE = 0.38;
const disabledPrimaryPaints = new WeakMap<object, Readonly<{ background: ThemePaint; foreground: ThemePaint }>>();

function resolveDisabledPrimaryPaint(theme: Pick<Theme, 'colors'>) {
    const existing = disabledPrimaryPaints.get(theme);
    if (existing) return existing;
    const page = tokenThemePaint(theme, 'surface.base');
    const background = tokenThemePaint(theme, 'control.button.primary.background');
    const foreground = tokenThemePaint(theme, 'control.button.primary.foreground');
    const pageColor = parseThemeColor(page.color);
    const backgroundColor = parseThemeColor(background.color);
    const foregroundColor = parseThemeColor(foreground.color);
    const result = pageColor && backgroundColor && foregroundColor
        ? {
            background: deriveThemePaint([page, background], (base, ink) => parseThemeColor(base)!.mix(parseThemeColor(ink)!, DISABLED_PRIMARY_PRESENCE).rgb().string()),
            foreground: deriveThemePaint([page, foreground], (base, ink) => parseThemeColor(base)!.mix(parseThemeColor(ink)!, DISABLED_PRIMARY_PRESENCE).rgb().string()),
        }
        : { background: tokenThemePaint(theme, 'control.button.primary.disabled'), foreground };
    disabledPrimaryPaints.set(theme, result);
    return result;
}

/** The renderer and inspector select one display here, including the disabled blend. */
export function resolveRoundButtonPaint(theme: Pick<Theme, 'colors'>, input: Readonly<{
    display?: RoundButtonDisplay;
    disabled?: boolean;
    /** The surrounding material owns a secondary control's fill. */
    secondaryFill: ThemePaint;
}>): Readonly<{ background: ThemePaint; foreground: ThemePaint; border: ThemePaint; gradient?: Theme['colors']['button']['primary']['gradient'] }> {
    const display = input.display ?? 'default';
    if (display === 'default') {
        if (input.disabled) return { ...resolveDisabledPrimaryPaint(theme), border: fixedThemePaint('transparent') };
        return {
            background: tokenThemePaint(theme, 'control.button.primary.background'),
            foreground: tokenThemePaint(theme, 'control.button.primary.foreground'),
            border: fixedThemePaint('transparent'),
            gradient: theme.colors.button.primary.gradient,
        };
    }
    const destructive = display === 'destructive' || display === 'quietDestructive';
    const outlined = display === 'secondary' || display === 'destructive';
    return {
        background: outlined ? input.secondaryFill : fixedThemePaint('transparent'),
        foreground: tokenThemePaint(theme, destructive ? 'state.danger.textForeground' : 'text.primary'),
        border: outlined ? tokenThemePaint(theme, destructive ? 'state.danger.border' : 'border.strong') : fixedThemePaint('transparent'),
    };
}
